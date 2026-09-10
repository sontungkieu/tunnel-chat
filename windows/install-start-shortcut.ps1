param(
    [string]$Distro = '',
    [string]$RepoPath = ''
)

$ErrorActionPreference = 'Stop'
$repoWindowsPath = Split-Path -Parent $PSScriptRoot
if (-not $RepoPath) {
    if ($repoWindowsPath -notmatch '^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.+)$') {
        throw 'Run this script from a WSL checkout or pass -Distro and -RepoPath explicitly.'
    }
    if (-not $Distro) {
        $Distro = $Matches[1]
    }
    $RepoPath = '/' + ($Matches[2] -replace '\\', '/')
}
if (-not $Distro) {
    $Distro = 'Ubuntu'
}
if ($Distro -match '["\r\n]' -or $RepoPath -match '["\r\n]') {
    throw 'Distro and RepoPath cannot contain quotes or newlines.'
}

$stateRoot = Join-Path $env:LOCALAPPDATA 'TunnelChat'
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$installedLauncher = Join-Path $stateRoot 'start-tunnel-chat.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-tunnel-chat.ps1') -Destination $installedLauncher -Force

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Tunnel Chat - Start All.lnk'
$powershell = Join-Path $PSHOME 'powershell.exe'
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Distro "{1}" -RepoPath "{2}"' -f $installedLauncher, $Distro, $RepoPath

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershell
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $stateRoot
$shortcut.IconLocation = "$env:WINDIR\System32\shell32.dll,220"
$shortcut.Description = 'Start ChatGPT web, Codex bridge, and Cloudflare tunnel'
$shortcut.WindowStyle = 7
$shortcut.Save()

Write-Output $shortcutPath
