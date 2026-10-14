# Changelog

All notable changes to `agentplugged`, newest first. Versions follow semantic versioning.

## 1.0.1 - 2026-10-14

### Fixes

- Stop writing Claude Code permission rules that end with a backslash, which Claude Code reports as malformed.
- On Windows, retry briefly when another program holds a file that sync replaces, then name the file.

## 1.0.0 - 2026-10-13

### New features

- First public release of the AgentPlugged command line, MCP server and method.
