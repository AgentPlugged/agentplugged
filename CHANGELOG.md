# Changelog

All notable changes to `agentplugged`, newest first. Versions follow semantic versioning.

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
