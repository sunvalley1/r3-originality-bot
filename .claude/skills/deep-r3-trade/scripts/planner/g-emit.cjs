// planner/g-emit.cjs - G's output (ported from the live g-emit): ./run/<run-id>/g-plan.json and ./run/<run-id>/gate-print.md,
// from the read, the build and the verification. Every literal that depends on the data is computed here, none is typed.
// Reads only, all through the chain helper (QuoterV2 pair-cost quotes, GasPriceOracle.getL1Fee of every unsigned
// transaction, the WETH/USDC quote, the PSM3 preview, the holder's ETH). NOTHING IS SIGNED OR SENT; ethers serialises an
// unsigned transaction for getL1Fee and holds no key.
//
// g-plan.json is the executor's input: its group ids, market_refs, pre_send_checks, expected_effects keys, mint.M_wei and
// per-transaction fields (signer_input_file, gas_used, max_used_gas, gas_limit, nonce_expected, l1_fee_wei_at_build,
// swap.quoted_*, rebuild_at_send) and label prefixes are an interface: change them only together with the executor.
'use strict';

const fs = require('fs');
const lib = require('./lib.cjs');
const TB = require('./table.cjs');
const G = require('./g-lib.cjs');

const { A, lc, weiStr: fmt } = G;
const N = G.N;
const n4 = (w) => (Number(w) / 1e18).toFixed(4);
const dec = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const loc = (n) => Number(n).toLocaleString('en-US');
const fileSha = (p) => { try { return lib.sha256(fs.readFileSync(p)); } catch (e) { return null; } };

const SEND_TIME_DUTIES = [
  'before every group: the trading-boundary read and fresh slot0 of the market (G section 3); a flip makes the plan stale',
  'before every group: the affordability gate, ETH >= 0.002 ETH + the sum over the group of gas_limit x 2 x eth_gasPrice (G section 8, Affordability)',
  'before every transaction: the holder nonce latest == pending == nonce_expected; the signer-input file equal to the plan (calldata, to, gasLimit) and its keccak256 equal to calldata_keccak256',
  'before every transaction: the signer\'s own simulate passes, and the pre-send gas check holds: gas_limit >= the fresh gas_used x 1.2, gas_limit >= the peak this plan measured (max_used_gas, else gas_used), and the fresh gas_used at most 10% above this plan\'s (G section 8)',
  'before every swap: its floor (amountOutMinimum) or bound (amountInMaximum) against a fresh quote',
  'write inflight.json and the nonce attempt before every broadcast; one call per send, never re-run once it printed its broadcast line (G section 8; a throttle answered before signing is re-run: I-setup.md I.2 section 7, Rate limits)',
  'before a merge-arb group: its child Invalid read fresh at the holder; below q the plan is stale (G section 1)',
  'rebuild the last two transactions of every complex-buy after the sale\'s receipt, with P = the realised proceeds and a fresh quote at P (rebuild_at_send, G section 3)',
  'a revert, a floor breach or a stale check stops sending; the group in progress goes to the recovery rule, the groups not started are skipped (G section 8 step 4)',
];

async function emit(R, built, V) {
  const { ctx, io, S, E } = R;
  const say = (s) => ctx.log(s);
  const holder = S.holder;
  await G.checkNonce(io, holder, S.nonce.pending, 'G emit');
  const head = await io.H(['block', 'latest']);
  const fh = await io.H(['fee-history']);
  const mk = new Map(built.tm.map((m) => [lc(m.addr), m]));
  const M = built.M; const groups = built.groups;
  const txsAll = groups.flatMap((g) => g.txs);
  const nonce0 = S.nonce.pending;
  const ALLOC = ctx.readRunJson('allocation.json');

  // ---------- pair costs at q (the locked-in sum of a dual-buy pair), for the print ----------
  const duals = built.tm.filter((m) => m.dirRoute === 'dual-buy');
  // a pair after a merge-arb sits on the state the merge-arb leaves: its legs' own probe quotes give the cost at q when
  // both counts are q (no folded extra); a live-pool quote would price the pre-merge-arb state
  const liveDuals = duals.filter((m) => !m.postMA);
  const preq = []; liveDuals.forEach((m) => ['UP', 'DOWN'].forEach((s) => preq.push({ kind: 'out', tokenIn: m.repo, tokenOut: s === 'UP' ? m.up : m.down, amt: m.qpair, fee: m.fee[s] })));
  const pq = await io.quotes(preq);
  liveDuals.forEach((m, k) => { const u = pq[2 * k]; const d = pq[2 * k + 1]; m.pairIn = u && d && u.ok && d.ok ? { UP: u.amt, DOWN: d.amt } : null; });
  duals.filter((m) => m.postMA).forEach((m) => { m.pairIn = m.cnt.UP === m.cnt.DOWN ? { UP: m.quotedIn.UP, DOWN: m.quotedIn.DOWN } : null; });

  // ---------- gas: the live fee read, the L1 data fee of every unsigned transaction, ETH and sUSDS prices ----------
  const gasPrice = BigInt(fh.gas_price); const baseFee = BigInt(head.base_fee_per_gas || 0); const maxFee = gasPrice * 2n; // the signer signs maxFeePerGas = 2 x eth_gasPrice
  const unsigned = txsAll.map((t) => E.Transaction.from({ type: 2, chainId: TB.CHAIN_ID, nonce: nonce0 + t.idx, to: t.to, value: 0, data: t.data, gasLimit: BigInt(t.gas_limit), maxFeePerGas: maxFee, maxPriorityFeePerGas: gasPrice > baseFee ? gasPrice - baseFee : 0n }).unsignedSerialized);
  const l1r = unsigned.length ? await io.mcChunked(unsigned.map((u) => ({ to: A.GPO, signature: 'getL1Fee(bytes)(uint256)', args: [u] })), 60) : [];
  const l1 = l1r.map((r) => BigInt(r[0]));
  const px = await io.mc([
    { to: A.QUOTER, signature: 'quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)', args: [[A.WETH, A.USDC, '1000000000000000000', 500, 0]] },
    { to: A.PSM3, signature: 'previewSwapExactIn(address,address,uint256)(uint256)', args: [A.sUSDS, A.USDS, '1000000000000000000'] },
    { to: A.MC3, signature: 'getEthBalance(address)(uint256)', args: [holder] },
  ]);
  const usdPerEth = Number(px[0][0]) / 1e6; const usdPerSusds = Number(px[1][0]) / 1e18; const ethBal = BigInt(px[2][0]);
  const susdsPerEth = usdPerSusds > 0 ? usdPerEth / usdPerSusds : 0;
  if (ethBal !== S.eth) say(`NOTE: the holder's ETH is ${fmt(ethBal)} now, ${fmt(S.eth)} at G's read (the nonce is unchanged, so no send of the holder's moved it); the walk below uses the fresh balance`);
  const walk = (eff) => {
    let bal = ethBal; let cum = 0n; let need0 = 0n; let first = null; let reserveHit = null; let lastGroup = -1; let minAtGroupStart = null; let minGroup = null;
    txsAll.forEach((t, i) => {
      if (t.group !== lastGroup) {
        lastGroup = t.group;
        if (minAtGroupStart === null || bal < minAtGroupStart) { minAtGroupStart = bal; minGroup = t.group; }
        const groupCeil = groups[t.group].txs.reduce((s, x) => s + BigInt(x.gas_limit) * maxFee, 0n);
        if (reserveHit === null && bal < G.RESERVE_WEI + groupCeil) reserveHit = { group: t.group, first_tx: i, balance_at_group_start: bal, requirement: G.RESERVE_WEI + groupCeil };
      }
      const up = BigInt(t.gas_limit) * maxFee; // the signer's up-front check: balance >= gasLimit x maxFeePerGas (execution gas only)
      const need = cum + up; if (need > need0) need0 = need;
      if (first === null && bal < up) first = { idx: i, label: t.label, group: t.group, balance_before: bal, upfront_needed: up };
      const cost = BigInt(t.gas_used) * eff + l1[i]; bal -= cost; cum += cost;
    });
    return { total_cost: cum, min_start_balance: need0, first_upfront_failure: first, first_group_failing_affordability: reserveHit, min_balance_at_a_group_start: minAtGroupStart, group_of_min: minGroup, end_balance: bal };
  };
  const sumGas = txsAll.reduce((s, t) => s + t.gas_used, 0); const sumLimit = txsAll.reduce((s, t) => s + Number(t.gas_limit), 0);
  const sumL1 = l1.reduce((a, b) => a + b, 0n);
  const scen = [{ name: 'effective price = eth_gasPrice (what the node suggests)', eff: gasPrice }, { name: 'effective price = the signer\'s ceiling maxFeePerGas = 2 x eth_gasPrice', eff: maxFee }];
  const ethRes = scen.map((s) => ({ scenario: s.name, effective_gas_price_wei: s.eff, ...walk(s.eff) }));
  const toSusds = (wei) => Number(wei) / 1e18 * susdsPerEth;
  const okScen = (r) => ethBal >= r.min_start_balance && r.first_upfront_failure === null && r.first_group_failing_affordability === null;
  const ethFund = {
    holder_eth_wei: ethBal, holder_eth: fmt(ethBal), holder_eth_at_read_wei: S.eth, eth_gasPrice_wei: gasPrice, base_fee_per_gas_wei: baseFee, maxFeePerGas_wei: maxFee, reserve_eth: fmt(G.RESERVE_WEI),
    affordability_rule: 'before each keep-whole group: ETH >= 0.002 ETH + the sum over the group of gas_limit x 2 x eth_gasPrice (G section 8, Affordability); the executor makes this check fresh before each group; this walk is a projection',
    sum_gasUsed: sumGas, sum_gas_limit: sumLimit, l1_data_fee_total_wei: sumL1, l1_data_fee_source: 'GasPriceOracle.getL1Fee(unsigned type-2 transaction) read through the helper multicall for every transaction (0x420...000F)',
    usd_per_eth: usdPerEth, usd_per_susds: usdPerSusds, susds_per_eth: susdsPerEth, price_sources: 'QuoterV2.quoteExactInputSingle(WETH, USDC, 1e18, fee 500) and PSM3.previewSwapExactIn(sUSDS, USDS, 1e18), read through the helper; sUSDS is not a dollar (I-setup.md I.1 section 6)',
    scenarios: ethRes.map((r) => ({ ...r, total_cost_eth: fmt(r.total_cost), total_cost_susds: toSusds(r.total_cost), min_start_balance_eth: fmt(r.min_start_balance), enough: okScen(r) })),
    affordable: ethRes.every(okScen),
  };

  // ---------- allocation rollups ----------
  const rows = ALLOC.positions; const rowsBy = new Map();
  rows.forEach((r) => { const a = lc(r.address); if (!rowsBy.has(a)) rowsBy.set(a, []); rowsBy.get(a).push(r); });
  const byKind = {};
  groups.filter((g) => g.kind !== 'mint').forEach((g) => {
    const o = (byKind[g.kind] = byKind[g.kind] || { groups: 0, tx: 0, ev_repo: 0, worst_repo: 0, gas: 0, rows: 0 });
    o.groups++; o.tx += g.txs.length; o.gas += g.txs.reduce((s, t) => s + t.gas_used, 0); o.rows += g.rows.length;
    g.rows.forEach((r) => { const row = (rowsBy.get(lc(g.address)) || []).find((x) => x.side === r.side); if (row) { o.ev_repo += row.ev; o.worst_repo += row.worst_case; } });
  });
  const evTotal = rows.reduce((s, r) => s + (Number(r.ev) || 0), 0);
  const kindOf = (k) => byKind[k] || { groups: 0, tx: 0, gas: 0, rows: 0, ev_repo: 0, worst_repo: 0 };
  const mintGroups = groups.filter((g) => g.kind === 'mint'); const mintGas = mintGroups.reduce((s, g) => s + g.txs.reduce((a, t) => a + t.gas_used, 0), 0);
  const txByKind = {}; groups.forEach((g) => { txByKind[g.kind] = (txByKind[g.kind] || 0) + g.txs.length; });
  const setMarkets = built.tm.filter((m) => m.set);
  const cxNoSet = groups.filter((g) => g.kind === 'complex-buy' && !mk.get(lc(g.address)).set).length; const cxSet = groups.filter((g) => g.kind === 'complex-buy' && mk.get(lc(g.address)).set).length;
  const bandCut = duals.filter((m) => m.bandCut && m.bandCut.length);
  const kindsStr = Object.keys(txByKind).map((k) => k + ' ' + txByKind[k]).join(', ');
  const nTx = txsAll.length; const lastNonce = nonce0 + nTx - 1;

  // ---------- the simulation record ----------
  const winRec = built.sim.windows.map((w) => ({ file: w.file, file_sha256: lib.sha256(ctx.readRel(w.file)), group_indexes: w.groupIdx, entries: w.page.entries, count: w.page.count, all_success: w.page.all_success, failed_count: w.page.failed_count, over_cap_count: w.page.over_cap_count, clamped_count: w.page.clamped_count, pending_nonce: w.page.pending_nonce, no_max_used_gas_count: w.page.no_max_used_gas_count === undefined ? 0 : w.page.no_max_used_gas_count }));
  const noMax = txsAll.filter((t) => t.max_used_gas === null).length;
  const simulation = {
    requests: winRec.length, windowed: built.sim.windowed, windows: winRec,
    helper_subcommand: 'simulate (groups form, one blockStateCalls entry per keep-whole group)',
    file: winRec.length ? winRec[0].file : null, file_sha256: winRec.length ? winRec[0].file_sha256 : null,
    entries: winRec.reduce((s, w) => s + w.entries, 0), count: winRec.reduce((s, w) => s + w.count, 0),
    all_success: winRec.every((w) => w.all_success === true), failed_count: winRec.reduce((s, w) => s + (w.failed_count || 0), 0), over_cap_count: winRec.reduce((s, w) => s + (w.over_cap_count || 0), 0), clamped_count: winRec.reduce((s, w) => s + (w.clamped_count || 0), 0),
    pending_nonce: nonce0, no_max_used_gas_count: noMax,
    gas_limit_rule: 'ceil(maxUsedGas x 1.2), clamped at 16777216; ceil(gasUsed x 1.5) for a call the RPC gave no maxUsedGas (G section 8, Gas limits); copied from the helper, never computed by hand',
    sum_gas_used: sumGas, sum_gas_limit: sumLimit, largest_gas_limit: txsAll.length ? Math.max(...txsAll.map((t) => Number(t.gas_limit))) : 0,
    note: built.sim.windowed ? 'NOT one request: the plan was cut into windows between markets, each beginning with the mint prefix and simulated from chain state without the earlier windows\' effects (G section 8, Money rules)' : 'one request: the whole ordered sequence',
  };

  // ---------- the plan object ----------
  const helperSha = fileSha(ctx.cfg.helperPath); const signerSha = fileSha(ctx.cfg.signerPath);
  const groupsOut = groups.map((g, gi) => {
    const m = mk.get(lc(g.address));
    const eff = V.effects[g.id] || {};
    const o = {
      index: gi, id: g.id, kind: g.kind, recorded_route: g.kind === 'mint' ? 'split-parent' : g.kind === 'merge-arb' ? 'buy-and-merge' : g.kind, market: g.market, address: lc(g.address),
      allocation_rows: g.rows || [], expected_effects: Object.fromEntries(Object.entries(eff).map(([k, v]) => [k, fmt(v)])),
      effects_unit: g.kind === 'mint' ? 'sUSDS / bundle token / repo token deltas (18 dec)' : 'deltas in the market\'s repo token and its outcome tokens (18 dec); sUSDS equivalent at the labelled 1/N is repo/98',
      txs: g.txs.map((t) => {
        const tx = {
          idx: t.idx, nonce_expected: nonce0 + t.idx, label: t.label, to: t.to, value: '0', data: t.data, calldata_keccak256: t.keccak256, selector: t.selector, gas_used: t.gas_used, max_used_gas: t.max_used_gas, gas_limit: String(t.gas_limit),
          gas_limit_basis: t.max_used_gas !== null ? 'ceil(maxUsedGas x 1.2), clamped at 2^24, from this call\'s row of the ordered simulation (G section 8, Gas limits)' : 'ceil(gasUsed x 1.5): the pinned RPC returned no maxUsedGas for this call (G section 8, Gas limits, fallback)',
          l1_fee_wei_at_build: l1[t.idx].toString(), signer_input_file: t.file, signer_check: 'allowed',
        };
        if (t.rebuild_at_send) tx.rebuild_at_send = 'sequential mode (G section 3): build after the sale\'s receipt with P = the realised proceeds (repo-token balance after minus before) and a fresh quote at P; simulate that pair before sending. The calldata here uses the QUOTED P and is what the whole-sequence simulation ran.';
        if (t.swap) tx.swap = dec(t.swap);
        return tx;
      }),
    };
    if (m) {
      o.market_refs = { address: m.addr, repo_token: m.repo, down: m.down, up: m.up, child_invalid: m.inv, bundle: m.bundle, slot: m.slot, fee_tier: m.fee, pools: m.pool, token0_is_outcome: { DOWN: m.slot0.DOWN.T0, UP: m.slot0.UP.T0 } };
      o.pre_send_checks = { condition_id: m.cond, question_id: m.qid, payoutDenominator_at_build: m.bound.payout, isPendingArbitration_at_build: m.bound.pending, getFinalizeTS_at_build: m.bound.finalize, getOpeningTS_at_build: m.bound.opening, spot_at_build: { UP: m.spot.UP, DOWN: m.spot.DOWN, sum: m.spot.sum }, pin_block_at_build: m.pin, note: 'repeat immediately before the first transaction of this group: payoutDenominator, isPendingArbitration, getFinalizeTS (nonzero past = stale), getOpeningTS nonzero; fresh slot0 of both pools; each swap\'s floor/inMax below' };
    } else if (g.kind === 'mint' && S.levels) {
      // the plan-time reading of the level a mint splits (G section 3 gates an entry send on its child; a split is gated
      // only on a flip of its own level since this reading)
      const lv = g.id === 'mint-parent' ? 'parent' : g.id.slice(-1); const L = S.levels[lv];
      if (L) o.pre_send_checks = { level: lv, condition_id: L.condition_id, payoutDenominator_at_build: L.payout, questions_at_build: L.questions.map((q) => ({ question_id: q.id, isPendingArbitration: q.pending, getFinalizeTS: q.finalize, getOpeningTS: q.opening })), note: 'repeat immediately before the first transaction of this group: a flip of payoutDenominator or isPendingArbitration since this reading, a zero getOpeningTS (a failed read), or, on a level unresolved here, a nonzero getFinalizeTS already past makes the plan stale (G section 3); a level already resolved here refuses nothing by itself' };
    }
    return o;
  });
  const runRel = ctx.runRel;
  const plan = {
    run_id: ctx.runId, step: 'G (build + simulate + verify; nothing sent)', status: groups.length ? 'built and simulated; NOTHING WAS SENT' : 'nothing to send: no group survived (no mint and no row)', built_at: new Date().toISOString(),
    environment: 'Optimism mainnet (chain id 10) through the pinned read-only chain helper',
    holder, signer: { path: ctx.cfg.signerPath, sha256: signerSha, one_call_per_send: true, mode: 'sequential (one transaction per signer call; works on any signer, atomic or not)', nonce_pinning: 'read from setup.deep-r3-trade.json by the executor, never inferred' },
    base: { head_at_read: S.head.number, pending_nonce: nonce0, first_nonce: nonce0, last_nonce_if_all_sent: nTx ? lastNonce : null, note: 'no step compares block numbers or hashes between reads: validity at each send rests on the nonce (latest == pending == nonce_expected), the per-market pin, the drift report, each call\'s floor and the pre-send re-check (G section 8, The head moves)' },
    inputs: {
      allocation_json: { path: `${runRel}/allocation.json`, sha256: lib.sha256(ctx.readRun('allocation.json')), generated_at: ALLOC.generated_at, totals: ALLOC.totals, rows: ALLOC.positions.length, markets: built.tm.length },
      candidates_json_sha256: lib.sha256(ctx.readRun('candidates.json')), r3_data_json_sha256: ctx.existsRun('r3-data.json') ? lib.sha256(ctx.readRun('r3-data.json')) : null, f_state_sha256: lib.sha256(ctx.readRun('planner/f-state.json')),
      chain_helper_sha256: helperSha, signer_sha256: signerSha,
    },
    mint: {
      totals_staked_susds: fmt(M), M_wei: M, b_X: built.bX, m_X_wei: built.mX, parent_split: M > 0n, bundles_with_position: S.bundlesWithPosition, bundles_split: mintGroups.filter((g) => g.id !== 'mint-parent').map((g) => g.id.slice(-1)),
      ramp: S.rampDue ? `DUE: USDC ${S.balances.USDC}, USDS ${S.balances.USDS} held; the PSM3 ramp is its own batch ahead of F (G section 1, I-setup.md I.1 section 5; the wake sends it before F, a supervised session on its own yes) and is not in this plan, which spends sUSDS only` : `none (USDC and USDS are both 0)`,
      note: 'parent split by M (none when M = 0), then each middle with a position by m_X = M + b_X (none when m_X = 0); no zero split emitted; the mint is not re-sized',
    },
    ordering: 'mint-parent, mint-middle A, B, C (those emitted), then the trade groups in allocation order, each market\'s set group ahead of its UP/DOWN rows; every group is an ordered sequence of single transactions, sent one at a time in nonce order',
    route_counts: { markets: built.tm.length, allocation_rows: ALLOC.positions.length, rows_in_groups: groups.reduce((s, g) => s + (g.rows ? g.rows.length : 0), 0), skipped_rows: built.skippedRows.length, dual_buy_pairs: duals.length, simple_buy: kindOf('simple-buy').groups, complex_buy: kindOf('complex-buy').groups, set_sell: kindOf('set-sell').groups, merge_arb: kindOf('merge-arb').groups, mint_groups: mintGroups.length, groups: groups.length, transactions: nTx },
    skipped_rows: built.skippedRows,
    cut: built.cut || null, // the rebuilt plan failed its simulation again: groups from cut.at_group on are skipped rows (G section 8)
    drift: { file: `${runRel}/planner/g-drift.json`, pools_compared: S.drift.pools_compared, pools_moved: S.drift.pools_moved, markets_moved: S.drift.markets_moved, f_pins: S.drift.f_pins, g_pins: S.drift.g_pins, fresh_quote_vs_f_quoted_fill_max_rel_gap: built.worstRel, note: S.drift.note },
    simulation,
    balances_before: Object.fromEntries(Object.entries(S.balances).map(([k, v]) => [k, v.toString()])),
    balances_read_at_block: S.balancesBlock, eth_at_read_wei: S.eth.toString(),
    eth_funding: dec(ethFund),
    totals: { staked_susds: ALLOC.totals.staked, expected_value_susds_at_1_over_98: ALLOC.totals.expected_value, correlated_worst_case_susds: ALLOC.totals.correlated_worst_case, unit_note: 'M sUSDS is minted into independent per-market repo-token budgets; every per-market number is in that market\'s repo token; sUSDS equivalent at the labelled 1/N = 1/98 (0 if the repo is not evaluated)', sum_ev_repo_tokens: evTotal },
    by_route: dec(byKind),
    route_agreement_set_markets: dec(built.agreement),
    end_state_check: { balances_probed: V.probes, simulated_equals_predicted: V.matched, differences: V.mismatches.length, simulate_requests: V.requests, method: 'each simulate window re-run with one final group of flagged balanceOf calls, 20 per request; a difference is recorded, never hidden (the pools may have moved since the build)' },
    expected_end_state_of_probed_tokens: dec(Object.fromEntries(Object.entries(V.endState).map(([k, v]) => [k, fmt(v)]))),
    verification: { helper_encode_vs_ethers: `${nTx} of ${nTx} identical (calldata and keccak256)`, signer_check_allowed: `${nTx} of ${nTx}`, boundary_at_build: `${S.markets.length} of ${S.markets.length} children clear at block ${S.boundary.block} (timestamp ${S.boundary.timestamp}); parent and 3 middles payoutDenominator ${S.midPayouts.join('/')}` },
    indep: R.indep || null,
    send_time_duties: SEND_TIME_DUTIES,
    groups: groupsOut,
  };
  ctx.writeRun('g-plan.json', JSON.stringify(plan, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));

  // ---------- gate-print.md ----------
  const out = []; const P = (s = '') => out.push(s);
  const sus = (w) => (Number(w) / 1e18 / N).toFixed(6);
  const e0 = ethRes[0]; const e1 = ethRes[1];
  const totalStakeRepo = rows.reduce((s, r) => s + (Number(r.stake) || 0), 0);
  P(`# G gate print - run ${ctx.runId}`);
  P();
  P(`**Optimism mainnet, holder ${holder}. Built, simulated and verified: nothing has been signed or sent.** Pending nonce ${nonce0}; head at G's read ${S.head.number} (blocks are reported, never compared between reads). Every group below is an ordered sequence of single transactions, one signer call each.`);
  P();
  if (built.cut) { P(`**Cut plan.** ${built.cut.reason}; ${built.cut.rows_skipped} row(s) are written skipped (section 5e)${built.cut.mint_groups_cut ? `, and ${built.cut.mint_groups_cut} mint group(s) are not sent` : ''}. The groups below, before the failing one, stay sendable.`); P(); }
  if (!groups.length) {
    P('**Nothing to send.** ' + (ALLOC.positions.length ? `Every row of allocation.json was skipped (section 5e) and there is no mint (M = ${fmt(M)}).` : `allocation.json has no row and totals.staked is ${ALLOC.totals.staked}.`));
    P();
  }
  P('## 1. The numbers');
  P();
  P('| | |');
  P('|---|---|');
  P(`| **Allocation input** | \`${runRel}/allocation.json\` (sha256 \`${plan.inputs.allocation_json.sha256}\`), generated ${ALLOC.generated_at}, ${ALLOC.positions.length} rows; ${built.tm.length} markets traded, ${built.skippedRows.length} rows skipped (section 5e) |`);
  P(`| **Counts per route** | pair (\`dual-buy\`) **${duals.length}** markets (${duals.length * 2} rows); \`simple-buy\` **${kindOf('simple-buy').groups}**; \`complex-buy\` **${kindOf('complex-buy').groups}** (${cxNoSet} single-side markets with spot sum > 1${cxSet ? `, plus ${cxSet} on a market whose \`set-sell\` runs first` : ''}); \`set-sell\` **${kindOf('set-sell').groups}**; \`merge-arb\` (\`buy-and-merge\`) **${kindOf('merge-arb').groups}**; mint groups **${mintGroups.length}**${mintGroups.length ? ' (' + mintGroups.map((g) => g.id).join(', ') + ')' : ''}; PSM3 ramp: ${S.rampDue ? '**due, not in this plan** (its own batch ahead of F)' : 'none'} |`);
  P(`| **Total sUSDS staked** | **${fmt(M)} sUSDS** = \`totals.staked\` = the new mint \`M\`${M === 0n ? ' (no parent split: the rows spend repo tokens the holder already holds)' : ''}${M > 0n && M === S.balances.sUSDS ? ' = the holder\'s whole sUSDS balance' : M > 0n ? ` (the holder holds ${fmt(S.balances.sUSDS)})` : ''}. Middles split: ${mintGroups.filter((g) => g.id !== 'mint-parent').map((g) => g.id.slice(-1) + ' by m_X = ' + fmt(built.mX[g.id.slice(-1)])).join(', ') || 'none'}. Each traded market's budget is its held repo tokens plus m_X; the rows' stakes sum to ${totalStakeRepo.toFixed(4)} repo tokens of ${built.tm.length} different tokens (${(totalStakeRepo / N).toFixed(4)} sUSDS-equivalent at the labelled 1/98) |`);
  P(`| **Expected value** | **${Number(ALLOC.totals.expected_value).toFixed(6)} sUSDS** at the labelled 1/N = 1/98 (F's \`totals.expected_value\`; ${evTotal.toFixed(4)} repo tokens summed over heterogeneous markets, / 98; 0 for any repo that is not evaluated) |`);
  P(`| **Worst case** | \`correlated_worst_case\` **${Number(ALLOC.totals.correlated_worst_case).toFixed(6)} sUSDS** (F's definition); a \`set-sell\` row's gain is locked only if its whole group lands |`);
  P(`| **Number of transactions** | **${nTx}** in **${groups.length}** keep-whole groups${kindsStr ? ' (' + kindsStr + ')' : ''}${nTx ? `, nonces ${nonce0} to ${lastNonce}` : ''} |`);
  P(`| **Estimated gas** | **${loc(sumGas)} gas used** (mints ${loc(mintGas)}${Object.keys(byKind).map((k) => '; ' + k + ' ' + loc(byKind[k].gas)).join('')}); sum of the gas limits ${loc(sumLimit)}, largest limit ${loc(simulation.largest_gas_limit)} (2^24 = 16,777,216). In ETH: **${fmt(e0.total_cost)} ETH** at \`eth_gasPrice\` ${gasPrice} wei (execution ${fmt(BigInt(sumGas) * gasPrice)} + L1 data fee ${fmt(sumL1)} from \`GasPriceOracle.getL1Fee\`), at most ${fmt(e1.total_cost)} ETH at the signer's ceiling (2 x gas price); about **${toSusds(e0.total_cost).toFixed(4)} sUSDS** (${usdPerEth.toFixed(2)} USD/ETH from QuoterV2 WETH/USDC fee 500, / ${usdPerSusds.toFixed(6)} USD per sUSDS from PSM3) |`);
  P(`| **Simulation** | ${simulation.requests} \`eth_simulateV1\` request(s) (helper \`simulate\`, one \`blockStateCalls\` entry per keep-whole group)${simulation.windowed ? ', **windowed: not one request**' : ''}, no state overrides: \`all_success\` **${simulation.all_success}**, \`failed_count\` ${simulation.failed_count}, \`clamped_count\` ${simulation.clamped_count}, \`over_cap_count\` ${simulation.over_cap_count}, pending nonce ${nonce0} |`);
  P();
  P('## 2. ETH for gas');
  P();
  P(`The holder holds **${fmt(ethBal)} ETH**; \`eth_gasPrice\` ${gasPrice} wei (base fee ${baseFee} wei). The simulation runs with \`validation: false\` and does not see ETH, so it is walked here: the signer refuses a transaction unless the balance covers \`gasLimit x maxFeePerGas\` (execution only), and before each group G section 8 asks for ETH >= 0.002 ETH + the group's \`gas_limit x 2 x eth_gasPrice\`. The executor makes that check fresh before each group; this is a projection.`);
  P();
  P(`| price assumption | effective price | cost of all ${nTx} transactions (execution + L1 data fee) | starting balance the walk needs | first transaction the signer would refuse | first group failing the affordability gate | lowest balance at a group start |`);
  P('|---|---|---|---|---|---|---|');
  for (const r of ethRes) P(`| ${r.scenario} | ${r.effective_gas_price_wei} wei | ${fmt(r.total_cost)} ETH | ${fmt(r.min_start_balance)} ETH | ${r.first_upfront_failure ? '#' + r.first_upfront_failure.idx + ' `' + r.first_upfront_failure.label + '`' : 'none'} | ${r.first_group_failing_affordability ? 'group ' + r.first_group_failing_affordability.group + ' (`' + groups[r.first_group_failing_affordability.group].id + '`)' : 'none'} | ${r.min_balance_at_a_group_start === null ? '-' : fmt(r.min_balance_at_a_group_start) + ' ETH (group ' + r.group_of_min + ')'} |`);
  P();
  P('Result: ' + (ethFund.affordable ? '**no ETH shortfall** under either assumption.' : '**ETH SHORTFALL** under at least one assumption (table): the executor skips the first group it cannot afford and every later one (G section 8, Affordability).'));
  P();
  P('## 3. Drift, the simulation, and what was checked');
  P();
  P(`- **Pool drift since F sized the plan** (\`${plan.drift.file}\`): ${S.drift.pools_moved} of ${S.drift.pools_compared} pools moved, on ${S.drift.markets_moved.length} market(s)${S.drift.markets_moved.length ? ': ' + S.drift.markets_moved.slice(0, 12).join(', ') + (S.drift.markets_moved.length > 12 ? ', ...' : '') : ''}. A moved pool is reported, never stale by itself; each call carries its own floor and the pre-send re-check decides. Fresh quotes vs F's \`quoted_fill\`: largest relative gap ${built.worstRel.toExponential(2)} (drift, not a check).`);
  P(`- **Simulation**: ${simulation.note}. ${simulation.entries} entries and ${simulation.count} calls in all, from the holder, in send order.`);
  P(`- **Gas limits** are the helper's \`gas_limit\` per call, copied, never computed by hand: ${noMax === 0 ? '`ceil(maxUsedGas x 1.2)` on every call' : `\`maxUsedGas\` present on ${nTx - noMax} of ${nTx} calls (\`ceil(maxUsedGas x 1.2)\`); the fallback \`ceil(gasUsed x 1.5)\` on the rest`}; the largest is ${loc(simulation.largest_gas_limit)}.`);
  P(`- **Calldata**: all ${nTx} calldatas re-encoded by the helper's \`encode\` equal the ethers encoding (bytes and keccak256); the signer's policy-only \`check\` **allowed all ${nTx}** signer-input files (\`${runRel}/g-tx/tx-NNN.json\`, each \`{"calls":[one call],"gasLimit":"<helper gas_limit>"}\`).`);
  P(`- **End state**: the simulated end state equals the prediction on **${V.matched} of ${V.probes}** probed balances${V.mismatches.length ? ` (**${V.mismatches.length} differ**: ${V.mismatches.slice(0, 6).map((b) => b.name + ' by ' + (b.got - b.want)).join(', ')}; the pools moved between the quotes and the probe, or a prediction is wrong: read before any yes)` : ''}.`);
  P(`- **Independent read**: ${R.indep && R.indep.request ? `requested (\`${R.indep.request}\`, ${R.indep.reads} reads): run each with a second tool against a second RPC at its block and compare; the helper pins one RPC, so the planner does not make this read itself` : 'not run (`--indep` not given; it is supervised-only, because the helper pins one RPC)'}.`);
  P(`- **Trading boundary at build**: ${plan.verification.boundary_at_build}. Re-read immediately before every group at send time.`);
  for (const a of built.agreement) P(`- **Route of a market with a \`set\` row** (${a.market}): fresh spot sum ${a.fresh_spot_sum.toFixed(6)} -> ${a.fresh_route}; sum after its own set-sell ${a.post_set_sell_sum.toFixed(6)} -> ${a.post_set_route}${a.agree ? ': they agree.' : ': **they disagree**; the fresh-slot0 route is used (G section 3).'}`);
  P();
  P(`## 4. Mints (${mintGroups.length} group${mintGroups.length === 1 ? '' : 's'} at the head of the sequence, each \`[approve, split]\`)`);
  P();
  if (!mintGroups.length) P(`- none: M = ${fmt(M)} and no bundle token is held for a bundle with a position, so no split is emitted (G section 1).`);
  for (const g of mintGroups) P(`- \`${g.id}\`: ${g.txs.map((t) => t.label).join(' ; ')} (gas used ${g.txs.map((t) => loc(t.gas_used)).join(' + ')})`);
  P();
  P('## 5. Per-market print (units: the row\'s own repo token; sUSDS equivalent at the labelled 1/98 in brackets)');
  P();
  P(`### 5a. Pairs: \`dual-buy\`, "pair (sum < 1 - f)", f = 0.0001 (${duals.length} markets)`);
  P();
  let pairCost = 0; let pairGain = 0;
  for (const m of duals) {
    const g = groups.find((x) => x.id === 'dual-buy:' + m.name);
    const q = m.qpair; const cu = m.pairIn ? m.pairIn.UP : null; const cd = m.pairIn ? m.pairIn.DOWN : null;
    if (cu === null) { P(`- **${m.name}** pair (sum < 1 - f): q = ${n4(q)}; the pair-cost quote at q failed (print only)`); continue; }
    const locked = Number(cu + cd) / Number(q); const gain = (1 - locked) * Number(q) / 1e18;
    pairCost += Number(cu + cd) / 1e18; pairGain += gain;
    const diff = m.cnt.UP > m.cnt.DOWN ? m.cnt.UP - m.cnt.DOWN : m.cnt.DOWN - m.cnt.UP; const bigSide = diff <= 10n ** 12n ? null : (m.cnt.UP > m.cnt.DOWN ? 'UP' : 'DOWN');
    P(`- **${m.name}** pair (sum < 1 - f): q = ${n4(q)} repo tokens; spot sum ${m.sum.toFixed(5)}; locked-in sum = cost/q = ${n4(cu + cd)}/${n4(q)} = ${locked.toFixed(5)}; cost ${n4(cu + cd)} [${sus(cu + cd)} sUSDS]`);
    P(`  - outcome: +(1 - sum)*q = ${gain.toFixed(4)} repo tokens if the repo is evaluated and its child resolves to a score | nothing of value lost if the repo is not evaluated`);
    P(`  - risk (a): evaluated but the child resolves INVALID anyway: UP + DOWN pay 0, loss sum*q = ${(locked * Number(q) / 1e18).toFixed(4)} repo tokens | risk (b): n_X and k_X disagree: a repo token pays (n_X/N)/k_X`);
    if (bigSide) { const tx = g.txs[bigSide === 'UP' ? 1 : 3]; P(`  - folded directional extra on ${bigSide}: +${n4(m.cnt[bigSide] - q)} tokens for ${n4(tx.swap.quoted_amountIn - m.pairIn[bigSide])} repo tokens (${bigSide} leg total ${n4(m.cnt[bigSide])} tokens at stake ${n4(m.sw[bigSide])})`); } else P('  - no folded directional extra (the two leg counts are equal up to truncation)');
    P(`  - legs: UP count ${n4(m.cnt.UP)} (stake ${n4(m.sw.UP)}, inMax ${n4(m.inMax.UP)}), DOWN count ${n4(m.cnt.DOWN)} (stake ${n4(m.sw.DOWN)}, inMax ${n4(m.inMax.DOWN)})${m.bandCut && m.bandCut.length ? `; the 0.5% band of ${m.bandCut.join(' and ')} is cut to what the market has left (G section 3)` : ''}; group \`[approve, buy UP, approve, buy DOWN]\`, 4 transactions`);
  }
  if (duals.length) { P(); P(`Pairs in total: cost ${pairCost.toFixed(4)} repo tokens, locked gain ${pairGain.toFixed(4)} repo tokens if every repo is evaluated and every child resolves to a score (heterogeneous tokens, informational).`); }
  P();
  P(`### 5b. Set rows: set-sell and merge-arb (${setMarkets.length} market${setMarkets.length === 1 ? '' : 's'})`);
  P();
  for (const m of setMarkets.filter((x) => x.setInfo.route === 'merge-arb')) { const si = m.setInfo; P(`- **${m.name}** merge-arb: ${n4(si.q)} pairs, cost ~ ${n4(si.cost)}, gain ~ ${n4(si.gain)} repo tokens now, consumes ${n4(si.q)} child Invalid held from earlier runs (I_j ${n4(si.Ij)}; recorded in their fills.json after it lands, oldest first). Leg bounds: UP amountInMaximum ${fmt(si.maxUP)}, DOWN ${fmt(si.maxDOWN)} (quoted_in x min(q / cost, 1.005)); group [approve, buy q UP, buy q DOWN, approve UP, approve DOWN, approve child Invalid, merge q], 7 transactions.`); }
  for (const m of setMarkets.filter((x) => x.setInfo.route !== 'merge-arb')) { const si = m.setInfo; P(`- **${m.name}** set-sell: ${n4(si.q)} sets, proceeds ~ ${n4(si.proceeds)}, gain ~ ${n4(si.gain)} repo tokens, keeps ${n4(si.q)} child Invalid [${sus(si.proceeds)} sUSDS-equivalent proceeds]. No-loss floors (sum >= q): UP leg >= ${fmt(si.minUP)}, DOWN leg >= ${fmt(si.minDOWN)}. Fresh spot sum ${m.sum.toFixed(6)}.`); }
  P();
  P(`### 5c. Complex-buy (${kindOf('complex-buy').groups} groups: split \`x = stake\`, sell the other leg, buy the own leg with the proceeds; keeps \`x\` child Invalid; the last two transactions are rebuilt at send time with the realised proceeds)`);
  P();
  for (const g of groups.filter((x) => x.kind === 'complex-buy')) {
    const m = mk.get(lc(g.address)); const r = g.rows[0]; const fCount = r.stake / r.quoted_fill; const total = m.x + m.buyQ;
    P(`- **${m.name}** complex-buy ${m.s}: split x = ${n4(m.x)} repo tokens [${sus(m.x)} sUSDS-eq], sell x ${m.o} for P = ${n4(m.sellQ)} repo tokens, buy ${n4(m.buyQ)} ${m.s} -> **${n4(total)} ${m.s} + ${n4(m.x)} child Invalid** (quoted total; F's simple-route count ${fCount.toFixed(4)}${m.set ? ', on the post-set-sell book' : ''}; complex ${((Number(total) / 1e18 / fCount - 1) * 100).toFixed(3)}% vs the simple route); spot sum ${m.sum.toFixed(5)} > 1; p_win ${r.p_win === null ? 'null' : Number(r.p_win).toFixed(4)}`);
  }
  P();
  P(`### 5d. Simple-buy (${kindOf('simple-buy').groups} groups: one approve and one \`exactInputSingle\`, min 99.5% of the quote)`);
  P();
  for (const g of groups.filter((x) => x.kind === 'simple-buy')) {
    const m = mk.get(lc(g.address)); const r = g.rows[0]; const t = g.txs[1];
    P(`- **${m.name}** simple-buy ${m.s}: stake ${n4(m.x)} repo tokens [${sus(m.x)} sUSDS-eq], quoted out ${n4(t.swap.quoted_amountOut)} ${m.s} (F count ${(r.stake / r.quoted_fill).toFixed(4)}), floor ${n4(t.swap.amountOutMinimum)}; spot sum ${m.sum.toFixed(5)}${m.set ? ' (quoted on the post-set-sell state)' : ' < 1'}; p_win ${r.p_win === null ? 'null' : Number(r.p_win).toFixed(4)}`);
  }
  P();
  P(`### 5e. Skipped rows (${built.skippedRows.length}: never sent; the executor writes each \`status: "skipped"\` with its reason)`);
  P();
  if (!built.skippedRows.length) P('- none');
  for (const r of built.skippedRows) P(`- ${r.market} ${r.side} (${r.route}, stake ${r.stake}): ${r.reason}`);
  P();
  P('## 6. Group order and gas (send order)');
  P();
  P('| # | group | tx | gas used |');
  P('|---|---|---|---|');
  groups.forEach((g, gi) => P(`| ${gi} | \`${g.id}\` | ${g.txs.map((t) => t.idx).filter((x, i, a) => i === 0 || i === a.length - 1).join('-')} | ${loc(g.txs.reduce((s, t) => s + t.gas_used, 0))} |`));
  P();
  P('## 7. Risks the human is told before any "yes" (supervised mode)');
  P();
  P('- **One transaction per signer call.** Every group above is an ordered sequence of single transactions and **can be left half-done between transactions** (one pair leg bought, a split without its sales, a `set-sell` whose gain is locked only if its whole group lands). A stopped group goes to the recovery rule (G section 8 step 4). EIP-7702 removes this risk and is recommended.');
  P('- **Residual risks (a) and (b)** of every pair and of the folded directional rows (section 5a): (a) the repo is evaluated but its child question resolves INVALID, UP + DOWN pay 0; (b) the parent\'s `n_X` and the middle\'s `k_X` disagree, a repo token pays `(n_X/N)/k_X`.');
  if (bandCut.length) P(`- **${bandCut.length} pair${bandCut.length === 1 ? '' : 's'} bind${bandCut.length === 1 ? 's' : ''} the market's repo-token budget** (${bandCut.map((m) => m.name).join(', ')}): the second leg's \`inMax\` is cut to what the market has left (G section 3), so a drift at send larger than that headroom reverts it and leaves the pair half-done; that goes to the recovery rule, never to a resize.`);
  P('- **Complex-buy is chosen on the spot sum.** At size it can quote slightly below the simple route (section 5c); G section 3 keeps the rule as written.');
  P('- **Sequence order and mints are not re-sized**; any send-time disagreement (balance, boundary flip, floor) makes the plan stale.');
  if (S.rampDue) P('- **A PSM3 ramp is due** (USDC or USDS held): it is its own batch ahead of F, not part of this plan.');
  P();
  P('## 8. At send time (the executor\'s duties; they do not change this plan)');
  P();
  SEND_TIME_DUTIES.forEach((d) => P('- ' + d));
  P();
  P(`Files: \`g-plan.json\` (groups, every call with calldata, keccak256, gas limit, floors and expected effects), \`g-tx/tx-NNN.json\` (one signer-input file per transaction), ${winRec.map((w) => '`' + w.file.replace(runRel + '/', '') + '`').join(', ') || 'no simulate file'} (the helper simulate input${winRec.length > 1 ? 's' : ''}), \`planner/g-drift.json\` (the drift report).`);
  ctx.writeRun('gate-print.md', out.join('\n') + '\n');
  say(`wrote g-plan.json and gate-print.md (${out.length} lines)`);
  return { plan, ethFund, sumGas, sumLimit, sumL1, usdPerEth, usdPerSusds };
}

module.exports = { emit };
