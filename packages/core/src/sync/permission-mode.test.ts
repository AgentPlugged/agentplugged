import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  initCommand,
  profileCommand,
  resolveProfile,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { SYNC_MANIFEST_PATH } from "./manifest.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const CONFIG = ".agentplugged/method.yaml";
const SETTINGS = ".claude/settings.json";
const KEY = "permissions.disableBypassPermissionsMode";

function context(files: MemoryFiles): CommandContext {
  return { files, tools: NO_TOOL, method: shippedMethod(), actor: "human", engineVersion: "1.0.0" };
}

async function run<T>(
  command: {
    readonly name: string;
    run(
      context: CommandContext,
      input: Record<string, unknown>,
    ): Promise<{ ok: true; value: T } | { ok: false; error: { code: string; details: unknown } }>;
  },
  files: MemoryFiles,
  input: Record<string, unknown> = {},
): Promise<T> {
  const result = await command.run(context(files), input);
  if (!result.ok) {
    throw new Error(
      `${command.name} failed: ${result.error.code} ${JSON.stringify(result.error.details)}`,
    );
  }
  return result.value;
}

// biome-ignore lint/suspicious/noExplicitAny: a test reads JSON of any shape
const json = (files: MemoryFiles, path: string): Record<string, any> =>
  JSON.parse(files.files.get(path) ?? "null");

describe("the permission mode of the AI tool", () => {
  it("is protected without a setting: Claude Code's mode without questions stays turned off", async () => {
    const files = new MemoryFiles();
    await run(initCommand, files, {
      profile: resolveProfile("new-product"),
      tools: ["claude-code"],
    });
    await run(syncCommand, files);
    expect(json(files, SETTINGS).permissions.disableBypassPermissionsMode).toBe("disable");
  });

  it("free: a new settings file does not turn that mode off, and nothing else is loosened", async () => {
    const files = new MemoryFiles();
    const result = await run(initCommand, files, {
      profile: resolveProfile("new-product"),
      tools: ["claude-code"],
      permissions: "free",
    });
    expect(result.permissions).toBe("free");
    expect(files.files.get(CONFIG)).toContain("permissions:\n  mode: free\n");
    await run(syncCommand, files);
    const settings = json(files, SETTINGS);
    expect(settings.permissions.disableBypassPermissionsMode).toBeUndefined();
    // The deny rules, which guard the secrets and the journal, stay.
    expect(settings.permissions.deny.length).toBeGreaterThan(5);
    expect(json(files, SYNC_MANIFEST_PATH).settings[SETTINGS].keys).not.toContain(KEY);
  });

  it("releases the key an earlier sync wrote when the creator goes free, and writes it back when they go back", async () => {
    const files = new MemoryFiles();
    await run(initCommand, files, {
      profile: resolveProfile("new-product"),
      tools: ["claude-code"],
    });
    await run(syncCommand, files);
    expect(json(files, SYNC_MANIFEST_PATH).settings[SETTINGS].keys).toContain(KEY);

    const free = await run(profileCommand, files, { permissions: "free" });
    expect(free.permissions).toEqual({ mode: "free", previous: undefined });
    await run(syncCommand, files);
    expect(json(files, SETTINGS).permissions.disableBypassPermissionsMode).toBeUndefined();
    expect(json(files, SYNC_MANIFEST_PATH).settings[SETTINGS].keys).not.toContain(KEY);
    // Run again: nothing moves.
    const again = await run(syncCommand, files);
    expect(again.entries.find((entry) => entry.path === SETTINGS)?.action).toBe("unchanged");

    const back = await run(profileCommand, files, { permissions: "protected" });
    expect(back.permissions).toEqual({ mode: "protected", previous: "free" });
    await run(syncCommand, files);
    expect(json(files, SETTINGS).permissions.disableBypassPermissionsMode).toBe("disable");
    expect(json(files, SYNC_MANIFEST_PATH).settings[SETTINGS].keys).toContain(KEY);
  });

  it("never touches a value the creator wrote themselves", async () => {
    const mine = { permissions: { disableBypassPermissionsMode: "disable" } };
    const files = new MemoryFiles({ [SETTINGS]: JSON.stringify(mine) });
    await run(initCommand, files, {
      profile: resolveProfile("new-product"),
      tools: ["claude-code"],
    });
    await run(profileCommand, files, { permissions: "free" });
    await run(syncCommand, files);
    expect(json(files, SETTINGS).permissions.disableBypassPermissionsMode).toBe("disable");
  });

  it("keeps a value the creator changed after sync wrote it", async () => {
    const files = new MemoryFiles();
    await run(initCommand, files, {
      profile: resolveProfile("new-product"),
      tools: ["claude-code"],
    });
    await run(syncCommand, files);
    const settings = json(files, SETTINGS);
    settings.permissions.disableBypassPermissionsMode = "disable-by-hand";
    files.seed(SETTINGS, JSON.stringify(settings));
    await run(profileCommand, files, { permissions: "free" });
    await run(syncCommand, files);
    expect(json(files, SETTINGS).permissions.disableBypassPermissionsMode).toBe("disable-by-hand");
  });

  it("is refused when the mode is not one of protected and free", async () => {
    const files = new MemoryFiles();
    await run(initCommand, files, {
      profile: resolveProfile("new-product"),
      tools: ["claude-code"],
    });
    const refused = await profileCommand.run(context(files), { permissions: "yolo" });
    expect(refused.ok).toBe(false);
    const refusedInit = await initCommand.run(context(new MemoryFiles()), { permissions: "yolo" });
    expect(refusedInit.ok).toBe(false);
  });
});

describe("the AI tools chosen at init", () => {
  it("records the tools the creator chose in method.yaml, and keeps them on the next init", async () => {
    const files = new MemoryFiles();
    const first = await run(initCommand, files, {
      profile: resolveProfile("new-product"),
      tools: ["cursor", "claude-code"],
    });
    // In the catalog's order.
    expect(first.targetedTools).toEqual(["claude-code", "cursor"]);
    expect(files.files.get(CONFIG)).toContain("tools:\n  - claude-code\n  - cursor\n");
    const second = await run(initCommand, files, { tools: ["codex"] });
    expect(second.targetedTools).toEqual(["claude-code", "cursor"]);
  });

  it("refuses an unknown tool, an empty list and a repeated tool", async () => {
    for (const tools of [["emacs"], [], ["codex", "codex"], "codex"]) {
      const result = await initCommand.run(context(new MemoryFiles()), { tools });
      expect(result.ok, JSON.stringify(tools)).toBe(false);
    }
  });
});
