import { sha256Hex } from "@agentplugged/crypto";
import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  initCommand,
  resolveProfile,
  type SyncResult,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { GENERATED_HEADER } from "../init/generated.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { SYNC_MANIFEST_PATH } from "./manifest.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

function context(files: MemoryFiles): CommandContext {
  return {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    platform: "linux",
  };
}

async function installed(): Promise<MemoryFiles> {
  const files = new MemoryFiles();
  const result = await initCommand.run(context(files), { profile: resolveProfile("new-product") });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  return files;
}

async function run(files: MemoryFiles, input: Record<string, unknown> = {}): Promise<SyncResult> {
  const result = await syncCommand.run(context(files), input);
  if (!result.ok) throw new Error(`sync failed: ${result.error.code}`);
  return result.value;
}

const AGENT = ".gemini/agents/iris.md";
const SETTINGS = ".gemini/settings.json";
const OURS = { command: "npx", args: ["-y", "agentplugged@1.0.0", "mcp"] };
const WRITTEN = `---\nname: iris\nkind: local\n---\n${GENERATED_HEADER}\n# Iris\n`;

const manifest = (files: MemoryFiles) => JSON.parse(files.files.get(SYNC_MANIFEST_PATH) ?? "{}");

/** A project as an earlier `sync` left it: the agent file and the settings entry, both recorded. */
async function olderProject(): Promise<MemoryFiles> {
  const files = await installed();
  await run(files);
  files.seed(AGENT, WRITTEN);
  files.seed(
    SETTINGS,
    `${JSON.stringify({ theme: "dark", mcpServers: { agentplugged: OURS } }, null, 2)}\n`,
  );
  const recorded = manifest(files);
  recorded.files[AGENT] = sha256Hex(WRITTEN);
  recorded.settings = {
    ...recorded.settings,
    [SETTINGS]: { created: false, keys: ["mcpServers", "mcpServers.agentplugged"] },
  };
  files.seed(SYNC_MANIFEST_PATH, `${JSON.stringify(recorded, null, 2)}\n`);
  return files;
}

describe("sync: files left by the retired Gemini CLI", () => {
  it("warns, reads, and writes or removes nothing there", async () => {
    const files = await olderProject();
    const before = files.files.get(SETTINGS);
    const result = await run(files);
    expect(result.warnings).toContainEqual({ kind: "gemini_legacy", path: ".gemini" });
    expect(files.files.get(AGENT)).toBe(WRITTEN);
    expect(files.files.get(SETTINGS)).toBe(before);
    expect(result.entries.some((entry) => entry.path.startsWith(".gemini/"))).toBe(false);
    // The proof of origin survives the next runs.
    expect(manifest(files).files[AGENT]).toBe(sha256Hex(WRITTEN));
    expect(manifest(files).settings[SETTINGS].keys).toContain("mcpServers.agentplugged");
  });

  it("does not warn in a project that never had them", async () => {
    const files = await installed();
    const result = await run(files);
    expect(result.warnings.some((warning) => warning.kind === "gemini_legacy")).toBe(false);
  });

  it("warns for an older models.yaml that still has a gemini-cli table", async () => {
    const files = await installed();
    const config = files.files.get(".agentplugged/method.yaml") ?? "";
    const tiers = ["reasoning", "code", "fast", "multimodal"]
      .map((tier) => `    ${tier}:\n      model: pro\n`)
      .join("");
    files.seed(".agentplugged/method.yaml", `${config}models:\n  gemini-cli:\n${tiers}`);
    const result = await run(files);
    expect(result.warnings).toContainEqual({ kind: "gemini_legacy", path: ".gemini" });
  });
});

describe("sync --clean-gemini", () => {
  it("removes only what sync wrote, keeps the creator's settings, and forgets the proof", async () => {
    const files = await olderProject();
    await run(files);
    files.seed(".gemini/agents/mine.md", "# my own agent\n");
    const result = await run(files, { clean_gemini: true });
    expect(result.entries).toEqual([
      { path: AGENT, action: "deleted", group: "antigravity" },
      { path: SETTINGS, action: "updated", group: "antigravity" },
    ]);
    expect(files.files.has(AGENT)).toBe(false);
    expect(JSON.parse(files.files.get(SETTINGS) ?? "")).toEqual({ theme: "dark" });
    // A file without the header is the creator's: left alone, and not even listed.
    expect(files.files.get(".gemini/agents/mine.md")).toBe("# my own agent\n");
    expect(result.warnings).toEqual([]);
    expect(result.geminiCleanup).toEqual({ listed: 0 });
    expect(manifest(files).files[AGENT]).toBeUndefined();
    expect(manifest(files).settings?.[SETTINGS]).toBeUndefined();
    // Nothing else of the project is touched, and a second run finds nothing.
    expect(files.files.has("GEMINI.md")).toBe(true);
    expect((await run(files, { clean_gemini: true })).entries).toEqual([]);
  });

  it("removes the folders it leaves empty, and the settings file it created", async () => {
    const files = await olderProject();
    const recorded = manifest(files);
    recorded.settings[SETTINGS] = {
      created: true,
      keys: ["mcpServers", "mcpServers.agentplugged"],
    };
    files.seed(SYNC_MANIFEST_PATH, `${JSON.stringify(recorded)}\n`);
    files.seed(SETTINGS, `${JSON.stringify({ mcpServers: { agentplugged: OURS } })}\n`);
    const result = await run(files, { clean_gemini: true });
    expect(result.entries.map((entry) => entry.action)).toEqual(["deleted", "deleted"]);
    expect(files.files.has(SETTINGS)).toBe(false);
    expect(files.dirs.has(".gemini")).toBe(false);
  });

  it("lists a file changed since, keeps it, and removes it only once confirmed", async () => {
    const files = await olderProject();
    files.seed(AGENT, `${WRITTEN}my notes\n`);
    const listed = await run(files, { clean_gemini: true });
    expect(listed.warnings).toContainEqual({ kind: "gemini_unproven", path: AGENT });
    expect(listed.geminiCleanup).toEqual({ listed: 1 });
    expect(files.files.has(AGENT)).toBe(true);
    // The settings entry is proven and goes all the same.
    expect(JSON.parse(files.files.get(SETTINGS) ?? "")).toEqual({ theme: "dark" });

    const confirmed = await run(files, { clean_gemini: true, yes: true });
    expect(confirmed.entries).toEqual([{ path: AGENT, action: "deleted", group: "antigravity" }]);
    expect(files.files.has(AGENT)).toBe(false);
  });

  it("keeps an agentplugged server entry it cannot prove it wrote", async () => {
    const files = await olderProject();
    const recorded = manifest(files);
    delete recorded.settings[SETTINGS];
    files.seed(SYNC_MANIFEST_PATH, `${JSON.stringify(recorded)}\n`);
    const own = { mcpServers: { agentplugged: { command: "node", args: ["mine.js"] } } };
    files.seed(SETTINGS, `${JSON.stringify(own)}\n`);
    const listed = await run(files, { clean_gemini: true });
    expect(listed.warnings).toContainEqual({ kind: "gemini_unproven", path: SETTINGS });
    expect(JSON.parse(files.files.get(SETTINGS) ?? "")).toEqual(own);

    await run(files, { clean_gemini: true, yes: true });
    // Nothing recorded: only the entry goes, the empty `mcpServers` stays.
    expect(JSON.parse(files.files.get(SETTINGS) ?? "")).toEqual({ mcpServers: {} });
  });

  it("recognises a file by its header when the manifest is gone", async () => {
    const files = await olderProject();
    files.files.delete(SYNC_MANIFEST_PATH);
    const result = await run(files, { clean_gemini: true });
    expect(result.entries.map((entry) => entry.path)).toEqual([AGENT, SETTINGS]);
    expect(files.files.has(AGENT)).toBe(false);
  });

  it("says there is nothing to clean in a project without those files", async () => {
    const files = await installed();
    await run(files);
    const result = await run(files, { clean_gemini: true });
    expect(result.entries).toEqual([]);
    expect(result.geminiCleanup).toEqual({ listed: 0 });
  });

  it("keeps the comments of settings it would have to rewrite, unless confirmed", async () => {
    const files = await olderProject();
    const commented = `{\n  // my theme\n  "theme": "dark",\n  "mcpServers": { "agentplugged": ${JSON.stringify(OURS)} }\n}\n`;
    files.seed(SETTINGS, commented);
    const listed = await run(files, { clean_gemini: true });
    expect(listed.warnings).toContainEqual({ kind: "gemini_unproven", path: SETTINGS });
    expect(files.files.get(SETTINGS)).toBe(commented);
    await run(files, { clean_gemini: true, yes: true });
    expect(JSON.parse(files.files.get(SETTINGS) ?? "").theme).toBe("dark");
  });

  it("does not take a header-only file for its own when the manifest does not list it", async () => {
    const files = await olderProject();
    files.seed(".gemini/agents/other.md", WRITTEN);
    const listed = await run(files, { clean_gemini: true });
    expect(listed.warnings).toContainEqual({
      kind: "gemini_unproven",
      path: ".gemini/agents/other.md",
    });
    expect(files.files.has(".gemini/agents/other.md")).toBe(true);
  });
});
