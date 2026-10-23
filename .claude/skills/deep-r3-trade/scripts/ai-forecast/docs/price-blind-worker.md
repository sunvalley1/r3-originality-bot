# D worker — a clean context and a precise handoff

Read this at C→D. The parent/controller has read market prices in C; it cannot become the independent
forecaster by deleting fields. It prepares the following local projections, starts a fresh worker,
then receives D's normal `base-forecast.json` and resumes E itself. C–H order and artifact schemas stay
unchanged; the projections below are private handoff files, not new pipeline artifacts.

## Prepare the inputs in the parent

Keep full `candidates.json` and `run/calibration.json` with the parent. Construct a new object with
an **allowlist**, not a copy followed by deletions. This example writes the candidate projection without
printing raw candidates; replace `RUNID` with the actual run id.

```javascript
const fs = require('node:fs');
const folder = './run/RUNID/';
const source = JSON.parse(fs.readFileSync(folder + 'candidates.json', 'utf8'));
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
const projected = {
  chain_id: source.chain_id,
  candidates: source.candidates.map(c => ({
    ...pick(c, ['market', 'address', 'kind', 'outcomes', 'collateral_symbol', 'resolves_on',
      'resolution_source', 'tradeable']),
    parent: c.parent ? pick(c.parent, ['address', 'outcome_index']) : null,
    pools: (c.pools || []).map(p => ({ outcome: p.outcome, fee_tier: p.fee_tier,
      has_liquidity: Number(p.liquidity || 0) > 0 })),
    traded: c.traded ? pick(c.traded, ['swaps', 'distinct_traders', 'hours_since_last']) : null
  }))
};
fs.writeFileSync(folder + 'candidates.blind.json', JSON.stringify(projected, null, 2));
```

Only the listed fields survive. No extra top-level annotations, `skipped`, `reason_in_scope`, volume,
liquidity amounts, spot/seed prices, ticks, sums, edges, directions, depths, fill quotes, stakes,
allocations or prior forecasts reach D. Parent addresses and outcome indexes are identifiers only.
`market` must be the verified encoded question, never a price-informed paraphrase. A resolution-source
URL is provenance, not permission to open the trading UI. Review retained text/labels/URLs for embedded
market quotes or commentary before dispatch; do not pass price-bearing excerpts through an allowed key.
Preserve thresholds that are part of the question/policy itself, such as the underlying asset's target.

Prepare `question-policy.blind.json` from price-free primary reads. Its only top-level fields are
`chain_id`, `generated_at` and `markets`. Each market permits only `address`, `encoded_questions`
(entries with `index`, exact `text`, `source_url`, `block_number`), `lower_bound`, `upper_bound`,
and `policy_sources` (entries with `url`, `version`, exact applicable `text`). Use `null` for inapplicable
bounds; never invent a missing policy. Record source/block provenance and check exact questions against
C's identity. Exclude UI prices, controller reasoning and summaries of what the controller expects.
D may supplement missing policy or factual resolution evidence from primary sources using price-free
reads; if a required question/bound cannot be verified, it stops that candidate.

Project calibration separately into `calib.forecast.json`. Allow only top-level `version` and `forecast`;
within `forecast`, only these existing type-keyed maps and their listed entry fields:

| Map | Allowed entry fields |
| --- | --- |
| `base_rate_anchor` | `value`, `space`, `n`, `n_eff`, `grade`, `active` |
| `own_bias` | `shift`, `space`, `n`, `n_eff`, `grade`, `active` |
| `shrink` | `lambda`, `anchor`, `n`, `n_eff`, `grade`, `active` |
| `invalid_floor` | `value`, `n`, `n_invalid`, `n_eff`, `grade`, `active` |

Keep applicable verified type labels only, with typed numeric/boolean values and the existing defined
`space`/`anchor`/`grade` labels. No arbitrary comments, extra fields, review excerpts, source-file paths,
`blend`, `execution`, `scope` or price-derived findings are sent. A calibration finding derived from
market prices never belongs in this projection, regardless of its field name. If calibration is absent,
send `null` for this input and D records `calib=none`. Keep inactive knobs inactive. The formula and
application order remain those in `../steps/D-base-forecast.md` and H's existing forecast schema.

## Start a fresh D worker

Use a worker mode that inherits **no conversation history or tool outputs**: for example, Codex
`spawn_agent` with `fork_turns: "none"`, or the environment's equivalent fresh isolated invocation.
Starting another agent with the parent's history, resuming a previous worker, or renaming the parent's
task is insufficient. If no clean-context worker is available, report independent forecasting as
unavailable and stop before E; do not claim price blindness.

Give it only: this boundary contract, D's price-free procedure and structural output schema, the
run id/output destination, the three checked input projections above (or their allowlisted contents),
and any required **price-free** mechanics
instructions. Do not pass the controller's broad prompt, bankroll/position, target edge, intended side,
subsidy economics, price-bearing worked examples, other workers' estimates or prior messages. Do not
load the full orchestrator, C/E/F/G/H/I files, shared price-bearing reference files (including the
controller-only `forecast-worked-example.md`), previous run directories or the full calibration into
its context. If using a shared filesystem, explicitly limit
its reads to the approved inputs and price-free primary resolution research.

The worker reads the exact question/policy, follows D's unchanged forecasting and calibration method,
and writes only the normal `base-forecast.json`. It never runs C, E, F, G or wallet setup. Return the
output path and any missing-source or contamination status to its immediate parent. The parent checks
the output identity, outcome order, sources, probability sums and `price_seen` before E. A worker that
completed D does not receive E's price feedback or get reused as the next D forecaster.

## Stop and restart on contamination

If a market quote, priced candidate, prior blend/allocation, inherited controller history or another
price-informed estimate reaches the worker, it stops and reports what leaked. Retain any contaminated
draft only as rejected evidence, with `price_seen: true`; do not use it as the run's accepted forecast.
The parent fixes the input/source boundary, discards the estimate and launches a **new** no-history D
worker. It does not pass the rejected estimate to that worker. E cannot lower `w`, edit the old result,
or ask the contaminated worker to try forgetting the price. If clean restart fails, stop the candidate.
