import { ErrorCode, TEST_CRITERIA, TEST_ROWS, type TestGrid } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CreatorActionRequested,
  computeProjection,
  type ProofRunner,
  type ProofRunRequest,
  type ProofRunResult,
  type StoryWorkspace,
  type StoryWorkspaceInspection,
  type StoryWorkspaceTarget,
  type WorkingCopy,
} from "../index.js";
import { RESPONSE_FORMS } from "../mcp-responses.js";
import { PROOFS_PATH } from "../proofs/proof-declaration.js";
import { FakeLab, failed, passed, type Tests } from "../testing/mutation-lab.js";
import { product } from "../testing/requirements-product.js";
import type { TestsView } from "./review-tests-command.js";

/**
 * `review_tests`, end to end: the graded review refused then accepted, the mutation
 * check run by the engine with the command the creator accepted (a break no test noticed is a
 * finding), the bounds, the creator's folder untouched, the holes tied to the criteria and the
 * requirements, and each hole recorded as work to decide, one gesture each.
 */

const COMMIT = "c".repeat(40);
const WORKTREE = "../shop.worktrees/1-3";

const STORY = [
  "---",
  "id: 1-3",
  "kind: story",
  "owner: sam",
  "title: Cart",
  "epic: epic-1",
  "reviewer: quentin",
  "requirements: [EF-1]",
  "budget_usd: 2",
  "branch: feat/1-3-cart",
  "depends_on: []",
  "---",
  "# Story 1-3",
  "",
  "## Context",
  "",
  "A gate.",
  "",
  "## Intent",
  "",
  "Ada enters at 18.",
  "",
  "## Acceptance criteria",
  "",
  "- Given Ada is 18, when she enters, then the door opens.",
  "- Given Ada is 17, when she enters, then the door stays closed.",
  "- Given three wrong tries, when she enters, then the door locks.",
  "",
  "## Out of scope",
  "",
  "Nothing else.",
  "",
].join("\n");

const DECLARED = [
  "commands:",
  "  - name: criteria",
  "    run: npx vitest run -t {criterion}",
  "    timeout: 120",
  "  - name: all",
  "    run: npx vitest run",
  "    timeout: 200",
  "    proves: [ENF-2]",
  "",
].join("\n");

const SOURCE = [
  "export function entry(age: number, tries: number): string {",
  "  if (age >= 18) {",
  "    return tries == 3 ? 'locked' : 'open';",
  "  }",
  "  return 'closed';",
  "}",
].join("\n");

/** The diff of a story that adds the whole file. */
const DIFF = [
  "diff --git a/src/entry.ts b/src/entry.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/entry.ts",
  `@@ -0,0 +1,${SOURCE.split("\n").length} @@`,
  ...SOURCE.split("\n").map((line) => `+${line}`),
  "",
].join("\n");

class FakeWorkspace implements StoryWorkspace {
  async inspect(target: StoryWorkspaceTarget): Promise<StoryWorkspaceInspection> {
    return {
      repository: true,
      prefix: "",
      main: { ref: "main", commit: COMMIT },
      storyBlob: null,
      branch: { commit: "d".repeat(40), merged: false, storyBlob: null },
      checkedOut: null,
      target: { path: `/repos/shop.worktrees/${target.id}`, relative: "", exists: true },
    };
  }
  create = () => Promise.reject(new Error("unused"));
  discard = async () => true;
  readBlob = async () => undefined;
  storyFilesOn = async () => undefined;
  installCommitHook = async () => ({ status: "installed" as const, path: "/hook" });
}

/** The runner of the engine: only asked for the commit of the working copy here. */
class FakeRunner implements ProofRunner {
  readonly requests: ProofRunRequest[] = [];
  copy: WorkingCopy = { commit: "d".repeat(40), clean: true };
  async workingCopy(): Promise<WorkingCopy> {
    return this.copy;
  }
  async run(request: ProofRunRequest): Promise<ProofRunResult> {
    this.requests.push(request);
    return passed();
  }
}

/** The tests pin the comparison, the branches and `locked`, but not the number 18. */
const pinning: Tests = (files) => {
  const text = files.get("src/entry.ts") ?? "";
  return text.includes("age >= ") &&
    !text.includes("!(") &&
    text.includes("tries == 3") &&
    text.includes("'closed'") &&
    text.includes("'locked'")
    ? passed()
    : failed("FAIL AC-1-3-2 keeps the door closed");
};

async function declared(tests: Tests = pinning, options: { declare?: boolean } = {}) {
  const lab = new FakeLab(new Map([["src/entry.ts", SOURCE]]), tests, { advance() {} }, 500);
  const runner = new FakeRunner();
  const world = await product({
    proofRunner: runner,
    context: {
      storyWorkspace: new FakeWorkspace(),
      storyDiff: { diff: async () => DIFF },
      mutationLab: lab,
    },
  });
  world.files.seed(".agentplugged/stories/1-3-cart.md", STORY);
  if (options.declare !== false) world.files.seed(PROOFS_PATH, DECLARED);
  const productId = world.journal.events[0]?.product as string;
  await world.journal.appendAll([
    {
      type: "story.started",
      actor: { kind: "agent", agent: "sam" },
      product: productId,
      provenance: "trusted",
      story: "1-3",
      payload: {
        agent: "sam",
        branch: "feat/1-3-cart",
        base: COMMIT,
        base_ref: "main",
        worktree: WORKTREE,
      },
    },
  ]);
  const accept = async () => {
    const raised = (await world.run("request_creator_action", {
      agent: "quentin",
      action: { kind: "proof_commands" },
      reason: "the creator wants the tests run by the engine",
    })) as unknown as CreatorActionRequested;
    await world.approve(raised.checkpoint);
  };
  /** The three parts of a review go under `check`, as the tool takes them. */
  const asked = (input: Record<string, unknown>) => {
    const { grid, mutation, propose, ...rest } = input;
    const check = Object.fromEntries(
      Object.entries({ grid, mutation, propose }).filter(([, value]) => value !== undefined),
    );
    return {
      agent: "quentin",
      story: "1-3",
      ...rest,
      ...(grid || mutation || propose ? { check } : {}),
    };
  };
  const review = async (input: Record<string, unknown> = {}) => {
    const result = await world.call("review_tests", asked(input));
    if (!result.ok) {
      throw new Error(`review_tests: ${result.error.code} ${result.error.details.reason}`);
    }
    return result.value as unknown as TestsView;
  };
  const refusal = async (input: Record<string, unknown> = {}) => {
    const result = await world.call("review_tests", asked(input));
    if (result.ok) throw new Error("expected a refusal");
    return result.error;
  };
  const cite = (...criteria: number[]) => {
    world.tests.lines = [
      ...criteria.map((n) => ({
        path: "src/entry.test.ts",
        line: 10 + n,
        text: `it('AC-1-3-${n} is covered', () => {`,
      })),
    ];
  };
  const events = (type: string) => world.journal.events.filter((event) => event.type === type);
  return { ...world, lab, runner, accept, review, refusal, cite, events };
}

const READS = ["src/entry.test.ts"];
const okGrid = (): TestGrid => ({
  reads: READS,
  criteria: TEST_CRITERIA.map((criterion) => ({ criterion, verdict: "ok" as const })),
  findings: [],
});
const withFinding = (row: string, test = "src/entry.test.ts:12 opens"): TestGrid => {
  const entry = TEST_ROWS.find((candidate) => candidate.id === row);
  if (entry === undefined) throw new Error(row);
  return {
    reads: READS,
    criteria: TEST_CRITERIA.map((criterion) => ({
      criterion,
      verdict: criterion === entry.criterion ? ("issues" as const) : ("ok" as const),
    })),
    findings: [
      {
        criterion: entry.criterion,
        row: entry.id as TestGrid["findings"][number]["row"],
        test,
        reason: "it passes whatever the gate does",
        fix: "assert the door state",
      },
    ],
  };
};

describe("the graded review is refused until it is whole", () => {
  it("refuses a grid that is not whole with what is missing, writes nothing, then accepts the fixed one", async () => {
    const world = await declared();
    const eventsBefore = world.journal.events.length;
    const bad: TestGrid = {
      reads: [],
      criteria: [{ criterion: "active", verdict: "ok" }],
      findings: [],
    };
    const refused = await world.refusal({ grid: bad });
    expect(refused.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    const reason = String(refused.details.reason);
    expect(reason).toContain("review_tests: grid: not whole");
    expect(reason).toContain("reads: list the test files you read");
    expect(reason).toContain("assertions is missing");
    expect(world.journal.events).toHaveLength(eventsBefore);
    const view = await world.review({ grid: okGrid() });
    expect(view.grid).toMatchObject({ score: 100, grade: "A", verdict: "sound", findings: 0 });
    expect(view.grid?.criteria).toContain("assertions 100");
    expect(world.events("tests.reviewed")).toHaveLength(1);
  });

  it("marks the grid itself: the reviewer gives rows, the engine gives the marks", async () => {
    const world = await declared();
    const view = await world.review({ grid: withFinding("tautology") });
    expect(view.grid).toMatchObject({ grade: "F", verdict: "blocked", findings: 1 });
    expect(view.grid?.score).toBeLessThanOrEqual(59);
    expect(view.grid?.criteria).toContain("assertions 80");
    expect(view.grid?.lines[0]).toContain("critical tautology src/entry.test.ts:12 opens");
    const payload = world.events("tests.reviewed")[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ story: "1-3", grade: "F", verdict: "blocked", findings: 1 });
    // A mark the reviewer wrote is not a field: the schema refuses it.
    const forged = await world.refusal({ grid: { ...okGrid(), score: 100 } });
    expect(forged.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });

  it("reviews the product when no story is named", async () => {
    const world = await declared();
    const result = await world.call("review_tests", {
      agent: "quentin",
      check: { grid: okGrid() },
    });
    expect(result.ok).toBe(true);
    expect((result.ok ? (result.value as unknown as TestsView) : undefined)?.scope).toBe("product");
    const asked = await world.call("review_tests", { agent: "quentin", check: { mutation: {} } });
    expect(asked.ok).toBe(false);
  });

  it("does not review a story that was not started", async () => {
    const world = await declared();
    const refused = await world.refusal({ story: "9-9" });
    expect(String(refused.details.reason)).toContain("not_started");
  });
});

describe("the engine breaks the code of the story and runs the accepted tests", () => {
  it("flags the break no test noticed, with file, line and break; the killed ones are only counted", async () => {
    const world = await declared();
    await world.accept();
    const view = await world.review({ mutation: {} });
    expect(view.mutation).toMatchObject({ status: "done" });
    expect(view.mutation?.ran).toBeGreaterThan(3);
    expect(view.mutation?.killed).toBeGreaterThan(0);
    expect(view.mutation?.survived).toBe(1);
    const survivors = view.gaps.filter((line) => line.startsWith("survives:"));
    expect(survivors).toEqual(["survives: src/entry.ts:2 number `18` -> `19`"]);
    // The line the creator accepted, with the story's marks written in, in the throwaway copy.
    const copy = world.lab.opened[0];
    expect(copy?.requests[0]).toMatchObject({
      line: "npx vitest run -t AC-1-3-",
      argv: ["npx", "vitest", "run", "-t", "AC-1-3-"],
      cwd: ".",
      timeoutMs: 120_000,
    });
    expect(copy?.closed).toBe(true);
    expect(world.runner.requests).toEqual([]);
    const payload = world.events("tests.reviewed")[0]?.payload as {
      mutation: Record<string, number>;
    };
    expect(payload.mutation).toMatchObject({ survived: 1 });
  });

  it("does not break a tree that is not at the head of the branch: the lines would be wrong", async () => {
    const world = await declared();
    await world.accept();
    world.runner.copy = { commit: "d".repeat(40), clean: false };
    const dirty = await world.review({ mutation: {} });
    expect(dirty.mutation).toMatchObject({ status: "refused", ran: 0 });
    expect(dirty.mutation?.reason).toContain("tree_not_at_the_branch_head");
    world.runner.copy = { commit: "e".repeat(40), clean: true };
    expect((await world.review({ mutation: {} })).mutation?.status).toBe("refused");
    expect(world.lab.openings).toBe(0);
    // A check that did not run leaves no "nothing survived" in the journal.
    const payloads = world
      .events("tests.reviewed")
      .map((event) => event.payload as Record<string, unknown>);
    expect(payloads.every((payload) => payload.mutation === undefined)).toBe(true);
  });

  it("keeps the marks of the grid when a later review is of the mutation check only", async () => {
    const world = await declared();
    await world.accept();
    await world.review({ grid: withFinding("tautology") });
    await world.review({ mutation: {} });
    const reviews = (
      (await computeProjection(world.journal.events)).state as Record<string, unknown>
    ).test_reviews as Record<string, Record<string, unknown>>;
    expect(reviews["1-3"]).toMatchObject({ grade: "F", verdict: "blocked", survived: 1 });
  });

  it("counts every break as killed when the tests pin the function", async () => {
    const world = await declared((files) =>
      files.get("src/entry.ts") === SOURCE ? passed() : failed(),
    );
    await world.accept();
    const view = await world.review({ mutation: {} });
    expect(view.mutation?.survived).toBe(0);
    expect(view.mutation?.killed).toBe(view.mutation?.ran);
    expect(view.gaps.filter((line) => line.startsWith("survives:"))).toEqual([]);
  });

  it("bounds the number of breaks and keeps the creator's folder as it was", async () => {
    const world = await declared();
    await world.accept();
    const view = await world.review({ mutation: { max: 2 } });
    expect(view.mutation?.ran).toBe(2);
    expect(view.mutation?.proposed).toBeGreaterThan(2);
    expect(world.lab.creator.get("src/entry.ts")).toBe(SOURCE);
    expect(world.lab.opened).toHaveLength(1);
    expect(world.lab.opened[0]?.files.get("src/entry.ts")).toBe(SOURCE);
    // The bounds are the schema's: no more than 30 breaks, no less than 10 seconds.
    expect((await world.refusal({ mutation: { max: 31 } })).code).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect((await world.refusal({ mutation: { seconds: 5 } })).code).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    expect((await world.refusal({ mutation: { seconds: 1801 } })).code).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
  });

  it("never runs a command the creator did not accept", async () => {
    const world = await declared();
    const waiting = await world.refusal({ mutation: {} });
    expect(String(waiting.details.reason)).toContain("not_accepted:criteria");
    const named = await world.refusal({ mutation: { command: "all" } });
    expect(String(named.details.reason)).toContain("not_accepted:all");
    const unknown = await world.refusal({ mutation: { command: "other" } });
    expect(String(unknown.details.reason)).toContain("unknown_command:other");
    expect(world.lab.openings).toBe(0);
    expect(world.runner.requests).toEqual([]);
  });

  it("asks for a command when the project declares none", async () => {
    const world = await declared(pinning, { declare: false });
    const refused = await world.refusal({ mutation: {} });
    expect(String(refused.details.reason)).toContain("no_command_to_run");
    expect(world.lab.openings).toBe(0);
  });

  it("runs the whole accepted command when it is asked for by name", async () => {
    const world = await declared();
    await world.accept();
    const view = await world.review({ mutation: { command: "all", max: 1 } });
    expect(view.mutation?.ran).toBe(1);
    expect(world.lab.opened[0]?.requests[0]).toMatchObject({
      line: "npx vitest run",
      timeoutMs: 200_000,
    });
  });

  it("says why the check did not run instead of failing", async () => {
    const world = await declared(() => failed("1 failed"));
    await world.accept();
    const view = await world.review({ mutation: {} });
    expect(view.mutation).toMatchObject({ status: "baseline_red", ran: 0 });
    expect(view.mutation?.reason).toContain("fail before any break");
    world.lab.refuse = "copy_too_big";
    const refused = await world.review({ mutation: {} });
    expect(refused.mutation).toMatchObject({ status: "refused", reason: "copy_too_big" });
  });
});

describe("the holes are tied to the requirements", () => {
  it("lists the criteria and the requirements of the story that no test guards", async () => {
    const world = await declared();
    world.cite(1);
    const view = await world.review();
    expect(view.gaps).toContain("1-3 2: no test cites it (name one AC-1-3-2)");
    expect(view.gaps).toContain("1-3 3: no test cites it (name one AC-1-3-3)");
    expect(view.gaps).toContain("EF-1: no test cites it");
    expect(view.gaps.join("\n")).not.toContain("1-3 1: no test");
    // A requirement the story does not cite is not its hole.
    expect(view.gaps.join("\n")).not.toContain("ENF-");
  });

  it("lists a test never seen failing, and the criteria whose tests killed no break", async () => {
    const world = await declared(() => passed());
    world.cite(1, 2, 3);
    world.tests.lines.push({
      path: "src/entry.test.ts",
      line: 40,
      text: "it('EF-1 lets Ada in', () => {",
    });
    await world.accept();
    const view = await world.review({ mutation: {} });
    expect(view.mutation?.killed).toBe(0);
    const ran = view.mutation?.ran ?? 0;
    expect(view.gaps).toContain("1-3 1: its test was not run yet (story.criterion)");
    expect(
      view.gaps.some((line) =>
        line.includes(`EF-1: story 1-3's tests killed none of ${ran} mutations`),
      ),
    ).toBe(true);
    expect(view.gaps.filter((line) => line.startsWith("survives:"))).toHaveLength(
      Math.min(ran, 11),
    );
  });

  it("lists, for the product, the requirements in progress that have no test", async () => {
    const world = await declared();
    const result = await world.call("review_tests", { agent: "quentin" });
    if (!result.ok) throw new Error(result.error.code);
    const view = result.value as unknown as TestsView;
    expect(view.scope).toBe("product");
    expect(view.gaps).toContain("EF-1: no test cites it");
    // Not started, so not yet a hole.
    expect(view.gaps.join("\n")).not.toContain("ENF-3");
  });
});

describe("each hole is work to decide, one gesture each", () => {
  it("records nothing unless asked, then one item of work per hole, once", async () => {
    const world = await declared();
    world.cite(1);
    await world.review();
    expect(world.events("deferred.recorded")).toEqual([]);
    const first = await world.review({ propose: true });
    expect(first.proposed).toBe(4);
    const items = world
      .events("deferred.recorded")
      .map((event) => event.payload as Record<string, unknown>);
    expect(items.map((item) => item.title)).toEqual([
      "[tests] 1-3 1: its test was not run yet (story.criterion)",
      "[tests] 1-3 2: no test cites it (name one AC-1-3-2)",
      "[tests] 1-3 3: no test cites it (name one AC-1-3-3)",
      "[tests] EF-1: no test cites it",
    ]);
    expect(items.every((item) => item.owner === "creator" && String(item.detail).length > 20)).toBe(
      true,
    );
    // Run again: the open items are not proposed twice.
    const second = await world.review({ propose: true });
    expect(second.proposed).toBe(0);
    expect(world.events("deferred.recorded")).toHaveLength(4);
  });

  it("proposes a surviving break as a correction to decide", async () => {
    const world = await declared();
    await world.accept();
    const view = await world.review({ mutation: {}, propose: true });
    expect(view.proposed).toBeGreaterThanOrEqual(1);
    const titles = world
      .events("deferred.recorded")
      .map((event) => (event.payload as { title: string }).title);
    expect(titles).toContain("[tests] survives: src/entry.ts:2 number `18` -> `19`");
  });

  it("proposes at most ten holes in one call", async () => {
    const world = await declared(() => passed());
    await world.accept();
    const view = await world.review({ mutation: { max: 30 }, propose: true });
    expect(view.gapCount).toBeGreaterThan(10);
    expect(view.proposed).toBe(10);
    expect(world.events("deferred.recorded")).toHaveLength(10);
  });
});

describe("what the answer weighs is bounded", () => {
  it("stays under its budget with a grid full of findings, many breaks and many holes", async () => {
    const world = await declared(() => passed());
    await world.accept();
    world.cite(1);
    const findings = TEST_ROWS.slice(0, 20).map((row, index) => ({
      criterion: row.criterion,
      row: row.id as TestGrid["findings"][number]["row"],
      test: `src/entry.test.ts:${index + 1} ${"a very long test name ".repeat(5)}`,
      reason: "x".repeat(240),
    }));
    const grid: TestGrid = {
      reads: READS,
      criteria: TEST_CRITERIA.map((criterion) => ({
        criterion,
        verdict: findings.some((finding) => finding.criterion === criterion)
          ? ("issues" as const)
          : ("ok" as const),
      })),
      findings: findings.map((finding) => ({
        ...finding,
        test: finding.test.slice(0, 200),
      })),
    };
    const view = await world.review({ grid, mutation: { max: 30 } });
    expect(view.gaps.length).toBeLessThanOrEqual(13);
    expect(view.grid?.lines.length).toBeLessThanOrEqual(9);
    const size = JSON.stringify(view).length;
    expect(size).toBeLessThanOrEqual(RESPONSE_FORMS["review.tests"]?.max ?? 0);
    expect(size).toBeGreaterThan(1_500);
  });

  it("is an action of the review tool and the engine's, not a tool of its own", async () => {
    const { toolCallOf } = await import("../mcp-tools.js");
    expect(toolCallOf("review_tests")).toEqual({ tool: "review", action: "tests" });
  });
});
