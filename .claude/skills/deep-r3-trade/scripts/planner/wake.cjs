// planner/wake.cjs - `planner wake <run-id>`: the whole scheduled run in one call (I-setup.md I.2 sections 1, 2, 6),
// in the skill's order and with its stop rules:
//   0. only inside the wrapper: run/.lock.deep-r3-trade held by the wrapper (stage "claude-p") naming this run-id; its
//      started_at is the run's start, its live-runs.txt the run-ids never touched;
//   1. wake-status.json written `aborted` FIRST; then the four gates of I.2 section 1 and G section 8 Two modes
//      (autonomy.enabled, autonomy.authorized_at, autonomy.signer_selftest_passed_at,
//      schedule.signer_allow_rule_added_at): a null or false one is named in notes, report.md is written and the wake
//      stops (status stays aborted); a setup in signer mode (b), signer_mode executor-session-key, stops the same way
//      first, cause unsupported-signer-mode (I.2 section 7, The planner);
//   2. the start-of-run repair of every prior run-id of this arm with an inflight file that is not final (G section 8,
//      Runs that die mid-way): its nonce settled by G section 8 step 4 (the block scan bounded by this run's deadline and
//      resumed at the next wake), a chain-mismatch closed, the missing fills.json row of a transaction that landed after
//      its run stopped appended (from the signed calldata, never a row removed); then, once every nonce is settled and
//      nothing blocks a send, G section 8 step 4's recovery rule on each half-done group (exec.recoverGroup, sent under the
//      wrapper's lock in that run-id); a run-id finalized with "repaired by" once nothing of it is half-done; a not-sent
//      finding on a signer that cannot pin the nonce is first consumed by the wake's own cancel, and once every nonce is
//      settled the signer's reconcile releases a settled send's lock (exec-core, G section 8 Nonce pinning); a Pending
//      nonce, a not-sent finding the cancel did not consume, or a send-lock reconcile keeps blocks every send of this wake;
//   3. Half A: c, d (the stored CSV only), e, then the PSM3 ramp of any USDC and USDS at the holder (planner/ramp.cjs,
//      I-setup.md I.1 section 5, I.2 section 2 Half A: its own simulated and sent batch, the run's first broadcast; a
//      ramp that stops, is refused or leaves a nonce Pending ends Half A before F, kept aborted when a nonce is
//      unsettled), then f (on the post-ramp sUSDS, read fresh), g, exec. ONE once-only re-plan (I-setup.md I.2 section 5 item 3, G
//      section 8 A failing pre-send simulation): a stale simulation before the run's first broadcast (G's own build
//      simulation, its end-state probe, its audit's fresh re-simulation, an infeasible dual-buy leg, or exec's pre-send
//      simulation) re-runs f and g once (g with cutAtFailure), and every later exec gets replanned; if the rebuilt plan
//      fails again, g cuts it at the failing group (the earlier groups stay sendable, the failing one and every later one
//      are written skipped) and the run goes on, its status traded or nothing-to-do (exit 3). After a broadcast (none
//      happens before exec today) g cuts at once. A C or D stop ends Half A only (D4): Half B and H still run, and the
//      stop's status stays the final status unless Half B ends aborted. A group exec leaves half-done (its nonce settled,
//      and the recovery rule exec applied in the same run did not complete or unwind it) makes the final status aborted,
//      cause half-done, the group named first in notes;
//   4. Half B (halfb), then H (h) on this arm's run-ids that hold fills, today's first, each within the time budget;
//   5. report: report.md and the final wake-status.json, with the fresh-wake verdict `retry` (retryVerdict, below: the
//      wrapper starts a fresh wake of the same run only on a stop marked recoverable) and a note of the nonce reads
//      repeated in place after a lagging RPC answer (G section 8, The nonce floor).
'use strict';

const lib = require('./lib.cjs');
const X = require('./exec-core.cjs');
const EX = require('./exec.cjs');
const HB = require('./halfb.cjs');
const RAMP = require('./ramp.cjs');

const { Stop, EXIT, clip } = lib;
const RESERVE_MS = 10 * 60 * 1000;
const wstop = (cause, notes, exit = EXIT.STOP, fields = {}) => new Stop({ step: 'W', cause, status: 'aborted', notes, exit, fields });

const gateProblems = X.gateProblems;
const STALE_BUILD = new Set(['stale-quote', 'stale-susds', 'stale-invalid', 'probe-failed', 'over-budget', 'pool-unusable']);
const REPAIR_RESETTLE_MS = Object.freeze(Array(12).fill(15000)); // the repair's Pending settled again: 15 s apart, 3 min

// The run-ids the repair scans: this arm's (exec.armRunIds: base-forecast.json csv-face-value and allocation.json
// max-ev), plus any run-id of this arm's D with an inflight file but no allocation.json yet: a wake whose PSM3 ramp (sent
// after E, before F) was left Pending or unclear writes no allocation.json, and is still repaired by the next wake.
function repairCandidates(ctx) {
  const ids = EX.armRunIds(ctx); const seen = new Set(ids);
  for (const d of ctx.listRunIds()) {
    if (seen.has(d)) continue;
    try {
      if (!ctx.existsRel(`run/${d}/inflight.json`) && !ctx.existsRel(`run/${d}/inflight.settled.json`)) continue;
      if (!ctx.existsRel(`run/${d}/base-forecast.json`) || ctx.existsRel(`run/${d}/allocation.json`)) continue;
      if (lib.isArmForecastMethod(JSON.parse(ctx.readRel(`run/${d}/base-forecast.json`).toString('utf8')).method)) ids.push(d);
    } catch (e) { /* not this arm's, or unreadable: never touched */ }
  }
  return ids;
}

// G section 8 step 4 for each prior run-id the repair may touch; never one named in live-runs.txt or the lock's own.
// Pass 1 settles every nonce and appends the missing rows; pass 2 (o.recover, the wake's own call, with env.lock the
// wrapper's) applies the recovery rule (exec.recoverGroup) to each half-done group, only when nothing blocks a send.
async function repair(ctx, env, live, o = {}) {
  // blockKind names what blocked the wake's sends, set together with blockSends (the first one wins): the fresh-wake
  // verdict reads it (retryVerdict, below); chainMismatch lists the run-ids closed as from another chain state. o.out, the
  // caller's object, is filled in place, so what was found before a throw (a run-id closed, a block) is kept
  const out = Object.assign(o.out || {}, { notes: [], repaired: [], recovered: [], blockSends: null, blockKind: null, chainMismatch: [] });
  const block = (kind, why) => { if (!out.blockSends) { out.blockSends = why; out.blockKind = kind; } };
  const halfDone = [];
  const now = lib.nowIso();
  const finalizeRun = (d, extra) => {
    const book = new X.Book(ctx.cfg, d);
    const F = book.readJson('fills.json', null);
    const status = F && (F.runs || []).some((r) => r.tx_hash) ? 'traded' : 'nothing-to-do';
    const old = book.readJson('wake-status.json', null);
    const note = `repaired by ${ctx.runId} at ${now}${extra ? ': ' + extra : ''}`;
    book.writeJson('wake-status.json', { ...(old || { run_id: d }), status, finished_at: (old && old.finished_at) || now, notes: [old && old.notes, note].filter(Boolean).join(' | ') });
    out.repaired.push({ run_id: d, status, note });
  };
  for (const d of repairCandidates(ctx)) {
    if (d === ctx.runId) continue;
    if (live.includes(d)) { out.notes.push(`repair skipped run ${d}: listed in live-runs.txt; delete run/${d}/session-owner.json once that session is confirmed gone`); continue; }
    const book = new X.Book(ctx.cfg, d);
    if (!book.exists('inflight.json') && !book.exists('inflight.settled.json')) continue;
    if (HB.isFinalRun(ctx, d)) continue;
    let late = null;
    if (book.exists('inflight.json')) {
      const inf = book.readJson('inflight.json', null);
      const n = inf && Number.isInteger(inf.nonce) ? inf.nonce : null;
      if (n === null) { out.notes.push(`run ${d}: inflight.json is unreadable; nothing is sent until an operator settles it`); block('inflight-unreadable', `run ${d}'s inflight.json is unreadable`); continue; }
      let s = await X.settleNonce(env, book, n); // bounded by env.deadlineMs, resumed at the next wake (exec-core)
      // a Pending that is only "not yet" is settled again every 15 s for up to 3 min before it blocks the wake's sends
      if (s.outcome === 'pending' && s.wait) s = await X.settleAgain(env, book, n, s, REPAIR_RESETTLE_MS);
      // a not-sent finding on a signer that cannot pin the nonce: the wake's own cancel consumes n first, and the outcome
      // below is the settlement after it (G section 8, Nonce pinning; exec-core cancelStuckNonce)
      if (s.outcome === 'not-sent' && !s.foreign && !env.pin && o.recover && X.selfClears(env)) {
        const c = await X.cancelStuckNonce(env, book, n, { trigger: `the start-of-run repair of ${ctx.runId}` });
        s = c.settlement; out.notes.push(`run ${d}: ${c.note}`);
      }
      if (s.outcome === 'chain-mismatch') {
        for (const a of X.liveAttempts(book.attempts(), n)) book.retire(n, a.calldata_hash || null, 'chain-mismatch');
        book.settleInflight(); finalizeRun(d, 'chain-mismatch'); out.chainMismatch.push(d);
        out.notes.push(`chain-mismatch: run ${d} nonce ${n} (${s.via}); closed, not repaired`); continue;
      }
      if (s.outcome === 'pending') { block('pending', `run ${d} nonce ${n} is Pending (${s.via}; hash ${inf.tx_hash || 'none recorded'})`); out.notes.push(`run ${d}: nonce ${n} is Pending, hash ${inf.tx_hash || 'none recorded'} (${s.via}): nothing is sent until it settles; if it never mines, clear it in a supervised session (I-setup.md I.2 section 6)`); continue; }
      if (s.outcome === 'not-sent' && !env.pin && !s.foreign) {
        // no settlement on a signer that cannot pin the nonce (G section 8, Nonce pinning): inflight.json stays, the run-id
        // stays non-final, and every later wake re-settles n, and sends its own cancel, until a transaction consumes n
        block('not-sent', `run ${d} nonce ${n} settled Not sent and the signer cannot pin the nonce (G section 8, Nonce pinning)`);
        out.notes.push(`run ${d}: nonce ${n} reads Not sent (${s.via}) and the signer cannot pin the nonce: nothing is sent until a transaction consumes nonce ${n}; the next wake sends its own cancel again, or an operator sends one (I-setup.md I.2 section 6)`);
        continue;
      }
      book.settleInflight();
      if (s.outcome === 'landed') {
        // the signed input's hash: the attempt carrying the landed hash, else the one hash every attempt at n shares
        const att = X.liveAttempts(book.attempts(), n); const own = att.find((a) => a.tx_hash && X.lc(a.tx_hash) === X.lc(s.hash)); const hs = [...new Set(att.map((a) => a.calldata_hash).filter(Boolean))];
        late = { n, hash: s.hash, input_hash: own && own.calldata_hash ? own.calldata_hash : hs.length === 1 ? hs[0] : null, success: s.receipt.success === true, block: s.receipt.block_number, receipt: s.receipt, via: s.via };
      } else {
        out.notes.push(`run ${d}: nonce ${n} settled Not sent (${s.via})${s.foreign ? `; foreign transaction ${s.foreign.hash} input_keccak256 ${s.foreign.input_keccak256}` : ''}`);
      }
    }
    // the missing fills.json rows, appended, never a row removed (I-setup.md I.2 section 6 (c)): the plan's landed
    // transactions without one (exec.repairPlanRows), or a Half B send recorded here that landed late (halfb.repairRows)
    const note = `recovered by the start-of-run repair of ${ctx.runId} at ${now} from receipt`;
    let pr = { matched: null, added: [], half_done: [] }; let failed = null;
    try {
      pr = EX.repairPlanRows(ctx, d, late, note);
      if (late && !pr.matched) {
        // a recovery send recorded in this run-id (recovery.json), else a Half B send recorded here
        const rl = EX.recoveryLate(ctx, d, late, note);
        if (rl) { pr.matched = { group: rl.group }; pr.added.push(...rl.rows); }
        else {
          const hb = await HB.repairRows(ctx, env, d, late, note);
          if (hb) { pr.matched = { group: 'Half B' }; if (hb.rows.length && !book.fills().runs.some((x) => X.lc(x.tx_hash || '') === X.lc(late.hash))) { book.addRows(hb.rows); pr.added.push(...hb.rows); } }
        }
      }
    } catch (e) { failed = clip(e && e.message ? e.message : String(e), 200); }
    if (late) {
      const m = pr.matched && pr.matched.group !== 'Half B' ? pr.matched : null;
      if (!book.sends().some((x) => x.tx_hash === late.hash)) book.addSend({ at: now, source: 'repair', group: m ? m.group : null, idx: m ? m.idx : null, label: m ? m.label : null, nonce: late.n, tx_hash: late.hash, block: late.block, to: late.receipt.to, gas_used: late.receipt.gas_used, effective_gas_price: late.receipt.effective_gas_price, l1_fee: late.receipt.l1_fee || '0', settled_via: `start-of-run repair by ${ctx.runId}: ${late.via}` });
      out.notes.push(`run ${d}: nonce ${late.n} landed after its run stopped (${late.hash}, status ${late.receipt.status}); recorded in its exec-sends.json${pr.matched || failed ? '' : '; no fills.json row: it is neither a transaction of that run\'s plan, a recovery send nor a Half B send recorded there (a PSM3 ramp or a setup send writes none)'}`);
    }
    if (failed) { out.notes.push(`run ${d}: its missing fills.json rows could not be appended (${failed}); not finalized, tried again at the next wake`); continue; }
    if (pr.added.length) out.notes.push(`run ${d}: ${pr.added.length} missing fills.json row(s) appended from the signed calldata of ${[...new Set(pr.added.map((r) => r.tx_hash))].join(', ')} (exact, or the calldata's own bound, said in each row's error)`);
    // a half-done group (some but not all of its transactions landed, no recovery settled it) goes to pass 2
    if (pr.half_done.length) { halfDone.push({ d, groups: pr.half_done }); continue; }
    finalizeRun(d, null);
  }
  // the signer's own release of a settled send's lock (exec-core releaseSendLock), once every nonce of the scan is settled
  // and before this wake's first send: a lock an earlier run left (a signer whose state folder outlives the run) would
  // otherwise refuse every send; a lock whose transaction is not settled, or a live process's, stays and blocks them
  if (o.recover && X.selfClears(env) && !out.blockSends) {
    const rl = await X.releaseSendLock(env);
    if (rl.note) out.notes.push(rl.note);
    if (['pending-or-unsent', 'in-progress', 'lock-unreadable'].includes(rl.status)) block(`send-lock:${rl.status}`, `the signer's send-lock is held (its reconcile: ${rl.status})`);
  }
  // pass 2: the recovery rule (G section 8 step 4, Start-of-run repair) on each half-done group, in its own run-id, judged
  // against the current chain state; the run-id is finalized once each of its groups is completed, unwound, has nothing
  // to unwind, or is kept because the boundary allows neither trading nor merging
  for (const { d, groups } of halfDone) {
    const named = (h) => `run ${d}: group ${h.group} (${h.landed} of ${h.of} transactions landed) is half-done`;
    const why = !o.recover ? 'this call applies no recovery' : out.blockSends ? `no send in this wake (${out.blockSends})` : !env.lock ? 'no send lock in this call' : null;
    if (why) { groups.forEach((h) => out.notes.push(`${named(h)}; the recovery rule is not applied now (${why}): not finalized, applied at the next start-of-run repair`)); continue; }
    let final = true; const done = [];
    for (const h of groups) {
      const rv = await EX.recoverGroup({ env, book: new X.Book(ctx.cfg, d), gid: h.group, trigger: 'start-of-run repair', by: `the start-of-run repair of ${ctx.runId}` });
      out.recovered.push({ run_id: d, group: h.group, outcome: rv.outcome, decision: rv.decision, txs: rv.txs, stop_cause: rv.stop_cause || null, stop_transient: !!rv.stop_transient, another_sender: !!rv.another_sender, settlement: rv.settlement || null });
      out.notes.push(`${named(h)}; the recovery rule (G section 8 step 4): ${rv.outcome}${rv.decision ? ` (${rv.decision})` : ''}: ${clip(rv.why, 300)}${rv.txs.length ? `; sent ${rv.txs.join(', ')}` : ''}`);
      if (rv.keep_aborted) block('recovery-unsettled', `the recovery of run ${d} group ${h.group} left nonce ${rv.pending_nonce} unsettled`);
      if (EX.RECOVERY_FINAL.has(rv.outcome)) done.push(`${h.group} ${rv.outcome}`); else final = false;
      if (out.blockSends) { final = false; break; }
    }
    if (final) finalizeRun(d, `recovery: ${done.join(', ')}`);
    else out.notes.push(`run ${d}: not finalized; the next start-of-run repair applies the recovery rule again`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The fresh-wake verdict (I-setup.md I.2 section 6, A fresh wake in the same run), wake-status.json's `retry`. The
// planner decides whether this wake's stop is one a fresh wake of the same run can recover, because only the step that
// stopped tells a lagging RPC from another sender, a refusal from an RPC error and Settled from Pending; r3.cjs decides
// whether there is room for one (schedule.fresh_wakes_max, the cap, the time left, origin and the pins). Deny by
// default: a cause named nowhere below gets none. The shape:
//   { verdict: 'fresh-wake' | 'none', class: 'transport' | 'market' | 'settle' | 'foreign' | 'stop', key, after_s, why }
// with quiet_s on class foreign (another sender at the wallet: the wrapper waits until the holder's nonce reads
// latest == pending, unchanged for quiet_s seconds, before the fresh wake); key ('<step>:<cause>', 'repair:<kind>') lets
// the wrapper see the same stop twice. In order:
//   1. D found no CSV to trade on (no-csv, csv-store-mismatch): none, a fresh wake reads the same input;
//   2. a safety cause anywhere in the wake (Half A, Half B, a recovery, a run-id the repair closed as chain-mismatch, an
//      open nonce settled as chain-mismatch after another stop): none; a refusal of the allowlist, a hash, the chain,
//      the signer, the holder, a lock or the authorization;
//   3. sends blocked by the start-of-run repair (its blockKind): settle (a nonce still Pending or Not sent, a send-lock
//      over an unsettled send, a recovery left unsettled), transport (a repair that failed on one), else none;
//   4. Half A's stop: foreign (another sender: exec-core anotherSender), transport, settle, market, else none;
//   5. no Half A stop but G cut its plan: market;
//   6. otherwise (Half A ran its plan; only Half B stopped, or nothing did): none.
// A fresh wake of another class becomes foreign when a recovery, or Half B while it could send, met another sender.
// The wake exits with the worst exit of its stops (run, below), and r3.cjs retries an exit 4 only for class settle or
// foreign: beside a stop of exit 4 (Half B's, or Half A's under a repair block), a fresh wake of another class becomes
// settle when that stop is a nonce left Pending or a pending or moved nonce (the fresh wake's repair settles it), else none.
// ---------------------------------------------------------------------------------------------------------------
const RETRY_AFTER_S = Object.freeze({ transport: 600, market: 180, settle: 900, foreign: 300 });
const QUIET_S = 300;
const NO_INPUT = ['no-csv', 'csv-store-mismatch'];
const NEVER_RETRY = new Set(['allowlist-refused', 'hash-mismatch', 'chain-mismatch', 'signer-changed', 'holder-mismatch', 'lock-held', 'lock-lost', 'lock-start-time', 'inflight-unsettled', 'identity', 'autonomy-gate', 'unsupported-signer-mode', 'send-lock-held']);
const TRANSPORT_CAUSES = new Set(['nonce-lag', 'transport', 'rpc_unreachable', 'onchain-reads-failed', 'boundary-read-failed', 'read-failed']);
const SETTLE_KINDS = new Set(['pending', 'not-sent', 'send-lock:pending-or-unsent', 'recovery-unsettled']);
const REPAIR_TRANSPORT = ['transport', 'rpc_unreachable', 'nonce-lag']; // a repair that failed on one of these is retried
const MARKET_CAUSES = new Set(['stale-simulation', 'stale-boundary', 'stale-floor', 'stale-balance', 'stale-route', 'gas-limit', 'gas-grew', 'reverted', 'stale-susds', 'stale-invalid', 'stale-quote', 'probe-failed', 'over-budget', 'pool-unusable', 'boundary', 'simulation-failed', 'dual-leg-infeasible', 'merge-arb-infeasible', 'audit-failed', 'refill-not-converging']);
const causeOf = (s) => (s ? (s.stop ? s.stop.cause : s.code || null) : null);
// W: the wake's state (status, steps); haStop {step, summary, keep_aborted} or null; haCut: G's cut or null; rep: the
// start-of-run repair's result; hb: Half B's summary; hbBlocked: why Half B could send nothing (null when it could)
function retryVerdict({ W, haStop = null, haCut = null, rep = {}, hb = null, hbBlocked = null }) {
  const R = rep || {};
  const v = (verdict, cls, key, why) => ({ verdict, class: cls, key, after_s: verdict === 'fresh-wake' ? RETRY_AFTER_S[cls] : null, ...(cls === 'foreign' ? { quiet_s: QUIET_S } : {}), why });
  const none = (key, why) => v('none', 'stop', key, why);
  const hs = haStop ? haStop.summary || {} : null; const hc = causeOf(hs); const hk = haStop ? `${haStop.step}:${hc}` : null;
  const rv = W && W.steps && W.steps.exec ? W.steps.exec.recovery || null : null;
  const hbc = causeOf(hb); const hbs = (hb && hb.half_b_stop) || {};
  // 1. no CSV to trade on
  if (W && NO_INPUT.includes(W.status)) return none(`D:${W.status}`, `D found no CSV to trade on (${W.status}): a fresh wake would read the same input; the operator supplies a CSV`);
  // 2. a safety cause, wherever it arose
  const seen = [];
  if (haStop) seen.push([hk, hc, hs.transient === true]);
  if (hbc) seen.push([`B:${hbc}`, hbc, hbs.transient === true || hb.transient === true]);
  if (hb && hb.refused) seen.push(['B:check-refused', 'allowlist-refused', false]); // a Half B skip for a refused signer check
  if (rv && rv.stop_cause) seen.push([`exec recovery:${rv.stop_cause}`, rv.stop_cause, rv.stop_transient === true]);
  for (const x of R.recovered || []) if (x.stop_cause) seen.push([`repair recovery:${x.stop_cause}`, x.stop_cause, x.stop_transient === true]);
  if ((R.chainMismatch || []).length) seen.push(['repair:chain-mismatch', 'chain-mismatch', false]);
  // an open nonce settled after another stop (exec's, the ramp's or Half B's, a recovery's) that read chain-mismatch
  const cm = (o) => o === 'chain-mismatch' || !!(o && o.outcome === 'chain-mismatch');
  if (hs && cm(hs.settlement)) seen.push([`${hk}:settlement`, 'chain-mismatch', false]);
  if (cm(hbs.settlement)) seen.push(['B:settlement', 'chain-mismatch', false]);
  if (rv && cm(rv.settlement)) seen.push(['exec recovery:settlement', 'chain-mismatch', false]);
  for (const x of R.recovered || []) if (cm(x.settlement)) seen.push([`repair recovery:settlement`, 'chain-mismatch', false]);
  const unsafe = seen.find(([, c, transient]) => NEVER_RETRY.has(c) || (c === 'signer-refused' && !transient));
  if (unsafe) return none(unsafe[0], `${unsafe[0]}: a safety stop (a refusal of the allowlist, a hash, the chain, the signer, the holder, a lock or the standing authorization) is never retried in the run; the operator, or the next scheduled run`);
  // another sender met outside Half A's own stop: a recovery, or Half B while it could send (with sends blocked, a
  // pending transaction may be this arm's own unsettled one)
  const met = [rv && rv.another_sender ? 'the recovery in exec' : null, ...(R.recovered || []).filter((x) => x.another_sender).map((x) => `the repair's recovery of run ${x.run_id}`), !hbBlocked && hb && (hbs.another_sender || X.anotherSender(hbc, hb)) ? 'Half B' : null].filter(Boolean);
  // the wake's stops of exit 4 (wake.run exits with the worst one)
  const x4 = [haStop && hs.exit === EXIT.SAFETY ? [hk, hc] : null, hb && hb.exit === EXIT.SAFETY ? [`B:${hbc}`, hbc] : null].filter(Boolean);
  const go = (cls, key, why) => {
    let r = v('fresh-wake', cls, key, why);
    if (cls !== 'foreign' && met.length) r = { ...r, class: 'foreign', after_s: Math.max(r.after_s, RETRY_AFTER_S.foreign), quiet_s: QUIET_S, why: `${why}; another sender used the wallet (${met.join(', ')}): the fresh wake waits until its nonce is quiet` };
    if (['settle', 'foreign'].includes(r.class) || !x4.length) return r;
    const p = x4.find(([, c]) => ['pending', 'pending-transaction', 'nonce-moved'].includes(c));
    if (p) return { ...r, class: 'settle', after_s: Math.max(r.after_s, RETRY_AFTER_S.settle), why: `${r.why}; ${p[0]} (exit 4) left a nonce unsettled or met a pending one: a fresh wake's start-of-run repair settles it` };
    return none(x4[0][0], `${x4[0][0]}: a stop of exit 4 beside ${key}, neither a nonce left unsettled nor another sender: the next scheduled run, or the operator`);
  };
  // 3. sends blocked by the start-of-run repair
  if (R.blockSends) {
    const k = R.blockKind || 'unknown'; const key = `repair:${k}`; const what = clip(R.blockSends, 200);
    if (SETTLE_KINDS.has(k)) return go('settle', key, `the start-of-run repair left a nonce unsettled (${what}): a fresh wake's repair settles it again`);
    if (k.startsWith('repair-failed:') && REPAIR_TRANSPORT.includes(k.slice('repair-failed:'.length))) return go('transport', key, `the start-of-run repair failed on a transport error (${what}): a fresh wake reads again`);
    return none(key, `the start-of-run repair blocked every send (${what}): the operator, or the next scheduled run`);
  }
  // 4. Half A's stop
  if (haStop) {
    const at = `${haStop.step} stopped on ${hc}`;
    if (X.anotherSender(hc, hs)) return go('foreign', hk, `${at}: another sender used the wallet; a fresh wake once the holder's nonce has been quiet for ${QUIET_S} s`);
    if (TRANSPORT_CAUSES.has(hc) || (hc === 'signer-refused' && hs.transient === true && hs.throttled === true)) return go('transport', hk, `${at}, a transport failure (a lagging or failing RPC): a fresh wake reads again`);
    if (hc === 'pending' || (hc === 'not-sent' && hs.keep_aborted)) return go('settle', hk, `${at}: a nonce is not settled yet; a fresh wake's start-of-run repair settles it`);
    // not-sent here: its nonce consumed (the run's own cancel) or a signer that pins the nonce
    if (MARKET_CAUSES.has(hc) || hc === 'not-sent' || (hc === 'self-check-failed' && haStop.step === 'F') || (hc === 'signer-refused' && hs.transient === true)) return go('market', hk, `${at}: the plan went stale against the chain before it was sent, or a send reverted; a fresh wake re-plans from C on live state`);
    return none(hk, `${at}: not a stop a fresh wake can fix; the next scheduled run, or the operator`);
  }
  // 5. G cut its plan at a group that failed its simulation again
  if (haCut) return go('market', 'G:cut', `G cut its plan (${clip(haCut.reason || 'a failing simulation', 160)}): a fresh wake re-plans from C on live state`);
  // 6. Half A ran its plan
  return hbc ? none(`B:${hbc}`, `Half A ran its plan; only Half B stopped (${hbc}): the next scheduled run`) : none(null, 'the wake ran its plan: nothing to retry');
}

// A start-of-run repair that threw: what it found before stands in rep (a run-id closed as chain-mismatch, a recovery's
// stop); a block it found before stands only when the throw is a transport failure (both are retried), any other cause
// decides the block (repair-failed:<cause>, verdict none), so a cause that is never retried is never hidden behind one
function repairFailed(rep, e) {
  const s = X.asStop('W', e); const why = `the start-of-run repair failed (${s.cause}): ${clip(s.notes, 300)}`;
  if (rep.blockSends && REPAIR_TRANSPORT.includes(s.cause)) rep.notes.push(why);
  else { rep.blockSends = why; rep.blockKind = `repair-failed:${s.cause}`; }
  return rep;
}

async function run(ctx) {
  const rid = ctx.runId;
  const lk = X.lockMode(ctx);
  if (lk.mode !== 'wrapper') { ctx.noDetail = true; throw wstop('not-scheduled', `wake is the scheduled run: run/${lib.LOCK_NAME} must be held by the wrapper (owner.txt stage "claude-p") naming run ${rid}; nothing was written`, EXIT.SAFETY); }
  const startedAt = lk.owner.started_at || lib.nowIso();
  // 1. aborted first, then the gates
  ctx.writeRunJson('wake-status.json', { run_id: rid, started_at: startedAt, status: 'aborted', notes: 'running: the final status is written at the end of the wake' });
  const setup = lib.readSetup(ctx.cfg);
  const W = { started_at: startedAt, status: 'aborted', stopped_at_step: null, notes: [], steps: {}, h: {}, h_rescored: [], final: true, cadence_hours: setup && setup.schedule ? setup.schedule.cadence_hours : null };
  const report = async () => lib.runStep({ cfg: ctx.cfg, sub: 'report', runId: rid, opts: { wake: W } });
  // the start check is the operator's standing authorization and pause: a fresh wake would read the same record
  const gateRetry = (key) => ({ verdict: 'none', class: 'stop', key, after_s: null, why: `${key}: refused at the start check, the operator's standing authorization (I-setup.md I.2 section 1): never retried in the run` });
  const rereads0 = lib.nonceRereads();
  // signer mode (b), a TradeExecutor with a session key: refused with the gates, before anything else is read or sent
  // (I-setup.md I.2 section 7, The planner); the signer never runs
  if (X.signerModeProblem(setup)) {
    W.notes.push(`autonomous run refused at the start check: ${X.SIGNER_MODE_NOTE}; signer_mode executor-session-key is not supported by the planner (I-setup.md I.2 section 7, The planner)`); W.stopped_at_step = 'gate';
    W.retry = gateRetry('W:unsupported-signer-mode');
    await report();
    throw wstop('unsupported-signer-mode', `${X.SIGNER_MODE_NOTE}; signer_mode executor-session-key is not supported by the planner; nothing was signed or sent`, EXIT.STOP, { status: 'aborted', retry: W.retry });
  }
  const gp = gateProblems(setup);
  if (gp.length) {
    W.notes.push(`autonomous run refused at the start check (I-setup.md I.2 section 1): ${gp.join('; ')}`); W.stopped_at_step = 'gate';
    W.retry = gateRetry('W:gate');
    await report();
    throw wstop('gate', gp.join('; '), EXIT.STOP, { status: 'aborted', retry: W.retry });
  }
  const tl = Number(setup.schedule && setup.schedule.time_limit_hours); const st0 = Date.parse(startedAt);
  const deadlineMs = Number.isFinite(tl) && tl > 0 && Number.isFinite(st0) ? st0 + tl * 3600000 - RESERVE_MS : null;
  const env = X.makeEnv(ctx, { step: 'W', holder: ctx.holder(), setup });
  // the repair's recovery sends use the wrapper's lock (never taken again or released) and the run's deadline
  env.lock = { mode: 'wrapper', taken: false, text: lk.text, owner: lk.owner }; env.deadlineMs = deadlineMs;
  const live = lk.liveRuns || [];
  live.forEach((d) => W.notes.push(`run ${d} is listed in live-runs.txt (a live supervised session): no repair, no Half B send and no H on it; delete run/${d}/session-owner.json once that session is confirmed gone`));
  // 2. the start-of-run repair
  const rep = {};
  try { await repair(ctx, env, live, { recover: true, out: rep }); } catch (e) { repairFailed(rep, e); }
  W.notes.push(...rep.notes); W.repaired = rep.repaired; W.recovered = rep.recovered || [];
  if (rep.blockSends) W.notes.push(`no send in this wake: ${rep.blockSends}`);
  // 3. Half A
  const step = async (sub, opts = {}) => { const r = await lib.runStep({ cfg: ctx.cfg, sub, runId: rid, opts }); W.steps[sub] = r.summary; return r.summary; };
  let haStop = null; let worstExit = 0; let replanUsed = false; let haCut = null;
  // "before the run's first broadcast": nothing of today's run-id was sent or attempted (exec.cjs counts the same records)
  const sentToday = () => { const b = new X.Book(ctx.cfg, rid); return b.sends().length > 0 || b.attempts().some((a) => a.status !== 'not_broadcast'); };
  // a G stop that is a failing pre-send simulation (G section 8): the build's simulation, the end-state probe, an
  // infeasible dual-buy leg (G section 3), or an audit whose only failures are its fresh re-simulation's
  const staleSim = (s) => !!(s && s.stop && s.stale_simulation === true && ['simulation-failed', 'dual-leg-infeasible', 'merge-arb-infeasible', 'audit-failed'].includes(s.stop.cause));
  // a G build that found the plan stale against the chain (G's `... the plan is stale, rebuild from F`): a quote, the
  // sUSDS or Invalid read, the return probe on the state a set-sell or merge-arb leaves, the budget or a pool moved
  // since F; the trading boundary is not one
  // (only a fresh C clears it)
  const staleBuild = (s) => !!(s && s.stop && STALE_BUILD.has(s.stop.cause));
  const replan = async (why) => {
    replanUsed = true;
    W.notes.push(`${why}: F and G re-run once (I-setup.md I.2 section 5 item 3); a rebuilt plan that fails again is cut at its failing group`);
    for (const sub of ['f', 'g']) { const r = await step(sub, sub === 'g' ? { cutAtFailure: true } : {}); if (r.exit !== 0) { haStop = { step: sub.toUpperCase(), summary: r }; return false; } }
    return true;
  };
  const halfA = async () => {
    for (const sub of ['c', 'd', 'e', 'ramp', 'f', 'g']) {
      if (sub === 'ramp') {
        // the PSM3 ramp, its own batch between E and F (I-setup.md I.2 section 2 Half A; G section 1)
        const r = (await lib.runStep({ cfg: ctx.cfg, sub: 'ramp', runId: rid, opts: { deadlineMs, blockSends: rep.blockSends }, step: RAMP })).summary;
        W.steps.ramp = r;
        if (r.exit !== 0) { haStop = { step: 'ramp', summary: r, keep_aborted: !!r.keep_aborted || [EXIT.SAFETY, EXIT.TRANSPORT].includes(r.exit) }; return; }
        if (r.ran) W.notes.push(`PSM3 ramp sent before F (I-setup.md I.1 section 5): ${r.assets.map((a) => `${a.amount_in} ${a.asset}`).join(' and ')} into sUSDS (${r.sent.reduce((n, g) => n + g.txs.length, 0)} transactions, record ${r.record}); sUSDS ${r.susds_before} -> ${r.susds_after}; F sizes on the post-ramp balance`);
        continue;
      }
      const s = await step(sub, sub === 'g' ? { cutAtFailure: sentToday() } : {});
      if (s.exit === 0) continue;
      if (sub === 'g' && (staleSim(s) || staleBuild(s)) && !replanUsed && !sentToday()) {
        if (!(await replan(staleSim(s) ? `G's pre-send simulation failed before the first broadcast (${s.stop.cause}, first failing group ${s.first_failed_group_id || s.first_failed_group})` : `G found the plan stale before the first broadcast (${s.stop.cause}: ${clip(s.stop.notes, 200)})`))) return;
        continue;
      }
      haStop = { step: sub.toUpperCase(), summary: s }; return;
    }
    const noteCut = () => { const c = W.steps.g && W.steps.g.cut; if (c && haCut === null) { haCut = c; W.notes.push(`${c.reason}; ${c.rows_skipped} row(s) written skipped`); } };
    noteCut();
    if (W.steps.g.nothing_to_send) { W.steps.exec = await step('exec', { deadlineMs }); return; }
    if (rep.blockSends) { haStop = { step: 'G', summary: { stop: { cause: 'sends-blocked', notes: rep.blockSends } }, keep_aborted: true }; return; }
    let s = await step('exec', { deadlineMs, replanned: replanUsed });
    // exec's own stale check before the first broadcast: its pre-send simulation, or the whole-plan boundary pass
    if (s.exit !== 0 && s.stop && ['stale-simulation', 'stale-boundary'].includes(s.stop.cause) && s.replan_due && !replanUsed) {
      if (!(await replan(`exec's ${s.stop.cause === 'stale-boundary' ? 'boundary pass' : 'pre-send simulation'} failed before the first broadcast (first failing group ${s.first_failed_group})`))) return;
      noteCut();
      if (W.steps.g.nothing_to_send) { s = await step('exec', { deadlineMs, replanned: true }); return; }
      s = await step('exec', { deadlineMs, replanned: true });
    }
    if (s.exit !== 0) haStop = { step: 'exec', summary: s, keep_aborted: !!s.keep_aborted || [EXIT.SAFETY, EXIT.TRANSPORT].includes(s.exit) };
  };
  await halfA();
  if (haStop) {
    const s = haStop.summary;
    W.stopped_at_step = haStop.step;
    W.notes.push(`Half A stopped at ${haStop.step}: ${s.stop ? `${s.stop.cause}: ${clip(s.stop.notes, 400)}` : clip(s.error || '', 400)}`);
    worstExit = Math.max(worstExit, s.exit || EXIT.STOP);
    if (s.budget_exhausted || (s.stop && s.stop.cause === 'time-budget')) W.notes.push('turn/time budget exhausted');
  }
  if (haCut) worstExit = Math.max(worstExit, EXIT.STOP); // groups skipped for a failing simulation: exit 3, as exec's own skip
  // the recovery rule exec applied in this run (G section 8 step 4); a keep-whole group of today's entry plan it did not
  // complete or unwind (its nonce settled): the run ends aborted, cause half-done, so it is not final and the next run's
  // start-of-run repair applies the rule again (I-setup.md I.2 section 6 (a), (c))
  const rv = W.steps.exec && W.steps.exec.recovery ? W.steps.exec.recovery : null;
  if (rv) W.notes.push(`recovery of group ${rv.group} in this run (G section 8 step 4): ${rv.outcome}${rv.decision ? ` (${rv.decision})` : ''}: ${clip(rv.why, 300)}${rv.txs && rv.txs.length ? `; sent ${rv.txs.join(', ')}` : ''}`);
  const hd = W.steps.exec && W.steps.exec.half_done ? W.steps.exec.half_done : null;
  if (hd) { W.notes.unshift(`half-done: group ${hd.group}, ${hd.landed} of ${hd.of} transactions landed (${(hd.txs || []).join(', ')}); ${hd.recovery}: this run-id stays aborted, not final, until then`); worstExit = Math.max(worstExit, EXIT.STOP); }
  // USDC or USDS still at the holder when F read it (deposited after the ramp step read the balances): reported, never a
  // brake; F sized on the sUSDS balance alone and the next wake's ramp converts it
  const fs1 = W.steps.f; if (fs1 && fs1.ramp_due) W.notes.push(`USDC ${fs1.usdc_raw} (6 decimals) or USDS ${fs1.usds_raw} wei was still held when F read the balances, after this wake's ramp step: F sized on the sUSDS balance alone; the next wake's PSM3 ramp converts it (I-setup.md I.1 section 5)`);
  // 4. Half B, then H, each checked against the time budget
  const over = () => deadlineMs && Date.now() > deadlineMs;
  let hbAborted = false; let hbStopped = false;
  // why Half B can send nothing (null when it can): the verdict trusts Half B's view of another sender only when it could send
  const hbBlocked = rep.blockSends || (haStop && haStop.keep_aborted ? 'Half A left a nonce unsettled or a send-lock held' : null);
  if (over()) { W.notes.push('turn/time budget exhausted: Half B and H not run'); }
  else {
    const hb = await step('halfb', { deadlineMs, blockSends: hbBlocked });
    if (hb.resize_schedule) W.notes.unshift(hb.resize_schedule);
    (hb.notes || []).forEach((n) => { if (n !== hb.resize_schedule && !W.notes.includes(n)) W.notes.push(n); });
    (hb.decided_but_unreported || []).forEach((n) => W.notes.push(n));
    if (hb.exit !== 0) { hbStopped = true; W.notes.push(`Half B stopped: ${hb.stop ? `${hb.stop.cause}: ${clip(hb.stop.notes, 300)}` : clip(hb.error || '', 300)}`); worstExit = Math.max(worstExit, hb.exit); if (hb.keep_aborted || [EXIT.SAFETY, EXIT.TRANSPORT].includes(hb.exit)) hbAborted = true; }
    // a Half B batch stopped part-way keeps the run's status (unless the stop above keeps it aborted); named, never
    // tracked across runs (planner.README.md section 8)
    (hb.half_done || []).forEach((h) => W.notes.push(`Half B left ${h.group} half-done: ${h.landed} of ${h.of} transactions landed (${(h.txs || []).join(', ')})`));
    if (hb.budget_exhausted && !W.notes.includes('turn/time budget exhausted')) W.notes.push('turn/time budget exhausted');
    // H: today's run-id first, then this arm's run-ids holding fills, never a live session's
    const arm = EX.armRunIds(ctx);
    const ids = [...(arm.includes(rid) ? [rid] : []), ...arm.filter((d) => d !== rid && ctx.existsRel(`run/${d}/fills.json`) && !live.includes(d))];
    const unprocessed = [];
    for (const d of ids) {
      if (over()) { unprocessed.push(d); continue; }
      const r = await lib.runStep({ cfg: ctx.cfg, sub: 'h', runId: d, opts: { prior: d !== rid } });
      W.h[d] = r.summary;
      if (r.summary.review_written) W.h_rescored.push(d);
    }
    if (unprocessed.length) W.notes.push(`turn/time budget exhausted: H not run on ${unprocessed.join(', ')}`);
  }
  // 5. the final status (I-setup.md I.2 sections 2 and 4) and the report
  const fills = (() => { try { return ctx.existsRun('fills.json') ? ctx.readRunJson('fills.json') : null; } catch (e) { return null; } })();
  const traded = !!(fills && (fills.runs || []).some((r) => r.tx_hash));
  const d = W.steps.d;
  if (hbAborted || rep.blockSends || hd) W.status = 'aborted';
  else if (haStop && haStop.step === 'C') W.status = 'aborted';
  else if (haStop && haStop.step === 'D') W.status = d && d.stop && ['no-csv', 'csv-store-mismatch'].includes(d.stop.status) ? d.stop.status : 'aborted';
  else if (haStop && ['E', 'F', 'G'].includes(haStop.step)) W.status = 'aborted';
  else if (haStop && haStop.keep_aborted) W.status = 'aborted';
  else W.status = traded ? 'traded' : 'nothing-to-do';
  if (!W.stopped_at_step) W.stopped_at_step = 'H';
  // nonce reads repeated in place after a lagging RPC answer, every step of this wake (lib.readNonceAtLeast)
  const rereads = lib.nonceRereads() - rereads0;
  if (rereads) W.notes.push(`nonce re-read ${rereads} time(s) after a lagging RPC answer (G section 8, The nonce floor): absorbed in place, nothing sent twice`);
  // the fresh-wake verdict, before the report writes it into wake-status.json
  W.retry = retryVerdict({ W, haStop, haCut, rep, hb: W.steps.halfb || null, hbBlocked });
  const rr = await report();
  if (rr.exit !== 0) W.notes.push('report failed: ' + clip(rr.summary.error || JSON.stringify(rr.summary.stop), 200));
  const out = { status: W.status, stopped_at_step: W.stopped_at_step, half_a_stop: haStop ? { step: haStop.step, cause: haStop.summary.stop ? haStop.summary.stop.cause : haStop.summary.code } : null, traded, repaired: rep.repaired.length, recovered: (rep.recovered || []).map((x) => ({ run_id: x.run_id, group: x.group, outcome: x.outcome })), sends_blocked: rep.blockSends || null, h_rescored: W.h_rescored, h_results: Object.fromEntries(Object.entries(W.h).map(([k, v]) => [k, v.result || (v.stop ? 'stopped' : null)])), notes: W.notes.slice(0, 20), retry: W.retry, report: ctx.rel('report.md'), wake_status: ctx.rel('wake-status.json') };
  if (worstExit !== 0 || W.status === 'aborted' || W.status === 'no-csv' || W.status === 'csv-store-mismatch') {
    const exit = worstExit && [EXIT.STOP, EXIT.SAFETY, EXIT.TRANSPORT].includes(worstExit) ? worstExit : EXIT.STOP;
    throw new Stop({ step: 'W', cause: W.status === 'no-csv' || W.status === 'csv-store-mismatch' ? W.status : (hd ? 'half-done' : haStop ? 'half-a-stop' : hbAborted ? 'half-b-aborted' : hbStopped ? 'half-b-stop' : haCut ? 'stale-simulation' : 'aborted'), status: W.status, notes: clip(W.notes.join(' | '), 1500), exit, fields: out });
  }
  return out;
}

module.exports = { run, gateProblems, repair, repairFailed, retryVerdict, RETRY_AFTER_S, QUIET_S, STALE_BUILD };
