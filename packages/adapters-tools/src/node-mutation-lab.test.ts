import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MutationPlan,
  mutationCounts,
  runMutationCheck,
  survivorLines,
} from "@agentplugged/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeMutationLab } from "./node-mutation-lab.js";

/**
 * The real throwaway copy of the mutation check: a real folder, a real program run in
 * the copy, and the proof that the creator's folder is the same afterwards and that nothing is left
 * behind, even when the tests fail to start.
 */

const GATE = [
  "function entry(age) {",
  "  if (age >= 18) {",
  "    return 'open';",
  "  }",
  "  return 'closed';",
  "}",
  "const LIMIT = 100;",
  "module.exports = { entry, LIMIT };",
  "",
].join("\n");

const CHECK = [
  "const { entry } = require('./src/gate.js');",
  "if (entry(18) !== 'open') process.exit(1);",
  "if (entry(17) !== 'closed') process.exit(1);",
  "",
].join("\n");

let root: string;
let project: string;
let scratch: string;

/** Every file of a folder with its content, for comparing before and after. */
async function digest(folder: string, base = folder): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(found, await digest(path, base));
    else if (entry.isFile()) {
      found[path.slice(base.length)] = (await readFile(path)).toString("base64");
    }
  }
  return found;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ap-lab-test-"));
  project = join(root, "project");
  scratch = join(root, "scratch");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(scratch, { recursive: true });
  await writeFile(join(project, "src", "gate.js"), GATE);
  await writeFile(join(project, "check.js"), CHECK);
  await writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const lab = (options: Partial<ConstructorParameters<typeof NodeMutationLab>[0]> = {}) =>
  new NodeMutationLab({ root: project, temporary: scratch, ...options });

const plan = (overrides: Partial<MutationPlan> = {}): MutationPlan => ({
  story: "1-1",
  line: "node check.js",
  argv: ["node", "check.js"],
  cwd: ".",
  commandTimeoutMs: 60_000,
  files: [{ path: "src/gate.js", added: new Set([1, 2, 3, 4, 5, 6, 7, 8]) }],
  max: 20,
  seconds: 120,
  now: Date.now,
  ...overrides,
});

describe("the real copy: a break is run in it and only in it", () => {
  it("kills the breaks the program notices, reports the constant it does not, leaves the folder as it was", async () => {
    const before = await digest(project);
    const report = await runMutationCheck(lab(), plan());
    expect(report.status).toBe("done");
    const counts = mutationCounts(report);
    expect(counts.killed).toBeGreaterThanOrEqual(3);
    expect(survivorLines(report)).toEqual(["src/gate.js:7 number `100` -> `101`"]);
    expect(await digest(project)).toEqual(before);
    // The copy is gone.
    expect(await readdir(scratch)).toEqual([]);
    expect(report.leftover).toBeUndefined();
  });

  it("does not copy Git's own folder, and runs the program inside the copy", async () => {
    const opened = await lab().open(undefined, 60);
    if (!("copy" in opened)) throw new Error(`refused: ${opened.refused}`);
    try {
      expect(await opened.copy.read("check.js")).toBe(CHECK);
      expect(await opened.copy.read(".git/HEAD")).toBeUndefined();
      const ran = await opened.copy.runner.run({
        line: "node check.js",
        argv: ["node", "check.js"],
        cwd: ".",
        timeoutMs: 30_000,
        maxOutputBytes: 10_000,
      });
      expect(ran).toMatchObject({ ended: "exit", exit: 0 });
      await opened.copy.write("src/gate.js", GATE.replace(">= 18", ">= 19"));
      const broken = await opened.copy.runner.run({
        line: "node check.js",
        argv: ["node", "check.js"],
        cwd: ".",
        timeoutMs: 30_000,
        maxOutputBytes: 10_000,
      });
      expect(broken.exit).toBe(1);
      expect(await readFile(join(project, "src", "gate.js"), "utf8")).toBe(GATE);
    } finally {
      expect(await opened.copy.close()).toBeUndefined();
    }
    expect(await readdir(scratch)).toEqual([]);
  });

  it("removes the copy when the tests cannot even start, and when the check blows up", async () => {
    const before = await digest(project);
    const missing = await runMutationCheck(
      lab(),
      plan({ line: "no-such-program-here", argv: ["no-such-program-here"] }),
    );
    expect(missing.status).toBe("baseline_red");
    expect(missing.reason).toContain("cannot_start");
    const red = await runMutationCheck(
      lab(),
      plan({ line: "node -e process.exit(3)", argv: ["node", "-e", "process.exit(3)"] }),
    );
    expect(red).toMatchObject({ status: "baseline_red", results: [] });
    expect(await digest(project)).toEqual(before);
    expect(await readdir(scratch)).toEqual([]);
  });
});

describe("a write can only land on a file of the copy", () => {
  it("refuses a path outside the project, a missing file, a folder", async () => {
    const opened = await lab().open(undefined, 60);
    if (!("copy" in opened)) throw new Error(`refused: ${opened.refused}`);
    try {
      await expect(opened.copy.write("../escape.js", "x")).rejects.toThrow(/refused/);
      await expect(opened.copy.write("/etc/escape.js", "x")).rejects.toThrow(/refused/);
      await expect(opened.copy.write("src/new.js", "x")).rejects.toThrow();
      await expect(opened.copy.write("src", "x")).rejects.toThrow();
      expect(await opened.copy.read("../project/check.js")).toBeUndefined();
    } finally {
      await opened.copy.close();
    }
    expect(await readdir(root)).toEqual(expect.arrayContaining(["project", "scratch"]));
    expect(await readdir(root)).not.toContain("escape.js");
  });

  it("never writes through a link that leads out of the copy", async (context) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.js"), "original");
    let linked = true;
    try {
      await symlink(outside, join(project, "src", "evil"), "junction");
      await symlink(join(outside, "secret.js"), join(project, "src", "file-link.js"), "file");
    } catch {
      // No right to make links here (Windows without developer mode): the folder link still counts.
      linked = (await readdir(join(project, "src"))).includes("evil");
    }
    if (!linked) context.skip("no right to make a folder link here");
    const opened = await lab().open(undefined, 60);
    if (!("copy" in opened)) throw new Error(`refused: ${opened.refused}`);
    try {
      await expect(opened.copy.write("src/evil/secret.js", "overwritten")).rejects.toThrow(
        /refused/,
      );
      await opened.copy.write("src/file-link.js", "overwritten").catch(() => undefined);
    } finally {
      await opened.copy.close();
    }
    expect(await readFile(join(outside, "secret.js"), "utf8")).toBe("original");
  });
});

describe("what the copy keeps and leaves", () => {
  it("makes a link that pointed inside the project point inside the copy", async (context) => {
    await mkdir(join(project, "lib"), { recursive: true });
    await writeFile(join(project, "lib", "dep.js"), "module.exports = 1;");
    try {
      await symlink(join(project, "lib"), join(project, "src", "alias"), "junction");
    } catch (error) {
      context.skip(`no right to make a folder link here: ${String(error)}`);
    }
    const opened = await lab().open(undefined, 60);
    if (!("copy" in opened)) throw new Error(`refused: ${opened.refused}`);
    try {
      // Read through the link, then change the file behind it: the creator's file is the same.
      expect(await opened.copy.read("src/alias/dep.js")).toBe("module.exports = 1;");
      await opened.copy.write("lib/dep.js", "module.exports = 2;");
      expect(await opened.copy.read("src/alias/dep.js")).toBe("module.exports = 2;");
      expect(await readFile(join(project, "lib", "dep.js"), "utf8")).toBe("module.exports = 1;");
    } finally {
      await opened.copy.close();
    }
  });

  it("leaves out another working copy of the repository nested in the project", async () => {
    const nested = join(project, "other-tree");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, ".git"), "gitdir: /repo/.git/worktrees/other-tree\n");
    await writeFile(join(nested, "big.js"), "x");
    const opened = await lab().open(undefined, 60);
    if (!("copy" in opened)) throw new Error(`refused: ${opened.refused}`);
    try {
      expect(await opened.copy.read("other-tree/big.js")).toBeUndefined();
      expect(await opened.copy.read("check.js")).toBe(CHECK);
    } finally {
      await opened.copy.close();
    }
  });
});

describe("the copy is bounded", () => {
  it("refuses a project with too many files, nothing left behind", async () => {
    const opened = await lab({ maxFiles: 1 }).open(undefined, 60);
    expect(opened).toEqual({ refused: "copy_too_big" });
    expect(await readdir(scratch)).toEqual([]);
  });

  it("refuses a project that is too big", async () => {
    expect(await lab({ maxBytes: 10 }).open(undefined, 60)).toEqual({ refused: "copy_too_big" });
    expect(await readdir(scratch)).toEqual([]);
  });

  it("refuses a copy that takes longer than its time", async () => {
    expect(await lab().open(undefined, -1)).toEqual({ refused: "copy_too_slow" });
    expect(await readdir(scratch)).toEqual([]);
  });

  it("refuses a folder that is not a working copy of the project", async () => {
    const refused = await lab().open("../elsewhere", 60);
    expect(refused).toEqual({ refused: "not_a_working_copy" });
  });
});
