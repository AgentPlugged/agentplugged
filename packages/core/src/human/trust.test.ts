import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode, type EventEnvelope, HUMAN_EVENT_TYPES } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CheckpointState,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  createUlidFactory,
  deviceHeads,
  type HumanDraft,
  type HumanKey,
  type HumanState,
  hashOf,
  initCommand,
  loadHumanKey,
  localeSigner,
  MemoryKeyStore,
  MemoryStateStore,
  parseWaiverAnswer,
  prepareHumanEvents,
  presenceSigner,
  type RecordedEvent,
  resolveProfile,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { withTimeZone } from "../testing/time-zone.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};
const SEED = toBase64url(new Uint8Array(32).fill(9));
const ADA = toBase64url(new Uint8Array(32).fill(21));
const NEWCOMER = toBase64url(new Uint8Array(32).fill(22));
const CY = toBase64url(new Uint8Array(32).fill(23));
const START = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function clock() {
  let now = START;
  const tick = () => {
    now += 1000;
    return now;
  };
  tick.jump = (ms: number) => {
    now += ms;
  };
  return tick;
}

const STORY = {
  agent: "iris",
  type: "story",
  risk: "low",
  title: "Story 2-6 done",
  summary: "Review the work on 2-6.",
  story: "2-6",
  blocks: [{ action: "story.review", story: "2-6" }],
};

/** A product whose root creator is Ada (her key published by init), and agents' calls. */
async function product() {
  const files = new MemoryFiles();
  const now = clock();
  const journal = new MemoryStateStore({ keys: new MemoryKeyStore(SEED), now });
  const presence = new SoftwareAuthenticator();
  const base: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
  };
  const creator = (secret: string | undefined) => {
    const keys = new MemoryKeyStore(SEED, secret);
    return { keys, context: { ...base, human: { keys, presence } } as CommandContext };
  };
  const ada = creator(ADA);
  const init = await initCommand.run(ada.context, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const registry = createCommandRegistry();
  const agent: CommandContext = { ...base, actor: "agent" };
  const asAgent = async (name: string, input: Record<string, unknown>) => {
    const result = await registry.run(name, agent, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
    return result.value as RecordedEvent;
  };
  const projection = async () => {
    const listing = await journal.list();
    return computeProjection(listing.events, { problems: listing.problems });
  };
  /** Writes a creator's events directly, chained on the device's head, at the given time. */
  const write = async (key: HumanKey, drafts: HumanDraft[], at?: () => number) => {
    const listing = await journal.list();
    const time = at ?? now;
    const events = await prepareHumanEvents({
      key,
      drafts,
      deviceHead: deviceHeads(listing.events).get(key.device) ?? null,
      product: listing.events[0]?.product as string,
      newId: createUlidFactory({ now: time }),
      now: time,
    });
    await journal.appendHuman(events);
    return events;
  };
  return {
    files,
    journal,
    now,
    presence,
    creator,
    ada,
    registry,
    agent,
    asAgent,
    projection,
    write,
  };
}

const humans = (state: Record<string, unknown>) =>
  (state.humans ?? {}) as Record<string, HumanState>;
const checkpoints = (state: Record<string, unknown>) =>
  (state.checkpoints ?? {}) as Record<string, CheckpointState>;
const resolution = (checkpoint: string, decision = "approved", extra = {}) => ({
  type: "checkpoint.resolved",
  payload: { checkpoint, decision, source: "terminal", ...extra },
});

describe("trust of creator keys", () => {
  it("a second key is pending: its answers are ignored until a trusted key endorses it", async () => {
    const { creator, ada, registry, asAgent, projection, write } = await product();
    const newcomer = creator(NEWCOMER);
    const published = await initCommand.run(newcomer.context, {});
    expect(published.ok && published.value.humanKey).toMatchObject({
      published: "written",
      trust: "pending",
    });
    const newcomerKey = (await loadHumanKey(newcomer.keys)) as HumanKey;
    const opened = await asAgent("open_checkpoint", STORY);
    const id = opened.checkpoint as string;

    // Through the CLI, refused before anything is written.
    const refused = await registry.run("review", newcomer.context, {
      action: "resolve",
      checkpoint: id,
      decision: "approved",
    });
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.HUMAN_KEY_UNENDORSED);
    // Written anyway: ignored.
    const [forged] = await write(newcomerKey, [
      { ...resolution(id), signer: localeSigner(newcomerKey) },
    ]);
    let state = await projection();
    expect(state.ignored).toContainEqual({ id: forged?.id, reason: "unendorsed_human" });
    expect(humans(state.state)[newcomerKey.device]?.trust).toBe("pending");
    expect(checkpoints(state.state)[id]?.status).toBe("open");

    // Ada lists the pending keys, then endorses the newcomer.
    const list = await registry.run("key", ada.context, { action: "endorse" });
    expect(list.ok && list.value).toEqual({
      action: "endorse",
      status: "list",
      pending: [{ device: newcomerKey.device, registered_at: expect.any(String) }],
    });
    const endorsed = await registry.run("key", ada.context, {
      action: "endorse",
      device: newcomerKey.device,
    });
    expect(endorsed.ok && endorsed.value).toEqual({
      action: "endorse",
      status: "endorsed",
      device: newcomerKey.device,
    });
    state = await projection();
    const adaKey = (await loadHumanKey(ada.keys)) as HumanKey;
    expect(humans(state.state)[newcomerKey.device]).toMatchObject({
      trust: "endorsed",
      endorsed_by: adaKey.device,
    });
    expect(humans(state.state)[adaKey.device]?.trust).toBe("root");
    // The newcomer's answers count from then on.
    const approved = await registry.run("review", newcomer.context, {
      action: "resolve",
      checkpoint: id,
      decision: "approved",
    });
    expect(approved.ok).toBe(true);
    expect(checkpoints((await projection()).state)[id]?.resolution?.by).toBe(newcomerKey.device);
  });

  it("an endorsement by a pending key is ignored", async () => {
    const { creator, projection, write } = await product();
    const newcomer = creator(NEWCOMER);
    await initCommand.run(newcomer.context, {});
    const cy = creator(CY);
    await initCommand.run(cy.context, {});
    const newcomerKey = (await loadHumanKey(newcomer.keys)) as HumanKey;
    const cyKey = (await loadHumanKey(cy.keys)) as HumanKey;
    const [endorsement] = await write(newcomerKey, [
      {
        type: HUMAN_EVENT_TYPES.keyEndorsed,
        payload: { device: cyKey.device, public_key: toBase64url(cyKey.publicKey) },
        signer: localeSigner(newcomerKey),
      },
    ]);
    const { ignored, state } = await projection();
    expect(ignored).toContainEqual({ id: endorsement?.id, reason: "unendorsed_human" });
    expect(humans(state)[cyKey.device]?.trust).toBe("pending");
  });

  it("review never creates a key: HUMAN_KEY_MISSING", async () => {
    const { creator, registry, asAgent } = await product();
    const nobody = creator(undefined);
    await asAgent("open_checkpoint", STORY);
    const result = await registry.run("review", nobody.context, { action: "list" });
    expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.HUMAN_KEY_MISSING);
    expect(nobody.keys.human).toBeUndefined();
  });

  it("matches a checkpoint id whatever its case", async () => {
    const { ada, registry, asAgent } = await product();
    const opened = await asAgent("open_checkpoint", STORY);
    const result = await registry.run("review", ada.context, {
      action: "resolve",
      checkpoint: (opened.checkpoint as string).toLowerCase(),
      decision: "approved",
    });
    expect(result.ok && result.value).toMatchObject({ checkpoint: opened.checkpoint });
  });
});

describe("refusals keep the action blocked", () => {
  it.each([
    ["rejected", { note: "not this way" }],
    ["changes_requested", { note: "split the module" }],
  ])("%s: blocks stay until a superseding checkpoint is approved", async (decision, extra) => {
    const { ada, registry, agent, asAgent, projection } = await product();
    const review = () =>
      registry.run("update_story", agent, { agent: "iris", story: "2-6", status: "in_review" });
    const first = (await asAgent("open_checkpoint", STORY)).checkpoint as string;
    // Superseding a checkpoint still open is refused.
    const early = await registry.run("open_checkpoint", agent, { ...STORY, supersedes: first });
    expect(early.ok ? undefined : early.error.details.field).toBe("supersedes");
    const answered = await registry.run("review", ada.context, {
      action: "resolve",
      checkpoint: first,
      decision,
      ...extra,
    });
    expect(answered.ok).toBe(true);
    let state = await projection();
    expect(checkpoints(state.state)[first]).toMatchObject({
      status: "resolved",
      blocks_lifted: false,
    });
    const blocked = await review();
    expect(blocked.ok ? undefined : blocked.error.details).toEqual({
      checkpoint: first,
      action: "story.review",
    });
    // Another story cannot supersede it.
    const otherStory = await registry.run("open_checkpoint", agent, {
      ...STORY,
      story: "2-7",
      blocks: [{ action: "story.review", story: "2-7" }],
      supersedes: first,
    });
    expect(otherStory.ok ? undefined : otherStory.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);

    const second = (await asAgent("open_checkpoint", { ...STORY, supersedes: first }))
      .checkpoint as string;
    const approved = await registry.run("review", ada.context, {
      action: "resolve",
      checkpoint: second,
      decision: "approved",
    });
    expect(approved.ok).toBe(true);
    state = await projection();
    expect(checkpoints(state.state)[first]?.blocks_lifted).toBe(true);
    expect(checkpoints(state.state)[second]?.blocks_lifted).toBe(true);
    expect((await review()).ok).toBe(true);
  });
});

describe("waivers", () => {
  const FAILING = {
    ...STORY,
    criteria: [
      { id: "tests", metric: "tests_failed", op: "<=", threshold: 0, severity: "blocking" },
    ],
  };

  it("caps the time waived in all at 90 days, renewals included", async () => {
    const { ada, registry, asAgent, now } = await product();
    const id = (await asAgent("open_checkpoint", FAILING)).checkpoint as string;
    await asAgent("report_measures", {
      agent: "iris",
      checkpoint: id,
      measures: { tests_failed: 1 },
    });
    const waive = (days: number) =>
      registry.run("review", ada.context, {
        action: "resolve",
        checkpoint: id,
        decision: "waived",
        waiver_until: parseWaiverAnswer(String(days), now() + 500) as string,
      });
    for (let round = 0; round < 3; round++) {
      const result = await waive(29);
      expect(result.ok).toBe(true);
      now.jump(30 * DAY);
    }
    const beyond = await waive(10);
    expect(beyond.ok ? undefined : beyond.error.details.reason_key).toBe(
      "reason.review.deadline.renewal",
    );
  });

  it("accepts the 30th day typed as a date", () => {
    const now = Date.UTC(2026, 9, 3, 12, 0, 0);
    withTimeZone("UTC", () => {
      const until = parseWaiverAnswer("2026-11-02", now);
      expect(until).toBe(new Date(now + 30 * DAY).toISOString());
      expect(parseWaiverAnswer("2026-11-03", now)).toBe("2026-11-03T23:59:59.999Z");
    });
    // The 30th day in the creator's local time, cut at the limit like in UTC.
    withTimeZone("America/New_York", () => {
      expect(parseWaiverAnswer("2026-11-02", now)).toBe(new Date(now + 30 * DAY).toISOString());
      expect(parseWaiverAnswer("2026-11-03", now)).toBe("2026-11-04T04:59:59.999Z");
    });
  });
});

describe("the projection of answers", () => {
  it("holds an answer sorted before its checkpoint opens, then applies it; a second is already_resolved", async () => {
    const { ada, asAgent, projection, write, journal } = await product();
    const key = (await loadHumanKey(ada.keys)) as HumanKey;
    const registered = journal.events.find(
      (event) => event.type === HUMAN_EVENT_TYPES.keyRegistered,
    ) as EventEnvelope;
    const opened = await asAgent("open_checkpoint", STORY);
    const id = opened.checkpoint as string;
    // Two answers dated between the key's registration and the opening: they sort before it.
    let early = Date.parse(registered.at);
    const before = () => {
      early += 10;
      return early;
    };
    const [first, second] = await write(
      key,
      [
        { ...resolution(id), signer: localeSigner(key) },
        { ...resolution(id, "rejected", { note: "no" }), signer: localeSigner(key) },
      ],
      before,
    );
    expect((first as EventEnvelope).id < opened.id).toBe(true);
    const state = await projection();
    expect(checkpoints(state.state)[id]?.resolution?.event).toBe(first?.id);
    expect(state.ignored).toEqual([{ id: second?.id, reason: "already_resolved" }]);
    expect(state.applied).toBe(journal.events.length - 1);
    // The date of the projection is the latest applied, never the held one's.
    expect(state.computed_at).toBe(opened.at);
  });

  it("ignores an answer to a checkpoint that never opens (checkpoint_unknown)", async () => {
    const { ada, projection, write, journal } = await product();
    const key = (await loadHumanKey(ada.keys)) as HumanKey;
    const [orphan] = await write(key, [
      { ...resolution("G-ZZZZZZZZZZ"), signer: localeSigner(key) },
    ]);
    const state = await projection();
    expect(state.ignored).toEqual([{ id: orphan?.id, reason: "checkpoint_unknown" }]);
    expect(state.applied).toBe(journal.events.length - 1);
  });

  it("ignores an answer signed by a WebAuthn credential not linked to the key", async () => {
    const { ada, asAgent, projection, write } = await product();
    const key = (await loadHumanKey(ada.keys)) as HumanKey;
    const id = (await asAgent("open_checkpoint", STORY)).checkpoint as string;
    const stranger = new SoftwareAuthenticator();
    const credential = await stranger.create();
    const [answer] = await write(key, [
      { ...resolution(id), signer: presenceSigner(stranger, credential) },
    ]);
    const state = await projection();
    expect(state.ignored).toEqual([{ id: answer?.id, reason: "unknown_signer" }]);
  });

  it("ignores an assertion whose signature counter does not increase", async () => {
    const { ada, registry, asAgent, projection, journal, presence, now } = await product();
    const linked = await registry.run("key", ada.context, { action: "presence" });
    expect(linked.ok).toBe(true);
    const key = (await loadHumanKey(ada.keys)) as HumanKey;
    const credential = JSON.parse((ada.keys.presence as string) ?? "{}");
    const a = (await asAgent("open_checkpoint", { ...STORY, risk: "high" })).checkpoint as string;
    const b = (await asAgent("open_checkpoint", { ...STORY, risk: "high", title: "B" }))
      .checkpoint as string;
    // Two answers on the same head (a fork): the later id is signed first, so its counter is lower.
    const listing = await journal.list();
    const head = deviceHeads(listing.events).get(key.device);
    const last = listing.events.find((event) => event.id === head?.id) as EventEnvelope;
    const newId = createUlidFactory({ now });
    const unsigned = (checkpoint: string, id: string) => ({
      v: 1 as const,
      id,
      type: "checkpoint.resolved",
      at: new Date(now()).toISOString(),
      actor: { kind: "human" as const, device: key.device },
      product: last.product,
      story: "2-6",
      provenance: "trusted" as const,
      prev: hashOf(last),
      payload: { checkpoint, decision: "approved", source: "terminal" },
      alg: credential.alg,
      assurance: "presence" as const,
    });
    const firstId = newId(last.id);
    const secondId = newId(firstId);
    const signer = presenceSigner(presence, credential);
    const later = await signer.sign(unsigned(b, secondId));
    const earlier = await signer.sign(unsigned(a, firstId));
    journal.rewrite([...journal.events, earlier, later]);
    const state = await projection();
    expect(state.ignored).toContainEqual({ id: later.id, reason: "bad_signature" });
    expect(checkpoints(state.state)[a]?.resolution?.assurance).toBe("presence");
  });
});
