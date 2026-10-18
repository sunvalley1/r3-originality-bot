// research/merge.cjs - checks the workers' parts of one run-id's research and merges them, values untouched, into
// run/<run-id>/research-forecast.json (the planner's d step checks it again and writes base-forecast.json).
// Usage: node merge.cjs <project root> <run-id> <work dir> <model> <effort> [tool]
// tool is how the workers ran, for the method string: codex (the default, GPT-6-Astra) or claude (Claude Opus 5.5).
// Exit 0, or 1 with every problem on stderr (then nothing is written and the run makes no new entry).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const [PROJECT, RID, WORK, MODEL, EFFORT, TOOL = 'codex'] = process.argv.slice(2);
if (!PROJECT || !RID || !WORK || !MODEL || !EFFORT) { console.error('merge: usage: node merge.cjs <project> <run-id> <work dir> <model> <effort> [tool]'); process.exit(1); }
const HOW = {
  codex: `Codex CLI exec, reasoning effort ${EFFORT}, live web search, workspace-write sandbox with no shell network, no user config or plugins`,
  claude: `Claude Code print mode, effort ${EFFORT}, restricted: no shell, file tools confined to the worker folder, market and explorer sites blocked for WebFetch, no user settings, CLAUDE.md, plugins, hooks or MCP`,
}[TOOL];
if (!HOW) { console.error(`merge: tool must be codex or claude, not ${TOOL}`); process.exit(1); }
// keep in step with the planner's lib.cjs RESEARCH_METHOD_PREFIX: it is how this arm recognizes its own run-ids
const PREFIX = 'seer-trade D (D-base-forecast.md) swapped into deep-r3-trade';
const runDir = path.join(PROJECT, 'run', RID);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const lc = (a) => String(a).toLowerCase();
const ROW_FIELDS = ['market', 'address', 'p', 'invalid_p', 'sums_to_one', 'reasoning', 'sources', 'would_change_my_mind'];

const partDirs = fs.readdirSync(WORK, { withFileTypes: true }).filter((d) => d.isDirectory() && /^part-\d+$/.test(d.name))
  .map((d) => d.name).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
if (!partDirs.length) { console.error('merge: no part folders in ' + WORK); process.exit(1); }
const problems = []; const byAddr = new Map(); const methods = [];
for (const name of partDirs) {
  const n = name.slice(5);
  const file = path.join(WORK, name, `part-${n}.json`);
  const want = readJson(path.join(WORK, name, `part-${n}.candidates.blind.json`)).candidates.map((c) => lc(c.address));
  if (!fs.existsSync(file)) { problems.push(`${name}: no part-${n}.json`); continue; }
  let part;
  try { part = readJson(file); } catch (e) { problems.push(`${name}: not valid JSON (${e.message.slice(0, 120)})`); continue; }
  if (part.price_seen !== false) problems.push(`${name}: price_seen is ${JSON.stringify(part.price_seen)}`);
  if (!Array.isArray(part.forecasts)) { problems.push(`${name}: forecasts is not an array`); continue; }
  const got = part.forecasts.map((f) => lc(f && f.address));
  if (got.length !== want.length) problems.push(`${name}: ${got.length} rows, not ${want.length}`);
  const missing = want.filter((a) => !got.includes(a)); const extra = got.filter((a) => !want.includes(a));
  if (missing.length || extra.length) problems.push(`${name}: addresses differ (missing ${missing.join(',') || '-'}; extra ${extra.join(',') || '-'})`);
  for (const f of part.forecasts) {
    const a = lc(f && f.address); const tag = `${name} ${a}`;
    const p = f && f.p;
    if (!Array.isArray(p) || p.length !== 3 || !p.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1)) { problems.push(`${tag}: p malformed ${JSON.stringify(p)}`); continue; }
    const sum = p[0] + p[1] + p[2];
    if (Math.abs(sum - 1) > 1e-9) problems.push(`${tag}: p sums to ${sum}`);
    if (!(p[2] > 0)) problems.push(`${tag}: Invalid is 0`);
    if (typeof f.invalid_p !== 'number' || Math.abs(f.invalid_p - p[2]) > 1e-12) problems.push(`${tag}: invalid_p ${f.invalid_p} != p[2] ${p[2]}`);
    if (typeof f.market !== 'string' || !f.market) problems.push(`${tag}: market is empty`);
    if (byAddr.has(a)) problems.push(`${tag}: duplicate address`);
    // invalid_p is set to exactly p[2] so the planner's strict equality check holds
    byAddr.set(a, { ...Object.fromEntries(ROW_FIELDS.filter((k) => f[k] !== undefined).map((k) => [k, f[k]])), address: a, invalid_p: p[2], sums_to_one: true });
  }
  methods.push(`${name}: ${String(part.method || '').replace(/\s+/g, ' ').slice(0, 300)}`);
}
if (problems.length) { console.error('merge: ' + problems.length + ' problem(s): ' + problems.slice(0, 20).join(' | ')); process.exit(1); }

fs.mkdirSync(path.join(runDir, 'd-parts'), { recursive: true });
for (const name of partDirs) { const n = name.slice(5); fs.copyFileSync(path.join(WORK, name, `part-${n}.json`), path.join(runDir, 'd-parts', `part-${n}.json`)); }
const order = readJson(path.join(runDir, 'candidates.blind.json')).candidates.map((c) => lc(c.address));
const forecasts = order.map((a) => byAddr.get(a));
if (forecasts.some((f) => !f)) { console.error('merge: a candidate has no forecast after the merge'); process.exit(1); }
const out = {
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  method: `${PREFIX} by the planner's research mode (one letter swapped: D; E identity, F max-ev, G mint-and-trade unchanged). Researched price-blind by ${partDirs.length} fresh no-history ${MODEL} workers (${HOW}) through reference/price-blind-worker.md, from this run-id's candidates.blind.json, question-policy.blind.json and onchain-state.blind.json; merged without changing any value. Parts: ${methods.join(' | ')} calib=none`,
  price_seen: false,
  forecasts,
};
fs.writeFileSync(path.join(runDir, 'research-forecast.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, run_id: RID, forecasts: forecasts.length, parts: partDirs.length }));
