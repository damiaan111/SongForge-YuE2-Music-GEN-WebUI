<#
.SYNOPSIS
    Safely tests the YuE2 runner configuration without generating audio.

.DESCRIPTION
    Runs `yue2 doctor`, which reports dependency versions, CUDA devices and
    weight checksums. It loads no model onto the GPU and produces no output
    files, so it is safe to run at any time.

    With -Generate it additionally performs one short real generation and
    reports elapsed time and peak VRAM. That does use the GPU and takes several
    minutes.

.PARAMETER Model
    Path to the YuE2 model directory. Defaults to runtime\models\YuE2-3B.

.PARAMETER Vae
    Path to the VAE directory. Defaults to runtime\models\YuE2-Vae.

.PARAMETER Generate
    Also run one short end-to-end generation.

.EXAMPLE
    .\Test-YuE2Runner.ps1
    .\Test-YuE2Runner.ps1 -Generate
#>
[CmdletBinding()]
param(
    [string]$Model,
    [string]$Vae,
    # YuE2 caps itself at budget - 2 GiB; the card's size is the right value.
    [ValidateRange(1, 128)][double]$Budget = 12,
    [ValidateSet('torch', 'torch-eager', 'vllm')][string]$Backend = 'torch-eager',
    [switch]$Generate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root    = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $Root 'runtime'
$Yue2    = Join-Path $Runtime 'venv-yue2\Scripts\yue2.exe'

if (-not $Model) { $Model = Join-Path $Runtime 'models\YuE2-3B' }
if (-not $Vae)   { $Vae   = Join-Path $Runtime 'models\YuE2-Vae' }

function Write-Step { param([string]$m) Write-Host "  $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "  $m" -ForegroundColor Green }
function Write-Bad  { param([string]$m) Write-Host "  $m" -ForegroundColor Red }
function Write-Warn { param([string]$m) Write-Host "  $m" -ForegroundColor Yellow }

Write-Host ''
Write-Host 'YuE2 runner diagnostics' -ForegroundColor White
Write-Host '-----------------------' -ForegroundColor DarkGray

# --- Preconditions ----------------------------------------------------------
$failed = $false
if (-not (Test-Path $Yue2)) {
    Write-Bad "yue2 executable not found: $Yue2"
    Write-Warn 'Create the inference environment and install the wheel:'
    Write-Warn "  py -3.12 -m venv `"$Runtime\venv-yue2`""
    Write-Warn "  `"$Runtime\venv-yue2\Scripts\python.exe`" -m pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cu128"
    Write-Warn "  `"$Runtime\venv-yue2\Scripts\python.exe`" -m pip install `"$Runtime\yue2_infer-0.1.5-py3-none-any.whl`""
    exit 4
}
Write-Ok "Executable: $Yue2"

foreach ($pair in @(@{ Name = 'Model'; Path = $Model }, @{ Name = 'VAE'; Path = $Vae })) {
    if (Test-Path $pair.Path) {
        Write-Ok "$($pair.Name): $($pair.Path)"
    } else {
        Write-Bad "$($pair.Name) not found: $($pair.Path)"
        $failed = $true
    }
}
if ($failed) {
    Write-Warn 'Download the weights with:'
    Write-Warn "  hf download m-a-p/YuE2-3B --local-dir `"$Runtime\models\YuE2-3B`""
    Write-Warn "  hf download m-a-p/YuE2-Vae --local-dir `"$Runtime\models\YuE2-Vae`""
    exit 4
}

# --- doctor -----------------------------------------------------------------
Write-Host ''
Write-Step 'Running: yue2 doctor --verify-hashes (loads nothing onto the GPU)'
$doctorArgs = @('doctor', "--model=$Model", "--vae=$Vae", '--offline', '--verify-hashes')
$report = & $Yue2 @doctorArgs
$doctorExit = $LASTEXITCODE

if ($doctorExit -ne 0) {
    Write-Bad "doctor exited with code $doctorExit"
    $report | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    exit 5
}

try {
    $json = ($report -join "`n") | ConvertFrom-Json
} catch {
    Write-Bad 'Could not parse the doctor report as JSON.'
    $report | Select-Object -Last 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    exit 5
}

Write-Host ''
if ($json.dependencies_ready) {
    Write-Ok 'Python dependencies: ready'
} else {
    Write-Bad 'Python dependencies: INCOMPLETE'
    $failed = $true
}
foreach ($name in $json.versions.PSObject.Properties.Name) {
    $value = $json.versions.$name
    if ($value) { Write-Host "      $name $value" -ForegroundColor DarkGray }
    else        { Write-Bad  "      $name MISSING" }
}

Write-Host ''
if ($json.cuda -and $json.cuda.Count -gt 0) {
    foreach ($device in $json.cuda) {
        $cc = "$($device.compute_capability[0]).$($device.compute_capability[1])"
        Write-Ok ("GPU {0}: {1} - {2:N2} GiB, compute {3}" -f $device.id, $device.name, $device.memory_gib, $cc)
        if ($Budget -gt $device.memory_gib) {
            Write-Warn ("  Budget {0} GiB exceeds this GPU's {1:N2} GiB." -f $Budget, $device.memory_gib)
        }
        if ($device.compute_capability[0] -lt 8 -or
           ($device.compute_capability[0] -eq 8 -and $device.compute_capability[1] -lt 9)) {
            Write-Host '      fp8 quantization is unavailable below compute 8.9; use --quantization none.' -ForegroundColor DarkGray
        }
    }
} else {
    Write-Bad 'No CUDA device was reported by torch.'
    $failed = $true
}

if ($json.PSObject.Properties.Name -contains 'weights') {
    Write-Host ''
    Write-Ok 'Weight checksums read successfully:'
    foreach ($key in 'model', 'vae') {
        $entry = $json.weights.$key
        foreach ($file in $entry.files.PSObject.Properties.Name) {
            $sha = $entry.files.$file.sha256
            Write-Host "      $key/$file  $($sha.Substring(0,16))..." -ForegroundColor DarkGray
        }
    }
}

Write-Host ''
Write-Host '  Note: this checks environment readiness only. It is not a' -ForegroundColor DarkGray
Write-Host '  guarantee of output quality or of sufficient VRAM for long songs.' -ForegroundColor DarkGray

if ($failed) {
    Write-Host ''
    Write-Bad 'Diagnostics found problems. Fix them before generating.'
    exit 5
}

Write-Host ''
Write-Ok 'Runner configuration looks good.'

# --- optional real generation ----------------------------------------------
if (-not $Generate) {
    Write-Host ''
    Write-Host '  Run with -Generate to perform one short real generation.' -ForegroundColor DarkGray
    Write-Host ''
    exit 0
}

Write-Host ''
Write-Step 'Running one short generation. This uses the GPU and takes a few minutes.'

$outDir = Join-Path $Runtime "logs\runner-test-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$lyricsFile = Join-Path $outDir 'lyrics.txt'
@'
[Verse]
A short test of the signal chain
[Chorus]
Everything is working fine
'@ | Set-Content -Path $lyricsFile -Encoding utf8

$peak = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()

$genArgs = @(
    'generate', "--model=$Model", "--vae=$Vae", '--device=cuda:0',
    "--budget=$Budget", "--backend=$Backend", '--quantization=none',
    '--offload-ar', '--offline', "--output=$outDir", '--id=selftest',
    '--style=Clean acoustic guitar, soft male vocal, simple test recording',
    "--lyrics-file=$lyricsFile", '--cot=full', '--seed=1234'
)

$proc = Start-Process -FilePath $Yue2 -ArgumentList $genArgs -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $outDir 'stdout.log') `
    -RedirectStandardError  (Join-Path $outDir 'stderr.log')

while (-not $proc.HasExited) {
    try {
        $used = (& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) | Select-Object -First 1
        if ([int]$used -gt $peak) { $peak = [int]$used }
    } catch { }
    Start-Sleep -Seconds 2
}
$sw.Stop()

Write-Host ''
if ($proc.ExitCode -eq 0) {
    $audio = Join-Path $outDir 'selftest\audio.flac'
    Write-Ok ("Generation succeeded in {0:N0} seconds." -f $sw.Elapsed.TotalSeconds)
    Write-Ok ("Peak VRAM: {0} MiB" -f $peak)
    if (Test-Path $audio) {
        Write-Ok "Audio: $audio"
    } else {
        Write-Warn 'Exited cleanly but no audio.flac was produced.'
        exit 5
    }
    Write-Host ''
    exit 0
}

Write-Bad "Generation failed with exit code $($proc.ExitCode)."
Write-Warn ("Peak VRAM before failure: {0} MiB" -f $peak)
$failureJson = Join-Path $outDir 'selftest\failure.json'
if (Test-Path $failureJson) {
    Write-Host '--- failure.json ---' -ForegroundColor DarkGray
    Get-Content $failureJson | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}
Write-Warn "Full log: $(Join-Path $outDir 'stderr.log')"
Write-Host ''
Write-Host '  Common causes:' -ForegroundColor DarkGray
Write-Host '   - "paging file is too small": increase the Windows page file.' -ForegroundColor DarkGray
Write-Host '   - "USE_FLASH_ATTENTION was not enabled": use -Backend torch-eager.' -ForegroundColor DarkGray
Write-Host '   - CUDA out of memory: lower -Budget or shorten the lyrics.' -ForegroundColor DarkGray
Write-Host ''
exit 5
