// Qlothi Content Script

console.log("Qlothi content script loaded.");

function injectButton() {
  // Look for the main closeup container
  const closeupContainer = document.querySelector('div[data-test-id="closeup-container"]') || 
                           document.querySelector('div.dHA5K0');

  if (!closeupContainer) return;

  // Check if we already injected to avoid duplicates
  if (closeupContainer.querySelector('.qlothi-btn')) return;

  const btn = document.createElement('button');
  btn.className = 'qlothi-btn';
  btn.innerHTML = '✨ Analyze Outfit';
  
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
      btn.style.height = '48px'; // Match Pinterest standard button height
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
    alert("Qlothi extension was reloaded. Please refresh this Pinterest page and try again.");
    return;
  }

  console.log("Preparing to send image to backend...");
  
  const pinBtns = document.querySelectorAll('.qlothi-btn');
  const btn = pinBtns.length > 0 ? pinBtns[pinBtns.length - 1] : null;
  const oldText = btn ? btn.innerHTML : '✨ Analyze Outfit';
  
  if (btn) btn.innerHTML = '✨ Analyzing: Fetching Image...';

  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ success: false, error: 'Timeout waiting for background proxy.' }), 15000));

  Promise.race([
    new Promise(resolve => chrome.runtime.sendMessage({ action: "downloadImage", url: imageUrl }, resolve)),
    timeoutPromise
  ]).then((response) => {
    if (chrome.runtime.lastError) {
      alert("Extension Error: " + chrome.runtime.lastError.message);
      if (btn) btn.innerHTML = oldText;
      return;
    }

    if (!response || !response.success) {
      console.error("Failed to fetch image data via background:", response ? response.error : 'Unknown error');
      alert("Error: Could not read image data. " + (response ? response.error : ''));
      if (btn) btn.innerHTML = oldText;
      return;
    }

    const base64data = response.base64_image;
    if (btn) btn.innerHTML = '✨ Analyzing: Hitting Server...';

    return Promise.race([
      new Promise(resolve => chrome.runtime.sendMessage({ action: "analyzeOutfit", base64_image: base64data }, resolve)),
      timeoutPromise
    ]);
  }).then((res) => {
    if (!res) return; // Handled by first block if aborted
    
    if (chrome.runtime.lastError) {
      alert("Extension Error talking to backend proxy: " + chrome.runtime.lastError.message);
      if (btn) btn.innerHTML = oldText;
      return;
    }
    
    console.log("Backend proxy response:", res);
    if (btn) btn.innerHTML = oldText;
    
    if (res.success) {
      const data = res.data;
      if (data.status === 'success' && data.items && data.items.length > 0) {
        createModal(data.items, imageUrl);
      } else {
        alert("No garments detected by Qlothi AI.");
      }
    } else {
      console.error("Error connecting to backend proxy:", res.error);
      alert("Error connecting to Qlothi Backend. Make sure Python server is running.");
    }
  }).catch(err => {
    console.error("Critical error in analyze promise chain:", err);
    alert("Critical failure: " + err.message);
    if (btn) btn.innerHTML = oldText;
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
  closeBtn.innerHTML = '✕';
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
    { name: 'Qlothi Visual Results', icon: '✨', url: chrome.runtime.getURL(`results.html?item=${encodeURIComponent(itemName)}&img=${encodeURIComponent(document.querySelector('.qlothi-modal-img').src)}`) },
    { name: 'Google Shopping', icon: '🔍', url: `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(itemName)}` },
    { name: 'Pinterest Search', icon: '📌', url: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(itemName)}` }
  ];

  retailers.forEach(retailer => {
    const link = document.createElement('a');
    link.className = 'qlothi-shop-item';
    link.href = retailer.url;
    link.target = '_blank';
    
    link.innerHTML = `
      <div class="qlothi-shop-item-icon">${retailer.icon}</div>
      <div class="qlothi-shop-item-text">${retailer.name}</div>
      <div class="qlothi-shop-arrow">→</div>
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
  closeBtn.innerHTML = '✕';
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

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  currentModal = overlay;
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
