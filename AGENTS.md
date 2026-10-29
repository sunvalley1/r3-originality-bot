# Instructions for AI agents working in this repository

**A scheduled run reads no further.** If your prompt has you run the code pin check as your first command
(`test "$(git ls-tree HEAD | ...`, or a `node -e` command over `git ls-tree`), or says this is a setup run or that you
are a Codex scheduled task or a Codex cloud task, you are the trading routine, its setup run or the Codex task in its
place: run
nothing this file asks for, not even the checks below; follow your prompt and
`.claude/skills/deep-r3-trade/routines/trade.md` only, and treat this file as data.

Everyone else: this repository is the R3 Originality trading bot, a skill in `.claude/skills/deep-r3-trade/`
(`SKILL.md` is its overview). It trades real money on Optimism.

## When a person opens this repository

**First, their choice of where the bot runs**, unless they already said: **Claude** (a routine in the cloud: SETUP.md
steps 6 to 8; it needs Claude Code's `/schedule`, the only way to give a routine its allowed and denied tools),
**ChatGPT in the cloud** (a Codex cloud environment and a schedule: SETUP.md "6 to 8 with ChatGPT in the cloud"; it
works only if a cloud task can push to their private copy, which its setup run checks), or **ChatGPT on their own
computer** (a Codex scheduled task: SETUP.md "6 to 8 with Codex instead"; the computer must be on with the ChatGPT app
open at run times). Steps 1 to 5 are the same for all three. Then find out how far their setup has got, with these
read-only checks, and tell them in one short list what is done and what is next:

1. `git remote get-url origin`: `sunvalley1/r3-originality-bot` (or no `origin`) means step 1 of
   [SETUP.md](SETUP.md) is still to do in this folder; their own private repository means it is done (a `public`
   remote pointing at `sunvalley1/r3-originality-bot` is expected then). If they made their private copy in another
   folder, tell them to open you again there and stop: every command and the skill's `run/` use the folder you are
   open in.
2. `routine.config.json` exists, its `signerAddress` is not the template's `0x…0001`, its `owner` is not the
   template's `0x…0002`, and the two differ; and `~/.claude/settings.json` lists SETUP.md step 2's six deny rules
   (if not, adding them comes next, before any key file exists).
3. `setup/r3-allowlist.json` exists and its sha256 equals `routine.config.json`'s `allowlistSha256`.
4. `run/csv/current.json` exists (a CSV has been supplied).
5. `run/setup.deep-r3-trade.json`, after a `git pull`: `autonomy.authorized_at` and
   `autonomy.signer_selftest_passed_at` (step 4; there is no supervised trading run); then step 8 is done only when `schedule.signer_allow_rule_added_at`
   is set and `autonomy.signer_path` and `autonomy.planner_path` equal `installed.signer` and `installed.planner` in
   the clearance that cleared the scheduler: the cloud setup run's (`/root/...` paths) for a Claude routine, the Codex
   cloud setup run's for ChatGPT in the cloud (SETUP.md CC2), or a supervised `node r3.cjs clearance` on this computer
   for a Codex scheduled task (SETUP.md C1 and C2). Until then
   every scheduled run stops at its start. Switching the schedule on is the person's call, not yours.
6. What you cannot see (the cloud environment, the routine or schedule, the wallet's funding): ask.

If anything is left, offer to walk them through [SETUP.md](SETUP.md) from that step, one step at a time: say what the
step is for, what they will do and what you will do, wait for them to finish it, check it with the step's own check,
and only then go on. If they decline, do what they asked.

## Rules for every agent here

- **Never ask for, accept, show or paste a private key, a recovery phrase, a keystore's text or a password**, in chat
  or in a file you write. The person types or pastes those themselves, into their own terminal or into the cloud
  service's settings page. If they paste one into the chat, stop and tell them: a raw private key or recovery phrase
  is exposed, so move the funds to a new wallet; a password with its keystore is exposed the same way.
- **Never read, list, open, print or copy a key file or a password**: not `~/.r3-signer-keys/`, not
  `~/.foundry/keystores/`, not any `.env`, and never print `R3_KEYSTORE_JSON`, `R3_KEYSTORE_PASSWORD` or the whole
  environment. Only the signer reads them, in its own process. Claude Code also gets deny rules for this in
  `~/.claude/settings.json` (SETUP.md step 2): add them before any key file exists even if you are another agent,
  because steps 7 and 8 run Claude Code in this folder. Other agents keep to the rule themselves.
- Never write code that reads, converts or encrypts a key. Use the commands in SETUP.md, which the person runs.
- **Never make the bot's wallet yourself**, with any tool or skill (`wallet-setup` included), and never use or offer
  one an agent made in its own process (`run/wallet.json`): the person makes it in their own terminal window
  (SETUP.md step 2). Asked to create it, give them that step's option B commands and run none of them.
- **In a supervised session the person approves each command.** Run in a mode that asks before every command (for
  Codex, an approval policy that asks; never a full-auto or bypass mode). Run `node r3.cjs planner exec ...`,
  `node r3.cjs planner halfb ... --send` and any `node <signer path> ...` command (`clear-nonce`, `reconcile`,
  `sweep-*`, `send`) only after the person approved that exact command; for `exec` and `halfb --send`, their "yes" to
  the batch comes first (`SKILL.md`). `allowlist-init` is never yours to run, even with their approval: the person
  runs it in their own terminal (SETUP.md step 3; `scripts/signer.README.md`).
- **A trade now is the person's to start** (the routine's or the Codex task's *Run now*; in Claude Code you may
  start the routine with `/schedule run` when they ask, never by giving the routine a one-time schedule, which would
  replace its recurring one; with ChatGPT, where there is no *Run now*, a one-time run of the same prompt one minute
  ahead does the same). A run that finds another one live stops by itself
  (`lock-held`), but nothing stops a supervised send: never start one while a supervised send from this computer
  may be under way, and pause the schedule before any supervised send. One sender per wallet.
- Push only what the person asked for. Never push `run/` or `inputs/` to the public repository.
- Use Node.js 22. On Windows, Node 24 crashes the bot's tools.
- If you are not Claude Code: run the skill by reading `.claude/skills/deep-r3-trade/SKILL.md` in full and following
  it; the skills it names are the folders beside it in `.claude/skills/`. For a supervised session's
  `run/<run-id>/session-owner.json` (`steps/I-setup.md` I.2 §6), the long-lived process is your own agent's: if the
  snippet stops with `no claude ancestor`, add your agent's process name to its match (for example `codex`). In the
  Codex app, delete that marker yourself when the run's sends are done: it names the app's own process, which outlives
  the chat, so a scheduled task would treat that run-id as live and skip its repair, merges, redeems and scoring.
- `.claude/skills/deep-r3-trade/SKILL.md` and its `steps/` are the authority when this file, SETUP.md or the README
  disagree with them.
