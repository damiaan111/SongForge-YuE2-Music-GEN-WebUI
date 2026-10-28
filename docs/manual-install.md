# Installing by hand

`setup.ps1` / `setup.sh` does all of this for you, choosing the PyTorch
build that matches your GPU and fetching the weights from Hugging Face.
These steps are kept for people who want to see exactly what that does, or
who need to deviate from it.

They assume Windows and an NVIDIA card. On other hardware the only line
that changes is the PyTorch index URL; run
`python app/backend/songforge/setup/__main__.py --detect` to see which one
applies to your machine.

## The steps

Run these from the project root in PowerShell.

**1. Backend environment**

```powershell
py -3.12 -m venv runtime\venv
runtime\venv\Scripts\python.exe -m pip install --upgrade pip
runtime\venv\Scripts\python.exe -m pip install -e "app\backend[test]"
```

**2. Inference environment**

Kept separate on purpose: PyTorch and the model package have heavy, version-
pinned dependencies that must not constrain the web application.

```powershell
py -3.12 -m venv runtime\venv-yue2
runtime\venv-yue2\Scripts\python.exe -m pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cu128
runtime\venv-yue2\Scripts\python.exe -m pip install runtime\yue2_infer-0.1.5-py3-none-any.whl
```

**3. Model weights** (~20 GB, once)

```powershell
runtime\venv-yue2\Scripts\python.exe -m pip install "huggingface_hub[cli]"
runtime\venv-yue2\Scripts\hf.exe download m-a-p/YuE2-3B  --local-dir runtime\models\YuE2-3B
runtime\venv-yue2\Scripts\hf.exe download m-a-p/YuE2-Vae --local-dir runtime\models\YuE2-Vae
```

**4. Frontend**

```powershell
cd app\frontend
npm ci
npm run build
cd ..\..
```

**5. Configuration**

```powershell
Copy-Item .env.example .env
```

Edit `.env` only if you want a different runtime folder or ports. The defaults
are correct for this layout.

If you change the backend port, also change `SONGFORGE_API_URL` in
`app\frontend\.env.local` and **rebuild the frontend** (`npm run build`). The
address the frontend proxies `/api` to is fixed at build time, so setting it
when starting the server has no effect.

**6. Verify the model before starting the app**

```powershell
.\scripts\Test-YuE2Runner.ps1
```

This runs `yue2 doctor --verify-hashes`: it checks dependencies, the CUDA
device, and every weight file's checksum. It loads nothing onto the GPU. Add
`-Generate` to also render one short song end to end — that takes a few minutes
and does use the GPU.
