import { ErrorCode } from "@agentplugged/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AgentStateView,
  type CreatorActionRequested,
  type CriterionView,
  computeProjection,
  type ProofRunner,
  type ProofRunRequest,
  type ProofRunResult,
  type StoryState,
  type WorkingCopy,
} from "../index.js";
import { PROOFS_PATH } from "../proofs/proof-declaration.js";
import { product } from "../testing/requirements-product.js";
import { criteriaTrace } from "./criterion-trace.js";

/**
 * The acceptance criteria proved by tests written first, end to end: the engine starts
 * the test command the creator accepted, filtered on a criterion, in the story's working copy, and
 * inscribes the red then the green itself; without a command the agent's word is marked reported;
 * a test never seen failing is flagged; a criterion with no result to observe is declared with its
 * reason; the story goes to review only when each criterion holds; the quick lane skips the red.
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
  "A cart.",
  "",
  "## Intent",
  "",
  "Ada can fill her cart.",
  "",
  "## Acceptance criteria",
  "",
  "- Given an empty cart, when Ada checks out, then she is told it is empty.",
  "- Given two items, when Ada checks out, then she pays for both.",
  "- Given a payment, when it is made, then a sound plays.",
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
  "  - name: pytest",
  "    run: python -m pytest -k {criterion_}",
  "    proves: []",
  "",
].join("\n");

/** A runner that runs nothing: it answers what the test says and records what it was asked. */
class FakeRunner implements ProofRunner {
  readonly requests: ProofRunRequest[] = [];
  readonly copies: Array<string | undefined> = [];
  copy: WorkingCopy = { commit: COMMIT, clean: true };
  queue: Array<Partial<ProofRunResult>> = [];
  async workingCopy(workspace?: string): Promise<WorkingCopy> {
    this.copies.push(workspace);
    return this.copy;
  }
  async run(request: ProofRunRequest): Promise<ProofRunResult> {
    this.requests.push(request);
    return {
      ended: "exit",
      exit: 0,
      ms: 800,
      head: "",
      tail: "1 passed",
      omitted: 0,
      ...this.queue.shift(),
    };
  }
}

const failing = (): Partial<ProofRunResult> => ({
  exit: 1,
  head: "FAIL AC-1-3-1 refuses an empty cart",
  tail: "AssertionError: expected 'ok' to be 'empty'\n1 failed",
});

type World = Awaited<ReturnType<typeof declared>>;

/** A product with its story started by Sam, its commands declared, and nothing accepted yet. */
async function declared(options: { runner?: ProofRunner; text?: string; quick?: boolean } = {}) {
  const runner = options.runner ?? new FakeRunner();
  const world = await product({ proofRunner: runner });
  world.files.seed(".agentplugged/stories/1-3-cart.md", STORY);
  if (options.text !== "none") world.files.seed(PROOFS_PATH, options.text ?? DECLARED);
  const productId = world.journal.events[0]?.product as string;
  const header = { product: productId, provenance: "trusted", story: "1-3" } as const;
  const sam = { kind: "agent", agent: "sam" } as const;
  const started = {
    type: "story.started",
    actor: sam,
    ...header,
    payload: {
      agent: "sam",
      branch: "feat/1-3-cart",
      base: COMMIT,
      base_ref: "main",
      worktree: WORKTREE,
    },
  };
  const [first] = await world.journal.appendAll([started]);
  if (options.quick === true) {
    await world.journal.appendAll([
      {
        type: "story.fast_track_entered",
        actor: sam,
        ...header,
        payload: {
          agent: "sam",
          summary: "A small fix",
          declared: { single_reading: true, reversible: true, no_public_interface: true },
        },
      },
    ]);
  }
  const accept = async () => {
    const raised = (await world.run("request_creator_action", {
      agent: "quentin",
      action: { kind: "proof_commands" },
      reason: "the creator wants the tests of the criteria run by the engine",
    })) as unknown as CreatorActionRequested;
    await world.approve(raised.checkpoint);
    return raised;
  };
  const record = async (criterion: number, extra: Record<string, unknown> = {}) => {
    const result = await world.call("record_criterion", {
      agent: "sam",
      story: "1-3",
      criterion,
      ...extra,
    });
    if (!result.ok) {
      throw new Error(`record_criterion: ${result.error.code} ${result.error.details.reason}`);
    }
    return result.value as unknown as CriterionView;
  };
  const refusal = async (criterion: number, extra: Record<string, unknown> = {}) => {
    const result = await world.call("record_criterion", {
      agent: "sam",
      story: "1-3",
      criterion,
      ...extra,
    });
    if (result.ok) throw new Error("expected a refusal");
    return result.error;
  };
  const toReview = () =>
    world.call("update_story", { agent: "sam", story: "1-3", status: "in_review" });
  const projection = async () => (await computeProjection(world.journal.events)).state;
  const storyState = async () =>
    ((await projection()).stories as Record<string, StoryState>)["1-3"] as StoryState;
  /** The code is written and committed: the next run is made on another commit. */
  let commits = 0;
  const advance = () => {
    commits += 1;
    (runner as FakeRunner).copy = {
      commit: "def0123456789abc"[commits % 16]?.repeat(40) ?? COMMIT,
      clean: true,
    };
  };
  const cites = (...criteria: number[]) => {
    world.tests.lines = criteria.map((n) => ({
      path: "src/cart.test.ts",
      line: 10 + n,
      text: `it('AC-1-3-${n} is covered', () => {`,
    }));
  };
  return {
    ...world,
    runner: runner as FakeRunner,
    started: first,
    accept,
    record,
    refusal,
    toReview,
    projection,
    storyState,
    cites,
    advance,
  };
}

const missingOf = (error: { details: Record<string, unknown> }) =>
  String(error.details.missing).split("\n");

describe("the engine sees the test fail, then pass", () => {
  it("runs the accepted command filtered on the criterion, in the story's working copy, red then green", async () => {
    const world = await declared();
    world.cites(1);
    await world.accept();
    world.runner.queue = [failing()];
    const red = await world.record(1);
    expect(red).toMatchObject({
      story: "1-3",
      criterion: 1,
      result: "red",
      origin: "engine",
      status: "red",
      ended: "exit",
      exit: 1,
      seconds: 0.8,
    });
    expect(red.lines?.join(" ")).toContain("AssertionError");
    expect(red.log).toContain(".agentplugged/.cache/proof-runs/criteria-");
    // The line the creator accepted, with the id written in; in the story's copy, not the main one.
    const request = world.runner.requests.at(-1) as ProofRunRequest;
    expect(request).toMatchObject({
      line: "npx vitest run -t AC-1-3-1",
      argv: ["npx", "vitest", "run", "-t", "AC-1-3-1"],
      cwd: ".",
      workspace: WORKTREE,
      timeoutMs: 120_000,
    });
    expect(world.runner.copies.at(-1)).toBe(WORKTREE);
    // After the code (committed): green, seen by the engine.
    world.advance();
    const green = await world.record(1);
    expect(green).toMatchObject({ result: "green", origin: "engine", status: "green" });
    expect(green.trace).toBe("1:green 2:no_test 3:no_test");
    const record = (await world.storyState()).criteria?.["1"];
    expect(record).toMatchObject({
      runs: 2,
      red: { origin: "engine", commit: COMMIT, clean: true },
      green: { origin: "engine", commit: "e".repeat(40), clean: true },
    });
    // The journal holds the run the engine made, with the command's fingerprint.
    const event = world.journal.events.filter((entry) => entry.type === "story.criterion_recorded");
    expect(event).toHaveLength(2);
    expect(event[0]?.payload).toMatchObject({
      criterion: 1,
      result: "red",
      origin: "engine",
      run: { command: "criteria", ended: "exit", exit: 1 },
    });
  });

  it("writes the id with underscores where the command asks for it", async () => {
    const world = await declared({
      text: ["commands:", "  - name: pytest", "    run: python -m pytest -k {criterion_}", ""].join(
        "\n",
      ),
    });
    await world.accept();
    world.runner.queue = [failing()];
    await world.record(2);
    expect(world.runner.requests.at(-1)?.argv).toEqual([
      "python",
      "-m",
      "pytest",
      "-k",
      "AC_1_3_2",
    ]);
  });

  it("flags a test that passes the first time it is seen: it proves nothing", async () => {
    const world = await declared();
    await world.accept();
    world.cites(2);
    const first = await world.record(2, { seen: "red" });
    // The agent expected red; the engine saw green and says so.
    expect(first).toMatchObject({ result: "green", status: "never_red", expected: "red" });
    expect(first.trace).toBe("1:no_test 2:never_red 3:no_test");
    const refused = await world.toReview();
    expect(refused.ok).toBe(false);
    // Seen failing, then passing: it holds.
    world.runner.queue = [failing()];
    expect((await world.record(2)).status).toBe("red");
    world.advance();
    expect((await world.record(2)).status).toBe("green");
  });

  it("records nothing when the command timed out or never started", async () => {
    const world = await declared();
    await world.accept();
    const before = world.journal.events.length;
    world.runner.queue = [{ ended: "timeout", exit: null }];
    const stopped = await world.record(1);
    expect(stopped).toMatchObject({ result: "none", ended: "timeout", status: "no_test" });
    world.runner.queue = [{ ended: "error", exit: null }];
    expect(await world.record(1)).toMatchObject({ result: "none", ended: "error" });
    expect(world.journal.events.length).toBe(before);
    expect((await world.storyState()).criteria).toBeUndefined();
  });

  it("marks a run on a copy with changes not committed", async () => {
    const world = await declared();
    await world.accept();
    world.runner.copy = { commit: COMMIT, clean: false };
    world.runner.queue = [failing()];
    expect(await world.record(1)).toMatchObject({ result: "red", unclean: true });
  });

  it("runs nothing the creator did not accept, and says what to do", async () => {
    const world = await declared();
    // Declared, not accepted: the agent has to say what it saw.
    const error = await world.refusal(1);
    expect(error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(String(error.details.reason)).toContain("no_command_to_run");
    expect(String(error.details.reason)).toContain("criteria is declared but not accepted");
    const reported = await world.record(1, { seen: "red", note: "AC-1-3-1 refuses an empty cart" });
    expect(reported.hint).toContain("not accepted");
    expect(world.runner.requests).toEqual([]);
    // Nothing is declared at all.
    const bare = await declared({ text: "none" });
    expect(String((await bare.refusal(1)).details.reason)).toContain("declare a test command");
  });

  it("keeps the tests of a criterion out of the proofs of the requirements", async () => {
    const world = await declared();
    await world.accept();
    const result = await world.call("run_proof_command", { agent: "quentin", command: "criteria" });
    expect(result.ok).toBe(false);
    expect(!result.ok && String(result.error.details.reason)).toContain("runs_criteria:criteria");
    expect(world.runner.requests).toEqual([]);
  });

  it("shows the creator the exact line, with the mark, and says it proves no requirement", async () => {
    const world = await declared();
    const raised = (await world.run("request_creator_action", {
      agent: "quentin",
      action: { kind: "proof_commands" },
      reason: "the creator wants the tests of the criteria run by the engine",
    })) as unknown as { preview: string };
    expect(raised.preview.split("\n")).toEqual([
      "- criteria: npx vitest run -t {criterion} [in .; stops after 120 s; runs the tests of a criterion]",
      "- pytest: python -m pytest -k {criterion_} [in .; stops after 300 s; runs the tests of a criterion]",
    ]);
  });
});

describe("what an agent reports is marked as its word", () => {
  it("marks a reported red and green, and the trace says so", async () => {
    const world = await declared({ text: "none" });
    world.cites(1, 2);
    const red = await world.record(1, { seen: "red", note: "AC-1-3-1 refuses an empty cart" });
    expect(red).toMatchObject({ result: "red", origin: "reported", status: "red" });
    expect(world.runner.requests).toEqual([]);
    world.advance();
    const green = await world.record(1, { seen: "green", note: "AC-1-3-1 refuses an empty cart" });
    expect(green).toMatchObject({ result: "green", origin: "reported", status: "green" });
    expect(green.trace).toBe("1:green(reported) 2:not_run 3:no_test");
    const event = world.journal.events.filter((entry) => entry.type === "story.criterion_recorded");
    expect(event[1]?.payload).toMatchObject({ origin: "reported", test: expect.any(String) });
    expect(event[1]?.payload).not.toHaveProperty("run");
  });

  it("asks what the agent saw, and for the test it ran", async () => {
    const world = await declared({ text: "none" });
    expect(String((await world.refusal(1)).details.reason)).toContain("no_command_to_run");
    expect(String((await world.refusal(1, { seen: "red" })).details.reason)).toContain(
      "no_command_to_run",
    );
    expect((await world.refusal(1, { seen: "blue", note: "t" })).code).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
  });

  it("refuses a story that is not the caller's, not started or a criterion it does not list", async () => {
    const world = await declared({ text: "none" });
    const other = await world.call("record_criterion", {
      agent: "quentin",
      story: "1-3",
      criterion: 1,
      seen: "red",
      note: "t",
    });
    expect(!other.ok && String(other.error.details.reason)).toContain("not_builder");
    const unknown = await world.refusal(4, { seen: "red", note: "t" });
    expect(String(unknown.details.reason)).toContain("unknown_criterion:4 (the story lists 3)");
    const none = await world.call("record_criterion", {
      agent: "sam",
      story: "1-1",
      criterion: 1,
      seen: "red",
      note: "t",
    });
    expect(!none.ok && String(none.error.details.reason)).toContain("not_started");
  });
});

describe("a criterion with no result to observe is declared, with its reason", () => {
  it("is shown to the review with its reason, and a run lifts it", async () => {
    const world = await declared();
    const declaredView = await world.record(3, {
      seen: "untestable",
      note: "the sound plays on the user's speaker",
    });
    expect(declaredView).toMatchObject({
      result: "untestable",
      origin: "reported",
      status: "untestable",
    });
    expect((await world.storyState()).criteria?.["3"]?.untestable?.reason).toContain("speaker");
    // The reason is not optional.
    expect((await world.refusal(3, { seen: "untestable" })).code).toBe(ErrorCode.INVALID_ARGUMENTS);
    // The creator never accepted a command: a run is the agent's word again.
    world.cites(3);
    const lifted = await world.record(3, { seen: "red", note: "AC-1-3-3 plays a sound" });
    expect(lifted.status).toBe("red");
    expect((await world.storyState()).criteria?.["3"]?.untestable).toBeUndefined();
  });
});

describe("the story goes to review when each criterion holds", () => {
  it("says what is missing, one line per criterion, and writes nothing", async () => {
    const world = await declared();
    await world.accept();
    world.cites(1, 2);
    world.runner.queue = [failing(), {}, {}];
    await world.record(1);
    world.advance();
    await world.record(1);
    await world.record(2); // passes the first time it is seen
    const before = world.journal.events.length;
    const refused = await world.toReview();
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe(ErrorCode.CRITERIA_NOT_PROVEN);
    expect(missingOf(refused.error)).toEqual([
      "- 2: its test never failed before the code (it proves nothing)",
      "- 3: no test cites it (name one AC-1-3-3)",
    ]);
    // submit_result complete moves the story to review: the same gate.
    const result = await world.call("submit_result", {
      agent: "sam",
      story: "1-3",
      status: "complete",
      summary: "Done.",
      assumptions: [],
      open_questions: [],
      conflicts: [],
    });
    expect(!result.ok && result.error.code).toBe(ErrorCode.CRITERIA_NOT_PROVEN);
    expect(world.journal.events.length).toBe(before);
    expect(((await world.projection()).stories as Record<string, StoryState>)["1-3"]?.status).toBe(
      "in_progress",
    );
    // Criterion 2 seen failing then passing; criterion 3 declared untestable: it goes.
    world.runner.queue = [failing()];
    await world.record(2);
    world.advance();
    await world.record(2);
    await world.record(3, { seen: "untestable", note: "the sound plays on a speaker" });
    expect((await world.toReview()).ok).toBe(true);
    expect(((await world.projection()).stories as Record<string, StoryState>)["1-3"]?.status).toBe(
      "in_review",
    );
  });

  it("holds a test that was never run and one that fails now", async () => {
    const world = await declared();
    await world.accept();
    world.cites(1, 2, 3);
    world.runner.queue = [failing(), {}, failing()];
    await world.record(1);
    await world.record(1);
    await world.record(1); // fails again after passing: a regression
    const refused = await world.toReview();
    expect(!refused.ok && missingOf(refused.error)).toEqual([
      "- 1: its test fails now",
      "- 2: its test was not run yet (story.criterion)",
      "- 3: its test was not run yet (story.criterion)",
    ]);
  });

  it("does not ask for what it cannot follow: a story whose criteria are not a list", async () => {
    const world = await declared();
    world.files.seed(
      ".agentplugged/stories/1-3-cart.md",
      STORY.replace(/- Given[^\n]*\n/g, "").replace(
        "## Acceptance criteria\n",
        "## Acceptance criteria\n\nGiven Ada, when she acts, then it works.\n",
      ),
    );
    expect((await world.toReview()).ok).toBe(true);
  });

  it("shows what the engine saw in the state of the story, in one line", async () => {
    const world = await declared({ text: "none" });
    await world.record(2, { seen: "red", note: "t" });
    await world.record(1, { seen: "untestable", note: "a sound" });
    const view = (await world.state()) as AgentStateView;
    expect((view.stories["1-3"] as unknown as { criteria?: string } | undefined)?.criteria).toBe(
      "1:untestable 2:red(reported)",
    );
  });
});

describe("the quick lane of a one-line fix does not ask for a red (limit)", () => {
  it("lets a passing test that covers the criterion through, and says it is covered", async () => {
    const world = await declared({ quick: true });
    await world.accept();
    world.cites(1, 2, 3);
    expect((await world.storyState()).fast_track?.status).toBe("active");
    const first = await world.record(1);
    expect(first).toMatchObject({ result: "green", status: "covered" });
    await world.record(2);
    // A test that was never run is not covered.
    const refused = await world.toReview();
    expect(!refused.ok && missingOf(refused.error)).toEqual([
      "- 3: its test was not run yet (story.criterion)",
    ]);
    await world.record(3);
    expect((await world.toReview()).ok).toBe(true);
  });

  it("asks for the red in the full lane for the same runs", async () => {
    const world = await declared();
    await world.accept();
    for (const n of [1, 2, 3]) await world.record(n);
    const refused = await world.toReview();
    expect(!refused.ok && missingOf(refused.error)).toHaveLength(3);
  });
});

describe("a green is earned: a test cites the criterion, and the code changed", () => {
  it("does not hold a green made on the commit of its red", async () => {
    const world = await declared();
    await world.accept();
    world.cites(1, 2, 3);
    world.runner.queue = [failing(), {}];
    await world.record(1);
    // Nothing was written between the two runs: the same clean commit.
    const green = await world.record(1);
    expect(green).toMatchObject({ result: "green", status: "no_change" });
    const refused = await world.toReview();
    expect(!refused.ok && missingOf(refused.error)[0]).toBe(
      "- 1: its green ran on the commit of its red (commit the test, then the code)",
    );
    // The code is committed: the next green is earned.
    world.advance();
    expect((await world.record(1)).status).toBe("green");
  });

  it("says no_test when the test that was run is gone, whatever the journal holds", async () => {
    const world = await declared();
    await world.accept();
    world.cites(1);
    world.runner.queue = [failing()];
    await world.record(1);
    world.advance();
    expect((await world.record(1)).status).toBe("green");
    // The test was renamed away from the criterion: the runs prove nothing about it any more.
    world.cites();
    const refused = await world.toReview();
    expect(!refused.ok && missingOf(refused.error)[0]).toBe(
      "- 1: no test cites it (name one AC-1-3-1)",
    );
  });

  it("marks the whole cycle as the agent's word when only one run was the engine's", async () => {
    const world = await declared({ text: "none" });
    world.cites(1);
    await world.record(1, { seen: "red", note: "AC-1-3-1 refuses an empty cart" });
    world.advance();
    const green = await world.record(1, { seen: "green", note: "AC-1-3-1 refuses an empty cart" });
    expect(green.trace).toBe("1:green(reported) 2:no_test 3:no_test");
  });

  it("gives the review no more than eight reasons, then counts the rest", async () => {
    const world = await declared({ text: "none" });
    const many = STORY.replace(
      /- Given an empty cart[^\n]*\n- Given two items[^\n]*\n- Given a payment[^\n]*\n/,
      Array.from(
        { length: 12 },
        (_, index) => `- Given a case ${index + 1}, then it is shown.\n`,
      ).join(""),
    );
    world.files.seed(".agentplugged/stories/1-3-cart.md", many);
    for (let n = 1; n <= 12; n += 1) {
      await world.record(n, { seen: "untestable", note: `reason ${n}` });
    }
    const trace = await criteriaTrace(
      { files: world.files, testReferences: world.tests } as never,
      await world.projection(),
      "1-3",
    );
    expect(trace?.untestable).toHaveLength(9);
    expect(trace?.untestable.at(-1)).toBe("+4 more");
    expect(trace?.untestable[0]).toBe("1: reason 1");
  });
});

describe("the journal believes only what the engine saw", () => {
  it("ignores a run no accepted command made, another agent's, and a verdict that disagrees", async () => {
    const world = await declared();
    const productId = world.journal.events[0]?.product as string;
    await world.accept();
    const accepted = Object.values(
      (await world.projection()).checkpoints as Record<
        string,
        {
          creator_action?: { commands?: Array<{ name: string; fingerprint: string }> };
        }
      >,
    )
      .flatMap((point) => point.creator_action?.commands ?? [])
      .find((command) => command.name === "criteria")?.fingerprint as string;
    const run = {
      command: "criteria",
      fingerprint: accepted,
      ended: "exit",
      exit: 1,
      ms: 5,
      summary: "x",
    };
    const forge = async (actor: Record<string, unknown>, payload: Record<string, unknown>) =>
      world.journal.appendAll([
        {
          type: "story.criterion_recorded",
          actor,
          product: productId,
          provenance: "trusted",
          story: "1-3",
          payload,
        },
      ] as never);
    const sam = { kind: "agent", agent: "sam" };
    const ignored = [
      // Never accepted: another fingerprint.
      ...(await forge(sam, {
        criterion: 1,
        result: "red",
        origin: "engine",
        run: { ...run, fingerprint: "b".repeat(24) },
      })),
      // Another name than the accepted command's.
      ...(await forge(sam, {
        criterion: 1,
        result: "red",
        origin: "engine",
        run: { ...run, command: "other" },
      })),
      // Exit 1 told as green, exit 0 told as red, a time limit told as red.
      ...(await forge(sam, { criterion: 1, result: "green", origin: "engine", run })),
      ...(await forge(sam, {
        criterion: 1,
        result: "red",
        origin: "engine",
        run: { ...run, exit: 0 },
      })),
      ...(await forge(sam, {
        criterion: 1,
        result: "red",
        origin: "engine",
        run: { ...run, ended: "timeout", exit: null },
      })),
      // Quentin is not the story's developer.
      ...(await forge(
        { kind: "agent", agent: "quentin" },
        { criterion: 1, result: "red", origin: "reported", test: "t" },
      )),
    ];
    const projection = await computeProjection(world.journal.events);
    expect(projection.ignored.map((entry) => entry.id).sort()).toEqual(
      ignored.map((event) => event.id).sort(),
    );
    expect((await world.storyState()).criteria).toBeUndefined();
    // The accepted line, exit 1: a red the engine could have seen.
    await forge(sam, { criterion: 1, result: "red", origin: "engine", run });
    expect((await world.storyState()).criteria?.["1"]?.red?.origin).toBe("engine");
  });

  it("replays to the same state", async () => {
    const world = await declared();
    await world.accept();
    world.runner.queue = [failing()];
    await world.record(1);
    await world.record(1);
    await world.record(3, { seen: "untestable", note: "a sound" });
    const first = JSON.stringify((await computeProjection(world.journal.events)).state);
    const second = JSON.stringify((await computeProjection([...world.journal.events])).state);
    expect(second).toBe(first);
    expect((await computeProjection(world.journal.events)).ignored).toEqual([]);
  });
});

/**
 * The few parts of Node the real-command test uses. The core takes no Node types (it is pure), so
 * the modules are loaded by name and typed by what is used here.
 */
interface NodeParts {
  readonly spawn: (
    program: string,
    args: string[],
    options: { cwd: string; encoding: "utf8"; timeout: number },
  ) => { status: number | null; stdout: string; stderr: string };
  readonly fs: {
    existsSync: (path: string) => boolean;
    mkdirSync: (path: string) => void;
    mkdtempSync: (prefix: string) => string;
    rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
    writeFileSync: (path: string, text: string) => void;
  };
  readonly tmp: string;
  readonly join: (...parts: string[]) => string;
  readonly program: string;
}

async function nodeParts(): Promise<NodeParts> {
  const load = (name: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ name);
  const [child, fs, os, path] = await Promise.all([
    load("node:child_process"),
    load("node:fs"),
    load("node:os"),
    load("node:path"),
  ]);
  const process = (globalThis as unknown as { process: { execPath: string } }).process;
  return {
    spawn: child.spawnSync as NodeParts["spawn"],
    fs: fs as unknown as NodeParts["fs"],
    tmp: (os.tmpdir as () => string)(),
    join: path.join as NodeParts["join"],
    program: process.execPath,
  };
}

/** A runner that really starts a short command: Node runs a script that looks for the code. */
class ShortCommandRunner implements ProofRunner {
  readonly lines: string[] = [];
  commit = COMMIT;
  constructor(
    private readonly node: NodeParts,
    private readonly folder: string,
  ) {}
  async workingCopy(): Promise<WorkingCopy> {
    return { commit: this.commit, clean: true };
  }
  async run(request: ProofRunRequest): Promise<ProofRunResult> {
    this.lines.push(request.line);
    const argv = request.argv ?? [];
    const started = Date.now();
    const done = this.node.spawn(this.node.program, argv.slice(1), {
      cwd: this.node.join(this.folder, request.cwd),
      encoding: "utf8",
      timeout: request.timeoutMs,
    });
    return {
      ended: "exit",
      exit: done.status,
      ms: Date.now() - started,
      head: "",
      tail: `${done.stdout}${done.stderr}`,
      omitted: 0,
    };
  }
}

describe("a real short command: red before the code, green after it", () => {
  let node: NodeParts;
  let folder = "";
  beforeAll(async () => {
    node = await nodeParts();
    folder = node.fs.mkdtempSync(node.join(node.tmp, "agentplugged-criteria-"));
  });
  afterAll(() => node.fs.rmSync(folder, { recursive: true, force: true }));

  it("starts a program that fails while the code is missing, and passes once it is written", async () => {
    const { fs, join } = node;
    fs.mkdirSync(join(folder, "tests"));
    // The test looks for the code of the criterion it is named for (its id is its argument).
    fs.writeFileSync(
      join(folder, "tests", "check.mjs"),
      [
        'import { existsSync } from "node:fs";',
        'const id = process.argv[2] ?? "";',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the text is the source of a script written to disk, not a template
        "if (!/^AC-1-3-\\d+$/.test(id)) throw new Error(`not a criterion: ${id}`);",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the text is the source of a script written to disk, not a template
        "if (!existsSync(`code-${id}.txt`)) {",
        "  console.error(`AssertionError: ${id}: the code is missing`);",
        "  process.exit(1);",
        "}",
        "console.log(`${id} ok`);",
        "",
      ].join("\n"),
    );
    const runner = new ShortCommandRunner(node, folder);
    const world = await declared({
      runner,
      text: [
        "commands:",
        "  - name: criteria",
        "    run: node tests/check.mjs {criterion}",
        "",
      ].join("\n"),
    });
    await world.accept();
    world.cites(1);
    const red = await world.record(1);
    expect(red).toMatchObject({ result: "red", origin: "engine", ended: "exit", exit: 1 });
    expect(red.lines?.join(" ")).toContain("AC-1-3-1: the code is missing");
    expect(runner.lines.at(-1)).toBe("node tests/check.mjs AC-1-3-1");
    fs.writeFileSync(join(folder, "code-AC-1-3-1.txt"), "done");
    runner.commit = "d".repeat(40);
    const green = await world.record(1);
    expect(green).toMatchObject({ result: "green", origin: "engine", status: "green", exit: 0 });
    expect(fs.existsSync(join(folder, "code-AC-1-3-2.txt"))).toBe(false);
    expect((await world.record(2)).result).toBe("red");
  });
});
