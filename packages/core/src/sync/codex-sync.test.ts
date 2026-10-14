import { describe, expect, it } from "vitest";
import {
  type Capability,
  CODEX_HOOK_PATH,
  CODEX_POLICY_PATH,
  CODEX_RULES_PATH,
  COMPATIBILITY,
  type CommandContext,
  DEFAULT_RULES,
  GENERATED_HEADER_SLASH,
  initCommand,
  renderCodexHookScript,
  renderCodexHooks,
  renderCodexRules,
  resolveProfile,
  type SyncResult,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import {
  CODEX_CONFIG_KEPT_REASON,
  CODEX_HOOKS_CONFIG_KEPT_REASON,
  CODEX_RULES_CONFIG_KEPT_REASON,
} from "./compatibility.js";
import { SYNC_MANIFEST_PATH } from "./manifest.js";

/**
 * Codex's project hooks (the proof of the chat, the permission rules, the reads), its
 * rules of commands, and a configuration without approval inside the sandbox.
 */

const GRANULAR_NEVER =
  "{ granular = { mcp_elicitations = true, rules = false, sandbox_approval = false, request_permissions = false, skill_approval = false } }";

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

async function sync(files: MemoryFiles, platform = "linux"): Promise<SyncResult> {
  const result = await syncCommand.run(context(files, platform), {});
  if (!result.ok) throw new Error(`sync failed: ${result.error.code}`);
  return result.value;
}

const CONFIG = ".agentplugged/method.yaml";
const CODEX_CONFIG = ".codex/config.toml";

function setTools(files: MemoryFiles, tools: readonly string[]) {
  const text = (files.files.get(CONFIG) ?? "").replace(/tools:\n(?: {2}- .*\n)+/, "");
  files.seed(CONFIG, `${text}tools: [${tools.join(", ")}]\n`);
}

const json = (files: MemoryFiles, path: string) => JSON.parse(files.files.get(path) ?? "null");
const action = (result: SyncResult, path: string) =>
  result.entries.find((entry) => entry.path === path)?.action;

describe("sync: Codex's hooks, rules and configuration", () => {
  it("writes the script, the policy and the rules of commands, for Codex", async () => {
    const files = await installed();
    const result = await sync(files);
    for (const path of [CODEX_HOOK_PATH, CODEX_POLICY_PATH, CODEX_RULES_PATH]) {
      expect(action(result, path), path).toBe("created");
      expect(result.entries.find((entry) => entry.path === path)?.group).toBe("codex");
    }
    expect(CODEX_HOOK_PATH).toBe(".codex/hooks/agentplugged-codex.mjs");
    const script = files.files.get(CODEX_HOOK_PATH) ?? "";
    expect(script.startsWith(`${GENERATED_HEADER_SLASH}\n`)).toBe(true);
    expect(script).toBe(renderCodexHookScript());
    // The script is the same for every product and every engine version: the launch is in the policy.
    expect(script).not.toContain("agentplugged@");
    const policy = json(files, CODEX_POLICY_PATH);
    expect(policy.version).toBe(1);
    expect(policy.launch).toEqual({ command: "npx", args: ["-y", "agentplugged@1.0.0"] });
    expect(policy.rules).toEqual(DEFAULT_RULES);
    expect(policy.main_branch).toBeUndefined();
    // The lists written for Claude Code, and Codex's own settings in the home folder.
    expect(policy.deny).toEqual(
      expect.arrayContaining([
        "Edit(/.agentplugged/method.yaml)",
        "Edit(/.codex/**)",
        "Edit(~/.codex/config.toml)",
        "Edit(~/.codex/hooks.json)",
        "Bash(codex *)",
        "Bash(node *agentplugged-codex*)",
      ]),
    );
  });

  it("declares the hooks in config.toml, the same on every machine and every engine version", async () => {
    const files = await installed();
    await sync(files);
    const config = files.files.get(CODEX_CONFIG) ?? "";
    expect(config).toContain(renderCodexHooks());
    const hooks = renderCodexHooks();
    for (const [event, matcher] of [
      ["UserPromptSubmit", undefined],
      ["PreToolUse", "^(Bash|apply_patch)$"],
      ["PostToolUse", "^(Bash|mcp__.*)$"],
    ] as const) {
      expect(hooks).toContain(`[[hooks.${event}]]`);
      expect(hooks).toContain(`[[hooks.${event}.hooks]]`);
      if (matcher !== undefined) expect(hooks).toContain(`matcher = "${matcher}"`);
    }
    expect(hooks).toContain(
      'command = "node \\"$(git rev-parse --show-toplevel)/.codex/hooks/agentplugged-codex.mjs\\" pre-tool"',
    );
    expect(hooks).toContain(
      'command_windows = "node \\".codex/hooks/agentplugged-codex.mjs\\" pre-tool"',
    );
    // Nothing of the engine's version: an update asks for no new approval.
    expect(hooks).not.toMatch(/agentplugged@|\d+\.\d+\.\d+/);
    // No `ask`: Codex's hooks know allow and deny only.
    expect(hooks).not.toContain("ask");
  });

  it("pins the definitions of the hooks: Codex asks the creator again when one changes (observed on 0.160.1)", () => {
    // Codex keeps its approval under `<config path>:<event>:<group>:<handler>` and against the hash of
    // the command of the platform, the timeout and the matcher (never the script). Changing a line
    // of this text, or putting a hook before another, asks every creator to approve again: do it
    // only on purpose, and add a new hook last.
    expect(renderCodexHooks()).toBe(
      [
        "[[hooks.UserPromptSubmit]]",
        "",
        "[[hooks.UserPromptSubmit.hooks]]",
        'type = "command"',
        'command = "node \\"$(git rev-parse --show-toplevel)/.codex/hooks/agentplugged-codex.mjs\\" user-prompt"',
        'command_windows = "node \\".codex/hooks/agentplugged-codex.mjs\\" user-prompt"',
        "timeout = 10",
        "",
        "[[hooks.PreToolUse]]",
        'matcher = "^(Bash|apply_patch)$"',
        "",
        "[[hooks.PreToolUse.hooks]]",
        'type = "command"',
        'command = "node \\"$(git rev-parse --show-toplevel)/.codex/hooks/agentplugged-codex.mjs\\" pre-tool"',
        'command_windows = "node \\".codex/hooks/agentplugged-codex.mjs\\" pre-tool"',
        "timeout = 30",
        "",
        "[[hooks.PostToolUse]]",
        'matcher = "^(Bash|mcp__.*)$"',
        "",
        "[[hooks.PostToolUse.hooks]]",
        'type = "command"',
        'command = "node \\"$(git rev-parse --show-toplevel)/.codex/hooks/agentplugged-codex.mjs\\" post-tool"',
        'command_windows = "node \\".codex/hooks/agentplugged-codex.mjs\\" post-tool"',
        "timeout = 30",
        "",
      ].join("\n"),
    );
  });

  it("writes the sandbox without approval, the engine's tools approved, and asks for approval at the strict level", async () => {
    const files = await installed();
    await sync(files);
    const config = files.files.get(CODEX_CONFIG) ?? "";
    // Observed on Codex 0.160.1: a bare `never` declines the forms silently; the granular form keeps them.
    expect(config).toContain(
      `sandbox_mode = "workspace-write"\napproval_policy = ${GRANULAR_NEVER}\n`,
    );
    expect(config).not.toContain('approval_policy = "never"');
    expect(config).toContain(
      '[mcp_servers.agentplugged]\ncommand = "npx"\nargs = ["-y", "agentplugged@1.0.0", "mcp"]\ndefault_tools_approval_mode = "approve"\n',
    );
    // Edits that ask first: the sandbox is read-only and Codex keeps asking.
    const strict = await installed();
    strict.seed(CONFIG, `${strict.files.get(CONFIG) ?? ""}validation:\n  mode: strict\n`);
    await sync(strict);
    expect(strict.files.get(CODEX_CONFIG)).toContain(
      'sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n',
    );
  });

  it("writes the rules of commands: forbidden for what is denied, git writes allowed outside the sandbox", async () => {
    const files = await installed();
    await sync(files);
    const rules = files.files.get(CODEX_RULES_PATH) ?? "";
    expect(
      rules.startsWith("# Generated by agentplugged. Do not edit: changes are overwritten.\n"),
    ).toBe(true);
    expect(rules).toBe(renderCodexRules(DEFAULT_RULES));
    expect(rules).toContain(
      'pattern = ["git", "push", "origin", ["main", "HEAD:main", "refs/heads/main"]],\n    decision = "forbidden",',
    );
    expect(rules).toContain(
      'pattern = ["git", "push", ["--force", "-f", "--force-with-lease"]],\n    decision = "forbidden",',
    );
    expect(rules).toContain(
      'pattern = ["rm", ["-r", "-R", "-rf", "-fr", "-Rf", "-fR", "-rfv", "-frv", "--recursive"], "/"],',
    );
    expect(rules).toContain('pattern = ["git", ["add", "commit", "switch",');
    expect(rules).toContain('decision = "allow",');
    // Never outside the sandbox: a rebase (`--exec`) and a working copy made by the agent.
    expect(rules).not.toMatch(/"rebase"|"worktree"/);
    // What agents never run, written the same way: the merge by hand, the forges' tokens, the
    // journal's branch, another AI session.
    for (const words of [
      '["gh", "pr", "merge"]',
      '["glab", "mr", "merge"]',
      '["gh", "repo", "delete"]',
      '["gh", "auth"]',
      '["git", "checkout", "agentplugged/journal"]',
      '["codex"]',
      '["claude"]',
    ]) {
      expect(rules, words).toContain(`pattern = ${words},\n    decision = "forbidden",`);
    }
    // The bare `git push` (the story's own branch) is no rule: a prefix cannot tell it from a push of main.
    expect(rules).not.toContain('pattern = ["git", "push"],');
  });

  it("writes the creator's `ask` as a prompt rule only while Codex asks for approvals", () => {
    const rules = { ...DEFAULT_RULES, install_dependency: "ask" as const };
    // Approval `never`: Codex cannot ask, a `prompt` would be a refusal no answer could lift.
    expect(renderCodexRules(rules, "trunk", "never")).not.toContain('decision = "prompt"');
    const asked = renderCodexRules(rules, "trunk", "on-request");
    expect(asked).toContain('pattern = ["npm", "install"],\n    decision = "prompt",');
    expect(asked).toContain('"trunk"');
    const open = renderCodexRules({ ...DEFAULT_RULES, edit_code: "ask" });
    // With edits that ask, nothing is allowed outside the sandbox.
    expect(open).not.toContain('decision = "allow"');
    const none = renderCodexRules({
      ...DEFAULT_RULES,
      destructive_command: "ask",
      push_main: "deny",
      force_push: "deny",
    });
    expect(none).toContain('decision = "prompt"');
    // A wildcard in the middle of a pattern is never written as a prefix.
    expect(renderCodexRules(DEFAULT_RULES)).not.toContain("*");
  });

  it("is stable: a second sync changes nothing, and a removed tool takes its files with it", async () => {
    const files = await installed();
    await sync(files);
    const again = await sync(files);
    for (const path of [CODEX_CONFIG, CODEX_HOOK_PATH, CODEX_POLICY_PATH, CODEX_RULES_PATH]) {
      expect(action(again, path), path).toBe("unchanged");
    }
    setTools(files, ["claude-code"]);
    const removed = await sync(files);
    for (const path of [CODEX_CONFIG, CODEX_HOOK_PATH, CODEX_POLICY_PATH, CODEX_RULES_PATH]) {
      expect(action(removed, path), path).toBe("deleted");
      expect(files.files.has(path), path).toBe(false);
    }
    expect(json(files, SYNC_MANIFEST_PATH).files[CODEX_POLICY_PATH]).toBeUndefined();
  });

  it("follows the permission rules: a changed rule rewrites the policy and the rules of commands", async () => {
    const files = await installed();
    await sync(files);
    files.seed(CONFIG, `${files.files.get(CONFIG) ?? ""}rules:\n  install_dependency: deny\n`);
    const result = await sync(files);
    expect(action(result, CODEX_POLICY_PATH)).toBe("updated");
    expect(action(result, CODEX_RULES_PATH)).toBe("updated");
    expect(json(files, CODEX_POLICY_PATH).rules.install_dependency).toBe("deny");
    expect(files.files.get(CODEX_RULES_PATH)).toContain('pattern = ["npm", "install"],');
  });

  it("reports what remains: asks, hosted web search, working copies, forms", async () => {
    const files = await installed();
    const result = await sync(files);
    const codex = result.fallbacks.filter((fallback) => fallback.client === "codex");
    expect(codex.map((fallback) => fallback.capability)).toEqual([
      "rules",
      "untrusted",
      "isolation",
      "decisions",
    ]);
    expect(codex.find((fallback) => fallback.capability === "rules")?.reason).toContain(
      "never `ask`",
    );
    expect(codex.find((fallback) => fallback.capability === "untrusted")?.reason).toContain(
      "web search is a hosted tool",
    );
    expect(codex.find((fallback) => fallback.capability === "isolation")?.reason).toContain(
      "writable_roots",
    );
    expect(codex.find((fallback) => fallback.capability === "decisions")?.reason).toContain(
      "Codex 0.160",
    );
    // The matrix says what is native for Codex now.
    const cells = COMPATIBILITY.find((entry) => entry.client === "codex")?.cells;
    for (const capability of ["permissions", "chat_proof", "installs"] as Capability[]) {
      expect(cells?.[capability].support, capability).toBe("native");
      expect(cells?.[capability].files, capability).toContain(CODEX_HOOK_PATH);
    }
  });

  it("falls back everywhere the hooks would have helped when config.toml is the creator's", async () => {
    const mine = 'model = "o9"\n';
    const files = await installed({ [CODEX_CONFIG]: mine });
    const result = await sync(files);
    expect(files.files.get(CODEX_CONFIG)).toBe(mine);
    // The rules of commands are independent of config.toml: still written. No hook is declared, so
    // neither the script nor its policy: the engine then says the hooks are missing.
    expect(files.files.has(CODEX_RULES_PATH)).toBe(true);
    expect(files.files.has(CODEX_HOOK_PATH)).toBe(false);
    expect(files.files.has(CODEX_POLICY_PATH)).toBe(false);
    const reasons = Object.fromEntries(
      result.fallbacks
        .filter((fallback) => fallback.client === "codex")
        .map((fallback) => [fallback.capability, fallback.reason]),
    );
    expect(reasons.permissions).toBe(CODEX_CONFIG_KEPT_REASON);
    expect(reasons.rules).toBe(CODEX_RULES_CONFIG_KEPT_REASON);
    for (const capability of ["untrusted", "chat_proof", "installs"]) {
      expect(reasons[capability], capability).toBe(CODEX_HOOKS_CONFIG_KEPT_REASON);
    }
    expect(result.fallbacks.find((fallback) => fallback.capability === "chat_proof")?.id).toBe(
      "codex.chat_proof.config-kept",
    );
  });
});
