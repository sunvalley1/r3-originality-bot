# register-deep-r3-wake.ps1 - registers (or re-registers) the Task Scheduler task deep-r3-wake, which starts
# wake-deep-r3.cmd every day at 11:30 and 21:30 local time, hidden through "conhost --headless" like the SeerBot tasks:
# the operator's own account (Interactive, Limited), waking the machine, a missed slot run once when the machine is
# back, never two at once, a 6h time limit (the same number as wake-deep-r3.cmd's stale-lock test and the setup
# record's schedule.time_limit_hours).
# Pause the bot:  Disable-ScheduledTask -TaskName deep-r3-wake      Resume: Enable-ScheduledTask -TaskName deep-r3-wake
# Remove it:      Unregister-ScheduledTask -TaskName deep-r3-wake -Confirm:$false
param([string[]]$At = @('11:30', '21:30'), [int]$TimeLimitHours = 6)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$wrapper = Join-Path $root 'wake-deep-r3.cmd'
if (-not (Test-Path -LiteralPath $wrapper)) { throw "no wake-deep-r3.cmd in $root" }
$conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
$action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless cmd.exe /d /c `"$wrapper`"" -WorkingDirectory $root
$triggers = @($At | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ })
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours $TimeLimitHours)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'deep-r3-wake' -Description 'deep-r3-trade: Opus 5.5 + GPT-6-Astra research, plan and trades on the 98 Deep Funding Round 3 Originality markets (wake-deep-r3.cmd)' -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
$t = Get-ScheduledTask -TaskName 'deep-r3-wake'
$i = $t | Get-ScheduledTaskInfo
Write-Output ("registered deep-r3-wake: state {0}, runs at {1}, next run {2}" -f $t.State, ($At -join ' and '), $i.NextRunTime)
