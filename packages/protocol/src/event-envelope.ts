import { z } from "zod";
import { ErrorCode, type ErrorPayload } from "./error-payload.js";
import { currentVersionOf, eventConversion, MAX_EVENT_VERSION } from "./event-versions.js";
import { EXTENSION_TYPE_PATTERN, isExtensionEventType } from "./extension.js";

/** An error payload whose `code` is one of the stable `ErrorCode`s. */
export type CodedErrorPayload = ErrorPayload & { code: ErrorCode };

/**
 * Version 1, the version of every type but those `EVENT_TYPE_VERSIONS` raises. The envelope's `v`
 * is its type's version: an older `v` is accepted only for a type that declares a conversion from
 * it (`EVENT_CONVERSIONS`), applied when the journal is read; a `v` above every version this
 * engine knows (`MAX_EVENT_VERSION`) asks for an upgrade.
 */
export const EVENT_ENVELOPE_VERSION = 1;

/** True when `type` can be converted from `version` up to its current version. */
function convertible(type: string, version: number): boolean {
  for (let from = version; from < currentVersionOf(type); from++) {
    if (eventConversion(type, from) === undefined) return false;
  }
  return true;
}

export const ACTOR_KINDS = ["human", "agent", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const PROVENANCES = ["trusted", "untrusted"] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** Signature algorithms: the `locale` key, and the `presence` WebAuthn credential. */
export const SIGNATURE_ALGS = ["ed25519", "webauthn-es256", "webauthn-rs256"] as const;
export type SignatureAlg = (typeof SIGNATURE_ALGS)[number];

export const ASSURANCE_LEVELS = ["presence", "locale"] as const;
export type Assurance = (typeof ASSURANCE_LEVELS)[number];

/**
 * Message keys of the reasons an envelope or a signature is rejected (`details.reason_key`).
 * Surfaces translate them; the keys are stable.
 */
export const EVENT_REASON = {
  required: "reason.required",
  unknownField: "reason.unknown_field",
  invalidValue: "reason.invalid_value",
  ulid: "reason.ulid",
  eventType: "reason.event_type",
  utcDatetime: "reason.utc_datetime",
  eventHash: "reason.event_hash",
  base64url: "reason.base64url",
  ed25519Signature: "reason.ed25519_signature",
  sigShape: "reason.sig_shape",
  payloadExclusive: "reason.payload_exclusive",
  agentRequired: "reason.agent_required",
  agentForbidden: "reason.agent_forbidden",
  assuranceHumanOnly: "reason.assurance_human_only",
  /** A type only the engine writes (`device.registered`, `product.created`). */
  reservedType: "reason.reserved_type",
  /**
   * A creator's event (`human.*`, `checkpoint.resolved`, or `actor.kind: human`): written only by
   * a creator's command of the CLI, signed by the creator's key, never through an agent's write.
   */
  humanOnly: "reason.human_only",
  /** A type reserved to tests (`test.*`), refused outside them. */
  testType: "reason.test_type",
  /** Not a JSON value: NaN, Infinity, BigInt, undefined, a cycle, a lone surrogate… */
  jsonValue: "reason.json_value",
} as const;

export const SIGNATURE_REASON = {
  /** The signature does not match the signed bytes or the key. */
  signatureMismatch: "reason.signature_mismatch",
  /** The WebAuthn challenge is not the SHA-256 of the signed bytes. */
  challengeMismatch: "reason.challenge_mismatch",
  /** The WebAuthn assertion does not carry the user-verified (UV) flag. */
  uvMissing: "reason.uv_missing",
  /** The declared `assurance` differs from the level the signature gives. */
  assuranceMismatch: "reason.assurance_mismatch",
  /** No key, or no credential, was given to verify this algorithm. */
  keyMissing: "reason.key_missing",
  /** The credential's algorithm is not the envelope's `alg`. */
  algMismatch: "reason.alg_mismatch",
  /** The assertion was made for another relying party or origin, or is not an assertion. */
  clientDataMismatch: "reason.client_data_mismatch",
  /** The assertion's signature counter is not above the last one seen (cloned or replayed). */
  counterRegression: "reason.counter_regression",
  /** Only a human signs with a WebAuthn (`presence`) credential. */
  webauthnNonHuman: "reason.webauthn_non_human",
} as const;

export type EventReasonKey = (typeof EVENT_REASON)[keyof typeof EVENT_REASON];
export type SignatureReasonKey = (typeof SIGNATURE_REASON)[keyof typeof SIGNATURE_REASON];

/** Base64url without padding (RFC 4648 §5). */
const BASE64URL = /^[A-Za-z0-9_-]*$/;
/** ULID: 26 Crockford base32 characters, the first one at most 7 (48-bit time). */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ULID = ULID_PATTERN;
/** `domain.action`, lowercase; or `x.<module>.<type>` for the extension point. */
export const EVENT_TYPE_PATTERN = new RegExp(
  `^(?:[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*|${EXTENSION_TYPE_PATTERN.source.slice(1, -1)})$`,
);
/** `sha256:` then the 32-byte digest in base64url (43 characters). */
const EVENT_HASH = /^sha256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
/** 64 bytes in base64url: 86 characters, the last one carrying 2 bits only. */
const ED25519_SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Canonical base64url: the only text that encodes its bytes (no padding, no length ≡ 1 mod 4,
 * unused trailing bits at zero). Any other text would give another hash for the same bytes.
 */
export function isCanonicalBase64url(text: string): boolean {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return false;
  const rest = text.length % 4;
  if (rest === 0) return true;
  const last = BASE64URL_ALPHABET.indexOf(text.charAt(text.length - 1));
  return (last & (rest === 2 ? 0x0f : 0x03)) === 0;
}

/** A ULID (event `id`, `product_id` of `method.yaml`). */
export const UlidSchema = z.string().regex(ULID, { message: EVENT_REASON.ulid });

const base64url = (min = 0) =>
  z.string().min(min).refine(isCanonicalBase64url, { message: EVENT_REASON.base64url });

export const ActorSchema = z
  .strictObject({
    kind: z.enum(ACTOR_KINDS),
    device: z.string().min(1),
    agent: z.string().min(1).optional(),
  })
  .superRefine((actor, context) => {
    if (actor.kind === "agent" && actor.agent === undefined) {
      context.addIssue({ code: "custom", path: ["agent"], message: EVENT_REASON.agentRequired });
    }
    if (actor.kind !== "agent" && actor.agent !== undefined) {
      context.addIssue({ code: "custom", path: ["agent"], message: EVENT_REASON.agentForbidden });
    }
  });

export type Actor = z.infer<typeof ActorSchema>;

/**
 * Encrypted payload: `{ alg, key_id, nonce, ct }`, `key_id` naming the product key
 * (`pk:` + 16 base64url characters), `nonce` and `ct` in base64url. Only its shape is checked
 * here: an algorithm this engine cannot decrypt is the projection's concern.
 */
export const EncryptedPayloadSchema = z.strictObject({
  alg: z.string().min(1),
  key_id: z.string().regex(/^pk:[A-Za-z0-9_-]{16}$/, { message: EVENT_REASON.invalidValue }),
  nonce: base64url(1),
  ct: base64url(1),
});

export type EncryptedPayload = z.infer<typeof EncryptedPayloadSchema>;

export const Ed25519SignatureSchema = z
  .string()
  .regex(ED25519_SIGNATURE, { message: EVENT_REASON.ed25519Signature });

export const WebAuthnSignatureSchema = z.strictObject({
  authenticatorData: base64url(1),
  clientDataJSON: base64url(1),
  signature: base64url(1),
});

export type WebAuthnSignature = z.infer<typeof WebAuthnSignatureSchema>;

/** Event envelope v1: one event of the journal or of a validation, signed by its writer. */
export const EventEnvelopeSchema = z
  .strictObject({
    v: z.number().int().min(0),
    id: UlidSchema,
    type: z.string().regex(EVENT_TYPE_PATTERN, { message: EVENT_REASON.eventType }),
    at: z.iso.datetime({ message: EVENT_REASON.utcDatetime }),
    actor: ActorSchema,
    product: z.string().min(1),
    story: z.string().min(1).optional(),
    provenance: z.enum(PROVENANCES),
    prev: z.string().regex(EVENT_HASH, { message: EVENT_REASON.eventHash }).nullable(),
    payload: z.record(z.string(), z.unknown()).optional(),
    payload_enc: EncryptedPayloadSchema.optional(),
    alg: z.enum(SIGNATURE_ALGS),
    sig: z.union([z.string(), z.record(z.string(), z.unknown())]),
    assurance: z.enum(ASSURANCE_LEVELS).optional(),
  })
  .superRefine((event, context) => {
    // A future version is refused, except for an extension event: it stays in its writer's chain,
    // applied to nothing, so that the events after it still count.
    if (event.v > MAX_EVENT_VERSION && !isExtensionEventType(event.type)) {
      context.addIssue({ code: "custom", path: ["v"], message: EVENT_REASON.invalidValue });
    }
    if (event.v < currentVersionOf(event.type) && !convertible(event.type, event.v)) {
      context.addIssue({ code: "custom", path: ["v"], message: EVENT_REASON.invalidValue });
    }
    if ((event.payload === undefined) === (event.payload_enc === undefined)) {
      context.addIssue({
        code: "custom",
        path: [event.payload === undefined ? "payload" : "payload_enc"],
        message: EVENT_REASON.payloadExclusive,
      });
    }
    const sig =
      event.alg === "ed25519"
        ? Ed25519SignatureSchema.safeParse(event.sig)
        : WebAuthnSignatureSchema.safeParse(event.sig);
    const sigIssue = sig.error?.issues[0];
    if (sigIssue !== undefined) {
      const shapeMismatch = (typeof event.sig === "string") !== (event.alg === "ed25519");
      const { path, reason } = locate(sigIssue, event.sig);
      context.addIssue({
        code: "custom",
        path: shapeMismatch ? ["sig"] : ["sig", ...path],
        message: shapeMismatch ? EVENT_REASON.sigShape : reason,
      });
    }
    if (event.assurance !== undefined && event.actor.kind !== "human") {
      context.addIssue({
        code: "custom",
        path: ["assurance"],
        message: EVENT_REASON.assuranceHumanOnly,
      });
    }
  });

/** The `sig` field, narrowed: a base64url string for `ed25519`, an assertion for `webauthn-*`. */
export type EventEnvelope = Omit<z.infer<typeof EventEnvelopeSchema>, "sig"> & {
  sig: string | WebAuthnSignature;
};

/** An envelope before signing: everything the signature covers. */
export type UnsignedEventEnvelope = Omit<EventEnvelope, "sig">;

export type EventEnvelopeParseResult =
  | { success: true; data: EventEnvelope }
  | { success: false; error: CodedErrorPayload };

const KNOWN_REASONS = new Set<string>(Object.values(EVENT_REASON));

/** True when the key at `path` is absent from `input` (zod does not report the input). */
function isMissing(input: unknown, path: ReadonlyArray<PropertyKey>): boolean {
  let parent: unknown = input;
  for (const key of path.slice(0, -1)) {
    if (typeof parent !== "object" || parent === null) return false;
    parent = (parent as Record<PropertyKey, unknown>)[key];
  }
  const key = path.at(-1);
  if (key === undefined || typeof parent !== "object" || parent === null) return false;
  return (parent as Record<PropertyKey, unknown>)[key] === undefined;
}

/** Where an issue points (an unknown key included) and its reason key. */
function locate(issue: z.core.$ZodIssue, input: unknown): { path: PropertyKey[]; reason: string } {
  if (issue.code === "unrecognized_keys") {
    return { path: [...issue.path, ...issue.keys.slice(0, 1)], reason: EVENT_REASON.unknownField };
  }
  if (KNOWN_REASONS.has(issue.message)) return { path: issue.path, reason: issue.message };
  if (issue.code === "invalid_type" && isMissing(input, issue.path)) {
    return { path: issue.path, reason: EVENT_REASON.required };
  }
  return { path: issue.path, reason: EVENT_REASON.invalidValue };
}

/**
 * The path of the first value that has no canonical JSON form (RFC 8785): a non-finite number,
 * a BigInt, a function, a symbol, `undefined` below the top level, a cycle, an object that is
 * not a plain object or array, or a string or key with a lone surrogate. Undefined when the
 * whole value is JSON. Top-level `undefined` properties count as absent.
 */
export function jsonValueIssue(value: unknown): string | undefined {
  const seen = new Set<object>();
  const visit = (item: unknown, path: string[], top: boolean): string[] | undefined => {
    switch (typeof item) {
      case "string":
        return item.isWellFormed() ? undefined : path;
      case "number":
        return Number.isFinite(item) ? undefined : path;
      case "boolean":
        return undefined;
      case "object": {
        if (item === null) return undefined;
        if (seen.has(item)) return path;
        const proto = Object.getPrototypeOf(item);
        if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) return path;
        seen.add(item);
        for (const [key, child] of Object.entries(item)) {
          const at = [...path, key];
          if (!key.isWellFormed()) return at;
          if (top && child === undefined) continue;
          const found = visit(child, at, false);
          if (found !== undefined) return found;
        }
        seen.delete(item);
        return undefined;
      }
      default:
        return path;
    }
  };
  return visit(value, [], true)?.join(".");
}

/** `EVENT_INVALID` for one field: `{ code, message_key, details: { field, reason_key } }`. */
export function eventInvalid(field: string, reasonKey: string): CodedErrorPayload {
  return {
    code: ErrorCode.EVENT_INVALID,
    message_key: "error.event_invalid",
    details: { field, reason_key: reasonKey },
  };
}

/**
 * Validates an envelope. A version newer than this engine knows gives `UPGRADE_REQUIRED` (with
 * the `type` when it is a string); any other problem gives `EVENT_INVALID` on the first field at
 * fault. An older version is valid only when its type declares a conversion from it.
 */
export function parseEventEnvelope(input: unknown): EventEnvelopeParseResult {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const { v: version, type } = input as { v?: unknown; type?: unknown };
    // An extension event never asks for an upgrade: one this engine cannot read is refused as
    // invalid and ignored, it does not stop the journal.
    if (
      typeof version === "number" &&
      Number.isInteger(version) &&
      version > MAX_EVENT_VERSION &&
      !(typeof type === "string" && isExtensionEventType(type))
    ) {
      return {
        success: false,
        error: {
          code: ErrorCode.UPGRADE_REQUIRED,
          message_key: "error.event_upgrade_required",
          details: {
            field: "v",
            version,
            supported: MAX_EVENT_VERSION,
            ...(typeof type === "string" ? { type } : {}),
          },
        },
      };
    }
  }
  const notJson = jsonValueIssue(input);
  if (notJson !== undefined) {
    return { success: false, error: eventInvalid(notJson, EVENT_REASON.jsonValue) };
  }
  const result = EventEnvelopeSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data as EventEnvelope };
  const issue = result.error.issues[0];
  if (issue === undefined) {
    return { success: false, error: eventInvalid("", EVENT_REASON.invalidValue) };
  }
  const { path, reason } = locate(issue, input);
  return { success: false, error: eventInvalid(path.map(String).join("."), reason) };
}
