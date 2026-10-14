import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EventDraft,
  JOURNAL_REMOTE_NAME,
  JournalBackup,
  MemoryKeyStore,
  type RemoteExposure,
} from "@agentplugged/core";
import { toBase64url } from "@agentplugged/crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { anonymousUrlOf, classifyAnonymousRead, GitStateStore, probeExposure } from "./index.js";

// Real repositories and real (temporary, bare) remotes, two machines: slower than vitest's default.
vi.setConfig({ testTimeout: 120_000 });

const REF = "refs/heads/agentplugged/journal";
const PRODUCT = "01JZ0000000000000000000000";
const SEED_A = toBase64url(new Uint8Array(32).fill(1));
const SEED_B = toBase64url(new Uint8Array(32).fill(2));

const draft = (n: number): EventDraft => ({
  type: "test.appended",
  actor: { kind: "system" },
  product: PRODUCT,
  provenance: "trusted",
  payload: { n },
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const saved: Record<string, string | undefined> = {};
let base: string;
let remote: string;
const stores: GitStateStore[] = [];
const backups: JournalBackup[] = [];

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

function identify(path: string) {
  git(path, ["config", "user.name", "Ada"]);
  git(path, ["config", "user.email", "ada@example.com"]);
  git(path, ["config", "core.autocrlf", "false"]);
}

async function makeRepo(path: string, origin: string | null): Promise<string> {
  await mkdir(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  identify(path);
  await writeFile(join(path, "README.md"), "product\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-q", "-m", "first"]);
  if (origin !== null) git(path, ["remote", "add", "origin", origin]);
  return path;
}

function bare(name: string): string {
  const path = join(base, name);
  git(base, ["init", "-q", "--bare", "-b", "main", path]);
  git(path, ["config", "core.logAllRefUpdates", "always"]);
  return path;
}

/** One machine: a store, and the backup that watches its writes. */
function machine(
  cwd: string,
  seed: string,
  options: { exposure?: (url: string) => RemoteExposure; debounceMs?: number } = {},
) {
  let saving: JournalBackup | undefined;
  const writes = { count: 0 };
  const journal = new GitStateStore({
    allowTestTypes: true,
    cwd,
    keys: new MemoryKeyStore(seed),
    machineLockPath: join(base, `machine-key-${seed.slice(0, 4)}.lock`),
    exposureProbe: async (url) => options.exposure?.(url) ?? "private",
    onWrite: () => {
      writes.count += 1;
      saving?.noteWrite();
    },
  });
  stores.push(journal);
  saving = new JournalBackup({
    port: journal,
    debounceMs: options.debounceMs ?? 100,
    pullEveryMs: 0,
    pullWaitMs: 20_000,
    retryMs: [60_000],
  });
  backups.push(saving);
  return { journal, saving, writes };
}

async function appendN(journal: GitStateStore, from: number, count: number) {
  for (let n = from; n < from + count; n++) await journal.append(draft(n));
}

const remoteHead = (path: string) => {
  const result = spawnSync("git", ["rev-parse", "-q", "--verify", REF], {
    cwd: path,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
};

/** The journal's events as the remote holds them (event files at its tip). */
const remoteEvents = (path: string): string[] =>
  git(path, ["ls-tree", "-r", "--name-only", REF]).split("\n").filter(Boolean).sort();

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agentplugged-backup-"));
  remote = bare("remote.git");
});

afterEach(async () => {
  for (const one of backups.splice(0)) await one.close(50);
  for (const opened of stores.splice(0)) opened.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("the journal sent by the engine itself", () => {
  it("is sent a few seconds after the writes, grouped, never forced, then a new machine receives it", async () => {
    const pathA = await makeRepo(join(base, "a"), remote);
    git(pathA, ["push", "-q", "origin", "main"]);
    const a = machine(pathA, SEED_A, { debounceMs: 4_000 });
    await appendN(a.journal, 0, 3);
    expect(remoteHead(remote)).toBeNull();
    await until(() => remoteHead(remote) !== null, "the first send");
    const listed = (await a.journal.list()).events.length;
    await until(() => remoteEvents(remote).length === listed, "all the events sent");
    // Three writes, grouped: far fewer sends than writes.
    const sends = git(remote, ["reflog", "show", "--format=%H", REF]).split("\n").filter(Boolean);
    expect(sends.length).toBeLessThanOrEqual(2);
    expect(await a.saving.report()).toBeUndefined();

    // A clone, a new machine: activating the engine receives the journal, with nothing to type.
    const pathB = join(base, "b");
    git(base, ["clone", "-q", remote, pathB]);
    identify(pathB);
    const b = machine(pathB, SEED_B);
    expect((await b.journal.list()).events).toHaveLength(0);
    await b.saving.start();
    expect((await b.journal.list()).events).toHaveLength(listed);
    expect(b.writes.count).toBe(0);
  });

  it("two machines write on their own: each fetches before it reads, both end with the same history", async () => {
    const pathA = await makeRepo(join(base, "a"), remote);
    git(pathA, ["push", "-q", "origin", "main"]);
    const pathB = join(base, "b");
    git(base, ["clone", "-q", remote, pathB]);
    identify(pathB);
    const a = machine(pathA, SEED_A);
    const b = machine(pathB, SEED_B);
    await appendN(a.journal, 0, 2);
    await a.saving.flush(30_000);
    await b.saving.beforeRead();
    await appendN(b.journal, 10, 2);
    await appendN(a.journal, 20, 2);
    await Promise.all([a.saving.flush(30_000), b.saving.flush(30_000)]);
    await a.saving.flush(30_000);
    await b.saving.flush(30_000);

    const idsOf = async (journal: GitStateStore) =>
      (await journal.list()).events.map((event) => event.id).sort();
    const same = await idsOf(a.journal);
    expect(await idsOf(b.journal)).toEqual(same);
    expect(same.length).toBeGreaterThanOrEqual(6);
    expect(remoteEvents(remote)).toHaveLength(same.length);
  });

  it("does not send what it only integrates (a write counts once, here)", async () => {
    const pathA = await makeRepo(join(base, "a"), remote);
    git(pathA, ["push", "-q", "origin", "main"]);
    const pathB = join(base, "b");
    git(base, ["clone", "-q", remote, pathB]);
    identify(pathB);
    const a = machine(pathA, SEED_A);
    const b = machine(pathB, SEED_B);
    await appendN(a.journal, 0, 1);
    await a.saving.flush(30_000);
    await b.saving.start();
    expect(b.writes.count).toBe(0);
  });
});

describe("offline, then catching up", () => {
  it("keeps writing locally, says since when, and sends everything when the remote is back", async () => {
    const pathA = await makeRepo(join(base, "a"), remote);
    git(pathA, ["push", "-q", "origin", "main"]);
    const a = machine(pathA, SEED_A);
    await appendN(a.journal, 0, 1);
    await a.saving.flush(30_000);
    const before = remoteEvents(remote).length;

    const away = join(base, "away.git");
    await rename(remote, away);
    await appendN(a.journal, 5, 2);
    await a.saving.flush(5_000);
    const view = await a.saving.report({ consume: true });
    expect(view).toMatchObject({ status: "offline", remote: "origin" });
    expect(view?.last_saved).toBeDefined();
    expect((await a.journal.list()).events.length).toBeGreaterThan(before);

    await rename(away, remote);
    await a.saving.kick();
    expect(await a.saving.report()).toBeUndefined();
    expect(remoteEvents(remote)).toHaveLength((await a.journal.list()).events.length);
  });
});

describe("the journal never goes to a public repository", () => {
  it("keeps the journal here and says so, when the repository is public", async () => {
    const pathA = await makeRepo(join(base, "a"), remote);
    git(pathA, ["push", "-q", "origin", "main"]);
    const a = machine(pathA, SEED_A, { exposure: () => "public" });
    await appendN(a.journal, 0, 2);
    await a.saving.flush(30_000);
    expect(remoteHead(remote)).toBeNull();
    const view = await a.saving.report({ consume: true });
    expect(view).toMatchObject({ status: "blocked", reason: "public_remote", remote: "origin" });
    expect(view?.action).toContain("-journal");
  });

  it("sends it to the separate private repository instead, and never to origin", async () => {
    const pathA = await makeRepo(join(base, "a"), remote);
    git(pathA, ["push", "-q", "origin", "main"]);
    const priv = bare("journal.git");
    git(pathA, ["remote", "add", JOURNAL_REMOTE_NAME, priv]);
    const a = machine(pathA, SEED_A, {
      exposure: (url) => (url.includes("remote.git") ? "public" : "private"),
    });
    await appendN(a.journal, 0, 2);
    await a.saving.flush(30_000);
    expect(remoteHead(remote)).toBeNull();
    expect(remoteHead(priv)).not.toBeNull();
    expect(remoteEvents(priv)).toHaveLength((await a.journal.list()).events.length);
    expect(await a.saving.report()).toBeUndefined();
    expect(await a.journal.backupRemote({ checkExposure: false })).toEqual({
      kind: "remote",
      remote: JOURNAL_REMOTE_NAME,
      exposure: "unknown",
    });
  });

  it("is not sent when the visibility cannot be checked", async () => {
    const pathA = await makeRepo(join(base, "a"), remote);
    git(pathA, ["push", "-q", "origin", "main"]);
    const a = machine(pathA, SEED_A, { exposure: () => "unknown" });
    await appendN(a.journal, 0, 1);
    await a.saving.flush(30_000);
    expect(remoteHead(remote)).toBeNull();
    expect((await a.saving.report())?.status).toBe("offline");
  });

  it("reads the visibility of the address Git pushes to, and remembers a private one", async () => {
    const pathA = await makeRepo(join(base, "a"), remote);
    const probed: string[] = [];
    const a = machine(pathA, SEED_A, {
      exposure: (url) => {
        probed.push(url);
        return "private";
      },
    });
    expect(await a.journal.remoteExposure("origin")).toBe("private");
    expect(await a.journal.remoteExposure("origin")).toBe("private");
    expect(probed).toHaveLength(1);
  });
});

describe("a product without a remote", () => {
  it("is blocked and told once, then saves by itself once a remote is there", async () => {
    const pathA = await makeRepo(join(base, "a"), null);
    const a = machine(pathA, SEED_A);
    await appendN(a.journal, 0, 1);
    await a.saving.flush(5_000);
    const first = await a.saving.report({ consume: true });
    expect(first).toMatchObject({ status: "blocked", reason: "no_remote" });
    expect(first?.action).toContain("forge_repo_create");
    expect((await a.saving.report({ consume: true }))?.action).toContain("already told");

    git(pathA, ["remote", "add", "origin", remote]);
    await a.saving.kick();
    expect(await a.saving.report()).toBeUndefined();
    expect(remoteEvents(remote)).toHaveLength((await a.journal.list()).events.length);
  });
});

describe("the anonymous read of a repository", () => {
  it("answered: public, even empty", () => {
    expect(classifyAnonymousRead({ status: 0, stderr: "" })).toBe("public");
  });

  it.each([
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "remote: Repository not found.\nfatal: repository 'https://github.com/ada/x/' not found",
    "fatal: Authentication failed for 'https://gitlab.com/ada/x.git/'",
    "fatal: unable to access 'https://x/': The requested URL returned error: 403",
  ])("asks for credentials or hides it: private (%s)", (stderr) => {
    expect(classifyAnonymousRead({ status: 128, stderr })).toBe("private");
  });

  it.each([
    "fatal: unable to access 'https://github.com/ada/x/': Could not resolve host: github.com",
    "fatal: unable to access 'https://x/': Failed to connect to x port 443",
    "fatal: unable to access 'https://x/': SSL certificate problem",
    "something unexpected",
  ])("a network that is down or an unknown answer: unknown (%s)", (stderr) => {
    expect(classifyAnonymousRead({ status: 128, stderr })).toBe("unknown");
  });

  it("a server in trouble or a rate limit says nothing of the repository: unknown", () => {
    for (const stderr of [
      "fatal: unable to access 'https://github.com/ada/x/': The requested URL returned error: 503",
      "fatal: unable to access 'https://github.com/ada/x/': The requested URL returned error: 429",
      "fatal: unable to access 'https://gitlab.com/ada/x/': Service Unavailable",
    ]) {
      expect(classifyAnonymousRead({ status: 128, stderr })).toBe("unknown");
      expect(classifyAnonymousRead({ status: 128, stderr }, { lenient: true })).toBe("unknown");
    }
  });

  it("a host of the creator's own that cannot be read anonymously is private, a forge's is not guessed", () => {
    const stderr =
      "fatal: unable to access 'https://git.company.example/team/app/': HTTP/2 stream 1 was not closed cleanly";
    expect(classifyAnonymousRead({ status: 128, stderr })).toBe("unknown");
    expect(classifyAnonymousRead({ status: 128, stderr }, { lenient: true })).toBe("private");
  });

  it("a repository named like a network word is no sign of a network that is down", () => {
    for (const name of ["tls-tools", "ssl-checker", "proxy-service", "app-500"]) {
      const stderr = `remote: Repository not found.\nfatal: repository 'https://github.com/acme/${name}/' not found`;
      expect(classifyAnonymousRead({ status: 128, stderr })).toBe("private");
    }
    expect(
      classifyAnonymousRead({
        status: 128,
        stderr: "fatal: transport 'ssh' not allowed",
      }),
    ).toBe("unknown");
  });

  it("an address that cannot be read from the web is unknown, never private", async () => {
    // A path with signs the engine does not parse, another port of a server that is no forge's.
    for (const url of [
      "https://git.sr.ht/~ada/repo",
      "git@git.sr.ht:~ada/repo",
      "ssh://git@host.example:2222/team/app.git",
    ]) {
      expect(await probeExposure(url, { cwd: base }), url).toBe("unknown");
    }
  });

  it("several push addresses are as exposed as the most exposed one", async () => {
    // A local path first, an address that cannot be told next: the doubt wins.
    expect(await probeExposure(`${remote}\nhttps://git.sr.ht/~ada/repo`, { cwd: base })).toBe(
      "unknown",
    );
  });

  it("a read that timed out is unknown", () => {
    expect(
      classifyAnonymousRead({
        status: null,
        stderr: "fatal: git ls-remote took more than 8 s",
        timedOut: true,
      }),
    ).toBe("unknown");
  });

  it("is asked on the web address of the repository, never with credentials", () => {
    expect(anonymousUrlOf("git@github.com:ada/shop.git")).toBe("https://github.com/ada/shop");
    expect(anonymousUrlOf("https://ada:token@gitlab.com/group/sub/shop.git")).toBe(
      "https://gitlab.com/group/sub/shop",
    );
    expect(anonymousUrlOf("ssh://git@github.com/ada/shop.git")).toBe("https://github.com/ada/shop");
    // The port of a web address is kept; another port of an ssh address says nothing of the web.
    expect(anonymousUrlOf("https://git.example.fr:8443/org/repo.git")).toBe(
      "https://git.example.fr:8443/org/repo",
    );
    expect(anonymousUrlOf("ssh://git@host.example:2222/team/app.git")).toBeUndefined();
    expect(anonymousUrlOf("http://git.internal/team/app")).toBe("http://git.internal/team/app");
  });

  it("a remote that is not on a host is private without any network", async () => {
    expect(anonymousUrlOf("/srv/git/shop.git")).toBeUndefined();
    expect(anonymousUrlOf("C:\\git\\shop.git")).toBeUndefined();
    expect(anonymousUrlOf("file:///srv/git/shop.git")).toBeUndefined();
    expect(await probeExposure(remote, { cwd: base })).toBe("private");
  });
});
