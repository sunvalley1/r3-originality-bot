// planner/f-read.cjs - F steps 1 and 2 and step 7's gas inputs (ported from the live F read script).
//
// Inputs: candidates.json and blended.json of this run-id (blended must be the identity blend), checked against the
// embedded C-select table. Then, onchain through the chain helper only:
// - the 294 wrappedOutcome reads (one multicall), cross-checked with the saved data-function body when C built its
//   candidates from it;
// - the holder's balances in ONE multicall file (allowFailure false): the 98 repo tokens (held_j), the 98 child
//   Invalid (I_j), the three unsplit bundle tokens (b_X), sUSDS, USDC, USDS and their decimals, ETH, the parent
//   Invalid and the three middle Invalid (the middle Invalid addresses cross-checked with wrappedOutcome(n_X));
// - the pools of every tradeable market: getPool at the candidates.json fee tier, then slot0, liquidity, token0, fee
//   and tickSpacing in files of 100 reads = 10 whole markets, so BOTH pools of a market are in one file and therefore at
//   ONE block: that block is the market's pin (F step 1 on a live chain, where the head moves and no step compares
//   block numbers between reads);
// - each pool's active range [lo, hi): seeded from the body's ticks and checked onchain with ticks(lo) and ticks(hi)
//   (both initialized, liquidityNet +L / -L, equal to the body's, slot0 tick inside), exactly as on the live run; a pool
//   with no usable seed, or whose seed fails that check, takes evm-onchain's readInitializedTicks instead: the nearest
//   initialized ticks below and above the current tick, found from tickBitmap and checked with ticks();
// - the gas inputs of step 7 (WETH/USDC QuoterV2 quote, PSM3 previewSwapExactIn, l1BaseFee, fee-history);
// - with --provisional (a supervised session whose PSM3 ramp is queued but has not landed; never the wake, which sends
//   the ramp itself before F): PSM3 previewSwapExactIn of the holder's whole USDC and USDS into sUSDS, each floored to
//   minAmountOut = quote x 9999 / 10000 (I-setup.md I.1 section 5), and the provisional bankroll = sUSDS + both
//   (F-max-ev.md, intro). G refuses such a plan until the ramp has landed and F has re-run (its stale-susds stop).
// Returns the state object F sizes from (BigInt values kept; serialised with f-lib's rep).
'use strict';

const lib = require('./lib.cjs');
const TB = require('./table.cjs');
const FL = require('./f-lib.cjs');

const { Stop, clip } = lib;
const { A, lc } = FL;
const N = 98;
const ZERO_ADDR = /^0x0{40}$/;

const fstop = (cause, notes, fields = {}) => new Stop({ step: 'F', cause, status: 'aborted', notes: `F stop (no allocation written): ${notes}`, fields });

// The data-function body of this run-id, as a seed for tick ranges and a cross-check of identities. Not used when C
// built candidates.json from its onchain rebuild (a refused body is never a source), nor when it is missing or unusable.
function loadBody(ctx) {
  let cSource = null;
  if (ctx.existsRun('planner/c.json')) {
    try { const cj = ctx.readRunJson('planner/c.json'); if (cj && cj.summary && typeof cj.summary.source === 'string') cSource = cj.summary.source; } catch (e) { /* unreadable detail: the body's own checks decide */ }
  }
  if (cSource && cSource !== 'body') return { body: null, why: `C took its ${cSource}, so the saved body is not a source` };
  if (!ctx.existsRun('r3-data.json')) return { body: null, why: 'no saved data-function body for this run-id' };
  let body;
  try { body = JSON.parse(ctx.readRun('r3-data.json').toString('utf8')); } catch (e) { return { body: null, why: 'the saved body is not JSON' }; }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.prototype.hasOwnProperty.call(body, 'error') || !Array.isArray(body.markets) || !body.marketsData || typeof body.marketsData !== 'object' || !Array.isArray(body.parentWrappedTokens)) {
    return { body: null, why: 'the saved body is unusable (error field or malformed shape)' };
  }
  return { body, why: null };
}

// evm-onchain readInitializedTicks, the walk F needs: for each pool, the nearest initialized tick at or below the
// current tick (lo) and the nearest one above it (hi), from tickBitmap words read outward from the current word.
// Between two adjacent initialized ticks the pool's liquidity is constant, so [lo, hi) is the range the single-range
// model may use. list: [{key, pool, tick, spacing}] -> Map key -> {lo, hi} (null when a side has no initialized tick).
async function scanAdjacentTicks(io, list, log) {
  const st = list.map((p) => {
    const c = Math.floor(p.tick / p.spacing);
    return {
      ...p, c, w0: c >> 8, b0: c & 255,
      minW: Math.floor(FL.MIN_TICK / p.spacing) >> 8, maxW: Math.floor(FL.MAX_TICK / p.spacing) >> 8,
      nextB: c >> 8, nextA: c >> 8, lo: null, hi: null, doneB: false, doneA: false,
    };
  });
  const lowestBit = (x) => { let n = 0; while (!(x & 1n)) { x >>= 1n; n++; } return n; };
  const highestBit = (x) => x.toString(2).length - 1;
  let words = 0;
  for (let round = 0; round < 400; round++) {
    const K = round === 0 ? 16 : 64;
    const reads = []; const tags = [];
    for (const p of st) {
      if (!p.doneB) for (let n = 0; n < K && p.nextB >= p.minW; n++) { reads.push({ to: p.pool, signature: 'tickBitmap(int16)(uint256)', args: [p.nextB] }); tags.push({ p, dir: 'B', w: p.nextB }); p.nextB--; }
      if (!p.doneA) for (let n = 0; n < K && p.nextA <= p.maxW; n++) { reads.push({ to: p.pool, signature: 'tickBitmap(int16)(uint256)', args: [p.nextA] }); tags.push({ p, dir: 'A', w: p.nextA }); p.nextA++; }
    }
    if (!reads.length) break;
    words += reads.length;
    const res = await io.mcChunked(reads, 500);
    tags.forEach((t, n) => {
      const p = t.p; let word = BigInt(res[n][0]);
      if (t.dir === 'B') {
        if (p.doneB) return;
        if (t.w === p.w0) word &= (1n << BigInt(p.b0 + 1)) - 1n; // bits at or below the current tick
        if (word !== 0n) { p.lo = (t.w * 256 + highestBit(word)) * p.spacing; p.doneB = true; }
      } else {
        if (p.doneA) return;
        if (t.w === p.w0) word = (word >> BigInt(p.b0 + 1)) << BigInt(p.b0 + 1); // bits above the current tick
        if (word !== 0n) { p.hi = (t.w * 256 + lowestBit(word)) * p.spacing; p.doneA = true; }
      }
    });
    for (const p of st) { if (!p.doneB && p.nextB < p.minW) p.doneB = true; if (!p.doneA && p.nextA > p.maxW) p.doneA = true; }
    if (st.every((p) => p.doneB && p.doneA)) break;
  }
  log(`readInitializedTicks: ${list.length} pool(s), ${words} tickBitmap word(s) read`);
  return new Map(st.map((p) => [p.key, { lo: p.lo, hi: p.hi }]));
}

async function read(R) {
  const { ctx, io } = R;
  const say = (s) => ctx.log(s);

  // ---------- inputs ----------
  let C; let B;
  try { C = ctx.readRunJson('candidates.json'); } catch (e) { throw fstop('candidates-unreadable', `${ctx.rel('candidates.json')} is unreadable: ${clip(e.message, 200)}`); }
  try { B = ctx.readRunJson('blended.json'); } catch (e) { throw fstop('blended-unreadable', `${ctx.rel('blended.json')} is unreadable: ${clip(e.message, 200)}`); }
  const cands = C && C.candidates;
  if (!Array.isArray(cands) || cands.length !== N) throw fstop('malformed-input', `candidates.json holds ${cands && cands.length} rows, not ${N}`);
  cands.forEach((c, i) => {
    const t = TB.T.rows[i];
    if (!c || lc(c.address) !== t.address || lc(c.collateral_token) !== t.repo_token || c.market !== t.repo || !c.parent || lc(c.parent.address) !== lc(TB.bundleOf(t).middle) || c.parent.outcome_index !== t.slot) {
      throw fstop('malformed-input', `candidates.json row ${i} differs from the C-select table (address, repo token, market, middle or slot)`);
    }
  });
  if (!B || B.method !== 'identity' || !Array.isArray(B.blends)) throw fstop('malformed-input', `blended.json method ${JSON.stringify(B && B.method)} is not "identity" or blends[] is missing`);
  const byAddr = new Map(cands.map((c, i) => [lc(c.address), i]));
  const blend = new Array(N).fill(null); let matched = 0; const orphans = [];
  for (const b of B.blends) {
    if (!(b && b.w === 1 && Array.isArray(b.blended) && b.blended.length === 3 && Array.isArray(b.own) && b.blended.every((x, k) => x === b.own[k]))) throw fstop('malformed-input', `blend is not the identity for ${clip(b && b.market, 80)}`);
    const i = byAddr.get(lc(b.address)); if (i === undefined) { orphans.push({ market: String(b.market), address: lc(b.address) }); continue; }
    if (blend[i]) throw fstop('malformed-input', `duplicate blend ${b.market}`);
    blend[i] = { blended: b.blended, address: lc(b.address) }; matched++;
  }
  R.cands = cands; R.blends = B.blends;
  const tradeable = cands.map((c) => c.tradeable === true);
  const nTrade = tradeable.filter(Boolean).length;
  say(`inputs: candidates ${cands.length} (tradeable ${nTrade}), blends ${B.blends.length}, matched ${matched}, orphan blends ${orphans.length}, candidates without a blend ${N - matched}`);
  const fees = [...new Set(cands.flatMap((c) => (c.pools || []).map((p) => p.fee_tier)))]; say(`fee tiers in candidates.json: ${fees.join(',')}`);
  const holder = ctx.holder();
  const { body, why: bodyWhy } = loadBody(ctx);
  say(body ? 'the saved data-function body is used as the seed of tick ranges and as an identity cross-check' : `no data-function body: ${bodyWhy}; tick ranges come from readInitializedTicks onchain`);

  // ---------- addresses: a FRESH 294-read wrappedOutcome multicall, cross-checked with the body ----------
  const wcalls = []; cands.forEach((c) => [0, 1, 2].forEach((k) => wcalls.push({ to: c.address, signature: 'wrappedOutcome(uint256)(address)', args: [String(k)] })));
  const wr = await io.mc(wcalls);
  const wrapped = []; const repo = [];
  const mk = body ? new Map(body.markets.filter((m) => m && typeof m.id === 'string').map((m) => [lc(m.id), m])) : null;
  cands.forEach((c, i) => {
    const w2 = [0, 1, 2].map((k) => lc(wr[i * 3 + k][0]));
    if (w2.some((a) => ZERO_ADDR.test(a))) throw fstop('identity-changed', `wrappedOutcome returned the zero address for ${c.market}`);
    if (mk) {
      const m = mk.get(lc(c.address)); if (!m) throw fstop('identity-changed', `no data-function market for ${c.market}`);
      const w = Array.isArray(m.wrappedTokens) ? m.wrappedTokens.map(lc) : [];
      if (w.join() !== w2.join()) throw fstop('identity-changed', `wrapped tokens differ between the data function and the live wrappedOutcome reads at ${i} (${c.market})`);
      if (lc(m.collateralToken) !== lc(c.collateral_token)) throw fstop('identity-changed', `repo token differs at ${i} (${c.market})`);
    }
    wrapped.push(w2); repo.push(lc(c.collateral_token));
  });
  const bundles = {}; const middles = {}; const midInvalidTable = {};
  TB.T.bundles.forEach((b) => { bundles[b.name] = b.bundleToken; middles[b.name] = lc(b.middle); midInvalidTable[b.name] = b.middleInvalid; });
  if (body) {
    const pwt = body.parentWrappedTokens.map(lc);
    if (TB.PARENT_WRAPPED.some((a, k) => lc(a) !== pwt[k])) throw fstop('identity-changed', 'bundle tokens or the parent Invalid differ between the F table and the data function');
  }
  const bundleOf = cands.map((c, i) => TB.T.rows[i].bundle);
  const nX = { A: 0, B: 0, C: 0 }; bundleOf.forEach((x) => { nX[x]++; });
  say(`addresses: wrapped tokens from 294 live wrappedOutcome reads (one multicall)${body ? ', identical to r3-data.json for all 98' : ''}; bundle tokens from the F step 2 table; bundle sizes ${nX.A}/${nX.B}/${nX.C}`);

  // ---------- balances: ONE multicall file, allowFailure:false ----------
  const bal = (t) => ({ to: t, signature: 'balanceOf(address)(uint256)', args: [holder] });
  const calls = [];
  repo.forEach((t) => calls.push(bal(t))); // 0..97 held_j
  wrapped.forEach((w) => calls.push(bal(w[2]))); // 98..195 I_j (child Invalid)
  ['A', 'B', 'C'].forEach((x) => calls.push(bal(bundles[x]))); // 196..198 unsplit bundle tokens
  [A.sUSDS, A.USDC, A.USDS].forEach((t) => calls.push(bal(t))); // 199..201
  [A.sUSDS, A.USDC, A.USDS].forEach((t) => calls.push({ to: t, signature: 'decimals()(uint8)', args: [] })); // 202..204
  calls.push({ to: A.MC3, signature: 'getEthBalance(address)(uint256)', args: [holder] }); // 205
  calls.push(bal(A.PARENT_INVALID)); // 206
  ['A', 'B', 'C'].forEach((x) => calls.push(bal(midInvalidTable[x]))); // 207..209
  ['A', 'B', 'C'].forEach((x) => calls.push({ to: middles[x], signature: 'wrappedOutcome(uint256)(address)', args: [String(nX[x])] })); // 210..212
  const rb = await io.mcb(calls); const r = rb.results;
  const n = (k) => BigInt(r[k][0]);
  const held = repo.map((_, j) => n(j)); const childInv = repo.map((_, j) => n(98 + j)); const bundleBal = [n(196), n(197), n(198)];
  const susds = n(199); const usdc = n(200); const usds = n(201); const decs = [202, 203, 204].map((k) => Number(r[k][0])); const eth = n(205);
  const parentInvBal = n(206); const midInvBal = [n(207), n(208), n(209)];
  ['A', 'B', 'C'].forEach((x, k) => { if (lc(r[210 + k][0]) !== lc(midInvalidTable[x])) throw fstop('identity-changed', `middle ${x} Invalid: live wrappedOutcome(${nX[x]}) ${r[210 + k][0]} != the table's ${midInvalidTable[x]}`); });
  if (decs.join() !== '18,6,18') throw fstop('identity-changed', `unexpected decimals sUSDS/USDC/USDS ${decs.join('/')}`);
  // held_j for the budget: the repo token held plus the unsplit tokens of its bundle, which G middle-splits first (F step 6)
  const bIdx = { A: 0, B: 1, C: 2 };
  const heldEff = held.map((h, j) => h + bundleBal[bIdx[bundleOf[j]]]);
  say(`BALANCES of ${holder} @ block ${rb.block} (one multicall, ${calls.length} reads, allowFailure:false):`);
  say(`  sUSDS ${susds} (${FL.weiStr(susds)}), USDC ${usdc}, USDS ${usds}, decimals ${decs.join('/')}, ETH ${eth} wei (${FL.weiStr(eth)})`);
  say(`  unsplit bundle tokens A/B/C ${bundleBal.join('/')}; parent Invalid ${parentInvBal}; middle Invalid A/B/C ${midInvBal.join('/')}; sum held_j (repo tokens) ${held.reduce((a, b) => a + b, 0n)}; sum I_j (child Invalid) ${childInv.reduce((a, b) => a + b, 0n)}; markets with held_j>0: ${held.filter((x) => x > 0n).length}, with I_j>0: ${childInv.filter((x) => x > 0n).length}`);
  const rampDue = usdc !== 0n || usds !== 0n;
  if (rampDue) say(R.provisional ? 'NOTE: USDC or USDS held and --provisional given: the bankroll is provisional, the sUSDS balance plus PSM3 minAmountOut of all USDC and USDS (F-max-ev.md, intro)' : 'NOTE: USDC or USDS held: a PSM3 ramp is due before F (I-setup.md I.1 section 5, I.2 section 2 Half A); this plan sizes on the sUSDS balance alone (a supervised session passes --provisional to size on the queued ramp)');
  else say('  USDC and USDS are both 0: no PSM3 ramp; the bankroll is the whole sUSDS balance');

  // ---------- pools of the tradeable markets: getPool, then slot0/liquidity/token0/fee/tickSpacing ----------
  const tIdx = cands.map((c, i) => i).filter((i) => tradeable[i]);
  const meta = [];
  tIdx.forEach((i) => ['DOWN', 'UP'].forEach((side, k) => {
    const pe = (cands[i].pools || []).find((p) => p.outcome === side);
    if (!pe || !Number.isInteger(pe.fee_tier)) throw fstop('malformed-input', `tradeable ${cands[i].market} has no ${side} pool entry in candidates.json`);
    meta.push({ i, side, tok: wrapped[i][k], fee: pe.fee_tier });
  }));
  const gp = meta.length ? await io.mcChunked(meta.map((m) => ({ to: A.FACTORY, signature: 'getPool(address,address,uint24)(address)', args: [m.tok, repo[m.i], m.fee] })), 200) : [];
  meta.forEach((m, k) => { m.pool = lc(gp[k][0]); if (ZERO_ADDR.test(m.pool)) throw fstop('pool-missing', `no pool at fee tier ${m.fee} for ${cands[m.i].market} ${m.side} (rescan 500/3000/10000 per evm-onchain)`); });
  say(`getPool: all ${meta.length} pools of the ${tIdx.length} tradeable markets found at their candidates.json fee tier; ${new Set(meta.map((m) => m.pool)).size} distinct`);
  const pc = [];
  meta.forEach((m) => ['slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)', 'liquidity()(uint128)', 'token0()(address)', 'fee()(uint24)', 'tickSpacing()(int24)'].forEach((sg) => pc.push({ to: m.pool, signature: sg, args: [] })));
  // 10 calls per market (2 pools x 5 reads), files of 100 = 10 whole markets, so BOTH pools of a market are always in
  // one multicall file and therefore at ONE block: that block is this market's pin (F step 1 on a live chain).
  const pr = []; const chunkBlocks = [];
  for (let off = 0; off < pc.length; off += 100) {
    const rr = await io.mcb(pc.slice(off, off + 100));
    chunkBlocks.push({ firstMarket: Math.floor(off / 10), nMarkets: Math.ceil(Math.min(100, pc.length - off) / 10), block: rr.block });
    pr.push(...rr.results);
  }
  const pinOfMarket = new Array(N).fill(null);
  chunkBlocks.forEach((cb) => { for (let q = 0; q < cb.nMarkets; q++) pinOfMarket[tIdx[cb.firstMarket + q]] = cb.block; });
  if (tIdx.some((i) => !pinOfMarket[i])) throw fstop('read-failed', `per-market pin block missing: ${clip(JSON.stringify(chunkBlocks), 300)}`);
  const pins = tIdx.map((i) => pinOfMarket[i]);
  if (pins.length) say(`pool state read in ${chunkBlocks.length} multicall files, pair-aligned: each market's two pools share one block (pins ${Math.min(...pins)}..${Math.max(...pins)}, ${new Set(pins).size} distinct)`);
  const dataPool = (m) => {
    if (!body) return null;
    const key = Object.keys(body.marketsData).find((k) => body.marketsData[k] && lc(body.marketsData[k].id) === lc(cands[m.i].address));
    const v = key === undefined ? null : body.marketsData[key];
    return v ? (m.side === 'UP' ? v.upPool : v.downPool) : null;
  };
  let t0mis = 0; let liqDiff = 0; let tickDiff = 0; let feeBad = 0;
  meta.forEach((m, k) => {
    const b = k * 5; const s0 = pr[b];
    m.sqrt = BigInt(s0[0]); m.tick = Number(s0[1]); m.obsIndex = Number(s0[2]); m.obsCard = Number(s0[3]); m.obsNext = Number(s0[4]); m.feeProtocol = Number(s0[5]); m.unlocked = s0[6];
    m.L = BigInt(pr[b + 1][0]); m.token0 = lc(pr[b + 2][0]); m.feeOnchain = Number(pr[b + 3][0]); m.spacing = Number(pr[b + 4][0]);
    if (m.token0 !== m.tok && m.token0 !== repo[m.i]) throw fstop('identity-changed', `token0 is neither the outcome token nor the repo token: ${cands[m.i].market} ${m.side}`);
    m.T0 = m.token0 === m.tok;
    if (m.feeOnchain !== m.fee) feeBad++;
    if (!(m.spacing > 0)) throw fstop('read-failed', `tickSpacing ${m.spacing} for ${cands[m.i].market} ${m.side}`);
    const dp = dataPool(m);
    m.dataTicks = dp && Array.isArray(dp.ticks) ? dp.ticks.map((t) => ({ tickIdx: Number(t.tickIdx), net: BigInt(t.liquidityNet) })).sort((a, b2) => a.tickIdx - b2.tickIdx) : null;
    if (dp) { if (lc(dp.token0) !== m.token0) t0mis++; if (String(dp.liquidity) !== String(m.L)) liqDiff++; if (Number(dp.tick) !== m.tick) tickDiff++; }
    const pe = cands[m.i].pools.find((p) => p.outcome === m.side); m.snap = pe.price;
  });
  if (feeBad) throw fstop('identity-changed', `${feeBad} pool(s) answer fee() different from their candidates.json fee tier`);
  say(`pools onchain: fee()==fee_tier on all: true; tickSpacing ${[...new Set(meta.map((m) => m.spacing))].join(',')}; L==0 pools ${meta.filter((m) => m.L === 0n).length}; unlocked all ${meta.every((m) => m.unlocked)}${body ? `; vs data function: token0 mismatches ${t0mis}, liquidity differing ${liqDiff}, tick differing ${tickDiff}` : ''}`);

  // ---------- each pool's active range: the body's two ticks checked onchain, else readInitializedTicks ----------
  const seeded = []; const rangeTicks = [];
  meta.forEach((m, k) => { if (m.dataTicks && m.dataTicks.length === 2) { seeded.push(k); m.dataTicks.forEach((t) => rangeTicks.push({ k, t: t.tickIdx })); } });
  const TICKS_SIG = 'ticks(int24)(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)';
  const tr = rangeTicks.length ? await io.mcChunked(rangeTicks.map((x) => ({ to: meta[x.k].pool, signature: TICKS_SIG, args: [x.t] })), 80) : [];
  meta.forEach((m) => { m.chainTicks = []; });
  rangeTicks.forEach((x, q) => meta[x.k].chainTicks.push({ tickIdx: x.t, net: BigInt(tr[q][1]), initialized: tr[q][7] }));
  let good = 0; const needScan = [];
  meta.forEach((m, k) => {
    const ct = m.chainTicks.sort((a, b) => a.tickIdx - b.tickIdx);
    const ok = !!m.dataTicks && ct.length === 2 && ct.every((t) => t.initialized) && ct[0].net === m.L && ct[1].net === -m.L && m.tick >= ct[0].tickIdx && m.tick < ct[1].tickIdx
      && ct[0].net === m.dataTicks[0].net && ct[1].net === m.dataTicks[1].net;
    if (ok) { good++; m.lo = ct[0].tickIdx; m.hi = ct[1].tickIdx; m.rangeSource = 'data-function ticks, checked onchain'; m.singleRange = true; }
    else { needScan.push(k); if (m.dataTicks) say(`range seed rejected for ${cands[m.i].market} ${m.side}: ${JSON.stringify(ct.map((t) => [t.tickIdx, String(t.net), t.initialized]))} L ${m.L} tick ${m.tick}; readInitializedTicks instead`); }
  });
  if (body) say(`tick cross-check (data-function ticks vs onchain ticks(lower)/ticks(upper)): ${good}/${meta.length} pools one range [lower,upper], both ticks initialized, liquidityNet +L/-L equal to the data function's and to liquidity(), slot0 tick inside; ${needScan.length} to readInitializedTicks`);
  if (needScan.length) {
    const found = await scanAdjacentTicks(io, needScan.map((k) => ({ key: k, pool: meta[k].pool, tick: meta[k].tick, spacing: meta[k].spacing })), say);
    const nk = []; needScan.forEach((k) => { const f = found.get(k); if (f.lo === null || f.hi === null) throw fstop('range-unreadable', `readInitializedTicks found no initialized tick ${f.lo === null ? 'at or below' : 'above'} the current tick of ${cands[meta[k].i].market} ${meta[k].side}`); meta[k].lo = f.lo; meta[k].hi = f.hi; nk.push({ k, t: f.lo }, { k, t: f.hi }); });
    const tr2 = await io.mcChunked(nk.map((x) => ({ to: meta[x.k].pool, signature: TICKS_SIG, args: [x.t] })), 80);
    const scanTicks = new Map(); nk.forEach((x, q) => { const a = scanTicks.get(x.k) || []; a.push({ tickIdx: x.t, net: BigInt(tr2[q][1]), initialized: tr2[q][7] }); scanTicks.set(x.k, a); });
    for (const k of needScan) {
      const m = meta[k]; const ct = scanTicks.get(k).sort((a, b) => a.tickIdx - b.tickIdx);
      if (!(ct.length === 2 && ct.every((t) => t.initialized) && m.tick >= ct[0].tickIdx && m.tick < ct[1].tickIdx && m.L > 0n)) throw fstop('range-unreadable', `readInitializedTicks gave an inconsistent range for ${cands[m.i].market} ${m.side}: ${JSON.stringify(ct.map((t) => [t.tickIdx, String(t.net), t.initialized]))} tick ${m.tick} L ${m.L}`);
      m.chainTicks = ct; m.rangeSource = 'readInitializedTicks (tickBitmap)'; m.singleRange = ct[0].net === m.L && ct[1].net === -m.L;
    }
    say(`readInitializedTicks: ${needScan.length} pool(s) ranged onchain; ${needScan.filter((k) => meta[k].singleRange).length} of them one range (+L/-L)`);
  }

  // ---------- gas inputs (F step 7) ----------
  const g = await io.mc([
    { to: A.QUOTER, signature: FL.SIG_IN, args: [[A.WETH, A.USDC, '1000000000000000000', 500, 0]] },
    { to: A.FACTORY, signature: 'getPool(address,address,uint24)(address)', args: [A.WETH, A.USDC, 500] },
    { to: A.PSM3, signature: 'previewSwapExactIn(address,address,uint256)(uint256)', args: [A.sUSDS, A.USDS, '1000000000000000000'] },
    { to: A.GPO, signature: 'l1BaseFee()(uint256)', args: [] },
  ]);
  // the provisional bankroll (supervised, --provisional, a ramp queued): sUSDS + minAmountOut of each non-zero asset
  let provisional = null;
  if (R.provisional && rampDue) {
    const assets = [['USDC', A.USDC, usdc], ['USDS', A.USDS, usds]].filter(([, , amt]) => amt > 0n);
    const pq = await io.mc(assets.map(([, tok, amt]) => ({ to: A.PSM3, signature: 'previewSwapExactIn(address,address,uint256)(uint256)', args: [tok, A.sUSDS, amt.toString()] })));
    const minOut = {}; assets.forEach(([name], k) => { minOut[name] = BigInt(pq[k][0]) * 9999n / 10000n; });
    provisional = { susds: susds, usdc_raw: usdc, usds_raw: usds, usdc_min_out: minOut.USDC || 0n, usds_min_out: minOut.USDS || 0n };
    provisional.bankroll = susds + provisional.usdc_min_out + provisional.usds_min_out;
    say(`provisional bankroll: sUSDS ${FL.weiStr(susds)} + minAmountOut ${FL.weiStr(provisional.usdc_min_out)} (all USDC) + ${FL.weiStr(provisional.usds_min_out)} (all USDS) = ${FL.weiStr(provisional.bankroll)} sUSDS`);
  }
  const usdPerEth = Number(g[0][0]) / 1e6; const usdPerSusds = Number(BigInt(g[2][0])) / 1e18; const susdsPerEth = usdPerEth / usdPerSusds;
  if (!(usdPerEth > 0) || !(usdPerSusds > 0)) throw fstop('read-failed', `gas inputs: USD per ETH ${usdPerEth}, usdPerSusds ${usdPerSusds}`);
  const fh = await io.H(['fee-history']);
  const bnow = await io.H(['block', 'latest']);
  const wethPoolOk = lc(g[1][0]) === lc(A.WETH_USDC_500);
  say(`gas inputs: WETH/USDC fee500 pool ${g[1][0]} (expected ${A.WETH_USDC_500}: ${wethPoolOk}); USD per ETH ${usdPerEth}; usdPerSusds ${usdPerSusds}; sUSDS per ETH ${susdsPerEth}; l1BaseFee ${g[3][0]} wei; eth_gasPrice ${fh.gas_price} wei; head base_fee_per_gas ${bnow.base_fee_per_gas}, fee-history next_base_fee ${fh.next_base_fee_per_gas}`);
  const GAS_LEG_ETH = 2.4e-7; // F step 7's figure (F simulates nothing)
  const gasLegSusds = GAS_LEG_ETH * susdsPerEth; const gasLegRepo = gasLegSusds * N;
  say(`gas_i = ${GAS_LEG_ETH} ETH/leg = ${gasLegSusds} sUSDS = ${gasLegRepo} repo tokens (x98 at the labelled 1/N)`);

  const poolsArr = new Array(2 * N).fill(null);
  meta.forEach((m) => {
    poolsArr[m.i * 2 + (m.side === 'UP' ? 1 : 0)] = {
      i: m.i, side: m.side, pool: m.pool, tok: m.tok, fee: m.fee, sqrt: m.sqrt, tick: m.tick, L: m.L, T0: m.T0, spacing: m.spacing, lo: m.lo, hi: m.hi,
      obsIndex: m.obsIndex, obsCard: m.obsCard, obsNext: m.obsNext, feeProtocol: m.feeProtocol, unlocked: m.unlocked, snap: m.snap,
      rangeSource: m.rangeSource, singleRange: m.singleRange, block: pinOfMarket[m.i],
    };
  });
  return {
    run_id: ctx.runId,
    block: io.lastBlockSeen(), pinOfMarket, chunkBlocks, holder, repo, wrapped, bundleOf, bundles, middles,
    blendAddr: blend.map((b) => (b ? b.address : null)), blendMatched: matched, orphans, tradeable,
    body_used: !!body, body_why: bodyWhy,
    balances: { sUSDS: susds, USDC: usdc, USDS: usds, eth, bundles: bundleBal, held, heldEff, childInv, parentInvalid: parentInvBal, middleInvalid: midInvBal, block: rb.block },
    rampDue,
    provisional, provisionalBankroll: provisional ? provisional.bankroll : null,
    pools: poolsArr,
    gas: { usdPerEth, usdPerSusds, susdsPerEth, GAS_LEG_ETH, gasLegSusds, gasLegRepo, l1BaseFee: String(g[3][0]), gasPrice: fh.gas_price, headBaseFee: bnow.base_fee_per_gas, headBlock: bnow.number, wethUsdcPool: lc(g[1][0]), wethUsdcPoolOk: wethPoolOk },
  };
}

module.exports = { read, scanAdjacentTicks, loadBody, fstop };
