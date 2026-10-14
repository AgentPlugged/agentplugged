import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode, type PhaseId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentStateView,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  createUlidFactory,
  type DeferredItem,
  type DeferredList,
  type DeferredResult,
  deferredItems,
  deferredLocks,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type NextResult,
  type RecordedEvent,
  resolveProfile,
  storyLockProblem,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";
import { closingProblem } from "./deferred-rules.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(6));

function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

/**
 * A product in the build phase, without a planner: a developer takes the first story.
 * `collide.next`, when set, gives the next event an id ending like it (once).
 */
async function product() {
  const files = new MemoryFiles();
  let clock = Date.UTC(2026, 9, 5, 9, 0, 0);
  const now = () => {
    clock += 1000;
    return clock;
  };
  const collide: { next?: string } = {};
  const ulid = createUlidFactory({ now });
  const newId = (after?: string, at?: number) => {
    const id = ulid(after, at);
    const target = collide.next;
    if (target === undefined) return id;
    collide.next = undefined;
    return `${id.slice(0, 16)}${target}`;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now, newId });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("stella", "Stella", "ux", "planning"),
      ...shippedAgent("sam", "Sam", "code", "build"),
      ...shippedAgent("quentin", "Quentin", "quality", "build"),
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
  const reader: CommandContext = { ...human, human: undefined, interactive: false };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
    return result.value as RecordedEvent;
  };
  const creator = (input: Record<string, unknown>, context: CommandContext = human) =>
    registry.run("deferred", context, input);
  const answer = async (checkpoint: string | undefined) => {
    const answered = await registry.run("review", human, {
      action: "resolve",
      checkpoint,
      decision: "approved",
    });
    if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
  };
  const closers: Partial<Record<PhaseId, string>> = {
    framing: "iris",
    planning: "stella",
    design: "main",
  };
  for (const phase of ["framing", "planning", "design"] as const) {
    const opened = await run("open_checkpoint", {
      agent: closers[phase],
      type: "phase_end",
      phase,
      risk: "low",
      title: `End of ${phase}`,
      summary: "Ready.",
    });
    await answer(opened.checkpoint);
  }
  for (const id of ["1-1", "1-2"]) {
    files.seed(
      `.agentplugged/stories/${id}-work.md`,
      `---\nid: ${id}\nkind: story\nowner: sam\n---\n# Story ${id}\n`,
    );
  }
  const next = async () => {
    const result = await registry.run("next", reader, {});
    if (!result.ok) throw new Error(`next failed: ${result.error.code}`);
    return result.value as NextResult;
  };
  const state = async () => {
    const result = await call("get_state", { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  const projection = async () => computeProjection(journal.events);
  const projected = async () => (await projection()).state;
  const productId = () => journal.events[0]?.product as string;
  return {
    journal,
    keys,
    human,
    call,
    run,
    creator,
    next,
    state,
    projection,
    projected,
    productId,
    reader,
    collide,
  };
}

const FINDING = {
  agent: "quentin",
  title: "Rate-limit the sign-in form",
  origin: "review",
  story: "1-1",
  owner: "sam",
  locks: ["1-2"],
};

const errorOf = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? undefined : result.error;

describe("the register of deferred work", () => {
  it("records an item with a stable D- id, shown by get_state and deferred list", async () => {
    const { run, state, creator, reader } = await product();
    const recorded = await run("defer_work", { ...FINDING, phase: "build" });
    expect(recorded.type).toBe("deferred.recorded");
    expect(recorded.deferred).toBe(`D-${recorded.id.slice(-10)}`);
    const view = (await state()).deferred;
    expect(view).toMatchObject({ done: 0, dropped: 0 });
    expect(view.open).toEqual([
      {
        id: recorded.deferred,
        title: FINDING.title,
        detail: null,
        origin: "review",
        story: "1-1",
        owner: "sam",
        locks: ["1-2"],
        phase: "build",
        status: "open",
        recorded_by: "quentin",
        recorded_at: recorded.at,
        event: recorded.id,
        closed: null,
      },
    ]);
    const listed = await creator({ action: "list", story: "1-2" }, reader);
    expect(listed.ok && (listed.value as DeferredList).open.map((item) => item.id)).toEqual([
      recorded.deferred,
    ]);
    const other = await creator({ action: "list", story: "1-1" }, reader);
    expect(other.ok && (other.value as DeferredList).open).toEqual([]);
    const shown = await creator({ action: "show", item: recorded.deferred?.toLowerCase() }, reader);
    expect(shown.ok && (shown.value as DeferredResult)).toMatchObject({
      action: "show",
      item: { id: recorded.deferred, status: "open" },
    });
  });

  it("brings story ids to their canonical form, and refuses control characters", async () => {
    const { run, call, state } = await product();
    await run("defer_work", { ...FINDING, story: "01-01", locks: ["01-02", "1-3"] });
    const [item] = (await state()).deferred.open;
    expect(item).toMatchObject({ story: "1-1", locks: ["1-2", "1-3"] });
    const duplicate = await call("defer_work", { ...FINDING, locks: ["1-2", "01-02"] });
    expect(errorOf(duplicate)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    for (const field of ["title", "detail"]) {
      const escaped = await call("defer_work", { ...FINDING, [field]: "Red \u001b[31malert" });
      expect(errorOf(escaped), field).toMatchObject({
        code: ErrorCode.INVALID_ARGUMENTS,
        details: { field },
      });
    }
  });

  it("gives the item to the calling agent, or to the creator for main", async () => {
    const { run, state } = await product();
    await run("defer_work", { agent: "sam", title: "Later", origin: "deliberate" });
    await run("defer_work", { agent: "main", title: "Later too", origin: "deliberate" });
    const owners = (await state()).deferred.open.map((item) => [item.title, item.owner]);
    expect(owners).toEqual([
      ["Later", "sam"],
      ["Later too", "creator"],
    ]);
  });

  it("refuses an inactive owner or caller, and a finding without its story", async () => {
    const { call, journal } = await product();
    const before = journal.events.length;
    const owner = await call("defer_work", { ...FINDING, owner: "ethan" });
    expect(errorOf(owner)).toMatchObject({
      code: ErrorCode.INVALID_ARGUMENTS,
      details: { field: "owner" },
    });
    const { story: _story, ...withoutStory } = FINDING;
    expect(errorOf(await call("defer_work", withoutStory))).toMatchObject({
      code: ErrorCode.INVALID_ARGUMENTS,
      details: { field: "story" },
    });
    expect(errorOf(await call("defer_work", { ...FINDING, agent: "ethan" }))).toMatchObject({
      code: ErrorCode.AGENT_NOT_FOUND,
    });
    expect(journal.events.length).toBe(before);
  });

  it("writes again, with a fresh id, when the D- id is already taken", async () => {
    const { run, collide, state, projection } = await product();
    const first = await run("defer_work", FINDING);
    collide.next = (first.deferred as string).slice(2);
    const second = await run("defer_work", { ...FINDING, title: "Another one" });
    expect(second.deferred).not.toBe(first.deferred);
    expect((await state()).deferred.open.map((item) => [item.id, item.title])).toEqual([
      [first.deferred, FINDING.title],
      [second.deferred, "Another one"],
    ]);
    // The colliding write stays in the journal, ignored.
    expect((await projection()).ignored.filter((entry) => entry.reason === "invalid")).toHaveLength(
      1,
    );
  });

  it("locks every way out of « no status » until the item is done, and next shows it", async () => {
    const { call, run, next, journal, projected } = await product();
    // Without a lock, the developer takes the first story.
    expect(await next()).toMatchObject({ step: "build", story: "1-1", deferred: null });
    const recorded = await run("defer_work", { ...FINDING, locks: ["1-1", "1-2"] });
    const before = journal.events.length;
    for (const status of ["in_progress", "in_review", "blocked"]) {
      const start = await call("update_story", { agent: "sam", story: "1-1", status });
      expect(errorOf(start), status).toMatchObject({
        code: ErrorCode.STORY_LOCKED,
        message_key: "error.story_locked.one",
        details: { story: "1-1", action: "start", count: 1, first: recorded.deferred },
      });
    }
    expect(journal.events.length).toBe(before);
    // Both stories locked: the item first, to its owner.
    expect(await next()).toMatchObject({
      step: "deferred_work",
      agent: "sam",
      story: "1-1",
      command: "npx agentplugged deferred list 1-1",
      deferred: { item: recorded.deferred, story: "1-1", title: FINDING.title },
    });
    // The merge asks the same rule, whatever the form of the id.
    expect(storyLockProblem(await projected(), "01-01", "merge")?.details).toMatchObject({
      story: "1-1",
      action: "merge",
      items: [recorded.deferred],
    });

    await run("complete_deferred", { agent: "sam", item: recorded.deferred, reason: "Done." });
    expect(deferredLocks(await projected(), "1-1")).toEqual([]);
    expect(await next()).toMatchObject({ step: "build", story: "1-1", deferred: null });
    await run("update_story", { agent: "sam", story: "1-1", status: "blocked" });
    await run("update_story", { agent: "sam", story: "1-1", status: "in_progress" });

    const again = await call("complete_deferred", {
      agent: "sam",
      item: recorded.deferred,
      reason: "Twice.",
    });
    expect(errorOf(again)).toMatchObject({
      code: ErrorCode.DEFERRED_NOT_OPEN,
      details: { item: recorded.deferred, status: "done" },
    });
    const unknown = await call("complete_deferred", {
      agent: "sam",
      item: "d-0000000000",
      reason: "Nothing.",
    });
    expect(errorOf(unknown)).toMatchObject({
      code: ErrorCode.DEFERRED_NOT_FOUND,
      details: { item: "D-0000000000" },
    });
  });

  it("proposes the next free story, the lock on a second line", async () => {
    const { run, next } = await product();
    const recorded = await run("defer_work", { ...FINDING, locks: ["1-1"] });
    expect(await next()).toMatchObject({
      step: "build",
      story: "1-2",
      deferred: {
        item: recorded.deferred,
        story: "1-1",
        command: "npx agentplugged deferred list 1-1",
      },
    });
  });

  it("names every item that locks a story (error.story_locked.other)", async () => {
    const { run, call } = await product();
    const first = await run("defer_work", { ...FINDING, locks: ["1-1"] });
    const second = await run("defer_work", { ...FINDING, title: "Second", locks: ["1-1"] });
    const start = await call("update_story", {
      agent: "sam",
      story: "1-1",
      status: "in_progress",
    });
    expect(errorOf(start)).toMatchObject({
      message_key: "error.story_locked.other",
      details: { count: 2, items: [first.deferred, second.deferred], first: first.deferred },
    });
  });

  it("lets only the owner or the recorder close an item, and never an item the creator owns", async () => {
    const { run, call, journal, productId, projection } = await product();
    // Quentin locks Sam's story with an item he keeps: Sam cannot unlock it himself.
    const kept = await run("defer_work", { ...FINDING, owner: "quentin", locks: ["1-1"] });
    const before = journal.events.length;
    const self = await call("complete_deferred", {
      agent: "sam",
      item: kept.deferred,
      reason: "x",
    });
    expect(errorOf(self)).toMatchObject({
      code: ErrorCode.DEFERRED_NOT_ALLOWED,
      details: { item: kept.deferred, agent: "sam", owner: "quentin" },
    });
    expect(journal.events.length).toBe(before);
    // An item the creator owns: not even its recorder.
    const creators = await run("defer_work", { ...FINDING, owner: "creator" });
    const recorder = await call("complete_deferred", {
      agent: "quentin",
      item: creators.deferred,
      reason: "Done.",
    });
    expect(errorOf(recorder)).toMatchObject({ code: ErrorCode.DEFERRED_NOT_ALLOWED });
    // Written past the command, the projection ignores it all the same.
    const forged = await journal.append({
      type: "deferred.closed",
      actor: { kind: "agent", agent: "sam" },
      product: productId(),
      provenance: "trusted",
      payload: { item: kept.deferred, outcome: "done", reason: "Mine." },
    });
    const ignored = (await projection()).ignored;
    expect(ignored).toContainEqual({ id: forged.id, reason: "invalid" });
    // The owner closes it.
    await run("complete_deferred", { agent: "quentin", item: kept.deferred, reason: "Done." });
  });

  it("never stops a story already started, and shows a locked story in review first", async () => {
    const { run, next } = await product();
    await run("update_story", { agent: "sam", story: "1-1", status: "in_progress" });
    const recorded = await run("defer_work", { ...FINDING, locks: ["1-1"] });
    await run("update_story", { agent: "sam", story: "1-1", status: "in_progress" });
    expect(await next()).toMatchObject({ step: "build", story: "1-1" });
    await run("update_story", { agent: "sam", story: "1-1", status: "in_review" });
    expect(await next()).toMatchObject({
      step: "deferred_work",
      story: "1-1",
      deferred: { item: recorded.deferred },
    });
  });

  it("lets the creator mark an item done at a terminal: the story may start", async () => {
    const { run, call, creator, state } = await product();
    const recorded = await run("defer_work", { ...FINDING, owner: "creator", locks: ["1-1"] });
    const resolved = await creator({
      action: "resolve",
      item: recorded.deferred,
      reason: "Rate limit added.",
    });
    expect(resolved.ok && (resolved.value as DeferredResult)).toMatchObject({
      action: "resolve",
      item: recorded.deferred,
      outcome: "done",
    });
    expect((await state()).deferred).toMatchObject({ open: [], done: 1, dropped: 0 });
    await run("update_story", { agent: "sam", story: "1-1", status: "in_progress" });
    expect(errorOf(await call("get_state", { full: true }))).toBeUndefined();
  });

  it("dates the creator's closing after the item, whatever the creator's clock", async () => {
    const { run, creator, human, projected } = await product();
    const recorded = await run("defer_work", FINDING);
    const behind: CommandContext = { ...human, now: () => Date.UTC(2020, 0, 1) };
    const dropped = await creator(
      { action: "drop", item: recorded.deferred, reason: "Not needed." },
      behind,
    );
    expect(dropped.ok).toBe(true);
    const [item] = deferredItems(await projected());
    expect(item?.status).toBe("dropped");
    expect(Date.parse(item?.closed?.at ?? "")).toBeGreaterThan(Date.parse(recorded.at));
    // A closing the projection did not apply is reported, never taken for done.
    expect(closingProblem(await projected(), recorded.deferred as string, "OTHER")).toMatchObject({
      code: ErrorCode.DEFERRED_CLOSING_IGNORED,
    });
  });

  it("lets only the creator drop an item, at a terminal, signed by their key", async () => {
    const { run, creator, reader, state, journal, projected } = await product();
    const recorded = await run("defer_work", { ...FINDING, owner: "creator" });
    const before = journal.events.length;
    const outside = await creator(
      { action: "drop", item: recorded.deferred, reason: "Not needed." },
      reader,
    );
    expect(outside.ok ? undefined : outside.error.code).toBe(ErrorCode.REVIEW_NOT_INTERACTIVE);
    // A malformed id is refused before anything else, the key included.
    const typo = await creator({ action: "drop", item: "D-1", reason: "x" }, reader);
    expect(typo.ok ? undefined : typo.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    const control = await creator({ action: "drop", item: recorded.deferred, reason: "a\u001bb" });
    expect(control.ok ? undefined : control.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(journal.events.length).toBe(before);

    const dropped = await creator({
      action: "drop",
      item: recorded.deferred?.toLowerCase(),
      reason: "Not needed.",
    });
    expect(dropped.ok && (dropped.value as DeferredResult)).toMatchObject({
      action: "drop",
      item: recorded.deferred,
      outcome: "dropped",
    });
    const closing = journal.events.at(-1);
    expect(closing).toMatchObject({ type: "deferred.closed", actor: { kind: "human" } });
    expect((await state()).deferred).toMatchObject({ open: [], done: 0, dropped: 1 });
    const [item] = deferredItems(await projected());
    expect(item).toMatchObject({
      status: "dropped",
      closed: { outcome: "dropped", reason: "Not needed.", by: closing?.actor.device },
    });
    const listed = await creator({ action: "list", all: true }, reader);
    expect(
      listed.ok && (listed.value as DeferredList).closed?.map((entry: DeferredItem) => entry.id),
    ).toEqual([recorded.deferred]);
    const twice = await creator({ action: "resolve", item: recorded.deferred, reason: "Again." });
    expect(twice.ok ? undefined : twice.error.code).toBe(ErrorCode.DEFERRED_NOT_OPEN);
  });

  it("refuses a creator without a key, or with a key the product does not trust", async () => {
    const { run, creator, human } = await product();
    const recorded = await run("defer_work", FINDING);
    const input = { action: "resolve", item: recorded.deferred, reason: "Done." };
    const empty = new MemoryKeyStore(SEED);
    const missing = await creator(input, { ...human, human: { keys: empty } });
    expect(missing.ok ? undefined : missing.error.code).toBe(ErrorCode.HUMAN_KEY_MISSING);
    const other = new MemoryKeyStore(SEED, toBase64url(new Uint8Array(32).fill(9)));
    const pending = await creator(input, { ...human, human: { keys: other } });
    expect(pending.ok ? undefined : pending.error.code).toBe(ErrorCode.HUMAN_KEY_UNENDORSED);
  });

  it("ignores an agent's drop, a closing of an unknown item and a creator's record", async () => {
    const { run, journal, projection, projected, productId } = await product();
    const recorded = await run("defer_work", FINDING);
    const drop = await journal.append({
      type: "deferred.closed",
      actor: { kind: "agent", agent: "quentin" },
      product: productId(),
      provenance: "trusted",
      payload: { item: recorded.deferred, outcome: "dropped", reason: "Mine." },
    });
    const unknown = await journal.append({
      type: "deferred.closed",
      actor: { kind: "agent", agent: "quentin" },
      product: productId(),
      provenance: "trusted",
      payload: { item: "D-0000000000", outcome: "done", reason: "None." },
    });
    const ignored = (await projection()).ignored;
    expect(ignored).toContainEqual({ id: drop.id, reason: "invalid" });
    expect(ignored).toContainEqual({ id: unknown.id, reason: "invalid" });
    expect(deferredLocks(await projected(), "1-2").map((item) => item.id)).toEqual([
      recorded.deferred,
    ]);
  });
});
