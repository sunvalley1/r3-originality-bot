# Reading the scalar triple correctly (price-free extract of seer-protocol)

The entries must sum to 1 *and* `p_invalid` must not be 0, so `p_up` is **not** `E[f | valid]`. Write
`p_invalid = P(unanswerable)`, `p_up = (1 - p_invalid)*E[f | valid]`, `p_down = (1 - p_invalid)*E[1 - f | valid]`.
Round 3 v3: each child's collateral is its own repo token, worth 0 unless the repo is selected, so forecast
`E[score | evaluated]` directly and set `p_invalid = P(child resolves INVALID | evaluated)`, which is small;
`P(evaluated)` does not enter the triple.