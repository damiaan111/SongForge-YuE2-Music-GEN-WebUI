<#
.SYNOPSIS
    Puts a "SongForge" shortcut on your desktop, or removes it again.

.DESCRIPTION
    The shortcut runs start.bat - exactly what double-clicking that file does.
    A terminal window opens, shows the address to open in your browser, and
    stays open while SongForge runs. Closing that window stops SongForge, so
    there is no separate "stop" shortcut.

    Nothing here needs administrator rights; the shortcut is written to your
    own Desktop folder, wherever that is (OneDrive-redirected desktops work).

.PARAMETER Port
    Port for the web app, passed to the start script. Default 3333.

.PARAMETER Lan
    Make the shortcut start SongForge shared on your network (start.bat -Lan).

.PARAMETER Name
    Name of the shortcut. Default 'SongForge'.

.PARAMETER Remove
    Delete the shortcut instead of creating it. Also removes the Start, Stop
    and Open shortcuts that earlier versions of this script created.

.EXAMPLE
    .\Create-DesktopShortcut.ps1
    .\Create-DesktopShortcut.ps1 -Port 8080
    .\Create-DesktopShortcut.ps1 -Remove
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateRange(1, 65535)][int]$Port = 3333,
    [switch]$Lan,
    [ValidateNotNullOrEmpty()][string]$Name = 'SongForge',
    [switch]$Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root     = Split-Path -Parent $PSScriptRoot
$StartBat = Join-Path $Root 'start.bat'
$Desktop  = [Environment]::GetFolderPath('Desktop')

function Write-Ok   { param([string]$Message) Write-Host "  $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  $Message" -ForegroundColor Yellow }

if (-not $Desktop -or -not (Test-Path -LiteralPath $Desktop)) {
    Write-Host "  Could not locate your Desktop folder (got '$Desktop')." -ForegroundColor Red
    exit 2
}

$link = Join-Path $Desktop "$Name.lnk"
# What earlier versions of this script created; -Remove clears these too.
$legacy = @(
    (Join-Path $Desktop "Start $Name.lnk"),
    (Join-Path $Desktop "Stop $Name.lnk"),
    (Join-Path $Desktop "Open $Name.url")
)

Write-Host ''
Write-Host 'SongForge desktop shortcut' -ForegroundColor White
Write-Host "  Desktop: $Desktop" -ForegroundColor DarkGray
Write-Host ''

# --- Remove -----------------------------------------------------------------
if ($Remove) {
    $removed = 0
    foreach ($path in @($link) + $legacy) {
        if (Test-Path -LiteralPath $path) {
            if ($PSCmdlet.ShouldProcess($path, 'Delete shortcut')) {
                Remove-Item -LiteralPath $path -Force
                Write-Ok "Removed $(Split-Path -Leaf $path)"
                $removed++
            }
        }
    }
    if ($removed -eq 0) { Write-Warn 'No SongForge shortcut was on the desktop.' }
    Write-Host ''
    exit 0
}

# --- Create -----------------------------------------------------------------
if (-not (Test-Path -LiteralPath $StartBat)) {
    Write-Host "  Missing: $StartBat" -ForegroundColor Red
    exit 2
}

$arguments = @()
if ($Port -ne 3333) { $arguments += "-Port $Port" }
if ($Lan) { $arguments += '-Lan' }

if ($PSCmdlet.ShouldProcess($link, 'Create shortcut')) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($link)
    # cmd.exe /c rather than the .bat itself: a shortcut pointing straight at a
    # batch file cannot be pinned to Start or the taskbar.
    $shortcut.TargetPath = "$env:SystemRoot\System32\cmd.exe"
    $shortcut.Arguments = "/c `"`"$StartBat`" $($arguments -join ' ')`""
    $shortcut.WorkingDirectory = $Root
    # A terminal icon is the honest one to show: this opens a terminal window,
    # and that window is the app.
    $shortcut.IconLocation = "$env:SystemRoot\System32\cmd.exe,0"
    $shortcut.Description = 'Start SongForge. Keep the window open while you use it; close it to stop.'
    $shortcut.Save()
    Write-Ok "Created $(Split-Path -Leaf $link)"
}

Write-Host ''
Write-Host '  Double-click it to start SongForge. A terminal window opens and shows' -ForegroundColor DarkGray
Write-Host '  the address; closing that window stops SongForge.' -ForegroundColor DarkGray
Write-Host '  Undo: .\scripts\Create-DesktopShortcut.ps1 -Remove' -ForegroundColor DarkGray
Write-Host ''
exit 0
