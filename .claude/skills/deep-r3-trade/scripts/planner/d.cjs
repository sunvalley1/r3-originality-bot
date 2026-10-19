// planner/d.cjs - `planner d <run-id>` and `planner d <run-id> --supply <csv> [--continue] [--notes <text>]`:
// steps/D-csv-forecast.md, writing ./run/<run-id>/base-forecast.json.
//
// `d <run-id>`: the stored CSV (D step 2, case 2), proceeding silently. D's structural checks only: the pointer as
// JSON with its three fields, its version file under ./run/csv/, the parse, the match. Nothing is hashed (D,
// *Integrity on load*: a scheduled run hashes nothing; a supervised session hashes the version file itself, with a
// command the human sees). No CSV ever provided is the D stop `no-csv`; a pointer that does not resolve is the D
// stop `csv-store-mismatch`; neither is a question.
// `d <run-id> --supply <csv>`: a CSV a human supplies in a supervised session (case 1), read from a path relative
// to the project root. It prints step 5's report and stores nothing until `--continue` (the human's "continue");
// a matched count of 0 is refused even with `--continue`. With `--continue` it writes the version file
// (write-once), rewrites ./run/csv/current.json and writes base-forecast.json.
// D reads exactly five fields per candidate (market, address, kind, outcomes, parent), never a price, and touches
// no chain: this module runs no helper and no signer.
'use strict';

const lib = require('./lib.cjs');

const { Stop, PlannerError, clip, sha256 } = lib;
const GH = 'https://github.com/';
const CURRENT = 'run/csv/current.json';
const VERSION_RE = /^originality-v(\d+)-[A-Za-z0-9._-]+\.csv$/;

// ---- step 3, verbatim from the pseudocode in D. Returns the rows that survive, plus the blank-cell rows it skipped
// (D's pseudocode discards them; step 5 needs them to split "markets with no forecast" into blank-cell and absent).
function parseOriginalityCSV(csv) {
  const text = csv.trim();
  const lines = text.split('\n');
  if (lines.length < 2) throw new Error('CSV must have at least a header row and one data row');
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  if (headers.length !== 2) throw new Error('CSV must have exactly 2 columns: repo, originality');
  if (!(headers.includes('repo') && headers.includes('originality'))) throw new Error('CSV must have columns: repo, originality');
  const seen = new Set();
  const rows = [];
  const blanks = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const values = line.split(',').map((v) => v.trim());
    if (values.length > 2) throw new Error(`Row ${i + 1}: Expected 2 columns, found ${values.length}`);
    while (values.length < 2) values.push('');
    const repo = values[0]; const originalityStr = values[1];
    if (originalityStr === '') { blanks.push({ line: i + 1, repo }); continue; }
    if (repo === '') throw new Error(`Row ${i + 1}: Missing repo. Leave the originality blank to skip a row.`);
    if (seen.has(repo)) throw new Error(`Row ${i + 1}: Duplicate repository "${repo}"`);
    seen.add(repo);
    const x = parseFloat(originalityStr);
    if (Number.isNaN(x)) throw new Error(`Row ${i + 1}: Originality "${originalityStr}" is not a valid number`);
    if (x < 0 || x > 1) throw new Error(`Row ${i + 1}: Originality must be between 0 and 1`);
    rows.push({ line: i + 1, repo, originalityStr, x });
  }
  if (rows.length === 0) throw new Error('CSV contains no predictions — every row was blank or left out.');
  return { rows, blanks };
}

// ---- steps 4 and 5: exact, case-sensitive match; the later row wins; the four counts.
const stripKey = (repo) => repo.replace(GH, '');
function matchRows(parsed, scalarCands) {
  const byMarket = new Map(scalarCands.map((c) => [c.market, c]));
  const lcMarkets = new Map();
  for (const c of scalarCands) { const k = c.market.toLowerCase(); if (!lcMarkets.has(k)) lcMarkets.set(k, []); lcMarkets.get(k).push(c.market); }
  const winner = new Map();
  const overwritten = [];
  const unmatched = [];
  for (const r of parsed.rows) {
    const key = stripKey(r.repo);
    if (!byMarket.has(key)) { unmatched.push({ line: r.line, repo: r.repo, key, did_you_mean: lcMarkets.get(key.toLowerCase()) || null }); continue; }
    if (winner.has(key)) { const e = winner.get(key); overwritten.push({ key, earlier_line: e.line, earlier_repo: e.repo, later_line: r.line, later_repo: r.repo }); }
    winner.set(key, { ...r, key });
  }
  const forecasts = [...winner.values()].sort((a, b) => a.line - b.line);
  const blankKeys = new Set(parsed.blanks.map((b) => stripKey(b.repo)));
  const noForecast = scalarCands.filter((c) => !winner.has(c.market));
  const blankCell = noForecast.filter((c) => blankKeys.has(c.market)).map((c) => c.market);
  const absent = noForecast.filter((c) => !blankKeys.has(c.market)).map((c) => c.market);
  return { forecasts, overwritten, unmatched, blankCell, absent, counts: { matched: forecasts.length, unmatched: unmatched.length, overwritten: overwritten.length, no_forecast: noForecast.length } };
}

// The step 5 report, as lines (kept in the detail file; the summary carries the counts and the first rows).
function reportLines(M, parsed, source) {
  const L = [];
  const { counts } = M;
  L.push(`step 4/5 report (${source === 'new' ? 'a CSV new in this session' : 'the stored CSV, reused'}):`);
  L.push(`  matched: ${counts.matched}`);
  L.push(`  unmatched CSV rows: ${counts.unmatched}`);
  for (const u of M.unmatched) L.push(`    line ${u.line}: compared "${u.key}"${u.repo !== u.key ? ` (from "${u.repo}")` : ''}${u.did_you_mean ? ` -> did you mean ${u.did_you_mean.join(' / ')}?` : ''}`);
  L.push(`  overwritten rows: ${counts.overwritten}`);
  for (const o of M.overwritten) L.push(`    line ${o.earlier_line} ("${o.earlier_repo}") overwritten by line ${o.later_line} ("${o.later_repo}"), key "${o.key}"`);
  L.push(`  markets with no forecast: ${counts.no_forecast} (${M.blankCell.length} blank cell, ${M.absent.length} absent)`);
  L.push(`  accounting: ${parsed.rows.length} non-blank CSV rows = ${counts.matched} matched + ${counts.overwritten} overwritten + ${counts.unmatched} unmatched; ${parsed.blanks.length} blank-cell rows skipped at the parse`);
  return L;
}
const reportFields = (M) => ({
  counts: M.counts,
  unmatched_rows: M.unmatched.slice(0, 20).map((u) => ({ line: u.line, compared: u.key, did_you_mean: u.did_you_mean })),
  overwritten_rows: M.overwritten.slice(0, 20).map((o) => ({ earlier_line: o.earlier_line, later_line: o.later_line, key: o.key })),
  no_forecast_split: { blank_cell: M.blankCell.length, absent: M.absent.length },
});

const dstop = (cause, status, notes, fields = {}) => new Stop({ step: 'D', cause, status, notes, fields });

async function run(ctx) {
  const D = ctx.detail;
  const supply = ctx.opts.supply;
  const source = supply !== undefined ? 'new' : 'stored';
  const runId = ctx.runId;

  // ---------------------------------------------------------------- step 1: the candidate set, five fields
  let raw;
  try { raw = ctx.readRunJson('candidates.json'); } catch (e) {
    throw dstop('candidates-refused', 'aborted', `D step 1: ${ctx.rel('candidates.json')} is unreadable: ${clip(e.message, 200)}`);
  }
  if (!raw || !Array.isArray(raw.candidates)) throw dstop('candidates-refused', 'aborted', 'D step 1: candidates.json has no candidates[]');
  const proj = raw.candidates.map(({ market, address, kind, outcomes, parent }) => ({ market, address, kind, outcomes, parent }));
  const scalar = proj.filter((c) => c.kind === 'scalar');
  const skippedNonScalar = proj.filter((c) => c.kind !== 'scalar').map((c) => c.market);
  ctx.log(`step 1: ${proj.length} candidate rows; ${scalar.length} kind "scalar"; ${skippedNonScalar.length} skipped as not scalar`);
  const refuse = [];
  for (const c of scalar) {
    if (!(Array.isArray(c.outcomes) && c.outcomes[0] === 'DOWN' && c.outcomes[1] === 'UP')) refuse.push(`${c.market}: outcomes[0..1] is ${JSON.stringify((c.outcomes || []).slice(0, 2))}, not ["DOWN","UP"]`);
    if (typeof c.market !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.market)) refuse.push(`${clip(JSON.stringify(c.market), 80)}: not a bare owner/repo string`);
    if (typeof c.address !== 'string' || !/^0x[0-9a-f]{40}$/.test(c.address)) refuse.push(`${c.market}: address ${c.address} is not lowercase 0x + 40 hex`);
  }
  if (new Set(scalar.map((c) => c.address)).size !== scalar.length) refuse.push('duplicate address among candidates');
  if (new Set(scalar.map((c) => c.market)).size !== scalar.length) refuse.push('duplicate market string among candidates');
  if (scalar.length === 0) refuse.push('no scalar rows');
  if (refuse.length) throw dstop('candidates-refused', 'aborted', `D step 1: candidates.json failed D's assertions, nothing written: ${refuse.slice(0, 5).join('; ')}`, { problems: refuse.length });

  // ---------------------------------------------------------------- step 2: get the CSV (never re-ask)
  const csvNames = ctx.listRunDir('csv');
  const versionFiles = csvNames.filter((f) => /^originality-v.*\.csv$/.test(f));
  let bytes; let store = null; let storeProblem = null;
  const mismatch = (file, why) => dstop('csv-store-mismatch', 'csv-store-mismatch', `D step 2: csv-store-mismatch: ${file}: ${why}. No fallback to another version and no replacement asked; supply a new CSV in a supervised session.`, { damaged_file: file });

  if (source === 'new') {
    // A .csv file only: the parse errors quote cells, so a mistyped path must never read another kind of file.
    if (!/\.csv$/i.test(String(supply))) throw new PlannerError('bad_argument', '--supply must name a .csv file relative to the project root', lib.EXIT.USAGE);
    try { bytes = ctx.readProjectFile(supply); } catch (e) {
      if (e instanceof PlannerError) throw new PlannerError(e.code, `--supply: ${e.message}`, e.exit);
      throw e;
    }
    ctx.log(`step 2: case 1, a CSV supplied in this session: ${supply} (${bytes.length} bytes); it becomes a new version only at step 7`);
    if (csvNames.includes('current.json')) {
      try { store = JSON.parse(ctx.readRel(CURRENT).toString('utf8')); } catch (e) { storeProblem = 'current.json does not read as JSON: ' + clip(e.message, 120); }
      if (store && (typeof store !== 'object' || Array.isArray(store) || ['current', 'version', 'sha256'].some((k) => store[k] === undefined || store[k] === null))) { storeProblem = 'current.json lacks current, version or sha256'; store = null; }
      if (store) {
        const m = /^\.\/run\/csv\/([^/\\]+)$/.exec(String(store.current));
        if (!m || !VERSION_RE.test(m[1]) || !csvNames.includes(m[1])) { storeProblem = 'current.json names a version file that is gone'; store = null; }
      }
    } else if (versionFiles.length) storeProblem = 'current.json is missing while version files exist';
    if (storeProblem) ctx.log(`  note: the existing store is damaged (${storeProblem}); this CSV still becomes a new version and the store is repaired`);
  } else {
    if (!csvNames.includes('current.json')) {
      if (versionFiles.length) throw mismatch('./run/csv/current.json', `current.json is missing while version files sit beside it (${versionFiles.slice(0, 5).join(', ')})`);
      throw dstop('no-csv', 'no-csv', 'D step 2: no CSV has ever been provided (./run/csv/current.json does not exist and ./run/csv/ holds no originality-v*.csv); no base-forecast.json written. A human supplies version 1 in a supervised session.');
    }
    try { store = JSON.parse(ctx.readRel(CURRENT).toString('utf8')); } catch (e) { throw mismatch('./run/csv/current.json', 'does not read as JSON: ' + clip(e.message, 120)); }
    if (!store || typeof store !== 'object' || Array.isArray(store)) throw mismatch('./run/csv/current.json', 'is not a JSON object');
    for (const k of ['current', 'version', 'sha256']) if (store[k] === undefined || store[k] === null) throw mismatch('./run/csv/current.json', `field "${k}" is missing`);
    const m = /^\.\/run\/csv\/([^/\\]+)$/.exec(String(store.current));
    if (!m || !VERSION_RE.test(m[1])) throw mismatch(String(store.current), 'current.json names a file that is not a version file under ./run/csv/');
    try { bytes = ctx.readRel(`run/csv/${m[1]}`); } catch (e) { throw mismatch(String(store.current), 'the version file named by current.json is gone or unreadable'); }
    ctx.log(`step 2: case 2, the stored CSV: current.json -> ${store.current} (v${store.version}, supplied ${store.supplied_at} in run ${store.supplied_in_run}); proceeding silently. Structural checks only: nothing is hashed.`);
  }
  const text = bytes.toString('utf8');

  // ---------------------------------------------------------------- steps 3 to 5: parse, match, report
  let parsed;
  try { parsed = parseOriginalityCSV(text); } catch (e) {
    if (source === 'stored') throw mismatch(String(store.current), 'the version file does not parse: ' + e.message);
    const swapped = /^Row \d+: Originality "https?:\/\/github\.com/.test(e.message) || /^Row \d+: Originality "[^"]*\/[^"]*" is not a valid number/.test(e.message);
    throw dstop('parse-error', null, `D step 3: parse error, fatal for the whole file; nothing stored, no base-forecast.json: ${e.message}${swapped ? ' (an Originality cell holding a repo URL means the columns are swapped: the header check tests membership, not order)' : ''}`, { parse_error: e.message });
  }
  const M = matchRows(parsed, scalar);
  const { counts } = M;
  D.report = reportLines(M, parsed, source);
  D.blank_cell = M.blankCell; D.absent = M.absent; D.unmatched = M.unmatched; D.overwritten = M.overwritten;
  for (const l of D.report) ctx.log(l);

  let countsDiffer = null; let previous = null;
  if (source === 'stored') {
    if (counts.matched === 0) throw mismatch(String(store.current), 'the stored CSV matches none of the 98 markets (step 4)');
    const recd = store.counts || {};
    const differs = ['matched', 'unmatched', 'overwritten', 'no_forecast'].filter((k) => recd[k] !== counts[k]);
    if (differs.length) {
      countsDiffer = differs.map((k) => `${k}: recorded ${recd[k]}, now ${counts[k]}`).join('; ');
      ctx.log(`  COUNTS DIFFER from those current.json recorded for v${store.version} (${countsDiffer}): either the file or C's candidate set changed (nothing is hashed here, so this says only that). Adjusting nothing.`);
    }
    // Which version the previous run of this arm cited (said plainly, never a stop).
    for (const d of ctx.listRunIds().filter((x) => x !== runId).reverse()) {
      if (!ctx.existsRel(`run/${d}/base-forecast.json`)) continue;
      try {
        const bf = JSON.parse(ctx.readRel(`run/${d}/base-forecast.json`).toString('utf8'));
        if (bf.method === 'csv-face-value') { previous = { run: d, source: bf.forecasts && bf.forecasts[0] && bf.forecasts[0].sources && bf.forecasts[0].sources[0] }; break; }
      } catch (e) { /* not this arm's, or unreadable: skip */ }
    }
  } else {
    if (counts.matched === 0) {
      throw dstop('refused-zero-match', null, 'D step 5: matched is 0, so nothing is stored and no base-forecast.json is written, even with --continue; supply another file.', reportFields(M));
    }
    if (!ctx.opts.continue) {
      throw dstop('awaiting-continue', null, 'D step 5: the report is printed; nothing is stored until the human says continue (re-run with --continue), or edits the CSV (re-run on the new file).', reportFields(M));
    }
    ctx.log('  the human said continue (--continue on the command the human approved)');
  }

  // ---------------------------------------------------------------- steps 6 and 7: convert, assert, store, write
  let N; let csvPath; let sha; let suppliedAt; let suppliedInRun; let versionName = null;
  if (source === 'new') {
    const nums = versionFiles.map((f) => Number((f.match(/^originality-v(\d+)-/) || [])[1])).filter(Number.isFinite);
    if (store && Number.isFinite(store.version)) nums.push(store.version);
    N = (nums.length ? Math.max(...nums) : 0) + 1;
    versionName = `originality-v${N}-${runId}.csv`;
    csvPath = `./run/csv/${versionName}`;
    sha = sha256(bytes);
    suppliedAt = lib.nowIsoSec();
    suppliedInRun = runId;
    if (csvNames.includes(versionName)) throw dstop('refused-exists', null, `D step 7: ${csvPath} already exists; versions are write-once, never overwritten`);
  } else {
    N = store.version; csvPath = store.current; sha = String(store.sha256).toLowerCase(); suppliedAt = store.supplied_at; suppliedInRun = store.supplied_in_run;
  }
  const h12 = sha.slice(0, 12);
  const forecasts = M.forecasts.map((r) => {
    const pu = r.x; const pd = 1 - r.x;
    const cand = scalar.find((c) => c.market === r.key);
    return {
      market: cand.market,
      address: cand.address,
      p: [pd, pu, 0.0],
      invalid_p: 0.0,
      sums_to_one: (pd + pu + 0.0) === 1,
      reasoning: `CSV line ${r.line}: ${r.key},${r.originalityStr}. Taken at face value; Invalid set to 0. CSV v${N}, sha256 ${h12}, supplied ${suppliedAt}, ${source === 'new' ? 'new this session' : 'reused unchanged'}.`,
      sources: [csvPath],
      would_change_my_mind: 'A different CSV.',
    };
  });
  const bad = [];
  if (forecasts.length !== counts.matched) bad.push('forecast count != matched');
  if (new Set(forecasts.map((f) => f.address)).size !== forecasts.length) bad.push('duplicate address in forecasts');
  for (const f of forecasts) {
    if (f.p.length !== 3 || !f.sums_to_one) bad.push(`${f.market}: p ${JSON.stringify(f.p)} (sums_to_one ${f.sums_to_one})`);
    if (f.address !== f.address.toLowerCase()) bad.push(`${f.market}: address not lowercase`);
  }
  if (bad.length) throw dstop('self-check-failed', 'aborted', `D step 7 self-check, nothing written: ${bad.slice(0, 5).join('; ')}`);

  let history = null;
  if (source === 'new') {
    // Writing a version, after the human said continue: the bytes exactly as supplied, write-once, then the pointer.
    ctx.writeRel(`run/csv/${versionName}`, bytes, { flag: 'wx' });
    history = [];
    if (store && Array.isArray(store.history)) history.push(...store.history);
    if (store && store.current) history.push({ version: store.version, path: store.current, sha256: store.sha256, supplied_at: store.supplied_at, superseded_at: suppliedAt });
    else if (storeProblem) {
      // A damaged store: rebuild history from the version files on disk, sha256 recomputed, dates unknown.
      for (const f of versionFiles.filter((x) => VERSION_RE.test(x)).sort()) {
        let h = null; try { h = sha256(ctx.readRel(`run/csv/${f}`)); } catch (e) { h = null; }
        history.push({ version: Number(f.match(/^originality-v(\d+)-/)[1]), path: `./run/csv/${f}`, sha256: h, supplied_at: null, superseded_at: suppliedAt });
      }
      ctx.log('  the store was repaired: history rebuilt from the version files on disk');
    }
    const pointer = {
      current: csvPath, version: N, sha256: sha, supplied_at: suppliedAt, supplied_in_run: suppliedInRun,
      counts: { matched: counts.matched, unmatched: counts.unmatched, overwritten: counts.overwritten, no_forecast: counts.no_forecast },
      history,
    };
    if (ctx.opts.notes !== undefined) pointer.notes = String(ctx.opts.notes);
    ctx.writeRel(CURRENT, JSON.stringify(pointer, null, 2) + '\n');
    ctx.log(`  stored version ${N}: ${csvPath} (sha256 ${sha}); current.json rewritten, history length ${history.length}`);
  }
  const out = { generated_at: lib.nowIsoSec(), method: 'csv-face-value', price_seen: false, forecasts };
  ctx.writeRunJson('base-forecast.json', out);
  ctx.log(`step 7: wrote ${ctx.rel('base-forecast.json')}: ${forecasts.length} forecasts, method csv-face-value, price_seen false, sources [${csvPath}]`);

  const artifacts = [ctx.rel('base-forecast.json')];
  if (source === 'new') artifacts.push(`run/csv/${versionName}`, CURRENT);
  return {
    source,
    forecasts: forecasts.length,
    csv: {
      version: N, path: csvPath, sha256: sha, supplied_at: suppliedAt, supplied_in_run: suppliedInRun, reused: source === 'stored',
      counts: { matched: counts.matched, unmatched: counts.unmatched, overwritten: counts.overwritten, no_forecast: counts.no_forecast },
      hash_checked: source === 'new' ? 'computed from the supplied bytes' : 'not hashed (structural checks only)',
      counts_differ: countsDiffer,
      store_repaired: source === 'new' && !!storeProblem,
    },
    previous_run_cited: previous ? { run_id: previous.run, path: previous.source || null, same_version: previous.source === csvPath } : null,
    ...reportFields(M),
    skipped_not_scalar: skippedNonScalar,
    artifacts,
  };
}

module.exports = { run, parseOriginalityCSV, matchRows, stripKey };
