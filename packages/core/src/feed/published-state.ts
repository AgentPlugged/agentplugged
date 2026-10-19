import type {
  EventEnvelope,
  FeedCursor,
  IgnoredReason,
  ImportInfo,
  ImportState,
  PublishedPhases,
  PublishedState,
  PublishedTrustedDevice,
  RootPin,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { parseMethodConfig } from "../init/method-config.js";
import type { KeyStore } from "../journal/key-store.js";
import { hashOf } from "../journal/prepare-event.js";
import { forgetProductKey, projectionKey } from "../journal/product-key.js";
import type { StateStore } from "../journal/state-store.js";
import { skippedPhases } from "../journey/journey-rules.js";
import { electPrimary } from "../machines/primary.js";
import { activePhases, phaseProgress } from "../phases/phases.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { computeProjectionDetailed } from "../projection/compute-projection.js";
import { publishedStoryDocs, type StoryFileText } from "./story-docs.js";

/**
 * What the main bridge publishes of a product, read from the journal it holds: the projection that
 * `get_state` returns (the same function, never another implementation), with the sensitive content
 * this machine can decrypt, the trust registry the journal computes from the root this machine
 * pinned, the main bridge, and the cursor the whole stands at.
 */

export interface PublishedStateOptions {
  /** The root this machine pinned for the product: trust starts from it. */
  readonly pin?: RootPin;
  /** The keychain holding the product key: without it, sensitive content stays out. */
  readonly keys?: KeyStore;
  /** Where the import of an earlier history stands (none while nothing imports). */
  readonly importState?: ImportState;
  /**
   * While an earlier history is being imported: only the first `upTo` events of the journal are
   * projected, and the totals of the whole product are given with the progress.
   */
  readonly importTotals?: ImportTotals;
  readonly upTo?: number;
  /** Why the import failed (with `importState: "failed"`). */
  readonly importReason?: string;
  /**
   * The text of the product's `method.yaml`: it tells which phases the product goes through. Without
   * it (or when it cannot be read) no phase is published, never a guessed one.
   */
  readonly methodConfig?: string;
  /**
   * The story files of the product's working copy, as read by the bridge: what they say of each
   * story (title, criteria, intent...) is published beside the projection. Without them (or when
   * none is a valid story) no such key is published.
   */
  readonly storyFiles?: readonly StoryFileText[];
  /** Milliseconds since the epoch, to read waivers that ran out (the clock when absent). */
  readonly now?: number;
}

/** The phases of the projection under the product's profile; undefined when there is no profile to read. */
export function publishedPhases(
  state: Readonly<Record<string, unknown>>,
  methodConfig: string | undefined,
  now: number,
): PublishedPhases | undefined {
  if (methodConfig === undefined) return undefined;
  const config = parseMethodConfig(methodConfig);
  if (config instanceof AgentPluggedError) return undefined;
  const progress = phaseProgress(
    Object.values(checkpointsOf(state)),
    activePhases(config.profile, skippedPhases(state)),
    now,
  );
  return {
    current: progress.current,
    since: progress.since,
    phases: progress.phases.map((entry) => ({ id: entry.id, status: entry.status })),
  };
}

/** What the journal of a product holds, as the creator reads it while the history comes in. */
export interface ImportTotals {
  readonly events: number;
  readonly stories: number;
  readonly validations: number;
}

/**
 * The reasons that make an event `forged`, `unsigned` or cut from its chain for the creator: told
 * at the end of an import, never counted among the validations. The other reasons are the
 * ordinary life of a journal (a question answered twice, an endorsement not given yet).
 */
const FORGERY_REASONS: ReadonlySet<IgnoredReason> = new Set<IgnoredReason>([
  "unknown_signer",
  "bad_signature",
  "broken_chain",
  "wrong_product",
  "invalid",
  "key_conflict",
  "product_conflict",
  "not_human",
  "key_proof_invalid",
  "decrypt_failed",
]);

export interface PublishedStateRead {
  readonly state: PublishedState;
  readonly cursor: FeedCursor;
  /** The date of the latest event, or null for an empty journal. */
  readonly latestEventAt: string | null;
  /** The journal position read. */
  readonly head: string | null;
  /** What the events read hold: their number, the stories, the validations, the events refused. */
  readonly totals: ImportTotals & { readonly ignored: number };
}

/** The cursor of a journal: how many events it holds and the head of each writer's chain. */
export function cursorOfEvents(events: readonly EventEnvelope[]): FeedCursor {
  const heads: Record<string, string> = {};
  // Events come sorted by id: the last one of each writer is the head of its chain.
  for (const event of events) heads[event.actor.device] = hashOf(event);
  return { n: events.length, heads };
}

export async function readPublishedState(
  journal: Pick<StateStore, "list">,
  product: string,
  options: PublishedStateOptions = {},
): Promise<PublishedStateRead> {
  const full = await journal.list();
  const events =
    options.upTo === undefined ? full.events : full.events.slice(0, Math.max(0, options.upTo));
  const listing = { ...full, events };
  const access = await projectionKey(
    options.keys === undefined ? {} : { keys: options.keys },
    product,
    { events: full.events, problems: full.problems },
  );
  let detailed: Awaited<ReturnType<typeof computeProjectionDetailed>>;
  // Who is trusted and who is main is judged on the whole journal, even while only a part of the
  // history is shown: the devices were written at its end.
  let whole: Awaited<ReturnType<typeof computeProjectionDetailed>>;
  try {
    const compute = (list: readonly EventEnvelope[]) =>
      computeProjectionDetailed(list, {
        problems: listing.problems,
        head: listing.head,
        product,
        ...(options.pin === undefined ? {} : { pinnedRoot: options.pin }),
        ...(access.key === undefined ? {} : { productKey: access.key }),
      });
    detailed = await compute(listing.events);
    whole = events.length < full.events.length ? await compute(full.events) : detailed;
  } finally {
    await forgetProductKey(access.key);
  }
  const trust = whole.deviceTrust;
  const projected = detailed.projection;
  const totals = {
    events: listing.events.length,
    stories: Object.keys((projected.state.stories as object | undefined) ?? {}).length,
    validations: ((projected.state.validations as unknown[] | undefined) ?? []).length,
    ignored: projected.ignored.filter((entry) => FORGERY_REASONS.has(entry.reason)).length,
  };
  const devices: Record<string, PublishedTrustedDevice> = {};
  for (const device of trust?.devices ?? []) {
    devices[device.device] = {
      kind: device.kind,
      sig_key: device.sig_key,
      enc_key: device.enc_key,
      provisional: device.provisional,
    };
  }
  const primary = (whole.projection.state as { primary_bridge?: { bridge?: unknown } })
    .primary_bridge?.bridge;
  // The creator's choice wins; without one, the machine in use is elected from the journal alone.
  const explicit = typeof primary === "string" ? primary : null;
  const revoked = new Set((trust?.revoked ?? []).map((entry) => entry.device));
  const machines = Object.entries(devices)
    .filter(([device, entry]) => entry.kind === "machine" && !revoked.has(device))
    .map(([device]) => device);
  const lastWrite = new Map<string, string>();
  for (const event of full.events) {
    const known = lastWrite.get(event.actor.device);
    if (known === undefined || event.at > known) lastWrite.set(event.actor.device, event.at);
  }
  const elected = explicit === null ? electPrimary(machines, lastWrite) : null;
  const phases = publishedPhases(projected.state, options.methodConfig, options.now ?? Date.now());
  const storyDocs = publishedStoryDocs(options.storyFiles ?? []);
  const extra: Record<string, unknown> = {
    ...(phases === undefined ? {} : { phases }),
    ...(Object.keys(storyDocs).length === 0 ? {} : { story_docs: storyDocs }),
  };
  const state: PublishedState = {
    projection:
      Object.keys(extra).length === 0
        ? detailed.projection
        : { ...detailed.projection, state: { ...projected.state, ...extra } },
    trust: {
      blocked: trust?.blocked === true,
      devices,
      revoked: (trust?.revoked ?? []).map((revoked) => revoked.device).sort(),
    },
    machines: { primary: explicit ?? elected, automatic: explicit === null && elected !== null },
    import: importInfo(options, totals),
  };
  const latest = listing.events.reduce<string | null>(
    (best, event) => (best === null || event.at > best ? event.at : best),
    null,
  );
  return {
    state,
    cursor: cursorOfEvents(listing.events),
    latestEventAt: latest,
    head: listing.head,
    totals,
  };
}

function importInfo(
  options: PublishedStateOptions,
  read: PublishedStateRead["totals"],
): ImportInfo {
  const state = options.importState ?? "none";
  // Once the history is in, the numbers are the product's as it stands now.
  const whole =
    options.importTotals ??
    (state === "done"
      ? { events: read.events, stories: read.stories, validations: read.validations }
      : undefined);
  if (whole === undefined) {
    return state === "failed" && options.importReason !== undefined
      ? { state, reason: options.importReason }
      : { state };
  }
  // The numbers are the product's; the refused events are told once the whole history is in
  // (a part of a history shows chains cut only by where it stops).
  const complete = read.events >= whole.events;
  return {
    state,
    progress: { events_done: Math.min(read.events, whole.events), events_total: whole.events },
    stories: whole.stories,
    validations: whole.validations,
    ...(complete ? { ignored: read.ignored } : {}),
  };
}
