import { describe, expect, it } from "vitest";
import { claudeCodeTranslator } from "./claude-code.js";
import type { RunEvent } from "./contract.js";

const init = { type: "system", subtype: "init", session_id: "s-1", apiKeySource: "none" };

function call(name: string, input: unknown): RunEvent | undefined {
  const reader = claudeCodeTranslator.begin();
  const lines = [
    init,
    {
      type: "assistant",
      message: { id: "m", content: [{ type: "tool_use", id: "t", name, input }] },
    },
  ];
  return lines
    .flatMap((line) => [...reader.line(line)])
    .find((event) => event.type === "tool.started");
}

describe("Claude Code tool actions", () => {
  it("names the file a call reads, the file it changes and the command it runs", () => {
    expect(call("Read", { file_path: "src/a.ts" })).toMatchObject({
      action: { kind: "read", target: "src/a.ts" },
    });
    expect(call("Edit", { file_path: "src/a.ts", old_string: "x" })).toMatchObject({
      action: { kind: "edit", target: "src/a.ts" },
    });
    expect(call("MultiEdit", { file_path: "b.ts", edits: [] })).toMatchObject({
      action: { kind: "edit", target: "b.ts" },
    });
    expect(call("Write", { file_path: "c.md", content: "text" })).toMatchObject({
      action: { kind: "edit", target: "c.md" },
    });
    expect(call("NotebookEdit", { notebook_path: "n.ipynb" })).toMatchObject({
      action: { kind: "edit", target: "n.ipynb" },
    });
    expect(call("Bash", { command: "git status" })).toMatchObject({
      action: { kind: "command", target: "git status" },
    });
    expect(call("PowerShell", { command: "Get-ChildItem" })).toMatchObject({
      action: { kind: "command", target: "Get-ChildItem" },
    });
  });

  it("gives no action to other tools, to a missing target or to an input of the wrong shape", () => {
    expect(call("Grep", { pattern: "x", path: "src" })).not.toHaveProperty("action");
    expect(call("mcp__x__tool", { command: "rm -rf" })).not.toHaveProperty("action");
    expect(call("Read", {})).not.toHaveProperty("action");
    expect(call("Read", { file_path: 12 })).not.toHaveProperty("action");
    expect(call("Bash", "git status")).not.toHaveProperty("action");
    expect(call("toString", { file_path: "x" })).not.toHaveProperty("action");
  });
});
