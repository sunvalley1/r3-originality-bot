#!/usr/bin/env node
'use strict';
/*
 * chain-helper.cjs - read-only chain helper for the deep-r3-trade skill (reference implementation).
 *
 * It reads. It never signs, never sends and never touches key material:
 *   - a FIXED JSON-RPC method list (ALLOWED_METHODS); every request goes through rpcBatch(), which refuses
 *     anything else before a socket is opened;
 *   - no URL, endpoint, header or output-path argument: the RPC endpoint, the data-function URL, the chain id
 *     and the pinned signer address live in chain-helper.config.json NEXT TO THIS FILE (path derived from
 *     __filename, never from argv or the environment) and must sit outside the project folder;
 *   - file arguments are confined to ./run/<run-id>/ (see parseRunPath / resolveRunFile);
 *   - the only files it ever writes are ./run/<run-id>/r3-data.json and ./run/<run-id>/tx-<hash>.input.
 *
 * Beyond the spec's subcommand list (all read-only, no new method, no new write path, no new network target):
 * `code`, `data-rows` and `multicall`, `block <n> <address>`, `@run/<run-id>/<file>` argument files, and the
 * grouped form of `simulate` (one blockStateCalls entry per group of calls), and the `"return": true` flag on a
 * `simulate` call (its returnData is printed in a compact `returns` list). See chain-helper.README.md.
 *
 * Output: exactly one JSON object on stdout. On failure the object is {"error": "...", "code": "..."} and the
 * exit status is non-zero (see EXIT below). Output is never silently truncated: an object longer than
 * MAX_OUTPUT_CHARS is replaced by an output_too_large error.
 *
 * Plain Node 22, CommonJS. Only dependency: ethers 6.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ethers } = require('ethers');

// ---------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------

const CONFIG_NAME = 'chain-helper.config.json';
const EXPECTED_CHAIN_ID = 10;
const DATA_FUNCTION_PATH = '/.netlify/functions/get-originality-r3-v3-markets-data';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const GAS_CAP = 16777216; // 2^24, Optimism's per-transaction ceiling (G section 8)
const MAX_OUTPUT_CHARS = 28000; // tool output is truncated around 30k characters
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SIM_RESPONSE_BYTES = 96 * 1024 * 1024; // eth_simulateV1 echoes every block and log
const MAX_DATA_BYTES = 16 * 1024 * 1024;
const MAX_RUN_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FAIL_DETAIL = 8; // simulate keeps error text for this many failing calls
const MAX_SIM_ENTRIES = 256; // geth's maxSimulateBlocks: one blockStateCalls entry per group (or per transaction in a flat list)
const MAX_SIM_CALLS = 500; // calls per simulate request, so the compact page (about 46 characters a call, worst case) stays under MAX_OUTPUT_CHARS
const MAX_SIM_RETURNS = 20; // calls flagged "return": true per simulate request
const MAX_SIM_RETURN_HEX = 2048; // hex digits (after 0x) of one flagged call's return_data: 1024 bytes
const MAX_BATCH_ITEMS = 9; // plus the eth_chainId probe = 10, the public endpoint's batch limit
const MAX_RETRIES = 3;
const MAX_ROWS = 30;

// The fixed method list. Nothing else is ever sent. Never eth_send*, eth_sign*, personal_*, wallet_*.
const ALLOWED_METHODS = Object.freeze([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getBlockByNumber',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_call',
  'eth_getCode',
  'eth_getLogs',
  'eth_simulateV1',
]);
const ALLOWED_SET = new Set(ALLOWED_METHODS);

const EXIT = Object.freeze({ GENERIC: 1, USAGE: 2, CONFIG: 3, PATH: 4, NET: 5, FORBIDDEN: 6, TOO_BIG: 7, REVERT: 8 });

const CONFIG_KEYS = new Set([
  'chainId', 'rpcUrl', 'dataFunctionUrl', 'signerAddress', 'simulationOverrides', 'requestTimeoutMs', 'retryBaseDelayMs',
]);

class HelperError extends Error {
  constructor(code, message, exit = EXIT.GENERIC, extra = undefined) {
    super(message);
    this.code = code;
    this.exit = exit;
    this.extra = extra;
  }
}

const bad = (message) => new HelperError('bad_argument', message, EXIT.USAGE);

function clip(value, n = 300) {
  return String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, n);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------
// Config (next to this file, fail closed)
// ---------------------------------------------------------------------------------------------------------

function isLoopbackHost(h) {
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
}

function checkUrl(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
    throw new HelperError('config_malformed', `${label} must be a URL string`, EXIT.CONFIG);
  }
  let u;
  try { u = new URL(value); } catch { throw new HelperError('config_malformed', `${label} is not a URL`, EXIT.CONFIG); }
  const okProto = u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname));
  if (!okProto) throw new HelperError('config_malformed', `${label} must be https (http only for loopback)`, EXIT.CONFIG);
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(value)) throw new HelperError('config_malformed', `${label} must not carry credentials`, EXIT.CONFIG);
  return u;
}

function parseUint256(v, label) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && (/^\d+$/.test(v) || /^0x[0-9a-fA-F]+$/.test(v))) {
    const b = BigInt(v);
    if (b < 2n ** 256n) return b;
  }
  throw new HelperError('config_malformed', `${label} must be a uint256 (decimal or 0x string)`, EXIT.CONFIG);
}

function parseSlot(v, label) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  throw new HelperError('config_malformed', `${label} must be a storage slot (integer or 0x hex)`, EXIT.CONFIG);
}

function cfgAddress(v, label) {
  try { return ethers.getAddress(String(v)); } catch { throw new HelperError('config_malformed', `${label} is not an address`, EXIT.CONFIG); }
}

function onlyKeys(obj, allowed, label) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new HelperError('config_malformed', `${label} must be an object`, EXIT.CONFIG);
  }
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new HelperError('config_malformed', `${label}: unknown key ${clip(k, 40)}`, EXIT.CONFIG);
  }
}

// simulationOverrides: config-only, for tests and dry runs. Solidity mapping layout only.
function validateOverrides(ov) {
  onlyKeys(ov, ['balances', 'erc20Balances', 'erc20Allowances'], 'simulationOverrides');
  const out = { balances: {}, erc20Balances: [], erc20Allowances: [] };
  if (ov.balances !== undefined) {
    onlyKeys(ov.balances, Object.keys(ov.balances), 'simulationOverrides.balances');
    for (const [a, wei] of Object.entries(ov.balances)) {
      out.balances[cfgAddress(a, 'simulationOverrides.balances key')] = parseUint256(wei, 'simulationOverrides.balances value');
    }
  }
  const list = (name, keys, build) => {
    if (ov[name] === undefined) return;
    if (!Array.isArray(ov[name])) throw new HelperError('config_malformed', `simulationOverrides.${name} must be an array`, EXIT.CONFIG);
    for (const e of ov[name]) { onlyKeys(e, keys, `simulationOverrides.${name}[]`); out[name].push(build(e)); }
  };
  list('erc20Balances', ['token', 'holder', 'amount', 'slot'], (e) => ({
    token: cfgAddress(e.token, 'erc20Balances.token'),
    holder: cfgAddress(e.holder, 'erc20Balances.holder'),
    amount: parseUint256(e.amount, 'erc20Balances.amount'),
    slot: parseSlot(e.slot, 'erc20Balances.slot'),
  }));
  list('erc20Allowances', ['token', 'owner', 'spender', 'amount', 'slot'], (e) => ({
    token: cfgAddress(e.token, 'erc20Allowances.token'),
    owner: cfgAddress(e.owner, 'erc20Allowances.owner'),
    spender: cfgAddress(e.spender, 'erc20Allowances.spender'),
    amount: e.amount === 'max' ? 2n ** 256n - 1n : parseUint256(e.amount, 'erc20Allowances.amount'),
    slot: parseSlot(e.slot, 'erc20Allowances.slot'),
  }));
  return out;
}

function insideDir(base, target) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const b = norm(base).replace(/[\\/]+$/, '');
  const t = norm(target);
  return t === b || t.startsWith(b + path.sep);
}

function loadConfigFrom(dir) {
  const file = path.join(dir, CONFIG_NAME);
  let st;
  try { st = fs.lstatSync(file); } catch {
    throw new HelperError('config_missing', `config file not found next to the helper (${CONFIG_NAME})`, EXIT.CONFIG);
  }
  if (!st.isFile() || st.isSymbolicLink()) throw new HelperError('config_malformed', 'config must be a regular file', EXIT.CONFIG);
  if (st.size > 65536) throw new HelperError('config_malformed', 'config is too large', EXIT.CONFIG);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    throw new HelperError('config_malformed', 'config is not valid JSON', EXIT.CONFIG);
  }
  onlyKeys(raw, [...CONFIG_KEYS], 'config');
  if (raw.chainId !== EXPECTED_CHAIN_ID) throw new HelperError('config_malformed', `chainId must be ${EXPECTED_CHAIN_ID}`, EXIT.CONFIG);
  const rpc = checkUrl(raw.rpcUrl, 'rpcUrl');
  const data = checkUrl(raw.dataFunctionUrl, 'dataFunctionUrl');
  if (data.pathname !== DATA_FUNCTION_PATH || data.search || data.hash) {
    throw new HelperError('config_malformed', `dataFunctionUrl must end with ${DATA_FUNCTION_PATH} and carry no query`, EXIT.CONFIG);
  }
  const signerAddress = cfgAddress(raw.signerAddress, 'signerAddress');
  if (signerAddress === ethers.ZeroAddress) throw new HelperError('config_malformed', 'signerAddress is the zero address placeholder', EXIT.CONFIG);
  const num = (v, def, lo, hi, label) => {
    if (v === undefined) return def;
    if (!Number.isInteger(v) || v < lo || v > hi) throw new HelperError('config_malformed', `${label} must be an integer in ${lo}..${hi}`, EXIT.CONFIG);
    return v;
  };
  const cfg = {
    chainId: EXPECTED_CHAIN_ID,
    rpcUrl: rpc.toString(),
    dataFunctionUrl: data.toString(),
    signerAddress,
    requestTimeoutMs: num(raw.requestTimeoutMs, 30000, 1000, 120000, 'requestTimeoutMs'),
    retryBaseDelayMs: num(raw.retryBaseDelayMs, 1000, 0, 10000, 'retryBaseDelayMs'),
    overrides: raw.simulationOverrides === undefined ? null : validateOverrides(raw.simulationOverrides),
  };
  // "outside the project folder": the project folder is the current directory (where ./run lives).
  let realDir; let realCwd;
  try { realDir = fs.realpathSync.native(dir); realCwd = fs.realpathSync.native(process.cwd()); } catch {
    throw new HelperError('config_malformed', 'cannot resolve the helper folder', EXIT.CONFIG);
  }
  if (insideDir(realCwd, realDir)) {
    throw new HelperError('config_inside_project', 'the helper and its config must live outside the project folder (current directory)', EXIT.CONFIG);
  }
  return cfg;
}

function loadConfig() {
  // Path comes from __filename only; no env var, no argv.
  return loadConfigFrom(path.dirname(__filename));
}

// ---------------------------------------------------------------------------------------------------------
// Path confinement: every file argument is run/<run-id>/<name...> relative to the current directory
// ---------------------------------------------------------------------------------------------------------

const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
const COMPONENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function pathErr(code, message) {
  return new HelperError(code, `path refused: ${message}`, EXIT.PATH);
}

function validateRunId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 100 || !RUN_ID_RE.test(id)) {
    throw new HelperError('bad_run_id', 'run-id must match [A-Za-z0-9._-]+', EXIT.PATH);
  }
  if (id.startsWith('.') || id.endsWith('.') || WIN_RESERVED_RE.test(id)) {
    throw new HelperError('bad_run_id', 'run-id must not start or end with a dot or be a reserved device name', EXIT.PATH);
  }
  return id;
}

function parseRunPath(arg) {
  if (typeof arg !== 'string' || arg === '') throw pathErr('path_empty', 'empty path');
  if (arg.includes('\0')) throw pathErr('path_nul', 'NUL byte');
  if (arg.length > 240) throw pathErr('path_too_long', 'path too long');
  if (/^[\\/]{2}/.test(arg)) throw pathErr('path_unc', 'UNC or device path');
  if (/^[A-Za-z]:/.test(arg)) throw pathErr('path_drive', 'drive letter');
  if (/^[\\/]/.test(arg) || path.posix.isAbsolute(arg) || path.win32.isAbsolute(arg)) throw pathErr('path_absolute', 'absolute path');
  if (arg.includes(':')) throw pathErr('path_colon', 'colon in path (alternate data stream)');
  const parts = arg.replace(/\\/g, '/').split('/');
  if (parts[0] === '.') parts.shift();
  if (parts.some((p) => p === '..')) throw pathErr('path_traversal', '".." component');
  if (parts.some((p) => p === '' || p === '.')) throw pathErr('path_malformed', 'empty or "." component');
  if (parts[0] !== 'run') throw pathErr('path_outside_run', 'must start with run/<run-id>/');
  if (parts.length < 3) throw pathErr('path_too_short', 'need run/<run-id>/<file>');
  validateRunId(parts[1]);
  const rel = parts.slice(2);
  for (const c of rel) {
    if (c.length > 100 || !COMPONENT_RE.test(c) || c.endsWith('.') || WIN_RESERVED_RE.test(c)) {
      throw pathErr('path_component', `unacceptable component ${clip(c, 40)}`);
    }
  }
  return { runId: parts[1], rel };
}

function realRunBase() {
  try { return fs.realpathSync.native(path.join(process.cwd(), 'run')); } catch {
    throw new HelperError('run_dir_missing', './run does not exist in the current directory (run from the project root)', EXIT.PATH);
  }
}

// Resolve a confined, existing, regular file. Refuses any symlink or junction on the way.
function resolveRunFile(arg) {
  const { runId, rel } = parseRunPath(arg);
  const base = realRunBase();
  let cur = base;
  for (const comp of [runId, ...rel]) {
    cur = path.join(cur, comp);
    let st;
    try { st = fs.lstatSync(cur); } catch { throw pathErr('path_not_found', 'no such file'); }
    if (st.isSymbolicLink()) throw pathErr('path_symlink', 'symlink or junction in path');
  }
  const st = fs.lstatSync(cur);
  if (!st.isFile()) throw pathErr('path_not_file', 'not a regular file');
  const real = fs.realpathSync.native(cur);
  if (!insideDir(path.join(base, runId), real)) throw pathErr('path_escape', 'resolves outside ./run/<run-id>/');
  return { abs: real, size: st.size, runId, rel };
}

function readRunFile(arg, maxBytes = MAX_RUN_FILE_BYTES) {
  const f = resolveRunFile(arg);
  if (f.size > maxBytes) throw pathErr('path_file_too_large', `file larger than ${maxBytes} bytes`);
  const fd = fs.openSync(f.abs, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) throw pathErr('path_not_file', 'not a regular file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

// The run-id folder for the two permitted writes. ./run must already exist; only the run-id folder is created
// (create=false only checks, so a refusal happens before any network traffic).
function resolveRunDirForWrite(runId, create = true) {
  validateRunId(runId);
  const base = realRunBase();
  const dir = path.join(base, runId);
  let st = null;
  try { st = fs.lstatSync(dir); } catch { st = null; }
  if (st === null) {
    if (!create) return dir;
    fs.mkdirSync(dir);
  } else if (st.isSymbolicLink()) throw pathErr('path_symlink', 'run-id folder is a symlink or junction');
  else if (!st.isDirectory()) throw pathErr('path_not_dir', 'run-id path is not a folder');
  const real = fs.realpathSync.native(dir);
  if (!insideDir(base, real) || real === base) throw pathErr('path_escape', 'run-id folder resolves outside ./run');
  return real;
}

function assertWritableName(name) {
  if (name !== 'r3-data.json' && !/^tx-0x[0-9a-f]{64}\.input$/.test(name)) {
    throw new HelperError('internal', 'refusing to write an unlisted file name', EXIT.PATH);
  }
}

function checkTarget(target) {
  let st = null;
  try { st = fs.lstatSync(target); } catch { st = null; }
  if (st && (st.isSymbolicLink() || !st.isFile())) throw pathErr('path_symlink', 'target exists and is not a plain file');
}

// Refuse before any network traffic when the destination is unusable (nothing is created).
function precheckWrite(runId, name) {
  assertWritableName(name);
  const dir = resolveRunDirForWrite(runId, false);
  checkTarget(path.join(dir, name));
}

function writeRunFile(runId, name, buffer) {
  assertWritableName(name);
  const dir = resolveRunDirForWrite(runId);
  const target = path.join(dir, name);
  checkTarget(target);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(target, flags, 0o644);
  try {
    let off = 0;
    while (off < buffer.length) off += fs.writeSync(fd, buffer, off, buffer.length - off);
  } catch (e) {
    try { fs.closeSync(fd); fs.unlinkSync(target); } catch { /* best effort */ }
    throw e;
  }
  fs.closeSync(fd);
  return { path: `run/${runId}/${name}`, abs: target };
}

// ---------------------------------------------------------------------------------------------------------
// HTTP + JSON-RPC: the single choke point
// ---------------------------------------------------------------------------------------------------------

async function readCapped(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new HelperError('response_too_large', `response larger than ${maxBytes} bytes`, EXIT.NET);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function backoffMs(cfg, attempt, retryAfterHeader) {
  let d = Math.min(cfg.retryBaseDelayMs * 2 ** (attempt - 1), 8000);
  const ra = Number(retryAfterHeader);
  if (Number.isFinite(ra) && ra > 0) d = Math.max(d, Math.min(ra * 1000, 8000));
  return d;
}

async function postJson(cfg, payload, maxBytes) {
  let lastErr = null;
  let retryAfter = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoffMs(cfg, attempt, retryAfter));
    let res;
    try {
      res = await fetch(cfg.rpcUrl, {
        method: 'POST',
        redirect: 'error', // a redirect would be an unpinned URL
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(cfg.requestTimeoutMs),
      });
    } catch (e) {
      lastErr = new HelperError('rpc_unreachable', `RPC request failed: ${clip(e && e.cause && e.cause.message ? e.cause.message : e.message, 120)}`, EXIT.NET);
      continue;
    }
    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      retryAfter = res.headers.get('retry-after');
      try { await res.body.cancel(); } catch { /* ignore */ }
      lastErr = new HelperError('rpc_rate_limited', `RPC answered HTTP ${res.status} after ${attempt + 1} attempt(s)`, EXIT.NET, { http_status: res.status });
      continue;
    }
    const text = (await readCapped(res, maxBytes)).toString('utf8');
    if (!res.ok) {
      throw new HelperError('rpc_http', `RPC answered HTTP ${res.status}: ${clip(text, 200)}`, EXIT.NET, { http_status: res.status });
    }
    try { return JSON.parse(text); } catch {
      throw new HelperError('rpc_malformed', 'RPC answered with invalid JSON', EXIT.NET);
    }
  }
  throw lastErr;
}

function assertMethodAllowed(method, params) {
  if (typeof method !== 'string' || !ALLOWED_SET.has(method)) {
    throw new HelperError('forbidden_method', `method not on the fixed read-only list: ${clip(method, 60)}`, EXIT.FORBIDDEN);
  }
  if (method === 'eth_getTransactionCount' && !(Array.isArray(params) && (params[1] === 'latest' || params[1] === 'pending'))) {
    throw new HelperError('forbidden_method', 'eth_getTransactionCount is allowed for latest and pending only', EXIT.FORBIDDEN);
  }
  if (method === 'eth_getBlockByNumber' && !(Array.isArray(params) && (params[0] === 'latest' || /^0x[0-9a-f]+$/.test(String(params[0]))))) {
    throw new HelperError('forbidden_method', 'eth_getBlockByNumber takes latest or a hex number', EXIT.FORBIDDEN);
  }
}

// calls: [{method, params}]. Returns the raw {result|error} element per call, in order. An eth_chainId probe rides
// in every request and a mismatch with the configured chain id is fatal.
// Transient answers worth a back-off and another try: a rate limit, or a provider with no healthy backend (-32011).
// eth_simulateV1's own errors (-38000 to -38999: too many blocks, gas budget, "Block gas limit exceeded ...") are never
// transient, so they are never retried as a rate limit.
const isSimulateErrorCode = (code) => typeof code === 'number' && code <= -38000 && code > -39000;
const isRateLimitEl = (el) => !!(el && el.error && !isSimulateErrorCode(el.error.code) && (el.error.code === -32005 || el.error.code === -32011
  || /rate.?limit|too many requests|limit exceeded|no backend is currently healthy/i.test(String(el.error.message))));

async function rpcBatch(cfg, calls, opts = {}) {
  for (const c of calls) assertMethodAllowed(c.method, c.params);
  if (calls.length > MAX_BATCH_ITEMS) throw new HelperError('internal', 'batch too large', EXIT.GENERIC);
  let out;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoffMs(cfg, attempt, null));
    out = await rpcBatchOnce(cfg, calls, opts);
    if (!out.some(isRateLimitEl)) return out;
  }
  const last = out.find(isRateLimitEl);
  throw new HelperError('rpc_rate_limited', `RPC kept answering with a transient error (rate limit or no healthy backend): ${clip(last.error.message, 120)}`, EXIT.NET);
}

async function rpcBatchOnce(cfg, calls, opts) {
  const maxBytes = opts.maxBytes || MAX_RESPONSE_BYTES;
  const wire = [{ jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] }]
    .concat(calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params || [] })));
  let items;
  let batchRefused = false;
  try {
    const answer = await postJson(cfg, wire, maxBytes);
    if (Array.isArray(answer)) items = answer;
    else batchRefused = true; // a JSON-RPC error object: the endpoint does not take batches
  } catch (e) {
    if (e instanceof HelperError && e.code === 'rpc_http' && e.extra && (e.extra.http_status === 400 || e.extra.http_status === 413)) batchRefused = true;
    else throw e;
  }
  if (batchRefused) {
    items = [];
    for (const w of wire) {
      const one = await postJson(cfg, w, maxBytes);
      if (!one || typeof one !== 'object' || Array.isArray(one)) throw new HelperError('rpc_malformed', 'RPC answered with an unexpected shape', EXIT.NET);
      items.push(one);
    }
  }
  const byId = new Map();
  for (const it of items) if (it && typeof it === 'object') byId.set(it.id, it);
  const probe = byId.get(0);
  if (!probe || probe.error || typeof probe.result !== 'string') {
    throw new HelperError('rpc_error', `eth_chainId failed: ${clip(probe && probe.error ? probe.error.message : 'no answer', 120)}`, EXIT.NET);
  }
  if (BigInt(probe.result) !== BigInt(cfg.chainId)) {
    throw new HelperError('chain_mismatch', `endpoint reports chain id ${BigInt(probe.result)}, expected ${cfg.chainId}`, EXIT.NET);
  }
  return calls.map((_, i) => {
    const el = byId.get(i + 1);
    if (!el) throw new HelperError('rpc_malformed', 'missing element in batch answer', EXIT.NET);
    return el;
  });
}

function unwrap(el, what) {
  if (el.error) throw new HelperError('rpc_error', `${what}: ${clip(el.error.message || 'error', 200)}`, EXIT.NET, { rpc_code: el.error.code });
  return el.result;
}

const hex = (n) => '0x' + BigInt(n).toString(16);

// ---------------------------------------------------------------------------------------------------------
// ABI work (pure computation)
// ---------------------------------------------------------------------------------------------------------

function takeBalanced(s, start) {
  if (s[start] !== '(') throw bad('signature: expected "("');
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return { inner: s.slice(start + 1, i), end: i + 1 }; }
  }
  throw bad('signature: unbalanced parentheses');
}

const fixTuples = (t) => t.replace(/(?<=^|[,(])\(/g, 'tuple(');

// Accepts cast style  name(in1,in2)(out1,out2)  with tuples written as (a,b)[], or a full human-readable ABI line.
function parseSignature(sig) {
  if (typeof sig !== 'string' || sig.trim() === '') throw bad('missing signature');
  const s = sig.trim();
  let fragment;
  try {
    if (/^function\s/.test(s)) {
      fragment = ethers.FunctionFragment.from(s);
    } else {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(s);
      if (!m) throw bad('signature must look like name(type,...)(returns,...)');
      const ins = takeBalanced(s, m[0].length - 1);
      const rest = s.slice(ins.end).trim();
      let outs = null;
      if (rest) {
        if (rest[0] !== '(') throw bad('signature: unexpected text after the argument list');
        const o = takeBalanced(rest, 0);
        if (rest.slice(o.end).trim() !== '') throw bad('signature: unexpected trailing text');
        outs = o.inner;
      }
      fragment = ethers.FunctionFragment.from(
        `function ${m[1]}(${fixTuples(ins.inner)})${outs !== null && outs.trim() !== '' ? ` view returns (${fixTuples(outs)})` : ''}`);
    }
  } catch (e) {
    if (e instanceof HelperError) throw e;
    throw bad(`cannot parse signature: ${clip(e.shortMessage || e.message, 120)}`);
  }
  return { fragment, canonical: fragment.format('sighash'), selector: fragment.selector, iface: new ethers.Interface([fragment]) };
}

function assertNoUnsafeNumbers(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < n && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      i++;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + 1;
      while (j < n && /[0-9.eE+-]/.test(text[j])) j++;
      const tok = text.slice(i, j);
      if (!/^-?\d+$/.test(tok)) throw bad(`JSON number ${clip(tok, 30)} is not a plain integer; quote it as a string`);
      if (BigInt(tok) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(tok) < -BigInt(Number.MAX_SAFE_INTEGER)) {
        throw bad(`JSON number ${clip(tok, 30)} exceeds 2^53; quote it as a string`);
      }
      i = j;
    } else i++;
  }
}

function coerceScalar(pt, v) {
  const t = pt.type;
  if (t === 'bool') {
    if (v === true || v === 'true') return true;
    if (v === false || v === 'false') return false;
    throw bad('bool argument must be true or false');
  }
  if (t === 'address') {
    if (typeof v !== 'string' || !ethers.isAddress(v)) throw bad(`not an address: ${clip(v, 50)}`);
    return v;
  }
  if (t.startsWith('uint') || t.startsWith('int')) {
    if (typeof v === 'number') { if (!Number.isSafeInteger(v)) throw bad('integer argument must be a safe integer or a string'); return BigInt(v); }
    if (typeof v === 'string' && (/^-?\d+$/.test(v) || /^0x[0-9a-fA-F]+$/.test(v))) return BigInt(v);
    throw bad(`integer argument must be a decimal or 0x string, got ${clip(v, 40)}`);
  }
  if (t.startsWith('bytes')) {
    if (typeof v !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw bad('bytes argument must be even-length 0x hex');
    return v;
  }
  if (t === 'string') return String(v);
  throw bad(`unsupported type ${clip(t, 40)}`);
}

function coerceNested(pt, v) {
  if (pt.baseType === 'array') {
    if (!Array.isArray(v)) throw bad(`expected a JSON array for ${clip(pt.format('sighash'), 60)}`);
    return v.map((x) => coerceNested(pt.arrayChildren, x));
  }
  if (pt.baseType === 'tuple') {
    let arr;
    if (Array.isArray(v)) arr = v;
    else if (v && typeof v === 'object') {
      arr = pt.components.map((c) => {
        if (!c.name || !(c.name in v)) throw bad('tuple given as an object needs named components for every field');
        return v[c.name];
      });
    } else throw bad(`expected a JSON array or object for ${clip(pt.format('sighash'), 60)}`);
    if (arr.length !== pt.components.length) throw bad(`tuple needs ${pt.components.length} fields, got ${arr.length}`);
    return arr.map((x, i) => coerceNested(pt.components[i], x));
  }
  return coerceScalar(pt, v);
}

function readArgText(text) {
  if (typeof text === 'string' && text.startsWith('@')) return readRunFile(text.slice(1)).toString('utf8').trim();
  return text;
}

// Windows PowerShell 5.1 drops the double quotes of an argument passed to a native program, so '["0xab",false,100]'
// arrives as [0xab,false,100]. When strict JSON fails, bare tokens are quoted as strings and the text is parsed
// again; every integer then arrives as a string, which also sidesteps the 2^53 limit. true, false and null stay.
function looseJson(text) {
  const tokenChar = /[A-Za-z0-9_.+-]/;
  const n = text.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') { if (text[j] === '\\') j++; j++; }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (tokenChar.test(c)) {
      let j = i;
      while (j < n && tokenChar.test(text[j])) j++;
      const tok = text.slice(i, j);
      out += tok === 'true' || tok === 'false' || tok === 'null' ? tok : JSON.stringify(tok);
      i = j;
    } else { out += c; i++; }
  }
  return out;
}

function parseJsonArg(text, pt) {
  try {
    const v = JSON.parse(text);
    assertNoUnsafeNumbers(text); // strict JSON: integers must be safe, others must be quoted
    return v;
  } catch (e) {
    if (e instanceof HelperError) throw e;
  }
  try { return JSON.parse(looseJson(text)); } catch {
    throw bad(`argument for ${clip(pt.format('sighash'), 60)} is not valid JSON`);
  }
}

function coerceArg(pt, argText) {
  const text = readArgText(argText);
  if (pt.baseType === 'tuple' || pt.baseType === 'array') return coerceNested(pt, parseJsonArg(text, pt));
  return coerceScalar(pt, text);
}

function encodeCall(sig, argTexts) {
  const p = parseSignature(sig);
  const inputs = p.fragment.inputs;
  if (argTexts.length !== inputs.length) throw bad(`${p.canonical} takes ${inputs.length} argument(s), got ${argTexts.length}`);
  const values = inputs.map((pt, i) => coerceArg(pt, argTexts[i]));
  let calldata;
  try { calldata = p.iface.encodeFunctionData(p.fragment, values); } catch (e) {
    throw bad(`cannot encode: ${clip(e.shortMessage || e.message, 160)}`);
  }
  return { ...p, calldata };
}

function toPlain(v) {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return Array.from(v, toPlain);
  return v;
}

function decodeRevert(data) {
  if (typeof data !== 'string') return null;
  try {
    if (data.startsWith('0x08c379a0')) return ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0];
    if (data.startsWith('0x4e487b71')) return 'Panic(' + ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], '0x' + data.slice(10))[0] + ')';
  } catch { /* fall through */ }
  return null;
}

const isHexData = (s) => typeof s === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(s);
const keccakOf = (hexStr) => ethers.keccak256(hexStr);
const bytesLen = (hexStr) => (hexStr.length - 2) / 2;

function normAddr(s) {
  try { return ethers.getAddress(s); } catch { throw bad(`not an address: ${clip(s, 50)}`); }
}

function normTxHash(s) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(s))) throw bad('transaction hash must be 0x + 64 hex characters');
  return String(s).toLowerCase();
}

function parseBlockTag(s) {
  if (s === undefined || s === 'latest') return 'latest';
  if (/^\d+$/.test(s)) return hex(BigInt(s));
  if (/^0x[0-9a-fA-F]+$/.test(s)) return hex(BigInt(s));
  throw bad('block must be latest, a decimal number or a 0x number');
}

// ---------------------------------------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------------------------------------

async function cmdChainId(cfg) {
  await rpcBatch(cfg, []);
  return { chain_id: cfg.chainId, expected: EXPECTED_CHAIN_ID, ok: true };
}

async function cmdBlock(cfg, [tagArg, addrArg]) {
  const tag = parseBlockTag(tagArg);
  const addr = addrArg === undefined ? null : normAddr(addrArg);
  const [el] = await rpcBatch(cfg, [{ method: 'eth_getBlockByNumber', params: [tag, addr !== null] }]);
  const b = unwrap(el, 'eth_getBlockByNumber');
  if (!b) throw new HelperError('block_not_found', 'no such block', EXIT.NET);
  const txs = Array.isArray(b.transactions) ? b.transactions : [];
  const out = {
    number: Number(BigInt(b.number)),
    hash: b.hash,
    parent_hash: b.parentHash,
    timestamp: Number(BigInt(b.timestamp)),
    gas_limit: BigInt(b.gasLimit).toString(),
    gas_used: BigInt(b.gasUsed).toString(),
    base_fee_per_gas: b.baseFeePerGas === undefined ? null : BigInt(b.baseFeePerGas).toString(),
    tx_count: txs.length,
  };
  if (addr !== null) {
    const mine = txs.filter((t) => t && typeof t === 'object' && String(t.from).toLowerCase() === addr.toLowerCase());
    out.address = addr;
    out.txs_from = mine.slice(0, 50).map((t) => ({
      hash: t.hash,
      nonce: Number(BigInt(t.nonce)),
      to: t.to === undefined ? null : t.to,
      value: BigInt(t.value || '0x0').toString(),
      input_bytes: isHexData(t.input) ? bytesLen(t.input) : null,
      input_keccak256: isHexData(t.input) ? keccakOf(t.input) : null,
    }));
    out.txs_from_total = mine.length;
  }
  return out;
}

async function cmdNonce(cfg, [addrArg]) {
  const addr = normAddr(addrArg);
  const [a, b] = await rpcBatch(cfg, [
    { method: 'eth_getTransactionCount', params: [addr, 'latest'] },
    { method: 'eth_getTransactionCount', params: [addr, 'pending'] },
  ]);
  return { address: addr, latest: Number(BigInt(unwrap(a, 'nonce latest'))), pending: Number(BigInt(unwrap(b, 'nonce pending'))) };
}

async function cmdBalance(cfg, [addrArg]) {
  const addr = normAddr(addrArg);
  const [el] = await rpcBatch(cfg, [{ method: 'eth_getBalance', params: [addr, 'latest'] }]);
  const wei = BigInt(unwrap(el, 'eth_getBalance'));
  return { address: addr, wei: wei.toString(), eth: ethers.formatEther(wei) };
}

async function cmdCode(cfg, [addrArg]) {
  const addr = normAddr(addrArg);
  const [el] = await rpcBatch(cfg, [{ method: 'eth_getCode', params: [addr, 'latest'] }]);
  const code = unwrap(el, 'eth_getCode');
  if (!isHexData(code)) throw new HelperError('rpc_malformed', 'eth_getCode returned non-hex', EXIT.NET);
  return { address: addr, has_code: code !== '0x', bytes: bytesLen(code), code_keccak256: keccakOf(code) };
}

async function cmdReceipt(cfg, [hashArg]) {
  const h = normTxHash(hashArg);
  const [el] = await rpcBatch(cfg, [{ method: 'eth_getTransactionReceipt', params: [h] }]);
  const r = unwrap(el, 'eth_getTransactionReceipt');
  if (!r) return { found: false, tx_hash: h };
  return {
    found: true,
    tx_hash: r.transactionHash,
    status: r.status === undefined ? null : r.status,
    success: r.status === '0x1',
    block_number: Number(BigInt(r.blockNumber)),
    transaction_index: Number(BigInt(r.transactionIndex)),
    from: r.from,
    to: r.to === undefined ? null : r.to,
    contract_address: r.contractAddress === undefined ? null : r.contractAddress,
    type: r.type === undefined ? null : r.type,
    gas_used: BigInt(r.gasUsed).toString(),
    effective_gas_price: r.effectiveGasPrice === undefined ? null : BigInt(r.effectiveGasPrice).toString(),
    l1_fee: r.l1Fee === undefined ? null : BigInt(r.l1Fee).toString(),
    logs_count: Array.isArray(r.logs) ? r.logs.length : 0,
  };
}

async function cmdTx(cfg, [hashArg, runId]) {
  const h = normTxHash(hashArg);
  validateRunId(runId);
  precheckWrite(runId, `tx-${h}.input`);
  const [el] = await rpcBatch(cfg, [{ method: 'eth_getTransactionByHash', params: [h] }]);
  const t = unwrap(el, 'eth_getTransactionByHash');
  if (!t) return { found: false, tx_hash: h };
  const mined = t.blockNumber !== null && t.blockNumber !== undefined;
  const out = {
    found: true,
    mined,
    hash: t.hash,
    from: t.from,
    nonce: Number(BigInt(t.nonce)),
    to: t.to === undefined ? null : t.to,
    value: BigInt(t.value || '0x0').toString(),
    block_number: mined ? Number(BigInt(t.blockNumber)) : null,
    input_bytes: null,
    input_keccak256: null,
    input_path: null,
  };
  if (!mined) return out;
  if (!isHexData(t.input)) throw new HelperError('rpc_malformed', 'transaction input is not hex', EXIT.NET);
  const w = writeRunFile(runId, `tx-${h}.input`, Buffer.from(t.input, 'utf8'));
  out.input_bytes = bytesLen(t.input);
  out.input_keccak256 = keccakOf(t.input);
  out.input_path = w.path;
  return out;
}

async function cmdFeeHistory(cfg) {
  const [fh, gp] = await rpcBatch(cfg, [
    { method: 'eth_feeHistory', params: ['0xa', 'latest', [25, 50, 75]] },
    { method: 'eth_gasPrice', params: [] },
  ]);
  const f = unwrap(fh, 'eth_feeHistory');
  const dec = (x) => BigInt(x).toString();
  const base = (f.baseFeePerGas || []).map(dec);
  return {
    oldest_block: Number(BigInt(f.oldestBlock)),
    base_fee_per_gas: base,
    next_base_fee_per_gas: base.length ? base[base.length - 1] : null,
    gas_used_ratio: f.gasUsedRatio || [],
    reward_percentiles: [25, 50, 75],
    reward: (f.reward || []).map((row) => row.map(dec)),
    gas_price: dec(unwrap(gp, 'eth_gasPrice')),
  };
}

const POOL_IFACE = new ethers.Interface([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
]);
const MC3_IFACE = new ethers.Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getBlockNumber() view returns (uint256 blockNumber)',
]);

const mkCall = (iface, target, fn) => [target, false, iface.encodeFunctionData(fn)];

async function cmdSlot0(cfg, [poolArg]) {
  const pool = normAddr(poolArg);
  const calls = [
    mkCall(POOL_IFACE, pool, 'slot0'), mkCall(POOL_IFACE, pool, 'liquidity'), mkCall(POOL_IFACE, pool, 'token0'),
    mkCall(POOL_IFACE, pool, 'token1'), mkCall(POOL_IFACE, pool, 'fee'), mkCall(MC3_IFACE, MULTICALL3, 'getBlockNumber'),
  ];
  const data = MC3_IFACE.encodeFunctionData('aggregate3', [calls]);
  const [el] = await rpcBatch(cfg, [{ method: 'eth_call', params: [{ to: MULTICALL3, data }, 'latest'] }]);
  const raw = callResult(el, 'slot0 multicall');
  let res;
  try { res = MC3_IFACE.decodeFunctionResult('aggregate3', raw)[0]; } catch {
    throw new HelperError('decode_failed', 'cannot decode the multicall answer', EXIT.GENERIC);
  }
  for (let i = 0; i < res.length; i++) {
    if (!res[i].success) throw new HelperError('call_reverted', `pool read ${i} failed: ${poolArg} is not a Uniswap V3 pool on this chain`, EXIT.REVERT);
    if (res[i].returnData === '0x') throw new HelperError('decode_failed', `${poolArg} returned no data: not a Uniswap V3 pool (no contract, or no such function)`, EXIT.GENERIC);
  }
  const dec = (iface, fn, i) => {
    try { return iface.decodeFunctionResult(fn, res[i].returnData); } catch {
      throw new HelperError('decode_failed', `${poolArg} answered pool read ${i} in an unexpected shape: not a Uniswap V3 pool`, EXIT.GENERIC);
    }
  };
  const s0 = dec(POOL_IFACE, 'slot0', 0);
  const sqrt = BigInt(s0[0]);
  const price = (sqrt * sqrt * 10n ** 36n) >> 192n;
  return {
    pool,
    block: Number(BigInt(dec(MC3_IFACE, 'getBlockNumber', 5)[0])),
    sqrt_price_x96: sqrt.toString(),
    tick: Number(s0[1]),
    liquidity: BigInt(dec(POOL_IFACE, 'liquidity', 1)[0]).toString(),
    token0: dec(POOL_IFACE, 'token0', 2)[0],
    token1: dec(POOL_IFACE, 'token1', 3)[0],
    fee: Number(dec(POOL_IFACE, 'fee', 4)[0]),
    price_token1_per_token0: ethers.formatUnits(price, 36),
  };
}

// An eth_call element: result hex, or a revert surfaced as call_reverted.
function callResult(el, what) {
  if (el.error) {
    const data = el.error.data;
    const reason = decodeRevert(data);
    if (el.error.code === 3 || /revert/i.test(String(el.error.message))) {
      throw new HelperError('call_reverted', `${what} reverted${reason ? `: ${clip(reason, 200)}` : `: ${clip(el.error.message, 200)}`}`, EXIT.REVERT,
        { revert_reason: reason, revert_data: typeof data === 'string' ? clip(data, 300) : null });
    }
    throw new HelperError('rpc_error', `${what}: ${clip(el.error.message || 'error', 200)}`, EXIT.NET, { rpc_code: el.error.code });
  }
  if (!isHexData(el.result)) throw new HelperError('rpc_malformed', `${what}: non-hex result`, EXIT.NET);
  return el.result;
}

async function cmdCall(cfg, [toArg, sig, ...argTexts]) {
  const to = normAddr(toArg);
  const enc = encodeCall(sig, argTexts);
  const [bn, el] = await rpcBatch(cfg, [
    { method: 'eth_blockNumber', params: [] },
    { method: 'eth_call', params: [{ to, data: enc.calldata }, 'latest'] },
  ]);
  const raw = callResult(el, enc.canonical);
  const out = {
    to,
    signature: enc.canonical,
    block: Number(BigInt(unwrap(bn, 'eth_blockNumber'))),
    calldata_bytes: bytesLen(enc.calldata),
    raw_bytes: bytesLen(raw),
    raw_keccak256: keccakOf(raw),
    result: null,
  };
  if (enc.fragment.outputs.length > 0) {
    if (raw === '0x') throw new HelperError('decode_failed', `${enc.canonical} returned no data: the target is not a contract or has no such function`, EXIT.GENERIC);
    try { out.result = toPlain(enc.iface.decodeFunctionResult(enc.fragment, raw)); } catch (e) {
      throw new HelperError('decode_failed', `cannot decode the answer as the declared returns: ${clip(e.shortMessage || e.message, 120)}`, EXIT.GENERIC);
    }
  }
  if (raw.length <= 2050) out.raw = raw;
  return out;
}

// --- multicall (extension) -------------------------------------------------------------------------------
//
// Not in the spec's subcommand list. `call` on Multicall3 returns every inner result as nested ABI hex, which the wake
// (no node -e) cannot decode and which does not fit one output page at C step 2's 294 reads. This is the same thing
// as `call <Multicall3> aggregate3(...)`, built from a confined file of {to, signature, args} entries and decoded
// per entry by its own declared returns. Pure computation over ONE eth_call: allowFailure is always false (one
// failed inner read fails the whole call, so a partial answer can never look like "nothing there"), the target is
// the pinned Multicall3, and nothing can be written or sent.

const MAX_MULTICALL = 500;

function loadMulticallList(fileArg) {
  const text = readRunFile(fileArg).toString('utf8');
  assertNoUnsafeNumbers(text);
  let list;
  try { list = JSON.parse(text); } catch { throw bad('multicall file is not valid JSON'); }
  if (!Array.isArray(list) || list.length === 0) throw bad('multicall file must hold a non-empty JSON list of {to, signature, args}');
  if (list.length > MAX_MULTICALL) throw bad(`at most ${MAX_MULTICALL} reads per multicall`);
  return list.map((e, i) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw bad(`entry ${i} is not an object`);
    for (const k of Object.keys(e)) if (!['to', 'signature', 'args'].includes(k)) throw bad(`entry ${i}: unexpected key ${clip(k, 30)} (allowed: to, signature, args)`);
    if (typeof e.to !== 'string') throw bad(`entry ${i}: to is not an address`);
    const to = normAddr(e.to);
    const p = parseSignature(e.signature);
    const args = e.args === undefined ? [] : e.args;
    if (!Array.isArray(args)) throw bad(`entry ${i}: args must be a JSON list`);
    if (args.length !== p.fragment.inputs.length) throw bad(`entry ${i}: ${p.canonical} takes ${p.fragment.inputs.length} argument(s), got ${args.length}`);
    const values = p.fragment.inputs.map((pt, k) => {
      const v = args[k];
      if ((pt.baseType === 'tuple' || pt.baseType === 'array') && typeof v === 'string') return coerceNested(pt, parseJsonArg(v, pt));
      return coerceNested(pt, v);
    });
    let data;
    try { data = p.iface.encodeFunctionData(p.fragment, values); } catch (err) { throw bad(`entry ${i}: cannot encode: ${clip(err.shortMessage || err.message, 120)}`); }
    return { to, p, data };
  });
}

async function cmdMulticall(cfg, [fileArg]) {
  const entries = loadMulticallList(fileArg);
  const calls = entries.map((e) => [e.to, false, e.data]);
  calls.push(mkCall(MC3_IFACE, MULTICALL3, 'getBlockNumber')); // the block the whole answer comes from
  const data = MC3_IFACE.encodeFunctionData('aggregate3', [calls]);
  const [el] = await rpcBatch(cfg, [{ method: 'eth_call', params: [{ to: MULTICALL3, data }, 'latest'] }]);
  const raw = callResult(el, 'multicall');
  let res;
  try { res = MC3_IFACE.decodeFunctionResult('aggregate3', raw)[0]; } catch {
    throw new HelperError('decode_failed', 'cannot decode the multicall answer', EXIT.GENERIC);
  }
  if (res.length !== calls.length) throw new HelperError('decode_failed', 'multicall answered with the wrong number of results', EXIT.GENERIC);
  const results = entries.map((e, i) => {
    const r = res[i];
    if (!r.success) throw new HelperError('call_reverted', `read ${i} (${e.p.canonical} on ${e.to}) failed`, EXIT.REVERT, { index: i });
    if (e.p.fragment.outputs.length === 0) return [];
    if (r.returnData === '0x') throw new HelperError('decode_failed', `read ${i} (${e.p.canonical} on ${e.to}) returned no data: not a contract or no such function`, EXIT.GENERIC, { index: i });
    try { return toPlain(e.p.iface.decodeFunctionResult(e.p.fragment, r.returnData)); } catch (err) {
      throw new HelperError('decode_failed', `read ${i} (${e.p.canonical} on ${e.to}) cannot be decoded as its declared returns: ${clip(err.shortMessage || err.message, 100)}`, EXIT.GENERIC, { index: i });
    }
  });
  return {
    block: Number(BigInt(MC3_IFACE.decodeFunctionResult('getBlockNumber', res[entries.length].returnData)[0])),
    count: entries.length,
    calldata_bytes: bytesLen(data),
    results,
  };
}

async function cmdEncode(cfg, [sig, ...argTexts]) {
  const enc = encodeCall(sig, argTexts);
  return {
    signature: enc.canonical,
    selector: enc.selector,
    bytes: bytesLen(enc.calldata),
    keccak256: keccakOf(enc.calldata),
    calldata: enc.calldata,
  };
}

function cmdKeccak256(cfg, [arg]) {
  if (typeof arg === 'string' && /^0[xX]/.test(arg)) {
    if (!/^0x([0-9a-fA-F]{2})*$/.test(arg)) throw bad('hex must be 0x followed by an even number of hex digits');
    return { keccak256: keccakOf(arg), bytes: bytesLen(arg), source: 'hex' };
  }
  const text = readRunFile(arg).toString('utf8').trim();
  if (!isHexData(text)) throw new HelperError('file_not_hex', 'file content must be one 0x hex string of even length', EXIT.USAGE);
  return { keccak256: keccakOf(text), bytes: bytesLen(text), source: 'file' };
}

// --- simulate -------------------------------------------------------------------------------------------

function mapSlot(key, slot) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [key, slot]));
}
function nestedMapSlot(k1, k2, slot) {
  const inner = mapSlot(k1, slot);
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32'], [k2, inner]));
}
const word = (n) => ethers.toBeHex(BigInt(n), 32);

// stateDiff only, never state: a full "state" replacement would wipe a proxy's implementation slot.
function buildStateOverrides(ov) {
  if (!ov) return null;
  const out = {};
  const acct = (a) => (out[a] = out[a] || {});
  for (const [a, wei] of Object.entries(ov.balances)) acct(a).balance = hex(wei);
  for (const e of ov.erc20Balances) {
    const a = acct(e.token); a.stateDiff = a.stateDiff || {};
    a.stateDiff[mapSlot(e.holder, e.slot)] = word(e.amount);
  }
  for (const e of ov.erc20Allowances) {
    const a = acct(e.token); a.stateDiff = a.stateDiff || {};
    a.stateDiff[nestedMapSlot(e.owner, e.spender, e.slot)] = word(e.amount);
  }
  return Object.keys(out).length ? out : null;
}

function parseSimValue(v) {
  if (v === undefined) return '0x0';
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return hex(v);
  if (typeof v === 'string' && (/^\d+$/.test(v) || /^0x[0-9a-fA-F]+$/.test(v))) return hex(BigInt(v));
  throw bad('value must be a decimal or 0x string');
}

// One call of the plan: {to, data, value} and, optionally, "return": true (print this call's returnData; the flag is
// never sent to the node). `label` names it in an error ("entry 3", "group 2 call 1").
function checkSimCall(t, label) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw bad(`${label} is not an object`);
  for (const k of Object.keys(t)) if (!['to', 'data', 'value', 'return'].includes(k)) throw bad(`${label}: unexpected key ${clip(k, 30)} (from is pinned in the config)`);
  if (Object.prototype.hasOwnProperty.call(t, 'return') && t.return !== true) throw bad(`${label}: "return" must be the boolean true when present (omit it to not print the call's return data)`);
  if (typeof t.to !== 'string' || !ethers.isAddress(t.to)) throw bad(`${label}: to is not an address`);
  const data = t.data === undefined ? '0x' : t.data;
  if (!isHexData(data)) throw bad(`${label}: data must be even-length 0x hex`);
  return { to: ethers.getAddress(t.to), data, value: parseSimValue(t.value), ret: t.return === true };
}

// The simulate file is either a flat list of {to, data, value} (one blockStateCalls entry per transaction) or a list of
// groups {"calls": [{to, data, value}, ...]} (one entry per group, its calls in order inside the entry). Never both.
// Everything is checked here, before any request is made.
function loadSimPlan(fileArg) {
  const text = readRunFile(fileArg).toString('utf8');
  assertNoUnsafeNumbers(text);
  let list;
  try { list = JSON.parse(text); } catch { throw bad('simulate file is not valid JSON'); }
  if (!Array.isArray(list) || list.length === 0) {
    throw bad('simulate file must hold a non-empty JSON list of {to, data, value} (one entry per transaction) or of {"calls": [...]} groups (one entry per group)');
  }
  if (list.length > MAX_SIM_ENTRIES) {
    throw bad(`at most ${MAX_SIM_ENTRIES} entries per simulate request (one entry per transaction in a flat list, one per group in a grouped list); group the transactions, or split the plan at group boundaries`);
  }
  const isGroup = (e) => !!e && typeof e === 'object' && !Array.isArray(e) && Object.prototype.hasOwnProperty.call(e, 'calls');
  const nGroups = list.filter(isGroup).length;
  if (nGroups !== 0 && nGroups !== list.length) throw bad('simulate file mixes groups ({"calls": [...]}) and single transactions; use one form for the whole list');
  const input = nGroups === 0 ? 'flat' : 'groups';
  const groups = input === 'flat'
    ? list.map((t, i) => [checkSimCall(t, `entry ${i}`)])
    : list.map((g, i) => {
      for (const k of Object.keys(g)) {
        if (k !== 'calls') throw bad(`group ${i}: unexpected key ${clip(k, 30)} (a group holds only "calls"; from is pinned and state overrides are config-only)`);
      }
      if (!Array.isArray(g.calls) || g.calls.length === 0) throw bad(`group ${i}: calls must be a non-empty JSON list of {to, data, value}`);
      return g.calls.map((t, k) => checkSimCall(t, `group ${i} call ${k}`));
    });
  const total = groups.reduce((n, g) => n + g.length, 0);
  if (total > MAX_SIM_CALLS) throw bad(`at most ${MAX_SIM_CALLS} calls per simulate request (${total} given); split the plan at group boundaries`);
  const returning = groups.reduce((n, g) => n + g.filter((t) => t.ret).length, 0);
  if (returning > MAX_SIM_RETURNS) throw bad(`at most ${MAX_SIM_RETURNS} calls per simulate request may carry "return": true (${returning} given)`);
  return { input, groups, total };
}

const hexBig = (v) => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null);

// G section 8 / K1: a transaction's gas limit is ceil(maxUsedGas x 1.2) from the same eth_simulateV1 answer, clamped at
// 2^24. gasUsed is net of refunds (Router splits hit the 20% refund cap, so gasUsed x 1.2 runs out of gas); when the
// RPC returns no maxUsedGas the fallback is ceil(gasUsed x 1.5). `over_cap`: the peak itself is above 2^24, so the
// call cannot be sent as one transaction whatever limit is set.
function gasLimitOf(gasUsed, maxUsed) {
  const cap = BigInt(GAS_CAP);
  let limit = null;
  let fallback = false;
  if (maxUsed !== null) limit = (maxUsed * 12n + 9n) / 10n;
  else if (gasUsed !== null) { limit = (gasUsed * 15n + 9n) / 10n; fallback = true; }
  const peak = maxUsed !== null ? maxUsed : gasUsed;
  return {
    limit: limit === null ? null : (limit > cap ? cap : limit),
    clamped: limit !== null && limit > cap,
    overCap: peak !== null && peak > cap,
    fallback,
  };
}

// What the public RPCs answer when a request is too big, and what to do about it (measured 2026-10-05).
function simulateHint(code) {
  if (code === -38026) {
    return 'the RPC refuses more than 256 blockStateCalls entries (too many blocks) per request: put the transactions in groups (one entry per keep-whole group), or split the plan at group boundaries into windows of at most 256 entries, each starting with the mint prefix it depends on, and say that it was not one request';
  }
  if (code === -38013) {
    return 'this RPC has a request-wide gas budget (about 50M on optimism-rpc.publicnode.com, 71.7M or more on mainnet.optimism.io; the text says intrinsic gas too low): split the plan at group boundaries into windows, each starting with the mint prefix it depends on, and say that it was not one request; or the operator pins another RPC';
  }
  if (code === -38015) {
    return 'one entry used more gas than the 40M block gas limit: put fewer calls in a group';
  }
  return null;
}

// The data a call flagged "return": true prints. A call that succeeded gives its returnData; a call that failed gives its
// revert data (the node's `error.data`, else its returnData). A node that gives something that is not hex for a flagged
// call is simulate_malformed (never a silent empty answer); one that gives more than MAX_SIM_RETURN_HEX digits is refused
// as bad_argument (the page is never truncated; probe a smaller return).
function simReturnData(c, index, group) {
  const failed = c.status !== '0x1';
  const errData = c.error && typeof c.error === 'object' ? c.error.data : undefined;
  let data = failed && isHexData(errData) && errData !== '0x' ? errData : c.returnData;
  if (data === undefined || data === null) data = '0x';
  if (!isHexData(data)) {
    throw new HelperError('simulate_malformed', `eth_simulateV1 gave no valid hex returnData for call ${index} (group ${group}), which is flagged "return": true`, EXIT.NET);
  }
  const digits = data.length - 2;
  if (digits > MAX_SIM_RETURN_HEX) {
    throw bad(`call ${index} (group ${group}) gave ${digits} hex characters of ${failed ? 'revert' : 'return'} data, over the ${MAX_SIM_RETURN_HEX} limit for "return": true; the page is never truncated, so drop "return" from that call or probe a smaller return`);
  }
  return data.toLowerCase();
}

async function cmdSimulate(cfg, [fileArg]) {
  const plan = loadSimPlan(fileArg);
  const overrides = buildStateOverrides(cfg.overrides);
  // A flat list is one call per entry, so every call can be simulated with the real per-transaction cap (gas 2^24). In a
  // group the calls share one simulated block: a declared gas of 2^24 per call fails the WHOLE request with -38015 as
  // soon as the entry's gas used so far plus 2^24 passes the 40M block gas limit (measured: 8 splits, 28M used), so a
  // grouped call carries no gas of its own; a call whose peak is above 2^24 is reported as over_cap instead.
  const blockStateCalls = plan.groups.map((g, gi) => {
    const entry = {
      calls: g.map((t) => {
        const c = { from: cfg.signerAddress, to: t.to, data: t.data, value: t.value };
        if (plan.input === 'flat') c.gas = hex(GAS_CAP);
        return c;
      }),
    };
    if (gi === 0 && overrides) entry.stateOverrides = overrides;
    return entry;
  });
  const [sim, nonce] = await rpcBatch(cfg, [
    { method: 'eth_simulateV1', params: [{ blockStateCalls, validation: false, traceTransfers: false, returnFullTransactions: false }, 'latest'] },
    { method: 'eth_getTransactionCount', params: [cfg.signerAddress, 'pending'] },
  ], { maxBytes: MAX_SIM_RESPONSE_BYTES });
  if (sim.error) {
    const msg = clip(sim.error.message || 'error', 300);
    if (sim.error.code === -32601 || /not (found|supported|available)|unknown method|does not exist/i.test(msg)) {
      throw new HelperError('simulate_unsupported', `the endpoint has no eth_simulateV1 (${msg}); stop, never simulate only the first transaction`, EXIT.NET);
    }
    const extra = { rpc_code: sim.error.code };
    const hint = simulateHint(sim.error.code);
    if (hint) extra.hint = hint;
    throw new HelperError('simulate_failed', `eth_simulateV1 failed: ${msg}`, EXIT.NET, extra);
  }
  const blocks = sim.result;
  if (!Array.isArray(blocks) || blocks.length !== plan.groups.length
    || blocks.some((b, g) => !b || !Array.isArray(b.calls) || b.calls.length !== plan.groups[g].length)) {
    throw new HelperError('simulate_malformed', 'eth_simulateV1 did not return one block per entry with one result per call', EXIT.NET);
  }
  // The page stays small: a call is one array row (about 40 characters) under `columns`, so 374 calls in 100 groups, or
  // 256 single transactions, fit one output page. Error text goes in `failures`, for the first MAX_FAIL_DETAIL failing
  // calls only; a dependent plan that fails at its first step fails every step after it.
  let failed = 0; let overCap = 0; let clamped = 0; let noMax = 0;
  let firstFailed = null; let firstFailedGroup = null; let firstOverCap = null;
  const rows = [];
  const failures = [];
  const returns = [];
  let index = 0;
  blocks.forEach((b, g) => {
    b.calls.forEach((c, k) => {
      const status = typeof c.status === 'string' ? c.status : null;
      const gasUsed = hexBig(c.gasUsed);
      const maxUsed = hexBig(c.maxUsedGas);
      const lim = gasLimitOf(gasUsed, maxUsed);
      if (lim.clamped) clamped++;
      if (lim.fallback) noMax++;
      if (lim.overCap) { overCap++; if (firstOverCap === null) firstOverCap = index; }
      if (status !== '0x1') {
        failed++;
        if (firstFailed === null) { firstFailed = index; firstFailedGroup = g; }
        if (failures.length < MAX_FAIL_DETAIL) {
          const reason = c.error ? decodeRevert(c.error.data) : null;
          failures.push({
            index,
            group: g,
            to: plan.groups[g][k].to,
            status,
            error: c.error && c.error.message ? clip(c.error.message, 200) : null,
            revert_reason: reason ? clip(reason, 200) : null,
          });
        }
      }
      rows.push([index, g, status, gasUsed === null ? null : Number(gasUsed), maxUsed === null ? null : Number(maxUsed), lim.limit === null ? null : Number(lim.limit)]);
      if (plan.groups[g][k].ret) returns.push({ index, group: g, return_data: simReturnData(c, index, g) });
      index++;
    });
  });
  const out = {
    from: cfg.signerAddress,
    input: plan.input,
    entries: plan.groups.length,
    count: plan.total,
    all_success: failed === 0 && overCap === 0,
    failed_count: failed,
    first_failed_index: firstFailed,
    first_failed_group: firstFailedGroup,
    over_cap_count: overCap,
    first_over_cap_index: firstOverCap,
    clamped_count: clamped,
    pending_nonce: Number(BigInt(unwrap(nonce, 'pending nonce'))),
    gas_limit_rule: 'ceil(maxUsedGas x 1.2), clamped at 16777216; ceil(gasUsed x 1.5) for a call the RPC gave no maxUsedGas',
    columns: ['index', 'group', 'status', 'gasUsed', 'maxUsedGas', 'gas_limit'],
    calls: rows,
  };
  if (returns.length > 0) out.returns = returns;
  if (noMax > 0) out.no_max_used_gas_count = noMax;
  if (failures.length > 0) out.failures = failures;
  if (failed > MAX_FAIL_DETAIL) out.error_detail_note = `error text is given for the first ${MAX_FAIL_DETAIL} failures only`;
  if (overrides) {
    out.overrides_active = true;
    out.warning = 'simulationOverrides are set in the config: statuses reflect fake balances, never gate a real send on them';
  }
  return out;
}

// --- data -----------------------------------------------------------------------------------------------

const BODY_KEYS = ['marketsData', 'markets', 'parentWrappedTokens', 'parentMarketStatus', 'middleMarkets'];
const ROW_KEYS = ['id', 'wrappedTokens', 'collateralToken', 'parentOutcome', 'marketStatus'];

async function fetchData(cfg) {
  let lastErr = null;
  let retryAfter = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoffMs(cfg, attempt, retryAfter));
    let res;
    try {
      res = await fetch(cfg.dataFunctionUrl, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(cfg.requestTimeoutMs) });
    } catch (e) {
      const cause = String((e && e.cause && e.cause.message) || (e && e.message) || '');
      if (/redirect/i.test(cause)) throw new HelperError('data_redirect', 'the data function answered with a redirect; refused (pinned URL)', EXIT.NET);
      throw new HelperError('data_unreachable', `no HTTP response from the data function: ${clip(cause, 120)}`, EXIT.NET);
    }
    if (res.status === 429) {
      retryAfter = res.headers.get('retry-after');
      try { await res.body.cancel(); } catch { /* ignore */ }
      lastErr = new HelperError('data_rate_limited', `data function answered HTTP 429 after ${attempt + 1} attempt(s)`, EXIT.NET);
      continue;
    }
    const buf = await readCapped(res, MAX_DATA_BYTES);
    return { status: res.status, contentType: res.headers.get('content-type'), buf };
  }
  throw lastErr;
}

function summariseBody(buf) {
  let body = null;
  let jsonValid = false;
  try { body = JSON.parse(buf.toString('utf8')); jsonValid = body !== null && typeof body === 'object' && !Array.isArray(body); } catch { jsonValid = false; }
  const s = { json_valid: jsonValid, has_error_field: false, shape_ok: false };
  if (!jsonValid) return s;
  s.has_error_field = Object.prototype.hasOwnProperty.call(body, 'error');
  const haveKeys = BODY_KEYS.every((k) => Object.prototype.hasOwnProperty.call(body, k));
  const marketsOk = Array.isArray(body.markets);
  s.markets = marketsOk ? body.markets.length : null;
  s.parent_wrapped_tokens = Array.isArray(body.parentWrappedTokens) ? body.parentWrappedTokens.length : null;
  s.middle_markets = Array.isArray(body.middleMarkets) ? body.middleMarkets.length : null;
  s.markets_data_keys = body.marketsData && typeof body.marketsData === 'object' ? Object.keys(body.marketsData).length : null;
  if (marketsOk) {
    const missing = body.markets.filter((m) => !m || typeof m !== 'object' || ROW_KEYS.some((k) => !Object.prototype.hasOwnProperty.call(m, k))).length;
    s.markets_missing_fields = missing;
    const slots = body.markets.map((m) => (m && Number.isInteger(m.parentOutcome) ? m.parentOutcome : null)).filter((x) => x !== null);
    s.slots = { min: slots.length ? Math.min(...slots) : null, max: slots.length ? Math.max(...slots) : null, distinct: new Set(slots).size };
    s.markets_open = body.markets.filter((m) => m && m.marketStatus === 'open').length;
    s.shape_ok = haveKeys && missing === 0;
  }
  if (body.marketsData && typeof body.marketsData === 'object') {
    const vals = Object.values(body.marketsData);
    s.pools_null = vals.reduce((n, v) => n + (v && v.upPool === null ? 1 : 0) + (v && v.downPool === null ? 1 : 0), 0);
  }
  return s;
}

async function cmdData(cfg, [runId]) {
  validateRunId(runId);
  precheckWrite(runId, 'r3-data.json');
  const got = await fetchData(cfg);
  const sum = summariseBody(got.buf);
  const w = writeRunFile(runId, 'r3-data.json', got.buf); // the RAW body, byte for byte
  const usable = got.status === 200 && sum.json_valid && !sum.has_error_field && sum.shape_ok;
  return {
    status: got.status,
    bytes: got.buf.length,
    sha256: crypto.createHash('sha256').update(got.buf).digest('hex'),
    content_type: got.contentType === null ? null : clip(got.contentType, 80),
    written: true,
    path: w.path,
    usable,
    ...sum,
  };
}

const MISSING = '<missing>';
const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : MISSING);
const pick = (o, k) => (o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : MISSING);

function poolRow(pool) {
  if (pool === MISSING) return MISSING;
  if (pool === null) return null;
  return [pick(pool, 'liquidity'), pick(pool, 'tick'), pick(pool, 'feeTier'), lower(pick(pool, 'token0'))];
}

// Extension (not in the spec's list): a paginated, projected view of r3-data.json, because the raw body is one
// 119 KB line that the agent's file reader refuses and the wake has no node -e.
function cmdDataRows(cfg, [runId, offArg, countArg]) {
  validateRunId(runId);
  if (!/^\d+$/.test(String(offArg)) || !/^\d+$/.test(String(countArg))) throw bad('offset and count must be non-negative integers');
  const offset = Number(offArg);
  const count = Number(countArg);
  if (count < 1 || count > MAX_ROWS) throw bad(`count must be 1..${MAX_ROWS}`);
  const buf = readRunFile(`run/${runId}/r3-data.json`, MAX_DATA_BYTES);
  let body;
  try { body = JSON.parse(buf.toString('utf8')); } catch { throw new HelperError('data_not_json', 'r3-data.json is not valid JSON', EXIT.GENERIC); }
  if (!body || !Array.isArray(body.markets)) throw new HelperError('data_shape', 'r3-data.json has no markets array', EXIT.GENERIC);
  const byId = new Map();
  if (body.marketsData && typeof body.marketsData === 'object') {
    for (const [repo, v] of Object.entries(body.marketsData)) if (v && typeof v.id === 'string') byId.set(v.id.toLowerCase(), { repo, v });
  }
  const rows = body.markets.slice(offset, offset + count).map((m, k) => {
    const id = lower(pick(m, 'id'));
    const md = byId.get(id);
    const wt = pick(m, 'wrappedTokens');
    return [
      offset + k,
      md ? md.repo : MISSING,
      id,
      pick(m, 'parentOutcome'),
      lower(pick(m, 'collateralToken')),
      pick(m, 'marketStatus'),
      Array.isArray(wt) ? wt.map(lower) : MISSING,
      md ? [pick(md.v, 'upPrice'), poolRow(pick(md.v, 'upPool'))] : MISSING,
      md ? [pick(md.v, 'downPrice'), poolRow(pick(md.v, 'downPool'))] : MISSING,
    ];
  });
  // The fields C step 2.5 and 2.6 compare (parent wrapped tokens, the three middle markets), on every page.
  const pwt = pick(body, 'parentWrappedTokens');
  const mm = pick(body, 'middleMarkets');
  const header = {
    parent_wrapped_tokens: Array.isArray(pwt) ? pwt.map(lower) : MISSING,
    parent_market_status: pick(body, 'parentMarketStatus'),
    middle_markets: Array.isArray(mm) ? mm.slice(0, 10).map((m) => [lower(pick(m, 'id')), pick(m, 'payoutReported')]) : MISSING,
    middle_columns: ['id', 'payoutReported'],
  };
  return {
    run_id: runId,
    offset,
    count: rows.length,
    total: body.markets.length,
    header,
    columns: ['i', 'repo', 'id', 'slot', 'collateral', 'status', 'wrapped[DOWN,UP,Invalid]', 'up[price,pool]', 'down[price,pool]'],
    pool_columns: ['liquidity', 'tick', 'feeTier', 'token0'],
    note: 'addresses lowercased; "<missing>" marks an absent field, null marks a pool the body reports as null; liquidity stays a string',
    rows,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------------------

const COMMANDS = {
  'chain-id': { min: 0, max: 0, usage: 'chain-id', run: cmdChainId },
  block: { min: 0, max: 2, usage: 'block [latest|<number>] [<address>]', run: cmdBlock },
  nonce: { min: 1, max: 1, usage: 'nonce <address>', run: cmdNonce },
  balance: { min: 1, max: 1, usage: 'balance <address>', run: cmdBalance },
  code: { min: 1, max: 1, usage: 'code <address>', run: cmdCode },
  receipt: { min: 1, max: 1, usage: 'receipt <txhash>', run: cmdReceipt },
  tx: { min: 2, max: 2, usage: 'tx <txhash> <run-id>', run: cmdTx },
  'fee-history': { min: 0, max: 0, usage: 'fee-history', run: cmdFeeHistory },
  slot0: { min: 1, max: 1, usage: 'slot0 <pool>', run: cmdSlot0 },
  call: { min: 2, max: Infinity, usage: 'call <to> <signature> <args...>', run: cmdCall },
  multicall: { min: 1, max: 1, usage: 'multicall run/<run-id>/<file>   (extension)', run: cmdMulticall },
  encode: { min: 1, max: Infinity, usage: 'encode <signature> <args...>', run: cmdEncode },
  simulate: { min: 1, max: 1, usage: 'simulate run/<run-id>/<file>   (a flat list of {to,data,value[,return:true]}, or a list of {"calls":[...]} groups)', run: cmdSimulate },
  keccak256: { min: 1, max: 1, usage: 'keccak256 <0xhex|run/<run-id>/<file>>', run: cmdKeccak256 },
  data: { min: 1, max: 1, usage: 'data <run-id>', run: cmdData },
  'data-rows': { min: 3, max: 3, usage: 'data-rows <run-id> <offset> <count>   (extension)', run: cmdDataRows },
};

async function run(argv) {
  const [sub, ...args] = argv;
  if (sub === undefined) throw new HelperError('usage', 'no subcommand', EXIT.USAGE, { commands: Object.keys(COMMANDS) });
  if (argv.some((a) => /^--/.test(String(a)))) {
    throw new HelperError('unexpected_option', 'this helper takes no options; endpoint, URL and output paths are not arguments', EXIT.USAGE);
  }
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, sub)) {
    throw new HelperError('unknown_subcommand', `unknown subcommand ${clip(sub, 40)}`, EXIT.USAGE, { commands: Object.keys(COMMANDS) });
  }
  const cmd = COMMANDS[sub];
  if (args.length < cmd.min || args.length > cmd.max) throw new HelperError('usage', `usage: ${cmd.usage}`, EXIT.USAGE);
  if (!/^6\./.test(ethers.version)) throw new HelperError('ethers_version', `ethers 6 required, found ${ethers.version}`, EXIT.CONFIG);
  const cfg = loadConfig();
  return cmd.run(cfg, args);
}

function render(obj, exit) {
  let text = JSON.stringify(obj);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = JSON.stringify({ error: `output would be ${text.length} characters (limit ${MAX_OUTPUT_CHARS}); narrow the request`, code: 'output_too_large', chars: text.length });
    exit = EXIT.TOO_BIG;
  }
  return { text, exit };
}

async function main(argv) {
  let result;
  try {
    result = render(await run(argv), 0);
  } catch (e) {
    if (e instanceof HelperError) {
      const o = { error: e.message, code: e.code };
      if (e.extra) for (const [k, v] of Object.entries(e.extra)) if (!(k in o)) o[k] = v;
      result = render(o, e.exit);
    } else {
      result = render({ error: clip(e && e.message ? e.message : e, 300), code: 'internal_error' }, EXIT.GENERIC);
    }
  }
  process.stdout.write(result.text + '\n', () => process.exit(result.exit));
}

if (require.main === module) {
  main(process.argv.slice(2));
} else {
  // Test hooks. Nothing here widens what the CLI can do: rpcBatch is the same choke point.
  module.exports = {
    HelperError, EXIT, ALLOWED_METHODS, MAX_OUTPUT_CHARS, GAS_CAP,
    rpcBatch, loadConfigFrom, parseRunPath, parseSignature, encodeCall, buildStateOverrides, validateRunId, run,
  };
}
