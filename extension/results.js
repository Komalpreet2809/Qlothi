// Qlothi Results Logic

document.addEventListener('DOMContentLoaded', () => {
    // Guard: if extension was reloaded, chrome.runtime becomes undefined
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;flex-direction:column;gap:16px;"><h2>Extension was reloaded</h2><p>Please close this tab and click a garment again from Pinterest.</p></div>';
        return;
    }

    let allItems = [];
    const grid = document.getElementById('results-grid');

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
            card.innerHTML = `
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
                    <div class="p-price-row" style="justify-content: flex-end;">
                        <a href="${item.link || '#'}" target="_blank" class="shop-now">Buy Now</a>
                    </div>
                </div>
            `;
            
            grid.appendChild(card);
            
            setTimeout(() => { card.classList.add('reveal'); }, index * 100);
        });
    };

    const doVisualSearch = (itemName, imgUrl, bbox) => {
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
                
                // Display the full image in the sidebar per user request
                document.getElementById('source-image').src = response.base64_image;

                // Send POST to backend via proxy
                chrome.runtime.sendMessage({ action: "visualSearch", base64_image: croppedBase64 }, (res) => {
                    document.getElementById('item-query').textContent = itemName;
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
            };
            img.src = response.base64_image;
        });
    };

    chrome.storage.local.get(['qlothi_current_search'], (result) => {
        if (!result.qlothi_current_search) {
            document.getElementById('item-query').textContent = "No item selected.";
            return;
        }

        const data = result.qlothi_current_search;
        const itemName = data.item || 'Fashion Item';
        const sourceImg = data.img || '';
        const bbox = data.bbox; 

        doVisualSearch(itemName, sourceImg, bbox);
    });
});
