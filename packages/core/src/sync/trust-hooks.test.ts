import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  createCommandRegistry,
  DEFAULT_RULES,
  initCommand,
  renderConstitutionReference,
  resolveProfile,
  type SyncResult,
  syncCommand,
  TOOL_GROUPS,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import {
  claudeTrustHooks,
  hookValue,
  isTrustHook,
  OTHER_MCP_MATCHER,
  withTrustHooks,
} from "./trust-hooks.js";

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

async function installed(initial: Record<string, string> = {}): Promise<MemoryFiles> {
  const files = new MemoryFiles(initial);
  const result = await initCommand.run(context(files), {
    profile: resolveProfile("new-product"),
  });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  return files;
}

async function sync(files: MemoryFiles): Promise<SyncResult> {
  const result = await syncCommand.run(context(files), {});
  if (!result.ok) throw new Error(`sync failed: ${result.error.code}`);
  return result.value;
}

const settingsOf = (files: MemoryFiles) => JSON.parse(files.files.get(SETTINGS) ?? "null");

describe("Claude Code hooks of untrusted content", () => {
  it("records external reads after a fetch, a search and another MCP server's tool", () => {
    const hooks = claudeTrustHooks(DEFAULT_RULES);
    expect(hooks.PostToolUse.map((group) => group.matcher)).toEqual([
      "WebFetch",
      "WebSearch",
      "Bash",
      OTHER_MCP_MATCHER,
      // The creator's answers to the question tool.
      "AskUserQuestion",
    ]);
    // Network commands, each by its own `if`.
    expect(hooks.PostToolUse[2]?.hooks.map((hook) => hook.if)).toEqual([
      "Bash(curl*)",
      "Bash(wget*)",
      "Bash(gh *)",
      "Bash(git pull*)",
      "Bash(git fetch*)",
      "Bash(git clone*)",
      "Bash(Invoke-WebRequest*)",
      "Bash(Invoke-RestMethod*)",
      "Bash(iwr *)",
      "Bash(irm *)",
    ]);
    expect(hooks.PostToolUse[2]?.hooks[0]?.input).toEqual({
      action: "external_read",
      tool: "Bash",
      source: hookValue("tool_input.command"),
      session: hookValue("session_id"),
    });
    expect(hooks.PostToolUse[0]?.hooks).toEqual([
      {
        type: "mcp_tool",
        server: "agentplugged",
        tool: "guard",
        input: {
          action: "external_read",
          tool: "WebFetch",
          source: hookValue("tool_input.url"),
          session: hookValue("session_id"),
        },
        timeout: 30,
      },
    ]);
    const other = new RegExp(OTHER_MCP_MATCHER);
    expect(other.test("mcp__github__get_issue")).toBe(true);
    expect(other.test("mcp__agentplugged__get_state")).toBe(false);
    expect(other.test("Bash")).toBe(false);
    // The editor's servers bring nothing from outside.
    expect(other.test("mcp__ide__getDiagnostics")).toBe(false);
    expect(other.test("mcp__claude-vscode__getDiagnostics")).toBe(false);
  });

  it("calls only tools and actions the server publishes, with the fields their commands take", () => {
    const hooks = claudeTrustHooks(DEFAULT_RULES);
    const calls = [...hooks.PreToolUse, ...hooks.PostToolUse]
      .flatMap((group) => group.hooks)
      .filter((hook) => hook.type === "mcp_tool") as Array<{
      tool: string;
      input: Record<string, unknown>;
    }>;
    expect(calls.length).toBeGreaterThan(3);
    for (const { tool, input } of calls) {
      const action = TOOL_GROUPS[tool]?.actions[String(input.action)];
      expect(action, `${tool}.${String(input.action)}`).toBeDefined();
      // Back to the command's own fields: what the hook sends is what its schema takes.
      const fields = { ...input } as Record<string, unknown>;
      delete fields.action;
      for (const [published, own] of Object.entries(action?.rename ?? {})) {
        if (published in fields) {
          fields[own] = fields[published];
          delete fields[published];
        }
      }
      const command = createCommandRegistry()
        .agentCommands()
        .find((candidate) => candidate.name === action?.command);
      const schema = command?.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      // The substituted values (${…}) are plain strings by the time the command runs.
      expect(schema.safeParse(fields).success, `${tool}.${String(input.action)}`).toBe(true);
    }
    // Hooks written by an older `sync` (one-action tools) are still recognised as ours, to be replaced.
    expect(
      isTrustHook({ type: "mcp_tool", server: "agentplugged", tool: "check_action", input: {} }),
    ).toBe(true);
  });

  it("gates the installations unless their rule is deny, one handler per command pattern", () => {
    const hooks = claudeTrustHooks(DEFAULT_RULES);
    // The last group is the question tool's hook: it refuses a call that carries answers.
    // Only the installations are gated: the other rules are written as the tool's own.
    expect(hooks.PreToolUse.map((group) => group.matcher)).toEqual([
      "Bash",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "AskUserQuestion",
    ]);
    const [install] = hooks.PreToolUse;
    expect(install?.hooks).toContainEqual({
      type: "mcp_tool",
      server: "agentplugged",
      tool: "guard",
      if: "Bash(npm install*)",
      input: {
        action: "check",
        what: "install_dependency",
        command: hookValue("tool_input.command"),
        session: hookValue("session_id"),
        cwd: hookValue("cwd"),
      },
      timeout: 30,
    });
    expect(install?.hooks.every((hook) => hook.input && isTrustHook(hook))).toBe(true);
    // A rule that denies is refused by the tool first: nothing to ask.
    const denied = claudeTrustHooks({ ...DEFAULT_RULES, install_dependency: "deny" });
    expect(denied.PreToolUse.map((group) => group.matcher)).toEqual([
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "AskUserQuestion",
    ]);
  });

  it("keeps the creator's hooks, replaces ours, and removes only what ours emptied", () => {
    const mine = { type: "command", command: "lint.sh" };
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [mine] }],
        Stop: [{ hooks: [mine] }],
      },
    };
    const hooks = claudeTrustHooks(DEFAULT_RULES);
    const once = withTrustHooks(settings, hooks);
    expect(withTrustHooks(once, hooks)).toEqual(once);
    expect(once.hooks.PreToolUse[0]).toEqual({ matcher: "Bash", hooks: [mine] });
    expect(once.hooks.PreToolUse).toHaveLength(7);
    expect(once.hooks.Stop).toEqual([{ hooks: [mine] }]);
    expect(withTrustHooks(once, undefined)).toEqual(settings);

    const only = withTrustHooks({ env: {} }, hooks);
    expect(withTrustHooks(only, undefined)).toEqual({ env: {} });
    // A hook of ours in the creator's group: only it leaves.
    const shared = {
      hooks: {
        PostToolUse: [
          { matcher: "WebFetch", hooks: [mine, ...(hooks.PostToolUse[0]?.hooks ?? [])] },
        ],
      },
    };
    expect(withTrustHooks(shared, undefined)).toEqual({
      hooks: { PostToolUse: [{ matcher: "WebFetch", hooks: [mine] }] },
    });
    // Something that is not a hooks object is left as is.
    expect(withTrustHooks({ hooks: "mine" }, hooks)).toEqual({ hooks: "mine" });
    expect(withTrustHooks({ hooks: {} }, undefined)).toEqual({ hooks: {} });
  });

  it("are written by sync while Claude Code is targeted, then taken back", async () => {
    const files = await installed();
    await sync(files);
    const settings = settingsOf(files);
    expect(Object.keys(settings.hooks)).toEqual(["PreToolUse", "PostToolUse", "UserPromptSubmit"]);
    expect(settings.hooks.PostToolUse).toHaveLength(5);
    // A second sync changes nothing.
    const again = await sync(files);
    expect(again.entries.find((entry) => entry.path === SETTINGS)?.action).toBe("unchanged");

    const text = (files.files.get(CONFIG) ?? "").replace(/tools:\n(?: {2}- .*\n)+/, "");
    files.seed(CONFIG, `${text}tools: [codex]\n`);
    await sync(files);
    expect(files.files.has(SETTINGS)).toBe(false);
  });

  it("follow the rules: no install gate once installing is denied", async () => {
    const files = await installed();
    files.seed(CONFIG, `${files.files.get(CONFIG) ?? ""}rules:\n  install_dependency: deny\n`);
    await sync(files);
    // The question tool's hook is a command hook with no gate input: left out here.
    const actions = settingsOf(files)
      .hooks.PreToolUse.filter((group: { matcher?: string }) => group.matcher === "Bash")
      .flatMap((group: { hooks: { input: { what: string } }[] }) =>
        group.hooks.map((hook) => hook.input.what),
      );
    expect(actions).toEqual([]);
  });
});

describe("constitution: external content", () => {
  it("says that reading the internet leaves a trace and blocks nothing", () => {
    const byDefault = renderConstitutionReference([], DEFAULT_RULES);
    expect(byDefault).toContain("\n## External content\n");
    expect(byDefault).toContain("nothing: the engine only keeps a trace of it in the journal");
    expect(byDefault).toContain("`read_secrets` is always denied");
    expect(byDefault).not.toContain("every session is untrusted from its start");
    expect(byDefault.indexOf("## External content")).toBeLessThan(
      byDefault.indexOf("## Permission rules"),
    );
  });
});
