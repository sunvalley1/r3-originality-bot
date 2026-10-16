# research/research.ps1 - the price-blind research of one deep-r3-trade run-id, run by the planner's d step in
# research mode (planner.config.json researchPath). It prepares the blind inputs (prep.cjs), runs one fresh Codex
# worker per part in parallel (live web search, workspace-write sandbox with no shell network, the user's Codex config
# and plugins ignored; retried in a fresh session if it ends without its file), keeps their logs in
# run/<run-id>/research/ and merges the parts (merge.cjs) into
# run/<run-id>/research-forecast.json. Exit 0 only when that file is written; anything else exits 1 and the run makes
# no new entry. It signs and sends nothing.
param(
  [Parameter(Mandatory = $true)][string]$ProjectRoot,
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [string]$Model = 'gpt-6-astra',
  [string]$Effort = 'xhigh',
  [int]$Parts = 7,
  [int]$WorkerTimeoutMinutes = 60,
  [int]$MaxAttempts = 3
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$runDir = Join-Path $ProjectRoot ('run\' + $RunId)
$log = Join-Path $runDir 'research.log'
function Log([string]$m) {
  $line = '[' + (Get-Date).ToUniversalTime().ToString('o') + '] ' + $m
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  [Console]::Out.WriteLine($line)
}
try {
  foreach ($f in @('candidates.json', 'onchain-state.blind.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $runDir $f))) { throw "no $f in $runDir" }
  }
  # the Codex CLI bundled with the Codex app (newest version folder), as the SeerBot bots' scripts\codex-app.cmd finds it
  $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  $codex = Get-ChildItem -LiteralPath $binRoot -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending |
    ForEach-Object { Join-Path $_.FullName 'codex.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $codex) { throw "no codex.exe under $binRoot (install or update the Codex app)" }
  # the workers' folders live outside the project, so nothing priced is beside them, and under %TEMP%: Codex's Windows
  # sandbox (unelevated) refuses to run commands when the workdir and %TEMP% are separate writable roots
  $work = Join-Path $env:TEMP ('deep-r3-research\' + $RunId + '-' + (Get-Date).ToUniversalTime().ToString('HHmmss'))
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  Log "research for run $RunId with $Model ($Effort), up to $Parts workers, $WorkerTimeoutMinutes min limit; codex $codex; work folder $work"

  & $NodeExe (Join-Path $here 'prep.cjs') $ProjectRoot $RunId $here $work $Parts
  if ($LASTEXITCODE -ne 0) { throw "prep.cjs failed (exit $LASTEXITCODE)" }
  $partDirs = @(Get-ChildItem -LiteralPath $work -Directory | Where-Object { $_.Name -match '^part-\d+$' } | Sort-Object { [int]($_.Name -replace 'part-', '') })
  if ($partDirs.Count -eq 0) { throw 'prep.cjs made no part folder' }

  $empty = Join-Path $work 'empty-stdin.txt'
  Set-Content -LiteralPath $empty -Value '' -NoNewline
  # one fresh session per attempt; attempt n logs to codex.out[.try<n>].log and codex.err[.try<n>].log
  function Start-Worker($d, [int]$attempt) {
    $suffix = if ($attempt -gt 1) { '.try' + $attempt } else { '' }
    $argLine = "--search exec -m $Model -c model_reasoning_effort=$Effort --ignore-user-config -c windows.sandbox=unelevated --disable multi_agent -s workspace-write -C `"$($d.FullName)`" --skip-git-repo-check --color never -o `"$($d.FullName)\final-message$suffix.txt`" `"Read TASK.md in the current folder and follow it exactly.`""
    $p = Start-Process -FilePath $codex -ArgumentList $argLine -NoNewWindow -PassThru -RedirectStandardInput $empty `
      -RedirectStandardOutput (Join-Path $d.FullName ('codex.out' + $suffix + '.log')) -RedirectStandardError (Join-Path $d.FullName ('codex.err' + $suffix + '.log'))
    $null = $p.Handle
    return $p
  }
  # started 10 s apart (seven at once drew 429 Too Many Requests); a worker that ends without its part file is retried
  # in a fresh session after 90 s, up to $MaxAttempts attempts, within the time limit
  $deadline = (Get-Date).AddMinutes($WorkerTimeoutMinutes)
  $workers = @()
  foreach ($d in $partDirs) {
    $workers += [pscustomobject]@{ name = $d.Name; dir = $d; file = (Join-Path $d.FullName ($d.Name + '.json')); proc = (Start-Worker $d 1); attempts = 1; retryAt = $null }
    Start-Sleep -Seconds 10
  }
  Log ('started ' + $workers.Count + ' workers')
  while ((Get-Date) -lt $deadline) {
    $open = 0
    foreach ($w in $workers) {
      if ($w.proc -and -not $w.proc.HasExited) { $open++; continue }
      if (Test-Path -LiteralPath $w.file) { continue }
      if ($w.attempts -ge $MaxAttempts) { continue }
      if (-not $w.retryAt) { $w.retryAt = (Get-Date).AddSeconds(90); Log ($w.name + ' ended without its file (attempt ' + $w.attempts + ', exit ' + $w.proc.ExitCode + '); retrying in 90 s'); $open++; continue }
      if ((Get-Date) -ge $w.retryAt) { $w.attempts++; $w.retryAt = $null; $w.proc = Start-Worker $w.dir $w.attempts; Log ($w.name + ' attempt ' + $w.attempts + ' started') }
      $open++
    }
    if ($open -eq 0) { break }
    Start-Sleep -Seconds 15
  }
  foreach ($w in $workers) {
    if ($w.proc -and -not $w.proc.HasExited) { Log ($w.name + ' passed the time limit; stopped'); Stop-Process -Id $w.proc.Id -Force -ErrorAction SilentlyContinue }
    Log ($w.name + ': ' + $(if (Test-Path -LiteralPath $w.file) { 'part file written' } else { 'no part file' }) + ' after ' + $w.attempts + ' attempt(s)')
  }

  # the workers' logs stay with the run
  $keep = Join-Path $runDir 'research'
  New-Item -ItemType Directory -Path $keep -Force | Out-Null
  foreach ($d in $partDirs) {
    Get-ChildItem -LiteralPath $d.FullName -File | Where-Object { $_.Name -like 'codex.*.log' -or $_.Name -like 'final-message*.txt' } |
      ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $keep ($d.Name + '.' + $_.Name)) -Force }
  }

  & $NodeExe (Join-Path $here 'merge.cjs') $ProjectRoot $RunId $work $Model $Effort
  if ($LASTEXITCODE -ne 0) { throw "merge.cjs refused the workers' output (exit $LASTEXITCODE)" }
  Log 'research-forecast.json written'
  exit 0
} catch {
  try { Log ('FAILED: ' + $_.Exception.Message) } catch { }
  [Console]::Error.WriteLine('research failed: ' + $_.Exception.Message)
  exit 1
}
