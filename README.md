# Qlothi: AI-Powered Multimodal Fashion Search

**Qlothi** is a state-of-the-art Chrome extension that transforms your Pinterest experience into a hyper-intelligent fashion shopping ecosystem. It leverages cutting-edge Vision-Language Models (VLM) and local browser-based scraping to find, save, and curate fashion items in real-time.

---

## ✨ High-End Features

- **AI Multimodal Search**: Uses **Salesforce BLIP** (Vision-Language Model) to generate semantic descriptions of clothing (e.g., *"A vintage denim jacket with sherpa lining"*) and injects them into search queries for extreme accuracy.
- **Outfit Segmentation**: Uses the **Segformer** transformer model to precisely identify and isolate individual garments within high-density Pinterest images.
- **Virtual Wardrobe (Wishlist)**: A dedicated persistent storage dashboard. Save your favorite finds with a single click and access them anytime via the extension's toolbar popup.
- **India Localization**: Hard-coded to prioritize Indian retailers (Amazon.in, Myntra, Ajio, Nykaa, etc.) while automatically filtering out non-shipping international domains and foreign currencies ($/€/£).
- **Glassmorphism UI**: A premium, motion-heavy interface that blends seamlessly with modern web design aesthetics.
- **Free & Unlimited**: Unlike other tools, Qlothi uses local browser logic to scrape Google Lens, requiring zero expensive third-party API keys for visual search.

---

## 🛠️ Architecture

### AI Backend (FastAPI)
- **Segmentation**: Segformer (`mattmdjaga/segformer_b2_clothes`)
- **Vision-Language**: BLIP (`Salesforce/blip-image-captioning-base`)
- **Hosting**: Hugging Face Spaces (GPU/CPU)

### Frontend (Chrome Extension)
- **Manifest V3**: Using modern Service Worker architectures.
- **Active Polling Scraper**: A 100ms ultra-fast DOM polling engine that manages invisible browser tabs for Google Lens.
- **Storage**: Chrome Local Storage for persistent "Virtual Wardrobe" items.

---

## 📦 Project Structure

```bash
Qlothi/
├── backend/            # FastAPI AI Server
│   ├── main.py        # Segmentation & VLM logic
│   ├── Dockerfile
│   └── requirements.txt
├── extension/          # Chrome Extension
│   ├── manifest.json
│   ├── background.js   # AI Orchestrator & Scraper
│   ├── content.js      # Pinterest Injection
│   ├── results.js/css  # Search UI
│   └── popup.js/css    # Wardrobe Dashboard
└── README.md
```

---

## ⚙️ Installation

### 1. Backend (Already Deployed)
The backend is currently hosted at: `https://komalsohal-qlothi.hf.space/`

### 2. Chrome Extension
1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `/extension` folder from this repository.

---

## 💡 Usage

1. **Pinterest**: Open any pin. Click the **Analyze Outfit** button on the image.
2. **Interact**: Click on the visual dots to trigger an AI search.
3. **Save**: Click the Heart (♥️) button on any product card to save it.
4. **Wardrobe**: Click the Qlothi icon in your browser toolbar to view your saved fashion items.

---

Made with ❤️ for the future of fashion.

