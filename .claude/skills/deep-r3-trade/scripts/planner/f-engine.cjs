// planner/f-engine.cjs - F's per-market planner (steps 3a, 3b, 3, 4 and 8), ported from the live F engine.
//
// All repo-token quantities are BigInt wei. The exact BigInt Uniswap v3 single-range math (f-lib) seeds every
// bisection and is the step 8 fallback model for rows sized on the post-3a state; every size that can be quoted on the
// live state is confirmed with QuoterV2 (through the chain helper) and compared with the model to the wei (the gaps
// list). The math and the order of the steps are the live run's, unchanged. Two additions, neither of which changes a
// result the live run could produce: a market whose budget is 0 returns no row without quoting (the live code would
// have quoted and kept nothing), and a sub-1 pair whose budget-fit size comes out 0 is no pair (the live code had no
// such case: every budget was the whole bankroll).
//
// Step 3a's merge-arb (a sub-1 market whose holder holds child Invalid I_j of THAT market, from an earlier set-sell or
// complex-buy split): q = min(q_max_pair, I_j), q_max_pair being 3b's pair bound bisected on quoteExactOutputSingle;
// cost = the two exact-output amountIn at q; limited_by invalid-held when I_j binds; a budget that cannot pay the cost
// takes the largest q whose cost fits (F step 6). 3b then takes only the remainder q_max_pair - q, priced on the
// post-merge-arb state: an exact-output swap's cost is path-additive, so the remainder's leg cost is the live quote at
// q + x less the live quote at q (every number a quoter answer); a folded directional extra the same way. A stand-alone
// directional row on the post-merge-arb state takes the exact model (src model-post-3a), as after a set-sell, and is
// probed on simulated state (f-probe-post3a).
'use strict';

const FL = require('./f-lib.cjs');

const { lc } = FL;

// The engine's view of one F invocation: the state read by f-read, candidates, blends, the I/O layer, the gaps list.
function makeEngine({ S, cands, blends, io }) {
  const blendByAddr = new Map(blends.map((b) => [lc(b.address), b]));
  const gaps = []; // model-vs-quoter comparisons (step 8's 1% rule; observed to the wei on the live run)
  const poolOf = (i, side) => S.pools[i * 2 + (side === 'UP' ? 1 : 0)];
  const sTick = (t) => Math.pow(1.0001, t / 2);
  // state object for the model: sqrt (pool order), L, fee, T0, range edges in pool-sqrt terms
  function mkState(p, sqrt) {
    const loS = BigInt(Math.floor(sTick(p.lo) * 2 ** 96)); const hiS = BigInt(Math.floor(sTick(p.hi) * 2 ** 96));
    return { pool: p.pool, tok: p.tok, T0: p.T0, fee: p.fee, L: p.L, sqrt: sqrt === undefined ? p.sqrt : sqrt, loSqrt: loS, hiSqrt: hiS };
  }
  const withSqrt = (st, sq) => ({ ...st, sqrt: sq });

  // ---------- exact model: legs ----------
  const feeF = (fee) => fee / 1e6;
  function sellModel(st, q) { const r = FL.sellExactIn(st, q); return r && FL.inRange(st, r.sqrtAfter) ? r : null; }
  function buyOutModel(st, q) { const r = FL.buyExactOut(st, q); return r && FL.inRange(st, r.sqrtAfter) ? r : null; }
  function buyInModel(st, amt) { const r = FL.buyExactIn(st, amt); return r && FL.inRange(st, r.sqrtAfter) ? r : null; }
  // predicates on a (UP, DOWN) pair of pool states for size q; returns {ok, why}
  function setSellOk(stU, stD, q, f) {
    const a = sellModel(stU, q); const b = sellModel(stD, q); if (!a || !b) return { ok: false, why: 'range' };
    return { ok: (FL.priceOf(a.sqrtAfter, stU.T0) + FL.priceOf(b.sqrtAfter, stD.T0)) * (1 - f) >= 1, why: 'sum', a, b };
  }
  function pairOk(stU, stD, q, f) {
    const a = buyOutModel(stU, q); const b = buyOutModel(stD, q); if (!a || !b) return { ok: false, why: 'range' };
    return { ok: (FL.priceOf(a.sqrtAfter, stU.T0) + FL.priceOf(b.sqrtAfter, stD.T0)) / (1 - f) <= 1, why: 'sum', a, b };
  }
  // largest wei q in [0, hi] with pred(q).ok (pred monotone: true then false)
  function maxQ(pred, hi = 10n ** 25n) {
    if (!pred(1n).ok) return { q: 0n }; let lo = 1n; let h = hi;
    if (pred(h).ok) return { q: h };
    while (h - lo > 1n) { const mid = (lo + h) / 2n; if (pred(mid).ok) lo = mid; else h = mid; }
    return { q: lo, whyAbove: pred(lo + 1n).why };
  }
  // largest q whose total cost (sum of the two exact-out legs) <= budget
  function maxQCost(stU, stD, f, budget) {
    const pred = (q) => { const a = buyOutModel(stU, q); const b = buyOutModel(stD, q); if (!a || !b) return { ok: false, why: 'range' }; return { ok: a.amtIn + b.amtIn <= budget, why: 'budget' }; };
    return maxQ(pred);
  }

  // ---------- quoter-backed predicates ----------
  async function predSetSellQ(R, stU, stD, qs, f) {
    const reqs = []; qs.forEach((q) => { reqs.push({ kind: 'in', tokenIn: stU.tok, tokenOut: R, amt: q, fee: stU.fee }, { kind: 'in', tokenIn: stD.tok, tokenOut: R, amt: q, fee: stD.fee }); });
    const r = await io.quotes(reqs);
    return qs.map((q, k) => { const a = r[2 * k]; const b = r[2 * k + 1]; if (!a.ok || !b.ok) return false; return (FL.priceOf(a.sqrtAfter, stU.T0) + FL.priceOf(b.sqrtAfter, stD.T0)) * (1 - f) >= 1; });
  }
  async function predPairQ(R, stU, stD, qs, f) {
    const reqs = []; qs.forEach((q) => { reqs.push({ kind: 'out', tokenIn: R, tokenOut: stU.tok, amt: q, fee: stU.fee }, { kind: 'out', tokenIn: R, tokenOut: stD.tok, amt: q, fee: stD.fee }); });
    const r = await io.quotes(reqs);
    return qs.map((q, k) => { const a = r[2 * k]; const b = r[2 * k + 1]; if (!a.ok || !b.ok) return false; return (FL.priceOf(a.sqrtAfter, stU.T0) + FL.priceOf(b.sqrtAfter, stD.T0)) / (1 - f) <= 1; });
  }
  // F step 8: bisect on the quoter. Seeded by the exact model q (tight bracket), so normally ONE batch (q passes, q(1+1e-6)+1 fails)
  // proves the bracket; otherwise widen and refine with grids until pass at q and fail at q(1+1e-6).
  async function bisectQuoter(predQ, qModel) {
    const info = { rounds: 0 };
    const next = (q) => q + q / 1000000n + 1n;
    if (qModel > 0n) { // the exact model is within ~1e-17 of the quoter, so test 1e-9 below it: that size must pass and 1e-6 above it must fail
      const qa = qModel - qModel / 1000000000n - 1n;
      info.rounds++; const r = await predQ([qa, next(qa)]);
      if (r[0] && !r[1]) return { q: qa, tight: true, info };
    }
    // general: bracket then refine on a grid (K = 24 sizes per round)
    let lo = qModel > 0n ? qModel - qModel / 1000n : 1000n; let hi = qModel > 0n ? qModel + qModel / 1000n : 10n ** 15n;
    for (let t = 0; t < 40; t++) {
      info.rounds++; const r = await predQ([lo, hi]);
      if (!r[0]) { hi = lo; lo = lo / 2n; if (lo < 10n) return { q: 0n, tight: false, info }; continue; }
      if (r[1]) { lo = hi; hi = hi * 2n + 1000n; continue; }
      break;
    }
    for (let g = 0; g < 14 && (hi - lo) * 10n ** 9n > lo; g++) {
      const K = 24n; const grid = []; for (let k = 1n; k <= K; k++) grid.push(lo + (hi - lo) * k / (K + 1n));
      info.rounds++; const r = await predQ(grid); const idx = r.findIndex((x) => !x);
      if (idx === -1) lo = grid[grid.length - 1]; else { hi = grid[idx]; if (idx > 0) lo = grid[idx - 1]; }
    }
    const t = await predQ([lo, next(lo)]); info.rounds++;
    return { q: lo, tight: t[0] && !t[1], info, qModel };
  }

  // ---------- F step 4: getVolumeUntilPrice(pool, target, outcomeToken, "buy"), exact integer form ----------
  // gross repo-token input (grossed up by 1/(1-f)) that moves the outcome token's price in repo tokens from curSqrt to targetP,
  // clamped just inside the range edge; also the outcome tokens out.
  function volumeUntil(st, curSqrt, targetP) {
    const T0 = st.T0; const sT = Math.sqrt(targetP);
    let sqrtT = T0 ? BigInt(Math.floor(sT * 2 ** 96)) : BigInt(Math.floor(2 ** 96 / sT));
    let capped = false;
    if (T0) { const edge = st.hiSqrt - st.hiSqrt / 1000000000n; if (sqrtT > edge) { sqrtT = edge; capped = true; } if (sqrtT <= curSqrt) return { gross: 0n, tokens: 0n, capped, sqrtT: curSqrt }; } else { const edge = st.loSqrt + st.loSqrt / 1000000000n; if (sqrtT < edge) { sqrtT = edge; capped = true; } if (sqrtT >= curSqrt) return { gross: 0n, tokens: 0n, capped, sqrtT: curSqrt }; }
    const f = BigInt(st.fee);
    const net = T0 ? FL.amount1Delta(curSqrt, sqrtT, st.L, true) : FL.amount0Delta(sqrtT, curSqrt, st.L, true);
    const tokens = T0 ? FL.amount0Delta(curSqrt, sqrtT, st.L, false) : FL.amount1Delta(sqrtT, curSqrt, st.L, false);
    return { gross: net + FL.mulDivUp(net, f, 1000000n - f), tokens, capped, sqrtT };
  }

  const wf = FL.wf;

  // ---------- the per-market planner ----------
  // opt: { B: BigInt budget (held_j + M) or undefined = unconstrained, dropSet, dropPair, dropDir:{UP,DOWN} }
  async function planMarket(i, opt = {}) {
    const c = cands[i]; const R = lc(c.collateral_token);
    const pU = poolOf(i, 'UP'); const pD = poolOf(i, 'DOWN'); if (!pU || !pD) throw new Error('no pool state for market ' + i);
    if (pU.fee !== pD.fee) throw new Error('fee tiers differ ' + i);
    const f = feeF(pU.fee);
    const live = { UP: mkState(pU), DOWN: mkState(pD) }; const stU = live.UP; const stD = live.DOWN;
    const bl = blendByAddr.get(lc(c.address)); const p = bl ? { UP: bl.blended[1], DOWN: bl.blended[0] } : null;
    const unc = opt.B === undefined; let rem = unc ? null : opt.B;
    const GL = []; const gp = (...a) => { GL.push(...a); gaps.push(...a); };
    const out = { i, market: c.market, address: lc(c.address), R, block: S.pinOfMarket[i], f, sym: c.collateral_symbol, hasBlend: !!bl, p, notes: [], checks: [], set: null, pair: null, dir: null, caps: { arb: 0n, pair: 0n, dir: 0n } };
    const PU = FL.priceOf(stU.sqrt, stU.T0); const PD = FL.priceOf(stD.sqrt, stD.T0);
    out.spot = { Pup: PU, Pdn: PD, sum: PU + PD };
    const snapSum = pU.snap + pD.snap; const clsOf = (s) => (s * (1 - f) > 1 ? 'set-sell' : s < 1 - f ? 'sub1' : 'band');
    out.cls = clsOf(out.spot.sum); out.clsSnap = clsOf(snapSum); out.snapSum = snapSum;
    let cur = { UP: stU.sqrt, DOWN: stD.sqrt }; let postState = false; // postState: cur differs from live (set-sell ran): model only from here
    if (!unc && rem <= 0n) { // nothing to spend in this market: no row (the live code would quote and keep nothing)
      out.notes.push('budget held_j + M is 0: no row'); out.gaps = GL; out.cap = 0n; out.post = { sqrt: { UP: cur.UP, DOWN: cur.DOWN } };
      return out;
    }

    // ===== 3a: set-sell =====
    if (out.cls === 'set-sell' && !opt.dropSet) {
      const qm = maxQ((q) => setSellOk(stU, stD, q, f));
      const bq = await bisectQuoter((qs) => predSetSellQ(R, stU, stD, qs, f), qm.q);
      out.checks.push({ what: 'set-sell q_max on QuoterV2', qModel: qm.q, qQuoter: bq.q, tight: bq.tight, rounds: bq.info.rounds });
      let q = bq.q; let limited = qm.whyAbove === 'range' ? 'pool-depth' : 'marginal-ev-zero';
      if (!unc && q > rem) { q = rem; limited = 'market-budget'; }
      if (q > 0n) {
        const r = await io.quotes([{ kind: 'in', tokenIn: stU.tok, tokenOut: R, amt: q, fee: stU.fee }, { kind: 'in', tokenIn: stD.tok, tokenOut: R, amt: q, fee: stD.fee }]);
        if (!r[0].ok || !r[1].ok) throw new Error('set-sell confirm quote invalid ' + i);
        const mu = sellModel(stU, q); const md = sellModel(stD, q);
        gp({ i, kind: 'set-sell UP out', model: mu.out, quoter: r[0].amt }, { i, kind: 'set-sell DOWN out', model: md.out, quoter: r[1].amt });
        gp({ i, kind: 'set-sell UP sqrtAfter', model: mu.sqrtAfter, quoter: r[0].sqrtAfter }, { i, kind: 'set-sell DOWN sqrtAfter', model: md.sqrtAfter, quoter: r[1].sqrtAfter });
        const proceeds = r[0].amt + r[1].amt;
        out.set = { route: 'set-sell', q, proceeds, upOut: r[0].amt, dnOut: r[1].amt, limited, qMaxFull: bq.q, sqrtAfter: { UP: r[0].sqrtAfter, DOWN: r[1].sqrtAfter } };
        cur = { UP: r[0].sqrtAfter, DOWN: r[1].sqrtAfter }; postState = true; if (!unc) rem -= q; out.caps.arb = q;
      }
    }

    const sumNow = () => FL.priceOf(cur.UP, stU.T0) + FL.priceOf(cur.DOWN, stD.T0);
    const subOne = () => sumNow() < 1 - f;
    // 3b's pair bound on the live state, shared by the merge-arb and the 3b pair (bisected once)
    let pairBound = null;
    const getPairBound = async () => {
      if (pairBound) return pairBound;
      const qm = maxQ((q) => pairOk(stU, stD, q, f));
      const bq = await bisectQuoter((qs) => predPairQ(R, stU, stD, qs, f), qm.q);
      out.checks.push({ what: 'pair q_max on QuoterV2', qModel: qm.q, qQuoter: bq.q, tight: bq.tight, rounds: bq.info.rounds });
      pairBound = { q: bq.q, whyAbove: qm.whyAbove }; return pairBound;
    };
    // a pair's two legs bought on top of an earlier buy of off pairs (the merge-arb's): live quotes at off + x, less the
    // live quotes at off (base), which are the merge-arb's own legs; off = 0 is the plain 3b pair on the live state
    let maQ = 0n; const maBase = { UP: 0n, DOWN: 0n };
    const legsAt = async (x) => { const r = await io.quotes([{ kind: 'out', tokenIn: R, tokenOut: stU.tok, amt: maQ + x, fee: stU.fee }, { kind: 'out', tokenIn: R, tokenOut: stD.tok, amt: maQ + x, fee: stD.fee }]); return r.map((y, k) => ({ ...y, amt: y.ok ? y.amt - maBase[k ? 'DOWN' : 'UP'] : y.amt })); };
    const predCost = (budget) => async (qs) => { const reqs = []; qs.forEach((x) => reqs.push({ kind: 'out', tokenIn: R, tokenOut: stU.tok, amt: maQ + x, fee: stU.fee }, { kind: 'out', tokenIn: R, tokenOut: stD.tok, amt: maQ + x, fee: stD.fee })); const rr = await io.quotes(reqs); return qs.map((x, k) => rr[2 * k].ok && rr[2 * k + 1].ok && rr[2 * k].amt - maBase.UP + rr[2 * k + 1].amt - maBase.DOWN <= budget); };
    // ===== 3a: merge-arb (held child Invalid I_j > 0 of this market; F step 3a) =====
    const Ij = BigInt(S.balances.childInv[i] || 0);
    if (!postState && subOne() && Ij > 0n && !opt.dropSet && (unc || rem > 0n)) {
      const pb = await getPairBound();
      let q = pb.q < Ij ? pb.q : Ij; let limited = Ij < pb.q ? 'invalid-held' : (pb.whyAbove === 'range' ? 'pool-depth' : 'marginal-ev-zero');
      if (q > 0n) {
        let r = await legsAt(q);
        if (!r[0].ok || !r[1].ok) throw new Error('merge-arb confirm quote invalid ' + i);
        if (!unc && r[0].amt + r[1].amt > rem) { // the budget binds (F step 6): the largest q whose cost fits
          const mq = maxQCost(stU, stD, f, rem); const bb = await bisectQuoter(predCost(rem), mq.q < q ? mq.q : q);
          q = bb.q < q ? bb.q : q; limited = 'market-budget';
          out.checks.push({ what: 'merge-arb budget-fit q on QuoterV2', qModel: mq.q, qQuoter: bb.q, tight: bb.q > 0n ? bb.tight : null, rounds: bb.info.rounds });
          if (q > 0n) r = await legsAt(q); else out.notes.push('merge-arb: no size fits the remaining budget');
        }
        if (q > 0n) {
          if (!r[0].ok || !r[1].ok) throw new Error('merge-arb budget-fit quote invalid ' + i);
          const mu = buyOutModel(stU, q); const md = buyOutModel(stD, q);
          gp({ i, kind: 'merge-arb UP amountIn', model: mu.amtIn, quoter: r[0].amt }, { i, kind: 'merge-arb DOWN amountIn', model: md.amtIn, quoter: r[1].amt }, { i, kind: 'merge-arb UP sqrtAfter', model: mu.sqrtAfter, quoter: r[0].sqrtAfter }, { i, kind: 'merge-arb DOWN sqrtAfter', model: md.sqrtAfter, quoter: r[1].sqrtAfter });
          const cost = r[0].amt + r[1].amt;
          out.set = { route: 'merge-arb', q, cost, upIn: r[0].amt, dnIn: r[1].amt, limited, qMaxPair: pb.q, Ij, sqrtAfter: { UP: r[0].sqrtAfter, DOWN: r[1].sqrtAfter } };
          cur = { UP: r[0].sqrtAfter, DOWN: r[1].sqrtAfter }; if (!unc) rem -= cost; out.caps.arb = cost;
          maQ = q; maBase.UP = r[0].amt; maBase.DOWN = r[1].amt; // its q returned repo tokens are not recycled (F step 6)
        }
      }
    }
    const postMA = maQ > 0n;
    // ===== 3b: sub-1 pair (after a merge-arb: the remainder of the pair bound, on the post-merge-arb state) =====
    if (subOne() && !opt.dropPair && (unc || rem > 0n)) {
      if (postState) throw new Error('3b after a post-3a state needs the model path; not reachable after a set-sell (market ' + i + ')');
      const pb = await getPairBound();
      let q = pb.q > maQ ? pb.q - maQ : 0n; let limited = pb.whyAbove === 'range' ? 'pool-depth' : 'marginal-ev-zero';
      if (q > 0n) {
        let r = await legsAt(q);
        if (!r[0].ok || !r[1].ok) throw new Error('pair confirm quote invalid ' + i);
        if (!unc && r[0].amt + r[1].amt > rem) { // budget binds: largest q whose cost fits the remaining budget (exact model, then confirmed on the quoter)
          const mq = maxQCost(withSqrt(stU, cur.UP), withSqrt(stD, cur.DOWN), f, rem); const qq = mq.q;
          const bb = await bisectQuoter(predCost(rem), qq); q = bb.q; limited = 'market-budget';
          out.checks.push({ what: 'pair budget-fit q on QuoterV2', qModel: qq, qQuoter: bb.q, tight: bb.q > 0n ? bb.tight : null, rounds: bb.info.rounds });
          if (q > 0n) r = await legsAt(q);
          else out.notes.push('pair: no size fits the remaining budget');
        }
        if (q > 0n) {
          if (!r[0].ok || !r[1].ok) throw new Error('pair budget-fit quote invalid ' + i);
          const mu = buyOutModel(withSqrt(stU, cur.UP), q); const md = buyOutModel(withSqrt(stD, cur.DOWN), q);
          gp({ i, kind: 'pair UP amountIn', model: mu.amtIn, quoter: r[0].amt }, { i, kind: 'pair DOWN amountIn', model: md.amtIn, quoter: r[1].amt }, { i, kind: 'pair UP sqrtAfter', model: mu.sqrtAfter, quoter: r[0].sqrtAfter }, { i, kind: 'pair DOWN sqrtAfter', model: md.sqrtAfter, quoter: r[1].sqrtAfter });
          const cost = r[0].amt + r[1].amt;
          out.pair = { q, upIn: r[0].amt, dnIn: r[1].amt, cost, limited, qMaxFull: pb.q - maQ, afterMergeArb: maQ, sqrtAfter: { UP: r[0].sqrtAfter, DOWN: r[1].sqrtAfter } };
          cur = { UP: r[0].sqrtAfter, DOWN: r[1].sqrtAfter }; if (!unc) rem -= cost; out.caps.pair = cost;
        }
      }
    }

    // ===== directional, steps 3-5, on post-arbitrage prices =====
    if (p) {
      const cands2 = [];
      for (const side of ['UP', 'DOWN']) {
        if (opt.dropDir && opt.dropDir[side]) continue;
        const st = live[side]; const stCur = withSqrt(st, cur[side]);
        const Pcur = FL.priceOf(cur[side], st.T0); const target = p[side] * (1 - f);
        if (!(target > Pcur)) continue; // step 3 test: p(1-f) > price
        const vol = volumeUntil(stCur, cur[side], target);
        let spend = vol.gross; let limited = vol.capped ? 'pool-depth' : 'marginal-ev-zero'; const spend0 = spend;
        if (!unc) { const room = rem > 0n ? rem : 0n; if (spend > room) { spend = room; limited = 'market-budget'; } }
        if (spend <= 0n) continue;
        const hasPair = out.pair && out.pair.q > 0n; let cand;
        if (hasPair) { // folded into the pair leg: count = q + extra, exact-output on the live (pre-pair) pool
          const baseIn = side === 'UP' ? out.pair.upIn : out.pair.dnIn;
          const room = unc ? null : rem;
          const mdl = buyInModel(stCur, spend); if (!mdl) { out.notes.push(`${side} folded extra: model out of range, skipped`); continue; }
          let extra = mdl.out; let rq = null; let extraStake = null;
          for (let tries = 0; tries < 8; tries++) {
            const count = out.pair.q + extra;
            // on the live (pre-pair) pool, on top of the merge-arb's maQ pairs when one ran (path-additive, maBase)
            rq = (await io.quotes([{ kind: 'out', tokenIn: R, tokenOut: st.tok, amt: maQ + count, fee: st.fee }]))[0];
            if (rq.ok) rq = { ...rq, amt: rq.amt - maBase[side] };
            if (!rq.ok) { extra = extra - extra / 1000n - 1n; if (extra <= 0n) { rq = null; break; } continue; } // infeasible (past depth): trim
            extraStake = rq.amt - baseIn;
            if (room !== null && extraStake > room) { const ex = extraStake - room; extra = extra - (ex * 1000000000n / BigInt(Math.max(1, Math.floor(Pcur * 1e9)))) - 2n; if (extra <= 0n) { rq = null; break; } continue; }
            break;
          }
          if (!rq || extraStake === null || extraStake <= 0n) { out.notes.push(`${side} folded extra could not be quoted within the budget: skipped`); continue; }
          const count = out.pair.q + extra;
          const mm = FL.buyExactOut(postMA ? withSqrt(st, out.set.sqrtAfter[side]) : st, count); if (mm) gp({ i, kind: `${side} folded leg amountIn`, model: mm.amtIn, quoter: rq.amt });
          const pw = p[side];
          cand = { side, folded: true, count, legStake: rq.amt, extra, extraStake, sqrtAfter: rq.sqrtAfter, spend0, limited, capped: vol.capped, targetP: target, p: pw };
          cand.extraEv = wf(extra) * pw - wf(extraStake); cand.ev = cand.extraEv; cand.legEv = wf(count) * pw - wf(rq.amt);
        } else { // stand-alone directional buy from R, exact input at the stake
          let rq; let src;
          if (!postState && !postMA) {
            rq = (await io.quotes([{ kind: 'in', tokenIn: R, tokenOut: st.tok, amt: spend, fee: st.fee }]))[0];
            if (!rq.ok) { out.notes.push(`${side} directional quote invalid (stake ${spend}): skipped`); continue; }
            src = 'quoter'; const mm = buyInModel(stCur, spend); if (mm) gp({ i, kind: `${side} directional out`, model: mm.out, quoter: rq.amt }, { i, kind: `${side} directional sqrtAfter`, model: mm.sqrtAfter, quoter: rq.sqrtAfter });
          } else { const mm = buyInModel(stCur, spend); if (!mm) { out.notes.push(`${side} post-3a directional: model out of range, skipped`); continue; } rq = { ok: true, amt: mm.out, sqrtAfter: mm.sqrtAfter }; src = 'model-post-3a'; }
          const pw = p[side]; const fill = wf(spend) / wf(rq.amt);
          cand = { side, folded: false, stake: spend, tokens: rq.amt, fill, sqrtAfter: rq.sqrtAfter, spend0, limited, capped: vol.capped, targetP: target, p: pw, src, ev: wf(rq.amt) * pw - wf(spend) };
        }
        cand.Pafter = FL.priceOf(cand.sqrtAfter, st.T0); cand.PafterVsTarget = cand.Pafter / target - 1;
        cands2.push(cand);
      }
      if (cands2.length > 1) { cands2.sort((a, b) => b.ev - a.ev); out.notes.push(`both sides passed step 3 (${cands2.map((x) => x.side).join(',')}); kept the higher-ev one`); }
      if (cands2.length) { out.dir = cands2[0]; out.caps.dir = out.dir.folded ? out.dir.extraStake : out.dir.stake; }
    }
    out.gaps = GL;
    out.cap = out.caps.arb + out.caps.pair + out.caps.dir;
    out.post = { sqrt: { UP: cur.UP, DOWN: cur.DOWN } };
    return out;
  }

  return { planMarket, gaps, poolOf, mkState, blendByAddr, volumeUntil, buyInModel, sellModel, buyOutModel };
}

module.exports = { makeEngine };
