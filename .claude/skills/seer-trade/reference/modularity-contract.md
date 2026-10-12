# The modularity contract — swapping one step of the seer-trade pipeline

Belongs to the `seer-trade` skill; read it only when you are replacing one lettered step with another
arm's version of the same letter, or running an A/B across the two pipelines.

Every step reads and writes exactly the shapes in `seer-protocol` §10 and communicates through nothing
else — no shared memory, no "as I mentioned earlier", no fields invented in passing. That is what makes
a single step swappable, including for the naive pipeline's version of the same letter.

Rules for a swap:

1. **Artifacts are the entire interface.** If a replacement writes a field the next step reads, it drops
   in. If it does not, it is a different pipeline, not a swap.
2. **Change exactly one letter per run.** Two changes and you cannot attribute the difference to either.
3. **Cross-set swaps are only valid on the universe both sides cover.** The `deep-r3-trade` steps are
   scoped to Round 3 Originality by that skill's own scope and their own market table, so a cross-set comparison
   runs on the R3 universe and nowhere else. Say so when you report it — it is an experiment, not a
   general result.
4. **Never execute two arms against the same pools.** These pools hold a few tokens in one initialized
   range; the second arm trades into the first one's price impact and you measure your own slippage.
   Execute one arm, paper-trade the other from the same quotes.

**Worked swap — is the blend step earning its keep?** Replace E (`../steps/E-reconcile-price.md`) with
`../../deep-r3-trade/steps/E-no-reconcile.md`, the identity blend: `blended = own`, `w = 1.0`,
`w_reason = "naive baseline: no reconciliation"`. It takes the same two inputs (`base-forecast.json`
and `candidates.json`) and writes `w` and `w_reason`, so F reads it unchanged. The two arms' recorded
`market_price` will still **differ**: real E re-reads `slot0` onchain, floors every entry at 0.005 and
renormalizes, while the identity records the raw vector including a negative third entry wherever the
pooled legs sum above 1. Compare the allocations and the P&L, not `brier_market`.

Method: run C once and delegate D once through [the clean worker boundary](price-blind-worker.md).
The priced controller performs E afterward. Copy the run directory at the D→E boundary so both arms share
`candidates.json` and `base-forecast.json` byte-identical. Run real E on one copy and the identity on
the other, then F on each. Execute the arm you chose in advance; **paper-fill the other from the same
quotes**, writing its `fills.json` rows as `status: "skipped"`, `tx_hash: null`,
`error: "paper arm, not executed"`. Mark a paper row `filled` and H counts it as real money and your
own spent-run-id rule condemns a directory that never traded.

**What it tells you is money, not Brier.** Both arms forecast from the same `base-forecast.json`, so
`brier_own` is identical in both and the identity arm adds no forecasting information — a single
reasoned run already reports `brier_own` beside `brier_blended`. What only the swap shows is the
allocation the two blends produced: `w = 1.0` expresses every gap between your forecast and the book at
full size, so compare the two `allocation.json` stakes and the two arms' realised P&L in `review.json`.
If the identity arm makes more money, your `w` is throttling real edge. If it loses, the throttle is
what paid for itself, and you have the number.

Two more that answer different questions:

- **F → `../../deep-r3-trade/steps/F-max-ev.md`** (same blend, pure marginal EV, no Kelly, no correlation cap). Compatible on
  both fields G dispatches on: it writes `route: "direct"`, which is in G's route set, and `side` as the
  `outcomes[]` string verbatim, which is what G and H index on. G re-searches routes anyway, except on a
  pair group. **It runs on seer-trade G only with the pair rule** (`seer-protocol` §10,
  `../steps/G-execute-trade.md` §3): an UP row and a DOWN row with `route: "direct"` on the same market,
  which F emitted as an equal-count pair, are one keep-whole pair group. Each leg is bought with
  `exactOutputSingle` at `count = stake / quoted_fill` and is never re-routed or split; the group is
  atomic on an atomic signer and sequential with stop-and-recovery on a non-atomic one. This F's
  both-sides rows are always pairs. It prices what risk control costs when you are right and saves when
  you are wrong.
- **D → `../../deep-r3-trade/steps/D-csv-forecast.md`** (a human's CSV instead of research). **Shape-compatible, value-
  incompatible, and that is itself the finding.** It writes `invalid_p = 0.0` flatly, and reasoned E
  refuses any `0` in an `own` vector rather than flooring it. The naive pipeline runs it because its own
  E is the identity; the reasoned pipeline cannot, because an Invalid of zero asserts a fair `UP + DOWN`
  of exactly 1 when the true sum is `P(valid)`. Matching artifact shapes is not the same as matching
  values: the contract makes a step droppable, it does not make it correct.

**The reverse F swap is not supported.** seer-trade's F (`../steps/F-allocate-capital.md`) cannot be
swapped into the `deep-r3-trade` pipeline. Its vocabulary includes `parent-mint+<route>`, `split`,
`fade` (`side: "short …"`) and `pair-carry` (`side: "pair"`), and deep-r3 G
(`../../deep-r3-trade/steps/G-mint-and-trade.md`) executes only `direct`, `set-sell` and `merge-arb`
rows, so seer-trade F's output is **not executable by deep-r3 G**. To act on it, run it with seer-trade
G; otherwise use it as a plan for comparison only.
