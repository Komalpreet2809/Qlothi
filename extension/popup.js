// Downscale an uploaded photo so it fits comfortably in chrome.storage.local
// and is a sensible size for the try-on model. Returns a JPEG data-URL.
function resizeImageFile(file, maxSide = 768) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                const scale = Math.min(1, maxSide / Math.max(width, height));
                width = Math.round(width * scale);
                height = Math.round(height * scale);
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.9));
            };
            img.onerror = reject;
            img.src = reader.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function showPopupMessage(message) {
    const existing = document.querySelector('.popup-message');
    if (existing) existing.remove();
    const notice = document.createElement('div');
    notice.className = 'popup-message';
    notice.setAttribute('role', 'alert');
    notice.textContent = message;
    document.body.appendChild(notice);
    window.setTimeout(() => notice.remove(), 5000);
}

function renderMyPhoto() {
    const body = document.getElementById('myphoto-body');
    const input = document.getElementById('photo-input');

    chrome.storage.local.get({ qlothi_person_photo: '' }, (res) => {
        const photo = res.qlothi_person_photo;
        if (photo) {
            body.innerHTML = `
                <div class="myphoto-preview">
                    <img src="${photo}" alt="Your photo">
                </div>
                <div class="myphoto-actions">
                    <button class="mp-btn" id="mp-change">Change</button>
                    <button class="mp-btn mp-danger" id="mp-remove">Remove</button>
                </div>`;
            document.getElementById('mp-change').onclick = () => input.click();
            document.getElementById('mp-remove').onclick = () => {
                chrome.storage.local.remove('qlothi_person_photo', renderMyPhoto);
            };
        } else {
            body.innerHTML = `
                <button class="myphoto-upload" id="mp-upload">
                    <span class="mp-plus">+</span>
                    <span>Upload a full-body photo</span>
                </button>`;
            document.getElementById('mp-upload').onclick = () => input.click();
        }
    });

    input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
            const dataUrl = await resizeImageFile(file);
            chrome.storage.local.set({ qlothi_person_photo: dataUrl }, renderMyPhoto);
        } catch (e) {
            showPopupMessage('Could not read that image. Try a different photo.');
        }
        input.value = ''; // allow re-selecting the same file later
    };
}

document.addEventListener('DOMContentLoaded', () => {
    const grid = document.getElementById('wardrobe-grid');
    const emptyState = document.getElementById('empty-state');

    renderMyPhoto();

    function renderWardrobe() {
        chrome.storage.local.get({ qlothi_wishlist: [] }, (res) => {
            const items = res.qlothi_wishlist;
            
            if (!items || items.length === 0) {
                grid.hidden = true;
                emptyState.hidden = false;
                return;
            }

            grid.hidden = false;
            emptyState.hidden = true;
            grid.innerHTML = ''; // clear

            items.forEach((item, index) => {
                const card = document.createElement('a');
                card.href = item.link || '#';
                card.target = '_blank';
                card.className = 'wardrobe-item';
                
                const initials = (item.store || '?')[0].toUpperCase();

                card.innerHTML = `
                    <div class="w-img-box">
                        <img src="${item.image}" alt="${item.name || 'Saved product'}">
                    </div>
                    <div class="w-info">
                        <div class="w-brand">${item.store || 'Store'}</div>
                        <div class="w-name">${item.name || 'Product'}</div>
                        <div class="w-price">${item.price && item.price !== '—' ? item.price : 'Check Price'}</div>
                    </div>
                    <button class="remove-btn" type="button" title="Remove from wardrobe" aria-label="Remove ${item.name || 'product'} from wardrobe">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>
                    </button>
                `;

                // Handle removal
                const rmBtn = card.querySelector('.remove-btn');
                const productImage = card.querySelector('.w-img-box img');
                productImage.addEventListener('error', () => {
                    productImage.hidden = true;
                    productImage.parentElement.classList.add('image-unavailable');
                });
                rmBtn.addEventListener('click', (e) => {
                    e.preventDefault(); // prevent opening the link
                    e.stopPropagation();
                    
                    const newList = items.filter(i => i.link !== item.link);
                    chrome.storage.local.set({ qlothi_wishlist: newList }, () => {
                        renderWardrobe(); // Re-render
                    });
                });

                grid.appendChild(card);
            });
        });
    }

    renderWardrobe();
});
