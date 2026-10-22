import { describe, expect, it } from "vitest";
import { claudeRulePermissions, DEFAULT_RULES, denyRules } from "../index.js";
import { policyDecision } from "./antigravity-guard.js";
import type { AntigravityPolicy } from "./antigravity-policy.js";
import {
  KIMI_FLAVOR,
  KIMI_POLICY_PATH,
  kimiCallOf,
  kimiCallTool,
  kimiSessionOf,
} from "./kimi-guard.js";

const PLACE = { root: "C:/work/app", home: "C:/Users/me" };
const INPUTS = {
  rootAgentsGenerated: true,
  claudeMdGenerated: false,
  geminiMdGenerated: false,
  generatedRoots: [".agents", ".kimi-code"],
};

/** The policy `sync` writes for Kimi: the lists written for Claude Code, and Kimi's own settings. */
function policy(): AntigravityPolicy {
  const claude = claudeRulePermissions(DEFAULT_RULES, "main");
  return {
    version: 1,
    rules: DEFAULT_RULES,
    main_branch: "main",
    deny: [
      ...new Set([
        ...denyRules(INPUTS),
        ...claude.deny,
        "Edit(~/.kimi-code/config.toml)",
        "Edit(~/.kimi-code/sessions/**)",
      ]),
    ],
    ask: claude.ask,
  };
}

const verdictOf = (input: unknown) => {
  const call = kimiCallOf(input);
  if (call === undefined) return "unreadable";
  return policyDecision(policy(), call, PLACE, KIMI_FLAVOR).decision;
};
const shell = (command: string) => ({
  hook_event_name: "PreToolUse",
  session_id: "s1",
  cwd: "C:/work/app",
  tool_input: { command },
});

describe("the guard before a Kimi tool call", () => {
  it("reads a shell command by its `command`, whatever the tool is called", () => {
    expect(kimiCallOf(shell("git status"))).toEqual({
      name: "run_command",
      args: { CommandLine: "git status", Cwd: "C:/work/app" },
    });
    expect(kimiCallTool(kimiCallOf(shell("ls")) as never)).toBe("Bash");
  });

  it("reads any other input by its fields, and an input of no tool as nothing", () => {
    const call = kimiCallOf({ cwd: "C:/work/app", tool_input: { file_path: "src/a.ts" } });
    expect(call).toEqual({ name: "kimi_tool", args: { file_path: "src/a.ts" } });
    expect(kimiCallTool(call as never)).toBe("Edit");
    expect(kimiCallTool({ name: "kimi_tool", args: { query: "x" } })).toBe("");
    expect(kimiCallOf({ cwd: "C:/work/app" })).toBeUndefined();
    expect(kimiCallOf("not an object")).toBeUndefined();
    expect(kimiCallOf({ tool_input: [] })).toBeUndefined();
  });

  it("reads the session id only when it is a plain token", () => {
    expect(kimiSessionOf({ session_id: " abc-123 " })).toBe("abc-123");
    expect(kimiSessionOf({ session_id: "has space" })).toBeUndefined();
    expect(kimiSessionOf({})).toBeUndefined();
  });

  it("refuses what the product denies, in a shell command", () => {
    expect(verdictOf(shell("git push origin main"))).toBe("deny");
    expect(verdictOf(shell("git push --force origin feature"))).toBe("deny");
    expect(verdictOf(shell("git status"))).toBe("allow");
  });

  it("refuses a write of the product's protected files, by any tool input that names a path", () => {
    const edit = (path: string) => ({ tool_input: { file_path: path, content: "x" } });
    expect(verdictOf(edit("C:/work/app/.agentplugged/method.yaml"))).toBe("deny");
    expect(verdictOf(edit("C:/work/app/src/a.ts"))).toBe("allow");
  });

  it("keeps the agent out of Kimi's settings, its sessions and the hook command", () => {
    expect(verdictOf({ tool_input: { path: "C:/Users/me/.kimi-code/config.toml" } })).toBe("deny");
    for (const command of [
      "echo x >> ~/.kimi-code/config.toml",
      "npx agentplugged kimi-hooks remove",
      "rm .kimi-code/agentplugged-policy.json",
      "rm -rf .kimi-code",
      "mv .kimi-code /tmp/x",
      "rm .agentplugged/method.yaml",
    ]) {
      expect(verdictOf(shell(command)), command).toBe("deny");
    }
  });

  it("names the policy file `sync` writes in the project", () => {
    expect(KIMI_POLICY_PATH).toBe(".kimi-code/agentplugged-policy.json");
    expect(KIMI_FLAVOR.policyPath).toBe(KIMI_POLICY_PATH);
  });
});
