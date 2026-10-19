import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  initCommand,
  resolveProfile,
  type SyncResult,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { CODEX_MCP_CONFIG_KEPT_REASON, mcpConflictReason } from "./compatibility.js";
import { SYNC_MANIFEST_PATH } from "./manifest.js";
import { isGeneratedMcpEntry } from "./mcp.js";

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

function setTools(files: MemoryFiles, tools: readonly string[]) {
  const text = (files.files.get(CONFIG) ?? "").replace(/tools:\n(?: {2}- .*\n)+/, "");
  files.seed(CONFIG, `${text}tools: [${tools.join(", ")}]\n`);
}

const json = (files: MemoryFiles, path: string) => JSON.parse(files.files.get(path) ?? "null");
const action = (result: SyncResult, path: string) =>
  result.entries.find((entry) => entry.path === path)?.action;

/** Antigravity reads MCP servers from a plugin only. */
const PLUGIN_MCP = ".agents/plugins/agentplugged/mcp_config.json";

const ARGS = ["-y", "agentplugged@1.0.0", "mcp"];

describe("sync: the agentplugged MCP server", () => {
  it("is declared in each tool's project configuration with the pinned engine", async () => {
    const files = await installed();
    const result = await sync(files);
    expect(json(files, ".mcp.json")).toEqual({
      mcpServers: { agentplugged: { type: "stdio", command: "npx", args: ARGS } },
    });
    expect(json(files, ".cursor/mcp.json")).toEqual({
      mcpServers: { agentplugged: { type: "stdio", command: "npx", args: ARGS } },
    });
    expect(json(files, PLUGIN_MCP)).toEqual({
      mcpServers: { agentplugged: { command: "npx", args: ARGS } },
    });
    // The retired Gemini CLI's settings are never created.
    expect(files.files.has(".gemini/settings.json")).toBe(false);
    expect(files.files.get(".codex/config.toml")).toContain(
      '\n[mcp_servers.agentplugged]\ncommand = "npx"\nargs = ["-y", "agentplugged@1.0.0", "mcp"]\n',
    );
    expect(result.fallbacks.filter((f) => f.capability === "mcp")).toEqual([]);
    // Agents may not change the server they report through.
    expect(json(files, ".claude/settings.json").permissions.deny).toContain("Edit(/.mcp.json)");
    expect(json(files, ".cursor/cli.json").permissions.deny).toContain("Write(.mcp.json)");
    // The constitution makes the server mandatory.
    const constitution = files.reference();
    expect(constitution).toContain("\n## Reporting\n");
    for (const tool of [
      "agent.status",
      "story.progress",
      "measure.cost",
      "story.result",
      "checkpoint.open",
      "checkpoint.measures",
    ]) {
      expect(constitution).toContain(`\`${tool}\``);
    }
    // When to open a checkpoint, and never to work around a refusal.
    expect(constitution).not.toContain("does not open a checkpoint yet");
    const prose = constitution.replace(/\s+/g, " ");
    for (const text of [
      "`story.result` with `blocked` opens one for you",
      "`agent.status` or `story.status` with `blocked` open none",
      "are recorded, and enforced when the corresponding command exists",
      "never work around the refusal",
    ]) {
      expect(prose).toContain(text);
    }
    expect(constitution).toContain("## Sensitive content");
    expect(constitution).toContain("`guard.read_sensitive` and `guard.write_sensitive`");
    expect(constitution).toContain(
      "A lost product key makes the encrypted content unreadable for ever.",
    );
    expect(constitution).toContain("the reserved id `main`");
    expect(constitution).toContain("The agent id is declared, not proven");
  });

  it("follows the pinned version, and changes nothing when run again", async () => {
    const files = await installed();
    await sync(files);
    files.writes.length = 0;
    const again = await sync(files);
    expect(again.entries.every((entry) => entry.action === "unchanged")).toBe(true);
    expect(files.writes).toEqual([]);

    files.seed(
      CONFIG,
      (files.files.get(CONFIG) ?? "").replace("engine_version: 1.0.0", "engine_version: 1.2.0"),
    );
    const bumped = await sync(files);
    for (const path of [".mcp.json", PLUGIN_MCP, ".cursor/mcp.json", ".codex/config.toml"]) {
      expect(action(bumped, path), path).toBe("updated");
      expect(files.files.get(path), path).toContain("agentplugged@1.2.0");
    }
  });

  it("merges into the creator's .mcp.json, then takes back only its entry", async () => {
    const mine = { mcpServers: { docs: { command: "docs-server" } }, other: true };
    const files = await installed({ ".mcp.json": `${JSON.stringify(mine, null, 2)}\r\n` });
    const result = await sync(files);
    expect(action(result, ".mcp.json")).toBe("updated");
    const merged = json(files, ".mcp.json");
    expect(merged.other).toBe(true);
    expect(merged.mcpServers.docs).toEqual({ command: "docs-server" });
    expect(isGeneratedMcpEntry(merged.mcpServers.agentplugged)).toBe(true);
    expect(files.files.get(".mcp.json")).toContain("\r\n");
    expect(json(files, SYNC_MANIFEST_PATH).settings[".mcp.json"]).toEqual({
      created: false,
      keys: ["mcpServers.agentplugged"],
    });

    setTools(files, ["codex"]);
    const removed = await sync(files);
    expect(action(removed, ".mcp.json")).toBe("updated");
    expect(json(files, ".mcp.json")).toEqual(mine);
  });

  it("deletes the files it created when their tool leaves the list", async () => {
    const files = await installed();
    await sync(files);
    setTools(files, ["claude-code"]);
    const result = await sync(files);
    for (const path of [PLUGIN_MCP, ".cursor/mcp.json"]) {
      expect(action(result, path), path).toBe("deleted");
      expect(files.files.has(path), path).toBe(false);
    }
    expect(json(files, SYNC_MANIFEST_PATH).settings[".cursor/mcp.json"]).toBeUndefined();
    expect(action(result, ".mcp.json")).toBe("unchanged");
  });

  it("never writes the retired Gemini CLI's settings, even where they exist", async () => {
    const jsonc = '{\n  // the creator\'s theme\n  "theme": "dark", /* kept */\n}\n';
    const files = await installed({ ".gemini/settings.json": jsonc });
    await sync(files);
    expect(files.files.get(".gemini/settings.json")).toBe(jsonc);
  });

  it("leaves an agentplugged server of the creator's as is, and announces a fallback", async () => {
    const own = { mcpServers: { agentplugged: { command: "node", args: ["my-server.js"] } } };
    const text = `${JSON.stringify(own)}\n`;
    const files = await installed({ ".mcp.json": text });
    const result = await sync(files);
    expect(files.files.get(".mcp.json")).toBe(text);
    expect(result.warnings).toContainEqual({ kind: "conflict", path: ".mcp.json" });
    const fallback = result.fallbacks.find((entry) => entry.capability === "mcp");
    expect(fallback).toMatchObject({
      id: "claude-code.mcp.conflict",
      client: "claude-code",
      reason: mcpConflictReason(".mcp.json"),
    });
    expect(files.reference()).toContain(`- Claude Code, mcp: ${mcpConflictReason(".mcp.json")}`);
    expect(json(files, ".claude/settings.json").permissions.deny).not.toContain("Edit(/.mcp.json)");
  });

  it("announces Codex's MCP fallback when the creator's config.toml is kept", async () => {
    const files = await installed({ ".codex/config.toml": 'model = "x"\n' });
    const result = await sync(files);
    expect(files.files.get(".codex/config.toml")).toBe('model = "x"\n');
    expect(result.fallbacks.find((entry) => entry.id === "codex.mcp.config-kept")?.reason).toBe(
      CODEX_MCP_CONFIG_KEPT_REASON,
    );
  });

  it("refuses an unreadable MCP file before writing anything", async () => {
    const files = await installed({ ".cursor/mcp.json": "{ not json" });
    const before = files.snapshot();
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.SETTINGS_INVALID);
    expect(result.error.details.path).toBe(".cursor/mcp.json");
    expect(files.snapshot()).toEqual(before);

    files.seed(".cursor/mcp.json", '{ "mcpServers": [] }');
    const servers = await syncCommand.run(context(files), {});
    expect(servers.ok ? undefined : servers.error.details.reason).toBe(
      "mcpServers: expected an object",
    );
  });

  it("wraps npx in cmd /c when sync runs on Windows, Codex included", async () => {
    const files = await installed();
    await sync(files, "win32");
    const windows = ["/c", "npx", ...ARGS];
    expect(json(files, ".mcp.json").mcpServers.agentplugged).toEqual({
      type: "stdio",
      command: "cmd",
      args: windows,
    });
    expect(json(files, PLUGIN_MCP).mcpServers.agentplugged).toEqual({
      command: "cmd",
      args: windows,
    });
    expect(files.files.get(".codex/config.toml")).toContain(
      '\ncommand = "cmd"\nargs = ["/c", "npx", "-y", "agentplugged@1.0.0", "mcp"]\n',
    );
    // A teammate on another system turns it back: the entry is recognised as ours both ways.
    const back = await sync(files, "linux");
    expect(action(back, ".mcp.json")).toBe("updated");
    expect(back.warnings).toEqual([]);
    expect(json(files, ".mcp.json").mcpServers.agentplugged.command).toBe("npx");
  });

  it("declares the creator's own launch of method.yaml everywhere", async () => {
    const files = await installed();
    const launch = ["node", "/work/agentplugged/apps/cli/dist/bin.js", "mcp"];
    files.seed(
      CONFIG,
      `${files.files.get(CONFIG)}mcp:\n  command: node\n  args: [${launch.slice(1).join(", ")}]\n`,
    );
    const result = await sync(files, "win32");
    // A path of this machine in the generated files: said, never shared.
    expect(result.warnings).toEqual([{ kind: "local_engine", path: CONFIG }]);
    expect(json(files, ".mcp.json").mcpServers.agentplugged).toEqual({
      type: "stdio",
      command: "node",
      args: launch.slice(1),
    });
    expect(json(files, ".cursor/mcp.json").mcpServers.agentplugged.command).toBe("node");
    expect(files.files.get(".codex/config.toml")).toContain(
      '\ncommand = "node"\nargs = ["/work/agentplugged/apps/cli/dist/bin.js", "mcp"]\n',
    );
    // Its own entry, recognised again by the manifest: nothing changes on the next run.
    const again = await sync(files, "win32");
    expect(again.warnings).toEqual([{ kind: "local_engine", path: CONFIG }]);
    expect(action(again, ".mcp.json")).toBe("unchanged");

    files.seed(
      CONFIG,
      `${files.files.get(CONFIG)}`.replace("  command: node\n", "  command: ''\n"),
    );
    const invalid = await syncCommand.run(context(files), {});
    expect(invalid.ok ? undefined : invalid.error.details.field).toBe("mcp.command");
  });

  it("owns a file it creates, even after an older record said otherwise", async () => {
    const files = await installed({ ".mcp.json": '{ "other": 1 }\n' });
    await sync(files);
    expect(json(files, SYNC_MANIFEST_PATH).settings[".mcp.json"].created).toBe(false);
    files.remove(".mcp.json");
    await sync(files);
    expect(json(files, SYNC_MANIFEST_PATH).settings[".mcp.json"]).toEqual({
      created: true,
      keys: ["mcpServers", "mcpServers.agentplugged"],
    });
    setTools(files, ["codex"]);
    await sync(files);
    expect(files.files.has(".mcp.json")).toBe(false);
  });

  it("compares entries whatever the order of their keys", async () => {
    const reordered = {
      mcpServers: { agentplugged: { args: ARGS, command: "npx", type: "stdio" } },
    };
    const files = await installed({ ".mcp.json": `${JSON.stringify(reordered)}\n` });
    const result = await sync(files);
    expect(action(result, ".mcp.json")).toBe("unchanged");
  });

  it("never takes back a generated-shape entry the creator wrote before sync", async () => {
    const before = { mcpServers: { agentplugged: { command: "npx", args: ARGS } } };
    const files = await installed({ ".mcp.json": `${JSON.stringify(before)}\n` });
    await sync(files);
    expect(json(files, SYNC_MANIFEST_PATH).settings[".mcp.json"]).toEqual({
      created: false,
      keys: [],
    });
    setTools(files, ["codex"]);
    await sync(files);
    expect(json(files, ".mcp.json")).toEqual({
      mcpServers: { agentplugged: { type: "stdio", command: "npx", args: ARGS } },
    });
  });

  it("recognises only its own entry shape", () => {
    expect(isGeneratedMcpEntry({ command: "npx", args: ARGS })).toBe(true);
    expect(isGeneratedMcpEntry({ type: "stdio", command: "npx", args: ARGS })).toBe(true);
    expect(isGeneratedMcpEntry({ command: "npx", args: ARGS, env: { A: "1" } })).toBe(false);
    expect(isGeneratedMcpEntry({ command: "npx", args: ["-y", "other@1.0.0", "mcp"] })).toBe(false);
    expect(isGeneratedMcpEntry({ type: "http", command: "npx", args: ARGS })).toBe(false);
    expect(isGeneratedMcpEntry(null)).toBe(false);
  });
});
