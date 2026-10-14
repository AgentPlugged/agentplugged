import {
  type EventEnvelope,
  PHASE_IDS,
  type PhaseId,
  USAGE_STEPS,
  type UsagePart,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { NEXT_STEPS } from "../next/next.js";
import { measureTraces } from "./measure-usage.js";
import { habitsOf } from "./session-habits.js";
import { readClaudeTranscript } from "./trace-readers.js";
import { skillAt, skillBoundaries, stepOf, toolSkillSpans } from "./usage-attribution.js";
import type { TraceFile } from "./usage-traces.js";

const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 13, 10, 0);
const at = (minutes: number) => new Date(START + minutes * MINUTE).toISOString();

let counter = 0;
const event = (
  agent: string,
  minutes: number,
  type: string,
  payload: Record<string, unknown>,
  story?: string,
): EventEnvelope => {
  counter += 1;
  return {
    id: `01EVENT${String(counter).padStart(6, "0")}ABCDEFGH`,
    type,
    at: at(minutes),
    actor: { kind: "agent", agent, device: "machine:x" },
    ...(story === undefined ? {} : { story }),
    payload,
  } as unknown as EventEnvelope;
};

const answer = (id: string, minutes: number, out: number, content: unknown[] = []) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(minutes),
    message: {
      id,
      model: "claude-opus-5-5",
      content,
      usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100 },
    },
  });
const skillCall = (id: string, skill: string) => ({
  type: "tool_use",
  id,
  name: "Skill",
  input: { skill },
});
const prompt = (minutes: number, text = "Go on") =>
  JSON.stringify({
    type: "user",
    timestamp: at(minutes),
    message: { role: "user", content: text },
  });
const toolResult = (minutes: number, id: string, text: string, isError = false) =>
  JSON.stringify({
    type: "user",
    timestamp: at(minutes),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }],
    },
  });

const trace = (lines: string[], over: Partial<TraceFile> = {}): TraceFile => ({
  source: "claude-code",
  id: "s1",
  kind: "main",
  text: lines.join("\n"),
  ...over,
});

const partsOf = (
  traces: TraceFile[],
  events: EventEnvelope[],
  phaseAt: (time: number) => PhaseId | undefined = () => undefined,
): UsagePart[] =>
  measureTraces(traces, events, phaseAt).sessions.flatMap((session) => session.payload.parts ?? []);

const out = (parts: readonly UsagePart[]) =>
  parts.reduce(
    (sum, part) => sum + part.models.reduce((total, model) => total + model.tokens_out, 0),
    0,
  );

describe("the skills the tool says it ran (Claude Code's Skill call)", () => {
  const lines = [
    prompt(0, "Write the PRD"),
    answer("a0", 1, 10),
    answer("a1", 2, 100, [skillCall("tool-1", "write-prd")]),
    answer("a2", 3, 200),
    prompt(5, "Thanks, now something else"),
    answer("a3", 6, 1000),
  ];

  it("reads each call once, and the messages the creator typed", () => {
    const summary = readClaudeTranscript(lines.join("\n"));
    expect(summary.skillCalls).toEqual([{ at: START + 2 * MINUTE, skill: "write-prd" }]);
    expect(summary.prompts).toEqual([START, START + 5 * MINUTE]);
  });

  it("counts a call written again for each block of its answer once", () => {
    const again = [...lines.slice(0, 3), lines[2] as string, ...lines.slice(3)];
    expect(readClaudeTranscript(again.join("\n")).skillCalls).toHaveLength(1);
  });

  it("ignores a message the tool wrote itself and a tool's result when it looks for the end of a skill", () => {
    const meta = JSON.stringify({
      type: "user",
      isMeta: true,
      timestamp: at(2.5),
      message: { role: "user", content: "Base directory for this skill: …" },
    });
    const summary = readClaudeTranscript(
      [lines[0], lines[1], lines[2], meta, toolResult(2.6, "tool-1", "ok")].join("\n"),
    );
    expect(summary.prompts).toEqual([START]);
  });

  it("does not take what the tool writes itself (a task's notice, a reminder) for a message the creator typed", () => {
    const notice = JSON.stringify({
      type: "user",
      timestamp: at(2.2),
      message: {
        role: "user",
        content: "<task-notification> <task-id>1</task-id></task-notification>",
      },
    });
    const reminder = JSON.stringify({
      type: "user",
      timestamp: at(2.4),
      message: {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }],
      },
    });
    const summary = readClaudeTranscript(
      [lines[0], lines[1], lines[2], notice, reminder].join("\n"),
    );
    expect(summary.prompts).toEqual([START]);
  });

  it("ends a skill at the next skill or at the next message of the creator, whichever is first", () => {
    const spans = toolSkillSpans(
      [
        { at: 10, skill: "a" },
        { at: 30, skill: "b" },
      ],
      [20, 50],
    );
    expect(spans.map((span) => [span.skill, span.from, span.to, span.origin])).toEqual([
      ["a", 10, 20, "tool"],
      ["b", 30, 50, "tool"],
    ]);
    expect(toolSkillSpans([{ at: 1, skill: "a" }], [])[0]?.to).toBe(Number.POSITIVE_INFINITY);
  });

  it("attributes the slice after the call to the skill, origin tool, and the rest to none, losing no token", () => {
    const parts = partsOf([trace(lines)], []);
    const skilled = parts.filter((part) => part.skill?.name === "write-prd");
    expect(skilled.map((part) => part.skill?.origin)).toEqual(["tool"]);
    expect(out(skilled)).toBe(300);
    expect(out(parts.filter((part) => part.skill === undefined))).toBe(1010);
    expect(out(parts)).toBe(1310);
  });
});

describe("the skills the journal bounds (report_status with a skill)", () => {
  const events = [
    event("lina", 0, "agent.status_reported", { status: "working", skill: "develop-story" }, "2-6"),
    event("lina", 4, "agent.status_reported", { status: "working", task: "tests" }, "2-6"),
    event("lina", 9, "agent.result_recorded", { status: "complete", summary: "Done." }, "2-6"),
  ];
  const lines = [
    answer("b0", 1, 10),
    answer("b1", 3, 20),
    answer("b2", 5, 400),
    answer("b3", 8, 800),
  ];
  const sub = trace(lines, {
    id: "sub1",
    kind: "sub",
    agent_type: "lina",
    description: "Lina 2-6",
  });

  it("attributes to the skill what ran between its start and the agent's next report, origin interval", () => {
    const parts = partsOf([sub], events);
    const skilled = parts.filter((part) => part.skill !== undefined);
    expect(skilled).toHaveLength(1);
    expect(skilled[0]?.skill).toEqual({ name: "develop-story", origin: "interval" });
    expect(out(skilled)).toBe(30);
    expect(out(parts)).toBe(1230);
  });

  it("never applies an agent's skill to another agent's work", () => {
    const other = trace(lines, { id: "sub2", kind: "sub", agent_type: "sam", description: "Sam" });
    expect(partsOf([other], events).every((part) => part.skill === undefined)).toBe(true);
  });

  it("closes a skill never ended at the agent's last write, not at the end of the session", () => {
    const open = [
      event("lina", 0, "agent.status_reported", { status: "working", skill: "x-skill" }),
      event("lina", 6, "agent.progress_reported", { note: "still at it" }, "2-6"),
    ];
    const parts = partsOf([sub], open);
    // Answers at 1, 3 and 5 minutes; the agent's last write at 6 closes it, the answer at 8 is outside.
    expect(out(parts.filter((part) => part.skill !== undefined))).toBe(10 + 20 + 400);
    expect(out(parts)).toBe(1230);
  });

  it("lets the span the journal bounds win over the tool's, whose end is only deduced", () => {
    const named = trace(
      [
        answer("c0", 1, 10, [skillCall("t1", "from-the-tool")]),
        answer("c1", 3, 20),
        answer("c2", 12, 400),
      ],
      { id: "sub3", kind: "sub", agent_type: "lina", description: "Lina" },
    );
    const parts = partsOf([named], events);
    // Minutes 1 and 3 are inside what the agent reported (0 to 4); minute 12 is after it.
    expect(out(parts.filter((part) => part.skill?.name === "develop-story"))).toBe(30);
    expect(out(parts.filter((part) => part.skill?.name === "from-the-tool"))).toBe(400);
  });

  it("keeps the same skill reached two ways as two parts, never merged", () => {
    const both = trace(
      [
        answer("d0", 1, 10),
        answer("d1", 6, 20, [skillCall("t1", "develop-story")]),
        answer("d2", 7, 30),
      ],
      { id: "sub4", kind: "sub", agent_type: "lina", description: "Lina" },
    );
    const parts = partsOf([both], events);
    const origins = parts
      .filter((part) => part.skill?.name === "develop-story")
      .map((p) => p.skill?.origin);
    expect(origins.sort()).toEqual(["interval", "tool"]);
  });
});

describe("the step of a part", () => {
  it("is always a step `state.next` knows, and every phase is one", () => {
    for (const step of USAGE_STEPS) expect(NEXT_STEPS as readonly string[]).toContain(step);
    for (const phase of PHASE_IDS) expect(USAGE_STEPS as readonly string[]).toContain(phase);
  });

  const base = { agent: "lina", phase: undefined, story: undefined, work: { kind: "session" } };
  it("is the build for a story's developer and the review for another agent of that story", () => {
    expect(stepOf({ ...base, story: "2-6" })).toEqual({ name: "build", origin: "interval" });
    expect(stepOf({ ...base, agent: "quentin", story: "2-6" })).toEqual({
      name: "review",
      origin: "interval",
    });
    expect(stepOf({ ...base, agent: "omar", story: "2-6" })?.name).toBe("delivery");
  });

  it("is the phase the creator's approvals say was current, else nothing", () => {
    expect(stepOf({ ...base, agent: "maya", phase: "planning" })).toEqual({
      name: "planning",
      origin: "interval",
    });
    expect(stepOf({ ...base, agent: "maya" })).toBeUndefined();
  });

  it("is none for the creator's conversation with Noah, whatever the phase", () => {
    expect(
      stepOf({ ...base, agent: "noah", phase: "design", work: { kind: "coordination" } }),
    ).toBeUndefined();
  });

  it("gives no step to an agent on a story that neither builds, reviews nor delivers it", () => {
    expect(stepOf({ ...base, agent: "noah", story: "2-6" })).toBeUndefined();
    expect(stepOf({ ...base, agent: "chloe", story: "2-6" })?.name).toBe("review");
    expect(stepOf({ ...base, agent: "noah", story: "2-6", phase: "build" })?.name).toBe("build");
  });

  it("is carried by the parts, in the order of the phases", () => {
    const sub = trace([answer("e0", 1, 10), answer("e1", 2, 20)], {
      id: "sub5",
      kind: "sub",
      agent_type: "maya",
      description: "Maya brief",
    });
    const parts = partsOf([sub], [], () => "planning");
    expect(parts.every((part) => part.step?.name === "planning")).toBe(true);
  });
});

describe("a part never straddles a UTC midnight", () => {
  it("cuts a session that goes on past midnight in two parts, losing no token", () => {
    const late = Date.UTC(2026, 9, 13, 23, 50);
    const stamp = (time: number, id: string, out: number) =>
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(time).toISOString(),
        message: {
          id,
          model: "claude-opus-5-5",
          content: [],
          usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 1 },
        },
      });
    const parts = partsOf(
      [
        trace([stamp(late, "m0", 10), stamp(late + 20 * MINUTE, "m1", 20)], {
          id: "sub9",
          kind: "sub",
          agent_type: "maya",
          description: "Maya",
        }),
      ],
      [],
      () => "planning",
    );
    expect(parts.map((part) => part.started_at.slice(0, 10))).toEqual(["2026-10-13", "2026-10-14"]);
    expect(out(parts)).toBe(30);
  });
});

describe("the boundaries of skills", () => {
  it("lists the instants inside a slice where a skill starts or ends, without infinity", () => {
    const spans = {
      tool: toolSkillSpans([{ at: 5, skill: "a" }], [7]),
      journal: [{ from: 8, to: 12, skill: "b", origin: "interval" as const, agent: "lina" }],
    };
    expect(skillBoundaries(spans, "lina", 0, 20)).toEqual([5, 7, 8, 12]);
    expect(skillBoundaries(spans, "sam", 0, 20)).toEqual([5, 7]);
    expect(skillAt(9, spans, "lina")).toEqual({ name: "b", origin: "interval" });
    expect(skillAt(6, spans, "lina")).toEqual({ name: "a", origin: "tool" });
    expect(skillAt(1, spans, "lina")).toBeUndefined();
  });
});

describe("what made a session dearer than it needed to be", () => {
  const read = (id: string, path: string) => ({
    type: "tool_use",
    id,
    name: "Read",
    input: { file_path: path },
  });
  const call = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} });
  const lines = [
    answer("h0", 1, 1, [skillCall("k1", "write-prd"), read("r1", "C:\\p\\a.ts")]),
    toolResult(1, "r1", "x".repeat(400)),
    answer("h1", 2, 1, [skillCall("k2", "write-prd"), read("r2", "C:/p/a.ts")]),
    toolResult(2, "r2", "x".repeat(400)),
    answer("h2", 3, 1, [read("r3", "C:/p/a.ts"), read("r4", "C:/p/b.ts")]),
    toolResult(3, "r3", "x".repeat(400)),
    toolResult(3, "r4", "y".repeat(10)),
    answer("h3", 4, 1, [call("m1", "mcp__x__fetch"), call("m2", "mcp__x__fetch")]),
    toolResult(4, "m1", "boom", true),
    toolResult(4, "m2", "boom", true),
    answer("h4", 5, 1, [call("m3", "mcp__x__fetch")]),
    toolResult(5, "m3", "boom", true),
  ];

  it("names the skills loaded twice, the files read three times and the tools failing three times", () => {
    expect(habitsOf(lines.join("\n"))).toEqual({
      skills_reloaded: [{ skill: "write-prd", calls: 2 }],
      files_reread: [{ path: "C:/p/a.ts", reads: 3, chars: 800 }],
      tools_failing: [{ tool: "mcp__x__fetch", calls: 3, errors: 3 }],
    });
  });

  it("does not call a tool failing when it fails a small share of its many calls", () => {
    const many = Array.from({ length: 40 }, (_, index) => [
      answer(`z${index}`, 1, 1, [call(`z-${index}`, "Bash")]),
      toolResult(1, `z-${index}`, "x", index < 4),
    ]).flat();
    expect(habitsOf(many.join("\n")).tools_failing).toEqual([]);
  });

  it("does not count a big file read by pieces, nor a file read again after the session wrote it", () => {
    const piece = (id: string, offset: number) => ({
      type: "tool_use",
      id,
      name: "Read",
      input: { file_path: "src/big.ts", offset, limit: 100 },
    });
    const edit = { type: "tool_use", id: "w1", name: "Edit", input: { file_path: "src/a.ts" } };
    const rows = [
      answer("p0", 1, 1, [piece("a", 0), piece("b", 100), piece("c", 200), read("d", "src/a.ts")]),
      toolResult(1, "a", "x"),
      answer("p1", 2, 1, [
        read("e", "src/a.ts"),
        edit,
        read("f", "src/a.ts"),
        read("g", "src/a.ts"),
      ]),
    ];
    expect(habitsOf(rows.join("\n")).files_reread).toEqual([]);
  });

  it("keeps a skill's name as the tool writes it and cleans a path, in the habits", () => {
    const dirty = "a\u001b[31m.ts";
    const rows = [
      answer("q0", 1, 1, [skillCall("k1", "/write-prd"), skillCall("k2", "write-prd")]),
      answer("q1", 2, 1, [read("r1", dirty), read("r2", dirty), read("r3", dirty)]),
    ];
    const found = habitsOf(rows.join("\n"));
    expect(found.skills_reloaded).toEqual([{ skill: "write-prd", calls: 2 }]);
    expect(found.files_reread[0]?.path).toBe("a [31m.ts");
  });

  it("finds nothing in a short session, as empty lists and not as a verdict", () => {
    expect(habitsOf(lines.slice(0, 2).join("\n"))).toEqual({
      skills_reloaded: [],
      files_reread: [],
      tools_failing: [],
    });
  });
});
