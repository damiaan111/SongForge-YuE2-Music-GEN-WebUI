<#
.SYNOPSIS
    First-run setup for SongForge on Windows.

.DESCRIPTION
    Finds a Python 3.12 or newer, then hands over to the setup menu, which
    detects this machine's GPU and offers to install what is needed. Nothing is
    downloaded until you agree to it in that menu.

    This script deliberately does almost nothing itself: every decision lives in
    app\backend\songforge\setup\, which is plain Python with no dependencies and
    is covered by the test suite. PowerShell cannot be tested on a Mac or in CI.

.EXAMPLE
    .\setup.ps1
    .\setup.ps1 -Arguments '--detect'
    .\setup.ps1 -Arguments '--yes'
#>
param(
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

function Find-Python {
    <# A Python 3.12+ interpreter, or $null.

       The py launcher is asked first and by exact version, because "python" on
       PATH is often a 3.11 from somewhere else or the Microsoft Store stub that
       opens a shop page instead of running. #>
    # 3.12 first because that is what the project is built and tested on; a
    # newer interpreter is accepted but is not the one to reach for by default,
    # since a dependency without a wheel for it turns into a compiler error.
    $candidates = @()
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($version in '-3.12', '-3.13', '-3.14', '-3') {
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
    $probe = 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,12) else 1)'

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
    Write-Bad 'No Python 3.12 or newer was found.'
    Write-Host ''
    Write-Host '  Install it from https://www.python.org/downloads/ and tick' -ForegroundColor DarkGray
    Write-Host '  "Add python.exe to PATH" in the installer, then run this again.' -ForegroundColor DarkGray
    Write-Host ''
    Exit-Script 1
}

Write-Step "Using Python $($python.Version)."
Write-Host ''

& $python.Exe @($python.Prefix) $Entry @Arguments
Exit-Script $LASTEXITCODE
