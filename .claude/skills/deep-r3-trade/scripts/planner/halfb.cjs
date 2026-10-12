// planner/halfb.cjs - `planner halfb <run-id> [--send]`: Half B of I-setup.md I.2 section 2 for this run-id and every
// run-id of this arm holding fills: the session-2 work of steps/G-mint-and-trade.md sections 4 to 6, three levels in
// order, each level reading balances after the one below has landed:
//   level 1 (children): the child merge of complete sets a run-id holds (sized from that run's own fills.json, capped at
//                       the live balance; no leg is bought to complete one), and, for a child that has resolved, the
//                       redeem of every held leg (holder-wide, Invalid included);
//   level 2 (middles):  per unresolved middle the middle merge z_X = min(every repo token of X, middle-X Invalid); per
//                       resolved middle the redeem of the repo tokens of its SETTLED children (resolved, or not selected:
//                       payoutNumerators(middle, slot) = 0) plus its Invalid, at most 30 outcomes per redeem call;
//   level 3 (parent):   the parent merge y = min(A, B, C, parent Invalid) while the parent is open; its redeem once resolved.
// No sell-exit (autonomous mode holds to resolution). Each level's groups are simulated in eth_simulateV1 (G's windows when
// they must be) immediately before sending, policy-checked by the signer, then sent through exec-core: the same
// affordability gate, boundary re-read, nonce, hash, simulate and three-part gas checks, write-ahead and settlement as an
// entry send. A child merge's row goes to the run-id that holds the sets; holder-wide rows (middle and parent merges,
// redeems) go to the first run-id processed (today's when it holds fills). It also reads the answer watch and lists every
// held market that is decided but unreported (G section 6), and counts the run-ids against schedule.max_turns_run_ids.
//
// Modes. Inside the wrapper (its lock names this run-id): every level is built and sent. In a supervised session: without
// --send it builds, simulates and prints the next level that has work (halfb-plan.json, halfb-print.md) and sends nothing;
// with --send it rebuilds that level and sends it only if it equals the printed one (gate 4, one "yes" per batch),
// taking and releasing the lock. The redeem paths have run on mocks only: untested live.
//
// A group skipped for affordability, the time budget or a failed or refused simulation is a stop the skill defines (exit
// 3, cause affordability-skip, time-budget or stale-simulation), each skipped group named in notes (the wake copies them
// into wake-status.json). The summary's artifacts name every file written: halfb-plan.json, halfb-print.md and the
// simulation files in the record run's folder (record_run, the first run-id processed, which may be an earlier one), the
// signer-input files halfb-tx/ in each group's book folder.
'use strict';

const lib = require('./lib.cjs');
const TB = require('./table.cjs');
const G = require('./g-lib.cjs');
const X = require('./exec-core.cjs');
const EX = require('./exec.cjs');

const { Stop, EXIT, clip } = lib;
const { lc, toWei, weiStr, num } = X;
const STEP = 'B';
const MAX_OUTCOMES_PER_BATCH = 30; // G section 6
const RESERVE_MS = 10 * 60 * 1000;
const A = { sUSDS: lc(TB.ADDR.sUSDS), ROUTER: TB.ADDR.ROUTER, CTF: TB.ADDR.CTF, REALITY: TB.ADDR.REALITY, MC3: TB.ADDR.MC3, PARENT: lc(TB.ADDR.PARENT), PARENT_INVALID: TB.ADDR.PARENT_INVALID };
const XS = TB.T.bundles.map((b) => b.name);
const BUN = Object.fromEntries(TB.T.bundles.map((b) => [b.name, b]));
const ROW = new Map(TB.T.rows.map((r) => [r.address, r]));
const MIDDLES = new Set(TB.T.bundles.map((b) => lc(b.middle)));
const SIG = {
  approve: 'approve(address,uint256)',
  merge: 'mergePositions(address,address,uint256)',
  redeem: 'redeemPositions(address,address,uint256[],uint256[])',
};
const stop = (kind, notes, fields) => X.xstop(STEP, kind, notes, fields);
// I-setup.md I.2 section 6: an unsettled inflight.json makes ANY prior run-id not final, whatever its wake-status says,
// because Half B writes its write-ahead records into prior run-ids (a child merge into the run that holds the sets, a
// holder-wide merge or redeem into the record run); the start-of-run repair then settles it and re-finalizes it.
const isFinalRun = (ctx, d) => {
  if (ctx.existsRel(`run/${d}/inflight.json`)) return false;
  if (ctx.existsRel(`run/${d}/wake-status.json`)) { try { const w = JSON.parse(ctx.readRel(`run/${d}/wake-status.json`).toString('utf8')); return w.status !== 'aborted' || /repaired by/i.test(String(w.notes || '')); } catch (e) { return false; } }
  return true;
};

// This run's own holding of a child's DOWN, UP and child Invalid, from its fills.json alone (G section 4): never the
// holder's balance, which other run-ids share. A redeem row is ignored (it converts at the realised payout, which H
// counts from the balance); a merge-arb's own merge row consumes another run's Invalid, not this one's.
function ownChild(F, alloc, addr, invToken) {
  const own = { down: 0n, up: 0n, inv: 0n };
  const mergeArb = (alloc && alloc.positions || []).some((p) => lc(p.address) === addr && p.side === 'set' && p.route === 'merge-arb');
  const key = { DOWN: 'down', UP: 'up' };
  for (const r of F.runs || []) {
    if (lc(r.address) !== addr || !['filled', 'partial'].includes(r.status)) continue;
    const f = toWei(r.filled || 0);
    if (key[r.side] && ['simple-buy', 'complex-buy', 'dual-buy'].includes(r.route)) own[key[r.side]] += f;
    else if (key[r.side] && r.route === 'sell-exit') own[key[r.side]] -= f;
    else if (key[r.side] && r.route === 'buy-and-merge') own[key[r.side]] += f;
    else if (r.side === 'set' && r.route === 'buy-and-merge' && !mergeArb) { own.down -= f; own.up -= f; own.inv -= f; }
    else if (r.side === 'Invalid' && r.route === 'buy-and-merge') own.inv -= f;
  }
  for (const l of F.retained_legs || []) if (lc(l.token) === lc(invToken)) own.inv += toWei(l.amount || 0);
  for (const k of Object.keys(own)) if (own[k] < 0n) own[k] = 0n;
  return own;
}

// ---------------------------------------------------------------------------------------------------------------
// the reads: every held child, the middles and the parent, the answer watch, the balances
// ---------------------------------------------------------------------------------------------------------------
async function readWorld(env, held) {
  const kids = [...held];
  const r1 = [];
  kids.forEach((a) => r1.push({ to: a, signature: 'wrappedOutcome(uint256)(address)', args: ['0'] }, { to: a, signature: 'wrappedOutcome(uint256)(address)', args: ['1'] }, { to: a, signature: 'wrappedOutcome(uint256)(address)', args: ['2'] }, { to: a, signature: 'conditionId()(bytes32)' }, { to: a, signature: 'questionsIds()(bytes32[])' }));
  const tops = [...XS.map((x) => lc(BUN[x].middle)), A.PARENT];
  tops.forEach((a) => r1.push({ to: a, signature: 'conditionId()(bytes32)' }, { to: a, signature: 'questionsIds()(bytes32[])' }));
  const o1 = (await env.mcChunked(r1, 400)).results;
  const W = { kids: {}, middles: {}, parent: null, questions: [] };
  kids.forEach((a, k) => { const b = 5 * k; W.kids[a] = { addr: a, row: ROW.get(a), down: lc(o1[b][0]), up: lc(o1[b + 1][0]), inv: lc(o1[b + 2][0]), cond: o1[b + 3][0], qids: o1[b + 4][0] }; });
  const off = 5 * kids.length;
  XS.forEach((x, k) => { W.middles[x] = { x, addr: lc(BUN[x].middle), cond: o1[off + 2 * k][0], qids: o1[off + 2 * k + 1][0] }; });
  W.parent = { addr: A.PARENT, cond: o1[off + 6][0], qids: o1[off + 7][0] };
  if (lc(W.parent.cond) !== lc(TB.CONDITIONS.parent) || XS.some((x) => lc(W.middles[x].cond) !== lc(TB.CONDITIONS[x]))) throw stop('identity', 'a middle or the parent conditionId differs from the skill\'s constants');
  // payouts, the Reality fields of every question, the balances, the block timestamp: one pass
  const r2 = []; const ix = {};
  const pd = (c) => ({ to: A.CTF, signature: 'payoutDenominator(bytes32)(uint256)', args: [c] });
  const pn = (c, i) => ({ to: A.CTF, signature: 'payoutNumerators(bytes32,uint256)(uint256)', args: [c, String(i)] });
  ix.kid = r2.length; kids.forEach((a) => { const c = W.kids[a].cond; r2.push(pd(c), pn(c, 0), pn(c, 1), pn(c, 2)); });
  ix.mid = r2.length; XS.forEach((x) => { const m = W.middles[x]; r2.push(pd(m.cond)); for (let s = 0; s <= BUN[x].nRepos; s++) r2.push(pn(m.cond, s)); });
  ix.par = r2.length; r2.push(pd(W.parent.cond)); for (let s = 0; s < 4; s++) r2.push(pn(W.parent.cond, s));
  const qs = [];
  kids.forEach((a) => (W.kids[a].qids || []).slice(0, 1).forEach((q) => qs.push({ id: q, kind: 'child', market: W.kids[a].row ? W.kids[a].row.repo : a, addr: a })));
  XS.forEach((x) => (W.middles[x].qids || []).forEach((q) => qs.push({ id: q, kind: 'middle', market: 'middle ' + x, addr: W.middles[x].addr })));
  (W.parent.qids || []).forEach((q) => qs.push({ id: q, kind: 'parent', market: 'parent', addr: A.PARENT }));
  ix.q = r2.length; qs.forEach((q) => r2.push({ to: A.REALITY, signature: 'getBestAnswer(bytes32)(bytes32)', args: [q.id] }, { to: A.REALITY, signature: 'getBond(bytes32)(uint256)', args: [q.id] }, { to: A.REALITY, signature: 'getFinalizeTS(bytes32)(uint32)', args: [q.id] }, { to: A.REALITY, signature: 'isPendingArbitration(bytes32)(bool)', args: [q.id] }));
  ix.ts = r2.length; r2.push({ to: A.MC3, signature: 'getCurrentBlockTimestamp()(uint256)' });
  const o2 = await env.mcChunked(r2, 400); const v = o2.results;
  W.ts = Number(v[ix.ts][0]); W.block = o2.block;
  kids.forEach((a, k) => { const b = ix.kid + 4 * k; W.kids[a].payout = BigInt(v[b][0]); W.kids[a].num = [0, 1, 2].map((i) => BigInt(v[b + 1 + i][0])); });
  let p = ix.mid;
  XS.forEach((x) => { const m = W.middles[x]; m.payout = BigInt(v[p][0]); p++; m.num = []; for (let s = 0; s <= BUN[x].nRepos; s++) { m.num.push(BigInt(v[p][0])); p++; } });
  W.parent.payout = BigInt(v[ix.par][0]); W.parent.num = [0, 1, 2, 3].map((i) => BigInt(v[ix.par + 1 + i][0]));
  qs.forEach((q, k) => { const b = ix.q + 4 * k; q.best_answer = v[b][0]; q.bond = String(v[b + 1][0]); q.finalize_ts = Number(v[b + 2][0]); q.pending_arbitration = v[b + 3][0]; });
  W.questions = qs;
  return W;
}
async function readBalances(env, W) {
  const toks = new Set();
  Object.values(W.kids).forEach((k) => { toks.add(k.down); toks.add(k.up); toks.add(k.inv); });
  TB.T.rows.forEach((r) => toks.add(lc(r.repo_token)));
  XS.forEach((x) => { toks.add(lc(BUN[x].middleInvalid)); toks.add(lc(BUN[x].bundleToken)); });
  toks.add(lc(A.PARENT_INVALID)); toks.add(A.sUSDS);
  const list = [...toks];
  const o = await env.mcChunked(list.map((t) => ({ to: t, signature: 'balanceOf(address)(uint256)', args: [env.holder] })), 400);
  const bal = new Map(); list.forEach((t, k) => bal.set(t, BigInt(o.results[k][0])));
  return bal;
}
// the boundary a session-2 send needs: a merge while open (payoutDenominator 0, no arbitration, finalize_ts not past);
// a redeem once resolved (payoutDenominator not 0)
function boundaryOk(level, op, W) {
  const qs = W.questions.filter((q) => q.addr === level.addr);
  if (op === 'redeem') return level.payout !== 0n ? { ok: true } : { ok: false, why: 'payoutDenominator is 0: not resolved' };
  if (level.payout !== 0n) return { ok: false, why: `payoutDenominator ${level.payout}: resolved (redeem instead)` };
  for (const q of qs) { if (q.pending_arbitration !== false) return { ok: false, why: 'pending arbitration' }; if (q.finalize_ts !== 0 && q.finalize_ts <= W.ts) return { ok: false, why: `finalize_ts ${q.finalize_ts} is past: decided but unreported` }; }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// building one level's groups (calldata through the helper's encode; its keccak256 is the plan's hash)
// ---------------------------------------------------------------------------------------------------------------
async function encode(env, wctx, sig, args) {
  const argv = []; let k = 0;
  for (const a of args) { if (Array.isArray(a)) { const f = `halfb-tmp/arg-${process.pid}-${Date.now()}-${k++}.json`; wctx.writeRun(f, JSON.stringify(a)); argv.push(`@${wctx.rel(f)}`); } else argv.push(String(a)); }
  const e = await env.H(['encode', sig, ...argv]);
  return { to: null, data: e.calldata, calldata_keccak256: lc(e.keccak256) };
}
async function buildLevel(R, level) {
  const { env, W, bal } = R; const groups = [];
  const take = new Map(); const left = (t) => (bal.get(lc(t)) || 0n) - (take.get(lc(t)) || 0n); const use = (t, a) => take.set(lc(t), (take.get(lc(t)) || 0n) + a);
  const approve = async (tok, amt, label) => ({ ...(await encode(env, R.wctx, SIG.approve, [TB.ADDR.ROUTER, amt.toString()])), to: lc(tok), label });
  if (level === 1) {
    for (const d of R.order) {
      const F = R.fills[d]; if (!F) continue;
      for (const a of R.heldBy[d] || []) {
        const k = W.kids[a]; if (!k || !k.row) continue;
        if (!boundaryOk(k, 'merge', W).ok) continue;
        const own = ownChild(F, R.alloc[d], a, k.inv);
        let N = [own.down, own.up, own.inv, left(k.down), left(k.up), left(k.inv)].reduce((m, x) => (x < m ? x : m));
        if (N <= 0n) continue;
        use(k.down, N); use(k.up, N); use(k.inv, N);
        groups.push({ id: `child-merge:${k.row.repo}:${d}`, kind: 'child-merge', op: 'merge', levelRef: { type: 'kid', addr: a }, book: d, market: k.row.repo, address: a, amount: N,
          txs: [await approve(k.down, N, `approve DOWN -> Router (N)`), await approve(k.up, N, `approve UP -> Router (N)`), await approve(k.inv, N, `approve child Invalid -> Router (N)`), { ...(await encode(env, R.wctx, SIG.merge, [A.sUSDS, a, N.toString()])), to: lc(TB.ADDR.ROUTER), label: 'Router.mergePositions(sUSDS, child, N)' }] });
      }
    }
    for (const a of Object.keys(W.kids)) {
      const k = W.kids[a]; if (!k.row || k.payout === 0n) continue;
      const legs = [[0, k.down], [1, k.up], [2, k.inv]].map(([i, t]) => ({ i, t, amt: left(t) })).filter((l) => l.amt > 0n);
      if (!legs.length) continue;
      const txs = []; for (const l of legs) { txs.push(await approve(l.t, l.amt, `approve ${['DOWN', 'UP', 'Invalid'][l.i]} -> Router`)); use(l.t, l.amt); }
      txs.push({ ...(await encode(env, R.wctx, SIG.redeem, [A.sUSDS, a, legs.map((l) => String(l.i)), legs.map((l) => l.amt.toString())])), to: lc(TB.ADDR.ROUTER), label: 'Router.redeemPositions(sUSDS, child, held legs)' });
      groups.push({ id: `child-redeem:${k.row.repo}`, kind: 'child-redeem', op: 'redeem', levelRef: { type: 'kid', addr: a }, book: R.rec, market: k.row.repo, address: a, legs: legs.map((l) => ({ i: l.i, amt: l.amt, frac: k.payout ? Number(k.num[l.i] * 1000000n / k.payout) / 1e6 : 0 })), txs });
    }
  } else if (level === 2) {
    for (const x of XS) {
      const m = W.middles[x]; const b = BUN[x]; const repos = TB.T.rows.filter((r) => r.bundle === x);
      if (m.payout === 0n) {
        if (!boundaryOk(m, 'merge', W).ok) continue;
        const z = [...repos.map((r) => left(r.repo_token)), left(b.middleInvalid)].reduce((mm, v) => (v < mm ? v : mm));
        if (z <= 0n) continue;
        const txs = []; for (const r of repos) txs.push(await approve(r.repo_token, z, `approve repo ${r.repo} -> Router (z_X)`));
        txs.push(await approve(b.middleInvalid, z, `approve middle-${x} Invalid -> Router (z_X)`));
        txs.push({ ...(await encode(env, R.wctx, SIG.merge, [A.sUSDS, lc(b.middle), z.toString()])), to: lc(TB.ADDR.ROUTER), label: `Router.mergePositions(sUSDS, middle ${x}, z_X)` });
        repos.forEach((r) => use(r.repo_token, z)); use(b.middleInvalid, z);
        groups.push({ id: `middle-merge:${x}`, kind: 'middle-merge', op: 'merge', levelRef: { type: 'middle', x }, book: R.rec, market: lc(b.middle), address: lc(b.middle), amount: z, txs });
      } else {
        // redeem the repo tokens of settled children only (resolved, or not selected by the middle), plus its Invalid
        const outs = [];
        repos.forEach((r) => { const k = W.kids[r.address]; const settled = (k && k.payout !== 0n) || m.num[r.slot] === 0n; const amt = left(r.repo_token); if (settled && amt > 0n) outs.push({ i: r.slot, t: r.repo_token, amt }); });
        const ia = left(b.middleInvalid); if (ia > 0n) outs.push({ i: b.nRepos, t: b.middleInvalid, amt: ia });
        for (let c = 0; c < outs.length; c += MAX_OUTCOMES_PER_BATCH) {
          const chunk = outs.slice(c, c + MAX_OUTCOMES_PER_BATCH); const txs = [];
          for (const l of chunk) { txs.push(await approve(l.t, l.amt, `approve middle-${x} outcome ${l.i} -> Router`)); use(l.t, l.amt); }
          txs.push({ ...(await encode(env, R.wctx, SIG.redeem, [A.sUSDS, lc(b.middle), chunk.map((l) => String(l.i)), chunk.map((l) => l.amt.toString())])), to: lc(TB.ADDR.ROUTER), label: `Router.redeemPositions(sUSDS, middle ${x}, ${chunk.length} outcomes)` });
          groups.push({ id: `middle-redeem:${x}:${c / MAX_OUTCOMES_PER_BATCH}`, kind: 'middle-redeem', op: 'redeem', levelRef: { type: 'middle', x }, book: R.rec, market: lc(b.middle), address: lc(b.middle), legs: chunk.map((l) => ({ i: l.i, amt: l.amt, frac: Number(m.num[l.i] * 1000000n / m.payout) / 1e6 })), txs });
        }
      }
    }
  } else {
    const p = W.parent; const toks = [...XS.map((x) => BUN[x].bundleToken), A.PARENT_INVALID];
    if (p.payout === 0n) {
      if (boundaryOk(p, 'merge', W).ok) {
        const y = toks.map((t) => left(t)).reduce((mm, v) => (v < mm ? v : mm));
        if (y > 0n) {
          const txs = []; for (const t of toks) txs.push(await approve(t, y, `approve ${t === A.PARENT_INVALID ? 'parent Invalid' : 'bundle token'} -> Router (y)`));
          txs.push({ ...(await encode(env, R.wctx, SIG.merge, [A.sUSDS, A.PARENT, y.toString()])), to: lc(TB.ADDR.ROUTER), label: 'Router.mergePositions(sUSDS, parent, y)' });
          toks.forEach((t) => use(t, y));
          groups.push({ id: 'parent-merge', kind: 'parent-merge', op: 'merge', levelRef: { type: 'parent' }, book: R.rec, market: A.PARENT, address: A.PARENT, amount: y, txs });
        }
      }
    } else {
      const legs = toks.map((t, i) => ({ i, t, amt: left(t) })).filter((l) => l.amt > 0n);
      if (legs.length) {
        const txs = []; for (const l of legs) { txs.push(await approve(l.t, l.amt, `approve parent outcome ${l.i} -> Router`)); use(l.t, l.amt); }
        txs.push({ ...(await encode(env, R.wctx, SIG.redeem, [A.sUSDS, A.PARENT, legs.map((l) => String(l.i)), legs.map((l) => l.amt.toString())])), to: lc(TB.ADDR.ROUTER), label: 'Router.redeemPositions(sUSDS, parent, held legs)' });
        groups.push({ id: 'parent-redeem', kind: 'parent-redeem', op: 'redeem', levelRef: { type: 'parent' }, book: R.rec, market: A.PARENT, address: A.PARENT, legs: legs.map((l) => ({ i: l.i, amt: l.amt, frac: Number(p.num[l.i] * 1000000n / p.payout) / 1e6 })), txs });
      }
    }
  }
  return groups;
}

// simulate the level (one request, or windows), give every transaction its gas fields, its nonce and its signer file
async function prepareLevel(R, groups, level) {
  const nn = await R.env.H(['nonce', R.env.holder]);
  if (nn.latest !== nn.pending) throw stop('pending-transaction', `a transaction of the holder is pending (latest ${nn.latest}, pending ${nn.pending}); nothing of Half B is sent`, { keep_aborted: true });
  const io = { simulate: async (name, gs) => { R.wctx.writeRun(name, JSON.stringify(gs)); return R.env.H(['simulate', R.wctx.rel(name)]); } };
  const sim = await G.simulatePlan(R.wctx, io, groups, 0, `halfb-sim-l${level}`);
  const problems = [];
  for (const w of sim.windows) { const pb = G.pageProblems(w.page, { entries: w.groupIdx.length, count: w.groupIdx.reduce((s, gi) => s + groups[gi].txs.length, 0), pendingNonce: nn.pending }); if (pb.length) problems.push(`${w.file}: ${pb.join('; ')}`); }
  let k = 0;
  groups.forEach((g, gi) => g.txs.forEach((t) => {
    const row = sim.rows[k];
    t.idx = k; t.nonce_expected = nn.pending + k;
    if (row) { t.gas_used = Number(row[3]); t.max_used_gas = row[4] === null || row[4] === undefined ? null : Number(row[4]); t.gas_limit = String(row[5]); t.sim_status = row[2]; }
    k++;
  }));
  return { clean: problems.length === 0, problems, nonce: nn.pending, files: sim.windows.map((w) => w.file) };
}
function writeTxFiles(R, groups) {
  for (const g of groups) for (const t of g.txs) {
    const name = `halfb-tx/tx-n${t.nonce_expected}.json`;
    lib.writeArmFile(R.ctx.cfg, g.book, name, JSON.stringify({ calls: [{ to: t.to, data: t.data, value: '0' }], gasLimit: t.gas_limit }));
    t.signer_input_file = `run/${g.book}/${name}`;
  }
}
const planView = (groups) => groups.map((g) => ({ id: g.id, kind: g.kind, book: g.book, market: g.market, amount: g.amount === undefined ? null : g.amount.toString(), legs: g.legs ? g.legs.map((l) => ({ i: l.i, amt: l.amt.toString() })) : null, txs: g.txs.map((t) => ({ label: t.label, to: t.to, calldata_keccak256: t.calldata_keccak256, gas_used: t.gas_used, max_used_gas: t.max_used_gas, gas_limit: t.gas_limit, nonce: t.nonce_expected })) }));
const sameAsPrinted = (a, b) => JSON.stringify(a.map((g) => ({ ...g, txs: g.txs.map((t) => ({ label: t.label, to: t.to, calldata_keccak256: t.calldata_keccak256, nonce: t.nonce })) }))) === JSON.stringify(b.map((g) => ({ ...g, txs: g.txs.map((t) => ({ label: t.label, to: t.to, calldata_keccak256: t.calldata_keccak256, nonce: t.nonce })) })));

// rows of one confirmed group (G Output vocabulary: buy-and-merge for a merge, redeem for a redeem)
function rowsFor(g, hash) {
  const base = { slippage_vs_quote: 0, tx_hash: hash, status: 'filled', error: null };
  if (g.op === 'merge') return [{ market: g.market, address: g.address, side: 'set', route: 'buy-and-merge', requested: num(g.amount), filled: num(g.amount), fill_price: 0, ...base }];
  if (g.kind === 'child-redeem') return g.legs.map((l) => ({ market: g.market, address: g.address, side: ['DOWN', 'UP', 'Invalid'][l.i], route: 'redeem', requested: num(l.amt), filled: num(l.amt), fill_price: l.frac, ...base }));
  const tot = g.legs.reduce((s, l) => s + l.amt, 0n); const got = g.legs.reduce((s, l) => s + Number(weiStr(l.amt)) * l.frac, 0);
  return [{ market: g.market, address: g.address, side: 'set', route: 'redeem', requested: num(tot), filled: num(tot), fill_price: num(tot) > 0 ? got / num(tot) : 0, ...base }];
}

// send one level's groups (exec-core: affordability, boundary re-read, nonce, hash, simulate, gas check, write-ahead)
async function sendLevel(R, groups) {
  const out = { sent: [], skipped: [] };
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    // a skip names its kind (the stop cause run() raises: exit 3, README section 6) and the groups it covers
    const skipRest = (kind, why, extra = {}) => { out.skipInfo = { kind, why: clip(why, 400), ...extra }; for (const h of groups.slice(gi)) out.skipped.push({ id: h.id, why: clip(why, 400) }); };
    if (g.txs.some((t) => t.sim_status !== '0x1')) { skipRest('stale-simulation', `the level's simulation failed (or the signer's check refused a transaction) at or before ${g.id} (G section 8, A failing pre-send simulation)`); break; }
    const fit = X.groupFits(R.env, g.txs.length, R.deadlineMs);
    if (!fit.ok) { skipRest('time-budget', 'turn/time budget exhausted before this Half B step'); R.budgetExhausted = true; break; }
    const af = await X.affordability(R.env, g.txs);
    if (!af.ok) { skipRest('affordability', `affordability: ${af.text} (G section 8)`, { eth: af.eth.toString(), need: af.need.toString() }); break; }
    const book = R.books[g.book] || (R.books[g.book] = new X.Book(R.ctx.cfg, g.book));
    const t0 = Date.now(); let landed = 0;
    try {
      // the boundary of this level, read fresh, as it must be for the operation (a flip makes it stale)
      const W2 = await readWorld(R.env, g.levelRef.type === 'kid' ? new Set([g.levelRef.addr]) : new Set());
      const lvl = g.levelRef.type === 'kid' ? W2.kids[g.levelRef.addr] : g.levelRef.type === 'middle' ? W2.middles[g.levelRef.x] : W2.parent;
      const bo = boundaryOk(lvl, g.op, W2); if (!bo.ok) throw stop('stale-boundary', `${g.id}: ${bo.why} (G section 3: the batch is stale)`);
      for (const t of g.txs) {
        const ps = await X.presend(R.env, book, t, t.nonce_expected);
        const res = await X.broadcast(R.env, book, t, t.nonce_expected, ps.hash, { source: `halfb:${R.ctx.runId}`, group: g.id });
        t.hash = res.hash; landed++;
      }
      X.clockAdd(R.env, Date.now() - t0, g.txs.length);
      book.addRows(rowsFor(g, g.txs[g.txs.length - 1].hash));
      out.sent.push({ id: g.id, book: g.book, txs: g.txs.map((t) => t.hash) });
    } catch (e) {
      const s = X.asStop(STEP, e);
      if (R.env.open) {
        try {
          const st = await X.settleNonce(R.env, book, R.env.open.n);
          // a not-sent finding on a signer that cannot pin the nonce, with no foreign transaction at n, is no settlement
          // (G section 8, Nonce pinning): inflight.json stays in that run-id and the wake stays aborted
          const keepOpen = st.outcome === 'not-sent' && !R.env.pin && !st.foreign;
          if (st.outcome === 'landed' || (st.outcome === 'not-sent' && !keepOpen)) book.settleInflight();
          if (st.outcome === 'pending' || keepOpen) s.fields = { ...s.fields, keep_aborted: true };
        } catch (x) { s.fields = { ...s.fields, keep_aborted: true }; }
        R.env.open = null;
      }
      out.stop = { kind: s.cause, notes: s.notes, exit: s.exit, fields: s.fields, group: g.id, landed, half_done: landed > 0 ? { group: g.id, landed, of: g.txs.length, txs: g.txs.filter((t) => t.hash).map((t) => t.hash) } : null };
      for (const h of groups.slice(gi + 1)) out.skipped.push({ id: h.id, why: `not started: Half B stopped at ${g.id}: ${clip(s.cause, 80)}` });
      break;
    }
  }
  return out;
}

// the answer watch against the previous run's report.md (an HTML comment line the report writes), and the derived list
function previousWatch(ctx, arm) {
  for (const d of arm.slice().reverse()) {
    if (d === ctx.runId || !ctx.existsRel(`run/${d}/report.md`)) continue;
    try { const t = ctx.readRel(`run/${d}/report.md`).toString('utf8'); const m = /<!-- answer-watch: (\{.*\}) -->/.exec(t); if (m) return { run: d, data: JSON.parse(m[1]) }; } catch (e) { /* unreadable: no comparison */ }
  }
  return null;
}

async function run(ctx) {
  const holder = lc(ctx.holder());
  const setup = lib.readSetup(ctx.cfg);
  const env = X.makeEnv(ctx, { step: STEP, holder, setup });
  const lk = X.lockMode(ctx);
  // signer mode (b) is refused wherever Half B would send (inside the wrapper, or --send), before any read, lock or
  // signer call (exec-core); a supervised print sends nothing and is not refused
  if (lk.mode === 'wrapper' || ctx.opts.send === true) X.refuseSignerMode(STEP, setup);
  if (lk.mode === 'held') throw X.lockHeldStop(STEP, lk);
  const wrapper = lk.mode === 'wrapper';
  const live = wrapper ? lk.liveRuns : [];
  const notes = [];
  // this arm's run-ids that hold fills (I-setup.md I.2 section 2's filter)
  const arm = EX.armRunIds(ctx);
  const fills = {}; const alloc = {};
  for (const d of arm) {
    try { const F = JSON.parse(ctx.readRel(`run/${d}/fills.json`).toString('utf8')); if ((F.runs || []).some((r) => r.tx_hash && ['filled', 'partial'].includes(r.status))) { fills[d] = F; alloc[d] = JSON.parse(ctx.readRel(`run/${d}/allocation.json`).toString('utf8')); } } catch (e) { /* no fills.json */ }
  }
  const holding = Object.keys(fills).sort();
  const skippedLive = holding.filter((d) => live.includes(d));
  skippedLive.forEach((d) => notes.push(`skipped run ${d}: listed in run/${lib.LOCK_NAME}/live-runs.txt (a live supervised session); delete run/${d}/session-owner.json once that session is confirmed gone`));
  const notFinal = holding.filter((d) => d !== ctx.runId && !skippedLive.includes(d) && !isFinalRun(ctx, d));
  notFinal.forEach((d) => notes.push(`run ${d} is not final: no session-2 send until the start-of-run repair finalizes it`));
  const work = holding.filter((d) => !skippedLive.includes(d) && !notFinal.includes(d));
  const maxIds = setup && setup.schedule && Number(setup.schedule.max_turns_run_ids);
  const resize = Number.isFinite(maxIds) && holding.length > maxIds ? `RESIZE SCHEDULE: ${holding.length} run-ids vs max_turns_run_ids ${maxIds}` : null;
  if (resize) notes.unshift(resize);
  // every held child (of every holding run-id, for the answer watch)
  const heldBy = {};
  for (const d of holding) heldBy[d] = [...new Set((fills[d].runs || []).map((r) => lc(r.address)).filter((a) => ROW.has(a)))];
  const held = new Set(Object.values(heldBy).flat());
  const W = await readWorld(env, held);
  const bal = await readBalances(env, W);
  // the answer watch and decided-but-unreported (G section 6): reporting only
  const prev = previousWatch(ctx, arm);
  const watchNow = {}; W.questions.forEach((q) => { watchNow[q.id] = { kind: q.kind, market: q.market, best_answer: q.best_answer, bond: q.bond, finalize_ts: q.finalize_ts }; });
  const newAnswers = prev ? W.questions.filter((q) => { const o = prev.data.questions && prev.data.questions[q.id]; return !o || o.best_answer !== q.best_answer || o.bond !== q.bond || o.finalize_ts !== q.finalize_ts; }).filter((q) => q.bond !== '0' || q.finalize_ts !== 0).map((q) => ({ market: q.market, kind: q.kind, question: q.id, best_answer: q.best_answer, bond: q.bond, finalize_ts: q.finalize_ts })) : W.questions.filter((q) => q.bond !== '0' || q.finalize_ts !== 0).map((q) => ({ market: q.market, kind: q.kind, question: q.id, best_answer: q.best_answer, bond: q.bond, finalize_ts: q.finalize_ts }));
  const decided = [];
  const levelPayout = (q) => (q.kind === 'child' ? W.kids[q.addr].payout : q.kind === 'middle' ? Object.values(W.middles).find((m) => m.addr === q.addr).payout : W.parent.payout);
  W.questions.forEach((q) => { if (q.finalize_ts !== 0 && q.finalize_ts <= W.ts && levelPayout(q) === 0n) decided.push(`${q.market}: awaiting oracle resolve (an operator action outside this skill)`); });
  const settledKids = Object.values(W.kids).filter((k) => k.payout !== 0n).map((k) => k.row ? k.row.repo : k.addr);
  const order = [...(work.includes(ctx.runId) ? [ctx.runId] : []), ...work.filter((d) => d !== ctx.runId && (heldBy[d] || []).some((a) => W.kids[a] && W.kids[a].payout !== 0n)), ...work.filter((d) => d !== ctx.runId && !(heldBy[d] || []).some((a) => W.kids[a] && W.kids[a].payout !== 0n))];
  const rec = order[0] || null;
  const wctx = rec && rec !== ctx.runId ? lib.makeContext({ cfg: ctx.cfg, sub: 'halfb', runId: rec }) : ctx;
  const R = { ctx, env, W, bal, fills, alloc, heldBy, order, rec, wctx, books: {}, deadlineMs: null, budgetExhausted: false };
  // what bounds the merges now (G section 5): z_X per bundle with its scarcest token, and the parent's y
  const bOf = (t) => bal.get(lc(t)) || 0n;
  const merge_bounds = {};
  for (const x of XS) {
    const toks = [...TB.T.rows.filter((r) => r.bundle === x).map((r) => [r.repo, r.repo_token]), ['middle-' + x + ' Invalid', BUN[x].middleInvalid]];
    const lo = toks.reduce((m, t) => (bOf(t[1]) < bOf(m[1]) ? t : m));
    merge_bounds['z_' + x] = { z: weiStr(bOf(lo[1])), scarcest: lo[0], zero_balances: toks.filter((t) => bOf(t[1]) === 0n).length };
  }
  const pt = [...XS.map((x) => ['bundle ' + x, BUN[x].bundleToken]), ['parent Invalid', A.PARENT_INVALID]];
  const plo = pt.reduce((m, t) => (bOf(t[1]) < bOf(m[1]) ? t : m));
  merge_bounds.y = { y: weiStr(bOf(plo[1])), scarcest: plo[0] };
  if (wrapper) {
    env.lock = { mode: 'wrapper', taken: false, text: lk.text, owner: lk.owner };
    const tl = setup && setup.schedule && Number(setup.schedule.time_limit_hours); const st = Date.parse(lk.owner.started_at);
    R.deadlineMs = ctx.opts.deadlineMs || (Number.isFinite(tl) && tl > 0 && Number.isFinite(st) ? st + tl * 3600000 - RESERVE_MS : null);
    env.deadlineMs = R.deadlineMs;
  }
  const base = {
    mode: wrapper ? 'wrapper' : ctx.opts.send ? 'supervised-send' : 'supervised-print',
    run_ids_holding_fills: holding.length, processed: work, skipped_live: skippedLive, not_final: notFinal, record_run: rec,
    held_children: held.size, settled_children: settledKids, middles_resolved: XS.filter((x) => W.middles[x].payout !== 0n), parent_resolved: W.parent.payout !== 0n,
    answer_watch: { compared_with: prev ? prev.run : null, new_answers: newAnswers.slice(0, 30), questions: W.questions.length, read_at_block: W.block, timestamp: W.ts },
    decided_but_unreported: decided, resize_schedule: resize, merge_bounds_at_read: merge_bounds,
  };
  ctx.detail.answer_watch_state = watchNow;
  if (!rec) return { ...base, actionable: [], sent: [], skipped: [], notes, artifacts: [], nothing_actionable: true };

  // ---- the levels, in order; each level built from balances read after the one below landed
  const actionable = []; const sent = []; const skipped = []; let stopInfo = null; let skipInfo = null; const halfDone = [];
  // every file this invocation writes (README section 4): halfb-plan.json, halfb-print.md and the simulation files in the
  // record run's folder, run/<record_run>/; the signer-input files halfb-tx/ in each group's book folder
  const files = []; const txByBook = new Map();
  const addFile = (p) => { if (!files.includes(p)) files.push(p); };
  const artifacts = () => [...files, ...[...txByBook].map(([b, s]) => `run/${b}/halfb-tx/ (${s.size} file${s.size === 1 ? '' : 's'})`)];
  const writePrint = (level, view, prep) => {
    wctx.writeRunJson('halfb-plan.json', { built_at: lib.nowIso(), level, nonce: prep.nonce, invoked_as: ctx.runId, record_run: rec, groups: view }, { indent: 1 }); addFile(wctx.rel('halfb-plan.json'));
    wctx.writeRun('halfb-print.md', printLevel(level, view, prep, R)); addFile(wctx.rel('halfb-print.md'));
  };
  const doSend = wrapper || ctx.opts.send === true;
  if (doSend && ctx.opts.blockSends) notes.push(`Half B sends nothing: ${ctx.opts.blockSends}`);
  if (wrapper && !ctx.opts.blockSends) { const gp = X.gateProblems(setup); if (gp.length) { ctx.opts.blockSends = `the standing authorization is missing (I-setup.md I.2 section 1): ${gp.join('; ')}`; notes.push(`Half B sends nothing: ${ctx.opts.blockSends}`); } }
  if (!wrapper && doSend) X.takeLock(env, 'planner halfb (supervised send batch)');
  try {
    for (const level of [1, 2, 3]) {
      if (level > 1) R.bal = await readBalances(env, W);
      const groups = await buildLevel(R, level);
      if (!groups.length) continue;
      const prep = await prepareLevel(R, groups, level);
      prep.files.forEach(addFile);
      writeTxFiles(R, groups);
      for (const g of groups) { const s = txByBook.get(g.book) || new Set(); g.txs.forEach((tx) => s.add(tx.signer_input_file)); txByBook.set(g.book, s); }
      // the signer's policy-only check of every file before anything of the level is sent
      for (const g of groups) for (const t of g.txs) { const c = await X.signerRun(env, 'check', t.signer_input_file); if (!(c.exit === 0 && c.last && c.last.allowed === true)) { t.sim_status = 'refused'; notes.push(`signer check refused ${g.id} ${t.label}: ${clip(c.stdout, 160)}`); } }
      const view = planView(groups);
      actionable.push({ level, groups: view.map((g) => ({ id: g.id, kind: g.kind, book: g.book, txs: g.txs.length, amount: g.amount })), simulation_clean: prep.clean, problems: prep.problems.slice(0, 3) });
      if (!doSend || ctx.opts.blockSends) {
        if (!wrapper) writePrint(level, view, prep);
        break; // a supervised print stops at the first level with work: the next level is read after this one lands
      }
      if (!wrapper) {
        let printed = null; try { printed = wctx.readRunJson('halfb-plan.json'); } catch (e) { printed = null; }
        if (!printed || printed.level !== level || !sameAsPrinted(view, printed.groups)) {
          writePrint(level, view, prep);
          throw stop('changed-since-print', `the level-${level} batch differs from the one printed in halfb-plan.json (or none was printed): re-presented, nothing sent (gate 4)`);
        }
      }
      const r = await sendLevel(R, groups);
      sent.push(...r.sent); skipped.push(...r.skipped);
      if (r.stop) { stopInfo = r.stop; if (r.stop.half_done) halfDone.push(r.stop.half_done); break; }
      if (r.skipInfo) skipInfo = r.skipInfo;
      if (r.skipped.length) break;
      if (!wrapper) break; // supervised: one batch per "yes"
    }
  } catch (e) {
    // a stop met while building or before sending (a pending transaction, changed-since-print) still names what was written
    if (e instanceof Stop) e.fields = { ...e.fields, artifacts: artifacts() };
    throw e;
  } finally { X.releaseLock(env); }
  if (R.budgetExhausted) notes.push('turn/time budget exhausted');
  // a group skipped for affordability, the time budget or a failed or refused simulation is named in notes (the wake
  // copies them into wake-status.json) and is a stop the skill defines, exit 3 (G section 8, Affordability)
  if (!stopInfo && skipInfo) skipped.forEach((s) => notes.push(`Half B skipped ${s.id}: ${s.why}`));
  const res = { ...base, actionable, sent, skipped, half_done: halfDone, notes, artifacts: artifacts(), sends_this_invocation: env.sentThisInvocation, keep_aborted: !!(stopInfo && stopInfo.fields && stopInfo.fields.keep_aborted), budget_exhausted: R.budgetExhausted };
  if (stopInfo) throw new Stop({ step: STEP, cause: stopInfo.kind, status: 'aborted', notes: stopInfo.notes, exit: stopInfo.exit, fields: { ...res, half_b_stop: { kind: stopInfo.kind, group: stopInfo.group } } });
  if (skipInfo) {
    const cause = skipInfo.kind === 'affordability' ? 'affordability-skip' : skipInfo.kind === 'time-budget' ? 'time-budget' : 'stale-simulation';
    throw new Stop({ step: STEP, cause, status: null, notes: skipInfo.why, exit: EXIT.STOP, fields: { ...res, keep_aborted: false, skipped_groups: skipped.map((s) => s.id).slice(0, 20), skipped_count: skipped.length, ...(skipInfo.eth ? { eth: skipInfo.eth, need: skipInfo.need } : {}) } });
  }
  return res;
}

function printLevel(level, view, prep, R) {
  const L = [`# Half B, level ${level} - invoked as run ${R.ctx.runId}; written in run/${R.rec}/`, '', `This file and halfb-plan.json are in the record run's folder, run/${R.rec}/ (the first run-id processed); each group's signer-input files are in its book's folder, run/<book>/halfb-tx/. Built and simulated; nothing sent. Holder ${R.env.holder}, pending nonce ${prep.nonce}. Simulation: ${prep.clean ? 'clean' : 'NOT clean: ' + prep.problems.join('; ')}.`, ''];
  for (const g of view) {
    L.push(`- \`${g.id}\` (${g.kind}) recorded in run ${g.book}${g.amount ? `, amount ${weiStr(BigInt(g.amount))}` : ''}${g.legs ? `, legs ${g.legs.map((l) => `${l.i}:${weiStr(BigInt(l.amt))}`).join(' ')}` : ''}: ${g.txs.length} transaction(s)`);
    for (const t of g.txs) L.push(`  - nonce ${t.nonce}: ${t.label} -> ${t.to}, gas used ${t.gas_used}, limit ${t.gas_limit}`);
  }
  L.push('', 'Each batch needs its own "yes" (gate 4); `planner halfb <run-id> --send` sends this level only if a fresh rebuild equals it.');
  return L.join('\n') + '\n';
}

// The start-of-run repair (wake.cjs; I-setup.md I.2 section 6 (c)): a Half B transaction recorded in run-id rid that
// landed after its run stopped gets the rows rowsFor writes, from its signed calldata (halfb-tx/tx-n<n>.json in rid, the
// file it was sent from, its keccak256 equal to the attempt's calldata_hash); a redeem's payout fractions are read now
// (final once reported). An approve gets no row. null when the transaction is not a Half B send of this folder.
// late: { n, hash, input_hash, success }.
async function repairRows(ctx, env, rid, late, note) {
  const rel = `run/${rid}/halfb-tx/tx-n${late.n}.json`;
  if (!late.input_hash || !ctx.existsRel(rel)) return null;
  let data; try { data = JSON.parse(ctx.readRel(rel).toString('utf8')).calls[0].data; } catch (e) { return null; }
  const E = ctx.ethers(); if (lc(E.keccak256(data)) !== lc(late.input_hash)) return null;
  const IF = new E.Interface([`function ${SIG.merge}`, `function ${SIG.redeem}`]);
  let p = null; try { p = IF.parseTransaction({ data }); } catch (e) { p = null; }
  if (!p) return { rows: [] };
  const addr = lc(p.args[1]); const kid = ROW.get(addr);
  const g = { market: kid ? kid.repo : addr, address: addr, op: p.name === 'mergePositions' ? 'merge' : 'redeem', kind: kid ? 'child-redeem' : 'redeem' };
  if (g.op === 'merge') g.amount = BigInt(p.args[2]);
  else {
    const cond = (await env.mc([{ to: addr, signature: 'conditionId()(bytes32)' }])).results[0][0];
    const idx = Array.from(p.args[2], (x) => Number(x));
    const pr = (await env.mc([{ to: A.CTF, signature: 'payoutDenominator(bytes32)(uint256)', args: [cond] }, ...idx.map((i) => ({ to: A.CTF, signature: 'payoutNumerators(bytes32,uint256)(uint256)', args: [cond, String(i)] }))])).results;
    const den = BigInt(pr[0][0]);
    g.legs = idx.map((i, k) => ({ i, amt: BigInt(p.args[3][k]), frac: den ? Number(BigInt(pr[1 + k][0]) * 1000000n / den) / 1e6 : 0 }));
  }
  const how = late.success ? 'amounts from the signed calldata (exact)' : 'the receipt shows a revert';
  return { rows: rowsFor(g, late.hash).map((r) => ({ ...r, ...(late.success ? {} : { filled: 0, fill_price: 0, status: 'reverted' }), error: `${note}: ${how}` })) };
}

module.exports = { run, ownChild, isFinalRun, readWorld, repairRows, MAX_OUTCOMES_PER_BATCH };
