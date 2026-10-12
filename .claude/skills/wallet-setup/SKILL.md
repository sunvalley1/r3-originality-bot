---
name: wallet-setup
description: Create or reuse an encrypted EVM wallet in the working repository for PaysForItself onboarding, return its public funding address, and continue with category A if funding is declined or absent. Also verify the selected network, signer readiness and authority for funded agent tasks.
---

# Wallet setup for agent work

Give the user a working local signer and one clear funding instruction. A wallet address alone is not spending access. Never ask for a private key, recovery phrase or password in chat. Create or reuse credentials inside a local signing backend and return public readiness facts.

## Automatic onboarding and unfunded work

A PaysForItself earnings/onboarding request includes creating a local wallet when the working repository
has none. Inspect its public wallet record and configured backend first; reuse a valid existing wallet.
If absent, create the encrypted wallet below without asking the user to supply or create one. Keep the
public record at `run/wallet.json` in that repository and credentials in the backend's protected storage.
An empty balance or a new conversation is not a reason to replace a wallet. An inaccessible or inconsistent
record needs diagnosis, not silent replacement. If the user has explicitly prohibited wallet creation,
honor that instruction and continue with work that does not need it.

After verification, give the actual public address and offer funding as an option. For a selected funded
task, state its verified network, gas asset, holder and current required amount; never imply that funds on
one EVM chain pay fees on another. If no funded task is selected, give the EVM address without inventing
a deposit amount or claiming trading readiness. A payout-only address can remain empty.

**Funding is not a gate for useful work.** If the user declines, postpones or has not funded the wallet,
start or continue an eligible section A task immediately while preserving the same wallet for later.
Do not wait indefinitely, repeatedly ask for money, or spend on B/C while unfunded. Recheck balances when
the user says funds arrived. Respect an explicit task/risk-range restriction: if it excludes A, prepare
the permitted task locally and explain the funding dependency rather than taking an excluded task.

For Thelyson, the agent-created wallet can supply the public Ethereum payout address when the user has
not supplied an email; no funding or transaction is required for entry. Use it only as the intended payout
recipient under the user's submission scope, leave email blank, and follow the [entry skill](../thelyson-prize/SKILL.md).

## Start from the task

Read the active task skill before choosing its chain, contract or asset:

| Task | Route | Wallet implication |
| --- | --- | --- |
| Thelyson / emptywallet | [thelyson-prize](../thelyson-prize/SKILL.md) | No funded wallet is needed for entry. Create/reuse an empty payout EOA during onboarding; email is optional when that payout address is used. Verify payout network/asset before award. |
| Proof of Humanity | [poh-challenge](../poh-challenge/SKILL.md) | Ethereum 1 and Gnosis 100 are different deployments; verify the chosen registry and gas/deposit asset. |
| Curate / registrynetwork | [curate-challenge](../curate-challenge/SKILL.md) | Resolve the registry deployment before suggesting a funding network or deposit. |
| Seer | [seer-trade](../seer-trade/SKILL.md), [deep-r3-trade](../deep-r3-trade/SKILL.md) | Optimism 10; local signer gas and the selected arm's verified collateral holder are separate decisions. |

The same EOA key derives the same public address on these EVM networks. Balances, nonces, approvals, contracts and gas are network specific. ETH deposited on Optimism does not fund Ethereum. Gnosis gas is native xDAI, not ETH or wrapped xDAI. Verify `eth_chainId` against the intended chain before displaying a balance or sending.

## Choose a backend and reuse first

1. Inspect public wallet records and the active backend's documented capabilities. Do not open credential-bearing files with a file viewer, shell print command or model tool.
2. Reuse a dedicated signer when its public address and backend are appropriate. A pre-existing `run/wallet.json` from this repository can be used by the companion below without copying or rotating its key. Its older `tools/wallet.cjs` sender is Optimism-only; an offline signature does not prove that sender can use mainnet or Gnosis.
3. On Windows, use the bundled [signing helper](scripts/wallet.cjs) with [DPAPI protection](scripts/wallet-protection.ps1). Download both together, plus [package.json](scripts/package.json), into a local folder. Install that folder's pinned dependency with `npm install --ignore-scripts --prefix <helper-folder>`. Existing repository `node_modules` also supplies the dependency.
4. On another OS, reuse an available documented agent signing backend, or create a wallet through an encrypted keystore and the OS credential store inside a local process. Verify it can actually sign the selected chain's transactions, recover the signer by address and keep secret inputs out of model-visible output. Do not ask the user to provide a wallet as a substitute for creation. The bundled DPAPI backend honestly reports unsupported; it does not create a plaintext fallback. If no usable protected backend exists, state that wallet setup is incomplete and continue eligible section A work without waiting or claiming an address was created.

From the task's local working directory:

```text
node <helper-folder>/wallet.cjs create
node <helper-folder>/wallet.cjs info
```

`create` is idempotent with a valid public record. It uses a random wallet/password, an encrypted JSON keystore and Windows CurrentUser DPAPI; secret material stays inside the helper process and private pipes. It refuses orphaned credential storage rather than overwriting a wallet. Default public record: `run/wallet.json`; optional second argument selects another public-record path. New credentials live outside the task checkout under the user's `.foundry/agent-wallet` directory. Keep the public record local too: its storage paths are not website content.

## Verify and give one funding checkpoint

Create a public chain request JSON as described in [the request and mandate schema](references/requests.md). It includes the explicit `chainId`, HTTPS `rpcUrl` and optional `walletConfig` path; no secret values.

```text
node <helper-folder>/wallet.cjs verify run/chain-request.json
node <helper-folder>/wallet.cjs balance run/chain-request.json
```

`verify` performs offline message and selected-chain transaction signature recovery. It broadcasts nothing and does not claim RPC connectivity or available funds. `balance` verifies the RPC chain, reads a block and native balance, and checks that the configured address is an EOA; it never unlocks. Zero is a normal funding checkpoint. A failed RPC is unknown, not zero.

Return the actual public address, chain name and ID, native gas asset, separately verified deposit/collateral destination, and what remains incomplete. For example: "Signer verified offline for Gnosis 100; RPC chain verified; native xDAI balance is zero. You can fund this address with xDAI for the verified task. Meanwhile I am starting section A work." Never publish a repository maintainer's address as someone else's funding address.

Choose the amount from a fresh task simulation and the user's loss budget. Avoid a universal mainnet gas amount. For Seer, its I.1 recommends 0.002–0.005 ETH gas headroom on Optimism; confirm the current guidance and fees. Fund trading collateral to the holder I.1 verifies; a verified local EOA is its own holder and trades in sequential mode (EIP-7702 recommended for atomic batches).

## Record authority, then execute within it

Record the trusted user's mandate locally before spending: authorized chains/tasks, expiry, allowed recipients, transaction count, cumulative native spend/fee/value/deposit/loss limits, and token spend/deposit/loss/approval limits in raw units. Keep the user's authorization source, exact scope and holder constraints. [Schema and examples](references/requests.md) explain what the helper enforces and what must be checked semantically by the agent.

Honor already explicit delegated scope. Do not ask again for each action that fits it. "I accept losing the funded amount" sets a loss tolerance; it does not choose a task, chain, recipient, unlimited approval, bridge or indefinite automation. Ask only for a missing material boundary or an action outside the recorded scope, after preparing the concrete plan.

For one reviewed action, encode a plan with the exact chain, sender, recipient, calldata, native value, nonce, gas limit and gas price, plus the mandate digest and decoded exposure. Refresh balances, allowances, deployment code and task state; review token operations and deposits against the task ABI, not calldata labels supplied by a website.

```text
node <helper-folder>/wallet.cjs simulate run/transaction-plan.json
node <helper-folder>/wallet.cjs send run/transaction-plan.json --broadcast
node <helper-folder>/wallet.cjs reconcile run/reconcile-request.json
```

The companion's sender supports **Ethereum 1 and Gnosis 100** with fixed legacy gas price, exact gas/value fields, conservative cumulative budget reservations, a sender lock, fresh exact-call simulation, recovered signer and a durable deterministic hash before broadcast. It refuses pending nonce conflicts and unresolved prior intents. It never changes a nonce, raises a fee, retries a broadcast or sends an approval automatically.

**Optimism 10:** balance, offline verify and simulation are supported; this companion refuses broadcast. OP's L1 data fee cannot be capped by an ordinary Ethereum transaction, and operator fees are additional. Use the selected Seer backend and holder after explicitly reconciling its fee policy with the mandate. The repository's older sender checks value and execution gas only; it is not evidence of a hard total-fee cap. Never silently relax an agreed fee/loss ceiling to obtain a send.

A simulation is evidence for one exact transaction at observed state, not proof of inclusion, successful execution, challenge success or profit. A pending/ambiguous broadcast keeps the hash and lock for reconciliation. Inspect that hash, sender/nonce and receipt before any retry. Two confirmations are the helper's default observation threshold, not chain finality; task settlement may require stronger evidence.

## Readiness report

Distinguish: public address known; offline signing verified for selected chain; RPC chain verified; funds observed at a block; task deposit/collateral and holder verified; mandate recorded; exact action simulated; execution supported. Report absent/unknown facts honestly. Always report `atomicBatches: false` for this companion. Do not claim "ready to spend on mainnet" from an Optimism balance or an untested encrypted file.

Source facts: [Ethereum account types](https://ethereum.org/developers/docs/accounts/), [Gnosis mainnet and native xDAI](https://docs.gnosischain.com/about/networks/mainnet), [OP fee components and uncapped L1 fee](https://docs.optimism.io/op-stack/transactions/fees), and [ethers v6 wallets](https://docs.ethers.org/v6/api/wallet/). Recheck deployment and pricing facts for the selected live task.
