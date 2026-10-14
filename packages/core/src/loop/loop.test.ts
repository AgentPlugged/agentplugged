import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { computeProjection, type LoopView, type RecordedEvent, type StoryState } from "../index.js";
import { product, shippedAgent } from "../testing/requirements-product.js";

/**
 * The bounded loop, end to end: Noah's turn says what comes next and writes the stop
 * and the resumption; the developer declares the approaches of a story and the engine refuses one
 * that failed, and a fourth; the success condition is the story's criteria; nothing is started,
 * merged or spent by the loop.
 */

const COMMIT = "c".repeat(40);

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
  "",
  "## Out of scope",
  "",
  "Nothing else.",
  "",
].join("\n");

const NOAH = shippedAgent("noah", "Noah", "product", "framing");

/** A product with Noah, and the story 1-3 started by Sam. */
async function world(context?: Partial<CommandContext>) {
  const base = await product({ method: NOAH, ...(context === undefined ? {} : { context }) });
  base.files.seed(".agentplugged/stories/1-3-cart.md", STORY);
  // The product has a CI: `next` proposes the story under way, not the setting up of one.
  base.files.seed(".github/workflows/ci.yml", "name: ci\non: push\njobs: {}\n");
  const productId = base.journal.events[0]?.product as string;
  await base.journal.appendAll([
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
        worktree: "../shop.worktrees/1-3",
      },
    },
  ]);
  const turn = async () => {
    const result = await base.call("loop", { agent: "noah" });
    if (!result.ok)
      throw new Error(`loop: ${result.error.code} ${JSON.stringify(result.error.details)}`);
    return result.value as unknown as LoopView;
  };
  const sam = (extra: Record<string, unknown>) =>
    base.call("loop", { agent: "sam", story: "1-3", ...extra });
  const reason = (result: Awaited<ReturnType<typeof sam>>) =>
    result.ok ? undefined : String(result.error.details.reason);
  const types = () => base.journal.events.map((event) => event.type);
  const story = async () =>
    ((await computeProjection(base.journal.events)).state.stories as Record<string, StoryState>)[
      "1-3"
    ] as StoryState;
  const loop = async () => (await computeProjection(base.journal.events)).state.loop;
  /** The three criteria declared untestable: the success condition holds. */
  const prove = async () => {
    for (const criterion of [1, 2]) {
      await base.run("record_criterion", {
        agent: "sam",
        story: "1-3",
        criterion,
        seen: "untestable",
        note: "no result to observe through the interface",
      });
    }
  };
  return { ...base, turn, sam, reason, types, story, loop, prove };
}

/** Fail three approaches of story 1-3, the third opening the creator's point. */
async function exhaust(w: Awaited<ReturnType<typeof world>>) {
  for (const approach of [
    "cache the total in memory",
    "recompute at checkout",
    "queue the payment",
  ]) {
    expect((await w.sam({ note: approach })).ok, approach).toBe(true);
    expect((await w.sam({ seen: "failed", note: "test red" })).ok, approach).toBe(true);
  }
}

describe("Noah's turn", () => {
  it("is Noah's only: another agent or the main session is refused, nothing written", async () => {
    const w = await world();
    const before = w.journal.events.length;
    for (const agent of ["sam", "quentin", "main"]) {
      const result = await w.call("loop", { agent });
      expect(result.ok ? undefined : result.error.code, agent).toBe(ErrorCode.ROLE_FORBIDDEN);
    }
    expect(w.journal.events.length).toBe(before);
  });

  it("stops at a point of the creator's, once, with its reason; goes on after their gesture, once", async () => {
    const w = await world();
    const opened = (await w.run("open_checkpoint", {
      agent: "sam",
      type: "decision",
      risk: "medium",
      title: "Two readings of the cart",
      summary: "The story reads two ways.",
      story: "1-3",
      options: [
        { id: "a", label: "Reading A", consequence: "The cart keeps its items." },
        { id: "b", label: "Reading B", consequence: "The cart empties on exit." },
      ],
      recommendation: "a",
    })) as RecordedEvent;
    const stopped = await w.turn();
    expect(stopped).toMatchObject({
      verdict: "stop",
      reason: "decision",
      subject: opened.checkpoint,
    });
    expect(stopped.line).toContain("decision");
    expect(await w.loop()).toMatchObject({
      stopped: { reason: "decision", subject: opened.checkpoint },
    });
    // The same stop is not written twice.
    const count = w.types().length;
    await w.turn();
    expect(w.types().length).toBe(count);
    // Until the creator answers, the loop stays stopped; their gesture frees it, and it says so.
    const answered = await w.resolve(opened.checkpoint, { decision: "option_chosen", option: "a" });
    expect(answered.ok).toBe(true);
    const after = await w.turn();
    expect(JSON.stringify(after)).not.toContain('"stop"');
    expect(after.resumed).toBe(true);
    expect(w.types().filter((type) => type === "loop.stopped")).toHaveLength(1);
    expect(w.types().filter((type) => type === "loop.resumed")).toHaveLength(1);
    expect(w.journal.events.find((event) => event.type === "loop.resumed")?.payload).toEqual({
      after: "decision",
      subject: opened.checkpoint,
    });
    expect(await w.loop()).toMatchObject({ stopped: null });
    // And the next turn writes nothing more.
    const settled = w.types().length;
    await w.turn();
    expect(w.types().length).toBe(settled);
    expect((await computeProjection(w.journal.events)).ignored).toEqual([]);
  });

  it("stops at the merge, the spend, the irreversible release and the gap, each with its reason", async () => {
    const w = await world();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: "decision", title: "Budget exceeded: 1-3", summary: "Over the ceiling." }, "spend"],
      [{ type: "decision", title: "Gap on ENF-3", summary: "No proof." }, "gap"],
      [{ type: "document", title: "The PRD", summary: "Ready to read." }, "validation"],
      // The last one stays open: a release cannot be taken back, so it is the creator's to answer.
      [{ type: "release", title: "Release 1.0", summary: "Ship it." }, "irreversible"],
    ];
    for (const [payload, reason] of cases) {
      const opened = (await w.run("open_checkpoint", {
        agent: payload.type === "release" ? "omar" : "sam",
        risk: "medium",
        ...(payload.type === "decision"
          ? {
              options: [
                { id: "a", label: "A", consequence: "One." },
                { id: "b", label: "B", consequence: "Two." },
              ],
              recommendation: "a",
            }
          : {}),
        ...payload,
      })) as RecordedEvent;
      const view = await w.turn();
      expect(view, reason).toMatchObject({ verdict: "stop", reason, subject: opened.checkpoint });
      if (payload.type === "release") continue;
      const answered = await w.resolve(opened.checkpoint, {
        decision: payload.type === "decision" ? "option_chosen" : "approved",
        ...(payload.type === "decision" ? { option: "a" } : {}),
      });
      expect(answered.ok, reason).toBe(true);
    }
  });

  it("runs the story that is under way with the agent that owns it, and its success condition", async () => {
    const w = await world();
    const turn = await w.turn();
    expect(turn).toMatchObject({
      verdict: "run",
      step: "build",
      agent: "sam",
      story: "1-3",
      // The success condition: each criterion of the story and where it stands.
      until: "1:no_test 2:no_test",
    });
    // The approaches that failed ride with the story, to go into the developer's brief.
    await w.sam({ note: "cache the total in memory" });
    await w.sam({ seen: "failed", note: "stale after a refund" });
    const again = await w.turn();
    expect(again).toMatchObject({
      verdict: "run",
      attempts: { failed: 1, limit: 3 },
      tried: ["cache the total in memory"],
    });
    expect(JSON.stringify(again).length).toBeLessThan(700);
    // Once the criteria hold the story moves on; the condition shows it.
    await w.prove();
    expect((await w.turn()).until).toBe("1:untestable 2:untestable");
  });

  it("writes nothing for the work itself: it starts, merges and spends nothing", async () => {
    const w = await world();
    const before = w.types().length;
    // Nothing waits and the loop runs: a turn that runs writes nothing, the work is the agents'.
    const turn = await w.turn();
    expect(turn.verdict).toBe("run");
    expect(turn.line.length).toBeLessThan(200);
    await w.sam({ note: "cache the total in memory" });
    await w.sam({ seen: "failed", note: "test red" });
    // An approach and its failure: nothing else reaches the journal, so no merge, no cost, no
    // release, no pull request and no story started or moved by the loop.
    expect(w.types().slice(before)).toEqual(["story.attempt_recorded", "story.attempt_recorded"]);
  });
});

describe("the attempts of a story", () => {
  it("records the approach started and how it ended", async () => {
    const w = await world();
    const started = await w.sam({ note: "cache the total in memory" });
    expect(started.ok && started.value).toMatchObject({
      verdict: "recorded",
      attempts: { failed: 0, limit: 3 },
    });
    // One at a time: the approach in progress is reported before another one starts.
    expect(await w.reason(await w.sam({ note: "recompute at checkout" }))).toContain(
      "attempt_open",
    );
    const failed = await w.sam({ seen: "failed", note: "total is stale after a refund" });
    expect(failed.ok && failed.value).toMatchObject({
      attempts: { failed: 1, limit: 3 },
      tried: ["cache the total in memory"],
    });
    expect((await w.story()).attempts).toEqual([
      expect.objectContaining({ approach: "cache the total in memory", result: "started" }),
      expect.objectContaining({
        approach: "cache the total in memory",
        result: "failed",
        note: "total is stale after a refund",
      }),
    ]);
    // A result with nothing in progress is refused.
    expect(await w.reason(await w.sam({ seen: "failed" }))).toContain("no_attempt_open");
  });

  it("refuses an approach that already failed, however it is put, and writes nothing", async () => {
    const w = await world();
    await w.sam({ note: "cache the total in memory" });
    await w.sam({ seen: "failed", note: "stale after a refund" });
    const count = w.types().length;
    for (const again of [
      "cache the total in memory",
      "In memory, cache the TOTAL",
      "cache the total in-memory",
    ]) {
      const refused = await w.sam({ note: again });
      expect(refused.ok, again).toBe(false);
      expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
      expect(await w.reason(refused), again).toContain("approach_failed");
      expect(await w.reason(refused), again).toContain("cache the total in memory");
    }
    expect(w.types().length).toBe(count);
    // A different way is welcome.
    expect((await w.sam({ note: "recompute the total at checkout" })).ok).toBe(true);
  });

  it("opens a point for the creator at the third failure, refuses a fourth, and the loop stops there", async () => {
    const w = await world();
    await exhaust(w);
    const point = w.journal.events.filter((event) => event.type === "checkpoint.opened").at(-1);
    expect(point?.payload).toMatchObject({ source: "attempt_limit", type: "permission" });
    expect(point?.story).toBe("1-3");
    // The same write holds the failure and the point.
    const failure = w.journal.events
      .filter((event) => event.type === "story.attempt_recorded")
      .at(-1);
    expect(failure?.payload).toMatchObject({ result: "failed" });
    // The fourth approach is refused, with the creator asked.
    const fourth = await w.sam({ note: "split the cart in two" });
    expect(await w.reason(fourth)).toContain("attempts_exhausted");
    const view = await w.turn();
    expect(view).toMatchObject({
      verdict: "stop",
      reason: "attempts",
      subject: expect.stringMatching(/^G-/),
    });
    // The creator says yes: three more approaches, none of them one that failed.
    const answered = await w.resolve(point?.id ? `G-${point.id.slice(-10)}` : undefined, {
      decision: "approved",
    });
    expect(answered.ok).toBe(true);
    expect((await w.sam({ note: "cache the total in memory" })).ok).toBe(false);
    const fresh = await w.sam({ note: "split the cart in two" });
    expect(fresh.ok && fresh.value).toMatchObject({ attempts: { failed: 0, limit: 3 } });
    expect((await computeProjection(w.journal.events)).ignored).toEqual([]);
  });

  it("keeps the story stopped when the creator refuses to lift the limit", async () => {
    const w = await world();
    await exhaust(w);
    const point = w.journal.events.filter((event) => event.type === "checkpoint.opened").at(-1);
    const refused = await w.resolve(`G-${point?.id.slice(-10)}`, {
      decision: "rejected",
      note: "I will look at it myself",
    });
    expect(refused.ok).toBe(true);
    expect(await w.reason(await w.sam({ note: "split the cart in two" }))).toContain(
      "attempts_exhausted",
    );
  });

  it("is the story developer's call: another agent, and Noah, are refused", async () => {
    const w = await world();
    for (const agent of ["quentin", "noah"]) {
      const result = await w.call("loop", { agent, story: "1-3", note: "cache the total" });
      expect(result.ok ? undefined : result.error.code, agent).toBeDefined();
      expect(w.types()).not.toContain("story.attempt_recorded");
    }
    expect((await w.call("loop", { agent: "sam", story: "9-9", note: "x y z" })).ok).toBe(false);
    // The input says one thing at a time.
    for (const input of [
      { agent: "sam", story: "1-3" },
      { agent: "sam", note: "cache the total" },
      { agent: "sam", seen: "green" },
      { agent: "sam", story: "1-3", seen: "maybe" },
      { agent: "noah", story: "1-3" },
    ]) {
      const result = await w.call("loop", input);
      expect(result.ok ? undefined : result.error.code, JSON.stringify(input)).toBe(
        ErrorCode.INVALID_ARGUMENTS,
      );
    }
  });

  it("goes green only when the criteria of the story hold: the condition is the engine's", async () => {
    const w = await world();
    await w.sam({ note: "recompute the total at checkout" });
    const early = await w.sam({ seen: "green" });
    expect(early.ok ? undefined : early.error.code).toBe(ErrorCode.CRITERIA_NOT_PROVEN);
    expect((await w.story()).attempts).toHaveLength(1);
    await w.prove();
    const green = await w.sam({ seen: "green" });
    expect(green.ok && green.value).toMatchObject({ verdict: "recorded", attempts: { failed: 0 } });
    expect((await w.story()).attempts?.at(-1)).toMatchObject({ result: "green" });
    // And a new approach may start again afterwards (the next round of work).
    expect((await w.sam({ note: "polish the messages" })).ok).toBe(true);
  });
});

describe("a story with no condition is never green", () => {
  it("refuses green when the story lists no criterion the engine can follow", async () => {
    const w = await world();
    w.files.seed(
      ".agentplugged/stories/1-3-cart.md",
      STORY.replace(/- Given[^\n]*\n/g, "").replace(
        "## Acceptance criteria\n",
        "## Acceptance criteria\n\nNone yet.\n",
      ),
    );
    await w.sam({ note: "recompute the total at checkout" });
    const early = await w.sam({ seen: "green" });
    expect(await w.reason(early)).toContain("no_condition");
    expect((await w.story()).attempts).toHaveLength(1);
  });
});

describe("the delegation is bounded", () => {
  const handover = (agent: string, to: string) => ({
    agent,
    to,
    mode: "autonomous",
    brief: "Take the next ready story.",
    story: "1-3",
  });

  it("is Noah's alone: an agent he handed a story to hands nothing further, nothing written", async () => {
    const w = await world();
    // Noah hands the story to Sam: that is the one level of the loop.
    const first = await w.call("delegate", handover("noah", "sam"));
    expect(first.ok).toBe(true);
    const before = w.journal.events.length;
    // Sam, who holds it, calls no one: not a reviewer, not another developer, not Noah.
    for (const to of ["quentin", "omar", "iris", "noah"]) {
      const cascade = await w.call("delegate", handover("sam", to));
      expect(cascade.ok ? undefined : cascade.error.code, to).toBe(ErrorCode.ROLE_FORBIDDEN);
    }
    // Nor the reviewer who was called, nor the main session while Noah is active.
    for (const agent of ["quentin", "main"]) {
      const cascade = await w.call("delegate", handover(agent, "sam"));
      expect(cascade.ok ? undefined : cascade.error.code, agent).toBe(ErrorCode.ROLE_FORBIDDEN);
    }
    expect(w.journal.events.length).toBe(before);
    expect(w.types().filter((type) => type === "agent.delegated")).toHaveLength(1);
  });

  it("gives the loop no way to hand work over itself: a turn writes no handover", async () => {
    const w = await world();
    await w.turn();
    await w.sam({ note: "cache the total in memory" });
    expect(w.types()).not.toContain("agent.delegated");
  });
});

describe("the search for a bug's cause", () => {
  it("keeps the hypotheses with their confidence and evidence, one at a time", async () => {
    const w = await world();
    const put = await w.sam({
      seen: "hypothesis",
      note: "7/10 the total is cached before a refund",
    });
    expect(put.ok).toBe(true);
    expect(w.journal.events.at(-1)?.payload).toEqual({
      approach: "the total is cached before a refund",
      result: "started",
      kind: "hypothesis",
      confidence: 7,
    });
    // One at a time: the next one waits for the end of the first.
    expect(
      w.reason(await w.sam({ seen: "hypothesis", note: "5/10 the tax rounds twice" })),
    ).toContain("hypothesis_open");
    const closed = await w.sam({
      seen: "ruled_out",
      note: "the refund test passes with the cache off",
    });
    expect(closed.ok).toBe(true);
    expect(w.journal.events.at(-1)?.payload).toEqual({
      approach: "the total is cached before a refund",
      result: "failed",
      note: "the refund test passes with the cache off",
      kind: "hypothesis",
      confidence: 7,
    });
    expect((await w.story()).attempts).toHaveLength(2);
    expect((await computeProjection(w.journal.events)).ignored).toEqual([]);
  });

  it("refuses a hypothesis already ruled out, whatever its order or its words", async () => {
    const w = await world();
    await w.sam({ seen: "hypothesis", note: "7/10 the total is cached before a refund" });
    await w.sam({ seen: "ruled_out", note: "refund test passes with the cache off" });
    const again = await w.sam({
      seen: "hypothesis",
      note: "8/10 Before a refund, the total is cached",
    });
    expect(w.reason(again)).toContain("hypothesis_ruled_out");
    const other = await w.sam({ seen: "hypothesis", note: "6/10 the tax rounds twice" });
    expect(other.ok).toBe(true);
  });

  it("asks for a confidence on a hypothesis and an evidence on its end", async () => {
    const w = await world();
    expect(w.reason(await w.sam({ seen: "hypothesis", note: "the tax rounds twice" }))).toContain(
      "confidence_missing",
    );
    expect(
      w.reason(await w.sam({ seen: "hypothesis", note: "11/10 the tax rounds twice" })),
    ).toContain("confidence_missing");
    expect(w.reason(await w.sam({ seen: "confirmed", note: "x y" }))).toContain(
      "no_hypothesis_open",
    );
    await w.sam({ seen: "hypothesis", note: "6/10 the tax rounds twice" });
    expect(w.reason(await w.sam({ seen: "confirmed" }))).toContain("evidence_missing");
  });

  it("starts no fix before a cause is confirmed, and shows the ruled-out causes with the cause", async () => {
    const w = await world();
    // A story with no hypothesis is as before: an approach starts at once.
    await w.sam({ seen: "hypothesis", note: "7/10 the total is cached before a refund" });
    await w.sam({ seen: "ruled_out", note: "refund test passes with the cache off" });
    expect(w.reason(await w.sam({ note: "recompute the total at checkout" }))).toContain(
      "cause_unconfirmed",
    );
    await w.sam({ seen: "hypothesis", note: "6/10 the tax rounds twice" });
    const confirmed = await w.sam({
      seen: "confirmed",
      note: "one cent off on 3 items, rounding is applied per line and per total",
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.ok ? confirmed.value : undefined).toMatchObject({
      cause: "the tax rounds twice",
      ruled_out: ["the total is cached before a refund"],
    });
    expect((await w.sam({ note: "round once, on the total" })).ok).toBe(true);
    // Noah's turn hands the ruled-out causes to the developer's brief.
    expect(await w.turn()).toMatchObject({ ruled_out: ["the total is cached before a refund"] });
  });

  it("counts the fixes that failed, not the causes ruled out: three failed fixes ask the creator", async () => {
    const w = await world();
    const opened = () => w.types().filter((type) => type === "checkpoint.opened").length;
    const before = opened();
    for (const note of [
      "6/10 the cache is stale",
      "6/10 the tax rounds twice",
      "6/10 the refund is lost",
      "6/10 the coupon applies twice",
    ]) {
      expect((await w.sam({ seen: "hypothesis", note })).ok, note).toBe(true);
      expect(
        (await w.sam({ seen: note.includes("coupon") ? "confirmed" : "ruled_out", note: "seen" }))
          .ok,
      ).toBe(true);
    }
    // Three causes ruled out opened no point for the creator.
    expect(opened()).toBe(before);
    await exhaust(w);
    expect(opened()).toBe(before + 1);
    // And while the creator is asked, no hypothesis is put forward either.
    expect(w.reason(await w.sam({ seen: "hypothesis", note: "5/10 something else" }))).toContain(
      "attempts_exhausted",
    );
  });

  it("keeps a story with a probe left from its review, and lets it go once it is taken out", async () => {
    let added = "console.log(total); // agentplugged:debug";
    const diff = () =>
      [
        "diff --git a/src/cart.ts b/src/cart.ts",
        "--- a/src/cart.ts",
        "+++ b/src/cart.ts",
        "@@ -1,1 +1,2 @@",
        " export const total = 1;",
        `+${added}`,
        "",
      ].join("\n");
    const w = await world({
      storyDiff: { diff: async () => diff() },
      proofRunner: {
        workingCopy: async () => ({ commit: "d".repeat(40), clean: true }),
        run: async () => {
          throw new Error("nothing runs here");
        },
      },
    });
    await w.prove();
    const toReview = () =>
      w.call("update_story", { agent: "sam", story: "1-3", status: "in_review" });
    const refused = await toReview();
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : String(refused.error.details.reason)).toContain(
      "debug_instrumentation_left",
    );
    expect(refused.ok ? "" : String(refused.error.details.reason)).toContain("src/cart.ts");
    added = "export const unit = 1;";
    expect((await toReview()).ok).toBe(true);
  });

  it("is the story's developer's alone, on a story under way", async () => {
    const w = await world();
    const other = await w.call("loop", {
      agent: "quentin",
      story: "1-3",
      seen: "hypothesis",
      note: "7/10 the cache is stale",
    });
    expect(other.ok ? undefined : String(other.error.details.reason)).toContain("not_builder");
  });
});
