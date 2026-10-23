#!/usr/bin/env node
// planner.cjs - the reviewed, hash-pinned planner of deep-r3-trade: the executable form of steps C to H for the
// scheduled run, which has no `node -e`. The skill text stays the authority; each subcommand performs one step it
// defines and prints ONE JSON summary line. Read scripts/planner.README.md before installing it.
//
//   node <planner path> c <run-id>                       C-select: candidates.json
//   node <planner path> blind <run-id>                   D's AI research: the price-free Reality.eth state the research
//                                                        workers read (onchain-state.blind.json)
//   node <planner path> d <run-id>                       D: base-forecast.json by the configured method (forecastMethod:
//                                                        csv, the default, the stored CSV; forecast-file, or ai, a
//                                                        forecast file any source wrote)
//   node <planner path> d <run-id> --supply <csv> [--continue] [--notes <text>]
//                                                        D, a CSV a human supplies in a supervised session
//   node <planner path> e <run-id>                       E: blended.json
//   node <planner path> f <run-id> [--provisional]       F: allocation.json, f-print.md (--provisional: a supervised
//                                                        session sizes on a queued PSM3 ramp, sUSDS + minAmountOut)
//   node <planner path> g <run-id> [--indep]             G: g-plan.json, gate-print.md, g-tx/
//   node <planner path> exec <run-id> [--check] [--max-groups N]
//   node <planner path> halfb <run-id> [--send]          Half B: merges and redeems at every level (--send: a supervised
//                                                        session sends the level it printed, gate 4)
//   node <planner path> h <run-id>                       H-no-learn
//   node <planner path> report <run-id>                  report.md (and wake-status.json on a wake)
//   node <planner path> wake <run-id>                    the whole scheduled run
//
// Exit codes: 0 ok; 1 internal error (a bug: the summary says so); 2 usage or config; 3 a stop the skill defines
// (C stop, D stop, stale plan, refusal, affordability skip), cause in the JSON; 4 a safety refusal (nonce moved,
// pending transaction, hash mismatch); 5 transport failure after retries.
//
// No key access, ever; no RPC contacted directly (every read goes through the chain helper, every send through
// the signer's send); writes only under ./run/<run-id>/ (and ./run/csv/ on the supervised `d --supply --continue`
// path). Plain Node 22, CommonJS. Reads no environment variable.
'use strict';

// Nothing but the summary may reach stdout: any stray console output goes to stderr.
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');
console.info = console.log;
console.warn = console.log;

const lib = require('./planner/lib.cjs');
const { EXIT, PlannerError } = lib;

// The grammar: positional <run-id>, then the flags each subcommand accepts. `value` flags take one argument.
const GRAMMAR = {
  c: { flags: {} },
  blind: { flags: {} },
  d: { flags: { '--supply': 'value', '--continue': 'bool', '--notes': 'value' } },
  e: { flags: {} },
  f: { flags: { '--provisional': 'bool' } },
  g: { flags: { '--indep': 'bool' } },
  exec: { flags: { '--check': 'bool', '--max-groups': 'value' } },
  halfb: { flags: { '--send': 'bool' } },
  h: { flags: {} },
  report: { flags: {} },
  wake: { flags: {} },
};
// Each subcommand's module is planner/<name>.cjs (lib.MODULES); a later step of the build adds its own file.

function usage(msg) { return new PlannerError('usage', `${msg}. usage: node planner.cjs <${Object.keys(GRAMMAR).join('|')}> <run-id> [flags] (see planner.README.md)`, EXIT.USAGE); }

function parseArgs(argv) {
  const [sub, runId, ...rest] = argv;
  if (!sub || !Object.prototype.hasOwnProperty.call(GRAMMAR, sub)) throw usage(`unknown or missing subcommand ${lib.clip(sub || '', 20)}`);
  if (runId === undefined || /^--/.test(runId)) throw usage(`${sub} needs a <run-id>`);
  lib.validateRunId(runId);
  const spec = GRAMMAR[sub].flags;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (!Object.prototype.hasOwnProperty.call(spec, t)) throw usage(`${sub} does not take ${lib.clip(t, 40)}`);
    const key = t.slice(2).replace(/-([a-z])/g, (m, ch) => ch.toUpperCase());
    if (Object.prototype.hasOwnProperty.call(opts, key)) throw usage(`${t} given twice`);
    if (spec[t] === 'bool') { opts[key] = true; continue; }
    if (i + 1 >= rest.length || /^--/.test(rest[i + 1])) throw usage(`${t} needs a value`);
    opts[key] = rest[++i];
  }
  if (sub === 'd') {
    if ((opts.continue || opts.notes !== undefined) && opts.supply === undefined) throw usage('--continue and --notes go with --supply only');
    if (opts.notes !== undefined && (opts.notes.length > 500 || /[\u0000-\u001f\u007f]/.test(opts.notes))) throw usage('--notes is one line of at most 500 characters');
  }
  if (sub === 'exec' && opts.maxGroups !== undefined) {
    if (!/^[1-9][0-9]{0,5}$/.test(opts.maxGroups)) throw usage('--max-groups needs a positive integer');
    opts.maxGroups = Number(opts.maxGroups);
  }
  return { sub, runId, opts };
}

async function main(argv) {
  let parsed = null; let cfg = null;
  try {
    parsed = parseArgs(argv);
    cfg = lib.loadConfig();
  } catch (e) {
    const f = lib.failureSummary(e, parsed && parsed.sub);
    lib.emitSummary({ subcommand: parsed ? parsed.sub : null, run_id: parsed ? parsed.runId : null, exit: f.exit, ...f.fields });
    return f.exit;
  }
  // The CSV store is writable only on the supervised path that stores a version: d --supply <csv> --continue.
  const allowCsv = parsed.sub === 'd' && parsed.opts.supply !== undefined && parsed.opts.continue === true;
  // The step: its module, its failure mapping and its detail file run/<run-id>/planner/<sub>.json (lib.runStep).
  const { summary } = await lib.runStep({ cfg, sub: parsed.sub, runId: parsed.runId, opts: parsed.opts, allowCsv });
  lib.emitSummary(summary);
  return summary.exit;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  // Only a failure of the summary itself lands here; still one JSON line.
  process.stdout.write(JSON.stringify({ ok: false, exit: EXIT.INTERNAL, error: `internal error: ${String(e && e.message).slice(0, 500)}`, code: 'internal' }) + '\n');
  process.exitCode = EXIT.INTERNAL;
});
