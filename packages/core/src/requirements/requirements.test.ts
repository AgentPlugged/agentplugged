import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { computeProjection, type RecordedEvent } from "../index.js";
import { ARCHITECTURE, OPTIONS, PRD, product, story } from "../testing/requirements-product.js";

/**
 * The audit of the non-functional requirements, end to end: the register read from the
 * documents, a proof written to the journal, a proof gone stale, the release point refused and then
 * opened by the creator's decision on each gap, and the audit of a pillar accepted and refused.
 */

const errorOf = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? undefined : (result.error as { code: string; details: Record<string, unknown> });

type Register = {
  total: number;
  proven: number;
  failed: number;
  unproven: number;
  settled: number;
  gaps: string[];
  audits?: Record<string, string>;
};
const registerOf = (view: unknown) => (view as { requirements: Register }).requirements;

const PROVE = {
  test: { requirement: "ENF-2", passed: true, source: "src/signin.test.ts:12" },
  analysis: { requirement: "ENF-3", passed: true, source: "npm audit --audit-level=high" },
  measure: (measured: number) => ({ requirement: "ENF-1", measured, source: "pnpm bench" }),
  replay: (measured: number) => ({ requirement: "AD-1", measured, source: "the replay benchmark" }),
};

/** An audit that finds the accessibility pillar tenable: the review proof of ENF-4. */
const ACCESSIBLE = {
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
};

describe("non-functional requirements and their proofs", () => {
  it("reads the register from the documents into the journal, and writes nothing twice", async () => {
    const { sync, state, journal, files } = await product();
    const first = await sync();
    expect(first.changed).toBe(true);
    expect(first.register).toMatchObject({ total: 5, proven: 0, failed: 0, unproven: 5 });
    expect(first.register?.gaps).toEqual([
      "AD-1:no_proof:measure",
      "ENF-1:no_proof:measure",
      "ENF-2:no_proof:test",
      "ENF-3:no_proof:analysis",
      "ENF-4:no_proof:review",
    ]);
    const events = journal.events.length;
    const second = await sync();
    expect(second.changed).toBe(false);
    expect(journal.events.length).toBe(events);
    // get_state carries the register in a bounded form.
    expect(registerOf(await state()).total).toBe(5);
    // A requirement the documents stop stating is told, never dropped in silence.
    files.seed(".agentplugged/docs/prd.md", PRD.replace(/- ENF-3:.*\n/, ""));
    const dropped = await sync();
    expect(dropped.removed).toEqual(["ENF-3"]);
    expect(dropped.register?.total).toBe(4);
  });

  it("records a proof with its source and its date, and refuses what is not a proof", async () => {
    const { sync, run, call, tests, state, journal } = await product();
    await sync();
    // A test that cites the requirement: found by the engine in the working copy.
    tests.lines = [
      { path: "src/signin.test.ts", line: 12, text: "it('ENF-2 refuses a bad password')" },
    ];
    const elsewhere = await call("record_proof", { ...PROVE.test, source: "src/other.test.ts:3" });
    expect(errorOf(elsewhere)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    const proof = (await run("record_proof", { agent: "quentin", ...PROVE.test })) as RecordedEvent;
    expect(proof.type).toBe("requirement.proved");
    // A command the project did not declare is not an analysis of this requirement.
    const foreign = await call("record_proof", { ...PROVE.analysis, source: "snyk test" });
    expect(errorOf(foreign)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    await run("record_proof", { agent: "quentin", ...PROVE.analysis });
    // A measure is compared with the budget by the engine, in the budget's unit.
    await run("record_proof", { agent: "quentin", ...PROVE.measure(450) });
    // A review proof is the audit's own: never typed in by hand.
    const byHand = await call("record_proof", {
      agent: "quentin",
      requirement: "ENF-4",
      passed: true,
      source: "I looked",
    });
    expect(errorOf(byHand)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    expect(String(errorOf(byHand)?.details.reason)).toContain("review_comes_from_an_audit");
    // A measure asks for its measure, the others for their result.
    expect(
      errorOf(
        await call("record_proof", { ...PROVE.measure(1), measured: undefined, passed: true }),
      ),
    ).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    const unknown = await call("record_proof", {
      agent: "quentin",
      ...PROVE.test,
      requirement: "ENF-99",
    });
    expect(errorOf(unknown)).toMatchObject({ code: ErrorCode.REQUIREMENT_NOT_FOUND });
    expect(registerOf(await state())).toMatchObject({ proven: 2, failed: 1, unproven: 2 });
    const stored = journal.events.find((event) => event.id === proof.id);
    expect(stored?.payload).toMatchObject({ requirement: "ENF-2", kind: "test", result: "pass" });
    expect(stored?.at).toBe(proof.at);
    const measured = journal.events.filter((event) => event.type === "requirement.proved").at(-1);
    expect(measured?.payload).toMatchObject({
      kind: "measure",
      result: "fail",
      measured: 450,
      budget: { op: "max", value: 300, unit: "ms" },
    });
  });

  it("no longer counts a proof older than the delivery of a story the requirement covers", async () => {
    const { sync, run, tests, deliver, state } = await product();
    await sync();
    tests.lines = [{ path: "src/signin.test.ts", line: 12, text: "// ENF-2" }];
    await run("record_proof", { agent: "quentin", ...PROVE.test });
    expect(registerOf(await state()).proven).toBe(1);
    // Story 1-2 cites ENF-2: delivering it after the proof makes the proof stale.
    await deliver("1-2");
    const after = registerOf(await state());
    expect(after.proven).toBe(0);
    expect(after.gaps).toContain("ENF-2:stale:test");
    // A fresh proof stands.
    await run("record_proof", { agent: "quentin", ...PROVE.test });
    expect(registerOf(await state()).proven).toBe(1);
  });

  it("refuses the release while a requirement has no valid proof, then opens it on the creator's decision on each gap", async () => {
    const { run, call, tests, resolve, releaseOf, decideGap, state } = await product();
    // Opening the release point reads the register itself.
    const release = await releaseOf();
    const refused = await resolve(release.checkpoint, { decision: "approved" });
    const error = errorOf(refused);
    expect(error).toMatchObject({
      code: ErrorCode.RELEASE_NOT_READY,
      details: { open: 5, failed: 0 },
    });
    expect(String(error?.details.requirements)).toContain("ENF-1:no_proof");
    // Proofs: ENF-2, ENF-3, the review of ENF-4; ENF-1 fails its budget; AD-1 stays without proof.
    tests.lines = [{ path: "src/signin.test.ts", line: 12, text: "// ENF-2" }];
    await run("record_proof", { agent: "quentin", ...PROVE.test });
    await run("record_proof", { agent: "quentin", ...PROVE.analysis });
    await run("record_proof", { agent: "quentin", ...PROVE.measure(450) });
    await run("submit_audit", ACCESSIBLE);
    const stillHeld = await resolve(release.checkpoint, { decision: "approved" });
    expect(errorOf(stillHeld)).toMatchObject({
      code: ErrorCode.RELEASE_NOT_READY,
      details: { open: 2, failed: 1 },
    });
    // The agent cannot settle a gap by itself: the point must be the creator's own answer.
    const unanswered = (await run("open_checkpoint", {
      agent: "omar",
      type: "decision",
      risk: "medium",
      title: "Gap on ENF-1",
      summary: "Over budget.",
      options: OPTIONS,
      recommendation: "fix",
    })) as RecordedEvent;
    const early = await call("settle_gap", {
      agent: "omar",
      requirement: "ENF-1",
      option: "accept",
      checkpoint: unanswered.checkpoint,
      reason: "Fine.",
    });
    expect(errorOf(early)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    // One gesture per gap. The creator accepts ENF-1, at a point that names both gaps.
    const both = await decideGap("ENF-1", "accept", "Gap on ENF-1 and AD-1");
    const accepted = (await run("settle_gap", {
      agent: "omar",
      requirement: "ENF-1",
      option: "accept",
      checkpoint: both,
      reason: "450 ms is fine for the beta, the creator said so.",
    })) as RecordedEvent;
    expect(accepted.type).toBe("requirement.gap_settled");
    expect(accepted.deferred).toBeUndefined();
    // That one gesture does not settle the second gap, whatever the point names.
    const reused = await call("settle_gap", {
      agent: "omar",
      requirement: "AD-1",
      option: "accept",
      checkpoint: both,
      reason: "Same.",
    });
    expect(String(errorOf(reused)?.details.reason)).toContain("point_already_used");
    // Nor can a point that names another requirement, or another option, settle it.
    const other = await decideGap("ENF-3", "accept");
    expect(
      String(
        errorOf(
          await call("settle_gap", {
            agent: "omar",
            requirement: "AD-1",
            option: "accept",
            checkpoint: other,
            reason: "x",
          }),
        )?.details.reason,
      ),
    ).toContain("point_title_does_not_name_AD-1");
    // Fix AD-1: a story is proposed, the gate stays shut.
    const fix = await decideGap("AD-1", "fix");
    const fixed = (await run("settle_gap", {
      agent: "omar",
      requirement: "AD-1",
      option: "fix",
      checkpoint: fix,
      reason: "Fix the replay time.",
    })) as RecordedEvent;
    expect(fixed.deferred).toMatch(/^D-/);
    const proposed = (await state()).deferred.open.find((item) => item.id === fixed.deferred);
    expect(proposed).toMatchObject({ owner: "creator", locks: [] });
    expect(proposed?.title).toContain("AD-1");
    const afterFix = await resolve(release.checkpoint, { decision: "approved" });
    expect(errorOf(afterFix)).toMatchObject({
      code: ErrorCode.RELEASE_NOT_READY,
      details: { open: 1 },
    });
    // Defer it to a version, at a new point: the gap is settled, the version is in the reason.
    const defer = await decideGap("AD-1", "defer");
    await run("settle_gap", {
      agent: "omar",
      requirement: "AD-1",
      option: "defer",
      checkpoint: defer,
      reason: "Version 1.1.",
    });
    // The creator can refuse the release at any time; only its approval was held.
    const approved = await resolve(release.checkpoint, { decision: "approved" });
    expect(approved.ok).toBe(true);
    expect(registerOf(await state())).toMatchObject({
      proven: 3,
      settled: 2,
      gaps: [],
    });
  });

  it("holds the release again when a failure is recorded after the creator accepted the risk", async () => {
    const { run, call, resolve, releaseOf, decideGap } = await product();
    const release = await releaseOf();
    await run("record_proof", { agent: "quentin", ...PROVE.measure(450) });
    const point = await decideGap("ENF-1", "accept");
    await run("settle_gap", {
      agent: "omar",
      requirement: "ENF-1",
      option: "accept",
      checkpoint: point,
      reason: "For the beta.",
    });
    // A new failing measure reopens the gap; the old point cannot settle it again.
    await run("record_proof", { agent: "quentin", ...PROVE.measure(520) });
    const again = await call("settle_gap", {
      agent: "omar",
      requirement: "ENF-1",
      option: "accept",
      checkpoint: point,
      reason: "Still.",
    });
    expect(String(errorOf(again)?.details.reason)).toMatch(/point_already_used|point_older/);
    const held = await resolve(release.checkpoint, { decision: "approved" });
    expect(String(errorOf(held)?.details.requirements)).toContain("ENF-1:failed");
    // The creator can still refuse it.
    expect((await resolve(release.checkpoint, { decision: "rejected", note: "Not yet." })).ok).toBe(
      true,
    );
  });

  it("opens the release at once when every requirement is proven", async () => {
    const { run, resolve, tests, releaseOf } = await product();
    tests.lines = [{ path: "src/signin.test.ts", line: 12, text: "// ENF-2" }];
    await run("sync_requirements", { agent: "quentin" });
    await run("record_proof", { agent: "quentin", ...PROVE.test });
    await run("record_proof", { agent: "quentin", ...PROVE.analysis });
    await run("record_proof", { agent: "quentin", ...PROVE.measure(120) });
    await run("record_proof", { agent: "quentin", ...PROVE.replay(1.4) });
    await run("submit_audit", ACCESSIBLE);
    const release = await releaseOf();
    const approved = await resolve(release.checkpoint, { decision: "approved" });
    expect(approved.ok).toBe(true);
  });

  it("is not stopped by a project that states no requirement", async () => {
    const { files, resolve, releaseOf, sync } = await product();
    files.seed(
      ".agentplugged/docs/prd.md",
      PRD.split("\n")
        .filter((line) => !line.includes("ENF-"))
        .join("\n"),
    );
    files.seed(".agentplugged/docs/architecture.md", ARCHITECTURE.replace("under 2 s", "fast"));
    expect((await sync()).register).toBeNull();
    const release = await releaseOf();
    expect((await resolve(release.checkpoint, { decision: "approved" })).ok).toBe(true);
  });

  it("keeps a proof while the requirement is the same, and drops it when the requirement changes", async () => {
    const { run, files, sync } = await product();
    await sync();
    await run("record_proof", { agent: "quentin", ...PROVE.analysis });
    files.seed(".agentplugged/stories/1-3-new.md", story("1-3", ["ENF-3"]));
    const moved = await sync();
    expect(moved.changed).toBe(true);
    expect(moved.register).toMatchObject({ proven: 1 });
    files.seed(
      ".agentplugged/docs/prd.md",
      PRD.replace("No known vulnerability", "No high vulnerability"),
    );
    const edited = await sync();
    expect(edited.register).toMatchObject({ proven: 0 });
    expect(edited.register?.gaps).toContain("ENF-3:no_proof:analysis");
  });
});

describe("the projection of the register", () => {
  it("replays to the same state, and ignores a gap the creator did not decide and a proof for an older wording", async () => {
    const { journal, sync, run, deliver } = await product();
    await sync();
    const productId = journal.events[0]?.product as string;
    const open = (await run("open_checkpoint", {
      agent: "omar",
      type: "decision",
      risk: "medium",
      title: "Gap on ENF-1",
      summary: "No proof.",
      options: OPTIONS,
      recommendation: "fix",
    })) as RecordedEvent;
    const forged = await journal.appendAll([
      {
        type: "requirement.gap_settled",
        actor: { kind: "agent", agent: "omar" },
        product: productId,
        provenance: "trusted",
        payload: {
          requirement: "ENF-1",
          decision: "accept",
          reason: "x",
          checkpoint: open.checkpoint,
        },
      },
      {
        type: "requirement.proved",
        actor: { kind: "agent", agent: "omar" },
        product: productId,
        provenance: "trusted",
        payload: {
          requirement: "ENF-3",
          kind: "analysis",
          result: "pass",
          source: "npm audit",
          entry: "ffffffffffff",
        },
      },
    ]);
    const projection = await computeProjection(journal.events);
    expect(projection.ignored.map((entry) => entry.id)).toEqual(
      forged.map((event) => event.id).sort(),
    );
    const register = projection.state.requirements as {
      items: Record<string, { gap: unknown; proved: unknown }>;
    };
    expect(register.items["ENF-1"]?.gap).toBeNull();
    expect(register.items["ENF-3"]?.proved).toBeNull();
    // A delivery writes nothing into the register: staleness is computed from the journal, so a
    // replay always gives the same answer.
    const before = JSON.stringify(projection.state.requirements);
    await deliver("1-1");
    expect(JSON.stringify((await computeProjection(journal.events)).state.requirements)).toBe(
      before,
    );
  });
});

describe("the audit by pillar", () => {
  const report = (extra: Record<string, unknown> = {}) => ({
    agent: "quentin",
    results: [
      {
        pillar: "performance",
        verdict: "issues",
        reads: ["src/page.ts", "src/db.ts"],
        summary: "One slow query.",
      },
      ...ACCESSIBLE.results,
    ],
    findings: [
      {
        pillar: "performance",
        severity: "should_fix",
        where: "src/db.ts:44",
        what: "The page query reads the whole table.",
        fix: "Add an index on the sign-in date.",
        requirement: "ENF-1",
        action: "gap",
      },
      {
        pillar: "performance",
        severity: "minor",
        where: "src/page.ts",
        what: "The image is not compressed.",
        action: "story",
      },
    ],
    ...extra,
  });

  it("accepts a whole report: a proof for what held, a failed proof for a gap, a story proposed once", async () => {
    const { run, sync, state } = await product();
    await sync();
    const recorded = (await run("submit_audit", report())) as RecordedEvent;
    expect(recorded.type).toBe("audit.reported");
    expect(recorded.deferred).toMatch(/^D-/);
    expect(registerOf(await state())).toMatchObject({
      proven: 1,
      failed: 1,
      audits: { performance: "issues", accessibility: "pass" },
    });
    const titles = (await state()).deferred.open.map((item) => item.title);
    expect(titles).toEqual(["[audit performance] The image is not compressed."]);
    // The same audit run again proposes nothing twice.
    const again = (await run("submit_audit", report())) as RecordedEvent;
    expect(again.deferred).toBeUndefined();
    expect((await state()).deferred.open).toHaveLength(1);
  });

  it("refuses a report that is not whole, with the list of what is missing, writing nothing", async () => {
    const { call, sync, journal } = await product();
    await sync();
    const events = journal.events.length;
    const refused = await call(
      "submit_audit",
      report({
        results: [
          {
            pillar: "performance",
            verdict: "issues",
            reads: [],
            summary: "Read.",
            verified: ["ENF-9", "ENF-2"],
          },
        ],
        findings: [],
      }),
    );
    const error = errorOf(refused);
    expect(error).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    const reason = String(error?.details.reason);
    expect(reason).toContain("reads_missing:performance");
    expect(reason).toContain("verified_unknown:performance:ENF-9");
    expect(reason).toContain("verified_not_a_review_proof:ENF-2:test");
    expect(reason).toContain("verified_needs_a_pass_with_reads:performance");
    expect(reason).toContain("issues_without_finding:performance");
    expect(journal.events.length).toBe(events);
  });

  it("refuses an audit that reads more than 40 files of a pillar", async () => {
    const { call, sync } = await product();
    await sync();
    const refused = await call(
      "submit_audit",
      report({
        results: [
          {
            pillar: "quality",
            verdict: "pass",
            reads: Array.from({ length: 41 }, (_, index) => `src/file${index}.ts`),
            summary: "Read everything.",
          },
        ],
        findings: [],
      }),
    );
    expect(String(errorOf(refused)?.details.reason)).toContain("reads_too_many:quality:41");
  });

  it("refuses a gap on a requirement the register does not hold, and tells to read the register first", async () => {
    const { call } = await product();
    const refused = await call("submit_audit", report());
    expect(errorOf(refused)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    expect(String(errorOf(refused)?.details.reason)).toContain("requirement_unknown");
    expect(String(errorOf(refused)?.details.reason)).toContain("measure.requirements");
  });

  it("makes a failed audit finding a gap for the release gate", async () => {
    const { run, sync, resolve, releaseOf, tests } = await product();
    await sync();
    tests.lines = [{ path: "src/signin.test.ts", line: 12, text: "// ENF-2" }];
    await run("record_proof", { agent: "quentin", ...PROVE.test });
    await run("record_proof", { agent: "quentin", ...PROVE.analysis });
    await run("record_proof", { agent: "quentin", ...PROVE.measure(120) });
    await run("record_proof", { agent: "quentin", ...PROVE.replay(1.4) });
    await run("submit_audit", ACCESSIBLE);
    await run("submit_audit", {
      agent: "quentin",
      results: [
        { pillar: "performance", verdict: "issues", reads: ["src/db.ts"], summary: "Slow." },
      ],
      findings: [
        {
          pillar: "performance",
          severity: "blocking",
          where: "src/db.ts:44",
          what: "A full scan on every page.",
          fix: "Index it.",
          requirement: "ENF-1",
          action: "gap",
        },
      ],
    });
    const release = await releaseOf();
    const held = await resolve(release.checkpoint, { decision: "approved" });
    expect(errorOf(held)).toMatchObject({
      code: ErrorCode.RELEASE_NOT_READY,
      details: { open: 1, failed: 1 },
    });
  });
});
