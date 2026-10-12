// planner/e.cjs - `planner e <run-id>`: steps/E-no-reconcile.md, the identity blend, writing
// ./run/<run-id>/blended.json.
//
// Step 1 aborts on price_seen not false, on a p that is not length 3 or does not sum to 1 within 1e-9, and on a
// duplicate address. Step 2 copies own = blended = p verbatim, w = 1.0, before any price is read. Step 3 takes the
// price from candidates.json pools[] (DOWN and UP by name, finite); for a row candidates.json cannot price, the
// saved body of this run-id through the helper's `data-rows` pages (joined on the lowercased address), never a new
// fetch; the body is not used when C took its onchain rebuild or the file is unusable. A row priced by neither keeps
// market_price null and is never dropped. Step 5 records [down, up, 1 - up - down], never renormalised or clamped.
// E spends nothing, signs nothing and builds no transaction.
'use strict';

const lib = require('./lib.cjs');

const { Stop, ToolFailure, clip } = lib;
const PAGE = 30;
const MAX_PAGES = 10;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const estop = (cause, notes) => new Stop({ step: 'E', cause, status: 'aborted', notes: `E abort (nothing written): ${notes}` });

// The saved body's prices by lowercased market id, through data-rows; null when the body is missing or unusable.
async function bodyPrices(ctx) {
  // C records which source it built candidates.json from; a refused body is never a price source.
  if (ctx.existsRun('planner/c.json')) {
    try {
      const c = ctx.readRunJson('planner/c.json');
      const src = c && c.summary && c.summary.source;
      if (src && src !== 'body') return { map: null, why: `C took its ${src}, so the saved body is not a price source` };
    } catch (e) { /* unreadable detail: fall through to the body's own checks */ }
  }
  if (!ctx.existsRun('r3-data.json')) return { map: null, why: 'no saved body for this run-id' };
  const map = new Map();
  let total = null;
  for (let offset = 0, n = 0; n < MAX_PAGES && (total === null || offset < total); offset += PAGE, n++) {
    let p;
    try { p = (await ctx.helper(['data-rows', ctx.runId, String(offset), String(PAGE)])).json; } catch (e) {
      if (e instanceof ToolFailure && [1, 4].includes(e.helperExit)) return { map: null, why: `the saved body is unusable (${e.code})` };
      throw e;
    }
    if (total === null) total = p.total;
    for (const r of p.rows || []) {
      if (!Array.isArray(r) || typeof r[2] !== 'string' || r[2] === '<missing>') continue;
      const up = Array.isArray(r[7]) ? r[7][0] : null; const down = Array.isArray(r[8]) ? r[8][0] : null;
      map.set(r[2].toLowerCase(), { up, down });
    }
    if (!Number.isInteger(total) || total <= 0) break;
  }
  return { map, why: null };
}

async function run(ctx) {
  const D = ctx.detail;
  // ---- step 1
  let bf;
  try { bf = ctx.readRunJson('base-forecast.json'); } catch (e) { throw estop('base-forecast-unreadable', `${ctx.rel('base-forecast.json')} is unreadable: ${clip(e.message, 200)}`); }
  if (!bf || bf.price_seen !== false) throw estop('price-seen', `price_seen is ${JSON.stringify(bf && bf.price_seen)}, not false: D saw the book, the control arm is contaminated and the A/B is void`);
  if (!Array.isArray(bf.forecasts)) throw estop('malformed-forecast', 'forecasts is not an array');
  for (const f of bf.forecasts) {
    if (!Array.isArray(f.p) || f.p.length !== 3) throw estop('malformed-forecast', `${f.market}: p is not length 3 (${clip(JSON.stringify(f.p), 80)})`);
    const sum = f.p.reduce((a, b) => a + b, 0);
    if (!(Math.abs(sum - 1) <= 1e-9)) throw estop('malformed-forecast', `${f.market}: p ${JSON.stringify(f.p)} sums to ${sum}, not 1 within 1e-9`);
  }
  const addrSeen = new Set();
  for (const f of bf.forecasts) {
    const a = String(f.address).toLowerCase();
    if (addrSeen.has(a)) throw estop('duplicate-address', `duplicate address ${a} in base-forecast.json (it breaks E and F, which key on it)`);
    addrSeen.add(a);
  }
  ctx.log(`step 1: base-forecast.json: ${bf.forecasts.length} forecasts, price_seen false, every p length 3 summing to 1 within 1e-9`);

  // ---- step 2: copy first, before any price is read
  const blends = bf.forecasts.map((f) => ({
    market: f.market, address: f.address,
    own: f.p.slice(), market_price: null,
    w: 1.0, w_reason: 'naive baseline: no reconciliation',
    blended: f.p.slice(),
  }));
  ctx.log(`step 2: copied own = blended = p verbatim for ${blends.length} rows, w = 1.0; no price read yet`);

  // ---- steps 3 and 4: candidates.json first (joined on the lowercased address), the saved body as the fallback
  let cands;
  try { cands = ctx.readRunJson('candidates.json').candidates; } catch (e) { throw estop('candidates-unreadable', `${ctx.rel('candidates.json')} is unreadable: ${clip(e.message, 200)}`); }
  if (!Array.isArray(cands)) throw estop('candidates-unreadable', 'candidates.json has no candidates[]');
  const byAddr = new Map(cands.map((c) => [String(c.address).toLowerCase(), c]));
  const fromPools = (c) => {
    if (!c || !Array.isArray(c.pools)) return null;
    const d = c.pools.find((p) => p.outcome === 'DOWN'); const u = c.pools.find((p) => p.outcome === 'UP'); // by name, never by position
    return d && u && fin(d.price) && fin(u.price) ? { down: d.price, up: u.price } : null;
  };
  const prices = blends.map((b) => fromPools(byAddr.get(String(b.address).toLowerCase())));
  const need = prices.map((p, i) => (p === null ? i : -1)).filter((i) => i >= 0);
  let viaBody = 0; let bodyWhy = null;
  const unpriced = [];
  if (need.length) {
    const bp = await bodyPrices(ctx);
    bodyWhy = bp.why;
    for (const i of need) {
      const b = blends[i]; const a = String(b.address).toLowerCase();
      const v = bp.map ? bp.map.get(a) : null;
      if (v && fin(v.down) && fin(v.up)) { prices[i] = { down: v.down, up: v.up }; viaBody++; continue; }
      const inCands = byAddr.has(a); const inBody = !!(bp.map && bp.map.has(a));
      unpriced.push({ market: b.market, address: b.address, why: !inCands && !inBody ? 'in neither candidates.json nor the saved body (D and E inputs disagree)' : (bp.map ? 'no finite DOWN and UP price' : bp.why) });
    }
    ctx.log(`step 3: ${blends.length - need.length} rows priced from candidates.json, ${viaBody} from the saved body (data-rows), ${unpriced.length} left null${bodyWhy ? ' (' + bodyWhy + ')' : ''}`);
  } else ctx.log('step 3: every row priced from candidates.json pools[] (DOWN and UP, finite, by outcome name); the data function is not fetched');

  // ---- step 5: record the price
  let nullPrice = 0; let negThird = 0;
  blends.forEach((b, i) => {
    const p = prices[i];
    if (p === null) { b.market_price = null; nullPrice++; return; }
    b.market_price = [p.down, p.up, 1 - p.up - p.down]; // never renormalised, never clamped
    if (b.market_price[2] < 0) negThird++;
  });
  ctx.log(`step 5: market_price recorded on ${blends.length - nullPrice} rows; null on ${nullPrice}; ${negThird} with a negative third entry (written as is)`);

  // ---- step 6 and the closing assertions
  if (blends.length !== bf.forecasts.length) throw estop('assertion', 'blends.length != forecasts.length');
  for (let i = 0; i < blends.length; i++) {
    const b = blends[i]; const f = bf.forecasts[i];
    if (b.address !== f.address || b.market !== f.market) throw estop('assertion', `row ${i}: order or identity differs from D`);
    for (let k = 0; k < 3; k++) if (!Object.is(b.blended[k], b.own[k]) || !Object.is(b.own[k], f.p[k])) throw estop('assertion', `${b.market}: blended != own != p at index ${k}`);
  }
  const out = { generated_at: lib.nowIsoSec(), method: 'identity', blends };
  ctx.writeRunJson('blended.json', out);
  D.unpriced = unpriced;
  ctx.log(`step 6: wrote ${ctx.rel('blended.json')}: ${blends.length} blends, method identity (same order and count as D)`);
  return {
    blends: blends.length,
    priced_from_candidates: blends.length - need.length,
    priced_from_saved_body: viaBody,
    null_price: nullPrice,
    null_price_rows: unpriced.slice(0, 20),
    negative_third: negThird,
    fetched: false,
    artifacts: [ctx.rel('blended.json')],
  };
}

module.exports = { run };
