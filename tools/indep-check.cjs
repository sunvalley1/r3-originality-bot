'use strict';
// G's independent second-RPC read (supervised only): re-run every read of g-indep-request.json on a second RPC,
// pinned to the block G read it at, and compare the leading values with what G got. Read-only: eth_call only.
const { ethers } = require('C:/Users/12/r3-tools/node_modules/ethers');
const fs = require('fs');

const REQ = process.argv[2];
const RPC = process.argv[3] || 'https://mainnet.optimism.io';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'; // evm-onchain
const mc = new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])']);

function iface(sig) {
  const i = sig.indexOf(')(');
  return new ethers.Interface([`function ${sig.slice(0, i + 1)} view returns ${sig.slice(i + 1)}`]);
}
const norm = (v) => (typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? v.toLowerCase() : String(v));

(async () => {
  const req = JSON.parse(fs.readFileSync(REQ, 'utf8'));
  const provider = new ethers.JsonRpcProvider(RPC, 10, { staticNetwork: true, batchMaxCount: 1 });
  const byBlock = new Map();
  req.reads.forEach((r, k) => { if (!byBlock.has(r.block)) byBlock.set(r.block, []); byBlock.get(r.block).push(k); });
  const bad = []; let ok = 0; let failed = 0;
  for (const [block, idx] of byBlock) {
    for (let s = 0; s < idx.length; s += 60) {
      const part = idx.slice(s, s + 60);
      const calls = part.map((k) => { const r = req.reads[k]; const I = iface(r.signature); const fn = I.fragments[0]; return { target: r.to, allowFailure: true, callData: I.encodeFunctionData(fn, r.args) }; });
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          const raw = await provider.call({ to: MULTICALL3, data: mc.encodeFunctionData('aggregate3', [calls]), blockTag: block });
          res = mc.decodeFunctionResult('aggregate3', raw)[0]; break;
        } catch (e) {
          if (attempt >= 5) throw e;
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      part.forEach((k, j) => {
        const r = req.reads[k];
        if (!res[j].success) { failed++; bad.push(`${r.what} @${block}: call failed on ${RPC}`); return; }
        const I = iface(r.signature); const out = I.decodeFunctionResult(I.fragments[0], res[j].returnData);
        const got = r.expect.map((_, n) => norm(out[n]));
        const want = r.expect.map((x) => String(x).toLowerCase());
        if (got.join('|') === want.join('|')) ok++; else bad.push(`${r.what} @${block}: second RPC ${got.join(',')} vs G ${want.join(',')}`);
      });
    }
  }
  console.log(`independent read on ${RPC}: ${ok} of ${req.reads.length} equal, ${bad.length} differ or failed (${failed} failed calls)`);
  for (const b of bad.slice(0, 40)) console.log('  ' + b);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('error: ' + String(e && e.message || e).split('\n')[0]); process.exit(2); });
