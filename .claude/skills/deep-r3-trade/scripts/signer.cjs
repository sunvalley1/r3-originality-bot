'use strict';
/*
 * signer.cjs - the allowlist signer CLI the deep-r3-trade skill promises (I-setup.md I.1 section 7,
 * G-mint-and-trade.md section 8). Reference implementation, staged for the operator to review.
 * One file on purpose: `autonomy.signer_sha256` pins ONE file, so everything that can sign lives here.
 * Dependency: ethers 6.17 only. Node 22, CommonJS.
 *
 *   Restricted subcommands (the autonomous allow rule names exactly these three):
 *     node signer.cjs check <file>                  policy only; no signing code path; decided before any RPC call
 *     node signer.cjs simulate <file>               policy, then eth_simulateV1 (eth_call fallback); never broadcasts
 *     node signer.cjs send <file> [--nonce <n>]     policy, then signs and broadcasts ONE transaction
 *   Supervised subcommands (NOT matched by `node <signer> send|simulate|check *`, so each one prompts the human):
 *     info | reconcile | clear-nonce <n> | sweep-token <token> [--amount <raw>] | sweep-eth --amount <wei>
 *     allowlist-init --skill-dir <dir> [--delay-ms <n>] [--force] [--allow-swap-exact-out] [--r3-data <file>]
 *
 * Nothing here reads an environment variable or an agent-writable file to change what is signed. The only
 * inputs that change behaviour are signer.config.json (next to this file) and the hash-pinned allowlist.
 * There is no amount, count, frequency or time limit anywhere in this file (owner policy).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Interface, Wallet, Transaction, getAddress, keccak256, getBytes, hexlify } = require('ethers');

const VERSION = '1.0.0';
const FORMAT = 'r3-signer-allowlist/1';
const CHAIN_ID = 10;
const MAX_GAS_LIMIT = 1n << 24n; // Optimism per-transaction ceiling, 16,777,216
const UINT256_MAX = (1n << 256n) - 1n;
const BURN = '0x000000000000000000000000000000000000dEaD';
const FEE_TIERS = [100, 500, 3000, 10000];
const DEFAULT_TIER = 100; // G-mint-and-trade.md section 2: the verified tier of every v3 UP/DOWN pool
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------
// Pinned addresses: G-mint-and-trade.md "Addresses - Optimism (10)" table. They are in this file (covered by
// the signer's own sha256) AND in the allowlist file (covered by its pinned sha256); the two must agree.
// The 98 child markets, their repo tokens and their 294 outcome tokens live only in the allowlist file.
// ---------------------------------------------------------------------------------------------------------
const PINNED = {
  susds: '0xb5b2dc7fd34c249f4be7fb1fcea07950784229e0',
  router: '0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD',
  ctf: '0x8bdC504dC3A05310059c1c67E0A2667309D27B93',
  swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  psm3: '0xe0F9978b907853F354d79188A3dEfbD41978af62',
  usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  usds: '0x4F13a96EC5C4Cf34e442b46Bbd98a0791F20edC3',
};
const PINNED_TREE = {
  parent: '0x37ab5cbeee3a32289430e5d38b914ec7f580fd87',
  parentInvalid: '0xe0d849F471037A9bE5dB2bDf21f9abaaBaD9F25c',
  bundles: ['0x8d883809dE718bAF9FCAd72133007B6115f77F6D', '0x9F26c46B5d70E5d9ce2b499F7F3d520f34aDd353',
    '0xa6Ebc6002ACB875A31922c37d2A9d5bb319d2b06'],
  middles: [
    { bundle: 'A', market: '0xc217920a91f1b3d56276393aa5345f01a848ecf0', invalid: '0x22DE5F831d7d61698dd56D7fD5B3d4a4B8710b83', repos: 33 },
    { bundle: 'B', market: '0xf0638b8999aaa0de3f5d02048a385a64e7a63aec', invalid: '0x27CA6b333E5E0f7BA5635B72F8E03c40a84A68A3', repos: 33 },
    { bundle: 'C', market: '0x99a941135226813037e15e34956fdd79761307d3', invalid: '0xf91A162f24d2DeF43AD939e52fcF5CF9Fb8aaf6c', repos: 32 },
  ],
};
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

const IF = {
  erc20: new Interface([
    'function approve(address spender, uint256 amount) returns (bool)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function transferFrom(address from, address to, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenId() view returns (uint256)',
  ]),
  router: new Interface([
    'function splitPosition(address collateralToken, address market, uint256 amount)',
    'function mergePositions(address collateralToken, address market, uint256 amount)',
    'function redeemPositions(address collateralToken, address market, uint256[] outcomeIndexes, uint256[] amounts)',
  ]),
  swap: new Interface([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
    'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)',
  ]),
  psm3: new Interface([
    'function swapExactIn(address assetIn, address assetOut, uint256 amountIn, uint256 minAmountOut, address receiver, uint256 referralCode) returns (uint256 amountOut)',
    'function swapExactOut(address assetIn, address assetOut, uint256 amountOut, uint256 maxAmountIn, address receiver, uint256 referralCode) returns (uint256 amountIn)',
    'function susds() view returns (address)', 'function usdc() view returns (address)', 'function usds() view returns (address)',
  ]),
  market: new Interface([
    'function wrappedOutcome(uint256 index) view returns (address wrapped1155, bytes data)',
    'function conditionId() view returns (bytes32)',
    'function parentCollectionId() view returns (bytes32)',
  ]),
  ctf: new Interface([
    'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
    'function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)',
  ]),
  factory: new Interface(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)']),
  pool: new Interface([
    'function fee() view returns (uint24)', 'function token0() view returns (address)',
    'function token1() view returns (address)', 'function liquidity() view returns (uint128)',
  ]),
  multicall: new Interface([
    'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  ]),
};
const SEL = {
  approve: IF.erc20.getFunction('approve').selector,
  transfer: IF.erc20.getFunction('transfer').selector,
  transferFrom: IF.erc20.getFunction('transferFrom').selector,
  split: IF.router.getFunction('splitPosition').selector,
  merge: IF.router.getFunction('mergePositions').selector,
  redeem: IF.router.getFunction('redeemPositions').selector,
  exactInputSingle: IF.swap.getFunction('exactInputSingle').selector,
  exactOutputSingle: IF.swap.getFunction('exactOutputSingle').selector,
  swapExactIn: IF.psm3.getFunction('swapExactIn').selector,
  swapExactOut: IF.psm3.getFunction('swapExactOut').selector,
};

// ---------------------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------------------
const lc = (a) => String(a).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isAddr = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHex = (v) => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v);
// Output hygiene: strip control characters and redact any run of 100+ hex digits (a signed transaction is
// always longer than that; a 32-byte hash is not), so no code path can print signed bytes by accident.
const scrub = (s) => String(s).replace(/0x[0-9a-fA-F]{100,}/g, '0x[redacted]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
const san = (s) => scrub(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 48);
const isEthersError = (e) => !!e && typeof e === 'object' && typeof e.shortMessage === 'string' && typeof e.code === 'string';

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function writeAll(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    try { off += fs.writeSync(fd, buf, off, buf.length - off); }
    catch (e) { if (e.code === 'EAGAIN') { sleepSync(5); continue; } if (e.code === 'EPIPE') return; throw e; }
  }
}
// stdout is machine output, one JSON object per line, written synchronously so a `broadcast` line is on the
// pipe before the next network call is made.
const emit = (obj) => writeAll(1, JSON.stringify(obj) + '\n');
const warn = (msg) => writeAll(2, scrub(msg) + '\n');

class Refusal extends Error { // an ALLOWLIST refusal: distinct result, decided before any signature
  constructor(rule, detail, extra) { super(detail || rule); this.rule = rule; this.detail = detail || ''; this.extra = extra || {}; }
}
class LockHeld extends Error { // the send-lock is held: a different pre-broadcast refusal
  constructor(lockPath, lock) { super('send-lock held'); this.lockPath = lockPath; this.lock = lock; }
}
class Fail extends Error { // an ordinary error: never an allowlist refusal
  constructor(code, detail, exit = 1, extra) { super(detail || code); this.code = code; this.detail = detail || ''; this.exit = exit; this.extra = extra || {}; }
}
const state = { command: null, lockPath: null, logPath: null };

// ---------------------------------------------------------------------------------------------------------
// Config: signer.config.json, next to this file, never an argument or an environment variable.
// ---------------------------------------------------------------------------------------------------------
const CONFIG_FILE = path.join(__dirname, 'signer.config.json');
const UNLOCK_MODES = ['dpapi', 'password-file', 'keychain', 'secret-service'];
const CONFIG_KEYS = ['chainId', 'rpcUrl', 'signerAddress', 'owner', 'projectRoot', 'keystorePath', 'signerMode', 'unlockPath',
  'unlockService', 'unlockAccount', 'allowlistPath', 'allowlistSha256', 'sendLockPath', 'logPath', 'receiptTimeoutSec',
  'receiptPollMs', 'rpcTimeoutMs', 'rpcRetries', 'rpcBackoffMs'];

const normCase = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
function realish(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch { /* not there yet */ }
  const dir = path.dirname(abs);
  return dir === abs ? abs : path.join(realish(dir), path.basename(abs));
}
function isInside(child, parent) {
  const rel = path.relative(normCase(realish(parent)), normCase(realish(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function loadConfig() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { throw new Fail('config', 'signer.config.json next to the signer is missing or is not valid JSON', 2); }
  const bad = (m) => new Fail('config', m, 2);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('signer.config.json must be an object');
  for (const k of Object.keys(raw)) if (!CONFIG_KEYS.includes(k) && !k.startsWith('_')) throw bad(`unknown config key "${san(k)}"`);
  if (raw.chainId !== CHAIN_ID) throw bad('chainId must be 10');
  let url;
  try { url = new URL(raw.rpcUrl); } catch { throw bad('rpcUrl is not a URL'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) throw bad('rpcUrl must be https (http only for a loopback host)');
  if (url.username || url.password || url.hash) throw bad('rpcUrl must not carry credentials or a fragment');
  for (const k of ['signerAddress', 'owner']) if (!isAddr(raw[k])) throw bad(`${k} must be an address`);
  if (lc(raw.signerAddress) === lc(raw.owner)) throw bad('owner must differ from signerAddress');
  for (const k of ['projectRoot', 'keystorePath', 'allowlistPath', 'sendLockPath', 'logPath']) {
    if (typeof raw[k] !== 'string' || !path.isAbsolute(raw[k])) throw bad(`${k} must be an absolute path`);
  }
  if (!UNLOCK_MODES.includes(raw.signerMode)) throw bad(`signerMode must be one of ${UNLOCK_MODES.join(', ')}`);
  if (['dpapi', 'password-file'].includes(raw.signerMode) && (typeof raw.unlockPath !== 'string' || !path.isAbsolute(raw.unlockPath))) {
    throw bad('unlockPath must be an absolute path for this signerMode');
  }
  if (['keychain', 'secret-service'].includes(raw.signerMode) && (typeof raw.unlockService !== 'string' || !/^[\w.@-]{1,80}$/.test(raw.unlockService))) {
    throw bad('unlockService must be a plain service name for this signerMode');
  }
  if (raw.unlockAccount !== undefined && !(typeof raw.unlockAccount === 'string' && /^[\w.@-]{1,80}$/.test(raw.unlockAccount))) throw bad('unlockAccount must be a plain name');
  if (typeof raw.allowlistSha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(raw.allowlistSha256)) throw bad('allowlistSha256 must be 64 hex digits');
  const num = (k, def, min, max) => {
    const v = raw[k] === undefined ? def : raw[k];
    if (!Number.isInteger(v) || v < min || v > max) throw bad(`${k} must be an integer in ${min}..${max}`);
    return v;
  };
  const cfg = {
    chainId: CHAIN_ID, rpcUrl: raw.rpcUrl, signerAddress: getAddress(raw.signerAddress), owner: getAddress(raw.owner),
    projectRoot: raw.projectRoot, keystorePath: raw.keystorePath, signerMode: raw.signerMode, unlockPath: raw.unlockPath,
    unlockService: raw.unlockService, unlockAccount: raw.unlockAccount, allowlistPath: raw.allowlistPath,
    allowlistSha256: lc(raw.allowlistSha256), sendLockPath: raw.sendLockPath, logPath: raw.logPath,
    receiptTimeoutSec: num('receiptTimeoutSec', 120, 1, 3600), receiptPollMs: num('receiptPollMs', 2000, 50, 60000),
    rpcTimeoutMs: num('rpcTimeoutMs', 20000, 100, 120000), rpcRetries: num('rpcRetries', 4, 0, 8),
    rpcBackoffMs: num('rpcBackoffMs', 1000, 1, 60000), configFile: CONFIG_FILE,
  };
  // Everything the agent could rewrite must stay out of reach: the signer, its config, the allowlist, the lock,
  // the log and the key material all live outside the project folder (I-setup.md I.1 section 7).
  const guarded = { 'the signer': __dirname, allowlistPath: cfg.allowlistPath, sendLockPath: cfg.sendLockPath, logPath: cfg.logPath,
    keystorePath: cfg.keystorePath, unlockPath: cfg.unlockPath };
  for (const [what, p] of Object.entries(guarded)) {
    if (p && isInside(p, cfg.projectRoot)) throw bad(`${what} is inside the project folder; install it outside (I-setup.md I.1 section 2)`);
  }
  state.lockPath = cfg.sendLockPath; state.logPath = cfg.logPath;
  return cfg;
}

// ---------------------------------------------------------------------------------------------------------
// Mode-switch detection. The real guarantee is that nothing below ever reads an argument, flag, environment
// variable or agent-writable file to widen what is signed. These tripwires only make an attempt loud, with the
// distinct allowlist refusal, instead of letting it be silently ignored.
// ---------------------------------------------------------------------------------------------------------
// (No bare SIGNER or R3_ here: the skill itself names a parameter R3_DATA_HOST, and an operator's own variable
// about the signer must not turn every send into a refusal. A name that really claims to switch the allowlist
// off carries one of the words below.)
const ENV_TRIPWIRE = /(ALLOW|POLIC|UNRESTRICT|BYPASS|OVERRIDE|UNSAFE|DANGER|NO_?CHECK|SKIP_?(CHECK|ALLOW|POLIC)|NO_?ALLOW|NO_?POLIC|DISABLE_?(ALLOW|POLIC|CHECK|GUARD|SAFE|SIGN|LIST)|SUPERVISED|ADMIN_?MODE)/i;
// Windows PowerShell 5.1 children carry PSExecutionPolicyPreference when launched with -ExecutionPolicy; a
// refusal there would silently block every wake, so it is the one known benign match.
const ENV_BENIGN = new Set(['psexecutionpolicypreference']);
function findModeSwitchEnv(env) {
  for (const k of Object.keys(env || {})) {
    if (ENV_BENIGN.has(k.toLowerCase())) continue;
    if (ENV_TRIPWIRE.test(k)) return k;
  }
  return null;
}
// Node itself can be told, through its environment or its own flags, to run other code before this file (a
// preload) or to load another `ethers` (a swapped decoder can make a bad call read as an allowlisted one). A check
// made inside this process is only ADVISORY against a preload that has already run; the binding defences are
// outside it: the allow rule matches only a command that starts with `node <signer path> send|simulate|check`, and
// the signer, its node_modules and its config live where the wake cannot write. This guard makes the attempt
// loud (the distinct refusal) instead of silent, and also refuses to run with TLS verification switched off.
const NODE_CODE_FLAG = /^(-r|--require|--import|--loader|--experimental-loader)(=|$)/;
function findRuntimeOverride(env, execArgv, projectRoot) {
  for (const a of execArgv || []) if (NODE_CODE_FLAG.test(String(a))) return `node flag "${san(a)}" loads code before the signer`;
  for (const [k, v] of Object.entries(env || {})) {
    const key = k.toLowerCase();
    if (key === 'node_options' && String(v).split(/\s+/).some((t) => NODE_CODE_FLAG.test(t))) return 'NODE_OPTIONS carries a flag that loads code before the signer (--require, -r, --import or --loader)';
    if (key === 'node_tls_reject_unauthorized' && String(v) === '0') return 'NODE_TLS_REJECT_UNAUTHORIZED=0 switches TLS verification of the pinned RPC off';
  }
  let ethersPath = null;
  try { ethersPath = require.resolve('ethers'); } catch { /* the require at the top already succeeded */ }
  if (ethersPath && projectRoot && isInside(ethersPath, projectRoot)) return 'the ethers library resolves to a path inside the project folder, which the agent can write';
  return null;
}
const MODE_KEY_RE =/allow|polic|mode|unrestrict|bypass|override|disable|unsafe|force|admin|sudo|skip|signer|off|trust|danger|yolo|insecure|nocheck|no_check/i;

function parseNonce(v) {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(v)) throw new Fail('usage', '--nonce needs a non-negative decimal integer', 2);
  return Number(v);
}
// The grammar is exactly: <file> and, for send only, --nonce <n>. Anything else is treated as an attempt to
// switch the signer's mode and refused with the distinct allowlist refusal.
function parseArgs(cmd, rest) {
  let file = null; let nonce = null;
  for (let i = 0; i < rest.length; i++) {
    const t = String(rest[i]);
    if (cmd === 'send' && (t === '--nonce' || t.startsWith('--nonce='))) {
      if (nonce !== null) throw new Fail('usage', '--nonce given twice', 2);
      if (t === '--nonce') { if (i + 1 >= rest.length) throw new Fail('usage', '--nonce needs a value', 2); nonce = parseNonce(String(rest[++i])); }
      else nonce = parseNonce(t.slice('--nonce='.length));
      continue;
    }
    if (t.startsWith('-')) throw new Refusal('mode-switch', `flag "${san(t)}" is not part of the ${cmd} grammar; no flag can change the allowlist`);
    if (file === null) { file = t; continue; }
    throw new Refusal('mode-switch', `extra argument "${san(t)}" is not part of the ${cmd} grammar; no argument can change the allowlist`);
  }
  if (file === null) throw new Fail('usage', `${cmd} needs one input file`, 2);
  return { file, nonce };
}

// ---------------------------------------------------------------------------------------------------------
// Input: a JSON list of calls | {calls, chainId?, gasLimit?} | one call | EIP-712 typed data | EIP-7702 authorization
// ---------------------------------------------------------------------------------------------------------
function readInputFile(cfg, file) {
  let st;
  try { st = fs.lstatSync(file); } catch { throw new Fail('usage', 'input file not found', 2); }
  if (!st.isFile()) throw new Fail('usage', 'input must be a regular file (not a link or directory)', 2);
  if (st.size > MAX_INPUT_BYTES) throw new Refusal('input-shape', 'input file is larger than 2 MiB');
  const protectedFiles = [cfg.configFile, cfg.keystorePath, cfg.unlockPath, cfg.allowlistPath, cfg.sendLockPath, cfg.logPath].filter(Boolean);
  const me = normCase(realish(file));
  if (protectedFiles.some((p) => normCase(realish(p)) === me)) throw new Fail('input-path', 'input file is one of the signer\'s own protected files', 2);
  return fs.readFileSync(file);
}
function unknownKey(k, index) {
  const extra = index === undefined ? {} : { index };
  return MODE_KEY_RE.test(k)
    ? new Refusal('mode-switch', `input key "${san(k)}" claims to change the signer mode; the input file cannot change the allowlist`, extra)
    : new Refusal('input-shape', `unknown input key "${san(k)}"`, extra);
}
function parseUint(v, what, index) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && (/^(0|[1-9][0-9]*)$/.test(v) || /^0x[0-9a-fA-F]+$/.test(v))) return BigInt(v);
  throw new Refusal('input-shape', `${what} is not an unsigned integer`, index === undefined ? {} : { index });
}
function normalizeCall(c, index) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Refusal('input-shape', `call ${index} is not an object`, { index });
  for (const k of Object.keys(c)) if (!['to', 'data', 'value'].includes(k)) throw unknownKey(k, index);
  if (!isAddr(c.to)) throw new Refusal('input-shape', `call ${index}: "to" is not an address`, { index });
  const data = c.data === undefined ? '0x' : c.data;
  if (!isHex(data)) throw new Refusal('input-shape', `call ${index}: "data" is not 0x-prefixed even-length hex`, { index });
  const value = c.value === undefined ? 0n : parseUint(c.value, `call ${index}: "value"`, index);
  return { to: lc(c.to), data: lc(data), value };
}
function parseInput(buf) {
  let doc;
  try { doc = JSON.parse(buf.toString('utf8')); } catch { throw new Refusal('input-shape', 'input is not valid JSON'); }
  let calls; let chainId; let gasLimit = null;
  if (Array.isArray(doc)) {
    calls = doc;
  } else if (doc && typeof doc === 'object') {
    const keys = Object.keys(doc);
    const has = (k) => Object.prototype.hasOwnProperty.call(doc, k);
    if (has('primaryType') || (has('types') && has('domain')) || (has('domain') && has('message'))) {
      throw new Refusal('eip712', 'EIP-712 typed data is never signed by this signer (permits, Permit2, EIP-3009 included)');
    }
    if (has('authorizationList') || has('authorization') || has('delegate') || has('contractAddress') || (has('type') && ['4', '0x4', '0x04'].includes(String(doc.type)))
      || (has('address') && !has('to') && !has('calls') && (has('chainId') || has('nonce')))) {
      throw new Refusal('eip7702', 'EIP-7702 authorizations and SetCode transactions are never signed by this signer');
    }
    if ((has('method') && /^(personal_sign|eth_sign|eth_signTypedData(_v\d)?|eth_signTransaction)$/i.test(String(doc.method)))
      || has('personal_sign') || has('signMessage') || (has('message') && !has('calls') && !has('to'))) {
      throw new Refusal('off-chain-signature', 'off-chain signatures (personal_sign, eth_sign, typed data) are never produced by this signer');
    }
    for (const k of keys) if (!['calls', 'chainId', 'gasLimit', 'to', 'data', 'value'].includes(k)) throw unknownKey(k);
    if (has('calls')) {
      if (has('to') || has('data') || has('value')) throw new Refusal('input-shape', 'give either "calls" or a single call, not both');
      calls = doc.calls;
    } else if (has('to')) {
      calls = [{ to: doc.to, data: doc.data, value: doc.value }];
      for (const k of ['to', 'data', 'value']) if (doc[k] === undefined) delete calls[0][k];
    } else {
      throw new Refusal('input-shape', 'input is neither a call list, a call, typed data nor an authorization');
    }
    if (has('chainId')) chainId = doc.chainId;
    if (has('gasLimit')) gasLimit = doc.gasLimit;
  } else {
    throw new Refusal('input-shape', 'input must be a JSON list or object');
  }
  if (chainId !== undefined) {
    let n = null;
    if (typeof chainId === 'number' && Number.isSafeInteger(chainId)) n = BigInt(chainId);
    else if (typeof chainId === 'string' && /^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(chainId)) n = BigInt(chainId);
    if (n !== BigInt(CHAIN_ID)) throw new Refusal('chain-id', 'this signer signs on chain 10 only');
  }
  if (!Array.isArray(calls) || calls.length === 0) throw new Refusal('input-shape', 'the call list is empty');
  const norm = calls.map((c, i) => normalizeCall(c, i));
  let gas = null;
  if (gasLimit !== null) {
    try { gas = parseUint(gasLimit, 'gasLimit'); } catch { throw new Fail('gas-limit', 'gasLimit must be an unsigned integer', 2); }
    if (gas === 0n || gas > MAX_GAS_LIMIT) throw new Fail('gas-limit', 'gasLimit must be 1..16777216 (2^24)', 2);
  }
  return { calls: norm, gasLimit: gas };
}

// ---------------------------------------------------------------------------------------------------------
// The allowlist: a JSON file outside the project folder, sha256 pinned in signer.config.json.
// ---------------------------------------------------------------------------------------------------------
function loadAllowlist(cfg) {
  let buf;
  try { buf = fs.readFileSync(cfg.allowlistPath); } catch { throw new Refusal('allowlist-missing', 'the pinned allowlist file cannot be read; refusing to sign'); }
  const actual = sha256hex(buf);
  if (actual !== cfg.allowlistSha256) {
    throw new Refusal('allowlist-hash-mismatch', `the allowlist file hashes to ${actual.slice(0, 12)}..., the config pins ${cfg.allowlistSha256.slice(0, 12)}...; refusing to sign`);
  }
  let doc;
  try { doc = JSON.parse(buf.toString('utf8')); } catch { throw new Fail('allowlist-invalid', 'the pinned allowlist is not valid JSON', 2); }
  return compilePolicy(doc, cfg);
}
function compilePolicy(doc, cfg) {
  const bad = (m) => new Fail('allowlist-invalid', m, 2);
  const A = (v, m) => { if (!isAddr(v)) throw bad(`${m} is not an address`); return lc(v); };
  if (!doc || typeof doc !== 'object' || doc.format !== FORMAT) throw bad('unknown allowlist format');
  if (doc.chain_id !== CHAIN_ID) throw bad('chain_id must be 10');
  const holder = A(doc.holder, 'holder');
  if (holder !== lc(cfg.signerAddress)) throw bad('holder differs from signerAddress (a local EOA signer is its own holder)');
  const contracts = {};
  for (const k of Object.keys(PINNED)) {
    contracts[k] = A(doc.contracts && doc.contracts[k], `contracts.${k}`);
    if (contracts[k] !== lc(PINNED[k])) throw bad(`contracts.${k} differs from the address pinned in the signer`);
  }
  const parent = doc.parent || {};
  if (A(parent.market, 'parent.market') !== lc(PINNED_TREE.parent)) throw bad('parent.market differs from the pinned parent');
  const wantParent = [...PINNED_TREE.bundles, PINNED_TREE.parentInvalid].map(lc);
  if (!Array.isArray(parent.outcomes) || parent.outcomes.length !== 4 || parent.outcomes.some((a, i) => A(a, 'parent.outcomes') !== wantParent[i])) throw bad('parent.outcomes differ from the pinned bundle and Invalid tokens');
  if (!Array.isArray(doc.middles) || doc.middles.length !== 3) throw bad('middles must list 3 markets');
  const markets = new Map([[lc(PINNED_TREE.parent), 4]]);
  const routerOnly = new Set([lc(PINNED_TREE.parentInvalid)]);
  doc.middles.forEach((m, i) => {
    const want = PINNED_TREE.middles[i];
    if (!m || m.bundle !== want.bundle || A(m.market, 'middle.market') !== lc(want.market) || A(m.invalid, 'middle.invalid') !== lc(want.invalid)
      || A(m.bundle_token, 'middle.bundle_token') !== lc(PINNED_TREE.bundles[i]) || m.slots !== want.repos + 1) throw bad(`middle ${want.bundle} differs from the pinned tree`);
    markets.set(lc(m.market), m.slots);
    routerOnly.add(lc(m.invalid));
  });
  if (!Array.isArray(doc.children) || doc.children.length !== 98) throw bad('children must list the fixed 98 markets');
  const perBundle = { A: 0, B: 0, C: 0 };
  const tokens = new Set([contracts.susds, contracts.usdc, contracts.usds, ...PINNED_TREE.bundles.map(lc)]);
  const pairFee = new Map();
  const seen = new Set([...Object.values(contracts), lc(PINNED_TREE.parent), ...routerOnly, ...PINNED_TREE.bundles.map(lc)]);
  const uniq = (a, what) => { if (seen.has(a)) throw bad(`${what} ${a} appears twice in the allowlist`); seen.add(a); return a; };
  doc.middles.forEach((m) => { uniq(lc(m.market), 'middle market'); });
  doc.children.forEach((c, i) => {
    if (!c || c.index !== i || !['A', 'B', 'C'].includes(c.bundle) || !Number.isInteger(c.slot) || c.slot < 0) throw bad(`children[${i}] is malformed`);
    perBundle[c.bundle]++;
    const market = uniq(A(c.market, `children[${i}].market`), 'child market');
    const repo = uniq(A(c.repo_token, `children[${i}].repo_token`), 'repo token');
    const down = uniq(A(c.down, `children[${i}].down`), 'DOWN token');
    const up = uniq(A(c.up, `children[${i}].up`), 'UP token');
    const inv = uniq(A(c.invalid, `children[${i}].invalid`), 'child Invalid token');
    markets.set(market, 3);
    for (const t of [repo, down, up, inv]) tokens.add(t);
    for (const [side, tok] of [['down', down], ['up', up]]) {
      const fee = c[`fee_${side}`];
      if (fee === null) continue; // no pool was found when the allowlist was built: the pair is not allowed
      if (!FEE_TIERS.includes(fee)) throw bad(`children[${i}].fee_${side} is not a Uniswap v3 tier`);
      pairFee.set(`${tok}|${repo}`, fee); pairFee.set(`${repo}|${tok}`, fee);
    }
  });
  if (perBundle.A !== 33 || perBundle.B !== 33 || perBundle.C !== 32) throw bad('bundle membership must be 33 / 33 / 32');
  const psm3Selectors = new Set(Array.isArray(doc.psm3_selectors) ? doc.psm3_selectors : []);
  if (!psm3Selectors.has('swapExactIn') || [...psm3Selectors].some((s) => !['swapExactIn', 'swapExactOut'].includes(s))) throw bad('psm3_selectors must contain swapExactIn and may add swapExactOut');
  return {
    holder, contracts, markets, tokens, routerOnly, pairFee, psm3Selectors,
    spenders: new Set([contracts.router, contracts.swapRouter02, contracts.psm3]),
    psm3Pairs: new Set([`${contracts.usdc}|${contracts.susds}`, `${contracts.usds}|${contracts.susds}`, `${contracts.susds}|${contracts.usdc}`, `${contracts.susds}|${contracts.usds}`]),
    doc,
  };
}

// decode and require the canonical encoding: dirty bits or trailing bytes are not an allowlisted shape
function decodeStrict(iface, selector, data, index) {
  let frag;
  try {
    frag = iface.getFunction(selector);
    const decoded = iface.decodeFunctionData(frag, data);
    if (iface.encodeFunctionData(frag, decoded).toLowerCase() === data) return decoded;
  } catch (e) {
    if (!isEthersError(e)) throw e; // a bug is an error, never a refusal
  }
  throw new Refusal('malformed-calldata', 'calldata is not the canonical encoding of an allowlisted function', { index });
}

function checkCall(call, P, index) {
  const R = (rule, detail) => new Refusal(rule, detail, { index });
  if (call.value !== 0n) throw R('native-value', 'native value must be 0');
  const { to, data } = call;
  const sel = data.length >= 10 ? data.slice(0, 10) : null;
  if (to === P.contracts.ctf) throw R('ctf-direct', 'ConditionalTokens is never called directly; only the Router unwraps and re-wraps (no CTF selector is allowlisted)');
  if (P.tokens.has(to) || P.routerOnly.has(to)) {
    if (sel === SEL.approve) {
      const d = decodeStrict(IF.erc20, sel, data, index);
      const spender = lc(d[0]);
      if (!P.spenders.has(spender)) throw R('approval-spender', `spender ${spender} is not the Router, SwapRouter02 or PSM3`);
      if (P.routerOnly.has(to) && spender !== P.contracts.router) throw R('approval-spender', 'middle and parent Invalid tokens may be approved to the Router only');
      if (d[1] === UINT256_MAX) throw R('approval-amount', 'an approval of type(uint256).max is never signed; approve the exact amount');
      return;
    }
    if (sel === SEL.transfer || sel === SEL.transferFrom) throw R('token-transfer', 'transfer and transferFrom are never allowlisted');
    throw R('selector', `selector ${sel || '(none)'} is not allowlisted on a token`);
  }
  if (to === P.contracts.router) {
    if (sel === SEL.split || sel === SEL.merge) {
      const d = decodeStrict(IF.router, sel, data, index);
      if (lc(d[0]) !== P.contracts.susds) throw R('router-collateral', 'the Router collateral argument is always sUSDS');
      if (!P.markets.has(lc(d[1]))) throw R('router-market', `market ${lc(d[1])} is not the v3 parent, a middle or one of the 98 children`);
      return;
    }
    if (sel === SEL.redeem) {
      const d = decodeStrict(IF.router, sel, data, index);
      if (lc(d[0]) !== P.contracts.susds) throw R('router-collateral', 'the Router collateral argument is always sUSDS');
      const slots = P.markets.get(lc(d[1]));
      if (slots === undefined) throw R('router-market', `market ${lc(d[1])} is not the v3 parent, a middle or one of the 98 children`);
      if (d[2].length !== d[3].length || d[2].some((i) => i >= BigInt(slots))) throw R('router-args', 'redeem index and amount arrays must match and stay inside the market\'s outcome slots');
      return;
    }
    throw R('selector', `selector ${sel || '(none)'} is not allowlisted on the Router`);
  }
  if (to === P.contracts.swapRouter02) {
    if (sel !== SEL.exactInputSingle && sel !== SEL.exactOutputSingle) throw R('selector', `selector ${sel || '(none)'} is not allowlisted on SwapRouter02`);
    const p = decodeStrict(IF.swap, sel, data, index)[0];
    const a = lc(p.tokenIn); const b = lc(p.tokenOut);
    const fee = P.pairFee.get(`${a}|${b}`);
    if (fee === undefined) throw R('swap-pair', 'swaps are only (UP or DOWN of child j) <-> (repo token j)');
    if (Number(p.fee) !== fee) throw R('swap-fee-tier', `fee ${Number(p.fee)} is not the tier ${fee} pinned for this pair`);
    if (lc(p.recipient) !== P.holder) throw R('recipient', 'the swap recipient is always the holder');
    return;
  }
  if (to === P.contracts.psm3) {
    const name = sel === SEL.swapExactIn ? 'swapExactIn' : sel === SEL.swapExactOut ? 'swapExactOut' : null;
    if (!name || !P.psm3Selectors.has(name)) throw R('selector', `selector ${sel || '(none)'} is not allowlisted on PSM3`);
    const d = decodeStrict(IF.psm3, sel, data, index);
    if (!P.psm3Pairs.has(`${lc(d[0])}|${lc(d[1])}`)) throw R('psm3-pair', 'PSM3 swaps are USDC or USDS <-> sUSDS only');
    if (lc(d[4]) !== P.holder) throw R('receiver', 'the PSM3 receiver is always the holder');
    return;
  }
  throw R('contract', `${to} is not a contract this signer may call`);
}
function checkCalls(calls, P) { calls.forEach((c, i) => checkCall(c, P, i)); }

// The pipeline every restricted subcommand runs before ANY network access and before any key access.
function offlinePipeline(cmd, rest, env) {
  const cfg = loadConfig();
  state.command = cmd;
  const args = parseArgs(cmd, rest);
  const bad = findModeSwitchEnv(env);
  if (bad) throw new Refusal('mode-switch', `environment variable ${san(bad)} looks like an allowlist switch; the signer reads no environment variable to change its behaviour`);
  const override = findRuntimeOverride(env, process.execArgv, cfg.projectRoot);
  if (override) throw new Refusal('mode-switch', `${override}; the signer refuses to run that way`);
  const input =parseInput(readInputFile(cfg, args.file)); // typed data, 7702, signatures, chain id: refused here
  const policy = loadAllowlist(cfg);
  checkCalls(input.calls, policy);
  return { cfg, policy, input, args };
}

// ---------------------------------------------------------------------------------------------------------
// JSON-RPC over the one pinned endpoint. Reads back off on 429/5xx; a send is attempted exactly once.
// ---------------------------------------------------------------------------------------------------------
function makeRpc(cfg) {
  let nextId = 1;
  async function post(payload, retry) {
    const attempts = retry ? cfg.rpcRetries + 1 : 1;
    let last;
    for (let a = 0; a < attempts; a++) {
      if (a > 0) await sleep(Math.min(30000, cfg.rpcBackoffMs * 2 ** (a - 1)));
      let res;
      try {
        res = await fetch(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(cfg.rpcTimeoutMs), redirect: 'error' });
      } catch {
        last = new Fail('rpc-transport', 'network error or timeout talking to the pinned RPC'); last.transport = true; continue;
      }
      if (res.status === 429 || res.status >= 500) { last = new Fail('rpc-http', `HTTP ${res.status} from the pinned RPC`); last.transport = true; continue; }
      if (!res.ok) throw new Fail('rpc-http', `HTTP ${res.status} from the pinned RPC`);
      try { return await res.json(); } catch { throw new Fail('rpc-http', 'the pinned RPC did not answer with JSON'); }
    }
    throw last;
  }
  function rpcError(e) { const f = new Fail('rpc-error', scrub(e && e.message), 1, { rpc_code: e && e.code }); f.rpcCode = e && e.code; return f; }
  async function call(method, params = [], opts = {}) {
    const body = await post({ jsonrpc: '2.0', id: nextId++, method, params }, opts.retry !== false);
    if (!body || typeof body !== 'object') throw new Fail('rpc-http', 'malformed JSON-RPC response');
    if (body.error) throw rpcError(body.error);
    return body.result;
  }
  async function batch(items) {
    const payload = items.map(([method, params]) => ({ jsonrpc: '2.0', id: nextId++, method, params }));
    let body;
    try { body = await post(payload, true); } catch (e) { if (!(e instanceof Fail) || e.transport) throw e; body = null; }
    if (!Array.isArray(body) || body.length !== payload.length) {
      const out = [];
      for (const [method, params] of items) {
        try { out.push({ result: await call(method, params) }); } catch (e) { if (!(e instanceof Fail) || e.code !== 'rpc-error') throw e; out.push({ error: e }); }
      }
      return out;
    }
    const byId = new Map(body.map((r) => [r && r.id, r]));
    return payload.map((p) => {
      const r = byId.get(p.id);
      if (!r) throw new Fail('rpc-http', 'a batched call got no answer');
      return r.error ? { error: rpcError(r.error) } : { result: r.result };
    });
  }
  return { call, batch };
}
const hexInt = (v, what) => { try { return BigInt(v); } catch { throw new Fail('rpc-http', `the RPC returned a malformed ${what}`); } };
// A JSON-RPC error on an eth_call is a revert only when the node says so (code 3, or "revert" in its message, the
// chain helper's test). Anything else, a rate limit worded as a plain error included, stays the RPC error it is, so a
// caller re-runs a throttle and never reads it as a revert.
const isRevert = (e) => e instanceof Fail && e.code === 'rpc-error' && (e.rpcCode === 3 || /revert/i.test(String(e.detail)));

// ---------------------------------------------------------------------------------------------------------
// Key handling. Unlock material and the keystore are read only here, only inside the signing process, only
// after every policy and chain check passed. Nothing below prints, logs, returns or exports key material.
// ---------------------------------------------------------------------------------------------------------
const DPAPI_SCRIPT = '$ErrorActionPreference = \'Stop\'; Add-Type -AssemblyName System.Security; '
  + '$in = [Console]::In.ReadToEnd().Trim(); $b = [Convert]::FromBase64String($in); '
  + '$r = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); '
  + '[Console]::Out.Write([Convert]::ToBase64String($r))';
function notLink(p) { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('link'); }
function readUnlockPassword(cfg, deps = { spawnSync }) {
  try {
    if (cfg.signerMode === 'password-file') {
      notLink(cfg.unlockPath);
      return fs.readFileSync(cfg.unlockPath, 'utf8').replace(/[\r\n]+$/, '');
    }
    if (cfg.signerMode === 'dpapi') {
      if (process.platform !== 'win32') throw new Error('dpapi is Windows-only');
      notLink(cfg.unlockPath);
      const blob = fs.readFileSync(cfg.unlockPath);
      const root = process.env.SystemRoot || 'C:\\Windows';
      const ps = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const enc = Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64');
      const r = deps.spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', enc], {
        input: blob.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 65536,
        stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: root, windir: root },
      });
      if (r.status !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(String(r.stdout).trim())) throw new Error('dpapi');
      return Buffer.from(String(r.stdout).trim(), 'base64');
    }
    if (cfg.signerMode === 'keychain') {
      const argv = ['find-generic-password', '-s', cfg.unlockService, ...(cfg.unlockAccount ? ['-a', cfg.unlockAccount] : []), '-w'];
      const r = deps.spawnSync('security', argv, { encoding: 'utf8', timeout: 30000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status !== 0 || !r.stdout) throw new Error('keychain');
      return String(r.stdout).replace(/[\r\n]+$/, '');
    }
    if (cfg.signerMode === 'secret-service') {
      const r = deps.spawnSync('secret-tool', ['lookup', 'service', cfg.unlockService], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status !== 0 || !r.stdout) throw new Error('secret-service');
      return String(r.stdout).replace(/[\r\n]+$/, '');
    }
  } catch { /* fall through: the message below never carries a secret */ }
  throw new Fail('unlock', 'could not read the unlock material; details suppressed', 1);
}
async function loadWallet(cfg) {
  const password = readUnlockPassword(cfg);
  try {
    notLink(cfg.keystorePath);
    const wallet = await Wallet.fromEncryptedJson(fs.readFileSync(cfg.keystorePath, 'utf8'), password);
    if (wallet.address !== cfg.signerAddress) throw new Fail('unlock', 'the keystore does not hold the configured signerAddress', 1);
    return wallet;
  } catch (e) {
    if (e instanceof Fail) throw e;
    throw new Fail('unlock', 'could not open the keystore; details suppressed', 1);
  } finally { if (Buffer.isBuffer(password)) password.fill(0); }
}

// ---------------------------------------------------------------------------------------------------------
// Send-lock and log. The lock is exclusive-create, declared in every send's output, never cleared by `send`.
// ---------------------------------------------------------------------------------------------------------
function readLock(cfg) {
  let text;
  try { text = fs.readFileSync(cfg.sendLockPath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; return { unreadable: true }; }
  try { const o = JSON.parse(text); return o && typeof o === 'object' ? o : { unreadable: true }; } catch { return { unreadable: true }; }
}
function writeLockFile(cfg, obj) {
  const fd = fs.openSync(cfg.sendLockPath, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function takeLock(cfg, info) {
  fs.mkdirSync(path.dirname(cfg.sendLockPath), { recursive: true });
  let fd;
  try { fd = fs.openSync(cfg.sendLockPath, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw new LockHeld(cfg.sendLockPath, readLock(cfg));
    throw new Fail('lock', 'the send-lock cannot be created', 1);
  }
  try { fs.writeFileSync(fd, JSON.stringify(info)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function releaseLock(cfg, attempt) {
  const lock = readLock(cfg);
  if (lock && lock.attempt === attempt) { try { fs.unlinkSync(cfg.sendLockPath); return true; } catch { return false; } }
  return false;
}
function appendLog(cfg, record, { strict = false } = {}) {
  try {
    fs.mkdirSync(path.dirname(cfg.logPath), { recursive: true });
    const fd = fs.openSync(cfg.logPath, 'a', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...record }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    if (strict) throw new Fail('log', 'the signer log cannot be written; nothing was broadcast', 1);
  }
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---------------------------------------------------------------------------------------------------------
// One transaction: pre-checks, sign, intent at broadcast, one send, receipt. Shared by `send` and the
// supervised entry points; the caller supplies `verifySigned`, run on the actual signed bytes.
// ---------------------------------------------------------------------------------------------------------
async function broadcastOne(cfg, spec) {
  // `send` has already been through the restricted pipeline (which refuses with the allowlist refusal); the
  // supervised entry points reach this point without it, and a signing process must not run with a preload either.
  const override = findRuntimeOverride(process.env, process.execArgv, cfg.projectRoot);
  if (override) throw new Fail('runtime-override', `${override}; the signer refuses to sign that way`, 2);
  const rpc = makeRpc(cfg);
  const attempt = crypto.randomUUID();
  const from = cfg.signerAddress;
  let lockTaken = false; let intentLogged = false;
  try {
    if (spec.lock === 'take') {
      takeLock(cfg, { attempt, pid: process.pid, command: spec.command, started_at: new Date().toISOString(), signer: from });
      lockTaken = true;
      emit({ event: 'lock', command: spec.command, lock_path: cfg.sendLockPath, log_path: cfg.logPath, attempt });
    } else {
      const held = readLock(cfg);
      if (held && (held.unreadable || pidAlive(held.pid))) throw new LockHeld(cfg.sendLockPath, held);
    }
    const [chain, latestR, pendingR, gasPriceR, tipR, balanceR] = await rpc.batch([
      ['eth_chainId', []], ['eth_getTransactionCount', [from, 'latest']], ['eth_getTransactionCount', [from, 'pending']],
      ['eth_gasPrice', []], ['eth_maxPriorityFeePerGas', []], ['eth_getBalance', [from, 'latest']],
    ]);
    for (const r of [chain, latestR, pendingR, gasPriceR, balanceR]) if (r.error) throw r.error;
    if (hexInt(chain.result, 'chain id') !== BigInt(CHAIN_ID)) throw new Refusal('chain-id', 'the pinned RPC is not on chain 10; refusing to sign');
    const latest = Number(hexInt(latestR.result, 'nonce')); const pending = Number(hexInt(pendingR.result, 'nonce'));
    let nonce = pending;
    if (spec.nonce !== null && spec.nonce !== undefined) {
      nonce = spec.nonce;
      // The pinned nonce is judged BEFORE anything is signed, so a used nonce produces no hash and no intent.
      if (nonce < latest) throw new Fail('nonce-too-low', `nonce ${nonce} is already used (the account's confirmed nonce is ${latest}); nothing was signed or broadcast`, 1, { nonce, latest, pending });
      if (nonce > pending) throw new Fail('nonce-gap', `nonce ${nonce} is above the account's pending nonce ${pending}; nothing was signed or broadcast`, 1, { nonce, latest, pending });
    }
    const gasPrice = hexInt(gasPriceR.result, 'gas price');
    const bump = spec.feeBump || 1n;
    const maxFeePerGas = (gasPrice * 2n < 1n ? 1n : gasPrice * 2n) * bump;
    let tip = tipR.error ? gasPrice / 2n : hexInt(tipR.result, 'priority fee');
    tip *= bump;
    const maxPriorityFeePerGas = tip > maxFeePerGas ? maxFeePerGas : tip;
    const txObj = { from, to: getAddress(spec.to), data: spec.data, value: spec.value > 0n ? '0x' + spec.value.toString(16) : '0x0' };
    try { await rpc.call('eth_call', [txObj, 'latest']); }
    catch (e) { if (isRevert(e)) throw new Fail('simulation-reverted', `the transaction reverts in simulation: ${e.detail}`, 1); throw e; }
    let gasLimit; let clamped = false;
    if (spec.gasLimit) gasLimit = spec.gasLimit;
    else {
      const est = hexInt(await rpc.call('eth_estimateGas', [txObj]), 'gas estimate');
      gasLimit = est * 12n / 10n; if (spec.minGas && gasLimit < spec.minGas) gasLimit = spec.minGas;
      if (gasLimit > MAX_GAS_LIMIT) { gasLimit = MAX_GAS_LIMIT; clamped = true; }
    }
    if (hexInt(balanceR.result, 'balance') < gasLimit * maxFeePerGas + spec.value) throw new Fail('insufficient-gas-funds', 'the signer\'s ETH balance does not cover the execution fee ceiling; nothing was signed', 1);

    // ---- from here on, key material is in play ----
    const wallet = await loadWallet(cfg);
    const raw = await wallet.signTransaction({ type: 2, chainId: CHAIN_ID, nonce, to: txObj.to, data: spec.data, value: spec.value, gasLimit, maxFeePerGas, maxPriorityFeePerGas });
    const parsed = Transaction.from(raw);
    if (parsed.from !== from || parsed.chainId !== BigInt(CHAIN_ID) || parsed.nonce !== nonce || lc(parsed.to) !== lc(txObj.to) || lc(parsed.data) !== spec.data || parsed.value !== spec.value) {
      throw new Fail('sign-verify', 'the signed transaction differs from the checked one; nothing was broadcast', 1);
    }
    spec.verifySigned(parsed); // the policy runs once more on the exact signed bytes
    const hash = parsed.hash; const inputHash = keccak256(parsed.data);
    const base = { hash, nonce, input_hash: inputHash, from, to: txObj.to, chain_id: CHAIN_ID };

    // Intent first (durable), lock updated, hash and nonce on stdout, THEN the single send.
    appendLog(cfg, { event: 'broadcast-intent', attempt, command: spec.command, ...base, gas_limit: gasLimit.toString() }, { strict: true });
    intentLogged = true;
    if (lockTaken) writeLockFile(cfg, { attempt, pid: process.pid, command: spec.command, started_at: new Date().toISOString(), signer: from, ...base });
    emit({ event: 'broadcast', ...base, gas_limit: gasLimit.toString(), gas_clamped: clamped, lock_path: cfg.sendLockPath, log_path: cfg.logPath });

    let sent;
    try { sent = await rpc.call('eth_sendRawTransaction', [raw], { retry: false }); }
    catch (e) {
      const why = e instanceof Fail ? e.detail : 'send failed';
      appendLog(cfg, { event: 'broadcast-error', attempt, ...base, detail: why });
      emit({ event: 'unconfirmed', reason: 'send-error', detail: scrub(why), ...base, lock_path: cfg.sendLockPath, lock_released: false, next: 'never re-send; settle this nonce from chain state (reconcile, then I-setup.md I.2 section 6)' });
      return 5;
    }
    if (typeof sent !== 'string' || lc(sent) !== lc(hash)) {
      appendLog(cfg, { event: 'broadcast-anomaly', attempt, ...base });
      emit({ event: 'unconfirmed', reason: 'unexpected-send-response', ...base, lock_path: cfg.sendLockPath, lock_released: false, next: 'never re-send; settle this nonce from chain state' });
      return 5;
    }
    appendLog(cfg, { event: 'broadcast-accepted', attempt, ...base });

    const deadline = Date.now() + cfg.receiptTimeoutSec * 1000;
    let receipt = null; let lastErr = null;
    for (;;) {
      try { receipt = await rpc.call('eth_getTransactionReceipt', [hash]); lastErr = null; } catch (e) { lastErr = e; }
      if (receipt) break;
      if (Date.now() >= deadline) break;
      await sleep(cfg.receiptPollMs);
    }
    if (!receipt || lc(receipt.transactionHash) !== lc(hash) || !['0x0', '0x1'].includes(receipt.status)) {
      appendLog(cfg, { event: 'receipt-timeout', attempt, ...base });
      emit({ event: 'unconfirmed', reason: receipt ? 'malformed-receipt' : 'receipt-timeout', ...(lastErr ? { detail: scrub(lastErr.detail || 'receipt read failed') } : {}), ...base, lock_path: cfg.sendLockPath, lock_released: false, next: 'never re-send; run `node signer.cjs reconcile` once the nonce has settled' });
      return 5;
    }
    const ok = receipt.status === '0x1';
    appendLog(cfg, { event: ok ? 'confirmed' : 'reverted', attempt, ...base, block_number: Number(hexInt(receipt.blockNumber, 'block number')) });
    const released = lockTaken ? releaseLock(cfg, attempt) : false;
    emit({ event: ok ? 'confirmed' : 'reverted', ...base, block_number: Number(hexInt(receipt.blockNumber, 'block number')), gas_used: receipt.gasUsed ? hexInt(receipt.gasUsed, 'gas used').toString() : null, ...(lockTaken ? { lock_path: cfg.sendLockPath, lock_released: released } : {}) });
    return ok ? 0 : 6;
  } catch (e) {
    if (lockTaken && !intentLogged) releaseLock(cfg, attempt); // provably nothing was broadcast
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Restricted subcommands
// ---------------------------------------------------------------------------------------------------------
async function cmdCheck(rest, env) {
  offlinePipeline('check', rest, env); // policy only: no RPC, no key, no signing code on this path
  emit({ allowed: true });
  return 0;
}

async function cmdSimulate(rest, env) {
  const { cfg, input } = offlinePipeline('simulate', rest, env);
  const rpc = makeRpc(cfg);
  const from = cfg.signerAddress;
  const [chain, pendingR] = await rpc.batch([['eth_chainId', []], ['eth_getTransactionCount', [from, 'pending']]]);
  for (const r of [chain, pendingR]) if (r.error) throw r.error;
  if (hexInt(chain.result, 'chain id') !== BigInt(CHAIN_ID)) throw new Refusal('chain-id', 'the pinned RPC is not on chain 10');
  const nonce = Number(hexInt(pendingR.result, 'nonce'));
  const callObjs = input.calls.map((c) => ({ from, to: getAddress(c.to), data: c.data, ...(c.value > 0n ? { value: '0x' + c.value.toString(16) } : {}) }));
  let results; let via = 'eth_simulateV1';
  try {
    const blocks = await rpc.call('eth_simulateV1', [{ blockStateCalls: [{ calls: callObjs }], validation: false }, 'latest']);
    const calls = blocks && blocks[0] && blocks[0].calls;
    if (!Array.isArray(calls) || calls.length !== callObjs.length) throw new Fail('rpc-http', 'eth_simulateV1 returned an unexpected shape');
    results = calls.map((c, i) => ({ index: i, status: c.status, gas_used: c.gasUsed ? hexInt(c.gasUsed, 'gas used').toString() : null, ...(c.error ? { error: scrub(c.error.message || 'reverted') } : {}) }));
  } catch (e) {
    if (!(e instanceof Fail) || e.code !== 'rpc-error' || ![-32601, -32602].includes(e.rpcCode)) throw e;
    via = 'eth_call'; results = [];
    for (let i = 0; i < callObjs.length; i++) {
      try { await rpc.call('eth_call', [callObjs[i], 'latest']); results.push({ index: i, status: '0x1', gas_used: null }); }
      catch (err) { if (!isRevert(err)) throw err; results.push({ index: i, status: '0x0', gas_used: null, error: err.detail }); }
    }
  }
  const ok = results.every((r) => r.status === '0x1');
  emit({ simulated: true, via, ok, broadcast: false, signed: false, from, chain_id: CHAIN_ID, nonce, results });
  return ok ? 0 : 1; // a revert is a non-zero exit, as G section 8 requires ("MUST throw on revert")
}

async function cmdSend(rest, env) {
  const { cfg, policy, input, args } = offlinePipeline('send', rest, env);
  if (input.calls.length !== 1) throw new Fail('one-call-only', 'send signs and broadcasts exactly one call; this signer is a plain EOA with no atomic batches', 2);
  const c = input.calls[0];
  return broadcastOne(cfg, {
    command: 'send', lock: 'take', to: c.to, data: c.data, value: c.value, nonce: args.nonce, gasLimit: input.gasLimit,
    verifySigned: (p) => checkCalls([{ to: lc(p.to), data: lc(p.data), value: p.value }], policy),
  });
}

// ---------------------------------------------------------------------------------------------------------
// Supervised entry points: never matched by `node <signer> send|simulate|check *`, so each one prompts the human.
// There is no destination argument anywhere below: funds only ever go to the owner pinned in the config.
// ---------------------------------------------------------------------------------------------------------
function parseKnownFlags(rest, flags, positionals) {
  const out = { positional: [] }; const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const t = String(rest[i]);
    const name = t.split('=')[0];
    if (flags[name]) {
      if (seen.has(name)) throw new Fail('usage', `${name} given twice`, 2);
      seen.add(name);
      if (flags[name] === 'bool') { out[name] = true; if (t.includes('=')) throw new Fail('usage', `${name} takes no value`, 2); }
      else if (t.includes('=')) out[name] = t.slice(name.length + 1);
      else { if (i + 1 >= rest.length) throw new Fail('usage', `${name} needs a value`, 2); out[name] = String(rest[++i]); }
      continue;
    }
    if (t.startsWith('-')) throw new Fail('usage', `unknown flag "${san(t)}"`, 2);
    out.positional.push(t);
  }
  if (out.positional.length !== positionals) throw new Fail('usage', `expected ${positionals} positional argument(s)`, 2);
  return out;
}
const rawAmount = (v, what) => { if (typeof v !== 'string' || !/^[1-9][0-9]*$/.test(v)) throw new Fail('usage', `${what} must be a positive decimal integer in raw units`, 2); return BigInt(v); };

async function cmdSweepToken(rest) {
  const cfg = loadConfig(); state.command = 'sweep-token';
  const a = parseKnownFlags(rest, { '--amount': 'value' }, 1);
  if (!isAddr(a.positional[0])) throw new Fail('usage', 'the argument is the token to sweep (an address); the destination is always the pinned owner', 2);
  const token = getAddress(a.positional[0]);
  const rpc = makeRpc(cfg);
  const bal = hexInt(await rpc.call('eth_call', [{ to: token, data: IF.erc20.encodeFunctionData('balanceOf', [cfg.signerAddress]) }, 'latest']), 'balance');
  const amount = a['--amount'] !== undefined ? rawAmount(a['--amount'], '--amount') : bal;
  if (amount === 0n) throw new Fail('nothing-to-sweep', 'the signer holds none of this token', 1);
  if (amount > bal) throw new Fail('amount-too-large', 'the amount exceeds the signer\'s balance of this token', 1);
  const data = lc(IF.erc20.encodeFunctionData('transfer', [cfg.owner, amount]));
  return broadcastOne(cfg, { command: 'sweep-token', lock: 'take', to: lc(token), data, value: 0n, nonce: null,
    verifySigned: (p) => { if (lc(p.to) !== lc(token) || lc(p.data) !== data || p.value !== 0n) throw new Fail('sign-verify', 'the signed sweep differs from the owner-only shape', 1); } });
}
async function cmdSweepEth(rest) {
  const cfg = loadConfig(); state.command = 'sweep-eth';
  const a = parseKnownFlags(rest, { '--amount': 'value' }, 0);
  const amount = rawAmount(a['--amount'], '--amount');
  return broadcastOne(cfg, { command: 'sweep-eth', lock: 'take', to: lc(cfg.owner), data: '0x', value: amount, nonce: null, minGas: 21000n,
    verifySigned: (p) => { if (lc(p.to) !== lc(cfg.owner) || lc(p.data) !== '0x' || p.value !== amount) throw new Fail('sign-verify', 'the signed sweep differs from the owner-only shape', 1); } });
}
// The stuck-nonce clearing step of I-setup.md I.2 section 6: a zero-value transaction to the pinned owner at
// nonce n, with a doubled fee so it replaces a pending transaction. It runs while a killed send's lock is
// still there (that is the point), but never while a live process holds the lock.
async function cmdClearNonce(rest) {
  const cfg = loadConfig(); state.command = 'clear-nonce';
  const a = parseKnownFlags(rest, {}, 1);
  const n = parseNonce(a.positional[0]);
  return broadcastOne(cfg, { command: 'clear-nonce', lock: 'none', to: lc(cfg.owner), data: '0x', value: 0n, nonce: n, feeBump: 2n, minGas: 21000n,
    verifySigned: (p) => { if (lc(p.to) !== lc(cfg.owner) || lc(p.data) !== '0x' || p.value !== 0n) throw new Fail('sign-verify', 'the signed transaction differs from the owner-only shape', 1); } });
}
async function cmdReconcile(rest) {
  const cfg = loadConfig(); state.command = 'reconcile';
  parseKnownFlags(rest, {}, 0);
  const lock = readLock(cfg);
  if (!lock) { emit({ status: 'no-lock', lock_path: cfg.sendLockPath }); return 0; }
  if (lock.unreadable) { emit({ status: 'lock-unreadable', lock_path: cfg.sendLockPath, next: 'inspect the lock file by hand; the signer will not guess' }); return 5; }
  if (pidAlive(lock.pid)) { emit({ status: 'in-progress', lock_path: cfg.sendLockPath, pid: lock.pid }); return 5; }
  if (!lock.hash) {
    appendLog(cfg, { event: 'reconcile-cleared', attempt: lock.attempt, reason: 'no broadcast intent recorded' });
    fs.unlinkSync(cfg.sendLockPath);
    emit({ status: 'cleared', reason: 'the killed send never reached its broadcast intent', lock_path: cfg.sendLockPath, lock_released: true });
    return 0;
  }
  const rpc = makeRpc(cfg);
  const [receiptR, latestR] = await rpc.batch([['eth_getTransactionReceipt', [lock.hash]], ['eth_getTransactionCount', [cfg.signerAddress, 'latest']]]);
  if (receiptR.error) throw receiptR.error; if (latestR.error) throw latestR.error;
  const latest = Number(hexInt(latestR.result, 'nonce'));
  const base = { hash: lock.hash, nonce: lock.nonce, input_hash: lock.input_hash, lock_path: cfg.sendLockPath };
  const r = receiptR.result;
  if (r) {
    const ok = r.status === '0x1';
    appendLog(cfg, { event: ok ? 'reconcile-confirmed' : 'reconcile-reverted', attempt: lock.attempt, ...base });
    fs.unlinkSync(cfg.sendLockPath);
    emit({ status: ok ? 'landed' : 'reverted', ...base, block_number: Number(hexInt(r.blockNumber, 'block number')), lock_released: true });
    return 0;
  }
  if (latest > lock.nonce) {
    appendLog(cfg, { event: 'reconcile-superseded', attempt: lock.attempt, ...base });
    fs.unlinkSync(cfg.sendLockPath);
    emit({ status: 'superseded', ...base, latest_nonce: latest, detail: 'the nonce was consumed by another transaction; the recorded hash can never land', lock_released: true });
    return 0;
  }
  emit({ status: 'pending-or-unsent', ...base, latest_nonce: latest, lock_released: false, next: `wait, or consume nonce ${lock.nonce} with: node signer.cjs clear-nonce ${lock.nonce}` });
  return 5;
}
async function cmdInfo(rest) {
  const cfg = loadConfig(); state.command = 'info';
  parseKnownFlags(rest, {}, 0);
  let actual = null;
  try { actual = sha256hex(fs.readFileSync(cfg.allowlistPath)); } catch { /* reported as null */ }
  emit({
    version: VERSION, signer_path: __filename, signer_sha256: sha256hex(fs.readFileSync(__filename)), chain_id: CHAIN_ID,
    ethers_version: require('ethers').version, node_version: process.version,
    rpc_origin: new URL(cfg.rpcUrl).origin, signer_address: cfg.signerAddress, holder: cfg.signerAddress, owner: cfg.owner,
    signer_mode: cfg.signerMode, allowlist_path: cfg.allowlistPath, allowlist_sha256_pinned: cfg.allowlistSha256,
    allowlist_sha256_actual: actual, allowlist_hash_matches: actual === cfg.allowlistSha256, send_lock_path: cfg.sendLockPath,
    log_path: cfg.logPath, atomic_batches: false, nonce_pinning: true, reports_input_hash: true,
    restricted_subcommands: ['send', 'simulate', 'check'],
    supervised_subcommands: ['info', 'reconcile', 'clear-nonce', 'sweep-token', 'sweep-eth', 'allowlist-init'],
  });
  return 0;
}

// ---------------------------------------------------------------------------------------------------------
// allowlist-init: builds the allowlist from the staged skill tables and onchain reads, prints the sha256.
// Operator-run. Reads only; needs no key. Addresses come from the skill's tables, never from fetched data;
// every outcome token and fee tier is derived onchain and verified (I-setup.md I.1 section 7).
// ---------------------------------------------------------------------------------------------------------
function parseCTable(md) {
  const bundles = {}; const rows = []; let cur = null;
  const header = /^###\s+Bundle\s+([ABC])\b.*?parent outcome\s+(\d+).*?bundle token\s+`(0x[0-9a-fA-F]{40})`.*?middle market\s+`(0x[0-9a-fA-F]{40})`.*?\([^)]*?(\d+)\s+repos\s*\+\s*Invalid\s+`(0x[0-9a-fA-F]{40})`/;
  const row = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*`(0x[0-9a-fA-F]{40})`\s*\|\s*`(0x[0-9a-fA-F]{40})`\s*\|/;
  for (const line of md.split(/\r?\n/)) {
    const h = header.exec(line);
    if (h) { cur = h[1]; bundles[cur] = { bundle: cur, parentOutcome: Number(h[2]), bundleToken: lc(h[3]), middle: lc(h[4]), repos: Number(h[5]), invalid: lc(h[6]) }; continue; }
    const r = row.exec(line);
    if (r && cur) rows.push({ index: Number(r[1]), repo: r[2], bundle: cur, slot: Number(r[3]), market: lc(r[4]), repoToken: lc(r[5]) });
  }
  const bad = (m) => new Fail('skill-table', `C-select.md table: ${m}`, 1);
  if (Object.keys(bundles).length !== 3) throw bad('expected the three bundle headers A, B, C');
  if (rows.length !== 98) throw bad(`expected 98 rows, found ${rows.length}`);
  rows.forEach((r, i) => { if (r.index !== i) throw bad(`row ${i} has index ${r.index}`); });
  const all = new Set();
  for (const b of ['A', 'B', 'C']) {
    const mine = rows.filter((r) => r.bundle === b);
    if (mine.length !== bundles[b].repos) throw bad(`bundle ${b} has ${mine.length} rows, its header says ${bundles[b].repos}`);
    mine.forEach((r, i) => { if (r.slot !== i) throw bad(`bundle ${b} slot ${r.slot} is out of order`); });
  }
  for (const r of rows) for (const a of [r.market, r.repoToken]) { if (all.has(a)) throw bad(`address ${a} appears twice`); all.add(a); }
  return { bundles, rows };
}
function parseGTable(md) {
  const found = { middles: {} };
  const addrs = (s) => (s.match(/0x[0-9a-fA-F]{40}/g) || []).map(lc);
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|');
    if (cells.length < 4) continue;
    const label = cells[1].trim(); const a = addrs(cells[2]);
    let m;
    if (/^sUSDS\b/.test(label)) found.susds = a[0];
    else if (/^Seer Router\b/.test(label)) found.router = a[0];
    else if (/^ConditionalTokens\b/.test(label)) found.ctf = a[0];
    else if (/^Uniswap SwapRouter02\b/.test(label)) found.swapRouter02 = a[0];
    else if (/^R3 v3 parent market\b/.test(label)) found.parent = a[0];
    else if (/^Bundle A \/ B \/ C\b/.test(label)) found.bundles = a;
    else if (/^Parent Invalid\b/.test(label)) found.parentInvalid = a[0];
    else if ((m = /^Middle ([ABC])\b/.exec(label))) found.middles[m[1]] = { market: a[0], invalid: a[1] };
    else if (/^PSM3\b/.test(label)) found.psm3 = a[0];
    else if (/^USDC\b/.test(label)) { found.usdc = a[0]; found.usds = a[1]; }
  }
  return found;
}
function crossCheckTables(c, g) {
  const bad = (m) => new Fail('skill-table', `the skill's address tables disagree with the addresses pinned in the signer: ${m}`, 1);
  for (const k of Object.keys(PINNED)) if (g[k] !== lc(PINNED[k])) throw bad(`G table ${k}`);
  if (g.parent !== lc(PINNED_TREE.parent)) throw bad('parent market');
  if (g.parentInvalid !== lc(PINNED_TREE.parentInvalid)) throw bad('parent Invalid');
  if (!g.bundles || g.bundles.join() !== PINNED_TREE.bundles.map(lc).join()) throw bad('bundle tokens (G table)');
  PINNED_TREE.middles.forEach((m, i) => {
    const gm = g.middles[m.bundle]; const cb = c.bundles[m.bundle];
    if (!gm || gm.market !== lc(m.market) || gm.invalid !== lc(m.invalid)) throw bad(`middle ${m.bundle} (G table)`);
    if (cb.middle !== lc(m.market) || cb.invalid !== lc(m.invalid) || cb.bundleToken !== lc(PINNED_TREE.bundles[i]) || cb.parentOutcome !== i || cb.repos !== m.repos) throw bad(`middle ${m.bundle} (C table header)`);
  });
}

function makeChainReader(cfg, delayMs) {
  const rpc = makeRpc(cfg);
  let last = 0;
  const pace = async () => { const wait = last + delayMs - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); };
  async function multicall(entries, chunk) {
    const out = [];
    for (let i = 0; i < entries.length; i += chunk) {
      const part = entries.slice(i, i + chunk);
      const data = IF.multicall.encodeFunctionData('aggregate3', [part.map((e) => [e.target, false, e.iface.encodeFunctionData(e.fn, e.args)])]);
      await pace();
      const res = await rpc.call('eth_call', [{ to: MULTICALL3, data }, 'latest']);
      const decoded = IF.multicall.decodeFunctionResult('aggregate3', res)[0];
      if (decoded.length !== part.length) throw new Fail('chain-read', 'multicall returned the wrong number of results', 1);
      decoded.forEach((r, j) => {
        if (!r.success) throw new Fail('chain-read', `a read failed onchain: ${part[j].fn} on ${part[j].target}`, 1);
        out.push(part[j].iface.decodeFunctionResult(part[j].fn, r.returnData));
      });
    }
    return out;
  }
  return { rpc, pace, multicall };
}

async function buildAllowlist(cfg, c, g, opts) {
  const reader = makeChainReader(cfg, opts.delayMs);
  const { rpc, pace, multicall } = reader;
  const warnings = [];
  await pace();
  if (hexInt(await rpc.call('eth_chainId'), 'chain id') !== BigInt(CHAIN_ID)) throw new Fail('chain-read', 'the pinned RPC is not on chain 10', 1);
  const block = Number(hexInt(await rpc.call('eth_blockNumber'), 'block number'));
  // contracts: code present, PSM3 getters match (I-setup.md I.1 section 1), selectors present in the deployed code
  const codeOf = async (a) => { await pace(); return String(await rpc.call('eth_getCode', [a, 'latest'])); };
  for (const [name, a] of Object.entries({ ...PINNED, multicall3: MULTICALL3, uniswapV3Factory: UNISWAP_V3_FACTORY })) {
    const code = await codeOf(a);
    if (code === '0x' || code.length < 10) throw new Fail('chain-read', `no code at ${name} ${a}`, 1);
    const want = { router: [SEL.split, SEL.merge, SEL.redeem], swapRouter02: [SEL.exactInputSingle, SEL.exactOutputSingle], psm3: [SEL.swapExactIn, ...(opts.swapExactOut ? [SEL.swapExactOut] : [])] }[name];
    for (const s of want || []) if (!code.toLowerCase().includes(s.slice(2))) warnings.push(`selector ${s} not seen in the deployed code of ${name} (a proxy?)`);
  }
  const getters = await multicall([{ target: PINNED.psm3, iface: IF.psm3, fn: 'susds', args: [] }, { target: PINNED.psm3, iface: IF.psm3, fn: 'usdc', args: [] }, { target: PINNED.psm3, iface: IF.psm3, fn: 'usds', args: [] }], 10);
  if (lc(getters[0][0]) !== lc(PINNED.susds) || lc(getters[1][0]) !== lc(PINNED.usdc) || lc(getters[2][0]) !== lc(PINNED.usds)) throw new Fail('chain-read', 'PSM3 getters do not match the pinned sUSDS, USDC and USDS', 1);

  // every market: conditionId, parentCollectionId, wrappedOutcome(0..n)
  const markets = [{ kind: 'parent', address: lc(PINNED_TREE.parent), slots: 4 }];
  c.bundles && ['A', 'B', 'C'].forEach((b) => markets.push({ kind: 'middle', bundle: b, address: c.bundles[b].middle, slots: c.bundles[b].repos + 1 }));
  c.rows.forEach((r) => markets.push({ kind: 'child', row: r, address: r.market, slots: 3 }));
  const reads = [];
  markets.forEach((m, mi) => {
    reads.push({ target: m.address, iface: IF.market, fn: 'conditionId', args: [], mi, what: 'cond' });
    reads.push({ target: m.address, iface: IF.market, fn: 'parentCollectionId', args: [], mi, what: 'parentCol' });
    for (let j = 0; j < m.slots; j++) reads.push({ target: m.address, iface: IF.market, fn: 'wrappedOutcome', args: [j], mi, what: 'wrapped', j });
  });
  const res = await multicall(reads, 100);
  const outcomes = []; // {mi, j, token}
  reads.forEach((rd, i) => {
    const m = markets[rd.mi];
    if (rd.what === 'cond') m.conditionId = res[i][0];
    else if (rd.what === 'parentCol') m.parentCollectionId = res[i][0];
    else outcomes.push({ mi: rd.mi, j: rd.j, token: lc(res[i][0]) });
  });
  // expectations from the skill tables: the table is the authority, the chain must agree
  const tokenOf = (mi, j) => outcomes.find((o) => o.mi === mi && o.j === j).token;
  const bad = (m) => new Fail('verify', m, 1);
  const wantParent = [...PINNED_TREE.bundles, PINNED_TREE.parentInvalid].map(lc);
  wantParent.forEach((t, j) => { if (tokenOf(0, j) !== t) throw bad(`parent wrappedOutcome(${j}) is not the pinned bundle/Invalid token`); });
  ['A', 'B', 'C'].forEach((b, bi) => {
    const mi = 1 + bi; const rows = c.rows.filter((r) => r.bundle === b);
    rows.forEach((r) => { if (tokenOf(mi, r.slot) !== r.repoToken) throw bad(`middle ${b} wrappedOutcome(${r.slot}) is not the table's repo token for ${r.repo}`); });
    if (tokenOf(mi, rows.length) !== lc(PINNED_TREE.middles[bi].invalid)) throw bad(`middle ${b} Invalid token differs from the pinned one`);
  });
  // each wrapped token's tokenId() must equal CTF.getPositionId(sUSDS, getCollectionId(parentCollectionId, conditionId, 1 << j))
  const colRes = await multicall(outcomes.map((o) => ({ target: PINNED.ctf, iface: IF.ctf, fn: 'getCollectionId', args: [markets[o.mi].parentCollectionId, markets[o.mi].conditionId, 1n << BigInt(o.j)] })), 25);
  const posRes = await multicall(colRes.map((r) => ({ target: PINNED.ctf, iface: IF.ctf, fn: 'getPositionId', args: [PINNED.susds, r[0]] })), 100);
  const idRes = await multicall(outcomes.map((o) => ({ target: o.token, iface: IF.erc20, fn: 'tokenId', args: [] })), 100);
  outcomes.forEach((o, i) => { if (idRes[i][0] !== posRes[i][0]) throw bad(`tokenId() of ${o.token} does not match CTF.getPositionId rooted in sUSDS (${markets[o.mi].kind} ${markets[o.mi].address} outcome ${o.j})`); });

  // fee tiers: getPool per tier, then fee(), token0(), token1(), liquidity() of every pool found
  const children = markets.slice(4).map((m, ci) => {
    const mi = 4 + ci;
    return { m, mi, down: tokenOf(mi, 0), up: tokenOf(mi, 1), invalid: tokenOf(mi, 2) };
  });
  const pairs = [];
  children.forEach((ch) => { for (const side of ['down', 'up']) pairs.push({ ch, side, outcome: ch[side], repo: ch.m.row.repoToken }); });
  const poolRes = await multicall(pairs.flatMap((p) => FEE_TIERS.map((t) => ({ target: UNISWAP_V3_FACTORY, iface: IF.factory, fn: 'getPool', args: [p.outcome, p.repo, t] }))), 100);
  const found = [];
  pairs.forEach((p, pi) => FEE_TIERS.forEach((t, ti) => { const pool = lc(poolRes[pi * FEE_TIERS.length + ti][0]); if (pool !== '0x0000000000000000000000000000000000000000') found.push({ p, tier: t, pool }); }));
  const poolInfo = await multicall(found.flatMap((f) => [
    { target: f.pool, iface: IF.pool, fn: 'fee', args: [] }, { target: f.pool, iface: IF.pool, fn: 'token0', args: [] },
    { target: f.pool, iface: IF.pool, fn: 'token1', args: [] }, { target: f.pool, iface: IF.pool, fn: 'liquidity', args: [] }]), 100);
  found.forEach((f, i) => {
    const [fee, t0, t1, liq] = poolInfo.slice(i * 4, i * 4 + 4).map((r) => r[0]);
    if (Number(fee) !== f.tier) throw bad(`pool ${f.pool} reports fee ${fee}, getPool asked for ${f.tier}`);
    if (new Set([lc(t0), lc(t1)]).size !== 2 || ![lc(t0), lc(t1)].includes(f.p.outcome) || ![lc(t0), lc(t1)].includes(f.p.repo)) throw bad(`pool ${f.pool} does not trade the expected pair`);
    f.liquidity = BigInt(liq);
  });
  // One tier is pinned per pair. The skill's verified default is tier 100 (G section 2: "100 on every one of the 196 v3
  // UP/DOWN pools"), so tier 100 is taken whenever its pool holds liquidity: a pool another party seeds at a deeper,
  // different tier before this runs must not become the pinned one just by being deeper. With no live tier-100 pool
  // the most liquid pool wins. More than one pool for a pair is always a warning for the operator to review.
  const pick = (p) => {
    const mine = found.filter((f) => f.p === p);
    if (mine.length === 0) return { fee: null, pool: null, liquidity: '0' };
    mine.sort((x, y) => (x.liquidity === y.liquidity ? x.tier - y.tier : x.liquidity > y.liquidity ? -1 : 1));
    const chosen = mine.find((f) => f.tier === DEFAULT_TIER && f.liquidity > 0n) || mine[0];
    if (mine.length > 1) warnings.push(`${p.ch.m.row.repo} ${p.side}: pools at tiers ${mine.map((f) => f.tier).join(', ')}; pinned tier ${chosen.tier} (tier ${DEFAULT_TIER} when its pool holds liquidity, otherwise the most liquid); review`);
    if (chosen.liquidity === 0n) warnings.push(`${p.ch.m.row.repo} ${p.side}: the pinned pool (tier ${chosen.tier}) holds no liquidity`);
    return { fee: chosen.tier, pool: getAddress(chosen.pool), liquidity: chosen.liquidity.toString() };
  };
  const picked = new Map(pairs.map((p) => [p, pick(p)]));
  for (const p of pairs) if (picked.get(p).fee === null) warnings.push(`${p.ch.m.row.repo} ${p.side}: no pool at any tier ${FEE_TIERS.join('/')}; the pair is NOT allowlisted until the allowlist is regenerated`);

  // Optional cross-check of the data function's body (the chain helper's r3-data.json). The body is DATA: it never
  // adds an address to the allowlist, it can only disagree with the skill tables and the chain and stop the build.
  let r3Checked = null;
  if (opts.r3) r3Checked = crossCheckR3Data(opts.r3.body, children, wantParent);

  const doc = {
    format: FORMAT, chain_id: CHAIN_ID, generated_at: new Date().toISOString(), built_at_block: block,
    built_from: { c_select_sha256: opts.cSha, g_mint_and_trade_sha256: opts.gSha, ...(opts.r3 ? { r3_data_sha256_cross_check_only: opts.r3.sha } : {}) },
    holder: getAddress(cfg.signerAddress),
    contracts: Object.fromEntries(Object.keys(PINNED).map((k) => [k, getAddress(PINNED[k])])),
    psm3_selectors: opts.swapExactOut ? ['swapExactIn', 'swapExactOut'] : ['swapExactIn'],
    parent: { market: getAddress(PINNED_TREE.parent), outcomes: wantParent.map(getAddress) },
    middles: PINNED_TREE.middles.map((m, i) => ({ bundle: m.bundle, market: getAddress(m.market), bundle_token: getAddress(PINNED_TREE.bundles[i]), invalid: getAddress(m.invalid), slots: m.repos + 1 })),
    children: children.map((ch, i) => {
      const r = ch.m.row; const pd = picked.get(pairs.find((p) => p.ch === ch && p.side === 'down')); const pu = picked.get(pairs.find((p) => p.ch === ch && p.side === 'up'));
      return {
        index: i, repo: r.repo, bundle: r.bundle, slot: r.slot, market: getAddress(r.market), repo_token: getAddress(r.repoToken),
        down: getAddress(ch.down), up: getAddress(ch.up), invalid: getAddress(ch.invalid),
        fee_down: pd.fee, fee_up: pu.fee, pool_down: pd.pool, pool_up: pu.pool,
      };
    }),
  };
  const tierCounts = {};
  for (const p of pairs) { const f = String(picked.get(p).fee); tierCounts[f] = (tierCounts[f] || 0) + 1; }
  return { doc, warnings, tierCounts, outcomesChecked: outcomes.length, block, r3Checked };
}
function crossCheckR3Data(body, children, wantParent) {
  const bad = (m) => new Fail('r3-data-mismatch', `the data function body disagrees with the skill tables and the chain: ${m}; nothing was written (the body is data, never the allowlist)`, 1);
  if (!body || !Array.isArray(body.markets) || body.markets.length !== 98) throw bad(`markets.length is ${body && Array.isArray(body.markets) ? body.markets.length : 'missing'}, not 98`);
  if (!Array.isArray(body.parentWrappedTokens) || body.parentWrappedTokens.length !== 4 || body.parentWrappedTokens.some((t, i) => lc(t) !== wantParent[i])) throw bad('parentWrappedTokens differ from the three bundle tokens and the parent Invalid');
  const byId = new Map(body.markets.map((m) => [lc(m && m.id), m]));
  if (byId.size !== 98) throw bad('the market ids are not 98 distinct addresses');
  for (const ch of children) {
    const r = ch.m.row; const d = byId.get(lc(r.market));
    if (!d) throw bad(`${r.repo}: market ${r.market} is not in the body`);
    if (lc(d.collateralToken) !== lc(r.repoToken)) throw bad(`${r.repo}: collateralToken differs from the table's repo token`);
    if (Number(d.parentOutcome) !== r.slot) throw bad(`${r.repo}: parentOutcome ${san(d.parentOutcome)} differs from the table's slot ${r.slot}`);
    const want = [ch.down, ch.up, ch.invalid];
    if (!Array.isArray(d.wrappedTokens) || d.wrappedTokens.length !== 3 || d.wrappedTokens.some((t, k) => lc(t) !== want[k])) throw bad(`${r.repo}: wrappedTokens differ from the onchain wrappedOutcome(0..2)`);
  }
  return children.length;
}

async function cmdAllowlistInit(rest) {
  const cfg = loadConfig(); state.command = 'allowlist-init';
  const a = parseKnownFlags(rest, { '--skill-dir': 'value', '--delay-ms': 'value', '--force': 'bool', '--allow-swap-exact-out': 'bool', '--r3-data': 'value' }, 0);
  const delayMs = a['--delay-ms'] === undefined ? 400 : Number(a['--delay-ms']);
  if (!Number.isInteger(delayMs) || delayMs < 50 || delayMs > 60000) throw new Fail('usage', '--delay-ms must be 50..60000: the init paces its reads on purpose', 2);
  const candidates = a['--skill-dir'] ? [path.resolve(a['--skill-dir'])] : [path.resolve(__dirname, '..')];
  const dir = candidates.find((d) => fs.existsSync(path.join(d, 'steps', 'C-select.md')) && fs.existsSync(path.join(d, 'steps', 'G-mint-and-trade.md')));
  if (!dir) throw new Fail('usage', 'pass --skill-dir <the deep-r3-trade skill folder> (it must hold steps/C-select.md and steps/G-mint-and-trade.md)', 2);
  if (fs.existsSync(cfg.allowlistPath) && !a['--force']) throw new Fail('exists', 'the allowlist file already exists; pass --force to regenerate it (its hash changes, so the config pin must be updated)', 2);
  const cBuf = fs.readFileSync(path.join(dir, 'steps', 'C-select.md')); const gBuf = fs.readFileSync(path.join(dir, 'steps', 'G-mint-and-trade.md'));
  const c = parseCTable(cBuf.toString('utf8')); const g = parseGTable(gBuf.toString('utf8'));
  crossCheckTables(c, g);
  let r3 = null;
  if (a['--r3-data'] !== undefined) {
    let buf;
    try { const p = path.resolve(a['--r3-data']); if (fs.lstatSync(p).isSymbolicLink() || fs.statSync(p).size > 16 * 1024 * 1024) throw new Error('x'); buf = fs.readFileSync(p); } catch { throw new Fail('usage', '--r3-data must name a readable regular file of at most 16 MiB (the chain helper\'s ./run/<run-id>/r3-data.json)', 2); }
    let body; try { body = JSON.parse(buf.toString('utf8')); } catch { throw new Fail('usage', '--r3-data is not valid JSON', 2); }
    r3 = { body, sha: sha256hex(buf) };
  }
  const built = await buildAllowlist(cfg, c, g, { delayMs, swapExactOut: !!a['--allow-swap-exact-out'], cSha: sha256hex(cBuf), gSha: sha256hex(gBuf), r3 });
  const text = JSON.stringify(built.doc, null, 2) + '\n';
  fs.mkdirSync(path.dirname(cfg.allowlistPath), { recursive: true });
  fs.writeFileSync(cfg.allowlistPath, text, { mode: 0o600 });
  const sha = sha256hex(Buffer.from(text, 'utf8'));
  emit({
    allowlist_path: cfg.allowlistPath, sha256: sha, record: `set "allowlistSha256": "${sha}" in signer.config.json`,
    built_at_block: built.block, markets_verified: 102, outcome_tokens_verified: built.outcomesChecked, children: 98,
    pools_pinned_by_fee_tier: built.tierCounts, ...(r3 ? { r3_data_cross_checked_rows: built.r3Checked } : {}), warnings: built.warnings,
  });
  return 0;
}

// ---------------------------------------------------------------------------------------------------------
// Dispatch on argv[0] only. The restricted names are matched exactly and never reinterpret a later token.
// ---------------------------------------------------------------------------------------------------------
const COMMANDS = {
  check: cmdCheck, simulate: cmdSimulate, send: cmdSend, info: cmdInfo, reconcile: cmdReconcile, 'clear-nonce': cmdClearNonce,
  'sweep-token': cmdSweepToken, 'sweep-eth': cmdSweepEth, 'allowlist-init': cmdAllowlistInit,
};
async function main(argv, env) {
  const cmd = argv[0];
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, cmd || '')) {
    warn('usage: node signer.cjs check|simulate <file> | send <file> [--nonce <n>]   (supervised: info, reconcile, clear-nonce, sweep-token, sweep-eth, allowlist-init)');
    throw new Fail('usage', 'unknown or missing subcommand', 2);
  }
  state.command = cmd;
  return COMMANDS[cmd](argv.slice(1), env);
}
function report(e) {
  const extra = state.command && state.command !== 'check' ? { command: state.command, signed: false, broadcast: false } : {};
  if (e instanceof Refusal) {
    emit({ refused: 'allowlist', rule: e.rule, detail: scrub(e.detail), ...(e.extra.index !== undefined ? { index: e.extra.index } : {}), ...extra, ...(state.command === 'send' ? { lock_path: state.lockPath } : {}) });
    return 3;
  }
  if (e instanceof LockHeld) {
    const l = e.lock || {};
    emit({ refused: 'send-lock', detail: 'the signer\'s send-lock is held; a killed send leaves it until `reconcile` clears it', command: state.command, signed: false, broadcast: false, lock_path: e.lockPath,
      lock: l.unreadable ? { unreadable: true } : { pid: l.pid, command: l.command, started_at: l.started_at, hash: l.hash || null, nonce: l.nonce === undefined ? null : l.nonce, input_hash: l.input_hash || null } });
    return 4;
  }
  if (e instanceof Fail) {
    emit({ error: e.code, detail: scrub(e.detail), ...extra, ...e.extra });
    return e.exit;
  }
  // an unexpected exception is an ERROR, never a refusal, and never prints its message (it could carry data)
  warn(`internal error (${e && e.constructor ? e.constructor.name : 'unknown'}); details suppressed`);
  emit({ error: 'internal', detail: 'unexpected failure; details suppressed', ...extra });
  return 1;
}
async function cli() {
  let code;
  try { code = await main(process.argv.slice(2), process.env); } catch (e) { code = report(e); }
  process.exit(code);
}

if (require.main === module) cli();
else module.exports = { // exported for signer.test.cjs only; the CLI above is the interface
  PINNED, PINNED_TREE, SEL, IF, FORMAT, CHAIN_ID, CONFIG_KEYS, MAX_GAS_LIMIT, DPAPI_SCRIPT, Refusal, Fail,
  findModeSwitchEnv, findRuntimeOverride, crossCheckR3Data, parseArgs, parseInput, compilePolicy, checkCalls, offlinePipeline, loadConfig, loadAllowlist,
  parseCTable, parseGTable, crossCheckTables, readUnlockPassword, main, report, hexlify, getBytes,
  sources: { cmdCheck, offlinePipeline, checkCall, checkCalls, parseInput, parseArgs, normalizeCall, loadAllowlist, compilePolicy, decodeStrict, findModeSwitchEnv, findRuntimeOverride, readInputFile },
};
