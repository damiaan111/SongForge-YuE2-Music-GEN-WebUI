<#
.SYNOPSIS
    Registers (or removes) a Windows scheduled task that starts SongForge when
    you log on.

.DESCRIPTION
    SongForge is a LAN application with no accounts, so it is deliberately tied
    to a logon rather than run as a service under SYSTEM: the GPU, the Hugging
    Face cache and the runtime folder all belong to your user profile, and a
    SYSTEM-owned copy would not be able to reach them.

    The task simply runs Start-SongForge.ps1, which already refuses to start a
    second copy - so nothing breaks if you also start it by hand.

    Registering a task for your own account does not need administrator rights.

.PARAMETER TaskName
    Name to register under. Default 'SongForge'.

.PARAMETER Port
    Frontend port passed through to Start-SongForge.ps1. Default 3333.

.PARAMETER BackendPort
    Backend port passed through to Start-SongForge.ps1. Default 3334.

.PARAMETER DelaySeconds
    Wait after logon before starting, so the network and NVIDIA driver are up.
    Default 45.

.PARAMETER Remove
    Delete the task instead of creating it.

.PARAMETER Status
    Report whether the task exists and when it last ran, then exit.

.EXAMPLE
    .\Install-StartupTask.ps1
    .\Install-StartupTask.ps1 -Port 8080 -DelaySeconds 90
    .\Install-StartupTask.ps1 -Status
    .\Install-StartupTask.ps1 -Remove
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateNotNullOrEmpty()][string]$TaskName = 'SongForge',
    [ValidateRange(1, 65535)][int]$Port = 3333,
    [ValidateRange(1, 65535)][int]$BackendPort = 3334,
    [ValidateRange(0, 900)][int]$DelaySeconds = 45,
    [switch]$Remove,
    [switch]$Status
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$StartPath = Join-Path $PSScriptRoot 'Start-SongForge.ps1'

function Write-Step { param([string]$Message) Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "  $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  $Message" -ForegroundColor Yellow }

function Get-Task {
    try { return Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { return $null }
}

Write-Host ''
Write-Host "SongForge startup task ($TaskName)" -ForegroundColor White
Write-Host ''

if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
    Write-Error 'The ScheduledTasks module is not available on this system.'
    exit 2
}

# --- Status -----------------------------------------------------------------
if ($Status) {
    $task = Get-Task
    if (-not $task) {
        Write-Warn 'Not installed.'
        exit 1
    }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Ok "Installed. State: $($task.State)."
    Write-Host "  Last run:    $($info.LastRunTime)" -ForegroundColor DarkGray
    Write-Host "  Last result: $($info.LastTaskResult)" -ForegroundColor DarkGray
    Write-Host "  Next run:    $($info.NextRunTime)" -ForegroundColor DarkGray
    exit 0
}

# --- Remove -----------------------------------------------------------------
if ($Remove) {
    if (-not (Get-Task)) {
        Write-Warn "No task named '$TaskName' is registered. Nothing to do."
        exit 0
    }
    if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister scheduled task')) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Ok "Removed. SongForge will no longer start at logon."
        Write-Host '  Any copy already running is untouched; stop it with .\Stop-SongForge.ps1' -ForegroundColor DarkGray
    }
    exit 0
}

# --- Create -----------------------------------------------------------------
if (-not (Test-Path -LiteralPath $StartPath)) {
    Write-Error "Start-SongForge.ps1 was not found next to this script ($StartPath)."
    exit 2
}

$existing = Get-Task
if ($existing) {
    Write-Warn "A task named '$TaskName' already exists; it will be replaced."
}

# -File keeps the quoting sane: no nested command string to escape.
$arguments = @(
    '-NoProfile'
    '-ExecutionPolicy', 'Bypass'
    '-WindowStyle', 'Hidden'
    '-File', "`"$StartPath`""
    '-Port', $Port
    '-BackendPort', $BackendPort
) -join ' '

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument $arguments -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
if ($DelaySeconds -gt 0) {
    # A logon trigger fires before the NVIDIA driver and the network are always
    # ready; the delay avoids a first-boot failure that needs a manual restart.
    $trigger.Delay = [System.Xml.XmlConvert]::ToString([TimeSpan]::FromSeconds($DelaySeconds))
}

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

if ($PSCmdlet.ShouldProcess($TaskName, 'Register scheduled task')) {
    Write-Step "Registering for $env:USERDOMAIN\$env:USERNAME ..."
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force `
        -Description 'Starts the SongForge backend and frontend at logon (LAN only).' | Out-Null

    Write-Ok 'Installed.'
    Write-Host ''
    Write-Host "  Runs:        $StartPath -Port $Port -BackendPort $BackendPort" -ForegroundColor DarkGray
    Write-Host "  Trigger:     at logon of $env:USERNAME, after $DelaySeconds s" -ForegroundColor DarkGray
    Write-Host "  Logs:        $(Join-Path $Root 'runtime\logs')" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  Test it now without logging out:' -ForegroundColor DarkGray
    Write-Host "    Start-ScheduledTask -TaskName $TaskName" -ForegroundColor DarkGray
    Write-Host "  Check on it:  .\Install-StartupTask.ps1 -Status" -ForegroundColor DarkGray
    Write-Host "  Undo:         .\Install-StartupTask.ps1 -Remove" -ForegroundColor DarkGray
    Write-Host ''
}
exit 0
