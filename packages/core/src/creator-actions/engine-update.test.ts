import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentSession,
  type AnswerRecorded,
  type ChatMessage,
  type CheckpointState,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  type EngineAutoUpdate,
  type EngineRelease,
  type EngineUpdateFailure,
  type EngineUpdateSettings,
  type EngineUpdates,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  maybeAutoUpdate,
  messageDigest,
  normalizeChatText,
  resolveProfile,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(31));
const SESSION = "5f0c-engine-update-session";
const START = Date.UTC(2026, 9, 6, 12, 0, 0);

/** The engine's updates on the machine, in memory: what the registry says and what was done. */
class FakeUpdates implements EngineUpdates {
  settingsNow: EngineUpdateSettings = { check: true, auto: false };
  announced: EngineRelease | undefined;
  installedVersions = new Set<string>();
  installResult: { ok: true } | EngineUpdateFailure = { ok: true };
  upgradeResult: { ok: true } | EngineUpdateFailure = { ok: true };
  auto: EngineAutoUpdate | undefined;
  readonly calls: string[] = [];

  async settings() {
    return this.settingsNow;
  }
  async saveSettings(patch: Partial<EngineUpdateSettings>) {
    this.calls.push(`save ${JSON.stringify(patch)}`);
    this.settingsNow = { ...this.settingsNow, ...patch };
    return this.settingsNow;
  }
  async latest() {
    return this.settingsNow.check ? this.announced : undefined;
  }
  async refresh() {
    this.calls.push("refresh");
  }
  async isInstalled(version: string) {
    return this.installedVersions.has(version);
  }
  async install(version: string) {
    this.calls.push(`install ${version}`);
    if (this.installResult.ok) this.installedVersions.add(version);
    return this.installResult;
  }
  async upgradeProduct(version: string) {
    this.calls.push(`upgrade ${version}`);
    return this.upgradeResult;
  }
  async noteAutoUpdate(update: EngineAutoUpdate) {
    this.auto = update;
  }
  async lastAutoUpdate() {
    return this.auto;
  }
}

class MemoryChatLog {
  readonly list: ChatMessage[] = [];
  say(text: string, at: number): void {
    const normalized = normalizeChatText(text);
    this.list.push({
      session: SESSION,
      at: new Date(at).toISOString(),
      digest: messageDigest(normalized),
      text: normalized,
    });
  }
  async messages(session: string): Promise<readonly ChatMessage[]> {
    return this.list.filter((message) => message.session === session);
  }
}

async function product(options: { updates?: FakeUpdates | null; engineVersion?: string } = {}) {
  const files = new MemoryFiles();
  let clock = START;
  const journalNow = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now: journalNow });
  const log = new MemoryChatLog();
  const updates = options.updates === null ? undefined : (options.updates ?? new FakeUpdates());
  const engineVersion = options.engineVersion ?? "1.0.0";
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion,
    journal,
    keys,
    now: journalNow,
    interactive: true,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    human: undefined,
    interactive: undefined,
    session: new AgentSession(START),
    now: () => clock + 500,
    chat: { log, hookInstalled: true, hooked: true },
    ...(updates === undefined ? {} : { engineUpdates: updates }),
  };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  const request = (action: Record<string, unknown>, reason = "the creator said yes") =>
    call("request_creator_action", { agent: "main", action, reason });
  const requested = async (action: Record<string, unknown>) => {
    const result = await request(action);
    if (!result.ok) {
      throw new Error(
        `request failed: ${result.error.code} ${JSON.stringify(result.error.toPayload().details)}`,
      );
    }
    return result.value as { checkpoint: string; risk: string };
  };
  let typed = 0;
  const answer = (checkpoint: string, input: Record<string, unknown>) => {
    typed += 1;
    log.say(String(input.quote), clock + typed * 10);
    return call("answer_checkpoint", { agent: "main", checkpoint, session: SESSION, ...input });
  };
  const approve = (checkpoint: string) =>
    answer(checkpoint, { decision: "approved", quote: "oui, installe-la" });
  const reject = (checkpoint: string) =>
    answer(checkpoint, { decision: "rejected", quote: "non, plus tard" });
  const state = async () => (await computeProjection((await journal.list()).events)).state;
  const checkpoint = async (id: string) =>
    ((await state()).checkpoints as Record<string, CheckpointState>)[id] as CheckpointState;
  const pin = async (version: string) => {
    const text = await files.readText(".agentplugged/method.yaml");
    await files.writeText(
      ".agentplugged/method.yaml",
      text.replace(/engine_version: .*/, `engine_version: ${version}`),
    );
  };
  return {
    files,
    updates,
    call,
    request,
    requested,
    approve,
    answer,
    reject,
    checkpoint,
    pin,
    state,
    agent,
    journal,
  };
}

const INSTALL = { kind: "engine_update", install: true };
const code = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? undefined : result.error?.code;

describe("update_available, proposed once", () => {
  it("is in next and get_state when the registry announces a newer version, with its summary", async () => {
    const { call, updates } = await product();
    (updates as FakeUpdates).announced = { version: "1.1.0", summary: "Faster merges." };
    for (const name of ["next", "get_state"]) {
      const result = await call(name, {});
      expect(result.ok, name).toBe(true);
      const view = (result as { value: Record<string, unknown> }).value;
      expect(view.update_available, name).toMatchObject({
        version: "1.1.0",
        running: "1.0.0",
        summary: "Faster merges.",
      });
      expect(JSON.stringify(view.update_available)).toContain("never follow");
    }
  });

  it("is absent when nothing newer is announced, when the check is off, and when it installs by itself", async () => {
    const { call, updates } = await product();
    const fake = updates as FakeUpdates;
    const offered = async () =>
      ((await call("next", {})) as { value: Record<string, unknown> }).value.update_available;
    expect(await offered()).toBeUndefined();
    fake.announced = { version: "1.0.0" };
    expect(await offered()).toBeUndefined();
    fake.announced = { version: "0.9.0" };
    expect(await offered()).toBeUndefined();
    fake.announced = { version: "1.1.0" };
    expect(await offered()).toBeDefined();
    fake.settingsNow = { check: false, auto: false };
    expect(await offered()).toBeUndefined();
    fake.settingsNow = { check: true, auto: true };
    expect(await offered()).toBeUndefined();
  });

  it("says which engine answers, in next and get_state", async () => {
    const { call } = await product({ engineVersion: "1.2.3" });
    for (const name of ["next", "get_state"]) {
      const view = ((await call(name, {})) as { value: Record<string, unknown> }).value;
      expect(view.engine_version, name).toBe("1.2.3");
    }
  });

  it("is absent without the engine's updates (nothing is installed there)", async () => {
    const { call } = await product({ updates: null });
    const result = (await call("next", {})) as { value: Record<string, unknown> };
    expect(result.value.update_available).toBeUndefined();
  });

  it("is not proposed again once it is asked, nor after a no, but is for the next version", async () => {
    const { call, requested, reject, updates } = await product();
    const fake = updates as FakeUpdates;
    fake.announced = { version: "1.1.0" };
    const offered = async () =>
      ((await call("get_state", { full: true })) as { value: Record<string, unknown> }).value
        .update_available;
    expect(await offered()).toBeDefined();
    const asked = await requested(INSTALL);
    // The point is open: it is in what waits for the creator, not offered a second time.
    expect(await offered()).toBeUndefined();
    expect((await reject(asked.checkpoint)).ok).toBe(true);
    expect(await offered()).toBeUndefined();
    expect(fake.calls).not.toContain("install 1.1.0");
    fake.announced = { version: "1.2.0" };
    expect(await offered()).toMatchObject({ version: "1.2.0" });
  });

  it("never makes a call fail when the engine's updates do", async () => {
    const { call, updates } = await product();
    (updates as FakeUpdates).latest = () => Promise.reject(new Error("registry down"));
    const result = await call("next", {});
    expect(result.ok).toBe(true);
    expect((result as { value: Record<string, unknown> }).value.update_available).toBeUndefined();
  });
});

describe("engine_update: the product asks for a newer engine than the session runs", () => {
  it("is carried when the pin is ahead, with the install proposal instead of /mcp", async () => {
    const { call, pin } = await product();
    await pin("1.4.0");
    const view = ((await call("next", {})) as { value: Record<string, unknown> }).value;
    expect(view.engine_update).toMatchObject({ running: "1.0.0", installed: "1.4.0" });
    const action = (view.engine_update as { action: string }).action;
    expect(action).toContain("engine_update");
    expect(action).not.toContain("/mcp");
  });

  it("keeps the old gesture where nothing can install (no engine updates)", async () => {
    const { call, pin } = await product({ updates: null });
    await pin("1.4.0");
    const view = ((await call("get_state", { full: true })) as { value: Record<string, unknown> })
      .value;
    expect((view.engine_update as { action: string }).action).toContain("/mcp");
  });

  it("is not carried when the pin is the running version or older", async () => {
    const { call, pin } = await product();
    await pin("1.0.0");
    expect(
      ((await call("next", {})) as { value: Record<string, unknown> }).value.engine_update,
    ).toBeUndefined();
  });
});

describe("the creator's yes installs the engine (request_creator_action engine_update)", () => {
  it("is asked as a medium risk, the version read by the engine, never the agent's", async () => {
    const { requested, request, checkpoint, updates } = await product();
    (updates as FakeUpdates).announced = { version: "1.1.0", summary: "Faster merges." };
    const asked = await requested(INSTALL);
    expect(asked.risk).toBe("medium");
    const point = await checkpoint(asked.checkpoint);
    expect(point.title).toBe("Update the engine to 1.1.0");
    expect(point.creator_action).toMatchObject({ kind: "engine_update", version: "1.1.0" });
    expect(point.summary).toContain("in its own folder");
    // An agent that names a version, or another registry, is refused.
    const named = await request({ kind: "engine_update", install: true, version: "9.9.9" });
    expect(code(named)).toBe(ErrorCode.INVALID_ARGUMENTS);
  });

  it("installs the version in its own folder, then brings the product to it, on one answer", async () => {
    const { requested, approve, updates, checkpoint } = await product();
    const fake = updates as FakeUpdates;
    fake.announced = { version: "1.1.0" };
    const asked = await requested(INSTALL);
    expect(fake.calls).toEqual([]);
    const result = await approve(asked.checkpoint);
    expect(result.ok).toBe(true);
    expect((result as { value: AnswerRecorded }).value.executed).toMatchObject({
      kind: "engine_update",
      engine: { installed: "1.1.0", product: "updated" },
    });
    expect(fake.calls).toEqual(["install 1.1.0", "upgrade 1.1.0"]);
    expect((await checkpoint(asked.checkpoint)).executed).toMatchObject({ source: "chat" });
  });

  it("installs the version the product pins, and has nothing to pin again", async () => {
    const { requested, approve, updates, pin } = await product();
    const fake = updates as FakeUpdates;
    // The registry says 1.9.0, but the product asks for 1.4.0: the product's version comes first.
    fake.announced = { version: "1.9.0" };
    await pin("1.4.0");
    const asked = await requested(INSTALL);
    const result = await approve(asked.checkpoint);
    expect((result as { value: AnswerRecorded }).value.executed).toMatchObject({
      engine: { installed: "1.4.0", product: "already" },
    });
    expect(fake.calls).toEqual(["install 1.4.0"]);
  });

  it("does nothing when the creator says no", async () => {
    const { requested, reject, updates, checkpoint } = await product();
    const fake = updates as FakeUpdates;
    fake.announced = { version: "1.1.0" };
    const asked = await requested(INSTALL);
    await reject(asked.checkpoint);
    expect(fake.calls).toEqual([]);
    expect((await checkpoint(asked.checkpoint)).resolution?.decision).toBe("rejected");
  });

  it("is CREATOR_ACTION_UNCHANGED when there is nothing newer to install", async () => {
    const { request, updates } = await product();
    expect(code(await request(INSTALL))).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
    (updates as FakeUpdates).announced = { version: "1.0.0" };
    expect(code(await request(INSTALL))).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
    (updates as FakeUpdates).settingsNow = { check: false, auto: false };
    (updates as FakeUpdates).announced = { version: "1.1.0" };
    expect(code(await request(INSTALL))).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
  });

  it("is stale, and installs nothing, when the version moved since the request", async () => {
    const { requested, approve, updates, checkpoint } = await product();
    const fake = updates as FakeUpdates;
    fake.announced = { version: "1.1.0" };
    const asked = await requested(INSTALL);
    fake.announced = { version: "1.2.0" };
    const result = await approve(asked.checkpoint);
    expect(code(result)).toBe(ErrorCode.CREATOR_ACTION_STALE);
    expect(fake.calls).toEqual([]);
    expect((await checkpoint(asked.checkpoint)).status).toBe("open");
  });

  it("says why it failed, leaves the running engine alone, and can be asked again", async () => {
    const { requested, approve, updates, call } = await product();
    const fake = updates as FakeUpdates;
    fake.announced = { version: "1.1.0" };
    fake.installResult = { ok: false, reason: "install_failed", message: "ENOTFOUND registry" };
    const asked = await requested(INSTALL);
    const result = await approve(asked.checkpoint);
    expect(code(result)).toBe(ErrorCode.CREATOR_ACTION_FAILED);
    const error = (result as { error: { toPayload(): { details: Record<string, unknown> } } })
      .error;
    expect(error.toPayload().details).toMatchObject({
      kind: "engine_update",
      reason: "install_failed",
      message: "ENOTFOUND registry",
    });
    expect(fake.calls).toEqual(["install 1.1.0"]);
    // The approval stays; the same version is offered again, as no installation ended.
    const view = ((await call("get_state", { full: true })) as { value: Record<string, unknown> })
      .value;
    expect(view.update_available).toMatchObject({ version: "1.1.0" });
  });

  it("reports a product that could not be brought to the new version, and says what to run", async () => {
    const { requested, approve, updates, call } = await product();
    const fake = updates as FakeUpdates;
    fake.announced = { version: "1.1.0" };
    fake.upgradeResult = {
      ok: false,
      reason: "product_update_failed",
      message: "migration required",
    };
    const asked = await requested(INSTALL);
    const result = await approve(asked.checkpoint);
    expect(code(result)).toBe(ErrorCode.CREATOR_ACTION_FAILED);
    const error = (
      result as {
        error: { message_key: string; toPayload(): { details: Record<string, unknown> } };
      }
    ).error;
    // Its own message: the engine is installed, what is left is the product (migrate, once).
    expect(error.message_key).toBe("error.creator_action_failed.engine_product");
    expect(error.toPayload().details).toMatchObject({
      version: "1.1.0",
      reason: "product_update_failed",
      message: "migration required",
    });
    expect(fake.calls).toEqual(["install 1.1.0", "upgrade 1.1.0"]);
    // The version is installed: the creator's yes is not asked for again, every call.
    const view = ((await call("get_state", { full: true })) as { value: Record<string, unknown> })
      .value;
    expect(view.update_available).toBeUndefined();
  });

  it("sets the two settings of the machine, low risk, and nothing is installed", async () => {
    const { requested, approve, updates, checkpoint } = await product();
    const fake = updates as FakeUpdates;
    const asked = await requested({ kind: "engine_update", check: false });
    expect(asked.risk).toBe("low");
    expect((await checkpoint(asked.checkpoint)).title).toBe(
      "Stop checking the registry for engine updates",
    );
    const result = await approve(asked.checkpoint);
    expect((result as { value: AnswerRecorded }).value.executed).toMatchObject({
      engine: { settings: { check: false, auto: false } },
    });
    expect(fake.settingsNow).toEqual({ check: false, auto: false });
    expect(fake.calls).toEqual(['save {"check":false}']);
  });

  it("turns the automatic updates on as a medium risk, and refuses what is already so", async () => {
    const { requested, request, approve, updates } = await product();
    const fake = updates as FakeUpdates;
    const asked = await requested({ kind: "engine_update", auto: true });
    expect(asked.risk).toBe("medium");
    await approve(asked.checkpoint);
    expect(fake.settingsNow.auto).toBe(true);
    expect(code(await request({ kind: "engine_update", auto: true }))).toBe(
      ErrorCode.CREATOR_ACTION_UNCHANGED,
    );
  });
});

describe("the automatic update (the creator turned it on)", () => {
  const context = (updates: FakeUpdates, engineVersion = "1.0.0"): CommandContext =>
    ({
      files: new MemoryFiles(),
      engineVersion,
      engineUpdates: updates,
      actor: "agent",
      now: () => START,
    }) as unknown as CommandContext;

  it("installs what the registry announces and brings the product to it, then notes it", async () => {
    const { files, agent, updates } = await product();
    const fake = updates as FakeUpdates;
    fake.settingsNow = { check: true, auto: true };
    fake.announced = { version: "1.1.0" };
    const moved = await maybeAutoUpdate({ ...agent, files });
    expect(moved).toBe("1.1.0");
    expect(fake.calls).toEqual(["install 1.1.0", "upgrade 1.1.0"]);
    expect(fake.auto).toMatchObject({ from: "1.0.0", to: "1.1.0" });
  });

  it("is said once in get_state, for a day", async () => {
    const { call, agent, updates, files } = await product();
    const fake = updates as FakeUpdates;
    fake.settingsNow = { check: true, auto: true };
    fake.announced = { version: "1.2.0" };
    await maybeAutoUpdate({ ...agent, files });
    const view = ((await call("get_state", { full: true })) as { value: Record<string, unknown> })
      .value;
    expect(view.engine_updated).toMatchObject({ from: "1.0.0", to: "1.2.0" });
  });

  it("does nothing by default, with the check off, or with nothing newer", async () => {
    const fake = new FakeUpdates();
    fake.announced = { version: "1.1.0" };
    expect(await maybeAutoUpdate(context(fake))).toBeUndefined();
    fake.settingsNow = { check: false, auto: true };
    expect(await maybeAutoUpdate(context(fake))).toBeUndefined();
    fake.settingsNow = { check: true, auto: true };
    fake.announced = { version: "1.0.0" };
    expect(await maybeAutoUpdate(context(fake))).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  it("never takes a version the product's files name, only the registry's", async () => {
    const { agent, files, pin, updates } = await product();
    const fake = updates as FakeUpdates;
    fake.settingsNow = { check: true, auto: true };
    fake.announced = undefined;
    await pin("5.0.0");
    expect(await maybeAutoUpdate({ ...agent, files })).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  it("never throws and does not try again a version that failed", async () => {
    const fake = new FakeUpdates();
    fake.settingsNow = { check: true, auto: true };
    fake.announced = { version: "1.3.0" };
    fake.installResult = { ok: false, reason: "install_failed" };
    const ctx = context(fake);
    expect(await maybeAutoUpdate(ctx)).toBeUndefined();
    expect(await maybeAutoUpdate(ctx)).toBeUndefined();
    expect(fake.calls).toEqual(["install 1.3.0"]);
  });
});

describe("a session older than the product's pin (the way out is the creator's yes)", () => {
  it("refuses every other command, and tells the agent to call next and ask for the yes", async () => {
    const { call, request, pin } = await product();
    await pin("1.4.0");
    const status = await call("report_status", { agent: "main", status: "working" });
    expect(code(status)).toBe(ErrorCode.ENGINE_VERSION_MISMATCH);
    const error = (status as { error: { message_key: string; toPayload(): { details: unknown } } })
      .error;
    expect(error.message_key).toBe("error.engine_version_too_old.agent");
    expect(error.toPayload().details).toMatchObject({ pinned: "1.4.0", engine_version: "1.0.0" });
    // Another request of the creator's is not the way out either.
    expect(code(await request({ kind: "profile", validation: "chat" }))).toBe(
      ErrorCode.ENGINE_VERSION_MISMATCH,
    );
  });

  it("answers the point of the update, and no other point", async () => {
    const { requested, approve, answer, pin, updates, checkpoint, call } = await product();
    await pin("1.4.0");
    const asked = await requested(INSTALL);
    const done = await approve(asked.checkpoint);
    expect(done.ok).toBe(true);
    expect((await checkpoint(asked.checkpoint)).status).toBe("resolved");
    expect((updates as FakeUpdates).calls).toEqual(["install 1.4.0"]);
    // A point that is not the update's stays out of reach until the session runs the pinned version.
    const other = await answer("G-0000000000", { decision: "approved", quote: "oui" });
    expect(code(other)).toBe(ErrorCode.ENGINE_VERSION_MISMATCH);
    const form = await call("ask_creator", { agent: "main", checkpoint: "G-0000000000" });
    expect(code(form)).toBe(ErrorCode.ENGINE_VERSION_MISMATCH);
  });
});
