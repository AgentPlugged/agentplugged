// Shared test vectors of the product key: packages/crypto/test-vectors/product-key-v1.json.
//
//   pnpm vectors         builds this package, then writes the file (with envelope-v1.json)
//   pnpm vectors:check   builds this package, then fails when the file differs (run by `test`)
//
// Deterministic: a fixed product key, a nonce of its own for each vector (none reused, here or in
// envelope-v1.json), a fixed salt and the minimum Argon2id limits (an export made with them is a
// test export only, refused by a real import). The fixed nonces and salt come from the test-only
// entry point `@agentplugged/crypto/testing`. Every case is decrypted again before the file is
// written.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decryptFile,
  decryptPayload,
  fileAssociatedData,
  importProductKey,
  payloadAssociatedData,
  productKeyId,
  productKeyProof,
  toHex,
  verifyProductKeyProof,
} from "@agentplugged/crypto";
import {
  encryptFileWith,
  encryptPayloadWith,
  exportProductKeyWith,
} from "@agentplugged/crypto/testing";

const here = dirname(fileURLToPath(import.meta.url));
export const PRODUCT_KEY_VECTORS_FILE = join(here, "../test-vectors/product-key-v1.json");

/** Fixed test values: never used outside these vectors. */
const KEY = Uint8Array.from({ length: 32 }, (_, index) => 0x40 + index);
const PAYLOAD_NONCE = Uint8Array.from({ length: 24 }, (_, index) => 0x80 + index);
const FILE_NONCE = Uint8Array.from({ length: 24 }, (_, index) => 0xa0 + index);
const EXPORT_NONCE = Uint8Array.from({ length: 24 }, (_, index) => 0xc0 + index);
const SALT = Uint8Array.from({ length: 16 }, (_, index) => 0xe0 + index);
const PASSPHRASE = "une phrase de passe de test";
const PRODUCT = "01K6KXJ5G0PR0DVCT00000000A";

/** Builds the vectors file, checks each case by decrypting it, and returns its text. */
export async function buildProductKeyVectors() {
  const envelope = {
    v: 1,
    id: "01K6KXJ5G0C0STREP0RTED0001",
    type: "cost.reported",
    at: "2026-10-04T08:00:00.000Z",
    actor: { kind: "agent", device: "machine:AAAAAAAAAAAAAAAA", agent: "iris" },
    product: PRODUCT,
    story: "2-13",
    provenance: "untrusted",
    prev: null,
    alg: "ed25519",
  };
  // Keys in code point order: the plaintext is the canonical JSON of the payload.
  const payload = { estimated: false, tokens_in: 1200, tokens_out: 340, usd: 0.42 };
  const payloadEnc = await encryptPayloadWith(envelope, payload, KEY, { nonce: PAYLOAD_NONCE });
  const decrypted = await decryptPayload({ ...envelope, payload_enc: payloadEnc, sig: "" }, KEY);
  if (!decrypted.ok || JSON.stringify(decrypted.payload) !== JSON.stringify(payload)) {
    throw new Error("payload: the vector does not decrypt");
  }

  const binding = { productId: PRODUCT, path: ".agentplugged/memory/leçons.md" };
  const content = "# Leçons\n\nToujours relire le plan avant de coder.\n";
  const file = await encryptFileWith(content, binding, KEY, { nonce: FILE_NONCE });
  const opened = await decryptFile(file, binding, KEY);
  if (!opened.ok || opened.content !== content)
    throw new Error("file: the vector does not decrypt");

  const proof = await productKeyProof(KEY, PRODUCT);
  if (!(await verifyProductKeyProof(KEY, PRODUCT, proof))) throw new Error("proof: not verified");

  const exported = await exportProductKeyWith(KEY, PRODUCT, PASSPHRASE, {
    limits: "min",
    salt: SALT,
    nonce: EXPORT_NONCE,
  });
  const imported = await importProductKey(exported, PASSPHRASE, { limits: "min" });
  if (!imported.ok || toHex(imported.key) !== toHex(KEY) || imported.productId !== PRODUCT) {
    throw new Error("export: the vector does not import");
  }

  const vectors = {
    format: "agentplugged.product-key.v1.test-vectors",
    notes: [
      "Subkeys: libsodium crypto_kdf_derive_from_key(32, 1, context, key), contexts apkeyid1 (key_id), approof1 (announcement proof), apevent1 (events), apfile01 (files). The key itself never encrypts anything.",
      "key_id: pk: then the first 16 base64url characters of the apkeyid1 subkey.",
      "proof: base64url of keyed BLAKE2b (crypto_generichash, 32 bytes, key = approof1 subkey) of 'agentplugged/key-proof/v1\\0' then the product id.",
      "XChaCha20-Poly1305 (IETF); nonce and ct in base64url, ct ending with the 16-byte tag.",
      "payload: key = apevent1 subkey; associated data = 'agentplugged/event/v1\\0' then the RFC 8785 canonical JSON of the envelope as written without payload_enc and sig (it has no payload); plaintext = canonical JSON of the payload.",
      "file: key = apfile01 subkey; first line agentplugged-enc:1:<key_id>, then base64url of nonce || ct; associated data = 'agentplugged/file/v1\\0' <product_id> '\\0' <workspace path in NFC>, in UTF-8.",
      "export: apk1: then base64url of version (1) || opslimit (u32 BE) || memlimit (u32 BE) || salt (16) || nonce (24) || key_id length (1) || key_id || product_id length (1) || product_id || ct; associated data = 'agentplugged/key-export/v1\\0' then everything before ct; key = Argon2id (crypto_pwhash, ALG_ARGON2ID13) of the NFC passphrase; a real import accepts only the MODERATE limits (these vectors use MIN).",
      "Each vector has its own nonce. These keys are fixed test keys: never use them elsewhere.",
    ],
    key: { hex: toHex(KEY), key_id: await productKeyId(KEY), product_id: PRODUCT, proof },
    payload: {
      envelope,
      payload,
      associated_data_hex: toHex(payloadAssociatedData(envelope)),
      payload_enc: payloadEnc,
    },
    file: {
      ...binding,
      content,
      associated_data_hex: toHex(fileAssociatedData(binding)),
      text: file,
    },
    export: { passphrase: PASSPHRASE, limits: "min", text: exported },
  };
  return `${JSON.stringify(vectors, null, 2)}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const text = await buildProductKeyVectors();
  if (process.argv.includes("--check")) {
    if (readFileSync(PRODUCT_KEY_VECTORS_FILE, "utf8") !== text) {
      console.error(
        `${PRODUCT_KEY_VECTORS_FILE} differs from what the generator writes: run pnpm vectors.`,
      );
      process.exit(1);
    }
    console.log(`${PRODUCT_KEY_VECTORS_FILE} is up to date.`);
  } else {
    writeFileSync(PRODUCT_KEY_VECTORS_FILE, text);
    console.log(`Wrote ${PRODUCT_KEY_VECTORS_FILE}.`);
  }
}
