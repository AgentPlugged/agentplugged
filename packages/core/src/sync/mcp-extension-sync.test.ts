import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_MCP_CONFIG_PATH } from "../chat/antigravity-hook.js";
import {
  type CommandContext,
  type ExtensionMcpServer,
  initCommand,
  resolveProfile,
  type SyncResult,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const EXTRA: ExtensionMcpServer = {
  name: "agentplugged-module-a",
  launch: { command: "node", args: ["module-a-server.js"] },
};

function context(files: MemoryFiles, extensionServers?: readonly ExtensionMcpServer[]) {
  const base: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    platform: "linux",
  };
  return extensionServers === undefined ? base : { ...base, extensionServers };
}

async function installed(initial: Record<string, string> = {}): Promise<MemoryFiles> {
  const files = new MemoryFiles(initial);
  const result = await initCommand.run(context(files), { profile: resolveProfile("new-product") });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  return files;
}

async function sync(
  files: MemoryFiles,
  extensionServers?: readonly ExtensionMcpServer[],
): Promise<SyncResult> {
  const result = await syncCommand.run(context(files, extensionServers), {});
  if (!result.ok) throw new Error(`sync failed: ${result.error.code}`);
  return result.value;
}

const CONFIG = ".agentplugged/method.yaml";
const json = (files: MemoryFiles, path: string) => JSON.parse(files.files.get(path) ?? "null");
const servers = (files: MemoryFiles, path: string): string[] =>
  Object.keys(json(files, path)?.mcpServers ?? {}).sort();
const action = (result: SyncResult, path: string) =>
  result.entries.find((entry) => entry.path === path)?.action;

describe("sync: extension MCP servers", () => {
  it("declares nothing more than the engine's server when none is given", async () => {
    const files = await installed();
    await sync(files);
    expect(servers(files, ".mcp.json")).toEqual(["agentplugged"]);
    expect(servers(files, ".cursor/mcp.json")).toEqual(["agentplugged"]);
  });

  it("declares a given server next to the engine's, in Claude Code's and Cursor's files", async () => {
    const files = await installed();
    await sync(files, [EXTRA]);
    for (const path of [".mcp.json", ".cursor/mcp.json"]) {
      expect(servers(files, path)).toEqual(["agentplugged", "agentplugged-module-a"]);
      expect(json(files, path).mcpServers["agentplugged-module-a"]).toEqual({
        type: "stdio",
        command: "node",
        args: ["module-a-server.js"],
      });
    }
  });

  it("changes nothing when run again with the same server", async () => {
    const files = await installed();
    await sync(files, [EXTRA]);
    const again = await sync(files, [EXTRA]);
    expect(action(again, ".mcp.json")).toBe("unchanged");
  });

  it("brings the entry to the launch given now", async () => {
    const files = await installed();
    await sync(files, [EXTRA]);
    await sync(files, [{ ...EXTRA, launch: { command: "node", args: ["other.js"] } }]);
    expect(json(files, ".mcp.json").mcpServers["agentplugged-module-a"].args).toEqual(["other.js"]);
  });

  it("takes the entry back when the server is no longer given, and only that one", async () => {
    const files = await installed();
    await sync(files, [EXTRA]);
    const result = await sync(files);
    expect(servers(files, ".mcp.json")).toEqual(["agentplugged"]);
    expect(action(result, ".mcp.json")).toBe("updated");
  });

  it("never touches the creator's own server of the same name", async () => {
    const mine = { type: "stdio", command: "mine", args: [] };
    const files = await installed({
      ".mcp.json": JSON.stringify({ mcpServers: { "agentplugged-module-a": mine } }),
    });
    const result = await sync(files, [EXTRA]);
    expect(json(files, ".mcp.json").mcpServers["agentplugged-module-a"]).toEqual(mine);
    expect(result.warnings.some((w) => w.kind === "conflict" && w.path === ".mcp.json")).toBe(true);
    await sync(files);
    expect(json(files, ".mcp.json").mcpServers["agentplugged-module-a"]).toEqual(mine);
  });

  it("keeps the creator's other servers when it adds and removes its own", async () => {
    const files = await installed({
      ".mcp.json": JSON.stringify({ mcpServers: { custom: { command: "x" } } }),
    });
    await sync(files, [EXTRA]);
    expect(servers(files, ".mcp.json")).toEqual([
      "agentplugged",
      "agentplugged-module-a",
      "custom",
    ]);
    await sync(files);
    expect(servers(files, ".mcp.json")).toEqual(["agentplugged", "custom"]);
  });

  it("deletes the file it created, extension server included, when the tool leaves the list", async () => {
    const files = await installed();
    await sync(files, [EXTRA]);
    const text = (files.files.get(CONFIG) ?? "").replace(/tools:\n(?: {2}- .*\n)+/, "");
    files.seed(CONFIG, `${text}tools: [codex]\n`);
    await sync(files, [EXTRA]);
    expect(files.files.has(".mcp.json")).toBe(false);
    expect(files.files.has(".cursor/mcp.json")).toBe(false);
  });

  it("ignores a server whose name is not a plain name", async () => {
    const files = await installed();
    const launch = { command: "node", args: [] };
    await sync(files, [
      { name: "__proto__", launch },
      { name: "a.b", launch },
    ]);
    expect(servers(files, ".mcp.json")).toEqual(["agentplugged"]);
  });

  it("never declares a server under the engine's own name", async () => {
    const files = await installed();
    await sync(files, [{ name: "agentplugged", launch: { command: "evil", args: [] } }]);
    expect(json(files, ".mcp.json").mcpServers.agentplugged.command).toBe("npx");
  });

  it("declares the server in Codex's and Antigravity's generated files too", async () => {
    const files = await installed();
    await sync(files, [EXTRA]);
    const codex = files.files.get(".codex/config.toml") ?? "";
    expect(codex).toContain("[mcp_servers.agentplugged-module-a]");
    expect(codex).toContain('args = ["module-a-server.js"]');
    const plugin = ANTIGRAVITY_MCP_CONFIG_PATH;
    expect(servers(files, plugin)).toEqual(["agentplugged", "agentplugged-module-a"]);
    await sync(files);
    expect(files.files.get(".codex/config.toml") ?? "").not.toContain("agentplugged-module-a");
    expect(servers(files, plugin)).toEqual(["agentplugged"]);
  });

  it("leaves an entry the creator replaced alone, when it is no longer given", async () => {
    const files = await installed();
    await sync(files, [EXTRA]);
    const mine = { type: "stdio", command: "mine", args: ["--mine"] };
    const config = json(files, ".mcp.json");
    config.mcpServers["agentplugged-module-a"] = mine;
    files.seed(".mcp.json", JSON.stringify(config));
    await sync(files);
    expect(json(files, ".mcp.json").mcpServers["agentplugged-module-a"]).toEqual(mine);
    // Forgotten by the manifest: a later run does not claim it either.
    await sync(files, [EXTRA]);
    expect(json(files, ".mcp.json").mcpServers["agentplugged-module-a"]).toEqual(mine);
  });

  it("does not rewrite an entry the creator replaced while it is still given", async () => {
    const files = await installed();
    await sync(files, [EXTRA]);
    const mine = { type: "stdio", command: "mine", args: [] };
    const config = json(files, ".mcp.json");
    config.mcpServers["agentplugged-module-a"] = mine;
    files.seed(".mcp.json", JSON.stringify(config));
    const result = await sync(files, [{ ...EXTRA, launch: { command: "node", args: ["new.js"] } }]);
    expect(json(files, ".mcp.json").mcpServers["agentplugged-module-a"]).toEqual(mine);
    expect(result.warnings.some((w) => w.kind === "conflict" && w.path === ".mcp.json")).toBe(true);
  });

  it("leaves no empty mcpServers behind once the entries it added are gone", async () => {
    const files = await installed({ ".mcp.json": JSON.stringify({ other: 1 }) });
    await sync(files, [EXTRA]);
    const text = (files.files.get(CONFIG) ?? "").replace(/tools:\n(?: {2}- .*\n)+/, "");
    files.seed(CONFIG, `${text}tools: [codex]\n`);
    await sync(files);
    expect(json(files, ".mcp.json")).toEqual({ other: 1 });
  });
});
