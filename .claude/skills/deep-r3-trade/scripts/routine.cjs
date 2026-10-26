#!/usr/bin/env node
// routine.cjs - the scheduled run of deep-r3-trade on any operating system (steps/I-setup.md I.2 section 7). It is what
// the AI agent of a Claude Code routine runs, and what a person can run by hand the same way. It does what the old
// Windows wrapper did (the arm lock, the hash pins, the installed planner's `wake` exactly once, the final status and
// exit code) and what a cloud run also needs (installing the tools outside the project, pushing the run records).
// Run it from the project root:
//
//   node .claude/skills/deep-r3-trade/scripts/routine.cjs install [--ethers-from <node_modules folder>]
//       the planner, the chain helper and the signer, outside the project (routine.config.json says where), with
//       ethers 6.17.0 and their configs; the signer's keystore and password from the environment variables
//       R3_KEYSTORE_JSON and R3_KEYSTORE_PASSWORD when both are set (written 0600 outside the project, never printed).
//       A first install, with no allowlist in the project yet, lays the tools down and stops (exit 4): its "next"
//       names the installed signer's allowlist-init, whose file goes into the project before install runs again
//       (SETUP.md step 3)
//   node ... routine.cjs trade [--push]
//       one scheduled run: the lock, the planner and signer pins of run/setup.deep-r3-trade.json (the paths must be this
//       install's), `planner wake` once, the final status; --push commits and pushes the run records while the run
//       lasts and at its end
//   node ... routine.cjs clearance [--push]
//       the no-send check of an install: c, d, e, f, g --indep and exec --check on a new run-id; signs nothing. It
//       passes only when exec --check checked a plan (an empty plan checks nothing), and it writes
//       run/<run-id>/clearance.json: the steps, and the sha256 of every installed file it ran
//   node ... routine.cjs selftest --cases run/<setup run-id>/selftest [--push]
//       the signer self-test's policy cases (steps/I-setup.md I.1 section 7, (1) to (16)), as the supervised self-test
//       saved them (case-*.json and results.json), replayed through this install's signer `check`: needs no key or
//       RPC and signs nothing; results in run/setup-<UTC slug>/selftest/results.json
//   node ... routine.cjs status
//       the newest scheduled run's final status
//   node ... routine.cjs planner <subcommand> <run-id> [flags]
//       the installed planner itself (the setup record's, else this config's), from the project root: what a supervised
//       session runs, e.g. `planner d <run-id> --supply inputs/my.csv` and then the same with `--continue`. Its send
//       entry points (exec without --check, halfb --send, wake) are refused where R3_KEYSTORE_JSON or
//       R3_KEYSTORE_PASSWORD is set: there the routine key lives and no human answers, and only `trade` sends
// `node r3.cjs <the same>` at the project root is the short form.
//
// Every subcommand prints one JSON line. Exit codes, as the old wrapper's: 0 done; 1 internal error; 2 usage, config,
// or the lock is held; 3 the run aborted; 4 refused at the gates (a pin, a missing tool or key) or, from `trade`, the
// planner's own safety stop; 5 nothing to trade on (no-csv, csv-store-mismatch) or, from `trade`, the
// planner's transport failure; 6 a time or turn budget ran out. `trade` passes the planner's exit code through
// otherwise (`exitFor`). It signs nothing itself: every send is the planner's, through the signer.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = process.cwd();
const SCRIPTS = __dirname;
const RUN = path.join(ROOT, 'run');
const LOCK = path.join(RUN, '.lock.deep-r3-trade');
const SETUP = path.join(RUN, 'setup.deep-r3-trade.json');
const LOG = path.join(RUN, 'wake-deep-r3.log');
const OUT = path.join(RUN, 'wake-deep-r3-out.json');
const CONFIG = path.join(ROOT, 'routine.config.json');
const ETHERS = '6.17.0';
const isWin = process.platform === 'win32';

class Exit extends Error { constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; } }
const norm = (p) => { const r = path.resolve(p); return isWin ? r.toLowerCase() : r; };
const isInside = (base, target) => { const b = norm(base); const t = norm(target); return t === b || t.startsWith(b + path.sep); };
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const home = (p) => (p === '~' ? os.homedir() : typeof p === 'string' && /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p);
const iso = () => new Date().toISOString();
const clip = (s, n) => { const t = String(s === undefined || s === null ? '' : s); return t.length > n ? t.slice(0, n) + '...' : t; };
function log(line) { try { fs.mkdirSync(RUN, { recursive: true }); fs.appendFileSync(LOG, `[${iso()}] ${line}\n`); } catch (e) { /* the log is best effort */ } }
// the tools' child processes never get the key's environment variables: install has written what the signer reads.
// Nor Claude Code's own variables, which no tool reads: a cloud session sets CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, whose
// name trips the signer's environment tripwire (OVERRIDE), and G's check refused every transaction on it (24 Oct 2026).
const childEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (/^R3_KEYSTORE_(JSON|PASSWORD)$/i.test(k) || /^CLAUDE(CODE$|_)/i.test(k)) delete e[k]; return e; };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
function readSetup() { try { return readJson(SETUP); } catch (e) { return null; } }

// ---- routine.config.json: where the tools go and what they talk to. No secret is ever in it.
const CONFIG_KEYS = ['toolsDir', 'signerDir', 'keysDir', 'stateDir', 'rpcUrl', 'dataFunctionUrl', 'signerAddress', 'owner', 'allowlistFile', 'allowlistSha256', 'planner', 'git'];
const PLANNER_KEYS = ['rpcGapMs', 'parallel'];
// keys a config written before 25 Oct 2026 may still hold: refused, never ignored (a forecastMethod of forecast-file
// silently dropped would trade the stored CSV instead), but named, so updating an install is one deletion
const REMOVED = 'was removed on 25 Oct 2026 with the forecast-file method (D now reads the stored CSV only): delete it';
function loadConfig() {
  let raw;
  try { raw = readJson(CONFIG); } catch (e) { throw new Exit(2, `routine.config.json is missing or not JSON in ${ROOT}; copy routine.config.example.json and fill it in`); }
  if ('forecastImport' in raw) throw new Exit(2, `routine.config.json: forecastImport ${REMOVED}`);
  for (const k of Object.keys(raw)) if (!CONFIG_KEYS.includes(k) && !k.startsWith('_')) throw new Exit(2, `routine.config.json: unknown key ${clip(k, 40)}`);
  const planner = raw.planner || {};
  for (const k of ['forecastMethod', 'forecastMaxAgeHours']) if (k in planner) throw new Exit(2, `routine.config.json: planner.${k} ${REMOVED}`);
  for (const k of Object.keys(planner)) if (!PLANNER_KEYS.includes(k) && !k.startsWith('_')) throw new Exit(2, `routine.config.json: unknown planner key ${clip(k, 40)}`);
  const c = {
    toolsDir: path.resolve(home(raw.toolsDir || '~/r3-tools')),
    signerDir: path.resolve(home(raw.signerDir || '~/.r3-signer-bin')),
    keysDir: path.resolve(home(raw.keysDir || '~/.r3-signer-keys')),
    stateDir: path.resolve(home(raw.stateDir || '~/.r3-signer-state')),
    rpcUrl: raw.rpcUrl || 'https://mainnet.optimism.io',
    dataFunctionUrl: raw.dataFunctionUrl || 'https://deep.seer.pm/.netlify/functions/get-originality-r3-v3-markets-data',
    signerAddress: String(raw.signerAddress || ''), owner: String(raw.owner || ''),
    allowlistFile: raw.allowlistFile || 'setup/r3-allowlist.json', allowlistSha256: String(raw.allowlistSha256 || '').toLowerCase(),
    planner, git: { name: 'deep-r3-trade routine', email: 'noreply@localhost', branch: '', ...(raw.git || {}) },
  };
  for (const k of ['signerAddress', 'owner']) if (!/^0x[0-9a-fA-F]{40}$/.test(c[k])) throw new Exit(2, `routine.config.json: ${k} must be a 0x address`);
  if (c.signerAddress.toLowerCase() === c.owner.toLowerCase()) throw new Exit(2, 'routine.config.json: owner (your own address) must differ from signerAddress (the bot wallet)');
  if (!/^[0-9a-f]{64}$/.test(c.allowlistSha256)) throw new Exit(2, 'routine.config.json: allowlistSha256 must be the allowlist file\'s sha256');
  for (const k of ['toolsDir', 'signerDir', 'keysDir', 'stateDir']) if (isInside(ROOT, c[k])) throw new Exit(2, `routine.config.json: ${k} must be outside the project folder`);
  return c;
}
const paths = (c) => ({
  plannerDir: path.join(c.toolsDir, 'planner'), planner: path.join(c.toolsDir, 'planner', 'planner.cjs'),
  helper: path.join(c.toolsDir, 'chain-helper.cjs'), signer: path.join(c.signerDir, 'signer.cjs'),
  allowlist: path.join(c.signerDir, 'r3-allowlist.json'),
  keystore: path.join(c.keysDir, 'keystore.json'), password: path.join(c.keysDir, 'password'),
  sendLock: path.join(c.stateDir, 'r3-signer-send.lock'), signerLog: path.join(c.stateDir, 'r3-signer.log.jsonl'),
});

// ---- install
function writeFile(p, data, mode) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data, mode ? { mode } : undefined); if (mode && !isWin) fs.chmodSync(p, mode); }
function ethersIn(dir, from) {
  const pj = path.join(dir, 'node_modules', 'ethers', 'package.json');
  const have = () => { try { return readJson(pj).version; } catch (e) { return null; } };
  if (have() === ETHERS) return 'present';
  if (from) {
    if (readJson(path.join(from, 'ethers', 'package.json')).version !== ETHERS) throw new Exit(4, `--ethers-from: ${from} does not hold ethers ${ETHERS}`);
    fs.cpSync(from, path.join(dir, 'node_modules'), { recursive: true });
  } else {
    writeFile(path.join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { ethers: ETHERS } }, null, 2) + '\n');
    const r = cp.spawnSync(isWin ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', dir], { cwd: dir, encoding: 'utf8', timeout: 600000, shell: isWin, env: childEnv() });
    if (r.status !== 0) throw new Exit(4, `npm install ethers@${ETHERS} in ${dir} failed: ${clip(String(r.stderr || (r.error && r.error.message) || ''), 400)}`);
  }
  if (have() !== ETHERS) throw new Exit(4, `ethers ${ETHERS} did not land in ${dir}/node_modules`);
  return 'installed';
}
function install(c, opts) {
  const P = paths(c);
  let prior = null; try { prior = readJson(path.join(c.signerDir, 'signer.config.json')); } catch (e) { prior = null; }
  if (prior && prior.signerMode && prior.signerMode !== 'password-file') {
    throw new Exit(4, `${c.signerDir} holds a signer set up in ${clip(prior.signerMode, 30)} mode, not a routine install; point routine.config.json's signerDir, keysDir, stateDir and toolsDir at other folders`);
  }
  // the planner and its modules, the chain helper, the signer: byte for byte from this repository
  fs.rmSync(path.join(P.plannerDir, 'planner'), { recursive: true, force: true });
  writeFile(P.planner, fs.readFileSync(path.join(SCRIPTS, 'planner.cjs')));
  for (const f of fs.readdirSync(path.join(SCRIPTS, 'planner')).filter((n) => n.endsWith('.cjs'))) writeFile(path.join(P.plannerDir, 'planner', f), fs.readFileSync(path.join(SCRIPTS, 'planner', f)));
  writeFile(P.helper, fs.readFileSync(path.join(SCRIPTS, 'chain-helper.cjs')));
  writeFile(P.signer, fs.readFileSync(path.join(SCRIPTS, 'signer.cjs')));
  // no allowlist in the project yet (a first install): the signer that builds it is laid down with its ethers and its
  // config below, then install stops, naming the command; the key files are not written until the allowlist is in place
  const allowSrc = path.join(ROOT, c.allowlistFile);
  const allowMissing = !fs.existsSync(allowSrc);
  if (!allowMissing && sha256File(allowSrc) !== c.allowlistSha256) throw new Exit(4, `${c.allowlistFile} does not hash to routine.config.json's allowlistSha256`);
  if (!allowMissing) writeFile(P.allowlist, fs.readFileSync(allowSrc));
  const ethers = { tools: ethersIn(c.toolsDir, opts.ethersFrom), signer: ethersIn(c.signerDir, opts.ethersFrom) };

  // the three configs: the planner's next to planner.cjs, the helper's next to the helper, the signer's next to it.
  // A signer config of another mode in signerDir is a machine's own signer setup (I-setup.md I.1 section 2): refused,
  // and checked before anything is written, so a routine install never lands on top of it
  const pcfg = { helperPath: P.helper, signerPath: P.signer, projectRoot: ROOT };
  for (const k of PLANNER_KEYS) if (c.planner[k] !== undefined) pcfg[k] = c.planner[k];
  writeFile(path.join(P.plannerDir, 'planner.config.json'), JSON.stringify(pcfg, null, 1) + '\n');
  writeFile(path.join(c.toolsDir, 'chain-helper.config.json'), JSON.stringify({ chainId: 10, rpcUrl: c.rpcUrl, dataFunctionUrl: c.dataFunctionUrl, signerAddress: c.signerAddress }, null, 1) + '\n');
  fs.mkdirSync(c.stateDir, { recursive: true });
  writeFile(path.join(c.signerDir, 'signer.config.json'), JSON.stringify({
    chainId: 10, rpcUrl: c.rpcUrl, signerAddress: c.signerAddress, owner: c.owner, projectRoot: ROOT,
    keystorePath: P.keystore, signerMode: 'password-file', unlockPath: P.password,
    allowlistPath: P.allowlist, allowlistSha256: c.allowlistSha256, sendLockPath: P.sendLock, logPath: P.signerLog,
  }, null, 1) + '\n');
  if (allowMissing) {
    throw new Exit(4, `the allowlist ${c.allowlistFile} is not in the project yet. The signer is installed: build the allowlist with it (operator-run, steps/I-setup.md I.1 section 7) as "next" says, copy the file it writes to ${c.allowlistFile} byte for byte, set routine.config.json's allowlistSha256 to the sha256 it prints, and run install again`, {
      next: { allowlist_init: `node "${P.signer}" allowlist-init --skill-dir "${path.join(ROOT, '.claude', 'skills', 'deep-r3-trade')}"`, writes: P.allowlist, copy_to: c.allowlistFile, note: 'add --force if allowlist-init says the file already exists' },
    });
  }

  // the key material: from the environment, written 0600 outside the project, never printed or logged
  let keys;
  const kj = process.env.R3_KEYSTORE_JSON; const kp = process.env.R3_KEYSTORE_PASSWORD;
  if (kj && kp) {
    let ks;
    try { ks = JSON.parse(kj); } catch (e) { throw new Exit(4, 'R3_KEYSTORE_JSON is not JSON: it must hold the encrypted keystore file\'s text'); }
    const addr = String((ks && ks.address) || '').toLowerCase().replace(/^0x/, '');
    if (!ks || !ks.crypto && !ks.Crypto) throw new Exit(4, 'R3_KEYSTORE_JSON is not an encrypted keystore (no crypto section)');
    if (addr && addr !== c.signerAddress.toLowerCase().slice(2)) throw new Exit(4, 'R3_KEYSTORE_JSON holds another address than routine.config.json\'s signerAddress');
    fs.mkdirSync(c.keysDir, { recursive: true, mode: 0o700 });
    writeFile(P.keystore, kj, 0o600); writeFile(P.password, kp, 0o600);
    keys = 'installed from the environment';
  } else keys = fs.existsSync(P.keystore) && fs.existsSync(P.password) ? 'present' : 'absent (no R3_KEYSTORE_JSON and R3_KEYSTORE_PASSWORD: this install cannot sign)';

  // the pins the setup record holds (trade refuses unless both match)
  const a = (readSetup() || {}).autonomy || {};
  const pin = (pinPath, pinSha, actual) => (!pinSha ? 'unpinned' : !pinPath || norm(pinPath) !== norm(actual) ? `pinned at another path (${pinPath})` : sha256File(actual) === String(pinSha).toLowerCase() ? 'match' : 'mismatch');
  return {
    ok: true, subcommand: 'install', tools: { planner: P.planner, helper: P.helper, signer: P.signer, allowlist: P.allowlist },
    planner_sha256: sha256File(P.planner), signer_sha256: sha256File(P.signer), allowlist_sha256: c.allowlistSha256, ethers, keys,
    pins: { planner: pin(a.planner_path, a.planner_sha256, P.planner), signer: pin(a.signer_path, a.signer_sha256, P.signer) },
  };
}

// ---- run-ids, the lock, live supervised sessions
// the UTC slug the old wrapper used (2026-10-23T0430Z), -w2 when that folder exists
function newRunId(suffix, prefix = '') {
  const t = new Date().toISOString();
  let rid = `${prefix}${t.slice(0, 10)}T${t.slice(11, 13)}${t.slice(14, 16)}Z${suffix}`;
  if (fs.existsSync(path.join(RUN, rid))) rid += '-w2';
  if (fs.existsSync(path.join(RUN, rid))) throw new Exit(2, `run-id ${rid} is taken`);
  return rid;
}
function startTimeOf(pid) {
  try {
    if (isWin) {
      const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      const t = Date.parse(String(r.stdout || '').trim()); return Number.isFinite(t) ? t : null;
    }
    const r = cp.spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 30000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    const t = Date.parse(String(r.stdout || '').trim() + ' UTC'); return Number.isFinite(t) ? t : null;
  } catch (e) { return null; }
}
// alive: the pid exists on this host and started within 2 seconds of the recorded start; anything unreadable counts as alive
function ownerAlive(o) {
  if (!o || !Number.isInteger(o.pid)) return true;
  if (o.host && o.host !== os.hostname()) return false; // another machine's lock: only its age can clear it
  try { process.kill(o.pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; }
  const recorded = Date.parse(o.process_start_time); const actual = startTimeOf(o.pid);
  if (!Number.isFinite(recorded) || actual === null) return true;
  return Math.abs(actual - recorded) <= 2000;
}
// stale: older than the time limit + 1 h (by its owner's started_at, else the folder's time) and its owner is gone
function clearStaleLock(limitHours) {
  if (!fs.existsSync(LOCK)) return;
  let o = null; try { o = readJson(path.join(LOCK, 'owner.txt')); } catch (e) { o = null; }
  const since = o && Number.isFinite(Date.parse(o.started_at)) ? Date.parse(o.started_at) : fs.statSync(LOCK).mtimeMs;
  if (!(Date.now() - since > (limitHours + 1) * 3600000)) return;
  if (o && ownerAlive(o)) return;
  fs.rmSync(LOCK, { recursive: true, force: true });
  log(`stale lock cleared: older than ${limitHours + 1} h and its owner ${o ? `pid ${o.pid} on ${o.host}` : '(unreadable)'} is gone`);
}
function liveSessions() {
  const live = [];
  for (const d of fs.existsSync(RUN) ? fs.readdirSync(RUN, { withFileTypes: true }) : []) {
    if (!d.isDirectory()) continue;
    const f = path.join(RUN, d.name, 'session-owner.json');
    if (!fs.existsSync(f)) continue;
    let o = null; try { o = readJson(f); } catch (e) { o = null; }
    if (!o || ownerAlive(o)) { live.push(d.name); if (!o) log(`run ${d.name}: session-owner.json unreadable, counted as live`); }
  }
  return live;
}
function release(ownerText) {
  try { if (fs.readFileSync(path.join(LOCK, 'owner.txt'), 'utf8') !== ownerText) return false; } catch (e) { return false; }
  fs.rmSync(LOCK, { recursive: true, force: true }); return true;
}

// ---- the run records in git (routine mode): everything under run/ but the lock and the scratch folders
const RECORD_EXCLUDES = ['.lock.deep-r3-trade', '*/exec-tmp', '*/f-tmp', '*/g-tmp', '*/halfb-tmp', '*/recovery-tmp'];
function git(args, o = {}) { return cp.spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true, ...o }); }
// A checkpoint (rebase false) runs while the planner writes run/: it only commits and pushes, and when origin has moved
// it skips, because a pull would check files out under the planner's feet. The final push, after the planner has
// exited, pulls and rebases (records never collide); a pull that fails is a failed push, its rebase aborted.
function pushRecords(c, message, only, { rebase = true } = {}) {
  const spec = [...(only ? [].concat(only).map((o) => `run/${o}`) : ['run']), ...RECORD_EXCLUDES.map((x) => `:(exclude,glob)run/${x}/**`)];
  const add = git(['add', '-f', '-A', '--', ...spec]);
  if (add.status !== 0) return { pushed: false, error: clip(add.stderr, 300) };
  if (git(['diff', '--cached', '--quiet']).status === 0) return { pushed: false, nothing: true };
  const cm = git(['-c', `user.name=${c.git.name}`, '-c', `user.email=${c.git.email}`, 'commit', '-q', '--no-verify', '-m', message]);
  if (cm.status !== 0) return { pushed: false, error: clip(cm.stderr || cm.stdout, 300) };
  const branch = c.git.branch || String(git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim();
  let last = null;
  for (let i = 0; i < 4; i++) {
    const p = git(['push', '-q', 'origin', `HEAD:${branch}`]);
    if (p.status === 0) return { pushed: true, branch };
    last = p.stderr;
    if (!rebase) return { pushed: false, branch, deferred: true, error: clip(`origin moved; the final push carries this commit: ${last}`, 300) };
    const id = ['-c', `user.name=${c.git.name}`, '-c', `user.email=${c.git.email}`]; // a rebase writes commits too
    const pl = git([...id, 'pull', '-q', '--rebase', 'origin', branch]); // another routine pushed meanwhile; records never collide
    if (pl.status !== 0) { git([...id, 'rebase', '--abort']); return { pushed: false, branch, error: clip(`pull --rebase failed: ${pl.stderr || pl.stdout}`, 300) }; }
  }
  return { pushed: false, branch, error: clip(last, 300) };
}

// ---- the final status, as the old wrapper wrote it
function wakeStatus(rid) { try { return readJson(path.join(RUN, rid, 'wake-status.json')); } catch (e) { return null; } }
function finalize(rid, rc, why) {
  const w = wakeStatus(rid);
  if (w && w.finished_at) return w;
  const dir = path.join(RUN, rid); fs.mkdirSync(dir, { recursive: true });
  const ws = { run_id: rid, started_at: w && w.started_at ? w.started_at : null, finished_at: iso(), status: 'aborted', stopped_at_step: (w && w.stopped_at_step) || null, notes: why || `the planner's wake ended without its final write (exit ${rc}); see run/wake-deep-r3.log` };
  fs.writeFileSync(path.join(dir, 'wake-status.json'), JSON.stringify(ws, null, 2) + '\n');
  if (!fs.existsSync(path.join(dir, 'report.md'))) fs.writeFileSync(path.join(dir, 'report.md'), `# deep-r3-trade run ${rid} - report\n\n- **Status: aborted.** ${ws.notes}\n`);
  return ws;
}
function exitFor(rc, ws) {
  let RC = rc;
  if (!ws || ws.status === 'aborted') { if (RC === 0) RC = 3; }
  if (ws && ['no-csv', 'csv-store-mismatch'].includes(ws.status) && (RC === 0 || RC === 3)) RC = 5;
  if (ws && /turn\/time budget exhausted|RESIZE SCHEDULE/.test(String(ws.notes || '')) && RC === 0) RC = 6;
  return RC;
}

// ---- trade: one scheduled run
function runPlanner(planner, args) {
  const r = cp.spawnSync(process.execPath, [planner, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true, env: childEnv() });
  const lines = String(r.stdout || '').trim().split(/\r?\n/);
  let j = null; try { j = JSON.parse(lines[lines.length - 1]); } catch (e) { j = null; }
  return { exit: r.status, j: j || {}, stderr: String(r.stderr || '') };
}
function wake(planner, rid, c, push) {
  return new Promise((resolve) => {
    const out = fs.openSync(OUT, 'w'); const err = fs.openSync(LOG, 'a');
    const child = cp.spawn(process.execPath, [planner, 'wake', rid], { cwd: ROOT, stdio: ['ignore', out, err], windowsHide: true, env: childEnv() });
    const timer = push ? setInterval(() => { const r = pushRecords(c, `records: run ${rid} in progress`, undefined, { rebase: false }); if (r.error) log(`run ${rid}: checkpoint not pushed: ${r.error}`); }, 20000) : null;
    child.on('exit', (code, signal) => { if (timer) clearInterval(timer); fs.closeSync(out); fs.closeSync(err); resolve(code === null ? (signal ? 3 : 1) : code); });
    child.on('error', (e) => { if (timer) clearInterval(timer); log(`run ${rid}: the planner did not start: ${e.message}`); resolve(4); });
  });
}
async function trade(c, opts) {
  const setup = readSetup();
  if (!setup) throw new Exit(2, 'no run/setup.deep-r3-trade.json: set the bot up first (steps/I-setup.md)');
  const limitH = Number((setup.schedule || {}).time_limit_hours) || 6;
  fs.mkdirSync(RUN, { recursive: true });
  clearStaleLock(limitH);
  const rid = newRunId(''); // before the lock, so a taken run-id leaves no lock behind
  try { fs.mkdirSync(LOCK); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    log('lock held, skipping');
    return { exit: 2, out: { ok: false, subcommand: 'trade', exit: 2, status: 'lock-held', notes: 'another run holds run/.lock.deep-r3-trade' } };
  }
  try { return await tradeLocked(c, opts, setup, rid); } catch (e) {
    // anything that throws once the lock is taken releases it: ours, or one whose owner file was never written
    let o = null; try { o = readJson(path.join(LOCK, 'owner.txt')); } catch (e2) { o = null; }
    if (!o || o.pid === process.pid) fs.rmSync(LOCK, { recursive: true, force: true });
    throw e;
  }
}
async function tradeLocked(c, opts, setup, rid) {
  const owner = { pid: process.pid, process_start_time: new Date(Date.now() - process.uptime() * 1000).toISOString(), host: os.hostname(), started_at: iso(), stage: 'claude-p', run_id: rid };
  const ownerText = JSON.stringify(owner);
  fs.writeFileSync(path.join(LOCK, 'owner.txt'), ownerText, { flag: 'wx' });
  const P = paths(c);
  log(`run ${rid}: lock taken by routine.cjs (pid ${process.pid} on ${os.hostname()})`);
  if (fs.existsSync(P.sendLock)) log(`leftover signer send-lock ${P.sendLock}, not deleted`);
  log(`signer log "${P.signerLog}"`);

  // the gates: the signer and the planner the setup record pins, by path and sha256. The pinned paths must be the
  // ones install lays down (outside the project, from this commit): the setup record is a run/ record, so it may only
  // confirm those files, never name others; and the planner config must start exactly that helper and signer
  const a = setup.autonomy || {};
  let pcfg = null; try { pcfg = readJson(path.join(P.plannerDir, 'planner.config.json')); } catch (e) { pcfg = null; }
  for (const [what, p, h, installed] of [['signer', a.signer_path, a.signer_sha256, P.signer], ['planner', a.planner_path, a.planner_sha256, P.planner]]) {
    let why = '';
    if (!p || norm(p) !== norm(installed)) why = `${what} path: the setup record pins ${p}, but this install's ${what} is ${installed}`;
    else if (isInside(ROOT, p)) why = `${what} path ${p} is inside the project`;
    else if (!fs.existsSync(p)) why = `${what} file missing: ${p}`;
    else if (sha256File(p) !== String(h || '').toLowerCase()) why = `${what} hash mismatch: ${p} hashes ${sha256File(p)}, the setup record pins ${h}`;
    else if (what === 'planner' && (!pcfg || norm(pcfg.signerPath || '') !== norm(P.signer) || norm(pcfg.helperPath || '') !== norm(P.helper))) why = `the planner config ${path.join(P.plannerDir, 'planner.config.json')} does not name this install's signer and helper`;
    if (!why) continue;
    const ws = finalize(rid, 4, `refused at the gates: ${why}`);
    release(ownerText); log(`run ${rid}: refused at the gates: ${why}`);
    const pushed = opts.push ? pushRecords(c, `records: run ${rid} refused at the gates`) : null;
    return { exit: 4, out: { ok: false, subcommand: 'trade', run_id: rid, exit: 4, status: ws.status, notes: why, pushed } };
  }
  const live = liveSessions();
  fs.writeFileSync(path.join(LOCK, 'live-runs.txt'), live.join('\n'));

  log(`run ${rid}: planner wake started`);
  const rc = await wake(P.planner, rid, c, opts.push);
  log(`run ${rid}: planner wake exited ${rc}`);
  const ws = finalize(rid, rc);
  const RC = exitFor(rc, ws);
  release(ownerText);
  log(`run ${rid} finished, exit ${RC}`);
  const pushed = opts.push ? pushRecords(c, `records: run ${rid} finished (${ws.status}), exit ${RC}`) : null;
  return { exit: RC, out: { ok: RC === 0, subcommand: 'trade', run_id: rid, exit: RC, planner_exit: rc, status: ws.status, stopped_at_step: ws.stopped_at_step || null, report: `run/${rid}/report.md`, live_supervised_runs: live, pushed } };
}

// ---- clearance: the no-send check of an install (I-setup.md I.2 section 7, The planner)
function clearance(c, opts) {
  const P = paths(c);
  if (!fs.existsSync(P.planner)) throw new Exit(4, 'the planner is not installed: run routine.cjs install first');
  const rid = newRunId('-clearance');
  const steps = [];
  for (const args of [['c'], ['d'], ['e'], ['f'], ['g', '--indep'], ['exec', '--check']]) {
    const t0 = Date.now(); const r = runPlanner(P.planner, [args[0], rid, ...args.slice(1)]);
    steps.push({ step: args.join(' '), exit: r.exit, seconds: Math.round((Date.now() - t0) / 1000), stop: r.j.stop || null, outcome: r.j.outcome || r.j.source || null });
    if (r.exit !== 0) break;
  }
  // an empty plan checks nothing and does not clear (I-setup.md I.2 section 7, The clearance)
  const checked = steps.length === 6 && steps[5].outcome === 'check-passed';
  const empty = steps.length === 6 && steps[5].exit === 0 && steps[5].outcome === 'nothing-to-send';
  const passed = steps.length === 6 && steps.every((s) => s.exit === 0) && checked;
  const modules = {};
  for (const f of fs.readdirSync(path.join(P.plannerDir, 'planner')).filter((n) => n.endsWith('.cjs')).sort()) modules[`planner/${f}`] = sha256File(path.join(P.plannerDir, 'planner', f));
  const head = String(git(['rev-parse', 'HEAD']).stdout || '').trim() || null;
  const record = { run_id: rid, at: iso(), passed, empty_plan: empty, steps, git_head: head,
    installed: { planner: P.planner, planner_sha256: sha256File(P.planner), modules_sha256: modules, helper_sha256: sha256File(P.helper), signer: P.signer, signer_sha256: sha256File(P.signer), allowlist_sha256: sha256File(P.allowlist) } };
  fs.mkdirSync(path.join(RUN, rid), { recursive: true }); fs.writeFileSync(path.join(RUN, rid, 'clearance.json'), JSON.stringify(record, null, 1) + '\n');
  const pushed = opts.push ? pushRecords(c, `records: clearance ${rid} ${passed ? 'passed' : 'failed'}`, rid) : null;
  return { exit: passed ? 0 : 3, out: { ok: passed, subcommand: 'clearance', run_id: rid, passed, empty_plan: record.empty_plan, steps, record: `run/${rid}/clearance.json`, pushed } };
}

// ---- selftest: the supervised self-test's `check` cases again, on this install's signer (I-setup.md I.1 section 7).
// A new signer path needs the self-test again; `check` applies the same allowlist as `send` and returns before signing.
// Each case's expected answer is the saved results.json's, in file order: a rule name, `<rule>@<index>`, or `allowed`.
function selftest(c, opts) {
  const P = paths(c);
  if (!fs.existsSync(P.signer)) throw new Exit(4, 'the signer is not installed: run routine.cjs install first');
  if (!opts.cases) throw new Exit(2, 'selftest needs --cases run/<setup run-id>/selftest: the supervised self-test\'s case-*.json and results.json');
  const src = path.resolve(ROOT, opts.cases);
  if (!isInside(RUN, src) || !fs.existsSync(src)) throw new Exit(2, '--cases must be an existing folder under run/');
  let saved; try { saved = readJson(path.join(src, 'results.json')); } catch (e) { throw new Exit(2, `${opts.cases}: results.json is missing or not JSON`); }
  const files = fs.readdirSync(src).filter((f) => /^case-[A-Za-z0-9_-]+\.json$/.test(f)).sort();
  const want = Array.isArray(saved.cases) ? saved.cases.map((x) => ({ case: String(x.case || ''), expected: String(x.expected || '') })) : [];
  if (!files.length || files.length !== want.length || want.some((w) => !/^(allowed|[a-z0-9-]+(@\d+)?)$/.test(w.expected))) {
    throw new Exit(2, `${opts.cases}: ${files.length} case files against ${want.length} saved cases, each needing an expected rule`);
  }
  const rid = newRunId('', 'setup-');
  const dir = path.join(RUN, rid, 'selftest'); fs.mkdirSync(dir, { recursive: true });
  let env = childEnv(); const dropped = [];
  const cases = files.map((f, i) => {
    fs.copyFileSync(path.join(src, f), path.join(dir, f));
    let r; let got = null;
    for (let a = 0; a < 4; a++) { // the planner's rule for the signer's environment tripwire (exec-core.cjs signerRun)
      r = cp.spawnSync(process.execPath, [P.signer, 'check', path.join('run', rid, 'selftest', f)], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000, env });
      const lines = String(r.stdout || '').trim().split(/\r?\n/);
      try { got = JSON.parse(lines[lines.length - 1]); } catch (e) { got = { unparsed: clip(r.stdout, 200), stderr: clip(r.stderr, 200) }; }
      const m = got.rule === 'mode-switch' && /environment variable (\S+) looks like/.exec(got.detail || '');
      if (!m || dropped.includes(m[1])) break;
      dropped.push(m[1]); env = { ...env }; delete env[m[1]];
    }
    const [rule, at] = want[i].expected.split('@');
    const pass = want[i].expected === 'allowed' ? r.status === 0 && got.allowed === true
      : r.status === 3 && got.refused === 'allowlist' && got.rule === rule && (at === undefined || got.index === Number(at));
    return { case: want[i].case, file: f, expected: want[i].expected, exit: r.status, got, pass };
  });
  const fails = cases.filter((x) => !x.pass).map((x) => x.case);
  const signerSha = sha256File(P.signer);
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ at: iso(), signer: P.signer, signer_sha256: signerSha, allowlist_sha256: c.allowlistSha256,
    replayed_from: path.relative(ROOT, src).split(path.sep).join('/'), env_dropped: dropped, cases, fails }, null, 1) + '\n');
  const pushed = opts.push ? pushRecords(c, `records: signer self-test ${rid} ${fails.length ? 'failed' : 'passed'}`, rid) : null;
  return { exit: fails.length ? 3 : 0, out: { ok: !fails.length, subcommand: 'selftest', run_id: rid, signer: P.signer, signer_sha256: signerSha,
    passed: cases.length - fails.length, failed: fails, results: `run/${rid}/selftest/results.json`, pushed } };
}

function status() {
  const ids = fs.existsSync(RUN) ? fs.readdirSync(RUN).filter((d) => /^\d{4}-\d\d-\d\dT\d{4}Z(-w2)?$/.test(d)).sort() : [];
  for (const rid of ids.reverse()) { const w = wakeStatus(rid); if (w) return { exit: 0, out: { ok: true, subcommand: 'status', run_id: rid, status: w.status, stopped_at_step: w.stopped_at_step || null, finished_at: w.finished_at || null, report: `run/${rid}/report.md` } }; }
  return { exit: 0, out: { ok: true, subcommand: 'status', run_id: null, status: null } };
}

// ---- the command line
function parse(argv) {
  const [sub, ...rest] = argv; const opts = {}; const pos = [];
  const VALUE = { '--ethers-from': 'ethersFrom', '--cases': 'cases' };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--push') opts.push = true;
    else if (VALUE[t]) { if (i + 1 >= rest.length) throw new Exit(2, `${t} needs a value`); opts[VALUE[t]] = rest[++i]; }
    else if (/^--/.test(t)) throw new Exit(2, `unknown flag ${clip(t, 40)}`);
    else pos.push(t);
  }
  return { sub, opts, pos };
}
// the installed planner, its own output and exit code passed straight through (it prints its own JSON line)
function plannerPassthrough(args) {
  const [sub, ...rest] = args;
  const sends = (sub === 'exec' && !rest.includes('--check')) || (sub === 'halfb' && rest.includes('--send')) || sub === 'wake';
  if (sends && (process.env.R3_KEYSTORE_JSON || process.env.R3_KEYSTORE_PASSWORD)) {
    throw new Exit(4, `planner ${sub} sends, and here the routine key lives and no human answers: only \`r3.cjs trade\` sends from this environment, under the setup record's gates; refused, nothing sent`);
  }
  // where the routine key lives, only this install's planner; elsewhere the setup record's, which must be outside the
  // project (a run/ record never names code to run from inside it)
  const a = (readSetup() || {}).autonomy || {};
  const keyed = !!(process.env.R3_KEYSTORE_JSON || process.env.R3_KEYSTORE_PASSWORD);
  const p = !keyed && a.planner_path && fs.existsSync(a.planner_path) ? a.planner_path : paths(loadConfig()).planner;
  if (isInside(ROOT, p)) throw new Exit(4, `the planner path ${p} is inside the project: refused`);
  if (!fs.existsSync(p)) throw new Exit(4, 'the planner is not installed: run `node r3.cjs install` first');
  const r = cp.spawnSync(process.execPath, [p, ...args], { cwd: ROOT, stdio: 'inherit', windowsHide: true, env: childEnv() });
  return r.status === null ? 1 : r.status;
}
async function main() {
  if (!fs.existsSync(path.join(ROOT, '.claude', 'skills', 'deep-r3-trade'))) throw new Exit(2, 'run routine.cjs from the project root (the folder holding .claude/skills/deep-r3-trade)');
  if (process.argv[2] === 'planner') return { exit: plannerPassthrough(process.argv.slice(3)), out: null };
  const { sub, opts } = parse(process.argv.slice(2));
  if (sub === 'status') return status();
  const c = loadConfig();
  if (sub === 'install') return { exit: 0, out: install(c, opts) };
  if (sub === 'trade') return trade(c, opts);
  if (sub === 'clearance') return clearance(c, opts);
  if (sub === 'selftest') return selftest(c, opts);
  throw new Exit(2, 'usage: node routine.cjs <install|trade|clearance|selftest|status|planner> [flags] (see the header)');
}
main().then(({ exit, out }) => { if (out) process.stdout.write(JSON.stringify(out) + '\n'); process.exitCode = exit; }, (e) => {
  const code = e instanceof Exit ? e.code : 1;
  process.stdout.write(JSON.stringify({ ok: false, exit: code, error: clip(e && e.message, 800), ...(e && e.extra) }) + '\n');
  process.exitCode = code;
});
