import type { GetStateInput } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  bigCheckpoint,
  DEMO_SIZE,
  fullState,
  type StateSize,
  ulid,
  words,
} from "../testing/state-fixtures.js";
import type { FullStateView } from "./agent-commands.js";
import {
  abridgeState,
  type CheckpointDigest,
  fitState,
  STATE_LIMITS,
  STATE_MAX_CHARS,
  type StateDetail,
  stateDetail,
  stateSize,
} from "./state-view.js";

/** The sizes the story names: the demo after six hours, a product of 40 stories, and 3 times more. */
const SIZES: ReadonlyArray<readonly [string, StateSize]> = [
  ["the demo (38 checkpoints)", DEMO_SIZE],
  ["40 stories, 200 checkpoints", { checkpoints: 200, stories: 40, open: 3 }],
  ["three times more", { checkpoints: 600, stories: 120, open: 5 }],
  ["a lot of open points, long texts", { checkpoints: 300, stories: 60, open: 20, text: 2500 }],
];

function detail(full: FullStateView, input: GetStateInput): StateDetail {
  const outcome = stateDetail(full, input);
  if (outcome === undefined || !outcome.found) throw new Error("no detail");
  return outcome.value;
}

describe("the abridged state", () => {
  it("the fixture is as large as the demo: the complete state is far beyond the limit", () => {
    expect(stateSize(fullState(DEMO_SIZE))).toBeGreaterThan(100_000);
  });

  for (const [name, size] of SIZES) {
    it(`stays under ${STATE_MAX_CHARS} characters for ${name}`, () => {
      const full = fullState(size);
      const view = fitState(full);
      expect(stateSize(view)).toBeLessThan(STATE_MAX_CHARS);
      // What was cut is said: the resolved checkpoints and the merged stories.
      const sections = view.truncated.map((entry) => entry.section);
      if (size.checkpoints > 20) expect(sections).toContain("checkpoints.resolved");
      for (const entry of view.truncated) {
        expect(entry.omitted, entry.section).toBeGreaterThan(0);
        expect(entry.total, entry.section).toBeGreaterThanOrEqual(entry.shown + entry.omitted);
      }
      // The counters tell the whole history.
      expect(view.checkpoint_counts.total).toBe(size.checkpoints);
      expect(view.checkpoint_counts.open).toBe(size.open ?? 3);
    });
  }

  it("keeps what a decision needs in full: the open checkpoints, the open points", () => {
    const full = fullState({ checkpoints: 200, stories: 40, open: 3 });
    const view = fitState(full);
    // The other parts give way first: a state that needs it is cut, the decisions are not.
    expect(view.open_points).toEqual(full.open_points.slice(0, 20));
    const open = Object.values(full.checkpoints).filter(
      (checkpoint) => checkpoint.status === "open",
    );
    expect(open).toHaveLength(3);
    for (const checkpoint of open) {
      // Whole: options, documents, blocks, the untrusted mark, everything.
      expect(view.checkpoints[checkpoint.id]).toEqual(checkpoint);
    }
    expect(view.open_points_total).toBe(full.open_points.length);
  });

  it("shows the ten latest resolved checkpoints as digests and counts the others", () => {
    // 3 stories (`validation.points`): `validation.channels` (the channels the creator can be asked
    // through) takes a few characters of the state's budget, which this size used to fill to within
    // 64 characters.
    const full = fullState({ checkpoints: 200, stories: 2, open: 2 });
    const view = fitState(full);
    // The demo's size, 5 times more checkpoints: nothing else needs to give way.
    expect(view.truncated.map((entry) => entry.section)).not.toContain("stories");
    const digests = Object.values(view.checkpoints).filter(
      (checkpoint): checkpoint is CheckpointDigest => "abridged" in checkpoint,
    );
    expect(digests.length).toBeGreaterThanOrEqual(10);
    expect(digests.length).toBeLessThanOrEqual(10 + 4);
    const resolved = view.truncated.find((entry) => entry.section === "checkpoints.resolved");
    expect(resolved).toBeDefined();
    expect(resolved?.omitted).toBe(198 - digests.length);
    expect(resolved?.read).toEqual({ checkpoints: { status: "resolved" } });
    // A digest keeps the decision and the creator's words, never the proof nor the options.
    const first = digests[0] as CheckpointDigest;
    expect(first.resolution?.decision).toBe("approved");
    expect(first).not.toHaveProperty("options");
    expect(first).not.toHaveProperty("untrusted");
    expect(first.options_count).toBeGreaterThanOrEqual(0);
  });

  it("keeps the checkpoint a story waits on, and the ones a sprint cites, however old", () => {
    const full = fullState({ checkpoints: 100, stories: 4, open: 1 });
    // The oldest checkpoint: refused, the story waits on it, with a long note.
    const oldest = Object.values(full.checkpoints).sort((a, b) =>
      a.opened_event < b.opened_event ? -1 : 1,
    )[0] as FullStateView["checkpoints"][string];
    const refused = {
      ...oldest,
      blocks_lifted: false,
      resolution: {
        ...(oldest.resolution as NonNullable<typeof oldest.resolution>),
        decision: "changes_requested" as const,
        note: words("Ce que le créateur veut changer", 1500),
      },
    };
    const story = Object.keys(full.stories)[0] as string;
    const stale = {
      ...full,
      checkpoints: { ...full.checkpoints, [refused.id]: refused },
      stories: {
        ...full.stories,
        [story]: { ...(full.stories[story] as object), waiting_on: [refused.id] },
      },
    } as unknown as FullStateView;
    const view = fitState(stale);
    const kept = view.checkpoints[refused.id] as CheckpointDigest;
    expect(kept.resolution?.decision).toBe("changes_requested");
    // The note is cut, and the cut is flagged: `checkpoint` reads it whole.
    expect(kept.resolution?.note?.endsWith("…")).toBe(true);
    expect(view.truncated.map((entry) => entry.section)).toContain("texts");
    const whole = detail(stale, { checkpoint: refused.id });
    expect(whole).toMatchObject({ detail: "checkpoint" });
    expect((whole as { checkpoint: typeof refused }).checkpoint.resolution?.note).toBe(
      refused.resolution.note,
    );
    // The sprint's own checkpoint is a digest too.
    expect(view.checkpoints[view.sprint.current?.checkpoint ?? ""]).toBeDefined();
  });

  it("bounds the open points to 20, with the counter and the way to read more", () => {
    const full = fullState({ checkpoints: 5, stories: 2, open: 1 });
    const many = {
      ...full,
      open_points: Array.from({ length: 45 }, (_, n) => ({
        kind: "question" as const,
        text: words(`Question ${n}`, 300),
        agent: "alex",
        story: null,
      })),
    };
    const view = fitState(many);
    expect(view.open_points).toHaveLength(20);
    expect(view.open_points[0]).toEqual(many.open_points[0]);
    expect(view.open_points_total).toBe(45);
    const entry = view.truncated.find((item) => item.section === "open_points");
    expect(entry).toMatchObject({ shown: 20, total: 45, omitted: 25 });
    expect(entry?.read).toBeDefined();
  });

  it("shows no truncation on a small state", () => {
    const view = fitState(fullState({ checkpoints: 3, stories: 2, open: 1, delegations: 2 }));
    // Texts of 600 characters are cut, and the external reads (30) are cut to 10.
    expect(view.truncated.map((entry) => entry.section)).toEqual(["session.reads", "texts"]);
    expect(stateSize(view)).toBeLessThan(STATE_MAX_CHARS);
    const quiet = fitState({
      ...fullState({ checkpoints: 1, stories: 0, open: 1, agents: 1, delegations: 0, text: 60 }),
      session: { trusted: true, reads: [] },
      external_reads: { total: 0, recent: [] },
    });
    expect(quiet.truncated).toEqual([]);
  });

  it("keeps the stories not merged, the latest merges and the order of all the merges", () => {
    const full = fullState({ checkpoints: 20, stories: 40, open: 1 });
    const view = abridgeState(full, STATE_LIMITS);
    const merged = Object.entries(full.stories)
      .filter(([, story]) => story.merged !== undefined)
      .sort(([, a], [, b]) => (a.merged?.seq ?? 0) - (b.merged?.seq ?? 0))
      .map(([id]) => id);
    expect(view.merged_order).toEqual(merged);
    expect(merged).toHaveLength(24);
    const notMerged = Object.keys(full.stories).filter((id) => !merged.includes(id));
    for (const id of notMerged) expect(view.stories[id]?.status).toBe(full.stories[id]?.status);
    // Only the latest merges are shown, as digests without the list of files.
    const shownMerged = Object.entries(view.stories).filter(([, story]) => story.merged);
    expect(shownMerged).toHaveLength(STATE_LIMITS.merged);
    expect(shownMerged[0]?.[1].merged?.files_count).toBe(30);
    expect(view.truncated.map((entry) => entry.section)).toContain("stories.merged");
  });

  it("shows first the open checkpoints a story waits on, even the newest ones", () => {
    const full = fullState({ checkpoints: 40, stories: 4, open: 25 });
    const open = Object.values(full.checkpoints)
      .filter((checkpoint) => checkpoint.status === "open")
      .sort((a, b) => (a.opened_event < b.opened_event ? -1 : 1));
    const newest = open[open.length - 1] as FullStateView["checkpoints"][string];
    const story = Object.keys(full.stories)[0] as string;
    const waiting = {
      ...full,
      stories: {
        ...full.stories,
        [story]: { ...(full.stories[story] as object), waiting_on: [newest.id] },
      },
    } as unknown as FullStateView;
    const view = abridgeState(waiting, STATE_LIMITS);
    const shown = Object.values(view.checkpoints).filter((entry) => entry.status === "open");
    expect(shown).toHaveLength(20);
    // The newest one is shown, as the story waits on it; the oldest of the others make room.
    expect(view.checkpoints[newest.id]).toEqual(newest);
    expect(view.checkpoints[(open[19] as { id: string }).id]).toBeUndefined();
    expect(view.truncated.find((entry) => entry.section === "checkpoints.open")?.omitted).toBe(5);
  });

  it("lists the open points of the stories not merged before those of the merged ones", () => {
    const full = fullState({ checkpoints: 5, stories: 10, open: 1 });
    const merged = Object.keys(full.stories).find(
      (id) => full.stories[id]?.merged !== undefined,
    ) as string;
    const live = Object.keys(full.stories).find(
      (id) => full.stories[id]?.merged === undefined,
    ) as string;
    const points = [
      { kind: "question" as const, text: "old", agent: "sam", story: merged },
      { kind: "question" as const, text: "agent", agent: "alex", story: null },
      { kind: "conflict" as const, text: "live", agent: "sam", story: live },
    ];
    const view = abridgeState({ ...full, open_points: points }, STATE_LIMITS);
    expect(view.open_points.map((point) => point.text)).toEqual(["agent", "live", "old"]);
  });

  it("counts the assumptions, the questions and the conflicts of a result it summarizes", () => {
    const view = abridgeState(fullState({ checkpoints: 3, stories: 2, open: 1 }), STATE_LIMITS);
    expect(view.agents.iris?.last_result).toMatchObject({
      assumptions_count: 2,
      open_questions_count: 1,
      conflicts_count: 1,
    });
  });

  it("gives the detail (results, CI, review) to the stories that wait first, not to the lowest ids", () => {
    const full = fullState({ checkpoints: 5, stories: 40, open: 1 });
    const live = Object.keys(full.stories).filter((id) => full.stories[id]?.merged === undefined);
    const last = live[live.length - 1] as string;
    const waiting = {
      ...full,
      stories: {
        ...full.stories,
        [last]: { ...(full.stories[last] as object), waiting_on: ["G-0000000000"] },
      },
    } as unknown as FullStateView;
    const view = abridgeState(waiting, { ...STATE_LIMITS, detailed: 1 });
    expect(view.stories[last]?.ci).toBeDefined();
    expect(view.stories[live[0] as string]?.ci).toBeUndefined();
  });

  it("never lists more merged ids than it should, and says when it still exceeds the limit", () => {
    const full = fullState({ checkpoints: 5, stories: 4, open: 1 });
    const many = Array.from({ length: 400 }, (_, n) => `7-${n + 1}`);
    const stories = { ...full.stories };
    for (const [n, id] of many.entries()) {
      stories[id] = {
        ...(full.stories["1-1"] as object),
        merged: { ...(full.stories["1-1"]?.merged as object), seq: 100 + n, files: [] },
      } as never;
    }
    const view = fitState({ ...full, stories });
    expect(view.merged_order.length).toBeLessThanOrEqual(300);
    expect(view.merged_order.at(-1)).toBe("7-400");
    // A state that still cannot fit says so.
    const huge = fitState({
      ...full,
      agents: Object.fromEntries(
        Array.from({ length: 800 }, (_, n) => [`agent-${n}`, full.agents.iris as never]),
      ),
    });
    if (stateSize(huge) > STATE_MAX_CHARS) {
      expect(huge.truncated.map((entry) => entry.section)).toContain("size_limit");
    }
  });

  it("reads a story whose merge changed a thousand files, in a size that fits", () => {
    const full = fullState({ checkpoints: 5, stories: 4, open: 1 });
    const merged = Object.keys(full.stories).find((id) => full.stories[id]?.merged) as string;
    const story = full.stories[merged] as NonNullable<FullStateView["stories"][string]>;
    const files = Array.from({ length: 1000 }, (_, n) => `src/${"dossier/".repeat(8)}f-${n}.ts`);
    const big = {
      ...full,
      stories: { ...full.stories, [merged]: { ...story, merged: { ...story.merged, files } } },
    } as unknown as FullStateView;
    const result = detail(big, { story: merged });
    if (result.detail !== "story") throw new Error("not a story");
    expect(result.state?.merged?.files).toHaveLength(200);
    expect(result.merged_files_total).toBe(1000);
    expect(stateSize(result)).toBeLessThan(STATE_MAX_CHARS);
  });

  it("handles an empty state and ids that look like object properties", () => {
    const empty = {
      ...fullState({ checkpoints: 0, stories: 0, open: 0, agents: 0, delegations: 0 }),
      open_points: [],
    };
    const view = fitState(empty);
    expect(view.checkpoint_counts.total).toBe(0);
    expect(view.merged_order).toEqual([]);
    expect(stateDetail(empty, { agent: "constructor" })).toEqual({
      found: false,
      option: "agent",
      id: "constructor",
    });
    expect(stateDetail(empty, { story: "1-1" })).toEqual({
      found: false,
      option: "story",
      id: "1-1",
    });
  });

  it("is the same given the same state", () => {
    const full = fullState({ checkpoints: 50, stories: 10, open: 2 });
    expect(abridgeState(full, STATE_LIMITS)).toEqual(abridgeState(full, STATE_LIMITS));
  });

  it("never drops an agent, and shows no cost nor budget of a story", () => {
    const full = fullState({ checkpoints: 30, stories: 120, open: 1 });
    const view = fitState(full);
    expect(view).not.toHaveProperty("costs");
    expect(view).not.toHaveProperty("budgets");
    expect(Object.keys(view.usage).sort()).toEqual(["estimates", "table"]);
    expect(Object.keys(view.agents)).toEqual(Object.keys(full.agents));
  });
});

describe("the options of get_state", () => {
  const full = fullState({ checkpoints: 60, stories: 12, open: 4 });
  const ids = Object.values(full.checkpoints)
    .sort((a, b) => (a.opened_event < b.opened_event ? 1 : -1))
    .map((checkpoint) => checkpoint.id);

  it("checkpoint: one checkpoint in full, the note and the proof of the answer included", () => {
    const resolved = Object.values(full.checkpoints).find(
      (checkpoint) => checkpoint.status === "resolved" && checkpoint.resolution?.note,
    ) as FullStateView["checkpoints"][string];
    const result = detail(full, { checkpoint: resolved.id });
    expect(result).toEqual({ detail: "checkpoint", checkpoint: resolved });
    expect(stateSize(result)).toBeLessThan(STATE_MAX_CHARS);
    expect(stateDetail(full, { checkpoint: "G-0000000000" })).toEqual({
      found: false,
      option: "checkpoint",
      id: "G-0000000000",
    });
  });

  it("checkpoints: a page, newest first, filtered, then the page before", () => {
    const first = detail(full, { checkpoints: { limit: 10 } });
    if (first.detail !== "checkpoints") throw new Error("not a page");
    expect(first.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(ids.slice(0, 10));
    expect(first.total).toBe(60);
    expect(first.next_before).toBe(ids[9]);
    const second = detail(full, {
      checkpoints: { limit: 10, before: first.next_before as string },
    });
    if (second.detail !== "checkpoints") throw new Error("not a page");
    expect(second.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(ids.slice(10, 20));
    // The last page has no next one.
    const last = detail(full, { checkpoints: { limit: 30, before: ids[40] as string } });
    if (last.detail !== "checkpoints") throw new Error("not a page");
    expect(last.checkpoints).toHaveLength(19);
    expect(last.next_before).toBeNull();

    const open = detail(full, { checkpoints: { status: "open" } });
    if (open.detail !== "checkpoints") throw new Error("not a page");
    expect(open.total).toBe(4);
    expect(open.checkpoints.every((checkpoint) => checkpoint.status === "open")).toBe(true);

    const decisions = detail(full, { checkpoints: { type: "decision", status: "resolved" } });
    if (decisions.detail !== "checkpoints") throw new Error("not a page");
    expect(decisions.checkpoints.every((checkpoint) => checkpoint.type === "decision")).toBe(true);
    const story = Object.values(full.checkpoints).find((checkpoint) => checkpoint.story !== null)
      ?.story as string;
    const ofStory = detail(full, { checkpoints: { story } });
    if (ofStory.detail !== "checkpoints") throw new Error("not a page");
    expect(ofStory.checkpoints.length).toBeGreaterThan(0);
    expect(ofStory.checkpoints.every((checkpoint) => checkpoint.story === story)).toBe(true);
    expect(stateSize(detail(full, { checkpoints: { limit: 30 } }))).toBeLessThan(STATE_MAX_CHARS);
  });

  it("checkpoints: pages of long documents lists stay under the limit", () => {
    const heavy = fullState({ checkpoints: 40, stories: 4, open: 0, text: 3000 });
    const page = detail(heavy, { checkpoints: { limit: 30 } });
    expect(stateSize(page)).toBeLessThan(STATE_MAX_CHARS);
  });

  it("agent: its whole last result, its instances and its open points", () => {
    const result = detail(full, { agent: "alex" });
    if (result.detail !== "agent") throw new Error("not an agent");
    expect(result.state).toEqual(full.agents.alex);
    expect(result.state.last_result?.assumptions).toHaveLength(2);
    expect(result.open_points.every((point) => point.agent === "alex")).toBe(true);
    expect(result.open_points.length).toBeGreaterThan(0);
    expect(stateDetail(full, { agent: "nobody" })).toEqual({
      found: false,
      option: "agent",
      id: "nobody",
    });
  });

  it("story: all of it, with its checkpoints, and no cost nor budget", () => {
    const id = "1-1";
    const result = detail(full, { story: id });
    if (result.detail !== "story") throw new Error("not a story");
    expect(result.state).toEqual(full.stories[id]);
    expect(result.state?.merged?.files).toHaveLength(30);
    expect(result).not.toHaveProperty("budget");
    expect(result).not.toHaveProperty("cost");
    expect(result).not.toHaveProperty("usage");
    const own = Object.values(full.checkpoints).filter((checkpoint) => checkpoint.story === id);
    expect(result.checkpoints_total).toBe(own.length);
    for (const checkpoint of own.filter((item) => item.status === "open")) {
      expect(result.checkpoints[checkpoint.id]).toEqual(checkpoint);
    }
    expect(result.instances).toHaveProperty([`sam/${id}`]);
    expect(stateDetail(full, { story: "99-99" })).toEqual({
      found: false,
      option: "story",
      id: "99-99",
    });
  });

  it("story: the deferred work and the deviations that concern it", () => {
    const withRegisters = {
      ...full,
      deferred: {
        open: [
          { id: "D-1", story: null, locks: ["1-2"] },
          { id: "D-2", story: "1-2", locks: [] },
          { id: "D-3", story: "1-3", locks: [] },
        ],
        done: 0,
        dropped: 0,
      },
      deviations: { open: [{ id: "V-1", story: "1-2" }], resolved: 0 },
    } as unknown as FullStateView;
    const result = detail(withRegisters, { story: "1-2" });
    if (result.detail !== "story") throw new Error("not a story");
    expect(result.deferred.map((item) => item.id)).toEqual(["D-1", "D-2"]);
    expect(result.deviations.map((item) => item.id)).toEqual(["V-1"]);
  });

  it("delegations: pages of handovers with their whole brief, newest first", () => {
    const page = detail(full, { delegations: { limit: 4 } });
    if (page.detail !== "delegations") throw new Error("not a page");
    expect(page.delegations.map((entry) => entry.id)).toEqual(
      full.delegations
        .slice(-4)
        .map((entry) => entry.id)
        .reverse(),
    );
    expect(page.delegations[0]?.brief).toBe(full.delegations.at(-1)?.brief);
    expect(page.total).toBe(100);
    const next = detail(full, {
      delegations: { limit: 4, before: page.next_before as string },
    });
    if (next.detail !== "delegations") throw new Error("not a page");
    expect(next.delegations[0]?.id).toBe(full.delegations.at(-5)?.id);
    expect(stateSize(detail(full, { delegations: { limit: 10 } }))).toBeLessThan(STATE_MAX_CHARS);
  });

  it("an option leaves the default state alone: no option, no detail", () => {
    expect(stateDetail(full, {})).toBeUndefined();
  });

  it("fits a state whose open checkpoints alone are too large, and says what it left out", () => {
    const heavy = fullState({ checkpoints: 30, stories: 4, open: 0 });
    const extra: Record<string, FullStateView["checkpoints"][string]> = {};
    for (let n = 0; n < 20; n++) {
      const checkpoint = bigCheckpoint(900 + n, true, 5000, null);
      extra[checkpoint.id] = { ...checkpoint, title: `Ouvert ${ulid(n)}` };
    }
    const state = { ...heavy, checkpoints: { ...heavy.checkpoints, ...extra } };
    const view = fitState(state);
    expect(stateSize(view)).toBeLessThan(STATE_MAX_CHARS);
    const open = Object.values(view.checkpoints).filter(
      (checkpoint) => checkpoint.status === "open",
    );
    // Each one weighs 10 000 characters: the engine shows fewer of them, and says so.
    expect(open.length).toBeGreaterThanOrEqual(1);
    expect(open.length).toBeLessThan(20);
    for (const checkpoint of open) {
      expect(checkpoint).toEqual(state.checkpoints[checkpoint.id]);
    }
    const entry = view.truncated.find((item) => item.section === "checkpoints.open");
    expect(entry?.total).toBe(20);
    expect(entry?.shown).toBe(open.length);
    expect(entry?.read).toEqual({ checkpoints: { status: "open" } });
  });
});
