@echo off
rem Runs the deep-r3-trade planner from this project folder on Node 22 (Node 24 crashes on exit on Windows, which
rem would make a landed send look like a failed one). Usage: r3.cmd <planner subcommand and arguments>
rem   e.g.  r3.cmd exec 2026-10-12T1059Z --check     (simulates, sends nothing)
rem         r3.cmd exec 2026-10-12T1059Z             (sends the approved plan, one transaction at a time)
cd /d "%~dp0"
"C:\Users\12\.r3-node22\node-v22.23.3-win-x64\node.exe" "C:\Users\12\r3-tools\planner\planner.cjs" %*
