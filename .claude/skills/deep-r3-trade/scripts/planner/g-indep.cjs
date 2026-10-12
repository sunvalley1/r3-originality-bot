// planner/g-indep.cjs - `planner g <run-id> --indep`: the independent second-RPC read of G, as a REQUEST (supervised only).
//
// The live G compared, through a second RPC, the static facts of its plan: every traded pool's slot0 and liquidity, every
// swap quote taken on the current pools, and every market's wrapped tokens and conditionId. The planner contacts no RPC
// itself (every read goes through the chain helper, which pins ONE RPC and takes no URL or block option), so it cannot make
// that read: with --indep it writes ./run/<run-id>/g-indep-request.json instead, each read pinned to the block G read it at
// with the answer G got, for the supervised session to run with a second tool against a second RPC, for example
//   cast call <to> "<signature>" <args> --block <block> --rpc-url https://mainnet.optimism.io
// (https://mainnet.optimism.io serves state at least 1,500 blocks back; optimism-rpc.publicnode.com only about 100), and
// compare the leading values with `expect`. A read pinned to an explicit block compares at that block, never against a
// read at latest (G section 8, The head moves). The scheduled run never passes --indep.
'use strict';

const G = require('./g-lib.cjs');

const SLOT0 = 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)';
const QIN = 'quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)';
const QOUT = 'quoteExactOutputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)';

function writeRequest(R, built) {
  const { ctx, S } = R;
  const reads = [];
  // (1) the pools: slot0 (sqrtPriceX96, tick) and liquidity, at the block of the market's pin (both pools of a market in one file)
  for (const p of S.pools) {
    reads.push({ what: `pool ${p.market} ${p.side} slot0`, to: p.pool, signature: SLOT0, args: [], block: p.block, expect: [String(p.sqrt), String(p.tick)] });
    reads.push({ what: `pool ${p.market} ${p.side} liquidity`, to: p.pool, signature: 'liquidity()(uint128)', args: [], block: p.block, expect: [String(p.L)] });
  }
  // (2) identity: wrappedOutcome(0..2) and conditionId(), at the block of the identity file that read them
  const idBlockOf = (n) => { const b = S.identityBlocks.find((x) => n * 7 >= x.from && n * 7 < x.from + x.n); return b ? b.block : null; };
  S.markets.forEach((m, n) => {
    const block = idBlockOf(n);
    [m.down, m.up, m.inv].forEach((w, k) => reads.push({ what: `${m.name} wrappedOutcome(${k})`, to: m.addr, signature: 'wrappedOutcome(uint256)(address)', args: [String(k)], block, expect: [w] }));
    reads.push({ what: `${m.name} conditionId`, to: m.addr, signature: 'conditionId()(bytes32)', args: [], block, expect: [m.cond] });
  });
  // (3) the swap quotes of the plan taken on the current pools (phase A and B), at the block of their quote file; a quote
  // taken on the state a set group leaves (a probe) has no block to read it at and is not listed
  for (const ph of ['A', 'B']) {
    for (const q of (R.quoteReqs && R.quoteReqs[ph]) || []) {
      if (!q.res || !q.res.ok) continue;
      reads.push({ what: `quote ${q.key}`, to: G.A.QUOTER, signature: q.kind === 'in' ? QIN : QOUT, args: [[q.tokenIn, q.tokenOut, String(q.amt), q.fee, 0]], block: q.res.block, expect: [String(q.res.amt)] });
    }
  }
  const doc = {
    run_id: ctx.runId, written_at: new Date().toISOString(), holder: S.holder,
    purpose: 'the independent second-RPC read of G (supervised only): each read pinned to the block G read it at, with the leading values G got',
    how: 'for each read: cast call <to> "<signature>" <args> --block <block> --rpc-url https://mainnet.optimism.io (or any RPC other than the one the chain helper pins); the first values printed must equal expect, in order. A mismatch on an identity read is a stop; on a pool or a quote it means the two RPCs disagree about that block: do not send before it is explained.',
    rpc_note: 'https://mainnet.optimism.io serves state at least 1,500 blocks back; https://optimism-rpc.publicnode.com only about 100 (chain-helper.README.md, Limits of the public RPCs)',
    plan_groups: built.groups.length,
    reads,
  };
  ctx.writeRunJson('g-indep-request.json', doc, { indent: 1 });
  return { request: ctx.rel('g-indep-request.json'), reads: reads.length, pools: S.pools.length, markets: S.markets.length, quotes: reads.filter((r) => r.what.startsWith('quote ')).length, note: 'requested, not run: the planner contacts no RPC itself; run it with a second tool in the supervised session' };
}

module.exports = { writeRequest };
