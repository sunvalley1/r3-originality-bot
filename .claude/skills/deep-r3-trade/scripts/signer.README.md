# signer.cjs - the allowlist signer CLI for the deep-r3-trade skill

**Status: the reference signer of `deep-r3-trade`, shipped in the skill's `scripts/` folder for the operator to review
and install (`steps/I-setup.md` I.2 section 7). It has never been run against the real wallet.** It is written to the
rules in `steps/I-setup.md` (I.1 sections 2 and 7, I.2 sections 1, 5, 6 and 7), `steps/G-mint-and-trade.md`
(section 8) and `SKILL.md` (*Two modes*). It was exercised only with a throwaway key it generated itself and a
local mock JSON-RPC server, plus read-only reads of the live chain (see *Verification record*). The agent does not
hold, read or need the real keystore, and never installs or edits this file by hand; you review it, you copy it outside
the project folder (in a routine, `node r3.cjs install` copies it from the pinned commit), you record its hash.

One file on purpose: `autonomy.signer_sha256` pins ONE file (I.1 section 7, I.2 section 7), so everything that can
sign lives in `signer.cjs`. Its only dependency is `ethers` 6.17. Plain Node 22, CommonJS, Windows, macOS and Linux.

| | |
|---|---|
| Restricted subcommands (the ones the planner starts) | `check <file>`, `simulate <file>`, `send <file> [--nonce <n>]` |
| Supervised subcommands (the planner never starts them: a human runs them in a supervised session, where each call prompts) | `info`, `reconcile`, `clear-nonce <n>`, `sweep-token <token> [--amount <raw>]`, `sweep-eth --amount <wei>`, `allowlist-init ...` |
| Signer facts to record | `signer_mode: "local-encrypted-eoa"`, `atomic_batches: false` (one call per `send`), `nonce_pinning: true` only after the setup nonce test passes (7.4; the `nonce_pinning` that `info` prints is this signer's capability, not that result), reports `input_hash` at broadcast |

## 1. What it guarantees, and where each guarantee lives

* **Scope, never value.** An allowlist of contracts, selectors, markets, token pairs, fee tiers and receivers. There is
  no amount, count, frequency or time limit anywhere in the file (owner policy). A 1e60 approve and a 1e40 split are
  signed if they are in scope.
* **`check` is policy only.** It runs the same policy code as `send`, decides before any RPC call, and has no signing
  code path: it never reads the keystore or the unlock material and never opens the network. It is a separate
  subcommand, never a flag on `send`. EIP-712 typed data (permits, Permit2, EIP-3009), `personal_sign` and EIP-7702
  authorizations are refused in every restricted subcommand, always.
* **`send` checks first, signs once.** Policy, then the pinned chain id, then a simulation of the call, then it
  decrypts the key inside this process, signs, re-runs the policy on the exact signed bytes, writes the broadcast
  intent to its log, prints the hash and nonce, and makes ONE `eth_sendRawTransaction`. It never retries a send. A
  receipt that does not arrive is `unconfirmed` (exit 5), never "failed". Only a revert of that simulation (JSON-RPC
  code 3, or "revert" in the node's message) is `simulation-reverted`; any other RPC error before signing, such as a
  rate limit worded as a plain error, is reported as the RPC error it is (section 5, `send`).
* **No mode switch.** A mode-switch is any input other than `<file>` and `--nonce` that changes behaviour
  (`steps/I-setup.md` I.1 section 7): an extra token (argument or flag), an environment variable whose name looks like
  a switch, an input-file key whose name looks like one. None changes what is signed: the signer reads no environment
  variable, flag or file to change its behaviour, so the real guarantee is that there is nothing to switch (a file
  beside the input or a look-alike config in the working directory is never read, so it is ignored, not refused).
  On top of that, each of the three kinds is refused with the distinct allowlist refusal (`rule: "mode-switch"`)
  before any signature, instead of being silently ignored.
* **Everything it trusts is pinned outside the project folder**: the signer itself (hashed by `r3.cjs trade`), its
  `signer.config.json` next to it, the allowlist (sha256 in the config), the send-lock, the log, the key material. The
  signer refuses to start when any of them is inside `projectRoot`.
* **Key handling.** The unlock secret and the keystore are read only inside the signing process, only after every
  policy and chain check passed. There is no export, no `getPrivateKey`, no key path in any output; errors from the
  crypto layer are replaced by a generic message.

## 2. Install (operator, once)

1. Pick a folder **outside the project**, whose path does not contain `deep-r3-signer` (the deny rules in I.1
   section 2 would block it), for example `~/.r3-signer-bin/` (`%USERPROFILE%\.r3-signer-bin\` on Windows).
2. In that folder: `npm install ethers@6.17.0 --save-exact` (this creates the `node_modules` the signer resolves
   `ethers` from; the signer refuses to run if `ethers` resolves to a path inside the project folder). Node 22 or newer.
3. Copy `signer.cjs` there. Copy `signer.config.example.json` to `signer.config.json` next to it and edit it
   (section 3). The config is read **only** from next to `signer.cjs`; no argument or environment variable moves it.
4. Keystore. To reuse the bundled wallet's layout (an ethers JSON keystore plus a Windows DPAPI blob for its password)
   set `keystorePath` and `unlockPath` to the two paths in the public `run/wallet.json` and `signerMode` to `dpapi`.
   **Never open those two files, and never paste them anywhere.** On macOS or Linux use `keychain` or
   `secret-service` (the human stores the password in their own terminal, I.1 section 2), or `password-file`.
5. Build the allowlist, operator-run (section 4):
   `node signer.cjs allowlist-init --skill-dir <project>/.claude/skills/deep-r3-trade`
   (`--skill-dir` is the skill folder, the one holding `steps/C-select.md`, `steps/G-mint-and-trade.md` and this
   `scripts/` folder: the installed skill, or the copy you reviewed)
   Optionally add `--r3-data <project>/run/<run-id>/r3-data.json` to cross-check the chain helper's saved copy of the
   data function body. It prints the sha256; put it in `signer.config.json` as `allowlistSha256`.
6. `node signer.cjs info`: `allowlist_hash_matches` must be `true`. It also prints `signer_path` and `signer_sha256`.
7. Run the self-test (section 7). Only after it passes record the signer's absolute path and sha256 (the `signer_sha256`
   of `info`, or `sha256sum` / `shasum -a 256` / `certutil -hashfile`) in the `signer` record of
   `setup.deep-r3-trade.json` (I.1 section 7, *The setup record*), which `autonomy.signer_path` and
   `autonomy.signer_sha256` copy.
8. Deny rules (I.1 section 2): the list there names `~/.deep-r3-signer.dpapi`, `~/.foundry/keystores/**` and the
   placeholder `Read(<keystore and unlock folder>/**)`. Replace the placeholder with the folder (two entries if they
   differ) of `keystorePath` and `unlockPath`; the bundled wallet's store, named in the public `run/wallet.json`, is in
   neither default location. Put it in settings. A routine's install writes the key files to `routine.config.json`'s
   `keysDir` (`~/.r3-signer-keys` by default), which the trading routine's denied tools name
   (`Read(~/.r3-signer-keys/**)`, `steps/I-setup.md` I.2 section 7); a `Read` deny rule does not cover what a shell
   command reads, so it is one layer, not a wall. The signer's own folder, config and allowlist should be unreadable
   to the agent as well where the OS allows it; its log is the exception (it holds no key material, and the run reads
   it to settle a nonce, I.1 section 7); the trading routine denies `Write` and `Edit` altogether.
9. The hash pins one file (I.1 section 7, *The hash pins one file*): `r3.cjs`'s hash check covers `signer.cjs` only.
   In a routine, `node r3.cjs install` writes the folder fresh at every run from the pinned commit, not read-only. The
   send-lock and the log (`sendLockPath`, `logPath`) are written by the signer on every send, so point them at a
   separate, writable folder outside the project (`install` uses `routine.config.json`'s `stateDir`).

## 3. `signer.config.json`

Every key is read from this file only. Unknown keys are an error, except keys that start with an underscore (comments).
All paths are absolute. See `signer.config.example.json`.

| Key | Meaning |
|---|---|
| `chainId` | Must be `10`. Anything else is a config error. |
| `rpcUrl` | The one RPC endpoint, https (http only for a loopback host), no credentials. Pinned here like the chain helper's. No argument, flag or environment variable can change it. Must answer `eth_chainId` = `0xa`; `eth_simulateV1` is used by `simulate` (falls back to per-call `eth_call` without it). Reads back off on HTTP 429 and 5xx; `eth_sendRawTransaction` is attempted once. |
| `signerAddress` | Who signs, pays gas and (a local EOA) holds every balance. Must equal the keystore's address and the allowlist's `holder`. |
| `owner` | The human's own address. The ONLY destination of `sweep-token`, `sweep-eth` and `clear-nonce`, none of which takes a destination argument. Must differ from `signerAddress`. |
| `projectRoot` | The folder Claude Code runs in. Used to prove that everything above sits outside it. |
| `keystorePath` | Encrypted JSON keystore (Web3 Secret Storage v3). |
| `signerMode` | `dpapi` (Windows blob at `unlockPath`) \| `password-file` (password in `unlockPath`) \| `keychain` (`security find-generic-password -s <unlockService> [-a <unlockAccount>] -w`) \| `secret-service` (`secret-tool lookup service <unlockService>`). |
| `unlockPath` / `unlockService` / `unlockAccount` | Where the password comes from, per `signerMode`. |
| `allowlistPath` | The policy file, outside the project. |
| `allowlistSha256` | sha256 of that file, as printed by `allowlist-init`. A different hash is a refusal (`allowlist-hash-mismatch`) in `check`, `simulate` and `send`, before any RPC call. |
| `sendLockPath` | The send-lock (section 6). A routine's `node r3.cjs install` puts it in `routine.config.json`'s `stateDir`, and `r3.cjs trade` logs one left over at its start. |
| `logPath` | Append-only JSON-lines log of broadcast intents and outcomes (section 6). A routine's install puts it in `stateDir`, and `r3.cjs trade` writes its path to `run/wake-deep-r3.log` at every start; the run reads it, so keep it readable. |
| `receiptTimeoutSec`, `receiptPollMs`, `rpcTimeoutMs`, `rpcRetries`, `rpcBackoffMs` | Optional tuning (defaults 120, 2000, 20000, 4, 1000). |

## 4. The allowlist file

`allowlist-init` builds it, the operator runs it, the agent never does. Addresses come from the skill's own tables, never
from fetched data: the 98 markets and repo tokens from `steps/C-select.md`'s v3 table, the Router, ConditionalTokens,
SwapRouter02, PSM3, USDC, USDS, sUSDS, parent, bundle tokens, middles and the Invalid tokens from
`steps/G-mint-and-trade.md`'s address table. Both tables must agree with each other and with the addresses compiled into
`signer.cjs`, or it aborts. Then, onchain, in paced Multicall3 batches (default 400 ms between calls):

* `wrappedOutcome(0..n)` on all 102 markets (parent, 3 middles, 98 children), and every one of the 399 outcome tokens
  is verified against `CTF.getPositionId(sUSDS, getCollectionId(parentCollectionId, conditionId, 1 << j))` through the
  token's own `tokenId()`; the parent, bundle, middle and repo-token slots must equal the tables;
* for each of the 196 (UP or DOWN, repo token) pairs, `getPool(outcome, repo, tier)` at 100, 500, 3000 and 10000 and
  the pool's `fee()`, `token0()`, `token1()`, `liquidity()`. One tier is pinned per pair: **tier 100 (G section 2's
  verified default) whenever its pool holds liquidity, otherwise the most liquid pool.** More than one pool for a pair
  is a warning to review; no pool at all leaves the pair out of the allowlist (swaps on it are refused) with a warning;
* with `--r3-data`, the data function body is compared with the tables and the chain (ids, repo tokens, slots, all 294
  wrapped tokens, the parent's four tokens). Any disagreement aborts and writes nothing; the body never adds an address.

It refuses to overwrite an existing allowlist without `--force` (the hash changes, so the config pin must follow).

```
{ "format": "r3-signer-allowlist/1", "chain_id": 10, "generated_at": "<ISO>", "built_at_block": <n>,
  "built_from": { "c_select_sha256": "...", "g_mint_and_trade_sha256": "...", "r3_data_sha256_cross_check_only": "..." },
  "holder": "0x...",                                  // == signerAddress
  "contracts": { "susds", "router", "ctf", "swapRouter02", "psm3", "usdc", "usds" },   // must equal the signer's own constants
  "psm3_selectors": ["swapExactIn"],                  // the skill's rule: swapExactIn only (see the note under allowlist-init)
  "parent":  { "market": "0x...", "outcomes": [bundleA, bundleB, bundleC, parentInvalid] },
  "middles": [ { "bundle": "A", "market", "bundle_token", "invalid", "slots": 34 }, ... x3 ],
  "children": [ { "index": 0, "repo": "ethereum/py_ecc", "bundle": "A", "slot": 0, "market", "repo_token",
                  "down", "up", "invalid", "fee_down": 100, "fee_up": 100, "pool_down", "pool_up" }, ... x98 ] }
```

What each refusal `rule` means (all are `{"refused":"allowlist","rule":...}`, exit 3, decided before any RPC call
unless noted):

| `rule` | Refused because |
|---|---|
| `contract` | `to` is none of the Router, SwapRouter02, PSM3 or a token of the round |
| `ctf-direct` | any direct call to ConditionalTokens (no CTF selector is allowlisted: only the Router mutates positions) |
| `selector` | a selector that is not `approve` (tokens), Router `splitPosition`/`mergePositions`/`redeemPositions`, SwapRouter02 `exactInputSingle`/`exactOutputSingle`, PSM3 `swapExactIn` |
| `token-transfer` | `transfer` or `transferFrom` on any token, to anyone |
| `approval-spender` | spender is not the Router, SwapRouter02 or PSM3; a middle or parent Invalid to anything but the Router |
| `approval-amount` | an approval of `type(uint256).max` (any other amount is accepted: see section 9) |
| `router-market` / `router-collateral` / `router-args` | a market that is not the parent, a middle or one of the 98 children; a collateral argument other than sUSDS; a `redeemPositions` index outside the market's slots or mismatched arrays |
| `swap-pair` | not (UP or DOWN of child j) against repo token j, in either direction, on either swap function |
| `swap-fee-tier` | a `fee` other than the tier pinned for that pair |
| `recipient` / `receiver` | a swap `recipient` or a PSM3 `receiver` that is not the holder |
| `psm3-pair` | a PSM3 pair other than USDC or USDS against sUSDS |
| `native-value` | `value` other than 0 |
| `malformed-calldata` | calldata that is not the canonical ABI encoding of an allowlisted function |
| `eip712` / `eip7702` / `off-chain-signature` | typed data, an EIP-7702 authorization or SetCode transaction, `personal_sign`/`eth_sign` |
| `chain-id` | an input `chainId` other than 10, or an RPC that is not on chain 10 (decided after the RPC answers for the latter, still before any signature) |
| `mode-switch` | anything that claims to change the allowlist: an extra argument or flag, an environment variable named like a switch, a key such as `allowlist`, `mode`, `policy` in the input, and the runtime overrides of section 9 |
| `allowlist-hash-mismatch` / `allowlist-missing` | the pinned file does not hash to `allowlistSha256`, or cannot be read |
| `input-shape` | an input that is not a call list, one call, typed data or an authorization, or has unknown keys |

A refusal is never an error and an error is never a refusal: a revert, an RPC error, a crash or a generic failure prints
`{"error": ...}` and is a FAIL for the self-test (I.1 section 7), not an allowlist refusal.

## 5. The subcommands, with their exact output

Every block below is a real run. The addresses are throwaway (generated for the run, never funded). `<dir>` stands for the
run's data folder. Blocks from the mock RPC come from `node signer.test.cjs`'s own transcript; blocks marked **live** ran
against the real Optimism RPC, read-only, with a throwaway holder and an allowlist built by `allowlist-init` on the live chain.

### `check <file>`: policy only, no RPC, no key

Input: a JSON list of calls `[{"to","data","value"?}]` (or `{"calls":[...],"chainId"?,"gasLimit"?}`, or one bare call), EIP-712 typed data, or an EIP-7702 authorization `{"chainId","address","nonce"}`.

**live**, allowed:
```
$ node signer.cjs check <ok-approve.json>
{"allowed":true}
(exit 0)
```

Refused (exit 3). `rule` is the distinct allowlist refusal; `detail` and `index` (the offending call of a list) are extra:
```
$ node signer.cjs check <bad-tier.json>
{"refused":"allowlist","rule":"swap-fee-tier","detail":"fee 500 is not the tier 100 pinned for this pair","index":0}
(exit 3)
```
```
$ node signer.cjs check <bad-recipient.json>
{"refused":"allowlist","rule":"recipient","detail":"the swap recipient is always the holder","index":0}
(exit 3)
```
```
$ node signer.cjs check run/max-approval.json
{"refused":"allowlist","rule":"approval-amount","detail":"an approval of type(uint256).max is never signed; approve the exact amount","index":0}
(exit 3)
```
```
$ node signer.cjs check <bad-spender.json>
{"refused":"allowlist","rule":"approval-spender","detail":"spender 0x000000000000000000000000000000000000dead is not the Router, SwapRouter02 or PSM3","index":0}
(exit 3)
```
Typed data and EIP-7702 authorizations are always refused in the restricted subcommands, before any signature:
```
$ node signer.cjs check run/permit.json
{"refused":"allowlist","rule":"eip712","detail":"EIP-712 typed data is never signed by this signer (permits, Permit2, EIP-3009 included)"}
(exit 3)
```
```
$ node signer.cjs check run/authorization.json
{"refused":"allowlist","rule":"eip7702","detail":"EIP-7702 authorizations and SetCode transactions are never signed by this signer"}
(exit 3)
```

### `simulate <file>`: policy, then `eth_simulateV1` of one transaction's calls from `signerAddress`; never signs, never broadcasts

**live**, `eth_simulateV1` on the real node (`nonce` is the account's pending nonce; exit 0 when every status is `0x1`, exit 1 otherwise: G section 8's "MUST throw on revert"):
```
$ node signer.cjs simulate <sim-approve.json>
{"simulated":true,"via":"eth_simulateV1","ok":true,"broadcast":false,"signed":false,"from":"0xB8e7e4B6e12d55a4ea661A71dB6577f0882a69A1","chain_id":10,"nonce":0,"results":[{"index":0,"status":"0x1","gas_used":"31093"}]}
(exit 0)
```
```
$ node signer.cjs simulate <sim-split.json>
{"simulated":true,"via":"eth_simulateV1","ok":false,"broadcast":false,"signed":false,"from":"0xB8e7e4B6e12d55a4ea661A71dB6577f0882a69A1","chain_id":10,"nonce":0,"results":[{"index":0,"status":"0x0","gas_used":"41053","error":"execution reverted: SUsds/insufficient-balance"}]}
(exit 1)
```
Only an answer carrying `"simulated":true` is a simulation result. An RPC error, a rate limit included, is `{"error":"rpc-error"|"rpc-http"|"rpc-transport","detail":...}` with no `simulated` key, exit 1; on the per-call `eth_call` fallback too, where only a revert (code 3, or "revert" in the node's message) becomes a `0x0` row.

### `send <file> [--nonce <n>]`: policy, chain check, simulation, sign, ONE broadcast

An allowlisted swap against the mock RPC. Three lines: the lock is taken and declared; **`broadcast` is printed, with the hash, the nonce and the `input_hash`, after the intent is logged and before the single `eth_sendRawTransaction` and long before the receipt**; then the outcome:
```
$ node signer.cjs send run/in.json
{"event":"lock","command":"send","lock_path":"<dir>/main-send.lock","log_path":"<dir>/main-signer.log.jsonl","attempt":"516cf391-1cd0-4182-9347-6c420d7b2900"}
{"event":"broadcast","hash":"0xad830d2a88c462e21e49b4dd459cb5e220cab9337ae8874d2d9591e9783bda32","nonce":7,"input_hash":"0x1e3c4ec9348ceef4692f974c11026ceaeef69ac143d7f7f815e0b049f6030b76","from":"0x04D928FaF0C077a70fe798cB39Dd02B682a7707c","to":"0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45","chain_id":10,"gas_limit":"240000","gas_clamped":false,"lock_path":"<dir>/main-send.lock","log_path":"<dir>/main-signer.log.jsonl"}
{"event":"confirmed","hash":"0xad830d2a88c462e21e49b4dd459cb5e220cab9337ae8874d2d9591e9783bda32","nonce":7,"input_hash":"0x1e3c4ec9348ceef4692f974c11026ceaeef69ac143d7f7f815e0b049f6030b76","from":"0x04D928FaF0C077a70fe798cB39Dd02B682a7707c","to":"0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45","chain_id":10,"block_number":101,"gas_used":"21000","lock_path":"<dir>/main-send.lock","lock_released":true}
(exit 0)
```

The refusals of `send` carry `"signed":false,"broadcast":false` and the lock path. The self-test's last case (a zero-amount approve with the burn address as spender), then the mode-switch attempts on an allowlisted call, then the hash pin:
```
$ node signer.cjs send run/burn-approve.json
{"refused":"allowlist","rule":"approval-spender","detail":"spender 0x000000000000000000000000000000000000dead is not the Router, SwapRouter02 or PSM3","index":0,"command":"send","signed":false,"broadcast":false,"lock_path":"<dir>/main-send.lock"}
(exit 3)
```
```
$ node signer.cjs send run/in.json --no-allowlist
{"refused":"allowlist","rule":"mode-switch","detail":"flag \"--no-allowlist\" is not part of the send grammar; no flag can change the allowlist","command":"send","signed":false,"broadcast":false,"lock_path":"<dir>/main-send.lock"}
(exit 3)
```
```
$ node signer.cjs send run/in.json
{"refused":"allowlist","rule":"mode-switch","detail":"environment variable SIGNER_ALLOWLIST looks like an allowlist switch; the signer reads no environment variable to change its behaviour","command":"send","signed":false,"broadcast":false,"lock_path":"<dir>/main-send.lock"}
(exit 3)
```
```
$ node signer.cjs send run/in.json
{"refused":"allowlist","rule":"allowlist-hash-mismatch","detail":"the allowlist file hashes to cf0fa6a4f3c6..., the config pins 9c3fffc03c17...; refusing to sign","command":"send","signed":false,"broadcast":false,"lock_path":"<dir>/main-send.lock"}
(exit 3)
```

A pinned nonce that is already used (the setup nonce test): no signature, no hash, no intent.
```
$ node signer.cjs send run/in.json --nonce 3
{"event":"lock","command":"send","lock_path":"<dir>/main-send.lock","log_path":"<dir>/main-signer.log.jsonl","attempt":"f27a8065-a1aa-4585-a30a-7918f6aa62fb"}
{"error":"nonce-too-low","detail":"nonce 3 is already used (the account's confirmed nonce is 7); nothing was signed or broadcast","command":"send","signed":false,"broadcast":false,"nonce":3,"latest":7,"pending":7}
(exit 1)
```

An RPC error before signing (the chain id, nonce, fee and balance reads, the pre-sign `eth_call` simulation, or `eth_estimateGas` when the input has no `gasLimit`) is reported as the RPC error it is: `rpc-error` (with the node's text in `detail` and its `rpc_code`), `rpc-http` or `rpc-transport`, exit 1, with no `broadcast` line, nothing signed and the lock released. `simulation-reverted` is only a revert of that `eth_call` (code 3, or "revert" in the node's message). So a public RPC's rate limit, answered as a plain JSON-RPC error, is never read as a revert, and the caller may re-run it (the throttle rule: `steps/I-setup.md` I.2 section 7, *Rate limits*). A rate limit on the pre-sign `eth_call`, against the mock RPC:
```
$ node signer.cjs send run/in.json
{"event":"lock","command":"send","lock_path":"<dir>/main-send.lock","log_path":"<dir>/main-signer.log.jsonl","attempt":"13e61943-4be0-40b7-9542-6d8cd404afa9"}
{"error":"rpc-error","detail":"exceeded its requests per second capacity","command":"send","signed":false,"broadcast":false,"rpc_code":-32005}
(exit 1)
```

**The ETH up-front rule (this is where it is written; G section 8's *Affordability* cites it).** After the policy, nonce and simulation checks and before any key is loaded, `send` reads `eth_gasPrice`, `eth_maxPriorityFeePerGas` and the signer's `eth_getBalance` in one batch and refuses unless the balance is at least `gasLimit x maxFeePerGas + value`, where `maxFeePerGas` is 2 x that `eth_gasPrice` (at least 1 wei), `gasLimit` is the input file's `gasLimit` (without it, `eth_estimateGas` x 1.2 clamped at 2^24) and `value` is 0 for every allowlisted call. The refusal is `{"error":"insufficient-gas-funds", ...}` with `"signed":false,"broadcast":false` and exit 1: no signature, no hash, no broadcast intent, and the send-lock it took is released, so the attempt never reached the network. The check uses the balance and the gas price read at that moment, once per send, so each later transaction of a group is checked against the balance the earlier ones left. Optimism's L1 data fee is deducted from the balance but is not in the check (section 9, *No fee ceiling*). `sweep-token`, `sweep-eth` and `clear-nonce` run the same check (`clear-nonce` with its doubled fee).

A send whose broadcast fails or whose receipt does not arrive is `unconfirmed` (exit 5): the hash was already printed, the lock stays, nothing is re-sent. The next `send` is then refused with the distinct send-lock refusal (exit 4):
```
$ node signer.cjs send run/in.json
{"event":"lock","command":"send","lock_path":"<dir>/main-send.lock","log_path":"<dir>/main-signer.log.jsonl","attempt":"9a484775-04b6-41e6-ab4d-e6f626e0c7c9"}
{"event":"broadcast","hash":"0x9327bef6f5088ba6b9fc67bee9793f38a9ae7a8e930bae127065f48b8c1be4fd","nonce":7,"input_hash":"0x2702f7e2c0195589d00ae7e90b5e999a7aa24b523df5662eed9b2b59b26ccf99","from":"0x04D928FaF0C077a70fe798cB39Dd02B682a7707c","to":"0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0","chain_id":10,"gas_limit":"240000","gas_clamped":false,"lock_path":"<dir>/main-send.lock","log_path":"<dir>/main-signer.log.jsonl"}
{"event":"unconfirmed","reason":"send-error","detail":"HTTP 500 from the pinned RPC","hash":"0x9327bef6f5088ba6b9fc67bee9793f38a9ae7a8e930bae127065f48b8c1be4fd","nonce":7,"input_hash":"0x2702f7e2c0195589d00ae7e90b5e999a7aa24b523df5662eed9b2b59b26ccf99","from":"0x04D928FaF0C077a70fe798cB39Dd02B682a7707c","to":"0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0","chain_id":10,"lock_path":"<dir>/main-send.lock","lock_released":false,"next":"never re-send; settle this nonce from chain state (reconcile, then I-setup.md I.2 section 6)"}
(exit 5)
```
```
$ node signer.cjs send run/in.json
{"refused":"send-lock","detail":"the signer's send-lock is held; a killed send leaves it until `reconcile` clears it","command":"send","signed":false,"broadcast":false,"lock_path":"<dir>/main-send.lock","lock":{"pid":61688,"command":"send","started_at":"2026-10-05T03:18:57.340Z","hash":"0x9327bef6f5088ba6b9fc67bee9793f38a9ae7a8e930bae127065f48b8c1be4fd","nonce":7,"input_hash":"0x2702f7e2c0195589d00ae7e90b5e999a7aa24b523df5662eed9b2b59b26ccf99"}}
(exit 4)
```

### Supervised entry points (never started by the planner)

`reconcile` settles the send-lock a killed or unconfirmed send left behind (statuses `no-lock`, `in-progress`, `cleared`, `landed`, `reverted`, `superseded`, `pending-or-unsent`):
```
$ node signer.cjs reconcile
{"status":"pending-or-unsent","hash":"0x9327bef6f5088ba6b9fc67bee9793f38a9ae7a8e930bae127065f48b8c1be4fd","nonce":7,"input_hash":"0x2702f7e2c0195589d00ae7e90b5e999a7aa24b523df5662eed9b2b59b26ccf99","lock_path":"<dir>/main-send.lock","latest_nonce":7,"lock_released":false,"next":"wait, or consume nonce 7 with: node signer.cjs clear-nonce 7"}
(exit 5)
```
```
$ node signer.cjs reconcile
{"status":"landed","hash":"0x9327bef6f5088ba6b9fc67bee9793f38a9ae7a8e930bae127065f48b8c1be4fd","nonce":7,"input_hash":"0x2702f7e2c0195589d00ae7e90b5e999a7aa24b523df5662eed9b2b59b26ccf99","lock_path":"<dir>/main-send.lock","block_number":101,"lock_released":true}
(exit 0)
```
```
$ node signer.cjs reconcile
{"status":"superseded","hash":"0x9327bef6f5088ba6b9fc67bee9793f38a9ae7a8e930bae127065f48b8c1be4fd","nonce":7,"input_hash":"0x2702f7e2c0195589d00ae7e90b5e999a7aa24b523df5662eed9b2b59b26ccf99","lock_path":"<dir>/main-send.lock","latest_nonce":9,"detail":"the nonce was consumed by another transaction; the recorded hash can never land","lock_released":true}
(exit 0)
```

`clear-nonce <n>` sends a zero-value transaction to the pinned `owner` at nonce `n` with a doubled fee (I.2 section 6's stuck-nonce step); `sweep-token <token> [--amount <raw>]` and `sweep-eth --amount <wei>` send to the pinned `owner` only. None of them takes a destination:
```
$ node signer.cjs clear-nonce 7
{"event":"broadcast","hash":"0x1d6510689411e1e450549e71d15fdc1a0fd1e7785da1917964ca7316b1beb483","nonce":7,"input_hash":"0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470","from":"0x04D928FaF0C077a70fe798cB39Dd02B682a7707c","to":"0x9d37D7C8480609d4b064432e273a1b5507B73393","chain_id":10,"gas_limit":"240000","gas_clamped":false,"lock_path":"<dir>/main-send.lock","log_path":"<dir>/main-signer.log.jsonl"}
{"event":"confirmed","hash":"0x1d6510689411e1e450549e71d15fdc1a0fd1e7785da1917964ca7316b1beb483","nonce":7,"input_hash":"0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470","from":"0x04D928FaF0C077a70fe798cB39Dd02B682a7707c","to":"0x9d37D7C8480609d4b064432e273a1b5507B73393","chain_id":10,"block_number":101,"gas_used":"21000"}
(exit 0)
```
```
$ node signer.cjs sweep-token 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85 --amount 100
{"event":"lock","command":"sweep-token","lock_path":"<dir>/main-send.lock","log_path":"<dir>/main-signer.log.jsonl","attempt":"151b8f3b-ede2-475e-843a-e5ee727da5f4"}
{"event":"broadcast","hash":"0x849cb5afb6e5724e87dec52ae77ede12c8533731c0e6bcb1a7052e2b37fcc0cb","nonce":7,"input_hash":"0xfe66318c1bcdd0d1608d9408b48cc577705f7bddc3dc0f9d95c61fac6b6b6f1e","from":"0x04D928FaF0C077a70fe798cB39Dd02B682a7707c","to":"0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85","chain_id":10,"gas_limit":"240000","gas_clamped":false,"lock_path":"<dir>/main-send.lock","log_path":"<dir>/main-signer.log.jsonl"}
{"event":"confirmed","hash":"0x849cb5afb6e5724e87dec52ae77ede12c8533731c0e6bcb1a7052e2b37fcc0cb","nonce":7,"input_hash":"0xfe66318c1bcdd0d1608d9408b48cc577705f7bddc3dc0f9d95c61fac6b6b6f1e","from":"0x04D928FaF0C077a70fe798cB39Dd02B682a7707c","to":"0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85","chain_id":10,"block_number":101,"gas_used":"21000","lock_path":"<dir>/main-send.lock","lock_released":true}
(exit 0)
```
```
$ node signer.cjs sweep-eth --amount 12345
{"event":"lock","command":"sweep-eth","lock_path":"<dir>/main-send.lock","log_path":"<dir>/main-signer.log.jsonl","attempt":"75f17dfb-5022-4e1f-9167-882361cbdcd7"}
{"event":"broadcast","hash":"0x314f20e3ca8b038fe3b9cc2250f6f13145a8bc2f1017fad4eed6cbf1fd479ad1","nonce":7,"input_hash":"0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470","from":"0x04D928FaF0C077a70fe798cB39Dd02B682a7707c","to":"0x9d37D7C8480609d4b064432e273a1b5507B73393","chain_id":10,"gas_limit":"240000","gas_clamped":false,"lock_path":"<dir>/main-send.lock","log_path":"<dir>/main-signer.log.jsonl"}
{"event":"confirmed","hash":"0x314f20e3ca8b038fe3b9cc2250f6f13145a8bc2f1017fad4eed6cbf1fd479ad1","nonce":7,"input_hash":"0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470","from":"0x04D928FaF0C077a70fe798cB39Dd02B682a7707c","to":"0x9d37D7C8480609d4b064432e273a1b5507B73393","chain_id":10,"block_number":101,"gas_used":"21000","lock_path":"<dir>/main-send.lock","lock_released":true}
(exit 0)
```

`info` prints public facts only (no key material, no keystore path): the values to record in `setup.deep-r3-trade.json` (I.1 section 7, *The setup record*, and the *Output* example), except `nonce_pinning` and `signer_mode` (`info` prints the unlock mode, for example `password-file`; the record's `signer_mode` for this signer is `local-encrypted-eoa`). `info` prints `nonce_pinning: true` before any test, because it is the signer's capability; the record takes the result of 7.4 only, never `info`'s field.

**live**:
```
$ node signer.cjs info
{"version":"1.0.0","signer_path":"<dir>/signer.cjs","signer_sha256":"<the signer.cjs sha256 of section 10>","chain_id":10,"ethers_version":"6.17.0","node_version":"v22.7.0","rpc_origin":"https://mainnet.optimism.io","signer_address":"0xB8e7e4B6e12d55a4ea661A71dB6577f0882a69A1","holder":"0xB8e7e4B6e12d55a4ea661A71dB6577f0882a69A1","owner":"0xea1E4F4D59bbADDF9d2AaDdBAcbBCa9aCAfB4344","signer_mode":"password-file","allowlist_path":"<dir>/allowlist.json","allowlist_sha256_pinned":"aabe27db2d12eb2076122f1b8248d77638fe7ba8ec63eecc8671af81e95bc639","allowlist_sha256_actual":"aabe27db2d12eb2076122f1b8248d77638fe7ba8ec63eecc8671af81e95bc639","allowlist_hash_matches":true,"send_lock_path":"<dir>/send.lock","log_path":"<dir>/signer.log.jsonl","atomic_batches":false,"nonce_pinning":true,"reports_input_hash":true,"restricted_subcommands":["send","simulate","check"],"supervised_subcommands":["info","reconcile","clear-nonce","sweep-token","sweep-eth","allowlist-init"]}
(exit 0)
```

`allowlist-init --skill-dir <dir> [--delay-ms <n>] [--force] [--allow-swap-exact-out] [--r3-data <file>]`, operator-run, read-only, paced. **live**:
```
$ node signer.cjs allowlist-init --force --skill-dir <deep-r3-trade> --delay-ms 400 --r3-data <r3-data.json>
{"allowlist_path":"<dir>/allowlist.json","sha256":"aabe27db2d12eb2076122f1b8248d77638fe7ba8ec63eecc8671af81e95bc639","record":"set \"allowlistSha256\": \"aabe27db2d12eb2076122f1b8248d77638fe7ba8ec63eecc8671af81e95bc639\" in signer.config.json","built_at_block":157785485,"markets_verified":102,"outcome_tokens_verified":399,"children":98,"pools_pinned_by_fee_tier":{"100":196},"r3_data_cross_checked_rows":98,"warnings":[]}
(exit 0)
```
Record `sha256` as `allowlistSha256` in `signer.config.json`. `--allow-swap-exact-out` is a code option that the skill's
rule does not use: the one allowlist file is what `send` checks in every mode, and I.1 section 7 says the allowlist
carries `swapExactIn` only, so never pass it when building the allowlist the wake signs under (an exact-out exit has no
entry point in this signer).


Exit codes: `0` ok / allowed, `1` an error (RPC, simulation revert, unlock, nonce-too-low, insufficient-gas-funds), `2` usage or config error,
`3` allowlist refusal, `4` send-lock refusal, `5` unconfirmed (hash printed, lock kept), `6` the receipt shows a revert.
`send`'s input file is `[{"to","data","value"?}]` (exactly one call), or `{"calls":[...], "chainId"?: 10,
"gasLimit"?: "<n>"}`, or one bare call. `gasLimit` is the caller's gas-limit override (1 to 16777216); without it the
gas limit is `eth_estimateGas` x 1.2 clamped at 2^24. The run passes `gasLimit` with every `send`, as
G section 8's *Gas limits* sets it (`maxUsedGas` x 1.2 from the ordered simulation; `gasUsed` x 1.5 only as the fallback
for a call the RPC gave no `maxUsedGas`, never `gasUsed` x 1.2).

## 6. Send-lock, log, nonce, `input_hash`

* **Send-lock.** Exclusive-create file at `sendLockPath`, taken by `send`, `sweep-*`, declared in the first line of
  output (`event: lock`) and in every `broadcast` event. Removed after a terminal receipt (confirmed or reverted) and
  when nothing was broadcast (refusal, nonce-too-low, failed simulation). **Left in place** when a send ends
  `unconfirmed` or the process is killed after the intent: a held lock makes `send` refuse with
  `{"refused":"send-lock"}` (exit 4) until `node signer.cjs reconcile` clears it. `reconcile` and `clear-nonce` are
  supervised entry points: the planner never starts them, and a human runs them in a supervised session, where each
  call prompts (I.2 section 6(e)).
* **Hash at broadcast.** Before the single `eth_sendRawTransaction` the signer appends `broadcast-intent` (hash, nonce,
  `input_hash`) to `logPath`, rewrites the lock with the same fields, and prints `{"event":"broadcast", ...}` on stdout
  with the transaction `hash`, its `nonce` and `input_hash`; the write is synchronous, so the line is on the pipe before
  the network call is made. A blocking tool call returns it to the run only when the process exits, so the log
  (`log_path` is in every event) is the record to read after a kill.
* **`input_hash`** is `keccak256` of the signed transaction's `input` (the call's `data`), exactly G section 8's
  `calldata_hash` for a single call.
* **Pinned nonce.** `send <file> --nonce <n>` signs at exactly `n`. If the node says `n` is already used
  (`eth_getTransactionCount(latest)` above it) it prints `{"error":"nonce-too-low"}`, exit 1, with no signature, no hash
  and no intent; `n` above the pending nonce is `nonce-gap`. Without `--nonce` the pending nonce is used.
* **Log events** (`logPath`, one JSON object per line, never key material or signed bytes): `broadcast-intent`,
  `broadcast-accepted`, `broadcast-error`, `broadcast-anomaly`, `confirmed`, `reverted`, `receipt-timeout`,
  `reconcile-cleared`, `reconcile-confirmed`, `reconcile-reverted`, `reconcile-superseded`. Every line starts
  with `at` (ISO 8601 UTC) and `pid`; the broadcast and receipt lines carry `hash`, `nonce`, `input_hash`,
  `from`, `to` and `chain_id`. The run ignores a line whose `at` is earlier than the start of the run-id whose
  attempt it is matching, so a log that outlives a chain instance marks nothing as landed (G section 8, step 4).

## 7. The self-test procedure

**7.1 The offline suite** (operator, on review, and again after any edit to `signer.cjs`):

```
cd <the folder holding signer.cjs and signer.test.cjs>
node signer.test.cjs --dir <a scratch folder>
```

It needs the skill folder it ships in, `..` from the folder holding the tests (it parses the same tables
`allowlist-init` does), so run it from the skill's `scripts/` folder, and `ethers` 6.17 resolvable. It generates a fresh throwaway keystore and password and a local mock JSON-RPC server (chain
id 10) on every run, never touches the network and never a real key, prints `PASS`/`FAIL`/`SKIP` per case and exits
non-zero on any `FAIL`. It covers every case of I.1 section 7's list, the positive sends, the send-lock, nonce pinning, key hygiene and
`allowlist-init` against a synthetic chain. It takes a few minutes (receipt waits and paced reads).

**7.2 The setup self-test (I.1 section 7)**, run by the agent in the supervised session after the operator's first yes.
The case list, its order and the record of the pass are written once, in `steps/I-setup.md` I.1 section 7; this
section carries no list of its own and uses that list's numbers. Cases (1) to (16) go through `check`, which signs
nothing; (17) and (18) are 7.3's `send` cases and (19) is 7.4. Use zero or 1-wei amounts and the burn address
`0x000000000000000000000000000000000000dEaD` as the foreign recipient and spender. Build each `data` with the chain
helper's `encode` (the agent writes no ABI by hand); `H` is the holder, `Ci` is the first child of the allowlist. Each
refusal must be `{"refused":"allowlist","rule":<rule>}`, exit 3; anything else (an `error`, a revert, a crash) is a FAIL.
The `rule` this signer returns, by I.1's case number: (1) `token-transfer`; (2) `approval-spender`; (3) `approval-amount`;
(4) and (5) `recipient`; (6) `receiver`; (7) `swap-pair`, once per swap function; (8) `swap-fee-tier`, once per swap
function; (9) `psm3-pair`; (10) `router-market`; (11) `native-value`; (12) `selector`; (13) `eip712`; (14) `eip7702`;
(15) `approval-spender` with the `index` of the bad call (`check` takes a list: three calls, the third a burn-spender
approve, gives `index: 2`); (16) is accepted, `{"allowed":true}`, exit 0. Save each case's input as
`run/<setup run-id>/selftest/case-NN.json`, numbered in the list's order, and the results beside them as `results.json`
(`{at, signer, cases: [{case, expected, exit, got, pass}]}`, `expected` a rule, `<rule>@<index>` or `allowed`): then
`node r3.cjs selftest --cases <that folder>` replays them through a new install's `check`, as a routine's install needs
(`steps/I-setup.md` I.2 section 7).

Optional, same procedure: an input `"chainId": 1` -> `chain-id`; a changed allowlist byte -> `allowlist-hash-mismatch`.

**7.3 Cases (17) and (18), through `send`, only after every `check` case passed.** A zero-amount `approve(burn, 0)` on sUSDS,
once for each mode-switch attempt: an extra argument (`send <file> allowlist=off`), a flag (`send <file> --no-allowlist`),
an environment variable (`SIGNER_ALLOWLIST=off node ... send <file>`), a key in the file (`{"calls":[...],
"allowlist":"off"}`) and an agent-writable file beside it. Each must print the distinct allowlist refusal with
`"signed":false,"broadcast":false`, exit 3: `mode-switch` for the first four, and for the file beside the input
`approval-spender`, because the signer does not read that file (it shows the file changed nothing). A signer that
signs it FAILS. That call is also out of scope on its own, so it would be refused even if the mode-switch detection
were removed; therefore run the same four detectable attempts on an allowlisted zero-amount call,
`approve(Router, 0)` on sUSDS (the call of 7.4; a broken signer that sent it would only reset an allowance, and each
attempt follows I.2 section 6's send rules under the setup run-id `setup-<slug>`, with the write-ahead records, as 7.4 does). Each
must print `{"refused":"allowlist","rule":"mode-switch",...}`, exit 3, which proves the refusal comes from the
switch (the offline suite runs the same attempts).

**7.4 The setup nonce test, case (19)** (after the signer has one confirmed transaction): `send <file> --nonce <an already-used nonce>`
with `[{"to":"<sUSDS>","data":"<approve(Router, 0)>"}]`. Pass: `{"error":"nonce-too-low", ...}`, exit 1, no `broadcast`
event, no hash, and no send-lock left behind (the lock event is printed first and the file is removed). Record
`nonce_pinning: true` only on that result, which is I.1 section 7's pass condition: nonce-too-low for the used nonce,
with no hash, no broadcast intent and no send-lock that survives it. This signer asks the node for the confirmed nonce
(`eth_getTransactionCount`, `latest`) and refuses before signing, so no transaction exists for the node to reject.

## 8. Wiring it into the skill

* The trading routine (`steps/I-setup.md` I.2 section 7): `node r3.cjs install` writes this signer's
  `signer.config.json` itself, in `password-file` mode, with the key files in `keysDir` and the send-lock and the log
  in `stateDir` (`routine.config.json`), and refuses (exit 4) when `signerDir` already holds a signer of another mode;
  the routine's tools name no signer command, and the second question (I.2 section 1) adds no rule: the signer runs as
  the planner's child process under `r3.cjs trade`; `autonomy.signer_path` / `autonomy.signer_sha256` as in 7, which
  `r3.cjs trade` accepts only for this install's `<signerDir>/signer.cjs`.
* The skill adds no allow rule for the signer anywhere. In a supervised session each signer call prompts the human,
  who reads the whole command, an environment-variable prefix included; never allow `node <signer path> …` by rule.
* Supervised exit: swap sUSDS to USDC with `send` (PSM3 `swapExactIn`, receiver = holder, is on the allowlist in both
  directions), then `sweep-token <USDC>` sends to `owner` and nowhere else; `sweep-eth --amount <wei>` for the gas
  remainder. Clearing a stuck nonce (I.2 section 6): `clear-nonce <n>`. There is no `swapExactOut` path and no
  EIP-7702 delegation or revocation entry point (section 9).

## 9. What this does not do (read before adopting it)

* **The first lines of defence are not in this file.** In the trading routine the planner starts the signer as a
  child process that no Claude Code rule sees; there who can push to the trading repository and what loads at
  session start, the code pin in the routine's prompt, the routine's tool lists and auto mode's classifier,
  `r3.cjs`'s gates and refusals, the agent's instructions, and your claude.ai and GitHub accounts stand in front of
  it (`steps/I-setup.md` I.2 section 7). In a supervised session each signer call prompts the human.
  Inside the process the signer refuses a
  `--require`, `-r`, `--import` or `--loader` in `NODE_OPTIONS` or in node's own flags, `NODE_TLS_REJECT_UNAUTHORIZED=0`,
  and an `ethers` that resolves inside the project folder, with the `mode-switch` refusal. **That check is advisory
  against a preload, not a control**: a preload runs before the signer does and can rewrite the signer's own checks.
* **The hash covers one file.** `r3.cjs trade` hashes `signer.cjs`. Its correctness also depends on `ethers` in
  `node_modules`, on `signer.config.json` and on the allowlist (hash-pinned by the config, so only the config and
  `node_modules` are unpinned). In a routine, `node r3.cjs install` writes `signer.cjs`, its config and the allowlist fresh at every run,
  not read-only, from the commit the routine's prompt pins, with `ethers` 6.17.0 from the npm registry (exact version,
  `--ignore-scripts`, no lockfile).
* **"Exact" approvals are not verifiable at signing time**: only `type(uint256).max` is refused; the signer cannot know
  what amount a group needs, and an amount limit is out of scope by owner policy. Exactness is the run's duty
  (I.1 section 7, the approval row; I.1 section 8 *ALLOWANCES*).
* **No fee ceiling.** Fees come from the pinned RPC (`maxFeePerGas` = 2 x `eth_gasPrice`); the balance check (section 5,
  `send`: the ETH up-front rule) covers execution gas only, not Optimism's L1 data fee.
* **One transaction per `send`**, so a keep-whole group on this signer is sequential and can be left half-done
  between transactions (I.1 section 7's recovery rule). EIP-7702 is not implemented here.
* **No EIP-7702 delegation or revocation entry point, and no `swapExactOut`.** Delegation and revocation are out of
  scope for this plain-EOA signer (a signer whose key signs them needs its own reviewed supervised entry point, after
  the delegate review in I.1 section 7); the exit is a `send` swap to the holder plus `sweep-token` (section 8).
* **`simulate` is one transaction's calls** in one `eth_simulateV1` block (per-call `eth_call` without it). The ordered
  multi-transaction simulation is the chain helper's.
* `sweep-*` and `clear-nonce` do not read the allowlist; they send only to `owner`.
* A name-based tripwire refuses environment variables whose names look like an allowlist switch (`ALLOW`, `POLIC`,
  `UNRESTRICT`, `BYPASS`, `OVERRIDE`, `UNSAFE`, `DANGER`, `NO_CHECK`, `SKIP_CHECK`, `DISABLE_...`, `SUPERVISED`,
  `ADMIN_MODE`). If an unrelated variable in the wake's environment trips it, the refusal names the variable; unset it.

## 10. Verification record

All of it was run with Node v22.7.0 and ethers 6.17.0: the live read-only block on 2026-10-05, the offline suite again
on 2026-10-08 on exactly the two files hashed here.

* `signer.cjs` sha256 `19d3598bb13983078eeac0a747120fa3a6886059764bcf212d1747b12be9eeef` (any edit changes it; `info` prints the value to record).
* `node signer.test.cjs --dir <scratch>`: **111 passed, 0 failed, 0 skipped**, exit code 0. Throwaway
  keystore and password generated per run, mock JSON-RPC server on loopback (chain id 10); no real network, no real key.
  `signer.test.cjs` sha256 `0894378a989005525e00f76f51eb401667e5edf516a2729341be9ca5dec1191b`. On 2026-10-08 the
  "broadcast-intent is logged before `eth_sendRawTransaction`" check (E1 to E6, E16) became causal: the mock reads the
  log when the raw transaction reaches it. It used to compare timestamps taken by two processes, the signer and the
  test. On 2026-10-08 it failed in two runs started just after a Windows time-service sync (02:51 UTC), and passed in
  every run since. A test that looks for the later `broadcast-accepted` line at that moment fails on exactly these
  seven cases, as it should. The two cases added on
  2026-10-06 (E12b, E12c: an RPC error that is not a revert, on `send`'s pre-sign `eth_call` and on `simulate`'s
  `eth_call` fallback, is reported as that RPC error) fail on the previous `signer.cjs`
  (`8867cdda492fb06e71e9c3656705da6313ebddf3d99819065e0a2ba6f23c6a5d`, which labelled it `simulation-reverted` or a `0x0`
  row) and pass on this one.
* **Live, read-only** (rule: only `eth_call`, `eth_getCode`, `eth_simulateV1`, the chain id and block reads, paced and batched
  through Multicall3; one HTTP GET of the data function; run on the previous `signer.cjs`, whose only difference is that
  labelling, which none of these reads reaches): `allowlist-init --delay-ms 400 --r3-data <the live body>` against
  `https://mainnet.optimism.io` at block 157785485: 102 markets, **399 outcome tokens verified against
  `CTF.getPositionId`**, 98 children, pools pinned by fee tier `{"100":196}` (all 196 at tier 100, as G section 2 says), the data
  function's body cross-checked on 98 rows, no warnings, allowlist sha256 `aabe27db2d12eb2076122f1b8248d77638fe7ba8ec63eecc8671af81e95bc639` (the hash differs on every
  build: it covers `generated_at` and the block number). `check` accepted the live allowlist's approve, split and swap and refused the
  wrong tier, the foreign recipient and the unknown spender; `simulate` ran on the real `eth_simulateV1` (approve: `0x1`; an unfunded
  split: `0x0`, `SUsds/insufficient-balance`, exit 1).
* Not exercised: a real broadcast (forbidden for this build), the macOS `keychain` and Linux `secret-service` unlock paths (their
  commands are asserted against a stubbed process runner), Windows DPAPI **was** exercised with a throwaway password.
* Not verified by this build: how Claude Code's allow-rule matching treats an environment-variable prefix. The
  skill adds no allow rule for the signer (section 8), so nothing here depends on it.

