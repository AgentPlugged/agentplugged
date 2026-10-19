import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EventEnvelope, UnsignedEventEnvelope } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { buildVectors, VECTORS_FILE } from "../scripts/generate-vectors.mjs";
import {
  canonicalBytes,
  eventHash,
  fromBase64url,
  generateEd25519,
  sha256Hex,
  signEd25519,
  signedBytes,
  toBase64url,
  toHex,
  type VerifyKeys,
  verifyEvent,
  webauthnChallenge,
} from "./index.js";

type Credential = { id: string; public_key: string };

type VectorCase = {
  name: string;
  envelope: EventEnvelope;
  verify_with: {
    ed25519_public_key: boolean;
    webauthn_credential: "es256" | "rs256" | null;
    webauthn_counter?: number;
  };
  signed_bytes_hex: string;
  hash: string;
  expected: Record<string, unknown>;
};

type Vectors = {
  keys: {
    ed25519: { public_key: string };
    webauthn: { es256: { credential: Credential }; rs256: { credential: Credential } };
  };
  cases: VectorCase[];
};

const vectorsText = readFileSync(VECTORS_FILE, "utf8");
const vectors = JSON.parse(vectorsText) as Vectors;

function bytes(base64url: string): Uint8Array {
  const out = fromBase64url(base64url);
  if (out === undefined) throw new Error(`not base64url: ${base64url}`);
  return out;
}

const ed25519PublicKey = bytes(vectors.keys.ed25519.public_key);
const credential = (name: "es256" | "rs256", counter?: number) => {
  const { id, public_key } = vectors.keys.webauthn[name].credential;
  return { id, publicKey: bytes(public_key), ...(counter === undefined ? {} : { counter }) };
};

function keysOf(vector: VectorCase): VerifyKeys {
  const { ed25519_public_key, webauthn_credential, webauthn_counter } = vector.verify_with;
  return {
    ...(ed25519_public_key ? { ed25519PublicKey } : {}),
    ...(webauthn_credential === null
      ? {}
      : { webauthnCredential: credential(webauthn_credential, webauthn_counter) }),
  };
}

function hashOf(env: EventEnvelope): string {
  const result = eventHash(env);
  if (!result.ok) throw new Error("expected a hash");
  return result.hash;
}

function vector(name: string): EventEnvelope {
  const found = vectors.cases.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no vector ${name}`);
  return found.envelope;
}

const unsigned: UnsignedEventEnvelope = {
  v: 1,
  id: "01K6KXJ5G0ED25519PAY10AD01",
  type: "story.validated",
  at: "2026-10-03T08:00:00.000Z",
  actor: { kind: "human", device: "laptop-ada" },
  product: "demo",
  provenance: "trusted",
  prev: null,
  payload: { b: 1, a: [true, null, "é"] },
  alg: "ed25519",
};

function outcome(result: Awaited<ReturnType<typeof verifyEvent>>) {
  if (result.ok) {
    return {
      ok: true,
      ...(result.assurance === undefined ? {} : { assurance: result.assurance }),
      ...(result.newCounter === undefined ? {} : { new_counter: result.newCounter }),
    };
  }
  const reasonKey = result.error.details.reason_key;
  return {
    ok: false,
    code: result.error.code,
    ...(reasonKey === undefined ? {} : { reason_key: reasonKey }),
  };
}

describe("shared test vectors (test-vectors/envelope-v1.json)", () => {
  it("covers the accepted and rejected cases", () => {
    expect(vectors.cases.map((c) => c.name)).toEqual([
      "ed25519-payload",
      "ed25519-payload-enc",
      "webauthn-es256",
      "webauthn-rs256",
      "ed25519-agent",
      "ed25519-tampered-signature",
      "ed25519-field-modified",
      "ed25519-assurance-mismatch",
      "ed25519-key-missing",
      "webauthn-es256-tampered-signature",
      "webauthn-es256-field-modified",
      "webauthn-es256-wrong-challenge",
      "webauthn-es256-no-uv",
      "webauthn-es256-wrong-origin",
      "webauthn-es256-wrong-rp",
      "webauthn-es256-create-type",
      "webauthn-es256-counter-regression",
      "webauthn-es256-key-missing",
      "webauthn-es256-alg-mismatch",
      "webauthn-es256-agent",
      "event-invalid",
      "upgrade-required",
    ]);
    const ids = vectors.cases.filter((c) => c.expected.ok).map((c) => c.envelope.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(vector("ed25519-assurance-mismatch").id).not.toBe(vector("ed25519-payload").id);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))("replays %s", async (_name, item) => {
    expect(toHex(signedBytes(item.envelope))).toBe(item.signed_bytes_hex);
    expect(hashOf(item.envelope)).toBe(item.hash);
    expect(outcome(await verifyEvent(item.envelope, keysOf(item)))).toEqual(item.expected);
  });

  it("chains the second case to the first one", () => {
    const [first, second] = vectors.cases;
    expect(second?.envelope.prev).toBe(first?.hash);
  });

  it("is what the generator writes, byte for byte", async () => {
    expect(await buildVectors()).toBe(vectorsText);
  });
});

describe("canonicalBytes and eventHash", () => {
  it("give the same bytes and hash whatever the key order", async () => {
    const { secretKey } = await generateEd25519({ seed: new Uint8Array(32) });
    const signed = await signEd25519(unsigned, secretKey);
    const reordered = Object.fromEntries(Object.entries(signed).reverse()) as EventEnvelope;
    reordered.payload = { a: [true, null, "é"], b: 1 };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(signed));
    expect(canonicalBytes(reordered)).toEqual(canonicalBytes(signed));
    expect(hashOf(reordered)).toBe(hashOf(signed));
    expect(signedBytes(reordered)).toEqual(signedBytes(signed));
  });

  it("follow RFC 8785", () => {
    const text = new TextDecoder().decode(canonicalBytes({ b: 1e21, a: "€", c: [1.5, -0] }));
    expect(text).toBe('{"a":"€","b":1e+21,"c":[1.5,0]}');
    expect(() => canonicalBytes(undefined)).toThrow();
  });

  it("sign everything but sig, alg included", () => {
    const text = new TextDecoder().decode(signedBytes({ ...unsigned, sig: "x" }));
    expect(text).toContain('"alg":"ed25519"');
    expect(text).not.toContain('"sig"');
    expect(webauthnChallenge(unsigned)).toHaveLength(32);
    expect(hashOf({ ...unsigned, sig: "x" })).toMatch(/^sha256:[\w-]{43}$/);
  });

  it("returns EVENT_INVALID for a value with no JSON form, without throwing", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const [payload, field] of [
      [{ n: Number.NaN }, "payload.n"],
      [{ n: 1n }, "payload.n"],
      [cycle, "payload.self"],
      [{ s: "\ud800" }, "payload.s"],
    ] as const) {
      expect(eventHash({ ...unsigned, payload, sig: "x" } as EventEnvelope)).toEqual({
        ok: false,
        error: {
          code: "EVENT_INVALID",
          message_key: "error.event_invalid",
          details: { field, reason_key: "reason.json_value" },
        },
      });
    }
  });
});

describe("portable encodings", () => {
  it("encode and decode base64url like Node, and refuse non-canonical text", () => {
    for (let length = 0; length < 40; length++) {
      const data = new Uint8Array(randomBytes(length));
      const text = Buffer.from(data).toString("base64url");
      expect(toBase64url(data)).toBe(text);
      expect(fromBase64url(text)).toEqual(data);
    }
    expect(fromBase64url("AB")).toBeUndefined();
    expect(fromBase64url("A")).toBeUndefined();
    expect(fromBase64url("AA==")).toBeUndefined();
  });

  it("keeps sha256Hex identical to node:crypto", () => {
    for (const data of ["", "abc", "é", "\ud800"]) {
      expect(sha256Hex(data)).toBe(createHash("sha256").update(data).digest("hex"));
    }
  });
});

describe("Ed25519", () => {
  it("derives the same key from the same seed, and a new key otherwise", async () => {
    const seed = new Uint8Array(32).fill(7);
    const [a, b, c] = await Promise.all([
      generateEd25519({ seed }),
      generateEd25519({ seed }),
      generateEd25519(),
    ]);
    expect(a.publicKey).toEqual(b.publicKey);
    expect(a.publicKey).toHaveLength(32);
    expect(a.secretKey).toHaveLength(64);
    expect(c.publicKey).not.toEqual(a.publicKey);
  });

  it("signs, and the verification gives locale to a human", async () => {
    const { publicKey, secretKey } = await generateEd25519();
    const signed = await signEd25519(unsigned, secretKey);
    expect(await verifyEvent(signed, { ed25519PublicKey: publicKey })).toEqual({
      ok: true,
      assurance: "locale",
    });
    // `assurance` is signed: adding it afterwards breaks the signature.
    expect(
      outcome(
        await verifyEvent({ ...signed, assurance: "locale" }, { ed25519PublicKey: publicKey }),
      ),
    ).toMatchObject({ reason_key: "reason.signature_mismatch" });
  });

  it("gives no assurance level to an agent or the system", async () => {
    const { publicKey, secretKey } = await generateEd25519();
    for (const actor of [
      { kind: "agent", device: "d", agent: "iris" },
      { kind: "system", device: "d" },
    ] as const) {
      const signed = await signEd25519({ ...unsigned, actor }, secretKey);
      expect(await verifyEvent(signed, { ed25519PublicKey: publicKey })).toEqual({ ok: true });
    }
  });

  it("rejects another key, a malformed key, a missing key, and a webauthn alg", async () => {
    const { secretKey } = await generateEd25519();
    const other = await generateEd25519();
    const signed = await signEd25519(unsigned, secretKey);
    expect(await verifyEvent(signed, { ed25519PublicKey: other.publicKey })).toEqual({
      ok: false,
      error: {
        code: "SIGNATURE_INVALID",
        message_key: "error.signature_invalid",
        details: { field: "sig", reason_key: "reason.signature_mismatch" },
      },
    });
    expect(
      outcome(await verifyEvent(signed, { ed25519PublicKey: new Uint8Array(3) })),
    ).toMatchObject({ reason_key: "reason.signature_mismatch" });
    expect(outcome(await verifyEvent(signed))).toMatchObject({ reason_key: "reason.key_missing" });
    await expect(signEd25519({ ...unsigned, alg: "webauthn-es256" }, secretKey)).rejects.toThrow();
  });
});

describe("verifyEvent: envelope and assurance", () => {
  it("rejects an invalid envelope with EVENT_INVALID, and v: 17 with UPGRADE_REQUIRED", async () => {
    const { publicKey, secretKey } = await generateEd25519();
    const signed = await signEd25519(unsigned, secretKey);
    const both = {
      ...signed,
      payload_enc: { alg: "x", key_id: "pk:AAAAAAAAAAAAAAAA", nonce: "AA", ct: "AA" },
    };
    expect(await verifyEvent(both, { ed25519PublicKey: publicKey })).toMatchObject({
      ok: false,
      error: { code: "EVENT_INVALID", details: { field: "payload_enc" } },
    });
    expect(await verifyEvent({ ...signed, v: 17 })).toMatchObject({
      ok: false,
      error: { code: "UPGRADE_REQUIRED" },
    });
  });

  it("returns EVENT_INVALID, without throwing, for a value with no JSON form", async () => {
    const { publicKey, secretKey } = await generateEd25519();
    const signed = await signEd25519(unsigned, secretKey);
    for (const payload of [{ s: "\udc00" }, { n: Number.POSITIVE_INFINITY }, { n: 2n }]) {
      expect(
        outcome(await verifyEvent({ ...signed, payload }, { ed25519PublicKey: publicKey })),
      ).toEqual({ ok: false, code: "EVENT_INVALID", reason_key: "reason.json_value" });
    }
  });

  it("rejects a declared assurance the signature does not give", async () => {
    const { publicKey, secretKey } = await generateEd25519();
    const signed = await signEd25519({ ...unsigned, assurance: "presence" }, secretKey);
    expect(await verifyEvent(signed, { ed25519PublicKey: publicKey })).toEqual({
      ok: false,
      error: {
        code: "SIGNATURE_INVALID",
        message_key: "error.signature_invalid",
        details: { field: "assurance", reason_key: "reason.assurance_mismatch" },
      },
    });
  });
});

describe("verifyEvent: WebAuthn", () => {
  const es256 = vector("webauthn-es256");
  if (typeof es256.sig === "string") throw new Error("the webauthn-es256 vector is malformed");
  const sig = es256.sig;

  it("returns the new counter, and rejects a counter that does not grow", async () => {
    expect(await verifyEvent(es256, { webauthnCredential: credential("es256") })).toEqual({
      ok: true,
      assurance: "presence",
      newCounter: 1,
    });
    for (const counter of [1, 5]) {
      const result = await verifyEvent(es256, { webauthnCredential: credential("es256", counter) });
      expect(outcome(result)).toEqual({
        ok: false,
        code: "SIGNATURE_INVALID",
        reason_key: "reason.counter_regression",
      });
    }
  });

  it("rejects a WebAuthn signature on an agent's event", async () => {
    const { assurance: _declared, ...rest } = es256;
    const result = await verifyEvent(
      { ...rest, actor: { kind: "agent", device: "d", agent: "iris" } },
      { webauthnCredential: credential("es256") },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "SIGNATURE_INVALID",
        message_key: "error.signature_invalid",
        details: { field: "alg", reason_key: "reason.webauthn_non_human" },
      },
    });
  });

  it("rejects a garbage credential", async () => {
    const garbage = await verifyEvent(es256, {
      webauthnCredential: { ...credential("es256"), publicKey: new Uint8Array([1, 2]) },
    });
    expect(outcome(garbage)).toMatchObject({ reason_key: "reason.alg_mismatch" });
  });

  it("rejects client data that is not JSON", async () => {
    const env = { ...es256, sig: { ...sig, clientDataJSON: "bm90IGpzb24" } };
    expect(
      outcome(await verifyEvent(env, { webauthnCredential: credential("es256") })),
    ).toMatchObject({ reason_key: "reason.client_data_mismatch" });
  });
});
