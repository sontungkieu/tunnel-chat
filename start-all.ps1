<#
  start-all.ps1 - mot cu bam: bat DSH web + Cloudflare tunnel + dsh-bridge (transport chunked)

  Chay:  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File start-all.ps1
  Tat:   powershell -NoProfile -ExecutionPolicy Bypass -File start-all.ps1 -Stop
#>
param([switch]$Stop)

$ErrorActionPreference = 'Continue'
$root      = 'D:\dev\dsh'
$bridgeDir = Join-Path $root 'bridge'
$logDir    = Join-Path $root 'logs'
$logFile   = Join-Path $logDir 'start-all.log'
$warn      = New-Object System.Collections.Generic.List[string]

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log([string]$msg) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Test-Port([int]$port) {
  $hit = $null
  try { $hit = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop } catch { $hit = $null }
  if ($hit) { return $true }
  $ns = netstat -ano | Select-String -Pattern (':' + $port + '\s+.*LISTENING')
  return [bool]$ns
}

function Get-PortPid([int]$port) {
  $hit = $null
  try { $hit = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop } catch { $hit = $null }
  if ($hit) { return [int]($hit | Select-Object -First 1).OwningProcess }
  $line = (netstat -ano | Select-String -Pattern (':' + $port + '\s+.*LISTENING') | Select-Object -First 1)
  if ($line) { return [int]((($line.ToString()) -split '\s+')[-1]) }
  return 0
}

if ($Stop) {
  Write-Log '--- stop-all ---'
  foreach ($p in 3080, 3090) {
    $procId = Get-PortPid $p
    if ($procId -gt 0) {
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      Write-Log ('stop: da tat tien trinh cong ' + $p + ' (pid ' + $procId + ')')
    } else {
      Write-Log ('stop: khong co tien trinh tren cong ' + $p)
    }
  }
  Write-Log '--- xong ---'
  return
}

Write-Log '--- start-all ---'

# 1) Cloudflare tunnel (Windows service, StartType Automatic)
$svc = Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue
if ($null -eq $svc) {
  $warn.Add('Khong tim thay service Cloudflared.') | Out-Null
  Write-Log 'cloudflared: KHONG tim thay service'
} elseif ($svc.Status -ne 'Running') {
  try {
    Start-Service -Name 'Cloudflared' -ErrorAction Stop
    Start-Sleep -Seconds 2
    Write-Log 'cloudflared: da bat'
  } catch {
    $warn.Add('Service Cloudflared dang dung va khong tu bat duoc (can quyen Administrator).') | Out-Null
    Write-Log ('cloudflared: loi - ' + $_.Exception.Message)
  }
} else {
  Write-Log 'cloudflared: dang chay'
}

# 2) dsh-bridge (lop dem transport, cong 3090)
if (Test-Port 3090) {
  Write-Log 'bridge: dang chay (3090)'
} else {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
  Write-Log ('bridge: khoi dong bang ' + $node)
  Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $bridgeDir 'dsh-bridge.cjs') + '"') -WorkingDirectory $bridgeDir -WindowStyle Hidden
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 500; if (Test-Port 3090) { $ok = $true; break } }
  if ($ok) { Write-Log 'bridge: da bat (3090)' } else { $warn.Add('dsh-bridge khong bat duoc tren cong 3090.') | Out-Null; Write-Log 'bridge: KHONG bat duoc' }
}

# 3) DSH web (cong 3080)
$dshWasRunning = Test-Port 3080
if ($dshWasRunning) {
  Write-Log 'dsh web: dang chay (3080)'
} else {
  $dsh = (Get-Command dsh.cmd -ErrorAction SilentlyContinue).Source
  if (-not $dsh) { $dsh = (Get-Command dsh -ErrorAction SilentlyContinue).Source }
  if (-not $dsh) {
    # npx cache doi ten moi lan chay -> tim ban moi dung nhat
    $cache = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
    $dir = Get-ChildItem $cache -Directory -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Where-Object { Test-Path (Join-Path $_.FullName 'node_modules\.bin\dsh.cmd') } |
      Select-Object -First 1
    if ($dir) { $dsh = Join-Path $dir.FullName 'node_modules\.bin\dsh.cmd' }
  }
  if (-not $dsh) { $warn.Add('Khong tim thay lenh dsh.cmd tren may.') | Out-Null; Write-Log 'dsh web: KHONG tim thay dsh.cmd' }
  $outLog = Join-Path $logDir 'dsh-web.log'
  $errLog = Join-Path $logDir 'dsh-web.err.log'
  Write-Log ('dsh web: khoi dong bang ' + $dsh)
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $dsh + '" --profile web') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $ok = $false
  for ($i = 0; $i -lt 180; $i++) { Start-Sleep -Milliseconds 500; if (Test-Port 3080) { $ok = $true; break } }
  if ($ok) {
    Write-Log 'dsh web: da bat (3080)'
    Start-Sleep -Seconds 2
  } else {
    $warn.Add('dsh web khong bat duoc tren cong 3080. Xem ' + $outLog) | Out-Null
    Write-Log 'dsh web: KHONG bat duoc'
  }
}

# 4) Neu DSH da chay san thi mo san giao dien cho nguoi dung thay phan hoi
if ($dshWasRunning -and (Test-Port 3080)) {
  Start-Process 'http://127.0.0.1:3080/'
  Write-Log 'mo trinh duyet toi giao dien local'
}

if ($warn.Count -gt 0) {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    [System.Windows.Forms.MessageBox]::Show(($warn -join [Environment]::NewLine), 'DSH + Tunnel', 'OK', 'Warning') | Out-Null
  } catch { }
}

Write-Log '--- xong ---'
