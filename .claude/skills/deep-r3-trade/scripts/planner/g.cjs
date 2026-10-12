// planner/g.cjs - `planner g <run-id> [--indep]`: steps/G-mint-and-trade.md's build as one call, writing
// ./run/<run-id>/g-plan.json, ./run/<run-id>/gate-print.md and ./run/<run-id>/g-tx/tx-NNN.json. Ported from the live G scripts
// (g-read, g-build, g-verify, g-emit, g-audit, g-indep) that built the first live run's plan; their logic and order are kept.
//
//   1. read   (g-read)   the nonce (latest == pending), the inputs, onchain identity, both pools of each market in one
//                        multicall (its pin), the pool-drift report against F's read, the balances, the trading boundary
//                                                                                    -> planner/g-state.json, g-drift.json
//   2. build  (g-build)  the mint, the routes, the quotes (post-set-sell legs probed on simulated state), the groups in
//                        send order, the whole-sequence simulation (windowed only when it must be)  -> planner/g-built.json
//   3. verify (g-verify) helper encode == ethers on every calldata, one signer-input file per transaction and the signer's
//                        policy-only `check` on each, the predicted vs simulated end state      -> g-tx/, planner/g-verified.json
//   4. indep  (g-indep)  only with --indep (supervised): the independent second-RPC read, written as a request
//   5. emit   (g-emit)   g-plan.json and gate-print.md
//   6. audit  (g-audit)  the written plan re-derived from its sources, then a fresh re-simulation; a failure removes g-plan.json
//
// No step compares block numbers or hashes between two reads (G section 8, The head moves): validity rests on the holder's
// nonce (latest == pending == the plan's, checked at every stage: a move is exit 4), the per-market pin, the drift report,
// each call's floor and the pre-send re-check the executor makes. G never signs and never sends: the signer is run only for
// its policy-only `check`. A run-id whose sends have started is refused (C to F, and so G, re-run only before the first
// broadcast; the one exception is a run-id whose only sends are its landed PSM3 ramp, which the wake sends ahead of F, G
// section 1); an earlier plan of this run-id is removed first, so a failed re-run never leaves a stale plan behind.
//
// A failing simulation (the build's whole-sequence simulation, verify's end-state probe, the audit's fresh
// re-simulation, or an infeasible dual-buy leg) is the G stop the wake re-plans on once (stale_simulation, with the
// first failing group). With cutAtFailure (the wake's rebuilt plan, or any plan after the run's first broadcast, e.g. a
// PSM3 ramp) a second such failure does not stop G: it reads and builds again with the plan cut at the failing group,
// the groups before it sendable, the failing group and every later one written skipped (G section 8, A failing
// pre-send simulation; I-setup.md I.2 section 5 item 3).
'use strict';

const lib = require('./lib.cjs');
const FL = require('./f-lib.cjs');
const G = require('./g-lib.cjs');
const { read } = require('./g-read.cjs');
const { build } = require('./g-build.cjs');
const { verify } = require('./g-verify.cjs');
const { writeRequest } = require('./g-indep.cjs');
const { emit } = require('./g-emit.cjs');
const { audit } = require('./g-audit.cjs');
const { rampOnlySends } = require('./ramp.cjs');

const { Stop } = lib;
const SENT_MARKERS = ['fills.json', 'inflight.json', 'inflight.settled.json', 'nonce-attempts.json'];

function removeOutputs(ctx, { keepPrint = false } = {}) {
  const removed = [];
  const rm = (name) => { if (ctx.existsRun(name)) { ctx.removeRun(name); removed.push(name); } };
  rm('g-plan.json'); rm('g-indep-request.json');
  if (!keepPrint) { rm('gate-print.md'); rm('planner/g-plan.rejected.json'); }
  for (const f of lib.listRunSubdir(ctx.cfg, ctx.runId, 'g-tx')) rm('g-tx/' + f);
  for (const f of lib.listRunSubdir(ctx.cfg, ctx.runId, 'g-tmp')) rm('g-tmp/' + f);
  if (!keepPrint) for (const f of ctx.listRunDir(ctx.runId)) if (/^g-sim-[A-Za-z0-9-]+\.json$/.test(f)) rm(f);
  return removed;
}

async function run(ctx) {
  // the wake's PSM3 ramp is sent ahead of F and G (G section 1): a run-id whose only sends are its landed ramp is not refused
  const rampOnly = rampOnlySends(ctx);
  for (const name of SENT_MARKERS) {
    if (ctx.existsRun(name) && !(rampOnly && ['inflight.settled.json', 'nonce-attempts.json'].includes(name))) throw new Stop({ step: 'G', cause: 'broadcast-started', status: 'aborted', notes: `G refused: ${ctx.rel(name)} exists, so this run-id's sends have started; a plan is built only before a run's first broadcast (G section 1), so start a fresh run-id` });
  }
  if (!ctx.existsRun('allocation.json')) throw G.gstop('allocation-missing', `${ctx.rel('allocation.json')} does not exist: run F first`);
  const removed = removeOutputs(ctx);
  if (removed.length) ctx.log(`removed the earlier G outputs of this run-id before re-running G: ${removed.join(', ')}`);

  const E = ctx.ethers();
  const io = G.makeIO(ctx);
  const R = { ctx, io, E, cutAt: null, cutGroupId: null };
  const t0 = Date.now();
  let stage = 'read';
  try {
    let built; let V; let EM; let AU;
    for (;;) {
      try {
        // 1. read
        stage = 'read';
        R.S = await read(R);
        ctx.writeRun('planner/g-state.json', JSON.stringify(R.S, FL.rep));
        // 2. build
        stage = 'build';
        built = await build(R);
        ctx.writeRun('planner/g-built.json', JSON.stringify({ ...built, tm: built.tm.map((m) => ({ ...m })) }, FL.rep));
        // 3. verify
        stage = 'verify';
        V = await verify(R, built);
        ctx.writeRun('planner/g-verified.json', JSON.stringify(V, FL.rep));
        // 4. the independent read, as a request (supervised only)
        R.indep = ctx.opts.indep ? writeRequest(R, built) : { ran: false, reason: 'skipped: the independent second-RPC read is supervised-only (the chain helper pins one RPC and the planner contacts none itself); pass --indep in a supervised session to write the request' };
        // 5. emit
        stage = 'emit';
        EM = await emit(R, built, V);
        // 6. audit
        stage = 'audit';
        AU = await audit(R);
        break;
      } catch (e) {
        // the rebuilt plan failed its simulation again: cut it at the failing group, once (G section 8)
        const f = e instanceof Stop ? e.fields || {} : {};
        if (!ctx.opts.cutAtFailure || R.cutAt !== null || f.stale_simulation !== true || !Number.isInteger(f.first_failed_group)) throw e;
        R.cutAt = f.first_failed_group; R.cutGroupId = f.first_failed_group_id || null;
        ctx.log(`the plan failed its simulation at group ${R.cutAt} (${R.cutGroupId}; ${e.cause}): rebuilt once with that group and every later one skipped`);
        removeOutputs(ctx);
      }
    }

    const S = R.S; const plan = EM.plan;
    const nTx = built.nTx;
    ctx.detail.timing_s = Math.round((Date.now() - t0) / 1000);
    ctx.detail.quote_stats = io.stats;
    const artifacts = [ctx.rel('g-plan.json'), ctx.rel('gate-print.md'), `${ctx.rel('g-tx')}/ (${nTx} file${nTx === 1 ? '' : 's'})`, ...plan.simulation.windows.map((w) => w.file), ctx.rel('planner/g-drift.json'), ctx.rel('planner/g-state.json'), ctx.rel('planner/g-built.json'), ctx.rel('planner/g-verified.json')];
    if (R.indep && R.indep.request) artifacts.push(R.indep.request);
    return {
      nothing_to_send: built.groups.length === 0,
      groups: built.groups.length,
      transactions: nTx,
      by_kind: built.kinds,
      markets: built.tm.length,
      rows_in_groups: plan.route_counts.rows_in_groups,
      skipped_rows: built.skippedRows.length,
      skipped: built.skippedRows.slice(0, 5).map((r) => `${r.market} ${r.side}: ${lib.clip(r.reason, 120)}`),
      mint: { M: G.weiStr(built.M), parent_split: built.M > 0n, middles: built.groups.filter((g) => g.id.startsWith('mint-middle-')).map((g) => g.id.slice(-1)), bundles_with_position: S.bundlesWithPosition },
      ramp_due: S.rampDue,
      cut: built.cut,
      nonce: S.nonce.pending,
      first_last_nonce: nTx ? [S.nonce.pending, S.nonce.pending + nTx - 1] : null,
      drift: { pools_compared: S.drift.pools_compared, pools_moved: S.drift.pools_moved, markets_moved: S.drift.markets_moved.slice(0, 10), fresh_quote_vs_f_max_rel_gap: built.worstRel },
      simulation: { requests: plan.simulation.requests, windowed: plan.simulation.windowed, all_success: plan.simulation.all_success, sum_gas_used: plan.simulation.sum_gas_used, sum_gas_limit: plan.simulation.sum_gas_limit, largest_gas_limit: plan.simulation.largest_gas_limit, no_max_used_gas_count: plan.simulation.no_max_used_gas_count },
      verify: { encode_identical: nTx, signer_check_allowed: nTx, end_state: { probed: V.probes, matched: V.matched, differ: V.mismatches.length } },
      eth: { holder_eth: G.weiStr(EM.ethFund.holder_eth_wei), cost_at_gas_price_eth: EM.ethFund.scenarios[0].total_cost_eth, cost_at_signer_ceiling_eth: EM.ethFund.scenarios[1].total_cost_eth, affordable: EM.ethFund.affordable },
      route_agreement: built.agreement.map((a) => ({ market: a.market, agree: a.agree })),
      audit: { failures: AU.failures, rows_checked: AU.rows_checked, gas_used_differ: AU.gas_used_differ },
      indep: R.indep.request ? { request: R.indep.request, reads: R.indep.reads } : { ran: false, reason: R.indep.reason },
      helper_calls: io.getCalls(),
      seconds: Math.round((Date.now() - t0) / 1000),
      artifacts,
    };
  } catch (e) {
    // no plan is left behind by a failed build; the audit keeps its own record (planner/g-plan.rejected.json, gate-print.md)
    try { removeOutputs(ctx, { keepPrint: stage === 'audit' }); } catch (x) { ctx.log(`cleanup after the ${stage} failure: ${lib.clip(x.message, 200)}`); }
    ctx.log(`G stopped at the ${stage} stage`);
    if (e instanceof Stop) e.fields = { ...e.fields, stage };
    throw e;
  }
}

module.exports = { run };
