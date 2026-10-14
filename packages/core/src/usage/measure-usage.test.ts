import type { EventEnvelope } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { journalFacts, measureTraces, sameMeasure, storyNamedBy, tieOf } from "./measure-usage.js";
import type { TraceSummary } from "./trace-readers.js";
import type { TraceFile } from "./usage-traces.js";

const measure = (traces: TraceFile[], events: EventEnvelope[]) =>
  measureTraces(traces, events).sessions;

/** A sprint holding these stories: the journal then knows them. */
const sprintOf = (...ids: string[]) =>
  event("izzy", undefined, 0, "sprint.planned", { stories: ids.map((id) => ({ id })) });

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 6, 10, minutes)).toISOString();

const event = (
  agent: string,
  story: string | undefined,
  minutes: number,
  type = "agent.status_reported",
  payload: Record<string, unknown> = {},
): EventEnvelope =>
  ({
    id: `E${agent}${minutes}${type}`,
    type,
    at: at(minutes),
    actor: { kind: "agent", agent, device: "machine:x" },
    ...(story === undefined ? {} : { story }),
    payload,
  }) as unknown as EventEnvelope;

const answer = (id: string, minutes: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(minutes),
    message: {
      id,
      model: "claude-opus-5-5",
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 },
    },
  });

const sub = (
  id: string,
  agent: string,
  description: string,
  from: number,
  to: number,
  extra: Partial<TraceFile> = {},
): TraceFile => ({
  source: "claude-code",
  id,
  kind: "sub",
  agent_type: agent,
  description,
  text: [answer(`${id}a`, from), answer(`${id}b`, to)].join("\n"),
  ...extra,
});

const SUMMARY: TraceSummary = {
  started_at: at(0),
  ended_at: at(30),
  active_ms: 0,
  models: [],
  answers: [],
  times: [],
};

describe("tying a session to its story", () => {
  const stories = new Set(["4-2", "4-3"]);

  it("reads the story a title names, never a sprint's or an epic's", () => {
    expect(storyNamedBy("Lina · story 4-3", stories)).toBe("4-3");
    expect(storyNamedBy("Quentin · revue 4-1 passe 2", new Set(["4-1"]))).toBe("4-1");
    expect(storyNamedBy("Izzy · sprint 4-2", stories)).toBeUndefined();
    expect(storyNamedBy("Izzy · epic 4-2", stories)).toBeUndefined();
    expect(storyNamedBy("Lina · story 9-9", stories)).toBeUndefined();
    expect(storyNamedBy("version 14-3x", new Set(["4-3"]))).toBeUndefined();
    expect(storyNamedBy(undefined, stories)).toBeUndefined();
  });

  it("ties a session to the story its agent wrote on while it ran, by the journal", () => {
    const journal = journalFacts([
      sprintOf("4-2", "4-3"),
      event("lina", "4-2", 5),
      event("lina", "4-2", 9),
      event("lina", "4-3", 12),
    ]);
    const tie = tieOf(sub("a", "lina", "no title", 0, 30), SUMMARY, journal);
    expect(tie).toEqual({ story: "4-2", agent: "lina", basis: "journal" });
  });

  it("uses the title to tell apart two sessions of one agent running together", () => {
    const events = [
      sprintOf("4-2", "4-3"),
      event("lina", "4-2", 5),
      event("lina", "4-2", 6),
      event("lina", "4-2", 7),
      event("lina", "4-3", 12),
    ];
    const journal = journalFacts(events);
    const second = tieOf(sub("b", "lina", "Lina · story 4-3", 0, 30), SUMMARY, journal);
    expect(second).toEqual({ story: "4-3", agent: "lina", basis: "journal" });
  });

  it("keeps the title's story when the agent only wrote on another one, and ignores a story no one started", () => {
    const journal = journalFacts([
      event("lina", "4-3", 5),
      event("lina", "4-3", 6),
      event("lina", "9-9", 7),
      event("sam", "4-2", 1, "story.started", { agent: "sam", worktree: "../w/4-2" }),
      event("sam", "4-3", 1, "story.started", { agent: "sam", worktree: "../w/4-3" }),
    ]);
    // The title names 4-2 (given by whoever started the session); writing on 4-3 does not move it.
    const named = tieOf(sub("a", "lina", "Lina · story 4-2", 0, 30), SUMMARY, journal);
    expect(named).toEqual({ story: "4-2", agent: "lina", basis: "label" });
    // 9-9 is no story: no sprint holds it and no developer started it.
    const invented = journalFacts([event("lina", "9-9", 5), event("lina", "9-9", 6)]);
    expect(tieOf(sub("b", "lina", "Lina", 0, 30), SUMMARY, invented)).toEqual({
      story: null,
      agent: "lina",
      basis: "none",
    });
  });

  it("takes the story a title names even when it was never planned, if an event names it", () => {
    // « Lina · story 2-4 » ran a story the journal only knows from what the agents wrote on it.
    const journal = journalFacts([event("lina", "2-4", 5), event("lina", "2-5", 6)]);
    const tie = tieOf(sub("a", "lina", "Lina · story 2-4", 0, 30), SUMMARY, journal);
    expect(tie).toEqual({ story: "2-4", agent: "lina", basis: "label" });
  });

  it("knows the stories of a sprint too", () => {
    const planned = event("izzy", undefined, 0, "sprint.planned", {
      stories: [{ id: "4-2" }, { id: "4-3" }],
    });
    const journal = journalFacts([planned, event("lina", "4-3", 5)]);
    expect(tieOf(sub("a", "lina", "Lina", 0, 30), SUMMARY, journal).story).toBe("4-3");
  });

  it("counts a session once when the product's folder and a story's working copy both hold it", () => {
    const started = event("sam", "1-1", 0, "story.started", { agent: "sam", worktree: "../w/1" });
    const root = sub("same", "sam", "Sam · story 1-1", 0, 10);
    const copy = sub("same", "sam", "Sam · story 1-1", 0, 10, { worktree: "../w/1" });
    const { sessions } = measureTraces([root, copy], [started]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.story).toBe("1-1");
  });

  it("counts a trace it cannot read and goes on with the others", () => {
    const broken = { ...sub("broken", "sam", "Sam", 0, 10), text: undefined as unknown as string };
    const fine = sub("fine", "sam", "Sam", 0, 10);
    const result = measureTraces([broken, fine], []);
    expect(result.skipped).toBe(1);
    expect(result.sessions.map((session) => session.payload.session)).toEqual(["fine"]);
  });

  it("does not read again a trace the adapter says did not change", () => {
    const unchanged = { ...sub("old", "sam", "Sam", 0, 10), unchanged: true, text: "" };
    expect(measureTraces([unchanged], []).sessions).toEqual([]);
  });

  it("ignores what another agent wrote, and what was written outside the session", () => {
    const journal = journalFacts([
      sprintOf("4-2"),
      event("sam", "4-2", 5),
      event("lina", "4-2", 300),
    ]);
    const tie = tieOf(sub("a", "lina", "Lina · planning", 0, 30), SUMMARY, journal);
    expect(tie).toEqual({ story: null, agent: "lina", basis: "none" });
  });

  it("falls back on the title when the journal is silent", () => {
    const journal = journalFacts([sprintOf("4-3"), event("sam", "4-3", 5)]);
    const tie = tieOf(sub("a", "lina", "Lina · story 4-3", 0, 30), SUMMARY, journal);
    expect(tie).toEqual({ story: "4-3", agent: "lina", basis: "label" });
  });

  it("ties a session of a story's working copy to that story", () => {
    const started = event("hugo", "4-2", 0, "story.started", {
      agent: "hugo",
      worktree: "../site.worktrees/4-2",
    });
    const main: TraceFile = {
      source: "claude-code",
      id: "conv",
      kind: "main",
      worktree: "../site.worktrees/4-2",
      text: "",
    };
    expect(tieOf(main, SUMMARY, journalFacts([started]))).toEqual({
      story: "4-2",
      agent: "hugo",
      basis: "journal",
    });
  });

  it("leaves the creator's own conversation tied to no story, still measured", () => {
    const main: TraceFile = {
      source: "claude-code",
      id: "conv",
      kind: "main",
      text: [answer("m1", 0), answer("m2", 5)].join("\n"),
    };
    const measured = measure([main], [sprintOf("4-2"), event("lina", "4-2", 1)]);
    expect(measured).toHaveLength(1);
    expect(measured[0]).toMatchObject({
      story: null,
      payload: { agent: "main", basis: "none", session: "conv", source: "claude-code" },
    });
  });

  it("does not let an agent hide a session by writing nothing: it still counts, outside the stories", () => {
    const silent = sub("quiet", "sam", "Sam · work", 0, 10);
    const measured = measure([silent], []);
    expect(measured[0]?.story).toBeNull();
    expect(measured[0]?.payload.models[0]?.tokens_out).toBe(40);
  });

  it("counts a plug-in's agent under main, and leaves out a trace whose name breaks the schema", () => {
    const plugin = sub("agent-p1", "brand-voice:writer", "Writer", 0, 10);
    const odd = sub("a name with spaces", "lina", "Lina", 0, 10);
    const measured = measure([plugin, odd], []);
    expect(measured).toHaveLength(1);
    expect(measured[0]?.payload).toMatchObject({ session: "agent-p1", agent: "main" });
  });

  it("reads a Codex rollout with the same tie", () => {
    const rollout: TraceFile = {
      source: "codex",
      id: "rollout-1",
      kind: "main",
      worktree: "../w/1",
      text: JSON.stringify({
        timestamp: at(0),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } },
        },
      }),
    };
    const started = event("sam", "1-1", 0, "story.started", { agent: "sam", worktree: "../w/1" });
    const measured = measure([rollout], [started]);
    expect(measured[0]).toMatchObject({ story: "1-1", payload: { source: "codex", agent: "sam" } });
  });

  it("is the same measure when nothing changed, a different one when the session grew", () => {
    const trace = sub("a", "lina", "Lina · story 4-3", 0, 10);
    const [first] = measure([trace], [event("lina", "4-3", 2)]);
    if (first === undefined) throw new Error("not measured");
    const held = {
      source: first.payload.source,
      session: first.payload.session,
      story: first.story,
      agent: first.payload.agent,
      basis: first.payload.basis,
      started_at: first.payload.started_at,
      ended_at: first.payload.ended_at,
      active_ms: first.payload.active_ms,
      models: first.payload.models,
      parts: first.payload.parts,
      at: at(0),
      event: "E",
    };
    expect(sameMeasure(first, held)).toBe(true);
    const grown = sub("a", "lina", "Lina · story 4-3", 0, 12);
    const [second] = measure([grown], [event("lina", "4-3", 2)]);
    expect(second && sameMeasure(second, held)).toBe(false);
    expect(sameMeasure(first, undefined)).toBe(false);
  });
});
