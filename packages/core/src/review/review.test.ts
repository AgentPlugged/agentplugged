import { gitBlobId, toBase64url, utf8 } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { type AnswerCheckpointParams, ErrorCode, type PhaseId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat/chat-proof.js";
import { messageDigest, normalizeChatText } from "../chat/chat-text.js";
import {
  type AgentStateView,
  type BranchPushOutcome,
  type CheckpointState,
  type CodeSource,
  type CommandContext,
  type CommitHookInstall,
  type CreatorPrompt,
  carryOutWebAnswers,
  computeProjection,
  createCommandRegistry,
  engineMerging,
  type ForgeCliState,
  type ForgeInspection,
  type ForgeMergeOutcome,
  type ForgeMergeRequest,
  type ForgePullRequest,
  type ForgeRepository,
  type ForgeReviewDraft,
  type FreeDiff,
  type FreeDiffRequest,
  initCommand,
  type MainInspection,
  MemoryKeyStore,
  MemoryStateStore,
  mergeGate,
  mergeReady,
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
  undoWebAnswer,
  type WorktreeRemoval,
  writeWebAnswer,
} from "../index.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";
import { exportPrompt } from "./review-export.js";
import { forgeText, REVIEW_MARKER, reviewDraft } from "./review-forge.js";
import {
  chooseLenses,
  creatorStack,
  planReaders,
  readerPasses,
  stackText,
} from "./review-lenses.js";
import {
  parseDiff,
  type ReviewPass,
  reviewVerdictOf,
  securityReasons,
  securityWords,
  sensitivePath,
} from "./review-rules.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

/**
 * A judge's report that gives no ruling confirms every finding of the lenses at the severity they
 * gave: the tests that are not about the judge's rulings keep reading as before.
 */
function confirming(extra: Record<string, unknown>): Record<string, unknown> {
  const judge = extra.judge as { findings?: unknown[]; silent?: true } | undefined;
  const lenses = extra.lenses as
    | Array<{ lens: string; findings?: Array<{ severity: string }> }>
    | undefined;
  if (judge === undefined || judge.silent === true) return extra;
  if (judge.findings !== undefined || lenses === undefined) return extra;
  const findings = lenses.flatMap((report) =>
    (report.findings ?? []).map((finding, index) => ({
      finding: `${report.lens}#${index + 1}`,
      status: "confirmed",
      severity: finding.severity,
      evidence: "Read the cited lines: the finding holds.",
    })),
  );
  return { ...extra, judge: { ...judge, findings } };
}

const SEED = toBase64url(new Uint8Array(32).fill(7));
const MAIN_COMMIT = "c".repeat(40);
const HEAD = "d".repeat(40);
const HEAD2 = "e".repeat(40);
const MERGE_COMMIT = "f".repeat(40);

const PLAIN_DIFF = [
  "diff --git a/src/profile.ts b/src/profile.ts",
  "index 1111111..2222222 100644",
  "--- a/src/profile.ts",
  "+++ b/src/profile.ts",
  "@@ -1,3 +1,4 @@",
  " export function profile() {",
  "+  return load();",
  "   const x = 1;",
  " }",
  "",
].join("\n");

const DEPENDENCY_DIFF = `${PLAIN_DIFF}${[
  "diff --git a/package.json b/package.json",
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -2,2 +2,3 @@",
  '   "name": "shop",',
  '+  "dependencies": { "left-pad": "1.0.0" },',
  '   "private": true',
  "",
].join("\n")}`;

/** A Git repository in memory: the story's branch and the approved story's text. */
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

  /** Changes not committed in the worktree keep it. */
  dirty = false;
  async removeWorktree(story: { id: string; branch: string }): Promise<WorktreeRemoval> {
    const path = this.worktrees.get(story.branch);
    if (path === undefined) return { status: "absent" };
    if (this.dirty) return { status: "kept", reason: "dirty", path };
    this.worktrees.delete(story.branch);
    return { status: "removed", path };
  }

  head(commit: string) {
    this.branches.set("feat/1-1-work", { commit, merged: false, storyBlob: null });
  }
}

/** The diff of the branch, by head. */
class FakeDiff implements StoryDiff {
  readonly diffs = new Map<string, string>();
  /** The messages of a branch's commits, and the diff of a free review (undefined: unreadable). */
  readonly messagesOf = new Map<string, string>();
  freeDiff: FreeDiff | undefined;
  readonly requests: FreeDiffRequest[] = [];
  async diff(_base: string, head: string) {
    return this.diffs.get(head);
  }
  async messages(_base: string, head: string) {
    return this.messagesOf.get(head);
  }
  async free(request: FreeDiffRequest) {
    this.requests.push(request);
    return this.freeDiff;
  }
}

/** A forge in memory: the pull request, the reviews and comments posted. */
class FakeForge implements StoryForge {
  cliState: ForgeCliState = "ready";
  head = HEAD;
  readonly prs: ForgePullRequest[] = [];
  readonly reviews: Array<{ number: number; review: ForgeReviewDraft }> = [];
  readonly comments: Array<{ number: number; body: string }> = [];
  failure: string | undefined;
  failOn: ((review: ForgeReviewDraft) => boolean) | undefined;

  async inspect(): Promise<ForgeInspection> {
    return {
      repository: true,
      prefix: "",
      remotes: [{ name: "origin", url: "https://github.com/ada/shop.git" }],
      head: this.head,
      commits: 2,
    };
  }
  async cli() {
    return this.cliState;
  }
  /** The main branch's remotes, and the diffs of the pull requests a free review reads. */
  readonly prDiffs = new Map<number, string>();
  async inspectMain(): Promise<MainInspection> {
    return {
      repository: true,
      prefix: "",
      remotes: [{ name: "origin", url: "https://github.com/ada/shop.git" }],
      branch: "main",
      head: MAIN_COMMIT,
    };
  }
  async pullRequestDiff(_repository: ForgeRepository, number: number) {
    const text = this.prDiffs.get(number);
    if (text === undefined) throw new Error("gh: no such pull request");
    return text;
  }
  async push(): Promise<BranchPushOutcome> {
    return { ok: true };
  }
  async pullRequests() {
    return this.prs.map((entry) => ({ ...entry }));
  }
  async create(repository: ForgeRepository, draft: PullRequestDraft) {
    const number = 41;
    const url = `https://${repository.host}/${repository.path}/pull/${number}`;
    this.prs.push({ number, url, state: "open", title: draft.title, body: draft.body });
    return { number, url };
  }
  async update() {}
  async postReview(_repository: ForgeRepository, number: number, review: ForgeReviewDraft) {
    if (this.failure !== undefined) throw new Error(this.failure);
    if (this.failOn?.(review) === true) throw new Error("gh: HTTP 502");
    this.reviews.push({ number, review });
  }
  async comment(_repository: ForgeRepository, number: number, body: string) {
    this.comments.push({ number, body });
  }
  /** The pull request's state at the forge, its head, and the merges asked. */
  prState: "open" | "closed" | "merged" = "open";
  prHead: string | undefined;
  prBase: string | undefined;
  readonly merges: Array<{ number: number; request: ForgeMergeRequest }> = [];
  mergeRefusal: { reason: "head_moved" | "not_mergeable" | "failed"; message: string } | undefined;
  onMerge: (() => Promise<void>) | undefined;
  async pullRequest() {
    return {
      state: this.prState,
      head: this.prHead ?? this.head,
      merge_commit: this.prState === "merged" ? MERGE_COMMIT : null,
      base: this.prBase,
      merged_by: this.prState === "merged" ? "ada" : null,
      merged_at: this.prState === "merged" ? "2026-10-05T14:20:00.000Z" : null,
    };
  }
  async merge(
    _repository: ForgeRepository,
    number: number,
    request: ForgeMergeRequest,
  ): Promise<ForgeMergeOutcome> {
    this.merges.push({ number, request });
    if (this.mergeRefusal !== undefined) return { ok: false, ...this.mergeRefusal };
    this.prState = "merged";
    await this.onMerge?.();
    return { ok: true, merge_commit: MERGE_COMMIT };
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

function storyFile(title: string, intent: string) {
  return [
    "---",
    "id: 1-1",
    "kind: story",
    "owner: sam",
    `title: ${title}`,
    "epic: epic-1",
    "reviewer: quentin",
    "requirements: [EF-1]",
    "budget_usd: 2",
    "branch: feat/1-1-work",
    "depends_on: []",
    "---",
    `# ${title}`,
    "",
    "## Context",
    "",
    "Profiles.",
    "",
    "## Intent",
    "",
    intent,
    "",
    "## Acceptance criteria",
    "",
    "- Given Ada, when she opens her profile, then she sees her name.",
    "",
    "## Out of scope",
    "",
    "Nothing else.",
    "",
  ].join("\n");
}

/**
 * A product in the build phase, story 1-1 validated and started by Sam, its PR open. The security
 * reviewer is a custom agent of the security domain: the review knows reviewers by their domain.
 */
async function product(
  options: { title?: string; intent?: string; warden?: boolean; codeSource?: CodeSource } = {},
) {
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
  diff.diffs.set(HEAD, PLAIN_DIFF);
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("izzy", "Izzy", "product", "build"),
      ...shippedAgent("sam", "Sam", "code", "build"),
      ...shippedAgent("quentin", "Quentin", "quality", "build"),
      ...(options.warden === false ? {} : shippedAgent("warden", "Warden", "security", "build")),
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
    ...(options.codeSource === undefined ? {} : { codeSource: options.codeSource }),
    forgeThrottleMs: 0,
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const reader: CommandContext = { ...human, human: undefined };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>, prompt?: CreatorPrompt) =>
    registry.run(name, prompt === undefined ? agent : { ...agent, creatorPrompt: prompt }, input);
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok)
      throw new Error(
        `${name} failed: ${result.error.code} ${JSON.stringify(result.error.details)}`,
      );
    return result.value as RecordedEvent;
  };
  const answer = async (checkpoint: string | undefined, decision = "approved") =>
    registry.run("review", human, { action: "resolve", checkpoint, decision });
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
    "---\nid: prd\nkind: prd\nowner: maya\n---\n# PRD\n\nEF-1 : Ada sees her profile.\n",
  );
  files.seed(
    ".agentplugged/epics/epic-1.md",
    "---\nid: epic-1\nkind: epic\nowner: izzy\n---\n# Epic 1\n",
  );
  const path = ".agentplugged/stories/1-1-profile.md";
  const text = storyFile(options.title ?? "Profile", options.intent ?? "Ada sees her profile.");
  files.seed(path, text);
  const blob = gitBlobId(utf8(text));
  workspace.blobs.set(path, blob);
  workspace.texts.set(blob, text);
  const validated = await run("open_checkpoint", {
    agent: "izzy",
    type: "document",
    risk: "medium",
    title: "Epic 1",
    summary: "The stories.",
    documents: [{ path, branch: "main", blob_sha: blob }],
  });
  await answer(validated.checkpoint);
  await run("start_story", { agent: "sam", story: "1-1" });
  workspace.head(HEAD);
  await run("open_pull_request", {
    agent: "sam",
    story: "1-1",
    criteria: [true],
    tests: { status: "passed", summary: "3 tests pass." },
  });
  const productId = (await journal.productId()) as string;
  /** The CI of the story's head, read green now (the engine's event). */
  const green = async (commit = HEAD) => {
    await journal.appendAll([
      {
        type: "story.ci_reported",
        actor: { kind: "system" },
        product: productId,
        story: "1-1",
        provenance: "trusted",
        payload: {
          forge: "github",
          status: "pass",
          checks: 4,
          failed: [],
          pr: 41,
          commit,
          read_at: new Date(now()).toISOString(),
        },
      },
    ]);
  };
  /** Sam sends the story to review, then its CI is read green. */
  const toReview = async (commit = HEAD) => {
    workspace.head(commit);
    forge.head = commit;
    // The story's one criterion has no result to observe here: declared (the gate of the proofs).
    await run("record_criterion", {
      agent: "sam",
      story: "1-1",
      criterion: 1,
      seen: "untestable",
      note: "fixture",
    });
    await run("update_story", { agent: "sam", story: "1-1", status: "in_review" });
    await green(commit);
  };
  const review = (agentId: string, kind: "qa" | "security", findings: unknown[] = [], extra = {}) =>
    call("submit_review", {
      agent: agentId,
      story: "1-1",
      kind,
      commit: forge.head,
      summary: "Checked against the story.",
      findings,
      ...confirming(extra),
    });
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
  const projection = async () => (await computeProjection((await journal.list()).events)).state;
  return {
    files,
    journal,
    workspace,
    forge,
    diff,
    registry,
    human,
    call,
    run,
    answer,
    toReview,
    green,
    review,
    next,
    state,
    projection,
    productId,
  };
}

const errorOf = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? undefined : (result.error as { code: string; details: Record<string, unknown> });
const resultValue = <T>(result: { ok: boolean; value?: unknown }) =>
  (result.ok ? result.value : undefined) as T;
const reasonOf = (result: { ok: boolean; error?: unknown }) => errorOf(result)?.details.reason;

const blocking = {
  severity: "blocking",
  title: "No test proves the empty profile",
  detail: "The criterion has no failing case.",
  path: "src/profile.ts",
  line: 2,
};
const minor = { severity: "minor", title: "Naming", path: "src/profile.ts", line: 40 };

describe("independent review", () => {
  it("refuses the developer, main, another domain and a story without a green CI", async () => {
    const { call, toReview, green } = await product();
    const start = (agent: string, kind = "qa") =>
      call("start_review", { agent, story: "1-1", kind });
    // In progress: not yet.
    expect(reasonOf(await start("quentin"))).toBe("not_in_review");
    await toReview();
    expect(reasonOf(await start("sam"))).toBe("not_independent");
    expect(reasonOf(await start("main"))).toBe("not_reviewer");
    expect(reasonOf(await start("izzy"))).toBe("not_reviewer");
    expect(reasonOf(await start("quentin", "security"))).toBe("not_reviewer");
    // The CI read on another commit than the branch's head.
    await green(HEAD2);
    expect(reasonOf(await start("quentin"))).toBe("head_moved");
    await green(HEAD);
    // Not concerned by security: no security review.
    expect(reasonOf(await start("warden", "security"))).toBe("security_not_required");
    // The submit is checked the same way, under the lock.
    const bySam = await call("submit_review", {
      agent: "sam",
      story: "1-1",
      kind: "qa",
      commit: HEAD,
      summary: "Mine is fine.",
      findings: [],
    });
    expect(errorOf(bySam)).toMatchObject({
      code: ErrorCode.REVIEW_NOT_POSSIBLE,
      details: { reason: "not_independent", developer: "sam" },
    });
  });

  it("gives the reviewer the diff in a file, reviews, sends back, sorts, and posts on the PR", async () => {
    const { call, run, files, toReview, review, next, state, forge, journal } = await product();
    await toReview();
    expect(await next()).toMatchObject({
      step: "review",
      agent: "quentin",
      story: "1-1",
      review: { pass: 1, qa: "pending", security: "unknown", reviewers: ["quentin", "warden"] },
    });
    const started = resultValue<{ diff: string; commit: string; pass: number; security: unknown }>(
      await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" }),
    );
    expect(started).toMatchObject({
      commit: HEAD,
      pass: 1,
      diff: `.agentplugged/.cache/reviews/1-1/qa-${HEAD.slice(0, 12)}.diff`,
      files: [{ path: "src/profile.ts", added: 1, removed: 0 }],
      story_file: ".agentplugged/stories/1-1-profile.md",
      requirements: ["EF-1"],
      security: { required: false, reasons: [], unavailable: false },
      previous: [],
    });
    expect(await files.readText(started.diff)).toBe(PLAIN_DIFF);
    // A blocking finding: the engine computes the verdict, the pass closes (no security needed).
    const submitted = resultValue<Record<string, unknown>>(
      await review("quentin", "qa", [blocking, minor]),
    );
    expect(submitted).toMatchObject({
      verdict: "fail",
      pass: 1,
      complete: true,
      outcome: "changes_requested",
      published: { status: "posted", forge: "github", pr: 41 },
    });
    // Posted on the PR: the finding on a changed line as a comment, the other in the text.
    expect(forge.reviews).toHaveLength(1);
    const posted = forge.reviews[0]?.review;
    expect(posted?.commit).toBe(HEAD);
    expect(posted?.comments).toEqual([
      expect.objectContaining({ path: "src/profile.ts", line: 2, old_line: null }),
    ]);
    expect(posted?.body).toContain(REVIEW_MARKER);
    expect(posted?.body).toContain("src/profile.ts:40");
    expect(journal.events.filter((event) => event.type === "story.review_published")).toHaveLength(
      1,
    );
    // The story goes back to its developer, who sorts the findings first.
    const view = await state();
    expect(view.stories["1-1"]?.status).toBe("in_progress");
    const summary = view.stories["1-1"]?.review as unknown as Record<string, unknown>;
    expect(JSON.stringify(summary)).not.toContain("No test proves");
    expect(summary).toMatchObject({ untriaged: 2, done: false });
    expect(await next()).toMatchObject({
      step: "review_triage",
      agent: "sam",
      story: "1-1",
      review: { untriaged: 2 },
    });
    // Only the developer and the reviewer read it; the reviewer reads its own only.
    expect(reasonOf(await call("get_review", { agent: "warden", story: "1-1" }))).toBe(
      "not_allowed",
    );
    const read = resultValue<{ findings: Array<{ id: string }>; untriaged: string[]; as: string }>(
      await call("get_review", { agent: "sam", story: "1-1" }),
    );
    expect(read.as).toBe("developer");
    expect(read.untriaged).toHaveLength(2);
    const [first, second] = read.findings.map((finding) => finding.id);
    // Only the developer sorts; a deferral names an item of deferred work linked to the story.
    const sort = (agent: string, items: unknown[]) =>
      call("triage_review", { agent, story: "1-1", items });
    expect(
      reasonOf(
        await sort("quentin", [{ finding: first, decision: "fix", root_cause: "Untested edge" }]),
      ),
    ).toBe("not_developer");
    expect(
      reasonOf(
        await sort("sam", [
          { finding: second, decision: "defer", root_cause: "Naming", deferred: "D-0123456789" },
        ]),
      ),
    ).toBe("deferred_unknown");
    const deferred = await run("defer_work", {
      agent: "sam",
      title: "Rename the profile helpers",
      origin: "review",
      story: "1-1",
    });
    await run("triage_review", {
      agent: "sam",
      story: "1-1",
      items: [
        { finding: first, decision: "fix", root_cause: "Untested edge" },
        { finding: second, decision: "defer", root_cause: "Naming", deferred: deferred.deferred },
      ],
    });
    expect(
      reasonOf(
        await sort("sam", [{ finding: first, decision: "reject", root_cause: "x", reason: "y" }]),
      ),
    ).toBe("already_triaged");
    const sorted = resultValue<{ root_causes: unknown[]; untriaged: string[] }>(
      await call("get_review", { agent: "sam", story: "1-1" }),
    );
    expect(sorted.untriaged).toEqual([]);
    expect(sorted.root_causes).toEqual([
      { root_cause: "Untested edge", findings: [first] },
      { root_cause: "Naming", findings: [second] },
    ]);
    // The reviewer sees the decision, never the author's reasoning.
    const own = resultValue<{ findings: Array<{ triage: { reason: unknown } | null }> }>(
      await call("get_review", { agent: "quentin", story: "1-1" }),
    );
    expect(own.findings[0]?.triage).toMatchObject({ decision: "fix", reason: null });
  });

  it("closes the review on a second pass, opens the merge checkpoint, and the story ends", async () => {
    const { call, run, toReview, review, next, projection, answer, forge, diff } = await product();
    await toReview();
    const failed = resultValue<{ review: string }>(await review("quentin", "qa", [blocking]));
    await run("triage_review", {
      agent: "sam",
      story: "1-1",
      items: [{ finding: `${failed.review}-1`, decision: "fix", root_cause: "Untested edge" }],
    });
    // Fixed on a new commit, back to review: pass 2, the earlier findings shown to their reviewer.
    diff.diffs.set(HEAD2, PLAIN_DIFF);
    await toReview(HEAD2);
    const second = resultValue<{ pass: number; previous: Array<{ decision: string }> }>(
      await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" }),
    );
    expect(second.pass).toBe(2);
    expect(second.previous).toEqual([expect.objectContaining({ decision: "fix" })]);
    // Before the review is done, the gate stays closed.
    expect(mergeGate(await projection(), "1-1").review).toBe(false);
    const passed = resultValue<{ checkpoint: string; outcome: string }>(
      await review("quentin", "qa"),
    );
    expect(passed.outcome).toBe("approved");
    expect(passed.checkpoint).toMatch(/^G-/);
    const state = await projection();
    expect(mergeGate(state, "1-1")).toEqual({
      ready: true,
      ci: "pass",
      review: true,
      deviations: 0,
      untriaged: 0,
      skipped: [],
    });
    expect(mergeReady(state, "1-1", { head: HEAD })).toBe(false);
    const merge = (state.checkpoints as Record<string, CheckpointState>)[passed.checkpoint];
    expect(merge).toMatchObject({
      type: "story",
      source: "merge",
      // A merge is undone by a git revert: reversible, a medium risk.
      risk: "medium",
      irreversible: false,
    });
    // Presented to the creator, who approves it: the story is done.
    expect(await next()).toMatchObject({ step: "validation", checkpoint: passed.checkpoint });
    const approved = await answer(passed.checkpoint);
    expect(approved.ok).toBe(true);
    // The `done` case of open_pull_request, now reachable.
    const again = await call("open_pull_request", {
      agent: "sam",
      story: "1-1",
      criteria: [true],
      tests: { status: "passed", summary: "3 tests pass." },
    });
    expect(errorOf(again)).toMatchObject({
      code: ErrorCode.PULL_REQUEST_NOT_OPENABLE,
      details: { reason: "done" },
    });
    expect(
      reasonOf(await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" })),
    ).toBe("done");
    expect(forge.reviews).toHaveLength(2);
  });

  it("waits for the security review of a concerned story, each reviewer blind to the other", async () => {
    const { call, toReview, review, next, state, diff, forge } = await product();
    diff.diffs.set(HEAD, DEPENDENCY_DIFF);
    await toReview();
    const qa = resultValue<{
      complete: boolean;
      security: { reasons: string[] };
      published: unknown;
    }>(await review("quentin", "qa", [minor]));
    expect(qa).toMatchObject({
      complete: false,
      security: { reasons: ["paths"] },
      published: { status: "pass_open" },
    });
    // Nothing posted while the pass is open; get_state shows only that QA is in.
    expect(forge.reviews).toHaveLength(0);
    // The abridged state shows the last pass; the `story` option the whole summary.
    const summary = (await state()).stories["1-1"]?.review as unknown as
      | { last?: Record<string, unknown> }
      | undefined;
    const pass = summary?.last;
    expect(pass).toMatchObject({ given: ["qa"], reviews: {}, complete: false });
    expect(await next()).toMatchObject({
      step: "review",
      agent: "warden",
      review: { qa: "done", security: "pending", reviewers: ["warden"] },
    });
    // The other reviewer reads nothing of the QA review.
    expect(reasonOf(await call("get_review", { agent: "warden", story: "1-1" }))).toBe(
      "not_allowed",
    );
    expect(
      reasonOf(await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" })),
    ).toBe("already_reviewed");
    const started = resultValue<{ security: { required: boolean } }>(
      await call("start_review", { agent: "warden", story: "1-1", kind: "security" }),
    );
    expect(started.security.required).toBe(true);
    const done = resultValue<{ complete: boolean; outcome: string }>(
      await review("warden", "security"),
    );
    expect(done).toMatchObject({ complete: true, outcome: "approved" });
    expect(forge.reviews.map((entry) => entry.review.body.split("\n")[2])).toEqual([
      "## QA review, pass 1: pass",
      "## Security review, pass 1: pass",
    ]);
    // A minor finding still waits for its triage before the merge.
    expect(await next()).toMatchObject({ step: "review_triage", agent: "sam" });
  });

  it("sends a story back to its developer when a finding of an approved pass is to be fixed", async () => {
    const { run, toReview, review, next, projection } = await product({ warden: false });
    await toReview();
    const passed = resultValue<{ review: string; outcome: string }>(
      await review("quentin", "qa", [minor, { ...minor, title: "Rounding", line: 41 }]),
    );
    expect(passed.outcome).toBe("approved");
    expect(await next()).toMatchObject({ step: "review_triage", agent: "sam" });
    // One finding rejected: nothing changes on the branch, the story stays in review.
    await run("triage_review", {
      agent: "sam",
      story: "1-1",
      items: [
        { finding: `${passed.review}-2`, decision: "reject", root_cause: "Style", reason: "Kept." },
      ],
    });
    const story = async () =>
      ((await projection()).stories as Record<string, { status: string }>)["1-1"];
    expect((await story())?.status).toBe("in_review");
    // One to fix: the code changes after the review, so the reviewed commit is no longer the one
    // to merge. The story goes back to its developer, then to a new pass, never to a merge that
    // the engine would refuse on the moved head.
    await run("triage_review", {
      agent: "sam",
      story: "1-1",
      items: [{ finding: `${passed.review}-1`, decision: "fix", root_cause: "Naming" }],
    });
    expect((await story())?.status).toBe("in_progress");
    expect(await next()).toMatchObject({ step: "build", agent: "sam", story: "1-1" });
    await toReview(HEAD2);
    expect(await next()).toMatchObject({
      step: "review",
      agent: "quentin",
      review: { pass: 2, qa: "pending" },
    });
  });

  it("asks the creator after 2 approved passes whose findings were each sent back to be fixed", async () => {
    const { run, toReview, review, projection, diff } = await product({ warden: false });
    const loops = async () =>
      Object.values((await projection()).checkpoints as Record<string, CheckpointState>).filter(
        (checkpoint) => checkpoint.source === "review_loop",
      );
    for (const [pass, commit] of [
      [1, HEAD],
      [2, HEAD2],
    ] as const) {
      diff.diffs.set(commit, PLAIN_DIFF);
      await toReview(commit);
      const passed = resultValue<{ review: string; outcome: string }>(
        await review("quentin", "qa", [minor]),
      );
      expect(passed.outcome).toBe("approved");
      await run("triage_review", {
        agent: "sam",
        story: "1-1",
        items: [{ finding: `${passed.review}-1`, decision: "fix", root_cause: "Naming" }],
      });
      expect(await loops()).toHaveLength(pass === 1 ? 0 : 1);
    }
    expect((await loops())[0]).toMatchObject({
      status: "open",
      blocks: [{ action: "story.review", story: "1-1" }],
    });
  });

  it("needs no security review without a security reviewer, and says so", async () => {
    const { toReview, review, diff } = await product({ warden: false });
    diff.diffs.set(HEAD, DEPENDENCY_DIFF);
    await toReview();
    const qa = resultValue<{ complete: boolean; security: unknown }>(await review("quentin", "qa"));
    expect(qa).toMatchObject({
      complete: true,
      security: { reasons: ["paths"], unavailable: true },
    });
  });

  it("asks the creator after 2 passes closed without agreement", async () => {
    const { toReview, review, run, projection, call } = await product();
    for (let pass = 1; pass <= 2; pass += 1) {
      await toReview();
      const failed = resultValue<{ review: string; checkpoint?: string }>(
        await review("quentin", "qa", [blocking]),
      );
      await run("triage_review", {
        agent: "sam",
        story: "1-1",
        items: [{ finding: `${failed.review}-1`, decision: "fix", root_cause: "Untested edge" }],
      });
      if (pass < 2) expect(failed.checkpoint).toBeUndefined();
      else expect(failed.checkpoint).toMatch(/^G-/);
    }
    const loop = Object.values(
      (await projection()).checkpoints as Record<string, CheckpointState>,
    ).find((checkpoint) => checkpoint.source === "review_loop");
    expect(loop).toMatchObject({
      type: "permission",
      status: "open",
      blocks: [{ action: "story.review", story: "1-1" }],
    });
    // The story cannot go back to review while it is open.
    const back = await call("update_story", { agent: "sam", story: "1-1", status: "in_review" });
    expect(errorOf(back)?.code).toBe(ErrorCode.CHECKPOINT_OPEN);
  });

  it("posts a deviation on the pull request", async () => {
    const { call, forge } = await product();
    const reported = resultValue<{ deviation: string; forge_comment: unknown }>(
      await call("report_deviation", {
        agent: "quentin",
        story: "1-1",
        requirements: ["EF-1"],
        summary: "The profile shows no name.",
      }),
    );
    expect(reported.forge_comment).toEqual({ status: "posted", forge: "github", pr: 41 });
    expect(forge.comments[0]?.number).toBe(41);
    expect(forge.comments[0]?.body).toContain(`Deviation ${reported.deviation} from EF-1`);
  });

  it("keeps the review written when the forge fails, and posts it again later", async () => {
    const { call, toReview, review, forge } = await product();
    await toReview();
    forge.failure = "gh: HTTP 502";
    const failed = resultValue<{ published: unknown }>(await review("quentin", "qa", [minor]));
    expect(failed.published).toEqual({ status: "failed", message: "gh: HTTP 502" });
    forge.failure = undefined;
    const again = resultValue<{ passes: unknown[] }>(
      await call("publish_review", { agent: "sam", story: "1-1" }),
    );
    expect(again.passes).toEqual([
      { pass: 1, published: { status: "posted", forge: "github", pr: 41 } },
    ]);
    const twice = resultValue<{ passes: unknown[] }>(
      await call("publish_review", { agent: "quentin", story: "1-1" }),
    );
    expect(twice.passes).toEqual([]);
  });

  it("never posts a review twice when the forge took only part of a pass", async () => {
    const { call, toReview, review, diff, forge } = await product();
    diff.diffs.set(HEAD, DEPENDENCY_DIFF);
    await toReview();
    await review("quentin", "qa");
    forge.failOn = (posted) => posted.body.includes("Security review,");
    const security = resultValue<{ published: unknown }>(await review("warden", "security"));
    expect(security.published).toEqual({ status: "failed", message: "gh: HTTP 502" });
    expect(forge.reviews).toHaveLength(1);
    forge.failOn = undefined;
    await call("publish_review", { agent: "sam", story: "1-1" });
    expect(forge.reviews.map((entry) => entry.review.body.split("\n")[2])).toEqual([
      "## QA review, pass 1: pass",
      "## Security review, pass 1: pass",
    ]);
  });

  it("refuses a red CI, an open pass's or an unknown finding, and a closed deferred item", async () => {
    const { call, run, journal, productId, toReview, review, workspace } = await product();
    await toReview();
    await journal.appendAll([
      {
        type: "story.ci_reported",
        actor: { kind: "system" },
        product: productId,
        story: "1-1",
        provenance: "trusted",
        payload: {
          forge: "github",
          status: "fail",
          checks: 4,
          failed: ["test"],
          pr: 41,
          commit: HEAD,
          read_at: "2026-10-04T13:00:00.000Z",
        },
      },
    ]);
    expect(
      reasonOf(await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" })),
    ).toBe("not_in_review");
    // Back to review, green: a review left open by a concerned story.
    workspace.head(HEAD);
    await toReview();
    const failed = resultValue<{ review: string }>(await review("quentin", "qa", [blocking]));
    const sort = (items: unknown[]) => call("triage_review", { agent: "sam", story: "1-1", items });
    expect(
      reasonOf(await sort([{ finding: "R-0123456789-1", decision: "fix", root_cause: "x" }])),
    ).toBe("unknown_finding");
    const deferred = await run("defer_work", {
      agent: "sam",
      title: "Later",
      origin: "review",
      story: "1-1",
    });
    await run("complete_deferred", { agent: "sam", item: deferred.deferred, reason: "Done." });
    expect(
      reasonOf(
        await sort([
          {
            finding: `${failed.review}-1`,
            decision: "defer",
            root_cause: "x",
            deferred: deferred.deferred,
          },
        ]),
      ),
    ).toBe("deferred_unknown");
  });

  it("keeps a finding of an open pass from its developer, until the pass closes", async () => {
    const { call, toReview, review, diff } = await product();
    diff.diffs.set(HEAD, DEPENDENCY_DIFF);
    await toReview();
    const qa = resultValue<{ review: string }>(await review("quentin", "qa", [blocking]));
    const read = resultValue<{ findings: unknown[] }>(
      await call("get_review", { agent: "sam", story: "1-1" }),
    );
    expect(read.findings).toEqual([]);
    expect(
      reasonOf(
        await call("triage_review", {
          agent: "sam",
          story: "1-1",
          items: [{ finding: `${qa.review}-1`, decision: "reject", root_cause: "x", reason: "y" }],
        }),
      ),
    ).toBe("pass_open");
  });

  it("closes a pass left open by a new commit: its blocking finding still waits for triage", async () => {
    const { toReview, review, diff, projection, next } = await product();
    diff.diffs.set(HEAD, DEPENDENCY_DIFF);
    diff.diffs.set(HEAD2, DEPENDENCY_DIFF);
    await toReview();
    await review("quentin", "qa", [blocking]);
    // A new commit, read green, reviewed: the pass left open is closed as it stands.
    await toReview(HEAD2);
    await review("quentin", "qa");
    const passes = (
      (await projection()).stories as Record<string, { review: { passes: ReviewPass[] } }>
    )["1-1"]?.review.passes;
    expect(passes?.[0]).toMatchObject({ complete: true, outcome: "changes_requested" });
    expect(await next()).toMatchObject({ step: "review_triage", agent: "sam" });
  });

  it("gives each reviewer its own review only, never the developer's words", async () => {
    const { call, run, toReview, review, diff } = await product();
    diff.diffs.set(HEAD, DEPENDENCY_DIFF);
    await toReview();
    await review("quentin", "qa", [minor]);
    const sec = resultValue<{ review: string }>(await review("warden", "security", [minor]));
    const ids = resultValue<{ findings: Array<{ id: string }> }>(
      await call("get_review", { agent: "sam", story: "1-1" }),
    ).findings.map((finding) => finding.id);
    await run("triage_review", {
      agent: "sam",
      story: "1-1",
      items: ids.map((finding) => ({
        finding,
        decision: "reject",
        root_cause: "The reviewer misread the spec",
        reason: "Out of scope.",
      })),
    });
    const own = resultValue<{
      findings: Array<{ id: string; triage: unknown }>;
      root_causes: unknown[];
      as: string;
    }>(await call("get_review", { agent: "warden", story: "1-1" }));
    expect(own.as).toBe("reviewer");
    expect(own.findings.map((finding) => finding.id)).toEqual([`${sec.review}-1`]);
    expect(own.findings[0]?.triage).toEqual({
      decision: "reject",
      root_cause: null,
      reason: null,
      deferred: null,
    });
    expect(own.root_causes).toEqual([]);
  });

  it("allows 2 more passes once the creator approves the loop's checkpoint", async () => {
    const { toReview, review, run, call, answer } = await product();
    let loop: string | undefined;
    for (let pass = 1; pass <= 2; pass += 1) {
      await toReview();
      const failed = resultValue<{ review: string; checkpoint?: string }>(
        await review("quentin", "qa", [blocking]),
      );
      await run("triage_review", {
        agent: "sam",
        story: "1-1",
        items: [{ finding: `${failed.review}-1`, decision: "fix", root_cause: "Untested edge" }],
      });
      loop = failed.checkpoint;
    }
    expect((await answer(loop)).ok).toBe(true);
    const back = await call("update_story", { agent: "sam", story: "1-1", status: "in_review" });
    expect(back.ok).toBe(true);
  });

  it("lets the creator merge as it is at the loop's checkpoint, the remaining findings accepted", async () => {
    const { toReview, review, run, call, registry, human, projection, next } = await product();
    let loop: string | undefined;
    for (let pass = 1; pass <= 2; pass += 1) {
      await toReview();
      const failed = resultValue<{ review: string; checkpoint?: string }>(
        await review("quentin", "qa", [blocking]),
      );
      // The last pass's finding is left unsorted: the creator's choice accepts it as it is.
      if (pass < 2) {
        await run("triage_review", {
          agent: "sam",
          story: "1-1",
          items: [{ finding: `${failed.review}-1`, decision: "fix", root_cause: "Untested edge" }],
        });
      }
      loop = failed.checkpoint;
    }
    const point = ((await projection()).checkpoints as Record<string, CheckpointState>)[
      loop as string
    ];
    expect(point?.options?.map((option) => option.id)).toEqual(["more_passes", "merge_as_is"]);
    expect(point?.recommendation).toBe("more_passes");
    const chosen = await registry.run("review", human, {
      action: "resolve",
      checkpoint: loop,
      decision: "option_chosen",
      option: "merge_as_is",
    });
    expect(chosen.ok).toBe(true);
    const skips = (await projection()).skips as Record<
      string,
      { step: string; checkpoint: string }
    >;
    expect(skips["story_review@1-1"]).toMatchObject({ step: "story_review", checkpoint: loop });
    // The finding left unsorted no longer holds the story: no triage step, no silent partial.
    expect((await next()).step).not.toBe("review_triage");
    const partial = await call("submit_result", {
      agent: "sam",
      story: "1-1",
      status: "partial",
      summary: "Merged as it is on the creator's choice.",
      assumptions: [],
      open_questions: [],
      conflicts: [],
    });
    expect(partial.ok).toBe(true);
  });

  it("holds an agent's own story checkpoint for good, and checks the branch's head", async () => {
    const { run, toReview, review, answer, workspace, projection } = await product();
    await toReview();
    const own = await run("open_checkpoint", {
      agent: "sam",
      type: "story",
      risk: "low",
      title: "Pick the font",
      summary: "Which font?",
      story: "1-1",
    });
    const passed = resultValue<{ checkpoint: string }>(await review("quentin", "qa"));
    // The engine opens its own merge checkpoint all the same.
    expect(passed.checkpoint).toMatch(/^G-/);
    expect(passed.checkpoint).not.toBe(own.checkpoint);
    expect(errorOf(await answer(own.checkpoint))?.code).toBe(ErrorCode.MERGE_NOT_READY);
    // The branch moved on since its review: the merge waits.
    workspace.head(HEAD2);
    expect(errorOf(await answer(passed.checkpoint))?.code).toBe(ErrorCode.MERGE_NOT_READY);
    workspace.head(HEAD);
    expect((await answer(passed.checkpoint)).ok).toBe(true);
    const checkpoints = (await projection()).checkpoints as Record<string, CheckpointState>;
    expect(checkpoints[passed.checkpoint]?.status).toBe("resolved");
  });

  it("says when a deviation cannot be posted, and keeps it", async () => {
    const { call, forge } = await product();
    forge.cliState = "logged_out";
    const reported = resultValue<{ deviation: string; forge_comment: unknown }>(
      await call("report_deviation", {
        agent: "quentin",
        story: "1-1",
        requirements: ["EF-1"],
        summary: "No name.",
      }),
    );
    expect(reported.deviation).toMatch(/^V-/);
    expect(reported.forge_comment).toEqual({ status: "skipped", reason: "not_linked" });
  });

  it("ignores in the journal main, a verdict that does not follow, another commit", async () => {
    const { journal, toReview, projection, productId } = await product();
    await toReview();
    const write = (agent: string, payload: Record<string, unknown>) =>
      journal.appendAll([
        {
          type: "story.reviewed",
          actor: { kind: "agent", agent },
          product: productId,
          story: "1-1",
          provenance: "trusted",
          payload: {
            kind: "qa",
            commit: HEAD,
            summary: "x",
            findings: [],
            verdict: "pass",
            security: { reasons: [] },
            ...payload,
          },
        },
      ]);
    await write("main", {});
    await write("quentin", { findings: [{ severity: "blocking", title: "x" }] });
    await write("quentin", { commit: HEAD2 });
    await write("warden", { kind: "security" });
    const state = await projection();
    expect((state.stories as Record<string, { review?: unknown }>)["1-1"]?.review).toBeUndefined();
  });

  it("ignores a review the developer writes in the journal itself", async () => {
    const { journal, toReview, projection, productId } = await product();
    await toReview();
    await journal.appendAll([
      {
        type: "story.reviewed",
        actor: { kind: "agent", agent: "sam" },
        product: productId,
        story: "1-1",
        provenance: "trusted",
        payload: {
          kind: "qa",
          commit: HEAD,
          summary: "Mine is fine.",
          findings: [],
          verdict: "pass",
          security: { reasons: [] },
        },
      },
    ]);
    const state = await projection();
    expect((state.stories as Record<string, { review?: unknown }>)["1-1"]?.review).toBeUndefined();
    expect(mergeGate(state, "1-1").review).toBe(false);
  });
});

describe("review rules", () => {
  it("computes the verdict from the findings", () => {
    expect(reviewVerdictOf([])).toBe("pass");
    expect(reviewVerdictOf([{ severity: "minor" }])).toBe("pass");
    expect(reviewVerdictOf([{ severity: "should_fix" }, { severity: "minor" }])).toBe(
      "pass_with_reservations",
    );
    expect(reviewVerdictOf([{ severity: "should_fix" }, { severity: "blocking" }])).toBe("fail");
  });

  it("finds security in paths of any language, and in the story's words", () => {
    for (const path of [
      "package.json",
      "backend/go.sum",
      "Cargo.lock",
      ".github/workflows/ci.yml",
      "infra/main.tf",
      "Dockerfile",
      ".env.production",
      "src/auth/session.rb",
      "app/Services/PaymentGateway.php",
      "lib/crypto_utils.ex",
      "web/src/LoginForm.tsx",
    ]) {
      expect(sensitivePath(path), path).toBe(true);
    }
    for (const path of ["src/profile.ts", "docs/readme.md", "app/views/home.html"]) {
      expect(sensitivePath(path), path).toBe(false);
    }
    expect(securityWords("Ada se connecte avec son mot de passe")).toBe(true);
    expect(securityWords("Chiffrer les données personnelles")).toBe(true);
    expect(securityWords("Ada voit son profil")).toBe(false);
    expect(securityWords("The author's name is shown")).toBe(false);
    expect(
      securityReasons({ paths: ["src/a.ts"], text: "", securityReviewer: true, qaFlag: true }),
    ).toEqual(["reviewer", "qa_flag"]);
  });

  it("reads the lines of a diff a comment may sit on", () => {
    const [file, manifest] = parseDiff(DEPENDENCY_DIFF);
    expect(file).toMatchObject({ path: "src/profile.ts", added: 1, removed: 0 });
    expect([...(file?.lines ?? [])]).toEqual([
      [1, 1],
      [2, null],
      [3, 2],
      [4, 3],
    ]);
    expect(manifest?.path).toBe("package.json");
    expect(
      parseDiff("diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n"),
    ).toEqual([expect.objectContaining({ path: "y", old_path: "x", added: 0 })]);
  });

  it("makes an agent's text inert before the forge", () => {
    const text = forgeText("Ping @org/team\n/approve\n![x](https://e.vil/?k)\n<!-- Generated -->");
    expect(text).not.toMatch(/@org/);
    expect(text).toContain("\\/approve");
    expect(text).toContain("!\\[x]");
    expect(text).not.toContain("<!--");
  });

  it("drafts a review: comments on changed lines, the rest in the text", () => {
    const pass = {
      number: 3,
      since: "2026-10-04T12:00:00.000Z",
      commit: HEAD,
      reviews: {},
      security: { reasons: [] },
      complete: true,
      outcome: "approved",
      completed_at: "2026-10-04T12:00:00.000Z",
      closed_by: null,
      published: {},
    } as ReviewPass;
    const drafted = reviewDraft(
      pass,
      {
        id: "R-0123456789",
        kind: "qa",
        event: "x",
        by: "quentin",
        at: "2026-10-04T12:00:00.000Z",
        verdict: "pass_with_reservations",
        summary: "Fine.",
        findings: [
          {
            id: "R-0123456789-1",
            severity: "should_fix",
            title: "Edge",
            path: "src/profile.ts",
            line: 3,
            triage: null,
          },
          { id: "R-0123456789-2", severity: "minor", title: "General", triage: null },
        ],
      },
      parseDiff(PLAIN_DIFF),
    );
    expect(drafted).toMatchObject({ comments: 1, notes: 1 });
    expect(drafted.draft.comments[0]).toMatchObject({ line: 3, old_line: 2 });
    expect(drafted.draft.body).toContain("## QA review, pass 3: pass with reservations");
    expect(drafted.draft.body).toContain("Security review: not needed for this story.");
  });
});

describe("merge after validation", () => {
  /** A story relued on a green CI, its merge checkpoint open and presented. */
  async function ready(options: Parameters<typeof product>[0] & { mode?: string } = {}) {
    const setup = await product(options);
    if (options.mode !== undefined) {
      const text = await setup.files.readText(".agentplugged/method.yaml");
      await setup.files.writeText(
        ".agentplugged/method.yaml",
        `${text}validation:\n  mode: ${options.mode}\n`,
      );
    }
    await setup.toReview();
    const passed = resultValue<{ checkpoint: string }>(await setup.review("quentin", "qa"));
    const story = async () =>
      ((await setup.projection()).stories as Record<string, StoryState>)["1-1"] as StoryState;
    const checkpoint = async () =>
      ((await setup.projection()).checkpoints as Record<string, CheckpointState>)[
        passed.checkpoint
      ] as CheckpointState;
    return { ...setup, merge: passed.checkpoint, story, checkpoint };
  }

  it("merges the reviewed commit at the terminal, records it, removes the worktree", async () => {
    const { answer, forge, merge, story, next, workspace } = await ready();
    expect(workspace.worktrees.has("feat/1-1-work")).toBe(true);
    const approved = await answer(merge);
    expect(approved.ok).toBe(true);
    expect(resultValue<{ merged: unknown }>(approved).merged).toMatchObject({
      story: "1-1",
      pr: 41,
      commit: HEAD,
      merge_commit: MERGE_COMMIT,
      method: "merge",
      already: false,
      files: 1,
      worktree: { status: "removed" },
    });
    expect(forge.merges).toEqual([{ number: 41, request: { commit: HEAD, method: "merge" } }]);
    expect((await story()).merged).toMatchObject({
      checkpoint: merge,
      pr: 41,
      commit: HEAD,
      files: ["src/profile.ts"],
      source: "terminal",
      seq: 1,
      by: null,
    });
    expect(workspace.worktrees.has("feat/1-1-work")).toBe(false);
    // Delivered: `next` no longer proposes it.
    expect((await next()).story).not.toBe("1-1");
  });

  it("merges from the chat with one answer, proved or not, and no confirmation", async () => {
    const { call, forge, merge, story, checkpoint } = await ready();
    const input = {
      agent: "main",
      checkpoint: merge,
      decision: "approved",
      quote: "ok, fusionne",
      session: "s-1",
    };
    // A second message that confirms is refused: the engine asks none.
    expect(
      errorOf(
        await call("answer_checkpoint", {
          ...input,
          confirmation_quote: "oui, fusionne la story 1-1",
        }),
      )?.code,
    ).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(forge.merges).toEqual([]);
    // Without the hook's proof, the one answer merges, recorded unverified.
    const unproved = await call("answer_checkpoint", input);
    expect(unproved.ok).toBe(true);
    expect(forge.merges).toHaveLength(1);
    expect((await story()).merged).toMatchObject({ source: "chat", by: "main" });
    expect((await checkpoint()).resolution).toMatchObject({
      assurance: "chat_unverified",
      source: "chat",
      relayed_by: "main",
      quote: "ok, fusionne",
    });
    // With the hook, the same one answer carries its proof.
    const hooked = await ready();
    const opened = Date.parse((await hooked.checkpoint()).opened_at);
    const normalized = normalizeChatText("ok, fusionne");
    const messages: ChatMessage[] = [
      {
        session: "s-1",
        at: new Date(opened + 10).toISOString(),
        digest: messageDigest(normalized),
        text: normalized,
      },
    ];
    const withHook: CommandContext = {
      ...hooked.human,
      actor: "agent",
      human: undefined,
      chat: { log: { messages: async () => messages }, hooked: true, hookInstalled: true },
    };
    const proved = await hooked.registry.run("answer_checkpoint", withHook, {
      ...input,
      checkpoint: hooked.merge,
    });
    expect(proved.ok).toBe(true);
    expect((await hooked.checkpoint()).resolution?.assurance).toBe("chat");
  });

  it("records a pull request the creator already merged at the forge, without any answer", async () => {
    const { call, forge, merge, story } = await ready();
    forge.prState = "merged";
    const result = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: merge,
      decision: "approved",
      quote: "oui, je l'ai déjà fusionnée",
      session: "s-1",
    });
    // The engine saw the merge first: nothing left to answer, nothing to regularise.
    expect(errorOf(result)?.code).toBe(ErrorCode.CHECKPOINT_NOT_OPEN);
    expect(forge.merges).toEqual([]);
    expect((await story()).merged).toMatchObject({ already: true, source: "forge" });
  });

  it("merges from the AI tool's form with one click and no box", async () => {
    const { call, forge, merge, story } = await ready();
    const port: CreatorPrompt = {
      channel: "claude-code",
      ask: async (prompt) => ({
        action: "accept" as const,
        content: {
          choice: prompt.choices.find((choice) => choice.decision === "approved")?.id ?? "",
        },
      }),
    };
    const clicked = await call("ask_creator", { agent: "main", checkpoint: merge }, port);
    expect(resultValue<{ answered: boolean; merged: unknown }>(clicked)).toMatchObject({
      answered: true,
      merged: { pr: 41, commit: HEAD },
    });
    expect(forge.merges).toHaveLength(1);
    expect((await story()).merged).toMatchObject({ source: "elicitation" });
  });

  it("keeps the proof of the hook for a merge at the strict level only (terminal otherwise)", async () => {
    const { call, forge, merge, answer } = await ready({ mode: "strict" });
    const chat = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: merge,
      decision: "approved",
      quote: "ok",
      session: "s-1",
    });
    expect(errorOf(chat)).toMatchObject({
      code: ErrorCode.REVIEW_REQUIRED,
      details: { reason: "unverified_merge" },
    });
    expect(forge.merges).toEqual([]);
    expect((await answer(merge)).ok).toBe(true);
    expect(forge.merges).toHaveLength(1);
  });

  it("never merges a branch that moved on", async () => {
    const moved = await ready();
    moved.workspace.head(HEAD2);
    expect(errorOf(await moved.answer(moved.merge))?.code).toBe(ErrorCode.MERGE_NOT_READY);
    expect(moved.forge.merges).toEqual([]);
  });

  it("says a worktree already gone is absent, the merge done", async () => {
    const { answer, merge, workspace } = await ready();
    workspace.worktrees.clear();
    expect(resultValue<{ merged: unknown }>(await answer(merge)).merged).toMatchObject({
      worktree: { status: "absent" },
    });
  });

  it("writes nothing when the forge refuses, then merges on the next answer", async () => {
    const { answer, forge, merge, story, checkpoint } = await ready();
    forge.mergeRefusal = { reason: "not_mergeable", message: "gh: Pull Request is not mergeable" };
    expect(errorOf(await answer(merge))).toMatchObject({
      code: ErrorCode.MERGE_FAILED,
      details: { reason: "not_mergeable", story: "1-1", checkpoint: merge },
    });
    expect((await checkpoint()).status).toBe("open");
    expect((await story()).merged).toBeUndefined();
    forge.mergeRefusal = undefined;
    expect((await answer(merge)).ok).toBe(true);
    expect((await story()).merged?.pr).toBe(41);
  });

  it("refuses without a linked forge, a moved or closed pull request", async () => {
    const { answer, forge, merge, story } = await ready();
    forge.cliState = "logged_out";
    expect(errorOf(await answer(merge))).toMatchObject({
      code: ErrorCode.FORGE_NOT_LINKED,
      details: { reason: "not_logged_in" },
    });
    forge.cliState = "missing";
    expect(reasonOf(await answer(merge))).toBe("cli_missing");
    forge.cliState = "ready";
    forge.prHead = HEAD2;
    expect(errorOf(await answer(merge))).toMatchObject({
      code: ErrorCode.MERGE_FAILED,
      details: { reason: "head_moved" },
    });
    forge.prHead = undefined;
    forge.prState = "closed";
    expect(reasonOf(await answer(merge))).toBe("pull_request_closed");
    expect(forge.merges).toEqual([]);
    expect((await story()).merged).toBeUndefined();
  });

  it("records a merge the forge already holds on the reviewed commit, without merging again", async () => {
    const { answer, forge, merge, story } = await ready();
    forge.prState = "merged";
    expect(errorOf(await answer(merge))?.code).toBe(ErrorCode.CHECKPOINT_NOT_OPEN);
    expect(forge.merges).toEqual([]);
    expect((await story()).merged).toMatchObject({
      already: true,
      merge_commit: MERGE_COMMIT,
      source: "forge",
    });
  });

  it("says a merge was not recorded when the checkpoint was answered meanwhile", async () => {
    const { registry: commands, human, forge, merge, answer, story } = await ready();
    forge.onMerge = async () => {
      await commands.run("review", human, {
        action: "resolve",
        checkpoint: merge,
        decision: "rejected",
        note: "Not now.",
      });
    };
    expect(errorOf(await answer(merge))).toMatchObject({
      code: ErrorCode.MERGE_FAILED,
      details: { reason: "not_recorded", url: "https://github.com/ada/shop/pull/41" },
    });
    // The forge shows it merged: the engine records it as the creator's gesture.
    expect((await story()).merged).toMatchObject({ source: "forge" });
  });

  it("keeps a worktree with changes not committed", async () => {
    const { answer, merge, workspace } = await ready();
    workspace.dirty = true;
    const approved = await answer(merge);
    expect(resultValue<{ merged: unknown }>(approved).merged).toMatchObject({
      worktree: { status: "kept", reason: "dirty" },
    });
  });

  it("sends the story back to its developer with the creator's note, merging nothing", async () => {
    const { registry: commands, human, forge, merge, story, next } = await ready();
    const sent = await commands.run("review", human, {
      action: "resolve",
      checkpoint: merge,
      decision: "changes_requested",
      note: "Add a test for the empty profile.",
    });
    expect(sent.ok).toBe(true);
    expect(forge.merges).toEqual([]);
    expect(await story()).toMatchObject({
      status: "in_progress",
      status_by: { agent: "sam" },
      merge_feedback: {
        checkpoint: merge,
        decision: "changes_requested",
        note: "Add a test for the empty profile.",
      },
    });
    expect((await story()).merged).toBeUndefined();
    expect(await next()).toMatchObject({
      step: "merge_changes",
      agent: "sam",
      story: "1-1",
      command: "npx agentplugged story start 1-1",
      merge_feedback: { decision: "changes_requested", note: "Add a test for the empty profile." },
    });
  });

  it("ignores a story.merged that no approval in the same write announces", async () => {
    const { journal, productId, merge, story } = await ready();
    const [forged] = await journal.appendAll([
      {
        type: "story.merged",
        actor: { kind: "agent", agent: "sam" },
        product: productId,
        story: "1-1",
        provenance: "trusted",
        payload: {
          checkpoint: merge,
          forge: "github",
          pr: 41,
          url: "https://github.com/ada/shop/pull/41",
          commit: HEAD,
          method: "merge",
          files: [],
          source: "chat",
        },
      },
    ]);
    const projected = await computeProjection((await journal.list()).events);
    expect(projected.ignored).toContainEqual({ id: forged?.id, reason: "invalid" });
    expect((await story()).merged).toBeUndefined();
  });
});

describe("the single stack and the merges of the agents", () => {
  /** A story reviewed on a green CI, its merge checkpoint open, and a plain document beside it. */
  async function waiting(points?: readonly string[]) {
    const setup = await product();
    if (points !== undefined) {
      const text = (await setup.files.readText(".agentplugged/method.yaml")) as string;
      await setup.files.writeText(
        ".agentplugged/method.yaml",
        `${text}validation:\n  points: [${points.join(", ")}]\n`,
      );
    }
    await setup.toReview();
    const passed = resultValue<{ checkpoint: string }>(await setup.review("quentin", "qa"));
    const story = async () =>
      ((await setup.projection()).stories as Record<string, StoryState>)["1-1"] as StoryState;
    const checkpoint = async (id = passed.checkpoint) =>
      ((await setup.projection()).checkpoints as Record<string, CheckpointState>)[
        id
      ] as CheckpointState;
    return { ...setup, merge: passed.checkpoint, story, checkpoint };
  }

  const DOC = {
    agent: "main",
    type: "document",
    risk: "low",
    title: "A document",
    summary: "Read it, then approve it.",
  };

  it("merges the story whose point is in the stack the creator answers once, in the same write", async () => {
    const { call, forge, merge, story, checkpoint } = await waiting();
    const other = resultValue<RecordedEvent>(await call("open_checkpoint", DOC)).checkpoint;
    const opened = await call("open_stack", { agent: "main", checkpoints: [merge, other] });
    expect(opened.ok).toBe(true);
    const stack = resultValue<{ stack: string }>(opened).stack;
    const answered = await call("answer_stack", {
      agent: "main",
      stack,
      quote: "j'approuve tout",
      session: "s-1",
    });
    expect(answered.ok).toBe(true);
    const value = resultValue<{ approved: unknown[]; merged: unknown[] }>(answered);
    expect(value.approved).toHaveLength(2);
    expect(value.merged).toMatchObject([
      { story: "1-1", pr: 41, commit: HEAD, worktree: { status: "removed" } },
    ]);
    expect(forge.merges).toEqual([{ number: 41, request: { commit: HEAD, method: "merge" } }]);
    expect((await story()).merged).toMatchObject({ checkpoint: merge, source: "chat", by: "main" });
    expect((await checkpoint()).resolution).toMatchObject({ source: "chat", stack });
  });

  it("leaves a merge the forge refuses open, and approves the other points of the stack", async () => {
    const { call, forge, merge, story, checkpoint } = await waiting();
    forge.mergeRefusal = { reason: "not_mergeable", message: "conflict" };
    const other = resultValue<RecordedEvent>(await call("open_checkpoint", DOC)).checkpoint;
    const opened = await call("open_stack", { agent: "main", checkpoints: [merge, other] });
    const stack = resultValue<{ stack: string }>(opened).stack;
    const answered = await call("answer_stack", {
      agent: "main",
      stack,
      quote: "j'approuve tout",
      session: "s-1",
    });
    expect(answered.ok).toBe(true);
    const value = resultValue<{ approved: Array<{ checkpoint: string }>; merge_failed: unknown[] }>(
      answered,
    );
    expect(value.approved.map((entry) => entry.checkpoint)).toEqual([other]);
    expect(value.merge_failed).toMatchObject([
      { checkpoint: merge, story: "1-1", code: ErrorCode.MERGE_FAILED, reason: "not_mergeable" },
    ]);
    expect((await story()).merged).toBeUndefined();
    expect((await checkpoint()).status).toBe("open");
    // A message that names only the merge that failed writes nothing and says why.
    const failed = await call("answer_stack", {
      agent: "main",
      stack,
      quote: "j'approuve 1",
      session: "s-1",
    });
    expect(errorOf(failed)?.code).toBe(ErrorCode.MERGE_FAILED);
  });

  it("merges the story when the agent responsible decides its point, the creator not keeping the merges", async () => {
    const { call, forge, merge, story, checkpoint } = await waiting(["framing"]);
    const decided = await call("decide_checkpoint", {
      agent: "main",
      checkpoint: merge,
      decision: "approved",
      reason: "Review done, CI green, nothing outside the story.",
    });
    expect(decided.ok).toBe(true);
    expect(resultValue<{ merged: unknown }>(decided).merged).toMatchObject({
      story: "1-1",
      pr: 41,
      commit: HEAD,
      worktree: { status: "removed" },
    });
    expect(forge.merges).toHaveLength(1);
    expect((await story()).merged).toMatchObject({
      checkpoint: merge,
      source: "agent",
      by: "main",
    });
    expect((await checkpoint()).resolution).toMatchObject({
      source: "agent",
      assurance: "agent",
      note: "Review done, CI green, nothing outside the story.",
    });
    // A merge already done is undone by a git revert, never by reopening its point.
    const reopened = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: merge,
      decision: "reopen",
      quote: "non, annule",
      session: "s-1",
    });
    expect(errorOf(reopened)?.code).toBe(ErrorCode.CHECKPOINT_NOT_REOPENABLE);
  });

  it("sends the story back to its developer when the agent responsible refuses the merge", async () => {
    const { call, forge, merge, story } = await waiting(["framing"]);
    const refused = await call("decide_checkpoint", {
      agent: "main",
      checkpoint: merge,
      decision: "changes_requested",
      reason: "The empty profile has no test.",
    });
    expect(refused.ok).toBe(true);
    expect(forge.merges).toEqual([]);
    expect(await story()).toMatchObject({
      status: "in_progress",
      merge_feedback: {
        checkpoint: merge,
        decision: "changes_requested",
        note: "The empty profile has no test.",
      },
    });
  });

  it("never merges by an agent's decision a story that changes the creator's settings", async () => {
    const setup = await waiting(["framing"]);
    setup.diff.diffs.set(
      HEAD,
      `${PLAIN_DIFF}${[
        "diff --git a/.agentplugged/method.yaml b/.agentplugged/method.yaml",
        "--- a/.agentplugged/method.yaml",
        "+++ b/.agentplugged/method.yaml",
        "@@ -1,1 +1,2 @@",
        " format_version: 2",
        "+validation: { points: [] }",
        "",
      ].join("\n")}`,
    );
    const refused = await setup.call("decide_checkpoint", {
      agent: "main",
      checkpoint: setup.merge,
      decision: "approved",
      reason: "Looks fine.",
    });
    expect(errorOf(refused)).toMatchObject({ details: { why: "touches_settings" } });
    expect(setup.forge.merges).toEqual([]);
    // The point goes back to the creator, so that next does not offer it again and again.
    expect((await setup.checkpoint()).escalated).toMatchObject({ by: "main" });
  });

  it("never decides a merge the creator keeps, and merges nothing", async () => {
    const { call, forge, merge } = await waiting(["merge"]);
    const refused = await call("decide_checkpoint", {
      agent: "main",
      checkpoint: merge,
      decision: "approved",
      reason: "It is fine.",
    });
    expect(errorOf(refused)).toMatchObject({
      code: ErrorCode.INVALID_ARGUMENTS,
      details: { why: "kept" },
    });
    expect(forge.merges).toEqual([]);
  });
});

describe("the engine follows the forge", () => {
  async function ready() {
    const setup = await product();
    await setup.toReview();
    const passed = resultValue<{ checkpoint: string }>(await setup.review("quentin", "qa"));
    const story = async () =>
      ((await setup.projection()).stories as Record<string, StoryState>)["1-1"] as StoryState;
    const checkpoint = async (id = passed.checkpoint) =>
      ((await setup.projection()).checkpoints as Record<string, CheckpointState>)[
        id
      ] as CheckpointState;
    return { ...setup, merge: passed.checkpoint, story, checkpoint };
  }

  it("records a pull request the creator merged on the forge, with its proof, at next, and closes its point", async () => {
    const { forge, next, story, checkpoint, merge, workspace, answer } = await ready();
    forge.prState = "merged";
    // The creator added a commit on the forge before merging: not the commit reviewed.
    forge.prHead = HEAD2;
    await next();
    expect((await story()).merged).toMatchObject({
      source: "forge",
      already: true,
      merged_by: "ada",
      pr: 41,
      commit: HEAD2,
      merge_commit: MERGE_COMMIT,
      checkpoint: merge,
      by: null,
    });
    expect((await story()).merged?.at).toBeDefined();
    expect(await checkpoint()).toMatchObject({
      status: "closed",
      closed: { reason: "story_merged", ref: null },
      blocks_lifted: true,
    });
    // Nobody answered: no validation of the creator, nothing to ask, nothing merged by the engine.
    expect((await checkpoint()).resolution).toBeNull();
    expect(forge.merges).toEqual([]);
    expect(workspace.worktrees.has("feat/1-1-work")).toBe(false);
    // The point can no longer be answered, and is no longer proposed.
    expect(errorOf(await answer(merge))).toBeDefined();
    expect((await next()).story).not.toBe("1-1");
  });

  it("dates the merge by the forge, and ignores a pull request merged into another branch", async () => {
    const { forge, next, story } = await ready();
    forge.prState = "merged";
    forge.prBase = "develop";
    await next();
    expect((await story()).merged).toBeUndefined();
    forge.prBase = "main";
    await next();
    expect((await story()).merged?.at).toBe("2026-10-05T14:20:00.000Z");
  });

  it("recognises the merge when the creator answers the point before any next", async () => {
    const { call, forge, merge, story, checkpoint } = await ready();
    forge.prState = "merged";
    forge.prHead = HEAD2;
    const answered = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: merge,
      decision: "approved",
      quote: "oui",
      session: "s-1",
    });
    // Nothing to answer any more: not a refusal of the gate, the point was closed by the engine.
    expect(errorOf(answered)?.code).toBe(ErrorCode.CHECKPOINT_NOT_OPEN);
    expect((await story()).merged).toMatchObject({ source: "forge", commit: HEAD2 });
    expect((await checkpoint()).closed?.reason).toBe("story_merged");
    expect(forge.merges).toEqual([]);
  });

  it("records it at get_state and check_ci too, and says so to the agent that reads the CI", async () => {
    const first = await ready();
    first.forge.prState = "merged";
    const view = await first.state();
    expect(view.stories["1-1"]?.merged).toMatchObject({ pr: 41 });
    const second = await ready();
    second.forge.prState = "merged";
    const withReader: CommandContext = {
      ...second.human,
      actor: "agent",
      human: undefined,
      ciReader: {
        repository: async () => ({ forge: "github", prefix: "", main: "main", ci: [] }),
        read: async () => ({ ok: false, reason: "forge_failed", tool: "gh" }),
      },
    };
    expect(
      errorOf(
        await second.registry.run("check_ci", withReader, { agent: "quentin", story: "1-1" }),
      ),
    ).toMatchObject({
      code: ErrorCode.CI_UNAVAILABLE,
      details: { reason: "done", merged_on_forge: true, merged_by: "ada" },
    });
    expect((await second.story()).merged?.source).toBe("forge");
  });

  it("leaves an open pull request alone, and a forge that cannot be read", async () => {
    const { forge, next, story, checkpoint, merge } = await ready();
    await next();
    expect((await story()).merged).toBeUndefined();
    expect((await checkpoint()).status).toBe("open");
    forge.pullRequest = async () => {
      throw new Error("gh: HTTP 502");
    };
    forge.prState = "merged";
    await next();
    expect((await story()).merged).toBeUndefined();
    expect((await checkpoint(merge)).status).toBe("open");
  });

  it("never closes a point on the engine's word alone: the journal must show the reason", async () => {
    const { journal, productId, merge, checkpoint } = await ready();
    await journal.appendAll([
      {
        type: "checkpoint.closed",
        actor: { kind: "system" },
        product: productId,
        provenance: "trusted",
        payload: { checkpoint: merge, reason: "story_merged" },
      },
    ]);
    expect((await checkpoint()).status).toBe("open");
  });
});

/** The lens reports and the judge's, as a reviewer returns them. */
const lensReport = (lens: string, findings: unknown[] = []) => ({
  lens,
  summary: `${lens} looked at the diff.`,
  covered: ["the diff", "the story"],
  findings,
});
const lensFinding = (over: Record<string, unknown> = {}) => ({
  severity: "should_fix",
  title: "The empty profile shows nothing",
  evidence: "load() returns null for a new user.",
  criterion: 1,
  recommendation: "Show an empty state.",
  path: "src/profile.ts",
  line: 2,
  ...over,
});
const judgeReport = (status: "met" | "partly" | "unmet" = "met", gap: string | null = null) => ({
  summary: "Judged against the story.",
  criteria: [
    {
      criterion: 1,
      status,
      evidence: "src/profile.ts:2 shows the name",
      ...(status === "met" ? {} : { recommendation: "Show the name Ada gave." }),
    },
  ],
  gap,
});
/** The lenses of a small change without risk, whole. */
const smallLenses = (findings: Record<string, unknown[]> = {}) => [
  lensReport("verification_gaps", findings.verification_gaps ?? []),
  lensReport("relevance", findings.relevance ?? []),
];

describe("the judge gets the trace of the criteria instead of recomputing it", () => {
  it("gives where each criterion stands, and the reasons of the ones declared untestable", async () => {
    const { call, toReview } = await product();
    await toReview();
    const started = resultValue<{ trace?: string; untestable?: string[] }>(
      await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" }),
    );
    // The fixture declared its one criterion untestable before going to review.
    expect(started.trace).toBe("1:untestable");
    expect(started.untestable).toEqual(["1: fixture"]);
  });
});

describe("the writes the guard refused are shown in the review", () => {
  it("adds one line when the guard refused or doubted, and nothing when it did nothing", async () => {
    const { call, toReview, journal } = await product();
    await toReview();
    const quiet = resultValue<{ guard?: string }>(
      await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" }),
    );
    expect(quiet.guard).toBeUndefined();
    const productId = journal.events[0]?.product as string;
    const base = { actor: { kind: "agent", agent: "main" }, product: productId, story: "1-1" };
    await journal.appendAll([
      {
        ...base,
        type: "write.refused",
        provenance: "trusted",
        payload: { rule: "secret", path: "src/profile.ts", detail: "GitHub token" },
      },
      {
        ...base,
        type: "write.refused",
        provenance: "trusted",
        payload: { rule: "scope", path: "src/other.ts" },
      },
      {
        ...base,
        type: "write.doubted",
        provenance: "trusted",
        payload: { reason: "timeout" },
      },
    ] as never);
    const started = resultValue<{ guard?: string }>(
      await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" }),
    );
    expect(started.guard).toBe(
      "Write guard: 2 writes refused before being written (1 secret, 1 scope); 1 let through in doubt (traced in the journal).",
    );
  });
});

describe("the review in lenses", () => {
  it("gives the readers the project's declared test command, and none when it declares none", async () => {
    const { call, toReview, files } = await product();
    await toReview();
    const without = resultValue<{ test_command?: string }>(
      await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" }),
    );
    expect(without).not.toHaveProperty("test_command");
    files.seed(
      "package.json",
      JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { test: "vitest run" } }),
    );
    files.seed("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const declared = resultValue<{ test_command?: string }>(
      await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" }),
    );
    // The script as the package manager runs it, never a launcher such as `npx vitest`.
    expect(declared.test_command).toBe("pnpm run test");
  });

  it("gives the lenses the engine chose from the change, and why, and the numbered criteria", async () => {
    const { call, toReview, diff, files } = await product();
    await toReview();
    const small = resultValue<{ lenses: unknown; criteria: string[] }>(
      await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" }),
    );
    // One line changed, nothing sensitive: two lenses only.
    expect(small.lenses).toEqual([
      { lens: "verification_gaps", why: ["always"] },
      { lens: "relevance", why: ["always"] },
    ]);
    expect(small.criteria).toEqual([
      "Given Ada, when she opens her profile, then she sees her name.",
    ]);
    // One reader carries both lenses and the judge's check, no sub-agent more.
    const diffOf = (reader: string) =>
      `.agentplugged/.cache/reviews/1-1/qa-${HEAD.slice(0, 12)}.${reader}.diff`;
    expect((small as unknown as { readers: unknown[] }).readers).toEqual([
      {
        reader: "whole",
        lenses: ["verification_gaps", "relevance"],
        judge: true,
        passes: ["assertions"],
        diff: diffOf("whole"),
      },
    ]);
    expect(await files.readText(diffOf("whole"))).toContain("diff --git a/src/profile.ts");
    // The creator may ask for one more.
    const more = resultValue<{ lenses: Array<{ lens: string; why: string[] }> }>(
      await call("start_review", {
        agent: "quentin",
        story: "1-1",
        kind: "qa",
        more: ["adversarial"],
      }),
    );
    expect(more.lenses.map((entry) => entry.lens)).toEqual([
      "adversarial",
      "verification_gaps",
      "relevance",
    ]);
    expect(more.lenses[0]?.why).toEqual(["requested"]);
    // Asking for the security lens of a quality review changes nothing: it is the other reviewer's.
    const asked = resultValue<{ lenses: Array<{ lens: string }> }>(
      await call("start_review", {
        agent: "quentin",
        story: "1-1",
        kind: "qa",
        more: ["security"],
      }),
    );
    expect(asked.lenses.map((entry) => entry.lens)).toEqual(["verification_gaps", "relevance"]);
    // Not sensitive: one reader, who also checks the criteria.
    expect(
      (more as unknown as { readers: Array<{ reader: string }> }).readers.map((r) => r.reader),
    ).toEqual(["whole"]);
    // A sensitive change: every lens, the security one being the security reviewer's.
    diff.diffs.set(HEAD, DEPENDENCY_DIFF);
    const sensitive = resultValue<{ lenses: Array<{ lens: string }> }>(
      await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" }),
    );
    expect(sensitive.lenses.map((entry) => entry.lens)).toEqual([
      "adversarial",
      "edge_cases",
      "verification_gaps",
      "structure",
      "relevance",
    ]);
    // A sensitive change is read by depth and form here (the security lens is the
    // other reviewer's), then the judge alone; never one reader per lens.
    const sensitiveReaders = (
      sensitive as unknown as {
        readers: Array<{ reader: string; lenses: string[]; judge: boolean }>;
      }
    ).readers;
    expect(sensitiveReaders).toEqual([
      {
        reader: "depth",
        lenses: ["adversarial", "edge_cases", "verification_gaps"],
        judge: false,
        passes: ["assertions"],
        diff: expect.any(String),
      },
      {
        reader: "form",
        lenses: ["structure", "relevance"],
        judge: false,
        diff: expect.any(String),
      },
      { reader: "judge", lenses: [], judge: true, diff: expect.any(String) },
    ]);
    // Each reader and the judge have their own part of the diff, written next to the whole one.
    for (const reader of ["depth", "form", "judge"]) {
      expect(
        await files.readText(
          `.agentplugged/.cache/reviews/1-1/qa-${HEAD.slice(0, 12)}.${reader}.diff`,
        ),
        reader,
      ).toContain("diff --git a/src/profile.ts");
    }
    const security = resultValue<{ lenses: Array<{ lens: string; why: string[] }> }>(
      await call("start_review", { agent: "warden", story: "1-1", kind: "security" }),
    );
    expect(security.lenses).toEqual([{ lens: "security", why: ["security_paths"] }]);
  });

  it("refuses a report that is not whole, with what is missing, and writes nothing", async () => {
    const { toReview, review, journal } = await product();
    await toReview();
    const before = journal.events.length;
    const refused = async (extra: Record<string, unknown>) => {
      const result = await review("quentin", "qa", [], extra);
      expect(reasonOf(result)).toBe("report_invalid");
      return String(errorOf(result)?.details.problems);
    };
    expect(await refused({ lenses: [lensReport("relevance")], judge: judgeReport() })).toBe(
      "lens_missing:verification_gaps",
    );
    expect(await refused({ lenses: smallLenses() })).toBe("judge_missing");
    expect(
      await refused({
        lenses: [
          lensReport("relevance", [{ severity: "blocking", title: "Wrong" }]),
          lensReport("verification_gaps"),
        ],
        judge: judgeReport(),
      }),
    ).toBe(
      "evidence_missing:relevance#1, criterion_missing:relevance#1, recommendation_missing:relevance#1",
    );
    expect(
      await refused({
        lenses: smallLenses({ relevance: [lensFinding({ criterion: 4 })] }),
        judge: { ...judgeReport(), criteria: [] },
      }),
    ).toBe("criterion_unknown:relevance#1:4, judge_criterion_missing:1");
    // The security lens is the security reviewer's; the judge is the quality review's.
    expect(
      await refused({ lenses: [...smallLenses(), lensReport("security")], judge: judgeReport() }),
    ).toBe("lens_not_allowed:security");
    expect(journal.events.length).toBe(before);
    // Lenses and plain findings do not mix.
    const mixed = await review("quentin", "qa", [minor], {
      lenses: smallLenses(),
      judge: judgeReport(),
    });
    expect(errorOf(mixed)?.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });

  it("merges what two lenses saw, links the criterion, takes the strictest verdict, journals it all", async () => {
    const { call, toReview, review, journal } = await product();
    await toReview();
    const submitted = resultValue<{ review: string; verdict: string; complete: boolean }>(
      await review("quentin", "qa", [], {
        lenses: smallLenses({
          verification_gaps: [
            lensFinding({ severity: "should_fix", title: "No test proves the empty profile" }),
            lensFinding({ severity: "minor", title: "Naming of load", line: 30, criterion: null }),
          ],
          relevance: [
            lensFinding({
              severity: "blocking",
              title: "The empty profile is not proven by any test",
              line: 3,
            }),
          ],
        }),
        judge: judgeReport("met"),
      }),
    );
    // Two lenses, one finding: kept blocking, so the review fails.
    expect(submitted).toMatchObject({ verdict: "fail", complete: true });
    const event = journal.events.find((entry) => entry.type === "story.reviewed");
    expect(event?.payload).toMatchObject({
      verdict: "fail",
      lenses: [
        { lens: "verification_gaps", findings: 2 },
        { lens: "relevance", findings: 1 },
      ],
      merged: 1,
      judge: { met: 1, partly: 0, unmet: 0 },
    });
    expect(event?.payload).toMatchObject({ findings: [expect.anything(), expect.anything()] });
    const read = resultValue<{
      findings: Array<{ severity: string; lens: string; also: string[]; criterion: number | null }>;
    }>(await call("get_review", { agent: "sam", story: "1-1" }));
    expect(read.findings[0]).toMatchObject({
      severity: "blocking",
      lens: "relevance",
      also: ["verification_gaps"],
      criterion: 1,
    });
    expect(read.findings.map((finding) => finding.severity)).toEqual(["blocking", "minor"]);
  });

  it("fails on the judge's word alone when every lens passes", async () => {
    const { review, toReview } = await product();
    await toReview();
    const submitted = resultValue<{ verdict: string; outcome: string }>(
      await review("quentin", "qa", [], {
        lenses: smallLenses(),
        judge: judgeReport("unmet", "The page shows an id, not the name."),
      }),
    );
    expect(submitted).toMatchObject({ verdict: "fail", outcome: "changes_requested" });
  });

  it("asks every lens of a sensitive change, and the security review only its lens", async () => {
    const { review, toReview, diff, call } = await product();
    diff.diffs.set(HEAD, DEPENDENCY_DIFF);
    await toReview();
    expect(
      String(
        errorOf(await review("quentin", "qa", [], { lenses: smallLenses(), judge: judgeReport() }))
          ?.details.problems,
      ),
    ).toBe("lens_missing:adversarial, lens_missing:edge_cases, lens_missing:structure");
    const wholeQa = [
      lensReport("adversarial"),
      lensReport("edge_cases"),
      lensReport("verification_gaps"),
      lensReport("structure"),
      lensReport("relevance"),
    ];
    expect(
      resultValue<{ complete: boolean }>(
        await review("quentin", "qa", [], { lenses: wholeQa, judge: judgeReport() }),
      ).complete,
    ).toBe(false);
    // The security reviewer: her lens, no judge, no other lens.
    const wrong = await review("warden", "security", [], {
      lenses: [lensReport("relevance")],
      judge: judgeReport(),
    });
    expect(String(errorOf(wrong)?.details.problems)).toBe(
      "lens_not_allowed:relevance, lens_missing:security, judge_not_allowed",
    );
    const done = resultValue<{ complete: boolean; verdict: string }>(
      await review("warden", "security", [], {
        lenses: [
          lensReport("security", [
            lensFinding({
              severity: "blocking",
              title: "Dependency pinned to an unknown package",
              path: "package.json",
              line: 3,
              criterion: null,
            }),
          ]),
        ],
      }),
    );
    expect(done).toMatchObject({ complete: true, verdict: "fail" });
    expect(await call("get_review", { agent: "sam", story: "1-1" })).toMatchObject({ ok: true });
  });

  it("shows the creator a short stack: fixed findings counted, the others one line each, blocking first", async () => {
    const { run, call, toReview, review, projection, diff } = await product();
    await toReview();
    await review("quentin", "qa", [], {
      lenses: smallLenses({
        relevance: [lensFinding({ severity: "blocking", title: "Crash on an empty profile" })],
      }),
      judge: judgeReport("partly"),
    });
    const read = resultValue<{ findings: Array<{ id: string }> }>(
      await call("get_review", { agent: "sam", story: "1-1" }),
    );
    // Fixed before the creator is shown anything: every finding of the first pass.
    await run("triage_review", {
      agent: "sam",
      story: "1-1",
      items: read.findings.map((finding) => ({
        finding: finding.id,
        decision: "fix",
        root_cause: "Untested edge",
      })),
    });
    diff.diffs.set(HEAD2, PLAIN_DIFF);
    await toReview(HEAD2);
    const passed = resultValue<{ checkpoint: string; outcome: string }>(
      await review("quentin", "qa", [], {
        lenses: smallLenses({
          verification_gaps: [
            lensFinding({
              severity: "minor",
              title: "Naming of the helper",
              line: 9,
              criterion: null,
              recommendation: "Rename it.",
            }),
            lensFinding({ severity: "should_fix", title: "Retry is not tested", line: 20 }),
          ],
        }),
        judge: judgeReport("met"),
      }),
    );
    expect(passed.outcome).toBe("approved");
    const summary = ((await projection()).checkpoints as Record<string, CheckpointState>)[
      passed.checkpoint
    ]?.summary as string;
    expect(summary).toContain("2 finding(s) were fixed before you saw them.");
    expect(summary).not.toContain("Crash on an empty profile");
    // To fix first, then minor, each in one line with the agent's advice.
    expect(summary).toContain(
      "Left open, blocking first: should_fix src/profile.ts:20 [criterion 1]: Retry is not tested -> Show an empty state. ; minor src/profile.ts:9: Naming of the helper -> Rename it.",
    );
    // The developer reads the same stack.
    const stack = resultValue<{ stack: { fixed: number; lines: string[] } }>(
      await call("get_review", { agent: "sam", story: "1-1" }),
    ).stack;
    expect(stack.fixed).toBe(2);
    expect(stack.lines).toHaveLength(2);
  });

  it("shows the same stack when the open merge checkpoint is refreshed by a new pass", async () => {
    const { run, toReview, review, projection, diff } = await product();
    await toReview();
    const first = resultValue<{ checkpoint: string }>(
      await review("quentin", "qa", [], { lenses: smallLenses(), judge: judgeReport() }),
    );
    // The story comes back to review on a new commit while its merge checkpoint is still open.
    await run("update_story", { agent: "sam", story: "1-1", status: "in_progress" });
    diff.diffs.set(HEAD2, PLAIN_DIFF);
    await toReview(HEAD2);
    const second = resultValue<{ outcome: string; checkpoint?: string }>(
      await review("quentin", "qa", [], {
        lenses: smallLenses({
          relevance: [lensFinding({ title: "A helper nobody calls", line: 7 })],
        }),
        judge: judgeReport("met"),
      }),
    );
    expect(second.outcome).toBe("approved");
    expect(second.checkpoint).toBeUndefined();
    const projected = await projection();
    const checkpoint = (projected.checkpoints as Record<string, CheckpointState>)[first.checkpoint];
    expect(checkpoint?.summary).toContain("pass 2");
    expect(checkpoint?.summary).toContain(
      "should_fix src/profile.ts:7 [criterion 1]: A helper nobody calls",
    );
    // The reducer accepted the summary the engine composed.
    expect((projected.stories as Record<string, StoryState>)["1-1"]?.merge_refresh).toMatchObject({
      pass: 2,
      commit: HEAD2,
    });
    // The walk through the new commit came with it, and the reducer composed it again.
    expect(checkpoint?.summary).toContain("Read first, riskiest first: 1) src/profile.ts:7");
  });

  it("joins the walk through the change to the merge checkpoint, beside the stack", async () => {
    const { toReview, review, projection, files } = await product();
    files.seed(
      ".agentplugged/docs/ux.md",
      "# UX\n\n## Key flows\n\n### Open a profile\n\nCovers: EF-1.\n\n1. She opens the app\n2. She taps Profile\n3. Her name shows\n\n## States\n",
    );
    await toReview();
    const passed = resultValue<{ checkpoint: string; outcome: string }>(
      await review("quentin", "qa", [], {
        lenses: smallLenses({ relevance: [lensFinding({ line: 2 })] }),
        judge: judgeReport("met"),
      }),
    );
    expect(passed.outcome).toBe("approved");
    const summary = ((await projection()).checkpoints as Record<string, CheckpointState>)[
      passed.checkpoint
    ]?.summary as string;
    const stack = summary.indexOf("Left open, blocking first:");
    const walk = summary.indexOf(
      "Read first, riskiest first: 1) src/profile.ts:2 (1 finding to fix open, criterion 1)",
    );
    const gesture = summary.indexOf("Approve and the engine merges");
    // The stack, then the walk, then the usual gesture; the finding's words are said once.
    expect(stack).toBeGreaterThan(0);
    expect(walk).toBeGreaterThan(stack);
    expect(gesture).toBeGreaterThan(walk);
    expect(summary.split("The empty profile shows nothing")).toHaveLength(2);
    // The criterion has no test (declared untestable here): the steps come from the journey.
    expect(summary).toContain(
      'To try by hand: AC1 follow the journey "Open a profile": She opens the app > She taps Profile > Her name shows',
    );
    expect(summary).toContain("(no test: fixture)");
    expect(
      summary.endsWith("ask for changes to send it back to its developer with your note."),
    ).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(2000);
  });

  it("makes the quality review carry the security lens when no security reviewer is active", async () => {
    const { call, toReview, review, diff, journal, files } = await product({ warden: false });
    diff.diffs.set(HEAD, DEPENDENCY_DIFF);
    await toReview();
    const started = resultValue<{
      lenses: Array<{ lens: string }>;
      security: { required: boolean; unavailable: boolean };
    }>(await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" }));
    // Nobody to give the security review: the lens is in Quentin's own list, so it is not lost.
    expect(started.security).toMatchObject({ required: false, unavailable: true });
    expect(started.lenses.map((entry) => entry.lens)).toContain("security");
    // The security lens has a reader of its own, who reads the whole diff.
    const readers = (started as unknown as { readers: Array<Record<string, unknown>> }).readers;
    const securityReader = readers.find((reader) => reader.reader === "security");
    expect(securityReader).toMatchObject({ lenses: ["security"], judge: false });
    expect(await files.readText(String(securityReader?.diff))).toBe(DEPENDENCY_DIFF);
    // The security lens alone, then depth and form, then the judge alone.
    expect(readers.map((reader) => reader.reader)).toEqual(["security", "depth", "form", "judge"]);
    expect(readers.find((reader) => reader.reader === "depth")?.lenses).toEqual([
      "adversarial",
      "edge_cases",
      "verification_gaps",
    ]);
    const lenses = started.lenses.map((entry) => lensReport(entry.lens));
    const without = lenses.filter((entry) => entry.lens !== "security");
    expect(
      String(
        errorOf(await review("quentin", "qa", [], { lenses: without, judge: judgeReport() }))
          ?.details.problems,
      ),
    ).toBe("lens_missing:security");
    const done = resultValue<{ complete: boolean }>(
      await review("quentin", "qa", [], { lenses, judge: judgeReport() }),
    );
    expect(done.complete).toBe(true);
    // The journal keeps what the engine asked, next to what came back.
    const event = journal.events.find((entry) => entry.type === "story.reviewed");
    expect(event?.payload).toMatchObject({
      asked: [
        "adversarial",
        "edge_cases",
        "verification_gaps",
        "structure",
        "security",
        "relevance",
      ],
    });
  });

  it("refuses a proof of two letters and a judge who gives none", async () => {
    const { toReview, review } = await product();
    await toReview();
    const result = await review("quentin", "qa", [], {
      lenses: smallLenses({ relevance: [lensFinding({ evidence: "ok" })] }),
      judge: {
        ...judgeReport(),
        criteria: [{ criterion: 1, status: "met", evidence: "ok" }],
      },
    });
    expect(String(errorOf(result)?.details.problems)).toBe(
      "evidence_missing:relevance#1, judge_evidence_missing:1",
    );
  });
});

describe("the engine proves the duplicates of the added code", () => {
  const ORIGINAL = `export function tally(rows: Row[], unit: string): Report {
  const sums = new Map<string, number>();
  for (const row of rows) {
    if (row.state === "void") continue;
    const owner = row.client.id;
    const before = sums.get(owner) ?? 0;
    sums.set(owner, before + row.total * row.factor);
  }
  const pairs = [...sums.entries()].sort((x, y) => y[1] - x[1]);
  return { unit, top: pairs.slice(0, 3), count: pairs.length };
}
`;
  const COPY = ORIGINAL.replace("tally", "summarize")
    .replaceAll("rows", "items")
    .replaceAll("row", "item")
    .replaceAll("sums", "totals");
  const COPY_DIFF = [
    "diff --git a/src/summary.ts b/src/summary.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/summary.ts",
    `@@ -0,0 +1,${COPY.split("\n").length - 1} @@`,
    ...COPY.split("\n")
      .slice(0, -1)
      .map((line) => `+${line}`),
    "",
  ].join("\n");
  const source: CodeSource = {
    read: async () => [
      { path: "src/report.ts", text: ORIGINAL },
      { path: "src/summary.ts", text: COPY },
    ],
  };

  it("tells the lone reader of a small change the duplicate in one line, and nothing else changes", async () => {
    const { call, toReview, diff } = await product({ codeSource: source });
    await toReview();
    diff.diffs.set(HEAD, COPY_DIFF);
    const started = resultValue<{ readers: Array<{ reader: string; reuse?: string[] }> }>(
      await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" }),
    );
    expect(started.readers).toHaveLength(1);
    expect(started.readers[0]?.reader).toBe("whole");
    expect(started.readers[0]?.reuse).toEqual([
      expect.stringMatching(
        /^duplicate src\/summary\.ts:1-11 = src\/report\.ts:1-11 \(\d+ words\)$/,
      ),
    ]);
    // Without a code source, or without a duplicate, the reader hears nothing of it.
    const plain = await product();
    await plain.toReview();
    const quiet = resultValue<{ readers: Array<{ reuse?: string[] }> }>(
      await plain.call("start_review", { agent: "quentin", story: "1-1", kind: "qa" }),
    );
    expect(quiet.readers[0]).not.toHaveProperty("reuse");
  });

  it("adds the duplicate to the review as a finding to fix of the structure lens the reviewer cannot drop", async () => {
    const { toReview, review, diff, journal } = await product({ codeSource: source });
    await toReview();
    diff.diffs.set(HEAD, COPY_DIFF);
    const result = await review("quentin", "qa", [], {
      lenses: [lensReport("edge_cases"), ...smallLenses()],
      judge: judgeReport(),
    });
    expect(errorOf(result)).toBeUndefined();
    const event = journal.events.find((entry) => entry.type === "story.reviewed");
    const reviewed = (event?.payload ?? {}) as {
      findings: Array<Record<string, unknown>>;
      verdict: string;
    };
    const findings = reviewed.findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "should_fix",
      lens: "structure",
      path: "src/summary.ts",
      line: 1,
    });
    expect(String(findings[0]?.title)).toMatch(
      /^Duplicated code: src\/summary\.ts:1-11 repeats src\/report\.ts:1-11/,
    );
    expect(reviewed.verdict).toBe("pass_with_reservations");
  });

  it("keeps the weight of the story's code in the journal when it is merged, and the duplicates it added", async () => {
    const { toReview, review, diff, answer, projection, run } = await product({
      codeSource: source,
    });
    await toReview();
    diff.diffs.set(HEAD, COPY_DIFF);
    const passed = resultValue<{ checkpoint: string; review: string }>(
      await review("quentin", "qa", [], {
        lenses: [lensReport("edge_cases"), ...smallLenses()],
        judge: judgeReport(),
      }),
    );
    // The duplicate is a finding to fix: the merge waits until the developer has sorted it, and a
    // rejection needs its reason.
    expect((await answer(passed.checkpoint)).ok).toBe(false);
    await run("triage_review", {
      agent: "sam",
      story: "1-1",
      items: [
        {
          finding: `${passed.review}-1`,
          decision: "reject",
          root_cause: "Copied the report code",
          reason: "The copy is the report's own format, kept on purpose.",
        },
      ],
    });
    const approved = await answer(passed.checkpoint);
    expect(approved.ok).toBe(true);
    const stories = (await projection()).stories as Record<string, StoryState>;
    expect(stories["1-1"]?.merged?.weight).toEqual({ added: 11, removed: 0, duplicates: 1 });
  });

  it("keeps the weight without a duplicate count when the repository cannot be read", async () => {
    const { toReview, review, answer, projection } = await product();
    await toReview();
    const passed = resultValue<{ checkpoint: string }>(await review("quentin", "qa"));
    expect((await answer(passed.checkpoint)).ok).toBe(true);
    const stories = (await projection()).stories as Record<string, StoryState>;
    expect(stories["1-1"]?.merged?.weight).toEqual({ added: 1, removed: 0 });
  });

  it("leaves the review as it was when the repository cannot be read", async () => {
    const { toReview, review, journal } = await product({
      codeSource: {
        read: async () => {
          throw new Error("no git");
        },
      },
    });
    await toReview();
    const result = await review("quentin", "qa", [], {
      lenses: smallLenses(),
      judge: judgeReport(),
    });
    expect(errorOf(result)).toBeUndefined();
    const event = journal.events.find((entry) => entry.type === "story.reviewed");
    expect(((event?.payload ?? {}) as { findings: unknown[] }).findings).toEqual([]);
  });
});

/**
 * The judge rules on every finding before the developer sees
 * one, a review of a change that belongs to no story, a lens that stayed silent, the request that
 * stands alone, and the passes of the reader of verification gaps.
 */
describe("the judge rules on every finding", () => {
  const ruling = (finding: string, over: Record<string, unknown> = {}) => ({
    finding,
    status: "confirmed",
    severity: "should_fix",
    evidence: "Read src/profile.ts:2 and the test: the finding holds.",
    ...over,
  });
  const judgeWith = (findings: unknown[], over: Record<string, unknown> = {}) => ({
    ...judgeReport(),
    findings,
    ...over,
  });

  it("refuses a judge who leaves a finding unruled, rules it twice, invents one or refutes without proof", async () => {
    const { toReview, review } = await product();
    await toReview();
    const lenses = smallLenses({
      relevance: [lensFinding({ title: "The empty profile shows nothing" })],
      verification_gaps: [lensFinding({ title: "No test proves it", line: 40 })],
    });
    const refused = async (judge: unknown) =>
      String(errorOf(await review("quentin", "qa", [], { lenses, judge }))?.details.problems);
    expect(await refused(judgeWith([ruling("relevance#1")]))).toBe(
      "judge_finding_missing:verification_gaps#1",
    );
    expect(
      await refused(
        judgeWith([ruling("relevance#1"), ruling("relevance#1"), ruling("verification_gaps#1")]),
      ),
    ).toBe("judge_finding_repeated:relevance#1");
    expect(
      await refused(
        judgeWith([ruling("relevance#1"), ruling("verification_gaps#1"), ruling("adversarial#3")]),
      ),
    ).toBe("judge_finding_unknown:adversarial#3");
    expect(
      await refused(
        judgeWith([
          ruling("relevance#1", { status: "refuted", severity: undefined }),
          ruling("verification_gaps#1", { severity: undefined }),
        ]),
      ),
    ).toBe(
      "judge_finding_proof_missing:relevance#1, judge_finding_severity_missing:verification_gaps#1",
    );
    expect(
      await refused(
        judgeWith([ruling("relevance#1", { evidence: "ok" }), ruling("verification_gaps#1")]),
      ),
    ).toBe("judge_finding_evidence_missing:relevance#1");
  });

  it("counts a refuted finding and shows it to nobody, and sets the severity the judge gives", async () => {
    const { toReview, review, call, journal } = await product();
    await toReview();
    const submitted = resultValue<{ verdict: string; outcome: string; refuted?: number }>(
      await review("quentin", "qa", [], {
        lenses: smallLenses({
          relevance: [
            lensFinding({ severity: "blocking", title: "Crash on an empty profile", line: 2 }),
          ],
          verification_gaps: [
            lensFinding({ severity: "minor", title: "The profile name is not escaped", line: 30 }),
          ],
        }),
        judge: judgeWith([
          ruling("relevance#1", {
            status: "refuted",
            severity: undefined,
            at: "src/profile.ts:2 returns before any use of the id",
          }),
          ruling("verification_gaps#1", { severity: "blocking" }),
        ]),
      }),
    );
    // The reader's blocking finding is gone (refuted with its proof); the reader's minor one is blocking.
    expect(submitted).toMatchObject({ verdict: "fail", outcome: "changes_requested", refuted: 1 });
    const read = resultValue<{ findings: Array<{ title: string; severity: string }> }>(
      await call("get_review", { agent: "sam", story: "1-1" }),
    );
    expect(read.findings.map((finding) => [finding.title, finding.severity])).toEqual([
      ["The profile name is not escaped", "blocking"],
    ]);
    // The journal keeps what was refuted, for the audit.
    const event = journal.events.find((entry) => entry.type === "story.reviewed");
    expect(event?.payload).toMatchObject({
      ruled: { confirmed: 1, refuted: 1, undecided: 0 },
      refuted: [
        {
          lens: "relevance",
          severity: "blocking",
          title: "Crash on an empty profile",
          at: "src/profile.ts:2 returns before any use of the id",
        },
      ],
    });
  });

  it("lets a finding nobody could settle be read, never block, and says it is unverified", async () => {
    const { toReview, review, call } = await product();
    await toReview();
    const submitted = resultValue<{ verdict: string; outcome: string; checkpoint?: string }>(
      await review("quentin", "qa", [], {
        lenses: smallLenses({
          relevance: [lensFinding({ severity: "blocking", title: "Race on two saves" })],
        }),
        judge: judgeWith([
          ruling("relevance#1", {
            status: "undecided",
            severity: undefined,
            evidence: "Needs the code of the store, which the diff does not show.",
          }),
        ]),
      }),
    );
    expect(submitted).toMatchObject({ verdict: "pass_with_reservations", outcome: "approved" });
    const read = resultValue<{
      findings: Array<{ severity: string; ruling: string | null }>;
      stack: { lines: string[] };
    }>(await call("get_review", { agent: "sam", story: "1-1" }));
    expect(read.findings[0]).toMatchObject({ severity: "should_fix", ruling: "undecided" });
    expect(read.stack.lines[0]).toContain("should_fix (unverified)");
  });

  it("marks a finding whose cause is the story, and tells the creator to amend it", async () => {
    const { toReview, review, call, projection } = await product();
    await toReview();
    const submitted = resultValue<{ checkpoint?: string }>(
      await review("quentin", "qa", [], {
        lenses: smallLenses({
          relevance: [
            lensFinding({ severity: "should_fix", title: "Two criteria ask opposite things" }),
          ],
        }),
        judge: judgeWith([ruling("relevance#1", { cause: "story" })]),
      }),
    );
    const read = resultValue<{
      findings: Array<{ cause: string | null }>;
      stack: { story: number };
    }>(await call("get_review", { agent: "sam", story: "1-1" }));
    expect(read.findings[0]?.cause).toBe("story");
    expect(read.stack.story).toBe(1);
    const checkpoints = (await projection()).checkpoints as Record<string, { summary: string }>;
    expect(checkpoints[submitted.checkpoint as string]?.summary).toContain(
      "1 finding(s) come from the story itself: amend the story, do not patch the code around it.",
    );
  });
});

describe("a proof the judge cannot wave through", () => {
  const proof = (status: string, over: Record<string, unknown> = {}) => ({
    finding: "relevance#1",
    status,
    severity: "minor",
    evidence: "Read src/profile.ts:2 and the test: it cannot happen, the guard returns first.",
    at: "src/profile.ts:2",
    ...over,
  });
  const verdictOn = async (reader: string, ruling: Record<string, unknown>) => {
    const { toReview, review } = await product();
    await toReview();
    const result = await review("quentin", "qa", [], {
      lenses: smallLenses({
        relevance: [lensFinding({ severity: reader, title: "Crash on empty" })],
      }),
      judge: { ...judgeReport(), findings: [ruling] },
    });
    return result.ok ? "accepted" : String(errorOf(result)?.details.problems);
  };

  it("asks a place in a file for a refutation, with its line when a reader called the finding blocking", async () => {
    expect(await verdictOn("should_fix", proof("refuted", { at: "n/a" }))).toBe(
      "judge_finding_proof_missing:relevance#1",
    );
    expect(await verdictOn("should_fix", proof("refuted", { at: "src/profile.ts" }))).toBe(
      "accepted",
    );
    expect(await verdictOn("blocking", proof("refuted", { at: "src/profile.ts" }))).toBe(
      "judge_finding_proof_missing:relevance#1",
    );
    expect(await verdictOn("blocking", proof("refuted", { at: "src/profile.ts:2" }))).toBe(
      "accepted",
    );
  });

  it("asks more than a word to set aside or lower what a reader called blocking", async () => {
    const short = { evidence: "It cannot really happen here." };
    expect(await verdictOn("blocking", proof("refuted", short))).toBe(
      "judge_finding_evidence_missing:relevance#1",
    );
    expect(await verdictOn("blocking", proof("confirmed", short))).toBe(
      "judge_finding_evidence_missing:relevance#1",
    );
    // Keeping it blocking, or lowering a lesser one, needs only the usual proof.
    expect(
      await verdictOn("blocking", proof("confirmed", { ...short, severity: "blocking" })),
    ).toBe("accepted");
    expect(await verdictOn("should_fix", proof("refuted", short))).toBe("accepted");
  });

  it("tells the creator how many findings the judge set aside, and how many were called blocking", async () => {
    const { toReview, review, projection } = await product();
    await toReview();
    const submitted = resultValue<{ checkpoint: string; refuted: number }>(
      await review("quentin", "qa", [], {
        lenses: smallLenses({
          relevance: [lensFinding({ severity: "blocking", title: "Crash on empty" })],
          verification_gaps: [lensFinding({ title: "No test proves it", line: 40 })],
        }),
        judge: {
          ...judgeReport(),
          findings: [
            proof("refuted"),
            proof("refuted", {
              finding: "verification_gaps#1",
              severity: undefined,
              at: "src/profile.test.ts",
            }),
          ],
        },
      }),
    );
    expect(submitted.refuted).toBe(2);
    const checkpoints = (await projection()).checkpoints as Record<string, { summary: string }>;
    expect(checkpoints[submitted.checkpoint]?.summary).toContain(
      "The judge refuted 2 finding(s) with proof (1 called blocking by a reader).",
    );
  });

  it("never sets aside a finding of the security lens the quality review carries", async () => {
    const { call, diff } = await product();
    diff.freeDiff = { diff: DEPENDENCY_DIFF, messages: "" };
    const started = resultValue<{ commit: string }>(
      await call("start_review", {
        agent: "quentin",
        kind: "qa",
        free: { source: "uncommitted", intent: "Add a dependency." },
      }),
    );
    const lensNames = ["adversarial", "edge_cases", "verification_gaps", "structure", "relevance"];
    const lenses = [
      ...lensNames.map((lens) => lensReport(lens)),
      lensReport("security", [
        lensFinding({
          severity: "blocking",
          title: "A package nobody knows",
          path: "package.json",
          line: 3,
        }),
      ]),
    ];
    const done = resultValue<{ verdict: string; refuted: number; stack: { lines: string[] } }>(
      await call("submit_review", {
        agent: "quentin",
        kind: "qa",
        commit: started.commit,
        summary: "Looked.",
        findings: [],
        lenses,
        judge: {
          ...judgeReport(),
          findings: [proof("refuted", { finding: "security#1", at: "package.json:3" })],
        },
      }),
    );
    // The refutation is not honoured: the finding stays, still blocking, said unverified.
    expect(done.refuted).toBe(0);
    expect(done.verdict).toBe("fail");
    expect(done.stack.lines[0]).toContain("blocking (unverified)");
  });

  it("points the developer to the amendment when a finding's cause is the story", async () => {
    const { toReview, review, call } = await product();
    await toReview();
    await review("quentin", "qa", [], {
      lenses: smallLenses({
        relevance: [
          lensFinding({ severity: "should_fix", title: "Two criteria ask opposite things" }),
        ],
      }),
      judge: {
        ...judgeReport(),
        findings: [proof("confirmed", { severity: "should_fix", cause: "story" })],
      },
    });
    const read = resultValue<{ amend?: string }>(
      await call("get_review", { agent: "sam", story: "1-1" }),
    );
    expect(read.amend).toBe(".agentplugged/skills/review-story/references/amend-story.md");
  });
});

describe("a lens that stays silent is said", () => {
  it("accepts the review with the lens declared silent, and says it is possibly incomplete", async () => {
    const { toReview, review, projection, journal } = await product();
    await toReview();
    const submitted = resultValue<{ outcome: string; incomplete?: string[]; checkpoint: string }>(
      await review("quentin", "qa", [], {
        lenses: [lensReport("verification_gaps"), { lens: "relevance", silent: true }],
        judge: judgeReport(),
      }),
    );
    expect(submitted).toMatchObject({ outcome: "approved", incomplete: ["relevance"] });
    // An empty stack is not a clean review: the creator is told a lens said nothing.
    const checkpoints = (await projection()).checkpoints as Record<string, { summary: string }>;
    expect(checkpoints[submitted.checkpoint]?.summary).toContain(
      "Review possibly incomplete: no report from relevance.",
    );
    expect(journal.events.find((entry) => entry.type === "story.reviewed")?.payload).toMatchObject({
      silent: ["relevance"],
      lenses: [{ lens: "verification_gaps", findings: 0 }],
    });
  });

  it("refuses a lens both silent and reported, a lens nobody asked for, and a review where nobody spoke", async () => {
    const { toReview, review } = await product();
    await toReview();
    const problems = async (extra: Record<string, unknown>) =>
      String(errorOf(await review("quentin", "qa", [], extra))?.details.problems);
    expect(
      await problems({
        lenses: [
          lensReport("verification_gaps"),
          lensReport("relevance"),
          { lens: "relevance", silent: true },
        ],
        judge: judgeReport(),
      }),
    ).toContain("silent_but_reported:relevance");
    expect(
      await problems({
        lenses: [...smallLenses(), { lens: "adversarial", silent: true }],
        judge: judgeReport(),
      }),
    ).toBe("silent_not_asked:adversarial");
    expect(
      await problems({
        lenses: [
          { lens: "verification_gaps", silent: true },
          { lens: "relevance", silent: true },
        ],
        judge: { silent: true },
      }),
    ).toBe("nothing_reported");
    // Silent without saying so is still refused: the lens is missing.
    expect(
      await problems({ lenses: [lensReport("verification_gaps")], judge: judgeReport() }),
    ).toBe("lens_missing:relevance");
  });

  it("keeps the readers' severities when the judge is silent, and says so", async () => {
    const { toReview, review } = await product();
    await toReview();
    const submitted = resultValue<{ verdict: string; incomplete?: string[] }>(
      await review("quentin", "qa", [], {
        lenses: smallLenses({
          relevance: [lensFinding({ severity: "blocking", title: "Crash on an empty profile" })],
        }),
        judge: { silent: true },
      }),
    );
    expect(submitted).toMatchObject({ verdict: "fail", incomplete: ["judge"] });
  });

  it("says it on the stack the developer reads, whatever the length of the stack", () => {
    const stack = creatorStack([], 7, ["relevance", "judge"]);
    expect(stack.incomplete).toEqual(["relevance", "judge"]);
    expect(stackText(stack)).toBe(" Review possibly incomplete: no report from relevance, judge.");
    expect(stackText(creatorStack([], 7, []))).toBe("");
  });
});

describe("a review of a change that belongs to no story", () => {
  const INTENT = "Show the profile name, and nothing else.";
  const freeStart =
    (call: (name: string, input: Record<string, unknown>) => Promise<unknown>) =>
    (free: Record<string, unknown>, over: Record<string, unknown> = {}) =>
      call("start_review", { agent: "quentin", kind: "qa", free, ...over }) as Promise<{
        ok: boolean;
        value?: unknown;
        error?: { code: string; details: Record<string, unknown> };
      }>;
  type FreeStarted = {
    story: null;
    commit: string;
    pass: number;
    criteria: string[];
    source: string;
    intent: string;
    statements?: string;
    diff: string;
    readers: Array<{
      reader: string;
      lenses: string[];
      judge: boolean;
      passes?: string[];
      diff: string;
    }>;
    lenses: Array<{ lens: string }>;
  };

  it("reads a range of commits through Git, with the same lenses and the intent as its one criterion", async () => {
    const { call, diff, files } = await product();
    diff.freeDiff = { diff: PLAIN_DIFF, messages: "Show the name\n---\nFix the title\n---\n" };
    const started = resultValue<FreeStarted>(
      await freeStart(call)({ source: "main~2..HEAD", intent: INTENT }),
    );
    expect(diff.requests).toEqual([{ kind: "range", from: "main~2", to: "HEAD", dots: ".." }]);
    expect(started).toMatchObject({
      story: null,
      pass: 1,
      criteria: [INTENT],
      source: "main~2..HEAD",
      intent: INTENT,
    });
    expect(started.commit).toMatch(/^[0-9a-f]{64}$/);
    // The same lenses and readers as a story's small change: one reader, the judge's check with it.
    expect(started.readers).toMatchObject([
      {
        reader: "whole",
        lenses: ["verification_gaps", "relevance"],
        judge: true,
        passes: ["assertions"],
      },
    ]);
    expect(await files.readText(started.diff)).toContain("diff --git a/src/profile.ts");
    expect(await files.readText(started.statements as string)).toContain("Fix the title");
  });

  it("reads the work not committed, a branch, a pull request and a pasted diff", async () => {
    const { call, diff, forge } = await product();
    const start = freeStart(call);
    diff.freeDiff = { diff: PLAIN_DIFF, messages: "" };
    await start({ source: "uncommitted", intent: INTENT });
    await start({ source: "branch:feat/profile", intent: INTENT });
    await start({ source: "main...feat/profile", intent: INTENT });
    expect(diff.requests).toEqual([
      { kind: "uncommitted" },
      { kind: "branch", name: "feat/profile" },
      { kind: "range", from: "main", to: "feat/profile", dots: "..." },
    ]);
    forge.prDiffs.set(77, PLAIN_DIFF);
    const pr = resultValue<FreeStarted>(await start({ source: "pr:77", intent: INTENT }));
    expect(pr).toMatchObject({ story: null, source: "pr:77" });
    const pasted = resultValue<FreeStarted>(await start({ diff: PLAIN_DIFF, intent: INTENT }));
    expect(pasted).toMatchObject({ story: null, source: "pasted diff" });
    // The same diff is the same review: named by its hash.
    expect(pasted.commit).toBe(pr.commit);
  });

  it("refuses what it cannot read, a reader who is not of the quality domain, and a free security review", async () => {
    const { call, diff } = await product();
    const start = freeStart(call);
    const why = (result: { error?: { details: Record<string, unknown> } }) =>
      String(result.error?.details.why);
    expect(errorOf(await start({ source: "last week", intent: INTENT }))?.code).toBe(
      ErrorCode.REVIEW_NOT_POSSIBLE,
    );
    expect(why(await start({ source: "last week", intent: INTENT }))).toContain("none of");
    expect(why(await start({ diff: "just words", intent: INTENT }))).toContain("not a git diff");
    // Git cannot read it: said, not guessed.
    diff.freeDiff = undefined;
    expect(why(await start({ source: "uncommitted", intent: INTENT }))).toContain("cannot read");
    expect(why(await start({ source: "pr:9", intent: INTENT }))).toContain("pr:9");
    expect(
      errorOf(await start({ diff: PLAIN_DIFF, intent: INTENT }, { agent: "sam" }))?.details.reason,
    ).toBe("free_not_reviewer");
    expect(
      errorOf(await start({ diff: PLAIN_DIFF, intent: INTENT }, { agent: "main" }))?.details.reason,
    ).toBe("free_not_reviewer");
    // The input itself: a story or a free change, never both nor none; the intent; only quality.
    for (const input of [
      { agent: "quentin", kind: "qa" },
      { agent: "quentin", kind: "qa", story: "1-1", free: { diff: PLAIN_DIFF, intent: INTENT } },
      { agent: "quentin", kind: "qa", free: { diff: PLAIN_DIFF } },
      {
        agent: "quentin",
        kind: "qa",
        free: { source: "uncommitted", diff: PLAIN_DIFF, intent: INTENT },
      },
      { agent: "warden", kind: "security", free: { diff: PLAIN_DIFF, intent: INTENT } },
    ]) {
      expect(errorOf(await call("start_review", input))?.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    }
  });

  it("records the review in the journal with no story, tells the creator the stack and touches no story", async () => {
    const { call, journal, projection, diff, review, toReview } = await product();
    await toReview();
    diff.freeDiff = { diff: PLAIN_DIFF, messages: "" };
    const started = resultValue<FreeStarted>(
      await freeStart(call)({ source: "uncommitted", intent: INTENT }),
    );
    const submit = (over: Record<string, unknown> = {}) =>
      call("submit_review", {
        agent: "quentin",
        kind: "qa",
        commit: started.commit,
        summary: "Looked at the change against its intent.",
        findings: [],
        lenses: [
          lensReport("verification_gaps", [
            lensFinding({ severity: "should_fix", title: "No test proves the name is shown" }),
          ]),
          lensReport("relevance", [
            lensFinding({ severity: "blocking", title: "It also reorders the settings" }),
          ]),
        ],
        judge: {
          ...judgeReport(),
          findings: [
            {
              finding: "verification_gaps#1",
              status: "confirmed",
              severity: "should_fix",
              evidence: "No test of src/profile.test.ts reads the name.",
            },
            {
              finding: "relevance#1",
              status: "refuted",
              evidence: "The settings file is not in the diff at all: only src/profile.ts changed.",
              at: "src/profile.ts:1",
            },
          ],
        },
        ...over,
      });
    const done = resultValue<{
      review: string;
      verdict: string;
      refuted: number;
      incomplete: string[];
      stack: { lines: string[]; fixed: number };
    }>(await submit());
    expect(done).toMatchObject({ verdict: "pass_with_reservations", refuted: 1, incomplete: [] });
    expect(done.review).toMatch(/^R-[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(done.stack.lines).toHaveLength(1);
    expect(done.stack.lines[0]).toContain("No test proves the name is shown");
    // In the journal, with no story.
    const event = journal.events.find((entry) => entry.type === "review.free_reviewed");
    expect(event?.story).toBeUndefined();
    expect(event?.payload).toMatchObject({
      commit: started.commit,
      source: "uncommitted work",
      intent: INTENT,
      verdict: "pass_with_reservations",
      files: 1,
      ruled: { confirmed: 1, refuted: 1, undecided: 0 },
    });
    // In the state: a short record, the story 1-1 untouched (still in review, no pass).
    const state = await projection();
    const kept = Object.values(
      state.free_reviews as Record<string, { verdict: string; refuted: number }>,
    );
    expect(kept).toMatchObject([{ verdict: "pass_with_reservations", refuted: 1 }]);
    const story = (state.stories as Record<string, { status: string; review?: unknown }>)["1-1"];
    expect(story?.status).toBe("in_review");
    expect(story?.review).toBeUndefined();
    // A review of the story itself still works beside it.
    expect(
      resultValue<{ complete: boolean }>(
        await review("quentin", "qa", [], { lenses: smallLenses(), judge: judgeReport() }),
      ).complete,
    ).toBe(true);
  });

  it("refuses to record a free review it did not start, or one the lenses of which are not whole", async () => {
    const { call, diff } = await product();
    diff.freeDiff = { diff: PLAIN_DIFF, messages: "" };
    const started = resultValue<FreeStarted>(
      await freeStart(call)({ source: "uncommitted", intent: INTENT }),
    );
    const submit = (over: Record<string, unknown>) =>
      call("submit_review", {
        agent: "quentin",
        kind: "qa",
        commit: started.commit,
        summary: "Looked.",
        findings: [],
        ...over,
      });
    expect(
      errorOf(await submit({ commit: "a".repeat(64), lenses: smallLenses(), judge: judgeReport() }))
        ?.details.reason,
    ).toBe("free_unknown");
    expect(
      String(
        errorOf(await submit({ lenses: [lensReport("relevance")], judge: judgeReport() }))?.details
          .problems,
      ),
    ).toBe("lens_missing:verification_gaps");
    expect(
      errorOf(await submit({ agent: "sam", lenses: smallLenses(), judge: judgeReport() }))?.details
        .reason,
    ).toBe("free_not_reviewer");
    expect(
      errorOf(await submit({ kind: "security", lenses: [lensReport("security")] }))?.details.reason,
    ).toBe("free_not_reviewer");
  });

  it("carries the security lens itself when the paths of the change call for it", async () => {
    const { call, diff } = await product();
    diff.freeDiff = { diff: DEPENDENCY_DIFF, messages: "" };
    const started = resultValue<FreeStarted>(
      await freeStart(call)({ source: "uncommitted", intent: INTENT }),
    );
    expect(started.lenses.map((entry) => entry.lens)).toContain("security");
    expect(started.readers.map((reader) => reader.reader)).toEqual([
      "security",
      "depth",
      "form",
      "judge",
    ]);
  });

  it("ignores a free review whose verdict is not the findings', or that names a story", async () => {
    const { journal, productId, projection } = await product();
    const base = {
      commit: "b".repeat(64),
      source: "pasted diff",
      intent: "Show the name.",
      files: 1,
      summary: "Looked.",
      findings: [{ severity: "blocking", title: "It crashes" }],
    };
    await journal.appendAll([
      {
        type: "review.free_reviewed",
        actor: { kind: "agent", agent: "quentin" },
        product: productId,
        provenance: "trusted",
        payload: { ...base, verdict: "pass" },
      },
      {
        type: "review.free_reviewed",
        actor: { kind: "agent", agent: "quentin" },
        product: productId,
        story: "1-1",
        provenance: "trusted",
        payload: { ...base, verdict: "fail" },
      },
    ]);
    expect((await projection()).free_reviews).toBeUndefined();
  });
});

describe("the review as a request that stands alone", () => {
  const REFS = ".agentplugged/skills/review-story/references";
  const seedSkill = (files: { seed(path: string, text: string): void }) => {
    files.seed(
      ".agentplugged/skills/review-story/SKILL.md",
      "---\nname: review-story\ndescription: Review a story.\nmetadata:\n  agent: quentin\n  phase: build\n---\n# Review a story\n",
    );
    files.seed(`${REFS}/format.md`, "FORMAT: one JSON answer.");
    files.seed(`${REFS}/judge.md`, "JUDGE: rule on every finding.");
    for (const lens of [
      "adversarial",
      "edge-cases",
      "verification-gaps",
      "structure",
      "prose",
      "relevance",
      "security",
    ]) {
      files.seed(`${REFS}/lens-${lens}.md`, `LENS ${lens}: look.`);
    }
    files.seed(`${REFS}/pass-assertions.md`, "PASS assertions: try.");
    files.seed(`${REFS}/pass-removals.md`, "PASS removals: restore.");
  };

  it("writes the criteria, the lenses, the judge, the shape of the answer and the diff in one file", async () => {
    const { call, toReview, files, diff } = await product();
    seedSkill(files);
    diff.messagesOf.set(HEAD, "Show the profile\n---\n");
    await toReview();
    const exported = resultValue<{
      story: string;
      commit: string;
      prompt: string;
      lenses: string[];
      chars: number;
    }>(await call("export_review", { agent: "quentin", story: "1-1", kind: "qa" }));
    expect(exported).toMatchObject({
      story: "1-1",
      commit: HEAD,
      lenses: ["verification_gaps", "relevance"],
    });
    const text = await files.readText(exported.prompt);
    expect(text.length).toBe(exported.chars);
    for (const part of [
      "# Independent review: story 1-1: Profile",
      "1. Given Ada, when she opens her profile, then she sees her name.",
      "LENS verification-gaps: look.",
      "LENS relevance: look.",
      "PASS assertions: try.",
      "JUDGE: rule on every finding.",
      "FORMAT: one JSON answer.",
      "Show the profile",
      "diff --git a/src/profile.ts b/src/profile.ts",
      "+  return load();",
    ]) {
      expect(text, part).toContain(part);
    }
    // Nothing of the developer's, nothing of the journal.
    expect(text).not.toContain("3 tests pass");
  });

  it("takes the answer back through review.submit, whole or refused with what is missing", async () => {
    const { call, toReview, files, review } = await product();
    seedSkill(files);
    await toReview();
    const exported = resultValue<{ commit: string }>(
      await call("export_review", { agent: "quentin", story: "1-1", kind: "qa" }),
    );
    // What another tool answered: the object of the request's last section, taken as it comes.
    const answer = {
      summary: "Looked, in another model.",
      lenses: smallLenses({
        relevance: [lensFinding({ title: "The empty profile shows nothing" })],
      }),
      judge: {
        ...judgeReport(),
        findings: [
          {
            finding: "relevance#1",
            status: "confirmed",
            severity: "should_fix",
            evidence: "src/profile.ts:2 returns null for a new user.",
          },
        ],
      },
    };
    const refused = await review("quentin", "qa", [], {
      commit: exported.commit,
      ...answer,
      lenses: [answer.lenses[0]],
    });
    expect(String(errorOf(refused)?.details.problems)).toContain("lens_missing:relevance");
    const taken = resultValue<{ verdict: string; complete: boolean }>(
      await review("quentin", "qa", [], { commit: exported.commit, ...answer }),
    );
    expect(taken).toMatchObject({ verdict: "pass_with_reservations", complete: true });
  });

  it("exports a free review too, diff included, and says which file of the skill is missing", async () => {
    const { call, files, diff } = await product();
    diff.freeDiff = { diff: PLAIN_DIFF, messages: "" };
    const input = {
      agent: "quentin",
      kind: "qa",
      free: { source: "uncommitted", intent: "Show the name." },
    };
    const missing = await call("export_review", input);
    expect(String(errorOf(missing)?.details.why)).toContain("lens-verification-gaps.md is missing");
    seedSkill(files);
    const exported = resultValue<{ story: null; prompt: string; commit: string }>(
      await call("export_review", input),
    );
    expect(exported.story).toBeNull();
    const text = await files.readText(exported.prompt);
    expect(text).toContain("# Independent review: uncommitted work, free review");
    expect(text).toContain("1. Show the name.");
    expect(text).toContain("+  return load();");
  });

  it("leaves the judge out of the request of a review that has none", () => {
    const parts = { format: "F", judge: "JUDGE-TEXT", lens: {}, pass: {} };
    const input = {
      subject: "x",
      criteria: ["Works."],
      lenses: [],
      passes: [],
      statements: "",
      diff: "+a\n",
      parts,
    } as const;
    const security = exportPrompt({ ...input, judge: false });
    expect(security).not.toContain("JUDGE-TEXT");
    expect(security).not.toContain("play the judge");
    expect(security).not.toContain('"judge"');
    expect(exportPrompt({ ...input, judge: true })).toContain("JUDGE-TEXT");
    expect(exportPrompt({ ...input, judge: true })).toContain('"judge"');
  });

  it("fences a diff that holds backquotes without letting it close the fence", () => {
    const text = exportPrompt({
      subject: "x",
      criteria: ["Works."],
      lenses: [],
      passes: [],
      judge: true,
      statements: "",
      diff: "+```\n+code\n+```\n",
      parts: { format: "F", judge: "J", lens: {}, pass: {} },
    });
    expect(text).toContain("````diff\n+```\n+code\n+```\n\n````");
  });
});

describe("the reader of verification gaps runs short passes", () => {
  const removing = [
    "diff --git a/src/profile.ts b/src/profile.ts",
    "--- a/src/profile.ts",
    "+++ b/src/profile.ts",
    "@@ -1,8 +1,3 @@",
    " export function profile() {",
    "-  if (!user) throw new Error('no user');",
    "-  audit('profile', user.id);",
    "-  const name = clean(user.name);",
    "-  cache.set(user.id, name);",
    "-  return name;",
    "+  return load();",
    " }",
    "",
  ].join("\n");

  it("adds the removals pass when the change takes code away, and the assertions pass when there is anything to test", async () => {
    const { call, diff, toReview } = await product();
    diff.diffs.set(HEAD, removing);
    diff.messagesOf.set(HEAD, "Simplify the profile\n---\n");
    await toReview();
    const started = resultValue<{
      statements?: string;
      readers: Array<{ reader: string; passes?: string[] }>;
    }>(await call("start_review", { agent: "quentin", story: "1-1", kind: "qa" }));
    expect(started.readers).toMatchObject([
      { reader: "whole", passes: ["removals", "assertions"] },
    ]);
    expect(started.statements).toMatch(/\.statements\.txt$/);
  });

  it("is pure: the removals pass from five removed lines of code, never for documents or lockfiles", () => {
    const code = (path: string, removed: number) => ({ path, added: 0, removed });
    expect(readerPasses([code("src/a.ts", 4)], false)).toEqual([]);
    expect(readerPasses([code("src/a.ts", 5)], false)).toEqual(["removals"]);
    expect(readerPasses([code("src/a.ts", 2), code("src/b.test.ts", 3)], true)).toEqual([
      "removals",
      "assertions",
    ]);
    expect(readerPasses([code("docs/guide.md", 50), code("pnpm-lock.yaml", 50)], false)).toEqual(
      [],
    );
    // Only the reader that carries the verification gaps gets them, and only one.
    const carrier = (files: Array<{ path: string; added: number; removed: number }>) =>
      planReaders("qa", chooseLenses(files, []), false, ["removals", "assertions"]).flatMap(
        (reader) => (reader.passes === undefined ? [] : [reader.reader]),
      );
    expect(carrier([code("src/a.ts", 30)])).toEqual(["whole"]);
    expect(carrier([code("src/a.ts", 200)])).toEqual(["whole"]);
    expect(
      planReaders("qa", chooseLenses([code("src/a.ts", 200)], []), true, ["removals"]).flatMap(
        (reader) => (reader.passes === undefined ? [] : [reader.reader]),
      ),
    ).toEqual(["depth"]);
    // The security reader carries no pass.
    expect(
      planReaders("security", chooseLenses([code("src/auth/a.ts", 30)], ["paths"]), false, [
        "assertions",
      ]),
    ).toEqual([{ reader: "security", lenses: ["security"], judge: false }]);
  });
});

describe("the merge of a story approved from the web view", () => {
  const WEB_ORDER = "01J9ZQ4V8E3M5N7P9R1S3T5V80";
  const OTHER_ORDER = "01J9ZQ4V8E3M5N7P9R1S3T5V81";
  const THIRD_ORDER = "01J9ZQ4V8E3M5N7P9R1S3T5V82";
  const WEB_DEVICE = "browser:abcdefghijklmnop";

  /** A story reviewed on a green CI, its merge checkpoint open, and the machine's side of the web. */
  async function reviewed() {
    const setup = await product();
    await setup.toReview();
    const passed = resultValue<{ checkpoint: string }>(await setup.review("quentin", "qa"));
    const point = passed.checkpoint;
    const story = async () =>
      ((await setup.projection()).stories as Record<string, StoryState> | undefined)?.[
        "1-1"
      ] as StoryState;
    const checkpoint = async () =>
      ((await setup.projection()).checkpoints as Record<string, CheckpointState>)[
        point
      ] as CheckpointState;
    const merging = engineMerging(setup.human);
    const answer = (
      params: { decision: "approved" | "changes_requested" | "rejected"; note?: string },
      at: number,
      order = WEB_ORDER,
      device = WEB_DEVICE,
    ) =>
      writeWebAnswer(
        setup.journal,
        setup.productId,
        {
          params: { checkpoint: point, ...params } as AnswerCheckpointParams,
          order,
          device,
        },
        () => at,
      );
    const carry = (at: number, withMerging = true) =>
      carryOutWebAnswers(
        setup.journal,
        setup.productId,
        () => at,
        withMerging ? merging : undefined,
      );
    const typed = async (type: string) =>
      (await setup.journal.list()).events.filter((event) => event.type === type);
    return { ...setup, point, story, checkpoint, answer, carry, typed };
  }

  /** When the held answer's window ends, and a moment after. */
  const windowOf = (held: { event: { at: string } }) => Date.parse(held.event.at) + 10_000;

  it("merges after the window, never before, and records the answer and the merge in one write", async () => {
    const { answer, carry, forge, workspace, checkpoint, story, typed, point, journal } =
      await reviewed();
    const written = await answer({ decision: "approved" }, Date.now());
    expect(written).toMatchObject({ ok: true, held: true });
    if (!written.ok) throw new Error("not written");
    // Held: the point is open for everyone and nothing touched the forge.
    expect((await checkpoint()).status).toBe("open");
    expect((await checkpoint()).pending_answer).toMatchObject({ decision: "approved" });
    expect(await carry(windowOf(written) - 1_000)).toMatchObject({ decided: 0 });
    expect(forge.merges).toEqual([]);
    // The window is over: the engine merges the commit reviewed, once, then the answer is written.
    expect(await carry(windowOf(written) + 500)).toMatchObject({ decided: 1, failed: 0 });
    expect(forge.merges).toEqual([{ number: 41, request: { commit: HEAD, method: "merge" } }]);
    expect((await checkpoint()).resolution).toMatchObject({
      decision: "approved",
      source: "web",
      assurance: "device",
      by: expect.stringMatching(/^machine:/),
    });
    expect((await story()).merged).toMatchObject({
      checkpoint: point,
      pr: 41,
      commit: HEAD,
      merge_commit: MERGE_COMMIT,
      source: "web",
      already: false,
    });
    expect(workspace.worktrees.has("feat/1-1-work")).toBe(false);
    // Both events, from the machine, in order.
    const events = (await journal.list()).events;
    const at = (type: string) => events.findIndex((event) => event.type === type);
    expect(at("checkpoint.web_answered")).toBeGreaterThan(-1);
    expect(at("story.merged")).toBe(at("checkpoint.web_answered") + 1);
    expect((await typed("story.merged"))[0]?.actor.kind).toBe("system");
    // A second pass finds nothing to do and never merges twice.
    expect(await carry(windowOf(written) + 5_000)).toMatchObject({ decided: 0 });
    expect(forge.merges).toHaveLength(1);
  });

  it("merges nothing when the creator takes the answer back inside the window", async () => {
    const { answer, carry, forge, checkpoint, story, journal, point, productId } = await reviewed();
    const written = await answer({ decision: "approved" }, Date.now());
    if (!written.ok) throw new Error("not written");
    const undone = await undoWebAnswer(
      journal,
      productId,
      { params: { checkpoint: point }, order: OTHER_ORDER, device: WEB_DEVICE },
      () => Date.parse(written.event.at) + 4_000,
    );
    expect(undone.ok).toBe(true);
    expect(await carry(windowOf(written) + 500)).toMatchObject({ decided: 0, failed: 0 });
    expect(forge.merges).toEqual([]);
    expect((await checkpoint()).status).toBe("open");
    expect((await story()).merged).toBeUndefined();
  });

  it("releases the answer with the reason when the forge refuses, and the point can be answered again", async () => {
    const { answer, carry, forge, checkpoint, story, typed, point } = await reviewed();
    forge.mergeRefusal = {
      reason: "not_mergeable",
      message: "HTTP 405: conflicts, token ghp_secret",
    };
    const first = await answer({ decision: "approved" }, Date.now());
    if (!first.ok) throw new Error("not written");
    expect(await carry(windowOf(first) + 500)).toMatchObject({ decided: 0, failed: 1 });
    expect(forge.merges).toHaveLength(1);
    const open = await checkpoint();
    expect(open.status).toBe("open");
    expect(open.pending_answer).toBeNull();
    expect(open.web_failure).toMatchObject({ code: "MERGE_FAILED", reason: "not_mergeable" });
    // The journal keeps a code and a reason, never the forge’s words.
    const failure = (await typed("checkpoint.web_hold_failed"))[0];
    expect(failure?.payload).toMatchObject({ checkpoint: point, code: "MERGE_FAILED" });
    expect(JSON.stringify(failure?.payload)).not.toContain("ghp_secret");
    expect((await story()).merged).toBeUndefined();
    // The creator tries again once the forge agrees: held again, then merged.
    forge.mergeRefusal = undefined;
    const second = await answer({ decision: "approved" }, windowOf(first) + 1_000, OTHER_ORDER);
    expect(second).toMatchObject({ ok: true, held: true });
    if (!second.ok) throw new Error("not written");
    expect((await checkpoint()).web_failure ?? null).toBeNull();
    expect(await carry(windowOf(second) + 500)).toMatchObject({ decided: 1, failed: 0 });
    expect((await story()).merged).toMatchObject({ source: "web" });
  });

  it("counts the merges refused for the same cause, and starts again on another cause", async () => {
    const { answer, carry, forge, checkpoint, next } = await reviewed();
    forge.mergeRefusal = { reason: "not_mergeable", message: "conflicts" };
    const first = await answer({ decision: "approved" }, Date.now());
    if (!first.ok) throw new Error("not written");
    await carry(windowOf(first) + 500);
    expect((await checkpoint()).web_failure_repeat).toMatchObject({ count: 1 });
    // One refusal: the failure is shown beside the point, no change of method yet.
    const once = await next();
    expect(once.waiting[0]?.failure).toMatchObject({ reason: "not_mergeable" });
    expect(once.change_method).toBeUndefined();
    const second = await answer({ decision: "approved" }, windowOf(first) + 1_000, OTHER_ORDER);
    if (!second.ok) throw new Error("not written");
    await carry(windowOf(second) + 500);
    const twice = await checkpoint();
    // The answer cleared the failure, the count of identical refusals stayed.
    expect(twice.web_failure).toMatchObject({ reason: "not_mergeable" });
    expect(twice.web_failure_repeat).toMatchObject({
      key: "MERGE_FAILED:not_mergeable",
      count: 2,
    });
    // The same refusal twice: `next` stops the same try, on the creator's merge point too.
    expect(await next()).toMatchObject({
      step: "validation",
      change_method: { cause: "merge", times: 2, what: "MERGE_FAILED:not_mergeable" },
    });
    forge.mergeRefusal = { reason: "failed", message: "x" };
    const third = await answer({ decision: "approved" }, windowOf(second) + 1_000, THIRD_ORDER);
    if (!third.ok) throw new Error("not written");
    await carry(windowOf(third) + 500);
    expect((await checkpoint()).web_failure_repeat).toMatchObject({ count: 1 });
  });

  it("says the branch moved past the commit reviewed, and asks for a new pass instead of the same merge", async () => {
    const { answer, carry, forge, workspace, checkpoint, story, next, green, review, diff } =
      await reviewed();
    // A commit lands on the story's branch after its review was approved.
    workspace.head(HEAD2);
    forge.head = HEAD2;
    const first = await answer({ decision: "approved" }, Date.now());
    if (!first.ok) throw new Error("not written");
    expect(await carry(windowOf(first) + 500)).toMatchObject({ decided: 0, failed: 1 });
    expect(forge.merges).toEqual([]);
    expect((await checkpoint()).web_failure).toMatchObject({
      code: "MERGE_NOT_READY",
      reason: "head_moved",
    });
    // Never the same merge again: a new pass, and the refusal said beside the point.
    const step = await next();
    expect(step).toMatchObject({
      step: "review",
      agent: "quentin",
      review: { pass: 2, qa: "pending", reviewers: ["quentin"] },
    });
    const pointId = (await checkpoint()).id;
    expect(step.waiting.find((entry) => entry.id === pointId)).toMatchObject({
      failure: { code: "MERGE_NOT_READY", reason: "head_moved" },
    });
    // The new pass approves the new head: the merge goes through.
    diff.diffs.set(HEAD2, PLAIN_DIFF);
    await green(HEAD2);
    expect(errorOf(await review("quentin", "qa"))).toBeUndefined();
    expect((await next()).step).toBe("validation");
    const second = await answer({ decision: "approved" }, windowOf(first) + 1_000, OTHER_ORDER);
    if (!second.ok) throw new Error("not written");
    expect(await carry(windowOf(second) + 500)).toMatchObject({ decided: 1, failed: 0 });
    expect((await story()).merged).toMatchObject({ commit: HEAD2 });
  });

  it("records a merge the creator already did at the forge without merging again", async () => {
    const { answer, carry, forge, story } = await reviewed();
    forge.prState = "merged";
    const written = await answer({ decision: "approved" }, Date.now());
    if (!written.ok) throw new Error("not written");
    expect(await carry(windowOf(written) + 500)).toMatchObject({ decided: 1 });
    expect(forge.merges).toEqual([]);
    expect((await story()).merged).toMatchObject({ already: true, source: "web" });
  });

  it("merges the story for the signed order of a phone too, and records the source mobile on both events", async () => {
    const { answer, carry, forge, checkpoint, story, typed } = await reviewed();
    const written = await answer(
      { decision: "approved" },
      Date.now(),
      WEB_ORDER,
      "phone:abcdefghijklmnop",
    );
    if (!written.ok) throw new Error("not written");
    expect(await carry(windowOf(written) + 500)).toMatchObject({ decided: 1, failed: 0 });
    expect(forge.merges).toHaveLength(1);
    expect((await checkpoint()).resolution).toMatchObject({
      decision: "approved",
      source: "mobile",
      assurance: "device",
    });
    expect((await story()).merged).toMatchObject({ source: "mobile", already: false });
    expect((await typed("story.merged"))[0]?.actor.kind).toBe("system");
  });

  it("sends the story back to its agent with the reason, merging nothing", async () => {
    const { answer, carry, forge, checkpoint, story } = await reviewed();
    const written = await answer(
      { decision: "changes_requested", note: "Handle the empty profile before the merge." },
      Date.now(),
    );
    if (!written.ok) throw new Error("not written");
    expect(await carry(windowOf(written) + 500)).toMatchObject({ decided: 1 });
    expect(forge.merges).toEqual([]);
    expect((await checkpoint()).resolution).toMatchObject({
      decision: "changes_requested",
      note: "Handle the empty profile before the merge.",
      source: "web",
    });
    expect(await story()).toMatchObject({
      status: "in_progress",
      merge_feedback: {
        decision: "changes_requested",
        note: "Handle the empty profile before the merge.",
      },
    });
    expect((await story()).merged).toBeUndefined();
  });

  it("refuses at the click a merge whose gate is closed, with its own code, and releases one whose gate closed during the window", async () => {
    const setup = await reviewed();
    const red = () =>
      setup.journal.appendAll([
        {
          type: "story.ci_reported",
          actor: { kind: "system" },
          product: setup.productId,
          story: "1-1",
          provenance: "trusted",
          payload: {
            forge: "github",
            status: "fail",
            checks: 4,
            failed: ["build"],
            pr: 41,
            commit: HEAD,
            read_at: new Date().toISOString(),
          },
        },
      ]);
    // Held while the gate is open, then the CI goes red during the window: nothing reaches the forge.
    const held = await setup.answer({ decision: "approved" }, Date.now());
    if (!held.ok) throw new Error("not written");
    await red();
    expect(await setup.carry(windowOf(held) + 500)).toMatchObject({ decided: 0, failed: 1 });
    expect(setup.forge.merges).toEqual([]);
    expect((await setup.typed("checkpoint.web_hold_failed"))[0]?.payload).toMatchObject({
      code: "MERGE_NOT_READY",
    });
    // And a new click is refused at once, without a window.
    expect(
      await setup.answer({ decision: "approved" }, windowOf(held) + 1_000, OTHER_ORDER),
    ).toEqual({ ok: false, code: "MERGE_NOT_READY" });
  });

  it("leaves an approval alone on a machine that cannot merge, and never decides it later by itself", async () => {
    const { answer, carry, checkpoint, forge } = await reviewed();
    const written = await answer({ decision: "approved" }, Date.now());
    if (!written.ok) throw new Error("not written");
    expect(await carry(windowOf(written) + 500, false)).toMatchObject({ decided: 0, failed: 0 });
    expect((await checkpoint()).status).toBe("open");
    expect(forge.merges).toEqual([]);
  });

  it("ignores a merge, a held answer and a release written by anyone but the machine", async () => {
    const { journal, productId, story, point, checkpoint } = await reviewed();
    const forged = (
      type: string,
      actor: Record<string, unknown>,
      payload: Record<string, unknown>,
    ) =>
      journal.appendAll([
        { type, actor, product: productId, story: "1-1", provenance: "trusted", payload } as never,
      ]);
    const agent = { kind: "agent", agent: "sam" };
    // An agent writes the machine's words: a merge of a point nobody answered, a held answer, a release.
    await forged("story.merged", agent, {
      checkpoint: point,
      forge: "github",
      pr: 41,
      url: "https://github.com/ada/shop/pull/41",
      commit: HEAD,
      method: "merge",
      files: [],
      source: "web",
    });
    await forged("checkpoint.web_held", agent, {
      checkpoint: point,
      decision: "approved",
      source: "web",
      order: WEB_ORDER,
      device: WEB_DEVICE,
    });
    await forged("checkpoint.web_hold_failed", agent, {
      checkpoint: point,
      held: WEB_ORDER,
      device: WEB_DEVICE,
      code: "MERGE_FAILED",
    });
    expect((await story()).merged).toBeUndefined();
    expect((await checkpoint()).pending_answer ?? null).toBeNull();
    expect((await checkpoint()).web_failure ?? null).toBeNull();
    expect((await checkpoint()).status).toBe("open");
  });
});
