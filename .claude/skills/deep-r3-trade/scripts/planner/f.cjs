// planner/f.cjs - `planner f <run-id>`: steps/F-max-ev.md as one call, writing ./run/<run-id>/allocation.json and
// ./run/<run-id>/f-print.md. Ported from the live F scripts (read, engine, plan, probe-post3a, verify, print) that sized
// the first live run; the math, the per-market pin and the order of the steps are theirs.
//
//   1. read  (f-read)   inputs, the holder's balances, every tradeable market's two pools at one block per market,
//                       their active ranges, the gas inputs                       -> planner/f-state.json
//   2. plan  (f-engine, f-plan)  steps 3a, 3b, 3 to 7 and 9, quoted on QuoterV2  -> the allocation object
//   3. probe (f-probe-post3a)    rows sized on the state a set-sell leaves, confirmed on simulated state
//   4. verify (f-verify)  every invariant on the exact bytes, then a live re-quote of every kept row; a hard failure is
//                       an F stop and nothing is written                         -> planner/f-verify.json
//   5. write allocation.json, then the plan print f-print.md (f-print)
// F never signs, never sends and builds no transaction; every chain read goes through the chain helper. A run-id whose
// sends have started (fills.json or inflight.json present) is refused: C to F re-run only before the run's first
// broadcast (SKILL.md, Running it). An earlier allocation.json and f-print.md of this run-id are removed first, so a
// failed re-run never leaves a stale plan behind.
//
// --provisional (supervised sessions only; the wake never passes it and inside the wrapper's lock it is refused): when
// USDC or USDS is held and their PSM3 ramp is queued but has not landed, the bankroll is provisional, the sUSDS balance
// plus PSM3 minAmountOut for all of it (F-max-ev.md, intro), and the print and the summary say so. G's stale-susds stop
// refuses such a plan until the ramp has landed and F has re-run. allocation.json carries no extra key.
'use strict';

const lib = require('./lib.cjs');
const FL = require('./f-lib.cjs');
const { read } = require('./f-read.cjs');
const { makeEngine } = require('./f-engine.cjs');
const { plan } = require('./f-plan.cjs');
const { probePost3a } = require('./f-probe-post3a.cjs');
const { verify } = require('./f-verify.cjs');
const { printPlan } = require('./f-print.cjs');

const { Stop } = lib;

async function run(ctx) {
  if (ctx.opts.provisional) { const L = lib.readLock(ctx.cfg); if (L.exists && L.owner && L.owner.stage === 'claude-p') throw new lib.PlannerError('usage', 'f --provisional is for a supervised session whose PSM3 ramp is queued; the scheduled run sends the ramp before F and never sizes on a provisional bankroll', lib.EXIT.USAGE); }
  for (const name of ['fills.json', 'inflight.json']) {
    if (ctx.existsRun(name)) throw new Stop({ step: 'F', cause: 'broadcast-started', status: 'aborted', notes: `F refused: ${ctx.rel(name)} exists, so this run-id's sends have started; C to F re-run only before a run's first broadcast (SKILL.md, Running it), so start a fresh run-id` });
  }
  for (const name of ['allocation.json', 'f-print.md']) if (ctx.existsRun(name)) { ctx.removeRun(name); ctx.log(`removed the earlier ${ctx.rel(name)} of this run-id before re-running F`); }

  const io = FL.makeIO(ctx);
  const R = { ctx, io, provisional: !!ctx.opts.provisional };
  const t0 = Date.now();

  // 1. read
  const S = await read(R);
  R.S = S;
  ctx.writeRun('planner/f-state.json', JSON.stringify(S, FL.rep));
  const tRead = Date.now();

  // 2. plan
  const E = makeEngine({ S, cands: R.cands, blends: R.blends, io });
  R.E = E;
  const Pl = await plan(R);
  const tPlan = Date.now();

  // 3. probe the rows sized on a post-set-sell state
  const probe = await probePost3a(R, Pl);

  // 4. verify the exact bytes before writing them
  const text = JSON.stringify(Pl.artifact, null, 2);
  const V = await verify(R, { text, res: Pl.res, flags: Pl.flags, aux: Pl.aux, gaps: E.gaps, probe });
  let gapsMax = 0; E.gaps.forEach((g) => { if (g.model === undefined || g.quoter === undefined) return; const d = Math.abs(Number(BigInt(g.model) - BigInt(g.quoter))) / Number(BigInt(g.quoter)); if (d > gapsMax) gapsMax = d; });
  ctx.writeRun('planner/f-final.json', JSON.stringify(Pl.res.map((r, i) => ({ ...r, opt: Pl.flags[i] })), FL.rep));
  ctx.writeRun('planner/f-aux.json', JSON.stringify({ ...Pl.aux, rows: undefined }, FL.rep));
  ctx.writeRun('planner/f-gaps.json', JSON.stringify(E.gaps, FL.rep));
  ctx.writeRun('planner/f-verify.json', JSON.stringify({ checks: V.checks, hard: V.hard, info: V.info, drift: V.drift, probe }, FL.rep, 1));
  for (const c of V.checks) ctx.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.id}${c.detail ? ' :: ' + c.detail : ''}`);
  for (const s of V.info) ctx.log(`   info: ${s}`);
  if (V.hard.length) {
    throw new Stop({ step: 'F', cause: 'self-check-failed', status: 'aborted', notes: `F stop (no allocation written): the plan failed its own check: ${V.hard.slice(0, 3).join(' | ').slice(0, 1500)}`, fields: { failed_checks: V.hard.length, verify_detail: ctx.rel('planner/f-verify.json') } });
  }

  // 5. write
  ctx.writeRun('allocation.json', text);
  const md = printPlan(R, { artifact: Pl.artifact, res: Pl.res, flags: Pl.flags, aux: Pl.aux, probe, V, gapsMax });
  ctx.writeRun('f-print.md', md);

  const A = Pl.artifact; const P = A.positions;
  const markets = new Map(); P.forEach((r) => { const o = markets.get(r.address) || { up: false, dn: false, set: false }; if (r.side === 'UP') o.up = true; if (r.side === 'DOWN') o.dn = true; if (r.side === 'set') o.set = true; markets.set(r.address, o); });
  const pins = FL.blockRange(S.pinOfMarket);
  const pools = S.pools.filter(Boolean);
  ctx.detail.timing_s = { read: Math.round((tRead - t0) / 1000), plan: Math.round((tPlan - tRead) / 1000), total: Math.round((Date.now() - t0) / 1000) };
  ctx.detail.quote_stats = io.stats;
  return {
    rows: P.length,
    markets_with_rows: markets.size,
    pair_markets: [...markets.values()].filter((o) => o.up && o.dn).length,
    set_rows: P.filter((r) => r.side === 'set').length,
    single_side_rows: [...markets.values()].filter((o) => o.up !== o.dn).length,
    markets_without_row: 98 - markets.size,
    skipped_entries: A.skipped.length,
    bankroll: A.bankroll,
    staked_M: A.totals.staked,
    binds: Pl.aux.nothingToSpend ? 'nothing-to-spend' : (BigInt(Pl.aux.M) === BigInt(Pl.aux.BANKROLL) ? 'bankroll' : 'books'),
    expected_value: A.totals.expected_value,
    correlated_worst_case: A.totals.correlated_worst_case,
    iterations: Pl.aux.iter,
    step7_drops: Pl.aux.dropLog.length,
    tradeable_markets: S.tradeable.filter(Boolean).length,
    held_markets: S.balances.heldEff.filter((h) => BigInt(h) > 0n).length,
    child_invalid_markets: S.balances.childInv.filter((x) => BigInt(x) > 0n).length,
    merge_arb_markets: Pl.aux.mergeArbs.map((x) => x.market),
    ramp_due: S.rampDue,
    provisional: !!S.provisional,
    provisional_min_out: S.provisional ? { usdc: String(S.provisional.usdc_min_out), usds: String(S.provisional.usds_min_out) } : null,
    usdc_raw: String(S.balances.USDC),
    usds_raw: String(S.balances.USDS),
    body_used: S.body_used,
    ranges: { from_body: pools.filter((p) => p.rangeSource && p.rangeSource.startsWith('data-function')).length, from_tickbitmap: pools.filter((p) => p.rangeSource && p.rangeSource.startsWith('readInitialized')).length },
    pins,
    post3a_rows: probe.length,
    probe: probe.map((x) => ({ market: x.market, side: x.side, ran: x.ran, confirmed: x.confirmed === true, rel_gap: x.rel_gap === undefined ? null : x.rel_gap, why: x.why || null })),
    checks: { passed: V.checks.filter((c) => c.pass).length, total: V.checks.length },
    drift_markets: V.drift.moved_markets.length,
    drift_list: V.drift.moved_markets.slice(0, 10),
    model_gap_max: gapsMax,
    helper_calls: io.getCalls(),
    quotes: io.stats,
    seconds: Math.round((Date.now() - t0) / 1000),
    artifacts: [ctx.rel('allocation.json'), ctx.rel('f-print.md'), ctx.rel('planner/f-state.json'), ctx.rel('planner/f-verify.json'), ctx.rel('planner/f-final.json'), ctx.rel('planner/f-aux.json'), ctx.rel('planner/f-gaps.json')],
  };
}

module.exports = { run };
