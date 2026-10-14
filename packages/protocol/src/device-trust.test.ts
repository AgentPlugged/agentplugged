import { describe, expect, it } from "vitest";
import {
  AuthorizationSchema,
  DEVICE_ID_PATTERN,
  DEVICE_TRUST_EVENT_TYPES,
  DeviceConfirmedPayloadSchema,
  DevicePairedPayloadSchema,
  DeviceRevokedPayloadSchema,
  DeviceRootCertifiedPayloadSchema,
  deviceKindOf,
  devicePairedRecord,
  deviceRevokedRecord,
  EVENT_TYPE_REGISTRY,
  eventTypeUpgrade,
  HUMAN_ONLY_EVENT_TYPES,
  isTrustSignatureTag,
  KNOWN_EVENT_TYPES,
  PairOfferSchema,
  pairOfferRecord,
  RootPinSchema,
  TRUST_SIGNATURE_TAGS,
  TrustDismissedPayloadSchema,
} from "./index.js";

const KEY = `${"A".repeat(42)}E`;
const SIG = `${"A".repeat(85)}Q`;
const HASH = `sha256:${"A".repeat(42)}E`;
const AT = "2026-10-08T08:00:00.000Z";
const authorization = { signer: "human:AAAAAAAAAAAAAAAA", alg: "ed25519", sig: SIG };
const paired = {
  device: "phone:AAAAAAAAAAAAAAAA",
  kind: "phone",
  sig: { alg: "ed25519", key: KEY },
  enc: { alg: "x25519", key: KEY },
  bridge: "machine:BBBBBBBBBBBBBBBB",
  provisional: true,
  issued_at: AT,
  authorization,
};

describe("device identifiers", () => {
  it.each([
    ["machine:AAAAAAAAAAAAAAAA", "machine"],
    ["human:abcdefghijklmnop", "human"],
    ["phone:A_-0A_-0A_-0A_-0", "phone"],
    ["browser:AAAAAAAAAAAAAAAA", "browser"],
  ])("accepts %s", (id, kind) => {
    expect(DEVICE_ID_PATTERN.test(id)).toBe(true);
    expect(deviceKindOf(id)).toBe(kind);
  });

  it.each([
    "machine:AAAAAAAAAAAAAAA",
    "machine:AAAAAAAAAAAAAAAAA",
    "machine:AAAAAAAAAAAAAAA+",
    "Machine:AAAAAAAAAAAAAAAA",
    "tablet:AAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAA",
    "01JZ0000000000000000000000",
    "phone:AAAAAAAAAAAAAAAA\n",
  ])("refuses %s", (id) => {
    expect(DEVICE_ID_PATTERN.test(id)).toBe(false);
    expect(deviceKindOf(id)).toBeUndefined();
  });
});

describe("the five trust events", () => {
  it("are known at version 1, and an old engine asks for an upgrade without them", () => {
    for (const type of Object.values(DEVICE_TRUST_EVENT_TYPES)) {
      expect(KNOWN_EVENT_TYPES).toContain(type);
      expect(EVENT_TYPE_REGISTRY[type]?.version).toBe(1);
      expect(eventTypeUpgrade(type, 1)).toBeUndefined();
      // Never encrypted: every machine reads them.
      expect(EVENT_TYPE_REGISTRY[type]?.sensitive).toBeUndefined();
      expect(eventTypeUpgrade(type, 2)?.code).toBe("UPGRADE_REQUIRED");
    }
    // Abandoned with the recovery code (recalibration of 2026-10-06): not known.
    expect(eventTypeUpgrade("device.unlocked", 1)?.code).toBe("UPGRADE_REQUIRED");
    expect(eventTypeUpgrade("device.recovery_set", 1)?.code).toBe("UPGRADE_REQUIRED");
  });

  it("makes trust.dismissed the creator's alone", () => {
    expect(HUMAN_ONLY_EVENT_TYPES.has("trust.dismissed")).toBe(true);
    expect(HUMAN_ONLY_EVENT_TYPES.has("device.paired")).toBe(false);
  });

  it("device.paired is strict, versioned and typed", () => {
    expect(DevicePairedPayloadSchema.safeParse(paired).success).toBe(true);
    const bad = (patch: Record<string, unknown>) =>
      DevicePairedPayloadSchema.safeParse({ ...paired, ...patch }).success;
    expect(bad({ extra: 1 })).toBe(false);
    expect(bad({ kind: "browser" })).toBe(false); // kind is the prefix of the device
    expect(bad({ device: "human:AAAAAAAAAAAAAAAA", kind: "phone" })).toBe(false);
    expect(bad({ sig: { alg: "webauthn-es256", key: KEY } })).toBe(false);
    expect(bad({ sig: { alg: "none", key: KEY } })).toBe(false);
    expect(bad({ enc: { alg: "ed25519", key: KEY } })).toBe(false);
    expect(bad({ sig: { alg: "ed25519", key: "AAAA" } })).toBe(false);
    expect(bad({ bridge: "phone:AAAAAAAAAAAAAAAA" })).toBe(false);
    expect(bad({ provisional: "yes" })).toBe(false);
    expect(bad({ issued_at: "yesterday" })).toBe(false);
    expect(bad({ authorization: { ...authorization, alg: "webauthn-es256" } })).toBe(false);
    expect(bad({ authorization: { ...authorization, alg: "none" } })).toBe(false);
    expect(bad({ authorization: { ...authorization, extra: true } })).toBe(false);
    for (const field of ["sig", "enc", "bridge", "provisional", "issued_at", "authorization"]) {
      const { [field]: _gone, ...rest } = paired as Record<string, unknown>;
      expect(DevicePairedPayloadSchema.safeParse(rest).success, field).toBe(false);
    }
  });

  it("an authorization may carry the signed order of a trusted device", () => {
    const order = { x: `${"A".repeat(21)}Q`, expires_at: AT };
    expect(PairOfferSchema.safeParse(order).success).toBe(true);
    expect(PairOfferSchema.safeParse({ ...order, x: "short" }).success).toBe(false);
    expect(AuthorizationSchema.safeParse({ ...authorization, order }).success).toBe(true);
    expect(AuthorizationSchema.safeParse({ ...authorization, order: { x: order.x } }).success).toBe(
      false,
    );
  });

  it("device.revoked names the device, the head, the date and the author", () => {
    const revoked = {
      device: "machine:AAAAAAAAAAAAAAAA",
      chain_head: HASH,
      issued_at: AT,
      author: "phone:BBBBBBBBBBBBBBBB",
      authorization: { alg: "ed25519", sig: SIG },
    };
    const accepts = (patch: Record<string, unknown>) =>
      DeviceRevokedPayloadSchema.safeParse({ ...revoked, ...patch }).success;
    expect(accepts({})).toBe(true);
    expect(accepts({ chain_head: null })).toBe(true);
    // Only a machine writes to the journal: a phone has no head.
    expect(accepts({ device: "phone:AAAAAAAAAAAAAAAA" })).toBe(false);
    expect(accepts({ device: "phone:AAAAAAAAAAAAAAAA", chain_head: null })).toBe(true);
    // The creator's key is not revoked by an event.
    expect(accepts({ device: "human:AAAAAAAAAAAAAAAA" })).toBe(false);
    expect(accepts({ chain_head: "sha256:x" })).toBe(false);
    expect(accepts({ extra: 1 })).toBe(false);
    expect(accepts({ authorization: { alg: "none", sig: SIG } })).toBe(false);
  });

  it("device.confirmed, device.root_certified, trust.dismissed", () => {
    expect(
      DeviceConfirmedPayloadSchema.safeParse({ device: paired.device, issued_at: AT }).success,
    ).toBe(true);
    expect(
      DeviceRootCertifiedPayloadSchema.safeParse({
        root: { device: "human:AAAAAAAAAAAAAAAA", key: KEY },
        issued_at: AT,
        authorization,
      }).success,
    ).toBe(true);
    expect(TrustDismissedPayloadSchema.safeParse({ events: [HASH], issued_at: AT }).success).toBe(
      true,
    );
    expect(TrustDismissedPayloadSchema.safeParse({ events: [], issued_at: AT }).success).toBe(
      false,
    );
    expect(
      TrustDismissedPayloadSchema.safeParse({ events: Array(17).fill(HASH), issued_at: AT })
        .success,
    ).toBe(false);
  });

  it("pins a root of a human or a machine only", () => {
    const pin = (device: string) => RootPinSchema.safeParse({ device, public_key: KEY }).success;
    expect(pin("human:AAAAAAAAAAAAAAAA")).toBe(true);
    expect(pin("machine:AAAAAAAAAAAAAAAA")).toBe(true);
    expect(pin("phone:AAAAAAAAAAAAAAAA")).toBe(false);
  });
});

describe("the signed records carry their label t", () => {
  it("builds each record with its own label, and knows only these labels", () => {
    const { authorization: _a, ...unsigned } = paired;
    const record = devicePairedRecord(unsigned as never);
    expect(record.t).toBe(TRUST_SIGNATURE_TAGS.devicePaired);
    expect(JSON.stringify(record)).not.toContain(SIG);
    expect(
      deviceRevokedRecord({
        device: "machine:AAAAAAAAAAAAAAAA",
        chain_head: null,
        issued_at: AT,
        author: "phone:BBBBBBBBBBBBBBBB",
      }).t,
    ).toBe(TRUST_SIGNATURE_TAGS.deviceRevoked);
    expect(
      pairOfferRecord({
        kind: "phone",
        bridge: paired.bridge,
        order: { x: `${"A".repeat(21)}Q`, expires_at: AT },
      }).t,
    ).toBe(TRUST_SIGNATURE_TAGS.pairOffer);
    expect(isTrustSignatureTag("device.paired.auth/v1")).toBe(true);
    expect(isTrustSignatureTag("relay.auth/v1")).toBe(false);
    expect(isTrustSignatureTag(undefined)).toBe(false);
  });
});
