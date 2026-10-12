// planner/h.cjs - `planner h <run-id>`: steps/H-no-learn.md, record the result and change nothing.
//
// Step 1, onchain per market (the union of base-forecast.json's forecasts and the child rows of fills.json; parent-level
// rows, mint, consumed, middle and parent merges and redeems, are never scored): conditionId(), wrappedOutcome(0..2),
// parentMarket(), parentOutcome() off the child, payoutDenominator / payoutNumerators of the child and of its middle.
// Settled is (i) the child resolved, else (ii) the middle resolved without this repo (numerator 0): a middle-settled row.
// NOTHING SETTLED (every fresh run): no review.json is written, the result is `nothing settled yet` (SPEC-auto-fix8 M8);
// the report writes the line "<run-id>: nothing settled yet". When something settled: steps 2 to 7, review.json with
// calibration_update null and lessons [], rewritten only when the settled set differs from the one already recorded
// (idempotent). H signs nothing, sends nothing and writes nothing but review.json; for a prior run-id scored inside a
// wake (opts.prior) not even the planner's detail file is written there.
//
// The scoring path has run on mocks only (nothing has resolved). A complex-buy row adds its `filled` to its side's
// balance and 0 to the buys (step 4): its `filled x fill_price` is x, its whole net outlay (G section 3), and the set term
// already counts that split through its x child Invalid, so x is counted once; it has no leg in Cq either (step 5).
'use strict';

const lib = require('./lib.cjs');
const TB = require('./table.cjs');
const X = require('./exec-core.cjs');
const HB = require('./halfb.cjs');

const { Stop, clip } = lib;
const { lc } = X;
const PARENT = lc(TB.ADDR.PARENT);
const MIDDLES = new Set(TB.T.bundles.map((b) => lc(b.middle)));
const BUY = ['simple-buy', 'complex-buy', 'dual-buy'];
const SLOT = { DOWN: 0, UP: 1 };
const hstop = (cause, notes) => new Stop({ step: 'H', cause, status: null, notes });

const parentLevel = (r) => r.side === 'mint' || r.side === 'consumed' || lc(r.address) === PARENT || MIDDLES.has(lc(r.address));
const brier = (p, r) => (p && r ? p.reduce((s, x, i) => s + (x - r[i]) ** 2, 0) : null);

async function run(ctx) {
  const rid = ctx.runId; const prior = !!ctx.opts.prior;
  if (prior) ctx.noDetail = true;
  const skip = (reason) => ({ result: 'not scored', reason, review_written: false });
  const L = lib.readLock(ctx.cfg);
  if (L.exists && L.owner && L.owner.stage === 'claude-p' && (L.liveRuns || []).includes(rid)) return skip('listed in live-runs.txt (a live supervised session)');
  const own = L.exists && L.owner && L.owner.run_id === rid;
  if (!own && !HB.isFinalRun(ctx, rid)) return skip('not final (I-setup.md I.2 section 6): the start-of-run repair finalizes it first');
  if (!ctx.existsRun('base-forecast.json') && !ctx.existsRun('fills.json')) return { result: 'nothing to score', reason: 'no base-forecast.json and no fills.json', review_written: false };
  const bf = ctx.existsRun('base-forecast.json') ? ctx.readRunJson('base-forecast.json') : { forecasts: [] };
  if (bf.method && bf.method !== 'csv-face-value') throw hstop('other-arm', `base-forecast.json method is ${clip(bf.method, 40)}: not this arm's run-id; never scored by this H`);
  const bl = ctx.existsRun('blended.json') ? ctx.readRunJson('blended.json') : { blends: [] };
  const alloc = ctx.existsRun('allocation.json') ? ctx.readRunJson('allocation.json') : { positions: [] };
  const cands = ctx.existsRun('candidates.json') ? ctx.readRunJson('candidates.json').candidates : [];
  const F = ctx.existsRun('fills.json') ? ctx.readRunJson('fills.json') : { runs: [], retained_legs: [] };
  // the union, joined on the lowercased address
  const mk = new Map();
  for (const f of bf.forecasts || []) mk.set(lc(f.address), { market: f.market, address: lc(f.address) });
  for (const r of F.runs || []) if (!parentLevel(r) && TB.T.rows.some((x) => x.address === lc(r.address)) && !mk.has(lc(r.address))) mk.set(lc(r.address), { market: r.market, address: lc(r.address) });
  const markets = [...mk.values()];
  if (!markets.length) return { result: 'nothing to score', reason: 'no forecast and no child row', review_written: false };
  // step 1: the resolution reads
  const env = X.makeEnv(ctx, { step: 'H', holder: ctx.holder(), setup: null });
  const r1 = [];
  markets.forEach((m) => r1.push({ to: m.address, signature: 'conditionId()(bytes32)' }, { to: m.address, signature: 'wrappedOutcome(uint256)(address)', args: ['0'] }, { to: m.address, signature: 'wrappedOutcome(uint256)(address)', args: ['1'] }, { to: m.address, signature: 'wrappedOutcome(uint256)(address)', args: ['2'] }, { to: m.address, signature: 'parentMarket()(address)' }, { to: m.address, signature: 'parentOutcome()(uint256)' }));
  const o1 = (await env.mcChunked(r1, 360)).results;
  markets.forEach((m, k) => { const b = 6 * k; m.cond = o1[b][0]; m.wrapped = [o1[b + 1][0], o1[b + 2][0], o1[b + 3][0]].map(lc); m.middle = lc(o1[b + 4][0]); m.slot = String(o1[b + 5][0]); });
  const mids = [...new Set(markets.map((m) => m.middle))];
  const om = (await env.mcChunked(mids.map((a) => ({ to: a, signature: 'conditionId()(bytes32)' })), 360)).results;
  const midCond = new Map(mids.map((a, k) => [a, om[k][0]]));
  const r2 = [];
  markets.forEach((m) => { const c = m.cond; const mc = midCond.get(m.middle); r2.push({ to: TB.ADDR.CTF, signature: 'payoutDenominator(bytes32)(uint256)', args: [c] }, ...[0, 1, 2].map((i) => ({ to: TB.ADDR.CTF, signature: 'payoutNumerators(bytes32,uint256)(uint256)', args: [c, String(i)] })), { to: TB.ADDR.CTF, signature: 'payoutDenominator(bytes32)(uint256)', args: [mc] }, { to: TB.ADDR.CTF, signature: 'payoutNumerators(bytes32,uint256)(uint256)', args: [mc, m.slot] }); });
  const o2 = (await env.mcChunked(r2, 360)).results;
  markets.forEach((m, k) => {
    const b = 6 * k; const den = BigInt(o2[b][0]); const nums = [1, 2, 3].map((i) => BigInt(o2[b + i][0])); const mden = BigInt(o2[b + 4][0]); const mnum = BigInt(o2[b + 5][0]);
    if (den !== 0n) { m.settled = 'child'; m.realised = nums.map((x) => Number(x * 1000000000000n / den) / 1e12); }
    else if (mden !== 0n && mnum === 0n) { m.settled = 'middle'; m.realised = null; }
    else m.settled = null;
  });
  const settled = markets.filter((m) => m.settled);
  if (!settled.length) return { result: 'nothing settled yet', line: `${rid}: nothing settled yet`, markets_read: markets.length, review_written: false };
  // idempotent: a review.json that already records exactly this settled set is left as it is
  if (ctx.existsRun('review.json')) {
    try { const old = ctx.readRunJson('review.json'); const a = new Set((old.resolved || []).map((r) => lc(r.address))); if (a.size === settled.length && settled.every((m) => a.has(m.address))) return { result: 'unchanged', reason: 'no market newly settled since the last review.json', settled: settled.length, review_written: false }; } catch (e) { /* rewritten below */ }
  }
  // steps 2 to 6
  const fcOf = new Map((bf.forecasts || []).map((f) => [lc(f.address), f]));
  const blOf = new Map((bl.blends || []).map((b) => [lc(b.address), b]));
  const unitOf = new Map(cands.map((c) => [lc(c.address), c.collateral_symbol]));
  const resolved = []; const residuals = []; const stillHeld = [];
  for (const m of settled) {
    const a = m.address; const fc = fcOf.get(a); const b = blOf.get(a);
    const own = fc ? fc.p : null; const blended = b ? b.blended : null; const marketP = b ? b.market_price : null;
    const qf = (side) => { const p = (alloc.positions || []).find((x) => lc(x.address) === a && x.side === side); return p && Number.isFinite(Number(p.quoted_fill)) ? Number(p.quoted_fill) : null; };
    const mergeArb = (alloc.positions || []).some((x) => lc(x.address) === a && x.side === 'set' && x.route === 'merge-arb');
    const bal = [0, 0, 0]; let buys = 0; let buysQ = 0; let sells = 0; let sellsQ = 0; let consumed = 0; let setsMerged = 0; let qMerge = 0;
    for (const r of F.runs || []) {
      if (lc(r.address) !== a || !['filled', 'partial'].includes(r.status)) continue;
      const f = Number(r.filled) || 0; const p = Number(r.fill_price) || 0;
      if (SLOT[r.side] !== undefined && r.route === 'complex-buy') bal[SLOT[r.side]] += f; // its outlay x is the set term's split (step 4)
      else if (SLOT[r.side] !== undefined && BUY.includes(r.route)) { bal[SLOT[r.side]] += f; buys += f * p; const q = qf(r.side); buysQ += f * (q === null ? p : q); }
      else if (SLOT[r.side] !== undefined && r.route === 'sell-exit') { bal[SLOT[r.side]] -= f; sells += f * p; sellsQ += f * p; }
      else if (r.side === 'set' && r.route === 'set-sell') { sells += f * p; const q = qf('set'); sellsQ += f * (q === null ? p : q); }
      else if (r.route === 'buy-and-merge') {
        if (r.side === 'set' && mergeArb) { buys += f * p; const q = qf('set'); buysQ += f * (q === null ? p : q); qMerge += f; }
        else if (r.side === 'set') { setsMerged += f; bal[0] -= f; bal[1] -= f; }
        else if (SLOT[r.side] !== undefined) { bal[SLOT[r.side]] += f; buys += f * p; buysQ += f * p; }
        else if (r.side === 'Invalid') consumed += f;
      }
      // route redeem: ignored (a redeem converts at the realised payout, which proceeds counts from the balance)
    }
    const invKept = (F.retained_legs || []).filter((l) => lc(l.token) === m.wrapped[2]).reduce((s, l) => s + (Number(l.amount) || 0), 0);
    bal[2] = invKept - consumed - setsMerged;
    const setTerm = bal[2] + consumed;
    const Cf = setTerm + buys - sells; const Cq = setTerm + buysQ - sellsQ;
    if (bal.some((x) => Math.abs(x) > 1e-12)) stillHeld.push(m.market);
    if (m.settled === 'middle') {
      resolved.push({ market: m.market, address: a, own_p: own, blended_p: blended, market_p: marketP, realised_outcome: null, brier_own: null, brier_market: null, brier_blended: null, pnl: 0, pnl_unit: 'sUSDS', attribution: { edge: 0, slippage: 0, timing: 0, resolution_surprise: 0, fees: 0 } });
      continue;
    }
    const rl = m.realised;
    const proceeds = bal.reduce((s, x, i) => s + x * rl[i], 0) + qMerge;
    const pnl = proceeds - Cf;
    let att;
    if (blended) {
      att = { edge: bal.reduce((s, x, i) => s + x * blended[i], 0) + qMerge - Cq, slippage: Cq - Cf, timing: 0, resolution_surprise: bal.reduce((s, x, i) => s + x * (rl[i] - blended[i]), 0), fees: 0 };
    } else {
      const q = Math.min(bal[0], bal[1]) + qMerge;
      att = { edge: q - Cq, slippage: Cq - Cf, timing: 0, resolution_surprise: proceeds - q, fees: 0 };
    }
    const res = att.edge + att.slippage + att.timing + att.resolution_surprise + att.fees - pnl;
    if (Math.abs(res) > 1e-9) residuals.push({ market: m.market, residual: res });
    const noF = !fc;
    resolved.push({ market: m.market, address: a, own_p: noF ? null : own, blended_p: noF ? null : blended, market_p: noF ? null : marketP, realised_outcome: rl, brier_own: noF ? null : brier(own, rl), brier_market: noF ? null : brier(marketP, rl), brier_blended: noF ? null : brier(blended, rl), pnl, pnl_unit: unitOf.get(a) || null, attribution: att });
  }
  if (residuals.length) throw hstop('attribution-residual', `the attribution does not telescope to pnl on ${residuals.length} market(s) (a number came off the wrong row): ${clip(JSON.stringify(residuals.slice(0, 3)), 400)}; no review.json written`);
  const review = { generated_at: lib.nowIsoSec(), resolved, calibration_update: null, lessons: [] };
  ctx.writeRunJson('review.json', review);
  const byUnit = {}; resolved.forEach((r) => { byUnit[r.pnl_unit] = (byUnit[r.pnl_unit] || 0) + r.pnl; });
  return { result: 'review.json written', review: ctx.rel('review.json'), settled: settled.length, child_settled: settled.filter((m) => m.settled === 'child').length, middle_settled: settled.filter((m) => m.settled === 'middle').length, pnl_by_unit: byUnit, still_held: stillHeld.slice(0, 30), review_written: true };
}

module.exports = { run };
