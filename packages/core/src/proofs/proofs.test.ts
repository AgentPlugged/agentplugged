import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CreatorActionRequested,
  computeProjection,
  type ProofRunner,
  type ProofRunRequest,
  type ProofRunResult,
  type ProofRunView,
  type RecordedEvent,
  type WorkingCopy,
} from "../index.js";
import { product } from "../testing/requirements-product.js";
import { PROOFS_PATH } from "./proof-declaration.js";
import { PROOF_RUNS_DIR } from "./proof-run-command.js";

/**
 * The proofs the engine produces, end to end: the project declares its commands, the
 * creator accepts the exact lines once, the engine runs them itself and inscribes the proof, marked
 * as its own; a modified line asks again, a refusal is respected, a command that fails or runs out
 * of time is a failure, a secret never reaches the journal, and the release can demand these proofs.
 */

const COMMIT = "c".repeat(40);

/** A runner that runs nothing: it records what it is asked and answers what the test says. */
class FakeRunner implements ProofRunner {
  readonly requests: ProofRunRequest[] = [];
  copy: WorkingCopy = { commit: COMMIT, clean: true };
  next: Partial<ProofRunResult> = {};
  async workingCopy(): Promise<WorkingCopy> {
    return this.copy;
  }
  async run(request: ProofRunRequest): Promise<ProofRunResult> {
    this.requests.push(request);
    return {
      ended: "exit",
      exit: 0,
      ms: 1234,
      head: "",
      tail: "Tests  12 passed",
      omitted: 0,
      ...this.next,
    };
  }
}

const DECLARED = [
  "commands:",
  "  - name: tests",
  "    run: pnpm test",
  "    proves: [ENF-2]",
  "  - name: audit",
  "    run: npm audit --audit-level=high",
  "    proves: [ENF-3]",
  "  - name: bench",
  "    run: node bench.mjs",
  "    cwd: perf",
  "    timeout: 60",
  "    proves: [ENF-1]",
  '    measured_after: "p95_ms="',
  "",
].join("\n");

const CITING = [
  { path: "src/signin.test.ts", line: 12, text: "it('ENF-2 refuses a bad password')" },
];

async function declared(text = DECLARED) {
  const runner = new FakeRunner();
  const world = await product({ proofRunner: runner });
  world.files.seed(PROOFS_PATH, text);
  world.tests.lines = CITING;
  await world.sync();
  const asked = async (
    action: Record<string, unknown> = { kind: "proof_commands" },
  ): Promise<CreatorActionRequested> =>
    (await world.run("request_creator_action", {
      agent: "quentin",
      action,
      reason: "the creator wants the proofs run by the engine",
    })) as unknown as CreatorActionRequested;
  const accept = async (action?: Record<string, unknown>) => {
    const raised = await asked(action);
    await world.approve(raised.checkpoint);
    return raised;
  };
  const execute = (command: string) =>
    world.call("run_proof_command", { agent: "quentin", command });
  const ran = async (command: string) => {
    const result = await execute(command);
    if (!result.ok)
      throw new Error(`run failed: ${result.error.code} ${result.error.details.reason}`);
    return result.value as unknown as ProofRunView;
  };
  const refusal = async (command: string) => {
    const result = await execute(command);
    if (result.ok) throw new Error("expected a refusal");
    return result.error;
  };
  const projection = async () => (await computeProjection(world.journal.events)).state;
  const proofOf = async (id: string) =>
    (
      (await projection()).requirements as {
        items: Record<string, { proved: Record<string, unknown> }>;
      }
    ).items[id]?.proved;
  return { ...world, runner, asked, accept, ran, refusal, execute, projection, proofOf };
}

describe("a command the creator did not accept does not run", () => {
  it("refuses what is not declared, not accepted, or still waiting for the creator", async () => {
    const world = await declared();
    expect((await world.refusal("tests")).details.reason).toContain("not_accepted:tests");
    expect((await world.refusal("nothing")).details.reason).toContain("unknown_command:nothing");
    // The request is open: nothing is accepted until the creator answers.
    const raised = await world.asked();
    expect((await world.refusal("tests")).details.reason).toContain("not_accepted:tests");
    expect(world.runner.requests).toEqual([]);
    expect(raised.kind).toBe("proof_commands");
    // Nothing declared at all.
    const empty = await declared("commands: []\n");
    expect((await empty.refusal("tests")).details.reason).toContain("unknown_command");
    const bare = await product({ proofRunner: new FakeRunner() });
    const none = await bare.call("run_proof_command", { agent: "quentin", command: "tests" });
    expect(none.ok).toBe(false);
    expect(!none.ok && String(none.error.details.reason)).toContain("no_command_declared");
  });

  it("refuses a file that is not valid, and says where", async () => {
    const world = await declared(
      "commands:\n  - { name: t, run: npm test, cwd: ../out, proves: [ENF-2] }\n",
    );
    const error = await world.refusal("t");
    expect(error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(String(error.details.reason)).toContain("commands.0.cwd");
    const asked = await world.call("request_creator_action", {
      agent: "quentin",
      action: { kind: "proof_commands" },
      reason: "x",
    });
    expect(asked.ok).toBe(false);
  });

  it("is never accepted in silence: a request that nobody answered, or an agent's own answer, accepts nothing", async () => {
    const world = await declared();
    const raised = await world.asked();
    // An agent cannot decide a creator's action.
    const decided = await world.call("decide_checkpoint", {
      agent: "quentin",
      checkpoint: raised.checkpoint,
      decision: "approved",
      reason: "I am sure",
    });
    expect(decided.ok).toBe(false);
    expect((await world.refusal("tests")).details.reason).toContain("not_accepted");
    expect(world.runner.requests).toEqual([]);
  });
});

describe("the creator accepts the exact lines once", () => {
  it("shows every new line whole, and the engine runs it once accepted", async () => {
    const world = await declared();
    const raised = await world.asked();
    expect(raised).toMatchObject({ kind: "proof_commands", risk: "medium" });
    const preview = (raised as unknown as { preview: string }).preview;
    expect(preview.split("\n")).toEqual([
      "- tests: pnpm test [in .; stops after 300 s; proves ENF-2]",
      "- audit: npm audit --audit-level=high [in .; stops after 300 s; proves ENF-3]",
      '- bench: node bench.mjs [in perf; stops after 60 s; proves ENF-1; measure read after "p95_ms="]',
    ]);
    const summary = (await world.projection()).checkpoints as Record<
      string,
      { summary: string; title: string }
    >;
    const point = summary[raised.checkpoint];
    expect(point?.summary).toContain("pnpm test");
    expect(point?.summary).toContain("npm audit --audit-level=high");
    expect(point?.summary).toContain("without a shell");
    expect(point?.title).toBe("Let the engine run 3 proof commands tests, audit, bench");
    // Nothing runs before the answer; then it does, once, for every line shown.
    await world.approve(raised.checkpoint);
    const view = await world.ran("tests");
    expect(view).toMatchObject({
      command: "tests",
      ok: true,
      exit: 0,
      seconds: 1.2,
      proved: ["ENF-2"],
      failed: [],
    });
    expect(world.runner.requests).toHaveLength(1);
    expect(world.runner.requests[0]).toMatchObject({
      line: "pnpm test",
      argv: ["pnpm", "test"],
      cwd: ".",
      timeoutMs: 300_000,
    });
    // The other lines were accepted by the same gesture.
    await world.ran("audit");
    expect((await world.ran("audit")).proved).toEqual(["ENF-3"]);
    // A second request has nothing new to ask.
    const again = await world.call("request_creator_action", {
      agent: "quentin",
      action: { kind: "proof_commands" },
      reason: "again",
    });
    expect(!again.ok && again.error.code).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
  });

  it("asks again for a line that changed, only for it", async () => {
    const world = await declared();
    await world.accept();
    await world.ran("tests");
    const changes: Array<[string, string, string]> = [
      ["run: pnpm test", "run: pnpm run test", "pnpm run test [in ."],
      ["proves: [ENF-2]", "proves: [ENF-2, ENF-3]", "proves ENF-2, ENF-3]"],
    ];
    for (const [from, to, shown] of changes) {
      world.files.seed(PROOFS_PATH, DECLARED.replace(from, to));
      expect((await world.refusal("tests")).details.reason).toContain("not_accepted:tests");
      const raised = await world.asked();
      const preview = (raised as unknown as { preview: string }).preview;
      expect(preview.split("\n")).toHaveLength(1);
      expect(preview).toContain(shown);
      // The creator turns it down for now: still refused, and the others still run.
      const rejected = await world.resolve(raised.checkpoint, {
        decision: "rejected",
        note: "not these lines",
      });
      expect(rejected.ok, JSON.stringify(rejected)).toBe(true);
      expect((await world.refusal("tests")).details.reason).toContain("refused_by_the_creator");
      await world.ran("audit");
      world.files.seed(PROOFS_PATH, DECLARED);
      // Back to the line the creator accepted: it runs again, without a question.
      await world.ran("tests");
    }
    expect(world.runner.requests.map((request) => request.line)).toEqual([
      "pnpm test",
      "npm audit --audit-level=high",
      "pnpm test",
      "npm audit --audit-level=high",
      "pnpm test",
    ]);
  });

  it("respects a refusal, and asks again only when it is named", async () => {
    const world = await declared();
    const raised = await world.asked();
    expect(await world.asked().catch((error: Error) => error.message)).toContain(
      "proof_request_open",
    );
    await world.resolve(raised.checkpoint, { decision: "rejected", note: "not these lines" });
    const refused = await world.refusal("tests");
    expect(refused.details.reason).toContain("refused_by_the_creator:tests");
    expect(world.runner.requests).toEqual([]);
    // Nothing new to ask: the refusal stands.
    const quiet = await world.call("request_creator_action", {
      agent: "quentin",
      action: { kind: "proof_commands" },
      reason: "again",
    });
    expect(!quiet.ok && quiet.error.code).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
    // Naming it is asking again, on the creator's word.
    await world.accept({ kind: "proof_commands", commands: ["tests"] });
    expect((await world.ran("tests")).ok).toBe(true);
    // A name the file does not hold is refused.
    const unknown = await world.call("request_creator_action", {
      agent: "quentin",
      action: { kind: "proof_commands", commands: ["ghost"] },
      reason: "x",
    });
    expect(unknown.ok).toBe(false);
  });

  it("never cuts a line the creator reads: as many as fit, the rest next", async () => {
    const long = (index: number) =>
      [
        `  - name: check${index}`,
        `    run: node scripts/check.mjs ${"--option-with-a-long-name=value".repeat(7)} ${index}`,
        "    proves: [ENF-2]",
      ].join("\n");
    const world = await declared(`commands:\n${[1, 2, 3, 4, 5, 6, 7, 8].map(long).join("\n")}\n`);
    const raised = await world.asked();
    const later = (raised as unknown as { later?: number }).later ?? 0;
    const preview = (raised as unknown as { preview: string }).preview.split("\n");
    expect(later).toBeGreaterThan(0);
    expect(preview.length + later).toBe(8);
    const state = (await world.projection()).checkpoints as Record<string, { summary: string }>;
    const summary = state[raised.checkpoint]?.summary ?? "";
    expect(summary.length).toBeLessThanOrEqual(2000);
    for (const line of preview) expect(summary).toContain(line);
    await world.approve(raised.checkpoint);
    // The rest is asked next, and the lines already accepted are not asked twice.
    const next = (await world.asked()) as unknown as { preview: string; later?: number };
    expect(next.preview).not.toContain("check1 ");
    expect(next.preview.split("\n").length + (next.later ?? 0)).toBe(8 - preview.length);
  });
});

describe("the engine inscribes the proof itself", () => {
  it("writes the proof with its run, marked as the engine's, and tells the agent the verdict only", async () => {
    const world = await declared();
    await world.accept();
    const view = await world.ran("tests");
    expect(Object.keys(view).sort()).toEqual([
      "command",
      "ended",
      "exit",
      "failed",
      "log",
      "ok",
      "proved",
      "seconds",
    ]);
    const proof = await world.proofOf("ENF-2");
    expect(proof).toMatchObject({
      kind: "test",
      result: "pass",
      source: "engine:tests",
      origin: "engine",
      run: { command: "tests", ended: "exit", exit: 0, ms: 1234, commit: COMMIT, clean: true },
    });
    const event = world.journal.events.at(-1);
    expect(event).toMatchObject({
      type: "requirement.proved",
      v: 2,
      actor: { kind: "agent", agent: "quentin" },
      payload: {
        requirement: "ENF-2",
        origin: "engine",
        commit: COMMIT,
        run: { command: "tests", exit: 0, summary: "Tests 12 passed" },
      },
    });
    const written = event?.payload as { run?: { fingerprint?: string } } | undefined;
    expect(written?.run?.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    // The register tells the difference: the engine's proofs, and those an agent reported.
    const register = ((await world.state()) as unknown as { requirements: Record<string, unknown> })
      .requirements;
    expect(register).toMatchObject({ proven: 1, engine: 1, reported: 0 });
    await world.run("record_proof", {
      agent: "quentin",
      requirement: "ENF-3",
      passed: true,
      source: "npm audit --audit-level=high",
    });
    expect(
      ((await world.state()) as unknown as { requirements: unknown }).requirements,
    ).toMatchObject({
      proven: 2,
      engine: 1,
      reported: 1,
    });
    expect((await world.proofOf("ENF-3"))?.origin).toBe("reported");
    // Only a command that proves something the engine can prove is run.
    expect(world.runner.requests).toHaveLength(1);
  });

  it("keeps the whole output in a local file, outside the journal, and a few files only", async () => {
    const world = await declared();
    await world.accept();
    world.runner.next = { head: "line one\n", tail: "line two\nTests  12 passed", omitted: 99 };
    const view = await world.ran("tests");
    expect(view.log).toMatch(new RegExp(`^${PROOF_RUNS_DIR}/tests-\\d{8}T\\d{6}Z\\.log$`));
    const text = await world.files.readText(view.log as string);
    expect(text).toContain("line: pnpm test");
    expect(text).toContain("line one");
    expect(text).toContain("99 bytes of output not kept");
    expect(text).toContain("Tests  12 passed");
    expect(JSON.stringify(world.journal.events)).not.toContain("line one");
    let last = view.log as string;
    for (let index = 0; index < 35; index += 1) last = (await world.ran("tests")).log as string;
    const kept = (await world.files.listFiles(PROOF_RUNS_DIR)).filter((file) =>
      file.endsWith(".log"),
    );
    expect(kept.length).toBeLessThanOrEqual(30);
    // The oldest go first: the file just written is always there, the first one is gone.
    expect(kept).toContain(last);
    expect(kept).not.toContain(view.log);
  });

  it("records a failure as a failed proof, a gap, with the lines that matter", async () => {
    const world = await declared();
    await world.accept();
    world.runner.next = {
      exit: 1,
      tail: [
        ...Array.from({ length: 300 }, (_, index) => `ok ${index}`),
        "FAIL src/signin.test.ts > refuses a bad password",
        "AssertionError: expected 401 to be 403",
        "Tests  1 failed | 300 passed",
      ].join("\n"),
    };
    const view = await world.ran("tests");
    expect(view).toMatchObject({
      ok: false,
      ended: "exit",
      exit: 1,
      proved: [],
      failed: ["ENF-2"],
    });
    expect(view.lines).toContain("AssertionError: expected 401 to be 403");
    expect(view.lines?.length).toBeLessThanOrEqual(12);
    expect(JSON.stringify(view).length).toBeLessThan(1500);
    expect(await world.proofOf("ENF-2")).toMatchObject({
      result: "fail",
      origin: "engine",
      run: { exit: 1 },
    });
    const register = ((await world.state()) as unknown as { requirements: { gaps: string[] } })
      .requirements;
    expect(register.gaps).toContain("ENF-2:failed:test");
  });

  it("makes a command that runs out of time, or never starts, an explicit failure, never a proof", async () => {
    const world = await declared();
    await world.accept();
    world.runner.next = { ended: "timeout", exit: null, ms: 300_000, tail: "still running" };
    const slow = await world.ran("tests");
    expect(slow).toMatchObject({
      ok: false,
      ended: "timeout",
      exit: null,
      failed: ["ENF-2"],
      proved: [],
    });
    expect(await world.proofOf("ENF-2")).toMatchObject({
      result: "fail",
      run: { ended: "timeout", exit: null },
      note: "tests failed: stopped after 300 s, its time limit",
    });
    world.runner.next = {
      ended: "error",
      exit: null,
      ms: 3,
      tail: "",
      detail: "spawn pnpm ENOENT",
    };
    const missing = await world.ran("tests");
    expect(missing).toMatchObject({ ok: false, ended: "error", failed: ["ENF-2"] });
    expect(await world.proofOf("ENF-2")).toMatchObject({
      result: "fail",
      note: "tests failed: could not be started: spawn pnpm ENOENT",
    });
  });

  it("decides a measure against the budget itself, from the number the command prints", async () => {
    const world = await declared();
    await world.accept();
    world.runner.next = { tail: "warmup p95_ms=900\nrun p95_ms=250.5" };
    expect(await world.ran("bench")).toMatchObject({ ok: true, proved: ["ENF-1"] });
    expect(await world.proofOf("ENF-1")).toMatchObject({
      kind: "measure",
      result: "pass",
      measured: 250.5,
      budget: { op: "max", value: 300 },
    });
    world.runner.next = { tail: "run p95_ms=450" };
    expect(await world.ran("bench")).toMatchObject({ ok: true, failed: ["ENF-1"] });
    expect(await world.proofOf("ENF-1")).toMatchObject({ result: "fail", measured: 450 });
    // A command that exits 0 without the number cannot prove a budget.
    world.runner.next = { tail: "done" };
    expect((await world.ran("bench")).failed).toEqual(["ENF-1"]);
    expect((await world.proofOf("ENF-1"))?.note).toContain('no number after "p95_ms="');
    // A bench that fails does not pass because of a good number.
    world.runner.next = { exit: 2, tail: "run p95_ms=10\nError: crashed" };
    expect((await world.ran("bench")).failed).toEqual(["ENF-1"]);
    expect(world.runner.requests.at(-1)).toMatchObject({ cwd: "perf", timeoutMs: 60_000 });
  });

  it("proves only what running can prove, and says what it skipped", async () => {
    const mixed = await declared(
      [
        "commands:",
        "  - name: all",
        "    run: pnpm check",
        "    proves: [ENF-2, ENF-3, ENF-4, AD-1, ENF-9]",
        "",
      ].join("\n"),
    );
    await mixed.accept();
    const view = await mixed.ran("all");
    // ENF-4 expects a review, AD-1 a measure with no number to read, ENF-9 is not in the register.
    expect(view.proved).toEqual(
      ["ENF-2", "ENF-3", "AD-1"].filter((id) => view.proved.includes(id)),
    );
    expect(view.skipped).toEqual(
      expect.arrayContaining(["ENF-4:review_comes_from_an_audit", "ENF-9:not_in_the_register"]),
    );
    // No test cites the requirement: the engine does not make a test proof out of an exit code.
    mixed.tests.lines = [];
    const only = await declared("commands:\n  - { name: t, run: pnpm test, proves: [ENF-2] }\n");
    only.tests.lines = [];
    await only.accept();
    expect((await only.refusal("t")).details.reason).toContain(
      "nothing_to_prove: ENF-2:no_test_cites_it",
    );
    expect(only.runner.requests).toEqual([]);
  });

  it("reports a copy with changes not committed", async () => {
    const world = await declared();
    await world.accept();
    world.runner.copy = { commit: COMMIT, clean: false };
    expect(await world.ran("tests")).toMatchObject({ unclean: true });
    expect(await world.proofOf("ENF-2")).toMatchObject({ run: { clean: false, commit: COMMIT } });
    world.runner.copy = {};
    const unknown = await world.ran("tests");
    expect(unknown.unclean).toBeUndefined();
    expect(world.journal.events.at(-1)?.payload).not.toHaveProperty("commit");
  });
});

describe("no secret reaches the journal nor the answer", () => {
  it("masks what the output shows, in the answer, the journal and the file", async () => {
    const world = await declared();
    await world.accept();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    world.runner.next = {
      exit: 1,
      head: `Using ${token}\n`,
      tail: "Error: login failed with password=hunter2\nAKIAABCDEFGHIJKLMNOP leaked\nFAIL signin",
    };
    const view = await world.ran("tests");
    const everything = [
      JSON.stringify(view),
      JSON.stringify(world.journal.events),
      await world.files.readText(view.log as string),
    ].join("\n");
    for (const secret of [token, "hunter2", "AKIAABCDEFGHIJKLMNOP"]) {
      expect(everything, secret).not.toContain(secret);
    }
    expect(everything).toContain("[secret]");
    expect(view.lines?.join("\n")).toContain("FAIL signin");
  });
});

describe("the release can demand the engine's own proofs", () => {
  const demand = { kind: "proof_commands", require: "engine" };

  it("asks the creator for the demand like any other gesture, and shows it", async () => {
    const world = await declared();
    const raised = await world.asked(demand);
    expect(raised).toMatchObject({ kind: "proof_commands", risk: "low" });
    const point = (
      (await world.projection()).checkpoints as Record<string, { title: string; summary: string }>
    )[raised.checkpoint];
    expect(point?.title).toBe("Demand proofs the engine produced itself at the release");
    expect(point?.summary).toContain("only a proof the engine ran or read itself counts");
    expect(
      ((await world.state()) as unknown as { requirements: { require?: string } }).requirements
        .require,
    ).toBeUndefined();
    await world.approve(raised.checkpoint);
    expect(
      ((await world.state()) as unknown as { requirements: { require?: string } }).requirements
        .require,
    ).toBe("engine");
    // The same demand is not asked twice; taking it back is a request too.
    const again = await world.call("request_creator_action", {
      agent: "quentin",
      action: demand,
      reason: "x",
    });
    expect(!again.ok && again.error.code).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
    await world.accept({ kind: "proof_commands", require: "any" });
    expect(
      ((await world.state()) as unknown as { requirements: { require?: string } }).requirements
        .require,
    ).toBeUndefined();
  });

  it("holds the release on a proof an agent reported, and lets the engine's through", async () => {
    const world = await declared();
    await world.accept();
    await world.accept(demand);
    // Reported by an agent: valid, but not what the creator demands.
    await world.run("record_proof", {
      agent: "quentin",
      requirement: "ENF-2",
      passed: true,
      source: "src/signin.test.ts:12",
    });
    const released = await world.releaseOf();
    const refused = await world.resolve(released.checkpoint, { decision: "approved" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe(ErrorCode.RELEASE_NOT_READY);
    expect(String(refused.error.details.requirements)).toContain("ENF-2:reported_only");
    expect(refused.error.details).toMatchObject({ engine: 0, reported: 1 });
    // The engine runs the command itself: the same requirement is now proven the way they asked.
    await world.ran("tests");
    const after = await world.resolve(released.checkpoint, { decision: "approved" });
    expect(!after.ok && String(after.error.details.requirements)).not.toContain("ENF-2");
    expect(!after.ok && after.error.details).toMatchObject({ engine: 1, reported: 0 });
    // And without the demand a reported proof counts, as before.
    const lax = await declared();
    await lax.run("record_proof", {
      agent: "quentin",
      requirement: "ENF-2",
      passed: true,
      source: "src/signin.test.ts:12",
    });
    expect(
      ((await lax.state()) as unknown as { requirements: { proven: number } }).requirements.proven,
    ).toBe(1);
  });

  it("shows the difference at the gate, in the refusal", async () => {
    const world = await declared();
    await world.accept();
    await world.ran("tests");
    await world.run("record_proof", {
      agent: "quentin",
      requirement: "ENF-3",
      passed: true,
      source: "npm audit",
    });
    const released = await world.releaseOf();
    const refused = await world.resolve(released.checkpoint, { decision: "approved" });
    expect(!refused.ok && refused.error.details).toMatchObject({ engine: 1, reported: 1 });
  });
});

describe("what the engine found stands against a word", () => {
  it("does not let a reported proof wipe out the failure of a run, until the engine runs again", async () => {
    const world = await declared();
    await world.accept();
    world.runner.next = { exit: 1, tail: "FAIL signin" };
    await world.ran("tests");
    const reported = await world.call("record_proof", {
      agent: "quentin",
      requirement: "ENF-2",
      passed: true,
      source: "src/signin.test.ts:12",
    });
    expect(!reported.ok && String(reported.error.details.reason)).toContain(
      "engine_failure_stands",
    );
    expect(await world.proofOf("ENF-2")).toMatchObject({ result: "fail", origin: "engine" });
    world.runner.next = {};
    await world.ran("tests");
    expect(await world.proofOf("ENF-2")).toMatchObject({ result: "pass", origin: "engine" });
  });

  it("leaves a requirement that expects a review outside the demand for the engine's proofs", async () => {
    const world = await declared();
    await world.accept({ kind: "proof_commands", require: "engine" });
    await world.run("submit_audit", {
      agent: "quentin",
      results: [
        {
          pillar: "accessibility",
          verdict: "pass",
          reads: ["src/ui/form.ts"],
          summary: "Every control is reachable by keyboard.",
          verified: ["ENF-4"],
        },
      ],
      findings: [],
    });
    const register = ((await world.state()) as unknown as { requirements: { gaps: string[] } })
      .requirements;
    expect(register.gaps.join(",")).not.toContain("ENF-4");
  });
});

describe("the journal does not believe an engine mark nothing earned", () => {
  it("ignores an engine proof for a command the creator never accepted, and a mark without its run", async () => {
    const world = await declared();
    const productId = world.journal.events[0]?.product as string;
    await world.accept();
    const register = (await world.projection()).requirements as {
      items: Record<string, { digest: string }>;
    };
    const digest = register.items["ENF-3"]?.digest as string;
    const run = {
      command: "audit",
      fingerprint: "a".repeat(24),
      ended: "exit",
      exit: 0,
      ms: 5,
      summary: "ok",
    };
    const base = {
      requirement: "ENF-3",
      kind: "analysis",
      result: "pass",
      source: "engine:audit",
      entry: digest,
    };
    const forge = (payload: Record<string, unknown>) =>
      world.journal.appendAll([
        {
          type: "requirement.proved",
          actor: { kind: "agent", agent: "omar" },
          product: productId,
          provenance: "trusted",
          payload,
        },
      ]);
    const forged = [
      ...(await forge({ ...base, origin: "engine", run })),
      ...(await forge({ ...base, origin: "engine" })),
      ...(await forge({ ...base, run })),
    ];
    const projection = await computeProjection(world.journal.events);
    expect(projection.ignored.map((entry) => entry.id).sort()).toEqual(
      forged.map((event) => event.id).sort(),
    );
    expect(await world.proofOf("ENF-3")).toBeNull();
    // The line the creator accepted is the one a run may carry.
    const accepted = (await world.projection()).checkpoints as Record<
      string,
      { creator_action?: { commands?: Array<{ name: string; fingerprint: string }> } }
    >;
    const fingerprint = Object.values(accepted)
      .flatMap((point) => point.creator_action?.commands ?? [])
      .find((command) => command.name === "audit")?.fingerprint as string;
    // The accepted line proves ENF-3 only: another requirement, or another name, is not covered.
    const other = (
      (await world.projection()).requirements as { items: Record<string, { digest: string }> }
    ).items["ENF-1"]?.digest as string;
    await forge({
      ...base,
      requirement: "ENF-1",
      kind: "measure",
      entry: other,
      origin: "engine",
      run: { ...run, fingerprint },
    });
    await forge({ ...base, origin: "engine", run: { ...run, fingerprint, command: "other" } });
    expect(await world.proofOf("ENF-1")).toBeNull();
    expect(await world.proofOf("ENF-3")).toBeNull();
    await forge({ ...base, origin: "engine", run: { ...run, fingerprint } });
    expect(await world.proofOf("ENF-3")).toMatchObject({ origin: "engine" });
  });

  it("replays to the same state", async () => {
    const world = await declared();
    await world.accept();
    await world.ran("tests");
    const first = JSON.stringify((await computeProjection(world.journal.events)).state);
    const second = JSON.stringify((await computeProjection([...world.journal.events])).state);
    expect(second).toBe(first);
    expect((await computeProjection(world.journal.events)).ignored).toEqual([]);
    const recorded = world.journal.events.at(-1) as unknown as RecordedEvent;
    expect(recorded.type).toBe("requirement.proved");
  });
});
