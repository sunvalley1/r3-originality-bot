#!/usr/bin/env node
'use strict';
/*
 * planner.test.cjs - tests for planner.cjs and planner/*.cjs. Run it from the skill's scripts/ folder:
 *
 *   node planner.test.cjs [--dir <work dir>] [--only <section,...>]
 *   node planner.test.cjs --live --helper <chain-helper.cjs> --signer <signer.cjs> --bin <dir> --project <dir>
 *                         [--csv-store <dir>] [--ethers-from <node_modules dir>] [--run-id <id>] [--gap-ms <n>]
 *                         [--skip-offline] [--dir <work dir>]
 *
 * Prints PASS / FAIL / SKIP per case and exits non-zero on any FAIL.
 *
 * OFFLINE (always, unless --skip-offline): no network, no key, nothing signed. The planner is installed as a COPY in a
 * work folder (default: a fresh folder under the OS temp folder; --dir chooses where), outside a scratch project that
 * has a ./run folder, with a planner.config.json naming a MOCK chain helper and a MOCK signer. Both mocks are two-line
 * shims written into the work folder; their logic is in this file (mockHelperMain, mockSignerMain). They answer the
 * shapes and exit codes of chain-helper.README.md and signer.README.md over a synthetic chain built from
 * planner/table.cjs: the 98 real market, repo token, middle and parent addresses; made-up outcome tokens, conditions,
 * questions and pools; single-range Uniswap v3 pools answered with the planner's own exact math (planner/f-lib.cjs); a
 * made-up holder address; and a JSON ledger the mock signer "mines" a transaction into (it holds no key and signs
 * nothing). The prices are set so that F finds every route: a set-sell, a pair (dual-buy), simple buys on both sides, a
 * complex buy, a market whose forecast equals its price (no row) and 92 markets with no forecast.
 * Sections (--only takes any of them): static, usage, lib, repair, pipeline, c-variants, g-safety, exec-safety, boundary,
 * mergearb, wake, ramp, recovery, cap.
 * g-safety and exec-safety run on the plan the pipeline builds, so they run the pipeline first.
 *
 * LIVE (read-only smoke, only with --live): installs a copy of the planner in --bin (outside --project) with a
 * planner.config.json naming the operator's installed chain helper and signer, copies `ethers` next to it from
 * --ethers-from (default: the node_modules folder next to the helper), copies a CSV store into --project/run/csv when
 * --csv-store is given, then runs `c`, `d` (the stored CSV), `e` and `f` on a fresh run-id. Those four steps never run
 * the signer (asserted); every chain read goes through the helper, which contacts only its pinned RPC and data function.
 * Nothing is signed or sent. F on Optimism mainnet takes several minutes.
 *
 * Needs Node 22 and `ethers` 6.17.0 resolvable from this folder (NODE_PATH, or an `npm install ethers@6.17.0` in a parent
 * folder); the installed copies get it through NODE_PATH (offline) or next to themselves (live). Reads no other
 * environment variable.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const SCRIPTS = __dirname;
const SKILL_DIR = path.resolve(SCRIPTS, '..');
const PLANNER_SRC = path.join(SCRIPTS, 'planner.cjs');
const PLANNER_DIR = path.join(SCRIPTS, 'planner');
const TEST_FILE = __filename;

let E_ = null; const ethers = () => E_ || (E_ = require('ethers'));
let TB_ = null; const tb = () => TB_ || (TB_ = require(path.join(PLANNER_DIR, 'table.cjs')));
let FL_ = null; const fl = () => FL_ || (FL_ = require(path.join(PLANNER_DIR, 'f-lib.cjs')));

const lc = (s) => String(s).toLowerCase();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fakeAddr = (tag) => '0x' + sha('planner-test:' + tag).slice(0, 40);
const fakeB32 = (tag) => '0x' + sha('planner-test:' + tag);
const HOLDER = fakeAddr('holder'); // a made-up address: no key exists for it anywhere
const ZERO_ADDR = '0x' + '0'.repeat(40);
const ZERO32 = '0x' + '0'.repeat(64);
const Q96 = 2 ** 96;
const MAX_UINT = (1n << 256n) - 1n;
const CAP_GAS = 16777216;

// =================================================================================================================
// THE MOCK CHAIN (runs inside the mock helper and mock signer processes; nothing here touches a network)
// =================================================================================================================

class MockOut { constructor(obj, code = 0) { this.obj = obj; this.code = code; } }
const mockFail = (code, error, exit, extra = {}) => { throw new MockOut({ error, code, ...extra }, exit); };

// ---- the static part of the world: addresses and pool ranges, derived from table.cjs ----
let SW_ = null;
function sw() {
  if (SW_) return SW_;
  const TB = tb(); const FL = fl(); const A0 = TB.ADDR;
  const tickOfPrice = (p) => Math.floor(Math.log(p) / Math.log(1.0001));
  const A = {
    sUSDS: lc(A0.sUSDS), USDS: lc(A0.USDS), USDC: lc(A0.USDC), WETH: lc(A0.WETH), PSM3: lc(A0.PSM3), ROUTER: lc(A0.ROUTER), CTF: lc(A0.CTF),
    REALITY: lc(A0.REALITY), SWAP: lc(A0.SWAP), QUOTER: lc(A0.QUOTER), FACTORY: lc(A0.FACTORY), MC3: lc(A0.MC3), PARENT: lc(A0.PARENT),
    PINV: lc(A0.PARENT_INVALID), GPO: lc(FL.A.GPO), WETH_USDC_500: lc(FL.A.WETH_USDC_500),
  };
  const kids = TB.T.rows.map((r) => ({
    i: r.i, name: r.repo, addr: r.address, repo: lc(r.repo_token), slot: r.slot, bundle: r.bundle,
    down: fakeAddr('down:' + r.address), up: fakeAddr('up:' + r.address), inv: fakeAddr('inv:' + r.address),
    cond: fakeB32('cond:' + r.address), qid: fakeB32('qid:' + r.address),
  }));
  const pools = new Map(); const byTok = new Map(); const kidByAddr = new Map();
  for (const k of kids) {
    kidByAddr.set(k.addr, k);
    for (const side of ['DOWN', 'UP']) {
      const tok = side === 'UP' ? k.up : k.down;
      const T0 = BigInt(tok) < BigInt(k.repo); // Uniswap sorts the pair by address
      // one liquidity range covering an outcome price of 0.02 to 0.98, in the pool's own token order
      const p = { addr: fakeAddr('pool' + side + ':' + k.addr), i: k.i, side, tok, repo: k.repo, T0, fee: 100, lo: T0 ? tickOfPrice(0.02) : tickOfPrice(1 / 0.98), hi: T0 ? tickOfPrice(0.98) : tickOfPrice(50) };
      k['pool' + side] = p.addr; pools.set(p.addr, p); byTok.set(tok, p);
    }
  }
  const bundles = {};
  for (const b of TB.T.bundles) bundles[b.name] = { name: b.name, idx: b.idx, middle: lc(b.middle), token: lc(b.bundleToken), inv: lc(b.middleInvalid), n: b.nRepos, cond: TB.CONDITIONS[b.name], qids: [fakeB32('midq:' + b.name)], repos: kids.filter((k) => k.bundle === b.name) };
  const middleBy = new Map(Object.values(bundles).map((b) => [b.middle, b]));
  SW_ = { TB, A, kids, kidByAddr, pools, byTok, bundles, middleBy, parentQids: [1, 2, 3].map((n) => fakeB32('parq:' + n)), parentWrapped: TB.PARENT_WRAPPED.map(lc) };
  return SW_;
}

// ---- prices: [UP, DOWN]. Six markets are set so that F finds each route; the other 92 sit inside the fee band ----
const SPECIAL = {
  0: [0.65, 0.52], // sum 1.17: step 3a set-sell (no forecast needed)
  1: [0.40, 0.50], // sum 0.90: step 3b pair, sent as a dual-buy
  2: [0.30, 0.69995], // forecast 0.60: buy UP, sum below 1 -> simple-buy, the bankroll binds
  3: [0.50, 0.49998], // forecast 0.50: no side clears p(1-f) > price -> no row
  40: [0.35, 0.65005], // forecast 0.75: buy UP, sum above 1 -> complex-buy
  70: [0.70, 0.29995], // forecast 0.66: buy DOWN, simple-buy, the book binds before the budget (leftover repo tokens)
};
const FORECAST = { 2: '0.6', 3: '0.5', 40: '0.75', 70: '0.66' };
const BLANK = [4, 41];
const POOL_L = 200n * 10n ** 18n;
function startPrice(i) { if (SPECIAL[i]) return SPECIAL[i]; const u = 0.2 + 0.6 * ((i * 0.6180339887) % 1); return [u, 1 - u - 0.00002]; }
const sqrtFor = (price, T0) => BigInt(Math.floor(Math.sqrt(T0 ? price : 1 / price) * Q96));
const tickOfSqrt = (sq) => Math.floor(2 * Math.log(Number(sq) / Q96) / Math.log(1.0001));

function freshWorld(o = {}) {
  const S = sw(); const pools = {};
  for (const p of S.pools.values()) { const [u, d] = startPrice(p.i); pools[p.addr] = { sqrt: sqrtFor(p.side === 'UP' ? u : d, p.T0).toString(), L: POOL_L.toString() }; }
  return { holder: HOLDER, nonce: 5, pendingTx: null, block: 1000, ts: 1791250000, eth: o.eth || '10000000000000000', gasPrice: '1000000', bal: { [S.A.sUSDS]: o.susds || '10000000000000000000' }, alw: {}, pools, payouts: {}, reality: {}, txs: [], sends: 0 };
}
const pendingOf = (w) => w.nonce + (w.pendingTx ? 1 : 0);

// ---- balances and allowances of the holder ----
const getB = (w, t) => BigInt(w.bal[lc(t)] || '0');
const addB = (w, t, d) => { const v = getB(w, t) + d; if (v < 0n) throw new Error(`balance of ${t} would go negative`); w.bal[lc(t)] = v.toString(); };
const getA = (w, t, s) => BigInt(w.alw[lc(t) + ':' + lc(s)] || '0');
const setA = (w, t, s, v) => { w.alw[lc(t) + ':' + lc(s)] = v.toString(); };
function pull(w, t, sp, amt) {
  if (getA(w, t, sp) < amt) throw new Error(`ERC20: insufficient allowance (${t} -> ${sp}: ${getA(w, t, sp)} < ${amt})`);
  if (getB(w, t) < amt) throw new Error(`ERC20: transfer amount exceeds balance (${t}: ${getB(w, t)} < ${amt})`);
  setA(w, t, sp, getA(w, t, sp) - amt); addB(w, t, -amt);
}

// ---- pools: the exact single-range math of f-lib (the planner's own model, so the quoter and the model agree) ----
const sTick = (t) => Math.pow(1.0001, t / 2);
function poolState(w, p) {
  const d = w.pools[p.addr];
  return { pool: p.addr, tok: p.tok, T0: p.T0, fee: p.fee, L: BigInt(d.L), sqrt: BigInt(d.sqrt), loSqrt: BigInt(Math.floor(sTick(p.lo) * Q96)), hiSqrt: BigInt(Math.floor(sTick(p.hi) * Q96)) };
}
// kind 'in' (exact input) or 'out' (exact output). Returns {amt, sqrtAfter, crossed, pool} | {fixed} | {revert}
function quoteOn(w, kind, tin, tout, amt) {
  const S = sw(); const FL = fl(); tin = lc(tin); tout = lc(tout); const A = BigInt(amt);
  if (tin === S.A.WETH && tout === S.A.USDC) return { fixed: ['2697476888', '79228162514264337593543950336', '0', '90000'] };
  const po = S.byTok.get(tout); const pi = S.byTok.get(tin);
  if (po && po.repo === tin) { // buy the outcome token with the repo token
    const st = poolState(w, po);
    if (kind === 'in') {
      const r = FL.buyExactIn(st, A);
      if (!r || !FL.inRange(st, r.sqrtAfter)) return { amt: 1n, sqrtAfter: st.T0 ? st.hiSqrt : st.loSqrt, crossed: 1, pool: po.addr, partial: true };
      return { amt: r.out, sqrtAfter: r.sqrtAfter, crossed: 0, pool: po.addr };
    }
    const r = FL.buyExactOut(st, A);
    if (!r || !FL.inRange(st, r.sqrtAfter)) return { revert: 'SPL' };
    return { amt: r.amtIn, sqrtAfter: r.sqrtAfter, crossed: 0, pool: po.addr };
  }
  if (pi && pi.repo === tout && kind === 'in') { // sell the outcome token for the repo token
    const st = poolState(w, pi); const r = FL.sellExactIn(st, A);
    if (!r || !FL.inRange(st, r.sqrtAfter)) return { amt: 1n, sqrtAfter: st.T0 ? st.loSqrt : st.hiSqrt, crossed: 1, pool: pi.addr, partial: true };
    return { amt: r.out, sqrtAfter: r.sqrtAfter, crossed: 0, pool: pi.addr };
  }
  return { revert: `no pool for ${tin} -> ${tout}` };
}

// ---- markets: their outcome tokens in index order, their collateral and their condition ----
function outcomesOf(m) {
  const S = sw(); m = lc(m);
  if (m === S.A.PARENT) return { level: 'parent', col: S.A.sUSDS, toks: [...['A', 'B', 'C'].map((x) => S.bundles[x].token), S.A.PINV], cond: lc(S.TB.CONDITIONS.parent) };
  const b = S.middleBy.get(m); if (b) return { level: 'middle', col: b.token, toks: [...b.repos.map((k) => k.repo), b.inv], cond: lc(b.cond) };
  const k = S.kidByAddr.get(m); if (k) return { level: 'child', col: k.repo, toks: [k.down, k.up, k.inv], cond: lc(k.cond) };
  return null;
}

// ---- gas: [gasUsed, maxUsedGas]. Approvals and swaps are refund-free (peak = gasUsed); a Router split hits the refund
// cap (peak ~1.25 x gasUsed), values measured live 2026-10-05 (chain-helper.README.md, simulate) ----
const GAS = { psm: [150000, 160000], approve: [46000, 46000], splitParent: [607250, 759062], splitMiddle: [4509738, 5637172], splitChild: [590127, 737658], merge: [420000, 525000], redeem: [300000, 330000], swapIn: [120310, 128710], swapOut: [125000, 134000], quote: [90000, 95000], read: [2600, 2600], failed: [30000, 30000] };
// PSM3: USD per sUSDS x 1e18 (previewSwapExactIn(sUSDS, USDS, 1e18) answers exactly this, as before), and its sUSDS
// inventory (the capacity gate reads sUSDS.balanceOf(PSM3)); USDC has 6 decimals
const PSM3_RATE = 1111831213164571392n; const PSM3_CAP = '1000000000000000000000000';
function psmQuote(tin, tout, amt) {
  const S = sw(); tin = lc(tin); tout = lc(tout);
  if (tin === S.A.sUSDS && tout === S.A.USDS) return amt * PSM3_RATE / 10n ** 18n;
  if (tin === S.A.USDS && tout === S.A.sUSDS) return amt * 10n ** 18n / PSM3_RATE;
  if (tin === S.A.USDC && tout === S.A.sUSDS) return amt * 10n ** 30n / PSM3_RATE;
  return null;
}
const limitOf = (gas, peak) => (peak === null ? Math.min(CAP_GAS, Math.ceil(gas * 1.5)) : Math.min(CAP_GAS, Math.ceil(peak * 1.2)));

let IF_ = null;
function iface() {
  if (IF_) return IF_;
  IF_ = new (ethers().Interface)([
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
    'function splitPosition(address collateralToken, address market, uint256 amount)',
    'function mergePositions(address collateralToken, address market, uint256 amount)',
    'function redeemPositions(address collateralToken, address market, uint256[] outcomeIndexes, uint256[] amounts)',
    'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)',
    'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn)',
    'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
    'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
    'function swapExactIn(address assetIn, address assetOut, uint256 amountIn, uint256 minAmountOut, address receiver, uint256 referralCode) returns (uint256 amountOut)',
  ]);
  return IF_;
}
const keccakHex = (hex) => ethers().keccak256(hex);
const errorData = (msg) => '0x08c379a0' + ethers().AbiCoder.defaultAbiCoder().encode(['string'], [String(msg)]).slice(2);

// Apply one call from the holder to the world (mutates it). Returns {k: gas kind, ret: return data}; throws on a revert.
function applyCall(w, call) {
  const S = sw(); const ab = ethers().AbiCoder.defaultAbiCoder(); const to = lc(call.to);
  if (call.value !== undefined && String(call.value) !== '0') throw new Error('native value is not accepted');
  let p; try { p = iface().parseTransaction({ data: call.data }); } catch (e) { throw new Error('unknown selector ' + String(call.data).slice(0, 10)); }
  if (!p) throw new Error('unknown selector ' + String(call.data).slice(0, 10));
  switch (p.name) {
    case 'approve': setA(w, to, p.args[0], BigInt(p.args[1])); return { k: 'approve', ret: ab.encode(['bool'], [true]) };
    case 'balanceOf': return { k: 'read', ret: ab.encode(['uint256'], [lc(p.args[0]) === w.holder ? getB(w, to) : 0n]) };
    case 'splitPosition': case 'mergePositions': case 'redeemPositions': {
      if (to !== S.A.ROUTER) throw new Error(`${p.name} on a contract that is not the Router`);
      if (lc(p.args[0]) !== S.A.sUSDS) throw new Error('collateral argument is not sUSDS');
      const o = outcomesOf(p.args[1]); if (!o) throw new Error('unknown market');
      if (p.name === 'splitPosition') { const amt = BigInt(p.args[2]); pull(w, o.col, S.A.ROUTER, amt); o.toks.forEach((t) => addB(w, t, amt)); return { k: o.level === 'parent' ? 'splitParent' : o.level === 'middle' ? 'splitMiddle' : 'splitChild', ret: '0x' }; }
      if (p.name === 'mergePositions') { const amt = BigInt(p.args[2]); o.toks.forEach((t) => pull(w, t, S.A.ROUTER, amt)); addB(w, o.col, amt); return { k: 'merge', ret: '0x' }; }
      const pay = w.payouts[o.cond]; if (!pay || BigInt(pay.den) === 0n) throw new Error('result for condition not received yet');
      let got = 0n;
      p.args[2].forEach((ix, n) => { const i = Number(ix); const amt = BigInt(p.args[3][n]); pull(w, o.toks[i], S.A.ROUTER, amt); got += amt * BigInt(pay.nums[i] || '0') / BigInt(pay.den); });
      addB(w, o.col, got); return { k: 'redeem', ret: '0x' };
    }
    case 'exactInputSingle': case 'exactOutputSingle': {
      if (to !== S.A.SWAP) throw new Error('swap on a contract that is not SwapRouter02');
      const a = p.args[0]; if (lc(a.recipient) !== w.holder) throw new Error('recipient is not the holder');
      if (Number(a.fee) !== 100) throw new Error('no pool at that fee tier');
      if (p.name === 'exactInputSingle') {
        const q = quoteOn(w, 'in', a.tokenIn, a.tokenOut, a.amountIn); if (q.revert || q.partial) throw new Error('SPL');
        if (q.amt < BigInt(a.amountOutMinimum)) throw new Error('Too little received');
        pull(w, a.tokenIn, S.A.SWAP, BigInt(a.amountIn)); addB(w, a.tokenOut, q.amt); w.pools[q.pool].sqrt = q.sqrtAfter.toString();
        return { k: 'swapIn', ret: ab.encode(['uint256'], [q.amt]) };
      }
      const q = quoteOn(w, 'out', a.tokenIn, a.tokenOut, a.amountOut); if (q.revert) throw new Error('SPL');
      if (q.amt > BigInt(a.amountInMaximum)) throw new Error('Too much requested');
      pull(w, a.tokenIn, S.A.SWAP, q.amt); addB(w, a.tokenOut, BigInt(a.amountOut)); w.pools[q.pool].sqrt = q.sqrtAfter.toString();
      return { k: 'swapOut', ret: ab.encode(['uint256'], [q.amt]) };
    }
    case 'swapExactIn': {
      if (to !== S.A.PSM3) throw new Error('swapExactIn on a contract that is not PSM3');
      const [ain, aout, amt, minOut, rcv] = p.args;
      if (lc(rcv) !== w.holder) throw new Error('receiver is not the holder');
      const out = psmQuote(ain, aout, BigInt(amt)); if (out === null) throw new Error('PSM3: unsupported pair');
      if (out < BigInt(minOut)) throw new Error('PSM3/amountOut-too-low');
      const cap = BigInt(w.psm3Cap || PSM3_CAP); if (out > cap) throw new Error('PSM3: insufficient sUSDS inventory');
      pull(w, ain, S.A.PSM3, BigInt(amt)); addB(w, aout, out); w.psm3Cap = (cap - out).toString();
      return { k: 'psm', ret: ab.encode(['uint256'], [out]) };
    }
    case 'quoteExactInputSingle': case 'quoteExactOutputSingle': {
      if (to !== S.A.QUOTER) throw new Error('quote on a contract that is not QuoterV2');
      const a = p.args[0]; const q = quoteOn(w, p.name === 'quoteExactInputSingle' ? 'in' : 'out', a[0], a[1], a[2]);
      if (q.revert) throw new Error(q.revert);
      const res = q.fixed ? q.fixed.map(BigInt) : [q.amt, q.sqrtAfter, BigInt(q.crossed), 90000n];
      return { k: 'quote', ret: ab.encode(['uint256', 'uint160', 'uint32', 'uint256'], res) };
    }
    default: throw new Error('unsupported call ' + p.name);
  }
}
const cloneWorld = (w) => JSON.parse(JSON.stringify(w));
function restoreWorld(w, snap) { for (const k of Object.keys(w)) delete w[k]; Object.assign(w, JSON.parse(snap)); }

// One mined transaction from the holder at nonce n (status 0x0 on a revert: the nonce is still used).
function mine(w, call, n) {
  const snap = JSON.stringify(w); let status = '0x1'; let k = 'failed';
  try { k = applyCall(w, call).k; } catch (e) { restoreWorld(w, snap); status = '0x0'; }
  const g = GAS[k] || GAS.read;
  const hash = '0x' + sha(`tx:${n}:${call.data}:${w.sends}`);
  w.block++; w.ts += 2; w.nonce = n + 1; w.sends++;
  w.eth = (BigInt(w.eth) - BigInt(g[0]) * BigInt(w.gasPrice) - 1000n).toString();
  w.txs.push({ hash, nonce: n, from: w.holder, to: lc(call.to), input_keccak256: keccakHex(call.data), input_bytes: (call.data.length - 2) / 2, block: w.block, status, gas_used: String(g[0]), effective_gas_price: w.gasPrice, l1_fee: '1000' });
  return { hash, status, block: w.block, gas: g[0] };
}

// The whole ordered plan in one simulated request (chain-helper.README.md, simulate: the page and its row format).
function simulatePage(w0, groups, sc) {
  const w = cloneWorld(w0); const rows = []; const returns = []; const failures = []; let index = 0;
  groups.forEach((g, gi) => (g.calls || []).forEach((c) => {
    const snap = JSON.stringify(w); let status = '0x1'; let k = 'failed'; let ret = '0x'; let err = null;
    try { const r = applyCall(w, c); k = r.k; ret = r.ret; } catch (e) { restoreWorld(w, snap); status = '0x0'; err = e.message; ret = errorData(err); }
    if (sc.failSelector && String(c.data).startsWith(sc.failSelector) && status === '0x1') { status = '0x0'; err = 'scenario failure'; }
    const g2 = GAS[k] || GAS.read; const peak = sc.noMaxUsedGas ? null : g2[1];
    rows.push([index, gi, status, g2[0], peak, limitOf(g2[0], peak)]);
    if (status !== '0x1' && failures.length < 8) failures.push({ index, group: gi, to: lc(c.to), status, error: 'execution reverted: ' + err, revert_reason: err });
    if (c.return === true) returns.push({ index, group: gi, return_data: ret });
    index++;
  }));
  const failed = rows.filter((r) => r[2] !== '0x1');
  const page = {
    from: w0.holder, input: 'groups', entries: groups.length, count: rows.length, all_success: failed.length === 0, failed_count: failed.length,
    first_failed_index: failed.length ? failed[0][0] : null, first_failed_group: failed.length ? failed[0][1] : null, over_cap_count: 0, first_over_cap_index: null, clamped_count: 0,
    pending_nonce: pendingOf(w0), gas_limit_rule: 'ceil(maxUsedGas x 1.2), clamped at 16777216; ceil(gasUsed x 1.5) for a call the RPC gave no maxUsedGas',
    columns: ['index', 'group', 'status', 'gasUsed', 'maxUsedGas', 'gas_limit'], calls: rows,
  };
  if (failures.length) page.failures = failures;
  if (returns.length) page.returns = returns;
  if (sc.noMaxUsedGas) page.no_max_used_gas_count = rows.length;
  return page;
}

// The data function's body, built from the world (the live body's shape: C-select.md step 1, chain-helper.README.md data)
function buildBody(w) {
  const S = sw(); const FL = fl();
  const poolBody = (p) => {
    const d = w.pools[p.addr]; const sq = BigInt(d.sqrt);
    return { liquidity: String(d.L), tick: String(tickOfSqrt(sq)), token0: p.T0 ? p.tok : p.repo, token1: p.T0 ? p.repo : p.tok, ticks: [{ tickIdx: String(p.hi), liquidityNet: '-' + d.L, __typename: 'Tick' }, { tickIdx: String(p.lo), liquidityNet: String(d.L), __typename: 'Tick' }], feeTier: '100', price: FL.priceOf(sq, p.T0) };
  };
  const marketsData = {}; const markets = [];
  for (const k of S.kids) {
    const up = poolBody(S.pools.get(k.poolUP)); const dn = poolBody(S.pools.get(k.poolDOWN));
    marketsData[k.name] = { id: k.addr, upPrice: up.price, upPool: up, downPrice: dn.price, downPool: dn };
    markets.push({ id: k.addr, wrappedTokens: [k.down, k.up, k.inv], collateralToken: k.repo, parentOutcome: k.slot, marketStatus: 'open' });
  }
  return { marketsData, markets, parentWrappedTokens: [...S.TB.PARENT_WRAPPED], parentMarketStatus: 'open', middleMarkets: ['A', 'B', 'C'].map((x) => ({ id: S.bundles[x].middle, payoutReported: false })) };
}

// ---- the mock's files: world.json (the ledger), scenario.json (knobs a test sets), calls.json (counters a test reads) ----
function mockFiles(dir) {
  const f = (n) => path.join(dir, n);
  const read = (n, d) => { try { return JSON.parse(fs.readFileSync(f(n), 'utf8')); } catch (e) { return d; } };
  const M = { world: read('world.json', null), scen: read('scenario.json', {}), calls: read('calls.json', null) };
  if (!M.calls) M.calls = { helper: {}, signer: {}, mc: 0, nonce: 0, encode: 0, sends: [] };
  M.saveWorld = () => fs.writeFileSync(f('world.json'), JSON.stringify(M.world));
  M.saveScen = () => fs.writeFileSync(f('scenario.json'), JSON.stringify(M.scen));
  M.saveCalls = () => fs.writeFileSync(f('calls.json'), JSON.stringify(M.calls));
  return M;
}
// A file argument the planner passes: run/<run-id>/<file>, relative to the project root (the current folder).
function projFile(rel) {
  if (typeof rel !== 'string' || !/^(\.\/)?run\/[A-Za-z0-9._-]+\/[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(rel) || rel.includes('..')) mockFail('path_outside_run', 'path refused: ' + String(rel).slice(0, 80), 4);
  const p = path.join(process.cwd(), rel);
  if (!fs.existsSync(p)) mockFail('path_not_found', 'path refused: no such file ' + rel, 4);
  return fs.readFileSync(p, 'utf8');
}

// ---- one multicall read ----
function mcRead(w, r, k) {
  const S = sw(); const FL = fl(); const to = lc(r.to); const sig = r.signature; const a = r.args || [];
  const none = () => mockFail('decode_failed', `read ${k} (${sig} on ${r.to}) returned no data`, 1, { index: k });
  const rev = (why) => mockFail('call_reverted', `read ${k} (${sig} on ${r.to}) reverted: ${why}`, 8, { index: k, revert_reason: why });
  const kd = S.kidByAddr.get(to); const md = S.middleBy.get(to); const isParent = to === S.A.PARENT; const pool = S.pools.get(to);
  const rq = (q) => w.reality[lc(q)] || {};
  switch (sig) {
    case 'wrappedOutcome(uint256)(address)': { const n = Number(a[0]); if (kd) return n <= 2 ? [[kd.down, kd.up, kd.inv][n]] : rev('index'); if (md) return n < md.n ? [md.repos[n].repo] : n === md.n ? [md.inv] : rev('index'); if (isParent) return n < 4 ? [S.parentWrapped[n]] : rev('index'); return none(); }
    case 'conditionId()(bytes32)': if (kd) return [kd.cond]; if (md) return [md.cond]; if (isParent) return [S.TB.CONDITIONS.parent]; return none();
    case 'questionsIds()(bytes32[])': if (kd) return [[kd.qid]]; if (md) return [md.qids]; if (isParent) return [S.parentQids]; return none();
    case 'parentMarket()(address)': if (kd) return [S.bundles[kd.bundle].middle]; if (md) return [S.A.PARENT]; return none();
    case 'parentOutcome()(uint256)': if (kd) return [String(kd.slot)]; if (md) return [String(md.idx)]; return none();
    case 'getPool(address,address,uint24)(address)': {
      if (to !== S.A.FACTORY) return none();
      const x = lc(a[0]); const y = lc(a[1]); const fee = Number(a[2]);
      if ([x, y].sort().join() === [S.A.WETH, S.A.USDC].sort().join() && fee === 500) return [S.A.WETH_USDC_500];
      const p = S.byTok.get(x) || S.byTok.get(y);
      return [p && fee === p.fee && [x, y].includes(p.repo) ? p.addr : ZERO_ADDR];
    }
    case 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)': { if (!pool) return none(); const sq = w.pools[to].sqrt; return [sq, String(tickOfSqrt(BigInt(sq))), '0', '1', '1', '0', true]; }
    case 'liquidity()(uint128)': return pool ? [w.pools[to].L] : none();
    case 'token0()(address)': return pool ? [pool.T0 ? pool.tok : pool.repo] : none();
    case 'fee()(uint24)': return pool ? [String(pool.fee)] : none();
    case 'tickSpacing()(int24)': return pool ? ['1'] : none();
    case 'ticks(int24)(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)': {
      if (!pool) return none(); const t = Number(a[0]); const L = w.pools[to].L; const init = t === pool.lo || t === pool.hi;
      return [init ? L : '0', t === pool.lo ? L : t === pool.hi ? '-' + L : '0', '0', '0', '0', '0', '0', init];
    }
    case 'tickBitmap(int16)(uint256)': { if (!pool) return none(); const wd = Number(a[0]); let word = 0n; for (const t of [pool.lo, pool.hi]) if ((t >> 8) === wd) word |= 1n << BigInt(t & 255); return [word.toString()]; }
    case 'balanceOf(address)(uint256)': if (lc(a[0]) === S.A.PSM3 && to === S.A.sUSDS) return [String(w.psm3Cap || PSM3_CAP)]; if (lc(a[0]) !== w.holder) return none(); return [getB(w, to).toString()];
    case 'allowance(address,address)(uint256)': if (lc(a[0]) !== w.holder) return none(); return [getA(w, to, a[1]).toString()];
    case 'decimals()(uint8)': return [to === S.A.USDC ? '6' : '18'];
    case 'getEthBalance(address)(uint256)': if (to !== S.A.MC3) return none(); return [lc(a[0]) === w.holder ? w.eth : '0'];
    case 'getCurrentBlockTimestamp()(uint256)': if (to !== S.A.MC3) return none(); return [String(w.ts)];
    case 'payoutDenominator(bytes32)(uint256)': if (to !== S.A.CTF) return none(); return [(w.payouts[lc(a[0])] || {}).den || '0'];
    case 'payoutNumerators(bytes32,uint256)(uint256)': if (to !== S.A.CTF) return none(); return [((w.payouts[lc(a[0])] || {}).nums || [])[Number(a[1])] || '0'];
    case 'isPendingArbitration(bytes32)(bool)': if (to !== S.A.REALITY) return none(); return [!!rq(a[0]).pending];
    case 'getFinalizeTS(bytes32)(uint32)': if (to !== S.A.REALITY) return none(); return [String(rq(a[0]).finalize || 0)];
    case 'getOpeningTS(bytes32)(uint32)': if (to !== S.A.REALITY) return none(); return [String(rq(a[0]).opening === undefined ? 1790000000 : rq(a[0]).opening)];
    case 'getBestAnswer(bytes32)(bytes32)': if (to !== S.A.REALITY) return none(); return [rq(a[0]).best || ZERO32];
    case 'getBond(bytes32)(uint256)': if (to !== S.A.REALITY) return none(); return [String(rq(a[0]).bond || 0)];
    case FL.SIG_IN: case FL.SIG_OUT: {
      if (to !== S.A.QUOTER) return none();
      const [tin, tout, amt] = a[0]; const q = quoteOn(w, sig === FL.SIG_IN ? 'in' : 'out', tin, tout, amt);
      if (q.revert) return rev(q.revert);
      return q.fixed ? q.fixed : [q.amt.toString(), q.sqrtAfter.toString(), String(q.crossed), '90000'];
    }
    case 'previewSwapExactIn(address,address,uint256)(uint256)': { if (to !== S.A.PSM3) return none(); const q = psmQuote(a[0], a[1], BigInt(a[2])); return q === null ? rev('PSM3: unsupported pair') : [q.toString()]; }
    case 'l1BaseFee()(uint256)': return to === S.A.GPO ? ['148701320'] : none();
    case 'getL1Fee(bytes)(uint256)': return to === S.A.GPO ? ['1000'] : none();
    default: return none();
  }
}

// ---- the mock chain helper: chain-helper.README.md's subcommands, one JSON line, its exit codes ----
function helperDispatch(M, sub, args) {
  const w = M.world; const sc = M.scen; const S = sw();
  const rl = sc.rateLimit;
  if (rl && rl.n > 0 && (rl.subs || ['multicall']).includes(sub)) { rl.n--; M.saveScen(); mockFail('rpc_error', 'RPC error -32016: over rate limit: exceeded its requests per second capacity', 5); }
  switch (sub) {
    case 'chain-id': return { chain_id: 10, expected: 10, ok: true };
    case 'nonce': {
      M.calls.nonce++;
      let latest = w.nonce; let pending = pendingOf(w);
      if (sc.nonceBump && M.calls.nonce > sc.nonceBump.after) { latest++; pending++; }
      return { address: lc(args[0]), latest, pending };
    }
    case 'balance': return { address: lc(args[0]), wei: lc(args[0]) === w.holder ? w.eth : '0', eth: String(Number(w.eth) / 1e18) };
    case 'fee-history': return { oldest_block: w.block - 10, base_fee_per_gas: ['100'], next_base_fee_per_gas: '100', gas_used_ratio: [0.5], reward_percentiles: [25, 50, 75], reward: [['1', '1', '1']], gas_price: w.gasPrice };
    case 'block': {
      const n = args[0] === undefined || args[0] === 'latest' ? w.block : Number(args[0]);
      if (!(n >= 0) || n > w.block) mockFail('block_not_found', 'block not found', 5);
      const o = { number: n, hash: '0x' + sha('block:' + n), parent_hash: '0x' + sha('block:' + (n - 1)), timestamp: w.ts - 2 * (w.block - n), gas_limit: '40000000', gas_used: '1', base_fee_per_gas: '100', tx_count: w.txs.filter((t) => t.block === n).length };
      if (args[1]) { const t = w.txs.filter((x) => x.block === n && lc(x.from) === lc(args[1])); o.address = lc(args[1]); o.txs_from_total = t.length; o.txs_from = t.map((x) => ({ hash: x.hash, nonce: x.nonce, to: x.to, value: '0', input_bytes: x.input_bytes, input_keccak256: x.input_keccak256 })); }
      return o;
    }
    case 'receipt': {
      const t = w.txs.find((x) => x.hash === lc(args[0]));
      if (!t) return { found: false, tx_hash: lc(args[0]) };
      return { found: true, tx_hash: t.hash, status: t.status, success: t.status === '0x1', block_number: t.block, transaction_index: 0, from: t.from, to: t.to, contract_address: null, type: '0x2', gas_used: t.gas_used, effective_gas_price: t.effective_gas_price, l1_fee: t.l1_fee, logs_count: 1 };
    }
    case 'keccak256': {
      const a = String(args[0] || ''); let hex; let source;
      if (a.startsWith('0x')) { hex = a; source = 'hex'; } else { hex = projFile(a).trim(); source = 'file'; }
      if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) mockFail('file_not_hex', 'not an even-length 0x hex string', 2);
      return { keccak256: keccakHex(hex), bytes: (hex.length - 2) / 2, source };
    }
    case 'encode': {
      M.calls.encode++;
      const sig = args[0]; const E = ethers(); const I = new E.Interface(['function ' + sig]); const fr = I.fragments[0];
      const vals = args.slice(1).map((x) => { const t = x.startsWith('@') ? projFile(x.slice(1)).trim() : x; return /^[[{]/.test(t) ? JSON.parse(t) : t; });
      let data = I.encodeFunctionData(fr, vals);
      if (sc.encodeCorrupt && M.calls.encode === sc.encodeCorrupt) data = data.slice(0, -2) + (data.slice(-2) === '00' ? '01' : '00');
      return { signature: sig, selector: data.slice(0, 10), bytes: (data.length - 2) / 2, keccak256: E.keccak256(data), calldata: data };
    }
    case 'multicall': {
      M.calls.mc++;
      if (sc.transportAlways) mockFail('rpc_unreachable', 'RPC unreachable: request timed out after 30000 ms', 5);
      const name = path.basename(String(args[0] || ''));
      if (sc.revertOn && sc.revertOn === name) mockFail('call_reverted', 'execution reverted: Multicall3: call failed (pool over capacity, 429)', 8, { revert_reason: 'Multicall3: call failed' });
      let reads; try { reads = JSON.parse(projFile(args[0])); } catch (e) { if (e instanceof MockOut) throw e; mockFail('bad_argument', 'the reads file is not JSON', 2); }
      if (!Array.isArray(reads) || reads.length < 1 || reads.length > 500) mockFail('bad_argument', 'a reads file holds 1 to 500 reads', 2);
      const results = reads.map((r, k) => mcRead(w, r, k));
      return { block: w.block, count: reads.length, calldata_bytes: 0, results };
    }
    case 'simulate': {
      if (sc.simulateUnsupported) mockFail('simulate_unsupported', 'the endpoint has no eth_simulateV1 (method not found)', 5);
      let groups; try { groups = JSON.parse(projFile(args[0])); } catch (e) { if (e instanceof MockOut) throw e; mockFail('bad_argument', 'the simulate file is not JSON', 2); }
      if (!Array.isArray(groups) || !groups.every((g) => g && Array.isArray(g.calls))) mockFail('bad_argument', 'this mock takes the groups form only', 2);
      // the helper's cap on calls flagged "return" per request (chain-helper.cjs MAX_SIM_RETURNS); the largest count any
      // request carried is kept in flagged-max.json next to the mock, which a test reads at the end of the suite
      const flagged = groups.reduce((s, g) => s + g.calls.filter((c) => c.return === true).length, 0);
      { const fm = path.join(path.dirname(process.argv[1]), 'flagged-max.json'); let mx = 0; try { mx = JSON.parse(fs.readFileSync(fm, 'utf8')).max; } catch (e) { mx = 0; } if (flagged > mx) fs.writeFileSync(fm, JSON.stringify({ max: flagged })); }
      if (flagged > 20) mockFail('bad_argument', 'more than 20 calls flagged return', 2);
      const fs2 = sc.failSimulate;
      if (fs2 && fs2.requests > 0 && groups.some((g) => g.calls.some((c) => String(c.data).startsWith(fs2.selector)))) { fs2.requests--; M.saveScen(); return simulatePage(w, groups, { ...sc, failSelector: fs2.selector }); }
      return simulatePage(w, groups, sc);
    }
    case 'data': {
      const rid = String(args[0] || '');
      if (!/^[A-Za-z0-9._-]+$/.test(rid)) mockFail('bad_run_id', 'bad run-id', 4);
      if (sc.dataUnreachable) mockFail('data_unreachable', 'no HTTP response from the data function: fetch failed', 5);
      if (!fs.existsSync(path.join(process.cwd(), 'run'))) mockFail('run_dir_missing', './run does not exist', 4);
      const dirR = path.join(process.cwd(), 'run', rid); fs.mkdirSync(dirR, { recursive: true });
      const body = buildBody(w);
      if (sc.bodyTransform === 'drop-last-market') body.markets.pop();
      if (sc.bodyTransform === 'wrong-wrapped') body.markets[1].wrappedTokens[1] = '0x000000000000000000000000000000000000dEaD';
      const buf = Buffer.from(sc.bodyText !== undefined ? sc.bodyText : JSON.stringify(body));
      fs.writeFileSync(path.join(dirR, 'r3-data.json'), buf);
      let b = null; let jsonValid = false;
      try { b = JSON.parse(buf.toString('utf8')); jsonValid = !!b && typeof b === 'object' && !Array.isArray(b); } catch (e) { jsonValid = false; }
      const KEYS = ['marketsData', 'markets', 'parentWrappedTokens', 'parentMarketStatus', 'middleMarkets'];
      const RK = ['id', 'wrappedTokens', 'collateralToken', 'parentOutcome', 'marketStatus'];
      const hasErr = jsonValid && Object.prototype.hasOwnProperty.call(b, 'error');
      const shapeOk = jsonValid && KEYS.every((x) => x in b) && Array.isArray(b.markets) && b.markets.every((m) => m && RK.every((x) => x in m));
      const status = sc.dataStatus || 200;
      return { status, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), content_type: 'text/plain;charset=UTF-8', written: true, path: `run/${rid}/r3-data.json`, usable: status === 200 && jsonValid && !hasErr && shapeOk, json_valid: jsonValid, has_error_field: hasErr, shape_ok: shapeOk, markets: jsonValid && Array.isArray(b.markets) ? b.markets.length : null };
    }
    case 'data-rows': {
      const [rid, off, cnt] = args; const MISSING = '<missing>';
      const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : MISSING);
      const pick = (o, k) => (o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : MISSING);
      const poolRow = (p) => (p === MISSING ? MISSING : p === null ? null : [pick(p, 'liquidity'), pick(p, 'tick'), pick(p, 'feeTier'), lower(pick(p, 'token0'))]);
      const file = path.join(process.cwd(), 'run', String(rid), 'r3-data.json');
      if (!fs.existsSync(file)) mockFail('path_not_found', 'path refused: no such file', 4);
      let b; try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { mockFail('data_not_json', 'r3-data.json is not valid JSON', 1); }
      if (!b || !Array.isArray(b.markets)) mockFail('data_shape', 'r3-data.json has no markets array', 1);
      const offset = Number(off); const count = Number(cnt);
      if (!(count >= 1 && count <= 30)) mockFail('bad_argument', 'count is 1 to 30', 2);
      const byId = new Map(); for (const [repo, v] of Object.entries(b.marketsData || {})) if (v && typeof v.id === 'string') byId.set(v.id.toLowerCase(), { repo, v });
      const rows = b.markets.slice(offset, offset + count).map((m, k) => {
        const id = lower(pick(m, 'id')); const mdd = byId.get(id); const wt = pick(m, 'wrappedTokens');
        return [offset + k, mdd ? mdd.repo : MISSING, id, pick(m, 'parentOutcome'), lower(pick(m, 'collateralToken')), pick(m, 'marketStatus'), Array.isArray(wt) ? wt.map(lower) : MISSING,
          mdd ? [pick(mdd.v, 'upPrice'), poolRow(pick(mdd.v, 'upPool'))] : MISSING, mdd ? [pick(mdd.v, 'downPrice'), poolRow(pick(mdd.v, 'downPool'))] : MISSING];
      });
      const pwt = pick(b, 'parentWrappedTokens'); const mm = pick(b, 'middleMarkets');
      return { run_id: rid, offset, count: rows.length, total: b.markets.length, header: { parent_wrapped_tokens: Array.isArray(pwt) ? pwt.map(lower) : MISSING, parent_market_status: pick(b, 'parentMarketStatus'), middle_markets: Array.isArray(mm) ? mm.slice(0, 10).map((m) => [lower(pick(m, 'id')), pick(m, 'payoutReported')]) : MISSING, middle_columns: ['id', 'payoutReported'] }, columns: ['i', 'repo', 'id', 'slot', 'collateral', 'status', 'wrapped[DOWN,UP,Invalid]', 'up[price,pool]', 'down[price,pool]'], pool_columns: ['liquidity', 'tick', 'feeTier', 'token0'], note: 'mock', rows };
    }
    default: return mockFail('unknown_subcommand', 'mock helper: unknown subcommand ' + String(sub).slice(0, 30), 2);
  }
}
function mockHelperMain(dir, argv) {
  const M = mockFiles(dir); const [sub, ...args] = argv; let out; let code = 0;
  M.calls.helper[sub] = (M.calls.helper[sub] || 0) + 1;
  try {
    if (!M.world) mockFail('internal', 'mock world.json is missing', 1);
    out = helperDispatch(M, sub, args);
  } catch (e) {
    if (e instanceof MockOut) { out = e.obj; code = e.code; } else { out = { error: 'mock helper internal: ' + String(e && e.stack ? e.stack : e).slice(0, 1500), code: 'internal' }; code = 1; }
  }
  M.saveCalls();
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exitCode = code;
}

// ---- the mock signer: check (policy only), simulate (one transaction, on a copy), send (mine into the ledger) ----
function scopeRule(inp) {
  const S = sw();
  if (!inp || typeof inp !== 'object' || Array.isArray(inp) || !Array.isArray(inp.calls) || inp.calls.length !== 1) return 'input-shape';
  const c = inp.calls[0];
  if (c.value !== undefined && String(c.value) !== '0') return 'native-value';
  let p = null; try { p = iface().parseTransaction({ data: c.data }); } catch (e) { p = null; }
  if (!p) return 'selector';
  const to = lc(c.to);
  if (p.name === 'approve') { if (![S.A.ROUTER, S.A.SWAP, S.A.PSM3].includes(lc(p.args[0]))) return 'approval-spender'; if (BigInt(p.args[1]) === MAX_UINT) return 'approval-amount'; return null; }
  if (['splitPosition', 'mergePositions', 'redeemPositions'].includes(p.name)) { if (to !== S.A.ROUTER) return 'contract'; if (lc(p.args[0]) !== S.A.sUSDS || !outcomesOf(p.args[1])) return 'router-market'; return null; }
  if (p.name === 'swapExactIn') {
    if (to !== S.A.PSM3) return 'contract';
    if (![S.A.USDC + '|' + S.A.sUSDS, S.A.USDS + '|' + S.A.sUSDS, S.A.sUSDS + '|' + S.A.USDC, S.A.sUSDS + '|' + S.A.USDS].includes(lc(p.args[0]) + '|' + lc(p.args[1]))) return 'psm3-pair';
    if (lc(p.args[4]) !== HOLDER) return 'receiver';
    return null;
  }
  if (['exactInputSingle', 'exactOutputSingle'].includes(p.name)) {
    if (to !== S.A.SWAP) return 'contract';
    const a = p.args[0]; if (lc(a.recipient) !== HOLDER) return 'recipient'; if (Number(a.fee) !== 100) return 'swap-fee-tier';
    const t = [lc(a.tokenIn), lc(a.tokenOut)]; const po = S.byTok.get(t[0]) || S.byTok.get(t[1]);
    if (!po || !t.includes(po.repo)) return 'swap-pair';
    return null;
  }
  return 'selector';
}
function mockSignerMain(dir, argv) {
  const M = mockFiles(dir); const [sub, file, ...rest] = argv; const lines = []; let code = 0;
  const line = (o) => lines.push(JSON.stringify(o));
  try {
    if (!['check', 'simulate', 'send'].includes(sub)) mockFail('supervised-entry-point', `mock signer: ${String(sub).slice(0, 30)} is a supervised entry point, never run by the planner`, 2);
    M.calls.signer[sub] = (M.calls.signer[sub] || 0) + 1;
    let inp; try { inp = JSON.parse(projFile(file)); } catch (e) { if (e instanceof MockOut) throw e; mockFail('bad-input', 'the input file is not JSON', 2); }
    let rule = scopeRule(inp);
    if (!rule && sub === 'check' && M.scen.refuseCheckFile && path.basename(String(file)) === M.scen.refuseCheckFile) rule = 'approval-spender';
    if (rule) throw new MockOut({ refused: 'allowlist', rule, detail: 'mock scope', index: 0, command: sub, signed: false, broadcast: false }, 3);
    // signerRateLimit {n, subs, afterBroadcast}: the public RPC's throttle as the signer reports it (signer.README.md
    // section 5): an RPC error with the node's text in `detail`, no "simulated":true; on a send before signing (lock line,
    // then the error: nothing signed), or with afterBroadcast after a `broadcast` line (never to be re-run)
    const srl = M.scen.signerRateLimit;
    if (sub !== 'check' && srl && srl.n > 0 && (srl.subs || ['simulate', 'send']).includes(sub)) {
      srl.n--; M.saveScen();
      if (sub === 'send') line({ event: 'lock', command: 'send', lock_path: path.join(dir, 'mock-send.lock'), log_path: path.join(dir, 'mock-signer.log.jsonl'), attempt: 'a' + M.calls.signer.send });
      if (sub === 'send' && srl.afterBroadcast) line({ event: 'broadcast', hash: '0x' + 'ab'.repeat(32), nonce: pendingOf(M.world), input_hash: keccakHex(inp.calls[0].data), from: M.world.holder, to: lc(inp.calls[0].to), chain_id: 10, gas_limit: String(inp.gasLimit) });
      throw new MockOut({ error: srl.afterBroadcast ? 'rpc-http' : 'rpc-error', detail: srl.afterBroadcast ? 'HTTP 429 from the pinned RPC' : 'exceeded its requests per second capacity', ...(srl.afterBroadcast ? {} : { rpc_code: -32005 }), command: sub, signed: false, broadcast: false }, 1);
    }
    if (sub === 'check') { line({ allowed: true }); } else {
      const w = M.world; const call = inp.calls[0];
      if (sub === 'simulate') {
        // signerSimError {selector?, afterSends?, error, detail, rpc_code?, n?}: the signer's simulate answers an RPC failure
        // with no "simulated":true (signer.README.md section 5's error shape), once the ledger holds afterSends sends, n
        // times (default every time)
        const sse = M.scen.signerSimError;
        if (sse && (!sse.selector || String(call.data).startsWith(sse.selector)) && (sse.afterSends === undefined || M.world.sends >= sse.afterSends) && (sse.n === undefined || sse.n > 0)) {
          if (sse.n !== undefined) { sse.n--; M.saveScen(); }
          throw new MockOut({ error: sse.error, detail: sse.detail || 'network error or timeout talking to the pinned RPC', ...(sse.rpc_code !== undefined ? { rpc_code: sse.rpc_code } : {}), command: 'simulate', signed: false, broadcast: false }, 1);
        }
        const c = cloneWorld(w); let k = 'failed'; let status = '0x1'; let err = null;
        try { k = applyCall(c, call).k; } catch (e) { status = '0x0'; err = e.message; }
        // signerSimFail {selector, after, times?}: the signer's own simulate fails a call with that selector once `after`
        // passed, `times` times (default every time)
        const ssf = M.scen.signerSimFail;
        if (ssf && status === '0x1' && String(call.data).startsWith(ssf.selector)) { ssf.seen = (ssf.seen || 0) + 1; if (ssf.seen > ssf.after && (ssf.times === undefined || (ssf.failed || 0) < ssf.times)) { ssf.failed = (ssf.failed || 0) + 1; status = '0x0'; err = 'scenario failure'; } M.saveScen(); }
        const g = GAS[k] || GAS.read; const gasUsed = Math.round(g[0] * (M.scen.gasFactor || 1));
        line({ simulated: true, via: 'eth_simulateV1', ok: status === '0x1', broadcast: false, signed: false, from: w.holder, chain_id: 10, nonce: pendingOf(w), results: [{ index: 0, status, gas_used: String(gasUsed), ...(err ? { error: 'execution reverted: ' + err } : {}) }] });
        if (status !== '0x1') code = 1;
      } else {
        const lockPath = path.join(dir, 'mock-send.lock'); const logPath = path.join(dir, 'mock-signer.log.jsonl');
        line({ event: 'lock', command: 'send', lock_path: lockPath, log_path: logPath, attempt: 'a' + M.calls.signer.send });
        const want = rest[0] === '--nonce' ? Number(rest[1]) : pendingOf(w);
        if (want < w.nonce) throw new MockOut({ error: 'nonce-too-low', detail: `nonce ${want} is already used`, command: 'send', signed: false, broadcast: false, nonce: want }, 1);
        if (w.pendingTx) throw new MockOut({ error: 'pending-transaction', detail: 'a transaction of the signer is pending', command: 'send', signed: false, broadcast: false }, 1);
        const inputHash = keccakHex(call.data);
        const m = mine(w, call, want);
        if (M.scen.ethAfterSends && w.sends === M.scen.ethAfterSends.n) w.eth = M.scen.ethAfterSends.eth;
        // onSend {selector, count, pool?: {addr, T0, factor}, arbitration?: qid}: once the count-th send with that selector
        // has landed, a third party moves a pool (its price times factor) or a question goes to arbitration
        const os2 = M.scen.onSend;
        if (os2 && m.status === '0x1' && String(call.data).startsWith(os2.selector)) {
          os2.seen = (os2.seen || 0) + 1; M.saveScen();
          if (os2.seen === os2.count) {
            if (os2.pool) { const d = w.pools[lc(os2.pool.addr)]; const s = Number(BigInt(d.sqrt)); const k = Math.sqrt(os2.pool.factor); d.sqrt = BigInt(Math.floor(os2.pool.T0 ? s * k : s / k)).toString(); }
            if (os2.arbitration) { const q = lc(os2.arbitration); w.reality[q] = { ...(w.reality[q] || {}), pending: true }; }
          }
        }
        M.saveWorld();
        M.calls.sends.push({ nonce: want, to: lc(call.to), selector: String(call.data).slice(0, 10), gas_limit: String(inp.gasLimit), status: m.status });
        fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), event: 'broadcast-intent', hash: m.hash, nonce: want, input_hash: inputHash }) + '\n');
        line({ event: 'broadcast', hash: m.hash, nonce: want, input_hash: inputHash, from: w.holder, to: lc(call.to), chain_id: 10, gas_limit: String(inp.gasLimit), gas_clamped: false, lock_path: lockPath, log_path: logPath });
        line({ event: m.status === '0x1' ? 'confirmed' : 'reverted', hash: m.hash, nonce: want, input_hash: inputHash, from: w.holder, to: lc(call.to), chain_id: 10, block_number: m.block, gas_used: String(m.gas), lock_path: lockPath, lock_released: true });
        code = m.status === '0x1' ? 0 : 6;
      }
    }
  } catch (e) {
    if (e instanceof MockOut) { lines.push(JSON.stringify(e.obj)); code = e.code; } else { lines.push(JSON.stringify({ error: 'mock signer internal: ' + String(e && e.stack ? e.stack : e).slice(0, 1500) })); code = 1; }
  }
  M.saveCalls();
  process.stdout.write(lines.join('\n') + '\n');
  process.exitCode = code;
}

module.exports = { mockHelperMain, mockSignerMain };
if (require.main !== module) return;

// =================================================================================================================
// THE TEST HARNESS
// =================================================================================================================

function argOf(name) { const i = process.argv.indexOf(name); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null; }
const ARGS = {
  dir: argOf('--dir'), only: argOf('--only'), live: process.argv.includes('--live'), skipOffline: process.argv.includes('--skip-offline'),
  helper: argOf('--helper'), signer: argOf('--signer'), bin: argOf('--bin'), project: argOf('--project'), csvStore: argOf('--csv-store'),
  ethersFrom: argOf('--ethers-from'), runId: argOf('--run-id'), gapMs: argOf('--gap-ms'),
};
const SECTIONS = ['static', 'usage', 'lib', 'repair', 'pipeline', 'c-variants', 'g-safety', 'exec-safety', 'boundary', 'mergearb', 'wake', 'ramp', 'recovery', 'cap'];
const ONLY = ARGS.only ? new Set(ARGS.only.split(',').map((s) => s.trim())) : null;
if (ONLY) for (const s of ONLY) if (!SECTIONS.includes(s)) { console.log(`unknown section ${s}; sections: ${SECTIONS.join(', ')}`); process.exit(2); }
const want = (s) => !ONLY || ONLY.has(s);

class Skip extends Error {}
const skip = (why) => { throw new Skip(why); };
const results = { PASS: 0, FAIL: 0, SKIP: 0 }; const failed = [];
async function test(name, fn) {
  try { await fn(); results.PASS++; console.log(`PASS  ${name}`); } catch (e) {
    if (e instanceof Skip) { results.SKIP++; console.log(`SKIP  ${name} -- ${e.message}`); return; }
    results.FAIL++; failed.push(name); console.log(`FAIL  ${name} -- ${String(e && e.message ? e.message : e).slice(0, 1500)}`);
  }
}
function ok(cond, what) { if (!cond) throw new Error(what || 'assertion failed'); }
const clip = (s, n = 600) => { const t = typeof s === 'string' ? s : JSON.stringify(s); return t && t.length > n ? t.slice(0, n) + '...' : t; };
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1) + '\n'); };
const exists = (p) => fs.existsSync(p);
function listTree(dir, base = dir) {
  const out = []; if (!exists(dir)) return out;
  (function walk(p) { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) { out.push(path.relative(base, q).replace(/\\/g, '/') + '/'); walk(q); } else out.push(path.relative(base, q).replace(/\\/g, '/')); } })(dir);
  return out.sort();
}
const FLwei = (x) => fl().g18(x); // a summary number back to wei, as G parses it
const keysMissing = (o, keys) => keys.filter((k) => !(o && Object.prototype.hasOwnProperty.call(o, k)));

// The folder holding the node_modules that holds ethers, for the installed copies (NODE_PATH, as chain-helper.test.cjs does).
function ethersNodeModules() {
  let d = path.dirname(require.resolve('ethers'));
  while (d !== path.dirname(d)) { if (path.basename(d) === 'ethers' && path.basename(path.dirname(d)) === 'node_modules') return path.dirname(d); d = path.dirname(d); }
  throw new Error('cannot locate the node_modules folder holding ethers');
}

// Install a copy of the planner (planner.cjs + planner/*.cjs) in binDir, with a config when given.
function installPlanner(binDir, cfg) {
  rmrf(path.join(binDir, 'planner')); fs.mkdirSync(path.join(binDir, 'planner'), { recursive: true });
  fs.copyFileSync(PLANNER_SRC, path.join(binDir, 'planner.cjs'));
  for (const f of fs.readdirSync(PLANNER_DIR)) if (f.endsWith('.cjs')) fs.copyFileSync(path.join(PLANNER_DIR, f), path.join(binDir, 'planner', f));
  if (cfg) fs.writeFileSync(path.join(binDir, 'planner.config.json'), JSON.stringify(cfg, null, 1));
  // ethers next to every installed copy (as the live section does): tests that load the installed copy in-process
  // (repair, recovery) resolve it from there, not through the child processes' NODE_PATH.
  if (!exists(path.join(binDir, 'node_modules', 'ethers'))) fs.cpSync(ethersNodeModules(), path.join(binDir, 'node_modules'), { recursive: true });
}

// Every invocation's output contract: exactly one JSON line, at most 20,000 characters, its exit equal to the process's.
const contract = [];
const SUMMARIES = {};
function runPlanner(L, args, { scen = {}, cwd, bin, keepCalls = false } = {}) {
  fs.writeFileSync(path.join(L.mock, 'scenario.json'), JSON.stringify(scen));
  if (!keepCalls) rmrf(path.join(L.mock, 'calls.json'));
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, [path.join(bin || L.bin, 'planner.cjs'), ...args], { cwd: cwd || L.proj, env: L.env, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 30 * 60 * 1000, windowsHide: true });
  const stdout = String(r.stdout || ''); const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  let j = null; try { j = JSON.parse(lines[lines.length - 1]); } catch (e) { j = null; }
  if (lines.length !== 1 || stdout.length > 20001 || !j) contract.push(`${args.join(' ')} -> ${lines.length} line(s), ${stdout.length} chars${j ? '' : ', not JSON'}`);
  else if (j.exit !== r.status) contract.push(`${args.join(' ')} -> summary exit ${j.exit}, process exit ${r.status}`);
  let calls = null; try { calls = rj(path.join(L.mock, 'calls.json')); } catch (e) { calls = { helper: {}, signer: {}, mc: 0, nonce: 0, encode: 0, sends: [] }; }
  if (j && j.subcommand) { // the first summary of each kind, for the README's examples
    const kind = j.exit === 0 ? (j.outcome || j.mode || j.result || j.source || 'ok') : 'stop-' + ((j.stop && j.stop.cause) || j.code);
    const key = `${j.subcommand}:${kind}`; if (!SUMMARIES[key]) SUMMARIES[key] = j;
  }
  return { code: r.status, j: j || {}, stdout, stderr: String(r.stderr || ''), ms: Date.now() - t0, calls };
}
const say = (r) => clip(`exit ${r.code}: ${r.stdout.slice(0, 900)} ${r.stderr ? 'stderr: ' + r.stderr.slice(-400) : ''}`, 1500);

// =================================================================================================================
// OFFLINE LAYOUT
// =================================================================================================================
function makeLayout(root) {
  const L = { root, bin: path.join(root, 'bin'), mock: path.join(root, 'mock'), proj: path.join(root, 'proj') };
  for (const d of [L.bin, L.mock, path.join(L.proj, 'run')]) fs.mkdirSync(d, { recursive: true });
  const shim = (fn, what) => `'use strict';\n// planner test mock (${what}): the logic is in planner.test.cjs; no network, no key.\nrequire(${JSON.stringify(TEST_FILE)}).${fn}(__dirname, process.argv.slice(2));\n`;
  fs.writeFileSync(path.join(L.mock, 'chain-helper.cjs'), shim('mockHelperMain', 'chain helper'));
  fs.writeFileSync(path.join(L.mock, 'signer.cjs'), shim('mockSignerMain', 'signer'));
  // the helper's own config next to it: the planner reads the holder (signerAddress) from it, nothing else
  wj(path.join(L.mock, 'chain-helper.config.json'), { chainId: 10, rpcUrl: 'http://127.0.0.1:9', dataFunctionUrl: 'http://127.0.0.1:9/data', signerAddress: HOLDER });
  L.cfg = { helperPath: path.join(L.mock, 'chain-helper.cjs'), signerPath: path.join(L.mock, 'signer.cjs'), projectRoot: L.proj, rpcGapMs: 0, parallel: 1 };
  installPlanner(L.bin, L.cfg);
  L.env = { ...process.env, NODE_PATH: [ethersNodeModules(), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) };
  return L;
}
const setWorld = (L, w) => wj(path.join(L.mock, 'world.json'), w);
const getWorld = (L) => rj(path.join(L.mock, 'world.json'));
function csvText() {
  const T = tb().T.rows; const L = ['repo,originality'];
  for (const [i, v] of Object.entries(FORECAST)) L.push(`https://github.com/${T[Number(i)].repo},${v}`);
  for (const i of BLANK) L.push(`https://github.com/${T[i].repo},`);
  L.push('https://github.com/nobody/not-in-round-3,0.5');
  return L.join('\n') + '\n';
}
const lockDir = (proj) => path.join(proj, 'run', '.lock.deep-r3-trade');
function wrapperLock(proj, runId, o = {}) {
  fs.mkdirSync(lockDir(proj), { recursive: true });
  fs.writeFileSync(path.join(lockDir(proj), 'owner.txt'), JSON.stringify({ pid: 4242, process_start_time: new Date().toISOString(), host: 'test-host', started_at: o.started_at || new Date().toISOString(), stage: o.stage || 'claude-p', run_id: runId }));
  fs.writeFileSync(path.join(lockDir(proj), 'live-runs.txt'), (o.live || []).join('\n'));
}
function setupRecord(proj, over = {}) {
  wj(path.join(proj, 'run', 'setup.deep-r3-trade.json'), { nonce_pinning: true, atomic_batches: false, first_successful_run: { run_id: 'a-supervised-run' }, autonomy: { enabled: true, authorized_at: '2026-10-06T00:00:00Z', signer_selftest_passed_at: '2026-10-06T00:00:00Z' }, schedule: { signer_allow_rule_added_at: '2026-10-06T00:00:00Z', time_limit_hours: 2, max_turns_run_ids: 5, cadence_hours: 24 }, ...over });
}
function snapshot(L, rid) { const s = path.join(L.root, 'snap-' + rid); rmrf(s); fs.cpSync(path.join(L.proj, 'run', rid), path.join(s, 'run'), { recursive: true }); fs.copyFileSync(path.join(L.mock, 'world.json'), path.join(s, 'world.json')); return s; }
function restore(L, rid, s) { rmrf(path.join(L.proj, 'run', rid)); fs.cpSync(path.join(s, 'run'), path.join(L.proj, 'run', rid), { recursive: true }); fs.copyFileSync(path.join(s, 'world.json'), path.join(L.mock, 'world.json')); rmrf(lockDir(L.proj)); }

// The summary keys each subcommand prints on success (besides subcommand, run_id, ok, exit, stop, detail).
const COMMON = ['subcommand', 'run_id', 'ok', 'exit', 'stop', 'detail'];
const KEYS = {
  c: ['source', 'body_refused', 'candidates', 'tradeable', 'not_tradeable', 'bundle_split', 'reason_counts', 'not_tradeable_rows', 'freshness', 'diagnostics_failed', 'block_timestamp', 'multicall_blocks', 'artifacts'],
  d: ['source', 'forecasts', 'csv', 'previous_run_cited', 'counts', 'unmatched_rows', 'overwritten_rows', 'no_forecast_split', 'skipped_not_scalar', 'artifacts'],
  e: ['blends', 'priced_from_candidates', 'priced_from_saved_body', 'null_price', 'null_price_rows', 'negative_third', 'fetched', 'artifacts'],
  f: ['rows', 'markets_with_rows', 'pair_markets', 'set_rows', 'single_side_rows', 'markets_without_row', 'skipped_entries', 'bankroll', 'staked_M', 'binds', 'expected_value', 'correlated_worst_case', 'iterations', 'step7_drops', 'tradeable_markets', 'held_markets', 'child_invalid_markets', 'merge_arb_markets', 'ramp_due', 'provisional', 'provisional_min_out', 'usdc_raw', 'usds_raw', 'body_used', 'ranges', 'pins', 'post3a_rows', 'probe', 'checks', 'drift_markets', 'drift_list', 'model_gap_max', 'helper_calls', 'quotes', 'seconds', 'artifacts'],
  g: ['nothing_to_send', 'groups', 'transactions', 'by_kind', 'markets', 'rows_in_groups', 'skipped_rows', 'skipped', 'mint', 'ramp_due', 'cut', 'nonce', 'first_last_nonce', 'drift', 'simulation', 'verify', 'eth', 'route_agreement', 'audit', 'indep', 'helper_calls', 'seconds', 'artifacts'],
  exec: ['outcome', 'mode', 'groups_total', 'groups_done', 'transactions_total', 'transactions_sent', 'sent_this_invocation', 'first_tx', 'last_tx', 'gas_cost_eth_receipts', 'nonce_pinning', 'signer_env_dropped', 'signer_log_path', 'tx_hash_file'],
  halfb: ['mode', 'actionable', 'sent', 'skipped', 'half_done', 'notes', 'artifacts', 'sends_this_invocation', 'keep_aborted', 'budget_exhausted', 'answer_watch', 'merge_bounds_at_read'],
  h: ['result', 'review_written'],
  report: ['report', 'lines', 'wake_status'],
  wake: ['status', 'stopped_at_step', 'half_a_stop', 'traded', 'repaired', 'sends_blocked', 'h_rescored', 'h_results', 'notes', 'report', 'wake_status'],
};
const shapeOk = (sub, j) => { const m = keysMissing(j, [...COMMON, ...KEYS[sub]]); return m.length ? `missing summary key(s) ${m.join(', ')}` : null; };

// =================================================================================================================
// SECTION static: the embedded table against the skill text; what the planner's source never does
// =================================================================================================================
async function staticSection() {
  const TB = tb();
  await test('static: table.cjs equals steps/C-select.md "The fixed 98" (98 rows and the three bundle headers)', () => {
    const f = path.join(SKILL_DIR, 'steps', 'C-select.md'); if (!exists(f)) skip('steps/C-select.md not found next to this scripts/ folder');
    const text = fs.readFileSync(f, 'utf8'); const at = text.indexOf('## The fixed 98'); ok(at >= 0, 'no "## The fixed 98" heading');
    const part = text.slice(at);
    const heads = [...part.matchAll(/^### Bundle ([ABC]) — parent outcome (\d+), bundle token `(0x[0-9a-fA-F]{40})`; middle market `(0x[0-9a-fA-F]{40})` \(multi-categorical, (\d+) repos \+ Invalid `(0x[0-9a-fA-F]{40})`\)/gm)];
    ok(heads.length === 3, `bundle headers found ${heads.length}`);
    heads.forEach((h, k) => { const b = TB.T.bundles[k]; ok(h[1] === b.name && Number(h[2]) === b.idx && lc(h[3]) === lc(b.bundleToken) && lc(h[4]) === lc(b.middle) && Number(h[5]) === b.nRepos && lc(h[6]) === lc(b.middleInvalid), `bundle header ${h[1]} differs from table.cjs`); });
    const rows = [...part.matchAll(/^\| (\d+) \| ([^|]+?) \| (\d+) \| `(0x[0-9a-f]{40})` \| `(0x[0-9a-f]{40})` \|[ \t\r]*$/gm)].slice(0, 98);
    ok(rows.length === 98, `table rows found ${rows.length}`);
    const bad = rows.filter((r, k) => { const t = TB.T.rows[k]; return Number(r[1]) !== k || r[2] !== t.repo || Number(r[3]) !== t.slot || r[4] !== t.address || r[5] !== t.repo_token; }).map((r) => r[1]);
    ok(bad.length === 0, `rows differ at # ${bad.slice(0, 10).join(', ')}`);
  });
  await test('static: the parent, parent Invalid and the four condition ids of table.cjs appear in the skill text (C-select.md, SKILL.md "Last verified")', () => {
    const c = path.join(SKILL_DIR, 'steps', 'C-select.md'); const s = path.join(SKILL_DIR, 'SKILL.md'); if (!exists(c) || !exists(s)) skip('skill text not found next to this scripts/ folder');
    const ct = lc(fs.readFileSync(c, 'utf8')); const st = lc(fs.readFileSync(s, 'utf8'));
    ok(ct.includes(lc(TB.ADDR.PARENT)) && ct.includes(lc(TB.ADDR.PARENT_INVALID)), 'parent or parent Invalid missing from C-select.md');
    for (const [k, v] of Object.entries(TB.CONDITIONS)) ok(st.includes(lc(v)), `condition id of ${k} missing from SKILL.md`);
  });
  const srcFiles = [PLANNER_SRC, ...fs.readdirSync(PLANNER_DIR).filter((f) => f.endsWith('.cjs')).map((f) => path.join(PLANNER_DIR, f))];
  const src = srcFiles.map((f) => ({ f: path.relative(SCRIPTS, f).replace(/\\/g, '/'), t: fs.readFileSync(f, 'utf8') }));
  await test('static: every subcommand of planner.cjs has its module, and lib.MODULES names exactly those subcommands', () => {
    const lib = require(path.join(PLANNER_DIR, 'lib.cjs'));
    const grammar = /const GRAMMAR = \{([\s\S]*?)\n\};/.exec(src[0].t); ok(grammar, 'GRAMMAR not found in planner.cjs');
    const subs = [...grammar[1].matchAll(/^\s+([a-z]+): \{/gm)].map((m) => m[1]);
    ok(JSON.stringify(subs.slice().sort()) === JSON.stringify(Object.keys(lib.MODULES).sort()), `GRAMMAR ${subs} vs MODULES ${Object.keys(lib.MODULES)}`);
    for (const s of subs) ok(exists(path.join(PLANNER_DIR, lib.MODULES[s])), `module of ${s} missing`);
  });
  await test('static: no environment variable is read (process.env only passed through to children), no socket module, no fetch, no key handling', () => {
    const bad = [];
    for (const { f, t } of src) {
      const code = t.replace(/\/\/[^\n]*/g, ''); // comments out
      if (/process\.env\s*(\.|\[)/.test(code)) bad.push(`${f}: reads process.env`);
      if (/require\(\s*['"](node:)?(http|https|net|tls|dgram|http2)['"]\s*\)/.test(code)) bad.push(`${f}: requires a socket module`);
      if (/\bfetch\s*\(/.test(code)) bad.push(`${f}: fetch`);
      if (/\b(Wallet|privateKey|keystore|signTransaction|sendRawTransaction|eth_sendRawTransaction|decryptKeystore|SigningKey)\b/.test(code)) bad.push(`${f}: key handling token`);
    }
    ok(bad.length === 0, bad.join('; '));
  });
  await test('static: planner.config.example.json carries exactly the config keys lib.cjs accepts', () => {
    const lib = require(path.join(PLANNER_DIR, 'lib.cjs'));
    const ex = rj(path.join(SCRIPTS, 'planner.config.example.json'));
    ok(JSON.stringify(Object.keys(ex).sort()) === JSON.stringify([...lib.CONFIG_KEYS].sort()), `example keys ${Object.keys(ex)}`);
  });
}

// =================================================================================================================
// SECTION usage: arguments, the config (fail closed), the inside-project refusal, the current folder
// =================================================================================================================
async function usageSection(L) {
  setWorld(L, freshWorld());
  const P = (args, o) => runPlanner(L, args, o);
  await test('usage: no subcommand -> exit 2 usage, one JSON line', () => { const r = P([]); ok(r.code === 2 && r.j.code === 'usage', say(r)); });
  await test('usage: unknown subcommand, missing run-id -> exit 2', () => { const a = P(['zz', 'x']); const b = P(['c']); ok(a.code === 2 && a.j.code === 'usage' && b.code === 2 && b.j.code === 'usage', say(a) + say(b)); });
  await test('usage: run-ids "csv", "..", "a:b" and ".x" are refused (exit 2 bad_run_id), no folder created', () => {
    for (const id of ['csv', '..', 'a:b', '.x']) { const r = P(['c', id]); ok(r.code === 2 && r.j.code === 'bad_run_id', `${id}: ${say(r)}`); }
    ok(!exists(path.join(L.proj, 'run', 'a:b')), 'a folder was created');
  });
  await test('usage: flags are per subcommand (c --supply, d --continue alone, a flag twice, exec --max-groups 0, f --check, d --notes with a control character, f --provisional with a value or twice, g --provisional) -> exit 2', () => {
    const cases = [['c', 'r1', '--supply', 'x.csv'], ['d', 'r1', '--continue'], ['d', 'r1', '--supply', 'a.csv', '--supply', 'b.csv'], ['exec', 'r1', '--max-groups', '0'], ['f', 'r1', '--check'], ['d', 'r1', '--supply', 'a.csv', '--notes', 'a\u0007b'], ['g', 'r1', '--indep', 'x'], ['f', 'r1', '--provisional', 'x'], ['f', 'r1', '--provisional', '--provisional'], ['g', 'r1', '--provisional']];
    for (const a of cases) { const r = P(a); ok(r.code === 2 && r.j.code === 'usage', `${a.join(' ')}: ${say(r)}`); }
  });
  const cfgFile = path.join(L.bin, 'planner.config.json'); const good = fs.readFileSync(cfgFile);
  const withCfg = (text, fn) => { fs.writeFileSync(cfgFile, text); try { return fn(); } finally { fs.writeFileSync(cfgFile, good); } };
  await test('config: missing -> exit 2 config_missing (fail closed)', () => { fs.unlinkSync(cfgFile); try { const r = P(['c', 'r1']); ok(r.code === 2 && r.j.code === 'config_missing', say(r)); } finally { fs.writeFileSync(cfgFile, good); } });
  await test('config: not JSON, an unknown key, the example file (placeholders), parallel 0, rpcGapMs -1, a relative helperPath, a missing signer -> exit 2', () => {
    const cfg = JSON.parse(good);
    const cases = [['not json', '{not json'], ['unknown key', JSON.stringify({ ...cfg, extra: 1 })], ['example', fs.readFileSync(path.join(SCRIPTS, 'planner.config.example.json'), 'utf8')],
      ['parallel 0', JSON.stringify({ ...cfg, parallel: 0 })], ['rpcGapMs -1', JSON.stringify({ ...cfg, rpcGapMs: -1 })], ['relative helper', JSON.stringify({ ...cfg, helperPath: 'mock/chain-helper.cjs' })],
      ['missing signer', JSON.stringify({ ...cfg, signerPath: path.join(L.mock, 'no-such-signer.cjs') })], ['array', '[]']];
    for (const [what, text] of cases) withCfg(text, () => { const r = P(['c', 'r1']); ok(r.code === 2 && /^config_/.test(r.j.code), `${what}: ${say(r)}`); });
  });
  await test('config: the signer (or the helper) inside the project folder -> exit 2 config_inside_project', () => {
    const inside = path.join(L.proj, 'signer.cjs'); fs.writeFileSync(inside, '// not a signer\n');
    try { const cfg = JSON.parse(good); withCfg(JSON.stringify({ ...cfg, signerPath: inside }), () => { const r = P(['c', 'r1']); ok(r.code === 2 && r.j.code === 'config_inside_project', say(r)); }); } finally { fs.unlinkSync(inside); }
  });
  await test('config: run from a folder other than projectRoot -> exit 2 config_cwd_mismatch', () => {
    const other = path.join(L.root, 'other-proj'); fs.mkdirSync(path.join(other, 'run'), { recursive: true });
    const r = P(['c', 'r1'], { cwd: other }); ok(r.code === 2 && r.j.code === 'config_cwd_mismatch', say(r));
  });
  await test('config: the planner installed inside the project folder refuses to run (exit 2 config_inside_project)', () => {
    const inBin = path.join(L.proj, 'tools'); installPlanner(inBin, L.cfg);
    try { const r = P(['c', 'r1'], { bin: inBin }); ok(r.code === 2 && r.j.code === 'config_inside_project', say(r)); } finally { rmrf(inBin); }
  });
  await test('config: a symlinked planner.config.json is refused (exit 2)', () => {
    const real = path.join(L.root, 'cfg-elsewhere.json'); fs.writeFileSync(real, good);
    fs.unlinkSync(cfgFile);
    try {
      try { fs.symlinkSync(real, cfgFile, 'file'); } catch (e) { skip(`cannot create a file symlink here (${e.code})`); }
      const r = P(['c', 'r1']); ok(r.code === 2 && r.j.code === 'config_malformed', say(r));
    } finally { try { fs.unlinkSync(cfgFile); } catch (e) { /* none */ } fs.writeFileSync(cfgFile, good); }
  });
  await test('usage: e, f, g and exec on an unknown run-id stop (exit 3) and create no run folder', () => {
    for (const s of ['e', 'f', 'g', 'exec']) { const r = P([s, 'no-such-run']); ok(r.code === 3 && r.j.stop, `${s}: ${say(r)}`); }
    ok(!exists(path.join(L.proj, 'run', 'no-such-run')), 'a run folder was created');
  });
}

// =================================================================================================================
// SECTION lib: path confinement, the summary cap, the runners (in process, on the installed copy)
// =================================================================================================================
async function libSection(L) {
  const lib = require(path.join(L.bin, 'planner', 'lib.cjs'));
  const cfg = { projectRoot: fs.realpathSync.native(L.proj), helperPath: fs.realpathSync.native(path.join(L.mock, 'chain-helper.cjs')), signerPath: fs.realpathSync.native(path.join(L.mock, 'signer.cjs')), rpcGapMs: 0, parallel: 1 };
  const code = (f) => { try { f(); return 'ok'; } catch (e) { return e.code || e.message; } };
  fs.mkdirSync(path.join(L.proj, 'run', 'mine'), { recursive: true });
  await test('lib: a write outside this run-id, into the CSV store without the grant, with "..", absolute, outside run/, with a colon -> refused', () => {
    const cases = [['run/other/x.json', 'path_not_allowed'], ['run/csv/x.csv', 'path_not_allowed'], ['run/mine/../x.json', 'path_traversal'], [path.join(L.proj, 'run', 'mine', 'x.json'), 'path_absolute'], ['notrun/mine/x.json', 'path_outside_run'], ['run/mine/x.json:ads', 'path_colon'], ['run/mine/CON', 'path_component']];
    for (const [rel, want] of cases) { const got = code(() => lib.writeRunFile(cfg, rel, 'x', { runId: 'mine' })); ok(got === want, `${rel}: ${got}, expected ${want}`); }
  });
  await test('lib: the CSV store is writable only with the grant; a write lands atomically; "wx" never overwrites', () => {
    ok(lib.writeRunFile(cfg, 'run/csv/t.csv', 'a', { runId: 'mine', allowCsv: true }) === 'run/csv/t.csv', 'granted csv write failed');
    ok(lib.writeRunFile(cfg, 'run/mine/sub/ok.json', '{}', { runId: 'mine' }) === 'run/mine/sub/ok.json' && fs.readFileSync(path.join(L.proj, 'run', 'mine', 'sub', 'ok.json'), 'utf8') === '{}', 'atomic write');
    ok(!fs.readdirSync(path.join(L.proj, 'run', 'mine', 'sub')).some((f) => /tmp/.test(f)), 'a temp file was left');
    ok(code(() => lib.writeRunFile(cfg, 'run/mine/sub/ok.json', 'x', { runId: 'mine', flag: 'wx' })) === 'EEXIST', 'wx overwrote');
    fs.unlinkSync(path.join(L.proj, 'run', 'csv', 't.csv')); rmrf(path.join(L.proj, 'run', 'csv'));
  });
  await test('lib: a junction or symlink inside the run folder is refused for writes and reads', () => {
    const target = path.join(L.root, 'elsewhere'); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'a.json'), '{}');
    const link = path.join(L.proj, 'run', 'mine', 'jx');
    try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { skip(`cannot create a junction here (${e.code})`); }
    try {
      ok(code(() => lib.writeRunFile(cfg, 'run/mine/jx/b.json', 'x', { runId: 'mine' })) === 'path_symlink', 'write through the junction');
      ok(code(() => lib.readRunFile(cfg, 'run/mine/jx/a.json')) === 'path_symlink', 'read through the junction');
      ok(!exists(path.join(target, 'b.json')), 'the write landed outside');
    } finally { try { fs.rmdirSync(link); } catch (e) { try { fs.unlinkSync(link); } catch (x) { /* already gone */ } } }
  });
  await test('lib: a summary over 20,000 characters is printed in its small form, valid JSON, under the cap', () => {
    const s = lib.renderSummary({ subcommand: 'c', run_id: 'r', ok: true, exit: 0, stop: null, filler: 'x'.repeat(50000) });
    ok(s.length <= 20000 && JSON.parse(s).truncated === true && JSON.parse(s).subcommand === 'c', s.slice(0, 200));
  });
  await test('lib: the signer runner refuses info, reconcile, sweep-*, clear-nonce and allowlist-init, and any send flag but --nonce <n>, before spawning', async () => {
    for (const sub of ['info', 'reconcile', 'sweep-eth', 'sweep-token', 'clear-nonce', 'allowlist-init']) { const r = await lib.runSigner({ ...cfg, signerPath: 'never-run' }, sub, 'run/mine/a.json').then(() => 'ran', (e) => e.code); ok(r === 'internal', `${sub}: ${r}`); }
    const r = await lib.runSigner({ ...cfg, signerPath: 'never-run' }, 'send', 'run/mine/a.json', ['--force']).then(() => 'ran', (e) => e.code); ok(r === 'internal', `send --force: ${r}`);
    const r2 = await lib.runSigner({ ...cfg, signerPath: 'never-run' }, 'check', '../outside.json').then(() => 'ran', (e) => e.code); ok(r2 === 'path_traversal', `check ../: ${r2}`);
  });
  await test('lib: rate-limit text is transient (the public RPC answers a rate limit as a plain rpc_error): re-run, then the answer', async () => {
    ok(['exceeded its requests per second capacity', 'over rate limit', 'Too Many Requests', 'HTTP 429', 'at capacity'].every((t) => lib.RATE_LIMIT_TEXT.test(t)), 'RATE_LIMIT_TEXT');
    setWorld(L, freshWorld()); fs.writeFileSync(path.join(L.mock, 'scenario.json'), JSON.stringify({ rateLimit: { n: 2, subs: ['chain-id'] } }));
    const before = lib.stats.helperRetries; const t0 = Date.now();
    const r = await lib.runHelper(cfg, ['chain-id']);
    ok(r.json.chain_id === 10 && r.attempts === 3 && lib.stats.helperRetries - before === 2, `attempts ${r.attempts} in ${Date.now() - t0} ms`);
  });
  await test('lib: a signer throttle (rpc-error with rate-limit text in detail, no "simulated":true) is re-run for simulate and for a send that printed no broadcast line; never for a send after its broadcast line or a "simulated":true answer', async () => {
    const T = { error: 'rpc-error', detail: 'exceeded its requests per second capacity', signed: false, broadcast: false };
    ok(lib.signerThrottled('simulate', 1, T, []) && lib.signerThrottled('send', 1, T, [{ event: 'lock' }, T]), 'the throttle answer');
    ok(!lib.signerThrottled('check', 1, T, []), 'check makes no RPC call');
    ok(!lib.signerThrottled('send', 1, T, [{ event: 'lock' }, { event: 'broadcast', hash: '0x01' }, T]), 'a send with a broadcast line');
    ok(!lib.signerThrottled('simulate', 1, { simulated: true, ok: false, results: [{ status: '0x0', error: 'execution reverted: over capacity' }] }, []), 'a "simulated":true answer');
    ok(!lib.signerThrottled('send', 1, { ...T, error: 'simulation-reverted' }, []) && !lib.signerThrottled('send', 1, { ...T, detail: 'network error or timeout' }, []) && !lib.signerThrottled('send', 0, T, []), 'a revert, a non-rate-limit RPC error, exit 0');
    setWorld(L, freshWorld());
    const call = { to: sw().A.sUSDS, data: iface().encodeFunctionData('approve', [sw().A.ROUTER, 1n]), value: '0' };
    fs.writeFileSync(path.join(L.proj, 'run', 'mine', 'tx.json'), JSON.stringify({ calls: [call], gasLimit: '55200' }));
    const calls = () => rj(path.join(L.mock, 'calls.json'));
    rmrf(path.join(L.mock, 'calls.json')); fs.writeFileSync(path.join(L.mock, 'scenario.json'), JSON.stringify({ signerRateLimit: { n: 2, subs: ['simulate'] } }));
    const s = await lib.runSigner(cfg, 'simulate', 'run/mine/tx.json', [], { retries: 9 });
    ok(s.exit === 0 && s.last.simulated === true && s.attempts === 3, `simulate: exit ${s.exit}, attempts ${s.attempts}`);
    rmrf(path.join(L.mock, 'calls.json')); fs.writeFileSync(path.join(L.mock, 'scenario.json'), JSON.stringify({ signerRateLimit: { n: 1, subs: ['send'] } }));
    const d = await lib.runSigner(cfg, 'send', 'run/mine/tx.json', [], { retries: 9 });
    ok(d.exit === 0 && d.attempts === 2 && d.last.event === 'confirmed' && calls().sends.length === 1, `send before signing: exit ${d.exit}, attempts ${d.attempts}, mined ${calls().sends.length}`);
    rmrf(path.join(L.mock, 'calls.json')); fs.writeFileSync(path.join(L.mock, 'scenario.json'), JSON.stringify({ signerRateLimit: { n: 3, subs: ['send'], afterBroadcast: true } }));
    const b = await lib.runSigner(cfg, 'send', 'run/mine/tx.json', [], { retries: 9 });
    ok(b.exit === 1 && b.attempts === 1 && calls().signer.send === 1, `send after its broadcast line: exit ${b.exit}, attempts ${b.attempts}`);
    rmrf(path.join(L.mock, 'calls.json')); fs.writeFileSync(path.join(L.mock, 'scenario.json'), JSON.stringify({ signerRateLimit: { n: 1, subs: ['send'] } }));
    const z = await lib.runSigner(cfg, 'send', 'run/mine/tx.json');
    ok(z.exit === 1 && z.attempts === 1 && z.last.error === 'rpc-error', `no retries given: attempts ${z.attempts}`);
    fs.writeFileSync(path.join(L.mock, 'scenario.json'), '{}'); rmrf(path.join(L.mock, 'calls.json')); setWorld(L, freshWorld());
  });
  await test('lib: a revert whose text looks like a rate limit (exit 8) is not re-run', async () => {
    fs.mkdirSync(path.join(L.proj, 'run', 'mine'), { recursive: true }); fs.writeFileSync(path.join(L.proj, 'run', 'mine', 'reads.json'), JSON.stringify([{ to: ZERO_ADDR, signature: 'x()(uint256)' }]));
    fs.writeFileSync(path.join(L.mock, 'scenario.json'), JSON.stringify({ revertOn: 'reads.json' }));
    const e = await lib.runHelper(cfg, ['multicall', 'run/mine/reads.json']).then(() => null, (x) => x);
    ok(e && e.helperExit === 8 && e.attempts === 1 && e.transient === false, clip(e && e.message));
    fs.writeFileSync(path.join(L.mock, 'scenario.json'), '{}');
  });
  await test('lib: the holder is the signerAddress of the helper\'s own config, next to the helper', () => { ok(lc(lib.holderAddress(cfg)) === HOLDER, lib.holderAddress(cfg)); });
  const X = require(path.join(L.bin, 'planner', 'exec-core.cjs'));
  await test('gas pre-send rule: a refund-free call (approve, limit ceil(46000 x 1.2)) passes; the old "gasUsed x 1.5 <= limit" form would have refused it', () => {
    const a = { planGasUsed: 46000, planPeak: 46000, gasLimit: String(limitOf(46000, 46000)), freshGas: 46000 };
    ok(a.gasLimit === '55200' && X.gasCheck(a).ok, JSON.stringify(X.gasCheck(a)));
    ok(46000 * 1.5 > Number(a.gasLimit), 'the old form would have passed too: no regression shown');
    const up = X.gasCheck({ ...a, freshGas: 46001 }); ok(!up.ok && up.part === 'a', 'a refund-free call has no headroom above its own gasUsed x 1.2: one more gas unit is part (a)');
  });
  await test('gas pre-send rule: a Router split (peak 1.25 x gasUsed, limit from maxUsedGas) passes; each of the three parts stops on its own', () => {
    const s = { planGasUsed: 590127, planPeak: 737658, gasLimit: String(limitOf(590127, 737658)) };
    ok(X.gasCheck({ ...s, freshGas: 590127 }).ok, 'the split at its own gas');
    ok(X.gasCheck({ ...s, freshGas: 649139 }).ok, 'exactly 10% above the plan passes');
    const c = X.gasCheck({ ...s, freshGas: 650000 }); ok(!c.ok && c.part === 'c' && c.kind === 'gas-grew', 'part (c): more than 10% above the plan -> gas-grew');
    const b = X.gasCheck({ planGasUsed: 590127, planPeak: 900000, gasLimit: '885190', freshGas: 590127 }); ok(!b.ok && b.part === 'b' && b.kind === 'gas-limit', 'part (b): the measured peak above the limit');
    const a = X.gasCheck({ planGasUsed: 100000, planPeak: 100000, gasLimit: '110000', freshGas: 100000 }); ok(!a.ok && a.part === 'a', 'part (a): fresh x 1.2 above the limit');
    ok(X.gasCheck({ planGasUsed: 46000, planPeak: null, gasLimit: String(limitOf(46000, null)), freshGas: 46000 }).ok, 'a fallback limit (no maxUsedGas): the peak is gasUsed');
  });
  // the pre-send simulate (exec-core presend), in process with a stubbed signer: only a "simulated":true answer is a
  // simulation result (I-setup.md I.2 section 7, Rate limits); its failure is G section 8's stale check
  await test('pre-send simulate: an RPC failure with no "simulated":true (rpc-transport, rpc-http 503, a plain rpc-error) and the planner\'s own timeout are transport failures (exit 5); simulate\'s own -38xxx refusal, a signer refusal and malformed output are their own stops (exit 3); only a "simulated":true 0x0 answer is stale-simulation', async () => {
    const call = { to: sw().A.sUSDS, data: iface().encodeFunctionData('approve', [sw().A.ROUTER, 7n]), value: '0' };
    fs.mkdirSync(path.join(L.proj, 'run', 'mine'), { recursive: true }); fs.writeFileSync(path.join(L.proj, 'run', 'mine', 'ps.json'), JSON.stringify({ calls: [call], gasLimit: '55200' }));
    const tx = { label: 'approve (test)', to: call.to, data: call.data, gas_limit: '55200', gas_used: 46000, max_used_gas: 46000, signer_input_file: 'run/mine/ps.json', calldata_keccak256: keccakHex(call.data) };
    const run = async (answer) => {
      const c = { cfg, log: () => {}, helper: async (args) => ({ json: args[0] === 'nonce' ? { latest: 5, pending: 5 } : { keccak256: keccakHex(call.data) } }), signer: async () => answer };
      const env = X.makeEnv(c, { step: 'G', holder: HOLDER, setup: null });
      try { await X.presend(env, new X.Book(cfg, 'mine'), tx, 5); return { cause: 'none' }; } catch (e) { return { cause: e.cause, exit: e.exit }; }
    };
    const fail = (j) => ({ exit: 1, last: j, lines: [j], stdout: JSON.stringify(j), stderr: '', attempts: 1, timedOut: false });
    const cases = [
      ['rpc-transport', fail({ error: 'rpc-transport', detail: 'network error or timeout talking to the pinned RPC', command: 'simulate', signed: false, broadcast: false }), 'transport', 5],
      ['rpc-http 503', fail({ error: 'rpc-http', detail: 'HTTP 503 from the pinned RPC', command: 'simulate', signed: false, broadcast: false }), 'transport', 5],
      ['plain rpc-error', fail({ error: 'rpc-error', detail: 'header not found', rpc_code: -32000, command: 'simulate', signed: false, broadcast: false }), 'transport', 5],
      ['timeout', { exit: null, last: { simulated: true, ok: false }, lines: [], stdout: '{"simulated":tr', stderr: '', attempts: 1, timedOut: true }, 'transport', 5],
      ['-38014', fail({ error: 'rpc-error', detail: 'block gas limit reached', rpc_code: -38014, command: 'simulate', signed: false, broadcast: false }), 'tool-failure', 3],
      ['refusal', { exit: 3, last: { refused: 'allowlist', rule: 'chain-id', detail: 'not chain 10' }, lines: [], stdout: '', stderr: '', attempts: 1, timedOut: false }, 'signer-refused', 3],
      ['malformed', { exit: 1, last: null, lines: [], stdout: 'garbage', stderr: '', attempts: 1, timedOut: false }, 'tool-failure', 3],
      ['simulated 0x0', fail({ simulated: true, ok: false, nonce: 5, results: [{ index: 0, status: '0x0', gas_used: '46000', error: 'execution reverted' }] }), 'stale-simulation', 3],
      ['simulated 0x1', { exit: 0, last: { simulated: true, ok: true, nonce: 5, results: [{ index: 0, status: '0x1', gas_used: '46000' }] }, lines: [], stdout: '', stderr: '', attempts: 1, timedOut: false }, 'none', undefined],
    ];
    for (const [what, ans, cause, exit] of cases) { const r = await run(ans); ok(r.cause === cause && r.exit === exit, `${what}: ${JSON.stringify(r)}, expected ${cause} exit ${exit}`); }
  });
  // signer mode (b), a TradeExecutor with a session key (I-setup.md I.2 section 7, The planner): exec-core, the one send
  // path, refuses it before any read, write-ahead or signer call; only that known value refuses
  await test('signer mode (b): only signer_mode "executor-session-key" refuses; local-encrypted-eoa, eip7702, other-agent-signer, a record with no signer_mode, no record and the setup template\'s list of modes keep working; presend and broadcast stop with unsupported-signer-mode (exit 3) before any helper or signer call and write nothing', async () => {
    const keep = [['local-encrypted-eoa', { signer_mode: 'local-encrypted-eoa' }], ['eip7702', { signer_mode: 'eip7702' }], ['other-agent-signer', { signer_mode: 'other-agent-signer' }], ['no signer_mode', { nonce_pinning: true }], ['no record', null], ['the template list', { signer_mode: 'local-encrypted-eoa | eip7702 | executor-session-key | other-agent-signer' }]];
    for (const [what, setup] of keep) {
      ok(X.signerModeProblem(setup) === null && X.makeEnv({ cfg }, { step: 'G', holder: HOLDER, setup }).signerModeProblem === null, `${what} refused`);
      let e = null; try { X.refuseSignerMode('G', setup); } catch (x) { e = x; } ok(e === null, `${what}: refuseSignerMode threw ${e && e.cause}`);
    }
    for (const v of ['executor-session-key', ' Executor-Session-Key ']) {
      let e = null; try { X.refuseSignerMode('B', { signer_mode: v }); } catch (x) { e = x; }
      ok(e && e.cause === 'unsupported-signer-mode' && e.exit === 3 && e.status === 'aborted' && e.notes.includes(X.SIGNER_MODE_NOTE), `"${v}": ${e && JSON.stringify({ cause: e.cause, exit: e.exit, notes: e.notes })}`);
    }
    const call = { to: sw().A.sUSDS, data: iface().encodeFunctionData('approve', [sw().A.ROUTER, 7n]), value: '0' };
    const tx = { label: 'approve (test)', to: call.to, data: call.data, gas_limit: '55200', gas_used: 46000, max_used_gas: 46000, signer_input_file: 'run/mine/ps.json', calldata_keccak256: keccakHex(call.data) };
    const seen = [];
    const c = { cfg, log: () => {}, helper: async (args) => { seen.push('helper ' + args[0]); throw new Error('no helper call'); }, signer: async (sub) => { seen.push('signer ' + sub); throw new Error('no signer call'); } };
    const env = X.makeEnv(c, { step: 'G', holder: HOLDER, setup: { signer_mode: 'executor-session-key' } });
    const book = new X.Book(cfg, 'mine');
    for (const [what, f] of [['presend', () => X.presend(env, book, tx, 5)], ['broadcast', () => X.broadcast(env, book, tx, 5, keccakHex(call.data))]]) {
      const e = await f().then(() => null, (x) => x);
      ok(e && e.cause === 'unsupported-signer-mode' && e.exit === 3 && e.notes.includes(X.SIGNER_MODE_NOTE), `${what}: ${e && JSON.stringify({ cause: e.cause, exit: e.exit, notes: e.notes })}`);
    }
    ok(seen.length === 0 && ['inflight.json', 'nonce-attempts.json', 'exec-sends.json'].every((n) => !exists(path.join(L.proj, 'run', 'mine', n))), `calls ${seen.join(', ')}`);
  });
  // the settlement block scan (exec-core settleNonce): forward only from from_block, bounded by time, resumed from its
  // cursor (settle-scan.json) at the next settlement, nonce-attempts.json never edited
  await test('settlement scan: a cancel (a foreign transaction) mined at from_block + 40,000 is found across five settlements of a 10,000-block time budget each; every block read exactly once, none skipped; Pending in between with the resume block; nonce-attempts.json byte-identical', async () => {
    const rid = 'scan-1'; rmrf(path.join(L.proj, 'run', rid)); fs.mkdirSync(path.join(L.proj, 'run', rid), { recursive: true });
    const N = 9; const FROM = 5000; const AT = FROM + 40000; const HEAD = AT + 10; const H = '0x' + 'ab'.repeat(32);
    fs.writeFileSync(path.join(L.proj, 'run', rid, 'nonce-attempts.json'), JSON.stringify([{ nonce: N, to: '0x' + '22'.repeat(20), calldata_hash: H, from_block: FROM }]));
    const att0 = fs.readFileSync(path.join(L.proj, 'run', rid, 'nonce-attempts.json'));
    let clock = 0; const reads = new Map();
    const c = { cfg, log: () => {}, signer: async () => { throw new Error('no signer call'); }, helper: async (args) => {
      if (args[0] === 'nonce') return { json: { latest: N + 1, pending: N + 1 } };
      if (args[0] === 'receipt') return { json: { found: false } };
      if (args[0] === 'block' && args[1] === 'latest') return { json: { number: HEAD } };
      if (args[0] === 'block') { const b = Number(args[1]); clock += 1; reads.set(b, (reads.get(b) || 0) + 1); return { json: { number: b, txs_from: b === AT ? [{ nonce: N, hash: '0x' + 'ee'.repeat(32), to: HOLDER, input_keccak256: '0x' + 'ff'.repeat(32) }] : [] } }; }
      throw new Error('unexpected ' + args.join(' '));
    } };
    const env = X.makeEnv(c, { step: 'W', holder: HOLDER, setup: null }); env.now = () => clock;
    const book = new X.Book(cfg, rid); const seen = [];
    for (let k = 1; k <= 5; k++) {
      const s = await X.settleNonce(env, book, N, { budgetMs: 10000 }); seen.push(s.outcome);
      const cur = JSON.parse(fs.readFileSync(path.join(L.proj, 'run', rid, 'settle-scan.json'), 'utf8'))[String(N)];
      if (k < 5) ok(s.outcome === 'pending' && cur.next_block === FROM + 10000 * k && new RegExp(`resumes at block ${FROM + 10000 * k}`).test(s.via), `settlement ${k}: ${JSON.stringify(s)} cursor ${JSON.stringify(cur)}`);
      else ok(s.outcome === 'not-sent' && s.foreign && s.foreign.block === AT && cur.next_block === AT, `settlement 5: ${JSON.stringify(s)} cursor ${JSON.stringify(cur)}`);
    }
    const twice = [...reads].filter(([, n]) => n > 1).length; let gap = 0; for (let b = FROM; b <= AT; b++) if (!reads.has(b)) gap++;
    ok(twice === 0 && gap === 0 && reads.size === AT - FROM + 1, `blocks read twice ${twice}, skipped ${gap}, read ${reads.size}`);
    ok(fs.readFileSync(path.join(L.proj, 'run', rid, 'nonce-attempts.json')).equals(att0), 'nonce-attempts.json changed');
    rmrf(path.join(L.proj, 'run', rid));
  });
  // H step 4's cost basis on real rows (the first live run's fills.json, 2026-10-05, numbers inline): a complex-buy's
  // filled x fill_price is x, its whole net outlay, and its x child Invalid already carries that split into the set
  // term, so x is counted once. Hand: herumi/mcl Cf = x; UP wins filled - x, DOWN wins -x, INVALID x - x = 0.
  // ethereum/py_ecc (a set-sell and a complex-buy, one Invalid entry q + x): Cf = (q + x) - q x 1.0290846409557581.
  await test('h: a complex-buy counts its x once (H step 4): herumi/mcl UP pnl +2.849115636005509 / -7.6641121701439 / 0 (UP, DOWN, INVALID wins), slippage 0; ethereum/py_ecc set-sell + complex-buy +5.281196697480954 / -21.320491902176045 / +15.909869599198458; the attribution telescopes', async () => {
    const H = require(path.join(L.bin, 'planner', 'h.cjs'));
    const rid = 'h-cb'; const dir = path.join(L.proj, 'run', rid); rmrf(dir);
    const HM = { name: 'herumi/mcl', addr: '0xc7846582934c4c1d1156ddf44d988f6857b0f743', inv: fakeAddr('h-cb:herumi-inv') };
    const PY = { name: 'ethereum/py_ecc', addr: '0x5d6a571b0f663c33831e6f81dd3c3f554eca188b', inv: fakeAddr('h-cb:py_ecc-inv') };
    const row = (m, side, route, requested, filled, fp) => ({ market: m.name, address: m.addr, side, route, requested, filled, fill_price: fp, slippage_vs_quote: 0, tx_hash: '0x' + sha(`h-cb:${m.name}:${route}`), status: 'filled', error: null });
    const pos = (m, side, route, stake, qf) => ({ market: m.name, address: m.addr, side, route, stake, quoted_fill: qf });
    wj(path.join(dir, 'fills.json'), { runs: [row(HM, 'UP', 'complex-buy', 7.6641121701439, 10.513227806149409, 0.728997060794307), row(PY, 'set', 'set-sell', 15.4602148025669, 15.4602148025669, 1.0290846409557581), row(PY, 'UP', 'complex-buy', 21.7701466988076, 26.601688599657, 0.8183746162297496)],
      retained_legs: [{ token: HM.inv, amount: 7.6641121701439, why: 'child Invalid; sources: herumi/mcl UP complex-buy' }, { token: PY.inv, amount: 37.2303615013745, why: 'child Invalid; sources: ethereum/py_ecc set set-sell, ethereum/py_ecc UP complex-buy' }] });
    wj(path.join(dir, 'allocation.json'), { positions: [pos(HM, 'UP', 'direct', 7.6641121701439, 0.7333855208877189), pos(PY, 'set', 'set-sell', 15.4602148025669, 1.029084640955758), pos(PY, 'UP', 'direct', 21.7701466988076, 0.8170351167715235)] });
    const p = [0.2606, 0.7394, 0]; // herumi/mcl has a forecast (the forecast branch), py_ecc none (the pair branch)
    wj(path.join(dir, 'base-forecast.json'), { method: 'csv-face-value', forecasts: [{ market: HM.name, address: HM.addr, p }] });
    wj(path.join(dir, 'blended.json'), { blends: [{ market: HM.name, address: HM.addr, blended: p, market_price: [0.27, 0.73, 0] }] });
    const cond = (a) => '0x' + sha('h-cb:cond:' + a);
    const cases = [['UP wins', ['0', '1', '0'], 2.849115636005509, 5.281196697480954], ['DOWN wins', ['1', '0', '0'], -7.6641121701439, -21.320491902176045], ['INVALID', ['0', '0', '1'], 0, 15.909869599198458]];
    try {
      for (const [what, nums, wantHM, wantPY] of cases) {
        rmrf(path.join(dir, 'review.json'));
        const c = lib.makeContext({ cfg, sub: 'h', runId: rid }); c.holder = () => HOLDER;
        c.helper = async (args) => { throw new Error('no helper call: ' + args.join(' ')); }; c.signer = async () => { throw new Error('no signer call'); };
        c.multicall = async (name, reads) => ({ block: 1, results: reads.map((r) => {
          const a = r.args || []; const settled = [HM.addr, PY.addr].map(cond).includes(a[0]);
          if (r.signature === 'conditionId()(bytes32)') return [cond(r.to)];
          if (r.signature.startsWith('wrappedOutcome')) return [a[0] === '2' && r.to === HM.addr ? HM.inv : a[0] === '2' && r.to === PY.addr ? PY.inv : fakeAddr(`h-cb:${r.to}:${a[0]}`)];
          if (r.signature.startsWith('parentMarket')) return [fakeAddr('h-cb:middle')];
          if (r.signature.startsWith('parentOutcome')) return ['0'];
          if (r.signature.startsWith('payoutDenominator')) return [settled ? '1' : '0'];
          if (r.signature.startsWith('payoutNumerators')) return [settled ? nums[Number(a[1])] : '0'];
          throw new Error('unexpected read ' + r.signature);
        }) });
        const out = await H.run(c); ok(out.result === 'review.json written' && out.settled === 2, `${what}: ${JSON.stringify(out)}`);
        const rv = rj(path.join(dir, 'review.json')); const hm = rv.resolved.find((x) => x.address === HM.addr); const py = rv.resolved.find((x) => x.address === PY.addr);
        ok(hm && py && Math.abs(hm.pnl - wantHM) < 1e-9 && Math.abs(py.pnl - wantPY) < 1e-9, `${what}: herumi/mcl pnl ${hm && hm.pnl} (hand ${wantHM}), ethereum/py_ecc pnl ${py && py.pnl} (hand ${wantPY})`);
        const at = hm.attribution; const sum = at.edge + at.slippage + at.timing + at.resolution_surprise + at.fees;
        ok(Math.abs(at.slippage) < 1e-12 && Math.abs(at.edge - (10.513227806149409 * 0.7394 - 7.6641121701439)) < 1e-9 && Math.abs(sum - hm.pnl) < 1e-9, `${what}: herumi/mcl attribution ${JSON.stringify(at)}`);
      }
    } finally { rmrf(dir); }
  });
  rmrf(path.join(L.proj, 'run', 'mine'));
}

// =================================================================================================================
// SECTION repair: finality and the start-of-run repair, in process on the installed copy with a stubbed helper and
// signer (no mock process): an unsettled inflight.json in a prior FINAL run-id (Half B writes there), and a not-sent
// finding on a signer that cannot pin the nonce
// =================================================================================================================
async function repairSection(root) {
  const proj = path.join(root, 'repair-proj'); rmrf(proj); fs.mkdirSync(path.join(proj, 'run'), { recursive: true });
  const bin = path.join(root, 'repair-bin'); installPlanner(bin, null);
  const lib = require(path.join(bin, 'planner', 'lib.cjs')); const X = require(path.join(bin, 'planner', 'exec-core.cjs'));
  const HB = require(path.join(bin, 'planner', 'halfb.cjs')); const WK = require(path.join(bin, 'planner', 'wake.cjs'));
  const cfg = { projectRoot: proj };
  const H0 = '0x' + '11'.repeat(20); const TO = '0x' + '22'.repeat(20); const DATA_HASH = '0x' + 'ab'.repeat(32); const TXH = '0x' + 'cd'.repeat(32); const N = 7;
  const w = (rel, o) => { const p = path.join(proj, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o)); };
  const ex = (rel) => exists(path.join(proj, rel));
  const chain = { latest: N, pending: N, receipt: null, blockTxs: [] };
  const stubCtx = (runId, sub = 'wake') => {
    const c = lib.makeContext({ cfg, sub, runId }); c.holder = () => H0;
    c.helper = async (args) => {
      const [s] = args;
      if (s === 'block') return { json: args[1] === undefined || args[1] === 'latest' ? { number: 1005 } : { number: Number(args[1]), txs_from: chain.blockTxs.filter((t) => t.block === Number(args[1])) } };
      if (s === 'nonce') return { json: { address: H0, latest: chain.latest, pending: chain.pending } };
      if (s === 'receipt') return { json: chain.receipt && chain.receipt.tx_hash === args[1] ? chain.receipt : { found: false, tx_hash: args[1] } };
      throw new Error('unexpected helper call ' + JSON.stringify(args));
    };
    c.signer = async (sub2, file, extra, o) => {
      // the signer prints its broadcast event, then fails waiting for the receipt (exit 5): an unclear outcome
      const ev = { event: 'broadcast', hash: TXH, nonce: N, input_hash: DATA_HASH, from: H0 }; o.onLine(JSON.stringify(ev), ev);
      const last = { error: 'receipt-timeout', detail: 'no receipt within the wait', signed: true, broadcast: true }; o.onLine(JSON.stringify(last), last);
      return { exit: 5, last, stdout: JSON.stringify(ev) + '\n' + JSON.stringify(last) };
    };
    return c;
  };
  const arm = (d) => { w(`run/${d}/base-forecast.json`, { method: 'csv-face-value' }); w(`run/${d}/allocation.json`, { objective: 'max-ev' }); };
  const receiptOf = () => ({ found: true, tx_hash: TXH, status: '0x1', success: true, block_number: 1003, from: H0, to: TO, gas_used: '50000', effective_gas_price: '1000000', l1_fee: '1000' });
  // ---- an unsettled Half B write-ahead in a prior run-id whose wake-status says traded
  const P1 = 'rp-final-1';
  const setP1 = () => {
    rmrf(path.join(proj, 'run', P1)); arm(P1);
    w(`run/${P1}/wake-status.json`, { run_id: P1, status: 'traded', notes: '' });
    w(`run/${P1}/fills.json`, { runs: [{ market: 'x', address: TO, side: 'UP', route: 'simple-buy', status: 'filled', filled: 1, tx_hash: '0x' + '01'.repeat(32) }], retained_legs: [] });
    w(`run/${P1}/inflight.json`, { run_id: P1, from_address: H0, nonce: N, to: TO, calldata_hash: DATA_HASH, chain_id: 10, from_block: 1000, tx_hash: TXH });
    w(`run/${P1}/nonce-attempts.json`, [{ nonce: N, to: TO, calldata_hash: DATA_HASH, from_block: 1000, tx_hash: TXH }]);
  };
  const env = (c, pin) => X.makeEnv(c, { step: 'W', holder: H0, setup: { nonce_pinning: pin } });
  await test('repair: a prior run-id whose wake-status says traded but which holds an unsettled inflight.json (a Half B send) is not final; a Pending nonce blocks every send of the wake and stays', async () => {
    setP1(); const c = stubCtx('rp-today'); Object.assign(chain, { latest: N, pending: N + 1, receipt: null, blockTxs: [] });
    ok(HB.isFinalRun(c, P1) === false, 'isFinalRun true with an inflight.json');
    const rep = await WK.repair(c, env(c, true), []);
    ok(/rp-final-1 nonce 7 is Pending/.test(rep.blockSends || '') && ex(`run/${P1}/inflight.json`) && rep.repaired.length === 0, JSON.stringify(rep));
  });
  await test('repair: the same run-id once its nonce landed: the send is recorded in its exec-sends.json, inflight.json renamed, the run-id re-finalized "repaired by"', async () => {
    setP1(); const c = stubCtx('rp-today'); Object.assign(chain, { latest: N + 1, pending: N + 1, receipt: receiptOf(), blockTxs: [] });
    const rep = await WK.repair(c, env(c, true), []);
    const sends = JSON.parse(fs.readFileSync(path.join(proj, 'run', P1, 'exec-sends.json'), 'utf8'));
    const ws = JSON.parse(fs.readFileSync(path.join(proj, 'run', P1, 'wake-status.json'), 'utf8'));
    ok(!rep.blockSends && sends.length === 1 && sends[0].tx_hash === TXH && !ex(`run/${P1}/inflight.json`) && ex(`run/${P1}/inflight.settled.json`) && ws.status === 'traded' && /repaired by rp-today/.test(ws.notes) && HB.isFinalRun(c, P1), JSON.stringify({ rep, sends, ws }));
  });
  await test('repair: a wake that stopped at its PSM3 ramp (base-forecast.json, no allocation.json yet) with an unsettled inflight.json is still scanned: Pending blocks every send; once landed it is finalized nothing-to-do', async () => {
    const P2 = 'rp-ramp-1'; rmrf(path.join(proj, 'run', P2));
    w(`run/${P2}/base-forecast.json`, { method: 'csv-face-value' }); w(`run/${P2}/wake-status.json`, { run_id: P2, status: 'aborted', notes: 'Half A stopped at ramp: pending' });
    w(`run/${P2}/inflight.json`, { run_id: P2, from_address: H0, nonce: N, to: TO, calldata_hash: DATA_HASH, chain_id: 10, from_block: 1000, tx_hash: TXH });
    w(`run/${P2}/nonce-attempts.json`, [{ nonce: N, to: TO, calldata_hash: DATA_HASH, from_block: 1000, tx_hash: TXH }]);
    const c = stubCtx('rp-today-2'); Object.assign(chain, { latest: N, pending: N + 1, receipt: null, blockTxs: [] });
    const rep = await WK.repair(c, env(c, true), []); ok(/rp-ramp-1 nonce 7 is Pending/.test(rep.blockSends || '') && ex(`run/${P2}/inflight.json`), JSON.stringify(rep));
    Object.assign(chain, { latest: N + 1, pending: N + 1, receipt: receiptOf(), blockTxs: [] });
    const rep2 = await WK.repair(c, env(c, true), []); const ws = JSON.parse(fs.readFileSync(path.join(proj, 'run', P2, 'wake-status.json'), 'utf8'));
    ok(!rep2.blockSends && ws.status === 'nothing-to-do' && /repaired by rp-today-2/.test(ws.notes) && ex(`run/${P2}/inflight.settled.json`), JSON.stringify({ rep2, ws }));
  });
  // ---- a not-sent finding on a signer that cannot pin the nonce
  const R1 = 'rp-notsent-1';
  const sendOnce = async (pin) => {
    rmrf(path.join(proj, 'run', R1)); arm(R1);
    w(`run/${R1}/g-tx/tx-n${N}.json`, { calls: [{ to: TO, data: '0x1234', value: '0' }], gasLimit: '100000' });
    const c = stubCtx(R1, 'exec'); const e = X.makeEnv(c, { step: 'G', holder: H0, setup: { nonce_pinning: pin } });
    const owner = JSON.stringify({ pid: 4242, process_start_time: 'x', host: 'h', started_at: new Date().toISOString(), stage: 'claude-p', run_id: R1 });
    w('run/.lock.deep-r3-trade/owner.txt', owner); w('run/.lock.deep-r3-trade/live-runs.txt', ''); e.lock = { mode: 'wrapper', taken: false, text: owner };
    Object.assign(chain, { latest: N, pending: N, receipt: null, blockTxs: [] });
    let s = null; try { await X.broadcast(e, new X.Book(cfg, R1), { label: 'split (test)', to: TO, signer_input_file: `run/${R1}/g-tx/tx-n${N}.json`, gas_limit: '100000' }, N, DATA_HASH, {}); } catch (x) { s = x; }
    rmrf(path.join(proj, 'run', '.lock.deep-r3-trade'));
    return s;
  };
  await test('not-sent on a signer that cannot pin the nonce: the stop keeps inflight.json (no settlement), keep_aborted; a supervised run-id (no wake-status.json) is therefore not final', async () => {
    const s = await sendOnce(false);
    ok(s && s.cause === 'not-sent' && s.fields.keep_aborted === true && ex(`run/${R1}/inflight.json`) && !ex(`run/${R1}/inflight.settled.json`), JSON.stringify(s && { cause: s.cause, fields: s.fields }));
    ok(HB.isFinalRun(stubCtx('rp-probe'), R1) === false, 'a supervised run-id with the not-sent inflight.json counts as final');
  });
  await test('not-sent, two wakes: each start-of-run repair re-settles nonce n and blocks every send, never finalizing; an operator\'s cancel at n (a foreign transaction) then settles it and the run-id is finalized', async () => {
    w(`run/${R1}/wake-status.json`, { run_id: R1, status: 'aborted', notes: 'not-sent at nonce 7' });
    for (const today of ['rp-wake-2', 'rp-wake-3']) {
      const c = stubCtx(today); Object.assign(chain, { latest: N, pending: N, receipt: null, blockTxs: [] });
      const rep = await WK.repair(c, env(c, false), []);
      ok(/cannot pin the nonce/.test(rep.blockSends || '') && rep.repaired.length === 0 && ex(`run/${R1}/inflight.json`), `${today}: ${JSON.stringify(rep)}`);
    }
    const c = stubCtx('rp-wake-4'); Object.assign(chain, { latest: N + 1, pending: N + 1, receipt: null, blockTxs: [{ block: 1005, hash: '0x' + 'ee'.repeat(32), nonce: N, to: H0, input_keccak256: '0x' + 'ff'.repeat(32) }] });
    const rep = await WK.repair(c, env(c, false), []);
    const ws = JSON.parse(fs.readFileSync(path.join(proj, 'run', R1, 'wake-status.json'), 'utf8'));
    ok(!rep.blockSends && !ex(`run/${R1}/inflight.json`) && ex(`run/${R1}/inflight.settled.json`) && ws.status === 'nothing-to-do' && /repaired by rp-wake-4/.test(ws.notes), JSON.stringify({ rep, ws }));
  });
  await test('not-sent on a signer that CAN pin the nonce: settled at once (inflight.json renamed), the stop does not keep the wake aborted', async () => {
    const s = await sendOnce(true);
    ok(s && s.cause === 'not-sent' && s.fields.keep_aborted === false && !ex(`run/${R1}/inflight.json`) && ex(`run/${R1}/inflight.settled.json`), JSON.stringify(s && { cause: s.cause, fields: s.fields }));
  });
  // ---- the missing fills.json rows (I-setup.md I.2 section 6 (c)): a transaction that landed after its run stopped gets
  // its row appended from the signed calldata, every row already there kept; some but not all of a group landed is half-done
  const EXM = require(path.join(bin, 'planner', 'exec.cjs'));
  const I = iface(); const S = sw(); const k1 = S.kids[1]; const k2 = S.kids[2]; const W18 = (x) => BigInt(x) * 10n ** 18n;
  const txOf = (idx, n0, label, to, data) => ({ idx, nonce_expected: n0 + idx, label, to, value: '0', data, calldata_keccak256: keccakHex(data) });
  const apr = (sp, amt) => I.encodeFunctionData('approve', [sp, amt]);
  const swapOut = (tin, tout, out, max) => I.encodeFunctionData('exactOutputSingle', [[tin, tout, 100, H0, out, max, 0]]);
  const swapIn = (tin, tout, amt, min) => I.encodeFunctionData('exactInputSingle', [[tin, tout, 100, H0, amt, min, 0]]);
  const hashOf = (tag) => '0x' + sha('tx:' + tag);
  const kept = [
    { market: k1.name, address: k1.addr, side: 'Invalid', route: 'buy-and-merge', requested: 1, filled: 1, fill_price: 0, slippage_vs_quote: 0, tx_hash: hashOf('other-run'), status: 'filled', error: 'consumed by run rp-other' },
    { market: k1.repo, address: S.bundles[k1.bundle].middle, side: 'consumed', route: 'split-parent', requested: 2, filled: 2, fill_price: 0, slippage_vs_quote: 0, tx_hash: null, status: 'filled', error: 'consumed by run rp-other' },
  ];
  const rjp = (d, n) => JSON.parse(fs.readFileSync(path.join(proj, 'run', d, n), 'utf8'));
  const lateRun = (d, { plan, state, rows, n, data, to }) => {
    rmrf(path.join(proj, 'run', d)); arm(d);
    if (plan) w(`run/${d}/g-plan.json`, plan);
    if (state) w(`run/${d}/exec-state.json`, state);
    w(`run/${d}/fills.json`, { generated_at: 'x', runs: rows, totals: { spent: 0, spent_unit: 'sUSDS', positions_opened: 0 }, retained_legs: [] });
    w(`run/${d}/wake-status.json`, { run_id: d, status: 'aborted', notes: 'Half A stopped at exec: pending' });
    const h = keccakHex(data); const txh = hashOf(`${d}:${n}`);
    w(`run/${d}/inflight.json`, { run_id: d, from_address: H0, nonce: n, to: lc(to), calldata_hash: h, chain_id: 10, from_block: 1000, tx_hash: txh });
    w(`run/${d}/nonce-attempts.json`, [{ nonce: n, to: lc(to), calldata_hash: h, from_block: 1000, tx_hash: txh }]);
    Object.assign(chain, { latest: n + 1, pending: n + 1, receipt: { ...receiptOf(), tx_hash: txh, to: lc(to) }, blockTxs: [] });
    return txh;
  };
  await test('repair rows: a dual-buy whose last leg landed after its run stopped: that DOWN row is appended once from the signed calldata (the exact-output count; fill_price from amountInMaximum, said in error), every row already there kept (the UP row, the partial placeholder, a cross-run Invalid and a consumed row), the send recorded with its group, 4 of 4 landed, the run-id finalized traded', async () => {
    const d = 'rp-late-dual'; const gid = `dual-buy:${k1.name}`; const n0 = N - 3;
    const txs = [txOf(0, n0, 'approve repo -> SwapRouter02 (inMax UP)', k1.repo, apr(S.A.SWAP, W18(3))), txOf(1, n0, 'buy count UP (exactOutput)', S.A.SWAP, swapOut(k1.repo, k1.up, W18(4), W18(3))),
      txOf(2, n0, 'approve repo -> SwapRouter02 (inMax DOWN)', k1.repo, apr(S.A.SWAP, W18(5))), txOf(3, n0, 'buy count DOWN (exactOutput)', S.A.SWAP, swapOut(k1.repo, k1.down, W18(8), W18(5)))];
    const plan = { run_id: d, built_at: 'b', mint: { M_wei: '0', m_X_wei: {} }, groups: [{ index: 0, id: gid, kind: 'dual-buy', recorded_route: 'dual-buy', market: k1.name, address: k1.addr, allocation_rows: [{ side: 'UP', stake: 3 }, { side: 'DOWN', stake: 5 }], market_refs: { up: k1.up, down: k1.down, repo_token: k1.repo, child_invalid: k1.inv }, txs }] };
    const state = { run_id: d, plan_built_at: 'b', groups: { [gid]: { status: 'stopped', reason: 'pending', txs: [0, 1, 2].map((i) => ({ idx: i, nonce: n0 + i, hash: hashOf(`${d}:${n0 + i}`) })) } }, stop: { kind: 'pending' }, invocations: [] };
    const rows = [{ market: k1.name, address: k1.addr, side: 'UP', route: 'dual-buy', requested: 3, filled: 4, fill_price: 0.7, slippage_vs_quote: 0, tx_hash: hashOf(`${d}:${n0 + 1}`), status: 'filled', error: null },
      { market: k1.name, address: k1.addr, side: 'DOWN', route: 'dual-buy', requested: 5, filled: 0, fill_price: 0, slippage_vs_quote: 0, tx_hash: null, status: 'partial', error: 'half-done group (one transaction per signer call): 3 of 4 transactions landed; pending' }, ...kept];
    const txh = lateRun(d, { plan, state, rows, n: N, data: txs[3].data, to: S.A.SWAP });
    const c = stubCtx('rp-today-4'); const rep = await WK.repair(c, env(c, true), []);
    const F = rjp(d, 'fills.json'); const add = F.runs.slice(rows.length); const ws = rjp(d, 'wake-status.json'); const snd = rjp(d, 'exec-sends.json'); const st = rjp(d, 'exec-state.json');
    ok(F.runs.length === rows.length + 1 && JSON.stringify(F.runs.slice(0, rows.length)) === JSON.stringify(rows), clip(F.runs, 1200));
    ok(add[0].side === 'DOWN' && add[0].route === 'dual-buy' && add[0].tx_hash === txh && add[0].status === 'filled' && add[0].filled === 8 && Math.abs(add[0].fill_price - 5 / 8) < 1e-12 && /recovered by the start-of-run repair of rp-today-4/.test(add[0].error) && /amountInMaximum, a ceiling/.test(add[0].error), clip(add));
    ok(snd.length === 1 && snd[0].tx_hash === txh && snd[0].group === gid && snd[0].idx === 3 && st.groups[gid].txs.length === 4, clip({ snd, st }));
    ok(ws.status === 'traded' && /repaired by rp-today-4/.test(ws.notes) && rep.repaired.some((r) => r.run_id === d) && rep.notes.some((x) => x.startsWith(`run ${d}: 1 missing fills.json row(s) appended`)), JSON.stringify({ ws, rep }));
    const again = EXM.repairPlanRows(c, d, null, 'again'); ok(again.added.length === 0 && again.half_done.length === 0 && rjp(d, 'fills.json').runs.length === rows.length + 1, 'a row appended twice');
  });
  await test('repair rows: a Half B child merge recorded in an earlier run-id (its wake-status traded) that landed after that run stopped: its buy-and-merge row appended from halfb-tx/tx-n<n>.json (the merge amount, exact), every row kept, the run-id re-finalized', async () => {
    const d = 'rp-late-merge'; const data = I.encodeFunctionData('mergePositions', [S.A.sUSDS, k2.addr, W18(2)]);
    const rows = [{ market: k2.name, address: k2.addr, side: 'UP', route: 'simple-buy', requested: 1, filled: 3, fill_price: 0.3, slippage_vs_quote: 0, tx_hash: hashOf('up-' + d), status: 'filled', error: null }, ...kept];
    const txh = lateRun(d, { rows, n: N, data, to: S.A.ROUTER });
    w(`run/${d}/wake-status.json`, { run_id: d, status: 'traded', notes: '' });
    w(`run/${d}/halfb-tx/tx-n${N}.json`, { calls: [{ to: S.A.ROUTER, data, value: '0' }], gasLimit: '300000' });
    const c = stubCtx('rp-today-5'); const rep = await WK.repair(c, env(c, true), []);
    const F = rjp(d, 'fills.json'); const add = F.runs.slice(rows.length);
    ok(JSON.stringify(F.runs.slice(0, rows.length)) === JSON.stringify(rows) && add.length === 1 && add[0].side === 'set' && add[0].route === 'buy-and-merge' && add[0].market === k2.name && add[0].filled === 2 && add[0].tx_hash === txh && /exact/.test(add[0].error), clip(F.runs, 1200));
    ok(rjp(d, 'wake-status.json').status === 'traded' && rep.repaired.some((r) => r.run_id === d), JSON.stringify(rep));
  });
  await test('repair rows: a Half B child redeem that landed after its run stopped: one redeem row per leg from its calldata, fill_price the payout fraction read now (final once reported)', async () => {
    const d = 'rp-late-redeem'; const data = I.encodeFunctionData('redeemPositions', [S.A.sUSDS, k2.addr, [0, 2], [W18(3), W18(1)]]);
    const rows = [...kept];
    const txh = lateRun(d, { rows, n: N, data, to: S.A.ROUTER });
    w(`run/${d}/wake-status.json`, { run_id: d, status: 'traded', notes: '' });
    w(`run/${d}/halfb-tx/tx-n${N}.json`, { calls: [{ to: S.A.ROUTER, data, value: '0' }], gasLimit: '300000' });
    const c = stubCtx('rp-today-5b');
    c.multicall = async (name, reads) => ({ block: 1005, results: reads.map((r) => (r.signature.startsWith('conditionId') ? [k2.cond] : r.signature.startsWith('payoutDenominator') ? ['1000'] : [r.args[1] === '0' ? '1000' : '0'])) });
    const rep = await WK.repair(c, env(c, true), []);
    const add = rjp(d, 'fills.json').runs.slice(rows.length);
    ok(add.length === 2 && add.every((r) => r.route === 'redeem' && r.tx_hash === txh && r.status === 'filled') && add[0].side === 'DOWN' && add[0].filled === 3 && add[0].fill_price === 1 && add[1].side === 'Invalid' && add[1].filled === 1 && add[1].fill_price === 0 && rep.repaired.some((r) => r.run_id === d), clip({ add, rep }, 1200));
  });
  await test('repair rows: a simple-buy whose approve (its first transaction) landed after its run stopped, the group written skipped: no row for an approve; the group is now half-done (1 of 2): named, the run-id left aborted and not final; the next repair names it again and appends nothing', async () => {
    const d = 'rp-late-approve'; const gid = `simple-buy:${k2.name}:UP`;
    const txs = [txOf(0, N, 'approve repo -> SwapRouter02 (stake)', k2.repo, apr(S.A.SWAP, W18(2))), txOf(1, N, 'buy UP (exactInput, min 99.5% of quote)', S.A.SWAP, swapIn(k2.repo, k2.up, W18(2), W18(3)))];
    const plan = { run_id: d, built_at: 'b', mint: { M_wei: '0', m_X_wei: {} }, groups: [{ index: 0, id: gid, kind: 'simple-buy', recorded_route: 'simple-buy', market: k2.name, address: k2.addr, allocation_rows: [{ side: 'UP', stake: 2 }], market_refs: { up: k2.up, down: k2.down, repo_token: k2.repo, child_invalid: k2.inv }, txs }] };
    const state = { run_id: d, plan_built_at: 'b', groups: { [gid]: { status: 'skipped', reason: 'pending', txs: [] } }, stop: { kind: 'pending' }, invocations: [] };
    const rows = [{ market: k2.name, address: k2.addr, side: 'UP', route: 'simple-buy', requested: 2, filled: 0, fill_price: 0, slippage_vs_quote: 0, tx_hash: null, status: 'skipped', error: 'not started: pending' }, ...kept];
    lateRun(d, { plan, state, rows, n: N, data: txs[0].data, to: k2.repo });
    for (const today of ['rp-today-6', 'rp-today-7']) {
      const c = stubCtx(today); const rep = await WK.repair(c, env(c, true), []);
      ok(rep.notes.some((x) => x.startsWith(`run ${d}: group ${gid} (1 of 2 transactions landed) is half-done`)) && !rep.repaired.some((r) => r.run_id === d) && rjp(d, 'wake-status.json').status === 'aborted' && !HB.isFinalRun(c, d) && JSON.stringify(rjp(d, 'fills.json').runs) === JSON.stringify(rows), `${today}: ${JSON.stringify(rep)}`);
    }
  });
}

// =================================================================================================================
// SECTION pipeline: c, d, e, f, g, exec --check, exec, halfb, h, report on the synthetic chain, one run-id
// =================================================================================================================
const RID = 'pt-run-1';
const ctx = { snapG: null };
async function pipelineSection(L) {
  setWorld(L, freshWorld());
  fs.mkdirSync(path.join(L.proj, 'inputs'), { recursive: true }); fs.writeFileSync(path.join(L.proj, 'inputs', 'forecast.csv'), csvText());
  rmrf(path.join(L.proj, 'run', RID)); rmrf(path.join(L.proj, 'run', 'csv'));
  const treeBefore = listTree(L.proj);
  const P = (args, o) => runPlanner(L, args, o);
  const runDir = path.join(L.proj, 'run', RID); const rf = (n) => path.join(runDir, n);
  const T = tb().T.rows;

  await test('c: two rate-limit replies (a plain rpc_error saying "requests per second") are re-run; exit 0, 98 candidates from the body, all tradeable, split 33/33/32', () => {
    const r = P(['c', RID], { scen: { rateLimit: { n: 2, subs: ['multicall'] } } });
    ok(r.code === 0, say(r)); const s = shapeOk('c', r.j); ok(!s, s);
    ok(r.j.source === 'body' && r.j.candidates === 98 && r.j.tradeable === 98 && r.j.bundle_split === '33 / 33 / 32' && r.j.freshness === '196/196 exact' && r.j.diagnostics_failed.length === 0, clip(r.j));
    const det = rj(rf('planner/c.json')); ok(det.tool_calls.helperRetries === 2 && det.tool_calls.signerCalls === 0, JSON.stringify(det.tool_calls));
    ok(det.log.some((l) => /transient failure \(rpc_error\), re-run 1 of 5/.test(l)), 'the re-run is logged');
    const cd = rj(rf('candidates.json')); ok(cd.candidates.every((c, i) => c.address === T[i].address && c.pools.length === 2 && c.pools.every((p) => p.fee_tier === 100 && typeof p.liquidity === 'string')), 'candidate rows');
  });
  await test('c: a run-id is never reused (exit 3 run-id-used); candidates.json and planner/c.json untouched', () => {
    const before = fs.readFileSync(rf('candidates.json')); const det = fs.readFileSync(rf('planner/c.json'));
    const r = P(['c', RID]); ok(r.code === 3 && r.j.stop.cause === 'run-id-used' && r.j.detail === null, say(r));
    ok(fs.readFileSync(rf('candidates.json')).equals(before) && fs.readFileSync(rf('planner/c.json')).equals(det), 'files changed');
  });
  await test('d: no CSV ever provided -> exit 3, D stop no-csv, no base-forecast.json', () => {
    const r = P(['d', RID]); ok(r.code === 3 && r.j.stop.step === 'D' && r.j.stop.cause === 'no-csv' && r.j.stop.status === 'no-csv' && !exists(rf('base-forecast.json')), say(r));
  });
  await test('d --supply without --continue: the step 5 report (matched 4, unmatched 1, no forecast 94 = 2 blank + 92 absent), exit 3 awaiting-continue, nothing stored', () => {
    const r = P(['d', RID, '--supply', 'inputs/forecast.csv']);
    ok(r.code === 3 && r.j.stop.cause === 'awaiting-continue', say(r));
    ok(JSON.stringify(r.j.counts) === JSON.stringify({ matched: 4, unmatched: 1, overwritten: 0, no_forecast: 94 }) && r.j.no_forecast_split.blank_cell === 2 && r.j.no_forecast_split.absent === 92, clip(r.j));
    ok(!exists(path.join(L.proj, 'run', 'csv')) && !exists(rf('base-forecast.json')), 'something was stored');
  });
  await test('d --supply: a path outside the project, an absolute path, a non-.csv file -> exit 2, nothing read', () => {
    for (const a of ['../outside.csv', path.join(L.proj, 'inputs', 'forecast.csv'), 'run/' + RID + '/candidates.json']) { const r = P(['d', RID, '--supply', a]); ok(r.code === 2, `${a}: ${say(r)}`); }
  });
  await test('d --supply --continue: version 1 stored write-once (bytes as supplied), current.json written, base-forecast.json with 4 forecasts', () => {
    const r = P(['d', RID, '--supply', 'inputs/forecast.csv', '--continue', '--notes', 'planner test CSV']);
    ok(r.code === 0, say(r)); const s = shapeOk('d', r.j); ok(!s, s);
    ok(r.j.source === 'new' && r.j.forecasts === 4 && r.j.csv.version === 1 && r.j.csv.reused === false, clip(r.j));
    const v = path.join(L.proj, 'run', 'csv', `originality-v1-${RID}.csv`); ok(exists(v) && fs.readFileSync(v, 'utf8') === csvText(), 'version file');
    const cur = rj(path.join(L.proj, 'run', 'csv', 'current.json')); ok(cur.version === 1 && cur.sha256 === sha(csvText()) && cur.notes === 'planner test CSV' && cur.counts.matched === 4, JSON.stringify(cur));
    const bf = rj(rf('base-forecast.json')); ok(bf.method === 'csv-face-value' && bf.price_seen === false && bf.forecasts.length === 4 && bf.forecasts.every((f) => Math.abs(f.p[0] + f.p[1] - 1) < 1e-12 && f.p[2] === 0), 'base-forecast');
    ok(!/pool|liquidity|"price"/i.test(JSON.stringify(bf)), 'a price-like key in base-forecast.json');
  });
  await test('d: the stored CSV path reads version 1 silently (reused, counts equal current.json, nothing hashed)', () => {
    const r = P(['d', RID]); ok(r.code === 0 && r.j.source === 'stored' && r.j.csv.reused === true && r.j.csv.version === 1 && r.j.csv.counts_differ === null && /not hashed/.test(r.j.csv.hash_checked), say(r));
  });
  await test('e: 4 identity blends, all priced from candidates.json, no fetch', () => {
    const r = P(['e', RID]); ok(r.code === 0, say(r)); const s = shapeOk('e', r.j); ok(!s, s);
    ok(r.j.blends === 4 && r.j.priced_from_candidates === 4 && r.j.null_price === 0 && r.j.fetched === false, clip(r.j));
    const b = rj(rf('blended.json')); ok(b.method === 'identity' && b.blends.every((x) => x.w === 1 && JSON.stringify(x.blended) === JSON.stringify(x.own)), 'identity');
  });
  let A = null;
  await test('f: exit 0; rows on exactly the designed markets (set-sell, pair, simple UP, complex UP, simple DOWN); the bankroll binds; every check passed; the signer never run', () => {
    const r = P(['f', RID]); ok(r.code === 0, say(r)); const s = shapeOk('f', r.j); ok(!s, s);
    A = rj(rf('allocation.json'));
    const by = {}; A.positions.forEach((p) => { const i = T.findIndex((t) => t.address === p.address); (by[i] = by[i] || []).push(p.side); });
    const got = Object.fromEntries(Object.entries(by).map(([i, sides]) => [i, sides.sort().join(',')]));
    const exp = { 0: 'set', 1: 'DOWN,UP', 2: 'UP', 40: 'UP', 70: 'DOWN' };
    ok(JSON.stringify(got) === JSON.stringify(exp), `rows ${JSON.stringify(got)}, expected ${JSON.stringify(exp)}`);
    ok(r.j.binds === 'bankroll' && r.j.staked_M === 10 && r.j.bankroll === 10 && r.j.checks.passed === r.j.checks.total && r.j.ranges.from_body === 196 && r.j.drift_markets === 0 && r.j.model_gap_max === 0, clip(r.j, 1500));
    ok(rj(rf('planner/f.json')).tool_calls.signerCalls === 0, 'the signer was run by f');
    ok(exists(rf('f-print.md')) && !fs.readdirSync(path.join(runDir, 'f-tmp')).length, 'f-print.md written, f-tmp emptied');
  });
  await test('g: exit 0; mints parent + A, B, C; one group per route; helper encode equals ethers; the signer\'s check (only) on every file; end state equals the prediction; audit passed', () => {
    const r = P(['g', RID]); ok(r.code === 0, say(r)); const s = shapeOk('g', r.j); ok(!s, s);
    const kinds = Object.entries(r.j.by_kind).sort().map(([k, v]) => `${k}:${v}`).join(' ');
    ok(kinds === 'complex-buy:1 dual-buy:1 mint:4 set-sell:1 simple-buy:2', kinds);
    ok(r.j.transactions === 28 && r.j.mint.parent_split === true && r.j.mint.middles.join() === 'A,B,C' && r.j.verify.end_state.differ === 0 && r.j.audit.failures === 0 && r.j.drift.pools_moved === 0 && r.j.indep.ran === false, clip(r.j, 1500));
    ok(r.calls.signer.check === 28 && !r.calls.signer.send && !r.calls.signer.simulate, JSON.stringify(r.calls.signer));
    ok(fs.readdirSync(path.join(runDir, 'g-tx')).length === 28 && exists(rf('gate-print.md')), 'g-tx files and gate-print.md');
    const plan = rj(rf('g-plan.json')); const txs = plan.groups.flatMap((g) => g.txs);
    ok(txs.every((t, k) => t.nonce_expected === 5 + k && Number(t.gas_limit) === limitOf(t.gas_used, t.max_used_gas)), 'every gas_limit is ceil(maxUsedGas x 1.2) and nonces run from the holder\'s');
  });
  ctx.snapG = snapshot(L, RID);
  await test('exec --check: sends nothing (no signer send, the nonce unchanged, no fills.json, inflight.json, nonce-attempts.json or lock), every file checked, the plan simulated', () => {
    const n0 = getWorld(L).nonce;
    const r = P(['exec', RID, '--check']); ok(r.code === 0 && r.j.outcome === 'check-passed', say(r)); const s = shapeOk('exec', r.j); ok(!s, s);
    ok(!r.calls.signer.send && r.calls.signer.check === 28 && getWorld(L).nonce === n0, JSON.stringify(r.calls.signer));
    for (const n of ['fills.json', 'inflight.json', 'nonce-attempts.json']) ok(!exists(rf(n)), `${n} written`);
    ok(!exists(lockDir(L.proj)) && r.j.check.data_files.checked === 28 && r.j.check.data_files.bad === 0 && r.j.check.simulation.clean === true && r.j.check.first_tx && r.j.check.first_tx.fresh_gas_used, clip(r.j.check, 1200));
  });
  await test('exec: the whole plan sent in the supervised lock (taken and released); every group\'s balance effects exactly as simulated; the complex-buy pair rebuilt with the realised proceeds', () => {
    const n0 = getWorld(L).nonce;
    const r = P(['exec', RID]); ok(r.code === 0 && r.j.outcome === 'complete' && r.j.mode === 'supervised', say(r)); const s = shapeOk('exec', r.j); ok(!s, s);
    ok(r.j.transactions_sent === 28 && r.calls.signer.send === 28 && getWorld(L).nonce === n0 + 28 && !exists(lockDir(L.proj)), JSON.stringify({ sent: r.j.transactions_sent, signer: r.calls.signer }));
    const st = rj(rf('exec-state.json')); ok(Object.values(st.groups).every((g) => g.status === 'done' && (g.effects_diffs || []).length === 0), 'a group not done or with effects that differ');
    ok(rj(rf('exec-sends.json')).filter((x) => x.rebuilt).length === 2, 'the complex-buy pair was not rebuilt');
    const F = rj(rf('fills.json')); ok(F.totals.positions_opened === 6 && F.runs.filter((x) => x.side === 'mint').length === 4 && F.runs.every((x) => x.status === 'filled'), JSON.stringify(F.totals));
    ok(Object.keys(F).sort().join() === 'generated_at,retained_legs,runs,totals' && F.retained_legs.every((l) => /sources: /.test(l.why)), 'fills.json keys or retained_legs');
    ok(!exists(rf('inflight.json')) && exists(rf('inflight.settled.json')) && rj(rf('nonce-attempts.json')).length === 28, 'write-ahead records');
  });
  await test('gas pre-send rule, at send time: every approve (refund-free, limit 55,200) and every Router split passed the three-part check; the old 1.5x form would have refused every approve', () => {
    const sends = rj(path.join(L.mock, 'calls.json')).sends; ok(sends.length === 28, `sends recorded ${sends.length}`);
    const approves = sends.filter((x) => x.selector === '0x095ea7b3'); const splits = sends.filter((x) => x.selector === iface().getFunction('splitPosition').selector);
    ok(approves.length >= 10 && approves.every((x) => Number(x.gas_limit) === 55200 && 46000 * 1.5 > 55200), `approves ${approves.length}: ${approves.map((x) => x.gas_limit).join(',')}`);
    ok(splits.length === 6 && splits.every((x) => Number(x.gas_limit) >= 885190), `splits ${splits.map((x) => x.gas_limit).join(',')}`);
  });
  await test('exec: a second run after completion sends nothing (exit 0 complete)', () => {
    const r = P(['exec', RID]); ok(r.code === 0 && r.j.outcome === 'complete' && !r.calls.signer.send, say(r));
  });
  await test('halfb (supervised, no --send): prints the first level with work, the middle-C merge of the leftover repo tokens (34 transactions), sends nothing', () => {
    const r = P(['halfb', RID]); ok(r.code === 0 && r.j.mode === 'supervised-print', say(r)); const s = shapeOk('halfb', r.j); ok(!s, s);
    const a = r.j.actionable; ok(a.length === 1 && a[0].level === 2 && a[0].groups.length === 1 && a[0].groups[0].id === 'middle-merge:C' && a[0].groups[0].txs === 34 && a[0].simulation_clean === true, clip(a));
    ok(!r.calls.signer.send && exists(rf('halfb-plan.json')) && exists(rf('halfb-print.md')), 'a send, or no print');
    ok(JSON.stringify(r.j.artifacts.slice(0, 3)) === JSON.stringify([`run/${RID}/halfb-sim-l2-main.json`, `run/${RID}/halfb-plan.json`, `run/${RID}/halfb-print.md`]) && r.j.artifacts[3] === `run/${RID}/halfb-tx/ (34 files)`, clip(r.j.artifacts));
  });
  await test('h: nothing settled -> no review.json, the line "<run-id>: nothing settled yet"', () => {
    const r = P(['h', RID]); ok(r.code === 0 && r.j.result === 'nothing settled yet' && r.j.line === `${RID}: nothing settled yet` && !exists(rf('review.json')), say(r));
    const s = shapeOk('h', r.j); ok(!s, s);
  });
  await test('halfb redeem (mocks only, untested live): a child resolves at 60/40; the print shows its redeem; --send sends exactly that level and the payout lands', () => {
    const w = getWorld(L); const k2 = sw().kids[2]; w.payouts[lc(k2.cond)] = { den: '100', nums: ['40', '60', '0'] }; setWorld(L, w);
    const up0 = getB(w, k2.up); const repo0 = getB(w, k2.repo);
    const r = P(['halfb', RID]); ok(r.code === 0 && r.j.actionable[0].level === 1 && r.j.actionable[0].groups[0].id === `child-redeem:${k2.name}`, say(r));
    const r2 = P(['halfb', RID, '--send']); ok(r2.code === 0 && r2.j.sent.length === 1 && r2.j.sent[0].id === `child-redeem:${k2.name}` && r2.calls.signer.send === 2, say(r2));
    const w2 = getWorld(L); ok(getB(w2, k2.up) === 0n && getB(w2, k2.repo) === repo0 + up0 * 60n / 100n && !exists(lockDir(L.proj)), `UP ${getB(w2, k2.up)}, repo ${getB(w2, k2.repo)} vs ${repo0} + ${up0 * 60n / 100n}`);
    const F = rj(rf('fills.json')); ok(F.runs.some((x) => x.route === 'redeem' && x.tx_hash), 'no redeem row in fills.json');
  });
  await test('h: the settled child is scored (review.json, calibration_update null, lessons []); a re-run with nothing newly settled leaves it as it is', () => {
    const r = P(['h', RID]); ok(r.code === 0 && r.j.result === 'review.json written' && r.j.settled === 1 && r.j.review_written === true, say(r));
    const rv = rj(rf('review.json')); const row = rv.resolved[0];
    ok(rv.calibration_update === null && Array.isArray(rv.lessons) && rv.lessons.length === 0 && row.address === T[2].address && Math.abs(row.brier_own) < 1e-12, clip(row));
    const r2 = P(['h', RID]); ok(r2.code === 0 && r2.j.result === 'unchanged', say(r2));
  });
  await test('report: report.md from the artifacts; no wake-status.json outside a wake', () => {
    const r = P(['report', RID]); ok(r.code === 0 && r.j.report === `run/${RID}/report.md` && r.j.wake_status === null && exists(rf('report.md')) && !exists(rf('wake-status.json')), say(r));
    const s = shapeOk('report', r.j); ok(!s, s);
  });
  await test('pipeline: every write landed under run/<run-id>/ or the CSV store; nothing else in the project changed; no lock left', () => {
    const after = listTree(L.proj).filter((p) => !p.startsWith(`run/${RID}/`) && !p.startsWith('run/csv/'));
    const before = treeBefore.filter((p) => !p.startsWith(`run/${RID}/`) && !p.startsWith('run/csv/'));
    ok(JSON.stringify(after) === JSON.stringify(before), `added ${after.filter((p) => !before.includes(p)).join(', ')}; removed ${before.filter((p) => !after.includes(p)).join(', ')}`);
  });
  await test('halfb on a run-id with no fills (cross-run): the print goes to the record run; artifacts name run/<record_run>/halfb-print.md and halfb-plan.json and nothing in the invoked run-id\'s folder', () => {
    const R2 = 'pt-run-2'; rmrf(path.join(L.proj, 'run', R2));
    const r = P(['halfb', R2]); ok(r.code === 0 && r.j.record_run === RID && r.j.mode === 'supervised-print', say(r));
    ok(r.j.artifacts.includes(`run/${RID}/halfb-print.md`) && r.j.artifacts.includes(`run/${RID}/halfb-plan.json`) && !r.j.artifacts.some((a) => a.startsWith(`run/${R2}/`)), clip(r.j.artifacts));
    const pr = fs.readFileSync(rf('halfb-print.md'), 'utf8'); ok(pr.includes(`invoked as run ${R2}; written in run/${RID}/`) && rj(rf('halfb-plan.json')).invoked_as === R2, pr.slice(0, 300));
    rmrf(path.join(L.proj, 'run', R2));
  });
}

// =================================================================================================================
// SECTION c-variants: C's stops and its onchain rebuild
// =================================================================================================================
async function cVariantsSection(L) {
  setWorld(L, freshWorld());
  const P = (args, o) => runPlanner(L, args, o);
  const cand = (rid) => path.join(L.proj, 'run', rid, 'candidates.json');
  let bodyRows = null;
  await test('c stop test: an error body saying the upstream market list does not match -> exit 3 upstream-set-changed, aborted, nothing built', () => {
    const r = P(['c', 'cv-stop-1'], { scen: { dataStatus: 500, bodyText: JSON.stringify({ error: 'The upstream Market LIST does not match the configured set' }) } });
    ok(r.code === 3 && r.j.stop.cause === 'upstream-set-changed' && r.j.stop.status === 'aborted' && !exists(cand('cv-stop-1')), say(r));
  });
  await test('c 2.1: a body with 97 markets -> exit 3, notes "C step 2.1: markets.length 97 != 98", before any chain read', () => {
    const r = P(['c', 'cv-stop-2'], { scen: { bodyTransform: 'drop-last-market' } });
    ok(r.code === 3 && r.j.stop.cause === 'identity-check-failed' && /C step 2\.1: markets\.length 97 != 98/.test(r.j.stop.notes) && !exists(cand('cv-stop-2')), say(r));
    ok(!fs.readdirSync(path.join(L.proj, 'run', 'cv-stop-2')).some((f) => /^reads/.test(f)) && !r.calls.mc, 'a chain read happened');
  });
  await test('c 2.7: a wrapped token that differs from wrappedOutcome onchain -> the body is refused and the rows are rebuilt onchain (exit 0); the same rows, prices within 5%', () => {
    const r0 = P(['c', 'cv-body']); ok(r0.code === 0, say(r0)); bodyRows = rj(cand('cv-body')).candidates;
    const r = P(['c', 'cv-rb-1'], { scen: { bodyTransform: 'wrong-wrapped' } });
    ok(r.code === 0 && r.j.source === 'onchain-rebuild' && /check 2\.7/.test(r.j.body_refused), say(r));
    const rb = rj(cand('cv-rb-1')).candidates; let worst = 0;
    ok(rb.length === 98 && rb.every((c, i) => c.address === bodyRows[i].address && c.tradeable === bodyRows[i].tradeable && c.pools.length === 2), 'rows differ');
    rb.forEach((c, i) => c.pools.forEach((p, k) => { worst = Math.max(worst, Math.abs(p.price - bodyRows[i].pools[k].price) / bodyRows[i].pools[k].price); }));
    ok(worst < 0.05, `worst relative price difference ${worst}`);
  });
  await test('c: an HTTP 500 error body, and no HTTP response at all -> the onchain rebuild (exit 0)', () => {
    const a = P(['c', 'cv-rb-2'], { scen: { dataStatus: 500, bodyText: JSON.stringify({ error: 'Pool query failed' }) } });
    const b = P(['c', 'cv-rb-3'], { scen: { dataUnreachable: true } });
    ok(a.code === 0 && a.j.source === 'onchain-rebuild' && /HTTP 500/.test(a.j.body_refused), say(a));
    ok(b.code === 0 && b.j.source === 'onchain-rebuild' && /data_unreachable/.test(b.j.body_refused), say(b));
  });
  await test('c: a reads file the chain answers with a revert -> exit 3 onchain-reads-failed, never re-run', () => {
    const r = P(['c', 'cv-rv-1'], { scen: { revertOn: 'reads-b1.json' } });
    ok(r.code === 3 && r.j.stop.cause === 'onchain-reads-failed' && /reads-b1\.json/.test(r.j.stop.notes) && rj(path.join(L.proj, 'run', 'cv-rv-1', 'planner', 'c.json')).tool_calls.helperRetries === 0, say(r));
  });
  await test('c: a transport failure that outlasts the 5 re-runs -> exit 5, C stop rpc_unreachable, status aborted, no candidates.json', () => {
    const r = P(['c', 'cv-tr-1'], { scen: { transportAlways: true } });
    const det = rj(path.join(L.proj, 'run', 'cv-tr-1', 'planner', 'c.json'));
    ok(r.code === 5 && r.j.stop.step === 'C' && r.j.stop.cause === 'rpc_unreachable' && r.j.stop.status === 'aborted' && det.tool_calls.helperRetries === 5 && r.calls.mc === 6 && !exists(cand('cv-tr-1')), say(r));
  });
}

// =================================================================================================================
// SECTION g-safety: G's safety refusals (exit 4) on the pipeline's plan
// =================================================================================================================
async function gSafetySection(L) {
  if (!ctx.snapG) { await test('g-safety: the pipeline\'s plan', () => skip('the pipeline did not build a plan')); return; }
  const P = (args, o) => runPlanner(L, args, o);
  const runDir = path.join(L.proj, 'run', RID);
  const noPlan = () => !exists(path.join(runDir, 'g-plan.json')) && (!exists(path.join(runDir, 'g-tx')) || fs.readdirSync(path.join(runDir, 'g-tx')).length === 0);
  await test('g: a pending transaction of the holder (latest != pending) -> exit 4 pending-transaction, the earlier plan removed, no new one', () => {
    restore(L, RID, ctx.snapG); const w = getWorld(L); w.pendingTx = { nonce: w.nonce }; setWorld(L, w);
    const r = P(['g', RID]); ok(r.code === 4 && r.j.stop.cause === 'pending-transaction' && noPlan() && !r.calls.signer.check, say(r));
  });
  await test('g: the holder nonce moves between G\'s read and its verify -> exit 4 nonce-moved, no plan, no g-tx file', () => {
    restore(L, RID, ctx.snapG);
    const r = P(['g', RID], { scen: { nonceBump: { after: 1 } } }); ok(r.code === 4 && r.j.stop.cause === 'nonce-moved' && noPlan(), say(r));
  });
  await test('g: the helper encodes one calldata differently from ethers -> exit 4 hash-mismatch, no plan, the signer never asked', () => {
    restore(L, RID, ctx.snapG);
    const r = P(['g', RID], { scen: { encodeCorrupt: 7 } }); ok(r.code === 4 && r.j.stop.cause === 'hash-mismatch' && noPlan() && !r.calls.signer.check, say(r));
  });
  await test('g: the signer\'s check refuses one file -> exit 3 allowlist-refused, no plan, never a send', () => {
    restore(L, RID, ctx.snapG);
    const r = P(['g', RID], { scen: { refuseCheckFile: 'tx-006.json' } }); ok(r.code === 3 && r.j.stop.cause === 'allowlist-refused' && /tx 6/.test(r.j.stop.notes) && noPlan() && !r.calls.signer.send, say(r));
  });
  restore(L, RID, ctx.snapG);
}

// =================================================================================================================
// SECTION exec-safety: the executor's refusals on the pipeline's plan (each from the same snapshot)
// =================================================================================================================
async function execSafetySection(L) {
  if (!ctx.snapG) { await test('exec-safety: the pipeline\'s plan', () => skip('the pipeline did not build a plan')); return; }
  const P = (args, o) => runPlanner(L, args, o);
  const rf = (n) => path.join(L.proj, 'run', RID, n);
  const nothingWritten = () => ['fills.json', 'inflight.json', 'nonce-attempts.json'].every((n) => !exists(rf(n)));
  await test('exec: the holder nonce moved (a send the plan did not expect) -> exit 4 nonce-moved, nothing sent, nothing written, the lock released', () => {
    restore(L, RID, ctx.snapG); const w = getWorld(L); w.nonce += 1; setWorld(L, w);
    const r = P(['exec', RID]); ok(r.code === 4 && r.j.stop.cause === 'nonce-moved' && !r.calls.signer.send && nothingWritten() && !exists(lockDir(L.proj)), say(r));
  });
  await test('exec: a pending transaction of the holder -> exit 4 pending-transaction, nothing sent', () => {
    restore(L, RID, ctx.snapG); const w = getWorld(L); w.pendingTx = { nonce: w.nonce }; setWorld(L, w);
    const r = P(['exec', RID]); ok(r.code === 4 && r.j.stop.cause === 'pending-transaction' && !r.calls.signer.send && nothingWritten(), say(r));
  });
  await test('exec --check: a pending transaction is reported the same way (exit 4), and --check never sends', () => {
    restore(L, RID, ctx.snapG); const w = getWorld(L); w.pendingTx = { nonce: w.nonce }; setWorld(L, w);
    const r = P(['exec', RID, '--check']); ok(r.code === 4 && r.j.stop.cause === 'pending-transaction' && !r.calls.signer.send, say(r));
  });
  await test('exec: the signer\'s fresh gas_used 15% above the plan on the first (refund-free) approve -> the pre-send gas check stops (exit 3 gas-limit, part a) before any send', () => {
    restore(L, RID, ctx.snapG);
    const r = P(['exec', RID], { scen: { gasFactor: 1.15 } }); ok(r.code === 3 && r.j.stop.cause === 'gas-limit' && /\(a\)/.test(r.j.stop.notes) && !r.calls.signer.send, say(r));
  });
  await test('exec: ETH exactly at the 0.002 reserve -> the first group is not started (exit 3 affordability-skip); every row written skipped; no write-ahead record', () => {
    restore(L, RID, ctx.snapG); const w = getWorld(L); w.eth = '2000000000000000'; setWorld(L, w);
    const r = P(['exec', RID]); ok(r.code === 3 && r.j.stop.cause === 'affordability-skip' && !r.calls.signer.send, say(r));
    const F = rj(rf('fills.json')); ok(F.runs.length === 10 && F.runs.every((x) => x.status === 'skipped' && /affordability/.test(x.error)) && !exists(rf('inflight.json')) && !exists(rf('nonce-attempts.json')), clip(F.runs.map((x) => x.status)));
  });
  {
    const T = tb().T.rows;
    const grpOf = (i) => rj(rf('g-plan.json')).groups.find((g) => g.market_refs && lc(g.address) === lc(T[i].address));
    const movePool = (w, pool, T0, f) => { const d = w.pools[lc(pool)]; const s = Number(BigInt(d.sqrt)); const k = Math.sqrt(f); d.sqrt = BigInt(Math.floor(T0 ? s * k : s / k)).toString(); };
    const movedDiffs = () => Object.entries(rj(rf('exec-state.json')).groups).flatMap(([id, g]) => (g.effects_diffs || []).filter((x) => x.kind === 'pool moved since build').map((x) => ({ id, ...x })));
    await test('exec: third parties buy UP (x1.003) and sell DOWN (x0.995) on a simple-buy market after G: fewer UP than the build quote, above the floor: the run completes and the difference is reported ("pool moved since build", report.md)', () => {
      restore(L, RID, ctx.snapG); const g = grpOf(2); ok(g && g.kind === 'simple-buy', 'group of market 2: ' + (g && g.kind));
      const w = getWorld(L); movePool(w, g.market_refs.pools.UP, g.market_refs.token0_is_outcome.UP, 1.003); movePool(w, g.market_refs.pools.DOWN, g.market_refs.token0_is_outcome.DOWN, 0.995); setWorld(L, w);
      const r = P(['exec', RID]); ok(r.code === 0 && r.j.outcome === 'complete' && r.j.transactions_sent === 28, say(r));
      const mv = movedDiffs(); ok(mv.length === 1 && mv[0].id === g.id && mv[0].token === 'up' && BigInt(mv[0].diff) < 0n && BigInt(mv[0].got) >= BigInt(g.txs[1].swap.amountOutMinimum), clip(mv));
      const rp = P(['report', RID]); ok(rp.code === 0 && /## Pool moved since build \(1 balance/.test(fs.readFileSync(rf('report.md'), 'utf8')), say(rp));
    });
    await test('exec: a third party sells UP (x0.997) on the dual-buy market after G (the pair binds the market budget, so only a cheaper leg stays feasible): the exact-output legs land, the repo spent differs from the build quote and is reported, never a stop', () => {
      restore(L, RID, ctx.snapG); const g = grpOf(1); ok(g && g.kind === 'dual-buy', 'group of market 1: ' + (g && g.kind));
      const w = getWorld(L); movePool(w, g.market_refs.pools.UP, g.market_refs.token0_is_outcome.UP, 0.997); setWorld(L, w);
      const r = P(['exec', RID]); ok(r.code === 0 && r.j.outcome === 'complete', say(r));
      const mv = movedDiffs(); ok(mv.length === 1 && mv[0].id === g.id && mv[0].token === 'repo' && BigInt(mv[0].diff) > 0n, clip(mv));
      const st = rj(rf('exec-state.json')).groups[g.id]; ok(!(st.effects_diffs || []).some((x) => x.kind === 'exact'), 'an exact delta (UP or DOWN count) differed');
    });
  }
  await test('exec --max-groups 1: sends the parent mint only and pauses; the next invocation resumes from the chain and completes', () => {
    restore(L, RID, ctx.snapG);
    const r = P(['exec', RID, '--max-groups', '1']); ok(r.code === 0 && r.j.outcome === 'paused-after-max-groups' && r.j.groups_done === 1 && r.calls.signer.send === 2, say(r));
    const r2 = P(['exec', RID]); ok(r2.code === 0 && r2.j.outcome === 'complete' && r2.j.transactions_sent === 28 && r2.calls.signer.send === 26, say(r2));
  });
  await test('exec --max-groups 1: the first send throttled before signing (no broadcast line) is re-run, never retired or taken for a revert; one attempt per nonce', () => {
    restore(L, RID, ctx.snapG);
    const r = P(['exec', RID, '--max-groups', '1'], { scen: { signerRateLimit: { n: 1, subs: ['send'] } } });
    const att = exists(rf('nonce-attempts.json')) ? rj(rf('nonce-attempts.json')) : [];
    ok(r.code === 0 && r.j.outcome === 'paused-after-max-groups' && r.j.groups_done === 1 && r.calls.signer.send === 3 && r.calls.sends.length === 2, say(r));
    ok(att.length === 2 && !att.some((a) => a.status === 'not_broadcast') && att.every((a) => a.tx_hash), clip(att));
  });
  await test('exec: the signer\'s pre-send simulate still throttled after the re-runs -> exit 5 transport (never stale-simulation), nothing sent', () => {
    restore(L, RID, ctx.snapG);
    const r = P(['exec', RID], { scen: { signerRateLimit: { n: 50, subs: ['simulate'] } } });
    ok(r.code === 5 && r.j.stop && r.j.stop.cause === 'transport' && !r.calls.signer.send && r.calls.signer.simulate === 10, say(r));
  });
  await test('exec: the signer\'s pre-send simulate answers rpc-transport (a network error), rpc-http 503 or a plain rpc-error with no "simulated":true -> exit 5 transport, never stale-simulation, nothing sent; a -38xxx refusal of eth_simulateV1 -> exit 3 tool-failure', () => {
    for (const [what, sse, cause, code] of [
      ['rpc-transport', { error: 'rpc-transport', detail: 'network error or timeout talking to the pinned RPC' }, 'transport', 5],
      ['rpc-http 503', { error: 'rpc-http', detail: 'HTTP 503 from the pinned RPC' }, 'transport', 5],
      ['rpc-error', { error: 'rpc-error', detail: 'header not found', rpc_code: -32000 }, 'transport', 5],
      ['-38014', { error: 'rpc-error', detail: 'block gas limit reached', rpc_code: -38014 }, 'tool-failure', 3]]) {
      restore(L, RID, ctx.snapG);
      const r = P(['exec', RID], { scen: { signerSimError: sse } });
      ok(r.code === code && r.j.stop && r.j.stop.cause === cause && !r.calls.signer.send && !r.calls.sends.length, `${what}: ${say(r)}`);
    }
  });
  await test('signer mode (b) (signer_mode executor-session-key): supervised exec, exec --check and halfb --send -> exit 3 unsupported-signer-mode before any signer call (no check, simulate or send; no helper or signer process at all), the nonce unchanged, no lock, no write-ahead record, no row', () => {
    const sp = path.join(L.proj, 'run', 'setup.deep-r3-trade.json'); ok(!exists(sp), 'the pipeline project already holds a setup record');
    try {
      wj(sp, { signer_mode: 'executor-session-key' });
      for (const args of [['exec', RID], ['exec', RID, '--check'], ['halfb', RID, '--send']]) {
        restore(L, RID, ctx.snapG); const n0 = getWorld(L).nonce;
        const r = P(args);
        ok(r.code === 3 && r.j.stop && r.j.stop.cause === 'unsupported-signer-mode' && /a TradeExecutor wallet works in supervised mode/.test(r.j.stop.notes), `${args.join(' ')}: ${say(r)}`);
        ok(!exists(path.join(L.mock, 'calls.json')) && !Object.keys(r.calls.signer).length && !r.calls.sends.length && getWorld(L).nonce === n0, `${args.join(' ')}: a helper or signer process ran: ${clip(r.calls)}`);
        ok(!exists(lockDir(L.proj)) && nothingWritten() && !exists(rf('exec-sends.json')), `${args.join(' ')}: a lock or a record was left`);
      }
    } finally { rmrf(sp); }
  });
  restore(L, RID, ctx.snapG);
}

// =================================================================================================================
// SECTION boundary: a resolved middle refuses no plan by itself (C-select.md step 4, G section 3)
// =================================================================================================================
async function boundarySection(root) {
  const L = makeLayout(path.join(root, 'boundary'));
  const TB = tb(); const S = sw(); const T = TB.T.rows;
  const nA = TB.T.bundles[0].nRepos; // middle A: 33 repos + Invalid
  const midA = (w) => { w.payouts[lc(TB.CONDITIONS.A)] = { den: '4', nums: Array.from({ length: nA + 1 }, (_, k) => (k <= 3 ? '1' : '0')) }; return w; }; // selects slots 0..3
  setWorld(L, midA(freshWorld()));
  fs.mkdirSync(path.join(L.proj, 'inputs'), { recursive: true }); fs.writeFileSync(path.join(L.proj, 'inputs', 'forecast.csv'), csvText());
  const P = (args, o) => runPlanner(L, args, o);
  const rf = (rid, n) => path.join(L.proj, 'run', rid, n);
  const R1 = 'pb-mid-a'; let snapG = null;
  await test('boundary: middle A resolved (slots 0..3 selected): C keeps the selected children of A tradeable and the other 29 not; F, G build the plan; G records the middle\'s plan-time reading for mint-middle-A', () => {
    const c = P(['c', R1]); ok(c.code === 0 && c.j.tradeable === 69 && c.j.reason_counts.middle_settled === 29, say(c));
    const d = P(['d', R1, '--supply', 'inputs/forecast.csv', '--continue']); ok(d.code === 0, say(d));
    for (const s of ['e', 'f']) { const r = P([s, R1]); ok(r.code === 0, `${s}: ${say(r)}`); }
    const g = P(['g', R1]); ok(g.code === 0 && g.j.mint.middles.join() === 'A,B,C' && g.j.groups === 9, say(g));
    const plan = rj(rf(R1, 'g-plan.json')); const mA = plan.groups.find((x) => x.id === 'mint-middle-A');
    ok(mA.pre_send_checks && mA.pre_send_checks.level === 'A' && mA.pre_send_checks.payoutDenominator_at_build === '4' && plan.groups.find((x) => x.id === 'mint-middle-B').pre_send_checks.payoutDenominator_at_build === '0', clip(mA.pre_send_checks));
    snapG = snapshot(L, R1);
  });
  await test('boundary: exec sends the whole plan: the bundle-B and bundle-C groups and the selected bundle-A children trade; every mint group done (no partial mint)', () => {
    if (!snapG) skip('no plan');
    const r = P(['exec', R1]); ok(r.code === 0 && r.j.outcome === 'complete' && r.j.transactions_sent === 28, say(r));
    const st = rj(rf(R1, 'exec-state.json')).groups; const ids = Object.keys(st);
    ok(['mint-parent', 'mint-middle-A', 'mint-middle-B', 'mint-middle-C'].every((id) => st[id].status === 'done') && ids.every((id) => st[id].status === 'done'), JSON.stringify(st));
    const traded = new Set(rj(rf(R1, 'fills.json')).runs.filter((x) => x.status === 'filled' && x.side !== 'mint').map((x) => T.findIndex((t) => t.address === lc(x.address))));
    ok([0, 1, 2, 40, 70].every((i) => traded.has(i)), JSON.stringify([...traded]));
  });
  await test('boundary: middle B resolves between G and exec (a flip since the plan): the whole-plan boundary pass stops the run before the parent mint is sent (supervised: exit 3 stale-boundary, nothing sent, nothing written)', () => {
    if (!snapG) skip('no plan');
    restore(L, R1, snapG); const w = getWorld(L); w.payouts[lc(TB.CONDITIONS.B)] = { den: '1', nums: ['1'] }; setWorld(L, w);
    const r = P(['exec', R1]); ok(r.code === 3 && r.j.stop.cause === 'stale-boundary' && /mint-middle-B: payoutDenominator 1, 0 at build/.test(r.j.stop.notes) && !r.calls.signer.send && !exists(rf(R1, 'fills.json')) && !exists(rf(R1, 'nonce-attempts.json')), say(r));
    // inside the wrapper, before the run's first broadcast: the same stop asks the wake's once-only re-plan
    setupRecord(L.proj); wrapperLock(L.proj, R1);
    try { const r2 = P(['exec', R1]); ok(r2.code === 3 && r2.j.stop.cause === 'stale-boundary' && r2.j.replan_due === true && r2.j.first_failed_group === 'mint-middle-B' && !r2.calls.signer.send, say(r2)); } finally { rmrf(lockDir(L.proj)); }
  });
  await test('boundary: an M = 0 plan on held repo tokens alone (no sUSDS), middle A resolved: no mint group, the trade groups send', () => {
    const w = midA(freshWorld({ susds: '0' })); for (const i of [0, 1, 2, 40, 70]) w.bal[lc(T[i].repo_token)] = '5000000000000000000'; delete w.bal[S.A.sUSDS]; setWorld(L, w);
    const R2 = 'pb-m0';
    for (const s of ['c', 'd', 'e', 'f']) { const r = P([s, R2]); ok(r.code === 0, `${s}: ${say(r)}`); }
    const g = P(['g', R2]); ok(g.code === 0 && g.j.mint.parent_split === false && g.j.mint.middles.length === 0 && g.j.groups > 0 && !g.j.by_kind.mint, say(g));
    const r = P(['exec', R2]); ok(r.code === 0 && r.j.outcome === 'complete' && r.j.groups_done === g.j.groups, say(r));
    const traded = new Set(rj(rf(R2, 'fills.json')).runs.filter((x) => x.status === 'filled').map((x) => T.findIndex((t) => t.address === lc(x.address))));
    ok([0, 1, 2].some((i) => traded.has(i)) && [40, 70].some((i) => traded.has(i)), JSON.stringify([...traded]));
  });
}

// =================================================================================================================
// SECTION mergearb: F step 3a's merge-arb on a sub-1 market whose child Invalid an earlier run retained, sent by G as
// buy-and-merge, then the 3b pair of the remainder on the post-merge-arb state; the cross-run Invalid row (G Output)
// =================================================================================================================
async function mergeArbSection(root) {
  const L = makeLayout(path.join(root, 'mergearb'));
  const S = sw(); const T = tb().T.rows; const k1 = S.kids[1]; // market 1: [UP 0.40, DOWN 0.50], a sub-1 pair
  const Q = 6n * 10n ** 18n; // child Invalid of market 1 held from an earlier run (a merge-arb of 3 would not clear the 7-leg gas floor)
  const w = freshWorld(); w.bal[k1.inv] = Q.toString(); setWorld(L, w);
  fs.mkdirSync(path.join(L.proj, 'inputs'), { recursive: true }); fs.writeFileSync(path.join(L.proj, 'inputs', 'forecast.csv'), csvText());
  const P = (args, o) => runPlanner(L, args, o);
  const rf = (rid, n) => path.join(L.proj, 'run', rid, n);
  const R0 = 'pt-ma-0'; const R1 = 'pt-ma-1';
  wj(rf(R0, 'base-forecast.json'), { method: 'csv-face-value', forecasts: [] }); wj(rf(R0, 'allocation.json'), { objective: 'max-ev', positions: [] });
  wj(rf(R0, 'fills.json'), { generated_at: '2026-10-05T00:00:00Z', runs: [{ market: T[1].repo, address: T[1].address, side: 'set', route: 'set-sell', requested: 6, filled: 6, fill_price: 1.01, slippage_vs_quote: 0, tx_hash: '0x' + '0a'.repeat(32), status: 'filled', error: null }], totals: { spent: 0, spent_unit: 'sUSDS', positions_opened: 1 }, retained_legs: [{ token: k1.inv, amount: 6, why: 'child Invalid minted by a complex-buy or set-sell split; no pool; sources: test set set-sell' }] });
  await test('mergearb: F sizes step 3a\'s merge-arb on market 1 (q = I_j = 6, invalid-held), then the 3b pair of the remainder on the post-merge-arb state; every check passes; the probe confirms the pair legs', () => {
    for (const s of ['c']) { const r = P([s, R1]); ok(r.code === 0, `${s}: ${say(r)}`); }
    const d = P(['d', R1, '--supply', 'inputs/forecast.csv', '--continue']); ok(d.code === 0, say(d));
    const e = P(['e', R1]); ok(e.code === 0, say(e));
    const f = P(['f', R1]); ok(f.code === 0 && f.j.checks.passed === f.j.checks.total && f.j.merge_arb_markets.includes(T[1].repo), say(f));
    const A = rj(rf(R1, 'allocation.json')); const m1 = A.positions.filter((p) => p.address === T[1].address);
    const st = m1.find((p) => p.side === 'set');
    ok(st && st.route === 'merge-arb' && st.limited_by === 'invalid-held' && st.quoted_fill < 1 && Math.abs(st.stake / st.quoted_fill - 6) < 1e-12 && Math.abs(st.ev - (6 - st.stake)) < 1e-12 && m1.some((p) => p.side === 'UP') && m1.some((p) => p.side === 'DOWN'), clip(m1, 900));
    const pr = f.j.probe.filter((x) => x.market === T[1].repo); ok(pr.length === 2 && pr.every((x) => x.ran && x.confirmed), clip(f.j.probe));
    ok(/merge-arb: 6.0000 pairs/.test(fs.readFileSync(rf(R1, 'f-print.md'), 'utf8')), 'f-print.md has no merge-arb line');
  });
  await test('mergearb: G builds the buy-and-merge group (approve, buy q UP, buy q DOWN, three approves, merge) and the remainder pair quoted on the post-merge-arb state; end state equal to the prediction; audit clean', () => {
    const g = P(['g', R1]); ok(g.code === 0 && g.j.by_kind['merge-arb'] === 1 && g.j.by_kind['dual-buy'] === 1 && g.j.verify.end_state.differ === 0 && g.j.audit.failures === 0, say(g));
    const plan = rj(rf(R1, 'g-plan.json')); const ma = plan.groups.find((x) => x.kind === 'merge-arb');
    ok(ma.recorded_route === 'buy-and-merge' && ma.txs.length === 7 && plan.route_counts.merge_arb === 1 && ma.expected_effects.childInvalid === '-6', clip(ma.expected_effects));
  });
  await test('mergearb: exec sends it all; the merge-arb consumes the 6 held child Invalid; its buy-and-merge row; the earlier run\'s fills.json gets the cross-run side "Invalid" row (6, consumed by this run)', () => {
    const r = P(['exec', R1]); ok(r.code === 0 && r.j.outcome === 'complete' && r.j.consumed_rows >= 1, say(r));
    const st = rj(rf(R1, 'exec-state.json')).groups; ok(Object.values(st).every((x) => x.status === 'done' && !(x.effects_diffs || []).some((d) => d.kind === 'exact')), JSON.stringify(st));
    const F1 = rj(rf(R1, 'fills.json')); const row = F1.runs.find((x) => x.route === 'buy-and-merge' && x.side === 'set');
    ok(row && row.filled === 6 && row.fill_price < 1 && row.status === 'filled' && row.tx_hash, clip(row));
    const F0 = rj(rf(R0, 'fills.json')); const inv = F0.runs.find((x) => x.side === 'Invalid');
    ok(inv && inv.route === 'buy-and-merge' && inv.filled === 6 && inv.error === `consumed by run ${R1}` && lc(inv.address) === T[1].address, clip(F0.runs));
    ok(getB(getWorld(L), k1.inv) === 0n, 'child Invalid left at the holder');
    const HB = require(path.join(L.bin, 'planner', 'halfb.cjs')); const own = HB.ownChild(F0, { positions: [] }, T[1].address, k1.inv); ok(own.inv === 0n, 'the earlier run still counts the consumed Invalid as its own');
  });
}

// =================================================================================================================
// SECTION wake: the whole scheduled run inside the wrapper's lock, the gates, the refusal outside it, D4
// =================================================================================================================
function wakeLayout(root, name) {
  const W = makeLayout(path.join(root, name));
  setWorld(W, freshWorld());
  fs.mkdirSync(path.join(W.proj, 'run', 'csv'), { recursive: true });
  fs.writeFileSync(path.join(W.proj, 'run', 'csv', 'originality-v1-a-supervised-run.csv'), csvText());
  wj(path.join(W.proj, 'run', 'csv', 'current.json'), { current: './run/csv/originality-v1-a-supervised-run.csv', version: 1, sha256: sha(csvText()), supplied_at: '2026-10-06T00:00:00Z', supplied_in_run: 'a-supervised-run', counts: { matched: 4, unmatched: 1, overwritten: 0, no_forecast: 94 }, history: [] });
  // the live setup's signer mode, so these wakes run on a record that names it (the wake section's record names none)
  setupRecord(W.proj, { signer_mode: 'local-encrypted-eoa' });
  return { W, P: (args, o) => runPlanner(W, args, o), rf: (rid, n) => path.join(W.proj, 'run', rid, n) };
}
// the wake's once-only re-plan on a failing simulation (I-setup.md I.2 section 5 item 3, G section 8)
async function wakeReplanSection(root) {
  const { W, P, rf } = wakeLayout(root, 'wake-replan');
  const SEL_OUT = iface().getFunction('exactOutputSingle').selector; // the dual-buy group's legs only
  await test('wake: G\'s own build simulation fails once (the dual-buy group) before any broadcast: F and G re-run once, the rebuilt plan passes, all 28 sent, status traded', () => {
    const R1 = 'pt-wake-sim1'; wrapperLock(W.proj, R1);
    try {
      const r = P(['wake', R1], { scen: { failSimulate: { selector: SEL_OUT, requests: 1 } } });
      const ws = rj(rf(R1, 'wake-status.json')); const ex = rj(rf(R1, 'planner/exec.json')).summary;
      ok(r.code === 0 && ws.status === 'traded' && /G's pre-send simulation failed before the first broadcast \(simulation-failed, first failing group dual-buy:/.test(ws.notes) && /F and G re-run once/.test(ws.notes) && ex.transactions_sent === 28 && !rj(rf(R1, 'g-plan.json')).cut, say(r) + JSON.stringify(ws));
    } finally { rmrf(lockDir(W.proj)); }
  });
  await test('wake: the rebuilt plan fails its simulation again at the dual-buy group: G cuts the plan there; the mints and the set-sell before it are sent, the dual-buy and every later row written skipped; status traded, exit 3', () => {
    const R2 = 'pt-wake-sim2'; setWorld(W, freshWorld()); wrapperLock(W.proj, R2);
    try {
      const r = P(['wake', R2], { scen: { failSimulate: { selector: SEL_OUT, requests: 2 } } });
      const ws = rj(rf(R2, 'wake-status.json')); const ex = rj(rf(R2, 'planner/exec.json')).summary; const plan = rj(rf(R2, 'g-plan.json')); const F = rj(rf(R2, 'fills.json'));
      ok(r.code === 3 && r.j.stop.cause === 'stale-simulation' && ws.status === 'traded' && /failed again at group 5 \(dual-buy:/.test(ws.notes), say(r) + JSON.stringify(ws));
      ok(plan.cut && plan.cut.at_group === 5 && plan.groups.length === 5 && plan.groups.map((g) => g.kind).join() === 'mint,mint,mint,mint,set-sell' && ex.transactions_sent === 14 && ex.outcome === 'complete', clip({ cut: plan.cut, ex }, 800));
      const sk = F.runs.filter((x) => x.status === 'skipped'); ok(sk.length === 5 && sk.every((x) => /simulation failed again/.test(x.error)) && F.runs.filter((x) => x.status === 'filled' && x.tx_hash && x.route !== 'buy-and-merge').length === 5, clip(F.runs.map((x) => `${x.side} ${x.route} ${x.status}`)));
    } finally { rmrf(lockDir(W.proj)); }
  });
}
// the PSM3 ramp of the wake (I-setup.md I.1 section 5, I.2 section 2 Half A), and F's --provisional (supervised)
async function rampSection(root) {
  const { W, P, rf } = wakeLayout(root, 'ramp');
  const S = sw();
  const holdRamp = (w) => { w.bal[S.A.USDC] = '20000000'; w.bal[S.A.USDS] = '5000000000000000000'; return w; }; // 20 USDC, 5 USDS (the bankroll still binds)
  setWorld(W, holdRamp(freshWorld()));
  await test('wake: 20 USDC and 5 USDS held: the PSM3 ramp is sent after E as its own batch (approve + swapExactIn per asset, the capacity gate), F sizes on the post-ramp sUSDS, G accepts the ramp-only run-id, exec sends; status traded', () => {
    const R1 = 'pt-ramp-1'; wrapperLock(W.proj, R1);
    try {
      const w0 = getWorld(W); const want = 10n ** 19n + psmQuote(S.A.USDC, S.A.sUSDS, 20000000n) + psmQuote(S.A.USDS, S.A.sUSDS, 5n * 10n ** 18n);
      const r = P(['wake', R1]); const ws = rj(rf(R1, 'wake-status.json'));
      const rec = rj(rf(R1, 'ramp.json')); const sends = rj(rf(R1, 'exec-sends.json')); const f = rj(rf(R1, 'planner/f.json')).summary;
      ok(r.code === 0 && ws.status === 'traded' && /PSM3 ramp sent before F/.test(ws.notes), say(r) + JSON.stringify(ws));
      ok(rec.status === 'landed' && rec.groups.length === 2 && rec.groups.every((g) => g.txs.length === 2 && g.capacity_at_send) && BigInt(rec.susds_after) === want, JSON.stringify(rec));
      ok(sends.filter((s) => s.source === 'ramp').length === 4 && sends.slice(0, 4).every((s) => s.source === 'ramp') && rj(rf(R1, 'nonce-attempts.json')).length === sends.length, clip(sends.map((s) => s.source)));
      ok(f.ramp_due === false && FLwei(f.bankroll) === fl().floor15(want) && f.provisional === false, clip(f, 600));
      const ex = rj(rf(R1, 'planner/exec.json')).summary; ok(ex.outcome === 'complete' && ex.transactions_sent > 0, clip(ex, 400));
      ok(getB(getWorld(W), S.A.USDC) === 0n && getB(getWorld(W), S.A.USDS) === 0n && w0, 'USDC or USDS left after the ramp');
      ok(/\[ramp\]/.test(fs.readFileSync(rf(R1, 'report.md'), 'utf8')), 'report.md does not list the ramp sends');
    } finally { rmrf(lockDir(W.proj)); }
  });
  await test('wake: PSM3 holds less sUSDS than the ramp would take (the capacity gate): the ramp stops before any send, Half A stops before F (no allocation.json), exit 3', () => {
    const R2 = 'pt-ramp-2'; const w = holdRamp(freshWorld()); w.psm3Cap = '1000000000000000000'; setWorld(W, w); wrapperLock(W.proj, R2);
    try {
      const r = P(['wake', R2]); const ws = rj(rf(R2, 'wake-status.json'));
      ok(r.code === 3 && ws.stopped_at_step === 'ramp' && /psm3-capacity/.test(ws.notes) && !exists(rf(R2, 'allocation.json')) && !exists(rf(R2, 'nonce-attempts.json')) && ws.status !== 'aborted', say(r) + JSON.stringify(ws));
    } finally { rmrf(lockDir(W.proj)); }
  });
  await test('f --provisional (supervised): 200 USDC and 0 sUSDS give rows sized on sUSDS + PSM3 minAmountOut, labelled provisional; g then stops stale-susds; plain f keeps the sUSDS-only sizing (no row)', () => {
    const R3 = 'pt-prov-1'; const w = freshWorld(); w.bal = { [S.A.USDC]: '200000000' }; setWorld(W, w);
    for (const s of ['c', 'd', 'e']) { const r = P([s, R3]); ok(r.code === 0, `${s}: ${say(r)}`); }
    const min = psmQuote(S.A.USDC, S.A.sUSDS, 200000000n) * 9999n / 10000n;
    const a = P(['f', R3, '--provisional']); ok(a.code === 0 && a.j.provisional === true && a.j.rows > 0 && a.j.provisional_min_out.usdc === min.toString() && FLwei(a.j.bankroll) === fl().floor15(min), say(a));
    ok(/\*\*PROVISIONAL\*\*/.test(fs.readFileSync(rf(R3, 'f-print.md'), 'utf8')) && Object.keys(rj(rf(R3, 'allocation.json'))).length === 7, 'f-print.md does not say provisional, or allocation.json has another key');
    const g = P(['g', R3]); ok(g.code === 3 && g.j.stop.cause === 'stale-susds' && !exists(rf(R3, 'g-plan.json')), say(g));
    const b = P(['f', R3]); ok(b.code === 0 && b.j.provisional === false && b.j.rows === 0 && b.j.ramp_due === true && b.j.bankroll === 0, say(b));
    // inside the wrapper's lock (the scheduled run) --provisional is refused before anything is written
    const before = fs.readFileSync(rf(R3, 'allocation.json'));
    wrapperLock(W.proj, R3); try { const c = P(['f', R3, '--provisional']); ok(c.code === 2 && c.j.code === 'usage' && fs.readFileSync(rf(R3, 'allocation.json')).equals(before), say(c)); } finally { rmrf(lockDir(W.proj)); }
  });
  await test('wake: the ramp\'s pre-send simulate answers rpc-transport (no "simulated":true): the ramp stops with exit 5 transport, never stale-simulation, nothing sent; Half A stops before F and the wake ends aborted (the wrapper exits 3)', () => {
    const R4 = 'pt-ramp-tr'; setWorld(W, holdRamp(freshWorld())); wrapperLock(W.proj, R4);
    try {
      const r = P(['wake', R4], { scen: { signerSimError: { selector: iface().getFunction('approve').selector, error: 'rpc-transport', detail: 'network error or timeout talking to the pinned RPC' } } });
      const ws = rj(rf(R4, 'wake-status.json')); const rp = rj(rf(R4, 'planner/ramp.json')).summary;
      ok(r.code === 5 && rp.exit === 5 && rp.stop.cause === 'transport' && ws.status === 'aborted' && ws.stopped_at_step === 'ramp' && !r.calls.sends.length && !exists(rf(R4, 'allocation.json')), say(r) + clip({ rp: rp.stop, ws }, 800));
    } finally { rmrf(lockDir(W.proj)); }
  });
}
async function wakeAffordSection(root) {
  const { W, P, rf } = wakeLayout(root, 'wake-afford');
  await test('wake: ETH drops to 0.002001 after Half A\'s 28th send: Half B\'s middle-merge:C is skipped for affordability, exit 3 affordability-skip, named in wake-status.json\'s notes; the status stays traded', () => {
    const R1 = 'pt-wake-afford'; wrapperLock(W.proj, R1);
    try {
      const r = P(['wake', R1], { scen: { ethAfterSends: { n: 28, eth: '2001000000000000' } } });
      const hb = rj(rf(R1, 'planner/halfb.json')).summary; const ws = rj(rf(R1, 'wake-status.json'));
      ok(r.code === 3 && hb.exit === 3 && hb.stop.cause === 'affordability-skip' && hb.skipped[0].id === 'middle-merge:C' && hb.sent.length === 0, say(r) + clip(hb, 800));
      ok(ws.status === 'traded' && /Half B skipped middle-merge:C: affordability/.test(ws.notes) && /Half B stopped: affordability-skip/.test(ws.notes), JSON.stringify(ws));
    } finally { rmrf(lockDir(W.proj)); }
  });
  // the pre-send simulate's RPC failure (no "simulated":true) is a transport failure on every send path (I-setup.md I.2
  // section 7, Rate limits): exec and Half B here, the ramp in its own section
  await test('wake: exec\'s first pre-send simulate answers rpc-transport (a network error, no "simulated":true): exec stops with exit 5 transport, never stale-simulation, nothing sent; the wake ends aborted (the wrapper exits 3)', () => {
    const R2 = 'pt-wake-tr-exec'; setWorld(W, freshWorld()); wrapperLock(W.proj, R2);
    try {
      const r = P(['wake', R2], { scen: { signerSimError: { selector: iface().getFunction('approve').selector, error: 'rpc-transport', detail: 'network error or timeout talking to the pinned RPC' } } });
      const ex = rj(rf(R2, 'planner/exec.json')).summary; const ws = rj(rf(R2, 'wake-status.json'));
      ok(r.code === 5 && ex.exit === 5 && ex.stop.cause === 'transport' && ws.status === 'aborted' && !r.calls.sends.length, say(r) + clip({ ex: ex.stop, ws }, 800));
    } finally { rmrf(lockDir(W.proj)); }
  });
  await test('wake: Half B\'s first pre-send simulate answers rpc-http 503 after Half A\'s 28 sends: Half B stops with exit 5 transport, never stale-simulation, nothing of it sent; the wake ends aborted (the wrapper exits 3)', () => {
    const R3 = 'pt-wake-tr-halfb'; setWorld(W, freshWorld()); wrapperLock(W.proj, R3);
    try {
      const r = P(['wake', R3], { scen: { signerSimError: { afterSends: 28, error: 'rpc-http', detail: 'HTTP 503 from the pinned RPC' } } });
      const hb = rj(rf(R3, 'planner/halfb.json')).summary; const ws = rj(rf(R3, 'wake-status.json'));
      ok(r.code === 5 && hb.exit === 5 && hb.stop.cause === 'transport' && ws.status === 'aborted' && r.calls.sends.length === 28 && hb.sent.length === 0, say(r) + clip({ hb: hb.stop, ws }, 800));
    } finally { rmrf(lockDir(W.proj)); }
  });
}
// a group today's exec leaves half-done ends the wake aborted, cause half-done (I-setup.md I.2 section 6 (a)); the next
// run's start-of-run repair names it and never finalizes it (section 6 (c))
async function wakeHalfDoneSection(root) {
  const { W, P, rf } = wakeLayout(root, 'wake-halfdone');
  const SEL_OUT = iface().getFunction('exactOutputSingle').selector; // the dual-buy group's two legs only
  const R1 = 'pt-wake-hd';
  await test('wake: the signer\'s own simulate fails the dual-buy\'s second leg after its first landed: exec stops with the group half-done (3 of 4 landed, nonce settled); the wake ends aborted, cause half-done, the group named first in notes, exit 3; Half B, H and report.md still run', () => {
    wrapperLock(W.proj, R1);
    try {
      const r = P(['wake', R1], { scen: { signerSimFail: { selector: SEL_OUT, after: 1 } } });
      const ws = rj(rf(R1, 'wake-status.json')); const ex = rj(rf(R1, 'planner/exec.json')).summary;
      ok(r.code === 3 && r.j.stop && r.j.stop.cause === 'half-done' && r.j.status === 'aborted' && ws.status === 'aborted' && /^half-done: group dual-buy:\S+, 3 of 4 transactions landed/.test(ws.notes) && ex.half_done && ex.half_done.landed === 3 && !exists(rf(R1, 'inflight.json')), say(r) + JSON.stringify(ws));
      ok(exists(rf(R1, 'planner/halfb.json')) && r.j.h_results[R1] === 'nothing settled yet' && /\*\*Half-done group\*\* dual-buy:/.test(fs.readFileSync(rf(R1, 'report.md'), 'utf8')), 'Half B, H or report.md: ' + say(r));
    } finally { rmrf(lockDir(W.proj)); }
  });
  await test('wake half-done, the next run: its start-of-run repair names the group (3 of 4 landed), appends no row and leaves the run-id aborted, not final (H holds it back)', async () => {
    const lib = require(path.join(W.bin, 'planner', 'lib.cjs')); const X = require(path.join(W.bin, 'planner', 'exec-core.cjs'));
    const HB = require(path.join(W.bin, 'planner', 'halfb.cjs')); const WK = require(path.join(W.bin, 'planner', 'wake.cjs'));
    const c = lib.makeContext({ cfg: W.cfg, sub: 'wake', runId: 'pt-wake-hd-next' });
    const before = fs.readFileSync(rf(R1, 'fills.json'), 'utf8');
    const rep = await WK.repair(c, X.makeEnv(c, { step: 'W', holder: HOLDER, setup: null }), []);
    ok(rep.notes.some((n) => /^run pt-wake-hd: group dual-buy:\S+ \(3 of 4 transactions landed\) is half-done/.test(n)) && rep.repaired.length === 0 && !rep.blockSends && rj(rf(R1, 'wake-status.json')).status === 'aborted' && !HB.isFinalRun(c, R1) && fs.readFileSync(rf(R1, 'fills.json'), 'utf8') === before, JSON.stringify(rep));
  });
  const gid = `dual-buy:${sw().kids[1].name}`; const R2 = 'pt-wake-hd-2';
  await test('wake half-done, the next wake (the failure gone): its start-of-run repair applies the recovery rule in that run-id, judged on the current state: Half B\'s middle merge has since taken the market\'s repo tokens back, so completing it no longer simulates clean and the stray UP leg is sold (sell-exit, unwound), its rows naming "recovery" and the failed transaction, the run-id finalized "repaired by"; the new wake goes on', () => {
    wrapperLock(W.proj, R2);
    try {
      const up0 = rj(rf(R1, 'fills.json')).runs.find((x) => x.route === 'dual-buy' && x.side === 'UP' && x.status === 'filled');
      const r = P(['wake', R2]);
      const ws1 = rj(rf(R1, 'wake-status.json')); const rec = rj(rf(R1, 'recovery.json')).groups[gid]; const w2 = rj(rf(R2, 'wake-status.json'));
      const rows = rj(rf(R1, 'fills.json')).runs.filter((x) => x.route === 'sell-exit' && x.side === 'UP' && x.status === 'filled' && /^recovery of group dual-buy:\S+ \(the start-of-run repair of pt-wake-hd-2\)/.test(x.error || '') && /the failed transaction: buy count DOWN/.test(x.error));
      const sends = rj(rf(R1, 'exec-sends.json')).filter((x) => x.source === 'recovery');
      ok(ws1.status === 'traded' && /repaired by pt-wake-hd-2 at \S+: recovery: dual-buy:\S+ unwound/.test(ws1.notes) && rec.outcome === 'unwound' && rec.attempts.length === 2 && rec.attempts[0].outcome === 'stopped' && rec.attempts[1].outcome === 'unwound' && /completing it does not simulate clean/.test(rec.attempts[1].why), say(r) + clip({ ws1, rec }, 1500));
      ok(up0 && rows.length === 1 && rows[0].filled === up0.filled && sends.length === 2 && sends[1].tx_hash === rows[0].tx_hash && r.j.recovered.length === 1 && r.j.recovered[0].outcome === 'unwound' && w2.status !== 'aborted' && /the recovery rule \(G section 8 step 4\): unwound \(sell-exit\)/.test(w2.notes), say(r) + clip({ rows, sends, w2: w2.notes }, 1500));
    } finally { rmrf(lockDir(W.proj)); }
  });
  await test('recovery is never applied twice: that run-id made non-final again, a repair with the recovery on finds the group settled in its recovery.json (unwound), sends nothing, records no attempt and re-finalizes it', async () => {
    const lib = require(path.join(W.bin, 'planner', 'lib.cjs')); const X = require(path.join(W.bin, 'planner', 'exec-core.cjs')); const WK = require(path.join(W.bin, 'planner', 'wake.cjs'));
    wj(rf(R1, 'wake-status.json'), { run_id: R1, status: 'aborted', notes: 'made non-final by the test' });
    const recBefore = fs.readFileSync(rf(R1, 'recovery.json'), 'utf8'); const n0 = getWorld(W).nonce;
    const c = lib.makeContext({ cfg: W.cfg, sub: 'wake', runId: 'pt-wake-hd-3' }); const env = X.makeEnv(c, { step: 'W', holder: HOLDER, setup: null }); env.lock = { mode: 'wrapper', taken: false, text: 'test' };
    const rep = await WK.repair(c, env, [], { recover: true });
    ok(rep.recovered.length === 0 && rep.repaired.some((x) => x.run_id === R1) && getWorld(W).nonce === n0 && fs.readFileSync(rf(R1, 'recovery.json'), 'utf8') === recBefore && !rep.notes.some((x) => /is half-done/.test(x)), JSON.stringify(rep));
  });
}
// G section 8 step 4's recovery rule applied by exec in the run that stopped (inside the wrapper): complete, unwind,
// keep; the kept group then finalized by the next run's start-of-run repair
async function recoverySection(root) {
  const SEL_OUT = iface().getFunction('exactOutputSingle').selector; // the dual-buy group's two legs only
  const S = sw(); const k1 = S.kids[1]; const gid = `dual-buy:${k1.name}`;
  {
    const { W, P, rf } = wakeLayout(root, 'rec-complete'); const R1 = 'pt-rec-c';
    await test('recovery, complete: the signer\'s simulate fails the dual-buy\'s DOWN leg once, after its UP leg landed; exec applies the rule in the same run: the DOWN leg re-simulated, sent and landed (completed), its row naming "recovery" and the failed transaction; nothing half-done, the wake ends traded (exit 3: Half A stopped at exec)', () => {
      wrapperLock(W.proj, R1);
      try {
        const r = P(['wake', R1], { scen: { signerSimFail: { selector: SEL_OUT, after: 1, times: 1 } } });
        const ws = rj(rf(R1, 'wake-status.json')); const ex = rj(rf(R1, 'planner/exec.json')).summary; const rec = rj(rf(R1, 'recovery.json')).groups[gid];
        const rows = rj(rf(R1, 'fills.json')).runs.filter((x) => x.route === 'dual-buy' && x.side === 'DOWN' && x.status === 'filled' && /^recovery of group dual-buy:/.test(x.error || '') && /the failed transaction: buy count DOWN/.test(x.error));
        const sends = rj(rf(R1, 'exec-sends.json')).filter((x) => x.source === 'recovery');
        ok(r.code === 3 && ws.status === 'traded' && ex.stop.cause === 'stale-simulation' && !ex.half_done && ex.recovery && ex.recovery.outcome === 'completed' && ex.recovery.decision === 'complete' && rec.outcome === 'completed', say(r) + clip({ ws, rv: ex.recovery }, 1200));
        ok(rows.length === 1 && rows[0].filled > 0 && sends.length === 1 && sends[0].tx_hash === rows[0].tx_hash && /recovery of group dual-buy:\S+ in this run/.test(ws.notes) && !exists(rf(R1, 'inflight.json')) && /\*\*Recovery\*\*/.test(fs.readFileSync(rf(R1, 'report.md'), 'utf8')), clip({ rows, sends, notes: ws.notes }, 1500));
      } finally { rmrf(lockDir(W.proj)); }
    });
  }
  {
    const { W, P, rf } = wakeLayout(root, 'rec-unwind'); const R2 = 'pt-rec-u';
    await test('recovery, unwind: a third party lifts the dual-buy\'s DOWN price x1.5 once its UP leg landed: the DOWN leg breaches its amountInMaximum (stale-floor); completing it does not simulate clean, so the stray UP leg is sold back (sell-exit at a fresh quote less 0.5%): unwound, the UP balance back to 0, the wake traded', () => {
      setWorld(W, freshWorld()); wrapperLock(W.proj, R2);
      try {
        const r = P(['wake', R2], { scen: { onSend: { selector: SEL_OUT, count: 1, pool: { addr: k1.poolDOWN, T0: S.pools.get(k1.poolDOWN).T0, factor: 1.5 } } } });
        const ws = rj(rf(R2, 'wake-status.json')); const ex = rj(rf(R2, 'planner/exec.json')).summary; const F = rj(rf(R2, 'fills.json'));
        const up = F.runs.find((x) => x.route === 'dual-buy' && x.side === 'UP' && x.status === 'filled'); const se = F.runs.find((x) => x.route === 'sell-exit' && x.side === 'UP');
        ok(r.code === 3 && ws.status === 'traded' && ex.stop.cause === 'stale-floor' && !ex.half_done && ex.recovery && ex.recovery.outcome === 'unwound' && ex.recovery.decision === 'sell-exit', say(r) + clip({ ws, rv: ex.recovery }, 1200));
        ok(up && se && se.filled === up.filled && se.fill_price > 0 && /the unwind sale of the stray leg/.test(se.error) && getB(getWorld(W), k1.up) === 0n, clip({ up, se }, 1200));
      } finally { rmrf(lockDir(W.proj)); }
    });
  }
  {
    const { W, P, rf } = wakeLayout(root, 'rec-keep'); const R3 = 'pt-rec-k'; const R4 = 'pt-rec-k2';
    await test('recovery, keep: the dual-buy\'s child goes to arbitration once its UP leg landed: its next transaction fails the boundary (stale-boundary); the boundary allows neither trading nor merging, so the landed leg is kept as its row and the group listed half-done: the wake ends aborted, cause half-done (exit 3)', () => {
      wrapperLock(W.proj, R3);
      try {
        const r = P(['wake', R3], { scen: { onSend: { selector: SEL_OUT, count: 1, arbitration: k1.qid } } });
        const ws = rj(rf(R3, 'wake-status.json')); const ex = rj(rf(R3, 'planner/exec.json')).summary;
        ok(r.code === 3 && r.j.stop.cause === 'half-done' && ws.status === 'aborted' && ex.stop.cause === 'stale-boundary' && ex.half_done && ex.half_done.landed === 2 && ex.recovery && ex.recovery.outcome === 'kept' && /^half-done: group dual-buy:\S+, 2 of 4 transactions landed/.test(ws.notes) && /kept the landed legs/.test(ws.notes) && !rj(rf(R3, 'exec-sends.json')).some((x) => x.source === 'recovery'), say(r) + clip({ ws, rv: ex.recovery }, 1200));
      } finally { rmrf(lockDir(W.proj)); }
    });
    await test('recovery, keep, the next wake: its start-of-run repair applies the rule again; the boundary still allows nothing, so it keeps the landed leg and finalizes the run-id ("repaired by", status traded); nothing sent for it', () => {
      wrapperLock(W.proj, R4);
      try {
        const r = P(['wake', R4]);
        const ws3 = rj(rf(R3, 'wake-status.json')); const rec = rj(rf(R3, 'recovery.json')).groups[gid]; const w4 = rj(rf(R4, 'wake-status.json'));
        ok(ws3.status === 'traded' && /repaired by pt-rec-k2 at \S+: recovery: dual-buy:\S+ kept/.test(ws3.notes) && rec.attempts.length === 2 && rec.attempts.every((a) => a.outcome === 'kept') && !rj(rf(R3, 'exec-sends.json')).some((x) => x.source === 'recovery') && /the recovery rule \(G section 8 step 4\): kept/.test(w4.notes), say(r) + clip({ ws3, w4: w4.notes }, 1500));
      } finally { rmrf(lockDir(W.proj)); }
    });
  }
}
// the chain helper's cap of 20 calls flagged "return" per simulate request (chain-helper.cjs MAX_SIM_RETURNS): a plan of
// 51 complex-buy groups (51 sales) passes exec --check, its sale proceeds read at most 20 per request, and is sent whole
// by exec inside the wrapper
async function capSection(root) {
  const L = makeLayout(path.join(root, 'cap'));
  const S = sw(); const I = iface(); const N = 51; const x = 2n * 10n ** 18n; const rid = 'pt-cap-51';
  const w = freshWorld(); const kids = S.kids.slice(4, 4 + N);
  for (const k of kids) {
    w.bal[k.repo] = x.toString();
    w.pools[k.poolUP].sqrt = sqrtFor(0.35, S.pools.get(k.poolUP).T0).toString(); w.pools[k.poolDOWN].sqrt = sqrtFor(0.65005, S.pools.get(k.poolDOWN).T0).toString();
  }
  setWorld(L, w); setupRecord(L.proj);
  const dir = path.join(L.proj, 'run', rid); rmrf(dir); fs.mkdirSync(path.join(dir, 'g-tx'), { recursive: true });
  wj(path.join(dir, 'candidates.json'), { candidates: S.kids.map((k) => ({ address: k.addr, parent: { address: S.bundles[k.bundle].middle }, collateral_token: k.repo })) });
  const H = lc(HOLDER); const apr = (sp, a) => I.encodeFunctionData('approve', [sp, a]); const exIn = (ti, to, a, m) => I.encodeFunctionData('exactInputSingle', [[ti, to, 100, H, a, m, 0]]);
  const groups = kids.map((k, gi) => {
    const P = quoteOn(w, 'in', k.down, k.repo, x).amt; const B = quoteOn(w, 'in', k.repo, k.up, P).amt;
    const spot = (p) => { const d = w.pools[p.addr]; return fl().priceOf(BigInt(d.sqrt), p.T0); };
    const pu = spot(S.pools.get(k.poolUP)); const pd = spot(S.pools.get(k.poolDOWN));
    const txs = [
      { label: 'approve repo -> Router (x = stake)', to: k.repo, data: apr(S.A.ROUTER, x) },
      { label: 'Router.splitPosition(sUSDS, child, x)', to: S.A.ROUTER, data: I.encodeFunctionData('splitPosition', [S.A.sUSDS, k.addr, x]) },
      { label: 'approve DOWN -> SwapRouter02 (x)', to: k.down, data: apr(S.A.SWAP, x) },
      { label: 'sell x DOWN -> repo (min 99.5% of quote)', to: S.A.SWAP, data: exIn(k.down, k.repo, x, P * 9950n / 10000n), swap: { kind: 'exactInputSingle', tokenIn: k.down, tokenOut: k.repo, fee: 100, amountIn: x.toString(), amountOutMinimum: (P * 9950n / 10000n).toString(), quoted_amountOut: P.toString() } },
      { label: 'approve repo -> SwapRouter02 (P, quoted proceeds)', to: k.repo, data: apr(S.A.SWAP, P), rebuild_at_send: 'sequential mode' },
      { label: 'buy UP with the proceeds (min 99.5% of quote at P)', to: S.A.SWAP, data: exIn(k.repo, k.up, P, B * 9950n / 10000n), rebuild_at_send: 'sequential mode', swap: { kind: 'exactInputSingle', tokenIn: k.repo, tokenOut: k.up, fee: 100, amountIn: P.toString(), amountOutMinimum: (B * 9950n / 10000n).toString(), quoted_amountOut: B.toString() } }];
    return { index: gi, id: `complex-buy:${k.name}:UP`, kind: 'complex-buy', recorded_route: 'complex-buy', market: k.name, address: k.addr, allocation_rows: [{ side: 'UP', stake: 2, quoted_fill: 0.35, p_win: 0.75 }],
      expected_effects: { repo: '-2', UP: fl().weiStr(x + B), DOWN: '0', childInvalid: '2' },
      market_refs: { address: k.addr, repo_token: k.repo, down: k.down, up: k.up, child_invalid: k.inv, bundle: k.bundle, slot: k.slot, fee_tier: { UP: 100, DOWN: 100 }, pools: { UP: k.poolUP, DOWN: k.poolDOWN }, token0_is_outcome: { UP: S.pools.get(k.poolUP).T0, DOWN: S.pools.get(k.poolDOWN).T0 } },
      pre_send_checks: { condition_id: k.cond, question_id: k.qid, spot_at_build: { UP: pu, DOWN: pd, sum: pu + pd } }, txs };
  });
  // gas fields from the whole plan simulated on the world (the mock helper's own page), nonces from the holder's
  const page = simulatePage(w, groups.map((g) => ({ calls: g.txs.map((t) => ({ to: t.to, data: t.data, value: '0' })) })), {});
  ok(page.all_success === true, 'the synthetic plan does not simulate clean: ' + clip(page.failures));
  let k = 0;
  for (const g of groups) for (const t of g.txs) {
    const row = page.calls[k]; Object.assign(t, { idx: k, nonce_expected: w.nonce + k, value: '0', calldata_keccak256: keccakHex(t.data), gas_used: row[3], max_used_gas: row[4], gas_limit: String(row[5]), signer_input_file: `run/${rid}/g-tx/tx-${String(k).padStart(3, '0')}.json` });
    wj(path.join(dir, 'g-tx', `tx-${String(k).padStart(3, '0')}.json`), { calls: [{ to: t.to, data: t.data, value: '0' }], gasLimit: t.gas_limit }); k++;
  }
  wj(path.join(dir, 'g-plan.json'), { run_id: rid, built_at: new Date().toISOString(), holder: H, inputs: { signer_sha256: sha(fs.readFileSync(L.cfg.signerPath)) }, mint: { M_wei: '0', m_X_wei: {} }, groups, skipped_rows: [] });
  const P = (args, o) => runPlanner(L, args, o);
  const flaggedMax = () => { try { return rj(path.join(L.mock, 'flagged-max.json')).max; } catch (e) { return 0; } };
  await test(`exec --check on a plan of ${N} complex-buy groups (${N} sales in one simulate window): passes; the sale proceeds read in ${Math.ceil(N / 20)} requests of at most 20 flagged calls; the main simulation flags none`, () => {
    const r = P(['exec', rid, '--check']);
    ok(r.code === 0 && r.j.outcome === 'check-passed' && r.j.check.simulation.clean === true && r.j.check.simulation.requests === 1 && r.j.check.sale_proceeds.checked === N && r.j.check.sale_proceeds.differ === 0 && flaggedMax() === 20, say(r) + ` flagged max ${flaggedMax()}`);
    ok(r.calls.helper.simulate === 1 + Math.ceil(N / 20), `simulate requests ${r.calls.helper.simulate}`);
  });
  await test(`exec inside the wrapper on the same ${N}-group plan: all ${6 * N} transactions sent, every group's effects as simulated, every complex-buy pair rebuilt at its realised proceeds`, () => {
    wrapperLock(L.proj, rid);
    try {
      const r = P(['exec', rid]);
      ok(r.code === 0 && r.j.outcome === 'complete' && r.j.transactions_sent === 6 * N && r.j.mode === 'wrapper', say(r));
      const st = rj(path.join(dir, 'exec-state.json')); ok(Object.values(st.groups).every((g) => g.status === 'done' && !(g.effects_diffs || []).some((d) => d.kind === 'exact')) && rj(path.join(dir, 'exec-sends.json')).filter((s) => s.rebuilt).length === 2 * N, 'a group not done, an exact effect that differs, or a pair not rebuilt');
    } finally { rmrf(lockDir(L.proj)); }
  });
}

async function wakeSection(root, csvStoreFrom) {
  const W = makeLayout(path.join(root, 'wake'));
  setWorld(W, freshWorld());
  const P = (args, o) => runPlanner(W, args, o);
  const rf = (rid, n) => path.join(W.proj, 'run', rid, n);
  // the CSV store a supervised session left (D's stored path), and the setup record of a green supervised run
  fs.mkdirSync(path.join(W.proj, 'run', 'csv'), { recursive: true });
  if (csvStoreFrom && exists(csvStoreFrom)) fs.cpSync(csvStoreFrom, path.join(W.proj, 'run', 'csv'), { recursive: true });
  else {
    fs.writeFileSync(path.join(W.proj, 'run', 'csv', 'originality-v1-a-supervised-run.csv'), csvText());
    wj(path.join(W.proj, 'run', 'csv', 'current.json'), { current: './run/csv/originality-v1-a-supervised-run.csv', version: 1, sha256: sha(csvText()), supplied_at: '2026-10-06T00:00:00Z', supplied_in_run: 'a-supervised-run', counts: { matched: 4, unmatched: 1, overwritten: 0, no_forecast: 94 }, history: [] });
  }
  setupRecord(W.proj);
  const W1 = 'pt-wake-1';
  await test('wake: outside the wrapper (no lock) -> exit 4 not-scheduled, nothing written', () => {
    rmrf(lockDir(W.proj)); const r = P(['wake', 'pt-wake-0']); ok(r.code === 4 && r.j.stop.cause === 'not-scheduled' && !exists(rf('pt-wake-0', 'wake-status.json')), say(r));
  });
  await test('wake: the gates (autonomy.enabled false) -> exit 3, wake-status.json aborted naming the field, report.md written, nothing else run', () => {
    setupRecord(W.proj, { autonomy: { enabled: false, authorized_at: '2026-10-06T00:00:00Z', signer_selftest_passed_at: '2026-10-06T00:00:00Z' } }); wrapperLock(W.proj, 'pt-wake-g');
    try {
      const r = P(['wake', 'pt-wake-g']); const ws = exists(rf('pt-wake-g', 'wake-status.json')) ? rj(rf('pt-wake-g', 'wake-status.json')) : {};
      ok(r.code === 3 && ws.status === 'aborted' && /autonomy\.enabled is not true/.test(ws.notes) && exists(rf('pt-wake-g', 'report.md')) && !exists(rf('pt-wake-g', 'candidates.json')), say(r) + JSON.stringify(ws));
    } finally { setupRecord(W.proj); rmrf(lockDir(W.proj)); }
  });
  await test('wake: the gates (autonomy.authorized_at null) -> exit 3, wake-status.json aborted naming the field, report.md written, nothing else run', () => {
    setupRecord(W.proj, { autonomy: { enabled: true, authorized_at: null, signer_selftest_passed_at: '2026-10-06T00:00:00Z' } }); wrapperLock(W.proj, 'pt-wake-a');
    try {
      const r = P(['wake', 'pt-wake-a']); const ws = exists(rf('pt-wake-a', 'wake-status.json')) ? rj(rf('pt-wake-a', 'wake-status.json')) : {};
      ok(r.code === 3 && ws.status === 'aborted' && /autonomy\.authorized_at is null/.test(ws.notes) && exists(rf('pt-wake-a', 'report.md')) && !exists(rf('pt-wake-a', 'candidates.json')), say(r) + JSON.stringify(ws));
    } finally { setupRecord(W.proj); rmrf(lockDir(W.proj)); }
  });
  await test('wake: signer mode (b) (signer_mode executor-session-key) -> exit 3 unsupported-signer-mode at the start check, wake-status.json aborted with the plain note, report.md written; no helper read, the signer never run, nothing sent, the wrapper lock left as it was and no lock of its own', () => {
    const RB = 'pt-wake-b'; setupRecord(W.proj, { signer_mode: 'executor-session-key' }); wrapperLock(W.proj, RB);
    const owner = fs.readFileSync(path.join(lockDir(W.proj), 'owner.txt'), 'utf8'); const n0 = getWorld(W).nonce;
    const note = 'daily autonomous trading needs a local encrypted wallet or an EIP-7702 wallet; a TradeExecutor wallet works in supervised mode';
    try {
      const r = P(['wake', RB]); const ws = exists(rf(RB, 'wake-status.json')) ? rj(rf(RB, 'wake-status.json')) : {};
      ok(r.code === 3 && r.j.stop && r.j.stop.cause === 'unsupported-signer-mode' && r.j.stop.status === 'aborted' && ws.status === 'aborted' && String(ws.notes).includes(note), say(r) + JSON.stringify(ws));
      ok(exists(rf(RB, 'report.md')) && fs.readFileSync(rf(RB, 'report.md'), 'utf8').includes(note) && !exists(rf(RB, 'candidates.json')), 'report.md missing or without the note, or C ran');
      ok(!exists(path.join(W.mock, 'calls.json')) && !Object.keys(r.calls.helper).length && !Object.keys(r.calls.signer).length && !r.calls.sends.length && getWorld(W).nonce === n0, `a helper or signer process ran: ${clip(r.calls)}`);
      ok(fs.readFileSync(path.join(lockDir(W.proj), 'owner.txt'), 'utf8') === owner && fs.readdirSync(lockDir(W.proj)).sort().join() === 'live-runs.txt,owner.txt' && !exists(path.join(W.mock, 'mock-send.lock')) && ['inflight.json', 'nonce-attempts.json', 'fills.json'].every((n) => !exists(rf(RB, n))), 'a lock or a record was left');
    } finally { setupRecord(W.proj); rmrf(lockDir(W.proj)); }
  });
  await test('wake: the whole scheduled run in one call (c, d stored, e, f, g, exec, halfb, h, report): status traded, the wrapper lock left as it was', () => {
    wrapperLock(W.proj, W1); const owner = fs.readFileSync(path.join(lockDir(W.proj), 'owner.txt'), 'utf8');
    const r = P(['wake', W1]); ok(r.code === 0, say(r)); const s = shapeOk('wake', r.j); ok(!s, s);
    const ws = rj(rf(W1, 'wake-status.json'));
    ok(ws.status === 'traded' && ws.stopped_at_step === 'H' && r.j.status === 'traded' && r.j.traded === true && r.j.h_results[W1] === 'nothing settled yet', clip({ ws, j: r.j }, 1500));
    ok(fs.readFileSync(path.join(lockDir(W.proj), 'owner.txt'), 'utf8') === owner, 'the wrapper lock changed');
    const steps = ['c', 'd', 'e', 'f', 'g', 'exec', 'halfb', 'h', 'report'].filter((x) => !exists(rf(W1, `planner/${x}.json`)));
    ok(steps.length === 0, `no detail file for ${steps.join(', ')}`);
    const hb = rj(rf(W1, 'planner/halfb.json')).summary; ok(hb.mode === 'wrapper' && hb.sent.map((x) => x.id).join() === 'middle-merge:C', clip(hb.sent));
    ok(rj(rf(W1, 'exec-summary.json')).transactions_sent === 28 && /- pt-wake-1: nothing settled yet/.test(fs.readFileSync(rf(W1, 'report.md'), 'utf8')), 'exec or report');
    rmrf(lockDir(W.proj));
  });
  await test('wake D4: a C stop ends Half A only; Half B and H still run on the earlier run-id; the final status stays aborted (exit 3)', () => {
    const W2 = 'pt-wake-2'; wrapperLock(W.proj, W2);
    try {
      const r = P(['wake', W2], { scen: { bodyTransform: 'drop-last-market' } });
      const ws = rj(rf(W2, 'wake-status.json'));
      ok(r.code === 3 && ws.status === 'aborted' && /Half A stopped at C/.test(ws.notes) && r.j.h_results && r.j.h_results[W1] === 'nothing settled yet' && exists(rf(W2, 'planner/halfb.json')) && !exists(rf(W2, 'candidates.json')), say(r));
    } finally { rmrf(lockDir(W.proj)); }
  });
}

// =================================================================================================================
// LIVE (read-only smoke): c, d, e, f through the operator's installed helper; the signer configured but never run
// =================================================================================================================
async function liveSection(workRoot) {
  const need = ['helper', 'signer', 'bin', 'project'].filter((k) => !ARGS[k]);
  if (need.length) { await test('live: arguments', () => skip(`--live needs --${need.join(', --')}`)); return; }
  const helper = path.resolve(ARGS.helper); const signer = path.resolve(ARGS.signer); const bin = path.resolve(ARGS.bin); const proj = path.resolve(ARGS.project);
  const L = { bin, proj, mock: workRoot, env: { ...process.env } }; delete L.env.NODE_PATH; // the installed copy resolves ethers next to itself
  const rid = ARGS.runId || ('live-smoke-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z'));
  const out = { run_id: rid, started_at: new Date().toISOString(), steps: {} };
  await test('live: install a copy of the planner outside the project, its config pinned next to it, ethers next to it', () => {
    fs.mkdirSync(path.join(proj, 'run'), { recursive: true });
    installPlanner(bin, { helperPath: helper, signerPath: signer, projectRoot: proj, rpcGapMs: Number(ARGS.gapMs || 150), parallel: 1 });
    if (!exists(path.join(bin, 'node_modules', 'ethers'))) {
      const from = path.resolve(ARGS.ethersFrom || path.join(path.dirname(helper), 'node_modules'));
      ok(exists(path.join(from, 'ethers')), `no ethers in ${from}`);
      fs.cpSync(from, path.join(bin, 'node_modules'), { recursive: true });
    }
    if (ARGS.csvStore) {
      const dst = path.join(proj, 'run', 'csv'); fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(path.resolve(ARGS.csvStore))) if (/^(current\.json|originality-v\d+-[A-Za-z0-9._-]+\.csv)$/.test(f) && !exists(path.join(dst, f))) fs.copyFileSync(path.join(path.resolve(ARGS.csvStore), f), path.join(dst, f));
    }
    const pv = require(path.join(bin, 'node_modules', 'ethers', 'package.json')).version; ok(pv === '6.17.0', `ethers ${pv}`);
    out.install = { bin, planner_sha256: sha(fs.readFileSync(path.join(bin, 'planner.cjs'))), helper_sha256: sha(fs.readFileSync(helper)), signer_sha256: sha(fs.readFileSync(signer)) };
  });
  const treeBefore = listTree(proj);
  const go = (args) => {
    const t0 = Date.now();
    const r = cp.spawnSync(process.execPath, [path.join(bin, 'planner.cjs'), ...args], { cwd: proj, env: L.env, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 45 * 60 * 1000, windowsHide: true });
    const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => l.trim()); let j = null; try { j = JSON.parse(lines[lines.length - 1]); } catch (e) { j = null; }
    if (lines.length !== 1 || String(r.stdout).length > 20001 || !j || j.exit !== r.status) contract.push(`live ${args.join(' ')}: ${lines.length} line(s)`);
    const res = { code: r.status, j: j || {}, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), seconds: Math.round((Date.now() - t0) / 1000) };
    out.steps[args[0]] = { exit: res.code, seconds: res.seconds, summary: j };
    console.log(`      live ${args.join(' ')}: exit ${res.code} in ${res.seconds} s`);
    return res;
  };
  const det = (sub) => { try { return rj(path.join(proj, 'run', rid, 'planner', sub + '.json')); } catch (e) { return null; } };
  const noSigner = (sub) => { const d = det(sub); return d && d.tool_calls && d.tool_calls.signerCalls === 0; };
  await test(`live c: exit 0, 98 candidates, split 33/33/32, every chain read through the helper, the signer never run (run-id ${rid})`, () => {
    const r = go(['c', rid]); ok(r.code === 0, say(r));
    ok(r.j.candidates === 98 && r.j.bundle_split === '33 / 33 / 32' && noSigner('c'), clip(r.j, 1200));
    console.log(`      c: source ${r.j.source}, tradeable ${r.j.tradeable}, freshness ${r.j.freshness}, diagnostics failed ${JSON.stringify(r.j.diagnostics_failed)}, helper calls ${det('c').tool_calls.helperCalls} (retries ${det('c').tool_calls.helperRetries})`);
  });
  await test('live d: the stored CSV, exit 0, forecasts written, the signer never run', () => {
    const r = go(['d', rid]); ok(r.code === 0 && r.j.forecasts > 0 && noSigner('d'), say(r));
    console.log(`      d: forecasts ${r.j.forecasts}, csv v${r.j.csv.version} ${r.j.csv.path}, counts ${JSON.stringify(r.j.counts)}, counts_differ ${JSON.stringify(r.j.csv.counts_differ)}`);
  });
  await test('live e: exit 0, one blend per forecast, the signer never run', () => {
    const r = go(['e', rid]); ok(r.code === 0 && r.j.blends === (out.steps.d.summary || {}).forecasts && noSigner('e'), say(r));
    console.log(`      e: blends ${r.j.blends}, priced from candidates ${r.j.priced_from_candidates}, from the saved body ${r.j.priced_from_saved_body}, null ${r.j.null_price}`);
  });
  await test('live f: exit 0, every check passed, the signer never run; the bankroll is the sUSDS read; every market\'s stake within its budget held_j + M', () => {
    const r = go(['f', rid]); ok(r.code === 0, say(r));
    ok(r.j.checks.passed === r.j.checks.total && noSigner('f'), clip(r.j, 1500));
    const FL = fl(); const st = JSON.parse(fs.readFileSync(path.join(proj, 'run', rid, 'planner', 'f-state.json'), 'utf8'), FL.rev);
    const aux = JSON.parse(fs.readFileSync(path.join(proj, 'run', rid, 'planner', 'f-aux.json'), 'utf8'), FL.rev);
    const susds = BigInt(st.balances.sUSDS);
    ok(r.j.bankroll === FL.fromWei(FL.floor15(susds)), `bankroll ${r.j.bankroll} vs sUSDS ${susds}`);
    if (susds === 0n) ok(r.j.staked_M === 0, `staked_M ${r.j.staked_M} with no sUSDS`);
    const over = aux.perMarket.filter((m) => BigInt(m.S_j) > BigInt(m.budget)); ok(over.length === 0, `stake above budget on ${over.map((m) => m.market).join(', ')}`);
    const alloc = rj(path.join(proj, 'run', rid, 'allocation.json'));
    const zeroBudgetRows = alloc.positions.filter((p) => { const m = aux.perMarket.find((x) => x.market === p.market); return !m || BigInt(m.budget) === 0n; });
    ok(zeroBudgetRows.length === 0, `rows on a market with no budget: ${zeroBudgetRows.map((p) => p.market).join(', ')}`);
    out.f_invariants = { susds_wei: susds.toString(), held_markets: r.j.held_markets, rows: r.j.rows, markets_with_rows: r.j.markets_with_rows, staked_M: r.j.staked_M, binds: r.j.binds };
    console.log(`      f: rows ${r.j.rows} on ${r.j.markets_with_rows} markets (pairs ${r.j.pair_markets}, set rows ${r.j.set_rows}, single-side ${r.j.single_side_rows}); sUSDS ${FL.weiStr(susds)}; bankroll ${r.j.bankroll}; staked_M ${r.j.staked_M}; binds ${r.j.binds}; held markets ${r.j.held_markets}; child Invalid markets ${r.j.child_invalid_markets}; checks ${r.j.checks.passed}/${r.j.checks.total}; helper calls ${r.j.helper_calls}; quotes ${JSON.stringify(r.j.quotes)}; pins ${JSON.stringify(r.j.pins)}; ${r.j.seconds} s`);
    if (susds === 0n && r.j.rows > 0) console.log(`      f: NOTE: no sUSDS, yet ${r.j.rows} row(s): F step 6 spends what earlier runs left (held_j: repo tokens plus unsplit bundle tokens), so a day-2 plan with M = 0 is expected while the holder holds them`);
  });
  await test('live: every write landed under run/<run-id>/ (nothing else in the project changed)', () => {
    const after = listTree(proj).filter((p) => !p.startsWith(`run/${rid}/`));
    const before = treeBefore.filter((p) => !p.startsWith(`run/${rid}/`));
    ok(JSON.stringify(after) === JSON.stringify(before) && !exists(lockDir(proj)), `added ${after.filter((p) => !before.includes(p)).join(', ')}`);
  });
  out.finished_at = new Date().toISOString();
  try { wj(path.join(workRoot, `live-summary-${rid}.json`), out); console.log(`      live summary: ${path.join(workRoot, `live-summary-${rid}.json`)}`); } catch (e) { /* the summary file is a convenience */ }
}

// =================================================================================================================
// main
// =================================================================================================================
(async () => {
  const base = ARGS.dir ? path.resolve(ARGS.dir) : fs.mkdtempSync(path.join(os.tmpdir(), 'r3-planner-test-'));
  fs.mkdirSync(base, { recursive: true });
  const root = path.join(base, 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(root, { recursive: true });
  console.log(`planner tests (${ARGS.skipOffline ? 'no offline' : 'offline'}${ARGS.live ? ' + live read-only' : ''}); node ${process.version}; work folder ${root}`);
  const t0 = Date.now();
  try { require('ethers'); } catch (e) { console.log('FAIL  ethers is not resolvable from this folder (NODE_PATH or npm install ethers@6.17.0): ' + e.message); process.exit(1); }
  if (!ARGS.skipOffline) {
    const L = makeLayout(path.join(root, 'offline'));
    const sec = async (name, fn) => { const s0 = Date.now(); await fn(); console.log(`      (${name}: ${Math.round((Date.now() - s0) / 1000)} s)`); };
    if (want('static')) await sec('static', () => staticSection());
    if (want('usage')) await sec('usage', () => usageSection(L));
    if (want('lib')) await sec('lib', () => libSection(L));
    if (want('repair')) await sec('repair', () => repairSection(root));
    const needPipe = want('pipeline') || want('g-safety') || want('exec-safety');
    if (needPipe) await sec('pipeline', () => pipelineSection(L));
    if (want('c-variants')) await sec('c-variants', () => cVariantsSection(L));
    if (want('g-safety')) await sec('g-safety', () => gSafetySection(L));
    if (want('exec-safety')) await sec('exec-safety', () => execSafetySection(L));
    if (want('boundary')) await sec('boundary', () => boundarySection(root));
    if (want('mergearb')) await sec('mergearb', () => mergeArbSection(root));
    if (want('wake')) await sec('wake', () => wakeSection(root, needPipe ? path.join(L.proj, 'run', 'csv') : null));
    if (want('wake')) await sec('wake-afford', () => wakeAffordSection(root));
    if (want('wake')) await sec('wake-halfdone', () => wakeHalfDoneSection(root));
    if (want('ramp')) await sec('ramp', () => rampSection(root));
    if (want('wake')) await sec('wake-replan', () => wakeReplanSection(root));
    if (want('recovery')) await sec('recovery', () => recoverySection(root));
    if (want('cap')) await sec('cap', () => capSection(root));
    await test('contract: every invocation printed exactly one JSON line under 20,000 characters, its exit equal to the process exit', () => ok(contract.length === 0, contract.slice(0, 8).join(' | ')));
    await test('cap: no simulate request of the whole suite flagged more than 20 calls "return" (the chain helper\'s cap; the mock refuses more)', () => {
      const files = listTree(root).filter((p) => p.endsWith('mock/flagged-max.json')); const mx = files.map((p) => rj(path.join(root, p)).max).reduce((a, b) => Math.max(a, b), 0);
      ok(mx <= 20, `largest flagged count ${mx} (${files.length} mock folders)`);
    });
    try { wj(path.join(root, 'summaries.json'), SUMMARIES); } catch (e) { /* a convenience for the README */ }
  }
  if (ARGS.live) await liveSection(root);
  console.log(`\n${results.PASS} passed, ${results.FAIL} failed, ${results.SKIP} skipped (${Math.round((Date.now() - t0) / 1000)} s)${failed.length ? '\nFAILED: ' + failed.join(' | ') : ''}`);
  process.exitCode = results.FAIL ? 1 : 0;
})().catch((e) => { console.log('TEST HARNESS ERROR ' + (e && e.stack ? e.stack : e)); process.exitCode = 2; });
