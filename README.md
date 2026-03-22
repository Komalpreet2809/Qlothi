# Qlothi: AI-Powered Fashion Hub for Pinterest

**Qlothi** is a Chrome extension that transforms your Pinterest experience into a smart fashion shopping and analysis tool. With Qlothi, you can analyze outfits within images, segment individual clothing items, and find similar products across the web using Google Lens integration.

---

## 🚀 Key Features

- **Outfit Segmentation**: Uses the `Segformer` (MATTMDJAGA/segformer_b2_clothes) transformer model to accurately identify and segment hats, sunglasses, upper clothes, skirts, pants, dresses, belts, bags, and scarves.
- **Visual Search**: Integrated Google Lens visual search to find exact or similar matches for segmented items.
- **Interactive UI**: A sleek, glassmorphism-inspired overlay that fits naturally into the Pinterest interface.
- **Smart Filtering**: Filter search results by budget, style, or luxury categories.

---

## 🛠️ Tech Stack

### Backend
- **Framework**: [FastAPI](https://fastapi.tiangolo.com/)
- **AI Models**: Hugging Face Transformers (`Segformer`), PyTorch, OpenCV
- **Web Automation**: [Playwright](https://playwright.dev/python/) & BeautifulSoup4 for Google Lens integration

### Frontend (Chrome Extension)
- **Standard**: Manifest V3
- **Logic**: Vanilla JavaScript
- **Styling**: Vanilla CSS (Premium Glassmorphism Design)

---

## 📦 Project Structure

```bash
Qlothi/
├── backend/            # FastAPI server & AI logic
│   ├── main.py        # API endpoints and model integration
│   └── requirements.txt
├── extension/          # Chrome extension files
│   ├── manifest.json
│   ├── content.js      # Pinterest DOM interaction
│   └── background.js   # Service worker
└── README.md
```

---

## ⚙️ Setup Instructions

### 1. Backend Setup (Windows/Linux/macOS)

1. Navigate to the backend directory:
   ```powershell
   cd backend
   ```
2. Create and activate a virtual environment:
   ```powershell
   python -m venv venv
   .\venv\Scripts\activate  # Windows
   # source venv/bin/activate # Linux/macOS
   ```
3. Install dependencies:
   ```powershell
   pip install -r requirements.txt
   ```
4. Install Playwright browsers:
   ```powershell
   playwright install chromium
   ```
5. Start the server:
   ```powershell
   python main.py
   ```
   *The server will run at `http://localhost:8000`.*

### 2. Chrome Extension Setup

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (top right corner).
3. Click **Load unpacked**.
4. Select the `extension` folder within the Qlothi project directory.

---

## 💡 Usage

1. Open any [Pinterest](https://www.pinterest.com) pin containing an outfit.
2. Click the **Analyze Outfit** button (integrated into the Pinterest UI).
3. Interact with the segmented clothing items to find similar products.

---

## 🌐 Deployment

### Part 1: FastAPI Backend (Hugging Face Spaces, Render, or Railway)
Because the backend uses a heavy AI classification model (`Segformer`), it requires a cloud host with at least **2GB to 4GB of RAM**:
1. Add a `Dockerfile` and push your `backend` directory to a GitHub repository.
2. Link your GitHub repository to a cloud service like Render or Hugging Face.
3. Configure the start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Once successfully deployed, copy your new live URL (e.g., `https://qlothi-api.onrender.com`).

### Part 2: Publish the Chrome Extension
1. Open your extension's JavaScript files (`background.js`, `content.js`) and replace any instances of `http://localhost:8000` with your new live backend URL.
2. Zip the entire `/extension` folder (make sure `manifest.json` is at the root of the zip file, and not buried in a subfolder).
3. Navigate to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/).
4. Click **New Item**, upload the Zip, fill out your store listing details, and click **Submit for Review**.

---

 Made with ❤️ by Kobuilds for fashion enthusiasts.
