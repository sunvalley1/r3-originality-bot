# R3 Originality trading bot

A bot that trades the 98 **Deep Funding Round 3 "Originality"** prediction markets on
[deep.seer.pm](https://deep.seer.pm) (Seer, on the Optimism chain). Each market asks for one GitHub repo's average
originality score (0 to 100), and you can buy UP or DOWN on each one.

**An AI agent runs every supervised run and every routine run.** The bot is a Claude Code skill (`.claude/skills/deep-r3-trade/`): the agent reads its
steps and runs them, by hand in a session or on a schedule as a **Claude Code routine**, which runs in the cloud on any
operating system with no machine left on. The supervised sessions work with any AI coding agent that can read the
skill files and run commands.

**The forecast is a CSV you provide** (`steps/D-forecast.md`, `steps/D-methods/csv.md`), in the format of
deep.seer.pm's upload: trading through the bot is then trading through the interface, every day. Other ways to
forecast, such as an AI researching each repo, a model or a pool of forecasters, are yours to build as a change to
step D; the bot does not include them.

> **Strategy write-ups wanted.** Seer will open write-ups on trading strategies built on this bot, with **$1,000 for
> the best one**. Running the base bot unchanged doesn't qualify: change a step (`.claude/skills/deep-r3-trade/steps/`)
> and show what it did.

Each run does the following:

1. **Forecast.** It takes your stored CSV. A market with no forecast gets no directional trade.
2. **Compare and size.** It takes the forecast at face value and buys wherever it beats the pool price, until the
   edge or your treasury runs out. Thin pools mean small trades: runs so far moved between about 15 and 100 sUSDS.
3. **Trade.** It mints, trades, merges and redeems through a **signer that only signs calls on its allowlist**.
4. **Report.** It writes everything under `run/<run-id>/`, including `report.md`.

> Real money, experimental software. Use a wallet made only for this bot, and fund it with what you can afford to lose.

## What's in this repo

| Path | What it is |
|---|---|
| `.claude/skills/deep-r3-trade/` | The skill: `SKILL.md` (overview), `steps/` (steps C to I), `routines/` (what the trading routine's agent does), `scripts/` (planner, chain helper, signer, the routine runner, and their tests) |
| `.claude/skills/seer-trade/`, `seer-protocol/`, `evm-onchain/`, `wallet-setup/` | Supporting skills: the reasoned arm for other Seer markets, how Seer works onchain, Optimism addresses and gas, the encrypted-wallet tool |
| `r3.cjs` | The one command, on any OS: `node r3.cjs install`, `trade`, `clearance`, `selftest`, `status`, and `planner <subcommand>` for supervised runs |
| `routine.config.example.json` | The template of `routine.config.json`: your wallet, your own address, the signer's allowlist |
| `tools/` | Read-only helpers: book status, an independent second-RPC check, who swapped in our pools |
| `scope/r3-originality.json` | A human-readable list of the 98 markets |
| `setup/signer.config.json` | The original machine's signer config, kept as an example |

**Not in this repo:** `run/` (trade records, stored CSVs, the setup record), `inputs/` (your CSV drafts), and any key
or password. Your routine keeps `run/` in **your own private copy** of this repo (below).

## Your forecast

Two columns, the same format as deep.seer.pm's upload:

```csv
repo,originality
https://github.com/ethereum/py_ecc,0.62
https://github.com/paradigmxyz/reth,
```

- The repo is its GitHub URL (or `owner/repo`), spelled exactly as on deep.seer.pm.
- `originality` is the score you expect divided by 100, from 0 to 1. A blank cell means you have no view: that market
  gets no directional trade, while the forecast-free arbitrage still runs.
- Make it however you like: by hand, in a spreadsheet, with your own research or with an AI. The bot only reads it.

Supply it, or a new version, in a supervised session in your trading clone, after a `git pull`; keep your drafts in
`inputs/`, which git ignores:

```bash
node r3.cjs planner c <run-id>
node r3.cjs planner d <run-id> --supply inputs/my-forecast.csv
node r3.cjs planner d <run-id> --supply inputs/my-forecast.csv --continue
```

The second command reports how many rows matched a market, which did not, and which markets have no forecast, and
stores nothing. The third stores it as the next version under `run/csv/` (a version is never overwritten), and every
later run uses it, once pushed, until you supply another. A run-id is any new name in the form `2026-10-23T0300Z`
(UTC). A new file replaces the old one whole: a market missing from it gets no new trades.

The trading routine works on a fresh clone of your trading repository, so it only sees a new version once you push
it (if the push is rejected because a run pushed meanwhile: `git pull --rebase`, then `git push`):

```bash
git add -f -- run/csv
git commit -m "csv: new version"
git push
```

**Another way to forecast** is a change to step D, and yours to build. Keep D's contract (`steps/D-forecast.md`: what
it reads, the `base-forecast.json` it writes, its checks and rules), and the rest of the bot runs unchanged on it.
Change one thing per run, dry-run it first (`node r3.cjs clearance`, which sends nothing), and run anything that reads
web pages outside your trading repository.

## How it fits together

Three tools are installed **outside** the project folder, and each one refuses to run from inside it:

- **Chain helper** (`chain-helper.cjs`): reads the chain and the Seer data function, and simulates transactions. It never signs.
- **Signer** (`signer.cjs`): the only one of the three tools that signs. It decrypts the wallet only inside its own process, only for
  calls on its allowlist (the Seer Router, Uniswap's SwapRouter02 for these markets' pools, and PSM3), and can sweep
  funds only to your `owner` address.
- **Planner** (`planner.cjs` and `planner/`): runs steps C to H, calling the helper for every read and the signer for every send.

`node r3.cjs install` lays all three down from this repo, with their configs, and reports whether the planner and the
signer match the paths and hashes your setup record pins. `node r3.cjs trade` refuses to run (exit 4) unless the
setup record pins exactly the planner and signer `install` laid down; it never runs a path the record names instead.

A scheduled run is the **trading routine**. Its agent first checks that the code is still the commit its prompt pins
(below), then runs `node r3.cjs install`, then `node r3.cjs trade --push`, which:
1. reads the setup record, takes the lock and checks the planner's and signer's paths and hashes against the record;
2. runs the planner's `wake`, which repairs anything an earlier run left unfinished; selects the markets (C); takes the
   forecast (D) and sets it beside the prices unchanged (E); converts any USDC to sUSDS (PSM3); sizes the positions (F),
   builds the plan (G) and sends it (exec); merges and redeems settled positions (Half B), then scores them (H);
3. writes `run/<run-id>/report.md`, and commits and pushes the run's records (`run/` only) to the trading repository.

**Your private copy.** You keep one private copy of this repo, the **trading repository**: the code,
`routine.config.json`, `setup/r3-allowlist.json` and the run records in `run/`. Only you and the trading routine (with
its one-off setup run) use it, and the routine pushes `run/` only. The trading routine attaches it alone, and its
session starts inside that clone.

Why only you and the routine push to it: when a session starts, before the agent's first command, Claude Code loads
what the repository holds: the clone's `.claude/settings.json` (permission rules, hooks, environment) and `.mcp.json`,
and its `CLAUDE.md`, `.claude/rules/`, `.claude/skills/`, `.claude/agents/` and `.claude/commands/`. The code pin
(below) cannot cover any of it. A hook pushed into the trading repository would run where the key is, before any
check, and a `CLAUDE.md` or a skill reaches the agent as instructions. So whoever can push to the trading repository
controls the key.

**The code pin.** The trading routine's prompt, stored in claude.ai and not in the repo, pins the code of one commit by
its tree fingerprint: the git tree of everything outside `run/`, which `git ls-tree <commit> | awk -F '\t' '$2 != "run"' |
git mktree` prints (in Git Bash or another POSIX shell, not PowerShell or cmd). The agent's first command, in the
trading clone, is:

```bash
test "$(git ls-tree HEAD | awk -F '\t' '$2 != "run"' | git mktree)" = <pinned tree>
```

Exit 1 means the fingerprint does not match: either the code differs from the pinned tree, or git could not compute
it (git then prints an error, for example outside the trading clone). Either way the agent stops, reports the exit
code and any error, and reads and runs nothing else. The check needs no history: the routine's
clone is shallow, and every run pushes its records as about two hundred commits (a checkpoint every 20 seconds), so a check
that looks up the pinned commit itself (`git diff <commit> HEAD`) fails with "bad object" a run or two later.
Everything outside `run/` is pinned: the code, `routine.config.json`, `setup/` with the allowlist, `routines/*.md` and
the skill's steps. The pin cannot cover what Claude Code loads at session start (above): that is why only you and the
trading routine push to that repository. `run/` is not pinned: it holds the records, the stored CSVs and the setup
record, whose consent fields and pins steer the run. After any change outside `run/`, clear the new commit and update
the pin (*Running and checking it*).

## Setting it up

**Follow [SETUP.md](SETUP.md), step by step.** Open this repository in your AI agent and say "walk me through
SETUP.md": it checks where you are and guides you, doing the commands while you do everything that touches your key,
your money or a website login. In short:

0. What you need: Git, Node.js 22, Foundry's `cast`, a scheduler (a Claude plan with routines and Claude Code, or a
   ChatGPT plan with Codex scheduled tasks), a new wallet funded on Optimism, your CSV.
1. A **private copy** of this repository, the *trading* repository, with the Claude GitHub app given access.
2. Deny rules for the key folders, then the **bot wallet** as an encrypted keystore with a text password
   (`cast wallet new ~/.foundry/keystores r3-bot` or `cast wallet import r3-bot --interactive`), funded on Optimism.
3. `routine.config.json`, `node r3.cjs install` (a first install stops and names the signer's `allowlist-init`), the
   allowlist copied to `setup/` with its sha256, `install` again, and the key files on your computer.
4. Your CSV, then the **first real run, supervised**: a "yes" before each batch, then the first question and the signer
   self-test.
5. Push your private copy (`run/` included, never the lock).
6. The **cloud environment** `r3-trade` on claude.ai: a network allowlist and four variables, the key as the
   keystore's text in single quotes, `R3_KEYSTORE_JSON='{...}'`, never the raw private key.
7. The **trading routine**, pinned to your commit's tree fingerprint and created with Claude Code's `/schedule` so its
   tool lists are set, then its **setup run**: a Run now of it with a setup prompt and two extra tools.
8. Record the setup run in the setup record, give the routine back its trading prompt and tools, answer the second
   question, turn the routine on.

   With Codex instead of steps 6 to 8: a Codex scheduled task on your own computer (it must be on, with the ChatGPT
   app open, at run times), its permissions, a no-send clearance on that computer, the second question, and one run by
   hand (SETUP.md, "6 to 8 with Codex instead").
9. Check the first scheduled run.

SETUP.md also has a troubleshooting table and what another cloud (Codex, GitHub Actions) must provide.
`steps/I-setup.md` is the full version of steps 2 to 8: I.1 for the wallet, I.2 §1 and I.1 §7 for the questions and
the self-test, I.2 §7 for the repository, the routine and the setup run.

## Running and checking it

- **What happened:** each run's session is listed under the routine, with the agent's report as its last message.
  In your trading repository, read the newest `run/<run-id>/report.md` and `wake-status.json`, or `node r3.cjs status`.
- **Change your forecast:** supply a new CSV version (*Your forecast*, above).
- **Change the code or the config:** anything outside `run/` (a step, `routine.config.json`, the allowlist) is
  pinned. Review the new commit, including any `.claude/`, `CLAUDE.md` or `.mcp.json` file it adds or changes (the pin
  cannot stop those at session start), and push it. Make a setup run with the new commit's tree fingerprint in its prompt (SETUP.md step 7). If
  `planner.cjs` or `signer.cjs` changed, record the new paths and hashes its `install` printed in the setup record; a
  changed signer also needs the self-test's pass and the second question again (`steps/I-setup.md` I.2 §1). Commit
  `run/`, then put the new commit's tree fingerprint in the trading routine's prompt and in its pin-check tool entry
  (with `/schedule update` in Claude Code: the claude.ai form changes the prompt, not the tool lists). Until you do,
  the trading run stops at its pin check. With a Codex scheduled task, there is no setup run: SETUP.md, *Afterwards,
  with Codex*.
- **Update from an install made before 25 Oct 2026:** delete `forecastImport`, `planner.forecastMethod` and
  `planner.forecastMaxAgeHours` from your `routine.config.json`. The forecast-file method and its research routine
  were removed from the base skill; `install`, `trade` and `clearance` refuse a config that still holds those keys and
  name the one to delete.
- **Pause:** turn the routine off in claude.ai, or set `autonomy.enabled` to false in `run/setup.deep-r3-trade.json`
  and push it. Neither stops a run already in progress. Removing the two key variables from the trading environment
  stops new runs from getting the key. It does not reach a past run: its VM pauses with its files saved, the key files
  `install` wrote among them, and continuing its session restores it. Never continue a trading run's session. With a
  Codex scheduled task: pause it in the app, and set the field in the clone on that computer; a push does not reach
  it, because it never pulls.
- **A supervised send from your own machine:** pause the trading routine (or the Codex task) first and make sure no
  run is live.
  `r3.cjs`'s lock lives in one clone, so it does not stop a cloud run and a local session from sending at once. For
  the same reason, never Run now while a scheduled run is live.
- **Status of the book** (read-only): `node tools/r3-status.cjs run/<run-id> <from-block>`.
- **Tests**, from `.claude/skills/deep-r3-trade/scripts/`, with `NODE_PATH` pointing at a `node_modules` folder that
  holds `ethers` 6.17.0. The planner suite takes 50 to 120 minutes. The signer and chain helper suites are
  `signer.test.cjs` and `chain-helper.test.cjs`.

  ```bash
  node planner.test.cjs --dir <scratch folder>
  ```

`tools/*.cjs` carry the original machine's `ethers` path and wallet in their first lines; change them to yours.

## Safety rules

- Never put a private key, keystore or password in this repo, your private copy, or a chat. The trading routine
  takes the key from its environment, and `install` writes it outside the project for the signer. Nothing makes it
  impossible for the routine's agent to read it: a routine runs in auto mode, where a command on neither tool list
  goes to a classifier instead of being refused, and a `Read` deny rule does not cover what a shell command reads. The
  trading environment's network allowlist does not stop a leaked key from being used either: the allowed RPC can
  broadcast a transfer signed with a leaked key. What protects the key: who can push to the trading repository (only
  you and the trading routine) and what loads at session start; the code pin; the narrow tool lists and their deny
  rules; auto mode's classifier; `r3.cjs`'s refusals; the agent's instructions; your claude.ai and GitHub accounts,
  which hold the prompt with the pin, the tool lists and the readable environment; and `ethers` 6.17.0 and its
  dependencies from the npm registry, which the signer loads with the key. The signer's allowlist bounds what the
  signer signs, not a leaked key. Keep in the bot wallet only what you accept to lose.
- Use the trading environment for the trading routine alone. Start no other session in it, and never continue a
  trading run's session.
- Never give anything that reads web pages push access to the trading repository.
- Use a wallet made only for this bot, and fund it with what you can afford to lose.
- Run one copy of the bot per wallet. Two machines or routines sending from the same wallet clash on nonces, and
  `r3.cjs`'s lock covers one machine only: turn off any other scheduler or machine first.
- Keep `run/` and `inputs/` out of this public repo: they hold your trade history and your forecasts. Your private
  copy is where they go.
- The skill text (`.claude/skills/deep-r3-trade/SKILL.md` and `steps/`) is the authority whenever this README and the skill disagree.
