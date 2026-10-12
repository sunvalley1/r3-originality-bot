# G-execute-trade.md — get the best fill, then say what really happened

**INPUT:** `./run/<run-id>/allocation.json` (from `F-allocate-capital.md`), and
`./run/<run-id>/blended.json` for one field only — `blended[].blended[Invalid]`, the `p_invalid` that
§4 and §5 mark every retained Invalid leg at. Marking it any other way collapses the route comparison
(§4), so that read is not optional. **OUTPUT:** `./run/<run-id>/fills.json`.

Router calls, complete sets, Invalid, parent/child collateral and pool reading are in `seer-protocol`;
chain facts, gas and the 2^24 cap are in `evm-onchain`. Say "onchain", one word.

**Chain scope.** The route logic is chain-independent; the DEX calls here are **Optimism-only**
(SwapRouter02, QuoterV2, fee tier 100, sUSDS). Gnosis uses sDAI and Swapr/Algebra — different quoter ABI,
no fee-tier argument. On any other chain, **stop until `evm-onchain` supplies verified addresses.** Never
guess one.

F decided the side and the stake. What is left is not clerical: on a real Seer market, buying $100 of a
10c outcome filled at **0.135 per token by the split route and 0.99 direct**. Route choice is routinely
larger than the edge F measured.

## 1. Refuse stale inputs; re-read state onchain

Per position, from the chain — not an indexer, not a cached data function:

| Read | Refuse if |
|---|---|
| `MarketView.getMarket(factory, address)` → `payoutReported` | `true` — it resolved; this is a redeem now |
| `isPendingArbitration(id)`, `getFinalizeTS(id)` on Reality, `id` = `Market.questionsIds()[0]` (`seer-protocol` §1, §8) | in arbitration, or finalizing inside your holding window |
| pool `liquidity()` and `slot0()` for every pool the route touches | `liquidity == 0`. A drained pool keeps its last `sqrtPriceX96` forever, so the price still looks normal |
| holder balances of the collateral and of every outcome here | collateral < the route's **gross** need — a split takes the full set up front, not the net cost |

**Then check what the holder already owns here.** A trade is **not idempotent**. Do not add to an open
position unless F's stake was sized against the existing holding, and say so in `fills.json`. A 300-token
short placed twice filled 0.5129 (EV +$14.14) then 0.6128 (EV −$15.83) — the second fill wiped out the
whole book's edge. If a send looks stuck, read balances onchain; never press it again.

## 2. Check the complete-set arbitrage first, both directions

It needs no forecast, so it outranks every opinion-based row. The three cases — `set-sell` above 1,
`merge-arb` below 1 with surplus Invalid, `pair-carry` below 1 without — and their payoff formulas are
`seer-protocol` §7. Execution adds four things:

- **Use the real threshold, then look at the book.** Sell-side breakeven is `sum·(1−f) > 1`, i.e.
  `sum > 1/(1−f)` ≈ 1.0001 at fee 100, not 1.02: selling both legs yields `sum·(1−f)`, so charging the
  fee per leg double-counts it. On the R3 book of 2026-09-29 (illustrative; the live v3 book differs —
  re-quote) the 98 sums span **0.8632–1.0174, median 0.9929**: a 1.02 gate finds **zero** rows, the old,
  double-counted 1.0002 threshold found **two** (not re-counted at `1/(1−f)`) — `argotorg/fe` at 1.0118
  and `dl-solarity/solidity-lib` at 1.0174. The 39 markets below 0.98
  are `pair-carry` candidates, not free money: on an R3 child a value arbitrage (an unevaluated repo
  costs nothing of value), whose residual risks are an evaluated repo's child resolving INVALID and the
  parent and middle oracles disagreeing.
- **Bound the size on the quoter, not a tick model** — `QuoterV2.quoteExactOutputSingle`, non-view, so
  `eth_call` only. Mirroring the sell side's proportional-target heuristic onto the buy side undersizes:
  on DefiLlama/chainlist (sum 0.8632, a buy-side candidate) it gave N = 1.382 against a quoter-measured
  optimum of **1.796** — 30% short in size, 6% in edge (illustrative arithmetic on pre-seeding depth;
  the v3 pools are much deeper, e.g. py_ecc UP ≈ 1.14e21 raw liquidity vs 2.3e19 — re-quote before use).
- **Selling walks the sum back toward 1**, so the spot gap is an upper bound on the average, never the
  fill. Quote the sale at the size you intend; do not multiply the spot gap by the size you wish you had.
- **Subtract gas in the market's own collateral**, not in dollars:
  `breakeven_edge = (gas_units × gasPrice + L1_data_fee) / rate(ETH → this collateral)`. Every term needs
  a source. Instance, assumptions named: a three-leg single-market `merge-arb` is ~900k gas (*estimated
  from call composition, not `eth_estimateGas`*) ≈ 1e-6 ETH at Optimism's measured 0.001 gwei plus L1
  data; at an **assumed** $3,500 ETH and **a 1 sUSDS = $1 rate you must establish, not assume**,
  ≈ 0.0035 sUSDS. On an R3 child the collateral is a **repo token**, worth `1/N` sUSDS if its repo is
  evaluated and 0 if not — here `N` is the number of repos evaluated in the round (`1/98` if all are),
  not the set count `N` used elsewhere in this file — so the cutoff in repo tokens is
  `gas_sUSDS ÷ (1/N)`: the same gas is about `N` times larger in repo tokens than in sUSDS. `1/N` is
  the evaluated case — on an unevaluated repo the edge is worth 0 and the gas is still spent. Batching
  amortises the fixed part.

Against that cutoff a `set-sell` row needs `cutoff / edge per set` sets before it pays for itself (on the
2026-09-29 book, `fe` ≈ 0.0117 edge/set and `solidity-lib` ≈ 0.0173, `sum·(1−f) − 1` at spot) — more
once the sale moves the price.
`set-sell`'s call composition is lighter than the `merge-arb` the 900k came from, so treat both as an
order of magnitude and re-estimate on the assembled batch. And on an R3 child the profit lands in **that
market's repo tokens**: merging them back toward sUSDS needs every repo token of the bundle plus the
middle Invalid, so leftovers usually wait for resolution, then pay `1/N` sUSDS each if the repo is
evaluated (`N` itself unknown) and 0 if not. Book the edge in repo tokens; call any sUSDS figure a
scenario.

## 3. Enumerate every route. Never assume direct

| Route | Calls | What you own afterwards | Wins when |
|---|---|---|---|
| **direct** | `exactInputSingle(collateral → outcome)` | just the outcome | §4's inequality fails |
| **split** | `splitPosition(amount)`, sell the legs you do not want | target + **Invalid** + anything unsold | §4's inequality holds — you want the Invalid at the price the market charges |
| **fade** (short) | `splitPosition(amount)`, sell **only** the outcome you think dear | every other outcome + Invalid | one outcome is overpriced and no long expresses it |
| **set-sell** | `splitPosition`, sell every pooled leg to `price_i / sum` | Invalid, free | sum > 1/(1−f) (§2) |
| **merge-arb** | `exactOutputSingle × legs`, then `mergePositions(N)` | collateral | surplus Invalid in hand and sum < 1 − f (§2) |
| **pair-carry** | `exactOutputSingle × legs`, **no merge** — nothing to complete the set with | one of every pooled leg, locked to resolution | sum < P(valid) − fees and no surplus Invalid: a short-Invalid carry, not a risk-free arb (on an R3 child, a value arbitrage — §2) |
| **parent-mint + ⟨route⟩** | `splitPosition(sUSDS, parent, x)` **first**, then any route above on the child | the above, plus one of every *other* parent outcome | conditional market, collateral not already held |

The first six names are F's `route` enum verbatim (`F-allocate-capital.md`); `parent-mint+` is a prefix G
adds when the child's collateral has to be minted first. F's *prose* names two of them
`mint-and-sell-both` and `buy-and-merge` — same trades, same definitions, so **accept those two as
aliases and normalise to `set-sell` / `merge-arb`**; the artifact should already carry the normalised
value. A row from the **deep-r3** arm's F carries `route: "direct"`, which is in this set; its G uses a
different vocabulary for the same shapes, and the mapping is in `seer-protocol` §10 — cite it, do not
re-derive it here. **Any other `route`, and any `side` that is not an `outcomes[]` string,
`"short <outcome>"`, `"pair"` or `"set"`, is an upstream bug:** skip the row, put the unknown string in
`error`, and do not map it by guess. The two vocabularies overlap in wording, and a `"mint"` side or a
`split-parent` route is a parent-level row from the other arm that this G does not execute.

**An UP/DOWN pair is one keep-whole group** (`seer-protocol` §10). An UP row and a DOWN row with
`route: "direct"` on the same market, which F emitted as an equal-count pair, are one keep-whole pair
group. Each leg is bought with `exactOutputSingle` at `count = stake / quoted_fill` and is never
re-routed or split — the route enumeration here and §4's comparison do not apply to it. The group is
atomic on an atomic signer and an ordered sequence with stop-and-recovery on a non-atomic one (*Signer
interface*, §8). Two independent `direct` rows that are **not** a pair are F's to mark. The deep-r3
arm's F's both-sides rows are always pairs; this arm's F should emit `pair-carry` for a pair, so its own
rows are unaffected.

**Fade is the route people forget**, and on a multi-outcome market often the only expression of the view:
when the favourite is 15 points too dear each underdog looks fairly priced alone, so every long screens as
no-trade while fading the favourite collects the whole mispricing in one position.

**Parent-mint is what conditional markets are for.** Keep the other parent outcomes it mints: on a
**categorical** parent each pays the collateral back in the world where the parent resolves to it; on a
**multi-scalar** parent they are the proportional merge legs that turn the position back into sUSDS at
all. Children of one parent share its tokens, so a sibling position costs almost no extra capital.
**R3 has a middle level.** Its mint is two groups — split the parent with sUSDS, then split the bundle's
middle with its bundle token — and one sUSDS gives one repo token per repo of that bundle. Each child
sits on, and swaps UP/DOWN against, its own repo token, so siblings under a middle do **not** share
capital: budgets are per repo token and cannot be steered between repos.

## 4. Quote every route at the real size, on the fill, never on spot

`QuoterV2.quoteExactInputSingle` / `quoteExactOutputSingle`, fee = the row's carried `pools[].fee_tier`
(100 today, never a literal retyped here — `seer-protocol` §6), by `eth_call`. Compare at an **equal
count of the target token**, not an equal spend: a split of S sets yields S target tokens while the same
collateral buys far more directly.

**Mark the retained Invalid at your blended `p_invalid` from `blended.json`, never at `1 − Σ price`.**
Invalid has no pool, so the market's implied price is not realizable — and it is exactly the number your
forecast is entitled to disagree with. Marking it at the market's price makes the two routes algebraically
identical at spot, which hides the whole decision. With the right marking, **split beats direct iff**

```
impact_up  −  impact_down   >   p_invalid_market  −  p_invalid_blended
```

`impact_up` is what you pay above spot buying the target; `impact_down` is what you give up below spot
selling the other leg; both at equal target counts. In plain terms, **split is a purchase of Invalid at the
market's price, funded by giving up some of the target** — take it only if you want that purchase.

Impact must be quoted, not modelled: on chainlist's earlier pools, then a few tokens deep in one
initialized range, `quoteExactOutputSingle` bought 1.796 UP **and** 1.796 DOWN for **1.6681** — an
average pair price of **0.9288** against a spot sum of 0.8632, **7.6% of impact on a 1.8-token order**.
That is illustrative arithmetic on pre-seeding depth; the v3 pools are much deeper (e.g. py_ecc UP ≈
1.14e21 raw liquidity vs 2.3e19) — re-quote before use. There is no size at which spot is the fill. Show
every route's quote, not only the winner.

## 5. What split, fade and set-sell change about what you own

You keep every leg you could not sell — normally **Invalid**, which has no pool, so it was never optional.
What each kind of Invalid is *worth* is `seer-protocol` §3. Execution owes three things:

1. **Mark it at `p_invalid` from `blended.json`**, never at `1 − Σ price` (§4).
2. **Name its role in `retained_legs[].why`**, because that is the only place H can read it: `hedge` on a
   scalar or categorical child, where it pays the whole collateral on exactly the event that zeroes your
   leg (on an R3 originality child, the repo is evaluated but its child question resolves INVALID; a
   never-evaluated repo zeroes the repo token itself, Invalid included) — so it belongs in `p_win`;
   `merge leg` on the R3 multi-scalar parent and on each R3 middle, where it pays only on a total wipeout
   (of the round, or of that bundle) — mark it 0 and hold it, because §2 and the exit both need it;
   `dead weight` on a question near-certain to resolve valid — real but illiquid, and it locks that
   capital until resolution.
3. **Never net it into `fill_price`.** The retained Invalid is what makes the `merge-arb` exit possible;
   buried in an average it is invisible to both the exit sizing and the postmortem.

## 6. Build the ordered call list

Call shapes, exact-amount approvals, `exactOutputSingle`, breakeven-derived guards, and the rule that
split/merge/redeem always pass the **root** collateral (sUSDS) even on a child while the token you
*approve* is the parent outcome token — all `seer-protocol` §5–6. Four things bite only at execution:

1. **A wrong spender does not stop the run.** Router for split/merge/redeem, SwapRouter02 for swaps; a
   call approved to the wrong one reverts in simulation and, under a skip-failures mode, is **dropped
   while the rest of the batch proceeds**. That is half the reason §7 bans that mode on a group.
2. **Split a two-leg budget `price_up : price_down`, never 50/50.** Equal collateral buys unequal token
   counts, and the odd tokens are an unmergeable residue — the commonest way a merge exit becomes
   impossible after the fact.
3. **Take every outcome index from `wrappedTokens` order, never from the UI or the question text** — a
   scalar child is `[DOWN, UP, Invalid]`, so index 1 is UP and the mergeable set is
   `min(DOWN, UP, Invalid)`. A guessed index **simulates clean**: nothing reverts, the position is
   simply backwards.
4. **Skip a `splitPosition` of ≤ 0** — common on `set-sell`, where the mint is only the headroom left
   after selling balances you already hold.

## 7. Batch under the gas cap, and simulate the whole ordered sequence

Optimism rejects any transaction whose gas **limit** exceeds **2^24 = 16,777,216**, at simulation.

- **Keep each group whole inside one atomic transaction** — `[approves + splitPosition]`,
  `[approves + mergePositions]`, `[buy legs + merge]`. Split across transactions, a group can land half
  executed, leaving a naked leg. A non-atomic signer runs each group instead as the ordered sequence in
  *Signer interface*, which stops at the first failure.
- **Budget by cost, not call count.** A Router split/merge/redeem costs ~5–10× a swap because it unwraps or
  wraps every outcome: ~100 calls is safe for `[approve, swap]` pairs (~50 swaps), 100 `splitPosition`
  calls is not. Cap merges and redeems at **~30 outcomes** per transaction.
- **Clamp any padded estimate** to `min(estimate × 1.2, 16_777_216)`; when it clamps, **split the batch**.
  Order transactions so no later one depends on an earlier one having succeeded — or abandon the rest if
  one fails, and say so in `fills.json`.

Then simulate the calls **in order against live state** before sending the first one, not call by call in
isolation, because approvals and balances are created by earlier calls. **If any step would revert, refuse
the route and say why** — a trade that fails part-way leaves the holder with half of it: a minted set and
no sale, or one leg of a pair and nothing to merge. Do not paper over a revert with a skip-failures mode:
it drops the failing call and runs the rest, which on a two-leg trade fills one leg and leaves you naked.
**Every group runs atomic, or — on a non-atomic signer — in sequential mode (*Signer interface*).**

**Do not copy the deep.seer.pm frontend's batch layer.** It submits trade and sell batches with
`skipFailCalls` true, so a reverting leg is dropped and the rest proceeds — we refuse the whole batch,
because a dropped sell leg on a split leaves a minted set with no sale and a dropped buy leg on a merge
leaves a naked leg. It slices the flattened call array every 100 calls regardless of group boundaries, so
one row's `[approve, split, approve, sell, approve, buy]` can straddle two transactions — the ~100 above
is a ceiling we fill with whole groups, never a cut point. And when a batch reverts it re-simulates call by
call, keeps the passing prefix and discards the list of failing calls, so nothing records what was pruned
— here every position in a refused, reverted or abandoned batch gets its `runs[]` row in `fills.json`,
`status` `reverted` or `skipped` and the reason in `error`.

## 8. Present, approve, re-quote, send exactly once

Never present a command and ask them to trust it. Per position:

```
MARKET   <question, verbatim from the encoded question>  <address>  chain <id>
POSITION <side>  stake <x> <collateral>   (allocation.json: edge <pts>, EV <+x>)
ROUTES   direct: <n> target, cost/unit <c> | split: <n> target + <n> Invalid @ p_inv <b>, cost/unit <c>
         | fade ... | arb routes from §2 ...
CHOSEN   <route> because <impact_up − impact_down = <x> vs Invalid gap <y> | only expression of the view>
SEQUENCE <n> calls in <k> txs, atomic|sequential, simulated OK, est gas <g> (cap 16,777,216)
COSTS    gas ≈ <e> ETH  fees <f>  guard <amountOutMinimum / amountInMaximum>
PAYS     <what, in which worlds>   WORST CASE <total loss, in money>
CAPITAL  gross <x> up front, net <y> once the sale legs land; locked until <resolution>
```

With a non-atomic signer, say plainly before asking that a group can be left half-done between
transactions — one pair leg bought, a split without its sales — and that an EIP-7702 delegated EOA
removes that risk. Wait for an explicit go-ahead; **approval of one trade is never approval of the
next**. Then re-run §4's quotes and §7's simulation **immediately before sending** — an hour-old quote
on pools this thin is fiction — and if the re-quote moves the fill past F's minimum edge, re-present
rather than send the stale plan. Send once (in sequential mode, each transaction once, in order — see
*Signer interface*). Then read the holder's balances onchain and reconcile: the receipt is not the fill,
the balance delta is.

**A sequential-mode recovery batch stays in this run-id** — the one exception to the spent-run-id rule
in `../SKILL.md`, that a spent run-id never trades again. It is presented, approved and re-quoted like
any batch, writes `./run/<run-id>/inflight.json` before each send, and appends its sends to this run's
`fills.json` in the existing vocabulary: a completing leg is a row on the original market, `side` and
`route`; an unwind sale (§9's level-1b sale) is a `route: "sell-exit"` row — the string `seer-protocol`
§10 gives that shape, which §3 does not name — and a merge-back (§9's exit merge) is a `merge-arb` row,
`buy-and-merge` in the other arm's vocabulary (`seer-protocol` §10).
Each such row names the failed transaction and the word "recovery" in `error`, even on a filled row.
Groups of the approved plan not yet sent when the sequence stopped are written `status: "skipped"`;
they are re-planned and re-approved, never resumed on the original yes.

## 9. Exit through the merge, not the pools

Two exits exist before resolution; quote them against each other:

**(a) buy back the legs you sold, then merge** — returns exactly 1 collateral per completed set, and is the
only route that gets any value out of the retained Invalid, which has no pool.
**(b) sell the legs you hold into their pools** — Invalid is unsellable, so it simply stays held.

(a) usually wins, but not because the buy-back is cheap: you walk the same curve back up, so it costs
roughly what the sale raised plus two fees and whatever the price drifted. It wins because it redeems the
Invalid leg at par inside the set instead of writing it off. On a $338 split position, (a) recovered **all
but $0.06**; (b) would have realised about half.

**A split or fade leaves you holding the target and Invalid but not the leg you sold, so
`min(DOWN, UP, Invalid)` is zero and there is nothing to merge yet.** Buy it back first:

```
LEVEL 0+1, per child, ONE atomic tx:
  N = min(bal childInvalid, bal of EVERY leg you still hold)  // the set size you can complete
  for each leg you sold: exactOutputSingle(collateral -> leg, amountOut = N)
  approve every outcome INCLUDING childInvalid to Router for N
  Router.mergePositions(sUSDS, child, N)                      -> N parent outcome tokens (R3: repo tokens)
LEVEL 1b: sell ONLY the residual (balance − N on the side you are still net long)
LEVEL 1c, R3 only, per bundle X, one atomic tx:  z = min(bal of EVERY repo token of X, middle-X Invalid)
  approve every one of them to Router for z                   // usually 0 after trading: leftovers wait
  Router.mergePositions(sUSDS, middleX, z)                    -> z bundle-X tokens
LEVEL 2, one atomic tx:  y = min(bal of EVERY parent outcome, parentInvalid included)
  approve every one of them to Router for y                   // R3: min(A, B, C, parentInvalid)
  Router.mergePositions(sUSDS, parent, y)                     -> y sUSDS
```

Levels 0 and 1 share a transaction: a buy-back that lands without its merge is just a reopened position.
On a non-atomic signer they run as one sequential group (*Signer interface*), as does each LEVEL 1c and
LEVEL 2 merge: if a merge does not land, stop and present the recovery. The deep.seer.pm frontend has no child-level merge at all — it sells both
legs into the pools and merges only at the middles and then the parent, leaving child Invalid to wait for
a redeem that needs `payoutReported`. In Round 2, **65 of 98 children were never answered**, so that
redeem may never come; the child merge is the only exit that works whether or not the oracle ever
speaks. Do not copy the sell-only exit.

After resolution the route is `redeemPositions`, **children first — batched at ≤30 outcomes per §7, so
~10 scalar children per transaction — then the parent in a later transaction**; on R3, children → repo
tokens, then each middle → bundle tokens, then the parent → sUSDS, each gated on its own
`payoutReported`. Read each level's balances only *after* the level below lands, because that phase is
what mints them. Do not wait on an unselected R3 repo's child: it may never resolve, and once its middle
has resolved without it, its legs are worth 0, so the middle and parent redeems proceed. A losing outcome
redeems for 0 without reverting, so pass every outcome you hold with a non-zero balance, Invalid among
them; unlike a merge, a redeem needs no complete set. **Parent and children resolve independently**: if
the children have closed but the parent (or, on R3, a middle) has not, there is no redeem at that level
— LEVEL 2's merge (and on R3, LEVEL 1c's) is the only way back to sUSDS, and it still needs the full set
at that level.

## Worked example — one position on DefiLlama/chainlist

`allocation.json`: buy UP, **net** stake 2.0 repo tokens, market
`0x4b8bda295e28375ed17abc8d1472e9cccadc93aa` — a scalar child of bundle A's middle
`0xc217920a91f1b3d56276393aa5345f01a848ecf0` at `outcome_index` 20, on chainlist's repo token
`0x6f7b1d0411f5e3d1908fa09b1cec4e9968b03095` (DOWN `0x90fa49f08133489a0aac2d677568b8fb927060b4`, UP
`0x7d02ec662144d5f3951514c2313bcdacbad41c43`, child Invalid `0xe3d571680810de40da8045af4e3a91476e1850cb`;
DOWN pool `0xdd72e6ed83509b1d70928ff8cf058d341c175a4f`, UP pool
`0x50caec635571df16182d70e5b94ab17a01bac719`), so **every figure is in repo tokens, not sUSDS**. Book of
2026-09-29 (illustrative; the live v3 book differs — re-quote): UP 0.4657, DOWN 0.3975, sum 0.8632 →
market-implied Invalid 0.1368; fee 100, `L` = 1.33e19 (UP), 2.59e19 (DOWN). `L`, the 7.6% impact and
`N*` below are illustrative arithmetic on pre-seeding depth; the v3 pools are much deeper (e.g. py_ecc UP
≈ 1.14e21 raw liquidity vs 2.3e19) — re-quote before use. Say `blended.json` puts `p_invalid` at 0.03.

1. **Arb (§2).** Sum < 1, so the sell side is dead; the buy side needs surplus Invalid and this holder has
   none — `merge-arb` is **recorded, not available**. With Invalid in hand the quoter's optimum was
   N\* = 1.796 for 0.1279 repo tokens of edge, which on these figures does **not** clear §2's gas cutoff:
   at `1/98` sUSDS per repo token it is worth less than the ≈ 0.0035 sUSDS of gas. A `pair-carry` *would*
   pass its price test on these numbers (pair cost 0.9288 against a blended P(valid) of 0.97; gas still
   to be tested at `1/N`), but it is a different `side` — `pair`, not UP — so it is F's line to open, not
   G's to substitute. Record it; do not switch.
2. **Sizing (§4).** Direct: `2.0 / 0.4657 ≈ 4.29 UP` at spot. Split: `S × (1 − 0.3975) = 2.0` → **3.32
   sets**, needing **3.32 gross** up front, leaving 3.32 UP + 3.32 Invalid. So split gives up 0.97 UP —
   worth 0.45 collateral — to acquire 3.32 Invalid: it **buys Invalid at 0.1368 each**, the book's price.
3. **Decision (§4).** Split wins iff `impact_up − impact_down > 0.1368 − 0.03 = 0.107`. The UP pool is half
   as deep as the DOWN pool so `impact_up` does exceed `impact_down` — the measured pair purchase took 7.6%
   at 1.8 tokens, so these are several points per leg — but several points does not cover 10.7. **Direct
   wins**, precisely because the forecast disagrees with the book about Invalid. Had F's blended
   `p_invalid` been near 0.13, split would have won on pool depth. Quote both; assume neither.
4. **Retained legs (§5).** Direct retains nothing. Split's 3.32 child Invalid would have been a **hedge**:
   it pays the full repo token exactly when chainlist is evaluated but its child question resolves
   INVALID, the event that zeroes the UP. If chainlist is never evaluated, the repo token itself is worth
   0, Invalid included.
5. **Sequence (§6–7), one atomic tx (two in order on a non-atomic signer), simulated in order:**
   `repoToken.approve(SwapRouter02, 2.0)`, `SwapRouter02.exactInputSingle(repoToken → UP, fee 100,
   amountOutMinimum = your breakeven)`. Report the realised UP count against the quote, in repo tokens.

## Hard rules

- **Never send a transaction the human has not approved in this conversation**, and never read, print or
  ask for a private key. A plan is not an approval.
- **A trade is not idempotent. Never re-run one**, and never add to an open position unless the addition
  was sized against what is already held.
- **Simulate the ordered sequence and refuse on any revert.** Never use a skip-failures mode on a group.
  On a non-atomic signer, stop at the first failure and recover only through a new batch the human
  approves.
- **Re-quote immediately before sending**, never assume `direct`, and mark retained Invalid at your blended
  `p_invalid`, not at `1 − Σ price`.
- **A merge needs the complete partition, Invalid included, at every level** — buy the missing legs back
  first, and size by the minimum.
- **Hold the gross, not the net**, and state the unit on every number: a child figure is in parent outcome
  tokens (repo tokens on R3) and is not comparable to an sUSDS one.
- **Report losses with numbers** — a reverted leg, a fill worse than quoted, a batch abandoned half-way.

## Signer interface

```
chainId()                                   -> number
holder()                                    -> address  // owns balances, is `recipient`; may differ from the signer
simulateBatch(calls)                        -> throws on revert
sendBatch(calls, {gasLimit?, atomic})       -> { hash, receipt }  // atomic = the signer's atomic_batches; false: one call per send
Call = { to, data, value? }                            // value is 0 on every call in every route here
```

**Any signer that needs no human action per transaction may trade**: a local encrypted EOA, an EIP-7702
delegated EOA (**recommended** — it gives atomic batches), a TradeExecutor session key, or another agent
signing backend. A hardware or browser wallet that asks a human to confirm each transaction is not a
trading signer, though it may sign one-off human actions such as an owner granting a session key. The
human's explicit yes per batch (§8) approves a plan, not each signature, and is required in every mode.

- **Atomic signer** (`atomic_batches: true` — an EIP-7702 delegated EOA with atomic batches or a
  TradeExecutor `batchExecute`; a Safe `multiSend` or a 4337 userOp does the same with an identical call
  array): `atomic: true` lands each §7 group, and levels 0+1 of the exit, as one transaction.
- **Non-atomic signer** (`atomic_batches: false`, e.g. a plain local EOA) **may trade too**, in
  sequential mode. Each keep-whole group — mint, split/merge, pair, `set-sell`, `merge-arb`, and levels
  0+1 of the exit — runs as an ordered sequence of single transactions. Simulate the whole ordered
  sequence first in one `eth_simulateV1` call (§7), since a per-call `eth_call` reverts on any call whose
  approval has not yet landed; one explicit yes covers it. Send each transaction once, in nonce order,
  re-running §1's state checks and its own floors before it and awaiting its receipt before the next. On
  any failure, revert or floor breach, **stop sending** and reconcile from chain state. The recovery —
  complete the group at fresh quotes or unwind what landed (sell the stray leg, or merge back) — is a new
  batch with its own explicit yes, never a resend of the failed transaction (§8 records it). Say plainly
  before the go-ahead that a group can be left half-done between transactions (one pair leg bought, a
  split without its sales); EIP-7702 removes that risk, which is why it is recommended.

`evm-onchain` carries the custody warnings for session-key backends.

## Output — `./run/<run-id>/fills.json`

```json
{ "generated_at": "<ISO 8601>",
  "runs": [ { "market": "<owner/repo or question>", "address": "0x…",
              "side": "<echoed from allocation.json, verbatim>",
              "route": "direct|split|fade|set-sell|merge-arb|pair-carry|parent-mint+<route>|sell-exit (recovery only, §8)",
              "requested": 0.0, "filled": 0.0,
              "fill_price": 0.0, "slippage_vs_quote": 0.0,
              "tx_hash": "0x…|null",
              "status": "filled|partial|reverted|skipped",
              "error": "<null, or why it reverted or was skipped; on a recovery row the failed tx and \"recovery\">" } ],
  "totals": { "spent": 0.0, "spent_unit": "<collateral_symbol label>", "positions_opened": 0 },
  "retained_legs": [ { "token": "0x…", "amount": 0.0,
                       "why": "hedge — <event it pays on> | merge leg — pays only on total wipeout | dead weight — illiquid until resolution" } ] }
```

- `requested` / `filled` count **the unit F sized in**, so the two files divide: **target tokens** for
  `direct`, `split` and `fade`; **sets** for `set-sell`; **pairs** for `merge-arb` and `pair-carry`.
  `spent` / `spent_unit` are the market's own collateral — parent outcome tokens on a child, never sUSDS
  unless the market is top-level.
- `fill_price` is realised net collateral **per that same unit**, matching F's `c(s)`: for `split` and
  `fade`, `(collateral minted − sale proceeds) / target tokens`; for `merge-arb` and `pair-carry`,
  collateral cost per pair (< 1 on a profitable `merge-arb`). **`set-sell` is the exception**
  (`seer-protocol` §10): its `fill_price`, like the `quoted_fill` F writes, is collateral of sale
  proceeds **per set**, **greater than 1 when profitable** — you were paid more than the mint and keep
  the Invalid free — not F's internal `c(s)`. Retained legs are listed separately, never netted in.
  Never the quote.
- `slippage_vs_quote` is signed so **positive is worse**: `fill_price − quoted_fill` on any line that
  pays collateral out, `quoted_fill − fill_price` on one that takes it in (`set-sell`, proceeds per set
  per §10; a fade's sale leg).
- `side` and `route` carry F's vocabulary unchanged — `side` one of `"<outcome>"`, `"short <outcome>"`,
  `"pair"`, `"set"`; `route` one of the six in §3, except a recovery unwind sale, written `sell-exit`
  (§8) — so `H-postmortem.md` can join the two files row for row. If the executed route differs from the allocated one, write `route` as `"<executed> (allocated:
  <route>)"` — otherwise H compares fills across different bases.
- `"partial"` is a batch that landed incompletely, not a swap: `exactInputSingle` is all-or-nothing.
  `"skipped"` needs a reason in `error` — resolved, drained, failed simulation, no edge after the re-quote,
  already held, unsent when a sequential run stopped (§8).
- `retained_legs` is **not optional** after any split or fade: `H-postmortem.md` cannot price the position
  without it, and the merge exit cannot be sized without it.

> **Last verified:** 2026-09-29 for the figures; the R3 v3 addresses onchain 2026-10-01. Prices,
> liquidity and fee tiers are the 2026-09-29 R3 book at pre-seeding depth, illustrative only; the 1.796 /
> 0.1279 chainlist optimum from `QuoterV2.quoteExactOutputSingle` by `eth_call` against
> `https://mainnet.optimism.io`, on that depth; gas price measured, the 900k gas figure and the $3,500 ETH
> price assumed. Re-check before sizing: `liquidity()` and `slot0()` on the pools in scope,
> `eth_gasPrice`, and one `quoteExactOutputSingle` at the size you intend.
