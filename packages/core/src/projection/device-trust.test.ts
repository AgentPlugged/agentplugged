import {
  deviceIdOf,
  type Ed25519KeyPair,
  eventHash,
  generateEd25519,
  generateX25519,
  signEd25519,
  signTrustRecord,
  toBase64url,
  type X25519KeyPair,
} from "@agentplugged/crypto";
import {
  DEVICE_TRUST_EVENT_TYPES,
  type DevicePairedPayload,
  type DeviceRevokedPayload,
  devicePairedRecord,
  deviceRevokedRecord,
  ErrorCode,
  type EventEnvelope,
  HUMAN_EVENT_TYPES,
  pairOfferRecord,
  type RootPin,
  rootCertifiedRecord,
  TRUST_SIGNATURE_TAGS,
  type UnsignedEventEnvelope,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { computeProjection, computeProjectionDetailed } from "./compute-projection.js";

const PRODUCT = "01K6KXJ5G0PR0DVCT00000000A";
const BASE = Date.UTC(2026, 9, 8, 8, 0, 0);

/** A valid ULID that sorts by `n` (all zeros for `n = 0`: the forged identifier of the epic). */
const ulid = (n: number) => `0${String(n).padStart(25, "0")}`;
const stamp = (n: number) => new Date(BASE + n * 1000).toISOString();
const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, index) => (n * 7 + index) & 0xff);

type Kind = "machine" | "human" | "phone" | "browser";

/** A device with its keys, and (for the writers) its chain in the journal. */
class Party {
  head: string | null = null;
  private constructor(
    readonly kind: Kind,
    readonly sig: Ed25519KeyPair,
    readonly enc: X25519KeyPair,
    readonly device: string,
  ) {}

  static async make(kind: Kind, n: number): Promise<Party> {
    const sig = await generateEd25519({ seed: seed(n) });
    const enc = await generateX25519();
    return new Party(kind, sig, enc, deviceIdOf(kind, sig.publicKey));
  }

  get pin(): RootPin {
    return { device: this.device, public_key: toBase64url(this.sig.publicKey) };
  }

  /** An event of this writer, chained on its previous one. */
  async write(
    id: number | string,
    type: string,
    payload: Record<string, unknown> | null,
    overrides: Partial<UnsignedEventEnvelope> = {},
  ): Promise<EventEnvelope> {
    const human = this.kind === "human";
    const n = typeof id === "number" ? id : Number(id);
    const unsigned: UnsignedEventEnvelope = {
      v: 1,
      id: typeof id === "number" ? ulid(id) : id,
      type,
      at: stamp(Number.isNaN(n) ? 0 : n),
      actor: human
        ? { kind: "human", device: this.device }
        : { kind: "system", device: this.device },
      product: PRODUCT,
      provenance: "trusted",
      prev: this.head,
      // `null`: an encrypted payload instead of a clear one (never allowed on these types).
      ...(payload === null
        ? {
            payload_enc: {
              alg: "xchacha20poly1305",
              key_id: "pk:AAAAAAAAAAAAAAAA",
              nonce: "AAAA",
              ct: "AAAA",
            },
          }
        : { payload }),
      alg: "ed25519",
      ...(human ? { assurance: "locale" as const } : {}),
      ...overrides,
    };
    const event = await signEd25519(unsigned, this.sig.secretKey);
    const hashed = eventHash(event);
    if (!hashed.ok) throw new Error("no hash");
    this.head = hashed.hash;
    return event;
  }

  register(id: number | string): Promise<EventEnvelope> {
    const key = { public_key: toBase64url(this.sig.publicKey) };
    return this.write(
      id,
      this.kind === "human" ? HUMAN_EVENT_TYPES.keyRegistered : "device.registered",
      key,
    );
  }
}

const hashOf = (event: EventEnvelope): string => {
  const hashed = eventHash(event);
  if (!hashed.ok) throw new Error("no hash");
  return hashed.hash;
};

interface PairedOptions {
  readonly bridge: Party;
  readonly signer: Party;
  readonly provisional?: boolean;
  readonly at?: number;
}

/** The payload of `device.paired` for `subject`, its authorization signed by `signer`. */
async function paired(subject: Party, options: PairedOptions): Promise<DevicePairedPayload> {
  const unsigned = {
    device: subject.device,
    kind: subject.kind as "machine" | "phone" | "browser",
    sig: { alg: "ed25519" as const, key: toBase64url(subject.sig.publicKey) },
    enc: { alg: "x25519" as const, key: toBase64url(subject.enc.publicKey) },
    bridge: options.bridge.device,
    provisional: options.provisional ?? false,
    issued_at: stamp(options.at ?? 1),
  };
  const sig = await signTrustRecord(
    devicePairedRecord(unsigned),
    TRUST_SIGNATURE_TAGS.devicePaired,
    options.signer.sig.secretKey,
  );
  return {
    ...unsigned,
    authorization: { signer: options.signer.device, alg: "ed25519", sig },
  };
}

/** The payload of `device.revoked` of `target` by `author`. */
async function revoked(
  target: Party,
  author: Party,
  chainHead: string | null = null,
  at = 1,
): Promise<DeviceRevokedPayload> {
  const unsigned = {
    device: target.device,
    chain_head: chainHead,
    issued_at: stamp(at),
    author: author.device,
  };
  const sig = await signTrustRecord(
    deviceRevokedRecord(unsigned),
    TRUST_SIGNATURE_TAGS.deviceRevoked,
    author.sig.secretKey,
  );
  return { ...unsigned, authorization: { alg: "ed25519", sig } };
}

/** The product of the epic: the creator's key (root), a bridge, a phone and a browser. */
async function world() {
  const root = await Party.make("human", 1);
  const bridge = await Party.make("machine", 2);
  const phone = await Party.make("phone", 3);
  const browser = await Party.make("browser", 4);
  const events: EventEnvelope[] = [];
  events.push(await root.register(1));
  events.push(await bridge.register(2));
  // The terminal pairs the bridge, then the bridge writes the phone (the creator wanted it:
  // the root's signature) and the browser (the phone's signature).
  events.push(
    await root.write(
      3,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(bridge, { bridge, signer: root, at: 3 }),
    ),
  );
  events.push(
    await bridge.write(
      4,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(phone, { bridge, signer: root, provisional: true, at: 4 }),
    ),
  );
  events.push(
    await bridge.write(
      5,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(browser, { bridge, signer: phone, at: 5 }),
    ),
  );
  /** Projects `list` with the root pinned on this machine (`null`: nothing pinned). */
  const project = (list: readonly EventEnvelope[] = events, pin: RootPin | null = root.pin) =>
    computeProjectionDetailed(list, pin === null ? {} : { pinnedRoot: pin });
  return { root, bridge, phone, browser, events, project };
}

const ids = (view: { devices: readonly { device: string }[] } | undefined) =>
  (view?.devices ?? []).map((device) => device.device).sort();
const reasonsOf = (result: Awaited<ReturnType<typeof computeProjectionDetailed>>) =>
  Object.fromEntries(result.projection.ignored.map((item) => [item.id, item.reason]));

describe("the chain of signatures leads to the pinned root", () => {
  it("trusts the bridge, the phone and the browser, root included", async () => {
    const { root, bridge, phone, browser, project } = await world();
    const result = await project();
    expect(ids(result.deviceTrust)).toEqual(
      [root.device, bridge.device, phone.device, browser.device].sort(),
    );
    expect(result.projection.ignored).toEqual([]);
    expect(result.deviceTrust?.blocked).toBe(false);
    expect(result.deviceTrust?.pinned).toBe(true);
    const byId = new Map(result.deviceTrust?.devices.map((device) => [device.device, device]));
    expect(byId.get(root.device)).toMatchObject({ root: true, authorized_by: null });
    expect(byId.get(phone.device)).toMatchObject({
      authorized_by: root.device,
      provisional: true,
      bridge: bridge.device,
    });
    expect(byId.get(browser.device)).toMatchObject({ authorized_by: phone.device });
  });

  it("gives the same registry without a pin when the journal's first creator key is the root", async () => {
    const { events, project } = await world();
    const pinned = await project();
    const unpinned = await project(events, null);
    expect(ids(unpinned.deviceTrust)).toEqual(ids(pinned.deviceTrust));
    expect(unpinned.deviceTrust?.pinned).toBe(false);
  });

  it("does not depend on the order of the events it is given", async () => {
    const { events, project } = await world();
    const forward = await project(events);
    const backward = await project([...events].reverse());
    expect(backward.projection).toEqual(forward.projection);
    expect(backward.deviceTrust).toEqual(forward.deviceTrust);
  });

  it("a journal without any event of trust projects as before, and says nothing of trust", async () => {
    const root = await Party.make("human", 1);
    const events = [await root.register(1)];
    const result = await computeProjectionDetailed(events);
    expect(result.deviceTrust).toBeUndefined();
    expect(result.projection.state.humans).toBeDefined();
    expect(await computeProjection(events)).toEqual(result.projection);
  });
});

describe("the journal holds another root (forged journal)", () => {
  async function forged() {
    const w = await world();
    const forger = await Party.make("human", 66);
    const evil = await Party.make("phone", 67);
    const evilBridge = await Party.make("machine", 68);
    // The forger's key is registered with the identifier zero: older than every event.
    const registration = await forger.register(0);
    const device = await forger.write(
      6,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(evil, { bridge: w.bridge, signer: forger, at: 6 }),
    );
    const evilRegistered = await evilBridge.register(7);
    const evilMachine = await evilBridge.write(
      8,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(evilBridge, { bridge: evilBridge, signer: forger, at: 8 }),
    );
    return { ...w, forger, evil, registration, device, evilRegistered, evilMachine };
  }

  it("keeps the root, adds no device, signals the fault and blocks every order", async () => {
    const w = await forged();
    const events = [...w.events, w.registration, w.device, w.evilRegistered, w.evilMachine];
    const result = await w.project(events);
    expect(result.deviceTrust?.root?.device).toBe(w.root.device);
    expect(ids(result.deviceTrust)).toEqual(
      [w.root.device, w.bridge.device, w.phone.device, w.browser.device].sort(),
    );
    expect(result.deviceTrust?.blocked).toBe(true);
    expect(result.deviceTrust?.faults.map((fault) => fault.id)).toEqual([w.registration.id]);
    expect(result.deviceTrust?.faults[0]?.device).toBe(w.forger.device);
    const reasons = reasonsOf(result);
    expect(reasons[w.device.id]).toBe("untrusted_authorization");
    expect(reasons[w.evilMachine.id]).toBe("untrusted_authorization");
    // The creator keys: the real one stays the root, the forged one is pending.
    const humans = result.projection.state.humans as Record<string, { trust: string }>;
    expect(humans[w.root.device]?.trust).toBe("root");
    expect(humans[w.forger.device]?.trust).toBe("pending");
  });

  it("is what the old rule did not see: without a pin, the forged key is crowned", async () => {
    const w = await forged();
    const events = [...w.events, w.registration, w.device];
    const result = await w.project(events, null);
    const humans = result.projection.state.humans as Record<string, { trust: string }>;
    expect(humans[w.forger.device]?.trust).toBe("root");
    expect(result.deviceTrust?.blocked).toBe(false);
  });

  it("raises no alert for a second creator machine registered after the root (pending)", async () => {
    const w = await world();
    const second = await Party.make("human", 70);
    const events = [...w.events, await second.register(9)];
    const result = await w.project(events);
    expect(result.deviceTrust?.blocked).toBe(false);
    expect(result.deviceTrust?.faults).toEqual([]);
    const humans = result.projection.state.humans as Record<string, { trust: string }>;
    expect(humans[second.device]?.trust).toBe("pending");
  });

  it("raises no alert for a machine registered before the pairing (it gains no trust)", async () => {
    const w = await world();
    const early = await Party.make("machine", 71);
    const events = [await early.register(0), ...w.events];
    const result = await w.project(events);
    expect(result.deviceTrust?.blocked).toBe(false);
    expect(ids(result.deviceTrust)).not.toContain(early.device);
  });

  it("flags a creator key when the pinned root has no registration in the journal", async () => {
    const w = await world();
    const other = await Party.make("human", 72);
    const result = await w.project([await other.register(1)]);
    expect(result.deviceTrust?.blocked).toBe(true);
  });

  it("the machine root is not crowned by a creator key from the journal's order", async () => {
    const w = await world();
    const result = await w.project(w.events, w.bridge.pin);
    const humans = result.projection.state.humans as Record<string, { trust: string }>;
    expect(humans[w.root.device]?.trust).toBe("pending");
    expect(result.deviceTrust?.root?.device).toBe(w.bridge.device);
    expect(result.deviceTrust?.blocked).toBe(false);
  });

  it("refuses a pin whose identifier is not its key's", async () => {
    const w = await world();
    const bad = { device: "human:AAAAAAAAAAAAAAAA", public_key: w.root.pin.public_key };
    const result = await w.project(w.events, bad);
    expect(result.deviceTrust?.root).toBeNull();
    expect(ids(result.deviceTrust)).toEqual([]);
  });
});

describe("trust.dismissed: the way out, signed by a trusted creator", () => {
  async function alert() {
    const w = await world();
    const forger = await Party.make("human", 66);
    const registration = await forger.register(0);
    const events = [...w.events, registration];
    const dismiss = (author: Party, hashes: string[], id = 10) =>
      author.write(id, DEVICE_TRUST_EVENT_TYPES.dismissed, {
        events: hashes,
        issued_at: stamp(id),
      });
    return { ...w, forger, registration, events, dismiss };
  }

  it("clears the alert when the trusted creator dismisses the event, and ignores that event", async () => {
    const w = await alert();
    const dismissal = await w.dismiss(w.root, [hashOf(w.registration)]);
    const result = await w.project([...w.events, dismissal]);
    expect(result.deviceTrust?.blocked).toBe(false);
    expect(result.deviceTrust?.faults).toEqual([]);
    expect(result.deviceTrust?.dismissed).toEqual([hashOf(w.registration)]);
    expect(reasonsOf(result)[w.registration.id]).toBe("dismissed");
    const humans = result.projection.state.humans as Record<string, unknown>;
    expect(humans[w.forger.device]).toBeUndefined();
  });

  it("ignores a dismissal signed by the forged key, or by a key not trusted", async () => {
    const w = await alert();
    const byForger = await w.dismiss(w.forger, [hashOf(w.registration)]);
    const result = await w.project([...w.events, byForger]);
    expect(result.deviceTrust?.blocked).toBe(true);
    expect(result.deviceTrust?.dismissed).toEqual([]);
  });

  it("dismisses only what raised the alert: not the root's own registration", async () => {
    const w = await alert();
    const rootRegistration = w.events[0] as EventEnvelope;
    const dismissal = await w.dismiss(w.root, [hashOf(rootRegistration)]);
    const result = await w.project([...w.events, dismissal]);
    expect(result.deviceTrust?.dismissed).toEqual([]);
    expect(result.deviceTrust?.blocked).toBe(true);
    expect(result.deviceTrust?.root?.device).toBe(w.root.device);
  });

  it("is a creator's event only: a machine cannot write it", async () => {
    const w = await alert();
    const byMachine = await w.bridge.write(10, DEVICE_TRUST_EVENT_TYPES.dismissed, {
      events: [hashOf(w.registration)],
      issued_at: stamp(10),
    });
    const result = await w.project([...w.events, byMachine]);
    expect(reasonsOf(result)[byMachine.id]).toBe("not_human");
    expect(result.deviceTrust?.blocked).toBe(true);
  });
});

describe("who may authorize a device", () => {
  it("refuses an unknown signer, a signer outside the chain, a wrong signature", async () => {
    const w = await world();
    const stranger = await Party.make("phone", 80);
    const late = await Party.make("phone", 81);
    const target1 = await Party.make("phone", 82);
    const target2 = await Party.make("phone", 83);
    const target3 = await Party.make("browser", 84);
    const e1 = await w.bridge.write(
      6,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(target1, { bridge: w.bridge, signer: stranger, at: 6 }),
    );
    // `late` is paired AFTER it signs: out of the chain at that point.
    const e2 = await w.bridge.write(
      7,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(target2, { bridge: w.bridge, signer: late, at: 7 }),
    );
    const e3 = await w.bridge.write(
      8,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(late, { bridge: w.bridge, signer: w.root, at: 8 }),
    );
    // A signature made over another record is not the signer's authorization.
    const wrong = await paired(target3, { bridge: w.bridge, signer: w.phone, at: 9 });
    const other = await paired(target3, { bridge: w.bridge, signer: w.phone, at: 10 });
    const e4 = await w.bridge.write(9, DEVICE_TRUST_EVENT_TYPES.paired, {
      ...wrong,
      authorization: other.authorization,
    });
    const result = await w.project([...w.events, e1, e2, e3, e4]);
    const reasons = reasonsOf(result);
    expect(reasons[e1.id]).toBe("untrusted_authorization");
    expect(reasons[e2.id]).toBe("untrusted_authorization");
    expect(reasons[e3.id]).toBeUndefined();
    expect(reasons[e4.id]).toBe("untrusted_authorization");
    expect(ids(result.deviceTrust)).toContain(late.device);
    expect(ids(result.deviceTrust)).not.toContain(target1.device);
    expect(ids(result.deviceTrust)).not.toContain(target3.device);
  });

  it("refuses a record modified after it was signed", async () => {
    const w = await world();
    const target = await Party.make("phone", 85);
    const payload = await paired(target, { bridge: w.bridge, signer: w.root, at: 6 });
    const tampered = { ...payload, provisional: !payload.provisional };
    const e = await w.bridge.write(6, DEVICE_TRUST_EVENT_TYPES.paired, tampered);
    const result = await w.project([...w.events, e]);
    expect(reasonsOf(result)[e.id]).toBe("untrusted_authorization");
  });

  it("an authorization holds only in the journals of the bridge it names", async () => {
    const w = await world();
    const target = await Party.make("phone", 86);
    const payload = await paired(target, { bridge: w.bridge, signer: w.root, at: 6 });
    // Copied into a journal where another trusted bridge writes it: invalid.
    const otherBridge = await Party.make("machine", 87);
    const registered = await otherBridge.register(6);
    const pairedOther = await w.root.write(
      7,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(otherBridge, { bridge: otherBridge, signer: w.root, at: 7 }),
    );
    const copied = await otherBridge.write(8, DEVICE_TRUST_EVENT_TYPES.paired, payload);
    // Written again by the right bridge, in another journal of its own: valid, no `prev` needed.
    const original = await w.bridge.write(9, DEVICE_TRUST_EVENT_TYPES.paired, payload);
    const result = await w.project([...w.events, registered, pairedOther, copied, original]);
    const reasons = reasonsOf(result);
    expect(reasons[copied.id]).toBe("untrusted_authorization");
    expect(reasons[original.id]).toBeUndefined();
    expect(ids(result.deviceTrust)).toContain(target.device);
    // The same authorization, in a journal that is only the bridge's second: no new signature.
    const second = await w.project([...w.events, original]);
    expect(ids(second.deviceTrust)).toContain(target.device);
  });

  it("a pairing written by something that is neither the bridge nor a trusted creator is refused", async () => {
    const w = await world();
    const target = await Party.make("phone", 88);
    const intruder = await Party.make("machine", 89);
    const registered = await intruder.register(6);
    const e = await intruder.write(
      7,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(target, { bridge: w.bridge, signer: w.root, at: 7 }),
    );
    const result = await w.project([...w.events, registered, e]);
    expect(reasonsOf(result)[e.id]).toBe("untrusted_authorization");
  });

  it("a bridge that is not trusted cannot be named as the bridge of a perimeter", async () => {
    const w = await world();
    const target = await Party.make("phone", 90);
    const rogue = await Party.make("machine", 91);
    const registered = await rogue.register(6);
    const e = await rogue.write(
      7,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(target, { bridge: rogue, signer: w.root, at: 7 }),
    );
    const result = await w.project([...w.events, registered, e]);
    expect(reasonsOf(result)[e.id]).toBe("untrusted_authorization");
  });

  it("an algorithm other than ed25519 or a missing authorization never reaches the registry (schema)", async () => {
    const w = await world();
    const target = await Party.make("phone", 92);
    const payload = await paired(target, { bridge: w.bridge, signer: w.root, at: 6 });
    const noAuth = { ...payload } as Record<string, unknown>;
    delete noAuth.authorization;
    const e1 = await w.bridge.write(6, DEVICE_TRUST_EVENT_TYPES.paired, noAuth);
    // Another writer, so that the first one's broken chain does not hide the second.
    const e2 = await w.root.write(7, DEVICE_TRUST_EVENT_TYPES.paired, {
      ...payload,
      authorization: { ...payload.authorization, alg: "none" },
    });
    const result = await w.project([...w.events, e1, e2]);
    expect(reasonsOf(result)[e1.id]).toBe("invalid");
    expect(reasonsOf(result)[e2.id]).toBe("invalid");
    expect(ids(result.deviceTrust)).not.toContain(target.device);
  });
});

describe("identifiers that are not their key's, keys shared by two devices", () => {
  it("refuses an identifier that is not the one its key gives", async () => {
    const w = await world();
    const target = await Party.make("phone", 93);
    const payload = await paired(target, { bridge: w.bridge, signer: w.root, at: 6 });
    const wrongId = `phone:${"A".repeat(16)}`;
    const record = { ...payload, device: wrongId };
    // Re-sign so that only the identifier is wrong.
    const { authorization: _a, ...unsigned } = record;
    const sig = await signTrustRecord(
      devicePairedRecord(unsigned),
      TRUST_SIGNATURE_TAGS.devicePaired,
      w.root.sig.secretKey,
    );
    const e = await w.bridge.write(6, DEVICE_TRUST_EVENT_TYPES.paired, {
      ...record,
      authorization: { ...payload.authorization, sig },
    });
    const result = await w.project([...w.events, e]);
    expect(reasonsOf(result)[e.id]).toBe("invalid");
    expect(ids(result.deviceTrust)).not.toContain(wrongId);
  });

  it("refuses a key that two devices share, and an encryption key too", async () => {
    const w = await world();
    // The phone's signing key presented under a browser identifier.
    const twin = await Party.make("browser", 3);
    expect(twin.device.slice(8)).toBe(w.phone.device.slice(6));
    const e1 = await w.bridge.write(
      6,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(twin, { bridge: w.bridge, signer: w.root, at: 6 }),
    );
    const thief = await Party.make("phone", 94);
    const stolenEnc = {
      ...(await paired(thief, { bridge: w.bridge, signer: w.root, at: 7 })),
      enc: { alg: "x25519" as const, key: toBase64url(w.phone.enc.publicKey) },
    };
    const { authorization: _a, ...unsigned } = stolenEnc;
    const sig = await signTrustRecord(
      devicePairedRecord(unsigned),
      TRUST_SIGNATURE_TAGS.devicePaired,
      w.root.sig.secretKey,
    );
    const e2 = await w.bridge.write(7, DEVICE_TRUST_EVENT_TYPES.paired, {
      ...stolenEnc,
      authorization: { ...stolenEnc.authorization, sig },
    });
    const result = await w.project([...w.events, e1, e2]);
    expect(reasonsOf(result)[e1.id]).toBe("invalid");
    expect(reasonsOf(result)[e2.id]).toBe("invalid");
    expect(ids(result.deviceTrust)).not.toContain(twin.device);
    expect(ids(result.deviceTrust)).not.toContain(thief.device);
  });

  it("a creator key under a phone identifier is a shared key too", async () => {
    const w = await world();
    const twin = await Party.make("phone", 1); // same seed as the root creator's key
    expect(twin.device.slice(6)).toBe(w.root.device.slice(6));
    const e = await w.bridge.write(
      6,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(twin, { bridge: w.bridge, signer: w.root, at: 6 }),
    );
    const result = await w.project([...w.events, e]);
    expect(reasonsOf(result)[e.id]).toBe("invalid");
  });
});

describe("revocation: only the ancestors of chain_head count", () => {
  async function machineWorld() {
    const w = await world();
    const machine = await Party.make("machine", 20);
    const registered = await machine.register(10);
    const paired1 = await w.root.write(
      11,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(machine, { bridge: w.bridge, signer: w.root, at: 11 }),
    );
    const e1 = await machine.write(12, "test.appended", { n: 1 });
    const e2 = await machine.write(13, "test.appended", { n: 2 });
    const e3 = await machine.write(14, "test.appended", { n: 3 });
    const base = [...w.events, registered, paired1, e1, e2, e3];
    const project = (list: readonly EventEnvelope[]) =>
      computeProjectionDetailed(list, { pinnedRoot: w.root.pin, allowTestTypes: true });
    return { ...w, machine, registered, e1, e2, e3, base, project };
  }

  it("keeps a revoked machine's events up to its head, refuses the others (even dated before)", async () => {
    const w = await machineWorld();
    // An event written after the head but dated before it (the writer chooses ULID and date).
    const antedated = await w.machine.write(
      "00000000000000000000000001",
      "test.appended",
      { n: 9 },
      {
        at: stamp(0),
      },
    );
    const revocation = await w.root.write(
      20,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.machine, w.root, hashOf(w.e2), 20),
    );
    const result = await w.project([...w.base, antedated, revocation]);
    const reasons = reasonsOf(result);
    expect(reasons[w.e1.id]).toBeUndefined();
    expect(reasons[w.e2.id]).toBeUndefined();
    expect(reasons[w.e3.id]).toBe("device_revoked");
    expect(reasons[antedated.id]).toBe("device_revoked");
    expect(ids(result.deviceTrust)).not.toContain(w.machine.device);
    expect(result.deviceTrust?.revoked).toEqual([
      { device: w.machine.device, heads: [hashOf(w.e2)], events: [revocation.id] },
    ]);
  });

  it("an empty head: nothing the machine wrote is accepted", async () => {
    const w = await machineWorld();
    const revocation = await w.root.write(
      20,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.machine, w.root, null, 20),
    );
    const result = await w.project([...w.base, revocation]);
    const reasons = reasonsOf(result);
    for (const event of [w.registered, w.e1, w.e2, w.e3]) {
      expect(reasons[event.id], event.id).toBe("device_revoked");
    }
  });

  it("two revocations of one machine: the union of their heads", async () => {
    const w = await machineWorld();
    const r1 = await w.root.write(
      20,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.machine, w.root, hashOf(w.e1), 20),
    );
    const r2 = await w.bridge.write(
      21,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.machine, w.root, hashOf(w.e3), 21),
    );
    const result = await w.project([...w.base, r1, r2]);
    const reasons = reasonsOf(result);
    expect(reasons[w.e2.id]).toBeUndefined();
    expect(reasons[w.e3.id]).toBeUndefined();
    expect(result.deviceTrust?.revoked[0]?.heads).toEqual([hashOf(w.e1), hashOf(w.e3)].sort());
  });

  it("a head the journal does not hold accepts nothing past what it can prove", async () => {
    const w = await machineWorld();
    const unknownHead = `sha256:${"A".repeat(42)}E`;
    const revocation = await w.root.write(
      20,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.machine, w.root, unknownHead, 20),
    );
    const result = await w.project([...w.base, revocation]);
    expect(reasonsOf(result)[w.e3.id]).toBe("device_revoked");
  });

  it("a revoked key never returns: its device.paired replayed afterwards is ignored", async () => {
    const w = await world();
    const revocation = await w.root.write(
      20,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.phone, w.root, null, 20),
    );
    const replay = await w.bridge.write(
      21,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(w.phone, { bridge: w.bridge, signer: w.root, at: 21 }),
    );
    const result = await w.project([...w.events, revocation, replay]);
    expect(ids(result.deviceTrust)).not.toContain(w.phone.device);
    expect(reasonsOf(result)[replay.id]).toBe("device_revoked");
  });

  it("an authorization of a signer revoked since is refused, what it signed before is kept", async () => {
    const w = await world();
    const revocation = await w.root.write(
      20,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.phone, w.root, null, 20),
    );
    const late = await Party.make("browser", 95);
    const e = await w.bridge.write(
      21,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(late, { bridge: w.bridge, signer: w.phone, at: 21 }),
    );
    const result = await w.project([...w.events, revocation, e]);
    expect(reasonsOf(result)[e.id]).toBe("untrusted_authorization");
    expect(ids(result.deviceTrust)).toContain(w.browser.device);
    expect(ids(result.deviceTrust)).not.toContain(late.device);
  });

  it("the root is never revoked by an event", async () => {
    const w = await world();
    const attempt = await w.bridge.write(
      20,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.bridge, w.bridge, null, 20),
    );
    const result = await w.project([...w.events, attempt], w.bridge.pin);
    expect(reasonsOf(result)[attempt.id]).toBe("untrusted_authorization");
    expect(ids(result.deviceTrust)).toContain(w.bridge.device);
    expect(result.deviceTrust?.revoked).toEqual([]);
  });

  it("a trusted device may retire another and itself; a stranger may not", async () => {
    const w = await world();
    const stranger = await Party.make("phone", 96);
    const byBrowser = await w.bridge.write(
      20,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.phone, w.browser, null, 20),
    );
    const byStranger = await w.bridge.write(
      21,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.browser, stranger, null, 21),
    );
    const result = await w.project([...w.events, byBrowser, byStranger]);
    expect(reasonsOf(result)[byBrowser.id]).toBeUndefined();
    expect(reasonsOf(result)[byStranger.id]).toBe("untrusted_authorization");
    expect(ids(result.deviceTrust)).not.toContain(w.phone.device);
    expect(ids(result.deviceTrust)).toContain(w.browser.device);
  });

  it("the bridge retires alone a device still provisional", async () => {
    const w = await world();
    // The phone was written provisional: the bridge retires it by itself.
    const retired = await w.bridge.write(
      20,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.phone, w.bridge, null, 20),
    );
    const result = await w.project([...w.events, retired]);
    expect(reasonsOf(result)[retired.id]).toBeUndefined();
    expect(ids(result.deviceTrust)).not.toContain(w.phone.device);
  });

  it("a trusted machine removes a device whose handover is confirmed, like any trusted device", async () => {
    const w = await world();
    const confirmed = await w.bridge.write(20, DEVICE_TRUST_EVENT_TYPES.confirmed, {
      device: w.phone.device,
      issued_at: stamp(20),
    });
    const attempt = await w.bridge.write(
      21,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.phone, w.bridge, null, 21),
    );
    const result = await w.project([...w.events, confirmed, attempt]);
    expect(reasonsOf(result)[attempt.id]).toBeUndefined();
    expect(ids(result.deviceTrust)).not.toContain(w.phone.device);
    // A trusted browser removes it too.
    const byBrowser = await w.bridge.write(
      22,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.phone, w.browser, null, 22),
    );
    const retired = await w.project([...w.events, confirmed, attempt, byBrowser]);
    expect(ids(retired.deviceTrust)).not.toContain(w.phone.device);
  });
});

describe("device.confirmed and device.root_certified", () => {
  it("only the bridge of the device lifts provisional", async () => {
    const w = await world();
    const byBridge = await w.bridge.write(20, DEVICE_TRUST_EVENT_TYPES.confirmed, {
      device: w.phone.device,
      issued_at: stamp(20),
    });
    const other = await Party.make("machine", 98);
    const otherRegistered = await other.register(21);
    const byOther = await other.write(22, DEVICE_TRUST_EVENT_TYPES.confirmed, {
      device: w.phone.device,
      issued_at: stamp(22),
    });
    const result = await w.project([...w.events, byBridge, otherRegistered, byOther]);
    expect(
      result.deviceTrust?.devices.find((device) => device.device === w.phone.device)?.provisional,
    ).toBe(false);
    expect(reasonsOf(result)[byBridge.id]).toBeUndefined();
    expect(reasonsOf(result)[byOther.id]).toBe("untrusted_authorization");
    const onlyOther = await w.project([...w.events, otherRegistered, byOther]);
    expect(
      onlyOther.deviceTrust?.devices.find((device) => device.device === w.phone.device)
        ?.provisional,
    ).toBe(true);
  });

  it("the certification by the first phone changes nothing about validity", async () => {
    const w = await world();
    const unsigned = {
      root: { device: w.root.device, key: toBase64url(w.root.sig.publicKey) },
      issued_at: stamp(20),
    };
    const sig = await signTrustRecord(
      rootCertifiedRecord(unsigned),
      TRUST_SIGNATURE_TAGS.rootCertified,
      w.phone.sig.secretKey,
    );
    const certified = await w.bridge.write(20, DEVICE_TRUST_EVENT_TYPES.rootCertified, {
      ...unsigned,
      authorization: { signer: w.phone.device, alg: "ed25519", sig },
    });
    const forged = await w.bridge.write(21, DEVICE_TRUST_EVENT_TYPES.rootCertified, {
      ...unsigned,
      root: { device: w.root.device, key: toBase64url(w.phone.sig.publicKey) },
      authorization: { signer: w.phone.device, alg: "ed25519", sig },
    });
    const without = await w.project();
    const withCert = await w.project([...w.events, certified]);
    expect(withCert.deviceTrust?.root_certified_by).toBe(w.phone.device);
    expect(without.deviceTrust?.root_certified_by).toBeNull();
    expect(withCert.deviceTrust?.devices).toEqual(without.deviceTrust?.devices);
    expect(withCert.projection.ignored).toEqual(without.projection.ignored);
    const bad = await w.project([...w.events, certified, forged]);
    expect(reasonsOf(bad)[forged.id]).toBe("untrusted_authorization");
    // The certification that verifies counts (the first one); the forged one does not.
    expect(bad.deviceTrust?.root_certified_by).toBe(w.phone.device);
  });
});

describe("the first device recognises the creator's key as the root", () => {
  async function certifiedBy(signer: Party, w: Awaited<ReturnType<typeof world>>, at: number) {
    const unsigned = {
      root: { device: w.root.device, key: toBase64url(w.root.sig.publicKey) },
      issued_at: stamp(at),
    };
    const sig = await signTrustRecord(
      rootCertifiedRecord(unsigned),
      TRUST_SIGNATURE_TAGS.rootCertified,
      signer.sig.secretKey,
    );
    return w.bridge.write(at, DEVICE_TRUST_EVENT_TYPES.rootCertified, {
      ...unsigned,
      authorization: { signer: signer.device, alg: "ed25519", sig },
    });
  }

  it("counts when a browser signs it, and changes the validity of nothing", async () => {
    const w = await world();
    const certified = await certifiedBy(w.browser, w, 20);
    const without = await w.project();
    const withCert = await w.project([...w.events, certified]);
    expect(withCert.deviceTrust?.root_certified_by).toBe(w.browser.device);
    expect(withCert.deviceTrust?.devices).toEqual(without.deviceTrust?.devices);
    expect(withCert.projection.ignored).toEqual(without.projection.ignored);
    expect(withCert.projection.state).toEqual(without.projection.state);
  });

  it("does not count when a machine signs it", async () => {
    const w = await world();
    const certified = await certifiedBy(w.bridge, w, 20);
    const result = await w.project([...w.events, certified]);
    expect(reasonsOf(result)[certified.id]).toBe("untrusted_authorization");
    expect(result.deviceTrust?.root_certified_by).toBeNull();
  });

  it("does not count when the device that signed it was revoked", async () => {
    const w = await world();
    // The browser is taken out first, then something is signed with its key.
    const gone = await w.bridge.write(
      19,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(w.browser, w.root, null, 19),
    );
    const certified = await certifiedBy(w.browser, w, 20);
    const result = await w.project([...w.events, gone, certified]);
    expect(result.deviceTrust?.root_certified_by).toBeNull();
  });
});

describe("the signed order of a trusted device (pair.offer)", () => {
  async function offered(
    subject: Party,
    w: Awaited<ReturnType<typeof world>>,
    x: string,
    expires: number,
  ) {
    const order = { x, expires_at: stamp(expires) };
    const sig = await signTrustRecord(
      pairOfferRecord({ kind: subject.kind as "phone", bridge: w.bridge.device, order }),
      TRUST_SIGNATURE_TAGS.pairOffer,
      w.phone.sig.secretKey,
    );
    const unsigned = await paired(subject, { bridge: w.bridge, signer: w.phone, at: 30 });
    return {
      ...unsigned,
      authorization: { signer: w.phone.device, alg: "ed25519" as const, sig, order },
    };
  }
  const X = `${"B".repeat(21)}Q`;

  it("pairs a device on the authority of a trusted device's offer, once", async () => {
    const w = await world();
    const newcomer = await Party.make("browser", 99);
    const second = await Party.make("browser", 100);
    const e1 = await w.bridge.write(
      30,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await offered(newcomer, w, X, 40),
    );
    const e2 = await w.bridge.write(
      31,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await offered(second, w, X, 40),
    );
    const result = await w.project([...w.events, e1, e2]);
    expect(ids(result.deviceTrust)).toContain(newcomer.device);
    expect(reasonsOf(result)[e2.id]).toBe("untrusted_authorization");
    expect(ids(result.deviceTrust)).not.toContain(second.device);
  });

  it("refuses an offer used after it expired, or for another kind of device", async () => {
    const w = await world();
    const late = await Party.make("browser", 101);
    const wrongKind = await Party.make("machine", 102);
    const e1 = await w.bridge.write(
      50,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await offered(late, w, X, 40),
    );
    // Signed for a phone, used to pair a machine.
    const forSomeone = await offered(wrongKind, w, `${"C".repeat(21)}Q`, 60);
    const swapped = {
      ...forSomeone,
      authorization: {
        ...forSomeone.authorization,
        sig: (await offered(late, w, `${"C".repeat(21)}Q`, 60)).authorization.sig,
      },
    };
    const e2 = await w.bridge.write(51, DEVICE_TRUST_EVENT_TYPES.paired, swapped);
    const result = await w.project([...w.events, e1, e2]);
    expect(reasonsOf(result)[e1.id]).toBe("untrusted_authorization");
    expect(reasonsOf(result)[e2.id]).toBe("untrusted_authorization");
  });
});

describe("6.24 what the review found (hostile or odd journals)", () => {
  it("an event of trust with an encrypted payload does not stop the projection", async () => {
    const w = await world();
    const rogue = await Party.make("machine", 110);
    const registered = await rogue.register(6);
    const events: EventEnvelope[] = [registered];
    let n = 7;
    for (const type of Object.values(DEVICE_TRUST_EVENT_TYPES)) {
      events.push(await rogue.write(n++, type, null));
    }
    const endorsement = await w.root.write(n++, HUMAN_EVENT_TYPES.keyEndorsed, null);
    const result = await w.project([...w.events, ...events, endorsement]);
    for (const event of [...events.slice(1), endorsement]) {
      expect(reasonsOf(result)[event.id], event.type).toBeDefined();
    }
    expect(ids(result.deviceTrust)).toContain(w.phone.device);
  });

  it("a machine that retires itself with an older head does not flip between revoked and trusted", async () => {
    const w = await world();
    const machine = await Party.make("machine", 111);
    const registered = await machine.register(10);
    const paired1 = await w.root.write(
      11,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(machine, { bridge: w.bridge, signer: w.root, at: 11 }),
    );
    const e1 = await machine.write(12, "test.appended", { n: 1 });
    const e2 = await machine.write(13, "test.appended", { n: 2 });
    const own = await machine.write(
      14,
      DEVICE_TRUST_EVENT_TYPES.revoked,
      await revoked(machine, machine, hashOf(e1), 14),
    );
    const list = [...w.events, registered, paired1, e1, e2, own];
    const result = await computeProjectionDetailed(list, {
      pinnedRoot: w.root.pin,
      allowTestTypes: true,
    });
    expect(ids(result.deviceTrust)).not.toContain(machine.device);
    expect(reasonsOf(result)[own.id]).toBeUndefined();
    expect(reasonsOf(result)[e2.id]).toBe("device_revoked");
    expect(reasonsOf(result)[e1.id]).toBeUndefined();
  });

  it("only the root pairs a machine as its own bridge, never a phone", async () => {
    const w = await world();
    const machine = await Party.make("machine", 112);
    const registered = await machine.register(6);
    const byPhone = await machine.write(
      7,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(machine, { bridge: machine, signer: w.phone, at: 7 }),
    );
    const result = await w.project([...w.events, registered, byPhone]);
    expect(reasonsOf(result)[byPhone.id]).toBe("untrusted_authorization");
    expect(ids(result.deviceTrust)).not.toContain(machine.device);
  });

  it("the root machine paired by its own event appears once, as the root", async () => {
    const w = await world();
    const self = await w.bridge.write(
      20,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(w.bridge, { bridge: w.bridge, signer: w.bridge, at: 20 }),
    );
    const result = await w.project([...w.events, self], w.bridge.pin);
    expect(result.deviceTrust?.devices.filter((d) => d.device === w.bridge.device)).toHaveLength(1);
    expect(reasonsOf(result)[self.id]).toBeUndefined();
  });

  it("a replay of a pairing under another bridge is not a valid duplicate", async () => {
    const w = await world();
    const other = await Party.make("machine", 113);
    const registered = await other.register(6);
    const pairedOther = await w.root.write(
      7,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(other, { bridge: other, signer: w.root, at: 7 }),
    );
    const replay = await other.write(
      8,
      DEVICE_TRUST_EVENT_TYPES.paired,
      await paired(w.phone, { bridge: other, signer: w.root, at: 8 }),
    );
    const result = await w.project([...w.events, registered, pairedOther, replay]);
    expect(reasonsOf(result)[replay.id]).toBe("invalid");
  });
});

describe("AD-22 an engine that does not know a type does not ignore it", () => {
  it("asks for an upgrade on a type of the abandoned recovery code (device.unlocked)", async () => {
    const w = await world();
    const future = await w.bridge.write(20, "device.unlocked", { device: w.phone.device });
    await expect(w.project([...w.events, future])).rejects.toMatchObject({
      code: ErrorCode.UPGRADE_REQUIRED,
    });
  });
});
