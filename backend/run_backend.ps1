# IMPORTANT: set NEITHER HF_HUB_OFFLINE NOR TRANSFORMERS_OFFLINE. Both flip
# huggingface_hub into offline mode, which makes gradio_client unable to reach
# the IDM-VTON try-on Space (it then silently falls back to the CPU overlay).
# Segformer/BLIP still load from the local HF cache in online mode (needs net).

$python = "C:\Users\LENOVO\AppData\Local\Programs\Python\Python313\python.exe"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# Free Hugging Face token for the try-on Space's per-account GPU quota.
# Put your token (no PRO needed) on a single line in backend/.hf_token — it's
# gitignored. Without it we fall back to the shared anonymous quota.
$tokenFile = Join-Path $root ".hf_token"
if (Test-Path $tokenFile) {
    $env:HF_TOKEN = (Get-Content $tokenFile -Raw).Trim()
    Write-Host "Loaded HF_TOKEN from .hf_token"
}

# Free Gemini API key (PRIMARY try-on engine). Get one at https://aistudio.google.com
# and put it on a single line in backend/.gemini_key (gitignored). Without it,
# try-on falls back to the FASHN Space.
$geminiFile = Join-Path $root ".gemini_key"
if (Test-Path $geminiFile) {
    $env:GEMINI_API_KEY = (Get-Content $geminiFile -Raw).Trim()
    Write-Host "Loaded GEMINI_API_KEY from .gemini_key"
}

# Self-hosted IDM-VTON on RunPod (PRIMARY engine). Put the pod's public gradio URL
# (e.g. https://<pod-id>-7860.proxy.runpod.net) on one line in backend/.runpod_url.
$runpodFile = Join-Path $root ".runpod_url"
if (Test-Path $runpodFile) {
    $env:RUNPOD_GRADIO_URL = (Get-Content $runpodFile -Raw).Trim()
    Write-Host "Loaded RUNPOD_GRADIO_URL from .runpod_url"
}

# Qlothi runs on 8009 (NOT 8000) — the Conflux/Gridlockr2 API squats on 8000
# with --reload and keeps reclaiming it. The extension points at :8009 locally.
& $python -m uvicorn main:app --host 127.0.0.1 --port 8009 *> backend-runtime.log
