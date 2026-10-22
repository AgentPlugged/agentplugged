import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  COMPATIBILITY,
  type CommandContext,
  initCommand,
  resolveProfile,
  type SyncResult,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { detectTools } from "../tools/detect-tools.js";
import { fallbacksFor, KIMI_MODEL_REASON, mcpConflictReason } from "./compatibility.js";

/**
 * Kimi Code CLI: its sub-agents, its project MCP file, the skills it shares with the other tools,
 * and what it lacks (said, never silent).
 */

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

function context(files: MemoryFiles, platform = "linux", tools = NO_TOOL): CommandContext {
  return {
    files,
    tools,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    platform,
  };
}

async function installed(): Promise<MemoryFiles> {
  const files = new MemoryFiles();
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
const AGENT = ".kimi-code/agents/iris.md";
const MCP = ".kimi-code/mcp.json";

function setTools(files: MemoryFiles, tools: readonly string[]) {
  const text = (files.files.get(CONFIG) ?? "").replace(/tools:(?:\n(?: {2}- .*\n)+| \[.*\]\n)/, "");
  files.seed(CONFIG, `${text}tools: [${tools.join(", ")}]\n`);
}

const json = (files: MemoryFiles, path: string) => JSON.parse(files.files.get(path) ?? "null");
const action = (result: SyncResult, path: string) =>
  result.entries.find((entry) => entry.path === path)?.action;

describe("sync: Kimi Code CLI", () => {
  it("writes its sub-agents, its project MCP file and the shared skills, nothing else", async () => {
    const files = await installed();
    setTools(files, ["kimi"]);
    const result = await sync(files);
    expect(result.tools).toEqual(["kimi"]);
    expect(action(result, AGENT)).toBe("created");
    expect(action(result, MCP)).toBe("created");
    expect(action(result, ".agents/skills/iris/SKILL.md")).toBe("created");
    expect(result.entries.find((entry) => entry.path === AGENT)?.group).toBe("kimi");
    expect(result.entries.find((entry) => entry.path === MCP)?.group).toBe("kimi");
    // The other tools' files are not written.
    const written = [...files.files.keys()];
    for (const prefix of [".claude/", ".codex/", ".cursor/", ".gemini/", ".agents/agents/"]) {
      expect(
        written.some((path) => path.startsWith(prefix)),
        prefix,
      ).toBe(false);
    }
    expect(written).not.toContain("CLAUDE.md");
    expect(written).not.toContain("GEMINI.md");
    expect(written).not.toContain(".cursorignore");
    // Nothing outside the project.
    for (const path of written) expect(path.startsWith("~") || path.startsWith("/")).toBe(false);
  });

  it("declares the engine's MCP server the way Kimi reads it: a command, no type", async () => {
    const files = await installed();
    setTools(files, ["kimi"]);
    await sync(files);
    expect(json(files, MCP)).toEqual({
      mcpServers: { agentplugged: { command: "npx", args: ["-y", "agentplugged@1.0.0", "mcp"] } },
    });
  });

  it("wraps npx in cmd /c on Windows", async () => {
    const files = await installed();
    setTools(files, ["kimi"]);
    await sync(files, "win32");
    expect(json(files, MCP).mcpServers.agentplugged).toEqual({
      command: "cmd",
      args: ["/c", "npx", "-y", "agentplugged@1.0.0", "mcp"],
    });
  });

  it("renders a sub-agent with the fields Kimi reads, and no model", async () => {
    const files = await installed();
    setTools(files, ["kimi"]);
    await sync(files);
    const text = files.files.get(AGENT) ?? "";
    const frontmatter = text.slice(4, text.indexOf("\n---\n", 4) + 1);
    expect(frontmatter).toBe(
      "name: iris\ndescription: Product analyst who frames a new product.\ndisallowedTools:\n  - mcp__agentplugged__review\n  - mcp__agentplugged__measure\n",
    );
    expect(text).not.toMatch(/^model:/m);
    expect(text).toContain("\n## Activation\n");
    // Noah is the main session, never a sub-agent.
    expect(files.files.has(".kimi-code/agents/noah.md")).toBe(false);
  });

  it("is idempotent, and leaves a creator's server and file alone", async () => {
    const files = await installed();
    setTools(files, ["kimi"]);
    files.seed(MCP, JSON.stringify({ mcpServers: { mine: { command: "node", args: ["x.js"] } } }));
    const first = await sync(files);
    expect(action(first, MCP)).toBe("updated");
    expect(Object.keys(json(files, MCP).mcpServers)).toEqual(["mine", "agentplugged"]);
    const second = await sync(files);
    expect(second.entries.every((entry) => entry.action === "unchanged")).toBe(true);
    expect(second.warnings).toEqual([]);
  });

  it("keeps a server named agentplugged that is the creator's, and says so", async () => {
    const files = await installed();
    setTools(files, ["kimi"]);
    files.seed(
      MCP,
      JSON.stringify({ mcpServers: { agentplugged: { command: "node", args: ["x"] } } }),
    );
    const result = await sync(files);
    expect(result.warnings).toContainEqual({ kind: "conflict", path: MCP });
    expect(json(files, MCP).mcpServers.agentplugged.command).toBe("node");
    const mcp = result.fallbacks.find((f) => f.client === "kimi" && f.capability === "mcp");
    expect(mcp?.reason).toBe(mcpConflictReason(MCP));
  });

  it("never overwrites a sub-agent file of the creator's", async () => {
    const files = await installed();
    setTools(files, ["kimi"]);
    files.seed(AGENT, "---\nname: iris\ndescription: mine\n---\nMy own Iris.\n");
    const result = await sync(files);
    expect(result.warnings).toContainEqual({ kind: "conflict", path: AGENT });
    expect(files.files.get(AGENT)).toContain("My own Iris.");
  });

  it("removes what it wrote when Kimi leaves the list, and the empty folder with it", async () => {
    const files = await installed();
    setTools(files, ["kimi", "claude-code"]);
    await sync(files);
    expect(files.files.has(AGENT)).toBe(true);
    setTools(files, ["claude-code"]);
    const result = await sync(files);
    expect(action(result, AGENT)).toBe("deleted");
    expect(action(result, MCP)).toBe("deleted");
    expect([...files.files.keys()].some((path) => path.startsWith(".kimi-code/"))).toBe(false);
  });

  it("keeps a creator's mcp.json entries when Kimi leaves the list", async () => {
    const files = await installed();
    setTools(files, ["kimi"]);
    files.seed(MCP, JSON.stringify({ mcpServers: { mine: { command: "node" } } }));
    await sync(files);
    setTools(files, ["claude-code"]);
    await sync(files);
    expect(json(files, MCP)).toEqual({ mcpServers: { mine: { command: "node" } } });
  });
});

describe("Kimi Code CLI in the compatibility matrix", () => {
  const cells = COMPATIBILITY.find((entry) => entry.client === "kimi");

  it("is a client of the matrix, driven by the `kimi` tool", () => {
    expect(cells?.tool).toBe("kimi");
    expect(cells?.name).toBe("Kimi Code CLI");
  });

  it("gives every capability a cell: native with its files, or a fallback with its reason", () => {
    for (const capability of CAPABILITIES) {
      const cell = cells?.cells[capability];
      expect(cell, capability).toBeDefined();
      if (cell?.support === "fallback") expect(cell.reason?.length, capability).toBeGreaterThan(20);
      else expect(cell?.files.length, capability).toBeGreaterThan(0);
    }
  });

  it("is native only for what Kimi documents: skills, agents, project MCP file", () => {
    const native = CAPABILITIES.filter(
      (capability) => cells?.cells[capability].support === "native",
    );
    expect(native).toEqual(["skills", "agents", "mcp"]);
    expect(cells?.cells.agents.files).toEqual([".kimi-code/agents/<id>.md"]);
    expect(cells?.cells.mcp.files).toEqual([".kimi-code/mcp.json"]);
  });

  it("says why its hook-based capabilities are fallbacks: hooks live in the user's settings", () => {
    for (const capability of [
      "permissions",
      "rules",
      "untrusted",
      "chat_proof",
      "installs",
      "budget",
    ] as const) {
      expect(cells?.cells[capability].reason, capability).toContain("~/.kimi-code/config.toml");
    }
  });

  it("reports the model fallback whatever the model table says", () => {
    const options = { modelInherit: new Set<"kimi">() };
    const found = fallbacksFor(["kimi"], options).find((f) => f.capability === "model");
    expect(found?.reason).toBe(KIMI_MODEL_REASON);
    expect(found?.id).toBe("kimi.model");
  });
});

describe("detection of Kimi Code CLI", () => {
  it("finds `kimi` and reads its version", async () => {
    const probe: ToolProbe = {
      which: async (names) =>
        names.includes("kimi") ? { name: "kimi", path: "/bin/kimi" } : undefined,
      version: async () => "kimi, version 0.30.1",
      extensions: async () => [],
    };
    const found = (await detectTools(probe)).find((tool) => tool.id === "kimi");
    expect(found).toMatchObject({
      found: true,
      name: "Kimi Code CLI",
      version: "0.30.1",
      sources: [{ kind: "command", command: "kimi" }],
      driveFiles: ["AGENTS.md", ".kimi-code/"],
    });
  });
});

describe("sync: Kimi's hooks in the user's own settings", () => {
  const POLICY = ".kimi-code/agentplugged-policy.json";

  async function syncWith(files: MemoryFiles, kimiHooks?: "installed" | "outdated" | "missing") {
    const result = await syncCommand.run(
      { ...context(files), ...(kimiHooks === undefined ? {} : { kimiHooks }) },
      {},
    );
    if (!result.ok) throw new Error(`sync failed: ${result.error.code}`);
    return result.value;
  }

  const lacks = (result: SyncResult) =>
    result.fallbacks.filter((f) => f.client === "kimi").map((f) => f.capability);

  it("writes the policy the hook reads, in the project, with Kimi's settings protected", async () => {
    const files = await installed();
    setTools(files, ["kimi"]);
    const result = await syncWith(files);
    expect(action(result, POLICY)).toBe("created");
    const policy = json(files, POLICY);
    expect(policy.version).toBe(1);
    expect(policy.deny).toEqual(
      expect.arrayContaining([
        "Edit(~/.kimi-code/config.toml)",
        "Edit(~/.kimi-code/sessions/**)",
        "Edit(/.agentplugged/method.yaml)",
      ]),
    );
    // Nothing is written outside the project, the hook or not.
    for (const path of files.files.keys()) {
      expect(path.startsWith("~") || path.startsWith("/")).toBe(false);
    }
    // The policy leaves with the tool.
    setTools(files, ["claude-code"]);
    await syncWith(files);
    expect(files.files.has(POLICY)).toBe(false);
  });

  it("says the hooks are missing, and how to install them, until they are installed", async () => {
    const files = await installed();
    setTools(files, ["kimi"]);
    for (const state of [undefined, "missing", "outdated"] as const) {
      const result = await syncWith(files, state);
      expect(result.kimiHooks, String(state)).toBe(state ?? "missing");
      expect(lacks(result)).toContain("permissions");
      const permissions = result.fallbacks.find((f) => f.capability === "permissions");
      expect(permissions?.reason).toContain("npx agentplugged kimi-hooks install");
    }
    // The proposal is in the constitution, where the agents read it.
    expect(files.reference()).toContain("kimi-hooks install");
  });

  it("makes permissions, outside reads and installations native only once the hooks are there", async () => {
    const files = await installed();
    setTools(files, ["kimi"]);
    const result = await syncWith(files, "installed");
    expect(result.kimiHooks).toBe("installed");
    const lacking = lacks(result);
    for (const capability of ["permissions", "untrusted", "installs"]) {
      expect(lacking, capability).not.toContain(capability);
    }
    // What a Kimi hook cannot do stays said, with its own reason.
    for (const capability of ["rules", "chat_proof", "budget"]) {
      const fallback = result.fallbacks.find((f) => f.capability === capability);
      expect(fallback?.id, capability).toBe(`kimi.${capability}.hooks-installed`);
      expect(fallback?.reason, capability).not.toContain("kimi-hooks install");
    }
    expect(lacking).toEqual(
      expect.arrayContaining(["instructions", "model", "rules", "chat_proof", "budget"]),
    );
  });

  it("reports nothing about Kimi's hooks when Kimi is not targeted", async () => {
    const files = await installed();
    setTools(files, ["claude-code"]);
    const result = await syncWith(files, "missing");
    expect(result.kimiHooks).toBeUndefined();
    expect(files.files.has(POLICY)).toBe(false);
  });
});
