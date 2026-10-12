// planner/f-plan.cjs - F's driver (steps 5 to 7 and 9), ported from the live F plan script: plan the markets, size M,
// apply step 7's floors and the refill loop, and build the allocation.json object (written by f.cjs once verified).
//
// Unchanged from the live run: the iteration (unconstrained plans -> M = min(bankroll, max_j (cap_j - held_j)+) -> re-plan
// every market whose cap exceeds held_j + M -> floors -> repeat until no new drop), the floors (VOLUME_MIN 0.01 repo
// tokens; gas 2.4e-7 ETH per swap leg, 7 legs for a set group, 2 for a pair, one for a directional row; a folded extra
// has no gas floor), the 15-significant-digit numbers, and the row and skipped[] shapes. Plans are cached in memory per
// (market, options), as on the live run, so a re-run of the loop re-plans only what changed.
// Generalised for a later day: held_j is the holder's repo token plus its bundle's unsplit tokens (f-read), a market C
// marked tradeable false is skipped before 3a, 3b and 3, a blend with no candidate is skipped, and a held child Invalid
// (I_j > 0) on a sub-1 market is step 3a's merge-arb (f-engine): a set row (route merge-arb, stake = the quoted cost
// of q UP + q DOWN, quoted_fill = stake / q, ev = q - stake), its stake counted in the market's spend S_j; its returned
// q repo tokens are not recycled (F step 6).
'use strict';

const lib = require('./lib.cjs');
const FL = require('./f-lib.cjs');

const { PlannerError, Stop, clip } = lib;
const N = 98;
const VOLUME_MIN = 10n ** 16n; // 0.01 repo tokens (F step 7)

async function plan(R) {
  const { ctx, S, E, cands } = R;
  const say = (s) => ctx.log(s);
  const wf = FL.wf;
  const GAS_LEG = FL.numToWeiFloor(S.gas.gasLegRepo); // repo tokens per swap leg (2.4e-7 ETH, F step 7), wei
  const GAS_SET = 7n * GAS_LEG; const GAS_PAIR = 2n * GAS_LEG; // 7 legs per set group, 2 legs per pair (step 7's leg counts)
  // the whole sUSDS balance; with --provisional and a ramp queued, sUSDS + PSM3 minAmountOut of all USDC and USDS (f-read)
  const BANKROLL = FL.floor15(BigInt(S.provisionalBankroll !== null && S.provisionalBankroll !== undefined ? S.provisionalBankroll : S.balances.sUSDS));
  const HELD = S.balances.heldEff.map(BigInt); // held_j: repo token + its bundle's unsplit tokens
  const CHILD_INV = S.balances.childInv.map(BigInt);
  const TRADE = S.tradeable;

  const cache = new Map();
  const optKey = (o) => JSON.stringify(o, FL.rep);
  async function getPlan(i, opt) {
    const key = i + '|' + optKey(opt);
    if (cache.has(key)) return cache.get(key);
    let r;
    for (let a = 0; a < 3; a++) {
      try { r = await E.planMarket(i, opt); break; } catch (e) {
        if (e instanceof PlannerError || e instanceof Stop || a === 2) throw e;
        say(`  market ${i}: retry after ${clip(e.message, 200)}`);
      }
    }
    cache.set(key, r);
    return r;
  }
  // A market C marked not tradeable: no plan, no quote (F step 1: skipped before 3a, 3b and 3).
  const stub = (i) => ({ i, market: cands[i].market, address: FL.lc(cands[i].address), notTradeable: true, set: null, pair: null, dir: null, cap: 0n, caps: { arb: 0n, pair: 0n, dir: 0n }, checks: [], notes: [], gaps: [], hasBlend: !!S.blendAddr[i], p: null, spot: null, cls: null, clsSnap: null, sym: cands[i].collateral_symbol });
  const planOrStub = (i, opt) => (TRADE[i] ? getPlan(i, opt) : Promise.resolve(stub(i)));

  const flags = Array.from({ length: N }, () => ({ dropSet: false, dropPair: false, dropDir: { UP: false, DOWN: false } }));
  const optOf = (i, B) => { const o = { dropSet: flags[i].dropSet, dropPair: flags[i].dropPair, dropDir: { ...flags[i].dropDir } }; if (B !== undefined) o.B = B; return o; };
  const dropLog = [];
  const evOfSet = (s) => (s.route === 'set-sell' ? s.proceeds - s.q : s.route === 'merge-arb' ? s.q - s.cost : 0n);
  const ceil15 = (w) => { const f = FL.floor15(w); return f === w ? w : f + (10n ** BigInt(w.toString().length - 15)); };

  say(`F plan: bankroll ${FL.weiStr(BANKROLL)} sUSDS (${S.provisional ? `PROVISIONAL: sUSDS ${S.balances.sUSDS} + PSM3 minAmountOut ${S.provisional.usdc_min_out} (USDC) + ${S.provisional.usds_min_out} (USDS)` : `the holder's whole sUSDS balance, raw ${S.balances.sUSDS}`}); VOLUME_MIN 0.01; gas leg ${FL.weiStr(GAS_LEG)} repo tokens (2.4e-7 ETH x ${S.gas.susdsPerEth.toFixed(2)} sUSDS/ETH x 98); set group 7 legs = ${FL.weiStr(GAS_SET)}, pair 2 legs = ${FL.weiStr(GAS_PAIR)}; markets with held_j > 0: ${HELD.filter((h) => h > 0n).length}`);
  let iter = 0; let M = 0n; let argmax = -1; let capMax = 0n;
  const res = new Array(N).fill(null); const unc = new Array(N).fill(null);
  const nothingToSpend = BANKROLL === 0n && HELD.every((h) => h === 0n);
  if (nothingToSpend) {
    // No sUSDS and no repo token held anywhere: every budget held_j + M is 0, so no row can exist. Nothing is quoted.
    for (let i = 0; i < N; i++) { const s = stub(i); s.notTradeable = !TRADE[i]; s.zeroBudget = true; res[i] = s; unc[i] = s; }
    iter = 1;
    say('every budget held_j + M is 0 (no sUSDS, no repo token or bundle token held): no market can take a row; nothing quoted');
  } else {
    for (;;) {
      iter++; say('--- iteration ' + iter);
      const t0 = Date.now();
      await Promise.all(Array.from({ length: N }, (_, i) => planOrStub(i, optOf(i)).then((r) => { unc[i] = r; })));
      const caps = unc.map((r, i) => (r.cap > HELD[i] ? r.cap - HELD[i] : 0n));
      capMax = caps.reduce((a, b) => (a > b ? a : b), 0n); argmax = caps.indexOf(capMax);
      M = FL.bigMin(BANKROLL, ceil15(capMax));
      say(`unconstrained plans done (${((Date.now() - t0) / 1000).toFixed(0)}s). M = min(bankroll ${FL.weiStr(BANKROLL)}, max_j (cap_j - held_j)+ = ${FL.weiStr(capMax)} at market ${argmax} ${unc[argmax].market}) = ${FL.weiStr(M)} sUSDS -> ${M === BANKROLL ? 'the BANKROLL binds' : 'the books bind'}`);
      let nb = 0; const t1 = Date.now();
      await Promise.all(Array.from({ length: N }, async (_, i) => {
        const budget = HELD[i] + M;
        if (unc[i].cap <= budget) res[i] = unc[i]; else { res[i] = await planOrStub(i, optOf(i, budget)); nb++; }
      }));
      say(`${nb} market(s) re-planned under the budget held_j + M (${((Date.now() - t1) / 1000).toFixed(0)}s)`);
      // ----- step 7 floors -----
      let newDrops = 0;
      for (let i = 0; i < N; i++) {
        const r = res[i]; const f = flags[i]; const before = newDrops;
        if (r.set && !f.dropSet) {
          const ev = evOfSet(r.set); const why = r.set.q < VOLUME_MIN ? 'volume-min' : (ev <= GAS_SET ? 'gas' : null);
          if (why) { f.dropSet = true; newDrops++; dropLog.push({ i, market: r.market, row: r.set.route, limited_by: why, ev, q: r.set.q, gas: GAS_SET, iteration: iter }); }
        }
        if (r.pair && !f.dropPair) {
          const gain = r.pair.q - r.pair.cost; // scored-case gain of the legs' cost of q, before any folded extra
          const why = (r.pair.upIn < VOLUME_MIN || r.pair.dnIn < VOLUME_MIN) ? 'volume-min' : (gain <= GAS_PAIR ? 'gas' : null);
          if (why) { f.dropPair = true; newDrops++; dropLog.push({ i, market: r.market, row: 'pair', limited_by: why, gain, q: r.pair.q, gas: GAS_PAIR, iteration: iter }); }
        }
        // a directional row sized on the post-3a / post-3b state of a set or pair dropped in this pass has lost its basis: re-size it in the re-run
        if (r.dir && !f.dropDir[r.dir.side] && newDrops === before) {
          let why = null; const evw = r.dir.ev;
          if (r.dir.folded) { if (r.dir.extraStake < VOLUME_MIN) why = 'volume-min'; } else if (r.dir.stake < VOLUME_MIN) why = 'volume-min'; else if (FL.numToWeiFloor(evw) <= GAS_LEG) why = 'gas';
          if (why) { f.dropDir[r.dir.side] = true; newDrops++; dropLog.push({ i, market: r.market, row: 'directional ' + r.dir.side + (r.dir.folded ? ' (folded extra)' : ''), limited_by: why, ev: evw, stake: r.dir.folded ? r.dir.extraStake : r.dir.stake, gas: GAS_LEG, iteration: iter }); }
        }
      }
      say(`floors: ${newDrops} new drops`);
      if (!newDrops) break;
      if (iter > 10) throw new Stop({ step: 'F', cause: 'refill-not-converging', status: 'aborted', notes: 'F stop (no allocation written): step 7\'s refill loop did not converge in 10 iterations' });
    }
  }
  say(`converged after ${iter} iteration(s); M = ${FL.weiStr(M)} sUSDS`);

  // ---------- assemble allocation.json ----------
  const positions = []; const skipped = [];
  let sumEv = 0; const perMarket = [];
  const e15 = (w) => FL.floor15(w);
  for (let i = 0; i < N; i++) {
    const r = res[i]; const fl = flags[i]; const rows = []; const base = { market: r.market, address: r.address, stake_unit: r.sym };
    if (r.notTradeable || r.zeroBudget) {
      perMarket.push({ i, market: r.market, S_j: 0n, budget: HELD[i] + M, held: HELD[i], rows: 0 });
      skipped.push({ market: r.market, reason: r.notTradeable ? 'tradeable false in candidates.json (C step 5): no 3a, 3b or directional trade' : 'budget held_j + M is 0 (no sUSDS and no repo token held): no row' });
      continue;
    }
    const dir = (r.dir && !fl.dropDir[r.dir.side]) ? r.dir : null;
    let S_j = 0n;
    if (r.set && !fl.dropSet && r.set.route === 'merge-arb') {
      // F step 3a / schema: stake = the quoted cost of q UP + q DOWN, quoted_fill = stake / q (G recovers q = stake /
      // quoted_fill, then clamps it at the held child Invalid), ev = q - stake
      const s = r.set; const stakeE = e15(s.cost); S_j += s.cost; const stake = FL.fromWei(stakeE);
      rows.push({ ...base, side: 'set', route: 'merge-arb', stake, quoted_fill: stake / wf(s.q), edge_pts: null, ev: wf(s.q) - stake, p_win: null, worst_case: 0, limited_by: s.limited, _w: { stake: s.cost, q: s.q } });
    } else if (r.set && !fl.dropSet) {
      const s = r.set; const stake = e15(s.q); S_j += s.q;
      rows.push({ ...base, side: 'set', route: 'set-sell', stake: FL.fromWei(stake), quoted_fill: wf(s.proceeds) / wf(s.q), edge_pts: null, ev: wf(s.proceeds - s.q), p_win: null, worst_case: 0, limited_by: s.limited, _w: { stake: s.q, proceeds: s.proceeds } });
    }
    if (r.pair && !fl.dropPair) {
      const pr = r.pair;
      for (const side of ['UP', 'DOWN']) {
        const folded = dir && dir.folded && dir.side === side;
        const legStake = folded ? dir.legStake : (side === 'UP' ? pr.upIn : pr.dnIn);
        const count = folded ? dir.count : pr.q;
        const stakeE = e15(legStake); const countE = e15(count); S_j += legStake;
        const stake = FL.fromWei(stakeE); const cnt = FL.fromWei(countE); const fill = stake / cnt;
        const pw = r.p ? r.p[side] : null; let ev;
        if (pw !== null) ev = stake * (pw / fill - 1);
        else ev = wf(pr.q - pr.cost) * wf(side === 'UP' ? pr.upIn : pr.dnIn) / wf(pr.cost);
        rows.push({ ...base, side, route: 'direct', stake, quoted_fill: fill, edge_pts: pw === null ? null : (pw - fill) * 100, ev, p_win: pw, worst_case: -stake, limited_by: folded ? dir.limited : pr.limited, _w: { stake: legStake, count, folded: !!folded } });
      }
    } else if (dir) {
      const stakeE = e15(dir.stake); S_j += dir.stake; const stake = FL.fromWei(stakeE); const fill = stake / wf(dir.tokens);
      rows.push({ ...base, side: dir.side, route: 'direct', stake, quoted_fill: fill, edge_pts: (dir.p - fill) * 100, ev: stake * (dir.p / fill - 1), p_win: dir.p, worst_case: -stake, limited_by: dir.limited, _w: { stake: dir.stake, count: dir.tokens, folded: false, src: dir.src } });
    }
    for (const x of rows) { sumEv += x.ev; positions.push(x); }
    const budget = HELD[i] + M;
    perMarket.push({ i, market: r.market, S_j, budget, held: HELD[i], rows: rows.length });
    const reasons = dropLog.filter((d) => d.i === i).map((d) => `${d.row} dropped by step 7 (limited_by ${d.limited_by}): ` + (d.ev !== undefined ? `ev ${wf(typeof d.ev === 'bigint' ? d.ev : FL.numToWeiFloor(d.ev)).toFixed(4)}` : `gain ${wf(d.gain).toFixed(4)}`) + ` repo tokens vs ${d.limited_by === 'gas' ? 'gas ' + wf(d.gas).toFixed(4) : 'VOLUME_MIN 0.01'}`);
    if (!rows.length || reasons.length) {
      let why = `spot sum ${r.spot.sum.toFixed(6)}`;
      if (!rows.length) {
        if (!r.hasBlend) why += '; no CSV forecast (blank cell: no directional trade)' + (r.cls === 'band' ? '; sum within [1-f, 1/(1-f)] so neither 3a nor 3b applies' : '');
        else why += `; p = [${r.p.DOWN}, ${r.p.UP}, 0]; ` + ((fl.dropDir.UP || fl.dropDir.DOWN) ? 'no side clears p(1-f) > price at the final prices except the directional row(s) dropped by step 7 below' : 'neither side clears p(1-f) > price') + (r.cls === 'band' ? '; sum within [1-f, 1/(1-f)] so neither 3a nor 3b applies' : '');
        if (HELD[i] + M === 0n) why += '; budget held_j + M is 0';
      }
      skipped.push({ market: r.market, reason: [why, ...reasons].join('; ') });
    }
  }
  for (const o of S.orphans || []) skipped.push({ market: o.market, reason: 'a blend with no candidate in candidates.json (F step 1)' });
  const artifact = {
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    bankroll: FL.fromWei(BANKROLL), bankroll_unit: 'sUSDS', objective: 'max-ev',
    positions: positions.map(({ _w, ...x }) => x),
    skipped,
    totals: { staked: FL.fromWei(M), expected_value: sumEv / N, correlated_worst_case: -FL.fromWei(M) },
  };
  // the merge-arb rows kept (F step 3a), each consuming q of the child Invalid I_j the holder holds from earlier runs
  const mergeArbs = res.filter((r) => r && r.set && r.set.route === 'merge-arb' && !flags[r.i].dropSet).map((r) => ({ i: r.i, market: r.market, q: r.set.q, cost: r.set.cost, childInvalidHeld: CHILD_INV[r.i], limited: r.set.limited, remainderPair: r.pair && !flags[r.i].dropPair ? r.pair.q : 0n }));
  const aux = { M, iter, flags, dropLog, perMarket, caps: res.map((r) => r.cap), uncCaps: unc.map((r) => r.cap), capMax, GAS_LEG, GAS_SET, GAS_PAIR, VOLUME_MIN, BANKROLL, argmax, sumEv, mergeArbs, nothingToSpend, rows: positions };
  say(`allocation: ${positions.length} rows over ${new Set(positions.map((r) => r.address)).size} markets, ${skipped.length} skipped entries, M ${FL.weiStr(M)}, sum ev ${sumEv.toFixed(4)} repo tokens, expected_value ${(sumEv / N).toFixed(6)} sUSDS at 1/98`);
  return { res, unc, flags, aux, artifact };
}

module.exports = { plan, VOLUME_MIN };
