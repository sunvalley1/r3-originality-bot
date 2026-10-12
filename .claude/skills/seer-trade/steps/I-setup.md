# I-setup.md — get a wallet that can trade, then a wake that can prepare

Stand up the wallet before the pipeline spends, and — optionally, only after a pass has finished green and
only under a separate OS user (I.2) — a recurring wake that prepares another pass. Read-only C–F work can
proceed without funded setup.

## Input / Output

**INPUT** from the human: a wallet setup/funding request, or their chosen signer's public address and
mode. Reuse the verified address already announced in this conversation for an agent-created wallet;
never ask for a secret or a repeated address confirmation. Read funding onchain. Wallet-only onboarding
needs no market universe or bankroll. I.2 takes the universe and bankroll a wake may use, with its unit
and whether it caps a wake or the whole book.
**OUTPUT** `./run/setup.json` — one file for all runs, beside `./run/calibration.json`.

**I.1's applicable checks pass before any real collateral conversion or trade; I.2 only after a whole
supervised pass finished green.** C–E forecasting, and C–F preparation with the human's stated sizing
bankroll, need no funded wallet or conversion. Missing funds or a missing signer leave setup partial while
research proceeds; a missing executor does not block trading (sequential mode, I.1 §6). Enter I.1
directly for wallet-only setup/funding/resume; it does not start C–H.
You do not schedule a pipeline you have never seen finish. Mechanics are not repeated here: `evm-onchain`
for chain, gas, the address table and Uniswap; `seer-protocol` for the Router and the artifacts. Chain
Optimism (10), RPC `https://mainnet.optimism.io`. Say **"onchain"**, one word. **Not R3-specific:** on
Optimism every market in scope settles in **sUSDS**, so that is the conversion target; on another chain it
is whatever that chain's markets settle in (Gnosis: sDAI, another PSM), and on a chain `evm-onchain` has not
verified, **stop** — the orchestrator's *Chain scope* rule.

## I.1 — the wallet

### 1. Create or reuse, verify, then give the funding address

Follow [shared wallet onboarding](../../evm-onchain/reference/wallet-onboarding.md). On Windows, a request
to set up a dedicated wallet authorizes the local signer to create or reuse it, with no key import in chat
and no repeat confirmation. Use `wallet:info`, `wallet:create` if absent, `wallet:verify`, and `wallet:status`
from the repository root, where a checkout ships that tooling. The signing process handles encrypted
credentials; the model reads only public results. Keep an existing signer that needs no human action per
transaction (EIP-7702, a session key, another agent backend) if that is the human's choice. A browser or
hardware wallet that asks for a human confirmation per transaction is not a trading signer; it may sign
one-off human actions only, such as an owner granting a session key.

Save partial progress under `onboarding` in `run/setup.json` before returning a funding handoff. Zero
balance means `needs-funding`; `needs-executor` is informational only — atomic batches unavailable,
sequential mode (§6) — never a blocker for trading. Give the checksummed address, network, ETH gas need
and verified collateral destination, then resume from that
same wallet after funding. Signing success is not full trading preflight or a successful C–H run.

```
addr = <the signer's own address — G-execute-trade.md's Signer interface, nothing more>
print addr                                          # the address, and nothing else
if lower(addr) != lower(expected_signer): STOP.     # never "try it and see"
```

`expected_signer` is the public address selected by the human, or the possession-verified address announced
when this conversation created the wallet. A file a wake could rewrite is not that identity anchor.
A mismatch stops setup; never replace or rotate the wallet to solve it. Verify chain (step 2) and holder
separately: tokens may sit in an executor while the signer pays gas.

### 2. Confirm the chain before you trust a single number

```
eth_chainId              -> 0xa (10)   anything else: STOP
eth_blockNumber          -> must advance between two reads (the paragraph below says how long to wait)
PSM3.susds() 0x58b8f19c  -> 0xb5b2dc7fd34c249f4be7fb1fcea07950784229e0   (sUSDS, 18 dp)
PSM3.usdc()  0x3e413bee  -> 0x0b2c639c533813f4aa9d7837caf62653d097ff85   (USDC,  6 dp)
PSM3.usds()  0x4cf282fb  -> 0x4f13a96ec5c4cf34e442b46bbd98a0791f20edc3   (USDS, 18 dp)
```

PSM3 is `0xe0F9978b907853F354d79188A3dEfbD41978af62`. A wrong-chain node answers `balanceOf` cheerfully, and
this cross-check beats `eth_chainId` alone because it proves the node is on the chain where *these* contracts
live. CREATE2 means a bare code check does not.

For block advancement, allow time for a new block: after the initial read, wait two seconds between
checks, up to ten seconds total. Equal immediate reads are normal. No advancement in that window leaves
chain freshness unverified; report the observation and retry the RPC later without replacing the wallet.

### 3. Read the four balances — all public, all keyed by address

`eth_getBalance(signer, "latest")` for ETH (18 dp, at the address that **signs**), and `balanceOf`
`0x70a08231` for USDC (**6**), USDS (18) and sUSDS (18) at the **holder**. One `aggregate3` on Multicall3
`0xcA11bde05977b3631167028862bE2a173976CA11` (`allowFailure: true`) plus `getEthBalance` does all four in one
round trip. Read `decimals()` `0x313ce567` and `symbol()` `0x95d89b41` off each token, not off a table.

Inspect every required Multicall result's `success` before decoding. A failed balance/metadata read is
unknown, never zero; retry that public read or leave funding unverified instead of requesting a top-up.

**USDC's 6 decimals is the classic money-losing bug.** `formatUnits(raw, 18)` on USDC is off by exactly
`1e12` — 1,000 USDC reads as `0.000000001`, so every gate downstream answers "not enough" on a funded wallet.
The parse direction is worse and is no display bug: `parseUnits("1000", 18)` against USDC is `1e21` raw = a
quadrillion USDC; `approve` does not check your balance so it **succeeds**, the swap then reverts on
`transferFrom`, the run looks like it failed safely — and the allowance persists. Carry every amount as a
`bigint` with its decimals attached.

### 4. Convert to sUSDS through PSM3 — one approve, one swap, and a real bound

This section is an execution option, never a prerequisite for read-only C–F preparation. Before a real
conversion, verify the applicable chain, identity, funded input/gas, holder and signer capability checks
in sections 1–3 and 6–7, then quote/simulate the exact action and apply the existing approval gate.
Do not convert merely to make an unfunded research pass or setup status green.

```
QUOTE   PSM3.previewSwapExactIn(assetIn, assetOut, amountIn) -> amountOut   0x00d8088a (eth_call)
APPROVE assetIn.approve(PSM3, amountIn)                                    0x095ea7b3 exact amount
SWAP    PSM3.swapExactIn(assetIn, assetOut, amountIn, minAmountOut, receiver, referralCode) 0x1a019e37

USDC -> sUSDS  amountIn = 1000 USDC = 1_000_000_000n          # 1e3 * 1e6 — watch the 6
               quote    = 899_937_140_000_000_000_000n        # measured rate 0.89993714
USDS -> sUSDS  amountIn = 1000 USDS = 1_000_000_000_000_000_000_000n
               quote   ~= 899_937_140_574_774_000_000n        # same per-unit rate
both           minAmountOut = quote * 9999n / 10000n   # 1 bp. NEVER 0.  receiver = holder(), ref = 0
```

PSM3 is **rate-based, not an AMM** — the same per-unit rate came back at 1 USDC and at 1,000, so no curve and
no size-dependent slippage, and measured drift of `+4.04e-6`/hour means 1 bp covers ~25 hours. Use 1–5 bp,
not 1%. A stale bound here **fails safe**: it cannot be sandwiched, it reverts and you re-quote — the
opposite of the Uniswap legs in `G-execute-trade.md`, where a loose bound funds someone else's trade.
`receiver` is a real decision: send the sUSDS to the EOA while the holder is a batch executor and the
executor has nothing to trade with.

**Money back out** reverses the pair and adds a gate that has nothing to do with price: PSM3 pays the output
leg from its **own balance**, and `previewSwapExactIn` does **not check inventory** — measured, it quoted
1,111.19 USDS for 1,000 sUSDS while PSM3 held **1.50 USDS**.

```
1 previewSwapExactIn(sUSDS, assetOut, amountIn)   2 CAPACITY: assetOut.balanceOf(PSM3) >= amountOut
3 sUSDS.approve(PSM3, amountIn)                   4 swapExactIn(sUSDS, assetOut, …, minAmountOut, …)
```

Step 2 is the skipped one; re-read it immediately before sending, in **both** directions. Measured inventory
2026-09-30: **999,800 USDC, 1.50 USDS, 883,512 sUSDS**, so **default the exit to USDC**. **This conversion is
a send**, so it goes through the orchestrator's human-approval gate — present, explicit yes, once, reconcile
by **balance delta** and not by receipt — and it is your first real exercise of that path.

### 5. sUSDS is not a dollar

Measured 2026-09-30, **1 sUSDS = 1.111189610534094 USDS**, drifting ~3.6%/yr (1.1101 ten days earlier). Three
wrong routes to a dollar figure, all measured: **assuming 1 sUSDS = $1** understates by **11.1%**, so a
position "sized in dollars" that way is 11% too big; **`convertToAssetValue`/`convertToAssets`** return
1.0332246, PSM3's own **LP share price** (`totalAssets/totalShares`), **7.5% wrong** here; and **treating
sUSDS as ERC-4626** — on Optimism `asset()` and `convertToAssets(uint256)` both **revert**, so a try/catch
falling back to 1:1 silently restores the first error. The one right call:
`usdPerSusds = previewSwapExactIn(sUSDS, USDS, 1e18) / 1e18`, because USDS is the 1:1 dollar leg. Record it
**with its timestamp** and label every dollar figure with it.

### 6. Pick a signer mode, and record which one

**`G-execute-trade.md`'s `## Signer interface` is the whole contract and there must not be a second one** —
read it there. Setup adds one thing to *know*, not to the interface: which address pays gas, since ETH sits
with the signer and tokens with `holder()`.

| Mode | Unattended | `atomic: true` | Blast radius on a leaked key |
|---|---|---|---|
| **local encrypted EOA** | signs without a human click; never supplied to the wake | **no** — trades in sequential mode (below) | dedicated EOA balance on every chain |
| **(a) browser / hardware wallet** | no — a human click per transaction, so **not a trading signer**; one-off human-signed actions only, such as the (b) owner granting a session key | no | whole EOA, every chain, forever |
| **(b) batch executor + time-boxed session key** | signs without a human click inside the window; never supplied to the wake | yes | everything the executor holds, until `expire` — that window also bounds a misbehaving or injected agent, not only a thief |
| **(c) EIP-7702 delegated EOA — recommended** | signs without a human click when a signing process holds its key; never supplied to the wake | yes, **only if atomicity is requested** | whole EOA, every chain; delegation makes draining it one call |
| **other agent signer** (signs without a human click) | never supplied to the wake | record what is verified; `false` = sequential mode | whatever its key can reach |

**Any signer that needs no human action per transaction may trade; EIP-7702 (c) is recommended because it
gives atomic batches. Onboarding defaults to the local EOA. No signer is supplied to the wake, in any
mode.** The local CLI sends individual transactions and does not implement G's atomic interface; never wrap
sequential sends and call them atomic — record `atomic_batches: false`. An **atomic** signer
(`atomic_batches: true`: (c) with atomic batches, or (b)'s `batchExecute`) lands each keep-whole group —
mint, split or merge, pair, set-sell, merge-arb — as one transaction. A **non-atomic** signer runs each
group in **sequential mode**, as the orchestrator's *The human approval gate* sets out: simulate the whole
ordered sequence first; send one transaction at a time in nonce order, awaiting each receipt; re-check its
floors and the pre-send state before each; on any failure, revert or floor breach, stop sending, reconcile
from chain state and present a recovery batch — complete the group at fresh quotes or unwind what landed —
for its own explicit yes. Tell the human plainly that a sequential group can be left half-done between
transactions; EIP-7702 removes that risk, which is why it is recommended. The human's yes per batch
approves a plan, not each signature, in either mode.

For (b), name its cost: `batchExecute` restricts **no target and no selector**, so inside the window its holder moves anything the executor holds. If used — the **human** signs
`setTemporaryPermission(session, expire)` and the gas top-up as owner; the trading signer holds **only**
the session key; a run that would outlast `expire` **stops and asks**, never re-authorizing itself. Two
traps: handing the trading signer the **owner** key "so it can renew" removes the time-box entirely,
because `owner` is authorized with no window at all; and `owner` is **immutable**, so a leaked owner key means
drain and redeploy at a new address. One CREATE2 salt has been used with two bytecodes, so **each owner has
two executor addresses** — check both before calling a wallet clean.

### 7. Preflight, before the first trade of a run

Re-run the starred blocks immediately before **every** transaction. Any failure stops that send;
read-only C–F preparation may continue with the missing readiness recorded.

```
CHAIN     1 chainId == 0xa   2 blockNumber advances   3 PSM3's three getters match
IDENTITY  4 signer == the address the human stated (case-insensitive)  5 holder == the funded address
          6 print ONLY addresses — no key, no env dump, no keystore read, ever
(b) only  7 executor owner == the human's, and signer != owner   8 permitted == signer, and expire >
          now + run duration, else STOP AND ASK   9 recompute the CREATE2 address; check both
GAS     * 10 balance(signer) >= 0.002 ETH   11 l1BaseFee() and eth_feeHistory read FRESH this run
          12 every tx min(estimateGas*1.2, 16_777_216) — if it clamps, SPLIT the batch
COLLAT. * 13 sUSDS.balanceOf(holder) >= the run's GROSS need (a split takes the whole set up front)
          14 decimals()==18, symbol()=="sUSDS", read not assumed  15 usdPerSusds, with its timestamp
          16 converting? assetIn.decimals() onchain AND assetOut.balanceOf(PSM3) >= amountOut
ALLOW.  * 17 allowance(holder, ·) is the exact leg amount, 0, or an exactOutputSingle leg's unconsumed residue (seer-protocol §6), for PSM3, Seer Router and SwapRouter02
          18 none is type(uint256).max, none outside evm-onchain's table  19 (b) read them at the EXECUTOR
POSITIONS 20 outcome balances in scope are 0, or F sized against them — a trade is not idempotent
          21 (b) revoke an unrecognised permitted key: setTemporaryPermission(0x0, 0), owner-signed
LIVE    * 22 eth_getCode non-empty for every evm-onchain address you will touch, and the executor
          23 every pool: getPool(t0,t1,100) != 0x0 AND liquidity() != 0 — a drained pool keeps its last
          sqrtPriceX96 forever, so a normal-looking price is not proof of life
SIMULATE  24 simulate the whole ordered call list against live state; refuse on any revert
```

**Fund 0.002–0.005 ETH** — ~100× the ~2e-5 to 3e-5 ETH estimated for 40 markets, because running out of gas
mid-batch is the failure that leaves a naked leg, three of that estimate's six lines are unmeasured, and
`l1BaseFee()` moved **16×** in a day. Gas composition and the L1 leg are `evm-onchain`'s. Lines 4–9 verify the
**result** — which address ended up in the signer — without touching the secret, and they fail closed.

## I.2 — the recurring wake

**The rule, in plain words.** Supervised runs, where the human approves each batch in the session, need
nothing from this section. **The unattended scheduled run is optional.** Any wallet that signs without a
human click can be used by any program running as the same OS user, so a scheduled run must run as a
**separate standard (non-admin) OS user** that cannot reach the key. **If the operator does not set that up,
do not schedule: run the pipeline manually when wanted.** Never schedule the wake under the operator's own
account. The next subsection, **the wake account, in plain words**, is the setup per OS and the one check
the human makes before scheduling; the rest of I.2 is the how-to for operators who do set it up.

### The wake account, in plain words

A **separate login on the same computer**, made only for the wake: a standard (non-admin) user that can read
the project folder (the one holding `./run/`), write `./run/` and nothing else, and reach nothing of the
operator's — above all the signer's key-store folder, wherever it lives, even inside the project folder.

- **Windows.** Create a standard local user (Settings > Accounts > Other users, or `net user <wake-account> * /add`
  from an administrator prompt). From a cmd prompt in the project root: `icacls . /grant <wake-account>:(OI)(CI)RX`,
  then `icacls run /grant <wake-account>:(OI)(CI)M`. If the key store sits inside the project folder, deny it
  that subfolder: `icacls <key-store-folder> /deny <wake-account>:(OI)(CI)F`.
- **macOS and Linux.** Create a non-admin user (macOS: System Settings > Users & Groups, type Standard; Linux:
  `useradd`). Give it read on the project folder and write on `./run/` only, with ACLs (Linux:
  `setfacl -R -m u:<wake-account>:rX .`, then the same with `rwX` on `run`; macOS: `chmod +a`, or Finder's
  Get Info > Sharing & Permissions), plus execute-only on any folder above the project it cannot already pass
  through. Keep the key store `chmod 700`, owned by the operator.
- **The one check, made by the human, before scheduling.** Sign in as that account (Windows:
  `runas /user:<wake-account> cmd`; macOS and Linux: `sudo -u <wake-account> -i`, or log in as it), go to the
  project root and run a signer command that must unlock the key or sign, such as its verify or self-test —
  not one that only prints the public address, which passes even when the key is reachable. It must fail
  **because the key cannot be unlocked**, not because the account could not start or the folder was out of
  reach; fix that and repeat. If it unlocks, do not schedule. The agent never runs this and never sees the key.
- **Record it.** Write `signer_reachable_from_wake: false` in `./run/setup.json` only after the human reports
  that failure; `schedule.created_at` stays `null` until then (Output section).

### 1. The gate: only after a pass you watched finish

Write `first_successful_run` before creating any schedule, and mean it concretely: **every artifact written**
(`candidates.json`, `base-forecast.json`, `blended.json`, `allocation.json`, `fills.json`, `review.json`, one
run id); **fills reconciled onchain**, every `filled` or `partial` row against the holder's balance deltas and
not receipts; **`review.json` produced** by `H-postmortem.md`; and a human who approved the send in
conversation. A **pending-only** `review.json` satisfies this — empty `resolved[]`, every row in `pending[]`,
`./run/calibration.json` recomputed — because H runs weeks later and many of these markets are never answered
at all; demand scored resolutions and the gate becomes unsatisfiable, so it gets dropped instead.

### 2. The cadence parameters — declared here, consumed everywhere else

**This block is the declaration.** Nowhere else in this file, in the orchestrator, or in any step is the
cadence written as a number: everywhere else says **"the cadence"** and derives from it. The registration
snippets below *consume* these variables and declare none of their own.

```powershell
# ---------------- THE CADENCE PARAMETERS.  Edit HERE and nowhere else. ----------------
$CadenceHours        = 24       # DEFAULT — the full prepare-only wake: H(prior) → C → D → E → F → G §1–7.
$ScoutCadenceMinutes = 30       # OPTION, and NOT registered by default — see *Choosing the cadence*.
                                #   Read-only, zero model turns, therefore zero credits. It is not a
                                #   smaller cadence for the wake; it is a different, cheaper thing.
$WakeAt              = '09:07'  # UTC; convert to local time to register.  Not :00, not the naive arm's 09:17.
# 24 is a DEFAULT, not a finding.  It is a CREDIT BUDGET, not market timing: see *Choosing the cadence*
# for what one wake costs, what a shorter one buys, and what a longer one misses.
# Constraint: $CadenceHours must stay above the task's -ExecutionTimeLimit (2 h below).  Below it, a slow
# wake is still running when the next fires, and `IgnoreNew` drops that one.
# --------------------------------------------------------------------------------------
```

**Mirrors, not sources.** `schedule.cadence_hours` and `schedule.scout_cadence_minutes` in `./run/setup.json`
are written *after* registering so a reader can see what is actually installed. They are a record: editing
one changes no trigger.

**To change the cadence:** edit the block above, re-register the **one** trigger with the new value —
`Register-ScheduledTask … -Force`, `schtasks /Create … /F`, or `OnCalendar=` in the wake account's systemd
unit — then rewrite the mirror. The last two read no PowerShell variable, so there it means transcribing
the number out of this block. Nothing else anywhere needs editing.

| `$CadenceHours` | Windows trigger | `schtasks` |
|---|---|---|
| 1–23 | `-Once -At $WakeAt -RepetitionInterval (New-TimeSpan -Hours $CadenceHours)` | `/SC HOURLY /MO <hours>`, `/MO` **1–23** |
| 24 | `-Daily -At $WakeAt` | `/SC DAILY` |
| a multiple of 24 | `-Daily -At $WakeAt -DaysInterval ($CadenceHours / 24)` | `/SC DAILY /MO <days>`, `/MO` **1–365** |
| anything else (36) | no calendar trigger maps to it — take the 1–23 row's `-RepetitionInterval`, or pick a value that divides or multiplies 24 | — |

### 3. What one wake does, C through H, by filename

1. **`H-postmortem.md` first**, for *prior* run ids whose markets now read
   `payoutDenominator(conditionId) > 0` onchain. It spends and signs nothing, and going first is what lets
   this wake's D read a fresh `./run/calibration.json`. A redeem or merge it finds is **queued**, never sent.
2. **`C-select-markets.md`** — on an **unchanged** universe, §2's identification multicall (`outcomes`,
   `wrappedTokens`, `collateralToken`, `parentMarket`, `conditionId`) may be reused from the last wake's
   `candidates.json`. **§4 tradeability, §5 Swap logs and §7 depth never may** — readings of right now.
3. **`D-base-forecast.md` — never skipped, never reused.** The wake controller prepares the exact
   candidate/question/policy and forecast-calibration allowlists in
   `../reference/price-blind-worker.md`, then starts a new D worker with **no inherited history**.
   It sends no prior run, C commentary, full candidates, prices or other forecasts. D writes the normal
   `base-forecast.json`; contamination means discard and restart in another clean context, never lower `w`.
4. **`E-reconcile-price.md` and `F-allocate-capital.md` — the controller resumes, never reuses results.**
   Validate the clean D output first. Prices moved; `w` is scored fresh from candidate data and F quotes
   the fill at size. Never send those prices or controller conclusions back to the D worker.
5. **`G-execute-trade.md` §1–§7 only** — re-read state onchain, enumerate routes, quote, build the ordered
   call list, simulate the whole sequence — **then stop at §8.** No presenting, no waiting, no sending.
6. **A wake whose upstream step returns empty stops there and is a complete, correct wake**: C keeps nothing,
   or F opens no line, and "no trade" is an output. It still **writes its status marker** (§5), and writes
   **no `fills.json`** because it filled nothing — H reads a market with no fills row as a no-trade.

### 4. Run id per wake, and what carries over

One run id per wake, `<ISO date>-<contest-or-topic>`; **one run id is one book**. A catch-up wake firing on
the same calendar date must **append a counter** — `2026-09-30-deep-r3-w2` — or it overwrites the earlier
run's artifacts, and with only one catch-up available that is a real case. Carried between wakes:
**`./run/calibration.json`** (H writes it; the next D reads its `forecast` block only, never the
price-derived `blend` block); **`./run/setup.json`**; the previous wake's queued intent and status marker; and
**open positions, read onchain and never from files** — balances and nonce are the only records a crashed wake
cannot have failed to write. Not carried: anything price-derived, into D.

### 5. The unattended-approval problem, and the lock

`G-execute-trade.md` says **"Never send a transaction the human has not approved in this conversation"** and
**"A plan is not an approval."** A 3am wake has nobody to ask. Send-once, never-re-run and the spent-run-id
rule are the orchestrator's and bind here unchanged. This project's resolution:

- **QUEUE AND STOP — what the wake does.** C→F, simulate in G, write `allocation.json` and a queued
  ready-to-send intent, halt. Enforced **mechanically, not in prose**: `--permission-mode dontAsk
  --permission-prompts none`, so anything that would prompt is denied, the model is told nobody can approve
  and not to retry, and the run continues — fail-closed by construction. **The real gate is that the wake has
  no signer:** simulation needs only an address, so run it where the key cannot be reached — as the
  separate standard (non-admin) OS user at the head of I.2, never the operator's own account, whose
  processes can unlock the operator's key. A Bash deny rule is weak (a scoped rule denies only calls
  matching **as written**); key absence cannot be walked around.
  **Scope the wake's writes too** — `Write(./run/**)`, `Edit(./run/**)` — because a wake that can edit
  `G-execute-trade.md` or its own wrapper rewrites the path the *executor* later trusts.
- **SUPERVISED SENDS — what the executor does.** A separate human-triggered run takes the queued intent,
  re-verifies the signer against the address **the human states in conversation**, re-quotes on QuoterV2,
  re-reads `payoutReported` and `is_pending_arbitration`, then runs G §8. A newer queued plan **supersedes**
  an older unsent one, and the executor takes the same lock.
- **PRE-AUTHORISED BUDGET — named, not taken.** Blast radius is in I.1 §6. No cap bounds being wrong,
  slippage in a drained pool, or a market past the trading boundary; a dollar cap must be derived through
  `previewSwapExactIn`, so a wrong derivation mis-sizes silently (`1e12`) instead of erroring; child Invalid
  has no pool at any fee tier, so a position opened unattended can be **unexitable** until resolution; and
  anyone can answer a Reality question at minimum bond once `opening_ts` has passed. `--max-budget-usd` caps
  API spend, not trade size. **Never quietly grant the routine spend authority.**
- **The lock is the wrapper's, not the model's**, so a crash, a kill or a budget exit cannot leave a lock only
  the model knew about: take it before invoking `claude`, release it on every exit path, with
  **exclusive-create** semantics — `mkdir run\.lock` is atomic on NTFS, `flock -n run/.lock` on POSIX.
  `if exist … then write` is a race two wakes win together. Put
  `{pid, process_start_time, host, run_id, started_at, stage}` in a file *inside* it: PIDs are reused on
  Windows, so a start-time mismatch means stale. **Serialise signing on that lock** — two processes signing
  from one address produce a silent replacement or a revert. **A stale lock must be recoverable or the
  routine deadlocks:** when the execution time limit kills the task the cleanup never runs and every later
  wake skips and exits 2 (a failed run, not a green tick) until the lock is cleared, so a lock older than
  that limit is dead — remove it, log it, then read that run id's
  status marker and `inflight.json`.
- **Write-ahead, and a terminal marker.** Dying after a send but before `fills.json` leaves no local trace,
  so the executor writes `{run_id, from_address, nonce, calldata_hash, chain_id}` to
  `./run/<run-id>/inflight.json` immediately before broadcasting, and the next wake looks up that nonce
  (`calldata_hash` is the keccak256 of the exact transaction `input` that was signed, and the settlement rule is
  `../../deep-r3-trade/steps/G-mint-and-trade.md` §8 step 4). Every
  wake's last act writes `status: queued | sent | aborted | nothing-to-do` — without it the next wake cannot
  tell "nothing to do" from "died mid-run". Decide staleness from these artifacts, never from the clock.
- **Keep any watcher in its own task**, since a run stalled on an unanswered prompt counts as "previous run
  still in progress" and **skips later wakes** — one unanswered stall can cancel the wakes after it. And
  **verify the wake did something**: under `dontAsk` a missing allowlist entry gives a denied call and a clean
  **exit 0**, a silent no-op monitoring reads as success. Gate on evidence — the artifact exists, and
  `permission_denials` in the JSON result names only the send path.

## Worked example — registering the wake as the wake account

A **Desktop scheduled task** (Code tab → Routines → New routine → **Local**) is Claude Code's supported local
mechanism — no open session needed, permission-mode and model pickers, prompt editable on disk under
`~/.claude/scheduled-tasks/<name>/` — but it runs in the operator's own OS session, where the operator's key
store unlocks, so it **cannot meet I.2's separate-account rule and is not this wake's mechanism**. It also
runs only while the desktop app is up and the machine awake, a sleep through the time is **skipped**, and it
gives exactly **one** catch-up for the most recently missed time. **Footgun:** clicking *Run now* and picking
*always allow* for each prompt, on the send path, **permanently deletes the human gate**. **Cloud routines
(`/schedule`) are disqualified twice:** they run autonomously with no permission-mode picker, so the gate is
absent silently rather than bypassed noisily, and they work from a fresh clone of a GitHub repo, with no
access to local files. `/loop` is session-scoped and expires. The mechanism is the OS scheduler, **run as the
wake account**, in **two layers** — a wrapper owning the working directory and the lock, then the `claude`
call — and the wrapper is mandatory, not stylistic: Task Scheduler starts `cmd` in `System32`, and every
path in these skills is relative. The wrapper lives in the project root (the folder holding `./run/`) and
enters its own folder, so it carries no path; run the registration from the project root, so the wake uses
the same `./run/` as supervised sessions. Create and check the wake account first (I.2, *the wake account,
in plain words*); nothing below is registered until the human's check there has failed as it should.

```bat
@echo off
rem  wake.cmd, in the project root
cd /d "%~dp0" || exit /b 1
if not defined SEER_CLEAN_D_WORKER_TOOL_RULE exit /b 2
if not exist run mkdir run
rem stale lock: older than the registered -ExecutionTimeLimit (2h, the same number registered below) + 1h margin
powershell -NoProfile -Command "$l='run\.lock'; if ((Test-Path $l) -and (Get-Item $l).CreationTime -lt (Get-Date).AddHours(-(2 + 1))) { Remove-Item -Recurse -Force $l; Add-Content run\wake.log ('[' + (Get-Date).ToUniversalTime().ToString('o') + '] stale lock removed') }"
mkdir run\.lock 2>nul || (echo [%DATE% %TIME%] lock held, skipping>>run\wake.log & exit /b 2)
>run\.lock\owner.txt echo host=%COMPUTERNAME% started=%DATE% %TIME%
call claude -p "/seer-trade WAKE, PREPARE-ONLY. Universe and bankroll per ./run/setup.json. Run H for prior resolved run ids, then C through F using a fresh no-history D worker, then G sections 1-7 only. Simulate. Write ./run/<run-id>/allocation.json and a queued intent. DO NOT SEND: nobody can approve anything. Finish by writing the status marker." ^
  --add-dir . ^
  --permission-mode dontAsk --permission-prompts none ^
  --allowedTools "Read,Write(./run/**),Edit(./run/**),WebFetch,WebSearch,Bash(node -e *),%SEER_CLEAN_D_WORKER_TOOL_RULE%" ^
  --disallowedTools "mcp__*" ^
  --output-format json --max-budget-usd 5 >run\wake-out.json 2>>run\wake.log
set RC=%ERRORLEVEL%
rmdir /s /q run\.lock
exit /b %RC%
```

The skip branch exits **2**, not 0, so a stuck lock shows up as a failed run rather than a green tick. Before
the `mkdir`, the PowerShell age test clears a lock older than the registered `-ExecutionTimeLimit` plus a 1h
margin — its `2` and the registered `2` are one number, so change the age test's `2`, `-ExecutionTimeLimit`
and the task XML's `PT2H` together. Plain `schtasks /Create` has no execution-time-limit flag, so it does not
register the 2h the age test assumes; on that path set one before relying on the test (below). Keep the
`call` before `claude`: if `claude` is the npm `claude.cmd` shim, `call` is what brings control back so the `rmdir` and
`exit /b %RC%` run, which removes the lock on every exit path the wrapper reaches.

**Build the allowlist from the verified workflow, not from this example.** Before registering a wake,
set `SEER_CLEAN_D_WORKER_TOOL_RULE` to the actual supported non-MCP clean-worker tool or narrowly scoped
launcher rule established in the supervised pass. Confirm that it creates a genuinely no-history D
context and that the worker can use only the approved handoff and price-free resolution research.
An inherited-context task tool is insufficient. The parent runs the projections in
`../reference/price-blind-worker.md`; D no longer projects full files itself. Its resolution research
needs web access. Do not allowlist a nonexistent launcher or enable signing tools to make dispatch work;
if no verified clean-worker mechanism is available, stop before E and leave the wake unregistered.
Count worker costs inside the declared wake credit budget. Both runaway guards
exist in current builds (last verified on 2.1.285): `--max-budget-usd` caps API spend, `--max-turns` caps
agentic turns — it is registered but **hidden from `--help`**, so confirm it in the binary rather than by
reading the help text. Neither caps trade size. Before registering on any OS, check `claude --version`
(`--permission-prompts none` needs v2.1.259 or later and aborts on older builds rather than being ignored).

```powershell
$Root = (Get-Location).Path      # run from the project root; never a typed path
# $CadenceHours and $WakeAt come from I.2 §2.  Paste that block first; this declares neither.
if (-not $CadenceHours) { throw 'paste the cadence parameter block from I.2 §2 first' }
$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$Root\wake.cmd`"" -WorkingDirectory $Root
$t = if ($CadenceHours -lt 24) { New-ScheduledTaskTrigger -Once -At $WakeAt `
                                   -RepetitionInterval (New-TimeSpan -Hours $CadenceHours) }
     elseif ($CadenceHours % 24 -eq 0) { New-ScheduledTaskTrigger -Daily -At $WakeAt `
                                           -DaysInterval ($CadenceHours / 24) }
     else { throw "$CadenceHours h maps to no calendar trigger - see the table in I.2 section 2" }
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -WakeToRun `
       -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$c = Get-Credential '<wake-account>'   # the human types the wake account's password, never the agent
Register-ScheduledTask -TaskName 'seer-trade-wake' -Action $a -Trigger $t -Settings $s -Force `
  -User $c.UserName -Password $c.GetNetworkCredential().Password
```

`-StartWhenAvailable` is the catch-up; `-ExecutionTimeLimit` stops a hung wake holding the lock and is the
number the stale-lock rule reads. Plain `schtasks` **cannot set the overlap policy** — its `/Create` help
exposes no `MultipleInstances` flag, verified — so the wrapper's lock is what prevents overlap. Nor has it an
execution-time-limit flag, so it does not register the 2h the stale-lock test assumes: on the `schtasks`
path, register through the cmdlet above, or set `ExecutionTimeLimit` to `PT2H` in the task XML (`/Query
/XML`, edit, re-create with `schtasks /Create /TN "seer-trade-wake" /XML <file> /RU <wake-account> /RP * /F`),
and confirm it with `schtasks /Query /TN "seer-trade-wake" /XML` before relying on the wrapper's age test. `/SC DAILY
/ST 09:07` below is **I.2 §2's default spelled out**; for any other value substitute that table's row:

```
schtasks /Create /TN "seer-trade-wake" /SC DAILY /ST 09:07 /RL LIMITED /RU <wake-account> /RP * /F /TR "cmd /c \"%CD%\wake.cmd\""
#                                      ^^^^^^^^^^^^^^^^^^  $CadenceHours = 24 and $WakeAt, transcribed
schtasks /Query /TN "seer-trade-wake" /XML   # read MultipleInstancesPolicy and ExecutionTimeLimit.  Then /Run once and check the
schtasks /Run   /TN "seer-trade-wake"        # artifact and permission_denials.  /Delete … /F removes it
```

Run `schtasks` from a cmd prompt in the project root: `/TR` is built from `%CD%`. `/RL LIMITED`, never
`/RL HIGHEST`. **`/RU <wake-account>` stores that account's password in Task Scheduler** (`/RP *` prompts the
human for it; the cmdlet snippet passes `-User`/`-Password` the same way) — drop them and the task runs as
the operator, which I.2 forbids. That is the tradeoff: a stored password for a standard, non-admin account
that reaches the project folder only, in exchange for a wake that cannot unlock the key. **`$WakeAt` is
meant as UTC, but `/ST` and `-At` take the machine's local time** — check the machine's timezone and convert
before registering, or the two diverge silently. A headless `claude` needs a credential the **human** places
in the wake account's own environment. POSIX equivalent: a **systemd user timer** in the wake account
(`OnCalendar=`, `Persistent=true`, `WorkingDirectory=`, `RuntimeMaxSec=`) with `flock -n run/.lock` in the
`ExecStart` wrapper —
`Persistent=true` is the analogue of `-StartWhenAvailable`, which plain cron has no equivalent for. On a
headless Linux box `loginctl enable-linger <wake-account>` lets that user's timer fire with nobody logged in.
**macOS:** a **launchd** job for the wake account — a LaunchDaemon (an administrator installs it) with
`UserName` set to `<wake-account>`, `WorkingDirectory` set to the project folder and `StartCalendarInterval` for
`$WakeAt` in local time; a LaunchAgent runs only while that user is logged in. macOS ships no `flock`, so the
wrapper takes the lock with `mkdir run/.lock`, which is atomic there too.

## Choosing the cadence — it is a credit budget, not market timing

**Why there is a cadence at all: every wake is a full LLM run, and the bill scales with how often you wake.**
Nothing about the default reads a market better than half of it or triple it would. It is the frequency the
human is willing to pay for, so choose it the way you choose any spend cap — and re-choose it once you have
measured a real wake.

**The arithmetic.** `wakes_per_year = 8760 / $CadenceHours`, times what one wake costs. The only figure this
project has fixed is the **ceiling**: `wake.cmd` passes `--max-budget-usd 5`, which caps a wake's API spend
and is not an estimate of it.

| `$CadenceHours` | wakes/yr | ceiling at $5 | looks per 84 h window | what the money buys |
|---|---|---|---|---|
| 12 | 730 | $3,650 | ~7 | two looks a day at liquidity, answers and redemptions — at double the bill |
| **24 — the default** | 365 | $1,825 | ~3 | one look a day; the fewest wakes that still see an 84 h window more than once |
| 72 | 122 | $610 | ~1 | one look per window *if nothing slips*, and something usually slips |
| 168 | 52 | $260 | ~0.5 | **an answer window can open and time out entirely between two wakes** |

**Measure, then re-choose.** `--output-format json` writes the run's cost into `run/wake-out.json` — the
`total_cost_usd` field in the builds checked so far, but read it out of the first wake's own output rather than
trusting this line. After three or four wakes you have a real per-wake number; put it where the $5 is and pick again. A
wake over a handful of markets that mostly finds nothing costs far less than the ceiling; one researching
forty fresh candidates approaches it.

**What the bill has to beat — and this is why bankroll decides the value.** EV saturates at **pool depth,
not at bankroll**: the one measured book in the orchestrator's *Hard rules* carried **+$18.77** of EV at
quarter-Kelly (EV-maximising +$23.14) on $1,000, and forcing the full amount in produced an expected **loss**.
So the edge a wake can find is bounded by thin pools, while the credit bill is bounded only by how often you
wake. **A wake that costs more than the edge it finds is a loss — and it is a loss you pay again every
cadence, whether or not it trades.** On a small bankroll the daily default can cost more per year than the
book can make, and the honest configurations are a long cadence, or the scout below with a full wake
triggered **by hand** when it alerts. On a bankroll where one wake's edge dwarfs a few dollars of credits,
shorten it and buy the extra looks.

### What a longer cadence misses

Caveats to price into the value you choose, not an argument for any particular one.

- **Badly — intraday pool liquidity.** Fee-tier-100 pools are thin and depth drains and returns inside hours,
  so a once-per-cadence snapshot is worthless, not merely stale. **Never size from the wake's quote.** Depth
  that drained and came back between two wakes is a window you never saw at all — a shorter cadence sees more
  of them and the scout's liveness read sees them at zero credits, but either way you size from a send-time
  quote and never from the wake's.
- **Badly — the trading boundary.** `payoutReported` and `is_pending_arbitration` can flip between the wake
  and the approval, and the pipeline forbids trading past either. Re-read both at send time.
- **A close date landing between two wakes**, and the redeem-vs-merge decision after it.
- **Just barely at the default — the Reality answer window.** The 84 h timeout (`C-select-markets.md` §8 and
  §10) gives `84 / $CadenceHours` looks at a premature answer — ~3 at the default, ~0.5 at a weekly one —
  and fewer in practice: one catch-up after a sleep, a stall skips later wakes, and escalation needs a
  doubling bond — the human approval a wake does not have.
  **A wake can detect a premature answer but cannot respond to one.**
- **Low urgency, but not zero — redemption.** Nothing races: 65 of Round 2's 98 children were still open with
  bond 0 three months on. What a long cadence actually costs here is idle capital — collateral that became
  redeemable on Monday and is noticed on the following Monday is a week of bankroll doing nothing.

### OPTION — the scout, on its own cadence and at zero credits

**An option with its own default, not the new cadence.** Registering it changes `$CadenceHours` not at all.
The point is that most of what a wake would notice is a **diff over flat chain fields**, which needs no model:

- One `MarketView.getMarket` multicall (`allowFailure: false` — a partial answer reads as nothing to redeem
  and silently drops rows) over the set, diffing `payoutReported`, `payoutNumerators` and the flat Reality
  fields against the last snapshot.
- Plus the two reads that answer *is anything redeemable* and *has liquidity come back*:
  `payoutDenominator(conditionId) > 0`, and preflight line 23's `getPool(t0,t1,100) != 0x0 AND liquidity()
  != 0`. That second one is **liveness, not depth** — a live pool can still be far too thin to fill, so depth
  at size stays a quote at send time and is never a scout reading.
- Silent on no change. It alerts on a new answer, arbitration flipping, `payoutReported` flipping, a pool
  going live or dark, or a `finalize_ts` **inside the next `$CadenceHours`** — that horizon is the cadence
  itself, because anything finalising sooner than the next full wake is something no wake will see in time.
- **One RPC round trip, zero model tokens and therefore zero credits**, which is what makes a 30-minute
  default affordable when a 30-minute *wake* would be absurd. It holds no key, signs nothing, queues nothing
  and writes only its own snapshot: it reads and it alerts. Never more than `$ScoutCadenceMinutes` blind.

```
rem  OPTION — not registered by default.  $ScoutCadenceMinutes is declared in I.2 §2.
schtasks /Create /TN "seer-trade-scout" /SC MINUTE /MO 30 /RL LIMITED /RU <wake-account> /RP * /F /TR "cmd /c <read-only script>"
rem                                                   ^^  $ScoutCadenceMinutes.  /MO is 1-1439, verified
```

Its **own** task, never folded into `wake.cmd`, and it takes **no lock**: it writes nothing a wake writes, so
it cannot collide, and a scout that blocked on a held lock would go quiet exactly while a wake ran long.
**Turning the scout on is a reason to lengthen `$CadenceHours`, not to shorten it** — it covers the cheap half
of what a wake looks at, so the expensive half can run less often. And if you would rather a model read that
diff than a script, that is a wake with a small budget running at scout frequency: at 30 minutes, 17,520 runs
a year, which is the configuration this whole section exists to talk you out of.

## Hard rules

- **The agent never sees the secret.** Verify **by address** against what the human said in conversation,
  print only the address, **stop on a mismatch**, never print an environment variable. Say why: what you read
  enters a transcript and goes to a provider.
- **Chain first, balances second, `decimals()` per token.** USDC is 6; `1e12` either way is the classic loss.
- **Never print a dollar figure derived from 1 sUSDS = $1**, from `convertToAssetValue`, or from ERC-4626.
- **Never a `minAmountOut` of 0**, and gate every PSM3 leg on `assetOut.balanceOf(PSM3) >= amountOut`.
- **I.1's conversion is a send** — present, explicit yes, once, reconcile by balance delta.
- **No schedule before `first_successful_run` is written.** A green supervised pass is the precondition.
- **The scheduled run is optional, and only as a separate standard (non-admin) OS user that cannot reach
  the key — never under the operator's own account.** Without that account, or before the human has checked
  once, from it, that unlocking the key fails (I.2), do not schedule; run manually.
- **The wake never sends and never holds spend authority**, its writes are scoped to `./run/**`, and nothing
  on the send path is ever always-allowed.
- **The wrapper owns the lock, one wake at a time, and every wake writes a status marker.**
- **The cadence is one declared parameter** — I.2 §2's block. Registration consumes it, `setup.json` mirrors
  it, nothing else states a number of hours. It is a **credit budget**: shorter costs proportionally more per
  year, longer is cheaper and misses more. Changing it is edit-the-block, re-register, rewrite the mirror.
- **This step writes no forecast and opens no position.**

## Output — `./run/setup.json`

**Addresses and public chain state only** — no key material, keystore path or environment variable. This
is a record, not an authority: compare identity to the conversation anchor described in I.1 §1. Write an
`onboarding` block while setup is incomplete, preserve unknown checks as `null`/unverified, and leave
`first_successful_run` and `schedule.created_at` null until their actual gates pass. The example below
shows a completed preflight, not default values to copy after creating a wallet.

```jsonc
{ "schema": "seer-setup/1", "generated_at": "<ISO 8601>", "verified_at_block": 157552977,
  "onboarding": { "status": "ready", "address_source": "human-selected|created-and-announced",
                  "signing_verified_at": "<ISO>|null", "next_action": null,
                  "funding": { "gas": "sufficient", "collateral": "available" },
                  "permission": { "scope": "<authorized tests or trading request>",
                                  "limit": "<amount and unit or deposited test balance>", "chain_id": 10 } },
  "chain": { "id": 10, "rpc": "https://mainnet.optimism.io", "psm3_getters_match": true },
  "verified": ["chain_id", "block_advances", "psm3_getters", "signer_address", "holder_address",
               "token_decimals", "contracts_live", "pools_live", "allowances", "simulation"],
  "addresses": { "signer": "0x…", "expected_signer": "0x…", "signer_match": true, "holder": "0x…",
                 "executor_owner": "0x…|null",                       // both addresses, per I.1 §6:
                 "executor_current": "0x…|null", "executor_legacy": "0x…|null" },
  "signer_mode": "local-encrypted-eoa|eip7702|executor-session-key|other-agent-signer",
  "atomic_batches": true,                       // false => sequential mode (I.1 §6), never a blocker
  "collateral": { "symbol": "sUSDS", "address": "0xb5b2dc7f…29e0", "decimals": 18,
                  "reason": "what every market in scope settles in on chain 10" },
  "balances_at_setup": { "eth_wei_at_signer": "…", "usdc_raw_6dp_at_holder": "…",
                         "usds_raw_18dp_at_holder": "…", "susds_raw_18dp_at_holder": "…" },
  "collateral_value": { "susds_raw": "…", "usd_per_susds": "1.111189610534094",
                        "source": "PSM3.previewSwapExactIn(sUSDS, USDS, 1e18)", "read_at": "<ISO>" },
  "conversions": [ { "asset_in": "USDC", "amount_in_raw": "1000000000", "quote_raw": "8999371400…",
                     "min_amount_out_raw": "…", "receiver": "0x…", "tx_hash": "0x…",
                     "balance_delta_raw": "…" } ],
  "universe": "<what a wake may trade>",
  "bankroll": { "amount": 0, "unit": "sUSDS", "scope": "per-wake|whole-book" },
  "preflight": { "all_pass": true, "failed": [] },
  "first_successful_run": { "run_id": "…", "artifacts_complete": true,
                            "fills_reconciled_onchain": true, "review_json": "pending-only|scored",
                            "human_approved_at": "<ISO>" },   // null until then; gates `schedule`
  "schedule": { "cadence_hours": 24,          // MIRROR of I.2 §2's $CadenceHours (default 24), never the
                                              // source — editing it here re-registers nothing
                "cost_usd_per_wake": null,          // measured from run/wake-out.json; null until wakes ran
                "scout_cadence_minutes": null,      // null = not registered; else $ScoutCadenceMinutes
                "mechanism": "windows-scheduled-task|systemd-timer|launchd",
                "task_name": "seer-trade-wake", "at": "09:07", "timezone": "UTC",
                "mode": "prepare-only", "signer_reachable_from_wake": false,
                "lock": "./run/.lock", "created_at": "<ISO>|null" },
  "notes": ["<what a human must know to change this safely>"] }
```

`schedule.created_at` stays `null` until `first_successful_run` is complete — that field **is** the gate, so a
consumer checks it instead of trusting prose. `signer_reachable_from_wake` must be `false`, and is written only
after the human's one check from the wake account (I.2, *the wake account, in plain words*) has failed as it
should: the record that queue-and-stop is real and not merely intended.

> **Last verified:** 2026-09-30 against `https://mainnet.optimism.io` — chain id, PSM3's three getters,
> `decimals()`/`symbol()` on all three tokens, one `aggregate3`, the USDC→sUSDS and sUSDS→USDS rates and their
> linearity at 1,000×, the drift series, PSM3's inventory, and both sUSDS ERC-4626 reverts. Claude Code
> flags, last checked 2026-09-30 on 2.1.285: `--permission-mode dontAsk`, `--permission-prompts none`,
> `--allowedTools`, `--disallowedTools`, `--output-format json`, `--max-budget-usd` and `--max-turns` (the last
> is accepted but hidden from `--help`); `--permission-prompts none` needs v2.1.259 or later. The `schtasks`
> and `New-ScheduledTaskTrigger` limits (`HOURLY /MO` 1–23, `DAILY /MO` 1–365, `MINUTE /MO` 1–1439, no
> `MultipleInstances` flag; `-DaysInterval` on `-Daily`, `-RepetitionInterval` on `-Once`) are Task Scheduler
> facts behind I.2 §2's trigger table — confirm them with `schtasks /Create /?` and
> `Get-Help New-ScheduledTaskTrigger`. Re-read before funding: `l1BaseFee()`, `balanceOf(PSM3)`, and the
> sUSDS→USDS rate.
