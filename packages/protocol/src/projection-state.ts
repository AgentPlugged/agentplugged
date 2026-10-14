import { z } from "zod";

/** Format of `state.json`, the projection of the journal (a cache, never a source). */
export const PROJECTION_FORMAT = 1;

/** The local reference holding the last journal commit projected: never pushed. */
export const JOURNAL_PROJECTED_REF = "refs/agentplugged/projected";

/** Why the projection ignored an event (it is never modified nor deleted). */
export const IGNORED_REASONS = [
  /** No key is registered for its `actor.device`. */
  "unknown_signer",
  /** Its signature does not verify with its device's key. */
  "bad_signature",
  /** Its `prev` names no event of the journal, an ignored one, or another device's. */
  "broken_chain",
  /** Its `product` is not the one of the journal's `product.created`. */
  "wrong_product",
  /** Its shape is refused by the schema (envelope or payload). */
  "invalid",
  /** A second `device.registered` of the same device, with another key. */
  "key_conflict",
  /** A `product.created` of another product than the one pinned or first created. */
  "product_conflict",
  /** A type reserved to tests (`test.*`), ignored outside them. */
  "test_type",
  /**
   * A `checkpoint.opened` whose checkpoint id (the last 10 characters of its ULID) is already
   * taken by a checkpoint opened before it in projection order.
   */
  "checkpoint_id_collision",
  /**
   * A creator's event (`checkpoint.resolved`, `human.*`, or `actor.kind: human`) that is not
   * signed by a registered creator's key (`human:` device): a machine or an agent cannot answer.
   */
  "not_human",
  /** A `checkpoint.resolved` on a checkpoint already answered (and not back open). */
  "already_resolved",
  /**
   * An answer, a presence link or an endorsement by a creator's key that is not trusted yet: not
   * the product's root creator key, and not endorsed by a trusted one.
   */
  "unendorsed_human",
  /** A `checkpoint.resolved` whose checkpoint never opened in the journal. */
  "checkpoint_unknown",
  /**
   * An encrypted payload (`payload_enc`) under the product key this machine holds that does not
   * decrypt (altered, or not a payload of its type): its content is never applied.
   */
  "decrypt_failed",
  /**
   * A `product.key_created` whose `proof` does not verify with the product key this machine holds
   * under its `key_id`: a forged announcement (only a holder of the key can check it).
   */
  "key_proof_invalid",
  /**
   * A sensitive event (`cost.reported`, `salle.*`…) in clear after the product key was announced,
   * in projection order: sensitive content is written encrypted from then on.
   */
  "sensitive_in_clear",
  /** An encrypted payload (`payload_enc`) on a type that is not sensitive. */
  "unexpected_encryption",
  /** An encrypted payload whose `alg` this engine does not know. */
  "unsupported_alg",
  /**
   * A `device.*` event whose authorization is missing, forged, or from a signer who
   * may not give it (unknown, outside the chain of the pinned root, revoked…).
   */
  "untrusted_authorization",
  /**
   * An event of a device revoked (`device.revoked`) that is not an ancestor of the head the
   * revocation names, or a `device.paired` of a key revoked before: a revoked key never returns.
   */
  "device_revoked",
  /** An event the creator dismissed with `trust.dismissed`. */
  "dismissed",
  /**
   * A `checkpoint.reopened` on a checkpoint the engine did not apply on its own, or already
   * answered since.
   */
  "not_reopenable",
] as const;

export type IgnoredReason = (typeof IGNORED_REASONS)[number];

export const IgnoredEventSchema = z.strictObject({
  id: z.string(),
  reason: z.enum(IGNORED_REASONS),
});

export type IgnoredEvent = z.infer<typeof IgnoredEventSchema>;

/** Two valid events of one device name the same `prev` (two clones on one machine): both kept. */
export const ChainForkWarningSchema = z.strictObject({
  code: z.literal("chain_fork"),
  device: z.string(),
  prev: z.string().nullable(),
  ids: z.array(z.string()),
});

/**
 * Two `checkpoint.opened` events give the same checkpoint id: `ids[0]` opened it, the others are
 * ignored (`checkpoint_id_collision`).
 */
export const CheckpointIdCollisionWarningSchema = z.strictObject({
  code: z.literal("checkpoint_id_collision"),
  checkpoint: z.string(),
  ids: z.array(z.string()),
});

/**
 * A signed `checkpoint.opened` asks a weaker recipient or confirmation than the rules give: the
 * projection applies the rules' values, and says so. `fields` names what was raised.
 */
export const CheckpointWeakPayloadWarningSchema = z.strictObject({
  code: z.literal("checkpoint_weak_payload"),
  checkpoint: z.string(),
  id: z.string(),
  fields: z.array(z.enum(["recipient_role", "confirmation"])),
});

/**
 * A `high` risk checkpoint answered with the `locale` assurance only (no `presence` credential):
 * accepted, and shown as such.
 */
export const LocaleOnHighRiskWarningSchema = z.strictObject({
  code: z.literal("locale_on_high_risk"),
  checkpoint: z.string(),
  id: z.string(),
});

/**
 * A machine-local warning, in a command's result only, never in `state.json`:
 * encrypted events (`payload_enc`) under a product key this machine does not hold, counted and
 * chained, their content not applied (costs and the like are missing).
 */
export const SensitiveUnreadableWarningSchema = z.strictObject({
  code: z.literal("sensitive_unreadable"),
  count: z.number().int().min(1),
});

export type SensitiveUnreadableWarning = z.infer<typeof SensitiveUnreadableWarningSchema>;

/**
 * Warnings drawn from the journal alone, the same on every machine. Machine-local ones (a history
 * rewritten since this machine's last projection, sensitive content this machine cannot read)
 * are never written to `state.json`.
 */
export const ProjectionWarningSchema = z.discriminatedUnion("code", [
  ChainForkWarningSchema,
  CheckpointIdCollisionWarningSchema,
  CheckpointWeakPayloadWarningSchema,
  LocaleOnHighRiskWarningSchema,
]);

export type ProjectionWarning = z.infer<typeof ProjectionWarningSchema>;

export const ProjectedDeviceSchema = z.strictObject({
  device: z.string(),
  public_key: z.string(),
});

export type ProjectedDevice = z.infer<typeof ProjectedDeviceSchema>;

/**
 * `state.json`: deterministic (two machines write the same bytes from the same journal, in
 * canonical JSON), `computed_at` being the date (`at`) of the last event applied in projection
 * order, never the clock.
 */
export const ProjectionStateSchema = z.strictObject({
  format: z.literal(PROJECTION_FORMAT),
  /** The journal position projected (a commit id in Git), or null for an empty journal. */
  journal_head: z.string().nullable(),
  /** The `at` of the last event applied, in projection order; null when none was applied. */
  computed_at: z.string().nullable(),
  /** The product id of the journal's `product.created`, or null. */
  product: z.string().nullable(),
  /** The registered machines, sorted by `device` (the creators are in `state.humans`). */
  devices: z.array(ProjectedDeviceSchema),
  /** Events applied. */
  applied: z.number().int().min(0),
  /** Events ignored, sorted by `id` then `reason`. */
  ignored: z.array(IgnoredEventSchema),
  warnings: z.array(ProjectionWarningSchema),
  /** What the reducers built. */
  state: z.record(z.string(), z.unknown()),
});

export type ProjectionState = z.infer<typeof ProjectionStateSchema>;
