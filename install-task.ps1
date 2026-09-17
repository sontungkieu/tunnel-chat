# Dang ky dsh-bridge chay cung Windows (Task Scheduler, chay khi dang nhap).
# Chay:  powershell -ExecutionPolicy Bypass -File install-task.ps1
# Go bo: powershell -ExecutionPolicy Bypass -File install-task.ps1 -Remove
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$taskName = 'dsh-bridge'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host 'Da go task dsh-bridge.'
  return
}
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $dir 'dsh-bridge.cjs') + '"') -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'dsh-bridge: WebSocket + polling transport cho DSH web' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State | Format-List
Write-Host 'Xong. Bridge se tu chay moi khi dang nhap.'