import { eventHash, signEd25519, toBase64url } from "@agentplugged/crypto";
import {
  ErrorCode,
  type EventEnvelope,
  METHOD_EVENT_TYPES,
  type UnsignedEventEnvelope,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import {
  AgentPluggedError,
  type AppendOptions,
  applyMigration,
  type CommandContext,
  checkEngine,
  computeProjection,
  createCommandRegistry,
  createUlidFactory,
  type EventDraft,
  type FormatMigration,
  type KeyStore,
  LATEST_ENGINE,
  loadMachineKey,
  METHOD_MIGRATIONS,
  MemoryKeyStore,
  MemoryStateStore,
  type MigrateResult,
  type ProjectStateResult,
  planMigration,
  stringifyMethodDocument,
  UPGRADE_DEFAULT_COMMAND,
  upgradeTarget,
  withUpgradeTarget,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const CONFIG = ".agentplugged/method.yaml";
const ENGINE = "1.1.0";
const PRODUCT_ID = "01JZ4444444444444444444444";
const OTHER_PRODUCT = "01JZ5555555555555555555555";
const SEED = toBase64url(new Uint8Array(32).fill(5));
const SEED_B = toBase64url(new Uint8Array(32).fill(6));

/**
 * Fixture of the tests only, never shipped: format 0 named the targeted AI tools `targets`;
 * format 1 names them `tools`. The shipped step of format 2 (`rename-agents`) follows it. Written as every step should be (`stringifyMethodDocument`).
 */
const TARGETS_TO_TOOLS: FormatMigration = {
  from: 0,
  id: "test-targets-to-tools",
  apply(text) {
    const document = parseDocument(text);
    const targets = document.get("targets", true);
    if (targets !== undefined) {
      document.delete("targets");
      document.set("tools", targets);
    }
    return stringifyMethodDocument(document, text);
  },
};

const FORMAT_0 = `# Réglages d'Ada : garder ce commentaire
format_version: 0
engine_version: 1.0.0
targets:
  - claude-code
  - codex
`;

const FORMAT_1 = (engine: string) => `# Réglages d'Ada
format_version: 2
engine_version: ${engine}
product_id: ${PRODUCT_ID}
`;

/** A clock that moves 1 s per call. */
function clock(start = Date.UTC(2026, 9, 3, 12, 0, 0)) {
  let now = start;
  return () => {
    now += 1000;
    return now;
  };
}

/** A journal whose `appendAll` first lets a test act, as another process would meanwhile. */
class RacingStore extends MemoryStateStore {
  meanwhile: (() => Promise<void>) | undefined;
  async appendAll(drafts: readonly EventDraft[], options?: AppendOptions) {
    const act = this.meanwhile;
    this.meanwhile = undefined;
    await act?.();
    return super.appendAll(drafts, options);
  }
}

/** Files whose writes of `method.yaml` fail while `failing` is set. */
class FlakyFiles extends MemoryFiles {
  failing = false;
  /** Returned by the next reads of `method.yaml` after the first one, when set. */
  changedTo: string | undefined;
  #reads = 0;
  async readText(path: string) {
    // The engine check and `migrate` read it first; the precondition reads it again.
    if (path === CONFIG && this.changedTo !== undefined && this.#reads++ > 1) {
      return this.changedTo;
    }
    return super.readText(path);
  }
  async writeText(path: string, content: string) {
    if (this.failing && path === CONFIG) throw new Error("disk full");
    return super.writeText(path, content);
  }
}

function setup(config: string, extra: Partial<CommandContext> = {}) {
  const files = new FlakyFiles({ [CONFIG]: config });
  const keys = new MemoryKeyStore(SEED);
  const journal = new RacingStore({ keys, now: clock(), allowTestTypes: true });
  const context: CommandContext = {
    files,
    tools: {
      which: async () => undefined,
      version: async () => undefined,
      extensions: async () => [],
    },
    method: shippedMethod(),
    actor: "human",
    engineVersion: ENGINE,
    interactive: true,
    journal,
    keys,
    newId: () => PRODUCT_ID,
    migrations: [TARGETS_TO_TOOLS, ...METHOD_MIGRATIONS],
    // The journal holds a test event (`test.appended`) in some tests: projected like any other.
    allowTestTypes: true,
    ...extra,
  };
  const registry = createCommandRegistry();
  const run = (
    name: string,
    input: Record<string, unknown> = {},
    more: Partial<CommandContext> = {},
  ) => registry.run(name, { ...context, ...more }, input);
  return { files, journal, context, run };
}

type RunResult = Awaited<ReturnType<ReturnType<typeof setup>["run"]>>;

function value(result: RunResult): MigrateResult {
  if (!result.ok) {
    throw new Error(`migrate failed: ${result.error.code} ${result.error.message_key}`);
  }
  return result.value as MigrateResult;
}

function errorOf(result: RunResult) {
  if (result.ok) throw new Error("expected an error");
  return result.error;
}

const migratedEvents = (journal: MemoryStateStore) =>
  journal.events.filter((event) => event.type === METHOD_EVENT_TYPES.migrated);

/** Another machine's events (its key from `SEED_B`), after which `journal` holds them too. */
async function fromAnotherMachine(journal: MemoryStateStore, drafts: readonly EventDraft[]) {
  const other = new MemoryStateStore({
    keys: new MemoryKeyStore(SEED_B),
    now: clock(Date.UTC(2026, 9, 3, 12, 30, 0)),
  });
  for (const draft of drafts) await other.append(draft);
  journal.rewrite([...journal.events, ...other.events]);
}

const migratedDraft = (payload: Record<string, unknown>, product = PRODUCT_ID): EventDraft => ({
  type: METHOD_EVENT_TYPES.migrated,
  actor: { kind: "system" },
  product,
  provenance: "trusted",
  payload,
});

/** A copy of `base` with `change`, after `base` in its chain, signed by the machine `seed`. */
async function signedAfter(base: EventEnvelope, change: Record<string, unknown>, seed = SEED) {
  const key = await loadMachineKey(new MemoryKeyStore(seed));
  const { sig: _sig, ...unsigned } = base;
  const hash = eventHash(base);
  if (!hash.ok) throw new Error("no hash");
  return signEd25519(
    {
      ...unsigned,
      id: createUlidFactory({ now: () => Date.UTC(2026, 9, 3, 14, 0, 0) })(),
      prev: hash.hash,
      ...change,
    } as UnsignedEventEnvelope,
    key.secretKey,
  );
}

describe("migration registry", () => {
  it("ships the step of format 2, and nothing from format 2 on", () => {
    expect(METHOD_MIGRATIONS.map((step) => [step.from, step.id])).toEqual([[1, "rename-agents"]]);
    expect(planMigration(2, 2, METHOD_MIGRATIONS)).toEqual([]);
  });

  it("plans the steps in order, and refuses a gap or two steps from one format", () => {
    const second: FormatMigration = { from: 1, id: "test-second", apply: (text) => text };
    const plan = planMigration(0, 2, [second, TARGETS_TO_TOOLS]);
    expect(Array.isArray(plan) && plan.map((step) => step.id)).toEqual([
      "test-targets-to-tools",
      "test-second",
    ]);
    const gap = planMigration(0, 2, [second]);
    expect(gap).toBeInstanceOf(AgentPluggedError);
    expect((gap as AgentPluggedError).toPayload()).toMatchObject({
      code: ErrorCode.METHOD_CONFIG_INVALID,
      details: { field: "format_version", reason: "no migration from format 0 to format 1" },
    });
    const twice = planMigration(0, 1, [
      TARGETS_TO_TOOLS,
      { ...TARGETS_TO_TOOLS, id: "test-other" },
    ]);
    expect((twice as AgentPluggedError).details.reason).toBe("several migrations from format 0");
    const badId = planMigration(0, 1, [{ ...TARGETS_TO_TOOLS, id: "Not An Id" }]);
    expect(badId).toBeInstanceOf(AgentPluggedError);
  });

  it("applies a step purely, keeping comments, then pins the engine and adds the product id", () => {
    const options = { engineVersion: ENGINE, productId: PRODUCT_ID };
    const text = applyMigration(FORMAT_0, [TARGETS_TO_TOOLS, ...METHOD_MIGRATIONS], options);
    expect(text).toBe(`# Réglages d'Ada : garder ce commentaire
format_version: 2
engine_version: ${ENGINE}
product_id: ${PRODUCT_ID}
tools:
  - claude-code
  - codex
`);
    // Pure: the same input gives the same output, the input untouched.
    expect(applyMigration(FORMAT_0, [TARGETS_TO_TOOLS, ...METHOD_MIGRATIONS], options)).toBe(text);
    const crlf = applyMigration(
      FORMAT_0.replace(/\n/g, "\r\n"),
      [TARGETS_TO_TOOLS, ...METHOD_MIGRATIONS],
      options,
    );
    expect(crlf).toBe((text as string).replace(/\n/g, "\r\n"));
  });

  it("keeps long lines and flow lists as the creator wrote them", () => {
    const long = `--${"a-very-long-argument-".repeat(6)}end`;
    const layout = `format_version: 0
engine_version: 1.0.0
targets: [claude-code, codex]
mcp:
  command: node
  args: [${long}, --flag]
`;
    const text = applyMigration(layout, [TARGETS_TO_TOOLS, ...METHOD_MIGRATIONS], {
      engineVersion: ENGINE,
      productId: PRODUCT_ID,
    });
    expect(text).toBe(`format_version: 2
engine_version: ${ENGINE}
product_id: ${PRODUCT_ID}
mcp:
  command: node
  args: [${long}, --flag]
tools: [claude-code, codex]
`);
  });

  it("refuses a step that throws or leaves method.yaml invalid", () => {
    const options = { engineVersion: ENGINE, productId: PRODUCT_ID };
    const throwing: FormatMigration = {
      from: 0,
      id: "test-throws",
      apply: () => {
        throw new Error("boom");
      },
    };
    const thrown = applyMigration(FORMAT_0, [throwing], options);
    expect((thrown as AgentPluggedError).details).toMatchObject({
      field: "format_version",
      reason: "migration test-throws: boom",
    });
    const identity: FormatMigration = { from: 0, id: "test-identity", apply: (text) => text };
    const invalid = applyMigration(FORMAT_0, [identity], options);
    expect((invalid as AgentPluggedError).code).toBe(ErrorCode.METHOD_CONFIG_INVALID);
  });
});

describe("checkEngine and the format", () => {
  it("stops every command but migrate on an older format with MIGRATION_REQUIRED", async () => {
    const files = new MemoryFiles({ [CONFIG]: FORMAT_0 });
    const stopped = await checkEngine(files, { engineVersion: ENGINE, command: "sync" });
    expect(stopped instanceof AgentPluggedError && stopped.toPayload()).toEqual({
      code: ErrorCode.MIGRATION_REQUIRED,
      message_key: "error.migration_required",
      details: {
        path: CONFIG,
        format_version: 0,
        supported: 2,
        engine_version: ENGINE,
        command: "sync",
      },
    });
    const passes = await checkEngine(files, {
      engineVersion: ENGINE,
      command: "migrate",
      migrate: true,
      upgrade: true,
    });
    expect(passes).toEqual({ pinned: "1.0.0", overridden: false, older: false });
  });

  it("asks agents to have the creator migrate or upgrade, never to run a tool name", async () => {
    const older = setup(FORMAT_0);
    const migration = errorOf(await older.run("get_state", {}, { actor: "agent" }));
    expect(migration.message_key).toBe("error.migration_required.agent");
    const newer = setup("format_version: 3\nengine_version: 2.0.0\n");
    const upgrade = errorOf(await newer.run("get_state", {}, { actor: "agent" }));
    expect(upgrade.message_key).toBe("error.upgrade_required.agent");
    expect(upgrade.details).toMatchObject({ install: "2.0.0", engine_version: ENGINE });
  });
});

describe("migrate", () => {
  it("says it is up to date and writes nothing", async () => {
    const { files, journal, run } = setup(FORMAT_1(ENGINE));
    const result = value(await run("migrate"));
    expect(result).toEqual({
      status: "up_to_date",
      from_format: 2,
      to_format: 2,
      from_engine: ENGINE,
      to_engine: ENGINE,
      steps: [],
    });
    expect(files.writes).toEqual([]);
    expect(journal.events).toEqual([]);
  });

  it("pins the running engine when only the engine changed, recorded in the journal", async () => {
    const { files, journal, run } = setup(FORMAT_1("1.0.0"));
    const result = value(await run("migrate"));
    expect(result).toMatchObject({
      status: "migrated",
      from_format: 2,
      to_format: 2,
      from_engine: "1.0.0",
      to_engine: ENGINE,
      steps: [],
      event: "written",
    });
    expect(files.files.get(CONFIG)).toBe(FORMAT_1(ENGINE));
    const [migrated] = migratedEvents(journal);
    expect(migrated?.id).toBe(result.event_id);
    expect(migrated?.actor.kind).toBe("system");
    expect(migrated?.payload).toEqual({
      from_format: 2,
      to_format: 2,
      from_engine: "1.0.0",
      to_engine: ENGINE,
      steps: [],
    });
    // Running it again: up to date.
    expect(value(await run("migrate")).status).toBe("up_to_date");
  });

  it("migrates an older format with the fixture step, adding events only", async () => {
    const { files, journal, run } = setup(FORMAT_0);
    // Another command stops, nothing written.
    const sync = errorOf(await run("sync"));
    expect(sync.code).toBe(ErrorCode.MIGRATION_REQUIRED);
    expect(files.writes).toEqual([]);

    // A first event in the journal: it is never rewritten.
    await journal.append({
      type: "test.appended",
      actor: { kind: "system" },
      product: PRODUCT_ID,
      provenance: "trusted",
      payload: { n: 1 },
    });
    const before = journal.events.map((event) => JSON.stringify(event));

    // `--check` shows all a run would do, and opens no keychain.
    let opened = 0;
    class LockedKeys extends MemoryKeyStore {
      async readMachineSecret(): Promise<string | undefined> {
        opened += 1;
        throw new Error("keychain opened");
      }
    }
    const locked: KeyStore = new LockedKeys(SEED);
    const check = value(
      await run("migrate", { check: true }, { interactive: false, keys: locked }),
    );
    expect(check).toEqual({
      status: "planned",
      from_format: 0,
      to_format: 2,
      from_engine: "1.0.0",
      to_engine: ENGINE,
      steps: ["test-targets-to-tools", "rename-agents"],
      event: "written",
      product_id_added: PRODUCT_ID,
      // The step of format 2 copies the shipped method again.
      files: [
        { action: "write", path: ".agentplugged/agents/iris/SKILL.md" },
        { action: "write", path: ".agentplugged/agents/iris/agent.yaml" },
      ],
    });
    expect(files.writes).toEqual([]);
    expect(opened).toBe(0);
    expect(journal.events.map((event) => JSON.stringify(event))).toEqual(before);

    const result = value(await run("migrate"));
    expect(result).toMatchObject({
      status: "migrated",
      from_format: 0,
      to_format: 2,
      steps: ["test-targets-to-tools", "rename-agents"],
      event: "written",
      product_id_added: PRODUCT_ID,
    });
    // The shipped method copied again by the step of format 2, `method.yaml` last.
    expect(files.writes).toEqual([
      ".agentplugged/agents/iris/SKILL.md",
      ".agentplugged/agents/iris/agent.yaml",
      CONFIG,
    ]);
    const text = files.files.get(CONFIG) ?? "";
    expect(text).toContain("# Réglages d'Ada : garder ce commentaire");
    expect(text).toContain("format_version: 2");
    expect(text).toContain(`engine_version: ${ENGINE}`);
    expect(text).toContain("tools:\n  - claude-code\n  - codex");
    expect(text).not.toContain("targets");
    // Events added after the earlier ones, which are untouched.
    const after = journal.events.map((event) => JSON.stringify(event));
    expect(after.slice(0, before.length)).toEqual(before);
    expect(journal.events.at(-1)?.type).toBe(METHOD_EVENT_TYPES.migrated);

    // The projection keeps the format reached, and the machine that recorded it.
    const status = await run("journal", { action: "status" });
    const state = (status.ok ? (status.value as ProjectStateResult) : undefined)?.state;
    const machine = (await loadMachineKey(new MemoryKeyStore(SEED))).device;
    expect(state?.state.format).toMatchObject({ version: 2, engine: ENGINE, device: machine });
    // Now up to date, and no other command is stopped any more.
    expect(value(await run("migrate")).status).toBe("up_to_date");
    expect(await checkEngine(files, { engineVersion: ENGINE, command: "sync" })).toEqual({
      pinned: ENGINE,
      overridden: false,
      older: false,
    });
  });

  it("adopts the journal's product id, not a new one", async () => {
    const { files, journal, run } = setup(FORMAT_0);
    await journal.append({
      type: "test.appended",
      actor: { kind: "system" },
      product: OTHER_PRODUCT,
      provenance: "trusted",
      payload: { n: 1 },
    });
    const result = value(await run("migrate"));
    expect(result.product_id_added).toBe(OTHER_PRODUCT);
    expect(files.files.get(CONFIG)).toContain(`product_id: ${OTHER_PRODUCT}`);
    expect(migratedEvents(journal)[0]?.product).toBe(OTHER_PRODUCT);
  });

  it("refuses a format without a migration path, writing nothing", async () => {
    const { files, journal, run } = setup(FORMAT_0, { migrations: [] });
    const error = errorOf(await run("migrate"));
    expect(error.toPayload()).toMatchObject({
      code: ErrorCode.METHOD_CONFIG_INVALID,
      details: { field: "format_version", reason: "no migration from format 0 to format 1" },
    });
    expect(files.writes).toEqual([]);
    expect(journal.events).toEqual([]);
  });

  it("never migrates a newer format down, nor replaces a newer pinned engine", async () => {
    const newer = setup("format_version: 3\nengine_version: 2.0.0\n");
    const upgrade = errorOf(await newer.run("migrate"));
    expect(upgrade.code).toBe(ErrorCode.UPGRADE_REQUIRED);
    expect(upgrade.details.version).toBe("2.0.0");
    expect(newer.files.writes).toEqual([]);

    const pinned = setup(FORMAT_1("2.0.0"));
    const mismatch = errorOf(await pinned.run("migrate"));
    expect(mismatch.code).toBe(ErrorCode.ENGINE_VERSION_MISMATCH);
    const any = errorOf(await pinned.run("migrate", {}, { engineAny: true }));
    expect(any.code).toBe(ErrorCode.ENGINE_VERSION_MISMATCH);
    expect(pinned.files.writes).toEqual([]);
    expect(pinned.journal.events).toEqual([]);
  });

  it("is the creator's, at a terminal; --check needs none; agents cannot run it", async () => {
    const { files, journal, run } = setup(FORMAT_0);
    const refused = errorOf(await run("migrate", {}, { interactive: false }));
    expect(refused.toPayload()).toEqual({
      code: ErrorCode.REVIEW_NOT_INTERACTIVE,
      message_key: "error.review_not_interactive",
      details: { command: "migrate" },
    });
    const agent = errorOf(await run("migrate", {}, { actor: "agent" }));
    expect(agent.code).toBe(ErrorCode.UNKNOWN_COMMAND);
    const badCheck = errorOf(await run("migrate", { check: "yes" }));
    expect(badCheck.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(files.writes).toEqual([]);
    expect(journal.events).toEqual([]);
  });

  it("reports METHOD_NOT_INSTALLED without method.yaml", async () => {
    const { files, run } = setup(FORMAT_0);
    files.files.delete(CONFIG);
    expect(errorOf(await run("migrate")).code).toBe(ErrorCode.METHOD_NOT_INSTALLED);
  });

  it("migrates the files without a Git repository, saying no event was recorded", async () => {
    const { files, journal, run } = setup(FORMAT_0);
    journal.listFailure = new AgentPluggedError(
      ErrorCode.NOT_A_GIT_REPO,
      "error.not_a_git_repo",
      {},
    );
    const check = value(await run("migrate", { check: true }));
    expect(check.event).toBe("no_repo");
    const result = value(await run("migrate"));
    expect(result).toMatchObject({ status: "migrated", event: "no_repo" });
    expect(result.event_id).toBeUndefined();
    expect(files.files.get(CONFIG)).toContain("format_version: 2");
  });

  it("writes nothing when the journal cannot be read", async () => {
    const { files, journal, run } = setup(FORMAT_1("1.0.0"));
    journal.listFailure = new AgentPluggedError(ErrorCode.JOURNAL_BUSY, "error.journal_busy", {});
    expect(errorOf(await run("migrate")).code).toBe(ErrorCode.JOURNAL_BUSY);
    expect(files.writes).toEqual([]);
  });

  it("refuses method.migrated from anyone but the engine", async () => {
    const { journal } = setup(FORMAT_1(ENGINE));
    await expect(
      journal.append({
        ...migratedDraft({
          from_format: 2,
          to_format: 2,
          from_engine: null,
          to_engine: ENGINE,
          steps: [],
        }),
        actor: { kind: "agent", agent: "sam" },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.EVENT_INVALID, details: { field: "actor.kind" } });
  });
});

describe("migrate, once and only once", () => {
  it("names the event and writes method.yaml on the next run, without a second event", async () => {
    const { files, journal, run } = setup(FORMAT_1("1.0.0"));
    files.failing = true;
    const failed = errorOf(await run("migrate"));
    const [event] = migratedEvents(journal);
    expect(failed.toPayload()).toEqual({
      code: ErrorCode.UNEXPECTED,
      message_key: "error.migrate.write_failed",
      details: { path: CONFIG, event_id: event?.id, reason: "disk full" },
    });
    expect(files.files.get(CONFIG)).toBe(FORMAT_1("1.0.0"));
    files.failing = false;
    const again = value(await run("migrate"));
    expect(again).toMatchObject({ status: "migrated", event: "already", event_id: event?.id });
    expect(migratedEvents(journal)).toHaveLength(1);
    expect(files.files.get(CONFIG)).toBe(FORMAT_1(ENGINE));
  });

  it("says to pull method.yaml when another machine recorded the migration", async () => {
    const { files, journal, run } = setup(FORMAT_1("1.0.0"));
    await fromAnotherMachine(journal, [
      migratedDraft({
        from_format: 2,
        to_format: 2,
        from_engine: "1.0.0",
        to_engine: ENGINE,
        steps: [],
      }),
    ]);
    const before = journal.events.length;
    const error = errorOf(await run("migrate"));
    expect(error.code).toBe(ErrorCode.MIGRATION_CONFLICT);
    expect(error.message_key).toBe("error.migrate.already_recorded");
    expect(files.writes).toEqual([]);
    expect(journal.events.length).toBe(before);
  });

  it("stops when the journal moves under the lock, writing nothing", async () => {
    // A machine records the migration meanwhile: no second one.
    const raced = setup(FORMAT_1("1.0.0"));
    raced.journal.meanwhile = () =>
      fromAnotherMachine(raced.journal, [
        migratedDraft({
          from_format: 2,
          to_format: 2,
          from_engine: "1.0.0",
          to_engine: ENGINE,
          steps: [],
        }),
      ]);
    expect(errorOf(await raced.run("migrate")).code).toBe(ErrorCode.MIGRATION_CONFLICT);
    expect(migratedEvents(raced.journal)).toHaveLength(1);
    expect(raced.files.writes).toEqual([]);

    // A newer engine moves the journal to format 2 meanwhile.
    const ahead = setup(FORMAT_1("1.0.0"));
    ahead.journal.meanwhile = () =>
      fromAnotherMachine(ahead.journal, [
        migratedDraft({
          from_format: 2,
          to_format: 3,
          from_engine: ENGINE,
          to_engine: "2.0.0",
          steps: ["x"],
        }),
      ]);
    expect(errorOf(await ahead.run("migrate")).code).toBe(ErrorCode.UPGRADE_REQUIRED);
    expect(migratedEvents(ahead.journal)).toHaveLength(1);
    expect(ahead.files.writes).toEqual([]);

    // The journal refuses the write.
    const busy = setup(FORMAT_1("1.0.0"));
    busy.journal.meanwhile = async () => {
      throw new AgentPluggedError(ErrorCode.JOURNAL_BUSY, "error.journal_busy", {});
    };
    expect(errorOf(await busy.run("migrate")).code).toBe(ErrorCode.JOURNAL_BUSY);
    expect(busy.journal.events).toEqual([]);
    expect(busy.files.writes).toEqual([]);
  });

  it("stops when method.yaml changes while it runs", async () => {
    const { files, journal, run } = setup(FORMAT_1("1.0.0"));
    files.changedTo = `${FORMAT_1("1.0.0")}# edited\n`;
    const error = errorOf(await run("migrate"));
    expect(error.toPayload()).toMatchObject({
      code: ErrorCode.MIGRATION_CONFLICT,
      message_key: "error.migrate.config_changed",
    });
    expect(journal.events).toEqual([]);
    expect(files.writes).toEqual([]);
  });
});

describe("a machine behind the journal", () => {
  const ahead2 = {
    from_format: 2,
    to_format: 3,
    from_engine: ENGINE,
    to_engine: "2.0.0",
    steps: ["x"],
  };

  it("stops reading and writing with UPGRADE_REQUIRED, naming the engine to install", async () => {
    const { files, journal, run } = setup(FORMAT_1(ENGINE));
    await journal.append(migratedDraft(ahead2));
    const before = journal.events.length;
    const status = errorOf(await run("journal", { action: "status" }));
    expect(status.toPayload()).toEqual({
      code: ErrorCode.UPGRADE_REQUIRED,
      message_key: "error.journal_format_upgrade_required",
      details: { format_version: 3, supported: 2, install: "2.0.0", command: "journal" },
    });
    // `migrate` itself stops: the format is never migrated down.
    files.seed(CONFIG, FORMAT_1("1.0.0"));
    const migrate = errorOf(await run("migrate", {}, { commandLine: "migrate" }));
    expect(migrate.message_key).toBe("error.journal_format_upgrade_required");
    expect(migrate.details.command).toBe("migrate");
    expect(files.files.get(CONFIG)).toBe(FORMAT_1("1.0.0"));
    expect(journal.events.length).toBe(before);
  });

  it("names a command and an engine without the registry, and never an older engine", async () => {
    const { journal } = setup(FORMAT_1(ENGINE));
    await journal.append(migratedDraft(ahead2));
    const options = { product: PRODUCT_ID, allowTestTypes: true };
    const error = await computeProjection(journal.events, options).catch((e: unknown) => e);
    expect((error as AgentPluggedError).details).toEqual({
      format_version: 3,
      supported: 2,
      install: "2.0.0",
      command: UPGRADE_DEFAULT_COMMAND,
    });
    // A running engine already as new as the one named: `latest`, never a downgrade.
    const newer = await computeProjection(journal.events, {
      ...options,
      engineVersion: "3.0.0",
    }).catch((e: unknown) => e);
    expect((newer as AgentPluggedError).details.install).toBe(LATEST_ENGINE);
  });

  it("ignores a migration signed as a creator or of another product", async () => {
    const { journal, run } = setup(FORMAT_1(ENGINE));
    await journal.append({
      type: "test.appended",
      actor: { kind: "system" },
      product: PRODUCT_ID,
      provenance: "trusted",
      payload: { n: 1 },
    });
    const last = journal.events.at(-1) as EventEnvelope;
    const human = await signedAfter(last, {
      type: METHOD_EVENT_TYPES.migrated,
      actor: { kind: "human", device: last.actor.device },
      payload: ahead2,
    });
    const foreign = await signedAfter(last, {
      type: METHOD_EVENT_TYPES.migrated,
      product: OTHER_PRODUCT,
      payload: ahead2,
    });
    journal.rewrite([...journal.events, human, foreign]);
    const status = await run("journal", { action: "status" });
    expect(status.ok).toBe(true);
    const state = (status.ok ? (status.value as ProjectStateResult) : undefined)?.state;
    expect(state?.state.format).toBeUndefined();
    const ignored = Object.fromEntries(
      (state?.ignored ?? []).map((entry) => [entry.id, entry.reason]),
    );
    expect(ignored[human.id]).toBeDefined();
    expect(ignored[foreign.id]).toBe("wrong_product");
  });

  it("names the engine of the journal's migrations for an unknown event type", async () => {
    const { files, journal, run } = setup(FORMAT_1("1.0.0"));
    expect(value(await run("migrate")).status).toBe("migrated");
    // The working copy still pins 1.0.0 (not pulled yet); the journal says 1.1.0 migrated it.
    files.seed(CONFIG, FORMAT_1("1.0.0"));
    const teleported = await signedAfter(journal.events.at(-1) as EventEnvelope, {
      type: "story.teleported",
      payload: {},
    });
    journal.rewrite([...journal.events, teleported]);
    const error = errorOf(await run("journal", { action: "status" }, { engineVersion: "1.0.0" }));
    expect(error.toPayload()).toEqual({
      code: ErrorCode.UPGRADE_REQUIRED,
      message_key: "error.event_type_upgrade_required.install",
      details: {
        type: "story.teleported",
        version: 1,
        supported: null,
        install: ENGINE,
        command: "journal",
      },
    });
  });

  it("names the engine of the journal's migrations for a newer envelope", async () => {
    const { journal, run } = setup(FORMAT_1("1.0.0"));
    expect(value(await run("migrate")).status).toBe("migrated");
    const newer = await signedAfter(journal.events.at(-1) as EventEnvelope, { v: 2 });
    const problem = {
      path: `journal/2026/10/${newer.id}.json`,
      raw: newer,
      error: {
        code: ErrorCode.UPGRADE_REQUIRED,
        message_key: "error.event_upgrade_required",
        details: { field: "v", version: 2, supported: 1 },
      },
    };
    const error = await computeProjection(journal.events, {
      product: PRODUCT_ID,
      problems: [problem],
      engineVersion: "1.0.0",
    }).catch((e: unknown) => e);
    expect((error as AgentPluggedError).toPayload()).toEqual({
      code: ErrorCode.UPGRADE_REQUIRED,
      message_key: "error.event_upgrade_required.install",
      details: {
        field: "v",
        version: 2,
        supported: 1,
        install: ENGINE,
        command: UPGRADE_DEFAULT_COMMAND,
      },
    });
  });
});

describe("upgrade target", () => {
  const options = {
    engineVersion: "1.0.0",
    pinned: "1.3.0",
    command: "next",
    actor: "human" as const,
  };

  it("names the newest known engine newer than this one, else latest", () => {
    expect(upgradeTarget("1.0.0", ["1.2.0", undefined, "1.1.0", "nope", 3])).toBe("1.2.0");
    expect(upgradeTarget("1.0.0", ["1.0.0", "0.9.0"])).toBe(LATEST_ENGINE);
    expect(upgradeTarget("1.0.0", [])).toBe("latest");
  });

  it("leaves other errors alone, refines the engine and the command", () => {
    const other = new AgentPluggedError(ErrorCode.EVENT_INVALID, "error.event_invalid", {});
    expect(withUpgradeTarget(other, options)).toBe(other);
    const format = new AgentPluggedError(ErrorCode.UPGRADE_REQUIRED, "error.upgrade_required", {
      version: "2.0.0",
    });
    expect(withUpgradeTarget(format, options)).toBe(format);
    const envelope = new AgentPluggedError(
      ErrorCode.UPGRADE_REQUIRED,
      "error.event_upgrade_required.install",
      { version: 2, supported: 1, install: "1.2.0", command: UPGRADE_DEFAULT_COMMAND },
    );
    expect(withUpgradeTarget(envelope, options).toPayload()).toEqual({
      code: ErrorCode.UPGRADE_REQUIRED,
      message_key: "error.event_upgrade_required.install",
      details: { version: 2, supported: 1, install: "1.3.0", command: "next" },
    });
    // Never an engine as old as the running one.
    const old = new AgentPluggedError(
      ErrorCode.UPGRADE_REQUIRED,
      "error.journal_format_upgrade_required",
      { install: "0.9.0" },
    );
    expect(withUpgradeTarget(old, { ...options, pinned: undefined }).details.install).toBe(
      LATEST_ENGINE,
    );
    // A bare unknown type gains an engine to install.
    const bare = new AgentPluggedError(
      ErrorCode.UPGRADE_REQUIRED,
      "error.event_type_upgrade_required",
      { type: "story.teleported", version: 1, supported: null },
    );
    expect(withUpgradeTarget(bare, options).message_key).toBe(
      "error.event_type_upgrade_required.install",
    );
  });
});
