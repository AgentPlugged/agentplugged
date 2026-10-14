import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEngine } from "@agentplugged/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeWorkspaceFiles } from "./node-workspace-files.js";

const CONFIG = ".agentplugged/method.yaml";
const pin = (version: string) => `format_version: 2\nengine_version: ${version}\n`;

let base: string;
let main: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: "ignore" },
  );
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agentplugged-engine-"));
  main = join(base, "product");
  await mkdir(join(main, ".agentplugged"), { recursive: true });
  git(main, "init", "-b", "main");
  await writeFile(join(main, CONFIG), pin("1.0.0"));
  git(main, "add", "-A");
  git(main, "commit", "-m", "start");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("a story's working copy after an engine update not committed yet", () => {
  it("passes the engine check of the running engine, and a main folder is not a copy", async () => {
    // The update rewrote the main working folder only; the copy is made from the commit.
    await writeFile(join(main, CONFIG), pin("1.0.2"));
    const copy = join(base, "product.worktrees", "1-1");
    git(main, "worktree", "add", "-b", "feat/1-1", copy);

    const running = { engineVersion: "1.0.2", command: "next" };
    const inCopy = new NodeWorkspaceFiles(copy);
    expect(await inCopy.readText(CONFIG)).toContain("engine_version: 1.0.0");
    expect(await checkEngine(inCopy, running)).toEqual({
      pinned: "1.0.0",
      overridden: false,
      older: false,
    });
    expect(await new NodeWorkspaceFiles(main).readMainCheckoutText(CONFIG)).toBeUndefined();

    // Another engine than the one the main folder pins still stops.
    const other = await checkEngine(inCopy, { ...running, engineVersion: "1.0.3" });
    expect(other).not.toHaveProperty("overridden");
  });
});
