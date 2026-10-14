import {
  encryptFile,
  fromBase64url,
  generateProductKey,
  signEd25519,
  toBase64url,
  verifyProductKeyProof,
} from "@agentplugged/crypto";
import { ErrorCode, type EventEnvelope, utf8Length } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentStateView,
  announcedKey,
  type CommandContext,
  type ConfirmationPrompt,
  computeProjection,
  computeProjectionDetailed,
  createCommandRegistry,
  type InitResult,
  type KeyExportResult,
  type KeyImportResult,
  type KeySealResult,
  loadMachineKey,
  MemoryKeyStore,
  MemoryStateStore,
  type PassphrasePrompt,
  productKeyOf,
  readProductKey,
  resolveProfile,
  type ToolProbe,
} from "../index.js";
import type { CostsState } from "../projection/agent-reducers.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const PASSPHRASE = "une phrase de passe solide";

/** A workspace in memory whose `links` are symbolic links (dangling or not). */
class LinkedFiles extends MemoryFiles {
  readonly links = new Set<string>();
  async isSymbolicLink(path: string): Promise<boolean> {
    return this.links.has(path);
  }
}

/** A clock that moves 1 s per call, from `start`. */
function clock(start = Date.UTC(2026, 9, 4, 12, 0, 0)) {
  let now = start;
  return () => {
    now += 1000;
    return now;
  };
}

/**
 * A machine: its keychain (machine key from `seed`), its own copy of the journal (`events`, as a
 * clone received them) and its contexts.
 */
function machine(
  files: MemoryFiles,
  seed: number,
  events: readonly EventEnvelope[] = [],
  start?: number,
) {
  const keys = new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(seed)));
  const store = new MemoryStateStore({ keys, now: clock(start) });
  if (events.length > 0) store.rewrite(events);
  const answers: string[] = [];
  const asked: PassphrasePrompt[] = [];
  const confirmations: string[] = [];
  const confirmed: ConfirmationPrompt[] = [];
  const base: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal: store,
    keys,
  };
  /** The creator at a terminal, typing `answers` at each secret prompt (simulated input). */
  const terminal: CommandContext = {
    ...base,
    interactive: true,
    human: {
      keys,
      passphraseLimits: "min",
      askPassphrase: async (prompt) => {
        asked.push(prompt);
        const answer = answers.shift();
        if (answer === undefined) throw new Error("no more answers");
        return answer;
      },
      askConfirmation: async (prompt) => {
        confirmed.push(prompt);
        return confirmations.shift() ?? "";
      },
    },
  };
  const agent: CommandContext = { ...base, actor: "agent" };
  const registry = createCommandRegistry();
  return {
    keys,
    journal: store,
    answers,
    asked,
    confirmations,
    confirmed,
    /** Receives the other machine's events (a `journal sync`, in memory). */
    receive: (other: { journal: MemoryStateStore }) => {
      const held = new Set(store.events.map((event) => event.id));
      store.rewrite([
        ...store.events,
        ...other.journal.events.filter((event) => !held.has(event.id)),
      ]);
    },
    init: async () => {
      const result = await registry.run("init", base, { profile: resolveProfile("new-product") });
      if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
      return result.value as InitResult;
    },
    key: (input: Record<string, unknown>) => registry.run("key", terminal, input),
    call: (name: string, input: Record<string, unknown> = {}) => registry.run(name, agent, input),
    state: async () => {
      const result = await registry.run("get_state", agent, {});
      if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
      return result.value as AgentStateView;
    },
  };
}

/** A product initialised on a first machine, and a second machine with a copy of its journal. */
async function twoMachines(files: MemoryFiles = new MemoryFiles()) {
  const first = machine(files, 1);
  const init = await first.init();
  const product = (await first.journal.productId()) as string;
  const second = machine(files, 2, first.journal.events);
  return { files, first, second, init, product };
}

/** The first machine's export of its product key. */
async function exported(first: ReturnType<typeof machine>): Promise<string> {
  first.answers.push(PASSPHRASE, PASSPHRASE);
  const result = await first.key({ action: "export" });
  if (!result.ok) throw new Error(`export failed: ${result.error.code}`);
  return (result.value as KeyExportResult).exported;
}

const COST = { agent: "iris", story: "2-13", usd: 12.34, estimated: false, tokens_in: 5678 };

/** `event` with `fields` changed, signed again by the machine of `keys`. */
async function resigned(
  keys: MemoryKeyStore,
  event: EventEnvelope,
  fields: Partial<EventEnvelope>,
): Promise<EventEnvelope> {
  const { sig: _sig, ...rest } = event;
  const machineKey = await loadMachineKey(keys);
  return signEd25519({ ...rest, ...fields } as EventEnvelope, machineKey.secretKey);
}

describe("product key: init", () => {
  it("is created on the first init and announced with a proof of the key", async () => {
    const { first, init, product } = await twoMachines();
    const key = await readProductKey(first.keys, product);
    expect(key?.keyId).toMatch(/^pk:[A-Za-z0-9_-]{16}$/);
    expect(init.productKey).toEqual({
      status: "created",
      key_id: key?.keyId,
      published: "written",
    });
    const announced = first.journal.events.filter((event) => event.type === "product.key_created");
    expect(announced).toHaveLength(1);
    expect(announced[0]?.actor.kind).toBe("system");
    const payload = announced[0]?.payload as { key_id: string; proof: string };
    expect(payload.key_id).toBe(key?.keyId);
    expect(await verifyProductKeyProof(key?.key as Uint8Array, product, payload.proof)).toBe(true);
    // Never the key itself: neither in the journal nor in the result.
    const secret = toBase64url(key?.key ?? new Uint8Array());
    expect(JSON.stringify(first.journal.events)).not.toContain(secret);
    expect(JSON.stringify(init)).not.toContain(secret);
    expect((await first.init()).productKey).toEqual({
      status: "ready",
      key_id: key?.keyId,
      published: "already",
    });
    expect(first.keys.productWrites).toBe(1);
    expect(await announcedKey(first.journal.events)).toMatchObject({ key_id: key?.keyId });
  });

  it("creates none on a second machine: the journal names a key to import", async () => {
    const { first, second, product } = await twoMachines();
    const keyId = (await readProductKey(first.keys, product))?.keyId;
    expect((await second.init()).productKey).toEqual({ status: "missing", journal_key_id: keyId });
    expect(second.keys.productWrites).toBe(0);
  });

  it("says when this machine holds another key than the journal's", async () => {
    const { second, product } = await twoMachines();
    await second.keys.writeProductSecret(product, toBase64url(generateProductKey()));
    expect((await second.init()).productKey?.status).toBe("mismatch");
  });

  it("creates none when the journal cannot be read", async () => {
    const files = new MemoryFiles();
    const first = machine(files, 1);
    first.journal.listFailure = new Error("disk on fire");
    const result = await first.init();
    expect(result.productKey).toEqual({ status: "failed", publishReason: "disk on fire" });
    expect(first.keys.productWrites).toBe(0);
  });

  it("creates none in a fresh clone whose remote journal is not here yet, or unreachable", async () => {
    for (const kind of ["behind", "unreachable"] as const) {
      const files = new MemoryFiles();
      const first = machine(files, 1);
      first.journal.remote = { kind, remote: "origin" };
      expect((await first.init()).productKey).toEqual({ status: "sync_first", remote: "origin" });
      expect(first.keys.productWrites).toBe(0);
      expect(first.journal.events.some((event) => event.type === "product.key_created")).toBe(
        false,
      );
    }
    const files = new MemoryFiles();
    const fresh = machine(files, 1);
    fresh.journal.remote = { kind: "absent", remote: "origin" };
    expect((await fresh.init()).productKey?.status).toBe("created");
  });

  it("is refused to an agent or a writer other than the engine", async () => {
    const { first, product } = await twoMachines();
    await expect(
      first.journal.append({
        type: "product.key_created",
        actor: { kind: "agent", agent: "iris" },
        product,
        provenance: "untrusted",
        payload: { key_id: "pk:AAAAAAAAAAAAAAAA", proof: "A".repeat(43) },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.EVENT_INVALID });
  });

  it("keeps the first valid announcement; a backdated one with a bad proof is ignored", async () => {
    const { files, first, product } = await twoMachines();
    const key = (await readProductKey(first.keys, product)) as Awaited<
      ReturnType<typeof productKeyOf>
    >;

    // A later machine (its clock a day ahead) announces its own key: the first one stays.
    const later = machine(files, 3, first.journal.events, Date.UTC(2026, 9, 5));
    await later.journal.append({
      type: "product.key_created",
      actor: { kind: "system" },
      product,
      provenance: "trusted",
      payload: { key_id: "pk:BBBBBBBBBBBBBBBB", proof: "A".repeat(43) },
    });
    // A forger, its clock set back a day, claims the first key without being able to prove it.
    const forger = machine(files, 4, first.journal.events, Date.UTC(2026, 9, 1));
    await forger.journal.append({
      type: "product.key_created",
      actor: { kind: "system" },
      product,
      provenance: "trusted",
      payload: { key_id: key.keyId, proof: "A".repeat(43) },
    });
    first.receive(later);
    first.receive(forger);
    const forged = forger.journal.events.at(-1) as EventEnvelope;
    const holder = await computeProjection(first.journal.events, { productKey: key });
    expect(holder.ignored).toContainEqual({ id: forged.id, reason: "key_proof_invalid" });
    expect(holder.state.product_key).toMatchObject({
      key_id: key.keyId,
      device: expect.any(String),
    });
    expect((holder.state.product_key as { id: string }).id).not.toBe(forged.id);
    // Writes check the same rule: the holder still writes.
    expect((await first.call("report_cost", COST)).ok).toBe(true);
  });
});

describe("product key: sensitive events", () => {
  it("encrypts a cost: no amount in clear in the journal, the totals read with the key, never shown by get_state", async () => {
    const { first, product } = await twoMachines();
    expect((await first.call("report_cost", COST)).ok).toBe(true);
    const cost = first.journal.events.find((event) => event.type === "cost.reported");
    expect(cost?.payload).toBeUndefined();
    expect(cost?.payload_enc).toMatchObject({
      alg: "xchacha20poly1305",
      key_id: (await readProductKey(first.keys, product))?.keyId,
    });
    const text = JSON.stringify(first.journal.events);
    expect(text).not.toContain("12.34");
    expect(text).not.toContain("5678");
    const productKey = await readProductKey(first.keys, product);
    const projection = await computeProjection(first.journal.events, {
      ...(productKey === undefined ? {} : { productKey }),
    });
    expect((projection.state.costs as CostsState).total).toMatchObject({
      usd: 12.34,
      tokens_in: 5678,
      reports: 1,
    });
    const view = await first.state();
    expect(view).not.toHaveProperty("costs");
    expect(view.warnings).toEqual([]);
  });

  it("without the key: projected, the costs missing, sensitive_unreadable in the result only", async () => {
    const { first, second, product } = await twoMachines();
    expect((await first.call("report_cost", COST)).ok).toBe(true);
    expect((await first.call("report_cost", { ...COST, usd: 1 })).ok).toBe(true);
    const productKey = await readProductKey(first.keys, product);
    const withKey = await computeProjectionDetailed(first.journal.events, {
      ...(productKey === undefined ? {} : { productKey }),
    });
    const without = await computeProjectionDetailed(first.journal.events);
    expect(without.projection.applied).toBe(withKey.projection.applied);
    expect(without.projection.ignored).toEqual([]);
    expect(without.projection.state.costs).toBeUndefined();
    expect(without.unreadable).toBe(2);
    expect(withKey.unreadable).toBe(0);
    expect(JSON.stringify(without.projection)).not.toContain("sensitive_unreadable");
    const other = await computeProjectionDetailed(first.journal.events, {
      productKey: await productKeyOf(generateProductKey()),
    });
    expect(other.projection.state.costs).toBeUndefined();
    expect(other.unreadable).toBe(2);
    second.receive(first);
    const view = await second.state();
    expect(view).not.toHaveProperty("costs");
    expect(view.warnings).toEqual([{ code: "sensitive_unreadable", count: 2 }]);
  });

  it("refuses a sensitive write without the key: nothing is written", async () => {
    const { second } = await twoMachines();
    const before = second.journal.events.length;
    const refused = await second.call("report_cost", COST);
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.PRODUCT_KEY_MISSING);
    expect(second.journal.events).toHaveLength(before);
  });

  it("refuses to encrypt with a key the journal does not announce (mismatch, ids in order)", async () => {
    const { second, first, product } = await twoMachines();
    const other = await productKeyOf(generateProductKey());
    await second.keys.writeProductSecret(product, toBase64url(other.key));
    const refused = await second.call("report_cost", COST);
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.PRODUCT_KEY_MISMATCH);
    expect(refused.ok ? undefined : refused.error.details).toEqual({
      journal_key_id: (await readProductKey(first.keys, product))?.keyId,
      held_key_id: other.keyId,
    });
  });

  it("reports a keychain failure as such, never as a missing key", async () => {
    const { first } = await twoMachines();
    first.keys.readProductSecret = async () => {
      throw new Error("keychain locked");
    };
    const refused = await first.call("report_cost", COST);
    expect(refused.ok ? undefined : refused.error.message_key).toBe("error.keychain_unavailable");
    expect((await first.state()).warnings).toEqual([
      { code: "keychain_unavailable", reason: "keychain locked" },
    ]);
  });

  it("ignores an altered ciphertext (decrypt_failed), its chain kept", async () => {
    const { first, product } = await twoMachines();
    expect((await first.call("report_cost", COST)).ok).toBe(true);
    const events = [...first.journal.events];
    const index = events.findIndex((event) => event.type === "cost.reported");
    const cost = events[index] as EventEnvelope;
    const encrypted = cost.payload_enc as NonNullable<EventEnvelope["payload_enc"]>;
    const ct = fromBase64url(encrypted.ct) as Uint8Array;
    ct[0] = (ct[0] ?? 0) ^ 1;
    const altered = await resigned(first.keys, cost, {
      payload_enc: { ...encrypted, ct: toBase64url(ct) },
    });
    events[index] = altered;
    first.journal.rewrite(events);
    expect((await first.call("report_status", { agent: "iris", status: "idle" })).ok).toBe(true);
    const productKey = await readProductKey(first.keys, product);
    const projection = await computeProjection(first.journal.events, {
      ...(productKey === undefined ? {} : { productKey }),
    });
    expect(projection.ignored).toEqual([{ id: altered.id, reason: "decrypt_failed" }]);
    expect(projection.state.costs).toBeUndefined();
    expect(projection.state.agents).toMatchObject({ iris: { status: "idle" } });
  });

  it("refuses an unknown algorithm and encryption on a type that is not sensitive", async () => {
    const { first } = await twoMachines();
    expect((await first.call("report_cost", COST)).ok).toBe(true);
    const events = [...first.journal.events];
    const index = events.findIndex((event) => event.type === "cost.reported");
    const cost = events[index] as EventEnvelope;
    const encrypted = cost.payload_enc as NonNullable<EventEnvelope["payload_enc"]>;
    const unknown = await resigned(first.keys, cost, {
      payload_enc: { ...encrypted, alg: "aes256gcm" },
    });
    expect((await computeProjection([...events.slice(0, index), unknown])).ignored).toEqual([
      { id: unknown.id, reason: "unsupported_alg" },
    ]);
    // A cost is at version 2; a status is at version 1.
    const status = await resigned(first.keys, cost, { type: "agent.status_reported", v: 1 });
    expect((await computeProjection([...events.slice(0, index), status])).ignored).toEqual([
      { id: status.id, reason: "unexpected_encryption" },
    ]);
  });

  it("reads an older cost in clear before the announcement; ignores one after it", async () => {
    const files = new MemoryFiles();
    const first = machine(files, 1);
    // No keychain at init: the journal has no announcement yet, like a journal.
    const registry = createCommandRegistry();
    const init = await registry.run(
      "init",
      {
        files,
        tools: NO_TOOL,
        method: shippedMethod(),
        actor: "human",
        engineVersion: "1.0.0",
        journal: first.journal,
      },
      { profile: resolveProfile("new-product") },
    );
    expect(init.ok).toBe(true);
    // The machine's first events (its key, the product), then a cost in clear, as.
    expect((await first.call("report_status", { agent: "iris", status: "idle" })).ok).toBe(true);
    const product = (await first.journal.productId()) as string;
    const machineKey = await loadMachineKey(first.keys);
    const head = first.journal.events.at(-1) as EventEnvelope;
    const { hashOf } = await import("../journal/prepare-event.js");
    const old = await signEd25519(
      {
        v: 1,
        id: "01K6ZZZZZZZZZZZZZZZZZZZZZ1",
        type: "cost.reported",
        at: "2026-10-05T00:00:00.000Z",
        actor: { kind: "agent", device: machineKey.device, agent: "iris" },
        product,
        provenance: "untrusted",
        prev: hashOf(head),
        payload: { usd: 3, estimated: true },
        alg: "ed25519",
      } as unknown as EventEnvelope,
      machineKey.secretKey,
    );
    first.journal.rewrite([...first.journal.events, old]);
    expect((await computeProjection(first.journal.events)).state.costs).toMatchObject({
      total: { usd_estimated: 3, reports: 1 },
    });
    // The product key is announced next: a clear cost after it is ignored.
    expect((await first.init()).productKey?.status).toBe("created");
    const announcement = first.journal.events.at(-1) as EventEnvelope;
    const late = await signEd25519(
      {
        ...old,
        id: "01K7ZZZZZZZZZZZZZZZZZZZZZ2",
        at: "2026-10-06T00:00:00.000Z",
        prev: hashOf(announcement),
      } as EventEnvelope,
      machineKey.secretKey,
    );
    const projection = await computeProjection([...first.journal.events, late]);
    expect(projection.ignored).toEqual([{ id: late.id, reason: "sensitive_in_clear" }]);
    expect(projection.state.costs).toMatchObject({ total: { usd_estimated: 3, reports: 1 } });
  });
});

describe("product key: key export and key import", () => {
  it("exports under a passphrase asked twice: apk1:, never the passphrase", async () => {
    const { first, product } = await twoMachines();
    first.answers.push(PASSPHRASE, PASSPHRASE);
    const result = await first.key({ action: "export" });
    expect(first.asked).toEqual(["new", "again"]);
    const value = result.ok ? (result.value as KeyExportResult) : undefined;
    const key = await readProductKey(first.keys, product);
    expect(value?.key_id).toBe(key?.keyId);
    expect(value?.exported).toMatch(/^apk1:[A-Za-z0-9_-]+$/);
    const shown = JSON.stringify(value);
    expect(shown).not.toContain(toBase64url(key?.key ?? new Uint8Array()));
    expect(shown).not.toContain(PASSPHRASE);
  });

  it("imports the export on another machine, asking the export itself when not given", async () => {
    const { first, second, product } = await twoMachines();
    const text = await exported(first);
    second.answers.push(text, PASSPHRASE);
    const imported = await second.key({ action: "import" });
    expect(second.asked).toEqual(["export", "enter"]);
    expect(imported.ok ? (imported.value as KeyImportResult) : imported.error.code).toEqual({
      action: "import",
      key_id: (await readProductKey(first.keys, product))?.keyId,
      status: "imported",
    });
    expect((await second.call("report_cost", COST)).ok).toBe(true);
    first.receive(second);
    const heldKey = await readProductKey(first.keys, product);
    const read = await computeProjection(first.journal.events, {
      ...(heldKey === undefined ? {} : { productKey: heldKey }),
    });
    expect((read.state.costs as CostsState).total.reports).toBe(1);
    const again = await second.key({ action: "import", text });
    expect(again.ok && (again.value as KeyImportResult).status).toBe("already");
  });

  it("refuses while the journal announces no key: the held key kept, no passphrase asked", async () => {
    const files = new MemoryFiles();
    const first = machine(files, 1);
    await first.init();
    const product = (await first.journal.productId()) as string;
    const text = await exported(first);
    // Another machine, with its own key K1 and an empty journal of the same product.
    const lonely = machine(files, 5);
    const held = toBase64url(generateProductKey());
    await lonely.keys.writeProductSecret(product, held);
    const refused = await lonely.key({ action: "import", text });
    expect(refused.ok ? undefined : refused.error.message_key).toBe(
      "error.product_key_not_announced",
    );
    expect(lonely.asked).toEqual([]);
    expect(await lonely.keys.readProductSecret(product)).toBe(held);
  });

  it("replaces a held key only after « je confirme », and keeps the old one aside", async () => {
    const { first, second, product } = await twoMachines();
    const text = await exported(first);
    const other = await productKeyOf(generateProductKey());
    await second.keys.writeProductSecret(product, toBase64url(other.key));
    second.answers.push(PASSPHRASE);
    second.confirmations.push("non");
    const declined = await second.key({ action: "import", text });
    expect(declined.ok ? undefined : declined.error.code).toBe(ErrorCode.CANCELLED);
    expect((await readProductKey(second.keys, product))?.keyId).toBe(other.keyId);

    second.answers.push(PASSPHRASE);
    second.confirmations.push("je confirme");
    const imported = await second.key({ action: "import", text });
    const keyId = (await readProductKey(first.keys, product))?.keyId;
    expect(imported.ok ? imported.value : imported.error.code).toEqual({
      action: "import",
      key_id: keyId,
      status: "imported",
      replaced: other.keyId,
    });
    expect(second.confirmed.at(-1)).toEqual({
      kind: "replace_product_key",
      held_key_id: other.keyId,
      key_id: keyId,
    });
    expect(second.keys.backups.get(`${product}:${other.keyId}`)).toBe(toBase64url(other.key));
    expect((await readProductKey(second.keys, product))?.keyId).toBe(keyId);
  });

  it("refuses a wrong passphrase, and stores nothing", async () => {
    const { first, second, product } = await twoMachines();
    const text = await exported(first);
    second.answers.push("une autre phrase de passe");
    const refused = await second.key({ action: "import", text });
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.PASSPHRASE_INVALID);
    expect(await readProductKey(second.keys, product)).toBeUndefined();
  });

  it("refuses another product's export before asking anything", async () => {
    const { second, product } = await twoMachines();
    const elsewhere = await twoMachines();
    const text = await exported(elsewhere.first);
    const refused = await second.key({ action: "import", text });
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.PRODUCT_KEY_MISMATCH);
    expect(refused.ok ? undefined : refused.error.message_key).toBe(
      "error.product_key_other_product",
    );
    expect(second.asked).toEqual([]);
    expect(await readProductKey(second.keys, product)).toBeUndefined();
  });

  it("refuses a short passphrase, two different entries, a text that is no export", async () => {
    const { first, second } = await twoMachines();
    first.answers.push("court");
    const short = await first.key({ action: "export" });
    expect(short.ok ? undefined : short.error.details.reason).toBe("too_short");
    first.answers.push(PASSPHRASE, `${PASSPHRASE}.`);
    const differ = await first.key({ action: "export" });
    expect(differ.ok ? undefined : differ.error.details.reason).toBe("mismatch");
    const notExport = await second.key({ action: "import", text: "pas une clé" });
    expect(notExport.ok ? undefined : notExport.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });

  it("needs the key to export it, and a terminal for every key action", async () => {
    const { second, files } = await twoMachines();
    const missing = await second.key({ action: "export" });
    expect(missing.ok ? undefined : missing.error.code).toBe(ErrorCode.PRODUCT_KEY_MISSING);
    const registry = createCommandRegistry();
    for (const action of ["export", "import", "seal"]) {
      const result = await registry.run(
        "key",
        {
          files,
          tools: NO_TOOL,
          method: shippedMethod(),
          actor: "human",
          engineVersion: "1.0.0",
          journal: second.journal,
        },
        { action },
      );
      expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.REVIEW_NOT_INTERACTIVE);
    }
  });
});

describe("product key: sensitive files", () => {
  it("writes memory encrypted on disk, and reads it back in clear", async () => {
    const { files, first, product } = await twoMachines();
    const content = "# Leçons\n\nToujours relire le plan.\n";
    const written = await first.call("write_sensitive", {
      agent: "iris",
      area: "memory",
      path: "lessons.md",
      content,
    });
    expect(written.ok ? written.value : written.error.code).toEqual({
      area: "memory",
      path: "lessons.md",
      bytes: utf8Length(content),
    });
    const onDisk = await files.readText(".agentplugged/memory/lessons.md");
    const keyId = (await readProductKey(first.keys, product))?.keyId;
    expect(onDisk.split("\n")[0]).toBe(`agentplugged-enc:1:${keyId}`);
    expect(onDisk).not.toContain("relire");
    const read = await first.call("read_sensitive", {
      agent: "iris",
      area: "memory",
      path: "lessons.md",
    });
    expect(read.ok ? read.value : read.error.code).toEqual({
      area: "memory",
      path: "lessons.md",
      content,
    });
    // Moved to another path, it no longer decrypts.
    files.seed(".agentplugged/salle/lessons.md", onDisk);
    const moved = await first.call("read_sensitive", {
      agent: "iris",
      area: "salle",
      path: "lessons.md",
    });
    expect(moved.ok ? undefined : moved.error.code).toBe(ErrorCode.UNEXPECTED);
  });

  it("never serves a file in clear, and key seal encrypts it", async () => {
    const { files, first } = await twoMachines();
    files.seed(".agentplugged/memory/notes.md", "écrit à la main\n");
    const read = await first.call("read_sensitive", {
      agent: "iris",
      area: "memory",
      path: "notes.md",
    });
    expect(read.ok ? undefined : read.error.code).toBe(ErrorCode.SENSITIVE_NOT_ENCRYPTED);
    const sealed = await first.key({ action: "seal" });
    const files_ = sealed.ok ? (sealed.value as KeySealResult).files : [];
    expect(files_).toEqual([{ path: ".agentplugged/memory/notes.md", status: "sealed" }]);
    const again = await first.call("read_sensitive", {
      agent: "iris",
      area: "memory",
      path: "notes.md",
    });
    expect(again.ok ? again.value : again.error.code).toMatchObject({
      content: "écrit à la main\n",
    });
    const twice = await first.key({ action: "seal" });
    expect(twice.ok ? (twice.value as KeySealResult).files : []).toEqual([
      { path: ".agentplugged/memory/notes.md", status: "already" },
    ]);
  });

  it("names both keys when a file is encrypted with another one", async () => {
    const { files, first, product } = await twoMachines();
    const other = await productKeyOf(generateProductKey());
    const path = ".agentplugged/memory/x.md";
    files.seed(path, await encryptFile("x", { productId: product, path }, other.key));
    const read = await first.call("read_sensitive", {
      agent: "iris",
      area: "memory",
      path: "x.md",
    });
    expect(read.ok ? undefined : read.error.code).toBe(ErrorCode.PRODUCT_KEY_MISMATCH);
    expect(read.ok ? undefined : read.error.details).toEqual({
      file_key_id: other.keyId,
      held_key_id: (await readProductKey(first.keys, product))?.keyId,
    });
  });

  it("refuses .., device names, a case-only twin, an inactive agent", async () => {
    const { files, first } = await twoMachines();
    files.seed(".agentplugged/memory/Notes.md", "x");
    for (const [input, code] of [
      [{ agent: "iris", area: "memory", path: "../x", content: "x" }, ErrorCode.INVALID_ARGUMENTS],
      [
        { agent: "iris", area: "memory", path: "/etc/x", content: "x" },
        ErrorCode.INVALID_ARGUMENTS,
      ],
      [
        { agent: "iris", area: "memory", path: "nul.md", content: "x" },
        ErrorCode.INVALID_ARGUMENTS,
      ],
      [{ agent: "iris", area: "memory", path: "a. ", content: "x" }, ErrorCode.INVALID_ARGUMENTS],
      [
        { agent: "iris", area: "memory", path: "notes.md", content: "x" },
        ErrorCode.INVALID_ARGUMENTS,
      ],
      [{ agent: "iris", area: "docs", path: "x.md", content: "x" }, ErrorCode.INVALID_ARGUMENTS],
      [{ agent: "ghost", area: "memory", path: "x.md", content: "x" }, ErrorCode.AGENT_NOT_FOUND],
    ] as const) {
      const result = await first.call("write_sensitive", input);
      expect(result.ok ? undefined : result.error.code, JSON.stringify(input)).toBe(code);
    }
    expect(await files.exists(".agentplugged/memory/notes.md")).toBe(false);
  });

  it("writes in NFC: a decomposed name and its composed form are one file", async () => {
    const { files, first } = await twoMachines();
    const decomposed = "léger.md";
    expect(
      (
        await first.call("write_sensitive", {
          agent: "iris",
          area: "memory",
          path: decomposed,
          content: "x",
        })
      ).ok,
    ).toBe(true);
    expect(await files.exists(".agentplugged/memory/léger.md")).toBe(true);
    const read = await first.call("read_sensitive", {
      agent: "iris",
      area: "memory",
      path: "léger.md",
    });
    expect(read.ok).toBe(true);
  });

  it("refuses a symbolic link on the way, .agentplugged itself and dangling ones included", async () => {
    for (const link of [".agentplugged", ".agentplugged/memory", ".agentplugged/memory/sub"]) {
      const files = new LinkedFiles();
      const { first } = await twoMachines(files);
      files.links.add(link);
      const result = await first.call("write_sensitive", {
        agent: "iris",
        area: "memory",
        path: "sub/x.md",
        content: "x",
      });
      expect(result.ok ? undefined : result.error.code, link).toBe(ErrorCode.INVALID_ARGUMENTS);
      expect(await files.exists(".agentplugged/memory/sub/x.md")).toBe(false);
    }
  });

  it("refuses to write or read without the key", async () => {
    const { first, second, files } = await twoMachines();
    expect(
      (
        await first.call("write_sensitive", {
          agent: "iris",
          area: "salle",
          path: "a.md",
          content: "x",
        })
      ).ok,
    ).toBe(true);
    const write = await second.call("write_sensitive", {
      agent: "iris",
      area: "salle",
      path: "b.md",
      content: "x",
    });
    expect(write.ok ? undefined : write.error.code).toBe(ErrorCode.PRODUCT_KEY_MISSING);
    expect(await files.exists(".agentplugged/salle/b.md")).toBe(false);
    const read = await second.call("read_sensitive", {
      agent: "iris",
      area: "salle",
      path: "a.md",
    });
    expect(read.ok ? undefined : read.error.code).toBe(ErrorCode.PRODUCT_KEY_MISSING);
  });
});
