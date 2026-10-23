# forecast-file.md — a forecast file, from any source

One way to make D's forecast: a forecast file, `research-forecast.json`, that any source writes and D's
`forecast-file` method reads. D's contract, the same for every method, is `../D-forecast.md`.

## Using it

Set `"forecastMethod": "forecast-file"` (`planner.forecastMethod` in `routine.config.json`, copied into
`planner.config.json`; `"ai"`, its older name, still works), and write `research-forecast.json` in the shape below,
in a run-id folder of its own named like a research run-id (`2026-10-23T0700Z-research`). Any source can write it,
for example:

- a pool of forecasters: several people's CSVs averaged, or weighted by their past Brier scores;
- a script that scores how much of each repository is its own code;
- another model, or an AI asked a different question;
- the AI agent's price-blind research, which the research routine runs before each trading run, in a private
  repository of its own (`ai-research.md`).

The trading run gets the file in one of two ways: `r3.cjs` imports it from the research repository's clone
(`forecastImport`, below), or you commit it into the trading repository's `run/` yourself. Anything that reads web
pages works in the research repository, never in the trading clone.

Change one thing per run, and dry-run it first: `node r3.cjs clearance`, which imports the forecast file and sends
nothing, or `node r3.cjs planner exec <run-id> --check` in a supervised session.

## The file

```json
{
  "generated_at": "<ISO-8601 UTC timestamp>",
  "method": "<how this forecast was made>",
  "price_seen": false,
  "forecasts": [
    { "market": "<owner/repo, or the oracle question naming it>", "address": "<the market's lowercase address>",
      "p": [0.29, 0.68, 0.03], "invalid_p": 0.03, "sums_to_one": true,
      "reasoning": "<why>", "sources": ["<url>"], "would_change_my_mind": "<what would>" }
  ]
}
```

- `p` is `[DOWN, UP, Invalid]`: three numbers summing to 1, with Invalid above 0, and `invalid_p` equal to `p[2]`.
- `price_seen: false` is a claim about how the forecast was made: no price went into it.
- `method` is free text: say how the forecast was made, in your own words. D marks `base-forecast.json` as this
  arm's itself (`../D-forecast.md`, *Output schema*), so add no prefix. A file that still starts with the older
  prefix `seer-trade D (D-base-forecast.md) swapped into deep-r3-trade` keeps working.
- `generated_at` is when it was made, as an ISO 8601 UTC timestamp and nothing else: `2026-10-23T07:41:09Z`
  (seconds and up to three decimals optional, `Z` required). D and the import refuse any other form.

## What D does with the file

The trading run's D (`node <planner path> d <run-id>`, also inside `wake`) takes the run-id's own
`research-forecast.json` if one is already there, whatever its age. Otherwise it takes the newest
`research-forecast.json` under `./run/` made within `forecastMaxAgeHours` (default 12; `planner.forecastMaxAgeHours`,
beside `forecastMethod`), copies it byte for byte into its own run-id, and checks it.

In the trading routine the research forecasts live in another repository. Before the planner runs, `r3.cjs trade`
(and `r3.cjs clearance`) copies the newest one made within `forecastMaxAgeHours` from that clone into
`./run/<the same research run-id>/` (`routine.config.json`'s `forecastImport`, never over a different file;
`../I-setup.md` I.2 §7), and D finds it there like any other. The import looks only in folders named like research
run-ids (`YYYY-MM-DDTHHMMZ-research`, or with `-w2`), takes only a file whose `generated_at` is an ISO 8601 UTC
timestamp, and copies that one file and nothing else. A supervised `node r3.cjs planner d` does not import.

D checks:

- `price_seen` is false;
- `generated_at` is an ISO 8601 UTC timestamp (above);
- `method` is a text saying how the forecast was made. D writes it into `base-forecast.json` behind its own marker
  for this arm, by which F, Half B, H and the repair recognize this arm's run-ids (`../D-forecast.md`,
  *Output schema*);
- every `p` is three numbers in [0, 1] summing to 1, with Invalid above 0, and `invalid_p` equals `p[2]`;
- there is one row per address, and each row's market names the repo C names.

No forecast file young enough is the D stop `no-forecast` (wake status `no-forecast`): no `base-forecast.json`, no
new entry that run, and a wake still runs Half B and H. A malformed one is the D stop `forecast-refused`. A market
with no row gets no forecast and no directional trade; rows for other markets are ignored.

**The file's text stays out of what the trading agent reads.** D's refusal notes name rows by their index and markets
by C's names, never the file's own strings. `report.md` and `wake-status.json` carry the method's sha256, not its
text. The file's numbers are still the forecast risk any source has: F sizes on them at face value, and nothing caps
them. Only what you keep in the bot wallet bounds a wrong or steered forecast.
