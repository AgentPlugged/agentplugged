import { sha256Hex } from "@agentplugged/crypto";
import { ErrorCode, QA_PROOF_DIR, qaProofBelongs } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { criteriaTrace } from "../criteria/criterion-trace.js";
import {
  type CreatorActionRequested,
  computeProjection,
  type ProofRunner,
  type ProofRunRequest,
  type ProofRunResult,
  type StoryState,
  type WorkingCopy,
} from "../index.js";
import { PROOFS_PATH } from "../proofs/proof-declaration.js";
import { stackEntriesOf } from "../review/review-rules.js";
import { walkCriteria, walkthrough, walkthroughText } from "../review/review-walkthrough.js";
import { product } from "../testing/requirements-product.js";
import type { QaView } from "./qa-command.js";
import { qaStackEntries, qaTraceOf, reportProblems, safeObserved } from "./qa-rules.js";

/**
 * The acceptance QA in a browser, end to end: the closed report an agent gives, the
 * proofs the engine fingerprints, the scenarios it plays itself with the command the creator
 * accepted under the name `browser-qa`, and what reaches the review. The browser is simulated: the runner
 * writes the files a Playwright run would leave, and the host's pilot is the test itself.
 */

const COMMIT = "c".repeat(40);
const WORKTREE = "../shop.worktrees/1-3";
const DIR = QA_PROOF_DIR;

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
  "  - name: browser-qa",
  "    run: npx playwright test -c qa.config.ts --grep {criterion}",
  "    timeout: 300",
  "",
].join("\n");

/** A runner that plays nothing: it writes the files a browser run leaves, and answers what the test says. */
class QaRunner implements ProofRunner {
  readonly requests: ProofRunRequest[] = [];
  copy: WorkingCopy = { commit: COMMIT, clean: true };
  queue: Array<Partial<ProofRunResult>> = [];
  /** What each run leaves in the proofs folder, in the order of the runs. */
  leaves: Array<Array<[string, Uint8Array]>> = [];
  write: (path: string, bytes: Uint8Array) => void = () => undefined;
  async workingCopy(): Promise<WorkingCopy> {
    return this.copy;
  }
  async run(request: ProofRunRequest): Promise<ProofRunResult> {
    this.requests.push(request);
    for (const [path, bytes] of this.leaves.shift() ?? []) this.write(path, bytes);
    return {
      ended: "exit",
      exit: 0,
      ms: 900,
      head: "",
      tail: "1 passed",
      omitted: 0,
      ...this.queue.shift(),
    };
  }
}

const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
const png = (text: string) => bytes(`\u0089PNG ${text}`);
const webm = (text: string) => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...bytes(text)]);

async function world(options: { declared?: boolean } = {}) {
  const runner = new QaRunner();
  const base = await product({ proofRunner: runner });
  runner.write = (path, content) => base.files.seedBytes(path, content);
  base.files.seed(".agentplugged/stories/1-3-cart.md", STORY);
  base.files.seed(PROOFS_PATH, options.declared === false ? "commands: []\n" : DECLARED);
  const productId = base.journal.events[0]?.product as string;
  const header = { product: productId, provenance: "trusted", story: "1-3" } as const;
  await base.journal.appendAll([
    {
      type: "story.started",
      actor: { kind: "agent", agent: "sam" },
      ...header,
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
    const raised = (await base.run("request_creator_action", {
      agent: "quentin",
      action: { kind: "proof_commands" },
      reason: "the creator wants the engine to play the scenarios of the QA",
    })) as unknown as CreatorActionRequested;
    await base.approve(raised.checkpoint);
  };
  const qa = (check: Record<string, unknown>, agent = "quentin") =>
    base.call("acceptance_qa", { agent, story: "1-3", check });
  const recorded = async (check: Record<string, unknown>) => {
    const result = await qa(check);
    if (!result.ok) throw new Error(`${result.error.code} ${JSON.stringify(result.error.details)}`);
    return result.value as unknown as QaView;
  };
  const refused = async (check: Record<string, unknown>, agent = "quentin") => {
    const result = await qa(check, agent);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    return String(result.error.details.reason);
  };
  const story = async () =>
    ((await computeProjection(base.journal.events)).state.stories as Record<string, StoryState>)[
      "1-3"
    ] as StoryState;
  return { ...base, runner, accept, qa, recorded, refused, story, header };
}

const OUTSIDE_3 = [{ criterion: 3, reason: "a sound cannot be seen in a page" }];

describe("the report is closed, and the engine checks it", () => {
  it("records, per criterion, the verdict, the paths and the fingerprints of the proofs", async () => {
    const w = await world();
    const shot = png("empty cart");
    const video = webm("webm video");
    w.files.seedBytes(`${DIR}/AC-1-3-1-empty.png`, shot);
    w.files.seedBytes(`${DIR}/AC-1-3-1-empty.webm`, video);
    w.files.seedBytes(`${DIR}/ac-1-3-2/test-failed-1.png`, png("two items"));
    const view = await w.recorded({
      scenarios: [
        {
          criterion: 1,
          verdict: "passed",
          proofs: [`${DIR}/AC-1-3-1-empty.png`, `${DIR}/AC-1-3-1-empty.webm`],
        },
        {
          criterion: 2,
          verdict: "failed",
          proofs: [`${DIR}/ac-1-3-2/test-failed-1.png`],
          observed: "The total shows one item instead of two",
        },
      ],
      outside: OUTSIDE_3,
    });
    expect(view.line).toBe("passed 1, failed 1, blocked 0, outside 1");
    expect(view.no_proof).toEqual([]);
    const event = w.journal.events.filter((entry) => entry.type === "story.qa_reported");
    expect(event).toHaveLength(1);
    expect(event[0]?.payload).toMatchObject({
      commit: COMMIT,
      clean: true,
      results: [
        {
          criterion: 1,
          verdict: "passed",
          origin: "reported",
          proofs: [
            {
              path: `${DIR}/AC-1-3-1-empty.png`,
              kind: "screenshot",
              bytes: shot.length,
              sha256: sha256Hex(shot),
            },
            { path: `${DIR}/AC-1-3-1-empty.webm`, kind: "video", sha256: sha256Hex(video) },
          ],
        },
        { criterion: 2, verdict: "failed", observed: "The total shows one item instead of two" },
      ],
      outside: [{ criterion: 3, reason: "a sound cannot be seen in a page" }],
    });
    // The proofs stay in files outside the journal: none of their bytes is in it.
    expect(JSON.stringify(w.journal.events)).not.toContain("empty cart");
    const state = (await w.story()).qa;
    expect(state?.results["1"]?.verdict).toBe("passed");
    expect(state?.outside["3"]).toContain("sound");
  });

  it("never calls a scenario passed when no proof file exists", async () => {
    const w = await world();
    const view = await w.recorded({
      scenarios: [
        { criterion: 1, verdict: "passed", proofs: [`${DIR}/AC-1-3-1-missing.png`] },
        { criterion: 2, verdict: "passed" },
      ],
      outside: OUTSIDE_3,
    });
    expect(view.no_proof).toEqual([1, 2]);
    expect(view.line).toBe("passed 0, failed 0, blocked 2, outside 1");
    const state = (await w.story()).qa;
    expect(state?.results["1"]).toMatchObject({ verdict: "blocked", proofs: [] });
    expect(state?.results["2"]?.observed).toContain("no_proof");
  });

  it("refuses a report that is not whole, repeats a criterion, or names one the story lacks", async () => {
    const w = await world();
    const ok = { criterion: 1, verdict: "blocked", observed: "the app was down" };
    expect(await w.refused({ scenarios: [ok] })).toContain("not_whole: criteria 2,3");
    expect(
      await w.refused({
        scenarios: [ok, ok],
        outside: [...OUTSIDE_3, { criterion: 2, reason: "none" }],
      }),
    ).toContain("listed_twice:1");
    expect(await w.refused({ scenarios: [{ ...ok, criterion: 4 }], outside: [] })).toContain(
      "unknown_criterion:4 (the story lists 3)",
    );
    expect(w.journal.events.some((entry) => entry.type === "story.qa_reported")).toBe(false);
  });

  it("refuses a failure without what was observed, a proof of another criterion, and a mixed scenario", async () => {
    const w = await world();
    const reason = await w.refused({
      scenarios: [
        { criterion: 1, verdict: "failed" },
        { criterion: 2, verdict: "passed", proofs: [`${DIR}/AC-1-3-1-empty.png`] },
        { criterion: 3, run: true, verdict: "passed" },
      ],
    });
    expect(reason).toContain("1: failed needs `observed`");
    expect(reason).toContain(`2: ${DIR}/AC-1-3-1-empty.png does not carry AC-1-3-2`);
    expect(reason).toContain("3: run:true gives nothing else");
  });

  it("refuses a proof outside the proofs folder, climbing out of it, oddly named, or neither image nor video", async () => {
    const w = await world();
    const rest = [{ criterion: 2, reason: "none" }, ...OUTSIDE_3];
    for (const path of [
      "src/AC-1-3-1.png",
      `${DIR}/../AC-1-3-1.png`,
      `${DIR}/AC-1-3-1.exe`,
      `${DIR}/AC-1-3-1 shot.png`,
      `${DIR}/AC-1-3-1;rm.png`,
    ]) {
      const result = await w.qa({
        scenarios: [{ criterion: 1, verdict: "passed", proofs: [path] }],
        outside: rest,
      });
      expect(result.ok, path).toBe(false);
      if (!result.ok) expect(JSON.stringify(result.error.details), path).toContain("expected");
    }
    expect(w.journal.events.some((entry) => entry.type === "story.qa_reported")).toBe(false);
  });

  it("does not take any bytes for a screenshot, nor a link for a file", async () => {
    const w = await world();
    w.files.seedBytes(`${DIR}/AC-1-3-1-a.png`, bytes("just text, not a PNG"));
    w.files.seedBytes(`${DIR}/AC-1-3-1-b.webm`, bytes("not a video"));
    w.files.seedBytes(`${DIR}/AC-1-3-1-c.png`, png("a real one, as a link"));
    w.files.seedBytes(`${DIR}/AC-1-3-2-ok.png`, png("fine"));
    Object.assign(w.files, {
      isSymbolicLink: async (path: string) => path.endsWith("AC-1-3-1-c.png"),
    });
    w.files.seedBytes(`${DIR}/AC-1-3-2-empty.png`, new Uint8Array());
    const view = await w.recorded({
      scenarios: [
        {
          criterion: 1,
          verdict: "passed",
          proofs: [`${DIR}/AC-1-3-1-a.png`, `${DIR}/AC-1-3-1-b.webm`, `${DIR}/AC-1-3-1-c.png`],
        },
        {
          criterion: 2,
          verdict: "passed",
          proofs: [`${DIR}/AC-1-3-2-ok.png`, `${DIR}/AC-1-3-2-empty.png`],
        },
      ],
      outside: OUTSIDE_3,
    });
    expect(view.no_proof).toEqual([1]);
    const results = (await w.story()).qa?.results;
    expect(results?.["1"]).toMatchObject({ verdict: "blocked", proofs: [] });
    expect(results?.["2"]?.proofs.map((proof) => proof.path)).toEqual([`${DIR}/AC-1-3-2-ok.png`]);
  });

  it("is never the developer's: the QA is independent of the builder", async () => {
    const w = await world();
    const reason = await w.refused(
      { scenarios: [{ criterion: 1, verdict: "blocked", observed: "x" }] },
      "sam",
    );
    expect(reason).toContain("builder");
  });

  it("keeps a page's words as data: tags and control characters never reach the journal", () => {
    const dirty = `<script>alert(1)</script> Total is 1${String.fromCharCode(0, 0x202e)}`;
    expect(safeObserved(dirty)).toBe("script alert(1) /script Total is 1");
    expect(safeObserved("<>")).toBe("no readable detail");
    expect(safeObserved("x".repeat(400))).toHaveLength(300);
    // A cut never splits an emoji (the journal refuses half of one).
    const cut = safeObserved(`${"x".repeat(299)}😀😀`);
    expect(cut.endsWith("…")).toBe(true);
    expect(() => encodeURIComponent(cut)).not.toThrow();
  });

  it("replaces a report whole with the next one", async () => {
    const w = await world();
    const blocked = { criterion: 1, verdict: "blocked", observed: "down" };
    await w.recorded({
      scenarios: [blocked],
      outside: [...OUTSIDE_3, { criterion: 2, reason: "none" }],
    });
    await w.recorded({
      scenarios: [{ ...blocked, criterion: 2 }],
      outside: [...OUTSIDE_3, { criterion: 1, reason: "none" }],
    });
    const qa = (await w.story()).qa;
    expect(Object.keys(qa?.results ?? {})).toEqual(["2"]);
  });
});

describe("the engine plays the scenarios with the accepted command", () => {
  const scenarios = [1, 2].map((criterion) => ({ criterion, run: true }));

  it("refuses to play what the creator did not accept, and runs nothing", async () => {
    const w = await world();
    const reason = await w.refused({ scenarios, outside: OUTSIDE_3 });
    expect(reason).toContain("not_accepted:browser-qa");
    expect(w.runner.requests).toEqual([]);
  });

  it("says what to declare when nothing is", async () => {
    const w = await world({ declared: false });
    expect(await w.refused({ scenarios, outside: OUTSIDE_3 })).toContain("no_command_to_run");
  });

  it("plays each criterion in the story's working copy and reads the verdict from the exit code", async () => {
    const w = await world();
    await w.accept();
    w.runner.leaves = [
      [
        [`${DIR}/ac-1-3-1-empty-cart-chromium/video.webm`, webm("v1")],
        [`${DIR}/ac-1-3-1-empty-cart-chromium/shot.png`, png("1")],
      ],
      [[`${DIR}/ac-1-3-2-two-items-chromium/test-failed-1.png`, png("2")]],
    ];
    w.runner.queue = [{}, { exit: 1, tail: "Error: expected total 2 but got 1\n1 failed" }];
    const view = await w.recorded({ scenarios, outside: OUTSIDE_3 });
    expect(view.line).toBe("passed 1, failed 1, blocked 0, outside 1");
    expect(w.runner.requests.map((request) => request.line)).toEqual([
      "npx playwright test -c qa.config.ts --grep AC-1-3-1",
      "npx playwright test -c qa.config.ts --grep AC-1-3-2",
    ]);
    expect(w.runner.requests[0]).toMatchObject({ workspace: WORKTREE, timeoutMs: 300_000 });
    const results = (await w.story()).qa?.results;
    expect(results?.["1"]).toMatchObject({ verdict: "passed", origin: "engine" });
    expect(results?.["1"]?.proofs.map((proof) => proof.kind)).toEqual(["screenshot", "video"]);
    expect(results?.["2"]?.verdict).toBe("failed");
    expect(results?.["2"]?.observed).toMatch(/^test output: .*expected total 2 but got 1/);
    expect(
      w.journal.events.find((entry) => entry.type === "story.qa_reported")?.payload,
    ).toMatchObject({
      results: [
        { run: { command: "browser-qa", exit: 0 } },
        { run: { command: "browser-qa", exit: 1 } },
      ],
    });
  });

  it("does not take a file left by an earlier run for this run's proof", async () => {
    const w = await world();
    await w.accept();
    w.files.seedBytes(`${DIR}/ac-1-3-1-old/video.webm`, webm("yesterday"));
    const view = await w.recorded({
      scenarios: [{ criterion: 1, run: true }],
      outside: [{ criterion: 2, reason: "none" }, ...OUTSIDE_3],
    });
    expect(view.no_proof).toEqual([1]);
    expect((await w.story()).qa?.results["1"]).toMatchObject({ verdict: "blocked", proofs: [] });
    // The old file was cleared before the run: it is gone, not counted.
    expect(w.files.removals).toContain(`${DIR}/ac-1-3-1-old/video.webm`);
    // A file the run writes is a proof.
    w.runner.leaves = [[[`${DIR}/ac-1-3-1-old/video.webm`, webm("today")]]];
    await w.recorded({
      scenarios: [{ criterion: 1, run: true }],
      outside: [{ criterion: 2, reason: "none" }, ...OUTSIDE_3],
    });
    expect((await w.story()).qa?.results["1"]).toMatchObject({ verdict: "passed" });
  });

  it("plays again the same way: an identical capture is a proof of this run", async () => {
    const w = await world();
    await w.accept();
    const again = {
      scenarios: [{ criterion: 1, run: true }],
      outside: [{ criterion: 2, reason: "none" }, ...OUTSIDE_3],
    };
    for (let run = 0; run < 2; run++) {
      w.runner.leaves = [[[`${DIR}/ac-1-3-1-same/shot.png`, png("the same bytes")]]];
      await w.recorded(again);
      expect((await w.story()).qa?.results["1"]).toMatchObject({ verdict: "passed" });
    }
  });

  it("does not give criterion 2 the proofs of criterion 21, nor of another story", async () => {
    expect(qaProofBelongs(`${DIR}/ac-1-3-21-x/shot.png`, "AC-1-3-2")).toBe(false);
    expect(qaProofBelongs(`${DIR}/AC-1-3-2.png`, "AC-1-3-2")).toBe(true);
    expect(qaProofBelongs(`${DIR}/AC_1_3_2-step.png`, "AC-1-3-2")).toBe(true);
    expect(qaProofBelongs(`${DIR}/ac-11-3-2.png`, "AC-1-3-2")).toBe(false);
    expect(qaProofBelongs("elsewhere/AC-1-3-2.png", "AC-1-3-2")).toBe(false);
  });

  it("records a run stopped at its time limit as blocked, never as failed", async () => {
    const w = await world();
    await w.accept();
    w.runner.queue = [{ ended: "timeout", exit: null }];
    await w.recorded({
      scenarios: [{ criterion: 1, run: true }],
      outside: [{ criterion: 2, reason: "none" }, ...OUTSIDE_3],
    });
    expect((await w.story()).qa?.results["1"]).toMatchObject({
      verdict: "blocked",
      observed: "stopped at its time limit",
    });
  });

  it("reads the line the skill tells to declare as a plain program, with the criterion in two places", async () => {
    const w = await world();
    w.files.seed(
      PROOFS_PATH,
      [
        "commands:",
        "  - name: browser-qa",
        '    run: npx playwright test -c playwright.qa.config.ts --grep "{criterion} " --output ../../shop/.agentplugged/.cache/qa/{criterion}',
        "",
      ].join("\n"),
    );
    await w.accept();
    w.runner.leaves = [[[`${DIR}/AC-1-3-2/video.webm`, webm("v")]]];
    await w.recorded({
      scenarios: [{ criterion: 2, run: true }],
      outside: [{ criterion: 1, reason: "none" }, ...OUTSIDE_3],
    });
    expect(w.runner.requests[0]?.argv).toEqual([
      "npx",
      "playwright",
      "test",
      "-c",
      "playwright.qa.config.ts",
      "--grep",
      "AC-1-3-2 ",
      "--output",
      "../../shop/.agentplugged/.cache/qa/AC-1-3-2",
    ]);
    expect((await w.story()).qa?.results["2"]?.proofs[0]?.path).toBe(`${DIR}/AC-1-3-2/video.webm`);
  });

  it("keeps the command named browser-qa out of the tests of the cycle of a criterion", async () => {
    const w = await world();
    w.files.seed(
      PROOFS_PATH,
      [
        "commands:",
        "  - name: browser-qa",
        "    run: npx playwright test --grep {criterion}",
        "",
      ].join("\n"),
    );
    await w.accept();
    const result = await w.call("record_criterion", { agent: "sam", story: "1-3", criterion: 1 });
    expect(result.ok).toBe(false);
    expect(w.runner.requests).toEqual([]);
  });
});

describe("a forged report changes nothing (the reducer)", () => {
  it("ignores a report written by the developer, or a verdict that the run contradicts", async () => {
    const w = await world();
    const proof = {
      path: `${DIR}/AC-1-3-1.png`,
      kind: "screenshot",
      bytes: 3,
      sha256: "a".repeat(64),
    };
    const forged = (agent: string, result: Record<string, unknown>) => ({
      type: "story.qa_reported",
      actor: { kind: "agent" as const, agent },
      ...w.header,
      payload: {
        results: [{ criterion: 1, origin: "reported", proofs: [proof], ...result }],
        outside: [],
      },
    });
    await w.journal.appendAll([forged("sam", { verdict: "passed" })]);
    expect((await w.story()).qa).toBeUndefined();
    // A proof of another criterion.
    await w.journal.appendAll([
      forged("quentin", { verdict: "passed", proofs: [{ ...proof, path: `${DIR}/AC-1-3-2.png` }] }),
    ]);
    expect((await w.story()).qa).toBeUndefined();
    // The engine's run, but of a command nobody accepted.
    await w.journal.appendAll([
      forged("quentin", {
        verdict: "passed",
        origin: "engine",
        run: {
          command: "browser-qa",
          fingerprint: "b".repeat(24),
          ended: "exit",
          exit: 0,
          ms: 1,
          summary: "ok",
        },
      }),
    ]);
    expect((await w.story()).qa).toBeUndefined();
    await w.journal.appendAll([forged("quentin", { verdict: "passed" })]);
    expect((await w.story()).qa?.results["1"]?.verdict).toBe("passed");
  });

  it("refuses a passed result with no proof at the door of the journal", async () => {
    const w = await world();
    await expect(
      w.journal.appendAll([
        {
          type: "story.qa_reported",
          actor: { kind: "agent" as const, agent: "quentin" },
          ...w.header,
          payload: {
            results: [{ criterion: 1, verdict: "passed", origin: "reported", proofs: [] }],
            outside: [],
          },
        },
      ]),
    ).rejects.toThrow();
  });
});

describe("what reaches the review", () => {
  it("lists the proofs in the walk through the change, and a failure as a blocking finding", async () => {
    const w = await world();
    w.files.seedBytes(`${DIR}/AC-1-3-1-empty.png`, png("a"));
    await w.recorded({
      scenarios: [
        { criterion: 1, verdict: "passed", proofs: [`${DIR}/AC-1-3-1-empty.png`] },
        { criterion: 2, verdict: "failed", observed: "One item paid instead of two" },
      ],
      outside: OUTSIDE_3,
    });
    const state = (await computeProjection(w.journal.events)).state;
    const trace = await criteriaTrace(w.human, state, "1-3");
    expect(trace?.criteria.map((entry) => entry.qa?.verdict)).toEqual([
      "passed",
      "failed",
      undefined,
    ]);
    const record = (await w.story()).qa;
    expect(qaTraceOf(record, 1)?.proofs).toEqual([`${DIR}/AC-1-3-1-empty.png`]);
    expect(qaStackEntries(record)).toEqual([
      {
        severity: "blocking",
        title: "QA failed: One item paid instead of two",
        criterion: 2,
        decision: null,
      },
    ]);
    // The stack the merge point shows, and the one its refresh recomputes, carry the failure.
    expect(stackEntriesOf(await w.story(), 0)).toEqual(qaStackEntries(record));
    const walk = walkthrough({
      files: [],
      findings: qaStackEntries(record),
      criteria: walkCriteria(["one", "two", "three"], trace),
    });
    const text = walkthroughText(walk);
    expect(text).toContain("Played in a browser by QA: AC2 failed");
    expect(text).toContain("AC1 passed (");
    expect(text).toContain("AC-1-3-1-empty.png");
    expect(text).toContain("AC2 failed: One item paid instead of two");
  });
});

describe("the pure rules", () => {
  it("tells every problem of a report, bounded", () => {
    const problems = reportProblems("1-3", 3, {
      scenarios: [{ criterion: 1 }, { criterion: 1, verdict: "blocked" }],
    });
    expect(problems.length).toBeLessThanOrEqual(8);
    expect(problems.join(" ")).toContain("give a verdict");
    expect(problems.join(" ")).toContain("listed_twice:1");
  });
});
