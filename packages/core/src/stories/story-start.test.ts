import { gitBlobId, toBase64url, utf8 } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode, type PhaseId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentStateView,
  type CommandContext,
  type CommitHookFiles,
  type CommitHookInstall,
  computeProjection,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type NextResult,
  type ProfileAdjustments,
  type RecordedEvent,
  recordGitWorkflow,
  resolveProfile,
  resultMovesToReview,
  type StoryStartResult,
  type StoryState,
  type StoryWorkspace,
  type StoryWorkspaceCreation,
  type StoryWorkspaceInspection,
  type StoryWorkspaceTarget,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";
import { commitHookFiles, renderCommitCheck, renderCommitHook } from "./commit-hook.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(5));
const MAIN_COMMIT = "c".repeat(40);

/** A Git repository in memory: branches, worktrees and the blobs of the main branch. */
class FakeWorkspace implements StoryWorkspace {
  readonly branches = new Map<
    string,
    { commit: string; merged: boolean; storyBlob: string | null }
  >();
  readonly worktrees = new Map<string, string>();
  /** The story blob at the main branch's commit, by path. */
  readonly blobs = new Map<string, string>();
  /** The text of every blob. */
  readonly texts = new Map<string, string>();
  /** The story files at each branch's last commit: blob by path. */
  readonly branchFiles = new Map<string, Map<string, string>>();
  readonly taken = new Set<string>();
  readonly hookFiles: CommitHookFiles[] = [];
  readonly discarded: string[] = [];
  main: { ref: string; commit: string } | null = { ref: "main", commit: MAIN_COMMIT };
  prefix = "";
  unsupported: "bare" | "root" | undefined;
  /** Runs when `create` is done: a concurrent writer, in the race test. */
  onCreate: (() => Promise<void>) | undefined;

  target(id: string) {
    return { path: `/repos/shop.worktrees/${id}`, relative: `../shop.worktrees/${id}` };
  }

  /** The integration branches that exist here, each at its own commit. */
  readonly landing = new Map<string, string>();

  /** The branch checked out in the main folder; `undefined`: the adapter does not say. */
  current: string | null | undefined;

  async ensureBranch(name: string) {
    if (this.landing.has(name)) return { status: "exists" as const };
    this.landing.set(name, "d".repeat(40));
    return { status: "created" as const, from: "main" };
  }

  async inspect(
    target: StoryWorkspaceTarget,
    options: { readonly base?: string } = {},
  ): Promise<StoryWorkspaceInspection> {
    if (this.unsupported !== undefined) return { repository: false, unsupported: this.unsupported };
    const where = this.target(target.id);
    const holder = this.worktrees.get(target.branch);
    const commit = options.base === undefined ? undefined : this.landing.get(options.base);
    return {
      repository: true,
      prefix: this.prefix,
      root: "/repos/shop",
      ...(this.current === undefined ? {} : { current: this.current }),
      main:
        options.base === undefined
          ? this.main
          : commit === undefined
            ? null
            : { ref: options.base, commit },
      storyBlob: this.blobs.get(target.path) ?? null,
      branch: this.branches.get(target.branch) ?? null,
      checkedOut: holder === undefined ? null : { path: holder, atTarget: holder === where.path },
      target: { ...where, exists: holder === where.path || this.taken.has(where.path) },
    };
  }

  async create(target: StoryWorkspaceTarget, base: string): Promise<StoryWorkspaceCreation> {
    let createdBranch = false;
    if (!this.branches.has(target.branch)) {
      this.branches.set(target.branch, { commit: base, merged: true, storyBlob: null });
      // At the main branch's commit, the branch holds the stories the main branch holds.
      this.branchFiles.set(target.branch, new Map(this.blobs));
      createdBranch = true;
    }
    const holder = this.worktrees.get(target.branch);
    let created: StoryWorkspaceCreation;
    if (holder !== undefined) {
      created = { worktree: holder, createdBranch, createdWorktree: false };
    } else {
      const { path } = this.target(target.id);
      this.worktrees.set(target.branch, path);
      created = { worktree: path, createdBranch, createdWorktree: true };
    }
    await this.onCreate?.();
    return created;
  }

  async discard(target: StoryWorkspaceTarget, _base: string, created: StoryWorkspaceCreation) {
    if (created.createdWorktree) this.worktrees.delete(target.branch);
    if (created.createdBranch) this.branches.delete(target.branch);
    this.discarded.push(target.branch);
    return true;
  }

  async readBlob(blob: string) {
    return this.texts.get(blob);
  }

  async storyFilesOn(branch: string) {
    const files = this.branchFiles.get(branch);
    return files === undefined ? undefined : [...files].map(([path, blob]) => ({ path, blob }));
  }

  async installCommitHook(files: CommitHookFiles): Promise<CommitHookInstall> {
    this.hookFiles.push(files);
    return { status: "installed", path: "/repos/shop/.git/hooks/commit-msg" };
  }
}

/** A shipped agent built on the sample one. */
function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

/** A story `docs check` accepts: the contract and its four sections. */
function storyFile(id: string, owner: string, dependsOn: string[] = [], branch?: string) {
  return [
    "---",
    `id: ${id}`,
    "kind: story",
    `owner: ${owner}`,
    `title: Story ${id}`,
    "epic: epic-1",
    "reviewer: quentin",
    "requirements: [EF-1]",
    "budget_usd: 2",
    `branch: ${branch ?? `feat/${id}-work`}`,
    `depends_on: [${dependsOn.join(", ")}]`,
    "---",
    `# Story ${id}`,
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
    "Given Ada, when she acts, then it works.",
    "",
    "## Out of scope",
    "",
    "Nothing else.",
    "",
  ].join("\n");
}

const STORIES: ReadonlyArray<readonly [string, string, string, string[], string?]> = [
  ["1-1-sign-up", "1-1", "sam", []],
  ["1-2-sign-in", "1-2", "sam", ["1-1"]],
  ["1-3-profile", "1-3", "ethan", []],
  ["1-4-welcome", "1-4", "creator", []],
  ["1-5-odd", "1-5", "sam", [], "work/1-5"],
];

const path = (name: string) => `.agentplugged/stories/${name}.md`;

/** A product in the build phase, its stories validated and on the main branch. */
async function product(adjustments: ProfileAdjustments = {}) {
  const files = new MemoryFiles();
  let clock = Date.UTC(2026, 9, 4, 12, 0, 0);
  const now = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now });
  const workspace = new FakeWorkspace();
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("izzy", "Izzy", "product", "build"),
      ...shippedAgent("sam", "Sam", "code", "build"),
      ...shippedAgent("ethan", "Ethan", "code", "build"),
      ...shippedAgent("jade", "Jade", "code", "build"),
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
  };
  const profile = resolveProfile("new-product", adjustments);
  const init = await initCommand.run(human, { profile });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok)
      throw new Error(
        `${name} failed: ${result.error.code} ${JSON.stringify(result.error.details)}`,
      );
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
    "---\nid: prd\nkind: prd\nowner: maya\n---\n# PRD\n\nEF-1 : Ada signs up and in.\n",
  );
  files.seed(
    ".agentplugged/epics/epic-1.md",
    "---\nid: epic-1\nkind: epic\nowner: izzy\n---\n# Epic 1\n",
  );
  /** Validates the stories at their current text, which the main branch then holds. */
  const validate = async (entries: ReadonlyArray<readonly [string, string]>) => {
    const documents = [];
    for (const [name, text] of entries) {
      files.seed(path(name), text);
      const blob = gitBlobId(utf8(text));
      workspace.blobs.set(path(name), blob);
      workspace.texts.set(blob, text);
      documents.push({ path: path(name), branch: "main", blob_sha: blob });
    }
    const opened = await run("open_checkpoint", {
      agent: "izzy",
      type: "document",
      risk: "medium",
      title: "Epic 1",
      summary: "The stories.",
      documents,
    });
    await answer(opened.checkpoint);
  };
  await validate(
    STORIES.map(([name, id, owner, dependsOn, branch]) => [
      name,
      storyFile(id, owner, dependsOn, branch),
    ]),
  );
  const planSprint = async (stories: string[], agents = ["sam", "ethan"]) => {
    const planned = await run("plan_sprint", {
      agent: "izzy",
      goal: "Accounts",
      stories,
      capacity: { agents, humans: 1 },
      summary: "Accounts first.",
    });
    await answer(planned.checkpoint);
  };
  /** The creator accepts a story: an approved `story` checkpoint makes it done. */
  const finish = async (story: string) => {
    const opened = await run("open_checkpoint", {
      agent: "sam",
      type: "story",
      risk: "low",
      title: `Story ${story}`,
      summary: "Done.",
      story,
    });
    await answer(opened.checkpoint);
  };
  const reader: CommandContext = { ...human, human: undefined };
  const next = async () => {
    const result = await registry.run("next", reader, {});
    if (!result.ok) throw new Error(`next failed: ${result.error.code}`);
    return result.value as NextResult;
  };
  const state = async () => {
    const result = await call("get_state", { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  const cli = (story: string) => registry.run("story", reader, { action: "start", story });
  return {
    files,
    journal,
    workspace,
    call,
    run,
    next,
    state,
    validate,
    planSprint,
    finish,
    cli,
    agent,
    human,
  };
}

const errorOf = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? undefined : result.error;
const reasonOf = (result: { ok: boolean; error?: { details?: Record<string, unknown> } }) =>
  result.ok ? undefined : result.error?.details?.reason;

describe("start_story and story start", () => {
  it("starts a validated story without a sprint, then only stories of the sprint in force", async () => {
    const { journal, workspace, call, next, state, planSprint } = await product();
    const started = await call("start_story", { agent: "ethan", story: "1-3" });
    expect(started.ok).toBe(true);
    const value = (started as { value: StoryStartResult }).value;
    expect(value).toMatchObject({
      status: "started",
      story: "1-3",
      agent: "ethan",
      branch: "feat/1-3-work",
      base: MAIN_COMMIT,
      base_ref: "main",
      worktree: "/repos/shop.worktrees/1-3",
      workdir: "/repos/shop.worktrees/1-3",
      hook: { status: "installed" },
    });
    // The sheet to read alone: here a story of the former format, which keeps working.
    expect(value.sheet).toMatchObject({ format: "legacy" });
    expect(value.sheet?.path).toMatch(/^\.agentplugged\/stories\/1-3/);
    expect(value.sheet?.stale).toBeUndefined();
    // The hook checks the requirements of the approved version.
    expect(workspace.hookFiles.at(-1)?.story).toEqual({ id: "1-3", requirements: ["EF-1"] });
    expect(journal.events.at(-1)).toMatchObject({
      id: value.event?.id,
      type: "story.started",
      story: "1-3",
      actor: { kind: "agent", agent: "ethan" },
      payload: {
        agent: "ethan",
        branch: "feat/1-3-work",
        base: MAIN_COMMIT,
        base_ref: "main",
        worktree: "../shop.worktrees/1-3",
      },
    });
    expect((await state()).stories["1-3"]).toMatchObject({
      status: "in_progress",
      status_by: { agent: "ethan" },
      started: { branch: "feat/1-3-work", worktree: "../shop.worktrees/1-3" },
    });

    // Again by the same agent: resumed, nothing written twice; by another: refused.
    const count = journal.events.length;
    const again = await call("start_story", { agent: "ethan", story: "1-3" });
    expect(again.ok ? again.value : undefined).toMatchObject({ status: "resumed" });
    expect(reasonOf(await call("start_story", { agent: "sam", story: "1-3" }))).toBe(
      "started_by_other",
    );
    expect(journal.events.length).toBe(count);

    await planSprint(["1-1", "1-2", "1-4"]);
    expect(await next()).toMatchObject({ step: "build", agent: "ethan", story: "1-3" });
    expect(errorOf(await call("start_story", { agent: "sam", story: "1-5" }))).toMatchObject({
      code: ErrorCode.STORY_NOT_STARTABLE,
      message_key: "error.story_not_startable.not_in_sprint",
      details: { story: "1-5", reason: "not_in_sprint" },
    });
    expect(errorOf(await call("start_story", { agent: "sam", story: "1-2" }))).toMatchObject({
      details: { reason: "dependency_open", dependency: "1-1" },
    });
    expect(reasonOf(await call("start_story", { agent: "sam", story: "9-9" }))).toBe(
      "unknown_story",
    );
    // Quentin is neither the owner nor in the sprint's capacity.
    expect(errorOf(await call("start_story", { agent: "quentin", story: "1-1" }))).toMatchObject({
      details: { reason: "not_builder", agent: "quentin", owner: "sam" },
    });
    // The sprint, its checkpoint and its approval only.
    expect(journal.events.length).toBe(count + 3);
    expect(workspace.branches.has("feat/1-2-work")).toBe(false);
  });

  it("gives one developer two stories as two instances, never two developers one story", async () => {
    const { journal, call, state } = await product();
    expect((await call("start_story", { agent: "sam", story: "1-1" })).ok).toBe(true);
    // The quick start of a second story of the same developer: another instance.
    const second = await call("start_story", { agent: "ethan", story: "1-3" });
    expect(second.ok).toBe(true);
    const count = journal.events.length;
    expect(errorOf(await call("start_story", { agent: "ethan", story: "1-1" }))).toMatchObject({
      code: ErrorCode.STORY_NOT_STARTABLE,
      message_key: "error.story_not_startable.started_by_other",
      details: { story: "1-1", reason: "started_by_other", agent: "sam" },
    });
    expect(journal.events.length).toBe(count);
    expect((await state()).instances).toMatchObject({
      "sam/1-1": { agent: "sam", story: "1-1" },
      "ethan/1-3": { agent: "ethan", story: "1-3" },
    });
  });

  it("starts and resumes no story for an agent while the team is paused, and again once resumed", async () => {
    const { journal, call, files, workspace } = await product();
    expect((await call("start_story", { agent: "sam", story: "1-1" })).ok).toBe(true);
    const productId = /product_id: "?([0-9A-Z]{26})/.exec(
      files.files.get(".agentplugged/method.yaml") ?? "",
    )?.[1];
    const hold = (type: string, payload: Record<string, unknown>) =>
      journal.appendAll([
        {
          type,
          actor: { kind: "system" },
          product: productId ?? "",
          provenance: "trusted",
          payload,
        },
      ]);
    await hold("team.paused", { reason: "creator" });
    const count = journal.events.length;
    // A new story is refused, and so is the story already started: nobody takes work up.
    for (const [agent, story] of [
      ["ethan", "1-3"],
      ["sam", "1-1"],
    ] as const) {
      expect(errorOf(await call("start_story", { agent, story }))).toMatchObject({
        code: ErrorCode.STORY_NOT_STARTABLE,
        message_key: "error.story_not_startable.team_paused",
        details: { story, reason: "team_paused" },
      });
    }
    expect(journal.events.length).toBe(count);
    expect(workspace.branches.has("feat/1-3-work")).toBe(false);
    await hold("team.resumed", {});
    expect((await call("start_story", { agent: "ethan", story: "1-3" })).ok).toBe(true);
  });

  it("makes a story wait while the ceiling of stories at once is reached", async () => {
    const { journal, call, workspace } = await product({ max_parallel_stories: 1 });
    expect((await call("start_story", { agent: "sam", story: "1-1" })).ok).toBe(true);
    const count = journal.events.length;
    expect(errorOf(await call("start_story", { agent: "ethan", story: "1-3" }))).toMatchObject({
      code: ErrorCode.STORY_NOT_STARTABLE,
      message_key: "error.story_not_startable.parallel_limit",
      details: { story: "1-3", reason: "parallel_limit", limit: 1, building: "1-1" },
    });
    expect(journal.events.length).toBe(count);
    expect(workspace.branches.has("feat/1-3-work")).toBe(false);
    // The story already started resumes, whatever the ceiling.
    const again = await call("start_story", { agent: "sam", story: "1-1" });
    expect(again.ok ? again.value : undefined).toMatchObject({ status: "resumed" });
  });

  it("names the builder in next and starts through the CLI for the active one", async () => {
    const { journal, call, next, state, planSprint, cli } = await product();
    await planSprint(["1-4", "1-1"]);
    expect(await next()).toMatchObject({
      step: "build",
      you: true,
      story: "1-4",
      command: "npx agentplugged story start 1-4",
    });
    const started = await cli("1-4");
    expect(started.ok ? started.value : undefined).toMatchObject({
      status: "started",
      agent: "creator",
    });
    expect(journal.events.at(-1)).toMatchObject({
      type: "story.started",
      actor: { kind: "system" },
      payload: { agent: "creator" },
    });
    // The projection shows it in progress, and next no longer proposes its start.
    expect((await state()).stories["1-4"]).toMatchObject({
      status: "in_progress",
      started: { agent: "creator" },
    });
    const building = await next();
    expect(building).toMatchObject({ step: "build", you: true, story: "1-4" });
    expect(building.command).not.toBe("npx agentplugged story start 1-4");
    // The CLI starts an agent's story for that agent.
    const sam = await cli("1-1");
    expect(sam.ok ? sam.value : undefined).toMatchObject({ agent: "sam" });
    expect(reasonOf(await call("start_story", { agent: "sam", story: "1-1" }))).toBeUndefined();
    expect(errorOf(await cli("x"))).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
  });

  it("carries the start command to the agent who owns the story", async () => {
    const { next, planSprint } = await product();
    await planSprint(["1-1"], ["sam"]);
    expect(await next()).toMatchObject({
      step: "build",
      agent: "sam",
      story: "1-1",
      command: "npx agentplugged story start 1-1",
    });
  });

  it("refuses what the journal and the working copy do not allow", async () => {
    const { journal, files, workspace, call, run, finish, validate } = await product();
    const count = journal.events.length;
    // A status given before any start.
    await run("update_story", { agent: "ethan", story: "1-3", status: "blocked" });
    expect(errorOf(await call("start_story", { agent: "ethan", story: "1-3" }))).toMatchObject({
      details: { reason: "already_started", status: "blocked" },
    });
    // Done: refused before any resume.
    await finish("1-1");
    expect(reasonOf(await call("start_story", { agent: "sam", story: "1-1" }))).toBe("done");
    // Changed since its validation.
    files.seed(path("1-4-welcome"), storyFile("1-4", "creator").replace("Ada can", "Ada may"));
    expect(errorOf(await call("start_story", { agent: "main", story: "1-4" }))).toMatchObject({
      details: { reason: "not_validated", why: "changed" },
    });
    // Refused by docs check, unreadable.
    files.seed(path("1-6-broken"), storyFile("1-6", "sam").replace("## Intent", "## Notes"));
    expect(reasonOf(await call("start_story", { agent: "sam", story: "1-6" }))).toBe(
      "invalid_story",
    );
    // A sheet over the ceiling, validated as it is: a story too big, cut before it starts.
    const tooLong = `${storyFile("1-5", "sam")}\n## Excerpts\n\n${"- line\n".repeat(300)}`;
    await validate([["1-5-long", tooLong]]);
    expect(errorOf(await call("start_story", { agent: "sam", story: "1-5" }))).toMatchObject({
      details: { reason: "invalid_story", why: "STORY_SHEET_TOO_LONG" },
    });
    files.seedBytes(path("1-7-binary"), new Uint8Array([0xff, 0xfe, 0x00]));
    expect(reasonOf(await call("start_story", { agent: "sam", story: "1-7" }))).toBe("unreadable");
    // Validated again, but the main branch still holds the older approval.
    await validate([["1-4-welcome", storyFile("1-4", "creator").replace("Ada can", "Ada may")]]);
    workspace.blobs.set(path("1-4-welcome"), gitBlobId(utf8(storyFile("1-4", "creator"))));
    expect(errorOf(await call("start_story", { agent: "main", story: "1-4" }))).toMatchObject({
      details: { reason: "not_on_main", why: "differs" },
    });
    expect(workspace.branches.size).toBe(0);
    expect(journal.events.filter((event) => event.type === "story.started")).toEqual([]);
    expect(journal.events.length).toBeGreaterThan(count);
  });

  it("refuses what Git would not give the story: main, its branch, its folder", async () => {
    const { journal, workspace, call } = await product();
    const count = journal.events.length;
    const story = path("1-1-sign-up");
    const approved = workspace.blobs.get(story) as string;
    workspace.blobs.delete(story);
    expect(errorOf(await call("start_story", { agent: "sam", story: "1-1" }))).toMatchObject({
      details: { reason: "not_on_main", why: "missing", base_ref: "main" },
    });
    workspace.blobs.set(story, approved);
    workspace.branches.set("feat/1-3-work", {
      commit: "e".repeat(40),
      merged: false,
      storyBlob: null,
    });
    expect(errorOf(await call("start_story", { agent: "ethan", story: "1-3" }))).toMatchObject({
      details: { reason: "branch_exists", branch: "feat/1-3-work" },
    });
    // Behind main, without the approved story: not taken.
    workspace.branches.set("feat/1-1-work", {
      commit: "a".repeat(40),
      merged: true,
      storyBlob: null,
    });
    expect(reasonOf(await call("start_story", { agent: "sam", story: "1-1" }))).toBe(
      "branch_exists",
    );
    workspace.worktrees.set("feat/1-4-work", "/repos/shop");
    expect(errorOf(await call("start_story", { agent: "main", story: "1-4" }))).toMatchObject({
      details: { reason: "branch_checked_out", path: "/repos/shop" },
    });
    workspace.worktrees.delete("feat/1-4-work");
    workspace.taken.add("/repos/shop.worktrees/1-4");
    expect(reasonOf(await call("start_story", { agent: "main", story: "1-4" }))).toBe(
      "worktree_path_taken",
    );
    expect(errorOf(await call("start_story", { agent: "sam", story: "1-5" }))).toMatchObject({
      details: { reason: "branch_name", branch: "work/1-5" },
    });
    workspace.unsupported = "bare";
    expect(errorOf(await call("start_story", { agent: "ethan", story: "1-3" }))).toMatchObject({
      details: { reason: "unsupported_repository", why: "bare" },
    });
    workspace.unsupported = undefined;
    workspace.main = null;
    expect(reasonOf(await call("start_story", { agent: "main", story: "1-4" }))).toBe(
      "no_main_branch",
    );
    expect(journal.events.length).toBe(count);
  });

  it("says when no repository holds the folder", async () => {
    const { agent } = await product();
    const none: StoryWorkspace = {
      inspect: async () => ({ repository: false }),
      create: () => Promise.reject(new Error("unused")),
      discard: async () => true,
      readBlob: async () => undefined,
      storyFilesOn: async () => undefined,
      installCommitHook: () => Promise.reject(new Error("unused")),
    };
    const result = await createCommandRegistry().run(
      "start_story",
      { ...agent, storyWorkspace: none },
      { agent: "ethan", story: "1-3" },
    );
    expect(errorOf(result)).toMatchObject({ code: ErrorCode.NOT_A_GIT_REPO });
  });

  it("takes a branch left by an interrupted start, and resumes only where it started", async () => {
    const { workspace, call, agent } = await product();
    const approved = workspace.blobs.get(path("1-3-profile")) ?? null;
    workspace.branches.set("feat/1-3-work", {
      commit: "f".repeat(40),
      merged: true,
      storyBlob: approved,
    });
    const started = await call("start_story", { agent: "ethan", story: "1-3" });
    expect(started.ok ? started.value : undefined).toMatchObject({ base: "f".repeat(40) });
    // Checked out elsewhere since: no resume there.
    workspace.worktrees.set("feat/1-3-work", "/repos/shop");
    expect(errorOf(await call("start_story", { agent: "ethan", story: "1-3" }))).toMatchObject({
      details: { reason: "branch_checked_out", path: "/repos/shop" },
    });
    // Another machine: its own key, even with a branch of the same name.
    const registry = createCommandRegistry();
    const other = await registry.run(
      "start_story",
      { ...agent, keys: new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(9))) },
      { agent: "ethan", story: "1-3" },
    );
    expect(reasonOf(other)).toBe("started_elsewhere");
  });

  it("removes what it created when a concurrent start wins the race", async () => {
    const { journal, workspace, call } = await product();
    workspace.onCreate = async () => {
      workspace.onCreate = undefined;
      await journal.append({
        type: "story.started",
        actor: { kind: "agent", agent: "ethan" },
        product: (await journal.productId()) as string,
        provenance: "trusted",
        story: "1-3",
        payload: {
          agent: "ethan",
          branch: "feat/1-3-work",
          base: MAIN_COMMIT,
          base_ref: "main",
          worktree: "../shop.worktrees/1-3",
        },
      });
    };
    expect(errorOf(await call("start_story", { agent: "ethan", story: "1-3" }))).toMatchObject({
      details: { reason: "already_started", status: "in_progress" },
    });
    expect(workspace.discarded).toEqual(["feat/1-3-work"]);
    expect(workspace.branches.has("feat/1-3-work")).toBe(false);
    expect(journal.events.filter((event) => event.type === "story.started")).toHaveLength(1);
    expect(workspace.hookFiles).toEqual([]);
  });

  it("never starts a story an open item of deferred work locks", async () => {
    const { journal, workspace, call, run, cli, next, planSprint } = await product();
    const recorded = await run("defer_work", {
      agent: "ethan",
      title: "Settle the avatar size",
      origin: "deliberate",
      locks: ["1-3"],
    });
    for (const result of [
      await call("start_story", { agent: "ethan", story: "1-3" }),
      await cli("1-3"),
    ]) {
      expect(errorOf(result)).toMatchObject({
        code: ErrorCode.STORY_LOCKED,
        details: { story: "1-3", action: "start", first: recorded.deferred },
      });
    }
    expect(workspace.branches.has("feat/1-3-work")).toBe(false);
    expect(journal.events.filter((event) => event.type === "story.started")).toEqual([]);

    // next passes over the locked story and names the free one, with its start command.
    await planSprint(["1-3", "1-1"]);
    expect(await next()).toMatchObject({
      step: "build",
      agent: "sam",
      story: "1-1",
      command: "npx agentplugged story start 1-1",
    });

    await run("complete_deferred", {
      agent: "ethan",
      item: recorded.deferred,
      reason: "Avatars are 96 px.",
    });
    const started = await call("start_story", { agent: "ethan", story: "1-3" });
    expect(started.ok ? started.value : undefined).toMatchObject({ status: "started" });
  });

  it("never pauses a story for its budget, whatever was declared on it", async () => {
    const { call, cli, planSprint, workspace } = await product();
    await planSprint(["1-3"]);
    // $3 declared on a $2 estimate: no ceiling in the engine, the story starts all the same.
    const over = await call("report_cost", {
      agent: "ethan",
      story: "1-3",
      usd: 3,
      estimated: false,
    });
    expect(over.ok).toBe(true);
    const started = await call("start_story", { agent: "ethan", story: "1-3" });
    expect(started.ok ? started.value : undefined).toMatchObject({ status: "started" });
    workspace.worktrees.delete("feat/1-3-work");
    const resumed = await cli("1-3");
    expect(errorOf(resumed)).toBeUndefined();
  });

  it("works in the workspace's folder inside the worktree", async () => {
    const { workspace, call } = await product();
    workspace.prefix = "app/";
    const started = await call("start_story", { agent: "ethan", story: "1-3" });
    expect(started.ok ? started.value : undefined).toMatchObject({
      worktree: "/repos/shop.worktrees/1-3",
      workdir: "/repos/shop.worktrees/1-3/app",
    });
  });
});

describe("the story.started reducer", () => {
  const draft = {
    type: "story.started",
    actor: { kind: "agent" as const, agent: "sam" },
    product: "01JZ0000000000000000000000",
    provenance: "trusted" as const,
    story: "1-1",
    payload: {
      agent: "sam",
      branch: "feat/1-1-work",
      base: MAIN_COMMIT,
      base_ref: "main",
      worktree: "../shop.worktrees/1-1",
    },
  };

  it("ignores an agent naming another builder, and a second start", async () => {
    const journal = new MemoryStateStore({ keys: new MemoryKeyStore(SEED) });
    await journal.append({ ...draft, payload: { ...draft.payload, agent: "ethan" } });
    const first = await journal.append(draft);
    const second = await journal.append({ ...draft, actor: { kind: "system" as const } });
    const projection = await computeProjection(journal.events);
    const ignored = projection.ignored.map((entry) => entry.id);
    expect(ignored).toContain(second.id);
    expect(ignored).not.toContain(first.id);
    expect(projection.ignored.length).toBe(2);
    expect((projection.state.stories as Record<string, unknown>)["1-1"]).toMatchObject({
      status: "in_progress",
      started: { agent: "sam", event: first.id },
    });
  });

  it("ignores a start once the story has a status", async () => {
    const journal = new MemoryStateStore({ keys: new MemoryKeyStore(SEED) });
    await journal.append({
      type: "story.status_changed",
      actor: draft.actor,
      product: draft.product,
      provenance: "trusted",
      story: "1-1",
      payload: { status: "blocked" },
    });
    const late = await journal.append(draft);
    const projection = await computeProjection(journal.events);
    expect(projection.ignored.map((entry) => entry.id)).toContain(late.id);
    expect((projection.state.stories as Record<string, unknown>)["1-1"]).toMatchObject({
      status: "blocked",
    });
  });
});

describe("the commit hook's files", () => {
  it("are marked as generated, chain the replaced hook and need Node on story branches only", () => {
    const hook = renderCommitHook();
    expect(hook.startsWith("#!/bin/sh\n# Generated by agentplugged.")).toBe(true);
    expect(hook).toContain("commit-msg.pre-agentplugged");
    expect(hook).toContain("  feat/*) ;;");
    expect(hook).toContain("command -v node");
    expect(hook).toContain('[ -n "$1" ] || exit 0');
    const check = renderCommitCheck();
    expect(check).toContain("git commit --no-verify");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge"]) {
      expect(check).toContain(`"${marker}"`);
    }
    expect(commitHookFiles({ id: "1-1", requirements: ["EF-1"] }).story).toEqual({
      id: "1-1",
      requirements: ["EF-1"],
    });
  });
});

describe("going to review", () => {
  const BRANCH = "feat/1-3-work";
  const APPROVED = storyFile("1-3", "ethan");
  const result = (agent: string, status: string, story = "1-3") => ({
    agent,
    story,
    status,
    summary: "Criteria done.",
    assumptions: [],
    open_questions: [],
    conflicts: [],
  });
  /** `1-3` started by Ethan, its branch holding the approved story. */
  async function started() {
    const context = await product();
    const begun = await context.call("start_story", { agent: "ethan", story: "1-3" });
    if (!begun.ok) throw new Error(`start_story failed: ${begun.error.code}`);
    return context;
  }
  /** The story files at the last commit of the story's branch: path → text. */
  function onBranch(workspace: FakeWorkspace, files: Record<string, string>) {
    const blobs = new Map<string, string>();
    for (const [file, text] of Object.entries(files)) {
      const blob = gitBlobId(utf8(text));
      workspace.texts.set(blob, text);
      blobs.set(file, blob);
    }
    workspace.branchFiles.set(BRANCH, blobs);
  }
  const statusOf = async (state: () => Promise<AgentStateView>) =>
    (await state()).stories["1-3"]?.status;

  it("moves the story to review on its builder's complete result, recorded explicitly", async () => {
    const { journal, call, run, state, next } = await started();
    // Another agent's complete result, a partial one: the story stays in progress.
    await run("submit_result", result("quentin", "complete"));
    await run("submit_result", result("ethan", "partial"));
    expect(await statusOf(state)).toBe("in_progress");
    const written = await run("submit_result", result("ethan", "complete"));
    // The result, then the move, in the same write.
    expect(journal.events.at(-2)).toMatchObject({ id: written.id, type: "agent.result_recorded" });
    expect(journal.events.at(-1)).toMatchObject({
      type: "story.status_changed",
      story: "1-3",
      actor: { kind: "agent", agent: "ethan" },
      payload: { status: "in_review" },
    });
    expect((await state()).stories["1-3"]).toMatchObject({
      status: "in_review",
      status_by: { agent: "ethan" },
    });
    // In review, its CI is read first: here the product has none Omar could set up,
    // so the step names the creator's way out.
    expect(await next()).toMatchObject({
      step: "ci_check",
      story: "1-3",
      ci: { cause: "no_ci" },
    });
    // Once in review, a second complete result moves nothing.
    const count = journal.events.length;
    expect((await call("submit_result", result("ethan", "complete"))).ok).toBe(true);
    expect(journal.events.length).toBe(count + 1);
  });

  it("leaves the story to its builder after a handover, never to the agent that took it", async () => {
    const { run, state } = await started();
    await run("update_story", { agent: "sam", story: "1-3", status: "in_progress" });
    await run("submit_result", result("sam", "complete"));
    expect(await statusOf(state)).toBe("in_progress");
    await run("submit_result", result("ethan", "complete"));
    expect(await statusOf(state)).toBe("in_review");
  });

  it("changes nothing when a journal written before is replayed", async () => {
    const journal = new MemoryStateStore({ keys: new MemoryKeyStore(SEED) });
    const envelope = {
      actor: { kind: "agent" as const, agent: "ethan" },
      product: "01JZ0000000000000000000000",
      provenance: "trusted" as const,
      story: "1-3",
    };
    await journal.append({
      ...envelope,
      type: "story.started",
      payload: {
        agent: "ethan",
        branch: BRANCH,
        base: MAIN_COMMIT,
        base_ref: "main",
        worktree: "../shop.worktrees/1-3",
      },
    });
    await journal.append({
      ...envelope,
      type: "agent.result_recorded",
      payload: {
        status: "complete",
        summary: "Criteria done.",
        assumptions: [],
        open_questions: [],
        conflicts: [],
      },
    });
    const projection = await computeProjection(journal.events);
    expect((projection.state.stories as Record<string, StoryState>)["1-3"]?.status).toBe(
      "in_progress",
    );
  });

  it("keeps the story in progress on a blocked result, and an explicit move as it is", async () => {
    const { run, state } = await started();
    const blocked = await run("submit_result", result("ethan", "blocked"));
    expect(blocked.checkpoint).toMatch(/^G-/);
    expect(await statusOf(state)).toBe("in_progress");

    const other = await started();
    await other.run("update_story", { agent: "ethan", story: "1-3", status: "in_review" });
    const count = other.journal.events.length;
    await other.run("submit_result", result("ethan", "complete"));
    expect(other.journal.events.length).toBe(count + 1);
    expect(await statusOf(other.state)).toBe("in_review");
  });

  it("refuses the move while a checkpoint blocks the review", async () => {
    const { journal, call, run, state } = await started();
    await run("open_checkpoint", {
      agent: "ethan",
      type: "decision",
      risk: "medium",
      title: "Two readings",
      summary: "The intent reads two ways.",
      story: "1-3",
      options: [
        { id: "a", label: "First", consequence: "Users see A." },
        { id: "b", label: "Second", consequence: "Users see B." },
      ],
      recommendation: "a",
      blocks: [{ action: "story.review" }],
    });
    const count = journal.events.length;
    expect(errorOf(await call("submit_result", result("ethan", "complete")))).toMatchObject({
      code: ErrorCode.CHECKPOINT_OPEN,
      details: { action: "story.review" },
    });
    expect(journal.events.length).toBe(count);
    expect(await statusOf(state)).toBe("in_progress");
    // Another agent's result does not move the story: it is not refused.
    expect((await call("submit_result", result("quentin", "complete"))).ok).toBe(true);

    // No budget pauses the story: a cost declared over its estimate does not refuse the move.
    const over = await product();
    await over.planSprint(["1-3"]);
    await over.run("start_story", { agent: "ethan", story: "1-3" });
    await over.run("report_cost", { agent: "ethan", story: "1-3", usd: 3, estimated: false });
    expect((await over.call("submit_result", result("ethan", "complete"))).ok).toBe(true);
    expect(await statusOf(over.state)).toBe("in_review");
  });

  it("refuses the move while the story's branch changes its frozen intent", async () => {
    const { journal, workspace, call, state } = await started();
    const at = path("1-3-profile");
    const count = journal.events.length;
    const refusal = (reason: string, file = at) => ({
      code: ErrorCode.STORY_INTENT_CHANGED,
      message_key: "error.story_intent_changed.on_branch",
      details: {
        story: "1-3",
        reason,
        branch: BRANCH,
        path: file,
        checkpoint: expect.stringMatching(/^G-/),
      },
    });
    onBranch(workspace, { [at]: APPROVED.replace("Ada can do 1-3.", "Ada can do anything.") });
    for (const refused of [
      await call("submit_result", result("ethan", "complete")),
      await call("update_story", { agent: "ethan", story: "1-3", status: "in_review" }),
    ]) {
      expect(errorOf(refused)).toMatchObject(refusal("changed"));
    }
    // Found by its id, wherever its file went on the branch.
    const moved = path("profile");
    onBranch(workspace, { [moved]: APPROVED.replace("Ada can do 1-3.", "Ada can do more.") });
    expect(errorOf(await call("submit_result", result("ethan", "complete")))).toMatchObject(
      refusal("changed", moved),
    );
    // Its file without an intent section; no file holding the story (another one at its path).
    onBranch(workspace, { [at]: APPROVED.replace("## Intent", "## Purpose") });
    expect(errorOf(await call("submit_result", result("ethan", "complete")))).toMatchObject(
      refusal("no_intent"),
    );
    onBranch(workspace, { [at]: storyFile("1-9", "ethan") });
    expect(errorOf(await call("submit_result", result("ethan", "complete")))).toMatchObject(
      refusal("removed"),
    );
    expect(journal.events.length).toBe(count);
    expect(await statusOf(state)).toBe("in_progress");

    // Other sections may change; with the intent as approved, the story goes to review.
    onBranch(workspace, { [moved]: APPROVED.replace("Nothing else.", "Nothing else, still.") });
    expect((await call("submit_result", result("ethan", "complete"))).ok).toBe(true);
    expect(await statusOf(state)).toBe("in_review");
  });

  it("goes to review when the branch cannot be read: no branch, no Git workspace", async () => {
    const { workspace, call, state } = await started();
    workspace.branchFiles.delete(BRANCH);
    expect(
      (await call("update_story", { agent: "ethan", story: "1-3", status: "in_review" })).ok,
    ).toBe(true);
    expect(await statusOf(state)).toBe("in_review");

    const other = await started();
    onBranch(other.workspace, { [path("1-3-profile")]: storyFile("1-9", "ethan") });
    const { storyWorkspace: _unused, ...withoutGit } = other.agent;
    const done = await createCommandRegistry().run(
      "submit_result",
      withoutGit,
      result("ethan", "complete"),
    );
    expect(done.ok).toBe(true);
    expect(await statusOf(other.state)).toBe("in_review");
  });

  it("moves the story of a developer of another specialty too", async () => {
    const { run, state, planSprint } = await product({ specialties: ["backend", "mobile"] });
    await planSprint(["1-1"], ["sam", "jade"]);
    await run("start_story", { agent: "jade", story: "1-1" });
    await run("submit_result", result("jade", "complete", "1-1"));
    expect((await state()).stories["1-1"]).toMatchObject({
      status: "in_review",
      status_by: { agent: "jade" },
    });
  });
});

describe("resultMovesToReview", () => {
  const story = (
    status: StoryState["status"],
    agent: string,
    builder: string | undefined,
  ): StoryState => ({
    status,
    status_by: { agent, at: "2026-10-04T12:00:00.000Z" },
    progress: null,
    results: {},
    waiting_on: [],
    ...(builder === undefined
      ? {}
      : {
          started: {
            agent: builder,
            branch: "feat/1-1-work",
            base: MAIN_COMMIT,
            base_ref: "main",
            worktree: "../shop.worktrees/1-1",
            device: "d",
            at: "2026-10-04T12:00:00.000Z",
            event: "e",
          },
        }),
  });

  it("is true only for the builder's complete result on a story in progress", () => {
    expect(resultMovesToReview(story("in_progress", "sam", "sam"), "sam", "complete")).toBe(true);
    // The builder is the one story.started records, not the last declarer.
    expect(resultMovesToReview(story("in_progress", "ethan", "sam"), "sam", "complete")).toBe(true);
    expect(resultMovesToReview(story("in_progress", "ethan", "sam"), "ethan", "complete")).toBe(
      false,
    );
    expect(resultMovesToReview(story("in_progress", "sam", undefined), "sam", "complete")).toBe(
      false,
    );
    expect(resultMovesToReview(story("in_progress", "sam", "sam"), "sam", "partial")).toBe(false);
    expect(resultMovesToReview(story("blocked", "sam", "sam"), "sam", "complete")).toBe(false);
    expect(resultMovesToReview(story("in_review", "sam", "sam"), "sam", "complete")).toBe(false);
    expect(resultMovesToReview(undefined, "sam", "complete")).toBe(false);
  });
});

describe("the stories land where the creator's workflow says", () => {
  const STAGED = {
    integration: "dev",
    production: "main",
    story_branches: true,
    ci: "remote",
    merge: "pr",
    review: true,
  } as const;

  it("starts a story from the integration branch, created from the main one", async () => {
    const { human, workspace, call, journal } = await product();
    // The stories must be on the branch they start from: the integration branch holds the main one's.
    for (const [path] of workspace.blobs) void path;
    const recorded = await recordGitWorkflow(
      human,
      { workflow: STAGED, previous: undefined },
      "terminal",
    );
    expect(recorded instanceof Error ? undefined : recorded.branch).toMatchObject({
      status: "created",
      name: "dev",
    });
    const started = await call("start_story", { agent: "ethan", story: "1-3" });
    const value = (started as { value: StoryStartResult }).value;
    expect(value).toMatchObject({ branch: "feat/1-3-work", base_ref: "dev", base: "d".repeat(40) });
    expect(journal.events.at(-1)).toMatchObject({
      payload: { base_ref: "dev", base: "d".repeat(40) },
    });
  });

  it("starts a story on the branch it lands on, with no branch nor working copy of its own", async () => {
    const { human, workspace, call, journal, state, agent } = await product();
    await recordGitWorkflow(
      human,
      { workflow: { ...STAGED, story_branches: false, merge: "direct" }, previous: undefined },
      "terminal",
    );
    const started = await call("start_story", { agent: "ethan", story: "1-3" });
    const value = (started as { value: StoryStartResult }).value;
    expect(value).toMatchObject({
      status: "started",
      branch: "dev",
      base: "d".repeat(40),
      story_branch: false,
      workdir: "/repos/shop",
    });
    expect(value.hook).toBeUndefined();
    expect(workspace.branches.size).toBe(0);
    expect(workspace.worktrees.size).toBe(0);
    expect(journal.events.at(-1)).toMatchObject({ payload: { branch: "dev", worktree: "." } });
    expect((await state()).stories["1-3"]).toMatchObject({ status: "in_progress" });
    const again = await call("start_story", { agent: "ethan", story: "1-3" });
    expect(again.ok ? again.value : undefined).toMatchObject({
      status: "resumed",
      story_branch: false,
    });
    // No pull request to open: the story goes to its review.
    const pr = await createCommandRegistry().run(
      "open_pull_request",
      { ...agent, storyForge: {} as never },
      {
        agent: "ethan",
        story: "1-3",
        criteria: [true],
        tests: { status: "passed", summary: "ok" },
      },
    );
    expect(errorOf(pr)).toMatchObject({ details: { reason: "not_wanted" } });
  });

  it("refuses to build a story on a branch the main folder is not on", async () => {
    const { human, workspace, call, journal } = await product();
    await recordGitWorkflow(
      human,
      { workflow: { ...STAGED, story_branches: false, merge: "direct" }, previous: undefined },
      "terminal",
    );
    workspace.current = "exp";
    const count = journal.events.length;
    const refused = await call("start_story", { agent: "ethan", story: "1-3" });
    expect(errorOf(refused)).toMatchObject({ details: { reason: "base_not_checked_out" } });
    expect(journal.events.length).toBe(count);
  });

  it("changes nothing for a creator who chose no workflow: the main branch, a branch per story", async () => {
    const { call } = await product();
    const started = await call("start_story", { agent: "ethan", story: "1-3" });
    expect((started as { value: StoryStartResult }).value).toMatchObject({
      base_ref: "main",
      branch: "feat/1-3-work",
    });
  });
});
