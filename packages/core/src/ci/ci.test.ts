import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { CI_EVENT_TYPES, DOMAIN_IDS, ErrorCode, type PhaseId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { resolutionProblem } from "../checkpoints/resolution-rules.js";
import {
  type AgentStateView,
  type CheckpointState,
  type CiCheck,
  type CiCheckResult,
  type CiReader,
  type CiReading,
  type CiRepository,
  type CiSetupResult,
  type CiWaiveResult,
  type CommandContext,
  checkName,
  ciPayload,
  ciPlan,
  computeProjection,
  createCommandRegistry,
  existingCi,
  heldMergeCheckpoint,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  mergeGate,
  mergeReady,
  type NextConfig,
  type NextResult,
  nextStep,
  type RecordedEvent,
  renderCiTemplate,
  resolveProfile,
  type StoryWorkspace,
  type StoryWorkspaceInspection,
  type StoryWorkspaceTarget,
  storyCiStatus,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(7));
const HEAD = "a".repeat(40);
const NEWER = "b".repeat(40);

const GITHUB_TEMPLATE = [
  "{{header}}",
  "on:",
  "  push:",
  "    branches: [{{main_branch}}]",
  "concurrency:",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own expression, kept as is.
  "  group: ci-${{ github.ref }}",
  "jobs:",
  "  lint:",
  "    timeout-minutes: 15",
  "    steps:",
  "      {{setup}}",
  "      {{lint}}",
  "  test:",
  "    steps:",
  "      {{setup}}",
  "      {{test}}",
  "  build:",
  "    steps:",
  "      {{setup}}",
  "      {{build}}",
  "  audit:",
  "    steps:",
  "      {{setup}}",
  "      {{audit}}",
  "",
].join("\n");

const GITLAB_TEMPLATE = [
  "{{header}}",
  "image: {{image}}",
  "default:",
  "  before_script:",
  "    {{setup}}",
  "lint:",
  "  script:",
  "    {{lint}}",
  "test:",
  "  script:",
  "    {{test}}",
  "build:",
  "  script:",
  "    {{build}}",
  "audit:",
  "  script:",
  "    {{audit}}",
  "",
].join("\n");

/** The forge in memory: the repository, then one reading per call (the last one repeats). */
class FakeCiReader implements CiReader {
  repo: CiRepository | null = { forge: "github", prefix: "", main: "main", ci: [] };
  readings: CiReading[] = [];
  readonly calls: Array<{ branch: string; forge: string }> = [];
  /** Runs while the forge is read: a concurrent writer, in the race test. */
  onRead: (() => Promise<void>) | undefined;

  async repository() {
    return this.repo;
  }

  async read(branch: string, forge: string): Promise<CiReading> {
    this.calls.push({ branch, forge });
    await this.onRead?.();
    const reading = this.readings.length > 1 ? this.readings.shift() : this.readings[0];
    if (reading === undefined) throw new Error("no reading");
    return reading;
  }
}

/** The story branches of the repository, by name, and their head: the Git port. */
class FakeWorkspace implements StoryWorkspace {
  readonly heads = new Map<string, string>();
  /** What the forge holds for the branch, when ahead of the local head. */
  forgeHead: string | undefined;
  async remoteHead() {
    return this.forgeHead;
  }

  async inspect(target: StoryWorkspaceTarget): Promise<StoryWorkspaceInspection> {
    const head = this.heads.get(target.branch);
    return {
      repository: true,
      prefix: "",
      main: { ref: "main", commit: "c".repeat(40) },
      storyBlob: null,
      branch: head === undefined ? null : { commit: head, merged: false, storyBlob: null },
      checkedOut: null,
      target: { path: `/repos/shop.worktrees/${target.id}`, relative: "", exists: false },
    };
  }
  create = () => Promise.reject(new Error("unused"));
  discard = async () => true;
  readBlob = async () => undefined;
  storyFilesOn = async () => undefined;
  installCommitHook = () => Promise.reject(new Error("unused"));
}

const checks = (...states: Array<[string, CiCheck["state"]]>): CiCheck[] =>
  states.map(([name, state]) => ({ name, state }));

const green = (commit = HEAD): CiReading => ({
  ok: true,
  checks: checks(["lint", "pass"], ["test", "pass"], ["build", "pass"], ["audit", "pass"]),
  pr: 12,
  url: "https://github.com/acme/shop/pull/12",
  commit,
});
const red = (commit = HEAD): CiReading => ({
  ok: true,
  checks: checks(["lint", "pass"], ["test", "fail"], ["build", "pass"], ["audit", "fail"]),
  pr: 12,
  url: "https://github.com/acme/shop/pull/12",
  commit,
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

/** A product in the build phase, whose journal starts stories directly (the engine's event). */
async function product() {
  const files = new MemoryFiles();
  let clock = Date.UTC(2026, 9, 4, 12, 0, 0);
  const now = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now });
  const reader = new FakeCiReader();
  const workspace = new FakeWorkspace();
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("sam", "Sam", "code", "build"),
      ...shippedAgent("quentin", "Quentin", "quality", "build"),
      ...shippedAgent("omar", "Omar", "delivery", "delivery"),
    }),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    keys,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
    ciReader: reader,
    storyWorkspace: workspace,
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const reader0: CommandContext = { ...human, human: undefined };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
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
    const answered = await answer(opened.checkpoint);
    if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
  }
  const productId = (await journal.productId()) as string;
  /** The engine records a story's start, its builder `agent`, its branch at HEAD. */
  const start = async (story: string, builder = "sam") => {
    workspace.heads.set(`feat/${story}-work`, HEAD);
    await journal.appendAll([
      {
        type: "story.started",
        actor: { kind: "system" },
        product: productId,
        story,
        provenance: "trusted",
        payload: {
          agent: builder,
          branch: `feat/${story}-work`,
          base: "c".repeat(40),
          base_ref: "main",
          worktree: `../shop.worktrees/${story}`,
        },
      },
    ]);
  };
  const next = async () => {
    const result = await registry.run("next", reader0, {});
    if (!result.ok) throw new Error(`next failed: ${result.error.code}`);
    return result.value as NextResult;
  };
  const state = async () => {
    const result = await call("get_state", { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  const projection = async () => (await computeProjection((await journal.list()).events)).state;
  const cli = (story: string, extra: Record<string, unknown> = {}) =>
    registry.run("story", reader0, { action: "ci", story, ...extra });
  const waive = (story: string, reason: string, context: CommandContext = human) =>
    registry.run("story", context, { action: "ci", story, waive: reason });
  // The method's templates, as `ci setup` reads them.
  const templates = new MemoryFiles({
    "skills/setup-ci/assets/github-actions.yml": GITHUB_TEMPLATE,
    "skills/setup-ci/assets/gitlab-ci.yml": GITLAB_TEMPLATE,
  });
  const setup = (input: Record<string, unknown> = {}) =>
    registry.run("ci", { ...reader0, method: templates }, { action: "setup", ...input });
  return {
    files,
    journal,
    reader,
    workspace,
    human,
    agent,
    registry,
    call,
    run,
    answer,
    start,
    next,
    state,
    projection,
    cli,
    waive,
    setup,
    productId,
  };
}

const errorOf = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? undefined : result.error;
const resultOf = <T>(result: { ok: boolean; value?: unknown }) =>
  (result.ok ? result.value : undefined) as T;

describe("check_ci and story ci", () => {
  it("sends a failed story back to its agent, then waits for a green CI on the new head", async () => {
    const { reader, workspace, call, run, start, next, state, cli, journal, files } =
      await product();
    files.seed(".gitlab-ci.yml", "test:\n  script: [true]\n");
    reader.repo = { forge: "github", prefix: "", main: "main", ci: [".gitlab-ci.yml"] };
    await start("1-1");
    await run("update_story", { agent: "sam", story: "1-1", status: "in_review" });
    // In review, CI never read: read it first, or let the creator waive it.
    expect(await next()).toMatchObject({
      step: "ci_check",
      agent: "sam",
      story: "1-1",
      command: "npx agentplugged story ci 1-1",
      ci: {
        status: "unknown",
        failed: [],
        cause: null,
        waive: true,
      },
    });

    reader.readings = [red()];
    const failed = resultOf<CiCheckResult>(
      await call("check_ci", { agent: "quentin", story: "1-1" }),
    );
    expect(failed).toMatchObject({
      story: "1-1",
      branch: "feat/1-1-work",
      agent: "sam",
      forge: "github",
      status: "fail",
      checks: 4,
      failed: ["test", "audit"],
      pr: 12,
      commit: HEAD,
      reopened: true,
      story_status: "in_progress",
      event: { type: CI_EVENT_TYPES.reported },
    });
    expect(reader.calls).toEqual([{ branch: "feat/1-1-work", forge: "github" }]);
    const story = (await state()).stories["1-1"];
    expect(story?.status).toBe("in_progress");
    expect(story?.status_by?.agent).toBe("sam");
    expect(story?.ci).toMatchObject({ status: "fail", commit: HEAD, by: "quentin" });
    const failedStep = {
      step: "ci_failed",
      agent: "sam",
      story: "1-1",
      command: "npx agentplugged story start 1-1",
      ci: { status: "fail", failed: ["test", "audit"], pr: 12, waive: false },
    };
    expect(await next()).toMatchObject(failedStep);
    // Declared in progress again: the failure still stands.
    await run("update_story", { agent: "sam", story: "1-1", status: "in_progress" });
    expect(await next()).toMatchObject(failedStep);

    // Fixed, pushed, back in review: the red read is stale, read it again.
    workspace.heads.set("feat/1-1-work", NEWER);
    await run("update_story", { agent: "sam", story: "1-1", status: "in_review" });
    expect(await next()).toMatchObject({ step: "ci_check", ci: { status: "stale" } });
    // A green read of the old commit counts for nothing.
    const count = (await journal.list()).events.length;
    reader.readings = [green(HEAD)];
    expect(errorOf(await cli("1-1"))).toMatchObject({
      code: ErrorCode.CI_UNAVAILABLE,
      details: { reason: "head_mismatch", commit: HEAD, head: NEWER },
    });
    expect((await journal.list()).events.length).toBe(count);
    reader.readings = [green(NEWER)];
    const passed = resultOf<CiCheckResult>(await cli("1-1"));
    expect(passed).toMatchObject({ status: "pass", failed: [], reopened: false, commit: NEWER });
    const events = (await journal.list()).events.filter((e) => e.type === CI_EVENT_TYPES.reported);
    expect(events.at(-1)?.actor.kind).toBe("system");
    expect(events.at(-1)?.payload).toMatchObject({ commit: NEWER, read_at: expect.any(String) });
    // Green on the head: on to the review.
    expect(await next()).toMatchObject({ step: "review", agent: "quentin", story: "1-1" });
    expect((await next()).ci).toBeUndefined();
    // The branch moves on: the green read no longer covers it.
    const projected = (await computeProjection((await journal.list()).events)).state;
    expect(mergeGate(projected, "1-1", { head: "d".repeat(40) }).ci).toBe("stale");
  });

  it("keeps the status of a pending CI, and of a blocked story", async () => {
    const { reader, call, run, start, state } = await product();
    await start("1-1");
    await run("update_story", { agent: "sam", story: "1-1", status: "in_review" });
    reader.readings = [{ ok: true, checks: checks(["test", "pending"]), commit: HEAD }];
    expect(
      resultOf<CiCheckResult>(await call("check_ci", { agent: "sam", story: "1-1" })),
    ).toMatchObject({ status: "pending", reopened: false, story_status: "in_review" });
    expect((await state()).stories["1-1"]?.status).toBe("in_review");
    await run("update_story", { agent: "sam", story: "1-1", status: "blocked" });
    reader.readings = [red()];
    expect(
      resultOf<CiCheckResult>(await call("check_ci", { agent: "sam", story: "1-1" })),
    ).toMatchObject({ status: "fail", reopened: false, story_status: "blocked" });
    expect((await state()).stories["1-1"]?.status).toBe("blocked");
  });

  it("refuses a read made before the story's status changed (under the journal's lock)", async () => {
    const { reader, call, run, start, journal } = await product();
    await start("1-1");
    await run("update_story", { agent: "sam", story: "1-1", status: "in_progress" });
    reader.readings = [green()];
    reader.onRead = async () => {
      reader.onRead = undefined;
      await run("update_story", { agent: "sam", story: "1-1", status: "in_review" });
    };
    const count = async () =>
      (await journal.list()).events.filter((e) => e.type === CI_EVENT_TYPES.reported).length;
    expect(errorOf(await call("check_ci", { agent: "sam", story: "1-1" }))).toMatchObject({
      code: ErrorCode.CI_UNAVAILABLE,
      details: { reason: "stale_read" },
    });
    expect(await count()).toBe(0);
  });

  it("sees a CI that has not started yet as pending, and never offers to waive it", async () => {
    const { reader, call, run, start, next, files } = await product();
    files.seed(".gitlab-ci.yml", "test:\n  script: [true]\n");
    reader.repo = { forge: "github", prefix: "", main: "main", ci: [".gitlab-ci.yml"] };
    await start("1-1");
    await run("update_story", { agent: "sam", story: "1-1", status: "in_review" });
    reader.readings = [{ ok: true, checks: [], commit: HEAD, pr: 12 }];
    const starting = resultOf<CiCheckResult>(
      await call("check_ci", { agent: "quentin", story: "1-1" }),
    );
    expect(starting).toMatchObject({ status: "pending", checks: 0, waiting: true, starting: true });
    expect(await next()).toMatchObject({
      step: "ci_check",
      ci: { status: "pending", waive: false },
    });
    // Running now: still pending, still waited for.
    reader.readings = [{ ok: true, checks: checks(["test", "pending"]), commit: HEAD, pr: 12 }];
    const running = resultOf<CiCheckResult>(
      await call("check_ci", { agent: "quentin", story: "1-1" }),
    );
    expect(running).toMatchObject({ status: "pending", waiting: true });
    expect(running.starting).toBeUndefined();
  });

  it("takes the commits the creator added on the forge as the story's head", async () => {
    const { reader, workspace, call, run, start } = await product();
    await start("1-1");
    await run("update_story", { agent: "sam", story: "1-1", status: "in_review" });
    // The creator resolved a conflict on the forge: the forge's branch is ahead of the local one.
    workspace.forgeHead = NEWER;
    reader.readings = [green(NEWER)];
    const read = resultOf<CiCheckResult>(
      await call("check_ci", { agent: "quentin", story: "1-1" }),
    );
    expect(read).toMatchObject({ status: "pass", commit: NEWER, forge_ahead: true });
    // The forge has nothing newer: the local head stands, and a CI read on another commit is refused.
    workspace.forgeHead = undefined;
    reader.readings = [green(NEWER)];
    expect(errorOf(await call("check_ci", { agent: "quentin", story: "1-1" }))).toMatchObject({
      details: { reason: "head_mismatch", commit: NEWER, head: HEAD },
    });
  });

  it("writes nothing when the CI cannot be read", async () => {
    const { reader, workspace, call, start, journal, cli } = await product();
    const count = async () => (await journal.list()).events.length;
    expect(errorOf(await call("check_ci", { agent: "sam", story: "1-1" }))).toMatchObject({
      code: ErrorCode.CI_UNAVAILABLE,
      details: { reason: "not_started", story: "1-1" },
    });
    await start("1-1");
    const started = await count();
    const cases: Array<[CiReading, string]> = [
      [{ ok: false, reason: "no_pull_request", tool: "gh" }, "no_pull_request"],
      [{ ok: false, reason: "forge_cli_missing", tool: "gh" }, "forge_cli_missing"],
      [{ ok: false, reason: "not_authenticated", tool: "gh" }, "not_authenticated"],
      [{ ok: false, reason: "forge_timeout", tool: "gh" }, "forge_timeout"],
      [{ ok: false, reason: "forge_access", tool: "gh", detail: "HTTP 404" }, "forge_access"],
      [{ ok: false, reason: "forge_failed", tool: "gh", detail: "boom" }, "forge_failed"],
      [{ ok: true, checks: [], commit: HEAD }, "no_checks"],
      [{ ok: true, checks: checks(["test", "pass"]) }, "head_mismatch"],
    ];
    for (const [reading, reason] of cases) {
      reader.readings = [reading];
      expect(errorOf(await cli("1-1")), reason).toMatchObject({
        code: ErrorCode.CI_UNAVAILABLE,
        details: { reason, story: "1-1" },
      });
    }
    reader.repo = { forge: null, prefix: "", main: "main", ci: [] };
    expect(errorOf(await cli("1-1"))).toMatchObject({ details: { reason: "no_forge" } });
    reader.repo = null;
    expect(errorOf(await cli("1-1"))).toMatchObject({ details: { reason: "no_repository" } });
    reader.repo = { forge: "github", prefix: "", main: "main", ci: [] };
    workspace.heads.clear();
    expect(errorOf(await cli("1-1"))).toMatchObject({ details: { reason: "no_branch" } });
    expect(await count()).toBe(started);
    expect(errorOf(await call("check_ci", { agent: "sam", story: "x" }))).toMatchObject({
      code: ErrorCode.INVALID_ARGUMENTS,
    });
    expect(errorOf(await call("check_ci", { agent: "ghost", story: "1-1" }))).toMatchObject({
      code: ErrorCode.AGENT_NOT_FOUND,
    });
    expect(errorOf(await cli("1-1", { forge: "gitea" }))).toMatchObject({
      code: ErrorCode.INVALID_ARGUMENTS,
    });
  });

  it("forces the forge with --forge, check_ci's forge, or method.yaml", async () => {
    const { reader, call, start, cli, files } = await product();
    await start("1-1");
    reader.repo = { forge: null, prefix: "", main: "main", ci: [] };
    reader.readings = [green()];
    expect(resultOf<CiCheckResult>(await cli("1-1", { forge: "gitlab" })).forge).toBe("gitlab");
    expect(
      resultOf<CiCheckResult>(
        await call("check_ci", { agent: "sam", story: "1-1", forge: "github" }),
      ).forge,
    ).toBe("github");
    const config = await files.readText(".agentplugged/method.yaml");
    files.seed(".agentplugged/method.yaml", `${config.trimEnd()}\nci:\n  forge: gitlab\n`);
    expect(resultOf<CiCheckResult>(await cli("1-1")).forge).toBe("gitlab");
    expect(reader.calls.map((entry) => entry.forge)).toEqual(["gitlab", "github", "gitlab"]);
  });

  it("refuses a done story, whose report the projection ignores", async () => {
    const { run, answer, call, journal, productId } = await product();
    await run("update_story", { agent: "sam", story: "1-2", status: "in_review" });
    const opened = await run("open_checkpoint", {
      agent: "sam",
      type: "story",
      risk: "low",
      title: "Story 1-2",
      summary: "Done.",
      story: "1-2",
    });
    expect((await answer(opened.checkpoint)).ok).toBe(true);
    expect(errorOf(await call("check_ci", { agent: "sam", story: "1-2" }))).toMatchObject({
      code: ErrorCode.CI_UNAVAILABLE,
      details: { reason: "done", story: "1-2" },
    });
    const ignored = [];
    for (const story of ["1-2", "1-9"]) {
      const [event] = await journal.appendAll([
        {
          type: CI_EVENT_TYPES.reported,
          actor: { kind: "system" },
          product: productId,
          story,
          provenance: "trusted",
          payload: {
            forge: "github",
            status: "fail",
            checks: 1,
            failed: ["test"],
            commit: HEAD,
            read_at: "2026-10-04T13:00:00.000Z",
          },
        },
      ]);
      ignored.push(event?.id);
    }
    const projected = await computeProjection((await journal.list()).events);
    for (const id of ignored) expect(projected.ignored).toContainEqual({ id, reason: "invalid" });
    const stories = projected.state.stories as Record<string, { ci?: unknown }>;
    expect(stories["1-2"]?.ci).toBeUndefined();
    expect(stories["1-9"]).toBeUndefined();
  });
});

describe("the creator's waiver", () => {
  it("lets a story without a readable CI go on, at the terminal only, for its head", async () => {
    const { run, start, next, waive, agent, human, journal, reader } = await product();
    // A CI exists, yet cannot be read (a self-hosted forge without its tool, for example).
    reader.repo = { forge: null, prefix: "", main: "main", ci: [".gitlab-ci.yml"] };
    await start("1-1");
    await run("update_story", { agent: "sam", story: "1-1", status: "in_review" });
    // Never an agent, never outside a terminal.
    expect(errorOf(await waive("1-1", "No CI here.", agent))).toMatchObject({
      code: ErrorCode.UNKNOWN_COMMAND,
    });
    expect(
      errorOf(await waive("1-1", "No CI here.", { ...human, interactive: false })),
    ).toMatchObject({ code: ErrorCode.REVIEW_NOT_INTERACTIVE });
    expect(errorOf(await waive("1-1", " "))).toMatchObject({
      code: ErrorCode.INVALID_ARGUMENTS,
    });
    expect(errorOf(await waive("1-9", "No CI here."))).toMatchObject({
      details: { reason: "not_started" },
    });
    const waived = resultOf<CiWaiveResult>(await waive("1-1", "Self-hosted forge, no CI yet."));
    expect(waived).toMatchObject({
      story: "1-1",
      waived: true,
      commit: HEAD,
      reason: "Self-hosted forge, no CI yet.",
      event: { type: CI_EVENT_TYPES.waived },
    });
    const event = (await journal.list()).events.find((e) => e.type === CI_EVENT_TYPES.waived);
    expect(event?.actor.kind).toBe("human");
    // Accepted for this commit: on to the review.
    expect(await next()).toMatchObject({ step: "review", agent: "quentin", story: "1-1" });
    const projected = (await computeProjection((await journal.list()).events)).state;
    expect(mergeGate(projected, "1-1", { head: HEAD }).ci).toBe("waived");
    expect(mergeGate(projected, "1-1", { head: NEWER }).ci).toBe("stale");
    expect(mergeReady(projected, "1-1", { reviewDone: () => true, head: HEAD })).toBe(true);
    // An agent cannot write it either: the journal takes it from the creator alone.
    await expect(
      journal.appendAll([
        {
          type: CI_EVENT_TYPES.waived,
          actor: { kind: "agent", agent: "sam" },
          product: (await journal.productId()) as string,
          story: "1-1",
          provenance: "trusted",
          payload: { reason: "Me.", commit: NEWER },
        },
      ]),
    ).rejects.toThrow();
  });
});

describe("merge gate", () => {
  it("holds a started story's merge checkpoint back from next, review and its approval", async () => {
    const { reader, call, run, start, next, registry, human, projection, answer } = await product();
    await start("1-1");
    await run("update_story", { agent: "sam", story: "1-1", status: "in_review" });
    reader.readings = [green()];
    await call("check_ci", { agent: "sam", story: "1-1" });
    const opened = await run("open_checkpoint", {
      agent: "sam",
      type: "story",
      risk: "low",
      title: "Story 1-1",
      summary: "Done.",
      story: "1-1",
    });
    // A story checkpoint of a story never started is shown as before.
    const other = await run("open_checkpoint", {
      agent: "sam",
      type: "story",
      risk: "low",
      title: "Story 1-2",
      summary: "Done.",
      story: "1-2",
    });
    const step = await next();
    expect(step.waiting.map((entry) => entry.id)).toContain(other.checkpoint);
    expect(step.waiting.map((entry) => entry.id)).not.toContain(opened.checkpoint);
    const listed = await registry.run("review", human, { action: "list" });
    const ids = resultOf<{ checkpoints: Array<{ id: string }> }>(listed).checkpoints.map(
      (checkpoint) => checkpoint.id,
    );
    expect(ids).toContain(other.checkpoint);
    expect(ids).not.toContain(opened.checkpoint);
    const notReady = {
      code: ErrorCode.MERGE_NOT_READY,
      details: { checkpoint: opened.checkpoint, story: "1-1", ci: "pass", review: false },
    };
    expect(
      errorOf(
        await registry.run("review", human, { action: "list", checkpoint: opened.checkpoint }),
      ),
    ).toMatchObject(notReady);
    // Never approved directly; refused, it no longer waits.
    expect(errorOf(await answer(opened.checkpoint))).toMatchObject(notReady);
    const state = await projection();
    expect(mergeGate(state, "1-1")).toEqual({
      ready: false,
      ci: "pass",
      review: false,
      deviations: 0,
      untriaged: 0,
      skipped: [],
    });
    expect(mergeReady(state, "1-1", { reviewDone: () => true })).toBe(true);
    const held = (state.checkpoints as Record<string, CheckpointState>)[
      opened.checkpoint as string
    ] as CheckpointState;
    expect(heldMergeCheckpoint(state, held)).toBe(true);
    expect(heldMergeCheckpoint(state, { ...held, status: "resolved" })).toBe(false);
    expect(heldMergeCheckpoint(state, { ...held, type: "decision" })).toBe(false);
    expect(
      resolutionProblem(
        { ...held, merge: { story: "1-1", ci: "pass", review: false } },
        { decision: "approved" },
        Date.UTC(2026, 9, 5),
      ),
    ).toMatchObject(notReady);
    expect(
      resolutionProblem(
        { ...held, merge: { story: "1-1", ci: "pass", review: false } },
        { decision: "changes_requested", note: "Not yet." },
        Date.UTC(2026, 9, 5),
      ),
    ).toBeUndefined();
    const refused = await answer(opened.checkpoint, "changes_requested");
    expect(errorOf(refused)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
  });

  it("keeps a held merge checkpoint that blocks in waiting, never as the step", async () => {
    const { reader, call, run, start, next } = await product();
    await start("1-1");
    reader.readings = [green()];
    await call("check_ci", { agent: "sam", story: "1-1" });
    const opened = await run("open_checkpoint", {
      agent: "sam",
      type: "story",
      risk: "low",
      title: "Story 1-1",
      summary: "Done.",
      story: "1-1",
      blocks: [{ action: "story.complete" }],
    });
    const step = await next();
    expect(step.step).not.toBe("validation");
    expect(step.checkpoint).not.toBe(opened.checkpoint);
    expect(step.waiting.map((entry) => entry.id)).toContain(opened.checkpoint);
  });

  it("tells a stale, failed, waived or unknown CI apart", () => {
    const base = {
      status: "in_review" as const,
      status_by: { agent: "sam", at: "2026-10-04T12:00:00.000Z" },
      progress: null,
      results: {},
      waiting_on: [],
    };
    const ci = (status: "pass" | "fail" | "waived", at: string) => ({
      status,
      checks: 1,
      failed: status === "fail" ? ["test"] : [],
      commit: HEAD,
      at,
      event: "E",
      by: "sam",
    });
    expect(storyCiStatus(undefined)).toBe("unknown");
    expect(storyCiStatus(base)).toBe("unknown");
    expect(storyCiStatus({ ...base, ci: ci("pass", "2026-10-04T11:00:00.000Z") })).toBe("stale");
    expect(storyCiStatus({ ...base, ci: ci("pass", "2026-10-04T12:00:00.000Z") })).toBe("pass");
    expect(storyCiStatus({ ...base, ci: ci("waived", "2026-10-04T13:00:00.000Z") })).toBe("waived");
    expect(storyCiStatus({ ...base, ci: ci("pass", "2026-10-04T13:00:00.000Z") }, NEWER)).toBe(
      "stale",
    );
    // In progress again after a failure: the failure stands.
    expect(
      storyCiStatus({
        ...base,
        status: "in_progress",
        ci: ci("fail", "2026-10-04T11:00:00.000Z"),
      }),
    ).toBe("fail");
  });

  it("builds a payload that holds: each failed name once, cut cleanly, a marker past 50", () => {
    const payload = ciPayload(
      "gitlab",
      checks(["test", "fail"], ["test", "fail"], ["li\u0007nt", "fail"], ["build", "pending"]),
      { pr: 0, url: "http://example.com", commit: HEAD, read_at: "2026-10-04T12:00:00.000Z" },
    );
    expect(payload).toEqual({
      forge: "gitlab",
      status: "fail",
      checks: 4,
      failed: ["test", "lint"],
      commit: HEAD,
      read_at: "2026-10-04T12:00:00.000Z",
    });
    const many = ciPayload(
      "github",
      Array.from(
        { length: 60 },
        (_, index): CiCheck => ({ name: `check ${index}`, state: "fail" }),
      ),
      { commit: HEAD, read_at: "2026-10-04T12:00:00.000Z" },
    );
    expect(many.failed).toHaveLength(50);
    expect(many.failed.at(-1)).toBe("… (+11 more)");
    // 199 letters then an emoji: cut before it, never half of it.
    const cut = checkName(`${"a".repeat(199)}😀z`);
    expect(cut).toBe("a".repeat(199));
    expect(checkName(`${"a".repeat(198)}😀z`)).toBe(`${"a".repeat(198)}😀`);
  });
});

describe("ci setup", () => {
  it("writes the GitHub workflow of a pnpm product, once", async () => {
    const { files, setup } = await product();
    files.seed(
      "package.json",
      `﻿${JSON.stringify({
        packageManager: "pnpm@9.15.0",
        scripts: { lint: "biome check .", typecheck: "tsc", test: "vitest run" },
      })}`,
    );
    files.seed("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    files.seed(".nvmrc", "24\n");
    const result = resultOf<CiSetupResult>(await setup());
    expect(result).toMatchObject({
      status: "created",
      forge: "github",
      path: ".github/workflows/ci.yml",
      stack: "pnpm",
      existing: [],
    });
    expect(result.todo).toEqual([
      'build: add a "build" script to package.json, or replace this step',
    ]);
    const text = await files.readText(".github/workflows/ci.yml");
    expect(text).toContain("branches: [main]");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's own expression, kept as is.
    expect(text).toContain("group: ci-${{ github.ref }}");
    expect(text).toContain(
      "      - run: 'npm install --global corepack@latest && corepack enable'",
    );
    expect(text).toContain("          node-version-file: .nvmrc");
    expect(text).toContain("          cache: pnpm");
    expect(text).toContain("      - run: 'pnpm install --frozen-lockfile'");
    expect(text).toContain("      - run: 'pnpm run lint'\n      - run: 'pnpm run typecheck'");
    expect(text).toContain("      - run: 'pnpm audit --audit-level high'");
    expect(text).toContain(
      `      # TODO build: add a "build" script to package.json, or replace this step\n      - run: 'echo "TODO build: add a \\"build\\" script to package.json, or replace this step" && exit 1'`,
    );
    expect(text).toContain("# Stack: Node.js with pnpm, from package.json.");
    expect(text).not.toMatch(/\{\{[a-z_]+\}\}/);
    // Deterministic, and never written over.
    expect(resultOf<CiSetupResult>(await setup())).toEqual({
      status: "exists",
      existing: [".github/workflows/ci.yml"],
      todo: [],
    });
  });

  it("follows npm and yarn, never guesses another manager, and uses .nvmrc on GitLab", async () => {
    const npm = new MemoryFiles({
      "package.json": JSON.stringify({ scripts: { lint: "x", test: "y", build: "z" } }),
      "package-lock.json": "{}",
      ".node-version": "v22.11.0\n",
    });
    const plan = await ciPlan(npm);
    expect(plan).toMatchObject({ stack: "npm", locked: true, install: ["npm ci"] });
    // A lock file alone: pin the manager.
    expect(plan.notes[0]).toContain('"packageManager": "npm@<version>"');
    const rendered = renderCiTemplate(GITLAB_TEMPLATE, "gitlab", plan, "trunk");
    expect(rendered).toContain("image: node:22.11.0");
    expect(rendered).toContain("    - 'npm ci'");
    expect(rendered).toContain("    - 'npm audit --audit-level=high'");
    expect(rendered).toContain("# TODO setup: pin the package manager");
    const yarn = await ciPlan(
      new MemoryFiles({ "package.json": '{"packageManager":"yarn@4.5.0"}' }),
    );
    expect(yarn).toMatchObject({ stack: "yarn", locked: false });
    expect(yarn.install).toContain("yarn install");
    expect(yarn.notes.join("\n")).toContain("commit the lock file (yarn.lock)");
    expect(
      (await ciPlan(new MemoryFiles({ "package.json": '{"packageManager":"yarn@1.22.0"}' }))).stack,
    ).toBe("yarn-classic");
    for (const files of [
      new MemoryFiles({ "package.json": '{"packageManager":"bun@1.1.0"}' }),
      new MemoryFiles({ "package.json": "{}", "bun.lockb": "" }),
      new MemoryFiles({ "go.mod": "module shop\n" }),
    ]) {
      const other = await ciPlan(files);
      expect(other.stack).toBe("other");
      const text = renderCiTemplate(GITLAB_TEMPLATE, "gitlab", other, "main");
      expect(text).toContain("image: alpine:latest");
      expect(text).toContain("    # TODO test: run the tests");
      expect(text.match(/exit 1/g)).toHaveLength(4);
    }
  });

  it("writes nothing over a CI of the repository, outside its top, or without a forge", async () => {
    const { files, setup, reader } = await product();
    reader.repo = { forge: null, prefix: "", main: null, ci: [] };
    expect(errorOf(await setup())).toMatchObject({
      code: ErrorCode.CI_UNAVAILABLE,
      details: { reason: "no_forge" },
    });
    const gitlab = resultOf<CiSetupResult>(await setup({ forge: "gitlab" }));
    expect(gitlab).toMatchObject({ status: "created", forge: "gitlab", path: ".gitlab-ci.yml" });
    expect(gitlab.todo[0]).toContain("setup: set up the toolchain of this stack");
    expect(resultOf<CiSetupResult>(await setup({ forge: "github" }))).toMatchObject({
      status: "exists",
      existing: [".gitlab-ci.yml"],
    });
    expect(await files.exists(".github/workflows/ci.yml")).toBe(false);
    expect(errorOf(await setup({ forge: "bitbucket" }))).toMatchObject({
      code: ErrorCode.INVALID_ARGUMENTS,
    });
    await files.remove(".gitlab-ci.yml");
    // The method in a folder of the repository: the repository's own CI counts.
    reader.repo = {
      forge: "github",
      prefix: "app/",
      main: "main",
      ci: [".github/workflows/x.yml"],
    };
    expect(resultOf<CiSetupResult>(await setup())).toMatchObject({
      status: "exists",
      existing: [".github/workflows/x.yml"],
    });
    reader.repo = { forge: "github", prefix: "app/", main: "main", ci: [] };
    expect(errorOf(await setup())).toMatchObject({ details: { reason: "not_repository_root" } });
  });

  it("counts only the workflows directly in .github/workflows", async () => {
    const files = new MemoryFiles({
      ".github/workflows/nested/x.yml": "",
      ".github/workflows/readme.md": "",
    });
    expect(await existingCi(files)).toEqual([]);
    files.seed(".github/workflows/ci.yaml", "");
    expect(await existingCi(files)).toEqual([".github/workflows/ci.yaml"]);
  });
});

describe("next and the CI", () => {
  const config: NextConfig = {
    domains: DOMAIN_IDS,
    phases: ["build"],
    tools: ["claude-code"],
    preferred: {},
    agents: { sam: "Sam", omar: "Omar", quentin: "Quentin" },
  };
  const sync = { manifest: true, missing: [], recorded: "a", current: "a" };
  const docs = { kinds: ["epic" as const], stories: ["1-1"] };
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  const started = {
    agent: "sam",
    branch: "feat/1-1-work",
    base: "c".repeat(40),
    base_ref: "main",
    worktree: "../shop.worktrees/1-1",
    device: "machine:AAAAAAAAAAAAAAAA",
    at: "2026-10-05T10:00:00.000Z",
    event: "E0",
  };
  const story = (status: string) => ({
    status,
    status_by: { agent: "sam", at: "2026-10-05T11:00:00.000Z" },
    progress: null,
    results: {},
    waiting_on: [],
    started,
  });

  it("calls Omar to set up the CI as soon as the build has none, stories under way or not", () => {
    const state = (stories: Record<string, unknown> = {}) => ({
      projection: { stories },
      now,
      sync,
    });
    const setup = { step: "setup_ci", agent: "omar", command: "npx agentplugged ci setup" };
    expect(nextStep(state(), { ...docs, ci: false }, config)).toMatchObject(setup);
    for (const status of ["in_progress", "in_review"]) {
      expect(
        nextStep(state({ "1-1": story(status) }), { ...docs, ci: false }, config),
        status,
      ).toMatchObject(setup);
    }
    expect(nextStep(state(), { ...docs, ci: true }, config)).toMatchObject({
      step: "build",
      agent: "sam",
      story: "1-1",
    });
    expect(nextStep(state(), docs, config).step).toBe("build");
  });

  it("never loops on ci_check without a CI: the cause, and the creator's way out", () => {
    const state = { projection: { stories: { "1-1": story("in_review") } }, now, sync };
    const stuck = {
      step: "ci_check",
      you: true,
      story: "1-1",
      command: null,
      ci: { cause: "no_ci", waive: true },
    };
    // Omar inactive, the delivery domain off, or `ci setup` impossible here (a folder of the
    // repository): never `setup_ci`, never a command that fails.
    for (const [name, docsOf, configOf] of [
      [
        "no Omar",
        { ...docs, ci: false },
        { ...config, agents: { sam: "Sam", quentin: "Quentin" } },
      ],
      [
        "no delivery",
        { ...docs, ci: false },
        { ...config, domains: DOMAIN_IDS.filter((id) => id !== "delivery") },
      ],
      ["below the top", { ...docs, ci: false, ci_setup: false }, config],
    ] as const) {
      expect(nextStep(state, docsOf, configOf), name).toMatchObject(stuck);
    }
  });

  it("calls Omar on the sprint's road too", () => {
    const sprint = {
      id: "S-SPRINT0001",
      goal: "Accounts",
      stories: [{ id: "1-1", owner: "sam", budget_usd: 2 }],
      capacity: { agents: ["sam"], humans: 0 },
      budget_usd: 2,
      budget_limit_usd: null,
      checkpoint: "G-SPRINT0001",
      planned_by: "izzy",
      at: "2026-10-05T09:00:00.000Z",
      event: "01JZ00000000000000SPRINT01",
    };
    const approved = {
      id: sprint.checkpoint,
      type: "document",
      risk: "medium",
      title: "Sprint",
      status: "resolved",
      story: null,
      documents: [],
      blocks: [],
      opened_by: "izzy",
      opened_event: "01JZ00000000000000SPRINT00",
      resolution: { decision: "approved", at: "2026-10-05T09:30:00Z", event: "E1" },
      blocks_lifted: true,
      phase: null,
    };
    const state = {
      projection: {
        sprints: { [sprint.id]: sprint },
        checkpoints: { [approved.id]: approved },
        stories: {},
      },
      now,
      sync,
    };
    const withSam = { ...config, agents: { ...config.agents, izzy: "Izzy" } };
    expect(nextStep(state, { ...docs, ci: false }, withSam)).toMatchObject({
      step: "setup_ci",
      agent: "omar",
    });
    expect(nextStep(state, { ...docs, ci: true }, withSam)).toMatchObject({
      step: "build",
      story: "1-1",
      command: "npx agentplugged story start 1-1",
    });
  });

  it("reads the product's CI for next, and stops proposing setup_ci once there is one", async () => {
    const { files, next, reader } = await product();
    files.seed(".agentplugged/epics/epic-1.md", "---\nid: epic-1\nkind: epic\nowner: izzy\n---\n");
    files.seed(
      ".agentplugged/stories/1-1-sign-up.md",
      "---\nid: 1-1\nkind: story\nowner: sam\n---\n# Sign up\n",
    );
    expect(await next()).toMatchObject({ step: "setup_ci", agent: "omar" });
    // A CI at the repository's top, the method in a folder of it.
    reader.repo = { forge: "github", prefix: "app/", main: "main", ci: [".gitlab-ci.yml"] };
    expect((await next()).step).not.toBe("setup_ci");
    // Outside a repository, the workspace's own files are read.
    const { next: plain, files: own, reader: ownReader } = await product();
    ownReader.repo = null;
    own.seed(".agentplugged/epics/epic-1.md", "---\nid: epic-1\nkind: epic\nowner: izzy\n---\n");
    own.seed(".github/workflows/ci.yml", "on: push\n");
    expect((await plain()).step).not.toBe("setup_ci");
  });
});

describe("the essai of 6 October 2026", () => {
  const blocked = (story = "1-1") => ({
    agent: "sam",
    story,
    status: "blocked",
    summary: "Cannot start: the story was not validated yet.",
    assumptions: [],
    open_questions: ["When is it validated?"],
    conflicts: [],
  });
  const pointOf = async (
    projection: () => Promise<Record<string, unknown>>,
    id: string | undefined,
  ) => ((await projection()).checkpoints as Record<string, CheckpointState>)[id as string];

  it("closes the point of a blocked result by itself once the story started: no more deadlock between the review and the point", async () => {
    const { run, call, start, projection } = await product();
    // The real case: `start_story` was refused, the developer ended with a blocked result.
    const opened = await run("submit_result", blocked());
    expect((await pointOf(projection, opened.checkpoint))?.status).toBe("open");
    // The cause is lifted, the story starts.
    await start("1-1");
    const closed = await pointOf(projection, opened.checkpoint);
    expect(closed?.status).toBe("closed");
    expect(closed?.closed?.reason).toBe("block_lifted");
    expect(closed?.blocks_lifted).toBe(true);
    // The review is not blocked by it any more.
    const review = await call("update_story", { agent: "sam", story: "1-1", status: "in_review" });
    expect(review.ok).toBe(true);
    // Another story's point is left alone.
    const other = await run("submit_result", blocked("1-2"));
    await start("1-3");
    expect((await pointOf(projection, other.checkpoint))?.status).toBe("open");
  });

  it("is never a merge point: the creator closes it with a word, the story is not done by it", async () => {
    const { run, start, answer, projection, next } = await product();
    await start("1-1");
    // Blocked while the story is under way (a real question for the creator).
    const opened = await run("submit_result", blocked());
    const state = await projection();
    const point = (state.checkpoints as Record<string, CheckpointState>)[
      opened.checkpoint as string
    ] as CheckpointState;
    expect(point.source).toBe("blocked_result");
    expect(heldMergeCheckpoint(state, point)).toBe(false);
    // It waits for the creator like any point, instead of being held by the merge gate.
    expect((await next()).decisions?.map((entry) => entry.id)).toContain(opened.checkpoint);
    const answered = await answer(opened.checkpoint);
    expect(answered.ok).toBe(true);
    const after = await pointOf(projection, opened.checkpoint);
    expect(after?.status).toBe("resolved");
    // The approval of a block does not end the story: only its merge does.
    const stories = (await projection()).stories as Record<string, { merged?: unknown }>;
    expect(stories["1-1"]?.merged).toBeUndefined();
  });

  it("never opens a story point on a story nobody started: a document, or a bare story point that ends nothing", async () => {
    const { run, answer, start, projection, journal } = await product();
    const base = {
      agent: "sam",
      type: "story",
      risk: "medium",
      title: "Validate story 2-4",
      summary: "The story file.",
      story: "2-4",
      blocks: [],
    };
    // Without its file it stays a story point, which never ends a story nobody worked on.
    const bare = await run("open_checkpoint", { ...base, documents: [] });
    expect((await pointOf(projection, bare.checkpoint))?.type).toBe("story");
    // Citing its file, it is opened as the document it should be.
    const opened = await run("open_checkpoint", {
      ...base,
      documents: [
        { path: ".agentplugged/stories/2-4.md", branch: "main", blob_sha: "a".repeat(40) },
      ],
    });
    const point = await pointOf(projection, opened.checkpoint);
    expect(point?.type).toBe("document");
    await answer(opened.checkpoint);
    // The story is not lost: nothing marks it done, it can still start.
    const events = (await journal.list()).events.length;
    await start("2-4");
    expect((await journal.list()).events.length).toBeGreaterThan(events);
    const view = await projection();
    expect((view.stories as Record<string, { started?: unknown }>)["2-4"]?.started).toBeDefined();
    expect((await computeProjection((await journal.list()).events)).ignored).toEqual([]);
  });

  it("closes the permission points of a working copy that is gone, with their reason, and next no longer shows them", async () => {
    const { run, start, next, projection } = await product();
    await start("1-1");
    const asked = await run("open_checkpoint", {
      agent: "sam",
      type: "permission",
      risk: "high",
      title: "Install a dependency: npm ci",
      summary: "Sam asks to install.",
      story: "1-1",
      blocks: [],
    });
    // The fake repository says the story's working copy is nowhere: it is gone.
    const step = await next();
    expect(step.waiting.map((entry) => entry.id)).not.toContain(asked.checkpoint);
    expect(step.decisions?.map((entry) => entry.id)).not.toContain(asked.checkpoint);
    const closed = await pointOf(projection, asked.checkpoint);
    expect(closed?.status).toBe("closed");
    expect(closed?.closed?.reason).toBe("worktree_gone");
  });
});
