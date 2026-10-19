import {
  fromBase64url,
  generateProductKey,
  productKeyProof,
  productKeyRotationProof,
  sealProductKeyFor,
} from "@agentplugged/crypto";
import {
  ErrorCode,
  MAX_KEY_BOXES,
  PRODUCT_KEY_EVENT_TYPES,
  type ProductKeyRotatedPayload,
  type RootPin,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { readDeviceTrust } from "../trust-devices/pairing-events.js";
import type { KeyStore, MachineLock } from "./key-store.js";
import {
  adoptRotatedKey,
  announcedKey,
  backupProductKey,
  checkAnnounced,
  forgetProductKey,
  type ProductKey,
  productKeyMismatch,
  productKeyMissing,
  productKeyOf,
  readHeldProductKey,
  storeProductKey,
} from "./product-key.js";
import type { StateStore } from "./state-store.js";

/** What a renewal of the product key did. */
export interface RotationResult {
  /** The key now announced. */
  readonly key_id: string;
  /** The key it follows, kept on this machine to read what was written under it. */
  readonly previous_key_id: string;
  /** The trusted machines the new key was sealed for (this one included). */
  readonly machines: readonly string[];
  /** True when the renewal of this order had been made already: nothing was done again. */
  readonly already?: true;
}

/** A renewal of the key another machine (or process) made first. */
class AlreadyRenewed extends Error {
  constructor(readonly keyId: string) {
    super("the product key was renewed meanwhile");
  }
}

/**
 * Renews the key of `product`: a new key is drawn, sealed (never in clear) for each trusted
 * machine of the product's journal, announced by a signed `product.key_rotated`, and made the key
 * this machine writes with. The old key is kept: everything written before stays readable, and the
 * journal is never rewritten. Nothing is written when the machine does not hold the key the
 * journal announces, or when another renewal was made first (`PRODUCT_KEY_MISMATCH`).
 *
 * The order of the steps makes a cut harmless: the new key is first kept in the keychain beside
 * the old one, then announced, and only then made current; a machine that finds the journal
 * announcing a key it already keeps makes it current (`adoptRotatedKey`).
 */
export async function rotateProductKey(input: {
  readonly keys: KeyStore;
  readonly journal: StateStore;
  readonly product: string;
  /** The root this machine pinned for the product, when it has pinned one. */
  readonly pin?: RootPin | undefined;
  /** The machine-wide lock of key changes. */
  readonly lock?: MachineLock | undefined;
  /** The signed order that asked for it: a renewal already made for it is not made again. */
  readonly order?: string | undefined;
  readonly allowTestTypes?: boolean;
}): Promise<RotationResult> {
  const { keys, journal, product } = input;
  const lock: MachineLock = input.lock ?? ((task) => task());
  return lock(async () => {
    const listing = await journal.list();
    if (input.order !== undefined) {
      const done = listing.events.find(
        (event) =>
          event.type === PRODUCT_KEY_EVENT_TYPES.keyRotated &&
          (event.payload as ProductKeyRotatedPayload | undefined)?.order === input.order,
      );
      if (done !== undefined) {
        const payload = done.payload as ProductKeyRotatedPayload;
        // Taken in on this machine too, should the cut have come between the journal and the keychain.
        await forgetProductKey(
          await adoptRotatedKey(keys, product, {
            events: listing.events,
            problems: listing.problems,
            allowTestTypes: input.allowTestTypes === true,
          }),
        );
        return {
          key_id: payload.key_id,
          previous_key_id: payload.previous_key_id,
          machines: Object.keys(payload.boxes),
          already: true,
        };
      }
    }
    // A renewal made elsewhere is taken in first: it is renewed from the key the journal announces.
    await forgetProductKey(
      await adoptRotatedKey(keys, product, {
        events: listing.events,
        problems: listing.problems,
        allowTestTypes: input.allowTestTypes === true,
      }),
    );
    let held: ProductKey | undefined;
    let fresh: ProductKey | undefined;
    try {
      held = await readHeldProductKey(keys, product);
      if (held === undefined) throw productKeyMissing(product);
      const options = {
        product,
        problems: listing.problems,
        allowTestTypes: input.allowTestTypes === true,
      };
      const announced = await announcedKey(listing.events, { ...options, productKey: held });
      if (announced === null) {
        throw new AgentPluggedError(
          ErrorCode.PRODUCT_KEY_MISSING,
          "error.product_key_not_announced",
          {
            product,
          },
        );
      }
      checkAnnounced(announced, held);

      const { view } = await readDeviceTrust(journal, product, input.pin);
      // While the root of trust is in doubt, nothing is sealed for anyone.
      if (view?.blocked === true) {
        throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
          reason: "the root of trust changed: the key is not renewed until it is settled",
        });
      }
      const recipients = (view?.devices ?? [])
        .filter(
          (device) => device.kind === "machine" && device.enc_key !== null && !device.provisional,
        )
        .slice(0, MAX_KEY_BOXES);
      fresh = await productKeyOf(generateProductKey());
      const boxes: Record<string, string> = {};
      for (const machine of recipients) {
        const encKey = fromBase64url(machine.enc_key ?? "");
        if (encKey === undefined || encKey.length !== 32) continue;
        boxes[machine.device] = await sealProductKeyFor(fresh.key, product, encKey);
      }
      const payload: ProductKeyRotatedPayload = {
        key_id: fresh.keyId,
        previous_key_id: held.keyId,
        proof: await productKeyProof(fresh.key, product),
        chain_proof: await productKeyRotationProof(held.key, product, fresh.keyId),
        ...(input.order === undefined ? {} : { order: input.order }),
        boxes,
      };

      // Kept before it is announced, and the old one too: a cut never loses either.
      await backupProductKey(keys, product, fresh);
      await backupProductKey(keys, product, held);
      try {
        await journal.appendAll(
          [
            {
              type: PRODUCT_KEY_EVENT_TYPES.keyRotated,
              actor: { kind: "system" },
              product,
              provenance: "trusted",
              payload,
            },
          ],
          {
            // Renewed once from a given key: another machine may have done it, after a sync.
            precondition: async (current) => {
              const other = await announcedKey(current.events, {
                ...options,
                problems: current.problems,
                productKey: held as ProductKey,
              });
              if (other !== null && other.key_id !== (held as ProductKey).keyId) {
                throw new AlreadyRenewed(other.key_id);
              }
            },
          },
        );
      } catch (error) {
        if (error instanceof AlreadyRenewed) {
          throw productKeyMismatch(error.keyId, (held as ProductKey).keyId);
        }
        throw error;
      }
      await storeProductKey(keys, product, fresh);
      return {
        key_id: fresh.keyId,
        previous_key_id: held.keyId,
        machines: Object.keys(boxes),
      };
    } finally {
      await forgetProductKey(held, fresh);
    }
  });
}
