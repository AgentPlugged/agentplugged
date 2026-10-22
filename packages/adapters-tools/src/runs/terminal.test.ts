import { describe, expect, it } from "vitest";
import {
  canContinueSession,
  canLaunchSubAgents,
  canNameSession,
  canReportContext,
  canTakeLiveInput,
  terminalCommandFor,
} from "./terminal.js";

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

  it("is the resume command of Codex, checked with the program itself", () => {
    expect(terminalCommandFor("codex", "0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b")).toEqual({
      program: "codex",
      args: ["resume", "0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b"],
      line: "codex resume 0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b",
    });
  });

  it("is the resume command of Kimi, checked in the program's own help", () => {
    expect(terminalCommandFor("kimi", "0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b")).toEqual({
      program: "kimi",
      args: ["--session", "0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b"],
      line: "kimi --session 0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b",
    });
  });

  it("does not exist for a tool that has no verified resume command yet", () => {
    for (const tool of ["antigravity", "cursor"] as const) {
      expect(terminalCommandFor(tool, "abc-123")).toBeUndefined();
    }
  });
});

describe("what each tool's run can do, as its adapter declares it", () => {
  it("launches sub-agents in Claude Code, Codex, Antigravity CLI and Kimi, not in Cursor or an unknown tool", () => {
    for (const tool of ["claude-code", "codex", "antigravity", "kimi"]) {
      expect(canLaunchSubAgents(tool)).toBe(true);
    }
    for (const tool of ["cursor", ""]) expect(canLaunchSubAgents(tool)).toBe(false);
  });

  it("takes a message while it goes on in Claude Code and Antigravity CLI only", () => {
    for (const tool of ["claude-code", "antigravity"]) expect(canTakeLiveInput(tool)).toBe(true);
    for (const tool of ["codex", "cursor", "kimi", ""]) expect(canTakeLiveInput(tool)).toBe(false);
  });

  it("continues a session in the five tools the bridge starts", () => {
    for (const tool of ["claude-code", "codex", "antigravity", "cursor", "kimi"]) {
      expect(canContinueSession(tool)).toBe(true);
    }
    expect(canContinueSession("")).toBe(false);
  });

  it("names a new session before the start in Claude Code only", () => {
    expect(canNameSession("claude-code")).toBe(true);
    for (const tool of ["codex", "antigravity", "cursor", "kimi"]) {
      expect(canNameSession(tool)).toBe(false);
    }
  });

  it("reports how heavy the conversation is in Claude Code only (no other flux is tried)", () => {
    expect(canReportContext("claude-code")).toBe(true);
    for (const tool of ["codex", "antigravity", "cursor", "kimi", ""]) {
      expect(canReportContext(tool)).toBe(false);
    }
  });
});
