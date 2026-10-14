import { signEd25519, toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import {
  ErrorCode,
  type EventEnvelope,
  type ProjectionState,
  type UnsignedEventEnvelope,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  createCommandRegistry,
  deviceHeads,
  HISTORY_CSV_COLUMNS,
  type HistoryEntry,
  type HistoryResult,
  hashOf,
  historyCsv,
  historyEntries,
  historyJson,
  initCommand,
  loadMachineKey,
  MemoryKeyStore,
  MemoryStateStore,
  parseSince,
  type RecordedEvent,
  resolveProfile,
  type ToolProbe,
} from "../index.js";
import { createUlidFactory } from "../journal/ulid.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(7));
const START = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
/** The byte order mark the CSV export starts with. */
const BOM = String.fromCharCode(0xfeff);

/** A clock that moves one second per call. */
function clock() {
  let now = START;
  return () => {
    now += 1000;
    return now;
  };
}

async function product() {
  const files = new MemoryFiles();
  const exported = new MemoryFiles();
  const now = clock();
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,

    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const registry = createCommandRegistry();
  const open = async (input: Record<string, unknown>) => {
    const result = await registry.run("open_checkpoint", agent, { agent: "iris", ...input });
    if (!result.ok) throw new Error(`open_checkpoint failed: ${result.error.code}`);
    return (result.value as RecordedEvent).checkpoint as string;
  };
  const answer = async (checkpoint: string, decision = "approved", extra = {}) => {
    const result = await registry.run("review", human, {
      action: "resolve",
      checkpoint,
      decision,
      ...extra,
    });
    if (!result.ok) throw new Error(`review failed: ${result.error.code}`);
  };
  const history = (input: Record<string, unknown> = {}) =>
    registry.run(
      "history",
      typeof input.export === "string"
        ? { ...human, exportTarget: { files: exported, name: input.export } }
        : human,
      input,
    );
  return { files, exported, journal, keys, human, agent, registry, open, answer, history };
}

const STORY = {
  type: "story",
  risk: "low",
  title: "Story 2-6 done",
  summary: "Review the work on 2-6.",
  story: "2-6",
  blocks: [{ action: "story.review", story: "2-6" }],
};

const value = (result: unknown) => (result as { value: HistoryResult }).value;

/** Three validations: 2-6 approved, 2-7 high risk approved in locale, 2-8 refused. */
async function threeValidations() {
  const setup = await product();
  const first = await setup.open(STORY);
  await setup.answer(first);
  const second = await setup.open({
    ...STORY,
    risk: "high",
    title: 'Release "beta", then GA',
    story: "2-7",
    blocks: [{ action: "story.review", story: "2-7" }],
  });
  await setup.answer(second);
  const third = await setup.open({
    ...STORY,
    title: "Story 2-8 done",
    story: "2-8",
    blocks: [{ action: "story.review", story: "2-8" }],
  });
  await setup.answer(third, "rejected", { note: "Not yet." });
  return { ...setup, ids: [first, second, third] };
}

/** A checkpoint of 2-6, and an answer to it forged with the machine's key (`not_human`). */
async function withForgedAnswer() {
  const setup = await product();
  const { journal, keys, open } = setup;
  const checkpoint = await open(STORY);
  const machine = await loadMachineKey(keys);
  const listing = await journal.list();
  const head = deviceHeads(listing.events).get(machine.device);
  const last = listing.events.find((event) => event.id === head?.id) as EventEnvelope;
  const unsigned: UnsignedEventEnvelope = {
    v: 1,
    id: createUlidFactory()(last.id),
    type: "checkpoint.resolved",
    at: new Date(START + DAY).toISOString(),
    actor: { kind: "agent", device: machine.device, agent: "iris" },
    product: last.product,
    provenance: "trusted",
    prev: hashOf(last),
    payload: { checkpoint, decision: "approved", source: "terminal" },
    alg: "ed25519",
  };
  const forged = await signEd25519(unsigned, machine.secretKey);
  journal.rewrite([...journal.events, forged]);
  return { ...setup, checkpoint, machine, forgedId: forged.id };
}

describe("history", () => {
  it("lists every validation, most recent first, locale on a high risk flagged", async () => {
    const { history, ids } = await threeValidations();
    const result = await history();
    expect(result.ok).toBe(true);
    const { entries, ignored, export: written } = value(result);
    expect(ignored).toBeNull();
    expect(written).toBeNull();
    expect(entries.map((entry) => entry.checkpoint)).toEqual([ids[2], ids[1], ids[0]]);
    expect(entries[0]).toMatchObject({
      decision: "rejected",
      story: "2-8",
      source: "terminal",
      assurance: "locale",
      author_trust: "root",
      author_endorsed_at: null,
      checkpoint_type: "story",
      checkpoint_risk: "low",
      locale_on_high_risk: false,
    });
    expect(entries[0]?.author).toMatch(/^human:/);
    expect(entries[1]).toMatchObject({
      checkpoint_risk: "high",
      assurance: "locale",
      locale_on_high_risk: true,
      checkpoint_title: 'Release "beta", then GA',
    });
    for (const entry of entries) expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("is a read command: it writes nothing to the journal nor to the workspace", async () => {
    const { history, journal, files } = await threeValidations();
    const events = journal.events.length;
    const writes = files.writes.length;
    expect((await history({ all: true })).ok).toBe(true);
    expect(journal.events).toHaveLength(events);
    expect(files.writes).toHaveLength(writes);
  });

  it("is the creator's command only: never an agent's, never over MCP", async () => {
    const { registry, agent } = await product();
    const refused = await registry.run("history", agent, {});
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.UNKNOWN_COMMAND);
    expect(registry.agentCommands().map((command) => command.name)).not.toContain("history");
  });

  it("exports JSON: an array that reads back as the same data", async () => {
    const { history, exported } = await threeValidations();
    const listed = value(await history()).entries;
    const result = await history({ export: "out.json" });
    expect(value(result).export).toEqual({
      path: "out.json",
      format: "json",
      count: 3,
      ignored: null,
      replaced: false,
    });
    const text = exported.files.get("out.json") as string;
    expect(text.endsWith("]\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(listed);
    expect(text).toBe(historyJson(listed));
  });

  it("exports CSV: BOM, header in English, a title with a comma and quotes quoted", async () => {
    const { history, exported } = await threeValidations();
    await history({ export: "out.csv" });
    const text = exported.files.get("out.csv") as string;
    const lines = text.split("\r\n");
    expect(lines[0]).toBe(`${BOM}${HISTORY_CSV_COLUMNS.join(",")}`);
    expect(HISTORY_CSV_COLUMNS.at(-1)).toBe("ignored_reason");
    expect(lines).toHaveLength(5); // header, three records, and the empty string after the last CRLF
    expect(lines[4]).toBe("");
    expect(text).toContain(',"Release ""beta"", then GA",2-7,');
    // A valid validation has an empty `ignored_reason`.
    expect(lines[1]?.endsWith(",")).toBe(true);
  });

  it("CSV: neutralises formulas, keeps accents (UTF-8 with BOM); JSON keeps the exact text", async () => {
    const { history, exported, open, answer } = await product();
    for (const title of ["=HYPERLINK(1)", "+1", "-2", "@SUM(A1)", "Évolution déjà là"]) {
      await answer(await open({ ...STORY, title }));
    }
    await history({ export: "f.csv" });
    const csv = exported.files.get("f.csv") as string;
    expect(csv.startsWith(`${BOM}at,`)).toBe(true);
    for (const cell of ["'=HYPERLINK(1)", "'+1", "'-2", "'@SUM(A1)", "Évolution déjà là"]) {
      expect(csv).toContain(`,${cell},2-6,`);
    }
    await history({ export: "f.json" });
    const titles = (JSON.parse(exported.files.get("f.json") as string) as HistoryEntry[]).map(
      (entry) => entry.checkpoint_title,
    );
    expect(titles).toContain("=HYPERLINK(1)");
  });

  it("--force to a new file creates it (replaced: false)", async () => {
    const { history, exported } = await threeValidations();
    const result = await history({ export: "new.json", force: true });
    expect(value(result).export).toMatchObject({ replaced: false, count: 3 });
    expect(exported.files.has("new.json")).toBe(true);
  });

  it("with --all, the export holds the ignored answers too", async () => {
    const { history, exported, forgedId } = await withForgedAnswer();
    const json = value(await history({ all: true, export: "all.json" }));
    expect(json.export).toMatchObject({ count: 0, ignored: 1 });
    const read = JSON.parse(exported.files.get("all.json") as string) as {
      validations: unknown[];
      ignored: Array<{ event: string; reason: string }>;
    };
    expect(read.validations).toEqual([]);
    expect(read.ignored).toMatchObject([{ event: forgedId, reason: "not_human" }]);
    await history({ all: true, export: "all.csv" });
    const lines = (exported.files.get("all.csv") as string).split("\r\n");
    expect(lines).toHaveLength(3);
    // `quote` and `relayed_by`, then `channel`, `stack` and
    // `via`, come after the phase, before the reason.
    expect(lines[1]?.endsWith(`,${forgedId},,,,,,,not_human`)).toBe(true);
  });

  it("never replaces an existing file without --force (FILE_EXISTS)", async () => {
    const { history, exported } = await threeValidations();
    exported.seed("out.json", "kept");
    const writes = exported.writes.length;
    const refused = await history({ export: "out.json" });
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.FILE_EXISTS);
    expect(refused.ok ? undefined : refused.error.details).toEqual({ path: "out.json" });
    expect(exported.files.get("out.json")).toBe("kept");
    expect(exported.writes).toHaveLength(writes);
    const forced = await history({ export: "out.json", force: true });
    expect(value(forced).export?.replaced).toBe(true);
    expect(JSON.parse(exported.files.get("out.json") as string)).toHaveLength(3);
  });

  it("filters by story, date and decision, and the export follows the filters", async () => {
    const { history, exported, ids } = await threeValidations();
    const story = value(await history({ story: "2-6" })).entries;
    expect(story.map((entry) => entry.checkpoint)).toEqual([ids[0]]);
    const refused = value(await history({ decision: "rejected" })).entries;
    expect(refused.map((entry) => entry.checkpoint)).toEqual([ids[2]]);
    const all = value(await history()).entries;
    const since = value(await history({ since: all[1]?.at })).entries;
    expect(since.map((entry) => entry.checkpoint)).toEqual([ids[2], ids[1]]);
    const future = value(await history({ since: "2099-01-01" })).entries;
    expect(future).toEqual([]);
    await history({ story: "2-7", export: "h.csv" });
    expect((exported.files.get("h.csv") as string).split("\r\n")).toHaveLength(3);
  });

  it("refuses an invalid filter or export (INVALID_ARGUMENTS)", async () => {
    const { history, exported } = await threeValidations();
    for (const input of [
      { story: "2.6" },
      { story: "story-2" },
      { since: "yesterday" },
      { since: "2026-02-30" },
      { since: "2026-10-03T12:00:00" },
      { decision: "approve" },
      { export: "out.txt" },
      { export: "out" },
      { export: "" },
      { force: true },
      { all: "yes" },
    ]) {
      const result = await history(input);
      expect(result.ok ? undefined : result.error.code, JSON.stringify(input)).toBe(
        ErrorCode.INVALID_ARGUMENTS,
      );
    }
    expect(exported.writes).toEqual([]);
  });

  it("with --all, lists apart the answers the projection ignored, with their reason", async () => {
    const { history, checkpoint, forgedId, machine } = await withForgedAnswer();
    const forged = { id: forgedId };

    const without = value(await history());
    expect(without.entries).toEqual([]);
    expect(without.ignored).toBeNull();
    const result = value(await history({ all: true }));
    expect(result.entries).toEqual([]);
    expect(result.ignored).toEqual([
      {
        event: forged.id,
        at: new Date(START + DAY).toISOString(),
        author: machine.device,
        actor_kind: "agent",
        checkpoint,
        decision: "approved",
        story: "2-6",
        reason: "not_human",
      },
    ]);
    expect(value(await history({ all: true, story: "2-7" })).ignored).toEqual([]);
  });

  it("without validation: nothing listed, an empty array or a header-only CSV", async () => {
    const { history, exported } = await product();
    const result = await history({ export: "empty.json" });
    expect(value(result).entries).toEqual([]);
    expect(exported.files.get("empty.json")).toBe("[]\n");
    await history({ export: "empty.csv" });
    expect(exported.files.get("empty.csv")).toBe(`${BOM}${HISTORY_CSV_COLUMNS.join(",")}\r\n`);
  });

  it("gives a waiver's deadline", async () => {
    const { history, open, answer, registry, agent } = await product();
    const checkpoint = await open({
      ...STORY,
      criteria: [
        { id: "tests", metric: "tests_failed", op: "<=", threshold: 0, severity: "blocking" },
      ],
    });
    await registry.run("report_measures", agent, {
      agent: "iris",
      checkpoint,
      measures: { tests_failed: 1 },
    });
    const until = new Date(START + 2 * DAY).toISOString();
    await answer(checkpoint, "waived", { waiver_until: until });
    const [entry] = value(await history()).entries;
    expect(entry).toMatchObject({ decision: "waived", waiver_until: until, option: null });
  });
});

describe("history entries (pure)", () => {
  const humans = {
    "human:root": {
      device: "human:root",
      public_key: "a",
      registered_at: "2026-10-01T00:00:00.000Z",
      trust: "root",
      endorsed_by: null,
      presence: [],
    },
    "human:second": {
      device: "human:second",
      public_key: "b",
      registered_at: "2026-10-02T00:00:00.000Z",
      trust: "endorsed",
      endorsed_by: "human:root",
      presence: [],
    },
  };
  const state: ProjectionState = {
    format: 1,
    journal_head: null,
    computed_at: null,
    product: null,
    devices: [],
    applied: 0,
    ignored: [],
    warnings: [],
    state: {
      humans,
      checkpoints: {
        "G-AAAAAAAAAA": {
          id: "G-AAAAAAAAAA",
          type: "decision",
          risk: "medium",
          title: "Pick a database",
          story: null,
        },
      },
      validations: [
        {
          checkpoint: "G-AAAAAAAAAA",
          decision: "option_chosen",
          option: "postgres",
          author: "human:second",
          at: "2026-10-03T10:00:00Z",
          source: "terminal",
          assurance: "presence",
          event: "01K00000000000000000000001",
        },
      ],
    },
  };
  const endorsement = {
    id: "01K00000000000000000000000",
    type: "human.key_endorsed",
    at: "2026-10-02T08:30:00Z",
    actor: { kind: "human", device: "human:root" },
    payload: { device: "human:second", public_key: "b" },
  } as unknown as EventEnvelope;

  it("names the author's trust and when the key was endorsed", () => {
    const [entry] = historyEntries(state, [endorsement]);
    expect(entry).toEqual<HistoryEntry>({
      event: "01K00000000000000000000001",
      at: "2026-10-03T10:00:00.000Z",
      author: "human:second",
      author_trust: "endorsed",
      author_endorsed_at: "2026-10-02T08:30:00.000Z",
      source: "terminal",
      decision: "option_chosen",
      option: "postgres",
      waiver_until: null,
      assurance: "presence",
      locale_on_high_risk: false,
      checkpoint: "G-AAAAAAAAAA",
      checkpoint_type: "decision",
      checkpoint_risk: "medium",
      checkpoint_title: "Pick a database",
      story: null,
      checkpoint_phase: null,
      quote: null,
      relayed_by: null,
      channel: null,
      stack: null,
      via: null,
    });
    // An endorsement the projection ignored does not count.
    const ignored = { ...state, ignored: [{ id: endorsement.id, reason: "invalid" as const }] };
    expect(historyEntries(ignored, [endorsement])[0]?.author_endorsed_at).toBeNull();
  });

  it("sorts entries without a valid date last, in a fixed order", () => {
    const validations = state.state.validations as Array<Record<string, unknown>>;
    const base = validations[0] as Record<string, unknown>;
    const mixed: ProjectionState = {
      ...state,
      state: {
        ...state.state,
        validations: [
          { ...base, at: "not a date", event: "01K00000000000000000000003" },
          { ...base, at: "2026-10-01T00:00:00Z", event: "01K00000000000000000000004" },
          { ...base, at: "bad", event: "01K00000000000000000000005" },
          { ...base, at: "2026-10-02T00:00:00Z", event: "01K00000000000000000000002" },
        ],
      },
    };
    const order = historyEntries(mixed, []).map((entry) => entry.event.slice(-1));
    expect(order).toEqual(["2", "4", "5", "3"]);
  });

  it("writes nulls as empty CSV fields, and line breaks quoted", () => {
    const [entry] = historyEntries(state, []);
    const text = historyCsv([{ ...(entry as HistoryEntry), checkpoint_title: "two\nlines" }]);
    expect(text).toContain(',postgres,,presence,false,G-AAAAAAAAAA,decision,medium,"two\nlines",,');
    const tab = historyCsv([{ ...(entry as HistoryEntry), checkpoint_title: "\tTab" }]);
    expect(tab).toContain(",medium,'\tTab,,");
    const cr = historyCsv([{ ...(entry as HistoryEntry), checkpoint_title: "\rX" }]);
    expect(cr).toContain(`,medium,"'\rX",,`);
  });

  it("parses ISO dates only", () => {
    // A date alone is local midnight; years 0000 to 0099 are those years.
    expect(parseSince("2026-10-03")).toBe(new Date(2026, 9, 3).getTime());
    const early = new Date(0);
    early.setFullYear(50, 0, 1);
    early.setHours(0, 0, 0, 0);
    expect(parseSince("0050-01-01")).toBe(early.getTime());
    expect(new Date(parseSince("0050-01-01T00:00:00Z") as number).getUTCFullYear()).toBe(50);
    expect(parseSince("2026-10-03T12:30:00+02:00")).toBe(Date.UTC(2026, 9, 3, 10, 30));
    expect(parseSince("2026-10-03T12:30Z")).toBe(Date.UTC(2026, 9, 3, 12, 30));
    for (const text of ["2026-13-01", "2026-02-29", "03/10/2026", "2026-10-03T25:00:00Z", ""]) {
      expect(parseSince(text), text).toBeUndefined();
    }
  });
});
