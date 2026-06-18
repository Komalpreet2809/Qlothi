// Qlothi Results Logic

document.addEventListener('DOMContentLoaded', () => {
    // Guard: if extension was reloaded, chrome.runtime becomes undefined
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;flex-direction:column;gap:16px;"><h2>Extension was reloaded</h2><p>Please close this tab and click a garment again from Pinterest.</p></div>';
        return;
    }

    let allItems = [];
    let savedLinks = new Set();
    let currentGarmentCrop = null;   // base64 crop of the garment, ready for try-on
    let currentItemName = '';        // e.g. "Dress", "Top / Upper Wear"
    let currentCaption = '';         // BLIP description, e.g. "loose grey wide-leg trousers"
    const grid = document.getElementById('results-grid');

    const TRYON_ENDPOINT = 'https://komalsohal-qlothi.hf.space/tryon';

    // Pre-load wishlist states
    chrome.storage.local.get({ qlothi_wishlist: [] }, (result) => {
        result.qlothi_wishlist.forEach(item => savedLinks.add(item.link));
        
        chrome.storage.local.get(['qlothi_current_search'], (sRes) => {
            if (!sRes.qlothi_current_search) {
                document.getElementById('item-query').textContent = "No item selected.";
                return;
            }
            doVisualSearch(sRes.qlothi_current_search.item || 'Fashion Item', sRes.qlothi_current_search.img || '', sRes.qlothi_current_search.bbox);
        });
    });

    const renderItems = (filter = 'all') => {
        grid.innerHTML = '';
        
        const filtered = filter === 'all' ? allItems : allItems.filter(item => item.category === filter);
        
        if (filtered.length === 0) {
            grid.innerHTML = '<p style="text-align:center;width:100%;color:#888;">No results found.</p>';
            return;
        }

        filtered.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'product-card';
            
            // Create star rating HTML
            const fullStars = Math.floor(item.rating || 4);
            let starsHtml = '';
            for(let j=0; j<5; j++) {
                if(j < fullStars) starsHtml += '★';
                else starsHtml += '☆';
            }
            
            const storeInitial = (item.store || item.name || '?')[0].toUpperCase();
            const isSaved = savedLinks.has(item.link);
            
            card.innerHTML = `
                <button class="wishlist-btn ${isSaved ? 'saved' : ''}" aria-label="Save to Wishlist">${isSaved ? '♥️' : '🤍'}</button>
                <div class="p-img-box">
                    <img src="${item.image}" alt="${item.name}" 
                         onerror="this.style.display='none'; this.parentElement.innerHTML='<div style=&quot;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#ffecd2,#fcb69f);font-size:64px;font-weight:900;color:rgba(0,0,0,0.15);&quot;>${storeInitial}</div>'">
                </div>
                <div class="p-info">
                    <div class="p-brand">${item.store || 'Store'}</div>
                    <h2 class="p-name">${item.name}</h2>
                    <div class="p-rating">
                        <span class="stars">${starsHtml}</span>
                        <span class="rating-val">${item.rating || '4.0'}</span>
                        <span class="reviews">(${item.reviews || '12'})</span>
                    </div>
                    <div class="p-price-row">
                        <div class="p-price">${item.price !== '—' && item.price ? item.price : 'Check Site'}</div>
                        <a href="${item.link || '#'}" target="_blank" class="shop-now">Buy Now</a>
                    </div>
                </div>
            `;
            
            const heartBtn = card.querySelector('.wishlist-btn');
            heartBtn.addEventListener('click', () => {
                chrome.storage.local.get({ qlothi_wishlist: [] }, (res) => {
                    let list = res.qlothi_wishlist;
                    if (savedLinks.has(item.link)) {
                        // Remove
                        list = list.filter(i => i.link !== item.link);
                        savedLinks.delete(item.link);
                        heartBtn.classList.remove('saved');
                        heartBtn.textContent = '🤍';
                    } else {
                        // Add
                        list.push(item);
                        savedLinks.add(item.link);
                        heartBtn.classList.add('saved');
                        heartBtn.textContent = '♥️';
                    }
                    chrome.storage.local.set({ qlothi_wishlist: list });
                });
            });
            
            grid.appendChild(card);
            
            setTimeout(() => { card.classList.add('reveal'); }, index * 100);
        });
    };

    const doVisualSearch = (itemName, imgUrl, bbox) => {
        currentItemName = itemName;
        // Show loading text
        document.getElementById('item-query').textContent = "Scanning the web...";
        document.getElementById('source-image').src = imgUrl; // Temporary full image
        
        // Fetch image via background to bypass cross-origin canvas taint
        chrome.runtime.sendMessage({ action: "downloadImage", url: imgUrl }, (response) => {
            if (!response || !response.success) {
                console.error("Failed to load image for cropping");
                document.getElementById('item-query').textContent = "Image Load Error";
                return;
            }

            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                let x1 = 0, y1 = 0, x2 = 1, y2 = 1;
                if (bbox && bbox.length >= 4) {
                    x1 = bbox[0] * img.width;
                    y1 = bbox[1] * img.height;
                    x2 = bbox[2] * img.width;
                    y2 = bbox[3] * img.height;
                }
                
                const cropWidth = Math.max(x2 - x1, 10);
                const cropHeight = Math.max(y2 - y1, 10);
                
                canvas.width = cropWidth;
                canvas.height = cropHeight;
                ctx.drawImage(img, x1, y1, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
                
                const croppedBase64 = canvas.toDataURL('image/jpeg', 0.9);
                currentGarmentCrop = croppedBase64; // ready for virtual try-on

                // Display the full image in the sidebar per user request
                document.getElementById('source-image').src = response.base64_image;

                document.getElementById('item-query').textContent = "AI analyzing style...";
                
                // Fetch AI Semantic Caption first
                fetch('https://komalsohal-qlothi.hf.space/caption', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ base64_image: croppedBase64 })
                }).then(r => r.json()).catch(() => ({ caption: "" })).then(capRes => {
                    const captionStr = capRes.caption || "";
                    currentCaption = captionStr; // richer garment prompt for try-on
                    if (captionStr) {
                         document.getElementById('item-query').textContent = captionStr;
                    } else {
                         document.getElementById('item-query').textContent = "Scanning the web...";
                    }

                    // Send POST to background for multimodal Google Lens hunt
                    chrome.runtime.sendMessage({ action: "visualSearch", base64_image: croppedBase64, caption: captionStr }, (res) => {
                        if (res && res.success) {
                            const data = res.data;
                            if (data.status === 'success' && data.items) {
                                allItems = data.items;
                                renderItems();
                            } else {
                                grid.innerHTML = '<p style="color:red;padding:20px;">Backend Error: ' + (data.message || 'Unknown error') + '</p>';
                            }
                        } else {
                            console.error("Backend Proxy Error:", res ? res.error : 'Unknown error');
                            document.getElementById('item-query').textContent = "Connection Failed";
                            grid.innerHTML = '<p style="color:red;padding:20px;">Could not connect to Qlothi Backend. Make sure it is running. Error: ' + (res ? res.error : 'Unknown') + '</p>';
                        }
                    });
                });
            };
            img.src = response.base64_image;
        });
    };

    // ---- Virtual Try-On ----
    const runTryOn = () => {
        if (!currentGarmentCrop) {
            alert('Hang on — still preparing the garment. Try again in a second.');
            return;
        }
        chrome.storage.local.get({ qlothi_person_photo: '' }, (res) => {
            if (!res.qlothi_person_photo) {
                alert('Add your photo first: click the Qlothi icon in the toolbar → "My Photo" → upload a full-body picture.');
                return;
            }
            openTryOnModal(res.qlothi_person_photo);
        });
    };

    const openTryOnModal = (personPhoto) => {
        const existing = document.querySelector('.tryon-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'tryon-overlay';
        overlay.innerHTML = `
            <div class="tryon-modal">
                <button class="tryon-close" aria-label="Close">✕</button>
                <h2 class="tryon-title">Virtual Try-On</h2>
                <p class="tryon-sub">${currentItemName}</p>
                <div class="tryon-stage">
                    <div class="tryon-loading">
                        <div class="spinner"></div>
                        <p id="tryon-status">Dressing you up… this can take up to a minute.</p>
                    </div>
                </div>
                <div class="tryon-foot" id="tryon-foot"></div>
            </div>`;
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.querySelector('.tryon-close').onclick = close;
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        fetch(TRYON_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                person_image: personPhoto,
                garment_image: currentGarmentCrop,
                category: currentItemName,
                description: currentCaption
            })
        })
        .then(r => r.json())
        .catch(() => ({ status: 'error', message: 'Could not reach the Qlothi backend. Make sure it is running.' }))
        .then(data => {
            const stage = overlay.querySelector('.tryon-stage');
            const foot = overlay.querySelector('#tryon-foot');
            if (data.status === 'success' && data.result_image) {
                stage.innerHTML = `<img class="tryon-result" src="${data.result_image}" alt="You wearing ${currentItemName}">`;
                const badge = data.engine === 'overlay'
                    ? `<span class="tryon-badge">Quick preview · live try-on was busy</span>`
                    : `<span class="tryon-badge live">✨ AI try-on</span>`;
                foot.innerHTML = `${badge}<a class="tryon-dl" href="${data.result_image}" download="qlothi-tryon.jpg">⬇ Save image</a>`;
            } else {
                stage.innerHTML = `<div class="tryon-error">😕<p>${data.message || 'Try-on failed. Please try again.'}</p></div>`;
            }
        });
    };

    const tryonBtn = document.getElementById('tryon-btn');
    if (tryonBtn) tryonBtn.addEventListener('click', runTryOn);

    // Search triggering is now handled at the top inside the wishlist pre-load callback
});
