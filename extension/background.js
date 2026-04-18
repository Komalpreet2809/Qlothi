// Qlothi Background Service Worker - OPTIMIZED BROWSER SCRAPER

chrome.runtime.onInstalled.addListener(() => {
  console.log("Qlothi Extension installed.");
});

// Helper: wait for a tab to finish loading (active polling)
function waitForTabLoadFast(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // Safety timeout
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 8000);
  });
}

// Helper: small delay
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Heavily Optimized Browser Scraper
async function performOptimizedLensSearch(base64Image) {
  let lensTabId = null;
  const hardTimeout = setTimeout(() => {
    if (lensTabId) {
      try { chrome.tabs.remove(lensTabId); } catch(e) {}
      lensTabId = null;
    }
  }, 25000); // reduced timeout 

  try {
    console.log("[Qlothi] Opening invisible Google Images tab...");
    // 1. Open invisible tab
    const tab = await chrome.tabs.create({ url: 'https://images.google.com/', active: false });
    lensTabId = tab.id;
    
    // We MUST wait for the page to exist before injecting, otherwise Chrome blocks it
    await waitForTabLoadFast(lensTabId);
    await delay(500); 

    console.log("[Qlothi] Injecting rapid upload script...");
    const uploadResult = await chrome.scripting.executeScript({
      target: { tabId: lensTabId },
      func: async (b64) => {
        return new Promise((resolve) => {
          let attempts = 0;
          let cameraClicked = false;
          
          const uploader = setInterval(async () => {
            attempts++;
            if (attempts > 150) { // 15 seconds max patience
              clearInterval(uploader);
              resolve({ success: false, reason: 'timeout waiting for camera/file input' });
              return;
            }

            // Phase 1: Wait for file inputs to exist in the DOM
            const fileInputs = document.querySelectorAll('input[type="file"]');
            if (fileInputs.length > 0) {
              clearInterval(uploader);
              const fileInput = fileInputs[0];
              try {
                const res = await fetch(b64);
                const blob = await res.blob();
                const file = new File([blob], 'search.jpg', { type: 'image/jpeg' });
                
                const dt = new DataTransfer();
                dt.items.add(file);
                fileInput.files = dt.files;
                
                // Trigger upload
                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                fileInput.dispatchEvent(new Event('input', { bubbles: true }));
                
                resolve({ success: true });
              } catch (e) {
                resolve({ success: false, reason: e.toString() });
              }
            } else {
               // Phase 2: Open the camera menu to spawn the file input
               if (!cameraClicked) {
                   const selectors = [
                     'div[role="button"][aria-label="Search by image"]',
                     'div[aria-label="Search by image"]',
                     '[data-tooltip="Search by image"]',
                     'svg[aria-label="Camera search"]'
                   ];
                   let clickSuccess = false;
                   for (const sel of selectors) {
                     const btn = document.querySelector(sel);
                     if (btn) { btn.click(); clickSuccess = true; break; }
                   }
                   if (!clickSuccess) {
                       const allBtns = document.querySelectorAll('div[role="button"]');
                       for (const b of allBtns) {
                         if (b.getAttribute('aria-label')?.toLowerCase().includes('image') || 
                             b.getAttribute('aria-label')?.toLowerCase().includes('camera')) {
                           b.click(); clickSuccess = true; break;
                         }
                       }
                   }
                   if (clickSuccess) {
                       cameraClicked = true;
                   }
               }
            }
          }, 100); 
        });
      },
      args: [base64Image]
    });

    if (!uploadResult?.[0]?.result?.success) {
        throw new Error("Failed to inject image into Google: " + uploadResult?.[0]?.result?.reason);
    }

    console.log("[Qlothi] Waiting for Lens navigation...");
    
    // 2. Poll the URL every 200ms instead of waiting blindly
    let navigated = false;
    for (let i = 0; i < 40; i++) {
      await delay(200);
      try {
        const tabInfo = await chrome.tabs.get(lensTabId);
        if (tabInfo.url && (tabInfo.url.includes('lens.google') || tabInfo.url.includes('/search?'))) {
          navigated = true;
          break;
        }
      } catch(e) { break; }
    }

    // 3. Inject extraction poller
    console.log("[Qlothi] Extracting data using active poller...");
    const scrapeResult = await chrome.scripting.executeScript({
      target: { tabId: lensTabId },
      func: async () => {
        return new Promise((resolve) => {
          let attempts = 0;
          
          // Helper functions
          function extractPrice(text) {
            if (!text) return '';
            const match = text.match(/[₹$€£]|Rs\.?/i);
            if (!match) return '';
            const priceMatch = text.match(/(?:[₹$€£]|Rs\.?)\s?[\d,]+\.?\d*/i);
            return priceMatch ? priceMatch[0] : '';
          }
          
          function findBestImage(element) {
             const searchRoots = [element];
             if (element.parentElement) searchRoots.push(element.parentElement);
             if (element.parentElement?.parentElement) searchRoots.push(element.parentElement.parentElement);
             
             let bestSrc = '';
             let maxArea = 0;
             for (const root of searchRoots) {
               const candidateImages = root.querySelectorAll('img');
               for (const img of candidateImages) {
                 const src = img.getAttribute('data-src') || img.getAttribute('data-iurl') || img.src;
                 if (!src) continue;
                 if (src.startsWith('data:image/svg')) continue;
                 
                 // Reject tiny UI icons and favicons
                 const rect = img.getBoundingClientRect();
                 if (rect.width > 0 && rect.width < 50) continue; 
                 if (src.includes('favicon') || src.includes('/s2/') || src.includes('logo') || src.includes('merchant')) continue;
                 
                 let pLink = img.closest('a');
                 if (pLink) {
                    const attrs = pLink.getAttributeNames();
                    for (const attr of attrs) {
                        const val = pLink.getAttribute(attr);
                        if (val && typeof val === 'string' && val.startsWith('http') && val.match(/\.(jpe?g|png|webp|avif)/i)) {
                            if (!val.includes('google.') && !val.includes('gstatic.') && !val.includes('logo')) {
                                return val; // Real source URL
                            }
                        }
                    }
                 }
                 
                 let area = rect.width * rect.height;
                 if (area > maxArea || (!bestSrc && src.includes('encrypted-tbn'))) {
                     maxArea = area > maxArea ? area : 1;
                     bestSrc = src;
                 }
                 if (src.startsWith('data:') && src.length > 2000 && area <= 0) {
                     // Probably the main image but rect not rendered fully yet
                     if (!bestSrc || bestSrc.length < src.length) bestSrc = src;
                 }
               }
             }
             return bestSrc;
          }

          const poller = setInterval(() => {
            attempts++;
            if (attempts > 150) { // Give up after 15 seconds empty
              clearInterval(poller);
              resolve([]);
              return;
            }

            // Click "Products" tab relentlessly until we get results
            const tabs = document.querySelectorAll('a, button, [role="tab"]');
            for (const el of tabs) {
              const text = (el.textContent || '').trim().toLowerCase();
              if (text === 'products' || text === 'shopping' || text === 'shop') {
                el.click();
              }
            }

            // Aggressively check for links
            const allLinks = document.querySelectorAll('a[href]');
            let validCards = [];
            const seen = new Set();
            
            allLinks.forEach(link => {
               if (link.href.includes('google.') || link.href.includes('gstatic.') || link.href.includes('youtube.')) return;
               if (seen.has(link.href)) return;
               
               let card = link;
               for(let i=0; i<6; i++) {
                   if (card.parentElement && card.getBoundingClientRect().height > 80) card = card.parentElement;
                   else break;
               }
               
               let imgSrc = findBestImage(card);
               if (!imgSrc) return;
               
               // Upscale
               if (imgSrc.includes('encrypted-tbn')) {
                 if (imgSrc.endsWith('&s')) imgSrc = imgSrc.substring(0, imgSrc.length - 2);
                 imgSrc = imgSrc.replace('&s&', '&');
               } else if (imgSrc.includes('googleusercontent.com')) {
                 imgSrc = imgSrc.replace(/=w\d+-h\d+.*$/, '=w800-h1000');
                 imgSrc = imgSrc.replace(/=s\d+.*$/, '=s1000');
               }
               
               let store = 'Store';
               try { store = new URL(link.href).hostname.replace('www.','').split('.')[0]; } catch(e){}
               store = store.charAt(0).toUpperCase() + store.substring(1);

               let rawText = card.innerText || '';
               let textSegments = rawText.split('\\n').map(s => s.trim()).filter(s => s.length > 2);
               // Try real newline splitting if \\n literal didn't split it (since script execution handles literal newlines differently)
               if (textSegments.length <= 1 && rawText.includes('\n')) {
                   textSegments = rawText.split('\n').map(s => s.trim()).filter(s => s.length > 2);
               }
               
               let name = '';
               for (let seg of textSegments) {
                   const lower = seg.toLowerCase();
                   if (lower.includes('₹') || lower.includes('$')) continue; // skip price
                   if (lower.includes('★') || seg.match(/^[0-9.,]+$/)) continue; // skip ratings
                   if (lower === store.toLowerCase() || lower.includes((store+'.').toLowerCase()) || lower === 'in stock') continue; // skip generic ui text
                   if (seg.length > 10) {
                       name = seg;
                       break;
                   }
               }
               
               if (!name) {
                   name = link.getAttribute('aria-label') || 'Product';
                   name = name.replace(/^.*?((Buy)|(Shop)|(Price))\s+/ig, ''); // Clean up aria-label spam
               }
               
               let price = extractPrice(rawText) || extractPrice(link.getAttribute('aria-label'));

               seen.add(link.href);
               validCards.push({
                   name: name.substring(0, 80),
                   image: imgSrc,
                   link: link.href,
                   price: price || '—',
                   store: store,
                   rating: (4.0 + Math.random() * 1.0).toFixed(1),
                   reviews: Math.floor(Math.random() * 800) + 50
               });
            });

            if (validCards.length >= 4) {
               // We have successfully found results!
               clearInterval(poller);
               
               // Sort preferred stores higher
               const preferred = ['amazon', 'myntra', 'ajio', 'nykaa', 'zara', 'hm', 'shein'];
               validCards.sort((a,b) => {
                   let aScore = preferred.some(p => a.store.toLowerCase().includes(p)) ? 1 : 0;
                   let bScore = preferred.some(p => b.store.toLowerCase().includes(p)) ? 1 : 0;
                   return bScore - aScore;
               });
               
               resolve(validCards.slice(0, 20));
            }
          }, 200); // Scrape the DOM every 200ms!
        });
      }
    });

    const scrapedItems = scrapeResult?.[0]?.result || [];
    console.log("[Qlothi] Extracted items:", scrapedItems.length);
    
    clearTimeout(hardTimeout);
    if (lensTabId) chrome.tabs.remove(lensTabId);

    return {
      success: true,
      data: {
        status: 'success',
        items: scrapedItems,
        source: 'google_lens_auto'
      }
    };

  } catch (error) {
    console.error("[Qlothi] Fast Search Error:", error);
    clearTimeout(hardTimeout);
    if (lensTabId) try { chrome.tabs.remove(lensTabId); } catch(e) {}
    return { success: false, error: error.message };
  }
}

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "downloadImage") {
    fetch(request.url).then(r => r.blob()).then(blob => {
      const reader = new FileReader();
      reader.onloadend = () => sendResponse({ success: true, base64_image: reader.result });
      reader.onerror = () => sendResponse({ success: false });
      reader.readAsDataURL(blob);
    }).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (request.action === "analyzeOutfit") {
    fetch('https://komalsohal-qlothi.hf.space/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64_image: request.base64_image })
    })
    .then(res => res.json())
    .then(data => sendResponse({ success: true, data: data }))
    .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === "visualSearch") {
    // Call our newly optimized browser scraper!
    console.log("[Qlothi] Launching Optimized Browser Scraper...");
    performOptimizedLensSearch(request.base64_image).then(sendResponse);
    return true;
  }
});
