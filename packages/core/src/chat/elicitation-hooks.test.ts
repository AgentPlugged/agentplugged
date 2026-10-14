import { describe, expect, it } from "vitest";
import { decisionHookHandler, elicitationHookIn, questionToolHookIn } from "../index.js";

const hook = (event: string, matcher?: unknown) => ({
  hooks: {
    [event]: [
      {
        ...(matcher === undefined ? {} : { matcher }),
        hooks: [{ type: "command", command: "echo accept" }],
      },
    ],
  },
});

describe("hooks that could answer the engine's forms", () => {
  it("finds an Elicitation or ElicitationResult hook that may apply to the server", () => {
    expect(elicitationHookIn(hook("Elicitation"), "agentplugged")).toBe(true);
    expect(elicitationHookIn(hook("ElicitationResult", "*"), "agentplugged")).toBe(true);
    expect(elicitationHookIn(hook("Elicitation", "agent.*"), "agentplugged")).toBe(true);
    expect(elicitationHookIn(hook("Elicitation", "^github$"), "agentplugged")).toBe(false);
    // A matcher that cannot be read, or a shape that cannot, counts (caution).
    expect(elicitationHookIn(hook("Elicitation", "(unclosed"), "agentplugged")).toBe(true);
    expect(elicitationHookIn({ hooks: { Elicitation: "x" } }, "agentplugged")).toBe(true);
  });

  it("ignores the other hooks and settings without hooks", () => {
    expect(elicitationHookIn(hook("UserPromptSubmit"), "agentplugged")).toBe(false);
    expect(elicitationHookIn({}, "agentplugged")).toBe(false);
    expect(elicitationHookIn(null, "agentplugged")).toBe(false);
    expect(elicitationHookIn({ hooks: { Elicitation: [{ hooks: [] }] } }, "agentplugged")).toBe(
      false,
    );
  });
});

describe("hooks that could answer the question tool", () => {
  it("finds a PreToolUse or PermissionRequest hook of another maker that may apply to the tool", () => {
    expect(questionToolHookIn(hook("PreToolUse", "AskUserQuestion"), "AskUserQuestion")).toBe(true);
    expect(questionToolHookIn(hook("PermissionRequest"), "AskUserQuestion")).toBe(true);
    expect(questionToolHookIn(hook("PreToolUse", "*"), "AskUserQuestion")).toBe(true);
    expect(questionToolHookIn(hook("PreToolUse", "Ask.*"), "AskUserQuestion")).toBe(true);
    expect(questionToolHookIn(hook("PreToolUse", "Bash"), "AskUserQuestion")).toBe(false);
    // A matcher or a shape that cannot be read counts (caution).
    expect(questionToolHookIn(hook("PreToolUse", "(unclosed"), "AskUserQuestion")).toBe(true);
    expect(questionToolHookIn({ hooks: { PreToolUse: "x" } }, "AskUserQuestion")).toBe(true);
  });

  it("ignores ours, the other events and settings without hooks", () => {
    const ours = {
      hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [decisionHookHandler()] }] },
    };
    expect(questionToolHookIn(ours, "AskUserQuestion")).toBe(false);
    expect(questionToolHookIn(hook("PostToolUse", "AskUserQuestion"), "AskUserQuestion")).toBe(
      false,
    );
    expect(questionToolHookIn(hook("UserPromptSubmit"), "AskUserQuestion")).toBe(false);
    expect(questionToolHookIn({}, "AskUserQuestion")).toBe(false);
    expect(questionToolHookIn(null, "AskUserQuestion")).toBe(false);
    // The creator's hook next to ours in one group counts.
    const mixed = {
      hooks: {
        PreToolUse: [
          {
            matcher: "AskUserQuestion",
            hooks: [decisionHookHandler(), { type: "command", command: "echo allow" }],
          },
        ],
      },
    };
    expect(questionToolHookIn(mixed, "AskUserQuestion")).toBe(true);
  });
});
