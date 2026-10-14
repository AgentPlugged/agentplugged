import { gitBlobId, sha256Hex, toBase64url, utf8 } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode, type EventEnvelope, type PhaseId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { parseDocumentFile } from "../docs/parse-document.js";
import {
  type AgentStateView,
  type BranchPushOutcome,
  type CommandContext,
  type CommitHookInstall,
  createCommandRegistry,
  type ForgeCliState,
  type ForgeInspection,
  type ForgePullRequest,
  type ForgeRemote,
  type ForgeRepository,
  initCommand,
  type MainBranchReader,
  MemoryKeyStore,
  MemoryStateStore,
  type PullRequestDraft,
  type RecordedEvent,
  resolveProfile,
  type StoryForge,
  type StoryPullRequestResult,
  type StoryWorkspace,
  type StoryWorkspaceCreation,
  type StoryWorkspaceInspection,
  type StoryWorkspaceTarget,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { emptyDraft } from "../projection/reducers.js";
import { STORY_REDUCERS } from "../projection/story-reducers.js";
import { cursorDenyRules, denyRules } from "../sync/permissions.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";
import { deliveryRemote, oneLine, targetBranch } from "./pull-request.js";
import {
  acceptanceCriteria,
  PULL_REQUEST_MARKER,
  renderPullRequestBody,
  withoutCost,
} from "./pull-request-body.js";
import {
  forgeOfHost,
  forgeRepositoryOf,
  isRepositoryPullRequest,
  remoteLocation,
} from "./story-forge.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(7));
const MAIN_COMMIT = "c".repeat(40);
const HEAD = "d".repeat(40);

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

const STORIES = [
  ["1-1-sign-up", "1-1", "sam", "Sign up"],
  ["1-3-profile", "1-3", "ethan", "Profile"],
] as const;

const path = (name: string) => `.agentplugged/stories/${name}.md`;

/** The main branch's `method.yaml`, as `sync` and `rules` read it: here only `pr`. */
const mainWith = (text: string): MainBranchReader => ({
  read: async () => ({ found: true, branch: "origin/main", text }),
});

/** A product in the build phase, its stories validated, 1-1 started by Sam with a commit. */
async function product(options: { mainBranch?: MainBranchReader } = {}) {
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
  const answer = async (checkpoint: string | undefined) => {
    const answered = await registry.run("review", human, {
      action: "resolve",
      checkpoint,
      decision: "approved",
    });
    if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
  };
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
    await answer(opened.checkpoint);
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
  await answer(validated.checkpoint);
  const started = await call("start_story", { agent: "sam", story: "1-1" });
  if (!started.ok) throw new Error(`start_story failed: ${started.error.code}`);
  forge.heads.set("feat/1-1-work", HEAD);
  // The main branch's settings, read from now on (the rules and `pr`).
  const withMain: CommandContext =
    options.mainBranch === undefined ? agent : { ...agent, mainBranch: options.mainBranch };
  const reader: CommandContext =
    options.mainBranch === undefined
      ? { ...human, human: undefined }
      : { ...human, human: undefined, mainBranch: options.mainBranch };
  const state = async () => {
    const result = await call("get_state", { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  const deliver = (input: Record<string, unknown> = {}, context: CommandContext = withMain) =>
    registry.run("open_pull_request", context, {
      agent: "sam",
      story: "1-1",
      criteria: [true, false],
      tests: { status: "passed", summary: "12 tests pass." },
      ...input,
    });
  const cli = (story = "1-1") => registry.run("story", reader, { action: "pr", story });
  return {
    files,
    journal,
    workspace,
    forge,
    agent: withMain,
    call,
    run,
    answer,
    state,
    deliver,
    cli,
  };
}

const resultOf = (result: { ok: boolean; value?: unknown }) =>
  result.ok ? (result.value as StoryPullRequestResult) : undefined;
const errorOf = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? undefined : result.error;
const reasonOf = (result: { ok: boolean; error?: { details?: Record<string, unknown> } }) =>
  result.ok ? undefined : result.error?.details?.reason;
const prEvents = (journal: MemoryStateStore) =>
  journal.events.filter((event) => event.type === "story.pr_opened");

describe("open_pull_request and story pr", () => {
  it("pushes the story's branch, opens the pull request with the fixed template, no cost", async () => {
    const { journal, forge, deliver, state } = await product();
    const opened = resultOf(await deliver());
    expect(opened).toMatchObject({
      status: "opened",
      story: "1-1",
      forge: "github",
      number: 41,
      url: "https://github.com/ada/shop/pull/41",
      branch: "feat/1-1-work",
      base: "main",
      head: HEAD,
      title: "Sign up (1-1)",
      criteria: { checked: 1, total: 2 },
      tests: "passed",
    });
    expect(opened).not.toHaveProperty("cost");
    // The story's branch only, to the remote the main branch was read from; never main.
    expect(forge.pushes).toEqual([{ remote: "origin", branch: "feat/1-1-work", base: "main" }]);
    expect(forge.repositories.at(-1)).toEqual({
      forge: "github",
      host: "github.com",
      path: "ada/shop",
    });
    const draft = forge.created[0];
    expect(draft).toMatchObject({ base: "main", branch: "feat/1-1-work", title: "Sign up (1-1)" });
    const body = draft?.body ?? "";
    expect(body.startsWith(PULL_REQUEST_MARKER)).toBe(true);
    for (const line of [
      "**1-1 — Sign up**",
      `- Story: [.agentplugged/stories/1-1-sign-up.md](https://github.com/ada/shop/blob/${HEAD}/.agentplugged/stories/1-1-sign-up.md)`,
      "- EF-1",
      "- EF-2",
      "- [x] Given Ada, when she signs up, then her account exists.",
      "- [ ] Given a taken email, when she signs up, then she sees why.",
      "**Passed**: 12 tests pass.",
    ]) {
      expect(body).toContain(line);
    }
    expect(body).not.toContain("Budget");
    expect(body).not.toContain("## Cost");
    expect(body).not.toContain("s3cret");
    const event = journal.events.at(-1);
    expect(event).toMatchObject({
      id: opened?.event?.id,
      type: "story.pr_opened",
      story: "1-1",
      actor: { kind: "agent", agent: "sam" },
      payload: {
        forge: "github",
        number: 41,
        action: "opened",
        branch: "feat/1-1-work",
        base: "main",
        head: HEAD,
        criteria: [true, false],
        tests: "passed",
        tests_summary: "12 tests pass.",
      },
    });
    // The digest ignores the cost section older pull requests carry.
    expect((event?.payload as { body_sha256?: string } | undefined)?.body_sha256).toBe(
      sha256Hex(`Sign up (1-1)\n${withoutCost(body)}`),
    );
    const story = (await state()).stories["1-1"];
    expect(story?.pull_request).toMatchObject({ number: 41, by: "sam", tests: "passed" });
    // Opening a pull request does not change the story's status.
    expect(story?.status).toBe("in_progress");
  });

  it("commits no notice when the story changes code no page describes", async () => {
    const { files, forge, workspace, deliver, agent } = await product();
    const PAGE = ".agentplugged/docs/reference/billing.md";
    const page =
      "---\nid: kb-billing\nkind: note\nowner: zoe\nlinks: []\ncode:\n  - src/billing/\n---\n# Billing\n\nBody.\n";
    files.seed(PAGE, page);
    // The story's own worktree: a copy apart, the main copy is never touched.
    const worktree = new Map([[PAGE, page]]);
    const commits: Array<{ branch: string; message: string }> = [];
    const AFTER = "e".repeat(40);
    (workspace as StoryWorkspace).commitFiles = async (request) => {
      for (const file of request.files) {
        worktree.set(file.path, file.edit(worktree.get(file.path) ?? ""));
      }
      commits.push({ branch: request.branch, message: request.message });
      forge.heads.set(request.branch, AFTER);
      return { ok: true, commit: AFTER };
    };
    const diff = (path: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
    const withDiff = (path: string) =>
      ({ ...agent, storyDiff: { diff: async () => diff(path) } }) as CommandContext;

    // A story that changes code a page does not describe: no commit, the head is the reviewed one.
    const other = resultOf(await deliver({}, withDiff("src/profile.ts")));
    expect(other).toMatchObject({ status: "opened", head: HEAD });
    expect(commits).toEqual([]);
  });

  it("puts the notice in the story's branch when the story changes described code", async () => {
    const { files, forge, workspace, deliver, agent } = await product();
    const PAGE = ".agentplugged/docs/reference/billing.md";
    const page =
      "---\nid: kb-billing\nkind: note\nowner: zoe\nlinks: []\ncode:\n  - src/billing/\n---\n# Billing\n\nBody.\n";
    files.seed(PAGE, page);
    const worktree = new Map([[PAGE, page]]);
    const commits: Array<{ branch: string; message: string }> = [];
    const AFTER = "e".repeat(40);
    (workspace as StoryWorkspace).commitFiles = async (request) => {
      for (const file of request.files) {
        worktree.set(file.path, file.edit(worktree.get(file.path) ?? ""));
      }
      commits.push({ branch: request.branch, message: request.message });
      forge.heads.set(request.branch, AFTER);
      return { ok: true, commit: AFTER };
    };
    const diff =
      "diff --git a/src/billing/tax.ts b/src/billing/tax.ts\n--- a/src/billing/tax.ts\n+++ b/src/billing/tax.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const opened = resultOf(
      await deliver({}, { ...agent, storyDiff: { diff: async () => diff } } as CommandContext),
    );
    // Committed on the story's branch, before the push; the pull request carries the new head.
    expect(commits).toEqual([
      { branch: "feat/1-1-work", message: "Documentation: late notices of the knowledge base" },
    ]);
    expect(opened).toMatchObject({ status: "opened", head: AFTER });
    expect(forge.pushes).toEqual([{ remote: "origin", branch: "feat/1-1-work", base: "main" }]);
    expect(worktree.get(PAGE)).toContain("<!-- agentplugged:late since=");
    expect(worktree.get(PAGE)).toContain("la story 1-1");
    expect(worktree.get(PAGE)).toContain("`src/billing/tax.ts`");
    // The main copy stays exactly as it was: clean.
    expect(files.files.get(PAGE)).toBe(page);
    expect(files.writes.filter((path) => path === PAGE)).toEqual([]);
  });

  it("shows no cost, even when the creator once asked for it and a cost was declared", async () => {
    const { journal, forge, run, deliver } = await product({
      mainBranch: mainWith("pr:\n  show_cost: true\n"),
    });
    await run("report_cost", { agent: "sam", story: "1-1", usd: 1.2, estimated: false });
    const delivered = resultOf(await deliver());
    expect(delivered).not.toHaveProperty("cost");
    expect(delivered).not.toHaveProperty("cost_in_pr");
    expect(forge.body(41)).not.toContain("## Cost");
    expect(forge.body(41)).not.toContain("1.20");
    for (const event of prEvents(journal)) {
      expect(JSON.stringify(event.payload)).not.toMatch(/1\.2/);
    }
  });

  it("compares with the forge's own text, updates the same pull request, and never pushes for nothing", async () => {
    const { journal, forge, deliver, cli, state } = await product();
    await deliver();
    const count = journal.events.length;
    const pushes = forge.pushes.length;
    expect(resultOf(await deliver())).toMatchObject({ status: "unchanged", number: 41 });
    expect(forge.updated).toHaveLength(0);
    expect(forge.pushes.length).toBe(pushes);
    expect(journal.events.length).toBe(count);

    // Someone edited the text on the forge: the fixed text comes back.
    const stored = forge.pullRequestsByBranch.get("feat/1-1-work")?.[0];
    if (stored !== undefined) stored.body = "edited by hand";
    expect(resultOf(await deliver())).toMatchObject({ status: "updated", number: 41 });
    expect(forge.body(41)).toContain(PULL_REQUEST_MARKER);

    // A new commit: the text names it, the pull request is updated, not opened twice.
    forge.heads.set("feat/1-1-work", "e".repeat(40));
    const updated = resultOf(await deliver({ criteria: [true, true] }));
    expect(updated).toMatchObject({ status: "updated", number: 41, criteria: { checked: 2 } });
    expect(forge.created).toHaveLength(1);
    expect(forge.body(41)).toContain("- [x] Given a taken email");
    expect(journal.events.at(-1)).toMatchObject({
      type: "story.pr_opened",
      payload: { action: "updated", head: "e".repeat(40) },
    });

    // Through the CLI, on the same commit: the last report, nothing new.
    const before = journal.events.length;
    expect(resultOf(await cli())).toMatchObject({ status: "unchanged", tests: "passed" });
    expect(journal.events.length).toBe(before);
    // A commit the agent never reported on: unchecked, tests not reported, never « passed ».
    forge.heads.set("feat/1-1-work", "f".repeat(40));
    const viaCli = resultOf(await cli());
    expect(viaCli).toMatchObject({
      status: "updated",
      tests: "not_reported",
      criteria: { checked: 0, total: 2 },
    });
    expect(forge.body(41)).toContain("**Not reported by the agent**");
    expect(journal.events.at(-1)).toMatchObject({
      type: "story.pr_opened",
      actor: { kind: "system" },
      payload: { criteria: [false, false], tests: "not_reported" },
    });
    expect((await state()).stories["1-1"]?.pull_request).toMatchObject({ by: null });
    // Again through the CLI: unchanged, no new event.
    const last = journal.events.length;
    expect(resultOf(await cli())).toMatchObject({ status: "unchanged" });
    expect(journal.events.length).toBe(last);
  });

  it("adopts a pull request opened by hand, prefers the recorded one, ignores forks, refuses a merged one", async () => {
    const { forge, deliver, journal } = await product();
    const pr = (number: number, state: ForgePullRequest["state"], repo = "ada/shop"): Stored => ({
      number,
      url: `https://github.com/${repo}/pull/${number}`,
      state,
      title: "mine",
      body: "",
    });
    forge.pullRequestsByBranch.set("feat/1-1-work", [pr(7, "open")]);
    expect(resultOf(await deliver())).toMatchObject({ status: "updated", number: 7 });
    expect(journal.events.at(-1)).toMatchObject({ payload: { number: 7, action: "updated" } });

    // Two open: the one the journal recorded.
    forge.pullRequestsByBranch.set("feat/1-1-work", [pr(5, "open"), pr(7, "open")]);
    forge.heads.set("feat/1-1-work", "e".repeat(40));
    expect(resultOf(await deliver())).toMatchObject({ number: 7 });

    // A fork's pull request of the same branch name is never the story's.
    forge.pullRequestsByBranch.set("feat/1-1-work", [pr(9, "open", "ada-fork/shop")]);
    expect(resultOf(await deliver())).toMatchObject({ status: "opened", number: 41 });

    forge.pullRequestsByBranch.set("feat/1-1-work", [pr(7, "merged")]);
    const pushes = forge.pushes.length;
    expect(errorOf(await deliver())).toMatchObject({
      code: ErrorCode.PULL_REQUEST_NOT_OPENABLE,
      details: { reason: "already_merged", url: "https://github.com/ada/shop/pull/7" },
    });
    expect(forge.pushes.length).toBe(pushes);

    // Only closed: a new one opens.
    forge.pullRequestsByBranch.set("feat/1-1-work", [pr(7, "closed")]);
    expect(resultOf(await deliver())).toMatchObject({ status: "opened" });

    // A tool that answers with another repository's pull request: refused.
    forge.pullRequestsByBranch.set("feat/1-1-work", []);
    forge.createdUrl = (number) => `https://github.com/mallory/shop/pull/${number}`;
    expect(errorOf(await deliver())).toMatchObject({
      code: ErrorCode.PULL_REQUEST_FAILED,
      details: { reason: "forge_failed" },
    });
  });

  it("says when the pull request exists but was not recorded, then records it on the next call", async () => {
    const { forge, deliver, journal } = await product();
    const append = journal.appendAll.bind(journal);
    journal.appendAll = (async (drafts, options) => {
      if (drafts.some((draft) => draft.type === "story.pr_opened")) throw new Error("disk full");
      return append(drafts, options);
    }) as typeof journal.appendAll;
    expect(errorOf(await deliver())).toMatchObject({
      code: ErrorCode.PULL_REQUEST_FAILED,
      message_key: "error.pull_request_failed.not_recorded",
      details: { reason: "not_recorded", url: "https://github.com/ada/shop/pull/41" },
    });
    journal.appendAll = append;
    expect(resultOf(await deliver())).toMatchObject({ status: "updated", number: 41 });
    expect(forge.created).toHaveLength(1);
    // The forge already held this very text: recorded without touching it.
    expect(forge.updated).toHaveLength(0);
    expect(prEvents(journal)).toHaveLength(1);
  });

  it("refuses what is not ready to deliver, nothing pushed", async () => {
    const { forge, journal, workspace, files, call, deliver, run, answer } = await product();
    const count = journal.events.length;
    const refused = async (result: Promise<unknown>, reason: string) =>
      expect(reasonOf((await result) as { ok: boolean })).toBe(reason);
    await refused(deliver({ story: "9-9" }), "unknown_story");
    await refused(deliver({ story: "1-3", agent: "ethan" }), "not_started");
    expect(errorOf(await deliver({ agent: "ethan" }))).toMatchObject({
      code: ErrorCode.PULL_REQUEST_NOT_OPENABLE,
      message_key: "error.pull_request_not_openable.not_builder",
      details: { story: "1-1", reason: "not_builder", agent: "ethan", builder: "sam" },
    });
    expect(errorOf(await deliver({ criteria: [true] }))).toMatchObject({
      details: { reason: "criteria_count", expected: 2, given: 1 },
    });
    expect(
      errorOf(await deliver({ tests: { status: "failed", summary: "2 fail." } })),
    ).toMatchObject({
      details: { reason: "tests_not_passed", status: "failed" },
    });
    // Own commits counted, not the head compared: a merge of main alone is no work.
    forge.commits.set("feat/1-1-work", 0);
    await refused(deliver(), "no_commits");
    forge.commits.delete("feat/1-1-work");
    forge.heads.delete("feat/1-1-work");
    await refused(deliver(), "branch_missing");
    forge.heads.set("feat/1-1-work", HEAD);
    forge.repository = false;
    expect(errorOf(await deliver())).toMatchObject({ code: ErrorCode.NOT_A_GIT_REPO });
    forge.repository = true;
    // The approved version is not in this clone.
    const texts = new Map(workspace.texts);
    workspace.texts.clear();
    expect(errorOf(await deliver())).toMatchObject({ details: { reason: "unreadable" } });
    for (const [blob, text] of texts) workspace.texts.set(blob, text);
    // The story's file moved: no approval lists its new path.
    const moved = ".agentplugged/stories/1-1-renamed.md";
    files.seed(moved, (await files.readText(path("1-1-sign-up"))) ?? "");
    await files.remove(path("1-1-sign-up"));
    expect(errorOf(await deliver())).toMatchObject({
      details: { reason: "not_validated", path: moved },
    });
    files.seed(path("1-1-sign-up"), (await files.readText(moved)) ?? "");
    await files.remove(moved);
    expect(forge.pushes).toHaveLength(0);
    expect(journal.events.length).toBe(count);

    // The creator's main session may deliver it.
    expect(resultOf(await deliver({ agent: "main" }))).toMatchObject({ status: "opened" });
    forge.heads.set("feat/1-1-work", "e".repeat(40));

    // A blocked result blocks the story's review: no pull request meanwhile.
    const blocked = await run("submit_result", {
      agent: "sam",
      story: "1-1",
      status: "blocked",
      summary: "The email rule is unclear.",
      assumptions: [],
      open_questions: ["Which emails are taken?"],
      conflicts: [],
    });
    const pushes = forge.pushes.length;
    expect(errorOf(await deliver())).toMatchObject({
      code: ErrorCode.CHECKPOINT_OPEN,
      details: { checkpoint: blocked.checkpoint, action: "story.review" },
    });
    expect(forge.pushes.length).toBe(pushes);

    // Its merge checkpoint is never approved while its CI is not green on the branch's head and
    // its review is not done: a started story cannot be done, and
    // its pull request stays open to updates.
    const accepted = await run("open_checkpoint", {
      agent: "sam",
      type: "story",
      risk: "low",
      title: "Story 1-1",
      summary: "Done.",
      story: "1-1",
    });
    await expect(answer(accepted.checkpoint)).rejects.toThrow("MERGE_NOT_READY");
    expect(
      reasonOf(
        await call("open_pull_request", {
          agent: "sam",
          story: "1-1",
          criteria: [true, true],
          tests: { status: "passed", summary: "ok" },
        }),
      ),
    ).not.toBe("done");
  });

  it("leaves one checkpoint when the forge is not linked, reused while open, nothing pushed", async () => {
    const { forge, journal, deliver, cli, state, answer } = await product();
    forge.cliState = "missing";
    // Another call opens the same checkpoint between this call's read and its write: the check
    // under the journal's lock sees it, and this call reuses it.
    const append = journal.appendAll.bind(journal);
    let raced = false;
    journal.appendAll = (async (drafts, options) => {
      const payload = drafts[0]?.payload as { source?: string } | undefined;
      if (
        !raced &&
        drafts[0]?.type === "checkpoint.opened" &&
        payload?.source === "forge_unlinked"
      ) {
        raced = true;
        await append(drafts);
      }
      return append(drafts, options);
    }) as typeof journal.appendAll;
    const first = errorOf(await deliver()) as { code: string; details: Record<string, unknown> };
    journal.appendAll = append;
    const second = errorOf(await deliver()) as { details: Record<string, unknown> };
    expect(raced).toBe(true);
    expect(first).toMatchObject({
      code: ErrorCode.FORGE_NOT_LINKED,
      details: {
        story: "1-1",
        reason: "cli_missing",
        forge: "github",
        host: "github.com",
        cli: "gh",
      },
    });
    const checkpoint = first?.details.checkpoint as string;
    expect(second?.details.checkpoint).toBe(checkpoint);
    const view = await state();
    const linking = Object.values(view.checkpoints).filter(
      (entry) => entry.source === "forge_unlinked",
    );
    expect(linking).toHaveLength(1);
    expect(view.checkpoints[checkpoint]).toMatchObject({
      type: "permission",
      risk: "low",
      story: "1-1",
      source: "forge_unlinked",
      blocks: [],
      status: "open",
    });
    expect(view.checkpoints[checkpoint]?.summary).toContain("gh auth login --hostname github.com");
    expect(view.checkpoints[checkpoint]?.summary).not.toContain("s3cret");
    const count = journal.events.length;
    forge.cliState = "logged_out";
    expect(errorOf(await deliver())).toMatchObject({
      details: { reason: "not_logged_in", checkpoint },
    });
    expect(journal.events.length).toBe(count);
    // Through the CLI the creator reads the message: no checkpoint.
    const viaCli = errorOf(await cli()) as { details: Record<string, unknown> };
    expect(viaCli.details).toMatchObject({ reason: "not_logged_in" });
    expect(viaCli.details.checkpoint).toBeUndefined();
    expect(journal.events.length).toBe(count);
    // Answered: a new refusal opens a new one.
    await answer(checkpoint);
    const again = errorOf(await deliver()) as { details: Record<string, unknown> };
    expect(again.details.checkpoint).not.toBe(checkpoint);

    forge.cliState = "ready";
    // Git pushes to a local folder: never taken for GitHub.
    forge.remotes = [{ name: "origin", url: "C:/backups/shop.git" }];
    expect(errorOf(await deliver())).toMatchObject({
      details: { reason: "unknown_forge", host: "local", remote: "origin" },
    });
    forge.remotes = [{ name: "origin", url: "https://git.example.org/shop.git" }];
    expect(errorOf(await deliver())).toMatchObject({
      details: { reason: "unknown_forge", host: "git.example.org" },
    });
    forge.remotes = [];
    expect(reasonOf(await deliver())).toBe("no_remote");
    expect(forge.pushes).toHaveLength(0);
    expect(forge.created).toHaveLength(0);
  });

  it("delivers to GitLab, and reports a refused push or a failing forge without secrets", async () => {
    const { forge, deliver } = await product();
    forge.remotes = [{ name: "origin", url: "ssh://git@gitlab.com:2222/team/sub/shop.git" }];
    forge.createdUrl = (number) => `https://gitlab.com/team/sub/shop/-/merge_requests/${number}`;
    const opened = resultOf(await deliver());
    expect(opened).toMatchObject({
      forge: "gitlab",
      url: "https://gitlab.com/team/sub/shop/-/merge_requests/41",
    });
    expect(forge.created[0]?.body).toContain(
      `(https://gitlab.com/team/sub/shop/-/blob/${HEAD}/.agentplugged/stories/1-1-sign-up.md)`,
    );

    forge.heads.set("feat/1-1-work", "e".repeat(40));
    forge.pushOutcome = {
      ok: false,
      reason: "push_rejected",
      message: "! [rejected] (fetch first)",
    };
    expect(errorOf(await deliver())).toMatchObject({
      code: ErrorCode.PULL_REQUEST_FAILED,
      details: { reason: "push_rejected", message: "! [rejected] (fetch first)" },
    });
    forge.failure =
      "HTTP 401 from https://ada:token@gitlab.com/api\nAuthorization: Bearer glpat-abcdefgh12345678 ghp_abcdefghijklmnop";
    const failed = errorOf(await deliver()) as { details: { reason: string; message: string } };
    expect(failed.details.reason).toBe("forge_failed");
    expect(failed.details.message).toContain("HTTP 401 from https://gitlab.com/api");
    expect(failed.details.message).not.toMatch(/token@|glpat-|ghp_|Bearer glpat/);
  });

  it("names its path in the repository when the method sits in a folder", async () => {
    const { forge, deliver } = await product();
    forge.prefix = "app/";
    await deliver();
    expect(forge.created[0]?.body).toContain(
      `[app/.agentplugged/stories/1-1-sign-up.md](https://github.com/ada/shop/blob/${HEAD}/app/.agentplugged/stories/1-1-sign-up.md)`,
    );
  });
});

describe("the story.pr_opened reducer", () => {
  const event = (change: Partial<EventEnvelope>): EventEnvelope =>
    ({
      v: 1,
      id: "01JZ0000000000000000000001",
      type: "story.pr_opened",
      at: "2026-10-04T12:00:00.000Z",
      actor: { kind: "agent", agent: "sam", device: "machine:abc" },
      product: "01JZ0000000000000000000000",
      provenance: "trusted",
      story: "1-1",
      payload: {
        forge: "github",
        number: 3,
        url: "https://github.com/ada/shop/pull/3",
        action: "opened",
        branch: "feat/1-1-work",
        base: "main",
        head: HEAD,
        criteria: [true],
        tests: "passed",
        body_sha256: "a".repeat(64),
      },
      ...change,
    }) as unknown as EventEnvelope;

  it("ignores a creator's event and one without a story", () => {
    const reducer = STORY_REDUCERS["story.pr_opened"];
    if (reducer === undefined) throw new Error("no reducer");
    const draft = emptyDraft();
    reducer(
      draft,
      event({
        id: "01JZ0000000000000000000002",
        actor: { kind: "human", device: "human:abc" } as EventEnvelope["actor"],
      }),
    );
    const { story: _story, ...withoutStory } = event({ id: "01JZ0000000000000000000003" });
    reducer(draft, withoutStory as EventEnvelope);
    expect(draft.ignored).toEqual([
      { id: "01JZ0000000000000000000002", reason: "invalid" },
      { id: "01JZ0000000000000000000003", reason: "invalid" },
    ]);
    reducer(draft, event({}));
    expect(
      (draft.state.stories as Record<string, { pull_request?: unknown }>)["1-1"]?.pull_request,
    ).toMatchObject({ number: 3, by: "sam", tests_summary: null });
  });
});

describe("the fixed template, pure", () => {
  it("reads a remote's host and path, never its credentials", () => {
    expect(remoteLocation("https://ada:s3cret@github.com/ada/shop.git")).toEqual({
      host: "github.com",
      path: "ada/shop",
    });
    expect(remoteLocation("git@github.com:ada/shop.git")).toEqual({
      host: "github.com",
      path: "ada/shop",
    });
    expect(remoteLocation("ssh://git@gitlab.example.com:2222/team/shop")).toEqual({
      host: "gitlab.example.com",
      path: "team/shop",
    });
    // A real host with one segment is still a host.
    expect(remoteLocation("https://git.example.org/shop.git")).toEqual({
      host: "git.example.org",
      path: "shop",
    });
    for (const local of ["C:/repos/shop", "C:\\repos\\shop", "/srv/git/shop.git", "../shop"]) {
      expect(remoteLocation(local), local).toBeUndefined();
    }
    expect(forgeOfHost("github.example.com")).toBe("github");
    expect(forgeOfHost("gitlab.com")).toBe("gitlab");
    expect(forgeOfHost("bitbucket.org")).toBeUndefined();
    expect(forgeRepositoryOf("https://bitbucket.org/ada/shop.git")).toEqual({
      host: "bitbucket.org",
    });
    expect(forgeRepositoryOf("https://github.com/shop")).toEqual({ host: "github.com" });
    const repository = { forge: "github" as const, host: "github.com", path: "ada/shop" };
    expect(isRepositoryPullRequest(repository, "https://github.com/ada/shop/pull/4", 4)).toBe(true);
    expect(isRepositoryPullRequest(repository, "https://github.com/eve/shop/pull/4", 4)).toBe(
      false,
    );
    expect(isRepositoryPullRequest(repository, "https://github.com/ada/shop/pull/5", 4)).toBe(
      false,
    );
  });

  it("picks the remote of the main branch, the longest name first, and its name for the target", () => {
    const remotes = [
      { name: "fork", url: "x" },
      { name: "origin", url: "y" },
      { name: "up", url: "z" },
      { name: "up/stream", url: "w" },
    ];
    expect(deliveryRemote(remotes, "up/main")?.name).toBe("up");
    expect(deliveryRemote(remotes, "up/stream/main")?.name).toBe("up/stream");
    expect(targetBranch("up/stream/main", remotes)).toBe("main");
    expect(deliveryRemote(remotes, "main")?.name).toBe("origin");
    expect(deliveryRemote([{ name: "fork", url: "x" }], "main")?.name).toBe("fork");
    expect(
      deliveryRemote(
        [
          { name: "fork", url: "x" },
          { name: "up", url: "z" },
        ],
        "main",
      ),
    ).toBeUndefined();
    expect(targetBranch("up/main", remotes)).toBe("main");
    expect(targetBranch("trunk", remotes)).toBe("trunk");
    // A remote removed since the story started: origin delivers, `main` is the target.
    expect(deliveryRemote(remotes, "upstream/main")?.name).toBe("origin");
    expect(targetBranch("upstream/main", remotes)).toBe("main");
  });

  it("reads acceptance criteria as top-level list items, else paragraphs, never code", () => {
    const parse = (body: string) =>
      acceptanceCriteria(parseDocumentFile("s.md", `---\nid: x\n---\n# X\n\n${body}`));
    expect(
      parse(
        "## Acceptance criteria\n\n1. First,\n   continued.\n2. [x] Second.\n\n```\n- not one\n```\n",
      ),
    ).toEqual(["First, continued.", "Second."]);
    expect(
      parse("## Acceptance criteria\n\n- Given A:\n  - B\n  - C\n\n    more of A\n- Then D.\n"),
    ).toEqual(["Given A: B C more of A", "Then D."]);
    expect(parse("## Critères d'acceptation\n\nGiven A, then B.\n\nGiven C,\nthen D.\n")).toEqual([
      "Given A, then B.",
      "Given C, then D.",
    ]);
    expect(parse("## Intent\n\nNothing.\n")).toEqual([]);
  });

  it("renders the same text every time, with no cost section", () => {
    const content = {
      story: { id: "1-1", title: "Sign up", path: "s.md", blob: "a".repeat(40), requirements: [] },
      repository: { forge: "github" as const, host: "github.com", path: "ada/shop" },
      branch: "feat/1-1-x",
      base: "main",
      head: HEAD,
      criteria: [],
      tests: { status: "not_reported" as const },
    };
    const body = renderPullRequestBody(content);
    expect(renderPullRequestBody(content)).toBe(body);
    expect(body).toContain("**Not reported by the agent**");
    expect(body).toContain("None listed.");
    expect(body).toContain("None found in the story.");
    expect(body).not.toContain("## Cost");
    // A cost section an older pull request carries is left out of the digest.
    const older = `${body}\n## Cost\n\n$0.50 real (1 report).\n`;
    expect(withoutCost(older)).toBe(`${body}\n`);
  });

  it("masks credentials and tokens in messages", () => {
    expect(oneLine("fatal: https://x:y@host/a\n  b")).toBe("fatal: https://host/a b");
    for (const secret of [
      "ghp_abcdefghijklmnop1234",
      "gho_abcdefghijklmnop1234",
      "github_pat_11ABCDEFG0123456789_abcdefghij",
      "glpat-abcdefghij123456",
    ]) {
      expect(oneLine(`refused: ${secret} here`), secret).toBe("refused: *** here");
    }
    expect(oneLine("Authorization: token abcdefghijkl")).not.toContain("abcdefghijkl");
    expect(oneLine("PRIVATE-TOKEN: abcdefghijkl")).not.toContain("abcdefghijkl");
  });

  it("denies the forge's token and the merge by hand to agents, literally (the rest is the constitution's)", () => {
    const inputs = { rootAgentsGenerated: true, claudeMdGenerated: true };
    const claude = denyRules(inputs);
    for (const rule of [
      "Bash(gh pr merge*)",
      "Bash(glab mr merge*)",
      "Bash(gh auth*)",
      "Bash(glab auth*)",
      "Bash(gh config get*)",
      "Bash(glab config get*)",
      "Bash(gh repo delete*)",
      "Bash(glab repo delete*)",
      "Read(~/.config/gh/**)",
      "Read(~/.config/glab-cli/**)",
      "Read(~/AppData/Roaming/GitHub CLI/**)",
      "Read(~/AppData/Roaming/glab-cli/**)",
      "Read(~/Library/Application Support/glab-cli/**)",
    ]) {
      expect(claude).toContain(rule);
    }
    // Reading a repository, opening and commenting a pull request: no rule (the constitution says it).
    expect(
      claude.some(
        (rule) =>
          rule.startsWith("Bash(gh repo view") ||
          rule === "Bash(gh repo*)" ||
          rule.startsWith("Bash(gh pr create") ||
          rule === "Bash(gh api*)",
      ),
    ).toBe(false);
    const cursor = cursorDenyRules(inputs);
    for (const rule of [
      "Shell(gh:auth*)",
      "Shell(gh:pr merge*)",
      "Read(~/AppData/Roaming/GitHub CLI/**)",
    ]) {
      expect(cursor).toContain(rule);
    }
  });
});
