# Waits for the user to start `r3.cmd exec <run-id>` (the live send, not --check), holds off Windows sleep for exactly
# as long as that process lives (the old fleet's keep-awake helper, max 3 h), and reports when it ends. Sends nothing.
param([string]$RunId = '2026-10-12T1059Z', [int]$WaitMinutes = 90)

$deadline = (Get-Date).AddMinutes($WaitMinutes)
$p = $null
while (-not $p -and (Get-Date) -lt $deadline) {
  $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match "planner\.cjs`"?\s+exec\s+$RunId" -and $_.CommandLine -notmatch '--check' } |
    Select-Object -First 1
  if (-not $p) { Start-Sleep -Seconds 5 }
}
if (-not $p) { "no live exec process appeared within $WaitMinutes minutes"; exit 2 }
"exec started: pid $($p.ProcessId) at $(Get-Date -Format o)"
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
  '-File', 'C:\Users\12\Desktop\Trading-bot-2\tools\keep-awake.ps1', '-ParentPid', "$($p.ProcessId)", '-MaxHours', '3')
"keep-awake helper attached to pid $($p.ProcessId)"
Wait-Process -Id $p.ProcessId -Timeout 10800 -ErrorAction SilentlyContinue
"exec process ended at $(Get-Date -Format o)"
