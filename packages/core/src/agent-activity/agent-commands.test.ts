import { toBase64url } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AGENT_REDUCERS,
  type AgentStateView,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  profileCommand,
  type RecordedEvent,
  resolveProfile,
  type ToolProbe,
} from "../index.js";
import { emptyDraft } from "../projection/reducers.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { withTimeZone } from "../testing/time-zone.js";
import { clockView } from "./agent-commands.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(7));

/** The tools the MCP server must expose, and nothing else. */
const WHITELIST = [
  "report_status",
  "report_progress",
  "report_cost",
  "update_story",
  "submit_result",
  "open_checkpoint",
  "report_measures",
  "get_state",
  "read_sensitive",
  "write_sensitive",
  "record_external_read",
  "request_action",
  "check_action",
  "check_write",
  "check_call",
  "plan_sprint",
  "defer_work",
  "complete_deferred",
  "sync_requirements",
  "record_proof",
  "settle_gap",
  "submit_audit",
  "critique",
  "ready",
  "round_table",
  "correct_course",
  "run_proof_command",
  "record_criterion",
  "loop",
  "review_tests",
  "acceptance_qa",
  "start_story",
  "leave_fast_track",
  "open_pull_request",
  "check_ci",
  "report_deviation",
  "lift_deviation",
  "get_trace",
  "answer_checkpoint",
  "decide_checkpoint",
  "request_creator_action",
  "workshop",
  "next",
  "delegate",
  "summarize",
  "pause_team",
  "start_review",
  "submit_review",
  "export_review",
  "triage_review",
  "get_review",
  "publish_review",
  "ask_creator",
  "open_stack",
  "ask_stack",
  "answer_stack",
  "read_memory",
  "propose_retrospective",
  "record_lessons",
  "propose_promotion",
  "promote_lesson",
  "get_merge_order",
  "qualify_merge_conflict",
  "measure_usage",
  "check_environment",
];

/** A clock that moves 1 s per call. */
function clock() {
  let now = Date.UTC(2026, 9, 3, 12, 0, 0);
  return () => {
    now += 1000;
    return now;
  };
}

async function product(preset: "new-product" | "maintenance" = "new-product") {
  const files = new MemoryFiles();
  // The keychain holds the machine key and, once `init` ran, the product key.
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now: clock() });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    keys,
  };
  const init = await initCommand.run(human, { profile: resolveProfile(preset) });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", journal };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown> = {}) =>
    registry.run(name, agent, input);
  const state = async () => {
    const result = await call("get_state", { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  return { files, journal, human, agent, registry, call, state };
}

describe("agents' commands", () => {
  it("are exactly the whitelist, reserved to agents", async () => {
    const { registry, human, call } = await product();
    expect(registry.agentCommands().map((command) => command.name)).toEqual(WHITELIST);
    for (const command of registry.agentCommands()) {
      expect(command.description, command.name).toBeTruthy();
      expect(command.inputSchema, command.name).toBeDefined();
      // `next` is the creator's command and an agent's: two commands, one name.
      if (command.name !== "next") expect(registry.names()).not.toContain(command.name);
    }
    // The creator's CLI never writes an agent's event, and an agent never runs init or sync.
    const byHuman = await registry.run("report_status", human, {
      agent: "iris",
      status: "working",
    });
    expect(byHuman.ok ? undefined : byHuman.error.code).toBe(ErrorCode.UNKNOWN_COMMAND);
    for (const name of ["init", "sync", "profile", "agent", "journal"]) {
      const result = await call(name, {});
      expect(result.ok ? undefined : result.error.code, name).toBe(ErrorCode.UNKNOWN_COMMAND);
    }
  });

  it("report_status writes a signed agent event that get_state shows", async () => {
    const { journal, call, state } = await product();
    const result = await call("report_status", { agent: "iris", status: "working", task: "brief" });
    expect(result.ok).toBe(true);
    const recorded = (result as { value: RecordedEvent }).value;
    expect(recorded.type).toBe("agent.status_reported");

    const events = journal.events;
    // The machine's key and the product come first, written by the journal itself.
    expect(events.map((event) => event.type)).toEqual([
      "device.registered",
      "product.created",
      "agent.status_reported",
    ]);
    const event = events.at(-1);
    expect(event?.id).toBe(recorded.id);
    expect(event?.actor).toEqual({
      kind: "agent",
      device: events[0]?.actor.device,
      agent: "iris",
    });
    expect(event?.payload).toEqual({ status: "working", task: "brief" });
    expect(event?.provenance).toBe("untrusted");

    // Signature and chain verify: the projection applies every event.
    const projection = await computeProjection(events);
    expect(projection.applied).toBe(3);
    expect(projection.ignored).toEqual([]);

    const view = await state();
    expect(view.agents.iris).toEqual({
      status: "working",
      task: "brief",
      story: null,
      last_signal_at: event?.at,
      last_result: null,
    });
  });

  it("refuses an actor or kind given in the input, writing nothing", async () => {
    const { journal, call } = await product();
    for (const extra of [{ actor: { kind: "human" } }, { kind: "human" }]) {
      const result = await call("report_status", { agent: "iris", status: "idle", ...extra });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
      expect(result.error.details.field).toBe(Object.keys(extra)[0]);
    }
    expect(journal.events).toEqual([]);
  });

  it("refuses an unknown or inactive agent with AGENT_NOT_FOUND, writing nothing", async () => {
    const { journal, call, human } = await product();
    const ghost = await call("report_status", { agent: "ghost", status: "working" });
    expect(ghost.ok ? undefined : ghost.error.toPayload()).toEqual({
      code: ErrorCode.AGENT_NOT_FOUND,
      message_key: "error.agent_not_active",
      details: { id: "ghost" },
    });
    // The maintenance profile leaves Iris out.
    const changed = await profileCommand.run(human, { profile: resolveProfile("maintenance") });
    expect(changed.ok).toBe(true);
    const inactive = await call("report_status", { agent: "iris", status: "working" });
    expect(inactive.ok ? undefined : inactive.error.code).toBe(ErrorCode.AGENT_NOT_FOUND);
    expect(journal.events).toEqual([]);
  });

  it("records progress, story status, costs and the structured result", async () => {
    const { call, state, journal } = await product();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["report_status", { agent: "iris", status: "working", task: "brief", story: "2-6" }],
      ["update_story", { agent: "iris", story: "2-6", status: "in_progress" }],
      ["report_progress", { agent: "iris", story: "2-6", percent: 40, note: "Interviews done" }],
      ["report_cost", { agent: "iris", story: "2-6", usd: 0.1, estimated: false, tokens_in: 10 }],
      ["report_cost", { agent: "iris", story: "2-6", usd: 0.2, estimated: false }],
      ["report_cost", { agent: "iris", usd: 1.5, estimated: true, tokens_out: 5 }],
      [
        "submit_result",
        {
          agent: "iris",
          story: "2-6",
          status: "partial",
          summary: "Brief drafted.",
          assumptions: ["B2B market"],
          open_questions: ["Which pricing?"],
          conflicts: ["Two target users"],
        },
      ],
      [
        "submit_result",
        {
          agent: "iris",
          status: "complete",
          summary: "Notes tidied.",
          assumptions: [],
          open_questions: ["Rename the product?"],
          conflicts: [],
        },
      ],
    ];
    for (const [name, input] of calls) {
      const result = await call(name, input);
      expect(result.ok, `${name}: ${result.ok ? "" : result.error.code}`).toBe(true);
    }
    const view = await state();
    const story = view.stories["2-6"];
    expect(story?.status).toBe("in_progress");
    expect(story?.status_by?.agent).toBe("iris");
    expect(story?.progress).toMatchObject({ agent: "iris", percent: 40, note: "Interviews done" });
    expect(story?.results?.iris).toMatchObject({ status: "partial", story: "2-6", agent: "iris" });
    expect(view.agents.iris?.last_result).toMatchObject({ status: "complete", story: null });
    // The costs declared are kept in the journal (encrypted) and never shown by get_state.
    expect(journal.events.filter((event) => event.type === "cost.reported")).toHaveLength(3);
    expect(view).not.toHaveProperty("costs");
    expect(view).not.toHaveProperty("budgets");
    expect(view.open_points).toEqual([
      { kind: "question", text: "Which pricing?", agent: "iris", story: "2-6" },
      { kind: "conflict", text: "Two target users", agent: "iris", story: "2-6" },
      { kind: "question", text: "Rename the product?", agent: "iris", story: null },
    ]);
  });

  it("refuses an invalid result or status, writing nothing", async () => {
    const { journal, call } = await product();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["submit_result", { agent: "iris", status: "complete", summary: "x" }, "assumptions"],
      [
        "submit_result",
        {
          agent: "iris",
          status: "done",
          summary: "x",
          assumptions: [],
          open_questions: [],
          conflicts: [],
        },
        "status",
      ],
      ["update_story", { agent: "iris", story: "2-6", status: "done" }, "status"],
      ["report_progress", { agent: "iris", story: "__proto__", note: "x" }, "story"],
      ["report_cost", { agent: "iris", estimated: true }, "(root)"],
      ["get_state", { agent: "iris" }, "agent"],
    ];
    for (const [name, input, field] of cases) {
      const result = await call(name, input);
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      expect(result.error.code, name).toBe(ErrorCode.INVALID_ARGUMENTS);
      expect(result.error.details.field, name).toBe(field);
    }
    expect(journal.events).toEqual([]);
  });

  it("accepts the reserved id main, the tool's main session", async () => {
    const { call, state } = await product();
    const result = await call("report_status", { agent: "main", status: "working" });
    expect(result.ok).toBe(true);
    expect((await state()).agents.main?.status).toBe("working");
  });

  it("refuses a story id that is not <epic>-<story>", async () => {
    const { journal, call } = await product();
    for (const story of ["2.6", "story-2-6", "constructor"]) {
      const result = await call("update_story", { agent: "iris", story, status: "in_review" });
      expect(result.ok ? undefined : result.error.details.field, story).toBe("story");
    }
    expect(journal.events).toEqual([]);
  });

  it("keeps the last result of each agent on a story: one never erases the other's", async () => {
    const { call, state } = await product();
    const result = (agent: string, question: string) => ({
      agent,
      story: "2-6",
      status: "partial",
      summary: "Done in part.",
      assumptions: [],
      open_questions: [question],
      conflicts: [],
    });
    for (const input of [
      result("iris", "Which pricing?"),
      result("main", "Which market?"),
      result("iris", "Which channel?"),
    ]) {
      expect((await call("submit_result", input)).ok).toBe(true);
    }
    const view = await state();
    expect(Object.keys(view.stories["2-6"]?.results ?? {}).sort()).toEqual(["iris", "main"]);
    expect(view.open_points).toEqual([
      { kind: "question", text: "Which channel?", agent: "iris", story: "2-6" },
      { kind: "question", text: "Which market?", agent: "main", story: "2-6" },
    ]);
  });

  it("ignores a cost reported by another actor than an agent", async () => {
    const { journal, call, state } = await product();
    expect((await call("report_status", { agent: "iris", status: "idle" })).ok).toBe(true);
    const product_id = journal.events[0]?.product as string;
    await journal.append({
      type: "cost.reported",
      actor: { kind: "system" },
      product: product_id,
      provenance: "trusted",
      payload: { usd: 5, estimated: false },
    });
    expect((await computeProjection(journal.events)).ignored).toEqual([]);
    expect(await state()).not.toHaveProperty("costs");
  });

  it("caps tokens at a billion per report, and totals at the largest safe integer", async () => {
    const { call } = await product();
    const over = await call("report_cost", {
      agent: "iris",
      estimated: true,
      tokens_in: 1_000_000_001,
    });
    expect(over.ok ? undefined : over.error.details.field).toBe("tokens_in");
    const reducer = AGENT_REDUCERS["cost.reported"];
    const near = Number.MAX_SAFE_INTEGER - 10;
    const totals = { usd: 0, usd_estimated: 0, tokens_in: near, tokens_out: 0, reports: 1 };
    const draft = {
      ...emptyDraft(),
      state: { costs: { total: totals, by_story: {} } } as Record<string, unknown>,
    };
    reducer?.(draft, {
      v: 1,
      id: "01JZ0000000000000000000001",
      type: "cost.reported",
      at: "2026-10-03T12:00:00.000Z",
      actor: { kind: "agent", device: "machine:AAAAAAAAAAAAAAAA", agent: "iris" },
      product: "01JZ0000000000000000000000",
      provenance: "untrusted",
      prev: null,
      payload: { estimated: true, tokens_in: 1_000_000_000 },
      alg: "ed25519",
      sig: "",
    });
    expect(totals.tokens_in).toBe(Number.MAX_SAFE_INTEGER);
    expect(totals.reports).toBe(2);
  });

  it("needs the method installed", async () => {
    const journal = new MemoryStateStore({ keys: new MemoryKeyStore(SEED) });
    const registry = createCommandRegistry();
    const context: CommandContext = {
      files: new MemoryFiles(),
      tools: NO_TOOL,
      method: shippedMethod(),
      actor: "agent",
      engineVersion: "1.0.0",
      journal,
    };
    for (const [name, input] of [
      ["report_status", { agent: "iris", status: "idle" }],
      ["get_state", {}],
    ] as const) {
      const result = await registry.run(name, context, input);
      expect(result.ok ? undefined : result.error.code, name).toBe(ErrorCode.METHOD_NOT_INSTALLED);
    }
  });

  it("tells the creator's clock: local time, zone and offset, not only UTC", () => {
    const cases: Array<[string, number, string, string]> = [
      ["America/New_York", Date.UTC(2026, 6, 3, 12, 5, 9), "2026-07-03 08:05:09 -04:00", "-04:00"],
      ["Asia/Kolkata", Date.UTC(2026, 6, 3, 12, 5, 9), "2026-07-03 17:35:09 +05:30", "+05:30"],
      // Paris leaves summer time on 25 October 2026, at 01:00 UTC.
      ["Europe/Paris", Date.UTC(2026, 9, 25, 0, 30, 0), "2026-10-25 02:30:00 +02:00", "+02:00"],
      ["Europe/Paris", Date.UTC(2026, 9, 25, 1, 30, 0), "2026-10-25 02:30:00 +01:00", "+01:00"],
      ["UTC", Date.UTC(2026, 6, 3, 12, 5, 9), "2026-07-03 12:05:09 +00:00", "+00:00"],
    ];
    for (const [zone, instant, local, offset] of cases) {
      const view = withTimeZone(zone, () => clockView(instant));
      expect(view.now, zone).toBe(new Date(instant).toISOString());
      expect(view.now_local, zone).toBe(local);
      expect(view.utc_offset, zone).toBe(offset);
      // ICU may name Kolkata by its old alias.
      expect([zone, "Asia/Calcutta"], zone).toContain(view.time_zone);
    }
  });

  it("gives an empty state before any event", async () => {
    const { state, files } = await product();
    const view = await state();
    expect(view).toEqual({
      // The engine that answers.
      engine_version: expect.any(String),
      clock: {
        now: expect.stringMatching(/Z$/),
        now_local: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/),
        time_zone: expect.any(String),
        utc_offset: expect.stringMatching(/^[+-]\d{2}:\d{2}$/),
      },
      product: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      journal_head: null,
      agents: {},
      instances: {},
      stories: {},
      merged_order: [],
      checkpoints: {},
      checkpoint_counts: { open: 0, resolved: 0, waived: 0, closed: 0, total: 0 },
      open_points: [],
      open_points_total: 0,
      warnings: [],
      journey: { skipped: [], skipped_total: 0 },
      git: expect.objectContaining({ chosen: false }),
      phase: {
        current: "framing",
        status: "in_progress",
        since: null,
        phases: [
          { id: "framing", status: "in_progress" },
          { id: "planning", status: "upcoming" },
          { id: "design", status: "upcoming" },
          { id: "build", status: "upcoming" },
          { id: "delivery", status: "upcoming" },
          { id: "launch", status: "upcoming" },
        ],
        stray: [],
      },
      // No session in this context: untrusted, by caution.
      session: { trusted: false, reads: [] },
      external_reads: { total: 0, recent: [] },
      sprint: { current: null, latest: null },
      deferred: { open: [], done: 0, dropped: 0 },
      deviations: { open: [], resolved: 0 },
      // Only the estimates are shown, from the method's reference.
      usage: {
        table: {
          version: "2026-10-17",
          as_of: "2026-10-17",
          source:
            "https://platform.claude.com/docs/en/about-claude/pricing and https://ai.google.dev/gemini-api/docs/pricing",
        },
        estimates: {
          standard: { low: 2, expected: 6, high: 14, basis: "reference", stories: 0 },
          fast: { low: 0.3, expected: 1, high: 4, basis: "reference", stories: 0 },
          guard: { low: 0.1, high: 42, factor: 3 },
        },
      },
      validation: {
        mode: "chat",
        source: "working_copy",
        warning: null,
        unpublished: null,
        proof: "unverified",
        review: [],
        elicitation: false,
        channels: { available: ["chat"], elicitation: "unavailable", question_tool: "unavailable" },
        points: {
          configured: false,
          fixed: ["framing", "architecture", "breakdown", "merge", "release", "publication"],
          delegated: [],
          proposed: ["framing", "architecture", "release", "publication"],
        },
      },
      stacks: [],
      installs: {
        mode: "visible",
        source: "working_copy",
        warning: null,
        declared: {},
        recent: [],
      },
      delegations: [],
      exchanges: [],
      truncated: [],
    });
    expect(files.files.get(".agentplugged/method.yaml")).toContain(`product_id: ${view.product}`);
  });

  it("skips the phases the maintenance profile turns off, in get_state and open_checkpoint", async () => {
    const { call, state, journal } = await product("maintenance");
    const view = await state();
    expect(view.phase).toMatchObject({ current: "build", status: "in_progress", since: null });
    expect(view.phase.phases.map((phase) => phase.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "in_progress",
      "upcoming",
      "skipped",
    ]);
    const end = (phase: string, agent = "main") =>
      call("open_checkpoint", {
        agent,
        type: "phase_end",
        phase,
        risk: "low",
        title: `End of ${phase}`,
        summary: "Ready.",
      });
    const before = journal.events.length;
    // A skipped phase is never current; no closer of the build is active, so the main session.
    for (const phase of ["design", "framing"]) {
      const refused = await end(phase);
      expect(!refused.ok && refused.error.code, phase).toBe(ErrorCode.PHASE_NOT_CURRENT);
      expect(!refused.ok && refused.error.details, phase).toMatchObject({
        current: "build",
        reason: "not_current",
      });
    }
    // Iris is not active in this profile.
    const inactive = await end("build", "iris");
    expect(!inactive.ok && inactive.error.code).toBe(ErrorCode.AGENT_NOT_FOUND);
    expect(journal.events.length).toBe(before);
    const opened = await end("build");
    expect(opened.ok).toBe(true);
    expect((await state()).phase).toMatchObject({ current: "build", status: "in_review" });
  });
});
