// planner/g-read.cjs - G's fresh read (ported from the live g-read): the holder's nonce, the inputs, the onchain identity of
// every market with a row, both pools of each market in ONE multicall file (one block: the market's pin), the pool-drift
// report against F's own read (planner/f-state.json), the holder's balances in ONE multicall file, and the trading
// boundary with the block timestamp in the same multicall (C-select.md step 4).
//
// The boundary gates each child with a row (G section 3: an entry send is gated on its child). A middle or the parent
// that has already resolved refuses nothing here: a child of a resolved middle stays tradeable while its middle's
// numerator at its slot is nonzero (C-select.md step 4: a middle-settled repo is C's boundary, never G's), and
// splitPosition does not check resolution. The middles' and the parent's own reading (payoutDenominator, and each of
// their questions' arbitration, finalize and opening times) is recorded as the plan-time reading of the mint groups;
// the executor stops a mint group only on a flip since that reading.
//
// The head moves: nothing here compares the blocks of two reads. The drift report lists the pools whose slot0 or
// liquidity differ from F's read and refuses nothing by itself (G section 8, The head moves); each call's own floor and
// the pre-send re-check are what guard a send. Holdings are recorded, never refused (G section 1: the balance read is a
// record, not a refusal): every balance read here is the start state the plan's end state is predicted from.
'use strict';

const lib = require('./lib.cjs');
const TB = require('./table.cjs');
const FL = require('./f-lib.cjs');
const { loadBody } = require('./f-read.cjs');
const G = require('./g-lib.cjs');

const { clip } = lib;
const { A, lc, gstop } = G;
const ZERO = /^0x0{40}$/;
const SLOT0 = 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)';

async function read(R) {
  const { ctx, io } = R;
  const say = (s) => ctx.log(s);
  const holder = ctx.holder();

  // ---------- nonce: latest == pending (a pending transaction is a safety refusal) ----------
  const head = await io.H(['block', 'latest']);
  const nonce = await G.checkNonce(io, holder, null, 'G read');
  say(`live head ${head.number}; holder ${holder} nonce latest ${nonce.latest} pending ${nonce.pending}`);

  // ---------- inputs ----------
  let ALLOC; let C; let FS;
  try { ALLOC = ctx.readRunJson('allocation.json'); } catch (e) { throw gstop('allocation-unreadable', `${ctx.rel('allocation.json')} is unreadable: ${clip(e.message, 200)}`); }
  try { C = ctx.readRunJson('candidates.json'); } catch (e) { throw gstop('candidates-unreadable', `${ctx.rel('candidates.json')} is unreadable: ${clip(e.message, 200)}`); }
  try { FS = JSON.parse(ctx.readRun('planner/f-state.json').toString('utf8'), FL.rev); } catch (e) { throw gstop('f-state-unreadable', `${ctx.rel('planner/f-state.json')} (F's own read, the base of the drift report) is unreadable: ${clip(e.message, 200)}; run F with the planner first`); }
  if (!ALLOC || !Array.isArray(ALLOC.positions) || !ALLOC.totals || typeof ALLOC.totals.staked !== 'number') throw gstop('malformed-input', 'allocation.json lacks positions[] or totals.staked');
  const cands = C && C.candidates;
  if (!Array.isArray(cands) || cands.length !== G.N) throw gstop('malformed-input', `candidates.json holds ${cands && cands.length} rows, not ${G.N}`);
  cands.forEach((c, i) => {
    const t = TB.T.rows[i];
    if (!c || lc(c.address) !== t.address || lc(c.collateral_token) !== t.repo_token || c.market !== t.repo || !c.parent || lc(c.parent.address) !== lc(TB.bundleOf(t).middle) || c.parent.outcome_index !== t.slot) {
      throw gstop('malformed-input', `candidates.json row ${i} differs from the C-select table (address, repo token, market, middle or slot)`);
    }
  });
  if (!Array.isArray(FS.wrapped) || FS.wrapped.length !== G.N || !Array.isArray(FS.pools)) throw gstop('malformed-input', 'planner/f-state.json lacks wrapped[] or pools[]');
  const { body, why: bodyWhy } = loadBody(ctx);
  const byAddr = new Map(cands.map((c, i) => [lc(c.address), i]));

  // ---------- the rows, grouped per market (allocation order); a route or side F does not write is refused ----------
  const rowsBy = new Map(); const refused = []; const bundlesWithPosition = new Set();
  for (const p of ALLOC.positions) {
    const a = lc(p && p.address); const i = byAddr.get(a);
    if (i !== undefined) bundlesWithPosition.add(TB.T.rows[i].bundle); // "at least one position": read off allocation.json (G section 1)
    const okRoute = p && ((p.side === 'UP' || p.side === 'DOWN') ? p.route === 'direct' : (p.side === 'set' && (p.route === 'set-sell' || p.route === 'merge-arb')));
    if (i === undefined || !okRoute) { refused.push({ market: p && p.market, address: a, side: p && p.side, route: p && p.route, stake: p && p.stake, reason: i === undefined ? 'unknown market (not in candidates.json)' : 'unknown route or side' }); continue; }
    if (!rowsBy.has(a)) rowsBy.set(a, { i, rows: {} });
    const e = rowsBy.get(a);
    if (e.rows[p.side]) throw gstop('malformed-input', `two ${p.side} rows on ${p.market}`);
    e.rows[p.side] = p;
  }
  say(`allocation: ${ALLOC.positions.length} rows over ${rowsBy.size} markets; refused (route, side or market F does not write): ${refused.length}; bundles with a position: ${[...bundlesWithPosition].sort().join(',') || 'none'}`);

  const mkts = [];
  for (const [a, e] of rowsBy) {
    const i = e.i; const c = cands[i]; const t = TB.T.rows[i];
    const fee = {}; for (const s of ['DOWN', 'UP']) { const pe = (c.pools || []).find((p) => p.outcome === s); if (!pe || !Number.isInteger(pe.fee_tier)) throw gstop('malformed-input', `${c.market} has no ${s} pool entry in candidates.json`); fee[s] = pe.fee_tier; }
    mkts.push({ i, name: c.market, addr: a, repo: lc(c.collateral_token), bundle: t.bundle, slot: t.slot, rows: e.rows, fee });
  }

  // ---------- onchain identity: wrappedOutcome(0..2), conditionId(), questionsIds(), parentOutcome(), parentMarket() ----------
  const idCalls = [];
  mkts.forEach((m) => {
    for (let k = 0; k < 3; k++) idCalls.push({ to: m.addr, signature: 'wrappedOutcome(uint256)(address)', args: [String(k)] });
    idCalls.push({ to: m.addr, signature: 'conditionId()(bytes32)' }, { to: m.addr, signature: 'questionsIds()(bytes32[])' }, { to: m.addr, signature: 'parentOutcome()(uint256)' }, { to: m.addr, signature: 'parentMarket()(address)' });
  });
  const pmTargets = [...G.XS.map((x) => G.MIDDLES[x]), A.PARENT];
  const pmCalls = pmTargets.map((to) => ({ to, signature: 'conditionId()(bytes32)' }));
  const idBlocks = [];
  const ir = mkts.length ? await io.mcChunked(idCalls, 140, idBlocks) : [];
  const pmr = await io.mc(pmCalls);
  const pmq = await io.mc(pmTargets.map((to) => ({ to, signature: 'questionsIds()(bytes32[])' })));
  const mkBody = body ? new Map(body.markets.filter((m) => m && typeof m.id === 'string').map((m) => [lc(m.id), m])) : null;
  mkts.forEach((m, n) => {
    const b = n * 7;
    m.wrapped = [0, 1, 2].map((k) => lc(ir[b + k][0]));
    if (m.wrapped.some((w) => ZERO.test(w))) throw gstop('identity-changed', `wrappedOutcome returned the zero address for ${m.name}`);
    if (m.wrapped.join() !== FS.wrapped[m.i].map(lc).join()) throw gstop('identity-changed', `wrapped tokens of ${m.name} differ from F's own read`);
    if (mkBody) { const d = mkBody.get(m.addr); if (!d || !Array.isArray(d.wrappedTokens) || d.wrappedTokens.map(lc).join() !== m.wrapped.join() || lc(d.collateralToken) !== m.repo || Number(d.parentOutcome) !== m.slot) throw gstop('identity-changed', `the data function's row for ${m.name} differs from the onchain reads`); }
    m.down = m.wrapped[0]; m.up = m.wrapped[1]; m.inv = m.wrapped[2];
    m.cond = ir[b + 3][0]; m.qids = ir[b + 4][0]; m.qid = Array.isArray(m.qids) ? m.qids[0] : null;
    if (Number(ir[b + 5][0]) !== m.slot || lc(ir[b + 6][0]) !== G.MIDDLES[m.bundle]) throw gstop('identity-changed', `parentOutcome/parentMarket of ${m.name} differ from the C-select table`);
    if (!m.qid || /^0x0+$/.test(m.qid)) throw gstop('identity-changed', `questionsIds()[0] of ${m.name} is empty`);
  });
  const pmConds = { A: pmr[0][0], B: pmr[1][0], C: pmr[2][0], parent: pmr[3][0] };
  for (const k of Object.keys(pmConds)) if (lc(pmConds[k]) !== lc(TB.CONDITIONS[k])) throw gstop('identity-changed', `conditionId of the ${k === 'parent' ? 'parent' : 'middle ' + k} ${pmConds[k]} differs from SKILL.md's ${TB.CONDITIONS[k]}`);
  say(`onchain identity: wrappedOutcome(0..2) equals F's own read${body ? ' and the data function' : ''} for all ${mkts.length} markets; parentOutcome == slot and parentMarket == the bundle's middle; questionsIds()[0] nonzero; the parent's and middles' conditionId equal SKILL.md's`);

  // ---------- pools: getPool at the candidates.json tier, then both pools of a market in ONE multicall file ----------
  const meta = [];
  mkts.forEach((m, n) => ['DOWN', 'UP'].forEach((side) => meta.push({ n, side, tok: side === 'DOWN' ? m.down : m.up, fee: m.fee[side] })));
  const gp = meta.length ? await io.mcChunked(meta.map((p) => ({ to: A.FACTORY, signature: 'getPool(address,address,uint24)(address)', args: [p.tok, mkts[p.n].repo, p.fee] })), 140) : [];
  meta.forEach((p, k) => { p.pool = lc(gp[k][0]); if (ZERO.test(p.pool)) throw gstop('pool-missing', `no pool at fee tier ${p.fee} for ${mkts[p.n].name} ${p.side}`); });
  const pc = [];
  meta.forEach((p) => [SLOT0, 'liquidity()(uint128)', 'token0()(address)', 'fee()(uint24)'].forEach((sg) => pc.push({ to: p.pool, signature: sg, args: [] })));
  // 8 reads per market (2 pools x 4), files of 96 = 12 whole markets: both pools of a market share one block, its pin.
  const pr = []; const pinOf = new Array(mkts.length).fill(null);
  for (let off = 0; off < pc.length; off += 96) {
    const r = await io.mcb(pc.slice(off, off + 96));
    for (let q = off / 8; q < Math.min(mkts.length, (off + 96) / 8); q++) pinOf[q] = r.block;
    pr.push(...r.results);
  }
  meta.forEach((p, k) => {
    const b = k * 4; const m = mkts[p.n];
    p.sqrt = BigInt(pr[b][0]); p.tick = Number(pr[b][1]); p.unlocked = pr[b][6]; p.L = BigInt(pr[b + 1][0]); p.token0 = lc(pr[b + 2][0]); p.feeOnchain = Number(pr[b + 3][0]);
    const T0calc = BigInt(p.tok) < BigInt(m.repo); // Uniswap sorts the pair by address
    if (p.token0 !== (T0calc ? p.tok : m.repo)) throw gstop('identity-changed', `token0 of ${m.name} ${p.side} is not the address-sorted token`);
    p.T0 = T0calc;
    if (p.feeOnchain !== p.fee) throw gstop('identity-changed', `fee() of ${m.name} ${p.side} is ${p.feeOnchain}, not the candidates.json tier ${p.fee}`);
    if (p.L === 0n || p.unlocked !== true) throw gstop('pool-unusable', `${m.name} ${p.side} pool has no liquidity or is locked: the plan is stale, rebuild from F`);
    m.pool = m.pool || {}; m.slot0 = m.slot0 || {};
    m.pool[p.side] = p.pool; m.slot0[p.side] = { sqrt: p.sqrt, tick: p.tick, L: p.L, T0: p.T0 };
  });
  mkts.forEach((m, n) => { m.pin = pinOf[n]; m.spot = { UP: G.spotOf(m.slot0.UP.sqrt, m.slot0.UP.T0), DOWN: G.spotOf(m.slot0.DOWN.sqrt, m.slot0.DOWN.T0) }; m.spot.sum = m.spot.UP + m.spot.DOWN; });
  const pins = pinOf.filter((x) => Number.isInteger(x));
  say(`pools: ${meta.length} (getPool at the candidates.json tier ${[...new Set(meta.map((p) => p.fee))].join('/') || '-'}), all with liquidity, unlocked, fee() == tier, token0 == the address-sorted token; each market's two pools read in one multicall file (pins ${pins.length ? Math.min(...pins) + '..' + Math.max(...pins) : '-'})`);

  // ---------- the pool-drift report: G's read against F's (reported, never a stop by itself) ----------
  const moved = [];
  meta.forEach((p) => {
    const m = mkts[p.n]; const f = FS.pools[m.i * 2 + (p.side === 'UP' ? 1 : 0)];
    if (!f || lc(f.pool) !== p.pool) { moved.push({ market: m.name, side: p.side, pool: p.pool, why: f ? 'F read another pool' : 'not in F\'s read' }); return; }
    if (BigInt(f.sqrt) !== p.sqrt || Number(f.tick) !== p.tick || BigInt(f.L) !== p.L) {
      const was = FL.priceOf(BigInt(f.sqrt), p.T0); const now = FL.priceOf(p.sqrt, p.T0);
      moved.push({ market: m.name, side: p.side, pool: p.pool, f_block: f.block === undefined ? null : f.block, g_block: m.pin, tick: [Number(f.tick), p.tick], rel_price_change: now / was - 1, L: [String(f.L), String(p.L)], L_changed: BigInt(f.L) !== p.L });
    }
  });
  const drift = { pools_compared: meta.length, pools_moved: moved.length, markets_moved: [...new Set(moved.map((x) => x.market))], moved, f_pins: FL.blockRange(FS.pinOfMarket || []), g_pins: FL.blockRange(pins), note: 'G section 8, The head moves: a moved pool is reported, never stale by itself; each call carries its own floor and the pre-send re-check decides' };
  ctx.writeRunJson('planner/g-drift.json', drift, { indent: 1 });
  say(`pool drift since F sized the plan: ${moved.length} of ${meta.length} pools moved, on ${drift.markets_moved.length} market(s)${moved.length ? ': ' + clip(JSON.stringify(moved.slice(0, 6)), 900) : ''}`);

  // ---------- holder balances: ONE multicall file ----------
  const bal = (t) => ({ to: t, signature: 'balanceOf(address)(uint256)', args: [holder] });
  const tokens = [['sUSDS', A.sUSDS], ['USDC', A.USDC], ['USDS', A.USDS], ...G.XS.map((x) => ['bundle' + x, G.BUNDLES[x]]), ['parentInvalid', A.PARENT_INVALID], ...G.XS.map((x) => ['middleInvalid' + x, G.MID_INV[x]])];
  mkts.forEach((m) => { tokens.push(['repo:' + m.name, m.repo], ['DOWN:' + m.name, m.down], ['UP:' + m.name, m.up], ['Inv:' + m.name, m.inv]); });
  const bc = tokens.map((t) => bal(t[1]));
  bc.push({ to: A.MC3, signature: 'getEthBalance(address)(uint256)', args: [holder] });
  [A.sUSDS, A.USDC, A.USDS].forEach((t) => bc.push({ to: t, signature: 'decimals()(uint8)', args: [] }));
  const brr = await io.mcb(bc); const br = brr.results;
  const balances = {}; tokens.forEach((t, k) => { balances[t[0]] = BigInt(br[k][0]); });
  const eth = BigInt(br[tokens.length][0]); const decs = [1, 2, 3].map((k) => Number(br[tokens.length + k][0]));
  if (decs.join() !== '18,6,18') throw gstop('identity-changed', `unexpected decimals sUSDS/USDC/USDS ${decs.join('/')}`);
  const rampDue = balances.USDC !== 0n || balances.USDS !== 0n;
  const held = Object.entries(balances).filter(([k, v]) => v > 0n && !['sUSDS', 'USDC', 'USDS'].includes(k)).length;
  say(`balances (one multicall, ${bc.length} reads, block ${brr.block}): sUSDS ${G.weiStr(balances.sUSDS)}, USDC ${balances.USDC}, USDS ${balances.USDS}, ETH ${G.weiStr(eth)}; bundle tokens ${G.XS.map((x) => G.weiStr(balances['bundle' + x])).join('/')}; ${held} other token balance(s) above 0 (a record, never a refusal)`);
  if (rampDue) say('NOTE: USDC or USDS is held: a PSM3 ramp is due (G section 1, I-setup.md I.1 section 5); it is its own batch ahead of F (the wake sends it before F, planner/ramp.cjs; a supervised session on its own yes) and is not part of this plan, which spends sUSDS only');

  // ---------- the trading boundary (G section 3), with the block timestamp in the same multicall ----------
  const bd = [];
  mkts.forEach((m) => { bd.push({ to: A.CTF, signature: 'payoutDenominator(bytes32)(uint256)', args: [m.cond] }, { to: A.REALITY, signature: 'isPendingArbitration(bytes32)(bool)', args: [m.qid] }, { to: A.REALITY, signature: 'getFinalizeTS(bytes32)(uint32)', args: [m.qid] }, { to: A.REALITY, signature: 'getOpeningTS(bytes32)(uint32)', args: [m.qid] }); });
  const LV = ['A', 'B', 'C', 'parent']; const lvQ = { A: pmq[0][0], B: pmq[1][0], C: pmq[2][0], parent: pmq[3][0] };
  LV.forEach((k) => bd.push({ to: A.CTF, signature: 'payoutDenominator(bytes32)(uint256)', args: [pmConds[k]] }));
  const lvAt = bd.length;
  LV.forEach((k) => (lvQ[k] || []).forEach((q) => bd.push({ to: A.REALITY, signature: 'isPendingArbitration(bytes32)(bool)', args: [q] }, { to: A.REALITY, signature: 'getFinalizeTS(bytes32)(uint32)', args: [q] }, { to: A.REALITY, signature: 'getOpeningTS(bytes32)(uint32)', args: [q] })));
  bd.push({ to: A.MC3, signature: 'getCurrentBlockTimestamp()(uint256)' });
  const bdb = await io.mcb(bd); const bdr = bdb.results;
  const ts = Number(bdr[bd.length - 1][0]);
  const notClear = [];
  mkts.forEach((m, n) => {
    const b = n * 4; m.bound = { payout: String(bdr[b][0]), pending: bdr[b + 1][0], finalize: String(bdr[b + 2][0]), opening: String(bdr[b + 3][0]) };
    if (m.bound.payout !== '0' || m.bound.pending !== false || m.bound.opening === '0' || (m.bound.finalize !== '0' && Number(m.bound.finalize) <= ts)) notClear.push(`${m.name} ${JSON.stringify(m.bound)}`);
  });
  const hi = mkts.length * 4; const midPayouts = [0, 1, 2, 3].map((k) => String(bdr[hi + k][0]));
  // the plan-time reading of each mint level (the executor's flip test of a mint group)
  const levels = {}; let q3 = lvAt;
  LV.forEach((k, n) => { levels[k] = { condition_id: pmConds[k], payout: midPayouts[n], questions: (lvQ[k] || []).map((q) => { const o = { id: q, pending: bdr[q3][0], finalize: String(bdr[q3 + 1][0]), opening: String(bdr[q3 + 2][0]) }; q3 += 3; return o; }) }; });
  say(`trading boundary (one multicall, block ${bdb.block}, timestamp ${ts}): clear on ${mkts.length - notClear.length} of ${mkts.length} children; middles A/B/C and parent payoutDenominator ${midPayouts.join('/')} (recorded for the mint groups; a resolved middle or parent refuses nothing by itself)`);
  if (notClear.length) throw gstop('boundary', `past the trading boundary: ${clip(notClear.join('; '), 800)}; the plan is stale (G section 3)`, { not_clear: notClear.length });

  return {
    head: { number: head.number, hash: head.hash, timestamp: head.timestamp }, holder, nonce, totals: ALLOC.totals,
    allocationOrder: ALLOC.positions.map((p) => lc(p && p.address)), allocationRows: ALLOC.positions.length, allocationGeneratedAt: ALLOC.generated_at || null,
    bundlesWithPosition: [...bundlesWithPosition].sort(), refused, body_used: !!body, body_why: bodyWhy,
    parentMiddleConditions: pmConds, midPayouts, levels, boundary: { block: bdb.block, timestamp: ts },
    balances, eth, balancesBlock: brr.block, rampDue, drift,
    identityBlocks: idBlocks,
    markets: mkts,
    pools: meta.map((p) => ({ market: mkts[p.n].name, i: mkts[p.n].i, side: p.side, pool: p.pool, tok: p.tok, fee: p.fee, sqrt: p.sqrt, tick: p.tick, L: p.L, T0: p.T0, block: mkts[p.n].pin })),
  };
}

module.exports = { read };
