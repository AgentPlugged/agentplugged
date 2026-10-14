import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  checkEngine,
  compareSemver,
  createCommandRegistry,
  type InitResult,
  initCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const ENGINE = "0.1.0";
const CONFIG = ".agentplugged/method.yaml";

const noTools: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

function context(files: MemoryFiles, extra: Partial<CommandContext> = {}): CommandContext {
  return {
    files,
    tools: noTools,
    method: shippedMethod(),
    actor: "human",
    engineVersion: ENGINE,
    ...extra,
  };
}

/** An installed product whose `method.yaml` pins `pinned`, under a comment of the creator. */
async function installed(pinned: string): Promise<MemoryFiles> {
  const files = new MemoryFiles();
  const result = await initCommand.run(context(files), {});
  if (!result.ok) throw new Error(result.error.code);
  const text = files.files.get(CONFIG) ?? "";
  files.seed(
    CONFIG,
    `# mine\n${text.replace(`engine_version: ${ENGINE}`, `engine_version: ${pinned}`)}`,
  );
  files.writes.length = 0;
  return files;
}

describe("checkEngine", () => {
  const check = (files: MemoryFiles, options: Partial<Parameters<typeof checkEngine>[1]> = {}) =>
    checkEngine(files, { engineVersion: ENGINE, command: "sync", ...options });

  it("passes when nothing is installed, or when the pinned version is the running one", async () => {
    expect(await check(new MemoryFiles())).toEqual({
      pinned: undefined,
      overridden: false,
      older: false,
    });
    const files = new MemoryFiles({ [CONFIG]: `format_version: 2\nengine_version: ${ENGINE}\n` });
    expect(await check(files)).toEqual({ pinned: ENGINE, overridden: false, older: false });
  });

  it("leaves an unreadable or invalid method.yaml to the command", async () => {
    for (const text of [
      "format_version: [1\n",
      "- 1\n",
      "",
      'format_version: 2\nengine_version: "1.0"\n',
    ]) {
      const result = await check(new MemoryFiles({ [CONFIG]: text }));
      expect(result).toEqual({ pinned: undefined, overridden: false, older: false });
    }
  });

  it("stops on another pinned version with ENGINE_VERSION_MISMATCH", async () => {
    const files = new MemoryFiles({ [CONFIG]: "format_version: 2\nengine_version: 0.0.9\n" });
    const result = await check(files, { command: "agent edit iris" });
    expect(result).not.toHaveProperty("overridden");
    if ("overridden" in result) return;
    expect(result.toPayload()).toEqual({
      code: "ENGINE_VERSION_MISMATCH",
      message_key: "error.engine_version_mismatch",
      details: {
        path: CONFIG,
        pinned: "0.0.9",
        engine_version: ENGINE,
        command: "agent edit iris",
      },
    });
  });

  it("lets --engine-any and --upgrade-engine through", async () => {
    const files = new MemoryFiles({ [CONFIG]: "format_version: 2\nengine_version: 0.0.9\n" });
    expect(await check(files, { engineAny: true })).toEqual({
      pinned: "0.0.9",
      overridden: true,
      older: false,
    });
    expect(await check(files, { upgrade: true })).toEqual({
      pinned: "0.0.9",
      overridden: false,
      older: false,
    });
  });

  it("asks for a newer engine on a newer format_version, whatever the options", async () => {
    const files = new MemoryFiles({ [CONFIG]: "format_version: 3\nengine_version: 0.2.0\n" });
    for (const options of [{}, { engineAny: true }, { upgrade: true }]) {
      const result = await check(files, options);
      if ("overridden" in result) throw new Error("expected an error");
      expect(result.toPayload()).toEqual({
        code: "UPGRADE_REQUIRED",
        message_key: "error.upgrade_required",
        details: {
          path: CONFIG,
          format_version: 3,
          supported: 2,
          engine_version: ENGINE,
          version: "0.2.0",
          command: "sync",
        },
      });
    }
    files.seed(CONFIG, `format_version: 3\nengine_version: ${ENGINE}\n`);
    const latest = await check(files);
    expect("overridden" in latest ? undefined : latest.details.version).toBe("latest");
  });
});

describe("the registry checks the pinned engine before every command", () => {
  it("runs nothing when the versions differ", async () => {
    const files = await installed("0.0.9");
    const before = files.snapshot();
    const registry = createCommandRegistry();
    for (const name of registry.names()) {
      // `migrate` replaces an older pin, like `init --upgrade-engine` (migrate.test.ts).
      if (name === "migrate") continue;
      const result = await registry.run(name, context(files), { action: "disable", id: "iris" });
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.error.code, name).toBe("ENGINE_VERSION_MISMATCH");
    }
    expect(files.writes).toEqual([]);
    expect(files.snapshot()).toEqual(before);
  });

  it("names the command as typed in the error", async () => {
    const files = await installed("0.0.9");
    const result = await createCommandRegistry().run(
      "sync",
      context(files, { commandLine: "sync --x" }),
    );
    expect(!result.ok && result.error.details.command).toBe("sync --x");
  });

  it("runs the command with engineAny, without touching the pinned version", async () => {
    const files = await installed("0.0.9");
    const result = await createCommandRegistry().run("sync", context(files, { engineAny: true }));
    expect(result.ok).toBe(true);
    expect(files.files.get(CONFIG)).toContain("engine_version: 0.0.9");
  });

  it("init --upgrade-engine pins the running engine, keeping comments, and refreshes the method", async () => {
    const files = await installed("0.0.9");
    files.files.delete(".agentplugged/agents/iris/SKILL.md");
    const result = await createCommandRegistry().run("init", context(files), {
      upgrade_engine: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as InitResult;
    expect(value.engineUpgrade).toEqual({ from: "0.0.9", to: ENGINE });
    expect(value.entries.find((entry) => entry.path === CONFIG)?.action).toBe("updated");
    const text = files.files.get(CONFIG) ?? "";
    expect(text.startsWith("# mine\nformat_version: 2\n")).toBe(true);
    expect(text).toContain(`\nengine_version: ${ENGINE}\n`);
    expect(files.files.has(".agentplugged/agents/iris/SKILL.md")).toBe(true);
  });

  it("init --upgrade-engine keeps CRLF line endings and leaves a current pin as is", async () => {
    const files = await installed("0.0.9");
    files.seed(CONFIG, (files.files.get(CONFIG) ?? "").replace(/\n/g, "\r\n"));
    const registry = createCommandRegistry();
    expect((await registry.run("init", context(files), { upgrade_engine: true })).ok).toBe(true);
    const text = files.files.get(CONFIG) ?? "";
    expect(text).toContain(`\r\nengine_version: ${ENGINE}\r\n`);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    files.writes.length = 0;
    const again = await registry.run("init", context(files), { upgrade_engine: true });
    expect(again.ok && (again.value as InitResult).engineUpgrade).toBeUndefined();
    expect(files.writes).not.toContain(CONFIG);
  });

  it("init without --upgrade-engine never changes the pinned version", async () => {
    const files = await installed("0.0.9");
    const result = await initCommand.run(context(files), {});
    expect(result.ok && result.value.engineUpgrade).toBeUndefined();
    expect(files.files.get(CONFIG)).toContain("engine_version: 0.0.9");
  });
});

describe("compareSemver", () => {
  it.each([
    ["0.1.0", "0.0.9", 1],
    ["0.0.9", "0.1.0", -1],
    ["1.0.0", "1.0.0", 0],
    ["1.10.0", "1.9.0", 1],
    ["1.0.0-beta.1", "1.0.0", -1],
    ["1.0.0-beta.2", "1.0.0-beta.10", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-1", "1.0.0-alpha", -1],
    ["1.0.0+build.1", "1.0.0", 0],
  ])("%s vs %s", (a, b, expected) => {
    expect(compareSemver(a, b)).toBe(expected);
  });
});

describe("the direction of the mismatch", () => {
  const check = (pinned: string, options: Partial<Parameters<typeof checkEngine>[1]> = {}) =>
    checkEngine(new MemoryFiles({ [CONFIG]: `format_version: 2\nengine_version: ${pinned}\n` }), {
      engineVersion: ENGINE,
      command: "sync",
      ...options,
    });
  const keyOf = (result: Awaited<ReturnType<typeof check>>) =>
    "overridden" in result ? undefined : `${result.code} ${result.message_key}`;

  it("an engine older than the pin advises the pinned one, and refuses --upgrade-engine", async () => {
    for (const options of [{}, { upgrade: true }, { upgrade: true, engineAny: true }]) {
      const result = await check("0.2.0", options);
      expect(keyOf(result)).toBe("ENGINE_VERSION_MISMATCH error.engine_version_too_old");
      if (!("overridden" in result)) expect(result.details.pinned).toBe("0.2.0");
    }
    expect(await check("0.2.0", { engineAny: true })).toEqual({
      pinned: "0.2.0",
      overridden: true,
      older: true,
    });
  });

  it("an engine newer than the pin advises the pinned one or --upgrade-engine", async () => {
    expect(keyOf(await check("0.0.9"))).toBe(
      "ENGINE_VERSION_MISMATCH error.engine_version_mismatch",
    );
  });

  it("a 0.0.0 pin (the unpublished development CLI) advises --upgrade-engine only", async () => {
    expect(keyOf(await check("0.0.0"))).toBe(
      "ENGINE_VERSION_MISMATCH error.engine_version_mismatch.dev_pin",
    );
    expect(await check("0.0.0", { upgrade: true })).toEqual({
      pinned: "0.0.0",
      overridden: false,
      older: false,
    });
  });

  it("init --upgrade-engine by an older engine leaves method.yaml as is", async () => {
    const files = await installed("0.2.0");
    const before = files.snapshot();
    const result = await createCommandRegistry().run("init", context(files), {
      upgrade_engine: true,
    });
    expect(!result.ok && result.error.message_key).toBe("error.engine_version_too_old");
    expect(files.snapshot()).toEqual(before);
  });
});

describe("init --upgrade-engine and the profile", () => {
  it("keeps the recorded profile in its result and in method.yaml", async () => {
    const files = new MemoryFiles();
    const first = await initCommand.run(context(files), {
      profile: {
        preset: "prototype",
        domains: ["code"],
        phases: ["build"],
        specialties: ["backend"],
      },
    });
    if (!first.ok) throw new Error(first.error.code);
    const text = files.files.get(CONFIG) ?? "";
    files.seed(CONFIG, text.replace(`engine_version: ${ENGINE}`, "engine_version: 0.0.9"));
    const result = await createCommandRegistry().run("init", context(files), {
      upgrade_engine: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as InitResult;
    expect(value.profile?.preset).toBe("prototype");
    expect(value.nothingPinned).toBe(false);
    expect(files.files.get(CONFIG)).toContain("preset: prototype");
  });

  it("says that nothing was pinned yet when method.yaml does not exist", async () => {
    const files = new MemoryFiles();
    const result = await createCommandRegistry().run("init", context(files), {
      upgrade_engine: true,
    });
    expect(result.ok && (result.value as InitResult).nothingPinned).toBe(true);
    expect(result.ok && (result.value as InitResult).engineUpgrade).toBeUndefined();
  });
});
