#!/usr/bin/env node
'use strict';
/*
 * routine.test.cjs - tests for routine.cjs, the scheduled run's runner (`node r3.cjs ...` at the project root is its
 * short form). Run it from the skill's scripts/ folder:
 *
 *   node routine.test.cjs [--dir <work dir>] [--ethers-from <node_modules dir>] [--only <section,...>]
 *
 * Prints PASS / FAIL / SKIP per case and exits non-zero on any FAIL.
 *
 * Every case runs routine.cjs as a child process (`node r3.cjs <subcommand>`) inside a THROWAWAY project built under
 * the work folder (default: a fresh folder under the OS temp folder; --dir chooses where): a copy of r3.cjs and of this
 * scripts/ folder (routine.cjs reads its siblings by __dirname; the untracked research/ folder is left out), a
 * routine.config.json whose toolsDir, signerDir, keysDir and stateDir are folders under the work folder, and a
 * setup/r3-allowlist.json with its sha256. Nothing runs from the repository itself and nothing touches the real tools,
 * keys or signer state: the children get a minimal environment with HOME and USERPROFILE inside the work folder, an
 * isolated git config (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM) and GIT_CEILING_DIRECTORIES at the work folder, so git
 * never finds the repository the work folder may sit in (checked before any case runs).
 *
 * After `install`, trade, clearance and the planner passthrough run a STUB in place of the installed planner.cjs
 * (stubPlanner below, written over the installed copy and pinned in the throwaway setup record). It prints one JSON line
 * per subcommand as its plan.json says (outside the project, in ext/stub), records each call's argv and environment
 * variable names, and for `wake` writes files under run/<run-id>/ over a few seconds, wake-status.json last,
 * re-reading its own files before every write and recording any that moved or vanished under it. selftest replays its
 * cases through the REAL installed signer's `check` (policy only: no key, no RPC, nothing signed), with a synthetic
 * allowlist built from planner/table.cjs, made-up outcome tokens and a made-up holder. The git cases use a bare
 * repository under the work folder as origin and a second clone that pushes while a run lasts. No network, no key,
 * nothing signed or sent.
 *
 * Sections (--only takes any of them): install, passthrough, clearance, gates, selftest, git.
 * The git section waits for one 20-second checkpoint (its four runs go in parallel), so it takes about half a minute.
 * Three cases guard bugs these tests found in routine.cjs on 2026-10-23 (their comments say what went wrong): a key
 * variable spelled in another case on Windows, a lock left behind when the run-id was taken, and a final rebase on a
 * machine with no git identity.
 *
 * Needs Node 22, git, and ethers 6.17.0: --ethers-from <node_modules folder holding it>, else resolvable from this
 * folder (NODE_PATH). It is copied once into the work folder and linked into each install.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const SCRIPTS = __dirname;
const REPO = path.resolve(SCRIPTS, '..', '..', '..', '..');
const R3_SRC = path.join(REPO, 'r3.cjs');
const isWin = process.platform === 'win32';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const shaFile = (p) => sha(fs.readFileSync(p));
const fakeAddr = (tag) => '0x' + sha('routine-test:' + tag).slice(0, 40);
const HOLDER = fakeAddr('holder'); // a made-up bot wallet: no key exists for it anywhere
const OWNER = fakeAddr('owner');
const BURN = '0x000000000000000000000000000000000000dEaD';
const KEY_PASSWORD = 'routine-test-password-' + crypto.randomBytes(6).toString('hex'); // a test value, never a real one
const KEYS_ENV = {
  R3_KEYSTORE_JSON: JSON.stringify({ address: HOLDER.slice(2), version: 3, crypto: { note: 'routine.test.cjs: a made-up keystore; no key exists for this address' } }),
  R3_KEYSTORE_PASSWORD: KEY_PASSWORD,
};
const RID_RE = /^\d{4}-\d\d-\d\dT\d{4}Z(-w2)?$/;

// =================================================================================================================
// THE STUB PLANNER (runs as toolsDir/planner/planner.cjs in the throwaway installs; self-contained: no require of
// this file, so its sha256 is its own)
// =================================================================================================================
function stubPlanner(STUB) {
  const fs = require('fs'); const path = require('path'); const cp = require('child_process');
  let plan = {}; try { plan = JSON.parse(fs.readFileSync(path.join(STUB, 'plan.json'), 'utf8')); } catch (e) { plan = {}; }
  const argv = process.argv.slice(2); const sub = argv[0]; const rid = argv[1]; const rest = argv.slice(2);
  const root = process.cwd();
  const rec = (o) => fs.appendFileSync(path.join(STUB, 'calls.jsonl'), JSON.stringify(o) + '\n');
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const exitOf = (k) => (plan.exit && Number.isInteger(plan.exit[k]) ? plan.exit[k] : 0);
  const say = (o, code) => { process.stdout.write(JSON.stringify({ ok: code === 0, subcommand: sub, run_id: rid, exit: code, stub: true, ...o }) + '\n'); process.exitCode = code; };
  let lock = null; try { lock = JSON.parse(fs.readFileSync(path.join(root, 'run', '.lock.deep-r3-trade', 'owner.txt'), 'utf8')); } catch (e) { lock = null; }
  rec({ kind: 'call', at: new Date().toISOString(), self: __filename, argv, cwd: root, env_keys: Object.keys(process.env).sort(), lock_run_id: lock ? lock.run_id : null });
  if (sub === 'wake') return wake();
  if (sub === 'exec' && rest.includes('--check')) {
    const code = exitOf('exec-check');
    return say(code === 0 ? { outcome: plan.execOutcome || 'check-passed' } : { stop: { cause: 'stub-stop' } }, code);
  }
  const code = exitOf(sub);
  return say(code === 0 ? { outcome: 'stub-' + sub } : { stop: { cause: 'stub-stop' } }, code);

  // the scheduled run: files under run/<run-id>/ over plan.wakeSeconds, each re-read before every write
  function wake() {
    const dir = path.join(root, 'run', rid);
    const mine = new Map(); const violations = []; const notes = [];
    const verify = (when) => {
      for (const [rel, text] of mine) {
        let got = null; try { got = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch (e) { got = null; }
        if (got !== text) violations.push(`${when}: run/${rid}/${rel} ${got === null ? 'is gone' : 'changed under the planner'}`);
      }
      if (plan.foreignFile && fs.existsSync(path.join(root, plan.foreignFile))) violations.push(`${when}: ${plan.foreignFile} appeared in the working tree (a pull or checkout ran mid-run)`);
    };
    const put = (rel, text) => {
      verify('before writing ' + rel);
      const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true });
      for (let a = 0; ; a++) {
        try { fs.writeFileSync(p, text); mine.set(rel, text); return; } catch (e) { if (a >= 20) { notes.push(`write ${rel}: ${e.code}`); return; } sleep(50); }
      }
    };
    const started = new Date().toISOString();
    put('planner/c.json', JSON.stringify({ step: 'c', at: started }) + '\n');
    put('candidates.json', JSON.stringify({ stub: true, rows: 98 }) + '\n');
    for (const t of ['exec-tmp', 'f-tmp', 'g-tmp', 'halfb-tmp', 'recovery-tmp']) put(`${t}/scratch.json`, JSON.stringify({ scratch: t }) + '\n');
    const t0 = Date.now(); let n = 0;
    while (Date.now() - t0 < Number(plan.wakeSeconds || 0) * 1000) {
      sleep(Number(plan.tickMs || 500)); n++;
      put('progress.txt', `tick ${n} at ${new Date().toISOString()}\n`);
      if (n % 4 === 0) put(`ticks/tick-${String(n).padStart(3, '0')}.json`, JSON.stringify({ n }) + '\n');
    }
    verify('at the end');
    const g = (args) => { const r = cp.spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }); return r.status === 0 ? String(r.stdout).trim().split(/\r?\n/).filter(Boolean) : null; };
    rec({ kind: 'wake-end', at: new Date().toISOString(), rid, ticks: n, violations, notes, files: [...mine.keys()].sort(),
      fetch_head: fs.existsSync(path.join(root, '.git', 'FETCH_HEAD')),
      local_log: plan.gitLogs ? g(['log', '--format=%s']) : null,
      origin_log: plan.gitLogs && plan.originDir ? g(['--git-dir', plan.originDir, 'log', '--format=%s', 'main']) : null });
    if (!plan.noFinalStatus) {
      put('report.md', `# stub report ${rid}\n`);
      fs.writeFileSync(path.join(dir, 'wake-status.json'), JSON.stringify({ run_id: rid, started_at: started, finished_at: new Date().toISOString(), status: plan.wakeStatus || 'completed', stopped_at_step: null, notes: 'stub wake' }, null, 2) + '\n');
    }
    return say({ outcome: plan.wakeStatus || 'completed' }, exitOf('wake'));
  }
}
const STUB_TEXT = `'use strict';\n// routine.test.cjs stub planner: stands in for the installed planner.cjs (routine.test.cjs, stubPlanner). No network,\n// no key, no signer; its plan and its records are in ../../stub, outside the project.\n(${stubPlanner.toString()})(require('path').join(__dirname, '..', '..', 'stub'));\n`;

// =================================================================================================================
// THE TEST HARNESS
// =================================================================================================================
function argOf(name) { const i = process.argv.indexOf(name); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null; }
const ARGS = { dir: argOf('--dir'), only: argOf('--only'), ethersFrom: argOf('--ethers-from') };
const SECTIONS = ['install', 'passthrough', 'clearance', 'gates', 'selftest', 'git'];
const ONLY = ARGS.only ? new Set(ARGS.only.split(',').map((s) => s.trim())) : null;
if (ONLY) for (const s of ONLY) if (!SECTIONS.includes(s)) { console.log(`unknown section ${s}; sections: ${SECTIONS.join(', ')}`); process.exit(2); }
const want = (s) => !ONLY || ONLY.has(s);

class Skip extends Error {}
const skip = (why) => { throw new Skip(why); };
const results = { PASS: 0, FAIL: 0, SKIP: 0 }; const failed = [];
async function test(name, fn) {
  try { await fn(); results.PASS++; console.log(`PASS  ${name}`); } catch (e) {
    if (e instanceof Skip) { results.SKIP++; console.log(`SKIP  ${name} -- ${e.message}`); return; }
    results.FAIL++; failed.push(name); console.log(`FAIL  ${name} -- ${String(e && e.message ? e.message : e).slice(0, 1500)}`);
  }
}
function ok(cond, what) { if (!cond) throw new Error(what || 'assertion failed'); }
const clip = (s, n = 600) => { const t = typeof s === 'string' ? s : JSON.stringify(s); return t && t.length > n ? t.slice(0, n) + '...' : t; };
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1) + '\n'); };
const exists = (p) => fs.existsSync(p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => { const r = path.resolve(p); return isWin ? r.toLowerCase() : r; };
const isInside = (base, target) => { const b = norm(base); const t = norm(target); return t === b || t.startsWith(b + path.sep); };
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function listTree(dir, base = dir) {
  const out = []; if (!exists(dir)) return out;
  (function walk(p) { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) { out.push(path.relative(base, q).replace(/\\/g, '/') + '/'); walk(q); } else out.push(path.relative(base, q).replace(/\\/g, '/')); } })(dir);
  return out.sort();
}
function ethersNodeModules() {
  let d = path.dirname(require.resolve('ethers'));
  while (d !== path.dirname(d)) { if (path.basename(d) === 'ethers' && path.basename(path.dirname(d)) === 'node_modules') return path.dirname(d); d = path.dirname(d); }
  throw new Error('cannot locate the node_modules folder holding ethers');
}
const link = (target, at) => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, isWin ? 'junction' : 'dir'); };

// ---- the children's environment: a minimal copy of this one, HOME in the work folder, an isolated git ----
const KEEP = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'USERNAME', 'USER', 'LOGNAME', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'SYSTEMDRIVE']);
function baseEnv(W, gitGlobal) {
  const e = {};
  for (const k of Object.keys(process.env)) if (KEEP.has(k.toUpperCase())) e[k] = process.env[k];
  return { ...e, HOME: W.home, USERPROFILE: W.home, GIT_CONFIG_GLOBAL: gitGlobal || W.gitGlobal, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: W.ceiling, GIT_TERMINAL_PROMPT: '0', R3TEST_MARKER: 'routine-test' };
}

// ---- one `node r3.cjs ...` in a throwaway project; every non-passthrough answer is one JSON line ----
const contract = [];
function r3(W, P, args, { env = {}, timeoutMs = 120000, passthrough = false } = {}) {
  // the hard rules: only a throwaway project strictly inside the work folder, never the repository; --push only to a
  // throwaway git project with its own .git (and git cannot see past the work folder anyway)
  if (!isInside(W.root, P.proj) || norm(P.proj) === norm(W.root) || isInside(P.proj, REPO)) throw new Error(`refusing to run r3.cjs in ${P.proj}`);
  if (args.includes('--push') && !exists(path.join(P.proj, '.git'))) throw new Error('refusing --push outside a throwaway git project');
  const e = { ...baseEnv(W, env.GIT_CONFIG_GLOBAL), ...env };
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = cp.spawn(process.execPath, [path.join(P.proj, 'r3.cjs'), ...args], { cwd: P.proj, env: e, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
      let j = null; try { j = JSON.parse(lines[lines.length - 1]); } catch (err) { j = null; }
      if (!passthrough || code === 4) {
        if (lines.length !== 1 || !j) contract.push(`${args.join(' ')} -> ${lines.length} line(s)${j ? '' : ', not JSON'}`);
        else if (j.exit !== undefined && j.exit !== code) contract.push(`${args.join(' ')} -> summary exit ${j.exit}, process exit ${code}`);
      }
      resolve({ code, j: j || {}, lines, stdout, stderr, ms: Date.now() - t0 });
    });
  });
}
const say = (r) => clip(`exit ${r.code}: ${r.stdout.slice(0, 900)} ${r.stderr ? 'stderr: ' + r.stderr.slice(-400) : ''}`, 1500);

function git(W, cwd, args, { allowFail = false, env } = {}) {
  if (!isInside(W.root, cwd)) throw new Error(`refusing git outside the work folder: ${cwd}`);
  const r = cp.spawnSync('git', args, { cwd, env: env || baseEnv(W), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} in ${cwd} failed (${r.status}): ${clip(String(r.stderr || r.stdout), 400)}`);
  return r;
}
const gitLines = (W, cwd, args) => String(git(W, cwd, args).stdout).trim().split(/\r?\n/).filter(Boolean);

// =================================================================================================================
// THROWAWAY PROJECTS
// =================================================================================================================
function makeProject(W, name, o = {}) {
  const base = path.join(W.root, name);
  const P = { name, base, proj: path.join(base, 'proj'), ext: path.join(base, 'ext') };
  P.tools = path.join(P.ext, 'tools'); P.signerDir = path.join(P.ext, 'signer-bin'); P.keys = path.join(P.ext, 'keys'); P.state = path.join(P.ext, 'state'); P.stub = path.join(P.ext, 'stub');
  P.plannerBin = path.join(P.tools, 'planner', 'planner.cjs'); P.signerBin = path.join(P.signerDir, 'signer.cjs');
  P.run = path.join(P.proj, 'run'); P.setupFile = path.join(P.run, 'setup.deep-r3-trade.json'); P.lock = path.join(P.run, '.lock.deep-r3-trade'); P.log = path.join(P.run, 'wake-deep-r3.log');
  fs.mkdirSync(P.proj, { recursive: true }); fs.mkdirSync(P.stub, { recursive: true });
  if (exists(R3_SRC)) fs.copyFileSync(R3_SRC, path.join(P.proj, 'r3.cjs'));
  else fs.writeFileSync(path.join(P.proj, 'r3.cjs'), "'use strict';\nrequire('./.claude/skills/deep-r3-trade/scripts/routine.cjs');\n");
  const skip = [path.join(SCRIPTS, 'research'), path.join(SCRIPTS, 'node_modules')];
  fs.cpSync(SCRIPTS, path.join(P.proj, '.claude', 'skills', 'deep-r3-trade', 'scripts'), { recursive: true, filter: (src) => !skip.some((s) => isInside(s, src)) });
  P.allowText = o.allowlist || JSON.stringify({ format: 'routine-test-placeholder', note: 'the stub planner never runs the signer' }) + '\n';
  fs.mkdirSync(path.join(P.proj, 'setup'), { recursive: true }); fs.writeFileSync(path.join(P.proj, 'setup', 'r3-allowlist.json'), P.allowText);
  P.cfg = { toolsDir: P.tools, signerDir: P.signerDir, keysDir: P.keys, stateDir: P.state, rpcUrl: 'http://127.0.0.1:9', dataFunctionUrl: 'http://127.0.0.1:9/data',
    signerAddress: HOLDER, owner: OWNER, allowlistFile: 'setup/r3-allowlist.json', allowlistSha256: sha(P.allowText), planner: { rpcGapMs: 0, parallel: 1 } };
  for (const k of ['toolsDir', 'signerDir', 'keysDir', 'stateDir']) if (!isInside(W.root, P.cfg[k])) throw new Error(`${k} would leave the work folder`);
  wj(path.join(P.proj, 'routine.config.json'), P.cfg);
  // ethers next to each install, linked to the work folder's copy: install then finds it present and copies nothing
  if (o.links !== false) { link(W.nm, path.join(P.tools, 'node_modules')); link(W.nm, path.join(P.signerDir, 'node_modules')); }
  return P;
}
const setPlan = (P, plan) => wj(path.join(P.stub, 'plan.json'), plan);
const calls = (P) => { try { return fs.readFileSync(path.join(P.stub, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
const plannerCalls = (P) => calls(P).filter((c) => c.kind === 'call');
const wakeEnd = (P, rid) => calls(P).filter((c) => c.kind === 'wake-end' && c.rid === rid).pop();
function autonomyOf(P) { return { enabled: true, signer_path: P.signerBin, signer_sha256: shaFile(P.signerBin), planner_path: P.plannerBin, planner_sha256: shaFile(P.plannerBin) }; }
function setupRecord(P, over = {}) {
  const rec = { schedule: { time_limit_hours: 6 } };
  if (over !== null) { const a = { ...autonomyOf(P), ...over }; for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k]; rec.autonomy = a; }
  wj(P.setupFile, rec);
}
// a project ready for the stub: installed, the stub over the installed planner, a setup record pinning both
async function stubProject(W, name, o = {}) {
  const P = makeProject(W, name, o);
  const r = await r3(W, P, ['install']);
  if (r.code !== 0) throw new Error(`install in ${name} failed: ${say(r)}`);
  fs.writeFileSync(P.plannerBin, STUB_TEXT); setPlan(P, {});
  setupRecord(P);
  return P;
}
// run-ids are minute slugs (a third in the same minute is refused), so each case removes the ones it made
function clearRuns(P) { for (const d of exists(P.run) ? fs.readdirSync(P.run) : []) if (RID_RE.test(d) || /-clearance(-w2)?$/.test(d) || /^setup-/.test(d)) rmrf(path.join(P.run, d)); }
const slugAt = (ms) => { const t = new Date(ms).toISOString(); return `${t.slice(0, 10)}T${t.slice(11, 13)}${t.slice(14, 16)}Z`; };

// =================================================================================================================
// 3. install: a machine's own signer in signerDir is refused before anything is written
// =================================================================================================================
async function installSection(W) {
  const P = makeProject(W, 'install', { links: false });
  const cfgPath = path.join(P.signerDir, 'signer.config.json');
  const machine = { chainId: 10, rpcUrl: 'https://mainnet.optimism.io', signerAddress: HOLDER, owner: OWNER, projectRoot: path.join(W.root, 'elsewhere'),
    keystorePath: path.join(P.keys, 'keystore.json'), unlockPath: path.join(P.keys, 'password.dpapi'), allowlistPath: path.join(P.signerDir, 'r3-allowlist.json'),
    allowlistSha256: '0'.repeat(64), sendLockPath: path.join(P.state, 'send.lock'), logPath: path.join(P.state, 'signer.log.jsonl') };
  for (const mode of ['dpapi', 'keychain']) {
    await test(`install: signerDir holding a signer.config.json in ${mode} mode -> exit 4, nothing written (no planner, helper, signer, allowlist, ethers or key files), its config untouched`, async () => {
      fs.mkdirSync(P.signerDir, { recursive: true });
      const text = JSON.stringify({ ...machine, signerMode: mode }, null, 1) + '\n';
      fs.writeFileSync(cfgPath, text);
      const r = await r3(W, P, ['install', '--ethers-from', W.nm], { env: KEYS_ENV });
      ok(r.code === 4 && r.j.ok === false && r.j.exit === 4, say(r));
      ok(r.j.error.includes(`${mode} mode`) && /not a routine install/.test(r.j.error), say(r));
      ok(!exists(P.tools), `toolsDir was written: ${listTree(P.tools).join(', ')}`);
      ok(sameList(listTree(P.signerDir), ['signer.config.json']), `signerDir holds ${listTree(P.signerDir).join(', ')}`);
      ok(!exists(P.keys), `keysDir was written: ${listTree(P.keys).join(', ')}`);
      ok(!exists(P.state), 'stateDir was created');
      ok(fs.readFileSync(cfgPath, 'utf8') === text, 'the machine\'s own signer config was rewritten');
      ok(!(r.stdout + r.stderr).includes(KEY_PASSWORD), 'the password was printed');
    });
  }
  await test('install: a signer.config.json a routine install wrote (password-file mode) is installed over: tools byte for byte, configs, key files from the environment, never printed', async () => {
    fs.writeFileSync(cfgPath, JSON.stringify({ ...machine, signerMode: 'password-file' }, null, 1) + '\n');
    link(W.nm, path.join(P.tools, 'node_modules')); link(W.nm, path.join(P.signerDir, 'node_modules'));
    const r = await r3(W, P, ['install'], { env: KEYS_ENV });
    ok(r.code === 0 && r.j.ok === true && r.j.subcommand === 'install', say(r));
    ok(shaFile(P.plannerBin) === shaFile(path.join(SCRIPTS, 'planner.cjs')) && r.j.planner_sha256 === shaFile(P.plannerBin), 'planner.cjs differs from the repository\'s');
    for (const f of fs.readdirSync(path.join(SCRIPTS, 'planner')).filter((n) => n.endsWith('.cjs'))) ok(shaFile(path.join(P.tools, 'planner', 'planner', f)) === shaFile(path.join(SCRIPTS, 'planner', f)), `planner/${f} differs`);
    ok(shaFile(path.join(P.tools, 'chain-helper.cjs')) === shaFile(path.join(SCRIPTS, 'chain-helper.cjs')), 'chain-helper.cjs differs');
    ok(shaFile(P.signerBin) === shaFile(path.join(SCRIPTS, 'signer.cjs')) && r.j.signer_sha256 === shaFile(P.signerBin), 'signer.cjs differs');
    ok(shaFile(path.join(P.signerDir, 'r3-allowlist.json')) === P.cfg.allowlistSha256, 'the allowlist was not copied byte for byte');
    const sc = rj(cfgPath);
    ok(sc.signerMode === 'password-file' && norm(sc.projectRoot) === norm(P.proj) && sc.allowlistSha256 === P.cfg.allowlistSha256 && norm(sc.keystorePath) === norm(path.join(P.keys, 'keystore.json')), clip(sc));
    ok(r.j.keys === 'installed from the environment', clip(r.j.keys));
    ok(fs.readFileSync(path.join(P.keys, 'keystore.json'), 'utf8') === KEYS_ENV.R3_KEYSTORE_JSON && fs.readFileSync(path.join(P.keys, 'password'), 'utf8') === KEY_PASSWORD, 'the key files differ from the environment');
    ok(!(r.stdout + r.stderr).includes(KEY_PASSWORD), 'the password was printed');
    ok(r.j.ethers.tools === 'present' && r.j.ethers.signer === 'present', clip(r.j.ethers));
  });
}

// =================================================================================================================
// 2. the planner passthrough: its send entry points refused where the key's variables are set; never the key to a child
// =================================================================================================================
async function passthroughSection(W) {
  let P;
  await test('passthrough: setup (install, the stub over the installed planner, a setup record pinning it)', async () => { P = await stubProject(W, 'passthrough'); });
  if (!P) return;
  const RID = 'routine-test-pt';
  const SENDS = [['exec <run-id>', ['exec', RID]], ['exec <run-id> --max-groups 1', ['exec', RID, '--max-groups', '1']], ['halfb <run-id> --send', ['halfb', RID, '--send']], ['wake <run-id>', ['wake', RID]]];
  const ENVS = [['both key variables', KEYS_ENV], ['R3_KEYSTORE_JSON alone', { R3_KEYSTORE_JSON: KEYS_ENV.R3_KEYSTORE_JSON }], ['R3_KEYSTORE_PASSWORD alone', { R3_KEYSTORE_PASSWORD: KEY_PASSWORD }]];
  for (const [label, env] of ENVS) {
    await test(`passthrough: with ${label} set, exec (no --check), halfb --send and wake -> exit 4, one JSON line, the planner never started`, async () => {
      for (const [what, args] of SENDS) {
        const n0 = plannerCalls(P).length;
        const r = await r3(W, P, ['planner', ...args], { env, passthrough: true });
        ok(r.code === 4 && r.j.ok === false && r.j.exit === 4 && /refused, nothing sent/.test(r.j.error || '') && r.lines.length === 1, `${what}: ${say(r)}`);
        ok(plannerCalls(P).length === n0, `${what}: the planner was started`);
        ok(!(r.stdout + r.stderr).includes(KEY_PASSWORD), `${what}: the password was printed`);
      }
      ok(!exists(path.join(P.run, RID)), 'a run folder was written');
    });
  }
  await test('passthrough: with both key variables set, exec --check, halfb (no --send), c and d pass through with their argv; the planner gets neither key variable, the rest of the environment does reach it', async () => {
    for (const args of [['exec', RID, '--check'], ['halfb', RID], ['c', RID], ['d', RID, '--supply', 'inputs/x.csv', '--continue']]) {
      const r = await r3(W, P, ['planner', ...args], { env: KEYS_ENV, passthrough: true });
      ok(r.code === 0 && r.j.stub === true && r.j.subcommand === args[0] && r.lines.length === 1, `${args.join(' ')}: ${say(r)}`);
      const c = plannerCalls(P).pop();
      ok(sameList(c.argv, args), `${args.join(' ')}: the planner got ${clip(c.argv)}`);
      ok(!c.env_keys.some((k) => /^R3_KEYSTORE_/i.test(k)), `${args.join(' ')}: the planner got ${c.env_keys.filter((k) => /^R3_KEYSTORE_/i.test(k)).join(', ')}`);
      ok(c.env_keys.includes('R3TEST_MARKER'), `${args.join(' ')}: the rest of the environment did not reach the planner`);
      ok(norm(c.cwd) === norm(P.proj), `cwd ${c.cwd}`);
    }
  });
  await test('passthrough: without the key variables, exec, halfb --send and wake pass through with their argv, and the planner\'s exit code comes back unchanged', async () => {
    setPlan(P, { exit: { exec: 5, halfb: 3, wake: 0 }, wakeSeconds: 0 });
    try {
      for (const [args, code] of [[['exec', RID], 5], [['halfb', RID, '--send'], 3], [['wake', RID], 0]]) {
        const r = await r3(W, P, ['planner', ...args], { passthrough: true });
        ok(r.code === code && r.j.stub === true && r.j.exit === code, `${args.join(' ')}: ${say(r)}`);
        ok(sameList(plannerCalls(P).pop().argv, args), `${args.join(' ')}: wrong argv`);
      }
      ok(exists(path.join(P.run, RID, 'wake-status.json')), 'the wake did not run');
    } finally { setPlan(P, {}); rmrf(path.join(P.run, RID)); }
  });
  // which planner runs: the setup record's (outside the project) for a supervised session; only this install's where
  // a key variable is set; never one inside the project
  const alt = path.join(P.ext, 'alt', 'planner', 'planner.cjs'); // outside the project; its records land in the same ext/stub
  const inProj = path.join(P.proj, 'planner-copy', 'planner', 'planner.cjs');
  for (const f of [alt, inProj]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, STUB_TEXT); }
  await test('passthrough: the setup record\'s planner_path (outside the project) runs without the key variables; with one set, this install\'s planner runs instead', async () => {
    setupRecord(P, { planner_path: alt, planner_sha256: shaFile(alt) });
    try {
      const r1 = await r3(W, P, ['planner', 'c', RID], { passthrough: true });
      ok(r1.code === 0 && norm(plannerCalls(P).pop().self) === norm(alt), `without keys: ${say(r1)} ran ${plannerCalls(P).pop().self}`);
      const r2 = await r3(W, P, ['planner', 'c', RID], { env: { R3_KEYSTORE_PASSWORD: KEY_PASSWORD }, passthrough: true });
      ok(r2.code === 0 && norm(plannerCalls(P).pop().self) === norm(P.plannerBin), `with a key variable: ${say(r2)} ran ${plannerCalls(P).pop().self}`);
    } finally { setupRecord(P); }
  });
  await test('passthrough: a setup record naming a planner inside the project -> exit 4, that file never started', async () => {
    setupRecord(P, { planner_path: inProj, planner_sha256: shaFile(inProj) });
    const n0 = plannerCalls(P).length;
    try {
      const r = await r3(W, P, ['planner', 'c', RID], { passthrough: true });
      ok(r.code === 4 && r.j.exit === 4 && /inside the project/.test(r.j.error || '') && r.lines.length === 1, say(r));
      ok(plannerCalls(P).length === n0, 'a planner was started');
    } finally { setupRecord(P); }
  });
  // On Windows an environment variable name is case-insensitive: r3_keystore_password IS R3_KEYSTORE_PASSWORD to the
  // OS and to every child's process.env. childEnv() copies process.env into a plain object, so it must delete every key
  // whose upper-case form is a key variable, or the variable reaches the planner (and through it the signer).
  await test('passthrough (Windows): a key variable spelled in another case is refused like the upper-case one, and never reaches the planner', async () => {
    if (!isWin) skip('environment variable names are case-sensitive on this platform');
    const env = { r3_keystore_password: KEY_PASSWORD };
    const r1 = await r3(W, P, ['planner', 'wake', RID], { env, passthrough: true });
    ok(r1.code === 4, `the send entry point was not refused: ${say(r1)}`);
    const r2 = await r3(W, P, ['planner', 'c', RID], { env, passthrough: true });
    ok(r2.code === 0, say(r2));
    const leaked = plannerCalls(P).pop().env_keys.filter((k) => /^r3_keystore_/i.test(k));
    ok(!leaked.length, `routine.cjs bug: childEnv() deletes only the upper-case names, so ${leaked.join(', ')} reached the planner child (on Windows it is R3_KEYSTORE_PASSWORD)`);
  });
}

// =================================================================================================================
// 4. clearance: passes only on exec --check's check-passed; an empty plan does not clear; clearance.json
// =================================================================================================================
async function clearanceSection(W) {
  let P;
  await test('clearance: setup (install, the stub over the installed planner)', async () => { P = await stubProject(W, 'clearance'); });
  if (!P) return;
  const STEPS = ['c', 'd', 'e', 'f', 'g --indep', 'exec --check'];
  const argvOf = (rid) => [['c', rid], ['d', rid], ['e', rid], ['f', rid], ['g', rid, '--indep'], ['exec', rid, '--check']];
  const run = async (plan, env) => { setPlan(P, plan); const n0 = plannerCalls(P).length; const r = await r3(W, P, ['clearance'], { env }); return { r, made: plannerCalls(P).slice(n0) }; };
  await test('clearance: exec --check outcome check-passed -> exit 0, passed, steps c d e f "g --indep" "exec --check" in order; nothing else run; no key variable reaches the planner', async () => {
    const { r, made } = await run({}, KEYS_ENV);
    try {
      ok(r.code === 0 && r.j.ok === true && r.j.passed === true && r.j.empty_plan === false, say(r));
      ok(/^\d{4}-\d\d-\d\dT\d{4}Z-clearance(-w2)?$/.test(r.j.run_id), `run-id ${r.j.run_id}`);
      ok(sameList(r.j.steps.map((s) => s.step), STEPS) && r.j.steps.every((s) => s.exit === 0) && r.j.steps[5].outcome === 'check-passed', clip(r.j.steps));
      ok(sameList(made.map((c) => c.argv), argvOf(r.j.run_id)), `the planner ran ${clip(made.map((c) => c.argv.join(' ')))}`);
      ok(made.every((c) => !c.env_keys.some((k) => /^R3_KEYSTORE_/i.test(k))), 'a key variable reached the planner');
    } finally { clearRuns(P); }
  });
  await test('clearance: run/<run-id>/clearance.json holds the steps and the sha256 of the installed planner, every planner/*.cjs, the helper, the signer and the allowlist', async () => {
    const { r } = await run({});
    try {
      ok(r.code === 0, say(r));
      ok(r.j.record === `run/${r.j.run_id}/clearance.json`, r.j.record);
      const rec = rj(path.join(P.proj, r.j.record));
      ok(rec.run_id === r.j.run_id && rec.passed === true && rec.empty_plan === false && sameList(rec.steps, r.j.steps), clip(rec));
      const I = rec.installed;
      ok(norm(I.planner) === norm(P.plannerBin) && I.planner_sha256 === shaFile(P.plannerBin), `planner ${I.planner} ${I.planner_sha256}`);
      ok(I.planner_sha256 === sha(STUB_TEXT), 'the planner hash is not the stub\'s (the file that ran)');
      const mods = fs.readdirSync(path.join(P.tools, 'planner', 'planner')).filter((n) => n.endsWith('.cjs')).sort();
      ok(mods.length > 10 && sameList(Object.keys(I.modules_sha256), mods.map((m) => `planner/${m}`)), `modules ${clip(Object.keys(I.modules_sha256))}`);
      for (const m of mods) ok(I.modules_sha256[`planner/${m}`] === shaFile(path.join(P.tools, 'planner', 'planner', m)), `planner/${m} hash`);
      ok(I.helper_sha256 === shaFile(path.join(P.tools, 'chain-helper.cjs')), 'helper hash');
      ok(norm(I.signer) === norm(P.signerBin) && I.signer_sha256 === shaFile(P.signerBin), 'signer hash');
      ok(I.allowlist_sha256 === shaFile(path.join(P.signerDir, 'r3-allowlist.json')) && I.allowlist_sha256 === P.cfg.allowlistSha256, 'allowlist hash');
      ok(rec.git_head === null, `git_head ${rec.git_head} (this throwaway project has no git: git must not have found another repository)`);
    } finally { clearRuns(P); }
  });
  await test('clearance: an empty plan (exec --check outcome nothing-to-send, exit 0) -> exit 3, passed false, empty_plan true, in the output and in clearance.json', async () => {
    const { r } = await run({ execOutcome: 'nothing-to-send' });
    try {
      ok(r.code === 3 && r.j.ok === false && r.j.passed === false && r.j.empty_plan === true, say(r));
      ok(r.j.steps.length === 6 && r.j.steps.every((s) => s.exit === 0) && r.j.steps[5].outcome === 'nothing-to-send', clip(r.j.steps));
      const rec = rj(path.join(P.proj, r.j.record));
      ok(rec.passed === false && rec.empty_plan === true, clip(rec));
    } finally { clearRuns(P); }
  });
  await test('clearance: a step that fails (d exits 5) stops the clearance there: exit 3, not passed, not an empty plan, e f g exec never run', async () => {
    const { r, made } = await run({ exit: { d: 5 } });
    try {
      ok(r.code === 3 && r.j.passed === false && r.j.empty_plan === false, say(r));
      ok(sameList(r.j.steps.map((s) => s.step), ['c', 'd']) && r.j.steps[1].exit === 5 && r.j.steps[1].stop && r.j.steps[1].stop.cause === 'stub-stop', clip(r.j.steps));
      ok(sameList(made.map((c) => c.argv[0]), ['c', 'd']), `the planner ran ${made.map((c) => c.argv[0]).join(' ')}`);
      ok(rj(path.join(P.proj, r.j.record)).passed === false, 'clearance.json says passed');
    } finally { clearRuns(P); }
  });
  // an exec --check that failed (a hash mismatch, a refusal, a transport failure) is not an empty plan, whose advice is
  // "run again once the holder holds sUSDS" (an earlier routine.cjs reported it as one)
  await test('clearance: an exec --check that fails (exit 4, a stop) -> exit 3, not passed, and not reported as an empty plan', async () => {
    const { r } = await run({ exit: { 'exec-check': 4 } });
    try {
      ok(r.code === 3 && r.j.passed === false && r.j.steps.length === 6 && r.j.steps[5].exit === 4, say(r));
      ok(r.j.empty_plan === false, `empty_plan is ${r.j.empty_plan} for a failed exec --check (exit 4, stop ${clip(r.j.steps[5].stop)})`);
      ok(rj(path.join(P.proj, r.j.record)).empty_plan === false, 'clearance.json says empty_plan');
    } finally { clearRuns(P); setPlan(P, {}); }
  });
  // the forecast file from the research repository (forecastImport): the newest made within forecastMaxAgeHours is
  // copied byte for byte into run/<its run-id>/, nothing else crosses, and a different file already here is kept
  await test('clearance under forecast-file with forecastImport: the newest young research-forecast.json is copied byte for byte into run/<its run-id>/; stale, malformed, undated and non-ISO ones and folders that are not research run-ids are not; a different file already here is not overwritten; method csv imports nothing', async () => {
    const R = path.join(P.base, 'research-clone');
    const put = (rid, body) => { fs.mkdirSync(path.join(R, 'run', rid), { recursive: true }); fs.writeFileSync(path.join(R, 'run', rid, 'research-forecast.json'), typeof body === 'string' ? body : JSON.stringify(body)); };
    const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
    put('2026-01-01T0000Z-research', { generated_at: ago(13), forecasts: [], tag: 'stale' });
    put('2026-01-02T0000Z-research', { generated_at: ago(2), forecasts: [], tag: 'older' });
    put('2026-01-03T0000Z-research', { generated_at: ago(1), forecasts: [], tag: 'newest' });
    put('2026-01-04T0000Z-research', '{ not json');
    put('2026-01-05T0000Z-research', { generated_at: 'not a date', forecasts: [] });
    put('2026-01-06T0000Z-research', { generated_at: new Date(Date.now() - 60000).toUTCString(), forecasts: [], tag: 'not ISO' });
    put('csv', { generated_at: ago(0.1), forecasts: [], tag: 'not a research run-id' });
    put('2026-01-07T0000Z', { generated_at: ago(0.1), forecasts: [], tag: 'a trading run-id' });
    const cfg = { ...P.cfg, forecastImport: R, planner: { ...P.cfg.planner, forecastMethod: 'forecast-file', forecastMaxAgeHours: 12 } };
    const dest = path.join(P.run, '2026-01-03T0000Z-research', 'research-forecast.json');
    wj(path.join(P.proj, 'routine.config.json'), cfg);
    try {
      const { r } = await run({});
      ok(r.code === 0 && r.j.forecast_import && r.j.forecast_import.imported === 'run/2026-01-03T0000Z-research/research-forecast.json', say(r));
      ok(fs.readFileSync(dest).equals(fs.readFileSync(path.join(R, 'run', '2026-01-03T0000Z-research', 'research-forecast.json'))), 'not a byte-for-byte copy');
      for (const d of ['2026-01-01T0000Z-research', '2026-01-02T0000Z-research', '2026-01-04T0000Z-research', '2026-01-05T0000Z-research', '2026-01-06T0000Z-research', '2026-01-07T0000Z']) ok(!exists(path.join(P.run, d)), `${d} was copied too`);
      ok(!exists(path.join(P.run, 'csv', 'research-forecast.json')), 'a file from a folder that is not a research run-id was copied');
      ok(rj(path.join(P.proj, r.j.record)).forecast_import.imported === r.j.forecast_import.imported, 'clearance.json has no forecast_import');
      fs.writeFileSync(dest, '{"generated_at":"2026-01-01T00:00:00Z","mine":true}');
      clearRuns(P);
      const { r: again } = await run({});
      ok(again.j.forecast_import && again.j.forecast_import.imported === null && /not overwritten/.test(again.j.forecast_import.note || ''), say(again));
      ok(JSON.parse(fs.readFileSync(dest, 'utf8')).mine === true, 'a different file already here was overwritten');
      wj(path.join(P.proj, 'routine.config.json'), { ...cfg, planner: { ...cfg.planner, forecastMethod: 'csv' } });
      clearRuns(P);
      const { r: csv } = await run({});
      ok(csv.j.forecast_import === null, `method csv imported: ${say(csv)}`);
    } finally { wj(path.join(P.proj, 'routine.config.json'), P.cfg); rmrf(path.join(P.run, '2026-01-03T0000Z-research')); clearRuns(P); }
  });
  await test('config: a forecastImport inside the project -> exit 2, nothing run', async () => {
    wj(path.join(P.proj, 'routine.config.json'), { ...P.cfg, forecastImport: 'run', planner: { ...P.cfg.planner, forecastMethod: 'forecast-file' } });
    try {
      const { r, made } = await run({});
      ok(r.code === 2 && /forecastImport/.test(r.j.error || ''), say(r));
      ok(made.length === 0, 'the planner ran');
    } finally { wj(path.join(P.proj, 'routine.config.json'), P.cfg); clearRuns(P); }
  });
}

// =================================================================================================================
// 5. trade's gates: the setup record's signer and planner pins, by path and sha256
// =================================================================================================================
async function gatesSection(W) {
  let P;
  await test('trade: setup (install, the stub over the installed planner, a setup record pinning the signer and the stub)', async () => { P = await stubProject(W, 'gates'); });
  if (!P) return;
  const wakes = () => plannerCalls(P).filter((c) => c.argv[0] === 'wake').length;
  await test('trade: both pins match -> the planner\'s wake runs once with the lock held for its run-id, without either key variable; exit 0; the lock released', async () => {
    setPlan(P, { wakeSeconds: 1 });
    const n0 = wakes();
    const r = await r3(W, P, ['trade'], { env: KEYS_ENV });
    try {
      ok(r.code === 0 && r.j.ok === true && r.j.exit === 0 && r.j.planner_exit === 0 && r.j.status === 'completed' && RID_RE.test(r.j.run_id), say(r));
      ok(wakes() === n0 + 1, 'wake did not run exactly once');
      const c = plannerCalls(P).pop();
      ok(sameList(c.argv, ['wake', r.j.run_id]) && c.lock_run_id === r.j.run_id, `the wake ran as ${clip(c.argv)} with the lock naming ${c.lock_run_id}`);
      ok(norm(c.self) === norm(P.plannerBin), `the wake ran ${c.self}, not the installed planner`);
      ok(!c.env_keys.some((k) => /^R3_KEYSTORE_/i.test(k)) && c.env_keys.includes('R3TEST_MARKER'), 'the wake got a key variable (or not the rest of the environment)');
      ok(!exists(P.lock), 'the lock was not released');
      ok(rj(path.join(P.run, r.j.run_id, 'wake-status.json')).status === 'completed' && r.j.pushed === null, clip(r.j));
      ok(!(r.stdout + r.stderr).includes(KEY_PASSWORD), 'the password was printed');
    } finally { clearRuns(P); setPlan(P, {}); }
  });
  await test('trade: pins recorded in upper case still match (sha256 compared case-insensitively)', async () => {
    const a = autonomyOf(P); setupRecord(P, { signer_sha256: a.signer_sha256.toUpperCase(), planner_sha256: a.planner_sha256.toUpperCase() });
    const r = await r3(W, P, ['trade']);
    try { ok(r.code === 0 && r.j.status === 'completed', say(r)); } finally { clearRuns(P); setupRecord(P); }
  });
  const realPlanner = shaFile(path.join(SCRIPTS, 'planner.cjs'));
  const elsewhere = path.join(P.ext, 'elsewhere', 'signer.cjs'); fs.mkdirSync(path.dirname(elsewhere), { recursive: true }); fs.copyFileSync(P.signerBin, elsewhere);
  const inProj = path.join(P.proj, 'planner-copy', 'planner.cjs'); fs.mkdirSync(path.dirname(inProj), { recursive: true }); fs.writeFileSync(inProj, STUB_TEXT);
  const pcfgPath = path.join(P.tools, 'planner', 'planner.config.json');
  const signerPathRe = (pinned) => new RegExp(`^signer path: the setup record pins ${pinned}, but this install's signer is .*signer-bin.signer\\.cjs$`);
  const plannerPathRe = (pinned) => new RegExp(`^planner path: the setup record pins ${pinned}, but this install's planner is .*tools.planner.planner\\.cjs$`);
  const swap = (file, change) => { const keep = path.join(P.ext, 'kept-' + path.basename(file)); fs.renameSync(file, keep); try { if (change) change(); } catch (e) { fs.renameSync(keep, file); throw e; } return () => { rmrf(file); fs.renameSync(keep, file); }; };
  // [label, the autonomy block's changes (null: none), the reason, an optional change to the install and its undo]
  const GATES = [
    ['no autonomy block', null, signerPathRe('undefined')],
    ['autonomy.signer_path missing', { signer_path: undefined }, signerPathRe('undefined')],
    ['autonomy.signer_path names another copy of the signer (same bytes, outside the project)', { signer_path: elsewhere, signer_sha256: shaFile(elsewhere) }, /^signer path: the setup record pins .*elsewhere.signer\.cjs, but/],
    ['autonomy.signer_path names the signer\'s folder', { signer_path: P.signerDir }, /^signer path: the setup record pins .*signer-bin, but/],
    ['autonomy.signer_sha256 another file\'s', { signer_sha256: 'ab'.repeat(32) }, /^signer hash mismatch: .* the setup record pins abab/],
    ['autonomy.signer_sha256 missing', { signer_sha256: undefined }, /^signer hash mismatch: .* the setup record pins undefined$/],
    ['the installed signer file is gone (the pin names it)', {}, /^signer file missing: .*signer-bin.signer\.cjs$/, () => swap(P.signerBin)],
    ['autonomy.planner_path missing', { planner_path: undefined }, plannerPathRe('undefined')],
    ['autonomy.planner_path names a copy inside the project', { planner_path: inProj, planner_sha256: shaFile(inProj) }, /^planner path: the setup record pins .*planner-copy.planner\.cjs, but/],
    ['autonomy.planner_sha256 the repository planner\'s while another file is installed', { planner_sha256: realPlanner }, new RegExp(`^planner hash mismatch: .* the setup record pins ${realPlanner}$`)],
    ['autonomy.planner_sha256 missing', { planner_sha256: undefined }, /^planner hash mismatch: /],
    ['the installed planner file is gone (the pin names it)', {}, /^planner file missing: .*tools.planner.planner\.cjs$/, () => swap(P.plannerBin)],
    ['the planner config names another signer', {}, /^the planner config .*planner\.config\.json does not name this install's signer and helper$/,
      () => { const text = fs.readFileSync(pcfgPath, 'utf8'); const c = JSON.parse(text); c.signerPath = elsewhere; fs.writeFileSync(pcfgPath, JSON.stringify(c)); return () => fs.writeFileSync(pcfgPath, text); }],
    ['no planner config', {}, /^the planner config .* does not name this install's signer and helper$/, () => swap(pcfgPath)],
  ];
  for (const [label, over, re, alter] of GATES) {
    await test(`trade gate: ${label} -> exit 4, wake-status aborted naming the reason, report.md, the planner never started, the lock released`, async () => {
      setupRecord(P, over);
      const undo = alter ? alter() : null;
      const n0 = plannerCalls(P).length;
      const r = await r3(W, P, ['trade'], { env: KEYS_ENV }).finally(() => { if (undo) undo(); });
      try {
        ok(r.code === 4 && r.j.ok === false && r.j.exit === 4 && r.j.status === 'aborted' && re.test(r.j.notes || ''), say(r));
        const ws = rj(path.join(P.run, r.j.run_id, 'wake-status.json'));
        ok(ws.status === 'aborted' && ws.notes === `refused at the gates: ${r.j.notes}` && ws.finished_at, clip(ws));
        ok(exists(path.join(P.run, r.j.run_id, 'report.md')), 'no report.md');
        ok(plannerCalls(P).length === n0, 'the planner was started');
        ok(!exists(P.lock), 'the lock was not released');
        ok(r.j.pushed === null, clip(r.j.pushed));
        ok(fs.readFileSync(P.log, 'utf8').includes(`run ${r.j.run_id}: refused at the gates: ${r.j.notes}`), 'the log does not name the refusal');
      } finally { clearRuns(P); setupRecord(P); }
    });
  }
  await test('trade: no setup record -> exit 2, no lock left, the planner never started', async () => {
    const keep = fs.readFileSync(P.setupFile); fs.unlinkSync(P.setupFile);
    const n0 = plannerCalls(P).length;
    try {
      const r = await r3(W, P, ['trade']);
      ok(r.code === 2 && /no run\/setup\.deep-r3-trade\.json/.test(r.j.error || ''), say(r));
      ok(!exists(P.lock) && plannerCalls(P).length === n0, 'a lock was left or the planner ran');
    } finally { fs.writeFileSync(P.setupFile, keep); clearRuns(P); }
  });
  await test('trade: the lock held by a live run -> exit 2, status lock-held, the planner never started, the lock left as it was', async () => {
    fs.mkdirSync(P.lock, { recursive: true });
    const owner = JSON.stringify({ pid: 4242, process_start_time: new Date().toISOString(), host: os.hostname(), started_at: new Date().toISOString(), stage: 'claude-p', run_id: 'other' });
    fs.writeFileSync(path.join(P.lock, 'owner.txt'), owner);
    const n0 = plannerCalls(P).length;
    try {
      const r = await r3(W, P, ['trade']);
      ok(r.code === 2 && r.j.exit === 2 && r.j.status === 'lock-held', say(r));
      ok(plannerCalls(P).length === n0, 'the planner was started');
      ok(fs.readFileSync(path.join(P.lock, 'owner.txt'), 'utf8') === owner, 'the lock was changed');
    } finally { rmrf(P.lock); clearRuns(P); }
  });
  await test('trade: a wake that exits 0 without its final status is written aborted (report.md too) and exits 3', async () => {
    setPlan(P, { noFinalStatus: true, wakeSeconds: 0 });
    const r = await r3(W, P, ['trade']);
    try {
      ok(r.code === 3 && r.j.exit === 3 && r.j.planner_exit === 0 && r.j.status === 'aborted', say(r));
      ok(rj(path.join(P.run, r.j.run_id, 'wake-status.json')).status === 'aborted' && exists(path.join(P.run, r.j.run_id, 'report.md')), 'no aborted wake-status or report.md');
      ok(!exists(P.lock), 'the lock was not released');
    } finally { clearRuns(P); setPlan(P, {}); }
  });
  // trade() picks the run-id before it takes the lock (newRunId throws "run-id ... is taken" when run/<slug> and
  // run/<slug>-w2 both exist), and anything that throws once the lock is taken releases it: a lock left with no
  // owner.txt would make every run on that machine skip as "lock held" until it is older than the time limit + 1 h.
  await test('trade: when the run-id is taken (exit 2), the lock is not left behind', async () => {
    const made = [];
    for (const ms of [Date.now(), Date.now() + 60000]) for (const s of ['', '-w2']) { const d = path.join(P.run, slugAt(ms) + s); fs.mkdirSync(d, { recursive: true }); made.push(d); }
    const r = await r3(W, P, ['trade']);
    try {
      ok(r.code === 2 && /is taken/.test(r.j.error || ''), say(r));
      ok(!exists(P.lock), `routine.cjs bug: the lock is left held (${listTree(P.lock).join(', ') || 'no owner.txt'}) after the run-id was refused`);
    } finally { rmrf(P.lock); for (const d of made) rmrf(d); clearRuns(P); }
  });
}

// =================================================================================================================
// 6. selftest: the saved cases replayed through the installed signer's check
// =================================================================================================================
async function selftestSection(W) {
  // the signer module in-process (a copy linked to the work folder's ethers), for its pinned addresses and ABIs only
  let S;
  await test('selftest: setup (a synthetic allowlist for a made-up holder, the real signer installed, five saved cases)', async () => {
    const mod = path.join(W.shared, 'sigmod'); fs.mkdirSync(mod, { recursive: true });
    fs.copyFileSync(path.join(SCRIPTS, 'signer.cjs'), path.join(mod, 'signer.cjs')); if (!exists(path.join(mod, 'node_modules'))) link(W.nm, path.join(mod, 'node_modules'));
    S = require(path.join(mod, 'signer.cjs'));
  });
  if (!S) return;
  const TB = require(path.join(SCRIPTS, 'planner', 'table.cjs'));
  const T = S.PINNED_TREE;
  const allow = {
    format: S.FORMAT, chain_id: 10, generated_at: 'routine.test.cjs (synthetic)', holder: HOLDER, contracts: { ...S.PINNED }, psm3_selectors: ['swapExactIn'],
    parent: { market: T.parent, outcomes: [...T.bundles, T.parentInvalid] },
    middles: T.middles.map((m, i) => ({ bundle: m.bundle, market: m.market, bundle_token: T.bundles[i], invalid: m.invalid, slots: m.repos + 1 })),
    children: TB.T.rows.map((r) => ({ index: r.i, repo: r.repo, bundle: r.bundle, slot: r.slot, market: r.address, repo_token: r.repo_token,
      down: fakeAddr('down:' + r.address), up: fakeAddr('up:' + r.address), invalid: fakeAddr('inv:' + r.address), fee_down: 100, fee_up: 100, pool_down: null, pool_up: null })),
  };
  let P;
  await test('selftest: setup (install with the synthetic allowlist)', async () => {
    P = makeProject(W, 'selftest', { allowlist: JSON.stringify(allow, null, 1) + '\n' });
    const r = await r3(W, P, ['install']);
    ok(r.code === 0, say(r));
  });
  if (!P) return;
  const approve = (token, spender, amount) => ({ to: token, data: S.IF.erc20.encodeFunctionData('approve', [spender, amount]) });
  const C = S.PINNED;
  const CASES = [
    ['case-01', [{ to: C.susds, data: S.IF.erc20.encodeFunctionData('transfer', [BURN, 1n]) }], 'token-transfer'],
    ['case-02', [approve(C.susds, BURN, 0n)], 'approval-spender'],
    ['case-03', [approve(C.susds, C.router, (1n << 256n) - 1n)], 'approval-amount'],
    ['case-04', [approve(C.susds, C.router, 1n), approve(C.susds, C.router, 2n), approve(C.susds, BURN, 1n)], 'approval-spender@2'],
    ['case-05', [approve(C.susds, C.router, 1n)], 'allowed'],
  ];
  const saveCases = (folder, expected, { count } = {}) => {
    const dir = path.join(P.run, folder); rmrf(dir); fs.mkdirSync(dir, { recursive: true });
    for (const [name, calls] of CASES) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(calls));
    const list = CASES.map(([name], i) => ({ case: name, expected: expected[i], exit: null, got: null, pass: true }));
    wj(path.join(dir, 'results.json'), { at: new Date().toISOString(), signer: '(the supervised self-test\'s signer)', cases: count === undefined ? list : list.slice(0, count) });
    return `run/${folder}`;
  };
  const RIGHT = CASES.map((c) => c[2]);
  const setupDirs = () => (exists(P.run) ? fs.readdirSync(P.run).filter((d) => /^setup-/.test(d)) : []);
  await test('selftest: every expectation right (a rule, rule@index and allowed) -> exit 0, all passed, results.json beside copies of the cases, the installed signer\'s sha256', async () => {
    const cases = saveCases('supervised-selftest', RIGHT);
    const r = await r3(W, P, ['selftest', '--cases', cases]);
    try {
      ok(r.code === 0 && r.j.ok === true && r.j.passed === 5 && sameList(r.j.failed, []), say(r));
      ok(/^setup-\d{4}-\d\d-\d\dT\d{4}Z(-w2)?$/.test(r.j.run_id) && r.j.results === `run/${r.j.run_id}/selftest/results.json`, `${r.j.run_id} ${r.j.results}`);
      ok(norm(r.j.signer) === norm(P.signerBin) && r.j.signer_sha256 === shaFile(P.signerBin), `signer ${r.j.signer} ${r.j.signer_sha256}`);
      const res = rj(path.join(P.proj, r.j.results));
      ok(res.replayed_from === cases && res.allowlist_sha256 === P.cfg.allowlistSha256 && res.signer_sha256 === shaFile(P.signerBin) && sameList(res.fails, []) && sameList(res.env_dropped, []), clip(res, 400));
      ok(sameList(res.cases.map((c) => [c.case, c.file, c.expected, c.exit, c.pass]), CASES.map(([n, , e], i) => [n, `${n}.json`, e, i === 4 ? 0 : 3, true])), clip(res.cases.map((c) => [c.case, c.expected, c.exit, c.pass])));
      ok(res.cases[3].got.rule === 'approval-spender' && res.cases[3].got.index === 2 && res.cases[4].got.allowed === true, clip(res.cases[3].got));
      for (const [n] of CASES) ok(fs.readFileSync(path.join(P.run, r.j.run_id, 'selftest', `${n}.json`), 'utf8') === fs.readFileSync(path.join(P.proj, cases, `${n}.json`), 'utf8'), `${n} was not copied`);
    } finally { clearRuns(P); }
  });
  await test('selftest: a refusal expected without an index matches the rule at any index', async () => {
    const r = await r3(W, P, ['selftest', '--cases', saveCases('no-index', RIGHT.map((e, i) => (i === 3 ? 'approval-spender' : e)))]);
    try { ok(r.code === 0 && r.j.passed === 5, say(r)); } finally { clearRuns(P); }
  });
  await test('selftest: wrong expectations fail exactly their cases (another rule, the wrong index, allowed for a refusal, a refusal for an allowed call) -> exit 3', async () => {
    const wrong = ['approval-amount', 'approval-spender', 'allowed', 'approval-spender@1', 'token-transfer'];
    const r = await r3(W, P, ['selftest', '--cases', saveCases('wrong-expectations', wrong)]);
    try {
      ok(r.code === 3 && r.j.ok === false && r.j.passed === 1 && sameList(r.j.failed, ['case-01', 'case-03', 'case-04', 'case-05']), say(r));
      const res = rj(path.join(P.proj, r.j.results));
      ok(sameList(res.fails, r.j.failed) && sameList(res.cases.map((c) => c.pass), [false, true, false, false, false]), clip(res.cases.map((c) => [c.case, c.expected, c.got])));
    } finally { clearRuns(P); }
  });
  await test('selftest: a case count that does not match results.json (5 files, 4 saved) -> exit 2, nothing replayed', async () => {
    const before = setupDirs();
    const r = await r3(W, P, ['selftest', '--cases', saveCases('short-results', RIGHT, { count: 4 })]);
    ok(r.code === 2 && /5 case files against 4 saved cases/.test(r.j.error || ''), say(r));
    ok(sameList(setupDirs(), before), 'a self-test run folder was made');
  });
  await test('selftest: an expected value that is not a rule, rule@index or allowed -> exit 2', async () => {
    const r = await r3(W, P, ['selftest', '--cases', saveCases('bad-expected', RIGHT.map((e, i) => (i === 0 ? 'Token Transfer' : e)))]);
    ok(r.code === 2 && /each needing an expected rule/.test(r.j.error || ''), say(r));
  });
  await test('selftest: --cases missing, outside run/ or not a folder -> exit 2', async () => {
    for (const args of [['selftest'], ['selftest', '--cases', 'setup'], ['selftest', '--cases', 'run/no-such-folder']]) {
      const r = await r3(W, P, args);
      ok(r.code === 2 && r.j.ok === false, `${args.join(' ')}: ${say(r)}`);
    }
  });
  await test('selftest: an environment variable the signer reads as an allowlist switch is dropped and the case re-run (env_dropped)', async () => {
    const r = await r3(W, P, ['selftest', '--cases', saveCases('supervised-selftest', RIGHT)], { env: { R3TEST_BYPASS_ALLOWLIST: '1' } });
    try {
      ok(r.code === 0 && r.j.passed === 5, say(r));
      ok(sameList(rj(path.join(P.proj, r.j.results)).env_dropped, ['R3TEST_BYPASS_ALLOWLIST']), 'env_dropped');
    } finally { clearRuns(P); }
  });
}

// =================================================================================================================
// 1. the run records in git: checkpoints never change the working tree; the final push rebases
// =================================================================================================================
async function gitSection(W) {
  const RECORD_EXCLUDED = /^run\/(\.lock\.deep-r3-trade\/|[^/]+\/(exec|f|g|halfb|recovery)-tmp\/)/;
  const FOREIGN = 'other-clone.txt';
  const setupGit = async (name, plan) => {
    const P = await stubProject(W, name);
    P.origin = path.join(P.base, 'origin.git'); P.clone2 = path.join(P.base, 'clone2');
    fs.writeFileSync(path.join(P.proj, '.gitignore'), 'run/\n'); // as the real repository: run/ is ignored and added with -f
    fs.writeFileSync(path.join(P.proj, 'README.md'), `throwaway project ${name} (routine.test.cjs)\n`);
    fs.writeFileSync(P.log, `[${new Date().toISOString()}] the log before this run\n`);
    git(W, P.base, ['init', '-q', '--bare', P.origin]);
    git(W, P.proj, ['init', '-q']);
    git(W, P.proj, ['add', '.gitignore', 'README.md']); git(W, P.proj, ['add', '-f', 'run/setup.deep-r3-trade.json', 'run/wake-deep-r3.log']);
    git(W, P.proj, ['commit', '-q', '-m', 'initial: the setup record']);
    git(W, P.proj, ['remote', 'add', 'origin', P.origin]);
    git(W, P.proj, ['push', '-q', 'origin', 'HEAD:main']);
    git(W, P.base, ['clone', '-q', P.origin, P.clone2]);
    setPlan(P, { gitLogs: true, originDir: P.origin, foreignFile: FOREIGN, ...plan });
    return P;
  };
  const pushForeign = (P, kind) => {
    if (kind === 'log') fs.appendFileSync(path.join(P.clone2, 'run', 'wake-deep-r3.log'), 'a line another clone wrote\n');
    else fs.writeFileSync(path.join(P.clone2, FOREIGN), 'pushed by another clone while the run lasts\n');
    git(W, P.clone2, ['add', '-f', kind === 'log' ? 'run/wake-deep-r3.log' : FOREIGN]);
    git(W, P.clone2, ['commit', '-q', '-m', kind === 'log' ? 'other clone: run/wake-deep-r3.log' : 'other clone: a commit pushed while the run lasts']);
    git(W, P.clone2, ['push', '-q', 'origin', 'HEAD:main']);
  };
  const originLog = (P) => gitLines(W, P.base, ['--git-dir', P.origin, 'log', '--format=%s', 'main']);
  const originPaths = (P) => gitLines(W, P.base, ['--git-dir', P.origin, 'log', '--name-only', '--format=', 'main']);
  const originTree = (P) => gitLines(W, P.base, ['--git-dir', P.origin, 'ls-tree', '-r', '--name-only', 'main']);
  const originShow = (P, rel) => String(git(W, P.base, ['--git-dir', P.origin, 'show', `main:${rel}`]).stdout);

  let G = null;
  await test('git: setup (four throwaway projects, each with a bare origin and a second clone)', async () => {
    G = {
      normal: await setupGit('git-normal', { wakeSeconds: 28 }),
      moved: await setupGit('git-moved', { wakeSeconds: 28 }),
      conflict: await setupGit('git-conflict', { wakeSeconds: 1 }),
      noident: await setupGit('git-noident', { wakeSeconds: 1 }),
    };
    pushForeign(G.conflict, 'log'); // collides with the run's own log lines: the final pull --rebase must fail
    pushForeign(G.noident, 'file');
  });
  if (!G) return;
  // the four runs at once; the second clone pushes to git-moved's origin 3 s in, before its first checkpoint (20 s
  // after its wake starts, so never before 20 s after t0)
  const t0 = Date.now();
  const R = {
    normal: r3(W, G.normal, ['trade', '--push']),
    moved: r3(W, G.moved, ['trade', '--push']),
    conflict: r3(W, G.conflict, ['trade', '--push']),
    noident: r3(W, G.noident, ['trade', '--push'], { env: { GIT_CONFIG_GLOBAL: W.gitNoId } }),
  };
  await sleep(3000);
  let movedAt = null; let movedErr = null;
  try { pushForeign(G.moved, 'file'); movedAt = Date.now() - t0; } catch (e) { movedErr = e.message; }
  for (const k of Object.keys(R)) R[k] = await R[k];
  console.log(`      (git runs: ${Object.entries(R).map(([k, r]) => `${k} ${Math.round(r.ms / 1000)} s`).join(', ')}; the other clone pushed ${movedAt === null ? 'NOT: ' + movedErr : Math.round(movedAt / 1000) + ' s'} in)`);

  const checkpointCommit = (P, rid) => gitLines(W, P.base, ['--git-dir', P.origin, 'log', '--format=%H %s', 'main']).find((l) => l.endsWith(`records: run ${rid} in progress`));
  const commonFinal = (P, r, label) => {
    const rid = r.j.run_id;
    ok(r.code === 0 && r.j.exit === 0 && r.j.status === 'completed' && RID_RE.test(rid || ''), `${label}: ${say(r)}`);
    ok(r.j.pushed && r.j.pushed.pushed === true && r.j.pushed.branch === 'main', `${label}: final push ${clip(r.j.pushed)}`);
    const log = originLog(P);
    ok(log[0] === `records: run ${rid} finished (completed), exit 0` && log.includes(`records: run ${rid} in progress`), `${label}: origin log ${clip(log)}`);
    const tree = originTree(P);
    for (const f of ['wake-status.json', 'report.md', 'candidates.json', 'progress.txt', 'planner/c.json']) ok(tree.includes(`run/${rid}/${f}`), `${label}: origin lacks run/${rid}/${f}`);
    ok(tree.includes('run/wake-deep-r3.log') && tree.includes('run/wake-deep-r3-out.json'), `${label}: origin lacks the run log or the wake output`);
    for (const f of ['progress.txt', 'wake-status.json']) ok(originShow(P, `run/${rid}/${f}`) === fs.readFileSync(path.join(P.run, rid, f), 'utf8'), `${label}: origin's run/${rid}/${f} is not the final one`);
    const bad = originPaths(P).filter((p) => RECORD_EXCLUDED.test(p));
    ok(!bad.length, `${label}: committed and pushed excluded paths: ${bad.slice(0, 6).join(', ')}`);
    const cpc = checkpointCommit(P, rid); ok(cpc, `${label}: no checkpoint commit on origin`);
    const inCp = gitLines(W, P.base, ['--git-dir', P.origin, 'show', '--name-only', '--format=', cpc.split(' ')[0]]);
    ok(inCp.includes(`run/${rid}/candidates.json`) && inCp.includes(`run/${rid}/progress.txt`) && !inCp.some((p) => RECORD_EXCLUDED.test(p)), `${label}: the checkpoint commit holds ${clip(inCp)}`);
    ok(!exists(P.lock), `${label}: the lock was not released`);
    return rid;
  };

  await test('git: a checkpoint while origin has not moved commits and pushes the records mid-run (the lock and the *-tmp folders left out); the final push carries the rest', async () => {
    const P = G.normal; const r = R.normal; const rid = commonFinal(P, r, 'normal');
    const end = wakeEnd(P, rid); ok(end, 'the stub wake recorded no end');
    ok(sameList(end.violations, []), `files moved under the planner: ${clip(end.violations)}`);
    ok(Array.isArray(end.origin_log) && end.origin_log[0] === `records: run ${rid} in progress`, `origin at the wake's end: ${clip(end.origin_log)}`);
    ok(!/checkpoint not pushed/.test(fs.readFileSync(P.log, 'utf8')), 'a checkpoint was not pushed');
  });
  await test('git: a checkpoint after origin moved does not pull: no fetch, the other clone\'s commit and file never reach the working tree mid-run, the planner\'s files never change under it; the log says it was deferred', async () => {
    const P = G.moved; const r = R.moved; const rid = r.j.run_id;
    ok(movedAt !== null && movedAt < 19000, `the other clone's push was not in place before the first checkpoint (${movedAt} ms; ${movedErr || ''}): inconclusive`);
    const end = wakeEnd(P, rid); ok(end, `the stub wake recorded no end: ${say(r)}`);
    ok(sameList(end.violations, []), `files moved under the planner: ${clip(end.violations)}`);
    ok(end.fetch_head === false, 'a fetch or pull ran during the wake (.git/FETCH_HEAD exists)');
    ok(Array.isArray(end.local_log) && Array.isArray(end.origin_log), `the stub could not read git: ${clip(end)}`);
    ok(end.local_log.includes(`records: run ${rid} in progress`), `the checkpoint did not commit: local log ${clip(end.local_log)}`);
    ok(!end.local_log.includes('other clone: a commit pushed while the run lasts'), `the other clone's commit was pulled mid-run: ${clip(end.local_log)}`);
    ok(end.origin_log.includes('other clone: a commit pushed while the run lasts') && !end.origin_log.includes(`records: run ${rid} in progress`), `origin at the wake's end: ${clip(end.origin_log)}`);
    ok(/checkpoint not pushed: origin moved; the final push carries this commit/.test(fs.readFileSync(P.log, 'utf8')), 'the log does not say the checkpoint was deferred');
  });
  await test('git: after origin moved, the final push (the planner gone) pulls with rebase and pushes: origin holds the other clone\'s commit, the checkpoint and the final records', async () => {
    const P = G.moved; const r = R.moved; const rid = commonFinal(P, r, 'moved');
    const log = originLog(P);
    ok(log.indexOf('other clone: a commit pushed while the run lasts') > log.indexOf(`records: run ${rid} in progress`), `the run's commits are not rebased on the other clone's: ${clip(log)}`);
    ok(originTree(P).includes(FOREIGN) && exists(path.join(P.proj, FOREIGN)), 'the other clone\'s file is missing after the final pull');
  });
  await test('git: a final pull --rebase that fails (a conflict on run/wake-deep-r3.log) is aborted: pushed false with the error, no rebase left in progress, the records committed locally, origin unchanged', async () => {
    const P = G.conflict; const r = R.conflict; const rid = r.j.run_id;
    ok(r.code === 0 && r.j.status === 'completed' && RID_RE.test(rid || ''), say(r));
    ok(r.j.pushed && r.j.pushed.pushed === false && /^pull --rebase failed/.test(r.j.pushed.error || ''), `pushed ${clip(r.j.pushed)}`);
    ok(!exists(path.join(P.proj, '.git', 'rebase-merge')) && !exists(path.join(P.proj, '.git', 'rebase-apply')), 'a rebase is left in progress');
    ok(String(git(W, P.proj, ['status', '--porcelain', '--untracked-files=no']).stdout).trim() === '', 'tracked files are left modified or conflicted');
    ok(!fs.readFileSync(P.log, 'utf8').includes('<<<<<<<'), 'conflict markers in the run log');
    ok(gitLines(W, P.proj, ['log', '-1', '--format=%s'])[0] === `records: run ${rid} finished (completed), exit 0`, 'HEAD is not the run\'s final commit');
    ok(gitLines(W, P.proj, ['ls-tree', '-r', '--name-only', 'HEAD']).includes(`run/${rid}/wake-status.json`), 'the records are not committed locally');
    ok(originLog(P)[0] === 'other clone: run/wake-deep-r3.log', `origin moved: ${clip(originLog(P))}`);
    ok(!exists(P.lock), 'the lock was not released');
  });
  // pushRecords commits with `-c user.name=... -c user.email=...` (routine.config.json's git identity), and the final
  // `git pull --rebase` (and its `rebase --abort`) must use it too: a rebase writes new commits, so on a machine with no
  // git identity (a fresh cloud container) it would fail whenever origin moved, and the run's records would not be
  // pushed at all.
  await test('git: the final pull --rebase works on a machine with no git identity (routine.config.json\'s git name and email, as the commit uses)', async () => {
    const P = G.noident; const r = R.noident;
    ok(r.code === 0 && r.j.status === 'completed', say(r));
    ok(!exists(path.join(P.proj, '.git', 'rebase-merge')) && !exists(path.join(P.proj, '.git', 'rebase-apply')), 'a rebase is left in progress');
    ok(r.j.pushed && r.j.pushed.pushed === true, `routine.cjs bug: the records were not pushed: ${clip(String(r.j.pushed && r.j.pushed.error).replace(/\s+/g, ' '), 300)}`);
    ok(originLog(P)[0] === `records: run ${r.j.run_id} finished (completed), exit 0`, `origin ${clip(originLog(P))}`);
  });
}

// =================================================================================================================
// MAIN
// =================================================================================================================
(async () => {
  const base = ARGS.dir ? path.resolve(ARGS.dir) : fs.mkdtempSync(path.join(os.tmpdir(), 'r3-routine-test-'));
  if (isInside(base, REPO)) { console.log(`FAIL  the work folder ${base} holds the repository; choose a folder inside it or elsewhere`); process.exit(2); }
  fs.mkdirSync(base, { recursive: true });
  const root = path.join(base, 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(root, { recursive: true });
  console.log(`routine tests; node ${process.version}; work folder ${root}`);
  const t0 = Date.now();
  const W = { root, home: path.join(root, 'home'), shared: path.join(root, 'shared'), ceiling: root };
  W.nm = path.join(W.shared, 'node_modules'); W.gitGlobal = path.join(W.shared, 'global.gitconfig'); W.gitNoId = path.join(W.shared, 'no-identity.gitconfig');
  fs.mkdirSync(W.home, { recursive: true }); fs.mkdirSync(W.shared, { recursive: true });
  const gitBase = '[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[advice]\n\tdetachedHead = false\n';
  fs.writeFileSync(W.gitGlobal, gitBase + '[user]\n\tname = routine test\n\temail = routine-test@localhost\n');
  fs.writeFileSync(W.gitNoId, gitBase);
  // ethers 6.17.0, copied once into the work folder (read from --ethers-from or this folder's resolution, never written)
  let from = ARGS.ethersFrom ? path.resolve(ARGS.ethersFrom) : null;
  if (!from) { try { from = ethersNodeModules(); } catch (e) { console.log('FAIL  ethers is not resolvable from this folder: pass --ethers-from <node_modules folder> or set NODE_PATH'); process.exit(1); } }
  let ver = null; try { ver = rj(path.join(from, 'ethers', 'package.json')).version; } catch (e) { ver = null; }
  if (ver !== '6.17.0') { console.log(`FAIL  ${from} does not hold ethers 6.17.0 (${ver})`); process.exit(1); }
  fs.cpSync(from, W.nm, { recursive: true });
  // git must not see past the work folder (it may sit inside a repository): the routine's git calls run in the throwaway projects
  fs.mkdirSync(path.join(root, 'no-git'), { recursive: true });
  let seen = cp.spawnSync('git', ['rev-parse', '--git-dir'], { cwd: path.join(root, 'no-git'), env: baseEnv(W), encoding: 'utf8', windowsHide: true });
  if (seen.status === 0) { W.ceiling = root.replace(/\\/g, '/'); seen = cp.spawnSync('git', ['rev-parse', '--git-dir'], { cwd: path.join(root, 'no-git'), env: baseEnv(W), encoding: 'utf8', windowsHide: true }); }
  if (seen.status === 0) { console.log(`FAIL  git finds a repository above the work folder (${String(seen.stdout).trim()}) despite GIT_CEILING_DIRECTORIES; not running`); process.exit(1); }
  if (seen.error) { console.log(`FAIL  git is not runnable: ${seen.error.message}`); process.exit(1); }
  console.log(`      (setup: ${Math.round((Date.now() - t0) / 1000)} s)`);

  const sec = async (name, fn) => { const s0 = Date.now(); await fn(); console.log(`      (${name}: ${Math.round((Date.now() - s0) / 1000)} s)`); };
  if (want('install')) await sec('install', () => installSection(W));
  if (want('passthrough')) await sec('passthrough', () => passthroughSection(W));
  if (want('clearance')) await sec('clearance', () => clearanceSection(W));
  if (want('gates')) await sec('gates', () => gatesSection(W));
  if (want('selftest')) await sec('selftest', () => selftestSection(W));
  if (want('git')) await sec('git', () => gitSection(W));
  await test('contract: every r3.cjs answer was exactly one JSON line, its exit (when it has one) equal to the process exit', () => ok(contract.length === 0, contract.slice(0, 8).join(' | ')));
  console.log(`\n${results.PASS} passed, ${results.FAIL} failed, ${results.SKIP} skipped (${Math.round((Date.now() - t0) / 1000)} s)${failed.length ? '\nFAILED: ' + failed.join(' | ') : ''}`);
  process.exitCode = results.FAIL ? 1 : 0;
})().catch((e) => { console.log('TEST HARNESS ERROR ' + (e && e.stack ? e.stack : e)); process.exitCode = 2; });
