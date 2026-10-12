// planner/g-build.cjs - G's build (ported from the live g-build): the ordered entry sequence for allocation.json exactly as
// G-mint-and-trade.md sections 1 to 3 and 7 say, quoted on QuoterV2 through the helper, then simulated whole with the
// helper's grouped simulate (one blockStateCalls entry per keep-whole group; windows only when the request must be cut).
// NOTHING IS SIGNED OR SENT.
//
// What the live script assumed and this one does not: a fresh holder (here every balance read is the start state; a
// held repo token is that market's budget, F step 6), a nonzero mint (no parent split when M = 0, no middle split when
// m_X = 0), one market with a set row and an UP/DOWN row (here any number, each probed on the state its own set group
// leaves), a dual-buy band never cut by the budget (here inMax = min(stake x 1.005, remaining), G section 3), and a row
// F should have dropped (here a row under VOLUME_MIN is skipped with its reason, a pair as a unit, G section 3).
//
// A set row routed merge-arb (F step 3a) is G section 3's buy-and-merge group: q = stake / quoted_fill (the count rule),
// clamped at the live child Invalid (a clamp of a few wei is rounding; a larger shortfall makes the plan stale: G section
// 1); amountInMaximum = quoted_in_leg x min(q / quoted_cost, 1.005); [approve the repo token to SwapRouter02 for both
// maxIn, buy q UP and q DOWN by exactOutputSingle, approve UP, DOWN and child Invalid to the Router, mergePositions q].
// Its q returned repo tokens are what the market has left for the rows after it; a pair after a merge-arb (its 3b
// remainder) is quoted on the state the merge-arb group leaves, by the return probe (exact-output quotes).
//
// A failing simulation (G section 8, A failing pre-send simulation) stops G with stale_simulation and the index of the
// first failing group. The wake's once-only re-plan (I-setup.md I.2 section 5 item 3) then re-runs F and G with
// cutAtFailure; when the rebuilt plan fails again, g.cjs rebuilds it with R.cutAt = that index: the groups before it
// stay sendable, and the failing group and every later one become skipped rows (the reason in error).
'use strict';

const lib = require('./lib.cjs');
const G = require('./g-lib.cjs');

const { clip } = lib;
const { A, gstop, gsafety, toWei, countWei, ceilDiv, weiStr: fmt, minB } = G;

async function build(R) {
  const { ctx, io, S, E } = R;
  const say = (s) => ctx.log(s);
  const holder = S.holder;
  const Bd = G.builders(E, holder);
  const I = G.ifaces(E);
  const side = (m, s) => (s === 'UP' ? m.up : m.down);

  const cutAt = Number.isInteger(R.cutAt) ? R.cutAt : null;
  const cutWhy = cutAt === null ? null : `the rebuilt plan's pre-send simulation failed again at group ${R.cutAt} (${R.cutGroupId || 'unnamed'}): this group and every later one are skipped (G section 8, A failing pre-send simulation)`;
  const head = await io.H(['block', 'latest']);
  await G.checkNonce(io, holder, S.nonce.pending, 'G build');
  say(`build at live head ${head.number}; holder nonce unchanged (${S.nonce.pending})`);

  // ---------- 1. the mint: M = totals.staked; m_X = M + b_X for each bundle with a position (G section 1) ----------
  const M = toWei(S.totals.staked);
  if (M > S.balances.sUSDS) throw gstop('stale-susds', `the holder's sUSDS ${fmt(S.balances.sUSDS)} is below totals.staked ${fmt(M)}: the plan is stale, re-run F (never resize the mint)`);
  const bX = {}; G.XS.forEach((x) => { bX[x] = S.balances['bundle' + x]; });
  const mX = {}; S.bundlesWithPosition.forEach((x) => { mX[x] = M + bX[x]; });
  const markets = S.markets;
  for (const m of markets) { m.held = S.balances['repo:' + m.name]; m.avail = m.held + (mX[m.bundle] || 0n); }

  // ---------- 2. refusals: rows F should not have written; a pair is refused as a unit (G section 3) ----------
  const skippedRows = S.refused.map((r) => ({ ...r }));
  const skipRow = (m, s, reason) => { const r = m.rows[s]; skippedRows.push({ market: m.name, address: m.addr, side: s, route: r.route, stake: r.stake, reason }); delete m.rows[s]; };
  for (const m of markets) {
    const refusedLeg = S.refused.some((r) => r.address === m.addr && (r.side === 'UP' || r.side === 'DOWN'));
    for (const s of Object.keys(m.rows)) if (!(m.rows[s].stake >= G.VOLUME_MIN)) skipRow(m, s, `VOLUME_MIN: ${s === 'set' ? 'q' : 'stake'} ${m.rows[s].stake} is below ${G.VOLUME_MIN} repo tokens (F should have dropped it)`);
    const legs = ['UP', 'DOWN'].filter((s) => m.rows[s]);
    const pairBroken = skippedRows.some((r) => r.address === m.addr && (r.side === 'UP' || r.side === 'DOWN') && r.reason.startsWith('VOLUME_MIN')) || refusedLeg;
    if (pairBroken) for (const s of legs) skipRow(m, s, 'refused with the other UP/DOWN row of this market: a pair is refused as a unit, and a surviving leg is never routed as a one-side market (G section 1)');
  }
  const tm = markets.filter((m) => Object.keys(m.rows).length);
  if (skippedRows.length) say(`rows skipped: ${skippedRows.length} (${clip(skippedRows.map((r) => `${r.market} ${r.side}: ${r.reason}`).join('; '), 600)})`);

  // ---------- 3. the route of each UP/DOWN position, from the FRESH slot0 sum (G section 3) ----------
  for (const m of tm) {
    m.set = m.rows.set || null; m.dirSides = ['UP', 'DOWN'].filter((s) => m.rows[s]);
    m.sum = m.spot.sum;
    m.dirRoute = m.dirSides.length === 2 ? 'dual-buy' : m.dirSides.length === 1 ? (m.sum > 1 ? 'complex-buy' : 'simple-buy') : null;
    m.postMA = !!(m.set && m.set.route === 'merge-arb');
    if (m.set && !m.postMA && m.dirRoute === 'dual-buy') throw gstop('unsupported-shape', `${m.name} carries a set-sell row and a pair: F never writes both (set-sell needs sum > 1/(1-f), a pair sum < 1-f)`);
    if (m.dirRoute === 'dual-buy' && m.sum >= 1) say(`NOTE dual-buy market ${m.name} whose fresh spot sum is ${m.sum} >= 1: still dual-buy (G section 3)`);
  }
  const mix = {}; tm.forEach((m) => { const k = (m.set ? m.set.route + '+' : '') + (m.dirRoute || '-'); mix[k] = (mix[k] || 0) + 1; });
  const closest = tm.map((m) => [Math.abs(m.sum - 1), m.name, m.sum]).sort((a, b) => a[0] - b[0]).slice(0, 3);
  say(`route mix from fresh slot0: ${JSON.stringify(mix)}; closest sums to 1: ${closest.map((c) => c[1] + ' ' + c[2].toFixed(6)).join(', ')}`);

  // ---------- 4. phase-A quotes on the current pools (QuoterV2 through the helper) ----------
  const reqs = []; const key = [];
  const addQ = (k, r) => { key.push(k); reqs.push(r); };
  for (const m of tm) {
    if (m.set && m.postMA) {
      // merge-arb: q = stake / quoted_fill, clamped at the live child Invalid (G section 1 and section 3, q is wei-exact)
      const q0 = countWei(m.set.stake, m.set.quoted_fill); const Ij = S.balances['Inv:' + m.name] || 0n;
      if (q0 > Ij && (q0 - Ij) * 10n ** 12n > q0) throw gstop('stale-invalid', `${m.name}: the held child Invalid ${fmt(Ij)} is below the merge-arb's q ${fmt(q0)}: the plan is stale, rebuild from F (never resize)`);
      m.q = q0 > Ij ? Ij : q0; m.Ij = Ij;
      addQ('maUP:' + m.addr, { kind: 'out', tokenIn: m.repo, tokenOut: m.up, amt: m.q, fee: m.fee.UP });
      addQ('maDOWN:' + m.addr, { kind: 'out', tokenIn: m.repo, tokenOut: m.down, amt: m.q, fee: m.fee.DOWN });
    } else if (m.set) {
      m.q = toWei(m.set.stake);
      addQ('setUP:' + m.addr, { kind: 'in', tokenIn: m.up, tokenOut: m.repo, amt: m.q, fee: m.fee.UP });
      addQ('setDOWN:' + m.addr, { kind: 'in', tokenIn: m.down, tokenOut: m.repo, amt: m.q, fee: m.fee.DOWN });
    }
    if (m.dirRoute === 'simple-buy' || m.dirRoute === 'complex-buy') {
      m.s = m.dirSides[0]; m.o = m.s === 'UP' ? 'DOWN' : 'UP'; m.x = toWei(m.rows[m.s].stake);
      if (!m.set) {
        if (m.dirRoute === 'simple-buy') addQ('simple:' + m.addr, { kind: 'in', tokenIn: m.repo, tokenOut: side(m, m.s), amt: m.x, fee: m.fee[m.s] });
        else addQ('cxsell:' + m.addr, { kind: 'in', tokenIn: side(m, m.o), tokenOut: m.repo, amt: m.x, fee: m.fee[m.o] });
      }
    }
    if (m.dirRoute === 'dual-buy') {
      m.cnt = {}; m.sw = {};
      // after a merge-arb the legs are quoted on the state its group leaves (step 7's probe), never on the live pools
      for (const s of ['UP', 'DOWN']) { const r = m.rows[s]; m.sw[s] = toWei(r.stake); m.cnt[s] = countWei(r.stake, r.quoted_fill); if (!m.postMA) addQ('dual' + s + ':' + m.addr, { kind: 'out', tokenIn: m.repo, tokenOut: side(m, s), amt: m.cnt[s], fee: m.fee[s] }); }
      m.qpair = m.cnt.UP < m.cnt.DOWN ? m.cnt.UP : m.cnt.DOWN;
    }
  }
  const qa = await io.quotes(reqs); const QA = new Map(); const bad = [];
  qa.forEach((r, k) => { if (!r.ok) bad.push(key[k] + (r.reverted ? ' (revert)' : ` (partial, ticks crossed ${r.ticks})`)); else QA.set(key[k], r); });
  say(`phase A: ${reqs.length} QuoterV2 quotes through the helper multicall; failures ${bad.length}${bad.length ? ' ' + bad.slice(0, 8).join(', ') : ''}`);
  if (bad.length) throw gstop('stale-quote', `a quote failed or crossed an initialized tick (${clip(bad.join(', '), 400)}): the plan is stale, rebuild from F`);
  // complex-buy without a set row, phase B: the buy leg quoted at the quoted sale proceeds P
  const reqB = []; const keyB = [];
  for (const m of tm) if (m.dirRoute === 'complex-buy' && !m.set) { m.P = QA.get('cxsell:' + m.addr).amt; keyB.push('cxbuy:' + m.addr); reqB.push({ kind: 'in', tokenIn: m.repo, tokenOut: side(m, m.s), amt: m.P, fee: m.fee[m.s] }); }
  const qb = await io.quotes(reqB); const QB = new Map();
  qb.forEach((r, k) => { if (!r.ok) throw gstop('stale-quote', `phase B quote failed: ${keyB[k]}`); QB.set(keyB[k], r); });
  say(`phase B: ${reqB.length} complex-buy buy-leg quotes at the quoted sale proceeds`);
  R.quoteBlocks = { A: qa.map((r, k) => ({ key: key[k], block: r.block })), B: qb.map((r, k) => ({ key: keyB[k], block: r.block })) };
  R.quoteReqs = { A: reqs.map((r, k) => ({ key: key[k], ...r, res: qa[k] })), B: reqB.map((r, k) => ({ key: keyB[k], ...r, res: qb[k] })) };

  // ---------- 5. mint groups: no zero split (G section 1) ----------
  const groups = [];
  if (M > 0n) groups.push({ id: 'mint-parent', kind: 'mint', market: 'PARENT-MINT', address: A.PARENT, txs: [Bd.approve(A.sUSDS, A.ROUTER, M, 'approve sUSDS -> Router (M)'), Bd.split(A.PARENT, M, 'Router.splitPosition(sUSDS, parent, M)')] });
  for (const x of G.XS) {
    if (mX[x] === undefined || mX[x] === 0n) continue;
    groups.push({ id: 'mint-middle-' + x, kind: 'mint', market: G.MIDDLES[x], address: G.MIDDLES[x], txs: [Bd.approve(G.BUNDLES[x], A.ROUTER, mX[x], `approve bundle ${x} -> Router (m_X)`), Bd.split(G.MIDDLES[x], mX[x], `Router.splitPosition(sUSDS, middle ${x}, m_X)`)] });
  }
  const mintGroups = groups.slice(); const nMint = mintGroups.length;
  say(`mint: M ${fmt(M)}; b_X ${G.XS.map((x) => fmt(bX[x])).join('/')}; ${nMint ? mintGroups.map((g) => g.id).join(', ') : 'no split (M = 0 and no bundle token held for a bundle with a position)'}`);

  // ---------- 6. set-sell groups with the no-loss floors (G section 3) ----------
  const setGroup = (m) => {
    const qu = QA.get('setUP:' + m.addr).amt; const qd = QA.get('setDOWN:' + m.addr).amt; const qp = qu + qd; const q = m.q;
    if (qp <= q) throw gstop('stale-quote', `${m.name}: the set-sell proceeds ${fmt(qp)} do not clear q ${fmt(q)}: the plan is stale`);
    const minFor = (ql) => { const a = ceilDiv(ql * q, qp); const b = ceilDiv(ql * 9950n, 10000n); return a > b ? a : b; }; // ceil(quoted_leg x max(q/qp, 0.995))
    const minUP = minFor(qu); const minDOWN = minFor(qd);
    if (minUP + minDOWN < q) throw gstop('internal-floor', `${m.name}: the set-sell floors sum below q`);
    m.setInfo = { q, quoted_up: qu, quoted_down: qd, proceeds: qp, gain: qp - q, minUP, minDOWN, sqrtAfterUP: QA.get('setUP:' + m.addr).sqrtAfter, sqrtAfterDOWN: QA.get('setDOWN:' + m.addr).sqrtAfter };
    return { id: 'set-sell:' + m.name, kind: 'set-sell', market: m.name, address: m.addr, rows: [{ side: 'set', stake: m.set.stake, quoted_fill: m.set.quoted_fill, p_win: m.set.p_win }], txs: [
      Bd.approve(m.repo, A.ROUTER, q, 'approve repo -> Router (q)'), Bd.split(m.addr, q, 'Router.splitPosition(sUSDS, child, q)'),
      Bd.approve(m.up, A.SWAP, q, 'approve UP -> SwapRouter02 (q)'), Bd.exIn(m.up, m.repo, m.fee.UP, q, minUP, qu, 'sell q UP -> repo (floor)'),
      Bd.approve(m.down, A.SWAP, q, 'approve DOWN -> SwapRouter02 (q)'), Bd.exIn(m.down, m.repo, m.fee.DOWN, q, minDOWN, qd, 'sell q DOWN -> repo (floor)')] };
  };
  // merge-arb groups (G section 3): amountInMaximum = quoted_in_leg x min(q / quoted_cost, 1.005), each floored
  const maGroup = (m) => {
    const qu = QA.get('maUP:' + m.addr); const qd = QA.get('maDOWN:' + m.addr); const cost = qu.amt + qd.amt; const q = m.q;
    if (cost >= q) throw gstop('stale-quote', `${m.name}: the merge-arb cost ${fmt(cost)} of q ${fmt(q)} pairs is not below q: the plan is stale`);
    const maxFor = (ql) => { const a = ql * q / cost; const b = ql * 10050n / 10000n; return a < b ? a : b; };
    const maxUP = maxFor(qu.amt); const maxDOWN = maxFor(qd.amt);
    m.setInfo = { route: 'merge-arb', q, Ij: m.Ij, quoted_up: qu.amt, quoted_down: qd.amt, cost, gain: q - cost, maxUP, maxDOWN, sqrtAfterUP: qu.sqrtAfter, sqrtAfterDOWN: qd.sqrtAfter };
    return { id: 'merge-arb:' + m.name, kind: 'merge-arb', market: m.name, address: m.addr, rows: [{ side: 'set', stake: m.set.stake, quoted_fill: m.set.quoted_fill, p_win: m.set.p_win }], txs: [
      Bd.approve(m.repo, A.SWAP, maxUP + maxDOWN, 'approve repo -> SwapRouter02 (maxIn UP + maxIn DOWN)'),
      Bd.exOut(m.repo, m.up, m.fee.UP, q, maxUP, qu.amt, 'buy q UP (exactOutput, merge-arb)'), Bd.exOut(m.repo, m.down, m.fee.DOWN, q, maxDOWN, qd.amt, 'buy q DOWN (exactOutput, merge-arb)'),
      Bd.approve(m.up, A.ROUTER, q, 'approve UP -> Router (q)'), Bd.approve(m.down, A.ROUTER, q, 'approve DOWN -> Router (q)'), Bd.approve(m.inv, A.ROUTER, q, 'approve child Invalid -> Router (q)'),
      Bd.merge(m.addr, q, 'Router.mergePositions(sUSDS, child, q)')] };
  };
  for (const m of tm) if (m.set) m.setGroupObj = m.postMA ? maGroup(m) : setGroup(m);

  // ---------- 7. a market with a set row AND an UP/DOWN row: quote the UP/DOWN leg on the state its set group leaves ----------
  // (the helper's "return" probe: [the mint groups it depends on, its set group, one group holding the flagged quote])
  const setDir = tm.filter((m) => m.set && m.dirRoute);
  const agreement = [];
  let probeSeq = 0;
  // kind 'in' (quoteExactInputSingle) or 'out' (quoteExactOutputSingle, a pair leg after a merge-arb); the merge-arb
  // group's own flagged-return calls are none, so the quote is the page's only return
  const probeQuote = async (m, label, tIn, tOut, fee, amt, kind = 'in') => {
    const prefix = mintGroups.filter((g) => g.id === 'mint-parent' || g.id === 'mint-middle-' + m.bundle).concat([m.setGroupObj]);
    const name = `g-tmp/probe-${++probeSeq}.json`;
    let page;
    try { page = await io.simulate(name, G.simGroups(prefix.concat([{ txs: [{ to: A.QUOTER, data: kind === 'out' ? Bd.qOut(tIn, tOut, fee, amt) : Bd.qIn(tIn, tOut, fee, amt), label, ret: true }] }]))); } finally { try { ctx.removeRun(name); } catch (e) { /* scratch */ } }
    if (page.all_success !== true || page.overrides_active || !Array.isArray(page.returns) || page.returns.length !== 1) throw gstop('probe-failed', `${m.name}: the probe "${label}" on the post-${m.set.route} state did not run cleanly (${clip(JSON.stringify({ all_success: page.all_success, failures: page.failures, overrides: page.overrides_active }), 400)}): the plan is stale`);
    const d = I.quoter.decodeFunctionResult(kind === 'out' ? 'quoteExactOutputSingle' : 'quoteExactInputSingle', page.returns[0].return_data);
    if (Number(d[2]) !== 0) throw gstop('stale-quote', `${m.name}: the probe "${label}" crossed an initialized tick`);
    return { amt: BigInt(d[0]), sqrtAfter: BigInt(d[1]) };
  };
  for (const m of setDir) {
    if (cutAt !== null && cutAt <= nMint) break; // every trade group is cut: nothing to probe
    const pUp = G.spotOf(m.setInfo.sqrtAfterUP, m.slot0.UP.T0); const pDn = G.spotOf(m.setInfo.sqrtAfterDOWN, m.slot0.DOWN.T0);
    m.postSetSum = pUp + pDn; m.postRoute = m.dirRoute === 'dual-buy' ? 'dual-buy' : m.postSetSum > 1 ? 'complex-buy' : 'simple-buy';
    agreement.push({ market: m.name, set_route: m.set.route, fresh_spot_sum: m.sum, post_set_sell_sum: m.postSetSum, fresh_route: m.dirRoute, post_set_route: m.postRoute, agree: m.postRoute === m.dirRoute });
    if (m.dirRoute === 'dual-buy') {
      // the 3b remainder after a merge-arb: each leg's count quoted by exact output on the post-merge-arb state
      for (const s of ['UP', 'DOWN']) { const p = await probeQuote(m, `probe quote: buy count ${s} (exactOutput)`, m.repo, side(m, s), m.fee[s], m.cnt[s], 'out'); QA.set('dual' + s + ':' + m.addr, { ...p, ok: true }); }
      say(`post-merge-arb probe (${m.name}): the pair's legs cost ${fmt(QA.get('dualUP:' + m.addr).amt)} UP + ${fmt(QA.get('dualDOWN:' + m.addr).amt)} DOWN on the state the merge-arb leaves`);
    } else if (m.dirRoute === 'complex-buy') {
      const p1 = await probeQuote(m, `probe quote: sell x ${m.o}`, side(m, m.o), m.repo, m.fee[m.o], m.x);
      m.P = p1.amt;
      const p2 = await probeQuote(m, `probe quote: buy ${m.s} with P`, m.repo, side(m, m.s), m.fee[m.s], m.P);
      QB.set('cxbuy:' + m.addr, p2);
      say(`post-set probe (${m.name}): sell x ${fmt(m.x)} ${m.o} -> P ${fmt(m.P)} repo; buy ${m.s} with P -> ${fmt(p2.amt)} ${m.s}; route ${m.dirRoute} (fresh sum ${m.sum.toFixed(6)}), post-set sum ${m.postSetSum.toFixed(6)} -> ${m.postRoute}${m.postRoute === m.dirRoute ? ' (agree)' : ' (DISAGREE: the fresh-slot0 route is kept, G section 3)'}`);
    } else {
      const p1 = await probeQuote(m, `probe quote: buy ${m.s} with x`, m.repo, side(m, m.s), m.fee[m.s], m.x);
      QA.set('simple:' + m.addr, { ...p1, ok: true });
      say(`post-set probe (${m.name}): buy ${m.s} with x ${fmt(m.x)} -> ${fmt(p1.amt)} ${m.s}; route ${m.dirRoute}, post-set sum ${m.postSetSum.toFixed(6)} -> ${m.postRoute}`);
    }
  }

  // ---------- 8. trade groups in allocation order, each market's set group first; the per-market repo-token ledger ----------
  const byAddr = new Map(tm.map((m) => [m.addr, m]));
  const order = []; const seen = new Set();
  for (const a of S.allocationOrder) { const m = byAddr.get(a); if (m && !seen.has(a)) { seen.add(a); order.push(m); } }
  const rowRef = (m, ss) => ss.map((s) => ({ side: s, stake: m.rows[s].stake, quoted_fill: m.rows[s].quoted_fill, p_win: m.rows[s].p_win }));
  const relRows = [];
  // the cut (a rebuilt plan that failed its simulation again): no group at or after index cutAt is built
  const cutHere = () => cutAt !== null && groups.length >= cutAt;
  const cutRows = (m, sides) => { for (const s of sides) skippedRows.push({ market: m.name, address: m.addr, side: s, route: m.rows[s].route, stake: m.rows[s].stake, reason: cutWhy }); };
  for (const m of order) {
    if (cutHere()) { cutRows(m, Object.keys(m.rows)); m.set = null; m.dirRoute = null; m.cut = true; continue; }
    let rem = m.avail; // G section 3: the balance the mints leave (held_j + m_X), less what earlier calls spend, plus what they return
    if (m.set && m.postMA) {
      // G section 3: a remaining below the merge-arb's quoted cost makes its legs infeasible (a failing simulation)
      if (rem < m.setInfo.cost) throw gstop('merge-arb-infeasible', `${m.name}: the merge-arb's quoted cost ${fmt(m.setInfo.cost)} is above what the market has (${fmt(rem)}): the plan is stale, rebuild from F`, { stale_simulation: true, first_failed_group: groups.length, first_failed_group_id: m.setGroupObj.id });
      groups.push(m.setGroupObj); rem = rem - m.setInfo.cost + m.setInfo.q; // its q returned repo tokens (G section 3)
    } else if (m.set) { groups.push(m.setGroupObj); rem = rem - m.setInfo.q + m.setInfo.proceeds; }
    if (m.dirRoute && cutHere()) { cutRows(m, m.dirSides); m.dirRoute = null; m.cut = true; m.remainingAfter = rem; continue; }
    if (m.dirRoute === 'simple-buy') {
      const s = m.s; const leg = side(m, s); const qout = QA.get('simple:' + m.addr).amt;
      if (!m.set) relRows.push([m.name, s, 'simple', Math.abs(Number(qout) / Number(m.x) - 1 / m.rows[s].quoted_fill) / (1 / m.rows[s].quoted_fill)]);
      m.qout = qout;
      groups.push({ id: 'simple-buy:' + m.name + ':' + s, kind: 'simple-buy', market: m.name, address: m.addr, rows: rowRef(m, [s]), txs: [
        Bd.approve(m.repo, A.SWAP, m.x, 'approve repo -> SwapRouter02 (stake)'),
        Bd.exIn(m.repo, leg, m.fee[s], m.x, qout * 9950n / 10000n, qout, `buy ${s} (exactInput, min 99.5% of quote)`)] });
      rem -= m.x;
    } else if (m.dirRoute === 'complex-buy') {
      const s = m.s; const o = m.o; const own = side(m, s); const oth = side(m, o);
      const sellQ = m.set ? m.P : QA.get('cxsell:' + m.addr).amt; const buyQ = QB.get('cxbuy:' + m.addr).amt;
      m.sellQ = sellQ; m.buyQ = buyQ;
      const g = { id: 'complex-buy:' + m.name + ':' + s, kind: 'complex-buy', market: m.name, address: m.addr, rows: rowRef(m, [s]), txs: [
        Bd.approve(m.repo, A.ROUTER, m.x, 'approve repo -> Router (x = stake)'), Bd.split(m.addr, m.x, 'Router.splitPosition(sUSDS, child, x)'),
        Bd.approve(oth, A.SWAP, m.x, `approve ${o} -> SwapRouter02 (x)`), Bd.exIn(oth, m.repo, m.fee[o], m.x, sellQ * 9950n / 10000n, sellQ, `sell x ${o} -> repo (min 99.5% of quote)`),
        Bd.approve(m.repo, A.SWAP, sellQ, 'approve repo -> SwapRouter02 (P, quoted proceeds)'), Bd.exIn(m.repo, own, m.fee[s], sellQ, buyQ * 9950n / 10000n, buyQ, `buy ${s} with the proceeds (min 99.5% of quote at P)`)] };
      g.txs[4].rebuild_at_send = true; g.txs[5].rebuild_at_send = true;
      groups.push(g);
      rem -= m.x;
    } else if (m.dirRoute === 'dual-buy') {
      m.inMax = {}; m.quotedIn = {};
      for (const s of ['UP', 'DOWN']) {
        const qq = QA.get('dual' + s + ':' + m.addr).amt; m.quotedIn[s] = qq;
        m.inMax[s] = minB(m.sw[s] * 10050n / 10000n, rem); // inMax = min(stake x 1.005, remaining) (G section 3)
        // G section 3: an infeasible leg is a failing simulation of its group (G section 8)
        if (m.inMax[s] < qq) throw gstop('dual-leg-infeasible', `${m.name} ${s}: the quoted amountIn ${fmt(qq)} is above what the market has left at that leg (${fmt(m.inMax[s])}): the plan is stale, rebuild from F`, { stale_simulation: true, first_failed_group: groups.length, first_failed_group_id: 'dual-buy:' + m.name });
        rem -= qq;
        relRows.push([m.name, s, 'dual', Math.abs(Number(qq) / Number(m.cnt[s]) - m.rows[s].quoted_fill) / m.rows[s].quoted_fill]);
      }
      m.bandCut = ['UP', 'DOWN'].filter((s) => m.inMax[s] < m.sw[s] * 10050n / 10000n);
      groups.push({ id: 'dual-buy:' + m.name, kind: 'dual-buy', market: m.name, address: m.addr, rows: rowRef(m, ['UP', 'DOWN']), txs: [
        Bd.approve(m.repo, A.SWAP, m.inMax.UP, 'approve repo -> SwapRouter02 (inMax UP)'), Bd.exOut(m.repo, m.up, m.fee.UP, m.cnt.UP, m.inMax.UP, m.quotedIn.UP, 'buy count UP (exactOutput)'),
        Bd.approve(m.repo, A.SWAP, m.inMax.DOWN, 'approve repo -> SwapRouter02 (inMax DOWN)'), Bd.exOut(m.repo, m.down, m.fee.DOWN, m.cnt.DOWN, m.inMax.DOWN, m.quotedIn.DOWN, 'buy count DOWN (exactOutput)')] });
    }
    m.remainingAfter = rem;
  }
  const relNum = relRows.map((r) => r[3]); const worstRel = relNum.reduce((a, b) => Math.max(a, b), 0);
  const worstRow = relRows.slice().sort((a, b) => b[3] - a[3])[0];
  say(`fresh quote vs F's quoted_fill (drift since F's read, not a check): ${relNum.length} rows, largest relative gap ${worstRel.toExponential(3)}${worstRow ? ` (${worstRow[0]} ${worstRow[1]} ${worstRow[2]})` : ''}`);

  // ---------- 9. per-market budget: nominal spend <= held_j + m_X (F step 6) ----------
  const over = []; const bandCut = [];
  for (const m of tm) {
    let nominal = 0n;
    if (m.set) nominal += m.postMA ? toWei(m.set.stake) : m.q; // a merge-arb's stake is its cost (F step 6's arb_j)
    if (m.dirRoute === 'dual-buy') nominal += m.sw.UP + m.sw.DOWN; else if (m.dirRoute) nominal += m.x;
    m.spendNominal = nominal;
    if (nominal > m.avail) over.push(`${m.name} nominal spend ${fmt(nominal)} > held_j + m_X ${fmt(m.avail)}`);
    if (m.bandCut && m.bandCut.length) bandCut.push(`${m.name} (${m.bandCut.join('+')})`);
  }
  if (over.length) throw gstop('over-budget', `a market would spend more than its repo-token budget: ${clip(over.join('; '), 600)}`);
  say(`per-market budget: every market's nominal spend within held_j + m_X; dual-buy legs whose band is cut by the remaining budget: ${bandCut.length}${bandCut.length ? ' ' + bandCut.join(', ') : ''}`);

  // a cut inside the mint prefix drops the later mints too (every trade group is already cut)
  if (cutAt !== null && groups.length > cutAt) groups.length = cutAt;
  const nMintSent = Math.min(nMint, groups.length);
  const cut = cutAt === null ? null : { at_group: cutAt, group_id: R.cutGroupId || null, reason: cutWhy, rows_skipped: skippedRows.filter((r) => r.reason === cutWhy).length, mint_groups_cut: nMint - nMintSent };
  if (cut) say(`CUT: ${cutWhy}; ${cut.rows_skipped} row(s) skipped${cut.mint_groups_cut ? `, ${cut.mint_groups_cut} mint group(s) dropped` : ''}`);

  // ---------- 10. the whole ordered sequence, simulated (G section 8, Money rules) ----------
  const nTx = groups.reduce((s, g) => s + g.txs.length, 0);
  const kinds = groups.reduce((o, g) => { o[g.kind] = (o[g.kind] || 0) + 1; return o; }, {});
  say(`built ${groups.length} keep-whole groups, ${nTx} single transactions (one call per send); by kind ${JSON.stringify(kinds)}`);
  let sim = { windows: [], rows: [], windowed: false };
  if (groups.length) {
    sim = await G.simulatePlan(ctx, io, groups, nMintSent);
    let firstFail = null; let failText = null; let failFile = null;
    for (const w of sim.windows) {
      if (w.page.pending_nonce !== S.nonce.pending) throw gsafety('nonce-moved', `${w.file}: the simulation's pending nonce ${w.page.pending_nonce} is not the plan's ${S.nonce.pending}`);
      const pb = G.pageProblems(w.page, { entries: w.groupIdx.length, count: w.groupIdx.reduce((s, gi) => s + groups[gi].txs.length, 0) });
      if (pb.length) {
        const local = w.page.first_failed_group; const gi = Number.isInteger(local) && local < w.groupIdx.length ? w.groupIdx[local] : null;
        if (failText === null || (gi !== null && (firstFail === null || gi < firstFail))) { firstFail = gi; failText = pb.join('; '); failFile = w.file; }
        continue;
      }
      say(`SIMULATION ${w.file}: ${JSON.stringify({ ...w.page, calls: undefined, returns: undefined })}`);
    }
    if (failText !== null) throw gstop('simulation-failed', `${failFile}: ${clip(failText, 800)}: the plan is stale (G section 8, A failing pre-send simulation)`, { simulate_file: failFile, stale_simulation: true, first_failed_group: firstFail, first_failed_group_id: firstFail === null ? null : groups[firstFail].id });
    let k = 0;
    groups.forEach((g, gi) => g.txs.forEach((t) => {
      const row = sim.rows[k];
      if (!row || row[2] !== '0x1') throw gstop('simulation-failed', `transaction ${k} (${t.label}) has no 0x1 row`);
      t.idx = k; t.group = gi; t.gas_used = Number(row[3]); t.max_used_gas = row[4] === null || row[4] === undefined ? null : Number(row[4]); t.gas_limit = String(row[5]);
      k++;
    }));
  }
  const nonceAfter = await G.checkNonce(io, holder, S.nonce.pending, 'G build (after the simulation)');
  say(`build finished; holder nonce still ${nonceAfter.latest}; ${sim.windows.length} simulate request(s)${sim.windowed ? ' (windowed: the plan was not one request)' : ''}`);

  for (const m of tm) delete m.setGroupObj;
  return { M, mX, bX, groups, nMint: nMintSent, sim, tm, order: order.map((m) => m.addr), skippedRows, worstRel, agreement, kinds, nTx, cut };
}

module.exports = { build };
