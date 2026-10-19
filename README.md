# R3 Originality trading bot

A bot that trades the 98 **Deep Funding Round 3 "Originality"** prediction markets on
[deep.seer.pm](https://deep.seer.pm) (Seer, on the Optimism chain). Each market asks for one GitHub repo's average
originality score (0 to 100), and you can buy UP or DOWN on each one.

**You give it your forecast as a CSV**, in the same format as the upload on deep.seer.pm: one row per repo with the
score you expect, from 0 to 1 (0.62 means you expect 62). The bot then does every day what you would do by hand in the
Seer interface: it compares your forecast with each market's price and trades wherever your forecast beats the price.
It never forecasts on its own, and it does not depend on which AI runs it. Any AI coding agent that can read the skill
files and run commands (Claude Code, Codex or another) can do the setup and the supervised runs; the scheduled runs use
no AI at all.

> **Strategy write-ups wanted.** Seer will open write-ups on trading strategies built on this bot, with **$1,000 for
> the best one**. Running the base bot unchanged doesn't qualify: change a step (`.claude/skills/deep-r3-trade/steps/`)
> and show what it did.

Each run does the following:

1. **Forecast.** It reads your stored CSV, the latest version you supplied. A repo you leave blank gets no directional
   trade.
2. **Compare and size.** It takes your forecast at face value and buys wherever it beats the pool price, until the edge
   or your treasury runs out. Thin pools mean small trades: runs so far moved between about 15 and 100 sUSDS.
3. **Trade.** It mints, trades, merges and redeems through a **signer that only signs calls on its allowlist**.
4. **Report.** It writes everything under `run/<run-id>/`, including `report.md`.

On the original machine it runs **twice a day from Windows Task Scheduler** (11:30 and 21:30) on the latest CSV, with
no AI agent in the trading path. You can also run it by hand through your AI agent, which then asks for a "yes" before
each batch is sent.

> Real money, experimental software. Use a wallet made only for this bot, and fund it with what you can afford to lose.

## What's in this repo

| Path | What it is |
|---|---|
| `.claude/skills/deep-r3-trade/` | The skill: `SKILL.md` (overview), `steps/` (the method, steps C to I), `scripts/` (planner, chain helper, signer, and their tests) |
| `.claude/skills/seer-trade/`, `seer-protocol/`, `evm-onchain/`, `wallet-setup/` | Supporting skills: the reasoned arm for other Seer markets, how Seer works onchain, Optimism addresses and gas, the encrypted-wallet tool |
| `wake-deep-r3.cmd` | The scheduled run, started by Task Scheduler |
| `register-deep-r3-wake.ps1` | Registers that task (11:30 and 21:30 by default) |
| `r3.cmd` | Runs planner commands by hand on Node 22 |
| `tools/` | Read-only helpers: book status, an independent second-RPC check, who swapped in our pools, watching a send |
| `scope/r3-originality.json` | A human-readable list of the 98 markets |
| `setup/signer.config.json` | The original machine's signer config, kept as an example |

**Not in the repo:** `run/` (trade records, your stored CSVs and the setup record), `inputs/` (your CSV drafts),
`.env`, and any key or password. Each machine keeps its own.

## Your forecast CSV

```csv
repo,originality
https://github.com/ethereum/py_ecc,0.62
https://github.com/paradigmxyz/reth,
```

- Two columns, `repo` and `originality`. The repo is its GitHub URL (or `owner/repo`), spelled exactly as on
  deep.seer.pm.
- `originality` is the score you expect divided by 100, from 0 to 1. A blank cell means you have no view: that market
  gets no directional trade, while the forecast-free arbitrage still runs.
- Make it however you like: by hand, in a spreadsheet, or with your own research tools. The bot only reads the file.

Supply it, or a new version of it, in a supervised run. Keep your CSVs in `inputs\`, which git ignores:

```powershell
.\r3.cmd c <run-id>
.\r3.cmd d <run-id> --supply inputs\my-forecast.csv
```

The second command reports how many rows matched a market, which rows did not, and which markets have no forecast. It
stores nothing. When the counts look right, store it:

```powershell
.\r3.cmd d <run-id> --supply inputs\my-forecast.csv --continue
```

It becomes the next version under `run\csv\` (a version is never overwritten), and every later run uses it until you
supply another. A run-id is any new name in the form `2026-10-19T0300Z` (UTC); add a suffix such as `-csv-v2` if you
like.

## How it fits together

Three tools are installed **outside** the project folder, and each one refuses to run from inside it:

- **Chain helper** (`chain-helper.cjs`): reads the chain and the Seer data function, and simulates transactions. It never signs.
- **Signer** (`signer.cjs`): the only part that can sign. It decrypts the wallet only inside its own process, only for
  calls on its allowlist (the Seer Router, Uniswap's SwapRouter02 for these markets' pools, and PSM3), and can sweep
  funds only to your `owner` address.
- **Planner** (`planner.cjs` and `planner/`): runs steps C to H, calling the helper for every read and the signer for every send.

A scheduled run goes like this: Task Scheduler starts `wake-deep-r3.cmd`, which checks its lock and the tools' hashes,
then runs `planner wake <run-id>`. The planner then:
1. repairs anything an earlier run left unfinished;
2. selects the markets (C), reads your stored CSV (D) and sets it beside the prices unchanged (E);
3. converts any USDC to sUSDS (PSM3);
4. sizes the positions (F), builds the plan (G) and sends it (exec);
5. merges and redeems settled positions (Half B), then scores them (H);
6. writes `run/<run-id>/report.md`.

With no CSV stored yet, a run makes no new trades (it still cashes in and scores), and the wrapper exits 5.

## Setting it up on a new Windows laptop

### What you need first

- Windows 10 or 11, and [Git](https://git-scm.com).
- **Node.js 22 LTS**, not 24. Node 24 crashes on exit on Windows, which makes a transaction that landed look like a
  failure. The portable zip from nodejs.org is fine.
- An **AI coding agent** that can read this repo's skill files and run commands, for the setup and the supervised runs:
  for example Claude Code, which loads `.claude/skills/` by itself, or Codex. The scheduled runs need none.
- A **new wallet just for this bot**, with on Optimism:
  - some ETH for gas: the bot never spends its last 0.002 ETH, so start with about 0.006;
  - sUSDS, or USDC, which the bot converts to sUSDS itself.
- **Your forecast CSV** (above).

### Steps

1. **Get the code** into a folder of your choice. This folder is "the project".

   ```powershell
   git clone https://github.com/sunvalley1/r3-originality-bot.git
   ```

2. **Open the project in your AI agent** and ask it to "set up the deep-r3-trade wallet". If your agent does not load
   skills by itself, point it at `.claude/skills/deep-r3-trade/SKILL.md` first. The skill walks you through
   `steps/I-setup.md` I.1:
   - creating an encrypted wallet: the keystore and a Windows-protected password go in
     `%USERPROFILE%\.foundry\agent-wallet\`, and the public address goes in `run\wallet.json`;
   - funding it;
   - installing the three tools.

   The installs can also be done by hand. Each tool's README in `.claude/skills/deep-r3-trade/scripts/` has the details.

   | Tool | Install to | What to do |
   |---|---|---|
   | Chain helper | `%USERPROFILE%\r3-tools\` | Copy `chain-helper.cjs`. Copy `chain-helper.config.example.json` as `chain-helper.config.json` and set `signerAddress` to your bot wallet. Run `npm init -y`, then `npm install ethers@6.17.0`. Check it from the project folder with `node %USERPROFILE%\r3-tools\chain-helper.cjs chain-id`, which should print `"ok":true`. |
   | Signer | `%USERPROFILE%\.r3-signer-bin\` | Run `npm install ethers@6.17.0 --save-exact`. Copy `signer.cjs`. Fill in `signer.config.json` from `signer.config.example.json`. Run `node signer.cjs allowlist-init --skill-dir <project>\.claude\skills\deep-r3-trade` and put the printed hash in `allowlistSha256`. Check that `node signer.cjs info` shows `allowlist_hash_matches: true`, then run the self-test (signer README section 7). |
   | Planner | `%USERPROFILE%\r3-tools\planner\` | Copy `planner.cjs` and the whole `planner\` folder. Fill in `planner.config.json` from `planner.config.example.json`. Run `npm init -y`, then `npm install ethers@6.17.0 --save-exact`. |

3. **Change the machine-specific lines** listed in the next section.

4. **Supply your forecast, then dry-run.** Pick a run-id in the form `2026-10-19T0300Z` (UTC). The last command
   simulates the whole plan and **sends nothing**:

   ```powershell
   .\r3.cmd c <run-id>
   .\r3.cmd d <run-id> --supply inputs\my-forecast.csv
   .\r3.cmd d <run-id> --supply inputs\my-forecast.csv --continue
   .\r3.cmd e <run-id>
   .\r3.cmd f <run-id>
   .\r3.cmd g <run-id>
   .\r3.cmd exec <run-id> --check
   ```

5. **First real run, supervised:** ask your agent to run deep-r3-trade (in Claude Code, `/deep-r3-trade`). It builds
   the plan and asks for a "yes" before each batch.

6. **Turn on the schedule** only after a clean supervised run. The skill's I.2 records your authorization in
   `run\setup.deep-r3-trade.json`. Then register the task:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\register-deep-r3-wake.ps1
   ```

## Lines to change for your own laptop and wallet

These files carry the original machine's paths (`C:\Users\12\...`) and wallet. The skill's scripts themselves need no
edits, because they take every path from the config files above.

| File | Line | What it holds now | Change it to |
|---|---|---|---|
| `r3.cmd` | 7 | The Node 22 path and the planner path | Your `node.exe` (Node 22) and your `...\r3-tools\planner\planner.cjs` |
| `wake-deep-r3.cmd` | 13 | `set "NODE=..."` (the Node 22 path) | Your `node.exe` (Node 22) |
| `wake-deep-r3.cmd` | 23 | The signer's send-lock path | The `sendLockPath` from your `signer.config.json` |
| `wake-deep-r3.cmd` | 24 | The signer's log path | The `logPath` from your `signer.config.json` |
| `tools/indep-check.cjs` | 4 | `require('C:/Users/12/r3-tools/node_modules/ethers')` | Your `.../r3-tools/node_modules/ethers` |
| `tools/r3-status.cjs` | 4 | The same `ethers` path | Your `.../r3-tools/node_modules/ethers` |
| `tools/r3-status.cjs` | 7 | `HOLDER` = the original bot wallet | Your bot wallet address, in lower case |
| `tools/who-swapped.cjs` | 3 | The same `ethers` path | Your `.../r3-tools/node_modules/ethers` |
| `tools/watch-exec.ps1` | 17 | The path of `keep-awake.ps1` | `<your project>\tools\keep-awake.ps1` |
| `setup/signer.config.json` | 4 to 14 | The original machine's signer config | Use it only as an example; your real config lives next to `signer.cjs`. Set `signerAddress` (your bot wallet), `owner` (your own main wallet, the only address the signer can sweep to), `projectRoot`, `keystorePath`, `unlockPath`, `allowlistPath`, `allowlistSha256`, `sendLockPath` and `logPath`. Use `https://mainnet.optimism.io` for `rpcUrl`, since the endpoint in this draft returned HTTP 500 errors. |

`wake-deep-r3.cmd` reads the planner and signer paths themselves from `run\setup.deep-r3-trade.json`
(`autonomy.planner_path` and `autonomy.signer_path`), which setup writes. `register-deep-r3-wake.ps1` needs no edits.
To register other run times, pass them like this:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "& .\register-deep-r3-wake.ps1 -At '09:00','21:00'"
```

## Running and checking it

- **When it runs:** the task runs as you, and only while you are logged in. It can wake the PC from sleep, and a
  missed time slot runs once when the PC is back.
- **Change your forecast:** supply a new CSV version any time (see *Your forecast CSV*); the next run uses it.
- **What happened:** read `run\wake-deep-r3.log`, then the newest `run\<run-id>\report.md` and `wake-status.json`.
- **Pause and resume:**

  ```powershell
  Disable-ScheduledTask -TaskName deep-r3-wake
  Enable-ScheduledTask -TaskName deep-r3-wake
  ```

- **Status of the book** (read-only):

  ```powershell
  node tools\r3-status.cjs run\<run-id> <from-block>
  ```

- **Tests**, from `.claude\skills\deep-r3-trade\scripts\`, with `NODE_PATH` pointing at a `node_modules` folder that
  holds `ethers` 6.17.0. The planner suite takes 50 to 100 minutes. The signer and chain helper suites are
  `signer.test.cjs` and `chain-helper.test.cjs`.

  ```powershell
  node planner.test.cjs --dir <scratch folder>
  ```

## Safety rules

- Never put a private key, keystore or password in this folder or in a chat. The signer refuses key material inside the project.
- Use a wallet made only for this bot, and fund it with what you can afford to lose.
- Run one copy of the bot per wallet. Two machines sending from the same wallet clash on nonces.
- Keep `run\` and `inputs\` out of git (both are in `.gitignore`): they hold your trade history and your forecasts.
- The skill text (`.claude/skills/deep-r3-trade/SKILL.md` and `steps/`) is the authority whenever this README and the skill disagree.
