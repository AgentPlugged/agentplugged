import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aeadDecrypt,
  aeadEncrypt,
  canonicalBytes,
  deriveSubkey,
  fromUtf8,
  generateEd25519,
  gitBlobId,
  openSealed,
  sha256Hex,
  signBytesEd25519,
  toHex,
  utf8,
  verifyEd25519,
  x25519,
  x25519PublicKey,
} from "./index.js";
import { sodiumSumo } from "./sodium.js";
import { sealToPublicKeyWith } from "./testing.js";

/**
 * The vectors of the trial 6.1 (`tooling/spikes/6-1/vectors/common-v1.json`), copied here as the
 * common test vectors of the product's primitives: the same file is replayed
 * on the phone and the browser, so that a primitive that drifts on one platform fails there.
 */

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(here, "../test-vectors/common-v1.json");
const SPIKE = join(here, "../../../tooling/spikes/6-1/vectors/common-v1.json");

const hex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

type Vectors = {
  format: string;
  ed25519: { name: string; seed: string; public_key: string; message: string; signature: string }[];
  ed25519_reject: { name: string; public_key: string; message: string; signature: string }[];
  x25519: {
    secret_a: string;
    public_a: string;
    secret_b: string;
    public_b: string;
    shared: string;
  }[];
  sealed_box: {
    recipient_sk: string;
    recipient_pk: string;
    cases: {
      name: string;
      message: string;
      ephemeral_sk: string;
      ephemeral_pk: string;
      sealed: string;
    }[];
  };
  aead: {
    name: string;
    key: string;
    nonce: string;
    ad: string;
    plaintext: string;
    ciphertext: string;
  }[];
  sha256: { name: string; message: string; digest: string }[];
  kdf: { key: string; id: number; context: string; length: number; subkey: string }[];
  git_blob: { name: string; content: string; sha1: string; sha256: string }[];
  canonical_json: { name: string; input_json: string; canonical?: string }[];
  argon2id: {
    name: string;
    passphrase: string;
    salt: string;
    opslimit: number;
    memlimit: number;
    length: number;
    output: string;
  }[];
  cross: { peer_sk: string; peer_pk: string; recipient_sk: string; recipient_pk: string };
};

const vectors = JSON.parse(readFileSync(VECTORS, "utf8")) as Vectors;

describe("common test vectors of the trial 6.1, replayed on Node", () => {
  it("is the file the trial left, when the trial is in the checkout", () => {
    expect(vectors.format).toBe("agentplugged.crypto.common-vectors.v1");
    if (existsSync(SPIKE)) expect(readFileSync(VECTORS, "utf8")).toBe(readFileSync(SPIKE, "utf8"));
  });

  it("Ed25519: the keys and signatures of RFC 8032 and of an event", async () => {
    for (const vector of vectors.ed25519) {
      const pair = await generateEd25519({ seed: hex(vector.seed) });
      expect(toHex(pair.publicKey), vector.name).toBe(vector.public_key);
      const signature = await signBytesEd25519(hex(vector.message), pair.secretKey);
      expect(toHex(signature), vector.name).toBe(vector.signature);
      expect(await verifyEd25519(hex(vector.message), signature, pair.publicKey)).toBe(true);
    }
  });

  it("Ed25519: refuses a signature with a non-canonical S, a small-order key, a truncated one", async () => {
    for (const vector of vectors.ed25519_reject) {
      const accepted = await verifyEd25519(
        hex(vector.message),
        hex(vector.signature),
        hex(vector.public_key),
      );
      expect(accepted, vector.name).toBe(false);
    }
  });

  it("X25519: RFC 7748 agreement from both sides, and the public keys", async () => {
    for (const vector of vectors.x25519) {
      expect(toHex(await x25519PublicKey(hex(vector.secret_a)))).toBe(vector.public_a);
      expect(toHex(await x25519PublicKey(hex(vector.secret_b)))).toBe(vector.public_b);
      const shared = await x25519(hex(vector.secret_a), hex(vector.public_b));
      expect(toHex(shared as Uint8Array)).toBe(vector.shared);
      expect(toHex((await x25519(hex(vector.secret_b), hex(vector.public_a))) as Uint8Array)).toBe(
        vector.shared,
      );
    }
  });

  it("X25519: refuses a key of low order", async () => {
    const zero = new Uint8Array(32);
    expect(await x25519(hex(vectors.x25519[0]?.secret_a ?? ""), zero)).toBeUndefined();
  });

  it("sealed box: opens each vector and rebuilds it from its fixed ephemeral key", async () => {
    const { recipient_pk: pk, recipient_sk: sk } = vectors.sealed_box;
    expect(toHex(await x25519PublicKey(hex(sk)))).toBe(pk);
    for (const vector of vectors.sealed_box.cases) {
      const opened = await openSealed(hex(vector.sealed), hex(pk), hex(sk));
      expect(toHex(opened as Uint8Array), vector.name).toBe(vector.message);
      const rebuilt = await sealToPublicKeyWith(
        hex(vector.message),
        hex(pk),
        hex(vector.ephemeral_sk),
      );
      expect(toHex(rebuilt), vector.name).toBe(vector.sealed);
      // A byte changed, or the wrong recipient: nothing opens.
      const altered = hex(vector.sealed);
      altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1;
      expect(await openSealed(altered, hex(pk), hex(sk))).toBeUndefined();
    }
  });

  it("XChaCha20-Poly1305: encrypts and decrypts each vector, and refuses an altered one", async () => {
    for (const vector of vectors.aead) {
      const key = hex(vector.key);
      const nonce = hex(vector.nonce);
      const ad = hex(vector.ad);
      const sealed = await aeadEncrypt(key, nonce, hex(vector.plaintext), ad);
      expect(toHex(sealed), vector.name).toBe(vector.ciphertext);
      const opened = await aeadDecrypt(key, nonce, hex(vector.ciphertext), ad);
      expect(toHex(opened as Uint8Array), vector.name).toBe(vector.plaintext);
      expect(
        await aeadDecrypt(key, nonce, hex(vector.ciphertext), utf8("other data")),
      ).toBeUndefined();
      const altered = hex(vector.ciphertext);
      altered[0] = (altered[0] ?? 0) ^ 1;
      expect(await aeadDecrypt(key, nonce, altered, ad), vector.name).toBeUndefined();
    }
  });

  it("SHA-256, key derivation, Git object ids, canonical JSON", async () => {
    for (const vector of vectors.sha256) {
      expect(sha256Hex(hex(vector.message)), vector.name).toBe(vector.digest);
    }
    for (const vector of vectors.kdf) {
      const derived = await deriveSubkey(hex(vector.key), vector.id, vector.context, vector.length);
      expect(toHex(derived), `${vector.context}/${vector.id}`).toBe(vector.subkey);
    }
    for (const vector of vectors.git_blob) {
      const content = utf8(vector.content);
      expect(gitBlobId(content, "sha1"), vector.name).toBe(vector.sha1);
      expect(gitBlobId(content, "sha256"), vector.name).toBe(vector.sha256);
    }
    for (const vector of vectors.canonical_json) {
      if (vector.canonical === undefined) continue;
      const bytes = canonicalBytes(JSON.parse(vector.input_json));
      expect(fromUtf8(bytes), vector.name).toBe(vector.canonical);
    }
  });

  it("Argon2id: the passphrase vectors", async () => {
    const lib = await sodiumSumo();
    for (const vector of vectors.argon2id) {
      const output = lib.crypto_pwhash(
        vector.length,
        vector.passphrase,
        hex(vector.salt),
        vector.opslimit,
        vector.memlimit,
        lib.crypto_pwhash_ALG_ARGON2ID13,
      );
      expect(toHex(output), vector.name).toBe(vector.output);
    }
  });

  it("cross-platform keys: the secret keys give the public ones", async () => {
    expect(toHex(await x25519PublicKey(hex(vectors.cross.peer_sk)))).toBe(vectors.cross.peer_pk);
    expect(toHex(await x25519PublicKey(hex(vectors.cross.recipient_sk)))).toBe(
      vectors.cross.recipient_pk,
    );
  });
});
