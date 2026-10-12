# chain-helper: the read-only chain helper for `deep-r3-trade`

The reference read-only chain helper of `deep-r3-trade` (`steps/I-setup.md` I.2 section 7, the paragraphs that start
"The allowlist is load-bearing" and "The rules for the helper without `node -e`"). It replaces `node -e` in the
autonomous wake's allow set. It ships in the skill's `scripts/` folder; the operator **reads it in full and installs a
copy** (Install, below); the agent does not install or edit it.

This file is `chain-helper.README.md`; the signer's is `signer.README.md`.

| File | What it is |
|---|---|
| `chain-helper.cjs` | the helper (one file, plain Node 22, CommonJS; its only dependency is `ethers` 6.17) |
| `chain-helper.config.example.json` | the config template; the helper refuses it until the placeholder signer address is replaced |
| `chain-helper.test.cjs` | offline and live read-only tests (`node chain-helper.test.cjs`) |
| `chain-helper.README.md` | this file |

## What it is, and what it cannot do

- **It reads.** Every request goes through one function that checks a fixed JSON-RPC method list before a socket is
  opened: `eth_chainId`, `eth_blockNumber`, `eth_getBalance`, `eth_getTransactionCount` (`latest` and `pending`
  only), `eth_getTransactionReceipt`, `eth_getTransactionByHash`, `eth_getBlockByNumber`, `eth_feeHistory`,
  `eth_gasPrice`, `eth_call`, `eth_getCode`, `eth_getLogs`, `eth_simulateV1`. Nothing named `eth_send*`, `eth_sign*`,
  `personal_*` or `wallet_*` exists in the file. (`eth_getLogs` is on the list because the spec lists it; no
  subcommand uses it today.)
- **It takes no URL, endpoint, header or output-path argument.** The RPC endpoint, the data-function URL, the chain
  id (10) and the pinned signer address live in `chain-helper.config.json` **next to the helper**. The path is derived
  from `__filename`, never from an environment variable or `argv`; any `--option` is refused.
- **No key access of any kind.** It never reads a keystore, a password or a wallet file. The only files it reads are
  its config and files under `./run/<run-id>/`; the only files it writes are `./run/<run-id>/r3-data.json` and
  `./run/<run-id>/tx-<hash>.input` (the source test pins this: one `fs.writeSync`, one `mkdirSync`, no `process.env`,
  no `child_process`).
- **Fails closed.** A missing, unparsable, symlinked, oversized or unexpected config (unknown key, wrong chain id, a
  non-https endpoint that is not loopback, a URL with credentials, a data-function URL that is not the Round 3 v3
  function, the zero-address signer) stops every subcommand with exit 3 before any network traffic. It also refuses to
  run when its own folder is inside the current directory (the project folder).
- **One JSON object on stdout**, never the raw body, never truncated: an answer longer than 28,000 characters (tool
  output is cut around 30k) is replaced by an `output_too_large` error (exit 7) that says how long it would have been.

## Install

1. Create a folder **outside the project folder** and outside every `Write` or `Edit` path the wrapper grants, for
   example `~/r3-tools/` (`%USERPROFILE%\r3-tools\` on Windows).
2. Copy `chain-helper.cjs` into it, and copy `chain-helper.config.example.json` next to it as
   **`chain-helper.config.json`** (exactly that name). Edit `signerAddress` to the pinned holder address (the public
   address in `run/wallet.json`; `owner()` under signer mode (b)). Review the file: the helper cannot tell a hostile
   `rpcUrl` from a good one, so the operator pins it.
3. Make `ethers` 6.17 resolvable from that folder: `cd <folder>`, then `npm init -y`, then
   `npm install ethers@6.17.0`, one command at a time (the same in every shell). (A copy
   inside the project finds `ethers` only through the project's `node_modules`, and the helper refuses to run from
   inside the project folder; an installed copy outside the project needs its own `ethers`.)
4. Put the path in both wrappers: `Bash(node <chain helper path> *)` and `PowerShell(node <chain helper path> *)`,
   where `<chain helper path>` is the full path to `chain-helper.cjs` (`steps/I-setup.md` section 7). Run it from the
   **project root**: every `./run/...` path is relative to the current directory.
5. Smoke test, from the project root: `node <chain helper path> chain-id` prints `{"chain_id":10,"expected":10,"ok":true}`.

Record the helper's sha256 as `chain_helper.sha256` in `setup.deep-r3-trade.json`, next to the signer's
`signer.sha256` (`steps/I-setup.md` I.1 section 7, *The setup record*, and I.2 section 7).

## Config: `chain-helper.config.json`

| Key | Required | Meaning |
|---|---|---|
| `chainId` | yes | must be the number `10` |
| `rpcUrl` | yes | JSON-RPC endpoint; `https` only (plain `http` only for `127.0.0.1`, `localhost`, `::1`); no credentials; must support `eth_simulateV1` (`https://mainnet.optimism.io` and `https://optimism-rpc.publicnode.com` do) |
| `dataFunctionUrl` | yes | the Round 3 v3 data function; its path must be exactly `/.netlify/functions/get-originality-r3-v3-markets-data`, no query, no fragment. The host is the skill's `R3_DATA_HOST`: **changing the host means re-reviewing this file** |
| `signerAddress` | yes | the pinned address used as `from` in `simulate` and for its pending nonce; the zero address is refused as the unreplaced placeholder |
| `requestTimeoutMs` | no | per HTTP request, 1000 to 120000, default 30000 |
| `retryBaseDelayMs` | no | first back-off delay, 0 to 10000, default 1000 (doubles per attempt, capped at 8 s; a `Retry-After` header is honoured up to 8 s) |
| `simulationOverrides` | no | config-only fake state for `simulate`, for tests and dry runs (below). Never settable from `argv` |

Any other key is an error. HTTP 429, 502, 503 and 504, and JSON-RPC rate-limit errors (`-32005`, or text such as "rate
limit") or "no backend is currently healthy" (`-32011`) inside HTTP 200, are retried up to 3 times with that
back-off, then fail as `rpc_rate_limited` (exit 5). Redirects are refused (a redirect would be an unpinned URL). Every
RPC request carries an `eth_chainId` probe; an endpoint on another chain is `chain_mismatch`. A request never has
more than 10 items; an endpoint that rejects batches is served one request at a time.

### `simulationOverrides`

```json
"simulationOverrides": {
  "balances":        { "<address>": "<wei>" },
  "erc20Balances":   [ { "token": "<address>", "holder": "<address>", "amount": "<raw>", "slot": 2 } ],
  "erc20Allowances": [ { "token": "<address>", "owner": "<address>", "spender": "<address>", "amount": "max", "slot": 3 } ]
}
```

They ride on the **first** `blockStateCalls` entry as `stateDiff` (never a full `state` replacement, which would wipe a
proxy's implementation slot) and carry through the later entries. `slot` is the Solidity storage slot of the token's
`balanceOf` or `allowance` mapping. Verified live on 2026-10-05: sUSDS `balanceOf` is slot 2 and `allowance` is slot
3; the Seer bundle-token wrapper's `allowance` is slot 4. When any override is set, `simulate` prints
`overrides_active: true` and a `warning`: **never gate a real send on such a result.**

## Conventions

- Run `node chain-helper.cjs <subcommand> <args...>` from the project root. Output is exactly one JSON line.
- **Success** exits 0 (a `data` fetch that was answered with a non-200 or an error body is still exit 0; read `usable`, and an error body first goes through C step 1's stop test).
- **Failure** prints `{"error": "<text>", "code": "<code>", ...}` and exits non-zero:

| Exit | Meaning | Codes |
|---|---|---|
| 1 | generic / decode | `decode_failed`, `data_not_json`, `data_shape`, `internal_error`, `internal` |
| 2 | usage | `usage`, `unknown_subcommand`, `unexpected_option`, `bad_argument`, `file_not_hex` |
| 3 | config | `config_missing`, `config_malformed`, `config_inside_project`, `ethers_version` |
| 4 | path refused | `bad_run_id`, `run_dir_missing`, and every `path_*` code below |
| 5 | network / RPC | `rpc_unreachable`, `rpc_http`, `rpc_rate_limited`, `rpc_malformed`, `rpc_error`, `chain_mismatch`, `block_not_found`, `response_too_large`, `data_unreachable`, `data_rate_limited`, `data_redirect`, `simulate_unsupported`, `simulate_failed`, `simulate_malformed` |
| 6 | method refused | `forbidden_method` |
| 7 | output too large | `output_too_large` |
| 8 | reverted | `call_reverted` (carries `revert_reason` and `revert_data` when the node returned them) |

`simulate_failed` (the node refused the whole `eth_simulateV1` request) carries `rpc_code`, so the refusals can be told
apart, and for the three known ones a `hint`: `-38026` (too many blocks: more than 256 entries), `-38013` (the text says
"intrinsic gas too low"; on `optimism-rpc.publicnode.com` it means the request-wide gas budget was passed) and `-38015`
(one entry used more than the 40M block gas limit). What to do is under `simulate` below.

- **File arguments** have one accepted form: **`run/<run-id>/<file>`**, relative to the current directory (a leading
  `./` is accepted). `<run-id>` matches `[A-Za-z0-9._-]+` (and does not start or end with a dot or name a reserved
  device); each later component matches `[A-Za-z0-9_-][A-Za-z0-9._-]*`. Everything else is refused with its own code:
  `path_empty`, `path_nul`, `path_too_long`, `path_unc` (`\\host\share`, `//host`), `path_drive` (`C:`),
  `path_absolute`, `path_colon` (alternate data stream), `path_traversal` (`..`), `path_malformed` (empty or `.`
  component), `path_outside_run` (does not start with `run/`), `path_too_short`, `path_component`, `path_not_found`,
  `path_symlink` (a symlink or junction anywhere on the way), `path_not_file`, `path_escape` (the real path leaves
  `./run/<run-id>/`), `path_file_too_large` (over 4 MB), `path_not_dir`. `./run` must already exist (`run_dir_missing`).
- **Arguments.** `<address>` is any valid address (checksummed or lowercase). `<txhash>` is `0x` plus 64 hex.
  Integers are decimal or `0x` strings (a JSON number above 2^53 is refused: quote it). A tuple or array argument is
  JSON (`[[addr,false,"0x1234"],...]`, or an object with named components). Windows PowerShell 5.1 strips the double
  quotes from native-program arguments, so quote-stripped JSON is accepted and parsed (bare tokens become strings), but
  the robust form for any tuple, array or long argument is **`"@run/<run-id>/<file>"`**: the argument's text is read
  from that confined file (same path rules and refusal codes as every other file argument; the text is trimmed and may
  end in a newline or CRLF; a file over 4 MB is `path_file_too_large`), so cmd, PowerShell and sh cannot differ. It
  works for every `call` and `encode` argument after the signature (tuple, array, `bytes`, a scalar address or integer)
  and nowhere else: not the `<to>` of `call`, not the signature, not `simulate`'s or `multicall`'s own file argument
  (those are already files). An argument that starts with `@` is always a file reference. **Write it in double quotes**:
  bare `@run/<run-id>/<file>` happens to work in Windows PowerShell 5.1, but a bare `@./run/...` is a PowerShell parse
  error that stops the whole command line, and `@name` is splatting syntax in PowerShell; the double-quoted form is
  passed through unchanged by cmd, PowerShell (5.1, tested) and sh. Always quote a signature in the shell:
  `"balanceOf(address)(uint256)"` (unquoted parentheses are a syntax error in PowerShell and a subshell in sh).

## Subcommands

`block <n> <address>`, `code`, `data-rows` and `multicall` are marked **extension**: they are not in the spec's list.
Everything else is the spec's list. An extension adds no write path, no method and no network target.

### `chain-id`
`{"chain_id":10,"expected":10,"ok":true}`. Fails with `chain_mismatch` if the pinned endpoint is on another chain.

### `block [latest|<number>] [<address>]`
```
{"number":157785026,"hash":"0x..","parent_hash":"0x..","timestamp":1791168829,"gas_limit":"40000000",
 "gas_used":"9968069","base_fee_per_gas":"1862","tx_count":24}
```
With `<address>` (extension) the block is read with full transactions and adds `"address"`, `"txs_from_total"` and
`"txs_from"` (at most 50): `[{"hash","nonce","to","value","input_bytes","input_keccak256"}]`. It never prints an
`input`. That is how a mined transaction from the signer at nonce `n` is found and matched by input hash without ever
holding the input.

### `nonce <address>`
`{"address":"0x..","latest":0,"pending":0}`.

### `balance <address>`
`{"address":"0x..","wei":"0","eth":"0.0"}`.

### `code <address>` (extension)
`{"address":"0x..","has_code":true,"bytes":3808,"code_keccak256":"0x.."}`. Never the bytecode.

### `receipt <txhash>`
Not mined yet: `{"found":false,"tx_hash":"0x.."}`. Otherwise
```
{"found":true,"tx_hash":"0x..","status":"0x1","success":true,"block_number":157785073,"transaction_index":7,
 "from":"0x..","to":"0x..","contract_address":null,"type":"0x2","gas_used":"442656",
 "effective_gas_price":"2805","l1_fee":"2263240592","logs_count":17}
```
Logs are counted, never printed.

### `tx <txhash> <run-id>`
Reads the transaction, writes the mined `input` (the `0x` hex text) to `./run/<run-id>/tx-<hash>.input` (hash
lowercased) and prints
```
{"found":true,"mined":true,"hash":"0x..","from":"0x..","nonce":3021552,"to":"0x..","value":"0",
 "block_number":157785073,"input_bytes":631,"input_keccak256":"0x..","input_path":"run/<run-id>/tx-0x..input"}
```
`from`, `nonce`, `to`, `value`, `input_bytes` and `input_keccak256` are the fields the spec names. Not found:
`{"found":false,"tx_hash":"0x.."}`. Known but not mined: `mined:false`, `block_number`, `input_bytes`,
`input_keccak256` and `input_path` are `null` and nothing is written. The `input_keccak256` is the settlement match
key of `G-mint-and-trade.md` step 4 (`calldata_hash`). The file can be passed to `keccak256` too.

### `fee-history`
```
{"oldest_block":157785021,"base_fee_per_gas":["1861",...11 values],"next_base_fee_per_gas":"1855",
 "gas_used_ratio":[0.41,...10 values],"reward_percentiles":[25,50,75],"reward":[["1","21","100000"],...10 rows],
 "gas_price":"1001857"}
```
Ten blocks, wei as decimal strings.

### `slot0 <pool>`
One Multicall3 `eth_call` (pool `slot0`, `liquidity`, `token0`, `token1`, `fee`, plus Multicall3 `getBlockNumber`), so
every field is from the same block:
```
{"pool":"0x..","block":157785058,"sqrt_price_x96":"72014628004435067639512964166","tick":-1910,
 "liquidity":"1138641802894253378367","token0":"0x..","token1":"0x..","fee":100,
 "price_token1_per_token0":"0.826194454899605030784310732145631948"}
```
`price_token1_per_token0` is `(sqrtPriceX96 / 2^96)^2` for the pool's own token order; applying the token0/token1
correction (`seer-protocol` section 6) is the caller's job. An address that is not a Uniswap V3 pool is
`decode_failed` or `call_reverted`, never a crash.

### `call <to> <signature> <args...>`
Encodes, `eth_call`s at `latest`, decodes with the declared returns. The signature is cast style
`name(in,in)(out,out)` with tuples written `(a,b)` and arrays `[]`, or a full `function ...` line.
```
{"to":"0x..","signature":"balanceOf(address)","block":157785060,"calldata_bytes":36,"raw_bytes":32,
 "raw_keccak256":"0x..","result":["0"],"raw":"0x0000..."}
```
`result` is the decoded outputs (every integer a decimal string, so nothing above 2^53 is ever rounded), `[]` when no
returns are declared. `raw` is present only when the answer is at most 1024 bytes. `block` is an `eth_blockNumber`
read in the same batch (it can be a block behind the block the call ran on; `slot0` and `multicall` read the block
inside the call). A revert is `call_reverted` (exit 8) with the decoded `Error(string)` or `Panic(code)`. A call to an
address with no code, or a function that returns nothing while returns were declared, is `decode_failed`.
The Uniswap QuoterV2 `quote*` functions are not `view` but are only ever `eth_call`ed, so they work as reads.
`allowances` and `balanceOf` are just `call`.

### `multicall <file>` (extension)
`call` on Multicall3 returns every inner answer as nested ABI hex: C step 2.7, the wrapped-token check (294 `wrappedOutcome`
reads) would print about 117,000 characters, over four times the output limit, and the wake has no `node -e` to decode
it. `multicall` is the same single `eth_call` to the pinned Multicall3 `aggregate3` with **`allowFailure: false`**,
built from a confined file, with each inner answer decoded by its own declared returns.

`<file>` is `run/<run-id>/<file>` holding a JSON list (1 to 500) of `{to, signature, args}`; `args` is a JSON list
(omit for none); a tuple or array argument may be a JSON value or a JSON string; no other key is allowed.
```
[{"to":"0x5d6a571b0f663c33831e6f81dd3c3f554eca188b","signature":"wrappedOutcome(uint256)(address)","args":["0"]},
 {"to":"0xb5b2dc7fd34c249f4be7fb1fcea07950784229e0","signature":"balanceOf(address)(uint256)","args":["0x..holder.."]}]
```
Output: `{"block":157785066,"count":2,"calldata_bytes":708,"results":[["0xE55A..."],["0"]]}`. `results[i]` is the list of
decoded outputs of read `i`, in file order. `wrappedOutcome` returns `(address,bytes)`; declare `(address)` to take
just the address (ethers decodes the prefix). A failed inner read fails the whole call (`call_reverted`, exit 8, from
Multicall3), and a read that returns no data (no contract, no such function) is `decode_failed` naming `index`: a
partial answer can never read as "nothing there". 294 reads print about 14,000 characters.
It serves every many-read step the skill describes without `node -e`: C step 2.7, C step 4's per-child
boundary reads, G's balance reads before and after a run, I.1 section 3's setup balances, and a batch of QuoterV2 quotes (tuple argument, four
returns; covered by a live test). Declare `getEthBalance(address)(uint256)` on the Multicall3 address for ETH, and
`getCurrentBlockTimestamp()(uint256)` there (no `args`) for the timestamp, as a decimal string, of the block the whole
answer comes from; C step 4 appends it to the file that holds the `getFinalizeTS` reads. A `multicall` that ends in exit 5
(`rpc_unreachable` for a timeout, `rpc_rate_limited`, ...) is an idempotent read: the helper has already retried a timeout or
a rate limit it recognizes 3 times itself (a throttle worded otherwise comes back at once as `rpc_error`: `steps/I-setup.md`
I.2 section 7, *Rate limits*), and `C-select.md` step 2, last paragraph, says how the run re-runs it. A cold node can need more
than the 30 s default for the 294-read file; the operator may raise `requestTimeoutMs` (1000 to 120000).

### `encode <signature> <args...>`
```
{"signature":"splitPosition(address,address,uint256)","selector":"0xd5f82280","bytes":100,
 "keccak256":"0x992a50a1c64a2e01963324c447fdd9a61c72ba1e8928439b81b6700cedc9b0c4","calldata":"0xd5f82280..."}
```
Pure computation, no network. Declared returns are accepted and ignored. Covers tuples, arrays and nested `bytes`
(`aggregate3((address,bool,bytes)[])`, `redeemPositions(address,address,uint256[],uint256[])`, the SwapRouter02
`exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))` and `exactOutputSingle(...)` structs, the
QuoterV2 `quoteExactInputSingle((address,address,uint256,uint24,uint160))` struct). The answer is one line; `calldata`
over 28,000 characters is `output_too_large` (a call that long cannot be handed to the signer as text anyway).
The caller copies `calldata` into a file under `./run/<run-id>/`; hash that file with `keccak256` and require it to
equal `encode`'s `keccak256`, which is how a mis-copied byte is caught.

### `simulate <file>`
`<file>` is `run/<run-id>/<file>` holding the ordered plan in **one of two forms** (a file never mixes them):

- **flat**: a list of `{to, data, value}`, the old form. One `blockStateCalls` entry per transaction, each call simulated
  with the real per-transaction gas cap (2^24). At most 256 transactions.
- **groups**: a list of `{"calls": [{to, data, value}, ...]}`. **One entry per group**, the group's calls in order inside
  the entry; state carries from call to call and from group to group. At most 256 groups. A group object holds only
  `calls`.

Per call `value` is optional (decimal or `0x` string, default 0), `data` is optional (even-length `0x` hex, default
`0x`) and `return` is optional (only the boolean `true`: it asks for that call's return data, see **`"return": true`**
below); no other key is accepted (`from` is pinned in the config; `gas`, `stateOverrides` and `blockOverrides` are
refused, at call level and at group level, because overrides are config-only). At most 500 calls in all. A flat list
without `return` is also a valid input for the signer's `check`; a file of groups, or any file with a `return` key, is a
helper input only (the signer reads one call list per file and refuses a key it does not know). Everything is
checked before any request: a bad file is `bad_argument` and nothing is sent. The helper sends **ONE** `eth_simulateV1`
request (`from` = the config's `signerAddress`, `validation: false`), plus the signer's `pending` nonce in the same
batch. A call in a group carries no `gas` of its own: the calls of a group share one simulated block, and a declared
gas of 2^24 per call fails the whole request with `-38015` as soon as the gas the entry has used so far plus 2^24 passes
the 40M block gas limit (measured: a parent split and seven middle splits, 29M used in all). A call whose peak is above 2^24
is reported as `over_cap` instead (below). The flat form keeps gas 2^24 per call.

The answer is one page. This is a grouped plan of four calls in two groups (approve and parent split, then approve and
middle split), exactly as printed:
```
{"from":"0x00000000000000000000000000000000000A11cE","input":"groups","entries":2,"count":4,"all_success":true,
 "failed_count":0,"first_failed_index":null,"first_failed_group":null,"over_cap_count":0,"first_over_cap_index":null,
 "clamped_count":0,"pending_nonce":0,
 "gas_limit_rule":"ceil(maxUsedGas x 1.2), clamped at 16777216; ceil(gasUsed x 1.5) for a call the RPC gave no maxUsedGas",
 "columns":["index","group","status","gasUsed","maxUsedGas","gas_limit"],
 "calls":[[0,0,"0x1",46000,46000,55200],[1,0,"0x1",607250,759062,910875],
          [2,1,"0x1",46000,46000,55200],[3,1,"0x1",4509738,5637172,6764607]]}
```
and with a failing call (the call after it in the same group is still simulated and reported):
```
{...,"all_success":false,"failed_count":1,"first_failed_index":1,"first_failed_group":0,...,
 "calls":[[0,0,"0x1",46000,46000,55200],[1,0,"0x0",21000,21000,25200],[2,1,"0x1",46000,46000,55200],[3,1,"0x1",4509738,5637172,6764607]],
 "failures":[{"index":1,"group":0,"to":"0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD","status":"0x0",
              "error":"execution reverted: ERC20: transfer amount exceeds balance","revert_reason":"ERC20: transfer amount exceeds balance"}]}
```

| Field | Meaning |
|---|---|
| `input` | `"flat"` or `"groups"` |
| `entries` | `blockStateCalls` entries sent: the groups, or for a flat list the same number as `count` |
| `count` | calls in the plan |
| `all_success` | every `status` is `0x1` **and** `over_cap_count` is 0. The caller refuses the plan when it is false, and also when `clamped_count` is above 0 (below) |
| `failed_count`, `first_failed_index`, `first_failed_group` | calls whose `status` is not `0x1`; the plan index and the group of the first (`null` when none) |
| `over_cap_count`, `first_over_cap_index` | calls whose peak (`maxUsedGas`, else `gasUsed`) is above 2^24 = 16,777,216: even with status `0x1` that call cannot be one transaction (the chain refuses a gas limit above 2^24), so split it. A grouped plan can show this because a grouped call has no gas cap of its own |
| `clamped_count` | calls whose `gas_limit` was cut to 2^24 (their peak times 1.2 is above it; every `over_cap` call is also counted here). Less than 20% headroom, so that batch is split, not sent (`G-mint-and-trade.md` section 8, *Gas limits*) |
| `pending_nonce` | the signer's `pending` nonce, read in the same batch |
| `gas_limit_rule` | the rule below, in words |
| `columns`, `calls` | one array per call: `[index, group, status, gasUsed, maxUsedGas, gas_limit]` |
| `failures` | present only when a call failed: for the **first 8 failing calls only** `{index, group, to, status, error, revert_reason}` (`revert_reason` is the decoded `Error(string)` or `Panic(code)` when the node returned data). A dependent plan that fails at step 1 fails every step after it, and the page must stay under the output limit. `error_detail_note` says so when more than 8 failed |
| `returns` | present only when some call carries `"return": true`: `[{index, group, return_data}]`, one object per flagged call, in plan order (below) |
| `no_max_used_gas_count` | present only when the RPC returned no `maxUsedGas` for some calls; a local anvil fork returns none (measured 2026-10-05), so every `gas_limit` is the `gasUsed x 1.5` fallback |
| `overrides_active`, `warning` | present only when the config carries `simulationOverrides`: statuses reflect fake balances, never gate a real send on them |

A row is `[index, group, status, gasUsed, maxUsedGas, gas_limit]`:
`index` is the call's position in the plan counted across groups, in send order (the caller's own transaction list has
the same order); `group` is the group index (a flat list is one group per transaction, so `group` equals `index`);
`status` is the node's (`"0x1"` succeeded); `gasUsed` and `maxUsedGas` are decimal integers (the RPC's hex, converted;
`maxUsedGas` is the field `eth_simulateV1` returns, `null` when the RPC returned none); and **`gas_limit` is the value to
put in the transaction: `ceil(maxUsedGas x 1.2)` from the same answer, clamped at 2^24, or `ceil(gasUsed x 1.5)` for a
call the RPC returned no `maxUsedGas` for.** `gasUsed` is net of refunds and a Router `splitPosition` hits the 20% refund
cap, so its peak is about 1.25 times its `gasUsed` (measured 2026-10-05: parent split gasUsed 607,250 and maxUsedGas
759,062; a 34-slot middle split gasUsed 4,509,738 and maxUsedGas 5,637,172): `gasUsed x 1.2` would run out of gas, which
is why the limit is taken from `maxUsedGas`. The rule is `G-mint-and-trade.md` section 8's.

**`"return": true`: the probe.** `simulate` prints no per-call return data, and `call` has no state override, so a quote on
the pool state an earlier part of the plan leaves cannot be had from either. A call in the file may carry
`"return": true`; for those calls (and only those) the page gains a compact `returns` list:
```
{"index":4,"group":1,"return_data":"0x00000000000000000000000000000000000000000000000000000000a19ac0ea..."}
```
`returns` follows `calls` in the page and is absent when no call is flagged (an unflagged plan prints exactly the page it
always did). Each object is `{index, group, return_data}`: `index` and `group` are the call's, as in `calls`; `return_data`
is the call's `returnData` as lowercase `0x` hex (`0x` when it returned nothing). **A failed flagged call returns its
revert data** (the node's `error.data`, which on both public RPCs is where it lives; `returnData` is `0x` there), for
example `0x08c379a0...` for an `Error(string)`; read whether the call failed from `calls[index]`'s `status`, not from
`returns`. Decode with `ethers` or `cast abi-decode`; the helper prints no decoded value.

- **Where it is accepted.** Only as the boolean `true`, on a call: a flat entry or a call inside a group. `false`,
  `"true"`, `1`, `null`, an object or a list are `bad_argument`, and so is a `return` on a group (a group holds only
  `calls`), on the file itself, as a `multicall` entry key, as an option (`--return`, `unexpected_option`) or in the config
  (`config_malformed`). The flag is never sent to the node: the request is byte for byte the one without it.
- **Caps, refused with `bad_argument` (exit 2).** At most **20 calls with `"return": true` per request** (the file is
  refused before any request, so nothing is sent; the other 480 calls of a 500-call plan need no flag). Each
  `return_data` at most **2048 hex digits** (1024 bytes, not counting the `0x`; a QuoterV2 `quoteExactInputSingle` answer
  is 256). The size of a return is known only after the simulation, so that check follows the request: the refusal names
  the call (`call 5 (group 2) gave 2050 hex characters of return data, over the 2048 limit`) and the page is never
  truncated. Drop `"return"` from that call, or probe a smaller one. A flagged call for which the node returned something
  that is not hex is `simulate_malformed`.
- **Page size.** The caps bound the request, not the page: 20 returns of 2048 digits are about 42,000 characters on their
  own, over the 28,000 cap, and such a request ends as `output_too_large` (exit 7, with the length it would have had).
  Realistic returns fit: measured against a mock with a 258-character (four-word) answer per flagged call, the 374-call
  plan in 100 groups with 20 returns is 20,916 characters when all pass and 27,052 with 74 failures in the tail whose
  flagged calls carry 340-character revert reasons (14,914 and 18,714 without returns). Several 1024-byte returns in a
  big plan can overflow; flag only what is read.
- **Use.** The step that needs a quote on simulated state builds `[mint prefix groups, the set group, a group holding the
  QuoterV2 call]` with the call flagged, and reads the quote from `returns`. State carries from call to call and from
  group to group (each group is its own simulated block), so the quote is on the pool state the set group left.
  QuoterV2's `quoteExactInputSingle` is not `view`, but a simulated call runs it like any other. `from` is the pinned
  signer; a quote does not depend on it. With config overrides in force the page carries the usual `overrides_active`
  warning, and a quote taken on fake balances is still not a send gate.
  Verified live (2026-10-05, both public RPCs): a flagged `getBlockNumber`, `balanceOf` and `quoteExactInputSingle` in
  group 2 return the node's values, a flagged revert returns its `Error(string)`, and the quote equals a plain
  `eth_call` quote at the same base block (the first entry of a simulation is block base+1, the second base+2; the live
  test reads the base block from a flagged `getBlockNumber` in the same simulation).

**Size.** Rows are about 40 characters, so the page for the 374-call plan in 100 groups is 14,914 characters when all
pass, 18,714 with 74 failures in the tail and 16,888 when all 374 fail (measured against a mock that returns realistic
widths; the cap is 28,000). The 500-call maximum with every call failing at 2^24 gas is 25,648. A flat list of 256
failing transactions is under 28,000 too. That is why a request is limited to 256 entries and 500
calls: a bigger plan is refused with `bad_argument` before anything is sent.

**Limits of the public RPCs** (measured 2026-10-05; the test measures the first line live on both):

| | `https://mainnet.optimism.io` | `https://optimism-rpc.publicnode.com` |
|---|---|---|
| 256 `blockStateCalls` entries in one request | accepted | accepted |
| 257 entries | `-38026` "too many blocks" | `-38026` "too many blocks" |
| total gas simulated in one request | accepted 71.7M (a 374-call plan in 100 groups, 71,661,876 gas) | about 50M (66 groups, 49,946,185 gas, passed; 67 and 100 groups gave `-38013` "intrinsic gas too low") |
| `maxUsedGas` returned per call | yes | yes (identical values) |
| historical `eth_call` depth | at least 1,500 blocks back | about 100 blocks back; older state is HTTP 403 "Archive requests require a personal token" |

An independent read of an older block (a `--block` comparison, below) therefore goes to `https://mainnet.optimism.io`;
`https://optimism-rpc.publicnode.com` answers only for roughly the last 100 blocks.

The helper refuses more than 256 entries itself (no request is made). When the node answers `-38026` or `-38013`
(`simulate_failed`, `rpc_code`, `hint`): use another RPC (the operator pins `rpcUrl` in the config; the helper takes no
URL), or split the plan at group boundaries into windows of at most 256 entries (and at most the RPC's gas budget), run
each window as its own file, begin every window with the mint prefix it depends on (a later window starts from chain
state, without the effects of the earlier windows), and say plainly that the answer was not one request. `-38015` means
one group used more than the 40M block gas limit: use smaller groups. The helper never raises the block gas limit
itself (`blockOverrides.gasLimit` is not portable: `optimism-rpc.publicnode.com` refuses 100M and `mainnet.optimism.io` refuses
1e9, both with `-38026` "Client adjustable limit reached").

An endpoint without `eth_simulateV1` is `simulate_unsupported`: stop, never simulate only the first transaction.
**Limit:** `validation: false` means the simulation does not check that the signer can pay gas in ETH; read `balance`
separately (`G-mint-and-trade.md` section 8's *Affordability* says what to compare it with, from this output's
`gas_limit` column and `fee-history`'s `gas_price`). A `0x1` status says the call would run on the state `latest` plus the earlier calls of the plan, nothing
more.

### `keccak256 <hex-or-file>`
An argument starting with `0x` must be even-length hex and is hashed as bytes; anything else is a file argument whose
trimmed content must be one even-length `0x` hex string.
```
{"keccak256":"0x56570de...","bytes":2,"source":"hex"}      {"keccak256":"0x992a50a...","bytes":100,"source":"file"}
```
A call's `data`, written to `run/<run-id>/<name>`, therefore gives its `calldata_hash` without a long argument.

### `data <run-id>`
`GET` the configured data function (no redirect, 429 backed off), write the **raw body, byte for byte,** to
`./run/<run-id>/r3-data.json` (the run-id folder is created if `./run` exists; a second `data` for the same run-id
overwrites, **including with an error body, so use a fresh run-id**) and print only a summary:
```
{"status":200,"bytes":119141,"sha256":"eb46d04...","content_type":"text/plain;charset=UTF-8","written":true,
 "path":"run/<run-id>/r3-data.json","usable":true,"json_valid":true,"has_error_field":false,"shape_ok":true,
 "markets":98,"parent_wrapped_tokens":4,"middle_markets":3,"markets_data_keys":98,"markets_missing_fields":0,
 "slots":{"min":0,"max":32,"distinct":33},"markets_open":98,"pools_null":0}
```
`usable` is true only for HTTP 200, valid JSON object, no `error` field, and all five top-level keys with every row
carrying `id`, `wrappedTokens`, `collateralToken`, `parentOutcome` and `marketStatus`. It is **not** a substitute for
C step 2's identity checks. A non-200 answer is reported as `status` with `usable:false` (exit 0); an unreachable
function is `data_unreachable` (exit 5). Either way: take C step 2's onchain fallback, unless the saved body's `error` text meets C step 1's stop test (it is read first, whatever `status`).

### `data-rows <run-id> <offset> <count>` (extension)
The raw body is one line of about 119 KB that the agent's file reader refuses, and the wake has no `node -e`; this is
the read-only, paginated projection of `./run/<run-id>/r3-data.json`. `count` is 1 to 30; a 30-row page is about
18,000 characters.
```
{"run_id":"..","offset":0,"count":1,"total":98,
 "header":{"parent_wrapped_tokens":["0x..",x4 lowercased],"parent_market_status":"open",
           "middle_markets":[["0xc217..",false],["0xf063..",false],["0x99a9..",false]],"middle_columns":["id","payoutReported"]},
 "columns":["i","repo","id","slot","collateral","status","wrapped[DOWN,UP,Invalid]","up[price,pool]","down[price,pool]"],
 "pool_columns":["liquidity","tick","feeTier","token0"],
 "note":"...",
 "rows":[[0,"ethereum/py_ecc","0x5d6a..",0,"0xc933..","open",["0xe55a..","0x3f86..","0xbda0.."],
          [0.826,["1138641802894253378367","-1910","100","0x3f86.."]],[0.192,["78852333593821140834","16495","100","0xc933.."]]]]}
```
Addresses are lowercased; `liquidity` stays a string; a pool the body reports as `null` stays `null`; a field the body
lacks is the string `"<missing>"`. It reads only the file `data` wrote. `header` carries what C step 2.5 and 2.6
compare (the parent's wrapped tokens and the three middle markets).

## The clearance test (`autonomy.blocked: needs-chain-helper`)

The pass rule is written once, in `steps/I-setup.md` I.2 section 7 (*The pipeline check*), and what is recorded in I.1
section 7 (*The setup record*, the `chain_helper` block). Its three parts, numbered here for the tests below: (1) a
`slot0` and a `payoutDenominator` read that match an independent read, (2) one `splitPosition` that the signer's
`check` accepts, (3) a two-transaction dependent sequence simulated through `simulate <file>` as two groups of
`[approve, split]` each (`[{"calls":[...]},{"calls":[...]}]`). A node that returns no `maxUsedGas` (the local anvil
fork returns none, measured 2026-10-05) cannot meet part (3)'s `maxUsedGas` requirement: `simulate` then prints
`no_max_used_gas_count` and falls back to `gasUsed x 1.5`, and the pass is recorded as `simulate_statuses_ok_at` with
`no_max_used_gas: true`.

**Automated, with a throwaway address and no key** (`node chain-helper.test.cjs` from anywhere; set
`R3_HELPER_TEST_TMP` to choose the scratch folder, `--offline` skips the live cases): the live cases cover
(1) `slot0` against a second endpoint at the same block (`sqrtPriceX96`, `tick`, `liquidity`, `token0`, `token1`, `fee`
all equal), `conditionId` and `payoutDenominator` of the parent, a middle and a child against the same reads on a second
endpoint (with a non-zero `totalSupply` control so equality is not 0 == 0), (3) the parent `splitPosition` followed by the
middle split that spends the bundle tokens it mints, both `0x1`, and the realistic four-transaction sequence
(`approve`, parent split, `approve` bundle, middle split) all `0x1`, with negative controls: the middle split alone is
`0x0`, a split with no approval fails with the token's own reason, and the same sequence without the config overrides
honestly fails; the same dependent sequence as **two groups** (a group is `{"calls":[...]}`; one group with the parent split, the next with the middle split, and again as approve plus split in each group), both `0x1` with `maxUsedGas` present on both public RPCs, with the second group alone failing as the control; and a 374-call plan in 100 groups sent as ONE request to both public RPCs. The offline cases also cover the `"return": true` probe (the flag, `returns`, the caps, revert data, the page size), and one live case runs a two-group simulation with config overrides whose second group holds a QuoterV2 `quoteExactInputSingle` (WETH/USDC, fee 500) flagged `"return": true`: the returned `amountOut`, `sqrtPriceX96After` and `initializedTicksCrossed` equal a plain `eth_call` quote at the same block (`gasEstimate` is `gasleft()`-based and is not compared). Part (2) is the operator's step, because the signer's allowlist and config live with the signer.

**By the operator, against the real holder** (from the project root; `<H>` is `node <chain helper path>`, `<RUN>` a
fresh run-id with an existing `./run/<RUN>/`):

1. Read: `<H> call 0x1F98431c8aD98523631AE4a59f267346ea31F984 "getPool(address,address,uint24)(address)" <UP token> <repo token> 100`
   gives a pool; `<H> slot0 <pool>` prints `block`, `sqrt_price_x96`, `tick`, `liquidity`. Read the same pool with a
   second tool at that `block` (for example `cast call <pool> "slot0()" --block <block> --rpc-url https://mainnet.optimism.io`;
   publicnode answers only for about the last 100 blocks, see *Limits of the public RPCs*) and compare.
2. `<H> call <market> "conditionId()(bytes32)"`, then
   `<H> call 0x8bdC504dC3A05310059c1c67E0A2667309D27B93 "payoutDenominator(bytes32)(uint256)" <conditionId>`; compare with
   `cast call` on a second endpoint. `0` is the expected live answer for an open market and is a legitimate match; add a
   non-zero control read (for example sUSDS `totalSupply()`) so the comparison is not 0 == 0.
3. Encode: `<H> encode "splitPosition(address,address,uint256)" 0xb5b2dc7fd34c249f4be7fb1fcea07950784229e0 0x37ab5cbeee3a32289430e5d38b914ec7f580fd87 1000000000000000000`;
   write `[{"to":"0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD","data":"<calldata>","value":"0"}]` to `run/<RUN>/split.json`
   and run the signer's `check` on it as the signer's README says. A `{"allowed":true}` answer is the pass.
4. Simulate: `run/<RUN>/txs.json` = `[ {"calls":[{sUSDS approve(Router, a)}, {parent splitPosition}]}, {"calls":[{bundle
   token approve(Router, a)}, {middle splitPosition}]} ]` (two keep-whole groups of `[approve, split]`, `a` at most the
   holder's sUSDS; both splits with collateral sUSDS: `splitPosition(sUSDS, <market>, amount)`; the parent and middle
   addresses are in `C-select.md`). The approvals are calls of the plan, so the holder needs only the sUSDS and no
   allowance, and the config's `simulationOverrides` stay unset (they are for the tests above: a result with them is
   no send gate, and the agent never sets or edits them). Then `<H> simulate run/<RUN>/txs.json`. Pass =
   `"all_success":true`, every `"status":"0x1"` and a `maxUsedGas` on every row (one row per call, `group` 0 and 1); on a
   node that returns none, the `no_max_used_gas_count` case above.

## Notes and known limits

- `simulate` sends one `blockStateCalls` entry per group (per transaction for a flat list); state carries from call to
  call and from entry to entry. A flat list gives every transaction its own block, so none can be refused for a shared
  block gas limit, at the price of 256 transactions at most; a grouped plan fits a 374-call plan in 100 entries but its
  groups share the 40M block gas limit of their entry. The page is one array row per call (about 40 characters), so
  374 calls take about 15,000 characters.
- A first-use `./run/<run-id>/` folder is created only by `data` and `tx`.
- `eth_getLogs` is allowed but unused; a future subcommand needs a test and a README entry first.
- Output order inside objects is stable; fields documented above are the contract, extra fields may be added.
- `block <n> <address>` reads one block per call. At roughly two-second blocks a long scan is thousands of calls; the
  caller should start from a block number it recorded at send time.
- Tests never send: the helper cannot, and the only "key" in them is `ethers.Wallet.createRandom().address`, an address
  used as the pinned signer in simulations.
