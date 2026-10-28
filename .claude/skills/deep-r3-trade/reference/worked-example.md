# Worked example — deep-r3-trade, 0.30 sUSDS at the 2026-09-29 book prices

> This example belongs to the **deep-r3-trade** skill and is worth reading before a first run: it is one
> end-to-end pass, D through H, of a supervised run (optional: setup has none, and the first trade is usually a
> scheduled run or a trade now). Step files referred to here are `../steps/*.md`, and
> "gate 4" and the other gate numbers are the four gates in `../SKILL.md`. Gates 2–4 bind supervised mode; in
> autonomous mode the standing authorization and G §8's pre-send checks (`../steps/G-mint-and-trade.md` §8,
> *Two modes*) take their place, and nothing waits for a per-batch "yes". The structure is Round 3's
> (parent → three middles → 98 children on **repo tokens**) and the market addresses are the v3 markets
> of the same repos. **The prices are from the 2026-09-29 book, before the v3 pools were seeded
> (2026-10-01); the live v3 book differs, so F reads the pools (`../steps/F-max-ev.md` step 1).** Every fill, swap output,
> `quoted_fill`, cap and exit quote is **illustrative arithmetic on pre-seeding depth; the v3 pools are
> much deeper (e.g. py_ecc UP ≈ 1.14e21 raw liquidity vs 2.3e19) — re-quote before use.** Nothing here
> is recomputed; never trade from it — check `../SKILL.md`'s *Last verified* footer before trusting any
> of the mechanics live.

0.30 sUSDS is, in this example, the holder's total sUSDS after the PSM3 ramp (`../steps/I-setup.md` I.1 §5);
no per-run size is chosen.

**D — the human's CSV.** Exactly two columns, `repo,originality`, originality a float in [0,1], blank
cell means unknown (no forecast).

```csv
repo,originality
https://github.com/DefiLlama/chainlist,0.70
https://github.com/dl-solarity/solidity-lib,0.85
https://github.com/paradigmxyz/reth,
```

Three data lines, `reth` gets no forecast for its blank cell (so no directional trade; the
forecast-free arbitrage — set-sell, merge-arb, sub-1 pair — still runs, so if its book sums below
1 − f, F step 3b still buys it as a pair), two forecasts survive. D writes
`p = [p_down, p_up, p_invalid] = [0.30, 0.70, 0.0]` and `[0.15, 0.85, 0.0]`, `price_seen: false`
(`p_invalid = 0`: conditional on evaluation, the child resolves to a score).
Case is preserved exactly as written and never tidied — `DefiLlama/chainlist` really is spelled that
way, and an unmatched row stops the run rather than being guessed at.

**E — identity.** `blended = own`, verbatim, `w = 1.0`. E's recorded copy of the live book is
consulted by nobody: F seeds its plan from `candidates.json` `pools[]` and tests and quotes on the pools'
onchain state (`../steps/F-max-ev.md` step 1). `reth` has no blend row
(blank cell); its book below is from `pools[]`, which is where F step 3b starts from. **Illustrative
only:** the addresses are the v3 markets, but the prices are the 2026-09-29 book, not the live v3
book; a run's markets and repo tokens come from `../steps/C-select.md`'s table or the data function, and
its prices from the pools (`pools[]`, then onchain), never from this file.

| market | address | bundle | DOWN | UP | sum |
|---|---|---|---|---|---|
| DefiLlama/chainlist | `0x4b8bda29…` | A | 0.3975 | 0.4657 | **0.8632** |
| dl-solarity/solidity-lib | `0x4b62af2f…` | B | 0.2807 | 0.7366 | **1.0174** |
| paradigmxyz/reth | `0xd2652335…` | C | 0.1391 | 0.7725 | 0.9115 |

**F — which side, and how much.** First, per market and inside that market's own budget — the repo
tokens it already holds (none on this first run) plus its `M` newly minted — step 3a takes a set-sell on every market with `(P_up + P_down)·(1−f) > 1` (sum above
`1/(1−f)` ≈ 1.0001), or, below `1 − f` and only where the holder already holds that market's child
Invalid, a merge-arb up to that Invalid; then step 3b buys what remains of every market with
`P_up + P_down < 1 − f` as an equal-quantity UP+DOWN pair, CSV or not. After that, a directional side is
a trade when `p_side·(1−f) > price_side` at the post-arbitrage price, `f = 0.0001`.
Written as a band on the CSV value, the directional rule is exact and worth internalising:

| market | sum | band on `originality` (step 3 test, pre-sweep spot) | width | CSV | taken |
|---|---|---|---|---|---|
| chainlist | 0.8632 | **dual-buy** (0.4657, 0.6025) | 0.1368 = 1 − sum | 0.70 | pair (3b), then UP only from what the sweep leaves of chainlist's own `M` repo tokens, tested at the post-sweep price and folded into the pair's UP row |
| solidity-lib | 1.0174 | **no-trade** (0.7193, 0.7366) | 0.0174 = sum − 1 | 0.85 | set-sell (3a), then UP only, tested at the post-set-sell price |
| reth | 0.9115 | dual-buy (0.7725, 0.8609) | 0.0885 | — | pair (3b), despite the blank cell |

Below the band, DOWN only; above it, UP only; inside it, **both sides when sum < 1 − f** and neither
when sum > 1 − f. Note the consequence: when sum < 1 − f the no-trade band is empty, so **on any sub-1
market the CSV scores at all, at least one side passes F's entry test.** Where both sides would pass,
3b has already bought the pair, so the directional pass adds at most one side; together with the
sweep, this is the baseline's largest single exposure. The CSV does not gate the sweep: `reth` at
0.9115 is bought as a pair despite its blank cell, and chainlist at 0.8632 gets its pair before any
directional UP.

Sizing: both trades' zero-marginal-EV caps are well above 0.30, so
`M = min(0.30, max_j (cap_j − held_j)⁺) = 0.30`, nothing held yet — **bankroll-bound**. There are 98 independent budgets, not one per
bundle: `M` sUSDS mints `M` repo tokens for **every** repo, and repo token `j` can only be spent on market
`j`. In each market step 3a's set-sell or merge-arb spends first, then the sweep's pair, then the
directional side at post-arbitrage prices, each to its own zero-marginal-EV stop, capped by `M` — no
cross-market water-fill, and never pool across markets. The repo tokens a set-sell or merge-arb returns
are not recycled in the run.

**Illustrative arithmetic on pre-seeding depth — pre-sweep, directional-only figures, not recomputed;
the v3 pools are much deeper — re-quote before use.** The
positions and totals below were computed on the 2026-09-29 book before step 3b, with chainlist's and
solidity-lib's whole 0.30 each in its one directional trade. A live run adds, first, step 3a's
`side: "set"` rows — a `route: "set-sell"` row on every market above `1/(1−f)`, CSV row or not (`stake` =
`q`, `ev` = proceeds − `q`, `p_win` and `edge_pts` null, `worst_case` 0), and a `route: "merge-arb"` row
on a sub-1 market only where its child Invalid is already held — then the UP and DOWN legs
of every sub-1 pair (chainlist, reth, and every other sub-1 market, CSV row or not — each from its own
repo tokens). chainlist's post-sweep directional UP, if it passes, is not a second row: it is
**folded into the pair's UP row** (token count `q` + the extra, quoted with `quoteExactOutputSingle` at
that count, so `stake = amountIn` and `quoted_fill = amountIn / count`) — one row per market and side.
reth's legs carry `p_win: null`, `edge_pts: null` and an `ev` share of the pair's scored-case gain, and
the plan print groups each pair as "pair (sum < 1 − f)" with `q`, its locked-in sum, both outcomes and
any folded directional extra on its own line (`../steps/F-max-ev.md`).

```
positions:
  DefiLlama/chainlist      up  stake 0.30 ORIG_R3_REPO:DefiLlama/chainlist       quoted_fill 0.4813  edge_pts 21.87  ev 0.1363  p_win 0.70
  dl-solarity/solidity-lib up  stake 0.30 ORIG_R3_REPO:dl-solarity/solidity-lib  quoted_fill 0.7446  edge_pts 10.54  ev 0.0425  p_win 0.85
totals: staked 0.30 sUSDS, expected_value 0.0018 sUSDS, correlated_worst_case −0.30
```

`stake` and `ev` are in **repo tokens** of that row, each row spending its own repo token. `totals.expected_value` is in **sUSDS**, converted at the
labelled `1/N` scenario (`N` = repos evaluated across A, B and C) — `1/98` at all-evaluated, 0 if the
repo is not evaluated — with no bundle factor: here (0.1363 + 0.0425) × 1/98 = 0.1788/98 ≈ 0.0018; `totals.staked` is `M` in sUSDS (the mint) and `correlated_worst_case` is `−M`, neither converted. `p_win` is a
**payout fraction**, not a probability — 0.70 UP pays 0.70 repo tokens.

**→ gate 2 (supervised mode): human reads `allocation.json` and approves. An autonomous run builds and
sends the plan in the same run, without this "yes". →**

**G — onchain.** Mint at three levels, then one route decision per market's UP/DOWN rows, decided by the
sides held and `sum`; a `set` row arrives with its route already fixed by F step 3a (`set-sell` or
`merge-arb`) and G only executes it. The mint is the parent split, then one middle split per bundle holding a position — each by `M`,
not by its own max stake, and each its own `[approves + split]` atomic group and transaction, recorded as
a parent-level `side: "mint"` row like PARENT-MINT (for a middle, `market` = the middle's address), not
scored. A bundle with no position is not split, and its `M` bundle tokens stay as leftovers.

These groups assume an atomic signer (`atomic_batches: true`; EIP-7702 recommended). A non-atomic signer
may trade too: it runs the same calls as an ordered sequence of single transactions, so a group can be
left half-done between transactions — the whole sequence simulated first, each transaction re-checked
against its floors before it is sent, and any failure stops the sequence and re-quotes: in supervised
mode the recovery batch needs its own explicit "yes"; in autonomous mode the group is completed if
completing it clears its floors, and otherwise what landed is unwound (sell the stray leg, or merge back),
logged in the same run-id (`../steps/G-mint-and-trade.md`).

**Illustrative arithmetic on pre-seeding depth — pre-sweep, directional-only figures, not recomputed;
the v3 pools are much deeper — re-quote before use**, from the
swap lines of this block through the early-exit comparison below; `RT` is the row's repo token. chainlist's
SIMPLE-BUY is one-side route arithmetic; under 3b chainlist and reth each carry a pair, routed as
`dual-buy` (`../steps/G-mint-and-trade.md` §3), and each market's repo tokens go to its pair before any
directional row; a `set` row goes first on its market, as its own group whose floors, with an atomic
signer, make it revert rather than realise a loss.

```
split(sUSDS, parent,  0.30)  ->  0.30 A + 0.30 B + 0.30 C + 0.30 parent-Invalid
split(sUSDS, middleX, 0.30)  ->  burns 0.30 X; 0.30 of each of X's repo tokens + 0.30 middle-X Invalid
                                 (once per bundle X holding a position: A for chainlist, B for
                                 solidity-lib, C for reth's pair)

chainlist     sum 0.8632 < 1  -> SIMPLE-BUY   0.30 RT -> 0.6234 UP        (pool 0.4657 -> 0.4970)
solidity-lib  sum 1.0174 > 1  -> COMPLEX-BUY  split 0.30 RT -> 0.30 of each leg,
                                              sell 0.30 DOWN -> 0.0817 RT, buy -> 0.1106 UP
                                              = 0.4106 UP + 0.30 child Invalid
                                              (simple would have bought only 0.4029 UP)
```

Fills land as `fill_price` 0.4813 on chainlist and **0.7306** on solidity-lib (0.30 / 0.4106, net outlay over
total tokens, `../steps/G-mint-and-trade.md` §3) — better than F's 0.7446
direct quote, because the complex route beat the pool. Every number in this block is a single-range
tick model on pre-seeding liquidity; real fills come from QuoterV2 and then from the receipt, and
`tx_hash` is whatever the send returns. `retained_legs` lists everything not spent, one entry per token with amounts summed (`../steps/G-mint-and-trade.md`, *Output*): 0.30 solidity-lib
child Invalid (`wrappedOutcome(2)` on that market — read it, it is not in this file), 0.30 parent Invalid
`0xe0d849F4…`, 0.30 of each split middle's Invalid, any unsplit bundle tokens, every market's unspent
repo tokens **`M − S_j`** (up to 98 entries) plus whatever its set-sell or merge-arb returned (not
recycled), and each set-sell's `q` child Invalid, where `S_j` is market `j`'s step-3a, sweep and
directional spend.
Merge-back is three levels, child first (`../steps/G-mint-and-trade.md` §5), each an atomic
`[approves + merge]` group sized by the `min` of its inputs: child (DOWN + UP + child Invalid → repo
token), middle (**every** repo token of bundle X + middle-X Invalid → X), parent (A + B + C + parent
Invalid → sUSDS). The middle `min` runs over a whole bundle's leftovers and is usually 0 after trading, so
unspent repo tokens — value-neutral, each worth `1/N` sUSDS if its repo is evaluated, else 0 — mostly
wait for resolution.

**The default at settlement is to hold.** Max-EV does not close a winning position early: under the
CSV's own 0.85, holding 0.4106 UP is worth ≈ 0.349 RT at resolution, against a best exit of 0.3008 RT.
So session 2 normally goes straight to redeem. Exit early only on human instruction in a supervised
session — and then quote both routes. An autonomous run never makes a discretionary exit: it merges
complete sets already held, runs merge-arb against held child Invalid, and redeems each level once resolved.

**The complete set — session 2, only if a supervised session exits early.** The complex-buy minted 0.30 child Invalid,
which is what makes a child merge reachable at all, so G quotes both exits and takes the larger:

```
merge-exit : buy back 0.30 DOWN (−0.0817 RT), merge 0.30 sets (+0.30 RT), sell 0.1106 UP (+0.0815 RT) = 0.2998 RT
sell-only  : sell all 0.4106 UP                                                                        = 0.3008 RT
```

Sell-only wins **here, and only because the sum is above 1** — paying 1 RT per set for legs the market
values at 1.0174 is a loss. On a chainlist-like 0.8632 the same three calls recover
`q × (1 − sum)` more than selling, for `q` sets. That is the whole test: quote both, take the larger,
every time.

Keep the merge route implemented even when it loses today, because it is the only exit that does not
need an oracle: **if nobody ever answers a repo's question, the market never resolves and redeem is
unavailable — a child merge is the only way out, and it needs all three legs.** Round 2 is the
precedent: 65 of its 98 children are still unanswered. That matters for an evaluated repo; an
unevaluated repo's legs are worth 0 once its middle resolves without selecting it, whatever its child does.

And note what the merge needs to turn a sum below 1 into repo tokens now: child Invalid **already held**.
A child merge burns DOWN + UP + child Invalid together, and child Invalid has no Uniswap pool at any fee
tier, so a sub-1 set can be bought and closed only against child Invalid that an earlier set-sell or
complex-buy on that market left behind. That is step 3a's merge-arb, below `1 − f` and up to that
balance: buy `q` UP + `q` DOWN, merge with `q` held child Invalid, and `q − cost` repo tokens are
realised at execution (`fills.json` records it as `buy-and-merge`). **`1 − (up + down)` is the market's price of child Invalid** — of "this repo
is evaluated but its child question resolves INVALID"; never-evaluated is carried by the middle, where the
repo token pays 0. `../steps/F-max-ev.md` step 3b buys what remains of every market with `up + down < 1 − f`
as an UP+DOWN pair of `q` tokens a side held to resolution — a value arbitrage: with `sum` its locked-in cost per pair,
`+(1 − sum)·q` repo tokens on an evaluated repo, and nothing of value lost on an unevaluated one, whose
repo tokens were worth 0 in that state anyway. Two residual risks, never a gate: **(a)** the repo is
evaluated but its child question resolves INVALID anyway, and UP + DOWN then pay 0 (not for merge-arb
pairs, which are closed at execution); **(b)** the parent's
count `n_X` and the middle's selection `k_X` are separate Reality questions that must agree — if they
don't, a repo token pays `(n_X/N)/k_X`.

**G — at resolution (session 2).** Redeem is three levels, child first, and the order is load-bearing;
each level is gated on its own `payoutReported`: each resolved child into repo tokens, every held leg
included (both legs of a 3b pair pay 0 if the child resolves INVALID, which costs value only on an
evaluated repo — residual risk (a)); then each resolved middle into bundle tokens, any unspent `M − S_j`
repo tokens (plus what step 3a returned) and middle Invalid included; then A / B / C / parent-Invalid into sUSDS. Redeem never waits on an unevaluated repo's child, which may never resolve: once its middle has
resolved without selecting it, its child legs are worth 0 and the middle and parent redeem proceed. A
redeem needs no complete set: you redeem whatever you hold, losing legs included, and a losing leg returns
0 without reverting. Every level is gated: gate 4 in supervised mode; in autonomous mode each redeem
batch is sent after its own simulation and `payoutReported` check, with no per-batch "yes".

**H — after that.** On a fresh run no market has settled, so H writes no `review.json` and says `nothing settled yet` (`../steps/H-no-learn.md` step 1); once markets settle, score the run into `review.json` — realised payouts, Brier for `own`, `blended` and
`market`, PnL attribution — and **change nothing.** PnL per market is in its repo tokens, converted to
sUSDS at the labelled `1/N` scenario (`1/98` all-evaluated), and 0 if its middle does not select the repo.
A market counts as settled when its child resolves, or when its middle resolves without selecting the
repo — then without waiting for the child: `realised_outcome` unknown, PnL in sUSDS terms, Brier fields
null, counted in PnL (middle-mint rows, like PARENT-MINT, are not scored). A 3b pair on a market with
no CSV forecast (`reth` here) still gets a `resolved[]` row with `pnl` and attribution, its forecast and Brier fields `null`, and
stays out of every Brier comparison (`../steps/H-no-learn.md` step 6). A `set` row carries no forecast
either: its Brier fields are null unless its market has a CSV row, which is then scored as usual; its
attribution puts the locked gain in `edge`, a set-sell's kept child Invalid in `resolution_surprise`, and
a merge-arb settles at execution with `resolution_surprise` 0.

**Day 2 — the next autonomous run, on a held book.** This happens only if, at setup, the operator
said yes to autonomous daily trading and to running the signer without prompting, the signer passed its
allowlist self-test (a distinct allowlist refusal for every off-allowlist case and acceptance of the
allowlisted call, through its policy-only entry point; `../steps/I-setup.md` I.1 §7), and the setup run's
no-send clearance passed (`../steps/I-setup.md` I.2 §1, §7);
otherwise day 2 is another supervised run. One `CADENCE` later the scheduled run opens a fresh run-id and
runs C → D (the stored CSV) → E → PSM3 ramp of any USDC/USDS → F → G → H with no per-batch "yes". Say
prices have moved back below target. G §1's guard is per run-id and per plan: it stops this run's plan
from being sent twice, and no longer refuses a row because day 1 already holds that side — buying more of a
held side still below its target is what max-EV sizing intends. F's budget per market is the repo tokens
of that market already held plus a new mint `M = min(free sUSDS after the ramp, max_j (cap_j − held_j)⁺)`,
any unsplit bundle token may be middle-split first, and F reads each market's repo-token and child-Invalid
balances but no UP/DOWN balance, because max-EV's marginal value per token does not depend on holdings.
Day 1 here was bankroll-bound — all 0.30 sUSDS minted — so a market whose repo tokens were all spent buys
again only from new sUSDS (a deposit, USDC/USDS the ramp converts, or sUSDS a parent merge or redeem
returned), while a market still holding repo tokens, unspent or returned by a set-sell or merge-arb,
starts from those. F sizes the new buys; G simulates the whole ordered sequence, re-checks floors, the
resolution boundary and fresh `slot0`, writes `inflight.json` and sends. The same run merges any complete set already held, runs
merge-arb against held child Invalid, redeems every level that has resolved, and writes
`./run/<run-id>/wake-status.json` (`traded`, or `nothing-to-do` when nothing clears) and a short `report.md`.
