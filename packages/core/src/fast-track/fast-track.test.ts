import { gitBlobId, toBase64url, utf8 } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode, FAST_TRACK_EVENT_TYPES, type PhaseId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { mergeNotReadyKey } from "../checkpoints/resolution-rules.js";
import type { CiCheck, CiReader, CiReading, CiRepository } from "../ci/ci-reader.js";
import { mergeGate } from "../ci/ci-rules.js";
import {
  type AgentStateView,
  type BranchPushOutcome,
  type CheckpointState,
  type CommandContext,
  type CommitHookInstall,
  createCommandRegistry,
  type ForgeCliState,
  type ForgeInspection,
  type ForgePullRequest,
  type ForgeRemote,
  type ForgeRepository,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type PullRequestDraft,
  type RecordedEvent,
  resolveProfile,
  type StoryForge,
  type StoryWorkspace,
  type StoryWorkspaceCreation,
  type StoryWorkspaceInspection,
  type StoryWorkspaceTarget,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { StoryDiff } from "../review/review-diff.js";
import { parseDiff } from "../review/review-rules.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";
import {
  announcedFiles,
  dependencyPath,
  fastTrackHold,
  fastTrackVerdict,
  interfacePath,
  migrationPath,
  renamedPaths,
} from "./fast-track-rules.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(7));
const MAIN_COMMIT = "c".repeat(40);
const HEAD = "d".repeat(40);
const MOVED = "e".repeat(40);

/** A Git repository in memory, enough for `start_story`. */
class FakeWorkspace implements StoryWorkspace {
  readonly branches = new Map<string, { commit: string; merged: boolean; storyBlob: null }>();
  readonly worktrees = new Map<string, string>();
  readonly blobs = new Map<string, string>();
  readonly texts = new Map<string, string>();

  async inspect(target: StoryWorkspaceTarget): Promise<StoryWorkspaceInspection> {
    const path = `/repos/shop.worktrees/${target.id}`;
    const holder = this.worktrees.get(target.branch);
    return {
      repository: true,
      prefix: "",
      main: { ref: "origin/main", commit: MAIN_COMMIT },
      storyBlob: this.blobs.get(target.path) ?? null,
      branch: this.branches.get(target.branch) ?? null,
      checkedOut: holder === undefined ? null : { path: holder, atTarget: holder === path },
      target: { path, relative: `../shop.worktrees/${target.id}`, exists: holder === path },
    };
  }

  async create(target: StoryWorkspaceTarget, base: string): Promise<StoryWorkspaceCreation> {
    const path = `/repos/shop.worktrees/${target.id}`;
    const createdBranch = !this.branches.has(target.branch);
    if (createdBranch) {
      this.branches.set(target.branch, { commit: base, merged: true, storyBlob: null });
    }
    const createdWorktree = !this.worktrees.has(target.branch);
    this.worktrees.set(target.branch, path);
    return { worktree: path, createdBranch, createdWorktree };
  }

  async discard() {
    return true;
  }

  async readBlob(blob: string) {
    return this.texts.get(blob);
  }

  /** The story files of a branch: none known here, the intent never checked. */
  async storyFilesOn() {
    return undefined;
  }

  async installCommitHook(): Promise<CommitHookInstall> {
    return { status: "installed", path: "/repos/shop/.git/hooks/commit-msg" };
  }
}

type Stored = { -readonly [K in keyof ForgePullRequest]: ForgePullRequest[K] };

/** A forge in memory: never the network, never a real `gh` or `glab`. */
class FakeForge implements StoryForge {
  remotes: ForgeRemote[] = [
    { name: "origin", url: "https://ada:s3cret@github.com/ada/shop.git" },
    { name: "fork", url: "git@github.com:ada-fork/shop.git" },
  ];
  readonly heads = new Map<string, string>();
  /** Own commits by branch; by default 2 when the head is not the base, else 0. */
  readonly commits = new Map<string, number | null>();
  prefix = "";
  repository = true;
  cliState: ForgeCliState = "ready";
  pushOutcome: BranchPushOutcome = { ok: true };
  readonly pushes: Array<{ remote: string; branch: string; base: string }> = [];
  readonly pullRequestsByBranch = new Map<string, Stored[]>();
  readonly created: PullRequestDraft[] = [];
  readonly updated: Array<{ number: number; draft: PullRequestDraft }> = [];
  readonly repositories: ForgeRepository[] = [];
  failure: string | undefined;
  /** The address `create` answers with; the repository's own by default. */
  createdUrl: ((number: number) => string) | undefined;

  async inspect(branch: string, base: string): Promise<ForgeInspection> {
    if (!this.repository) return { repository: false };
    const head = this.heads.get(branch) ?? null;
    const commits = this.commits.has(branch)
      ? (this.commits.get(branch) ?? null)
      : head === null || head === base
        ? 0
        : 2;
    return { repository: true, prefix: this.prefix, remotes: this.remotes, head, commits };
  }

  async cli(repository: ForgeRepository): Promise<ForgeCliState> {
    this.repositories.push(repository);
    return this.cliState;
  }

  async push(remote: string, branch: string, base: string): Promise<BranchPushOutcome> {
    this.pushes.push({ remote, branch, base });
    return this.pushOutcome;
  }

  async pullRequests(_repository: ForgeRepository, branch: string) {
    if (this.failure !== undefined) throw new Error(this.failure);
    return (this.pullRequestsByBranch.get(branch) ?? []).map((entry) => ({ ...entry }));
  }

  async create(repository: ForgeRepository, draft: PullRequestDraft) {
    this.created.push(draft);
    const list = this.pullRequestsByBranch.get(draft.branch) ?? [];
    const number = 40 + this.created.length;
    const url =
      this.createdUrl?.(number) ?? `https://${repository.host}/${repository.path}/pull/${number}`;
    list.push({ number, url, state: "open", title: draft.title, body: draft.body });
    this.pullRequestsByBranch.set(draft.branch, list);
    return { number, url };
  }

  async update(_repository: ForgeRepository, number: number, draft: PullRequestDraft) {
    this.updated.push({ number, draft });
    for (const entry of this.pullRequestsByBranch.get(draft.branch) ?? []) {
      if (entry.number === number) {
        entry.title = draft.title;
        entry.body = draft.body;
      }
    }
  }

  /** The text the forge holds for the branch's pull request `number`. */
  body(number: number, branch = "feat/1-1-work"): string {
    return (
      this.pullRequestsByBranch.get(branch)?.find((entry) => entry.number === number)?.body ?? ""
    );
  }
}

function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

/** A story `docs check` accepts, with two acceptance criteria in a list. */
function storyFile(id: string, owner: string, title: string) {
  return [
    "---",
    `id: ${id}`,
    "kind: story",
    `owner: ${owner}`,
    `title: ${title}`,
    "epic: epic-1",
    "reviewer: quentin",
    "requirements: [EF-1, EF-2]",
    "budget_usd: 2",
    `branch: feat/${id}-work`,
    "depends_on: []",
    "---",
    `# ${title}`,
    "",
    "## Context",
    "",
    "Accounts.",
    "",
    "## Intent",
    "",
    `Ada can do ${id}.`,
    "",
    "## Acceptance criteria",
    "",
    "- Given Ada, when she signs up,",
    "  then her account exists.",
    "- [ ] Given a taken email, when she signs up, then she sees why.",
    "",
    "## Out of scope",
    "",
    "Nothing else.",
    "",
  ].join("\n");
}

/** The diffs by commit: what Git would give for the story's branch. */
class FakeDiff implements StoryDiff {
  readonly diffs = new Map<string, string | undefined>();
  readonly calls: string[] = [];
  async diff(_base: string, head: string): Promise<string | undefined> {
    this.calls.push(head);
    return this.diffs.get(head);
  }
}

/** A unified diff that touches (modifies) each of the paths, or renames the `from => to` pairs. */
function diffOf(paths: readonly string[], renames: ReadonlyArray<readonly [string, string]> = []) {
  const modified = paths.map(
    (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`,
  );
  const renamed = renames.map(
    ([from, to]) =>
      `diff --git a/${from} b/${to}\nsimilarity index 100%\nrename from ${from}\nrename to ${to}\n`,
  );
  return [...modified, ...renamed].join("");
}

class FakeCiReader implements CiReader {
  repo: CiRepository | null = {
    forge: "github",
    prefix: "",
    main: "main",
    ci: [".github/workflows/ci.yml"],
  };
  commit: string = HEAD;
  checks: CiCheck[] = [{ name: "build", state: "pass" }];
  async repository() {
    return this.repo;
  }
  async read(): Promise<CiReading> {
    return { ok: true, checks: this.checks, commit: this.commit, pr: 41 };
  }
}

const path = (name: string) => `.agentplugged/stories/${name}.md`;
const EXIT = "story.fast_track_left";
const DECLARED = { single_reading: true, reversible: true, no_public_interface: true };
const ENTRY = { summary: "The empty name is refused", declared: DECLARED };

const STORIES = [
  ["1-1-sign-up", "1-1", "sam", "Sign up"],
  ["1-2-profile", "1-2", "sam", "Profile"],
  ["1-3-search", "1-3", "ethan", "Search"],
] as const;

/** A product in the build phase, its stories validated, nothing started yet. */
async function product() {
  const files = new MemoryFiles();
  let clock = Date.UTC(2026, 9, 4, 12, 0, 0);
  const now = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now });
  const workspace = new FakeWorkspace();
  const forge = new FakeForge();
  const diff = new FakeDiff();
  const reader = new FakeCiReader();
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("izzy", "Izzy", "product", "build"),
      ...shippedAgent("sam", "Sam", "code", "build"),
      ...shippedAgent("ethan", "Ethan", "code", "build"),
      ...shippedAgent("quentin", "Quentin", "quality", "build"),
    }),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    keys,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
    storyWorkspace: workspace,
    storyForge: forge,
    storyDiff: diff,
    ciReader: reader,
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
    return result.value as RecordedEvent;
  };
  const answer = async (checkpoint: string | undefined, extra: Record<string, unknown> = {}) =>
    registry.run("review", human, {
      action: "resolve",
      checkpoint,
      decision: "approved",
      ...extra,
    });
  const closers: Partial<Record<PhaseId, string>> = {
    framing: "iris",
    planning: "main",
    design: "main",
  };
  for (const phase of ["framing", "planning", "design"] as const) {
    const opened = await run("open_checkpoint", {
      agent: closers[phase],
      type: "phase_end",
      phase,
      risk: "low",
      title: `End of ${phase}`,
      summary: "Ready.",
    });
    const answered = await answer(opened.checkpoint);
    if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
  }
  files.seed(
    ".agentplugged/docs/prd.md",
    "---\nid: prd\nkind: prd\nowner: maya\n---\n# PRD\n\nEF-1 : Ada signs up.\n\nEF-2 : Ada sees why.\n",
  );
  files.seed(
    ".agentplugged/epics/epic-1.md",
    "---\nid: epic-1\nkind: epic\nowner: izzy\n---\n# Epic 1\n",
  );
  const documents = [];
  for (const [name, id, owner, title] of STORIES) {
    const text = storyFile(id, owner, title);
    files.seed(path(name), text);
    const blob = gitBlobId(utf8(text));
    workspace.blobs.set(path(name), blob);
    workspace.texts.set(blob, text);
    documents.push({ path: path(name), branch: "main", blob_sha: blob });
  }
  const validated = await run("open_checkpoint", {
    agent: "izzy",
    type: "document",
    risk: "medium",
    title: "Epic 1",
    summary: "The stories.",
    documents,
  });
  const approved = await answer(validated.checkpoint);
  if (!approved.ok) throw new Error(`review failed: ${approved.error.code}`);
  const state = async () => {
    const result = await call("get_state", { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  /** Starts a story; the branch of the fakes sits at HEAD from then on. */
  const start = async (story: string, extra: Record<string, unknown> = {}, who = "sam") => {
    forge.heads.set(`feat/${story}-work`, HEAD);
    const started = await call("start_story", { agent: who, story, ...extra });
    const branch = workspace.branches.get(`feat/${story}-work`);
    if (started.ok && branch !== undefined) branch.commit = HEAD;
    return started;
  };
  const deliver = (story = "1-1", who = "sam") =>
    call("open_pull_request", {
      agent: who,
      story,
      criteria: [true, false],
      tests: { status: "passed", summary: "12 tests pass." },
    });
  const readCi = (story = "1-1") => call("check_ci", { agent: "sam", story });
  return {
    files,
    journal,
    workspace,
    forge,
    diff,
    reader,
    agent,
    call,
    run,
    answer,
    state,
    start,
    deliver,
    readCi,
  };
}

const types = (journal: MemoryStateStore, type: string) =>
  journal.events.filter((event) => event.type === type);
const reasonOf = (result: { ok: boolean; error?: { details?: Record<string, unknown> } }) =>
  result.ok ? undefined : result.error?.details?.reason;
const track = async (state: () => Promise<AgentStateView>, story = "1-1") =>
  (await state()).stories[story]?.fast_track;

describe("the rules of a small change", () => {
  const verdict = (paths: string[], renames: Array<[string, string]> = []) =>
    fastTrackVerdict(parseDiff(diffOf(paths, renames)));

  it("accepts fewer than 5 files and refuses 5 exactly", () => {
    expect(verdict(["a.ts", "b.ts", "c.ts", "d.ts"])).toMatchObject({
      count: 4,
      ok: true,
      reasons: [],
    });
    expect(verdict(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"])).toMatchObject({
      count: 5,
      ok: false,
      reasons: ["too_many_files"],
    });
    expect(verdict([])).toMatchObject({ count: 0, ok: true });
  });

  it("counts tests like any other file", () => {
    expect(
      verdict(["src/a.ts", "src/b.ts", "src/c.ts", "src/a.test.ts", "src/b.test.ts"]),
    ).toMatchObject({ count: 5, ok: false });
  });

  it("counts both paths of a renamed file, and classifies each", () => {
    expect(verdict(["a.ts", "b.ts", "c.ts"], [["old.ts", "new.ts"]])).toMatchObject({
      count: 5,
      ok: false,
      reasons: ["too_many_files"],
    });
    expect(verdict([], [["db/migrations/001.txt", "docs/notes.txt"]])).toMatchObject({
      count: 2,
      reasons: ["migration"],
    });
  });

  it("refuses a dependency manifest or lockfile, whatever the ecosystem and the folder", () => {
    for (const file of [
      "package.json",
      "apps/web/package.json",
      "pnpm-lock.yaml",
      "Cargo.toml",
      "go.mod",
      "requirements-dev.txt",
      "src/App.csproj",
      "Gemfile.lock",
      "pyproject.toml",
      "gradle/libs.versions.toml",
      "PACKAGE.JSON",
    ]) {
      expect(dependencyPath(file), file).toBe(true);
      expect(verdict([file]).reasons, file).toEqual(["dependency_manifest"]);
    }
    expect(dependencyPath("src/package.ts")).toBe(false);
    expect(dependencyPath("docs/requirements.md")).toBe(false);
  });

  it("refuses a migration or a schema file", () => {
    for (const file of [
      "db/migrations/0001_users.py",
      "supabase/migrations/20260101.sql",
      "src/Migrations/Init.cs",
      "prisma/schema.prisma",
      "db/schema.rb",
      "scripts/seed.sql",
      "src/20260101-migrate-users.ts",
    ]) {
      expect(migrationPath(file), file).toBe(true);
    }
    expect(migrationPath("src/migrator-ui.ts")).toBe(false);
    expect(migrationPath("src/transmigration.ts")).toBe(false);
  });

  it("refuses a file of an interface's contract", () => {
    for (const file of [
      "openapi.yaml",
      "docs/swagger.json",
      "api/user.proto",
      "schema.graphql",
      "types/index.d.ts",
    ]) {
      expect(interfacePath(file), file).toBe(true);
    }
    expect(interfacePath("src/index.ts")).toBe(false);
    expect(interfacePath("src/openapi-client.ts")).toBe(false);
  });

  it("catches the usual hiding places of a dependency, a contract or a submodule", () => {
    for (const file of [
      "requirements/base.txt",
      "requirements.in",
      "Dockerfile",
      "docker/app.Dockerfile",
      ".gitmodules",
      "Chart.yaml",
    ]) {
      expect(dependencyPath(file), file).toBe(true);
    }
    for (const file of ["foo.openapi.yaml", "docs/openapi/v1.yaml", "petstore.swagger.json"]) {
      expect(interfacePath(file), file).toBe(true);
    }
  });

  it("reads a pure rename from its rename lines, even when its header splits two ways", () => {
    const text =
      "diff --git a/x b/package.json b/y.txt\nsimilarity index 100%\nrename from x b/package.json\nrename to y.txt\n";
    expect(renamedPaths(text)).toEqual(["x b/package.json", "y.txt"]);
    expect(announcedFiles(text)).toBe(1);
    expect(fastTrackVerdict(parseDiff(text), renamedPaths(text)).reasons).toEqual([
      "dependency_manifest",
    ]);
  });

  it("gives every reason that applies, in a stable order, with a complete count", () => {
    const result = verdict(["package.json", "db/migrations/1.sql", "openapi.yaml", "a.ts", "b.ts"]);
    expect(result.reasons).toEqual([
      "too_many_files",
      "dependency_manifest",
      "migration",
      "interface_contract",
    ]);
    const many = verdict(Array.from({ length: 150 }, (_, index) => `src/f${index}.ts`));
    expect(many).toMatchObject({ count: 150, truncated: true });
    expect(many.files).toHaveLength(100);
  });

  it("lists only the paths a payload can hold, and still counts the others", () => {
    const text = [
      "diff --git a/ok.ts b/ok.ts\n--- a/ok.ts\n+++ b/ok.ts\n@@ -1 +1 @@\n-a\n+b\n",
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -1 +1 @@\n-a\n+b\n',
    ].join("");
    const result = fastTrackVerdict(parseDiff(text));
    expect(result.count).toBe(2);
    expect(result.files).toEqual(["ok.ts"]);
    expect(result.truncated).toBe(true);
  });
});

describe("the merge gate and the fast track", () => {
  const checkpoint = (status: string, resolution?: { decision: string; option?: string }) =>
    ({
      id: "G-1",
      story: "1-1",
      source: "fast_track",
      status,
      resolution: resolution === undefined ? null : { option: null, ...resolution },
    }) as never;
  const story = (
    fast_track: object,
    ci: object = { commit: HEAD, status: "pass", at: "2026-10-04T12:00:00Z" },
  ) => ({ ci, fast_track }) as never;
  const active = (checked?: object) => ({ status: "active", checked });

  it("holds nothing back for a story of the full lane", () => {
    expect(fastTrackHold({} as never, [], "1-1")).toBeUndefined();
  });

  it("wants the commit the CI covers read as a small change", () => {
    expect(fastTrackHold(story(active()), [], "1-1")).toBe("unverified");
    expect(fastTrackHold(story(active({ commit: HEAD, ok: false })), [], "1-1")).toBe("exceeded");
    expect(fastTrackHold(story(active({ commit: MOVED, ok: true })), [], "1-1")).toBe("unverified");
    expect(fastTrackHold(story(active({ commit: HEAD, ok: true })), [], "1-1")).toBeUndefined();
    // The branch's head, when read, is the commit that was read.
    expect(fastTrackHold(story(active({ commit: HEAD, ok: true })), [], "1-1", MOVED)).toBe(
      "unverified",
    );
    expect(
      fastTrackHold(story(active({ commit: HEAD, ok: true })), [], "1-1", HEAD),
    ).toBeUndefined();
    // No CI read at all.
    expect(
      fastTrackHold({ fast_track: active({ commit: HEAD, ok: true }) } as never, [], "1-1"),
    ).toBe("unverified");
  });

  it("waits for the creator after the way back, and for the full lane to be chosen", () => {
    const left = story({ status: "left" });
    expect(fastTrackHold(left, [], "1-1")).toBe("stopped");
    expect(fastTrackHold(left, [checkpoint("open")], "1-1")).toBe("left_open");
    expect(fastTrackHold(left, [checkpoint("waived")], "1-1")).toBe("left_open");
    expect(
      fastTrackHold(
        left,
        [checkpoint("resolved", { decision: "option_chosen", option: "stop" })],
        "1-1",
      ),
    ).toBe("stopped");
    expect(fastTrackHold(left, [checkpoint("resolved", { decision: "rejected" })], "1-1")).toBe(
      "stopped",
    );
    expect(
      fastTrackHold(
        left,
        [checkpoint("resolved", { decision: "option_chosen", option: "full_lane" })],
        "1-1",
      ),
    ).toBeUndefined();
    // Another story's checkpoint says nothing about this one.
    expect(
      fastTrackHold(left, [{ ...(checkpoint("open") as object), story: "1-2" } as never], "1-1"),
    ).toBe("stopped");
  });

  it("never lets a later answer undo a stop", () => {
    const left = story({ status: "left" });
    const stop = checkpoint("resolved", { decision: "option_chosen", option: "stop" });
    const go = checkpoint("resolved", { decision: "option_chosen", option: "full_lane" });
    expect(fastTrackHold(left, [stop, go], "1-1")).toBe("stopped");
    expect(fastTrackHold(left, [go, stop], "1-1")).toBe("stopped");
    expect(fastTrackHold(left, [go, go], "1-1")).toBeUndefined();
  });

  it("names the message of each hold", () => {
    expect(mergeNotReadyKey(undefined)).toBe("error.merge_not_ready");
    for (const hold of ["unverified", "exceeded", "left_open", "stopped"]) {
      expect(mergeNotReadyKey(hold)).toBe(`error.merge_not_ready.${hold}`);
    }
  });

  it("closes the gate of a fast-track story until the engine has read its commit", () => {
    const state = (fast: object) => ({ stories: { "1-1": story(fast) }, checkpoints: {} });
    expect(mergeGate(state(active()), "1-1").fast_track).toBe("unverified");
    expect(mergeGate(state(active()), "1-1").ready).toBe(false);
    expect(mergeGate(state(active({ commit: HEAD, ok: true })), "1-1").fast_track).toBeUndefined();
  });
});

describe("the fast track of a story", () => {
  it("is entered when the developer starts the story, in the same write", async () => {
    const { start, state, journal } = await product();
    const started = await start("1-1", { fast_track: ENTRY });
    expect(started).toMatchObject({ ok: true, value: { status: "started", track: "fast" } });
    const [entered] = types(journal, FAST_TRACK_EVENT_TYPES.entered);
    expect(entered).toMatchObject({
      story: "1-1",
      actor: { kind: "agent", agent: "sam" },
      payload: { agent: "sam", summary: ENTRY.summary, declared: DECLARED },
    });
    // The write that started it: started, then entered, chained.
    const startedAt = journal.events.findIndex((event) => event.type === "story.started");
    expect(journal.events[startedAt + 1]?.id).toBe(entered?.id);
    expect(await track(state)).toMatchObject({
      status: "active",
      agent: "sam",
      summary: ENTRY.summary,
      declared: DECLARED,
    });
    expect((await state()).stories["1-1"]?.status).toBe("in_progress");
  });

  it("is the full lane without it, and the mode is not an agent", async () => {
    const { start, state, journal } = await product();
    const started = await start("1-1");
    expect(started).toMatchObject({ ok: true, value: { track: "full" } });
    expect(types(journal, FAST_TRACK_EVENT_TYPES.entered)).toHaveLength(0);
    expect(await track(state)).toBeUndefined();
  });

  it("is refused with an incomplete declaration, and nothing is created", async () => {
    const { start, journal, workspace } = await product();
    for (const missing of ["single_reading", "reversible", "no_public_interface"]) {
      const refused = await start("1-1", {
        fast_track: { ...ENTRY, declared: { ...DECLARED, [missing]: false } },
      });
      expect(refused).toMatchObject({
        ok: false,
        error: {
          code: ErrorCode.FAST_TRACK_NOT_POSSIBLE,
          details: { reason: "declaration", missing },
        },
      });
    }
    expect(types(journal, "story.started")).toHaveLength(0);
    expect(workspace.worktrees.size).toBe(0);
    expect(workspace.branches.size).toBe(0);
  });

  it("is never entered by a story already started in the full lane", async () => {
    const { start, state } = await product();
    await start("1-1");
    const late = await start("1-1", { fast_track: ENTRY });
    expect(reasonOf(late as never)).toBe("already_started");
    expect(await track(state)).toBeUndefined();
  });

  it("resumes a story already in the fast track, writing nothing more", async () => {
    const { start, journal } = await product();
    await start("1-1", { fast_track: ENTRY });
    const count = journal.events.length;
    const again = await start("1-1", { fast_track: ENTRY });
    expect(again).toMatchObject({ ok: true, value: { status: "resumed", track: "fast" } });
    expect(journal.events.length).toBe(count);
    const plain = await start("1-1");
    expect(plain).toMatchObject({ ok: true, value: { status: "resumed", track: "fast" } });
  });

  it("ignores an entry that is not in the write that started the story, or not by its developer", async () => {
    const { start, state, journal, run } = await product();
    await start("1-2");
    await run("report_progress", { agent: "sam", story: "1-2", percent: 10, note: "begun" });
    const productId = (await journal.productId()) as string;
    const forge = (agent: string, story: string) =>
      journal.appendAll([
        {
          type: FAST_TRACK_EVENT_TYPES.entered,
          actor: { kind: "agent", agent },
          product: productId,
          story,
          provenance: "trusted",
          payload: { agent, summary: "Forged", declared: DECLARED },
        },
      ]);
    await forge("sam", "1-2");
    expect(await track(state, "1-2")).toBeUndefined();
    // Started by Sam, the entry written by Ethan.
    await start("1-1");
    await forge("ethan", "1-1");
    expect(await track(state, "1-1")).toBeUndefined();
  });

  it("is read by the engine at each pull request: a small change stays in the fast track", async () => {
    const { start, deliver, diff, journal, state } = await product();
    await start("1-1", { fast_track: ENTRY });
    diff.diffs.set(HEAD, diffOf(["src/a.ts", "src/a.test.ts", "src/b.ts", "src/b.test.ts"]));
    const opened = await deliver();
    expect(opened).toMatchObject({
      ok: true,
      value: { status: "opened", fast_track: { ok: true, count: 4, left: false } },
    });
    const [checked] = types(journal, FAST_TRACK_EVENT_TYPES.checked);
    expect(checked).toMatchObject({
      payload: { commit: HEAD, count: 4, ok: true, reasons: [] },
    });
    // In the same write as the pull request it follows.
    const prAt = journal.events.findIndex((event) => event.type === "story.pr_opened");
    expect(journal.events[prAt + 1]?.id).toBe(checked?.id);
    expect(await track(state)).toMatchObject({
      status: "active",
      checked: { commit: HEAD, ok: true },
    });
    expect(types(journal, EXIT)).toHaveLength(0);
  });

  it("sends a story with 5 files back to the full lane, with a checkpoint that explains it", async () => {
    const { start, deliver, diff, journal, state } = await product();
    await start("1-1", { fast_track: ENTRY });
    diff.diffs.set(HEAD, diffOf(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]));
    const opened = await deliver();
    expect(opened).toMatchObject({
      ok: true,
      value: { fast_track: { ok: false, count: 5, left: true, reasons: ["too_many_files"] } },
    });
    const view = await state();
    expect(view.stories["1-1"]?.fast_track).toMatchObject({
      status: "left",
      left: { by: "engine", reasons: ["too_many_files"], commit: HEAD },
    });
    expect(view.stories["1-1"]?.status).toBe("blocked");
    const exit = Object.values(view.checkpoints).find((entry) => entry.source === "fast_track");
    expect(exit).toMatchObject({
      type: "decision",
      story: "1-1",
      status: "open",
      recommendation: "full_lane",
      blocks: [
        { action: "story.review", story: "1-1" },
        { action: "story.complete", story: "1-1" },
      ],
    });
    // An open checkpoint is in full in the abridged state: its options are there.
    expect((exit as CheckpointState | undefined)?.options?.map((option) => option.id)).toEqual([
      "full_lane",
      "stop",
    ]);
    expect(exit?.summary).toContain("touches 5 files or more");
    expect(types(journal, "checkpoint.opened")).toHaveLength(
      Object.keys(view.checkpoints).length - 0,
    );
    // The story waits for the creator: its review cannot be asked.
    const again = await deliver();
    expect(again).toMatchObject({ ok: false, error: { code: ErrorCode.CHECKPOINT_OPEN } });
  });

  it("goes on in the full lane once the creator chose it, and never returns to the fast track", async () => {
    const { start, deliver, diff, answer, state, call } = await product();
    await start("1-1", { fast_track: ENTRY });
    diff.diffs.set(HEAD, diffOf(["package.json", "a.ts"]));
    await deliver();
    const view = await state();
    const exit = Object.values(view.checkpoints).find((entry) => entry.source === "fast_track");
    expect(view.stories["1-1"]?.fast_track?.left?.reasons).toEqual(["dependency_manifest"]);
    const chosen = await answer(exit?.id, { decision: "option_chosen", option: "full_lane" });
    expect(chosen.ok).toBe(true);
    // The way back is final: the story is in the full lane, the mode cannot be entered again.
    const left = await call("leave_fast_track", {
      agent: "sam",
      story: "1-1",
      reasons: ["growing_scope"],
      detail: "Again",
    });
    expect(reasonOf(left as never)).toBe("already_left");
    const restart = await call("start_story", { agent: "sam", story: "1-1", fast_track: ENTRY });
    expect(reasonOf(restart as never)).toBe("already_left");
    expect((await state()).stories["1-1"]?.fast_track?.status).toBe("left");
  });

  it("reads a commit added on the way: a dependency added after the pull request", async () => {
    const { start, deliver, diff, readCi, reader, workspace, journal, state } = await product();
    await start("1-1", { fast_track: ENTRY });
    diff.diffs.set(HEAD, diffOf(["a.ts"]));
    await deliver();
    expect((await track(state))?.status).toBe("active");
    // A commit pushed by hand moves the branch; its changes add a dependency.
    reader.commit = MOVED;
    const branch = workspace.branches.get("feat/1-1-work");
    if (branch !== undefined) branch.commit = MOVED;
    diff.diffs.set(MOVED, diffOf(["a.ts", "package.json", "pnpm-lock.yaml"]));
    const read = await readCi();
    expect(read).toMatchObject({
      ok: true,
      value: {
        commit: MOVED,
        fast_track: { ok: false, left: true, reasons: ["dependency_manifest"] },
      },
    });
    expect(types(journal, EXIT)).toHaveLength(1);
    expect((await track(state))?.status).toBe("left");
  });

  it("verifies at the CI read the commit the CI covers, once", async () => {
    const { start, deliver, diff, readCi, journal } = await product();
    await start("1-1", { fast_track: ENTRY });
    diff.diffs.set(HEAD, diffOf(["a.ts"]));
    await deliver();
    // Same commit as the pull request's: already read, not read again.
    const calls = diff.calls.length;
    const read = await readCi();
    expect(read).toMatchObject({ ok: true });
    expect((read as { value: { fast_track?: unknown } }).value.fast_track).toBeUndefined();
    expect(diff.calls.length).toBe(calls);
    expect(types(journal, FAST_TRACK_EVENT_TYPES.checked)).toHaveLength(1);
  });

  it("writes nothing when Git cannot give the diff, and the gate stays closed", async () => {
    const { start, deliver, diff, journal, state, call } = await product();
    await start("1-1", { fast_track: ENTRY });
    diff.diffs.set(HEAD, undefined);
    const opened = await deliver();
    expect(opened).toMatchObject({ ok: true });
    expect(types(journal, FAST_TRACK_EVENT_TYPES.checked)).toHaveLength(0);
    const view = await state();
    expect(view.stories["1-1"]?.fast_track).toMatchObject({ status: "active" });
    expect(view.stories["1-1"]?.fast_track?.checked).toBeUndefined();
    // The whole story, read through the `story` option.
    const whole = await call("get_state", { story: "1-1" });
    const detail = whole.ok
      ? (whole.value as { state: StoryState; checkpoints: Record<string, CheckpointState> })
      : undefined;
    expect(
      fastTrackHold(detail?.state, Object.values(detail?.checkpoints ?? {}), "1-1", HEAD),
    ).toBe("unverified");
  });

  it("reads again a pull request that is up to date when no reading was written", async () => {
    const { start, deliver, diff, journal } = await product();
    await start("1-1", { fast_track: ENTRY });
    diff.diffs.set(HEAD, undefined);
    await deliver();
    diff.diffs.set(HEAD, diffOf(["a.ts"]));
    const again = await deliver();
    expect(again).toMatchObject({
      ok: true,
      value: { status: "unchanged", fast_track: { ok: true } },
    });
    expect(types(journal, FAST_TRACK_EVENT_TYPES.checked)).toHaveLength(1);
  });

  it("lets the developer leave, with a checkpoint for the creator and the story blocked", async () => {
    const { start, call, state, journal } = await product();
    await start("1-1", { fast_track: ENTRY });
    const left = await call("leave_fast_track", {
      agent: "sam",
      story: "1-1",
      reasons: ["growing_scope", "new_dependency"],
      detail: "The fix needs a date library",
    });
    expect(left).toMatchObject({ ok: true, value: { type: EXIT } });
    expect(left.ok && left.value).toHaveProperty("checkpoint");
    const view = await state();
    expect(view.stories["1-1"]).toMatchObject({
      status: "blocked",
      fast_track: {
        status: "left",
        left: {
          by: "agent",
          reasons: ["growing_scope", "new_dependency"],
          detail: "The fix needs a date library",
        },
      },
    });
    const exit = Object.values(view.checkpoints).find((entry) => entry.source === "fast_track");
    expect(exit?.summary).toContain("The fix needs a date library");
    expect(exit?.summary).toContain("Its developer found");
    expect(
      types(journal, "checkpoint.opened").filter(
        (e) => (e.payload as { source?: string }).source === "fast_track",
      ),
    ).toHaveLength(1);
    const again = await call("leave_fast_track", {
      agent: "sam",
      story: "1-1",
      reasons: ["growing_scope"],
      detail: "Again",
    });
    expect(reasonOf(again as never)).toBe("already_left");
  });

  it("refuses to leave for another agent, for a story of the full lane, or one not started", async () => {
    const { start, call } = await product();
    const input = { reasons: ["growing_scope"], detail: "Too big" };
    expect(
      reasonOf((await call("leave_fast_track", { agent: "sam", story: "1-1", ...input })) as never),
    ).toBe("not_started");
    expect(
      reasonOf((await call("leave_fast_track", { agent: "sam", story: "9-9", ...input })) as never),
    ).toBe("not_started");
    await start("1-1", { fast_track: ENTRY });
    await start("1-2");
    expect(
      reasonOf(
        (await call("leave_fast_track", { agent: "ethan", story: "1-1", ...input })) as never,
      ),
    ).toBe("not_builder");
    expect(
      reasonOf((await call("leave_fast_track", { agent: "sam", story: "1-2", ...input })) as never),
    ).toBe("not_fast_track");
    // The engine's own reasons are not the developer's to give.
    const wrong = await call("leave_fast_track", {
      agent: "sam",
      story: "1-1",
      reasons: ["too_many_files"],
      detail: "x",
    });
    expect(wrong).toMatchObject({ ok: false, error: { code: ErrorCode.INVALID_ARGUMENTS } });
  });

  it("never reads the changes of a story in the full lane", async () => {
    const { start, deliver, diff, journal } = await product();
    await start("1-1");
    diff.diffs.set(HEAD, diffOf(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]));
    const opened = await deliver();
    expect(opened).toMatchObject({ ok: true });
    expect(diff.calls).toHaveLength(0);
    expect(types(journal, FAST_TRACK_EVENT_TYPES.checked)).toHaveLength(0);
  });

  it("reads nothing from a diff it cannot read whole", async () => {
    const { start, deliver, diff, journal } = await product();
    await start("1-1", { fast_track: ENTRY });
    for (const text of [
      "",
      "garbage that is not a diff\n",
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git weird\n",
    ]) {
      diff.diffs.set(HEAD, text);
      await deliver();
    }
    expect(types(journal, FAST_TRACK_EVENT_TYPES.checked)).toHaveLength(0);
  });

  it("shows a story back in the full lane on its blocked step", async () => {
    const { start, call, state } = await product();
    await start("1-1", { fast_track: ENTRY });
    await call("leave_fast_track", {
      agent: "sam",
      story: "1-1",
      reasons: ["growing_scope"],
      detail: "Too big",
    });
    expect((await state()).stories["1-1"]?.status).toBe("blocked");
    const next = await call("next", {});
    expect(next).toMatchObject({
      ok: true,
      value: { fast_track: { status: "left", left_by: "agent", reasons: ["growing_scope"] } },
    });
  });

  it("leaves a stopped story aside: it neither holds up next nor counts as building", async () => {
    const { start, call, answer, state } = await product();
    await start("1-1", { fast_track: ENTRY });
    await call("leave_fast_track", {
      agent: "sam",
      story: "1-1",
      reasons: ["growing_scope"],
      detail: "Too big",
    });
    const exit = Object.values((await state()).checkpoints).find((c) => c.source === "fast_track");
    await answer(exit?.id, { decision: "option_chosen", option: "stop" });
    const next = await call("next", {});
    expect(next).toMatchObject({ ok: true });
    expect((next as { value: { step: string } }).value.step).not.toBe("story_blocked");
  });

  it("is shown by next on the story's steps", async () => {
    const { start, call } = await product();
    await start("1-1", { fast_track: ENTRY });
    const next = await call("next", {});
    expect(next).toMatchObject({
      ok: true,
      value: { story: "1-1", fast_track: { status: "active" } },
    });
  });
});
