// research/prep.cjs - the price-blind inputs of one run-id's research (research mode of the planner's d step).
// Usage: node prep.cjs <project root> <run-id> <research dir> <work dir> <parts> [task template]
// The task template is a file name in <research dir> (default TASK.template.md, the Codex workers' brief;
// TASK.claude.template.md is the Claude workers' brief).
//
// Reads run/<run-id>/candidates.json (the tradeable scalar rows, through the allowlist of
// seer-trade/reference/price-blind-worker.md), <research dir>/question-policy.blind.json (the immutable onchain
// questions, bounds and policy text) and run/<run-id>/onchain-state.blind.json (the Reality.eth state d read). Writes
// the run's own blind files (candidates.blind.json, question-policy.blind.json, d-input/) and one isolated worker
// folder per part under <work dir>, outside the project: the part's inputs, the docs and TASK.md. Exit 0, or 1 with
// the reason on stderr. Reads and writes no price.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const [PROJECT, RID, RESEARCH, WORK, PARTS_ARG, TEMPLATE_ARG] = process.argv.slice(2);
const fail = (msg) => { console.error('prep: ' + msg); process.exit(1); };
if (!PROJECT || !RID || !RESEARCH || !WORK || !PARTS_ARG) fail('usage: node prep.cjs <project> <run-id> <research dir> <work dir> <parts> [task template]');
const PARTS = Number(PARTS_ARG);
if (!Number.isInteger(PARTS) || PARTS < 1 || PARTS > 16) fail('parts must be an integer 1..16');
const TEMPLATE = TEMPLATE_ARG || 'TASK.template.md';
if (!/^TASK(\.[a-z]+)?\.template\.md$/.test(TEMPLATE)) fail(`task template must be a TASK*.template.md file name, not ${TEMPLATE}`);
const runDir = path.join(PROJECT, 'run', RID);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const pick = (value, keys) => Object.fromEntries(keys.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]));
const lc = (a) => String(a).toLowerCase();

// candidates.blind.json: the allowlist of price-blind-worker.md, tradeable scalar rows only
const source = readJson(path.join(runDir, 'candidates.json'));
const rows = source.candidates.filter((c) => c.kind === 'scalar' && c.tradeable === true);
if (!rows.length) fail('no tradeable scalar candidate');
for (const c of rows) if (JSON.stringify(c.outcomes) !== JSON.stringify(['DOWN', 'UP', 'Invalid'])) fail(`${c.market}: outcomes ${JSON.stringify(c.outcomes)}`);
const blindCandidates = {
  chain_id: source.chain_id,
  candidates: rows.map((c) => ({
    ...pick(c, ['market', 'address', 'kind', 'outcomes', 'collateral_symbol', 'resolves_on', 'resolution_source', 'tradeable']),
    parent: c.parent ? pick(c.parent, ['address', 'outcome_index']) : null,
    pools: (c.pools || []).map((p) => ({ outcome: p.outcome, fee_tier: p.fee_tier, has_liquidity: Number(p.liquidity || 0) > 0 })),
    traded: c.traded ? pick(c.traded, ['swaps', 'distinct_traders', 'hours_since_last']) : null,
  })),
};

// question-policy.blind.json: re-projected through its allowlist; every row's question must name its repo
const qpAll = readJson(path.join(RESEARCH, 'question-policy.blind.json'));
const qpBy = new Map(qpAll.markets.map((m) => [lc(m.address), {
  address: lc(m.address),
  encoded_questions: (m.encoded_questions || []).map((q) => pick(q, ['index', 'text', 'source_url', 'block_number'])),
  lower_bound: m.lower_bound === undefined ? null : m.lower_bound,
  upper_bound: m.upper_bound === undefined ? null : m.upper_bound,
  policy_sources: (m.policy_sources || []).map((s) => pick(s, ['url', 'version', 'text'])),
}]));
for (const c of rows) {
  const m = qpBy.get(lc(c.address));
  if (!m) fail(`${c.market}: no question-policy entry for ${c.address}`);
  const text = m.encoded_questions[0] && m.encoded_questions[0].text;
  if (typeof text !== 'string' || !text.toLowerCase().includes(lc(c.market))) fail(`${c.market}: the encoded question does not name the repo`);
}

// onchain-state.blind.json: the Reality.eth state the planner's d step read, re-projected
const stAll = readJson(path.join(runDir, 'onchain-state.blind.json'));
const stBy = new Map((stAll.markets || []).map((m) => [lc(m.address), pick(m, ['address', 'question_id', 'answer_posted', 'finalize_ts', 'best_answer_score', 'best_answer_label', 'bond_wei', 'pending_arbitration'])]));
for (const c of rows) if (!stBy.has(lc(c.address))) fail(`${c.market}: no onchain state for ${c.address}`);

// the parts, in C's order, and one isolated worker folder each
const docsDir = path.join(RESEARCH, 'docs');
const docs = ['D-base-forecast.md', 'price-blind-worker.md', 'seer-protocol-scalar-triple.md', 'seer-markets-resolution-policy.pdf'];
for (const d of docs) if (!fs.existsSync(path.join(docsDir, d))) fail(`missing ${path.join(docsDir, d)}`);
const template = fs.readFileSync(path.join(RESEARCH, TEMPLATE), 'utf8');
const size = Math.ceil(rows.length / PARTS);
const priceWords = /\b(price|prices|priced|odds|quote|quotes|volume|tvl)\b/i;
const today = new Date().toISOString().slice(0, 10);
let made = 0;
for (let n = 1; n <= PARTS; n++) {
  const part = blindCandidates.candidates.slice((n - 1) * size, n * size);
  if (!part.length) break;
  made++;
  const addrs = part.map((r) => lc(r.address));
  const files = {
    [`part-${n}.candidates.blind.json`]: { chain_id: blindCandidates.chain_id, candidates: part },
    [`part-${n}.question-policy.blind.json`]: { chain_id: qpAll.chain_id, generated_at: qpAll.generated_at, markets: addrs.map((a) => qpBy.get(a)) },
    [`part-${n}.onchain-state.blind.json`]: { chain_id: stAll.chain_id, block: stAll.block, block_timestamp: stAll.block_timestamp, note: stAll.note, markets: addrs.map((a) => stBy.get(a)) },
  };
  const dir = path.join(WORK, `part-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const s = JSON.stringify(value);
    const m = s.match(priceWords);
    if (m) fail(`${name} holds a price-like word near "${s.slice(Math.max(0, m.index - 60), m.index + 60)}"; nothing dispatched`);
    writeJson(path.join(runDir, 'd-input', name), value);
    writeJson(path.join(dir, name), value);
  }
  for (const d of docs) fs.copyFileSync(path.join(docsDir, d), path.join(dir, d));
  const task = template.replaceAll('{{N}}', String(n)).replaceAll('{{COUNT}}', String(part.length)).replaceAll('{{BLOCK}}', String(stAll.block)).replaceAll('{{TODAY}}', today);
  fs.writeFileSync(path.join(dir, 'TASK.md'), task, 'utf8');
}
writeJson(path.join(runDir, 'candidates.blind.json'), blindCandidates);
writeJson(path.join(runDir, 'question-policy.blind.json'), { chain_id: qpAll.chain_id, generated_at: qpAll.generated_at, markets: rows.map((c) => qpBy.get(lc(c.address))) });
console.log(JSON.stringify({ ok: true, run_id: RID, markets: rows.length, parts: made, per_part: size, block: stAll.block, work: WORK }));
