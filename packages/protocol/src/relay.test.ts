import { describe, expect, it } from "vitest";
import { ErrorCode } from "./error-payload.js";
import {
  base64urlBytes,
  base64urlLength,
  parseRelayEnvelope,
  RELAY_ACCEPTED_VERSIONS,
  RELAY_ENVELOPE_VERSION,
  RELAY_MAX_CIPHERTEXT_BYTES,
  RelayClientFrameSchema,
  RelayEnvelopeSchema,
  RelayErrorCode,
  RelayServerFrameSchema,
  relayAuthPayload,
  relayError,
  relayMessageKey,
} from "./relay.js";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** `count` bytes of `fill`, in canonical base64url (no `Buffer` here: this package has no Node types). */
function bytes64(count: number, fill: number): string {
  let out = "";
  for (let i = 0; i < count; i += 3) {
    const n = Math.min(3, count - i);
    const value = (fill << 16) | ((n > 1 ? fill : 0) << 8) | (n > 2 ? fill : 0);
    const chars = [(value >> 18) & 63, (value >> 12) & 63, (value >> 6) & 63, value & 63];
    out += chars
      .slice(0, n + 1)
      .map((index) => ALPHABET.charAt(index))
      .join("");
  }
  return out;
}
const envelope = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  to: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  from: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  id: ID,
  nonce: bytes64(24, 1),
  ciphertext: bytes64(40, 2),
  ...extra,
});

describe("l'enveloppe du relais", () => {
  it("accepte { v, to, from, id, nonce, ciphertext } et rien d'autre", () => {
    expect(RelayEnvelopeSchema.safeParse(envelope()).success).toBe(true);
    const parsed = parseRelayEnvelope(envelope());
    expect(parsed.success).toBe(true);
    expect(Object.keys(envelope()).sort()).toEqual([
      "ciphertext",
      "from",
      "id",
      "nonce",
      "to",
      "v",
    ]);
  });

  it("refuse une clé en trop, un champ manquant et une valeur hors borne, avec { code, message_key, details }", () => {
    const missing = envelope();
    const { nonce: _, ...withoutNonce } = missing;
    const cases: [unknown, string][] = [
      [envelope({ extra: 1 }), "keys"],
      [withoutNonce, "nonce"],
      [envelope({ to: "pas un ulid" }), "to"],
      [envelope({ from: 3 }), "from"],
      [envelope({ id: ID.toLowerCase() }), "id"],
      [envelope({ nonce: "" }), "nonce"],
      [envelope({ nonce: "a".repeat(65) }), "nonce"],
      [envelope({ ciphertext: "" }), "ciphertext"],
      [envelope({ ciphertext: "pas du base64url !" }), "ciphertext"],
      [envelope({ ciphertext: "a=" }), "ciphertext"],
      [envelope({ v: 0 }), "v"],
      [envelope({ v: 1.5 }), "v"],
      [envelope({ v: "1" }), "v"],
      [null, ""],
      [[envelope()], ""],
    ];
    for (const [input, field] of cases) {
      const parsed = parseRelayEnvelope(input);
      expect(parsed.success, JSON.stringify(input)).toBe(false);
      if (!parsed.success) {
        expect(parsed.error).toEqual({
          code: RelayErrorCode.ENVELOPE_INVALID,
          message_key: "error.relay.envelope_invalid",
          details: { field },
        });
      }
    }
  });

  it("une erreur ne répète jamais la valeur reçue", () => {
    const parsed = parseRelayEnvelope(envelope({ ciphertext: "CANARI secret !" }));
    expect(JSON.stringify(parsed)).not.toContain("CANARI");
    const stray = parseRelayEnvelope(envelope({ "CANARI-champ": "CANARI-valeur" }));
    expect(JSON.stringify(stray)).not.toContain("CANARI");
  });

  it("une version autre que la courante ou la précédente est refusée avec UPGRADE_REQUIRED", () => {
    expect(RELAY_ENVELOPE_VERSION).toBe(1);
    expect(RELAY_ACCEPTED_VERSIONS).toContain(RELAY_ENVELOPE_VERSION);
    for (const v of [2, 3, 99]) {
      const parsed = parseRelayEnvelope(envelope({ v }));
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.code).toBe(ErrorCode.UPGRADE_REQUIRED);
        expect(parsed.error.message_key).toBe("error.relay.upgrade_required");
        expect(parsed.error.details).toEqual({ field: "v", supported: [1] });
        expect(JSON.stringify(parsed.error)).not.toContain(String(v));
      }
    }
  });

  it("la taille maximale est celle du protocole : X octets acceptés, X + 1 refusés avec ENVELOPE_TOO_LARGE", () => {
    const limit = 600;
    const sized = (bytes: number) => envelope({ ciphertext: bytes64(bytes, 5) });
    expect(parseRelayEnvelope(sized(limit), limit).success).toBe(true);
    const over = parseRelayEnvelope(sized(limit + 1), limit);
    expect(over.success).toBe(false);
    if (!over.success) {
      expect(over.error).toEqual({
        code: "ENVELOPE_TOO_LARGE",
        message_key: "error.relay.envelope_too_large",
        details: { max_bytes: limit },
      });
    }
    // The protocol's own ceiling, the one a snapshot is cut at.
    const max = RELAY_MAX_CIPHERTEXT_BYTES;
    expect(parseRelayEnvelope(sized(max)).success).toBe(true);
    const tooBig = parseRelayEnvelope(sized(max + 1));
    expect(!tooBig.success && tooBig.error.code).toBe("ENVELOPE_TOO_LARGE");
    expect(RelayEnvelopeSchema.safeParse(sized(max + 1)).success).toBe(false);
  });

  it("compte les octets d'un texte base64url", () => {
    for (const bytes of [1, 2, 3, 4, 5, 100, 1000]) {
      const text = bytes64(bytes, 1);
      expect(text.length).toBe(base64urlLength(bytes));
      expect(base64urlBytes(text.length)).toBe(bytes);
    }
  });

  it("les codes ont leur clé de message, en minuscules, sous error.relay", () => {
    for (const code of Object.values(RelayErrorCode)) {
      expect(relayMessageKey(code)).toBe(`error.relay.${code.toLowerCase()}`);
      expect(relayError(code).details).toEqual({});
    }
    expect(Object.keys(RelayErrorCode)).toEqual(Object.values(RelayErrorCode));
  });

  it("la preuve d'identité signe un domaine, le défi et l'identifiant de l'appareil", () => {
    const expected = `relay.auth/v1\nDEFI\n${ID}\nrelay.example\n1760000000`;
    expect(Array.from(relayAuthPayload("DEFI", ID, "relay.example", 1760000000))).toEqual(
      Array.from(expected, (char) => char.charCodeAt(0)),
    );
    // Non-ASCII text is encoded as UTF-8 too.
    const prefix = "relay.auth/v1\n".length;
    expect(Array.from(relayAuthPayload("é€😀", ID, "r", 1).slice(prefix, prefix + 10))).toEqual([
      0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80, 0x0a,
    ]);
  });

  it("les trames du client et du relais sont strictes", () => {
    const hello = {
      type: "hello",
      v: 1,
      device_id: ID,
      credential: "x",
      signed_at: 1760000000,
      signature: bytes64(64, 0),
    };
    expect(RelayClientFrameSchema.safeParse(hello).success).toBe(true);
    expect(RelayClientFrameSchema.safeParse({ ...hello, extra: 1 }).success).toBe(false);
    expect(RelayClientFrameSchema.safeParse({ ...hello, signature: "court" }).success).toBe(false);
    expect(RelayClientFrameSchema.safeParse({ type: "ack", from: ID, id: ID }).success).toBe(true);
    expect(RelayClientFrameSchema.safeParse({ type: "inconnue" }).success).toBe(false);
    expect(
      RelayServerFrameSchema.safeParse({ type: "accepted", id: ID, duplicate: false }).success,
    ).toBe(true);
    expect(
      RelayServerFrameSchema.safeParse({ type: "error", error: relayError("RATE_LIMITED") })
        .success,
    ).toBe(true);
  });
});

describe("the request to stop serving a device", () => {
  const KEY = bytes64(32, 7);

  it("names the device by its signing key, or by its identifier at the relay, never by both or neither", () => {
    const parse = (frame: unknown) => RelayClientFrameSchema.safeParse(frame).success;
    expect(parse({ type: "device_revoke", sig_key: KEY })).toBe(true);
    expect(parse({ type: "device_revoke", device_id: ID })).toBe(true);
    expect(parse({ type: "device_revoke" })).toBe(false);
    expect(parse({ type: "device_revoke", sig_key: KEY, device_id: ID })).toBe(false);
    expect(parse({ type: "device_revoke", sig_key: "court" })).toBe(false);
    expect(parse({ type: "device_revoke", sig_key: KEY, extra: 1 })).toBe(false);
  });

  it("is answered with what the relay did, and the others hear that the device is gone", () => {
    const parse = (frame: unknown) => RelayServerFrameSchema.safeParse(frame).success;
    expect(parse({ type: "device_revoked", found: true, device_id: ID })).toBe(true);
    expect(parse({ type: "device_revoked", found: false, device_id: null })).toBe(true);
    expect(parse({ type: "device_revoked", found: true })).toBe(false);
    expect(parse({ type: "device_gone", device_id: ID })).toBe(true);
    expect(parse({ type: "device_gone" })).toBe(false);
  });
});
