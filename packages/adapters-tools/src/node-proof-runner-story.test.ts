import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ProofRunRequest } from "@agentplugged/core";
import { describe, expect, it } from "vitest";
import { NodeProofRunner } from "./node-proof-runner.js";

/**
 * The runner in the working copy of a story: the tests of a story are in its own
 * working copy, beside the project's, so the engine starts the command there, with the commit of
 * that copy, and nowhere else. Real Git, real short commands.
 */

const text = (result: { head: string; tail: string }) => result.head + result.tail;

const request = (overrides: Partial<ProofRunRequest> & { script?: string } = {}) => {
  const { script, ...rest } = overrides;
  return {
    line: "node",
    argv: [process.execPath, "-e", script ?? "console.log('hello')"],
    cwd: ".",
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    ...rest,
  } satisfies ProofRunRequest;
};

/** The program run in Git's folder `cwd`, quietly. */
function vcs(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
}

/** A repository `shop` and, beside it, the working copy `shop.worktrees/1-3` of a branch of its own. */
function shop() {
  const parent = mkdtempSync(join(tmpdir(), "agentplugged-story-"));
  const main = join(parent, "shop");
  mkdirSync(main);
  vcs(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "where.txt"), "main");
  vcs(main, "add", ".");
  vcs(main, "commit", "-q", "-m", "first");
  const story = join(parent, "shop.worktrees", "1-3");
  vcs(main, "worktree", "add", "-q", "-b", "feat/1-3", story);
  writeFileSync(join(story, "where.txt"), "story");
  vcs(story, "add", ".");
  vcs(story, "commit", "-q", "-m", "the test, then the code");
  return { parent, main, story };
}

const PRINT = "process.stdout.write(require('node:fs').readFileSync('where.txt', 'utf8'))";
const WORKSPACE = "../shop.worktrees/1-3";

describe("the working copy of a story", () => {
  it("runs in the story's working copy, not in the project's, and reads its commit", async () => {
    const { parent, main, story } = shop();
    try {
      const probe = new NodeProofRunner({ root: main });
      expect(text(await probe.run(request({ script: PRINT })))).toBe("main");
      expect(text(await probe.run(request({ script: PRINT, workspace: WORKSPACE })))).toBe("story");
      const head = vcs(story, "rev-parse", "HEAD");
      const mainHead = vcs(main, "rev-parse", "HEAD");
      expect(head).not.toBe(mainHead);
      expect(await probe.workingCopy(WORKSPACE)).toEqual({ commit: head, clean: true });
      expect((await probe.workingCopy()).commit).toBe(mainHead);
      // Changes not committed in the story's copy are said, and only there.
      writeFileSync(join(story, "new.txt"), "x");
      expect((await probe.workingCopy(WORKSPACE)).clean).toBe(false);
      expect((await probe.workingCopy()).clean).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("looks for the folder of the command inside the copy", async () => {
    const { parent, main, story } = shop();
    try {
      const probe = new NodeProofRunner({ root: main });
      mkdirSync(join(story, "sub"));
      const inside = await probe.run(
        request({ script: "process.stdout.write('ok')", cwd: "sub", workspace: WORKSPACE }),
      );
      expect(text(inside)).toBe("ok");
      const outside = await probe.run(request({ cwd: "..", workspace: WORKSPACE }));
      expect(outside.ended).toBe("error");
      expect(outside.detail).toContain("outside the project");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("runs nowhere else: not in another repository, not where nothing exists", async () => {
    const { parent, main } = shop();
    const other = mkdtempSync(join(tmpdir(), "agentplugged-other-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: other, stdio: "ignore" });
      const probe = new NodeProofRunner({ root: main });
      const elsewhere = relative(main, other).replaceAll("\\", "/");
      const stranger = await probe.run(request({ workspace: elsewhere }));
      expect(stranger.ended).toBe("error");
      expect(stranger.detail).toContain("not a working copy of this repository");
      const missing = await probe.run(request({ workspace: "../shop.worktrees/9-9" }));
      expect(missing.ended).toBe("error");
      expect(await probe.workingCopy(elsewhere)).toEqual({});
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});
