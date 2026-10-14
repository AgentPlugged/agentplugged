import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CheckpointState,
  computeProjection,
  createCommandRegistry,
  type DocsCheckResult,
  type NextResult,
} from "../index.js";
import { HEAD, product, SESSION } from "../testing/product-harness.js";

const codeOf = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? undefined : result.error?.code;

describe("skipping a step of the journey, from the chat", () => {
  it("asks once, with the risk and the lightest option, at the risk the engine fixes", async () => {
    const { request, checkpoint } = await product();
    const asked = await request({ kind: "step_skip", step: "architecture" }, "je code d'abord");
    expect(asked).toMatchObject({ kind: "step_skip", risk: "low", irreversible: false });
    expect(asked.journey).toMatchObject({
      step: "architecture",
      story: null,
      dependents: ["architecture_security", "breakdown", "story_review"],
    });
    expect(asked.journey?.warning).toContain("lightest option: a minimal architecture");
    const opened = await checkpoint(asked.checkpoint);
    expect(opened).toMatchObject({ type: "creator_action", risk: "low", story: null });
    expect(opened?.title).toBe("Skip the architecture");
    expect(opened?.summary).toContain("Reason: je code d'abord");
    expect(opened?.summary).toContain("The engine no longer asks for an architecture");
    expect(opened?.summary).toContain("Warning: Without the architecture");
    // The security of a story or of the design is a high risk to skip; a review, a medium one.
    expect((await request({ kind: "step_skip", step: "story_security" })).risk).toBe("high");
    expect((await request({ kind: "step_skip", step: "story_review", story: "4-3" })).risk).toBe(
      "medium",
    );
  });

  it("records it with one answer: what, by whom, when, how it was proved, and why", async () => {
    const { decide, state, journal } = await product();
    const asked = await decide({ kind: "step_skip", step: "prd" }, "oui, pas de PRD", "pas de PRD");
    const skips = (await state()).skips as Record<string, Record<string, unknown>>;
    expect(Object.keys(skips)).toEqual(["prd"]);
    expect(skips.prd).toMatchObject({
      step: "prd",
      story: null,
      reason: "pas de PRD",
      by: "creator",
      source: "chat",
      checkpoint: asked.checkpoint,
    });
    // The journal holds the creator's answer (proved by their message) and its execution.
    const [answered, executed] = journal.events.slice(-2);
    expect(answered?.type).toBe("checkpoint.answered");
    expect(executed).toMatchObject({
      type: "creator_action.executed",
      payload: {
        checkpoint: asked.checkpoint,
        source: "chat",
        quote: "oui, pas de PRD",
        action: { kind: "step_skip", step: "prd", reason: "pas de PRD" },
      },
    });
  });

  it("covers one story, or every story, and canonicalises the story", async () => {
    const { decide, state } = await product();
    await decide({ kind: "step_skip", step: "story_review", story: "04-3" });
    await decide({ kind: "step_skip", step: "story_ci" });
    const skips = (await state()).skips as Record<string, Record<string, unknown>>;
    expect(Object.keys(skips).sort()).toEqual(["story_ci", "story_review@4-3"]);
    expect(skips["story_review@4-3"]).toMatchObject({ story: "4-3" });
    expect(skips.story_ci).toMatchObject({ story: null });
  });

  it("is refused for what is not a step, nor a step of a story given a story, and writes nothing", async () => {
    const { call, journal } = await product();
    const before = journal.events.length;
    const ask = (action: Record<string, unknown>) =>
      call("request_creator_action", { agent: "main", action, reason: "why" });
    expect(codeOf(await ask({ kind: "step_skip", step: "the_whole_method" }))).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    expect(codeOf(await ask({ kind: "step_skip", step: "prd", story: "4-3" }))).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    expect(codeOf(await ask({ kind: "step_skip" }))).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(journal.events.length).toBe(before);
  });

  it("is not asked twice, and a step skipped for every story covers one story", async () => {
    const { decide, call } = await product();
    await decide({ kind: "step_skip", step: "story_review" });
    const again = await call("request_creator_action", {
      agent: "main",
      action: { kind: "step_skip", step: "story_review", story: "4-3" },
      reason: "why",
    });
    expect(codeOf(again)).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
    const twice = await call("request_creator_action", {
      agent: "main",
      action: { kind: "step_skip", step: "story_review" },
      reason: "why",
    });
    expect(codeOf(twice)).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
  });

  it("is taken up again in a word, and only a step that is skipped", async () => {
    const { decide, call, state } = await product();
    const ask = (kind: string, step: string) =>
      call("request_creator_action", {
        agent: "main",
        action: { kind, step },
        reason: "finalement",
      });
    expect(codeOf(await ask("step_resume", "prd"))).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
    await decide({ kind: "step_skip", step: "prd" });
    expect(Object.keys((await state()).skips as object)).toEqual(["prd"]);
    await decide({ kind: "step_resume", step: "prd" }, "oui, finalement fais le PRD");
    expect(Object.keys((await state()).skips as object)).toEqual([]);
  });

  it("is never done by an agent alone: no answer, no skip", async () => {
    const { request, call, state, journal, productId } = await product();
    const asked = await request({ kind: "step_skip", step: "prd" });
    // An answer the creator never gave: nothing is written.
    const before = journal.events.length;
    const invented = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: asked.checkpoint,
      decision: "approved",
      quote: "je n'ai jamais dit ça",
      session: SESSION,
    });
    expect(codeOf(invented)).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect(journal.events.length).toBe(before);
    // An execution written without the creator's approval is ignored by the projection.
    await journal.appendAll([
      {
        type: "creator_action.executed",
        actor: { kind: "agent", agent: "main" },
        product: productId,
        provenance: "trusted",
        payload: {
          checkpoint: asked.checkpoint,
          action: { kind: "step_skip", step: "prd", reason: "my choice" },
          source: "chat",
          quote: "oui",
        },
      },
    ]);
    const projected = await computeProjection((await journal.list()).events);
    expect(projected.ignored.some((entry) => entry.reason === "invalid")).toBe(true);
    expect(projected.state.skips).toBeUndefined();
    expect(await state()).not.toHaveProperty("skips.prd");
  });

  it("is shown by next and get_state as the creator's choice, never an error", async () => {
    const { decide, call } = await product();
    const first = await call("next");
    expect(first.ok && (first.value as NextResult).journey).toEqual({
      skipped: [],
      skipped_total: 0,
    });
    await decide({ kind: "step_skip", step: "prd" }, "oui, pas de PRD", "pas de PRD");
    const next = await call("next");
    expect(next.ok && (next.value as NextResult).journey).toMatchObject({
      skipped: [{ step: "prd", story: null, reason: "pas de PRD", by: "creator", source: "chat" }],
      skipped_total: 1,
    });
    const view = await call("get_state", { full: true });
    expect(view.ok && (view.value as { journey?: unknown }).journey).toMatchObject({
      skipped_total: 1,
    });
  });
});

describe("what skipping a step does to the checks", () => {
  it("turns the problems of a skipped document into warnings in docs check", async () => {
    const { decide, files, human } = await product();
    files.seed(
      ".agentplugged/docs/prd.md",
      "---\nid: prd\nkind: prd\nowner: nobody-known\n---\n# PRD\n",
    );
    const run = async () => {
      const result = await createCommandRegistry().run("docs", human, { action: "check" });
      if (!result.ok) throw new Error(result.error.code);
      return result.value as DocsCheckResult;
    };
    const before = await run();
    expect(before.problems).toHaveLength(1);
    expect(before.skipped).toEqual([]);
    await decide({ kind: "step_skip", step: "prd" });
    const after = await run();
    expect(after.problems).toEqual([]);
    expect(after.skipped).toHaveLength(1);
    expect(after.skipped[0]?.details.path).toBe(".agentplugged/docs/prd.md");
    // Taking the PRD up again brings the problem back.
    await decide({ kind: "step_resume", step: "prd" });
    expect((await run()).problems).toHaveLength(1);
  });

  it("closes the point of the end of a skipped phase, written by the engine, shown to nobody", async () => {
    const { call, decide, state } = await product();
    const opened = await call("open_checkpoint", {
      agent: "iris",
      type: "phase_end",
      phase: "framing",
      risk: "low",
      title: "End of framing",
      summary: "The brief is ready.",
    });
    if (!opened.ok) throw new Error(opened.error.code);
    const id = (opened.value as { checkpoint: string }).checkpoint;
    const before = await call("next");
    expect(before.ok && (before.value as NextResult)).toMatchObject({
      step: "phase_review",
      checkpoint: id,
    });
    await decide({ kind: "step_skip", step: "phase_framing" });
    const next = await call("next");
    const value = next.ok ? (next.value as NextResult) : undefined;
    expect(value).toMatchObject({ phase: "planning" });
    expect(value?.waiting.map((entry) => entry.id)).toEqual([]);
    expect(value?.decisions?.map((entry) => entry.id)).toEqual([]);
    const closed = ((await state()).checkpoints as Record<string, CheckpointState>)[id];
    expect(closed).toMatchObject({ status: "closed", closed: { reason: "step_skipped" } });
    // Taking the phase up again brings it back: the agent opens its end again.
    await decide({ kind: "step_resume", step: "phase_framing" });
    const again = await call("next");
    expect(again.ok && (again.value as NextResult).phase).toBe("framing");
  });

  it("tells the commit hook of the stories started that no requirement is to be cited", async () => {
    const { decide, workspace, journal, productId } = await product();
    workspace.heads.set("feat/4-3-work", HEAD);
    await journal.appendAll([
      {
        type: "story.started",
        actor: { kind: "system" },
        product: productId,
        story: "4-3",
        provenance: "trusted",
        payload: {
          agent: "main",
          branch: "feat/4-3-work",
          base: "c".repeat(40),
          base_ref: "main",
          worktree: "../shop.worktrees/4-3",
        },
      },
    ]);
    await decide({ kind: "step_skip", step: "prd" });
    const last = workspace.hooks.at(-1) as { skips?: string; story?: unknown };
    expect(last.skips).toBe('{"story_trace":true}\n');
    expect(last.story).toBeUndefined();
    await decide({ kind: "step_resume", step: "prd" });
    expect((workspace.hooks.at(-1) as { skips?: string }).skips).toBe('{"story_trace":[]}\n');
  });

  it("gives a story whose review is skipped its merge point, once, and shows it to the creator", async () => {
    // The build phase alone, so that the stories decide the next step.
    const { decide, call, journal, productId, state } = await product("maintenance");
    await journal.appendAll([
      {
        type: "story.started",
        actor: { kind: "system" },
        product: productId,
        story: "4-3",
        provenance: "trusted",
        payload: {
          agent: "main",
          branch: "feat/4-3-work",
          base: "c".repeat(40),
          base_ref: "main",
          worktree: "../shop.worktrees/4-3",
        },
      },
      {
        type: "story.status_changed",
        actor: { kind: "agent", agent: "main" },
        product: productId,
        story: "4-3",
        provenance: "trusted",
        payload: { status: "in_review" },
      },
    ]);
    await decide({ kind: "step_skip", step: "story_review", story: "4-3" });
    await decide({ kind: "step_skip", step: "story_ci", story: "4-3" });
    await decide({ kind: "step_skip", step: "ci_setup" });
    const merges = async () =>
      Object.values((await state()).checkpoints as Record<string, CheckpointState>).filter(
        (entry) => entry.source === "merge",
      );
    // The engine opens the merge point (whichever read of the journal comes first), once.
    const next = await call("next");
    expect(next.ok && (next.value as NextResult)).toMatchObject({
      step: "validation",
      you: true,
      story: "4-3",
    });
    const [merge] = await merges();
    expect(merge).toMatchObject({ type: "story", story: "4-3", status: "open", risk: "medium" });
    expect(merge?.opened_by).toBeNull();
    expect(merge?.summary).toContain("its independent review");
    // Called again, nothing is opened a second time.
    await call("next");
    expect(await merges()).toHaveLength(1);
  });
});
