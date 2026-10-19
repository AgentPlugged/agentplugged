# Changelog

All notable changes to `agentplugged`, newest first. Versions follow semantic versioning.

## 1.1.1 - 2026-10-19

### Fixes

- Publish the release that 1.1.0 announced; the 1.1.0 build stopped before reaching npm.

## 1.1.0 - 2026-10-19

### New features

- Tell the bridge when the creator's account was deleted, so that the machine says so, stops reconnecting, forgets its link and keeps working on its own.
- Carry out a checkpoint answer given from a phone only if the checkpoint is unchanged since the creator saw it, so answers given offline wait for the machine and are refused as stale when the checkpoint moved.
- Replace Gemini CLI with Antigravity CLI everywhere (detection, models, MCP, texts), keep reading old Gemini CLI files without writing them, and add sync --clean-gemini to remove only the files AgentPlugged wrote for it.
- Let the creator pause, resume, stop and instruct the agents; instructions need the engine published with this version, so the bridge refuses them while a product runs an older one.
- Let the creator follow, from the web view, what a Claude Code session opened in their own terminal reads, changes and runs, through a new hook that sync writes and that never slows or blocks the session.
- Follow what an agent costs while it works, warn at the alert ratio of the story's budget, pause the team at the ceiling until the creator answers the budget checkpoint, and count the last known cost of a run that was cut short.
- Merge a story's pull request from the web view with one click and a 10-second undo, or send the story back to its agent with a reason.
- Keep the last state received in a sealed copy on the device and queue orders given with no network, sent in order when the network is back.
- Write in the journal the orders a machine refused after checking their signature, so that every view shows what became of them.
- Let the creator renew the product key in one click after removing a machine, keeping every older key to read the history, and export all the keys with key export.
- Let the creator type a secret in the web view, encrypted in the browser for one machine and kept in that machine's keychain, never queued and never seen by the relay.
- Answer a checkpoint from the phone with one touch or one swipe, with the same 10-second undo; the journal records the source as the phone, and an engine older than this version asks to be updated when it reads such an answer.
- Talk to your team and hear your briefing in the web view, with the browser's local recognition or, if turned on, your machine transcribing through the command set in AGENTPLUGGED_TRANSCRIBE_COMMAND.
- Let the creator watch an agent work and talk to it from the web view, or reopen its session in their own terminal and hand the work back; a session left open on the machine can be closed from afar.

### Fixes

- Show a freshly linked product in the web view within about a second instead of several seconds.

## 1.0.6 - 2026-10-15

### Fixes

- Ship the faster Windows keychain announced in 1.0.5, whose publication stopped on a formatting check.

## 1.0.5 - 2026-10-15

### Fixes

- On Windows, load the keychain's native module first and fall back on PowerShell only when Windows refuses it, so each engine process starts fast again.

## 1.0.4 - 2026-10-14

### Fixes

- A story's working copy no longer fails the engine check after an engine update that is not committed yet.

## 1.0.3 - 2026-10-14

### Fixes

- Write Claude Code's Windows disk-root deletion bans with the escaped final backslash, and give every command rule and command hook a PowerShell tool twin.
- Read placeholder folders like <module> in a story's text as one folder name in the write scope, and tell agents never to redo a refused write through another tool.

## 1.0.2 - 2026-10-14

### Fixes

- Reach the Windows Credential Manager through PowerShell so Smart App Control no longer blocks the keys, and say clearly what blocks when the keychain cannot be used.

## 1.0.1 - 2026-10-14

### Fixes

- Stop writing Claude Code permission rules that end with a backslash, which Claude Code reports as malformed.
- On Windows, retry briefly when another program holds a file that sync replaces, then name the file.

## 1.0.0 - 2026-10-13

### New features

- First public release of the AgentPlugged command line, MCP server and method.
