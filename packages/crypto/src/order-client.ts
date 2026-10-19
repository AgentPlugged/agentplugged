import {
  deviceRevokedRecord,
  ORDER_ALG,
  ORDER_MESSAGE_TYPE,
  ORDER_RECEIPT_MESSAGE_TYPE,
  type Order,
  type OrderReceipt,
  OrderReceiptSchema,
  orderTag,
  pairOfferRecord,
  TRUST_SIGNATURE_TAGS,
  type UnsignedOrder,
} from "@agentplugged/protocol";
import type { X25519Agreement } from "./browser-keys.js";
import { fromBase64url, toBase64url } from "./encoding.js";
import { orderSigningBytes, verifyOrderReceipt } from "./order-signature.js";
import { offerRecipientKey } from "./pairing-offer.js";
import { encryptPeerMessage, openPeerMessage, type PeerEnvelope } from "./peer-message.js";
import { trustRecordBytes } from "./trust-signature.js";

/**
 * The creator's device side of an order: building it, signing it with the device's own key (which a
 * browser cannot read, hence a `sign` callback), encrypting it for the bridge's key the device
 * pinned when it was linked, and tracking what comes back. An order is never "sent" on the word of
 * the relay: it is applied or rejected when the bridge's signed receipt says so, and "unconfirmed"
 * when none came in time.
 */

/** The device that gives orders: its identifier and what signs with its key. */
export interface OrderSigner {
  readonly device: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export interface OrderDraft {
  /** The order type, `pair.offer`… */
  readonly type: string;
  readonly version?: number;
  /** The bridge the order is for. */
  readonly bridge: string;
  readonly product: string;
  readonly target?: string | null;
  readonly basis?: string | null;
  readonly params: Record<string, unknown>;
}

export interface OrderTiming {
  /** Milliseconds since the epoch, on the device's clock. */
  readonly now: number;
  /** How long the order stays valid. */
  readonly lifetimeMs: number;
}

/**
 * The device's counter of orders: one number per order, strictly increasing, and recorded durably
 * BEFORE the order is signed, so that a crash never makes a device sign two orders with one number.
 */
export interface OrderCounter {
  next(): Promise<number>;
}

/** An order, ready to send: signed by the device, valid for `lifetimeMs`. */
export async function createOrder(
  draft: OrderDraft,
  signer: OrderSigner,
  counter: OrderCounter,
  timing: OrderTiming,
  newId: () => string,
): Promise<Order> {
  const unsigned: UnsignedOrder = {
    t: orderTag(draft.type, draft.version ?? 1),
    id: newId(),
    device: signer.device,
    bridge: draft.bridge,
    product: draft.product,
    target: draft.target ?? null,
    basis: draft.basis ?? null,
    seq: await counter.next(),
    issued_at: new Date(timing.now).toISOString(),
    expires_at: new Date(timing.now + timing.lifetimeMs).toISOString(),
    params: draft.params,
    alg: ORDER_ALG,
  };
  const signature = await signer.sign(orderSigningBytes(unsigned));
  return { ...unsigned, sig: toBase64url(signature) };
}

/**
 * The parameters of a `pair.offer` for a link or a QR code: the device signs the offer before the
 * new device exists, and the bridge writes `device.paired` on that signature.
 */
export async function pairOfferParams(
  input: {
    readonly kind: "link" | "phone";
    readonly bridge: string;
    readonly x: Uint8Array;
    readonly s: Uint8Array;
    readonly expiresAt: Date;
  },
  signer: OrderSigner,
): Promise<{
  kind: "link" | "phone";
  x: string;
  s: string;
  expires_at: string;
  offer_sig: string;
}> {
  const x = toBase64url(input.x);
  const expiresAt = input.expiresAt.toISOString();
  const offerSig = await signPairOffer(
    { kind: input.kind === "phone" ? "phone" : "browser", bridge: input.bridge, x, expiresAt },
    signer,
  );
  return {
    kind: input.kind,
    x,
    s: toBase64url(input.s),
    expires_at: expiresAt,
    offer_sig: offerSig,
  };
}

/**
 * The parameters of a `pair.offer` for another machine: the short code (its address and its
 * password), and the device's signature of the offer, which names the address only.
 */
export async function pairCodeOfferParams(
  input: {
    readonly bridge: string;
    readonly code: { readonly id: string; readonly secret: string };
    readonly expiresAt: Date;
  },
  signer: OrderSigner,
): Promise<{
  kind: "machine";
  x: string;
  w: string;
  expires_at: string;
  offer_sig: string;
}> {
  const expiresAt = input.expiresAt.toISOString();
  return {
    kind: "machine",
    x: input.code.id,
    w: input.code.secret,
    expires_at: expiresAt,
    offer_sig: await signPairOffer(
      { kind: "machine", bridge: input.bridge, x: input.code.id, expiresAt },
      signer,
    ),
  };
}

/**
 * The parameters of a `device.revoke`: the device signs the authorization of the removal itself
 * (the record `device.revoked` rests on), because the journal must prove who removed what. The
 * author of the record is this device. `heads` gives, for each product whose journal holds a
 * removed machine's chain, the last event of it that this device saw; the removal for any other
 * product has no head (a phone or a browser has none anywhere).
 */
export async function revokeDeviceParams(
  input: {
    readonly device: string;
    readonly heads?: Readonly<Record<string, string>>;
    readonly issuedAt: Date;
  },
  signer: OrderSigner,
): Promise<{
  device: string;
  issued_at: string;
  authorizations: Record<string, { chain_head: string | null; sig: string }>;
}> {
  const issuedAt = input.issuedAt.toISOString();
  const authorize = async (chainHead: string | null) => ({
    chain_head: chainHead,
    sig: toBase64url(
      await signer.sign(
        trustRecordBytes(
          deviceRevokedRecord({
            device: input.device,
            chain_head: chainHead,
            issued_at: issuedAt,
            author: signer.device,
          }),
          TRUST_SIGNATURE_TAGS.deviceRevoked,
        ),
      ),
    ),
  });
  const authorizations: Record<string, { chain_head: string | null; sig: string }> = {
    "*": await authorize(null),
  };
  for (const [product, head] of Object.entries(input.heads ?? {})) {
    authorizations[product] = await authorize(head);
  }
  return { device: input.device, issued_at: issuedAt, authorizations };
}

async function signPairOffer(
  offer: {
    readonly kind: "phone" | "browser" | "machine";
    readonly bridge: string;
    readonly x: string;
    readonly expiresAt: string;
  },
  signer: OrderSigner,
): Promise<string> {
  const record = pairOfferRecord({
    kind: offer.kind,
    bridge: offer.bridge,
    order: { x: offer.x, expires_at: offer.expiresAt },
  });
  return toBase64url(await signer.sign(trustRecordBytes(record, TRUST_SIGNATURE_TAGS.pairOffer)));
}

/** The bridge as the device pinned it when it was linked. */
export interface PinnedBridge {
  readonly device: string;
  readonly sigKey: Uint8Array;
  readonly encKey: Uint8Array;
}

/** Where an order goes and how: the relay labels, the bridge's pinned keys, and the sender's own. */
export interface OrderTransport {
  readonly bridge: PinnedBridge;
  /** The bridge's label at the relay (`to`) and the device's own (`from`). */
  readonly bridgeRoute: string;
  readonly deviceRoute: string;
  /** The key the relay's directory advertises for the bridge, when it does (it is never believed). */
  readonly advertisedEncKey?: Uint8Array | undefined;
  readonly messageId: string;
  /** The device's counter of messages to this bridge (not the orders' counter). */
  readonly messageSeq: number;
}

/**
 * The order, encrypted for the bridge's pinned key and signed inside by the device. Undefined when
 * the relay advertises another key for the bridge: nothing is sent, because the relay is trying to
 * read the order.
 */
export async function sealOrder(
  order: Order,
  signer: OrderSigner,
  transport: OrderTransport,
): Promise<PeerEnvelope | undefined> {
  const recipient = await offerRecipientKey(transport.bridge.encKey, transport.advertisedEncKey);
  if (recipient === undefined) return undefined;
  return await encryptPeerMessage({
    to: transport.bridgeRoute,
    from: transport.deviceRoute,
    id: transport.messageId,
    sender: signer.device,
    senderSigner: (bytes) => signer.sign(bytes),
    recipientEncKey: recipient,
    seq: transport.messageSeq,
    type: ORDER_MESSAGE_TYPE,
    body: order,
  });
}

/** What the device knows of an order it gave. */
export type OrderStatus =
  /** Handed to the connection: that is all that is known. Never shown as sent. */
  | { readonly state: "waiting"; readonly since: number }
  | { readonly state: "applied"; readonly receipt: OrderReceipt }
  | { readonly state: "rejected"; readonly code: string; readonly receipt: OrderReceipt }
  /** No receipt came in time: the creator may give the order again. */
  | { readonly state: "unconfirmed"; readonly since: number };

/**
 * The orders a device gave and what became of them. A receipt counts only when it is signed by the
 * bridge's pinned key, is for this device and names an order the device gave.
 */
export class OrderLedger {
  readonly #orders = new Map<string, { order: Order; status: OrderStatus }>();

  constructor(
    private readonly options: {
      readonly device: string;
      readonly bridge: PinnedBridge;
      /** How long to wait for a receipt before the order is "unconfirmed". */
      readonly confirmationMs: number;
    },
  ) {}

  /** Records an order as given (waiting for its receipt). */
  given(order: Order, now: number): void {
    this.#orders.set(order.id, { order, status: { state: "waiting", since: now } });
  }

  status(id: string): OrderStatus | undefined {
    return this.#orders.get(id)?.status;
  }

  /** Marks "unconfirmed" the orders that waited too long; returns their identifiers. */
  expire(now: number): string[] {
    const late: string[] = [];
    for (const [id, entry] of this.#orders) {
      if (
        entry.status.state === "waiting" &&
        now - entry.status.since >= this.options.confirmationMs
      ) {
        entry.status = { state: "unconfirmed", since: now };
        late.push(id);
      }
    }
    return late;
  }

  /**
   * Takes a message from the relay: when it is a receipt the bridge signed for one of this
   * device's orders, the order's status changes. Anything else is ignored. The first receipt wins.
   */
  async receive(
    envelope: PeerEnvelope,
    recipient: { readonly secretKey?: Uint8Array; readonly agreement?: X25519Agreement },
  ): Promise<OrderReceipt | undefined> {
    const opened = await openPeerMessage(envelope, {
      ...(recipient.secretKey === undefined ? {} : { recipientSecretKey: recipient.secretKey }),
      ...(recipient.agreement === undefined ? {} : { recipientAgreement: recipient.agreement }),
      registry: (sender) =>
        sender === this.options.bridge.device
          ? { signingKey: this.options.bridge.sigKey, routingId: envelope.from }
          : undefined,
    });
    if (!opened.ok || opened.type !== ORDER_RECEIPT_MESSAGE_TYPE) return undefined;
    const parsed = OrderReceiptSchema.safeParse(opened.body);
    if (!parsed.success) return undefined;
    const receipt = parsed.data;
    if (receipt.device !== this.options.device || receipt.bridge !== this.options.bridge.device) {
      return undefined;
    }
    if (!(await verifyOrderReceipt(receipt, this.options.bridge.sigKey))) return undefined;
    const entry = this.#orders.get(receipt.order);
    if (entry === undefined || entry.order.product !== receipt.product) return undefined;
    if (entry.status.state === "applied" || entry.status.state === "rejected") return undefined;
    entry.status =
      receipt.outcome === "applied"
        ? { state: "applied", receipt }
        : { state: "rejected", code: receipt.code ?? "UNKNOWN", receipt };
    return receipt;
  }
}

/** Reads a bridge's pinned keys from their text (base64url), or undefined when malformed. */
export function pinnedBridge(input: {
  device: string;
  sigKey: string;
  encKey: string;
}): PinnedBridge | undefined {
  const sigKey = fromBase64url(input.sigKey);
  const encKey = fromBase64url(input.encKey);
  if (sigKey?.length !== 32 || encKey?.length !== 32) return undefined;
  return { device: input.device, sigKey, encKey };
}
