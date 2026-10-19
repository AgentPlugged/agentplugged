import {
  type PairCodeOfferOrder,
  type PairLinkOfferOrder,
  TRUST_SIGNATURE_TAGS,
} from "@agentplugged/protocol";
import { toBase64url } from "./encoding.js";
import { randomBytes } from "./hash.js";
import {
  PAIR_ID_BYTES,
  PAIR_SECRET_BYTES,
  type PairLink,
  type PairLinkKind,
  type PairRootKind,
  pairLinkUrl,
} from "./pairing.js";
import { formatPairCode, type PairCode, randomPairCode } from "./pairing-code.js";
import { constantTimeEqual } from "./primitives.js";

/**
 * The offer of a linked device that wants to link one more: it draws the rendezvous `x` and the
 * secret `s`, sends them to its bridge in the order `pair.offer`, and shows the link (as a QR for a
 * phone, as text for another browser). Everything the link holds is public data the device has
 * pinned already, plus `s`: no private key, no product key.
 */

export interface PairOfferInput {
  readonly kind: PairLinkKind;
  /** The bridge's signing key, as the device pinned it when it was linked. */
  readonly bridgeSigKey: Uint8Array;
  /** The root the device pinned when it was linked. */
  readonly root: { readonly kind: PairRootKind; readonly key: Uint8Array };
  /** The address of the web app (`https://…`): where a link opens. */
  readonly appUrl: string;
}

export interface PairOffer {
  readonly link: PairLink;
  /** The text a QR holds and a « copy the link » button copies. */
  readonly url: string;
  /** The order to send to the bridge (inside the encrypted, signed order channel). */
  readonly order: PairLinkOfferOrder;
}

/** A fresh offer: random `x` and `s`, drawn here and nowhere else. */
export function createPairOffer(
  input: PairOfferInput,
  random: (bytes: number) => Uint8Array = randomBytes,
): PairOffer {
  const x = Uint8Array.from(random(PAIR_ID_BYTES));
  const s = Uint8Array.from(random(PAIR_SECRET_BYTES));
  const link: PairLink = {
    kind: input.kind,
    x,
    s,
    bridgeSigKey: input.bridgeSigKey,
    root: input.root,
  };
  return {
    link,
    url: pairLinkUrl(input.appUrl, link),
    order: {
      t: TRUST_SIGNATURE_TAGS.pairOffer,
      kind: input.kind,
      x: toBase64url(x),
      s: toBase64url(s),
    },
  };
}

/**
 * The key an offer is encrypted for: the one the device pinned at the link, never the one the relay's
 * directory advertises. When the directory shows another key, nothing must be sent: the relay is
 * trying to read the order. Returns the key to use, or undefined when nothing may be sent.
 */
export async function offerRecipientKey(
  pinned: Uint8Array,
  advertised: Uint8Array | undefined,
): Promise<Uint8Array | undefined> {
  if (advertised === undefined) return pinned;
  return (await constantTimeEqual(pinned, advertised)) ? pinned : undefined;
}

/** An offer for another machine: the short code the linked device shows, and the order that carries it. */
export interface CodeOffer {
  readonly code: PairCode;
  /** `R3T9-HJ2P-K7M-4QX`: what the person copies onto the other machine. */
  readonly display: string;
  /** The order to send to the bridge (inside the encrypted, signed order channel). */
  readonly order: PairCodeOfferOrder;
}

/** A fresh code for another machine: address and password from two separate draws, here and nowhere else. */
export function createCodeOffer(random?: (bytes: number) => Uint8Array): CodeOffer {
  const code = randomPairCode(random);
  return {
    code,
    display: formatPairCode(code),
    order: { t: TRUST_SIGNATURE_TAGS.pairOffer, kind: "machine", x: code.id, w: code.secret },
  };
}
