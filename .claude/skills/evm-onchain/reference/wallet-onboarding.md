# Wallet onboarding shared by both Seer arms

Read this when the human asks to create, connect, fund, check or resume a wallet, or when an authorized
trading request needs I.1. Wallet-only setup needs no market universe, forecast CSV or trading bankroll.
I.1 owns each arm's setup record; this reference owns the common intake and funding conversation.

## Create or reuse without exposing credentials

Honor a wallet or signer the human already selected. If they ask the agent to set up a dedicated wallet
on Windows, the preferred implementation is the repository's local encrypted EOA signer (the `wallet:*`
tooling), where the checkout ships it. The request authorizes running its setup; do not hand the human a
key-import tutorial or ask them to repeat permission already given. For another OS or network, use an
available signer for that environment rather than run this Windows/Optimism implementation blindly.

Run commands from the repository root. Read [the tool guide](../../../../tools/README.md) for command
details. The pinned dependency is installed with `npm ci --ignore-scripts --no-fund` if missing; Foundry
is not required for this implementation. Use the environment's normal permission mechanism for network
access or the outside-project credential directory. Do not weaken global permissions to make it run.

1. Check `npm run wallet:info`. `run/wallet.json` is public metadata and is safe to read. Reuse its address
   when it matches the wallet already selected or announced in this conversation. Do not treat every
   command failure as a missing wallet: a mismatch, invalid configuration or inaccessible stored wallet
   requires diagnosis, not a replacement.
2. If no wallet exists and setup is authorized, run `npm run wallet:create`. The signer process generates
   the key, stores an encrypted JSON keystore, and seals a random unlock credential with Windows DPAPI.
   It prints only public details. It also reuses an existing wallet and refuses incomplete storage.
   Never delete or rotate storage to solve an install, RPC, decryption or funding problem.
3. Run `npm run wallet:verify` in a fresh process. Require both message and transaction signing checks
   to pass. They recover the saved signer's address and broadcast nothing. This proves possession,
   not successful onchain execution or atomic batch support.
4. Run `npm run wallet:status`. It reads public Optimism state: chain ID, block, PSM3 token getters,
   token metadata, ETH and USDC/USDS/sUSDS balances. Its `signingVerification.observed: false` means
   this read-only command did not unlock the wallet; use step 3's result for signing verification.
   `wallet:balance` remains an ETH-only shortcut.
5. Write the actual milestone and next action into this arm's setup record, then give the human the
   verified funding address and network. No send or schedule is part of these steps.

Keep a public identity anchor: for an agent-created wallet, the successfully recovered address announced
to the human in this conversation is the expected address. Do not demand that they type it back. For a
human-selected wallet, compare against the public address they supplied. A new address in a local file
does not replace that anchor. A new conversation without a trusted address anchor asks for confirmation
of the public address, never a key. Read signer and holder separately for executor-backed wallets.

The model never reads a key, keystore contents or unlock credential; only the signing process may consume
them. Never put credentials in chat, command arguments, an environment dump, source or logs. Explain this
once when intake is needed: chat and tool output enter the model transcript. Creation inside a process
that suppresses credentials is permitted; printing or constructing key material in the conversation is not.
Existing signers that need no human action per transaction (an EIP-7702 delegated EOA, a TradeExecutor
session key or another agent signing backend) remain in use through G's interface and their established
local intake. Browser and hardware wallets that need a human confirmation per transaction cannot trade;
they may still sign one-off human actions, such as an owner granting a session key. In each case the
public address is the information needed in chat.

DPAPI protects storage under the Windows account, not against processes running as that account. Other
accounts cannot normally unlock it; moving the files without the original Windows profile is not a
portable recovery plan. In plain words: supervised runs, where the human approves each batch in the
session, need nothing special. The unattended scheduled run is optional. Any program running as the same
OS user can use a non-interactive wallet, so seer-trade's prepare-only wake must run as a separate standard
(non-admin) OS user that cannot reach the key; its I.2 signer-isolation checks apply. If the operator does
not set that up, do not schedule it: run the pipeline manually when wanted. Never schedule that wake under
the operator's own account, and in every signer mode it holds no signer. deep-r3-trade's scheduled run
instead trades autonomously every day once its setup is complete (the operator's explicit consent asked
at setup, the signer self-test passed and the setup run's no-send clearance; no supervised trading run); it may run under the operator's own
account and signs only through the signing process, never by reading the key. Autonomous R3 needs an
operator-supplied signer (the reference `signer.cjs` in [deep-r3-trade's `scripts/`](../../deep-r3-trade/scripts/signer.README.md) is one) that enforces deep-r3-trade's scope-only allowlist (what may be signed, never how
much or how often) and has passed its allowlist self-test: a policy check, not a simulation, where every
off-allowlist case gets a distinct refusal before any RPC call (through a separate `check` entry point, except
a final mode-switch attempt through `send` itself), one allowlisted call is accepted, and a revert or RPC error
counts as a fail (see I.1 section 7 in [deep-r3-trade's setup step](../../deep-r3-trade/steps/I-setup.md));
otherwise autonomous mode stays off.

## Give one clear funding handoff

State **Optimism mainnet, chain ID 10**, and print checksummed addresses. An EOA address can receive
funds on Ethereum mainnet and other EVM networks, but balances are separate and this local signing tool
currently operates on Optimism only. Mainnet ETH does not pay Optimism gas. Do not bridge or change the
configured network as an incidental part of wallet setup.

Give a compact table with what to send, where, current balance and the remaining need:

- **ETH for gas goes to the signer.** Both trading preflights currently check the signer's balance
  against a 0.002 ETH reserve (the R3 arm also checks the signer's own up-front fee requirement for each
  group, which grows with the gas price: [its *Affordability* rule](../../deep-r3-trade/steps/G-mint-and-trade.md)).
  That is the floor the preflight stays above, not a recommended amount:
  ask the human to fund toward 0.005 ETH for a full run. Label the 0.002 ETH as the trading reserve,
  not the cost of creating the wallet or a guarantee of total fees. A separately authorized small
  wallet test uses its own live fee estimate; Optimism L1 data and operator fees are additional to
  execution gas.
- **Trading collateral goes to the verified holder.** Prefer sUSDS, or USDC/USDS followed by the
  arm's PSM3 conversion step. ETH-only funding does not make the trading bankroll available.
  A conversion is a real send and still needs applicable authorization, fresh quotes and simulation.
- For this local EOA, signer and holder are initially the same. For an atomic executor they can differ.
  Verify the executor and its holder before requesting collateral funding; never use an owner or session
  address as the collateral destination just because it appeared first. Actual A/B holders stay distinct.

An empty wallet is **needs-funding**, not failed setup. Give the address immediately after signing and
network checks; never generate a second wallet because the first has no funds. A verified local EOA is
its own holder and may trade in sequential mode, so its address is the collateral destination. If the
human is moving to an executor or session key, say "Wallet verified; executor holder not yet verified"
and defer that collateral funding address until the holder is verified. Do not ask the human to fund a
run to an unready holder.

When the human says "funded" or resumes later, re-read balances and continue from the saved milestone.
Reuse the wallet and previous permissions. If funds are absent, report what is missing on this network;
do not assume the transfer failed, invent balances, or monitor indefinitely. Check another network only
when the human says they funded it there. An RPC error means **unknown**, never a balance of zero.

## Record readiness as separate facts

Add an `onboarding` block to `run/setup.json` or `run/setup.deep-r3-trade.json`. These are local bookkeeping,
not additions to the six handoff artifact shapes. Record only public facts: expected address and its
conversation source, signer/holder, signing verification time, observed balances/block, signer capability,
applicable spending permission and the next action. Credential paths remain in `run/wallet.json`, not the
arm's setup record. Do not put this installation's wallet address into reusable skill instructions.

| Status | Meaning and next step |
|---|---|
| `needs-wallet` | Select an existing signer or create one under the setup request. |
| `needs-verification` | Offline possession or chain checks have not passed; diagnose without rotation. |
| `needs-executor` | Information only: signing works, atomic batches are unavailable, so G runs keep-whole groups in sequential mode. Never a blocker for trading; an atomic backend (EIP-7702 recommended) is optional. |
| `needs-funding` | Required gas or collateral is missing; give verified addresses and asset/network details. |
| `needs-conversion` | USDC/USDS is available; quote and simulate the authorized PSM3 ramp. |
| `needs-preflight` | Identity, capability and funding are established; finish I.1's route-specific checks. |
| `ready` | I.1's actual required checks passed for the chosen arm/route. This authorizes no new spend. |

Funding, signing and capability may each have independent missing items; the status names the next action,
and the block retains all three facts. Record `signer_mode` as `local-encrypted-eoa`, `eip7702`,
`executor-session-key` or `other-agent-signer`, with `atomic_batches` true or false as verified; a local
EOA is `signer_mode: "local-encrypted-eoa"` with `atomic_batches: false`. Browser and hardware wallets
are not trading modes. Either arm may trade on a non-atomic signer through G's interface: G runs each
keep-whole group as an ordered sequence of single transactions (sequential mode). In supervised mode
this is under the same per-batch approval: if any transaction fails, reverts or would breach its floor,
G stops sending, reconciles from chain state and presents a recovery batch (complete the group at fresh
quotes or unwind what landed) for its own explicit "yes". In deep-r3-trade's autonomous mode G instead
applies its deterministic recovery rule (re-quote; complete the group if its floors clear, otherwise
unwind what landed; log it, same run-id) with no "yes". Tell the human plainly that such a group can be
left half-done between transactions; EIP-7702 is recommended because its atomic batches remove that risk. Calling
`wallet:send` repeatedly does not create an atomic batch; never record it as one.

**Identity transition to an atomic backend** (optional; EIP-7702 recommended). The local EOA signer has
no bundled executor/delegation setup command. Follow the selected arm's signer-choice section to reuse an
existing backend or prepare concrete setup calls for a newly requested one. Keep `atomic_batches: false`
(sequential mode) until the adapter and onchain atomic capability have actually been verified, and state
this limitation before collateral funding, not after.

An authorized session-key setup establishes three public roles: the existing EOA remains the **owner**,
the process-generated session address becomes the **signer/gas payer**, and the verified executor becomes
the **holder**. Announce those verified roles and retain the old owner anchor alongside the newly
announced session/holder anchors in this arm's setup record. Do not compare a session key to the owner's
address, silently accept addresses from a changed file, or discard the original wallet. Renewal or
replacement of a session gets the same authorized transition. Under EIP-7702, the address remains the
EOA but delegated code and atomic call behavior are new facts to verify. After either transition, use
the backend's public balance and possession checks; `wallet:status` continues to describe only the
original local EOA, not the executor's holder or session signer.

During onboarding, retain `schedule.created_at: null` (and, for seer-trade, `first_successful_run: null`;
deep-r3-trade no longer writes or reads that field), unknown fields as
`null`, and preflight checks that have not run as unverified. A successful wallet signature or incoming
deposit cannot populate a successful trading run. Preserve any real prior run/schedule history when
resuming; never replace a finished setup with the illustrative all-passed JSON example.

Keep user authorization concrete: operation/test scope, wallet, network, amount/unit or deposited-balance
bound, and fees. Existing explicit bounded test permission remains valid for that scope; do not demand
the same permission again. Willingness to lose a wallet's balance alone is not approval for unrelated
trades, automatic conversion, delegation, deployment or recurring spending. Ordinary trading approvals
remain in G. seer-trade's I.2 remains prepare-only and explicitly requested after a successful supervised
run; deep-r3-trade asks at setup, and its I.2 trades autonomously only after the operator's explicit
consent, the signer self-test passed and the setup run's no-send clearance (no supervised trading run).
