// planner/exec-core.cjs - the one sending path of the planner: steps/G-mint-and-trade.md section 8, sequential mode, ported
// from the executor that sent the first live run (278 transactions, every group's effects equal to the plan). `exec` (the
// entry plan) and `halfb` (session-2 merges and redeems) both send through it.
//
// Per transaction, in this order (G section 8 step 3, Money rules):
//   the caller's own fresh checks (the trading boundary, floors, the route), then the holder nonce latest == pending ==
//   the nonce the plan gives it, the signer-input file equal to the plan and its keccak256 (through the helper) equal to
//   the plan's, the signer's own `simulate` on live state, and THE PRE-SEND GAS CHECK (G section 8; the live fix):
//     (a) gas_limit >= the fresh gas_used x 1.2, (b) gas_limit >= the peak the ordered simulation measured for that
//     call (max_used_gas, else gas_used), (c) the fresh gas_used at most 10% above the plan's gas_used.
//   Never the old `gasUsed x 1.5 <= gas_limit` form, which rejects every refund-free call once limits come from a real
//   maxUsedGas. No block number or hash is ever compared between two reads (G section 8, The head moves).
//   Then the lock is confirmed still ours, inflight.json and the attempt are written BEFORE the broadcast, the signer's
//   `send` runs once (re-run only on a throttle answered before signing, with no broadcast line: lib.runSigner), the hash
//   is recorded at the broadcast event, the receipt is confirmed through the helper and the nonce must then read n + 1.
// Per group, before its first write-ahead: affordability, ETH >= 0.002 ETH + the sum over the group of gas_limit x 2 x
//   eth_gasPrice, both read fresh (G section 8, Affordability). ETH is not re-checked inside a group.
// A failure stops sending. A broadcast whose outcome is unclear is settled from chain state (G section 8 step 4: Landed,
//   Pending, Not sent; no timeout); a refusal before any broadcast that provably signed nothing is retired at once
//   (I-setup.md I.2 section 6). Nothing here re-sends a broadcast, signs, holds a key or contacts an RPC itself.
// Signer mode (b), a TradeExecutor with a session key, is refused before any of this (signerModeProblem, below).
'use strict';

const os = require('os');
const lib = require('./lib.cjs');
const TB = require('./table.cjs');

const { Stop, ToolFailure, EXIT, clip } = lib;
const lc = (s) => String(s).toLowerCase();
const RESERVE_WEI = 2000000000000000n; // G section 8, Affordability: the 0.002 ETH reserve
const STALE_APPROVAL_MS = 2 * 3600 * 1000; // I-setup.md I.2 section 8: STALE_APPROVAL 2h, supervised mode only
// The settlement block scan (G section 8 step 4: no timeout) runs forward from from_block to the head, bounded only by time:
// the caller's deadline (env.deadlineMs: the registered time limit less the reserve), else SCAN_BUDGET_MS. A scan that
// stops before the head reads Pending and resumes where it stopped at the next settlement (settle-scan.json, below).
const SCAN_BUDGET_MS = 15 * 60 * 1000;
const SCAN_SAVE_EVERY = 100; // blocks between two writes of the scan cursor
const HELPER_RETRIES = 9;

// Float to wei and back (G section 1 rule; exponent notation expanded first).
function toWei(x) {
  let s = String(x); if (/e/i.test(s)) s = Number(x).toFixed(30);
  const neg = s.startsWith('-'); if (neg) s = s.slice(1);
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) throw new Error('not a decimal amount: ' + clip(String(x), 40));
  const [i, f = ''] = s.split('.'); const v = BigInt(i + (f + '0'.repeat(18)).slice(0, 18)); return neg ? -v : v;
}
function weiStr(w) { const neg = w < 0n; const a = neg ? -w : w; const s = a.toString().padStart(19, '0'); const i = s.slice(0, s.length - 18); const f = s.slice(s.length - 18).replace(/0+$/, ''); return (neg ? '-' : '') + i + (f ? '.' + f : ''); }
const num = (w) => Number(weiStr(w));
const eth = (w) => weiStr(w) + ' ETH';
const pad = (n) => String(n).padStart(3, '0');

// A stop of the sending path. kind is the machine cause; exit 3 (a stop the skill defines), 4 (safety) or 5 (transport).
const SAFETY_KINDS = new Set(['nonce-moved', 'pending-transaction', 'hash-mismatch', 'lock-held', 'lock-lost', 'lock-start-time', 'inflight-unsettled', 'pending', 'chain-mismatch', 'signer-changed', 'holder-mismatch']);
function xstop(step, kind, notes, fields = {}) {
  return new Stop({ step, cause: kind, status: 'aborted', notes, exit: fields.transport ? EXIT.TRANSPORT : SAFETY_KINDS.has(kind) ? EXIT.SAFETY : EXIT.STOP, fields });
}
// Signer mode (b), a TradeExecutor with a session key (`signer_mode` "executor-session-key"), is refused on every send
// path, in both modes (I-setup.md I.2 section 7, The planner): the planner sends each call itself from the holder the
// helper's config names, so it cannot drive an executor (no batchExecute, no window check, no executor balances). Only
// that known value refuses; a local encrypted EOA, an EIP-7702 delegated EOA, another agent signer and a record with no
// signer_mode keep working. The refusal comes before any signer call: nothing signed, nothing sent, the nonce unchanged.
const REFUSED_SIGNER_MODE = 'executor-session-key';
const SIGNER_MODE_NOTE = 'daily autonomous trading needs a local encrypted wallet or an EIP-7702 wallet; a TradeExecutor wallet works in supervised mode';
function signerModeProblem(setup) {
  const m = setup && typeof setup.signer_mode === 'string' ? setup.signer_mode.trim().toLowerCase() : null;
  if (m !== REFUSED_SIGNER_MODE) return null;
  return `signer_mode executor-session-key is not supported by the planner: it sends each call directly from the holder and cannot drive a TradeExecutor (no batchExecute, no window check, no executor balances); ${SIGNER_MODE_NOTE}`;
}
function signerModeStop(step, problem) {
  return xstop(step, 'unsupported-signer-mode', `${problem}, by hand through G section 8 with batchExecute, not through the planner; nothing was signed or sent (I-setup.md I.2 section 7, The planner)`);
}
function refuseSignerMode(step, setup) { const p = signerModeProblem(setup); if (p) throw signerModeStop(step, p); }

// Any error met while sending, as a Stop (a transport failure after the helper's re-runs is exit 5).
function asStop(step, e) {
  if (e instanceof Stop) return e;
  if (e instanceof ToolFailure) return xstop(step, e.transient ? 'transport' : 'tool-failure', clip(e.message, 600), { transport: !!e.transient });
  return xstop(step, 'internal', clip(e && e.stack ? e.stack : String(e), 1200));
}

// ---------------------------------------------------------------------------------------------------------------
// The bookkeeping of one run-id: inflight.json, nonce-attempts.json (append-only; tx_hash completed in place),
// fills.json (rows as they land), exec-sends.json (every confirmed send, the planner's own record).
// ---------------------------------------------------------------------------------------------------------------
class Book {
  constructor(cfg, runId) { lib.validateRunId(runId); this.cfg = cfg; this.runId = runId; }
  rel(n) { return `run/${this.runId}/${n}`; }
  exists(n) { return lib.existsRunFile(this.cfg, this.rel(n)); }
  readJson(n, dflt) { if (!this.exists(n)) return dflt; return JSON.parse(lib.readRunFile(this.cfg, this.rel(n)).toString('utf8')); }
  writeJson(n, o) { lib.writeArmFile(this.cfg, this.runId, n, JSON.stringify(o, null, 1) + '\n'); }
  write(n, data) { lib.writeArmFile(this.cfg, this.runId, n, data); }
  attempts() { return this.readJson('nonce-attempts.json', []); }
  appendAttempt(a) { const l = this.attempts(); l.push(a); this.writeJson('nonce-attempts.json', l); }
  // complete tx_hash in place on the latest entry of (nonce, calldata_hash) that has none
  completeAttemptHash(n, h, txHash) {
    const l = this.attempts();
    for (let k = l.length - 1; k >= 0; k--) { const a = l[k]; if (a.nonce === n && a.status !== 'not_broadcast' && (a.calldata_hash || null) === (h || null)) { if (!a.tx_hash) { a.tx_hash = txHash; this.writeJson('nonce-attempts.json', l); } return; } }
  }
  retire(n, h, reason) { this.appendAttempt({ nonce: n, calldata_hash: h || null, status: 'not_broadcast', reason: clip(reason, 400) }); }
  settleInflight() { if (this.exists('inflight.json')) lib.renameArmFile(this.cfg, this.runId, 'inflight.json', 'inflight.settled.json'); }
  fills() { return this.readJson('fills.json', null) || { generated_at: lib.nowIso(), runs: [], totals: { spent: 0, spent_unit: 'sUSDS', positions_opened: 0 }, retained_legs: [] }; }
  saveFills(F) {
    F.generated_at = lib.nowIso();
    F.totals = F.totals || { spent: 0, spent_unit: 'sUSDS', positions_opened: 0 };
    F.totals.positions_opened = positionsOpened(F.runs);
    if (!Array.isArray(F.retained_legs)) F.retained_legs = [];
    this.writeJson('fills.json', { generated_at: F.generated_at, runs: F.runs, totals: F.totals, retained_legs: F.retained_legs });
  }
  addRows(rows) { if (!rows.length) return; const F = this.fills(); F.runs.push(...rows); this.saveFills(F); }
  sends() { return this.readJson('exec-sends.json', []); }
  addSend(s) { const l = this.sends(); l.push(s); this.writeJson('exec-sends.json', l); }
}
// G Output: filled UP/DOWN rows on the three buy routes, plus every filled set-sell row.
function positionsOpened(runs) {
  return runs.filter((r) => r.status === 'filled' && ((['UP', 'DOWN'].includes(r.side) && ['simple-buy', 'complex-buy', 'dual-buy'].includes(r.route)) || r.route === 'set-sell')).length;
}

// Attempts of nonce n that are not retired (a not_broadcast entry retires the latest earlier attempt of the same hash).
function liveAttempts(list, n) {
  const live = [];
  for (const a of list) {
    if (a.nonce !== n) continue;
    if (a.status === 'not_broadcast') { for (let k = live.length - 1; k >= 0; k--) if ((live[k].calldata_hash || null) === (a.calldata_hash || null)) { live.splice(k, 1); break; } } else live.push(a);
  }
  return live;
}

// ---------------------------------------------------------------------------------------------------------------
// The sending environment of one invocation.
// ---------------------------------------------------------------------------------------------------------------
function makeEnv(ctx, { step, holder, setup }) {
  const env = {
    ctx, cfg: ctx.cfg, step, holder: lc(holder),
    pin: !!(setup && setup.nonce_pinning === true), // G section 8 Nonce pinning: read from the setup record, never inferred
    signerModeProblem: signerModeProblem(setup), // set only for signer mode (b): presend and broadcast refuse (above)
    signerEnv: null, envDropped: [], logPath: null, lock: null, open: null, sentThisInvocation: 0, txTimes: [],
    deadlineMs: null, // the step's deadline (the registered time limit less the reserve), set by a wrapper-mode caller
  };
  let seq = 0;
  env.H = async (args) => (await ctx.helper(args, { retries: HELPER_RETRIES })).json;
  env.mc = async (reads) => {
    const name = `exec-tmp/mc-${process.pid}-${++seq}.json`;
    try { const r = await ctx.multicall(name, reads, { retries: HELPER_RETRIES }); return { block: r.block, results: r.results }; } finally { try { ctx.removeRun(name); } catch (e) { /* scratch */ } }
  };
  env.mcChunked = async (reads, chunk = 400) => { const out = []; let block = null; for (let i = 0; i < reads.length; i += chunk) { const r = await env.mc(reads.slice(i, i + chunk)); out.push(...r.results); block = r.block; } return { block, results: out }; };
  return env;
}

// The signer, restricted subcommands only. A mode-switch refusal that names an unrelated environment variable on a
// read-only call (simulate, check) drops that variable from the CHILD environment and re-runs it (signer README
// section 9: "unset it"); a send is never re-run for it.
async function signerRun(env, sub, file, extra = [], o = {}) {
  for (let a = 0; a < 4; a++) {
    const r = await env.ctx.signer(sub, file, extra, { ...o, env: env.signerEnv || undefined });
    const j = r.last;
    const m = sub !== 'send' && j && j.rule === 'mode-switch' && /environment variable (\S+) looks like/.exec(j.detail || '');
    if (m && !env.envDropped.includes(m[1])) {
      env.envDropped.push(m[1]); const e2 = { ...(env.signerEnv || process.env) }; delete e2[m[1]]; env.signerEnv = e2;
      env.ctx.log(`signer env tripwire named ${m[1]}: dropped from the signer's child environment only`);
      continue;
    }
    return r;
  }
  throw xstop(env.step, 'signer-env', 'the signer kept refusing on its environment tripwire');
}

// ---------------------------------------------------------------------------------------------------------------
// The lock (I-setup.md I.2 section 6). Wrapper mode: ./run/.lock.deep-r3-trade exists and its owner.txt is the
// wrapper's (stage "claude-p") naming THIS run-id: it is used and never taken again or released. Otherwise, when the
// folder does not exist, a supervised session's send batch: the planner takes it with its own pid and start time (the
// process that sends) and releases it when done, only while owner.txt is still the text it wrote. Any other lock refuses.
// ---------------------------------------------------------------------------------------------------------------
function lockMode(ctx) {
  const L = lib.readLock(ctx.cfg);
  if (!L.exists) return { mode: 'supervised', taken: false, liveRuns: [] };
  if (L.owner && L.owner.stage === 'claude-p' && L.owner.run_id === ctx.runId) return { mode: 'wrapper', taken: false, text: L.ownerRaw, owner: L.owner, liveRuns: L.liveRuns || [] };
  return { mode: 'held', owner: L.owner, ownerError: L.ownerError };
}
function lockHeldStop(step, lk) {
  return xstop(step, 'lock-held', `run/${lib.LOCK_NAME} is held (${lk.owner ? `stage ${clip(lk.owner.stage, 60)}, run_id ${clip(lk.owner.run_id, 60)}, pid ${lk.owner.pid}` : lk.ownerError}): another live owner, or a stale lock a supervised session clears only after settling its recorded nonce (I-setup.md I.2 section 6). Nothing was sent.`);
}
function takeLock(env, stage) {
  const start = lib.processStartTime(process.pid);
  if (!start) throw xstop(env.step, 'lock-start-time', 'the planner could not read its own process start time, so it cannot write a lock owner another session could test; nothing was sent');
  const owner = { pid: process.pid, process_start_time: start, host: os.hostname(), started_at: lib.nowIso(), stage, run_id: env.ctx.runId };
  const text = lib.takeLock(env.cfg, owner);
  if (text === null) throw lockHeldStop(env.step, lockMode(env.ctx));
  env.lock = { mode: 'supervised', taken: true, text, owner };
  const rel = () => { try { releaseLock(env); } catch (e) { /* ignore */ } };
  env.lockExitHandler = rel; process.on('exit', rel);
  env.ctx.log(`lock taken: run/${lib.LOCK_NAME} by pid ${process.pid} (start ${start}), stage "${stage}"`);
  return env.lock;
}
function releaseLock(env) {
  if (!env.lock || !env.lock.taken) return null;
  const r = lib.releaseLock(env.cfg, env.lock.text);
  env.lock.taken = false;
  if (env.lockExitHandler) { process.removeListener('exit', env.lockExitHandler); env.lockExitHandler = null; }
  env.ctx.log(r.released ? 'lock released' : `lock NOT released: ${r.why}`);
  return r;
}
function lockStillOurs(env) {
  if (!env.lock) return false;
  const L = lib.readLock(env.cfg);
  return L.exists && L.ownerRaw === env.lock.text;
}

// ---------------------------------------------------------------------------------------------------------------
// Affordability of one group (G section 8): ETH >= 0.002 ETH + sum over its transactions of gas_limit x 2 x eth_gasPrice.
// ---------------------------------------------------------------------------------------------------------------
async function affordability(env, txs) {
  const bal = BigInt((await env.H(['balance', env.holder])).wei);
  const gp = BigInt((await env.H(['fee-history'])).gas_price);
  const need = RESERVE_WEI + txs.reduce((s, t) => s + BigInt(t.gas_limit) * 2n * gp, 0n);
  return { ok: bal >= need, eth: bal, need, gasPrice: gp, text: `ETH ${eth(bal)} vs the requirement ${eth(need)} (0.002 ETH reserve + ${txs.length} gas limit(s) x 2 x eth_gasPrice ${gp} wei)` };
}

// ---------------------------------------------------------------------------------------------------------------
// The pre-send gas check (G section 8), a pure function: three parts, all must hold.
// ---------------------------------------------------------------------------------------------------------------
function gasCheck({ freshGas, planGasUsed, planPeak, gasLimit }) {
  const f = BigInt(freshGas); const g = BigInt(planGasUsed); const lim = BigInt(gasLimit);
  const peak = planPeak === null || planPeak === undefined ? g : BigInt(planPeak);
  if (f * 12n > lim * 10n) return { ok: false, part: 'a', kind: 'gas-limit', why: `the fresh gas_used ${f} x 1.2 is above the plan's gas_limit ${lim} (a limit is never raised at send time)` };
  if (peak > lim) return { ok: false, part: 'b', kind: 'gas-limit', why: `the peak the ordered simulation measured, ${peak}, is above the plan's gas_limit ${lim}` };
  if (f * 10n > g * 11n) return { ok: false, part: 'c', kind: 'gas-grew', why: `the fresh gas_used ${f} is more than 10% above the plan's ${g}: the state the plan was built on has changed` };
  return { ok: true };
}

// The signer-input file the plan names must be exactly the plan's call and gas limit; its data hashed by the helper.
async function checkInputFile(env, book, tx, n) {
  const where = `${tx.label} (nonce ${n})`;
  let inp;
  try { inp = JSON.parse(lib.readRunFile(env.cfg, tx.signer_input_file).toString('utf8')); } catch (e) { throw xstop(env.step, 'hash-mismatch', `${where}: the signer-input file ${tx.signer_input_file} is unreadable: ${clip(e.message, 160)}`); }
  if (!inp || !Array.isArray(inp.calls) || inp.calls.length !== 1 || lc(inp.calls[0].data) !== lc(tx.data) || lc(inp.calls[0].to) !== lc(tx.to) || String(inp.gasLimit) !== String(tx.gas_limit) || Object.keys(inp).sort().join() !== 'calls,gasLimit' || (inp.calls[0].value !== undefined && String(inp.calls[0].value) !== '0')) {
    throw xstop(env.step, 'hash-mismatch', `${where}: the signer-input file differs from the plan (call, to, value or gasLimit)`);
  }
  const f = `exec-data/data-n${n}.hex`;
  book.write(f, inp.calls[0].data + '\n');
  const k = (await env.H(['keccak256', book.rel(f)])).keccak256;
  if (lc(k) !== lc(tx.calldata_keccak256)) throw xstop(env.step, 'hash-mismatch', `${where}: keccak256 of the data file ${k} != the plan's ${tx.calldata_keccak256} (a mis-copied byte; nothing is simulated or sent)`);
  return lc(k);
}

// Everything before the broadcast that does not write: nonce, file and hash, the signer's simulate, the gas check.
async function presend(env, book, tx, n) {
  const where = `${tx.label} (nonce ${n})`;
  if (env.signerModeProblem) throw signerModeStop(env.step, env.signerModeProblem); // before any read or signer call
  const nn = await env.H(['nonce', env.holder]);
  if (nn.latest !== nn.pending) throw xstop(env.step, 'pending-transaction', `${where}: a transaction of the holder is pending (latest ${nn.latest}, pending ${nn.pending}); settle it before anything is sent`, { nonce: nn });
  if (nn.latest !== n) throw xstop(env.step, 'nonce-moved', `${where}: the holder nonce is ${nn.latest}, the plan gives this transaction ${n}: a transaction the plan did not expect; reconcile from chain state`, { nonce: nn });
  const hash = await checkInputFile(env, book, tx, n);
  const sr = await signerRun(env, 'simulate', tx.signer_input_file, [], { retries: HELPER_RETRIES }); // a throttle is re-run (lib.runSigner)
  const sj = sr.last;
  // Only a "simulated":true answer is a simulation result (I-setup.md I.2 section 7, Rate limits; G section 8: a failure is
  // such an answer with a status other than 0x1, or a failed gas check). Everything else is no stale check:
  // a simulate the planner killed at its timeout (its output may be cut short, so it is not read) or still throttled after
  // the re-runs, and an RPC error with no "simulated":true, are transport failures (exit 5), except simulate's own refusals
  // (rpc_code -38000 to -38999, never transient); a refusal, an internal error or malformed output is its own stop (exit 3)
  const fail = (kind, why, f = {}) => xstop(env.step, kind, `${where}: ${why}; nothing was sent`, f);
  if (sr.timedOut) throw fail('transport', 'the signer\'s simulate did not answer within the planner\'s timeout', { transport: true });
  if (lib.signerThrottled('simulate', sr.exit, sj, sr.lines)) throw fail('transport', `the signer's simulate was still rate-limited after ${sr.attempts} attempt(s): ${clip(sj.detail, 200)}`, { transport: true });
  if (!sj || sj.simulated !== true) {
    const rc = sj ? Number(sj.rpc_code) : NaN;
    if (sj && sj.error === 'rpc-error' && Number.isInteger(rc) && rc <= -38000 && rc >= -38999) throw fail('tool-failure', `the signer's simulate was refused by the node's own eth_simulateV1 check (rpc_code ${rc}, never transient): ${clip(sj.detail, 200)}`);
    if (sj && ['rpc-error', 'rpc-http', 'rpc-transport'].includes(sj.error)) throw fail('transport', `the signer's simulate met an RPC failure (${sj.error}${sj.rpc_code !== undefined ? ' ' + sj.rpc_code : ''}): ${clip(sj.detail, 200)}`, { transport: true });
    if (sj && sj.refused) throw fail('signer-refused', `the signer refused the simulate (${clip(sj.refused, 40)}${sj.rule ? ' ' + clip(sj.rule, 60) : ''}): ${clip(sj.detail, 200)}`, { refused: true });
    throw fail('tool-failure', `the signer's simulate gave no simulation result (exit ${sr.exit}): ${clip(sr.stdout || sr.stderr, 300)}`);
  }
  if (sr.exit !== 0 || sj.ok !== true || !Array.isArray(sj.results) || !sj.results[0] || sj.results[0].status !== '0x1') {
    throw xstop(env.step, 'stale-simulation', `${where}: the signer's own simulate on live state failed (exit ${sr.exit}): ${clip(sr.stdout || sr.stderr, 400)}`);
  }
  if (sj.nonce !== n) throw xstop(env.step, 'nonce-moved', `${where}: the signer's simulate reports pending nonce ${sj.nonce}, the plan ${n}`);
  const freshGas = BigInt(sj.results[0].gas_used);
  const gc = gasCheck({ freshGas, planGasUsed: tx.gas_used, planPeak: tx.max_used_gas, gasLimit: tx.gas_limit });
  if (!gc.ok) throw xstop(env.step, gc.kind, `${where}: pre-send gas check (${gc.part}) failed: ${gc.why}`);
  return { hash, freshGas, sim: sj };
}

// ---------------------------------------------------------------------------------------------------------------
// Settlement of nonce n (G section 8 step 4). The signer's own log is not read here: the recorded tx_hash (from the
// broadcast event), the receipt and a block scan forward from the attempt's from_block decide; the match key is
// (nonce, from, to, input hash), never the input hash alone. The scan is resumable: its cursor, the next block to read for
// nonce n, is the planner's own record run/<run-id>/settle-scan.json ({"<n>": {"next_block": B}}), never a field of
// nonce-attempts.json or inflight.json; it advances only past blocks read whole that hold no transaction of the holder
// at n, never past a matched block whose receipt is not readable yet, and it is saved as the scan goes, so a run killed
// mid-scan loses nothing and no block is skipped. o.deadlineMs (else env.deadlineMs, else now + SCAN_BUDGET_MS) bounds it.
// ---------------------------------------------------------------------------------------------------------------
async function settleNonce(env, book, n, o = {}) {
  const att = liveAttempts(book.attempts(), n);
  const nn = await env.H(['nonce', env.holder]);
  const res = { n, latest: nn.latest, pending: nn.pending, attempts: att.length };
  if (nn.latest < n) return { ...res, outcome: 'chain-mismatch', via: `the confirmed nonce ${nn.latest} is below the record's ${n}: the record comes from a chain state that no longer exists` };
  for (const a of att) if (a.tx_hash) {
    const r = await env.H(['receipt', a.tx_hash]);
    if (r.found) return { ...res, outcome: 'landed', via: 'receipt of the recorded tx_hash', hash: a.tx_hash, receipt: r };
  }
  if (nn.latest > n) {
    const now = env.now || Date.now;
    const stopAt = o.deadlineMs || env.deadlineMs || now() + (o.budgetMs || SCAN_BUDGET_MS);
    const head = (await env.H(['block', 'latest'])).number;
    const froms = att.map((a) => a.from_block).filter((x) => Number.isInteger(x));
    const start = froms.length ? Math.min(...froms) : head;
    const cur = book.readJson('settle-scan.json', null) || {};
    const saved = cur[String(n)] && Number.isInteger(cur[String(n)].next_block) ? cur[String(n)].next_block : null;
    const from = saved !== null && saved > start ? saved : start;
    let b = from; let saveAt = from + SCAN_SAVE_EVERY;
    const save = () => { cur[String(n)] = { next_block: b, head_at_last_scan: head, updated_at: lib.nowIso() }; book.writeJson('settle-scan.json', cur); };
    try {
      while (b <= head && now() < stopAt) {
        const blk = await env.H(['block', String(b), env.holder]);
        for (const t of blk.txs_from || []) {
          if (t.nonce !== n) continue;
          const m = att.some((a) => (a.tx_hash && lc(a.tx_hash) === lc(t.hash)) || (a.calldata_hash && lc(a.calldata_hash) === lc(t.input_keccak256) && (a.to === null || a.to === undefined || lc(a.to) === lc(t.to))));
          if (m) { const r = await env.H(['receipt', t.hash]); if (!r.found) return { ...res, outcome: 'pending', via: `block ${b}: matched, receipt not readable yet` }; return { ...res, outcome: 'landed', via: `block ${b}: (nonce, to, input hash) match an attempt`, hash: t.hash, receipt: r }; }
          if (att.every((a) => a.calldata_hash)) return { ...res, outcome: 'not-sent', foreign: { hash: t.hash, input_keccak256: t.input_keccak256, to: t.to, block: b }, via: 'a foreign transaction mined at n matches no recorded attempt' };
          return { ...res, outcome: 'pending', via: 'a transaction is mined at n and an attempt with a null calldata_hash cannot be excluded' };
        }
        b++; // block b - 1 was read whole and holds no transaction of the holder at n
        if (b >= saveAt) { save(); saveAt = b + SCAN_SAVE_EVERY; }
      }
    } finally { if (b !== from) save(); }
    return { ...res, outcome: 'pending', via: b > head ? `latest ${nn.latest} > n but no transaction at n was found in blocks ${start}..${head}: unconfirmed, not failed` : `${b > from ? `scanned blocks ${from}..${b - 1}` : 'no block read'} of head ${head} within this run's time budget, no transaction at n yet: unconfirmed, not failed; resumes at block ${b} at the next settlement` };
  }
  if (nn.pending > n) return { ...res, outcome: 'pending', via: 'the pending nonce is above n, the latest is not' };
  return { ...res, outcome: 'not-sent', via: 'latest == pending == n' };
}

// ---------------------------------------------------------------------------------------------------------------
// One transaction: write-ahead, ONE signer send, then confirmation (or settlement). Returns { hash, receipt }.
// Throws a Stop carrying fields: pre_broadcast_refusal, send_lock_held, keep_aborted, settlement.
// ---------------------------------------------------------------------------------------------------------------
async function broadcast(env, book, tx, n, hash, meta = {}) {
  const where = `${tx.label} (nonce ${n})`;
  if (env.signerModeProblem) throw signerModeStop(env.step, env.signerModeProblem); // before any write-ahead or send
  if (!lockStillOurs(env)) throw xstop(env.step, 'lock-lost', `${where}: run/${lib.LOCK_NAME} or its owner.txt is no longer this run's; nothing more is sent`);
  if (book.exists('inflight.json')) throw xstop(env.step, 'inflight-unsettled', `${where}: ${book.rel('inflight.json')} exists from an earlier broadcast that was never settled`);
  const fromBlock = (await env.H(['block', 'latest'])).number;
  const to = lc(tx.to);
  book.writeJson('inflight.json', { run_id: book.runId, from_address: env.holder, nonce: n, to, calldata_hash: hash, chain_id: TB.CHAIN_ID, from_block: fromBlock });
  book.appendAttempt({ nonce: n, to, calldata_hash: hash, from_block: fromBlock });
  env.open = { book, n, to, calldata_hash: hash, from_block: fromBlock, tx_hash: null, label: tx.label };
  env.ctx.log(`SEND ${where} gasLimit ${tx.gas_limit} calldata_hash ${hash}`);
  const t0 = Date.now();
  let bc = null; const events = [];
  const r = await env.ctx.signer('send', tx.signer_input_file, env.pin ? ['--nonce', String(n)] : [], {
    env: env.signerEnv || undefined, retries: HELPER_RETRIES, // only a throttle before signing is re-run (lib.runSigner)
    onLine: (line, j) => {
      if (!j) return; events.push(j);
      if (j.log_path && !env.logPath) env.logPath = j.log_path;
      if (j.event === 'broadcast' && !bc) {
        bc = j; env.open.tx_hash = j.hash;
        try { const inf = book.readJson('inflight.json', null); if (inf) { inf.tx_hash = j.hash; book.writeJson('inflight.json', inf); } book.completeAttemptHash(n, hash, j.hash); } catch (e) { /* settlement still has the receipt and the block scan */ }
      }
    },
  });
  env.txTimes.push(Date.now() - t0);
  const last = r.last || events[events.length - 1] || {};
  if (!bc) {
    // nothing was broadcast. Provable (no signed bytes) when the signer's own answer says so: retire at once.
    if (last.signed === false && last.broadcast === false) {
      book.retire(n, hash, `${last.refused ? 'refused: ' + last.refused + (last.rule ? ' ' + last.rule : '') : last.error || 'refused'}: ${clip(last.detail || '', 200)}`);
      book.settleInflight(); env.open = null;
      const sendLock = last.refused === 'send-lock';
      throw xstop(env.step, sendLock ? 'send-lock-held' : 'signer-refused', `${where}: refused before any broadcast (signer exit ${r.exit}): ${clip(JSON.stringify(last), 400)}`, { pre_broadcast_refusal: true, send_lock_held: sendLock, keep_aborted: sendLock, lock_path: last.lock_path || null, lock_hash: last.lock ? last.lock.hash || null : null });
    }
    const s = await settleNonce(env, book, n);
    return afterUnclear(env, book, tx, n, s, `${where}: the signer exited ${r.exit} with no broadcast event and no refusal marker: ${clip(r.stdout || r.stderr, 300)}`);
  }
  if (lc(bc.input_hash) !== lc(hash) || bc.nonce !== n) throw xstop(env.step, 'hash-mismatch', `${where}: the broadcast reports input_hash ${bc.input_hash} nonce ${bc.nonce}, the attempt ${hash} nonce ${n}`, { keep_aborted: true });
  const conf = events.find((e) => e.event === 'confirmed' && e.hash === bc.hash);
  if (r.exit === 0 && conf) return confirm(env, book, tx, n, bc.hash, meta);
  const s = await settleNonce(env, book, n);
  return afterUnclear(env, book, tx, n, s, `${where}: the signer ended with ${clip(JSON.stringify(last), 300)} (exit ${r.exit})`, meta);
}

// A settled outcome of an unclear send: Landed with status 1 continues (G section 8 step 4); everything else stops.
async function afterUnclear(env, book, tx, n, s, why, meta = {}) {
  const settlement = { outcome: s.outcome, via: s.via, hash: s.hash || null, latest: s.latest, pending: s.pending, foreign: s.foreign || null };
  env.ctx.log(`settlement of nonce ${n}: ${JSON.stringify(settlement)}`);
  if (s.outcome === 'landed' && s.receipt && s.receipt.success === true) return confirm(env, book, tx, n, s.hash, meta, settlement);
  if (s.outcome === 'landed') { book.settleInflight(); env.open = null; throw xstop(env.step, 'reverted', `${why}; settled: the transaction landed and reverted (${s.hash})`, { settlement, landed_reverted: s.hash }); }
  if (s.outcome === 'not-sent') {
    // a signer that cannot pin the nonce sends no replacement after a not-sent finding (G section 8, Nonce pinning): the
    // finding is not a settlement then, so inflight.json stays and the run-id stays non-final; every later run's
    // start-of-run repair re-settles nonce n until the old transaction lands or a foreign one (an operator's cancel)
    // consumes n (I-setup.md I.2 section 6)
    if (env.pin || s.foreign) book.settleInflight();
    env.open = null;
    throw xstop(env.step, 'not-sent', `${why}; settled Not sent (${s.via})${s.foreign ? `; foreign transaction ${s.foreign.hash} input_keccak256 ${s.foreign.input_keccak256} at nonce ${n}` : ''}`, { settlement, keep_aborted: !env.pin && !s.foreign, foreign: s.foreign || null });
  }
  if (s.outcome === 'chain-mismatch') throw xstop(env.step, 'chain-mismatch', `${why}; ${s.via}`, { settlement, keep_aborted: true });
  throw xstop(env.step, 'pending', `${why}; nonce ${n} is Pending (${s.via}): no recovery is built and nothing more is sent; the next run's start-of-run repair settles it`, { settlement, keep_aborted: true, pending_hash: env.open ? env.open.tx_hash : null, pending_nonce: n });
}

async function confirm(env, book, tx, n, hash, meta = {}, settlement = null) {
  const where = `${tx.label} (nonce ${n})`;
  const rc = await env.H(['receipt', hash]);
  if (!rc.found) { const s = await settleNonce(env, book, n); if (!(s.outcome === 'landed' && s.receipt && s.receipt.success)) return afterUnclear(env, book, tx, n, s, `${where}: no receipt for ${hash} through the helper`, meta); return confirm(env, book, tx, n, s.hash, meta, settlement); }
  if (rc.success !== true) { book.settleInflight(); env.open = null; throw xstop(env.step, 'reverted', `${where}: receipt of ${hash} shows status ${rc.status}`, { landed_reverted: hash }); }
  if (lc(rc.from) !== env.holder || lc(rc.to) !== lc(tx.to)) throw xstop(env.step, 'hash-mismatch', `${where}: receipt from ${rc.from} to ${rc.to}, expected the holder to ${tx.to}`, { keep_aborted: true });
  book.settleInflight(); env.open = null;
  const cost = BigInt(rc.gas_used) * BigInt(rc.effective_gas_price) + BigInt(rc.l1_fee || 0);
  const rec = { at: lib.nowIso(), source: meta.source || env.step, group: meta.group || null, idx: tx.idx === undefined ? null : tx.idx, label: tx.label, nonce: n, tx_hash: hash, block: rc.block_number, to: lc(tx.to), gas_limit: String(tx.gas_limit), gas_used: rc.gas_used, effective_gas_price: rc.effective_gas_price, l1_fee: rc.l1_fee || '0', cost_wei: cost.toString(), rebuilt: !!tx.rebuilt, settled_via: settlement ? settlement.via : null };
  book.addSend(rec);
  env.sentThisInvocation++;
  // the transaction landed and is recorded; only then is the nonce judged (a move after it is someone else's send)
  const n2 = await env.H(['nonce', env.holder]);
  if (n2.latest !== n + 1 || n2.pending !== n + 1) { const e = xstop(env.step, n2.latest !== n2.pending ? 'pending-transaction' : 'nonce-moved', `${where}: landed (${hash}), but after its receipt latest ${n2.latest} pending ${n2.pending}, expected ${n + 1}`); e.landed = { hash, receipt: rc, record: rec }; throw e; }
  env.ctx.log(`  confirmed ${hash} block ${rc.block_number} gas ${rc.gas_used} cost ${eth(cost)}; nonce now ${n2.latest}`);
  return { hash, receipt: rc, record: rec };
}

// The standing authorization (I-setup.md I.2 section 1, G section 8 Two modes): an autonomous send needs all five set
// in the setup record (first_successful_run, autonomy.enabled true with autonomy.authorized_at,
// autonomy.signer_selftest_passed_at, schedule.signer_allow_rule_added_at). Checked by `wake` at its start and again by
// every wrapper-mode send path (exec, halfb, the wake's ramp), so a revocation (autonomy.enabled false) stops sends even
// when a step is driven alone.
function gateProblems(setup) {
  if (!setup) return ['run/setup.deep-r3-trade.json does not exist'];
  const p = [];
  if (!setup.first_successful_run) p.push('first_successful_run is null');
  if (!setup.autonomy || setup.autonomy.enabled !== true) p.push('autonomy.enabled is not true');
  if (!setup.autonomy || !setup.autonomy.authorized_at) p.push('autonomy.authorized_at is null');
  if (!setup.autonomy || !setup.autonomy.signer_selftest_passed_at) p.push('autonomy.signer_selftest_passed_at is null');
  if (!setup.schedule || !setup.schedule.signer_allow_rule_added_at) p.push('schedule.signer_allow_rule_added_at is null');
  return p;
}

// Turn/time budget (G section 8, Room to finish): before a group starts, the time left before the deadline (the
// registered time limit less the reserve for Half B, H and the final write) must cover the whole group. The estimate is
// 1.5 x this invocation's measured wall time per transaction (pre-send checks, send, receipt, rows), 30 s before any.
const DEFAULT_TX_MS = 30000;
function groupFits(env, nTx, deadlineMs) {
  if (!deadlineMs) return { ok: true };
  const c = env.clock || { ms: 0, n: 0 };
  const per = c.n ? Math.max(5000, Math.round((c.ms / c.n) * 1.5)) : DEFAULT_TX_MS;
  const needMs = nTx * per;
  return { ok: Date.now() + needMs <= deadlineMs, needMs, leftMs: deadlineMs - Date.now(), perTxMs: per };
}
function clockAdd(env, ms, n) { env.clock = env.clock || { ms: 0, n: 0 }; env.clock.ms += ms; env.clock.n += n; }

module.exports = {
  RESERVE_WEI, STALE_APPROVAL_MS, SCAN_BUDGET_MS, toWei, weiStr, num, eth, pad, lc,
  xstop, asStop, Book, positionsOpened, liveAttempts, makeEnv, signerRun,
  REFUSED_SIGNER_MODE, SIGNER_MODE_NOTE, signerModeProblem, signerModeStop, refuseSignerMode,
  lockMode, lockHeldStop, takeLock, releaseLock, lockStillOurs,
  affordability, gasCheck, checkInputFile, presend, settleNonce, broadcast, groupFits, clockAdd, gateProblems,
};
