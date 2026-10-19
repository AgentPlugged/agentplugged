import { z } from "zod";
import { BRIDGE_ID_PATTERN, DEVICE_ID_PATTERN } from "./device-trust.js";
import { isCanonicalBase64url, ULID_PATTERN } from "./event-envelope.js";
import { MachineReportSchema } from "./machines.js";
import { PHASE_IDS, SemverSchema } from "./method-config.js";
import { ProjectionStateSchema } from "./projection-state.js";
import { readTolerant } from "./tolerant-reader.js";

/**
 * The state a product's main bridge publishes to the creator's views (web and phone): a snapshot
 * of the whole state at a cursor, then changes from one cursor to the next. Everything here is
 * pure data and pure rules; the encryption, the signature and the transport are the peer message's.
 *
 * A view applies what it receives and derives nothing: no status, no risk.
 *
 * Reading rule: a device ignores the optional fields it does not know and validates every field it
 * knows, so each message here is read with its `...Reader` (tolerant), never its strict schema.
 */

/** The version of the schema of the published state; a view may be one version behind. */
export const FEED_SCHEMA_VERSION = 1;

/** The message types of the publication, carried by peer messages. */
export const FEED_MESSAGE_TYPES = {
  /** One part of a snapshot or of a change (a message is split when it is too large). */
  part: "feed.part",
  /** The bridge's signed, dated presence. */
  beat: "feed.beat",
  /** A view asks for what it misses, from its cursor. */
  hello: "feed.hello",
  /** A view says it applied a snapshot or a change. */
  ack: "feed.ack",
  /** The bridge tells a view that is too old to be served. */
  upgradeRequired: "feed.upgrade_required",
  /** The key of a product, sent to a view the journal trusts once its `device.paired` is read back. */
  productKeys: "feed.product_keys",
  /** The bridge tells a device the creator removed that it was, with the product whose journal holds the removal. */
  deviceRemoved: "feed.device_removed",
} as const;

/** True when a view speaking schema `viewSchema` must update (older than the previous version). */
export function feedNeedsUpgrade(
  viewSchema: number,
  current: number = FEED_SCHEMA_VERSION,
): boolean {
  return viewSchema < current - 1;
}

/**
 * Where a view stands in a journal: `n` is the number of events the journal held (it never goes
 * down) and `heads` the head of each writer's chain.
 */
export const FeedCursorSchema = z.strictObject({
  n: z.number().int().min(0),
  heads: z.record(z.string().min(1).max(64), z.string().min(1).max(128)),
});
export type FeedCursor = z.infer<typeof FeedCursorSchema>;

/** A text that stands for a cursor: two cursors are the same exactly when their texts are. */
export function cursorId(cursor: FeedCursor): string {
  const heads = Object.keys(cursor.heads)
    .sort()
    .map((writer) => `${writer}=${cursor.heads[writer]}`);
  return [String(cursor.n), ...heads].join(";");
}

export function sameCursor(a: FeedCursor, b: FeedCursor): boolean {
  return cursorId(a) === cursorId(b);
}

/** The devices the journal trusts, as the views need them. */
export const PublishedTrustedDeviceSchema = z.strictObject({
  kind: z.enum(["machine", "human", "phone", "browser"]),
  sig_key: z.string().min(1).max(128),
  enc_key: z.string().min(1).max(128).nullable(),
  provisional: z.boolean(),
});
export type PublishedTrustedDevice = z.infer<typeof PublishedTrustedDeviceSchema>;

/** The state of the import of an earlier product's history. */
export const IMPORT_STATES = ["none", "running", "done", "failed"] as const;
export type ImportState = (typeof IMPORT_STATES)[number];

/**
 * Where the import of an earlier history stands: the events brought in out of those the journal
 * holds, and the totals of the product (the creator reads « 48 stories, 131 validations »).
 * `ignored` counts the events the journal holds that were refused as forged, unsigned or cut from
 * their chain: they are told, never counted among the validations.
 */
export const ImportInfoSchema = z.strictObject({
  state: z.enum(IMPORT_STATES),
  progress: z
    .strictObject({
      events_done: z.number().int().nonnegative(),
      events_total: z.number().int().nonnegative(),
    })
    .optional(),
  stories: z.number().int().nonnegative().optional(),
  validations: z.number().int().nonnegative().optional(),
  ignored: z.number().int().nonnegative().optional(),
  /** Why the import stopped (a short code, never a received value); with `failed` only. */
  reason: z.string().max(100).optional(),
});
export type ImportInfo = z.infer<typeof ImportInfoSchema>;

/**
 * What the exit guard puts in place of a text it kept from leaving. A stable code, not a sentence:
 * a view recognises it and shows it in the creator's language.
 */
export const REDACTED_SECRET = "redacted:secret";

/**
 * What the main bridge publishes of a product. The projection is the one `get_state` returns; the
 * trust registry is the journal's (never the relay's list); the machines say which bridge is
 * main; the import says where the import of an earlier history stands.
 */
export const PublishedStateSchema = z.strictObject({
  projection: ProjectionStateSchema,
  trust: z.strictObject({
    /** True while the journal's root differs from the pinned one: no order is accepted. */
    blocked: z.boolean(),
    devices: z.record(z.string().regex(DEVICE_ID_PATTERN), PublishedTrustedDeviceSchema),
    revoked: z.array(z.string().regex(DEVICE_ID_PATTERN)),
  }),
  machines: z.strictObject({
    primary: z.string().regex(BRIDGE_ID_PATTERN).nullable(),
    /** True when nobody chose the main bridge: the engine elected it from the journal. */
    automatic: z.boolean(),
  }),
  import: ImportInfoSchema,
});
export type PublishedState = z.infer<typeof PublishedStateSchema>;

/**
 * The phases of a product as its main bridge read them (`projection.state.phases` of the published
 * state, set only when the bridge could read the product's profile): the current phase, since when
 * it is, and the status of each phase of the method. The state's `state` record is open, so a view
 * that does not know this key still reads the rest; a view that does reads it with this schema and
 * shows no phase when it does not fit.
 */
export const PUBLISHED_PHASE_STATUSES = [
  "done",
  "in_progress",
  "in_review",
  "upcoming",
  "skipped",
] as const;
export type PublishedPhaseStatus = (typeof PUBLISHED_PHASE_STATUSES)[number];

export const PublishedPhasesSchema = z.strictObject({
  current: z.enum(PHASE_IDS).nullable(),
  since: z.string().nullable(),
  phases: z
    .array(z.strictObject({ id: z.enum(PHASE_IDS), status: z.enum(PUBLISHED_PHASE_STATUSES) }))
    .max(PHASE_IDS.length),
});
export type PublishedPhases = z.infer<typeof PublishedPhasesSchema>;

/** What a view reads of the phases: unknown optional fields dropped, known ones as strict as above. */
export const PublishedPhasesReader = readTolerant(PublishedPhasesSchema);

/** The most story files a bridge publishes the text of, and the bounds of what it keeps of each. */
export const PUBLISHED_STORY_DOCS_MAX = 300;
export const PUBLISHED_STORY_CRITERIA_MAX = 40;
export const PUBLISHED_STORY_TEXT_MAX = 1200;
export const PUBLISHED_STORY_LINE_MAX = 400;

/**
 * What a story's file says, as the main bridge read it from the product's working copy (the
 * `story_docs` key of `projection.state` of the published state, set only for the files the
 * bridge could read and that follow the story contract): the title, the owner, the requirements
 * it covers, the stories it depends on, its branch and budget, its intent and its acceptance
 * criteria in order. The state's `state` record is open, so a view that does not know this key
 * still reads the rest; a view that does reads each entry with this schema and leaves out the
 * ones that do not fit.
 */
export const PublishedStoryDocSchema = z.strictObject({
  title: z.string().min(1).max(PUBLISHED_STORY_LINE_MAX),
  owner: z.string().min(1).max(64).optional(),
  epic: z.string().min(1).max(64).optional(),
  requirements: z.array(z.string().min(1).max(64)).max(PUBLISHED_STORY_CRITERIA_MAX),
  depends_on: z.array(z.string().min(1).max(64)).max(PUBLISHED_STORY_CRITERIA_MAX),
  branch: z.string().min(1).max(PUBLISHED_STORY_LINE_MAX).optional(),
  budget_usd: z.number().finite().nonnegative().optional(),
  intent: z.string().max(PUBLISHED_STORY_TEXT_MAX),
  criteria: z.array(z.string().max(PUBLISHED_STORY_LINE_MAX)).max(PUBLISHED_STORY_CRITERIA_MAX),
});
export type PublishedStoryDoc = z.infer<typeof PublishedStoryDocSchema>;

/** What a view reads of a story's file: unknown optional fields dropped, known ones as strict as above. */
export const PublishedStoryDocReader = readTolerant(PublishedStoryDocSchema);

export const PublishedStoryDocsSchema = z.record(
  z.string().regex(/^[1-9]\d{0,5}-[1-9]\d{0,5}$/),
  PublishedStoryDocSchema,
);
export type PublishedStoryDocs = z.infer<typeof PublishedStoryDocsSchema>;

const PATH_SEGMENT_MAX = 200;
const PATH_DEPTH_MAX = 16;
export const FEED_OPS_MAX = 20_000;

/** One step of a change: set the value at a path, or remove it. */
export const FeedOpSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("set"),
    path: z.array(z.string().max(PATH_SEGMENT_MAX)).min(1).max(PATH_DEPTH_MAX),
    value: z.unknown(),
  }),
  z.strictObject({
    op: z.literal("remove"),
    path: z.array(z.string().max(PATH_SEGMENT_MAX)).min(1).max(PATH_DEPTH_MAX),
  }),
]);
export type FeedOp = z.infer<typeof FeedOpSchema>;

export const FeedSnapshotSchema = z.strictObject({
  kind: z.literal("snapshot"),
  schema: z.number().int().positive(),
  product: z.string().regex(ULID_PATTERN),
  cursor: FeedCursorSchema,
  state: PublishedStateSchema,
});
export type FeedSnapshot = z.infer<typeof FeedSnapshotSchema>;

export const FeedChangeSchema = z.strictObject({
  kind: z.literal("change"),
  schema: z.number().int().positive(),
  product: z.string().regex(ULID_PATTERN),
  from_cursor: FeedCursorSchema,
  to_cursor: FeedCursorSchema,
  ops: z.array(FeedOpSchema).max(FEED_OPS_MAX),
});
export type FeedChange = z.infer<typeof FeedChangeSchema>;

/** What a published message says once its parts are put together. */
export type FeedContent = FeedSnapshot | FeedChange;

/** Most parts one message is split into, and the longest text of one part. */
export const FEED_PARTS_MAX = 4096;
export const FEED_PART_DATA_MAX_CHARS = 262_144;

/** One part of a snapshot or of a change, and the fingerprint of the whole. */
export const FeedPartSchema = z.strictObject({
  /** The same for all the parts of one message. */
  id: z.string().regex(ULID_PATTERN),
  index: z
    .number()
    .int()
    .min(0)
    .max(FEED_PARTS_MAX - 1),
  count: z.number().int().min(1).max(FEED_PARTS_MAX),
  /** SHA-256 of the whole content, base64url (43 characters). */
  digest: z.string().length(43).refine(isCanonicalBase64url),
  data: z.string().min(1).max(FEED_PART_DATA_MAX_CHARS).refine(isCanonicalBase64url),
});
export type FeedPart = z.infer<typeof FeedPartSchema>;

/** The bridge's presence: signed (as the message that carries it) and dated. */
export const FeedBeatSchema = z.strictObject({
  bridge: z.string().regex(BRIDGE_ID_PATTERN),
  /** Seconds since the epoch, on the bridge's clock. */
  at: z.number().int().positive(),
  bridge_version: SemverSchema,
  protocol_version: z.number().int().positive(),
  schema: z.number().int().positive(),
  /** The last sequence number this bridge gave to a message for this view. */
  last_seq: z.number().int().min(0),
  /** The products this bridge publishes, and the cursor of each. */
  publishes: z
    .array(z.strictObject({ product: z.string().regex(ULID_PATTERN), cursor: FeedCursorSchema }))
    .max(64),
  report: MachineReportSchema.optional(),
});
export type FeedBeat = z.infer<typeof FeedBeatSchema>;

export const FeedHelloSchema = z.strictObject({
  schema: z.number().int().positive(),
  product: z.string().regex(ULID_PATTERN),
  cursor: FeedCursorSchema.nullable(),
});
export type FeedHello = z.infer<typeof FeedHelloSchema>;

export const FeedAckSchema = z.strictObject({
  product: z.string().regex(ULID_PATTERN),
  cursor: FeedCursorSchema,
});
export type FeedAck = z.infer<typeof FeedAckSchema>;

export const FeedUpgradeRequiredSchema = z.strictObject({
  current: z.number().int().positive(),
  minimum: z.number().int().positive(),
});
export type FeedUpgradeRequired = z.infer<typeof FeedUpgradeRequiredSchema>;

/**
 * What a bridge tells a device it just removed: the device it means, the product whose journal
 * holds the removal and the date. The device believes it only from the bridge it pinned when it was
 * linked (the message is signed by that bridge's key), never from the relay closing a connection.
 */
export const FeedDeviceRemovedSchema = z.strictObject({
  device: z.string().regex(DEVICE_ID_PATTERN),
  product: z.string().regex(ULID_PATTERN),
  removed_at: z.iso.datetime(),
});
export type FeedDeviceRemoved = z.infer<typeof FeedDeviceRemovedSchema>;

/**
 * What a device reads: the same schemas, tolerant of the optional fields a newer bridge adds
 * (dropped, never kept or shown), as strict as the schemas on every field they declare.
 */
export const PublishedStateReader = readTolerant(PublishedStateSchema);
export const FeedSnapshotReader = readTolerant(FeedSnapshotSchema);
export const FeedChangeReader = readTolerant(FeedChangeSchema);
export const FeedBeatReader = readTolerant(FeedBeatSchema);
export const FeedUpgradeRequiredReader = readTolerant(FeedUpgradeRequiredSchema);
export const FeedDeviceRemovedReader = readTolerant(FeedDeviceRemovedSchema);

// ---------------------------------------------------------------------------------------------
// Changes: the difference between two states, and applying it.

/** A change that cannot be computed or applied: the receiver asks for a snapshot instead. */
export class FeedPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedPatchError";
  }
}

const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (value: Json): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Deep equality of two JSON values; the order of the keys of an object does not count. */
export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
    );
  }
  return false;
}

function diffInto(prev: JsonObject, next: JsonObject, path: string[], ops: FeedOp[]): void {
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort();
  for (const key of keys) {
    if (FORBIDDEN_SEGMENTS.has(key)) {
      throw new FeedPatchError("a key cannot be named in a change");
    }
    const here = [...path, key];
    if (here.length > PATH_DEPTH_MAX || key.length > PATH_SEGMENT_MAX) {
      throw new FeedPatchError("a path is too deep or too long for a change");
    }
    const before = Object.hasOwn(prev, key) ? prev[key] : undefined;
    const after = Object.hasOwn(next, key) ? next[key] : undefined;
    if (!Object.hasOwn(next, key)) ops.push({ op: "remove", path: here });
    else if (!Object.hasOwn(prev, key)) ops.push({ op: "set", path: here, value: after });
    else if (isObject(before) && isObject(after)) diffInto(before, after, here, ops);
    else if (!jsonEqual(before, after)) ops.push({ op: "set", path: here, value: after });
  }
}

/**
 * The steps that turn `prev` into `next`: objects are compared key by key, anything else (a list,
 * a text, a number) is replaced as a whole. Throws `FeedPatchError` for a key or a path
 * that a change cannot carry; the publisher then sends a snapshot.
 */
export function diffPublished(prev: PublishedState, next: PublishedState): FeedOp[] {
  const ops: FeedOp[] = [];
  diffInto(prev as unknown as JsonObject, next as unknown as JsonObject, [], ops);
  if (ops.length > FEED_OPS_MAX) {
    throw new FeedPatchError("a change has too many steps");
  }
  return ops;
}

/** A copy of `value` that shares nothing with it. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * `state` with `ops` applied, in order, on a copy. Throws `FeedPatchError` when a step
 * names a path that is not there or a key no change may name, or when the result is no valid
 * published state: the caller then keeps its state and asks for a snapshot.
 */
export function applyFeedOps(state: PublishedState, ops: readonly FeedOp[]): PublishedState {
  const root = cloneJson(state) as unknown as JsonObject;
  for (const step of ops) {
    if (step.path.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
      throw new FeedPatchError("a step names a forbidden key");
    }
    let node: Json = root;
    for (const segment of step.path.slice(0, -1)) {
      if (!isObject(node) || !Object.hasOwn(node, segment)) {
        throw new FeedPatchError("a step names a path that is not there");
      }
      node = node[segment];
    }
    const last = step.path[step.path.length - 1] as string;
    if (!isObject(node)) throw new FeedPatchError("a step names a path that is not there");
    if (step.op === "remove") {
      if (!Object.hasOwn(node, last)) throw new FeedPatchError("a step removes nothing");
      delete node[last];
    } else {
      Object.defineProperty(node, last, {
        value: cloneJson(step.value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  const checked = PublishedStateReader.safeParse(root);
  if (!checked.success) throw new FeedPatchError("the result is not a published state");
  return checked.data;
}

/** The product's cursor as the main bridge publishes it: the whole journal it holds. */
export interface CursorSource {
  readonly n: number;
  readonly heads: Readonly<Record<string, string>>;
}

export function cursorOf(source: CursorSource): FeedCursor {
  return { n: source.n, heads: { ...source.heads } };
}

/**
 * Whether a view holding `held` may take a snapshot at `incoming`: never one behind it (a relay
 * that replays an old snapshot must not take the view back), and not another one at the same count.
 */
export function snapshotVerdict(
  held: FeedCursor | undefined,
  incoming: FeedCursor,
): "apply" | "duplicate" | "behind" | "conflict" {
  if (held === undefined) return "apply";
  if (incoming.n < held.n) return "behind";
  if (incoming.n === held.n) return sameCursor(held, incoming) ? "duplicate" : "conflict";
  return "apply";
}
