'use strict';
// Merge the seven price-blind D parts into one base-forecast.json, refusing anything malformed rather than repairing it
// (seer-trade D Output section; deep-r3 E step 1 checks). Prints only counts and problems, never the numbers.
const fs = require('fs');
const path = require('path');

const RUN = process.argv[2];
const write = process.argv.includes('--write');
if (!RUN) { console.log('usage: merge-d.cjs <run dir> [--write]'); process.exit(2); }
const rd = (p) => JSON.parse(fs.readFileSync(path.join(RUN, p), 'utf8'));
const lc = (s) => String(s || '').toLowerCase();

const cands = rd('candidates.json').candidates;
const order = new Map(cands.map((c, i) => [lc(c.address), i]));
const problems = [];
const rows = [];
const methods = [];
let answered = 0;

for (let k = 1; k <= 7; k++) {
  const partFile = path.join('d-parts', `part-${k}.json`);
  if (!fs.existsSync(path.join(RUN, partFile))) { problems.push(`${partFile}: missing`); continue; }
  let part;
  try { part = rd(partFile); } catch (e) { problems.push(`${partFile}: not JSON (${String(e.message).split('\n')[0]})`); continue; }
  const pc = rd(path.join('d-input', `part-${k}.candidates.blind.json`)).candidates;
  const pq = rd(path.join('d-input', `part-${k}.question-policy.blind.json`)).markets;
  const qText = new Map(pq.map((m) => [lc(m.address), m.encoded_questions[0].text]));
  if (part.price_seen !== false) problems.push(`${partFile}: price_seen is ${JSON.stringify(part.price_seen)}, not false`);
  if (typeof part.method !== 'string' || !/calib=none/.test(part.method)) problems.push(`${partFile}: method missing or does not end with calib=none`);
  else methods.push(`part ${k}: ${part.method}`);
  if (typeof part.generated_at !== 'string') problems.push(`${partFile}: generated_at missing`);
  const fs_ = Array.isArray(part.forecasts) ? part.forecasts : [];
  if (fs_.length !== pc.length) problems.push(`${partFile}: ${fs_.length} forecasts for ${pc.length} markets`);
  const seen = new Set();
  for (const f of fs_) {
    const a = lc(f.address);
    const tag = `${partFile} ${a}`;
    if (!pc.some((c) => lc(c.address) === a)) { problems.push(`${tag}: address not in this part's inputs`); continue; }
    if (seen.has(a)) problems.push(`${tag}: duplicate`); seen.add(a);
    if (f.market !== qText.get(a)) problems.push(`${tag}: market is not the exact encoded question`);
    if (!Array.isArray(f.p) || f.p.length !== 3 || !f.p.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1)) { problems.push(`${tag}: p is not three numbers in [0,1]`); continue; }
    const s = f.p[0] + f.p[1] + f.p[2];
    if (!(Math.abs(s - 1) <= 1e-9)) problems.push(`${tag}: p sums to ${s}`);
    if (!(f.invalid_p > 0)) problems.push(`${tag}: invalid_p is not above zero`);
    if (f.invalid_p !== f.p[2]) problems.push(`${tag}: invalid_p differs from p[2]`);
    if (f.sums_to_one !== true) problems.push(`${tag}: sums_to_one is not true`);
    if (typeof f.reasoning !== 'string' || !/p_raw\s*=\s*\[/.test(f.reasoning)) problems.push(`${tag}: reasoning lacks p_raw=[...]`);
    if (!Array.isArray(f.sources) || f.sources.length === 0) problems.push(`${tag}: no sources`);
    if (typeof f.would_change_my_mind !== 'string' || f.would_change_my_mind.length < 10) problems.push(`${tag}: would_change_my_mind missing`);
    // a posted answer: a nonzero bond that is not the min_bond, or a nonzero best_answer (the worker's own words otherwise)
    if (/(?<!min_)\bbond\s*[:=]?\s*[1-9]|best_answer\s*[:=]?\s*0x0*[1-9a-f]/i.test(f.reasoning || '')) answered++;
    rows.push({ i: order.has(a) ? order.get(a) : 1e9, row: { market: f.market, address: a, p: f.p, invalid_p: f.invalid_p, sums_to_one: f.sums_to_one, reasoning: f.reasoning, sources: f.sources, would_change_my_mind: f.would_change_my_mind } });
  }
}

const covered = new Set(rows.map((r) => r.row.address));
const missing = cands.filter((c) => !covered.has(lc(c.address))).map((c) => c.market);
if (missing.length) problems.push(`no forecast for ${missing.length} candidate(s): ${missing.join(', ')}`);
rows.sort((x, y) => x.i - y.i);

console.log(`parts read: ${methods.length}/7, rows: ${rows.length}, candidates: ${cands.length}, rows mentioning a posted answer: ${answered}`);
if (problems.length) { console.log(`PROBLEMS (${problems.length}):`); for (const p of problems) console.log('  ' + p); }
if (!write) { console.log('dry check only, nothing written'); process.exit(problems.length ? 1 : 0); }
if (problems.length) { console.log('refusing to write base-forecast.json'); process.exit(1); }

const out = {
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  method: 'seer-trade D (D-base-forecast.md) swapped into deep-r3-trade for this run (one letter swapped: D; E identity, F max-ev, G mint-and-trade unchanged). '
    + 'Researched price-blind by seven fresh no-history workers through reference/price-blind-worker.md, 14 markets each, merged by the parent without changing a number. '
    + 'Per-part methods: ' + methods.join(' | ') + ' | merged calib=none',
  price_seen: false,
  forecasts: rows.map((r) => r.row),
};
const dest = path.join(RUN, 'base-forecast.json');
if (fs.existsSync(dest)) { console.log('base-forecast.json already exists, refusing to overwrite'); process.exit(1); }
fs.writeFileSync(dest, JSON.stringify(out, null, 2), { flag: 'wx' });
console.log(`wrote ${dest}: ${out.forecasts.length} forecasts, price_seen false`);
