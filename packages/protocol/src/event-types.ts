import { z } from "zod";
import { QA_EVENT_TYPES, QaReportedPayloadSchema } from "./acceptance-qa.js";
import {
  AGENT_EVENT_TYPES,
  AgentResultSchema,
  CostReportedPayloadSchema,
  ProgressReportedPayloadSchema,
  StatusReportedPayloadSchema,
  StoryStatusChangedPayloadSchema,
} from "./agent-activity.js";
import { BUDGET_EVENT_TYPES, BudgetThresholdReachedPayloadSchema } from "./budget.js";
import {
  CHAT_EVENT_TYPES,
  CheckpointAnsweredPayloadSchema,
  CheckpointAutoAppliedPayloadSchema,
  CheckpointReopenedPayloadSchema,
} from "./chat.js";
import {
  CHECKPOINT_EVENT_TYPES,
  CheckpointMeasuredPayloadSchema,
  CheckpointOpenedPayloadSchema,
  CheckpointResolvedPayloadSchema,
} from "./checkpoint.js";
import {
  CHECKPOINT_CLOSED_EVENT_TYPES,
  CheckpointClosedPayloadSchema,
} from "./checkpoint-closed.js";
import {
  CHECKPOINT_DECIDED_EVENT_TYPES,
  CheckpointDecidedPayloadSchema,
} from "./checkpoint-decided.js";
import { CI_EVENT_TYPES, CiReportedPayloadSchema, CiWaivedPayloadSchema } from "./ci.js";
import {
  COURSE_EVENT_TYPES,
  CourseClosedPayloadSchema,
  CourseDecidedPayloadSchema,
  CourseOpenedPayloadSchema,
} from "./course.js";
import { CREATOR_ACTION_EVENT_TYPES } from "./creator-action.js";
import { CreatorActionExecutedPayloadSchema } from "./creator-action-event.js";
import { CRITERION_EVENT_TYPES, CriterionRecordedPayloadSchema } from "./criteria.js";
import {
  CRITIQUE_EVENT_TYPES,
  CritiqueProposedPayloadSchema,
  CritiqueReportedPayloadSchema,
  CritiqueSettledPayloadSchema,
  HypothesisClosedPayloadSchema,
} from "./critique.js";
import {
  DEFERRED_EVENT_TYPES,
  DeferredClosedPayloadSchema,
  DeferredRecordedPayloadSchema,
} from "./deferred.js";
import { AgentDelegatedPayloadSchema, DELEGATION_EVENT_TYPES } from "./delegation.js";
import {
  DEVICE_TRUST_EVENT_TYPES,
  DeviceConfirmedPayloadSchema,
  DevicePairedPayloadSchema,
  DeviceRevokedPayloadSchema,
  DeviceRootCertifiedPayloadSchema,
  TrustDismissedPayloadSchema,
} from "./device-trust.js";
import { CheckpointElicitedPayloadSchema, ELICITATION_EVENT_TYPES } from "./elicitation.js";
import { ErrorCode } from "./error-payload.js";
import {
  type CodedErrorPayload,
  EVENT_REASON,
  type EventEnvelope,
  eventInvalid,
} from "./event-envelope.js";
import { currentVersionOf, eventConversion, TEST_EVENT_TYPE } from "./event-versions.js";
import {
  FAST_TRACK_EVENT_TYPES,
  FastTrackCheckedPayloadSchema,
  FastTrackEnteredPayloadSchema,
  FastTrackLeftPayloadSchema,
} from "./fast-track.js";
import {
  GIT_EVENT_TYPES,
  GitReleasedPayloadSchema,
  GitWorkflowSetPayloadSchema,
} from "./git-workflow.js";
import {
  HUMAN_EVENT_TYPES,
  HumanKeyEndorsedPayloadSchema,
  HumanKeyRegisteredPayloadSchema,
  HumanPresenceLinkedPayloadSchema,
} from "./human.js";
import { INSTALL_EVENT_TYPES, InstallRecordedPayloadSchema } from "./install.js";
import {
  DeviceRegisteredPayloadSchema,
  EVENT_TYPES,
  ProductCreatedPayloadSchema,
} from "./journal.js";
import {
  AttemptRecordedPayloadSchema,
  LOOP_EVENT_TYPES,
  LoopResumedPayloadSchema,
  LoopStoppedPayloadSchema,
} from "./loop.js";
import {
  LESSON_EVENT_TYPES,
  LessonsPromotedPayloadSchema,
  LessonsRecordedPayloadSchema,
  MEMORY_EVENT_TYPES,
  RetrospectiveProposedPayloadSchema,
} from "./memory.js";
import { MERGE_EVENT_TYPES, StoryMergedPayloadSchema } from "./merge.js";
import {
  MERGE_ORDER_EVENT_TYPES,
  StoryConflictQualifiedPayloadSchema,
  StoryMergeRefreshedPayloadSchema,
} from "./merge-order.js";
import { METHOD_EVENT_TYPES, MethodMigratedPayloadSchema } from "./migration.js";
import {
  PRODUCT_KEY_EVENT_TYPES,
  ProductKeyCreatedPayloadSchema,
  SENSITIVE_EVENT_DOMAINS,
} from "./product-key.js";
import {
  READINESS_EVENT_TYPES,
  ReadinessReportedPayloadSchema,
  ReadinessSettledPayloadSchema,
} from "./readiness.js";
import {
  AuditReportedPayloadSchema,
  GapSettledPayloadSchema,
  REQUIREMENT_EVENT_TYPES,
  RequirementProvedPayloadSchema,
  RequirementsRegisteredPayloadSchema,
} from "./requirements.js";
import {
  FreeReviewedPayloadSchema,
  REVIEW_EVENT_TYPES,
  StoryReviewedPayloadSchema,
  StoryReviewPublishedPayloadSchema,
  StoryReviewTriagedPayloadSchema,
} from "./review.js";
import { SPRINT_EVENT_TYPES, SprintPlannedPayloadSchema } from "./sprint.js";
import {
  STACK_EVENT_TYPES,
  StackAnsweredPayloadSchema,
  StackOpenedPayloadSchema,
} from "./stack.js";
import {
  STORY_EVENT_TYPES,
  StoryPrOpenedPayloadSchema,
  StoryStartedPayloadSchema,
} from "./story.js";
import {
  TABLE_EVENT_TYPES,
  TableClosedPayloadSchema,
  TableProposedPayloadSchema,
} from "./table.js";
import { TEST_REVIEW_EVENT_TYPES, TestsReviewedPayloadSchema } from "./test-quality.js";
import {
  DEVIATION_EVENT_TYPES,
  DeviationReportedPayloadSchema,
  DeviationResolvedPayloadSchema,
} from "./trace.js";
import { ExternalReadPayloadSchema, SESSION_EVENT_TYPES } from "./trust.js";
import { USAGE_EVENT_TYPES, UsageMeasuredPayloadSchema } from "./usage.js";
import {
  WRITE_GUARD_EVENT_TYPES,
  WriteDoubtedPayloadSchema,
  WriteRefusedPayloadSchema,
} from "./write-guard.js";

/** One known event type: its current version and the schema of its `payload`. */
export interface EventTypeSpec {
  readonly version: number;
  readonly payload: z.ZodType<Record<string, unknown>>;
  /**
   * Sensitive content: its `payload` is written encrypted with the product key
   * (`payload_enc`), and read only by a machine holding that key.
   */
  readonly sensitive?: boolean;
}

/**
 * Every event type this engine knows. A journal holding another type, or a newer version of one
 * of these, needs a newer engine (`UPGRADE_REQUIRED`). The agents' types come,
 * the checkpoints', the creator's key and resolutions, the
 * product key, the format's migrations, the external reads
 * of untrusted sessions.
 */
export const EVENT_TYPE_REGISTRY: Readonly<Record<string, EventTypeSpec>> = {
  [EVENT_TYPES.deviceRegistered]: { version: 1, payload: DeviceRegisteredPayloadSchema },
  [EVENT_TYPES.productCreated]: { version: 1, payload: ProductCreatedPayloadSchema },
  // Version 2: the `skill` an agent starts (version 1 converts as is).
  [AGENT_EVENT_TYPES.statusReported]: {
    version: currentVersionOf(AGENT_EVENT_TYPES.statusReported),
    payload: StatusReportedPayloadSchema,
  },
  [AGENT_EVENT_TYPES.progressReported]: { version: 1, payload: ProgressReportedPayloadSchema },
  // Version 2: billing, quota, run and cumulative reports (version 1 converts as is).
  [AGENT_EVENT_TYPES.costReported]: {
    version: currentVersionOf(AGENT_EVENT_TYPES.costReported),
    payload: CostReportedPayloadSchema,
    sensitive: true,
  },
  [AGENT_EVENT_TYPES.storyStatusChanged]: { version: 1, payload: StoryStatusChangedPayloadSchema },
  [AGENT_EVENT_TYPES.resultRecorded]: { version: 1, payload: AgentResultSchema },
  // Version 2: `phase_end` and its `phase`, the request and the mark of
  // an untrusted session (version 1 converts as is).
  [CHECKPOINT_EVENT_TYPES.opened]: {
    version: currentVersionOf(CHECKPOINT_EVENT_TYPES.opened),
    payload: CheckpointOpenedPayloadSchema,
  },
  [CHECKPOINT_EVENT_TYPES.measured]: { version: 1, payload: CheckpointMeasuredPayloadSchema },
  [CHECKPOINT_EVENT_TYPES.resolved]: { version: 1, payload: CheckpointResolvedPayloadSchema },
  [HUMAN_EVENT_TYPES.keyRegistered]: { version: 1, payload: HumanKeyRegisteredPayloadSchema },
  [HUMAN_EVENT_TYPES.presenceLinked]: { version: 1, payload: HumanPresenceLinkedPayloadSchema },
  [HUMAN_EVENT_TYPES.keyEndorsed]: { version: 1, payload: HumanKeyEndorsedPayloadSchema },
  [PRODUCT_KEY_EVENT_TYPES.keyCreated]: { version: 1, payload: ProductKeyCreatedPayloadSchema },
  /**
   * The registry of trusted devices: a device paired, revoked, confirmed, the
   * root certified by the first phone, and an alert dismissed by the creator. Clear: every
   * machine reads them.
   */
  [DEVICE_TRUST_EVENT_TYPES.paired]: { version: 1, payload: DevicePairedPayloadSchema },
  [DEVICE_TRUST_EVENT_TYPES.revoked]: { version: 1, payload: DeviceRevokedPayloadSchema },
  [DEVICE_TRUST_EVENT_TYPES.rootCertified]: {
    version: 1,
    payload: DeviceRootCertifiedPayloadSchema,
  },
  [DEVICE_TRUST_EVENT_TYPES.confirmed]: { version: 1, payload: DeviceConfirmedPayloadSchema },
  [DEVICE_TRUST_EVENT_TYPES.dismissed]: { version: 1, payload: TrustDismissedPayloadSchema },
  /** Reserved to tests: any payload. */
  [TEST_EVENT_TYPE]: { version: 1, payload: z.record(z.string(), z.unknown()) },
  [METHOD_EVENT_TYPES.migrated]: { version: 1, payload: MethodMigratedPayloadSchema },
  /** An external read of an untrusted session. */
  [SESSION_EVENT_TYPES.externalRead]: { version: 1, payload: ExternalReadPayloadSchema },
  /** A write refused by a named rule, or let through in doubt. */
  [WRITE_GUARD_EVENT_TYPES.refused]: { version: 1, payload: WriteRefusedPayloadSchema },
  [WRITE_GUARD_EVENT_TYPES.doubted]: { version: 1, payload: WriteDoubtedPayloadSchema },
  /** A sprint proposed to the creator, in force once its checkpoint is approved. */
  [SPRINT_EVENT_TYPES.planned]: { version: 1, payload: SprintPlannedPayloadSchema },
  /** An item of the register of deferred work, and its closing. */
  [DEFERRED_EVENT_TYPES.recorded]: { version: 1, payload: DeferredRecordedPayloadSchema },
  [DEFERRED_EVENT_TYPES.closed]: { version: 1, payload: DeferredClosedPayloadSchema },
  /** The register of non-functional requirements, their proofs, gaps and audits. */
  [REQUIREMENT_EVENT_TYPES.registered]: {
    version: 1,
    payload: RequirementsRegisteredPayloadSchema,
  },
  [REQUIREMENT_EVENT_TYPES.proved]: {
    version: currentVersionOf(REQUIREMENT_EVENT_TYPES.proved),
    payload: RequirementProvedPayloadSchema,
  },
  [REQUIREMENT_EVENT_TYPES.gapSettled]: { version: 1, payload: GapSettledPayloadSchema },
  [REQUIREMENT_EVENT_TYPES.audited]: { version: 1, payload: AuditReportedPayloadSchema },
  /** The review of the tests of a story or of the product. */
  [TEST_REVIEW_EVENT_TYPES.reviewed]: { version: 1, payload: TestsReviewedPayloadSchema },
  /** The critique of a deliverable, the gestures on its objections, the hypotheses. */
  [CRITIQUE_EVENT_TYPES.reported]: { version: 1, payload: CritiqueReportedPayloadSchema },
  [CRITIQUE_EVENT_TYPES.proposed]: { version: 1, payload: CritiqueProposedPayloadSchema },
  [CRITIQUE_EVENT_TYPES.settled]: { version: 1, payload: CritiqueSettledPayloadSchema },
  [CRITIQUE_EVENT_TYPES.closed]: { version: 1, payload: HypothesisClosedPayloadSchema },
  /** The readiness gate: a judged report with the verdict, the creator's gestures on its findings. */
  [READINESS_EVENT_TYPES.reported]: { version: 1, payload: ReadinessReportedPayloadSchema },
  [READINESS_EVENT_TYPES.settled]: { version: 1, payload: ReadinessSettledPayloadSchema },
  /** A round table of agents closed, with its synthesis and the gesture made of it. */
  [TABLE_EVENT_TYPES.proposed]: { version: 1, payload: TableProposedPayloadSchema },
  [TABLE_EVENT_TYPES.closed]: { version: 1, payload: TableClosedPayloadSchema },
  /** A correction of course, the creator's gestures on its stack, its closing. */
  [COURSE_EVENT_TYPES.opened]: { version: 1, payload: CourseOpenedPayloadSchema },
  [COURSE_EVENT_TYPES.decided]: { version: 1, payload: CourseDecidedPayloadSchema },
  [COURSE_EVENT_TYPES.closed]: { version: 1, payload: CourseClosedPayloadSchema },
  /** A story started in its own branch and worktree. */
  [STORY_EVENT_TYPES.started]: { version: 1, payload: StoryStartedPayloadSchema },
  /** A story's cost reached its alert ratio or went over its ceiling. */
  [BUDGET_EVENT_TYPES.thresholdReached]: {
    version: 1,
    payload: BudgetThresholdReachedPayloadSchema,
  },
  /** A story's pull request opened or updated. */
  [STORY_EVENT_TYPES.prOpened]: { version: 1, payload: StoryPrOpenedPayloadSchema },
  /** The CI of a story's pull request, as the forge reported it. */
  [CI_EVENT_TYPES.reported]: { version: 1, payload: CiReportedPayloadSchema },
  /** The creator accepts a story without a readable CI, for one commit. */
  [CI_EVENT_TYPES.waived]: { version: 1, payload: CiWaivedPayloadSchema },
  /** A deviation of a story from the requirements it cites, and its resolution. */
  [DEVIATION_EVENT_TYPES.reported]: { version: 1, payload: DeviationReportedPayloadSchema },
  [DEVIATION_EVENT_TYPES.resolved]: { version: 1, payload: DeviationResolvedPayloadSchema },
  /** A story's independent review, its triage and its posting on the pull request. */
  [REVIEW_EVENT_TYPES.reviewed]: { version: 1, payload: StoryReviewedPayloadSchema },
  [REVIEW_EVENT_TYPES.triaged]: { version: 1, payload: StoryReviewTriagedPayloadSchema },
  [REVIEW_EVENT_TYPES.published]: { version: 1, payload: StoryReviewPublishedPayloadSchema },
  /** A review of a change that belongs to no story. */
  [REVIEW_EVENT_TYPES.freeReviewed]: { version: 1, payload: FreeReviewedPayloadSchema },
  /**
   * The creator's answer relayed from the chat, the recommended option applied at the `auto`
   * level, and its cancelling.
   */
  [CHAT_EVENT_TYPES.answered]: {
    version: currentVersionOf(CHAT_EVENT_TYPES.answered),
    payload: CheckpointAnsweredPayloadSchema,
  },
  [CHAT_EVENT_TYPES.autoApplied]: { version: 1, payload: CheckpointAutoAppliedPayloadSchema },
  [CHAT_EVENT_TYPES.reopened]: { version: 1, payload: CheckpointReopenedPayloadSchema },
  /**
   * An action reserved to the creator, carried out by the engine once approved;
   * version 2 adds the source `elicitation` (version 1 converts as is).
   */
  [CREATOR_ACTION_EVENT_TYPES.executed]: {
    version: currentVersionOf(CREATOR_ACTION_EVENT_TYPES.executed),
    payload: CreatorActionExecutedPayloadSchema,
  },
  /** A handover of Noah's to an agent or a skill. */
  [DELEGATION_EVENT_TYPES.delegated]: { version: 1, payload: AgentDelegatedPayloadSchema },
  /**
   * The memory of the product: a retrospective's content (sensitive: encrypted), the
   * lessons recorded and the lesson promoted (clear: identifiers and digests only).
   */
  [MEMORY_EVENT_TYPES.retrospectiveProposed]: {
    version: 1,
    payload: RetrospectiveProposedPayloadSchema,
    sensitive: true,
  },
  [LESSON_EVENT_TYPES.recorded]: { version: 1, payload: LessonsRecordedPayloadSchema },
  [LESSON_EVENT_TYPES.promoted]: { version: 1, payload: LessonsPromotedPayloadSchema },
  /** The creator's answer chosen in the AI tool's form the engine asked for. */
  [ELICITATION_EVENT_TYPES.answered]: {
    version: currentVersionOf(ELICITATION_EVENT_TYPES.answered),
    payload: CheckpointElicitedPayloadSchema,
  },
  /** A story merged by the engine once the creator approved its merge checkpoint. */
  // Version 2: a merge without a pull request (`direct`); version 1 converts as is.
  [MERGE_EVENT_TYPES.merged]: {
    version: currentVersionOf(MERGE_EVENT_TYPES.merged),
    payload: StoryMergedPayloadSchema,
  },
  /** The creator chose, or changed, their Git workflow. */
  [GIT_EVENT_TYPES.workflowSet]: { version: 1, payload: GitWorkflowSetPayloadSchema },
  /** What waited in staging went into production. */
  [GIT_EVENT_TYPES.released]: { version: 1, payload: GitReleasedPayloadSchema },
  /** The fast track of a story: entered, checked by the engine, left. */
  [FAST_TRACK_EVENT_TYPES.entered]: { version: 1, payload: FastTrackEnteredPayloadSchema },
  [FAST_TRACK_EVENT_TYPES.checked]: { version: 1, payload: FastTrackCheckedPayloadSchema },
  [FAST_TRACK_EVENT_TYPES.left]: { version: 1, payload: FastTrackLeftPayloadSchema },
  /** A criterion of a story seen red or green by a test, or declared untestable. */
  [CRITERION_EVENT_TYPES.recorded]: { version: 1, payload: CriterionRecordedPayloadSchema },
  /** The acceptance QA of a story in a browser: verdicts, proofs and their fingerprints. */
  [QA_EVENT_TYPES.reported]: { version: 1, payload: QaReportedPayloadSchema },
  /** The bounded loop: an approach tried on a story, a stop, a resumption. */
  [LOOP_EVENT_TYPES.attempt]: { version: 1, payload: AttemptRecordedPayloadSchema },
  [LOOP_EVENT_TYPES.stopped]: { version: 1, payload: LoopStoppedPayloadSchema },
  [LOOP_EVENT_TYPES.resumed]: { version: 1, payload: LoopResumedPayloadSchema },
  /** A conflict with the main branch qualified by the story's developer. */
  [MERGE_ORDER_EVENT_TYPES.conflictQualified]: {
    version: 1,
    payload: StoryConflictQualifiedPayloadSchema,
  },
  /** The merge checkpoint of a story reviewed again, refreshed. */
  [MERGE_ORDER_EVENT_TYPES.mergeRefreshed]: {
    version: 1,
    payload: StoryMergeRefreshedPayloadSchema,
  },
  /**
   * A stack of open checkpoints presented together and the creator's answer to it, written as one
   * event that the projection turns into one answer per point approved.
   */
  [STACK_EVENT_TYPES.opened]: { version: 1, payload: StackOpenedPayloadSchema },
  [STACK_EVENT_TYPES.answered]: {
    version: currentVersionOf(STACK_EVENT_TYPES.answered),
    payload: StackAnsweredPayloadSchema,
  },
  /** A planned installation let through without asking and shown in the activity. */
  [INSTALL_EVENT_TYPES.recorded]: { version: 1, payload: InstallRecordedPayloadSchema },
  /**
   * A point closed by the engine because its object is settled; version 2 adds the
   * reason `step_skipped` (version 1 converts as is).
   */
  [CHECKPOINT_CLOSED_EVENT_TYPES.closed]: {
    version: currentVersionOf(CHECKPOINT_CLOSED_EVENT_TYPES.closed),
    payload: CheckpointClosedPayloadSchema,
  },
  /** A point decided by the agent responsible for it, the creator not keeping it. */
  [CHECKPOINT_DECIDED_EVENT_TYPES.decided]: {
    version: 1,
    payload: CheckpointDecidedPayloadSchema,
  },
  /** A session of an AI tool measured by the engine from the tool's traces. */
  [USAGE_EVENT_TYPES.measured]: {
    // Version 2: the step and the skill of a part (version 1 converts as is).
    version: currentVersionOf(USAGE_EVENT_TYPES.measured),
    payload: UsageMeasuredPayloadSchema,
    sensitive: true,
  },
};

/** True for a type reserved to tests (`test.*`): refused or ignored unless tests allow it. */
export function isTestEventType(type: string): boolean {
  return type.startsWith("test.");
}

/**
 * True for a type whose content is sensitive: marked so in the registry (`cost.reported`), or of
 * a sensitive domain (`salle.*`, `security.*`, `memory.*`), known yet or not.
 */
export function isSensitiveEventType(type: string): boolean {
  if (eventTypeSpec(type)?.sensitive === true) return true;
  const domain = type.split(".")[0] ?? "";
  return SENSITIVE_EVENT_DOMAINS.includes(domain);
}

/** The known types, in code point order. */
export const KNOWN_EVENT_TYPES: readonly string[] = Object.keys(EVENT_TYPE_REGISTRY).sort();

export function eventTypeSpec(type: string): EventTypeSpec | undefined {
  return Object.hasOwn(EVENT_TYPE_REGISTRY, type) ? EVENT_TYPE_REGISTRY[type] : undefined;
}

/**
 * `UPGRADE_REQUIRED` when this engine does not know `type`, or knows only an older version of
 * it (`details: { type, version, supported }`, `supported` being null for an unknown type);
 * undefined when it can read it.
 */
export function eventTypeUpgrade(type: string, version: number): CodedErrorPayload | undefined {
  const spec = eventTypeSpec(type);
  if (spec !== undefined && version <= spec.version) return undefined;
  return {
    code: ErrorCode.UPGRADE_REQUIRED,
    message_key: "error.event_type_upgrade_required",
    details: { type, version, supported: spec?.version ?? null },
  };
}

export type CurrentEventResult =
  | { readonly ok: true; readonly event: EventEnvelope }
  | { readonly ok: false; readonly error: CodedErrorPayload };

/**
 * The event in its type's current format: older versions converted step by step (the file is
 * never rewritten), then the `payload` checked by the type's schema. `UPGRADE_REQUIRED` for an
 * unknown type or a newer version; `EVENT_INVALID` (`payload`, or `v` without conversion) else.
 * An encrypted payload (`payload_enc`) is left as is.
 */
export function currentEvent(event: EventEnvelope): CurrentEventResult {
  const upgrade = eventTypeUpgrade(event.type, event.v);
  if (upgrade !== undefined) return { ok: false, error: upgrade };
  const spec = eventTypeSpec(event.type) as EventTypeSpec;
  let current = event;
  for (let version = event.v; version < spec.version; version++) {
    const conversion = eventConversion(event.type, version);
    if (conversion === undefined)
      return { ok: false, error: eventInvalid("v", EVENT_REASON.invalidValue) };
    current = {
      ...current,
      v: version + 1,
      ...(current.payload === undefined ? {} : { payload: conversion.convert(current.payload) }),
    };
  }
  if (current.payload !== undefined) {
    const checked = spec.payload.safeParse(current.payload);
    if (!checked.success) {
      const path = checked.error.issues[0]?.path.map(String) ?? [];
      return {
        ok: false,
        error: eventInvalid(["payload", ...path].join("."), EVENT_REASON.invalidValue),
      };
    }
  }
  return { ok: true, event: current };
}
