import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import {
  ErrorCode,
  MAX_MEMORY_LINES,
  MAX_SESSION_MEMORY_LINES,
  MAX_TABLE_AGENTS,
  MAX_TABLE_GUESTS,
  RECALLED_MEMORY_LINES,
  type RoundTableCall,
  RoundTableInputSchema,
  TABLE_EVENT_TYPES,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentNextResult,
  type CommandContext,
  createCommandRegistry,
  createUlidFactory,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  ResponseMemory,
  type RoundTableResult,
  resolveProfile,
  shapeResponse,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { computeProjection } from "../projection/compute-projection.js";
import type { ProjectionDraft } from "../projection/reducers.js";
import { TABLE_REDUCERS } from "../projection/table-reducers.js";
import { checkpointState } from "../testing/checkpoint-state.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";
import {
  memoryPath,
  parseMemory,
  recalledMemory,
  renderMemory,
  roomPath,
  withMemory,
} from "./rooms.js";
import { tableNextOf } from "./table-next.js";
import {
  gestureOwner,
  sensitiveStory,
  tableCandidate,
  tableOffer,
  threeViewsAgents,
  validateClosing,
  validateProposal,
  withOffer,
} from "./table-rules.js";

/**
 * The round table of agents in the chat: who may sit, what a closing must hold, the
 * gesture and who takes it over, the three views of a sensitive story offered once, and nothing of
 * the Room (no debate kept, no positions, no several humans).
 */

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(7));

function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

const PRD_PATH = ".agentplugged/docs/prd.md";
const PRD = ["---", "id: prd", "kind: prd", "owner: iris", "---", "# PRD", ""].join("\n");

/** A product whose team is Noah, Maya, Omar, Quentin and Sam (no Izzy unless asked). */
async function product(options: { izzy?: boolean } = {}) {
  const files = new MemoryFiles();
  let clock = Date.UTC(2026, 9, 12, 9, 0, 0);
  const now = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now, newId: createUlidFactory({ now }) });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("noah", "Noah", "product", "framing"),
      ...shippedAgent("maya", "Maya", "product", "planning"),
      ...shippedAgent("omar", "Omar", "delivery", "delivery"),
      ...shippedAgent("quentin", "Quentin", "quality", "build"),
      ...shippedAgent("sam", "Sam", "code", "build"),
      ...(options.izzy === true ? shippedAgent("izzy", "Izzy", "product", "build") : {}),
    }),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  /** A call as the rules read it (flat), sent as the tool takes it: the table, and the quote beside. */
  const table = (input: Record<string, unknown>) => {
    const { quote, ...record } = input;
    return call("round_table", {
      agent: "noah",
      table: record,
      ...(quote === undefined ? {} : { quote }),
    });
  };
  const closing = async (input: Record<string, unknown>) => {
    const result = await table(input);
    if (!result.ok) throw new Error(`round_table failed: ${JSON.stringify(result.error)}`);
    return result.value as RoundTableResult;
  };
  return { files, journal, call, table, closing };
}

const AGENTS = [
  { id: "maya", why: "owns the product question" },
  { id: "quentin", why: "will have to test it" },
];

const SYNTHESIS = {
  topic: "Do we ship the export before the import?",
  agreed: ["Export first: it is what the first customers ask for."],
  disputed: ["Quentin wants the import tested first; Maya does not."],
  advice: "Ship the export, test the import in the next sprint.",
};

const QUOTE = "Ok, on part sur l'export et tu ouvres la décision.";

const reasonOf = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? "" : String((result.error as { details: { reason: string } }).details.reason);

describe("a round table closes with its synthesis and a gesture", () => {
  it("writes who sat and why, the synthesis, the gesture and the creator's words, never the debate", async () => {
    const { closing, journal } = await product();
    const result = await closing({
      agents: AGENTS,
      synthesis: SYNTHESIS,
      gesture: { type: "none" },
      quote: QUOTE,
    });
    expect(result).toEqual({ gesture: "none" });
    const event = journal.events.find((entry) => entry.type === TABLE_EVENT_TYPES.closed);
    expect(event?.actor).toMatchObject({ kind: "agent", agent: "noah" });
    expect(event?.payload).toEqual({
      topic: SYNTHESIS.topic,
      agents: AGENTS,
      agreed: SYNTHESIS.agreed,
      disputed: SYNTHESIS.disputed,
      advice: SYNTHESIS.advice,
      gesture: { type: "none" },
      quote: QUOTE,
    });
    // The debate has no place in the record: a turn, a position, a participant are refused.
    const whole = {
      agent: "noah",
      table: { agents: AGENTS, synthesis: SYNTHESIS, gesture: { type: "none" } },
      quote: QUOTE,
    };
    expect(RoundTableInputSchema.safeParse(whole).success).toBe(true);
    for (const stray of ["turns", "positions", "participants", "humans", "transcript"]) {
      for (const input of [
        { ...whole, [stray]: "x" },
        { ...whole, table: { ...whole.table, [stray]: "x" } },
        { ...whole, table: { ...whole.table, synthesis: { ...SYNTHESIS, [stray]: "x" } } },
      ]) {
        expect(RoundTableInputSchema.safeParse(input).success, stray).toBe(false);
      }
    }
  });

  it("seats at least two, each agent present, each for a reason, Noah never", async () => {
    const { table } = await product();
    const base = { synthesis: SYNTHESIS, gesture: { type: "none" }, quote: QUOTE };
    const alone = await table({ ...base, agents: [AGENTS[0]] });
    expect(reasonOf(alone)).toContain("seats_count:2+");
    // Everyone of the team may sit: no ceiling of four.
    const team = await table({
      ...base,
      agents: ["maya", "omar", "quentin", "sam"].map((id) => ({ id, why: "relevant" })),
    });
    expect(team.ok).toBe(true);
    const withNoah = await table({
      ...base,
      agents: [AGENTS[0], { id: "noah", why: "leads the table" }],
    });
    expect(reasonOf(withNoah)).toContain("agent_leads:noah");
    const absent = await table({
      ...base,
      agents: [AGENTS[0], { id: "stella", why: "would know the screen" }],
    });
    expect(reasonOf(absent)).toContain("agent_absent:stella");
    const twice = await table({ ...base, agents: [AGENTS[0], AGENTS[0]] });
    expect(reasonOf(twice)).toContain("agent_twice:maya");
    const unmotivated = await table({
      ...base,
      agents: [AGENTS[0], { id: "quentin", why: "" }],
    });
    expect(unmotivated.ok).toBe(false);
  });

  it("refuses a closing without a synthesis that says something, a gesture or the creator's words", async () => {
    const { table, journal } = await product();
    const bare = await table({
      agents: AGENTS,
      synthesis: { topic: "Anything?", advice: "Nothing." },
    });
    const reason = reasonOf(bare);
    for (const missing of ["synthesis_empty", "gesture_missing", "quote_missing"]) {
      expect(reason).toContain(missing);
    }
    // Nothing was written by the refusal.
    expect(journal.events.some((event) => event.type === TABLE_EVENT_TYPES.closed)).toBe(false);
  });

  it("hands a decision to the agent at the table the engine is told, and only to one of them", async () => {
    const { table, closing } = await product();
    const input = {
      agents: AGENTS,
      synthesis: SYNTHESIS,
      quote: QUOTE,
    };
    const stranger = await table({
      ...input,
      gesture: { type: "decision", subject: "Export first?", owner: "omar" },
    });
    expect(reasonOf(stranger)).toContain("gesture:owner_not_at_table");
    const unsaid = await table({ ...input, gesture: { type: "decision" } });
    expect(reasonOf(unsaid)).toContain("gesture:subject_missing");
    expect(reasonOf(unsaid)).toContain("gesture:owner_missing");
    const result = await closing({
      ...input,
      gesture: { type: "decision", subject: "Export before import?", owner: "maya" },
    });
    expect(result).toEqual({
      gesture: "decision",
      owner: "maya",
      subject: "Export before import?",
      advice: SYNTHESIS.advice,
    });
  });

  it("hands a story to Izzy, who must be there", async () => {
    const gesture = { type: "story", subject: "Export the data as CSV" };
    const without = await product();
    const refused = await without.table({
      agents: AGENTS,
      synthesis: SYNTHESIS,
      gesture,
      quote: QUOTE,
    });
    expect(reasonOf(refused)).toContain("agent_absent:izzy");
    const withIzzy = await product({ izzy: true });
    const result = await withIzzy.closing({
      agents: AGENTS,
      synthesis: SYNTHESIS,
      gesture,
      quote: QUOTE,
    });
    expect(result).toMatchObject({ gesture: "story", owner: "izzy", subject: gesture.subject });
    // Nobody else is chosen for it.
    const chosen = await withIzzy.table({
      agents: AGENTS,
      synthesis: SYNTHESIS,
      gesture: { ...gesture, owner: "maya" },
      quote: QUOTE,
    });
    expect(reasonOf(chosen)).toContain("gesture:owner_is_not_chosen");
  });

  it("asks the author of a document to update it, and the creator when no author is there", async () => {
    const { files, table, closing } = await product();
    files.seed(PRD_PATH, PRD.replace("owner: iris", "owner: maya"));
    const input = { agents: AGENTS, synthesis: SYNTHESIS, quote: QUOTE };
    const result = await closing({ ...input, gesture: { type: "document", subject: PRD_PATH } });
    expect(result).toMatchObject({ gesture: "document", owner: "maya", subject: PRD_PATH });
    // The author is not in the team: only proposals go to the creator, nothing is changed.
    files.seed(PRD_PATH, PRD.replace("owner: iris", "owner: stella"));
    const orphan = await closing({ ...input, gesture: { type: "document", subject: PRD_PATH } });
    expect(orphan.owner).toBe("creator");
    // Only a document of the product, that exists.
    const missing = await table({
      ...input,
      gesture: { type: "document", subject: ".agentplugged/docs/ux.md" },
    });
    expect(reasonOf(missing)).toContain("gesture:document_missing");
    const outside = await table({
      ...input,
      gesture: { type: "document", subject: ".agentplugged/docs/../../secret.md" },
    });
    expect(reasonOf(outside)).toContain("gesture:document_out_of_docs");
    const code = await table({ ...input, gesture: { type: "document", subject: "src/app.ts" } });
    expect(reasonOf(code)).toContain("gesture:document_out_of_docs");
    // The path is read and recorded one way: normalised.
    const odd = await closing({
      ...input,
      gesture: { type: "document", subject: "./.agentplugged\\docs\\prd.md" },
    });
    expect(odd.subject).toBe(PRD_PATH);
    const hole = await table({
      ...input,
      gesture: { type: "document", subject: ".agentplugged/docs//prd.md" },
    });
    expect(reasonOf(hole)).toContain("gesture:document_out_of_docs");
    // Nothing of the creator's text is rewritten by the table.
    expect(await files.readText(PRD_PATH)).toBe(PRD.replace("owner: iris", "owner: stella"));
  });

  it("opens no point, writes no story and no document: it only hands the gesture over", async () => {
    const { closing, journal, files } = await product({ izzy: true });
    const before = [...journal.events];
    await closing({
      agents: AGENTS,
      synthesis: SYNTHESIS,
      gesture: { type: "story", subject: "Export the data as CSV" },
      quote: QUOTE,
    });
    const added = journal.events.filter((event) => !before.includes(event));
    expect(added.map((event) => event.type)).toEqual([TABLE_EVENT_TYPES.closed]);
    expect(await files.exists(".agentplugged/stories/1-1-export.md")).toBe(false);
  });
});

/** A state with one story whose latest review pass found these reasons of security. */
const mergePoint = (story: string) =>
  checkpointState("M1", { type: "story", story, source: "merge" });

const stateWith = (reasons: string[], offered?: string[], merge = true) => ({
  stories: { "1-1": { review: { passes: [{ security: { reasons } }] } } },
  ...(merge ? { checkpoints: { M1: mergePoint("1-1") } } : {}),
  ...(offered === undefined ? {} : { tables: { offered } }),
});

const ACTIVE = new Set(["noah", "maya", "omar", "quentin", "sam"]);

describe("the three views of a sensitive story, offered once", () => {
  it("offers them for the merge of a sensitive story, with product, delivery and quality in order", () => {
    const state = stateWith(["paths"]);
    expect(sensitiveStory(state, "1-1")).toBe(true);
    const story = tableCandidate(state, mergePoint("1-1"));
    expect(story).toBe("1-1");
    expect(tableOffer("1-1", ACTIVE)).toEqual({
      format: "three_views",
      story: "1-1",
      agents: ["maya", "omar", "quentin"],
    });
  });

  it("offers nothing for a story at no risk, for a point that is not a merge, or past an offer", () => {
    expect(tableCandidate(stateWith([]), mergePoint("1-1"))).toBeUndefined();
    expect(tableCandidate({ stories: {} }, mergePoint("1-1"))).toBeUndefined();
    const document = checkpointState("D1", { type: "document", story: null, source: null });
    expect(tableCandidate(stateWith(["words"]), document)).toBeUndefined();
    expect(tableCandidate(stateWith(["words"]), undefined)).toBeUndefined();
    // Once per story, whatever the creator answered.
    expect(tableCandidate(stateWith(["words"], ["1-1"]), mergePoint("1-1"))).toBeUndefined();
  });

  it("offers nothing when the team lacks one of the three sides", () => {
    expect(threeViewsAgents(new Set(["maya", "quentin"]))).toBeUndefined();
    expect(tableOffer("1-1", new Set(["maya", "quentin"]))).toBeUndefined();
  });

  it("records the offer once per story and remembers a bounded number of them", () => {
    expect(withOffer([], "1-1")).toEqual(["1-1"]);
    expect(withOffer(["1-1"], "1-1")).toEqual(["1-1"]);
    let offered: string[] = [];
    for (let n = 1; n <= 100; n += 1) offered = withOffer(offered, `${n}-1`);
    expect(offered).toHaveLength(80);
    expect(offered.at(-1)).toBe("100-1");
  });

  it("refuses the offer of an unknown story, of a story at no risk, and a second one", async () => {
    const { table } = await product();
    expect(reasonOf(await table({ story: "9-9" }))).toContain("story_unknown");
    const facts = { active: ACTIVE, prepared: undefined };
    const input = { agent: "noah", story: "1-1" } as RoundTableCall;
    expect(validateProposal(input, { ...facts, state: stateWith(["paths"]) })).toEqual([]);
    expect(validateProposal(input, { ...facts, state: stateWith([]) })).toEqual([
      "story_not_sensitive",
    ]);
    expect(validateProposal(input, { ...facts, state: stateWith(["paths"], ["1-1"]) })).toEqual([
      "already_offered",
    ]);
    // What `next` would not offer is not recorded either: no merge waiting, a team without a side.
    expect(
      validateProposal(input, { ...facts, state: stateWith(["paths"], undefined, false) }),
    ).toEqual(["merge_not_waiting"]);
    expect(
      validateProposal(input, {
        ...facts,
        active: new Set(["noah", "maya", "quentin"]),
        state: stateWith(["paths"]),
      }),
    ).toEqual(["team_incomplete"]);
    // The offer carries nothing else.
    expect(
      validateProposal({ ...input, quote: "oui" }, { ...facts, state: stateWith(["paths"]) }),
    ).toEqual(["unexpected:quote"]);
  });

  it("closes the format with one agent per side, and marks the story as held", () => {
    const facts = { active: ACTIVE, prepared: undefined, state: stateWith(["paths"]) };
    const input = {
      agent: "noah",
      story: "1-1",
      agents: [
        { id: "maya", why: "does it serve the promise?", angle: "product" },
        { id: "omar", why: "can it ship safely?", angle: "delivery" },
        { id: "quentin", why: "is it tested?", angle: "quality" },
      ],
      synthesis: { ...SYNTHESIS, format: "three_views" },
      gesture: { type: "none" },
      quote: QUOTE,
    } as RoundTableCall;
    expect(validateClosing(input, facts)).toEqual([]);
    // Two sides at the same angle, or an angle outside the format.
    const twice = {
      ...input,
      agents: input.agents?.map((agent) => ({ ...agent, angle: "quality" })),
    } as RoundTableCall;
    expect(validateClosing(twice, facts)).toContain("three_views:one_agent_per_angle");
    const noStory = { ...input, story: undefined } as RoundTableCall;
    expect(validateClosing(noStory, facts)).toContain("three_views:story_missing");
    const unknown = validateClosing(input, { ...facts, state: { stories: {} } });
    expect(unknown).toContain("story_unknown");
    const loose = { ...input, synthesis: SYNTHESIS } as RoundTableCall;
    expect(validateClosing(loose, facts)).toContain("angle_without_format");
    expect(validateClosing(loose, facts)).toContain("unexpected:story");
  });

  it("takes a call with a closing's fields but no synthesis for a closing, never for an offer", async () => {
    const { table } = await product();
    const bare = await table({ story: "1-1", agents: AGENTS, gesture: { type: "none" } });
    const reason = reasonOf(bare);
    expect(reason).toContain("round_table: close:");
    expect(reason).toContain("synthesis_empty");
    expect(reason).toContain("quote_missing");
    expect(reason).not.toContain("story_missing");
  });

  it("marks the story as offered when the offer or the three views are recorded", () => {
    const draft = { state: {}, ignored: [] } as unknown as ProjectionDraft;
    const actor = { kind: "agent", agent: "noah" };
    const proposed = TABLE_REDUCERS[TABLE_EVENT_TYPES.proposed];
    proposed?.(draft, { id: "E1", actor, payload: { story: "1-1" } } as never);
    expect(draft.state.tables).toEqual({ offered: ["1-1"] });
    const closed = TABLE_REDUCERS[TABLE_EVENT_TYPES.closed];
    closed?.(draft, {
      id: "E2",
      actor,
      payload: { format: "three_views", story: "2-1" },
    } as never);
    expect(draft.state.tables).toEqual({ offered: ["1-1", "2-1"] });
    // An ordinary table leaves the state as it was: the debate is not kept.
    closed?.(draft, { id: "E3", actor, payload: { topic: "x" } } as never);
    expect(draft.state.tables).toEqual({ offered: ["1-1", "2-1"] });
    // Only an agent's event counts.
    proposed?.(draft, {
      id: "E4",
      actor: { kind: "human" },
      payload: { story: "3-1" },
    } as never);
    expect(draft.state.tables).toEqual({ offered: ["1-1", "2-1"] });
    expect(draft.ignored).toEqual([{ id: "E4", reason: "invalid" }]);
  });

  it("puts the offer in the step of the merge, and drops it once recorded", async () => {
    const step = { step: "validation", checkpoint: "M1" } as never;
    const team = async () => ACTIVE as ReadonlySet<string>;
    expect(await tableNextOf(stateWith(["paths"]), step, team)).toEqual({
      table: { format: "three_views", story: "1-1", agents: ["maya", "omar", "quentin"] },
    });
    // Recorded: never again. Another step, a story at no risk, a team without a side: nothing.
    expect(await tableNextOf(stateWith(["paths"], ["1-1"]), step, team)).toEqual({});
    expect(
      await tableNextOf(stateWith(["paths"]), { step: "build", checkpoint: null } as never, team),
    ).toEqual({});
    let asked = false;
    const spy = async () => {
      asked = true;
      return ACTIVE as ReadonlySet<string>;
    };
    expect(await tableNextOf(stateWith([]), step, spy)).toEqual({});
    // The team is read only for a story to offer.
    expect(asked).toBe(false);
    expect(
      await tableNextOf(stateWith(["paths"]), step, async () => new Set(["maya", "quentin"])),
    ).toEqual({});
  });

  it("says the offer once per session in the answer of the step", () => {
    const memory = new ResponseMemory();
    const offer = { format: "three_views", story: "1-1", agents: ["maya", "omar", "quentin"] };
    const next = () =>
      shapeResponse("state", "next", { step: "validation", table: offer } as never, memory) as {
        table?: unknown;
      };
    expect(next().table).toEqual(offer);
    expect(next().table).toBeUndefined();
  });

  it("replays the offer from the journal: the projection keeps the story, only for an agent's event", async () => {
    const { journal } = await product();
    const productId = journal.events[0]?.product as string;
    const draft = (actor: { kind: string; agent?: string }) => ({
      type: TABLE_EVENT_TYPES.proposed,
      actor,
      product: productId,
      provenance: "trusted" as const,
      payload: { story: "1-1" },
    });
    await journal.append(draft({ kind: "system" }) as never);
    expect((await computeProjection(journal.events)).state.tables).toBeUndefined();
    await journal.append(draft({ kind: "agent", agent: "noah" }) as never);
    const projected = await computeProjection(journal.events);
    expect(projected.state.tables).toEqual({ offered: ["1-1"] });
    expect(projected.ignored).toHaveLength(1);
    // The step no longer offers a story whose offer the journal holds.
    const state = { ...stateWith(["paths"]), tables: projected.state.tables };
    const step = { step: "validation", checkpoint: "M1" } as never;
    expect(await tableNextOf(state, step, async () => ACTIVE)).toEqual({});
  });

  it("says nothing of the three views in the step when no sensitive merge waits", async () => {
    const { call } = await product();
    const next = await call("next", {});
    expect(next.ok).toBe(true);
    expect((next.ok ? (next.value as AgentNextResult) : {}) as object).not.toHaveProperty("table");
  });
});

describe("who takes the gesture over", () => {
  const input = (gesture: RoundTableCall["gesture"]) =>
    ({ agent: "noah", agents: AGENTS, gesture }) as RoundTableCall;
  const facts = {
    active: new Set(["maya", "izzy", "iris"]),
    prepared: { documentExists: true, documentOwner: "iris" },
  };

  it("names the table's agent, Izzy, the author of the document, or no one", () => {
    expect(gestureOwner(input({ type: "decision", subject: "q", owner: "maya" }), facts)).toBe(
      "maya",
    );
    expect(gestureOwner(input({ type: "story", subject: "t" }), facts)).toBe("izzy");
    expect(gestureOwner(input({ type: "document", subject: PRD_PATH }), facts)).toBe("iris");
    expect(
      gestureOwner(input({ type: "document", subject: PRD_PATH }), {
        ...facts,
        prepared: { documentExists: true, documentOwner: undefined },
      }),
    ).toBe("creator");
    expect(gestureOwner(input({ type: "none" }), facts)).toBeUndefined();
  });
});

describe("this engine holds nothing of a live debate", () => {
  it("writes only events of the table, never a generic extension of a module", async () => {
    const { closing, journal } = await product({ izzy: true });
    const before = journal.events.length;
    await closing({
      agents: AGENTS,
      synthesis: SYNTHESIS,
      gesture: { type: "story", subject: "Export the data as CSV" },
      quote: QUOTE,
    });
    const types = journal.events.slice(before).map((event) => event.type);
    expect(types).toEqual(["table.closed"]);
    expect(types.some((type) => type.startsWith("x."))).toBe(false);
  });

  it("keeps no position, no participant other than the team's agents, no live state", async () => {
    const { closing, journal } = await product();
    await closing({
      agents: AGENTS,
      synthesis: SYNTHESIS,
      gesture: { type: "none" },
      quote: QUOTE,
    });
    const event = journal.events.find((entry) => entry.type === TABLE_EVENT_TYPES.closed);
    expect(Object.keys(event?.payload as object).sort()).toEqual([
      "advice",
      "agents",
      "agreed",
      "disputed",
      "gesture",
      "quote",
      "topic",
    ]);
  });

  it("lets Noah lead the table and no other agent, the main session included", async () => {
    const { call, journal } = await product();
    const closing = {
      table: { agents: AGENTS, synthesis: SYNTHESIS, gesture: { type: "none" } },
      quote: QUOTE,
    };
    for (const agent of ["maya", "quentin", "main"]) {
      const refused = await call("round_table", { agent, ...closing });
      expect(refused.ok ? "" : refused.error.code, agent).toBe(ErrorCode.ROLE_FORBIDDEN);
    }
    expect(journal.events.some((event) => event.type === TABLE_EVENT_TYPES.closed)).toBe(false);
    // Noah reaches the engine's own checks (here: an unknown story).
    const reached = await call("round_table", { agent: "noah", table: { story: "9-9" } });
    expect(reached.ok ? "" : reached.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });
});

/**
 * A real round table: everyone who spoke is recorded, guests apart from the team,
 * saved rooms recalled by name, a memory of a few lines per session in a file and never in the
 * journal. The gesture at the end is the one.
 */
describe("everyone who spoke, guests apart from the team", () => {
  const GUEST = {
    id: "guest-gdpr-lawyer",
    role: "GDPR lawyer",
    why: "the export holds personal data",
  };
  const base = { synthesis: SYNTHESIS, gesture: { type: "none" }, quote: QUOTE };
  const ids = (count: number) => Array.from({ length: count }, (_, i) => `agent-${i + 1}`);
  const facts = (active: Iterable<string>) => ({
    active: new Set(active),
    state: {},
    prepared: undefined,
  });
  const call = (input: Record<string, unknown>): RoundTableCall => ({
    agent: "noah",
    quote: QUOTE,
    ...input,
  });

  it("records a guest apart from the agents, with the field where its word is a lead", async () => {
    const { closing, journal } = await product();
    await closing({ ...base, agents: AGENTS, guests: [{ ...GUEST, field: "law" }] });
    const event = journal.events.find((entry) => entry.type === TABLE_EVENT_TYPES.closed);
    const payload = event?.payload as { agents: { id: string }[]; guests: unknown[] };
    expect(payload.agents.map((agent) => agent.id)).toEqual(["maya", "quentin"]);
    expect(payload.guests).toEqual([{ ...GUEST, field: "law" }]);
  });

  it("never mistakes a guest for an agent: the ids stay apart, whoever tries", async () => {
    const { table } = await product();
    // The id of a guest starts with `guest-`: an agent's id is refused by the schema.
    const asAgent = await table({ ...base, agents: AGENTS, guests: [{ ...GUEST, id: "maya" }] });
    expect(asAgent.ok).toBe(false);
    // A guest cannot sit among the agents of the team.
    const inTeam = await table({
      ...base,
      agents: [AGENTS[0], { id: "guest-lawyer", why: "an outsider" }],
    });
    expect(reasonOf(inTeam)).toContain("agent_absent:guest-lawyer");
    // A guest bearing the id of an agent of the team (a team with an agent of that name) is refused.
    const collision = validateClosing(
      call({ agents: AGENTS, guests: [GUEST], synthesis: SYNTHESIS, gesture: { type: "none" } }),
      facts(["maya", "quentin", GUEST.id]),
    );
    expect(collision).toContain(`guest_is_agent:${GUEST.id}`);
    const twice = await table({ ...base, agents: AGENTS, guests: [GUEST, GUEST] });
    expect(reasonOf(twice)).toContain(`guest_twice:${GUEST.id}`);
  });

  it("lets a guest and an agent make a table, a guest never owns the gesture", async () => {
    const { table, closing } = await product();
    const alone = await table({ ...base, guests: [GUEST] });
    expect(reasonOf(alone)).toContain("seats_count:2+");
    const two = await closing({ ...base, agents: [AGENTS[0]], guests: [GUEST] });
    expect(two).toEqual({ gesture: "none" });
    // A table of customers alone (a group of guests) is a table: no agent is required.
    const customers = await closing({
      ...base,
      guests: [GUEST, { ...GUEST, id: "guest-solo-founder", role: "solo founder" }],
    });
    expect(customers).toEqual({ gesture: "none" });
    const owned = await table({
      ...base,
      agents: AGENTS,
      guests: [GUEST],
      gesture: { type: "decision", subject: "Encrypt the export?", owner: GUEST.id },
    });
    expect(reasonOf(owned)).toContain("gesture:owner_is_guest");
  });

  it("raises the ceiling of agents to twelve and bounds guests to eight, in the engine", () => {
    const names = ids(13);
    const agent = (id: string) => ({ id, why: "spoke" });
    const whole = call({
      agents: names.slice(0, MAX_TABLE_AGENTS).map(agent),
      synthesis: SYNTHESIS,
      gesture: { type: "none" },
    });
    expect(validateClosing(whole, facts(names))).toEqual([]);
    const crowd = call({
      agents: names.map(agent),
      synthesis: SYNTHESIS,
      gesture: { type: "none" },
    });
    expect(validateClosing(crowd, facts(names))).toContain(`agents_count:0-${MAX_TABLE_AGENTS}`);
    const guests = Array.from({ length: MAX_TABLE_GUESTS + 1 }, (_, i) => ({
      ...GUEST,
      id: `guest-voice-${i}`,
    }));
    const guestly = call({
      agents: AGENTS,
      guests,
      synthesis: SYNTHESIS,
      gesture: { type: "none" },
    });
    expect(validateClosing(guestly, facts(["maya", "quentin"]))).toContain(
      `guests_count:0-${MAX_TABLE_GUESTS}`,
    );
    expect(MAX_TABLE_AGENTS).toBe(12);
    expect(MAX_TABLE_GUESTS).toBe(8);
  });

  it("keeps the three views to the team: no guest, no room", async () => {
    const { table } = await product({ izzy: true });
    const refused = await table({
      story: "1-1",
      agents: [
        { id: "maya", why: "product", angle: "product" },
        { id: "omar", why: "delivery", angle: "delivery" },
        { id: "quentin", why: "quality", angle: "quality" },
      ],
      guests: [GUEST],
      synthesis: { ...SYNTHESIS, format: "three_views" },
      gesture: { type: "none" },
      quote: QUOTE,
    });
    expect(reasonOf(refused)).toContain("three_views:no_room");
  });

  it("still writes the debate nowhere: the closing's keys are the team's, plus the guests", async () => {
    const { closing, journal } = await product();
    await closing({ ...base, agents: AGENTS, guests: [GUEST] });
    const event = journal.events.find((entry) => entry.type === TABLE_EVENT_TYPES.closed);
    expect(Object.keys(event?.payload as object).sort()).toEqual([
      "advice",
      "agents",
      "agreed",
      "disputed",
      "gesture",
      "guests",
      "quote",
      "topic",
    ]);
  });
});

describe("saved rooms, recalled by name, with a short memory", () => {
  const ROOM = [
    "name: Launch board",
    "setting: A blunt board meeting where Quentin doubts everything and Maya defends the user.",
    "members: [maya, quentin, ghost]",
    "guests:",
    "  - id: guest-investor",
    "    name: Ines",
    "    role: seed investor",
    "    persona: Dry, numbers first, hates vague promises.",
    "memory: true",
    "",
  ].join("\n");
  const base = { synthesis: SYNTHESIS, gesture: { type: "none" }, quote: QUOTE };

  it("hands a saved room back by its name, its cast checked against the team", async () => {
    const { files, table, journal } = await product();
    files.seed(roomPath("launch-board"), ROOM);
    const before = journal.events.length;
    const result = await table({ room: "launch-board" });
    expect(result.ok).toBe(true);
    const room = (result.ok ? result.value : undefined) as RoundTableResult;
    expect(room.room).toMatchObject({
      id: "launch-board",
      name: "Launch board",
      members: ["maya", "quentin"],
      absent: ["ghost"],
      remembers: true,
      memory: [],
    });
    expect(room.room?.guests.map((guest) => guest.id)).toEqual(["guest-investor"]);
    // A recall is a read: nothing in the journal.
    expect(journal.events.length).toBe(before);
  });

  it("refuses a room that is unknown or whose file is not whole, naming what is wrong", async () => {
    const { files, table } = await product();
    expect(reasonOf(await table({ room: "nowhere" }))).toContain("room_unknown");
    files.seed(roomPath("broken"), "name: Broken\nsetting: x\nmembers: maya\n");
    expect(reasonOf(await table({ room: "broken" }))).toContain("room_invalid:members");
    files.seed(roomPath("twice"), "name: Twice\nsetting: x\nmembers: [maya, maya]\n");
    expect(reasonOf(await table({ room: "twice" }))).toContain("room_member_twice:maya");
    files.seed(roomPath("garbage"), ":\n  - [");
    expect(reasonOf(await table({ room: "garbage" }))).toContain("room_invalid");
    files.seed(roomPath("led"), "name: Led\nsetting: x\nmembers: [noah, maya]\n");
    expect(reasonOf(await table({ room: "led" }))).toContain("room_member_leads:noah");
    // The offer of the three views names a story, never a room.
    files.seed(roomPath("launch-board"), ROOM);
    expect(reasonOf(await table({ room: "launch-board", story: "1-1" }))).toContain(
      "unexpected:room",
    );
  });

  it("writes a few lines of memory at the close, reads them back, and keeps them out of the journal", async () => {
    const { files, closing, table, journal } = await product();
    files.seed(roomPath("launch-board"), ROOM);
    const result = await closing({
      ...base,
      agents: AGENTS,
      room: "launch-board",
      memory: ["Quentin and Ines allied against the free tier.", "Maya conceded on pricing."],
    });
    expect(result.memory).toBe("saved");
    const text = files.files.get(memoryPath("launch-board")) ?? "";
    expect(text).toContain("- 2026-10-12: Quentin and Ines allied against the free tier.");
    expect(text).toContain("- 2026-10-12: Maya conceded on pricing.");
    // Not in the journal: only the room's name is, not its memory.
    const event = journal.events.find((entry) => entry.type === TABLE_EVENT_TYPES.closed);
    expect((event?.payload as { room?: string } | undefined)?.room).toBe("launch-board");
    expect(JSON.stringify(journal.events)).not.toContain("allied against");
    // Read back on the next entry.
    const again = await table({ room: "launch-board" });
    expect(again.ok && (again.value as RoundTableResult).room?.memory).toEqual([
      "2026-10-12: Quentin and Ines allied against the free tier.",
      "2026-10-12: Maya conceded on pricing.",
    ]);
  });

  it("refuses a memory the room does not keep, one without a room, and too many lines", async () => {
    const { files, table } = await product();
    files.seed(roomPath("amnesiac"), "name: Amnesiac\nsetting: Forgets all.\nmembers: [maya]\n");
    files.seed(roomPath("launch-board"), ROOM);
    const off = await table({ ...base, agents: AGENTS, room: "amnesiac", memory: ["x"] });
    expect(reasonOf(off)).toContain("memory_off");
    const orphan = await table({ ...base, agents: AGENTS, memory: ["x"] });
    expect(reasonOf(orphan)).toContain("memory_without_room");
    const many = await table({
      ...base,
      agents: AGENTS,
      room: "launch-board",
      memory: ["a", "b", "c", "d", "e"],
    });
    expect(reasonOf(many)).toContain(`memory_count:0-${MAX_SESSION_MEMORY_LINES}`);
    const unknown = await table({ ...base, agents: AGENTS, room: "nowhere" });
    expect(reasonOf(unknown)).toContain("room_unknown");
    expect(files.files.has(memoryPath("amnesiac"))).toBe(false);
  });

  it("closes a room that does not remember without writing any memory file", async () => {
    const { files, closing } = await product();
    files.seed(roomPath("amnesiac"), "name: Amnesiac\nsetting: Forgets all.\nmembers: [maya]\n");
    const result = await closing({ ...base, agents: AGENTS, room: "amnesiac" });
    expect(result.memory).toBeUndefined();
    expect(files.files.has(memoryPath("amnesiac"))).toBe(false);
  });
});

describe("the memory of a room stays short", () => {
  it("keeps the latest thirty lines, the oldest forgotten", () => {
    let entries: string[] = [];
    for (let day = 1; day <= 12; day++) {
      entries = withMemory(entries, `2026-10-${String(day).padStart(2, "0")}`, [
        "one",
        "two",
        "three",
      ]);
    }
    expect(entries).toHaveLength(MAX_MEMORY_LINES);
    expect(entries[0]).toBe("2026-10-03: one");
    expect(entries.at(-1)).toBe("2026-10-12: three");
  });

  it("reads back at most eight lines in a short total, whatever the file holds", () => {
    const long = Array.from({ length: 30 }, (_, i) => `2026-10-12: n${i} ${"x".repeat(190)}`);
    const read = recalledMemory(parseMemory(renderMemory(long)));
    expect(read.length).toBeLessThanOrEqual(RECALLED_MEMORY_LINES);
    expect(read.join("").length).toBeLessThanOrEqual(1_200);
    expect(read.at(-1)).toContain(" n29 ");
    // Hand-edited lines are tolerated: headers and prose are ignored, long lines cut.
    const edited = parseMemory(
      `# my notes\nfree text\n- ${"y".repeat(500)}\n-not a line\n- short\n`,
    );
    expect(edited).toHaveLength(2);
    expect(edited[0]?.length).toBe(200);
    expect(edited[1]).toBe("short");
  });
});
