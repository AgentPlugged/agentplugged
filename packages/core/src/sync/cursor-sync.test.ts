import { describe, expect, it } from "vitest";
import {
  type Capability,
  COMPATIBILITY,
  type CommandContext,
  CURSOR_ENGINE_MCP_RULE,
  CURSOR_HOOK_PATH,
  CURSOR_HOOKS_PATH,
  CURSOR_POLICY_PATH,
  cursorHookCommand,
  cursorIgnoreBlock,
  DEFAULT_RULES,
  GENERATED_HEADER_SLASH,
  initCommand,
  renderCursorHookScript,
  renderCursorHooks,
  resolveProfile,
  type SyncResult,
  syncCommand,
  type ToolProbe,
  withCursorIgnoreBlock,
  withoutCursorIgnoreBlock,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import {
  CURSOR_HOOKS_KEPT_REASON,
  CURSOR_PERMISSIONS_KEPT_REASON,
  CURSOR_RULES_REASON,
  CURSOR_USAGE_REASON,
} from "./compatibility.js";
import { cursorRulePermissions } from "./rule-permissions.js";

/**
 * Cursor's project hooks (the proof of the chat, the permission rules, the
 * reads), `.cursorignore` for the secrets, the CLI's configuration without approval for the engine's
 * tools, and what Cursor still lacks, said.
 */

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

function context(files: MemoryFiles, platform = "linux"): CommandContext {
  return {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    platform,
  };
}

async function installed(initial: Record<string, string> = {}): Promise<MemoryFiles> {
  const files = new MemoryFiles(initial);
  const result = await initCommand.run(context(files), { profile: resolveProfile("new-product") });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  return files;
}

async function sync(files: MemoryFiles): Promise<SyncResult> {
  const result = await syncCommand.run(context(files), {});
  if (!result.ok) throw new Error(`sync failed: ${result.error.code}`);
  return result.value;
}

const CONFIG = ".agentplugged/method.yaml";
const IGNORE = ".cursorignore";
const CLI = ".cursor/cli.json";

function setTools(files: MemoryFiles, tools: readonly string[]) {
  const text = (files.files.get(CONFIG) ?? "").replace(/tools:\n(?: {2}- .*\n)+/, "");
  files.seed(CONFIG, `${text}tools: [${tools.join(", ")}]\n`);
}

const json = (files: MemoryFiles, path: string) => JSON.parse(files.files.get(path) ?? "null");
const action = (result: SyncResult, path: string) =>
  result.entries.find((entry) => entry.path === path)?.action;

describe("sync: Cursor's hooks, rules and secrets", () => {
  it("writes the hooks, the script and the policy for Cursor", async () => {
    const files = await installed();
    const result = await sync(files);
    for (const path of [CURSOR_HOOKS_PATH, CURSOR_HOOK_PATH, CURSOR_POLICY_PATH, IGNORE]) {
      expect(action(result, path), path).toBe("created");
      expect(result.entries.find((entry) => entry.path === path)?.group).toBe("cursor");
    }
    expect(CURSOR_HOOK_PATH).toBe(".cursor/hooks/agentplugged-cursor.mjs");
    const script = files.files.get(CURSOR_HOOK_PATH) ?? "";
    expect(script.startsWith(`${GENERATED_HEADER_SLASH}\n`)).toBe(true);
    expect(script).toBe(renderCursorHookScript());
    // The script is the same for every product and every engine version: the launch is in the policy.
    expect(script).not.toContain("agentplugged@");
    const policy = json(files, CURSOR_POLICY_PATH);
    expect(policy.version).toBe(1);
    expect(policy.launch).toEqual({ command: "npx", args: ["-y", "agentplugged@1.0.0"] });
    expect(policy.rules).toEqual(DEFAULT_RULES);
    // The lists written for Claude Code, and Cursor's own settings in the home folder.
    expect(policy.deny).toEqual(
      expect.arrayContaining([
        "Edit(/.agentplugged/method.yaml)",
        "Edit(/.cursor/**)",
        "Edit(~/.cursor/hooks.json)",
        "Edit(~/.cursor/projects/**)",
        "Bash(cursor-agent *)",
        "Bash(node *agentplugged-cursor*)",
      ]),
    );
  });

  it("declares the hooks in .cursor/hooks.json, in Cursor's format, the same on every machine", async () => {
    const files = await installed();
    await sync(files);
    const text = files.files.get(CURSOR_HOOKS_PATH) ?? "";
    expect(text).toBe(renderCursorHooks());
    const config = JSON.parse(text);
    // The matchers are valid JavaScript regular expressions, and say what they should.
    const pre = new RegExp(config.hooks.preToolUse[0].matcher);
    for (const name of ["Write", "Delete", "WebFetch", "WebSearch", "MCP:chat"]) {
      expect(pre.test(name), name).toBe(true);
    }
    for (const name of ["Shell", "Read", "Grep", "MCP:state", "MCP:chat_x", "Task"]) {
      expect(pre.test(name), name).toBe(false);
    }
    const post = new RegExp(config.hooks.postToolUse[0].matcher);
    expect(post.test("WebFetch") && post.test("WebSearch")).toBe(true);
    expect(post.test("Shell")).toBe(false);
    expect(cursorHookCommand("shell")).toBe("node .cursor/hooks/agentplugged-cursor.mjs shell");
  });

  it("pins the definitions: a change here changes a file every creator has committed", () => {
    // Cursor reloads `.cursor/hooks.json` on save and asks nothing, but the file is shared in the repository.
    expect(renderCursorHooks()).toMatchInlineSnapshot(`
      "{
        "version": 1,
        "hooks": {
          "sessionStart": [
            {
              "command": "node .cursor/hooks/agentplugged-cursor.mjs session-start",
              "timeout": 10
            }
          ],
          "beforeSubmitPrompt": [
            {
              "command": "node .cursor/hooks/agentplugged-cursor.mjs before-submit",
              "timeout": 10
            }
          ],
          "beforeShellExecution": [
            {
              "command": "node .cursor/hooks/agentplugged-cursor.mjs shell",
              "timeout": 30,
              "failClosed": true
            }
          ],
          "preToolUse": [
            {
              "command": "node .cursor/hooks/agentplugged-cursor.mjs pre-tool",
              "timeout": 30,
              "matcher": "^(?:Write|Delete|WebFetch|WebSearch|MCP:chat)$",
              "failClosed": true
            }
          ],
          "postToolUse": [
            {
              "command": "node .cursor/hooks/agentplugged-cursor.mjs post-tool",
              "timeout": 30,
              "matcher": "^(?:WebFetch|WebSearch)$"
            }
          ],
          "afterShellExecution": [
            {
              "command": "node .cursor/hooks/agentplugged-cursor.mjs post-tool",
              "timeout": 30
            }
          ],
          "afterMCPExecution": [
            {
              "command": "node .cursor/hooks/agentplugged-cursor.mjs post-tool",
              "timeout": 30
            }
          ]
        }
      }
      "
    `);
  });

  it("keeps the creator's .cursor/hooks.json and says what is lost", async () => {
    const mine = `${JSON.stringify({ version: 1, hooks: { stop: [{ command: "echo done" }] } }, null, 2)}\n`;
    const files = await installed({ [CURSOR_HOOKS_PATH]: mine });
    const result = await sync(files);
    expect(files.files.get(CURSOR_HOOKS_PATH)).toBe(mine);
    expect(result.warnings).toContainEqual({ kind: "conflict", path: CURSOR_HOOKS_PATH });
    // No script, no policy: nothing runs them.
    expect(files.files.has(CURSOR_HOOK_PATH)).toBe(false);
    expect(files.files.has(CURSOR_POLICY_PATH)).toBe(false);
    const reasons = Object.fromEntries(
      result.fallbacks
        .filter((fallback) => fallback.client === "cursor")
        .map((fallback) => [fallback.capability, fallback]),
    );
    expect(reasons.permissions?.reason).toBe(CURSOR_PERMISSIONS_KEPT_REASON);
    expect(reasons.permissions?.id).toBe("cursor.permissions.hooks-kept");
    for (const capability of ["rules", "untrusted", "chat_proof", "installs"]) {
      expect(reasons[capability]?.reason, capability).toBe(CURSOR_HOOKS_KEPT_REASON);
      expect(reasons[capability]?.id, capability).toBe(`cursor.${capability}.hooks-kept`);
    }
    // The secrets are still kept from the agent.
    expect(files.files.get(IGNORE)).toContain(cursorIgnoreBlock());
    // A second run changes nothing and keeps the file.
    const again = await sync(files);
    expect(files.files.get(CURSOR_HOOKS_PATH)).toBe(mine);
    expect(again.warnings).toContainEqual({ kind: "conflict", path: CURSOR_HOOKS_PATH });
  });

  it("refreshes its own .cursor/hooks.json, and removes it with the tool", async () => {
    const files = await installed();
    await sync(files);
    const again = await sync(files);
    expect(action(again, CURSOR_HOOKS_PATH)).toBe("unchanged");
    expect(again.warnings).toEqual([]);

    setTools(files, ["claude-code", "codex"]);
    const result = await sync(files);
    for (const path of [CURSOR_HOOKS_PATH, CURSOR_HOOK_PATH, CURSOR_POLICY_PATH]) {
      expect(action(result, path), path).toBe("deleted");
      expect(files.files.has(path), path).toBe(false);
    }
    // `.cursorignore` was ours alone: it goes with the tool.
    expect(action(result, IGNORE)).toBe("deleted");
    expect(files.files.has(IGNORE)).toBe(false);
  });

  it("completes the CLI's file: the engine's tools allowed, and an ask of a command is no longer a deny", async () => {
    const files = await installed();
    const result = await sync(files);
    const cli = json(files, CLI);
    expect(cli.permissions.allow).toContain(CURSOR_ENGINE_MCP_RULE);
    expect(CURSOR_ENGINE_MCP_RULE).toBe("Mcp(agentplugged:*)");
    expect(cli.permissions.deny).toContain("Shell(gh:pr merge*)");
    expect(result.rules?.cursorAskedAsDeny).toEqual([]);

    const asking = { ...DEFAULT_RULES, install_dependency: "ask" as const };
    // With the hooks the rule asks (`beforeShellExecution`), so nothing is written as `deny` for it.
    const withHooks = cursorRulePermissions(asking, "main", true);
    expect(withHooks.askedAsDeny).toEqual([]);
    expect(withHooks.allow).toContain(CURSOR_ENGINE_MCP_RULE);
    // Without them it is, as before, and said.
    const withoutHooks = cursorRulePermissions(asking, "main", false);
    expect(withoutHooks.askedAsDeny).toEqual(["install_dependency"]);
    expect(withoutHooks.deny.length).toBeGreaterThan(withHooks.deny.length);
    // What a hook cannot ask (a file write) stays a `deny` of the CLI, and is said.
    const editing = cursorRulePermissions({ ...DEFAULT_RULES, edit_code: "ask" }, "main", true);
    expect(editing.askedAsDeny).toEqual(["edit_code"]);
    expect(editing.deny).toContain("Write(**)");
    // What the creator denies stays denied either way.
    const denying = { ...DEFAULT_RULES, install_dependency: "deny" as const };
    expect(cursorRulePermissions(denying, "main", true).deny).toEqual(
      cursorRulePermissions(denying, "main", false).deny,
    );
  });

  it("reports what remains: forms and working copies, and that usage is not measured", async () => {
    const files = await installed();
    const result = await sync(files);
    const cursor = result.fallbacks.filter((fallback) => fallback.client === "cursor");
    expect(cursor.map((fallback) => fallback.id)).toEqual([
      "cursor.rules",
      "cursor.isolation",
      "cursor.decisions",
      "cursor.usage",
    ]);
    expect(cursor.find((fallback) => fallback.capability === "rules")?.reason).toBe(
      CURSOR_RULES_REASON,
    );
    expect(cursor.find((fallback) => fallback.capability === "usage")?.reason).toBe(
      CURSOR_USAGE_REASON,
    );
    // The matrix says what is native for Cursor now.
    const cells = COMPATIBILITY.find((entry) => entry.client === "cursor")?.cells;
    for (const capability of [
      "permissions",
      "rules",
      "untrusted",
      "chat_proof",
      "installs",
    ] as Capability[]) {
      expect(cells?.[capability].files, capability).toContain(CURSOR_HOOKS_PATH);
    }
    for (const capability of ["permissions", "untrusted", "chat_proof", "installs"] as const) {
      expect(cells?.[capability].support, capability).toBe("native");
    }
    expect(cells?.permissions.files).toContain(IGNORE);
    expect(cells?.usage.support).toBe("fallback");
  });
});

describe("sync: .cursorignore", () => {
  it("holds the secrets the permission rules never let an agent read, in one marked block", async () => {
    const files = await installed();
    await sync(files);
    const text = files.files.get(IGNORE) ?? "";
    expect(text).toBe(`${cursorIgnoreBlock()}\n`);
    for (const pattern of [".env", ".env.local", ".env.*.local", ".env.production*"]) {
      expect(text.split("\n"), pattern).toContain(pattern);
    }
    // `.env.example` is not a secret: nothing here matches it.
    expect(text.split("\n")).not.toContain(".env*");
  });

  it("keeps the creator's lines, before and after, and the line breaks they use", () => {
    const mine = "node_modules\r\ndist/\r\n";
    const added = withCursorIgnoreBlock(mine);
    expect(added.startsWith(mine)).toBe(true);
    expect(added).toContain(cursorIgnoreBlock("\r\n"));
    expect(added.includes("\r\n")).toBe(true);
    expect(withCursorIgnoreBlock(added)).toBe(added);
    // A block an older engine wrote is replaced in place.
    const old = added.replace(".env.local", ".env.stale");
    expect(withCursorIgnoreBlock(old)).toBe(added);
    // The creator may add lines after the block.
    const edited = `${added}!.env.local\r\n`;
    expect(withCursorIgnoreBlock(edited)).toBe(edited);
    expect(withoutCursorIgnoreBlock(edited)).toBe("node_modules\r\ndist/\r\n!.env.local\r\n");
    expect(withoutCursorIgnoreBlock(added)).toBe("node_modules\r\ndist/\r\n");
  });

  it("leaves a file without our block alone, and an empty file means no file", () => {
    expect(withoutCursorIgnoreBlock("a\nb\n")).toBe("a\nb\n");
    expect(withoutCursorIgnoreBlock(withCursorIgnoreBlock(undefined))).toBeUndefined();
    expect(withoutCursorIgnoreBlock(withCursorIgnoreBlock("  \n"))).toBeUndefined();
    // A begin marker with no end marker is the creator's text: the block goes after it.
    const broken = "# >>> agentplugged (generated: secrets agents never read) >>>\nmine\n";
    expect(withCursorIgnoreBlock(broken)).toContain(`${broken}\n${cursorIgnoreBlock()}\n`);
  });

  it("adds its block to the creator's file at sync, and takes it back with the tool", async () => {
    const files = await installed({ [IGNORE]: "build/\n" });
    const first = await sync(files);
    expect(action(first, IGNORE)).toBe("updated");
    expect(files.files.get(IGNORE)).toBe(`build/\n\n${cursorIgnoreBlock()}\n`);
    expect(action(await sync(files), IGNORE)).toBe("unchanged");

    setTools(files, ["claude-code"]);
    const left = await sync(files);
    expect(action(left, IGNORE)).toBe("updated");
    expect(files.files.get(IGNORE)).toBe("build/\n");
  });
});
