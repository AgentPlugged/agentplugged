// Shared test vectors of the event envelope v1: packages/crypto/test-vectors/envelope-v1.json.
//
//   pnpm vectors         builds this package, then writes the file
//   pnpm vectors:check   builds this package, then fails when the file differs (run by `test`)
//
// Deterministic: fixed keys (an Ed25519 seed, a P-256 scalar, an RSA key in
// fixtures/rs256-test-key.jwk.json), a fixed clock and fixed ULIDs. Ed25519 and RSA PKCS#1 v1.5
// signatures are deterministic by design; the software WebAuthn authenticator signs ES256 with
// RFC 6979 deterministic nonces (@noble/curves), so its signatures are too.
// Every case is checked against `verifyEvent` before the file is written.

import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  eventHash,
  fromBase64url,
  generateEd25519,
  signEd25519,
  signedBytes,
  toBase64url,
  toHex,
  verifyEvent,
  WEBAUTHN_ORIGIN,
  WEBAUTHN_RP_ID,
  webauthnChallenge,
} from "@agentplugged/crypto";
import { encryptPayloadWith } from "@agentplugged/crypto/testing";
import { p256 } from "@noble/curves/nist.js";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const here = dirname(fileURLToPath(import.meta.url));
export const VECTORS_FILE = join(here, "../test-vectors/envelope-v1.json");

/** Fixed test keys: never used outside these vectors. */
const ED25519_SEED = Uint8Array.from({ length: 32 }, (_, index) => index);
const P256_SCALAR = Uint8Array.from({ length: 32 }, (_, index) => 0xa0 + index);
const RSA_JWK = JSON.parse(readFileSync(join(here, "fixtures/rs256-test-key.jwk.json"), "utf8"));
const RSA_KEY = createPrivateKey({ key: RSA_JWK, format: "jwk" });
const ES256_CREDENTIAL_ID = Uint8Array.from({ length: 16 }, (_, index) => 0xc0 + index);
const RS256_CREDENTIAL_ID = Uint8Array.from({ length: 16 }, (_, index) => 0xd0 + index);

/** Fixed product key (the one of test-vectors/product-key-v1.json) and a nonce of its own. */
const PRODUCT_KEY = Uint8Array.from({ length: 32 }, (_, index) => 0x40 + index);
const PAYLOAD_NONCE = Uint8Array.from({ length: 24 }, (_, index) => 0x60 + index);

const AT = "2026-10-03T08:00:00.000Z";
const ULID = {
  edPayload: "01K6KXJ5G0ED25519PAY10AD01",
  edEncrypted: "01K6KXJ5G0ED25519ENC0PAY02",
  es256: "01K6KXJ5G0WEBAVTHNES256003",
  rs256: "01K6KXJ5G0WEBAVTHNRS256004",
  assurance: "01K6KXJ5G0ED25519ASSVRE005",
  agent: "01K6KXJ5G0ED25519AGENT0006",
};

const UV = 0x05; // UP | UV
const UP_ONLY = 0x01;

const sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const utf8 = (text) => new TextEncoder().encode(text);

/** COSE_Key (RFC 9053) of the P-256 key: kty EC2, alg ES256, crv P-256, x, y. */
function es256CoseKey() {
  const point = p256.getPublicKey(P256_SCALAR, false);
  return isoCBOR.encode(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, point.subarray(1, 33)],
      [-3, point.subarray(33, 65)],
    ]),
  );
}

/** COSE_Key (RFC 8230) of the RSA key: kty RSA, alg RS256, n, e. */
function rs256CoseKey() {
  return isoCBOR.encode(
    new Map([
      [1, 3],
      [3, -257],
      [-1, fromBase64url(RSA_JWK.n)],
      [-2, fromBase64url(RSA_JWK.e)],
    ]),
  );
}

/**
 * Software authenticator: an assertion over `challenge`. Options change what a faulty or
 * hostile authenticator would send: flags, counter, origin, relying party, client data type.
 */
function assert(
  challenge,
  {
    alg = "es256",
    flags = UV,
    counter = 1,
    origin = WEBAUTHN_ORIGIN,
    rpId = WEBAUTHN_RP_ID,
    type = "webauthn.get",
  } = {},
) {
  const authenticatorData = concat(
    sha256(utf8(rpId)),
    Uint8Array.of(flags),
    Uint8Array.of(0, 0, 0, counter),
  );
  const clientDataJSON = utf8(
    JSON.stringify({ type, challenge: toBase64url(challenge), origin, crossOrigin: false }),
  );
  const signed = concat(authenticatorData, sha256(clientDataJSON));
  const signature =
    alg === "es256"
      ? p256.sign(signed, P256_SCALAR, { format: "der" })
      : new Uint8Array(sign("sha256", signed, RSA_KEY));
  return {
    authenticatorData: toBase64url(authenticatorData),
    clientDataJSON: toBase64url(clientDataJSON),
    signature: toBase64url(signature),
  };
}

/** Flips the last bit of a base64url value's bytes. */
function tamper(value) {
  const bytes = fromBase64url(value);
  bytes[bytes.length - 1] ^= 0x01;
  return toBase64url(bytes);
}

function envelope(id, fields) {
  return {
    v: 1,
    id,
    type: "story.validated",
    at: AT,
    actor: { kind: "human", device: "laptop-ada" },
    product: "demo",
    story: "2.2",
    provenance: "trusted",
    prev: null,
    ...fields,
  };
}

function hashOf(env) {
  const result = eventHash(env);
  if (!result.ok) throw new Error(`eventHash: ${JSON.stringify(result.error)}`);
  return result.hash;
}

/** Builds the vectors file, verifies each case, and returns its text. */
export async function buildVectors() {
  const ed25519 = await generateEd25519({ seed: ED25519_SEED });
  const credentials = {
    es256: { id: toBase64url(ES256_CREDENTIAL_ID), publicKey: es256CoseKey() },
    rs256: { id: toBase64url(RS256_CREDENTIAL_ID), publicKey: rs256CoseKey() },
  };
  /** The keys a case is verified with, as written in the file. */
  const keysFor = ({ ed25519: withEd25519 = true, webauthn = null, counter }) => ({
    ...(withEd25519 ? { ed25519PublicKey: ed25519.publicKey } : {}),
    ...(webauthn === null
      ? {}
      : {
          webauthnCredential: {
            ...credentials[webauthn],
            ...(counter === undefined ? {} : { counter }),
          },
        }),
  });

  const edPayload = await signEd25519(
    envelope(ULID.edPayload, {
      payload: { decision: "approved", note: "Ça marche." },
      alg: "ed25519",
    }),
    ed25519.secretKey,
  );
  // A real `payload_enc`, under the fixed product key of
  // test-vectors/product-key-v1.json and a nonce used by no other vector, bound to this envelope.
  const edEncryptedUnsigned = envelope(ULID.edEncrypted, {
    prev: hashOf(edPayload),
    alg: "ed25519",
    assurance: "locale",
  });
  const edEncrypted = await signEd25519(
    {
      ...edEncryptedUnsigned,
      payload_enc: await encryptPayloadWith(
        edEncryptedUnsigned,
        { decision: "approved", note: "Chiffré." },
        PRODUCT_KEY,
        { nonce: PAYLOAD_NONCE },
      ),
    },
    ed25519.secretKey,
  );
  const es256Unsigned = envelope(ULID.es256, {
    prev: hashOf(edEncrypted),
    type: "release.approved",
    payload: { release: "0.2.0", risk: "high" },
    alg: "webauthn-es256",
    assurance: "presence",
  });
  const es256Challenge = webauthnChallenge(es256Unsigned);
  const es256 = { ...es256Unsigned, sig: assert(es256Challenge) };
  const withAssertion = (options) => ({ ...es256Unsigned, sig: assert(es256Challenge, options) });

  const rs256Unsigned = envelope(ULID.rs256, {
    type: "release.approved",
    payload: { release: "0.3.0", risk: "high" },
    alg: "webauthn-rs256",
  });
  const rs256 = {
    ...rs256Unsigned,
    sig: assert(webauthnChallenge(rs256Unsigned), { alg: "rs256", counter: 7 }),
  };

  const contradictory = await signEd25519(
    envelope(ULID.assurance, {
      payload: { decision: "approved" },
      alg: "ed25519",
      assurance: "presence",
    }),
    ed25519.secretKey,
  );
  const agentEvent = await signEd25519(
    envelope(ULID.agent, {
      type: "story.status_changed",
      actor: { kind: "agent", device: "laptop-ada", agent: "iris" },
      provenance: "untrusted",
      payload: { status: "review" },
      alg: "ed25519",
    }),
    ed25519.secretKey,
  );
  const { assurance: _declared, ...humanWebauthn } = es256Unsigned;
  const agentWebauthnUnsigned = { ...humanWebauthn, actor: agentEvent.actor };
  const agentWebauthn = {
    ...agentWebauthnUnsigned,
    sig: assert(webauthnChallenge(agentWebauthnUnsigned)),
  };

  const ok = (assurance, newCounter) => ({
    ok: true,
    ...(assurance === undefined ? {} : { assurance }),
    ...(newCounter === undefined ? {} : { new_counter: newCounter }),
  });
  const ko = (code, reason_key) => ({ ok: false, code, reason_key });
  const signatureKo = (reason) => ko("SIGNATURE_INVALID", `reason.${reason}`);
  const ED = { ed25519: true };
  const ES = { ed25519: false, webauthn: "es256" };

  // [name, description, envelope, verified with, expected]
  const cases = [
    ["ed25519-payload", "Ed25519, clear payload.", edPayload, ED, ok("locale")],
    [
      "ed25519-payload-enc",
      "Ed25519, encrypted payload, chained to the previous case.",
      edEncrypted,
      ED,
      ok("locale"),
    ],
    [
      "webauthn-es256",
      "WebAuthn ES256 assertion with UV, challenge = SHA-256 of the signed bytes.",
      es256,
      ES,
      ok("presence", 1),
    ],
    [
      "webauthn-rs256",
      "WebAuthn RS256 (RSASSA-PKCS1-v1_5 with SHA-256) assertion with UV, counter 7.",
      rs256,
      { ed25519: false, webauthn: "rs256" },
      ok("presence", 7),
    ],
    [
      "ed25519-agent",
      "Ed25519 event of an agent: verified, with no assurance level (reserved to humans).",
      agentEvent,
      ED,
      ok(),
    ],
    [
      "ed25519-tampered-signature",
      "Last bit of the signature flipped.",
      { ...edPayload, sig: tamper(edPayload.sig) },
      ED,
      signatureKo("signature_mismatch"),
    ],
    [
      "ed25519-field-modified",
      "payload changed after signing.",
      { ...edPayload, payload: { decision: "rejected", note: "Ça marche." } },
      ED,
      signatureKo("signature_mismatch"),
    ],
    [
      "ed25519-assurance-mismatch",
      "assurance: presence declared on an Ed25519 signature.",
      contradictory,
      ED,
      signatureKo("assurance_mismatch"),
    ],
    [
      "ed25519-key-missing",
      "No Ed25519 public key given to the verifier.",
      edPayload,
      { ed25519: false },
      signatureKo("key_missing"),
    ],
    [
      "webauthn-es256-tampered-signature",
      "Last bit of the assertion signature flipped.",
      { ...es256, sig: { ...es256.sig, signature: tamper(es256.sig.signature) } },
      ES,
      signatureKo("signature_mismatch"),
    ],
    [
      "webauthn-es256-field-modified",
      "payload changed after signing: the challenge no longer matches.",
      { ...es256, payload: { release: "0.2.0", risk: "low" } },
      ES,
      signatureKo("challenge_mismatch"),
    ],
    [
      "webauthn-es256-wrong-challenge",
      "Assertion made over another challenge.",
      { ...es256Unsigned, sig: assert(sha256(utf8("another event"))) },
      ES,
      signatureKo("challenge_mismatch"),
    ],
    [
      "webauthn-es256-no-uv",
      "Assertion without the UV flag.",
      withAssertion({ flags: UP_ONLY }),
      ES,
      signatureKo("uv_missing"),
    ],
    [
      "webauthn-es256-wrong-origin",
      "Client data made for https://example.com.",
      withAssertion({ origin: "https://example.com" }),
      ES,
      signatureKo("client_data_mismatch"),
    ],
    [
      "webauthn-es256-wrong-rp",
      "Authenticator data made for the relying party example.com (rpIdHash).",
      withAssertion({ rpId: "example.com" }),
      ES,
      signatureKo("client_data_mismatch"),
    ],
    [
      "webauthn-es256-create-type",
      "Client data of a registration (webauthn.create), not an assertion.",
      withAssertion({ type: "webauthn.create" }),
      ES,
      signatureKo("client_data_mismatch"),
    ],
    [
      "webauthn-es256-counter-regression",
      "Assertion counter 1 while the credential has already seen 5.",
      es256,
      { ...ES, counter: 5 },
      signatureKo("counter_regression"),
    ],
    [
      "webauthn-es256-key-missing",
      "No WebAuthn credential given to the verifier.",
      es256,
      { ed25519: true },
      signatureKo("key_missing"),
    ],
    [
      "webauthn-es256-alg-mismatch",
      "ES256 event verified with the RS256 credential.",
      es256,
      { ed25519: false, webauthn: "rs256" },
      signatureKo("alg_mismatch"),
    ],
    [
      "webauthn-es256-agent",
      "WebAuthn assertion on an agent's event: presence is reserved to humans.",
      agentWebauthn,
      ES,
      signatureKo("webauthn_non_human"),
    ],
    [
      "event-invalid",
      "payload and payload_enc together.",
      { ...edPayload, payload_enc: edEncrypted.payload_enc },
      ED,
      ko("EVENT_INVALID", "reason.payload_exclusive"),
    ],
    [
      "upgrade-required",
      "Envelope version 15, beyond every version this engine knows (checkpoint.opened is at 14).",
      { ...edPayload, v: 15 },
      ED,
      { ok: false, code: "UPGRADE_REQUIRED" },
    ],
  ];

  const out = [];
  for (const [name, description, env, verifyWith, expected] of cases) {
    const result = await verifyEvent(env, keysFor(verifyWith));
    const actual = result.ok
      ? ok(result.assurance, result.newCounter)
      : {
          ok: false,
          code: result.error.code,
          ...(result.error.details.reason_key === undefined
            ? {}
            : { reason_key: result.error.details.reason_key }),
        };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `${name}: expected ${JSON.stringify(expected)}, verifyEvent gave ${JSON.stringify(actual)}`,
      );
    }
    out.push({
      name,
      description,
      envelope: env,
      verify_with: {
        ed25519_public_key: verifyWith.ed25519 ?? true,
        webauthn_credential: verifyWith.webauthn ?? null,
        ...(verifyWith.counter === undefined ? {} : { webauthn_counter: verifyWith.counter }),
      },
      signed_bytes_hex: toHex(signedBytes(env)),
      hash: hashOf(env),
      expected,
    });
  }

  const file = {
    format: "agentplugged.event-envelope.v1.test-vectors",
    notes: [
      "signed_bytes_hex: RFC 8785 canonical JSON of the envelope without sig, in hexadecimal.",
      "hash: sha256: then base64url SHA-256 of the canonical JSON of the whole envelope, sig included (the next event's prev).",
      "verify_with: the keys given to the verifier; webauthn_credential names one of keys.webauthn, with its stored counter (0 when absent).",
      "Keys are fixed test keys: never use them elsewhere.",
    ],
    keys: {
      ed25519: { seed_hex: toHex(ED25519_SEED), public_key: toBase64url(ed25519.publicKey) },
      webauthn: {
        rp_id: WEBAUTHN_RP_ID,
        origin: WEBAUTHN_ORIGIN,
        es256: {
          p256_private_scalar_hex: toHex(P256_SCALAR),
          credential: {
            id: credentials.es256.id,
            public_key: toBase64url(credentials.es256.publicKey),
          },
        },
        rs256: {
          private_key_jwk: "scripts/fixtures/rs256-test-key.jwk.json",
          credential: {
            id: credentials.rs256.id,
            public_key: toBase64url(credentials.rs256.publicKey),
          },
        },
      },
    },
    cases: out,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const text = await buildVectors();
  if (process.argv.includes("--check")) {
    if (readFileSync(VECTORS_FILE, "utf8") !== text) {
      console.error(`${VECTORS_FILE} differs from what the generator writes: run pnpm vectors.`);
      process.exit(1);
    }
    console.log(`${VECTORS_FILE} is up to date.`);
  } else {
    writeFileSync(VECTORS_FILE, text);
    console.log(`Wrote ${VECTORS_FILE}.`);
  }
}
