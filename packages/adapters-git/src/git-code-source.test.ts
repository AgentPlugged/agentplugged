import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCodeSource } from "./index.js";

vi.setConfig({ testTimeout: 60_000 });

function gitOk(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(cwd, ".no-config") },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-code-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("GitCodeSource", () => {
  it("reads the files of a commit that the caller accepts, whatever the working folder holds", async () => {
    gitOk(root, ["init", "-q", "-b", "main"]);
    gitOk(root, ["config", "user.name", "Ada"]);
    gitOk(root, ["config", "user.email", "ada@example.com"]);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "é accent.ts"), "export const a = 1;\n");
    await writeFile(join(root, "src", "b.py"), "b = 2\n");
    await writeFile(join(root, "README.md"), "# readme\n");
    await writeFile(join(root, "big.ts"), "x".repeat(5_000));
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "start"]);
    const commit = gitOk(root, ["rev-parse", "HEAD"]);
    // The working folder changes after the commit: the commit's files are the ones read.
    await writeFile(join(root, "src", "b.py"), "b = 3\n");
    await writeFile(join(root, "untracked.ts"), "export const u = 1;\n");
    const source = new GitCodeSource({ cwd: root });
    const files = await source.read(
      commit,
      (path, bytes) => /\.(?:ts|py)$/.test(path) && bytes < 1_000,
    );
    expect(files).toEqual([
      { path: "src/b.py", text: "b = 2\n" },
      { path: "src/é accent.ts", text: "export const a = 1;\n" },
    ]);
    expect(await source.read(commit, () => false)).toEqual([]);
  });

  it("says nothing it does not know: an unknown commit, a bad id, no repository", async () => {
    const source = new GitCodeSource({ cwd: root });
    expect(await source.read("a".repeat(40), () => true)).toBeUndefined();
    expect(await source.read("--output=x", () => true)).toBeUndefined();
  });
});
