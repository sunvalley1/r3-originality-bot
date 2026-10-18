# research/research.ps1 - the price-blind research of one deep-r3-trade run-id, run by the planner's d step in
# research mode (planner.config.json researchPath). One model researches each run, chosen by the R3_RESEARCH_MODEL
# environment variable; the scheduled wrapper runs <slot>-1-opus first and <slot>-2-astra next, and each run trades on its
# own model's forecast from the same wallet:
#   opus  - Claude Opus 5.5 through Claude Code in print mode, restricted: no shell, file tools confined to the worker
#           folder, market, exchange and explorer sites blocked for WebFetch, no user settings, CLAUDE.md, plugins,
#           hooks or MCP servers. Brief: TASK.claude.template.md.
#   astra - GPT-6-Astra through the Codex CLI bundled with the Codex app: live web search, workspace-write sandbox with
#           no shell network, the user's Codex config and plugins ignored. Brief: TASK.template.md. The default when
#           R3_RESEARCH_MODEL is unset.
# It prepares the blind inputs (prep.cjs), runs one fresh worker per part in parallel (retried in a fresh session if
# it ends without its file), keeps their logs in run/<run-id>/research/ and merges the parts (merge.cjs) into
# run/<run-id>/research-forecast.json. Exit 0 only when that file is written; anything else exits 1 and the run makes
# no new entry. It signs and sends nothing.
param(
  [Parameter(Mandatory = $true)][string]$ProjectRoot,
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [string]$Which = $(if ($env:R3_RESEARCH_MODEL) { $env:R3_RESEARCH_MODEL } else { 'astra' }),
  [string]$ClaudeModel = 'claude-opus-5-5',
  [string]$ClaudeEffort = 'max',
  [int]$ClaudeWorkerTimeoutMinutes = 150,
  [int]$ClaudeMaxAttempts = 2,
  [string]$Model = 'gpt-6-astra',
  [string]$Effort = 'xhigh',
  [int]$WorkerTimeoutMinutes = 60,
  [int]$MaxAttempts = 3,
  [int]$Parts = 7
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
# sites the Claude workers' WebFetch refuses: Seer and the DEXs, explorers and dashboards that show these markets'
# prices. TASK.md forbids them to both models; the Codex workers have only that instruction.
$blockedSites = @('seer.pm', 'app.seer.pm', 'deep.seer.pm', 'swapr.eth.limo', 'v2.swapr.eth.limo', 'uniswap.org',
  'app.uniswap.org', 'info.uniswap.org', 'etherscan.io', 'optimistic.etherscan.io', 'optimism.blockscout.com',
  'explorer.optimism.io', 'dexscreener.com', 'www.dexscreener.com', 'geckoterminal.com', 'www.geckoterminal.com',
  'coingecko.com', 'www.coingecko.com', 'defillama.com', 'polymarket.com', 'dune.com')
try {
  foreach ($f in @('candidates.json', 'onchain-state.blind.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $runDir $f))) { throw "no $f in $runDir" }
  }
  $Which = $Which.ToLowerInvariant()
  if ($Which -eq 'opus') {
    $tool = 'claude'; $label = $ClaudeModel; $effortUsed = $ClaudeEffort; $template = 'TASK.claude.template.md'
    $timeout = $ClaudeWorkerTimeoutMinutes; $attemptsMax = $ClaudeMaxAttempts
    # Claude Code's native binary, the file the npm install's claude.cmd starts
    $exe = Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "no claude.exe at $exe (install Claude Code with npm and sign in with claude auth login)" }
  } elseif ($Which -eq 'astra') {
    $tool = 'codex'; $label = $Model; $effortUsed = $Effort; $template = 'TASK.template.md'
    $timeout = $WorkerTimeoutMinutes; $attemptsMax = $MaxAttempts
    # the Codex CLI bundled with the Codex app (newest version folder), as the SeerBot bots' scripts\codex-app.cmd finds it
    $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    $exe = Get-ChildItem -LiteralPath $binRoot -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending |
      ForEach-Object { Join-Path $_.FullName 'codex.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $exe) { throw "no codex.exe under $binRoot (install or update the Codex app)" }
  } else {
    throw "R3_RESEARCH_MODEL is '$Which'; it must be opus or astra"
  }
  # the workers' folders live outside the project, so nothing priced is beside them, and under %TEMP%: Codex's Windows
  # sandbox (unelevated) refuses to run commands when the workdir and %TEMP% are separate writable roots
  $work = Join-Path $env:TEMP ('deep-r3-research\' + $RunId + '-' + (Get-Date).ToUniversalTime().ToString('HHmmss'))
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  Log "research for run ${RunId}: $Which, $label ($effortUsed), up to $Parts workers, $timeout min limit; $tool $exe; work folder $work"

  & $NodeExe (Join-Path $here 'prep.cjs') $ProjectRoot $RunId $here $work $Parts $template
  if ($LASTEXITCODE -ne 0) { throw "prep.cjs failed (exit $LASTEXITCODE)" }
  $partDirs = @(Get-ChildItem -LiteralPath $work -Directory | Where-Object { $_.Name -match '^part-\d+$' } | Sort-Object { [int]($_.Name -replace 'part-', '') })
  if ($partDirs.Count -eq 0) { throw 'prep.cjs made no part folder' }

  $empty = Join-Path $work 'empty-stdin.txt'
  Set-Content -LiteralPath $empty -Value '' -NoNewline
  $prompt = 'Read TASK.md in the current folder and follow it exactly.'
  $denied = ($blockedSites | ForEach-Object { '"WebFetch(domain:' + $_ + ')"' }) -join ' '
  # one fresh session per attempt; attempt n logs to <tool>.out[.try<n>].log and <tool>.err[.try<n>].log
  function Start-Worker($d, [int]$attempt) {
    $suffix = if ($attempt -gt 1) { '.try' + $attempt } else { '' }
    $out = Join-Path $d.FullName ($tool + '.out' + $suffix + '.log')
    $err = Join-Path $d.FullName ($tool + '.err' + $suffix + '.log')
    if ($tool -eq 'claude') {
      $argLine = "-p `"$prompt`" --model $ClaudeModel --effort $ClaudeEffort --restricted --safe-mode --strict-mcp-config --tools Read,Write,Edit,Glob,Grep,WebSearch,WebFetch --allowedTools WebSearch,WebFetch --disallowedTools $denied --permission-mode acceptEdits --permission-prompts none --no-session-persistence --output-format json"
      $p = Start-Process -FilePath $exe -ArgumentList $argLine -WorkingDirectory $d.FullName -NoNewWindow -PassThru -RedirectStandardInput $empty -RedirectStandardOutput $out -RedirectStandardError $err
    } else {
      $argLine = "--search exec -m $Model -c model_reasoning_effort=$Effort --ignore-user-config -c windows.sandbox=unelevated --disable multi_agent -s workspace-write -C `"$($d.FullName)`" --skip-git-repo-check --color never -o `"$($d.FullName)\final-message$suffix.txt`" `"$prompt`""
      $p = Start-Process -FilePath $exe -ArgumentList $argLine -NoNewWindow -PassThru -RedirectStandardInput $empty -RedirectStandardOutput $out -RedirectStandardError $err
    }
    $null = $p.Handle
    return $p
  }
  # started 10 s apart (seven Codex sessions at once drew 429 Too Many Requests); a worker that ends without its part
  # file is retried in a fresh session after 90 s, up to $attemptsMax attempts, within the time limit
  $deadline = (Get-Date).AddMinutes($timeout)
  $workers = @()
  foreach ($d in $partDirs) {
    $workers += [pscustomobject]@{ name = $d.Name; dir = $d; file = (Join-Path $d.FullName ($d.Name + '.json')); proc = (Start-Worker $d 1); attempts = 1; retryAt = $null }
    Start-Sleep -Seconds 10
  }
  Log ('started ' + $workers.Count + ' ' + $label + ' workers')
  while ((Get-Date) -lt $deadline) {
    $open = 0
    foreach ($w in $workers) {
      if ($w.proc -and -not $w.proc.HasExited) { $open++; continue }
      if (Test-Path -LiteralPath $w.file) { continue }
      if ($w.attempts -ge $attemptsMax) { continue }
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
    Get-ChildItem -LiteralPath $d.FullName -File | Where-Object { $_.Name -like ($tool + '.*.log') -or $_.Name -like 'final-message*.txt' } |
      ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $keep ($d.Name + '.' + $_.Name)) -Force }
  }

  & $NodeExe (Join-Path $here 'merge.cjs') $ProjectRoot $RunId $work $label $effortUsed $tool
  if ($LASTEXITCODE -ne 0) { throw "merge.cjs refused the workers' output (exit $LASTEXITCODE)" }
  Log 'research-forecast.json written'
  exit 0
} catch {
  try { Log ('FAILED: ' + $_.Exception.Message) } catch { }
  [Console]::Error.WriteLine('research failed: ' + $_.Exception.Message)
  exit 1
}
