# Report format — what a seer-trade pass returns

Belongs to the `seer-trade` skill; read it when you are about to write the report — in a fan-out every
agent reads it itself, so the blocks come back comparable.

Every agent returns exactly this, so the orchestrator can compare and the human can audit. Every
figure carries its unit.

```
MARKET     <question, verbatim from the encoded question, not the title>
           <address>   chain <id>   run <run-id>
KIND       <binary | categorical | multi-categorical | scalar low..high | multi-scalar>
           <unconditional, collateral <sym> | conditional on "<outcome>" of <parent addr>,
            collateral <parent token sym>, 1 <sym> = <factor> sUSDS if <condition>>
RESOLVES   <what event, on what date, per what source>   oracle answerable from <opening_ts>
           timeout <h>h   min bond <x> ETH   lockup to <date>

RESEARCH
  <numbered findings, each with a link>
  <already decided vs still open>

ESTIMATE   <outcome>: <p>  ...   (sums to 1, Invalid included, never 0)
           <on a scalar: p_up is an expected payout fraction, not a probability>
  reasoning: <a few lines>
  would change my mind: <what, and by how much>

MARKET PRICE  <outcome>: <price>  ...  <unit>   (third entry on a scalar = the pool's Invalid estimate)
              traded <n> swaps / <v> <unit> / <k> traders / last <h>h ago   pool liquidity <raw, onchain>
CONFIDENCE    w = <0..1> because <the Δw rows that fired, each with its number>
BLENDED       <outcome>: <q>  ...

TRADE      <side | NO TRADE>
  route <direct | split | fade | set-sell | merge-arb | pair-carry | parent-mint>  because <why it beat the others>
  stake <x> <unit>   fill <price>   edge <pts>   EV <+x> <unit>   (= <y> sUSDS at factor <f>)
  gross capital <x> <unit> up front, net <y> once the sale legs land
  pays <n> <unit> if <outcomes>       worst case: <total loss, in money>
  limited by: <Kelly cap | pool depth | bankroll | hurdle | nothing cleared>
RETAINED   <token>: <amount> — <why you kept it: Invalid from a split, unsold fade leg, merge residue>

RISKS      <the 2-3 things most likely to make this wrong>
```

For a multi-market run the orchestrator adds one block above the per-market reports:

```
BOOK       markets <n>   staked <x> <unit>   EV <+y>
           common failure: <what> resolves to <outcome|Invalid>, p <z>, applied once
           correlated worst case <w> <unit>   (per-market worst cases summed: <v> — do not report that one)
```

**"No trade" is a complete and often correct answer.** An agent that finds no edge and says so with
the numbers that rejected it has done the job. Never loosen a cap to produce a line.
