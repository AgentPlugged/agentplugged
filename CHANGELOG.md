# Changelog

All notable changes to `agentplugged`, newest first. Versions follow semantic versioning.

## 1.4.0 - 2026-10-22

### New features

- Add an acceptance run before a release, with proofs and one gesture, and a look back a week after a launch with measures, a short retrospective and feedback turned into tickets.
- Run Noah from the web view and the phone with Codex, Antigravity CLI or Cursor too (`agent edit noah --tool`), each missing mechanism reported as a fallback with its cause and one action.
- Count the same refusal when it comes back and, on the second, tell the agent to change method; each common refusal carries the gesture to make instead, and sync allows the local command it gives the agents.
- Support Kimi Code CLI beside the other tools and add `kimi-hooks install|remove|status`, which puts the product's guards in Kimi's own settings on request, with a backup.
- Run Noah from the web view and the phone with Kimi Code CLI too (`agent edit noah --tool kimi`), each mechanism it lacks reported as a fallback with its cause and one action.
- Make the method lighter: Noah's role is one short file, skills are short work sheets without what a model already knows, and agent sheets no longer repeat their persona, so each start loads less.
- Tell the web view where the conversation with Noah can be reopened in the AI tool's own terminal, only when the tool can reopen a session and nothing secret is in the answer.
- Review once and ask early: one reader checks a change without high risk, the creator is asked after 2 passes, and every sub-agent is a named team member so its cost has an owner.
- Show how heavy Noah's conversation is (the tokens Claude Code reports, never an estimate) and offer a clean conversation, with what it saves, once it grows or before a story starts.
- Make Noah answer faster with Claude Code by keeping his program open ten minutes between messages (no token spent while waiting) and by showing his answer as he writes it.
- Tell Noah which page the creator is looking at (its kind and, if one item is singled out, its identifier and title, never its content); the creator can take the page off for one message.
- Nothing stops in silence: a partial result that leaves the creator a decision is refused until a checkpoint is open, and the next step says when a story failed twice for the same cause.
- Agents no longer rediscover the project: `init` writes a short project profile, `docs profile refresh` rewrites it, and `docs bricks <words>` tells from a registry of the code whether something exists.
- Agents no longer read a whole PRD or architecture: `docs read` gives the passages asked for by identifier or section, and `next` hands the agent of a step the passages its task needs.
- The state summary tells the day each status was last declared, and a refused command carries the first words the creator may allow in one gesture, with the order that applies it.
- Each story becomes one sheet its developer reads, with the tests expected and the cited passages of the documents; `docs check` refuses a sheet over 300 lines and warns when a cited passage changed.
- Show which sub-agents Noah launched, how long each worked and the tokens the tool counted for it (never estimated, cost at public prices when it allows), and say so for tools that count none.

### Fixes

- When the creator's answer is read aloud (Voice and Hands-free modes of the chat), Noah now answers in plain sentences only, with no list, heading or bold on top of the table, code, path and address already left out.
- The next step accepts the agent's name, a story result without its empty lists is accepted, and tool manuals are read when a refusal names an unknown field instead of before the first call.

### What was tried, and what was not

- Works, with automated tests: the project profile and the brick registry, the story sheet, the reading by passage, the identical-refusal count and its gestures, the single review, the dated statuses and the allow-a-command order, the context gauge, the page given to Noah, the live sub-agents and the reopen command.
- Tried for real only with Claude Code and on Windows: one story built, reviewed and merged from end to end on a throwaway product, with Noah and his sub-agents. The framing steps (brief, PRD, UX, architecture) were not replayed.
- Not tried with a successful turn: Codex, Antigravity CLI, Cursor and Kimi Code CLI (they keep a fallback that is said); macOS; Linux beyond a short trial in a container (install and start of the MCP server only).
- The Kimi hook starts the engine through npx at each tool call: measured at 2.5 to 2.9 s per call once the cache is warm.
- Updating a product from 1.2.0 or 1.3.0 needs one gesture (`npx agentplugged@1.4.0 init --upgrade-engine`; until then the new engine refuses and writes nothing). Tried from 1.2.0 on Windows with an earlier build of this release: your own settings and servers are kept, generated files are rewritten. From 1.3.0 and against the registry: not tried.

## 1.3.0 - 2026-10-20

### New features

- Stop a story at its budget at the nearest tool call, through a hook of Claude Code that reads the measured cost and refuses the next call, and hold the team's pause at the same point while an agent writes.
- Let Noah write a one-line note of each exchange with the creator to the journal (`agent summarize`), shown in the latest notes of the state, so that a fresh session takes the thread up without any session to resume.
- Add an extension point to the journal: signed, ordered events named x.<module>.<type> that an engine ignores without stopping when it does not know the module, and extra MCP servers that sync can declare.
- Let a program built on the engine declare its extra MCP server for Codex and Antigravity too, and leave alone an entry the user replaced instead of rewriting or removing it.
- Let Noah hold the whole team himself (`agent pause`, the same `team.paused` fact the pause button writes) once the creator said yes to his proposal to adjust the plan after changes of course pile up; resuming stays the creator's gesture.
- Noah now answers briefly and in plain words to a dictated message, and the spoken reading drops icons, agent prefixes, emojis and tables.
- Tell Noah, in the instructions that sync writes, that a program on the creator's machine may start him without a head, so that he launches his sub-agents himself and respects the team's pause.
- Add a team pause written to the journal that Noah and every sub-agent respect, so the creator can hold all the agents of a product and resume them.
- A tool run can now take further messages while it works, so that a message to the lead agent no longer waits for its sub-agents to finish.
- A tool run can now launch sub-agents under the same permission plan, with the refusals meant for the launching session kept away from its sub-agents.

### Fixes

- Noah's spoken-answer rule now applies whenever his answer will be read aloud, whether the message was typed or dictated in the web view or on the phone.

### What was tried, and what was not

- Works, with automated tests: the team pause, the note of each exchange, the budget check before each tool call, the pause written by Noah, and the reading of a journal across 1.2.0 and 1.3.0.
- Tried for real only with Claude Code and on Windows: the budget hook, a sub-agent that reads the pause through the engine, a lead agent that takes messages while its sub-agents work. The pause's hold on writes is covered by automated tests only.
- The budget is measured at the engine's public price table, which gives about 2.7 times less than the cost Claude Code announces for Haiku 5.5, so a ceiling can be reached later than the real bill; a call already started is not cut.
- Not tried yet: Codex, Antigravity CLI, Cursor and Kimi (they keep the earlier behaviour, with a fallback that is said), macOS, and Linux beyond a short trial in a container (install, build and start of the MCP server only).
- A product pinned to 1.2.0 keeps working and is not written the new events; an engine 1.2.0 that meets one answers that it must be updated, and changes nothing. It refuses an extension event as invalid.

## 1.2.0 - 2026-10-19

### New features

- Add an optional evening recap: a daily reminder at a chosen hour, then Noah tells the day (delivered, published, cost) and reads the calm decisions, on the phone and in the web view.

### Fixes

- Publish the release that 1.1.0 and 1.1.1 announced; their builds stopped on tests before reaching npm.

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
