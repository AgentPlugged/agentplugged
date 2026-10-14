import { describe, expect, it } from "vitest";
import {
  DECISION_HOOK_COMMAND,
  DECISION_HOOK_PATH,
  DEFAULT_RULES,
  decisionHookHandler,
  GENERATED_HEADER_SLASH,
  isDecisionHook,
  renderDecisionHookScript,
} from "../index.js";
import { claudeTrustHooks, isTrustHook, withTrustHooks } from "../sync/trust-hooks.js";

describe("the question tool's hook script", () => {
  it("is a generated script the same for every product, with no dependency", () => {
    const text = renderDecisionHookScript();
    expect(
      text.startsWith(`${GENERATED_HEADER_SLASH}
`),
    ).toBe(true);
    expect(text).toBe(renderDecisionHookScript());
    expect(DECISION_HOOK_PATH).toBe(".claude/hooks/agentplugged-decision.mjs");
    const imports = [...text.matchAll(/^import .* from "(.*)";$/gm)].map((match) => match[1]);
    expect(imports.every((name) => name?.startsWith("node:"))).toBe(true);
  });
});

describe("the question tool's hook in the project's settings", () => {
  it("is a command hook (never an mcp_tool) on PostToolUse and PreToolUse, for AskUserQuestion only", () => {
    const hooks = claudeTrustHooks(DEFAULT_RULES);
    for (const event of ["PreToolUse", "PostToolUse"] as const) {
      const groups = hooks[event].filter((group) => group.matcher === "AskUserQuestion");
      expect(groups).toHaveLength(1);
      expect(groups[0]?.hooks).toEqual([decisionHookHandler()]);
    }
    expect(decisionHookHandler()).toEqual({
      type: "command",
      command: DECISION_HOOK_COMMAND,
      timeout: 10,
    });
    expect(JSON.stringify(decisionHookHandler())).not.toContain("mcp_tool");
  });

  it("is ours: sync replaces it, keeps the creator's hooks, and takes it back", () => {
    const mine = { type: "command", command: "lint.sh" };
    const settings = { hooks: { PostToolUse: [{ matcher: "AskUserQuestion", hooks: [mine] }] } };
    const hooks = claudeTrustHooks(DEFAULT_RULES);
    const once = withTrustHooks(settings, hooks);
    expect(withTrustHooks(once, hooks)).toEqual(once);
    expect(once.hooks.PostToolUse[0]).toEqual({ matcher: "AskUserQuestion", hooks: [mine] });
    expect(isDecisionHook(decisionHookHandler())).toBe(true);
    expect(isTrustHook(decisionHookHandler())).toBe(true);
    expect(isDecisionHook({ type: "command", command: "node other.mjs" })).toBe(false);
    expect(isDecisionHook({ type: "mcp_tool", command: DECISION_HOOK_COMMAND })).toBe(false);
    expect(withTrustHooks(once, undefined)).toEqual(settings);
  });
});
