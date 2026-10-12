# H-postmortem.md — close the loop with numbers, not prose

Turn resolved markets into an honest score of who was right and a **stated correction** that
`D-base-forecast.md` (D) applies next run. The channel is narrow on purpose (`seer-protocol` §10,
"`calibration_update` is a pointer and a summary"):

- **D** projects `./run/calibration.json`'s **`forecast` block** and applies each `active` knob by
  hand, naming what it applied in its `method` (D §2). It reads `calibration_update` as the index that
  says which knobs to expect — never as the data.
- **E has no calibration input at all.** It scores `w` fresh from the candidate data every run.
- So the **`blend` block is an audit record**, not an instruction, and **no blend-block number may
  appear in `calibration_update`** — `market_bias` is fitted against the price, and a price-derived
  figure reaching D re-anchors the pipeline's only independent step one run later. If the orchestrator
  wants a blend finding used, it quotes it into the next run's brief by hand, where it is visible.

A lesson with no number in it is not an output of this step.

**INPUT:** `./run/<run-id>/fills.json`, `blended.json`, `base-forecast.json`. Also reads, if present,
`allocation.json` for `ev` and `candidates.json` for `pools[].fee_tier` and `pools[].liquidity`;
everything else is derivable without them.
**OUTPUT:** `./run/<run-id>/review.json` (contract artifact 6) **and** `./run/calibration.json` —
outside the run directory, because it persists across runs. Mechanics in `seer-protocol`, chain facts
in `evm-onchain`. Say "onchain", one word.

## Procedure

**1. Collect the resolved set.** `blended.json` carries only `market` and `address` — take its rows
plus any `fills.json` market it lacks (an arbitrage leg on a market with no forecast, step 2) — so per
row read `Market(address).conditionId()`, then
`ConditionalTokens(0x8bdC504dC3A05310059c1c67E0A2667309D27B93).payoutDenominator(conditionId)` and
`getOutcomeSlotCount(conditionId)` onchain, at one block you record as `scored_at_block` — never an
indexer's `payoutReported` (Seer's Optimism indexer stalled at block 156,195,946, 2026-08-29).
`den == 0` → **pending**, not a miss: log `days_open` and capital locked, score nothing — 65 of Round
2's 98 children were still unanswered three months after the other 33 finalised, and nobody is paid to
answer them. A pending market is **not redeemable** — `redeemPositions` needs a reported payout — so if
it is past its resolution date the only exit is a complete-set merge on that market. Flag it for the
orchestrator; it is not a scoring row. On Round 3, a child whose middle has resolved without selecting
its repo sits on a worthless repo token — worth 0 however it resolves — so log it pending, owe no merge
for it, and do not wait on it.

Otherwise the realised outcome is the **CT payout vector** `oᵢ = payoutNumerators(conditionId, i)/den`
— on a scalar answered 96 of 100, `[0.04, 0.96, 0]`; on an Invalid resolution, `[0, 0, 1]`. There is no
winner to pick and no special case for scalars, multi-scalars or Invalid: everything below scores
against `o` directly.

**2. Score three ways on the same question.** `own_p` = `base-forecast.json` `p`; `market_p` =
`blended.json` `market_price`; `blended_p` = `blended`. All three already sum to 1 — D floors
`invalid_p` above zero and E floors every entry at **0.005** and renormalizes. Do not re-floor, and
never rebuild `market_p` from the pools: a post-resolution `slot0` is not the price you traded against.
A market with no forecast — a blank CSV cell means unknown, so D wrote no row and E no blend — has
`own_p`, `blended_p`, `market_p` and their Brier and log fields `null` by design (`seer-protocol` §10).
Its forecast-free arbitrage legs (`set-sell`, `merge-arb`, a sub-1 pair) are still positions; any
step-5 quantity that needs the missing `B` or `M0` is `null` too, so there the five need not sum to `pnl`.

**Fit on the raw forecast, not on a corrected one.** D's `method` ends with `calib=none` or
`calib=<version>` plus the knobs it applied (D §2), and D records the pre-knob triple inside
`reasoning` as a literal `p_raw=[…]`. So: `calib=none` → `p` **is** the raw forecast, fit on it;
`p_raw` present → fit on `p_raw`; a knob you can invert and no `p_raw` → subtract it and fit on that;
anything you cannot invert → fit nothing own-side and say why in `do_not_update`. Fitting a knob on a
forecast that already contains it is how a shift compounds into an anchor.

| metric | formula | note |
|---|---|---|
| Brier | `Σᵢ (pᵢ − oᵢ)²` | 0..2; with `p_inv = 0` it collapses to `2(p_up − f)²` |
| log | `−Σᵢ oᵢ·ln(max(pᵢ, 1e-4))` | count the clamps into `log_clamps` |
| floor | `H(o) = −Σᵢ oᵢ·ln oᵢ` | report `log_excess = log − H(o)` |

Cross-entropy floors at `H(o)`, not 0, so **never average raw log across types** — use `log_excess`.
`log_clamps` counts entries that hit the `1e-4` guard; on a vector from D or E it is always 0, so any
count is an upstream bug, not a score. Copy E's `complete_set_sum` when present: above 1 means the
pool's implied Invalid `1 − up − down` was negative before E floored it. Flag that row
`market_p_clamped: true` — it is a complete-set arb signal that F takes without any forecast, and it
must never be scored as directional market skill.

**3. Fit `w*`, do not assume it.** Grid `w ∈ [0,1]` step 0.05 over `q ∝ own^w · market^(1−w)`
(renormalized), minimizing mean Brier across all resolutions **of one market type**. Shrink before
writing: `w_new = (n·w* + k·w_default)/(n+k)`, `k = 10`; at most one row of E's `w` table per update,
only at `n ≥ 8`. Blend beat both → `w` about right; market beat blend → `w` too high; own beat blend →
too low. Beating the market on one question tells you nothing — the residual SD on Round 2
originality was 0.168.

**4. Separate bias from noise**, per type, in the type's natural space (`E[f|valid]` for scalars, `p`
for binaries):

- `bias = mean(forecast − realised)`, `se = sd/√n`, `t = bias/se`. **The knob is `shift = −bias`** —
  store the bias as the shift and you double the error. `noise = sd(residual)` is **not** fixable by
  calibration; it means smaller stakes, or research that discriminates.
- Bucket by forecast band, ≥ 5 rows per bucket, and report `n`, `mean_p` and `realised_mean` for each.
  Bias large at one end and absent at the other is **compression**; a flat shift is the wrong fix.
- Compare MSE against the constant predictor "always the base rate". If the constant wins, the level
  was all the signal there was.

Write one `by_type` row per (type, forecaster) into `review.json`: own, market and blend each get one,
which is how you see whether the blend inherited a bias from one side.

**5. Attribute the P&L.** Per position, per-token in `pnl_unit`, `q = filled`. `side` carries G's
vocabulary: `"<outcome>"` → `s = +1`, index it **by the exact string, case included**; `"short
<outcome>"` → `s = −1`, same index; `"mint"` → a parent-level row (on Round 3, the parent mint or a middle mint): score
nothing. `route` likewise carries the vocabulary of whichever G wrote the file, so **map it through
`seer-protocol` §10's table before dispatching** — a `fills.json` from `../../deep-r3-trade/steps/G-mint-and-trade.md` says
`simple-buy` for `direct`, `complex-buy` for `split` and `buy-and-merge` for `merge-arb`, and its
`sell-exit` / `redeem` rows are exit legs of a position, not positions of their own. The same holds for a
`sell-exit` row in this arm's own file: G §8 writes a recovery unwind sale that way, an exit leg of the
position on that market and side. An unrecognised
`side` or `route` is not scored: name it in `do_not_update` rather than guessing a frame. On
`"pair"` and `"set"` the frame follows the **route**: `pair-carry` and `merge-arb` sum `B, M0, M1, F`
over the **pool-traded legs only** — Invalid has no pool (`getPool` returned `0x0` for every R3 child
and the parent), so it has no `M` to quote and enters only as inventory; `set-sell`, `split` and
`fade` are framed on what you **retained**, below.

```
B  = blended_p[side]                    what you believed
M0 = raw market_price[side]             the price you decided against. E renormalizes only where it
                                        floored a negative leg, so on a market_p_clamped row take
                                        market_price[side] × (complete_set_sum + 0.005); elsewhere
                                        its entry is already the raw pool price
M1 = mid immediately before your fill   slot0 at receipt.blockNumber − 1, via tx_hash
F  = fill_price        F_ex = F − s·fee/q   realised execution, and it ex-fee
R  = realised_outcome[side]             CT payout per token, from step 1
```

`fills.json` carries **no fee and no gas** — derive both. `fee = (fee_tier/1e6) × notional × legs`,
`fee_tier` read from C's `pools[].fee_tier` or the pool's `fee()` and never assumed: every R3
originality pool is tier **100 = 0.01%/leg**, but other Seer markets may sit on other tiers and guessing
100 there undercounts by up to 100×. Legs: 1 `direct`, 2 `pair-carry`/`set-sell`/`merge-arb`, 1 per leg
actually sold on `split`/`fade`; a Router `splitPosition`, `mergePositions` or `redeemPositions` pays
no pool fee at all. Gas: from the receipt at `tx_hash`, `gasUsed × effectiveGasPrice` plus the L1 leg
from `GasPriceOracle` (`evm-onchain`), pro-rated across that batch's positions.

No `tx_hash`, or no archive node at that height? Fall back to `M1 ≈ F − s·slippage_vs_quote` — G signs
`slippage_vs_quote` so positive is worse on **both** sides, so dropping the `s` credits every sell's
slippage as profit. It folds quote-to-send drift into `slippage`: mark those rows `pivot: "quote"` and
keep them out of `execution.timing_haircut_bps`.

`R − F = (R−B) + (B−M0) + (M0−M1) + (M1−F_ex) + (F_ex−F)`; multiply through by `s·q`:

| term | value | the fix when it dominates |
|---|---|---|
| `resolution_surprise` | `s·q·(R−B)` | research — unless the market missed it too |
| `edge` | `s·q·(B−M0)` | the only term your thesis earns |
| `timing` | `s·q·(M0−M1)` | quote and send closer together; the pool moved without you |
| `slippage` | `s·q·(M1−F_ex)` | your own size against the book — size down or split the batch |
| `fees` | `−fee_unit` | derived above; dominating fees mean the trade was too small to run |

The five sum to `pnl` by construction. **Gas stays out of the identity** — report `gas_native` in ETH;
there is no verified ETH→collateral rate, and sUSDS is not $1 and is not ERC-4626 on Optimism.

**Frame every mint-and-sell route on what you HOLD, never on what you minted.** On `split`, `fade` and
`set-sell`, take `q = filled` — the target tokens in the wallet when the run ends — and `F = fill_price`,
which G already writes as net collateral *per that same token* (`G-execute-trade.md` §"fills.json") —
except on `set-sell`, whose `fill_price` is proceeds per set (below). Do
**not** substitute "complete sets minted". The two coincide on a plain `split`, which is why the error
hides, and they diverge on any route that recycles its sale proceeds into more of the target leg —
`../../deep-r3-trade/steps/G-mint-and-trade.md`'s `complex-buy`, which `seer-protocol` §10 aliases to `split`. On that step's
own `solidity-lib` example (mint 0.30 sets, sell 0.30 DOWN for 0.0817, buy 0.1106 more UP — illustrative
arithmetic on pre-seeding depth; the v3 pools are much deeper (e.g. py_ecc UP ≈ 1.14e21 raw liquidity vs
2.3e19) — re-quote before use) the position holds **0.4106 UP against 0.30 sets**: framing on sets
drops 0.1106 × `o_UP`, understating the position by 27%. `filled` is right for both because G defines
it as target tokens on exactly these routes. Read the unit off G's own route→unit table (`G-execute-trade.md`, `fills.json` notes): target tokens on `direct`,
`split` and `fade`; **sets** on `set-sell`; **pairs** on `merge-arb` and `pair-carry`. Map an aliased
route through `seer-protocol` §10 *first*, then take the unit — and carry that unit into `pnl_unit`
rather than assuming tokens.

`R` is the realised payout **per target token**, plus retained legs credited per target token:
`R = realised_outcome[side] + Σ oᵢ·(amountᵢ/q)` over `retained_legs`. Credit them at their realised `oᵢ`
or every split looks worse than it was by the value of its Invalid leg. `retained_legs` names legs by
token address only — map each to its outcome index with the market's `wrappedOutcome(j)`, whose order
on a scalar child is **[DOWN, UP, Invalid]**, so a retained Invalid is index 2 and pays `o₂`. A
`set-sell` is the same frame with `q` in sets: `F = 1 − fill_price` per set — a `set-sell` row's
`fill_price` is collateral of proceeds per set, above 1 when profitable (`seer-protocol` §10), so `F`,
the retained Invalid's net cost, is negative exactly when the sale paid — `B = blended_p[Invalid]`,
`M0 = 1 − complete_set_sum` (negative on a clamped row — that negative **is** the arb), `R = o₂`.

A **`merge-arb` settles before resolution**: the Router returns 1 per set and consumes one Invalid,
marked at `blended_p[Invalid]` (G §5), so `R = 1 − blended_p[Invalid]` and `R − B = 0` **exactly** —
a merge has no `resolution_surprise`, and its whole P&L is `edge + timing + slippage + fees`, with
`edge = B − M0` your `P(valid)` against the board's `complete_set_sum`. A `pair-carry` held to
resolution keeps a real surprise: `R = o_DOWN + o_UP`.

Split `resolution_surprise` by comparing `|R−B|` against `|R−M0|`: the market missed it too →
`unknowable`; the market had it and you did not → `research_miss`. These two partition
`resolution_surprise` and go in a **sibling** field `resolution_surprise_split`, never inside
`attribution` — a consumer that sums `attribution`'s five values must not double-count them.

**6. Score decisions, not outcomes.** A market in `blended.json` with no `fills.json` row, or with one
whose `status` is `skipped` or `reverted`, is a **no-trade**: score its Brier, `pnl: 0`, label
`no_trade_saved` or `no_trade_missed` by whether it resolved against or with the direction your blend
implied, and carry G's `error` string as the reason — both are forecast records, not P&L. A `partial`
is a real position: score it at `filled`, never at `requested`. A losing position with positive
ex-ante EV is a success; a winning one with negative EV is luck. A mean P&L `m` over `n` positions
with SD `s` is evidence only if `|m| > 2s/√n`; below that, write the number and write "not evidence".

**7. Recompute `calibration.json` from every `run/*/review.json` on disk.** Never increment the
previous file — a shrink applied to a shrink collapses every forecast to its anchor. Dedupe by
`conditionId`: one market forecast in two runs is one resolution.

**Exclude the control arm's runs from every fitted knob.** Both pipelines write under
`./run/<run-id>/`, so a naive sweep of `run/*/review.json` fits the reasoned arm's corrections on the
naive arm's numbers and the A/B measures nothing. Filter per run directory: fit **`forecast`-block
knobs** (`own_bias`, `shrink`, `invalid_floor`, `base_rate_anchor`) only where that run's
`base-forecast.json` `method` is **not** `csv-face-value`, and fit **`w*`** only where its
`blended.json` `method` is **not** `identity`. A control-arm run's `p` is a human's cell taken at face
value with `p_invalid` flatly 0 — a fine thing to score, and never a thing to calibrate on. When the
dedupe puts a control row and a reasoned row on one `conditionId`, keep the reasoned one.
`execution` and `scope` may use both arms, since fills are fills; say in `do_not_update` which runs
were excluded and why.

Fill the two non-forecast sections by formula:

- `execution.slippage_bps_by_liquidity_band[b] = mean(−slippage / notional) × 10⁴` over rows in band
  `b`, with `notional = filled × fill_price` in that market's own collateral and the band taken from
  C's `pools[].liquidity`; `timing_haircut_bps = mean(−timing / notional) × 10⁴`;
  `fill_ratio = Σfilled / Σrequested`.
  **Use only rows with `pivot: "slot0"`** — a quote-pivot row has no valid timing/slippage split.
- `scope.by_type`: `forecasts` = rows in `base-forecast.json`; `positions` = `fills.json` rows with
  `status` `filled` **or** `partial` — a partial fill is a position;
  `research_yield = positions/forecasts`; `pnl_per_forecast = Σpnl/forecasts`
  (per *forecast*, not per trade — research on a market you never traded still cost you);
  `never_answered_rate = n_pending/(n_pending + n_resolved)`. Verdict `drop` when
  `pnl_per_forecast ≤ 0` **and** `n_resolved ≥ 8`; `narrow` when `research_yield < 0.2` (tighten C's
  filter rather than dropping the type); else `keep`.

## Worked example — Round 2 originality, real resolutions

Every vector is `[DOWN, UP, Invalid]`, the market's own `wrappedOutcome` order. `ethereum/eips`
resolved 96.00 → `o = [0.04, 0.96, 0]`. Market (R2 data function, final snapshot) `down 0.5182,
up 0.4962` → `complete_set_sum 1.0144`, so the implied Invalid was `−0.0144`; E's 0.005 floor and
renormalization give `[0.50834, 0.48676, 0.0049]`, flagged `market_p_clamped`. Own (illustrative)
`[0.09, 0.88, 0.03]`; `w = 0.25` → blend `[0.3656, 0.6258, 0.0086]`.

| | Brier | log | log_excess (`H(o)=0.1679`) |
|---|---|---|---|
| own | **0.0098** | 0.2190 | **0.0511** |
| market | 0.4433 | 0.7183 | 0.5503 |
| blend `w=0.25` | 0.2178 | 0.4902 | 0.3222 |

`w*` here is 1.00 (Brier falls monotonically in `w`). **n = 1: no update.** One row cannot move a knob,
and this row was picked knowing the answer.

The aggregate is what can be acted on — all 33 resolved Round 2 children joined to the juror sheet
(`deepfunding/oss-evals`, arithmetic mean per repo, matched 33/33 against the onchain answers):

| band (market `up`) | n | mean `up` | realised mean `f` | bias |
|---|---|---|---|---|
| 0.00–0.50 | 4 | 0.4523 | 0.7850 | **−0.3327** |
| 0.50–0.60 | 7 | 0.5321 | 0.7214 | −0.1893 |
| 0.60–0.70 | 7 | 0.6531 | 0.7986 | −0.1455 |
| 0.70–0.80 | 13 | 0.7355 | 0.7921 | −0.0565 |
| 0.80–1.00 | 2 | 0.8039 | 0.7500 | +0.0539 *(n<5, inactive)* |

Aggregate `bias = −0.1303`, `sd = 0.1682`, `se = 0.0293`, `t = −4.45`, MSE `0.0444`; `shift = +0.1303`
takes MSE to `0.0274`, a 38% cut. But the best linear recalibration is `f̂ = 0.6286 + 0.2271·up`,
MSE `0.0198`, `r = 0.179` — SE ≈ 0.18 at n = 33, indistinguishable from zero — while the constant
"always 0.775" scores `0.0205`. The price carried a level and essentially no ranking information, and
`f` is itself a mean of 1–6 juror ratings, mostly one.

**And the whole thing writes `active: false`** — that is the point of the example.

- `market_bias["scalar:originality"] = {shift: +0.13, space: "E[f|valid]", n: 33, n_eff: 1, t: −4.45,
  grade: "C", active: false}`: drained-pool snapshot prices of unknown vintage, and all 33 sit in one
  contest judged by one jury, so `n_eff = 1` against a threshold of 12. It also lives in `E[f|valid]`
  space — adding it unconverted to an R3 `upPrice` is a unit error: `upPrice` is
  `(1 − p_inv)·E[f|valid]`, with `p_inv = P(child INVALID | evaluated)`, priced conditional on the repo
  being evaluated, so `P(evaluated)` does not enter it.
- `base_rate_anchor["scalar:originality"] = {value: 0.775, n: 33, n_eff: 1, grade: "B",
  active: false}`: onchain-exact outcomes set its **grade**, not its independence. 0.775 is one jury's
  leniency — a level term like any other, killed by the same `n_eff = 1` rule. Activating it would
  anchor every unsourced Round 3 repo to a Round 2 jury.
- Nothing about `w`: Round 2 has no own-forecast column, so `w*` is unfittable from it.

## Hard rules

- **The inputs are frozen artifacts.** `market_p` from `blended.json`, `o` from
  `payoutNumerators`/`payoutDenominator` at a stated block — never a price re-read after resolution,
  never an indexer. Fit only on a forecast that does not already contain the knob: D's `method` says
  what it applied, and if you cannot invert it, `do_not_update`.
- **Never update on n = 1**, and state `n` on every knob. `n` = distinct conditionIds; one contest is
  one observation for a level term.
- **Score Invalid resolutions**, against `[0,0,1]` — the only evidence `invalid_floor` has.
- **Never carry a correction across a numeraire change**, or between spaces without converting, and
  **recompute `calibration.json` from scratch** every run.
- **Every figure carries its unit.** A child P&L is in parent outcome tokens, never sUSDS; convert with
  the parent's own numerators, at every level. On Round 3 a child's collateral is a **repo token** — an
  outcome of its bundle's middle market — worth `1/N` sUSDS (`N` = repos evaluated; `1/98` only if all
  are) if its repo is evaluated and 0 if not, never 1 (`seer-protocol` §4): read
  `payoutNumerators`/`payoutDenominator` on the middle and the parent, and while either is unresolved
  call the sUSDS figure a scenario. A child is priced and scored conditional on its repo being
  evaluated, so never multiply in `P(evaluated)`: an unevaluated repo's child sits on a worthless repo
  token and is worth 0 however it resolves.
- **This step spends nothing and signs nothing.** Every call here is `eth_call` or a receipt read.
  Never read, print or ask for a private key — H needs no signer at all. If a redeem or a merge is
  owed, write it into `lessons` with the market, the outcome indexes and the amounts, and hand it to
  the orchestrator, which builds it, simulates it and gets a human yes before anything is sent. Never
  re-send or re-run a trade to "check" a fill: read the receipt at `tx_hash` instead.

## Output schema — review.json

```jsonc
{ "generated_at": "<ISO>", "run_id": "<id>", "scored_at_block": 157552977,
  "resolved": [ { "market": "<name>", "address": "0x…", "condition_id": "0x…",
    "kind": "scalar", "type": "scalar:originality",
    "own_p": [0.09,0.88,0.03], "blended_p": [0.3656,0.6258,0.0086],     // all [DOWN, UP, Invalid]
    "market_p": [0.50834,0.48676,0.0049], "market_p_clamped": true, "complete_set_sum": 1.0144,
    "realised_outcome": [0.04,0.96,0],
    "brier_own": 0.0098, "brier_market": 0.4433, "brier_blended": 0.2178,
    "log_own": 0.2190, "log_market": 0.7183, "log_blended": 0.4902,
    "log_floor": 0.1679, "log_clamps": 0, "w_used": 0.25, "w_star": 1.00,
    "side": "<echoed from fills.json>", "route": "<echoed from fills.json>",
    "pnl": 0.0, "pnl_unit": "<the market's own collateral — a parent outcome token on a child>",
    "gas_native": "0.0000012", "ev_ex_ante": null,
    "attribution": { "edge": 0, "slippage": 0, "timing": 0,        // these five sum to pnl
                     "resolution_surprise": 0, "fees": 0 },
    "resolution_surprise_split": { "unknowable": 0, "research_miss": 0 },   // partition, not addends
    "pivot": "slot0|quote",
    "decision": "traded|no_trade_saved|no_trade_missed" } ],
  "by_type": [ { "type": "scalar:originality", "forecaster": "own|market|blend",
    "n": 33, "n_eff": 1, "bias": -0.1303, "se": 0.0293, "noise_sd": 0.1682,
    "mse": 0.0444, "mse_constant": 0.0205,
    "buckets": [ { "band": [0.50,0.60], "n": 7, "mean_p": 0.5321, "realised_mean": 0.7214 } ] } ],
  "pending": [ { "market": "…", "address": "0x…", "days_open": 84,
                 "capital_locked": 0, "unit": "…" } ],
  "totals": { "pnl": 0, "pnl_unit": "…", "n_scored": 0, "n_pending": 0,
              "mean_brier_own": 0, "mean_brier_market": 0, "mean_brier_blended": 0,
              "evidence": false },
  "calibration_update": "calib=2026-09-29T18:00Z | forecast block: NO ACTIVE KNOB — own_bias not fitted (n=0), invalid_floor 0.03 unchanged (n_invalid=0), base_rate_anchor inactive (n_eff=1). Apply order if any activate: anchor, shift, shrink, floor, rebuild. | blend block: audit only, D must not read it; one knob was written inactive. | detail ./run/calibration.json@2026-09-29T18:00Z",
  "lessons": [ { "claim": "…", "evidence_n": 33, "acted": false, "why_not": "n_eff=1" } ] }
```

**`calibration_update` is a pointer and a summary** (`seer-protocol` §10). D applies knobs from the
projected `forecast` block of `calibration.json`, so this string's job is to say **which** knobs are
active, in what space, and in what order — plus the inactive ones, so D can see that nothing was
withheld — and to point at the file. Two hard constraints: it carries **no `blend`-block figure**,
because a price-derived number reaching D re-anchors the price-blind step; and a bare path with no
summary makes D apply nothing, which is correct, since D's rule is "do not invent a correction the
review did not state".

## Output schema — calibration.json, and how its findings reach D and E

At `./run/calibration.json` — outside `run/<run-id>/`, because it spans runs. **It is the data; the
`calibration_update` string is only the index to it.** Every knob carries `n`, `n_eff`, `grade` (A onchain-exact / B derived /
C contaminated source) and `active`. **An inactive knob is still written** — that is the record.
`n_eff` is what the thresholds test: for any **level** term (`own_bias`, `market_bias`,
`base_rate_anchor`) it is the number of distinct contests or juries, not markets.

```jsonc
{ "schema": "seer-calibration/1", "version": "<ISO>",
  "recomputed_from": ["run/<id>/review.json", …], "n_resolutions": 33,

  "forecast": {            // the ONLY block D reads. No price-derived number may appear here.
    "base_rate_anchor": { "scalar:originality": { "value": 0.775, "space": "E[f|valid]",
                          "n": 33, "n_eff": 1, "grade": "B", "active": false } },
    "own_bias":  { "<type>": { "shift": 0.0, "space": "E[f|valid]", "n": 0, "n_eff": 0,
                               "active": false } },
    "shrink":    { "<type>": { "lambda": 0.0, "anchor": "base_rate|0.5|uniform",
                               "n": 0, "active": false } },
    "invalid_floor": { "<type>": { "value": 0.03, "n": 0, "n_invalid": 0, "active": false } } },

  "blend": {               // audit only. E reads nothing; a human hands it on. Never quote it to D.
    "w_default": 0.25, "w_shrink_k": 10,
    "w_by_type":   { "<type>": { "w": 0.25, "w_star": null, "n": 0, "active": false } },
    "market_bias": { "scalar:originality": { "shift": 0.13, "space": "E[f|valid]", "n": 33,
                     "n_eff": 1, "t": -4.45, "grade": "C", "active": false } },
    "market_bias_buckets": [ { "band": [0.0,0.5], "shift": 0.33, "n": 4, "active": false } ] },

  "execution": { "slippage_bps_by_liquidity_band": [], "timing_haircut_bps": 0,
                 "fill_ratio": 1.0, "n": 0 },     // sizing and fill evidence for F and G

  "scope": {               // next run's selection verdicts, for C
    "by_type": [ { "type": "<type>", "forecasts": 0, "positions": 0, "research_yield": 0.0,
                   "pnl_per_forecast": 0.0, "n_resolved": 0, "never_answered_rate": 0.0,
                   "verdict": "keep|drop|narrow" } ],
    "min_liquidity": null, "min_edge_pts": null },

  "do_not_update": ["base-forecast.json method named a correction I could not invert — own_bias not fitted"] }
```

**D is the only step that reads any of this automatically, and only the projected `forecast` block.**
C, E, F and G have no calibration input at all, so `blend`, `execution` and `scope` are evidence the
orchestrator must hand them — quote the numbers into the next run's brief, or they are inert. That is
deliberate for `blend`: it is fitted against the price, and the only safe path from it to a forecast
runs through a human who can see it happening.

**Spell the application order out inside `calibration_update`**, because D applies it by hand and a
different order is a different forecast: derive `f` price-blind, then **anchor** (an active
`base_rate_anchor` replaces `f` when D found no market-specific source, and then `own_bias` is
**skipped** — it was fitted on real forecasts, not on the anchor), else **shift** by `own_bias.shift`
in the named space, then **shrink** `λ` toward the anchor (0.5 for a binary or scalar, `1/k` for a
k-outcome categorical when no anchor is active), then **floor** `p_invalid`, then rebuild
`p_up = (1−p_inv)·f`, `p_down = (1−p_inv)·(1−f)`. D ends its `method` with `calib=none` or
`calib=<version>` naming each knob applied, and records the pre-knob triple as `p_raw=[…]` inside
`reasoning`. Those two are the only way the next H tells a raw forecast from a corrected one; without
them, own-side fitting stops.

**A blend-side finding does not land by itself, and that is the design.** E takes no calibration
input, so `w_by_type` and `market_bias` are written, graded and left inert until a human reads them
and decides. To act on one, the orchestrator states it in the next run's brief in E's own terms — a
`w` change as **one row of E's Δw table**, with a Δw and a reason; a `market_bias` as a shift with its
space named — and E records it in `w_reason`, which is the only field a later H can reconstruct a
`market_price` from. Never route a blend finding through `calibration_update`: D reads that index, and
`market_bias` is price-derived.

**Activation thresholds** — below them, write the knob with `active: false`:

| knob | min | max move per update |
|---|---|---|
| `own_bias` | `n_eff` ≥ 8 | 0.05, cumulative cap 0.15 |
| `w_by_type` | `n` ≥ 8 | one row of E's `w` table |
| `market_bias` | `n_eff` ≥ 12 | 0.10 |
| `invalid_floor` | `n` ≥ 10, with ≥ 2 Invalid resolutions | 0.03 |
| `base_rate_anchor` | `n_eff` ≥ 20 | — |
| any bucket | `n` ≥ 5 | — |

> **Last verified:** 2026-09-29. Round 2 figures recomputed from
> `deep.seer.pm/.netlify/functions/get-originality-markets-data` joined to the `Originality R1` sheet in
> `deepfunding/oss-evals` (juror means matched 33/33 against onchain answers). Re-check any market you
> score with `ConditionalTokens.payoutNumerators`/`payoutDenominator`.
