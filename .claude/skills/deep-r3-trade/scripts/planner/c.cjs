// planner/c.cjs - `planner c <run-id>`: steps/C-select.md as one call, writing ./run/<run-id>/candidates.json.
//
// Step 1: the helper's `data <run-id>` (the raw body, saved as r3-data.json), the stop test first, then the body
// read through `data-rows` pages. Step 2: shape, identity checks 2.1 to 2.6 (a failure is a C stop), check 2.7 by
// one multicall of the 294 wrappedOutcome reads, check 2.8 (the pool gate) on every one of the 196 pools derived
// onchain. A refused body (non-200, an error body, a malformed body, a 2.7 or 2.8 failure, no HTTP response at all)
// takes the onchain rebuild: the same rows from the individual Market getters, never MarketView.getMarket. Step 4:
// the boundary reads in two rounds (reads-b1.json, reads-b2.json), the block timestamp read in the same multicall
// as getFinalizeTS. Steps 3, 5, 6, 7: one row per table row, written once all checks passed.
//
// Every chain read goes through the helper's `multicall` on a reads file named reads*.json in the run folder (the
// names C allows); a transport failure is re-run up to 5 more times (C step 2, last paragraph) and then is a C
// stop with cause rpc_unreachable (exit 5). No step compares block numbers between two reads: the head moves.
// The freshness and price-vs-tick comparisons are diagnostics, never a stop.
'use strict';

const lib = require('./lib.cjs');
const TB = require('./table.cjs');

const { Stop, ToolFailure, EXIT, clip } = lib;
const { ADDR, T } = TB;
const lc = (s) => String(s).toLowerCase();
const ZERO = /^0x0{40}$/;
const PAGE = 30;
const MAX_PAGES = 10;
const PARENT = lc(ADDR.PARENT);

const cstop = (cause, notes, fields = {}) => new Stop({ step: 'C', cause, status: 'aborted', notes, fields });

// One multicall over a reads file. Transport failure after the re-runs: C stop, exit 5. A failure the chain
// answered (call_reverted, decode_failed) or a count mismatch: returned as { ok: false } for the caller to judge.
async function mcRead(ctx, name, reads) {
  try {
    const r = await ctx.multicall(name, reads);
    ctx.log(`multicall ${name}: ${reads.length} reads, block ${r.block}, ${r.attempts} attempt(s)`);
    ctx.detail.blocks[name] = r.block;
    return { ok: true, ...r };
  } catch (e) {
    if (e instanceof ToolFailure && e.transient) {
      throw new Stop({
        step: 'C', cause: 'rpc_unreachable', status: 'aborted', exit: EXIT.TRANSPORT,
        notes: `C step 2: ${ctx.rel(name)} still ended in a transport failure after ${Math.max(0, e.attempts - 1)} re-run(s): ${e.code}: ${clip(e.text, 200)}`,
        fields: { failed_reads: ctx.rel(name), helper_code: e.code },
      });
    }
    if (e instanceof ToolFailure && [0, 1, 8].includes(e.helperExit)) {
      ctx.log(`multicall ${name} answered with a failure: ${e.code}: ${clip(e.text, 200)}`);
      return { ok: false, code: e.code || `exit_${e.helperExit}`, text: e.text };
    }
    throw e;
  }
}
const readsFailed = (ctx, name, m, what) => cstop('onchain-reads-failed', `C ${what}: ${ctx.rel(name)} answered with a failure (${m.code}): ${clip(m.text, 200)}`, { failed_reads: ctx.rel(name), helper_code: m.code });

// Split a reads list into files of at most 500 reads, evenly: reads-p2a.json, reads-p2b.json, ...
function splitEven(list, max) {
  if (!list.length) return [];
  const k = Math.ceil(list.length / max); const size = Math.ceil(list.length / k); const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// The data-rows pages of the saved body (count at most 30 each).
async function readPages(ctx) {
  const pages = [];
  let total = null;
  for (let offset = 0; pages.length < MAX_PAGES && (total === null || offset < total); offset += PAGE) {
    const p = (await ctx.helper(['data-rows', ctx.runId, String(offset), String(PAGE)])).json;
    if (total === null) total = p.total;
    pages.push(p);
    if (!Number.isInteger(total) || total <= 0) break;
  }
  return pages;
}

// Price of an outcome token in repo tokens from a pool's sqrtPriceX96: (sqrt / 2^96)^2 when the outcome is token0,
// its reciprocal otherwise (seer-protocol section 6).
function priceOf(sqrtX96, outcomeIsToken0) {
  const s = Number(BigInt(sqrtX96)) / 2 ** 96; const p = s * s;
  return outcomeIsToken0 ? p : 1 / p;
}

async function run(ctx) {
  const D = ctx.detail;
  D.checks = []; D.blocks = {};
  const rec = (id, desc, pass, detail) => { D.checks.push({ id, desc, pass, detail: detail || '' }); ctx.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${desc}${detail ? ' :: ' + clip(detail, 300) : ''}`); };
  const artifacts = [];

  if (ctx.existsRun('candidates.json')) {
    ctx.noDetail = true; // the earlier run's planner/c.json stays as it is
    throw cstop('run-id-used', `C: ${ctx.rel('candidates.json')} already exists; a run-id is never reused (I-setup.md I.2 section 4), so start a fresh run-id`);
  }

  // ------------------------------------------------------------------ step 1: the raw body, the stop test first
  let data = null; let dataFail = null;
  try { data = (await ctx.helper(['data', ctx.runId], { retries: 0 })).json; } catch (e) {
    if (e instanceof ToolFailure && e.helperExit === 5) dataFail = e; else throw e;
  }
  D.data = data || { failed: dataFail.code, error: clip(dataFail.text, 300) };
  let body = null; let bodyIsObject = false;
  if (data && data.written) {
    artifacts.push(ctx.rel('r3-data.json'));
    try { body = JSON.parse(ctx.readRun('r3-data.json').toString('utf8')); bodyIsObject = !!body && typeof body === 'object' && !Array.isArray(body); } catch (e) { body = null; }
  }
  if (bodyIsObject && Object.prototype.hasOwnProperty.call(body, 'error')) {
    const t = String(body.error);
    if (/does not match/i.test(t) && /market list/i.test(t)) {
      throw cstop('upstream-set-changed', `C step 1: the data function says the upstream market set changed, so the table is stale: ${clip(t, 300)}`, { http_status: data.status });
    }
  }
  let refuse = null; // why the body is refused; a refused body takes the onchain rebuild
  if (dataFail) refuse = `no usable HTTP response from the data function (${dataFail.code})`;
  else if (data.status !== 200) refuse = `the data function answered HTTP ${data.status}`;
  else if (!bodyIsObject) refuse = 'the body is not a JSON object';
  else if (data.has_error_field) refuse = `the body carries an error field: ${clip(String(body.error), 200)}`;
  else if (data.usable !== true) refuse = 'malformed shape (the helper reports usable false)';

  // ------------------------------------------------------------------ step 2: shape and identity 2.1 to 2.6
  let rows = null; let header = null; let total = null;
  if (!refuse) {
    let pages = null;
    try { pages = await readPages(ctx); } catch (e) {
      if (e instanceof ToolFailure && e.helperExit === 1) refuse = `data-rows could not read the saved body (${e.code})`; else throw e;
    }
    if (pages) {
      header = pages[0].header; total = pages[0].total;
      rows = pages.flatMap((p) => p.rows || []);
      if (pages.some((p) => JSON.stringify(p.header) !== JSON.stringify(header))) refuse = 'data-rows page headers differ';
    }
  }
  if (!refuse) {
    const miss = [];
    rows.forEach((r) => { if (!Array.isArray(r) || r.length !== 9) { miss.push(`row ${r && r[0]} length`); return; } for (const k of [2, 3, 4, 5, 6]) if (r[k] === '<missing>' || r[k] === undefined) miss.push(`row ${r[0]} col ${k}`); });
    if (!header || !Array.isArray(header.parent_wrapped_tokens) || !Array.isArray(header.middle_markets)) miss.push('header');
    rec('shape', 'every projected row carries id, slot, collateral, status and wrappedTokens; the header carries parentWrappedTokens and middleMarkets', miss.length === 0, miss.slice(0, 5).join('; '));
    if (miss.length) refuse = `malformed shape: ${miss.slice(0, 3).join('; ')}`;
  }
  if (!refuse) {
    const stops = [];
    let ok = total === 98 && rows.length === 98;
    rec('2.1', 'markets.length === 98 (data-rows total, and rows read)', ok, `total ${total}, rows ${rows.length}`);
    if (!ok) stops.push(`C step 2.1: markets.length ${total} != 98`);
    let bad = T.rows.filter((r, i) => !rows[i] || lc(rows[i][2]) !== r.address).map((r) => r.i);
    rec('2.2', 'markets[i].id lowercased === table[i].address', bad.length === 0, bad.join(','));
    if (bad.length) stops.push(`C step 2.2: markets[i].id differs from the table at i = ${bad.slice(0, 10).join(',')}`);
    bad = T.rows.filter((r, i) => !rows[i] || rows[i][3] !== r.slot).map((r) => r.i);
    rec('2.3', 'markets[i].parentOutcome === table[i].slot (strict ===)', bad.length === 0, bad.join(','));
    if (bad.length) stops.push(`C step 2.3: markets[i].parentOutcome differs from the slot at i = ${bad.slice(0, 10).join(',')}`);
    bad = T.rows.filter((r, i) => !rows[i] || lc(rows[i][4]) !== r.repo_token).map((r) => r.i);
    rec('2.4', 'markets[i].collateralToken lowercased === table[i].repo_token', bad.length === 0, bad.join(','));
    if (bad.length) stops.push(`C step 2.4: markets[i].collateralToken differs from the repo token at i = ${bad.slice(0, 10).join(',')}`);
    const expParent = TB.PARENT_WRAPPED.map(lc);
    const pw = header.parent_wrapped_tokens.map(lc);
    ok = pw.length === 4 && pw.every((x, i) => x === expParent[i]);
    rec('2.5', 'parentWrappedTokens === [A, B, C, parent Invalid] in order, the first three the bundle-token headers', ok, JSON.stringify(pw));
    if (!ok) stops.push(`C step 2.5: parentWrappedTokens ${JSON.stringify(pw)} != [A, B, C, parent Invalid]`);
    const mm = header.middle_markets;
    ok = mm.length === 3 && mm.every((m, x) => Array.isArray(m) && lc(m[0]) === lc(T.bundles[x].middle));
    rec('2.6', 'middleMarkets.length === 3 and ids === the middle headers A, B, C in order', ok, JSON.stringify(mm.map((m) => m && m[0])));
    if (!ok) stops.push(`C step 2.6: middleMarkets ids ${JSON.stringify(mm.map((m) => m && m[0]))} != the three middle markets`);
    if (stops.length) throw cstop('identity-check-failed', stops.join('; '), { failed_checks: stops.length });
  }
  // The raw body the rows are built from must carry every table repo, by its own address, with the pool fields typed
  // as C expects (liquidity and feeTier strings, prices numbers); otherwise it is a malformed body.
  if (!refuse) {
    const diffs = []; const malformed = [];
    T.rows.forEach((tr, i) => {
      const md = body.marketsData && body.marketsData[tr.repo]; const r = rows[i]; const mk = Array.isArray(body.markets) ? body.markets[i] : null;
      if (!md || typeof md !== 'object' || lc(md.id) !== tr.address) { malformed.push(`marketsData[${tr.repo}] missing or another id`); return; }
      for (const [pn, pp, pr] of [['upPool', md.upPool, md.upPrice], ['downPool', md.downPool, md.downPrice]]) {
        if (pp === null) continue;
        if (!pp || typeof pp !== 'object' || typeof pp.liquidity !== 'string' || !/^\d+$/.test(pp.liquidity) || typeof pp.feeTier !== 'string' || typeof pr !== 'number' || !Number.isFinite(pr)) malformed.push(`${tr.repo}.${pn} fields`);
      }
      const side = (price, pool, rr) => (pool === null ? rr[1] === null : rr[0] === price && rr[1] && rr[1][0] === String(pool.liquidity) && rr[1][1] === String(pool.tick) && rr[1][2] === String(pool.feeTier) && rr[1][3] === lc(pool.token0));
      if (!mk || lc(mk.id) !== r[2] || mk.parentOutcome !== r[3] || lc(mk.collateralToken) !== r[4] || mk.marketStatus !== r[5] || !Array.isArray(mk.wrappedTokens) || mk.wrappedTokens.map(lc).join() !== r[6].join()) diffs.push(`markets[${i}]`);
      if (!side(md.upPrice, md.upPool, r[7])) diffs.push(`up ${i}`);
      if (!side(md.downPrice, md.downPool, r[8])) diffs.push(`down ${i}`);
    });
    rec('x.bodyRows', 'the raw body carries every table repo by its own address, pool fields typed as C expects', malformed.length === 0, malformed.slice(0, 5).join('; '));
    rec('x.rawVsRows', 'diagnostic, never a refusal: the data-rows projection equals the raw body for all 98 rows', diffs.length === 0, diffs.slice(0, 8).join(' '));
    if (malformed.length) refuse = `malformed body: ${malformed.slice(0, 3).join('; ')}`;
  }
  const bodyAfterIdentity = !refuse;

  // ------------------------------------------------------------------ check 2.7: the 294 wrappedOutcome reads
  const reads7 = [];
  for (const r of T.rows) for (let k = 0; k < 3; k++) reads7.push({ to: r.address, signature: 'wrappedOutcome(uint256)(address)', args: [String(k)] });
  const m7 = await mcRead(ctx, 'reads.json', reads7);
  artifacts.push(ctx.rel('reads.json'));
  if (!m7.ok) {
    rec('2.7', 'wrappedOutcome x294 read onchain', false, m7.code);
    throw readsFailed(ctx, 'reads.json', m7, 'check 2.7 (and the onchain rebuild, which needs the same reads)');
  }
  const W = T.rows.map((r, i) => [0, 1, 2].map((k) => lc(m7.results[3 * i + k][0])));
  if (!refuse) {
    const bad = [];
    rows.forEach((r, i) => [0, 1, 2].forEach((k) => { if (W[i][k] !== lc(r[6][k])) bad.push(`${i}.${k}`); }));
    rec('2.7', 'wrappedOutcome(k) onchain === markets[i].wrappedTokens[k] for all 294', bad.length === 0, bad.slice(0, 10).join(','));
    if (bad.length) refuse = `check 2.7: ${bad.length} wrapped token(s) differ from wrappedOutcome onchain (first ${bad.slice(0, 3).join(',')})`;
  }

  // ------------------------------------------------------------------ check 2.8: the pool gate, on every pool
  const readsP1 = [];
  for (let i = 0; i < 98; i++) {
    readsP1.push({ to: ADDR.FACTORY, signature: 'getPool(address,address,uint24)(address)', args: [W[i][1], T.rows[i].repo_token, '100'] });
    readsP1.push({ to: ADDR.FACTORY, signature: 'getPool(address,address,uint24)(address)', args: [W[i][0], T.rows[i].repo_token, '100'] });
  }
  const p1 = await mcRead(ctx, 'reads-p1.json', readsP1);
  artifacts.push(ctx.rel('reads-p1.json'));
  if (!p1.ok) throw readsFailed(ctx, 'reads-p1.json', p1, 'check 2.8 (getPool)');
  const pools = p1.results.map((x) => x[0]); // [UP0, DOWN0, UP1, DOWN1, ...]
  const nonzero = pools.map((p, n) => (ZERO.test(p) ? -1 : n)).filter((n) => n >= 0);
  const readsP2 = [];
  for (const n of nonzero) {
    const p = pools[n];
    readsP2.push({ to: p, signature: 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)' });
    readsP2.push({ to: p, signature: 'liquidity()(uint128)' });
    readsP2.push({ to: p, signature: 'fee()(uint24)' });
    readsP2.push({ to: p, signature: 'token0()(address)' });
  }
  const st = [];
  const parts = splitEven(readsP2, 500);
  for (let q = 0; q < parts.length; q++) {
    const name = `reads-p2${String.fromCharCode(97 + q)}.json`;
    const m = await mcRead(ctx, name, parts[q]);
    artifacts.push(ctx.rel(name));
    if (!m.ok) throw readsFailed(ctx, name, m, 'check 2.8 (pool state)');
    st.push(...m.results);
  }
  const onchain = {}; // `${i}.${side}` -> { pool, sqrt, tick, liquidity, fee, token0 } (absent when getPool is zero)
  nonzero.forEach((n, q) => {
    const i = Math.floor(n / 2); const side = n % 2 === 0 ? 'UP' : 'DOWN';
    const s0 = st[4 * q];
    onchain[`${i}.${side}`] = { pool: lc(pools[n]), sqrt: String(s0[0]), tick: Number(s0[1]), liquidity: String(st[4 * q + 1][0]), fee: Number(st[4 * q + 2][0]), token0: lc(st[4 * q + 3][0]) };
  });
  if (!refuse) {
    const gateBad = []; const fresh = [];
    for (let i = 0; i < 98; i++) {
      const md = body.marketsData[T.rows[i].repo];
      for (const side of ['UP', 'DOWN']) {
        const o = onchain[`${i}.${side}`]; const bp = side === 'UP' ? md.upPool : md.downPool; const outTok = W[i][side === 'UP' ? 1 : 0];
        const why = [];
        if (!o) why.push('getPool zero');
        if (!bp) why.push('body pool null');
        if (o && bp) {
          if (String(o.fee) !== String(bp.feeTier) || String(o.fee) !== '100') why.push(`fee ${o.fee} vs body ${bp.feeTier}`);
          if (o.token0 !== lc(bp.token0)) why.push(`token0 ${o.token0} vs body ${lc(bp.token0)}`);
          if (o.token0 !== outTok && o.token0 !== T.rows[i].repo_token) why.push('token0 not in {onchain outcome token, repo token}');
          if (lc(bp.token1) !== (o.token0 === outTok ? T.rows[i].repo_token : outTok)) why.push('token1 mismatch');
          if (String(o.tick) !== String(bp.tick) || o.liquidity !== String(bp.liquidity)) fresh.push(`${i}.${side}: tick chain ${o.tick} body ${bp.tick}; liquidity chain ${o.liquidity} body ${bp.liquidity}`);
        }
        if (why.length) gateBad.push(`${i}.${side} ${why.join(', ')}`);
      }
    }
    rec('2.8', 'pool gate on all 196 pools: getPool(onchain outcome token, repo token, 100) nonzero; token0() and fee() === body token0 and feeTier "100"', gateBad.length === 0, gateBad.slice(0, 5).join(' | ') || '196/196');
    rec('x.freshness', 'diagnostic, never a stop: body tick and liquidity vs onchain slot0 and liquidity', true, fresh.length === 0 ? '196/196 exact' : `${196 - fresh.length}/196 exact; differences: ` + fresh.slice(0, 6).join(' || '));
    D.freshness_differences = fresh;
    if (gateBad.length) refuse = `check 2.8: the pool gate failed (${gateBad.slice(0, 3).join(' | ')})`;
    else {
      let pbad = 0;
      for (let i = 0; i < 98; i++) for (const side of ['UP', 'DOWN']) {
        const o = onchain[`${i}.${side}`]; const outTok = W[i][side === 'UP' ? 1 : 0];
        const px = o.token0 === outTok ? Math.pow(1.0001, o.tick) : Math.pow(1.0001, -o.tick);
        const bpx = side === 'UP' ? body.marketsData[T.rows[i].repo].upPrice : body.marketsData[T.rows[i].repo].downPrice;
        if (Math.abs(px - bpx) / bpx > 0.05) pbad++;
      }
      rec('x.priceTick', 'diagnostic: outcome price from the onchain tick (token order corrected) within 5% of the body price, all 196', pbad === 0, `${pbad} outside`);
    }
  }

  // ------------------------------------------------------------------ identity of the table against the chain
  const readsX1 = [];
  for (const x of T.rows) { const b = TB.bundleOf(x); readsX1.push({ to: b.middle, signature: 'wrappedOutcome(uint256)(address)', args: [String(x.slot)] }); }
  for (const x of T.rows) readsX1.push({ to: x.address, signature: 'parentMarket()(address)' });
  for (const x of T.rows) readsX1.push({ to: x.address, signature: 'parentOutcome()(uint256)' });
  for (const b of T.bundles) {
    readsX1.push({ to: b.middle, signature: 'wrappedOutcome(uint256)(address)', args: [String(b.nRepos)] });
    readsX1.push({ to: b.middle, signature: 'parentMarket()(address)' });
    readsX1.push({ to: b.middle, signature: 'parentOutcome()(uint256)' });
  }
  for (let k = 0; k < 4; k++) readsX1.push({ to: PARENT, signature: 'wrappedOutcome(uint256)(address)', args: [String(k)] });
  const x1 = await mcRead(ctx, 'reads-x1.json', readsX1);
  artifacts.push(ctx.rel('reads-x1.json'));
  const xfail = [];
  if (!x1.ok && refuse) throw readsFailed(ctx, 'reads-x1.json', x1, 'step 2 (onchain rebuild: parentMarket, parentOutcome, the middles and the parent)');
  if (!x1.ok) xfail.push(`reads-x1.json failed (${x1.code})`);
  else {
    const R = x1.results;
    let bad = T.rows.filter((r, i) => lc(R[i][0]) !== r.repo_token).map((r) => r.i);
    rec('x.repoToken', 'middle.wrappedOutcome(slot) === table repo token, all 98', bad.length === 0, bad.join(','));
    if (bad.length) xfail.push(`middle.wrappedOutcome(slot) != repo token at i = ${bad.slice(0, 10)}`);
    bad = T.rows.filter((r, i) => lc(R[98 + i][0]) !== lc(TB.bundleOf(r).middle)).map((r) => r.i);
    rec('x.parentMarket', 'child.parentMarket() === its middle, all 98', bad.length === 0, bad.join(','));
    if (bad.length) xfail.push(`parentMarket() != middle at i = ${bad.slice(0, 10)}`);
    bad = T.rows.filter((r, i) => Number(R[196 + i][0]) !== r.slot).map((r) => r.i);
    rec('x.parentOutcome', 'child.parentOutcome() === slot, all 98', bad.length === 0, bad.join(','));
    if (bad.length) xfail.push(`parentOutcome() != slot at i = ${bad.slice(0, 10)}`);
    const mids = T.bundles.map((b, k) => ({ inv: lc(R[294 + 3 * k][0]), pm: lc(R[295 + 3 * k][0]), po: Number(R[296 + 3 * k][0]) }));
    const midsOk = mids.every((m, k) => m.inv === lc(T.bundles[k].middleInvalid) && m.pm === PARENT && m.po === T.bundles[k].idx);
    rec('x.middles', 'each middle: Invalid token, parentMarket() === parent, parentOutcome() === bundle index', midsOk, JSON.stringify(mids));
    if (!midsOk) xfail.push('a middle market disagrees with its table header');
    const pw = [0, 1, 2, 3].map((k) => lc(R[303 + k][0]));
    const pwOk = pw.every((w, k) => w === lc(TB.PARENT_WRAPPED[k]));
    rec('x.parentWrapped', 'parent.wrappedOutcome(0..3) === [A, B, C, parent Invalid]', pwOk, JSON.stringify(pw));
    if (!pwOk) xfail.push('the parent wrapped tokens disagree with the scope list');
  }

  // ------------------------------------------------------------------ step 4: boundary reads, two rounds
  const readsB1 = [];
  for (const x of T.rows) readsB1.push({ to: x.address, signature: 'conditionId()(bytes32)' });
  for (const x of T.rows) readsB1.push({ to: x.address, signature: 'questionsIds()(bytes32[])' });
  for (const b of T.bundles) readsB1.push({ to: b.middle, signature: 'conditionId()(bytes32)' });
  const b1 = await mcRead(ctx, 'reads-b1.json', readsB1);
  artifacts.push(ctx.rel('reads-b1.json'));
  if (!b1.ok) throw readsFailed(ctx, 'reads-b1.json', b1, 'step 4 (round 1)');
  const cond = b1.results.slice(0, 98).map((x) => x[0]);
  const qids = b1.results.slice(98, 196).map((x) => x[0]);
  const mcond = b1.results.slice(196, 199).map((x) => x[0]);
  const noQ = qids.map((q, i) => (Array.isArray(q) && q.length >= 1 ? null : i)).filter((v) => v !== null);
  rec('4.qids', 'every child has a questionsIds() entry (exactly one expected)', noQ.length === 0 && qids.every((q) => q.length === 1), noQ.length ? 'none at ' + noQ.join(',') : '');
  if (noQ.length) throw cstop('boundary-read-failed', `C step 4: questionsIds() is empty for ${noQ.map((i) => T.rows[i].repo).slice(0, 10).join(', ')}; the boundary cannot be read`);
  const qid = qids.map((q) => q[0]);
  const readsB2 = [];
  for (let i = 0; i < 98; i++) readsB2.push({ to: ADDR.CTF, signature: 'payoutDenominator(bytes32)(uint256)', args: [cond[i]] });
  for (let i = 0; i < 98; i++) readsB2.push({ to: ADDR.REALITY, signature: 'isPendingArbitration(bytes32)(bool)', args: [qid[i]] });
  for (let i = 0; i < 98; i++) readsB2.push({ to: ADDR.REALITY, signature: 'getFinalizeTS(bytes32)(uint32)', args: [qid[i]] });
  for (let i = 0; i < 98; i++) readsB2.push({ to: ADDR.REALITY, signature: 'getOpeningTS(bytes32)(uint32)', args: [qid[i]] });
  for (let x = 0; x < 3; x++) readsB2.push({ to: ADDR.CTF, signature: 'payoutDenominator(bytes32)(uint256)', args: [mcond[x]] });
  for (let i = 0; i < 98; i++) readsB2.push({ to: ADDR.CTF, signature: 'payoutNumerators(bytes32,uint256)(uint256)', args: [mcond[TB.bundleIndex(T.rows[i])], String(T.rows[i].slot)] });
  readsB2.push({ to: ADDR.MC3, signature: 'getCurrentBlockTimestamp()(uint256)' }); // [493]: the block time of this same multicall
  const b2 = await mcRead(ctx, 'reads-b2.json', readsB2);
  artifacts.push(ctx.rel('reads-b2.json'));
  if (!b2.ok) throw readsFailed(ctx, 'reads-b2.json', b2, 'step 4 (round 2)');
  const R2 = b2.results;
  const den = R2.slice(0, 98).map((x) => String(x[0]));
  const pend = R2.slice(98, 196).map((x) => x[0]);
  const fin = R2.slice(196, 294).map((x) => Number(x[0]));
  const opn = R2.slice(294, 392).map((x) => Number(x[0]));
  const midDen = R2.slice(392, 395).map((x) => String(x[0]));
  const midNum = R2.slice(395, 493).map((x) => String(x[0]));
  const BLOCK_TS = Number(R2[493][0]);
  if (!(BLOCK_TS > 0)) throw cstop('boundary-read-failed', 'C step 4: the block timestamp read in reads-b2.json is missing or zero');
  const failedOpen = opn.map((v, i) => (v === 0 ? i : null)).filter((v) => v !== null);
  rec('4.opening', 'getOpeningTS(questionsIds()[0]) nonzero for all 98 (a zero is a failed read)', failedOpen.length === 0, failedOpen.join(','));
  if (failedOpen.length) throw cstop('boundary-read-failed', `C step 4: getOpeningTS(questionsIds()[0]) is 0, a failed read, never "clear", for ${failedOpen.map((i) => T.rows[i].repo).slice(0, 10).join(', ')}`);

  // ------------------------------------------------------------------ the onchain rebuild's own identity tests
  const source = refuse ? 'onchain-rebuild' : 'body';
  if (refuse) {
    ctx.log(`body refused (${refuse}): the rows are rebuilt from the Market getters`);
    if (xfail.length) throw cstop('table-stale-onchain', `C step 2 (onchain rebuild): the chain disagrees with the table: ${xfail.join('; ')}`);
    const gateBad = [];
    for (let i = 0; i < 98; i++) for (const side of ['UP', 'DOWN']) {
      const o = onchain[`${i}.${side}`]; if (!o) continue; const outTok = W[i][side === 'UP' ? 1 : 0];
      if (o.fee !== 100) gateBad.push(`${i}.${side} fee ${o.fee}`);
      if (o.token0 !== outTok && o.token0 !== T.rows[i].repo_token) gateBad.push(`${i}.${side} token0 not in {outcome token, repo token}`);
    }
    rec('2.8r', 'onchain rebuild: every pool getPool found has fee() 100 and token0() in {outcome token, repo token}', gateBad.length === 0, gateBad.slice(0, 5).join(' | '));
    if (gateBad.length) throw cstop('pool-identity-failed', `C step 2.8 (onchain rebuild): ${gateBad.slice(0, 5).join(' | ')}`);
  } else if (xfail.length) {
    D.identity_diagnostic = xfail; // the body passed 2.1 to 2.8; the extra chain identity reads are reported, not gated
  }

  // ------------------------------------------------------------------ steps 3 to 6: one row per table row
  const counts = { body_not_open: 0, pool_null: 0, liq_zero: 0, payoutReported: 0, pending: 0, decided_unreported: 0, middle_settled: 0, future_finalize: 0 };
  const cands = []; const why = [];
  T.rows.forEach((r, i) => {
    const x = TB.bundleIndex(r); const reasons = [];
    let pl = [];
    if (source === 'body') {
      const md = body.marketsData[r.repo]; const mk = body.markets[i];
      const up = md.upPool; const down = md.downPool;
      if (mk.marketStatus !== 'open') { reasons.push('status'); counts.body_not_open++; }
      if (up === null || down === null) { reasons.push('pool_null'); counts.pool_null++; } else if (String(up.liquidity) === '0' || String(down.liquidity) === '0') { reasons.push('liq_zero'); counts.liq_zero++; }
      if (down) pl.push({ outcome: 'DOWN', fee_tier: Number(down.feeTier), liquidity: String(down.liquidity), price: md.downPrice });
      if (up) pl.push({ outcome: 'UP', fee_tier: Number(up.feeTier), liquidity: String(up.liquidity), price: md.upPrice });
    } else {
      const dn = onchain[`${i}.DOWN`]; const up = onchain[`${i}.UP`];
      if (!dn || !up) { reasons.push('pool_null'); counts.pool_null++; } else if (dn.liquidity === '0' || up.liquidity === '0') { reasons.push('liq_zero'); counts.liq_zero++; }
      if (dn) pl.push({ outcome: 'DOWN', fee_tier: dn.fee, liquidity: dn.liquidity, price: priceOf(dn.sqrt, dn.token0 === W[i][0]) });
      if (up) pl.push({ outcome: 'UP', fee_tier: up.fee, liquidity: up.liquidity, price: priceOf(up.sqrt, up.token0 === W[i][1]) });
    }
    if (den[i] !== '0') { reasons.push('payoutReported'); counts.payoutReported++; }
    if (pend[i] !== false) { reasons.push('pending_arbitration'); counts.pending++; }
    if (fin[i] !== 0 && fin[i] <= BLOCK_TS) { reasons.push('decided_unreported'); counts.decided_unreported++; } else if (fin[i] !== 0) counts.future_finalize++;
    if (midDen[x] !== '0' && midNum[i] === '0') { reasons.push('middle_settled'); counts.middle_settled++; }
    why.push(reasons);
    cands.push({
      market: r.repo,
      address: r.address,
      kind: 'scalar',
      outcomes: ['DOWN', 'UP', 'Invalid'],
      collateral_token: r.repo_token,
      collateral_symbol: `ORIG_R3_REPO:${r.repo}`,
      parent: { address: lc(T.bundles[x].middle), outcome_index: r.slot },
      resolves_on: null,
      resolution_source: `Reality.eth question "What will be the average originality score of ${r.repo} in Round 3 of the Deep Funding experiment?", answered as the mean juror score on the 0-100 scale x 1e18, bounds 0..100e18, so UP pays score/100 repo tokens; Round 2 ratings were published at github.com/deepfunding/oss-evals`,
      tradeable: reasons.length === 0,
      pools: pl,
      traded: null,
      reason_in_scope: `Round 3 Originality market ${i} of 98, slot ${r.slot} of bundle ${r.bundle}'s middle market ${lc(T.bundles[x].middle)} under parent ${PARENT}`,
    });
  });
  const doc = { generated_at: new Date().toISOString(), chain_id: TB.CHAIN_ID, contest: TB.CONTEST, candidates: cands, skipped: [] };

  // ------------------------------------------------------------------ step 7: self-check the exact bytes, then write
  const text = JSON.stringify(doc, null, 2) + '\n';
  const d = JSON.parse(text); const errs = [];
  const ROW_KEYS = ['market', 'address', 'kind', 'outcomes', 'collateral_token', 'collateral_symbol', 'parent', 'resolves_on', 'resolution_source', 'tradeable', 'pools', 'traded', 'reason_in_scope'].sort().join();
  if (Object.keys(d).sort().join() !== ['candidates', 'chain_id', 'contest', 'generated_at', 'skipped'].join()) errs.push('top-level keys');
  if (d.chain_id !== 10 || d.contest !== 'round3' || !Array.isArray(d.skipped) || d.skipped.length) errs.push('chain/contest/skipped');
  if (d.candidates.length !== 98) errs.push('row count');
  const split = { A: 0, B: 0, C: 0 }; const ADDR_RE = /^0x[0-9a-f]{40}$/;
  d.candidates.forEach((c, i) => {
    const r = T.rows[i];
    if (Object.keys(c).sort().join() !== ROW_KEYS) errs.push(`row ${i} keys`);
    if (c.market !== r.repo || c.address !== r.address || c.collateral_token !== r.repo_token) errs.push(`row ${i} identity`);
    for (const a of [c.address, c.collateral_token, c.parent.address]) if (!ADDR_RE.test(a)) errs.push(`row ${i} address ${a}`);
    if (c.parent.outcome_index !== r.slot) errs.push(`row ${i} slot`);
    split[r.bundle]++;
    if (typeof c.tradeable !== 'boolean') errs.push(`row ${i} tradeable type`);
    if (c.traded !== null || c.resolves_on !== null || c.kind !== 'scalar') errs.push(`row ${i} nulls/kind`);
    if (JSON.stringify(c.outcomes) !== '["DOWN","UP","Invalid"]') errs.push(`row ${i} outcomes`);
    if (!['', 'DOWN', 'UP', 'DOWN,UP'].includes(c.pools.map((p) => p.outcome).join())) errs.push(`row ${i} pools shape`); // one entry per non-null pool, DOWN then UP
    if (c.tradeable && c.pools.length !== 2) errs.push(`row ${i} tradeable without both pools`);
    for (const p of c.pools) {
      if (Object.keys(p).sort().join() !== 'fee_tier,liquidity,outcome,price') errs.push(`row ${i} pool keys`);
      if (typeof p.liquidity !== 'string' || !/^\d+$/.test(p.liquidity) || typeof p.fee_tier !== 'number' || typeof p.price !== 'number' || !Number.isFinite(p.price)) errs.push(`row ${i} pool types`);
      if (p.fee_tier !== 100) errs.push(`row ${i} fee_tier ${p.fee_tier}`);
    }
  });
  if (/"liquidity":\s*\d/.test(text)) errs.push('a liquidity is a bare JSON number');
  if (split.A !== 33 || split.B !== 33 || split.C !== 32) errs.push(`bundle split ${split.A}/${split.B}/${split.C}`);
  rec('7.self', 'candidates.json self-check (contract shape, identity, types, split 33/33/32)', errs.length === 0, errs.slice(0, 10).join('; '));
  if (errs.length) throw cstop('self-check-failed', `C step 7: candidates.json failed its own check, nothing written: ${errs.slice(0, 5).join('; ')}`);
  ctx.writeRun('candidates.json', text);
  artifacts.unshift(ctx.rel('candidates.json'));

  const nTrade = cands.filter((c) => c.tradeable).length;
  const notTradeable = why.map((w, i) => (w.length ? `${i}:${T.rows[i].repo}:${w.join('+')}` : null)).filter(Boolean);
  D.not_tradeable = notTradeable; D.reason_counts = counts; D.body_refused = refuse; D.source = source; D.block_timestamp = BLOCK_TS;
  const diagFailed = D.checks.filter((c) => !c.pass && /^x\./.test(c.id)).map((c) => c.id);
  return {
    source,
    body_refused: refuse,
    candidates: cands.length,
    tradeable: nTrade,
    not_tradeable: cands.length - nTrade,
    bundle_split: `${split.A} / ${split.B} / ${split.C}`,
    reason_counts: counts,
    not_tradeable_rows: notTradeable.slice(0, 20),
    freshness: source === 'body' ? (D.freshness_differences.length ? `${196 - D.freshness_differences.length}/196 exact (diagnostic only)` : '196/196 exact') : 'n/a (onchain rebuild)',
    diagnostics_failed: diagFailed,
    block_timestamp: BLOCK_TS,
    multicall_blocks: D.blocks,
    artifacts,
  };
}

module.exports = { run, priceOf, splitEven };
