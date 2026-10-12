// planner/g-audit.cjs - the final audit of the written ./run/<run-id>/g-plan.json (ported from the live g-audit), then a FRESH
// re-simulation of every simulate file the plan names. Read-only (helper simulate / nonce). NOTHING IS SIGNED OR SENT.
//
// The calldata audit re-derives every amount and every token from allocation.json, candidates.json, F's own read of the
// wrapped tokens and the balances the plan records, by the rules of G sections 1 (Float to wei, the mint), 2, 3 (routes,
// floors, inMax = min(stake x 1.005, remaining)) and 8 (gas limits), and decodes each transaction with ethers (decode
// only). The re-simulation must pass on the live head as it is now; no block number or hash is compared with the build's
// (G section 8, The head moves): what must hold is the nonce, every status 0x1, nothing clamped, and each call's fresh
// peak within the plan's gas limit. A failed audit removes g-plan.json (kept as planner/g-plan.rejected.json) and stops G.
'use strict';

const lib = require('./lib.cjs');
const TB = require('./table.cjs');
const FL = require('./f-lib.cjs');
const G = require('./g-lib.cjs');

const { clip } = lib;
const { A, lc, gstop } = G;
const MAXU = (1n << 256n) - 1n;

// G section 1 (Float to wei): truncate the decimal string to 18 places; count = stake / quoted_fill divided in decimal, truncated
const dstr = (x) => { const s = String(x); if (/e/i.test(s)) return Number(x).toFixed(30); return s; };
const splitD = (x) => { const [i, f = ''] = dstr(x).split('.'); return { d: BigInt(i + f), sc: f.length }; };
const w18 = (x) => { const [i, f = ''] = dstr(x).split('.'); return BigInt(i + (f + '0'.repeat(18)).slice(0, 18)); };
const cnt = (stake, fill) => { const s = splitD(stake); const f = splitD(fill); return (s.d * 10n ** BigInt(f.sc + 18)) / (f.d * 10n ** BigInt(s.sc)); };

async function audit(R) {
  const { ctx, io, S, E } = R;
  const P = ctx.readRunJson('g-plan.json');
  const ALLOC = ctx.readRunJson('allocation.json');
  const CAND = ctx.readRunJson('candidates.json').candidates;
  const FS = JSON.parse(ctx.readRun('planner/f-state.json').toString('utf8'), FL.rev);
  const holder = S.holder;
  const out = []; const say = (s) => { ctx.log('audit: ' + s); out.push(s); };
  let bad = 0; const failures = [];
  const fail = (m) => { bad++; failures.push(m); say('AUDIT FAIL ' + m); };
  const chk = (cond, m) => { if (!cond) fail(m); };
  const I = new E.Interface(['function approve(address,uint256)', 'function splitPosition(address,address,uint256)', 'function mergePositions(address,address,uint256)',
    'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)',
    'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params)']);
  const dc = (t) => { try { const p = I.parseTransaction({ data: t.data }); return { fn: p.name, a: p.args }; } catch (e) { return { fn: null, a: [] }; } };

  const n0 = await G.checkNonce(io, holder, P.base.pending_nonce, 'G audit');
  // ---------- inputs ----------
  chk(P.run_id === ctx.runId, 'run id');
  chk(P.inputs.allocation_json.path === ctx.rel('allocation.json'), `plan input path is not this run's allocation.json: ${P.inputs.allocation_json.path}`);
  chk(P.inputs.allocation_json.sha256 === lib.sha256(ctx.readRun('allocation.json')), 'allocation.json sha256 differs from the file now');
  chk(lc(P.holder) === lc(holder), 'holder');

  // ---------- structure: the simulate files equal the plan's groups; every transaction's own fields ----------
  const groups = P.groups;
  const covered = new Array(groups.length).fill(0);
  for (const w of P.simulation.windows) {
    let SIM = null;
    try { SIM = JSON.parse(ctx.readRel(w.file).toString('utf8')); } catch (e) { fail(`simulate file ${w.file} unreadable`); continue; }
    chk(lib.sha256(ctx.readRel(w.file)) === w.file_sha256, `${w.file} sha256 differs from the plan's`);
    chk(Array.isArray(SIM) && SIM.length === w.group_indexes.length, `${w.file}: ${SIM && SIM.length} groups, the plan names ${w.group_indexes.length}`);
    w.group_indexes.forEach((gi, local) => {
      const g = groups[gi]; const sg = SIM[local];
      if (!g || !sg || !Array.isArray(sg.calls) || sg.calls.length !== g.txs.length) { fail(`${w.file}: group ${gi} shape`); return; }
      if (g.kind !== 'mint') covered[gi]++;
      g.txs.forEach((t, ti) => { const c = sg.calls[ti]; if (c.to !== t.to || c.data !== t.data || c.value !== '0' || Object.keys(c).sort().join() !== 'data,to,value') fail(`${w.file} differs from the plan at tx ${t.idx}`); });
    });
    // the mint prefix heads every window
    const nMint = groups.filter((g) => g.kind === 'mint').length;
    chk(w.group_indexes.slice(0, nMint).every((gi, k) => gi === k), `${w.file} does not begin with the mint prefix`);
  }
  groups.forEach((g, gi) => { if (g.kind !== 'mint') chk(covered[gi] === 1, `group ${g.id} is in ${covered[gi]} simulate window(s), not 1`); });
  if (groups.length) chk(P.simulation.windows.length > 0, 'no simulate file for a plan with groups');
  let nTx = 0;
  groups.forEach((g, gi) => {
    chk(g.index === gi, `group index ${gi}`);
    g.txs.forEach((t) => {
      nTx++;
      if (E.keccak256(t.data) !== t.calldata_keccak256) fail(`keccak at ${t.idx}`);
      let f = null; try { f = JSON.parse(ctx.readRel(t.signer_input_file).toString('utf8')); } catch (e) { fail(`signer input file of tx ${t.idx} unreadable`); }
      if (f && (!Array.isArray(f.calls) || f.calls.length !== 1 || f.calls[0].to !== t.to || f.calls[0].data !== t.data || f.calls[0].value !== '0' || f.gasLimit !== t.gas_limit || Object.keys(f).sort().join() !== 'calls,gasLimit')) fail(`signer input file differs from the plan at tx ${t.idx}`);
      chk(t.signer_input_file === ctx.rel(`g-tx/tx-${String(t.idx).padStart(3, '0')}.json`), `signer input path at ${t.idx}`);
      const need = (t.max_used_gas !== null && t.max_used_gas !== undefined) ? Math.ceil(t.max_used_gas * 1.2) : Math.ceil(t.gas_used * 1.5);
      if (Number(t.gas_limit) !== Math.min(need, G.CAP_GAS) || Number(t.gas_limit) >= G.CAP_GAS) fail(`gas limit rule at ${t.idx}: ${t.gas_limit} vs ${need}`);
      if (t.nonce_expected !== P.base.first_nonce + t.idx || t.idx !== nTx - 1) fail(`nonce/index at ${t.idx}`);
      chk(t.value === '0', `value at ${t.idx}`);
    });
  });
  const gtx = lib.listRunSubdir(ctx.cfg, ctx.runId, 'g-tx');
  chk(gtx.length === nTx, `g-tx/ holds ${gtx.length} files for ${nTx} transactions`);

  // ---------- calldata semantics, re-derived ----------
  const cByAddr = new Map(CAND.map((c, i) => [lc(c.address), { c, i }]));
  const rowsBy = new Map(); ALLOC.positions.forEach((p) => { const a = lc(p.address); if (!rowsBy.has(a)) rowsBy.set(a, []); rowsBy.get(a).push(p); });
  const M = w18(ALLOC.totals.staked);
  chk(BigInt(P.mint.M_wei) === M, 'M differs from totals.staked');
  const withPos = new Set(); for (const p of ALLOC.positions) { const e = cByAddr.get(lc(p.address)); if (e) withPos.add(TB.T.rows[e.i].bundle); }
  const bX = {}; const mX = {}; G.XS.forEach((x) => { bX[x] = BigInt(P.balances_before['bundle' + x]); if (withPos.has(x)) mX[x] = M + bX[x]; });
  const mintAll = [...(M > 0n ? ['mint-parent'] : []), ...G.XS.filter((x) => mX[x] !== undefined && mX[x] > 0n).map((x) => 'mint-middle-' + x)];
  // a cut plan (g-build: the rebuilt plan failed its simulation again) keeps only the groups before P.cut.at_group
  const mintOrder = P.cut && Number.isInteger(P.cut.at_group) ? mintAll.slice(0, P.cut.at_group) : mintAll;
  mintOrder.forEach((id, k) => chk(groups[k] && groups[k].id === id, `mint group order at ${k}: ${groups[k] && groups[k].id} != ${id}`));
  chk(groups.filter((g) => g.kind === 'mint').length === mintOrder.length, 'mint group count (no zero split; a bundle with no position is not split)');
  const approveOf = (t, token, spender, amt, label) => { const { fn, a } = dc(t); chk(fn === 'approve' && lc(t.to) === lc(token) && lc(a[0]) === lc(spender) && BigInt(a[1]) === amt && BigInt(a[1]) < MAXU, `${label}: approve ${token} -> ${spender} ${amt}, got to ${t.to} ${fn === 'approve' ? a[0] + ' ' + a[1] : fn}`); };
  const mergeOf = (t, market, amt, label) => { const { fn, a } = dc(t); chk(fn === 'mergePositions' && lc(t.to) === lc(A.ROUTER) && lc(a[0]) === lc(A.sUSDS) && lc(a[1]) === lc(market) && BigInt(a[2]) === amt, `${label}: merge ${market} ${amt}`); };
  const splitOf = (t, market, amt, label) => { const { fn, a } = dc(t); chk(fn === 'splitPosition' && lc(t.to) === lc(A.ROUTER) && lc(a[0]) === lc(A.sUSDS) && lc(a[1]) === lc(market) && BigInt(a[2]) === amt, `${label}: split ${market} ${amt}`); };
  const exIn = (t, tin, tout, fee, amt, label) => { const { fn, a } = dc(t); const p = a[0] || {}; chk(fn === 'exactInputSingle' && lc(t.to) === lc(A.SWAP) && lc(p.tokenIn) === lc(tin) && lc(p.tokenOut) === lc(tout) && Number(p.fee) === fee && lc(p.recipient) === lc(holder) && BigInt(p.amountIn) === amt && BigInt(p.sqrtPriceLimitX96) === 0n && BigInt(p.amountOutMinimum) > 0n, `${label}: exactInputSingle`); return fn === 'exactInputSingle' ? BigInt(p.amountOutMinimum) : 0n; };
  const exOut = (t, tin, tout, fee, o, inMax, label) => { const { fn, a } = dc(t); const p = a[0] || {}; chk(fn === 'exactOutputSingle' && lc(t.to) === lc(A.SWAP) && lc(p.tokenIn) === lc(tin) && lc(p.tokenOut) === lc(tout) && Number(p.fee) === fee && lc(p.recipient) === lc(holder) && BigInt(p.amountOut) === o && BigInt(p.amountInMaximum) === inMax && BigInt(p.sqrtPriceLimitX96) === 0n, `${label}: exactOutputSingle`); };
  const tokens = (a) => {
    const { c, i } = cByAddr.get(a); const [d, u, inv] = FS.wrapped[i].map(lc);
    const feeOf = (s) => c.pools.find((p) => p.outcome === s).fee_tier;
    return { repo: lc(c.collateral_token), down: d, up: u, inv, fee: { UP: feeOf('UP'), DOWN: feeOf('DOWN') }, bundle: TB.T.rows[i].bundle, name: c.market };
  };
  const rowKeys = new Set(); const seenKinds = {}; const rem = new Map(); const spend = new Map(); const avail = new Map();
  for (const g of groups) {
    seenKinds[g.kind] = (seenKinds[g.kind] || 0) + 1;
    if (g.kind === 'mint') {
      chk(g.txs.length === 2, `${g.id} tx count`);
      if (g.id === 'mint-parent') { approveOf(g.txs[0], A.sUSDS, A.ROUTER, M, g.id); splitOf(g.txs[1], A.PARENT, M, g.id); } else { const x = g.id.slice(-1); approveOf(g.txs[0], G.BUNDLES[x], A.ROUTER, mX[x], g.id); splitOf(g.txs[1], G.MIDDLES[x], mX[x], g.id); }
      continue;
    }
    const a = lc(g.address); if (!cByAddr.has(a)) { fail(`${g.id}: unknown market`); continue; }
    const tk = tokens(a); const byS = Object.fromEntries((rowsBy.get(a) || []).map((r) => [r.side, r])); const L = g.id;
    if (!rem.has(a)) { const v = BigInt(P.balances_before['repo:' + tk.name] || '0') + (mX[tk.bundle] !== undefined ? mX[tk.bundle] : 0n); rem.set(a, v); avail.set(a, v); spend.set(a, 0n); }
    (g.allocation_rows || []).forEach((r) => { const k = a + ':' + r.side; if (rowKeys.has(k)) fail('duplicate row ' + k); rowKeys.add(k); });
    const sp = (w) => spend.set(a, spend.get(a) + w);
    if (g.kind === 'set-sell') {
      const q = w18(byS.set.stake); chk(byS.set.route === 'set-sell' && g.txs.length === 6, `${L} shape`);
      approveOf(g.txs[0], tk.repo, A.ROUTER, q, L); splitOf(g.txs[1], a, q, L); approveOf(g.txs[2], tk.up, A.SWAP, q, L); const m1 = exIn(g.txs[3], tk.up, tk.repo, tk.fee.UP, q, L); approveOf(g.txs[4], tk.down, A.SWAP, q, L); const m2 = exIn(g.txs[5], tk.down, tk.repo, tk.fee.DOWN, q, L);
      chk(m1 + m2 >= q, `${L}: the two set-sell floors sum below q`);
      sp(q); rem.set(a, rem.get(a) - q + BigInt(g.txs[3].swap.quoted_amountOut) + BigInt(g.txs[5].swap.quoted_amountOut));
    } else if (g.kind === 'merge-arb') {
      // G section 3: q = stake / quoted_fill clamped at the child Invalid read before the plan (a few wei of rounding);
      // amountInMaximum = quoted_in_leg x min(q / quoted_cost, 1.005); the q merged repo tokens return to the market
      const q0 = cnt(byS.set.stake, byS.set.quoted_fill); const Ij = BigInt(P.balances_before['Inv:' + tk.name] || '0'); const q = q0 > Ij && (q0 - Ij) * 10n ** 12n <= q0 ? Ij : q0;
      chk(byS.set.route === 'merge-arb' && g.txs.length === 7 && g.recorded_route === 'buy-and-merge', `${L} shape`);
      const qu = BigInt((g.txs[1].swap || {}).quoted_amountIn || 0); const qd = BigInt((g.txs[2].swap || {}).quoted_amountIn || 0); const cost = qu + qd;
      chk(cost > 0n && cost < q, `${L}: quoted cost ${cost} not below q ${q}`);
      const maxFor = (ql) => { const x = ql * q / cost; const y = ql * 10050n / 10000n; return x < y ? x : y; };
      const mu = cost > 0n ? maxFor(qu) : 0n; const md = cost > 0n ? maxFor(qd) : 0n;
      approveOf(g.txs[0], tk.repo, A.SWAP, mu + md, L); exOut(g.txs[1], tk.repo, tk.up, tk.fee.UP, q, mu, `${L} UP`); exOut(g.txs[2], tk.repo, tk.down, tk.fee.DOWN, q, md, `${L} DOWN`);
      approveOf(g.txs[3], tk.up, A.ROUTER, q, L); approveOf(g.txs[4], tk.down, A.ROUTER, q, L); approveOf(g.txs[5], tk.inv, A.ROUTER, q, L); mergeOf(g.txs[6], a, q, L);
      chk(cost <= rem.get(a), `${L}: quoted cost above what the market has`);
      sp(w18(byS.set.stake)); rem.set(a, rem.get(a) - cost + q);
    } else if (g.kind === 'complex-buy') {
      const s = Object.keys(byS).find((k) => k === 'UP' || k === 'DOWN'); const o = s === 'UP' ? 'DOWN' : 'UP'; const x = w18(byS[s].stake);
      chk(g.txs.length === 6 && Object.keys(byS).filter((k) => k !== 'set').length === 1, `${L} shape`);
      approveOf(g.txs[0], tk.repo, A.ROUTER, x, L); splitOf(g.txs[1], a, x, L); approveOf(g.txs[2], tk[o.toLowerCase()], A.SWAP, x, L); exIn(g.txs[3], tk[o.toLowerCase()], tk.repo, tk.fee[o], x, L);
      chk(g.txs[3].label.startsWith('sell x'), `${L}: the sale's label must start with "sell x" (the executor's key)`);
      const Pq = BigInt((dc(g.txs[5]).a[0] || {}).amountIn || 0); approveOf(g.txs[4], tk.repo, A.SWAP, Pq, L); exIn(g.txs[5], tk.repo, tk[s.toLowerCase()], tk.fee[s], Pq, L);
      chk(g.txs[4].rebuild_at_send && g.txs[5].rebuild_at_send, `${L}: the last two transactions are not marked rebuild_at_send`);
      sp(x); rem.set(a, rem.get(a) - x);
    } else if (g.kind === 'dual-buy') {
      chk(byS.UP && byS.DOWN && g.txs.length === 4, `${L} shape`);
      if (byS.UP && byS.DOWN) {
        [['UP', 0], ['DOWN', 2]].forEach(([s, k]) => {
          const sw = w18(byS[s].stake); const c = cnt(byS[s].stake, byS[s].quoted_fill);
          const inMax = G.minB(sw * 10050n / 10000n, rem.get(a)); // G section 3: min(stake x 1.005, remaining)
          approveOf(g.txs[k], tk.repo, A.SWAP, inMax, `${L} ${s}`); exOut(g.txs[k + 1], tk.repo, tk[s.toLowerCase()], tk.fee[s], c, inMax, `${L} ${s}`);
          const qin = BigInt(g.txs[k + 1].swap.quoted_amountIn); chk(qin <= inMax, `${L} ${s}: quoted amountIn above inMax`);
          sp(sw); rem.set(a, rem.get(a) - qin);
        });
      }
    } else if (g.kind === 'simple-buy') {
      const s = Object.keys(byS).find((k) => k === 'UP' || k === 'DOWN'); const x = w18(byS[s].stake);
      chk(g.txs.length === 2 && Object.keys(byS).filter((k) => k !== 'set').length === 1, `${L} shape`);
      approveOf(g.txs[0], tk.repo, A.SWAP, x, L); exIn(g.txs[1], tk.repo, tk[s.toLowerCase()], tk.fee[s], x, L);
      sp(x); rem.set(a, rem.get(a) - x);
    } else fail('unknown group kind ' + g.kind);
  }
  for (const [a, w] of spend) if (w > avail.get(a)) fail(`market ${cByAddr.get(a).c.market} nominal spend ${w} exceeds held_j + m_X ${avail.get(a)}`);
  const allocKeys = new Set(ALLOC.positions.map((r) => lc(r.address) + ':' + r.side));
  const skipKeys = new Set((P.skipped_rows || []).map((r) => lc(r.address) + ':' + r.side));
  const union = new Set([...rowKeys, ...skipKeys]);
  chk([...rowKeys].every((k) => !skipKeys.has(k)), 'a row is both in a group and skipped');
  chk(allocKeys.size === union.size && [...allocKeys].every((k) => union.has(k)), `allocation rows vs plan groups + skipped rows: ${allocKeys.size} vs ${union.size}`);
  chk(P.route_counts.transactions === nTx && P.route_counts.groups === groups.length, 'route_counts');
  say(`calldata audit: ${groups.length} groups, ${nTx} transactions decoded and re-derived from allocation.json (${ALLOC.positions.length} rows: ${rowKeys.size} in groups, ${skipKeys.size} skipped), kinds ${JSON.stringify(seenKinds)}, every approval exact (none near 2^256), every swap recipient the holder, every tier the candidates.json tier, dual-buy inMax = min(stake x 1.005, remaining); failures ${bad}`);

  // ---------- a fresh re-simulation of every simulate file, on the head as it is now ----------
  let gasDiffer = 0; let rowsChecked = 0; const badBeforeResim = bad; let resimFirstFail = null;
  for (const w of P.simulation.windows) {
    const r = await io.H(['simulate', w.file]);
    const planTxs = w.group_indexes.flatMap((gi) => groups[gi].txs);
    const pb = G.pageProblems(r, { entries: w.group_indexes.length, count: planTxs.length, pendingNonce: P.base.pending_nonce });
    pb.forEach((x) => fail(`fresh re-simulation of ${w.file}: ${x}`));
    if (r.all_success !== true && Number.isInteger(r.first_failed_group) && r.first_failed_group < w.group_indexes.length) { const gi = w.group_indexes[r.first_failed_group]; if (resimFirstFail === null || gi < resimFirstFail) resimFirstFail = gi; }
    (r.calls || []).forEach((row, i) => {
      const t = planTxs[i]; rowsChecked++;
      if (!t || row[0] !== i || row[2] !== '0x1') { fail(`fresh re-simulation of ${w.file}: row ${i} ${clip(JSON.stringify(row), 80)}`); return; }
      const peak = Number(row[4] === null || row[4] === undefined ? row[3] : row[4]);
      if (peak > Number(t.gas_limit)) fail(`fresh re-simulation of ${w.file}: tx ${t.idx} peak ${peak} above the plan's gas_limit ${t.gas_limit}`);
      if (Number(row[3]) !== Number(t.gas_used)) gasDiffer++;
    });
    if ((r.calls || []).length !== planTxs.length) fail(`fresh re-simulation of ${w.file}: ${(r.calls || []).length} rows for ${planTxs.length} transactions`);
    say(`fresh re-simulation of ${w.file} (sha256 ${w.file_sha256}): ${JSON.stringify({ entries: r.entries, count: r.count, all_success: r.all_success, failed_count: r.failed_count, over_cap_count: r.over_cap_count, clamped_count: r.clamped_count, pending_nonce: r.pending_nonce, overrides_active: r.overrides_active === undefined ? 'absent' : r.overrides_active, no_max_used_gas_count: r.no_max_used_gas_count === undefined ? 0 : r.no_max_used_gas_count })}`);
  }
  const n1 = await G.checkNonce(io, holder, P.base.pending_nonce, 'G audit (after the re-simulation)');
  say(`holder nonce latest/pending before ${n0.latest}/${n0.pending}, after ${n1.latest}/${n1.pending} (the plan's ${P.base.pending_nonce}); per-call rows of the fresh simulation: ${rowsChecked} checked, every status 0x1 and every fresh peak within the plan's gas_limit${gasDiffer ? `; ${gasDiffer} gasUsed value(s) differ from the build's (the state moved; the executor's pre-send gas check decides per transaction)` : '; gasUsed equal to the build\'s on all'}`);
  say(bad ? `AUDIT: ${bad} FAILURE(S)` : 'AUDIT PASSED: every acceptance check holds');

  // ---------- section 9 of gate-print.md (idempotent) ----------
  let gp = ctx.readRun('gate-print.md').toString('utf8'); const cut = gp.indexOf('\n## 9. Audit'); if (cut >= 0) gp = gp.slice(0, cut + 1);
  gp = gp.replace(/\n+$/, '\n') + '\n## 9. Audit of the written plan (run after `g-plan.json` was written)\n\n' + out.map((x) => '- ' + x).join('\n') + '\n';
  ctx.writeRun('gate-print.md', gp);
  if (bad) {
    ctx.writeRun('planner/g-plan.rejected.json', ctx.readRun('g-plan.json'));
    ctx.removeRun('g-plan.json');
    // a failure of the fresh re-simulation alone (the calldata audit clean) is a failing pre-send simulation (G section 8)
    const staleSim = badBeforeResim === 0 && resimFirstFail !== null;
    throw gstop('audit-failed', `the audit of the written plan failed ${bad} check(s) (g-plan.json removed, kept as planner/g-plan.rejected.json): ${clip(failures.slice(0, 5).join(' | '), 900)}`, { audit_failures: bad, stale_simulation: staleSim, first_failed_group: staleSim ? resimFirstFail : null, first_failed_group_id: staleSim ? groups[resimFirstFail].id : null });
  }
  return { failures: 0, rows_checked: rowsChecked, gas_used_differ: gasDiffer, lines: out };
}

module.exports = { audit };
