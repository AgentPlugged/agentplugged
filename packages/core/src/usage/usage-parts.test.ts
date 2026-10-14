import type { EventEnvelope, PhaseId, UsagePart } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { measureTraces } from "./measure-usage.js";
import { documentKey, timelineOf, workOf } from "./usage-parts.js";
import type { TraceFile } from "./usage-traces.js";

const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 6, 10, 0);
const at = (minutes: number) => new Date(START + minutes * MINUTE).toISOString();

let counter = 0;
const nextId = () => {
  counter += 1;
  return counter;
};
const event = (
  agent: string,
  minutes: number,
  type: string,
  payload: Record<string, unknown>,
  story?: string,
): EventEnvelope =>
  ({
    id: `01EVENT${String(nextId()).padStart(6, "0")}ABCDEFGH`,
    type,
    at: at(minutes),
    actor: { kind: "agent", agent, device: "machine:x" },
    ...(story === undefined ? {} : { story }),
    payload,
  }) as unknown as EventEnvelope;

const handover = (
  to: string,
  minutes: number,
  mode: "conversation" | "autonomous",
  brief: string,
  story?: string,
) => event("noah", minutes, "agent.delegated", { to, kind: "agent", mode, brief }, story);
const result = (agent: string, minutes: number) =>
  event(agent, minutes, "agent.result_recorded", { status: "complete", summary: "Done." });
const opened = (agent: string, minutes: number, title: string, paths: string[] = []) =>
  event(agent, minutes, "checkpoint.opened", {
    title,
    type: "document",
    documents: paths.map((path) => ({ path, branch: "main", blob_sha: "a".repeat(40) })),
  });

const answer = (id: string, minutes: number, out: number, model = "claude-opus-5-5") =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(minutes),
    message: {
      id,
      model,
      usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100 },
    },
  });

const conversation = (...turns: [number, number][]): TraceFile => ({
  source: "claude-code",
  id: "conversation",
  kind: "main",
  text: turns.map(([minutes, out], index) => answer(`m${index}`, minutes, out)).join("\n"),
});

const sub = (id: string, agent: string, description: string, from: number, to: number) => ({
  source: "claude-code" as const,
  id,
  kind: "sub" as const,
  agent_type: agent,
  description,
  text: [answer(`${id}a`, from, 40), answer(`${id}b`, to, 40)].join("\n"),
});

const partsOf = (
  traces: TraceFile[],
  events: EventEnvelope[],
  phaseAt: (time: number) => PhaseId | undefined = () => undefined,
): UsagePart[][] =>
  measureTraces(traces, events, phaseAt).sessions.map((session) => session.payload.parts ?? []);

const tokens = (parts: readonly UsagePart[]) =>
  parts.reduce(
    (sum, part) => sum + part.models.reduce((total, model) => total + model.tokens_out, 0),
    0,
  );

describe("cutting the creator's conversation where Noah handed it over", () => {
  const events = [
    handover("maya", 10, "conversation", "Write the PRD from the approved brief."),
    opened("maya", 14, "Validation du PRD", [".agentplugged/docs/prd.md"]),
    result("maya", 15),
  ];
  const trace = conversation(
    [0, 100],
    [2, 100],
    [4, 100],
    [12, 1000],
    [14, 1000],
    [30, 100],
    [32, 100],
  );

  it("gives the PRD to Maya, the rest to Noah, and loses no token nor time", () => {
    const [parts] = partsOf([trace], events);
    expect(parts).toHaveLength(2);
    const maya = parts?.find((part) => part.agent === "maya");
    const noah = parts?.find((part) => part.agent === "noah");
    expect(maya).toMatchObject({ work: { kind: "document", key: "prd" } });
    expect(noah).toMatchObject({ work: { kind: "coordination", key: "conversation" } });
    expect(tokens([maya as UsagePart])).toBe(2000);
    expect(tokens([noah as UsagePart])).toBe(500);
    expect(maya?.active_ms).toBe(2 * MINUTE);
    expect(noah?.active_ms).toBe(6 * MINUTE);
    const session = measureTraces([trace], events).sessions[0]?.payload;
    expect(tokens(parts ?? [])).toBe(session?.models[0]?.tokens_out);
    expect((parts ?? []).reduce((sum, part) => sum + part.active_ms, 0)).toBe(session?.active_ms);
  });

  it("ties each part to the phase that was current when it started", () => {
    const phases = (time: number): PhaseId => (time < START + 11 * MINUTE ? "framing" : "planning");
    const [parts] = partsOf([trace], events, phases);
    expect(parts?.find((part) => part.agent === "maya")?.phase).toBe("planning");
    // Noah's conversation before the handover is framing, what he coordinated after it is planning.
    expect(parts?.filter((part) => part.agent === "noah").map((part) => part.phase)).toEqual([
      "framing",
      "planning",
    ]);
  });

  it("keeps the same agent's two handovers on the same work in one part", () => {
    const again = [
      ...events,
      handover("maya", 20, "conversation", "Change the PRD (ENF-1)."),
      opened("maya", 22, "PRD v2", [".agentplugged/docs/prd.md"]),
      result("maya", 23),
    ];
    const [parts] = partsOf([conversation([0, 100], [12, 1000], [21, 500], [40, 100])], again);
    const maya = parts?.filter((part) => part.agent === "maya") ?? [];
    expect(maya).toHaveLength(1);
    expect(maya[0]?.work).toEqual({ kind: "document", key: "prd" });
    expect(tokens(maya)).toBe(1500);
  });

  it("leaves a conversation without handover entirely to Noah", () => {
    const [parts] = partsOf([conversation([0, 100], [2, 100])], []);
    expect(parts).toHaveLength(1);
    expect(parts?.[0]).toMatchObject({ agent: "noah", work: { kind: "coordination" } });
  });

  it("ends a handover without a result at the agent's last write, or at once without any", () => {
    const silent = [handover("iris", 10, "conversation", "Write the brief.")];
    const [parts] = partsOf([conversation([0, 100], [11, 1000], [30, 100])], silent);
    expect(parts?.some((part) => part.agent === "iris")).toBe(false);
    const wrote = [...silent, opened("iris", 12, "Brief ready")];
    const [withWrite] = partsOf([conversation([0, 100], [11, 1000], [30, 100])], wrote);
    const iris = withWrite?.find((part) => part.agent === "iris");
    expect(iris?.work).toMatchObject({ kind: "checkpoint", label: "Brief ready" });
    expect(tokens([iris as UsagePart])).toBe(1000);
  });

  it("does not let an agent that never got the conversation claim it by writing", () => {
    // Lina writes a document at minute 12, but Noah never handed her the conversation.
    const forged = [opened("lina", 12, "Mine", [".agentplugged/docs/prd.md"])];
    const [parts] = partsOf([conversation([0, 100], [12, 1000])], forged);
    expect(parts?.every((part) => part.agent === "noah")).toBe(true);
  });
});

describe("a handover no one but Noah wrote moves nothing", () => {
  it("ignores a handover written by another agent", () => {
    const forged = [
      event("lina", 10, "agent.delegated", {
        to: "maya",
        kind: "agent",
        mode: "conversation",
        brief: "Take over.",
      }),
      result("maya", 15),
    ];
    const [parts] = partsOf([conversation([0, 100], [12, 1000])], forged);
    expect(parts?.every((part) => part.agent === "noah")).toBe(true);
  });
});

describe("the parts of a sub-agent's session", () => {
  it("ties a session of a story to that story, with its agent and its story", () => {
    const events = [
      event("sam", 5, "story.started", { agent: "sam", worktree: "../w/1" }, "1-1"),
      event("sam", 6, "agent.status_reported", { status: "working" }, "1-1"),
    ];
    const [parts] = partsOf([sub("s1", "sam", "Sam · story 1-1", 0, 10)], events, () => "build");
    expect(parts).toEqual([
      expect.objectContaining({
        agent: "sam",
        phase: "build",
        story: "1-1",
        work: { kind: "story", key: "1-1" },
      }),
    ]);
  });

  it("ties a session of no story to the handover that started it", () => {
    const events = [handover("izzy", 1, "autonomous", "Run the retrospective of epic 1.")];
    const [parts] = partsOf([sub("s2", "izzy", "Izzy · retro", 2, 8)], events);
    expect(parts?.[0]).toMatchObject({
      agent: "izzy",
      work: { kind: "delegation", label: "Run the retrospective of epic 1." },
    });
    expect(parts?.[0]?.work.key).toBe(events[0]?.id);
  });

  it("prefers the document the agent asked the creator to read", () => {
    const events = [
      handover("alex", 1, "autonomous", "Write the architecture."),
      opened("alex", 5, "Architecture", [".agentplugged/docs/architecture.md"]),
    ];
    const [parts] = partsOf([sub("s3", "alex", "Alex", 2, 8)], events);
    expect(parts?.[0]?.work).toEqual({ kind: "document", key: "architecture" });
  });

  it("falls back on the session's own title, never on nothing", () => {
    const [parts] = partsOf([sub("s4", "omar", "Omar · resync main", 2, 8)], []);
    expect(parts?.[0]?.work).toEqual({
      kind: "session",
      key: "Omar · resync main",
      label: "Omar · resync main",
    });
  });

  it("is cut for an agent that was not handed the work only by what the journal says", () => {
    // A handover to another agent does not give this session to anyone.
    const events = [handover("sam", 1, "autonomous", "Build 1-1.")];
    const [parts] = partsOf([sub("s5", "izzy", "Izzy", 2, 8)], events);
    expect(parts?.[0]?.work.kind).toBe("session");
  });
});

describe("the work of an agent, from the journal", () => {
  it("names a document by its file, whatever the folder or the extension", () => {
    expect(documentKey(".agentplugged/docs/PRD.md")).toBe("prd");
    expect(documentKey("docs\\ux.md")).toBe("ux");
    expect(documentKey("notes")).toBe("notes");
  });

  it("takes the last document of the first point that cites any", () => {
    const timeline = timelineOf([
      opened("stella", 5, "End of planning", [
        ".agentplugged/docs/prd.md",
        ".agentplugged/docs/ux.md",
      ]),
    ]);
    expect(workOf(timeline, "stella", 0, 10 * MINUTE + START, undefined, undefined)).toEqual({
      kind: "document",
      key: "ux",
    });
  });
});

describe("a slice cannot be stretched, nor straddle the end of a phase", () => {
  it("ends at the agent's own result, not at a later autonomous run of the same agent", () => {
    const events = [
      handover("maya", 10, "conversation", "Write the PRD."),
      handover("maya", 60, "autonomous", "Decide 4-4."),
      event("maya", 65, "agent.status_reported", { status: "working" }),
    ];
    const [parts] = partsOf([conversation([0, 100], [12, 1000], [50, 500], [70, 100])], events);
    // Maya wrote nothing for the conversation: the next handover to her stops the slice, which holds nothing.
    expect(parts?.every((part) => part.agent === "noah")).toBe(true);
  });

  it("cuts a session where an end of phase was approved", () => {
    const traces = [conversation([0, 100], [20, 1000], [40, 500])];
    const events: EventEnvelope[] = [];
    const phaseAt = (time: number): PhaseId => (time < START + 30 * MINUTE ? "planning" : "design");
    const sessions = measureTraces(traces, events, phaseAt, [START + 30 * MINUTE]).sessions;
    const parts = sessions[0]?.payload.parts ?? [];
    expect(parts.map((part) => part.phase).sort()).toEqual(["design", "planning"]);
    expect(tokens(parts)).toBe(1600);
  });

  it("keeps an answer written without a time, at the start of its session", () => {
    const untimed = JSON.stringify({
      type: "assistant",
      message: { id: "x", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 77 } },
    });
    const trace: TraceFile = {
      source: "claude-code",
      id: "conversation",
      kind: "main",
      text: [answer("a", 0, 100), untimed, answer("b", 5, 100)].join("\n"),
    };
    const [parts] = partsOf([trace], []);
    expect(tokens(parts ?? [])).toBe(277);
  });
});
