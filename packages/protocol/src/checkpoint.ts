import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { CreatorActionRecordSchema } from "./creator-action.js";
import { MemoryRecordSchema } from "./memory.js";
import { AgentIdSchema, PHASE_IDS, type PhaseId } from "./method-config.js";
import {
  MAX_PUBLICATION_FILES,
  PublicationInputSchema,
  PublicationRecordSchema,
} from "./publication.js";
import { ActionRequestSchema, UntrustedMarkSchema } from "./trust.js";

/**
 * Checkpoints: a typed stop where an agent asks the creator for a decision. Agents
 * open one (`open_checkpoint`), or `submit_result` with `blocked` opens one; while it is open,
 * the actions it blocks are refused (`CHECKPOINT_OPEN`). Its id is drawn from the event that
 * opens it (`G-` then the last 10 characters of its ULID), never written in the `payload`; its
 * story is the envelope's `story`. Nothing an agent calls resolves, validates, waives or closes
 * a checkpoint: only the creator does, at the terminal (`checkpoint.resolved`).
 */

/** Event types of checkpoints, each at version 1. */
export const CHECKPOINT_EVENT_TYPES = {
  opened: "checkpoint.opened",
  measured: "checkpoint.measured",
  resolved: "checkpoint.resolved",
} as const;

/** What a checkpoint asks for. */
export const CHECKPOINT_TYPES = [
  "document",
  "decision",
  "story",
  "permission",
  "release",
  "publication",
  /** The end of a phase: its `phase` is closed once the creator approves it. */
  "phase_end",
  /**
   * An action reserved to the creator, asked from the chat: opened by the engine
   * only (`request_creator_action`), never by `open_checkpoint`; the engine carries it out once
   * the creator approves it.
   */
  "creator_action",
  /**
   * A change of the memory of the product, validated by the creator: the lessons of a
   * retrospective, or the promotion of a lesson to the common memory. Opened by the engine only
   * (`propose_retrospective`, `propose_promotion`), never by `open_checkpoint`.
   */
  "memory",
] as const;
export type CheckpointType = (typeof CHECKPOINT_TYPES)[number];

export const CHECKPOINT_RISKS = ["low", "medium", "high"] as const;
export type CheckpointRisk = (typeof CHECKPOINT_RISKS)[number];

/**
 * Who must answer, from the least to the most demanding. Every role is the creator today;
 * the role is recorded all the same.
 */
export const RECIPIENT_ROLES = ["creator", "product", "tech_lead", "security"] as const;
export type RecipientRole = (typeof RECIPIENT_ROLES)[number];

/**
 * How the answer must be confirmed: a gesture undoable for 10 s (low or medium risk) or
 * the creator's presence (high risk, a `presence` signature), at the terminal.
 * `explicit` (a second confirmation for an irreversible action) is retired: the
 * engine no longer asks it, and only reads it in journals written before.
 */
export const CONFIRMATION_MODES = ["gesture_undo_10s", "presence", "explicit"] as const;
export type ConfirmationMode = (typeof CONFIRMATION_MODES)[number];

/**
 * The actions a checkpoint can block: `story.review` (moving a story to review), `story.complete`
 * (a `complete` result), and the deployment, publication and permission uses to come.
 */
export const BLOCKABLE_ACTIONS = [
  "story.review",
  "story.complete",
  "release.deploy",
  "publication.publish",
  "permission.use",
] as const;
export type BlockableAction = (typeof BLOCKABLE_ACTIONS)[number];

export const CRITERION_OPERATORS = [">=", "<=", "=="] as const;
export type CriterionOperator = (typeof CRITERION_OPERATORS)[number];

/** A `blocking` criterion not met fails the verdict; a `reservation` one only qualifies it. */
export const CRITERION_SEVERITIES = ["blocking", "reservation"] as const;
export type CriterionSeverity = (typeof CRITERION_SEVERITIES)[number];

export const VERDICT_RESULTS = ["pass", "pass_with_reservations", "fail"] as const;
export type VerdictResult = (typeof VERDICT_RESULTS)[number];

/**
 * A checkpoint is open until the creator answers it: then `resolved`, or `waived`
 * until its waiver's deadline, after which it blocks again. `closed` when the engine
 * closed it itself because its object was settled (the story merged on the forge, the review
 * redone, the request replaced): nobody answered it, and its blocks no longer apply.
 */
export const CHECKPOINT_STATUSES = ["open", "resolved", "waived", "closed"] as const;
export type CheckpointStatus = (typeof CHECKPOINT_STATUSES)[number];

/** Who, in `core`, opened a checkpoint no agent asked for directly. */
export const CHECKPOINT_SOURCES = [
  "blocked_result",
  "untrusted_action",
  /** The forge is not linked when an agent opens a story's pull request. */
  "forge_unlinked",
  /** The merge checkpoint the engine opens once a story's review is done. */
  "merge",
  /** The review loop of a story reached its limit of passes. */
  "review_loop",
  /** A story left the fast track for the full lane. */
  "fast_track",
  /** A conflict of substance between a story's branch and the main branch. */
  "merge_conflict",
  /** A story's approaches failed up to the limit of the bounded loop. */
  "attempt_limit",
] as const;
export type CheckpointSource = (typeof CHECKPOINT_SOURCES)[number];

/** `G-` then the last 10 characters of the ULID of the event that opens the checkpoint. */
export const CheckpointIdSchema = z.string().regex(/^G-[0-9A-HJKMNP-TV-Z]{10}$/, {
  message: "expected G- then 10 characters, for example G-7M2K9QX4TB",
});

/** The id of the checkpoint opened by the event `eventId`: stable, never renumbered. */
export function checkpointIdOf(eventId: string): string {
  return `G-${eventId.slice(-10)}`;
}

/** A free text of 1 to `max` characters. */
const text = (max: number) => z.string().trim().min(1).max(max);

/** A short identifier: an option or a criterion. */
const ShortIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/, {
  message: "expected 1 to 32 letters, digits, dots, hyphens or underscores",
});

/** A measure's name: `tests_failed`, `coverage`, `lighthouse.performance`. */
export const MetricSchema = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/, {
  message: "expected a lowercase name of letters, digits, dots and underscores",
});

/**
 * A path relative to the repository: no leading `/` or `\`, no drive, no `.` or `..` segment, no
 * empty segment, no control character.
 */
export const RelativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) =>
      !/^[/\\]/.test(path) &&
      !/^[A-Za-z]:/.test(path) &&
      ![...path].some((char) => char.charCodeAt(0) < 0x20) &&
      path.split(/[/\\]/).every((part) => part !== "" && part !== "." && part !== ".."),
    { message: "expected a relative path without '.' or '..' segments" },
  );

/**
 * A Git branch name: no whitespace, control character, `~ ^ : ? * [ \`, `..` or `@{`; not
 * starting with `-`, not ending with `/` or `.lock`.
 */
export const BranchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      /^[^\s~^:?*[\\]+$/.test(name) &&
      ![...name].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) &&
      !name.startsWith("-") &&
      !name.includes("..") &&
      !name.includes("@{") &&
      !name.endsWith("/") &&
      !name.endsWith(".lock"),
    { message: "expected a Git branch name" },
  );

/** A document to read: its path, branch and Git blob (SHA-1 or SHA-256). */
export const CheckpointDocumentSchema = z.strictObject({
  path: RelativePathSchema,
  branch: BranchNameSchema,
  blob_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
    message: "expected 40 or 64 lowercase hexadecimal characters",
  }),
});
export type CheckpointDocument = z.infer<typeof CheckpointDocumentSchema>;

/**
 * An action the checkpoint blocks, on its own story, else on the checkpoint's: `open_checkpoint`
 * refuses a block without a story on a checkpoint without one (no product-wide block).
 */
export const CheckpointBlockSchema = z.strictObject({
  action: z.enum(BLOCKABLE_ACTIONS),
  story: StoryIdSchema.optional(),
});
export type CheckpointBlock = z.infer<typeof CheckpointBlockSchema>;

/** One answer of a decision: what it is, and what it entails. */
export const CheckpointOptionSchema = z.strictObject({
  id: ShortIdSchema,
  label: text(200),
  consequence: text(1000),
});
export type CheckpointOption = z.infer<typeof CheckpointOptionSchema>;

/** A rule on a measure: `<metric> <op> <threshold>`. */
export const CheckpointCriterionSchema = z.strictObject({
  id: ShortIdSchema,
  metric: MetricSchema,
  op: z.enum(CRITERION_OPERATORS),
  threshold: z.number().finite(),
  severity: z.enum(CRITERION_SEVERITIES),
});
export type CheckpointCriterion = z.infer<typeof CheckpointCriterionSchema>;

/** Measures reported for a checkpoint: `{ <metric>: number }`, 1 to 50 of them. */
export const MeasuresSchema = z
  .record(MetricSchema, z.number().finite())
  .refine((measures) => Object.keys(measures).length >= 1, { message: "give at least a measure" })
  .refine((measures) => Object.keys(measures).length <= 50, {
    message: "give at most 50 measures",
  });
export type Measures = z.infer<typeof MeasuresSchema>;

/** The longest `effect` of a card: one or two plain sentences. */
export const CARD_EFFECT_MAX = 300;
/** The longest risk or opinion of a card: one plain sentence. */
export const CARD_LINE_MAX = 200;
/** The most risks a card holds: the creator reads it in seconds. */
export const CARD_RISKS_MAX = 3;
/** The most opinions a card holds. */
export const CARD_OPINIONS_MAX = 4;

/**
 * What the creator reads first on a checkpoint, in plain words: what changes for the people who
 * use the product (`effect`), what could go wrong (`risks`) and what the agents consulted think
 * (`opinions`, one sentence each). Optional: a checkpoint without a card is read from its
 * `summary`. The fuller text stays in `summary`, one click away. `why` answers "why this?" in
 * place: one sentence for the reason, one for the alternative set aside.
 */
export const CheckpointCardSchema = z.strictObject({
  effect: text(CARD_EFFECT_MAX),
  why: z
    .strictObject({
      reason: text(CARD_LINE_MAX),
      /** Absent when nothing else was weighed. */
      rejected: text(CARD_LINE_MAX).optional(),
    })
    .optional(),
  risks: z.array(text(CARD_LINE_MAX)).min(1).max(CARD_RISKS_MAX).optional(),
  opinions: z
    .array(z.strictObject({ agent: AgentIdSchema.max(64), view: text(CARD_LINE_MAX) }))
    .min(1)
    .max(CARD_OPINIONS_MAX)
    .optional(),
});
export type CheckpointCard = z.infer<typeof CheckpointCardSchema>;

/** The fields an agent gives, whose defaults `core` fixes (recipient, confirmation). */
const describedFields = {
  type: z.enum(CHECKPOINT_TYPES),
  risk: z.enum(CHECKPOINT_RISKS),
  title: text(120),
  summary: text(2000),
  /** The first lines the creator reads: the effect for the users, the risks, the agents' views. */
  card: CheckpointCardSchema.optional(),
  documents: z.array(CheckpointDocumentSchema).max(20),
  blocks: z.array(CheckpointBlockSchema).max(10),
  options: z.array(CheckpointOptionSchema).min(2).max(4).optional(),
  recommendation: ShortIdSchema.optional(),
  criteria: z.array(CheckpointCriterionSchema).min(1).max(20).optional(),
  /** The phase a `phase_end` checkpoint closes: given with that type, and only with it. */
  phase: z.enum(PHASE_IDS).optional(),
};

interface CheckedFields {
  readonly type: CheckpointType;
  readonly creator_action?: unknown;
  readonly memory?: unknown;
  readonly publication?: unknown;
  readonly supersedes?: string | undefined;
  readonly options?: readonly CheckpointOption[] | undefined;
  readonly recommendation?: string | undefined;
  readonly criteria?: readonly CheckpointCriterion[] | undefined;
  readonly phase?: PhaseId | undefined;
  readonly blocks?: readonly CheckpointBlock[] | undefined;
}

/**
 * The rules across fields: a decision has options; options come with a recommendation that is
 * one of them, and a recommendation never comes without options; option and criterion ids are
 * unique; a `phase` goes with `phase_end`, and only with it, and a `phase_end` blocks nothing.
 */
function checkFields(value: CheckedFields, context: z.RefinementCtx): void {
  // A creator's action: its action, and nothing a decision of the agents has.
  if ((value.type === "creator_action") !== (value.creator_action !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["creator_action"],
      message: "a creator_action goes with its type, and only with it",
    });
  }
  if (value.type === "creator_action") {
    for (const field of ["options", "criteria", "phase", "supersedes"] as const) {
      if (value[field] === undefined) continue;
      context.addIssue({
        code: "custom",
        path: [field],
        message: "a creator_action checkpoint has none",
      });
    }
    if ((value.blocks?.length ?? 0) > 0) {
      context.addIssue({
        code: "custom",
        path: ["blocks"],
        message: "a creator_action checkpoint blocks nothing",
      });
    }
  }
  // A memory change: its record, and nothing a decision of the agents has.
  if ((value.type === "memory") !== (value.memory !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["memory"],
      message: "a memory record goes with its type, and only with it",
    });
  }
  if (value.type === "memory") {
    for (const field of ["options", "criteria", "phase", "supersedes"] as const) {
      if (value[field] === undefined) continue;
      context.addIssue({
        code: "custom",
        path: [field],
        message: "a memory checkpoint has none",
      });
    }
    if ((value.blocks?.length ?? 0) > 0) {
      context.addIssue({
        code: "custom",
        path: ["blocks"],
        message: "a memory checkpoint blocks nothing",
      });
    }
  }
  // The presentation of a deliverable goes with its type, and only with it.
  if (value.publication !== undefined && value.type !== "publication") {
    context.addIssue({
      code: "custom",
      path: ["publication"],
      message: "a publication goes with its type, and only with it",
    });
  }
  if ((value.type === "phase_end") !== (value.phase !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["phase"],
      message: "a phase goes with phase_end, and only with it",
    });
  }
  if (value.type === "phase_end" && (value.blocks?.length ?? 0) > 0) {
    context.addIssue({
      code: "custom",
      path: ["blocks"],
      message: "a phase_end checkpoint blocks nothing: the phase follows from its approval",
    });
  }
  if (value.type === "decision" && value.options === undefined) {
    context.addIssue({
      code: "custom",
      path: ["options"],
      message: "a decision needs 2 to 4 options",
    });
  }
  if (value.options !== undefined) {
    const ids = value.options.map((option) => option.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: ["options"], message: "option ids must differ" });
    }
    if (value.recommendation === undefined) {
      context.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "give the id of the recommended option",
      });
    } else if (!ids.includes(value.recommendation)) {
      context.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "expected the id of one of the options",
      });
    }
  } else if (value.recommendation !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["recommendation"],
      message: "a recommendation needs options",
    });
  }
  if (value.criteria !== undefined) {
    const ids = value.criteria.map((criterion) => criterion.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["criteria"],
        message: "criterion ids must differ",
      });
    }
  }
}

const agent = AgentIdSchema.max(64);

/**
 * Input of `open_checkpoint`: the checkpoint without its id. `irreversible` is false and
 * `documents` and `blocks` are empty when absent; `recipient_role` is kept only when it is more
 * demanding than the type's default (`core`).
 */
export const OpenCheckpointInputSchema = z
  .strictObject({
    agent,
    ...describedFields,
    irreversible: z.boolean().optional(),
    recipient_role: z.enum(RECIPIENT_ROLES).optional(),
    story: StoryIdSchema.optional(),
    documents: describedFields.documents.optional(),
    blocks: describedFields.blocks.optional(),
    supersedes: CheckpointIdSchema.optional(),
    /** The angle, audience and short version of a `publication`: required with it. */
    publication: PublicationInputSchema.optional(),
  })
  .superRefine(checkFields)
  .superRefine((value, context) => {
    // A deliverable: presented, its full text cited, and nothing of a decision.
    if (value.type === "publication") {
      if (value.publication === undefined) {
        context.addIssue({
          code: "custom",
          path: ["publication"],
          message: "a publication needs its angle, audience and short_version",
        });
      }
      if ((value.documents?.length ?? 0) < 1) {
        context.addIssue({
          code: "custom",
          path: ["documents"],
          message: `a publication cites the file of its full text (1 to ${MAX_PUBLICATION_FILES})`,
        });
      }
      for (const field of ["options", "criteria"] as const) {
        if (value[field] === undefined) continue;
        context.addIssue({
          code: "custom",
          path: [field],
          message:
            "a publication is approved, refused or sent back: it has no options nor criteria",
        });
      }
    }
    // Only the engine opens a creator's action (`request_creator_action`).
    if (value.type === "creator_action") {
      context.addIssue({
        code: "custom",
        path: ["type"],
        message: "a creator_action is asked with request_creator_action",
      });
    }
    // Only the engine opens a memory change (`propose_retrospective`, `propose_promotion`).
    if (value.type === "memory") {
      context.addIssue({
        code: "custom",
        path: ["type"],
        message: "a memory checkpoint is opened with propose_retrospective or propose_promotion",
      });
    }
    if (value.type === "phase_end" && value.story !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["story"],
        message: "a phase_end checkpoint belongs to no story",
      });
    }
  })
  .superRefine((value, context) => {
    // No product-wide block: each one targets a story, its own or the checkpoint's.
    if (value.story !== undefined) return;
    value.blocks?.forEach((block, index) => {
      if (block.story !== undefined) return;
      context.addIssue({
        code: "custom",
        path: ["blocks", index, "story"],
        message: "give the story this block targets, or the checkpoint's story",
      });
    });
  });
export type OpenCheckpointInput = z.infer<typeof OpenCheckpointInputSchema>;

/**
 * `payload` of `checkpoint.opened`: the checkpoint as `core` completed it (defaults applied,
 * confirmation required), without its id nor its story (the envelope's).
 */
export const CheckpointOpenedPayloadSchema = z
  .strictObject({
    ...describedFields,
    irreversible: z.boolean(),
    recipient_role: z.enum(RECIPIENT_ROLES),
    confirmation: z.array(z.enum(CONFIRMATION_MODES)).min(1).max(3),
    /**
     * Set by `core`, never given by an agent: `blocked_result` on the checkpoint a `blocked`
     * result opens, `untrusted_action` on the one an installation to validate opens (
     * the name is kept, the journals hold it).
     */
    source: z.enum(CHECKPOINT_SOURCES).optional(),
    /**
     * A checkpoint of the same story the creator refused (`rejected`, `changes_requested`):
     * answering this one with a lifting decision lifts its blocks too.
     */
    supersedes: CheckpointIdSchema.optional(),
    /** The installation an `untrusted_action` checkpoint asks for. */
    request: ActionRequestSchema.optional(),
    /** Set by `core` when the session that opened it was untrusted: history only. */
    untrusted: UntrustedMarkSchema.optional(),
    /** The action a `creator_action` checkpoint asks for, set by `core`. */
    creator_action: CreatorActionRecordSchema.optional(),
    /** What a `memory` checkpoint is about, in clear and without content. */
    memory: MemoryRecordSchema.optional(),
    /**
     * The angle, audience and short version of a `publication`. Optional so that a
     * publication opened before this story still reads; `open_checkpoint` requires it.
     */
    publication: PublicationRecordSchema.optional(),
  })
  .superRefine(checkFields);
export type CheckpointOpenedPayload = z.infer<typeof CheckpointOpenedPayloadSchema>;

/** Input of `report_measures`. */
export const ReportMeasuresInputSchema = z.strictObject({
  agent,
  checkpoint: CheckpointIdSchema,
  measures: MeasuresSchema,
});

/** `payload` of `checkpoint.measured`. */
export const CheckpointMeasuredPayloadSchema = z.strictObject({
  checkpoint: CheckpointIdSchema,
  measures: MeasuresSchema,
});
export type CheckpointMeasuredPayload = z.infer<typeof CheckpointMeasuredPayloadSchema>;

/** One criterion as the verdict judged it. */
export interface CriterionVerdict {
  readonly id: string;
  readonly metric: string;
  readonly op: CriterionOperator;
  readonly threshold: number;
  readonly severity: CriterionSeverity;
  /** The last measure of its metric, or null when none was reported. */
  readonly measure: number | null;
  readonly satisfied: boolean;
  /** `missing:<metric>`, or null when the measure was reported. */
  readonly reason: string | null;
}

/** The verdict of a checkpoint's criteria on its last measures. */
export interface CheckpointVerdict {
  readonly result: VerdictResult;
  /** Why it is not a plain pass: `missing:<metric>` for each measure lacking. */
  readonly reasons: readonly string[];
  readonly criteria: readonly CriterionVerdict[];
}

/**
 * The creator's answer to a checkpoint: approve it (with reservations, a note), reject it (a
 * note), ask for changes (an instruction), choose one of a decision's options, or waive a failed
 * verdict until a deadline.
 */
export const RESOLUTION_DECISIONS = [
  "approved",
  "approved_with_reservations",
  "rejected",
  "changes_requested",
  "option_chosen",
  "waived",
] as const;
export type ResolutionDecision = (typeof RESOLUTION_DECISIONS)[number];

/** Where a resolution was made: the terminal only. */
export const RESOLUTION_SOURCES = ["terminal"] as const;
export type ResolutionSource = (typeof RESOLUTION_SOURCES)[number];

/** A waiver lasts at most this many days. */
export const MAX_WAIVER_DAYS = 30;

/** The waivers of one checkpoint, renewals included, last at most this many days in all. */
export const MAX_WAIVED_TOTAL_DAYS = 90;

/** The decisions that lift a checkpoint's blocks (and those of the checkpoint it supersedes). */
export const LIFTING_DECISIONS: ReadonlySet<ResolutionDecision> = new Set([
  "approved",
  "approved_with_reservations",
  "option_chosen",
  "waived",
]);

/** The decisions that need a note (reservations, reason of a refusal, instruction). */
export const NOTE_REQUIRED: ReadonlySet<ResolutionDecision> = new Set([
  "approved_with_reservations",
  "rejected",
  "changes_requested",
]);

/**
 * `payload` of `checkpoint.resolved`, written by the creator only (`actor.kind: human`, signed by
 * the creator's key): `option` exactly for `option_chosen`, `waiver_until` exactly for `waived`, a
 * `note` for the decisions that need one.
 */
export const CheckpointResolvedPayloadSchema = z
  .strictObject({
    checkpoint: CheckpointIdSchema,
    decision: z.enum(RESOLUTION_DECISIONS),
    option: ShortIdSchema.optional(),
    note: text(2000).optional(),
    waiver_until: z.iso.datetime().optional(),
    source: z.enum(RESOLUTION_SOURCES),
  })
  .superRefine((value, context) => {
    if ((value.decision === "option_chosen") !== (value.option !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["option"],
        message: "an option goes with option_chosen, and only with it",
      });
    }
    if ((value.decision === "waived") !== (value.waiver_until !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["waiver_until"],
        message: "a deadline goes with waived, and only with it",
      });
    }
    if (NOTE_REQUIRED.has(value.decision) && value.note === undefined) {
      context.addIssue({ code: "custom", path: ["note"], message: "this decision needs a note" });
    }
  });
export type CheckpointResolvedPayload = z.infer<typeof CheckpointResolvedPayloadSchema>;
