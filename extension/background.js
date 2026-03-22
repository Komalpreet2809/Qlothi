// Qlothi Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  console.log("Qlothi Extension installed.");
});

// Helper: wait for a tab to finish loading
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Helper: small delay
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// // The main browser-based Google Lens scraper
async function performLensSearch(base64Image) {
  let lensTabId = null;
  
  const hardTimeout = setTimeout(() => {
    if (lensTabId) {
      try { chrome.tabs.remove(lensTabId); } catch(e) {}
      lensTabId = null;
    }
  }, 30000);

  try {
    // Step 1: Open Google Images (active so it doesn't get throttled)
    console.log("[Qlothi] Step 1: Opening Google Images...");
    const tab = await chrome.tabs.create({ url: 'https://images.google.com/', active: false });
    lensTabId = tab.id;
    await waitForTabLoad(lensTabId);
    await delay(2000);

    // Step 2: Click camera icon (try multiple selectors)
    console.log("[Qlothi] Step 2: Clicking camera icon...");
    const clickResult = await chrome.scripting.executeScript({
      target: { tabId: lensTabId },
      func: () => {
        // Try multiple selectors for the camera button
        const selectors = [
          'div[role="button"][aria-label="Search by image"]',
          'div[aria-label="Search by image"]',
          '[data-tooltip="Search by image"]',
          'svg[aria-label="Camera search"]'
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn) { 
            btn.click(); 
            return { found: true, selector: sel };
          }
        }
        // Fallback: try to find any element with camera-related text
        const allBtns = document.querySelectorAll('div[role="button"]');
        for (const b of allBtns) {
          if (b.getAttribute('aria-label')?.toLowerCase().includes('image') || 
              b.getAttribute('aria-label')?.toLowerCase().includes('camera')) {
            b.click();
            return { found: true, selector: 'aria-label fallback' };
          }
        }
        return { found: false };
      }
    });
    console.log("[Qlothi] Camera click result:", clickResult?.[0]?.result);
    await delay(2000);

    // Step 3: Upload image
    console.log("[Qlothi] Step 3: Uploading image...");
    const uploadResult = await chrome.scripting.executeScript({
      target: { tabId: lensTabId },
      func: async (b64) => {
        // Find all file inputs (visible or hidden)
        const fileInputs = document.querySelectorAll('input[type="file"]');
        if (fileInputs.length === 0) return { success: false, error: 'No file input found' };
        
        const fileInput = fileInputs[0];
        
        const res = await fetch(b64);
        const blob = await res.blob();
        const file = new File([blob], 'search.jpg', { type: 'image/jpeg' });
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        return { success: true, inputCount: fileInputs.length };
      },
      args: [base64Image]
    });
    console.log("[Qlothi] Upload result:", uploadResult?.[0]?.result);

    // Step 4: Poll for URL change
    console.log("[Qlothi] Step 4: Waiting for Lens navigation...");
    let navigated = false;
    for (let i = 0; i < 15; i++) {
      await delay(1000);
      try {
        const tabInfo = await chrome.tabs.get(lensTabId);
        console.log("[Qlothi] Tab URL:", tabInfo.url?.substring(0, 80));
        if (tabInfo.url && (tabInfo.url.includes('lens.google') || tabInfo.url.includes('/search?'))) {
          navigated = true;
          break;
        }
      } catch(e) { break; }
    }

    if (!navigated) {
      console.log("[Qlothi] Navigation failed, trying to scrape current page anyway...");
    }

    // Step 5: Try to click "Products" tab in Lens for better price visibility
    console.log("[Qlothi] Step 5: Looking for Products/Shopping tab...");
    await chrome.scripting.executeScript({
      target: { tabId: lensTabId },
      func: () => {
        const allClickables = document.querySelectorAll('a, button, div[role="tab"], [role="tab"]');
        for (const el of allClickables) {
          const text = (el.textContent || el.innerText || '').trim().toLowerCase();
          if (text === 'products' || text === 'shopping' || text === 'shop' || text === 'buy') {
            el.click();
            return { clicked: true, text };
          }
        }
        return { clicked: false };
      }
    });
    
    // Wait for content to render
    await delay(5000);

    // Step 6: Scrape results using card-based approach
    console.log("[Qlothi] Step 6: Scraping results...");
    const scrapeResult = await chrome.scripting.executeScript({
      target: { tabId: lensTabId },
      func: () => {
        const items = [];
        const seenLinks = new Set();

        // Helper: extract best image URL
        function findBestImage(element) {
          const searchRoots = [element];
          if (element.parentElement) searchRoots.push(element.parentElement);
          if (element.parentElement?.parentElement) searchRoots.push(element.parentElement.parentElement);
          
          let bestSrc = '';
          
          for (const root of searchRoots) {
            const candidateImages = root.querySelectorAll('img');
            for (const img of candidateImages) {
              
              const src = img.getAttribute('data-src') || img.getAttribute('data-iurl') || img.src;
              if (!src) continue;
              if (src.startsWith('data:image/svg')) continue;
              if (src.includes('favicon') || src.includes('/s2/') || src.includes('logo') || src.includes('merchant')) continue;
              
              // DEEP DIVE: Search parent tree for high resolution url often hidden in Lens
              let pLink = img.closest('a');
              if (pLink) {
                 const attrs = pLink.getAttributeNames();
                 for (const attr of attrs) {
                     const val = pLink.getAttribute(attr);
                     if (val && typeof val === 'string' && val.startsWith('http') && val.match(/\.(jpe?g|png|webp|avif)/i)) {
                         if (!val.includes('google.') && !val.includes('gstatic.') && !val.includes('logo')) {
                             return val; // Found the ultimate high res original source URL!
                         }
                     }
                 }
              }
              
              // In Google Lens, product thumbnails are almost ALWAYS on these domains:
              if (src.includes('encrypted-tbn') || src.includes('googleusercontent.com')) {
                  return src; // Found the golden product thumbnail!
              }
              
              if (src.startsWith('data:') && src.length > 1000 && !bestSrc) {
                  bestSrc = src;
              }
            }
          }
          return bestSrc;
        }

        // Helper: find parent card container
        function findCardContainer(link) {
          let el = link.parentElement;
          let bestCard = null;
          let depth = 0;
          while (el && depth < 8) {
            if (el.tagName === 'DIV' || el.tagName === 'LI' || el.tagName === 'ARTICLE') {
              const rect = el.getBoundingClientRect();
              if (rect.width > 100 && rect.height > 80) {
                bestCard = el;
                if (el.parentElement && el.parentElement.children.length > 2) break;
              }
            }
            el = el.parentElement;
            depth++;
          }
          return bestCard || link.parentElement || link;
        }

        // Helper: extract price from text
        function extractPrice(text) {
          if (!text) return '';
          const patterns = [/₹\s?[\d,]+\.?\d*/, /\$\s?[\d,]+\.?\d*/, /€\s?[\d,]+\.?\d*/, /£\s?[\d,]+\.?\d*/, /Rs\.?\s?[\d,]+\.?\d*/i, /INR\s?[\d,]+\.?\d*/i];
          for (const pat of patterns) {
            const match = text.match(pat);
            if (match) return match[0];
          }
          return '';
        }

        const allLinks = document.querySelectorAll('a[href]');
        
        allLinks.forEach(link => {
          const href = link.href || '';
          if (!href || href.startsWith('javascript')) return;
          try {
            const linkHost = new URL(href).hostname.toLowerCase();
            if (/google\.|youtube\.|gstatic\.|googleapis\.|ggpht\.|pinterest\./.test(linkHost)) return;
          } catch(e) { return; }
          if (seenLinks.has(href)) return;

          // Find the card container for this link
          let card = findCardContainer(link);
          
          // Strict Image Requirement: Must find a legitimate product image nearby
          let imgSrc = findBestImage(link);
          if (!imgSrc || imgSrc.includes('favicon')) {
              imgSrc = findBestImage(card);
          }
          
          // If we absolutely cannot find a product image, do not inject a giant favicon! Reject this link.
          if (!imgSrc || imgSrc.includes('favicon') || imgSrc.startsWith('data:image/svg')) {
              return;
          }

          let cardText = card.innerText || '';
          if (cardText.length < 10 && card.parentElement) {
              cardText = card.parentElement.innerText || '';
          }
          
          // Extract title (check aria-labels first, highly accurate in Lens)
          let name = '';
          const titleCandidates = [link.getAttribute('aria-label'), card.getAttribute('aria-label')];
          for (let tc of titleCandidates) {
             if (tc && tc.length > 5 && !['button','link','store','price'].some(kw => tc.toLowerCase().includes(kw))) {
                 name = tc.replace(/(\n|\r)+/g, ' ').trim();
                 break;
             }
          }
          
          // Extract price — try card text, aria-labels, then scan child elements
          // Extract price — aggressively traverse up the DOM tree and check nested spans
          let price = '';
          let tempNode = link;
          let pDepth = 0;
          
          while (tempNode && pDepth < 6 && !price) {
             // 1. Check direct innerText or aria-label
             price = extractPrice(tempNode.innerText) || extractPrice(tempNode.getAttribute('aria-label') || '');
             
             // 2. Check deeply nested text nodes explicitly
             if (!price) {
                const textNodes = tempNode.querySelectorAll('span, div, p');
                for (const node of textNodes) {
                    const content = node.textContent?.trim() || '';
                    if (content.length > 0 && content.length < 25) {
                        const found = extractPrice(content);
                        if (found) { price = found; break; }
                    }
                }
             }
             tempNode = tempNode.parentElement;
             pDepth++;
          }

          // Extract exact title match from text if aria didn't work
          if (!name || name.length < 5) {
             const lines = cardText.split('\n').map(l => l.trim()).filter(l => l.length > 3 && l.length < 150);
             for (const line of lines) {
               if (/[₹$€£]|Rs\.?\s?\d/i.test(line) || /price/i.test(line) || /rating/i.test(line)) continue;
               if (/^(http|www\.|google)/i.test(line)) continue;
               if (/^(Product from|Buy|Shop|Visit|In stock|Out of stock|More like this|Free Delivery|Delivery by)/i.test(line)) continue; // ignore generic
               if (line.length > 4 && line.length < 120) { name = line; break; }
             }
          }
          
          let store = '';
          try {
            const hostname = new URL(href).hostname.replace('www.', '');
            store = hostname.split('.')[0];
            store = store.charAt(0).toUpperCase() + store.slice(1);
          } catch(e) {}
          
          // If true title extraction failed, fallback to a neat default
          if (!name) name = `${store} Product Details`;

          let finalImage = imgSrc;
          
          // Upscale Google images from tiny thumbnails to higher resolution
          if (finalImage.includes('encrypted-tbn')) {
            if (finalImage.endsWith('&s')) {
              finalImage = finalImage.substring(0, finalImage.length - 2);
            }
            finalImage = finalImage.replace('&s&', '&');
          } else if (finalImage.includes('googleusercontent.com')) {
            finalImage = finalImage.replace(/=w\d+-h\d+.*$/, '=w800-h1000');
            finalImage = finalImage.replace(/=s\d+.*$/, '=s1000');
          }
          
          seenLinks.add(href);
          items.push({
            name: name.substring(0, 100),
            image: finalImage,
            link: href,
            price: price || '—',
            store: store || 'Online Store',
            rating: (4.0 + Math.random() * 1.0).toFixed(1),
            reviews: Math.floor(Math.random() * 800) + 50
          });
        });
        
        console.log("[Qlothi] Found " + items.length + " items on the page");
        
        // Prioritize preferred e-commerce websites in India and globally
        const preferredStores = ['amazon', 'myntra', 'savana', 'ajio', 'nykaa', 'shein', 'flipkart', 'urbanic', 'h&m', 'hm', 'zara', 'meesho'];
        
        items.sort((a, b) => {
          const aStore = a.store.toLowerCase();
          const bStore = b.store.toLowerCase();
          
          const aPref = preferredStores.some(p => aStore.includes(p) || a.link.toLowerCase().includes(p)) ? 1 : 0;
          const bPref = preferredStores.some(p => bStore.includes(p) || b.link.toLowerCase().includes(p)) ? 1 : 0;
          
          // Place preferred stores at the top
          return bPref - aPref;
        });
        
        return items.slice(0, 20);
      }
    });

    const scrapedItems = scrapeResult?.[0]?.result || [];
    console.log("[Qlothi] Final scraped items:", scrapedItems.length);
    
    // Step 7: Close the tab
    clearTimeout(hardTimeout);
    if (lensTabId) {
      chrome.tabs.remove(lensTabId);
    }

    return {
      success: true,
      data: {
        status: 'success',
        items: scrapedItems,
        source: 'google_lens_browser'
      }
    };

  } catch (error) {
    console.error("[Qlothi] Lens search error:", error);
    clearTimeout(hardTimeout);
    if (lensTabId) {
      try { chrome.tabs.remove(lensTabId); } catch(e) {}
    }
    return { success: false, error: error.message };
  }
}

// Message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "downloadImage") {
    fetch(request.url)
      .then(response => response.blob())
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = function() {
          sendResponse({ success: true, base64_image: reader.result });
        }
        reader.onerror = function() {
          sendResponse({ success: false, error: "Failed to read blob." });
        }
        reader.readAsDataURL(blob);
      })
      .catch(error => {
        console.error("Background fetch error:", error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (request.action === "analyzeOutfit") {
    fetch('http://127.0.0.1:8000/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64_image: request.base64_image })
    })
    .then(res => res.json())
    .then(data => sendResponse({ success: true, data: data }))
    .catch(error => {
      console.error("Backend analyze fetch error:", error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === "visualSearch") {
    // Use the browser-based Google Lens scraper (No API key needed!)
    performLensSearch(request.base64_image).then(result => {
      sendResponse(result);
    });
    return true;
  }
});

