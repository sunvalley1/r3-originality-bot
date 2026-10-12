# E-reconcile-price.md — step E: blend your number with the price

The price is another forecaster's opinion. Combine it with yours; do not overwrite yours, do not defer
to it, and write down how much of each survived.

**INPUT:** `./run/<run-id>/base-forecast.json` and `./run/<run-id>/candidates.json`
**OUTPUT:** `./run/<run-id>/blended.json` — `w` and `w_reason` mandatory on every row. Schema at the end.

Outcome order, the scalar triple and Invalid are defined in `seer-protocol`; chain and RPC facts in
`evm-onchain`. This file is only the blend.

## 1. Load and check the inputs

- The controller resumes E only after a fresh no-history D worker returns. `base-forecast.json` must
  carry `price_seen: false`; check its actual handoff/context boundary too. If it is true, reasoning
  quotes a price, or inherited priced context reached D, **stop** and discard the forecast. Fix the
  boundary and restart D in a new clean worker without that estimate. Never lower `w`, edit the flag,
  or rerun the contaminated worker to rehabilitate an anchored forecast.
- Any `0` in an `own` vector requires a new clean D attempt, never the floor in §2 — §7 explains why a
  zero is unrecoverable. Give only the validation defect and approved price-free inputs, never E's prices,
  desired direction or rejected estimate; flooring it silently rewrites D's forecast.
- Join on `address`, **lowercased on both sides**. One response mixes both cases — the R3 data function
  returns `id`, `wrappedTokens` and `collateralToken` checksummed but pool `token0`/`token1` lowercase —
  so a raw compare silently drops rows. Report the count matched.
- A forecast with no candidate row has no price and is outside C's scope: **exclude it** and report
  it, rather than emitting it with an invented weight.
- A candidate D left without a forecast (unknown; with the CSV forecast swapped in for D, a blank
  field) gets no blend row either — never invent an `own` for it. F makes no directional trade on it,
  and its forecast-free arbitrage still runs.
- Drop any candidate with `tradeable: false`. A drained pool keeps its last `sqrtPriceX96` forever, so
  a dead market still shows a plausible price with no counterparty behind it.
- **A multi-scalar parent has no price of its own.** The R3 parent `0x37ab5cbeee3a32289430e5d38b914ec7f580fd87`
  is 3 outcomes (Bundle A/B/C) plus Invalid. Each bundle token is the collateral of a multi-categorical
  middle whose outcomes are the **repo tokens** — the collateral side of all 196 child pools — but
  **nothing prices a bundle or a repo token in sUSDS**, and parentInvalid has no pool at all, so there is
  no vector to blend against. Its outcomes are not probabilities either: Bundle A redeems at
  `n_A/(n_A+n_B+n_C)`. The three middles are excluded too: a selected repo pays `1/k_X` bundle tokens,
  not a probability, and a middle's Invalid has no pool. Exclude them; never synthesise a price for them.

## 2. Build the market price vector

One pool price per traded outcome, in the same order D used, then `1 − Σ` for Invalid — for a scalar
that is `[downPrice, upPrice, 1 − down − up]`. `seer-protocol` §10 fixes the order and that rule; the
arithmetic below is what E adds.

**Never renormalize the traded legs to sum to 1.** The third entry is the pool's own price for Invalid;
discarding it re-introduces the `P(valid)` error that `seer-protocol` §10 exists to prevent. On the
Round 3 board the sums run 0.8632–1.2114, median 1.0000, 36 of 98 below `1 − f` (2026-10-01) — so that
entry is real money: `1 − 0.8632 = 0.1368` is what the board charges for ethpandaops/ethereum-package
being evaluated and its child question still resolving INVALID. It is not a price for "never
evaluated": an unevaluated repo's child sits on a worthless repo token, so `P(evaluated)` does not enter
a child's price (`seer-protocol` §4).

Then, once: floor every entry at **0.005** (not `MIN_PRICE` 1e-8 — see §7) and renormalize to 1. Record
`complete_set_sum` whenever the raw sum leaves 1, because above 1 the third entry is negative and the
floor would otherwise launder it into fake directional edge. Use that one floored vector everywhere
below, **including the `w = 0` hold path**.

**Where "above 1" is actually a trade.** 41 of 98 print above 1 (2026-10-01), from residue a hair over
it up to `smartcontracts/simple-optimism-node` at 1.2114. The hurdle is `seer-protocol` §7's —
**`sum > 1/(1 − f)`** ≈ 1.0001 at fee tier 100 — not 1.02. **Clearing the fee hurdle is not clearing
the trade:** gas, booked in repo tokens at `1/N`, and the depth the quote walks still decide whether it
pays and at what size. E records `complete_set_sum` and stops there; F quotes it with `QuoterV2` at the
depth-limited size and decides, independently of `w`.

Prices from a data function come from a subgraph. Re-read `liquidity` and `slot0` onchain **before
blending**, not merely before sizing: a blend on a stale price is your view mixed with an hour-old
ghost. Read `token0`/`token1` before inverting anything yourself — both orientations are live here, e.g.
`ethereum/py_ecc` has the outcome as `token0` in its UP pool (raw price ≈ `upPrice`, within 0.01%: `seer-protocol` §6) and its repo
token as `token0` in its DOWN pool (raw price ≈ `1 / downPrice`).

## 3. Score w

`w` is the weight your own view keeps. Start at **0.25**, add the rows that apply, clamp to
[0.10, 0.80]. Every row that fires goes into `w_reason` with its number.

| observation | where it comes from | Δw |
|---|---|---|
| depth: a 5-point price move costs < 1 collateral unit | see below | +0.10 |
| depth: a 5-point move costs 1–10 units | same | +0.05 |
| depth: > 100 units absorb 5 points | same | −0.10 |
| < 5 swaps, or ≤ 2 distinct traders, since creation | `traded.swaps`, `traded.distinct_traders` | +0.10 |
| price still within 2 points of the creator's seed | `traded.seed_price_delta` | +0.10 |
| no trade in > 72h | `traded.hours_since_last` | +0.05 |
| price moved > 5 points on volume in the last 24h, **by a counterparty that was not repricing the whole board at once** | per-swap `sqrtPriceX96`, and the `recipient` topic on those Swap logs | −0.10 |
| siblings on the same event mutually inconsistent | your own check, §4 | +0.10 |
| siblings consistent **and independently traded** | §4 | −0.10 |
| a primary source the price-setter plainly never read | your research, §5 | +0.15 |
| market-type competitiveness | table below, **one row only** | −0.10 … +0.05 |
| any field above is null | — | **do not score that row.** A whole-block `traded: null` also caps `w` at 0.35: not knowing whether a market is traded is not evidence that it is not |

**Computing the depth row.** Percentile rank is not the rubric; collateral is. Within one LP range the
collateral needed to move the price 5 points is `L · |√P₁ − √P₀|`, with `P` the outcome token's price in
collateral — the data function's `price` is already oriented that way, so the formula is identical in
both token orders. Or quote it with `QuoterV2.quoteExactOutputSingle`. Measured across 196 R3 pools on
2026-09-29 — illustrative arithmetic on pre-seeding depth; the v3 pools are much deeper (e.g. py_ecc UP
≈ 1.14e21 raw liquidity vs 2.3e19) — re-quote before use: **0.13 to 1.35 collateral units, median 0.72,
93% under 1**. Which depth row fires on the v3 board is unknown until you re-quote it.

**The overlap rule.** "Under 5 swaps" and "price still on the seed" are usually the same fact wearing
two hats. Take the larger, never both; likewise for the two depth rows. Double-counting one
observation is how a defensible 0.35 becomes an indefensible 0.60. Rows that pull opposite ways are a
different case and both count: few trades *and* a large recent move is a thin, contested book.

**What actually discriminates here.** Score per market, since `w` is per market. Pre-seeding history —
the pools of the 2026-09-29 book, counted against chain time 2026-09-29T17:58:51Z (block 157552977); the
v3 pools are new, so re-count from their own `Initialize` before use: every pool had 1–4 swaps (never
5) and ≤2 distinct traders on 175 of 196, so the activity row fired on **all 98**; depth fired on 93%;
market type adds +0.05; the overlap rule swallowed the seed-distance row whenever activity fired, which
was always. Of the rows left, staleness fired on 1 of 196 pools (195 last traded within 24h, median
3.0h), so the +0.15 primary-source row was the only real lever.

**The −0.10 move row looks like the discriminator and is not — check this before letting it fire.** On
the same pre-seeding history, 57 of 98 markets moved > 5 points on a leg within 24h. But all 423 swaps
across all 196 pools were received by **three addresses**, and one of them,
`0xc7ac690a7b44d270263ac85d86f9e08d8302d77c`, took the most recent swap in **195 of 196 pools**, nearly
all inside blocks 157547595–157547603. That was one forecaster revising one book in one batch, not 57
markets discovering a price against each other; scoring −0.10 on each counts a single opinion 57 times,
exactly as §5 forbids. **Test:** group the qualifying moves by Swap `recipient` and block, and if one
address moved a majority of the board in one batch, the row does not fire.

On that history R3 `w` sat at **0.50** on essentially every market, not the 0.25 default; recompute it
on the v3 pools before reusing the figure. Where one value does fall out across a board, say so in
`w_reason` rather than dress it up as a per-market judgement.

Who trades this kind of question, and do they know more than you:

| counterparty | Δw | why |
|---|---|---|
| the people who decide it — coinholder votes, token governance, grant committees | −0.10 | they trade their own poll |
| liquid and professionally traded — prices, rates, macro, sports | −0.10 | you are the least informed participant |
| dated protocol or release events | −0.05 | core devs hold a timeline you do not |
| general news, elections, widely covered events | 0.00 | |
| niche technical scoring with no insider class — repo originality, code quality | +0.05 | nobody can know the answer yet either |
| a contest whose entrants are models driving one public interface | +0.05 | but read §5 before cashing that in |

Take the closest single row. R3 Originality matches both of the last two and still scores **+0.05
once, not +0.10** — they are one fact (a model-priced niche) described twice.

## 4. The sibling check, and what it is actually worth

Cheap, and it catches misread questions. Where a parent has N children each pricing a piece of one
quantity, sum the children's implied quantities and ask whether the parent can support the total.
Round 3 Originality's children are not such a set: each prices its own repo's score conditional on that
repo being evaluated, so their `up + down` sums carry no count the parent must support, and the sum
check has nothing to test there.

**Coherence alone still scores Δw = 0**, because consistency is evidence only when independent parties
priced the siblings. All 196 R3 pools carry exactly one balanced LP range, and across all 196 there are
only two distinct tick boundaries — `−39123/−203` and its token-order mirror `202/39122` (2026-10-01).
One seeder, one template — any coherence is theirs, not the market's. Inconsistency still earns +0.10
whoever priced them: an incoherent book is incoherent regardless of authorship.

## 5. The model-correlation rule — hard

**If the price was set by a model and you are a model, agreement proves nothing.** You are the same
prior twice, reasoning from the same public record in much the same way.

- **Never write "agrees with the market" as a reason to lower `w`,** and never let it shrink your
  Invalid estimate. Deferring to your own reasoning played back is not deference.
- **Disagreement with a correlated forecaster is the stronger signal.** If you and a model-set price
  diverge, one of you used something the other did not. Find out which before trading.
- Only hard data the price-setter plausibly never used breaks the correlation — a prior round's exact
  tallies, a resolved sibling's onchain payout, zero replies on the application thread. Only that
  earns the +0.15 row.
- deep.seer.pm is a model-versus-model contest by construction ("test your model at deep.seer.pm").
  Assume every price there was produced the way yours was.
- You may raise `w` because nobody has traded (a liquidity fact), never because you like where the
  seed landed (an opinion fact). Keep the two apart in `w_reason`.

## 6. The 25-point gate

If `max_i |own_i − market_i| > 0.25`, **stop and find out why before trading.** A gap that size is
usually a misread question, not an edge. Check, in order: the encoded question text rather than the
title; the bounds (a scalar's `0..100e18` against a `[0,1]` score is a 100× trap); which sibling you
are on; whether the price is in a parent outcome token rather than the chain's collateral; whether
resolution has already been reported.

The controller investigates this gate. If verified question/policy/bounds facts require a new forecast,
correct only the factual price-free handoff and start a new no-history D worker. Do not disclose the
observed gap, market price, desired side or previous estimate to it.

One such misread on Round 3: a `p_invalid` that still carries P(not evaluated). A child prices
conditional on its repo being evaluated (`seer-protocol` §4), so its `p_invalid` is only P(evaluated but
the child resolves INVALID), which is small; a D that folded R2's evaluation rate (33 of 98, parent
`0xdb3aae8d1c964767eeaa17805be25cded7a17210`, `payoutDenominator = 33`) into it fires this gate across
the board.

If you cannot settle a gate, emit the row with `w = 0`, `blended = market_price`, and a `w_reason`
naming what you could not resolve. **`w = 0` overrides the [0.10, 0.80] clamp.** It is how this schema
says "no trade": F sees zero edge on every outcome and opens nothing. Leaving `w` wherever the rows put
it and having F find nothing is also a correct outcome — say so rather than manufacture edge.

## 7. The log-opinion pool

For each outcome i, with your `own` and the floored `market_price` from §2:

```
unnormalised_i = own_i^w × market_i^(1−w)
Z              = Σ_i unnormalised_i
blended_i      = unnormalised_i / Z
```

`w = 1` returns your view untouched, `w = 0` returns the price exactly, and the result always sums
to 1. Two properties that cost money when forgotten:

- **It is zero-preserving.** `0^w × anything = 0`. An outcome written as 0 stays 0 whatever the market
  says, and F sizes as though it cannot happen. That is the arithmetic reason Invalid is never 0, and
  why §2 floors at 0.005 rather than 1e-8: a 1e-8 floor is alive on paper and dead in practice — at
  `w = 0.5` it contributes ~1e-4 and still vanishes.
- **It is geometric, so more decisive than a linear blend** — and on a scalar `p_up` is an expected
  payout fraction, not a probability, so geometric pooling here is pragmatic, not a theorem. The gap is
  small at these weights (0.91 points at most in §8); still compute the linear blend and report both
  when they differ by more than 2 points on a market you intend to trade.

## 8. Worked example — DefiLlama/chainlist, Round 3 Originality

Market `0x4b8bda295e28375ed17abc8d1472e9cccadc93aa`, scalar `[DOWN, UP, Invalid]`, a child of Bundle
A's middle at outcome 20; collateral its repo token `0x6f7b1d0411f5e3d1908fa09b1cec4e9968b03095`.
**Illustrative arithmetic:** the prices are from the 2026-09-29 book, and the depth and history figures
are pre-seeding — the v3 pools are new and much deeper (e.g. py_ecc UP ≈ 1.14e21 raw liquidity vs
2.3e19), and v3 chainlist read 0.7118 UP / 0.2883 DOWN at 2026-10-01 spot. Re-quote before use; the
method is what carries over.

**Price.** `upPrice 0.4657`, `downPrice 0.3975`, sum `0.8632` — the cheapest complete set on that
book. `market_price = [0.3975, 0.4657, 0.1368]`. Nothing floors, nothing is negative.

**Observations.** The data function returns no pool address, so derive it:
`UniswapV3Factory.getPool(UP, repoToken, 100)` → `0x50caec635571df16182d70e5b94ab17a01bac719`, with
token0 = the repo token and token1 = UP, so its raw pool price is `1 / upPrice`. Then `eth_getLogs`
for `Initialize` and `Swap` on both pools from creation. On the pools of the 2026-09-29 book that read
gave (pre-seeding history, not these v3 pools'):

| | UP pool | DOWN pool |
|---|---|---|
| seeded (Initialize), 182.5h ago | 0.4061 | 0.5938 — seed sum **0.9999** |
| swap 1, 93.4h ago, to `0xf7f3223f…` | → 0.6943 | → 0.3057 |
| swap 2, 3.0h ago, to `0xc7ac690a…` | → 0.4657 | → 0.3975 |

Two swaps per pool at the same two blocks: two dual-leg trades, two distinct recipients. The seed sum
was 0.9999; trading pushed it to 0.8632, so **the 0.1368 Invalid price is traded, not seeded** — and
the last trade moved UP 22.9 points.

| row | value | Δw |
|---|---|---|
| default | | 0.25 |
| depth | 13.30 × (√0.5157 − √0.4657) = **0.47** collateral units per 5 points, so < 1 | +0.10 |
| activity | 2 swaps per pool, 2 distinct counterparties | +0.10 |
| seed distance | UP +6.0 pts, DOWN −19.6 pts from seed — not fired | 0 |
| staleness | last trade 3.0h ago — not fired | 0 |
| moved on volume | UP −22.9 pts, 3.0h ago, qualifies on size and recency — but `0xc7ac690a…` took the last swap in 195 of 196 pools in the same 8 blocks, so **suppressed per §3** | 0 |
| siblings | no sum check applies to R3 children (§4) — not fired | 0 |
| primary source | none held at the time — not fired | 0 |
| market type | niche technical scoring, model counterparties | +0.05 |
| **w** | | **0.50** |

**Own**, from D and price-blind: `p_invalid = 0.25`, `E[f | the child resolves to a score] = 0.35`, so
`own = [0.4875, 0.2625, 0.2500]` — a large `p_invalid`, kept to exercise the arithmetic; on an R3 child
it is P(evaluated but the child resolves INVALID), which is small. Largest gap against the price is
20.3 points on UP — under the gate.

```
DOWN     √(0.4875 × 0.3975) = 0.440206
UP       √(0.2625 × 0.4657) = 0.349637
Invalid  √(0.2500 × 0.1368) = 0.184932
Z = 0.974776
blended = [0.4516, 0.3587, 0.1897]        linear would be [0.4425, 0.3641, 0.1934]
```

**What this hands F.** UP is 10.7 points dear against the blend, DOWN 5.4 cheap, Invalid 5.3 cheap.
Invalid has no pool at any fee tier, so any long-Invalid view can only be expressed by splitting a
repo token and selling traded legs. Route choice is F's, and the two routes are far apart. Valuing
what you sell at spot and what you keep at the blend, per repo token split: fading UP (sell UP,
keep DOWN + Invalid) is `0.4657 + 0.4516 + 0.1897 = 1.1070`; selling both legs is
`0.8632 + 0.1897 = 1.0529`, worse because it dumps the cheap leg too. Neither is an arbitrage — both
are long-Invalid at the board's 0.1368 against your 0.1897 — and the 0.4657 is a spot quote on a pool
0.47 units deep (pre-seeding), so F re-quotes at its own size.

## Hard rules

- **Never blend a forecast that saw the price** — `price_seen: true` invalidates the step — and never
  blend past the 25-point gate: investigate, or emit `w = 0`.
- **Never write a `w` without a `w_reason` carrying every row's number, fired or not.** "Seems thin"
  is not a reason; "0.47 units per 5 points" is.
- **Never renormalize UP and DOWN to 1 on a scalar** (that third entry is the price of Invalid) and
  **never floor a zero in `own`** — restart D through its clean input boundary. Floor only `market_price`, at 0.005.
- **Never record agreement with a model-set price as corroboration** — same prior twice.
- **Never blend a market flagged `tradeable: false`**, one with a reported payout, one in arbitration,
  or a multi-scalar parent or R3 middle — no pool prices their outcomes in the chain's collateral, so
  there is no vector to blend against.
- **Never score one actor's repricing as N markets' worth of evidence** — group the qualifying moves by
  Swap `recipient` and block before letting the −0.10 row fire.
- **Keep the unit** — a child's prices are in its parent outcome token, not sUSDS; F carries `stake_unit`.
- **E spends nothing and signs nothing.** Read-only RPC (`eth_call`, `eth_getLogs`) and two files in,
  one file out: no signer, no approval, no send, and it never reads, prints or asks for a private key.
  Anything that spends is F's plan and G's send, simulated first and approved by a human.

## Output — blended.json

The row is §8's example: prices from the 2026-09-29 book, and the depth and history figures in
`w_reason` (`L`, units per 5 points, swaps, recipients, seed) are illustrative arithmetic on
pre-seeding depth; the v3 pools are much deeper (e.g. py_ecc UP ≈ 1.14e21 raw liquidity vs 2.3e19) —
re-quote before use.

```json
{
  "generated_at": "2026-09-29T18:40:35Z",
  "method": "log-opinion pool q_i ∝ own_i^w · market_i^(1-w), renormalised; market floored at 0.005",
  "blends": [
    {
      "market": "DefiLlama/chainlist — average originality score, Round 3",
      "address": "0x4b8bda295e28375ed17abc8d1472e9cccadc93aa",
      "own": [0.4875, 0.2625, 0.25],
      "market_price": [0.3975, 0.4657, 0.1368],
      "w": 0.5,
      "w_reason": "0.25 default; +0.10 depth (L 13.30, 5pt move costs 0.47 repo-token units); +0.10 activity (2 swaps per pool, 2 distinct recipients since Initialize); moved-on-volume row SUPPRESSED (UP -22.9pts 3.0h ago qualifies on size and recency, but 0xc7ac690a7b44d270263ac85d86f9e08d8302d77c took the last swap in 195 of 196 pools within blocks 157547595-157547603 - one book revised in one batch, not 57 independent repricings); seed-distance not fired (UP +6.0pts, DOWN -19.6pts from seed 0.4061/0.5938); staleness not fired (3.0h); sibling row not fired (no sum check applies to R3 children); no primary source held; +0.05 niche technical scoring, counterparties are models with no access to unpublished jury data. Agreement with the price was NOT used as a reason.",
      "blended": [0.4516, 0.3587, 0.1897]
    }
  ]
}
```

Those seven fields per row are the contract and F reads exactly them. `complete_set_sum` (whenever the
raw sum leaves 1), `linear_blend` (when it differs from the log blend by more than 2 points) and
`gate: "held"` (on a `w = 0` row) are **optional annotations**: emit them, but no downstream step may
depend on one, so a reader that ignores them loses nothing.

> **Last verified:** 2026-10-01 for the R3 v3 structure, the §2 sums and py_ecc orientation, the §4 LP
> template and §8's v3 addresses, against the R3 v3 data function (`get-originality-r3-v3-markets-data`,
> `seer-protocol` §9) and onchain. The §8 prices and the §3/§8 depth, seed, swap and trader figures are
> pre-seeding, from the 2026-09-29 book, read with `getPool` and `eth_getLogs` against
> `https://mainnet.optimism.io` in 10,000-block chunks (the public endpoint rejects wider ranges).
> **The §3 fire rates are the part that rots fastest** — they were measured on the pre-seeding pools,
> and the v3 pools are new. Before using them, re-read `liquidity` and `slot0` onchain, re-run one
> `eth_getLogs` per v3 pool from its creation block, and recompute the fire rates — including the Swap
> `recipient` concentration — before trusting the "w sat at 0.50" figure or the suppression of the
> −0.10 row.
