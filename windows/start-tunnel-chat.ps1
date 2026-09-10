param(
    [Parameter(Mandatory = $true)]
    [string]$Distro,
    [Parameter(Mandatory = $true)]
    [string]$RepoPath,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$stateRoot = Join-Path $env:LOCALAPPDATA 'TunnelChat'
$logPath = Join-Path $stateRoot 'start.log'
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null

if ($Distro -match '["\r\n]' -or $RepoPath -match '["\r\n]') {
    throw 'Distro and RepoPath cannot contain quotes or newlines.'
}

$wsl = Join-Path $env:WINDIR 'System32\wsl.exe'
$savedErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$output = @(& $wsl -d $Distro --cd $RepoPath -- bash -lc './bin/start-all' 2>&1)
$exitCode = $LASTEXITCODE
$ErrorActionPreference = $savedErrorAction

$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
@(
    "[$timestamp] exit=$exitCode"
    $output | ForEach-Object { $_.ToString().TrimEnd() }
) | Where-Object { $_ -ne '' } | Set-Content -LiteralPath $logPath -Encoding UTF8

if ($exitCode -ne 0) {
    if (-not $NoOpen) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show(
            "Tunnel Chat could not start. See the log at:`n$logPath",
            'Tunnel Chat',
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Error
        ) | Out-Null
    }
    exit $exitCode
}

if (-not $NoOpen) {
    $ErrorActionPreference = 'Continue'
    $urlOutput = @(& $wsl -d $Distro --cd $RepoPath -- bash -lc './bin/url codex' 2>$null)
    $urlExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedErrorAction
    $publicUrl = if ($urlOutput.Count -gt 0) { $urlOutput[0].ToString().Trim() } else { '' }
    $parsedUrl = $null
    if ($urlExitCode -ne 0 -or
        -not [Uri]::TryCreate($publicUrl, [UriKind]::Absolute, [ref]$parsedUrl) -or
        $parsedUrl.Scheme -notin @('http', 'https')) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show(
            "Tunnel Chat started, but its browser URL could not be resolved. Run ./bin/url codex in WSL.",
            'Tunnel Chat',
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Warning
        ) | Out-Null
        exit 1
    }
    Start-Process -FilePath $publicUrl
}
