// planner/exec.cjs - `planner exec <run-id> [--check] [--max-groups N]`: the sequential executor of
// steps/G-mint-and-trade.md section 8, ported from the live executor that sent the first live run (2026-10-06: 74 groups,
// 278 transactions, every group's balance effects equal to the plan), with the live fixes:
//   - the three-part pre-send gas check (exec-core gasCheck), never `gasUsed x 1.5 <= gas_limit`;
//   - no block equality between two reads anywhere (G section 8, The head moves);
//   - affordability per group, ETH >= 0.002 ETH + sum of gas_limit x 2 x eth_gasPrice, read fresh before the group's
//     first write-ahead; a group that cannot be afforded is skipped with every later one (exit 3); ETH is not re-checked
//     inside a group.
// It also: takes no `signer info` (identity is the plan's signer sha256 against the configured signer file, the holder
// from the helper config, nonce_pinning from the setup record); writes inflight.json and the attempt with `to`; writes
// fills.json rows as they land, G's skipped rows, retained_legs as THIS run's own amounts (one entry per token, `why`
// ending in `sources:`), and the cross-run "consumed" rows into the source run-ids' fills.json (G Output).
//
// Before the plan's first send (no group started yet), the trading boundary of every group in one pass: a group past its
// boundary stops the run before the parent mint is sent, never after (a partial mint): before the run's first broadcast
// in autonomous mode it asks the wake for its once-only re-plan (replan_due), after one it writes every group skipped. A
// mint group's boundary is its own level's flip since G's plan-time reading; a trade group's is its child's (G section 3).
// After each group, its balance deltas against the plan's expected effects: exact on every delta no pool decides (a
// mint, a split, an exact-output count, a child Invalid kept or merged, a leg that ends at 0), a stop otherwise; a delta
// a pool decides (a swap's output, an exact-output swap's input) is reported as "pool moved since build" when a third
// party moved the pool after the build, and only held to the calldata's own bound (G section 8, The head moves).
// A merge-arb group (buy-and-merge) re-reads its child Invalid before it is sent (below q: stale, G section 1), and once
// it lands the side "Invalid" rows of the child Invalid it consumed go to the earlier run-ids that retained it, oldest
// first (G Output, Cross-run Invalid accounting).
//
// --check sends nothing: it re-hashes and policy-checks every remaining signer-input file, reads the boundary, quotes
// every swap against its bound, simulates the remaining plan, re-encodes the complex-buy rebuild on the plan's own
// numbers, projects affordability, runs the full pre-send path on the next transaction without its send, and settles
// the attempts already recorded.
//
// The lock (exec-core lockMode): inside the wrapper (owner.txt stage "claude-p" naming this run-id) it is used, never
// taken again or released; otherwise (a supervised session) the planner takes it for this invocation and releases it.
// A stop stops sending: the open nonce is settled, the group in progress keeps what landed (rows `partial`), every group
// not started is written `skipped`. Inside the wrapper a group left half-done then goes to G section 8 step 4's recovery
// rule in the same run (recoverGroup, below; summary `recovery`); one it does not complete or unwind is reported in
// `half_done`, a wake then ends `aborted` (cause `half-done`), and the next wake's start-of-run repair appends the rows
// of what landed later (repairPlanRows, below) and applies the rule again. A supervised batch's recovery has its own "yes".
'use strict';

const lib = require('./lib.cjs');
const TB = require('./table.cjs');
const G = require('./g-lib.cjs');
const X = require('./exec-core.cjs');

const { Stop, EXIT, clip } = lib;
const { lc, toWei, weiStr, num, eth } = X;

const A = {
  sUSDS: lc(TB.ADDR.sUSDS), ROUTER: TB.ADDR.ROUTER, CTF: TB.ADDR.CTF, SWAP: TB.ADDR.SWAP, QUOTER: TB.ADDR.QUOTER, MC3: TB.ADDR.MC3,
  REALITY: TB.ADDR.REALITY, PARENT: lc(TB.ADDR.PARENT), PARENT_INVALID: TB.ADDR.PARENT_INVALID, USDC: TB.ADDR.USDC, USDS: TB.ADDR.USDS,
};
const XS = TB.T.bundles.map((b) => b.name);
const BUNDLE = Object.fromEntries(TB.T.bundles.map((b) => [b.name, b.bundleToken]));
const MIDDLE = Object.fromEntries(TB.T.bundles.map((b) => [b.name, lc(b.middle)]));
const MIDINV = Object.fromEntries(TB.T.bundles.map((b) => [b.name, b.middleInvalid]));
const CONDS = TB.CONDITIONS;
const STEP = 'G';
const RESERVE_MS = 10 * 60 * 1000; // the time kept for Half B, H and the final wake-status.json / report.md write

const SIG_IN = 'quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)';
const SIG_OUT = 'quoteExactOutputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)';
const MIN_SQRT = 4295128740n; const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
const SLOT0 = 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)';
const spotOf = (sqrt, T0) => { const s = Number(sqrt) / 2 ** 96; const p = s * s; return T0 ? p : 1 / p; };

const stop = (kind, notes, fields) => X.xstop(STEP, kind, notes, fields);
const IF_SIGS = ['function approve(address,uint256)', 'function splitPosition(address,address,uint256)', 'function mergePositions(address,address,uint256)',
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))',
  'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96))'];

// ---------------------------------------------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------------------------------------------
async function quote(R, kind, tokenIn, tokenOut, fee, amt) {
  try {
    const r = await R.env.mc([{ to: A.QUOTER, signature: kind === 'in' ? SIG_IN : SIG_OUT, args: [[tokenIn, tokenOut, String(amt), fee, 0]] }]);
    const x = r.results[0]; const sq = BigInt(x[1]); const ticks = Number(x[2]);
    return { ok: ticks === 0 && sq !== MIN_SQRT && sq !== MAX_SQRT, amt: BigInt(x[0]), sqrtAfter: sq, ticks };
  } catch (e) { if (e instanceof lib.ToolFailure && (e.helperExit === 8 || e.code === 'call_reverted')) return { ok: false, reverted: true, why: clip(e.message, 200) }; throw e; }
}
const mintX = (g) => (g.id === 'mint-parent' ? 'parent' : g.id.startsWith('mint-middle-') ? g.id.slice(-1) : null);

// the tokens a group's balances are tracked on: name -> address
function watch(R, g) {
  if (g.market_refs) { const m = g.market_refs; return { repo: m.repo_token, up: m.up, down: m.down, inv: m.child_invalid }; }
  const x = mintX(g);
  if (x === 'parent') return { sUSDS: A.sUSDS, bundleA: BUNDLE.A, bundleB: BUNDLE.B, bundleC: BUNDLE.C, parentInvalid: A.PARENT_INVALID };
  const w = { ['bundle' + x]: BUNDLE[x], ['midInv' + x]: MIDINV[x] }; R.repoOfBundle[x].forEach((r) => { w['repo:' + r] = r; }); return w;
}
// expected balance deltas of a group, in wei (plan.expected_effects, written by g-verify)
function expectedDeltas(R, g) {
  const e = g.expected_effects; const out = {};
  if (g.market_refs) {
    const mp = { repo: 'repo', UP: 'up', DOWN: 'down', childInvalid: 'inv' };
    for (const [k, v] of Object.entries(e)) { if (!mp[k]) throw stop('plan-shape', `unknown effect key ${clip(k, 40)} in ${g.id}`); out[mp[k]] = toWei(v); }
    for (const n of ['repo', 'up', 'down', 'inv']) if (out[n] === undefined) out[n] = 0n;
    return out;
  }
  const x = mintX(g);
  if (x === 'parent') { out.sUSDS = toWei(e.sUSDS); XS.forEach((b) => { out['bundle' + b] = toWei(e['bundle' + b]); }); out.parentInvalid = toWei(e.parentInvalid); return out; }
  out['bundle' + x] = toWei(e['bundle' + x]); out['midInv' + x] = toWei(e['middleInvalid' + x]);
  const rk = Object.keys(e).find((k) => k.startsWith('each of the')); R.repoOfBundle[x].forEach((r) => { out['repo:' + r] = toWei(e[rk]); });
  return out;
}
// A trade group's boundary is its child's (G section 3). A mint group's is its own level's (the parent or a middle),
// judged against the plan-time reading G recorded (pre_send_checks): only a flip since the plan makes it stale, because
// a resolved middle or parent refuses no split by itself (C-select.md step 4 keeps a child of a resolved middle
// tradeable while its numerator is nonzero, and splitPosition does not check resolution).
function boundaryOf(R, g) {
  if (g.market_refs) return { label: g.market, cond: g.pre_send_checks.condition_id, qids: [g.pre_send_checks.question_id] };
  const x = mintX(g); const b = R.BND[x]; if (!b) throw stop('internal', 'boundary of ' + g.id + ' not loaded');
  return g.pre_send_checks && g.pre_send_checks.level ? { ...b, build: g.pre_send_checks } : b;
}
const boundaryReq = (b) => { const c = [{ to: A.CTF, signature: 'payoutDenominator(bytes32)(uint256)', args: [b.cond] }]; for (const q of b.qids) c.push({ to: A.REALITY, signature: 'isPendingArbitration(bytes32)(bool)', args: [q] }, { to: A.REALITY, signature: 'getFinalizeTS(bytes32)(uint32)', args: [q] }, { to: A.REALITY, signature: 'getOpeningTS(bytes32)(uint32)', args: [q] }); return c; };
// G section 3. A trade group (its child): payoutDenominator 0, no arbitration, opening nonzero, finalize_ts not already
// past. A mint group (build = its level's plan-time reading): no flip of payoutDenominator or isPendingArbitration since
// that reading, opening nonzero, and, on a level unresolved at build, finalize_ts not already past.
function boundaryEval(slice, ts, nq, build) {
  const why = []; const payout = BigInt(slice[0][0]);
  const payoutAtBuild = build ? BigInt(build.payoutDenominator_at_build) : 0n;
  if (payout !== payoutAtBuild) why.push(build ? `payoutDenominator ${payout}, ${payoutAtBuild} at build (a flip since the plan)` : 'payoutDenominator ' + payout);
  for (let k = 0; k < nq; k++) {
    const pending = slice[1 + 3 * k][0]; const fin = BigInt(slice[2 + 3 * k][0]); const open = BigInt(slice[3 + 3 * k][0]);
    const qb = build ? (build.questions_at_build || [])[k] : null;
    if (build && !qb) why.push(`question ${k} has no plan-time reading`);
    const pendingAtBuild = qb ? qb.isPendingArbitration : false;
    if (pending !== pendingAtBuild) why.push(`isPendingArbitration ${pending}${build ? `, ${pendingAtBuild} at build (a flip since the plan)` : ''}`);
    if (open === 0n) why.push('getOpeningTS is 0 (a failed read is never clear)');
    if (payoutAtBuild === 0n && fin !== 0n && fin <= ts) why.push(`finalize_ts ${fin} <= now ${ts} (decided but unreported)`);
  }
  return { clear: why.length === 0, why };
}
// the boundary of every group given, in one pass (exec --check, and the live run before the plan's first send)
async function boundaryPass(R, groups) {
  const bcalls = []; const bix = [];
  for (const g of groups) { const b = boundaryOf(R, g); const req = boundaryReq(b); bix.push([bcalls.length, req.length, g, b]); bcalls.push(...req); }
  bcalls.push({ to: A.MC3, signature: 'getCurrentBlockTimestamp()(uint256)' });
  const bo = await R.env.mcChunked(bcalls, 400); const ts = BigInt(bo.results[bo.results.length - 1][0]);
  const notClear = [];
  for (const [s, len, g, b] of bix) { const ev = boundaryEval(bo.results.slice(s, s + len), ts, b.qids.length, b.build); if (!ev.clear) notClear.push({ id: g.id, why: ev.why.join('; ') }); }
  return notClear;
}
// one multicall: block ts, ETH, boundary, the group's balances, the two pools' slot0
async function readGroupState(R, g, { withSlot = true } = {}) {
  const w = watch(R, g); const names = Object.keys(w); const calls = []; const ix = {};
  calls.push({ to: A.MC3, signature: 'getCurrentBlockTimestamp()(uint256)' }, { to: A.MC3, signature: 'getEthBalance(address)(uint256)', args: [R.holder] });
  const b = boundaryOf(R, g); ix.bnd = calls.length; const bq = boundaryReq(b); calls.push(...bq);
  ix.bal = calls.length; names.forEach((n) => calls.push({ to: w[n], signature: 'balanceOf(address)(uint256)', args: [R.holder] }));
  ix.slot = calls.length; const slotOn = withSlot && g.market_refs; if (slotOn) calls.push({ to: g.market_refs.pools.UP, signature: SLOT0 }, { to: g.market_refs.pools.DOWN, signature: SLOT0 });
  const out = await R.env.mcChunked(calls, 400); const Rr = out.results; const ts = BigInt(Rr[0][0]);
  const st = { block: out.block, ts, eth: BigInt(Rr[1][0]), bnd: boundaryEval(Rr.slice(ix.bnd, ix.bnd + bq.length), ts, b.qids.length, b.build), bal: {}, slot: null };
  names.forEach((n, k) => { st.bal[n] = BigInt(Rr[ix.bal + k][0]); });
  if (slotOn) { const m = g.market_refs; const up = spotOf(BigInt(Rr[ix.slot][0]), m.token0_is_outcome.UP); const dn = spotOf(BigInt(Rr[ix.slot + 1][0]), m.token0_is_outcome.DOWN); st.slot = { UP: up, DOWN: dn, sum: up + dn }; }
  return st;
}
async function readBalances(R, g) {
  const w = watch(R, g); const names = Object.keys(w);
  const o = await R.env.mcChunked([{ to: A.MC3, signature: 'getEthBalance(address)(uint256)', args: [R.holder] }, ...names.map((n) => ({ to: w[n], signature: 'balanceOf(address)(uint256)', args: [R.holder] }))], 400);
  const bal = {}; names.forEach((n, k) => { bal[n] = BigInt(o.results[1 + k][0]); }); return { block: o.block, eth: BigInt(o.results[0][0]), bal };
}
// every token this run can hold: name -> address (before / after the run; retained_legs)
function allTokens(R) {
  const t = { sUSDS: A.sUSDS, USDC: A.USDC, USDS: A.USDS, parentInvalid: A.PARENT_INVALID };
  for (const x of XS) { t['bundle' + x] = BUNDLE[x]; t['midInv' + x] = MIDINV[x]; }
  R.ALL_REPO.forEach((r) => { t['repo:' + r] = r; });
  for (const g of R.TRADED) { const m = g.market_refs; t['up:' + g.market] = m.up; t['down:' + g.market] = m.down; t['inv:' + g.market] = m.child_invalid; }
  return t;
}
async function readAll(R) {
  const t = allTokens(R); const names = Object.keys(t);
  const o = await R.env.mcChunked([{ to: A.MC3, signature: 'getEthBalance(address)(uint256)', args: [R.holder] }, ...names.map((n) => ({ to: t[n], signature: 'balanceOf(address)(uint256)', args: [R.holder] }))], 400);
  const bal = {}; names.forEach((n, k) => { bal[n] = BigInt(o.results[1 + k][0]); }); return { block: o.block, eth: BigInt(o.results[0][0]), bal, names };
}

// ---------------------------------------------------------------------------------------------------------------
// state and rows
// ---------------------------------------------------------------------------------------------------------------
const saveState = (R) => R.ctx.writeRunJson('exec-state.json', R.STATE, { indent: 1 });
function rowsOfGroup(R, g) {
  if (!g.market_refs) { const x = mintX(g); return [{ market: x === 'parent' ? 'PARENT-MINT' : MIDDLE[x], address: x === 'parent' ? A.PARENT : MIDDLE[x], side: 'mint', route: 'split-parent', requested: num(x === 'parent' ? R.M_WEI : BigInt(R.mX[x] || 0)) }]; }
  return g.allocation_rows.map((r) => ({ market: g.market, address: lc(g.address), side: r.side, route: g.recorded_route, requested: r.stake }));
}
function alreadyRowed(R, r) { return R.book.fills().runs.some((x) => lc(x.address) === lc(r.address) && x.side === r.side && x.route === r.route); }
function addRow(R, row) { R.book.addRows([row]); R.ctx.log(`fills row: ${row.market} ${row.side} ${row.route} ${row.status} filled ${row.filled}`); }
const skippedRow = (r, reason) => ({ ...r, filled: 0, fill_price: 0, slippage_vs_quote: 0, tx_hash: null, status: 'skipped', error: clip(reason, 600) });
// G's own skipped rows (section 5e of the print): written once, status skipped, F's route kept
function writePlanSkips(R) {
  const rows = [];
  for (const s of R.plan.skipped_rows || []) {
    const r = { market: s.market, address: lc(s.address), side: s.side, route: s.route, requested: s.stake };
    if (!alreadyRowed(R, r)) rows.push(skippedRow(r, `skipped by G: ${s.reason || 'no reason recorded'}`));
  }
  if (rows.length) R.book.addRows(rows);
}
function skipRowsFrom(R, gi, reason) {
  const out = [];
  for (let k = gi; k < R.GROUPS.length; k++) {
    const g = R.GROUPS[k]; const st = R.STATE.groups[g.id];
    if (st && st.status === 'done') continue;
    for (const r of rowsOfGroup(R, g)) if (!alreadyRowed(R, r) && !out.some((o) => o.address === r.address && o.side === r.side && o.route === r.route)) out.push(skippedRow(r, reason));
    R.STATE.groups[g.id] = { ...(st || {}), status: 'skipped', reason: clip(reason, 400) };
  }
  R.book.addRows(out); saveState(R);
  return R.GROUPS.slice(gi).filter((g) => R.STATE.groups[g.id] && R.STATE.groups[g.id].status === 'skipped').map((g) => g.id);
}

// ---------------------------------------------------------------------------------------------------------------
// the whole remaining plan in eth_simulateV1 (windowed exactly like G when it must be), with no call flagged "return"
// ---------------------------------------------------------------------------------------------------------------
async function simulateRemaining(R, fromGi, tag) {
  const groups = R.GROUPS.slice(fromGi).map((g) => ({ ...g, txs: g.txs.map((t) => { const u = { ...t }; delete u.ret; return u; }) }));
  let nMint = 0; while (nMint < groups.length && groups[nMint].kind === 'mint') nMint++;
  const io = { simulate: async (name, gs) => { R.ctx.writeRun(name, JSON.stringify(gs)); return R.env.H(['simulate', R.ctx.rel(name)]); } };
  const sim = await G.simulatePlan(R.ctx, io, groups, nMint, `exec-sim-${tag}`);
  const want = groups[0].txs[0].nonce_expected;
  const problems = []; let firstFailed = null;
  for (const w of sim.windows) {
    const pb = G.pageProblems(w.page, { entries: w.groupIdx.length, count: w.groupIdx.reduce((s, gi) => s + groups[gi].txs.length, 0), pendingNonce: want });
    if (pb.length) {
      problems.push(`${w.file}: ${pb.join('; ')}`);
      const local = w.page.first_failed_group; const gl = Number.isInteger(local) ? w.groupIdx[local] : null;
      if (gl !== null && (firstFailed === null || gl < firstFailed)) firstFailed = gl;
      if (gl === null && firstFailed === null) firstFailed = w.groupIdx[0] < nMint ? 0 : w.groupIdx.find((gi) => gi >= nMint);
    }
  }
  // the realised sale proceeds of every complex-buy (--check only, a report: the live rebuild uses the realised proceeds):
  // each clean window re-run as written, its own calls in place, with at most G.PROBE_CALLS of its sale calls flagged
  // "return" per request (the chain helper's cap), as many requests as that takes; every one must run clean
  const sales = []; const saleProblems = [];
  if (R.check && problems.length === 0) {
    sim.windows.forEach((w, wi) => { w.sales = []; let k = 0; w.groupIdx.forEach((gi) => groups[gi].txs.forEach((t) => { if (groups[gi].kind === 'complex-buy' && t.label.startsWith('sell x')) w.sales.push({ k, gi, t }); k++; })); w.wi = wi; });
    for (const w of sim.windows) {
      for (let c = 0; c < w.sales.length && !saleProblems.length; c += G.PROBE_CALLS) {
        const chunk = w.sales.slice(c, c + G.PROBE_CALLS); const flag = new Set(chunk.map((x) => x.k));
        const sg = G.simGroups(w.groupIdx.map((gi) => groups[gi])); let k = 0;
        sg.forEach((g) => g.calls.forEach((cl) => { if (flag.has(k)) cl.return = true; k++; }));
        const name = `exec-sim-${tag}-sales-w${w.wi + 1}-${c / G.PROBE_CALLS + 1}.json`;
        R.ctx.writeRun(name, JSON.stringify(sg));
        const page = await R.env.H(['simulate', R.ctx.rel(name)]);
        const rets = Array.isArray(page.returns) ? page.returns : [];
        if (!(page.all_success === true && page.clamped_count === 0 && !page.overrides_active && rets.length === chunk.length && rets.every((x) => flag.has(x.index)))) { saleProblems.push(`${R.ctx.rel(name)}: the sale-proceeds re-run did not run clean (all_success ${page.all_success}, returns ${rets.length} of ${chunk.length})`); break; }
        const ret = new Map(rets.map((x) => [x.index, x.return_data]));
        for (const x of chunk) sales.push({ id: groups[x.gi].id, realised: BigInt(ret.get(x.k)), planned: BigInt(x.t.swap.quoted_amountOut) });
      }
    }
  }
  return { sim, clean: problems.length === 0, problems, firstFailed: firstFailed === null ? null : fromGi + firstFailed, sales, saleProblems, groups, nTx: groups.reduce((s, g) => s + g.txs.length, 0) };
}

// ---------------------------------------------------------------------------------------------------------------
// one transaction's fresh checks (G section 3 + section 8 step 3): boundary, route, drift note, spend, floors
// ---------------------------------------------------------------------------------------------------------------
function decode(R, data) { const p = R.IF.parseTransaction({ data }); return { name: p.name, args: p.args }; }
function spendOf(R, g, d) {
  if (d.name === 'splitPosition') { const mkt = lc(d.args[1]); const x = mintX(g); const tok = x === 'parent' ? 'sUSDS' : x ? 'bundle' + x : 'repo'; if (x === 'parent' && mkt !== A.PARENT) throw stop('plan-shape', 'a parent split on another market'); return { tok, amt: BigInt(d.args[2]) }; }
  if (d.name === 'exactInputSingle') { const ti = lc(d.args[0].tokenIn); const m = g.market_refs; const tok = ti === lc(m.repo_token) ? 'repo' : ti === lc(m.up) ? 'up' : ti === lc(m.down) ? 'down' : null; if (!tok) throw stop('plan-shape', 'swap tokenIn is none of the market tokens'); return { tok, amt: BigInt(d.args[0].amountIn) }; }
  return null;
}
async function preflight(R, g, T, cg, { firstOfGroup }) {
  const d = decode(R, T.data); const notes = [];
  if (d.name === 'approve' && BigInt(d.args[1]) === 2n ** 256n - 1n) throw stop('plan-shape', 'an approve of type(uint256).max in the plan');
  if ((d.name === 'exactInputSingle' || d.name === 'exactOutputSingle') && lc(d.args[0].recipient) !== R.holder) throw stop('plan-shape', 'a swap recipient that is not the holder');
  const rs = await readGroupState(R, g);
  if (!rs.bnd.clear) throw stop('stale-boundary', `${g.id}: ${rs.bnd.why.join('; ')} (G section 3: the plan is stale)`);
  // G section 1: a merge-arb re-reads its child Invalid at send time; below its q the plan is stale (never resized)
  if (g.kind === 'merge-arb' && !R.check) {
    const qm = BigInt(decode(R, g.txs[g.txs.length - 1].data).args[2]);
    if (rs.bal.inv < qm) throw stop('stale-balance', `${g.id} idx ${T.idx}: child Invalid balance ${weiStr(rs.bal.inv)} < q ${weiStr(qm)} (G section 1: the plan is stale)`);
    if (d.name === 'mergePositions' && (rs.bal.up < qm || rs.bal.down < qm)) throw stop('stale-balance', `${g.id} idx ${T.idx}: UP ${weiStr(rs.bal.up)} or DOWN ${weiStr(rs.bal.down)} below q ${weiStr(qm)}`);
  }
  const sp = spendOf(R, g, d);
  if (sp && !R.check) { const have = rs.bal[sp.tok]; if (have === undefined) throw stop('plan-shape', 'no tracked balance for ' + sp.tok); if (have < sp.amt) throw stop('stale-balance', `${g.id} idx ${T.idx}: ${sp.tok} balance ${weiStr(have)} < amount ${weiStr(sp.amt)} (never resized: the plan is stale)`); }
  if (rs.slot && firstOfGroup && (g.kind === 'simple-buy' || g.kind === 'complex-buy')) {
    if (g.kind === 'complex-buy' && !(rs.slot.sum > 1)) throw stop('stale-route', `${g.id}: fresh sum ${rs.slot.sum} is not > 1, the plan routed complex-buy`);
    if (g.kind === 'simple-buy' && !(rs.slot.sum <= 1)) throw stop('stale-route', `${g.id}: fresh sum ${rs.slot.sum} is > 1, the plan routed simple-buy`);
  }
  if (rs.slot && g.pre_send_checks && firstOfGroup && !(cg.touched && cg.touched.has(lc(g.address)))) {
    const sb = g.pre_send_checks.spot_at_build; const dr = Math.max(Math.abs(rs.slot.UP / sb.UP - 1), Math.abs(rs.slot.DOWN / sb.DOWN - 1));
    if (dr > 0) notes.push(`slot0 drift vs build ${dr.toExponential(2)} (reported, never stale by itself)`);
  }
  let q = null;
  if (d.name === 'exactInputSingle') {
    const s = d.args[0]; q = await quote(R, 'in', s.tokenIn, s.tokenOut, Number(s.fee), s.amountIn);
    if (!q.ok) throw stop('stale-floor', `${g.id} idx ${T.idx}: the fresh quote is unusable (${q.reverted ? 'reverted ' + q.why : 'ticks ' + q.ticks})`);
    if (q.amt < BigInt(s.amountOutMinimum)) throw stop('stale-floor', `${g.id} idx ${T.idx}: fresh quote ${q.amt} < amountOutMinimum ${s.amountOutMinimum}`);
    q.kind = 'in';
  } else if (d.name === 'exactOutputSingle') {
    const s = d.args[0]; q = await quote(R, 'out', s.tokenIn, s.tokenOut, Number(s.fee), s.amountOut);
    if (!q.ok) throw stop('stale-floor', `${g.id} idx ${T.idx}: the fresh exact-output quote is unusable (${q.reverted ? 'reverted ' + q.why : 'ticks ' + q.ticks})`);
    if (q.amt > BigInt(s.amountInMaximum)) throw stop('stale-floor', `${g.id} idx ${T.idx}: fresh amountIn ${q.amt} > amountInMaximum ${s.amountInMaximum}`);
    if (!R.check && rs.bal.repo < q.amt) throw stop('stale-balance', `${g.id} idx ${T.idx}: repo balance ${rs.bal.repo} < fresh amountIn ${q.amt}`);
    q.kind = 'out';
  }
  return { d, rs, q, notes };
}

// ---------------------------------------------------------------------------------------------------------------
// the complex-buy rebuild after the sale (G section 3, sequential mode): P = the realised proceeds, a fresh quote at P;
// the rebuilt pair's own simulation is "the plan" for its gas_limit, its peak and its gas_used (G section 8)
// ---------------------------------------------------------------------------------------------------------------
async function encodeCall(R, sig, args, tag) {
  const argv = []; let k = 0;
  for (const a of args) { if (Array.isArray(a)) { const f = `exec-tmp/arg-${process.pid}-${tag}-${k++}.json`; R.ctx.writeRun(f, JSON.stringify(a)); argv.push(`@${R.ctx.rel(f)}`); } else argv.push(String(a)); }
  return R.env.H(['encode', sig, ...argv]);
}
async function dataHash(R, name, data) { R.ctx.writeRun(name, data + '\n'); return (await R.env.H(['keccak256', R.ctx.rel(name)])).keccak256; }
async function rebuildPair(R, g, txs, i, P) {
  const sale = txs[i - 1]; const buy = txs[i + 1]; const ap = txs[i];
  const s = buy.swap; if (!s || s.kind !== 'exactInputSingle') throw stop('plan-shape', 'rebuild: the transaction after the approve is not the exactInputSingle buy');
  if (P <= 0n) throw stop('stale-floor', `${g.id}: the sale realised no proceeds`);
  const q = await quote(R, 'in', s.tokenIn, s.tokenOut, s.fee, P);
  if (!q.ok) throw stop('stale-floor', `${g.id}: the fresh buy quote at P is unusable`);
  const min = q.amt * 9950n / 10000n;
  const ea = await encodeCall(R, 'approve(address,uint256)', [A.SWAP, P.toString()], 'a');
  const es = await encodeCall(R, 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))', [[s.tokenIn, s.tokenOut, s.fee, R.holder, P.toString(), min.toString(), 0]], 's');
  const ha = await dataHash(R, `exec-data/r-data-${X.pad(ap.idx)}.hex`, ea.calldata); const hs = await dataHash(R, `exec-data/r-data-${X.pad(buy.idx)}.hex`, es.calldata);
  if (lc(ha) !== lc(ea.keccak256) || lc(hs) !== lc(es.keccak256)) throw stop('hash-mismatch', `${g.id}: a rebuilt calldata file hashes differently from encode's keccak256 (a mis-copied byte)`);
  R.ctx.writeRun(`exec-tmp/rebuild-${ap.idx}.json`, JSON.stringify([{ calls: [{ to: ap.to, data: ea.calldata, value: '0' }, { to: A.SWAP, data: es.calldata, value: '0' }] }]));
  const sim = await R.env.H(['simulate', R.ctx.rel(`exec-tmp/rebuild-${ap.idx}.json`)]);
  if (!(sim.all_success === true && sim.clamped_count === 0 && sim.over_cap_count === 0 && !sim.overrides_active)) throw stop('stale-simulation', `${g.id}: the rebuilt pair does not simulate clean: ${clip(JSON.stringify(sim.failures || sim), 400)}`);
  const planEqual = lc(ea.calldata) === lc(ap.data) && lc(es.calldata) === lc(buy.data);
  const info = { P: P.toString(), planP: sale.swap.quoted_amountOut, quoteAtP: q.amt.toString(), planQuoteAtP: buy.swap.quoted_amountOut, min: min.toString(), calldata_equals_plan: planEqual };
  const mk = (t, data, kh, row) => {
    const peak = row[4] === null || row[4] === undefined ? null : Number(row[4]);
    return { ...t, data, calldata_keccak256: lc(kh), gas_used: Number(row[3]), max_used_gas: peak, gas_limit: String(row[5]), rebuilt: true, signer_input_file: R.ctx.rel(`exec-data/r-tx-${X.pad(t.idx)}.json`), swap: t.swap ? { ...t.swap, amountIn: P.toString(), amountOutMinimum: min.toString(), quoted_amountOut: q.amt.toString() } : t.swap };
  };
  const na = mk(ap, ea.calldata, ea.keccak256, sim.calls[0]); const nb = mk(buy, es.calldata, es.keccak256, sim.calls[1]);
  for (const t of [na, nb]) R.ctx.writeRun(`exec-data/r-tx-${X.pad(t.idx)}.json`, JSON.stringify({ calls: [{ to: t.to, data: t.data, value: '0' }], gasLimit: t.gas_limit }));
  txs[i] = na; txs[i + 1] = nb;
  return { info, q };
}

// ---------------------------------------------------------------------------------------------------------------
// one transaction: fresh checks, the common pre-send path, then (live only) the broadcast
// ---------------------------------------------------------------------------------------------------------------
async function sendTx(R, g, gi, T, i, cg) {
  const pf = await preflight(R, g, T, cg, { firstOfGroup: i === 0 });
  if (i === 0) cg.gpre = pf.rs.bal;
  const n = T.nonce_expected;
  const ps = await X.presend(R.env, R.book, T, n);
  if (R.check) return { pf, ps };
  const res = await X.broadcast(R.env, R.book, T, n, ps.hash, { source: 'entry', group: g.id });
  const post = await readBalances(R, g);
  const gs = R.STATE.groups[g.id]; gs.txs = gs.txs || []; gs.txs.push({ idx: T.idx, nonce: n, hash: res.hash, block: res.receipt.block_number }); saveState(R);
  if (pf.notes.length) R.ctx.log(`  notes: ${pf.notes.join('; ')}`);
  return { pf, ps, post, hash: res.hash, receipt: res.receipt };
}
const price = (spent, filled) => (filled > 0n ? num(spent) / num(filled) : 0);
function rowFor(R, g, T, res, cg) {
  const d = decode(R, T.data); const pre = res.pf.rs.bal; const post = res.post.bal;
  if (g.kind === 'mint' && d.name === 'splitPosition') {
    const x = mintX(g); const tok = x === 'parent' ? 'sUSDS' : 'bundle' + x; const spent = pre[tok] - post[tok]; const want = x === 'parent' ? R.M_WEI : BigInt(R.mX[x] || 0);
    const base = rowsOfGroup(R, g)[0]; return { ...base, filled: num(spent), fill_price: 1.0, slippage_vs_quote: 0.0, tx_hash: res.hash, status: spent === want ? 'filled' : 'partial', error: null };
  }
  const base = (side) => ({ market: g.market, address: lc(g.address), side });
  const stakeOf = (side) => g.allocation_rows.find((r) => r.side === side).stake;
  if (g.kind === 'simple-buy' && d.name === 'exactInputSingle') {
    const side = g.allocation_rows[0].side; const own = side === 'UP' ? 'up' : 'down'; const filled = post[own] - pre[own]; const spent = pre.repo - post.repo; const fp = price(spent, filled); const qp = res.pf.q ? num(BigInt(d.args[0].amountIn)) / num(res.pf.q.amt) : fp;
    return { ...base(side), route: 'simple-buy', requested: stakeOf(side), filled: num(filled), fill_price: fp, slippage_vs_quote: fp - qp, tx_hash: res.hash, status: filled > 0n ? 'filled' : 'partial', error: null };
  }
  if (g.kind === 'dual-buy' && d.name === 'exactOutputSingle') {
    const side = lc(d.args[0].tokenOut) === lc(g.market_refs.up) ? 'UP' : 'DOWN'; const own = side === 'UP' ? 'up' : 'down'; const filled = post[own] - pre[own]; const spent = pre.repo - post.repo;
    const fp = price(spent, filled); const qp = num(res.pf.q.amt) / num(BigInt(d.args[0].amountOut));
    return { ...base(side), route: 'dual-buy', requested: stakeOf(side), filled: num(filled), fill_price: fp, slippage_vs_quote: fp - qp, tx_hash: res.hash, status: filled === BigInt(d.args[0].amountOut) ? 'filled' : 'partial', error: null };
  }
  if (g.kind === 'set-sell' && T.label.startsWith('sell q DOWN')) {
    const q = BigInt(d.args[0].amountIn); const proceeds = post.repo - cg.gpre.repo + q; const fp = num(proceeds) / num(q); const quoted = cg.setQuoted ? num(cg.setQuoted) / num(q) : fp;
    return { ...base('set'), route: 'set-sell', requested: stakeOf('set'), filled: num(q), fill_price: fp, slippage_vs_quote: fp - quoted, tx_hash: res.hash, status: proceeds >= q ? 'filled' : 'partial', error: proceeds >= q ? null : 'proceeds below q (no-loss floor breached)' };
  }
  if (g.kind === 'merge-arb' && d.name === 'mergePositions') {
    // G Output: the buy-and-merge row; filled = q pairs, fill_price = the realised cost per pair (repo spent - q returned)
    const q = BigInt(d.args[2]); const net = post.repo - cg.gpre.repo; const cost = q - net; const fp = num(cost) / num(q);
    const quoted = cg.fresh && cg.fresh.in[lc(g.market_refs.repo_token)] ? num(cg.fresh.in[lc(g.market_refs.repo_token)]) / num(q) : fp;
    return { ...base('set'), route: 'buy-and-merge', requested: stakeOf('set'), filled: num(q), fill_price: fp, slippage_vs_quote: fp - quoted, tx_hash: res.hash, status: cost < q ? 'filled' : 'partial', error: cost < q ? null : 'cost at or above q (no-loss bound breached)' };
  }
  if (g.kind === 'complex-buy' && T.label.startsWith('buy ')) {
    const side = g.allocation_rows[0].side; const own = side === 'UP' ? 'up' : 'down'; const x = BigInt(cg.cx.x); const filled = post[own] - cg.gpre[own]; const netOut = cg.gpre.repo - post.repo; const fp = price(netOut, filled); const qp = num(x) / num(x + cg.cx.quotedBought);
    return { ...base(side), route: 'complex-buy', requested: stakeOf(side), filled: num(filled), fill_price: fp, slippage_vs_quote: fp - qp, tx_hash: res.hash, status: filled > 0n ? 'filled' : 'partial', error: null };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// one group: the time budget, affordability, the transactions, the effects check
// ---------------------------------------------------------------------------------------------------------------
// G section 8 (The head moves): a balance delta a pool decides (a swap's output, or an exact-output swap's input) moves
// with any third-party trade between G's build and the send, while each call's own floor (amountOutMinimum,
// amountInMaximum) and the fresh pre-send quote guard the send. Such a delta is reported ("pool moved since build"),
// never a stop; it is only asserted against what the chain already guarantees (output at least the calldata's
// amountOutMinimum, input at most its amountInMaximum). Every delta no pool decides stays exact: each mint delta, a
// split's amount, an exact-output count, a child Invalid kept or merged, a leg that must end at 0.
function poolDecided(g, cg) {
  const m = g.market_refs; if (!m) return {};
  const own = g.allocation_rows && g.allocation_rows[0] && g.allocation_rows[0].side === 'DOWN' ? 'down' : 'up';
  const tk = { repo: lc(m.repo_token), up: lc(m.up), down: lc(m.down) };
  const b = cg.bounds; const minOut = (t) => b.minOut[t] || 0n; const maxIn = (t) => b.maxIn[t] || 0n;
  const fOut = (t) => cg.fresh.out[t] || 0n; const fIn = (t) => cg.fresh.in[t] || 0n;
  if (g.kind === 'simple-buy') return { [own]: { floor: minOut(tk[own]), fresh: fOut(tk[own]) } };
  if (g.kind === 'complex-buy') return { [own]: { floor: b.split + minOut(tk[own]), fresh: b.split + fOut(tk[own]) } };
  if (g.kind === 'dual-buy') return { repo: { floor: -maxIn(tk.repo), fresh: -fIn(tk.repo) } };
  if (g.kind === 'set-sell') return { repo: { floor: -b.split + minOut(tk.repo), fresh: -b.split + fOut(tk.repo) } };
  if (g.kind === 'merge-arb') return { repo: { floor: b.merge - maxIn(tk.repo), fresh: b.merge - fIn(tk.repo) } };
  return {};
}
async function runGroup(R, gi, cg) {
  const g = R.GROUPS[gi]; cg.gi = gi; cg.cx = null; cg.setQuoted = null; cg.sale = null; cg.gpre = null;
  cg.bounds = { minOut: {}, maxIn: {}, split: 0n, merge: 0n }; cg.fresh = { out: {}, in: {} };
  const fit = X.groupFits(R.env, g.txs.length, R.deadlineMs);
  if (!fit.ok) { const why = `turn/time budget exhausted: group ${g.id} (${g.txs.length} transactions, about ${Math.round(fit.needMs / 1000)} s) does not fit the ${Math.max(0, Math.round(fit.leftMs / 1000))} s left before the registered time limit less the reserve (G section 8, Room to finish)`; const skipped = skipRowsFrom(R, gi, why); return { skipped: { kind: 'time-budget', why, groups: skipped } }; }
  const af = await X.affordability(R.env, g.txs);
  R.ctx.log(`GROUP ${gi} ${g.id} (${g.txs.length} tx): affordability ${af.ok ? 'ok' : 'NOT MET'}: ${af.text}`);
  if (!af.ok) { const why = `affordability: ${af.text}; the group is not started (G section 8, Affordability)`; const skipped = skipRowsFrom(R, gi, why); return { skipped: { kind: 'affordability', why, groups: skipped, eth: af.eth.toString(), need: af.need.toString() } }; }
  const t0 = Date.now();
  R.STATE.groups[g.id] = { status: 'in-progress', started_at: lib.nowIso(), txs: [] }; saveState(R); R.started = true;
  if (!R.planSkipsWritten) { writePlanSkips(R); R.planSkipsWritten = true; }
  const txs = g.txs.map((t) => ({ ...t }));
  if (g.kind === 'complex-buy') cg.cx = { x: BigInt(decode(R, txs[1].data).args[2]) };
  cg.txs = txs;
  for (let i = 0; i < txs.length; i++) {
    if (txs[i].rebuild_at_send && !txs[i].rebuilt && i > 0 && txs[i - 1].label.startsWith('sell x')) {
      const P = cg.sale.post - cg.sale.pre; const rb = await rebuildPair(R, g, txs, i, P);
      cg.cx.quotedBought = rb.q.amt; cg.cx.rb = rb.info;
      R.ctx.log(`  rebuilt the last two transactions with the realised proceeds P ${P} (plan P ${rb.info.planP}); fresh quote at P ${rb.info.quoteAtP}; calldata equals plan: ${rb.info.calldata_equals_plan}`);
    }
    const res = await sendTx(R, g, gi, txs[i], i, cg);
    { // what the calldata guarantees and what the fresh pre-send quote said, per token (poolDecided)
      const d = res.pf.d; const a = d.args[0]; const add = (o, t, v) => { o[lc(t)] = (o[lc(t)] || 0n) + v; };
      if (d.name === 'exactInputSingle') { add(cg.bounds.minOut, a.tokenOut, BigInt(a.amountOutMinimum)); if (res.pf.q) add(cg.fresh.out, a.tokenOut, res.pf.q.amt); }
      if (d.name === 'exactOutputSingle') { add(cg.bounds.maxIn, a.tokenIn, BigInt(a.amountInMaximum)); if (res.pf.q) add(cg.fresh.in, a.tokenIn, res.pf.q.amt); }
      if (d.name === 'splitPosition') cg.bounds.split += BigInt(d.args[2]);
      if (d.name === 'mergePositions') cg.bounds.merge += BigInt(d.args[2]);
    }
    if (g.kind === 'complex-buy' && txs[i].label.startsWith('sell x')) cg.sale = { pre: res.pf.rs.bal.repo, post: res.post.bal.repo };
    if (g.kind === 'set-sell' && txs[i].label.startsWith('sell q')) cg.setQuoted = (cg.setQuoted || 0n) + res.pf.q.amt;
    const row = rowFor(R, g, txs[i], res, cg); if (row) addRow(R, row);
    cg.lastPost = res.post;
  }
  X.clockAdd(R.env, Date.now() - t0, txs.length);
  // the group's balance deltas against its expected effects (the build's quotes, g-verify; a rebuilt complex-buy uses
  // the rebuilt quote): exact on every delta no pool decides, reported on the ones a pool decides (poolDecided)
  const exp = expectedDeltas(R, g); const post = cg.lastPost.bal; const diffs = []; const breach = [];
  if (g.kind === 'complex-buy' && cg.cx && cg.cx.quotedBought !== undefined) { const side = g.allocation_rows[0].side; exp[side === 'UP' ? 'up' : 'down'] = cg.cx.x + cg.cx.quotedBought; }
  const pk = poolDecided(g, cg);
  for (const [k, v] of Object.entries(exp)) {
    const got = post[k] - cg.gpre[k]; const p = pk[k];
    if (p) {
      if (got !== v) diffs.push({ token: k, kind: 'pool moved since build', expected: v.toString(), got: got.toString(), diff: (got - v).toString(), fresh_quote: p.fresh.toString(), diff_vs_fresh_quote: (got - p.fresh).toString() });
      if (got < p.floor) breach.push({ token: k, got: got.toString(), calldata_bound: p.floor.toString() });
    } else if (got !== v) diffs.push({ token: k, kind: 'exact', expected: v.toString(), got: got.toString(), diff: (got - v).toString() });
  }
  const unexpected = diffs.filter((d) => { if (d.kind !== 'exact') return false; const e = BigInt(d.expected); const df = BigInt(d.diff); return (df < 0n ? -df : df) * 1000000000n > (e === 0n ? 1n : (e < 0n ? -e : e)); });
  const moved = diffs.filter((d) => d.kind !== 'exact');
  R.ctx.log(`  group effects vs expected: ${diffs.length ? 'differ on ' + diffs.length + (moved.length ? ` (${moved.length} decided by a pool that moved since the build: reported, never a stop)` : '') : 'exact (' + Object.keys(exp).length + ' balances)'}`);
  const gs = R.STATE.groups[g.id];
  if (unexpected.length || breach.length) { gs.status = 'stopped'; gs.reason = 'effects-mismatch'; saveState(R); throw stop('effects-mismatch', `${g.id}: ${unexpected.length ? 'balance deltas no pool decides differ from the simulated effects beyond rounding: ' + clip(JSON.stringify(unexpected.slice(0, 4)), 500) : ''}${breach.length ? ' a swap delta is past its own calldata bound: ' + clip(JSON.stringify(breach), 300) : ''}`, { group_complete: true }); }
  gs.status = 'done'; gs.ended_at = lib.nowIso(); gs.effects_diffs = diffs; saveState(R);
  cg.touched.add(lc(g.address || ''));
  if (g.id === 'mint-parent') { const F = R.book.fills(); F.totals.spent = num(R.M_WEI); F.totals.spent_unit = 'sUSDS'; R.book.saveFills(F); }
  return { done: true };
}

// ---------------------------------------------------------------------------------------------------------------
// start-up checks shared by both modes (no `signer info`: the planner never runs it)
// ---------------------------------------------------------------------------------------------------------------
async function startup(R) {
  const cid = await R.env.H(['chain-id']); if (cid.chain_id !== TB.CHAIN_ID || !cid.ok) throw stop('identity', `chain id ${cid.chain_id}`);
  const calls = []; const keys = [];
  for (const x of ['parent', ...XS]) { const addr = x === 'parent' ? A.PARENT : MIDDLE[x]; calls.push({ to: addr, signature: 'conditionId()(bytes32)' }, { to: addr, signature: 'questionsIds()(bytes32[])' }); keys.push(x); }
  const kids = R.TRADED.filter((g) => !R.STATE.groups[g.id] || R.STATE.groups[g.id].status !== 'done');
  kids.forEach((g) => calls.push({ to: g.address, signature: 'conditionId()(bytes32)' }, { to: g.address, signature: 'questionsIds()(bytes32[])' }));
  const o = await R.env.mcChunked(calls, 400);
  keys.forEach((x, k) => { const c = o.results[2 * k][0]; if (lc(c) !== lc(CONDS[x])) throw stop('identity', `conditionId of ${x} differs from the skill's constant`); R.BND[x] = { label: x, cond: c, qids: o.results[2 * k + 1][0] }; });
  const off = 2 * keys.length;
  kids.forEach((g, k) => { const b = off + 2 * k; if (lc(o.results[b][0]) !== lc(g.pre_send_checks.condition_id) || lc(o.results[b + 1][0][0]) !== lc(g.pre_send_checks.question_id)) throw stop('identity', `conditionId / questionsIds()[0] of ${g.market} differ from the plan`); });
  R.ctx.log(`identity ok: chain 10; parent and middles' conditionId equal the skill's constants; ${kids.length} children's conditionId and questionsIds()[0] equal the plan`);
}
// which group is next, strictly from the chain and the files
async function nextGroup(R) {
  let gi = 0; while (gi < R.GROUPS.length && R.STATE.groups[R.GROUPS[gi].id] && R.STATE.groups[R.GROUPS[gi].id].status === 'done') gi++;
  for (let k = gi; k < R.GROUPS.length; k++) { const st = R.STATE.groups[R.GROUPS[k].id]; if (st && ['in-progress', 'stopped', 'skipped'].includes(st.status)) throw stop('resume-refused', `group ${R.GROUPS[k].id} is ${st.status}: never resumed on the original plan (G section 8 step 4)`); }
  const nn = await R.env.H(['nonce', R.holder]);
  if (gi >= R.GROUPS.length) return { gi, nn, done: true };
  const want = R.GROUPS[gi].txs[0].nonce_expected;
  if (nn.latest !== nn.pending) throw stop('pending-transaction', `a transaction of the holder is pending (latest ${nn.latest}, pending ${nn.pending}); settle it first`, { nonce: nn });
  if (nn.latest !== want) throw stop('nonce-moved', `the holder nonce ${nn.latest} is not the first unsent group's first nonce ${want} (${R.GROUPS[gi].id}): a send the plan did not expect`, { nonce: nn });
  if (rowsOfGroup(R, R.GROUPS[gi]).some((r) => alreadyRowed(R, r))) throw stop('resume-refused', `fills.json already holds a row for ${R.GROUPS[gi].id}`);
  for (let k = 0; k < gi; k++) for (const t of R.STATE.groups[R.GROUPS[k].id].txs || []) { const r = await R.env.H(['receipt', t.hash]); if (!(r.found && r.success)) throw stop('resume-refused', `recorded transaction ${t.hash} of ${R.GROUPS[k].id} has no successful receipt`); }
  if (R.book.exists('inflight.json')) throw stop('inflight-unsettled', `${R.book.rel('inflight.json')} is present: settle it before anything is sent`);
  return { gi, nn, done: false };
}

// ---------------------------------------------------------------------------------------------------------------
// retained_legs (this run's own amounts) and the cross-run "consumed" rows (G Output)
// ---------------------------------------------------------------------------------------------------------------
function armRunIds(ctx) {
  const out = [];
  for (const d of ctx.listRunIds()) {
    try {
      if (!ctx.existsRel(`run/${d}/base-forecast.json`) || !ctx.existsRel(`run/${d}/allocation.json`)) continue;
      const bf = JSON.parse(ctx.readRel(`run/${d}/base-forecast.json`).toString('utf8')); const al = JSON.parse(ctx.readRel(`run/${d}/allocation.json`).toString('utf8'));
      if (bf.method === 'csv-face-value' && al.objective === 'max-ev') out.push(d);
    } catch (e) { /* not this arm's, or unreadable: never touched */ }
  }
  return out;
}
async function finalize(R, tag) {
  const out = { retained: 0, consumed_rows: 0, unattributed: [], notes: [] };
  let a;
  try { a = await readAll(R); } catch (e) { out.notes.push('the after-run balance read failed: ' + clip(e.message, 200)); return out; }
  const before = R.STATE.balances_before ? Object.fromEntries(Object.entries(R.STATE.balances_before).map(([k, v]) => [k, BigInt(v)])) : null;
  if (!before) { out.notes.push('no before-balances were recorded (no live invocation started), so no retained_legs'); return out; }
  const done = (id) => R.STATE.groups[id] && R.STATE.groups[id].status === 'done';
  const M = done('mint-parent') ? R.M_WEI : 0n; const mX = {}; for (const x of XS) mX[x] = done('mint-middle-' + x) ? BigInt(R.mX[x] || 0) : 0n;
  const F = R.book.fills(); const runs = F.runs;
  const rowSrc = (pred) => runs.filter((r) => ['filled', 'partial'].includes(r.status) && pred(r)).map((r) => `${r.market} ${r.side} ${r.route}`);
  const legs = []; const take = [];
  const t = allTokens(R);
  const bundleOfRepo = new Map(); TB.T.rows.forEach((r) => bundleOfRepo.set(lc(r.repo_token), r.bundle));
  const repoRow = new Map(TB.T.rows.map((r) => [lc(r.repo_token), r]));
  for (const name of a.names) {
    let mint; let why; let srcs;
    if (name.startsWith('bundle')) { const x = name.slice(6); mint = M; why = `bundle token ${x} of an unsplit bundle (or its unsplit part); no sUSDS pool`; srcs = rowSrc((r) => r.market === 'PARENT-MINT'); }
    else if (name === 'parentInvalid') { mint = M; why = 'parent Invalid; bounds the parent merge'; srcs = rowSrc((r) => r.market === 'PARENT-MINT'); }
    else if (name.startsWith('midInv')) { const x = name.slice(6); mint = mX[x]; why = `middle-${x} Invalid; bounds the middle-${x} merge`; srcs = rowSrc((r) => r.side === 'mint' && lc(r.address) === MIDDLE[x]); }
    else if (name.startsWith('repo:')) { const tok = name.slice(5); const x = bundleOfRepo.get(lc(tok)); const rr = repoRow.get(lc(tok)); mint = mX[x] || 0n; why = 'unspent repo token (m_X less this run\'s net spend beyond what it held, plus set-sell proceeds and merge-arb returns); no sUSDS pool; middle merge or resolution'; srcs = [...rowSrc((r) => r.side === 'mint' && lc(r.address) === MIDDLE[x]), ...rowSrc((r) => rr && lc(r.address) === rr.address && (r.route === 'set-sell' || (r.route === 'buy-and-merge' && r.side === 'set')))]; }
    else if (name.startsWith('inv:')) { const mk = name.slice(4); mint = 0n; why = 'child Invalid minted by a complex-buy or set-sell split; no pool'; srcs = rowSrc((r) => r.market === mk && ['complex-buy', 'set-sell'].includes(r.route)); }
    else continue;
    const b0 = before[name] || 0n; const delta = a.bal[name] - b0;
    let c = mint - delta; if (c < 0n) c = 0n; if (c > b0) c = b0;
    const own = delta + c;
    if (own > 0n) legs.push({ token: t[name], amount: num(own), why: `${why}; sources: ${srcs.length ? srcs.join(', ') : 'none recorded'}` });
    if (c > 0n && (name.startsWith('repo:') || name.startsWith('bundle'))) take.push({ name, token: lc(t[name]), c });
  }
  F.retained_legs = legs; R.book.saveFills(F); out.retained = legs.length;
  // the cross-run consumed rows: oldest first, net of earlier such rows (this run's own included)
  if (take.length) {
    const sources = armRunIds(R.ctx).filter((d) => d !== R.ctx.runId && !(R.liveRuns || []).includes(d));
    const books = new Map(sources.map((d) => [d, new X.Book(R.ctx.cfg, d)]));
    const mine = `consumed by run ${R.ctx.runId}`;
    for (const tk of take) {
      let already = 0n;
      for (const [, bk] of books) for (const r of (bk.readJson('fills.json', { runs: [] }).runs || [])) if (r.side === 'consumed' && lc(r.market) === tk.token && r.error === mine) already += toWei(r.filled);
      let need = tk.c - already; if (need <= 0n) continue;
      const isBundle = tk.name.startsWith('bundle'); const rr = repoRow.get(tk.token);
      const route = isBundle ? 'split-parent' : ((R.GROUPS.find((g) => g.market_refs && lc(g.market_refs.repo_token) === tk.token && R.STATE.groups[g.id] && ['done', 'stopped', 'in-progress'].includes(R.STATE.groups[g.id].status)) || {}).recorded_route || 'split-parent');
      for (const [d, bk] of books) {
        if (need <= 0n) break;
        const Fs = bk.readJson('fills.json', null); if (!Fs || !Array.isArray(Fs.retained_legs)) continue;
        const kept = Fs.retained_legs.filter((l) => lc(l.token) === tk.token).reduce((s, l) => s + toWei(l.amount), 0n);
        const used = (Fs.runs || []).filter((r) => r.side === 'consumed' && lc(r.market) === tk.token).reduce((s, r) => s + toWei(r.filled), 0n);
        const avail = kept - used; if (avail <= 0n) continue;
        const amt = avail < need ? avail : need;
        Fs.runs.push({ market: tk.token, address: isBundle ? A.PARENT : MIDDLE[rr.bundle], side: 'consumed', route, requested: num(amt), filled: num(amt), fill_price: 0, slippage_vs_quote: 0, tx_hash: null, status: 'filled', error: mine });
        bk.saveFills(Fs); need -= amt; out.consumed_rows++;
        R.ctx.log(`consumed row: ${weiStr(amt)} of ${tk.token} from run ${d}`);
      }
      if (need > 0n) out.unattributed.push({ token: tk.token, amount: weiStr(need) });
    }
  }
  // the cross-run Invalid rows (G Output, Cross-run Invalid accounting): a merge-arb consumed child Invalid earlier runs
  // retained; one side "Invalid" buy-and-merge row per source run, oldest first, net of earlier such rows, the consuming
  // run-id in error (read by halfb.ownChild and H, which stop valuing the consumed Invalid)
  // a merge-arb its recovery completed in this run counts too (its merge is the recovery's last send)
  const recMerge = (id) => { const r = recoveryOf(R.book, id); if (!r || r.outcome !== 'completed') return null; for (const a of (r.attempts || []).slice().reverse()) for (const t of (a.txs || []).slice().reverse()) if (t.tx_hash && /mergePositions/.test(t.label)) return t.tx_hash; return null; };
  const maDone = R.GROUPS.filter((g) => g.kind === 'merge-arb' && (done(g.id) || recMerge(g.id)));
  if (maDone.length) {
    const mine = `consumed by run ${R.ctx.runId}`;
    const srcIds = armRunIds(R.ctx).filter((d) => d !== R.ctx.runId && !(R.liveRuns || []).includes(d)).sort();
    for (const g of maDone) {
      const inv = lc(g.market_refs.child_invalid); const child = lc(g.address); const q = BigInt(decode(R, g.txs[g.txs.length - 1].data).args[2]);
      const st = R.STATE.groups[g.id]; const hash = done(g.id) ? (st.txs && st.txs.length ? st.txs[st.txs.length - 1].hash : null) : recMerge(g.id);
      const invRows = (Fs) => (Fs.runs || []).filter((r) => r.side === 'Invalid' && r.route === 'buy-and-merge' && lc(r.address) === child);
      let already = 0n; const fsOf = new Map();
      for (const d of srcIds) { const bk = new X.Book(R.ctx.cfg, d); const Fs = bk.readJson('fills.json', null); if (!Fs) continue; fsOf.set(d, { bk, Fs }); for (const r of invRows(Fs)) if (r.error === mine) already += toWei(r.filled); }
      let need = q - already;
      for (const [d, { bk, Fs }] of fsOf) {
        if (need <= 0n) break;
        const kept = (Fs.retained_legs || []).filter((l) => lc(l.token) === inv).reduce((s, l) => s + toWei(l.amount), 0n);
        const used = invRows(Fs).reduce((s, r) => s + toWei(r.filled), 0n);
        const avail = kept - used; if (avail <= 0n) continue;
        const amt = avail < need ? avail : need;
        Fs.runs.push({ market: g.market, address: child, side: 'Invalid', route: 'buy-and-merge', requested: num(amt), filled: num(amt), fill_price: 0, slippage_vs_quote: 0, tx_hash: hash, status: 'filled', error: mine });
        bk.saveFills(Fs); need -= amt; out.consumed_rows++;
        R.ctx.log(`consumed Invalid row: ${weiStr(amt)} of ${inv} (${g.market}) from run ${d}`);
      }
      if (need > 0n) out.unattributed.push({ token: inv, amount: weiStr(need), what: 'child Invalid a merge-arb consumed that no earlier run of this arm retained' });
    }
  }
  // the after-run read also carries allowance(holder, SwapRouter02) of each repo token an exactOutputSingle leg approved
  const alw = {};
  try { const ac = R.TRADED.filter((g) => g.kind === 'dual-buy' || g.kind === 'merge-arb').map((g) => ({ to: g.market_refs.repo_token, signature: 'allowance(address,address)(uint256)', args: [R.holder, A.SWAP] })); if (ac.length) { const ao = await R.env.mcChunked(ac, 400); R.TRADED.filter((g) => g.kind === 'dual-buy' || g.kind === 'merge-arb').forEach((g, k) => { const v = BigInt(ao.results[k][0]); if (v > 0n) alw[g.market] = v.toString(); }); } } catch (e) { alw.read_error = clip(e.message, 200); }
  R.ctx.writeRunJson(`exec-balances-${tag}.json`, { block: a.block, eth: a.eth.toString(), bal: Object.fromEntries(Object.entries(a.bal).filter(([, v]) => v > 0n).map(([k, v]) => [k, v.toString()])), allowance_swaprouter02_nonzero: alw }, { indent: 1 });
  out.eth_after = a.eth; out.after_file = R.ctx.rel(`exec-balances-${tag}.json`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// a stop: settle the open nonce, rows (the group in progress keeps what landed), skipped groups, the final read
// ---------------------------------------------------------------------------------------------------------------
async function stopRun(R, e, cg) {
  const s = X.asStop(STEP, e);
  R.ctx.log(`STOP ${s.cause}: ${s.notes}`);
  const f = { ...s.fields };
  // an attempt still open (a write-ahead with no settled outcome, e.g. a transport failure after the broadcast)
  if (R.env.open) {
    try {
      const st = await X.settleNonce(R.env, R.book, R.env.open.n);
      f.settlement = { outcome: st.outcome, via: st.via, hash: st.hash || null };
      // a not-sent finding on a signer that cannot pin the nonce, with no foreign transaction at n, is no settlement:
      // inflight.json stays and the wake stays aborted (G section 8, Nonce pinning)
      const keepOpen = st.outcome === 'not-sent' && !R.env.pin && !st.foreign;
      if (keepOpen) { f.keep_aborted = true; f.pending_nonce = R.env.open.n; }
      if (st.outcome === 'landed' || (st.outcome === 'not-sent' && !keepOpen)) {
        R.book.settleInflight();
        if (st.outcome === 'landed' && st.receipt && st.receipt.success && cg && cg.gi !== undefined) {
          const g0 = R.GROUPS[cg.gi]; const gs = R.STATE.groups[g0.id];
          if (gs) {
            gs.txs = gs.txs || []; gs.txs.push({ nonce: R.env.open.n, hash: st.hash, block: st.receipt.block_number, recorded_at: 'settlement after a stop; its row from the signed calldata' });
            // its row now, from the signed calldata (exact, or the calldata's own bound), as the start-of-run repair would
            const T = g0.txs.find((t) => t.nonce_expected === R.env.open.n); const data = T ? signedData(R.ctx, R.ctx.runId, T) : null;
            const row = T && data ? rowFromCalldata(R.IF, R.plan, g0, T, data, st.hash, `recorded at the settlement after the stop of ${R.ctx.runId}`) : null;
            if (row && !R.book.fills().runs.some((x) => lc(x.tx_hash || '') === lc(st.hash))) R.book.addRows([row]);
          }
        }
      }
      if (st.outcome === 'pending') { f.keep_aborted = true; f.pending_nonce = R.env.open.n; f.pending_hash = R.env.open.tx_hash; }
    } catch (x) { f.keep_aborted = true; f.settlement = { outcome: 'unreadable', via: clip(x.message, 200) }; f.pending_nonce = R.env.open.n; f.pending_hash = R.env.open.tx_hash; }
    R.env.open = null;
  }
  if (e && e.landed && cg && cg.gi !== undefined) { const gs = R.STATE.groups[R.GROUPS[cg.gi].id]; if (gs) { gs.txs = gs.txs || []; if (!gs.txs.some((t) => t.hash === e.landed.hash)) gs.txs.push({ hash: e.landed.hash, block: e.landed.receipt.block_number, recorded_at: 'landed before the stop; its row was not written' }); } }
  const rec = { kind: s.cause, notes: s.notes, at: lib.nowIso(), exit: s.exit, group: cg && cg.gi !== undefined ? R.GROUPS[cg.gi].id : null, fields: f };
  R.STATE.stop = rec; saveState(R);
  const reason = clip(`${s.cause}: ${s.notes}`, 600);
  let halfDone = null; let skipped = []; let recovery = null;
  if (cg && cg.gi !== undefined) {
    const g = R.GROUPS[cg.gi]; const gs = R.STATE.groups[g.id];
    if (gs && (gs.status === 'in-progress' || gs.status === 'stopped')) {
      const landed = (gs.txs || []).length;
      const rows = rowsOfGroup(R, g).filter((r) => !alreadyRowed(R, r)).map((r) => ({ ...skippedRow(r, `half-done group (one transaction per signer call): ${landed} of ${g.txs.length} transactions landed; ${reason}`), status: landed ? 'partial' : 'skipped' }));
      R.book.addRows(rows);
      gs.status = landed ? 'stopped' : 'skipped'; gs.reason = reason; saveState(R);
      if (landed && !f.group_complete) {
        halfDone = { group: g.id, landed, of: g.txs.length, txs: gs.txs.map((t) => t.hash) };
        // the recovery rule in the same run (G section 8 step 4): inside the wrapper only, after a stop it covers, never
        // with a nonce left unsettled; a supervised batch's recovery has its own "yes"
        if (R.recoverInRun && RECOVERABLE.has(s.cause) && !f.keep_aborted) {
          const T = g.txs[landed] || null;
          recovery = await recoverGroup({ env: R.env, book: R.book, gid: g.id, trigger: s.cause, by: `exec of run ${R.ctx.runId}, the run that stopped`, failed: { cause: s.cause, label: T ? T.label : null, nonce: T ? T.nonce_expected : null, hash: f.landed_reverted || null } });
          R.ctx.log(`recovery of ${g.id}: ${recovery.outcome}${recovery.decision ? ' (' + recovery.decision + ')' : ''}: ${recovery.why}`);
          if (recovery.keep_aborted) { f.keep_aborted = true; if (recovery.pending_nonce !== null) f.pending_nonce = recovery.pending_nonce; }
          if (RECOVERY_SETTLED.has(recovery.outcome)) halfDone = null;
          else halfDone.recovery = `the recovery rule (G section 8 step 4) ${recovery.outcome === 'kept' ? 'kept the landed legs' : 'did not complete or unwind it'} in this run: ${recovery.why}; the next run's start-of-run repair applies it again (I-setup.md I.2 section 6 (c))`;
        } else halfDone.recovery = R.recoverInRun ? `no recovery in this run after a ${s.cause} stop (G section 8 step 4); the next run's start-of-run repair applies the recovery rule (I-setup.md I.2 section 6 (c))` : 'a supervised session presents G section 8 step 4\'s recovery batch for its own "yes"';
      }
      skipped = skipRowsFrom(R, cg.gi + 1, `not started: the run stopped at group ${g.id}: ${reason}`);
    } else skipped = skipRowsFrom(R, cg.gi, `not started: ${reason}`);
  }
  if (!R.planSkipsWritten) { writePlanSkips(R); R.planSkipsWritten = true; }
  const fin = await finalize(R, 'after-stop-inv' + R.STATE.invocations.length);
  return { s, f, halfDone, recovery, skipped, fin };
}

function summary(R, extra) {
  const sends = R.book.sends().filter((x) => x.source === 'entry');
  const cost = sends.reduce((a, x) => a + BigInt(x.cost_wei || '0'), 0n);
  const doneIds = R.GROUPS.filter((g) => R.STATE.groups[g.id] && R.STATE.groups[g.id].status === 'done').map((g) => g.id);
  return {
    mode: R.check ? 'check' : R.env.lock ? R.env.lock.mode : 'none',
    groups_total: R.GROUPS.length, groups_done: doneIds.length,
    transactions_total: R.GROUPS.reduce((s, g) => s + g.txs.length, 0), transactions_sent: sends.length, sent_this_invocation: R.env.sentThisInvocation,
    first_tx: sends[0] ? sends[0].tx_hash : null, last_tx: sends.length ? sends[sends.length - 1].tx_hash : null,
    gas_cost_eth_receipts: weiStr(cost),
    nonce_pinning: R.env.pin, signer_env_dropped: R.env.envDropped, signer_log_path: R.env.logPath,
    tx_hash_file: R.book.rel('exec-sends.json'),
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// --check: sends nothing
// ---------------------------------------------------------------------------------------------------------------
async function checkMode(R) {
  const t0 = Date.now(); const rep = {}; const bad = [];
  const { gi: gi0, nn, done } = await nextGroup(R);
  R.ctx.log(`next group ${gi0}${done ? ' (all done)' : ' ' + R.GROUPS[gi0].id}; nonce latest ${nn.latest} pending ${nn.pending}`);
  if (done) return { rep: { all_done: true }, bad };
  const rem = R.GROUPS.slice(gi0); const remTx = rem.flatMap((g) => g.txs);
  // 1. every remaining signer-input file: equal to the plan, hashed by the helper, the signer's policy-only check
  let n1 = 0;
  for (const t of remTx) {
    let why = null;
    try { await X.checkInputFile(R.env, R.book, t, t.nonce_expected); } catch (e) { why = e.notes || e.message; }
    const c = await X.signerRun(R.env, 'check', t.signer_input_file); if (!(c.exit === 0 && c.last && c.last.allowed === true)) why = (why ? why + '; ' : '') + 'signer check: ' + clip(c.stdout, 160);
    if (why) { n1++; bad.push({ idx: t.idx, w: why }); }
  }
  rep.data_files = { checked: remTx.length, bad: n1 };
  // 2. the boundary of every remaining group, one pass
  const nc = await boundaryPass(R, rem); nc.forEach((x) => bad.push({ group: x.id, w: x.why }));
  rep.boundary = { groups: rem.length, not_clear: nc.length };
  // 3. fresh quotes against the calldata bounds on pristine pools (a market traded after its own set-sell or merge-arb is
  // covered by 4)
  const afterSet = (g) => !['set-sell', 'merge-arb'].includes(g.kind) && R.GROUPS.some((x) => ['set-sell', 'merge-arb'].includes(x.kind) && lc(x.address) === lc(g.address) && x.index < g.index);
  let qn = 0; let qout = 0; let qdiff = 0;
  for (const g of rem) for (const t of g.txs) {
    if (!t.swap || afterSet(g) || t.rebuild_at_send) continue;
    const d = decode(R, t.data); const s = d.args[0]; qn++;
    if (d.name === 'exactInputSingle') { const q = await quote(R, 'in', s.tokenIn, s.tokenOut, Number(s.fee), s.amountIn); if (!(q.ok && q.amt >= BigInt(s.amountOutMinimum))) { qout++; bad.push({ idx: t.idx, w: 'quote below amountOutMinimum' }); } if (q.ok && t.swap.quoted_amountOut && q.amt !== BigInt(t.swap.quoted_amountOut)) qdiff++; }
    else { const q = await quote(R, 'out', s.tokenIn, s.tokenOut, Number(s.fee), s.amountOut); if (!(q.ok && q.amt <= BigInt(s.amountInMaximum))) { qout++; bad.push({ idx: t.idx, w: 'quote above amountInMaximum' }); } if (q.ok && t.swap.quoted_amountIn && q.amt !== BigInt(t.swap.quoted_amountIn)) qdiff++; }
  }
  rep.quotes = { checked: qn, outside_bound: qout, differ_from_plan_quote: qdiff };
  // 4. the remaining plan simulated (one request, or G's windows), the sale proceeds, the rows against the plan
  const sw = await simulateRemaining(R, gi0, 'check');
  rep.simulation = { clean: sw.clean, requests: sw.sim.windows.length, windowed: sw.sim.windowed, problems: sw.problems.slice(0, 3) };
  if (!sw.clean) bad.push({ w: 'the remaining plan does not simulate clean', problems: sw.problems.slice(0, 3) });
  rep.sale_proceeds = { checked: sw.sales.length, differ: sw.sales.filter((x) => x.realised !== x.planned).length, problems: sw.saleProblems.slice(0, 3) };
  if (sw.saleProblems.length) bad.push({ w: 'the sale-proceeds re-run of the remaining plan did not run clean', problems: sw.saleProblems.slice(0, 3) });
  let perBad = 0; remTx.forEach((t, k) => { const row = sw.sim.rows[k]; if (!row || row[2] !== '0x1' || Number(row[3]) !== Number(t.gas_used) || String(row[5]) !== String(t.gas_limit)) perBad++; });
  rep.sim_rows_vs_plan = { checked: remTx.length, differ: perBad, note: 'a difference in gasUsed or gas_limit is reported; the pre-send gas check judges each transaction at its send' };
  // 5. the complex-buy rebuild code on the plan's own P and quote
  let rbBad = 0; let rbN = 0;
  for (const g of rem.filter((x) => x.kind === 'complex-buy')) {
    rbN++;
    const sale = g.txs[3]; const buy = g.txs[5]; const P = BigInt(sale.swap.quoted_amountOut); const s = buy.swap; const min = BigInt(s.quoted_amountOut) * 9950n / 10000n;
    const ea = await encodeCall(R, 'approve(address,uint256)', [A.SWAP, P.toString()], 'ca'); const es = await encodeCall(R, 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))', [[s.tokenIn, s.tokenOut, s.fee, R.holder, P.toString(), min.toString(), 0]], 'cs');
    const hs = await dataHash(R, `exec-data/c-data-${X.pad(buy.idx)}.hex`, es.calldata);
    if (!(lc(ea.calldata) === lc(g.txs[4].data) && lc(es.calldata) === lc(buy.data) && lc(hs) === lc(es.keccak256))) { rbBad++; bad.push({ w: 'the rebuild differs from the plan on its own numbers', group: g.id }); }
  }
  rep.rebuild = { groups: rbN, differ: rbBad };
  // 6. affordability, projected group by group (the executor checks it fresh before each group)
  const gp = BigInt((await R.env.H(['fee-history'])).gas_price); let bal = BigInt((await R.env.H(['balance', R.holder])).wei); let stopsAt = null;
  for (let gi = gi0; gi < R.GROUPS.length; gi++) {
    const g = R.GROUPS[gi]; const need = X.RESERVE_WEI + g.txs.reduce((s, t) => s + BigInt(t.gas_limit) * 2n * gp, 0n);
    if (bal < need) { stopsAt = { group: g.id, eth: weiStr(bal), need: weiStr(need) }; break; }
    bal -= g.txs.reduce((s, t) => s + BigInt(t.gas_used) * gp + BigInt(t.l1_fee_wei_at_build || '0'), 0n);
  }
  rep.affordability = { gas_price: gp.toString(), first_group_not_affordable: stopsAt, projected_end_eth: stopsAt ? null : weiStr(bal) };
  if (stopsAt) bad.push({ w: `affordability: ${stopsAt.group} would be skipped (ETH ${stopsAt.eth} < ${stopsAt.need})` });
  // 7. the full pre-send path on the next transaction, without its send
  try { const g = R.GROUPS[gi0]; const t = g.txs[0]; const r = await sendTx(R, g, gi0, { ...t }, 0, { touched: new Set() }); rep.first_tx = { idx: t.idx, fresh_gas_used: r.ps.freshGas.toString(), plan_gas_used: t.gas_used, gas_limit: t.gas_limit, notes: r.pf.notes }; } catch (e) { bad.push({ w: '7 ' + (e.notes || e.message) }); rep.first_tx = { failed: clip(e.notes || e.message, 300) }; }
  // 8. settlement of the attempts already recorded by this run (each should read Landed)
  const ns = [...new Set(R.book.attempts().filter((a) => a.status !== 'not_broadcast').map((a) => a.nonce))]; const sres = [];
  for (const n of ns.slice(-20)) { const s = await X.settleNonce(R.env, R.book, n); sres.push({ n, outcome: s.outcome }); }
  rep.settlement = { checked: sres.length, not_landed: sres.filter((x) => x.outcome !== 'landed').length };
  rep.problems = bad.length; rep.seconds = Math.round((Date.now() - t0) / 1000);
  R.ctx.writeRunJson('exec-check.json', { at: lib.nowIso(), rep, bad }, { indent: 1 });
  return { rep, bad };
}

// ---------------------------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------------------------
async function run(ctx) {
  const check = !!ctx.opts.check; const maxGroups = ctx.opts.maxGroups || Infinity;
  if (!ctx.existsRun('g-plan.json')) throw stop('plan-missing', `${ctx.rel('g-plan.json')} does not exist: run G first`);
  const plan = ctx.readRunJson('g-plan.json');
  const holder = lc(ctx.holder());
  if (plan.run_id !== ctx.runId || lc(plan.holder) !== holder) throw stop('holder-mismatch', `g-plan.json names run ${clip(plan.run_id, 60)} and holder ${clip(plan.holder, 60)}; this run is ${ctx.runId} with holder ${holder}`);
  const signerSha = lib.sha256(require('fs').readFileSync(ctx.cfg.signerPath));
  if (signerSha !== plan.inputs.signer_sha256) throw stop('signer-changed', `the configured signer hashes to ${signerSha.slice(0, 16)}..., the plan was built for ${String(plan.inputs.signer_sha256).slice(0, 16)}...: rebuild G`);
  const setup = lib.readSetup(ctx.cfg);
  // signer mode (b) is refused in every mode, --check included, before any signer call, lock or write (exec-core)
  X.refuseSignerMode(STEP, setup);
  const env = X.makeEnv(ctx, { step: STEP, holder, setup });
  const E = ctx.ethers();
  const IF = new E.Interface(IF_SIGS);
  const cands = ctx.readRunJson('candidates.json').candidates;
  const repoOfBundle = { A: [], B: [], C: [] };
  for (const c of cands) { const x = XS.find((k) => MIDDLE[k] === lc(c.parent.address)); if (!x) throw stop('plan-shape', 'a candidate with an unknown middle'); repoOfBundle[x].push(lc(c.collateral_token)); }
  const GROUPS = plan.groups || [];
  const R = {
    ctx, env, plan, holder, check, IF, GROUPS, repoOfBundle, ALL_REPO: cands.map((c) => lc(c.collateral_token)), TRADED: GROUPS.filter((g) => g.market_refs),
    M_WEI: BigInt(plan.mint.M_wei || 0), mX: plan.mint.m_X_wei || {}, BND: {}, book: new X.Book(ctx.cfg, ctx.runId), planSkipsWritten: false, liveRuns: [],
  };
  // the state of this run-id's executor, keyed to the plan it sends
  let STATE = ctx.existsRun('exec-state.json') ? ctx.readRunJson('exec-state.json') : null;
  const anySent = R.book.sends().some((s) => s.source === 'entry') || R.book.attempts().some((a) => a.status !== 'not_broadcast');
  if (STATE && STATE.plan_built_at === undefined) STATE.plan_built_at = plan.built_at; // a state the live executor wrote
  if (STATE && STATE.plan_built_at !== plan.built_at) {
    if (anySent) throw stop('plan-changed', `exec-state.json belongs to the plan built ${STATE.plan_built_at}, g-plan.json was built ${plan.built_at}, and this run-id has broadcast: a plan is built only before the first broadcast (G section 1)`);
    STATE = { ...STATE, plan_built_at: plan.built_at, groups: {}, stop: null };
  }
  R.STATE = STATE || { run_id: ctx.runId, plan_built_at: plan.built_at, groups: {}, stop: null, invocations: [], balances_before: null, presend_sim: [] };
  R.STATE.presend_sim = R.STATE.presend_sim || [];

  if (!GROUPS.length) {
    if (!check) { writePlanSkips(R); R.planSkipsWritten = true; }
    return { outcome: 'nothing-to-send', ...summary(R, { skipped_rows: (plan.skipped_rows || []).length }) };
  }
  if (check) {
    if (R.STATE.stop) ctx.log(`note: a stop is recorded (${R.STATE.stop.kind}); --check reads only`);
    await startup(R);
    const r = await checkMode(R);
    if (r.bad.length) throw stop('check-found-problems', `exec --check found ${r.bad.length} problem(s): ${clip(JSON.stringify(r.bad.slice(0, 3)), 600)}`, { check: r.rep, check_file: ctx.rel('exec-check.json') });
    return { outcome: 'check-passed', check: r.rep, check_file: ctx.rel('exec-check.json'), ...summary(R, {}) };
  }

  // ---- LIVE. Refusals first: nothing is written and nothing is sent.
  const lk = X.lockMode(ctx);
  if (lk.mode === 'held') throw X.lockHeldStop(STEP, lk);
  if (R.STATE.stop) throw stop('prior-stop', `a stop is recorded in exec-state.json (${R.STATE.stop.kind}: ${clip(R.STATE.stop.notes, 300)}): the groups it skipped are re-planned by a fresh run-id, never resumed`);
  const supervised = lk.mode === 'supervised';
  if (supervised) {
    const ageMs = Date.now() - Date.parse(plan.built_at);
    if (!anySent && !(ageMs <= X.STALE_APPROVAL_MS)) throw stop('stale-approval', `the plan was built ${plan.built_at}, ${Math.round(ageMs / 60000)} min ago, older than STALE_APPROVAL (2 h): re-run C to F in this run-id and G (I-setup.md I.2 section 5); the executor never re-plans`);
    if (ctx.existsRun('wake-status.json')) { const ws = ctx.readRunJson('wake-status.json'); if (/repaired by/i.test(String(ws.notes || ''))) throw stop('repaired', `wake-status.json carries a "repaired by" note: rebuild and re-present the batch (G section 8, Money rules)`); }
    X.takeLock(env, 'planner exec (supervised send batch)');
  } else {
    const gp = X.gateProblems(setup);
    if (gp.length) throw stop('autonomy-gate', `an autonomous send needs the standing authorization (I-setup.md I.2 section 1): ${gp.join('; ')}; nothing was sent`, { gate: gp });
    env.lock = { mode: 'wrapper', taken: false, text: lk.text, owner: lk.owner };
    R.liveRuns = lk.liveRuns;
    const tl = setup && setup.schedule && Number(setup.schedule.time_limit_hours);
    const st = Date.parse(lk.owner.started_at);
    R.deadlineMs = ctx.opts.deadlineMs || (Number.isFinite(tl) && tl > 0 && Number.isFinite(st) ? st + tl * 3600000 - RESERVE_MS : null);
    env.deadlineMs = R.deadlineMs; R.recoverInRun = true;
  }
  try {
    await startup(R);
    const ng = await nextGroup(R);
    if (!R.STATE.balances_before) {
      const b0 = await readAll(R);
      R.STATE.balances_before = Object.fromEntries(Object.entries(b0.bal).map(([k, v]) => [k, v.toString()]));
      R.STATE.eth_before = b0.eth.toString();
    }
    R.STATE.invocations.push({ started_at: lib.nowIso(), mode: lk.mode, max_groups: maxGroups === Infinity ? null : maxGroups, start_group: ng.done ? null : R.GROUPS[ng.gi].id }); saveState(R);
    if (ng.done) { const fin = await finalize(R, 'after-inv' + R.STATE.invocations.length); return { outcome: 'complete', ...summary(R, { retained_legs: fin.retained, consumed_rows: fin.consumed_rows }) }; }
    // G section 3, before the plan's first send: the boundary of every group in one pass, so that a group past its
    // boundary stops the run before the parent mint is sent, never after (a partial mint)
    let bndSkip = null;
    if (!R.GROUPS.some((g) => R.STATE.groups[g.id] && ['done', 'in-progress', 'stopped'].includes(R.STATE.groups[g.id].status))) {
      const nc = await boundaryPass(R, R.GROUPS.slice(ng.gi));
      if (nc.length) {
        const why = `the trading boundary of ${nc.length} group(s) is not clear before the plan's first send: ${clip(nc.map((x) => `${x.id}: ${x.why}`).join('; '), 500)} (G section 3: the plan is stale)`;
        if (!anySent && !supervised && !ctx.opts.replanned) throw stop('stale-boundary', `${why}; before the run's first broadcast: re-run F and G once, then exec (I-setup.md I.2 section 5 item 3)`, { replan_due: true, first_failed_group: nc[0].id });
        if (supervised) throw stop('stale-boundary', `${why}; supervised mode re-presents the plan (re-run C to F, then G)`, { first_failed_group: nc[0].id });
        bndSkip = { kind: 'stale-boundary', why: `${why}; nothing of the plan is sent: every group is written skipped (never a partial mint)`, from: nc[0].id };
      }
    }
    // the whole remaining sequence in eth_simulateV1 immediately before the first send (G section 8, Money rules)
    const sw = bndSkip ? null : await simulateRemaining(R, ng.gi, `inv${R.STATE.invocations.length}`);
    let lastGi = R.GROUPS.length; let simSkip = null;
    if (bndSkip) { lastGi = ng.gi; simSkip = bndSkip; } else if (!sw.clean) {
      const failId = R.GROUPS[sw.firstFailed] ? R.GROUPS[sw.firstFailed].id : null;
      const why = `the pre-send simulation of the remaining plan is not clean: ${clip(sw.problems.join(' | '), 500)}`;
      if (!anySent && !supervised && !ctx.opts.replanned && !R.STATE.presend_sim.some((p) => p.plan_built_at !== plan.built_at)) {
        R.STATE.presend_sim.push({ at: lib.nowIso(), plan_built_at: plan.built_at, first_failed_group: failId, problems: sw.problems.slice(0, 3) }); saveState(R);
        throw stop('stale-simulation', `${why}; before the run's first broadcast: re-run F and G once, then exec (I-setup.md I.2 section 5 item 3)`, { replan_due: true, first_failed_group: failId });
      }
      if (supervised) throw stop('stale-simulation', `${why}; supervised mode re-presents the plan (re-run C to F if needed, then G)`, { first_failed_group: failId });
      R.STATE.presend_sim.push({ at: lib.nowIso(), plan_built_at: plan.built_at, first_failed_group: failId, problems: sw.problems.slice(0, 3), action: 'skipped from the failing group' }); saveState(R);
      lastGi = sw.firstFailed === null ? ng.gi : sw.firstFailed;
      simSkip = { why: `${why}; ${anySent ? 'after a broadcast' : 'the rebuilt plan failed again'}: the failing group and every later one are skipped (G section 8, A failing pre-send simulation)`, from: failId };
    }
    const cg = { touched: new Set() }; let done = 0; let skippedInfo = null;
    for (let gi = ng.gi; gi < lastGi && done < maxGroups; gi++) {
      const r = await runGroup(R, gi, cg);
      if (r.skipped) { skippedInfo = r.skipped; break; }
      done++;
    }
    if (simSkip) { const sk = skipRowsFrom(R, lastGi, simSkip.why); skippedInfo = skippedInfo || { kind: simSkip.kind || 'stale-simulation', why: simSkip.why, groups: sk }; }
    R.STATE.invocations[R.STATE.invocations.length - 1].ended_at = lib.nowIso(); saveState(R);
    if (!R.planSkipsWritten) { writePlanSkips(R); R.planSkipsWritten = true; }
    const fin = await finalize(R, 'after-inv' + R.STATE.invocations.length);
    const complete = R.GROUPS.every((g) => R.STATE.groups[g.id] && R.STATE.groups[g.id].status === 'done');
    const sm = summary(R, { retained_legs: fin.retained, consumed_rows: fin.consumed_rows, unattributed_consumption: fin.unattributed, notes: fin.notes, eth_after: fin.eth_after !== undefined ? weiStr(fin.eth_after) : null });
    ctx.writeRunJson('exec-summary.json', { ...sm, skipped: skippedInfo }, { indent: 1 });
    if (skippedInfo) throw stop(skippedInfo.kind === 'affordability' ? 'affordability-skip' : skippedInfo.kind === 'time-budget' ? 'time-budget' : skippedInfo.kind === 'stale-boundary' ? 'stale-boundary' : 'stale-simulation', skippedInfo.why, { ...sm, skipped_groups: skippedInfo.groups.slice(0, 20), skipped_count: skippedInfo.groups.length, budget_exhausted: skippedInfo.kind === 'time-budget', already_final: true });
    return { outcome: complete ? 'complete' : 'paused-after-max-groups', ...sm };
  } catch (e) {
    // a refusal before this invocation started any group (nothing open) changes nothing more; a skip is already written
    if ((e instanceof Stop && e.fields && e.fields.already_final) || (!R.started && !R.env.open)) throw e;
    const inProgress = R.GROUPS.findIndex((g) => R.STATE.groups[g.id] && ['in-progress', 'stopped'].includes(R.STATE.groups[g.id].status) && !R.STATE.groups[g.id].reason);
    const firstOpen = R.GROUPS.findIndex((g) => !R.STATE.groups[g.id] || !['done', 'skipped'].includes(R.STATE.groups[g.id].status));
    const st = await stopRun(R, e, { gi: inProgress >= 0 ? inProgress : firstOpen >= 0 ? firstOpen : undefined });
    const sm = summary(R, { retained_legs: st.fin.retained, consumed_rows: st.fin.consumed_rows, unattributed_consumption: st.fin.unattributed, half_done: st.halfDone, recovery: st.recovery, skipped_groups: st.skipped.slice(0, 20), skipped_count: st.skipped.length, eth_after: st.fin.eth_after !== undefined ? weiStr(st.fin.eth_after) : null });
    ctx.writeRunJson('exec-summary.json', { outcome: 'stopped', stop: { kind: st.s.cause, notes: st.s.notes }, ...sm }, { indent: 1 });
    throw new Stop({ step: STEP, cause: st.s.cause, status: 'aborted', notes: st.s.notes, exit: st.s.exit, fields: { ...st.f, ...sm } });
  } finally {
    X.releaseLock(env);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the start-of-run repair of a prior run-id (wake.cjs; I-setup.md I.2 section 6 (c)): every transaction of its plan that
// landed with no fills.json row carrying its tx_hash (it landed after the run stopped, or the run stopped between its
// receipt and its row) gets its row APPENDED, never a row removed or edited. A receipt read gives no amounts (the helper
// prints no logs) and H never fills a row from allocation.json or a live balance, so the row comes from the signed
// calldata: exact where the calldata fixes the amount (a split, an exact-output count, a set-sell's or a merge's q, a
// complex buy's x), else the calldata's own bound (amountOutMinimum, a floor on what came in; amountInMaximum, a ceiling
// on what went out), said in `error`. It also counts each group's landed transactions against the plan: some but not
// all landed is a half-done group.
// ---------------------------------------------------------------------------------------------------------------
function signedData(ctx, rid, T) {
  if (!T.rebuild_at_send) return T.data;
  const rel = `run/${rid}/exec-data/r-tx-${X.pad(T.idx)}.json`; // a complex buy's last two, rebuilt at send time
  try { return ctx.existsRel(rel) ? JSON.parse(ctx.readRel(rel).toString('utf8')).calls[0].data : null; } catch (e) { return null; }
}
function rowFromCalldata(IF, plan, g, T, data, hash, note) {
  const d = IF.parseTransaction({ data }); if (!d) return null;
  const arg = (t, k) => IF.parseTransaction({ data: t.data }).args[k];
  const per = (a, b) => (b > 0n ? num(a) / num(b) : 0);
  const stakeOf = (side) => { const r = (g.allocation_rows || []).find((x) => x.side === side); return r ? r.stake : null; };
  const row = (side, route, filled, fp, how) => ({ market: g.market, address: lc(g.address), side, route, requested: stakeOf(side), filled: num(filled), fill_price: fp, slippage_vs_quote: 0, tx_hash: hash, status: 'filled', error: `${note}: ${how}` });
  if (g.kind === 'mint' && d.name === 'splitPosition') {
    const x = mintX(g); const mt = plan.mint || {}; const want = BigInt(x === 'parent' ? mt.M_wei || 0 : (mt.m_X_wei || {})[x] || 0);
    return { market: x === 'parent' ? 'PARENT-MINT' : MIDDLE[x], address: x === 'parent' ? A.PARENT : MIDDLE[x], side: 'mint', route: 'split-parent', requested: num(want), filled: num(BigInt(d.args[2])), fill_price: 1.0, slippage_vs_quote: 0, tx_hash: hash, status: 'filled', error: `${note}: the split amount from the signed calldata (exact)` };
  }
  if (g.kind === 'simple-buy' && d.name === 'exactInputSingle') { const a = d.args[0]; const fl = BigInt(a.amountOutMinimum); return row(g.allocation_rows[0].side, 'simple-buy', fl, per(BigInt(a.amountIn), fl), 'filled is the calldata\'s amountOutMinimum, a floor on the output; the repo spent (amountIn) is exact'); }
  if (g.kind === 'dual-buy' && d.name === 'exactOutputSingle') { const a = d.args[0]; const out = BigInt(a.amountOut); return row(lc(a.tokenOut) === lc(g.market_refs.up) ? 'UP' : 'DOWN', 'dual-buy', out, per(BigInt(a.amountInMaximum), out), 'filled is the exact-output count (exact); fill_price from amountInMaximum, a ceiling on the repo spent'); }
  if (g.kind === 'set-sell' && T.label.startsWith('sell q DOWN')) { const q = BigInt(d.args[0].amountIn); const fl = g.txs.filter((t) => t.label.startsWith('sell q')).reduce((s, t) => s + BigInt(arg(t, 0).amountOutMinimum), 0n); return row('set', 'set-sell', q, per(fl, q), 'filled is q (exact); fill_price from the two sales\' amountOutMinimum, a floor on the proceeds'); }
  if (g.kind === 'merge-arb' && d.name === 'mergePositions') { const q = BigInt(d.args[2]); const ceil = g.txs.filter((t) => (IF.parseTransaction({ data: t.data }) || {}).name === 'exactOutputSingle').reduce((s, t) => s + BigInt(arg(t, 0).amountInMaximum), 0n); return row('set', 'buy-and-merge', q, per(ceil, q), 'filled is q (exact); fill_price from the two buys\' amountInMaximum, a ceiling on the repo spent'); }
  if (g.kind === 'complex-buy' && T.label.startsWith('buy ')) { const x = BigInt(arg(g.txs[1], 2)); const filled = x + BigInt(d.args[0].amountOutMinimum); return row(g.allocation_rows[0].side, 'complex-buy', filled, per(x, filled), 'filled is x plus the final buy\'s amountOutMinimum, a floor; the net repo spent (x) is exact'); }
  return null;
}
// late: the nonce the repair has just settled Landed, { n, hash, input_hash, success, block }, or null
function repairPlanRows(ctx, rid, late, note) {
  const out = { matched: null, added: [], half_done: [] };
  if (!ctx.existsRel(`run/${rid}/g-plan.json`)) return out;
  const plan = JSON.parse(ctx.readRel(`run/${rid}/g-plan.json`).toString('utf8'));
  const groups = plan.groups || []; const book = new X.Book(ctx.cfg, rid);
  const st = book.readJson('exec-state.json', null) || { run_id: rid, plan_built_at: plan.built_at, groups: {}, stop: null, invocations: [], balances_before: null, presend_sim: [] };
  st.groups = st.groups || {};
  const E = ctx.ethers(); const IF = new E.Interface(IF_SIGS);
  if (late && late.input_hash) {
    // the plan's transaction at that nonce whose signed input hashes to the attempt's calldata_hash (a Half B send recorded
    // in this folder can reuse the nonce of a group the run skipped: never matched by the nonce alone)
    for (const g of groups) for (const T of g.txs) {
      if (out.matched || T.nonce_expected !== late.n) continue;
      const data = signedData(ctx, rid, T);
      if (!data || lc(E.keccak256(data)) !== lc(late.input_hash)) continue;
      out.matched = { group: g.id, idx: T.idx, label: T.label };
      if (late.success) {
        const gs = st.groups[g.id] || (st.groups[g.id] = { status: 'skipped', txs: [] }); gs.txs = gs.txs || [];
        if (!gs.txs.some((t) => lc(t.hash || '') === lc(late.hash))) { gs.txs.push({ idx: T.idx, nonce: late.n, hash: late.hash, block: late.block, recorded_at: note }); book.writeJson('exec-state.json', st); }
      } else {
        const r = rowFromCalldata(IF, plan, g, T, data, late.hash, note);
        if (r && !book.fills().runs.some((x) => lc(x.tx_hash || '') === lc(late.hash))) { const rv = { ...r, filled: 0, fill_price: 0, status: 'reverted', error: `${note}: the receipt shows a revert` }; book.addRows([rv]); out.added.push(rv); }
      }
    }
  }
  // every landed transaction of the plan (exec-state.json; a hash-only entry is placed through exec-sends.json) without a
  // row carrying its tx_hash
  const sent = new Map(book.sends().filter((s) => s.tx_hash).map((s) => [lc(s.tx_hash), s]));
  const have = new Set(book.fills().runs.map((r) => lc(r.tx_hash || '')));
  const rows = [];
  for (const g of groups) {
    const gs = st.groups[g.id]; if (!gs) continue;
    for (const t of gs.txs || []) {
      if (!t.hash || have.has(lc(t.hash))) continue;
      const s = sent.get(lc(t.hash)) || {}; const idx = Number.isInteger(t.idx) ? t.idx : s.idx; const nonce = Number.isInteger(t.nonce) ? t.nonce : s.nonce;
      const T = g.txs.find((x) => (Number.isInteger(idx) ? x.idx === idx : x.nonce_expected === nonce)); if (!T) continue;
      const data = signedData(ctx, rid, T); if (!data) continue;
      const r = rowFromCalldata(IF, plan, g, T, data, t.hash, note);
      if (r) { rows.push(r); have.add(lc(t.hash)); }
    }
  }
  if (rows.length) {
    const F = book.fills(); F.runs.push(...rows);
    const pm = rows.find((r) => r.market === 'PARENT-MINT'); if (pm) { F.totals = F.totals || {}; F.totals.spent = pm.filled; F.totals.spent_unit = 'sUSDS'; }
    book.saveFills(F); out.added.push(...rows);
  }
  // half-done: some but not all of a group's transactions landed, and no recovery completed, unwound or settled it
  for (const g of groups) { const gs = st.groups[g.id]; const n = new Set(((gs && gs.txs) || []).map((t) => lc(t.hash || '')).filter(Boolean)).size; if (n > 0 && n < g.txs.length && !recoverySettled(book, g.id)) out.half_done.push({ group: g.id, landed: n, of: g.txs.length }); }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// THE RECOVERY RULE of G section 8 step 4 (I-setup.md I.2 section 5 item 6), its one implementation. exec applies it in
// the run that stopped (inside the wrapper only: a supervised batch has its own "yes"), and the wake's start-of-run
// repair applies it to a prior run-id's half-done group once every nonce is settled. A keep-whole group of the entry
// plan whose first L transactions landed (exec-state.json, plus what an earlier recovery of it landed) is judged
// against the CURRENT chain state and the rows already recorded, never the original plan alone:
//   1. its boundary (G section 3: its child's; a mint's own level, a flip since the plan) not clear: nothing is traded
//      or merged and the landed legs are kept as rows (kept), or, when only approvals landed, nothing-to-unwind;
//   2. complete it: the group's remaining transactions as the plan wrote them, its floors unchanged (a complex buy's
//      last pair at the sale's proceeds P and a fresh quote at P less 0.5%, rebuilt at the realised P once the sale
//      lands), simulated now: sent when every call of that simulation succeeds (its floors and balances clear);
//   3. otherwise unwind what landed: merge back a split whose sales did not land (buy-and-merge), else sell each stray
//      leg into the repo token at a fresh quote less 0.5% (sell-exit), simulated now; only approvals landed:
//      nothing-to-unwind;
//   4. neither simulates clean: nothing is sent (stopped), and the next run's start-of-run repair judges it again.
// The batch is a new plan from that state, never a resend, in the same run-id: fresh nonces, gas from its own
// simulation, the signer's check of every file, the time budget and affordability, then per transaction the boundary and
// floor re-check and exec-core's pre-send path, write-ahead and settlement (exec-sends.json source "recovery"). Its rows
// go to that run-id's fills.json in the existing vocabulary (a completing leg on the group's own route, an unwind sale
// sell-exit, a merge-back buy-and-merge), each naming the failed transaction and the word "recovery". One attempt per
// run, never a loop: a send that stops ends it (stopped). recovery.json in the run-id records every attempt and its
// transactions before each broadcast, and the effects that landed; a group it completed, unwound or found nothing to
// unwind in is never acted on again.
// ---------------------------------------------------------------------------------------------------------------
const RECOVERY_SETTLED = new Set(['completed', 'unwound', 'nothing-to-unwind']); // never acted on again
const RECOVERY_FINAL = new Set([...RECOVERY_SETTLED, 'kept']); // the repair finalizes the run-id after these
// the stops after which exec applies the rule in the same run (G section 8 step 4): a settled revert, a not-sent finding
// that sending may continue after, a floor breach or a stale check found before sending; never a refusal before any
// broadcast (terminal for the group in this run), a Pending or unsettled nonce, a safety stop or a transport failure
const RECOVERABLE = new Set(['reverted', 'not-sent', 'stale-floor', 'stale-balance', 'stale-boundary', 'stale-route', 'stale-simulation', 'gas-limit', 'gas-grew']);
const SIG_APPROVE = 'approve(address,uint256)';
const SIG_EXIN = 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))';
const SIG_MERGE = 'mergePositions(address,address,uint256)';
const recoveryRecord = (book) => book.readJson('recovery.json', null) || { groups: {} };
const recoveryOf = (book, gid) => recoveryRecord(book).groups[gid] || null;
const recoverySettled = (book, gid) => { const r = recoveryOf(book, gid); return !!(r && RECOVERY_SETTLED.has(r.outcome)); };
const fileTag = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);

// the group's boundary, read now in one multicall (a mint's level: its questions read first)
async function recBoundary(env, g) {
  let b;
  if (g.market_refs) b = { cond: g.pre_send_checks.condition_id, qids: [g.pre_send_checks.question_id], build: null };
  else { const x = mintX(g); const q = await env.mc([{ to: x === 'parent' ? A.PARENT : MIDDLE[x], signature: 'questionsIds()(bytes32[])' }]); b = { cond: CONDS[x], qids: q.results[0][0], build: g.pre_send_checks && g.pre_send_checks.level ? g.pre_send_checks : null }; }
  const req = [...boundaryReq(b), { to: A.MC3, signature: 'getCurrentBlockTimestamp()(uint256)' }];
  const o = await env.mcChunked(req, 400);
  return boundaryEval(o.results.slice(0, req.length - 1), BigInt(o.results[req.length - 1][0]), b.qids.length, b.build);
}
async function recBalances(env, g) {
  const m = g.market_refs; const k = ['repo', 'up', 'down', 'inv']; const t = [m.repo_token, m.up, m.down, m.child_invalid];
  const o = await env.mc(t.map((a) => ({ to: a, signature: 'balanceOf(address)(uint256)', args: [env.holder] })));
  const bal = {}; k.forEach((n, i) => { bal[n] = BigInt(o.results[i][0]); }); return bal;
}
async function recEncode(env, book, sig, args, tag) {
  const argv = []; let k = 0;
  for (const a of args) { if (Array.isArray(a)) { const f = `recovery-tmp/arg-${tag}-${k++}.json`; book.write(f, JSON.stringify(a)); argv.push(`@${book.rel(f)}`); } else argv.push(String(a)); }
  const e = await env.H(['encode', sig, ...argv]);
  return { data: e.calldata, keccak: lc(e.keccak256) };
}
// the batch simulated now as one group: every call 0x1, nothing clamped, no override, at the holder's pending nonce; it
// gives each transaction its nonce and its gas fields ("the plan" of a recovery batch, G section 8)
async function recSimulate(env, book, txs, name) {
  const nn = await env.H(['nonce', env.holder]);
  if (nn.latest !== nn.pending) throw X.xstop(env.step, 'pending-transaction', `a transaction of the holder is pending (latest ${nn.latest}, pending ${nn.pending}): no recovery batch is simulated or sent`, { nonce: nn });
  book.write(name, JSON.stringify([{ calls: txs.map((t) => ({ to: t.to, data: t.data, value: '0' })) }]));
  const page = await env.H(['simulate', book.rel(name)]);
  const pb = G.pageProblems(page, { entries: 1, count: txs.length, pendingNonce: nn.pending });
  if (pb.length) return { ok: false, why: clip(pb.join('; '), 300) };
  txs.forEach((t, k) => { const row = page.calls[k]; t.gas_used = Number(row[3]); t.max_used_gas = row[4] === null || row[4] === undefined ? null : Number(row[4]); t.gas_limit = String(row[5]); t.nonce_expected = nn.pending + k; });
  return { ok: true };
}
function recInput(book, t, tag) { const name = `recovery-tx/${tag}-n${t.nonce_expected}.json`; book.write(name, JSON.stringify({ calls: [{ to: t.to, data: t.data, value: '0' }], gasLimit: t.gas_limit })); t.signer_input_file = book.rel(name); }
// the fee tier of the pool of one leg: market_refs, else the plan's own swap on that token
function legFee(IF, g, tok) {
  const m = g.market_refs; const side = lc(tok) === lc(m.up) ? 'UP' : 'DOWN';
  if (m.fee_tier && m.fee_tier[side] !== undefined) return Number(m.fee_tier[side]);
  for (const t of g.txs) { const d = IF.parseTransaction({ data: t.data }); if (d && /^exact(In|Out)putSingle$/.test(d.name) && [lc(d.args[0].tokenIn), lc(d.args[0].tokenOut)].includes(lc(tok))) return Number(d.args[0].fee); }
  throw stop('plan-shape', `${g.id}: no fee tier for ${tok}`);
}
async function recPair(env, book, buy, P, quoted, own, tag) {
  const min = quoted * 9950n / 10000n;
  const ea = await recEncode(env, book, SIG_APPROVE, [A.SWAP, P.toString()], tag + 'a');
  const es = await recEncode(env, book, SIG_EXIN, [[buy.tokenIn, buy.tokenOut, Number(buy.fee), env.holder, P.toString(), min.toString(), 0]], tag + 'b');
  return [{ label: 'approve repo -> SwapRouter02 (P, the sale proceeds)', to: lc(buy.tokenIn), data: ea.data, calldata_keccak256: ea.keccak, role: 'complete', planIdx: 4, P },
    { label: `buy ${own} with the proceeds (min 99.5% of a fresh quote at P)`, to: lc(A.SWAP), data: es.data, calldata_keccak256: es.keccak, role: 'complete', planIdx: 5, P }];
}
// 2. completing the group: its transactions from L on (null: no usable quote)
async function recCompletion(env, book, g, L, IF, bal, ef, tag) {
  const rem = g.txs.slice(L).map((t) => ({ label: t.label, to: lc(t.to), data: t.data, calldata_keccak256: lc(t.calldata_keccak256), role: 'complete', planIdx: t.idx }));
  if (g.kind !== 'complex-buy') return { txs: rem };
  const own = g.allocation_rows[0].side;
  const sale = IF.parseTransaction({ data: g.txs[3].data }).args[0]; const buy = IF.parseTransaction({ data: g.txs[5].data }).args[0];
  let P; let bound = false;
  if (L <= 3) { const q = await quote({ env }, 'in', sale.tokenIn, sale.tokenOut, Number(sale.fee), BigInt(sale.amountIn)); if (!q.ok) return null; P = q.amt; }
  else {
    const rb = signedData(env.ctx, book.runId, g.txs[4]); // the approve rebuilt at the realised proceeds before the stop
    if (ef.approved_P) P = BigInt(ef.approved_P); else if (rb) P = BigInt(IF.parseTransaction({ data: rb }).args[1]); else { P = BigInt(sale.amountOutMinimum); bound = true; }
    if (P > bal.repo) P = bal.repo;
  }
  if (P <= 0n) return null;
  const qb = await quote({ env }, 'in', buy.tokenIn, buy.tokenOut, Number(buy.fee), P); if (!qb.ok) return null;
  const pair = await recPair(env, book, buy, P, qb.amt, own, tag);
  pair.forEach((t) => { t.rebuild = L <= 3; t.boundP = bound; });
  return { txs: [...rem.filter((t) => t.planIdx < 4), ...pair.filter((t) => t.planIdx >= L)] };
}
// 3. unwinding what landed: a merge-back of a split whose sales did not land, else a sale of each stray leg
async function recUnwind(env, book, g, L, IF, bal, ef, tag) {
  const m = g.market_refs; if (!m) return { txs: [], why: 'only an approval landed: a mint holds no position to unwind' };
  const landed = g.txs.slice(0, L).map((t) => IF.parseTransaction({ data: t.data }));
  const split = landed.find((d) => d.name === 'splitPosition'); const sold = landed.some((d) => d.name === 'exactInputSingle');
  if (split && !sold) {
    const S0 = BigInt(split.args[2]) - BigInt(ef.merged_back || '0'); if (S0 <= 0n) return { txs: [], done: true };
    const S = [S0, bal.down, bal.up, bal.inv].reduce((a, b) => (b < a ? b : a)); if (S <= 0n) return { txs: [], gone: true, why: 'the split\'s legs are no longer held' };
    const txs = [];
    for (const [tok, nm] of [[m.down, 'DOWN'], [m.up, 'UP'], [m.child_invalid, 'child Invalid']]) { const e = await recEncode(env, book, SIG_APPROVE, [A.ROUTER, S.toString()], `${tag}m${nm[0]}`); txs.push({ label: `approve ${nm} -> Router (S, merge-back)`, to: lc(tok), data: e.data, calldata_keccak256: e.keccak, role: 'merge-back' }); }
    const e = await recEncode(env, book, SIG_MERGE, [A.sUSDS, lc(g.address), S.toString()], `${tag}mm`);
    txs.push({ label: 'Router.mergePositions(sUSDS, child, S) (merge-back)', to: lc(A.ROUTER), data: e.data, calldata_keccak256: e.keccak, role: 'merge-back' });
    return { txs, kind: 'merge-back' };
  }
  const legs = []; const own = g.allocation_rows && g.allocation_rows[0] ? g.allocation_rows[0].side : null;
  if (g.kind === 'complex-buy' && sold) legs.push({ side: own, amt: BigInt(split.args[2]) });
  if (g.kind === 'set-sell' && sold) legs.push({ side: 'DOWN', amt: BigInt(split.args[2]) });
  if (g.kind === 'dual-buy' || g.kind === 'merge-arb') for (const d of landed) if (d.name === 'exactOutputSingle') legs.push({ side: lc(d.args[0].tokenOut) === lc(m.up) ? 'UP' : 'DOWN', amt: BigInt(d.args[0].amountOut) });
  if (!legs.length) return { txs: [], why: 'only approvals landed: no position to unwind' };
  const txs = []; let left = false;
  for (const l of legs) {
    const rest = l.amt - BigInt((ef.sold || {})[l.side] || '0'); if (rest <= 0n) continue; left = true;
    const tok = l.side === 'UP' ? m.up : m.down; const have = bal[l.side === 'UP' ? 'up' : 'down']; const amt = rest < have ? rest : have;
    if (amt <= 0n) continue;
    const fee = legFee(IF, g, tok);
    const q = await quote({ env }, 'in', tok, m.repo_token, fee, amt); if (!q.ok || q.amt <= 0n) return { txs: [], why: `no usable quote to sell the stray ${l.side} leg` };
    const ea = await recEncode(env, book, SIG_APPROVE, [A.SWAP, amt.toString()], `${tag}s${l.side[0]}a`);
    const es = await recEncode(env, book, SIG_EXIN, [[tok, m.repo_token, fee, env.holder, amt.toString(), (q.amt * 9950n / 10000n).toString(), 0]], `${tag}s${l.side[0]}b`);
    txs.push({ label: `approve ${l.side} -> SwapRouter02 (the stray leg)`, to: lc(tok), data: ea.data, calldata_keccak256: ea.keccak, role: 'sell-exit', side: l.side },
      { label: `sell the stray ${l.side} leg -> repo (sell-exit, min 99.5% of a fresh quote)`, to: lc(A.SWAP), data: es.data, calldata_keccak256: es.keccak, role: 'sell-exit', side: l.side });
  }
  if (!txs.length) return left ? { txs: [], gone: true, why: 'the stray legs are no longer held' } : { txs: [], done: true };
  return { txs, kind: 'sell-exit' };
}
// the pre-send re-check of one recovery transaction (G section 3): the boundary, and a swap's fresh quote against its floor
async function recPreCheck(env, g, T, IF) {
  const bd = await recBoundary(env, g); if (!bd.clear) throw X.xstop(env.step, 'stale-boundary', `${g.id} (recovery) ${T.label}: ${bd.why.join('; ')} (G section 3)`);
  const d = IF.parseTransaction({ data: T.data }); const a = d.args[0];
  if (d.name === 'exactInputSingle') { const q = await quote({ env }, 'in', a.tokenIn, a.tokenOut, Number(a.fee), BigInt(a.amountIn)); if (!q.ok || q.amt < BigInt(a.amountOutMinimum)) throw X.xstop(env.step, 'stale-floor', `${g.id} (recovery) ${T.label}: the fresh quote ${q.ok ? q.amt : 'unusable'} is below amountOutMinimum ${a.amountOutMinimum}`); }
  if (d.name === 'exactOutputSingle') { const q = await quote({ env }, 'out', a.tokenIn, a.tokenOut, Number(a.fee), BigInt(a.amountOut)); if (!q.ok || q.amt > BigInt(a.amountInMaximum)) throw X.xstop(env.step, 'stale-floor', `${g.id} (recovery) ${T.label}: the fresh amountIn ${q.ok ? q.amt : 'unusable'} is above amountInMaximum ${a.amountInMaximum}`); }
}

// Apply the rule to group gid of run-id book.runId. failed: { cause, label, nonce, hash } of the transaction that stopped
// the group (exec), or null (the repair names the group's first transaction not landed). Never throws for a stop: it
// returns { group, outcome, decision, why, txs, rows, keep_aborted, pending_nonce }.
async function recoverGroup({ env, book, gid, trigger, by, failed = null }) {
  const ctx = env.ctx; const E = ctx.ethers(); const IF = new E.Interface(IF_SIGS);
  const rec = recoveryRecord(book); const prev = rec.groups[gid] || null;
  if (prev && RECOVERY_SETTLED.has(prev.outcome)) return { group: gid, outcome: prev.outcome, already: true, why: `already ${prev.outcome} by an earlier recovery`, txs: [], rows: 0 };
  const plan = book.readJson('g-plan.json', null); const g = plan ? (plan.groups || []).find((x) => x.id === gid) : null;
  const ef = (prev && prev.effects) || { completed_idx: [], merged_back: '0', sold: {}, approved_P: null };
  const gs = ((book.readJson('exec-state.json', null) || {}).groups || {})[gid] || { txs: [] };
  const L0 = new Set((gs.txs || []).map((t) => lc(t.hash || '')).filter(Boolean)).size;
  let L = L0; while (ef.completed_idx.includes(L)) L++;
  const ft = failed || (g && g.txs[L] ? { label: g.txs[L].label, nonce: g.txs[L].nonce_expected } : {});
  const failedText = `${ft.label || 'unknown'}${ft.nonce !== undefined && ft.nonce !== null ? ` (plan nonce ${ft.nonce})` : ''}${ft.hash ? ` ${ft.hash}` : ''}${ft.cause ? `, ${ft.cause}` : ''}`;
  const att = { at: lib.nowIso(), by, trigger, landed: L, of: g ? g.txs.length : null, failed: failedText, decision: null, outcome: 'judging', why: null, txs: [], rows: 0 };
  const record = () => { rec.groups[gid] = { outcome: att.outcome, effects: ef, attempts: [...((prev && prev.attempts) || []), att] }; book.writeJson('recovery.json', rec); };
  const tag = `${fileTag(gid)}-a${((prev && prev.attempts) || []).length + 1}`;
  const errText = (what) => `recovery of group ${gid} (${by}): ${what}; the failed transaction: ${failedText}`;
  const addRow = (r) => { book.addRows([{ slippage_vs_quote: 0, status: 'filled', ...r }]); att.rows++; };
  const end = (outcome, why) => { att.outcome = outcome; att.why = clip(why, 600); };
  try {
    if (!g) { end('stopped', 'the group is not in g-plan.json'); }
    else if (L >= g.txs.length) end('completed', 'every transaction of the group has landed (an earlier recovery included)');
    else {
      const m = g.market_refs || null; const own = g.allocation_rows && g.allocation_rows[0] ? g.allocation_rows[0].side : null;
      const position = g.txs.slice(0, L).some((t) => IF.parseTransaction({ data: t.data }).name !== 'approve');
      // the landed legs of a merge-arb (no row until its merge): kept as filled rows before anything is unwound or kept
      const landedHash = (t) => { const h = (gs.txs || []).find((x) => x.hash && (x.idx === t.idx || x.nonce === t.nonce_expected)); if (h) return h.hash; for (const a of (prev && prev.attempts) || []) for (const u of a.txs || []) if (u.plan_idx === t.idx && u.tx_hash) return u.tx_hash; return null; };
      const legRows = () => {
        if (g.kind !== 'merge-arb') return;
        const have = new Set(book.fills().runs.map((r) => lc(r.tx_hash || '')));
        for (const t of g.txs.slice(0, L)) {
          const d = IF.parseTransaction({ data: t.data }); if (d.name !== 'exactOutputSingle') continue;
          const h = { hash: landedHash(t) }; if (!h.hash || have.has(lc(h.hash))) continue;
          const out = BigInt(d.args[0].amountOut); const side = lc(d.args[0].tokenOut) === lc(m.up) ? 'UP' : 'DOWN';
          addRow({ market: g.market, address: lc(g.address), side, route: 'buy-and-merge', requested: num(out), filled: num(out), fill_price: num(BigInt(d.args[0].amountInMaximum)) / num(out), tx_hash: h.hash, error: errText('the landed leg, kept as a filled row; fill_price from amountInMaximum, a ceiling') });
        }
      };
      const bnd = await recBoundary(env, g);
      if (!bnd.clear) { if (position) { legRows(); end('kept', `the boundary allows neither trading nor merging (${bnd.why.join('; ')}): the landed legs are kept as rows and the group is listed half-done`); } else end('nothing-to-unwind', `only approvals landed and the boundary allows no trade (${bnd.why.join('; ')}): no position to unwind`); }
      else {
        const bal = m ? await recBalances(env, g) : null;
        let batch = null; const tried = [];
        const comp = await recCompletion(env, book, g, L, IF, bal, ef, tag + 'c');
        if (!comp) tried.push('completing it has no usable quote');
        else { const s = await recSimulate(env, book, comp.txs, `recovery-tmp/${tag}-complete.json`); if (s.ok) { batch = comp.txs; att.decision = 'complete'; } else tried.push(`completing it does not simulate clean (${s.why})`); }
        if (!batch) {
          const un = await recUnwind(env, book, g, L, IF, bal, ef, tag + 'u');
          if (!un.txs.length) {
            if (un.done) end('unwound', `${tried.join('; ')}; what landed is already unwound by an earlier recovery`);
            else if (!position || un.gone) end('nothing-to-unwind', `${tried.join('; ')}; ${un.why}`);
            else { legRows(); end('stopped', `${tried.join('; ')}; it cannot be unwound now (${un.why}): nothing sent`); }
          } else {
            const s = await recSimulate(env, book, un.txs, `recovery-tmp/${tag}-unwind.json`);
            if (s.ok) { batch = un.txs; att.decision = un.kind; } else { legRows(); end('stopped', `${tried.join('; ')}; unwinding it does not simulate clean either (${s.why}): nothing sent`); }
          }
        }
        if (batch) {
          for (const t of batch) recInput(book, t, tag);
          let refused = null;
          for (const t of batch) { const c = await X.signerRun(env, 'check', t.signer_input_file); if (!(c.exit === 0 && c.last && c.last.allowed === true)) { refused = `the signer's check refused ${t.label}: ${clip(c.stdout || c.stderr, 200)}`; break; } }
          const fit = refused ? null : X.groupFits(env, batch.length, env.deadlineMs);
          const af = refused || !fit.ok ? null : await X.affordability(env, batch);
          if (refused) end('stopped', `${refused} (a refusal before any broadcast: nothing more is tried in this run)`);
          else if (!fit.ok) end('stopped', `turn/time budget exhausted: the recovery batch (${batch.length} transactions) does not fit the time left (G section 8, Room to finish)`);
          else if (!af.ok) end('stopped', `affordability: ${af.text}; the recovery batch is not started (G section 8, Affordability)`);
          else {
            if (att.decision !== 'complete') legRows();
            const splitAmt = (() => { const t = g.txs.find((u) => IF.parseTransaction({ data: u.data }).name === 'splitPosition'); return t ? BigInt(IF.parseTransaction({ data: t.data }).args[2]) : 0n; })();
            const acc = { sale: null, set: 0n, ma: 0n };
            let prevBal = bal; const t0 = Date.now();
            for (let i = 0; i < batch.length; i++) {
              let T = batch[i];
              if (T.rebuild && !T.rebuilt) {
                // the sale landed: the last pair at the realised proceeds (G section 3, sequential mode), simulated again
                const buy = IF.parseTransaction({ data: g.txs[5].data }).args[0];
                const P = acc.sale; if (P === null || P <= 0n) throw X.xstop(env.step, 'stale-floor', `${gid} (recovery): the sale realised no proceeds`);
                const q = await quote({ env }, 'in', buy.tokenIn, buy.tokenOut, Number(buy.fee), P); if (!q.ok) throw X.xstop(env.step, 'stale-floor', `${gid} (recovery): the fresh buy quote at P is unusable`);
                const pair = await recPair(env, book, buy, P, q.amt, own, tag + 'r');
                const s = await recSimulate(env, book, pair, `recovery-tmp/${tag}-pair.json`); if (!s.ok) throw X.xstop(env.step, 'stale-simulation', `${gid} (recovery): the pair rebuilt at P does not simulate clean (${s.why})`);
                for (const p of pair) { p.rebuilt = true; recInput(book, p, tag); const c = await X.signerRun(env, 'check', p.signer_input_file); if (!(c.exit === 0 && c.last && c.last.allowed === true)) throw X.xstop(env.step, 'signer-refused', `${gid} (recovery): the signer's check refused ${p.label}`); }
                batch.splice(i, 2, ...pair); T = batch[i];
              }
              await recPreCheck(env, g, T, IF);
              const ps = await X.presend(env, book, T, T.nonce_expected);
              const tr = { label: T.label, role: T.role, plan_idx: T.planIdx === undefined ? null : T.planIdx, side: T.side || null, nonce: T.nonce_expected, calldata_hash: ps.hash, signer_input_file: T.signer_input_file, tx_hash: null };
              att.txs.push(tr); att.outcome = 'sending'; record(); // the attempt's own write-ahead, before inflight.json and the broadcast
              const res = await X.broadcast(env, book, T, T.nonce_expected, ps.hash, { source: 'recovery', group: gid });
              const d = IF.parseTransaction({ data: T.data }); const a = d.args[0]; const base = { market: g.market, address: lc(g.address), tx_hash: res.hash };
              tr.tx_hash = res.hash; recEffect(g, ef, tr, d); record(); // its effect, before anything else is read
              const nb = m ? await recBalances(env, g) : null;
              const stakeOf = (side) => { const r = (g.allocation_rows || []).find((z) => z.side === side); return r ? r.stake : null; };
              tr.row = true;
              if (T.role === 'complete') {
                if (g.kind === 'mint' && d.name === 'splitPosition') {
                  const x = mintX(g); const amt = BigInt(d.args[2]); const want = BigInt(x === 'parent' ? (plan.mint || {}).M_wei || 0 : ((plan.mint || {}).m_X_wei || {})[x] || 0);
                  addRow({ market: x === 'parent' ? 'PARENT-MINT' : MIDDLE[x], address: x === 'parent' ? A.PARENT : MIDDLE[x], side: 'mint', route: 'split-parent', requested: num(want), filled: num(amt), fill_price: 1.0, tx_hash: res.hash, error: errText('the completing split (exact)') });
                  if (x === 'parent') { const F = book.fills(); F.totals.spent = num(amt); F.totals.spent_unit = 'sUSDS'; book.saveFills(F); }
                } else if (g.kind === 'simple-buy' && d.name === 'exactInputSingle') {
                  const k = own === 'UP' ? 'up' : 'down'; const got = nb[k] - prevBal[k];
                  addRow({ ...base, side: own, route: 'simple-buy', requested: stakeOf(own), filled: num(got), fill_price: price(prevBal.repo - nb.repo, got), error: errText('the completing leg') });
                } else if (g.kind === 'dual-buy' && d.name === 'exactOutputSingle') {
                  const side = lc(a.tokenOut) === lc(m.up) ? 'UP' : 'DOWN'; const out = BigInt(a.amountOut);
                  addRow({ ...base, side, route: 'dual-buy', requested: stakeOf(side), filled: num(out), fill_price: price(prevBal.repo - nb.repo, out), error: errText('the completing leg') });
                } else if (g.kind === 'complex-buy' && T.label.startsWith('sell x')) acc.sale = nb.repo - prevBal.repo;
                else if (g.kind === 'complex-buy' && T.label.startsWith('buy ')) {
                  const k = own === 'UP' ? 'up' : 'down'; const filled = splitAmt + (nb[k] - prevBal[k]); const saleP = acc.sale !== null ? acc.sale : BigInt(T.P);
                  addRow({ ...base, side: own, route: 'complex-buy', requested: stakeOf(own), filled: num(filled), fill_price: price(splitAmt - saleP + (prevBal.repo - nb.repo), filled), error: errText(`the completing leg${acc.sale === null ? (T.boundP ? '; the sale landed before this recovery, its proceeds taken at its amountOutMinimum, a floor' : '; the sale landed before this recovery, its proceeds taken from the rebuilt approve') : ''}`) });
                } else if (g.kind === 'set-sell' && d.name === 'exactInputSingle') {
                  acc.set += nb.repo - prevBal.repo;
                  if (T.label.startsWith('sell q DOWN')) {
                    const q = BigInt(a.amountIn); const early = L > 3 ? BigInt(IF.parseTransaction({ data: g.txs[3].data }).args[0].amountOutMinimum) : 0n;
                    addRow({ ...base, side: 'set', route: 'set-sell', requested: stakeOf('set'), filled: num(q), fill_price: num(acc.set + early) / num(q), error: errText(`the completing sale${early ? '; the UP sale landed before this recovery, its proceeds taken at its amountOutMinimum, a floor' : ''}`) });
                  }
                } else if (g.kind === 'merge-arb' && d.name === 'exactOutputSingle') acc.ma += prevBal.repo - nb.repo;
                else if (g.kind === 'merge-arb' && d.name === 'mergePositions') {
                  const q = BigInt(d.args[2]); const early = g.txs.slice(0, L).reduce((s, u) => { const du = IF.parseTransaction({ data: u.data }); return du.name === 'exactOutputSingle' ? s + BigInt(du.args[0].amountInMaximum) : s; }, 0n);
                  addRow({ ...base, side: 'set', route: 'buy-and-merge', requested: stakeOf('set'), filled: num(q), fill_price: num(acc.ma + early) / num(q), error: errText(`the completing merge${early ? '; the legs bought before this recovery taken at their amountInMaximum, a ceiling' : ''}`) });
                }
              } else if (T.role === 'merge-back' && d.name === 'mergePositions') {
                const S = BigInt(d.args[2]);
                addRow({ ...base, side: 'set', route: 'buy-and-merge', requested: num(S), filled: num(S), fill_price: 0, error: errText('the merge-back of the split (exact)') });
              } else if (T.role === 'sell-exit' && d.name === 'exactInputSingle') {
                const amt = BigInt(a.amountIn);
                addRow({ ...base, side: T.side, route: 'sell-exit', requested: num(amt), filled: num(amt), fill_price: num(nb.repo - prevBal.repo) / num(amt), error: errText('the unwind sale of the stray leg') });
              }
              record(); prevBal = nb;
            }
            X.clockAdd(env, Date.now() - t0, batch.length);
            end(att.decision === 'complete' ? 'completed' : 'unwound', att.decision === 'complete' ? 'completed at fresh quotes, its floors cleared' : `${tried.join('; ')}; unwound (${att.decision})`);
          }
        }
      }
    }
  } catch (e) {
    const s = X.asStop(env.step, e);
    // a send of the batch that landed although the call stopped (settled Landed, or landed before a nonce check): its
    // effect is recorded and its row written from its signed calldata, so no later recovery repeats it
    const landedNow = (hash) => {
      const tr = att.txs[att.txs.length - 1]; if (!tr || tr.row || !g) return;
      let data = null; try { data = JSON.parse(ctx.readRel(tr.signer_input_file).toString('utf8')).calls[0].data; } catch (x) { data = null; }
      if (!data) return;
      if (!tr.tx_hash) recEffect(g, ef, tr, IF.parseTransaction({ data }));
      tr.tx_hash = tr.tx_hash || hash; tr.row = true;
      const rows = recCalldataRows(IF, plan, g, tr, data, tr.tx_hash, errText('amounts from the signed calldata (the batch stopped after this send landed)'));
      if (rows.length && !book.fills().runs.some((x) => lc(x.tx_hash || '') === lc(tr.tx_hash))) { book.addRows(rows); att.rows += rows.length; }
    };
    if (env.open) {
      try {
        const st = await X.settleNonce(env, book, env.open.n);
        const keepOpen = st.outcome === 'not-sent' && !env.pin && !st.foreign; // G section 8, Nonce pinning
        if (st.outcome === 'landed' || (st.outcome === 'not-sent' && !keepOpen)) book.settleInflight();
        if (st.outcome === 'pending' || keepOpen) { att.keep_aborted = true; att.pending_nonce = env.open.n; }
        if (st.outcome === 'landed' && st.receipt && st.receipt.success) landedNow(st.hash);
      } catch (x) { att.keep_aborted = true; att.pending_nonce = env.open.n; }
      env.open = null;
    }
    if (e && e.landed && e.landed.hash) landedNow(e.landed.hash);
    const lastTr = att.txs[att.txs.length - 1]; if (lastTr && lastTr.tx_hash && !lastTr.row) landedNow(lastTr.tx_hash);
    if (s.fields && s.fields.keep_aborted) att.keep_aborted = true;
    end('stopped', `the recovery batch stopped (${s.cause}): ${clip(s.notes, 400)}`); att.stop = { cause: s.cause, exit: s.exit };
  }
  record();
  return { group: gid, outcome: att.outcome, decision: att.decision, why: att.why, txs: att.txs.filter((t) => t.tx_hash).map((t) => t.tx_hash), rows: att.rows, keep_aborted: !!att.keep_aborted, pending_nonce: att.pending_nonce === undefined ? null : att.pending_nonce };
}

// The effect of one landed recovery send, kept in recovery.json so that no later recovery repeats it: the plan
// transactions it completed, the split merged back, the legs sold.
function recEffect(g, ef, t, d) {
  if (t.role === 'complete') { ef.completed_idx.push(t.plan_idx); if (g.kind === 'complex-buy' && t.plan_idx === 4 && d.name === 'approve') ef.approved_P = d.args[1].toString(); }
  else if (t.role === 'merge-back' && d.name === 'mergePositions') ef.merged_back = (BigInt(ef.merged_back || '0') + BigInt(d.args[2])).toString();
  else if (t.role === 'sell-exit' && d.name === 'exactInputSingle') { ef.sold = ef.sold || {}; ef.sold[t.side] = (BigInt(ef.sold[t.side] || '0') + BigInt(d.args[0].amountIn)).toString(); }
}
// The row of a landed recovery send from its signed calldata (no balance read): exact, or the calldata's own bound, said
// in error.
function recCalldataRows(IF, plan, g, t, data, hash, why) {
  const d = IF.parseTransaction({ data }); const base = { market: g.market, address: lc(g.address), slippage_vs_quote: 0, tx_hash: hash, status: 'filled' };
  if (t.role === 'complete') { const r = rowFromCalldata(IF, plan, g, { label: t.label }, data, hash, why); return r ? [r] : []; }
  if (t.role === 'merge-back' && d.name === 'mergePositions') { const S = BigInt(d.args[2]); return [{ ...base, side: 'set', route: 'buy-and-merge', requested: num(S), filled: num(S), fill_price: 0, error: `${why}: the merge-back of the split (exact)` }]; }
  if (t.role === 'sell-exit' && d.name === 'exactInputSingle') { const amt = BigInt(d.args[0].amountIn); return [{ ...base, side: t.side, route: 'sell-exit', requested: num(amt), filled: num(amt), fill_price: num(BigInt(d.args[0].amountOutMinimum)) / num(amt), error: `${why}: fill_price from amountOutMinimum, a floor` }]; }
  return [];
}
// The start-of-run repair (wake.cjs) of a recovery send that landed after its run stopped: matched in recovery.json on
// (nonce, calldata hash), its effect recorded and its row APPENDED from its signed calldata, never a row removed. null
// when it is no recovery send of this run-id.
function recoveryLate(ctx, rid, late, note) {
  if (!late || !late.input_hash) return null;
  const book = new X.Book(ctx.cfg, rid); if (!book.exists('recovery.json')) return null;
  const rec = recoveryRecord(book);
  const E = ctx.ethers(); const IF = new E.Interface(IF_SIGS);
  for (const [gid, r] of Object.entries(rec.groups || {})) for (const at of r.attempts || []) for (const t of at.txs || []) {
    if (t.nonce !== late.n || lc(t.calldata_hash || '') !== lc(late.input_hash)) continue;
    let data = null; try { data = JSON.parse(ctx.readRel(t.signer_input_file).toString('utf8')).calls[0].data; } catch (e) { data = null; }
    if (!data || lc(E.keccak256(data)) !== lc(late.input_hash)) return null;
    let rows = [];
    if (!t.tx_hash || !t.row) {
      const plan = book.readJson('g-plan.json', null); const g = plan ? (plan.groups || []).find((x) => x.id === gid) : null;
      r.effects = r.effects || { completed_idx: [], merged_back: '0', sold: {} };
      if (late.success && g) {
        if (!t.tx_hash) recEffect(g, r.effects, t, IF.parseTransaction({ data }));
        rows = recCalldataRows(IF, plan, g, t, data, late.hash, `${note}; a recovery send of group ${gid}`);
        if (rows.length && !book.fills().runs.some((x) => lc(x.tx_hash || '') === lc(late.hash))) book.addRows(rows); else rows = [];
        t.row = true;
      }
      t.tx_hash = late.hash;
      book.writeJson('recovery.json', rec);
    }
    return { group: gid, rows };
  }
  return null;
}

module.exports = { run, armRunIds, boundaryEval, repairPlanRows, simulateRemaining, recoverGroup, recoveryLate, recoverySettled, recoveryOf, RECOVERY_FINAL, RECOVERY_SETTLED, RECOVERABLE };
