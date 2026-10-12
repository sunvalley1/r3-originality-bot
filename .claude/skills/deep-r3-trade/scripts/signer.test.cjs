'use strict';
/*
 * signer.test.cjs - self-test for signer.cjs. Offline: a local mock JSON-RPC server (chain id 10) stands in for
 * the network, and a THROWAWAY wallet is generated fresh on every run. No real network, no real key.
 *
 *   node signer.test.cjs [--dir <work dir>]
 *
 * Prints PASS / FAIL / SKIP per case and exits non-zero if any case FAILs. Needs the skill folder it ships in
 * (`..` from this file, the one holding steps/C-select.md and steps/G-mint-and-trade.md, which it reads exactly as
 * allowlist-init does); run it from the skill's scripts/ folder. Also needs ethers 6.17 resolvable from here
 * (see signer.README.md section 7.1).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const ethers = require('ethers');
const { Wallet, Transaction, keccak256, getAddress, AbiCoder, solidityPacked, toUtf8Bytes, ZeroHash, recoverAddress } = ethers;

const SIGNER_SRC = path.join(__dirname, 'signer.cjs');
const SKILL_DIR = path.resolve(__dirname, '..'); // shipped layout: scripts/ sits inside the skill folder
const BURN = '0x000000000000000000000000000000000000dEaD';
const ZERO64 = '0'.repeat(64);
const lc = (a) => String(a).toLowerCase();

// ---- work dir: one fresh sub-folder per run, so a key is never reused -----------------------------------------
const dirArg = process.argv.indexOf('--dir');
const baseDir = dirArg > 0 ? path.resolve(process.argv[dirArg + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'r3-signer-test-'));
fs.mkdirSync(baseDir, { recursive: true });
const ROOT = path.join(baseDir, 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
fs.mkdirSync(ROOT, { recursive: true });

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
class Skip extends Error {}
const skip = (why) => { throw new Skip(why); };
const ALL_OUTPUT = []; // every byte any signer child printed, scanned for key material at the end
const NEEDLES = []; // secrets of the throwaway wallets, which must never appear in any of it
const deadPid = () => cp.spawnSync(process.execPath, ['-e', '0']).pid; // the pid of a process that has already exited
const TRANSCRIPT = [];

// ---- mock JSON-RPC server --------------------------------------------------------------------------------------
class MockRpc {
  constructor() { this.world = null; this.reset(); }
  reset() {
    this.chainId = 10n; this.latest = 7; this.pending = 7; this.balance = 10n ** 18n; this.gasPrice = 1_000_000n; this.tip = 100_000n;
    this.noTip = false; this.estimate = 200_000n; this.callRevert = false; this.callError = null; this.sendMode = 'accept'; this.receiptDelayMs = 600; this.receiptStatus = '0x1';
    this.simStatus = '0x1'; this.simulateSupported = true; this.tokenBalance = 0n; this.throttle = 0; this.throttleSend = 0; this.http429 = 0;
    this.requests = []; this.raws = []; this.rawEvents = []; this.txs = new Map(); this.firstReceiptServedAt = null; this.sendAttempts = 0;
  }
  async start() {
    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => this.handle(Buffer.concat(chunks).toString('utf8'), res));
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }
  stop() { return new Promise((r) => { this.server.closeAllConnections?.(); this.server.close(r); }); }
  tick() { const now = Date.now(); for (const tx of this.txs.values()) if (!tx.applied && now >= tx.minedAt) { tx.applied = true; this.latest = Math.max(this.latest, tx.nonce + 1); } }
  handle(text, res) {
    let payload; try { payload = JSON.parse(text); } catch { res.writeHead(400); return res.end(); }
    const items = Array.isArray(payload) ? payload : [payload];
    const isSend = items.some((i) => i.method === 'eth_sendRawTransaction');
    if (isSend) this.sendAttempts++;
    if ((isSend && this.throttleSend > 0) || (!isSend && this.throttle > 0)) {
      if (isSend) this.throttleSend--; else this.throttle--;
      this.http429++; res.writeHead(429, { 'content-type': 'text/plain' }); return res.end('slow down');
    }
    this.tick();
    const out = []; let httpStatus = 200;
    for (const it of items) {
      this.requests.push({ t: Date.now(), method: it.method, params: it.params });
      let r;
      try { r = this.dispatch(it.method, it.params || []); } catch (e) { r = { error: { code: e.rpcCode || -32000, message: e.message } }; }
      if (r && r.http) { httpStatus = r.http; break; }
      if (r && r.hang) return; // never answer
      out.push({ jsonrpc: '2.0', id: it.id, ...(r && r.error ? { error: r.error } : { result: r ? r.result : null }) });
    }
    res.writeHead(httpStatus, { 'content-type': 'application/json' });
    res.end(httpStatus !== 200 ? 'mock failure' : JSON.stringify(Array.isArray(payload) ? out : out[0]));
  }
  dispatch(method, p) {
    const hex = (n) => '0x' + BigInt(n).toString(16);
    switch (method) {
      case 'eth_chainId': return { result: hex(this.chainId) };
      case 'eth_blockNumber': return { result: '0x64' };
      case 'eth_getTransactionCount': return { result: hex(p[1] === 'pending' ? Math.max(this.pending, this.latest) : this.latest) };
      case 'eth_gasPrice': return { result: hex(this.gasPrice) };
      case 'eth_maxPriorityFeePerGas': return this.noTip ? { error: { code: -32601, message: 'method not found' } } : { result: hex(this.tip) };
      case 'eth_getBalance': return { result: hex(this.balance) };
      case 'eth_estimateGas': return { result: hex(this.estimate) };
      case 'eth_getCode': return { result: this.world && this.world.codeOf ? this.world.codeOf(p[0]) : '0x6080' };
      case 'eth_call': {
        const c = p[0];
        if (this.world && lc(c.to) === lc(this.world.multicall)) return { result: this.world.aggregate3(c.data) };
        if (this.callError) return { error: this.callError };
        if (this.callRevert) return { error: { code: 3, message: 'execution reverted' } };
        if (String(c.data).startsWith('0x70a08231')) return { result: '0x' + this.tokenBalance.toString(16).padStart(64, '0') };
        return { result: '0x' };
      }
      case 'eth_simulateV1': {
        if (!this.simulateSupported) return { error: { code: -32601, message: 'the method eth_simulateV1 does not exist' } };
        const calls = p[0].blockStateCalls[0].calls;
        return { result: [{ calls: calls.map(() => (this.simStatus === '0x1' ? { status: '0x1', gasUsed: '0x5208', returnData: '0x', logs: [] } : { status: '0x0', gasUsed: '0x5208', returnData: '0x', logs: [], error: { code: 3, message: 'execution reverted' } })) }] };
      }
      case 'eth_sendRawTransaction': {
        const raw = p[0]; this.raws.push(raw); this.rawEvents.push({ t: Date.now(), log: (() => { try { return M0 ? fs.readFileSync(M0.cfg.logPath, 'utf8') : ''; } catch { return ''; } })() });
        if (this.sendMode === 'http500') return { http: 500 };
        if (this.sendMode === 'hang') return { hang: true };
        const tx = Transaction.from(raw);
        if (this.sendMode === 'error-nonce-low' || tx.nonce < this.latest) return { error: { code: -32000, message: 'nonce too low' } };
        if (tx.chainId !== this.chainId) return { error: { code: -32000, message: 'invalid chain id for signer' } };
        this.pending = Math.max(this.pending, tx.nonce + 1);
        this.txs.set(lc(tx.hash), { tx, raw, nonce: tx.nonce, minedAt: Date.now() + this.receiptDelayMs, applied: false });
        return { result: tx.hash };
      }
      case 'eth_getTransactionReceipt': {
        const t = this.txs.get(lc(p[0]));
        if (!t || Date.now() < t.minedAt) return { result: null };
        if (this.firstReceiptServedAt === null) this.firstReceiptServedAt = Date.now();
        return { result: { transactionHash: t.tx.hash, status: this.receiptStatus, blockNumber: '0x65', gasUsed: '0x5208', from: t.tx.from } };
      }
      case 'eth_getTransactionByHash': { const t = this.txs.get(lc(p[0])); return { result: t ? { hash: t.tx.hash, nonce: hex(t.nonce) } : null }; }
      default: return { error: { code: -32601, message: `the method ${method} does not exist` } };
    }
  }
}

// ---- synthetic chain for allowlist-init (Multicall3 + markets + CTF + factory + pools) -------------------------------
function makeWorld(S, cTable, opts = {}) {
  const P = S.PINNED; const T = S.PINNED_TREE; const abi = AbiCoder.defaultAbiCoder();
  const synth = (label, a) => getAddress('0x' + keccak256(toUtf8Bytes(label + a)).slice(26));
  const world = { multicall: '0xcA11bde05977b3631167028862bE2a173976CA11', factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', markets: new Map(), tokens: new Map(), pools: new Map(), poolByPair: new Map(), tamper: new Set() };
  const cond = (a) => keccak256(toUtf8Bytes('cond' + lc(a)));
  const collId = (p, c, i) => keccak256(abi.encode(['bytes32', 'bytes32', 'uint256'], [p, c, i]));
  const posId = (coll) => BigInt(keccak256(solidityPacked(['address', 'bytes32'], [P.susds, coll])));
  const add = (m) => { world.markets.set(lc(m.address), m); m.wrapped.forEach((t, j) => world.tokens.set(lc(t), { m, j })); };
  add({ address: T.parent, pcol: ZeroHash, wrapped: [...T.bundles, T.parentInvalid] });
  T.middles.forEach((m) => {
    const rows = cTable.rows.filter((r) => r.bundle === m.bundle);
    add({ address: m.market, pcol: keccak256(toUtf8Bytes('pcol-mid' + m.bundle)), wrapped: [...rows.map((r) => r.repoToken), m.invalid] });
  });
  const children = cTable.rows.map((r) => {
    const m = { address: r.market, pcol: keccak256(toUtf8Bytes('pcol-child' + r.market)), wrapped: [synth('down', r.market), synth('up', r.market), synth('inv', r.market)], row: r };
    add(m); return m;
  });
  const addPool = (a, b, fee, liq) => {
    const [t0, t1] = lc(a) < lc(b) ? [a, b] : [b, a];
    const addr = synth('pool' + fee, lc(a) + lc(b));
    world.pools.set(lc(addr), { addr, fee, t0, t1, liq });
    world.poolByPair.set(`${lc(t0)}|${lc(t1)}|${fee}`, addr);
  };
  children.forEach((c, i) => {
    for (const [side, j] of [['down', 0], ['up', 1]]) {
      const tok = c.wrapped[j]; const repo = c.row.repoToken;
      if (opts.noPool && opts.noPool(i, side)) continue;
      addPool(tok, repo, opts.tier ? opts.tier(i, side) : 100, opts.zeroLiq && opts.zeroLiq(i, side) ? 0n : 1_000_000n + BigInt(i));
      if (opts.extraPool && opts.extraPool(i, side)) addPool(tok, repo, 500, 9_999_999n);
    }
  });
  world.codeOf = () => '0x' + [S.SEL.split, S.SEL.merge, S.SEL.redeem, S.SEL.exactInputSingle, S.SEL.exactOutputSingle, S.SEL.swapExactIn, S.SEL.swapExactOut].map((s) => s.slice(2)).join('') + '00'.repeat(32);
  const I = S.IF;
  world.callOne = (to, data) => {
    const t = lc(to); const sel = data.slice(0, 10);
    const mk = world.markets.get(t);
    if (mk) {
      if (sel === I.market.getFunction('conditionId').selector) return I.market.encodeFunctionResult('conditionId', [cond(mk.address)]);
      if (sel === I.market.getFunction('parentCollectionId').selector) return I.market.encodeFunctionResult('parentCollectionId', [mk.pcol]);
      if (sel === I.market.getFunction('wrappedOutcome').selector) {
        const j = Number(I.market.decodeFunctionData('wrappedOutcome', data)[0]);
        if (j >= mk.wrapped.length) throw new Error('revert');
        return I.market.encodeFunctionResult('wrappedOutcome', [mk.wrapped[j], '0x']);
      }
    }
    if (t === lc(P.ctf)) {
      if (sel === I.ctf.getFunction('getCollectionId').selector) { const [p, c, i] = I.ctf.decodeFunctionData('getCollectionId', data); return I.ctf.encodeFunctionResult('getCollectionId', [collId(p, c, i)]); }
      if (sel === I.ctf.getFunction('getPositionId').selector) { const [, coll] = I.ctf.decodeFunctionData('getPositionId', data); return I.ctf.encodeFunctionResult('getPositionId', [posId(coll)]); }
    }
    const tk = world.tokens.get(t);
    if (tk && sel === I.erc20.getFunction('tokenId').selector) {
      const id = world.tamper.has(t) ? 12345n : posId(collId(tk.m.pcol, cond(tk.m.address), 1n << BigInt(tk.j)));
      return I.erc20.encodeFunctionResult('tokenId', [id]);
    }
    if (t === lc(world.factory) && sel === I.factory.getFunction('getPool').selector) {
      const [a, b, fee] = I.factory.decodeFunctionData('getPool', data);
      const [t0, t1] = lc(a) < lc(b) ? [a, b] : [b, a];
      return I.factory.encodeFunctionResult('getPool', [world.poolByPair.get(`${lc(t0)}|${lc(t1)}|${Number(fee)}`) || ethers.ZeroAddress]);
    }
    const pool = world.pools.get(t);
    if (pool) {
      if (sel === I.pool.getFunction('fee').selector) return I.pool.encodeFunctionResult('fee', [pool.fee]);
      if (sel === I.pool.getFunction('token0').selector) return I.pool.encodeFunctionResult('token0', [pool.t0]);
      if (sel === I.pool.getFunction('token1').selector) return I.pool.encodeFunctionResult('token1', [pool.t1]);
      if (sel === I.pool.getFunction('liquidity').selector) return I.pool.encodeFunctionResult('liquidity', [pool.liq]);
    }
    if (t === lc(P.psm3)) {
      for (const n of ['susds', 'usdc', 'usds']) if (sel === I.psm3.getFunction(n).selector) return I.psm3.encodeFunctionResult(n, [P[n]]);
    }
    throw new Error('mock world: unhandled call ' + sel + ' to ' + t);
  };
  world.aggregate3 = (data) => {
    const [calls] = I.multicall.decodeFunctionData('aggregate3', data);
    const results = calls.map((c) => { try { return [true, world.callOne(c.target, c.callData)]; } catch { return [false, '0x']; } });
    return I.multicall.encodeFunctionResult('aggregate3', [results]);
  };
  return world;
}

// ---- fixtures ---------------------------------------------------------------------------------------------------
const mock = new MockRpc();
const W = { root: ROOT, project: path.join(ROOT, 'project'), data: path.join(ROOT, 'data') };
let S; // the signer module, loaded from an install dir
let cTable; let gTable;

function nodeModulesDir() {
  let p = path.dirname(require.resolve('ethers'));
  while (path.basename(p) !== 'node_modules') { const up = path.dirname(p); if (up === p) throw new Error('cannot find node_modules for ethers'); p = up; }
  return p;
}
function makeInstall(name, over = {}, baseDirectory = ROOT) {
  const dir = path.join(baseDirectory, name); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SIGNER_SRC, path.join(dir, 'signer.cjs'));
  fs.symlinkSync(nodeModulesDir(), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const cfg = {
    chainId: 10, rpcUrl: mock.url, signerAddress: W.address, owner: W.owner, projectRoot: W.project, keystorePath: W.keystore,
    signerMode: 'password-file', unlockPath: W.unlock, allowlistPath: path.join(W.data, name + '-allowlist.json'), allowlistSha256: ZERO64,
    sendLockPath: path.join(W.data, name + '-send.lock'), logPath: path.join(W.data, name + '-signer.log.jsonl'),
    receiptTimeoutSec: 2, receiptPollMs: 100, rpcTimeoutMs: 3000, rpcRetries: 3, rpcBackoffMs: 20, ...over,
  };
  const inst = { name, dir, bin: path.join(dir, 'signer.cjs'), cfgPath: path.join(dir, 'signer.config.json'), cfg };
  inst.writeConfig = () => fs.writeFileSync(inst.cfgPath, JSON.stringify(inst.cfg, null, 2));
  inst.setAllowlist = (text) => { fs.mkdirSync(path.dirname(inst.cfg.allowlistPath), { recursive: true }); fs.writeFileSync(inst.cfg.allowlistPath, text); inst.cfg.allowlistSha256 = crypto.createHash('sha256').update(text).digest('hex'); inst.writeConfig(); return inst.cfg.allowlistSha256; };
  inst.writeConfig();
  return inst;
}
const synthAddr = (label, a) => getAddress('0x' + keccak256(toUtf8Bytes(label + a)).slice(26));
function synthAllowlist(S2, holder) {
  const P = S2.PINNED; const T = S2.PINNED_TREE;
  return {
    format: S2.FORMAT, chain_id: 10, generated_at: 'test', holder: getAddress(holder),
    contracts: Object.fromEntries(Object.keys(P).map((k) => [k, getAddress(P[k])])),
    psm3_selectors: ['swapExactIn'],
    parent: { market: getAddress(T.parent), outcomes: [...T.bundles, T.parentInvalid].map(getAddress) },
    middles: T.middles.map((m, i) => ({ bundle: m.bundle, market: getAddress(m.market), bundle_token: getAddress(T.bundles[i]), invalid: getAddress(m.invalid), slots: m.repos + 1 })),
    children: cTable.rows.map((r, i) => ({
      index: i, repo: r.repo, bundle: r.bundle, slot: r.slot, market: getAddress(r.market), repo_token: getAddress(r.repoToken),
      down: synthAddr('down', r.market), up: synthAddr('up', r.market), invalid: synthAddr('inv', r.market),
      fee_down: 100, fee_up: i === 1 ? 500 : 100, pool_down: null, pool_up: null,
    })),
  };
}

function childEnv(extra = {}) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'COMSPEC', 'PATHEXT', 'LANG'];
  const env = {}; for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}
function run(inst, args, opts = {}) {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [...(opts.nodeArgs || []), ...(opts.entry ? [opts.entry] : []), inst.bin, ...args], { cwd: opts.cwd || W.project, env: childEnv(opts.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let buf = ''; const lines = [];
    child.stdout.on('data', (d) => {
      const s = d.toString(); out += s; buf += s; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); let json = null; try { json = JSON.parse(line); } catch { /* not json */ }
        const rec = { t: Date.now(), line, json }; lines.push(rec);
        if (opts.onLine) opts.onLine(rec, child);
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => child.kill(), opts.timeoutMs || 90000);
    child.on('close', (code) => {
      clearTimeout(timer); ALL_OUTPUT.push(out, err);
      const json = lines.map((l) => l.json).filter(Boolean);
      resolve({ code, stdout: out, stderr: err, lines, json, last: json[json.length - 1] });
    });
  });
}
let inputSeq = 0;
function input(obj, name) {
  const file = path.join(W.project, 'run', name || `input-${++inputSeq}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
}
function resetFs(inst) { for (const p of [inst.cfg.sendLockPath, inst.cfg.logPath]) { try { fs.unlinkSync(p); } catch { /* absent */ } } }
function note(label, args, res) { TRANSCRIPT.push(`$ node signer.cjs ${args.join(' ')}   # ${label}\n${res.stdout.trim()}\n(exit ${res.code})\n`); }

// call builders ----------------------------------------------------------------------------------------------------
let M0; // the main install
let POL; // the synthetic allowlist document
const C = () => POL.children;
const P = () => ({ ...S.PINNED });
const lcP = (k) => lc(S.PINNED[k]);
const approve = (token, spender, amount) => ({ to: token, data: S.IF.erc20.encodeFunctionData('approve', [spender, amount]) });
const split = (market, amount, coll) => ({ to: S.PINNED.router, data: S.IF.router.encodeFunctionData('splitPosition', [coll || S.PINNED.susds, market, amount]) });
const merge = (market, amount) => ({ to: S.PINNED.router, data: S.IF.router.encodeFunctionData('mergePositions', [S.PINNED.susds, market, amount]) });
const redeem = (market, idx, amts) => ({ to: S.PINNED.router, data: S.IF.router.encodeFunctionData('redeemPositions', [S.PINNED.susds, market, idx, amts]) });
const swapIn = (o) => ({ to: S.PINNED.swapRouter02, data: S.IF.swap.encodeFunctionData('exactInputSingle', [{ tokenIn: o.tokenIn, tokenOut: o.tokenOut, fee: o.fee, recipient: o.recipient, amountIn: o.amount ?? 1n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }]) });
const swapOut = (o) => ({ to: S.PINNED.swapRouter02, data: S.IF.swap.encodeFunctionData('exactOutputSingle', [{ tokenIn: o.tokenIn, tokenOut: o.tokenOut, fee: o.fee, recipient: o.recipient, amountOut: o.amount ?? 1n, amountInMaximum: 10n, sqrtPriceLimitX96: 0n }]) });
const psm = (name, a, b, receiver, amount = 1n) => ({ to: S.PINNED.psm3, data: S.IF.psm3.encodeFunctionData(name, [a, b, amount, 0n, receiver, 0n]) });
const goodSwapIn = () => swapIn({ tokenIn: C()[0].up, tokenOut: C()[0].repo_token, fee: 100, recipient: W.address });

// result assertions -------------------------------------------------------------------------------------------------
function expectRefusal(res, rule, { rpc0 = true, rawsZero = true, index } = {}) {
  assert.equal(res.code, 3, `exit code 3 expected, got ${res.code}; stdout=${res.stdout}; stderr=${res.stderr}`);
  assert.equal(res.last.refused, 'allowlist', `refused:'allowlist' expected: ${res.stdout}`);
  assert.equal(res.last.rule, rule, `rule ${rule} expected, got ${res.last.rule} (${res.last.detail})`);
  if (index !== undefined) assert.equal(res.last.index, index);
  if (rpc0) assert.equal(mock.requests.length, 0, `refusal must be decided before any RPC call, but the mock saw ${mock.requests.map((r) => r.method).join(',')}`);
  if (rawsZero) assert.equal(mock.raws.length, 0, 'nothing may reach eth_sendRawTransaction');
}
const checkOf = (inst, obj) => run(inst, ['check', input(obj)]);
const parseRaw = (raw) => Transaction.from(raw);

async function withFreshState(inst, fn) { mock.reset(); resetFs(inst); return fn(); }

// =========================================================================================================
// A. unit-level facts about the implementation
// =========================================================================================================
test('A1 selectors match the values the skill and Uniswap/PSM3 publish', () => {
  assert.equal(S.SEL.approve, '0x095ea7b3');
  assert.equal(S.SEL.swapExactIn, '0x1a019e37'); // I-setup.md section 5
  assert.equal(S.SEL.exactInputSingle, '0x04e45aaf'); // SwapRouter02 IV3SwapRouter
  assert.equal(S.SEL.exactOutputSingle, '0x5023b4df');
});
test('A2 the skill tables parse: 98 rows, bundles 33/33/32, and agree with the pinned addresses', () => {
  assert.equal(cTable.rows.length, 98);
  assert.deepEqual(['A', 'B', 'C'].map((b) => cTable.rows.filter((r) => r.bundle === b).length), [33, 33, 32]);
  S.crossCheckTables(cTable, gTable);
});
test('A3 the check path contains no signing, key, RPC or lock code (static scan of its own functions)', () => {
  // (?<![\w]) keeps the refusal pattern for the JSON-RPC method name "eth_signTransaction" from counting as a call
  const forbidden = /makeRpc|fetch\(|loadWallet|readUnlockPassword|(?<!\w)signTransaction|(?<!\w)sendRawTransaction|broadcastOne|takeLock|fromEncryptedJson|keystorePath|unlockPath|spawnSync/;
  for (const name of ['cmdCheck', 'offlinePipeline', 'checkCall', 'checkCalls', 'parseInput', 'parseArgs', 'normalizeCall', 'compilePolicy', 'decodeStrict', 'findModeSwitchEnv', 'findRuntimeOverride']) {
    const src = S.sources[name].toString();
    assert.ok(!forbidden.test(src), `${name} references a forbidden identifier: ${forbidden.exec(src)}`);
  }
  // loadAllowlist and readInputFile may read FILES but never the key files or the network
  for (const name of ['loadAllowlist', 'readInputFile']) assert.ok(!/loadWallet|fromEncryptedJson|fetch\(|makeRpc|signTransaction/.test(S.sources[name].toString()));
});
test('A4 dispatch reads argv[0] only: a restricted name never reinterprets a later token as a subcommand', async () => {
  await withFreshState(M0, async () => {
    const r1 = await run(M0, ['send', input([approve(S.PINNED.susds, S.PINNED.router, 1n)]), 'reconcile']);
    expectRefusal(r1, 'mode-switch');
    const r2 = await run(M0, ['reconcile', 'send']);
    assert.equal(r2.code, 2); assert.equal(r2.last.error, 'usage');
    const r3 = await run(M0, ['sendx', 'f']); assert.equal(r3.code, 2); assert.equal(r3.last.error, 'usage');
    const r4 = await run(M0, []); assert.equal(r4.code, 2);
  });
});
test('A5 no admin subcommand is matched by the autonomous allow rule', () => {
  const signer = '/home/op/.r3-signer-bin/signer.cjs';
  const rules = ['send', 'simulate', 'check'].flatMap((c) => [`Bash(node ${signer} ${c} *)`, `PowerShell(node ${signer} ${c} *)`]);
  const matches = (rule, cmd) => { const m = /^(?:Bash|PowerShell)\((.*) \*\)$/.exec(rule); return cmd.startsWith(m[1] + ' '); };
  for (const admin of ['reconcile', 'clear-nonce 7', 'sweep-token 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 'sweep-eth --amount 1', 'allowlist-init --skill-dir x', 'info']) {
    assert.ok(!rules.some((r) => matches(r, `node ${signer} ${admin}`)), `${admin} must not be matched`);
  }
  for (const ok of ['send f.json --nonce 3', 'simulate f.json', 'check f.json']) assert.ok(rules.some((r) => matches(r, `node ${signer} ${ok}`)));
});
test('A6 environment tripwire: fires on allowlist-switch names, silent on the real Bash, PowerShell and test environments', () => {
  for (const k of ['SIGNER_ALLOWLIST', 'ALLOWLIST_DISABLED', 'R3_SIGNER_UNRESTRICTED', 'UNSAFE_NO_POLICY', 'BYPASS_ALLOWLIST', 'SKIP_POLICY_CHECK']) {
    assert.equal(S.findModeSwitchEnv({ [k]: '1' }), k, `${k} should trip`);
  }
  // R3_DATA_HOST is a parameter the skill itself names; SIGNER_* is an operator's own naming. Neither claims to switch anything off.
  const benign = ['PATH', 'Path', 'PSModulePath', 'PSExecutionPolicyPreference', 'ALLUSERSPROFILE', 'CLAUDECODE', 'DISABLE_AUTOUPDATER', 'FORCE_COLOR', 'NO_COLOR', 'NODE_OPTIONS', 'NODE_PATH', 'TEMP', 'COMSPEC', 'SESSIONNAME', 'R3_DATA_HOST', 'SIGNER_ADDRESS', 'SIGNER'];
  for (const k of benign) assert.equal(S.findModeSwitchEnv({ [k]: 'x' }), null, `${k} must not trip`);
  assert.equal(S.findModeSwitchEnv(process.env), null, 'this test runner\'s own environment must not trip');
  let checked = 0;
  if (process.platform === 'win32') {
    const r = cp.spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '[Environment]::GetEnvironmentVariables().Keys -join "`n"'], { encoding: 'utf8' });
    if (r.status === 0) { const names = r.stdout.split(/\r?\n/).filter(Boolean); assert.ok(names.length > 5); assert.equal(S.findModeSwitchEnv(Object.fromEntries(names.map((n) => [n, '']))), null, 'PowerShell child environment must not trip'); checked++; }
  }
  const b = cp.spawnSync('bash', ['-c', 'env'], { encoding: 'utf8' });
  if (b.status === 0) { const names = b.stdout.split(/\r?\n/).map((l) => l.split('=')[0]).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)); assert.equal(S.findModeSwitchEnv(Object.fromEntries(names.map((n) => [n, '']))), null, 'bash environment must not trip'); checked++; }
  if (checked === 0) skip('neither powershell nor bash is available here; unit names and process.env were checked');
});
test('A7 unlock backends keychain and secret-service use the expected commands (STUBBED process runner; not exercised on this OS)', () => {
  const calls = [];
  const stub = (out, status = 0) => ({ spawnSync: (cmd, args) => { calls.push([cmd, args]); return { status, stdout: out }; } });
  const base = { signerMode: 'keychain', unlockService: 'svc', unlockAccount: 'acct' };
  assert.equal(S.readUnlockPassword(base, stub('pw\n')), 'pw');
  assert.deepEqual(calls[0], ['security', ['find-generic-password', '-s', 'svc', '-a', 'acct', '-w']]);
  assert.equal(S.readUnlockPassword({ signerMode: 'secret-service', unlockService: 'svc' }, stub('pw2\n')), 'pw2');
  assert.deepEqual(calls[1], ['secret-tool', ['lookup', 'service', 'svc']]);
  assert.throws(() => S.readUnlockPassword(base, stub('', 1)), (e) => e.code === 'unlock' && !/pw/.test(e.detail));
});

test('A8 signer.config.example.json: every key is one the signer knows, underscore keys are ignored, and it loads once its placeholders are filled', async () => {
  const ex = JSON.parse(fs.readFileSync(path.join(__dirname, 'signer.config.example.json'), 'utf8'));
  const real = Object.keys(ex).filter((k) => !k.startsWith('_'));
  for (const k of real) assert.ok(S.CONFIG_KEYS.includes(k), 'unknown key in the example: ' + k);
  for (const k of ['chainId', 'rpcUrl', 'signerAddress', 'owner', 'projectRoot', 'keystorePath', 'signerMode', 'allowlistPath', 'allowlistSha256', 'sendLockPath', 'logPath']) assert.ok(real.includes(k), 'the example lacks ' + k);
  assert.ok(!/0xb5b2|0x7fB4F3/i.test(JSON.stringify(ex)), 'no real address in the example');
  assert.equal(ex.chainId, 10);
  const under = Object.fromEntries(Object.entries(ex).filter(([k]) => k.startsWith('_')));
  const inst = makeInstall('example-config', under); inst.setAllowlist(JSON.stringify(POL, null, 2));
  const r = await run(inst, ['check', input(okCall())]);
  assert.equal(r.stdout, '{"allowed":true}\n', r.stdout + r.stderr);
});

// =========================================================================================================
// B. I.1 section 7 self-test cases, through the policy-only `check` entry point
// =========================================================================================================
test('B1 check ACCEPTS allowlisted calls (approve exact, split, merge, redeem, swaps in both functions, PSM3)', async () => {
  await withFreshState(M0, async () => {
    const goods = [
      approve(S.PINNED.susds, S.PINNED.router, 1n), approve(S.PINNED.usdc, S.PINNED.psm3, 0n), approve(C()[0].repo_token, S.PINNED.swapRouter02, 5n),
      approve(POL.middles[0].invalid, S.PINNED.router, 1n), approve(S.PINNED_TREE.parentInvalid, S.PINNED.router, 1n),
      split(S.PINNED_TREE.parent, 10n ** 40n), split(POL.middles[1].market, 3n), merge(C()[4].market, 2n), redeem(C()[4].market, [0n, 1n, 2n], [1n, 2n, 3n]),
      goodSwapIn(), swapOut({ tokenIn: C()[0].repo_token, tokenOut: C()[0].down, fee: 100, recipient: W.address }),
      swapIn({ tokenIn: C()[1].up, tokenOut: C()[1].repo_token, fee: 500, recipient: W.address }), // the pair pinned at tier 500
      psm('swapExactIn', S.PINNED.usdc, S.PINNED.susds, W.address), psm('swapExactIn', S.PINNED.susds, S.PINNED.usds, W.address),
    ];
    for (const g of goods) {
      const r = await checkOf(M0, [g]);
      assert.equal(r.stdout, '{"allowed":true}\n', `${g.data.slice(0, 10)} to ${g.to}: ${r.stdout}`);
      assert.equal(r.code, 0);
    }
    assert.equal(mock.requests.length, 0, 'check made network calls');
    const rr = await checkOf(M0, goods.slice(0, 4)); assert.equal(rr.stdout, '{"allowed":true}\n');
    const one = await run(M0, ['check', input([approve(S.PINNED.susds, S.PINNED.router, 1n)], 'ok-approve.json')]); note('check, an allowlisted call', ['check', 'run/ok-approve.json'], one);
  });
});
const REFUSALS = [
  ['B2a a token transfer to another address', () => [{ to: S.PINNED.susds, data: S.IF.erc20.encodeFunctionData('transfer', [BURN, 1n]) }], 'token-transfer'],
  ['B2b transferFrom is refused too', () => [{ to: S.PINNED.usdc, data: S.IF.erc20.encodeFunctionData('transferFrom', [W.address, BURN, 1n]) }], 'token-transfer'],
  ['B2c a call to a contract that is not listed', () => [{ to: '0x4200000000000000000000000000000000000006', data: '0xd0e30db0' }], 'contract'],
  ['B2d an unlisted selector on the Router', () => [{ to: S.PINNED.router, data: '0xdeadbeef' }], 'selector'],
  ['B2e ConditionalTokens is never called directly', () => [{ to: S.PINNED.ctf, data: '0x00000000' }], 'ctf-direct'],
  ['B3a exactInputSingle with recipient != holder', () => [swapIn({ tokenIn: C()[0].up, tokenOut: C()[0].repo_token, fee: 100, recipient: BURN })], 'recipient'],
  ['B3b exactOutputSingle with recipient != holder', () => [swapOut({ tokenIn: C()[0].repo_token, tokenOut: C()[0].up, fee: 100, recipient: BURN })], 'recipient'],
  ['B3c PSM3 swapExactIn with receiver != holder', () => [psm('swapExactIn', S.PINNED.usdc, S.PINNED.susds, BURN)], 'receiver'],
  ['B4 a max approval (type(uint256).max)', () => [approve(S.PINNED.susds, S.PINNED.router, (1n << 256n) - 1n)], 'approval-amount'],
  ['B5a an approval to an unlisted spender', () => [approve(S.PINNED.susds, BURN, 0n)], 'approval-spender'],
  ['B5b a middle Invalid approved to anything but the Router', () => [approve(POL.middles[0].invalid, S.PINNED.swapRouter02, 1n)], 'approval-spender'],
  ['B6a exactInputSingle at a fee tier other than the pinned one', () => [swapIn({ tokenIn: C()[0].up, tokenOut: C()[0].repo_token, fee: 500, recipient: W.address })], 'swap-fee-tier'],
  ['B6b exactOutputSingle at a fee tier other than the pinned one', () => [swapOut({ tokenIn: C()[1].repo_token, tokenOut: C()[1].up, fee: 100, recipient: W.address })], 'swap-fee-tier'],
  ['B7a exactInputSingle on the wrong pair (UP of child 0 with the repo token of child 1)', () => [swapIn({ tokenIn: C()[0].up, tokenOut: C()[1].repo_token, fee: 100, recipient: W.address })], 'swap-pair'],
  ['B7b exactOutputSingle on the wrong pair', () => [swapOut({ tokenIn: C()[1].repo_token, tokenOut: C()[0].down, fee: 100, recipient: W.address })], 'swap-pair'],
  ['B7c a child-Invalid leg is never swapped', () => [swapIn({ tokenIn: C()[0].invalid, tokenOut: C()[0].repo_token, fee: 100, recipient: W.address })], 'swap-pair'],
  ['B7d an UP leg against sUSDS is not a pair', () => [swapIn({ tokenIn: C()[0].up, tokenOut: S.PINNED.susds, fee: 100, recipient: W.address })], 'swap-pair'],
  ['B8a a PSM3 pair other than USDC/USDS <-> sUSDS', () => [psm('swapExactIn', S.PINNED.usdc, S.PINNED.usds, W.address)], 'psm3-pair'],
  ['B8b PSM3 swapExactOut is not allowlisted (G does not use it)', () => [psm('swapExactOut', S.PINNED.usdc, S.PINNED.susds, W.address)], 'selector'],
  ['B9a a Router call on an unlisted market', () => [split('0x1111111111111111111111111111111111111111', 1n)], 'router-market'],
  ['B9b a Router call with a collateral other than sUSDS', () => [split(C()[0].market, 1n, S.PINNED.usdc)], 'router-collateral'],
  ['B9c redeem with a slot outside the market', () => [redeem(C()[0].market, [3n], [1n])], 'router-args'],
  ['B10 value > 0', () => [{ ...approve(S.PINNED.susds, S.PINNED.router, 1n), value: '1' }], 'native-value'],
  ['B11 an unlisted selector on a listed token', () => [{ to: S.PINNED.susds, data: '0x39509351' + '00'.repeat(64) }], 'selector'],
  ['B12 EIP-712 typed-data permit', () => ({ domain: { name: 'USDC', chainId: 10, verifyingContract: S.PINNED.usdc }, types: { Permit: [{ name: 'owner', type: 'address' }] }, primaryType: 'Permit', message: { owner: W.address } }), 'eip712'],
  ['B13 EIP-7702 authorization naming the burn address', () => ({ chainId: 10, address: BURN, nonce: 0 }), 'eip7702'],
  ['B13b an EIP-7702 authorizationList / SetCode transaction', () => ({ type: 4, authorizationList: [{ chainId: 10, address: BURN, nonce: 0 }], calls: [] }), 'eip7702'],
  ['B13c personal_sign', () => ({ method: 'personal_sign', params: ['0x00', W.address] }), 'off-chain-signature'],
  ['B14 a batch with one bad inner call (index reported)', () => [approve(S.PINNED.susds, S.PINNED.router, 1n), split(C()[0].market, 1n), approve(S.PINNED.susds, BURN, 1n)], 'approval-spender', 2],
  ['B15 calldata that is not the canonical encoding (trailing bytes)', () => [{ ...approve(S.PINNED.susds, S.PINNED.router, 1n), data: approve(S.PINNED.susds, S.PINNED.router, 1n).data + '00' }], 'malformed-calldata'],
  ['B16 an empty call list', () => [], 'input-shape'],
  ['B17 an unknown key on a call', () => [{ ...approve(S.PINNED.susds, S.PINNED.router, 1n), gasPrice: '1' }], 'input-shape'],
];
for (const [name, build, rule, index] of REFUSALS) {
  test(`${name}: distinct allowlist refusal "${rule}" before any RPC call`, async () => {
    await withFreshState(M0, async () => {
      const args = ['check', input(build())];
      const r = await run(M0, args);
      expectRefusal(r, rule, { index });
      if (rule === 'approval-amount') note('check, a max approval', ['check', 'run/max-approval.json'], r);
      if (rule === 'eip712') note('check, an EIP-712 permit', ['check', 'run/permit.json'], r);
      if (name.startsWith('B13 ')) note('check, an EIP-7702 authorization', ['check', 'run/authorization.json'], r);
      if (rule === 'swap-fee-tier' && name.startsWith('B6a')) note('check, wrong fee tier', ['check', 'run/wrong-fee.json'], r);
    });
  });
}
test('B18 check in-process tripwire: never reads the keystore or unlock file, never opens the network, never decrypts', async () => {
  const inst = makeInstall('tripwire');
  inst.setAllowlist(JSON.stringify(POL, null, 2));
  const mod = require(inst.bin);
  const seen = []; const origRead = fs.readFileSync; const origFetch = globalThis.fetch; const origDecrypt = Wallet.fromEncryptedJson;
  fs.readFileSync = function (p, ...rest) { seen.push(String(p)); return origRead.call(this, p, ...rest); };
  let net = 0; globalThis.fetch = () => { net++; throw new Error('network is off limits for check'); };
  let dec = 0; Wallet.fromEncryptedJson = () => { dec++; throw new Error('decrypt is off limits for check'); };
  try {
    mod.offlinePipeline('check', [input([goodSwapIn()])], {});
    for (const bad of [[approve(S.PINNED.susds, BURN, 0n)]]) assert.throws(() => mod.offlinePipeline('check', [input(bad)], {}), (e) => e.rule === 'approval-spender');
  } finally { fs.readFileSync = origRead; globalThis.fetch = origFetch; Wallet.fromEncryptedJson = origDecrypt; }
  assert.equal(net, 0); assert.equal(dec, 0);
  assert.ok(!seen.some((p) => [W.keystore, W.unlock].some((k) => path.resolve(p) === path.resolve(k))), 'check read a key file: ' + seen.join(' | '));
});

// =========================================================================================================
// C. mode-switch attempts via `send` (the one self-test case that goes through send), chain id, hash pin
// =========================================================================================================
const okCall = () => [approve(S.PINNED.susds, S.PINNED.router, 1n)];
test('C1 the spec\'s final case: zero-amount approve with the burn spender through send is refused before signing', async () => {
  await withFreshState(M0, async () => {
    const f = input([approve(S.PINNED.susds, BURN, 0n)], 'burn-approve.json');
    const r = await run(M0, ['send', f]);
    expectRefusal(r, 'approval-spender');
    assert.ok(!fs.existsSync(M0.cfg.sendLockPath), 'no lock may be taken for a refusal');
    assert.ok(!r.json.some((j) => j.event === 'broadcast'));
    note('send, the mode-switch self-test case (burn spender)', ['send', 'run/burn-approve.json'], r);
  });
});
for (const [name, extra] of [
  ['an extra positional argument', ['allowlist=off']], ['--no-allowlist', ['--no-allowlist']], ['--allowlist=off', ['--allowlist=off']],
  ['--allowlist off', ['--allowlist', 'off']], ['--unrestricted', ['--unrestricted']], ['--force', ['--force']], ['--broadcast (the bundled CLI\'s flag)', ['--broadcast']],
  ['--config <file>', ['--config', 'x.json']], ['--rpc <url>', ['--rpc', 'http://127.0.0.1:1']], ['--nonce next to a mode flag', ['--nonce', '7', '--admin']],
]) {
  test(`C2 mode-switch by argument/flag, send of an ALLOWLISTED call: ${name} -> refusal "mode-switch"`, async () => {
    await withFreshState(M0, async () => {
      const r = await run(M0, ['send', input(okCall()), ...extra]);
      expectRefusal(r, 'mode-switch');
      assert.ok(!fs.existsSync(M0.cfg.sendLockPath));
      if (name === '--no-allowlist') note('send, a flag that claims to lift the allowlist', ['send', 'run/in.json', '--no-allowlist'], r);
    });
  });
}
for (const name of ['SIGNER_ALLOWLIST', 'ALLOWLIST_DISABLED', 'R3_SIGNER_UNRESTRICTED', 'UNSAFE_NO_POLICY']) {
  test(`C3 mode-switch by environment variable ${name}=off on an ALLOWLISTED call -> refusal "mode-switch"`, async () => {
    await withFreshState(M0, async () => {
      const r = await run(M0, ['send', input(okCall())], { env: { [name]: 'off' } });
      expectRefusal(r, 'mode-switch');
      assert.ok(!fs.existsSync(M0.cfg.sendLockPath));
      if (name === 'SIGNER_ALLOWLIST') note('send, an environment variable that claims to lift the allowlist', ['send', 'run/in.json'], r);
    });
  });
}
test('C3b the same environment variable is refused by check and simulate too', async () => {
  await withFreshState(M0, async () => {
    expectRefusal(await run(M0, ['check', input(okCall())], { env: { SIGNER_ALLOWLIST: 'off' } }), 'mode-switch');
    expectRefusal(await run(M0, ['simulate', input(okCall())], { env: { SIGNER_ALLOWLIST: 'off' } }), 'mode-switch');
  });
});
for (const [name, key, val] of [['allowlist', 'allowlist', 'off'], ['mode', 'mode', 'supervised'], ['unrestricted', 'unrestricted', true], ['policy', 'policy', null]]) {
  test(`C4 mode-switch by a key inside the input file ("${name}") on an ALLOWLISTED call -> refusal "mode-switch"`, async () => {
    await withFreshState(M0, async () => {
      const r = await run(M0, ['send', input({ calls: okCall(), [key]: val })]);
      expectRefusal(r, 'mode-switch');
    });
  });
}
test('C5 an agent-writable file that claims to turn the allowlist off is ignored: the burn-spender approve is still refused, zero raw transactions', async () => {
  await withFreshState(M0, async () => {
    for (const f of ['allowlist-off.json', 'signer-mode.json', '.env', 'signer.override.json']) input({ allowlist: 'off', mode: 'unrestricted', ALLOWLIST: 'off' }, f);
    fs.writeFileSync(path.join(W.project, 'allowlist-off'), 'off'); fs.writeFileSync(path.join(W.project, '.env'), 'SIGNER_ALLOWLIST=off\n');
    // a look-alike config and allowlist in the working directory and next to the input: the signer reads its config only from next to itself
    const fake = JSON.stringify({ allowlistPath: path.join(W.project, 'allowlist.json'), allowlistSha256: ZERO64, rpcUrl: 'http://127.0.0.1:1', mode: 'unrestricted' });
    for (const d of [W.project, path.join(W.project, 'run')]) { fs.writeFileSync(path.join(d, 'signer.config.json'), fake); fs.writeFileSync(path.join(d, 'allowlist.json'), JSON.stringify({ allow: 'everything' })); }
    const r = await run(M0, ['send', input([approve(S.PINNED.susds, BURN, 0n)])]);
    expectRefusal(r, 'approval-spender');
    assert.equal(mock.raws.length, 0);
  });
});
// The skill's literal last self-test case: a mode-switch attempt on a ZERO-AMOUNT approve with the BURN ADDRESS as
// spender, through `send`. C2-C4 above prove the mode-switch refusal on an allowlisted call; these prove the literal case.
test('C5b the literal self-test case: send of a zero-amount burn-spender approve with a mode-switch by argument, flag, environment variable, input key and writable file', async () => {
  const burnApprove = () => [approve(S.PINNED.susds, BURN, 0n)];
  const attempts = [
    ['an extra argument', () => run(M0, ['send', input(burnApprove()), 'allowlist=off'])],
    ['a flag', () => run(M0, ['send', input(burnApprove()), '--no-allowlist'])],
    ['a flag with a value', () => run(M0, ['send', input(burnApprove()), '--allowlist', 'off'])],
    ['an environment variable', () => run(M0, ['send', input(burnApprove())], { env: { SIGNER_ALLOWLIST: 'off' } })],
    ['a key in the input file', () => run(M0, ['send', input({ calls: burnApprove(), allowlist: 'off' })])],
    ['an agent-writable file next to the input', () => { input({ allowlist: 'off' }, 'allowlist-off.json'); fs.writeFileSync(path.join(W.project, 'run', 'allowlist-off'), 'off'); return run(M0, ['send', input(burnApprove())]); }],
  ];
  for (const [label, go] of attempts) {
    await withFreshState(M0, async () => {
      const r = await go();
      assert.equal(r.code, 3, `${label}: ${r.stdout}`); assert.equal(r.last.refused, 'allowlist', `${label}: ${r.stdout}`);
      assert.ok(['mode-switch', 'approval-spender'].includes(r.last.rule), `${label}: rule ${r.last.rule}`);
      assert.equal(mock.requests.length, 0, `${label}: refusal must precede any RPC call`); assert.equal(mock.raws.length, 0);
      assert.ok(!fs.existsSync(M0.cfg.sendLockPath), `${label}: no lock for a refusal`); assert.ok(!r.json.some((j) => j.event === 'broadcast' || j.hash));
    });
  }
});
test('C5c node itself told to load code first: NODE_OPTIONS (--require, -r, --import) and node flags are refused with the allowlist refusal; TLS verification off too', async () => {
  const pre = path.join(W.project, 'run', 'preload.cjs'); const marker = path.join(W.project, 'run', 'preload-ran.txt');
  fs.writeFileSync(pre, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`);
  const fwd = pre.replace(/\\/g, '/');
  const variants = [
    ['NODE_OPTIONS=--require=<file>', { env: { NODE_OPTIONS: `--require=${fwd}` } }], ['NODE_OPTIONS=-r <file>', { env: { NODE_OPTIONS: `-r ${fwd}` } }],
    ['NODE_OPTIONS=--import=<url>', { env: { NODE_OPTIONS: `--import=${require('node:url').pathToFileURL(pre).href}` } }], ['node --require <file>', { nodeArgs: ['--require', pre] }],
    ['NODE_TLS_REJECT_UNAUTHORIZED=0', { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } }],
  ];
  for (const [label, opts] of variants) {
    for (const cmd of ['send', 'check', 'simulate']) {
      await withFreshState(M0, async () => {
        const r = await run(M0, [cmd, input(okCall())], opts);
        assert.equal(r.code, 3, `${label} ${cmd}: ${r.stdout}${r.stderr}`); assert.equal(r.last.refused, 'allowlist'); assert.equal(r.last.rule, 'mode-switch', `${label} ${cmd}`);
        assert.equal(mock.requests.length, 0); assert.equal(mock.raws.length, 0); assert.ok(!fs.existsSync(M0.cfg.sendLockPath));
      });
    }
  }
  assert.ok(fs.existsSync(marker), 'the preload did run before the signer started: an in-process guard is advisory against a preload, which is what the README says');
  // a supervised signing entry point refuses too (as a plain error: it is not an allowlist matter)
  await withFreshState(M0, async () => {
    const r = await run(M0, ['sweep-eth', '--amount', '1'], { env: { NODE_OPTIONS: `--require=${fwd}` } });
    assert.equal(r.code, 2); assert.equal(r.last.error, 'runtime-override'); assert.equal(mock.raws.length, 0);
  });
  // benign node options are not refused
  await withFreshState(M0, async () => { const r = await run(M0, ['check', input(okCall())], { env: { NODE_OPTIONS: '--max-old-space-size=512 --no-warnings' } }); assert.equal(r.stdout, '{"allowed":true}\n'); });
});
test('C5d an ethers library that resolves inside the project folder is refused (a tampered decoder could make a bad call read as allowlisted)', async () => {
  const inst = makeInstall('ethers-in-project', { projectRoot: path.dirname(nodeModulesDir()) }); inst.setAllowlist(JSON.stringify(POL, null, 2));
  mock.reset();
  const r = await run(inst, ['check', input(okCall())]);
  assert.equal(r.code, 3); assert.equal(r.last.rule, 'mode-switch'); assert.match(r.last.detail, /ethers library resolves to a path inside the project folder/); assert.equal(mock.requests.length, 0);
});
test('C6 wrong chain id in the input is refused before any RPC call (number, decimal string, hex string)', async () => {
  await withFreshState(M0, async () => {
    for (const cid of [1, '1', '0x1', 8453, 0]) {
      mock.reset();
      const r = await run(M0, ['send', input({ chainId: cid, calls: okCall() })]);
      expectRefusal(r, 'chain-id');
    }
    const ok = await run(M0, ['check', input({ chainId: 10, calls: okCall() })]); assert.equal(ok.stdout, '{"allowed":true}\n');
  });
});
test('C7 wrong chain id on the RPC side: refused before any signature, lock released, no hash emitted', async () => {
  await withFreshState(M0, async () => {
    mock.chainId = 1n;
    const r = await run(M0, ['send', input(okCall())]);
    assert.equal(r.code, 3); assert.equal(r.last.refused, 'allowlist'); assert.equal(r.last.rule, 'chain-id');
    assert.equal(mock.raws.length, 0); assert.ok(!r.json.some((j) => j.event === 'broadcast')); assert.ok(!fs.existsSync(M0.cfg.sendLockPath));
    mock.reset(); mock.chainId = 1n;
    const s = await run(M0, ['simulate', input(okCall())]); assert.equal(s.code, 3); assert.equal(s.last.rule, 'chain-id');
  });
});
test('C8 a config that names another chain is a config error, not a signer for that chain', async () => {
  const inst = makeInstall('badchain', { chainId: 8453 }); inst.setAllowlist(JSON.stringify(POL, null, 2));
  const r = await run(inst, ['check', input(okCall())]);
  assert.equal(r.code, 2); assert.equal(r.last.error, 'config');
});
test('C9 allowlist hash mismatch: refusal for check, simulate and send, before any RPC call', async () => {
  await withFreshState(M0, async () => {
    const text = fs.readFileSync(M0.cfg.allowlistPath, 'utf8');
    try {
      fs.writeFileSync(M0.cfg.allowlistPath, text + ' '); // a change the agent could make with Write
      for (const cmd of ['check', 'simulate', 'send']) { mock.reset(); expectRefusal(await run(M0, [cmd, input(okCall())]), 'allowlist-hash-mismatch'); }
      const tampered = JSON.parse(text); tampered.children[0].fee_up = 3000; fs.writeFileSync(M0.cfg.allowlistPath, JSON.stringify(tampered, null, 2));
      mock.reset(); const r = await run(M0, ['send', input(okCall())]); expectRefusal(r, 'allowlist-hash-mismatch');
      note('send, allowlist hash mismatch', ['send', 'run/in.json'], r);
      fs.unlinkSync(M0.cfg.allowlistPath); mock.reset();
      expectRefusal(await run(M0, ['check', input(okCall())]), 'allowlist-missing');
    } finally { fs.writeFileSync(M0.cfg.allowlistPath, text); }
    assert.equal((await run(M0, ['check', input(okCall())])).stdout, '{"allowed":true}\n');
  });
});
test('C10 a pinned allowlist that disagrees with the addresses pinned in the signer is a config error, never a silent accept', async () => {
  const inst = makeInstall('wrongrouter'); const bad = JSON.parse(JSON.stringify(POL)); bad.contracts.router = getAddress(BURN); inst.setAllowlist(JSON.stringify(bad, null, 2));
  const r = await run(inst, ['check', input(okCall())]); assert.equal(r.code, 2); assert.equal(r.last.error, 'allowlist-invalid');
  const inst2 = makeInstall('otherholder'); const bad2 = JSON.parse(JSON.stringify(POL)); bad2.holder = getAddress(BURN); inst2.setAllowlist(JSON.stringify(bad2, null, 2));
  const r2 = await run(inst2, ['check', input(okCall())]); assert.equal(r2.code, 2); assert.equal(r2.last.error, 'allowlist-invalid');
});
test('C11 the signer, the allowlist and the lock must live outside the project folder', async () => {
  const insideAllow = makeInstall('insideallow', { allowlistPath: path.join(W.project, 'run', 'allowlist.json') }); insideAllow.writeConfig();
  const r1 = await run(insideAllow, ['check', input(okCall())]); assert.equal(r1.code, 2); assert.match(r1.last.detail, /inside the project folder/);
  const inProject = makeInstall('signer-in-project', {}, W.project); inProject.setAllowlist(JSON.stringify(POL, null, 2));
  const r2 = await run(inProject, ['check', input(okCall())]); assert.equal(r2.code, 2); assert.match(r2.last.detail, /inside the project folder/);
});
test('C12 an unexpected exception is an ERROR, never an allowlist refusal (a crashing signer must not pass the self-test)', async () => {
  await withFreshState(M0, async () => {
    // a runner that breaks the ABI decoder in-process (NOT a --require preload: the signer refuses those), then drives the signer's own main() and report()
    const crash = path.join(ROOT, 'crash-runner.cjs');
    fs.writeFileSync(crash, `const { Interface } = require(${JSON.stringify(path.join(nodeModulesDir(), 'ethers'))}); Interface.prototype.decodeFunctionData = function () { throw new TypeError('boom ' + 'SECRET-LOOKING-VALUE'); };\n`
      + 'const m = require(process.argv[2]); (async () => { let code; try { code = await m.main(process.argv.slice(3), process.env); } catch (e) { code = m.report(e); } process.exit(code); })();\n');
    const r = await run(M0, ['check', input(okCall())], { entry: crash });
    assert.equal(r.code, 1); assert.equal(r.last.error, 'internal'); assert.equal(r.last.refused, undefined);
    assert.ok(!/SECRET-LOOKING-VALUE|boom/.test(r.stdout + r.stderr), 'the exception message must not be printed');
  });
});
test('C13 the signer never reads its input from a protected file and never echoes input content', async () => {
  await withFreshState(M0, async () => {
    const r = await run(M0, ['check', W.keystore]); assert.equal(r.code, 2); assert.equal(r.last.error, 'input-path');
    const junk = input('{"a": "TOP-SECRET-CONTENT-123"', 'junk.json'); const j = await run(M0, ['check', junk]);
    assert.equal(j.code, 3); assert.ok(!/TOP-SECRET-CONTENT/.test(j.stdout + j.stderr));
    const k = await run(M0, ['check', input({ calls: okCall(), 'TOP-SECRET-KEY': 1 })]); assert.ok(!/TOP-SECRET-CONTENT/.test(k.stdout));
  });
});

// =========================================================================================================
// D. simulate
// =========================================================================================================
test('D1 simulate: policy first, then eth_simulateV1; reports the pending nonce; never broadcasts', async () => {
  await withFreshState(M0, async () => {
    const r = await run(M0, ['simulate', input([goodSwapIn()], 'sim-ok.json')]);
    assert.equal(r.code, 0, r.stdout); assert.equal(r.last.simulated, true); assert.equal(r.last.ok, true); assert.equal(r.last.broadcast, false);
    assert.equal(r.last.nonce, 7); assert.equal(r.last.from, W.address); assert.equal(r.last.via, 'eth_simulateV1'); assert.equal(r.last.results[0].status, '0x1');
    const m = mock.requests.find((q) => q.method === 'eth_simulateV1'); assert.ok(m, 'eth_simulateV1 was not called');
    assert.equal(m.params[0].blockStateCalls[0].calls[0].from, W.address);
    assert.equal(mock.raws.length, 0); assert.ok(!mock.requests.some((q) => /sendRaw|sign/i.test(q.method)));
    note('simulate, an allowlisted call', ['simulate', 'run/sim-ok.json'], r);
  });
});
test('D2 simulate refuses off-allowlist calls before any RPC call', async () => {
  await withFreshState(M0, async () => { expectRefusal(await run(M0, ['simulate', input([approve(S.PINNED.susds, BURN, 0n)])]), 'approval-spender'); });
});
test('D3 simulate exits non-zero on a revert ("MUST throw on revert")', async () => {
  await withFreshState(M0, async () => {
    mock.simStatus = '0x0';
    const r = await run(M0, ['simulate', input([goodSwapIn()])]); assert.equal(r.code, 1); assert.equal(r.last.ok, false); assert.equal(r.last.results[0].status, '0x0');
  });
});
test('D4 simulate falls back to eth_call when eth_simulateV1 is unsupported', async () => {
  await withFreshState(M0, async () => {
    mock.simulateSupported = false;
    const r = await run(M0, ['simulate', input([goodSwapIn()])]); assert.equal(r.code, 0); assert.equal(r.last.via, 'eth_call');
  });
});

// =========================================================================================================
// E. send: positive cases against the mock RPC
// =========================================================================================================
async function sendAndWatch(call, { args = [], expectNonce, mockSetup } = {}) {
  mock.reset(); resetFs(M0); if (mockSetup) mockSetup();
  const f = input([call]);
  const seen = {};
  const res = await run(M0, ['send', f, ...args], {
    onLine: (rec) => {
      if (rec.json && rec.json.event === 'broadcast') {
        seen.broadcastAt = rec.t; seen.lockExistsAtBroadcast = fs.existsSync(M0.cfg.sendLockPath);
        try { seen.lock = JSON.parse(fs.readFileSync(M0.cfg.sendLockPath, 'utf8')); } catch { seen.lock = null; }
        seen.rawsAtBroadcast = mock.raws.length;
      }
    },
  });
  return { res, seen, file: f };
}
function verifySend({ res, seen }, call, nonce) {
  assert.equal(res.code, 0, `exit ${res.code}: ${res.stdout} ${res.stderr}`);
  assert.deepEqual(res.json.map((j) => j.event), ['lock', 'broadcast', 'confirmed'], res.stdout);
  const [lock, bc, done] = res.json;
  assert.equal(lock.lock_path, M0.cfg.sendLockPath, 'the lock path is declared');
  assert.equal(mock.raws.length, 1, 'exactly one transaction is broadcast');
  const raw = mock.raws[0]; const tx = parseRaw(raw);
  // the raw transaction recovers to the throwaway address, on chain 10, at the pinned/expected nonce, to the checked call
  assert.equal(tx.from, W.address); assert.equal(recoverAddress(tx.unsignedHash, tx.signature), W.address);
  assert.equal(tx.chainId, 10n); assert.equal(tx.type, 2); assert.equal(tx.value, 0n);
  assert.equal(lc(tx.to), lc(call.to)); assert.equal(lc(tx.data), lc(call.data)); assert.equal(tx.nonce, nonce);
  // hash and nonce are emitted AT BROADCAST, before the receipt, with input_hash next to the hash
  assert.equal(bc.hash, tx.hash); assert.equal(bc.nonce, nonce); assert.equal(bc.input_hash, keccak256(call.data)); assert.equal(bc.input_hash, keccak256(tx.data));
  assert.equal(done.hash, tx.hash); assert.equal(done.nonce, nonce); assert.equal(done.input_hash, bc.input_hash); assert.equal(done.lock_released, true);
  assert.ok(mock.firstReceiptServedAt !== null && seen.broadcastAt < mock.firstReceiptServedAt, `broadcast line (${seen.broadcastAt}) must precede the first receipt (${mock.firstReceiptServedAt})`);
  // send-lock: held while the transaction was in flight, carrying the hash and nonce, and gone after the terminal receipt
  assert.equal(seen.lockExistsAtBroadcast, true); assert.equal(seen.lock.hash, tx.hash); assert.equal(seen.lock.nonce, nonce); assert.equal(seen.lock.input_hash, bc.input_hash);
  assert.ok(!fs.existsSync(M0.cfg.sendLockPath), 'the lock is released after the receipt');
  // log: intent before the send, accepted after, confirmed last
  const log = fs.readFileSync(M0.cfg.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => l.event), ['broadcast-intent', 'broadcast-accepted', 'confirmed']);
  assert.equal(log[0].hash, tx.hash); assert.equal(log[0].nonce, nonce);
  // causal, not clock-based (the signer and the mock are two processes): the intent line is already in the log when the raw transaction reaches the mock
  assert.ok(mock.rawEvents[0].log.split(/\r?\n/).some((l) => l.includes('"broadcast-intent"') && l.toLowerCase().includes(tx.hash.toLowerCase())), 'broadcast-intent is logged before eth_sendRawTransaction');
  // signed bytes are never printed
  for (const text of [res.stdout, res.stderr, fs.readFileSync(M0.cfg.logPath, 'utf8')]) assert.ok(!text.toLowerCase().includes(raw.toLowerCase().slice(2, 60)), 'signed transaction bytes leaked');
  return tx;
}
const POSITIVE = [
  ['E1 a Seer split (parent, mint)', () => split(S.PINNED_TREE.parent, 123456789012345678901n)],
  ['E2 a swap (UP -> repo token, pinned tier, recipient = holder)', () => goodSwapIn()],
  ['E3 an exact approve', () => approve(S.PINNED.susds, S.PINNED.router, 987654321n)],
  ['E4 a merge (child level)', () => merge(C()[4].market, 5n)],
  ['E5 a redeem (child, all three legs)', () => redeem(C()[4].market, [0n, 1n, 2n], [1n, 2n, 3n])],
];
for (const [name, build] of POSITIVE) {
  test(`${name}: signs, broadcasts once to the mock, hash before receipt, nonce, lock, input_hash, recovery to the throwaway address`, async () => {
    const call = build();
    const out = await sendAndWatch(call);
    verifySend(out, call, 7);
    if (name.startsWith('E2')) note('send, an allowlisted swap (account nonce 7)', ['send', 'run/in.json'], out.res);
    // the same call with the nonce pinned by the caller: signed at exactly that nonce (pending nonce 7 here)
    const pinned = await sendAndWatch(call, { args: ['--nonce', '7'] });
    verifySend(pinned, call, 7);
    assert.equal(pinned.res.json[1].nonce, 7, 'the pinned nonce is emitted at broadcast');
  });
}
test('E6 --nonce <n> signs at exactly that nonce (account nonce 7 pending, pinned 7)', async () => {
  const call = approve(S.PINNED.susds, S.PINNED.router, 5n);
  const out = await sendAndWatch(call, { args: ['--nonce', '7'] }); verifySend(out, call, 7);
  const out2 = await sendAndWatch(call, { args: ['--nonce=6'], mockSetup: () => { mock.latest = 6; mock.pending = 7; } }); verifySend(out2, call, 6);
});
test('E7 a pinned nonce that is already used: nonce-too-low, NO signature, NO hash, NO intent, no lock left behind (the setup nonce test)', async () => {
  await withFreshState(M0, async () => {
    const r = await run(M0, ['send', input(okCall()), '--nonce', '3']);
    assert.equal(r.code, 1); assert.equal(r.last.error, 'nonce-too-low');
    assert.ok(!r.json.some((j) => j.event === 'broadcast' || j.hash), 'no hash may be emitted');
    assert.equal(mock.raws.length, 0); assert.ok(!fs.existsSync(M0.cfg.sendLockPath)); assert.ok(!fs.existsSync(M0.cfg.logPath) || !/broadcast-intent/.test(fs.readFileSync(M0.cfg.logPath, 'utf8')));
    note('send --nonce on an already-used nonce', ['send', 'run/in.json', '--nonce', '3'], r);
    mock.reset(); const g = await run(M0, ['send', input(okCall()), '--nonce', '9']); assert.equal(g.last.error, 'nonce-gap'); assert.equal(mock.raws.length, 0);
  });
});
test('E8 a send is never retried: a failed send leaves the lock and exactly one send attempt (HTTP 500, nonce-too-low, 429, hang)', async () => {
  for (const [mode, setup] of [['http500', () => { mock.sendMode = 'http500'; }], ['error-nonce-low', () => { mock.sendMode = 'error-nonce-low'; }], ['429', () => { mock.throttleSend = 1; }], ['hang', () => { mock.sendMode = 'hang'; }]]) {
    mock.reset(); resetFs(M0); setup();
    const r = await run(M0, ['send', input(okCall())]);
    assert.equal(r.code, 5, `${mode}: ${r.stdout}`); assert.equal(r.last.event, 'unconfirmed'); assert.equal(r.last.reason, 'send-error'); assert.equal(r.last.lock_released, false);
    assert.ok(r.json.some((j) => j.event === 'broadcast'), 'the hash was emitted at broadcast');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(mock.sendAttempts, 1, `${mode}: the send must be attempted exactly once, saw ${mock.sendAttempts}`);
    assert.ok(fs.existsSync(M0.cfg.sendLockPath), `${mode}: the lock stays until reconcile`);
    const next = await run(M0, ['send', input(okCall())]); assert.equal(next.code, 4); assert.equal(next.last.refused, 'send-lock');
    if (mode === 'http500') note('send, send error leaves the lock', ['send', 'run/in.json'], r);
  }
});
test('E9 reads back off on 429 and retry; the send itself does not', async () => {
  mock.reset(); resetFs(M0); mock.throttle = 2;
  const call = okCall()[0]; const r = await run(M0, ['send', input([call])]);
  assert.equal(r.code, 0, r.stdout + r.stderr); assert.equal(mock.http429, 2); assert.equal(mock.sendAttempts, 1);
});
test('E10 a receipt that never arrives is unconfirmed (exit 5), the lock stays, nothing is re-sent', async () => {
  mock.reset(); resetFs(M0); mock.receiptDelayMs = 60000;
  const r = await run(M0, ['send', input(okCall())]);
  assert.equal(r.code, 5); assert.equal(r.last.event, 'unconfirmed'); assert.equal(r.last.reason, 'receipt-timeout'); assert.equal(mock.sendAttempts, 1); assert.ok(fs.existsSync(M0.cfg.sendLockPath));
  const lock = JSON.parse(fs.readFileSync(M0.cfg.sendLockPath, 'utf8')); assert.equal(lock.hash, r.last.hash);
});
test('E11 a reverted receipt exits 6 and releases the lock', async () => {
  mock.reset(); resetFs(M0); mock.receiptStatus = '0x0';
  const r = await run(M0, ['send', input(okCall())]);
  assert.equal(r.code, 6); assert.equal(r.last.event, 'reverted'); assert.ok(!fs.existsSync(M0.cfg.sendLockPath));
});
test('E12 a call that reverts in simulation is never signed', async () => {
  await withFreshState(M0, async () => {
    mock.callRevert = true;
    const r = await run(M0, ['send', input(okCall())]); assert.equal(r.code, 1); assert.equal(r.last.error, 'simulation-reverted');
    assert.equal(mock.raws.length, 0); assert.ok(!fs.existsSync(M0.cfg.sendLockPath));
    mock.reset(); resetFs(M0); mock.callError = { code: -32000, message: 'execution reverted: STF' }; // a revert under another code
    const r2 = await run(M0, ['send', input(okCall())]); assert.equal(r2.code, 1); assert.equal(r2.last.error, 'simulation-reverted'); assert.equal(mock.raws.length, 0);
  });
});
test('E12b a rate limit answered as a plain JSON-RPC error on the pre-sign eth_call is reported as the RPC error it is, never as a revert; nothing signed, no intent, lock released', async () => {
  await withFreshState(M0, async () => {
    mock.callError = { code: -32005, message: 'exceeded its requests per second capacity' };
    const r = await run(M0, ['send', input(okCall())]);
    assert.equal(r.code, 1, r.stdout); assert.equal(r.last.error, 'rpc-error'); assert.notEqual(r.last.error, 'simulation-reverted');
    assert.match(r.last.detail, /requests per second/); assert.equal(r.last.rpc_code, -32005); assert.equal(r.last.simulated, undefined);
    assert.equal(r.last.signed, false); assert.equal(r.last.broadcast, false);
    assert.ok(!r.json.some((j) => j.event === 'broadcast' || j.hash), 'no hash may be emitted');
    assert.equal(mock.raws.length, 0); assert.ok(!fs.existsSync(M0.cfg.sendLockPath), 'the lock is released: nothing was broadcast');
    assert.ok(!fs.existsSync(M0.cfg.logPath) || !/broadcast-intent/.test(fs.readFileSync(M0.cfg.logPath, 'utf8')), 'no broadcast intent');
    note('send, a rate limit on the pre-sign eth_call', ['send', 'run/in.json'], r);
    // the caller re-runs it once the RPC answers again: the same file then signs and broadcasts once
    mock.callError = null; const again = await run(M0, ['send', input(okCall())]);
    assert.equal(again.code, 0, again.stdout); assert.equal(again.last.event, 'confirmed'); assert.equal(mock.raws.length, 1);
  });
});
test('E12c simulate on the eth_call fallback: a rate limit is the RPC error it is (no "simulated":true); a revert is status 0x0', async () => {
  await withFreshState(M0, async () => {
    mock.simulateSupported = false; mock.callError = { code: -32016, message: 'over rate limit' };
    const r = await run(M0, ['simulate', input([goodSwapIn()])]);
    assert.equal(r.code, 1, r.stdout); assert.equal(r.last.error, 'rpc-error'); assert.match(r.last.detail, /rate limit/); assert.equal(r.last.simulated, undefined);
    mock.callError = null; mock.callRevert = true;
    const v = await run(M0, ['simulate', input([goodSwapIn()])]);
    assert.equal(v.code, 1); assert.equal(v.last.simulated, true); assert.equal(v.last.via, 'eth_call'); assert.equal(v.last.results[0].status, '0x0');
    assert.equal(mock.raws.length, 0);
  });
});
test('E13 gas: estimate x1.2, caller gasLimit honoured, 2^24 clamp, over-ceiling input rejected', async () => {
  const call = okCall()[0];
  let out = await sendAndWatch(call); assert.equal(parseRaw(mock.raws[0]).gasLimit, 240000n);
  mock.reset(); resetFs(M0);
  let r = await run(M0, ['send', input({ calls: [call], gasLimit: '123456' })]); assert.equal(r.code, 0); assert.equal(parseRaw(mock.raws[0]).gasLimit, 123456n);
  mock.reset(); resetFs(M0); mock.estimate = 16_000_000n;
  r = await run(M0, ['send', input([call])]); assert.equal(r.code, 0); assert.equal(parseRaw(mock.raws[0]).gasLimit, 16777216n); assert.equal(r.json[1].gas_clamped, true);
  mock.reset(); resetFs(M0);
  r = await run(M0, ['send', input({ calls: [call], gasLimit: '20000000' })]); assert.equal(r.code, 2); assert.equal(r.last.error, 'gas-limit'); assert.equal(mock.requests.length, 0);
});
test('E14 send takes exactly one call (a plain EOA has no atomic batch)', async () => {
  await withFreshState(M0, async () => {
    const r = await run(M0, ['send', input([okCall()[0], okCall()[0]])]); assert.equal(r.code, 2); assert.equal(r.last.error, 'one-call-only'); assert.equal(mock.raws.length, 0);
    const bad = await run(M0, ['send', input([okCall()[0], approve(S.PINNED.susds, BURN, 1n)])]); assert.equal(bad.last.rule, 'approval-spender'); assert.equal(bad.last.index, 1);
  });
});
test('E15 no amount, count, frequency or time limit: a 1e60 approve, a 1e40 split and back-to-back sends all go through', async () => {
  mock.reset(); resetFs(M0);
  for (const call of [approve(S.PINNED.susds, S.PINNED.router, 10n ** 60n), split(S.PINNED_TREE.parent, 10n ** 40n), okCall()[0], okCall()[0], okCall()[0]]) {
    mock.receiptDelayMs = 50;
    const r = await run(M0, ['send', input([call])]); assert.equal(r.code, 0, r.stdout); mock.tick();
  }
  assert.equal(mock.raws.length, 5); assert.equal(parseRaw(mock.raws[4]).nonce, 11);
});
test('E16 the broadcast carries a fresh pending nonce when none is pinned, and fee fields are set from the node', async () => {
  const call = okCall()[0]; const out = await sendAndWatch(call, { mockSetup: () => { mock.latest = 20; mock.pending = 20; } });
  const tx = verifySend(out, call, 20); assert.equal(tx.maxFeePerGas, 2_000_000n); assert.equal(tx.maxPriorityFeePerGas, 100_000n);
  mock.reset(); resetFs(M0); mock.noTip = true;
  const r = await run(M0, ['send', input([call])]); assert.equal(r.code, 0); assert.equal(parseRaw(mock.raws[0]).maxPriorityFeePerGas, 500_000n);
});

// =========================================================================================================
// F. send-lock, reconcile, clear-nonce, sweeps (the separate, supervised entry points)
// =========================================================================================================
test('F1 a second send while the first is in flight is refused with the distinct send-lock refusal (lock path and hash declared)', async () => {
  mock.reset(); resetFs(M0); mock.receiptDelayMs = 1200;
  let second; const f = input(okCall());
  const first = await run(M0, ['send', f], { onLine: (rec) => { if (rec.json && rec.json.event === 'broadcast' && !second) second = run(M0, ['send', f]); } });
  const b = await second;
  assert.equal(first.code, 0); assert.equal(b.code, 4); assert.equal(b.last.refused, 'send-lock'); assert.equal(b.last.lock_path, M0.cfg.sendLockPath);
  assert.equal(b.last.lock.hash, first.json[1].hash); assert.equal(b.last.signed, false); assert.equal(mock.raws.length, 1);
  note('send, refused because the send-lock is held', ['send', 'run/in.json'], b);
});
test('F2 a killed send leaves the lock; send refuses; reconcile reports pending, then clears it once the transaction landed', async () => {
  mock.reset(); resetFs(M0); mock.receiptDelayMs = 3000;
  const f = input(okCall());
  const killed = await run(M0, ['send', f], { onLine: (rec, child) => { if (rec.json && rec.json.event === 'broadcast') { const iv = setInterval(() => { if (mock.raws.length > 0) { clearInterval(iv); child.kill('SIGKILL'); } }, 5); } } });
  assert.notEqual(killed.code, 0); assert.ok(fs.existsSync(M0.cfg.sendLockPath));
  const lock = JSON.parse(fs.readFileSync(M0.cfg.sendLockPath, 'utf8')); assert.equal(lock.hash, killed.json[1].hash);
  const refused = await run(M0, ['send', f]); assert.equal(refused.code, 4); assert.equal(refused.last.refused, 'send-lock');
  const pend = await run(M0, ['reconcile']); assert.equal(pend.code, 5); assert.equal(pend.last.status, 'pending-or-unsent'); assert.ok(fs.existsSync(M0.cfg.sendLockPath));
  note('reconcile, transaction not mined yet', ['reconcile'], pend);
  while (Date.now() < [...mock.txs.values()][0].minedAt + 50) await new Promise((r) => setTimeout(r, 100));
  const done = await run(M0, ['reconcile']); assert.equal(done.code, 0); assert.equal(done.last.status, 'landed'); assert.equal(done.last.hash, lock.hash); assert.equal(done.last.lock_released, true);
  assert.ok(!fs.existsSync(M0.cfg.sendLockPath)); note('reconcile, transaction landed', ['reconcile'], done);
  mock.reset(); const again = await run(M0, ['send', f]); assert.equal(again.code, 0);
});
test('F3 reconcile: superseded nonce, no-intent lock, no lock', async () => {
  mock.reset(); resetFs(M0); mock.sendMode = 'error-nonce-low';
  const r = await run(M0, ['send', input(okCall())]); assert.equal(r.code, 5);
  mock.latest = 9; // another transaction consumed nonce 7
  const sup = await run(M0, ['reconcile']); assert.equal(sup.code, 0); assert.equal(sup.last.status, 'superseded'); assert.ok(!fs.existsSync(M0.cfg.sendLockPath)); note('reconcile, nonce consumed by another transaction', ['reconcile'], sup);
  fs.writeFileSync(M0.cfg.sendLockPath, JSON.stringify({ attempt: 'x', pid: deadPid(), command: 'send', started_at: 'then' }));
  const cleared = await run(M0, ['reconcile']); assert.equal(cleared.last.status, 'cleared');
  const none = await run(M0, ['reconcile']); assert.equal(none.last.status, 'no-lock');
  fs.writeFileSync(M0.cfg.sendLockPath, JSON.stringify({ attempt: 'x', pid: process.pid, command: 'send' }));
  const live = await run(M0, ['reconcile']); assert.equal(live.last.status, 'in-progress'); assert.ok(fs.existsSync(M0.cfg.sendLockPath));
  resetFs(M0);
});
test('F4 clear-nonce <n>: zero-value transaction to the PINNED owner at nonce n with a doubled fee, no destination argument, runs past a dead lock but not a live one', async () => {
  mock.reset(); resetFs(M0);
  fs.writeFileSync(M0.cfg.sendLockPath, JSON.stringify({ attempt: 'x', pid: deadPid(), command: 'send', hash: '0x' + '11'.repeat(32), nonce: 7 }));
  const normal = await sendAndWatch(okCall()[0]); void normal; const normalFee = parseRaw(mock.raws[0]).maxFeePerGas;
  mock.reset(); resetFs(M0); fs.writeFileSync(M0.cfg.sendLockPath, JSON.stringify({ attempt: 'x', pid: deadPid(), command: 'send', hash: '0x' + '11'.repeat(32), nonce: 7 }));
  const r = await run(M0, ['clear-nonce', '7']);
  assert.equal(r.code, 0, r.stdout + r.stderr); const tx = parseRaw(mock.raws[0]);
  assert.equal(lc(tx.to), lc(W.owner)); assert.equal(tx.value, 0n); assert.equal(tx.data, '0x'); assert.equal(tx.nonce, 7); assert.equal(tx.from, W.address); assert.equal(tx.maxFeePerGas, normalFee * 2n);
  assert.equal(r.json[0].event, 'broadcast'); assert.equal(r.json[0].hash, tx.hash);
  note('clear-nonce 7 (supervised entry point)', ['clear-nonce', '7'], r);
  mock.reset(); expectNoSend(await run(M0, ['clear-nonce', '3']), 'nonce-too-low');
  mock.reset(); fs.writeFileSync(M0.cfg.sendLockPath, JSON.stringify({ attempt: 'x', pid: process.pid })); const live = await run(M0, ['clear-nonce', '7']); assert.equal(live.code, 4); assert.equal(mock.raws.length, 0);
  mock.reset(); resetFs(M0);
  for (const bad of [['clear-nonce', '7', BURN], ['clear-nonce', '7', '--to', BURN], ['clear-nonce', '--destination', BURN, '7']]) { const x = await run(M0, bad); assert.equal(x.code, 2); assert.equal(mock.raws.length, 0); }
});
function expectNoSend(r, error) { assert.equal(r.last.error, error); assert.equal(mock.raws.length, 0); }
test('F5 sweep-token sends ONLY to the pinned owner (balance default, --amount, no destination argument possible)', async () => {
  mock.reset(); resetFs(M0); mock.tokenBalance = 1234n;
  let r = await run(M0, ['sweep-token', S.PINNED.usdc]); assert.equal(r.code, 0, r.stdout + r.stderr);
  let tx = parseRaw(mock.raws[0]); assert.equal(lc(tx.to), lcP('usdc')); assert.equal(tx.data, S.IF.erc20.encodeFunctionData('transfer', [W.owner, 1234n]).toLowerCase()); assert.equal(tx.value, 0n);
  const [dec] = S.IF.erc20.decodeFunctionData('transfer', tx.data); assert.equal(lc(dec), lc(W.owner));
  mock.reset(); resetFs(M0); mock.tokenBalance = 1234n;
  r = await run(M0, ['sweep-token', S.PINNED.usdc, '--amount', '100']); tx = parseRaw(mock.raws[0]); assert.equal(tx.data, S.IF.erc20.encodeFunctionData('transfer', [W.owner, 100n]).toLowerCase());
  note('sweep-token <token> --amount 100', ['sweep-token', S.PINNED.usdc, '--amount', '100'], r);
  for (const bad of [['sweep-token', S.PINNED.usdc, BURN], ['sweep-token', S.PINNED.usdc, '--to', BURN], ['sweep-token', S.PINNED.usdc, '--recipient=' + BURN], ['sweep-token']]) {
    mock.reset(); resetFs(M0); const x = await run(M0, bad); assert.equal(x.code, 2); assert.equal(mock.raws.length, 0);
  }
  mock.reset(); resetFs(M0); mock.tokenBalance = 5n; const big = await run(M0, ['sweep-token', S.PINNED.usdc, '--amount', '6']); assert.equal(big.last.error, 'amount-too-large'); assert.equal(mock.raws.length, 0);
});
test('F6 sweep-eth sends ONLY to the pinned owner', async () => {
  mock.reset(); resetFs(M0);
  const r = await run(M0, ['sweep-eth', '--amount', '12345']); assert.equal(r.code, 0, r.stdout + r.stderr); note('sweep-eth --amount 12345', ['sweep-eth', '--amount', '12345'], r);
  const tx = parseRaw(mock.raws[0]); assert.equal(lc(tx.to), lc(W.owner)); assert.equal(tx.value, 12345n); assert.equal(tx.data, '0x'); assert.ok(tx.gasLimit >= 21000n);
  for (const bad of [['sweep-eth'], ['sweep-eth', '--amount', '1', BURN], ['sweep-eth', '--amount', '1', '--to', BURN]]) { mock.reset(); resetFs(M0); assert.equal((await run(M0, bad)).code, 2); assert.equal(mock.raws.length, 0); }
});
test('F7 info reports public facts only (addresses, hashes, the declared lock path), never key material', async () => {
  mock.reset();
  const r = await run(M0, ['info']); assert.equal(r.code, 0); const i = r.last;
  assert.equal(i.signer_address, W.address); assert.equal(i.owner, W.owner); assert.equal(i.allowlist_hash_matches, true); assert.equal(i.send_lock_path, M0.cfg.sendLockPath);
  assert.equal(i.signer_sha256, crypto.createHash('sha256').update(fs.readFileSync(M0.bin)).digest('hex')); assert.equal(mock.requests.length, 0);
  note('info', ['info'], r);
});

// =========================================================================================================
// G. key handling
// =========================================================================================================
test('G1 a wrong unlock secret is a generic error before any intent: no key, password or ethers detail is printed', async () => {
  await withFreshState(M0, async () => {
    const good = fs.readFileSync(W.unlock, 'utf8');
    try {
      fs.writeFileSync(W.unlock, 'not-the-password-ZZZ');
      const r = await run(M0, ['send', input(okCall())]);
      assert.equal(r.code, 1); assert.equal(r.last.error, 'unlock'); assert.equal(mock.raws.length, 0); assert.ok(!fs.existsSync(M0.cfg.sendLockPath));
      assert.ok(!/not-the-password|incorrect password|scrypt/i.test(r.stdout + r.stderr));
    } finally { fs.writeFileSync(W.unlock, good); }
  });
});
test('G2 a keystore for a different address than signerAddress is refused before signing', async () => {
  await withFreshState(M0, async () => {
    const other = Wallet.createRandom(); const text = await ethers.encryptKeystoreJson({ address: other.address, privateKey: other.privateKey }, W.password, { scrypt: { N: 1 << 10 } });
    const ks = path.join(W.data, 'other-keystore.json'); fs.writeFileSync(ks, text);
    const inst = makeInstall('wrongkeystore', { keystorePath: ks, allowlistPath: M0.cfg.allowlistPath, allowlistSha256: M0.cfg.allowlistSha256 }); inst.writeConfig();
    const r = await run(inst, ['send', input(okCall())]); assert.equal(r.code, 1); assert.equal(r.last.error, 'unlock'); assert.equal(mock.raws.length, 0);
    NEEDLES.push(other.privateKey);
  });
});
test('G3 Windows DPAPI (the bundled CLI\'s keystore + DPAPI-protected password layout) signs and broadcasts', async () => {
  if (process.platform !== 'win32') skip('DPAPI is Windows-only');
  const w = Wallet.createRandom(); const pw = crypto.randomBytes(32);
  const ks = path.join(W.data, 'dpapi-keystore.json'); fs.writeFileSync(ks, await ethers.encryptKeystoreJson({ address: w.address, privateKey: w.privateKey }, pw, { scrypt: { N: 1 << 10 } }));
  const script = 'Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($in); $r=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))';
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const p = cp.spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { input: pw.toString('base64'), encoding: 'utf8' });
  assert.equal(p.status, 0, 'DPAPI Protect failed in the test setup');
  const blob = path.join(W.data, 'dpapi-unlock.bin'); fs.writeFileSync(blob, Buffer.from(p.stdout.trim(), 'base64'));
  const inst = makeInstall('dpapi', { signerAddress: w.address, keystorePath: ks, signerMode: 'dpapi', unlockPath: blob });
  inst.setAllowlist(JSON.stringify(synthAllowlist(S, w.address), null, 2));
  mock.reset();
  const r = await run(inst, ['send', input([approve(S.PINNED.susds, S.PINNED.router, 1n)])]);
  assert.equal(r.code, 0, r.stdout + r.stderr); assert.equal(parseRaw(mock.raws[0]).from, w.address);
  NEEDLES.push(w.privateKey, pw.toString('hex'));
});

// =========================================================================================================
// H. allowlist-init against a synthetic chain (the live run is recorded in the README)
// =========================================================================================================
test('H1 allowlist-init: builds, verifies every outcome token against CTF.getPositionId, pins fee tiers, prints the sha256 to record', async () => {
  mock.reset();
  mock.world = makeWorld(S, cTable, { tier: (i, side) => (i === 3 && side === 'down' ? 500 : 100), extraPool: (i, side) => (i === 5 && side === 'up') || (i === 9 && side === 'down'), zeroLiq: (i, side) => i === 9 && side === 'down', noPool: (i, side) => i === 7 && side === 'up' });
  try {
    const inst = makeInstall('init'); const skillDir = SKILL_DIR;
    const r = await run(inst, ['allowlist-init', '--skill-dir', skillDir, '--delay-ms', '50']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const text = fs.readFileSync(inst.cfg.allowlistPath, 'utf8');
    assert.equal(r.last.sha256, crypto.createHash('sha256').update(text).digest('hex'));
    assert.equal(r.last.children, 98); assert.equal(r.last.outcome_tokens_verified, 4 + 34 + 34 + 33 + 294);
    const doc = JSON.parse(text);
    assert.equal(doc.children[3].fee_down, 500); assert.equal(doc.children[5].fee_up, 100, 'tier 100 is the verified default and wins while its pool holds liquidity, even against a deeper pool at another tier'); assert.equal(doc.children[9].fee_down, 500, 'a tier-100 pool with no liquidity loses to a live pool at another tier'); assert.equal(doc.children[7].fee_up, null); assert.equal(doc.children[0].fee_down, 100);
    assert.equal(doc.children[0].down, mock.world.markets.get(lc(doc.children[0].market)).wrapped[0]);
    assert.equal(doc.holder, W.address);
    assert.ok(r.last.warnings.some((w) => /pools at tiers 100, 500/.test(w) || /pools at tiers 500, 100/.test(w)), 'multi-pool warning');
    assert.ok(r.last.warnings.some((w) => /no pool at any tier/.test(w)), 'missing-pool warning');
    assert.deepEqual(r.last.pools_pinned_by_fee_tier, { 100: 193, 500: 2, null: 1 });
    note('allowlist-init (synthetic chain)', ['allowlist-init', '--skill-dir', '<skill dir>', '--delay-ms', '50'], r);
    // the produced file loads: pin it and use it
    inst.cfg.allowlistSha256 = r.last.sha256; inst.writeConfig();
    const d = doc.children[3];
    const good = await run(inst, ['check', input([swapIn({ tokenIn: d.down, tokenOut: d.repo_token, fee: 500, recipient: W.address })])]); assert.equal(good.stdout, '{"allowed":true}\n');
    const wrong = await run(inst, ['check', input([swapIn({ tokenIn: d.down, tokenOut: d.repo_token, fee: 100, recipient: W.address })])]); assert.equal(wrong.last.rule, 'swap-fee-tier');
    const nopool = doc.children[7]; const np = await run(inst, ['check', input([swapIn({ tokenIn: nopool.up, tokenOut: nopool.repo_token, fee: 100, recipient: W.address })])]); assert.equal(np.last.rule, 'swap-pair');
    // refuses to overwrite without --force
    const again = await run(inst, ['allowlist-init', '--skill-dir', skillDir, '--delay-ms', '50']); assert.equal(again.code, 2); assert.equal(again.last.error, 'exists');
  } finally { mock.world = null; }
});
test('H2 allowlist-init aborts and writes nothing when a wrapped token does not match CTF.getPositionId', async () => {
  mock.reset(); mock.world = makeWorld(S, cTable);
  try {
    mock.world.tamper.add(lc(mock.world.markets.get(lc(cTable.rows[10].market)).wrapped[1]));
    const inst = makeInstall('init-tamper');
    const r = await run(inst, ['allowlist-init', '--skill-dir', SKILL_DIR, '--delay-ms', '50']);
    assert.equal(r.code, 1); assert.equal(r.last.error, 'verify'); assert.match(r.last.detail, /does not match CTF\.getPositionId/); assert.ok(!fs.existsSync(inst.cfg.allowlistPath));
  } finally { mock.world = null; }
});
test('H3 allowlist-init refuses a skill table that disagrees with itself or with the pinned addresses', async () => {
  mock.reset(); mock.world = makeWorld(S, cTable);
  try {
    const dir = path.join(ROOT, 'badskill', 'steps'); fs.mkdirSync(dir, { recursive: true });
    const c = fs.readFileSync(path.join(SKILL_DIR, 'steps', 'C-select.md'), 'utf8'); const g = fs.readFileSync(path.join(SKILL_DIR, 'steps', 'G-mint-and-trade.md'), 'utf8');
    const inst = makeInstall('init-badskill');
    fs.writeFileSync(path.join(dir, 'C-select.md'), c.replace(cTable.rows[1].market, cTable.rows[0].market)); fs.writeFileSync(path.join(dir, 'G-mint-and-trade.md'), g);
    let r = await run(inst, ['allowlist-init', '--skill-dir', path.dirname(dir), '--delay-ms', '50']); assert.equal(r.last.error, 'skill-table'); assert.match(r.last.detail, /appears twice/);
    fs.writeFileSync(path.join(dir, 'C-select.md'), c); fs.writeFileSync(path.join(dir, 'G-mint-and-trade.md'), g.replace(S.PINNED.router.slice(2), S.PINNED.psm3.slice(2)));
    r = await run(inst, ['allowlist-init', '--skill-dir', path.dirname(dir), '--delay-ms', '50']); assert.equal(r.last.error, 'skill-table'); assert.match(r.last.detail, /pinned in the signer/);
    assert.ok(!fs.existsSync(inst.cfg.allowlistPath));
  } finally { mock.world = null; }
});

function r3Body(world) {
  return {
    marketsData: {}, parentMarketStatus: 'open', middleMarkets: [],
    parentWrappedTokens: [...S.PINNED_TREE.bundles, S.PINNED_TREE.parentInvalid],
    markets: cTable.rows.map((r) => ({ id: r.market, wrappedTokens: world.markets.get(lc(r.market)).wrapped, collateralToken: r.repoToken, parentOutcome: r.slot, marketStatus: 'open' })),
  };
}
test('H4 allowlist-init --r3-data: the data function body is cross-checked against the tables and the chain, records its hash, and adds nothing', async () => {
  mock.reset(); mock.world = makeWorld(S, cTable);
  try {
    const body = r3Body(mock.world); const file = path.join(W.data, 'r3-data.json'); const text = JSON.stringify(body); fs.writeFileSync(file, text);
    const inst = makeInstall('init-r3');
    const r = await run(inst, ['allowlist-init', '--skill-dir', SKILL_DIR, '--delay-ms', '50', '--r3-data', file]);
    assert.equal(r.code, 0, r.stdout + r.stderr); assert.equal(r.last.r3_data_cross_checked_rows, 98);
    const doc = JSON.parse(fs.readFileSync(inst.cfg.allowlistPath, 'utf8'));
    assert.equal(doc.built_from.r3_data_sha256_cross_check_only, crypto.createHash('sha256').update(text).digest('hex'));
    // an address that only the body knows never reaches the allowlist: add a bogus extra token to a row, the build must refuse, not absorb it
    const evil = r3Body(mock.world); evil.markets[4].wrappedTokens = [evil.markets[4].wrappedTokens[0], evil.markets[4].wrappedTokens[1], BURN];
    fs.writeFileSync(file, JSON.stringify(evil));
    const inst2 = makeInstall('init-r3-evil'); mock.reset(); mock.world = makeWorld(S, cTable);
    const bad = await run(inst2, ['allowlist-init', '--skill-dir', SKILL_DIR, '--delay-ms', '50', '--r3-data', file]);
    assert.equal(bad.code, 1); assert.equal(bad.last.error, 'r3-data-mismatch'); assert.match(bad.last.detail, /wrappedTokens differ from the onchain wrappedOutcome/); assert.ok(!fs.existsSync(inst2.cfg.allowlistPath), 'nothing is written on a mismatch');
    let mi = 0;
    for (const mutate of [(b) => { b.markets.pop(); }, (b) => { b.markets[2].collateralToken = BURN; }, (b) => { b.markets[2].parentOutcome = 99; }, (b) => { b.parentWrappedTokens[3] = BURN; }]) {
      const b = r3Body(mock.world); mutate(b); fs.writeFileSync(file, JSON.stringify(b)); mock.reset(); mock.world = makeWorld(S, cTable);
      const x = await run(makeInstall('init-r3-bad' + (mi++)), ['allowlist-init', '--skill-dir', SKILL_DIR, '--delay-ms', '50', '--r3-data', file]);
      assert.equal(x.code, 1, x.stdout); assert.equal(x.last.error, 'r3-data-mismatch');
    }
    const missing = await run(makeInstall('init-r3-missing'), ['allowlist-init', '--skill-dir', SKILL_DIR, '--r3-data', path.join(W.data, 'nope.json')]); assert.equal(missing.code, 2);
  } finally { mock.world = null; }
});

// =========================================================================================================
// Z. key hygiene over everything the signer ever printed or logged in this run
// =========================================================================================================
test('Z1 no key material, password, keystore ciphertext or signed bytes appears in any output, log or lock produced in this run', () => {
  const blob = ALL_OUTPUT.join('\n') + '\n' + fs.readdirSync(W.data).filter((f) => /(-send\.lock|-signer\.log\.jsonl)$/.test(f)).map((f) => fs.readFileSync(path.join(W.data, f), 'utf8')).join('\n');
  const low = blob.toLowerCase();
  const labelled = [['throwaway private key', W.privateKey], ['throwaway private key (no 0x)', W.privateKey.slice(2)], ['unlock password', W.password],
    ...NEEDLES.map((n) => ['other throwaway secret', n]), ...NEEDLES.map((n) => ['other throwaway secret (no 0x)', n.replace(/^0x/, '')]),
    ...mock.allRaws.map((r) => ['signed transaction bytes', r]), ...mock.raws.map((r) => ['signed transaction bytes', r])].filter(([, s]) => s);
  for (const [label, n] of labelled) assert.ok(!low.includes(n.toLowerCase().slice(0, 64)), `${label} found in output`);
  const ks = JSON.parse(fs.readFileSync(W.keystore, 'utf8'));
  const cr = ks.crypto || ks.Crypto;
  for (const field of [cr.ciphertext, cr.kdfparams.salt, cr.mac]) assert.ok(!low.includes(String(field).toLowerCase()), 'keystore contents found in output');
  assert.ok(ALL_OUTPUT.length > 50, 'the scan must have seen the run\'s output');
});

// ---- runner ----------------------------------------------------------------------------------------------------
async function setup() {
  fs.mkdirSync(W.project, { recursive: true }); fs.mkdirSync(path.join(W.project, 'run'), { recursive: true }); fs.mkdirSync(W.data, { recursive: true });
  await mock.start();
  // a fresh throwaway wallet for this run only; its secrets exist only in this process and in W.data
  const wallet = Wallet.createRandom(); const owner = Wallet.createRandom();
  W.address = wallet.address; W.owner = owner.address; W.privateKey = wallet.privateKey; W.password = crypto.randomBytes(24).toString('hex');
  W.keystore = path.join(W.data, 'keystore.json'); W.unlock = path.join(W.data, 'unlock.txt');
  fs.writeFileSync(W.keystore, await ethers.encryptKeystoreJson({ address: wallet.address, privateKey: wallet.privateKey }, W.password, { scrypt: { N: 1 << 10 } }), { mode: 0o600 });
  fs.writeFileSync(W.unlock, W.password + '\n', { mode: 0o600 });
  const origReset = mock.reset.bind(mock); mock.allRaws = [];
  mock.reset = function () { if (this.raws) this.allRaws.push(...this.raws); origReset(); };
  const probe = makeInstall('probe'); S = require(probe.bin);
  const read = (f) => fs.readFileSync(path.join(SKILL_DIR, 'steps', f), 'utf8');
  cTable = S.parseCTable(read('C-select.md')); gTable = S.parseGTable(read('G-mint-and-trade.md'));
  POL = synthAllowlist(S, W.address);
  M0 = makeInstall('main'); M0.setAllowlist(JSON.stringify(POL, null, 2));
}
async function main() {
  console.log(`signer.test.cjs  work dir: ${ROOT}\n`);
  if (!fs.existsSync(path.join(SKILL_DIR, 'steps', 'C-select.md'))) { console.log(`FAIL setup: the skill folder (the parent of scripts/) was not found at ${SKILL_DIR}; run this from the skill's scripts/ folder`); process.exit(1); }
  await setup();
  let pass = 0; let fail = 0; let skipped = 0;
  for (const c of cases) {
    try { await c.fn(); pass++; console.log('PASS ' + c.name); }
    catch (e) {
      if (e instanceof Skip) { skipped++; console.log(`SKIP ${c.name} (${e.message})`); } else { fail++; console.log(`FAIL ${c.name}\n     ${String(e && e.message).split('\n').join('\n     ')}`); }
    }
  }
  fs.writeFileSync(path.join(ROOT, 'transcript.txt'), TRANSCRIPT.join('\n'));
  await mock.stop();
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped  (transcript: ${path.join(ROOT, 'transcript.txt')})`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
