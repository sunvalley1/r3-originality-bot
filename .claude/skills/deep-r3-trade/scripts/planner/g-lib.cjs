// planner/g-lib.cjs - step G's shared library (ported from the live G scripts that built the first live run's plan).
//
// - The addresses G sends to, all from the embedded C-select table (table.cjs); nothing is typed twice.
// - The one Float-to-wei rule of G section 1 and the count rule (stake / quoted_fill, divided in decimal, then truncated).
// - The call builders (approve, Router.splitPosition, SwapRouter02 exactInputSingle / exactOutputSingle) with ethers
//   encoding only: no Wallet, no provider, no signing.
// - The I/O layer: every chain read is a chain-helper `multicall` over a reads file under ./run/<run-id>/g-tmp/ (removed
//   once answered) or another helper subcommand, through the planner's sequential runner (lib.runHelper: `rpcGapMs`
//   spacing, a rate-limit reply treated as transient). Every multicall reports the block it was read at, so a reader
//   can pin a set of reads to one block; no step compares the blocks of two reads (G section 8, The head moves).
// - The simulate runner: the whole ordered sequence in ONE eth_simulateV1 request, or, when the request is over the
//   helper's caps or the node refuses it (-38026 too many blocks, -38013 the request gas budget), in windows cut only
//   between markets, each beginning with the mint prefix (G section 8, Money rules).
'use strict';

const lib = require('./lib.cjs');
const TB = require('./table.cjs');
const FL = require('./f-lib.cjs');

const { Stop, ToolFailure, EXIT, clip } = lib;

const lc = (s) => String(s).toLowerCase();
const A = Object.freeze({
  sUSDS: lc(TB.ADDR.sUSDS), USDS: TB.ADDR.USDS, USDC: TB.ADDR.USDC, WETH: TB.ADDR.WETH, PSM3: TB.ADDR.PSM3,
  ROUTER: TB.ADDR.ROUTER, CTF: TB.ADDR.CTF, REALITY: TB.ADDR.REALITY, SWAP: TB.ADDR.SWAP, QUOTER: TB.ADDR.QUOTER,
  FACTORY: TB.ADDR.FACTORY, MC3: TB.ADDR.MC3, PARENT: lc(TB.ADDR.PARENT), PARENT_INVALID: TB.ADDR.PARENT_INVALID,
  GPO: FL.A.GPO, WETH_USDC_500: FL.A.WETH_USDC_500,
});
const BUNDLES = Object.freeze(Object.fromEntries(TB.T.bundles.map((b) => [b.name, b.bundleToken])));
const MIDDLES = Object.freeze(Object.fromEntries(TB.T.bundles.map((b) => [b.name, lc(b.middle)])));
const MID_INV = Object.freeze(Object.fromEntries(TB.T.bundles.map((b) => [b.name, b.middleInvalid])));
const BUNDLE_N = Object.freeze(Object.fromEntries(TB.T.bundles.map((b) => [b.name, b.nRepos])));
const XS = Object.freeze(TB.T.bundles.map((b) => b.name)); // ['A', 'B', 'C']

const VOLUME_MIN = 0.01; // G section 3
const RESERVE_WEI = 2000000000000000n; // G section 8 Affordability: the 0.002 ETH reserve
const CAP_GAS = 16777216; // 2^24
const MAX_ENTRIES = 256; // eth_simulateV1 blockStateCalls entries per request (G section 8)
const MAX_CALLS = 500; // the chain helper's calls per simulate file
const PROBE_CALLS = 20; // the chain helper's limit of calls flagged "return" per simulate request
const G_RETRIES = 9; // transient re-runs of a read (the live G's 10 attempts in all)

const N = 98;

// ---------------- errors ----------------
// A stop G defines (stale plan, refusal): exit 3. A safety refusal (nonce moved, pending transaction, hash mismatch): exit 4.
const gstop = (cause, notes, fields = {}) => new Stop({ step: 'G', cause, status: 'aborted', notes: `G stop (no plan written): ${notes}`, fields });
const gsafety = (cause, notes, fields = {}) => new Stop({ step: 'G', cause, status: 'aborted', notes: `G safety refusal (no plan written): ${notes}`, fields, exit: EXIT.SAFETY });

// ---------------- Float to wei (G section 1) ----------------
// Truncate the decimal string to 18 places; exponent notation is expanded first (a float below 1e-6 prints as 1e-7).
function decStr(x) {
  if (typeof x !== 'number' && typeof x !== 'string') throw gstop('malformed-input', `amount ${clip(JSON.stringify(x), 40)} is not a number`);
  let s = String(x);
  if (/e/i.test(s)) s = Number(x).toFixed(30);
  if (s.startsWith('-') || !/^[0-9]+(\.[0-9]+)?$/.test(s)) throw gstop('malformed-input', `amount ${clip(s, 40)} is negative or not a decimal`);
  return s;
}
const toWei = (x) => { const [i, f = ''] = decStr(x).split('.'); return BigInt(i + (f + '0'.repeat(18)).slice(0, 18)); };
// count = stake / quoted_fill: divide in decimal, then truncate to 18 places (exact BigInt long division, never float division)
function countWei(stake, fill) {
  const sw = toWei(stake); const [fi, ff = ''] = decStr(fill).split('.'); const F = BigInt(fi + ff);
  if (F === 0n) throw gstop('malformed-input', 'a quoted_fill of 0');
  return sw * (10n ** BigInt(ff.length)) / F;
}
const ceilDiv = (a, b) => (a + b - 1n) / b;
const weiStr = FL.weiStr;
const big = (x) => BigInt(x);
const minB = (a, b) => (a < b ? a : b);

// ---------------- ABI (encode / decode only) ----------------
let IFS = null;
function ifaces(E) {
  if (IFS) return IFS;
  IFS = {
    erc20: new E.Interface(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']),
    router: new E.Interface(['function splitPosition(address collateralToken, address market, uint256 amount)', 'function mergePositions(address collateralToken, address market, uint256 amount)']),
    swap: new E.Interface([
      'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
      'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)']),
    quoter: new E.Interface([
      'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
      'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']),
    mc3: new E.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']),
    pool: new E.Interface(['function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 a,uint16 b,uint16 c,uint8 d,bool e)', 'function liquidity() view returns (uint128)']),
    market: new E.Interface(['function wrappedOutcome(uint256) view returns (address,bytes)', 'function conditionId() view returns (bytes32)']),
  };
  return IFS;
}

// The helper `encode` signatures of the call kinds G builds (G verify compares the helper's bytes with ethers').
const SIG = Object.freeze({
  approve: 'approve(address,uint256)',
  splitPosition: 'splitPosition(address,address,uint256)',
  mergePositions: 'mergePositions(address,address,uint256)',
  exactInputSingle: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
  exactOutputSingle: 'exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))',
});

// The call builders. Each transaction is {to, data, label, call: {fn, args}, swap?}. The label prefixes are an interface:
// the executor finds a complex-buy's sale by label.startsWith('sell x').
function builders(E, holder) {
  const I = ifaces(E);
  const T = (to, data, label, extra) => Object.assign({ to, data, label }, extra || {});
  return {
    approve: (token, spender, amt, label) => T(token, I.erc20.encodeFunctionData('approve', [spender, amt]), label, { call: { fn: 'approve', args: [spender, amt] } }),
    split: (market, amt, label) => T(A.ROUTER, I.router.encodeFunctionData('splitPosition', [A.sUSDS, market, amt]), label, { call: { fn: 'splitPosition', args: [A.sUSDS, market, amt] } }),
    merge: (market, amt, label) => T(A.ROUTER, I.router.encodeFunctionData('mergePositions', [A.sUSDS, market, amt]), label, { call: { fn: 'mergePositions', args: [A.sUSDS, market, amt] } }),
    exIn: (tIn, tOut, fee, amountIn, min, quoted, label) => T(A.SWAP, I.swap.encodeFunctionData('exactInputSingle', [{ tokenIn: tIn, tokenOut: tOut, fee, recipient: holder, amountIn, amountOutMinimum: min, sqrtPriceLimitX96: 0 }]), label,
      { call: { fn: 'exactInputSingle', args: [tIn, tOut, fee, holder, amountIn, min, 0] }, swap: { kind: 'exactInputSingle', tokenIn: tIn, tokenOut: tOut, fee, amountIn, amountOutMinimum: min, quoted_amountOut: quoted } }),
    exOut: (tIn, tOut, fee, out, inMax, quoted, label) => T(A.SWAP, I.swap.encodeFunctionData('exactOutputSingle', [{ tokenIn: tIn, tokenOut: tOut, fee, recipient: holder, amountOut: out, amountInMaximum: inMax, sqrtPriceLimitX96: 0 }]), label,
      { call: { fn: 'exactOutputSingle', args: [tIn, tOut, fee, holder, out, inMax, 0] }, swap: { kind: 'exactOutputSingle', tokenIn: tIn, tokenOut: tOut, fee, amountOut: out, amountInMaximum: inMax, quoted_amountIn: quoted } }),
    qIn: (tIn, tOut, fee, amt) => I.quoter.encodeFunctionData('quoteExactInputSingle', [{ tokenIn: tIn, tokenOut: tOut, amountIn: amt, fee, sqrtPriceLimitX96: 0 }]),
    qOut: (tIn, tOut, fee, amt) => I.quoter.encodeFunctionData('quoteExactOutputSingle', [{ tokenIn: tIn, tokenOut: tOut, amount: amt, fee, sqrtPriceLimitX96: 0 }]),
    balanceOfData: () => I.erc20.encodeFunctionData('balanceOf', [holder]),
  };
}

// ---------------- the I/O layer ----------------
function makeIO(ctx) {
  let seq = 0; let calls = 0;
  const stats = { quotes: 0, quoteBatches: 0, revertSplits: 0, singleReverts: 0, simulates: 0 };
  const isRevert = (e) => e instanceof ToolFailure && (e.code === 'call_reverted' || e.helperExit === 8);
  async function H(args, o = {}) { calls++; return (await ctx.helper(args, { retries: G_RETRIES, ...o })).json; }
  async function mcb(reads) {
    const name = `g-tmp/m-${++seq}.json`;
    calls++;
    try {
      const r = await ctx.multicall(name, reads, { retries: G_RETRIES });
      return { block: r.block, results: r.results };
    } finally { try { ctx.removeRun(name); } catch (e) { /* scratch file; a failed removal is harmless */ } }
  }
  async function mc(reads) { return (await mcb(reads)).results; }
  // Chunked: [{block, results}] per chunk is kept in blocksOut when given.
  async function mcChunked(reads, chunk, blocksOut) {
    const out = [];
    for (let i = 0; i < reads.length; i += chunk) {
      const r = await mcb(reads.slice(i, i + chunk));
      if (blocksOut) blocksOut.push({ from: i, n: Math.min(chunk, reads.length - i), block: r.block });
      out.push(...r.results);
    }
    return out;
  }
  // reqs: [{kind:'in'|'out', tokenIn, tokenOut, amt(BigInt), fee}] -> [{ok, amt, sqrtAfter, ticks, block}]. The helper's multicall
  // is allowFailure:false, so a batch with one infeasible exact-output size fails whole: split it, down to single calls.
  async function quotes(reqs) {
    const out = new Array(reqs.length);
    async function go(idx) {
      if (!idx.length) return;
      try {
        const r = await mcb(idx.map((k) => FL.quoteCall(reqs[k])));
        stats.quoteBatches++; idx.forEach((k, n) => { out[k] = { ...FL.parseQ(r.results[n]), block: r.block }; stats.quotes++; });
      } catch (e) {
        if (!isRevert(e)) throw e;
        if (idx.length === 1) { out[idx[0]] = { ok: false, reverted: true }; stats.singleReverts++; return; }
        stats.revertSplits++; const h = idx.length >> 1; await go(idx.slice(0, h)); await go(idx.slice(h));
      }
    }
    const all = reqs.map((_, k) => k);
    for (let i = 0; i < all.length; i += FL.QUOTE_CHUNK) await go(all.slice(i, i + FL.QUOTE_CHUNK));
    return out;
  }
  // One simulate request over a groups file this step writes (run/<run-id>/<name>). Returns the helper's page.
  async function simulate(name, groups) {
    ctx.writeRun(name, JSON.stringify(groups));
    stats.simulates++;
    return H(['simulate', ctx.rel(name)]);
  }
  return { H, mcb, mc, mcChunked, quotes, simulate, stats, isRevert, getCalls: () => calls };
}

// The groups-file form of a list of plan groups: {calls: [{to, data, value[, return]}]}.
const simGroups = (groups) => groups.map((g) => ({ calls: g.txs.map((t) => { const c = { to: t.to, data: t.data, value: '0' }; if (t.ret) c.return = true; return c; }) }));

// ---------------- the whole-sequence simulation, windowed when it must be ----------------
// groups: the plan's groups in send order; nMint: how many of them (at the head) are the mint prefix. Returns
// { windows: [{file, groupIdx: [...], entries, count, page}], rows: per transaction [index, group, status, gasUsed, maxUsedGas,
// gas_limit] in plan order, windowed }. A node refusal of the request size (-38026, -38013) halves the windows and retries;
// -38015 (one entry over the block gas limit) and every other failure propagate.
async function simulatePlan(ctx, io, groups, nMint, namePrefix = 'g-sim') {
  const mint = groups.slice(0, nMint); const trade = groups.slice(nMint);
  // market blocks: consecutive trade groups of one market (a market's set group and its UP/DOWN rows stay together)
  const blocks = [];
  trade.forEach((g, k) => { const gi = nMint + k; const last = blocks[blocks.length - 1]; if (last && last.address === g.address) last.gis.push(gi); else blocks.push({ address: g.address, gis: [gi] }); });
  const txCount = (gis) => gis.reduce((s, gi) => s + groups[gi].txs.length, 0);
  const mintTx = txCount(mint.map((_, k) => k));
  // room is kept for verify's end-state probe, which re-runs a window plus one group of PROBE_CALLS flagged reads
  const fits = (gis) => nMint + gis.length <= MAX_ENTRIES - 1 && mintTx + txCount(gis) <= MAX_CALLS - PROBE_CALLS;
  // cut the market blocks into n contiguous windows of about equal transaction counts, each within the caps
  function cut(n) {
    const total = blocks.reduce((s, b) => s + txCount(b.gis), 0); const target = total / n;
    const out = []; let cur = []; let curTx = 0;
    for (const b of blocks) {
      const bt = txCount(b.gis);
      if (cur.length && (curTx + bt > target * 1.0001 || !fits([...cur, ...b.gis])) && out.length < n - 1) { out.push(cur); cur = []; curTx = 0; }
      if (!fits([...cur, ...b.gis])) { if (!cur.length) return null; out.push(cur); cur = []; curTx = 0; }
      cur.push(...b.gis); curTx += bt;
    }
    if (cur.length || !out.length) out.push(cur);
    return out.every((w) => fits(w)) ? out : null;
  }
  let n = fits(trade.map((_, k) => nMint + k)) ? 1 : 2;
  for (;;) {
    let wins = cut(n);
    while (!wins && n < Math.max(1, blocks.length)) { n++; wins = cut(n); }
    if (!wins) throw gstop('plan-too-large', `one market's groups plus the mint prefix exceed the simulate caps (${MAX_ENTRIES} entries, ${MAX_CALLS} calls)`);
    const results = [];
    let refused = null;
    for (let w = 0; w < wins.length; w++) {
      const gis = [...mint.map((_, k) => k), ...wins[w]];
      const name = wins.length === 1 ? `${namePrefix}-main.json` : `${namePrefix}-w${w + 1}-of-${wins.length}.json`;
      try {
        const page = await io.simulate(name, simGroups(gis.map((gi) => groups[gi])));
        results.push({ file: ctx.rel(name), name, groupIdx: gis, entries: page.entries, count: page.count, page });
      } catch (e) {
        const rc = e instanceof ToolFailure && e.code === 'simulate_failed' && e.json ? Number(e.json.rpc_code) : null;
        if (rc === -38026 || rc === -38013) { refused = { rc, file: ctx.rel(name), text: clip(e.text, 200) }; break; }
        throw e;
      }
    }
    if (refused) {
      ctx.log(`simulate: the node refused ${refused.file} (${refused.rc}: ${refused.text}); ${wins.length} window(s) -> ${wins.length * 2}`);
      for (const r of results) { try { ctx.removeRun(r.name); } catch (e) { /* ignore */ } }
      if (wins.length >= blocks.length) throw gstop('simulate-refused', `the node refused a window holding a single market (${refused.rc}: ${refused.text}); pin another RPC in the chain helper's config`);
      n = Math.min(blocks.length, wins.length * 2);
      continue;
    }
    // per-transaction rows in plan order: the mint rows from the first window, each trade group's rows from its window
    const rows = new Array(groups.reduce((s, g) => s + g.txs.length, 0)).fill(null);
    const start = []; let acc = 0; groups.forEach((g, gi) => { start[gi] = acc; acc += g.txs.length; });
    results.forEach((r, w) => {
      let k = 0;
      r.groupIdx.forEach((gi, local) => {
        groups[gi].txs.forEach((t, ti) => {
          const row = r.page.calls && r.page.calls[k];
          if (!row || row[0] !== k || row[1] !== local) throw gstop('simulate-shape', `${r.file}: row ${k} is ${clip(JSON.stringify(row), 80)}`);
          if (gi >= nMint || w === 0) rows[start[gi] + ti] = row;
          k++;
        });
      });
    });
    return { windows: results, rows, windowed: results.length > 1 };
  }
}

// The acceptance of one simulate page (G section 8, Money rules): every status 0x1, nothing clamped or over the cap, no
// overrides, the page's counts equal to the file's, the pending nonce the plan's.
function pageProblems(page, { entries, count, pendingNonce }) {
  const p = [];
  if (page.all_success !== true) p.push(`all_success ${page.all_success} (failed_count ${page.failed_count}, first failed index ${page.first_failed_index}: ${clip(JSON.stringify(page.failures || []), 300)})`);
  if (page.clamped_count !== 0) p.push(`clamped_count ${page.clamped_count}`);
  if (page.over_cap_count !== 0) p.push(`over_cap_count ${page.over_cap_count}`);
  if (page.overrides_active) p.push('simulation overrides are active in the helper config');
  if (entries !== undefined && page.entries !== entries) p.push(`entries ${page.entries} != ${entries}`);
  if (count !== undefined && page.count !== count) p.push(`count ${page.count} != ${count}`);
  if (pendingNonce !== undefined && page.pending_nonce !== pendingNonce) p.push(`pending_nonce ${page.pending_nonce} != the plan's ${pendingNonce}`);
  return p;
}

// The holder's nonce must be what the plan was built on: latest == pending == the plan's pending nonce (G section 8).
async function checkNonce(io, holder, want, where) {
  const n = await io.H(['nonce', holder]);
  if (n.latest !== n.pending) throw gsafety('pending-transaction', `${where}: a transaction of the holder is pending (latest ${n.latest}, pending ${n.pending}): settle it before building a plan`, { nonce: n });
  if (want !== undefined && want !== null && n.pending !== want) throw gsafety('nonce-moved', `${where}: the holder nonce moved since the plan's read (${want} -> ${n.pending}): a send happened outside this plan`, { nonce: n });
  return n;
}

// Spot price (repo tokens per outcome token) from a pool sqrtPriceX96, token order corrected (F step 1).
const spotOf = (sqrt, T0) => FL.priceOf(BigInt(sqrt), T0);

module.exports = {
  lc, A, BUNDLES, MIDDLES, MID_INV, BUNDLE_N, XS, N, VOLUME_MIN, RESERVE_WEI, CAP_GAS, MAX_ENTRIES, MAX_CALLS, PROBE_CALLS, G_RETRIES,
  gstop, gsafety, decStr, toWei, countWei, ceilDiv, weiStr, big, minB,
  ifaces, SIG, builders, makeIO, simGroups, simulatePlan, pageProblems, checkNonce, spotOf,
};
