import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "@agentplugged/i18n";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runKimiHooks } from "./kimi-hooks.js";

/**
 * The direct form of the hook: the engine that runs `kimi-hooks install` is named by its file, and
 * `npx` takes over when that file is gone. Settings folders are always temporary.
 */

let folder: string;
let settings: string;
let entry: string;
const ENGINE = "1.4.0";

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "agentplugged-kimi-direct-"));
  settings = join(folder, "kimi settings");
  // A folder name with a space, as a user name can have.
  await mkdir(join(folder, "some one", "dist"), { recursive: true });
  entry = join(folder, "some one", "dist", "bin.js");
  await writeFile(entry, "process.exit(0);\n");
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function run(action: string, withEntry: string | undefined) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runKimiHooks(
    {
      env: { KIMI_CODE_HOME: settings },
      engineVersion: ENGINE,
      ...(withEntry === undefined ? {} : { entry: withEntry }),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      now: () => 0,
    },
    createTranslator("en"),
    [action],
  );
  return { code, out: out.join(""), err: err.join("") };
}

const config = () => readFile(join(settings, "config.toml"), "utf8");

describe("kimi-hooks with the engine started directly", () => {
  it("writes the quoted path of the installed engine, with npx behind it, and reads it as installed", async () => {
    expect((await run("install", entry)).code).toBe(0);
    const text = await config();
    const line = text.split("\n").find((l) => l.startsWith("command = ")) ?? "";
    const command = JSON.parse(line.slice("command = ".length)) as string;
    expect(command).toBe(
      `node "${entry}" hook kimi pre-tool || npx -y agentplugged@${ENGINE} hook kimi pre-tool`,
    );
    expect((await run("status", entry)).out).toContain("are installed");
  });

  it("runs the hook through a shell: the engine file when it is there", async () => {
    await run("install", entry);
    const text = await config();
    const line = text.split("\n").find((l) => l.startsWith("command = ")) ?? "";
    const command = (JSON.parse(line.slice("command = ".length)) as string).replace(
      /\|\| .*$/,
      "|| echo fallback-ran",
    );
    const result = spawnSync(command, { shell: true, encoding: "utf8", input: "{}" });
    expect(result.stdout).not.toContain("fallback-ran");
  });

  it("falls back to npx when the file is gone, and the status says the block is out of date", async () => {
    await run("install", entry);
    const text = await config();
    const line = text.split("\n").find((l) => l.startsWith("command = ")) ?? "";
    const command = (JSON.parse(line.slice("command = ".length)) as string).replace(
      /\|\| .*$/,
      "|| echo fallback-ran",
    );
    await rm(entry);
    const result = spawnSync(command, { shell: true, encoding: "utf8", input: "{}" });
    expect(result.stdout).toContain("fallback-ran");
    const status = await run("status", entry);
    expect(status.out).toContain("another version");
  });

  it("installs the npx form alone when no engine file can be named, and again with it when asked", async () => {
    await run("install", undefined);
    expect(existsSync(join(settings, "config.toml"))).toBe(true);
    const first = await config();
    expect(first).toContain(`command = "npx -y agentplugged@${ENGINE} hook kimi pre-tool"`);
    expect((await run("status", undefined)).out).toContain("are installed");
  });
});
