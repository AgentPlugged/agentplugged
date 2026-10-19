import {
  SECRET_NAME_PATTERN,
  SECRET_VALUE_MAX_BYTES,
  SECRET_VALUE_MAX_CHARS,
} from "@agentplugged/protocol";
import { fromBase64url, fromUtf8, toBase64url, utf8 } from "./encoding.js";
import { offerRecipientKey } from "./pairing-offer.js";
import { openSealed, sealToPublicKey, wipe } from "./primitives.js";

/**
 * A secret the creator types in a browser, sealed for one machine: a sealed box (libsodium
 * `crypto_box_seal`) of `{ v, name, value }` for the machine's long-term encryption key. Only that
 * machine opens it; the relay, the journal and any other device see bytes. The name is inside the
 * box so that a box made for one name cannot be passed off as another's.
 *
 * The key to seal for is the one the product's journal registers for the machine (verified against
 * the pinned root), never one the relay advertises: when the relay's directory shows another key,
 * nothing is sealed, because the relay is trying to read the secret.
 */

const SECRET_BOX_VERSION = 1;

/** Why a secret was not sealed. */
export class SecretNotSealed extends Error {
  constructor(readonly reason: "name" | "value" | "key") {
    super(`the secret was not sealed (${reason})`);
    this.name = "SecretNotSealed";
  }
}

/**
 * The secret sealed for `machineEncKey`, as base64url text. Throws `SecretNotSealed` when the name
 * or the value is not acceptable, or when the relay advertises another key for the machine.
 */
export async function sealSecret(
  secret: { readonly name: string; readonly value: string },
  machineEncKey: Uint8Array,
  advertisedEncKey?: Uint8Array,
): Promise<string> {
  if (!SECRET_NAME_PATTERN.test(secret.name)) throw new SecretNotSealed("name");
  if (
    secret.value === "" ||
    secret.value.length > SECRET_VALUE_MAX_CHARS ||
    utf8(secret.value).length > SECRET_VALUE_MAX_BYTES
  ) {
    throw new SecretNotSealed("value");
  }
  const recipient = await offerRecipientKey(machineEncKey, advertisedEncKey);
  if (recipient === undefined) throw new SecretNotSealed("key");
  const plain = utf8(
    JSON.stringify({ v: SECRET_BOX_VERSION, name: secret.name, value: secret.value }),
  );
  try {
    return toBase64url(await sealToPublicKey(plain, recipient));
  } finally {
    await wipe(plain);
  }
}

/**
 * The value of a sealed secret for `name`, or undefined when the box does not open with this
 * machine's key pair, is not well formed, or was made for another name.
 */
export async function openSecret(
  sealed: string,
  name: string,
  keys: { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array },
): Promise<string | undefined> {
  const box = fromBase64url(sealed);
  if (box === undefined) return undefined;
  const plain = await openSealed(box, keys.publicKey, keys.secretKey);
  if (plain === undefined) return undefined;
  try {
    const text = fromUtf8(plain);
    if (text === undefined) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { v, name: inside, value } = parsed as Record<string, unknown>;
    if (v !== SECRET_BOX_VERSION || inside !== name || typeof value !== "string") return undefined;
    if (value === "" || value.length > SECRET_VALUE_MAX_CHARS) return undefined;
    if (utf8(value).length > SECRET_VALUE_MAX_BYTES) return undefined;
    return value;
  } catch {
    return undefined;
  } finally {
    await wipe(plain);
  }
}
