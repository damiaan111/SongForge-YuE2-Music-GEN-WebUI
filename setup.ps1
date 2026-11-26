<#
.SYNOPSIS
    First-run setup for SongForge on Windows.

.DESCRIPTION
    Finds a Python 3.12 or 3.13, then hands over to the setup menu, which
    detects this machine's GPU and offers to install what is needed. Nothing is
    downloaded until you agree to it in that menu.

    This script deliberately does almost nothing itself: every decision lives in
    app\backend\songforge\setup\, which is plain Python with no dependencies and
    is covered by the test suite. PowerShell cannot be tested on a Mac or in CI.

    Easiest: double-click setup.bat in the same folder, which runs this file
    even on a computer where PowerShell scripts are blocked.

.EXAMPLE
    .\setup.ps1
    .\setup.ps1 --detect
    .\setup.ps1 --yes
    .\setup.ps1 --yes --with-lyrics
    .\setup.ps1 --only=backend,frontend
#>
param(
    # Kept so an older command line (-Arguments '--yes') still works. Flags
    # typed the natural way arrive in $args instead; see Get-ForwardedArguments.
    [string[]]$Arguments = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root  = $PSScriptRoot
$Entry = Join-Path $Root 'app\backend\songforge\setup\__main__.py'

function Write-Step { param([string]$Message) Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Bad  { param([string]$Message) Write-Host "  $Message" -ForegroundColor Red }

# Closing the window on exit hides whatever went wrong, which is exactly what
# someone running this for the first time needs to read.
$script:ConsoleWillClose = $false
if ($Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected) {
    $keepsOpen = @([Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^[-/]noe' })
    $script:ConsoleWillClose = ($keepsOpen.Count -eq 0)
}

function Exit-Script {
    param([int]$Code = 0)
    if ($script:ConsoleWillClose) {
        Write-Host '  Press any key to close this window ...' -ForegroundColor DarkGray
        try { [Console]::ReadKey($true) | Out-Null } catch { Start-Sleep -Seconds 30 }
    }
    exit $Code
}

function Get-ForwardedArguments {
    <# Everything to hand to the Python entry point.

       ".\setup.ps1 --yes" does not bind --yes to a parameter: PowerShell reads
       a leading dash as a parameter name, finds none called that, and leaves
       it in $args. Forwarding only -Arguments therefore dropped every flag
       the README shows, and setup opened the menu as though none were given.

       A value with a comma ("--only=backend,frontend") arrives as an array,
       because the comma is PowerShell's array operator; it is joined back. #>
    param([object[]]$Named, [object[]]$Remaining)
    $result = @()
    foreach ($item in @($Named) + @($Remaining)) {
        if ($null -eq $item) { continue }
        if ($item -is [array]) { $result += ($item -join ',') } else { $result += "$item" }
    }
    return ,$result
}

function Find-Python {
    <# A Python 3.12 or 3.13 interpreter, or $null.

       The py launcher is asked first and by exact version, because "python" on
       PATH is often a 3.11 from somewhere else or the Microsoft Store stub that
       opens a shop page instead of running. #>
    # 3.12 first because that is what the project is built and tested on.
    # Nothing newer than 3.13 is accepted: YuE2's dependencies are pinned to
    # exact versions, and on an interpreter they have no wheels for pip tries
    # to compile them and fails twenty minutes into the install.
    $candidates = @()
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($version in '-3.12', '-3.13') {
            $candidates += ,@('py', @($version))
        }
    }
    foreach ($name in 'python3', 'python') {
        if (Get-Command $name -ErrorAction SilentlyContinue) { $candidates += ,@($name, @()) }
    }

    # The probe deliberately contains no quotes and no % formatting: PowerShell
    # rewrites those on the way to a native command, and the interpreter then
    # fails with a SyntaxError that looks like a broken Python rather than a
    # broken argument. Exit status says everything we need.
    $probe = 'import sys; raise SystemExit(0 if (3,12) <= sys.version_info[:2] <= (3,13) else 1)'

    foreach ($candidate in $candidates) {
        $exe = $candidate[0]
        $prefix = $candidate[1]
        try {
            & $exe @prefix -c $probe 2>$null
        } catch { continue }
        if ($LASTEXITCODE -ne 0) { continue }

        $version = ''
        try { $version = (& $exe @prefix --version 2>&1 | Select-Object -First 1) } catch { }
        return @{ Exe = $exe; Prefix = $prefix; Version = "$version".Replace('Python', '').Trim() }
    }
    return $null
}

Write-Host ''
Write-Host 'SongForge setup' -ForegroundColor White
Write-Host '---------------' -ForegroundColor DarkGray

if (-not (Test-Path $Entry)) {
    Write-Bad "Cannot find $Entry."
    Write-Bad 'Run this script from inside the SongForge checkout.'
    Exit-Script 1
}

$python = Find-Python
if ($null -eq $python) {
    Write-Bad 'Python 3.12 was not found (3.13 also works; older and newer do not).'
    Write-Host ''
    Write-Host '  Install Python 3.12 from https://www.python.org/downloads/' -ForegroundColor DarkGray
    Write-Host '  (or run:  winget install Python.Python.3.12), then run setup again.' -ForegroundColor DarkGray
    Write-Host '  It can sit beside any other Python you already have.' -ForegroundColor DarkGray
    Write-Host ''
    Exit-Script 1
}

Write-Step "Using Python $($python.Version)."
Write-Host ''

$forwarded = Get-ForwardedArguments -Named $Arguments -Remaining $args
& $python.Exe @($python.Prefix) $Entry @forwarded
Exit-Script $LASTEXITCODE
