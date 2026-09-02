# Qlothi — Self-hosted IDM-VTON on RunPod

This is the **try-on GPU service** for Qlothi. It runs the official
[`yisol/IDM-VTON`](https://github.com/yisol/IDM-VTON) Gradio app on a RunPod GPU.
The Qlothi backend calls it with `gradio_client` (set `RUNPOD_GRADIO_URL`).

```
Extension → Qlothi backend (:8009) → RunPod GPU (IDM-VTON gradio) → result → back
```

Cost model: you pay only for **GPU time while the pod is running**. Start it for a
demo, stop it after. No per-image fees.

---

## 0. Prerequisites
- A RunPod account with ~$10 credit (https://runpod.io).
- GPU with **≥ 16 GB VRAM** (RTX 4090 24 GB or A40 48 GB are comfortable;
  IDM-VTON runs on 8 GB but tightly).

---

## 1. Easiest path — the SECourses 1-click installer (recommended)
There's a community 1-click RunPod installer that handles the whole messy setup
(detectron2/densepose, weights, the gradio bug fixes). It's the fastest reliable
route — see the tutorial linked from the
[IDM-VTON Space discussions](https://huggingface.co/spaces/yisol/IDM-VTON/discussions/7).
Follow it, then jump to **step 4** below to grab the URL.

If you'd rather do it by hand, use the manual path below.

---

## 2. Manual path — create the Pod
1. **+ Deploy** → pick a GPU (RTX 4090 / A40).
2. Template: **RunPod PyTorch 2.x** (CUDA 12.x).
3. **Container disk ≥ 30 GB**, **Volume ≥ 20 GB** (weights are ~7 GB).
4. **Expose HTTP port `7860`** (Edit Pod → Expose HTTP Ports → add `7860`).
5. Deploy, then open the **web terminal** (or SSH).

## 3. Manual path — install + run
In the pod terminal:
```bash
cd /workspace
# copy setup.sh here (or paste its contents), then:
bash setup.sh           # clones IDM-VTON, installs deps + detectron2 (~10-15 min)

cd /workspace/IDM-VTON
GRADIO_SERVER_NAME=0.0.0.0 python gradio_demo/app.py
```
First launch downloads the model weights (~7 GB) and is slow; subsequent launches
are fast. When you see `Running on local URL: http://0.0.0.0:7860`, it's up.

> ⚠️ Common snags: detectron2 can fail to compile if CUDA dev tools are missing
> (use the RunPod PyTorch *devel* image), and the gradio app sometimes needs
> `GRADIO_SERVER_NAME=0.0.0.0` to be reachable. The 1-click installer (step 1)
> avoids both.

## 4. Get the public URL
RunPod proxies the port at:
```
https://<YOUR_POD_ID>-7860.proxy.runpod.net
```
Open it in a browser — you should see the IDM-VTON gradio UI. Do one manual try-on
to confirm the GPU works.

## 5. Point Qlothi at it
In `backend/.runpod_url` (gitignored), put that URL on one line:
```
https://<YOUR_POD_ID>-7860.proxy.runpod.net
```
Then restart the Qlothi backend. It will call this instance as the **primary**
try-on engine (FASHN/overlay remain fallbacks for when the pod is off).

## 6. Stop billing
When you're done demoing: **Stop** the pod in RunPod (or terminate it). You are
billed only while it runs. Next demo: start it again, grab the (new) URL, update
`backend/.runpod_url`.

---

## Notes
- The pod URL **changes** each time you start a fresh pod. Use a **persistent pod**
  (stop, not terminate) to keep the same URL, or update `.runpod_url` each time.
- IDM-VTON auto-masks the **torso**, so the Qlothi backend supplies a lower-body
  mask for skirts/pants/dresses (handled server-side in `main.py`).
