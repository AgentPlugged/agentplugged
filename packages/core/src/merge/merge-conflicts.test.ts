import { gitBlobId, toBase64url, utf8 } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode, type PhaseId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { autoOption } from "../chat/auto-apply.js";
import {
  type BranchPushOutcome,
  type CheckpointState,
  type CommandContext,
  type CommitHookInstall,
  computeProjection,
  createCommandRegistry,
  type ForgeCliState,
  type ForgeInspection,
  type ForgeMergeOutcome,
  type ForgeMergeRequest,
  type ForgePullRequest,
  type ForgeRepository,
  type ForgeReviewDraft,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type NextResult,
  type PullRequestDraft,
  type RecordedEvent,
  resolveProfile,
  type StoryDiff,
  type StoryForge,
  type StoryState,
  type StoryWorkspace,
  type StoryWorkspaceCreation,
  type StoryWorkspaceInspection,
  type StoryWorkspaceTarget,
  syncCommand,
  type ToolProbe,
  type WorktreeRemoval,
} from "../index.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";
import type {
  BranchMerge,
  ConflictFileProbe,
  ConflictHunk,
  ConflictProbe,
  MergeProbe,
} from "./merge-probe.js";

/**
 * The order of the merges, a textual conflict
 * qualified, resolved on the story's branch and reviewed again, a conflict of substance settled by
 * the creator, and every way an agent could pass one for the other.
 */

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(9));
const MAIN_COMMIT = "c".repeat(40);
const MAIN_2 = "9".repeat(40);
const HEAD_1 = "d".repeat(40);
const HEAD_2 = "e".repeat(40);
const HEAD_2B = "a".repeat(40);
const RESOLUTION = "b".repeat(40);
const MERGE_COMMIT = "f".repeat(40);

const diffOf = (paths: readonly string[]) =>
  paths
    .map(
      (path) =>
        `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n a\n+b\n`,
    )
    .join("");

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
    this.branches.set(target.branch, { commit: base, merged: true, storyBlob: null });
    this.worktrees.set(target.branch, path);
    return { worktree: path, createdBranch: true, createdWorktree: true };
  }
  async discard() {
    return true;
  }
  async readBlob(blob: string) {
    return this.texts.get(blob);
  }
  async storyFilesOn() {
    return undefined;
  }
  async installCommitHook(): Promise<CommitHookInstall> {
    return { status: "installed", path: "/repos/shop/.git/hooks/commit-msg" };
  }
  async removeWorktree(story: { id: string; branch: string }): Promise<WorktreeRemoval> {
    const path = this.worktrees.get(story.branch);
    if (path === undefined) return { status: "absent" };
    this.worktrees.delete(story.branch);
    return { status: "removed", path };
  }
  head(branch: string, commit: string) {
    this.branches.set(branch, { commit, merged: false, storyBlob: null });
  }
}

class FakeDiff implements StoryDiff {
  readonly diffs = new Map<string, string>();
  async diff(_base: string, head: string) {
    return this.diffs.get(head);
  }
}

/** A forge in memory, one pull request per story. */
class FakeForge implements StoryForge {
  readonly prs: Array<{
    number: number;
    url: string;
    state: ForgePullRequest["state"];
    title: string;
    body: string;
    branch: string;
    head: string;
  }> = [];
  readonly heads = new Map<string, string>();
  readonly merges: Array<{ number: number; request: ForgeMergeRequest }> = [];
  async inspect(branch: string): Promise<ForgeInspection> {
    return {
      repository: true,
      prefix: "",
      remotes: [{ name: "origin", url: "https://github.com/ada/shop.git" }],
      head: this.heads.get(branch) ?? null,
      commits: 2,
    };
  }
  async cli(): Promise<ForgeCliState> {
    return "ready";
  }
  async push(): Promise<BranchPushOutcome> {
    return { ok: true };
  }
  async pullRequests(_repository: ForgeRepository, branch: string) {
    return this.prs.filter((entry) => entry.branch === branch).map((entry) => ({ ...entry }));
  }
  async create(repository: ForgeRepository, draft: PullRequestDraft) {
    const number = 41 + this.prs.length;
    const url = `https://${repository.host}/${repository.path}/pull/${number}`;
    this.prs.push({
      number,
      url,
      state: "open",
      title: draft.title,
      body: draft.body,
      branch: draft.branch,
      head: this.heads.get(draft.branch) ?? "",
    });
    return { number, url };
  }
  async update(_repository: ForgeRepository, number: number) {
    const found = this.prs.find((entry) => entry.number === number);
    if (found !== undefined) found.head = this.heads.get(found.branch) ?? found.head;
  }
  async postReview(_repository: ForgeRepository, _number: number, _review: ForgeReviewDraft) {}
  async comment() {}
  async pullRequest(_repository: ForgeRepository, number: number) {
    const found = this.prs.find((entry) => entry.number === number);
    return {
      state: found?.state ?? "open",
      head: this.heads.get(found?.branch ?? "") ?? null,
      merge_commit: found?.state === "merged" ? MERGE_COMMIT : null,
    };
  }
  async merge(
    _repository: ForgeRepository,
    number: number,
    request: ForgeMergeRequest,
  ): Promise<ForgeMergeOutcome> {
    this.merges.push({ number, request });
    const found = this.prs.find((entry) => entry.number === number);
    if (found !== undefined) found.state = "merged";
    return { ok: true, merge_commit: MERGE_COMMIT };
  }
}

/** Git in memory: what merging a head into the main branch conflicts on, and the branch's merges. */
class FakeProbe implements MergeProbe {
  refs = new Map<string, string>([["origin/main", MAIN_COMMIT]]);
  probes = new Map<string, ConflictProbe>();
  texts = new Map<string, string>();
  histories = new Map<string, readonly BranchMerge[]>();
  async resolve(ref: string) {
    return this.refs.get(ref);
  }
  async probe(main: string, head: string): Promise<ConflictProbe> {
    return this.probes.get(`${main}|${head}`) ?? { status: "clean", main };
  }
  async show(commit: string, path: string) {
    return this.texts.get(`${commit}:${path}`);
  }
  notAncestors = new Set<string>();
  async isAncestor(ancestor: string, descendant: string) {
    return !this.notAncestors.has(`${ancestor}|${descendant}`);
  }
  async mergedTree() {
    return "T";
  }
  async treeOf() {
    return "T";
  }
  async merges(_base: string, head: string) {
    return this.histories.get(head) ?? [];
  }
}

const hunk = (main: string[], story: string[], base: string[] = []): ConflictHunk => ({
  main,
  base,
  story,
});
const file = (path: string, hunks: ConflictHunk[]): ConflictFileProbe => ({
  path,
  structural: false,
  hunks,
  hunks_truncated: false,
});
const conflicting = (main: string, files: ConflictFileProbe[]): ConflictProbe => ({
  status: "conflict",
  main,
  files,
  files_truncated: false,
});

function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

function storyFile(id: string) {
  return [
    "---",
    `id: ${id}`,
    "kind: story",
    "owner: sam",
    `title: Story ${id}`,
    "epic: epic-1",
    "reviewer: quentin",
    "requirements: [EF-29]",
    "budget_usd: 2",
    `branch: feat/${id}-work`,
    "depends_on: []",
    "---",
    `# Story ${id}`,
    "",
    "## Context",
    "",
    "Shop.",
    "",
    "## Intent",
    "",
    `Ada does ${id}.`,
    "",
    "## Acceptance criteria",
    "",
    "- Given Ada, when she acts, then it works.",
    "",
    "## Out of scope",
    "",
    "Nothing else.",
    "",
  ].join("\n");
}

const STORIES = ["1-1", "1-2"] as const;
type StoryId = (typeof STORIES)[number];
const branchOf = (id: string) => `feat/${id}-work`;

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
  const probe = new FakeProbe();
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("izzy", "Izzy", "product", "build"),
      ...shippedAgent("sam", "Sam", "code", "build"),
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
    mergeProbe: probe,
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const reader: CommandContext = { ...human, human: undefined };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok) {
      throw new Error(
        `${name} failed: ${result.error.code} ${JSON.stringify(result.error.details)}`,
      );
    }
    return result.value as RecordedEvent;
  };
  const resolve = (checkpoint: string | undefined, input: Record<string, unknown> = {}) =>
    registry.run("review", human, {
      action: "resolve",
      checkpoint,
      decision: "approved",
      ...input,
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
    await resolve(opened.checkpoint);
  }
  files.seed(
    ".agentplugged/docs/prd.md",
    "---\nid: prd\nkind: prd\nowner: maya\n---\n# PRD\n\nEF-29 : Order the merges.\n",
  );
  files.seed(
    ".agentplugged/epics/epic-1.md",
    "---\nid: epic-1\nkind: epic\nowner: izzy\n---\n# Epic 1\n",
  );
  const documents = [];
  for (const id of STORIES) {
    const path = `.agentplugged/stories/${id}-work.md`;
    const text = storyFile(id);
    files.seed(path, text);
    const blob = gitBlobId(utf8(text));
    workspace.blobs.set(path, blob);
    workspace.texts.set(blob, text);
    documents.push({ path, branch: "main", blob_sha: blob });
  }
  const validated = await run("open_checkpoint", {
    agent: "izzy",
    type: "document",
    risk: "medium",
    title: "Epic 1",
    summary: "The stories.",
    documents,
  });
  await resolve(validated.checkpoint);
  const productId = (await journal.productId()) as string;
  const heads: Record<StoryId, string> = { "1-1": HEAD_1, "1-2": HEAD_2 };
  const green = async (id: StoryId, commit: string) => {
    const pr = forge.prs.find((entry) => entry.branch === branchOf(id));
    await journal.appendAll([
      {
        type: "story.ci_reported",
        actor: { kind: "system" },
        product: productId,
        story: id,
        provenance: "trusted",
        payload: {
          forge: "github",
          status: "pass",
          checks: 4,
          failed: [],
          pr: pr?.number ?? 41,
          commit,
          read_at: new Date(now()).toISOString(),
        },
      },
    ]);
  };
  /** Sam sends the story to review on `commit`, its CI is read green. */
  const toReview = async (id: StoryId, commit: string) => {
    workspace.head(branchOf(id), commit);
    forge.heads.set(branchOf(id), commit);
    diff.diffs.set(commit, diff.diffs.get(commit) ?? diffOf(["src/shared.ts"]));
    // The story's one criterion has no result to observe here: declared (the gate of the proofs).
    await run("record_criterion", {
      agent: "sam",
      story: id,
      criterion: 1,
      seen: "untestable",
      note: "fixture",
    });
    await run("update_story", { agent: "sam", story: id, status: "in_review" });
    await green(id, commit);
  };
  /** Starts the story, opens its pull request, sends it to review. */
  const open = async (id: StoryId) => {
    await run("start_story", { agent: "sam", story: id });
    workspace.head(branchOf(id), heads[id]);
    forge.heads.set(branchOf(id), heads[id]);
    await run("open_pull_request", {
      agent: "sam",
      story: id,
      criteria: [true],
      tests: { status: "passed", summary: "Tests pass." },
    });
    await toReview(id, heads[id]);
  };
  const review = async (id: StoryId) =>
    call("submit_review", {
      agent: "quentin",
      story: id,
      kind: "qa",
      commit: forge.heads.get(branchOf(id)),
      summary: "Checked.",
      findings: [],
    });
  const projection = async () => (await computeProjection((await journal.list()).events)).state;
  const story = async (id: StoryId) =>
    ((await projection()).stories as Record<string, StoryState>)[id] as StoryState;
  const checkpoints = async () =>
    (await projection()).checkpoints as Record<string, CheckpointState>;
  const next = async () => {
    const result = await registry.run("next", reader, {});
    if (!result.ok) throw new Error(`next failed: ${result.error.code}`);
    return result.value as NextResult;
  };
  return {
    files,
    journal,
    workspace,
    forge,
    diff,
    probe,
    registry,
    human,
    call,
    run,
    resolve,
    open,
    toReview,
    review,
    projection,
    story,
    checkpoints,
    next,
  };
}

const errorOf = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? undefined : (result.error as { code: string; details: Record<string, unknown> });
const resultOf = <T>(result: { ok: boolean; value?: unknown }) =>
  (result.ok ? result.value : undefined) as T;
const reasonOf = (result: { ok: boolean; error?: unknown }) => errorOf(result)?.details.reason;

/** Both stories relued on a green CI, their merge checkpoints open. */
async function ready() {
  const setup = await product();
  await setup.open("1-1");
  await setup.open("1-2");
  const first = resultOf<{ checkpoint: string }>(await setup.review("1-1"));
  const second = resultOf<{ checkpoint: string }>(await setup.review("1-2"));
  return { ...setup, merges: { "1-1": first.checkpoint, "1-2": second.checkpoint } };
}

describe("the order of the merges", () => {
  it("gives the queue, and refuses a story that shares a file with an earlier one", async () => {
    const { call, resolve, merges, forge, story, next } = await ready();
    const read = resultOf<{
      queue: Array<{ story: string; position: number; waits_for: unknown[]; files: number }>;
    }>(await call("get_merge_order", { agent: "izzy" }));
    expect(read.queue.map((entry) => [entry.story, entry.position])).toEqual([
      ["1-1", 1],
      ["1-2", 2],
    ]);
    expect(read.queue[1]).toMatchObject({
      files: 1,
      waits_for: [{ story: "1-1", why: "overlap" }],
    });
    // `next` presents the merge checkpoints in the queue's order.
    expect(await next()).toMatchObject({
      step: "validation",
      checkpoint: merges["1-1"],
      merge_queue: [
        { position: 1, story: "1-1", checkpoint: merges["1-1"] },
        { position: 2, story: "1-2", checkpoint: merges["1-2"] },
      ],
    });
    // The creator answers the second first: the engine refuses, nothing is merged.
    const refused = await resolve(merges["1-2"]);
    expect(errorOf(refused)).toMatchObject({
      code: ErrorCode.MERGE_FAILED,
      details: { reason: "out_of_order", before: "1-1", why: "overlap" },
    });
    expect(forge.merges).toEqual([]);
    expect((await story("1-2")).merged).toBeUndefined();
    // In the right order both merge.
    expect((await resolve(merges["1-1"])).ok).toBe(true);
    expect((await resolve(merges["1-2"])).ok).toBe(true);
    expect(forge.merges.map((entry) => entry.number)).toEqual([41, 42]);
    expect((await story("1-2")).merged).toMatchObject({ seq: 2 });
  });

  it("presents the merge checkpoint of the first place, whatever the stories' numbers", async () => {
    const setup = await product();
    // 1-2 is reviewed before 1-1: it is first in the queue.
    await setup.open("1-1");
    await setup.open("1-2");
    const second = resultOf<{ checkpoint: string }>(await setup.review("1-2"));
    const first = resultOf<{ checkpoint: string }>(await setup.review("1-1"));
    const step = await setup.next();
    expect(step).toMatchObject({
      step: "validation",
      story: "1-2",
      checkpoint: second.checkpoint,
      merge_queue: [
        { position: 1, story: "1-2", checkpoint: second.checkpoint },
        { position: 2, story: "1-1", checkpoint: first.checkpoint },
      ],
    });
    expect(step.waiting[0]?.id).toBe(second.checkpoint);
  });

  it("lets stories with disjoint files merge in any order", async () => {
    const setup = await product();
    setup.diff.diffs.set(HEAD_1, diffOf(["src/a.ts"]));
    setup.diff.diffs.set(HEAD_2, diffOf(["src/b.ts"]));
    await setup.open("1-1");
    await setup.open("1-2");
    await setup.review("1-1");
    const second = resultOf<{ checkpoint: string }>(await setup.review("1-2"));
    expect((await setup.resolve(second.checkpoint)).ok).toBe(true);
  });

  it("reads the dependencies in the version the creator approved, not in an edited working copy", async () => {
    const setup = await product();
    setup.diff.diffs.set(HEAD_1, diffOf(["src/a.ts"]));
    setup.diff.diffs.set(HEAD_2, diffOf(["src/b.ts"]));
    await setup.open("1-1");
    await setup.open("1-2");
    await setup.review("1-1");
    const second = resultOf<{ checkpoint: string }>(await setup.review("1-2"));
    // An agent edits 1-2's header after its validation: it now depends on 1-1.
    const path = ".agentplugged/stories/1-2-work.md";
    const text = await setup.files.readText(path);
    await setup.files.writeText(path, text.replace("depends_on: []", "depends_on: [1-1]"));
    expect((await setup.resolve(second.checkpoint)).ok).toBe(true);
  });

  it("changes the order with nobody's say-so but the creator's answer", async () => {
    const { call, resolve, merges, story } = await ready();
    // An agent has no tool to order, nor to merge.
    expect(reasonOf(await call("merge_story", {}))).toBeUndefined();
    // The creator asks 1-1 for changes: it leaves the queue and 1-2 goes first.
    const sent = await resolve(merges["1-1"], {
      decision: "changes_requested",
      note: "Add a test.",
    });
    expect(sent.ok).toBe(true);
    expect((await resolve(merges["1-2"])).ok).toBe(true);
    expect((await story("1-2")).merged).toBeDefined();
    expect((await story("1-1")).status).toBe("in_progress");
  });

  it("refuses an agent that is not an active agent", async () => {
    const { call } = await ready();
    expect(errorOf(await call("get_merge_order", { agent: "ghost" }))?.code).toBe(
      ErrorCode.AGENT_NOT_FOUND,
    );
  });
});

describe("a textual conflict", () => {
  /** Story 1-2 conflicts with the main branch on two imports at the same place. */
  async function conflicted() {
    const setup = await ready();
    setup.probe.probes.set(
      `${MAIN_COMMIT}|${HEAD_2}`,
      conflicting(MAIN_COMMIT, [file("src/index.ts", [hunk(["import a"], ["import b"])])]),
    );
    // The first story merges first: the main branch moves.
    expect((await setup.resolve(setup.merges["1-1"])).ok).toBe(true);
    return setup;
  }

  it("is read by the engine, qualified by the developer alone, and sends the story back to them", async () => {
    const { call, resolve, merges, story, next, journal, forge } = await conflicted();
    // The forge would have refused: the engine reads the conflict before and says it.
    const refused = await resolve(merges["1-2"]);
    expect(errorOf(refused)).toMatchObject({
      code: ErrorCode.MERGE_FAILED,
      details: { reason: "conflict", files: ["src/index.ts"] },
    });
    expect(forge.merges).toHaveLength(1);
    const input = { story: "1-2", kind: "textual", rationale: "Two imports at the same place." };
    // Only the story's developer qualifies.
    expect(reasonOf(await call("qualify_merge_conflict", { agent: "quentin", ...input }))).toBe(
      "not_developer",
    );
    expect(
      reasonOf(await call("qualify_merge_conflict", { agent: "sam", ...input, story: "1-9" })),
    ).toBe("unknown_story");
    const qualified = resultOf<{ kind: string; files: unknown[]; checkpoint?: string }>(
      await call("qualify_merge_conflict", { agent: "sam", ...input }),
    );
    expect(qualified).toMatchObject({
      kind: "textual",
      files: [{ path: "src/index.ts", class: "additions" }],
    });
    expect(qualified.checkpoint).toBeUndefined();
    const event = journal.events.find((entry) => entry.type === "story.conflict_qualified");
    expect(event?.payload).toMatchObject({
      main: MAIN_COMMIT,
      head: HEAD_2,
      base_ref: "origin/main",
      kind: "textual",
    });
    expect(event?.actor).toMatchObject({ kind: "agent", agent: "sam" });
    // Back to Sam, who has a step of their own; asking twice is refused.
    expect((await story("1-2")).status).toBe("in_progress");
    expect(await next()).toMatchObject({
      step: "merge_conflict",
      agent: "sam",
      story: "1-2",
      merge_conflict: { kind: "textual", phase: "to_resolve", files: ["src/index.ts"] },
    });
    expect(reasonOf(await call("qualify_merge_conflict", { agent: "sam", ...input }))).toBe(
      "already_open",
    );
  });

  it("is resolved on the story's branch, reviewed again, and the merge checkpoint says so", async () => {
    const {
      call,
      run,
      resolve,
      merges,
      probe,
      workspace,
      forge,
      toReview,
      review,
      checkpoints,
      story,
    } = await conflicted();
    await run("qualify_merge_conflict", {
      agent: "sam",
      story: "1-2",
      kind: "textual",
      rationale: "Two imports at the same place.",
    });
    // Sam merges the main branch into the story's branch (MAIN_2 is the main branch now).
    probe.refs.set("origin/main", MAIN_2);
    probe.probes.set(
      `${MAIN_COMMIT}|${HEAD_2}`,
      conflicting(MAIN_COMMIT, [file("src/index.ts", [hunk(["import a"], ["import b"])])]),
    );
    probe.histories.set(HEAD_2B, [{ commit: RESOLUTION, parents: [HEAD_2, MAIN_COMMIT] }]);
    probe.probes.set(
      `${MAIN_COMMIT}|${HEAD_2}`,
      conflicting(MAIN_COMMIT, [file("src/index.ts", [hunk(["import a"], ["import b"])])]),
    );
    probe.texts.set(`${RESOLUTION}:src/index.ts`, "import a\nimport b\nrest");
    workspace.head(branchOf("1-2"), HEAD_2B);
    await call("open_pull_request", {
      agent: "sam",
      story: "1-2",
      criteria: [true],
      tests: { status: "passed", summary: "Tests pass." },
    });
    // Back to review on the new commit: the old merge checkpoint is still open.
    await toReview("1-2", HEAD_2B);
    const old = (await checkpoints())[merges["1-2"]] as CheckpointState;
    expect(old.status).toBe("open");
    expect(old.summary).toContain(HEAD_2.slice(0, 0));
    const passed = resultOf<{ outcome: string; checkpoint?: string }>(await review("1-2"));
    expect(passed.outcome).toBe("approved");
    // No second merge checkpoint: the open one is refreshed with this pass and this commit.
    expect(passed.checkpoint).toBeUndefined();
    const refreshed = (await checkpoints())[merges["1-2"]] as CheckpointState;
    expect(refreshed.summary).toContain(HEAD_2B.slice(0, 12));
    expect(refreshed.summary).toContain("pass 2");
    expect(refreshed.summary).toContain(
      "qualified a textual conflict with the main branch (src/index.ts)",
    );
    expect((await story("1-2")).merge_refresh).toMatchObject({ pass: 2, commit: HEAD_2B });
    // The branch now merges cleanly, the resolution keeps both sides: the merge goes through.
    probe.probes.delete(`${MAIN_2}|${HEAD_2B}`);
    probe.probes.set(
      `${MAIN_COMMIT}|${HEAD_2}`,
      conflicting(MAIN_COMMIT, [file("src/index.ts", [hunk(["import a"], ["import b"])])]),
    );
    const merged = await resolve(merges["1-2"]);
    expect(merged.ok).toBe(true);
    expect(forge.merges.at(-1)?.request.commit).toBe(HEAD_2B);
    expect((await story("1-2")).merged).toMatchObject({ commit: HEAD_2B });
  });

  it("is refused at the merge when the resolution lost a line, left a marker, or was never qualified", async () => {
    const { run, resolve, merges, probe, workspace, toReview, review } = await conflicted();
    await run("qualify_merge_conflict", {
      agent: "sam",
      story: "1-2",
      kind: "textual",
      rationale: "Two imports at the same place.",
    });
    probe.histories.set(HEAD_2B, [{ commit: RESOLUTION, parents: [HEAD_2, MAIN_COMMIT] }]);
    probe.probes.set(
      `${MAIN_COMMIT}|${HEAD_2}`,
      conflicting(MAIN_COMMIT, [file("src/index.ts", [hunk(["import a"], ["import b"])])]),
    );
    // Sam kept only the story's side: a choice the engine does not allow a textual conflict.
    probe.texts.set(`${RESOLUTION}:src/index.ts`, "import b\nrest");
    workspace.head(branchOf("1-2"), HEAD_2B);
    await toReview("1-2", HEAD_2B);
    await review("1-2");
    const dropped = await resolve(merges["1-2"]);
    expect(errorOf(dropped)).toMatchObject({
      code: ErrorCode.MERGE_FAILED,
      details: { reason: "conflict_dropped", files: ["src/index.ts"], commit: RESOLUTION },
    });
    probe.texts.set(`${RESOLUTION}:src/index.ts`, "import a\nimport b\n<<<<<<< main\n");
    expect(reasonOf(await resolve(merges["1-2"]))).toBe("conflict_markers");
    // The same merge commit, but a conflict nobody qualified.
    probe.histories.set(HEAD_2B, [{ commit: RESOLUTION, parents: [HEAD_2, "8".repeat(40)] }]);
    probe.notAncestors.add(`${MAIN_COMMIT}|${"8".repeat(40)}`);
    probe.probes.set(
      `${"8".repeat(40)}|${HEAD_2}`,
      conflicting("8".repeat(40), [file("src/index.ts", [hunk(["import a"], ["import b"])])]),
    );
    expect(reasonOf(await resolve(merges["1-2"]))).toBe("conflict_unqualified");
  });

  it("is qualified after the fact when its developer resolved it first, and then verified", async () => {
    const { call, run, resolve, merges, probe, workspace, forge, toReview, review } =
      await conflicted();
    // Sam merged the main branch into the story's branch without qualifying the conflict.
    probe.histories.set(HEAD_2B, [{ commit: RESOLUTION, parents: [HEAD_2, MAIN_COMMIT] }]);
    probe.probes.set(
      `${MAIN_COMMIT}|${HEAD_2}`,
      conflicting(MAIN_COMMIT, [file("src/index.ts", [hunk(["import a"], ["import b"])])]),
    );
    probe.texts.set(`${RESOLUTION}:src/index.ts`, "import a\nimport b\nrest");
    workspace.head(branchOf("1-2"), HEAD_2B);
    await call("open_pull_request", {
      agent: "sam",
      story: "1-2",
      criteria: [true],
      tests: { status: "passed", summary: "Tests pass." },
    });
    await toReview("1-2", HEAD_2B);
    await review("1-2");
    expect(reasonOf(await resolve(merges["1-2"]))).toBe("conflict_unqualified");
    // The branch merges cleanly now, yet the conflict it resolved is qualified, from the merge
    // commit's own parents; the engine reads that the resolution kept both sides.
    const qualified = resultOf<{ kind: string; files: unknown[] }>(
      await call("qualify_merge_conflict", {
        agent: "sam",
        story: "1-2",
        kind: "textual",
        rationale: "Two imports at the same place, both kept.",
      }),
    );
    expect(qualified).toMatchObject({ kind: "textual", files: [{ path: "src/index.ts" }] });
    // The story went back to its developer: it returns to review, and the pass covers it again.
    await toReview("1-2", HEAD_2B);
    await review("1-2");
    expect((await resolve(merges["1-2"])).ok).toBe(true);
    expect(forge.merges.at(-1)?.request.commit).toBe(HEAD_2B);
    expect(run).toBeDefined();
  });

  it("is refused to qualify as textual what the engine reads as more than text", async () => {
    const { call, probe } = await ready();
    probe.probes.set(
      `${MAIN_COMMIT}|${HEAD_2}`,
      conflicting(MAIN_COMMIT, [
        file("src/cart.ts", [hunk(["total = a"], ["total = b"], ["total = 0"])]),
        file("src/index.ts", [hunk(["import a"], ["import b"])]),
      ]),
    );
    const refused = await call("qualify_merge_conflict", {
      agent: "sam",
      story: "1-2",
      kind: "textual",
      rationale: "Only imports.",
    });
    expect(errorOf(refused)).toMatchObject({
      code: ErrorCode.MERGE_CONFLICT,
      details: {
        reason: "forced_substantive",
        files: ["src/cart.ts (both_modified)"],
      },
    });
  });

  it("refuses to qualify what is not a conflict, what Git cannot read, and what is done", async () => {
    const { call, probe, resolve, merges } = await ready();
    const input = { agent: "sam", story: "1-2", kind: "textual", rationale: "Imports." };
    expect(reasonOf(await call("qualify_merge_conflict", input))).toBe("no_conflict");
    probe.probes.set(`${MAIN_COMMIT}|${HEAD_2}`, { status: "unavailable" });
    expect(reasonOf(await call("qualify_merge_conflict", input))).toBe("unprovable");
    // A conflict of substance is always accepted: the agent may raise what it cannot read.
    const raised = await call("qualify_merge_conflict", {
      ...input,
      kind: "substantive",
      recommendation: "combine",
    });
    expect(raised.ok).toBe(true);
    // A story that is done is not qualified.
    expect((await resolve(merges["1-1"])).ok).toBe(true);
    expect(reasonOf(await call("qualify_merge_conflict", { ...input, story: "1-1" }))).toBe("done");
  });
});

describe("a conflict of substance", () => {
  async function substantive() {
    const setup = await ready();
    expect((await setup.resolve(setup.merges["1-1"])).ok).toBe(true);
    setup.probe.probes.set(
      `${MAIN_COMMIT}|${HEAD_2}`,
      conflicting(MAIN_COMMIT, [
        file("src/cart.ts", [hunk(["total = a"], ["total = b"], ["total = 0"])]),
      ]),
    );
    const result = await setup.call("qualify_merge_conflict", {
      agent: "sam",
      story: "1-2",
      kind: "substantive",
      rationale: "Both change how the total is computed.",
      recommendation: "keep_story",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const qualified = resultOf<{ checkpoint: string }>(result);
    return { ...setup, decision: qualified.checkpoint };
  }

  it("opens a decision with both versions and the agent's recommendation", async () => {
    const { checkpoints, decision, story, next, run } = await substantive();
    const point = (await checkpoints())[decision] as CheckpointState;
    expect(point).toMatchObject({
      type: "decision",
      source: "merge_conflict",
      story: "1-2",
      recommendation: "keep_story",
      blocks: [{ action: "story.review", story: "1-2" }],
    });
    expect(point.options?.map((option) => option.id)).toEqual([
      "keep_story",
      "keep_main",
      "combine",
    ]);
    // Never applied by the engine on its own, whatever the validation level: the creator chooses.
    expect(autoOption(point)).toBeUndefined();
    expect(point.summary).toContain("src/cart.ts [both_modified]");
    expect(point.summary).toContain("| total = a");
    expect(point.summary).toContain("| total = b");
    expect(point.summary).toContain("Both change how the total is computed.");
    // The creator decides first: the story cannot come back to review before.
    expect(await next()).toMatchObject({ step: "validation", checkpoint: decision });
    expect((await story("1-2")).status).toBe("in_progress");
    const blocked = await run("update_story", {
      agent: "sam",
      story: "1-2",
      status: "in_review",
    }).then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(blocked).toContain("CHECKPOINT_OPEN");
  });

  it("is settled by the creator, and the branch must apply their choice", async () => {
    const { call, run, resolve, merges, probe, workspace, toReview, review, decision, next } =
      await substantive();
    const chosen = await resolve(decision, { decision: "option_chosen", option: "keep_main" });
    expect(chosen.ok).toBe(true);
    expect(await next()).toMatchObject({
      step: "merge_conflict",
      agent: "sam",
      merge_conflict: {
        kind: "substantive",
        phase: "decided",
        option: "keep_main",
        checkpoint: decision,
      },
    });
    // Sam applies the choice on the branch: a merge of the main branch, main's lines kept.
    probe.histories.set(HEAD_2B, [{ commit: RESOLUTION, parents: [HEAD_2, MAIN_COMMIT] }]);
    probe.probes.set(
      `${MAIN_COMMIT}|${HEAD_2}`,
      conflicting(MAIN_COMMIT, [
        file("src/cart.ts", [hunk(["total = a"], ["total = b"], ["total = 0"])]),
      ]),
    );
    // First attempt: the story's lines were kept, against the creator's choice.
    probe.texts.set(`${RESOLUTION}:src/cart.ts`, "total = b");
    workspace.head(branchOf("1-2"), HEAD_2B);
    await call("open_pull_request", {
      agent: "sam",
      story: "1-2",
      criteria: [true],
      tests: { status: "passed", summary: "Tests pass." },
    });
    await toReview("1-2", HEAD_2B);
    await review("1-2");
    expect(errorOf(await resolve(merges["1-2"]))).toMatchObject({
      code: ErrorCode.MERGE_FAILED,
      details: { reason: "conflict_dropped", files: ["src/cart.ts"] },
    });
    // The main branch's lines kept, as chosen: it merges.
    probe.texts.set(`${RESOLUTION}:src/cart.ts`, "total = a");
    expect((await resolve(merges["1-2"])).ok).toBe(true);
    expect(run).toBeDefined();
  });

  it("keeps the story with its developer when the creator refuses every option", async () => {
    const {
      call,
      resolve,
      merges,
      probe,
      workspace,
      toReview,
      review,
      decision,
      next,
      checkpoints,
    } = await substantive();
    // The creator refuses every option: the decision is resolved without a chosen option.
    await resolve(decision, { decision: "rejected", note: "Let me think." });
    // The story stays with its developer: its return to review is still blocked.
    expect(await next()).toMatchObject({
      step: "changes_requested",
      agent: "sam",
      checkpoint: decision,
    });
    expect(
      errorOf(await call("update_story", { agent: "sam", story: "1-2", status: "in_review" }))
        ?.code,
    ).toBe(ErrorCode.CHECKPOINT_OPEN);
    // A textual qualification cannot go round it; a new conflict of substance supersedes it.
    expect(
      reasonOf(
        await call("qualify_merge_conflict", {
          agent: "sam",
          story: "1-2",
          kind: "textual",
          rationale: "Imports.",
        }),
      ),
    ).toBe("already_open");
    probe.probes.set(
      `${MAIN_COMMIT}|${HEAD_2}`,
      conflicting(MAIN_COMMIT, [
        file("src/cart.ts", [hunk(["total = a"], ["total = b"], ["total = 0"])]),
      ]),
    );
    const again = resultOf<{ checkpoint: string }>(
      await call("qualify_merge_conflict", {
        agent: "sam",
        story: "1-2",
        kind: "substantive",
        rationale: "Both change the total, I recommend combining.",
        recommendation: "combine",
      }),
    );
    expect(((await checkpoints())[again.checkpoint] as CheckpointState).supersedes).toBe(decision);
    expect(
      (await resolve(again.checkpoint, { decision: "option_chosen", option: "combine" })).ok,
    ).toBe(true);
    // Both blocks lifted: the story goes back to review.
    expect(
      (await call("update_story", { agent: "sam", story: "1-2", status: "in_review" })).ok,
    ).toBe(true);
    expect(merges).toBeDefined();
    expect(workspace).toBeDefined();
    expect(toReview).toBeDefined();
    expect(review).toBeDefined();
  });

  it("ignores a qualification an agent writes without the creator's decision", async () => {
    const { journal, productId, story } = await (async () => {
      const setup = await ready();
      return { ...setup, productId: (await setup.journal.productId()) as string };
    })();
    await journal.appendAll([
      {
        type: "story.conflict_qualified",
        actor: { kind: "agent", agent: "sam" },
        product: productId,
        story: "1-2",
        provenance: "trusted",
        payload: {
          main: MAIN_COMMIT,
          head: HEAD_2,
          base_ref: "origin/main",
          kind: "substantive",
          files: [],
          rationale: "Trust me.",
          recommendation: "keep_story",
          checkpoint: "G-0000000000",
        },
      },
    ]);
    expect((await story("1-2")).conflicts).toBeUndefined();
  });
});
