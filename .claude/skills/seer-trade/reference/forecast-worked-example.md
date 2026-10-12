# Forecast example — controller only

Read this only in the priced controller after accepting a clean D output, or for offline method review.
Never include this reference, its estimates or its market-specific output illustration in a D worker
handoff. The example below declares that its author had seen the price; it is rejected as an
independent forecast and cannot be blended or used to seed another D worker. Its numeric method and
illustration are retained for audit, not as a valid live forecast.

## Worked example — DefiLlama/chainlist, Round 3

Market `0x4b8bda295e28375ed17abc8d1472e9cccadc93aa`, scalar, bounds 0..100e18, collateral = the
chainlist repo token `0x6f7b1d0411f5e3d1908fa09b1cec4e9968b03095`, parent = middle A
(`0xc217920a91f1b3d56276393aa5345f01a848ecf0`) at `outcome_index` 20. That repo token is worth `1/N`
sUSDS if chainlist is evaluated and 0 if not, so the triple below prices the child **given rated**.
Encoded question, verbatim: *"What will be the average originality score of DefiLlama/chainlist in
Round 3 of the Deep Funding experiment?␟misc␟en_US"* — no criteria in it, so the arbitrator's policy
governs (step 3.3).

| Step | Finding |
|---|---|
| Already decided? | No R3 sheet in `oss-evals` (history ends 2026-09-17); Reality question `bond 0`, `finalize_ts 0`. But R2's sheet lagged its answers by two months, so this is weak evidence. |
| Base rate, coverage | 33 of 98 = 34% rated in R2. **n = 1 round.** |
| Base rate, score | R2 distribution above: median 80, mean 77.50, sd 14.54. |
| Repo-specific | chainlist **was** rated in R2 — one juror, 80 — and its R2 market resolved at exactly 80.00. |
| P(rated in R3) | **Not in this triple.** An unrated repo's child sits on a worthless repo token, so nobody needs to answer it and it is worth 0 whatever happens. P(rated) moves only the sUSDS value of the position, `E[1{rated}/N]` — F's, not D's. |
| E[score \| rated] | Centre on its own prior answer, 80; spread sd ≈ 12 for the thin-jury reason in step 8. |
| f | `E[clamp(X/100)]` for N(80, 12) ≈ 0.797 → round to the 0.05 grid → **0.80**. |
| P(child INVALID \| rated) | Step 7's 5%+ floor for a question whose resolution waits on a named body publishing; the question carries no criteria of its own, which step 7 says raises it, so 0.05 is a lower bound. **0.05.** |

```
p_invalid = P(child INVALID | rated)   = 0.05
p_up      = (1 − 0.05) × 0.80          = 0.76
p_down    = (1 − 0.05) × 0.20          = 0.19        sum = 1.00
```

Edge in answer units: 0.05 of `f` = 5 points of score, and chainlist's R3 mean may rest on a single
juror. Would change my mind: **a published R3 sheet containing chainlist** pins `f` outright and
takes `p_invalid` below 0.05; **any `best_answer` on this question** voids the forecast and requires a
new one. A coverage scope or a sheet without chainlist changes P(rated), which is not in this triple.

**Disclosure, under this step's own rule.** Whoever wrote this example had seen chainlist's price and
picked it as the cheapest complete set on the 2026-09-29 book. It shows the *method*: 80 and 0.05 are
not constants for "was rated in R2" — derive `E[score | rated]` and `P(child INVALID | rated)` fresh,
per repo, every run, and never paste them onto the other 32.

## Output — `./run/<run-id>/base-forecast.json`

```json
{
  "generated_at": "2026-09-29T18:40:00Z",
  "method": "price-blind E[score|rated] directly, p_invalid = P(child INVALID|rated); P(rated) not in the child's price; base rate n=1 (Round 2, 33 answers); scalar distribution -> expected payout fraction; calib=none",
  "price_seen": false,
  "forecasts": [
    {
      "market": "What will be the average originality score of DefiLlama/chainlist in Round 3 of the Deep Funding experiment?",
      "address": "0x4b8bda295e28375ed17abc8d1472e9cccadc93aa",
      "p": [0.19, 0.76, 0.05],
      "invalid_p": 0.05,
      "sums_to_one": true,
      "reasoning": "Scalar 0..100e18, order [DOWN, UP, Invalid], collateral the chainlist repo token. E[score|rated] = N(80,12) centred on its own R2 answer; f = 0.797 -> 0.80 on the 0.05 grid. p_invalid = P(child INVALID|rated) = 0.05, step 7's 5%+ floor for a named body that must publish; the missing criteria argue it higher, so this is a lower bound. P(rated) does not enter this price: unrated, the repo token and so the child are worth 0. p_raw=[0.19,0.76,0.05] (calib=none, so p_raw == p). FOR F: P(rated) moves only the sUSDS value of the position, E[1{rated}/N]. FOR F: the residual risks are an evaluated repo whose child resolves INVALID (this p_invalid) and parent/middle oracle disagreement.",
      "sources": [
        "https://github.com/deepfunding/oss-evals",
        "onchain: Market(0x4b8bda29...) encodedQuestions(0), lowerBound()=0, upperBound()=100e18, parentMarket()=middle A, parentOutcome()=20",
        "onchain: R2 market 0x16de39b0e972d160c62b2b5f246e3de363175819 best_answer = 80e18"
      ],
      "would_change_my_mind": "A published R3 sheet containing chainlist: f pinned to its mean, p_invalid below 0.05. Any best_answer on this question: forecast void, re-run D."
    }
  ]
}
```

