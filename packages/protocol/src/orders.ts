import { z } from "zod";
import {
  AutonomyHintParamsSchema,
  ORDER_TYPE_AUTONOMY_HINT,
  ORDER_TYPE_SET_AUTONOMY,
  ORDER_TYPE_SET_RULE,
  SetAutonomyParamsSchema,
  SetRuleParamsSchema,
} from "./autonomy.js";
import {
  ChainControlParamsSchema,
  ChainInstructParamsSchema,
  ChainPauseParamsSchema,
  ChainResumeParamsSchema,
  ChainSayParamsSchema,
  ChainStartParamsSchema,
  NoahSayParamsSchema,
  ORDER_TYPE_CHAIN_INSTRUCT,
  ORDER_TYPE_CHAIN_PAUSE,
  ORDER_TYPE_CHAIN_RESUME,
  ORDER_TYPE_CHAIN_SAY,
  ORDER_TYPE_CHAIN_START,
  ORDER_TYPE_CHAIN_STOP,
  ORDER_TYPE_NOAH_SAY,
} from "./chain.js";
import {
  AnswerCheckpointParamsSchema,
  ORDER_TYPE_ANSWER_CHECKPOINT,
  ORDER_TYPE_UNDO_CHECKPOINT_ANSWER,
  UndoCheckpointAnswerParamsSchema,
} from "./checkpoint-web.js";
import {
  BRIDGE_ID_PATTERN,
  DEVICE_ID_PATTERN,
  DEVICE_SIG_ALG,
  PAIRED_DEVICE_ID_PATTERN,
  TRUST_EVENT_HASH_PATTERN,
} from "./device-trust.js";
import { ErrorCode } from "./error-payload.js";
import {
  Ed25519SignatureSchema,
  isCanonicalBase64url,
  jsonValueIssue,
  ULID_PATTERN,
  UlidSchema,
} from "./event-envelope.js";
import {
  LinkForgeParamsSchema,
  ORDER_TYPE_FORGE_LINK,
  ORDER_TYPE_FORGE_UNLINK,
  UnlinkForgeParamsSchema,
} from "./forge-link.js";
import { MACHINE_ROLE_MAX } from "./machines.js";
import {
  CreateProductParamsSchema,
  OpenProductFolderParamsSchema,
  ORDER_TYPE_CREATE_PRODUCT,
  ORDER_TYPE_OPEN_PRODUCT_FOLDER,
  ORDER_TYPE_SET_PRODUCT_PROFILE,
  ORDER_TYPE_SET_PRODUCT_STATE,
  SetProductProfileParamsSchema,
  SetProductStateParamsSchema,
} from "./product-lifecycle.js";

/**
 * Signed orders: every command sent to a machine is signed by the device of the creator that gives
 * it, and the bridge that receives it checks it with the key its journal registers for that
 * device, never with a key the relay supplied. An order is one JSON object; the signature covers
 * its canonical form (RFC 8785) without the signature itself, `t` included. `t` names the order
 * type and its version (`order.pair.offer/v1`), so that a signature made for an order is never
 * taken for an authorization, a message or an event, and conversely.
 *
 * Adding an order type means declaring its parameters, its target and its risk level in an
 * `OrderTypeRegistry`; no check below changes.
 */

/** Event type the bridge writes once an order is applied: it keeps the signed order. */
export const ORDER_EVENT_TYPES = {
  applied: "order.applied",
  /** A signed order the bridge refused: the journal keeps who gave it and why it was refused. */
  rejected: "order.rejected",
} as const;

/** Orders are signed with Ed25519 only. */
export const ORDER_ALG = DEVICE_SIG_ALG;

/** The label of the receipt a bridge signs for an order. */
export const ORDER_RECEIPT_TAG = "order.receipt/v1";

/** The message type that carries an order (and the one that carries its receipt). */
export const ORDER_MESSAGE_TYPE = "order";
export const ORDER_RECEIPT_MESSAGE_TYPE = "order.receipt";

/** The longest an order may be valid (issued to expired) and how far ahead of the bridge's clock it may be dated. */
export const ORDER_DEFAULT_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const ORDER_DEFAULT_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

/** `order.` then a dotted type in lowercase, `/v` and the version: `order.pair.offer/v1`. */
const ORDER_TYPE_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const ORDER_TAG = /^order\.([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\/v([1-9][0-9]{0,2})$/;

/** The label of an order of `type` at `version`. */
export function orderTag(type: string, version = 1): string {
  return `order.${type}/v${version}`;
}

/** The type and the version an order label names, or undefined when it is no order label. */
export function parseOrderTag(tag: unknown): { type: string; version: number } | undefined {
  if (typeof tag !== "string") return undefined;
  const match = ORDER_TAG.exec(tag);
  if (match === null) return undefined;
  return { type: match[1] as string, version: Number(match[2]) };
}

/**
 * How much an order can hurt, as its type declares it. The bridge asks the device for nothing more
 * whatever the level (one gesture per validation); a creator who chooses a stricter mode reads it.
 */
export const ORDER_RISK_LEVELS = ["low", "medium", "high"] as const;
export type OrderRisk = (typeof ORDER_RISK_LEVELS)[number];

/** The codes a bridge answers an order with, in the order the bridge applies its checks. */
export const ORDER_ERROR_CODES = {
  INVALID_ORDER: "INVALID_ORDER",
  UPGRADE_REQUIRED: ErrorCode.UPGRADE_REQUIRED,
  UNKNOWN_DEVICE: "UNKNOWN_DEVICE",
  SIGNATURE_INVALID: ErrorCode.SIGNATURE_INVALID,
  SECURITY_ROOT_CHANGED: ErrorCode.SECURITY_ROOT_CHANGED,
  DEVICE_REVOKED: "DEVICE_REVOKED",
  WRONG_BRIDGE: "WRONG_BRIDGE",
  ORDER_EXPIRED: "ORDER_EXPIRED",
  ORDER_REPLAYED: "ORDER_REPLAYED",
  NOT_OWNER: "NOT_OWNER",
  STALE_BASIS: "STALE_BASIS",
  /** Two orders on the same target: the first one applied wins, the second gets this. */
  ALREADY_RESOLVED: "ALREADY_RESOLVED",
} as const;
export type OrderErrorCode = (typeof ORDER_ERROR_CODES)[keyof typeof ORDER_ERROR_CODES];

/** The checks in the order the bridge applies them: the first failing one is the code returned. */
export const ORDER_CHECK_SEQUENCE: readonly OrderErrorCode[] = [
  ORDER_ERROR_CODES.INVALID_ORDER,
  ORDER_ERROR_CODES.UPGRADE_REQUIRED,
  ORDER_ERROR_CODES.UNKNOWN_DEVICE,
  ORDER_ERROR_CODES.SIGNATURE_INVALID,
  ORDER_ERROR_CODES.SECURITY_ROOT_CHANGED,
  ORDER_ERROR_CODES.DEVICE_REVOKED,
  ORDER_ERROR_CODES.WRONG_BRIDGE,
  ORDER_ERROR_CODES.ORDER_EXPIRED,
  ORDER_ERROR_CODES.ORDER_REPLAYED,
  ORDER_ERROR_CODES.NOT_OWNER,
  ORDER_ERROR_CODES.STALE_BASIS,
  ORDER_ERROR_CODES.ALREADY_RESOLVED,
];

/**
 * The code the emitting device sees. An unknown device and a wrong signature give the same one, so
 * that nobody learns from an answer whether a device exists; the bridge's own log keeps the real one.
 */
export function externalOrderCode(code: string): string {
  return code === ORDER_ERROR_CODES.UNKNOWN_DEVICE ? ORDER_ERROR_CODES.SIGNATURE_INVALID : code;
}

/** The key of the user text for a rejected order (`orders.rejected.<code>` in the user-interface catalogs). */
export function orderRejectionMessageKey(code: string): string {
  return `orders.rejected.${externalOrderCode(code).toLowerCase()}`;
}

/** `sha256:` then the digest in base64url: the fingerprint of what the creator saw. */
export const ORDER_BASIS_PATTERN = TRUST_EVENT_HASH_PATTERN;

/** A document an order's basis covers. */
export const DocumentRefSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  branch: z.string().min(1).max(255),
  blob_sha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
});
export type DocumentRef = z.infer<typeof DocumentRefSchema>;

const utcDatetime = z.iso.datetime();

/**
 * An order, as it travels. `params` is checked again by the schema of its type (a registry
 * declares it); here it is only a JSON object.
 */
export const OrderSchema = z
  .strictObject({
    /** `order.<type>/v<version>`. */
    t: z.string().regex(ORDER_TAG),
    id: UlidSchema,
    /** The device of the creator that signs the order. */
    device: z.string().regex(DEVICE_ID_PATTERN),
    /** The bridge the order is for. */
    bridge: z.string().regex(BRIDGE_ID_PATTERN),
    product: UlidSchema,
    /** The story the order is about, or null. */
    target: z.string().min(1).max(120).nullable(),
    /** The fingerprint of the state and documents the creator saw, or null. */
    basis: z.string().regex(ORDER_BASIS_PATTERN).nullable(),
    /** The device's own counter: strictly increasing, one per order the device signs. */
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    issued_at: utcDatetime,
    expires_at: utcDatetime,
    params: z.record(z.string(), z.unknown()),
    alg: z.literal(ORDER_ALG),
    sig: Ed25519SignatureSchema,
  })
  .refine((order) => Date.parse(order.expires_at) > Date.parse(order.issued_at), {
    path: ["expires_at"],
    message: "an order expires after it is issued",
  })
  .refine((order) => jsonValueIssue(order.params) === undefined, {
    path: ["params"],
    message: "params are JSON",
  });
export type Order = z.infer<typeof OrderSchema>;
export type UnsignedOrder = Omit<Order, "sig">;

/** What a bridge says of an order it applied or rejected, signed with its machine key. */
export const OrderReceiptSchema = z
  .strictObject({
    t: z.literal(ORDER_RECEIPT_TAG),
    order: UlidSchema,
    /** The device that gave the order: the receipt is for it only. */
    device: z.string().regex(DEVICE_ID_PATTERN),
    bridge: z.string().regex(BRIDGE_ID_PATTERN),
    product: UlidSchema,
    outcome: z.enum(["applied", "rejected"]),
    /** The code the emitting device sees (never `UNKNOWN_DEVICE`); present when rejected. */
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/)
      .optional(),
    /**
     * A simple handle on what an applied order made (never its content): for a secret, the
     * reference under which the machine keeps it.
     */
    reference: z.string().min(1).max(128).optional(),
    at: utcDatetime,
    alg: z.literal(ORDER_ALG),
    sig: Ed25519SignatureSchema,
  })
  .refine((receipt) => (receipt.outcome === "rejected") === (receipt.code !== undefined), {
    path: ["code"],
    message: "a rejected receipt names its code, an applied one has none",
  })
  .refine((receipt) => receipt.reference === undefined || receipt.outcome === "applied", {
    path: ["reference"],
    message: "only an applied receipt carries a reference",
  })
  .refine((receipt) => receipt.code !== ORDER_ERROR_CODES.UNKNOWN_DEVICE, {
    path: ["code"],
    message: "the external code never tells that a device is unknown",
  });
export type OrderReceipt = z.infer<typeof OrderReceiptSchema>;
export type UnsignedOrderReceipt = Omit<OrderReceipt, "sig">;

/** Where an order was given from, as the bridge knows it from the device's kind in its registry. */
export const ORDER_SOURCES = ["web", "mobile", "machine"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/** `payload` of `order.applied` v1: the signed order, kept so that anyone can check it without the bridge. */
export const OrderAppliedPayloadSchema = z.strictObject({
  order: OrderSchema,
  /** The emitting device (the order's own `device`). */
  device: z.string().regex(DEVICE_ID_PATTERN),
  /** Fixed by the way in (the kind of device in the registry), never read from the order. */
  source: z.enum(ORDER_SOURCES),
  applied_at: utcDatetime,
});
export type OrderAppliedPayload = z.infer<typeof OrderAppliedPayloadSchema>;

/**
 * `payload` of `order.rejected` v1: an order whose signature checked out and that the bridge did
 * not apply, with the code the creator sees (never `UNKNOWN_DEVICE`). It carries no `params`: a
 * refusal is a fact, not a second copy of the order.
 */
export const OrderRejectedPayloadSchema = z.strictObject({
  order: UlidSchema,
  /** `order.<type>/v<version>`. */
  t: z.string().regex(ORDER_TAG),
  device: z.string().regex(DEVICE_ID_PATTERN),
  code: z.string().regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/),
  source: z.enum(ORDER_SOURCES),
  rejected_at: utcDatetime,
});
export type OrderRejectedPayload = z.infer<typeof OrderRejectedPayloadSchema>;

/**
 * Where an order goes. `story`: it names a story and goes to the bridge that owns it. `primary`: it
 * names none and goes to the product's main bridge (the only bridge when none was chosen).
 * `bridge`: it names none and goes to the bridge it names, whether main or not (the order that
 * makes a bridge the main one).
 */
export type OrderTargetKind = "story" | "primary" | "bridge";

/** The declaration of an order type: parameters, target and risk. */
export interface OrderTypeDeclaration {
  /** `pair.offer`, `bridge.set_primary`… */
  readonly type: string;
  readonly version: number;
  /** The parameters, checked strictly. */
  readonly params: z.ZodType;
  readonly risk: OrderRisk;
  readonly target: OrderTargetKind;
  /**
   * True when two orders on the same target are exclusive (the second one gets
   * `ALREADY_RESOLVED`): a decision on a checkpoint.
   */
  readonly exclusive?: boolean;
  /** True when the order must carry the fingerprint of what the creator saw (`basis` not null). */
  readonly requiresBasis?: boolean;
  /**
   * Parameters that hold sealed content (a secret encrypted for the machine). The machine keeps the
   * order without them once it is applied (in its registry and in the journal): only a digest
   * stays, so that the fact of the order is kept and its content is not.
   */
  readonly sealedParams?: readonly string[];
}

/** The order types a bridge knows. A registry is a value: a test adds its own type to a copy. */
export class OrderTypeRegistry {
  readonly #types = new Map<string, OrderTypeDeclaration>();

  constructor(declarations: readonly OrderTypeDeclaration[] = []) {
    for (const declaration of declarations) this.declare(declaration);
  }

  declare(declaration: OrderTypeDeclaration): this {
    if (!ORDER_TYPE_NAME.test(declaration.type)) throw new RangeError("invalid order type name");
    const key = orderTag(declaration.type, declaration.version);
    if (this.#types.has(key)) throw new RangeError(`order type ${key} is declared twice`);
    this.#types.set(key, declaration);
    return this;
  }

  /** The declaration of the type and version an order label names, or undefined. */
  get(tag: string): OrderTypeDeclaration | undefined {
    return this.#types.get(tag);
  }

  /** Every declared label, sorted. */
  tags(): string[] {
    return [...this.#types.keys()].sort();
  }

  /** A copy that also knows `declarations`. */
  extended(...declarations: readonly OrderTypeDeclaration[]): OrderTypeRegistry {
    const copy = new OrderTypeRegistry();
    for (const [, declaration] of this.#types) copy.declare(declaration);
    for (const declaration of declarations) copy.declare(declaration);
    return copy;
  }
}

/**
 * A link or a QR code for one more browser or phone: the rendezvous and the secret the device drew,
 * and the device's own signature of the authorization the bridge will write `device.paired` on
 * (`offer_sig`, over the `pair.offer` record of the kind of device, this bridge, `x` and `expires_at`).
 */
export const PairOfferLinkParamsSchema = z.strictObject({
  kind: z.enum(["link", "phone"]),
  x: z.string().length(22).refine(isCanonicalBase64url),
  s: z.string().length(22).refine(isCanonicalBase64url),
  expires_at: utcDatetime,
  offer_sig: Ed25519SignatureSchema,
});
/** The short code of another machine: an address of 8 symbols and a password of 6. */
export const PairOfferCodeParamsSchema = z.strictObject({
  kind: z.literal("machine"),
  x: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/),
  w: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{6}$/),
  expires_at: utcDatetime,
  offer_sig: Ed25519SignatureSchema,
});
export const PairOfferParamsSchema = z.union([
  PairOfferLinkParamsSchema,
  PairOfferCodeParamsSchema,
]);
export type PairOfferParams = z.infer<typeof PairOfferParamsSchema>;

/**
 * The creator chooses the main bridge of a product: the order is for the machine that becomes main
 * (`bridge`), and carries the head of each writer's chain the creator's device saw. The new main
 * bridge refuses the change while it lacks one of them.
 */
export const SetPrimaryParamsSchema = z.strictObject({
  heads: z
    .record(z.string().regex(BRIDGE_ID_PATTERN), z.string().regex(TRUST_EVENT_HASH_PATTERN))
    .refine((heads) => Object.keys(heads).length <= 64, { message: "at most 64 writers" }),
});
export type SetPrimaryParams = z.infer<typeof SetPrimaryParamsSchema>;

/** The creator gives a machine a free role (an empty text clears it). The order is for that machine. */
export const SetRoleParamsSchema = z.strictObject({ role: z.string().max(MACHINE_ROLE_MAX) });
export type SetRoleParams = z.infer<typeof SetRoleParamsSchema>;

/**
 * The creator renews the key of a product (after removing a machine). The order is for the
 * machine that applies it, and names the product through the order's own `product`: it has no
 * parameter, and nothing in it is a key.
 */
export const RotateProductKeyParamsSchema = z.strictObject({});
export type RotateProductKeyParams = z.infer<typeof RotateProductKeyParamsSchema>;

/** The kinds of connection a secret belongs to, and the shape of its name (`forge.github`, `data.crm`). */
export const SECRET_NAME_PATTERN = /^(?:forge|data)\.[a-z0-9][a-z0-9._-]{0,63}$/;
/**
 * The longest secret a creator can enter (a token, a connection string, the JSON file of a service
 * account), in characters and in UTF-8 bytes. The machine splits a long one over several entries
 * of its keychain, so the limit is the same on every system.
 */
export const SECRET_VALUE_MAX_CHARS = 65_536;
export const SECRET_VALUE_MAX_BYTES = 65_536;
/** The longest sealed box of a secret, as text: the secret in UTF-8 (4 bytes a character), its envelope and the box's own. */
const SEALED_SECRET_MAX_CHARS = Math.ceil(((SECRET_VALUE_MAX_BYTES + 160) * 4) / 3) + 80;

/**
 * The creator gives a machine a secret (a token of a code platform, the login of a data source).
 * `sealed` is the secret encrypted in the browser for the machine's own encryption key (a sealed
 * box): it never travels, nor is it kept anywhere, in the clear. The order is for that machine,
 * which opens the box, keeps the secret in its system keychain and answers with a reference.
 */
export const SetSecretParamsSchema = z.strictObject({
  name: z.string().regex(SECRET_NAME_PATTERN),
  sealed: z
    .string()
    .min(1)
    .max(SEALED_SECRET_MAX_CHARS)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export type SetSecretParams = z.infer<typeof SetSecretParamsSchema>;

/** The most products one priority order ranks, and the highest rank a product can take. */
export const PRIORITY_PRODUCTS_MAX = 64;
export const PRIORITY_RANK_MAX = 9999;

/**
 * The creator's order of priority among their products, for the products a machine serves: each
 * product's rank, 1 first. A product that is not in the order has no rank and comes after the
 * ranked ones. The machine keeps the ranks and publishes them in its beat, so that every device of
 * the creator reads the same order.
 */
export const SetPriorityParamsSchema = z.strictObject({
  ranks: z
    .record(UlidSchema, z.int().min(1).max(PRIORITY_RANK_MAX))
    .refine((all) => Object.keys(all).length <= PRIORITY_PRODUCTS_MAX, {
      message: "at most 64 products",
    }),
});
export type SetPriorityParams = z.infer<typeof SetPriorityParamsSchema>;

/** The reference a machine answers with for a secret it keeps: it names the secret, never its value. */
export function secretReference(name: string): string {
  return `secret:${name}`;
}

/**
 * The creator removes a device (a phone, a browser or a machine, possibly the one that gives the
 * order). The device signs the `device.revoked` authorization the bridge will write on its
 * authority (over the record of the removed device, the head of its chain, the date and the
 * author, which is the device that gives the order), so that the journal proves who removed what
 * without the bridge's word. `chain_head` is the last event of a removed machine's chain the author
 * saw in a product's journal (each journal has its own chain), null for a phone or a browser.
 * `authorizations` holds one signature per product the author saw the machine in, and `*` for any
 * other product (always with a null head). The order is for the bridge that applies it, which
 * writes the removal in every product it serves.
 */
export const RevocationAuthorizationSchema = z.strictObject({
  chain_head: z.string().regex(TRUST_EVENT_HASH_PATTERN).nullable(),
  sig: Ed25519SignatureSchema,
});
export type RevocationAuthorization = z.infer<typeof RevocationAuthorizationSchema>;

/** The key of an authorization that holds for every product without one of its own. */
export const REVOCATION_ANY_PRODUCT = "*";

export const RevokeDeviceParamsSchema = z.strictObject({
  device: z.string().regex(PAIRED_DEVICE_ID_PATTERN),
  issued_at: utcDatetime,
  authorizations: z
    .record(
      z.string().refine((key) => key === REVOCATION_ANY_PRODUCT || ULID_PATTERN.test(key), {
        message: "a product identifier or *",
      }),
      RevocationAuthorizationSchema,
    )
    .refine(
      (all) => REVOCATION_ANY_PRODUCT in all && all[REVOCATION_ANY_PRODUCT]?.chain_head === null,
      {
        message: "the authorization for any product has no chain head",
      },
    )
    .refine((all) => Object.keys(all).length <= 65, { message: "at most 64 products" }),
});
export type RevokeDeviceParams = z.infer<typeof RevokeDeviceParamsSchema>;

/** The order types of the engine itself. The epics that add commands declare theirs beside these. */
export const ORDER_TYPE_PAIR_OFFER = "pair.offer";
export const ORDER_TYPE_REVOKE_DEVICE = "device.revoke";
export const ORDER_TYPE_SET_PRIMARY = "bridge.set_primary";
export const ORDER_TYPE_SET_ROLE = "machine.set_role";
export const ORDER_TYPE_SET_PRIORITY = "portfolio.set_priority";
export const ORDER_TYPE_SET_SECRET = "secret.set";
export const ORDER_TYPE_ROTATE_PRODUCT_KEY = "product.rotate_key";

export const BASE_ORDER_TYPES: readonly OrderTypeDeclaration[] = [
  {
    type: ORDER_TYPE_PAIR_OFFER,
    version: 1,
    params: PairOfferParamsSchema,
    risk: "medium",
    target: "primary",
  },
  {
    type: ORDER_TYPE_SET_PRIMARY,
    version: 1,
    params: SetPrimaryParamsSchema,
    risk: "medium",
    target: "bridge",
  },
  {
    type: ORDER_TYPE_SET_ROLE,
    version: 1,
    params: SetRoleParamsSchema,
    risk: "low",
    target: "bridge",
  },
  {
    type: ORDER_TYPE_SET_PRIORITY,
    version: 1,
    params: SetPriorityParamsSchema,
    risk: "low",
    target: "bridge",
  },
  {
    type: ORDER_TYPE_SET_SECRET,
    version: 1,
    params: SetSecretParamsSchema,
    risk: "high",
    target: "bridge",
    sealedParams: ["sealed"],
  },
  {
    type: ORDER_TYPE_REVOKE_DEVICE,
    version: 1,
    params: RevokeDeviceParamsSchema,
    risk: "high",
    target: "bridge",
  },
  {
    // Run what comes next: the agents go on until a validation waits for the creator.
    type: ORDER_TYPE_CHAIN_START,
    version: 1,
    params: ChainStartParamsSchema,
    risk: "medium",
    target: "primary",
  },
  {
    // Keep the hand on the agents: pause, take up again, stop, or give an instruction.
    type: ORDER_TYPE_CHAIN_PAUSE,
    version: 1,
    params: ChainPauseParamsSchema,
    risk: "medium",
    target: "primary",
  },
  {
    type: ORDER_TYPE_CHAIN_RESUME,
    version: 1,
    params: ChainResumeParamsSchema,
    risk: "medium",
    target: "primary",
  },
  {
    type: ORDER_TYPE_CHAIN_STOP,
    version: 1,
    params: ChainControlParamsSchema,
    risk: "medium",
    target: "primary",
  },
  {
    // The creator's own words: the signed order the journal keeps holds a digest of them, not the
    // text, which is written once, encrypted, as an event of its own.
    type: ORDER_TYPE_CHAIN_INSTRUCT,
    version: 1,
    params: ChainInstructParamsSchema,
    risk: "medium",
    target: "primary",
    sealedParams: ["text"],
  },
  {
    // One message in a conversation with the agent the creator holds the hand on: kept like an
    // instruction (a digest in the order, the text encrypted in an event of its own).
    type: ORDER_TYPE_CHAIN_SAY,
    version: 1,
    params: ChainSayParamsSchema,
    risk: "medium",
    target: "primary",
    sealedParams: ["text"],
  },
  {
    // One message to Noah, typed or dictated on the device: kept like an instruction (a digest in
    // the order, the text encrypted in an event of its own).
    type: ORDER_TYPE_NOAH_SAY,
    version: 1,
    params: NoahSayParamsSchema,
    risk: "medium",
    target: "primary",
    sealedParams: ["text"],
  },
  {
    type: ORDER_TYPE_ROTATE_PRODUCT_KEY,
    version: 1,
    params: RotateProductKeyParamsSchema,
    risk: "high",
    target: "bridge",
  },
  {
    // Authorise the machine at a code platform: the token is made and kept by the machine alone.
    type: ORDER_TYPE_FORGE_LINK,
    version: 1,
    params: LinkForgeParamsSchema,
    risk: "high",
    target: "bridge",
  },
  {
    type: ORDER_TYPE_FORGE_UNLINK,
    version: 1,
    params: UnlinkForgeParamsSchema,
    risk: "high",
    target: "bridge",
  },
  {
    // A new product on this machine: a folder and the engine's `init`. The idea is sealed content.
    type: ORDER_TYPE_CREATE_PRODUCT,
    version: 1,
    params: CreateProductParamsSchema,
    risk: "medium",
    target: "bridge",
    sealedParams: ["idea"],
  },
  {
    // Opens the folder of a product in the machine's file explorer: the machine knows the folder, the order carries none.
    type: ORDER_TYPE_OPEN_PRODUCT_FOLDER,
    version: 1,
    params: OpenProductFolderParamsSchema,
    risk: "low",
    target: "bridge",
  },
  {
    // Stage, pause, archive: marks the machine keeps; each is undone by the same gesture.
    type: ORDER_TYPE_SET_PRODUCT_STATE,
    version: 1,
    params: SetProductStateParamsSchema,
    risk: "low",
    target: "bridge",
  },
  {
    // The profile of a product, written in its `method.yaml` by the engine on the main machine.
    type: ORDER_TYPE_SET_PRODUCT_PROFILE,
    version: 1,
    params: SetProductProfileParamsSchema,
    risk: "medium",
    target: "primary",
  },
  {
    // The autonomy dial of a product: a preset over settings the engine already has, written in its
    // method.yaml by the engine's own writers on the main machine.
    type: ORDER_TYPE_SET_AUTONOMY,
    version: 1,
    params: SetAutonomyParamsSchema,
    risk: "high",
    target: "primary",
  },
  {
    // The permission rule of one kind of action; a locked action only keeps its locked value.
    type: ORDER_TYPE_SET_RULE,
    version: 1,
    params: SetRuleParamsSchema,
    risk: "high",
    target: "primary",
  },
  {
    // The marks of the proposal to raise the dial: « not now » and the threshold. Each machine keeps them.
    type: ORDER_TYPE_AUTONOMY_HINT,
    version: 1,
    params: AutonomyHintParamsSchema,
    risk: "low",
    target: "bridge",
  },
  {
    // The creator's answer to a checkpoint, given from the web view: one gesture, whatever the
    // risk of the point; the engine records it on the main machine.
    type: ORDER_TYPE_ANSWER_CHECKPOINT,
    version: 1,
    params: AnswerCheckpointParamsSchema,
    risk: "high",
    target: "primary",
  },
  {
    // Takes back an answer the machine still holds (the undo window): nothing was ever decided.
    type: ORDER_TYPE_UNDO_CHECKPOINT_ANSWER,
    version: 1,
    params: UndoCheckpointAnswerParamsSchema,
    risk: "medium",
    target: "primary",
  },
];

/** The registry of the engine's own order types. */
export function baseOrderTypes(): OrderTypeRegistry {
  return new OrderTypeRegistry(BASE_ORDER_TYPES);
}
