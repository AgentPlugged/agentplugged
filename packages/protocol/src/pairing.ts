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
 */

/** Codes of the pairing, said by the bridge (separate from `ErrorCode`, like the relay's). */
export const PAIR_ERROR_CODES = {
  PAIRING_ALREADY_USED: "PAIRING_ALREADY_USED",
  PAIRING_EXPIRED: "PAIRING_EXPIRED",
  PAIRING_INVALID_PROOF: "PAIRING_INVALID_PROOF",
  PAIRING_KEY_MISMATCH: "PAIRING_KEY_MISMATCH",
  PAIRING_WRONG_ACCOUNT: "PAIRING_WRONG_ACCOUNT",
} as const;
export type PairErrorCode = (typeof PAIR_ERROR_CODES)[keyof typeof PAIR_ERROR_CODES];

/** The type labels of the messages (`t` of the signed ones, `type` of the boxes and messages). */
export const PAIR_MESSAGE_TYPES = {
  request: "link.request/v1",
  welcome: TRUST_SIGNATURE_TAGS.linkWelcome,
  productKeys: "product.keys/v1",
} as const;

const key32 = z.string().length(43).refine(isCanonicalBase64url);
const label = z.string().min(1).max(40);

/** `link.request/v1`: what the browser sends, inside the box drawn from `s`. */
export const LinkRequestSchema = z.strictObject({
  t: z.literal(PAIR_MESSAGE_TYPES.request),
  /** The account of the requester, as the relay knows it. */
  account: RelayIdSchema,
  browser: z.strictObject({
    device: z.string().regex(/^browser:[A-Za-z0-9_-]{16}$/),
    sig: DeviceSigKeySchema,
    enc: DeviceEncKeySchema,
  }),
  /** « declared »: said by the requester, shown to the creator as such, never believed. */
  declared: z.strictObject({ type: label, os: label }),
});
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
  }),
  browser: z.string().regex(/^browser:[A-Za-z0-9_-]{16}$/),
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

/** `product.keys/v1`: the key of one product, sent once its `device.paired` is written and read back. */
export const ProductKeysSchema = z.strictObject({
  t: z.literal(PAIR_MESSAGE_TYPES.productKeys),
  product: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  /** The identifier of the key (`apkeyid1`): the browser checks it against the journal's events. */
  key_id: z.string().min(1).max(64),
  key: key32,
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
  z.strictObject({
    k: z.literal("refused"),
    code: z.enum(Object.values(PAIR_ERROR_CODES) as [PairErrorCode, ...PairErrorCode[]]),
  }),
]);
export type PairWire = z.infer<typeof PairWireSchema>;
