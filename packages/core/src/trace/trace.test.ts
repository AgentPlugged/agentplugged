import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode, type PhaseId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentStateView,
  type CandidateLine,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  createUlidFactory,
  initCommand,
  isTestPath,
  MemoryKeyStore,
  MemoryStateStore,
  mergeGate,
  type RecordedEvent,
  requirementStatus,
  requirementsInLine,
  resolveProfile,
  syncCommand,
  type TestReferenceRead,
  type TestReferenceSource,
  type ToolProbe,
  type TraceDetail,
  type TraceOverview,
  type TraceResolved,
  testReferences,
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

const SEED = toBase64url(new Uint8Array(32).fill(8));

function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

const PRD = [
  "---",
  "id: prd",
  "kind: prd",
  "owner: creator",
  "---",
  "# PRD",
  "",
  "- EF-1: The visitor signs in with an email and a password.",
  "- EF-2: (retired) The visitor signs in with a magic link.",
  "- EF-3: The visitor resets the password.",
  "- ENF-1: A page answers in less than 300 ms.",
  "- PU-1: A journey, never traced.",
  "",
].join("\n");

function storyFile(id: string, requirements: readonly string[]): string {
  return [
    "---",
    `id: ${id}`,
    `title: Story ${id}`,
    "kind: story",
    "owner: builder",
    `requirements: [${requirements.join(", ")}]`,
    "---",
    `# Story ${id}`,
    "",
  ].join("\n");
}

/** A fake test source: the candidate lines as Git would give them. */
class FakeTests implements TestReferenceSource {
  lines: CandidateLine[] = [];
  files: string[] = [];
  available = true;
  truncated = false;
  async read(): Promise<TestReferenceRead> {
    if (!this.available) return { found: false, reason: "unavailable" };
    return { found: true, lines: this.lines, files: this.files, truncated: this.truncated };
  }
}

const HEAD = "a".repeat(40);

/** A product in the build phase, stories 1-1, 1-2, 1-3. */
async function product() {
  const files = new MemoryFiles();
  let clock = Date.UTC(2026, 9, 6, 9, 0, 0);
  const now = () => {
    clock += 1000;
    return clock;
  };
  const collide: { next?: string } = {};
  const ulid = createUlidFactory({ now });
  const newId = (after?: string, at?: number) => {
    const id = ulid(after, at);
    const target = collide.next;
    if (target === undefined) return id;
    collide.next = undefined;
    return `${id.slice(0, 16)}${target}`;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now, newId });
  const tests = new FakeTests();
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("builder", "Builder", "code", "build"),
      ...shippedAgent("checker", "Checker", "quality", "build"),
    }),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
    testReferences: tests,
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const reader: CommandContext = { ...human, human: undefined, interactive: false };
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
  files.seed(".agentplugged/docs/prd.md", PRD);
  files.seed(".agentplugged/stories/1-1-sign-in.md", storyFile("1-1", ["EF-1", "ENF-1"]));
  files.seed(".agentplugged/stories/1-2-sign-in-errors.md", storyFile("1-2", ["EF-1"]));
  files.seed(".agentplugged/stories/1-3-reset.md", storyFile("1-3", ["EF-3"]));
  const productId = (await journal.productId()) as string;
  /** The engine records a story's start. */
  const start = async (story: string) => {
    await journal.appendAll([
      {
        type: "story.started",
        actor: { kind: "system" },
        product: productId,
        story,
        provenance: "trusted",
        payload: {
          agent: "builder",
          branch: `feat/${story}-work`,
          base: "c".repeat(40),
          base_ref: "main",
          worktree: `../shop.worktrees/${story}`,
        },
      },
    ]);
  };
  /** The engine records a story's pull request. */
  const pullRequest = async (story: string, number: number) => {
    await journal.appendAll([
      {
        type: "story.pr_opened",
        actor: { kind: "system" },
        product: productId,
        story,
        provenance: "trusted",
        payload: {
          forge: "github",
          number,
          url: `https://github.com/acme/shop/pull/${number}`,
          action: "opened",
          branch: `feat/${story}-work`,
          base: "main",
          head: HEAD,
          criteria: [true],
          tests: "passed",
          body_sha256: "e".repeat(64),
        },
      },
    ]);
  };
  const trace = async (input: Record<string, unknown> = {}) => {
    const result = await registry.run("trace", reader, { action: "overview", ...input });
    if (!result.ok) throw new Error(`trace failed: ${result.error.code}`);
    return result.value;
  };
  const overview = async () => (await trace()) as TraceOverview;
  const detail = async (requirement: string) =>
    ((await trace({ action: "requirement", requirement })) as TraceDetail).requirement;
  const state = async () => {
    const result = await call("get_state", { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  const projected = async () => (await computeProjection((await journal.list()).events)).state;
  const creator = (input: Record<string, unknown>, context: CommandContext = human) =>
    registry.run("trace", context, input);
  return {
    files,
    journal,
    keys,
    tests,
    human,
    agent,
    reader,
    registry,
    call,
    run,
    answer,
    start,
    pullRequest,
    trace,
    overview,
    detail,
    state,
    projected,
    creator,
    collide,
    productId,
  };
}

const errorOf = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? undefined : result.error;

const DEVIATION = {
  agent: "checker",
  story: "1-1",
  requirements: ["EF-1"],
  summary: "A wrong password does not lock the account after five attempts",
  detail: "EF-1 asks for a lockout; src/sign-in.ts:42 never counts the attempts.",
  commit: HEAD,
};

describe("tests that cite a requirement", () => {
  it("knows a test file by its folder or its name, in any language", () => {
    for (const path of [
      "tests/login.py",
      "test/sign_in.rb",
      "spec/models/user_spec.rb",
      "src/__tests__/a.ts",
      "src/sign-in.test.ts",
      "src/sign-in.spec.js",
      "pkg/login_test.go",
      "test_login.py",
      "t/login.t",
      "src/test/java/LoginTest.java",
      "LoginTests.cs",
      "LoginSpec.scala",
      "TestLogin.java",
      "app/Tests/Feature/LoginTest.php",
      "check-test.c",
      "src/Shop.Tests/CartFacts.cs",
      "cypress/e2e/login.ts",
      "src/login.cy.ts",
      "src/login.e2e.ts",
      "T/login.T",
    ]) {
      expect(isTestPath(path), path).toBe(true);
    }
    for (const path of [
      "src/sign-in.ts",
      "latest.md",
      "contest/main.c",
      "docs/testing.md",
      ".agentplugged/stories/test/1-1.md",
      "lib/Attestation.pm",
      "docs/test-plan.md",
      "specs/auth.md",
      "tests/fixtures/users.json",
      ".github/workflows/test.yml",
      "spec-4-8-traceability.md",
      ".AgentPlugged/tests/a_test.py",
    ]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });

  it("reads a bounded id, with a dash or an underscore, in any case", () => {
    expect(requirementsInLine("def test_EF_1_signs_in(): # ENF-2")).toEqual(["EF-1", "ENF-2"]);
    expect(requirementsInLine("void test_ef_12_reset(void) /* EF-12 */")).toEqual(["EF-12"]);
    expect(requirementsInLine("sub test_EF_3 { ok(1) }")).toEqual(["EF-3"]);
    expect(requirementsInLine("it('EF-4: rejects', () => {})")).toEqual(["EF-4"]);
    // Not an id: inside a word, a leading zero, a number that goes on, no separator.
    for (const line of ["DEF_1", "REF-2", "EF-0", "EF-05", "EF18", "xEF-1", "EF-"]) {
      expect(requirementsInLine(line), line).toEqual([]);
    }
    expect(requirementsInLine("EF-10 and EF-1")).toEqual(["EF-10", "EF-1"]);
    // A glued `test` prefix (Go, JUnit 3): `TestEF_18`, `testEF_18`; never `latestEF_1`.
    expect(requirementsInLine("func TestEF_18(t *testing.T) {")).toEqual(["EF-18"]);
    expect(requirementsInLine("public void testEF_2() {")).toEqual(["EF-2"]);
    expect(requirementsInLine("latestEF_1 contestEF_2")).toEqual([]);
    // `EF_1_2` cites EF-1 only: `EF_1_EF_2` cites both.
    expect(requirementsInLine("test_EF_1_2")).toEqual(["EF-1"]);
    expect(requirementsInLine("test_EF_1_EF_2")).toEqual(["EF-1", "EF-2"]);
  });

  it("keeps the test files only, sorted by path and line", () => {
    expect(
      testReferences(
        [
          { path: "tests/b_test.py", line: 9, text: "# EF-1" },
          { path: "src/a.ts", line: 1, text: "// EF-1" },
          { path: "tests/a_test.py", line: 3, text: "def test_EF_1(): # EF-1" },
          { path: "tests/a_test.py", line: 1, text: "ENF-1" },
        ],
        ["tests/EF-3_reset.py", "src/EF-4.ts"],
      ),
    ).toEqual([
      { requirement: "EF-3", path: "tests/EF-3_reset.py", line: 0 },
      { requirement: "ENF-1", path: "tests/a_test.py", line: 1 },
      { requirement: "EF-1", path: "tests/a_test.py", line: 3 },
      { requirement: "EF-1", path: "tests/b_test.py", line: 9 },
    ]);
  });
});

describe("the status of a requirement", () => {
  it("follows its stories, and a deviation first", () => {
    expect(requirementStatus([], 0)).toBe("todo");
    expect(requirementStatus(["todo", "todo"], 0)).toBe("todo");
    expect(requirementStatus(["in_progress", "todo"], 0)).toBe("in_development");
    expect(requirementStatus(["blocked"], 0)).toBe("in_development");
    expect(requirementStatus(["done", "todo"], 0)).toBe("in_development");
    expect(requirementStatus(["in_review", "done"], 0)).toBe("in_review");
    expect(requirementStatus(["in_review", "todo"], 0)).toBe("in_development");
    expect(requirementStatus(["done", "done"], 0)).toBe("delivered");
    expect(requirementStatus(["done"], 1)).toBe("deviation");
    expect(requirementStatus([], 1)).toBe("deviation");
  });
});

describe("trace and get_trace", () => {
  it("links each requirement to its stories, tests and pull requests", async () => {
    const { tests, start, pullRequest, run, overview, detail, call } = await product();
    tests.lines = [
      { path: "tests/login_test.py", line: 4, text: "def test_EF_1_signs_in():" },
      { path: "tests/login_test.py", line: 9, text: "    # ENF-1: under 300 ms" },
      { path: "src/sign-in.ts", line: 2, text: "// EF-1, not a test" },
      { path: "t/reset.t", line: 1, text: "ok(reset(), 'EF-3');" },
    ];
    const view = await overview();
    expect(view.requirements.map((requirement) => [requirement.id, requirement.status])).toEqual([
      ["EF-1", "todo"],
      ["EF-3", "todo"],
      ["ENF-1", "todo"],
    ]);
    expect(view.requirements[0]).toMatchObject({
      text: "The visitor signs in with an email and a password.",
      stories: ["1-1", "1-2"],
      tests: 1,
      pull_requests: 0,
      deviations: 0,
    });
    expect(view.counts).toEqual({
      todo: 3,
      in_development: 0,
      in_review: 0,
      delivered: 0,
      deviation: 0,
    });
    expect(view.tests).toEqual({ status: "read", references: 3 });

    await start("1-1");
    await pullRequest("1-1", 7);
    expect((await detail("EF-1")).status).toBe("in_development");
    await run("update_story", { agent: "builder", story: "1-1", status: "in_review" });
    // 1-2 not started yet: EF-1 is still being developed.
    expect((await detail("EF-1")).status).toBe("in_development");
    expect((await detail("ENF-1")).status).toBe("in_review");
    const one = await detail("EF-1");
    expect(one).toMatchObject({
      id: "EF-1",
      path: ".agentplugged/docs/prd.md",
      line: 8,
      retired: false,
      stories: [
        { id: "1-1", title: "Story 1-1", status: "in_review" },
        { id: "1-2", title: "Story 1-2", status: "todo" },
      ],
      tests: [{ path: "tests/login_test.py", line: 4 }],
      pull_requests: [
        { story: "1-1", forge: "github", number: 7, url: "https://github.com/acme/shop/pull/7" },
      ],
      deviations: [],
    });
    // The agents read the same through get_trace.
    const agentView = await call("get_trace", { requirement: "ef-1" });
    expect(agentView.ok && agentView.value).toMatchObject({ action: "requirement" });
    expect((await call("get_trace", {})).ok).toBe(true);
  });

  it("delivers a requirement once every story citing it is done", async () => {
    const { run, answer, detail } = await product();
    // 1-3 never started through the engine: its story checkpoint can be approved.
    await run("update_story", { agent: "builder", story: "1-3", status: "in_progress" });
    await run("update_story", { agent: "builder", story: "1-3", status: "in_review" });
    expect((await detail("EF-3")).status).toBe("in_review");
    const opened = await run("open_checkpoint", {
      agent: "builder",
      type: "story",
      story: "1-3",
      risk: "low",
      title: "Story 1-3",
      summary: "Ready.",
    });
    await answer(opened.checkpoint);
    expect((await detail("EF-3")).status).toBe("delivered");
    expect((await detail("EF-3")).stories[0]?.status).toBe("done");
  });

  it("shows a retired requirement on demand, never in the overview", async () => {
    const { detail, overview, registry, reader, call } = await product();
    expect((await overview()).requirements.map((requirement) => requirement.id)).not.toContain(
      "EF-2",
    );
    expect(await detail("EF-2")).toMatchObject({ retired: true, status: "todo", stories: [] });
    const unknown = await registry.run("trace", reader, {
      action: "requirement",
      requirement: "EF-99",
    });
    expect(errorOf(unknown)).toMatchObject({
      code: ErrorCode.REQUIREMENT_NOT_FOUND,
      details: { requirement: "EF-99" },
    });
    for (const requirement of ["PU-1", "AD-1", "x", "EF-0"]) {
      const wrong = await registry.run("trace", reader, { action: "requirement", requirement });
      expect(errorOf(wrong), requirement).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    }
    const typo = await call("get_trace", { requirement: "PU-1" });
    expect(errorOf(typo)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    const extra = await registry.run("trace", reader, { action: "overview", requirement: "EF-1" });
    expect(errorOf(extra)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
  });

  it("says when the tests cannot be read, and shows the rest", async () => {
    const { tests, overview, detail } = await product();
    tests.available = false;
    const view = await overview();
    expect(view.tests).toEqual({ status: "unavailable", references: 0 });
    expect(view.requirements).toHaveLength(3);
    expect(view.requirements[0]?.tests).toBeNull();
    expect((await detail("EF-1")).tests).toEqual([]);
    tests.available = true;
    tests.truncated = true;
    expect((await overview()).tests.status).toBe("truncated");
  });

  it("traces nothing without a PRD", async () => {
    const { files, overview } = await product();
    files.seed(
      ".agentplugged/docs/prd.md",
      "---\nid: prd\nkind: prd\nowner: creator\n---\n# PRD\n",
    );
    const view = await overview();
    expect(view.requirements).toEqual([]);
    expect(view.deviations).toEqual([]);
  });
});

describe("deviations", () => {
  it("records a deviation on the story, its pull request and the requirement", async () => {
    const { start, pullRequest, run, state, detail, overview, projected } = await product();
    await start("1-1");
    await pullRequest("1-1", 7);
    await run("update_story", { agent: "builder", story: "1-1", status: "in_review" });
    const reported = await run("report_deviation", {
      ...DEVIATION,
      story: "01-01",
      requirements: ["ef-1"],
    });
    expect(reported.type).toBe("deviation.reported");
    expect(reported.deviation).toBe(`V-${reported.id.slice(-10)}`);
    const view = await state();
    expect(view.deviations).toEqual({
      open: [
        {
          id: reported.deviation,
          story: "1-1",
          requirements: ["EF-1"],
          summary: DEVIATION.summary,
          detail: DEVIATION.detail,
          pr: 7,
          commit: HEAD,
          status: "open",
          reported_by: "checker",
          reported_at: reported.at,
          event: reported.id,
          resolved: null,
        },
      ],
      resolved: 0,
    });
    // The story goes back to its developer.
    expect(view.stories["1-1"]).toMatchObject({
      status: "in_progress",
      status_by: { agent: "builder" },
    });
    expect((await detail("EF-1")).status).toBe("deviation");
    // ENF-1 is not named by the deviation.
    expect((await detail("ENF-1")).status).toBe("in_development");
    const all = await overview();
    expect(all.counts.deviation).toBe(1);
    expect(all.deviations.map((deviation) => deviation.id)).toEqual([reported.deviation]);
    expect(all.requirements[0]).toMatchObject({ id: "EF-1", deviations: 1 });
    // The merge stays closed while it is open.
    expect(mergeGate(await projected(), "1-1", { reviewDone: () => true })).toMatchObject({
      ready: false,
      deviations: 1,
    });
  });

  it("refuses a deviation it cannot attach, and writes nothing", async () => {
    const { start, call, answer, run, journal } = await product();
    const before = (await journal.list()).events.length;
    for (const [input, reason] of [
      [{ story: "9-9" }, "unknown_story"],
      [{ requirements: ["EF-3"] }, "not_linked"],
      [{ requirements: ["EF-1", "AD-2"] }, "not_linked"],
      [{}, "not_started"],
    ] as const) {
      const refused = await call("report_deviation", { ...DEVIATION, ...input });
      expect(errorOf(refused), reason).toMatchObject({
        code: ErrorCode.DEVIATION_NOT_REPORTABLE,
        details: { reason },
      });
    }
    expect((await journal.list()).events.length).toBe(before);
    // A story done takes no deviation (here, approved without the engine's start).
    await run("update_story", { agent: "builder", story: "1-3", status: "in_progress" });
    const opened = await run("open_checkpoint", {
      agent: "builder",
      type: "story",
      story: "1-3",
      risk: "low",
      title: "Story 1-3",
      summary: "Ready.",
    });
    await answer(opened.checkpoint);
    await start("1-1");
    const inactive = await call("report_deviation", { ...DEVIATION, agent: "ghost" });
    expect(errorOf(inactive)).toMatchObject({ code: ErrorCode.AGENT_NOT_FOUND });
    const injected = await call("report_deviation", { ...DEVIATION, summary: "a\u001b[2Jb" });
    expect(errorOf(injected)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    const withPr = await call("report_deviation", { ...DEVIATION, pr: 3 });
    expect(errorOf(withPr)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
  });

  it("is lifted by the agent that reported it only", async () => {
    const { start, run, call, state, detail, projected } = await product();
    await start("1-1");
    const reported = await run("report_deviation", DEVIATION);
    const id = reported.deviation as string;
    const byBuilder = await call("lift_deviation", {
      agent: "builder",
      deviation: id,
      reason: "Fixed it myself.",
    });
    expect(errorOf(byBuilder)).toMatchObject({
      code: ErrorCode.DEVIATION_NOT_ALLOWED,
      details: { deviation: id, agent: "builder", reported_by: "checker" },
    });
    const unknown = await call("lift_deviation", {
      agent: "checker",
      deviation: "V-0000000000",
      reason: "x",
    });
    expect(errorOf(unknown)).toMatchObject({ code: ErrorCode.DEVIATION_NOT_FOUND });
    const lifted = await run("lift_deviation", {
      agent: "checker",
      deviation: id.toLowerCase(),
      reason: "Lockout after five attempts, tested in tests/login_test.py.",
    });
    expect(lifted.type).toBe("deviation.resolved");
    const view = await state();
    expect(view.deviations).toEqual({ open: [], resolved: 1 });
    expect((await detail("EF-1")).deviations[0]).toMatchObject({
      id,
      status: "resolved",
      resolved: { by: "checker", event: lifted.id },
    });
    expect((await detail("EF-1")).status).toBe("in_development");
    expect(mergeGate(await projected(), "1-1").deviations).toBe(0);
    const twice = await call("lift_deviation", { agent: "checker", deviation: id, reason: "x" });
    expect(errorOf(twice)).toMatchObject({
      code: ErrorCode.DEVIATION_NOT_OPEN,
      details: { deviation: id, status: "resolved" },
    });
  });

  it("never lets the story's developer report a deviation on it: only the creator could lift it", async () => {
    const { start, call, journal } = await product();
    await start("1-1");
    const before = (await journal.list()).events.length;
    const own = await call("report_deviation", { ...DEVIATION, agent: "builder" });
    expect(errorOf(own)).toMatchObject({
      code: ErrorCode.DEVIATION_NOT_REPORTABLE,
      details: { story: "1-1", reason: "own_story" },
    });
    expect((await journal.list()).events.length).toBe(before);
  });

  it("keeps the status of a story in progress or blocked, and refuses a story done", async () => {
    const { start, run, call, state, answer } = await product();
    await start("1-1");
    await run("update_story", { agent: "builder", story: "1-1", status: "blocked" });
    await run("report_deviation", DEVIATION);
    expect((await state()).stories["1-1"]?.status).toBe("blocked");
    // 1-3 done: its story checkpoint approved.
    await run("update_story", { agent: "builder", story: "1-3", status: "in_progress" });
    const opened = await run("open_checkpoint", {
      agent: "builder",
      type: "story",
      story: "1-3",
      risk: "low",
      title: "Story 1-3",
      summary: "Ready.",
    });
    await answer(opened.checkpoint);
    const done = await call("report_deviation", {
      ...DEVIATION,
      story: "1-3",
      requirements: ["EF-3"],
    });
    expect(errorOf(done)).toMatchObject({
      code: ErrorCode.DEVIATION_NOT_REPORTABLE,
      details: { reason: "done" },
    });
  });

  it("holds the merge checkpoint of a story with an open deviation", async () => {
    const { start, run, registry, human } = await product();
    await start("1-1");
    await run("report_deviation", DEVIATION);
    const opened = await run("open_checkpoint", {
      agent: "builder",
      type: "story",
      story: "1-1",
      risk: "low",
      title: "Merge 1-1",
      summary: "Ready.",
    });
    const refused = await registry.run("review", human, {
      action: "resolve",
      checkpoint: opened.checkpoint,
      decision: "approved",
    });
    expect(errorOf(refused)).toMatchObject({
      code: ErrorCode.MERGE_NOT_READY,
      details: { story: "1-1", deviations: 1 },
    });
  });

  it("writes again with a fresh id when its id is taken", async () => {
    const { start, run, collide, state } = await product();
    await start("1-1");
    const first = await run("report_deviation", DEVIATION);
    collide.next = (first.deviation as string).slice(2);
    const second = await run("report_deviation", { ...DEVIATION, summary: "Another gap" });
    expect(second.deviation).not.toBe(first.deviation);
    expect((await state()).deviations.open.map((deviation) => deviation.summary)).toEqual([
      DEVIATION.summary,
      "Another gap",
    ]);
  });

  it("lets the creator lift a deviation at the terminal, signed by their key", async () => {
    const { start, run, creator, human, reader, state } = await product();
    await start("1-1");
    const reported = await run("report_deviation", DEVIATION);
    const id = reported.deviation as string;
    const away = await creator({ action: "resolve", deviation: id, reason: "ok" }, reader);
    expect(errorOf(away)).toMatchObject({ code: ErrorCode.REVIEW_NOT_INTERACTIVE });
    const badId = await creator({ action: "resolve", deviation: "V-1", reason: "ok" });
    expect(errorOf(badId)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    const noReason = await creator({ action: "resolve", deviation: id, reason: " " });
    expect(errorOf(noReason)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    const lifted = await creator({
      action: "resolve",
      deviation: id,
      reason: "Accepted: the lockout moves to story 1-2.",
    });
    expect(lifted.ok && (lifted.value as TraceResolved)).toMatchObject({
      action: "resolve",
      deviation: id,
      story: "1-1",
      summary: DEVIATION.summary,
    });
    expect((await state()).deviations).toEqual({ open: [], resolved: 1 });
    const again = await creator({ action: "resolve", deviation: id, reason: "x" }, human);
    expect(errorOf(again)).toMatchObject({ code: ErrorCode.DEVIATION_NOT_OPEN });
  });

  it("ignores a deviation the journal holds from another actor, or on a story not started", async () => {
    const { journal, productId, start, run, projected } = await product();
    const event = (story: string) => ({
      type: "deviation.reported",
      product: productId,
      story,
      provenance: "trusted" as const,
      payload: { requirements: ["EF-1"], summary: "x" },
    });
    const [system] = await journal.appendAll([{ ...event("1-1"), actor: { kind: "system" } }]);
    const [early] = await journal.appendAll([
      { ...event("1-2"), actor: { kind: "agent", agent: "checker" } },
    ]);
    await start("1-1");
    const reported = await run("report_deviation", DEVIATION);
    const [stranger] = await journal.appendAll([
      {
        type: "deviation.resolved",
        actor: { kind: "agent", agent: "builder" },
        product: productId,
        provenance: "trusted",
        payload: { deviation: reported.deviation, reason: "mine now" },
      },
    ]);
    const projection = await computeProjection((await journal.list()).events);
    const ignored = projection.ignored.map((entry) => entry.id);
    expect(ignored).toEqual(
      expect.arrayContaining([system?.id, early?.id, stranger?.id].filter(Boolean)),
    );
    const deviations = (await projected()).deviations as Record<string, { status: string }>;
    expect(Object.values(deviations).map((deviation) => deviation.status)).toEqual(["open"]);
  });
});
