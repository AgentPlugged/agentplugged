// Journal bench (`pnpm --filter @agentplugged/adapters-git bench`): cost per event of
// `GitStateStore` with one writer, then with two processes in two worktrees. Temporary
// repositories only, with their own identity; never this repository. The result is recorded in
// docs/spikes/2-1-cle-humaine-et-journal.md, not asserted by the tests.
//
// Usage: node test/bench.mjs [--count 50]

import "./source-hooks.mjs";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { GitStateStore } = await import("../src/git-state-store.ts");
const { MemoryKeyStore } = await import("@agentplugged/core");

const here = dirname(fileURLToPath(import.meta.url));
const countArg = process.argv.indexOf("--count");
const count = countArg === -1 ? 50 : Number(process.argv[countArg + 1]);
const SEED_A = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const SEED_B = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo(base) {
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".agentplugged"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Ada");
  git(repo, "config", "user.email", "ada@example.com");
  writeFileSync(join(repo, ".agentplugged/.gitignore"), ".cache/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  return repo;
}

function worker(cwd, seed, label, lock) {
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [join(here, "append-worker.mjs"), cwd, seed, String(count), label, lock],
      { windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) =>
      status === 0 ? done(JSON.parse(out.trim())) : reject(new Error(`worker ${label}: ${status}`)),
    );
  });
}

const round = (value) => Math.round(value * 10) / 10;
const base = mkdtempSync(join(tmpdir(), "agentplugged-bench-"));
try {
  const lock = join(base, "machine-key.lock");
  const repo = makeRepo(base);
  const store = new GitStateStore({
    allowTestTypes: true,
    cwd: repo,
    keys: new MemoryKeyStore(SEED_A),
    machineLockPath: lock,
  });
  await store.append({
    type: "test.appended",
    actor: { kind: "system" },
    product: "01JZ0000000000000000000000",
    provenance: "trusted",
    payload: {},
  });
  const started = performance.now();
  for (let n = 1; n <= count; n++) {
    await store.append({
      type: "test.appended",
      actor: { kind: "system" },
      product: "01JZ0000000000000000000000",
      provenance: "trusted",
      payload: { n },
    });
  }
  const solo = {
    events: count,
    msPerEvent: round((performance.now() - started) / count),
    ...store.stats,
  };
  store.close();

  const other = join(base, "feat-x");
  git(repo, "worktree", "add", "-q", "-b", "feat/x", other);
  const wall = performance.now();
  const results = await Promise.all([
    worker(repo, SEED_A, "A", lock),
    worker(other, SEED_B, "B", lock),
  ]);
  const wallMs = performance.now() - wall;
  const concurrent = {
    events: 2 * count,
    msPerEventWall: round(wallMs / (2 * count)),
    casRetries: results.map((r) => r.stats.casRetries),
    lockWaitMs: results.map((r) => r.stats.lockWaitMs),
    gitStarts: results.map((r) => r.stats.gitStarts),
  };
  console.log(
    JSON.stringify(
      {
        platform: `${process.platform} ${process.arch}`,
        node: process.version,
        git: git(repo, "--version"),
        solo,
        concurrent,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
