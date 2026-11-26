<#
.SYNOPSIS
    Starts SongForge and keeps this window open while it runs.

.DESCRIPTION
    Starts the backend and the web app, waits until both answer, prints the
    address to open, and then stays in the foreground. This window IS the app:
    press Ctrl+C or close it and SongForge stops. Nothing is left running in
    the background.

    Refuses to start a second copy. Writes logs to runtime\logs. Exits with a
    non-zero code and an explanatory message if anything fails to come up.

.PARAMETER Port
    Port of the web app. Default 3333.

.PARAMETER BackendPort
    Port of the API, on this computer only. Default 3334.

.PARAMETER TimeoutSeconds
    How long to wait for each service to become healthy. Default 120.

.PARAMETER Lan
    Also listen on the local network, so a phone or another computer in the
    house can open the app. Off by default: SongForge has no accounts, so
    anyone who can reach the port can use it.

.PARAMETER NoBrowser
    Do not open the browser once SongForge is up.

.EXAMPLE
    .\Start-SongForge.ps1
    .\Start-SongForge.ps1 -Lan
    .\Start-SongForge.ps1 -Port 8080 -NoBrowser
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 3333,
    [ValidateRange(1, 65535)][int]$BackendPort = 3334,
    [ValidateRange(5, 600)][int]$TimeoutSeconds = 120,
    [switch]$Lan,
    [switch]$NoBrowser
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
$OllamaUrl  = 'http://127.0.0.1:11434'

function Write-Step { param([string]$Message) Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "  $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  $Message" -ForegroundColor Yellow }
function Write-Dim  { param([string]$Message) Write-Host "  $Message" -ForegroundColor DarkGray }

# --- Keeping the window readable -------------------------------------------
# `exit` ends the host process, not just the script, so when this file is run
# by double-clicking start.bat, or from any shortcut that was made without
# -NoExit, the console closes the instant the script finishes and takes the
# error with it. Exit-Script waits for a key first, but only in that case: an
# interactive console, started without -NoExit, with a keyboard still
# attached. Piped or scripted runs keep their exit codes and never block.
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

function Get-RunningProcess {
    <# Returns the process for a recorded PID, or $null if it is gone - or if
       the number now belongs to some other program. After a crash and a reboot
       a stale PID file can name anything, and "SongForge is already running"
       because a browser happens to hold that number helps nobody. #>
    param([int]$ProcessId, [string]$Expect = '')
    if ($ProcessId -le 0) { return $null }
    try { $found = Get-Process -Id $ProcessId -ErrorAction Stop } catch { return $null }
    if ($Expect -and $found.ProcessName -notmatch $Expect) { return $null }
    return $found
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

# --- Tying the children to this window --------------------------------------
# Ctrl+C runs the `finally` block at the bottom and everything is stopped
# politely. Clicking the window's X does not: Windows kills this process
# outright and nothing of ours gets to run. A job object covers that case -
# every process placed in it is ended by Windows itself the moment this
# process goes away, including the yue2 render the backend may have started.
$script:JobReady = $false
try {
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SongForgeJob
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    static IntPtr handle = IntPtr.Zero;

    public static bool Create()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) return false;
        ExtendedLimits info = new ExtendedLimits();
        info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int length = Marshal.SizeOf(typeof(ExtendedLimits));
        IntPtr pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, pointer, false);
            return SetInformationJobObject(handle, 9, pointer, (uint)length);
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    public static bool Add(IntPtr process)
    {
        return handle != IntPtr.Zero && AssignProcessToJobObject(handle, process);
    }
}
'@
    $script:JobReady = [SongForgeJob]::Create()
} catch {
    # Without it Ctrl+C still stops everything; only closing the window with
    # the X would leave the services behind, and Stop-SongForge.ps1 clears those.
    $script:JobReady = $false
}

function Add-ToJob {
    param([System.Diagnostics.Process]$Process)
    if (-not $script:JobReady -or -not $Process) { return }
    try { [SongForgeJob]::Add($Process.Handle) | Out-Null } catch { }
}

function Stop-Tree {
    <# Ends a process and everything it started. taskkill /T walks the tree,
       which matters for the backend while it is running a render. #>
    param([System.Diagnostics.Process]$Process)
    if (-not $Process) { return }
    try {
        if (-not $Process.HasExited) {
            & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
        }
    } catch { }
}

$script:Children = @()
$script:Started = $false

function Stop-Everything {
    foreach ($child in $script:Children) { Stop-Tree -Process $child }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    $lock = Join-Path $Runtime 'songforge.lock'
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
}

# A failure nobody anticipated must not close the window, or leave half the
# app running behind it.
trap {
    Write-Host ''
    Write-Host "  Unexpected error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  at $($_.InvocationInfo.ScriptName):$($_.InvocationInfo.ScriptLineNumber)" -ForegroundColor DarkGray
    Stop-Everything
    Exit-Script 1
}

$Host.UI.RawUI.WindowTitle = 'SongForge (starting)'
Write-Host ''
Write-Host '  SongForge' -ForegroundColor White
Write-Host '  ---------' -ForegroundColor DarkGray

# --- Refuse to start twice --------------------------------------------------
if (Test-Path $PidFile) {
    try {
        $recorded = Get-Content $PidFile -Raw | ConvertFrom-Json
        $live = @()
        $expected = @{ backend = '^python'; frontend = '^node' }
        foreach ($name in 'backend', 'frontend') {
            $proc = Get-RunningProcess -ProcessId ([int]$recorded.$name) -Expect $expected[$name]
            if ($proc) { $live += "$name (pid $($proc.Id))" }
        }
        if ($live.Count -gt 0) {
            Write-Warn "SongForge is already running: $($live -join ', ')"
            Write-Warn 'Use the window it was started in, or stop it with scripts\Stop-SongForge.ps1'
            Exit-Script 3
        }
        Remove-Item $PidFile -Force
    } catch {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
}

if (Test-Endpoint -Uri "http://127.0.0.1:$BackendPort/api/health" -TimeoutSec 2) {
    Write-Warn "Something is already answering on port $BackendPort - probably another SongForge."
    Write-Warn 'Close that one first, or run scripts\Stop-SongForge.ps1.'
    Write-Warn 'If another program owns that port, start with:  start.bat -BackendPort 3344'
    Exit-Script 3
}

# --- Preconditions ----------------------------------------------------------
if (-not (Test-Path $VenvPython)) {
    Write-Fail "SongForge is not installed yet.`nRun setup first: double-click setup.bat (or run .\setup.ps1)."
    Exit-Script 4
}
if (-not (Test-Path (Join-Path $Frontend 'node_modules\next'))) {
    Write-Fail "The web app's packages are not installed.`nRun setup again: double-click setup.bat (or run .\setup.ps1)."
    Exit-Script 4
}
# `next start` refuses to run without a production build, and said so only
# after the start timed out. Checking here names the fix instead.
if (-not (Test-Path (Join-Path $Frontend '.next\BUILD_ID'))) {
    Write-Fail "The web app has not been built.`nRun setup again: double-click setup.bat (or run .\setup.ps1)."
    Exit-Script 4
}
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
if (-not $node) {
    Write-Fail "Node.js was not found.`nInstall the LTS version from https://nodejs.org, then start SongForge again."
    Exit-Script 4
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# --- The web app must point at the engine port in use ------------------------
# The address the web app forwards /api to is fixed when it is built. Started
# on another engine port without rebuilding, every request went to the old
# port and the app opened to nothing but errors.
$routes = Join-Path $Frontend '.next\routes-manifest.json'
$apiTarget = "http://127.0.0.1:$BackendPort/"
if ((Test-Path $routes) -and -not (Select-String -LiteralPath $routes -SimpleMatch $apiTarget -Quiet)) {
    Write-Step "Rebuilding the web app for engine port $BackendPort (about a minute, once) ..."
    $env:SONGFORGE_API_URL = "http://127.0.0.1:$BackendPort"
    $env:NEXT_TELEMETRY_DISABLED = '1'
    $rebuildLog = Join-Path $LogDir 'rebuild.log'
    $rebuildErr = Join-Path $LogDir 'rebuild.err.log'
    $nextCli = Join-Path $Frontend 'node_modules\next\dist\bin\next'
    $rebuild = Start-Process -FilePath $node.Source -ArgumentList @("`"$nextCli`"", 'build') `
        -WorkingDirectory $Frontend -PassThru -Wait -WindowStyle Hidden `
        -RedirectStandardOutput $rebuildLog -RedirectStandardError $rebuildErr
    if ($rebuild.ExitCode -ne 0) {
        Write-Fail "The web app could not be rebuilt for port $BackendPort.`nLog: $rebuildErr`nStart without -BackendPort, or run setup again."
        Exit-Script 4
    }
}

# --- Prune old run logs -----------------------------------------------------
# Every start writes a handful of files here and nothing ever removed them, so
# the folder grew without limit. Only this script's own stamped run logs are
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
}

$stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'
$backendLog  = Join-Path $LogDir "backend-$stamp.log"
$backendErr  = Join-Path $LogDir "backend-$stamp.err.log"
$frontendLog = Join-Path $LogDir "frontend-$stamp.log"
$frontendErr = Join-Path $LogDir "frontend-$stamp.err.log"
$ollamaLog   = Join-Path $LogDir "ollama-$stamp.log"

try {
    # --- Local lyrics model (optional) -------------------------------------
    # Entirely optional: a failure here never blocks SongForge, and the
    # lyrics writer explains itself when the model is absent. An Ollama that
    # is already running (its own tray app, say) is used as it is and left
    # running afterwards; one this script starts is stopped with it.
    $ollamaNote = 'not installed (optional)'
    $portable   = Join-Path $Runtime 'ollama\ollama.exe'
    $ollamaExe  = $null
    if (Test-Path $portable) {
        $ollamaExe = $portable
    } else {
        $found = Get-Command ollama.exe -ErrorAction SilentlyContinue
        if ($found) { $ollamaExe = $found.Source }
    }
    if (Test-Endpoint -Uri "$OllamaUrl/api/version" -TimeoutSec 2) {
        $ollamaNote = 'running'
    } elseif ($ollamaExe) {
        Write-Step 'Starting the lyrics writer (Ollama) ...'
        $env:OLLAMA_HOST = '127.0.0.1:11434'
        $env:OLLAMA_MAX_LOADED_MODELS = '1'
        $env:OLLAMA_NUM_PARALLEL = '1'
        # A portable copy keeps its models beside it. A system install keeps
        # them where its own installer put them, and pointing it elsewhere
        # would hide every model the user has already pulled.
        $portableModels = Join-Path $Runtime 'models\ollama'
        if ($ollamaExe -eq $portable -or (Test-Path $portableModels)) {
            $env:OLLAMA_MODELS = $portableModels
        }
        $ollamaProc = Start-Process -FilePath $ollamaExe -ArgumentList @('serve') `
            -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput "$ollamaLog.out" -RedirectStandardError $ollamaLog
        Add-ToJob -Process $ollamaProc
        $script:Children += $ollamaProc
        $ollamaReady = $false
        try {
            $ollamaReady = Wait-ForEndpoint -Uri "$OllamaUrl/api/version" -Seconds 30 -Name 'Ollama' -Process $ollamaProc
        } catch {
            $ollamaReady = $false
        }
        if ($ollamaReady) {
            $ollamaNote = 'running'
        } else {
            $ollamaNote = 'did not start (optional) - see ' + $ollamaLog
            Stop-Tree -Process $ollamaProc
        }
    }

    # --- Backend -------------------------------------------------------------
    Write-Step 'Starting the engine ...'
    # Tells the engine whether it is being shared. While it is, the settings
    # that decide which program runs cannot be changed from the web page.
    # Always set, so a value left in this terminal by an earlier run is not
    # inherited.
    $env:SONGFORGE_LAN = if ($Lan) { '1' } else { '0' }
    $backendProc = Start-Process -FilePath $VenvPython `
        -ArgumentList @('-m', 'uvicorn', 'songforge.main:app',
                        '--host', '127.0.0.1', '--port', "$BackendPort") `
        -WorkingDirectory $Backend -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $backendLog -RedirectStandardError $backendErr
    Add-ToJob -Process $backendProc
    $script:Children += $backendProc

    $healthy = $false
    $problem = "The engine did not answer within $TimeoutSeconds seconds."
    try {
        $healthy = Wait-ForEndpoint -Uri "http://127.0.0.1:$BackendPort/api/health" `
                                    -Seconds $TimeoutSeconds -Name 'The engine' -Process $backendProc
    } catch {
        $problem = $_.Exception.Message
    }
    if (-not $healthy) {
        Write-Fail $problem
        Write-Warn "Log: $backendErr"
        if (Test-Path $backendErr) {
            Write-Dim '--- last lines of the log ---'
            Get-Content $backendErr -Tail 20 | ForEach-Object { Write-Dim $_ }
        }
        Stop-Everything
        Exit-Script 5
    }

    # --- Web app -------------------------------------------------------------
    Write-Step 'Starting the web app ...'
    $bind = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
    $env:SONGFORGE_API_URL = "http://127.0.0.1:$BackendPort"
    $env:NEXT_TELEMETRY_DISABLED = '1'
    # node is started directly rather than through npm: one process fewer, a
    # real exit code, and no cmd.exe wrapper that outlives its child.
    $nextBin = Join-Path $Frontend 'node_modules\next\dist\bin\next'
    $frontendProc = Start-Process -FilePath $node.Source `
        -ArgumentList @("`"$nextBin`"", 'start', '--hostname', $bind, '--port', "$Port") `
        -WorkingDirectory $Frontend -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $frontendLog -RedirectStandardError $frontendErr
    Add-ToJob -Process $frontendProc
    $script:Children += $frontendProc

    $ready = $false
    $problem = "The web app did not answer within $TimeoutSeconds seconds."
    try {
        $ready = Wait-ForEndpoint -Uri "http://127.0.0.1:$Port" `
                                  -Seconds $TimeoutSeconds -Name 'The web app' -Process $frontendProc
    } catch {
        $problem = $_.Exception.Message
    }
    if (-not $ready) {
        Write-Fail $problem
        Write-Warn "Log: $frontendErr"
        if (Test-Path $frontendErr) {
            Write-Dim '--- last lines of the log ---'
            Get-Content $frontendErr -Tail 20 | ForEach-Object { Write-Dim $_ }
        }
        Write-Warn "If port $Port is taken by another program, start with: .\scripts\Start-SongForge.ps1 -Port 8080"
        Stop-Everything
        Exit-Script 5
    }

    # --- Record and report ---------------------------------------------------
    @{
        backend  = $backendProc.Id
        frontend = $frontendProc.Id
        ollama   = 0
        port     = $Port
        started  = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -Path $PidFile -Encoding utf8
    $script:Started = $true

    $url = "http://localhost:$Port"
    $Host.UI.RawUI.WindowTitle = "SongForge - $url"
    Write-Host ''
    Write-Host '  SongForge is running.' -ForegroundColor Green
    Write-Host ''
    Write-Host '    Open it here:    ' -NoNewline
    Write-Host $url -ForegroundColor White
    if ($Lan) {
        $address = Get-LanAddress
        if ($address) {
            Write-Host '    Other devices:   ' -NoNewline
            Write-Host "http://${address}:$Port" -ForegroundColor White
        } else {
            Write-Warn '  No network address was found; only this computer can open it.'
        }
    } else {
        Write-Dim '  Only this computer can open it. Start with -Lan to share it on your network.'
    }
    Write-Dim "  Lyrics writer:   $ollamaNote"
    Write-Dim "  Logs:            $LogDir"
    Write-Host ''
    Write-Host '  Keep this window open while you use SongForge.' -ForegroundColor White
    Write-Host '  Press Ctrl+C here, or close the window, to stop it.' -ForegroundColor White
    Write-Host ''

    if (-not $NoBrowser) {
        try { Start-Process $url | Out-Null } catch { Write-Dim "Open $url in your browser." }
    }

    # --- Stay in the foreground ---------------------------------------------
    # One line per event, so the window reads as a short history of the
    # session rather than a wall of server output (that is what the logs are
    # for). A missed poll is not an event: only a process that has actually
    # exited ends the session.
    $lastJob = ''
    $lastQueued = -1
    while ($true) {
        Start-Sleep -Seconds 2
        if ($backendProc.HasExited) {
            throw "The engine stopped unexpectedly (exit code $($backendProc.ExitCode)). See $backendErr"
        }
        if ($frontendProc.HasExited) {
            throw "The web app stopped unexpectedly (exit code $($frontendProc.ExitCode)). See $frontendErr"
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$BackendPort/api/health" -TimeoutSec 3
        } catch {
            continue
        }
        $job = [string]$health.active_job_id
        $queued = [int]$health.queued_jobs
        $time = Get-Date -Format 'HH:mm:ss'
        if ($job -ne $lastJob) {
            if ($job) {
                $suffix = if ($queued -gt 0) { " ($queued more waiting)" } else { '' }
                Write-Host "  [$time] Rendering a song$suffix ..." -ForegroundColor Cyan
            } elseif ($lastJob) {
                Write-Host "  [$time] Done. Ready for the next one." -ForegroundColor Green
            }
            $lastJob = $job
        } elseif ($job -and $queued -ne $lastQueued -and $lastQueued -ge 0) {
            Write-Dim "[$time] $queued waiting in the queue."
        }
        $lastQueued = $queued
    }
} catch {
    Write-Fail $_.Exception.Message
    $script:Failed = $true
} finally {
    # Reached on Ctrl+C, on an error above, and on a normal end alike.
    if ($script:Children.Count -gt 0) {
        Write-Host ''
        Write-Step 'Stopping SongForge ...'
        Stop-Everything
        Write-Ok 'Stopped.'
        Write-Host ''
    }
}

if (Get-Variable -Name Failed -Scope Script -ErrorAction SilentlyContinue) {
    Exit-Script 5
}
exit 0
