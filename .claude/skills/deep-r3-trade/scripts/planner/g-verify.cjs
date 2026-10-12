// planner/g-verify.cjs - G's verification pass (ported from the live g-verify), on the built plan:
//  A. every transaction's calldata re-encoded by the helper's `encode` and compared with the ethers encoding (bytes and
//     keccak256); a mismatch is a mis-copied byte: a safety refusal (exit 4), nothing is written;
//  B. one signer-input file per transaction, ./run/<run-id>/g-tx/tx-NNN.json = {"calls":[one call],"gasLimit":"<helper
//     gas_limit>"}, and the signer's policy-only `check` on every one (no RPC, no key, nothing signed); a refusal stops G;
//  C. the end state each group predicts (from its quotes, starting from the balances G read) against the simulated end
//     state, read through the helper's "return" probe: each simulate window re-run with one final group of flagged
//     balanceOf calls, 20 per request. A difference is recorded and reported, never hidden; the pools may have moved
//     since the build (G section 8, The head moves), and each call's floor is what guards a send.
// NOTHING IS SIGNED OR SENT.
'use strict';

const lib = require('./lib.cjs');
const G = require('./g-lib.cjs');

const { clip } = lib;
const { A, lc, gstop, gsafety } = G;

// The helper `encode` arguments of one transaction (the live form: scalars as strings, a struct as one JSON argument).
function encodeArgs(t) {
  const c = t.call; const a = c.args.map((x) => (typeof x === 'bigint' ? x.toString() : x));
  if (c.fn === 'approve' || c.fn === 'splitPosition' || c.fn === 'mergePositions') return a.map(String);
  return [JSON.stringify(a.map((x, i) => (i === 2 || i === 6 ? Number(x) : String(x))))];
}

// The predicted effect of each group, by token, from its quotes (the executor reads these keys: an interface).
function predictEffects(S, built) {
  const { groups, M, mX, tm } = built;
  const mk = new Map(tm.map((m) => [m.addr, m]));
  const exp = new Map(); const names = new Map();
  const add = (tok, d) => exp.set(lc(tok), (exp.get(lc(tok)) || 0n) + d);
  const nm = (tok, n) => names.set(lc(tok), n);
  nm(A.sUSDS, 'sUSDS'); for (const x of G.XS) { nm(G.BUNDLES[x], 'bundle' + x); nm(G.MID_INV[x], 'middleInvalid' + x); } nm(A.PARENT_INVALID, 'parentInvalid');
  for (const m of tm) { nm(m.repo, 'repo:' + m.name); nm(m.up, 'UP:' + m.name); nm(m.down, 'DOWN:' + m.name); nm(m.inv, 'Inv:' + m.name); }
  // the start state: every balance G read (a record of what the holder holds, never a refusal)
  for (const [tok, n] of names) add(tok, S.balances[n] === undefined ? 0n : S.balances[n]);
  const effects = {};
  for (const g of groups) {
    const m = mk.get(lc(g.address)); const e = {};
    const sw = (k, tok, d) => { e[k] = (e[k] || 0n) + d; add(tok, d); };
    if (g.kind === 'mint') {
      if (g.id === 'mint-parent') { sw('sUSDS', A.sUSDS, -M); for (const x of G.XS) sw('bundle' + x, G.BUNDLES[x], M); sw('parentInvalid', A.PARENT_INVALID, M); } else {
        const x = g.id.slice(-1); sw('bundle' + x, G.BUNDLES[x], -mX[x]); sw('middleInvalid' + x, G.MID_INV[x], mX[x]);
        e[`each of the ${G.BUNDLE_N[x]} repo tokens of bundle ${x}`] = mX[x];
        for (const mm of tm) if (mm.bundle === x) add(mm.repo, mX[x]);
      }
    } else if (g.kind === 'merge-arb') {
      // buy q UP and q DOWN at their quoted amountIn, merge q with q held child Invalid: q repo tokens back (G section 3)
      sw('repo', m.repo, -m.setInfo.cost + m.setInfo.q); sw('UP', m.up, 0n); sw('DOWN', m.down, 0n); sw('childInvalid', m.inv, -m.setInfo.q);
    } else if (g.kind === 'set-sell') {
      sw('repo', m.repo, -m.setInfo.q + m.setInfo.proceeds); sw('childInvalid', m.inv, m.setInfo.q);
    } else if (g.kind === 'simple-buy') {
      const sd = m.s; sw('repo', m.repo, -m.x); sw(sd, sd === 'UP' ? m.up : m.down, g.txs[1].swap.quoted_amountOut);
    } else if (g.kind === 'complex-buy') {
      const sd = m.s; sw('repo', m.repo, -m.x); sw('childInvalid', m.inv, m.x); sw(sd, sd === 'UP' ? m.up : m.down, m.x + m.buyQ);
    } else if (g.kind === 'dual-buy') {
      const tu = g.txs[1]; const td = g.txs[3];
      sw('repo', m.repo, -(tu.swap.quoted_amountIn + td.swap.quoted_amountIn)); sw('UP', m.up, tu.swap.amountOut); sw('DOWN', m.down, td.swap.amountOut);
    }
    effects[g.id] = e;
  }
  return { exp, names, effects };
}

async function verify(R, built) {
  const { ctx, io, S, E } = R;
  const say = (s) => ctx.log(s);
  const Bd = G.builders(E, S.holder);
  await G.checkNonce(io, S.holder, S.nonce.pending, 'G verify');
  const txs = built.groups.flatMap((g) => g.txs.map((t) => ({ g, t })));
  say(`verify: ${txs.length} transactions in ${built.groups.length} groups`);

  // ---------- A. helper `encode` vs ethers ----------
  let encBad = 0; const encBadList = [];
  for (const { t } of txs) {
    const r = await io.H(['encode', G.SIG[t.call.fn], ...encodeArgs(t)]);
    const mine = E.keccak256(t.data);
    if (lc(r.calldata) !== lc(t.data) || lc(r.keccak256) !== lc(mine)) { encBad++; encBadList.push(`${t.idx} ${t.label}`); }
    t.keccak256 = mine; t.selector = r.selector;
  }
  say(`A. helper encode vs ethers: ${txs.length - encBad} of ${txs.length} calldatas identical (bytes and keccak256)`);
  if (encBad) throw gsafety('hash-mismatch', `the helper's encoding differs from the built calldata on ${encBad} transaction(s): ${clip(encBadList.join('; '), 400)}`);

  // ---------- B. signer-input files + the signer's policy-only check ----------
  const refusals = [];
  for (const { t } of txs) {
    const name = `g-tx/tx-${String(t.idx).padStart(3, '0')}.json`;
    t.file = ctx.rel(name);
    ctx.writeRun(name, JSON.stringify({ calls: [{ to: t.to, data: t.data, value: '0' }], gasLimit: String(t.gas_limit) }));
    const r = await ctx.signer('check', t.file);
    const j = r.last;
    if (!(r.exit === 0 && j && j.allowed === true)) refusals.push({ idx: t.idx, label: t.label, exit: r.exit, answer: j ? clip(JSON.stringify(j), 300) : clip(r.stdout || r.stderr, 300) });
  }
  say(`B. signer check (policy only, nothing signed) on each of the ${txs.length} signer-input files: allowed ${txs.length - refusals.length}, refused or error ${refusals.length}`);
  if (refusals.length) {
    const f = refusals[0];
    throw gstop('allowlist-refused', `the signer's check refused or failed on ${refusals.length} transaction(s); first: tx ${f.idx} "${f.label}" (exit ${f.exit}): ${f.answer}`, { refusals: refusals.slice(0, 10) });
  }

  // ---------- C. predicted vs simulated end state, window by window ----------
  const { exp, names, effects } = predictEffects(S, built);
  const mk = new Map(built.tm.map((m) => [m.addr, m]));
  const tokensOf = (m) => {
    const all = [m.repo, m.up, m.down, m.inv];
    if (m.dirRoute === 'dual-buy' && !m.set) return [m.repo, m.up, m.down];
    if (m.set) return all;
    if (m.dirRoute === 'simple-buy') return [m.repo, m.s === 'UP' ? m.up : m.down];
    return all; // complex-buy: repo, own, other, child Invalid
  };
  const okRows = []; const badRows = []; let requests = 0;
  for (let w = 0; w < built.sim.windows.length; w++) {
    const win = built.sim.windows[w];
    const probe = [];
    if (w === 0) for (const n of ['sUSDS', 'bundleA', 'bundleB', 'bundleC', 'parentInvalid', 'middleInvalidA', 'middleInvalidB', 'middleInvalidC']) { const tok = [...names.entries()].find(([, v]) => v === n)[0]; probe.push({ name: n, tok, want: exp.get(tok) }); }
    const seenM = new Set();
    for (const gi of win.groupIdx) {
      const m = mk.get(lc(built.groups[gi].address)); if (!m || seenM.has(m.addr)) continue; seenM.add(m.addr);
      for (const tk of tokensOf(m)) probe.push({ name: names.get(lc(tk)), tok: lc(tk), want: exp.get(lc(tk)) });
    }
    const base = G.simGroups(win.groupIdx.map((gi) => built.groups[gi]));
    for (let i = 0; i < probe.length; i += G.PROBE_CALLS) {
      const part = probe.slice(i, i + G.PROBE_CALLS);
      const name = `g-tmp/state-${w + 1}-${i / G.PROBE_CALLS + 1}.json`;
      let r;
      try { r = await io.simulate(name, base.concat([{ calls: part.map((p) => ({ to: p.tok, data: Bd.balanceOfData(), value: '0', return: true })) }])); } finally { try { ctx.removeRun(name); } catch (e) { /* scratch */ } }
      requests++;
      if (r.all_success !== true || r.clamped_count !== 0 || r.overrides_active) {
        // a failing group of the window (not the probe group itself) is a failing pre-send simulation (G section 8)
        const local = r.first_failed_group; const gi = Number.isInteger(local) && local < win.groupIdx.length ? win.groupIdx[local] : null;
        throw gstop('simulation-failed', `the end-state probe of ${win.file} did not simulate cleanly: ${clip(JSON.stringify({ ...r, calls: undefined, returns: undefined }), 400)}: the plan is stale`, { stale_simulation: r.all_success !== true && gi !== null, first_failed_group: gi, first_failed_group_id: gi === null ? null : built.groups[gi].id });
      }
      if (!Array.isArray(r.returns) || r.returns.length !== part.length) throw gstop('simulate-shape', `end-state probe returned ${r.returns && r.returns.length} values for ${part.length} reads`);
      part.forEach((p, k) => { const got = BigInt(r.returns[k].return_data); (got === p.want ? okRows : badRows).push({ name: p.name, got, want: p.want }); });
    }
  }
  const probes = okRows.length + badRows.length;
  say(`C. end-state probe: the simulated end state equals the prediction on ${okRows.length} of ${probes} balances (${requests} simulate request(s))`);
  for (const b of badRows.slice(0, 20)) say(`   DIFFERS ${b.name}: simulated ${b.got}, predicted ${b.want}, difference ${b.got - b.want}`);
  const endState = Object.fromEntries([...exp.entries()].filter(([k]) => names.has(k)).map(([k, v]) => [names.get(k), v]));
  return { txs: txs.map(({ t }) => ({ i: t.idx, keccak256: t.keccak256, file: t.file })), mismatches: badRows, probes, matched: okRows.length, requests, effects, endState };
}

module.exports = { verify, predictEffects, encodeArgs };
