<#
.SYNOPSIS
    Creates (or removes) desktop shortcuts for starting, stopping and opening
    SongForge.

.DESCRIPTION
    Three shortcuts, all optional:

      Start SongForge   runs Start-SongForge.ps1 in a visible window, so you can
                        read the LAN address it prints and any error it hits
      Stop SongForge    runs Stop-SongForge.ps1
      Open SongForge    an internet shortcut to http://localhost:<port>

    Nothing here needs administrator rights; the shortcuts are written to your
    own Desktop folder, wherever that is (OneDrive-redirected desktops work).

.PARAMETER Port
    Port used for the "Open SongForge" shortcut and passed to the start script.
    Default 3333.

.PARAMETER BackendPort
    Backend port passed to the start script. Default 3334.

.PARAMETER Prefix
    Name prefix for the shortcut files. Default 'SongForge'.

.PARAMETER NoOpenShortcut
    Skip the browser shortcut.

.PARAMETER Remove
    Delete the shortcuts instead of creating them.

.EXAMPLE
    .\Create-DesktopShortcut.ps1
    .\Create-DesktopShortcut.ps1 -Port 8080
    .\Create-DesktopShortcut.ps1 -Remove
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateRange(1, 65535)][int]$Port = 3333,
    [ValidateRange(1, 65535)][int]$BackendPort = 3334,
    [ValidateNotNullOrEmpty()][string]$Prefix = 'SongForge',
    [switch]$NoOpenShortcut,
    [switch]$Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$StartPath = Join-Path $PSScriptRoot 'Start-SongForge.ps1'
$StopPath  = Join-Path $PSScriptRoot 'Stop-SongForge.ps1'
$Desktop   = [Environment]::GetFolderPath('Desktop')

function Write-Ok   { param([string]$Message) Write-Host "  $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  $Message" -ForegroundColor Yellow }

if (-not $Desktop -or -not (Test-Path -LiteralPath $Desktop)) {
    Write-Error "Could not locate your Desktop folder (got '$Desktop')."
    exit 2
}

$startLink = Join-Path $Desktop "Start $Prefix.lnk"
$stopLink  = Join-Path $Desktop "Stop $Prefix.lnk"
$openLink  = Join-Path $Desktop "Open $Prefix.url"

Write-Host ''
Write-Host "SongForge desktop shortcuts" -ForegroundColor White
Write-Host "  Desktop: $Desktop" -ForegroundColor DarkGray
Write-Host ''

# --- Remove -----------------------------------------------------------------
if ($Remove) {
    $removed = 0
    foreach ($path in @($startLink, $stopLink, $openLink)) {
        if (Test-Path -LiteralPath $path) {
            if ($PSCmdlet.ShouldProcess($path, 'Delete shortcut')) {
                Remove-Item -LiteralPath $path -Force
                Write-Ok "Removed $(Split-Path -Leaf $path)"
                $removed++
            }
        }
    }
    if ($removed -eq 0) { Write-Warn 'No SongForge shortcuts were on the desktop.' }
    Write-Host ''
    exit 0
}

# --- Create -----------------------------------------------------------------
foreach ($required in @($StartPath, $StopPath)) {
    if (-not (Test-Path -LiteralPath $required)) {
        Write-Error "Missing script: $required"
        exit 2
    }
}

# powershell.exe carries its own icon, which is the honest one to show: these
# shortcuts run a script, they are not the application itself.
$iconSource = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe,0"
$shell = New-Object -ComObject WScript.Shell

function New-ScriptShortcut {
    param(
        [string]$LinkPath,
        [string]$ScriptPath,
        [string]$Arguments,
        [string]$Description
    )
    if (-not $PSCmdlet.ShouldProcess($LinkPath, 'Create shortcut')) { return }
    $link = $shell.CreateShortcut($LinkPath)
    $link.TargetPath = 'powershell.exe'
    # -NoExit keeps the window open so the printed LAN address and any error
    # stay readable instead of vanishing with the console.
    $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$ScriptPath`" $Arguments"
    $link.WorkingDirectory = $Root
    $link.IconLocation = $iconSource
    $link.Description = $Description
    $link.Save()
    Write-Ok "Created $(Split-Path -Leaf $LinkPath)"
}

New-ScriptShortcut -LinkPath $startLink -ScriptPath $StartPath `
    -Arguments "-Port $Port -BackendPort $BackendPort" `
    -Description 'Start the SongForge backend and frontend, then print the LAN address.'

New-ScriptShortcut -LinkPath $stopLink -ScriptPath $StopPath `
    -Arguments '' `
    -Description 'Stop SongForge. A generation in progress is cancelled cleanly.'

if (-not $NoOpenShortcut) {
    if ($PSCmdlet.ShouldProcess($openLink, 'Create internet shortcut')) {
        # A .url file opens in the default browser without a shell wrapper.
        @(
            '[InternetShortcut]'
            "URL=http://localhost:$Port"
            "IconIndex=0"
        ) | Set-Content -LiteralPath $openLink -Encoding ascii
        Write-Ok "Created $(Split-Path -Leaf $openLink)"
    }
}

Write-Host ''
Write-Host '  Open SongForge only works once it is running.' -ForegroundColor DarkGray
Write-Host '  On another device, use the LAN address the start script prints instead.' -ForegroundColor DarkGray
Write-Host "  Undo: .\Create-DesktopShortcut.ps1 -Remove" -ForegroundColor DarkGray
Write-Host ''
exit 0
