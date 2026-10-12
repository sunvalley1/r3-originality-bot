// planner/f-probe-post3a.cjs - F step 8's probe for a row sized on the state a step-3a set-sell leaves (ported from the
// live probe script). The engine sizes such a row with the exact single-range model from the set-sell quote's
// sqrtPriceX96After, because the chain helper's call and multicall carry no state override. This confirms it on
// simulated state: ONE chain-helper `simulate` file of [the mint prefix the set group needs, the set group (split the
// child, sell q UP, sell q DOWN), QuoterV2 for the row flagged "return": true], run from the pinned holder by
// eth_simulateV1. Read-only: nothing is signed or sent.
//
// The prefix mints only what the holder lacks: q repo tokens of the market, taken from the repo token held first, then
// from the bundle's unsplit tokens (a middle split), then from sUSDS (a parent split, then a middle split). When the
// probe cannot run (no eth_simulateV1, a failed call, not enough sUSDS for the prefix) the row keeps the model's numbers
// and the print says the model was used (F step 8's stated fallback).
//
// A market whose step 3a is a merge-arb is probed the same way, with the merge-arb group in place of the set-sell group
// (approve the repo token, buy q UP and q DOWN by exact output, approve the three legs to the Router, merge q with the
// held child Invalid) and one flagged quote per UP/DOWN row after it: an exact-output quote at a pair leg's count (its
// stake was quoted on the live pool at q + count less the quote at q), an exact-input quote at a stand-alone row's stake.
'use strict';

const lib = require('./lib.cjs');
const FL = require('./f-lib.cjs');

const { ToolFailure, clip } = lib;
const { A, lc } = FL;

async function probePost3a(R, { res, flags, artifact }) {
  const { ctx, S, io, cands } = R;
  const say = (s) => ctx.log(s);
  const rows = [];
  const fins = res.filter((r) => r && r.dir && r.dir.src === 'model-post-3a' && !flags[r.i].dropDir[r.dir.side] && r.set && r.set.route === 'set-sell' && !flags[r.i].dropSet
    && artifact.positions.some((p) => p.address === r.address && p.side === 'set') && artifact.positions.some((p) => p.address === r.address && p.side === r.dir.side));
  const maFins = res.filter((r) => r && r.set && r.set.route === 'merge-arb' && !flags[r.i].dropSet && artifact.positions.some((p) => p.address === r.address && p.side === 'set' && p.route === 'merge-arb')
    && artifact.positions.some((p) => p.address === r.address && (p.side === 'UP' || p.side === 'DOWN')));
  if (!fins.length && !maFins.length) return rows;
  const ethers = ctx.ethers();
  const { Interface } = ethers;
  const erc = new Interface(['function approve(address,uint256) returns (bool)']);
  const rt = new Interface(['function splitPosition(address collateralToken, address market, uint256 amount)']);
  const sw = new Interface(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)']);
  const qt = new Interface(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
  const call = (to, data, ret) => ({ to, data, value: '0', ...(ret ? { return: true } : {}) });
  const bIdx = { A: 0, B: 1, C: 2 };
  for (const fin of fins) {
    const i = fin.i; const Rt = lc(cands[i].collateral_token); const pu = S.pools[i * 2 + 1]; const pd = S.pools[i * 2]; const mid = lc(cands[i].parent.address);
    const bundleName = S.bundleOf[i]; const bundle = S.bundles[bundleName];
    const setRow = artifact.positions.find((p) => p.address === fin.address && p.side === 'set'); const dirRow = artifact.positions.find((p) => p.address === fin.address && p.side === fin.dir.side);
    const q = FL.g18(setRow.stake); const stake = FL.g18(dirRow.stake); const H = S.holder;
    const held = BigInt(S.balances.held[i]); const bHeld = BigInt(S.balances.bundles[bIdx[bundleName]]); const susds = BigInt(S.balances.sUSDS);
    const needRepo = q > held ? q - held : 0n; const fromBundle = needRepo < bHeld ? needRepo : bHeld; const fromMint = needRepo - fromBundle;
    const base = { market: fin.market, side: fin.dir.side, artifact_fill: dirRow.quoted_fill };
    if (fromMint > susds) { rows.push({ ...base, ran: false, why: `the prefix needs ${FL.weiStr(fromMint)} sUSDS, the holder has ${FL.weiStr(susds)}` }); continue; }
    const groups = [];
    if (fromMint > 0n) groups.push({ calls: [call(A.sUSDS, erc.encodeFunctionData('approve', [A.ROUTER, fromMint])), call(A.ROUTER, rt.encodeFunctionData('splitPosition', [A.sUSDS, A.PARENT, fromMint]))] });
    if (needRepo > 0n) groups.push({ calls: [call(bundle, erc.encodeFunctionData('approve', [A.ROUTER, needRepo])), call(A.ROUTER, rt.encodeFunctionData('splitPosition', [A.sUSDS, mid, needRepo]))] });
    groups.push({ calls: [call(Rt, erc.encodeFunctionData('approve', [A.ROUTER, q])), call(A.ROUTER, rt.encodeFunctionData('splitPosition', [A.sUSDS, fin.address, q]))] });
    groups.push({ calls: [
      call(pu.tok, erc.encodeFunctionData('approve', [A.SWAP, q])), call(A.SWAP, sw.encodeFunctionData('exactInputSingle', [{ tokenIn: pu.tok, tokenOut: Rt, fee: pu.fee, recipient: H, amountIn: q, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }]), true),
      call(pd.tok, erc.encodeFunctionData('approve', [A.SWAP, q])), call(A.SWAP, sw.encodeFunctionData('exactInputSingle', [{ tokenIn: pd.tok, tokenOut: Rt, fee: pd.fee, recipient: H, amountIn: q, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }]), true),
    ] });
    groups.push({ calls: [call(A.QUOTER, qt.encodeFunctionData('quoteExactInputSingle', [{ tokenIn: Rt, tokenOut: fin.dir.side === 'UP' ? pu.tok : pd.tok, amountIn: stake, fee: pu.fee, sqrtPriceLimitX96: 0 }]), true)] });
    const name = `f-tmp/probe-${i}.json`;
    let out;
    try {
      ctx.writeRun(name, JSON.stringify(groups));
      out = await io.H(['simulate', ctx.rel(name)]);
    } catch (e) {
      if (!(e instanceof ToolFailure)) throw e;
      rows.push({ ...base, ran: false, why: `simulate failed: ${e.code || 'exit ' + e.helperExit}: ${clip(e.text, 200)}` });
      continue;
    } finally { try { ctx.removeRun(name); } catch (e) { /* scratch */ } }
    say(`probe ${fin.market}: simulate all_success ${out.all_success}, failed ${out.failed_count}, calls ${out.count}, overrides_active ${out.overrides_active || false}`);
    if (!out.all_success || out.overrides_active || !Array.isArray(out.returns) || out.returns.length !== 3) { rows.push({ ...base, ran: false, why: `simulate did not succeed cleanly (all_success ${out.all_success}, failed ${out.failed_count}, overrides ${!!out.overrides_active})` }); continue; }
    const rets = out.returns;
    const sellUp = BigInt(sw.decodeFunctionResult('exactInputSingle', rets[0].return_data)[0]); const sellDn = BigInt(sw.decodeFunctionResult('exactInputSingle', rets[1].return_data)[0]);
    const qr = qt.decodeFunctionResult('quoteExactInputSingle', rets[2].return_data);
    const fill = Number(stake) / Number(qr[0]);
    const Pafter = FL.priceOf(BigInt(qr[1]), (fin.dir.side === 'UP' ? pu : pd).T0); const target = dirRow.p_win * (1 - fin.f);
    const relGap = Math.abs(fill - dirRow.quoted_fill) / dirRow.quoted_fill;
    say(`  simulated set-sell proceeds ${FL.weiStr(sellUp + sellDn)} (plan row: stake*fill = ${setRow.stake * setRow.quoted_fill}); simulated-state quoter: ${FL.weiStr(stake)} repo tokens -> ${FL.weiStr(BigInt(qr[0]))} tokens, ticksCrossed ${qr[2]}; fill gap ${relGap.toExponential(2)}; price after vs p(1-f) ${(Pafter / target - 1).toExponential(2)}`);
    rows.push({ ...base, ran: true, simulated_fill: fill, rel_gap: relGap, ticks_crossed: Number(qr[2]), confirmed: relGap <= 0.01 && Number(qr[2]) === 0, simulated_proceeds: FL.weiStr(sellUp + sellDn), price_after_vs_target: Pafter / target - 1, prefix: { from_mint: FL.weiStr(fromMint), from_bundle: FL.weiStr(fromBundle), from_held: FL.weiStr(q - needRepo) } });
  }
  // ---- merge-arb markets: [prefix, the merge-arb group, the flagged quotes of every UP/DOWN row after it]
  const swOut = new Interface(['function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn)']);
  const mg = new Interface(['function mergePositions(address collateralToken, address market, uint256 amount)']);
  const qto = new Interface(['function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
  for (const fin of maFins) {
    const i = fin.i; const Rt = lc(cands[i].collateral_token); const pu = S.pools[i * 2 + 1]; const pd = S.pools[i * 2]; const mid = lc(cands[i].parent.address);
    const bundleName = S.bundleOf[i]; const bundle = S.bundles[bundleName]; const inv = lc(S.wrapped[i][2]); const H = S.holder;
    const setRow = artifact.positions.find((p) => p.address === fin.address && p.side === 'set');
    const legRows = artifact.positions.filter((p) => p.address === fin.address && (p.side === 'UP' || p.side === 'DOWN'));
    const q = FL.gCount(setRow.stake, setRow.quoted_fill); const cost = FL.g18(setRow.stake); const capIn = cost + cost / 1000n + 2n; // the row's stake is 15-digit floored: a 0.1% margin covers the legs' real amountIn
    const held = BigInt(S.balances.held[i]); const bHeld = BigInt(S.balances.bundles[bIdx[bundleName]]); const susds = BigInt(S.balances.sUSDS);
    const needRepo = capIn > held ? capIn - held : 0n; const fromBundle = needRepo < bHeld ? needRepo : bHeld; const fromMint = needRepo - fromBundle;
    if (fromMint > susds) { legRows.forEach((r) => rows.push({ market: fin.market, side: r.side, artifact_fill: r.quoted_fill, ran: false, why: `the prefix needs ${FL.weiStr(fromMint)} sUSDS, the holder has ${FL.weiStr(susds)}` })); continue; }
    const groups = [];
    if (fromMint > 0n) groups.push({ calls: [call(A.sUSDS, erc.encodeFunctionData('approve', [A.ROUTER, fromMint])), call(A.ROUTER, rt.encodeFunctionData('splitPosition', [A.sUSDS, A.PARENT, fromMint]))] });
    if (needRepo > 0n) groups.push({ calls: [call(bundle, erc.encodeFunctionData('approve', [A.ROUTER, needRepo])), call(A.ROUTER, rt.encodeFunctionData('splitPosition', [A.sUSDS, mid, needRepo]))] });
    const leg = (p) => call(A.SWAP, swOut.encodeFunctionData('exactOutputSingle', [{ tokenIn: Rt, tokenOut: p.tok, fee: p.fee, recipient: H, amountOut: q, amountInMaximum: capIn, sqrtPriceLimitX96: 0 }]), true);
    groups.push({ calls: [call(Rt, erc.encodeFunctionData('approve', [A.SWAP, 2n * capIn])), leg(pu), leg(pd),
      call(pu.tok, erc.encodeFunctionData('approve', [A.ROUTER, q])), call(pd.tok, erc.encodeFunctionData('approve', [A.ROUTER, q])), call(inv, erc.encodeFunctionData('approve', [A.ROUTER, q])),
      call(A.ROUTER, mg.encodeFunctionData('mergePositions', [A.sUSDS, fin.address, q]))] });
    const pairLeg = () => legRows.length === 2; // a 3b pair (a folded extra included); else one stand-alone directional row
    groups.push({ calls: legRows.map((r) => { const p = r.side === 'UP' ? pu : pd; return pairLeg(r)
      ? call(A.QUOTER, qto.encodeFunctionData('quoteExactOutputSingle', [{ tokenIn: Rt, tokenOut: p.tok, amount: FL.gCount(r.stake, r.quoted_fill), fee: p.fee, sqrtPriceLimitX96: 0 }]), true)
      : call(A.QUOTER, qt.encodeFunctionData('quoteExactInputSingle', [{ tokenIn: Rt, tokenOut: p.tok, amountIn: FL.g18(r.stake), fee: p.fee, sqrtPriceLimitX96: 0 }]), true); }) });
    const name = `f-tmp/probe-ma-${i}.json`;
    let out;
    try { ctx.writeRun(name, JSON.stringify(groups)); out = await io.H(['simulate', ctx.rel(name)]); } catch (e) {
      if (!(e instanceof ToolFailure)) throw e;
      legRows.forEach((r) => rows.push({ market: fin.market, side: r.side, artifact_fill: r.quoted_fill, ran: false, why: `simulate failed: ${e.code || 'exit ' + e.helperExit}: ${clip(e.text, 200)}` }));
      continue;
    } finally { try { ctx.removeRun(name); } catch (e) { /* scratch */ } }
    say(`probe (merge-arb) ${fin.market}: simulate all_success ${out.all_success}, failed ${out.failed_count}, calls ${out.count}, overrides_active ${out.overrides_active || false}`);
    if (!out.all_success || out.overrides_active || !Array.isArray(out.returns) || out.returns.length !== 2 + legRows.length) { legRows.forEach((r) => rows.push({ market: fin.market, side: r.side, artifact_fill: r.quoted_fill, ran: false, why: `simulate did not succeed cleanly (all_success ${out.all_success}, failed ${out.failed_count}, overrides ${!!out.overrides_active})` })); continue; }
    const simCost = BigInt(swOut.decodeFunctionResult('exactOutputSingle', out.returns[0].return_data)[0]) + BigInt(swOut.decodeFunctionResult('exactOutputSingle', out.returns[1].return_data)[0]);
    legRows.forEach((r, k) => {
      const ret = out.returns[2 + k].return_data; const p = r.side === 'UP' ? pu : pd;
      let fill; let ticks;
      if (pairLeg(r)) { const d = qto.decodeFunctionResult('quoteExactOutputSingle', ret); fill = Number(BigInt(d[0])) / Number(FL.gCount(r.stake, r.quoted_fill)); ticks = Number(d[2]); } else { const d = qt.decodeFunctionResult('quoteExactInputSingle', ret); fill = Number(FL.g18(r.stake)) / Number(BigInt(d[0])); ticks = Number(d[2]); }
      const relGap = Math.abs(fill - r.quoted_fill) / r.quoted_fill;
      say(`  simulated merge-arb cost ${FL.weiStr(simCost)} (plan row stake ${setRow.stake}); ${r.side} ${pairLeg(r) ? 'pair leg' : 'directional'} on the post-merge-arb state: fill gap ${relGap.toExponential(2)}, ticks crossed ${ticks}`);
      rows.push({ market: fin.market, side: r.side, artifact_fill: r.quoted_fill, ran: true, after: 'merge-arb', simulated_fill: fill, rel_gap: relGap, ticks_crossed: ticks, confirmed: relGap <= 0.01 && ticks === 0, simulated_merge_arb_cost: FL.weiStr(simCost), prefix: { from_mint: FL.weiStr(fromMint), from_bundle: FL.weiStr(fromBundle) }, pool: p.pool });
    });
  }
  return rows;
}

module.exports = { probePost3a };
