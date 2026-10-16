'use strict';
// Read-only: Swap events on the plan's pools since G's read, with each swap's sender and transaction origin.
const { ethers } = require('C:/Users/12/r3-tools/node_modules/ethers');
const fs = require('fs');
const RUN = process.argv[2]; const FROM = Number(process.argv[3]); const RPC = process.argv[4] || 'https://mainnet.optimism.io';
const req = JSON.parse(fs.readFileSync(RUN + '/g-indep-request.json', 'utf8'));
(async () => {
  const pv = new ethers.JsonRpcProvider(RPC, 10, { staticNetwork: true });
  const head = await pv.getBlockNumber();
  // the pool list: every pool G compared
  const pools = new Map();
  const walk = (o) => { if (!o || typeof o !== 'object') return; if (typeof o.pool === 'string' && /^0x[0-9a-f]{40}$/i.test(o.pool)) pools.set(o.pool.toLowerCase(), (o.market || '') + ' ' + (o.side || '')); for (const v of Object.values(o)) walk(v); };
  for (const r of req.reads) { const m = /^pool (\S+) (UP|DOWN) slot0$/.exec(r.what); if (m) pools.set(r.to.toLowerCase(), m[1] + ' ' + m[2]); }
  const topic = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
  const addrs = [...pools.keys()];
  const logs = [];
  for (let s = 0; s < addrs.length; s += 40) {
    for (let b = FROM; b <= head; b += 2000) {
      const got = await pv.getLogs({ address: addrs.slice(s, s + 40), topics: [topic], fromBlock: b, toBlock: Math.min(head, b + 1999) });
      logs.push(...got);
    }
  }
  const byTx = new Map();
  for (const l of logs) { const k = l.transactionHash; if (!byTx.has(k)) byTx.set(k, { block: l.blockNumber, pools: [] }); byTx.get(k).pools.push(pools.get(l.address.toLowerCase())); }
  const byFrom = new Map();
  for (const [h, v] of byTx) { const tx = await pv.getTransaction(h); const f = tx.from.toLowerCase(); if (!byFrom.has(f)) byFrom.set(f, { txs: 0, swaps: 0, first: v.block, last: v.block, sample: [] }); const e = byFrom.get(f); e.txs++; e.swaps += v.pools.length; e.first = Math.min(e.first, v.block); e.last = Math.max(e.last, v.block); if (e.sample.length < 6) e.sample.push(...v.pools.slice(0, 2)); }
  console.log(`head ${head}; ${pools.size} pools; ${logs.length} swaps in ${byTx.size} transactions since block ${FROM}`);
  for (const [f, e] of [...byFrom.entries()].sort((a, b) => b[1].swaps - a[1].swaps)) console.log(`${f}: ${e.swaps} swaps in ${e.txs} txs, blocks ${e.first}-${e.last}; e.g. ${e.sample.join(' | ')}`);
})().catch((e) => { console.log('error: ' + String(e && e.message || e).split('\n')[0]); process.exit(2); });
