// planner/lib.cjs - the planner's shared library: pinned config, the inside-project refusal, path confinement,
// the helper and signer subprocess runners (sequential pacing, transient retry), and the one-line JSON summary.
//
// Rules this file enforces for every subcommand (scripts/planner.README.md):
// - The config is planner.config.json NEXT TO planner.cjs, found from __filename only: never from argv, never from
//   an environment variable. A missing, unparsable, symlinked or unexpected config fails closed (exit 2).
// - The planner refuses to run when its own folder is inside the project folder, when the helper or the signer
//   is inside it, or when the current directory is not the configured project root.
// - No key access, ever: no keystore, no password, no wallet file is opened here. Every chain read goes through
//   the read-only chain helper; every send through the signer's `send`. This file opens no socket.
// - Writes only under ./run/<run-id>/ for the run-id of the invocation, plus ./run/csv/ when planner.cjs grants it
//   (the supervised `d --supply ... --continue` path only). Relative to the project root; no `..`, no absolute
//   path, no symlink or junction anywhere on the way.
// - Reads no environment variable to change behaviour.
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const ENTRY_DIR = path.resolve(__dirname, '..'); // the folder holding planner.cjs
const CONFIG_NAME = 'planner.config.json';
const CONFIG_KEYS = ['helperPath', 'signerPath', 'projectRoot', 'rpcGapMs', 'parallel'];

// The forecast methods of this arm's run-ids (exec.armRunIds, the wake's repair, H): the stored CSV's
// 'csv-face-value'; a researched forecast whose method string starts with RESEARCH_METHOD_PREFIX: a supervised run
// that swapped seer-trade's D in (seer-trade's modularity contract), or a run-id an operator made with a research add-on
// before using the CSV; and a method starting with FORECAST_FILE_MARK, which D's forecast-file method (23 to 25 Oct
// 2026, since removed) wrote. Such run-ids may still hold positions, which Half B, H and the repair must keep seeing.
const RESEARCH_METHOD_PREFIX = 'seer-trade D (D-base-forecast.md) swapped into deep-r3-trade';
const FORECAST_FILE_MARK = 'deep-r3-trade D, forecast file';
function isArmForecastMethod(m) { return m === 'csv-face-value' || (typeof m === 'string' && (m.startsWith(RESEARCH_METHOD_PREFIX) || m.startsWith(FORECAST_FILE_MARK))); }
const HELPER_CONFIG_NAME = 'chain-helper.config.json';
const ETHERS_VERSION = '6.17.0';

// Exit codes of the planner (scripts/planner.README.md).
const EXIT = Object.freeze({ OK: 0, INTERNAL: 1, USAGE: 2, STOP: 3, SAFETY: 4, TRANSPORT: 5 });
const MAX_OUTPUT_CHARS = 20000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------

// A failure of the planner itself or of its setup: usage, config, confinement (exit 2 unless stated).
class PlannerError extends Error {
  constructor(code, message, exit = EXIT.USAGE, extra = {}) {
    super(message);
    this.code = code; this.exit = exit; this.extra = extra;
  }
}

// A stop the skill defines. exit 3 (C stop, D stop, stale plan, refusal, affordability skip), 4 (a safety refusal:
// nonce moved, pending transaction, hash mismatch) or 5 (transport failure after retries).
// step: 'C' | 'D' | 'E' | ...; cause: a short machine code; status: the wake-status value the stop implies
// ('aborted' | 'no-csv' | 'csv-store-mismatch'), or null when it is not a wake state (a supervised refusal);
// notes: the human text, in the form the skill asks for (e.g. "C step 2.1: markets.length 97 != 98");
// fields: extra summary fields (counts and the like).
class Stop extends Error {
  constructor({ step, cause, status = null, notes = '', exit = EXIT.STOP, fields = {} }) {
    super(`${step} stop: ${cause}: ${notes}`);
    if (![EXIT.STOP, EXIT.SAFETY, EXIT.TRANSPORT].includes(exit)) throw new Error('Stop exit must be 3, 4 or 5');
    this.step = step; this.cause = cause; this.status = status; this.notes = notes; this.exit = exit; this.fields = fields;
  }
}

// A helper or signer run that failed. helperExit is the tool's own exit code, code its JSON `code` (or `error`).
// transient: the last failure was a transport failure (exit 5 with a transport code or rate-limit text).
class ToolFailure extends Error {
  constructor({ tool, args, helperExit, code, json, text, transient, attempts }) {
    super(`${tool} ${args[0]} failed (exit ${helperExit}${code ? ', ' + code : ''})${text ? ': ' + clip(text, 300) : ''}`);
    this.tool = tool; this.args = args; this.helperExit = helperExit; this.code = code || null; this.json = json || null;
    this.text = text || ''; this.transient = !!transient; this.attempts = attempts;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------------------------

const lc = (s) => String(s).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const nowIsoSec = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function clip(s, n) { const t = String(s === undefined || s === null ? '' : s); return t.length > n ? t.slice(0, n) + '...' : t; }
const isWin = process.platform === 'win32';
const normCase = (p) => (isWin ? p.toLowerCase() : p);
function isInside(base, target) {
  const b = normCase(path.resolve(base)).replace(/[\\/]+$/, '');
  const t = normCase(path.resolve(target));
  return t === b || t.startsWith(b + path.sep);
}
const samePath = (a, b) => normCase(path.resolve(a)).replace(/[\\/]+$/, '') === normCase(path.resolve(b)).replace(/[\\/]+$/, '');
function realpath(p) { return fs.realpathSync.native(p); }
// Last parseable JSON line of a tool's stdout (the helper prints exactly one; the signer's send prints several).
function lastJson(s) {
  const ls = String(s || '').trim().split(/\r?\n/);
  for (let i = ls.length - 1; i >= 0; i--) { const t = ls[i].trim(); if (!t) continue; try { return JSON.parse(t); } catch (e) { /* next */ } }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Config: planner.config.json next to planner.cjs, from __filename only. Fails closed.
// ---------------------------------------------------------------------------------------------------------------

function cfgErr(message, code = 'config_malformed') { return new PlannerError(code, message, EXIT.USAGE); }

function loadConfig() {
  const file = path.join(ENTRY_DIR, CONFIG_NAME);
  let st;
  try { st = fs.lstatSync(file); } catch (e) { throw cfgErr(`config file not found next to planner.cjs (${CONFIG_NAME})`, 'config_missing'); }
  if (st.isSymbolicLink() || !st.isFile()) throw cfgErr('config must be a regular file (no symlink)');
  if (st.size > 65536) throw cfgErr('config is too large');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw cfgErr('config is not valid JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw cfgErr('config must be a JSON object');
  for (const k of Object.keys(raw)) if (!CONFIG_KEYS.includes(k)) throw cfgErr(`unknown config key ${clip(k, 40)}`);
  for (const k of ['helperPath', 'signerPath', 'projectRoot']) {
    if (typeof raw[k] !== 'string' || raw[k].length === 0 || raw[k].length > 1024 || raw[k].includes('\0')) throw cfgErr(`${k} must be a non-empty path string`);
    if (!path.isAbsolute(raw[k])) throw cfgErr(`${k} must be an absolute path`);
  }
  const num = (k, def, lo, hi) => {
    if (raw[k] === undefined) return def;
    if (!Number.isInteger(raw[k]) || raw[k] < lo || raw[k] > hi) throw cfgErr(`${k} must be an integer in ${lo}..${hi}`);
    return raw[k];
  };
  const rpcGapMs = num('rpcGapMs', 120, 0, 60000);
  const parallel = num('parallel', 1, 1, 8);

  // projectRoot: an existing folder (no symlink at the leaf).
  let pst;
  try { pst = fs.lstatSync(raw.projectRoot); } catch (e) { throw cfgErr('projectRoot does not exist'); }
  if (pst.isSymbolicLink() || !pst.isDirectory()) throw cfgErr('projectRoot must be a folder (no symlink)');
  let projectReal; let entryReal; let cwdReal;
  try { projectReal = realpath(raw.projectRoot); entryReal = realpath(ENTRY_DIR); cwdReal = realpath(process.cwd()); } catch (e) { throw cfgErr('cannot resolve the project, planner or current folder'); }

  // The inside-project refusal (the helper's and the signer's rule).
  if (isInside(projectReal, entryReal) || isInside(cwdReal, entryReal)) {
    throw cfgErr('the planner and its config must be installed outside the project folder', 'config_inside_project');
  }
  if (!samePath(cwdReal, projectReal)) {
    throw cfgErr('run the planner from the configured project root (the current folder differs from projectRoot)', 'config_cwd_mismatch');
  }
  // The two tools: regular files, outside the project.
  const tool = (k) => {
    let s;
    try { s = fs.lstatSync(raw[k]); } catch (e) { throw cfgErr(`${k} does not exist`); }
    if (s.isSymbolicLink() || !s.isFile()) throw cfgErr(`${k} must be a regular file (no symlink)`);
    const real = realpath(raw[k]);
    if (isInside(projectReal, real)) throw cfgErr(`${k} is inside the project folder; install it outside`, 'config_inside_project');
    return real;
  };
  const helperPath = tool('helperPath');
  const signerPath = tool('signerPath');
  return Object.freeze({ helperPath, signerPath, projectRoot: projectReal, rpcGapMs, parallel, configFile: file, entryDir: entryReal });
}

// The holder: the signer address the operator pinned in the helper's own config (chain-helper.config.json next to
// helperPath). A public address; no key material. Steps that read balances take it from here.
function holderAddress(cfg) {
  const file = path.join(path.dirname(cfg.helperPath), HELPER_CONFIG_NAME);
  let st;
  try { st = fs.lstatSync(file); } catch (e) { throw cfgErr(`${HELPER_CONFIG_NAME} not found next to the helper`, 'holder_unknown'); }
  if (st.isSymbolicLink() || !st.isFile() || st.size > 65536) throw cfgErr(`${HELPER_CONFIG_NAME} must be a small regular file`, 'holder_unknown');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw cfgErr(`${HELPER_CONFIG_NAME} is not valid JSON`, 'holder_unknown'); }
  const a = raw && raw.signerAddress;
  if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a) || /^0x0{40}$/.test(a)) throw cfgErr('the helper config carries no usable signerAddress', 'holder_unknown');
  return a;
}

// ethers, resolved from next to planner.cjs (never from the project), at the pinned version. Lazy: c, d and e do
// not need it.
let ETHERS = null;
function loadEthers(cfg) {
  if (ETHERS) return ETHERS;
  let p;
  try { p = require.resolve('ethers', { paths: [ENTRY_DIR] }); } catch (e) { throw cfgErr(`ethers ${ETHERS_VERSION} is not installed next to planner.cjs`, 'ethers_missing'); }
  if (isInside(cfg.projectRoot, realpath(p))) throw cfgErr('ethers resolves to a path inside the project folder', 'ethers_inside_project');
  const e = require(p);
  if (e.version !== ETHERS_VERSION) throw cfgErr(`ethers ${ETHERS_VERSION} required, found ${e.version}`, 'ethers_version');
  ETHERS = e;
  return e;
}

// ---------------------------------------------------------------------------------------------------------------
// Path confinement. Every path is "run/<run-id>/<name...>" relative to the project root (forward slashes).
// ---------------------------------------------------------------------------------------------------------------

const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
const COMPONENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const pathErr = (code, message) => new PlannerError(code, `path refused: ${message}`, EXIT.USAGE);

// A run-id names one directory under ./run/. "csv" is the CSV store, never a run-id; colons never appear.
function validateRunId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 100 || !RUN_ID_RE.test(id)) throw new PlannerError('bad_run_id', 'run-id must match [A-Za-z0-9._-]+ (no colon; 1..100 characters)', EXIT.USAGE);
  if (id.startsWith('.') || id.endsWith('.') || WIN_RESERVED_RE.test(id)) throw new PlannerError('bad_run_id', 'run-id must not start or end with a dot or be a reserved device name', EXIT.USAGE);
  if (lc(id) === 'csv') throw new PlannerError('bad_run_id', '"csv" is the CSV store, not a run-id', EXIT.USAGE);
  return id;
}

// Parse "run/<dir>/<a>/<b>" -> { dir, rel: [a, b] }. dir is a run-id or "csv".
function parseRunRel(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || rel.length > 240) throw pathErr('path_malformed', 'empty, NUL or too long');
  if (/^[\\/]{2}/.test(rel) || /^[A-Za-z]:/.test(rel) || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel)) throw pathErr('path_absolute', 'absolute, drive or UNC path');
  if (rel.includes(':')) throw pathErr('path_colon', 'colon in path');
  const parts = rel.replace(/\\/g, '/').split('/');
  if (parts[0] === '.') parts.shift();
  if (parts.some((p) => p === '..')) throw pathErr('path_traversal', '".." component');
  if (parts.some((p) => p === '' || p === '.')) throw pathErr('path_malformed', 'empty or "." component');
  if (parts[0] !== 'run' || parts.length < 3) throw pathErr('path_outside_run', 'must be run/<run-id>/<file>');
  const dir = parts[1];
  if (dir !== 'csv') validateRunId(dir);
  const sub = parts.slice(2);
  for (const c of sub) if (c.length > 100 || !COMPONENT_RE.test(c) || c.endsWith('.') || WIN_RESERVED_RE.test(c)) throw pathErr('path_component', `unacceptable component ${clip(c, 40)}`);
  return { dir, sub };
}

function runBase(cfg) {
  const p = path.join(cfg.projectRoot, 'run');
  let st;
  try { st = fs.lstatSync(p); } catch (e) { throw new PlannerError('run_dir_missing', './run does not exist in the project root', EXIT.USAGE); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw pathErr('path_symlink', './run must be a plain folder');
  return realpath(p);
}

// Resolve a path for reading: every component must exist, none a symlink or junction; the leaf a regular file.
function resolveRead(cfg, rel) {
  const { dir, sub } = parseRunRel(rel);
  const base = runBase(cfg);
  let cur = base;
  for (const comp of [dir, ...sub]) {
    cur = path.join(cur, comp);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { throw pathErr('path_not_found', `no such file ${rel}`); }
    if (st.isSymbolicLink()) throw pathErr('path_symlink', `symlink or junction in ${rel}`);
  }
  if (!fs.lstatSync(cur).isFile()) throw pathErr('path_not_file', `${rel} is not a regular file`);
  if (!isInside(path.join(base, dir), realpath(cur))) throw pathErr('path_escape', `${rel} resolves outside ./run/${dir}/`);
  return cur;
}

function readRunFile(cfg, rel, maxBytes = MAX_FILE_BYTES) {
  const abs = resolveRead(cfg, rel);
  const fd = fs.openSync(abs, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw pathErr('path_not_file', `${rel} is not a regular file`);
    if (st.size > maxBytes) throw pathErr('path_file_too_large', `${rel} is larger than ${maxBytes} bytes`);
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function existsRunFile(cfg, rel) {
  try { resolveRead(cfg, rel); return true; } catch (e) { if (e instanceof PlannerError && e.code === 'path_not_found') return false; throw e; }
}
// Names in run/<dir>/ (a run-id folder or the CSV store); [] when it does not exist. Refuses a symlinked folder.
function listRunDir(cfg, dir) {
  if (dir !== 'csv') validateRunId(dir);
  const base = runBase(cfg);
  const p = path.join(base, dir);
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return []; }
  if (st.isSymbolicLink() || !st.isDirectory()) throw pathErr('path_symlink', `run/${dir} is not a plain folder`);
  return fs.readdirSync(p);
}
// Whether ./run/<run-id>/ exists as a plain folder (the detail file is written only into an existing run folder).
function runDirExists(cfg, runId) {
  validateRunId(runId);
  try { const st = fs.lstatSync(path.join(runBase(cfg), runId)); return st.isDirectory() && !st.isSymbolicLink(); } catch (e) { return false; }
}
// The run-id folders under ./run/ (plain folders only, valid run-id names, "csv" and dot-names excluded).
function listRunIds(cfg) {
  const base = runBase(cfg);
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.isSymbolicLink() && lc(d.name) !== 'csv' && RUN_ID_RE.test(d.name) && !d.name.startsWith('.') && !d.name.endsWith('.'))
    .map((d) => d.name).sort();
}

// Resolve a path for writing. Only run/<runId>/... of this invocation, or run/csv/... when allowCsv is set.
// Missing folders below ./run are created one component at a time; an existing symlink, junction or non-folder on
// the way refuses; an existing leaf must be a regular file.
function resolveWrite(cfg, rel, { runId, allowCsv }) {
  const { dir, sub } = parseRunRel(rel);
  if (dir === 'csv' ? !allowCsv : dir !== runId) throw pathErr('path_not_allowed', `this invocation may not write ${rel}`);
  const base = runBase(cfg);
  let cur = base;
  const comps = [dir, ...sub];
  for (let k = 0; k < comps.length; k++) {
    cur = path.join(cur, comps[k]);
    let st = null;
    try { st = fs.lstatSync(cur); } catch (e) { st = null; }
    const leaf = k === comps.length - 1;
    if (st && st.isSymbolicLink()) throw pathErr('path_symlink', `symlink or junction in ${rel}`);
    if (leaf) { if (st && !st.isFile()) throw pathErr('path_not_file', `${rel} exists and is not a regular file`); break; }
    if (!st) fs.mkdirSync(cur);
    else if (!st.isDirectory()) throw pathErr('path_not_dir', `${comps.slice(0, k + 1).join('/')} is not a folder`);
  }
  const parentReal = realpath(path.dirname(cur));
  if (!isInside(path.join(base, dir), parentReal)) throw pathErr('path_escape', `${rel} resolves outside ./run/${dir}/`);
  return path.join(parentReal, path.basename(cur));
}

// Write a file: atomically (temp file, then rename) by default; flag "wx" writes once and never overwrites.
function writeRunFile(cfg, rel, data, { runId, allowCsv = false, flag } = {}) {
  const abs = resolveWrite(cfg, rel, { runId, allowCsv });
  if (flag === 'wx') { fs.writeFileSync(abs, data, { flag: 'wx' }); return rel; }
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { flag: 'wx' });
  try { fs.renameSync(tmp, abs); } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ } throw e; }
  return rel;
}
function removeRunFile(cfg, rel, { runId }) {
  const abs = resolveWrite(cfg, rel, { runId, allowCsv: false });
  try { fs.unlinkSync(abs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// A file the human names relative to the project root (the supervised `d --supply <csv>`): no absolute path, no
// drive, no UNC, no colon, no "..", no symlink on the way; a regular file of at most 4 MB inside the project.
function readProjectFile(cfg, rel, maxBytes = MAX_FILE_BYTES) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || rel.length > 400) throw pathErr('path_malformed', 'empty, NUL or too long');
  if (/^[\\/]{2}/.test(rel) || /^[A-Za-z]:/.test(rel) || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel)) throw pathErr('path_absolute', 'give a path relative to the project root');
  if (rel.includes(':')) throw pathErr('path_colon', 'colon in path');
  const parts = rel.replace(/\\/g, '/').split('/');
  while (parts[0] === '.') parts.shift();
  if (!parts.length || parts.some((p) => p === '..' || p === '' || p === '.')) throw pathErr('path_traversal', 'empty, "." or ".." component');
  let cur = cfg.projectRoot;
  for (const comp of parts) {
    cur = path.join(cur, comp);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { throw pathErr('path_not_found', `no such file ${rel}`); }
    if (st.isSymbolicLink()) throw pathErr('path_symlink', `symlink or junction in ${rel}`);
  }
  if (!isInside(cfg.projectRoot, realpath(cur))) throw pathErr('path_escape', `${rel} resolves outside the project`);
  const fd = fs.openSync(cur, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw pathErr('path_not_file', `${rel} is not a regular file`);
    if (st.size > maxBytes) throw pathErr('path_file_too_large', `${rel} is larger than ${maxBytes} bytes`);
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------------------------------------------------------
// Subprocess runners: sequential by default (`parallel` slots), `rpcGapMs` between starts, one shared queue for
// the helper and the signer. A rate-limit reply is transient: back off and re-run (helper reads; a signer throttle, below).
// ---------------------------------------------------------------------------------------------------------------

// The helper's transport codes (exit 5): C-select.md step 2, last paragraph.
const TRANSIENT_CODES = new Set(['rpc_unreachable', 'rpc_rate_limited', 'rpc_http', 'rpc_malformed', 'rpc_error', 'block_not_found', 'planner_timeout']);
// A public RPC answers a rate limit as a plain rpc_error whose text says so; applied only to an exit-5 reply.
const RATE_LIMIT_TEXT = /requests per second|rate.?limit|too many requests|\b429\b|exceeded its requests|capacity/i;
const DEFAULT_RETRIES = 5; // re-runs after the first attempt (C-select.md step 2: up to 5 more times)
const HELPER_TIMEOUT_MS = 10 * 60 * 1000;

const queue = { active: 0, waiters: [], nextStart: 0 };
const stats = { helperCalls: 0, helperRetries: 0, signerCalls: 0 };
async function acquire(cfg) {
  while (queue.active >= cfg.parallel) await new Promise((r) => queue.waiters.push(r));
  queue.active++;
  const now = Date.now();
  const start = Math.max(now, queue.nextStart);
  queue.nextStart = start + cfg.rpcGapMs;
  if (start > now) await sleep(start - now);
}
function release() { queue.active--; const w = queue.waiters.shift(); if (w) w(); }

// Spawn `node <script> <args...>` in the project root. Streams stdout lines to onLine. No shell.
function spawnNode(cfg, script, args, { onLine, env, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [script, ...args], { cwd: cfg.projectRoot, windowsHide: true, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let buf = ''; let timedOut = false; let done = false;
    const cap = 8 * 1024 * 1024;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; try { child.kill(); } catch (e) { /* ignore */ } }, timeoutMs) : null;
    child.stdout.on('data', (d) => {
      const s = d.toString();
      if (out.length < cap) out += s;
      if (onLine) { buf += s; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { onLine(line); } catch (e) { /* a callback error never kills the reader */ } } } }
    });
    child.stderr.on('data', (d) => { if (err.length < cap) err += d.toString(); });
    const finish = (code) => {
      if (done) return; done = true;
      if (timer) clearTimeout(timer);
      if (onLine && buf.trim()) { try { onLine(buf.trim()); } catch (e) { /* ignore */ } }
      resolve({ code, stdout: out, stderr: err, timedOut });
    };
    child.on('error', (e) => { err += String(e); finish(-1); });
    child.on('close', (code) => finish(code));
  });
}

// Run the read-only chain helper. Returns { json, attempts }. Throws ToolFailure.
// retries: re-runs on a transient failure (default 5; 0 for `data`, whose failures take C's fallback instead).
async function runHelper(cfg, args, { retries = DEFAULT_RETRIES, log } = {}) {
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string' || /^--/.test(a))) throw new PlannerError('internal', 'helper arguments must be plain strings (the helper takes no options)', EXIT.INTERNAL);
  let attempt = 0;
  for (;;) {
    attempt++;
    await acquire(cfg);
    let r;
    try { stats.helperCalls++; r = await spawnNode(cfg, cfg.helperPath, args, { timeoutMs: HELPER_TIMEOUT_MS }); } finally { release(); }
    const j = lastJson(r.stdout);
    if (r.code === 0 && j && typeof j === 'object' && !j.error) return { json: j, attempts: attempt };
    const code = r.timedOut ? 'planner_timeout' : (j && (j.code || null));
    const exit = r.timedOut ? 5 : r.code;
    const text = (j && (j.error || j.detail)) || r.stderr || r.stdout || '';
    const transient = exit === 5 && ((code && TRANSIENT_CODES.has(code)) || RATE_LIMIT_TEXT.test(String(text)) || RATE_LIMIT_TEXT.test(String(j && j.hint || '')));
    if (transient && attempt <= retries) {
      stats.helperRetries++;
      if (log) log(`helper ${args[0]} transient failure (${code || 'exit ' + exit}), re-run ${attempt} of ${retries}`);
      await sleep(Math.min(20000, 1500 * attempt));
      continue;
    }
    throw new ToolFailure({ tool: 'helper', args, helperExit: exit, code, json: j, text, transient, attempts: attempt });
  }
}

// The signer's restricted subcommands only. `info`, `reconcile`, `clear-nonce`, `sweep-*` and `allowlist-init` are
// supervised entry points and are never run by the planner. `send` is never timed out (the signer has its own receipt
// timeout; a killed send would leave its broadcast state unknown). A signer throttle (I-setup.md I.2 section 7, Rate
// limits) is a non-zero exit whose JSON has `error` rpc-error, rpc-http or rpc-transport, no "simulated":true, and
// rate-limit text in `detail`; it is re-run like the helper's: a `simulate`, and a `send` only when that attempt printed
// no `broadcast` line and says signed:false, broadcast:false (nothing signed, nothing sent). `check` makes no RPC call.
const SIGNER_SUBS = new Set(['check', 'simulate', 'send']);
const SIGNER_RPC_ERRORS = new Set(['rpc-error', 'rpc-http', 'rpc-transport']);
function signerThrottled(sub, code, last, lines) {
  if (code === 0 || !last || last.simulated === true || !SIGNER_RPC_ERRORS.has(last.error) || !RATE_LIMIT_TEXT.test(String(last.detail || ''))) return false;
  if (sub === 'send') return last.signed === false && last.broadcast === false && !lines.some((j) => j && (j.event === 'broadcast' || j.hash));
  return sub === 'simulate';
}
async function runSigner(cfg, sub, file, extra = [], { onLine, env, retries = 0, log } = {}) {
  if (!SIGNER_SUBS.has(sub)) throw new PlannerError('internal', `the planner runs only the signer's check, simulate and send (not ${clip(sub, 20)})`, EXIT.INTERNAL);
  if (typeof file !== 'string') throw new PlannerError('internal', 'signer file argument missing', EXIT.INTERNAL);
  parseRunRel(file); // the input file is always a confined run/<run-id>/<file>
  if (!Array.isArray(extra) || extra.some((a) => typeof a !== 'string')) throw new PlannerError('internal', 'signer arguments must be strings', EXIT.INTERNAL);
  if (sub !== 'send' && extra.length) throw new PlannerError('internal', `signer ${sub} takes only its file`, EXIT.INTERNAL);
  if (sub === 'send' && !(extra.length === 0 || (extra.length === 2 && extra[0] === '--nonce' && /^(0|[1-9][0-9]{0,15})$/.test(extra[1])))) throw new PlannerError('internal', 'signer send takes only --nonce <n>', EXIT.INTERNAL);
  const maxRetries = sub === 'check' ? 0 : retries;
  let attempt = 0;
  for (;;) {
    attempt++;
    const lines = [];
    const cb = (line) => { let j = null; try { j = JSON.parse(line); } catch (e) { /* not json */ } lines.push(j); if (onLine) onLine(line, j); };
    await acquire(cfg);
    let r;
    try { stats.signerCalls++; r = await spawnNode(cfg, cfg.signerPath, [sub, file, ...extra], { onLine: cb, env, timeoutMs: sub === 'send' ? 0 : HELPER_TIMEOUT_MS }); } finally { release(); }
    const last = lastJson(r.stdout);
    const rateLimited = !r.timedOut && signerThrottled(sub, r.code, last, lines);
    if (rateLimited && attempt <= maxRetries) {
      if (log) log(`signer ${sub} rate-limited, re-run ${attempt} of ${maxRetries}`);
      await sleep(Math.min(20000, 1500 * attempt));
      continue;
    }
    return { exit: r.code, last, lines: lines.filter(Boolean), stdout: r.stdout, stderr: r.stderr, attempts: attempt, timedOut: r.timedOut };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The invocation context: what a subcommand module gets. Modules print nothing and never exit the process.
// ---------------------------------------------------------------------------------------------------------------

function makeContext({ cfg, sub, runId, opts = {}, allowCsv = false }) {
  validateRunId(runId);
  const runRel = `run/${runId}`;
  const logLines = [];
  const ctx = {
    cfg, sub, runId, opts, runRel, allowCsv: !!allowCsv,
    startedAt: nowIso(),
    detail: {},
    noDetail: false, // set by a refusal that must leave the run folder untouched (no detail file written)
    log: (msg) => { logLines.push(`${nowIso()} ${msg}`); },
    logLines,
    rel: (name) => `${runRel}/${name}`,
    // reads (any run-id or the CSV store; confined, no symlink)
    readRun: (name) => readRunFile(cfg, `${runRel}/${name}`),
    readRunJson: (name) => JSON.parse(readRunFile(cfg, `${runRel}/${name}`).toString('utf8')),
    existsRun: (name) => existsRunFile(cfg, `${runRel}/${name}`),
    readRel: (rel) => readRunFile(cfg, rel),
    existsRel: (rel) => existsRunFile(cfg, rel),
    listRunDir: (dir) => listRunDir(cfg, dir),
    listRunIds: () => listRunIds(cfg),
    readProjectFile: (rel) => readProjectFile(cfg, rel),
    // writes (this run-id; the CSV store only when planner.cjs granted it)
    writeRun: (name, data, o = {}) => writeRunFile(cfg, `${runRel}/${name}`, data, { runId, allowCsv: false, flag: o.flag }),
    writeRunJson: (name, obj, o = {}) => writeRunFile(cfg, `${runRel}/${name}`, JSON.stringify(obj, null, o.indent === undefined ? 2 : o.indent) + (o.newline === false ? '' : '\n'), { runId, allowCsv: false, flag: o.flag }),
    writeRel: (rel, data, o = {}) => writeRunFile(cfg, rel, data, { runId, allowCsv: ctx.allowCsv, flag: o.flag }),
    removeRun: (name) => removeRunFile(cfg, `${runRel}/${name}`, { runId }),
    // tools
    helper: (args, o = {}) => runHelper(cfg, args, { log: ctx.log, ...o }),
    signer: (sub2, file, extra, o = {}) => runSigner(cfg, sub2, file, extra, { log: ctx.log, ...o }),
    holder: () => holderAddress(cfg),
    ethers: () => loadEthers(cfg),
  };
  // One helper multicall over a reads file this step writes (run/<run-id>/<name>), with C's transient re-runs.
  // The answer is accepted only on exit 0 with count equal to the file's reads.
  ctx.multicall = async (name, reads, o = {}) => {
    if (!Array.isArray(reads) || reads.length < 1 || reads.length > 500) throw new PlannerError('internal', `a reads file holds 1..500 reads (${name}: ${reads && reads.length})`, EXIT.INTERNAL);
    ctx.writeRun(name, JSON.stringify(reads));
    const r = await ctx.helper(['multicall', ctx.rel(name)], o);
    const j = r.json;
    if (j.count !== reads.length || !Array.isArray(j.results) || j.results.length !== reads.length) {
      throw new ToolFailure({ tool: 'helper', args: ['multicall', ctx.rel(name)], helperExit: 0, code: 'count_mismatch', json: null, text: `count ${j.count}, results ${j.results && j.results.length}, reads ${reads.length}`, transient: false, attempts: r.attempts });
    }
    return { block: j.block, results: j.results, attempts: r.attempts };
  };
  return ctx;
}
// A context for another subcommand of the same invocation (the wake runs c, d, e, ... in one process).
function subContext(ctx, sub, opts = {}) { return makeContext({ cfg: ctx.cfg, sub, runId: ctx.runId, opts, allowCsv: false }); }

// The detail file of a subcommand: run/<run-id>/planner/<sub>.json (long detail lives here, never on stdout).
function detailRel(ctx) { return `${ctx.runRel}/planner/${ctx.sub}.json`; }
function saveDetail(ctx, summary, toolCalls) {
  const rel = detailRel(ctx);
  const doc = { subcommand: ctx.sub, run_id: ctx.runId, started_at: ctx.startedAt, finished_at: nowIso(), summary, detail: ctx.detail, log: ctx.logLines, tool_calls: toolCalls || { ...stats } };
  writeRunFile(ctx.cfg, rel, JSON.stringify(doc, null, 1) + '\n', { runId: ctx.runId, allowCsv: false });
  return rel;
}

// ---------------------------------------------------------------------------------------------------------------
// One step: load the subcommand's module, run it, map any failure to the exit codes, save the detail file.
// planner.cjs calls it once per invocation; the wake calls it once per step, in process, so every step leaves the
// same summary and detail file whether it ran alone or inside a wake.
// ---------------------------------------------------------------------------------------------------------------

// Each subcommand's module, next to this file; a later step of the build adds its own file.
const MODULES = Object.freeze({ c: './c.cjs', d: './d.cjs', e: './e.cjs', f: './f.cjs', g: './g.cjs', exec: './exec.cjs', halfb: './halfb.cjs', h: './h.cjs', report: './report.cjs', wake: './wake.cjs' });

// Map any failure to (exit, summary fields).
function failureSummary(e, sub) {
  if (e instanceof Stop) return { exit: e.exit, fields: { ok: false, stop: stopJson(e), ...e.fields } };
  if (e instanceof ToolFailure) {
    // A transport failure after the re-runs is exit 5; a tool that refuses its own config, arguments or paths is a
    // setup problem (2); anything else the tool answered (a revert, a decode failure, a count mismatch) is a stop (3).
    const step = String(sub || '').toUpperCase();
    if (e.transient) return { exit: EXIT.TRANSPORT, fields: { ok: false, stop: { step, cause: 'rpc_unreachable', status: 'aborted', notes: `${e.tool} ${e.args.join(' ')} still failed after ${e.attempts} attempt(s): ${e.code || 'exit ' + e.helperExit}: ${clip(e.text, 300)}` } } };
    if ([2, 3, 4, 6].includes(e.helperExit)) return { exit: EXIT.USAGE, fields: { ok: false, error: `${e.tool} refused: ${clip(e.text, 300)}`, code: e.code || `${e.tool}_exit_${e.helperExit}` } };
    return { exit: EXIT.STOP, fields: { ok: false, stop: { step, cause: `${e.tool}_${e.code || 'exit_' + e.helperExit}`, status: 'aborted', notes: clip(e.message, 600) } } };
  }
  if (e instanceof PlannerError) return { exit: e.exit, fields: { ok: false, error: e.message, code: e.code, ...e.extra } };
  return { exit: EXIT.INTERNAL, fields: { ok: false, error: `internal error: ${clip(e && e.stack ? e.stack : e, 1500)}`, code: 'internal' } };
}

// Returns { exit, summary, ctx }. Never throws. The detail file is written only into a run folder that exists, so
// a usage error never creates one. tool_calls in the detail are this step's own counts.
// `step` (the wake only): a step module that is not a subcommand of its own (the PSM3 ramp, planner/ramp.cjs), run the
// same way, with its own summary and detail file run/<run-id>/planner/<sub>.json.
async function runStep({ cfg, sub, runId, opts = {}, allowCsv = false, step = null }) {
  const before = { ...stats };
  let ctx = null; let summary;
  try {
    if (!step && !Object.prototype.hasOwnProperty.call(MODULES, sub)) throw new PlannerError('usage', `unknown subcommand ${clip(sub, 20)}`, EXIT.USAGE);
    ctx = makeContext({ cfg, sub, runId, opts, allowCsv });
    let mod = step;
    if (!mod) try { mod = require(MODULES[sub]); } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).startsWith(`Cannot find module '${MODULES[sub]}'`)) throw new PlannerError('not_installed', `subcommand ${sub} is not part of this planner build`, EXIT.USAGE);
      throw e;
    }
    const res = await mod.run(ctx);
    summary = { subcommand: sub, run_id: runId, ok: true, exit: EXIT.OK, stop: null, ...res };
  } catch (e) {
    const f = failureSummary(e, sub);
    summary = { subcommand: sub, run_id: runId, exit: f.exit, ...f.fields };
    if (ctx) ctx.log(`failure: ${clip(e && e.stack ? e.stack : e, 2000)}`);
  }
  if (ctx) {
    const calls = {}; for (const k of Object.keys(stats)) calls[k] = stats[k] - (before[k] || 0);
    try { summary.detail = !ctx.noDetail && runDirExists(cfg, runId) ? saveDetail(ctx, summary, calls) : null; } catch (e) { summary.detail = null; summary.detail_error = clip(e.message, 200); }
  }
  return { exit: summary.exit, summary, ctx };
}

// ---------------------------------------------------------------------------------------------------------------
// The one-line JSON summary: exactly one line on stdout, never more than 20,000 characters.
// ---------------------------------------------------------------------------------------------------------------

function renderSummary(obj) {
  let text = JSON.stringify(obj);
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const keep = ['subcommand', 'run_id', 'ok', 'exit', 'stop', 'detail', 'error', 'code'];
  const small = {}; for (const k of keep) if (obj[k] !== undefined) small[k] = obj[k];
  small.truncated = true; small.full_chars = text.length;
  text = JSON.stringify(small);
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  if (small.stop && small.stop.notes) small.stop = { ...small.stop, notes: clip(small.stop.notes, 2000) };
  if (small.error) small.error = clip(small.error, 2000);
  return JSON.stringify(small).slice(0, MAX_OUTPUT_CHARS); // cannot happen with the clips above; never more than the cap
}
function emitSummary(obj) { process.stdout.write(renderSummary(obj) + '\n'); }

// A stop object as it appears in a summary.
const stopJson = (s) => ({ step: s.step, cause: s.cause, status: s.status, notes: s.notes });

module.exports = {
  ENTRY_DIR, CONFIG_NAME, CONFIG_KEYS, EXIT, MAX_OUTPUT_CHARS, ETHERS_VERSION, RESEARCH_METHOD_PREFIX, isArmForecastMethod,
  PlannerError, Stop, ToolFailure,
  lc, sleep, nowIso, nowIsoSec, sha256, clip, isInside, lastJson,
  loadConfig, holderAddress, loadEthers,
  validateRunId, parseRunRel, readRunFile, existsRunFile, listRunDir, listRunIds, runDirExists, writeRunFile, readProjectFile,
  TRANSIENT_CODES, RATE_LIMIT_TEXT, DEFAULT_RETRIES, runHelper, runSigner, signerThrottled, stats,
  makeContext, subContext, detailRel, saveDetail, renderSummary, emitSummary, stopJson,
  MODULES, failureSummary, runStep,
};

// ===============================================================================================================
// Later steps append their own clearly separated helpers below this line (P2..P4); nothing above changes.
// ===============================================================================================================

// ---------------------------------------------------------------------------------------------------------------
// P3 (G): list the files of one sub-folder of this run-id's folder, run/<run-id>/<sub>/ (G removes its earlier g-tx/
// files before a rebuild). Plain folders only: a symlink or junction refuses; a missing folder is []. Names that are
// not acceptable path components are left out, so every name returned can be passed back to the confined writers.
// ---------------------------------------------------------------------------------------------------------------
function listRunSubdir(cfg, runId, sub) {
  validateRunId(runId);
  if (typeof sub !== 'string' || !COMPONENT_RE.test(sub) || sub.endsWith('.') || WIN_RESERVED_RE.test(sub)) throw pathErr('path_component', `unacceptable folder name ${clip(sub, 40)}`);
  const base = runBase(cfg);
  let cur = base;
  for (const comp of [runId, sub]) {
    cur = path.join(cur, comp);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { return []; }
    if (st.isSymbolicLink() || !st.isDirectory()) throw pathErr('path_symlink', `run/${runId}/${sub} is not a plain folder`);
  }
  return fs.readdirSync(cur, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.isSymbolicLink() && COMPONENT_RE.test(d.name) && !d.name.endsWith('.') && !WIN_RESERVED_RE.test(d.name))
    .map((d) => d.name).sort();
}
module.exports.listRunSubdir = listRunSubdir;

// ---------------------------------------------------------------------------------------------------------------
// P4 (exec, halfb, h, report, wake). Four narrow additions, nothing above changes:
//  1. The arm lock ./run/.lock.deep-r3-trade (I-setup.md I.2 section 6): read its owner.txt and live-runs.txt; take it
//     with an exclusive mkdir and release it only while owner.txt is still the one written. This folder is the one write
//     outside ./run/<run-id>/ (and ./run/csv/), because every session that sends takes the lock; the planner touches
//     nothing else in it and never deletes a lock it did not take.
//  2. The start time of a process, in the form the wrapper compares (I-setup.md I.2 section 7): ISO 8601 UTC from
//     PowerShell on Windows; `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>`, leading spaces stripped, on macOS and Linux.
//  3. The setup record ./run/setup.deep-r3-trade.json, read only (the gate fields, nonce_pinning, the schedule).
//  4. A confined write into another run-id's folder of this arm (Half B rows, cross-run "consumed" rows, a repair's
//     wake-status.json): the same writer as writeRunFile, with that run-id as the allowed folder.
// ---------------------------------------------------------------------------------------------------------------
const LOCK_NAME = '.lock.deep-r3-trade';
const SETUP_NAME = 'setup.deep-r3-trade.json';
const stripBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

function lockPath(cfg) { return path.join(runBase(cfg), LOCK_NAME); }
function readSmallFile(p, max) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return null; }
  if (st.isSymbolicLink() || !st.isFile()) throw pathErr('path_symlink', `${path.basename(p)} must be a regular file`);
  if (st.size > max) throw pathErr('path_file_too_large', `${path.basename(p)} is larger than ${max} bytes`);
  return stripBom(fs.readFileSync(p, 'utf8'));
}
// { exists, owner (parsed owner.txt or null), ownerRaw, ownerError, liveRuns: [run-id] (null when the file is absent) }
function readLock(cfg) {
  const p = lockPath(cfg);
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return { exists: false, owner: null, ownerRaw: null, ownerError: null, liveRuns: null }; }
  if (st.isSymbolicLink() || !st.isDirectory()) throw pathErr('path_symlink', `run/${LOCK_NAME} is not a plain folder`);
  const raw = readSmallFile(path.join(p, 'owner.txt'), 65536);
  let owner = null; let ownerError = null;
  if (raw === null) ownerError = 'owner.txt is missing';
  else { try { owner = JSON.parse(raw); if (!owner || typeof owner !== 'object' || Array.isArray(owner)) { owner = null; ownerError = 'owner.txt is not a JSON object'; } } catch (e) { ownerError = 'owner.txt is not JSON'; } }
  const lr = readSmallFile(path.join(p, 'live-runs.txt'), 1024 * 1024);
  const liveRuns = lr === null ? null : lr.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return { exists: true, owner, ownerRaw: raw, ownerError, liveRuns };
}
// Exclusive create (mkdir), then owner.txt written once. Returns the exact owner text, or null when the folder exists.
function takeLock(cfg, ownerObj) {
  const p = lockPath(cfg);
  try { fs.mkdirSync(p); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  const text = JSON.stringify(ownerObj);
  try { fs.writeFileSync(path.join(p, 'owner.txt'), text, { flag: 'wx' }); } catch (e) { try { fs.rmdirSync(p); } catch (x) { /* ignore */ } throw e; }
  return text;
}
// Release only while owner.txt is byte-for-byte the text this process wrote; never a lock someone else holds.
function releaseLock(cfg, ownerText) {
  const p = lockPath(cfg);
  let raw = null;
  try { raw = readSmallFile(path.join(p, 'owner.txt'), 65536); } catch (e) { return { released: false, why: e.message }; }
  if (raw === null || raw !== ownerText) return { released: false, why: 'owner.txt no longer names this process' };
  fs.unlinkSync(path.join(p, 'owner.txt'));
  try { fs.rmdirSync(p); } catch (e) { return { released: false, why: `owner.txt removed but the folder was not empty (${e.code})` }; }
  return { released: true };
}
function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (isWin) {
      const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      const t = String(r.stdout || '').trim();
      return r.status === 0 && /^\d{4}-\d\d-\d\dT/.test(t) ? t : null;
    }
    const r = cp.spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 30000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    const t = String(r.stdout || '').replace(/^\s+/, '').replace(/\s+$/, '');
    return r.status === 0 && t ? t : null;
  } catch (e) { return null; }
}
// The setup record, read only; null when it does not exist. A symlink or an unparsable file fails closed.
function readSetup(cfg) {
  const raw = readSmallFile(path.join(runBase(cfg), SETUP_NAME), 1024 * 1024);
  if (raw === null) return null;
  try { const j = JSON.parse(raw); if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object'); return j; } catch (e) {
    throw new PlannerError('setup_malformed', `${SETUP_NAME} is not a JSON object`, EXIT.USAGE);
  }
}
// Write run/<runId>/<name> for a run-id of this arm other than the invocation's own (confined exactly like writeRunFile).
function writeArmFile(cfg, runId, name, data, o = {}) { validateRunId(runId); return writeRunFile(cfg, `run/${runId}/${name}`, data, { runId, allowCsv: false, flag: o.flag }); }
function renameArmFile(cfg, runId, from, to) {
  validateRunId(runId);
  const a = resolveRead(cfg, `run/${runId}/${from}`);
  const b = resolveWrite(cfg, `run/${runId}/${to}`, { runId, allowCsv: false });
  fs.renameSync(a, b);
}
Object.assign(module.exports, { LOCK_NAME, SETUP_NAME, readLock, takeLock, releaseLock, processStartTime, readSetup, writeArmFile, renameArmFile });
