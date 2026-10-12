// planner/f-print.cjs - F's plan print, ./run/<run-id>/f-print.md (ported from the live F print script). Offline: it
// formats what f-plan, f-probe-post3a and f-verify computed. In supervised mode the human reads it at gate 2; in
// autonomous mode the run's report.md points at it. Every pair, set row, directional row, step-7 drop, class change and
// skipped market is listed; the wording of a pair and of a set row is the one SKILL.md's gate 2 and F step 3a fix.
'use strict';

const FL = require('./f-lib.cjs');

function printPlan(R, { artifact: A, res, flags, aux, probe, V, gapsMax }) {
  const { S, ctx } = R;
  const lines = []; const P = (s = '') => lines.push(s);
  const w = (x, d = 4) => (typeof x === 'bigint' ? Number(FL.weiStr(x)) : x).toFixed(d);
  const FIN = res.map((r, i) => ({ ...r, opt: flags[i] }));
  const byKey = new Map(A.positions.map((r) => [r.address + '|' + r.side, r]));
  const M = BigInt(aux.M);
  const pins = S.pinOfMarket.filter((b) => Number.isInteger(b));
  const heldN = S.balances.heldEff.filter((h) => BigInt(h) > 0n).length;
  const sym = (r) => String(r.sym).replace('ORIG_R3_REPO:', 'RT:');

  P(`# F plan: allocation.json of run ${ctx.runId}`);
  P();
  P(`Holder \`${S.holder}\`. Pool state read at blocks ${pins.length ? Math.min(...pins) + '..' + Math.max(...pins) : 'none'} (both pools of a market in one multicall file, so each market has one pinned block; the head moves, so no two reads are compared by block). Nothing is sent by F.`);
  P();
  P(`objective max-ev; 98 independent per-market budgets, each \`held_j + M\` (held_j = the repo token held plus its bundle's unsplit tokens, which G middle-splits first; ${heldN} market(s) hold some), so each market may spend up to held_j + M = held_j + ${FL.weiStr(M)} of its own repo token.`);
  const pv = S.provisional;
  const ramp = pv ? ` The holder holds USDC ${S.balances.USDC} (6 decimals) and USDS ${FL.weiStr(BigInt(S.balances.USDS))}, and their PSM3 ramp has not landed: this bankroll counts each at PSM3 minAmountOut (quote x 9999 / 10000), ${FL.weiStr(BigInt(pv.usdc_min_out))} sUSDS for all USDC and ${FL.weiStr(BigInt(pv.usds_min_out))} sUSDS for all USDS, on top of the sUSDS balance ${FL.weiStr(BigInt(S.balances.sUSDS))}. G refuses this plan until the ramp has landed and F has re-run on the real post-ramp sUSDS (F-max-ev.md, intro).` : S.rampDue ? ` **A PSM3 ramp is due:** the holder holds USDC ${S.balances.USDC} (6 decimals) and USDS ${FL.weiStr(BigInt(S.balances.USDS))}; this plan sizes on the sUSDS balance alone, which is not the post-ramp bankroll (I-setup.md I.1 section 5; a supervised session sizes on the queued ramp with \`f --provisional\`; the wake sends the ramp before F).` : ' USDC and USDS are 0: no PSM3 ramp, so the bankroll is not provisional.';
  const capMax = BigInt(aux.capMax);
  P(`Bankroll = ${pv ? '**PROVISIONAL**: the holder\'s sUSDS + PSM3 minAmountOut for all its USDC and USDS =' : 'the holder\'s whole sUSDS balance'} ${FL.weiStr(BigInt(aux.BANKROLL))}.${ramp} M = min(bankroll, max_j (cap_j - held_j)+) = ${FL.weiStr(M)} sUSDS: ${aux.nothingToSpend ? 'nothing to spend (no sUSDS and no repo token held)' : M === BigInt(aux.BANKROLL) && capMax > 0n ? `the bankroll binds (largest unconstrained cap above held_j ${w(capMax)} repo tokens at ${aux.argmax >= 0 ? FIN[aux.argmax].market : '-'})` : `the books bind (largest unconstrained cap above held_j ${w(capMax)} repo tokens${aux.argmax >= 0 ? ' at ' + FIN[aux.argmax].market : ''})`}.`);
  P();
  P(`A \`set\` row's worst_case 0 holds only if its whole keep-whole group lands: the planner sends every group as an ordered sequence of single transactions, on any signer, so a group can be left half-done between transactions, and a half-done group carries the stray leg's risk until its recovery batch lands (G section 8 step 5).`);
  P();
  P(`totals.staked = M = ${w(A.totals.staked, 6)} sUSDS (G splits the parent by M and then each middle whose bundle holds a position by M); totals.expected_value = ${w(A.totals.expected_value, 6)} sUSDS at the labelled 1/N = 1/98 scenario (a repo token is worth 0 if its repo is not evaluated); correlated_worst_case = ${w(A.totals.correlated_worst_case, 6)} sUSDS (the whole outlay can go to zero together; no correlation control).`);
  P();
  P(`Gas floors use F step 7's 2.4e-7 ETH per swap leg = ${w(BigInt(aux.GAS_LEG), 5)} repo tokens (set group 7 legs ${w(BigInt(aux.GAS_SET), 4)}, pair 2 legs ${w(BigInt(aux.GAS_PAIR), 4)}), converted at ${S.gas.susdsPerEth.toFixed(2)} sUSDS per ETH (QuoterV2 WETH/USDC and PSM3 usdPerSusds ${S.gas.usdPerSusds}) and x98; F simulates nothing. For the record: eth_gasPrice ${S.gas.gasPrice} wei, l1BaseFee ${S.gas.l1BaseFee} wei, signer ETH ${FL.weiStr(BigInt(S.balances.eth))} (F does not gate on it; G's affordability check does).`);
  P();
  const negRows = A.positions.filter((r) => r.ev < 0); const negMk = new Map(); A.positions.forEach((r) => negMk.set(r.market, (negMk.get(r.market) || 0) + r.ev));
  P(`Negative-ev rows: ${negRows.length} of ${A.positions.length} rows have ev < 0 (sum ${negRows.reduce((a, r) => a + r.ev, 0).toFixed(4)} repo tokens)${negRows.length ? '; all are legs of a step-3b pair on a CSV market, which keeps its p-based fields although the pair is bought whatever the CSV says (F step 3b and the schema conventions)' : ''}; ${[...negMk.values()].filter((v) => v < 0).length} market(s) have a negative total ev. The step-3b pair is a CSV-independent arbitrage, so it can sit above the CSV's own value of one leg.`);
  P();
  const perMarketAtBudget = (() => { const m = new Map(); A.positions.forEach((r) => m.set(r.address, (m.get(r.address) || 0n) + FL.g18(r.stake))); let n = 0; for (const [a, s] of m) { const i = FIN.findIndex((x) => x.address === a); const Bj = BigInt(S.balances.heldEff[i]) + M; if (Bj > 0n && s >= Bj - Bj / 10n ** 7n) n++; } return n; })();
  P(`Budget headroom: ${perMarketAtBudget} market(s) spend their whole budget held_j + M; on a dual-buy pair that binds the budget, G clamps the second leg's amountInMaximum to what the first leg leaves (G section 3), so F reserves no headroom.`);
  P();
  const post = probe || [];
  P(`Rows sized on a state a step-3a set-sell or merge-arb left (marked "post-set-sell" below; after a merge-arb, a pair leg or folded extra is quoted on the live pool at q + count less the quote at q, an exact-output swap's cost being path-additive) are computed from the 3a quote's sqrtPriceX96After and the pool's liquidity with the exact integer Uniswap v3 single-range model, because the chain helper's call and multicall carry no state override (F step 8); the same model reproduced every QuoterV2 answer of this plan to within ${gapsMax.toExponential(1)} relative.` + (post.length ? ' Each such row was then probed on simulated state with the helper\'s simulate "return" probe (the mint prefix it needs, the set group, then QuoterV2 flagged return): ' + post.map((x) => `${x.market} ${x.side}: ${x.ran ? `fill gap ${x.rel_gap.toExponential(1)}${x.confirmed ? ', confirmed' : ', NOT confirmed (over 1% or ticks crossed): the model\'s numbers are kept and each call\'s floor guards the send'}` : `probe not run (${x.why}): the model's numbers are used`}`).join('; ') + '.' : ' None in this plan.'));
  P();
  if (aux.mergeArbs && aux.mergeArbs.length) {
    P(`Held child Invalid on a sub-1 market is step 3a's merge-arb (F step 3a): on ${aux.mergeArbs.map((x) => `${x.market} (I_j ${FL.weiStr(BigInt(x.childInvalidHeld))}, merge-arb q ${w(BigInt(x.q))}${BigInt(x.remainderPair) > 0n ? `, then a 3b pair of the remainder q ${w(BigInt(x.remainderPair))}` : ''})`).join(', ')} the pairs are bought and merged with the held child Invalid at once, returning q repo tokens now; that child Invalid was retained by earlier runs, and G records its consumption in their fills.json, oldest first.`);
    P();
  }
  P(`Verification of the plan before it was written: ${V.checks.filter((c) => c.pass).length} of ${V.checks.length} checks passed (planner/f-verify.json).${V.drift.moved_markets.length ? ` Pools moved between F's read and its re-quote on ${V.drift.moved_markets.length} market(s) (${V.drift.moved_markets.slice(0, 10).join(', ')}${V.drift.moved_markets.length > 10 ? ', ...' : ''}): their rows are as sized; G's drift report, each call's floor and the pre-send re-check decide.` : ' No planned market\'s pools moved between F\'s read and its re-quote.'}`);
  P();

  const pairs = []; const sets = []; const dirs = [];
  for (const r of FIN) {
    const up = byKey.get(r.address + '|UP'); const dn = byKey.get(r.address + '|DOWN'); const st = byKey.get(r.address + '|set');
    if (up && dn) pairs.push(r); else if (up || dn) dirs.push(r);
    if (st) sets.push(r);
  }
  P(`## Pairs: ${pairs.length} markets, "pair (sum < 1 - f)", f = 0.0001`);
  P();
  for (const r of pairs) {
    const pr = r.pair; const dir = (r.dir && !r.opt.dropDir[r.dir.side]) ? r.dir : null; const sum = Number(pr.cost) / Number(pr.q);
    P(`- **${r.market}** pair (sum < 1 - f): q = ${w(pr.q)} ${sym(r)}; spot sum ${r.spot.sum.toFixed(5)}; locked-in sum = cost/q = ${w(pr.cost)}/${w(pr.q)} = ${sum.toFixed(5)} [limited_by ${pr.limited}]`);
    if (r.set && r.set.route === 'merge-arb' && !r.opt.dropSet) P(`  - after this market's merge-arb of ${w(r.set.q)} pairs: the remainder of the pair bound, priced on the post-merge-arb state`);
    P(`  - outcome: +(1 - sum)*q = ${w(pr.q - pr.cost)} repo tokens if the repo is evaluated and its child resolves to a score; nothing of value lost if the repo is not evaluated (the repo tokens spent were worth 0 then)`);
    P(`  - risk (a): evaluated but the child resolves INVALID anyway: UP + DOWN pay 0, a loss of sum*q = ${w(pr.cost)} repo tokens`);
    P('  - risk (b): the parent\'s n_X and the middle\'s k_X disagree: a repo token pays (n_X/N)/k_X');
    if (dir) P(`  - folded directional extra on ${dir.side}: +${w(dir.extra)} tokens for ${w(dir.extraStake)} repo tokens (p = ${dir.p}, stop at P = p(1-f) = ${dir.targetP.toFixed(6)}${dir.capped ? ', RANGE-CAPPED' : ''}), ev ${w(dir.extraEv)}; ${dir.side} leg total ${w(dir.count)} tokens at stake ${w(dir.legStake)} [limited_by ${dir.limited}]`);
    else if (r.p) P('  - no directional extra (post-pair prices clear neither side, or the extra was floored)');
    else P('  - no CSV forecast for this market (blank cell: unknown): pair only');
  }
  P();
  P(`## Set rows: ${sets.length}`);
  P();
  if (!sets.length) P('(none kept)');
  for (const r of sets) {
    const s = r.set;
    if (s.route === 'merge-arb') P(`- **${r.market}** merge-arb: ${w(s.q)} pairs, cost ≈ ${w(s.cost)}, gain ≈ ${w(s.q - s.cost)} repo tokens now, consumes ${w(s.q)} child Invalid held from earlier runs (I_j ${w(s.Ij)}; G records it in the source runs' fills.json, oldest first) [limited_by ${s.limited}; group = approve, buy q UP, buy q DOWN, approve UP, DOWN and child Invalid, merge: 7 legs]`);
    else P(`- **${r.market}** set-sell: ${w(s.q)} sets, proceeds ≈ ${w(s.proceeds)}, gain ≈ ${w(s.proceeds - s.q)} repo tokens, keeps ${w(s.q)} child Invalid [limited_by ${s.limited}; group = approve, split, approve, sell UP, approve, sell DOWN: 7 legs]`);
  }
  const iHeld = S.balances.childInv.filter((x) => BigInt(x) > 0n).length; const nMa = sets.filter((r) => r.set.route === 'merge-arb').length;
  if (!nMa) P(`- merge-arb: none (${iHeld ? `${iHeld} market(s) hold child Invalid, none of them a sub-1 market whose merge-arb survived step 7` : 'the holder holds no child Invalid anywhere: I_j = 0 for all 98 markets'})`);
  P();
  P(`## Directional (stand-alone, one side) rows: ${dirs.length}`);
  P();
  P('The count is stake / quoted_fill, the simple route\'s; on a one-side market with sum > 1 G routes the row complex-buy, whose delivered count is its own (G section 3).');
  P();
  for (const r of dirs) {
    const d = r.dir; const lb = r.spot.sum > 1;
    P(`- **${r.market}** ${d.side}: stake ${w(d.stake)} repo tokens -> ${w(d.tokens)} tokens, quoted_fill ${w(d.fill, 5)}, p ${d.p}, ev ${w(d.ev)}${d.src === 'model-post-3a' ? ' (post-set-sell, exact model, not the quoter)' : ''}${d.capped ? ' RANGE-CAPPED' : ''}, limited_by ${d.limited}${lb ? '; spot sum > 1 so G routes complex-buy: this count is a LOWER BOUND (more tokens plus child Invalid delivered)' : ''}`);
  }
  P();
  P(`## Dropped by step 7 (${aux.dropLog.length})`);
  P();
  for (const d of aux.dropLog) P(`- ${d.market}: ${d.row} limited_by ${d.limited_by} ` + (d.gain !== undefined ? `gain ${w(d.gain)}` : `ev ${typeof d.ev === 'bigint' ? w(d.ev) : Number(d.ev).toFixed(4)}`) + (d.q !== undefined ? ` q ${w(d.q)}` : '') + (d.stake !== undefined ? ` stake ${w(d.stake)}` : '') + ` (iteration ${d.iteration})`);
  P();
  const cc = FIN.filter((r) => r.cls && r.cls !== r.clsSnap);
  P(`## Class vs the candidates.json snapshot (pools[].price): ${cc.length} market(s) whose class differs`);
  P();
  cc.forEach((r) => P(`- ${r.market}: snapshot sum ${r.snapSum.toFixed(6)} (${r.clsSnap}) -> live ${r.spot.sum.toFixed(6)} (${r.cls})`));
  P(`- live classes: ${JSON.stringify(FIN.reduce((m, r) => { if (r.cls) m[r.cls] = (m[r.cls] || 0) + 1; return m; }, {}))}`);
  P();
  const inPos = new Set(A.positions.map((p) => p.market));
  const skippedOnly = A.skipped.filter((s) => !inPos.has(s.market));
  P(`## No row (skipped): ${skippedOnly.length} markets`);
  P();
  skippedOnly.forEach((s) => P(`- ${s.market}: ${s.reason}`));
  P();
  const evSum = A.positions.reduce((a, r) => a + r.ev, 0);
  P(`**Totals:** ${A.positions.length} rows over ${new Set(A.positions.map((r) => r.address)).size} markets; sum ev = ${evSum.toFixed(4)} repo tokens (different tokens per market) => expected_value ${w(A.totals.expected_value, 6)} sUSDS at 1/98.`);
  return lines.join('\n') + '\n';
}

module.exports = { printPlan };
