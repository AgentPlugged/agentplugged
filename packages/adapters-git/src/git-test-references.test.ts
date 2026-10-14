import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { citedCriteria, testReferences } from "@agentplugged/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GitTestReferences, parseGrepOutput } from "./index.js";

// Real Git processes: slower than vitest's 5 s default under a full test run.
vi.setConfig({ testTimeout: 120_000 });

/** Runs git in a test repository; never in this one, never on the network. */
function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const saved: Record<string, string | undefined> = {};
let config: string;
let base: string;

/** Git sees neither this repository, nor the creator's global or system configuration. */
beforeAll(async () => {
  config = await mkdtemp(join(tmpdir(), "agentplugged-gitconfig-"));
  const global = join(config, "gitconfig");
  await writeFile(global, "");
  const env = {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: await realpath(tmpdir()),
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(config, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agentplugged-test-refs-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

describe("GitTestReferences", () => {
  it("reads the candidate lines of the working tree, tracked and untracked, in any language", async () => {
    git(base, ["init", "-q", "-b", "main"]);
    await write(base, {
      "tests/login_test.py": "def test_EF_1_signs_in():\n    pass  # ENF-2\n",
      "src/sign-in.ts": "// EF-1: not a test\n",
      "spec/reset_spec.rb": "it 'EF-3 resets' do\nend\n",
      "t/lockout.t": "ok(lockout(), 'ef_4');\n",
      "tests/fixtures/logo.png": "\u0000EF-9\u0000",
      ".gitignore": "build/\n",
      "build/tests/old_test.c": "/* EF-5 */\n",
      "src/check_test.c": "void test_ef_6(void) {}\n",
      "docs/latest.md": "EF-7\n",
      "tests/EF-8_reset.py": "def test_reset():\n    pass\n",
      "tests/README.md": "EF-10\n",
    });
    git(base, ["add", "tests", "src", "spec", ".gitignore"]);
    git(base, ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-qm", "x"]);
    // `t/lockout.t` stays untracked: read all the same; `build/` is ignored.
    const read = await new GitTestReferences({ cwd: base }).read();
    expect(read.found).toBe(true);
    if (!read.found) return;
    expect(read.truncated).toBe(false);
    expect(read.files).toEqual(["tests/EF-8_reset.py"]);
    expect(testReferences(read.lines, read.files)).toEqual([
      { requirement: "EF-3", path: "spec/reset_spec.rb", line: 1 },
      { requirement: "EF-6", path: "src/check_test.c", line: 1 },
      { requirement: "EF-4", path: "t/lockout.t", line: 1 },
      { requirement: "EF-8", path: "tests/EF-8_reset.py", line: 0 },
      { requirement: "EF-1", path: "tests/login_test.py", line: 1 },
      { requirement: "ENF-2", path: "tests/login_test.py", line: 2 },
    ]);
  });

  it("reads the criteria of a story cited by the tests, in any language", async () => {
    git(base, ["init", "-q", "-b", "main"]);
    await write(base, {
      "tests/cart.test.ts": "it('AC-17-3-1 refuses an empty cart', () => {});\n",
      "tests/test_cart.py": "def test_AC_17_3_2_pays_for_both():\n    pass\n",
      "cart/cart_test.go": "func TestAC_17_3_3_PlaysASound(t *testing.T) {}\n",
      "tests/ac_17_3_4_test.rs": "fn works() {}\n",
      "src/cart.ts": "// AC-17-3-5 is not in a test file\n",
      "tests/other.test.ts": "it('AC-17-4-1 is another story', () => {});\n",
    });
    git(base, ["add", "."]);
    git(base, ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-qm", "x"]);
    const read = await new GitTestReferences({ cwd: base }).read();
    expect(read.found).toBe(true);
    if (!read.found) return;
    const cited = citedCriteria("17-3", read.lines, read.files);
    expect([...cited.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [1, ["tests/cart.test.ts:1"]],
      [2, ["tests/test_cart.py:1"]],
      [3, ["cart/cart_test.go:1"]],
      [4, ["tests/ac_17_3_4_test.rs"]],
    ]);
    // The requirements are untouched by the criteria.
    expect(testReferences(read.lines, read.files)).toEqual([]);
  });

  it("reads the tests of a story's working copy, and nowhere else", async () => {
    git(base, ["init", "-q", "-b", "main"]);
    await write(base, { "tests/main.test.ts": "it('AC-9-1-1 is in the project', () => {});\n" });
    git(base, ["add", "."]);
    git(base, ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-qm", "x"]);
    const story = join(dirname(base), `${basename(base)}.worktrees`, "9-1");
    git(base, ["worktree", "add", "-q", "-b", "feat/9-1", story]);
    try {
      await write(story, { "tests/cart.test.ts": "it('AC-9-1-2 is in the story', () => {});\n" });
      const source = new GitTestReferences({ cwd: base });
      const workspace = `../${basename(base)}.worktrees/9-1`;
      const inStory = await source.read(workspace);
      const inProject = await source.read();
      expect(inStory.found && inProject.found).toBe(true);
      if (!inStory.found || !inProject.found) return;
      // The project's folder does not hold the story's test; the story's copy holds both lines it has.
      expect([...citedCriteria("9-1", inProject.lines, inProject.files).keys()]).toEqual([1]);
      expect([...citedCriteria("9-1", inStory.lines, inStory.files).keys()].sort()).toEqual([1, 2]);
      // A folder that is not a working copy of this repository is never read.
      const other = await mkdtemp(join(tmpdir(), "agentplugged-other-refs-"));
      try {
        git(other, ["init", "-q", "-b", "main"]);
        const elsewhere = relative(base, other).replaceAll("\\", "/");
        expect((await source.read(elsewhere)).found).toBe(false);
        expect((await source.read("../nowhere")).found).toBe(false);
      } finally {
        await rm(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    } finally {
      await rm(dirname(story), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it("reads below its folder only, with paths relative to it", async () => {
    git(base, ["init", "-q", "-b", "main"]);
    await write(base, {
      "app/tests/a_test.go": "// EF-1\n",
      "other/tests/b_test.go": "// EF-2\n",
    });
    const read = await new GitTestReferences({ cwd: join(base, "app") }).read();
    expect(read.found && testReferences(read.lines)).toEqual([
      { requirement: "EF-1", path: "tests/a_test.go", line: 1 },
    ]);
  });

  it("finds nothing without a match, and is unavailable outside a repository", async () => {
    git(base, ["init", "-q", "-b", "main"]);
    await write(base, { "tests/a_test.py": "nothing here\n" });
    expect(await new GitTestReferences({ cwd: base }).read()).toEqual({
      found: true,
      lines: [],
      files: [],
      truncated: false,
    });
    const outside = await mkdtemp(join(tmpdir(), "agentplugged-no-repo-"));
    try {
      const read = await new GitTestReferences({ cwd: outside }).read();
      expect(read.found).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("is unavailable when Git cannot start, or fails", async () => {
    const missing = new GitTestReferences({
      cwd: base,
      run: async () => {
        throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      },
    });
    expect(await missing.read()).toMatchObject({ found: false, reason: "unavailable" });
    const failing = new GitTestReferences({
      cwd: base,
      run: async () => ({ status: 128, stdout: Buffer.alloc(0), stderr: "fatal: bad\nmore" }),
    });
    expect(await failing.read()).toEqual({
      found: false,
      reason: "unavailable",
      detail: "fatal: bad",
    });
  });

  it("parses `git grep -z` output, and stops at its limit", () => {
    expect(
      parseGrepOutput(
        "tests/a b.py\u00002\u0000# EF-1\r\nbroken line\ntests/c.py\u0000x\u0000EF-2\n",
      ),
    ).toEqual({
      found: true,
      lines: [{ path: "tests/a b.py", line: 2, text: "# EF-1" }],
      files: [],
      truncated: false,
    });
    // A line cut at its limit loses its last, cut word: `EF-12` never reads `EF-1`.
    const long = parseGrepOutput(`t/a.t\u00001\u0000${"x ".repeat(998)}EF-12 more`);
    expect(long.found && long.lines[0]?.text.endsWith("x ")).toBe(true);
    const many = Array.from({ length: 20_001 }, (_, i) => `t/a.t\u0000${i + 1}\u0000EF-1`).join(
      "\n",
    );
    const read = parseGrepOutput(many);
    expect(read.found && read.lines.length).toBe(20_000);
    expect(read.found && read.truncated).toBe(true);
  });
});
