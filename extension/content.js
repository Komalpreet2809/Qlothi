// Qlothi Content Script

console.log("Qlothi content script loaded. [build: modal-action-footer v3]");

// Backend base URL. The full-look try-on is fetched directly from here (not via
// the background worker) because MV3 tears the worker down before a ~80s chained
// request finishes ("message port closed"). The backend sends CORS * and
// http://localhost is mixed-content-exempt, so a direct fetch is allowed.
const QLOTHI_BACKEND = 'http://localhost:8009';
const QLOTHI_CLOSE_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 7l10 10M17 7 7 17" />
  </svg>`;

function qlothiNotify(message, tone = 'error') {
  const existing = document.querySelector('.qlothi-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `qlothi-toast qlothi-toast--${tone}`;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');

  const text = document.createElement('span');
  text.textContent = message;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Dismiss message');
  dismiss.innerHTML = QLOTHI_CLOSE_ICON;
  dismiss.addEventListener('click', () => toast.remove());

  toast.append(text, dismiss);
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  window.setTimeout(() => toast.remove(), 6500);
}

function injectButton() {
  // Look for the main closeup container
  const closeupContainer = document.querySelector('div[data-test-id="closeup-container"]') || 
                           document.querySelector('div.dHA5K0');

  if (!closeupContainer) return;

  // Check if we already injected to avoid duplicates
  if (closeupContainer.querySelector('.qlothi-btn')) return;

  const btn = document.createElement('button');
  btn.className = 'qlothi-btn';
  btn.innerHTML = 'Shop';
  
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Attempt to extract the image URL from the reliable visual content container
    const imgEle = closeupContainer.querySelector('div[data-test-id="visual-content"] img') || 
                   closeupContainer.querySelector('img');
                   
    if (imgEle && (imgEle.src || imgEle.dataset.src)) {
      const url = imgEle.src || imgEle.dataset.src;
      console.log("Extracted Image URL:", url);
      analyzeImage(url);
    } else {
      console.error("Could not find image element to analyze.");
    }
  });

  // Declare saveBtn before using it
  const saveBtn = closeupContainer.querySelector('button[aria-label="Pin"]') ||
                  closeupContainer.querySelector('[data-test-id="repin-button-red"]') ||
                  closeupContainer.querySelector('button[aria-label="Save"]');

  if (saveBtn && saveBtn.parentNode) {
      btn.style.position = 'static'; // Remove absolute positioning
      btn.style.marginRight = '8px';
      // Match perfectly to the native Pinterest button next to it logically
      const computedBtn = window.getComputedStyle(saveBtn);
      btn.style.height = computedBtn.height || '48px';
      btn.style.borderRadius = computedBtn.borderRadius || '24px';
      btn.style.paddingLeft = computedBtn.paddingLeft || '16px';
      btn.style.paddingRight = computedBtn.paddingRight || '16px';
      btn.style.paddingTop = computedBtn.paddingTop || '0px';
      btn.style.paddingBottom = computedBtn.paddingBottom || '0px';
      btn.style.minWidth = '60px'; // Fallback to prevent crushing
      btn.style.display = 'inline-flex';
      
      // Get the container that holds the save button
      const container = saveBtn.parentNode;
      
      // Ensure the container is a flexbox that allows side-by-side
      container.style.display = 'flex';
      container.style.alignItems = 'center';
      
      // Inject before the save button
      container.insertBefore(btn, saveBtn);
  } else {
      // Fallback: inject over the top-left of the visual content wrapper
      const visWrapper = closeupContainer.querySelector('div[data-test-id="visual-content"]');
      if (visWrapper) {
          visWrapper.style.position = 'relative';
          visWrapper.appendChild(btn);
      }
  }
}

function analyzeImage(imageUrl) {
  // Guard: if extension was reloaded, chrome.runtime becomes undefined
  if (!chrome.runtime || !chrome.runtime.sendMessage) {
    qlothiNotify('Qlothi was reloaded. Refresh this Pinterest page and try again.');
    return;
  }

  console.log("Preparing to send image to backend...");
  
  const pinBtns = document.querySelectorAll('.qlothi-btn');
  const btn = pinBtns.length > 0 ? pinBtns[pinBtns.length - 1] : null;
  const oldText = btn ? btn.innerHTML : 'Shop';
  
  if (btn) {
    btn.innerHTML = '<div class="qlothi-btn-spinner"></div>';
    btn.style.pointerEvents = 'none'; // prevent double clicks
  }

  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ success: false, error: 'Timeout waiting for background proxy.' }), 15000));

  Promise.race([
    new Promise(resolve => chrome.runtime.sendMessage({ action: "downloadImage", url: imageUrl }, resolve)),
    timeoutPromise
  ]).then((response) => {
    if (chrome.runtime.lastError) {
      qlothiNotify('Extension error: ' + chrome.runtime.lastError.message);
      if (btn) { btn.innerHTML = oldText; btn.style.pointerEvents = 'auto'; }
      return;
    }

    if (!response || !response.success) {
      console.error("Failed to fetch image data via background:", response ? response.error : 'Unknown error');
      qlothiNotify('Could not read the Pin image. ' + (response ? response.error : ''));
      if (btn) { btn.innerHTML = oldText; btn.style.pointerEvents = 'auto'; }
      return;
    }

    const base64data = response.base64_image;
    // Spinner continues natively here, no text expansion needed.

    return Promise.race([
      new Promise(resolve => chrome.runtime.sendMessage({ action: "analyzeOutfit", base64_image: base64data }, resolve)),
      timeoutPromise
    ]);
  }).then((res) => {
    if (!res) return; // Handled by first block if aborted
    
    if (chrome.runtime.lastError) {
      qlothiNotify('Could not contact the extension service: ' + chrome.runtime.lastError.message);
      if (btn) { btn.innerHTML = oldText; btn.style.pointerEvents = 'auto'; }
      return;
    }
    
    console.log("Backend proxy response:", res);
    if (btn) { btn.innerHTML = oldText; btn.style.pointerEvents = 'auto'; }
    
    if (res.success) {
      const data = res.data;
      if (data.status === 'success' && data.items && data.items.length > 0) {
        createModal(data.items, imageUrl);
      } else {
        qlothiNotify('No garments were detected in this Pin.', 'info');
      }
    } else {
      console.error("Error connecting to backend proxy:", res.error);
      qlothiNotify('Qlothi is offline. Start the local backend, then try again.');
    }
  }).catch(err => {
    console.error("Critical error in analyze promise chain:", err);
    qlothiNotify('Qlothi could not complete the request: ' + err.message);
    if (btn) { btn.innerHTML = oldText; btn.style.pointerEvents = 'auto'; }
  });
}

let currentModal = null;
let currentShopModal = null;

function openShopModal(itemName, mainModal) {
  // If a shop modal already exists, remove it
  if (currentShopModal) {
    currentShopModal.remove();
  }

  // Blur the underlying image wrapper for focus
  const imgWrapper = mainModal.querySelector('.qlothi-modal-img-wrapper');
  if (imgWrapper) {
    imgWrapper.classList.add('blurred');
  }

  const shopModal = document.createElement('div');
  shopModal.className = 'qlothi-shop-modal';
  
  // Create header
  const header = document.createElement('div');
  header.className = 'qlothi-shop-header';
  
  const title = document.createElement('h2');
  title.className = 'qlothi-shop-title';
  title.textContent = itemName;
  
  const subtitle = document.createElement('p');
  subtitle.className = 'qlothi-shop-subtitle';
  subtitle.textContent = 'Choose where you want to find similar items:';
  
  header.appendChild(title);
  header.appendChild(subtitle);
  shopModal.appendChild(header);

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'qlothi-shop-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close shopping options');
  closeBtn.innerHTML = QLOTHI_CLOSE_ICON;
  closeBtn.onclick = () => {
    shopModal.classList.remove('visible');
    if (imgWrapper) imgWrapper.classList.remove('blurred');
    setTimeout(() => {
        shopModal.remove();
        currentShopModal = null;
    }, 400);
  };
  shopModal.appendChild(closeBtn);

  // Shopping Results Container
  const results = document.createElement('div');
  results.className = 'qlothi-shop-results';

  const retailers = [
    { name: 'Qlothi visual results', shortLabel: 'Q', source: 'qlothi', url: chrome.runtime.getURL(`results.html?item=${encodeURIComponent(itemName)}&img=${encodeURIComponent(document.querySelector('.qlothi-modal-img').src)}`) },
    { name: 'Google Shopping', shortLabel: 'G', source: 'google', url: `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(itemName)}` },
    { name: 'Pinterest search', shortLabel: 'P', source: 'pinterest', url: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(itemName)}` }
  ];

  retailers.forEach(retailer => {
    const link = document.createElement('a');
    link.className = 'qlothi-shop-item';
    link.href = retailer.url;
    link.target = '_blank';
    
    link.innerHTML = `
      <div class="qlothi-shop-item-icon qlothi-shop-item-icon--${retailer.source}" aria-hidden="true">${retailer.shortLabel}</div>
      <div class="qlothi-shop-item-text">${retailer.name}</div>
      <div class="qlothi-shop-arrow" aria-hidden="true"></div>
    `;
    
    results.appendChild(link);
  });

  shopModal.appendChild(results);
  mainModal.appendChild(shopModal); // Append to main modal, not imgWrapper
  currentShopModal = shopModal;

  // Trigger animation next frame
  requestAnimationFrame(() => {
    shopModal.classList.add('visible');
  });
}

function createModal(items, imageUrl) {
  // Remove existing modal if any
  if (currentModal) {
    currentModal.remove();
  }

  // Create the dark background overlay
  const overlay = document.createElement('div');
  overlay.className = 'qlothi-modal-overlay';
  
  // Close modal when clicking the dark background
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
      currentModal = null;
    }
  });

  // Create the modal container
  const modal = document.createElement('div');
  modal.className = 'qlothi-modal';

  // Create a close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'qlothi-modal-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close outfit analysis');
  closeBtn.innerHTML = QLOTHI_CLOSE_ICON;
  closeBtn.addEventListener('click', () => {
    overlay.remove();
    currentModal = null;
  });
  modal.appendChild(closeBtn);

  // Create an image element to display the outfit in the modal
  const img = document.createElement('img');
  img.src = imageUrl;
  img.className = 'qlothi-modal-img';
  
  // Wrapper for image + SVG to keep coordinates aligned perfectly
  const imgWrapper = document.createElement('div');
  imgWrapper.className = 'qlothi-modal-img-wrapper';
  imgWrapper.appendChild(img);
  modal.appendChild(imgWrapper);

  // Wait for image to load to get accurate dimensions for the SVG
  img.onload = () => {
    // Create an SVG element spanning the whole image
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.className = 'qlothi-overlay';
    
    // Set SVG absolute, matching the image bounds
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none'; // The container ignores clicks, polygons catch them
    svg.style.zIndex = '10';

    const imgWidth = img.offsetWidth;
    const imgHeight = img.offsetHeight;

    items.forEach(item => {
      if (!item.polygon_normalized || item.polygon_normalized.length === 0) return;

      let sumX = 0;
      let sumY = 0;
      const numPoints = item.polygon_normalized.length;

      // Convert normalized [x,y] back to absolute integer [x,y]
      const pointsStr = item.polygon_normalized.map(point => {
          const px = point[0] * imgWidth;
          const py = point[1] * imgHeight;
          sumX += px;
          sumY += py;
          return `${px},${py}`;
      }).join(' ');

      const cx = sumX / numPoints;
      const cy = sumY / numPoints;

      // Draw the original polygon (transparent by default)
      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      polygon.setAttribute("points", pointsStr);
      polygon.setAttribute("class", "qlothi-item");
      polygon.setAttribute("data-id", item.id);
      polygon.setAttribute("data-class", item.class_name);
      
      // Allows hover/click only on the filled mask itself
      polygon.style.pointerEvents = 'visibleFill';

      // Create interactive link group (SVG part)
      const lineGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      lineGroup.setAttribute("class", "qlothi-link-group");
      
      // Determine line direction (point right mostly, unless too close to right edge)
      const lineLength = 100;
      const pointRight = cx < (imgWidth - 160);
      const dx = pointRight ? cx + lineLength : cx - lineLength;
      const dy = cy;

      // Center dot inside clothing item
      const centerDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      centerDot.setAttribute("cx", cx);
      centerDot.setAttribute("cy", cy);
      centerDot.setAttribute("r", "4");
      centerDot.setAttribute("class", "qlothi-dot-start");

      // Connecting line
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", cx);
      line.setAttribute("y1", cy);
      line.setAttribute("x2", dx);
      line.setAttribute("y2", dy);
      line.setAttribute("class", "qlothi-line");

      // End circle (hollow)
      const endDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      endDot.setAttribute("cx", dx);
      endDot.setAttribute("cy", dy);
      endDot.setAttribute("r", "5");
      endDot.setAttribute("class", "qlothi-dot-end");

      lineGroup.appendChild(centerDot);
      lineGroup.appendChild(line);
      lineGroup.appendChild(endDot);

      // Create HTML Label (Shop link)
      const label = document.createElement('button');
      label.className = 'qlothi-shop-circle';
      
      const displayClass = item.class_name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      label.title = `Shop ${displayClass}`;
      label.setAttribute("data-class", item.class_name);
      
      label.style.position = 'absolute';
      label.style.top = `${dy}px`;
      label.style.left = `${dx}px`;
      label.style.transform = 'translate(-50%, -50%)';

      label.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.storage.local.set({
          qlothi_current_search: {
            item: displayClass,
            img: imageUrl,
            bbox: item.bbox_normalized
          }
        }, () => {
          const resultsUrl = chrome.runtime.getURL('results.html');
          window.open(resultsUrl, '_blank');
        });
      });

      // Select specific item via polygon
      polygon.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.storage.local.set({
          qlothi_current_search: {
            item: displayClass,
            img: imageUrl,
            bbox: item.bbox_normalized
          }
        }, () => {
          const resultsUrl = chrome.runtime.getURL('results.html');
          window.open(resultsUrl, '_blank');
        });
      });


      // Hover interactions
      const elementsToHover = [polygon, lineGroup, label];
      elementsToHover.forEach(el => {
        el.addEventListener('mouseenter', () => {
          polygon.classList.add('hovered');
          lineGroup.classList.add('hovered');
          label.classList.add('hovered');
        });
        el.addEventListener('mouseleave', () => {
          polygon.classList.remove('hovered');
          lineGroup.classList.remove('hovered');
          label.classList.remove('hovered');
        });
      });

      // Add a title tooltip
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = displayClass;
      polygon.appendChild(title);

      svg.appendChild(polygon);
      svg.appendChild(lineGroup);
      imgWrapper.appendChild(label);
    });

    imgWrapper.appendChild(svg);
  };

  // Keep the primary action inside the modal so it remains visually attached to
  // the preview without covering the image or straddling the card boundary.
  const actions = document.createElement('div');
  actions.className = 'qlothi-modal-actions';

  const lookBtn = document.createElement('button');
  lookBtn.className = 'qlothi-look-btn';
  lookBtn.type = 'button';
  lookBtn.textContent = 'Try full look';
  lookBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    tryWholeLook(items, imageUrl);
  });
  actions.appendChild(lookBtn);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  currentModal = overlay;
}

// ---- Try the whole look (chained try-on of every garment) ----

function qlothiCategoryOf(name) {
  const n = (name || '').toLowerCase();
  if (/dress/.test(n)) return 'dress';
  if (/top|upper|shirt|tee|jacket|blouse/.test(n)) return 'upper';
  if (/pant|trouser|jean|skirt|lower|short/.test(n)) return 'lower';
  return null; // accessories (bag, shoes, hat...) can't be tried on
}

function qlothiCrop(baseImg, bbox) {
  const x1 = bbox[0] * baseImg.width;
  const y1 = bbox[1] * baseImg.height;
  const w = Math.max((bbox[2] - bbox[0]) * baseImg.width, 10);
  const h = Math.max((bbox[3] - bbox[1]) * baseImg.height, 10);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(baseImg, x1, y1, w, h, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.9);
}

function tryWholeLook(items, imageUrl) {
  if (!chrome.runtime || !chrome.runtime.sendMessage) {
    qlothiNotify('Qlothi was reloaded. Refresh this Pinterest page and try again.');
    return;
  }

  // Pick the largest garment per category (top / bottom / dress).
  const best = {};
  items.forEach(it => {
    const cat = qlothiCategoryOf(it.class_name);
    if (!cat) return;
    if (!best[cat] || (it.area_pct || 0) > (best[cat].area_pct || 0)) best[cat] = it;
  });
  const chosen = Object.values(best);
  if (chosen.length === 0) {
    qlothiNotify('This look only contains accessories, so it cannot be tried on.', 'info');
    return;
  }

  chrome.storage.local.get({ qlothi_person_photo: '' }, (res) => {
    if (!res.qlothi_person_photo) {
      qlothiNotify('Add a full-body photo under My photo in the Qlothi toolbar menu.', 'info');
      return;
    }
    const overlay = qlothiLookModal(chosen.length);

    // Pull the pin image as base64 (via background) so we can crop without CORS taint.
    chrome.runtime.sendMessage({ action: 'downloadImage', url: imageUrl }, (resp) => {
      if (!resp || !resp.success) { qlothiLookError(overlay, 'Could not read the pin image.'); return; }
      const baseImg = new Image();
      baseImg.onload = () => {
        const garments = chosen.map(it => ({
          image: qlothiCrop(baseImg, it.bbox_normalized),
          category: it.class_name,
        }));
        // Direct fetch (NOT via background) so the ~80s request isn't killed
        // when MV3 tears down the service worker.
        console.log('[Qlothi] Try Full Look -> POST', QLOTHI_BACKEND + '/tryon_look', '|', garments.length, 'garments');
        fetch(QLOTHI_BACKEND + '/tryon_look', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_image: res.qlothi_person_photo, garments })
        })
          .then(r => r.json())
          .then(data => {
            if (data && data.status === 'success' && data.result_image) {
              qlothiLookSuccess(overlay, data.result_image, data.applied || []);
            } else {
              qlothiLookError(overlay, (data && data.message) || 'Try-on failed. Please try again.');
            }
          })
          .catch(err => qlothiLookError(overlay, 'Could not reach the Qlothi backend. ' + err.message));
      };
      baseImg.onerror = () => qlothiLookError(overlay, 'Image load error.');
      baseImg.src = resp.base64_image;
    });
  });
}

function qlothiLookModal(numItems) {
  if (!document.getElementById('qlothi-look-style')) {
    const st = document.createElement('style');
    st.id = 'qlothi-look-style';
    st.textContent = '@keyframes qlothi-spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(st);
  }
  const ov = document.createElement('div');
  ov.className = 'qlothi-look-overlay';
  ov.innerHTML =
    '<div class="qlothi-look-card">' +
      '<button class="qlothi-look-close" type="button" aria-label="Close full-look preview">' + QLOTHI_CLOSE_ICON + '</button>' +
      '<h2>Your full look</h2>' +
      '<p class="qlothi-look-sub">' +
        'Applying ' + numItems + ' item' + (numItems > 1 ? 's' : '') + '. This may take a minute.</p>' +
      '<div class="qlothi-look-stage">' +
        '<div class="qlothi-look-spinner" aria-label="Creating preview"></div>' +
      '</div>' +
    '</div>';
  const close = () => ov.remove();
  ov.querySelector('.qlothi-look-close').onclick = close;
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.body.appendChild(ov);
  return ov;
}

function qlothiLookSuccess(ov, img, applied) {
  const sub = ov.querySelector('.qlothi-look-sub');
  if (sub) sub.textContent = applied.length ? ('Applied: ' + applied.join(' + ')) : 'Done';
  ov.querySelector('.qlothi-look-stage').innerHTML =
    '<img class="qlothi-look-result" src="' + img + '" alt="Virtual try-on result">';
  const dl = document.createElement('a');
  dl.href = img; dl.download = 'qlothi-look.jpg'; dl.textContent = 'Save image';
  dl.className = 'qlothi-look-save';
  ov.querySelector('.qlothi-look-card').appendChild(dl);
}

function qlothiLookError(ov, msg) {
  const sub = ov.querySelector('.qlothi-look-sub');
  if (sub) sub.textContent = '';
  ov.querySelector('.qlothi-look-stage').innerHTML =
    '<div class="qlothi-look-error"><span aria-hidden="true">!</span><p>' + msg + '</p></div>';
}

// Observe DOM changes to detect when a Pin is opened
const observer = new MutationObserver((mutations) => {
  injectButton();
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});

// Try to inject initially in case a Pin is already open
injectButton();
