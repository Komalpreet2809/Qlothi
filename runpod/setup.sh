#!/usr/bin/env bash
# Qlothi — IDM-VTON setup for a RunPod PyTorch pod.
# Run once in /workspace:  bash setup.sh
# Then launch:  cd /workspace/IDM-VTON && GRADIO_SERVER_NAME=0.0.0.0 python gradio_demo/app.py
set -euo pipefail

cd /workspace

echo "==> Cloning IDM-VTON"
[ -d IDM-VTON ] || git clone https://github.com/yisol/IDM-VTON.git
cd IDM-VTON

echo "==> Installing Python deps"
pip install --upgrade pip
pip install -r requirements.txt

echo "==> Installing detectron2 (DensePose dependency)"
# Needs CUDA dev toolchain (use a RunPod PyTorch *devel* image if this fails).
pip install "git+https://github.com/facebookresearch/detectron2.git"

echo "==> Sanity: import torch + CUDA"
python - <<'PY'
import torch
print("torch", torch.__version__, "cuda", torch.cuda.is_available())
PY

echo
echo "==> Done. Model weights (~7 GB) download from Hugging Face on first launch."
echo "    Start the app with:"
echo "      cd /workspace/IDM-VTON && GRADIO_SERVER_NAME=0.0.0.0 python gradio_demo/app.py"
echo "    Then open: https://<POD_ID>-7860.proxy.runpod.net"
