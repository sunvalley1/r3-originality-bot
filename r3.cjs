#!/usr/bin/env node
// r3.cjs - the short form of .claude/skills/deep-r3-trade/scripts/routine.cjs, on any operating system. Run it from
// this folder (the project root):
//   node r3.cjs install                      the planner, chain helper and signer, outside the project
//   node r3.cjs planner <subcommand> ...     the installed planner, e.g. `node r3.cjs planner d <run-id> --supply inputs/my.csv`
//   node r3.cjs trade [--push]               one scheduled run (what the trading routine runs)
//   node r3.cjs clearance [--push]           the no-send check of an install
//   node r3.cjs selftest --cases <folder> [--push]   the signer self-test, replayed on this install
//   node r3.cjs status                       the newest run's final status
// See routine.cjs's header and steps/I-setup.md I.2 section 7.
'use strict';
require('./.claude/skills/deep-r3-trade/scripts/routine.cjs');
