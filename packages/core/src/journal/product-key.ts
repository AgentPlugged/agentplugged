import {
  deriveBridgeEncryptionKey,
  fromBase64url,
  generateProductKey,
  openProductKeyBox,
  productKeyId,
  toBase64url,
  verifyProductKeyProof,
  verifyProductKeyRotationProof,
  wipeBytes,
} from "@agentplugged/crypto";
import {
  ErrorCode,
  type EventEnvelope,
  isSensitiveEventType,
  PRODUCT_KEY_EVENT_TYPES,
  type ProductKeyRotatedPayload,
  ProductKeyRotatedPayloadSchema,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { computeProjection } from "../projection/compute-projection.js";
import {
  isStored,
  type KeyStore,
  type MachineLock,
  readMachineKey,
  settledRead,
} from "./key-store.js";
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
  /**
   * Finds a key this machine kept from before a renewal, by its `key_id` (the keychain's
   * `product:<product_id>:previous:<key_id>`): what was written under it is still read. Absent on a
   * key built from bytes alone.
   */
  readonly older?: (keyId: string) => Promise<ProductKey | undefined>;
  /** Wipes the older keys `older` opened. */
  readonly release?: () => Promise<void>;
}

/** The product key of `bytes`. */
export async function productKeyOf(bytes: Uint8Array): Promise<ProductKey> {
  return { key: bytes, keyId: await productKeyId(bytes) };
}

/**
 * `key` itself, or the key of the same product that `keyId` names and this machine kept from
 * before a renewal; undefined when none is kept.
 */
export async function productKeyById(
  key: ProductKey,
  keyId: string,
): Promise<ProductKey | undefined> {
  if (key.keyId === keyId) return key;
  return key.older?.(keyId);
}

/**
 * `key` with the keys the keychain kept from before a renewal of `product` within reach: each
 * opened once, when asked for, and wiped with `forgetProductKey`.
 */
function withOlderKeys(key: ProductKey, keys: KeyStore, product: string): ProductKey {
  const read = keys.readProductBackup?.bind(keys);
  if (read === undefined) return key;
  const opened = new Map<string, ProductKey>();
  return {
    key: key.key,
    keyId: key.keyId,
    async older(keyId) {
      const known = opened.get(keyId);
      if (known !== undefined) return known;
      let stored: string | undefined;
      try {
        stored = await read(product, keyId);
      } catch (error) {
        throw keychainUnavailable(error);
      }
      const bytes = stored === undefined ? undefined : fromBase64url(stored);
      if (bytes === undefined || bytes.length !== 32) return undefined;
      const found = await productKeyOf(bytes);
      // A kept key is only ever served under the identifier it really has.
      if (found.keyId !== keyId) {
        await wipeBytes(bytes);
        return undefined;
      }
      opened.set(keyId, found);
      return found;
    },
    async release() {
      await wipeBytes(...[...opened.values()].map((older) => older.key));
      opened.clear();
    },
  };
}

/** Wipes the bytes of product keys no longer needed (best effort). */
export async function forgetProductKey(
  ...keys: ReadonlyArray<ProductKey | undefined>
): Promise<void> {
  await wipeBytes(...keys.map((key) => key?.key));
  for (const key of keys) await key?.release?.();
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
  return withOlderKeys(await productKeyOf(bytes), keys, product);
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
  journal?: AdoptionJournal,
): Promise<ProjectionKey> {
  const keys = access.keys ?? access.human?.keys;
  if (keys === undefined || product === undefined || product === null) return {};
  try {
    // A renewal this machine has not taken in yet is taken in first (a read of the journal that
    // finds the key renewed gets the new key, where the machine can open it).
    if (journal !== undefined) {
      await forgetProductKey(await adoptRotatedKey(keys, product, journal).catch(() => undefined));
    }
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

/**
 * The product key a journal announces now: its `key_id`, and the event that announced it. `history`
 * lists every key the product had, the first one first and the announced one last, each with the
 * event that announced it (`product.key_created`, then one `product.key_rotated` per renewal).
 */
export interface AnnouncedKey {
  readonly key_id: string;
  readonly id: string;
  readonly device: string;
  readonly at: string;
  readonly history: ReadonlyArray<{ readonly key_id: string; readonly id: string }>;
}

/**
 * The one rule of the announced product key, for the projection, `init`, `key import`,
 * `key export` and every encrypting write: the first valid `product.key_created` in projection
 * order (signed by a registered machine of this product, its chain intact), then each valid
 * `product.key_rotated` that follows the key announced at that point. With `productKey`, an
 * announcement of a key it holds (or kept) whose proof does not verify is ignored
 * (`key_proof_invalid`): only a holder of the key can tell. Null when the journal announces none.
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

/**
 * The key a write encrypts with: the one the journal announces, found among the keys this
 * machine holds (the current one, or one kept that a renewal has not yet made current here).
 * Another announced key than any held gives `PRODUCT_KEY_MISMATCH`, nothing written.
 */
export async function writingKey(
  announced: AnnouncedKey | null,
  held: ProductKey,
): Promise<ProductKey> {
  if (announced === null || announced.key_id === held.keyId) return held;
  const found = await held.older?.(announced.key_id);
  if (found === undefined) throw productKeyMismatch(announced.key_id, held.keyId);
  // The key written with still reads everything the held one does, and releases it too.
  return {
    key: found.key,
    keyId: found.keyId,
    older: async (keyId) => (keyId === held.keyId ? held : held.older?.(keyId)),
    release: async () => {
      await held.release?.();
      await forgetProductKey(held);
    },
  };
}

/** The journal a renewal is looked for in. */
export interface AdoptionJournal {
  readonly events: readonly EventEnvelope[];
  readonly problems?: readonly JournalProblem[];
  readonly allowTestTypes?: boolean;
}

/** True when the journal holds a renewal of the product key. */
export function hasRotation(events: readonly EventEnvelope[]): boolean {
  return events.some((event) => event.type === PRODUCT_KEY_EVENT_TYPES.keyRotated);
}

/**
 * The last key of the chain the events draw, read without checking a signature or a proof: the
 * first `product.key_created` by identifier, then each `product.key_rotated` that follows the key
 * reached so far, in identifier order. A shortcut for the common case; never an authority.
 */
function chainEnd(events: readonly EventEnvelope[]): string | undefined {
  const named = (event: EventEnvelope): Partial<ProductKeyRotatedPayload> =>
    (event.payload ?? {}) as Partial<ProductKeyRotatedPayload>;
  const ordered = events
    .filter(
      (event) =>
        event.type === PRODUCT_KEY_EVENT_TYPES.keyCreated ||
        event.type === PRODUCT_KEY_EVENT_TYPES.keyRotated,
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let end: string | undefined;
  for (const event of ordered) {
    const payload = named(event);
    if (event.type === PRODUCT_KEY_EVENT_TYPES.keyCreated) end ??= payload.key_id;
    else if (payload.previous_key_id === end) end = payload.key_id;
  }
  return end;
}

/**
 * Takes in a renewal of the product key this machine has not yet: when the journal announces a
 * key other than the one held, the machine makes it current if it already keeps it (a renewal it
 * wrote itself, cut short), else opens the box the renewal sealed for its own key, one renewal
 * after the other if it missed several. Each key taken in is checked against the `key_id` and the
 * proof the journal announces, and the key it replaces is kept (`product:<id>:previous:<key_id>`).
 * Nothing is done for a journal without renewal, a machine without key, or a renewal made while
 * this machine was not trusted: those keys come by `key import` or by the pairing. Returns the key
 * now held as current, or undefined when none is.
 */
export async function adoptRotatedKey(
  keys: KeyStore,
  product: string,
  journal: AdoptionJournal,
): Promise<ProductKey | undefined> {
  if (!hasRotation(journal.events)) return undefined;
  let held = await readHeldProductKey(keys, product);
  // The usual case, cheap to see: the key held is the end of the chain the events draw. (The full
  // rule, with the proofs, runs only when it is not, or when the events are not what they seem.)
  if (held !== undefined && held.keyId === chainEnd(journal.events)) return held;
  try {
    const announced = await announcedKey(journal.events, {
      product,
      ...(held === undefined ? {} : { productKey: held }),
      ...(journal.problems === undefined ? {} : { problems: journal.problems }),
      allowTestTypes: journal.allowTestTypes === true,
    });
    if (announced === null || held?.keyId === announced.key_id) return held;
    // The renewal the machine wrote itself, cut short before the keychain made it current.
    const kept = held === undefined ? undefined : await held.older?.(announced.key_id);
    if (held !== undefined && kept !== undefined) {
      await backupProductKey(keys, product, held);
      await storeProductKey(keys, product, kept);
      return await readHeldProductKey(keys, product);
    }
    const machine = await readMachineKey(keys);
    if (machine === undefined) return held;
    const enc = await deriveBridgeEncryptionKey(machine.secretKey.slice(0, 32));
    try {
      const at = announced.history.findIndex((step) => step.key_id === held?.keyId);
      // A machine that holds no key of this product opens the latest box only; one that holds an
      // earlier key follows the renewals after it, in order.
      const steps = at >= 0 ? announced.history.slice(at + 1) : announced.history.slice(-1);
      for (const step of steps) {
        const event = journal.events.find((candidate) => candidate.id === step.id);
        const parsed = ProductKeyRotatedPayloadSchema.safeParse(event?.payload);
        const box = parsed.success ? parsed.data.boxes[machine.device] : undefined;
        if (!parsed.success || box === undefined) break;
        const bytes = await openProductKeyBox(box, product, enc);
        if (bytes === undefined) break;
        const opened = await productKeyOf(bytes);
        // Each step must follow the key now held and carry that key's proof: a writer who never
        // had it cannot slip its own key into the chain between two renewals.
        const follows =
          held === undefined ||
          (parsed.data.previous_key_id === held.keyId &&
            (await verifyProductKeyRotationProof(
              held.key,
              product,
              parsed.data.key_id,
              parsed.data.chain_proof,
            )));
        if (
          !follows ||
          opened.keyId !== step.key_id ||
          !(await verifyProductKeyProof(opened.key, product, parsed.data.proof))
        ) {
          await forgetProductKey(opened);
          break;
        }
        if (held !== undefined) await backupProductKey(keys, product, held);
        await storeProductKey(keys, product, opened);
        await forgetProductKey(held, opened);
        held = await readHeldProductKey(keys, product);
        if (held === undefined) break;
      }
      return held;
    } finally {
      await wipeBytes(enc.secretKey);
    }
  } catch (error) {
    await forgetProductKey(held);
    throw error;
  }
}
