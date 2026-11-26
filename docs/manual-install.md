# Installing by hand

`setup.bat` / `./setup.sh` does all of this for you: it chooses the PyTorch
build that matches your graphics card, downloads the exact model files
SongForge was tested with, and checks them. Use it unless you have a reason not
to.

These steps are kept for people who want to see exactly what setup does, or who
need to deviate from it. They are written for Windows and an NVIDIA card. On
other hardware the line that changes is the PyTorch index URL; run

```
python app/backend/songforge/setup/__main__.py --detect
```

to see which one applies to your machine.

Run everything from the project root in PowerShell.

## 1. Backend environment

```powershell
py -3.12 -m venv runtime\venv
runtime\venv\Scripts\python.exe -m pip install -c app\backend\constraints.txt -e app\backend
```

`constraints.txt` holds the exact versions the app was tested with. Leaving it
out installs whatever is newest today, which is how an install that worked last
month stops working this month.

## 2. Inference environment

Kept separate on purpose: PyTorch and the model package have heavy,
exactly-pinned dependencies that must not constrain the web application.

```powershell
py -3.12 -m venv runtime\venv-yue2
runtime\venv-yue2\Scripts\python.exe -m pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cu128
runtime\venv-yue2\Scripts\python.exe -m pip install huggingface-hub==0.36.2
```

The CUDA build of PyTorch is a 2.9 GB download. If the connection drops part
way through, pip starts again from nothing. Setup avoids that by fetching the
wheel to `runtime\downloads` first and resuming where it stopped. By hand,
`curl` does the same job - run the first line again as often as you need:

```powershell
curl.exe -L -C - --retry 10 --retry-all-errors -o "runtime\downloads\torch-2.10.0+cu128-cp312-cp312-win_amd64.whl" "https://download.pytorch.org/whl/cu128/torch-2.10.0%2Bcu128-cp312-cp312-win_amd64.whl"
runtime\venv-yue2\Scripts\python.exe -m pip install "runtime\downloads\torch-2.10.0+cu128-cp312-cp312-win_amd64.whl" --index-url https://download.pytorch.org/whl/cu128
```

## 3. The YuE2 inference package

It is not on PyPI; the model repository carries it as a file. Download the
revision SongForge pins, **check its checksum**, and only then install it:

```powershell
runtime\venv-yue2\Scripts\hf.exe download m-a-p/YuE2-3B yue2_infer-0.1.5-py3-none-any.whl --revision 8f24312f187763b9854adeec87e437e2b03bbff1 --local-dir runtime
(Get-FileHash runtime\yue2_infer-0.1.5-py3-none-any.whl -Algorithm SHA256).Hash
```

The hash must read
`8801E2C0D969DB02DF78D2994150B4CCD86077D87C24FDB8509B1F6F31462641`. If it does
not, stop: delete the file and do not install it.

```powershell
runtime\venv-yue2\Scripts\python.exe -m pip install --no-deps runtime\yue2_infer-0.1.5-py3-none-any.whl
runtime\venv-yue2\Scripts\python.exe -m pip install transformers==4.57.6 safetensors==0.7.0 tiktoken==0.12.0 numpy==2.2.6 soundfile==0.13.1 accelerate==1.13.0
```

The revision and the checksum above are the ones in
`app/backend/songforge/setup/components.py`; that file is the source of truth
if the two ever disagree.

## 4. Model weights (about 7.3 GB, once)

```powershell
runtime\venv-yue2\Scripts\hf.exe download m-a-p/YuE2-3B  --revision 8f24312f187763b9854adeec87e437e2b03bbff1 --local-dir runtime\models\YuE2-3B --include "*.json" "*.safetensors" "*.py" "*.tiktoken" "*.txt" "*.md"
runtime\venv-yue2\Scripts\hf.exe download m-a-p/YuE2-Vae --revision 152733a19ad43aa67e367f9b5503ef8075bb5126 --local-dir runtime\models\YuE2-Vae --include "*.json" "*.safetensors" "*.py" "*.tiktoken" "*.txt" "*.md"
```

The weights are **CC BY-NC 4.0 - non-commercial**. See [NOTICE.md](../NOTICE.md).

## 5. Web app

```powershell
$env:NEXT_TELEMETRY_DISABLED = "1"
cd app\frontend
npm ci
npm run build
cd ..\..
```

The first line keeps the build tool from sending its anonymous usage report;
setup and the start scripts set it for you.

## 6. Configuration (optional)

Nothing needs configuring for the default layout. To use a different runtime
folder or different ports, copy `.env.example` to `.env` and edit it.

If the engine port (3334) is taken, start SongForge with `start.bat -BackendPort
3344` (`BACKEND_PORT=3344 ./start.sh`); the web app is rebuilt for that port once.

## 7. Verify the model before starting the app

```powershell
.\scripts\Test-YuE2Runner.ps1
```

This runs `yue2 doctor --verify-hashes`: it checks dependencies, the CUDA
device, and the checksum of every weight file. It loads nothing onto the GPU.
Add `-Generate` to also render one short song end to end - that takes a few
minutes and does use the GPU.

Then start it as usual: `start.bat`.
