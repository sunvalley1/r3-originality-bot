// planner/blind.cjs - `planner blind <run-id>`: the price-free onchain input of the AI research that writes a forecast
// file for D (steps/D-methods/ai-research.md). It reads each tradeable scalar candidate's Reality.eth question state through the helper (getFinalizeTS,
// getBestAnswer, getBond, isPendingArbitration of Market.questionsIds()[0]) and writes
// ./run/<run-id>/onchain-state.blind.json. From candidates.json it reads four fields per row (market, address, kind,
// tradeable), never a price; it writes no forecast and runs no signer. scripts/ai-forecast/prep.cjs turns this file and
// candidates.json's price-blind fields into the research workers' inputs.
'use strict';

const lib = require('./lib.cjs');
const TB = require('./table.cjs');

const { Stop, clip } = lib;
const STATE_FILE = 'onchain-state.blind.json';
const INVALID_ANSWER = '0x' + 'f'.repeat(64);
const bstop = (cause, notes, fields = {}) => new Stop({ step: 'D', cause, status: 'aborted', notes, fields });

async function run(ctx) {
  let raw;
  try { raw = ctx.readRunJson('candidates.json'); } catch (e) {
    throw bstop('candidates-refused', `blind: ${ctx.rel('candidates.json')} is unreadable: ${clip(e.message, 200)}`);
  }
  if (!raw || !Array.isArray(raw.candidates)) throw bstop('candidates-refused', 'blind: candidates.json has no candidates[]');
  const tradeable = raw.candidates.filter((c) => c && c.kind === 'scalar' && c.tradeable === true).map(({ market, address }) => ({ market, address }));
  if (!tradeable.length) throw bstop('no-tradeable', 'blind: candidates.json has no tradeable scalar candidate');
  ctx.log(`blind: ${tradeable.length} tradeable scalar candidates of ${raw.candidates.length}`);

  // Market.questionsIds()[0] of each child, then four reads per question and the block time, in two multicalls
  const r1 = await ctx.multicall('reads-blind1.json', tradeable.map((c) => ({ to: c.address, signature: 'questionsIds()(bytes32[])' })));
  const qids = r1.results.map((x) => (Array.isArray(x[0]) && x[0].length >= 1 ? String(x[0][0]) : null));
  const noQ = tradeable.filter((c, i) => !qids[i]).map((c) => c.market);
  if (noQ.length) throw bstop('no-question', `blind: questionsIds() is empty for ${noQ.slice(0, 5).join(', ')}`);
  const n = qids.length; const R = TB.ADDR.REALITY; const reads = [];
  for (const sig of ['getFinalizeTS(bytes32)(uint32)', 'getBestAnswer(bytes32)(bytes32)', 'getBond(bytes32)(uint256)', 'isPendingArbitration(bytes32)(bool)']) for (const q of qids) reads.push({ to: R, signature: sig, args: [q] });
  reads.push({ to: TB.ADDR.MC3, signature: 'getCurrentBlockTimestamp()(uint256)' });
  const r2 = await ctx.multicall('reads-blind2.json', reads);
  const res = r2.results; const blockTs = Number(res[4 * n][0]);
  const markets = tradeable.map((c, i) => {
    const fin = Number(res[i][0]); const ans = String(res[n + i][0]).toLowerCase(); const posted = fin !== 0;
    let score = null; let label = null;
    if (posted && ans === INVALID_ANSWER) label = 'INVALID';
    else if (posted) { try { score = Number(BigInt(ans)) / 1e18; } catch (e) { score = null; } }
    return { address: c.address, question_id: qids[i], answer_posted: posted, finalize_ts: fin, best_answer: posted ? ans : null, best_answer_score: score, best_answer_label: label, bond_wei: String(res[2 * n + i][0]), pending_arbitration: res[3 * n + i][0] === true };
  });
  const answersPosted = markets.filter((m) => m.answer_posted).length;
  ctx.writeRunJson(STATE_FILE, { chain_id: TB.CHAIN_ID, block: r2.block, block_timestamp: blockTs, note: `Read onchain by the planner (Optimism) at block ${r2.block}: each tradeable child's Reality.eth question (Market.questionsIds()[0]) with getFinalizeTS, getBestAnswer, getBond and isPendingArbitration. finalize_ts 0 means no answer has been posted; a posted answer is the 0-100 score x 1e18 (best_answer_score), or INVALID.`, markets });
  ctx.log(`blind: Reality state of ${n} questions read at block ${r2.block}; ${answersPosted} with an answer posted; wrote ${ctx.rel(STATE_FILE)}`);
  return { questions: n, answers_posted: answersPosted, block: r2.block, artifacts: [ctx.rel(STATE_FILE)] };
}

module.exports = { run };
