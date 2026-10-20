import {
  CHAIN_EVENT_TYPES,
  DEVICE_TRUST_EVENT_TYPES,
  type DeviceRegisteredPayload,
  EVENT_TYPES,
  type EventEnvelope,
  type IgnoredEvent,
  MACHINE_DEVICE_PATTERN,
  MACHINE_EVENT_TYPES,
  METHOD_EVENT_TYPES,
  type MethodMigratedPayload,
  ORDER_EVENT_TYPES,
  PRODUCT_KEY_EVENT_TYPES,
  type PrimaryChangedPayload,
  type ProductCreatedPayload,
  type ProductKeyCreatedPayload,
  type ProductKeyRotatedPayload,
  type ProjectionWarning,
  type RootPin,
  TEST_EVENT_TYPE,
} from "@agentplugged/protocol";
import { AGENT_REDUCERS } from "./agent-reducers.js";
import { BUDGET_REDUCERS } from "./budget-reducers.js";
import { CHECKPOINT_REDUCERS } from "./checkpoint-reducers.js";
import { CI_REDUCERS } from "./ci-reducers.js";
import { COURSE_REDUCERS } from "./course-reducers.js";
import { CREATOR_ACTION_REDUCERS } from "./creator-action-reducers.js";
import { CRITERION_REDUCERS } from "./criterion-reducers.js";
import { CRITIQUE_REDUCERS } from "./critique-reducers.js";
import { DEFERRED_REDUCERS } from "./deferred-reducers.js";
import { DELEGATION_REDUCERS } from "./delegation-reducers.js";
import { DEVIATION_REDUCERS } from "./deviation-reducers.js";
import { EXCHANGE_REDUCERS } from "./exchange-reducers.js";
import { FAST_TRACK_REDUCERS } from "./fast-track-reducers.js";
import { GIT_REDUCERS } from "./git-reducers.js";
import { HUMAN_REDUCERS } from "./human-reducers.js";
import { INSTALL_REDUCERS } from "./install-reducers.js";
import { LOOP_REDUCERS } from "./loop-reducers.js";
import { MEMORY_REDUCERS } from "./memory-reducers.js";
import { MERGE_ORDER_REDUCERS } from "./merge-order-reducers.js";
import { MERGE_REDUCERS, withMergeFeedback } from "./merge-reducers.js";
import { QA_REDUCERS } from "./qa-reducers.js";
import { QUALITY_REDUCERS } from "./quality-reducers.js";
import { READINESS_REDUCERS } from "./readiness-reducers.js";
import { REQUIREMENT_REDUCERS } from "./requirement-reducers.js";
import { REVIEW_REDUCERS } from "./review-reducers.js";
import { SPRINT_REDUCERS } from "./sprint-reducers.js";
import { STACK_REDUCERS } from "./stack-reducers.js";
import { STORY_REDUCERS } from "./story-reducers.js";
import { TABLE_REDUCERS } from "./table-reducers.js";
import { TEAM_REDUCERS } from "./team-reducers.js";
import { TRUST_REDUCERS } from "./trust-reducers.js";
import { USAGE_REDUCERS } from "./usage-reducers.js";
import { WRITE_GUARD_REDUCERS } from "./write-guard-reducers.js";

/** What the reducers build while the events are applied, in projection order. */
export interface ProjectionDraft {
  product: string | null;
  /**
   * The root of trust this machine pinned outside the repository: when given, the
   * root creator key is that one, whatever the order of the journal (and none when the pin is a
   * machine's). Absent: the first creator key registered is the root.
   */
  readonly pinnedRoot?: RootPin;
  /** Device → public key (base64url). */
  readonly devices: Map<string, string>;
  /** The reducers' object (`state` of `state.json`). */
  readonly state: Record<string, unknown>;
  /** Events a reducer refused on their meaning (a checkpoint id taken): not counted as applied. */
  readonly ignored: IgnoredEvent[];
  /** Warnings reducers raise (written to `state.json` with the others). */
  readonly warnings: ProjectionWarning[];
  /**
   * Measures applied before their checkpoint opened (clocks of two devices apart), by checkpoint
   * id: applied when it opens. Never written.
   */
  readonly pendingMeasures: Map<string, EventEnvelope[]>;
  /** Answers given before their checkpoint opened in projection order: applied when it opens. */
  readonly pendingResolutions: Map<string, EventEnvelope[]>;
  /**
   * Reopenings seen before their checkpoint opened in projection order (another
   * machine's clock behind): applied once the engine's automatic application is.
   */
  readonly pendingReopenings: Map<string, EventEnvelope[]>;
  /**
   * A creator's action carried out whose approval is held (its checkpoint not open
   * yet in projection order), by the approval's id: applied once the approval is.
   */
  readonly pendingExecutions: Map<string, EventEnvelope[]>;
  /** Events a reducer held (neither applied nor ignored yet), by id. */
  readonly held: Set<string>;
  /** Held events applied since (counted then, with their date). */
  readonly released: EventEnvelope[];
  /** The WebAuthn credential that verified each event signed so, by event id. */
  readonly signedBy: Map<string, string>;
  /** Endorsements of creator keys not registered yet: device → its key and who endorsed it. */
  readonly endorsements: Map<string, { readonly public_key: string; readonly by: string }>;
  /**
   * The event each event chains on in its writer's chain (`prev`), by id, when the journal holds
   * it (a sprint and the checkpoint opened just before it, in the same write).
   */
  readonly parents: Map<string, string>;
  /**
   * The costs declared by an agent on a story, by event id, read or not: a budget
   * threshold is accepted only right after one of them, in the same write. Never written.
   */
  readonly costEvents: Map<string, { readonly agent: string; readonly story: string }>;
}

/** An empty draft. */
export function emptyDraft(pinnedRoot?: RootPin): ProjectionDraft {
  return {
    product: null,
    ...(pinnedRoot === undefined ? {} : { pinnedRoot }),
    devices: new Map(),
    state: {},
    ignored: [],
    warnings: [],
    pendingMeasures: new Map(),
    pendingResolutions: new Map(),
    pendingReopenings: new Map(),
    pendingExecutions: new Map(),
    held: new Set(),
    released: [],
    signedBy: new Map(),
    endorsements: new Map(),
    parents: new Map(),
    costEvents: new Map(),
  };
}

/**
 * Applies one event, already checked (signature, chain, product) and in its type's current
 * format. Never reads the clock or anything outside the draft and the event.
 */
export type Reducer = (draft: ProjectionDraft, event: EventEnvelope) => void;

/**
 * One reducer per known type (`EVENT_TYPE_REGISTRY`): the engine's own, the agents' (
 * `AGENT_REDUCERS`), the checkpoints' (`CHECKPOINT_REDUCERS`, with their answers),
 * the creator's keys (`HUMAN_REDUCERS`) and the test type.
 */
export const REDUCERS: Readonly<Record<string, Reducer>> = withMergeFeedback({
  [EVENT_TYPES.deviceRegistered]: (draft, event) => {
    const { public_key } = event.payload as DeviceRegisteredPayload;
    if (!draft.devices.has(event.actor.device)) draft.devices.set(event.actor.device, public_key);
  },
  [EVENT_TYPES.productCreated]: (draft, event) => {
    draft.product ??= (event.payload as ProductCreatedPayload).product_id;
  },
  ...AGENT_REDUCERS,
  ...CHECKPOINT_REDUCERS,
  ...HUMAN_REDUCERS,
  // The registry of trusted devices is computed before the reducers (`computeDeviceTrust`):
  // the events it accepted change nothing else, and the ones it refused never get here.
  ...Object.fromEntries(Object.values(DEVICE_TRUST_EVENT_TYPES).map((type) => [type, () => {}])),
  /**
   * The product key's announcement, the one rule `announcedKey` reads: the first one
   * applied in projection order, by a registered machine (its signature and chain checked before,
   * its proof too on a machine holding that key), names the product's key (`state.product_key`);
   * a later one changes nothing.
   */
  [PRODUCT_KEY_EVENT_TYPES.keyCreated]: (draft, event) => {
    if (draft.state.product_key !== undefined) return;
    if (event.actor.kind !== "system" || !MACHINE_DEVICE_PATTERN.test(event.actor.device)) return;
    const { key_id } = event.payload as ProductKeyCreatedPayload;
    draft.state.product_key = {
      key_id,
      id: event.id,
      device: event.actor.device,
      at: event.at,
      history: [{ key_id, id: event.id }],
    };
  },
  /**
   * The renewal of the product key: a `product.key_rotated` by a machine that names the key now
   * announced as the one it follows makes its own key the announced one. The earlier keys stay in
   * `history`, in order, so that everything written under them is still read. One that follows
   * another key (a second renewal made at the same time, or by a machine that never saw the
   * first) changes nothing; the earliest in projection order wins.
   */
  [PRODUCT_KEY_EVENT_TYPES.keyRotated]: (draft, event) => {
    const announced = draft.state.product_key as
      | { key_id: string; history: Array<{ key_id: string; id: string }> }
      | undefined;
    if (announced === undefined) return;
    if (event.actor.kind !== "system" || !MACHINE_DEVICE_PATTERN.test(event.actor.device)) return;
    const { key_id, previous_key_id } = event.payload as ProductKeyRotatedPayload;
    if (previous_key_id !== announced.key_id) return;
    if (announced.history.some((step) => step.key_id === key_id)) return;
    draft.state.product_key = {
      key_id,
      id: event.id,
      device: event.actor.device,
      at: event.at,
      history: [...announced.history, { key_id, id: event.id }],
    };
  },
  /**
   * The product's main bridge: the last `bridge.primary_changed` in projection order, written by a
   * machine (a creator's key never is). Manual only: nothing in the engine writes it on its own.
   */
  /** An applied order is a record: nothing in the state depends on it. */
  [ORDER_EVENT_TYPES.applied]: () => {},
  // A refused order is a fact of the journal (shown in the history), not a change of any state.
  [ORDER_EVENT_TYPES.rejected]: () => {},
  // The creator's words to an agent are a record of the journal (the views list them): no state depends on them.
  [CHAIN_EVENT_TYPES.instructionGiven]: () => {},
  [MACHINE_EVENT_TYPES.primaryChanged]: (draft, event) => {
    if (event.actor.kind !== "system" || !MACHINE_DEVICE_PATTERN.test(event.actor.device)) return;
    const { bridge } = event.payload as PrimaryChangedPayload;
    // The machine that becomes main is the one that writes the change.
    if (bridge !== event.actor.device) return;
    draft.state.primary_bridge = { bridge, id: event.id, device: event.actor.device, at: event.at };
  },
  /** Reserved to tests: counts the events and keeps their payloads, in order. */
  [TEST_EVENT_TYPE]: (draft, event) => {
    const test = (draft.state.test as { appended: number; payloads: unknown[] } | undefined) ?? {
      appended: 0,
      payloads: [],
    };
    test.appended += 1;
    test.payloads.push(event.payload ?? null);
    draft.state.test = test;
  },
  /**
   * The format's migrations, written by a machine (`machine:` device, never a
   * creator's key): `state.format` is `{ version, engine, id, at, device }`, the latest format
   * reached, the engine that reached it, and the event and machine that recorded it (the later
   * in projection order on a tie).
   */
  [METHOD_EVENT_TYPES.migrated]: (draft, event) => {
    if (event.actor.kind !== "system" || !MACHINE_DEVICE_PATTERN.test(event.actor.device)) return;
    const { to_format, to_engine } = event.payload as MethodMigratedPayload;
    const current = draft.state.format as { version: number } | undefined;
    if (current !== undefined && current.version > to_format) return;
    draft.state.format = {
      version: to_format,
      engine: to_engine,
      id: event.id,
      at: event.at,
      device: event.actor.device,
    };
  },
  ...TRUST_REDUCERS,
  ...WRITE_GUARD_REDUCERS,
  ...SPRINT_REDUCERS,
  ...DEFERRED_REDUCERS,
  ...STORY_REDUCERS,
  ...BUDGET_REDUCERS,
  ...CI_REDUCERS,
  ...DEVIATION_REDUCERS,
  ...CREATOR_ACTION_REDUCERS,
  ...GIT_REDUCERS,
  ...DELEGATION_REDUCERS,
  ...REVIEW_REDUCERS,
  ...MERGE_REDUCERS,
  ...FAST_TRACK_REDUCERS,
  ...CRITERION_REDUCERS,
  ...QA_REDUCERS,
  ...LOOP_REDUCERS,
  ...TEAM_REDUCERS,
  ...EXCHANGE_REDUCERS,
  ...MERGE_ORDER_REDUCERS,
  ...MEMORY_REDUCERS,
  ...STACK_REDUCERS,
  ...INSTALL_REDUCERS,
  ...USAGE_REDUCERS,
  ...REQUIREMENT_REDUCERS,
  ...QUALITY_REDUCERS,
  ...CRITIQUE_REDUCERS,
  ...READINESS_REDUCERS,
  ...COURSE_REDUCERS,
  ...TABLE_REDUCERS,
});
