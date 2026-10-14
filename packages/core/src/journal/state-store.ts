import type {
  ActorKind,
  CodedErrorPayload,
  EventEnvelope,
  UnsignedEventEnvelope,
} from "@agentplugged/protocol";

/**
 * What a caller asks to append: the envelope without `id`, `at`, `prev`, `alg` and `sig`, which
 * the store completes. `v` defaults to 1. `actor.device` defaults to the machine's device; when
 * given, it must be the machine's.
 */
export type EventDraft = Omit<
  UnsignedEventEnvelope,
  "v" | "id" | "at" | "prev" | "alg" | "actor"
> & {
  readonly v?: 1;
  readonly actor: { readonly kind: ActorKind; readonly agent?: string; readonly device?: string };
  /**
   * A field of `payload` the store sets to the id of the checkpoint (`G-…`) the draft just before
   * this one opens, in the same `appendAll` (a sprint names the checkpoint that submits
   * it). Only `sprint.planned` and `budget.threshold_reached` may carry it, only as
   * `checkpoint`, and the draft just before it
   * must be a `checkpoint.opened`: anything else is `EVENT_INVALID`, nothing written. Never
   * written itself.
   */
  readonly checkpointField?: string;
};

/** A journal entry that could not be read as an event: reported, never blocking the others. */
export interface JournalProblem {
  /** Path of the file in the journal tree (`journal/<YYYY>/<MM>/<ulid>.json`). */
  readonly path: string;
  readonly error: CodedErrorPayload;
  /**
   * The entry's JSON value, when it is JSON: an envelope of a newer version (`UPGRADE_REQUIRED`)
   * is then checked against its writer's key before it stops the projection.
   */
  readonly raw?: unknown;
}

export interface JournalListing {
  /** The journal position these events were read at (`head()`), or null when it is empty. */
  readonly head: string | null;
  /** Every readable event, sorted by `id` (ULID). */
  readonly events: readonly EventEnvelope[];
  readonly problems: readonly JournalProblem[];
}

/**
 * Port to the product's journal: nobody reads or writes the journal's files but through it.
 * Expected failures are thrown as `AgentPluggedError` (`JOURNAL_BUSY`, `NOT_A_GIT_REPO`,
 * `EVENT_INVALID`…).
 */
export interface StateStore {
  /**
   * Completes the draft (ULID, clock, `prev`, `alg: ed25519`), signs it with the machine key and
   * writes it. On the machine's first write to this journal, a `device.registered` event,
   * signed by the same key, is written before it; in a journal without `product.created`, that
   * event (the draft's `product`) comes next. A draft whose `product` is not the journal's gives
   * `PRODUCT_ID_MISMATCH`; a draft with an engine type (`device.registered`,
   * `product.created`) gives `EVENT_INVALID`. Returns the signed event.
   */
  append(draft: EventDraft): Promise<EventEnvelope>;
  /**
   * Appends several drafts in one write, in order, chained one after the other: all of them or
   * none (same checks and engine events as `append`). Returns their signed events, in order.
   * No draft gives `UNEXPECTED`. `options.precondition` runs under the journal lock, on the
   * listing at the very head the drafts are written on (again on every retry when that head
   * moved): whatever it throws aborts the write, nothing written.
   */
  appendAll(
    drafts: readonly EventDraft[],
    options?: AppendOptions,
  ): Promise<readonly EventEnvelope[]>;
  /**
   * Writes the creator's events, already signed by the creator's key (`prepareHumanEvents`), in
   * one write: all of them or none. They must follow the creator's device head in this journal
   * (`checkHumanEvents`, under the lock); in a journal without `product.created`, the machine
   * writes its `device.registered` and that event first. Only a creator's command of the CLI
   * calls it: `append` and `appendAll` refuse every creator's event. `options.precondition` runs
   * under the lock, as for `appendAll`. Returns the creator's events.
   */
  appendHuman(
    events: readonly EventEnvelope[],
    options?: AppendOptions,
  ): Promise<readonly EventEnvelope[]>;
  /** Every event of the journal, parsed by the envelope schema, sorted by ULID. */
  list(): Promise<JournalListing>;
  /**
   * The journal's current position, or null when it is empty. Opaque and specific to the
   * implementation (a commit id in Git, a counter in memory): only compare it for equality with
   * another position from the same store.
   */
  head(): Promise<string | null>;
  /** The product id the journal holds (its `product.created` event), or null when none yet. */
  productId(): Promise<string | null>;
  /** The last journal position projected (`refs/agentplugged/projected` in Git), or null. */
  projected(): Promise<string | null>;
  /**
   * Records `position` as the last one projected (null: none, for an empty journal), by
   * compare-and-swap from `previous` (what `projected()` gave): left as is when another process
   * moved it meanwhile.
   */
  markProjected(position: string | null, previous: string | null): Promise<void>;
  /**
   * How the journal went from `from` (a position projected earlier) to `to` (null: empty):
   * whether `to` descends from it, and how many events held at `from` are no longer held at `to`.
   * A position that cannot be read any more gives `unknown: true` (not descended from, 0 missing).
   */
  history(from: string, to: string | null): Promise<JournalHistory>;
  /**
   * Where the remote's journal stands against this one (`init` creates no product
   * key in a clone that has not synced yet). Optional: a store without remotes has none.
   */
  remoteJournalStatus?(options?: { readonly timeoutMs?: number }): Promise<RemoteJournalStatus>;
}

/**
 * `no_remote`: no remote configured; `absent`: the remote has no journal; `contained`: this journal
 * holds the remote's; `behind`: the remote's journal holds events this one lacks (sync first);
 * `unreachable`: the remote did not answer in time.
 */
export type RemoteJournalStatus =
  | { readonly kind: "no_remote" }
  | { readonly kind: "absent" | "contained" | "behind" | "unreachable"; readonly remote: string };

/** A check of the journal as it is when written: throws to abort the write. */
export type AppendPrecondition = (listing: JournalListing) => void | Promise<void>;

export interface AppendOptions {
  readonly precondition?: AppendPrecondition;
}

export interface JournalHistory {
  readonly descends: boolean;
  /** Event files held at `from` and no longer at `to`. */
  readonly missing: number;
  /** True when `from` could not be read: nothing is known of what was lost. */
  readonly unknown?: boolean;
}
