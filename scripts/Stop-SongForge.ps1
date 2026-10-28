<#
.SYNOPSIS
    Stops the SongForge backend and frontend.

.DESCRIPTION
    Reads runtime\songforge.pids.json, stops the recorded processes and their
    children, and removes the instance lock if it is stale. Safe to run when
    nothing is running.

.PARAMETER Force
    Skip the graceful wait and terminate immediately.
#>
[CmdletBinding()]
param([switch]$Force)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root     = Split-Path -Parent $PSScriptRoot
$Runtime  = Join-Path $Root 'runtime'
$PidFile  = Join-Path $Runtime 'songforge.pids.json'
$LockFile = Join-Path $Runtime 'songforge.lock'

function Write-Step { param([string]$m) Write-Host "  $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "  $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "  $m" -ForegroundColor Yellow }

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


function Get-Descendants {
    <# All descendant process ids of a process, breadth-first. #>
    param([int]$ProcessId)
    $all = @()
    try {
        $table = Get-CimInstance Win32_Process -ErrorAction Stop |
            Select-Object ProcessId, ParentProcessId
    } catch { return @() }
    $frontier = @($ProcessId)
    while ($frontier.Count -gt 0) {
        $next = @()
        foreach ($parent in $frontier) {
            $kids = $table | Where-Object { $_.ParentProcessId -eq $parent -and $_.ProcessId -ne $parent }
            foreach ($kid in $kids) {
                if ($all -notcontains $kid.ProcessId) {
                    $all += $kid.ProcessId
                    $next += $kid.ProcessId
                }
            }
        }
        $frontier = $next
    }
    return $all
}

function Stop-Tree {
    <# Stops a process and any children, since npm spawns a node child. #>
    param([int]$ProcessId, [string]$Name)

    $proc = $null
    try { $proc = Get-Process -Id $ProcessId -ErrorAction Stop } catch { }
    if (-not $proc) {
        Write-Step "$Name (pid $ProcessId) was not running."
        return $false
    }

    # The whole tree, not just direct children: the frontend is launched as
    # npm -> cmd -> node, so stopping one level left the actual Next.js server
    # running and holding port 3333 after every stop. Deepest processes first.
    $descendants = @(Get-Descendants -ProcessId $ProcessId)
    [array]::Reverse($descendants)
    foreach ($descendant in $descendants) {
        try { Stop-Process -Id $descendant -Force -ErrorAction SilentlyContinue } catch { }
    }

    if (-not $Force) {
        try {
            $proc.CloseMainWindow() | Out-Null
            if ($proc.WaitForExit(5000)) {
                Write-Ok "$Name (pid $ProcessId) stopped."
                return $true
            }
        } catch { }
    }

    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        Write-Ok "$Name (pid $ProcessId) stopped."
        return $true
    } catch {
        Write-Warn "Could not stop $Name (pid ${ProcessId}): $($_.Exception.Message)"
        return $false
    }
}

Write-Host ''
Write-Host 'Stopping SongForge' -ForegroundColor White
Write-Host '------------------' -ForegroundColor DarkGray

$stoppedAny = $false

if (Test-Path $PidFile) {
    try {
        $recorded = Get-Content $PidFile -Raw | ConvertFrom-Json
        # Frontend first, so the UI stops accepting requests before the API goes.
        foreach ($name in 'frontend', 'backend', 'ollama') {
            # StrictMode throws on a missing property, and PID files written
            # before Ollama was managed have no 'ollama' entry.
            $property = $recorded.PSObject.Properties[$name]
            $value = if ($property) { $property.Value } else { $null }
            if ($null -ne $value -and [int]$value -gt 0) {
                if (Stop-Tree -ProcessId ([int]$value) -Name $name) { $stoppedAny = $true }
            }
        }
    } catch {
        Write-Warn "Could not read $PidFile : $($_.Exception.Message)"
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
} else {
    Write-Step 'No PID file found.'
}

# The backend removes its own lock on a clean exit. A leftover lock means it was
# killed; clear it only when no process still holds it.
if (Test-Path $LockFile) {
    $holder = 0
    try { $holder = [int](Get-Content $LockFile -Raw).Trim() } catch { }
    $alive = $null
    if ($holder -gt 0) { try { $alive = Get-Process -Id $holder -ErrorAction Stop } catch { } }
    if ($alive) {
        Write-Warn "The instance lock is still held by pid $holder. Not removing it."
    } else {
        Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
        Write-Step 'Removed a stale instance lock.'
    }
}

Write-Host ''
if ($stoppedAny) {
    Write-Host 'SongForge stopped.' -ForegroundColor Green
} else {
    Write-Host 'Nothing was running.' -ForegroundColor DarkGray
}
Write-Host ''
Exit-Script 0
