# Several markets at once — fan-out rules for the seer-trade pipeline

Belongs to the `seer-trade` skill; read it before dispatching sub-agents, i.e. whenever a run covers
more than one market, and again at the merge before F.

**Research fans out. The book and the trade do not.**

One controller per market coordinates this same pipeline and keeps its priced context on one question.
Each controller delegates D to a separate fresh no-history worker; its own C context never reaches D.
Read [the exact worker boundary](price-blind-worker.md) before dispatching a forecaster.

Give each agent exactly three things: **the market address, its bankroll slice, and its own run id**
`<run-id>/<first-8-of-address>`. Pass the run id that way, not the directory: every step writes to
`./run/<run-id>/` from the id it was given, so an agent told only "your directory is
`./run/<id>/<addr8>/`" still writes `./run/<id>/candidates.json` and collides with its siblings.
Nothing else goes to the agent. In particular, never pass on:

- what you think the answer is, or a range you would find plausible;
- another agent's estimate, weight, or conclusion — not even "the others came out around 60";
- which way you expect them to come out, or that you have a position already.

That is not politeness. Independent estimates across siblings are the only cross-check this pipeline
has; contaminate them and the agreement you get back is your own opinion echoed N times. Separate
directories are not optional either — parallel agents writing one `candidates.json` overwrite each
other silently.

**Per-market controllers run C, dispatch a clean D worker, then perform E and a draft F and stop.**
The D worker receives only the checked candidate/question/policy projections, projected forecast
calibration, price-free procedure and output destination. It inherits no controller history, bankroll,
positions, C commentary, sibling estimates, prices, full candidates or calibration. It returns only its
normal forecast and source/contamination status; the controller validates that output before E. A
contaminated estimate is discarded and restarted in another clean worker, never rehabilitated.
No per-market controller or forecaster runs G. An agent that executes makes the next three steps impossible.

Then the orchestrator, single-threaded:

1. **Merge** the per-agent artifacts into one `./run/<run-id>/` book by concatenating the arrays —
   `candidates`, `forecasts`, `blends` and every `skipped` list — and re-checking that addresses are
   unique. `./run/calibration.json` is not per-agent and stays where it is.
2. **Cross-check siblings.** Seer regularly carries several markets on one event with different
   wording — one with "Abstain" as an outcome and one without, one with a quorum clause and one
   without. They are not substitutes. If two agents' estimates imply contradictory views of the same
   underlying fact, at least one is wrong; resolve it before trading either. Re-read the *encoded*
   question on each, never the title.
3. **Re-run F once over the merged book.** Per-market Kelly caps do not compose, and F's correlated
   worst case has to see the whole book to apply the common failure factor **once** rather than once
   per market. Markets that hinge on the same poll reaching quorum are one exposure, not four — size them
   as one position.
4. **Work out which outcome the common failure actually resolves to, and never assume it is Invalid.**
   Plenty of questions define it away: criteria that make a failed quorum resolve *No* turn a "No"
   book into a hedge and a "Yes" book into a doubled-up concentration. Get this backwards and you
   have inverted your hedge.
5. **One approval. One G.** One human approval covering the merged book, then one execution pass.

Running the same market on **different models**, each with its own clean D context, and comparing is a cheap, real second opinion:
agreement earns a higher `w`, disagreement lowers it. Running it on the same model twice does not.
