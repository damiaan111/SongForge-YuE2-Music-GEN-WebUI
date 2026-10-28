<#
.SYNOPSIS
    Starts the SongForge backend and frontend, waits for health, and prints the
    addresses to open.

.DESCRIPTION
    Refuses to start a second copy. Writes logs to runtime\logs. Exits with a
    non-zero code and an explanatory message if anything fails to come up.

.PARAMETER Port
    Frontend port. Default 3333.

.PARAMETER BackendPort
    Backend port. Default 3334.

.PARAMETER TimeoutSeconds
    How long to wait for each service to become healthy. Default 120.

.EXAMPLE
    .\Start-SongForge.ps1
    .\Start-SongForge.ps1 -Port 8080 -Verbose
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 3333,
    [ValidateRange(1, 65535)][int]$BackendPort = 3334,
    [ValidateRange(5, 600)][int]$TimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root       = Split-Path -Parent $PSScriptRoot
$Backend    = Join-Path $Root 'app\backend'
$Frontend   = Join-Path $Root 'app\frontend'
$Runtime    = Join-Path $Root 'runtime'
$LogDir     = Join-Path $Runtime 'logs'
$PidFile    = Join-Path $Runtime 'songforge.pids.json'
$VenvPython = Join-Path $Runtime 'venv\Scripts\python.exe'
$OllamaExe  = Join-Path $Runtime 'ollama\ollama.exe'
$OllamaUrl  = 'http://127.0.0.1:11434'

function Write-Step { param([string]$Message) Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "  $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  $Message" -ForegroundColor Yellow }

# --- Keeping the window readable -------------------------------------------
# `exit` ends the host process, not just the script, so when this file is run
# by right-clicking it ("Run with PowerShell"), or from any shortcut that was
# made without -NoExit, the console closes the instant the script finishes and
# takes the printed addresses - or the error - with it. Exit-Script waits for a
# key first, but only in that case: an interactive console, started without
# -NoExit, with a keyboard still attached. Piped or scripted runs keep their
# exit codes and never block.
$script:ConsoleWillClose = $false
if ($Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected) {
    # -NoExit can be abbreviated to -noe and may use a / prefix.
    $keepsOpen = @([Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^[-/]noe' })
    $script:ConsoleWillClose = ($keepsOpen.Count -eq 0)
}

function Exit-Script {
    param([int]$Code = 0)
    if ($script:ConsoleWillClose) {
        Write-Host '  Press any key to close this window ...' -ForegroundColor DarkGray
        try { [Console]::ReadKey($true) | Out-Null } catch { Start-Sleep -Seconds 30 }
        Write-Host ''
    }
    exit $Code
}

function Write-Fail {
    # Write-Error is a terminating error while $ErrorActionPreference is Stop,
    # which skipped the cleanup and the "press any key" pause below it. These
    # failures are expected outcomes, so they are reported as plain output and
    # the script decides its own exit code.
    param([string]$Message)
    Write-Host ''
    foreach ($line in ($Message -split "`n")) { Write-Host "  $line" -ForegroundColor Red }
}

# A failure nobody anticipated must not close the window either.
trap {
    Write-Host ''
    Write-Host "  Unexpected error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  at $($_.InvocationInfo.ScriptName):$($_.InvocationInfo.ScriptLineNumber)" -ForegroundColor DarkGray
    Exit-Script 1
}


function Get-RunningProcess {
    <# Returns the process for a recorded PID, or $null if it is gone. #>
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return $null }
    try { return Get-Process -Id $ProcessId -ErrorAction Stop } catch { return $null }
}

function Test-Endpoint {
    param([string]$Uri, [int]$TimeoutSec = 3)
    try {
        $response = Invoke-WebRequest -Uri $Uri -TimeoutSec $TimeoutSec -UseBasicParsing
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Wait-ForEndpoint {
    param([string]$Uri, [int]$Seconds, [string]$Name, [System.Diagnostics.Process]$Process)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if ($Process -and $Process.HasExited) {
            throw "$Name exited early with code $($Process.ExitCode). Check the log in $LogDir."
        }
        if (Test-Endpoint -Uri $Uri) { return $true }
        Start-Sleep -Milliseconds 700
    }
    return $false
}

function Get-LanAddress {
    <# This machine's address on the local network, if it has one.

       The interface holding the default route is the one that actually reaches
       the rest of the house. Picking merely the first private address instead
       hands out a Hyper-V, WSL or Docker bridge address - 172.x.0.1 - which no
       other device can reach, and which looks plausible enough to waste a long
       time on. RFC 1918, and then anything, are fallbacks for a machine with no
       default route at all. #>
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -ne '127.0.0.1' -and
                       $_.PrefixOrigin -ne 'WellKnown' -and
                       $_.IPAddress -notlike '169.254.*' })
    if ($addresses.Count -eq 0) { return $null }

    $routed = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue |
        Where-Object { $null -ne $_.IPv4DefaultGateway } |
        ForEach-Object { $_.IPv4Address.IPAddress })
    $preferred = $addresses | Where-Object { $routed -contains $_.IPAddress } |
        Select-Object -First 1
    if ($preferred) { return $preferred.IPAddress }

    $private = $addresses | Where-Object {
        $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' -or
        $_.IPAddress -match '^172\.(1[6-9]|2[0-9]|3[01])\.'
    } | Select-Object -First 1
    if ($private) { return $private.IPAddress }

    return ($addresses | Select-Object -First 1).IPAddress
}

Write-Host ''
Write-Host 'SongForge' -ForegroundColor White
Write-Host '---------' -ForegroundColor DarkGray

# --- Refuse to start twice --------------------------------------------------
if (Test-Path $PidFile) {
    try {
        $recorded = Get-Content $PidFile -Raw | ConvertFrom-Json
        $live = @()
        foreach ($name in 'backend', 'frontend') {
            $proc = Get-RunningProcess -ProcessId ([int]$recorded.$name)
            if ($proc) { $live += "$name (pid $($proc.Id))" }
        }
        if ($live.Count -gt 0) {
            Write-Warn "SongForge is already running: $($live -join ', ')"
            Write-Warn "Stop it first with .\Stop-SongForge.ps1"
            Exit-Script 3
        }
        Write-Step 'Clearing a stale PID file from a previous run.'
        Remove-Item $PidFile -Force
    } catch {
        Write-Step 'PID file was unreadable; ignoring it.'
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
}

if (Test-Endpoint -Uri "http://127.0.0.1:$BackendPort/api/health" -TimeoutSec 2) {
    Write-Warn "Something is already serving the API on port $BackendPort."
    Write-Warn 'Stop it before starting SongForge.'
    Exit-Script 3
}

# --- Preconditions ----------------------------------------------------------
if (-not (Test-Path $VenvPython)) {
    Write-Fail "Python environment missing: $VenvPython`nCreate it with: py -3.12 -m venv `"$Runtime\venv`""
    Exit-Script 4
}
if (-not (Test-Path (Join-Path $Frontend 'package.json'))) {
    Write-Fail "Frontend not found at $Frontend."
    Exit-Script 4
}
if (-not (Test-Path (Join-Path $Frontend 'node_modules'))) {
    Write-Fail "Frontend dependencies are not installed.`nRun: cd `"$Frontend`"; npm install"
    Exit-Script 4
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# --- Prune old run logs -----------------------------------------------------
# Every start writes five files here and nothing ever removed them, so the
# folder grew without limit. Only this script's own stamped run logs are
# touched: a version's generation.log lives with the version and is an
# artifact, not a run log.
$keepRuns = 10
# @() around every pipeline result: Set-StrictMode -Version Latest refuses
# .Count on the bare string a single-item pipeline returns, which made the
# script fail outright on the one start where exactly one run had to go.
$runStamps = @(Get-ChildItem -LiteralPath $LogDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(backend|frontend|ollama)-(\d{8}-\d{6})\.' } |
    ForEach-Object { $Matches[2] } |
    Sort-Object -Unique -Descending)
if ($runStamps.Count -gt $keepRuns) {
    $stale = @($runStamps | Select-Object -Skip $keepRuns)
    foreach ($old in $stale) {
        Get-ChildItem -LiteralPath $LogDir -File -Filter "*-$old.*" -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
    Write-Step "Removed logs from $($stale.Count) older run(s); keeping the last $keepRuns."
}

$stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'
$backendLog  = Join-Path $LogDir "backend-$stamp.log"
$backendErr  = Join-Path $LogDir "backend-$stamp.err.log"
$frontendLog = Join-Path $LogDir "frontend-$stamp.log"
$frontendErr = Join-Path $LogDir "frontend-$stamp.err.log"
$ollamaLog   = Join-Path $LogDir "ollama-$stamp.log"

# --- Local lyrics model (optional) -----------------------------------------
# Ollama is only started when the portable copy is present. It listens on
# localhost only, keeps its models on D:, and has its cloud features disabled:
# the lyrics writer is local by design. A failure here never blocks SongForge;
# the lyrics panel just reports the model as unavailable.
$ollamaProc = $null
$ollamaNote = 'not installed'
if (Test-Path $OllamaExe) {
    if (Test-Endpoint -Uri "$OllamaUrl/api/version" -TimeoutSec 2) {
        $ollamaNote = 'already running (not started by SongForge)'
        Write-Warn "An Ollama server is already running on $OllamaUrl; using it."
    } else {
        Write-Step 'Starting the local lyrics model server (Ollama) ...'
        $env:OLLAMA_HOST = '127.0.0.1:11434'
        $env:OLLAMA_MODELS = Join-Path $Runtime 'models\ollama'
        $env:OLLAMA_MAX_LOADED_MODELS = '1'
        $env:OLLAMA_NUM_PARALLEL = '1'
        $env:OLLAMA_NO_CLOUD = '1'
        $ollamaProc = Start-Process -FilePath $OllamaExe -ArgumentList @('serve') `
            -WorkingDirectory (Split-Path $OllamaExe) -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput "$ollamaLog.out" -RedirectStandardError $ollamaLog
        # Wait-ForEndpoint throws if the process exits early; that must not
        # abort SongForge's own startup.
        $ollamaReady = $false
        try {
            $ollamaReady = Wait-ForEndpoint -Uri "$OllamaUrl/api/version" -Seconds 30 -Name 'Ollama' -Process $ollamaProc
        } catch {
            $ollamaReady = $false
        }
        if ($ollamaReady) {
            $ollamaNote = 'running on localhost'
            Write-Ok "Lyrics model server ready (pid $($ollamaProc.Id))."
        } else {
            $ollamaNote = 'failed to start - see ' + $ollamaLog
            Write-Warn "Ollama did not start; lyrics writing will be unavailable. Log: $ollamaLog"
            if (-not $ollamaProc.HasExited) { Stop-Process -Id $ollamaProc.Id -Force -ErrorAction SilentlyContinue }
            $ollamaProc = $null
        }
    }
}

# --- Backend ----------------------------------------------------------------
Write-Step "Starting backend on 127.0.0.1:$BackendPort ..."
$backendProc = Start-Process -FilePath $VenvPython `
    -ArgumentList @('-m', 'uvicorn', 'songforge.main:app',
                    '--host', '127.0.0.1', '--port', "$BackendPort") `
    -WorkingDirectory $Backend -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $backendLog -RedirectStandardError $backendErr

try {
    if (-not (Wait-ForEndpoint -Uri "http://127.0.0.1:$BackendPort/api/health" `
                               -Seconds $TimeoutSeconds -Name 'Backend' -Process $backendProc)) {
        throw "Backend did not become healthy within $TimeoutSeconds seconds."
    }
} catch {
    Write-Host ''
    Write-Fail $_.Exception.Message
    Write-Warn "Backend log:  $backendLog"
    Write-Warn "Backend errors: $backendErr"
    if (Get-Content $backendErr -ErrorAction SilentlyContinue) {
        Write-Host '--- last lines of stderr ---' -ForegroundColor DarkGray
        Get-Content $backendErr -Tail 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    }
    if (-not $backendProc.HasExited) { Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue }
    Exit-Script 5
}
Write-Ok "Backend healthy (pid $($backendProc.Id))."

# --- Frontend ---------------------------------------------------------------
Write-Step "Starting frontend on 0.0.0.0:$Port ..."
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
if (-not $npm) { $npm = (Get-Command npm -ErrorAction SilentlyContinue) }
if (-not $npm) {
    Write-Fail 'npm was not found on PATH. Install Node.js LTS.'
    Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue
    Exit-Script 4
}

$env:SONGFORGE_API_URL = "http://127.0.0.1:$BackendPort"
$frontendProc = Start-Process -FilePath $npm.Source `
    -ArgumentList @('run', 'start', '--', '--hostname', '0.0.0.0', '--port', "$Port") `
    -WorkingDirectory $Frontend -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $frontendLog -RedirectStandardError $frontendErr

try {
    if (-not (Wait-ForEndpoint -Uri "http://127.0.0.1:$Port" `
                               -Seconds $TimeoutSeconds -Name 'Frontend' -Process $frontendProc)) {
        throw "Frontend did not respond within $TimeoutSeconds seconds."
    }
} catch {
    Write-Host ''
    Write-Fail $_.Exception.Message
    Write-Warn "Frontend log: $frontendLog"
    Write-Warn "Frontend errors: $frontendErr"
    Write-Warn 'If the app has not been built yet, run: npm run build'
    if (-not $frontendProc.HasExited) { Stop-Process -Id $frontendProc.Id -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue
    Exit-Script 5
}
Write-Ok "Frontend ready (pid $($frontendProc.Id))."

# --- Record and report ------------------------------------------------------
@{
    backend  = $backendProc.Id
    frontend = $frontendProc.Id
    ollama   = $(if ($ollamaProc) { $ollamaProc.Id } else { 0 })
    port     = $Port
    started  = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -Path $PidFile -Encoding utf8

$lan = Get-LanAddress
Write-Host ''
Write-Host 'SongForge is running.' -ForegroundColor Green
Write-Host "  On this PC:    http://localhost:$Port" -ForegroundColor White
if ($lan) {
    Write-Host "  On your LAN:   http://${lan}:$Port" -ForegroundColor White
    Write-Host "                 (open this one on another device)" -ForegroundColor DarkGray
} else {
    Write-Warn 'No LAN address detected; only localhost is available.'
}
Write-Host "  API docs:      http://localhost:$BackendPort/api/docs" -ForegroundColor DarkGray
Write-Host "  Logs:          $LogDir" -ForegroundColor DarkGray
Write-Host "  Lyrics model:  $ollamaNote" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Stop with: .\scripts\Stop-SongForge.ps1' -ForegroundColor DarkGray
Write-Host ''
Exit-Script 0
