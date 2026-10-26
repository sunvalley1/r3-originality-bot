#!/usr/bin/env node
'use strict';
/*
 * chain-helper.test.cjs - tests for chain-helper.cjs.  Run:  node chain-helper.test.cjs [--offline]
 *
 * Prints PASS / FAIL / SKIP per case and exits non-zero on any FAIL.
 *   offline cases  : no network at all (a loopback mock RPC stands in for the endpoint)
 *   live cases     : read-only calls to https://mainnet.optimism.io (eth_simulateV1 included), an independent
 *                    read on https://optimism-rpc.publicnode.com, and one GET of the deep.seer.pm data function.
 *                    --offline skips them.
 *
 * It never sends anything: the helper cannot, and no test holds key material. The only "key" is
 * ethers.Wallet.createRandom() used to mint a throwaway ADDRESS to act as the pinned signer in simulations.
 *
 * The helper is always run from a COPY in a scratch folder next to a test config (the helper refuses to run from
 * inside the project folder), with cwd = a scratch "project" that has a ./run folder.  Set R3_HELPER_TEST_TMP to
 * choose where the scratch folders go (default: the OS temp folder).  NODE_PATH points the copy at the ethers this
 * test uses; that is Node module resolution, not helper configuration.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { ethers } = require('ethers');

const OFFLINE = process.argv.includes('--offline');
const HELPER_SRC = path.join(__dirname, 'chain-helper.cjs');
const DATA_PATH = '/.netlify/functions/get-originality-r3-v3-markets-data';
const LIVE_RPC = 'https://mainnet.optimism.io';
const LIVE_DATA = 'https://deep.seer.pm' + DATA_PATH;
const INDEP_RPC = 'https://optimism-rpc.publicnode.com';

const TMP_BASE = process.env.R3_HELPER_TEST_TMP || os.tmpdir();
const ROOT = fs.mkdtempSync(path.join(TMP_BASE, 'r3-helper-test-'));

function ethersNodePath() {
  let d = path.dirname(require.resolve('ethers'));
  while (d !== path.dirname(d)) {
    if (path.basename(d) === 'ethers' && path.basename(path.dirname(d)) === 'node_modules') return path.dirname(d);
    d = path.dirname(d);
  }
  throw new Error('cannot locate the node_modules folder holding ethers');
}
const NODE_PATH = ethersNodePath();

// --------------------------------------------------------------------------------------------------------
// tiny harness
// --------------------------------------------------------------------------------------------------------

class Skip extends Error {}
const skip = (why) => { throw new Skip(why); };
const results = { PASS: 0, FAIL: 0, SKIP: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function test(name, fn) {
  try {
    await fn();
    results.PASS++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    if (e instanceof Skip) { results.SKIP++; console.log(`SKIP  ${name} -- ${e.message}`); return; }
    results.FAIL++;
    console.log(`FAIL  ${name} -- ${String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)}`);
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || 'values differ'}: got ${a.slice(0, 300)} expected ${b.slice(0, 300)}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'assertion failed'); }

// --------------------------------------------------------------------------------------------------------
// scratch layout: <ROOT>/<name>/install (helper copy + config)  and  <ROOT>/<name>/proj (cwd, with run/)
// --------------------------------------------------------------------------------------------------------

let seq = 0;
const THROWAWAY = ethers.Wallet.createRandom().address; // address only
const SIGNER_FIXED = '0x00000000000000000000000000000000000a11ce';

function makeLayout(name, config, opts = {}) {
  const base = path.join(ROOT, `${String(++seq).padStart(3, '0')}-${name}`);
  const install = path.join(base, 'install');
  const proj = path.join(base, 'proj');
  fs.mkdirSync(install, { recursive: true });
  fs.mkdirSync(path.join(proj, 'run'), { recursive: true });
  fs.copyFileSync(HELPER_SRC, path.join(install, 'chain-helper.cjs'));
  if (opts.rawConfig !== undefined) fs.writeFileSync(path.join(install, 'chain-helper.config.json'), opts.rawConfig);
  else if (config) fs.writeFileSync(path.join(install, 'chain-helper.config.json'), JSON.stringify(config, null, 2));
  return { base, install, proj, run: (id) => path.join(proj, 'run', id) };
}

function runHelperAt(helperFile, cwd, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [helperFile, ...args], { cwd, env: { ...process.env, NODE_PATH, ...extraEnv } });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      const lines = out.split('\n').filter((l) => l.trim() !== '');
      let json = null;
      if (lines.length === 1) { try { json = JSON.parse(lines[0]); } catch { json = null; } }
      resolve({ code, json, stdout: out, stderr: err });
    });
  });
}
const helperIn = (L) => (args, env) => runHelperAt(path.join(L.install, 'chain-helper.cjs'), L.proj, args, env);

function mockConfig(mock, extra = {}) {
  return {
    chainId: 10,
    rpcUrl: `http://127.0.0.1:${mock.port}/`,
    dataFunctionUrl: `http://127.0.0.1:${mock.port}${DATA_PATH}`,
    signerAddress: SIGNER_FIXED,
    requestTimeoutMs: 5000,
    retryBaseDelayMs: 5,
    ...extra,
  };
}

// --------------------------------------------------------------------------------------------------------
// loopback mock RPC + data function
// --------------------------------------------------------------------------------------------------------

const ALL_METHODS_SEEN = [];

function startMock() {
  const m = {
    http: [], // one entry per HTTP request: {method, url, items: [{method, params}], isBatch}
    rpc: {}, // method -> (params) => result | {error}
    data: () => ({ status: 200, headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: Buffer.from('{}') }),
    batchMode: 'ok', // 'ok' | 'refuse' (answers a JSON-RPC error object to an array) | '429-n'
    fail429: 0,
    port: 0,
  };
  m.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET') {
        m.http.push({ method: 'GET', url: req.url, items: [] });
        if (req.url !== DATA_PATH) { res.writeHead(404); res.end('nope'); return; }
        if (m.fail429 > 0) { m.fail429--; res.writeHead(429, { 'retry-after': '0' }); res.end('slow down'); return; }
        const d = m.data();
        res.writeHead(d.status, d.headers || {});
        res.end(d.body);
        return;
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); res.end('bad'); return; }
      const isBatch = Array.isArray(body);
      const reqs = isBatch ? body : [body];
      m.http.push({ method: 'POST', url: req.url, items: reqs.map((r) => ({ method: r.method, params: r.params })), isBatch });
      for (const r of reqs) ALL_METHODS_SEEN.push(r.method);
      if (m.fail429 > 0) { m.fail429--; res.writeHead(429, { 'retry-after': '0' }); res.end('slow down'); return; }
      if (isBatch && m.batchMode === 'refuse') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch not supported' } }));
        return;
      }
      const answer = reqs.map((r) => {
        if (r.method === 'eth_chainId' && !m.rpc.eth_chainId) return { jsonrpc: '2.0', id: r.id, result: '0xa' };
        const h = m.rpc[r.method];
        if (!h) return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `the method ${r.method} does not exist/is not available` } };
        const out = h(r.params);
        if (out && out.__error) return { jsonrpc: '2.0', id: r.id, error: out.__error };
        return { jsonrpc: '2.0', id: r.id, result: out };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(isBatch ? answer : answer[0]));
    });
  });
  return new Promise((resolve) => {
    m.server.listen(0, '127.0.0.1', () => {
      m.port = m.server.address().port;
      m.close = () => new Promise((r) => m.server.close(() => r()));
      resolve(m);
    });
  });
}
const rpcErr = (code, message, data) => ({ __error: { code, message, data } });
const methodsOf = (mock) => mock.http.flatMap((h) => h.items.map((i) => i.method));

// --------------------------------------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------------------------------------

const A = {
  sUSDS: '0xb5b2dc7fd34c249f4be7fb1fcea07950784229e0',
  router: '0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD',
  ctf: '0x8bdC504dC3A05310059c1c67E0A2667309D27B93',
  parent: '0x37ab5cbeee3a32289430e5d38b914ec7f580fd87',
  middleA: '0xc217920a91f1b3d56276393aa5345f01a848ecf0',
  bundleA: '0x8d883809dE718bAF9FCAd72133007B6115f77F6D',
  factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  mc3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  swapRouter: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
};
const ADDR1 = '0x1111111111111111111111111111111111111111';
const ADDR2 = '0x2222222222222222222222222222222222222222';

function writeRunFile(L, runId, name, content) {
  const dir = L.run(runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
  return `run/${runId}/${name}`;
}

function trySymlink(target, link, type) {
  try { fs.symlinkSync(target, link, type); return true; } catch (e) { if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'UNKNOWN') return false; throw e; }
}
function removeLink(p) {
  try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { /* ignore */ } }
}

// ========================================================================================================
// OFFLINE
// ========================================================================================================

async function offline() {
  const L0 = makeLayout('base', { chainId: 10, rpcUrl: 'http://127.0.0.1:9/', dataFunctionUrl: `http://127.0.0.1:9${DATA_PATH}`, signerAddress: SIGNER_FIXED });
  const H0 = helperIn(L0);
  const lib = require(HELPER_SRC); // in-process hooks (same code, same choke point)

  // ---- encode -------------------------------------------------------------------------------------------
  await test('encode: known selectors (independent of ethers)', async () => {
    const t = await H0(['encode', 'approve(address,uint256)', ADDR1, '5']);
    eq(t.code, 0); eq(t.json.selector, '0x095ea7b3');
    eq((await H0(['encode', 'transfer(address,uint256)', ADDR1, '5'])).json.selector, '0xa9059cbb');
    eq((await H0(['encode', 'balanceOf(address)', ADDR1])).json.selector, '0x70a08231');
    eq((await H0(['encode', 'slot0()'])).json.selector, '0x3850c7bd');
    eq((await H0(['encode', 'aggregate3((address,bool,bytes)[])', '[]'])).json.selector, '0x82ad56cb');
  });

  const iface = (frag) => new ethers.Interface([frag]);
  const vectors = [
    {
      name: 'splitPosition',
      args: ['splitPosition(address,address,uint256)', A.sUSDS, A.parent, '100000000000000000000'],
      expect: () => iface('function splitPosition(address,address,uint256)').encodeFunctionData('splitPosition', [A.sUSDS, A.parent, 100n * 10n ** 18n]),
    },
    {
      name: 'uint above 2^53 as string, and as 0x hex',
      args: ['approve(address,uint256)', A.router, '115792089237316195423570985008687907853269984665640564039457584007913129639935'],
      expect: () => iface('function approve(address,uint256)').encodeFunctionData('approve', [A.router, ethers.MaxUint256]),
    },
    {
      name: 'aggregate3 with nested bytes (tuple array as JSON)',
      args: ['aggregate3((address,bool,bytes)[])', JSON.stringify([[A.mc3, false, '0x1234'], [A.sUSDS, true, '0x']])],
      expect: () => iface('function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)')
        .encodeFunctionData('aggregate3', [[[A.mc3, false, '0x1234'], [A.sUSDS, true, '0x']]]),
    },
    {
      name: 'aggregate3 given as objects with named fields',
      args: ['aggregate3((address target,bool allowFailure,bytes callData)[] calls)', JSON.stringify([{ target: A.mc3, allowFailure: false, callData: '0xdeadbeef' }])],
      expect: () => iface('function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)')
        .encodeFunctionData('aggregate3', [[[A.mc3, false, '0xdeadbeef']]]),
    },
    {
      name: 'redeemPositions with two uint256 arrays',
      args: ['redeemPositions(address,address,uint256[],uint256[])', A.sUSDS, A.parent, '["0","1","2"]', '["1000000000000000000","2","3"]'],
      expect: () => iface('function redeemPositions(address,address,uint256[],uint256[])').encodeFunctionData('redeemPositions', [A.sUSDS, A.parent, [0n, 1n, 2n], [10n ** 18n, 2n, 3n]]),
    },
    {
      name: 'SwapRouter02 exactInputSingle struct',
      args: ['exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))', JSON.stringify([ADDR1, ADDR2, 100, A.router, '1000000000000000000', '995000000000000000', '0'])],
      expect: () => iface('function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)')
        .encodeFunctionData('exactInputSingle', [[ADDR1, ADDR2, 100, A.router, 10n ** 18n, 995000000000000000n, 0n]]),
    },
    {
      name: 'SwapRouter02 exactOutputSingle struct',
      args: ['exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))', JSON.stringify([ADDR1, ADDR2, 100, A.router, '7', '8', '0'])],
      expect: () => iface('function exactOutputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)')
        .encodeFunctionData('exactOutputSingle', [[ADDR1, ADDR2, 100, A.router, 7n, 8n, 0n]]),
    },
    {
      name: 'QuoterV2 quoteExactInputSingle struct (returns declared, ignored by encode)',
      args: ['quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)', JSON.stringify([ADDR1, ADDR2, '1000000000000000000', 100, '0'])],
      expect: () => iface('function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params)')
        .encodeFunctionData('quoteExactInputSingle', [[ADDR1, ADDR2, 10n ** 18n, 100, 0n]]),
    },
    {
      name: 'bool, bytes32, string and negative int24',
      args: ['mixed(bool,bytes32,string,int24)', 'true', '0x' + '11'.repeat(32), 'hello', '-887272'],
      expect: () => iface('function mixed(bool,bytes32,string,int24)').encodeFunctionData('mixed', [true, '0x' + '11'.repeat(32), 'hello', -887272]),
    },
    {
      name: 'full human-readable function line',
      args: ['function balanceOf(address owner) view returns (uint256)', ADDR1],
      expect: () => iface('function balanceOf(address) view returns (uint256)').encodeFunctionData('balanceOf', [ADDR1]),
    },
  ];
  for (const v of vectors) {
    await test(`encode vector: ${v.name}`, async () => {
      const r = await H0(['encode', ...v.args]);
      eq(r.code, 0, `exit (${r.stdout.slice(0, 200)})`);
      eq(r.json.calldata, v.expect(), 'calldata');
      eq(r.json.bytes, (v.expect().length - 2) / 2, 'bytes');
      eq(r.json.keccak256, ethers.keccak256(v.expect()), 'keccak256 of calldata');
    });
  }

  await test('encode: quote-stripped JSON (Windows PowerShell 5.1 drops the double quotes) is accepted, big integers included', async () => {
    const want = iface('function exactInputSingle(tuple(address,address,uint24,address,uint256,uint256,uint160))').encodeFunctionData('exactInputSingle', [[ADDR1, ADDR2, 100, A.router, 10n ** 18n, 995000000000000000n, 0n]]);
    const sig = 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))';
    const stripped = `[${ADDR1},${ADDR2},100,${A.router},1000000000000000000,995000000000000000,0]`;
    const r = await H0(['encode', sig, stripped]);
    eq(r.code, 0, r.stdout); eq(r.json.calldata, want);
    const agg = iface('function aggregate3(tuple(address,bool,bytes)[])').encodeFunctionData('aggregate3', [[[A.mc3, false, '0x1234'], [A.sUSDS, true, '0x']]]);
    eq((await H0(['encode', 'aggregate3((address,bool,bytes)[])', `[[${A.mc3},false,0x1234],[${A.sUSDS},true,0x]]`])).json.calldata.length, agg.length);
    eq((await H0(['encode', 'aggregate3((address,bool,bytes)[])', `[[${A.mc3},false,0x1234],[${A.sUSDS},true,0x]]`])).json.calldata, agg);
    const objs = await H0(['encode', 'aggregate3((address target,bool allowFailure,bytes callData)[] calls)', `[{target:${A.mc3},allowFailure:false,callData:0xdeadbeef}]`]);
    eq(objs.json.calldata, iface('function aggregate3(tuple(address,bool,bytes)[])').encodeFunctionData('aggregate3', [[[A.mc3, false, '0xdeadbeef']]]));
    // strict JSON still refuses an unquoted-or-not unsafe integer, and loose mode refuses what is not an integer
    eq((await H0(['encode', 'f(uint256[])', '[9007199254740993]'])).code, 2);
    eq((await H0(['encode', 'f(uint256[])', '[1e18]'])).code, 2);
    eq((await H0(['encode', 'f(uint256[])', '[1000000000000000000]'])).code, 2, 'strict JSON number above 2^53 is refused');
    eq((await H0(['encode', 'f(uint256[])', '[0x1,1000000000000000000]'])).json.calldata, iface('function f(uint256[])').encodeFunctionData('f', [[1n, 10n ** 18n]]), 'the same integers survive once quotes were stripped');
  });

  await test('encode refuses a JSON integer above 2^53, an exponent, a wrong arity and bad scalars', async () => {
    const big = await H0(['encode', 'f(uint256[])', '[9007199254740993]']);
    eq(big.code, 2); eq(big.json.code, 'bad_argument');
    const exp = await H0(['encode', 'f(uint256[])', '[1e18]']);
    eq(exp.code, 2);
    eq((await H0(['encode', 'f(uint256)', '1', '2'])).code, 2);
    eq((await H0(['encode', 'f(address)', '0x1234'])).code, 2);
    eq((await H0(['encode', 'f(bool)', 'yes'])).code, 2);
    eq((await H0(['encode', 'f(bytes)', '0xabc'])).code, 2);
    eq((await H0(['encode', 'f(uint256)', '1.5'])).code, 2);
    eq((await H0(['encode', 'f(uint256)', '1e18'])).code, 2);
    eq((await H0(['encode', 'not a signature', '1'])).code, 2);
    eq((await H0(['encode', 'f(address)', '0x52908400098527886E0F7030069857D2E4169EE7'])).code, 0, 'valid checksum accepted');
    eq((await H0(['encode', 'f(address)', '0x52908400098527886E0F7030069857D2E4169ee7'])).code, 2, 'bad checksum refused');
  });

  await test('encode: @file argument reads a confined file; an escaping @ path is refused', async () => {
    const rel = writeRunFile(L0, 'args1', 'tuple.json', JSON.stringify([[A.mc3, false, '0x1234']]));
    const r = await H0(['encode', 'aggregate3((address,bool,bytes)[])', `@${rel}`]);
    eq(r.code, 0, r.stdout);
    eq(r.json.calldata, iface('function aggregate3(tuple(address,bool,bytes)[])').encodeFunctionData('aggregate3', [[[A.mc3, false, '0x1234']]]));
    const bad = await H0(['encode', 'aggregate3((address,bool,bytes)[])', '@../outside.json']);
    eq(bad.code, 4); eq(bad.json.code, 'path_traversal');
  });

  await test('encode: output too large is an error, never a truncation', async () => {
    const rel = writeRunFile(L0, 'big1', 'blob.hex', '0x' + '00'.repeat(20000));
    const r = await H0(['encode', 'f(bytes)', `@${rel}`]);
    eq(r.code, 7); eq(r.json.code, 'output_too_large');
  });

  // ---- keccak256 ----------------------------------------------------------------------------------------
  await test('keccak256: hex is hashed as bytes (empty, short, long) and matches ethers', async () => {
    const e = await H0(['keccak256', '0x']);
    eq(e.json.keccak256, '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'); eq(e.json.bytes, 0);
    eq((await H0(['keccak256', '0x1234'])).json.keccak256, ethers.keccak256('0x1234'));
    const long = '0x' + crypto.randomBytes(5000).toString('hex');
    eq((await H0(['keccak256', long])).json.keccak256, ethers.keccak256(long));
    eq((await H0(['keccak256', '0x1234'])).json.source, 'hex');
  });
  await test('keccak256: odd-length or non-hex 0x input and an uppercase 0X are refused, not treated as a path', async () => {
    for (const x of ['0xabc', '0xzz', '0X1234']) {
      const r = await H0(['keccak256', x]);
      eq(r.code, 2, x); eq(r.json.code, 'bad_argument', x);
    }
  });
  await test('keccak256: a file under run/<run-id>/ holding 0x hex is hashed as bytes (trailing newline ignored)', async () => {
    const data = '0x' + crypto.randomBytes(3000).toString('hex');
    const rel = writeRunFile(L0, 'k1', 'data.hex', data + '\n');
    const r = await H0(['keccak256', rel]);
    eq(r.code, 0, r.stdout); eq(r.json.keccak256, ethers.keccak256(data)); eq(r.json.bytes, 3000); eq(r.json.source, 'file');
    const rel2 = writeRunFile(L0, 'k1', 'notes.txt', 'hello world');
    const r2 = await H0(['keccak256', rel2]);
    eq(r2.code, 2); eq(r2.json.code, 'file_not_hex');
    const rel3 = writeRunFile(L0, 'k1', 'odd.hex', '0xabc');
    eq((await H0(['keccak256', rel3])).json.code, 'file_not_hex');
  });

  // ---- path confinement ---------------------------------------------------------------------------------
  await test('path confinement (lexical): every refusal carries its own distinct code', async () => {
    const cases = [
      ['', 'path_empty'],
      ['../x', 'path_traversal'],
      ['run/../x', 'path_traversal'],
      ['run/k1/../../x', 'path_traversal'],
      ['run\\k1\\..\\..\\x', 'path_traversal'],
      ['/etc/passwd', 'path_absolute'],
      ['\\Windows\\win.ini', 'path_absolute'],
      ['C:\\Windows\\win.ini', 'path_drive'],
      ['C:/Windows/win.ini', 'path_drive'],
      ['C:foo', 'path_drive'],
      ['\\\\server\\share\\x', 'path_unc'],
      ['//server/share/x', 'path_unc'],
      ['\\\\?\\C:\\x', 'path_unc'],
      ['run/k1/a:stream', 'path_colon'],
      ['x/y/z', 'path_outside_run'],
      ['RUN/k1/data.hex', 'path_outside_run'],
      ['wallet.json', 'path_outside_run'],
      ['run', 'path_too_short'],
      ['run/wallet.json', 'path_too_short'],
      ['run/k1', 'path_too_short'],
      ['run//k1/data.hex', 'path_malformed'],
      ['run/k1/./data.hex', 'path_malformed'],
      ['run/k1/', 'path_malformed'],
      ['run/.lock.deep-r3-trade/owner.txt', 'bad_run_id'],
      ['run/a b/x', 'bad_run_id'],
      ['run/k1/CON', 'path_component'],
      ['run/k1/nul.txt', 'path_component'],
      ['run/k1/trailing.', 'path_component'],
      ['run/k1/sp ace', 'path_component'],
      ['run/k1/.hidden', 'path_component'],
    ];
    for (const [arg, code] of cases) {
      let got = null;
      try { lib.parseRunPath(arg); } catch (e) { got = e.code; }
      eq(got, code, `parseRunPath(${JSON.stringify(arg)})`);
    }
    for (const good of ['run/k1/data.hex', './run/k1/data.hex', 'run\\k1\\data.hex', 'run/k1/sub/dir/a_b-c.1.json']) {
      eq(lib.parseRunPath(good).runId, 'k1', good);
    }
    ok(new Set(cases.map((c) => c[1])).size >= 11, 'distinct codes');
  });

  await test('path confinement (end to end): refusals exit 4 with the same codes, and an absolute path to a real file is still refused', async () => {
    const real = writeRunFile(L0, 'k1', 'real.hex', '0x1234');
    const abs = path.join(L0.proj, real);
    const r = await H0(['keccak256', abs]);
    eq(r.code, 4); eq(r.json.code, abs.startsWith('\\\\') ? 'path_unc' : (/^[A-Za-z]:/.test(abs) ? 'path_drive' : 'path_absolute'));
    for (const [arg, code] of [['../x', 'path_traversal'], ['run/k1/missing.hex', 'path_not_found'], ['run/k1', 'path_too_short'], ['run/nonexistent/x.hex', 'path_not_found']]) {
      const x = await H0(['keccak256', arg]);
      eq(x.code, 4, arg); eq(x.json.code, code, arg);
    }
    fs.mkdirSync(path.join(L0.run('k1'), 'subdir'), { recursive: true });
    eq((await H0(['keccak256', 'run/k1/subdir'])).json.code, 'path_not_file');
    eq((await H0(['keccak256', './run/k1/real.hex'])).code, 0);
    eq((await H0(['keccak256', 'run\\k1\\real.hex'])).code, 0);
  });

  await test('path confinement: ./run missing in the current directory is its own error', async () => {
    const L = makeLayout('norun', { chainId: 10, rpcUrl: 'http://127.0.0.1:9/', dataFunctionUrl: `http://127.0.0.1:9${DATA_PATH}`, signerAddress: SIGNER_FIXED });
    fs.rmSync(path.join(L.proj, 'run'), { recursive: true });
    const r = await helperIn(L)(['keccak256', 'run/k1/x.hex']);
    eq(r.code, 4); eq(r.json.code, 'run_dir_missing');
  });

  await test('path confinement: a symlink (or junction) that escapes ./run/<run-id>/ is refused', async () => {
    const L = makeLayout('symlink', { chainId: 10, rpcUrl: 'http://127.0.0.1:9/', dataFunctionUrl: `http://127.0.0.1:9${DATA_PATH}`, signerAddress: SIGNER_FIXED });
    const H = helperIn(L);
    const outside = path.join(L.base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.hex'), '0xdeadbeef');
    fs.mkdirSync(L.run('s1'));
    let tried = 0;
    // directory link inside the run-id folder pointing outside
    const dirLink = path.join(L.run('s1'), 'linkdir');
    if (trySymlink(outside, dirLink, 'junction')) {
      tried++;
      const r = await H(['keccak256', 'run/s1/linkdir/secret.hex']);
      eq(r.code, 4, 'dir link'); eq(r.json.code, 'path_symlink');
      ok(!r.stdout.includes(ethers.keccak256('0xdeadbeef')), 'must not hash the outside file');
    }
    // file symlink (needs privilege on Windows)
    const fileLink = path.join(L.run('s1'), 'linkfile.hex');
    if (trySymlink(path.join(outside, 'secret.hex'), fileLink, 'file')) {
      tried++;
      const r = await H(['keccak256', 'run/s1/linkfile.hex']);
      eq(r.code, 4, 'file link'); eq(r.json.code, 'path_symlink');
    }
    // the run-id folder itself is a link to somewhere else
    const idLink = L.run('s2');
    if (trySymlink(outside, idLink, 'junction')) {
      tried++;
      const r = await H(['keccak256', 'run/s2/secret.hex']);
      eq(r.code, 4, 'run-id link'); eq(r.json.code, 'path_symlink');
      const w = await H(['tx', '0x' + '11'.repeat(32), 's2']);
      eq(w.code, 4, 'tx write into a linked run-id'); eq(w.json.code, 'path_symlink');
    }
    for (const p of [dirLink, fileLink, idLink]) removeLink(p);
    if (tried === 0) skip('cannot create symlinks or junctions on this machine');
  });

  // ---- dispatch -----------------------------------------------------------------------------------------
  await test('unknown subcommands and options are refused with no network traffic', async () => {
    const mock = await startMock();
    const L = makeLayout('unknown', mockConfig(mock));
    const H = helperIn(L);
    for (const sub of ['send', 'sendTransaction', 'sign', 'wallet', 'broadcast', 'eth_sendRawTransaction', 'rpc', 'Chain-Id', '__proto__', 'constructor']) {
      const r = await H([sub, '0x00']);
      eq(r.code, 2, sub); eq(r.json.code, 'unknown_subcommand', sub);
    }
    eq((await H([])).json.code, 'usage');
    for (const args of [['--rpc', 'http://evil.example', 'chain-id'], ['chain-id', '--url=http://evil.example'], ['simulate', '--out', 'x'], ['data', 'r1', '--output', '/tmp/x']]) {
      const r = await H(args);
      eq(r.code, 2, args.join(' ')); eq(r.json.code, 'unexpected_option', args.join(' '));
    }
    eq((await H(['chain-id', 'extra'])).json.code, 'usage');
    eq((await H(['nonce'])).json.code, 'usage');
    eq((await H(['nonce', ADDR1, '16', 'extra'])).json.code, 'usage');
    eq(mock.http.length, 0, 'no HTTP request may have been made');
    await mock.close();
  });

  // ---- forbidden methods (the single choke point) --------------------------------------------------------
  await test('the method list is exactly the thirteen read-only methods', async () => {
    eq([...lib.ALLOWED_METHODS], [
      'eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getTransactionReceipt',
      'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_feeHistory', 'eth_gasPrice', 'eth_call', 'eth_getCode',
      'eth_getLogs', 'eth_simulateV1']);
    ok(Object.isFrozen(lib.ALLOWED_METHODS), 'frozen');
  });

  await test('forbidden methods are refused before any socket is opened', async () => {
    const L = makeLayout('rpc-hook', { chainId: 10, rpcUrl: 'https://rpc.invalid/', dataFunctionUrl: `https://data.invalid${DATA_PATH}`, signerAddress: SIGNER_FIXED });
    const savedCwd = process.cwd();
    process.chdir(L.proj);
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; throw new Error('fetch must not be reached'); };
    try {
      const cfg = lib.loadConfigFrom(L.install);
      for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'eth_signTransaction', 'eth_signTypedData_v4',
        'personal_sign', 'personal_unlockAccount', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_accounts', 'eth_estimateGas',
        'debug_traceCall', 'ETH_CALL', 'eth_call ', 'eth_createAccessList', 'eth_sendRawTransactionConditional', 'eth_coinbase', '', 'toString']) {
        let err = null;
        try { await lib.rpcBatch(cfg, [{ method, params: [] }]); } catch (e) { err = e; }
        ok(err && err.code === 'forbidden_method', `${JSON.stringify(method)} must be refused, got ${err && err.code}`);
        eq(err.exit, lib.EXIT.FORBIDDEN);
      }
      // one forbidden method among allowed ones refuses the whole batch
      let err = null;
      try { await lib.rpcBatch(cfg, [{ method: 'eth_blockNumber', params: [] }, { method: 'eth_sendRawTransaction', params: ['0x'] }]); } catch (e) { err = e; }
      ok(err && err.code === 'forbidden_method', 'mixed batch refused');
      // eth_getTransactionCount only at latest, pending or a lowercase hex block number
      for (const tag of ['earliest', 'finalized', 'safe', undefined, '16', '0X10', '0x', 'latest ']) {
        err = null;
        try { await lib.rpcBatch(cfg, [{ method: 'eth_getTransactionCount', params: [ADDR1, tag] }]); } catch (e) { err = e; }
        ok(err && err.code === 'forbidden_method', `tx count at ${tag} refused`);
      }
      err = null;
      try { await lib.rpcBatch(cfg, [{ method: 'eth_getBlockByNumber', params: ['pending', false] }]); } catch (e) { err = e; }
      ok(err && err.code === 'forbidden_method', 'block tag pending refused');
      eq(fetchCalls, 0, 'fetch calls for refused methods');
      // positive control: an allowed method does reach fetch
      globalThis.fetch = async (url, init) => {
        fetchCalls++;
        const body = JSON.parse(init.body);
        eq(init.redirect, 'error', 'redirects are refused');
        eq(init.method, 'POST');
        return new Response(JSON.stringify(body.map((b) => ({ jsonrpc: '2.0', id: b.id, result: b.method === 'eth_chainId' ? '0xa' : '0x5' }))), { status: 200 });
      };
      const out = await lib.rpcBatch(cfg, [{ method: 'eth_blockNumber', params: [] }]);
      eq(out[0].result, '0x5'); eq(fetchCalls, 1, 'one fetch for an allowed batch');
      const past = await lib.rpcBatch(cfg, [{ method: 'eth_getTransactionCount', params: [ADDR1, '0x10'] }]);
      eq(past[0].result, '0x5'); eq(fetchCalls, 2, 'a nonce at a hex block number reaches fetch');
    } finally {
      globalThis.fetch = realFetch;
      process.chdir(savedCwd);
    }
  });

  await test('chain id mismatch from the endpoint is fatal', async () => {
    const mock = await startMock();
    mock.rpc.eth_chainId = () => '0x1';
    const L = makeLayout('chainmismatch', mockConfig(mock));
    const r = await helperIn(L)(['block']);
    eq(r.code, 5); eq(r.json.code, 'chain_mismatch');
    await mock.close();
  });

  // ---- config fail closed -------------------------------------------------------------------------------
  await test('config: missing config fails closed (exit 3, config_missing), for every subcommand shape', async () => {
    const L = makeLayout('noconfig', null);
    const H = helperIn(L);
    for (const args of [['chain-id'], ['keccak256', '0x'], ['encode', 'f()'], ['block']]) {
      const r = await H(args);
      eq(r.code, 3, args.join(' ')); eq(r.json.code, 'config_missing');
    }
  });
  await test('config: an env var cannot point the helper at another config', async () => {
    const good = makeLayout('envgood', { chainId: 10, rpcUrl: 'http://127.0.0.1:9/', dataFunctionUrl: `http://127.0.0.1:9${DATA_PATH}`, signerAddress: SIGNER_FIXED });
    const L = makeLayout('envbad', null);
    const env = {};
    for (const k of ['CHAIN_HELPER_CONFIG', 'CONFIG', 'R3_CHAIN_HELPER_CONFIG', 'CHAIN_HELPER_RPC', 'RPC_URL']) env[k] = path.join(good.install, 'chain-helper.config.json');
    const r = await helperIn(L)(['chain-id'], env);
    eq(r.json.code, 'config_missing');
  });
  const baseCfg = { chainId: 10, rpcUrl: 'https://mainnet.optimism.io', dataFunctionUrl: 'https://deep.seer.pm' + DATA_PATH, signerAddress: SIGNER_FIXED };
  const badConfigs = [
    ['not JSON', { raw: '{ nope' }],
    ['a JSON array', { raw: '[]' }],
    ['chainId 1', { cfg: { ...baseCfg, chainId: 1 } }],
    ['chainId as a string', { cfg: { ...baseCfg, chainId: '10' } }],
    ['missing rpcUrl', { cfg: (() => { const c = { ...baseCfg }; delete c.rpcUrl; return c; })() }],
    ['http rpcUrl on a public host', { cfg: { ...baseCfg, rpcUrl: 'http://mainnet.optimism.io' } }],
    ['rpcUrl with credentials', { cfg: { ...baseCfg, rpcUrl: 'https://user:pw@mainnet.optimism.io' } }],
    ['file: rpcUrl', { cfg: { ...baseCfg, rpcUrl: 'file:///etc/passwd' } }],
    ['unknown key rpcURL', { cfg: { ...baseCfg, rpcURL: 'https://x.example' } }],
    ['unknown key outputPath', { cfg: { ...baseCfg, outputPath: 'x' } }],
    ['zero signer placeholder', { cfg: { ...baseCfg, signerAddress: ethers.ZeroAddress } }],
    ['signer not an address', { cfg: { ...baseCfg, signerAddress: '0x1234' } }],
    ['signer with a bad checksum', { cfg: { ...baseCfg, signerAddress: '0x52908400098527886E0F7030069857D2E4169ee7' } }],
    ['Round 2 data function', { cfg: { ...baseCfg, dataFunctionUrl: 'https://deep.seer.pm/.netlify/functions/get-originality-markets-data' } }],
    ['data function with a query', { cfg: { ...baseCfg, dataFunctionUrl: 'https://deep.seer.pm' + DATA_PATH + '?x=1' } }],
    ['bad override key', { cfg: { ...baseCfg, simulationOverrides: { storage: {} } } }],
    ['override amount not a uint', { cfg: { ...baseCfg, simulationOverrides: { balances: { [ADDR1]: '-5' } } } }],
    ['override entry with an extra key', { cfg: { ...baseCfg, simulationOverrides: { erc20Balances: [{ token: ADDR1, holder: ADDR2, amount: '1', slot: 0, state: {} }] } } }],
    ['retryBaseDelayMs out of range', { cfg: { ...baseCfg, retryBaseDelayMs: 999999 } }],
  ];
  for (const [name, spec] of badConfigs) {
    await test(`config: ${name} fails closed`, async () => {
      const L = makeLayout('badcfg', spec.cfg || null, spec.raw !== undefined ? { rawConfig: spec.raw } : {});
      const r = await helperIn(L)(['chain-id']);
      eq(r.code, 3, r.stdout.slice(0, 200));
      ok(r.json.code === 'config_malformed', `code ${r.json && r.json.code}`);
    });
  }
  await test('config: a helper installed inside the project folder (cwd) refuses to run', async () => {
    const L = makeLayout('inproject', { chainId: 10, rpcUrl: 'http://127.0.0.1:9/', dataFunctionUrl: `http://127.0.0.1:9${DATA_PATH}`, signerAddress: SIGNER_FIXED });
    const inside = path.join(L.proj, 'tools');
    fs.mkdirSync(inside);
    fs.copyFileSync(path.join(L.install, 'chain-helper.cjs'), path.join(inside, 'chain-helper.cjs'));
    fs.copyFileSync(path.join(L.install, 'chain-helper.config.json'), path.join(inside, 'chain-helper.config.json'));
    const r = await runHelperAt(path.join(inside, 'chain-helper.cjs'), L.proj, ['chain-id']);
    eq(r.code, 3); eq(r.json.code, 'config_inside_project');
    const inRun = path.join(L.proj, 'run', 'tools');
    fs.mkdirSync(inRun);
    fs.copyFileSync(path.join(L.install, 'chain-helper.cjs'), path.join(inRun, 'chain-helper.cjs'));
    fs.copyFileSync(path.join(L.install, 'chain-helper.config.json'), path.join(inRun, 'chain-helper.config.json'));
    eq((await runHelperAt(path.join(inRun, 'chain-helper.cjs'), L.proj, ['chain-id'])).json.code, 'config_inside_project');
  });
  await test('config: the shipped example is valid JSON with only known keys and fails closed until the placeholder signer is replaced', async () => {
    const example = JSON.parse(fs.readFileSync(path.join(__dirname, 'chain-helper.config.example.json'), 'utf8'));
    const known = ['chainId', 'rpcUrl', 'dataFunctionUrl', 'signerAddress', 'simulationOverrides', 'requestTimeoutMs', 'retryBaseDelayMs'];
    for (const k of Object.keys(example)) ok(known.includes(k), `example key ${k} is not a config key`);
    eq(example.chainId, 10);
    ok(!('simulationOverrides' in example), 'the example carries no simulation overrides');
    const L = makeLayout('example', null, { rawConfig: fs.readFileSync(path.join(__dirname, 'chain-helper.config.example.json'), 'utf8') });
    const r = await helperIn(L)(['chain-id']);
    eq(r.code, 3); eq(r.json.code, 'config_malformed');
    ok(/placeholder/.test(r.json.error), r.json.error);
    // with a real signer address it loads
    const ready = { ...example, signerAddress: SIGNER_FIXED };
    const L2 = makeLayout('example2', ready);
    const savedCwd = process.cwd();
    process.chdir(L2.proj); // loadConfigFrom refuses a helper folder inside the cwd, so run it from the project folder
    let cfg;
    try { cfg = lib.loadConfigFrom(L2.install); } finally { process.chdir(savedCwd); }
    eq(cfg.signerAddress, ethers.getAddress(SIGNER_FIXED));
  });

  // ---- static properties of the source ------------------------------------------------------------------
  await test('source: no env access, no child process, no key code, no send/sign method names, one write path', async () => {
    const src = fs.readFileSync(HELPER_SRC, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
    for (const bad of [/process\.env/, /child_process/, /eth_send/i, /eth_sign/i, /personal_/, /wallet_/, /keystore/i, /password/i, /privateKey/i,
      /mnemonic/i, /\bWallet\b/, /SigningKey/, /\bSigner\b/, /\.sign\(/, /require\(['"]node:(net|http|https|dgram|worker_threads|vm)['"]\)/, /\beval\(/, /new Function/]) {
      ok(!bad.test(code), `source must not match ${bad}`);
    }
    eq((code.match(/fs\.writeSync\(/g) || []).length, 1, 'one fs.writeSync');
    ok(!/writeFileSync|appendFileSync|createWriteStream|renameSync|copyFileSync/.test(code), 'no other write primitive');
    eq((code.match(/mkdirSync\(/g) || []).length, 1, 'one mkdirSync');
    ok(/__filename/.test(code) && /path\.dirname\(__filename\)/.test(code), 'config path comes from __filename');
    ok(!/process\.argv/.test(code.replace(/main\(process\.argv\.slice\(2\)\)/, '')), 'argv only reaches main()');
  });

  // ---- mock RPC: calls, receipts, blocks, tx, retries ---------------------------------------------------
  await test('call: decodes tuple arrays and nested bytes (aggregate3 shape) and sends exactly the encoded calldata', async () => {
    const mock = await startMock();
    const sigOut = 'function aggregate3(tuple(address,bool,bytes)[]) returns (tuple(bool,bytes)[])';
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const inner1 = coder.encode(['address', 'bytes'], [ADDR1, '0x']);
    const inner2 = coder.encode(['address', 'bytes'], [ADDR2, '0x']);
    const reply = iface(sigOut).encodeFunctionResult('aggregate3', [[[true, inner1], [true, inner2]]]);
    mock.rpc.eth_blockNumber = () => '0x64';
    mock.rpc.eth_call = () => reply;
    const L = makeLayout('call', mockConfig(mock));
    const calls = [[A.mc3, false, '0x1234'], [A.sUSDS, false, '0x5678']];
    const rel = writeRunFile(L, 'c1', 'calls.json', JSON.stringify(calls));
    const r = await helperIn(L)(['call', A.mc3, 'aggregate3((address,bool,bytes)[])((bool,bytes)[])', `@${rel}`]);
    eq(r.code, 0, r.stdout);
    eq(r.json.result, [[[true, inner1], [true, inner2]]]);
    eq(r.json.block, 100);
    const sent = mock.http.flatMap((h) => h.items).find((i) => i.method === 'eth_call');
    eq(sent.params[0].data, iface(sigOut).encodeFunctionData('aggregate3', [calls]));
    eq(sent.params[0].to.toLowerCase(), A.mc3.toLowerCase());
    eq(sent.params[1], 'latest');
    ok(!('from' in sent.params[0]), 'no from on a read');
    await mock.close();
  });
  await test('call: a revert comes back as call_reverted with the decoded reason; empty data is decode_failed', async () => {
    const mock = await startMock();
    const reasonData = new ethers.Interface(['error Error(string)']).encodeErrorResult('Error', ['SUsds/insufficient-allowance']);
    mock.rpc.eth_blockNumber = () => '0x1';
    mock.rpc.eth_call = () => rpcErr(3, 'execution reverted: SUsds/insufficient-allowance', reasonData);
    const L = makeLayout('callrev', mockConfig(mock));
    const r = await helperIn(L)(['call', ADDR1, 'f()(uint256)']);
    eq(r.code, 8); eq(r.json.code, 'call_reverted'); ok(/insufficient-allowance/.test(r.json.error), r.json.error);
    mock.rpc.eth_call = () => '0x';
    const r2 = await helperIn(L)(['call', ADDR1, 'f()(uint256)']);
    eq(r2.code, 1); eq(r2.json.code, 'decode_failed');
    await mock.close();
  });
  await test('call: raw is omitted when large and an oversized decoded answer is output_too_large', async () => {
    const mock = await startMock();
    mock.rpc.eth_blockNumber = () => '0x1';
    mock.rpc.eth_call = () => ethers.AbiCoder.defaultAbiCoder().encode(['bytes'], ['0x' + 'ab'.repeat(3000)]);
    const L = makeLayout('calllarge', mockConfig(mock));
    const r = await helperIn(L)(['call', ADDR1, 'f()(bytes)']);
    eq(r.code, 0); ok(!('raw' in r.json), 'raw omitted'); eq(r.json.raw_bytes, 3072);
    mock.rpc.eth_call = () => ethers.AbiCoder.defaultAbiCoder().encode(['bytes'], ['0x' + 'ab'.repeat(20000)]);
    const r2 = await helperIn(L)(['call', ADDR1, 'f()(bytes)']);
    eq(r2.code, 7); eq(r2.json.code, 'output_too_large');
    await mock.close();
  });

  // ---- multicall (extension) ----------------------------------------------------------------------------
  await test('multicall (extension): ONE aggregate3 eth_call to Multicall3 with allowFailure false, each result decoded by its own returns (prefix of (address,bytes) included)', async () => {
    const mock = await startMock();
    const mc = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)', 'function getBlockNumber() view returns (uint256)']);
    const wo = new ethers.Interface(['function wrappedOutcome(uint256) view returns (address,bytes)']);
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const seen = [];
    mock.rpc.eth_call = (params) => {
      seen.push(params);
      const calls = mc.decodeFunctionData('aggregate3', params[0].data)[0];
      return mc.encodeFunctionResult('aggregate3', [calls.map((c) => {
        if (c.callData === mc.encodeFunctionData('getBlockNumber')) return [true, coder.encode(['uint256'], [4242n])];
        if (!c.callData.startsWith(wo.getFunction('wrappedOutcome').selector)) return [true, coder.encode(['uint256'], [77n])];
        const [k] = wo.decodeFunctionData('wrappedOutcome', c.callData);
        return [true, coder.encode(['address', 'bytes'], [ethers.getAddress('0x' + (BigInt(c.target) + k).toString(16).padStart(40, '0')), '0x' + 'ab'.repeat(64)])];
      })]);
    };
    const L = makeLayout('multicall', mockConfig(mock));
    const entries = [];
    for (const target of [ADDR1, ADDR2]) for (let k = 0; k < 3; k++) entries.push({ to: target, signature: 'wrappedOutcome(uint256)(address)', args: [String(k)] });
    entries.push({ to: A.sUSDS, signature: 'transfer(address,uint256)', args: [ADDR1, '5'] }); // no declared returns: runs, prints []
    entries.push({ to: A.sUSDS, signature: 'f((address,uint256)[],bool)(uint256)', args: [[[ADDR1, 7]], true] }); // tuple array given as a JSON value
    const rel = writeRunFile(L, 'm1', 'reads.json', JSON.stringify(entries));
    const r = await helperIn(L)(['multicall', rel]);
    eq(r.code, 0, r.stdout);
    eq(r.json.block, 4242); eq(r.json.count, 8);
    const addrPlus = (a, k) => ethers.getAddress('0x' + (BigInt(a) + BigInt(k)).toString(16).padStart(40, '0'));
    eq(r.json.results.slice(0, 6), [ADDR1, ADDR1, ADDR1, ADDR2, ADDR2, ADDR2].map((a, i) => [addrPlus(a, i % 3)]));
    eq(r.json.results[6], []); eq(r.json.results[7], ['77']);
    eq(seen.length, 1, 'exactly one eth_call');
    const sent = mc.decodeFunctionData('aggregate3', seen[0][0].data)[0];
    eq(seen[0][0].to.toLowerCase(), A.mc3.toLowerCase()); eq(seen[0][1], 'latest'); ok(!('from' in seen[0][0]), 'no from on a read');
    eq(sent.length, 9, 'eight reads plus the trailing getBlockNumber');
    ok(sent.every((c) => c.allowFailure === false), 'allowFailure is always false');
    eq(sent[0].callData, wo.encodeFunctionData('wrappedOutcome', [0]));
    eq(sent[7].callData, new ethers.Interface(['function f((address,uint256)[],bool)']).encodeFunctionData('f', [[[ADDR1, 7n]], true]));
    eq(sent[8].callData, mc.encodeFunctionData('getBlockNumber'));
    eq(methodsOf(mock).filter((m) => m !== 'eth_chainId'), ['eth_call']);
    await mock.close();
  });
  await test('multicall (extension): 294 reads decode to a compact page that fits one output', async () => {
    const mock = await startMock();
    const mc = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
    const coder = ethers.AbiCoder.defaultAbiCoder();
    mock.rpc.eth_call = (params) => {
      const calls = mc.decodeFunctionData('aggregate3', params[0].data)[0];
      return mc.encodeFunctionResult('aggregate3', [calls.map((c, i) => [true, i === calls.length - 1 ? coder.encode(['uint256'], [9n]) : coder.encode(['address', 'bytes'], [ADDR1, '0x' + 'cd'.repeat(32)])])]);
    };
    const L = makeLayout('multicall294', mockConfig(mock));
    const entries = Array.from({ length: 294 }, (_, i) => ({ to: ADDR2, signature: 'wrappedOutcome(uint256)(address)', args: [String(i % 3)] }));
    const r = await helperIn(L)(['multicall', writeRunFile(L, 'm2', 'reads.json', JSON.stringify(entries))]);
    eq(r.code, 0, r.stdout.slice(0, 200)); eq(r.json.results.length, 294); ok(r.stdout.length < 20000, `page is ${r.stdout.length} chars`);
    await mock.close();
  });
  await test('multicall (extension): a failed inner read fails the whole call (index named when known); empty return data is decode_failed with the index', async () => {
    const mock = await startMock();
    const mc = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const L = makeLayout('multicallbad', mockConfig(mock));
    const rel = writeRunFile(L, 'm3', 'reads.json', JSON.stringify([{ to: ADDR1, signature: 'a()(uint256)' }, { to: ADDR2, signature: 'b()(uint256)' }]));
    // Multicall3 itself reverts when an allowFailure=false read fails
    mock.rpc.eth_call = () => rpcErr(3, 'execution reverted: Multicall3: call failed', new ethers.Interface(['error Error(string)']).encodeErrorResult('Error', ['Multicall3: call failed']));
    const r = await helperIn(L)(['multicall', rel]);
    eq(r.code, 8); eq(r.json.code, 'call_reverted'); ok(/call failed/.test(r.json.error), r.json.error);
    // a target with no code answers success with empty data
    mock.rpc.eth_call = () => mc.encodeFunctionResult('aggregate3', [[[true, coder.encode(['uint256'], [1n])], [true, '0x'], [true, coder.encode(['uint256'], [3n])]]]);
    const r2 = await helperIn(L)(['multicall', rel]);
    eq(r2.code, 1); eq(r2.json.code, 'decode_failed'); eq(r2.json.index, 1); ok(r2.json.error.includes(ADDR2), r2.json.error);
    await mock.close();
  });
  await test('multicall (extension): bad entries, extra keys, arity, oversize lists and unconfined files are refused before any network traffic', async () => {
    const mock = await startMock();
    const L = makeLayout('multicallref', mockConfig(mock));
    const H = helperIn(L);
    const put = (name, v) => writeRunFile(L, 'm4', name, typeof v === 'string' ? v : JSON.stringify(v));
    const good = { to: ADDR1, signature: 'a()(uint256)' };
    for (const [name, content, why] of [
      ['notjson.json', 'nope', 'not JSON'],
      ['empty.json', [], 'empty list'],
      ['obj.json', { to: ADDR1 }, 'not a list'],
      ['extra.json', [{ ...good, from: ADDR2 }], 'unexpected key'],
      ['noaddr.json', [{ to: 'nope', signature: 'a()(uint256)' }], 'bad address'],
      ['arity.json', [{ to: ADDR1, signature: 'a(uint256)(uint256)', args: [] }], 'wrong arity'],
      ['badsig.json', [{ to: ADDR1, signature: 'not a signature' }], 'bad signature'],
      ['bigint.json', '[{"to":"' + ADDR1 + '","signature":"a(uint256)(uint256)","args":[1000000000000000000]}]', 'unsafe JSON number'],
      ['many.json', Array.from({ length: 501 }, () => good), 'over the cap'],
    ]) {
      const r = await H(['multicall', put(name, content)]);
      eq(r.code, 2, `${why}: ${r.stdout.slice(0, 200)}`); eq(r.json.code, 'bad_argument', why);
    }
    for (const bad of ['../x.json', '/etc/passwd', '\\\\host\\share\\x.json', 'C:\\x.json', 'run/m4/../../x.json']) {
      const r = await H(['multicall', bad]);
      eq(r.code, 4, `${bad}: ${r.stdout.slice(0, 200)}`);
    }
    eq(mock.http.length, 0, 'no network traffic for refusals');
    await mock.close();
  });

  await test('receipt: logs are counted, never printed; not found is found:false', async () => {
    const mock = await startMock();
    const h = '0x' + 'ab'.repeat(32);
    mock.rpc.eth_getTransactionReceipt = () => ({
      transactionHash: h, status: '0x1', blockNumber: '0x10', transactionIndex: '0x2', from: ADDR1, to: ADDR2, contractAddress: null,
      type: '0x2', gasUsed: '0x4d2', effectiveGasPrice: '0x3b9aca00', l1Fee: '0x5f5e100',
      logs: Array.from({ length: 500 }, () => ({ address: ADDR1, topics: ['0x' + '00'.repeat(32)], data: '0x' + '11'.repeat(96) })),
    });
    const L = makeLayout('receipt', mockConfig(mock));
    const r = await helperIn(L)(['receipt', h]);
    eq(r.code, 0); eq(r.json.logs_count, 500); eq(r.json.status, '0x1'); eq(r.json.success, true); eq(r.json.gas_used, '1234'); eq(r.json.l1_fee, '100000000');
    ok(r.stdout.length < 1500, `receipt output ${r.stdout.length} chars`);
    mock.rpc.eth_getTransactionReceipt = () => null;
    const r2 = await helperIn(L)(['receipt', h]);
    eq(r2.code, 0); eq(r2.json.found, false);
    eq((await helperIn(L)(['receipt', '0x1234'])).json.code, 'bad_argument');
    await mock.close();
  });

  await test('tx: writes only run/<run-id>/tx-<hash>.input with the mined input and prints its keccak256', async () => {
    const mock = await startMock();
    const h = '0x' + 'cd'.repeat(32);
    const input = '0x' + crypto.randomBytes(2500).toString('hex');
    mock.rpc.eth_getTransactionByHash = () => ({ hash: h, from: ADDR1, to: ADDR2, nonce: '0x2a', value: '0xde0b6b3a7640000', blockNumber: '0x99', input });
    const L = makeLayout('tx', mockConfig(mock));
    fs.mkdirSync(L.run('t9'));
    const r = await helperIn(L)(['tx', h.toUpperCase().replace('0X', '0x'), 't9']);
    eq(r.code, 0, r.stdout);
    eq(r.json.from, ADDR1); eq(r.json.nonce, 42); eq(r.json.to, ADDR2); eq(r.json.value, '1000000000000000000');
    eq(r.json.input_bytes, 2500); eq(r.json.input_keccak256, ethers.keccak256(input)); eq(r.json.mined, true);
    const file = path.join(L.run('t9'), `tx-${h}.input`);
    eq(fs.readFileSync(file, 'utf8'), input, 'file holds the mined input');
    eq(fs.readdirSync(L.run('t9')), [`tx-${h}.input`], 'nothing else written');
    // the file is what keccak256 hashes later
    const k = await helperIn(L)(['keccak256', `run/t9/tx-${h}.input`]);
    eq(k.json.keccak256, ethers.keccak256(input));
    // pending: no file
    const h2 = '0x' + 'ef'.repeat(32);
    mock.rpc.eth_getTransactionByHash = () => ({ hash: h2, from: ADDR1, to: ADDR2, nonce: '0x1', value: '0x0', blockNumber: null, input: '0x1234' });
    const p = await helperIn(L)(['tx', h2, 't9']);
    eq(p.json.mined, false); eq(p.json.input_keccak256, null);
    ok(!fs.existsSync(path.join(L.run('t9'), `tx-${h2}.input`)), 'no file for a pending tx');
    // unknown
    mock.rpc.eth_getTransactionByHash = () => null;
    eq((await helperIn(L)(['tx', h2, 't9'])).json.found, false);
    // bad inputs make no request
    const before = mock.http.length;
    eq((await helperIn(L)(['tx', 'nothex', 't9'])).json.code, 'bad_argument');
    eq((await helperIn(L)(['tx', h, '..'])).json.code, 'bad_run_id');
    eq((await helperIn(L)(['tx', h, 'a/b'])).json.code, 'bad_run_id');
    eq(mock.http.length, before, 'no request for refused arguments');
    await mock.close();
  });

  await test('block <n> <address>: lists that address\'s transactions with input hashes, never the inputs', async () => {
    const mock = await startMock();
    const inp = '0x' + 'aa'.repeat(100);
    mock.rpc.eth_getBlockByNumber = (p) => ({
      number: '0x10', hash: '0x' + '01'.repeat(32), parentHash: '0x' + '02'.repeat(32), timestamp: '0x65', gasLimit: '0x2625a00', gasUsed: '0x1', baseFeePerGas: '0x7',
      transactions: [
        { hash: '0x' + '0a'.repeat(32), from: ADDR2, to: ADDR1, nonce: '0x1', value: '0x0', input: '0x' },
        { hash: '0x' + '0b'.repeat(32), from: ADDR1.toUpperCase().replace('0X', '0x'), to: ADDR2, nonce: '0x7', value: '0x5', input: inp },
      ],
      __params: p,
    });
    const L = makeLayout('block', mockConfig(mock));
    const r = await helperIn(L)(['block', '16', ADDR1]);
    eq(r.code, 0, r.stdout);
    eq(r.json.number, 16); eq(r.json.tx_count, 2); eq(r.json.txs_from_total, 1);
    eq(r.json.txs_from[0].nonce, 7); eq(r.json.txs_from[0].input_keccak256, ethers.keccak256(inp)); eq(r.json.txs_from[0].input_bytes, 100);
    ok(!r.stdout.includes(inp), 'input not printed');
    const sent = mock.http.flatMap((h) => h.items).find((i) => i.method === 'eth_getBlockByNumber');
    eq(sent.params, ['0x10', true]);
    await mock.close();
  });

  await test('transport: 429 is retried with backoff and then succeeds; a persistent 429 is an error after four attempts', async () => {
    const mock = await startMock();
    mock.rpc.eth_getBalance = () => '0x10';
    const L = makeLayout('retry', mockConfig(mock));
    mock.fail429 = 2;
    const r = await helperIn(L)(['balance', ADDR1]);
    eq(r.code, 0, r.stdout); eq(r.json.wei, '16');
    eq(mock.http.length, 3, 'two 429s then one success');
    mock.http.length = 0;
    mock.fail429 = 99;
    const r2 = await helperIn(L)(['balance', ADDR1]);
    eq(r2.code, 5); eq(r2.json.code, 'rpc_rate_limited'); eq(mock.http.length, 4, 'four attempts, then stop');
    await mock.close();
  });

  await test('transport: a rate limit reported as a JSON-RPC error inside HTTP 200 is retried too', async () => {
    const mock = await startMock();
    let n = 0;
    mock.rpc.eth_getBalance = () => (++n <= 2 ? rpcErr(-32005, 'rate limit exceeded') : '0x20');
    const L = makeLayout('retry-rpc', mockConfig(mock));
    const r = await helperIn(L)(['balance', ADDR1]);
    eq(r.code, 0, r.stdout); eq(r.json.wei, '32'); eq(mock.http.length, 3);
    await mock.close();
  });

  await test('transport: "no backend is currently healthy" (-32011) is retried with back-off, and a persistent one is rpc_rate_limited', async () => {
    const mock = await startMock();
    let n = 0;
    mock.rpc.eth_getBalance = () => (++n <= 2 ? rpcErr(-32011, 'no backend is currently healthy to serve traffic') : '0x21');
    const L = makeLayout('retry-32011', mockConfig(mock));
    const r = await helperIn(L)(['balance', ADDR1]);
    eq(r.code, 0, r.stdout); eq(r.json.wei, '33'); eq(mock.http.length, 3);
    mock.rpc.eth_getBalance = () => rpcErr(-32011, 'no backend is currently healthy to serve traffic');
    const before = mock.http.length;
    const r2 = await helperIn(L)(['balance', ADDR1]);
    eq(r2.code, 5); eq(r2.json.code, 'rpc_rate_limited'); ok(/no backend/.test(r2.json.error), r2.json.error); eq(mock.http.length - before, 4, 'one try plus three retries');
    await mock.close();
  });

  await test('slot0: an address that is not a pool is decode_failed, not a crash', async () => {
    const mock = await startMock();
    const mc = new ethers.Interface(['function aggregate3((address,bool,bytes)[]) payable returns ((bool,bytes)[])']);
    mock.rpc.eth_call = () => mc.encodeFunctionResult('aggregate3', [Array.from({ length: 6 }, () => [true, '0x'])]);
    const L = makeLayout('slot0-eoa', mockConfig(mock));
    const r = await helperIn(L)(['slot0', ADDR1]);
    eq(r.code, 1); eq(r.json.code, 'decode_failed');
    mock.rpc.eth_call = () => rpcErr(3, 'execution reverted');
    eq((await helperIn(L)(['slot0', ADDR1])).json.code, 'call_reverted');
    await mock.close();
  });

  await test('transport: batches never exceed ten items and an endpoint that refuses batches is served one request at a time', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = (p) => (p[1] === 'pending' ? '0x5' : '0x4');
    const L = makeLayout('batch', mockConfig(mock));
    const r = await helperIn(L)(['nonce', ADDR1]);
    eq(r.json.latest, 4); eq(r.json.pending, 5);
    for (const h of mock.http) ok(h.items.length <= 10, `batch of ${h.items.length}`);
    eq(mock.http.length, 1, 'one HTTP request carries chainId + both reads');
    mock.http.length = 0;
    mock.batchMode = 'refuse';
    const r2 = await helperIn(L)(['nonce', ADDR1]);
    eq(r2.code, 0, r2.stdout); eq(r2.json.latest, 4);
    ok(mock.http.length >= 4 && mock.http.every((h) => !h.isBatch || h.items.length === 3), 'fell back to single requests');
    await mock.close();
  });

  await test('nonce <address> <block>: one eth_getTransactionCount at that hex block, decimal or 0x accepted; latest, pending and junk refused before any request; a node without that state is state_unavailable (exit 5), any other RPC error stays rpc_error', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = (p) => (p[1] === '0x9c0e3d5' ? '0x55e' : p[1] === '0x9c0e3d6' ? '0x55f' : '0x1');
    const L = makeLayout('nonce-at', mockConfig(mock));
    for (const [arg, want] of [['163636181', 0x55e], ['0x9c0e3d6', 0x55f], ['0x9C0E3D6', 0x55f]]) {
      mock.http.length = 0;
      const r = await helperIn(L)(['nonce', ADDR1, arg]);
      eq(r.code, 0, r.stdout); eq(r.json, { address: r.json.address, block: Number(BigInt(arg)), nonce: want });
      const items = mock.http.flatMap((h) => h.items).filter((i) => i.method === 'eth_getTransactionCount');
      eq(items.length, 1, 'one nonce read'); eq(items[0].params[1], '0x' + BigInt(arg).toString(16));
    }
    mock.http.length = 0;
    for (const arg of ['latest', 'pending', 'earliest', '-1', '1.5', '0x', 'abc']) {
      const r = await helperIn(L)(['nonce', ADDR1, arg]);
      eq(r.code, 2, `${arg}: ${r.stdout}`); eq(r.json.code, 'bad_argument', arg);
    }
    eq(mock.http.length, 0, 'no request for a refused block');
    for (const msg of ['missing trie node 6d5a (path ) state 0x6d5a is not available', 'historical state 0xab is not available', 'project ID does not have access to archive state']) {
      mock.rpc.eth_getTransactionCount = () => ({ __error: { code: -32000, message: msg } });
      const r = await helperIn(L)(['nonce', ADDR1, '16']);
      eq(r.code, 5, r.stdout); eq(r.json.code, 'state_unavailable', msg);
    }
    mock.rpc.eth_getTransactionCount = () => ({ __error: { code: -32000, message: 'header not found' } });
    const r = await helperIn(L)(['nonce', ADDR1, '16']);
    eq(r.code, 5, r.stdout); eq(r.json.code, 'rpc_error', 'header not found stays rpc_error, re-run as transient');
    await mock.close();
  });

  await test('transport: an unreachable endpoint is rpc_unreachable (exit 5), after bounded retries', async () => {
    const mock = await startMock();
    const cfg = mockConfig(mock);
    await mock.close();
    const L = makeLayout('unreach', cfg);
    const r = await helperIn(L)(['chain-id']);
    eq(r.code, 5); eq(r.json.code, 'rpc_unreachable');
  });

  // ---- simulate: request shape + result shape -----------------------------------------------------------
  const simTxs = [
    { to: A.sUSDS, data: new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [A.router, 100n * 10n ** 18n]), value: '0' },
    { to: A.router, data: iface('function splitPosition(address,address,uint256)').encodeFunctionData('splitPosition', [A.sUSDS, A.parent, 100n * 10n ** 18n]) },
    { to: A.bundleA, data: '0x', value: '0x10' },
  ];
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const slotBal = (holder, slot) => ethers.keccak256(abiCoder.encode(['address', 'uint256'], [holder, slot]));
  const slotAllow = (owner, spender, slot) => ethers.keccak256(abiCoder.encode(['address', 'bytes32'], [spender, ethers.keccak256(abiCoder.encode(['address', 'uint256'], [owner, slot]))]));
  const w32 = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);

  await test('simulate: ONE eth_simulateV1 request, one blockStateCalls entry per transaction in order, from pinned, 2^24 gas cap', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = (p) => { eq(p[1], 'pending'); eq(p[0].toLowerCase(), SIGNER_FIXED); return '0x7'; };
    mock.rpc.eth_simulateV1 = (p) => p[0].blockStateCalls.map((_, i) => ({
      number: '0x1', calls: [i === 2
        ? { status: '0x0', gasUsed: '0x5208', returnData: '0x', error: { code: 3, message: 'execution reverted: ERC20: transfer amount exceeds balance', data: new ethers.Interface(['error Error(string)']).encodeErrorResult('Error', ['ERC20: transfer amount exceeds balance']) } }
        : { status: '0x1', gasUsed: i === 1 ? '0x1000000' : '0x1388', returnData: '0x' }],
    }));
    const L = makeLayout('sim-shape', mockConfig(mock));
    const rel = writeRunFile(L, 'sim1', 'txs.json', JSON.stringify(simTxs));
    const r = await helperIn(L)(['simulate', rel]);
    eq(r.code, 0, r.stdout);
    const sims = mock.http.flatMap((h) => h.items).filter((i) => i.method === 'eth_simulateV1');
    eq(sims.length, 1, 'exactly one eth_simulateV1');
    const req = sims[0].params[0];
    eq(sims[0].params[1], 'latest');
    eq(req.blockStateCalls.length, 3, 'one entry per tx');
    req.blockStateCalls.forEach((b, i) => {
      eq(b.calls.length, 1, `entry ${i} has one call`);
      eq(b.calls[0].from.toLowerCase(), SIGNER_FIXED, 'from is the pinned signer');
      eq(b.calls[0].to.toLowerCase(), simTxs[i].to.toLowerCase(), `to ${i}`);
      eq(b.calls[0].data, simTxs[i].data, `data ${i}`);
      eq(b.calls[0].gas, '0x1000000', 'per-call gas cap is 2^24');
      ok(!('stateOverrides' in b), 'no overrides without config overrides');
    });
    eq(req.blockStateCalls[2].calls[0].value, '0x10'); eq(req.blockStateCalls[0].calls[0].value, '0x0');
    eq(req.validation, false);
    const methods = methodsOf(mock);
    eq(methods.sort(), ['eth_chainId', 'eth_getTransactionCount', 'eth_simulateV1'].sort(), 'only chainId, simulateV1 and the pending nonce are requested');
    // result shape
    // result shape (K2h: rows are arrays under `columns`; this mock returns no maxUsedGas, so gas_limit is the gasUsed x 1.5 fallback)
    eq(r.json.from, ethers.getAddress(SIGNER_FIXED)); eq(r.json.count, 3); eq(r.json.pending_nonce, 7); eq(r.json.all_success, false);
    eq(r.json.input, 'flat'); eq(r.json.entries, 3);
    eq(r.json.columns, ['index', 'group', 'status', 'gasUsed', 'maxUsedGas', 'gas_limit']);
    eq(r.json.calls.map((c) => c[2]), ['0x1', '0x1', '0x0']);
    eq(r.json.calls.map((c) => c[0]), [0, 1, 2]); eq(r.json.calls.map((c) => c[1]), [0, 1, 2], 'a flat list is one group per transaction');
    eq(r.json.calls.map((c) => c[3]), [5000, 16777216, 21000], 'gasUsed, decimal');
    eq(r.json.calls.map((c) => c[4]), [null, null, null], 'no maxUsedGas from this node');
    eq(r.json.calls[0][5], 7500, 'no maxUsedGas: ceil(gasUsed x 1.5)');
    eq(r.json.calls[1][5], 16777216, 'clamped at 2^24'); eq(r.json.clamped_count, 1); eq(r.json.no_max_used_gas_count, 3);
    ok(/transfer amount exceeds balance/.test(r.json.failures[0].revert_reason), 'revert reason decoded');
    ok(!('overrides_active' in r.json));
    eq(r.json.failed_count, 1); eq(r.json.first_failed_index, 2); eq(r.json.first_failed_group, 2);
    eq(r.json.failures.length, 1); eq(r.json.failures[0].index, 2); eq(r.json.failures[0].to, ethers.getAddress(A.bundleA), 'a failure names its target');
    await mock.close();
  });

  await test('simulate: a 256-transaction sequence (the node cap) prints one compact page, failures keep error text for the first 8 only; 257 is refused before any network traffic', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x3';
    let mode = 'ok';
    mock.rpc.eth_simulateV1 = (p) => p[0].blockStateCalls.map((_, i) => ({
      number: '0x1', calls: [mode === 'ok' || (mode === 'late' && i < 200)
        ? { status: '0x1', gasUsed: '0x11a2c8', returnData: '0x' }
        : { status: '0x0', gasUsed: '0x5208', returnData: '0x', error: { code: 3, message: 'execution reverted: ' + 'x'.repeat(190), data: new ethers.Interface(['error Error(string)']).encodeErrorResult('Error', ['ERC20: transfer amount exceeds balance ' + 'y'.repeat(300)]) } }],
    }));
    const L = makeLayout('sim256', mockConfig(mock));
    const tx = { to: ADDR1, data: '0x' + 'ab'.repeat(36), value: '0' };
    const rel = writeRunFile(L, 'sim256', 'txs.json', JSON.stringify(Array.from({ length: 256 }, () => tx)));
    const ok256 = await helperIn(L)(['simulate', rel]);
    eq(ok256.code, 0, ok256.stdout.slice(0, 200)); eq(ok256.json.count, 256); eq(ok256.json.all_success, true); eq(ok256.json.failed_count, 0); eq(ok256.json.first_failed_index, null);
    ok(ok256.stdout.length < 24000, 'compact page: ' + ok256.stdout.length + ' chars');
    eq(ok256.json.calls[0].length, 6, 'a row is [index, group, status, gasUsed, maxUsedGas, gas_limit]'); ok(!('failures' in ok256.json), 'no failure list when all pass');
    mode = 'late';
    const late = await helperIn(L)(['simulate', rel]);
    eq(late.code, 0); eq(late.json.all_success, false); eq(late.json.failed_count, 56); eq(late.json.first_failed_index, 200);
    eq(late.json.failures.length, 8, 'error text for the first eight failures only'); eq(late.json.failures.map((f) => f.index), [200, 201, 202, 203, 204, 205, 206, 207]);
    ok(/transfer amount exceeds balance/.test(late.json.failures[0].revert_reason) && late.json.failures[0].to === ethers.getAddress(ADDR1));
    ok(/first 8 failures/.test(late.json.error_detail_note));
    mode = 'allfail';
    const bad = await helperIn(L)(['simulate', rel]);
    eq(bad.code, 0); eq(bad.json.failed_count, 256); eq(bad.json.first_failed_index, 0); ok(bad.stdout.length < 28000, 'worst case still one page: ' + bad.stdout.length);
    const before = mock.http.length;
    const rel257 = writeRunFile(L, 'sim256', 'txs257.json', JSON.stringify(Array.from({ length: 257 }, () => tx)));
    const r257 = await helperIn(L)(['simulate', rel257]);
    eq(r257.code, 2); eq(r257.json.code, 'bad_argument'); ok(/256/.test(r257.json.error)); eq(mock.http.length, before, 'refused before any request');
    await mock.close();
  });

  await test('simulate: config-only overrides ride on the FIRST entry as stateDiff (never state), with the right slots', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x0';
    mock.rpc.eth_simulateV1 = (p) => p[0].blockStateCalls.map(() => ({ calls: [{ status: '0x1', gasUsed: '0x5208' }] }));
    const cfg = mockConfig(mock, { simulationOverrides: {
      balances: { [SIGNER_FIXED]: '0x56bc75e2d63100000' },
      erc20Balances: [{ token: A.sUSDS, holder: SIGNER_FIXED, amount: '1000000000000000000000', slot: 2 }],
      erc20Allowances: [{ token: A.sUSDS, owner: SIGNER_FIXED, spender: A.router, amount: 'max', slot: 3 }, { token: A.bundleA, owner: SIGNER_FIXED, spender: A.router, amount: '5', slot: 4 }],
    } });
    const L = makeLayout('sim-ov', cfg);
    const rel = writeRunFile(L, 'sim2', 'txs.json', JSON.stringify(simTxs.slice(0, 2)));
    const r = await helperIn(L)(['simulate', rel]);
    eq(r.code, 0, r.stdout); eq(r.json.overrides_active, true); ok(/never gate a real send/.test(r.json.warning));
    const req = mock.http.flatMap((h) => h.items).find((i) => i.method === 'eth_simulateV1').params[0];
    ok(!('stateOverrides' in req.blockStateCalls[1]), 'only the first entry carries overrides');
    const so = req.blockStateCalls[0].stateOverrides;
    const get = (a) => so[Object.keys(so).find((k) => k.toLowerCase() === a.toLowerCase())];
    eq(get(SIGNER_FIXED), { balance: '0x56bc75e2d63100000' });
    eq(get(A.sUSDS).stateDiff, {
      [slotBal(SIGNER_FIXED, 2)]: w32(1000n * 10n ** 18n),
      [slotAllow(SIGNER_FIXED, A.router, 3)]: w32(2n ** 256n - 1n),
    });
    eq(get(A.bundleA).stateDiff, { [slotAllow(SIGNER_FIXED, A.router, 4)]: w32(5) });
    ok(!JSON.stringify(so).includes('"state"'), 'never a full "state" replacement');
    await mock.close();
  });

  await test('simulate: overrides cannot come from argv or the environment', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x0';
    mock.rpc.eth_simulateV1 = (p) => p[0].blockStateCalls.map(() => ({ calls: [{ status: '0x1', gasUsed: '0x1' }] }));
    const L = makeLayout('sim-noov', mockConfig(mock));
    const rel = writeRunFile(L, 'sim3', 'txs.json', JSON.stringify(simTxs.slice(0, 1)));
    const H = helperIn(L);
    eq((await H(['simulate', rel, '--overrides', '{}'])).json.code, 'unexpected_option');
    eq((await H(['simulate', rel, '{}'])).json.code, 'usage');
    const bad = writeRunFile(L, 'sim3', 'bad.json', JSON.stringify([{ to: A.router, data: '0x', value: '0', stateOverrides: {} }]));
    eq((await H(['simulate', bad])).json.code, 'bad_argument');
    const bad2 = writeRunFile(L, 'sim3', 'bad2.json', JSON.stringify([{ to: A.router, data: '0x', from: ADDR1 }]));
    ok(/pinned/.test((await H(['simulate', bad2])).json.error), 'from in the file is refused');
    const r = await H(['simulate', rel], { SIMULATION_OVERRIDES: '{"balances":{}}', CHAIN_HELPER_OVERRIDES: '{}' });
    eq(r.code, 0);
    const req = mock.http.flatMap((h) => h.items).find((i) => i.method === 'eth_simulateV1').params[0];
    ok(!('stateOverrides' in req.blockStateCalls[0]), 'no overrides');
    await mock.close();
  });

  await test('simulate: an endpoint without eth_simulateV1 is simulate_unsupported (no fallback), and file confinement applies', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x0';
    const L = makeLayout('sim-unsup', mockConfig(mock));
    const rel = writeRunFile(L, 'sim4', 'txs.json', JSON.stringify(simTxs.slice(0, 1)));
    const r = await helperIn(L)(['simulate', rel]);
    eq(r.code, 5); eq(r.json.code, 'simulate_unsupported');
    ok(!methodsOf(mock).some((m) => m === 'eth_estimateGas' || m === 'eth_call'), 'no fallback to estimateGas or eth_call');
    mock.http.length = 0;
    for (const [arg, code] of [['../txs.json', 'path_traversal'], ['/abs/txs.json', 'path_absolute'], ['C:\\txs.json', 'path_drive'], ['\\\\h\\s\\t.json', 'path_unc'], ['run/sim4/missing.json', 'path_not_found']]) {
      const x = await helperIn(L)(['simulate', arg]);
      eq(x.code, 4, arg); eq(x.json.code, code, arg);
    }
    eq(mock.http.length, 0, 'refused paths cause no request');
    const huge = writeRunFile(L, 'sim4', 'huge.json', JSON.stringify(Array.from({ length: 257 }, () => ({ to: A.router, data: '0x' }))));
    eq((await helperIn(L)(['simulate', huge])).json.code, 'bad_argument');
    const unsafe = writeRunFile(L, 'sim4', 'unsafe.json', '[{"to":"' + A.router + '","data":"0x","value":9007199254740993}]');
    eq((await helperIn(L)(['simulate', unsafe])).json.code, 'bad_argument');
    await mock.close();
  });

  // ---- simulate, grouped form (K2h) ---------------------------------------------------------------------
  const okRes = (used, max) => ({ status: '0x1', gasUsed: '0x' + used.toString(16), maxUsedGas: '0x' + max.toString(16), returnData: '0x' });
  const failRes = (reason, gas = 0x5208) => ({
    status: '0x0', gasUsed: '0x' + gas.toString(16), maxUsedGas: '0x' + gas.toString(16), returnData: '0x',
    error: { code: 3, message: 'execution reverted: ' + 'x'.repeat(190), data: new ethers.Interface(['error Error(string)']).encodeErrorResult('Error', [reason]) },
  });
  const answer = (p, f) => p[0].blockStateCalls.map((b, g) => ({ number: '0x1', calls: b.calls.map((c, k) => f(g, k, c)) }));
  const sendTx = (i) => ({ to: i % 2 ? A.router : A.sUSDS, data: '0x' + (i % 256).toString(16).padStart(2, '0').repeat(36), value: '0' });
  const groupsOf = (sizes) => { let n = 0; return sizes.map((s) => ({ calls: Array.from({ length: s }, () => sendTx(n++)) })); };
  const simReqs = (mock) => mock.http.flatMap((h) => h.items).filter((i) => i.method === 'eth_simulateV1');
  const limitRule = (m) => Number((BigInt(m) * 12n + 9n) / 10n); // ceil(maxUsedGas x 1.2)

  await test('simulate (groups): one blockStateCalls entry per group, its calls in order, no per-call gas; rows carry group, gasUsed, maxUsedGas and gas_limit = ceil(maxUsedGas x 1.2)', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = (p) => { eq(p[1], 'pending'); return '0x9'; };
    const table = [[609738, 762172], [4509748, 5637184], [51065, 63831], [1000, null], [609738, 762172], [4509748, 5637184]]; // [gasUsed, maxUsedGas]; null = the RPC returned none
    let n = 0;
    mock.rpc.eth_simulateV1 = (p) => answer(p, () => { const [u, m] = table[n++]; return m === null ? { status: '0x1', gasUsed: '0x' + u.toString(16), returnData: '0x' } : okRes(u, m); });
    const L = makeLayout('sim-groups', mockConfig(mock));
    const plan = groupsOf([2, 1, 3]);
    const rel = writeRunFile(L, 'sg1', 'plan.json', JSON.stringify(plan));
    const r = await helperIn(L)(['simulate', rel]);
    eq(r.code, 0, r.stdout);
    eq(simReqs(mock).length, 1, 'exactly one eth_simulateV1');
    const req = simReqs(mock)[0].params[0];
    eq(simReqs(mock)[0].params[1], 'latest'); eq(req.validation, false);
    eq(req.blockStateCalls.map((b) => b.calls.length), [2, 1, 3], 'one entry per group, its calls inside, in order');
    const flat = plan.flatMap((g) => g.calls);
    let k = 0;
    for (const b of req.blockStateCalls) {
      ok(!('stateOverrides' in b), 'no overrides without config overrides');
      for (const c of b.calls) {
        const want = flat[k++];
        eq(c.from.toLowerCase(), SIGNER_FIXED, 'from is the pinned signer'); eq(c.to.toLowerCase(), want.to.toLowerCase(), `to ${k}`); eq(c.data, want.data, `data ${k}`); eq(c.value, '0x0');
        ok(!('gas' in c), 'a grouped call carries no gas of its own (2^24 per call would fail the whole request with -38015 once the entry has used 23M)');
      }
    }
    eq(k, 6);
    eq(methodsOf(mock).sort(), ['eth_chainId', 'eth_getTransactionCount', 'eth_simulateV1'].sort(), 'only chainId, simulateV1 and the pending nonce are requested');
    const j = r.json;
    eq(j.from, ethers.getAddress(SIGNER_FIXED)); eq(j.input, 'groups'); eq(j.entries, 3); eq(j.count, 6); eq(j.pending_nonce, 9);
    eq(j.all_success, true); eq(j.failed_count, 0); eq(j.first_failed_index, null); eq(j.first_failed_group, null); eq(j.over_cap_count, 0); eq(j.first_over_cap_index, null); eq(j.clamped_count, 0);
    eq(j.columns, ['index', 'group', 'status', 'gasUsed', 'maxUsedGas', 'gas_limit']);
    eq(j.calls, [
      [0, 0, '0x1', 609738, 762172, 914607],
      [1, 0, '0x1', 4509748, 5637184, 6764621],
      [2, 1, '0x1', 51065, 63831, 76598],
      [3, 2, '0x1', 1000, null, 1500],
      [4, 2, '0x1', 609738, 762172, 914607],
      [5, 2, '0x1', 4509748, 5637184, 6764621],
    ], 'index is the global call index; the limit is ceil(maxUsedGas x 1.2), or ceil(gasUsed x 1.5) when the RPC returned no maxUsedGas');
    eq(j.no_max_used_gas_count, 1); ok(!('failures' in j) && !('overrides_active' in j));
    ok(/maxUsedGas x 1\.2/.test(j.gas_limit_rule));
    await mock.close();
  });

  await test('simulate (groups): config overrides ride on the first entry of the first group only; a failing call in a group names its index, group and target, and the later calls still report', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x0';
    mock.rpc.eth_simulateV1 = (p) => answer(p, (g, k) => (g === 1 && k === 0 ? failRes('ERC20: transfer amount exceeds balance') : okRes(21000, 26000)));
    const L = makeLayout('sim-groups-ov', mockConfig(mock, { simulationOverrides: {
      balances: { [SIGNER_FIXED]: '0x56bc75e2d63100000' },
      erc20Allowances: [{ token: A.sUSDS, owner: SIGNER_FIXED, spender: A.router, amount: 'max', slot: 3 }],
    } }));
    const plan = groupsOf([2, 2, 1]);
    const r = await helperIn(L)(['simulate', writeRunFile(L, 'sg2', 'plan.json', JSON.stringify(plan))]);
    eq(r.code, 0, r.stdout); eq(r.json.overrides_active, true); ok(/never gate a real send/.test(r.json.warning));
    const req = simReqs(mock)[0].params[0];
    ok('stateOverrides' in req.blockStateCalls[0], 'first entry carries the overrides');
    ok(!('stateOverrides' in req.blockStateCalls[1]) && !('stateOverrides' in req.blockStateCalls[2]), 'no other entry does');
    ok(!JSON.stringify(req).includes('"state"'), 'never a full "state" replacement');
    const j = r.json;
    eq(j.calls.map((c) => c[2]), ['0x1', '0x1', '0x0', '0x1', '0x1'], 'the call after the failing one in the same group is still simulated and reported');
    eq(j.calls.map((c) => c[1]), [0, 0, 1, 1, 2]);
    eq(j.all_success, false); eq(j.failed_count, 1); eq(j.first_failed_index, 2); eq(j.first_failed_group, 1);
    eq(j.failures.length, 1); eq(j.failures[0].index, 2); eq(j.failures[0].group, 1); eq(j.failures[0].to, ethers.getAddress(plan[1].calls[0].to)); eq(j.failures[0].status, '0x0');
    ok(/transfer amount exceeds balance/.test(j.failures[0].revert_reason));
    await mock.close();
  });

  await test('simulate (groups): 256 groups pass, 500 calls pass; 257 groups, 501 calls, a mixed list, group-level keys, empty or non-array calls and a bad inner call are all refused before any request', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x0';
    mock.rpc.eth_simulateV1 = (p) => answer(p, () => okRes(21000, 21000));
    const L = makeLayout('sim-groups-val', mockConfig(mock));
    const send = (name, content) => helperIn(L)(['simulate', writeRunFile(L, 'sg4', `${name}.json`, typeof content === 'string' ? content : JSON.stringify(content))]);
    const g256 = await send('g256', groupsOf(Array(256).fill(1)));
    eq(g256.code, 0, g256.stdout.slice(0, 200)); eq(g256.json.entries, 256); eq(g256.json.count, 256); eq(g256.json.all_success, true);
    eq(simReqs(mock)[0].params[0].blockStateCalls.length, 256);
    const c500 = await send('c500', groupsOf(Array(125).fill(4)));
    eq(c500.code, 0, c500.stdout.slice(0, 200)); eq(c500.json.count, 500); eq(c500.json.entries, 125);
    const tx = sendTx(1);
    const refused = [
      ['257 groups', groupsOf(Array(257).fill(1)), /256/],
      ['501 calls', groupsOf(Array(126).fill(4)).slice(0, 125).concat([{ calls: [tx] }]), /500/],
      ['mixed list', [tx, { calls: [tx] }], /mixes/],
      ['mixed list, group first', [{ calls: [tx] }, tx], /mixes/],
      ['group-level stateOverrides', [{ calls: [tx], stateOverrides: { [A.sUSDS]: { balance: '0x1' } } }], /unexpected key stateOverrides/],
      ['group-level blockOverrides', [{ calls: [tx], blockOverrides: { gasLimit: '0x5f5e100' } }], /unexpected key blockOverrides/],
      ['group-level from', [{ calls: [tx], from: ADDR1 }], /pinned/],
      ['group-level gas', [{ calls: [tx], gas: '0x1000000' }], /unexpected key gas/],
      ['empty calls', [{ calls: [] }], /non-empty/],
      ['calls not a list (object)', [{ calls: {} }], /non-empty/],
      ['calls not a list (string)', [{ calls: 'x' }], /non-empty/],
      ['inner from', [{ calls: [{ ...tx, from: ADDR1 }] }], /pinned/],
      ['inner gas', [{ calls: [{ ...tx, gas: '0x1' }] }], /unexpected key gas/],
      ['inner stateOverrides', [{ calls: [{ ...tx, stateOverrides: {} }] }], /unexpected key stateOverrides/],
      ['inner not an object', [{ calls: [5] }], /not an object/],
      ['inner bad to', [{ calls: [{ to: '0x12', data: '0x' }] }], /not an address/],
      ['inner odd-length data', [{ calls: [{ to: tx.to, data: '0xabc' }] }], /even-length/],
      ['empty list', [], /non-empty/],
      ['an object instead of a list', { calls: [tx] }, /non-empty/],
    ];
    const before = mock.http.length;
    for (const [name, content, re] of refused) {
      const x = await send(`bad-${name.replace(/[^a-z0-9]+/gi, '-')}`, content);
      eq(x.code, 2, `${name}: ${x.stdout.slice(0, 200)}`); eq(x.json.code, 'bad_argument', name); ok(re.test(x.json.error), `${name}: ${x.json.error}`);
    }
    const unsafe = await send('unsafe', '[{"calls":[{"to":"' + tx.to + '","data":"0x","value":9007199254740993}]}]');
    eq(unsafe.json.code, 'bad_argument');
    eq(mock.http.length, before, 'every refusal happens before any request');
    // a group of one call is the same as a flat entry apart from the per-call gas
    const one = await send('one', [{ calls: [tx] }]);
    eq(one.code, 0); eq(one.json.input, 'groups');
    await mock.close();
  });

  await test('simulate (groups): overrides cannot come from the file, argv or the environment', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x0';
    mock.rpc.eth_simulateV1 = (p) => answer(p, () => okRes(21000, 21000));
    const L = makeLayout('sim-groups-noov', mockConfig(mock));
    const H = helperIn(L);
    const rel = writeRunFile(L, 'sg5', 'plan.json', JSON.stringify(groupsOf([2, 1])));
    eq((await H(['simulate', rel, '--overrides', '{}'])).json.code, 'unexpected_option');
    eq((await H(['simulate', rel, '{}'])).json.code, 'usage');
    const r = await H(['simulate', rel], { SIMULATION_OVERRIDES: '{"balances":{}}', CHAIN_HELPER_OVERRIDES: '{}' });
    eq(r.code, 0); ok(!('overrides_active' in r.json));
    ok(simReqs(mock).every((s) => s.params[0].blockStateCalls.every((b) => !('stateOverrides' in b) && !('blockOverrides' in b))), 'no overrides of any kind in the request');
    await mock.close();
  });

  await test('simulate (groups): a 374-call plan in 100 groups prints one page under the 28000 cap, whether all pass, the tail fails or all fail; so does the 500-call maximum at its worst', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x3b2a1c';
    let mode = 'ok';
    let n = 0;
    mock.rpc.eth_simulateV1 = (p) => { n = 0; return answer(p, () => {
      const i = n++;
      if (mode === 'allfail' || (mode === 'late' && i >= 300)) return failRes('ERC20: transfer amount exceeds balance ' + 'y'.repeat(300));
      if (mode === 'worst') return { ...failRes('z'.repeat(300), 0x1000000), maxUsedGas: '0x1000000' };
      return i % 7 === 0 ? okRes(4509748, 5637184) : okRes(1187250, 1483846);
    }); };
    const L = makeLayout('sim-374', mockConfig(mock));
    const sizes = [...Array(74).fill(4), ...Array(26).fill(3)]; // 296 + 78 = 374 calls in 100 groups
    const plan = groupsOf(sizes);
    const rel = writeRunFile(L, 'sg6', 'plan374.json', JSON.stringify(plan));
    const okRun = await helperIn(L)(['simulate', rel]);
    eq(okRun.code, 0, okRun.stdout.slice(0, 200)); eq(okRun.json.count, 374); eq(okRun.json.entries, 100); eq(okRun.json.all_success, true);
    eq(okRun.json.calls.length, 374); eq(okRun.json.calls[373].slice(0, 3), [373, 99, '0x1']);
    ok(okRun.json.calls.every((c) => c[5] === limitRule(c[4])), 'every limit is ceil(maxUsedGas x 1.2)');
    eq(simReqs(mock)[0].params[0].blockStateCalls.length, 100, 'one request, 100 entries'); eq(simReqs(mock).length, 1);
    mode = 'late';
    const late = await helperIn(L)(['simulate', rel]);
    eq(late.code, 0); eq(late.json.failed_count, 74); eq(late.json.first_failed_index, 300); eq(late.json.failures.length, 8);
    mode = 'allfail';
    const bad = await helperIn(L)(['simulate', rel]);
    eq(bad.code, 0); eq(bad.json.failed_count, 374); eq(bad.json.first_failed_index, 0); eq(bad.json.failures.length, 8);
    const rel500 = writeRunFile(L, 'sg6', 'plan500.json', JSON.stringify(groupsOf(Array(125).fill(4))));
    mode = 'worst';
    const worst = await helperIn(L)(['simulate', rel500]);
    eq(worst.code, 0, worst.stdout.slice(0, 200)); eq(worst.json.count, 500); eq(worst.json.failed_count, 500); eq(worst.json.over_cap_count, 0);
    const sizesOut = { ok: okRun.stdout.length, late: late.stdout.length, allfail: bad.stdout.length, worst500: worst.stdout.length };
    for (const [k, v] of Object.entries(sizesOut)) ok(v < 28000, `${k} page is ${v} characters`);
    ok(okRun.stdout.length < 20000, `an all-pass 374-call page is ${okRun.stdout.length} characters`);
    console.log(`      (374 calls in 100 groups: ${sizesOut.ok} chars all pass, ${sizesOut.late} chars with 74 late failures, ${sizesOut.allfail} chars all failing; 500 calls all failing at 2^24 gas: ${sizesOut.worst500}; cap 28000)`);
    await mock.close();
  });

  await test('simulate: a call whose peak gas is above 2^24 is over_cap (the plan is not all_success even with status 0x1); the limit clamps at 2^24 and clamped calls are counted', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x0';
    // call 0 peaks at 18.9M (cannot be one transaction), call 1 at 14.5M (x 1.2 = 17.4M clamps but fits), call 2 is ordinary
    const peaks = [[15000000, 18874368], [11600000, 14500000], [51065, 63831]];
    let n = 0;
    mock.rpc.eth_simulateV1 = (p) => answer(p, () => { const [u, m] = peaks[n++]; return okRes(u, m); });
    const L = makeLayout('sim-overcap', mockConfig(mock));
    const r = await helperIn(L)(['simulate', writeRunFile(L, 'sg7', 'plan.json', JSON.stringify(groupsOf([3])))]);
    eq(r.code, 0, r.stdout);
    eq(r.json.calls.map((c) => c[5]), [16777216, 16777216, 76598]);
    eq(r.json.failed_count, 0); eq(r.json.over_cap_count, 1); eq(r.json.first_over_cap_index, 0); eq(r.json.clamped_count, 2); eq(r.json.all_success, false);
    await mock.close();
  });

  await test('simulate: -38026 (too many blocks), -38013 (gas budget) and -38015 (block gas limit) come back as simulate_failed with rpc_code and a hint, without retries; a wrong call count is simulate_malformed', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x0';
    const L = makeLayout('sim-errs', mockConfig(mock));
    const rel = writeRunFile(L, 'sg8', 'plan.json', JSON.stringify(groupsOf([2, 1])));
    const cases = [
      [-38026, 'too many blocks', /256 blockStateCalls entries.*windows of at most 256/],
      [-38013, 'intrinsic gas too low', /gas budget.*split the plan at group boundaries/],
      [-38015, "Block gas limit exceeded by the block's transactions", /40M block gas limit/],
    ];
    for (const [code, message, re] of cases) {
      mock.rpc.eth_simulateV1 = () => rpcErr(code, message);
      mock.http.length = 0;
      const r = await helperIn(L)(['simulate', rel]);
      eq(r.code, 5, message); eq(r.json.code, 'simulate_failed', message); eq(r.json.rpc_code, code); ok(re.test(r.json.hint), `${code} hint: ${r.json.hint}`); ok(r.json.error.includes(message));
      eq(simReqs(mock).length, 1, `${code} is not retried as a rate limit`);
    }
    mock.rpc.eth_simulateV1 = () => rpcErr(-32000, 'boom');
    const other = await helperIn(L)(['simulate', rel]);
    eq(other.json.code, 'simulate_failed'); ok(!('hint' in other.json), 'no hint for an error the helper does not know');
    mock.rpc.eth_simulateV1 = () => [{ number: '0x1', calls: [okRes(1, 1)] }]; // one block for a two-entry plan
    eq((await helperIn(L)(['simulate', rel])).json.code, 'simulate_malformed');
    mock.rpc.eth_simulateV1 = (p) => { const a = answer(p, () => okRes(1, 1)); a[0].calls.pop(); return a; }; // block 0 has one result for two calls
    const m2 = await helperIn(L)(['simulate', rel]);
    eq(m2.code, 5); eq(m2.json.code, 'simulate_malformed');
    await mock.close();
  });

  // ---- simulate: "return": true (a probe returns the flagged call's returnData) -----------------------------
  // The case it exists for: a market with a set group AND a complex-buy row is quoted on the pool state its set group
  // leaves, so the plan is [mint prefix + set group + a QuoterV2 call flagged "return": true] and the quote comes back.
  const wordsHex = (vals) => '0x' + vals.map((v) => BigInt(v).toString(16).padStart(64, '0')).join('');
  const quoteLike = (i) => wordsHex([1000 + i, 2n ** 96n + BigInt(i), i % 3, 150000 + i]); // 4 words = 258 characters, the width of a QuoterV2 quote
  const retOk = (data) => ({ status: '0x1', gasUsed: '0x5208', maxUsedGas: '0x5208', returnData: data });
  const revertErr = (reason) => new ethers.Interface(['error Error(string)']).encodeErrorResult('Error', [reason]);
  const flag = (plan, ...at) => plan.map((g) => ({ calls: g.calls.map((c) => ({ ...c })) })).map((g, gi) => { at.filter(([a]) => a === gi).forEach(([, k]) => { g.calls[k].return = true; }); return g; });

  await test('simulate (return): "return": true prints that call\'s returnData as `returns` [{index, group, return_data}], flagged calls only, in plan order, grouped or flat; the flag never reaches the node; with no flag there is no `returns` key and the rest of the page is identical', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x2';
    mock.rpc.eth_simulateV1 = (p) => answer(p, (g, k) => retOk(g === 1 && k === 2 ? '0xABCD' : quoteLike(g * 10 + k))); // every call has returnData; only the flagged ones are printed
    const L = makeLayout('sim-ret', mockConfig(mock));
    const base = groupsOf([2, 3, 1]); // global indexes: group 0 = 0,1; group 1 = 2,3,4; group 2 = 5
    const plan = flag(base, [0, 1], [1, 2], [2, 0]);
    const f = await helperIn(L)(['simulate', writeRunFile(L, 'sr1', 'probe.json', JSON.stringify(plan))]);
    eq(f.code, 0, f.stdout.slice(0, 300));
    eq(f.json.returns, [
      { index: 1, group: 0, return_data: quoteLike(1) },
      { index: 4, group: 1, return_data: '0xabcd' },
      { index: 5, group: 2, return_data: quoteLike(20) },
    ], 'one object per flagged call, in plan order, hex lowercased; unflagged calls are absent');
    eq(Object.keys(f.json.returns[0]), ['index', 'group', 'return_data']);
    const keys = Object.keys(f.json);
    eq(keys.indexOf('returns'), keys.indexOf('calls') + 1, '`returns` follows `calls`');
    eq(f.json.calls.length, 6); eq(f.json.columns, ['index', 'group', 'status', 'gasUsed', 'maxUsedGas', 'gas_limit']);
    eq(simReqs(mock).length, 1, 'still ONE eth_simulateV1');
    for (const b of simReqs(mock)[0].params[0].blockStateCalls) for (const c of b.calls) eq(Object.keys(c).sort(), ['data', 'from', 'to', 'value'], 'the flag is never sent to the node');
    ok(!JSON.stringify(simReqs(mock)[0].params).includes('"return"'), 'no "return" anywhere in the request');
    // the same plan without flags: no `returns` key, and everything else is identical
    const plain = await helperIn(L)(['simulate', writeRunFile(L, 'sr1', 'plain.json', JSON.stringify(base))]);
    eq(plain.code, 0); ok(!('returns' in plain.json), 'no flag, no `returns` key');
    const stripped = { ...f.json }; delete stripped.returns;
    eq(stripped, plain.json, 'apart from `returns` the page is the same as the unflagged plan\'s');
    // flat form: a flat entry is a call too (group equals index)
    const flat = [0, 1, 2].map((i) => ({ ...sendTx(i), ...(i !== 1 ? { return: true } : {}) }));
    const fl = await helperIn(L)(['simulate', writeRunFile(L, 'sr1', 'flat.json', JSON.stringify(flat))]);
    eq(fl.code, 0, fl.stdout.slice(0, 300)); eq(fl.json.input, 'flat');
    eq(fl.json.returns, [{ index: 0, group: 0, return_data: quoteLike(0) }, { index: 2, group: 2, return_data: quoteLike(20) }], 'a flat entry is its own group; the mock answers quoteLike(group x 10 + k)');
    // a flagged call that returned nothing prints "0x", and a call without returnData in the answer too
    mock.rpc.eth_simulateV1 = (p) => answer(p, (g, k) => (k === 0 ? retOk('0x') : { status: '0x1', gasUsed: '0x5208' }));
    const empty = await helperIn(L)(['simulate', writeRunFile(L, 'sr1', 'empty.json', JSON.stringify(flag(groupsOf([2]), [0, 0], [0, 1])))]);
    eq(empty.json.returns, [{ index: 0, group: 0, return_data: '0x' }, { index: 1, group: 0, return_data: '0x' }]);
    await mock.close();
  });

  await test('simulate (return): a FAILED flagged call returns its revert data (the node\'s error.data, else its returnData; "0x" when it has none); its status stays in `calls` and its text in `failures`; an unflagged failure is not in `returns`', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x0';
    const revert = revertErr('SUsds/insufficient-balance');
    const shapes = {
      errdata: [{ status: '0x0', gasUsed: '0x7261', maxUsedGas: '0x7261', returnData: '0x', error: { code: 3, message: 'execution reverted: SUsds/insufficient-balance', data: revert } }, revert], // measured live on both public RPCs: revert data is error.data, returnData is "0x"
      retdata: [{ status: '0x0', gasUsed: '0x7261', returnData: revert, error: { code: 3, message: 'execution reverted' } }, revert],
      empty: [{ status: '0x0', gasUsed: '0x5dd8', maxUsedGas: '0x5dd8', returnData: '0x', error: { code: 3, message: 'execution reverted', data: '0x' } }, '0x'],
      noerror: [{ status: '0x0', gasUsed: '0x5dd8' }, '0x'],
    };
    let shape = 'errdata';
    mock.rpc.eth_simulateV1 = (p) => answer(p, (g, k) => (k === 1 ? retOk(quoteLike(7)) : shapes[shape][0]));
    const L = makeLayout('sim-ret-fail', mockConfig(mock));
    const rel = writeRunFile(L, 'sr2', 'probe.json', JSON.stringify(flag(groupsOf([3]), [0, 0], [0, 1]))); // calls 0 (fails) and 1 (ok) flagged; call 2 fails, unflagged
    for (const name of Object.keys(shapes)) {
      shape = name;
      const r = await helperIn(L)(['simulate', rel]);
      eq(r.code, 0, `${name}: ${r.stdout.slice(0, 300)}`);
      eq(r.json.returns, [{ index: 0, group: 0, return_data: shapes[name][1] }, { index: 1, group: 0, return_data: quoteLike(7) }], name);
      eq(r.json.calls.map((c) => c[2]), ['0x0', '0x1', '0x0'], `${name}: the status is read from calls[index]`);
      eq(r.json.failed_count, 2); eq(r.json.all_success, false); eq(r.json.failures.map((x) => x.index), [0, 2]);
      if (name === 'errdata') ok(r.json.failures[0].revert_reason === 'SUsds/insufficient-balance', 'failures still decode the reason');
    }
    await mock.close();
  });

  await test('simulate (return): "return" is accepted only as boolean true on a call; false, "true", 1, null, an object, a group-level or file-level "return", a config key, an option and a multicall entry key are all refused before any request; 20 flagged calls pass and 21 are refused (grouped and flat)', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x0';
    mock.rpc.eth_simulateV1 = (p) => answer(p, () => okRes(21000, 21000));
    const L = makeLayout('sim-ret-val', mockConfig(mock));
    const send = (name, content) => helperIn(L)(['simulate', writeRunFile(L, 'sr3', `${name}.json`, typeof content === 'string' ? content : JSON.stringify(content))]);
    const tx = sendTx(1);
    const noReq = [
      ['return false', [{ calls: [{ ...tx, return: false }] }], /"return" must be the boolean true/],
      ['return "true"', [{ calls: [{ ...tx, return: 'true' }] }], /"return" must be the boolean true/],
      ['return 1', [{ calls: [{ ...tx, return: 1 }] }], /"return" must be the boolean true/],
      ['return null', [{ calls: [{ ...tx, return: null }] }], /"return" must be the boolean true/],
      ['return object', [{ calls: [{ ...tx, return: {} }] }], /"return" must be the boolean true/],
      ['return list', [{ calls: [{ ...tx, return: [true] }] }], /"return" must be the boolean true/],
      ['flat return false', [{ ...tx, return: false }], /"return" must be the boolean true/],
      ['flat return "yes"', [tx, { ...tx, return: 'yes' }], /"return" must be the boolean true/],
      ['group-level return', [{ calls: [tx], return: true }], /group 0: unexpected key return/],
      ['file-level return', { return: true, calls: [tx] }, /non-empty/],
      ['a misspelt flag', [{ calls: [{ ...tx, returns: true }] }], /unexpected key returns/],
      ['a data-ish key', [{ calls: [{ ...tx, returnData: true }] }], /unexpected key returnData/],
    ];
    const before = mock.http.length;
    for (const [name, content, re] of noReq) {
      const x = await send(`bad-${name.replace(/[^a-z0-9]+/gi, '-')}`, content);
      eq(x.code, 2, `${name}: ${x.stdout.slice(0, 200)}`); eq(x.json.code, 'bad_argument', name); ok(re.test(x.json.error), `${name}: ${x.json.error}`);
    }
    // the cap: 20 flagged calls pass, 21 are refused before any request, grouped or flat
    const all = (plan) => plan.map((g) => ({ calls: g.calls.map((c) => ({ ...c, return: true })) }));
    const over = await send('g21', all(groupsOf([5, 5, 5, 5, 1])));
    eq(over.code, 2); eq(over.json.code, 'bad_argument'); ok(/at most 20 calls .*"return": true \(21 given\)/.test(over.json.error), over.json.error);
    const overFlat = await send('f21', Array.from({ length: 21 }, (_, i) => ({ ...sendTx(i), return: true })));
    eq(overFlat.json.code, 'bad_argument'); ok(/21 given/.test(overFlat.json.error));
    eq(mock.http.length, before, 'every refusal happens before any request');
    const ok20 = await send('g20', all(groupsOf([5, 5, 5, 5])));
    eq(ok20.code, 0, ok20.stdout.slice(0, 200)); eq(ok20.json.returns.length, 20); eq(ok20.json.returns.map((x) => x.index), Array.from({ length: 20 }, (_, i) => i));
    const ok20flat = await send('f20', Array.from({ length: 20 }, (_, i) => ({ ...sendTx(i), return: true })));
    eq(ok20flat.code, 0); eq(ok20flat.json.returns.length, 20);
    // 20 flagged among 500 calls is fine: the cap counts flagged calls, not calls
    const mixed = await send('mix500', groupsOf(Array(125).fill(4)).map((g, gi) => ({ calls: g.calls.map((c, k) => (k === 0 && gi < 20 ? { ...c, return: true } : c)) })));
    eq(mixed.code, 0); eq(mixed.json.count, 500); eq(mixed.json.returns.length, 20);
    // `return` exists nowhere but on a simulate call
    const H = helperIn(L);
    eq((await H(['simulate', writeRunFile(L, 'sr3', 'p.json', JSON.stringify([{ calls: [tx] }])), '--return'])).json.code, 'unexpected_option');
    eq((await H(['simulate', writeRunFile(L, 'sr3', 'p.json', JSON.stringify([{ calls: [tx] }])), 'return'])).json.code, 'usage');
    const mcRel = writeRunFile(L, 'sr3', 'mc.json', JSON.stringify([{ to: A.sUSDS, signature: 'totalSupply()(uint256)', return: true }]));
    const mc = await H(['multicall', mcRel]);
    eq(mc.json.code, 'bad_argument'); ok(/unexpected key return/.test(mc.json.error), mc.json.error);
    const Lcfg = makeLayout('sim-ret-cfg', mockConfig(mock, { return: true }));
    const cfgRun = await helperIn(Lcfg)(['chain-id']);
    eq(cfgRun.code, 3); eq(cfgRun.json.code, 'config_malformed');
    await mock.close();
  });

  await test('simulate (return): a return_data of exactly 2048 hex digits (1024 bytes) passes, 2050 is refused as bad_argument naming the call (the page is never truncated), also for revert data; an unflagged call\'s big returnData is ignored; a flagged call with non-hex returnData is simulate_malformed', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x0';
    let make = () => retOk('0x');
    mock.rpc.eth_simulateV1 = (p) => answer(p, (g, k) => make(g, k));
    const L = makeLayout('sim-ret-cap', mockConfig(mock));
    const rel = writeRunFile(L, 'sr4', 'probe.json', JSON.stringify(flag(groupsOf([1, 2]), [0, 0], [1, 1]))); // calls 0 and 2 flagged
    const edge = '0x' + 'ab'.repeat(1024);
    make = (g, k) => retOk(g === 0 || k === 1 ? edge : '0x' + 'cd'.repeat(5000)); // call 1 (unflagged) returns 10,000 digits, ignored
    const r = await helperIn(L)(['simulate', rel]);
    eq(r.code, 0, r.stdout.slice(0, 200)); eq(r.json.returns.length, 2); eq(r.json.returns[0].return_data.length, 2050); eq(r.json.returns[1].return_data, edge);
    make = (g, k) => retOk(g === 1 && k === 1 ? '0x' + 'ab'.repeat(1025) : '0x');
    const big = await helperIn(L)(['simulate', rel]);
    eq(big.code, 2, big.stdout.slice(0, 300)); eq(big.json.code, 'bad_argument');
    ok(/call 2 \(group 1\) gave 2050 hex characters of return data, over the 2048 limit/.test(big.json.error), big.json.error);
    make = (g, k) => (g === 0 ? { status: '0x0', gasUsed: '0x5208', returnData: '0x', error: { code: 3, message: 'execution reverted', data: revertErr('r'.repeat(1100)) } } : retOk('0x'));
    const bigRevert = await helperIn(L)(['simulate', rel]);
    eq(bigRevert.code, 2); eq(bigRevert.json.code, 'bad_argument'); ok(/call 0 \(group 0\) gave \d+ hex characters of revert data/.test(bigRevert.json.error), bigRevert.json.error);
    for (const badData of ['0xzz', '0xabc', 'abcd', 42, {}]) {
      make = (g, k) => (g === 0 ? { status: '0x1', gasUsed: '0x5208', returnData: badData } : retOk('0x'));
      const m = await helperIn(L)(['simulate', rel]);
      eq(m.code, 5, JSON.stringify(badData)); eq(m.json.code, 'simulate_malformed', JSON.stringify(badData)); ok(/call 0 \(group 0\)/.test(m.json.error));
    }
    // the same garbage on an UNFLAGGED call is never read
    make = (g, k) => ({ status: '0x1', gasUsed: '0x5208', returnData: '0xzz' });
    const unflagged = await helperIn(L)(['simulate', writeRunFile(L, 'sr4', 'plain.json', JSON.stringify(groupsOf([1, 2])))]);
    eq(unflagged.code, 0); ok(!('returns' in unflagged.json));
    await mock.close();
  });

  await test('simulate (return): the page for a 374-call plan in 100 groups with 20 QuoterV2-sized returns stays under the 28000 cap, whether all pass or the tail fails (flagged failures return revert data); 20 returns of the full 2048 digits cannot fit one page and are reported as output_too_large, never truncated', async () => {
    const mock = await startMock();
    mock.rpc.eth_getTransactionCount = () => '0x3b2a1c';
    let mode = 'ok';
    let n = 0;
    const flaggedAt = new Set(Array.from({ length: 20 }, (_, i) => i * 19)); // 0, 19, ..., 361 (20 calls spread over the plan)
    mock.rpc.eth_simulateV1 = (p) => { n = 0; return answer(p, () => {
      const i = n++;
      if (mode === 'late' && i >= 300) return failRes('ERC20: transfer amount exceeds balance ' + 'y'.repeat(300));
      if (mode === 'full') return retOk('0x' + 'ab'.repeat(1024));
      return i % 7 === 0 ? { ...okRes(4509748, 5637184), returnData: quoteLike(i) } : { ...okRes(1187250, 1483846), returnData: quoteLike(i) };
    }); };
    const L = makeLayout('sim-ret-374', mockConfig(mock));
    const sizes = [...Array(74).fill(4), ...Array(26).fill(3)]; // 296 + 78 = 374 calls in 100 groups
    let g = 0;
    const plan = groupsOf(sizes).map((grp) => ({ calls: grp.calls.map((c) => (flaggedAt.has(g++) ? { ...c, return: true } : c)) }));
    eq(plan.flatMap((x) => x.calls).filter((c) => c.return === true).length, 20);
    const rel = writeRunFile(L, 'sr5', 'plan374.json', JSON.stringify(plan));
    const okRun = await helperIn(L)(['simulate', rel]);
    eq(okRun.code, 0, okRun.stdout.slice(0, 200)); eq(okRun.json.count, 374); eq(okRun.json.entries, 100); eq(okRun.json.all_success, true);
    eq(okRun.json.returns.length, 20); eq(okRun.json.returns.map((x) => x.index), [...flaggedAt]);
    ok(okRun.json.returns.every((x) => x.return_data.length === 258), 'a four-word quote is 258 characters with the 0x');
    eq(simReqs(mock).length, 1, 'one request');
    mode = 'late';
    const late = await helperIn(L)(['simulate', rel]);
    eq(late.code, 0, late.stdout.slice(0, 200)); eq(late.json.failed_count, 74); eq(late.json.returns.length, 20);
    const lateFlaggedFail = late.json.returns.filter((x) => x.index >= 300);
    eq(lateFlaggedFail.length, 4); ok(lateFlaggedFail.every((x) => x.return_data.startsWith('0x08c379a0')), 'a failed flagged call prints its revert data');
    mode = 'full';
    const full = await helperIn(L)(['simulate', rel]);
    eq(full.code, 7, full.stdout.slice(0, 200)); eq(full.json.code, 'output_too_large'); ok(full.json.chars > 28000, `the page would have been ${full.json.chars}`);
    const sz = { ok: okRun.stdout.length, late: late.stdout.length };
    for (const [k, v] of Object.entries(sz)) ok(v < 28000, `${k} page is ${v} characters`);
    console.log(`      (374 calls in 100 groups, 20 four-word returns: ${sz.ok} chars all pass, ${sz.late} chars with 74 late failures; 20 returns of 2048 digits would be ${full.json.chars} chars and are refused as output_too_large; cap 28000)`);
    await mock.close();
  });

  // ---- @run/<run-id>/<file> arguments (K6/H8) ------------------------------------------------------------
  await test('@file arguments: a tuple, an array, a long array and a scalar read from run/<run-id>/<file> encode the same calldata as inline; ./ and backslashes, CRLF and a trailing newline are accepted', async () => {
    const f = (frag) => new ethers.Interface([frag]);
    const redeem = f('function redeemPositions(address,address,uint256[],uint256[])');
    const idx = writeRunFile(L0, 'at1', 'idx.json', '["0","1","2"]\r\n');
    const amt = writeRunFile(L0, 'at1', 'amt.json', '["1000000000000000000","2","3"]\n');
    const want = redeem.encodeFunctionData('redeemPositions', [A.sUSDS, A.parent, [0n, 1n, 2n], [10n ** 18n, 2n, 3n]]);
    const sig = 'redeemPositions(address,address,uint256[],uint256[])';
    for (const [a, b] of [[`@${idx}`, `@${amt}`], [`@./${idx}`, `@./${amt}`], [`@${idx.replace(/\//g, '\\')}`, `@${amt.replace(/\//g, '\\')}`]]) {
      const r = await H0(['encode', sig, A.sUSDS, A.parent, a, b]);
      eq(r.code, 0, r.stdout); eq(r.json.calldata, want, `${a}`);
    }
    const mixed = await H0(['encode', sig, A.sUSDS, A.parent, `@${idx}`, '["1000000000000000000","2","3"]']);
    eq(mixed.json.calldata, want, 'a file argument and an inline argument can be mixed');
    // a long array (300 values: about 6 KB of text) from a file
    const values = Array.from({ length: 300 }, (_, i) => String(10n ** 18n + BigInt(i)));
    const big = writeRunFile(L0, 'at1', 'big.json', JSON.stringify(values));
    const rb = await H0(['encode', 'f(uint256[])', `@${big}`]);
    eq(rb.json.calldata, f('function f(uint256[])').encodeFunctionData('f', [values.map(BigInt)]));
    // quote-stripped JSON inside the file is parsed like quote-stripped inline JSON; a named-component tuple object works too
    const strip = writeRunFile(L0, 'at1', 'stripped.json', `[${ADDR1},${ADDR2},100,${A.router},1000000000000000000,995000000000000000,0]`);
    const sigE = 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))';
    const wantE = f('function exactInputSingle(tuple(address,address,uint24,address,uint256,uint256,uint160))').encodeFunctionData('exactInputSingle', [[ADDR1, ADDR2, 100, A.router, 10n ** 18n, 995000000000000000n, 0n]]);
    eq((await H0(['encode', sigE, `@${strip}`])).json.calldata, wantE);
    const named = writeRunFile(L0, 'at1', 'named.json', JSON.stringify({ tokenIn: ADDR1, tokenOut: ADDR2, fee: 100, recipient: A.router, amountIn: '1000000000000000000', amountOutMinimum: '995000000000000000', sqrtPriceLimitX96: '0' }));
    eq((await H0(['encode', 'exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))', `@${named}`])).json.calldata, wantE);
    // scalars: a uint256 and an address
    const sc = writeRunFile(L0, 'at1', 'scalar.txt', '1000000000000000000\n');
    eq((await H0(['encode', 'approve(address,uint256)', ADDR1, `@${sc}`])).json.calldata, f('function approve(address,uint256)').encodeFunctionData('approve', [ADDR1, 10n ** 18n]));
    const ad = writeRunFile(L0, 'at1', 'addr.txt', ADDR2 + '\n');
    eq((await H0(['encode', 'approve(address,uint256)', `@${ad}`, '5'])).json.calldata, f('function approve(address,uint256)').encodeFunctionData('approve', [ADDR2, 5n]));
    // a number above 2^53 inside a strict-JSON file is refused exactly as inline
    const unsafe = writeRunFile(L0, 'at1', 'unsafe.json', '[9007199254740993]');
    eq((await H0(['encode', 'f(uint256[])', `@${unsafe}`])).json.code, 'bad_argument');
    // neither the signature nor the <to> address of a call is ever read from a file
    const sigFile = writeRunFile(L0, 'at1', 'sig.txt', 'approve(address,uint256)');
    const noSig = await H0(['encode', `@${sigFile}`, ADDR1, '5']);
    eq(noSig.code, 2); eq(noSig.json.code, 'bad_argument');
    const noTo = await H0(['call', `@${ad}`, 'balanceOf(address)(uint256)', ADDR1]);
    eq(noTo.code, 2); eq(noTo.json.code, 'bad_argument');
  });

  await test('@file arguments: call sends exactly the calldata built from the file (scalar address and tuple array from files), with one eth_call', async () => {
    const mock = await startMock();
    mock.rpc.eth_blockNumber = () => '0x64';
    mock.rpc.eth_call = () => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [7n]);
    const L = makeLayout('at-call', mockConfig(mock));
    const holder = writeRunFile(L, 'at2', 'holder.txt', ADDR2);
    const r = await helperIn(L)(['call', A.sUSDS, 'balanceOf(address)(uint256)', `@${holder}`]);
    eq(r.code, 0, r.stdout); eq(r.json.result, ['7']);
    const sent = mock.http.flatMap((h) => h.items).filter((i) => i.method === 'eth_call');
    eq(sent.length, 1);
    eq(sent[0].params[0].data, new ethers.Interface(['function balanceOf(address)']).encodeFunctionData('balanceOf', [ADDR2]));
    await mock.close();
  });

  await test('@file arguments: every path rule refuses an @ argument with exit 4 and its own code, through encode and call; call makes no request', async () => {
    const mock = await startMock();
    const L = makeLayout('at-refuse', mockConfig(mock));
    const H = helperIn(L);
    writeRunFile(L, 'k1', 'ok.json', '["1"]');
    fs.mkdirSync(path.join(L.run('k1'), 'subdir'), { recursive: true });
    writeRunFile(L, 'k1', 'huge.json', '[' + '"1",'.repeat(1100000) + '"1"]'); // over 4 MB
    const cases = [
      ['@', 'path_empty'],
      ['@../x.json', 'path_traversal'],
      ['@run/k1/../../x.json', 'path_traversal'],
      ['@/etc/passwd', 'path_absolute'],
      ['@\\Windows\\win.ini', 'path_absolute'],
      ['@C:\\Windows\\win.ini', 'path_drive'],
      ['@C:/Windows/win.ini', 'path_drive'],
      ['@\\\\server\\share\\x', 'path_unc'],
      ['@//server/share/x', 'path_unc'],
      ['@run/k1/a:stream', 'path_colon'],
      ['@x/y/z.json', 'path_outside_run'],
      ['@wallet.json', 'path_outside_run'],
      ['@run/k1', 'path_too_short'],
      ['@run/wallet.json', 'path_too_short'],
      ['@run//k1/ok.json', 'path_malformed'],
      ['@run/.lock/ok.json', 'bad_run_id'],
      ['@run/k1/sp ace.json', 'path_component'],
      ['@run/k1/.hidden', 'path_component'],
      ['@run/k1/missing.json', 'path_not_found'],
      ['@run/nonexistent/x.json', 'path_not_found'],
      ['@run/k1/subdir', 'path_not_file'],
      ['@run/k1/huge.json', 'path_file_too_large'],
    ];
    for (const [arg, code] of cases) {
      const e = await H(['encode', 'f(uint256[])', arg]);
      eq(e.code, 4, `encode ${arg}`); eq(e.json.code, code, `encode ${arg}`);
      const c = await H(['call', A.sUSDS, 'f(uint256[])(uint256)', arg]);
      eq(c.code, 4, `call ${arg}`); eq(c.json.code, code, `call ${arg}`);
    }
    eq(mock.http.length, 0, 'a refused @ argument causes no request');
    // a symlink or junction on the way is refused (needs link privileges on Windows)
    const outside = path.join(L.base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.json'), '["1"]');
    const link = path.join(L.run('k1'), 'linkdir');
    if (trySymlink(outside, link, 'junction')) {
      const x = await H(['encode', 'f(uint256[])', '@run/k1/linkdir/secret.json']);
      eq(x.code, 4); eq(x.json.code, 'path_symlink');
      removeLink(link);
    }
    // and the same file, spelled correctly, is accepted
    eq((await H(['encode', 'f(uint256[])', '@run/k1/ok.json'])).code, 0);
    await mock.close();
  });

  await test('@file arguments through Windows PowerShell: the double-quoted "@run/<run-id>/<file>" form reaches the helper intact (skipped off Windows)', async () => {
    if (process.platform !== 'win32') skip('PowerShell quoting is a Windows concern');
    const rel = writeRunFile(L0, 'at-ps', 'arr.json', '["0","1","2"]');
    const outFile = (() => {
      const helper = path.join(L0.install, 'chain-helper.cjs');
      return new Promise((resolve, reject) => {
        const cmd = `& '${process.execPath}' '${helper}' encode 'f(uint256[])' "@${rel}"`;
        const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cmd, 'utf16le').toString('base64')], { cwd: L0.proj, env: { ...process.env, NODE_PATH } });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.on('error', reject);
        p.on('close', () => resolve(out));
      });
    })();
    let out;
    try { out = await outFile; } catch { skip('powershell.exe is not available'); }
    let j = null; try { j = JSON.parse(out.trim()); } catch { j = null; }
    if (j === null) skip(`powershell.exe gave no JSON: ${out.slice(0, 100)}`);
    eq(j.calldata, new ethers.Interface(['function f(uint256[])']).encodeFunctionData('f', [[0n, 1n, 2n]]));
  });

  // ---- data ---------------------------------------------------------------------------------------------
  const syntheticBody = () => JSON.stringify({
    marketsData: { 'a/b': { id: ADDR1, upPrice: 0.5, downPrice: 0.4, upPool: { liquidity: '123456789012345678901234', tick: '-5', token0: ADDR2, token1: ADDR1, feeTier: '100', price: 0.5 }, downPool: null } },
    markets: [{ id: ADDR1.toUpperCase().replace('0X', '0x'), wrappedTokens: [ADDR2, ADDR2, ADDR2], collateralToken: ADDR2, parentOutcome: 3, marketStatus: 'open' },
      { id: ADDR2, wrappedTokens: [ADDR1, ADDR1, ADDR1], collateralToken: ADDR1, parentOutcome: 0, marketStatus: 'open' }],
    parentWrappedTokens: [ADDR1, ADDR1, ADDR1, ADDR1],
    parentMarketStatus: 'open',
    middleMarkets: [{ id: ADDR1, payoutReported: false }],
  });
  await test('data: the RAW body is written byte for byte, only a summary is printed', async () => {
    const mock = await startMock();
    const marker = 'UNIQUE_BODY_MARKER_9f3a';
    const raw = Buffer.from(syntheticBody().replace('a/b', marker) + '   \n\n', 'utf8');
    mock.data = () => ({ status: 200, headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: raw });
    const L = makeLayout('data', mockConfig(mock));
    const r = await helperIn(L)(['data', 'd1']);
    eq(r.code, 0, r.stdout);
    ok(Buffer.compare(fs.readFileSync(path.join(L.run('d1'), 'r3-data.json')), raw) === 0, 'file equals the body');
    eq(r.json.status, 200); eq(r.json.bytes, raw.length); eq(r.json.sha256, crypto.createHash('sha256').update(raw).digest('hex'));
    eq(r.json.markets, 2); eq(r.json.slots, { min: 0, max: 3, distinct: 2 }); eq(r.json.pools_null, 1); eq(r.json.usable, true); eq(r.json.written, true);
    eq(r.json.path, 'run/d1/r3-data.json'); eq(r.json.json_valid, true); eq(r.json.shape_ok, true); eq(r.json.has_error_field, false);
    ok(!r.stdout.includes(marker), 'the body must never be printed'); ok(r.stdout.length < 1500, `summary is ${r.stdout.length} chars`);
    eq(fs.readdirSync(L.run('d1')), ['r3-data.json']);
    eq(mock.http.filter((h) => h.method === 'GET').length, 1, 'one GET');
    eq(mock.http.length, 1, 'the data command makes no RPC request');
    // the second fetch overwrites
    mock.data = () => ({ status: 200, headers: {}, body: Buffer.from('{}') });
    const r2 = await helperIn(L)(['data', 'd1']);
    eq(r2.json.bytes, 2); eq(r2.json.usable, false); eq(r2.json.shape_ok, false); eq(fs.readFileSync(path.join(L.run('d1'), 'r3-data.json'), 'utf8'), '{}');
    await mock.close();
  });
  await test('data: non-200, error bodies, malformed bodies and redirects are reported, never "usable"', async () => {
    const mock = await startMock();
    const L = makeLayout('data-bad', mockConfig(mock));
    const H = helperIn(L);
    mock.data = () => ({ status: 500, headers: {}, body: Buffer.from('{"error":"Pool query failed"}') });
    let r = await H(['data', 'd2']);
    eq(r.code, 0); eq(r.json.status, 500); eq(r.json.usable, false); eq(r.json.has_error_field, true);
    ok(!r.stdout.includes('Pool query failed'), 'error text is in the file, not echoed');
    eq(fs.readFileSync(path.join(L.run('d2'), 'r3-data.json'), 'utf8'), '{"error":"Pool query failed"}');
    mock.data = () => ({ status: 200, headers: {}, body: Buffer.from('{"markets":[{"id":"0x') });
    r = await H(['data', 'd2']);
    eq(r.json.status, 200); eq(r.json.json_valid, false); eq(r.json.usable, false);
    mock.data = () => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ error: 'x', ...JSON.parse(syntheticBody()) })) });
    r = await H(['data', 'd2']);
    eq(r.json.has_error_field, true); eq(r.json.usable, false);
    mock.data = () => ({ status: 302, headers: { location: '/somewhere-else' }, body: Buffer.from('') });
    r = await H(['data', 'd2']);
    eq(r.code, 5); eq(r.json.code, 'data_redirect');
    mock.fail429 = 2; mock.data = () => ({ status: 200, headers: {}, body: Buffer.from(syntheticBody()) });
    mock.http.length = 0;
    r = await H(['data', 'd3']);
    eq(r.code, 0); eq(r.json.usable, true); eq(mock.http.length, 3, 'two 429s then success');
    eq((await H(['data', '../x'])).json.code, 'bad_run_id');
    eq((await H(['data', 'a/b'])).json.code, 'bad_run_id');
    eq((await H(['data', '.lock'])).json.code, 'bad_run_id');
    await mock.close();
  });
  await test('data: an unreachable data function is data_unreachable (the offline-fallback signal)', async () => {
    const mock = await startMock();
    const cfg = mockConfig(mock);
    await mock.close();
    const L = makeLayout('data-down', cfg);
    const r = await helperIn(L)(['data', 'd4']);
    eq(r.code, 5); eq(r.json.code, 'data_unreachable');
    ok(!fs.existsSync(path.join(L.run('d4'), 'r3-data.json')), 'nothing written');
  });
  await test('data: a body over the cap is refused and a symlinked target is not followed', async () => {
    const mock = await startMock();
    mock.data = () => ({ status: 200, headers: {}, body: Buffer.alloc(17 * 1024 * 1024, 0x20) });
    const L = makeLayout('data-cap', mockConfig(mock));
    const r = await helperIn(L)(['data', 'd5']);
    eq(r.code, 5); eq(r.json.code, 'response_too_large');
    mock.data = () => ({ status: 200, headers: {}, body: Buffer.from(syntheticBody()) });
    const outside = path.join(L.base, 'victim.txt');
    fs.writeFileSync(outside, 'untouched');
    fs.mkdirSync(L.run('d6'));
    if (trySymlink(outside, path.join(L.run('d6'), 'r3-data.json'), 'file')) {
      const x = await helperIn(L)(['data', 'd6']);
      eq(x.code, 4); eq(x.json.code, 'path_symlink');
      eq(fs.readFileSync(outside, 'utf8'), 'untouched');
      removeLink(path.join(L.run('d6'), 'r3-data.json'));
    }
    await mock.close();
  });

  await test('data-rows (extension): paginated projection of r3-data.json, absent fields marked, count capped', async () => {
    const L = makeLayout('rows', { chainId: 10, rpcUrl: 'http://127.0.0.1:9/', dataFunctionUrl: `http://127.0.0.1:9${DATA_PATH}`, signerAddress: SIGNER_FIXED });
    const H = helperIn(L);
    const body = JSON.parse(syntheticBody());
    delete body.markets[1].collateralToken;
    writeRunFile(L, 'r1', 'r3-data.json', JSON.stringify(body));
    const r = await H(['data-rows', 'r1', '0', '5']);
    eq(r.code, 0, r.stdout); eq(r.json.total, 2); eq(r.json.count, 2);
    eq(r.json.rows[0][0], 0); eq(r.json.rows[0][1], 'a/b'); eq(r.json.rows[0][2], ADDR1); eq(r.json.rows[0][3], 3);
    eq(r.json.rows[0][7][1][0], '123456789012345678901234', 'liquidity stays a string');
    eq(r.json.header.parent_wrapped_tokens, [ADDR1, ADDR1, ADDR1, ADDR1], 'parent wrapped tokens, lowercased'); eq(r.json.header.parent_market_status, 'open'); eq(r.json.header.middle_markets, [[ADDR1, false]], 'middle markets as [id, payoutReported]');
    eq(r.json.rows[0][8][1], null, 'null pool stays null'); eq(r.json.rows[1][4], '<missing>', 'absent field marked'); eq(r.json.rows[1][1], '<missing>');
    const r2 = await H(['data-rows', 'r1', '1', '1']);
    eq(r2.json.rows.length, 1); eq(r2.json.rows[0][0], 1);
    eq((await H(['data-rows', 'r1', '0', '31'])).json.code, 'bad_argument');
    eq((await H(['data-rows', 'r1', 'x', '3'])).json.code, 'bad_argument');
    eq((await H(['data-rows', 'nope', '0', '3'])).json.code, 'path_not_found');
    eq((await H(['data-rows', '..', '0', '3'])).json.code, 'bad_run_id');
  });

  // ---- every request any offline test made used the fixed list --------------------------------------------
  await test('across all offline tests, only fixed-list methods ever reached the (mock) endpoint', async () => {
    ok(ALL_METHODS_SEEN.length > 20, `saw ${ALL_METHODS_SEEN.length} requests`);
    for (const m of ALL_METHODS_SEEN) ok(lib.ALLOWED_METHODS.includes(m), `unexpected method ${m}`);
    ok(!ALL_METHODS_SEEN.some((m) => /^(eth_send|eth_sign|personal_|wallet_)/.test(m)));
  });
}

// ========================================================================================================
// LIVE (read-only)
// ========================================================================================================

async function indepRpc(method, params, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(INDEP_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
    const j = await res.json();
    if (!j.error) return j.result;
    last = j.error;
    await sleep(1500);
  }
  throw new Error(`independent read failed: ${JSON.stringify(last)}`);
}
async function indepCall(to, signature, args, blockHex) {
  const f = ethers.FunctionFragment.from(signature);
  const i = new ethers.Interface([f]);
  const raw = await indepRpc('eth_call', [{ to, data: i.encodeFunctionData(f, args) }, blockHex || 'latest']);
  return i.decodeFunctionResult(f, raw);
}

async function live() {
  const liveCfg = (extra = {}) => ({ chainId: 10, rpcUrl: LIVE_RPC, dataFunctionUrl: LIVE_DATA, signerAddress: THROWAWAY, ...extra });
  const L = makeLayout('live', liveCfg());
  const H = helperIn(L);
  const lt = async (name, fn) => { await sleep(500); await test(`live: ${name}`, fn); };
  const must = (r, what) => { if (r.code !== 0) throw new Error(`${what || 'helper'} failed: ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 200)}`); return r.json; };

  await lt('chain-id is 10', async () => { const j = must(await H(['chain-id'])); eq(j, { chain_id: 10, expected: 10, ok: true }); });
  await lt('block, nonce, balance, code, fee-history shapes', async () => {
    const b = must(await H(['block']));
    ok(b.number > 100000000 && Math.abs(Date.now() / 1000 - b.timestamp) < 600, `latest block ${b.number} ts ${b.timestamp}`);
    const n = must(await H(['nonce', THROWAWAY])); eq([n.latest, n.pending], [0, 0]);
    const np = must(await H(['nonce', THROWAWAY, String(b.number - 20000)])); eq([np.block, np.nonce], [b.number - 20000, 0]);
    eq(must(await H(['balance', THROWAWAY])).wei, '0');
    const c = must(await H(['code', A.mc3])); eq(c.has_code, true); ok(c.bytes > 1000);
    eq(must(await H(['code', THROWAWAY])).has_code, false);
    const f = must(await H(['fee-history']));
    eq(f.base_fee_per_gas.length, 11); eq(f.reward.length, 10); ok(/^\d+$/.test(f.gas_price));
  });

  let dataRows = [];
  await lt('data: GET the data function, write the raw body, print only a summary', async () => {
    fs.mkdirSync(L.run('live1'), { recursive: true });
    const j = must(await H(['data', 'live1']));
    eq(j.status, 200); eq(j.markets, 98); eq(j.usable, true); eq(j.middle_markets, 3); eq(j.parent_wrapped_tokens, 4);
    const file = fs.readFileSync(path.join(L.run('live1'), 'r3-data.json'));
    eq(j.bytes, file.length); eq(j.sha256, crypto.createHash('sha256').update(file).digest('hex'));
    ok(file.length > 50000, 'a real body');
    const body = JSON.parse(file.toString('utf8'));
    eq(body.markets[0].id.toLowerCase(), '0x5d6a571b0f663c33831e6f81dd3c3f554eca188b', 'row 0 is the skill table\'s py_ecc market');
    eq(j.slots, { min: 0, max: 32, distinct: 33 });
  });
  await lt('data-rows: four pages cover all 98 markets and agree with the file', async () => {
    const body = JSON.parse(fs.readFileSync(path.join(L.run('live1'), 'r3-data.json'), 'utf8'));
    for (const off of [0, 30, 60, 90]) {
      const j = must(await H(['data-rows', 'live1', String(off), '30']));
      eq(j.total, 98); dataRows = dataRows.concat(j.rows);
      ok(JSON.stringify(j).length < 28000, 'page is bounded');
    }
    eq(dataRows.length, 98);
    dataRows.forEach((row, i) => {
      eq(row[0], i); eq(row[2], body.markets[i].id.toLowerCase()); eq(row[3], body.markets[i].parentOutcome);
      eq(row[4], body.markets[i].collateralToken.toLowerCase()); eq(row[6], body.markets[i].wrappedTokens.map((x) => x.toLowerCase()));
    });
  });

  await lt('encode splitPosition and keccak256 over the file route agree with ethers', async () => {
    const e = must(await H(['encode', 'splitPosition(address,address,uint256)', A.sUSDS, A.parent, '1000000000000000000']));
    const want = new ethers.Interface(['function splitPosition(address,address,uint256)']).encodeFunctionData('splitPosition', [A.sUSDS, A.parent, 10n ** 18n]);
    eq(e.calldata, want);
    const rel = writeRunFile(L, 'live1', 'split.data', e.calldata);
    const k = must(await H(['keccak256', rel]));
    eq(k.keccak256, ethers.keccak256(want)); eq(k.keccak256, e.keccak256);
  });

  // slot0 against an independent read of the same pool at the same block
  let pool = null;
  await lt('slot0 matches an independent read of the same pool at the same block', async () => {
    const row = dataRows[0];
    const upToken = row[6][1];
    const collateral = row[4];
    const g = must(await H(['call', A.factory, 'getPool(address,address,uint24)(address)', upToken, collateral, '100']));
    pool = g.result[0];
    const indepPool = (await indepCall(A.factory, 'function getPool(address,address,uint24) view returns (address)', [upToken, collateral, 100]))[0];
    eq(pool, indepPool, 'pool address');
    ok(pool !== ethers.ZeroAddress, 'pool exists');
    await sleep(400);
    const s = must(await H(['slot0', pool]));
    const blk = ethers.toBeHex(s.block);
    await sleep(2500); // let the second endpoint see the block
    const pi = new ethers.Interface(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function liquidity() view returns (uint128)', 'function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)']);
    const rd = async (fn) => pi.decodeFunctionResult(fn, await indepRpc('eth_call', [{ to: pool, data: pi.encodeFunctionData(fn) }, blk]));
    const s0 = await rd('slot0');
    eq(s.sqrt_price_x96, s0[0].toString(), 'sqrtPriceX96'); eq(s.tick, Number(s0[1]), 'tick');
    eq(s.liquidity, (await rd('liquidity'))[0].toString(), 'liquidity');
    eq(s.token0, (await rd('token0'))[0]); eq(s.token1, (await rd('token1'))[0]); eq(s.fee, Number((await rd('fee'))[0]));
    ok(s.fee === 100 && Number.isInteger(s.tick), 'fee tier 100');
    // sanity against the data function snapshot: same pool, close tick
    const body = JSON.parse(fs.readFileSync(path.join(L.run('live1'), 'r3-data.json'), 'utf8'));
    const up = body.marketsData[row[1]].upPool;
    ok(Math.abs(Number(up.tick) - s.tick) < 2000, `snapshot tick ${up.tick} vs live ${s.tick}`);
  });
  await lt('a quote through QuoterV2 (non-view, eth_call only) matches an independent call', async () => {
    const row = dataRows[0];
    const tuple = [row[4], row[6][1], '1000000000000000000', 100, '0'];
    const q = must(await H(['call', A.quoter, 'quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)', JSON.stringify(tuple)]));
    ok(BigInt(q.result[0]) > 0n, 'positive amountOut');
    await sleep(500);
    const f = 'function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256,uint160,uint32,uint256)';
    const iq = new ethers.Interface([f]);
    const raw = await indepRpc('eth_call', [{ to: A.quoter, data: iq.encodeFunctionData('quoteExactInputSingle', [[row[4], row[6][1], 10n ** 18n, 100, 0n]]) }, 'latest']);
    const want = iq.decodeFunctionResult('quoteExactInputSingle', raw);
    const rel = Math.abs(Number(BigInt(q.result[0]) - want[0]) / Number(want[0]));
    ok(rel < 0.01, `quote ${q.result[0]} vs ${want[0]}`); // same pool state up to a block or two of drift
  });

  await lt('payoutDenominator (and conditionId) match an independent read, with a non-vacuous control', async () => {
    const markets = [A.parent, A.middleA, dataRows[0][2]];
    for (const m of markets) {
      const cid = must(await H(['call', m, 'conditionId()(bytes32)'])).result[0];
      const icid = (await indepCall(m, 'function conditionId() view returns (bytes32)', []))[0];
      eq(cid, icid, `conditionId of ${m}`);
      const pd = must(await H(['call', A.ctf, 'payoutDenominator(bytes32)(uint256)', cid])).result[0];
      const ipd = (await indepCall(A.ctf, 'function payoutDenominator(bytes32) view returns (uint256)', [cid]))[0].toString();
      eq(pd, ipd, `payoutDenominator of ${m}`);
      const slotCount = must(await H(['call', A.ctf, 'getOutcomeSlotCount(bytes32)(uint256)', cid])).result[0];
      eq(slotCount, (await indepCall(A.ctf, 'function getOutcomeSlotCount(bytes32) view returns (uint256)', [cid]))[0].toString());
      ok(BigInt(slotCount) >= 3n, `slot count ${slotCount}`);
      await sleep(400);
    }
    // control: a read that is not zero, so equality is not trivially 0 == 0
    const ts = must(await H(['call', A.sUSDS, 'totalSupply()(uint256)'])).result[0];
    ok(BigInt(ts) > 0n); ok(Math.abs(Number(BigInt(ts) - (await indepCall(A.sUSDS, 'function totalSupply() view returns (uint256)', []))[0]) / Number(ts)) < 0.001);
  });

  await lt('the check 2.7 shape: aggregate3 of wrappedOutcome reads, decoded, equals the data function', async () => {
    const calls = [];
    const want = [];
    for (const row of dataRows.slice(0, 2)) for (let k = 0; k < 3; k++) {
      calls.push([row[2], false, new ethers.Interface(['function wrappedOutcome(uint256) view returns (address,bytes)']).encodeFunctionData('wrappedOutcome', [k])]);
      want.push(row[6][k]);
    }
    const rel = writeRunFile(L, 'live1', 'calls.json', JSON.stringify(calls));
    const j = must(await H(['call', A.mc3, 'aggregate3((address,bool,bytes)[])((bool,bytes)[])', `@${rel}`]));
    eq(j.result[0].length, 6);
    const got = j.result[0].map((x) => ethers.AbiCoder.defaultAbiCoder().decode(['address', 'bytes'], x[1])[0].toLowerCase());
    eq(got, want);
    eq(j.result[0].every((x) => x[0] === true), true);
  });

  await lt('slot0 of an address that is not a pool is refused', async () => {
    const r = await H(['slot0', THROWAWAY]);
    eq(r.code, 1); eq(r.json.code, 'decode_failed');
  });
  // The raw `call` form of C's check 2.7 does not fit one output page: each nested (address,bytes) result is
  // ~400 characters, so 98 reads print ~39k and the full 294 would print ~117k, against the 28k cap. The helper must
  // REFUSE such an answer (output_too_large, exit 7), never truncate it; a ~60-read page does fit.  The `multicall`
  // extension (below) is what makes the 294-read check workable.
  await lt('raw call: a 98-read aggregate3 is refused as output_too_large (never truncated); a 60-read page fits and decodes', async () => {
    const wo = new ethers.Interface(['function wrappedOutcome(uint256) view returns (address,bytes)']).encodeFunctionData('wrappedOutcome', [1]);
    const calls = dataRows.map((row) => [row[2], false, wo]);
    const rel = writeRunFile(L, 'live1', 'calls98.json', JSON.stringify(calls));
    const big = await H(['call', A.mc3, 'aggregate3((address,bool,bytes)[])((bool,bytes)[])', `@${rel}`]);
    eq(big.code, 7, big.stdout.slice(0, 200)); eq(big.json.code, 'output_too_large'); ok(big.json.chars > 28000 && big.stdout.length < 1000, 'an error object, not a truncated answer');
    await sleep(800);
    const rel60 = writeRunFile(L, 'live1', 'calls60.json', JSON.stringify(calls.slice(0, 60)));
    const r = await H(['call', A.mc3, 'aggregate3((address,bool,bytes)[])((bool,bytes)[])', `@${rel60}`]);
    const j = must(r);
    eq(j.result[0].length, 60);
    console.log(`      (98-read page: ${big.json.chars} chars; 60-read page printed ${r.stdout.length} chars, limit 28000; 98 reads on a command line would be ${JSON.stringify(calls).length} chars)`);
    const got = j.result[0].map((x) => ethers.AbiCoder.defaultAbiCoder().decode(['address', 'bytes'], x[1])[0].toLowerCase());
    eq(got, dataRows.slice(0, 60).map((row) => row[6][1]), 'every UP wrapped token equals the data function');
  });
  await lt('multicall (extension): the whole check 2.7, 294 wrappedOutcome reads in ONE call, equals the data function\'s wrappedTokens', async () => {
    const entries = [];
    const want = [];
    for (const row of dataRows) for (let k = 0; k < 3; k++) { entries.push({ to: row[2], signature: 'wrappedOutcome(uint256)(address)', args: [String(k)] }); want.push(row[6][k]); }
    eq(entries.length, 294);
    const rel = writeRunFile(L, 'live1', 'reads294.json', JSON.stringify(entries));
    const r = await H(['multicall', rel]);
    const j = must(r);
    eq(j.count, 294); eq(j.results.length, 294); ok(j.block > 100000000, `block ${j.block}`);
    const got = j.results.map((x) => { eq(x.length, 1); return x[0].toLowerCase(); });
    eq(got, want, 'every wrapped outcome token read onchain equals the body\'s wrappedTokens');
    ok(new Set(got).size === 294, '294 distinct tokens');
    const swapped = want.slice(); [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    ok(JSON.stringify(got) !== JSON.stringify(swapped), 'negative control: a swapped pair would be detected');
    console.log(`      (294 reads: output ${r.stdout.length} chars of a 28000 limit; as a raw aggregate3 it would be ~117k)`);
  });
  await lt('multicall (extension): QuoterV2 quotes (non-view, tuple args, four returns) and boundary reads in one call agree with single calls', async () => {
    const qsig = 'quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)';
    const tuples = [0, 1].map((i) => [dataRows[i][4], dataRows[i][6][1], '1000000000000000000', 100, '0']);
    const entries = [
      ...tuples.map((t) => ({ to: A.quoter, signature: qsig, args: [t] })),
      { to: A.ctf, signature: 'getOutcomeSlotCount(bytes32)(uint256)', args: ['0x' + '00'.repeat(32)] },
      { to: A.sUSDS, signature: 'balanceOf(address)(uint256)', args: [THROWAWAY] },
    ];
    const rel = writeRunFile(L, 'live1', 'reads-quotes.json', JSON.stringify(entries));
    const m = must(await H(['multicall', rel]));
    eq(m.count, 4); eq(m.results[2], ['0']); eq(m.results[3], ['0']);
    for (let i = 0; i < 2; i++) {
      eq(m.results[i].length, 4); ok(BigInt(m.results[i][0]) > 0n, 'positive amountOut');
      await sleep(500);
      const single = must(await H(['call', A.quoter, qsig, JSON.stringify(tuples[i])]));
      const a = BigInt(m.results[i][0]); const b = BigInt(single.result[0]);
      ok(a > 0n && Math.abs(Number(a - b)) / Number(b) < 0.01, `multicall quote ${a} vs call ${b}`);
    }
  });
  await lt('multicall (extension): a read on a contract without the function fails the call, it is not silently dropped', async () => {
    const rel = writeRunFile(L, 'live1', 'reads-bad.json', JSON.stringify([{ to: A.sUSDS, signature: 'totalSupply()(uint256)' }, { to: A.sUSDS, signature: 'definitelyNotAFunction()(uint256)' }]));
    const r = await H(['multicall', rel]);
    ok(r.code !== 0 && r.json && r.json.error, `expected a failure, got ${r.stdout.slice(0, 200)}`);
  });
  await lt('allowances and balanceOf are just call', async () => {
    const bal = must(await H(['call', A.sUSDS, 'balanceOf(address)(uint256)', THROWAWAY]));
    eq(bal.result, ['0']);
    const al = must(await H(['call', A.sUSDS, 'allowance(address,address)(uint256)', THROWAWAY, A.router]));
    eq(al.result, ['0']);
  });

  // simulations: the needs-chain-helper clearance
  const split = (market, amount) => must_encode(['splitPosition(address,address,uint256)', A.sUSDS, market, amount]);
  const must_encode = (args) => new ethers.Interface(['function splitPosition(address,address,uint256)']).encodeFunctionData('splitPosition', [args[1], args[2], BigInt(args[3])]);
  const approve = (token, amount) => ({ to: token, data: new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [A.router, BigInt(amount)]) });
  const M = (100n * 10n ** 18n).toString();
  const baseOv = { balances: { [THROWAWAY]: '1000000000000000000' }, erc20Balances: [{ token: A.sUSDS, holder: THROWAWAY, amount: (1000n * 10n ** 18n).toString(), slot: 2 }] };

  await lt('clearance: two dependent transactions (parent split, then the middle split spending the bundle tokens it mints), both 0x1', async () => {
    const L2 = makeLayout('live-sim2', liveCfg({ simulationOverrides: { ...baseOv, erc20Allowances: [
      { token: A.sUSDS, owner: THROWAWAY, spender: A.router, amount: 'max', slot: 3 },
      { token: A.bundleA, owner: THROWAWAY, spender: A.router, amount: 'max', slot: 4 },
    ] } }));
    const rel = writeRunFile(L2, 'sim2', 'txs.json', JSON.stringify([
      { to: A.router, data: split(A.parent, M), value: '0' },
      { to: A.router, data: split(A.middleA, M), value: '0' },
    ]));
    const j = must(await helperIn(L2)(['simulate', rel]), 'simulate');
    eq(j.count, 2); eq(j.calls.map((c) => c[2]), ['0x1', '0x1'], JSON.stringify(j.calls)); eq(j.all_success, true);
    ok(j.calls[0][3] > 100000 && j.calls[1][3] > 1000000, `gas ${j.calls.map((c) => c[3])}`);
    eq(j.pending_nonce, 0); eq(j.overrides_active, true);
    ok(j.calls.every((c) => c[4] >= c[3] && c[5] === Math.min(Math.ceil(c[4] * 1.2), 16777216)), 'gas_limit = ceil(maxUsedGas x 1.2) from the same answer (the RPC returns maxUsedGas)');
  });
  await lt('clearance: the realistic sequence (approve, parent split, approve bundle, middle split), all 0x1', async () => {
    const L3 = makeLayout('live-sim4', liveCfg({ simulationOverrides: baseOv }));
    const rel = writeRunFile(L3, 'sim4', 'txs.json', JSON.stringify([
      { ...approve(A.sUSDS, M) }, { to: A.router, data: split(A.parent, M) }, { ...approve(A.bundleA, M) }, { to: A.router, data: split(A.middleA, M) },
    ]));
    const j = must(await helperIn(L3)(['simulate', rel]), 'simulate');
    eq(j.calls.map((c) => c[2]), ['0x1', '0x1', '0x1', '0x1'], JSON.stringify(j.calls));
    // negative controls: the same middle split alone does not pass, so state really chains across entries
    const rel2 = writeRunFile(L3, 'sim4', 'alone.json', JSON.stringify([{ to: A.router, data: split(A.middleA, M) }]));
    await sleep(800);
    const j2 = must(await helperIn(L3)(['simulate', rel2]), 'simulate alone');
    eq(j2.all_success, false); eq(j2.calls[0][2], '0x0');
    // and a split with no approval fails with the token's own reason
    const rel3 = writeRunFile(L3, 'sim4', 'noappr.json', JSON.stringify([{ to: A.router, data: split(A.parent, M) }]));
    await sleep(800);
    const j3 = must(await helperIn(L3)(['simulate', rel3]), 'simulate noappr');
    eq(j3.calls[0][2], '0x0'); ok(/allowance/.test(j3.failures[0].revert_reason || j3.failures[0].error || ''), JSON.stringify(j3.failures[0]));
  });
  await lt('clearance: without the config overrides the same sequence honestly fails (the overrides are what make it pass)', async () => {
    const rel = writeRunFile(L, 'sim5', 'txs.json', JSON.stringify([{ ...approve(A.sUSDS, M) }, { to: A.router, data: split(A.parent, M) }]));
    const j = must(await H(['simulate', rel]), 'simulate');
    eq(j.calls[0][2], '0x1'); eq(j.calls[1][2], '0x0'); eq(j.all_success, false); ok(!('overrides_active' in j));
  });

  // grouped simulate (K2): one blockStateCalls entry per keep-whole group, state carrying from group to group
  const grp = (...calls) => ({ calls });
  const splitTx = (market) => ({ to: A.router, data: split(market, M), value: '0' });
  const allowOv = { ...baseOv, erc20Allowances: [
    { token: A.sUSDS, owner: THROWAWAY, spender: A.router, amount: 'max', slot: 3 },
    { token: A.bundleA, owner: THROWAWAY, spender: A.router, amount: 'max', slot: 4 },
  ] };
  const checkGrouped = (j, groupsCol) => {
    eq(j.input, 'groups'); eq(j.entries, 2); eq(j.count, groupsCol.length); eq(j.pending_nonce, 0);
    eq(j.calls.map((c) => c[2]), groupsCol.map(() => '0x1'), JSON.stringify(j.calls)); eq(j.all_success, true); eq(j.failed_count, 0); eq(j.over_cap_count, 0);
    eq(j.calls.map((c) => c[1]), groupsCol, 'group index per call'); eq(j.calls.map((c) => c[0]), groupsCol.map((_, i) => i), 'global call index');
    ok(j.calls.every((c) => c[4] !== null && c[4] >= c[3]), `maxUsedGas is present and at least gasUsed: ${JSON.stringify(j.calls)}`);
    ok(j.calls.every((c) => c[5] === Math.min(Math.ceil(c[4] * 1.2), 16777216)), 'gas_limit = ceil(maxUsedGas x 1.2) taken from the same answer');
  };
  await lt('clearance (groups): a two-group dependent sequence with config overrides, both 0x1 and maxUsedGas present; the second group alone fails', async () => {
    const L5 = makeLayout('live-sim-groups', liveCfg({ simulationOverrides: allowOv }));
    const rel = writeRunFile(L5, 'g1', 'groups.json', JSON.stringify([grp(splitTx(A.parent)), grp(splitTx(A.middleA))]));
    const j = must(await helperIn(L5)(['simulate', rel]), 'simulate groups');
    checkGrouped(j, [0, 1]); eq(j.overrides_active, true);
    ok(j.calls[0][3] > 100000 && j.calls[1][3] > 1000000, `gas ${j.calls.map((c) => c[3])}`);
    ok(j.calls.every((c) => c[4] > c[3]), 'a Router split peaks above its net gasUsed (refund cap), so a limit of gasUsed x 1.2 is not safe');
    console.log(`      (parent split gasUsed ${j.calls[0][3]} maxUsedGas ${j.calls[0][4]} limit ${j.calls[0][5]}; middle split gasUsed ${j.calls[1][3]} maxUsedGas ${j.calls[1][4]} limit ${j.calls[1][5]}; ${JSON.stringify(j).length} chars)`);
    // negative control: the same second group alone does not pass, so state really carries from group 0 into group 1
    const rel2 = writeRunFile(L5, 'g1', 'alone.json', JSON.stringify([grp(splitTx(A.middleA))]));
    await sleep(800);
    const j2 = must(await helperIn(L5)(['simulate', rel2]), 'simulate group alone');
    eq(j2.all_success, false); eq(j2.calls[0][2], '0x0'); eq(j2.first_failed_group, 0);
  });
  await lt('clearance (groups): the realistic sequence as two groups of two calls (approve, parent split | approve bundle, middle split), all 0x1', async () => {
    const L6 = makeLayout('live-sim-groups2', liveCfg({ simulationOverrides: baseOv }));
    const rel = writeRunFile(L6, 'g2', 'groups.json', JSON.stringify([
      grp(approve(A.sUSDS, M), splitTx(A.parent)),
      grp(approve(A.bundleA, M), splitTx(A.middleA)),
    ]));
    const j = must(await helperIn(L6)(['simulate', rel]), 'simulate groups');
    checkGrouped(j, [0, 0, 1, 1]);
    // the flat form of the same four transactions gives the same gas
    const relFlat = writeRunFile(L6, 'g2', 'flat.json', JSON.stringify([approve(A.sUSDS, M), splitTx(A.parent), approve(A.bundleA, M), splitTx(A.middleA)]));
    await sleep(800);
    const f = must(await helperIn(L6)(['simulate', relFlat]), 'simulate flat');
    eq(f.input, 'flat'); eq(f.calls.map((c) => c[2]), ['0x1', '0x1', '0x1', '0x1']);
    eq(f.calls.map((c) => c[3]), j.calls.map((c) => c[3]), 'gasUsed is the same whether the calls are grouped or each is its own block');
  });
  await lt('clearance (groups) on the second public RPC: the same two-group dependent sequence, both 0x1, maxUsedGas present', async () => {
    const L7 = makeLayout('live-sim-groups-indep', { chainId: 10, rpcUrl: INDEP_RPC, dataFunctionUrl: LIVE_DATA, signerAddress: THROWAWAY, simulationOverrides: allowOv });
    const rel = writeRunFile(L7, 'g3', 'groups.json', JSON.stringify([grp(splitTx(A.parent)), grp(splitTx(A.middleA))]));
    const j = must(await helperIn(L7)(['simulate', rel]), 'simulate groups on the second RPC');
    checkGrouped(j, [0, 1]);
  });
  await lt('a 374-call plan in 100 groups goes out as ONE request on both public RPCs and the page stays under the 28000 cap', async () => {
    const sizes = [...Array(74).fill(4), ...Array(26).fill(3)];
    let n = 0;
    const plan = sizes.map((k) => grp(...Array.from({ length: k }, () => ({ to: A.sUSDS, data: approve(A.sUSDS, BigInt(++n)).data, value: '0' }))));
    eq(n, 374);
    for (const [label, cfgOverride] of [['mainnet.optimism.io', {}], ['optimism-rpc.publicnode.com', { rpcUrl: INDEP_RPC }]]) {
      const L8 = makeLayout('live-374', liveCfg(cfgOverride));
      const rel = writeRunFile(L8, 'g374', 'plan.json', JSON.stringify(plan));
      const r = await helperIn(L8)(['simulate', rel]);
      const j = must(r, `simulate 374 calls on ${label}`);
      eq(j.input, 'groups'); eq(j.entries, 100); eq(j.count, 374); eq(j.calls.length, 374); eq(j.all_success, true, JSON.stringify(j.failures || j.calls.slice(0, 3)));
      eq(j.calls[373].slice(0, 3), [373, 99, '0x1']); ok(j.calls.every((c) => c[4] !== null && c[5] === Math.min(Math.ceil(c[4] * 1.2), 16777216)));
      ok(r.stdout.length < 28000, `page is ${r.stdout.length}`);
      console.log(`      (${label}: 374 approve calls in 100 groups, one eth_simulateV1 request, page ${r.stdout.length} chars, total gasUsed ${j.calls.reduce((a, c) => a + c[3], 0)})`);
      await sleep(1500);
    }
  });
  // simulate "return": true: the probe of G section 3 (a quote on the state an earlier group leaves). Read-only: nothing is sent.
  await lt('simulate "return": true: a two-group simulation with config overrides, group 2 holding a QuoterV2 quote (WETH/USDC fee 500) flagged "return": true, returns an amountOut equal to a plain eth_call quote at the same block, and the balance the earlier group left', async () => {
    const WETH = '0x4200000000000000000000000000000000000006';
    const USDC = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'; // native USDC on Optimism
    const FEE = 500;
    const pool = (await indepCall(A.factory, 'function getPool(address,address,uint24) view returns (address)', [WETH, USDC, FEE]))[0];
    ok(pool !== ethers.ZeroAddress, 'the WETH/USDC fee-500 pool exists');
    const wi = new ethers.Interface(['function deposit() payable', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)']);
    const qi = new ethers.Interface(['function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
    const mi = new ethers.Interface(['function getBlockNumber() view returns (uint256)']);
    const quoteData = qi.encodeFunctionData('quoteExactInputSingle', [[WETH, USDC, 10n ** 18n, FEE, 0n]]);
    const dep = 10n ** 15n;
    const L9 = makeLayout('live-sim-return', liveCfg({ simulationOverrides: { balances: { [THROWAWAY]: (10n ** 18n).toString() } } }));
    // group 0 needs the ETH override (deposit sends value); group 1 reads the state group 0 left. It does not touch the pool, so its quote
    // must equal a plain quote on the same base block. The unflagged totalSupply call must not appear in `returns`.
    const plan = [
      grp({ to: WETH, data: wi.encodeFunctionData('deposit'), value: dep.toString() }, { to: WETH, data: wi.encodeFunctionData('approve', [A.quoter, dep]) }),
      grp(
        { to: A.mc3, data: mi.encodeFunctionData('getBlockNumber'), return: true },
        { to: WETH, data: wi.encodeFunctionData('totalSupply') },
        { to: A.quoter, data: quoteData, return: true },
        { to: WETH, data: wi.encodeFunctionData('balanceOf', [THROWAWAY]), return: true },
      ),
    ];
    const r = await helperIn(L9)(['simulate', writeRunFile(L9, 'ret1', 'probe.json', JSON.stringify(plan))]);
    const j = must(r, 'simulate with return');
    eq(j.input, 'groups'); eq(j.entries, 2); eq(j.count, 6); eq(j.all_success, true, JSON.stringify(j.failures || j.calls)); eq(j.overrides_active, true);
    eq(j.returns.map((x) => [x.index, x.group]), [[2, 1], [4, 1], [5, 1]], 'only the flagged calls, with their plan index and group');
    ok(j.returns.every((x) => /^0x[0-9a-f]*$/.test(x.return_data)));
    ok(r.stdout.length < 28000);
    // the simulation's entries are blocks base+1 and base+2 (measured on both public RPCs); group 1 reports its own block number
    const simBlock = BigInt(j.returns[0].return_data) - 2n;
    const latest = BigInt(await indepRpc('eth_blockNumber', []));
    ok(simBlock <= latest + 3n && latest - simBlock < 60n, `simulated base block ${simBlock} vs latest ${latest}`);
    const sim = qi.decodeFunctionResult('quoteExactInputSingle', j.returns[1].return_data);
    ok(sim[0] > 0n, 'positive amountOut');
    await sleep(2500); // let the second endpoint see the base block
    const plainRaw = await indepRpc('eth_call', [{ to: A.quoter, data: quoteData }, ethers.toBeHex(simBlock)]);
    const plain = qi.decodeFunctionResult('quoteExactInputSingle', plainRaw);
    eq(sim[0].toString(), plain[0].toString(), 'amountOut: the probe quote equals a plain eth_call quote at the same block');
    eq(sim[1].toString(), plain[1].toString(), 'sqrtPriceX96After'); eq(sim[2].toString(), plain[2].toString(), 'initializedTicksCrossed'); // gasEstimate is gasleft()-based and may differ
    // the probe sees the state group 0 left; a plain call at the base block does not
    eq(BigInt(j.returns[2].return_data).toString(), dep.toString(), 'balanceOf after group 0');
    const plainBal = wi.decodeFunctionResult('balanceOf', await indepRpc('eth_call', [{ to: WETH, data: wi.encodeFunctionData('balanceOf', [THROWAWAY]) }, ethers.toBeHex(simBlock)]));
    eq(plainBal[0].toString(), '0', 'negative control: at the base block the holder has no WETH, so `returns` really carries the state of the earlier group');
    console.log(`      (base block ${simBlock}: simulated quote amountOut ${sim[0]} sqrtPriceX96After ${sim[1]} ticksCrossed ${sim[2]} = plain eth_call quote at the same block; page ${r.stdout.length} chars)`);
  });
  await lt('measured RPC limits (raw requests, not through the helper): 256 blockStateCalls entries are accepted and 257 give -38026 on both public RPCs', async () => {
    const post = async (url, entries) => {
      const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: Array.from({ length: entries }, () => ({ calls: [{ from: THROWAWAY, to: A.sUSDS, data: '0x', value: '0x0' }] })), validation: false }, 'latest'] };
      let last;
      for (let i = 0; i < 4; i++) {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
        last = await res.json();
        if (!(last.error && /rate.?limit|too many requests/i.test(String(last.error.message)))) return last;
        await sleep(2000);
      }
      return last;
    };
    for (const url of [LIVE_RPC, INDEP_RPC]) {
      const a = await post(url, 256);
      ok(!a.error && Array.isArray(a.result) && a.result.length === 256, `${url}: 256 entries: ${JSON.stringify(a.error || a.result.length)}`);
      await sleep(800);
      const b = await post(url, 257);
      ok(b.error && b.error.code === -38026 && /too many blocks/i.test(b.error.message), `${url}: 257 entries: ${JSON.stringify(b.error || 'accepted')}`);
      await sleep(800);
    }
  });

  await lt('tx and receipt against an independent read of a recent mined transaction', async () => {
    const blk = await indepRpc('eth_getBlockByNumber', ['latest', true]);
    const t = blk.transactions.find((x, i) => i > 0 && x.type === '0x2' && x.input.length > 10);
    if (!t) skip('no suitable transaction in the latest block');
    fs.mkdirSync(L.run('live2'), { recursive: true });
    const j = must(await H(['tx', t.hash, 'live2']));
    eq(j.from.toLowerCase(), t.from.toLowerCase()); eq(j.nonce, Number(BigInt(t.nonce))); eq((j.to || '').toLowerCase(), t.to.toLowerCase()); eq(j.value, BigInt(t.value).toString());
    eq(j.input_bytes, (t.input.length - 2) / 2); eq(j.input_keccak256, ethers.keccak256(t.input));
    eq(fs.readFileSync(path.join(L.run('live2'), `tx-${t.hash.toLowerCase()}.input`), 'utf8'), t.input);
    await sleep(400);
    const k = must(await H(['keccak256', `run/live2/tx-${t.hash.toLowerCase()}.input`]));
    eq(k.keccak256, ethers.keccak256(t.input));
    await sleep(400);
    const r = must(await H(['receipt', t.hash]));
    eq(r.found, true); eq(r.block_number, Number(BigInt(t.blockNumber)));
    await sleep(400);
    const b = must(await H(['block', String(Number(BigInt(t.blockNumber))), t.from]));
    ok(b.txs_from.some((x) => x.hash.toLowerCase() === t.hash.toLowerCase() && x.input_keccak256 === ethers.keccak256(t.input)), 'block scan finds the transaction by sender');
  });
}

// ========================================================================================================

(async () => {
  console.log(`chain-helper tests (${OFFLINE ? 'offline only' : 'offline + live read-only'}); scratch: ${ROOT}`);
  await offline();
  if (!OFFLINE) await live(); else console.log('SKIP  live tests (--offline)');
  console.log(`\n${results.PASS} passed, ${results.FAIL} failed, ${results.SKIP} skipped`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave scratch behind */ }
  process.exit(results.FAIL === 0 ? 0 : 1);
})().catch((e) => { console.error('test run crashed:', e); process.exit(2); });
