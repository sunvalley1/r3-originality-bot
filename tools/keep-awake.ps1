<#
  .SYNOPSIS
  Keeps Windows from sleeping while a cycle runs, and lets go the moment it ends.

  .DESCRIPTION
  A pass takes no keyboard or mouse input, so Windows' idle timer sleeps the laptop underneath it however busy the
  CPU is: on 21 September it slept at 21:48 and killed Fable's Gnosis pass and Astra's Optimism pass mid-run, which
  costs the model's usage as well as the pass. src/cycle.ts starts this helper detached when it is about to run a
  pass, and it holds the system-required request until that process exits - so nothing keeps the machine awake when
  no pass is running. The screen is left alone; only sleep is held off.

  Started by src/cycle.ts, not by hand.
#>
param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [int]$MaxHours = 3
)

Add-Type -Namespace Win32 -Name Power -MemberDefinition '
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);'

$ES_CONTINUOUS = [uint32]0x80000000
$ES_SYSTEM_REQUIRED = [uint32]0x00000001

if ([Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) -eq 0) {
  exit 1
}
try {
  # the task's own limit is three hours, so never outlive it: a helper left holding this would keep the laptop up all night
  Wait-Process -Id $ParentPid -Timeout ($MaxHours * 3600) -ErrorAction SilentlyContinue
} finally {
  [void][Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS)
}
