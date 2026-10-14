import { z } from "zod";
import { type EventEnvelope, isCanonicalBase64url, ULID_PATTERN } from "./event-envelope.js";

/** The orphan branch holding the journal, shared by every branch and worktree of a repository. */
export const JOURNAL_REF = "refs/heads/agentplugged/journal";

/**
 * The remote-tracking reference of a remote's journal, advanced by `journal sync` once a fetched
 * tip passed its checks: local, never pushed. `key` identifies the remote by its URL (a hex hash),
 * so that a name with `/` or a renamed remote never collides.
 */
export function journalRemoteRef(key: string): string {
  return `refs/agentplugged/remotes/${key}/journal`;
}

/** The last tip of a remote's journal that `journal sync` saw (same `key`): local, never pushed. */
export function journalSeenRef(key: string): string {
  return `refs/agentplugged/seen/${key}`;
}

/** Folder of the event files in the journal tree: `journal/<YYYY>/<MM>/<ulid>.json`. */
export const JOURNAL_DIR = "journal";

/** Path of an event's file in the journal tree, from its UTC date and its id. */
export function journalEventPath(event: Pick<EventEnvelope, "id" | "at">): string {
  return `${JOURNAL_DIR}/${event.at.slice(0, 4)}/${event.at.slice(5, 7)}/${event.id}.json`;
}

/** Event types the engine itself writes; a caller's draft cannot use them. */
export const EVENT_TYPES = {
  /** A machine publishes its public key: the first event of each machine in a journal. */
  deviceRegistered: "device.registered",
  /** The journal's product id, written once, before any event other than a key publication. */
  productCreated: "product.created",
} as const;

export const RESERVED_EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(EVENT_TYPES));

/** 32 bytes in base64url: 43 characters, the last one carrying 4 bits only. */
const ED25519_PUBLIC_KEY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** `payload` of `device.registered`: the machine's Ed25519 public key (32 bytes, base64url). */
export const DeviceRegisteredPayloadSchema = z.strictObject({
  public_key: z.string().regex(ED25519_PUBLIC_KEY).refine(isCanonicalBase64url),
});

export type DeviceRegisteredPayload = z.infer<typeof DeviceRegisteredPayloadSchema>;

/** `payload` of `product.created`: the product id, the same as the envelope's `product`. */
export const ProductCreatedPayloadSchema = z.strictObject({
  product_id: z.string().regex(ULID_PATTERN),
});

export type ProductCreatedPayload = z.infer<typeof ProductCreatedPayloadSchema>;

/** `machine:` then 16 base64url characters (the start of the SHA-256 of the public key). */
export const MACHINE_DEVICE_PATTERN = /^machine:[A-Za-z0-9_-]{16}$/;
