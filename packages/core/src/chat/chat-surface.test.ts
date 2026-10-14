import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  answerChannel,
  answerReason,
  type CheckpointState,
  COMPATIBILITY,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  DEFAULT_RULES,
  denyRules,
  GENERATED_HEADER_SLASH,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  PROMPT_HOOK_COMMAND,
  PROMPT_HOOK_PATH,
  type ProfileResult,
  profileCommand,
  type RecordedEvent,
  renderConstitutionReference,
  renderPromptHookScript,
  resolveProfile,
  type SyncResult,
  syncCommand,
  type ToolProbe,
  type ValidationEntry,
} from "../index.js";
import { checkpointState } from "../testing/checkpoint-state.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const claudeOnly: ToolProbe = {
  which: async (names) =>
    names.includes("claude") ? { name: "claude", path: "/usr/bin/claude" } : undefined,
  version: async () => "2.1.300 (Claude Code)",
  extensions: async () => [],
};

const CONFIG = ".agentplugged/method.yaml";
const SETTINGS = ".claude/settings.json";

function context(files: MemoryFiles): CommandContext {
  return {
    files,
    tools: claudeOnly,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
  };
}

async function installed(input: Record<string, unknown> = {}): Promise<MemoryFiles> {
  const files = new MemoryFiles();
  const result = await initCommand.run(context(files), {
    profile: resolveProfile("new-product"),
    ...input,
  });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  return files;
}

async function sync(files: MemoryFiles): Promise<SyncResult> {
  const result = await syncCommand.run(context(files), {});
  if (!result.ok) throw new Error(`sync failed: ${result.error.code}`);
  return result.value;
}

describe("sync: the chat's hook", () => {
  it("writes a UserPromptSubmit command hook and its script, never an mcp_tool", async () => {
    const files = await installed();
    const result = await sync(files);
    expect(result.entries.find((entry) => entry.path === PROMPT_HOOK_PATH)?.action).toBe("created");
    const script = files.files.get(PROMPT_HOOK_PATH) ?? "";
    expect(script.startsWith(`${GENERATED_HEADER_SLASH}\n`)).toBe(true);
    expect(script).toBe(renderPromptHookScript());
    const settings = JSON.parse(files.files.get(SETTINGS) ?? "{}");
    expect(settings.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: PROMPT_HOOK_COMMAND, timeout: 10 }] },
    ]);
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).not.toContain("mcp_tool");
    // Agents never write the store, nor run the script.
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        "Edit(~/.agentplugged/chat/**)",
        "Bash(node *agentplugged-prompt*)",
        // The question tool's hook: same store, same rule.
        "Bash(node *agentplugged-decision*)",
      ]),
    );
  });

  it("keeps the creator's UserPromptSubmit hooks, and takes ours back with Claude Code", async () => {
    const files = await installed();
    const mine = { type: "command", command: "echo hello" };
    files.seed(
      SETTINGS,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [mine] }] }, env: { A: "1" } }),
    );
    await sync(files);
    const settings = JSON.parse(files.files.get(SETTINGS) ?? "{}");
    expect(settings.hooks.UserPromptSubmit).toEqual([
      { hooks: [mine] },
      { hooks: [{ type: "command", command: PROMPT_HOOK_COMMAND, timeout: 10 }] },
    ]);
    const text = (files.files.get(CONFIG) ?? "").replace(/tools:\n(?: {2}- .*\n)+/, "");
    files.seed(CONFIG, `${text}tools: [codex]\n`);
    await sync(files);
    const after = JSON.parse(files.files.get(SETTINGS) ?? "{}");
    expect(after.hooks).toEqual({ UserPromptSubmit: [{ hooks: [mine] }] });
    expect(files.files.has(PROMPT_HOOK_PATH)).toBe(false);
  });

  it("denies the store to agents in every tool with rules", () => {
    const rules = denyRules({ rootAgentsGenerated: true, claudeMdGenerated: true });
    expect(rules).toContain("Edit(~/.agentplugged/chat/**)");
    // Another Claude Code session, the main branch's refs (the rest is not denied).
    expect(rules).toEqual(
      expect.arrayContaining([
        "Bash(claude *)",
        "Bash(git update-ref*refs/remotes*)",
        "Bash(git remote set-head*)",
      ]),
    );
  });

  it("marks the fallback of every tool without the hook in the matrix", () => {
    for (const entry of COMPATIBILITY) {
      // Claude Code's hook, Antigravity CLI's plugin (it reads the transcript) and Codex's
      // project hook record the creator's messages.
      expect(entry.cells.chat_proof.support).toBe(
        entry.client === "claude-code" ||
          entry.client === "antigravity" ||
          entry.client === "codex" ||
          entry.client === "cursor"
          ? "native"
          : "fallback",
      );
    }
  });
});

describe("constitution: checkpoints in the chat", () => {
  it("asks agents to present each checkpoint and quote the creator's whole message", () => {
    const text = renderConstitutionReference([], DEFAULT_RULES);
    expect(text).toContain("\n## Checkpoints in the chat\n");
    expect(text).toContain("`chat.answer`");
    expect(text).toContain("the creator's whole message, word for word");
    expect(text).not.toContain("`confirmation_quote`");
    expect(text).toContain("`REVIEW_REQUIRED`");
    expect(text).toContain("`decision: reopen`");
    expect(text).not.toContain("nothing you can call resolves");
  });
});

describe("next: where the creator answers", () => {
  const step = {
    you: true,
    checkpoint: "G-AAAAAAAAAA",
    command: "npx agentplugged review G-AAAAAAAAAA",
  };
  const checkpoints = (risk: "low" | "high") => ({
    "G-AAAAAAAAAA": checkpointState("G-AAAAAAAAAA", { risk }),
  });

  it("says the chat, but review for a high risk at the strict level", () => {
    expect(answerChannel(step, checkpoints("high"), "chat")).toBe("chat");
    expect(answerChannel(step, checkpoints("high"), "auto")).toBe("chat");
    expect(answerChannel(step, checkpoints("low"), "strict")).toBe("chat");
    expect(answerChannel(step, checkpoints("high"), "strict")).toBe("terminal");
    // An untrusted session's action: the chat answers it too, the terminal at strict only.
    const untrusted = {
      "G-AAAAAAAAAA": checkpointState("G-AAAAAAAAAA", { risk: "high", source: "untrusted_action" }),
    };
    expect(answerChannel(step, untrusted, "chat")).toBe("chat");
    expect(answerChannel(step, untrusted, "strict")).toBe("terminal");
    expect(answerChannel({ ...step, you: false }, checkpoints("low"), "chat")).toBeNull();
    expect(
      answerChannel({ ...step, command: "npx agentplugged history" }, checkpoints("low"), "chat"),
    ).toBeNull();
  });

  it("speaks of the strict level only at the strict level", () => {
    const untrusted = {
      "G-AAAAAAAAAA": checkpointState("G-AAAAAAAAAA", { risk: "high", source: "untrusted_action" }),
    };
    // The chat answers: no reason to give.
    expect(answerReason(step, checkpoints("high"), "chat")).toBeUndefined();
    expect(answerReason(step, checkpoints("high"), "auto")).toBeUndefined();
    expect(answerReason(step, checkpoints("low"), "strict")).toBeUndefined();
    // The terminal, for the strict level.
    expect(answerReason(step, checkpoints("high"), "strict")).toBe("strict");
    // An untrusted session's action is answered in the chat: no reason to give.
    expect(answerReason(step, untrusted, "chat")).toBeUndefined();
    expect(answerReason(step, untrusted, "auto")).toBeUndefined();
    // Both: the level is the strict one, and the sentence about it is true.
    expect(answerReason(step, untrusted, "strict")).toBe("strict");
    expect(answerReason({ ...step, you: false }, untrusted, "chat")).toBeUndefined();
  });
});

describe("profile and init: the validation level", () => {
  it("init writes the level the creator chose, profile changes it, never anything else", async () => {
    const files = await installed({ validation: "auto" });
    expect(files.files.get(CONFIG)).toContain("validation:\n  mode: auto\n");
    const human = context(files);
    const changed = await profileCommand.run(human, { validation: "strict" });
    expect(changed.ok).toBe(true);
    const value = (changed as { value: ProfileResult }).value;
    expect(value.validation).toEqual({ mode: "strict", previous: "auto" });
    expect(value.action).toBe("updated");
    expect(files.files.get(CONFIG)).toContain("validation:\n  mode: strict\n");
    const refused = await profileCommand.run(human, { validation: "fast" });
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.METHOD_CONFIG_INVALID);
    const same = await profileCommand.run(human, { validation: "strict" });
    expect((same as { value: ProfileResult }).value.action).toBe("unchanged");
  });

  it("init writes nothing without a choice: chat applies", async () => {
    const files = await installed();
    expect(files.files.get(CONFIG)).not.toContain("validation");
  });
});

describe("review: reopening an automatic application", () => {
  async function product() {
    const files = new MemoryFiles();
    let tick = Date.UTC(2026, 9, 3, 12, 0, 0);
    const now = () => {
      tick += 1000;
      return tick;
    };
    const keys = new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(9)));
    const journal = new MemoryStateStore({ keys, now });
    const human: CommandContext = {
      files,
      tools: claudeOnly,
      method: shippedMethod(),
      actor: "human",
      engineVersion: "1.0.0",
      journal,
      now,
      interactive: true,
      human: { keys, presence: new SoftwareAuthenticator() },
    };
    const init = await initCommand.run(human, {
      profile: resolveProfile("new-product"),
      validation: "auto",
    });
    if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
    const registry = createCommandRegistry();
    const agent: CommandContext = { ...human, actor: "agent", human: undefined };
    return { journal, human, agent, registry };
  }

  it("lists it, reopens it signed by the creator, and refuses another checkpoint", async () => {
    const { journal, human, agent, registry } = await product();
    const opened = await registry.run("open_checkpoint", agent, {
      agent: "main",
      type: "decision",
      risk: "low",
      title: "Pick a name",
      summary: "Which name?",
      story: "2-6",
      blocks: [{ action: "story.review", story: "2-6" }],
      options: [
        { id: "a", label: "A", consequence: "a" },
        { id: "b", label: "B", consequence: "b" },
      ],
      recommendation: "b",
    });
    const recorded = (opened as { value: RecordedEvent }).value;
    expect(recorded.auto_applied).toEqual({ checkpoint: recorded.checkpoint, option: "b" });
    // Not in the list of what waits for the creator; by its id only.
    const listed = await registry.run("review", human, { action: "list" });
    expect((listed as { value: { checkpoints: CheckpointState[] } }).value.checkpoints).toEqual([]);
    const one = await registry.run("review", human, {
      action: "list",
      checkpoint: recorded.checkpoint,
    });
    const list = (one as { value: { checkpoints: CheckpointState[] } }).value;
    expect(list.checkpoints.map((checkpoint) => checkpoint.id)).toEqual([recorded.checkpoint]);

    const reopened = await registry.run("review", human, {
      action: "reopen",
      checkpoint: recorded.checkpoint,
    });
    expect(reopened.ok).toBe(true);
    const last = journal.events.at(-1);
    expect(last?.type).toBe("checkpoint.reopened");
    expect(last?.actor.kind).toBe("human");
    const state = await computeProjection(journal.events);
    const checkpoint = (state.state.checkpoints as Record<string, CheckpointState>)[
      recorded.checkpoint as string
    ];
    expect(checkpoint?.status).toBe("open");
    const validations = state.state.validations as ValidationEntry[];
    expect(validations.at(-1)).toMatchObject({ decision: "reopened", source: "terminal" });

    const again = await registry.run("review", human, {
      action: "reopen",
      checkpoint: recorded.checkpoint,
    });
    expect(again.ok ? undefined : again.error.code).toBe(ErrorCode.CHECKPOINT_NOT_REOPENABLE);
  });
});
