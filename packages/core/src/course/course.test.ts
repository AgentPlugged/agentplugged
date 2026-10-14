import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentNextResult,
  type AgentStateView,
  type CourseResult,
  computeProjection,
  computeProjectionDetailed,
  mergeGate,
} from "../index.js";
import { product, story } from "../testing/requirements-product.js";

/**
 * The correction of course, end to end: the creator changes their mind about a
 * requirement with stories to do, under way and done, tests and a proof behind it. The engine
 * computes the impact by the trace, the stack comes sorted, the creator's three gestures are
 * recorded, the story under way does not merge before its decision, and the course closes only
 * when the documents, the stories and the proofs are coherent again.
 */

const PRD_TEXT = [
  "---",
  "id: prd",
  "kind: prd",
  "owner: quentin",
  "---",
  "# PRD",
  "",
  "## Sign-in",
  "",
  "- EF-1: The visitor signs in with an email.",
  "- EF-2: The visitor resets their password.",
  "- ENF-1: A page answers in at most 300 ms, measured by `pnpm bench`.",
  "",
].join("\n");

const UX = [
  "---",
  "id: ux",
  "kind: ux",
  "owner: sam",
  "---",
  "# UX",
  "",
  "## Sign-in screen",
  "",
  "The screen is the one EF-1 asks for.",
  "",
].join("\n");

const storyWithCriteria = (id: string, requirements: string[], extra = "") =>
  [
    "---",
    `id: ${id}`,
    "kind: story",
    "owner: sam",
    `requirements: [${requirements.join(", ")}]`,
    "---",
    `# Story ${id}`,
    "",
    "## Acceptance criteria",
    "",
    "- The visitor signs in.",
    "- A wrong password is refused.",
    extra,
    "",
  ].join("\n");

const PAGE = [
  "---",
  "id: kb-sign-in",
  "kind: note",
  "owner: zoe",
  "sources:",
  "  - path: .agentplugged/docs/prd.md",
  `    blob: ${"a".repeat(40)}`,
  "code:",
  "  - src/signin/",
  "---",
  "# Sign-in",
  "",
].join("\n");

const QUOTE = "On ne se connecte plus par e-mail : un lien magique à la place.";

/** The product of the requirements' tests, with a PRD about sign-in and four stories. */
async function world() {
  const p = await product();
  p.files.seed(".agentplugged/docs/prd.md", PRD_TEXT);
  p.files.seed(".agentplugged/docs/ux.md", UX);
  p.files.seed(".agentplugged/docs/reference/sign-in.md", PAGE);
  p.files.seed(".agentplugged/stories/1-1-page.md", storyWithCriteria("1-1", ["EF-1", "ENF-1"]));
  p.files.seed(".agentplugged/stories/1-2-signin.md", storyWithCriteria("1-2", ["EF-1"]));
  p.files.seed(".agentplugged/stories/1-3-reset.md", storyWithCriteria("1-3", ["EF-1", "EF-2"]));
  p.files.seed(".agentplugged/stories/1-4-other.md", storyWithCriteria("1-4", ["EF-2"]));
  p.tests.lines = [
    { path: "src/signin.test.ts", line: 3, text: "// EF-1 signs in" },
    { path: "src/signin.test.ts", line: 9, text: "it('AC-1-2-1 signs in')" },
  ];
  const productId = (await p.journal.productId()) as string;
  /** The engine records that a story started: it is under way. */
  const start = async (id: string) => {
    await p.journal.appendAll([
      {
        type: "story.started",
        actor: { kind: "system" },
        product: productId,
        story: id,
        provenance: "trusted",
        payload: {
          agent: "sam",
          branch: `feat/${id}-work`,
          base: "c".repeat(40),
          base_ref: "main",
          worktree: `../shop.worktrees/${id}`,
        },
      },
    ]);
  };
  await p.sync();
  await p.run("record_proof", {
    agent: "quentin",
    requirement: "ENF-1",
    measured: 250,
    source: "pnpm bench",
  });
  // 1-1 is delivered (after the proof, so the proof is stale by that rule: record it again).
  await p.deliver("1-1");
  await p.run("record_proof", {
    agent: "quentin",
    requirement: "ENF-1",
    measured: 250,
    source: "pnpm bench",
  });
  await start("1-2");
  const course = (input: Record<string, unknown>) =>
    p.run("correct_course", { agent: "quentin", ...input }) as Promise<CourseResult>;
  const attempt = (input: Record<string, unknown>) =>
    p.call("correct_course", { agent: "quentin", ...input });
  const projected = async () => (await computeProjection((await p.journal.list()).events)).state;
  const next = () => p.run("next", {}) as Promise<AgentNextResult>;
  const state = async () => (await p.run("get_state", {})) as AgentStateView;
  return { ...p, course, attempt, projected, start, next, state };
}

const OPEN = {
  step: "open",
  summary: "Sign in with a magic link, no longer with an email and a password.",
  starts: ["EF-1", "ENF-1"],
  quote: QUOTE,
};

describe("a change of course on a requirement with stories, tests and proofs", () => {
  it("refuses a change that is not whole, or that names what does not exist, and writes nothing", async () => {
    const w = await world();
    const before = w.journal.events.length;
    const bare = await w.attempt({ step: "open", starts: ["EF-1"] });
    expect(bare.ok).toBe(false);
    if (!bare.ok) {
      expect(bare.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
      expect(JSON.stringify(bare.error.details)).toContain("summary");
      expect(JSON.stringify(bare.error.details)).toContain("quote");
    }
    const unknown = await w.attempt({ ...OPEN, starts: ["EF-1", "EF-99", "prd#No such heading"] });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(JSON.stringify(unknown.error.details)).toContain("EF-99: not found");
      expect(JSON.stringify(unknown.error.details)).toContain("prd#No such heading: not found");
    }
    expect(w.journal.events.length).toBe(before);
  });

  it("computes the impact by the trace and answers one sorted stack", async () => {
    const w = await world();
    const opened = await w.course(OPEN);
    expect(opened.course).toMatch(/^C-[0-9A-Z]{10}$/);
    // Requirements first, then the document that names them, the stories (under way, to do,
    // done), the page of the base.
    const lines = opened.stack ?? [];
    expect(lines.map((line) => line.replace(/^\d+\. /, "").split(" — ")[0])).toEqual([
      "requirement · EF-1",
      "requirement · ENF-1",
      "document · .agentplugged/docs/ux.md",
      "story · 1-2",
      "story · 1-3",
      "story · 1-1",
      "page · .agentplugged/docs/reference/sign-in.md",
    ]);
    // Never guessed: 1-4 only cites EF-2, which the change does not touch.
    expect(lines.join("\n")).not.toContain("1-4");
    // The facts come from the trace: stories, criteria, tests, the stale proof.
    expect(lines[0]).toContain("3 stories");
    expect(lines[0]).toContain("1 test file");
    expect(lines[1]).toContain("its proof goes stale");
    expect(lines[3]).toContain("in progress");
    expect(lines[3]).toContain("2 criteria, 1 test file");
    expect(lines[4]).toContain("to do");
    expect(lines[5]).toContain("done");
    expect(lines[2]).toContain("line 10");
    expect(lines[6]).toContain("describes src/signin/");
    expect(opened.proofs).toEqual(["ENF-1"]);
    expect(opened.blocked).toEqual(["1-2 (sam)"]);
    expect(opened.kinds).toEqual({ requirement: 2, document: 1, story: 3, page: 1 });
    expect(opened.left).toBe(7);
    // The journal keeps the change and the creator's words.
    const event = w.journal.events.find((entry) => entry.type === "course.opened");
    expect(event?.actor).toMatchObject({ kind: "agent", agent: "quentin" });
    expect(event?.payload).toMatchObject({ quote: QUOTE, starts: ["EF-1", "ENF-1"] });
  });

  it("keeps the story under way from merging until its decision, and says so in state and next", async () => {
    const w = await world();
    const opened = await w.course(OPEN);
    const projected = await w.projected();
    const gate = mergeGate(projected, "1-2");
    expect(gate.course).toBe(1);
    expect(gate.ready).toBe(false);
    // A story the change does not touch is not held.
    expect(mergeGate(projected, "1-4").course ?? 0).toBe(0);
    const state = await w.state();
    expect(state.course).toMatchObject({ id: opened.course, left: 7, total: 7 });
    expect(state.course?.blocked).toEqual(["1-2 (sam)"]);
    expect(state.course?.stack).toHaveLength(5);
    expect(state.course?.more).toBe(2);
    const next = await w.next();
    expect(next.course).toEqual({ id: opened.course, left: 7, blocked: ["1-2 (sam)"] });
    // One course at a time.
    const second = await w.attempt({ ...OPEN, starts: ["EF-2"] });
    expect(second.ok).toBe(false);
    // The decision of the story lifts the hold.
    await w.course({
      step: "decide",
      item: opened.course,
      items: [{ n: 4, gesture: "keep", reason: "Already builds the magic link." }],
      quote: "oui, la 1-2 reste comme elle est",
    });
    const after = await w.projected();
    expect(mergeGate(after, "1-2").course ?? 0).toBe(0);
    expect(mergeGate(after, "1-3").course).toBe(1);
  });

  it("takes the creator's three gestures, and refuses what is not a gesture", async () => {
    const w = await world();
    const opened = await w.course(OPEN);
    const item = opened.course;
    const refuse = async (items: unknown[], withQuote = true) => {
      const result = await w.attempt({
        step: "decide",
        item,
        items,
        ...(withQuote ? { quote: "ok" } : {}),
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      return JSON.stringify(result.error.details);
    };
    expect(await refuse([{ n: 4, gesture: "keep" }])).toContain("4: keep needs a reason");
    expect(await refuse([{ n: 4, gesture: "retire" }])).toContain(
      "4: only a requirement or a decision is retired",
    );
    expect(await refuse([{ n: 9, gesture: "update" }])).toContain("9: not in the stack");
    expect(await refuse([{ n: 4, gesture: "update" }], false)).toContain("quote");
    const decided = await w.course({
      step: "decide",
      item,
      items: [
        { n: 1, gesture: "retire" },
        { n: 2, gesture: "update" },
        { n: 3, gesture: "update" },
        { n: 4, gesture: "keep", reason: "Already builds the magic link." },
      ],
      quote: "j'enlève EF-1, je change ENF-1, je garde la 1-2",
    });
    expect(decided.decided).toEqual({ retire: 1, update: 2, keep: 1 });
    expect(decided.left).toBe(3);
    // The updates go to the agent that authors each document; the creator's text is not touched.
    expect(decided.handoff).toEqual([
      { owner: "quentin", refs: ["retire EF-1", "ENF-1"] },
      { owner: "sam", refs: [".agentplugged/docs/ux.md"] },
    ]);
    // A gesture is final: it is not decided twice.
    expect(await refuse([{ n: 1, gesture: "update" }])).toContain("1: already decided");
    const record = (await w.projected()).courses as Record<
      string,
      { stack: Array<{ gesture: string | null; reason: string | null }> }
    >;
    const stack = record[item as string]?.stack ?? [];
    expect(stack.map((entry) => entry.gesture)).toEqual([
      "retire",
      "update",
      "update",
      "keep",
      null,
      null,
      null,
    ]);
    expect(stack[3]?.reason).toBe("Already builds the magic link.");
    expect(w.journal.events.filter((entry) => entry.type === "course.decided")).toHaveLength(1);
  });

  it("closes only when the stories, the retired requirement and the proofs are coherent again", async () => {
    const w = await world();
    const opened = await w.course(OPEN);
    const item = opened.course;
    await w.course({
      step: "decide",
      item,
      items: [
        { n: 1, gesture: "retire" },
        { n: 2, gesture: "update" },
        { n: 3, gesture: "update" },
        { n: 4, gesture: "keep", reason: "Already builds the magic link." },
        { n: 5, gesture: "update" },
        { n: 6, gesture: "update" },
        { n: 7, gesture: "update" },
      ],
      quote: "tout est tranché",
    });
    // Everything is decided but nothing is written yet: the engine finds what is still wrong.
    const early = await w.course({ step: "close", item });
    expect(early.closed).toBe(false);
    // The identifier is not marked, and each element marked update still reads as it did.
    expect(early.problems).toEqual([
      "EF-1: not marked retired yet",
      "ENF-1: marked update, its text is unchanged (keep it, or change it)",
      ".agentplugged/docs/ux.md: marked update, nothing changed yet (keep it, or change it)",
      "1-3: marked update, nothing changed yet (keep it, or change it)",
      "1-1: marked update, nothing changed yet (keep it, or change it)",
      ".agentplugged/docs/reference/sign-in.md: marked update, nothing changed yet (keep it, or change it)",
    ]);
    // The authors do their work: EF-1 is marked retired, ENF-1 changes, the stories drop EF-1.
    const changed = PRD_TEXT.replace(
      "- EF-1: The visitor signs in with an email.",
      "- EF-1: (retired) Sign-in by email.",
    ).replace("at most 300 ms", "at most 200 ms");
    w.files.seed(".agentplugged/docs/prd.md", changed);
    // The stories that still cite the retired requirement are told, one line each.
    const cited = await w.course({ step: "close", item });
    expect(cited.problems).toEqual(
      expect.arrayContaining([
        "story 1-1: cites EF-1, which is retired",
        "story 1-2: cites EF-1, which is retired",
        "story 1-3: cites EF-1, which is retired",
      ]),
    );
    w.files.seed(".agentplugged/stories/1-1-page.md", storyWithCriteria("1-1", ["ENF-1"]));
    w.files.seed(".agentplugged/stories/1-2-signin.md", storyWithCriteria("1-2", ["EF-2"]));
    w.files.seed(".agentplugged/stories/1-3-reset.md", storyWithCriteria("1-3", ["EF-2"]));
    // The stories are rewritten but the UX specification and the page still read as before.
    const unchanged = await w.course({ step: "close", item });
    expect(unchanged.problems).toEqual([
      "ENF-1: changed, its proof still counts, the register is behind (measure.requirements)",
      ".agentplugged/docs/ux.md: marked update, nothing changed yet (keep it, or change it)",
      ".agentplugged/docs/reference/sign-in.md: marked update, nothing changed yet (keep it, or change it)",
    ]);
    w.files.seed(
      ".agentplugged/docs/ux.md",
      UX.replace("the one EF-1 asks for", "the magic link screen"),
    );
    w.files.seed(".agentplugged/docs/reference/sign-in.md", `${PAGE}Magic link.\n`);
    // The proof of ENF-1 still counts for a requirement whose text changed: the register is behind.
    const behind = await w.course({ step: "close", item });
    expect(behind.closed).toBe(false);
    expect(behind.problems).toEqual([
      "ENF-1: changed, its proof still counts, the register is behind (measure.requirements)",
    ]);
    await w.sync();
    const registered = (await w.state()).requirements;
    expect(registered?.gaps).toContain("ENF-1:no_proof:measure");
    const closed = await w.course({ step: "close", item });
    expect(closed).toEqual({ course: item, closed: true });
    // After: no course open, no hold, and the journal tells the whole story.
    const after = await w.state();
    expect(after.course).toBeUndefined();
    expect((await w.next()).course).toBeUndefined();
    expect(mergeGate(await w.projected(), "1-3").course ?? 0).toBe(0);
    expect(
      w.journal.events.map((entry) => entry.type).filter((type) => type.startsWith("course.")),
    ).toEqual(["course.opened", "course.decided", "course.closed"]);
  });

  it("refuses to close while an element waits for the creator, and a course is open for the next", async () => {
    const w = await world();
    const opened = await w.course({ ...OPEN, starts: ["EF-2"] });
    const early = await w.course({ step: "close", item: opened.course });
    expect(early.closed).toBe(false);
    expect(early.left).toBe(opened.left);
    const shown = await w.course({ step: "show", item: opened.course });
    expect(shown.left).toBe(opened.left);
    expect(shown.stack?.length).toBeGreaterThan(0);
  });

  it("retires a requirement for good: the identifier stays, and a story that still cites it is told", async () => {
    const w = await world();
    const opened = await w.course({ ...OPEN, starts: ["EF-2"], summary: "No password reset." });
    // 1-3 and 1-4 cite EF-2; EF-2 is the first line.
    expect(opened.stack?.[0]).toContain("requirement · EF-2");
    const item = opened.course;
    const decisions = (opened.stack ?? []).map((_, index) =>
      index === 0
        ? { n: 1, gesture: "retire" }
        : { n: index + 1, gesture: "keep", reason: "Reviewed, nothing to change." },
    );
    await w.course({ step: "decide", item, items: decisions, quote: "plus de réinitialisation" });
    // The definition is removed instead of being marked retired: it must stay.
    w.files.seed(".agentplugged/docs/prd.md", PRD_TEXT.replace(/- EF-2:.*\n/, ""));
    const removed = await w.course({ step: "close", item });
    expect(removed.closed).toBe(false);
    expect(removed.problems?.[0]).toBe("EF-2: removed, mark it retired (it stays, never reused)");
    w.files.seed(
      ".agentplugged/docs/prd.md",
      PRD_TEXT.replace("- EF-2: The visitor resets", "- EF-2: (retired) The visitor resets"),
    );
    const cited = await w.course({ step: "close", item });
    expect(cited.problems).toEqual(
      expect.arrayContaining([
        "story 1-3: cites EF-2, which is retired",
        "story 1-4: cites EF-2, which is retired",
      ]),
    );
    w.files.seed(".agentplugged/stories/1-3-reset.md", storyWithCriteria("1-3", ["EF-1"]));
    w.files.seed(".agentplugged/stories/1-4-other.md", storyWithCriteria("1-4", ["EF-1"]));
    expect((await w.course({ step: "close", item })).closed).toBe(true);
  });

  it("bounds the stack it shows and counts the rest", async () => {
    const w = await world();
    for (let n = 10; n < 30; n += 1) {
      w.files.seed(`.agentplugged/stories/1-${n}-more.md`, story(`1-${n}`, ["EF-2"]));
    }
    const opened = await w.course({ ...OPEN, starts: ["EF-2"] });
    expect(opened.stack).toHaveLength(12);
    // EF-2, twenty-two stories (1-3, 1-4 and twenty more) and the page: 24 elements, 12 shown.
    expect(opened.more).toBe(12);
    expect(opened.left).toBe(24);
    expect(JSON.stringify(opened).length).toBeLessThan(2_600);
  });

  it("ignores in the projection what does not fit: a second course, a closing before the decisions", async () => {
    const w = await world();
    const opened = await w.course(OPEN);
    const productId = (await w.journal.productId()) as string;
    const asAgent = (type: string, payload: Record<string, unknown>) => ({
      type,
      actor: { kind: "agent" as const, agent: "quentin" },
      product: productId,
      provenance: "trusted" as const,
      payload,
    });
    const entry = { kind: "requirement", ref: "EF-2", why: "again" };
    await w.journal.appendAll([
      asAgent("course.opened", {
        summary: "Another",
        quote: "q",
        starts: ["EF-2"],
        stack: [entry],
        more: 0,
        proofs: [],
      }),
      asAgent("course.closed", { course: opened.course }),
      asAgent("course.decided", {
        course: opened.course,
        decisions: [{ n: 1, gesture: "keep" }],
        quote: "q",
      }),
      asAgent("course.decided", {
        course: "C-ZZZZZZZZZZ",
        decisions: [{ n: 1, gesture: "update" }],
        quote: "q",
      }),
    ]);
    const detailed = await computeProjectionDetailed((await w.journal.list()).events);
    const courses = detailed.projection.state.courses as Record<string, { status: string }>;
    // Still the one course, still open, no gesture applied (a keep without a reason is no gesture).
    expect(Object.keys(courses)).toEqual([opened.course]);
    expect(courses[opened.course as string]?.status).toBe("open");
    expect(detailed.projection.ignored.length).toBeGreaterThanOrEqual(4);
  });
});
