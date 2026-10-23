# ai-forecast: the AI research kit, one source of D's forecast file

The price-blind AI research that writes the forecast file D's `forecast-file` method trades on
(`../../steps/D-methods/ai-research.md`). Any agent can
run it: the research routine does (`../../routines/research.md`), in a private research repository of its own, from
which the trading run copies the newest forecast file; so can a supervised session in a clone of that repository,
never in the trading clone. It holds no key and sends nothing. `node r3.cjs research-begin` names the run-id
`<UTC slug>-research`, the only folder name the trading run imports from, and puts the work folders under
`~/r3-research/<run-id>` (in the cloud HOME is `/root`). Whatever the research does reaches the trading run only as
that one file, as data (`../../steps/D-methods/forecast-file.md`).

| File | What it is |
|---|---|
| `prep.cjs` | Builds one isolated worker folder per part, outside the project, from the research run-id's `candidates.json` (price-blind fields only, through `docs/price-blind-worker.md`'s allowlist), `question-policy.blind.json` and `onchain-state.blind.json` (the planner's `blind`). Refuses to dispatch if a price-like word reaches a worker's inputs. |
| `WORKER.template.md` | The worker's brief, copied into each folder as `TASK.md`: the price-blind boundary, primary sources only, the output schema, the self-check. |
| `docs/` | What each worker reads: seer-trade's forecasting procedure (`D-base-forecast.md`), the boundary contract (`price-blind-worker.md`), the scalar triple (`seer-protocol-scalar-triple.md`) and Seer's resolution policy. |
| `question-policy.blind.json` | Each market's oracle question, bounds and policy text, read onchain once. Immutable for Round 3. |
| `merge.cjs` | Checks every worker's part and merges them, values untouched, into `run/<run-id>/research-forecast.json`, with a method text naming the workers' model and how they ran. |

The flow, which `node r3.cjs research-begin` and `research-end` wrap:

```bash
node <planner path> c <run-id>
node <planner path> blind <run-id>
node prep.cjs <project root> <run-id> <this folder> <work folder> <parts>
# one fresh worker per part: "read TASK.md in <folder> and follow it"
node merge.cjs <project root> <run-id> <work folder> <model> "<how the workers ran>"
```

The workers can be any model with web search: `merge.cjs` records which one, and how it ran, in the method string.
