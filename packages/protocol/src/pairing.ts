import { z } from "zod";
import {
  DEVICE_ENC_ALG,
  DeviceEncKeySchema,
  DeviceSigKeySchema,
  TRUST_EVENT_HASH_PATTERN,
  TRUST_SIGNATURE_TAGS,
} from "./device-trust.js";
import { Ed25519SignatureSchema, isCanonicalBase64url } from "./event-envelope.js";
import { RelayIdSchema } from "./relay.js";

const PRODUCT_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * The messages of the pairing link. Generic on purpose
 *: schemas and codes only; the link's bytes and the boxes are in `packages/crypto`, the
 * machine's side in `apps/bridge`, the browser's in the web app.
 *
 * What goes through the relay's rendezvous is `PairWire` messages, encoded as JSON then base64url:
 * - `request` (browser to bridge): a box opened with the key drawn from the link's secret `s`
 *   (`link.request/v1` inside): the proof that the requester read the link;
 * - `envelope` (bridge to browser): a message from peer to peer encrypted for the
 *   browser's key and signed by the bridge: `link.welcome` then one `product.keys` per product;
 * - `refused` (bridge to browser): a code and nothing else; informative, not authenticated.
 *
 * A machine that joins with a short code does not hold a link's secret: both sides run a password
 * exchange first (`pake_*` messages), and the box key is drawn from the session key it gives. The
 * bridge then says who it is in `hello`; the machine answers with its `request`.
 */

/** Codes of the pairing, said by the bridge (separate from `ErrorCode`, like the relay's). */
export const PAIR_ERROR_CODES = {
  PAIRING_ALREADY_USED: "PAIRING_ALREADY_USED",
  PAIRING_EXPIRED: "PAIRING_EXPIRED",
  PAIRING_INVALID_PROOF: "PAIRING_INVALID_PROOF",
  PAIRING_KEY_MISMATCH: "PAIRING_KEY_MISMATCH",
  /** A machine joined from a folder whose product the bridge that gave the code does not serve. */
  PAIRING_PRODUCT_UNKNOWN: "PAIRING_PRODUCT_UNKNOWN",
  PAIRING_WRONG_ACCOUNT: "PAIRING_WRONG_ACCOUNT",
} as const;
export type PairErrorCode = (typeof PAIR_ERROR_CODES)[keyof typeof PAIR_ERROR_CODES];

/** The type labels of the messages (`t` of the signed ones, `type` of the boxes and messages). */
export const PAIR_MESSAGE_TYPES = {
  request: "link.request/v1",
  welcome: TRUST_SIGNATURE_TAGS.linkWelcome,
  productKeys: "product.keys/v1",
  hello: "pair.hello/v1",
} as const;

const key32 = z.string().length(43).refine(isCanonicalBase64url);
const key22 = z.string().length(22).refine(isCanonicalBase64url);
const label = z.string().min(1).max(40);

/** The devices that answer a pairing: a browser, a phone or another machine. */
export const REQUESTER_DEVICE_ID_PATTERN = /^(?:browser|phone|machine):[A-Za-z0-9_-]{16}$/;

/**
 * The short code of a machine pairing: an address of 8 symbols to meet at, then a password of 6.
 * The 32 symbols leave out I, L, O and U (nothing looks like anything else); the two parts are
 * drawn apart, so that the address tells the relay nothing about the password.
 */
export const PAIR_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIR_CODE_ID_SYMBOLS = 8;
export const PAIR_CODE_SECRET_SYMBOLS = 6;
export const PairCodeIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/);
export const PairCodeSecretSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{6}$/);

/** `pair.offer/v1` for a link or a QR: a linked device asks its bridge to open a rendezvous. */
export const PairLinkOfferOrderSchema = z.strictObject({
  t: z.literal(TRUST_SIGNATURE_TAGS.pairOffer),
  /** Which kind of device the link is for: another browser or a phone. */
  kind: z.enum(["link", "phone"]),
  /** The rendezvous identifier: 16 random bytes in base64url. */
  x: z.string().length(22).refine(isCanonicalBase64url),
  /** The link's secret: 16 random bytes in base64url. Travels inside the encrypted order only. */
  s: z.string().length(22).refine(isCanonicalBase64url),
});
export type PairLinkOfferOrder = z.infer<typeof PairLinkOfferOrderSchema>;

/** `pair.offer/v1` for another machine: the short code, drawn by the linked device. */
export const PairCodeOfferOrderSchema = z.strictObject({
  t: z.literal(TRUST_SIGNATURE_TAGS.pairOffer),
  kind: z.literal("machine"),
  /** The address to meet at (8 symbols). */
  x: PairCodeIdSchema,
  /** The password (6 symbols). Travels inside the encrypted order only. */
  w: PairCodeSecretSchema,
});
export type PairCodeOfferOrder = z.infer<typeof PairCodeOfferOrderSchema>;

/** `pair.offer/v1`: a linked device asks its bridge to open a rendezvous for one more device. */
export const PairOfferOrderSchema = z.union([PairLinkOfferOrderSchema, PairCodeOfferOrderSchema]);
export type PairOfferOrder = z.infer<typeof PairOfferOrderSchema>;

/** `link.request/v1`: what the browser sends, inside the box drawn from `s`. */
export const LinkRequestSchema = z
  .strictObject({
    t: z.literal(PAIR_MESSAGE_TYPES.request),
    /** The account of the requester, as the relay knows it. */
    account: RelayIdSchema,
    browser: z.strictObject({
      device: z.string().regex(REQUESTER_DEVICE_ID_PATTERN),
      sig: DeviceSigKeySchema,
      enc: DeviceEncKeySchema,
    }),
    /** « declared »: said by the requester, shown to the creator as such, never believed. */
    declared: z.strictObject({ type: label, os: label }),
    /**
     * The requester's signature recognising the creator's key as the root of the link (the root
     * the link carried): it ties that key to the account without any gesture. Optional: a requester
     * that does not sign it is linked all the same, only the key stays unattached.
     */
    root_certification: z
      .strictObject({ issued_at: z.iso.datetime(), sig: Ed25519SignatureSchema })
      .optional(),
    /**
     * Only a machine joining with a short code: the product it serves and the declaration it
     * signed to be attached to the relay (the bridge that holds the rendezvous vouches for it).
     */
    machine: z
      .strictObject({
        product: z.string().regex(PRODUCT_ID),
        relay_device: RelayIdSchema,
        attach_expires_at: z.number().int().positive(),
        attach_sig: Ed25519SignatureSchema,
      })
      .optional(),
  })
  .refine(
    (request) => request.browser.device.startsWith("machine:") === (request.machine !== undefined),
    { path: ["machine"], message: "a machine says what it serves, and only a machine does" },
  );
export type LinkRequest = z.infer<typeof LinkRequestSchema>;

/**
 * `link.welcome/v1`: signed by the bridge. The root and the bridge's keys the browser pins, the
 * heads of the registry (the hash of the browser's own `device.paired` in each journal served) and
 * the fingerprint of the request it acknowledges. The browser checks the signature against the
 * bridge key it read in the link's fragment, which the relay never saw, and refuses to consider
 * itself linked without it.
 */
export const LinkWelcomeSchema = z.strictObject({
  t: z.literal(PAIR_MESSAGE_TYPES.welcome),
  root: z.strictObject({
    device: z.string().regex(/^(machine|human):[A-Za-z0-9_-]{16}$/),
    key: key32,
  }),
  bridge: z.strictObject({
    device: z.string().regex(/^machine:[A-Za-z0-9_-]{16}$/),
    sig: DeviceSigKeySchema,
    enc: z.strictObject({ alg: z.literal(DEVICE_ENC_ALG), key: key32 }),
    /** The identifier the relay knows the bridge by: where the browser's messages to it go. */
    relay_device: z
      .string()
      .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
      .optional(),
  }),
  browser: z.string().regex(REQUESTER_DEVICE_ID_PATTERN),
  /** SHA-256 of the opened request, base64url. */
  request: key32,
  registry: z
    .array(
      z.strictObject({
        product: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
        head: z.string().regex(TRUST_EVENT_HASH_PATTERN),
        /** The root this machine pinned for that product (the views cross-check it). */
        root: z.strictObject({
          device: z.string().regex(/^(machine|human):[A-Za-z0-9_-]{16}$/),
          key: key32,
        }),
      }),
    )
    .max(64),
  sig: Ed25519SignatureSchema,
});
export type LinkWelcome = z.infer<typeof LinkWelcomeSchema>;

/** What the bridge signs in a welcome. */
export function linkWelcomeRecord(welcome: Omit<LinkWelcome, "sig">): Record<string, unknown> {
  return {
    t: welcome.t,
    root: welcome.root,
    bridge: welcome.bridge,
    browser: welcome.browser,
    request: welcome.request,
    registry: welcome.registry,
  };
}

/**
 * `pair.hello/v1`: what the bridge that holds a short code's rendezvous says about itself, once the
 * password exchange succeeded. It travels in a box the session key opens, so only whoever knew the
 * code reads it; the machine then checks every later message against the keys it names. `now` is
 * the bridge's clock in seconds: the machine dates its attachment with it, not with its own clock.
 */
export const PairHelloSchema = z.strictObject({
  t: z.literal(PAIR_MESSAGE_TYPES.hello),
  root: z.strictObject({
    device: z.string().regex(/^(machine|human):[A-Za-z0-9_-]{16}$/),
    key: key32,
  }),
  bridge: z.strictObject({
    device: z.string().regex(/^machine:[A-Za-z0-9_-]{16}$/),
    sig: DeviceSigKeySchema,
    enc: z.strictObject({ alg: z.literal(DEVICE_ENC_ALG), key: key32 }),
  }),
  /** The account of the bridge, which the machine joins. */
  account: RelayIdSchema,
  now: z.number().int().positive(),
});
export type PairHello = z.infer<typeof PairHelloSchema>;

/** `product.keys/v1`: the key of one product, sent once its `device.paired` is written and read back. */
export const ProductKeysSchema = z.strictObject({
  t: z.literal(PAIR_MESSAGE_TYPES.productKeys),
  product: z.string().regex(PRODUCT_ID),
  /** The identifier of the key (`apkeyid1`): the browser checks it against the journal's events. */
  key_id: z.string().min(1).max(64),
  key: key32,
  /**
   * The keys the product had before it was renewed, so that a device linked afterwards reads the
   * whole history. Each is checked against its own `key_id` by the receiver.
   */
  older: z
    .array(z.strictObject({ key_id: z.string().min(1).max(64), key: key32 }))
    .max(32)
    .optional(),
});
export type ProductKeys = z.infer<typeof ProductKeysSchema>;

/** A message of the rendezvous, before the relay carries it as opaque bytes. */
export const PairWireSchema = z.discriminatedUnion("k", [
  z.strictObject({
    k: z.literal("request"),
    nonce: z.string().min(1).max(64),
    ciphertext: z.string().min(1).max(65_536),
  }),
  z.strictObject({
    k: z.literal("envelope"),
    envelope: z.strictObject({
      v: z.number().int().positive(),
      to: z.string().min(1).max(100),
      from: z.string().min(1).max(100),
      id: RelayIdSchema,
      nonce: z.string().min(1).max(64),
      ciphertext: z.string().min(1).max(65_536),
    }),
  }),
  /** Short code, machine to bridge: the nonce and the first share of the password exchange. */
  z.strictObject({ k: z.literal("pake_init"), nonce: key22, share: key32 }),
  /** Short code, bridge to machine: its share. */
  z.strictObject({ k: z.literal("pake_reply"), share: key32 }),
  /** Short code: the proof that each side holds the session key, the machine first. */
  z.strictObject({ k: z.literal("pake_confirm"), mac: key32 }),
  z.strictObject({ k: z.literal("pake_confirm_b"), mac: key32 }),
  /** Short code, bridge to machine: `pair.hello/v1` in a box of the session key. */
  z.strictObject({
    k: z.literal("hello"),
    nonce: z.string().min(1).max(64),
    ciphertext: z.string().min(1).max(65_536),
  }),
  z.strictObject({
    k: z.literal("refused"),
    code: z.enum(Object.values(PAIR_ERROR_CODES) as [PairErrorCode, ...PairErrorCode[]]),
  }),
]);
export type PairWire = z.infer<typeof PairWireSchema>;
