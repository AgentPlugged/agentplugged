import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EventDraft,
  MemoryKeyStore,
  projectState,
  STATE_CACHE_PATH,
  syncJournal,
} from "@agentplugged/core";
import { toBase64url } from "@agentplugged/crypto";
import { JOURNAL_PROJECTED_REF, JOURNAL_REF, TEST_EVENT_TYPE } from "@agentplugged/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GitStateStore, NodeWorkspaceFiles } from "./index.js";

// Real repositories and a real (temporary, bare) remote: slower than vitest's 5 s default.
vi.setConfig({ testTimeout: 120_000 });

const PRODUCT = "01JZ0000000000000000000000";
const SEED_A = toBase64url(new Uint8Array(32).fill(1));
const SEED_B = toBase64url(new Uint8Array(32).fill(2));

const draft = (n: number): EventDraft => ({
  type: TEST_EVENT_TYPE,
  actor: { kind: "system" },
  product: PRODUCT,
  provenance: "trusted",
  payload: { n },
});

/** Runs git in a test repository; never in this one, never on the network. */
function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const saved: Record<string, string | undefined> = {};
let base: string;
let remote: string;
const stores: GitStateStore[] = [];

/** Git sees neither this repository, nor the creator's global or system configuration. */
beforeAll(async () => {
  const isolated = await mkdtemp(join(tmpdir(), "agentplugged-gitconfig-"));
  const global = join(isolated, "gitconfig");
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

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Identity of a test repository: Ada, never the creator's. */
function identify(path: string) {
  git(path, ["config", "user.name", "Ada"]);
  git(path, ["config", "user.email", "ada@example.com"]);
  git(path, ["config", "core.autocrlf", "false"]);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agentplugged-projection-"));
  remote = join(base, "remote.git");
  git(base, ["init", "-q", "--bare", "-b", "main", remote]);
  identify(remote);
});

afterEach(async () => {
  for (const opened of stores.splice(0)) opened.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Machine A (a repository with `.agentplugged/`, pushed to the remote) and B (a clone). */
async function twoMachines() {
  const pathA = join(base, "a");
  await mkdir(join(pathA, ".agentplugged"), { recursive: true });
  git(pathA, ["init", "-q", "-b", "main"]);
  identify(pathA);
  await writeFile(join(pathA, ".agentplugged/.gitignore"), ".cache/\n");
  git(pathA, ["add", "."]);
  git(pathA, ["commit", "-q", "-m", "first"]);
  git(pathA, ["remote", "add", "origin", remote]);
  git(pathA, ["push", "-q", "origin", "main"]);
  const pathB = join(base, "b");
  git(base, ["clone", "-q", remote, pathB]);
  identify(pathB);
  const open = (cwd: string, seed: string) => {
    const created = new GitStateStore({
      allowTestTypes: true,
      cwd,
      keys: new MemoryKeyStore(seed),
      machineLockPath: join(base, `machine-key-${seed.slice(0, 4)}.lock`),
    });
    stores.push(created);
    return created;
  };
  return { pathA, pathB, a: open(pathA, SEED_A), b: open(pathB, SEED_B) };
}

const stateOf = (path: string) => readFile(join(path, STATE_CACHE_PATH), "utf8");
const options = { productId: PRODUCT, allowTestTypes: true };

describe("journal status on a Git journal", () => {
  it("gives byte-identical state.json files on two clones once synced", async () => {
    const { pathA, pathB, a, b } = await twoMachines();
    for (let n = 0; n < 5; n++) await a.append(draft(n));
    for (let n = 10; n < 15; n++) await b.append(draft(n));
    await syncJournal(a);
    await syncJournal(b);
    await syncJournal(a);

    const fromA = await projectState(a, new NodeWorkspaceFiles(pathA), options);
    const fromB = await projectState(b, new NodeWorkspaceFiles(pathB), options);
    expect([fromA.file, fromB.file]).toEqual(["written", "written"]);
    const textA = await stateOf(pathA);
    expect(textA).toBe(await stateOf(pathB));
    expect(fromA.state).toMatchObject({
      journal_head: git(pathA, ["rev-parse", JOURNAL_REF]),
      product: PRODUCT,
      // Each machine: its key, the product (written by both, the same), its 5 events.
      applied: 14,
      ignored: [],
      warnings: [],
    });
    expect(fromA.state.devices).toHaveLength(2);
    // The projected reference is local: never pushed, and state.json never versioned.
    expect(git(pathA, ["rev-parse", JOURNAL_PROJECTED_REF])).toBe(fromA.state.journal_head);
    expect(git(remote, ["for-each-ref", "--format=%(refname)"]).split("\n").sort()).toEqual([
      "refs/heads/agentplugged/journal",
      "refs/heads/main",
    ]);
    expect(git(pathA, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  it("computes the same state again when .agentplugged/.cache/ is deleted", async () => {
    const { pathA, a } = await twoMachines();
    for (let n = 0; n < 3; n++) await a.append(draft(n));
    const files = new NodeWorkspaceFiles(pathA);
    expect((await projectState(a, files, options)).file).toBe("written");
    const reference = await stateOf(pathA);
    expect((await projectState(a, files, options)).file).toBe("unchanged");
    await rm(join(pathA, ".agentplugged/.cache"), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
    const again = await projectState(a, files, options);
    expect(again.file).toBe("written");
    expect(again.warnings).toEqual([]);
    expect(await stateOf(pathA)).toBe(reference);
  });

  it("warns history_rewritten when the journal no longer descends from the projected commit", async () => {
    const { pathA, a } = await twoMachines();
    await a.append(draft(0));
    const older = git(pathA, ["rev-parse", JOURNAL_REF]);
    for (let n = 1; n <= 3; n++) await a.append(draft(n));
    const files = new NodeWorkspaceFiles(pathA);
    const first = await projectState(a, files, options);
    expect(first.state.applied).toBe(6);

    // Forced back, as a rewrite elsewhere would: 3 events projected are gone.
    git(pathA, ["update-ref", JOURNAL_REF, older]);
    const rewritten = await projectState(a, files, options);
    expect(rewritten.file).toBe("written");
    expect(rewritten.warnings).toEqual([{ code: "history_rewritten", missing: 3, unknown: false }]);
    expect(rewritten.state.warnings).toEqual([]);
    expect(rewritten.state.applied).toBe(3);
    expect(rewritten.state.journal_head).toBe(older);
    expect(git(pathA, ["rev-parse", JOURNAL_PROJECTED_REF])).toBe(older);

    // Writing goes on from there: the new head descends from the projected one.
    await a.append(draft(9));
    const next = await projectState(a, files, options);
    expect(next.warnings).toEqual([]);
    expect(next.state.applied).toBe(4);
  });

  it("warns without a count when the projected commit is missing, then moves the reference", async () => {
    const { pathA, a } = await twoMachines();
    await a.append(draft(0));
    const missing = "1".repeat(git(pathA, ["rev-parse", JOURNAL_REF]).length);
    const refFile = join(pathA, ".git", ...JOURNAL_PROJECTED_REF.split("/"));
    await mkdir(join(refFile, ".."), { recursive: true });
    await writeFile(refFile, `${missing}\n`);
    expect(await a.projected()).toBe(missing);

    const result = await projectState(a, new NodeWorkspaceFiles(pathA), options);
    expect(result.warnings).toEqual([{ code: "history_rewritten", missing: 0, unknown: true }]);
    expect(git(pathA, ["rev-parse", JOURNAL_PROJECTED_REF])).toBe(
      git(pathA, ["rev-parse", JOURNAL_REF]),
    );
  });

  it("leaves the projected reference as another process moved it, and clears it when asked", async () => {
    const { pathA, a } = await twoMachines();
    await a.append(draft(0));
    const head = git(pathA, ["rev-parse", JOURNAL_REF]);
    await a.markProjected(head, null);
    // A lost compare-and-swap: someone projected meanwhile, the reference stays theirs.
    await a.markProjected(git(pathA, ["rev-parse", "HEAD"]), null);
    expect(await a.projected()).toBe(head);
    await a.markProjected(null, head);
    expect(await a.projected()).toBeNull();
  });

  it("writes no state.json where the method is not installed", async () => {
    const path = join(base, "bare-product");
    await mkdir(path);
    git(path, ["init", "-q", "-b", "main"]);
    identify(path);
    const journal = new GitStateStore({
      allowTestTypes: true,
      cwd: path,
      keys: new MemoryKeyStore(SEED_A),
      machineLockPath: join(base, "machine-key.lock"),
    });
    stores.push(journal);
    await journal.append(draft(0));
    const result = await projectState(journal, new NodeWorkspaceFiles(path), options);
    expect(result).toMatchObject({ file: "not_installed", state: { applied: 3 } });
    expect(existsSync(join(path, ".agentplugged"))).toBe(false);
  });
});
