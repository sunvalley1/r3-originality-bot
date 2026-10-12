// planner/f-verify.cjs - F's invariant checker (ported from the live F verify script), run on the exact bytes of
// allocation.json BEFORE they are written.
//
// Parts A to D and F are offline (schema, coverage, totals, per-row invariants, value accounting). Part E re-quotes
// every kept row through the chain helper from the artifact's own numbers, as G reads them (count = stake / quoted_fill,
// divided in decimal, truncated to 18 places), exactly as on the live run.
// The head moves on a live chain, so part E first reads every planned market's two pools (slot0 and liquidity, the two
// pools of a market in one multicall file) before and after the re-quotes. A market whose pools are exactly as F read
// them must reproduce its rows (a disagreement is a hard failure: the plan is wrong); a market whose pools moved since F
// read them is reported in the drift list, never a stop (G's drift report, each call's floor and the pre-send re-check
// guard it, G section 3). The same split applies to step 8's bisection and model-gap checks of that market.
// On a market with a merge-arb (F step 3a), every row after it sits on the post-merge-arb state: its pair legs and a
// folded extra are re-quoted on the live pool at q_merge-arb + count less the live quote at q_merge-arb (an exact-output
// swap's cost is path-additive), and a stand-alone directional row is checked against the exact model (part E2).
// Returns { checks, hard, drift, info }; f.cjs writes allocation.json only when hard is empty.
'use strict';

const FL = require('./f-lib.cjs');

const { lc } = FL;
const N = 98;
const VOLUME_MIN = 10n ** 16n;
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1e-30, Math.abs(a), Math.abs(b));

async function verify(R, { text, res, flags, aux, gaps, probe }) {
  const { S, io, cands: C } = R;
  const checks = []; const info = [];
  const chk = (id, ok, detail, hard = true) => { checks.push({ id, pass: !!ok, hard, detail: detail || '' }); };
  const A = JSON.parse(text);
  const P = A.positions; const byAddr = new Map(C.map((c, i) => [lc(c.address), i]));
  const FIN = res.map((r, i) => ({ ...r, opt: flags[i] }));
  // the bankroll F sized on: the sUSDS balance, or the provisional bankroll (sUSDS + PSM3 minAmountOut, --provisional)
  const susdsRaw = BigInt(S.balances.sUSDS); const bankrollRaw = S.provisionalBankroll !== null && S.provisionalBankroll !== undefined ? BigInt(S.provisionalBankroll) : susdsRaw; const HELD = S.balances.heldEff.map(BigInt);
  const wf = FL.wf; const g18 = FL.g18; const gCount = FL.gCount;

  // ---------------- A: schema ----------------
  chk('A1 top-level keys and totals keys', ['generated_at', 'bankroll', 'bankroll_unit', 'objective', 'positions', 'skipped', 'totals'].every((k) => k in A) && Object.keys(A).length === 7 && ['staked', 'expected_value', 'correlated_worst_case'].every((k) => k in A.totals), Object.keys(A).join(','));
  chk('A2 objective max-ev, bankroll_unit sUSDS, no dry_run annotation, bankroll == the 15-digit floor of the raw balance', A.objective === 'max-ev' && A.bankroll_unit === 'sUSDS' && !('dry_run' in A) && g18(A.bankroll) === FL.floor15(bankrollRaw), `bankroll ${A.bankroll} vs raw ${bankrollRaw}${S.provisional ? ' (provisional)' : ''}`);
  const need = ['market', 'address', 'side', 'route', 'stake', 'stake_unit', 'quoted_fill', 'edge_pts', 'ev', 'p_win', 'worst_case', 'limited_by'];
  chk('A3 every row has the 12 contract fields', P.every((r) => need.every((k) => k in r)), `${P.length} rows`);
  chk('A4 side/route vocabulary (UP|DOWN uppercase with direct; set with set-sell|merge-arb)', P.every((r) => (['UP', 'DOWN'].includes(r.side) && r.route === 'direct') || (r.side === 'set' && ['set-sell', 'merge-arb'].includes(r.route))));
  chk('A5 address lowercase and in candidates; stake_unit == collateral_symbol; market name matches; tradeable market', P.every((r) => r.address === r.address.toLowerCase() && byAddr.has(r.address) && r.stake_unit === C[byAddr.get(r.address)].collateral_symbol && r.market === C[byAddr.get(r.address)].market && C[byAddr.get(r.address)].tradeable === true));
  const lim = ['marginal-ev-zero', 'market-budget', 'pool-depth', 'invalid-held', 'volume-min', 'gas'];
  chk('A6 limited_by vocabulary', P.every((r) => lim.includes(r.limited_by)), [...new Set(P.map((r) => r.limited_by))].join(','));
  chk('A7 numbers are finite and written with at most 15 significant digits (round-trip through G exactly)', P.every((r) => ['stake', 'quoted_fill', 'ev', 'worst_case'].every((k) => Number.isFinite(r[k])) && (g18(r.stake) === FL.floor15(g18(r.stake)))), 'stake decimal strings');
  chk('A8 skipped[] entries are {market, reason}', Array.isArray(A.skipped) && A.skipped.every((s) => s && typeof s.market === 'string' && typeof s.reason === 'string' && Object.keys(s).length === 2));
  // ---------------- B: coverage / uniqueness ----------------
  const inPos = new Set(P.map((r) => r.market)); const inSkip = new Set(A.skipped.map((s) => s.market));
  const uncovered = C.filter((c) => !inPos.has(c.market) && !inSkip.has(c.market)).map((c) => c.market);
  chk('B1 every one of the 98 markets is in positions or skipped', uncovered.length === 0 && C.length === N, `markets with rows ${inPos.size}, skipped entries ${A.skipped.length}, in neither ${uncovered.length}`);
  const noRow = C.filter((c) => !inPos.has(c.market)).length; const both = C.filter((c) => inPos.has(c.market) && inSkip.has(c.market)).length;
  info.push(`${inPos.size} markets with rows + ${noRow} markets with no row = ${inPos.size + noRow}; ${both} market(s) in both (a row survived, another was dropped by step 7)`);
  const seen = new Set(); let dup = 0; P.forEach((r) => { const k = r.address + '|' + r.side; if (seen.has(k)) dup++; seen.add(k); });
  chk('B2 at most one set row, one UP row and one DOWN row per market', dup === 0, `duplicates ${dup}`);
  // ---------------- C: totals ----------------
  const Mw = g18(A.totals.staked); const sumEv = P.reduce((a, r) => a + r.ev, 0);
  chk('C1 totals.staked (G-parsed) <= the holder\'s raw sUSDS balance (the provisional bankroll with --provisional) and == M of the plan', Mw <= bankrollRaw && Mw === BigInt(aux.M), `M ${Mw} (${A.totals.staked}) balance ${bankrollRaw}${S.provisional ? ` (provisional; the real sUSDS is ${susdsRaw})` : ''}`);
  chk('C2 totals.expected_value == sum(ev)/98 (sUSDS at 1/98)', near(A.totals.expected_value, sumEv / N, 1e-12) || (sumEv === 0 && A.totals.expected_value === 0), `${A.totals.expected_value} vs ${sumEv / N}; sum ev ${sumEv} repo tokens`);
  chk('C3 correlated_worst_case == -totals.staked (not -sum stake)', A.totals.correlated_worst_case === -A.totals.staked, `${A.totals.correlated_worst_case}`);
  const perM = new Map(); P.forEach((r) => { const o = perM.get(r.address) || { S: 0n, rows: [] }; o.S += g18(r.stake); o.rows.push(r); perM.set(r.address, o); });
  let overBudget = 0; let binding = 0; let maxS = 0n; let maxMkt = '';
  for (const [a, o] of perM) { const i = byAddr.get(a); const Bj = HELD[i] + Mw; if (o.S > Bj) overBudget++; if (o.S >= Bj - Bj / 10n ** 12n) binding++; if (o.S > maxS) { maxS = o.S; maxMkt = C[i].market; } }
  chk('C4 every market: sum of G-parsed stakes <= held_j + M in wei', overBudget === 0, `${perM.size} markets; ${binding} at the budget (within 1e-12); largest S_j ${FL.weiStr(maxS)} (${maxMkt})`);
  const ceil15 = (w) => { const f = FL.floor15(w); return f === w ? w : f + (10n ** BigInt(w.toString().length - 15)); };
  chk('C5 M follows the rule: min(bankroll, max_j (cap_j - held_j)+)', Mw === FL.bigMin(FL.floor15(bankrollRaw), ceil15(BigInt(aux.capMax))), `M ${A.totals.staked}; bankroll ${FL.weiStr(FL.floor15(bankrollRaw))}; max_j (cap_j - held_j)+ ${FL.weiStr(BigInt(aux.capMax))}`);

  // ---------------- E (first): pool state before the re-quotes, per market, pair-aligned ----------------
  const mkts = [...perM.keys()].map((a) => byAddr.get(a)).sort((x, y) => x - y);
  async function readPools() {
    const reads = []; mkts.forEach((i) => [S.pools[i * 2], S.pools[i * 2 + 1]].forEach((p) => { reads.push({ to: p.pool, signature: 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)' }, { to: p.pool, signature: 'liquidity()(uint128)' }); }));
    const out = new Map();
    for (let off = 0; off < reads.length; off += 100) { // 4 reads per market: a market's two pools always share a file
      const rr = await io.mcb(reads.slice(off, off + 100));
      rr.results.forEach((x, k) => { const q = off + k; const i = mkts[Math.floor(q / 4)]; const e = out.get(i) || { block: rr.block, v: [] }; e.v.push(String(x[0])); out.set(i, e); });
    }
    return out;
  }
  const moved = new Set();
  const judgeMoved = (snap) => { for (const i of mkts) { const e = snap.get(i); const d = S.pools[i * 2]; const u = S.pools[i * 2 + 1]; const want = [String(d.sqrt), String(d.L), String(u.sqrt), String(u.L)]; if (!e || e.v.join() !== want.join()) moved.add(i); } };
  if (mkts.length) judgeMoved(await readPools());

  // ---------------- D: per-row invariants ----------------
  const bad = []; const gasLeg = BigInt(aux.GAS_LEG); const gasSet = BigInt(aux.GAS_SET); const gasPair = BigInt(aux.GAS_PAIR);
  for (const [a, o] of perM) {
    const i = byAddr.get(a); const fin = FIN[i]; const f = fin.f; const up = o.rows.find((r) => r.side === 'UP'); const dn = o.rows.find((r) => r.side === 'DOWN'); const st = o.rows.find((r) => r.side === 'set');
    for (const r of o.rows) {
      if (!(r.stake > 0)) bad.push(`${r.market} ${r.side} stake<=0`);
      const pairLeg = r.side !== 'set' && up && dn;
      if (!pairLeg && !(r.ev > 0)) bad.push(`${r.market} ${r.side} ev<=0 ${r.ev}`);
      if (r.side === 'set') { if (r.worst_case !== 0 || r.p_win !== null || r.edge_pts !== null) bad.push(`${r.market} set row fields`); } else {
        if (r.worst_case !== -r.stake) bad.push(`${r.market} ${r.side} worst_case`);
        if (r.p_win !== null) { if (!near(r.ev, r.stake * (r.p_win / r.quoted_fill - 1), 1e-9)) bad.push(`${r.market} ${r.side} ev formula`); if (!near(r.edge_pts, (r.p_win - r.quoted_fill) * 100, 1e-9)) bad.push(`${r.market} ${r.side} edge_pts`); } else if (r.edge_pts !== null) bad.push(`${r.market} ${r.side} null-p leg has edge_pts`);
      }
    }
    if (up && dn) {
      if (!fin.pair || fin.opt.dropPair) { bad.push(`${up.market} UP and DOWN rows without a kept 3b pair`); continue; }
      const cu = Number(gCount(up.stake, up.quoted_fill)) / 1e18; const cd = Number(gCount(dn.stake, dn.quoted_fill)) / 1e18; const q = wf(fin.pair.q);
      const fu = fin.dir && fin.dir.folded && fin.dir.side === 'UP' && !fin.opt.dropDir.UP; const fd = fin.dir && fin.dir.folded && fin.dir.side === 'DOWN' && !fin.opt.dropDir.DOWN;
      if (!near(cu, fu ? wf(fin.dir.count) : q, 1e-12) || !near(cd, fd ? wf(fin.dir.count) : q, 1e-12)) bad.push(`${up.market} pair counts ${cu} ${cd} vs q ${q}`);
      if (!fin.hasBlend) { const sU = wf(fin.pair.upIn); const sD = wf(fin.pair.dnIn); const gain = q - sU - sD; if (!near(up.ev, gain * sU / (sU + sD), 1e-9) || !near(dn.ev, gain * sD / (sU + sD), 1e-9)) bad.push(`${up.market} no-blend ev share`); if (up.p_win !== null || dn.p_win !== null) bad.push(`${up.market} no-blend p_win not null`); }
      if (!(fin.spot.sum < 1 - f)) bad.push(`${up.market} pair market spot sum ${fin.spot.sum} not < 1-f`);
      if (!(wf(fin.pair.cost) / q < 1)) bad.push(`${up.market} locked-in sum >= 1`);
      if (fin.pair.upIn < VOLUME_MIN || fin.pair.dnIn < VOLUME_MIN) bad.push(`${up.market} pair leg < VOLUME_MIN`);
      if (!(fin.pair.q - fin.pair.cost > gasPair)) bad.push(`${up.market} pair gain <= gas`);
      if (fu || fd) { if (!(fin.dir.extraStake >= VOLUME_MIN)) bad.push(`${up.market} folded extra < VOLUME_MIN`); }
    } else if (up || dn) {
      const r = up || dn; const d = fin.dir; if (!d || d.folded || d.side !== r.side) bad.push(`${r.market} single dir row without a stand-alone dir plan`); else { if (g18(r.stake) < VOLUME_MIN) bad.push(`${r.market} dir stake < VOLUME_MIN`); if (!(FL.numToWeiFloor(r.ev) > gasLeg)) bad.push(`${r.market} dir ev ${r.ev} <= gas`); }
    }
    if (st && st.route === 'merge-arb') {
      // F step 3a: q = stake / quoted_fill (G's count rule) pairs, at most the held child Invalid I_j, cost per pair < 1
      const q = gCount(st.stake, st.quoted_fill); const Ij = BigInt(S.balances.childInv[i]);
      if (!fin.set || fin.set.route !== 'merge-arb' || fin.opt.dropSet) bad.push(`${st.market} merge-arb row without a kept merge-arb plan`);
      if (q < VOLUME_MIN) bad.push(`${st.market} merge-arb q < VOLUME_MIN`); if (!(FL.numToWeiFloor(st.ev) > gasSet)) bad.push(`${st.market} merge-arb ev ${st.ev} <= group gas ${wf(gasSet)}`);
      if (q > Ij && (q - Ij) * 10n ** 12n > q) bad.push(`${st.market} merge-arb q ${q} above the held child Invalid ${Ij}`);
      if (!(st.quoted_fill < 1)) bad.push(`${st.market} merge-arb cost per pair >= 1`); if (!(fin.spot.sum < 1 - f)) bad.push(`${st.market} merge-arb but spot sum ${fin.spot.sum}`); if (!near(st.ev, wf(q) - st.stake, 1e-9)) bad.push(`${st.market} merge-arb ev`);
    } else if (st) {
      const q = g18(st.stake); if (q < VOLUME_MIN) bad.push(`${st.market} set q < VOLUME_MIN`); if (!(FL.numToWeiFloor(st.ev) > gasSet)) bad.push(`${st.market} set ev ${st.ev} <= group gas ${wf(gasSet)}`);
      if (!(st.quoted_fill > 1)) bad.push(`${st.market} set-sell fill <= 1`); if (!(fin.spot.sum * (1 - f) > 1)) bad.push(`${st.market} set-sell but spot sum ${fin.spot.sum}`); if (!near(st.ev, st.stake * st.quoted_fill - st.stake, 1e-9)) bad.push(`${st.market} set ev`);
    }
    if (fin.dir && !fin.opt.dropDir[fin.dir.side]) { const d = fin.dir; const kept = o.rows.find((r) => r.side === d.side); if (kept && kept.limited_by === 'marginal-ev-zero' && !d.capped && Math.abs(d.PafterVsTarget) > 1e-9) bad.push(`${fin.market} price after fill vs p(1-f) target: ${d.PafterVsTarget}`); if (kept && kept.limited_by === 'market-budget' && !(d.Pafter <= d.targetP * (1 + 1e-12))) bad.push(`${fin.market} budget-limited row ends above its target`); }
  }
  chk('D1 per-row invariants: stake>0, ev>0 (pair legs judged as a unit), worst_case, p_win/edge_pts rules, ev formulas, pair equal counts via G\'s count rule, no-blend ev share, sums < 1-f, VOLUME_MIN and gas floors, marginal-EV stop at p(1-f)', bad.length === 0, bad.length ? bad.slice(0, 8).join(' | ') : `all ${P.length} rows over ${perM.size} markets`);
  chk('D2 every dropped row is a recorded drop and no kept row is on a dropped (market, kind)', aux.dropLog.every((d) => { const fl = aux.flags[d.i]; return d.row.startsWith('directional') ? (fl.dropDir.UP || fl.dropDir.DOWN) : d.row === 'pair' ? fl.dropPair : fl.dropSet; })
    && P.every((r) => { const fl = flags[byAddr.get(r.address)]; return r.side === 'set' ? !fl.dropSet : true; }), `${aux.dropLog.length} drops`);
  // step 8's bisections and model gaps, judged per market (a market whose pools moved since F's read is drift)
  const keptMkts = new Set(mkts);
  // a bisection that ended at 0 sized no row, so it is not judged
  let tn = 0; const loose = []; const looseMoved = [];
  FIN.forEach((r) => (r.checks || []).forEach((c) => { if (c.tight === null || BigInt(c.qQuoter) === 0n) return; tn++; if (!c.tight && keptMkts.has(r.i)) (moved.has(r.i) ? looseMoved : loose).push(`${r.market}: ${c.what}`); }));
  chk('D3 every q_max bisection on QuoterV2 of a market with a row ended tight (passes at q, fails at q(1+1e-6))', loose.length === 0, `${tn} bisections; loose on an unmoved market ${loose.length}${loose.length ? ' (' + loose.slice(0, 4).join('; ') + ')' : ''}; loose on a moved market (drift) ${looseMoved.length}`);
  let gmax = 0; let gmaxMoved = 0; let gn = 0;
  gaps.forEach((g) => { if (g.model === undefined || g.quoter === undefined) return; const d = Math.abs(Number(BigInt(g.model) - BigInt(g.quoter))) / Number(BigInt(g.quoter)); gn++; if (keptMkts.has(g.i) && moved.has(g.i)) { if (d > gmaxMoved) gmaxMoved = d; } else if (d > gmax) gmax = d; });
  chk('D4 quoter vs exact integer model gap <= 1% (step 8 rule)', gmax <= 0.01, `max relative gap ${gmax.toExponential(2)} over ${gn} comparisons${gmaxMoved ? `; on moved markets (drift) ${gmaxMoved.toExponential(2)}` : ''}`);
  const bothSide = FIN.filter((r) => r.notes && r.notes.some((x) => x.includes('both sides')));
  chk('D5 a both-sides tie-break (at most one directional side) only on markets with no kept pair', bothSide.every((r) => !r.pair || flags[r.i].dropPair), `${bothSide.length} market(s)`);
  const lastDrop = aux.dropLog.length ? Math.max(...aux.dropLog.map((d) => d.iteration)) : 0;
  chk('D6 floors fixed point: the loop ended on an iteration with 0 new drops', aux.nothingToSpend || lastDrop < aux.iter, `last drop in iteration ${lastDrop}, converged at ${aux.iter}`);
  info.push(`held_j > 0 in ${HELD.filter((x) => x > 0n).length} market(s); I_j > 0 in ${S.balances.childInv.filter((x) => BigInt(x) > 0n).length}; unsplit bundle tokens ${S.balances.bundles.join('/')}`);

  // ---------------- E: live re-quote of every kept row, from the artifact's own numbers ----------------
  const reqs = []; const tags = [];
  for (const [a, o] of perM) {
    const i = byAddr.get(a); const fin = FIN[i]; const Rt = lc(C[i].collateral_token); const pU = S.pools[i * 2 + 1]; const pD = S.pools[i * 2];
    const up = o.rows.find((r) => r.side === 'UP'); const dn = o.rows.find((r) => r.side === 'DOWN'); const st = o.rows.find((r) => r.side === 'set');
    const tokU = pU.tok; const tokD = pD.tok; const fee = pU.fee;
    // on a merge-arb market the later legs are quoted on top of the merge-arb's off pairs, less the quote at off (base)
    const ma = st && st.route === 'merge-arb' ? gCount(st.stake, st.quoted_fill) : 0n;
    if (st && st.route === 'merge-arb') { reqs.push({ kind: 'out', tokenIn: Rt, tokenOut: tokU, amt: ma, fee }, { kind: 'out', tokenIn: Rt, tokenOut: tokD, amt: ma, fee }); tags.push({ t: 'ma', i, side: 'UP' }, { t: 'ma', i, side: 'DOWN' }); }
    else if (st) { const q = g18(st.stake); reqs.push({ kind: 'in', tokenIn: tokU, tokenOut: Rt, amt: q, fee }, { kind: 'in', tokenIn: tokD, tokenOut: Rt, amt: q, fee }); tags.push({ t: 'set', i }, { t: 'set', i }); }
    if (up && dn && fin.pair) {
      for (const [side, row, tok] of [['UP', up, tokU], ['DOWN', dn, tokD]]) { const cnt = gCount(row.stake, row.quoted_fill); reqs.push({ kind: 'out', tokenIn: Rt, tokenOut: tok, amt: ma + cnt, fee }); tags.push({ t: 'leg', i, side, row, cnt }); }
      const qq = FL.floor15(fin.pair.q); const qa = ma + qq; const qb = ma + qq + qq / 1000000n + 1n; // the plan's q (15-digit), and 1e-6 above it for the fail check
      reqs.push({ kind: 'out', tokenIn: Rt, tokenOut: tokU, amt: qa, fee }, { kind: 'out', tokenIn: Rt, tokenOut: tokD, amt: qa, fee }, { kind: 'out', tokenIn: Rt, tokenOut: tokU, amt: qb, fee }, { kind: 'out', tokenIn: Rt, tokenOut: tokD, amt: qb, fee });
      tags.push({ t: 'pa', i, side: 'UP' }, { t: 'pa', i, side: 'DOWN' }, { t: 'pb', i, side: 'UP' }, { t: 'pb', i, side: 'DOWN' });
    } else if (up || dn) {
      const row = up || dn; const side = row.side; const tok = side === 'UP' ? tokU : tokD; const stake = g18(row.stake);
      if (fin.dir && fin.dir.src === 'model-post-3a') continue; // post-set-sell row: no quoter path on the live state (checked against the model below)
      reqs.push({ kind: 'in', tokenIn: Rt, tokenOut: tok, amt: stake, fee }); tags.push({ t: 'dir', i, side, row, stake });
    }
  }
  const rq = reqs.length ? await io.quotes(reqs) : [];
  if (mkts.length) judgeMoved(await readPools());
  info.push(`live re-quote of ${reqs.length} sizes through the chain helper; markets whose pools moved since F read them: ${moved.size}`);
  let worst = 0; let worstWhat = ''; const failsHard = []; const failsDrift = [];
  const fail = (i, s) => (moved.has(i) ? failsDrift : failsHard).push(s);
  const bump = (i, d, w) => { if (moved.has(i)) return; if (d > worst) { worst = d; worstWhat = w; } };
  const setQ = new Map();
  // the merge-arb's own legs first: their sum against the row's stake (its cost), and the base the later legs subtract
  const maBase = new Map();
  tags.forEach((tg, k) => { if (tg.t !== 'ma') return; const x = rq[k]; const e = maBase.get(tg.i) || {}; e[tg.side] = x; maBase.set(tg.i, e); });
  for (const [i, e] of maBase) {
    const fin = FIN[i]; const st = (perM.get(lc(C[i].address)) || { rows: [] }).rows.find((r) => r.side === 'set');
    if (!e.UP.ok || !e.DOWN.ok) { fail(i, `${fin.market} merge-arb quote invalid`); continue; }
    const cost = wf(e.UP.amt + e.DOWN.amt); const d = Math.abs(cost - st.stake) / st.stake; bump(i, d, `${fin.market} merge-arb cost`);
    if (!moved.has(i) && d >= 1e-9) failsHard.push(`${fin.market} merge-arb cost drift ${d}`);
  }
  const less = (i, side, x) => { const b = maBase.get(i); return b && b[side] && b[side].ok && x.ok ? { ...x, amt: x.amt - b[side].amt } : x; };
  tags.forEach((tg, k) => {
    const x0 = rq[k]; const fin = FIN[tg.i]; const x = tg.t === 'leg' ? less(tg.i, tg.side, x0) : x0;
    if (tg.t === 'ma') return;
    if (tg.t === 'set') { if (!x.ok) fail(tg.i, `${fin.market} set quote invalid`); else { const a = setQ.get(tg.i) || { sum: 0n }; a.sum += x.amt; setQ.set(tg.i, a); } } else if (tg.t === 'leg') { if (!x.ok) fail(tg.i, `${fin.market} ${tg.side} leg exact-out quote invalid at count ${tg.cnt}`); else { const d = Math.abs(wf(x.amt) - tg.row.stake) / tg.row.stake; bump(tg.i, d, `${fin.market} ${tg.side} pair leg stake`); const fill = wf(x.amt) / wf(tg.cnt); bump(tg.i, Math.abs(fill - tg.row.quoted_fill) / tg.row.quoted_fill, `${fin.market} ${tg.side} leg fill`); if (!moved.has(tg.i) && d >= 1e-9) failsHard.push(`${fin.market} ${tg.side} leg stake drift ${d}`); } } else if (tg.t === 'dir') {
      if (!x.ok) fail(tg.i, `${fin.market} ${tg.side} dir quote invalid`); else {
        const fill = wf(tg.stake) / wf(x.amt); const d = Math.abs(fill - tg.row.quoted_fill) / tg.row.quoted_fill; bump(tg.i, d, `${fin.market} ${tg.side} directional fill`); if (!moved.has(tg.i) && d >= 1e-9) failsHard.push(`${fin.market} ${tg.side} directional fill drift ${d}`);
        // marginal-EV stop on the quoter's own sqrtAfter
        const Pafter = FL.priceOf(x.sqrtAfter, S.pools[tg.i * 2 + (tg.side === 'UP' ? 1 : 0)].T0); const pw = tg.row.p_win; const target = pw * (1 - fin.f);
        if (tg.row.limited_by === 'marginal-ev-zero' && Math.abs(Pafter / target - 1) > 1e-9) fail(tg.i, `${fin.market} ${tg.side} price after ${Pafter} vs p(1-f) ${target}`);
        if (tg.row.limited_by === 'market-budget' && !(Pafter <= target * (1 + 1e-12))) fail(tg.i, `${fin.market} ${tg.side} budget-limited ends above target`);
      }
    }
  });
  for (const [a, o] of perM) { const i = byAddr.get(a); const st = o.rows.find((r) => r.side === 'set'); if (!st) continue; const s = setQ.get(i); if (!s) continue; const proceeds = wf(s.sum); const d = Math.abs(proceeds / wf(g18(st.stake)) - st.quoted_fill) / st.quoted_fill; bump(i, d, `${C[i].market} set-sell fill`); if (!moved.has(i) && d >= 1e-9) failsHard.push(`${C[i].market} set-sell fill drift ${d}`); if (!(proceeds > wf(g18(st.stake)))) fail(i, `${C[i].market} set-sell proceeds ${proceeds} <= q`); }
  const pairMk = new Map();
  tags.forEach((tg, k) => { if (tg.t === 'pa' || tg.t === 'pb') { const e = pairMk.get(tg.i) || {}; e[tg.t + tg.side] = rq[k]; pairMk.set(tg.i, e); } });
  let pairOkN = 0;
  for (const [i, e] of pairMk) {
    const T0u = S.pools[i * 2 + 1].T0; const T0d = S.pools[i * 2].T0; const f = FIN[i].f;
    if (!e.paUP.ok || !e.paDOWN.ok) { fail(i, `${C[i].market} pair q not quotable now`); continue; }
    const sa = (FL.priceOf(e.paUP.sqrtAfter, T0u) + FL.priceOf(e.paDOWN.sqrtAfter, T0d)) / (1 - f);
    const sb = (e.pbUP.ok && e.pbDOWN.ok) ? (FL.priceOf(e.pbUP.sqrtAfter, T0u) + FL.priceOf(e.pbDOWN.sqrtAfter, T0d)) / (1 - f) : Infinity;
    const limitedBudget = FIN[i].pair && FIN[i].pair.limited === 'market-budget';
    if (!(sa <= 1)) fail(i, `${C[i].market} pair sum/(1-f) ${sa} > 1 at q`);
    if (!limitedBudget && !(sb > 1)) fail(i, `${C[i].market} pair sum/(1-f) ${sb} <= 1 at q(1+1e-6): q was not the maximum`);
    pairOkN++;
  }
  chk('E1 live re-quote reproduces every kept row\'s stake and quoted_fill on every market whose pools did not move (as G reads them: count = stake / quoted_fill)', failsHard.length === 0 && worst < 1e-9, `max relative drift ${worst.toExponential(2)} (${worstWhat || 'none'}); ${pairOkN} pair markets checked for q_max; failures: ${failsHard.slice(0, 6).join(' | ') || 'none'}; drift on moved markets: ${failsDrift.length}`);
  // post-set-sell rows: the artifact's number against the exact model re-run from the set-sell quote
  let postN = 0; const postBad = [];
  for (const [a, o] of perM) {
    const i = byAddr.get(a); const fin = FIN[i]; if (!(fin.dir && fin.dir.src === 'model-post-3a')) continue; const r = o.rows.find((x) => x.side === fin.dir.side); if (!r) continue; postN++;
    if (!near(r.stake, wf(FL.floor15(fin.dir.stake)), 1e-12) || !near(r.quoted_fill, wf(FL.floor15(fin.dir.stake)) / wf(fin.dir.tokens), 1e-9)) postBad.push(fin.market);
  }
  chk('E2 post-set-sell directional rows equal the exact model\'s numbers', postBad.length === 0, `${postN} row(s), inconsistent ${postBad.length}${postBad.length ? ': ' + postBad.join(', ') : ''}`);
  info.push(`post-set-sell rows: ${postN}; probe ${probe.length ? probe.map((x) => `${x.market} ${x.side}: ${x.ran ? 'gap ' + x.rel_gap.toExponential(1) : 'not run (' + x.why + ')'}`).join('; ') : 'not needed'}`);

  // ---------------- F: unspent tokens, accounting ----------------
  let unspentTotal = 0n; const per = [];
  for (let i = 0; i < N; i++) { const Bj = HELD[i] + Mw; const Sj = (perM.get(lc(C[i].address)) || { S: 0n }).S; per.push({ i, B: Bj, S: Sj, unspent: Bj - Sj }); unspentTotal += Bj - Sj; }
  const budgetsAll = per.reduce((s, x) => s + x.B, 0n); const spentTotal = [...perM.values()].reduce((s, o) => s + o.S, 0n);
  chk('F1 value accounting: sum of budgets (held_j + M) = spent + unspent', budgetsAll === spentTotal + unspentTotal, `budgets ${FL.weiStr(budgetsAll)}, spent ${FL.weiStr(spentTotal)}, unspent ${FL.weiStr(unspentTotal)}`);
  chk('F2 unspent >= 0 in every market', per.every((x) => x.unspent >= 0n), `min unspent ${FL.weiStr(per.reduce((m, x) => (x.unspent < m ? x.unspent : m), per[0].unspent))}`);
  info.push(`unspent repo tokens (held_j + M - S_j): total ${FL.weiStr(unspentTotal)}; markets at their budget ${per.filter((x) => x.B > 0n && x.unspent <= x.B / 10n ** 12n).length}; markets with no row ${per.filter((x) => x.S === 0n).length}; sUSDS left over after the mint: ${FL.weiStr(bankrollRaw - Mw)}`);

  const hard = checks.filter((c) => c.hard && !c.pass).map((c) => `${c.id}: ${c.detail}`);
  return { checks, hard, info, drift: { moved_markets: [...moved].sort((x, y) => x - y).map((i) => C[i].market), failures: failsDrift }, worst, unspentTotal };
}

module.exports = { verify };
