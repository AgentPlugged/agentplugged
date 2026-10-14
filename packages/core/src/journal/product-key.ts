import {
  fromBase64url,
  generateProductKey,
  productKeyId,
  toBase64url,
  wipeBytes,
} from "@agentplugged/crypto";
import { ErrorCode, type EventEnvelope, isSensitiveEventType } from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { computeProjection } from "../projection/compute-projection.js";
import { isStored, type KeyStore, type MachineLock, settledRead } from "./key-store.js";
import type { EventDraft, JournalProblem } from "./state-store.js";

/**
 * The product key as core holds it while it works: its bytes, read from the
 * keychain, and its public `key_id`. The bytes are never written anywhere but the keychain:
 * never in the repository, the journal, a log, an agent's output or an error.
 */
export interface ProductKey {
  readonly key: Uint8Array;
  /** `pk:` then 16 base64url characters of the key's `apkeyid1` subkey. */
  readonly keyId: string;
}

/** The product key of `bytes`. */
export async function productKeyOf(bytes: Uint8Array): Promise<ProductKey> {
  return { key: bytes, keyId: await productKeyId(bytes) };
}

/** Wipes the bytes of product keys no longer needed (best effort). */
export async function forgetProductKey(
  ...keys: ReadonlyArray<ProductKey | undefined>
): Promise<void> {
  await wipeBytes(...keys.map((key) => key?.key));
}

/**
 * The keychain failed (`UNEXPECTED`, `error.keychain_unavailable`): reported as such, never as
 * "this machine does not hold the key". `reason` is the system's message, never a secret.
 */
export function keychainUnavailable(error: unknown): AgentPluggedError {
  if (error instanceof AgentPluggedError) return error;
  return new AgentPluggedError(ErrorCode.UNEXPECTED, "error.keychain_unavailable", {
    reason: error instanceof Error ? error.message : String(error),
  });
}

/**
 * The product key of `product` in the keychain, or undefined when this machine does not hold it.
 * A keychain failure gives `error.keychain_unavailable`; a stored value that is not a key gives
 * `UNEXPECTED` (without the value).
 */
export async function readProductKey(
  keys: KeyStore,
  product: string,
): Promise<ProductKey | undefined> {
  return readSettledProductKey(keys, product);
}

/**
 * The product key this machine holds, said absent only once re-reads confirm it (`settle`): for
 * the paths where an absence refuses the command or skips the backup of a key being replaced.
 */
export async function readHeldProductKey(
  keys: KeyStore,
  product: string,
): Promise<ProductKey | undefined> {
  return readSettledProductKey(keys, product, isStored);
}

/**
 * `readProductKey`, re-read while the stored value is not `accepted` (`settledRead`): a key's
 * absence confirmed before one is created, a key written read back.
 */
async function readSettledProductKey(
  keys: KeyStore,
  product: string,
  accepted?: (value: string | undefined) => boolean,
): Promise<ProductKey | undefined> {
  let stored: string | undefined;
  try {
    const read = () => keys.readProductSecret(product);
    stored = accepted === undefined ? await read() : await settledRead(keys, read, accepted);
  } catch (error) {
    throw keychainUnavailable(error);
  }
  if (stored === undefined) return undefined;
  const bytes = fromBase64url(stored);
  if (bytes === undefined || bytes.length !== 32) {
    throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
      reason: "the product key in the system keychain is not 32 bytes in base64url",
    });
  }
  return productKeyOf(bytes);
}

/**
 * The product key a write needs: read only when one of `drafts` is sensitive content (story
 * 2.13), for the drafts' product; undefined otherwise, or when this machine does not hold it
 * (`prepareAppend` then refuses a sensitive draft with `PRODUCT_KEY_MISSING`).
 */
export async function sensitiveProductKey(
  keys: KeyStore,
  drafts: readonly EventDraft[],
): Promise<ProductKey | undefined> {
  const sensitive = drafts.find(
    (draft) => draft.payload !== undefined && isSensitiveEventType(draft.type),
  );
  return sensitive === undefined ? undefined : readHeldProductKey(keys, sensitive.product);
}

/** The product key a projection decrypts with, or why the keychain could not give it. */
export type ProjectionKey =
  | { readonly key?: ProductKey; readonly keychainError?: undefined }
  | { readonly key?: undefined; readonly keychainError: string };

/**
 * The product key a projection decrypts with: from the keychain the surface gives (`keys`, else
 * the creator's), for `product`. No key without a keychain, a product or a stored key; a keychain
 * failure is returned as such (`keychainError`), for the command to report it.
 */
export async function projectionKey(
  access: { readonly keys?: KeyStore; readonly human?: { readonly keys: KeyStore } },
  product: string | null | undefined,
): Promise<ProjectionKey> {
  const keys = access.keys ?? access.human?.keys;
  if (keys === undefined || product === undefined || product === null) return {};
  try {
    const key = await readProductKey(keys, product);
    return key === undefined ? {} : { key };
  } catch (error) {
    return { keychainError: String(keychainUnavailable(error).details.reason ?? "") };
  }
}

/** Stores the product key of `product` in the keychain, and checks it was kept. */
export async function storeProductKey(
  keys: KeyStore,
  product: string,
  key: ProductKey,
): Promise<void> {
  const secret = toBase64url(key.key);
  try {
    await keys.writeProductSecret(product, secret);
  } catch (error) {
    throw keychainUnavailable(error);
  }
  // Read back, again while empty or not yet the value written: never said stored unread.
  const kept = await readSettledProductKey(keys, product, (value) => value === secret);
  if (kept?.keyId !== key.keyId) {
    throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.keychain_unavailable", {
      reason: "the system keychain did not keep the product key",
    });
  }
  await forgetProductKey(kept);
}

/** Keeps a product key being replaced, under `product:<product_id>:previous:<key_id>`. */
export async function backupProductKey(
  keys: KeyStore,
  product: string,
  key: ProductKey,
): Promise<void> {
  try {
    await keys.writeProductBackup(product, key.keyId, toBase64url(key.key));
  } catch (error) {
    throw keychainUnavailable(error);
  }
}

/**
 * The product key of `product`; created (32 random bytes) and stored when the keychain has none,
 * under `lock` (the machine-wide lock of key creation), the keychain being read again inside it.
 */
export async function createProductKey(
  keys: KeyStore,
  product: string,
  options: { lock?: MachineLock } = {},
): Promise<{ key: ProductKey; created: boolean }> {
  const lock: MachineLock = options.lock ?? ((task) => task());
  return lock(async () => {
    // Its absence confirmed by re-reads: an empty answer of a busy keychain never replaces a key.
    const existing = await readSettledProductKey(keys, product, isStored);
    if (existing !== undefined) return { key: existing, created: false };
    const key = await productKeyOf(generateProductKey());
    await storeProductKey(keys, product, key);
    return { key, created: true };
  });
}

/** The product key a journal announces: its `key_id`, and the event that announced it. */
export interface AnnouncedKey {
  readonly key_id: string;
  readonly id: string;
  readonly device: string;
  readonly at: string;
}

/**
 * The one rule of the announced product key, for the projection, `init`, `key import`,
 * `key export` and every encrypting write: the first valid `product.key_created` in projection
 * order (signed by a registered machine of this product, its chain intact). With `productKey`,
 * an announcement of that key whose proof does not verify is ignored (`key_proof_invalid`): only
 * a holder of the key can tell. Null when the journal announces none.
 */
export async function announcedKey(
  events: readonly EventEnvelope[],
  options: {
    readonly product?: string;
    readonly productKey?: ProductKey;
    readonly problems?: readonly JournalProblem[];
    readonly allowTestTypes?: boolean;
  } = {},
): Promise<AnnouncedKey | null> {
  const projection = await computeProjection(events, {
    ...(options.product === undefined ? {} : { product: options.product }),
    ...(options.productKey === undefined ? {} : { productKey: options.productKey }),
    ...(options.problems === undefined ? {} : { problems: options.problems }),
    allowTestTypes: options.allowTestTypes === true,
  });
  return (projection.state.product_key as AnnouncedKey | undefined) ?? null;
}

/**
 * `PRODUCT_KEY_MISSING`: this machine does not hold the product key, and sensitive content needs
 * it. `keyId`: the one the journal announces, when known.
 */
export function productKeyMissing(product: string, keyId?: string | null): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.PRODUCT_KEY_MISSING, "error.product_key_missing", {
    product,
    ...(keyId === undefined || keyId === null ? {} : { key_id: keyId }),
  });
}

/**
 * `PRODUCT_KEY_MISMATCH`: the key at hand (`heldKeyId`: held, or given to import) is not the one
 * the journal announces (`journalKeyId`).
 */
export function productKeyMismatch(journalKeyId: string, heldKeyId: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.PRODUCT_KEY_MISMATCH, "error.product_key_mismatch", {
    journal_key_id: journalKeyId,
    held_key_id: heldKeyId,
  });
}

/** Refuses to encrypt with `held` when the journal announces another key. */
export function checkAnnounced(announced: AnnouncedKey | null, held: ProductKey): void {
  if (announced !== null && announced.key_id !== held.keyId) {
    throw productKeyMismatch(announced.key_id, held.keyId);
  }
}
