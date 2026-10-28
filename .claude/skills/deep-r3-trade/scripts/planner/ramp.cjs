// planner/ramp.cjs - the PSM3 ramp of the scheduled run (I-setup.md I.1 section 5, I.2 section 2 Half A; G section 1,
// "Before the mint - the PSM3 ramp"): any USDC and USDS at the holder reaches sUSDS through PSM3 as its own batch, after
// E and before F, simulated and sent under the autonomous rule, so that F sizes on the actual post-ramp sUSDS (F reads
// the balance fresh). Not a subcommand: the wake runs it in process (lib.runStep with this module), and it refuses to
// run outside the wrapper's lock. A supervised session sends its ramp on its own "yes", outside this planner (F's
// `--provisional` sizes a plan on a queued ramp).
//
// One group per asset held (USDC first, then USDS), each, per I.1 section 5:
//   1. QUOTE     PSM3.previewSwapExactIn(asset, sUSDS, amountIn), amountIn = the whole balance (USDC has 6 decimals)
//   2. CAPACITY  sUSDS.balanceOf(PSM3) >= the quote, read before the group and again right before the swap
//   3. APPROVE   asset.approve(PSM3, amountIn), exact, never max
//   4. SWAP      PSM3.swapExactIn(asset, sUSDS, amountIn, minAmountOut = quote x 9999 / 10000, holder, 0)
// The calldata comes from the helper's `encode`; both groups are simulated in one eth_simulateV1 request (the helper's
// `simulate`) and every signer-input file passes the signer's policy-only `check` before anything is sent. Then each
// group goes through exec-core, the one sending path: the time budget, affordability, the nonce, the file and its hash,
// the signer's own simulate and the three-part gas check, inflight.json and the attempt under this run-id before the
// broadcast, one `send`, the receipt. The ramp is the run's first broadcast: exec then counts it (anySent), so a later
// failing simulation skips instead of re-planning (G section 1). It is not a fills.json row; its record for
// reconciling the holder's balances (H, and a supervised check against fills.json) is ./run/<run-id>/ramp.json (amounts, quotes, the tx hashes,
// receipts' blocks and gas, sUSDS before and after), and every send is in exec-sends.json with source "ramp".
// A stop (stale simulation, refusal, capacity, affordability, time budget, a Pending or unclear nonce) ends Half A
// before F; a nonce left unsettled keeps the wake aborted (keep_aborted).
'use strict';

const lib = require('./lib.cjs');
const TB = require('./table.cjs');
const G = require('./g-lib.cjs');
const X = require('./exec-core.cjs');

const { clip } = lib;
const { lc, weiStr } = X;
const STEP = 'ramp';
const PSM3 = TB.ADDR.PSM3; const SUSDS = lc(TB.ADDR.sUSDS);
const ASSETS = [{ name: 'USDC', token: TB.ADDR.USDC, decimals: 6 }, { name: 'USDS', token: TB.ADDR.USDS, decimals: 18 }];
const SIG = { approve: 'approve(address,uint256)', swap: 'swapExactIn(address,address,uint256,uint256,address,uint256)', preview: 'previewSwapExactIn(address,address,uint256)(uint256)', bal: 'balanceOf(address)(uint256)' };
const stop = (kind, notes, fields) => X.xstop(STEP, kind, notes, fields);
const units = (amt, dec) => { const s = amt.toString().padStart(dec + 1, '0'); const i = s.slice(0, s.length - dec); const f = s.slice(s.length - dec).replace(/0+$/, ''); return i + (f ? '.' + f : ''); };

async function readBalances(env) {
  const r = await env.mc([...ASSETS.map((a) => ({ to: a.token, signature: SIG.bal, args: [env.holder] })), { to: SUSDS, signature: SIG.bal, args: [env.holder] }]);
  const out = {}; ASSETS.forEach((a, k) => { out[a.name] = BigInt(r.results[k][0]); }); out.sUSDS = BigInt(r.results[ASSETS.length][0]); out.block = r.block;
  return out;
}
async function capacity(env) { return BigInt((await env.mc([{ to: SUSDS, signature: SIG.bal, args: [PSM3] }])).results[0][0]); }

async function run(ctx) {
  const rid = ctx.runId;
  const lk = X.lockMode(ctx);
  if (lk.mode !== 'wrapper') { ctx.noDetail = true; throw stop('not-scheduled', `the ramp step runs inside the wake only (run/${lib.LOCK_NAME} held by the wrapper naming run ${rid}); a supervised session sends its ramp on its own "yes"`); }
  const setup = lib.readSetup(ctx.cfg);
  X.refuseSignerMode(STEP, setup); // signer mode (b): refused before any read or signer call (exec-core)
  const env = X.makeEnv(ctx, { step: STEP, holder: ctx.holder(), setup });
  const bal0 = await readBalances(env);
  const held = ASSETS.filter((a) => bal0[a.name] > 0n);
  const base = { susds_before: weiStr(bal0.sUSDS), usdc_raw: bal0.USDC.toString(), usds_raw: bal0.USDS.toString() };
  if (!held.length) return { ran: false, reason: 'USDC and USDS are both 0: no ramp', ...base, sent: [], artifacts: [] };
  if (ctx.opts.blockSends) throw stop('sends-blocked', `a PSM3 ramp is due (USDC ${units(bal0.USDC, 6)}, USDS ${weiStr(bal0.USDS)}) and this wake sends nothing: ${ctx.opts.blockSends}; Half A stops before F`, { keep_aborted: true, ...base });
  const gp = X.gateProblems(setup);
  if (gp.length) throw stop('autonomy-gate', `an autonomous send needs the standing authorization (I-setup.md I.2 section 1): ${gp.join('; ')}; nothing was sent`, { gate: gp, ...base });
  env.lock = { mode: 'wrapper', taken: false, text: lk.text, owner: lk.owner }; env.deadlineMs = ctx.opts.deadlineMs || null;
  const book = new X.Book(ctx.cfg, rid);
  if (book.exists('inflight.json')) throw stop('inflight-unsettled', `${book.rel('inflight.json')} is present: settle it before anything is sent`);
  const artifacts = [];

  // 1. quote each asset held, then encode its two calls through the helper
  const pv = await env.mc(held.map((a) => ({ to: PSM3, signature: SIG.preview, args: [a.token, SUSDS, bal0[a.name].toString()] })));
  const groups = [];
  for (let k = 0; k < held.length; k++) {
    const a = held[k]; const amountIn = bal0[a.name]; const quote = BigInt(pv.results[k][0]); const minOut = quote * 9999n / 10000n;
    if (minOut <= 0n) throw stop('ramp-quote', `PSM3 quotes ${quote} sUSDS for ${units(amountIn, a.decimals)} ${a.name}: nothing to ramp at a nonzero floor`, base);
    const ea = await env.H(['encode', SIG.approve, PSM3, amountIn.toString()]);
    const es = await env.H(['encode', SIG.swap, a.token, SUSDS, amountIn.toString(), minOut.toString(), env.holder, '0']);
    groups.push({ id: `ramp:${a.name}`, address: lc(PSM3), asset: a, amountIn, quote, minOut, txs: [
      { label: `approve ${a.name} -> PSM3 (amountIn)`, kind: 'approve', to: lc(a.token), data: ea.calldata, calldata_keccak256: lc(ea.keccak256) },
      { label: `PSM3.swapExactIn(${a.name}, sUSDS, amountIn, quote x 9999/10000, holder, 0)`, kind: 'swap', to: lc(PSM3), data: es.calldata, calldata_keccak256: lc(es.keccak256) }] });
  }
  // 2. the capacity gate (I-setup.md I.1 section 5, step 2: previewSwapExactIn does not check inventory)
  const need = groups.reduce((s, g) => s + g.quote, 0n); const cap0 = await capacity(env);
  if (cap0 < need) throw stop('psm3-capacity', `PSM3 holds ${weiStr(cap0)} sUSDS, below the ${weiStr(need)} the ramp would take out (I-setup.md I.1 section 5, the capacity gate); nothing was sent`, base);
  // 3. the whole ramp simulated in one request (G section 8, Money rules: the ramp leads the ordered sequence)
  const nn = await env.H(['nonce', env.holder]);
  if (nn.latest !== nn.pending) throw stop('pending-transaction', `a transaction of the holder is pending (latest ${nn.latest}, pending ${nn.pending}); nothing of the ramp is sent`, { keep_aborted: true, ...base });
  const io = { simulate: async (name, gs) => { ctx.writeRun(name, JSON.stringify(gs)); return env.H(['simulate', ctx.rel(name)]); } };
  const sim = await G.simulatePlan(ctx, io, groups, 0, 'ramp-sim');
  sim.windows.forEach((w) => artifacts.push(w.file));
  const problems = []; for (const w of sim.windows) { const pb = G.pageProblems(w.page, { entries: w.groupIdx.length, count: w.groupIdx.reduce((s, gi) => s + groups[gi].txs.length, 0), pendingNonce: nn.pending }); if (pb.length) problems.push(`${w.file}: ${pb.join('; ')}`); }
  if (problems.length) throw stop('stale-simulation', `the ramp's simulation is not clean: ${clip(problems.join(' | '), 500)}; nothing was sent, Half A stops before F (G section 8, A failing pre-send simulation)`, base);
  let k = 0;
  for (const g of groups) for (const t of g.txs) {
    const row = sim.rows[k]; t.idx = k; t.nonce_expected = nn.pending + k; k++;
    t.gas_used = Number(row[3]); t.max_used_gas = row[4] === null || row[4] === undefined ? null : Number(row[4]); t.gas_limit = String(row[5]);
    const name = `ramp-tx/tx-n${t.nonce_expected}.json`; ctx.writeRun(name, JSON.stringify({ calls: [{ to: t.to, data: t.data, value: '0' }], gasLimit: t.gas_limit })); t.signer_input_file = ctx.rel(name);
  }
  artifacts.push(`${ctx.rel('ramp-tx')}/ (${k} file${k === 1 ? '' : 's'})`);
  // 4. the signer's policy-only check of every file before anything is sent
  for (const g of groups) for (const t of g.txs) { const c = await X.signerRun(env, 'check', t.signer_input_file); if (!(c.exit === 0 && c.last && c.last.allowed === true)) throw stop('allowlist-refused', `the signer's check refused ${t.label}: ${clip(c.stdout || c.stderr, 300)}; nothing was sent`, base); }

  // 5. send, group by group, through exec-core
  const record = { run_id: rid, started_at: lib.nowIso(), holder: env.holder, susds_before: bal0.sUSDS.toString(), usdc_before: bal0.USDC.toString(), usds_before: bal0.USDS.toString(), groups: groups.map((g) => ({ id: g.id, asset: g.asset.name, amount_in: g.amountIn.toString(), quote_susds: g.quote.toString(), min_amount_out: g.minOut.toString(), capacity_at_send: null, txs: [] })), status: 'sending' };
  const saveRecord = () => { ctx.writeRunJson('ramp.json', record, { indent: 1 }); };
  const sent = [];
  try {
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]; const rg = record.groups[gi];
      const fit = X.groupFits(env, g.txs.length, ctx.opts.deadlineMs || null);
      if (!fit.ok) throw stop('time-budget', `turn/time budget exhausted before the ramp group ${g.id} (G section 8, Room to finish)`, { budget_exhausted: true });
      const af = await X.affordability(env, g.txs);
      if (!af.ok) throw stop('affordability-skip', `affordability: ${af.text}; the ramp group ${g.id} is not started, nor anything after it (G section 8, Affordability)`, { eth: af.eth.toString(), need: af.need.toString() });
      const t0 = Date.now();
      for (const t of g.txs) {
        if (t.kind === 'swap') { const cap = await capacity(env); rg.capacity_at_send = cap.toString(); if (cap < g.quote) throw stop('psm3-capacity', `${g.id}: PSM3 holds ${weiStr(cap)} sUSDS right before the swap, below the quote ${weiStr(g.quote)} (I-setup.md I.1 section 5)`); }
        const ps = await X.presend(env, book, t, t.nonce_expected);
        const res = await X.broadcast(env, book, t, t.nonce_expected, ps.hash, { source: 'ramp', group: g.id });
        rg.txs.push({ label: t.label, nonce: t.nonce_expected, tx_hash: res.hash, block: res.receipt.block_number, gas_used: res.receipt.gas_used, effective_gas_price: res.receipt.effective_gas_price, l1_fee: res.receipt.l1_fee || '0' }); saveRecord();
      }
      X.clockAdd(env, Date.now() - t0, g.txs.length);
      sent.push({ id: g.id, txs: rg.txs.map((x) => x.tx_hash) });
    }
  } catch (e) {
    const s = X.asStop(STEP, e);
    if (env.open) {
      try {
        const st = await X.settleNonce(env, book, env.open.n);
        const keepOpen = st.outcome === 'not-sent' && !env.pin && !st.foreign; // G section 8, Nonce pinning
        if (st.outcome === 'landed' || (st.outcome === 'not-sent' && !keepOpen)) book.settleInflight();
        if (st.outcome === 'pending' || keepOpen) s.fields = { ...s.fields, keep_aborted: true };
      } catch (x) { s.fields = { ...s.fields, keep_aborted: true }; }
      env.open = null;
    }
    record.status = 'stopped'; record.stop = { kind: s.cause, notes: clip(s.notes, 600) }; record.ended_at = lib.nowIso(); saveRecord();
    s.fields = { ...s.fields, ...base, sent, record: ctx.rel('ramp.json'), artifacts: [...artifacts, ctx.rel('ramp.json')], notes_for_report: `the PSM3 ramp stopped (${s.cause}); Half A stops before F` };
    throw s;
  }
  // 6. sUSDS re-read once the ramp has landed (F reads it fresh again)
  const bal1 = await readBalances(env);
  record.status = 'landed'; record.ended_at = lib.nowIso(); record.susds_after = bal1.sUSDS.toString(); record.susds_delta = (bal1.sUSDS - bal0.sUSDS).toString(); saveRecord();
  artifacts.push(ctx.rel('ramp.json'));
  return { ran: true, ...base, assets: groups.map((g) => ({ asset: g.asset.name, amount_in: units(g.amountIn, g.asset.decimals), quote_susds: weiStr(g.quote), min_amount_out: weiStr(g.minOut) })), sent, transactions_sent: env.sentThisInvocation, susds_after: weiStr(bal1.sUSDS), susds_delta: weiStr(bal1.sUSDS - bal0.sUSDS), record: ctx.rel('ramp.json'), artifacts };
}

// The ramp's own sends of a run-id, from its record: G refuses a run-id whose sends have started, except a run-id whose
// only sends are its landed PSM3 ramp (G section 1: in autonomous mode the ramp is sent ahead of F and G).
function rampOnlySends(ctx) {
  if (ctx.existsRun('fills.json') || ctx.existsRun('inflight.json')) return false;
  let rec = null; try { rec = ctx.existsRun('ramp.json') ? ctx.readRunJson('ramp.json') : null; } catch (e) { rec = null; }
  if (!rec || rec.status !== 'landed') return false;
  const nonces = new Set(rec.groups.flatMap((g) => g.txs.map((t) => t.nonce)));
  let att = []; let sends = [];
  try { att = ctx.existsRun('nonce-attempts.json') ? ctx.readRunJson('nonce-attempts.json') : []; sends = ctx.existsRun('exec-sends.json') ? ctx.readRunJson('exec-sends.json') : []; } catch (e) { return false; }
  return att.every((a) => nonces.has(a.nonce)) && sends.every((s) => s.source === 'ramp' && nonces.has(s.nonce));
}

module.exports = { run, rampOnlySends };
