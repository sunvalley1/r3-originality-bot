'use strict';
// Read-only status of the R3 book: Reality answers on every question (98 children, 3 middles, the parent's 3),
// swaps by others on our pools since a block, and a spot mark of every position. eth_call and eth_getLogs only.
const { ethers } = require('C:/Users/12/r3-tools/node_modules/ethers');
const fs = require('fs');
const RUN = process.argv[2]; const FROM = Number(process.argv[3]); const RPC = process.argv[4] || 'https://mainnet.optimism.io';
const HOLDER = '0x2ad670e5953a85c998cdf1c2f6d74386ab735d4a';
const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const REALITY = '0x0eF940F7f053a2eF5D6578841072488aF0c7d89A';
const PARENT = '0x37ab5cbeee3a32289430e5d38b914ec7f580fd87';
const MIDDLES = { A: '0xc217920a91f1b3d56276393aa5345f01a848ecf0', B: '0xf0638b8999aaa0de3f5d02048a385a64e7a63aec', C: '0x99a941135226813037e15e34956fdd79761307d3' };
const mc = new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])']);
const mkt = new ethers.Interface(['function questionsIds() view returns (bytes32[])']);
const rea = new ethers.Interface(['function questions(bytes32) view returns (bytes32 content_hash,address arbitrator,uint32 opening_ts,uint32 timeout,uint32 finalize_ts,bool is_pending_arbitration,uint256 bounty,bytes32 best_answer,bytes32 history_hash,uint256 bond,uint256 min_bond)']);
const pool = new ethers.Interface(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function token0() view returns (address)']);
const rd = (p) => JSON.parse(fs.readFileSync(RUN + '/' + p, 'utf8'));

(async () => {
  const pv = new ethers.JsonRpcProvider(RPC, 10, { staticNetwork: true });
  const agg = async (calls) => { const out = []; for (let s = 0; s < calls.length; s += 100) { const raw = await pv.call({ to: MC3, data: mc.encodeFunctionData('aggregate3', [calls.slice(s, s + 100).map((c) => ({ target: c.to, allowFailure: true, callData: c.data }))]) }); out.push(...mc.decodeFunctionResult('aggregate3', raw)[0]); } return out; };

  // 1. Reality answers
  const cands = rd('candidates.json').candidates;
  const marks = [...cands.map((c) => ({ name: c.market, addr: c.address })), ...Object.entries(MIDDLES).map(([k, a]) => ({ name: 'middle ' + k, addr: a })), { name: 'parent', addr: PARENT }];
  const qr = await agg(marks.map((m) => ({ to: m.addr, data: mkt.encodeFunctionData('questionsIds') })));
  const qs = []; marks.forEach((m, i) => { const ids = mkt.decodeFunctionResult('questionsIds', qr[i].returnData)[0]; ids.forEach((id, k) => qs.push({ name: m.name + (ids.length > 1 ? ' q' + k : ''), id })); });
  const st = await agg(qs.map((q) => ({ to: REALITY, data: rea.encodeFunctionData('questions', [q.id]) })));
  const answered = []; qs.forEach((q, i) => { const r = rea.decodeFunctionResult('questions', st[i].returnData); if (r.bond > 0n || r.finalize_ts > 0) answered.push(`${q.name}: answer ${BigInt(r.best_answer)} bond ${ethers.formatEther(r.bond)} ETH finalize ${new Date(Number(r.finalize_ts) * 1000).toISOString()} arbitration ${r.is_pending_arbitration}`); });
  console.log(`Reality: ${qs.length} questions read, ${answered.length} with an answer posted`); answered.forEach((a) => console.log('  ' + a));

  // 2. pools of our positions, from G's own reads
  const req = rd('g-indep-request.json');
  const pools = new Map(); const wrapped = new Map();
  for (const r of req.reads) {
    let m = /^pool (\S+) (UP|DOWN) slot0$/.exec(r.what); if (m) pools.set(m[1] + '|' + m[2], r.to.toLowerCase());
    m = /^(\S+) wrappedOutcome\(([012])\)$/.exec(r.what); if (m) { if (!wrapped.has(m[1])) wrapped.set(m[1], []); wrapped.get(m[1])[Number(m[2])] = r.expect[0].toLowerCase(); }
  }
  const keys = [...pools.keys()];
  const pr = await agg(keys.flatMap((k) => [{ to: pools.get(k), data: pool.encodeFunctionData('slot0') }, { to: pools.get(k), data: pool.encodeFunctionData('token0') }]));
  const price = new Map();
  keys.forEach((k, i) => { const [mk, side] = k.split('|'); const s0 = pool.decodeFunctionResult('slot0', pr[2 * i].returnData); const t0 = pool.decodeFunctionResult('token0', pr[2 * i + 1].returnData)[0].toLowerCase(); const tok = wrapped.get(mk)[side === 'DOWN' ? 0 : 1]; const s = Number(s0[0]) / 2 ** 96; const p = s * s; price.set(k, t0 === tok ? p : 1 / p); });

  // 3. spot mark of each position (repo tokens), and the swaps by others since FROM
  const fills = rd('fills.json').runs.filter((r) => r.status === 'filled' && (r.side === 'UP' || r.side === 'DOWN'));
  let cost = 0; let value = 0; const rows = [];
  for (const r of fills) { const p = price.get(r.market + '|' + r.side); if (p === undefined) continue; cost += r.requested; value += r.filled * p; rows.push({ m: r.market, side: r.side, pnl: r.filled * p - r.requested }); }
  rows.sort((a, b) => a.pnl - b.pnl);
  console.log(`spot mark of ${rows.length} positions: cost ${cost.toFixed(2)} repo tokens, value ${value.toFixed(2)}, P&L ${(value - cost).toFixed(2)} repo tokens = ${((value - cost) / 98).toFixed(3)} sUSDS at 1/98`);
  console.log('  worst: ' + rows.slice(0, 3).map((r) => `${r.m} ${r.side} ${r.pnl.toFixed(2)}`).join('; '));
  console.log('  best:  ' + rows.slice(-3).reverse().map((r) => `${r.m} ${r.side} ${r.pnl.toFixed(2)}`).join('; '));
  const topic = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
  const head = await pv.getBlockNumber(); const addrs = [...new Set(pools.values())]; const byFrom = new Map(); let n = 0;
  for (let s = 0; s < addrs.length; s += 40) for (let b = FROM + 1; b <= head; b += 2000) {
    const logs = await pv.getLogs({ address: addrs.slice(s, s + 40), topics: [topic], fromBlock: b, toBlock: Math.min(head, b + 1999) });
    for (const l of logs) { const tx = await pv.getTransaction(l.transactionHash); const f = tx.from.toLowerCase(); if (f === HOLDER) continue; n++; byFrom.set(f, (byFrom.get(f) || 0) + 1); }
  }
  console.log(`swaps by others on our ${addrs.length} pools since block ${FROM}: ${n}` + (n ? ' (' + [...byFrom].map(([f, c]) => f + ' x' + c).join(', ') + ')' : ''));
})().catch((e) => { console.log('error: ' + String(e && e.message || e).split('\n')[0]); process.exit(2); });
