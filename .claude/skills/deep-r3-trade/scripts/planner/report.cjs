// planner/report.cjs - `planner report <run-id>`: ./run/<run-id>/report.md from the run's artifacts (I-setup.md I.2
// section 4): what was sent (tx hashes), what was skipped and why, balances before and after, Half B, the answer watch,
// the markets decided but unreported, and the P&L so far from H, one line per run-id of this arm ("<run-id>: nothing
// settled yet" when H ran on it and found nothing settled, I.2 section 4). Inside a wake (opts.wake, never from the
// command line) it also writes the final wake-status.json; run alone it writes report.md only and never touches a
// wake-status.json. Reads files only; no chain read, no send.
'use strict';

const lib = require('./lib.cjs');
const X = require('./exec-core.cjs');
const EX = require('./exec.cjs');

const { clip } = lib;
const { weiStr, lc } = X;

function detail(ctx, rid, sub) {
  const rel = `run/${rid}/planner/${sub}.json`;
  try { return ctx.existsRel(rel) ? JSON.parse(ctx.readRel(rel).toString('utf8')).summary : null; } catch (e) { return null; }
}
const json = (ctx, rel, d) => { try { return ctx.existsRel(rel) ? JSON.parse(ctx.readRel(rel).toString('utf8')) : d; } catch (e) { return d; } };
const stopText = (s) => (s && s.stop ? `${s.stop.step || ''} stop ${s.stop.cause}: ${clip(s.stop.notes, 400)}` : s && s.error ? `error ${s.code}: ${clip(s.error, 300)}` : null);

function pnlLines(ctx, rid, hResults) {
  const out = [];
  const arm = EX.armRunIds(ctx);
  const ids = [...new Set([...arm.filter((d) => ctx.existsRel(`run/${d}/fills.json`)), ...(arm.includes(rid) ? [rid] : [])])].sort();
  for (const d of ids) {
    const hr = hResults && hResults[d];
    const rv = json(ctx, `run/${d}/review.json`, null);
    if (rv && Array.isArray(rv.resolved)) {
      const by = {}; rv.resolved.forEach((r) => { const u = r.pnl_unit || 'unknown unit'; by[u] = by[u] || { n: 0, pnl: 0 }; by[u].n++; by[u].pnl += Number(r.pnl) || 0; });
      out.push(`- ${d}: review.json, ${rv.resolved.length} settled market(s): ${Object.entries(by).map(([u, v]) => `${v.pnl.toFixed(6)} ${u}${v.n > 1 ? ` (${v.n} rows)` : ''}`).join('; ')} (each in its own unit; never summed across repo tokens)`);
      continue;
    }
    const own = d === rid ? (hr || detail(ctx, d, 'h')) : hr;
    if (own && own.result === 'nothing settled yet') out.push(`- ${d}: nothing settled yet`);
    else if (own && own.result === 'not scored') out.push(`- ${d}: not scored: ${own.reason}`);
    else if (own && own.result === 'nothing to score') out.push(`- ${d}: nothing to score (${own.reason})`);
    else if (own && own.stop) out.push(`- ${d}: not scored: H stopped (${own.stop.cause})`);
    else out.push(`- ${d}: not scored in this pass`);
  }
  return out;
}

async function run(ctx) {
  const rid = ctx.runId; const W = ctx.opts.wake || null;
  const S = (sub) => (W && W.steps && W.steps[sub] !== undefined ? W.steps[sub] : detail(ctx, rid, sub));
  const c = S('c'); const d = S('d'); const e = S('e'); const rp = S('ramp'); const f = S('f'); const g = S('g'); const ex = S('exec'); const hb = S('halfb');
  const scheduled = !!W || ctx.existsRun('wake-status.json');
  const L = [];
  L.push(`# deep-r3-trade run ${rid} - report (${scheduled ? 'scheduled, autonomous' : 'supervised'})`, '');
  // the top: what an operator must see first
  const top = [];
  if (W && W.status) top.push(`**Status: ${W.status}**${W.stopped_at_step ? ` (Half A stopped at ${W.stopped_at_step})` : ''}.`);
  for (const n of (W && W.notes) || []) top.push(n);
  if (hb && hb.resize_schedule && !top.includes(hb.resize_schedule)) top.unshift(hb.resize_schedule);
  if (hb && hb.answer_watch && hb.answer_watch.new_answers && hb.answer_watch.new_answers.length) top.push(`New Reality answers since ${hb.answer_watch.compared_with || 'the first watch'}: ${hb.answer_watch.new_answers.slice(0, 10).map((a) => `${a.market} (${a.kind}) best_answer ${a.best_answer} bond ${a.bond} finalize_ts ${a.finalize_ts}`).join('; ')}`);
  for (const x of (hb && hb.decided_but_unreported) || []) top.push(x);
  if (top.length) { L.push('## First'); L.push(''); top.forEach((t) => L.push(`- ${t}`)); L.push(''); }
  // Half A
  L.push('## Half A (today\'s entry)', '');
  const step = (name, s, ok) => L.push(`- **${name}**: ${!s ? 'not run' : s.ok === false || s.stop ? stopText(s) : ok(s)}`);
  step('C', c, (s) => `candidates.json, ${s.candidates} rows (${s.tradeable} tradeable), source ${s.source}`);
  step('D', d, (s) => `base-forecast.json, ${s.forecasts} forecasts from CSV v${s.csv && s.csv.version} (${s.csv && s.csv.reused ? 'reused' : 'new'}; matched ${s.csv && s.csv.counts.matched}, no forecast ${s.csv && s.csv.counts.no_forecast})`);
  step('E', e, (s) => `blended.json, ${s.blends} blends (identity)`);
  if (rp) step('PSM3 ramp', rp, (s) => (s.ran ? `sent before F: ${s.assets.map((a) => `${a.amount_in} ${a.asset} (quote ${a.quote_susds} sUSDS, floor ${a.min_amount_out})`).join(', ')}; sUSDS ${s.susds_before} -> ${s.susds_after}; record ${s.record}` : s.reason));
  step('F', f, (s) => `allocation.json, ${s.rows} rows on ${s.markets_with_rows} markets; staked ${s.staked_M} sUSDS of bankroll ${s.bankroll}${s.provisional ? ' (PROVISIONAL: sUSDS + PSM3 minAmountOut of the queued ramp)' : ''}; EV ${s.expected_value}${s.ramp_due && !s.provisional ? '; USDC or USDS still held at F: sized on the sUSDS balance alone (the wake sends the ramp before F; a supervised session sends it on its own yes)' : ''}`);
  step('G', g, (s) => (s.nothing_to_send ? 'nothing to send' : `g-plan.json, ${s.groups} groups, ${s.transactions} transactions; drift ${s.drift.pools_moved} of ${s.drift.pools_compared} pools moved`));
  step('exec', ex, (s) => `${s.outcome}: ${s.groups_done} of ${s.groups_total} groups, ${s.transactions_sent} transactions sent`);
  L.push('');
  // sends and skips, from the files
  const sends = json(ctx, `run/${rid}/exec-sends.json`, []);
  const F = json(ctx, `run/${rid}/fills.json`, null);
  if (sends.length) {
    const cost = sends.reduce((a, s) => a + BigInt(s.cost_wei || '0'), 0n);
    L.push(`## Sent (${sends.length} transactions, gas by receipts ${weiStr(cost)} ETH)`, '');
    for (const s of sends) L.push(`- nonce ${s.nonce} \`${s.tx_hash}\` ${s.group || ''} ${s.label}${s.source && s.source !== 'G' && s.source !== 'entry' ? ` [${s.source}]` : ''}`);
    L.push('');
  }
  if (F) {
    const sk = F.runs.filter((r) => r.status === 'skipped'); const pr = F.runs.filter((r) => r.status === 'partial' || r.status === 'reverted');
    L.push(`## Rows (fills.json): ${F.runs.length} rows, ${F.totals ? F.totals.positions_opened : 0} positions opened, ${sk.length} skipped, ${pr.length} partial or reverted, ${(F.retained_legs || []).length} retained legs`, '');
    const why = {}; sk.forEach((r) => { const k = clip(r.error || 'no reason', 160); why[k] = (why[k] || 0) + 1; });
    Object.entries(why).forEach(([k, n]) => L.push(`- skipped x${n}: ${k}`));
    pr.forEach((r) => L.push(`- ${r.status}: ${r.market} ${r.side} ${r.route}: ${clip(r.error || '', 200)}`));
    L.push('');
  }
  if (ex && ex.recovery) L.push(`**Recovery** (G section 8 step 4) of group ${ex.recovery.group} in this run: ${ex.recovery.outcome}${ex.recovery.decision ? ` (${ex.recovery.decision})` : ''}: ${ex.recovery.why}${(ex.recovery.txs || []).length ? `; sent ${ex.recovery.txs.join(', ')}` : ''}.`, '');
  if (ex && ex.half_done) L.push(`**Half-done group** ${ex.half_done.group}: ${ex.half_done.landed} of ${ex.half_done.of} transactions landed (${(ex.half_done.txs || []).join(', ')}); ${ex.half_done.recovery}.`, '');
  const st = json(ctx, `run/${rid}/exec-state.json`, null);
  if (st && st.balances_before) {
    const after = (ctx.listRunDir(rid).filter((n) => /^exec-balances-.*\.json$/.test(n)).sort().pop());
    const A = after ? json(ctx, `run/${rid}/${after}`, null) : null;
    const nz = (o) => Object.values(o || {}).filter((v) => BigInt(v) > 0n).length;
    L.push('## Balances', '');
    L.push(`- before: ETH ${st.eth_before ? weiStr(BigInt(st.eth_before)) : '?'}, sUSDS ${weiStr(BigInt(st.balances_before.sUSDS || '0'))}, ${nz(st.balances_before)} non-zero token balances`);
    if (A) L.push(`- after (${after}): ETH ${weiStr(BigInt(A.eth))}, sUSDS ${weiStr(BigInt((A.bal || {}).sUSDS || '0'))}, ${Object.keys(A.bal || {}).length} non-zero token balances`);
    L.push('');
  }
  // a swap's output or input differing from the build's quote: a pool moved between G's build and the send (G section 8,
  // The head moves); reported here, never a stop (each call's floor guarded the send)
  const moved = st && st.groups ? Object.entries(st.groups).flatMap(([id, gs]) => (gs.effects_diffs || []).filter((x) => x.kind === 'pool moved since build').map((x) => ({ id, ...x }))) : [];
  if (moved.length) {
    L.push(`## Pool moved since build (${moved.length} balance(s); reported, never a stop)`, '');
    moved.forEach((x) => L.push(`- ${x.id} ${x.token}: realised ${weiStr(BigInt(x.got))}, build quote ${weiStr(BigInt(x.expected))} (difference ${weiStr(BigInt(x.diff))}), fresh pre-send quote ${weiStr(BigInt(x.fresh_quote))}`));
    L.push('');
  }
  // Half B
  L.push('## Half B (session-2 merges and redeems)', '');
  if (!hb) L.push('- not run');
  else if (hb.ok === false && !hb.actionable) L.push(`- ${stopText(hb)}`);
  else {
    L.push(`- ${hb.run_ids_holding_fills} run-id(s) of this arm hold fills; processed ${(hb.processed || []).join(', ') || 'none'}; held children ${hb.held_children}; settled children ${(hb.settled_children || []).length}; middles resolved ${(hb.middles_resolved || []).join(',') || 'none'}; parent resolved ${hb.parent_resolved}`);
    for (const a of hb.actionable || []) L.push(`- level ${a.level}: ${a.groups.map((x) => `${x.id} (${x.txs} tx)`).join(', ')}; simulation ${a.simulation_clean ? 'clean' : 'NOT clean'}`);
    for (const s of hb.sent || []) L.push(`- sent ${s.id} (recorded in run ${s.book}): ${s.txs.join(', ')}`);
    for (const s of hb.skipped || []) L.push(`- skipped ${s.id}: ${s.why}`);
    for (const n of hb.notes || []) L.push(`- ${n}`);
    if (hb.stop) L.push(`- stopped: ${stopText(hb)}`);
    for (const h of hb.half_done || []) L.push(`- half-done: ${h.group}, ${h.landed} of ${h.of} transactions landed (${(h.txs || []).join(', ')})`);
    if (!(hb.actionable || []).length) L.push('- nothing actionable');
  }
  L.push('');
  // P&L so far
  L.push('## P&L so far (H; settled markets only, each in its own unit)', '');
  pnlLines(ctx, rid, W ? W.h : null).forEach((l) => L.push(l));
  if (W && W.h) for (const [k, v] of Object.entries(W.h)) if (v && v.still_held && v.still_held.length) L.push(`- ${k}: resolved and still held (redeem is Half B's): ${v.still_held.join(', ')}`);
  L.push('');
  // the answer watch, and its machine line for the next run's comparison
  if (hb && hb.answer_watch) {
    L.push('## Answer watch (reporting only)', '');
    L.push(`- ${hb.answer_watch.questions} questions read at block ${hb.answer_watch.read_at_block}; ${hb.answer_watch.new_answers.length} new or changed since ${hb.answer_watch.compared_with || 'none (first watch)'}`);
    L.push('');
    const state = (json(ctx, `run/${rid}/planner/halfb.json`, { detail: {} }).detail || {}).answer_watch_state || null;
    if (state) L.push(`<!-- answer-watch: ${JSON.stringify({ read_at: lib.nowIso(), questions: state })} -->`);
  }
  ctx.writeRun('report.md', L.join('\n') + '\n');
  let ws = null;
  if (W && W.final) {
    ws = { run_id: rid, started_at: W.started_at, finished_at: lib.nowIso(), status: W.status, stopped_at_step: W.stopped_at_step || 'H', cadence_hours: W.cadence_hours === undefined ? null : W.cadence_hours, bankroll: f && f.bankroll !== undefined ? f.bankroll : null, positions_sent: F ? F.runs.filter((r) => r.tx_hash && ['filled', 'partial'].includes(r.status) && !['mint', 'consumed'].includes(r.side) && !['buy-and-merge', 'redeem'].includes(r.route)).length : 0, h_rescored: W.h_rescored || [], csv: d && d.csv ? { version: d.csv.version, path: d.csv.path, sha256: d.csv.sha256, supplied_at: d.csv.supplied_at, reused: d.csv.reused, counts: d.csv.counts } : null, notes: (W.notes || []).join(' | ') };
    ctx.writeRunJson('wake-status.json', ws);
  }
  return { report: ctx.rel('report.md'), lines: L.length, wake_status: ws ? { path: ctx.rel('wake-status.json'), status: ws.status } : null };
}

module.exports = { run, pnlLines };
