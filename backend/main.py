from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
import base64
import os
import asyncio
import tempfile
import traceback
import numpy as np
import cv2
from io import BytesIO
from PIL import Image

# gradio_client is only needed for the live (free GPU Space) try-on path.
# Import it lazily so the backend still boots if it isn't installed yet — in
# that case /tryon simply uses the CPU overlay fallback.
try:
    from gradio_client import Client, handle_file
    _HAS_GRADIO = True
except Exception:
    _HAS_GRADIO = False

app = FastAPI(title="Qlothi Backend")

# Enable CORS so the Chrome extension can make requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load the fashion segmentation model on startup
print("Loading Segformer fashion model (first run downloads ~350MB)...")
from transformers import SegformerImageProcessor, AutoModelForSemanticSegmentation
import torch

processor = SegformerImageProcessor.from_pretrained("mattmdjaga/segformer_b2_clothes")
fashion_model = AutoModelForSemanticSegmentation.from_pretrained("mattmdjaga/segformer_b2_clothes")
fashion_model.eval()
print("Fashion model loaded!")

print("Loading BLIP captioning model (first run downloads ~950MB)...")
from transformers import BlipProcessor, BlipForConditionalGeneration
blip_processor = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-base")
blip_model = BlipForConditionalGeneration.from_pretrained("Salesforce/blip-image-captioning-base")
blip_model.eval()
print("BLIP model loaded!")

# ATR label map produced by mattmdjaga/segformer_b2_clothes
LABEL_MAP = {
    0: "background", 1: "hat", 2: "hair", 3: "sunglasses",
    4: "upper-clothes", 5: "skirt", 6: "pants", 7: "dress",
    8: "belt", 9: "left-shoe", 10: "right-shoe", 11: "face",
    12: "left-leg", 13: "right-leg", 14: "left-arm", 15: "right-arm",
    16: "bag", 17: "scarf"
}

# Synthetic id: left-shoe (9) + right-shoe (10) are merged into one "Footwear" category
# so the user doesn't get two differently-labeled dots for one pair of shoes.
FOOTWEAR_CLASS = 100
SHOE_CLASSES = (9, 10)

# Classes the user can actually shop for.
SHOPPABLE_CLASSES = (1, 3, 4, 5, 6, 7, 8, FOOTWEAR_CLASS, 16, 17)

FRIENDLY_NAMES = {
    1: "Hat", 3: "Sunglasses", 4: "Top / Upper Wear",
    5: "Skirt", 6: "Pants", 7: "Dress", 8: "Belt",
    FOOTWEAR_CLASS: "Footwear",
    16: "Bag", 17: "Scarf / Accessory"
}

# Small accessories otherwise get dropped on full-body pins where they occupy very little area.
SMALL_ITEM_CLASSES = {1, 3, 8}  # hat, sunglasses, belt
MIN_AREA_PCT_DEFAULT = 0.005
MIN_AREA_PCT_SMALL = 0.001
# Contours smaller than this fraction of the largest contour for the same class are treated as fragments.
CONTOUR_KEEP_RATIO = 0.15


def _build_class_mask(seg_map: np.ndarray, class_id: int) -> np.ndarray:
    if class_id == FOOTWEAR_CLASS:
        combined = (seg_map == SHOE_CLASSES[0]) | (seg_map == SHOE_CLASSES[1])
        return combined.astype(np.uint8) * 255
    return (seg_map == class_id).astype(np.uint8) * 255


def _class_confidence(probs: np.ndarray, low_res_seg: np.ndarray, class_id: int) -> float:
    """Mean softmax score over pixels the model argmax-assigned to this class."""
    if class_id == FOOTWEAR_CLASS:
        mask = (low_res_seg == SHOE_CLASSES[0]) | (low_res_seg == SHOE_CLASSES[1])
        if not mask.any():
            return 0.0
        return float((probs[SHOE_CLASSES[0]] + probs[SHOE_CLASSES[1]])[mask].mean())
    mask = (low_res_seg == class_id)
    if not mask.any():
        return 0.0
    return float(probs[class_id][mask].mean())


def _extract_items(class_mask: np.ndarray, class_id: int, width: int, height: int, confidence: float):
    """Clean the mask morphologically, then emit one item per significant contour."""
    # Open removes speckles, close fills pinholes (e.g. skin peeking through a blouse).
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    cleaned = cv2.morphologyEx(class_mask, cv2.MORPH_OPEN, kernel, iterations=1)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(cleaned, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []

    min_area_pct = MIN_AREA_PCT_SMALL if class_id in SMALL_ITEM_CLASSES else MIN_AREA_PCT_DEFAULT
    min_area_px = width * height * min_area_pct
    largest_area = max(cv2.contourArea(c) for c in contours)
    keep_floor = largest_area * CONTOUR_KEEP_RATIO

    items = []
    for idx, contour in enumerate(sorted(contours, key=cv2.contourArea, reverse=True)):
        area = cv2.contourArea(contour)
        if area < min_area_px or area < keep_floor:
            continue

        epsilon = 0.005 * cv2.arcLength(contour, True)
        simplified = cv2.approxPolyDP(contour, epsilon, True)
        if len(simplified) < 4:
            continue

        polygon = [[float(pt[0][0]) / width, float(pt[0][1]) / height] for pt in simplified]
        px = [p[0] for p in polygon]
        py = [p[1] for p in polygon]
        bbox = [min(px), min(py), max(px), max(py)]

        items.append({
            "id": f"item_{class_id}_{idx}",
            "class_name": FRIENDLY_NAMES.get(class_id, LABEL_MAP.get(class_id, "Item")),
            "confidence": round(confidence, 3),
            "polygon_normalized": polygon,
            "bbox_normalized": bbox,
            "area_pct": round(area / (width * height), 4),
        })
    return items


# ---------------------------------------------------------------------------
# Virtual Try-On
# ---------------------------------------------------------------------------
# Strategy: try a free public ZeroGPU VTON Space first (photorealistic), and if
# it's queued / over-quota / down, degrade to a Segformer-guided CPU overlay so
# the feature never fully dies. Both paths are $0.

# Public ZeroGPU Space running FASHN VTON v1.5 (open-source, Apache-2.0). It is
# maskless + pixel-space -> sharper detail and better colour fidelity than
# IDM-VTON, and it handles tops/bottoms/one-pieces natively (no custom mask).
# Overridable via env; `merve/fashn-vton-1.5` is an equivalent mirror.
VTON_SPACE = os.environ.get("QLOTHI_VTON_SPACE", "fashn-ai/fashn-vton-1.5")
# A *free* (non-PRO) HF token grants a small daily ZeroGPU quota for calls to
# public Spaces. Optional — anonymous calls still work but are throttled harder.
HF_TOKEN = os.environ.get("HF_TOKEN") or None
# Give up on the live Space after this long and fall back to the overlay.
VTON_SPACE_TIMEOUT_S = 150
# Set QLOTHI_SSL_VERIFY=0 when on a network that does SSL inspection (corporate
# proxy / VPN / AV), which otherwise breaks gradio_client with a self-signed-cert
# error. Defaults to verifying (safe for the HF deployment).
VTON_SSL_VERIFY = os.environ.get("QLOTHI_SSL_VERIFY", "1") != "0"

# ---- PRIMARY engine: Google Gemini 2.5 Flash Image ("Nano Banana") ----
# Best free quality: hosted (no local GPU), 500 images/day free tier, and a true
# generative model — so it preserves each garment's real colour / neckline /
# length far better than warping VTON, and can dress a whole outfit in ONE call.
# Needs a free key from https://aistudio.google.com (loaded from backend/.gemini_key).
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY") or None
GEMINI_IMAGE_MODEL = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image")
try:
    from google import genai as _genai
    _HAS_GENAI = True
except Exception:
    _HAS_GENAI = False

# ---- Self-hosted IDM-VTON on RunPod (PRIMARY engine) ----
# Our own RunPod GPU pod runs the official IDM-VTON gradio app; we call it with
# gradio_client. No per-image cost — pay only for GPU time while the pod is up.
# Set RUNPOD_GRADIO_URL to the pod's public URL, e.g.
#   https://<pod-id>-7860.proxy.runpod.net   (loaded from backend/.runpod_url)
RUNPOD_GRADIO_URL = os.environ.get("RUNPOD_GRADIO_URL") or None
RUNPOD_TIMEOUT_S = int(os.environ.get("RUNPOD_TIMEOUT_S", "300"))  # allow cold start

# Our internal category -> FASHN's category enum.
_FASHN_CATEGORY = {"upper_body": "tops", "lower_body": "bottoms", "dresses": "one-pieces"}

# Map the garment label coming from the extension to an IDM-VTON category and to
# the Segformer class ids used to locate that region on the person (overlay).
_CATEGORY_KEYWORDS = {
    "dress": "dresses",
    "skirt": "lower_body",
    "pant": "lower_body",
    "trouser": "lower_body",
    "jean": "lower_body",
    "lower": "lower_body",
    "upper": "upper_body",
    "top": "upper_body",
    "shirt": "upper_body",
    "tee": "upper_body",
    "jacket": "upper_body",
}
def _normalize_category(raw: str) -> str:
    text = (raw or "").strip().lower()
    for keyword, vton_cat in _CATEGORY_KEYWORDS.items():
        if keyword in text:
            return vton_cat
    return "upper_body"  # safe default


def _strip_data_url(b64: str) -> str:
    if b64.startswith("data:image"):
        return b64.split(",", 1)[1]
    return b64


def _b64_to_pil(b64: str) -> Image.Image:
    return Image.open(BytesIO(base64.b64decode(_strip_data_url(b64)))).convert("RGB")


def _pil_to_data_url(img: Image.Image) -> str:
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _write_temp_jpg(b64: str) -> str:
    data = base64.b64decode(_strip_data_url(b64))
    fd, path = tempfile.mkstemp(suffix=".jpg")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


# Segformer classes used to build the agnostic (inpaint) mask per category.
# Bottoms/dresses include the legs so wide-leg or flowy cuts have room to render
# beyond a skinny silhouette — the garment image then dictates loose-vs-tight
# *within* that region, which is what gives fit fidelity.
_VTON_MASK_CLASSES = {
    "upper_body": (4,),                 # upper-clothes
    "lower_body": (5, 6, 12, 13),       # skirt, pants, both legs
    "dresses": (4, 5, 6, 7, 12, 13),    # whole torso + legs
}


# Save what we send to the Space, for debugging bad results.
_DEBUG_DIR = os.path.join(os.path.dirname(__file__), "_debug_tryon")


# IDM-VTON auto-masks the TORSO only, so for skirts/pants/dresses we supply our
# own mask (is_checked=False) covering the garment area + legs.
_LOWER_MASK_CLASSES = {
    "lower_body": (5, 6, 12, 13),       # skirt, pants, both legs
    "dresses": (4, 5, 6, 7, 12, 13),    # torso + legs
}


def _save_temp_image(img: Image.Image, suffix: str = ".png") -> str:
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    img.save(path)
    return path


def _build_lower_mask(person_img: Image.Image, vton_category: str):
    """White-on-black mask of the lower body (garment area + legs), for IDM-VTON's
    is_checked=False path. Returns None if the region can't be found."""
    w, h = person_img.size
    inputs = processor(images=person_img, return_tensors="pt")
    with torch.no_grad():
        outputs = fashion_model(**inputs)
    seg_map = torch.nn.functional.interpolate(
        outputs.logits, size=(h, w), mode="bilinear", align_corners=False
    ).argmax(dim=1).squeeze().cpu().numpy()

    classes = _LOWER_MASK_CLASSES.get(vton_category, (5, 6, 12, 13))
    mask = np.zeros((h, w), dtype=np.uint8)
    for class_id in classes:
        mask[seg_map == class_id] = 255
    if int((mask > 0).sum()) < int(w * h * 0.02):
        return None

    mask = cv2.morphologyEx(
        mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)), iterations=2
    )
    mask = cv2.dilate(
        mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (max(int(w * 0.05), 5) * 2 + 1, 9)),
        iterations=1,
    )
    return Image.fromarray(mask).convert("RGB")


def _runpod_idmvton(person_b64: str, garment_b64: str, vton_category: str) -> str:
    """PRIMARY engine: our self-hosted IDM-VTON gradio app on RunPod (called via
    gradio_client). Auto-mask for tops; custom lower-body mask for bottoms/dresses
    (IDM-VTON auto-masks the torso only). Returns a data-URL."""
    if not _HAS_GRADIO:
        raise RuntimeError("gradio_client not installed")
    if not RUNPOD_GRADIO_URL:
        raise RuntimeError("RUNPOD_GRADIO_URL not configured")

    person_path = _write_temp_jpg(person_b64)
    garment_path = _write_temp_jpg(garment_b64)
    mask_path = None
    try:
        if vton_category == "upper_body":
            editor = {"background": handle_file(person_path), "layers": [], "composite": None}
            is_checked, is_checked_crop = True, True
        else:
            mask_img = _build_lower_mask(_b64_to_pil(person_b64), vton_category)
            if mask_img is not None:
                mask_path = _save_temp_image(mask_img, ".png")
                editor = {
                    "background": handle_file(person_path),
                    "layers": [handle_file(mask_path)],
                    "composite": None,
                }
                is_checked, is_checked_crop = False, False
                print(f"[tryon] RunPod IDM-VTON lower-body mask ({vton_category}).")
            else:
                editor = {"background": handle_file(person_path), "layers": [], "composite": None}
                is_checked, is_checked_crop = True, True

        client = Client(RUNPOD_GRADIO_URL, ssl_verify=VTON_SSL_VERIFY)
        result = client.predict(
            dict=editor,
            garm_img=handle_file(garment_path),
            garment_des="a fashion garment",
            is_checked=is_checked,
            is_checked_crop=is_checked_crop,
            denoise_steps=30,
            seed=42,
            api_name="/tryon",
        )
        output_path = result[0] if isinstance(result, (list, tuple)) else result
        try:
            os.makedirs(_DEBUG_DIR, exist_ok=True)
            Image.open(output_path).convert("RGB").save(os.path.join(_DEBUG_DIR, "result_out.jpg"))
        except Exception:
            pass
        with open(output_path, "rb") as f:
            return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()
    finally:
        for p in (person_path, garment_path, mask_path):
            if p:
                try:
                    os.remove(p)
                except OSError:
                    pass


def _gemini_tryon(person_b64: str, garments: list) -> str:
    """PRIMARY engine. Dress the person in ALL given garments in a single Gemini
    image-generation call. garments: [{"image": b64/data-URL, "category": str}, ...].
    Returns a data-URL. Raises if Gemini isn't configured or returns no image."""
    if not _HAS_GENAI or not GEMINI_API_KEY:
        raise RuntimeError("Gemini not configured (need google-genai + GEMINI_API_KEY)")

    client = _genai.Client(api_key=GEMINI_API_KEY)
    labels = ", ".join((g.get("category") or "garment") for g in garments) or "outfit"
    prompt = (
        "Virtual try-on task. The FIRST image is a PERSON. The remaining image(s) are "
        f"CLOTHING items ({labels}). Generate ONE photorealistic, full-body image of the "
        "SAME person wearing ALL of these clothing items together. Keep the person's face, "
        "hairstyle, body shape, skin tone, pose and the background EXACTLY the same — change "
        "only their clothing. Reproduce each garment's exact colour, print/pattern, neckline, "
        "sleeve and hem length, and fit as accurately as possible. Photorealistic, natural lighting."
    )
    contents = [prompt, _b64_to_pil(person_b64)]
    for g in garments:
        contents.append(_b64_to_pil(g["image"]))

    resp = client.models.generate_content(model=GEMINI_IMAGE_MODEL, contents=contents)
    for cand in (getattr(resp, "candidates", None) or []):
        content = getattr(cand, "content", None)
        for part in (getattr(content, "parts", None) or []):
            inline = getattr(part, "inline_data", None)
            if inline and getattr(inline, "data", None):
                raw = inline.data
                raw = base64.b64decode(raw) if isinstance(raw, str) else raw
                try:
                    os.makedirs(_DEBUG_DIR, exist_ok=True)
                    with open(os.path.join(_DEBUG_DIR, "result_out.jpg"), "wb") as f:
                        f.write(raw)
                except Exception:
                    pass
                return "data:image/png;base64," + base64.b64encode(raw).decode()
    raise RuntimeError("Gemini returned no image (blocked or text-only response)")


def _vton_via_space(person_b64: str, garment_b64: str, garment_des: str, vton_category: str) -> str:
    """Call the FASHN VTON v1.5 Space (maskless). Returns a data-URL.
    `garment_des` is unused by FASHN (no text prompt) but kept for signature
    stability with the chained / overlay callers."""
    if not _HAS_GRADIO:
        raise RuntimeError("gradio_client not installed")

    person_path = _write_temp_jpg(person_b64)
    garment_path = _write_temp_jpg(garment_b64)
    try:
        os.makedirs(_DEBUG_DIR, exist_ok=True)
        try:
            _b64_to_pil(person_b64).save(os.path.join(_DEBUG_DIR, "person_in.jpg"))
            _b64_to_pil(garment_b64).save(os.path.join(_DEBUG_DIR, "garment_raw.jpg"))
        except Exception:
            pass

        category = _FASHN_CATEGORY.get(vton_category, "tops")
        print(f"[tryon] FASHN VTON v1.5 -> category={category}")
        client = Client(VTON_SPACE, token=HF_TOKEN, ssl_verify=VTON_SSL_VERIFY)
        result = client.predict(
            person_image=handle_file(person_path),
            garment_image=handle_file(garment_path),
            category=category,
            garment_photo_type="model",   # Pinterest crops show the garment worn
            num_timesteps=50,
            guidance_scale=1.5,
            seed=42,
            segmentation_free=True,       # maskless
            api_name="/try_on",
        )
        # Image output: gradio_client returns a local filepath (str) or a
        # FileData dict with "path".
        if isinstance(result, dict):
            output_path = result.get("path") or result.get("url")
        elif isinstance(result, (list, tuple)):
            output_path = result[0]
        else:
            output_path = result
        try:
            Image.open(output_path).convert("RGB").save(os.path.join(_DEBUG_DIR, "result_out.jpg"))
        except Exception:
            pass
        with open(output_path, "rb") as f:
            return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()
    finally:
        for p in (person_path, garment_path):
            try:
                os.remove(p)
            except OSError:
                pass


def _vton_overlay(person_b64: str, garment_b64: str, vton_category: str) -> str:
    """CPU fallback: segment the person, then composite the garment into the
    matching body region. Sticker-like, but always available."""
    person = _b64_to_pil(person_b64)
    garment = _b64_to_pil(garment_b64)
    pw, ph = person.size

    inputs = processor(images=person, return_tensors="pt")
    with torch.no_grad():
        outputs = fashion_model(**inputs)
    upsampled = torch.nn.functional.interpolate(
        outputs.logits, size=(ph, pw), mode="bilinear", align_corners=False
    )
    seg_map = upsampled.argmax(dim=1).squeeze().cpu().numpy()

    target_classes = _VTON_MASK_CLASSES.get(vton_category, (4,))
    region = np.zeros((ph, pw), dtype=bool)
    for class_id in target_classes:
        region |= (seg_map == class_id)
    if not region.any():
        raise ValueError("Could not locate that body region in your photo.")

    ys, xs = np.where(region)
    x1, x2 = int(xs.min()), int(xs.max())
    y1, y2 = int(ys.min()), int(ys.max())
    bw, bh = max(x2 - x1, 1), max(y2 - y1, 1)

    garment_resized = np.array(garment.resize((bw, bh))).astype(np.float32)
    person_arr = np.array(person).astype(np.float32)

    mask = region[y1:y2, x1:x2].astype(np.float32)
    mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=3.0)
    mask = np.clip(mask, 0.0, 1.0)[..., None]

    roi = person_arr[y1:y2, x1:x2, :]
    person_arr[y1:y2, x1:x2, :] = garment_resized * mask + roi * (1.0 - mask)

    return _pil_to_data_url(Image.fromarray(person_arr.astype(np.uint8)))


class TryOnRequest(BaseModel):
    person_image: str       # the user's body photo (base64 / data-URL)
    garment_image: str      # the cropped garment from the pin (base64 / data-URL)
    category: str = ""      # e.g. "Top / Upper Wear", "Dress", "Pants"
    description: str = ""   # richer BLIP caption, used as the garment prompt


@app.post("/tryon")
async def try_on(request: TryOnRequest):
    vton_category = _normalize_category(request.category)
    garment_des = request.description or request.category or "a fashion garment"
    print(f"[tryon] category={request.category!r} -> {vton_category}; des={garment_des!r}")

    # 0a. Self-hosted IDM-VTON on RunPod (PRIMARY — our own GPU, no per-image cost).
    if RUNPOD_GRADIO_URL:
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(
                    _runpod_idmvton, request.person_image, request.garment_image, vton_category
                ),
                timeout=RUNPOD_TIMEOUT_S + 10,
            )
            print("[tryon] served by RunPod IDM-VTON.")
            return {"status": "success", "engine": "runpod-idm-vton", "result_image": result}
        except Exception as e:
            print(f"[tryon] RunPod unavailable ({type(e).__name__}: {e}); trying next engine.")

    # 0b. Gemini (Nano Banana) — best quality, one fast generative call.
    if GEMINI_API_KEY:
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(
                    _gemini_tryon, request.person_image,
                    [{"image": request.garment_image, "category": request.category or "garment"}],
                ),
                timeout=120,
            )
            print("[tryon] served by Gemini.")
            return {"status": "success", "engine": "gemini", "result_image": result}
        except Exception as e:
            print(f"[tryon] Gemini failed ({type(e).__name__}: {e}); trying Space.")

    # 1. Free GPU Space (FASHN) fallback.
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(
                _vton_via_space, request.person_image, request.garment_image,
                garment_des, vton_category,
            ),
            timeout=VTON_SPACE_TIMEOUT_S,
        )
        print("[tryon] served by live Space.")
        return {"status": "success", "engine": "fashn", "result_image": result}
    except Exception as e:
        print(f"[tryon] live Space unavailable ({type(e).__name__}: {e}); using overlay.")

    # 2. Segformer-guided CPU overlay fallback.
    try:
        result = await asyncio.to_thread(
            _vton_overlay, request.person_image, request.garment_image, vton_category
        )
        return {
            "status": "success",
            "engine": "overlay",
            "message": "Live try-on was busy — here's a quick preview.",
            "result_image": result,
        }
    except Exception as e:
        traceback.print_exc()
        return {"status": "error", "message": f"Try-on failed: {e}", "result_image": ""}


class TryOnLookRequest(BaseModel):
    person_image: str       # the user's body photo
    garments: list = []     # [{"image", "category", "description"}, ...]


# Apply upper body first, then dress, then lower — so passes don't fight over
# overlapping regions.
_LOOK_ORDER = {"upper_body": 0, "dresses": 1, "lower_body": 2}


@app.post("/tryon_look")
async def try_on_look(request: TryOnLookRequest):
    """Apply a whole outfit by CHAINING IDM-VTON passes: each garment is tried on
    the result of the previous pass. One pass per garment (~35-40s + GPU quota
    each)."""
    # Normalise + keep one garment per category, ordered top -> dress -> bottom.
    garments, seen = [], set()
    for g in sorted(request.garments, key=lambda x: _LOOK_ORDER.get(
            _normalize_category(x.get("category", "")), 3)):
        cat = _normalize_category(g.get("category", ""))
        if cat in seen or not g.get("image"):
            continue
        seen.add(cat)
        garments.append({
            "image": g["image"],
            "category": cat,
            "description": g.get("description") or g.get("category") or "a fashion garment",
        })

    if not garments:
        return {"status": "error", "message": "No try-on-able garments in this look.", "result_image": ""}

    print(f"[tryon_look] {len(garments)} garments: {[g['category'] for g in garments]}")

    # 0a. RunPod IDM-VTON (PRIMARY): chain one pass per garment on our own GPU.
    if RUNPOD_GRADIO_URL:
        try:
            current = request.person_image
            for g in garments:
                current = await asyncio.wait_for(
                    asyncio.to_thread(_runpod_idmvton, current, g["image"], g["category"]),
                    timeout=RUNPOD_TIMEOUT_S + 10,
                )
            print("[tryon_look] served by RunPod IDM-VTON (chained).")
            return {
                "status": "success", "engine": "runpod-idm-vton",
                "applied": [g["category"] for g in garments], "result_image": current,
            }
        except Exception as e:
            print(f"[tryon_look] RunPod unavailable ({type(e).__name__}: {e}); trying next engine.")

    # 0b. Gemini dresses the WHOLE outfit in ONE call (no slow chaining).
    if GEMINI_API_KEY:
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(
                    _gemini_tryon, request.person_image,
                    [{"image": g["image"], "category": g["category"]} for g in garments],
                ),
                timeout=150,
            )
            print("[tryon_look] served by Gemini (one-shot).")
            return {
                "status": "success", "engine": "gemini",
                "applied": [g["category"] for g in garments], "result_image": result,
            }
        except Exception as e:
            print(f"[tryon_look] Gemini failed ({type(e).__name__}: {e}); chaining Space.")

    # Fallback: chain one Space pass per garment.
    current = request.person_image
    applied = []
    for g in garments:
        try:
            current = await asyncio.wait_for(
                asyncio.to_thread(
                    _vton_via_space, current, g["image"], g["description"], g["category"]
                ),
                timeout=VTON_SPACE_TIMEOUT_S,
            )
            applied.append(g["category"])
            print(f"[tryon_look] applied {g['category']}")
        except Exception as e:
            print(f"[tryon_look] skipped {g['category']} ({type(e).__name__}: {e})")

    if not applied:
        return {
            "status": "error",
            "message": "Try-on was busy or out of GPU quota. Try again shortly.",
            "result_image": "",
        }
    return {
        "status": "success",
        "engine": "idm-vton",
        "applied": applied,
        "result_image": current,
    }


class AnalyzeRequest(BaseModel):
    base64_image: str


@app.post("/analyze")
async def analyze_outfit(request: AnalyzeRequest):
    print(f"Received request with base64 image of length: {len(request.base64_image)}")

    try:
        base64_data = request.base64_image
        if base64_data.startswith('data:image'):
            base64_data = base64_data.split(',')[1]

        image_bytes = base64.b64decode(base64_data)
        img = Image.open(BytesIO(image_bytes)).convert("RGB")
        width, height = img.size
        print(f"Image opened: {width}x{height}")

        print("Running fashion segmentation...")
        inputs = processor(images=img, return_tensors="pt")
        with torch.no_grad():
            outputs = fashion_model(**inputs)

        logits = outputs.logits  # (1, num_classes, h, w) at the model's internal resolution

        # Full-resolution seg_map for polygon extraction.
        upsampled = torch.nn.functional.interpolate(
            logits, size=(height, width), mode='bilinear', align_corners=False
        )
        seg_map = upsampled.argmax(dim=1).squeeze().cpu().numpy()

        # Low-res probs for cheap mean-softmax confidence (tall pins produce huge full-res tensors).
        low_res_probs = torch.nn.functional.softmax(logits, dim=1).squeeze(0).cpu().numpy()
        low_res_seg = logits.argmax(dim=1).squeeze().cpu().numpy()
        print("Segmentation complete.")

        items = []
        for class_id in SHOPPABLE_CLASSES:
            confidence = _class_confidence(low_res_probs, low_res_seg, class_id)
            if confidence == 0.0:
                continue
            class_mask = _build_class_mask(seg_map, class_id)
            items.extend(_extract_items(class_mask, class_id, width, height, confidence))

        print(f"Successfully extracted {len(items)} clothing items.")
        return {
            "status": "success",
            "message": f"Processed image. Found {len(items)} items.",
            "image_size": {"width": width, "height": height},
            "items": items,
        }

    except Exception as e:
        print(f"CRITICAL ERROR processing image: {e}")
        import traceback
        traceback.print_exc()
        return {
            "status": "error",
            "message": f"Backend Error: {str(e)}",
            "items": [],
        }

@app.post("/caption")
async def caption_image(request: AnalyzeRequest):
    print(f"Captioning image of length: {len(request.base64_image)}")
    try:
        base64_data = request.base64_image
        if base64_data.startswith('data:image'):
            base64_data = base64_data.split(',')[1]

        image_bytes = base64.b64decode(base64_data)
        img = Image.open(BytesIO(image_bytes)).convert("RGB")
        
        # BLIP text prefix to explicitly guide generation for clothes
        text = "a photograph of a "
        inputs = blip_processor(img, text, return_tensors="pt")
        
        with torch.no_grad():
            out = blip_model.generate(**inputs, max_new_tokens=20)
            
        caption_text = blip_processor.decode(out[0], skip_special_tokens=True)
        print(f"Generated Caption: {caption_text}")
        
        # Strip generic prefixes occasionally produced
        clean_caption = caption_text.replace("a photograph of a ", "").replace("a ", "").strip()
        
        return {
            "status": "success",
            "caption": clean_caption
        }
    except Exception as e:
        print(f"Caption Error: {e}")
        return {
            "status": "error",
            "caption": ""
        }

@app.get("/", response_class=HTMLResponse)
async def root():
    return """
    <!DOCTYPE html>
    <html>
        <head>
            <title>Qlothi API Server</title>
            <style>
                body { font-family: -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f8f9fa; color: #111; }
                .container { text-align: center; padding: 40px; background: white; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.05); }
                h1 { font-size: 2rem; margin-bottom: 0.5rem; letter-spacing: -0.5px; }
                p { color: #666; margin-bottom: 2rem; }
                footer { font-size: 14px; color: #888; font-weight: 500; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Qlothi Backend API</h1>
                <p>The AI segmentation engine is online and listening for extension requests.</p>
                <footer>Built by <strong>Komal</strong></footer>
            </div>
        </body>
    </html>
    """

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
