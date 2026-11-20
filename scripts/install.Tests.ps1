# Pester 5 tests for scripts/install.ps1: the check-and-skip logic, the winget
# fallbacks and the stop messages. Nothing here installs anything: every probe
# and every winget/npm call is mocked.
#
#   Invoke-Pester scripts/install.Tests.ps1

BeforeAll {
    . (Join-Path $PSScriptRoot 'install.ps1')

    # Run the installer with everything it calls mocked; return what it printed and returned.
    function Invoke-Installer {
        $info = Install-Crewly 6>&1
        $ok = $info | Where-Object { $_ -is [bool] } | Select-Object -Last 1
        $text = ($info | Where-Object { $_ -isnot [bool] } | ForEach-Object { "$_" }) -join "`n"
        return [pscustomobject]@{ Ok = $ok; Text = $text }
    }
}

Describe 'install.ps1' {
    BeforeEach {
        Mock Test-WindowsHost { $true }
        Mock Get-NodeMajor { 22 }
        Mock Get-GitBashPath { 'C:\Program Files\Git\bin\bash.exe' }
        Mock Test-JqInstalled { $true }
        Mock Test-WingetInstalled { $true }
        Mock Invoke-Winget { $true }
        Mock Sync-SessionPath { }
        Mock Find-CrewlyCommand { 'C:\npm\crewly.cmd' }
        Mock Get-CrewlyVersion { '1.39.1' }
        Mock Get-Command { [pscustomobject]@{ Source = 'C:\npm\npm.cmd' } } -ParameterFilter { $Name -eq 'npm' }
        Mock npm { $global:LASTEXITCODE = 0 }
    }

    Context 'everything is already installed' {
        It 'reports each prerequisite as found, installs nothing and installs Crewly' {
            $r = Invoke-Installer
            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-Winget -Times 0 -Exactly
            Should -Invoke npm -Times 1 -Exactly
            $r.Text | Should -Match 'Node.js .*detected'
            $r.Text | Should -Match 'Git for Windows detected'
            $r.Text | Should -Match 'jq detected'
            $r.Text | Should -Match 'Crewly 1.39.1 installed'
        }

        It 'ends by telling the user to open a new terminal and run crewly start' {
            $r = Invoke-Installer
            $r.Text | Should -Match 'open a new terminal and run'
            $r.Text | Should -Match 'crewly start'
        }

        It 'does not need winget at all' {
            Mock Test-WingetInstalled { $false }
            $r = Invoke-Installer
            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-Winget -Times 0 -Exactly
        }
    }

    Context 'a prerequisite is missing' {
        It 'installs Node.js with winget for the user first' {
            $script:nodeInstalled = $false
            Mock Get-NodeMajor { if ($script:nodeInstalled) { 22 } else { $null } }
            Mock Invoke-Winget { $script:nodeInstalled = $true; $true }
            $r = Invoke-Installer
            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-Winget -Times 1 -Exactly -ParameterFilter {
                ($WingetArgs -contains 'OpenJS.NodeJS.LTS') -and ($WingetArgs -contains '--scope') -and ($WingetArgs -contains 'user')
            }
            $r.Text | Should -Match 'Node.js installed'
        }

        It 'treats a Node.js older than 22 as missing' {
            $script:nodeInstalled = $false
            Mock Get-NodeMajor { if ($script:nodeInstalled) { 22 } else { 20 } }
            Mock Invoke-Winget { $script:nodeInstalled = $true; $true }
            $r = Invoke-Installer
            $r.Text | Should -Match 'Node.js 22 or later not found'
            Should -Invoke Invoke-Winget -Times 1 -Exactly
        }

        It 'says plainly that Windows will ask for administrator permission before the machine-wide retry' {
            $script:calls = 0
            $script:gitInstalled = $false
            Mock Get-GitBashPath { if ($script:gitInstalled) { 'C:\Program Files\Git\bin\bash.exe' } else { $null } }
            Mock Invoke-Winget {
                $script:calls++
                if ($script:calls -eq 1) { return $false }
                $script:gitInstalled = $true
                return $true
            }
            $r = Invoke-Installer
            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-Winget -Times 2 -Exactly
            Should -Invoke Invoke-Winget -Times 1 -Exactly -ParameterFilter { $WingetArgs -notcontains '--scope' }
            $r.Text | Should -Match 'administrator permission'
        }

        It 'installs jq with no administrator note' {
            $script:jqInstalled = $false
            Mock Test-JqInstalled { $script:jqInstalled }
            Mock Invoke-Winget { $script:jqInstalled = $true; $true }
            $r = Invoke-Installer
            $r.Ok | Should -BeTrue
            Should -Invoke Invoke-Winget -Times 1 -Exactly -ParameterFilter { $WingetArgs -contains 'jqlang.jq' }
            $r.Text | Should -Not -Match 'administrator'
        }

        It 'stops with the download links when winget is missing' {
            Mock Test-JqInstalled { $false }
            Mock Test-WingetInstalled { $false }
            $r = Invoke-Installer
            $r.Ok | Should -BeFalse
            Should -Invoke npm -Times 0 -Exactly
            $r.Text | Should -Match 'winget'
            $r.Text | Should -Match 'https://nodejs.org'
            $r.Text | Should -Match 'https://gitforwindows.org'
            $r.Text | Should -Match 'https://jqlang.org/download/'
        }

        It 'stops when an install fails, and does not install Crewly' {
            Mock Test-JqInstalled { $false }
            Mock Invoke-Winget { $false }
            $r = Invoke-Installer
            $r.Ok | Should -BeFalse
            Should -Invoke npm -Times 0 -Exactly
            $r.Text | Should -Match 'jq could not be installed'
        }

        It 'stops when a program was installed but is still not visible' {
            Mock Test-JqInstalled { $false }
            $r = Invoke-Installer
            $r.Ok | Should -BeFalse
            $r.Text | Should -Match 'not visible yet'
        }
    }

    Context 'installing Crewly' {
        It 'stops when npm install fails' {
            Mock npm { $global:LASTEXITCODE = 1 }
            $r = Invoke-Installer
            $r.Ok | Should -BeFalse
            $r.Text | Should -Match 'Failed to install Crewly'
        }

        It 'stops when the crewly command cannot be found afterwards' {
            Mock Find-CrewlyCommand { $null }
            $r = Invoke-Installer
            $r.Ok | Should -BeFalse
            $r.Text | Should -Match 'crewly command was not found'
        }

        It 'warns when the installed version is below the Windows minimum' {
            Mock Get-CrewlyVersion { '1.38.0' }
            $r = Invoke-Installer
            $r.Text | Should -Match 'needs Crewly 1.39.1 or later'
        }
    }

    Context 'not Windows' {
        It 'points to the shell installer and installs nothing' {
            Mock Test-WindowsHost { $false }
            $r = Invoke-Installer
            $r.Ok | Should -BeFalse
            Should -Invoke npm -Times 0 -Exactly
            $r.Text | Should -Match 'install.sh'
        }
    }
}

Describe 'install.ps1 as a file' {
    It 'is ASCII only (Windows PowerShell 5.1 reads a file without a byte order mark in the legacy code page)' {
        $bytes = [System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'install.ps1'))
        $bytes.Count | Should -BeGreaterThan 0
        ($bytes | Where-Object { $_ -gt 127 }).Count | Should -Be 0
    }

    It 'never calls exit outside the script-file guard (it would close the terminal under irm | iex)' {
        $lines = Get-Content (Join-Path $PSScriptRoot 'install.ps1')
        $exits = @($lines | Where-Object { $_ -match '^\s*[^#\s].*\bexit\b' })
        $exits.Count | Should -Be 1
        $exits[0] | Should -Match 'PSCommandPath'
    }

    It 'defines its functions without running the installer when dot-sourced' {
        (Get-Command Install-Crewly -ErrorAction SilentlyContinue) | Should -Not -BeNullOrEmpty
    }
}
