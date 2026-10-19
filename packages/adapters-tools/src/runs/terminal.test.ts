import { describe, expect, it } from "vitest";
import { terminalCommandFor } from "./terminal.js";

describe("the command that reopens a session in the tool's own terminal", () => {
  it("is the resume command of Claude Code for a plain session identifier", () => {
    expect(terminalCommandFor("claude-code", "0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b")).toEqual({
      program: "claude",
      args: ["--resume", "0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b"],
      line: "claude --resume 0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b",
    });
  });

  it("is never built from an identifier that could be read as more than one word or an option", () => {
    for (const bad of [
      "",
      "a b",
      "a;rm -rf /",
      "a&b",
      "$(x)",
      "`x`",
      "a\nb",
      "--help",
      "-x",
      "a|b",
      'a"b',
      "x".repeat(201),
    ]) {
      expect(terminalCommandFor("claude-code", bad)).toBeUndefined();
    }
  });

  it("does not exist for a tool that has no resume command yet", () => {
    for (const tool of ["codex", "antigravity", "cursor"] as const) {
      expect(terminalCommandFor(tool, "abc-123")).toBeUndefined();
    }
  });
});
