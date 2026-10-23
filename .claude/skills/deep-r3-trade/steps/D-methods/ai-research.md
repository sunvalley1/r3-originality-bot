# ai-research.md — price-blind AI research, one source of the forecast file

One source of D's forecast: the AI agent researches each repository and writes the forecast file that D's
`forecast-file` method reads (`forecast-file.md`: the file, and what D does with it). D's contract, the same for
every method, is `../D-forecast.md`.

## The research

The AI agent running this skill researches each repository itself, without seeing a price, and D trades on that
research. Set `"forecastMethod": "forecast-file"` (`planner.forecastMethod` in `routine.config.json`, copied into
`planner.config.json`; `"ai"`, its older name, still works). The research is a run-id of its own
(`<UTC slug>-research`), made before the trading run; on a schedule it is the research routine (`../I-setup.md` I.2 §7,
`../../routines/research.md`), which works in a private research repository of its own and holds no key. The trading
run copies its newest forecast file from that repository's clone (`forecastImport`, `../I-setup.md` I.2 §7). The
steps (`node r3.cjs research-begin` runs 1 to 3, `node r3.cjs research-end` runs 5):

1. `node <planner path> c <research run-id>`: the candidate set. The agent orchestrating the research does not read
   its prices; nothing priced reaches the workers.
2. `node <planner path> blind <research run-id>`: each tradeable child's Reality.eth question state, read onchain and
   price-free, into `onchain-state.blind.json`. A posted answer that is not yet final is strong evidence.
3. `node ../../scripts/ai-forecast/prep.cjs <project root> <research run-id> <ai-forecast folder> <work folder> <parts>`:
   one isolated worker folder per part, outside the project. Each holds only price-blind inputs (the allowlist of
   `price-blind-worker.md`), the forecasting procedure (`docs/D-base-forecast.md`, seer-trade's D), and the brief
   `TASK.md` made from `WORKER.template.md`. prep refuses to dispatch if a price-like word reaches those inputs.
4. One fresh worker per part, with no history, each working only in its own folder. In Claude Code that is one
   subagent per part, told to read `TASK.md` in its folder and follow it; any other agent uses its own equivalent.
   Workers research primary sources only and never look at a price (the brief's boundary).
5. `node ../../scripts/ai-forecast/merge.cjs <project root> <research run-id> <work folder> <model> "<how the workers
   ran>"`: checks every part and writes `./run/<research run-id>/research-forecast.json`, values untouched.

The kit, its files and the flow that `node r3.cjs research-begin` and `research-end` wrap are in
`../../scripts/ai-forecast/README.md`.

## The file it writes

`merge.cjs` writes `./run/<research run-id>/research-forecast.json` in the forecast file's shape, in the research
repository's clone. The research runs in a clone of the research repository, never in the trading clone:
it reads web pages that anyone can write, and nothing that reads them may write where the key's code runs. The
trading run gets the file through `forecastImport`: `r3.cjs trade` or `r3.cjs clearance` copies the newest one made
within `forecastMaxAgeHours` into the trading clone's `run/`, and D reads it as `forecast-file.md` says (*What D does
with the file*). No research forecast young enough is the D stop `no-forecast`: the trading run makes no new entry,
and a wake still runs Half B and H. A market the research did not cover gets no forecast and no directional trade.

Its text never reaches the trading agent: D checks it and the report carries the method's sha256, not its text
(`forecast-file.md`). Its numbers are the forecast risk any source has, and here that risk is concrete. The workers
read pages that anyone can write, including people who trade these markets. A forecast steered by such a page can
spend the whole balance into positions whose counterparties chose the prices: F sizes on it at face value and
nothing caps it. Only what you keep in the bot wallet bounds it.

Unlike the default method (`csv.md`), the research prices Invalid above 0 (seer-trade's D, section 9). Workers can be
any model: `merge.cjs` records which one and how it ran in the file's `method` text.
