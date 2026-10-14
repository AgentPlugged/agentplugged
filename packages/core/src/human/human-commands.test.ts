import { signEd25519, toBase64url, webauthnChallenge } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import {
  ErrorCode,
  type EventEnvelope,
  HUMAN_EVENT_TYPES,
  type UnsignedEventEnvelope,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  blockingCheckpoint,
  type CheckpointResolution,
  type CheckpointState,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  deviceHeads,
  type HumanState,
  hashOf,
  type InitResult,
  initCommand,
  type KeyPresenceResult,
  linkPayload,
  loadHumanKey,
  loadMachineKey,
  localeSigner,
  MemoryKeyStore,
  MemoryStateStore,
  type PresencePrompt,
  prepareHumanEvents,
  presenceSigner,
  type RecordedEvent,
  type ReviewList,
  type ReviewResolved,
  resolveProfile,
  type StoryState,
  type ToolProbe,
  type ValidationEntry,
  waiverExpired,
} from "../index.js";
import { keychainFull } from "../journal/key-store.js";
import { createUlidFactory } from "../journal/ulid.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(9));
const START = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

/** A clock that moves one second per call, and can jump. */
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

async function product(
  options: { presence?: SoftwareAuthenticator; interactive?: boolean; keys?: MemoryKeyStore } = {},
) {
  const files = new MemoryFiles();
  const now = clock();
  const keys = options.keys ?? new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now });
  const authenticator = options.presence ?? new SoftwareAuthenticator();
  const prompts: PresencePrompt[] = [];
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: options.interactive ?? true,
    human: {
      keys,
      presence: authenticator,
      onPresencePrompt: (prompt) => {
        prompts.push(prompt);
      },
    },
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const registry = createCommandRegistry();
  const asAgent = async (name: string, input: Record<string, unknown>) => {
    const result = await registry.run(name, agent, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
    return result.value as RecordedEvent;
  };
  const asHuman = (name: string, input: Record<string, unknown>) =>
    registry.run(name, human, input);
  const projection = async () => {
    const listing = await journal.list();
    return computeProjection(listing.events, { problems: listing.problems });
  };
  return {
    files,
    journal,
    keys,
    now,
    human,
    agent,
    registry,
    authenticator,
    prompts,
    init: init.value as InitResult,
    asAgent,
    asHuman,
    projection,
  };
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

const checkpoints = (state: Record<string, unknown>) =>
  (state.checkpoints ?? {}) as Record<string, CheckpointState>;

describe("init and the creator's key", () => {
  it("creates the locale key, publishes it, and tells whether Windows Hello is available", async () => {
    const { init, keys, journal, projection } = await product();
    expect(init.humanKey).toMatchObject({
      status: "ready",
      created: true,
      published: "written",
      presence: { status: "no_credential" },
    });
    expect(keys.human).toBeDefined();
    const key = await loadHumanKey(keys);
    expect(init.humanKey?.device).toBe(key?.device);
    expect(key?.device).toMatch(/^human:[A-Za-z0-9_-]{16}$/);
    const registered = journal.events.find(
      (event) => event.type === HUMAN_EVENT_TYPES.keyRegistered,
    );
    expect(registered?.actor).toEqual({ kind: "human", device: key?.device });
    const { state, ignored } = await projection();
    expect(ignored).toEqual([]);
    expect(Object.keys((state.humans ?? {}) as object)).toEqual([key?.device]);
  });

  it("says a full keychain apart, for the creator's key and the product key", async () => {
    // The machine key is there; the keychain then refuses every new entry (Windows: full).
    const keys = new MemoryKeyStore(SEED);
    keys.writeHumanSecret = keys.writeProductSecret = async () => {
      throw keychainFull("Platform failure: Windows error code 8");
    };
    const { init } = await product({ keys });
    expect(init.humanKey).toEqual({
      status: "keychain_full",
      reason: "Platform failure: Windows error code 8",
    });
    expect(init.productKey).toEqual({
      status: "keychain_full",
      publishReason: "Platform failure: Windows error code 8",
    });
    expect([keys.human, keys.products.size]).toEqual([undefined, 0]);
  });

  it("without Windows Hello, stays locale and says so", async () => {
    const { init } = await product({ presence: new SoftwareAuthenticator({ available: false }) });
    expect(init.humanKey?.presence).toEqual({ status: "unavailable", reason: "not_configured" });
  });

  it("creates the key once per machine, and publishes it once per journal", async () => {
    const { human, keys, journal } = await product();
    const again = await initCommand.run(human, {});
    expect(again.ok && again.value.humanKey).toMatchObject({
      created: false,
      published: "already",
    });
    expect(keys.humanWrites).toBe(1);
    expect(
      journal.events.filter((event) => event.type === HUMAN_EVENT_TYPES.keyRegistered),
    ).toHaveLength(1);
  });
});

describe("key presence", () => {
  it("links a credential, signed by both keys, and the projection accepts it", async () => {
    const { asHuman, projection, authenticator, prompts, journal } = await product();
    const result = await asHuman("key", { action: "presence" });
    expect(result.ok).toBe(true);
    const value = (result as { value: KeyPresenceResult }).value;
    expect(value).toMatchObject({ status: "linked", alg: "webauthn-es256", created: true });
    expect(authenticator.calls.map((call) => call.kind)).toEqual(["create", "assert"]);
    const link = journal.events.find((event) => event.type === HUMAN_EVENT_TYPES.presenceLinked);
    expect(link?.alg).toBe("webauthn-es256");
    expect(link?.assurance).toBe("presence");
    // The fingerprint shown before the prompt is the start of what the assertion signs.
    expect(prompts).toHaveLength(1);
    expect(authenticator.calls[1]?.challenge?.startsWith(prompts[0]?.fingerprint ?? "-")).toBe(
      true,
    );
    const { state, ignored } = await projection();
    expect(ignored).toEqual([]);
    const humans = state.humans as Record<string, HumanState>;
    expect(Object.values(humans)[0]?.presence).toEqual([
      { credential_id: value.credential_id, alg: "webauthn-es256", linked_at: link?.at },
    ]);
    const again = await asHuman("key", { action: "presence" });
    expect(again.ok && again.value).toMatchObject({ status: "already_linked", created: false });
  });

  it("reports Windows Hello unavailable, and writes nothing", async () => {
    const { asHuman, journal } = await product({
      presence: new SoftwareAuthenticator({ available: false }),
    });
    const before = journal.events.length;
    const result = await asHuman("key", { action: "presence" });
    expect(result.ok && result.value).toEqual({
      action: "presence",
      status: "unavailable",
      reason: "not_configured",
    });
    expect(journal.events).toHaveLength(before);
  });

  it("ignores a link with one valid signature only (bad_signature)", async () => {
    const { keys, journal, now, projection, authenticator } = await product();
    const key = await loadHumanKey(keys);
    if (key === undefined) throw new Error("no key");
    const credential = await authenticator.create();
    const other = await new SoftwareAuthenticator().create();
    const listing = await journal.list();
    const head = deviceHeads(listing.events).get(key.device) ?? null;
    const productId = listing.events[0]?.product as string;
    // The locale key signs one credential, the event is signed by it: the locale signature
    // names another credential.
    const wrongLocale = { ...(await linkPayload(key, other)), ...credential };
    const [forged] = await prepareHumanEvents({
      key,
      drafts: [
        {
          type: HUMAN_EVENT_TYPES.presenceLinked,
          payload: { ...wrongLocale },
          signer: presenceSigner(authenticator, credential),
        },
      ],
      deviceHead: head,
      product: productId,
      newId: createUlidFactory({ now }),
      now,
    });
    if (forged === undefined) throw new Error("nothing prepared");
    await journal.appendHuman([forged]);
    const { ignored, state } = await projection();
    expect(ignored).toEqual([{ id: forged.id, reason: "bad_signature" }]);
    const humans = state.humans as Record<string, HumanState>;
    expect(humans[key.device]?.presence).toEqual([]);
  });

  it("ignores a link whose event another credential signed (bad_signature)", async () => {
    const { keys, journal, now, projection, authenticator } = await product();
    const key = await loadHumanKey(keys);
    if (key === undefined) throw new Error("no key");
    const credential = await authenticator.create();
    const thief = new SoftwareAuthenticator();
    const stolen = await thief.create();
    const listing = await journal.list();
    const [forged] = await prepareHumanEvents({
      key,
      drafts: [
        {
          type: HUMAN_EVENT_TYPES.presenceLinked,
          payload: { ...(await linkPayload(key, credential)) },
          // Signed by another credential than the one linked.
          signer: presenceSigner(thief, { ...stolen, alg: credential.alg }),
        },
      ],
      deviceHead: deviceHeads(listing.events).get(key.device) ?? null,
      product: listing.events[0]?.product as string,
      newId: createUlidFactory({ now }),
      now,
    });
    if (forged === undefined) throw new Error("nothing prepared");
    await journal.appendHuman([forged]);
    const { ignored } = await projection();
    expect(ignored).toEqual([{ id: forged.id, reason: "bad_signature" }]);
  });
});

describe("review", () => {
  it("lists the open checkpoints, then approves one: locale, blocks lifted", async () => {
    const { asAgent, asHuman, projection, registry, agent } = await product();
    const opened = await asAgent("open_checkpoint", STORY);
    const refused = await registry.run("update_story", agent, {
      agent: "iris",
      story: "2-6",
      status: "in_review",
    });
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.CHECKPOINT_OPEN);

    const list = await asHuman("review", { action: "list" });
    const listed = (list as { value: ReviewList }).value;
    expect(listed.checkpoints.map((checkpoint) => checkpoint.id)).toEqual([opened.checkpoint]);
    expect(listed.presence.status).toBe("no_credential");

    const result = await asHuman("review", {
      action: "resolve",
      checkpoint: opened.checkpoint,
      decision: "approved",
    });
    expect(result.ok).toBe(true);
    expect((result as { value: ReviewResolved }).value).toMatchObject({
      checkpoint: opened.checkpoint,
      decision: "approved",
      assurance: "locale",
    });
    const allowed = await registry.run("update_story", agent, {
      agent: "iris",
      story: "2-6",
      status: "in_review",
    });
    expect(allowed.ok).toBe(true);

    const { state, ignored, warnings } = await projection();
    expect(ignored).toEqual([]);
    expect(warnings).toEqual([]);
    const checkpoint = checkpoints(state)[opened.checkpoint as string];
    expect(checkpoint?.status).toBe("resolved");
    expect(checkpoint?.resolution).toMatchObject({
      decision: "approved",
      assurance: "locale",
      source: "terminal",
    });
    const validations = state.validations as ValidationEntry[];
    expect(validations).toHaveLength(1);
    expect(validations[0]).toMatchObject({
      checkpoint: opened.checkpoint,
      decision: "approved",
      assurance: "locale",
      source: "terminal",
    });
    expect(validations[0]?.author).toMatch(/^human:/);
  });

  it("refuses a second answer (CHECKPOINT_NOT_OPEN), and the projection ignores one written anyway", async () => {
    const { asAgent, asHuman, keys, journal, now, projection } = await product();
    const opened = await asAgent("open_checkpoint", STORY);
    const answer = { action: "resolve", checkpoint: opened.checkpoint, decision: "approved" };
    expect((await asHuman("review", answer)).ok).toBe(true);
    const again = await asHuman("review", answer);
    expect(again.ok ? undefined : again.error.code).toBe(ErrorCode.CHECKPOINT_NOT_OPEN);

    const key = await loadHumanKey(keys);
    if (key === undefined) throw new Error("no key");
    const listing = await journal.list();
    const [second] = await prepareHumanEvents({
      key,
      drafts: [
        {
          type: "checkpoint.resolved",
          payload: {
            checkpoint: opened.checkpoint,
            decision: "rejected",
            note: "no",
            source: "terminal",
          },
          signer: localeSigner(key),
        },
      ],
      deviceHead: deviceHeads(listing.events).get(key.device) ?? null,
      product: listing.events[0]?.product as string,
      newId: createUlidFactory({ now }),
      now,
    });
    if (second === undefined) throw new Error("nothing prepared");
    await journal.appendHuman([second]);
    const { ignored, state } = await projection();
    expect(ignored).toEqual([{ id: second.id, reason: "already_resolved" }]);
    expect(checkpoints(state)[opened.checkpoint as string]?.resolution?.decision).toBe("approved");
  });

  it("chooses an option of a decision", async () => {
    const { asAgent, asHuman, projection } = await product();
    const opened = await asAgent("open_checkpoint", {
      ...STORY,
      type: "decision",
      options: [
        { id: "a", label: "A", consequence: "First." },
        { id: "b", label: "B", consequence: "Second." },
      ],
      recommendation: "a",
    });
    const unknown = await asHuman("review", {
      action: "resolve",
      checkpoint: opened.checkpoint,
      decision: "option_chosen",
      option: "z",
    });
    expect(unknown.ok ? undefined : unknown.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    const chosen = await asHuman("review", {
      action: "resolve",
      checkpoint: opened.checkpoint,
      decision: "option_chosen",
      option: "b",
    });
    expect(chosen.ok).toBe(true);
    const { state } = await projection();
    expect(checkpoints(state)[opened.checkpoint as string]?.resolution).toMatchObject({
      decision: "option_chosen",
      option: "b",
    });
  });

  it("needs a note to reject", async () => {
    const { asAgent, asHuman } = await product();
    const opened = await asAgent("open_checkpoint", STORY);
    const result = await asHuman("review", {
      action: "resolve",
      checkpoint: opened.checkpoint,
      decision: "rejected",
    });
    expect(result.ok ? undefined : result.error.details.reason_key).toBe("reason.review.note");
  });

  it("high risk with a linked credential: a fresh UV assertion, presence, fingerprint first", async () => {
    const { asAgent, asHuman, projection, authenticator, prompts } = await product();
    await asHuman("key", { action: "presence" });
    const opened = await asAgent("open_checkpoint", {
      ...STORY,
      type: "release",
      risk: "high",
      irreversible: true,
    });
    const list = (await asHuman("review", { action: "list" })) as { value: ReviewList };
    expect(list.value.presence.status).toBe("linked");
    const result = await asHuman("review", {
      action: "resolve",
      checkpoint: opened.checkpoint,
      decision: "approved",
    });
    expect((result as { value: ReviewResolved }).value.assurance).toBe("presence");
    expect(prompts).toHaveLength(2);
    const last = prompts[1] as PresencePrompt;
    expect(last.event.type).toBe("checkpoint.resolved");
    expect(last.fingerprint).toBe(toBase64url(webauthnChallenge(last.event)).slice(0, 8));
    expect(authenticator.calls.at(-1)?.challenge?.startsWith(last.fingerprint)).toBe(true);
    const { state, warnings, ignored } = await projection();
    expect(ignored).toEqual([]);
    expect(warnings).toEqual([]);
    expect(checkpoints(state)[opened.checkpoint as string]?.resolution?.assurance).toBe("presence");
  });

  it("high risk: a failed assertion writes nothing", async () => {
    const { asAgent, asHuman, journal, authenticator } = await product();
    await asHuman("key", { action: "presence" });
    const opened = await asAgent("open_checkpoint", { ...STORY, risk: "high" });
    authenticator.fail = true;
    const before = journal.events.length;
    const result = await asHuman("review", {
      action: "resolve",
      checkpoint: opened.checkpoint,
      decision: "approved",
    });
    expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.CANCELLED);
    expect(result.ok ? undefined : result.error.message_key).toBe("error.presence_failed");
    expect(journal.events).toHaveLength(before);
  });

  it("high risk without presence: accepted in locale, with a warning", async () => {
    const { asAgent, asHuman, projection } = await product({
      presence: new SoftwareAuthenticator({ available: false }),
    });
    const opened = await asAgent("open_checkpoint", { ...STORY, risk: "high" });
    const result = await asHuman("review", {
      action: "resolve",
      checkpoint: opened.checkpoint,
      decision: "approved",
    });
    expect((result as { value: ReviewResolved }).value).toMatchObject({
      assurance: "locale",
      presenceFallback: "unavailable",
      presenceReason: "not_configured",
    });
    const { warnings } = await projection();
    expect(warnings).toEqual([
      { code: "locale_on_high_risk", checkpoint: opened.checkpoint, id: expect.any(String) },
    ]);
  });

  describe("waivers", () => {
    const FAILING = {
      ...STORY,
      criteria: [
        { id: "tests", metric: "tests_failed", op: "<=", threshold: 0, severity: "blocking" },
      ],
    };

    it("waives a failed verdict until a deadline, which blocks again once past", async () => {
      const { asAgent, asHuman, projection, now, registry, agent } = await product();
      const opened = await asAgent("open_checkpoint", FAILING);
      await asAgent("report_measures", {
        agent: "iris",
        checkpoint: opened.checkpoint,
        measures: { tests_failed: 2 },
      });
      const tooFar = await asHuman("review", {
        action: "resolve",
        checkpoint: opened.checkpoint,
        decision: "waived",
        waiver_until: new Date(START + 31 * DAY).toISOString(),
      });
      expect(tooFar.ok ? undefined : tooFar.error.details.reason_key).toBe(
        "reason.review.deadline.too_far",
      );
      const until = new Date(START + 2 * DAY).toISOString();
      const waived = await asHuman("review", {
        action: "resolve",
        checkpoint: opened.checkpoint,
        decision: "waived",
        waiver_until: until,
      });
      expect(waived.ok).toBe(true);
      const allowed = await registry.run("update_story", agent, {
        agent: "iris",
        story: "2-6",
        status: "in_review",
      });
      expect(allowed.ok).toBe(true);
      const during = await projection();
      expect(checkpoints(during.state)[opened.checkpoint as string]?.status).toBe("waived");

      // Three days later, by the clock alone (no new event): the waiver is past.
      now.jump(3 * DAY);
      const refused = await registry.run("update_story", agent, {
        agent: "iris",
        story: "2-6",
        status: "in_review",
      });
      expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.CHECKPOINT_OPEN);
      // The projection records the deadline and never decides expiry (state.json stays the same
      // whatever the clock); readers ask the clock.
      const after = await projection();
      expect(checkpoints(after.state)[opened.checkpoint as string]?.status).toBe("waived");
      expect(after.warnings).toEqual([]);
      const view = (await registry.run("get_state", agent, { full: true })) as {
        value: {
          checkpoints: Record<string, CheckpointState>;
          stories: Record<string, StoryState>;
        };
      };
      expect(view.value.checkpoints[opened.checkpoint as string]?.status).toBe("open");
      expect(view.value.stories["2-6"]?.waiting_on).toEqual([opened.checkpoint]);
      const list = (await asHuman("review", { action: "list" })) as { value: ReviewList };
      expect(list.value.checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
        opened.checkpoint,
      ]);
      expect(
        blockingCheckpoint(
          Object.values(checkpoints(after.state)),
          "story.review",
          "2-6",
          START + 4 * DAY,
        )?.id,
      ).toBe(opened.checkpoint);
      // Dates are compared as dates: the same instant without milliseconds has expired too.
      const plain = until.replace(".000Z", "Z");
      const atDeadline = {
        ...(checkpoints(after.state)[opened.checkpoint as string] as CheckpointState),
        resolution: {
          ...(checkpoints(after.state)[opened.checkpoint as string]
            ?.resolution as CheckpointResolution),
          waiver_until: plain,
        },
      };
      expect(waiverExpired(atDeadline, Date.parse(until))).toBe(true);
      expect(waiverExpired(atDeadline, Date.parse(until) - 1)).toBe(false);
      // It can be answered again.
      const approved = await asHuman("review", {
        action: "resolve",
        checkpoint: opened.checkpoint,
        decision: "approved",
      });
      expect(approved.ok).toBe(true);
    });

    it("refuses a waiver on a security checkpoint, and without a failed verdict", async () => {
      const { asAgent, asHuman } = await product();
      const security = await asAgent("open_checkpoint", { ...FAILING, recipient_role: "security" });
      await asAgent("report_measures", {
        agent: "iris",
        checkpoint: security.checkpoint,
        measures: { tests_failed: 2 },
      });
      const deadline = new Date(START + 2 * DAY).toISOString();
      const refused = await asHuman("review", {
        action: "resolve",
        checkpoint: security.checkpoint,
        decision: "waived",
        waiver_until: deadline,
      });
      expect(refused.ok ? undefined : refused.error.details.reason_key).toBe(
        "reason.review.waiver.security",
      );
      const passing = await asAgent("open_checkpoint", STORY);
      const noVerdict = await asHuman("review", {
        action: "resolve",
        checkpoint: passing.checkpoint,
        decision: "waived",
        waiver_until: deadline,
      });
      expect(noVerdict.ok ? undefined : noVerdict.error.details.reason_key).toBe(
        "reason.review.waiver.no_failed_verdict",
      );
    });
  });

  it("refuses without an interactive terminal, and writes nothing", async () => {
    const { asAgent, asHuman, journal } = await product({ interactive: false });
    const opened = await asAgent("open_checkpoint", STORY);
    const before = journal.events.length;
    for (const input of [
      { action: "list" },
      { action: "resolve", checkpoint: opened.checkpoint, decision: "approved" },
    ]) {
      const result = await asHuman("review", input);
      expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.REVIEW_NOT_INTERACTIVE);
    }
    const key = await asHuman("key", { action: "presence" });
    expect(key.ok ? undefined : key.error.code).toBe(ErrorCode.REVIEW_NOT_INTERACTIVE);
    expect(journal.events).toHaveLength(before);
  });

  it("is not an agent's command: the registry refuses it to agents", async () => {
    const { registry, agent } = await product();
    for (const name of ["review", "key"]) {
      const result = await registry.run(name, agent, { action: "list" });
      expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.UNKNOWN_COMMAND);
    }
    expect(registry.agentCommands().map((command) => command.name)).not.toContain("review");
  });
});

describe("forged answers", () => {
  it("the journal refuses a creator's event through an agent's or the engine's write", async () => {
    const { journal, asAgent } = await product();
    const opened = await asAgent("open_checkpoint", STORY);
    const payload = { checkpoint: opened.checkpoint, decision: "approved", source: "terminal" };
    const product_id = (await journal.productId()) as string;
    for (const draft of [
      {
        type: "checkpoint.resolved",
        actor: { kind: "agent" as const, agent: "iris" },
        product: product_id,
        provenance: "trusted" as const,
        payload,
      },
      {
        type: "test.appended",
        actor: { kind: "human" as const },
        product: product_id,
        provenance: "trusted" as const,
        payload: {},
      },
      {
        type: HUMAN_EVENT_TYPES.keyRegistered,
        actor: { kind: "system" as const },
        product: product_id,
        provenance: "trusted" as const,
        payload: { public_key: toBase64url(new Uint8Array(32)) },
      },
    ]) {
      await expect(journal.append(draft)).rejects.toMatchObject({
        code: ErrorCode.EVENT_INVALID,
        details: { reason_key: "reason.human_only" },
      });
    }
  });

  it("the projection ignores an answer signed by the machine key (not_human)", async () => {
    const { journal, keys, asAgent, projection } = await product();
    const opened = await asAgent("open_checkpoint", STORY);
    const machine = await loadMachineKey(keys);
    for (const kind of ["system", "agent", "human"] as const) {
      const listing = await journal.list();
      const head = deviceHeads(listing.events).get(machine.device);
      const last = listing.events.find((event) => event.id === head?.id) as EventEnvelope;
      const unsigned: UnsignedEventEnvelope = {
        v: 1,
        id: createUlidFactory()(last.id),
        type: "checkpoint.resolved",
        at: new Date(START + DAY).toISOString(),
        actor:
          kind === "agent"
            ? { kind, device: machine.device, agent: "iris" }
            : { kind, device: machine.device },
        product: last.product,
        provenance: "trusted",
        prev: hashOf(last),
        payload: { checkpoint: opened.checkpoint, decision: "approved", source: "terminal" },
        alg: "ed25519",
      };
      const forged = await signEd25519(unsigned, machine.secretKey);
      journal.rewrite([...journal.events, forged]);
      const { ignored, state } = await projection();
      expect(ignored).toContainEqual({ id: forged.id, reason: "not_human" });
      expect(checkpoints(state)[opened.checkpoint as string]?.status).toBe("open");
    }
  });
});
