import {
  deriveBridgeEncryptionKey,
  fromBase64url,
  generateProductKey,
  productKeyId,
  productKeyProof,
  productKeyRotationProof,
  sealProductKeyFor,
  toBase64url,
} from "@agentplugged/crypto";
import {
  ErrorCode,
  type EventEnvelope,
  type ProductKeyRotatedPayload,
  type RootPin,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentStateView,
  adoptRotatedKey,
  announcedKey,
  buildPairedPayload,
  type CommandContext,
  computeProjectionDetailed,
  createCommandRegistry,
  forgetProductKey,
  type KeyExportResult,
  type KeyImportResult,
  loadMachineKey,
  MemoryKeyStore,
  MemoryStateStore,
  type PassphrasePrompt,
  productKeyById,
  readProductKey,
  resolveProfile,
  rotateProductKey,
  type ToolProbe,
  writePairedDevice,
} from "../index.js";
import type { CostsState } from "../projection/agent-reducers.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const PASSPHRASE = "une phrase de passe solide";

function clock(start = Date.UTC(2026, 9, 4, 12, 0, 0)) {
  let now = start;
  return () => {
    now += 1000;
    return now;
  };
}

/** A machine: its keychain (machine key from `seed`), its copy of the journal, its contexts. */
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
  const base: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal: store,
    keys,
  };
  const terminal: CommandContext = {
    ...base,
    interactive: true,
    human: {
      keys,
      passphraseLimits: "min",
      askPassphrase: async (_prompt: PassphrasePrompt) => {
        const answer = answers.shift();
        if (answer === undefined) throw new Error("no more answers");
        return answer;
      },
      askConfirmation: async () => "je confirme",
    },
  };
  const agent: CommandContext = { ...base, actor: "agent" };
  const registry = createCommandRegistry();
  return {
    keys,
    journal: store,
    answers,
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

const cost = (usd: number) => ({
  agent: "iris",
  story: "6-35",
  usd,
  estimated: false,
  tokens_in: 1000,
});

async function exported(from: ReturnType<typeof machine>): Promise<KeyExportResult> {
  from.answers.push(PASSPHRASE, PASSPHRASE);
  const result = await from.key({ action: "export" });
  if (!result.ok) throw new Error(`export failed: ${result.error.code}`);
  return result.value as KeyExportResult;
}

/** Makes the machine of `keys` a machine the first machine's journal trusts. */
async function trust(
  root: ReturnType<typeof machine>,
  other: ReturnType<typeof machine>,
  product: string,
): Promise<RootPin> {
  const rootKey = await loadMachineKey(root.keys);
  const otherKey = await loadMachineKey(other.keys);
  const enc = await deriveBridgeEncryptionKey(otherKey.secretKey.slice(0, 32));
  const payload = await buildPairedPayload(
    {
      device: otherKey.device,
      kind: "machine",
      sigKey: toBase64url(otherKey.publicKey),
      encKey: toBase64url(enc.publicKey),
      bridge: rootKey.device,
      provisional: false,
      issuedAt: "2026-10-08T10:00:00.000Z",
    },
    { device: rootKey.device, secretKey: rootKey.secretKey },
  );
  await writePairedDevice(root.journal, product, payload);
  return { device: rootKey.device, public_key: toBase64url(rootKey.publicKey) };
}

/** The costs a machine reads in its journal with the keys it holds. */
async function costsRead(m: ReturnType<typeof machine>, product: string) {
  const ring = await readProductKey(m.keys, product);
  try {
    const detailed = await computeProjectionDetailed(m.journal.events, {
      ...(ring === undefined ? {} : { productKey: ring }),
    });
    return {
      reports: ((detailed.projection.state.costs as CostsState | undefined)?.total.reports ??
        0) as number,
      unreadable: detailed.unreadable,
      announced: detailed.projection.state.product_key as { key_id: string } | undefined,
    };
  } finally {
    await forgetProductKey(ring);
  }
}

/**
 * The product with its first key on machine A, a machine B the journal trusts and that got the
 * first key by an export (a machine paired before the renewals), and machine C, a machine that was
 * removed: it holds the first key and is not in the registry.
 */
async function world() {
  const files = new MemoryFiles();
  const a = machine(files, 1);
  await a.init();
  const product = (await a.journal.productId()) as string;
  const first = await exported(a);
  const b = machine(files, 2, a.journal.events);
  const c = machine(files, 3, a.journal.events);
  for (const target of [b, c]) {
    target.answers.push(PASSPHRASE);
    expect((await target.key({ action: "import", text: first.exported })).ok).toBe(true);
  }
  const pin = await trust(a, b, product);
  b.receive(a);
  c.receive(a);
  return { files, a, b, c, product, pin, firstKeyId: first.key_id };
}

describe("product key: renewal", () => {
  it("renews twice and still reads everything; the removed machine reads only what it knew", async () => {
    const { a, b, c, product, pin, firstKeyId } = await world();
    expect((await a.call("report_cost", cost(1))).ok).toBe(true);

    const first = await rotateProductKey({ keys: a.keys, journal: a.journal, product, pin });
    expect(first.previous_key_id).toBe(firstKeyId);
    expect(first.machines).toHaveLength(1);
    expect((await a.call("report_cost", cost(2))).ok).toBe(true);

    const second = await rotateProductKey({ keys: a.keys, journal: a.journal, product, pin });
    expect(second.previous_key_id).toBe(first.key_id);
    expect((await a.call("report_cost", cost(4))).ok).toBe(true);

    // Three costs, three keys: the journal says which one wrote each, and never writes a key.
    const written = a.journal.events.filter((event) => event.type === "cost.reported");
    expect(written.map((event) => event.payload_enc?.key_id)).toEqual([
      firstKeyId,
      first.key_id,
      second.key_id,
    ]);
    const rotations = a.journal.events.filter((event) => event.type === "product.key_rotated");
    expect(rotations).toHaveLength(2);
    expect(rotations.every((event) => event.actor.kind === "system")).toBe(true);
    const ring = await readProductKey(a.keys, product);
    for (const keyId of [firstKeyId, first.key_id, second.key_id]) {
      const held = await productKeyById(ring as NonNullable<typeof ring>, keyId);
      expect(held?.keyId).toBe(keyId);
      expect(JSON.stringify(a.journal.events)).not.toContain(toBase64url(held?.key as Uint8Array));
    }
    expect(ring?.keyId).toBe(second.key_id);
    await forgetProductKey(ring);

    // The machine that renewed reads all of it.
    expect(await costsRead(a, product)).toMatchObject({ reports: 3, unreadable: 0 });
    expect(await announcedKey(a.journal.events, { product })).toMatchObject({
      key_id: second.key_id,
      history: [{ key_id: firstKeyId }, { key_id: first.key_id }, { key_id: second.key_id }],
    });

    // The trusted machine B was off: it opens the boxes, one renewal after the other.
    b.receive(a);
    const adopted = await adoptRotatedKey(b.keys, product, { events: b.journal.events });
    expect(adopted?.keyId).toBe(second.key_id);
    await forgetProductKey(adopted);
    expect(await costsRead(b, product)).toMatchObject({ reports: 3, unreadable: 0 });
    expect((await b.call("report_cost", cost(8))).ok).toBe(true);
    expect(
      b.journal.events.filter((event) => event.type === "cost.reported").at(-1)?.payload_enc
        ?.key_id,
    ).toBe(second.key_id);

    // The removed machine C: it reads what was written under its key, nothing after.
    c.receive(a);
    const taken = await adoptRotatedKey(c.keys, product, { events: c.journal.events });
    expect((taken as { keyId?: string } | undefined)?.keyId).toBe(firstKeyId);
    expect(await costsRead(c, product)).toMatchObject({ reports: 1, unreadable: 2 });
    const refused = await c.call("report_cost", cost(16));
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.PRODUCT_KEY_MISMATCH);
  });

  it("exports every key and restores the whole history on a machine that has none", async () => {
    const { files, a, product, pin, firstKeyId } = await world();
    expect((await a.call("report_cost", cost(1))).ok).toBe(true);
    const one = await rotateProductKey({ keys: a.keys, journal: a.journal, product, pin });
    expect((await a.call("report_cost", cost(2))).ok).toBe(true);
    const two = await rotateProductKey({ keys: a.keys, journal: a.journal, product, pin });
    expect((await a.call("report_cost", cost(4))).ok).toBe(true);

    const everything = await exported(a);
    expect(everything.exported.startsWith("apk2:")).toBe(true);
    expect(everything.key_ids).toEqual([two.key_id, one.key_id, firstKeyId]);
    expect(everything.missing).toBeUndefined();

    const restored = machine(files, 5, a.journal.events);
    restored.answers.push(PASSPHRASE);
    const imported = await restored.key({ action: "import", text: everything.exported });
    expect(imported.ok ? (imported.value as KeyImportResult) : imported.error.code).toMatchObject({
      status: "imported",
      key_id: two.key_id,
    });
    expect(await costsRead(restored, product)).toMatchObject({ reports: 3, unreadable: 0 });
    expect((await restored.call("report_cost", cost(8))).ok).toBe(true);

    // The restored machine exports the same set again: nothing is lost on the way.
    const again = await exported(restored);
    expect(again.key_ids).toEqual([two.key_id, one.key_id, firstKeyId]);
  });

  it("an export made before the renewals reads the old history only, and says the current key is missing", async () => {
    const { files, a, product, pin, firstKeyId } = await world();
    expect((await a.call("report_cost", cost(1))).ok).toBe(true);
    const old = (await exported(a)).exported;
    await rotateProductKey({ keys: a.keys, journal: a.journal, product, pin });
    expect((await a.call("report_cost", cost(2))).ok).toBe(true);
    const fresh = machine(files, 6, a.journal.events);
    fresh.answers.push(PASSPHRASE);
    const imported = await fresh.key({ action: "import", text: old });
    expect(imported.ok ? (imported.value as KeyImportResult).status : undefined).toBe("older");
    expect(await costsRead(fresh, product)).toMatchObject({ reports: 1, unreadable: 1 });
    expect(firstKeyId).toMatch(/^pk:/);
  });

  it("reads the files written before the renewal, and writes the next under the new key", async () => {
    const { files, a, product, pin, firstKeyId } = await world();
    const content = "# Leçons\n\nRelire le plan.\n";
    expect(
      (
        await a.call("write_sensitive", {
          agent: "iris",
          area: "memory",
          path: "lessons.md",
          content,
        })
      ).ok,
    ).toBe(true);
    expect((await files.readText(".agentplugged/memory/lessons.md")).split("\n")[0]).toBe(
      `agentplugged-enc:1:${firstKeyId}`,
    );
    const renewed = await rotateProductKey({ keys: a.keys, journal: a.journal, product, pin });
    const read = await a.call("read_sensitive", {
      agent: "iris",
      area: "memory",
      path: "lessons.md",
    });
    expect(read.ok ? read.value : read.error.code).toMatchObject({ content });
    expect(
      (
        await a.call("write_sensitive", {
          agent: "iris",
          area: "memory",
          path: "lessons.md",
          content: "# Leçons\n\nNouveau.\n",
        })
      ).ok,
    ).toBe(true);
    expect((await files.readText(".agentplugged/memory/lessons.md")).split("\n")[0]).toBe(
      `agentplugged-enc:1:${renewed.key_id}`,
    );
  });

  it("renews once per order: the same order run again changes nothing", async () => {
    const { a, product, pin } = await world();
    const order = "01K6KXJ5G0PR0DVCT00000000B";
    const once = await rotateProductKey({ keys: a.keys, journal: a.journal, product, pin, order });
    const again = await rotateProductKey({ keys: a.keys, journal: a.journal, product, pin, order });
    expect(again).toMatchObject({ key_id: once.key_id, already: true });
    expect(a.journal.events.filter((event) => event.type === "product.key_rotated")).toHaveLength(
      1,
    );
  });

  it("recovers from a cut between the journal and the keychain", async () => {
    const { a, product, pin, firstKeyId } = await world();
    const before = a.keys.products.get(product) as string;
    const renewed = await rotateProductKey({ keys: a.keys, journal: a.journal, product, pin });
    // The cut: the journal announces the new key, the keychain still makes the old one current.
    a.keys.products.set(product, before);
    const ring = await readProductKey(a.keys, product);
    expect(ring?.keyId).toBe(firstKeyId);
    // A write still uses the announced key, which the machine keeps.
    expect((await a.call("report_cost", cost(1))).ok).toBe(true);
    expect(
      a.journal.events.filter((event) => event.type === "cost.reported")[0]?.payload_enc?.key_id,
    ).toBe(renewed.key_id);
    const healed = await adoptRotatedKey(a.keys, product, { events: a.journal.events });
    expect(healed?.keyId).toBe(renewed.key_id);
    await forgetProductKey(ring, healed);
    expect((await readProductKey(a.keys, product))?.keyId).toBe(renewed.key_id);
  });

  it("a machine catching up refuses a key slipped in between two renewals by a writer without the key", async () => {
    const { files, a, b, product, pin } = await world();
    const one = await rotateProductKey({ keys: a.keys, journal: a.journal, product, pin });
    const forger = machine(files, 7, a.journal.events, Date.UTC(2026, 9, 6));
    // The forger follows the new key without holding it, and seals its own key for machine B.
    const bKey = await loadMachineKey(b.keys);
    const enc = await deriveBridgeEncryptionKey(bKey.secretKey.slice(0, 32));
    const own = generateProductKey();
    const ownId = await productKeyId(own);
    await forger.journal.append({
      type: "product.key_rotated",
      actor: { kind: "system" },
      product,
      provenance: "trusted",
      payload: {
        key_id: ownId,
        previous_key_id: one.key_id,
        proof: await productKeyProof(own, product),
        chain_proof: await productKeyRotationProof(own, product, ownId),
        boxes: { [bKey.device]: await sealProductKeyFor(own, product, enc.publicKey) },
      },
    });
    b.receive(a);
    b.receive(forger);
    const caught = await adoptRotatedKey(b.keys, product, { events: b.journal.events });
    // B takes the true renewal and stops there: the forged key is never adopted.
    expect(caught?.keyId).toBe(one.key_id);
    await forgetProductKey(caught);
  });

  it("ignores a renewal by a writer that does not hold the key it follows", async () => {
    const { files, a, product, firstKeyId } = await world();
    const forger = machine(files, 7, a.journal.events);
    const stolen = generateProductKey();
    const fakeId = "pk:ZZZZZZZZZZZZZZZZ";
    const bogus: ProductKeyRotatedPayload = {
      key_id: fakeId,
      previous_key_id: firstKeyId,
      proof: "A".repeat(43),
      chain_proof: await productKeyRotationProof(stolen, product, fakeId),
      boxes: {},
    };
    await forger.journal.append({
      type: "product.key_rotated",
      actor: { kind: "system" },
      product,
      provenance: "trusted",
      payload: bogus,
    });
    a.receive(forger);
    const forged = forger.journal.events.at(-1) as EventEnvelope;
    const ring = await readProductKey(a.keys, product);
    const holder = await computeProjectionDetailed(a.journal.events, {
      ...(ring === undefined ? {} : { productKey: ring }),
    });
    expect(holder.projection.ignored).toContainEqual({
      id: forged.id,
      reason: "key_proof_invalid",
    });
    expect(holder.projection.state.product_key).toMatchObject({ key_id: firstKeyId });
    // The holder still writes under the key it knows.
    expect((await a.call("report_cost", cost(1))).ok).toBe(true);
    await forgetProductKey(ring);
  });

  it("two renewals made at the same time: the earliest wins, the other follows nothing", async () => {
    const { files, a, product, pin, firstKeyId } = await world();
    const rival = machine(files, 8, a.journal.events);
    rival.keys.products.set(product, a.keys.products.get(product) as string);
    const winner = await rotateProductKey({ keys: a.keys, journal: a.journal, product, pin });
    const loser = await rotateProductKey({
      keys: rival.keys,
      journal: rival.journal,
      product,
      pin,
    });
    a.receive(rival);
    const view = await costsRead(a, product);
    expect(winner.previous_key_id).toBe(firstKeyId);
    expect(loser.previous_key_id).toBe(firstKeyId);
    expect(view.announced?.key_id).toBe(winner.key_id);
    // The sealed payloads never carry a raw key.
    const sealedBoxes = a.journal.events
      .filter((event) => event.type === "product.key_rotated")
      .map((event) => (event.payload as ProductKeyRotatedPayload).boxes);
    for (const boxes of sealedBoxes) {
      for (const box of Object.values(boxes))
        expect(fromBase64url(box)?.length).toBeGreaterThan(48);
    }
  });
});
