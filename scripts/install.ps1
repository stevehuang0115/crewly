# Crewly installer for Windows: one-liner install script
#
# Usage (PowerShell):
#   irm https://crewlyai.com/install.ps1 | iex
#
# What it does:
#   1. Checks Node.js 22+, Git for Windows (Git Bash) and jq; installs what is
#      missing with winget (the Windows package manager that ships with
#      Windows 10 and 11). Anything already present is reported and skipped.
#   2. Installs Crewly with `npm install -g crewly` (Crewly 1.39.1 or later).
#   3. Tells you to open a new terminal and run `crewly start`.
#
# Windows may ask for administrator permission while it installs Node.js or
# Git (their installers can need it). This script says so before it starts
# one, and it never asks you for anything itself.
#
# NOTE: web/public/install.ps1 (crewlyai.com) is a copy of this file; keep them in sync.
#
# Written for Windows PowerShell 5.1 and PowerShell 7. Under `irm | iex` the
# script runs inside your own session, so it never calls `exit` there (that
# would close your terminal) and it leaves your session settings as it found them.
# Keep this file ASCII only: Windows PowerShell 5.1 reads a file without a byte
# order mark in the legacy code page.

$script:MinNodeVersion = 22
$script:MinCrewlyVersion = '1.39.1'

function Write-Ok {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: colored console output is the point, and it must not enter the pipeline.')]
    param([string]$Message)
    Write-Host ('  ' + [char]0x2713 + ' ' + $Message) -ForegroundColor Green
}
function Write-Warn {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: colored console output is the point, and it must not enter the pipeline.')]
    param([string]$Message)
    Write-Host ('  ' + [char]0x26A0 + ' ' + $Message) -ForegroundColor Yellow
}
function Write-Fail {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: colored console output is the point, and it must not enter the pipeline.')]
    param([string]$Message)
    Write-Host ('  ' + [char]0x2717 + ' ' + $Message) -ForegroundColor Red
}
function Write-Step {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: colored console output is the point, and it must not enter the pipeline.')]
    param([string]$Message)
    Write-Host ('  ' + $Message) -ForegroundColor Blue
}
function Write-Plain {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: colored console output is the point, and it must not enter the pipeline.')]
    param([string]$Message)
    Write-Host ('  ' + $Message)
}

function Write-Banner {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: colored console output is the point, and it must not enter the pipeline.')]
    param()
    Write-Host ''
    Write-Host @'
   ____                    _
  / ___|_ __ _____      _| |_   _
 | |   | '__/ _ \ \ /\ / / | | | |
 | |___| | |  __/\ V  V /| | |_| |
  \____|_|  \___| \_/\_/ |_|\__, |
                            |___/
'@ -ForegroundColor Cyan
    Write-Host '  Quick Install (Windows)' -ForegroundColor White
    Write-Host ''
}

# Reload PATH from the machine and user settings, so a program installed a
# moment ago is found without opening a new terminal.
function Sync-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @()
    foreach ($value in @($machine, $user, $env:Path)) {
        if ($value) { $parts += ($value -split ';' | Where-Object { $_ }) }
    }
    $seen = @{}
    $unique = @()
    foreach ($p in $parts) {
        $key = $p.TrimEnd('\').ToLowerInvariant()
        if (-not $seen.ContainsKey($key)) { $seen[$key] = $true; $unique += $p }
    }
    $env:Path = $unique -join ';'
}

# The Node.js major version found on PATH, or $null when there is no node.
function Get-NodeMajor {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    $text = (& $cmd.Source -v 2>$null | Select-Object -First 1)
    if ($text -match '^v?(\d+)\.') { return [int]$Matches[1] }
    return $null
}

# The folder of Git for Windows (the one that holds bin\bash.exe), or $null.
function Get-GitBashPath {
    $candidates = @()
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Git\bin\bash.exe') }
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe') }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe') }
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        $root = Split-Path (Split-Path $git.Source -Parent) -Parent
        $candidates += (Join-Path $root 'bin\bash.exe')
    }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}

function Test-WindowsHost {
    return ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)
}

# npm puts the crewly command in its global folder; ask npm where that is.
function Find-CrewlyCommand {
    $prefix = (& npm prefix -g 2>$null | Select-Object -First 1)
    if ($prefix) {
        $candidate = Join-Path $prefix 'crewly.cmd'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $found = Get-Command crewly -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    return $null
}

function Get-CrewlyVersion {
    param([string]$Path)
    return (& $Path --version 2>$null | Select-Object -First 1)
}

function Test-JqInstalled {
    return [bool](Get-Command jq -ErrorAction SilentlyContinue)
}

function Test-NpmInstalled {
    return [bool](Get-Command npm -ErrorAction SilentlyContinue)
}

# `npm install -g crewly`; returns $true when npm reports success.
function Invoke-NpmInstallCrewly {
    & npm install -g crewly | Out-Host
    return ($LASTEXITCODE -eq 0)
}

function Test-WingetInstalled {
    return [bool](Get-Command winget -ErrorAction SilentlyContinue)
}

# Run winget for one package. Returns $true when it reports success.
function Invoke-Winget {
    param([string[]]$WingetArgs)
    & winget @WingetArgs | Out-Host
    return ($LASTEXITCODE -eq 0)
}

# Install one package with winget: for your user only when the package allows
# it, otherwise machine-wide, and then Windows asks for administrator permission.
function Install-WingetPackage {
    param(
        [string]$Id,
        [string]$Name,
        [string]$AdminNote
    )
    $common = @('install', '--id', $Id, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements')
    Write-Step ('Installing ' + $Name + ' with winget...')
    if (Invoke-Winget -WingetArgs ($common + @('--scope', 'user'))) { return $true }
    if ($AdminNote) { Write-Warn $AdminNote }
    return (Invoke-Winget -WingetArgs $common)
}

function Write-ManualLink {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: colored console output is the point, and it must not enter the pipeline.')]
    param()
    Write-Plain 'winget was not found. It comes with Windows 10 (version 1809 or later) and Windows 11,'
    Write-Plain ('in the "App Installer" package: ' + 'https://aka.ms/getwinget')
    Write-Plain 'Install the pieces below by hand, open a new PowerShell window, and run this installer again:'
    Write-Plain '  Node.js 22 or later   https://nodejs.org'
    Write-Plain '  Git for Windows       https://gitforwindows.org'
    Write-Plain '  jq                    https://jqlang.org/download/'
}

# Make sure one prerequisite is present: report it, or install it, or fail.
# $Check returns $true when the program is there; $Install installs it.
function Confirm-Prerequisite {
    param(
        [string]$Name,
        [scriptblock]$Check,
        [string]$Found,
        [string]$Missing,
        [scriptblock]$Install
    )
    if (& $Check) {
        Write-Ok $Found
        return $true
    }
    Write-Warn $Missing
    if (-not (& $Install)) {
        Write-Fail ($Name + ' could not be installed.')
        return $false
    }
    Sync-SessionPath
    if (-not (& $Check)) {
        Write-Fail ($Name + ' was installed but is not visible yet. Open a new PowerShell window and run this installer again.')
        return $false
    }
    Write-Ok ($Name + ' installed')
    return $true
}

function Install-Crewly {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer: colored console output is the point, and it must not enter the pipeline.')]
    param()
    Write-Banner

    if (-not (Test-WindowsHost)) {
        Write-Fail 'This installer is for Windows. On macOS and Linux, run:'
        Write-Plain '  curl -fsSL https://crewlyai.com/install.sh | bash'
        return $false
    }
    Write-Ok ('Windows detected (' + $env:PROCESSOR_ARCHITECTURE + ')')
    Write-Host ''

    # ========================= Prerequisites =========================

    $nodeOk = ($null -ne (Get-NodeMajor)) -and ((Get-NodeMajor) -ge $script:MinNodeVersion)
    $gitOk = [bool](Get-GitBashPath)
    $jqOk = Test-JqInstalled
    $needsInstall = -not ($nodeOk -and $gitOk -and $jqOk)
    if ($needsInstall -and -not (Test-WingetInstalled)) {
        if ($nodeOk) { Write-Ok ('Node.js ' + (& node -v) + ' detected') }
        if ($gitOk) { Write-Ok 'Git for Windows detected' }
        if ($jqOk) { Write-Ok 'jq detected' }
        Write-Fail 'Something Crewly needs is missing, and winget is not available to install it.'
        Write-ManualLink
        return $false
    }

    $nodeCheck = {
        $major = Get-NodeMajor
        return (($null -ne $major) -and ($major -ge $script:MinNodeVersion))
    }
    $nodeFound = if ($nodeOk) { 'Node.js ' + (& node -v) + ' detected' } else { '' }
    $nodeMissing = 'Node.js ' + $script:MinNodeVersion + ' or later not found'
    $nodeInstall = {
        Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -Name 'Node.js (LTS)' `
            -AdminNote 'Node.js cannot be installed for your user only here. Windows will now ask for administrator permission; choose Yes to continue.'
    }
    if (-not (Confirm-Prerequisite -Name 'Node.js' -Check $nodeCheck -Found $nodeFound -Missing $nodeMissing -Install $nodeInstall)) { return $false }

    $gitFound = 'Git for Windows detected'
    $gitInstall = {
        Install-WingetPackage -Id 'Git.Git' -Name 'Git for Windows' `
            -AdminNote 'Git for Windows cannot be installed for your user only here. Windows will now ask for administrator permission; choose Yes to continue.'
    }
    if (-not (Confirm-Prerequisite -Name 'Git for Windows' -Check { [bool](Get-GitBashPath) } -Found $gitFound -Missing 'Git for Windows (Git Bash) not found' -Install $gitInstall)) { return $false }

    $jqInstall = {
        Install-WingetPackage -Id 'jqlang.jq' -Name 'jq' -AdminNote ''
    }
    if (-not (Confirm-Prerequisite -Name 'jq' -Check { Test-JqInstalled } -Found 'jq detected' -Missing 'jq not found' -Install $jqInstall)) { return $false }

    Write-Host ''

    # ========================= npm Check =========================

    if (-not (Test-NpmInstalled)) {
        Write-Fail 'npm not found. It should come with Node.js.'
        Write-Plain 'Open a new PowerShell window and run this installer again, or reinstall Node.js from https://nodejs.org'
        return $false
    }

    # ========================= Install Crewly =========================

    Write-Step 'Installing Crewly...'
    if (-not (Invoke-NpmInstallCrewly)) {
        Write-Fail 'Failed to install Crewly.'
        Write-Plain 'Try this and read the message above it:  npm install -g crewly'
        return $false
    }

    $crewlyCmd = Find-CrewlyCommand
    if (-not $crewlyCmd) {
        Write-Fail 'Crewly was installed, but the crewly command was not found.'
        Write-Plain 'Open a new PowerShell window and run:  crewly --version'
        return $false
    }
    $version = Get-CrewlyVersion -Path $crewlyCmd
    Write-Ok ('Crewly ' + $version + ' installed')
    $parsed = $null
    if ([version]::TryParse(($version -replace '[^0-9.].*$', ''), [ref]$parsed) -and $parsed -lt [version]$script:MinCrewlyVersion) {
        Write-Warn ('Windows needs Crewly ' + $script:MinCrewlyVersion + ' or later; this is older. Run this installer again, or: npm install -g crewly@latest')
    }
    Write-Host ''

    Write-Host '  Next: open a new terminal and run:' -ForegroundColor White
    Write-Host ''
    Write-Host '    crewly start' -ForegroundColor Cyan
    Write-Host ''
    return $true
}

# Dot-sourcing this file (a test does) defines the functions and runs nothing.
if ($MyInvocation.InvocationName -ne '.') {
    $installed = Install-Crewly
    # `exit` is safe only when this is a script file; under `irm | iex` it would close the terminal.
    if (-not $installed -and $PSCommandPath) { exit 1 }
}
