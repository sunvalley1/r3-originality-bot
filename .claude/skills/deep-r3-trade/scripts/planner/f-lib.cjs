// planner/f-lib.cjs - step F's shared library (ported from the live F scripts that sized the first live run).
//
// Two parts:
// - The exact Uniswap v3 single-range swap math in BigInt, the price helpers and the wei <-> decimal helpers. These are
//   the live-proven functions, copied unchanged: on the live run the model reproduced every QuoterV2 answer to within
//   1.7e-17 relative over 627 comparisons.
// - The I/O layer: every chain read is a chain-helper `multicall` over a reads file under ./run/<run-id>/f-tmp/ (removed
//   once answered), through the planner's sequential runner (lib.runHelper: `rpcGapMs` spacing, `parallel` slots, a
//   rate-limit reply treated as transient). F's reads keep the live run's 9 re-runs after the first attempt. QuoterV2 is
//   called by `eth_call` inside the multicall, never in a transaction; a batch that ends call_reverted is halved down to
//   single sizes (F step 8).
// No key, no signing, no RPC contacted directly, no environment variable.
'use strict';

const lib = require('./lib.cjs');
const TB = require('./table.cjs');

const { ToolFailure } = lib;

const A = Object.freeze({
  sUSDS: TB.ADDR.sUSDS,
  USDS: TB.ADDR.USDS,
  USDC: TB.ADDR.USDC,
  PSM3: TB.ADDR.PSM3,
  QUOTER: TB.ADDR.QUOTER,
  FACTORY: TB.ADDR.FACTORY,
  WETH: TB.ADDR.WETH,
  GPO: '0x420000000000000000000000000000000000000F', // Optimism GasPriceOracle (l1BaseFee)
  MC3: TB.ADDR.MC3,
  ROUTER: TB.ADDR.ROUTER,
  SWAP: TB.ADDR.SWAP,
  PARENT: TB.ADDR.PARENT,
  PARENT_INVALID: TB.ADDR.PARENT_INVALID,
  WETH_USDC_500: '0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7b', // F step 7, verified 2026-10-02
});
const MIN_SQRT = 4295128740n; const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
const MIN_TICK = -887272; const MAX_TICK = 887272;

const lc = (s) => String(s).toLowerCase();
const rep = (k, v) => (typeof v === 'bigint' ? { $big: v.toString() } : v);
const rev = (k, v) => ((v && typeof v === 'object' && v.$big !== undefined) ? BigInt(v.$big) : v);
const ser = (o) => JSON.parse(JSON.stringify(o, rep));

// ---------------- exact Uniswap v3 single-range swap math (BigInt), matches pool.swap within one range ----------------
const Q96 = 1n << 96n;
const divUp = (a, b) => a / b + (a % b ? 1n : 0n);
const mulDivUp = (a, b, d) => divUp(a * b, d);
function amount0Delta(sA, sB, L, up) { if (sA > sB) [sA, sB] = [sB, sA]; const n1 = L << 96n; const n2 = sB - sA; return up ? divUp(mulDivUp(n1, n2, sB), sA) : (n1 * n2 / sB) / sA; }
function amount1Delta(sA, sB, L, up) { if (sA > sB) [sA, sB] = [sB, sA]; return up ? mulDivUp(L, sB - sA, Q96) : (L * (sB - sA)) / Q96; }
function nextFromAmount0(sP, L, amt, add) { if (amt === 0n) return sP; const n1 = L << 96n; const prod = amt * sP; const den = add ? n1 + prod : n1 - prod; if (den <= 0n) return null; return mulDivUp(n1, sP, den); }
function nextFromAmount1(sP, L, amt, add) { if (add) return sP + (amt * Q96) / L; const q = divUp(amt * Q96, L); return sP > q ? sP - q : null; }
// pool state: {sqrt (BigInt, pool order), L, fee (ppm), T0 (outcome is token0), loSqrt, hiSqrt (range edges as sqrt X96 approximations)}
// buy outcome T paying repo R. T0: R is token1 => oneForZero, sqrt rises.
function buyExactIn(st, amtIn) { // -> {out, sqrtAfter}
  const zfo = !st.T0; const f = BigInt(st.fee); const net = amtIn * (1000000n - f) / 1000000n;
  const sN = zfo ? nextFromAmount0(st.sqrt, st.L, net, true) : nextFromAmount1(st.sqrt, st.L, net, true); if (sN === null) return null;
  const out = zfo ? amount1Delta(sN, st.sqrt, st.L, false) : amount0Delta(st.sqrt, sN, st.L, false);
  return { out, sqrtAfter: sN };
}
function buyExactOut(st, cnt) { // -> {amtIn, sqrtAfter}
  const zfo = !st.T0; const f = BigInt(st.fee);
  const sN = zfo ? nextFromAmount1(st.sqrt, st.L, cnt, false) : nextFromAmount0(st.sqrt, st.L, cnt, false); if (sN === null) return null;
  const net = zfo ? amount0Delta(sN, st.sqrt, st.L, true) : amount1Delta(st.sqrt, sN, st.L, true);
  return { amtIn: net + mulDivUp(net, f, 1000000n - f), sqrtAfter: sN };
}
function sellExactIn(st, cnt) { // sell outcome T for R. T0: zeroForOne => sqrt falls
  const zfo = st.T0; const f = BigInt(st.fee); const net = cnt * (1000000n - f) / 1000000n;
  const sN = zfo ? nextFromAmount0(st.sqrt, st.L, net, true) : nextFromAmount1(st.sqrt, st.L, net, true); if (sN === null) return null;
  const out = zfo ? amount1Delta(sN, st.sqrt, st.L, false) : amount0Delta(st.sqrt, sN, st.L, false);
  return { out, sqrtAfter: sN };
}
// price of outcome T in repo tokens, from a pool sqrtPriceX96: (sqrt/2^96)^2 if T is token0 else its reciprocal (F step 1)
const sOfPool = (sq, T0) => { const s = Number(sq) / 2 ** 96; return T0 ? s : 1 / s; };
const priceOf = (sq, T0) => { const s = sOfPool(sq, T0); return s * s; };
// inside the initialized range? (float edge test; the quoter's initializedTicksCrossed has the last word)
const inRange = (st, sq) => sq > st.loSqrt && sq < st.hiSqrt;

// 15-significant-digit floor of a wei amount: such a decimal round-trips through a JSON number exactly, so G's
// "truncate the decimal string to 18 places" gives back the same wei and never exceeds the wei that was planned.
function floor15(w) { if (w <= 0n) return 0n; const s = w.toString(); if (s.length <= 15) return w; const keep = s.slice(0, 15); return BigInt(keep + '0'.repeat(s.length - 15)); }
const weiStr = (w) => { const neg = w < 0n; const a = neg ? -w : w; const s = a.toString().padStart(19, '0'); const i = s.slice(0, s.length - 18); const f = s.slice(s.length - 18).replace(/0+$/, ''); return (neg ? '-' : '') + i + (f ? '.' + f : ''); };
const fromWei = (w) => Number(weiStr(w)); // floor15 amounts convert exactly; others to nearest double
const toWeiStr = (s) => { const [i, f = ''] = String(s).split('.'); return BigInt(i + (f + '0'.repeat(18)).slice(0, 18)); };
const bigMax = (a, b) => (a > b ? a : b); const bigMin = (a, b) => (a < b ? a : b);
// Number (double) -> wei BigInt, floor, via exact decimal expansion
function numToWeiFloor(x) { if (!(x > 0)) return 0n; const s = x.toFixed(18); return toWeiStr(s); }
const wf = (w) => Number(weiStr(w));
// G's "float to wei": expand an exponent, truncate the decimal string to 18 places
function g18(x) { let s = String(x); if (/e/i.test(s)) s = Number(x).toFixed(30); const [i, fr = ''] = s.split('.'); return BigInt(i + (fr + '0'.repeat(18)).slice(0, 18)); }
// count = stake / quoted_fill, decimal division, truncated to 18 places (scaled integers; quoted_fill's expansion to 30 digits)
function scaled(x, d) { let s = String(x); if (/e/i.test(s)) s = Number(x).toFixed(40); const [i, fr = ''] = s.split('.'); return BigInt(i + (fr + '0'.repeat(d)).slice(0, d)); }
function gCount(stake, fill) { return scaled(stake, 18) * 10n ** 30n / scaled(fill, 30); }

// ---------------- QuoterV2 call shapes ----------------
const SIG_IN = 'quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)';
const SIG_OUT = 'quoteExactOutputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)';
const quoteCall = (r) => ({ to: A.QUOTER, signature: r.kind === 'in' ? SIG_IN : SIG_OUT, args: [[r.tokenIn, r.tokenOut, String(r.amt), r.fee, 0]] });
const parseQ = (res) => {
  const sq = BigInt(res[1]); const ticks = Number(res[2]);
  // F step 8 rules: reject an answer that crossed an initialized tick or ends at MIN/MAX ratio (a partial fill, not a quote)
  return { ok: ticks === 0 && sq !== MIN_SQRT && sq !== MAX_SQRT, amt: BigInt(res[0]), sqrtAfter: sq, ticks, gas: Number(res[3]) };
};

// ---------------- the I/O layer over the planner's helper runner ----------------
const F_RETRIES = 9; // the live F's transient re-runs (10 attempts in all), kept for F's many reads
const QUOTE_CHUNK = 120; // sizes per QuoterV2 multicall file (the live value)

function makeIO(ctx) {
  let seq = 0; let calls = 0; let lastBlock = null;
  const blocks = new Set();
  const stats = { quotes: 0, quoteBatches: 0, revertSplits: 0, singleReverts: 0 };
  const isRevert = (e) => e instanceof ToolFailure && (e.code === 'call_reverted' || e.helperExit === 8);

  // A helper subcommand other than multicall (fee-history, block, simulate). Returns its JSON.
  async function H(args) { calls++; return (await ctx.helper(args, { retries: F_RETRIES })).json; }
  // One multicall file: {block, results}. The printed block is the pin of every read in that file.
  async function mcb(reads) {
    const name = `f-tmp/m-${++seq}.json`;
    calls++;
    try {
      const r = await ctx.multicall(name, reads, { retries: F_RETRIES });
      lastBlock = r.block; blocks.add(r.block);
      return { block: r.block, results: r.results };
    } finally { try { ctx.removeRun(name); } catch (e) { /* the file is scratch; a failed removal is harmless */ } }
  }
  async function mc(reads) { return (await mcb(reads)).results; }
  async function mcChunked(reads, chunk) {
    const out = []; const parts = [];
    for (let i = 0; i < reads.length; i += chunk) parts.push(reads.slice(i, i + chunk));
    const rs = await Promise.all(parts.map((p) => mc(p)));
    rs.forEach((r) => out.push(...r));
    return out;
  }
  // reqs: [{kind:'in'|'out', tokenIn, tokenOut, amt(BigInt), fee}] -> [{ok, amt, sqrtAfter, ticks}]; a
  // quoteExactOutputSingle revert = infeasible (ok:false, reverted:true). The helper's multicall is allowFailure:false, so
  // a batch with one infeasible exact-output size fails whole: split it, down to single calls (F step 8).
  async function quotes(reqs) {
    const out = new Array(reqs.length);
    async function go(idx) {
      if (!idx.length) return;
      try {
        const res = await mc(idx.map((k) => quoteCall(reqs[k])));
        stats.quoteBatches++; idx.forEach((k, n) => { out[k] = parseQ(res[n]); stats.quotes++; });
      } catch (e) {
        if (!isRevert(e)) throw e;
        if (idx.length === 1) { out[idx[0]] = { ok: false, reverted: true }; stats.singleReverts++; return; }
        stats.revertSplits++; const h = idx.length >> 1; await Promise.all([go(idx.slice(0, h)), go(idx.slice(h))]);
      }
    }
    const parts = []; const all = reqs.map((_, k) => k);
    for (let i = 0; i < all.length; i += QUOTE_CHUNK) parts.push(all.slice(i, i + QUOTE_CHUNK));
    await Promise.all(parts.map(go));
    return out;
  }
  return {
    H, mcb, mc, mcChunked, quotes, stats, isRevert,
    getCalls: () => calls, blocksSeen: () => [...blocks].sort((a, b) => a - b), lastBlockSeen: () => lastBlock,
  };
}

// Block range of a list of block numbers, for one summary line.
function blockRange(bs) { const v = bs.filter((b) => Number.isInteger(b)); return v.length ? { min: Math.min(...v), max: Math.max(...v), distinct: new Set(v).size } : null; }

module.exports = {
  A, MIN_SQRT, MAX_SQRT, MIN_TICK, MAX_TICK, lc, rep, rev, ser,
  Q96, divUp, mulDivUp, amount0Delta, amount1Delta, buyExactIn, buyExactOut, sellExactIn, sOfPool, priceOf, inRange,
  floor15, weiStr, fromWei, toWeiStr, bigMax, bigMin, numToWeiFloor, wf, g18, scaled, gCount,
  SIG_IN, SIG_OUT, quoteCall, parseQ, F_RETRIES, QUOTE_CHUNK, makeIO, blockRange,
};
