# planner: the executable form of steps C to H for `deep-r3-trade`

The scheduled (autonomous) run has no `node -e` (`steps/I-setup.md` I.2 section 7), and the work of a run does not fit a
model's hand inside one session's turns: on the first live run F alone made 354 helper calls and 782 quotes, and G encoded and
checked 278 transactions. The planner is a reviewed, hash-pinned tool, like the chain helper and the signer, that does
that computation; the model drives it and reads its one-line summaries. **The skill text stays the authority**: each
subcommand performs one step the skill defines, in the skill's order and with its stop rules. Its modules are ported
from the scripts that built and sent the first live run on Optimism mainnet (278 transactions in 74 groups, every
group's balance effects equal to the plan); the math is theirs, parameterized, not rewritten.

It ships in the skill's `scripts/` folder; the operator **reads it in full and installs a copy** (section 2), or a
routine's `node r3.cjs install` lays the copy down from the repository, at the commit the routine's prompt pins, and
reports whether it matches the setup record's path and hash. `r3.cjs trade` refuses (exit 4) unless the record pins
exactly this install's planner and signer and the installed `planner.config.json` names that signer and helper, and
it runs this install's planner, never a path from a record. The agent does not edit it. "The wrapper" below is the scheduled run's driver: `node r3.cjs trade` (`routine.cjs`), which takes
the arm lock with `owner.txt` stage `claude-p` and runs `wake` once (`steps/I-setup.md` I.2 §7).

| File | What it is |
|---|---|
| `planner.cjs` | the entry: parses `<subcommand> <run-id> [flags]`, loads the config, runs one step, prints one JSON line |
| `planner/lib.cjs` | the pinned config, the inside-project refusal, path confinement, the helper and signer runners (pacing, transient re-runs), the summary, the arm lock |
| `planner/table.cjs` | the fixed scope: the 98 rows and three bundle headers of `steps/C-select.md` "The fixed 98", the contract addresses, the parent's and middles' condition ids (the test compares it with the skill text) |
| `planner/c.cjs` | `c`: C-select |
| `planner/blind.cjs` | `blind`: the price-free Reality.eth state of each tradeable question that the AI research's workers read |
| `planner/d.cjs` | `d`: D-forecast, by the configured method: the stored CSV (`csv`), a forecast file (`forecast-file`), or a supervised `--supply` |
| `planner/e.cjs` | `e`: E-no-reconcile (the identity blend) |
| `planner/f.cjs`, `f-read.cjs`, `f-engine.cjs`, `f-plan.cjs`, `f-probe-post3a.cjs`, `f-verify.cjs`, `f-print.cjs`, `f-lib.cjs` | `f`: F-max-ev (read, plan, probe, verify, print; the exact single-range Uniswap v3 math) |
| `planner/g.cjs`, `g-read.cjs`, `g-build.cjs`, `g-verify.cjs`, `g-emit.cjs`, `g-audit.cjs`, `g-indep.cjs`, `g-lib.cjs` | `g`: G's build (read with drift report, build, verify, emit, audit) |
| `planner/exec.cjs`, `planner/exec-core.cjs` | `exec`: G section 8's sequential executor and its recovery rule (step 4; the wake's repair applies it too); `exec-core` is the one sending path (also used by Half B, the ramp and the recovery) |
| `planner/halfb.cjs` | `halfb`: Half B (merges and redeems at every level) |
| `planner/h.cjs` | `h`: H-no-learn |
| `planner/report.cjs` | `report`: `report.md` (and `wake-status.json` inside a wake) |
| `planner/wake.cjs` | `wake`: the whole scheduled run in one call |
| `planner/ramp.cjs` | the wake's PSM3 ramp of any USDC and USDS, between `e` and `f` (not a subcommand of its own) |
| `planner.config.example.json` | the config template (refused until its placeholders are replaced) |
| `planner.test.cjs` | offline tests on a synthetic chain, and an optional live read-only smoke (section 7) |
| `planner.README.md` | this file |

## 1. What it guarantees, and where each guarantee lives

- **No key access, ever.** It never signs, never holds or reads a key, keystore, password or wallet file, and never
  contacts an RPC: no socket module, no `fetch`, no key-handling code (the test scans every file for it). Every chain
  read goes through the chain helper (`multicall`, `simulate`, `encode`, `keccak256`, `nonce`, `receipt`, `block`,
  `balance`, `fee-history`, `chain-id`, `data`, `data-rows`); every send goes through the signer's `send`, after the
  signer's own `simulate`; G runs only the signer's policy-only `check`. The signer's supervised entry points (`info`,
  `reconcile`, `clear-nonce`, `sweep-*`, `allowlist-init`) are refused before any process starts (`lib.runSigner`).
- **The config is pinned next to `planner.cjs`** (`planner.config.json`, found from `__filename`), never from `argv` or
  an environment variable. A missing, unparsable, symlinked, oversized or unexpected config fails closed (exit 2).
- **It refuses to run from inside the project folder** (its own folder, or the helper or the signer inside the project),
  and when the current folder is not the configured `projectRoot`.
- **Writes are confined**, relative to the project root, with no `..`, no absolute path, no colon, no reserved device
  name and no symlink or junction anywhere on the way: `./run/<run-id>/` of the invocation; `./run/csv/` only on the
  supervised `d <run-id> --supply <csv> --continue`; the arm lock `./run/.lock.deep-r3-trade/` (taken and released by a
  supervised send batch, used and never released inside the wrapper); and the folders of this arm's earlier run-ids, for
  what the skill writes there (Half B rows and write-ahead records, cross-run `consumed` and side `Invalid` rows, the
  start-of-run repair's appended `fills.json` rows, its `exec-sends.json` and `exec-state.json` entries and its
  `wake-status.json`, and the repair's recovery sends: their write-ahead records, rows, `recovery.json`, `recovery-tx/`
  and `recovery-tmp/`); in any of them the settlement scan's cursor `settle-scan.json` (section 6).
- **Output contract.** Every invocation prints exactly ONE JSON line on stdout, never more than 20,000 characters (a
  longer summary is replaced by a small form with `"truncated": true`); long detail goes to
  `./run/<run-id>/planner/<subcommand>.json`, which also records the helper and signer calls the step made.
- **Reads no environment variable** to change its behaviour; it passes its environment through to the helper and the
  signer unchanged (the signer's own tripwire may name a variable to drop for its read-only calls, signer README section 9).

## 2. Install (operator, once)

1. Pick a folder **outside the project folder** and outside every `Write` or `Edit` path a run grants, for example
   `~/r3-tools/planner/` (`%USERPROFILE%\r3-tools\planner\` on Windows).
2. Copy `planner.cjs` and the whole `planner/` folder into it (keep the layout: `planner.cjs` next to `planner/`). Copy
   `planner.config.example.json` next to it as **`planner.config.json`** and fill it in (section 3).
3. Make `ethers` 6.17.0 resolvable from that folder: `cd <folder>`, then `npm init -y`, then
   `npm install ethers@6.17.0 --save-exact`, one command at a time (the same in every shell). The planner refuses an
   `ethers` that resolves inside the project or is another version. (`c`, `d` and `e` do not load it.)
4. Record the sha256 of `planner.cjs` **and of every `planner/*.cjs`** (all of them load) with the chain helper's and
   the signer's hashes in the setup record (`steps/I-setup.md` I.1 section 7), and compare them with section 9:
   - Windows: `certutil -hashfile <file> SHA256`, or PowerShell `Get-FileHash -Algorithm SHA256 <file>`
   - macOS: `shasum -a 256 <file>`
   - Linux: `sha256sum <file>`
5. In a routine, `node r3.cjs install` writes it fresh at every run from the pinned commit, not read-only, with
   `ethers` 6.17.0 from the npm registry (`steps/I-setup.md` I.1 section 7, *The hash pins one file*).
6. Run it from the **project root**: `node <planner path> <subcommand> <run-id> [flags]`. Every `./run/...` path is
   relative to the current folder, and the planner refuses any other current folder.
7. Smoke test: the live read-only smoke of section 7 runs `c`, `d`, `e` and `f` through the installed helper and never
   runs the signer.

## 3. `planner.config.json`

| Key | Required | Meaning |
|---|---|---|
| `helperPath` | yes | absolute path of the installed `chain-helper.cjs`, a regular file outside the project. The holder is the `signerAddress` of the helper's own `chain-helper.config.json` next to it (a public address; the planner has no holder key of its own) |
| `signerPath` | yes | absolute path of the installed `signer.cjs`, a regular file outside the project. `exec` refuses a plan whose recorded signer sha256 differs from this file's |
| `projectRoot` | yes | absolute path of the project folder the wake runs in; the current folder must be this folder |
| `rpcGapMs` | no | the spacing between two helper or signer starts, 0 to 60000 ms, default 120 |
| `parallel` | no | how many helper or signer processes may run at once, 1 to 8, default 1 (sequential) |
| `forecastMethod` | no | D's method (`steps/D-forecast.md`): `csv`, the default, reads the stored CSV; `forecast-file` reads a forecast file that any source wrote (`ai` is its first name and still works) |
| `forecastMaxAgeHours` | no | under `forecast-file`, how old the newest forecast file under `./run/` may be, 1 to 72 hours, default 12 |

Any other key is an error, and so is the example file as shipped (its placeholders are not absolute paths).

## 4. The subcommands, with their exact output

Common fields of every summary: `subcommand`, `run_id`, `ok`, `exit`, `stop` (null, or `{step, cause, status, notes}`
where `status` is the `wake-status.json` value the stop implies, or null for a supervised refusal), and `detail` (the
path of the detail file, or null when the step must leave the run folder untouched). The examples below are real
outputs, with the run-id replaced by `<run-id>`: `c`, `d`, `e` and `f` from the live read-only smoke on Optimism
mainnet (section 9), the others from the offline test's synthetic chain (section 7).

A failure prints the same line with `ok: false`: a usage or config error carries `error` and `code`
(`{"subcommand":"c","run_id":"<run-id>","exit":2,"ok":false,"error":"config file not found next to planner.cjs (planner.config.json)","code":"config_missing"}`),
a stop carries `stop` and the fields the step adds:

```json
{"subcommand":"d","run_id":"<run-id>","exit":3,"ok":false,"stop":{"step":"D","cause":"no-csv","status":"no-csv","notes":"D step 2: no CSV has ever been provided (./run/csv/current.json does not exist and ./run/csv/ holds no originality-v*.csv); no base-forecast.json written. A human supplies version 1 in a supervised session."},"detail":"run/<run-id>/planner/d.json"}
```

### `c <run-id>`: C-select

Step 1 (the helper's `data`, the stop test first, the body read through `data-rows` pages), step 2 (shape, checks 2.1 to
2.6, check 2.7 as one multicall of the 294 `wrappedOutcome` reads, the pool gate 2.8 on all 196 pools), step 4 (the
boundary reads in two rounds, the block timestamp in the same multicall as `getFinalizeTS`), steps 5 to 7. Writes
`candidates.json`, the raw body `r3-data.json` and its reads files `reads*.json`. A body that is refused (non-200, an
error field, a malformed shape, a 2.7 or 2.8 failure, no HTTP response) takes the onchain rebuild: `source` is
`"onchain-rebuild"` and `body_refused` says why. A used run-id is refused (`run-id-used`). Stops: `upstream-set-changed`,
`identity-check-failed` (2.1 to 2.6), `onchain-reads-failed`, `boundary-read-failed`, `table-stale-onchain`,
`pool-identity-failed`, `self-check-failed`; a transport failure after 5 re-runs is `rpc_unreachable`, exit 5.

```json
{"subcommand":"c","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"source":"body","body_refused":null,"candidates":98,"tradeable":98,"not_tradeable":0,"bundle_split":"33 / 33 / 32","reason_counts":{"body_not_open":0,"pool_null":0,"liq_zero":0,"payoutReported":0,"pending":0,"decided_unreported":0,"middle_settled":0,"future_finalize":0},"not_tradeable_rows":[],"freshness":"196/196 exact","diagnostics_failed":[],"block_timestamp":1791294003,"multicall_blocks":{"reads.json":157847606,"reads-p1.json":157847607,"reads-p2a.json":157847608,"reads-p2b.json":157847610,"reads-x1.json":157847611,"reads-b1.json":157847612,"reads-b2.json":157847613},"artifacts":["run/<run-id>/candidates.json","run/<run-id>/r3-data.json","run/<run-id>/reads.json","run/<run-id>/reads-p1.json","run/<run-id>/reads-p2a.json","run/<run-id>/reads-p2b.json","run/<run-id>/reads-x1.json","run/<run-id>/reads-b1.json","run/<run-id>/reads-b2.json"],"detail":"run/<run-id>/planner/c.json"}
```

### `blind <run-id>`: the price-free input of an AI research run-id

After `c` on the same run-id: from `candidates.json` it reads four fields per row (`market`, `address`, `kind`,
`tradeable`), never a price; for each tradeable scalar child it reads the Reality.eth question
(`Market.questionsIds()[0]`) and its `getFinalizeTS`, `getBestAnswer`, `getBond` and `isPendingArbitration`, in two
multicalls through the helper, and writes `onchain-state.blind.json` (a posted answer as `best_answer_score`, 0 to 100,
or `best_answer_label` `INVALID`). It writes no forecast and runs no signer. `scripts/ai-forecast/prep.cjs` then
builds the research workers' folders from it (`steps/D-methods/ai-research.md`).

```json
{"subcommand":"blind","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"questions":98,"answers_posted":0,"block":158529912,"artifacts":["run/<run-id>/onchain-state.blind.json"],"detail":"run/<run-id>/planner/blind.json"}
```

### `d <run-id>` and `d <run-id> --supply <csv> [--continue] [--notes <text>]`: D-forecast

**Method `forecast-file`** (`forecastMethod` `forecast-file`, or `ai`, its first name), without `--supply`: this run-id's
own `research-forecast.json` if it has one, else the newest one under `./run/*/` made within `forecastMaxAgeHours`,
copied in byte for byte; a file whose `generated_at` is not an ISO 8601 UTC timestamp is skipped. Any source may write
it: the AI research, another model, a script, a pool of forecasters. D checks it (`price_seen` false, a `method` text
saying how it was made, `generated_at` an ISO 8601 UTC timestamp, each `p` three numbers in [0, 1] summing to 1 with
Invalid above 0, one row per address, each row's market naming C's repo; a refusal names rows by index and markets by
C's names, never the file's own strings) and writes `base-forecast.json` with C's
market strings and the file's method, marked as this arm's (`lib.FORECAST_FILE_MARK` in front, unless it already
carries that mark or the older `lib.RESEARCH_METHOD_PREFIX`), so F, Half B, H and the repair know the run-id; a
candidate without a row gets no forecast. None young enough is the D stop `no-forecast` (status `no-forecast`); a
malformed one, `forecast-refused` (status `aborted`). The summary's `source` is `forecast-file`, with a `forecast_file`
block (`file`, `from_run_id`, `generated_at`, `age_hours`, `method`, `method_sha256`, `no_forecast`, `ignored_rows`).
`wake-status.json` carries `from_run_id`, `generated_at`, `age_hours`, `method_sha256` and `no_forecast` as
`forecast_file`, and `report.md` the method's sha256: neither carries the method's text.

**Method `csv`**, the default, without `--supply`: the stored CSV (`steps/D-methods/csv.md` step 2, case 2), D's structural checks only, nothing hashed, `base-forecast.json`.
No CSV ever provided is the D stop `no-csv` (status `no-csv`); a pointer that does not resolve is `csv-store-mismatch`.
With `--supply` (a supervised session only): a `.csv` file named relative to the project root; it prints `steps/D-methods/csv.md` step 5's
report and stores nothing (`awaiting-continue`, exit 3) until the human's "continue" is given as `--continue`; then it
writes the version file write-once, rewrites `./run/csv/current.json` (with `--notes` as its `notes`) and writes
`base-forecast.json`. A matched count of 0 is refused even with `--continue`. D reads five fields per candidate and
never a price, and runs no helper and no signer.

```json
{"subcommand":"d","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"source":"stored","forecasts":83,"csv":{"version":1,"path":"./run/csv/originality-v1-<supplying run-id>.csv","sha256":"ed5e6124c019413777eb2b6ee1ce4f3fcec2aaed8dcbb1737e0273038ff23187","supplied_at":"2026-10-06T01:34:11Z","supplied_in_run":"<supplying run-id>","reused":true,"counts":{"matched":83,"unmatched":0,"overwritten":0,"no_forecast":15},"hash_checked":"not hashed (structural checks only)","counts_differ":null,"store_repaired":false},"previous_run_cited":null,"counts":{"matched":83,"unmatched":0,"overwritten":0,"no_forecast":15},"unmatched_rows":[],"overwritten_rows":[],"no_forecast_split":{"blank_cell":15,"absent":0},"skipped_not_scalar":[],"artifacts":["run/<run-id>/base-forecast.json"],"detail":"run/<run-id>/planner/d.json"}
```

The supervised path before the "continue":

```json
{"subcommand":"d","run_id":"<run-id>","exit":3,"ok":false,"stop":{"step":"D","cause":"awaiting-continue","status":null,"notes":"D step 5: the report is printed; nothing is stored until the human says continue (re-run with --continue), or edits the CSV (re-run on the new file)."},"counts":{"matched":4,"unmatched":1,"overwritten":0,"no_forecast":94},"unmatched_rows":[{"line":8,"compared":"nobody/not-in-round-3","did_you_mean":null}],"overwritten_rows":[],"no_forecast_split":{"blank_cell":2,"absent":92},"detail":"run/<run-id>/planner/d.json"}
```

### `e <run-id>`: E-no-reconcile

`blended.json`, the identity blend: `own = blended = p`, `w = 1`, copied before any price is read; the price from
`candidates.json`, else the saved body through `data-rows` (never a new fetch, and never a body C refused); a row priced
by neither keeps `market_price` null. Stops (abort, nothing written): `price-seen`, `malformed-forecast`,
`duplicate-address`, an unreadable input.

```json
{"subcommand":"e","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"blends":83,"priced_from_candidates":83,"priced_from_saved_body":0,"null_price":0,"null_price_rows":[],"negative_third":61,"fetched":false,"artifacts":["run/<run-id>/blended.json"],"detail":"run/<run-id>/planner/e.json"}
```

### `f <run-id> [--provisional]`: F-max-ev

Read (inputs, the holder's balances in one multicall, both pools of every tradeable market in one multicall file each:
the market's pin, the tick ranges from the body checked onchain or found from `tickBitmap`, the gas inputs), plan
(steps 3a, 3b, 3 to 7 and 9 on QuoterV2 and the exact model), the probe of rows sized on a post-set-sell or
post-merge-arb state (`simulate`), verify (every invariant on the exact bytes, then a re-quote of every kept row; a
hard failure is the F stop `self-check-failed` and nothing is written), then `allocation.json` and `f-print.md`. A
run-id whose sends have started is refused (`broadcast-started`; a landed PSM3 ramp alone, which renames its
`inflight.json`, is not a start); an earlier plan of the run-id is removed first.

Step 3a's **merge-arb** is built: on a sub-1 market whose holder holds that market's child Invalid `I_j` (retained by an
earlier run's set-sell or complex-buy), a `set` row routed `merge-arb` with `q = min(q_max_pair, I_j)` (`limited_by`
`invalid-held` when `I_j` binds), `stake` the quoted cost of `q` UP + `q` DOWN, `quoted_fill = stake / q`,
`ev = q - stake`; the 3b pair then takes only the remainder of the pair bound, priced on the post-merge-arb state (the
live quote at `q + count` less the live quote at `q`, an exact-output swap's cost being path-additive) and probed on
simulated state. `merge_arb_markets` names those markets.

`--provisional` (a supervised session only; refused inside the wrapper's lock, and the wake never passes it): when USDC
or USDS is held and its PSM3 ramp is queued but has not landed, the bankroll is provisional, the sUSDS balance plus PSM3
`minAmountOut` (quote x 9999 / 10000) for all of it (`F-max-ev.md`, intro). `f-print.md` and the summary
(`provisional`, `provisional_min_out`) say so, `allocation.json` carries no extra key, and `g` refuses the plan
(`stale-susds`) until the ramp has landed and `f` has re-run on the real sUSDS. Without the flag a held USDC or USDS is
reported (`ramp_due`) and F sizes on the sUSDS balance alone.

```json
{"subcommand":"f","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"rows":39,"markets_with_rows":33,"pair_markets":1,"set_rows":7,"single_side_rows":30,"markets_without_row":65,"skipped_entries":89,"bankroll":0,"staked_M":0,"binds":"bankroll","expected_value":0.40063882570980613,"correlated_worst_case":0,"iterations":4,"step7_drops":114,"tradeable_markets":98,"held_markets":90,"child_invalid_markets":18,"merge_arb_markets":[],"ramp_due":false,"provisional":false,"provisional_min_out":null,"usdc_raw":"0","usds_raw":"0","body_used":true,"ranges":{"from_body":196,"from_tickbitmap":0},"pins":{"min":157851808,"max":157851815,"distinct":8},"post3a_rows":5,"probe":[{"market":"flashbots/rbuilder","side":"DOWN","ran":true,"confirmed":true,"rel_gap":4.1104618562769266e-15,"why":null},{"market":"Certora/CertoraProver","side":"DOWN","ran":true,"confirmed":true,"rel_gap":1.2971123214199527e-15,"why":null},{"market":"edb-rs/edb","side":"DOWN","ran":true,"confirmed":true,"rel_gap":4.684846242136943e-15,"why":null},{"market":"eth-infinitism/account-abstraction","side":"DOWN","ran":true,"confirmed":true,"rel_gap":1.1428493338011948e-15,"why":null},{"market":"ethereum/execution-apis","side":"DOWN","ran":true,"confirmed":true,"rel_gap":2.577399743580523e-15,"why":null}],"checks":{"passed":25,"total":25},"drift_markets":0,"drift_list":[],"model_gap_max":9.553432561459348e-18,"helper_calls":346,"quotes":{"quotes":820,"quoteBatches":316,"revertSplits":0,"singleReverts":0},"seconds":366,"artifacts":["run/<run-id>/allocation.json","run/<run-id>/f-print.md","run/<run-id>/planner/f-state.json","run/<run-id>/planner/f-verify.json","run/<run-id>/planner/f-final.json","run/<run-id>/planner/f-aux.json","run/<run-id>/planner/f-gaps.json"]}
```

(That run held no sUSDS: `bankroll` and `staked_M` are 0 and every row spends repo tokens an earlier run left, the
day-2 budget `held_j` of F step 6. See section 8. Its one sub-1 market with held child Invalid, OffchainLabs/stylus-sdk-rs,
was sized a merge-arb of 15.1465 pairs, the whole pair bound, below I_j 28.77; its gain, 0.3669 repo tokens, did not
clear step 7's 7-leg gas floor, so the drop is listed in `f-print.md` and the market keeps its 3b pair, which clears
the 2-leg floor.)

### `g <run-id> [--indep]`: G's build

Read (the nonce, latest == pending; identity; both pools of each market in one multicall; the pool-drift report against
F's read, `planner/g-drift.json`; balances; the trading boundary), build (the mint, the routes, the quotes, the groups in
send order, the whole-sequence simulation, windowed only when the node refuses one request), verify (the helper's
`encode` equal to the ethers encoding on every calldata, one `g-tx/tx-NNN.json` per transaction with the signer's
policy-only `check` on each, the predicted end state against the simulated one), emit (`g-plan.json`,
`gate-print.md`), audit (the written plan re-derived, then a fresh re-simulation). `--indep` (supervised only) writes
`g-indep-request.json`, the independent second-RPC read as a request; without it the summary says it was skipped. A
nonce move, a pending transaction or an encode mismatch is exit 4; a refused check, the boundary, a failed simulation, a
changed identity are exit 3; no plan is left behind by a failure.

The boundary refuses a plan only on a child with a row past its own boundary (G section 3): a middle or the parent that
has resolved refuses nothing by itself (a child of a resolved middle stays tradeable while its numerator is nonzero,
`C-select.md` step 4). Each mint group carries its level's plan-time reading (`pre_send_checks`), and the executor stops
it only on a flip since. A merge-arb row is built as G section 3's buy-and-merge group (kind `merge-arb`, recorded route
`buy-and-merge`): `q` clamped at the live child Invalid (a larger shortfall is `stale-invalid`), each leg's
`amountInMaximum = quoted_in x min(q / quoted_cost, 1.005)`; a pair after it is quoted on the state it leaves by the
return probe. A failing simulation (the build's, the end-state probe's, the audit's fresh re-simulation, an infeasible
dual-buy or merge-arb leg) carries `stale_simulation` and `first_failed_group`; with `cutAtFailure` (the wake only) a
second such failure cuts the plan there instead: the earlier groups stay, the failing one and every later one become
skipped rows, and `cut` in the summary and `g-plan.json` says where. A run-id whose only sends are its landed PSM3 ramp
(`ramp.json`) is not refused as started.

```json
{"subcommand":"g","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"nothing_to_send":false,"groups":9,"transactions":28,"by_kind":{"mint":4,"set-sell":1,"dual-buy":1,"simple-buy":2,"complex-buy":1},"markets":5,"rows_in_groups":6,"skipped_rows":0,"skipped":[],"mint":{"M":"10","parent_split":true,"middles":["A","B","C"],"bundles_with_position":["A","B","C"]},"ramp_due":false,"cut":null,"nonce":5,"first_last_nonce":[5,32],"drift":{"pools_compared":10,"pools_moved":0,"markets_moved":[],"fresh_quote_vs_f_max_rel_gap":5.6307200007507196e-15},"simulation":{"requests":1,"windowed":false,"all_success":true,"sum_gas_used":16932578,"sum_gas_limit":24996188,"largest_gas_limit":6764607,"no_max_used_gas_count":0},"verify":{"encode_identical":28,"signer_check_allowed":28,"end_state":{"probed":23,"matched":23,"differ":0}},"eth":{"holder_eth":"0.01","cost_at_gas_price_eth":"0.000016932578028","cost_at_signer_ceiling_eth":"0.000033865156028","affordable":true},"route_agreement":[],"audit":{"failures":0,"rows_checked":28,"gas_used_differ":0},"indep":{"ran":false,"reason":"skipped: the independent second-RPC read is supervised-only (the chain helper pins one RPC and the planner contacts none itself); pass --indep in a supervised session to write the request"},"helper_calls":55,"seconds":27,"artifacts":["run/<run-id>/g-plan.json","run/<run-id>/gate-print.md","run/<run-id>/g-tx/ (28 files)","run/<run-id>/g-sim-main.json","run/<run-id>/planner/g-drift.json","run/<run-id>/planner/g-state.json","run/<run-id>/planner/g-built.json","run/<run-id>/planner/g-verified.json"],"detail":"run/<run-id>/planner/g.json"}
```

### `exec <run-id> [--check] [--max-groups N]`: G section 8's sequential executor

One transaction per signer call, in the plan's order. Before the plan's first send, the trading boundary of every group
in one pass: a group past its boundary stops the run before the parent mint is sent (`stale-boundary`; before the run's
first broadcast inside the wrapper it asks the wake's once-only re-plan, `replan_due`; after one, every group is written
skipped). A mint group's boundary is a flip of its own level since G's reading; a trade group's is its child's. Per
transaction: the fresh checks (boundary, route, floors; a merge-arb's child Invalid at least its `q`), then
the nonce (latest == pending == the plan's), the signer-input file equal to the plan and its keccak256 equal to the
plan's, the signer's own `simulate`, the three-part gas check, the lock still ours, the write-ahead, ONE `send`, the
receipt and the nonce n + 1. Per group: affordability first; the balance effects against the plan's after it: exact on
every delta no pool decides (`effects-mismatch` otherwise), reported as "pool moved since build" (`exec-state.json`
`effects_diffs`, `report.md`) on a swap's output or an exact-output swap's input that a third party's trade moved after
the build, held only to the calldata's own bound. A landed merge-arb writes the side `Invalid` rows of the child Invalid
it consumed into the earlier run-ids that retained it, oldest first. A complex
buy's last two transactions are rebuilt at send time with the realised sale proceeds. Inside the wrapper (its lock names
this run-id) the lock is used and never released, and the standing authorization is checked (`autonomy-gate`);
otherwise a supervised send batch takes the lock and releases it. A stop stops sending: the group in progress keeps what
landed (rows `partial`); inside the wrapper, a group left half-done then goes to G section 8 step 4's recovery rule in
the same run (section 6, *The recovery rule*; summary `recovery`), and one it does not complete or unwind is reported
in `half_done` (a wake then ends `aborted`, cause `half-done`); a supervised batch's recovery has its own "yes". Every
group not started is written `skipped`, and a stopped plan is never resumed (`prior-stop`). `--max-groups N` pauses
after N groups; the next invocation resumes from the chain. `--check` sends nothing: it re-hashes and policy-checks
every remaining file, reads the boundary, quotes every swap against its bound, simulates the remaining plan (no call
flagged "return"), reads the complex-buy sale proceeds by re-running each simulated window with at most 20 sale calls
flagged per request (the chain helper's cap), re-encodes the complex-buy rebuild on the plan's own numbers, projects
affordability, runs the full pre-send path on the next transaction without its send, and settles the attempts already
recorded (`exec-check.json`).

```json
{"subcommand":"exec","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"outcome":"check-passed","check":{"data_files":{"checked":28,"bad":0},"boundary":{"groups":9,"not_clear":0},"quotes":{"checked":7,"outside_bound":0,"differ_from_plan_quote":0},"simulation":{"clean":true,"requests":1,"windowed":false,"problems":[]},"sale_proceeds":{"checked":1,"differ":0,"problems":[]},"sim_rows_vs_plan":{"checked":28,"differ":0,"note":"a difference in gasUsed or gas_limit is reported; the pre-send gas check judges each transaction at its send"},"rebuild":{"groups":1,"differ":0},"affordability":{"gas_price":"1000000","first_group_not_affordable":null,"projected_end_eth":"0.009983067421972"},"first_tx":{"idx":0,"fresh_gas_used":"46000","plan_gas_used":46000,"gas_limit":"55200","notes":[]},"settlement":{"checked":0,"not_landed":0},"problems":0,"seconds":24},"check_file":"run/<run-id>/exec-check.json","mode":"check","groups_total":9,"groups_done":0,"transactions_total":28,"transactions_sent":0,"sent_this_invocation":0,"first_tx":null,"last_tx":null,"gas_cost_eth_receipts":"0","nonce_pinning":false,"signer_env_dropped":[],"signer_log_path":null,"tx_hash_file":"run/<run-id>/exec-sends.json","detail":"run/<run-id>/planner/exec.json"}
```

```json
{"subcommand":"exec","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"outcome":"complete","mode":"supervised","groups_total":9,"groups_done":9,"transactions_total":28,"transactions_sent":28,"sent_this_invocation":28,"first_tx":"0xf010d7130f7f8740b9b7eda0477ce178a5e517fed4408cad42b6ad97b02ff484","last_tx":"0x02ed6a8cf08c1c6e1e33ba9bb3b6c2fe2cd50d887e795e2ad72728be08287845","gas_cost_eth_receipts":"0.000016932578028","nonce_pinning":false,"signer_env_dropped":[],"signer_log_path":"<the signer's log>","tx_hash_file":"run/<run-id>/exec-sends.json","retained_legs":102,"consumed_rows":0,"unattributed_consumption":[],"notes":[],"eth_after":"0.009983067421972","detail":"run/<run-id>/planner/exec.json"}
```

A stop (here the pre-send gas check on the first approve, before any send):

```json
{"subcommand":"exec","run_id":"<run-id>","exit":3,"ok":false,"stop":{"step":"G","cause":"gas-limit","status":"aborted","notes":"approve sUSDS -> Router (M) (nonce 5): pre-send gas check (a) failed: the fresh gas_used 52900 x 1.2 is above the plan's gas_limit 55200 (a limit is never raised at send time)"},"mode":"supervised","groups_total":9,"groups_done":0,"transactions_total":28,"transactions_sent":0,"sent_this_invocation":0,"first_tx":null,"last_tx":null,"gas_cost_eth_receipts":"0","nonce_pinning":false,"signer_env_dropped":[],"signer_log_path":null,"tx_hash_file":"run/<run-id>/exec-sends.json","retained_legs":0,"consumed_rows":0,"unattributed_consumption":[],"half_done":null,"recovery":null,"skipped_groups":["mint-middle-A","mint-middle-B","mint-middle-C","set-sell:ethereum/py_ecc","dual-buy:blockscout/blockscout","simple-buy:LFDT-web3j/web3j:UP","complex-buy:Cyfrin/aderyn:UP","simple-buy:argotorg/sourcify:DOWN"],"skipped_count":8,"eth_after":"0.01","detail":"run/<run-id>/planner/exec.json"}
```

A safety refusal (exit 4) writes nothing and sends nothing:
`{"subcommand":"exec","run_id":"<run-id>","exit":4,"ok":false,"stop":{"step":"G","cause":"nonce-moved","status":"aborted","notes":"the holder nonce 6 is not the first unsent group's first nonce 5 (mint-parent): a send the plan did not expect"},"nonce":{"address":"<holder>","latest":6,"pending":6},"detail":"run/<run-id>/planner/exec.json"}`

### `halfb <run-id> [--send]`: Half B

This run-id and every run-id of this arm holding fills, three levels in order, each read after the one below landed:
children (the child merge of complete sets a run-id holds, and the redeem of every held leg of a resolved child),
middles (the merge `z_X` while open; the redeem of settled children's repo tokens plus the Invalid once resolved, at
most 30 outcomes per call), the parent (the merge `y`, or its redeem). It also reads the answer watch and lists every
held market decided but unreported. Inside the wrapper every level is built and sent (`mode: "wrapper"`). In a
supervised session it prints the first level with work (`supervised-print`, `halfb-plan.json`, `halfb-print.md`) and
sends nothing; `--send` rebuilds that level and sends it only if it equals the printed one (`changed-since-print`
otherwise), one batch per "yes".

**Where its files go.** `halfb-plan.json`, `halfb-print.md`, the simulation files `halfb-sim-l<N>-*.json` and the
scratch `halfb-tmp/` are written in the **record run's** folder, `run/<record_run>/` (the first run-id processed: the
invoked run-id when it holds fills, else an earlier one); each group's signer-input files `halfb-tx/` go in its book's
folder (a child merge's book is the run-id that holds the sets); the detail file stays `run/<invoked run-id>/planner/halfb.json`.
`artifacts` in the summary names every file written, and the print names both run-ids. A group skipped for
affordability, the time budget or a failed or refused simulation exits 3 (`affordability-skip`, `time-budget`,
`stale-simulation`) with the skipped groups in `skipped`, `skipped_groups` and `notes` (the wake copies the notes into
`wake-status.json`).

```json
{"subcommand":"halfb","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"mode":"supervised-print","run_ids_holding_fills":1,"processed":["<run-id>"],"skipped_live":[],"not_final":[],"record_run":"<run-id>","held_children":5,"settled_children":[],"middles_resolved":[],"parent_resolved":false,"answer_watch":{"compared_with":null,"new_answers":[],"questions":11,"read_at_block":1028,"timestamp":1791250056},"decided_but_unreported":[],"resize_schedule":null,"merge_bounds_at_read":{"z_A":{"z":"0","scarcest":"LFDT-web3j/web3j","zero_balances":1},"z_B":{"z":"0","scarcest":"Cyfrin/aderyn","zero_balances":1},"z_C":{"z":"2.9214677588927","scarcest":"argotorg/sourcify","zero_balances":0},"y":{"y":"0","scarcest":"bundle A"}},"actionable":[{"level":2,"groups":[{"id":"middle-merge:C","kind":"middle-merge","book":"<run-id>","txs":34,"amount":"2921467758892700000"}],"simulation_clean":true,"problems":[]}],"sent":[],"skipped":[],"half_done":[],"notes":[],"artifacts":["run/<run-id>/halfb-sim-l2-main.json","run/<run-id>/halfb-plan.json","run/<run-id>/halfb-print.md","run/<run-id>/halfb-tx/ (34 files)"],"sends_this_invocation":0,"keep_aborted":false,"budget_exhausted":false,"detail":"run/<run-id>/planner/halfb.json"}
```

```json
{"subcommand":"halfb","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"mode":"supervised-send","run_ids_holding_fills":1,"processed":["<run-id>"],"skipped_live":[],"not_final":[],"record_run":"<run-id>","held_children":5,"settled_children":["LFDT-web3j/web3j"],"middles_resolved":[],"parent_resolved":false,"answer_watch":{"compared_with":null,"new_answers":[],"questions":11,"read_at_block":1028,"timestamp":1791250056},"decided_but_unreported":[],"resize_schedule":null,"merge_bounds_at_read":{"z_A":{"z":"0","scarcest":"LFDT-web3j/web3j","zero_balances":1},"z_B":{"z":"0","scarcest":"Cyfrin/aderyn","zero_balances":1},"z_C":{"z":"2.9214677588927","scarcest":"argotorg/sourcify","zero_balances":0},"y":{"y":"0","scarcest":"bundle A"}},"actionable":[{"level":1,"groups":[{"id":"child-redeem:LFDT-web3j/web3j","kind":"child-redeem","book":"<run-id>","txs":2,"amount":null}],"simulation_clean":true,"problems":[]}],"sent":[{"id":"child-redeem:LFDT-web3j/web3j","book":"<run-id>","txs":["0x309c7f72864e9d47e0995455d77de26d8147c6fba3ea82615446cdb89e32e0ea","0xdf60efab9cc083e2f6ff6ffd4c5696b8c24a6ae12ab47c292aa7120358f29ae5"]}],"skipped":[],"half_done":[],"notes":[],"artifacts":["run/<run-id>/halfb-sim-l1-main.json","run/<run-id>/halfb-tx/ (2 files)"],"sends_this_invocation":2,"keep_aborted":false,"budget_exhausted":false,"detail":"run/<run-id>/planner/halfb.json"}
```

### `h <run-id>`: H-no-learn

Per market (the union of `base-forecast.json`'s forecasts and the child rows of `fills.json`): resolved, or settled by
its middle. When nothing has settled no `review.json` is written and the line is `<run-id>: nothing settled yet`; when
something has, `review.json` with `calibration_update` null and `lessons` `[]`, rewritten only when the settled set
changes (`result: "unchanged"` otherwise).

```json
{"subcommand":"h","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"result":"nothing settled yet","line":"<run-id>: nothing settled yet","markets_read":6,"review_written":false,"detail":"run/<run-id>/planner/h.json"}
```

```json
{"subcommand":"h","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"result":"review.json written","review":"run/<run-id>/review.json","settled":1,"child_settled":1,"middle_settled":0,"pnl_by_unit":{"ORIG_R3_REPO:LFDT-web3j/web3j":8.325303594404858},"still_held":["LFDT-web3j/web3j"],"review_written":true,"detail":"run/<run-id>/planner/h.json"}
```

### `report <run-id>`

`report.md` from the run's artifacts (inside a wake also the final `wake-status.json`).

```json
{"subcommand":"report","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"report":"run/<run-id>/report.md","lines":67,"wake_status":null,"detail":"run/<run-id>/planner/report.json"}
```

### `wake <run-id>`: the whole scheduled run

Only inside the wrapper: `./run/.lock.deep-r3-trade` held by the wrapper (`owner.txt` stage `claude-p`) naming this
run-id (else `not-scheduled`, exit 4, nothing written). It writes `wake-status.json` `aborted` first; checks the five
gates of I.2 section 1 and G section 8 *Two modes* (`first_successful_run`, `autonomy.enabled`, `autonomy.authorized_at`,
`autonomy.signer_selftest_passed_at`, `schedule.signer_allow_rule_added_at`; a null or false one is named, `report.md`
is written, the wake stops; a setup in signer mode (b) stops the same way first, `unsupported-signer-mode`, section 8);
runs the start-of-run repair of earlier run-ids that hold an `inflight.json` or
`inflight.settled.json` and are not final (an unsettled `inflight.json` makes even a run-id final by its
`wake-status.json` not final, since Half B writes there; a run-id that stopped at its ramp, before `allocation.json`, is
scanned too): it settles the nonce; it appends the missing `fills.json` row of every transaction of that run-id's plan
that landed without one (after its run stopped, or between a receipt and its row) and of a Half B send recorded there
(`halfb-tx/tx-n<n>.json`), append only, built from the signed calldata because a receipt read carries no amounts: exact
for a split, an exact-output count, a set-sell's or a merge's `q`, else the calldata's own bound (`amountOutMinimum` a
floor, `amountInMaximum` a ceiling), said in the row's `error`; a ramp or setup send gets none; a recovery send recorded
in that run-id's `recovery.json` gets its row the same way. Once every nonce of the scan is settled and nothing blocks
a send, it applies the recovery rule (section 6) to each half-done group, some but not all of its transactions landed
by `exec-state.json` against `g-plan.json` and no recovery settled it, in that run-id under the wrapper's lock, and
finalizes the run-id once nothing of it is half-done (completed, unwound, nothing to unwind, or kept because the
boundary allows neither trading nor merging); otherwise it names the group and leaves the run-id not final. Then Half A: `c`, `d` by the configured method (`forecastMethod`: the stored CSV, or a forecast file), `e`, **the PSM3 ramp** of any
USDC and USDS at the holder (`planner/ramp.cjs`, I.1 section 5: per asset a quote, the capacity gate
`sUSDS.balanceOf(PSM3)` read before the group and again right before the swap, an exact approve, `swapExactIn` with `minAmountOut = quote x 9999 / 10000`; simulated in one
request, policy-checked, sent through exec-core like every send, the run's first broadcast; its record `ramp.json` and its
sends in `exec-sends.json` with source `ramp`; a ramp that stops, is refused or leaves a nonce unsettled ends Half A
before F), then `f` on the post-ramp sUSDS, `g`, `exec`. **One once-only re-plan:** a stale simulation before the run's
first broadcast (G's build simulation, its end-state probe, its audit's fresh re-simulation, an infeasible dual-buy or
merge-arb leg, or `exec`'s pre-send simulation or boundary pass) re-runs `f` and `g` once (`g` with `cutAtFailure`), and
every later `exec` gets `replanned`; if the rebuilt plan fails again, `g` cuts it at the failing group (the groups before
it are sent, the failing one and every later one written skipped) and the status stays `traded` or `nothing-to-do`
(exit 3, cause `stale-simulation`). After the run's first broadcast (a ramp) `g` cuts at once. Then Half B and H on this
arm's run-ids holding fills, within the time budget; then `report`, which writes the final `wake-status.json`. A C or D
stop ends Half A only (D4): Half B and H still run, and the final status is `aborted`, `no-csv`, `csv-store-mismatch` or `no-forecast` (`forecast-refused` ends `aborted`).
A Half B stop that leaves no nonce open (an affordability skip, say) keeps the status and exits 3 (`half-b-stop`); a
Half B group it left part-way is named in `notes` and `report.md`. An `exec` that leaves a keep-whole group half-done
(its `half_done`: nonce settled, and the recovery rule it applied in the same run did not complete or unwind the group)
makes the final status `aborted`, cause `half-done`, exit 3 (at least), the group named at the top of `notes` and
`report.md`: the run-id is not final, and the next wake's repair applies the rule again. Every step leaves the same
summary and detail file as when it runs alone (the ramp's is `planner/ramp.json`).

```json
{"subcommand":"wake","run_id":"<run-id>","ok":true,"exit":0,"stop":null,"status":"traded","stopped_at_step":"H","half_a_stop":null,"traded":true,"repaired":0,"recovered":[],"sends_blocked":null,"h_rescored":[],"h_results":{"<run-id>":"nothing settled yet"},"notes":[],"report":"run/<run-id>/report.md","wake_status":"run/<run-id>/wake-status.json","detail":"run/<run-id>/planner/wake.json"}
```

```json
{"subcommand":"wake","run_id":"<run-id>","exit":3,"ok":false,"stop":{"step":"W","cause":"gate","status":"aborted","notes":"autonomy.enabled is not true"},"status":"aborted","detail":"run/<run-id>/planner/wake.json"}
```

## 5. Exit codes

| Exit | Meaning | Examples (`code` or `stop.cause`) |
|---|---|---|
| 0 | ok | |
| 1 | an internal error of the planner (a bug); the summary says so | `internal` |
| 2 | usage or config, or a tool that refused its own config, arguments or paths | `usage`, `bad_run_id`, `bad_argument`, `config_missing`, `config_malformed`, `config_inside_project`, `config_cwd_mismatch`, `ethers_missing`, `ethers_version`, `path_*` |
| 3 | a stop the skill defines: a C or D stop, a stale plan, a refusal, an affordability skip | `tool-failure`, `signer-refused`, `identity-check-failed`, `upstream-set-changed`, `onchain-reads-failed`, `run-id-used`, `no-csv`, `csv-store-mismatch`, `no-forecast`, `forecast-refused`, `awaiting-continue`, `price-seen`, `self-check-failed`, `broadcast-started`, `allowlist-refused`, `boundary`, `stale-boundary`, `simulation-failed`, `stale-simulation`, `dual-leg-infeasible`, `merge-arb-infeasible`, `stale-invalid`, `stale-susds`, `stale-floor`, `stale-balance`, `effects-mismatch`, `gas-limit`, `gas-grew`, `affordability-skip`, `time-budget`, `psm3-capacity`, `autonomy-gate`, `prior-stop`, `changed-since-print`, `unsupported-signer-mode` (signer mode (b), refused by every send path and by the wake: section 8); the wake's `half-a-stop`, `half-done`, `half-b-stop`, `aborted` |
| 4 | a safety refusal | `nonce-moved`, `pending-transaction`, `hash-mismatch`, `lock-held`, `lock-lost`, `pending`, `inflight-unsettled`, `signer-changed`, `holder-mismatch`, `not-scheduled` |
| 5 | a transport failure after the re-runs | `rpc_unreachable` (C), `transport` |

## 6. The live-chain rules it keeps

All proven or fixed on the first live run; the canonical text is `steps/G-mint-and-trade.md` section 8.

- **Pacing and rate limits.** Helper and signer processes run one at a time by default (`parallel` 1), `rpcGapMs`
  apart. A helper answer with exit 5 whose code is a transport code, or whose text says the RPC is rate-limited
  ("requests per second", "rate limit", "too many requests", "429", "exceeded its requests", "capacity"), is transient:
  the planner backs off (1.5 s times the attempt, at most 20 s) and re-runs it, up to 5 more times in C and E (C step
  2, last paragraph) and 9 more in F, G, the executor, Half B and H; then the step stops with exit 5. The public RPC answers a rate
  limit as a plain `rpc_error`, which is why the text is read. A revert (exit 8) is never re-run, whatever its text;
  the data function's `data` is never re-run (its failure takes C's onchain rebuild). A signer throttle (the one
  definition: `steps/I-setup.md` I.2 section 7, *Rate limits*: a non-zero exit, `error` `rpc-error`, `rpc-http` or
  `rpc-transport`, no `"simulated":true`, the rate-limit text in `detail`) is re-run the same way, up to 9 more times
  (`lib.signerThrottled`): the executor's pre-send `simulate`, and a `send` only when that attempt printed no
  `broadcast` line and says `"signed":false,"broadcast":false` (its write-ahead record stands; nothing was signed). A
  `send` that printed a `broadcast` line is never re-run, and `send` is never timed out. A `simulate` still throttled
  after the re-runs stops with exit 5 `transport` (never `stale-simulation`); a `send` still throttled is retired as
  not broadcast and ends its group like a refusal before any broadcast. Only a `"simulated":true` answer is a
  simulation result, so the pre-send `simulate` (`exec-core.presend`, on every send path) stops with `stale-simulation`
  only on such an answer with a status other than `0x1`: an RPC failure with no `"simulated":true` or the planner's
  own timeout is exit 5 `transport`, a `-38000` to `-38999` refusal `tool-failure`, a refusal `signer-refused`, any
  other answer `tool-failure` (the rule: `steps/I-setup.md` I.2 section 7, *Rate limits*).
- **The head moves.** No step compares block numbers or hashes between two reads. Validity rests on: the holder's nonce,
  latest == pending == the plan's, at every stage of G and before every send; the per-market pin (both pools of a market
  read in one multicall, one block: F step 1); the pool-drift report between F's sizing and G's build (reported, never
  a stop by itself); each call's own floor; and the pre-send re-check of G section 3.
- **Gas.** Each transaction's limit is the helper's `gas_limit`: `ceil(maxUsedGas x 1.2)`, or `ceil(gasUsed x 1.5)` when
  the RPC gives no `maxUsedGas`. Before every send, after the signer's own `simulate` on live state, all three must hold
  (`exec-core.gasCheck`): (a) the limit covers the fresh `gas_used` x 1.2; (b) the limit covers the peak the ordered
  simulation measured for that call; (c) the fresh `gas_used` is at most 10% above the plan's (else the state changed:
  stop). Never the old `gasUsed x 1.5 <= limit` test, which refuses every refund-free call once limits come from a real
  `maxUsedGas`: an approve uses 46,000 gas and gets the limit 55,200, and 46,000 x 1.5 = 69,000 is above it. (A local
  fork reports no `maxUsedGas`, so its 1.5x fallback hid this.) A Router split hits the refund cap (gasUsed 590,127,
  peak 737,658, limit 885,190), which is why the limit comes from the peak.
- **Affordability.** Before each group's first write-ahead, read fresh: ETH >= 0.002 ETH + the sum over the group of
  `gas_limit x 2 x eth_gasPrice` (the signer's up-front rule, `maxFeePerGas` = 2 x `eth_gasPrice`). A group that does
  not fit is not started; it and every later group are written `skipped` (exit 3). ETH is not re-checked inside a group.
  The same holds for the wake's PSM3 ramp and for every Half B batch: a Half B batch skipped for affordability, the time
  budget or a failed or refused simulation exits 3 with the cause in the JSON and the skipped groups named in `notes`.
- **A pool that merely moved.** A swap's output (or an exact-output swap's input) that differs from G's build quote
  because a third party traded in the pool after the build is reported ("pool moved since build"), never a stop: each
  call's floor and the fresh pre-send quote guard the send (G section 8, *The head moves*). Every balance delta no pool
  decides is still exact.
- **Write-ahead and settlement.** `inflight.json` and the nonce attempt (with `to`) are written before every broadcast;
  `send` runs once; an unclear outcome is settled from chain state (Landed, Pending, Not sent; no timeout). A refusal
  before any broadcast that provably signed nothing is retired at once. The block scan of a nonce with no known hash
  runs forward from the attempts' `from_block` to the head, bounded only by time (the step's deadline, the registered
  time limit less the reserve, else 15 minutes); its cursor, the next block to read, is the planner's own
  `run/<run-id>/settle-scan.json`, never a field of `nonce-attempts.json` or `inflight.json`, advanced only past blocks
  read whole that hold no transaction of the holder at that nonce and saved as the scan goes. A scan cut short reads
  Pending ("resumes at block B") and the next settlement continues from B, so a cancel mined far past `from_block`
  is still found and no block is skipped or read twice.
- **The recovery rule** (G section 8 step 4; `exec.recoverGroup`, its one implementation). `exec` applies it inside the
  wrapper in the run that stopped, after a settled revert, a not-sent finding sending may continue after, or a floor
  breach or stale check before a send (never after a refusal before any broadcast, a Pending or unsettled nonce, a
  safety stop or a transport failure); the wake's start-of-run repair applies it to a prior run-id's half-done group
  once every nonce is settled and nothing blocks a send. Judged against the current chain state: the group's boundary
  not clear, the landed legs are kept (`kept`; only approvals landed: `nothing-to-unwind`); else its remaining
  transactions, as the plan wrote them with their floors (a complex buy's last pair at the sale's proceeds, rebuilt at
  the realised proceeds once the sale lands), simulated now and sent if every call succeeds (`completed`); else what
  landed unwound, a split whose sales did not land merged back (`buy-and-merge`), else each stray leg sold at a fresh
  quote less 0.5% (`sell-exit`), simulated now (`unwound`); else nothing sent (`stopped`). The batch has fresh nonces,
  gas from its own simulation, the signer's check of every file, the time budget and affordability, and per transaction
  the boundary and floor re-check and the whole pre-send path, write-ahead and settlement (`exec-sends.json` source
  `recovery`); each row names the failed transaction and the word "recovery". One attempt per run, never a loop.
  `run/<run-id>/recovery.json` records every attempt, each send before its broadcast and the effects that landed, so a
  group a recovery completed, unwound or found nothing to unwind in is never acted on again.

## 7. Tests (`planner.test.cjs`)

**Offline** (operator, on review, and again after any edit to a planner file), from the skill's `scripts/` folder with
`ethers` 6.17.0 resolvable (an `npm install ethers@6.17.0` in a parent folder, or `NODE_PATH` pointing at a
`node_modules` that holds it):

```
node planner.test.cjs --dir <a scratch folder>
```

It installs a copy of the planner in the scratch folder, outside a scratch project, with a config naming a mock chain
helper and a mock signer. The mocks answer this skill's helper and signer README shapes and exit codes over a synthetic
chain built from `planner/table.cjs` (the 98 real market, repo-token, middle and parent addresses; made-up outcome
tokens and pools, answered with the planner's own exact single-range math; a made-up holder; a JSON ledger the mock
signer "mines" into). No network, no key, nothing signed. Prices are set so that F finds every route: a set-sell, a pair
sent as a dual-buy, simple buys on both sides, a complex buy, and a market whose forecast equals its price. Sections
(`--only` takes any of them): `static` (the embedded table against the skill text; no env read, no socket, no key code
in any file), `usage` (arguments, the config failing closed, the inside-project refusal, the current folder), `lib`
(path confinement, the summary cap, the signer runner's refusals, the rate-limit re-run, the signer throttle re-run of a
`simulate` and of a `send` that printed no `broadcast` line and never of one that did, the gas pre-send rule on a
refund-free call and a Router split, the pre-send `simulate`'s answers in process (an RPC failure with no
`"simulated":true` and the planner's own timeout to `transport`, a `-38xxx` refusal, a signer refusal and malformed
output to their own stops, a `"simulated":true` 0x0 to `stale-simulation`), the signer-mode rule in process (only
`executor-session-key` refuses; `presend` and `broadcast` stop before any helper or signer call), the settlement scan
in process (a cancel at `from_block` + 40,000 found across five settlements of a short time budget, every block read
once, none skipped, `nonce-attempts.json` unchanged), H's cost basis in process (the first live run's complex-buy rows:
`x` counted once, the hand-computed P&L for UP, DOWN and INVALID)), `pipeline` (c, d, e, f, g, `exec --check`, exec, halfb, h,
report on one run-id, each summary's shape, writes only where allowed), `c-variants` (C's stops and its onchain
rebuild, a transport failure to exit 5), `forecast-file` (D's forecast-file method: `blind`'s price-free Reality.eth
reads, the config's method and age bounds with `ai` accepted, no forecast file or only a stale one to the `no-forecast`
stop, a fresh one in another run-id copied byte for byte with its free-text method marked as this arm's and read by E, a
run-id's own file used whatever its age, a file with the older mark kept as is under `ai` and both marks recognized,
five malformed ones refused, `--supply` still storing a CSV, and a wake ending `no-forecast`), `g-safety` and `exec-safety` (nonce moved, pending transaction, hash
mismatch, a refused check, the gas check at send time, affordability, `--max-groups`, a send throttled before signing
re-run with one attempt per nonce, a pre-send `simulate` still throttled after its re-runs to exit 5, its
`rpc-transport`, `rpc-http` 503 and plain `rpc-error` answers to exit 5 and a `-38xxx` one to exit 3, nothing sent;
signer mode (b): `exec`, `exec --check` and `halfb --send` refused before any signer call), `wake` (the whole
scheduled run inside a wrapper lock, the gates, a signer-mode (b) setup refused at the start check, the refusal
outside the wrapper, D4, the five gates, a Half B affordability skip, exec's and Half B's pre-send `simulate`
answering an RPC failure (exit 5, nothing sent, the wake `aborted`), the once-only re-plan and the cut, a group exec
leaves half-done after its in-run recovery stopped ending the wake `aborted` (cause
`half-done`), the next wake's repair applying the rule to it on the state of the day (Half B's middle merge had taken
the market's repo tokens back, so the stray leg is sold: unwound, its rows appended, the run-id finalized), and a
recovered group never acted on again), `repair` (in process: an unsettled Half B write-ahead in a prior final run-id,
a not-sent finding on a signer that cannot pin the nonce over two wakes, a ramp-stopped run-id; the missing `fills.json`
row appended once, every row kept, for a dual-buy leg, a Half B merge and a Half B child redeem that landed after their
run stopped; a late approve that makes a skipped group half-done), `boundary` (a resolved middle: the plan, the sends, a
flip between G and exec, an `M = 0` plan), `mergearb` (F's merge-arb, G's buy-and-merge group, exec and the cross-run
Invalid row), `ramp` (the wake's PSM3 ramp, its capacity stop, `f --provisional`, its pre-send `simulate` answering
`rpc-transport`), `recovery` (exec's recovery rule in the same run: a dual-buy completed after its DOWN leg's
simulate failed once, unwound by selling the stray UP leg after a third party lifted the DOWN price, kept when the
child went to arbitration and then finalized by the next wake's repair), `cap` (a 51-complex-buy plan: `exec --check`
passes with its 51 sale proceeds read at most 20 flagged calls per request, and `exec` inside the wrapper sends all 306
transactions; across the whole suite no simulate request flags more than 20 calls); `exec-safety` also moves a pool
after G (reported, never a stop). It takes about 50 minutes (every helper and signer call is a process).

**Live read-only smoke** (optional, after installing): it installs its own copy of the planner in `--bin`, outside
`--project`, copies `ethers` next to it from the helper's folder, copies a CSV store into `--project/run/csv`, then runs
`c`, `d` (the stored CSV), `e` and `f` on a fresh run-id through the installed helper. The signer is configured and
never run (asserted from each step's detail file); nothing is signed or sent. F on mainnet takes several minutes.

```
node planner.test.cjs --skip-offline --live --helper <chain-helper.cjs> --signer <signer.cjs> --bin <folder> --project <folder> --csv-store <a run/csv folder> --dir <a scratch folder>
```

## 8. What is untested live, and open items

- **Every send path is tested on the mock ledger.** The paths are `exec` sending, `halfb --send`, wrapper-mode Half B,
  the wake's PSM3 ramp, the merge-arb (buy-and-merge) group, the recovery rule (its completion, merge-back and stray-leg
  sale, in the same run and in the next wake's repair) and the wake.
  - A local fork rehearsal of the scheduled path (section 9) also sent the wake, its ramp, `exec`, Half B's middle
    merge and the recovery rule's merge-back for real on a fork.
  - Not sent on a fork: the merge-arb group, the recovery rule's completion and stray-leg sale, the next wake's repair
    of a half-done group, and the redeems.
  - The live smoke covers `c`, `d`, `e` and `f`. No planner send has run on Optimism mainnet itself.
- **The recovery rule's rows, in G's vocabulary.** A completing leg is a row on the group's own route; where part of
  it landed before the recovery (a complex buy's sale, a set-sell's UP sale, a merge-arb's legs), its amount comes from
  the calldata's own bound, said in `error`. G's vocabulary has no row for a split's two legs, so the merge-back of a
  split whose sales did not land (side `set`, `buy-and-merge`) nets to a P&L of 0 in H while H lists the market as
  still held with negative legs; a merge-arb whose recovery a later run's repair completed gets no cross-run side
  `Invalid` row (exec writes them only for one it completes in the same run). The skill text decides.
- **Redeem paths are untested live**: the child redeem, the middle redeem (at most 30 outcomes per call) and the parent
  redeem run on mocks only, because nothing has resolved yet; so does H's scoring of a settled market.
- **The repair's rows are bounds where the calldata is.** A row the start-of-run repair appends for a transaction that
  landed late is built from its signed calldata, since the helper's `receipt` prints no logs and H fills no row from
  `allocation.json` or a live balance: an exact-input buy's `filled` is its `amountOutMinimum` (a floor), an
  exact-output buy's and a merge-arb's `fill_price` come from `amountInMaximum` (a ceiling), a set-sell's from its two
  floors; each row says so in `error`. Such a run-id's `retained_legs` (written at the stop, from balances then) are not
  recomputed. A Half B group stopped part-way is not tracked across runs (only `exec-state.json` groups count as
  half-done): it keeps the wake's status unless its stop keeps it aborted, and is named in `notes` and `report.md`
  (`steps/I-setup.md` I.2 §6 (a)). Checked on a copy of the first live run's folder: with nothing missing it appends nothing and finds no
  half-done group; with one row of each route removed it rebuilds all eight, exact on the mint, the set-sell's `q` and
  both dual-buy counts, and on the safe side of the realised value elsewhere. Writing a row back, like every
  `fills.json` write of the planner (`exec-core` `Book.saveFills`), keeps only `generated_at`, `runs`, `totals` and
  `retained_legs`: another top-level key (the live run's `retained_legs_note`) is dropped.
- **Not built by the planner:** a supervised session's PSM3 ramp (it is sent on its own "yes" outside the planner;
  `f --provisional` sizes a plan on it, and the wake sends its own ramp between `e` and `f`); a supervised batch's
  recovery batch (presented for its own "yes"; inside the wrapper the planner applies the rule itself, section 6); the
  independent second-RPC read of G, which `g --indep` writes as a request for a supervised session to run with a second
  tool; and **signer mode (b), TradeExecutor + session key**: the planner treats the helper config's `signerAddress` as
  the holder and sends each call directly, so it cannot drive an executor (no `batchExecute`, no window or expiry check,
  no plan from the executor's balances). **It refuses (b), fail closed** (the rule: `steps/I-setup.md` I.2 section 7,
  *The planner*). When the setup record's `signer_mode` is `executor-session-key`, `exec` (`--check` included),
  `halfb --send` and every other send of `exec-core` (the ramp, the recovery rule, the start-of-run repair) stop before
  any signer call, in supervised mode too: cause `unsupported-signer-mode`, exit 3, nothing signed or sent, the nonce
  unchanged, no lock taken. `wake` ends `aborted` at its start check, with the gates (exit 3; `report.md` written, the
  signer never run). Only that value refuses: `local-encrypted-eoa`, `eip7702`, `other-agent-signer` and a record with
  no `signer_mode` run as before. Supervised (b) is done by hand, through G section 8 with `batchExecute`. F step
  3a's merge-arb is built (F, G's
  buy-and-merge group, the executor, the cross-run Invalid rows).
- **A day-2 plan with no sUSDS is not empty.** F step 6 gives each market the budget `held_j + M`, where `held_j` is the
  repo token held plus the bundle's unsplit tokens that earlier runs left; with `M = 0`, F still sizes rows on the
  markets whose `held_j` is above 0.
- **Where the skill text names the planner**: `steps/I-setup.md` I.2 §7, *The planner*: the trading routine's tool
  entries (`Bash(node r3.cjs install)`, `Bash(node r3.cjs trade --push)` and `Bash(node r3.cjs status)` allowed,
  beside `Read`, the exact `Bash(cd /home/user/<trading repo>)` when two repositories are attached, and the exact
  pin check `Bash(git diff --quiet --no-ext-diff --no-textconv <commit> HEAD -- . ':(exclude)run')`;
  `Bash(node r3.cjs planner *)` and `Bash(node r3.cjs planner)` denied, with the rest of that section's list:
  `r3.cjs trade` runs `wake` only; a supervised session runs the other subcommands, `node r3.cjs planner …`, each
  call prompting the human), its hash record (`planner`, with `autonomy.planner_path` and `autonomy.planner_sha256`,
  which `r3.cjs trade` checks before the wake, the path included), the code pin in the trading routine's prompt (the
  commit `node r3.cjs install` copies the planner from), the `needs-planner` blocker and its clearance (`c`, then
  `d`, `e`, `f`, `g --indep` and `exec --check` on a dry run, which `node r3.cjs clearance` runs and records in
  `run/<run-id>/clearance.json`; it passes only on `check-passed`), the tool timeout of the `r3.cjs trade` call, and
  its single `wake` call. `wake` sends the PSM3 ramp itself (between `e` and `f`). The trading routine is kept from
  driving the steps one by one instead of calling `wake` by its denied entries, auto mode's classifier for any
  variant on neither list, the agent's instructions, and `r3.cjs`'s own refusal of `exec` without `--check`,
  `halfb --send` and `wake` wherever `R3_KEYSTORE_JSON` or `R3_KEYSTORE_PASSWORD` is set. That refusal is keyed on
  those variables and on `r3.cjs planner`: the installed planner run directly, or `r3.cjs` with the variables unset,
  gets round it, so it is one layer, not a wall. The planner has no ramp subcommand.

## 9. Verification record

The table holds the sha256 of each file as git stores it (LF line endings), as of 2026-10-23. A Windows checkout with
`core.autocrlf` writes CRLF, which changes a raw hash, so normalize line endings before you compare. (The fingerprint a
setup records, `autonomy.planner_sha256`, is the raw hash of that machine's installed `planner.cjs`.) The first two
bullets below are the 2026-10-23 and 2026-10-19 records. The others are older: the offline suite and the fork
rehearsal from 2026-10-08, and the live read-only smoke from 2026-10-06, on earlier versions of some files. The
2026-10-08 files are the ones in this repository's first commit. Everything ran on Windows with `ethers` 6.17.0, on
Node v22.7.0 up to 2026-10-08 and v22.23.3 since 2026-10-19. Any edit to a file changes its hash; re-run the tests
after one.

| File | sha256 (LF line endings) |
|---|---|
| `planner.cjs` | `a0054b5680565e1bd3407bdb0ac311f396a1076e6e1b6768f02009fbee067a32` |
| `planner/blind.cjs` | `d8124939321970f8f207b48acbfcdc703e674b00c3b4b0e762afcad3fd035cc7` |
| `planner/c.cjs` | `970aecb2021a56246fdf2423572a14f73cf7a90387b5fd6e2d2adb30eb48dc91` |
| `planner/d.cjs` | `99568bacae8614a8dc2edb33c6451e2a79966d861d13616cf3b111ac3f9a267f` |
| `planner/e.cjs` | `72b99c27dea8c075b533336386b93dac4991b15c9a66ceef2449a866266afae2` |
| `planner/exec-core.cjs` | `f6d701b7516d308199009efa1ffd8f3b21f8f446966d3e61885a4c91fb1f61c6` |
| `planner/exec.cjs` | `981b17b2306d2763d2deb0481f311325f149b87255f1b886dfaf5e2b43f70fc5` |
| `planner/f-engine.cjs` | `54135dbde54f07904396962996582f2860f59c86391373e810947144577cf2c5` |
| `planner/f-lib.cjs` | `e05fa6f31a2763a29f6ecff5e10a2f155e29be83b690807f15b50b72e62232b0` |
| `planner/f-plan.cjs` | `0453a1bdb78cb3fb2e4a1401e3abbf9f78418648835d7c4840c870d2c856fd0f` |
| `planner/f-print.cjs` | `0d070caa3e3050c0ef5b879a422fecb4c38cf94f9a5fb6f5ede12f31c40d31b2` |
| `planner/f-probe-post3a.cjs` | `ae3b0d1eaf05d396005fdfcdbac7f5dfaf8e0a16611d8a1bc66c007139ed050a` |
| `planner/f-read.cjs` | `9b9a5411ad997e4e25af48919b8de9d90d515d3eec6483c5db8e944a911ff21e` |
| `planner/f-verify.cjs` | `87cb7ab6c7ae861dc745d27e5fe39207b29f6eb116119a1e4e494c93ae63880b` |
| `planner/f.cjs` | `996fd15bb7245225de01ceed561772c9d3d3a998c8ac59b0d405a61b8f75ec79` |
| `planner/g-audit.cjs` | `2bfcbf61e76797644a93b34d71218a8f528dc455903938bce58a2f42fc6c3754` |
| `planner/g-build.cjs` | `3a1a24a5bec7f3bcc95979d8bbce4af2e8b431802a9668ffdf6a3f60154d26f0` |
| `planner/g-emit.cjs` | `a3da2cda3d49d6760e32329bab4a01c2b9219239f5af38d0f56356021d02d0df` |
| `planner/g-indep.cjs` | `0d640518c7b3b00aea62c555a1f9d91e10030edc0bc24289f0ae5229d916645a` |
| `planner/g-lib.cjs` | `c997af2609ef2a4444ec570c8bc49f5e3ca6023061a762d4ff398f82ef6c3455` |
| `planner/g-read.cjs` | `9c2ef0ba358eeece76a5864f6a5ce6b4839d1ab62082682e08352d7fb76ef7d4` |
| `planner/g-verify.cjs` | `f39039008d9260e7e97729947858c4cc04606606a8f6268c33975d4474b625ad` |
| `planner/g.cjs` | `2e90acb6edee64e3cbd4f2bd1606adc8eb2a666535862742298c75f8c62a8738` |
| `planner/h.cjs` | `775f68189c74cd7a576df4cd9868a3be1218d26ec0b1f3771361a1fa4cad2eae` |
| `planner/halfb.cjs` | `f469de4b846564af34e12ecc301adb723853bb4aed3deb182348529d9b91e55d` |
| `planner/lib.cjs` | `6e50e70a6c45e0d8a5d3f9498fcbbf6399cd7c5f4d450d29f20738bb4ae67c86` |
| `planner/ramp.cjs` | `dc14003d7085f958d81a47fa2369dc94203c17c593340e4d154fd8691a8da086` |
| `planner/report.cjs` | `72697adb4c13bcb429526c948e9cceba7e193efa9aa28aba913c8d77ead07bc2` |
| `planner/table.cjs` | `4d4e00d9e90c9840dd7ac67e20e027ce9547ce989c8a4b402b424bd16083280d` |
| `planner/wake.cjs` | `89313626d955a158e48d0953fe53d6b3fad6516f1569652edf4556a5710b98c2` |
| `planner.config.example.json` | `ec6c35f8243941e66a464bc2551e9aa4d631701749b0bd30aa491b20d81e5fbe` |
| `planner.test.cjs` | `5b7748e4c0b6d65d6a8343be78fd9024799a184543637d6068a5a5901971e259` |

- **2026-10-24, the runner only.** The first cloud clearance stopped in G: a Claude Code cloud session sets
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, whose name trips the signer's environment tripwire, and G's check refused all 491
  transactions on it. `routine.cjs` now keeps Claude Code's own variables (`CLAUDECODE`, `CLAUDE_*`) out of every
  tool's environment, as it keeps the key variables out. No file hashed above changed. `routine.test.cjs`: 58 passed,
  0 failed (the new case fails on the old runner).
- **2026-10-23, an AI agent in the loop: D's `forecast-file` method and the routines.** New since 2026-10-19:
  `planner/blind.cjs` (the price-free Reality.eth reads of a research run-id); `d.cjs`'s `forecast-file` method
  (`forecastMethod`, `ai` being its first name: a forecast file at most `forecastMaxAgeHours` old, from any source,
  copied byte for byte and checked, its free-text method marked as this arm's in `base-forecast.json`); `lib.cjs`'s two
  config keys and the mark (`FORECAST_FILE_MARK`, the older `RESEARCH_METHOD_PREFIX` still recognized); `planner.cjs`'s
  `blind` subcommand; `wake.cjs` and `report.cjs` carrying the `no-forecast` status and the `forecast_file` block. The
  `csv` method, the default, is unchanged. **Offline**, `node planner.test.cjs --dir <scratch>` with `NODE_PATH` naming
  `ethers` 6.17.0: **128 passed, 0 failed, 1 skipped** (the symlinked-config case, as below), exit code 0,
  6382 s, on exactly the files hashed above (up to line endings). The new `forecast-file` section is thirteen of them.
  D also takes only an ISO 8601 UTC `generated_at` and names rows rather than quoting the file in its refusal notes,
  and `report.cjs` carries the method's sha256 instead of its text, so no forecast file's words reach the trading agent.
  `routine.cjs` (the runner, not hashed here) has its own offline suite, `routine.test.cjs`: 57 passed, 0 failed.
- **2026-10-19, the CSV base skill.** Only `lib.cjs`, `exec.cjs`, `h.cjs` and `wake.cjs` differ from the 2026-10-08
  files: they also accept run-ids whose forecast was researched (`lib.isArmForecastMethod`: seer-trade's D swapped in,
  or an earlier research add-on), so Half B, H and the wake's repair still see the positions those runs opened. The
  suite has no case of its own for such a run-id. **Offline**, `node planner.test.cjs --dir <scratch>` with `NODE_PATH`
  naming `ethers` 6.17.0: **117 passed, 0 failed, 1 skipped** (the symlinked-config case, as below), exit
  code 0, 7091 s, on that day's files (up to line endings), none of them modified during the run.
- **Offline**, `node planner.test.cjs --dir <scratch>` (`ethers` 6.17.0 in a parent folder's `node_modules`; no
  `NODE_PATH` needed): **117 passed, 0 failed, 1 skipped**, exit code 0, 3579 s, on the 2026-10-08 files (checked before
  and after the run). Added on 2026-10-07: TradeExecutor (`executor-session-key`) is refused before any helper or
  signer call by `exec-core`'s `presend` and `broadcast`, by `exec` (`--check` included), by `halfb --send` and by `wake`.
  Only that value refuses: `local-encrypted-eoa`, `eip7702`, `other-agent-signer`, a missing `signer_mode` and a missing
  record all pass. Also added: H counts a complex buy's `x` once, pinned on two rows of the first live run (herumi/mcl
  and ethereum/py_ecc) against a hand computation for UP, DOWN and INVALID. The fifteen cases added on 2026-10-06: the pre-send `simulate`'s answers in process
  (an RPC failure with no `"simulated":true` or the planner's own timeout to `transport`, a `-38xxx` refusal, a signer
  refusal and malformed output to their own stops, only a `"simulated":true` 0x0 to `stale-simulation`); the settlement
  scan's cursor (a cancel at `from_block` + 40,000 found over five settlements, every block read once, none skipped,
  `nonce-attempts.json` byte-identical); exec's `rpc-transport`, `rpc-http` 503, plain `rpc-error` and `-38014` answers
  (exit 5, 5, 5 and 3, nothing sent); the same failure on exec's, Half B's and the ramp's first pre-send `simulate`
  inside a wake (exit 5, nothing sent, the wake `aborted`); the recovery rule in the same run (a dual-buy completed,
  unwound by a sale of its stray UP leg, kept when its child went to arbitration and then finalized by the next wake's
  repair) and in the next wake's repair (unwound, its rows appended, the run-id finalized, then never acted on again);
  a 51-complex-buy plan through `exec --check` (its 51 sale proceeds read in 3 requests of at most 20 flagged calls)
  and through `exec` inside the wrapper (all 306 transactions sent); across the whole suite no simulate request flagged
  more than 20 calls. The skip is the symlinked-config case, because Windows refuses a file symlink to an account without
  that privilege (the junction cases ran). The synthetic plan: 6 rows on 5 markets (a set-sell, a pair as a dual-buy, simple buys of UP and
  DOWN, a complex buy), M = 10 with the bankroll binding, 28 transactions in 9 groups (the parent mint and the three
  middle mints first), the end state equal to the prediction on all 23 probed balances, all 28 sent with every group's
  balance effects exactly as simulated, then a middle merge (34 transactions) and a child redeem. Also: a pool moved by a
  third party after G (reported, the run completes); the start-of-run repair of a prior final run-id with an unsettled
  Half B write-ahead, of a not-sent finding on a signer that cannot pin the nonce over two wakes, and of a run-id that
  stopped at its ramp; a resolved middle A (the plan built and sent with every mint, a middle-B flip stopping the run
  before the parent mint, an `M = 0` plan); the merge-arb (6 pairs on held child Invalid, its 3b remainder, the
  cross-run Invalid row, every effect exact); the wake's PSM3 ramp (USDC and USDS converted before F, a capacity stop),
  `f --provisional`; the five gates; a Half B affordability skip; the once-only re-plan and the cut plan.
- **Fork rehearsal of the scheduled path** (2026-10-08, on the 2026-10-08 files). The setup:
  - a local anvil fork of Optimism mainnet at block 157,912,851, on loopback;
  - a throwaway holder funded on the fork with 50 sUSDS, 20 USDC and 1 ETH;
  - the installed helper, signer and planner, with the signer's real allowlist;
  - the real `.cmd` wrapper extracted from `steps/I-setup.md` (the Windows wrapper of that date, since replaced by `r3.cjs trade`, which takes the same lock, gates and exit codes), and a stub `claude` that runs `node <planner path> wake <run-id>` as the scheduled prompt did;
  - the real price-blind CSV, stored version 1.

  **Day 1** forced the recovery rule.
  - The wake ran the PSM3 ramp (20 USDC to sUSDS, 2 transactions). F then sized 91 rows on 81 markets (67.984788 sUSDS), and G built 93 groups and 450 transactions.
  - `exec` sent 7 groups, each group's balance effects exactly as simulated.
  - After the split of the first complex buy landed, a third party, impersonated on the fork and never the holder, sold 203.95 DOWN into that market's DOWN/repo pool.
  - The sale's pre-send quote then failed its floor (`stale-floor`). Completing the group no longer simulated clean, so the recovery rule unwound it: a merge-back of the whole 67.984788 split in 4 sends, all landed, recorded in `recovery.json`.
  - Half B merged the unspent repo tokens back. The wake ended `traded` with the Half A stop in `notes`, and the wrapper exited 3. In all, 132 transactions, every receipt successful.

  **Day 2** (the next wake, a new run-id) ran the full plan.
  - The start-of-run repair left the recovered group alone.
  - F sized 89 rows on 78 markets (50.984052 sUSDS, including 55 complex buys), and G built 90 groups and 442 transactions.
  - `exec` sent all 442. Every group's balance effects were exactly as simulated, and the end state equals G's prediction on all 319 probed token balances, to the wei, with sUSDS 0.
  - The wake ended `traded`, exit 0. The wrapper exited 6 because the rehearsal's setup record had no `max_turns_run_ids`, so the `RESIZE SCHEDULE` note was correct.

  **A third wake** used the same record with `signer_mode` `executor-session-key`. It ended `aborted` at the start check in 2 seconds with the TradeExecutor note. The wrapper exited 3, the holder's nonce did not move, and the signer log gained no line.
- **Live, read-only** (Optimism mainnet through the installed chain helper, pinned to `https://mainnet.optimism.io`;
  the signer configured and never run; nothing signed or sent): **6 passed, 0 failed, 0 skipped**, run twice on these
  files' predecessors and twice again after this round's changes, the last before the signer-throttle change of
  2026-10-06 (`lib.cjs`'s signer runner, `exec-core.cjs`'s pre-send `simulate` and `send`, and one rules line of
  `g-emit.cjs`), the half-done change (`wake.cjs`, and the repair rows of `exec.cjs` and `halfb.cjs`) and this round's
  changes (`exec.cjs`, `exec-core.cjs`, `wake.cjs`, `halfb.cjs`, `ramp.cjs`, `report.cjs`, `f-print.cjs`). Of those,
  `c`, `d`, `e` and `f` reach only one printed sentence of `f-print.md` (`f-print.cjs`: the planner sends every group
  as single transactions on any signer); they never run the signer (asserted) and the helper runner is unchanged. The
  live smoke was not run again after this round. `c`: 98
  candidates from the body, all tradeable, freshness 196/196 exact, no diagnostic failed, 12 helper calls, 21 to 33 s.
  `d`: the stored CSV, 83 forecasts, counts 83 / 0 / 0 / 15 equal to `current.json`. `e`: 83 blends, all priced from
  `candidates.json`. `f`: every one of the 25 checks passed; on a holder with no sUSDS, repo tokens held on 90 markets
  and child Invalid on 18, 39 rows on 33 markets (1 pair, 7 set rows, 30 single-side), `staked_M` 0, every market's
  stake within its budget; the one sub-1 market with held child Invalid (OffchainLabs/stylus-sdk-rs, I_j 28.77) sized a
  merge-arb of 15.1465 pairs (the whole pair bound) whose gain, 0.3669 repo tokens, did not clear step 7's 7-leg gas
  floor, so it keeps its 3b pair; 346 helper calls, 820 quotes, model-to-quoter gap at most 1e-17; 366 to 380 s.
- The chain helper the planner was tested against is byte-identical to the one shipped next to it:
  `chain-helper.cjs` sha256 `112440ea607441f40d3bb97f27d5f465de48ff23166712a85e33331b5a7418f9`, its own suite passed
  unchanged the same day (`chain-helper.test.cjs` 118 passed, offline and live; 93 passed offline again on 2026-10-08).
  The shipped `signer.cjs` is sha256
  `19d3598bb13983078eeac0a747120fa3a6886059764bcf212d1747b12be9eeef` (`signer.test.cjs` 111 passed, 2026-10-08); the
  live smoke configured its predecessor `8867cdda492fb06e71e9c3656705da6313ebddf3d99819065e0a2ba6f23c6a5d` and never
  ran it, and the two differ only in how `send` and `simulate` label an RPC error that is not a revert (signer README
  section 5). The offline suite runs a mock signer that answers the shipped one's shapes, the throttle included.
