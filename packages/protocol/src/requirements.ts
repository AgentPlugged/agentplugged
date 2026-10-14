import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { CheckpointIdSchema } from "./checkpoint.js";
import { canonicalStoryId, hasControlCharacter } from "./deferred.js";
import { AgentIdSchema } from "./method-config.js";
import {
  PROOF_COMMAND_NAME_PATTERN,
  REGISTERED_REQUIREMENT_PATTERN,
  RegisteredRequirementIdSchema,
  RegisteredRequirementInputSchema,
} from "./requirement-id.js";
import { FINDING_SEVERITIES, ReviewPathSchema } from "./review.js";
import { CommitIdSchema } from "./story.js";

/**
 * The non-functional requirements and their proofs. The engine reads the `ENF-n` of
 * the PRD and the numbered budgets of the architecture's decisions (`AD-n`) into a register: for
 * each one a pillar, the proof it expects and its state (proven, failed, without proof). A proof is
 * an event of the journal with its source and its date; one older than the last change of the code
 * it covers is not valid any more. The `release` point is not approved while a requirement has no
 * valid proof or a failed one, unless the creator settled the gap (fix, accept the risk, defer).
 */

export {
  PROOF_COMMAND_NAME_PATTERN,
  REGISTERED_REQUIREMENT_PATTERN,
  RegisteredRequirementIdSchema,
  RegisteredRequirementInputSchema,
};

/** Event types, each at version 1. */
export const REQUIREMENT_EVENT_TYPES = {
  registered: "requirements.registered",
  proved: "requirement.proved",
  gapSettled: "requirement.gap_settled",
  audited: "audit.reported",
} as const;

/** The pillars a requirement belongs to. Identifiers are stable. */
export const REQUIREMENT_PILLARS = [
  "performance",
  "reliability",
  "security",
  "maintainability",
  "accessibility",
  "dependencies",
  "tests",
  "interface",
] as const;
export type RequirementPillar = (typeof REQUIREMENT_PILLARS)[number];

/** What a proof is: a test that cites the requirement, a CI, an analysis, a measure, a review. */
export const PROOF_KINDS = ["test", "ci", "analysis", "measure", "review"] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];

export const PROOF_RESULTS = ["pass", "fail"] as const;
export type ProofResult = (typeof PROOF_RESULTS)[number];

/** Where a requirement stands. */
export const REQUIREMENT_PROOF_STATES = ["proven", "failed", "unproven"] as const;
export type RequirementProofState = (typeof REQUIREMENT_PROOF_STATES)[number];

/** The three ways to settle a gap; the creator chooses, one gesture each. */
export const GAP_DECISIONS = ["fix", "accept", "defer"] as const;
export type GapDecision = (typeof GAP_DECISIONS)[number];

/** The most requirements a register holds. */
export const MAX_REGISTERED_REQUIREMENTS = 300;

const NO_CONTROL = { message: "expected no control character" };

const lineText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !/[\r\n]/.test(text), { message: "expected a single line" })
    .refine((text) => !hasControlCharacter(text, false), NO_CONTROL);

const longText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !hasControlCharacter(text, true), NO_CONTROL);

/** A numbered bound: at most (`max`) or at least (`min`) a value, in a unit as written. */
export const RequirementBudgetSchema = z.strictObject({
  op: z.enum(["max", "min"]),
  value: z.number().finite(),
  unit: z.string().trim().max(16),
});
export type RequirementBudget = z.infer<typeof RequirementBudgetSchema>;

const StoriesSchema = z
  .array(StoryIdSchema.refine((id) => canonicalStoryId(id) === id))
  .max(100)
  .refine((stories) => new Set(stories).size === stories.length, {
    message: "stories must differ",
  });

/** One requirement of the register, as read from the documents. */
export const RequirementEntrySchema = z.strictObject({
  id: RegisteredRequirementIdSchema,
  pillar: z.enum(REQUIREMENT_PILLARS),
  /** The proof the requirement expects. */
  proof: z.enum(PROOF_KINDS),
  text: lineText(240),
  budget: RequirementBudgetSchema.optional(),
  /** The commands the project declares for it (between backticks in its text). */
  commands: z.array(lineText(200)).max(4),
  /** The stories that cite it: the code it covers. None: all the code. */
  stories: StoriesSchema,
  /** A short digest of what the entry says: a proof is valid for this digest only. */
  digest: z.string().regex(/^[0-9a-f]{12}$/),
});
export type RequirementEntry = z.infer<typeof RequirementEntrySchema>;

/** `payload` of `requirements.registered`: the whole register, replaced. */
export const RequirementsRegisteredPayloadSchema = z.strictObject({
  items: z
    .array(RequirementEntrySchema)
    .max(MAX_REGISTERED_REQUIREMENTS)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
      message: "requirements must differ",
    }),
});
export type RequirementsRegisteredPayload = z.infer<typeof RequirementsRegisteredPayloadSchema>;

/** Who produced a proof: the engine (it ran the project's command or read the CI) or an agent that reported it. */
export const PROOF_ORIGINS = ["engine", "reported"] as const;
export type ProofOrigin = (typeof PROOF_ORIGINS)[number];

/** How a command run ended: it exited (any code), the engine stopped it at its time limit, it never started. */
export const PROOF_RUN_ENDS = ["exit", "timeout", "error"] as const;

/**
 * What the engine inscribes of a run of a command of the project: the command (its
 * name and its fingerprint, the one the creator accepted), how it ended, how long it took, the commit
 * tested and whether the working copy was clean, and a bounded summary of the output, secrets masked.
 */
export const ProofRunSchema = z.strictObject({
  command: z.string().regex(PROOF_COMMAND_NAME_PATTERN),
  fingerprint: z.string().regex(/^[0-9a-f]{24}$/),
  ended: z.enum(PROOF_RUN_ENDS),
  /** The exit code; null when the command was stopped or never started. */
  exit: z.int().min(-2_147_483_648).max(2_147_483_647).nullable(),
  ms: z.int().min(0).max(86_400_000),
  commit: CommitIdSchema.optional(),
  /** False when the working copy had changes not committed; absent when Git could not say. */
  clean: z.boolean().optional(),
  summary: longText(700),
});
export type ProofRun = z.infer<typeof ProofRunSchema>;

/** `payload` of `requirement.proved`. */
export const RequirementProvedPayloadSchema = z.strictObject({
  requirement: RegisteredRequirementIdSchema,
  kind: z.enum(PROOF_KINDS),
  result: z.enum(PROOF_RESULTS),
  /** Where the proof comes from: a test (path:line), a CI run, a command, a measure, a review. */
  source: lineText(300),
  measured: z.number().finite().optional(),
  budget: RequirementBudgetSchema.optional(),
  note: longText(500).optional(),
  /** The digest of the requirement's entry the proof was made for. */
  entry: z.string().regex(/^[0-9a-f]{12}$/),
  commit: CommitIdSchema.optional(),
  /**
   * `engine`: the proof comes from a run of a command of the project by the engine
   * itself, described by `run`. Absent: an agent reported it.
   */
  origin: z.literal("engine").optional(),
  run: ProofRunSchema.optional(),
});
export type RequirementProvedPayload = z.infer<typeof RequirementProvedPayloadSchema>;

/** `payload` of `requirement.gap_settled`: the creator's decision on a gap, relayed by an agent. */
export const GapSettledPayloadSchema = z.strictObject({
  requirement: RegisteredRequirementIdSchema,
  decision: z.enum(GAP_DECISIONS),
  reason: longText(1000),
  /** The point the creator answered. */
  checkpoint: CheckpointIdSchema,
  /** The version the requirement is deferred to (`defer`). */
  version: lineText(40).optional(),
});
export type GapSettledPayload = z.infer<typeof GapSettledPayloadSchema>;

/** The pillars an audit covers (a different cut than the register's: it audits the work). */
export const AUDIT_PILLARS = [
  "quality",
  "architecture",
  "security",
  "dependencies",
  "performance",
  "tests",
  "interface",
  "accessibility",
] as const;
export type AuditPillar = (typeof AUDIT_PILLARS)[number];

export const AUDIT_VERDICTS = ["pass", "issues", "not_applicable"] as const;
export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

/** What a finding becomes: a gap on a requirement, a story proposed, or a note. */
export const AUDIT_ACTIONS = ["gap", "story", "note"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The most files an audit lists as read for one pillar: an audit reads a pillar, not the repository. */
export const MAX_AUDIT_READS = 40;
/** Findings one audit holds, at most. */
export const MAX_AUDIT_FINDINGS = 60;

/** The result of one audited pillar. */
export const AuditPillarResultSchema = z.strictObject({
  pillar: z.enum(AUDIT_PILLARS),
  verdict: z.enum(AUDIT_VERDICTS),
  /** The files the audit read for this pillar (checked by the engine: at least one, 40 at most). */
  reads: z.array(ReviewPathSchema).max(MAX_AUDIT_READS + 10),
  summary: longText(400),
  /** The requirements this pillar's audit checked and found tenable: each becomes a proof. */
  verified: z.array(RegisteredRequirementInputSchema).max(20).optional(),
});
export type AuditPillarResult = z.infer<typeof AuditPillarResultSchema>;

/** One finding of an audit. */
export const AuditFindingSchema = z.strictObject({
  pillar: z.enum(AUDIT_PILLARS),
  severity: z.enum(FINDING_SEVERITIES),
  /** `path` or `path:line`. */
  where: lineText(220),
  what: lineText(300),
  /** What to do; required unless the finding is minor. */
  fix: lineText(200).optional(),
  /** The requirement the finding fails (required for a `gap`). */
  requirement: RegisteredRequirementInputSchema.optional(),
  action: z.enum(AUDIT_ACTIONS),
});
export type AuditFinding = z.infer<typeof AuditFindingSchema>;

/** Input of `submit_audit`: the fixed report of an audit of one pillar or several. */
export const SubmitAuditInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  commit: CommitIdSchema.optional(),
  /** One result per audited pillar: one pillar, or all. */
  results: z.array(AuditPillarResultSchema).min(1).max(AUDIT_PILLARS.length),
  findings: z.array(AuditFindingSchema).max(MAX_AUDIT_FINDINGS),
});
export type SubmitAuditInput = z.infer<typeof SubmitAuditInputSchema>;

/** `payload` of `audit.reported`: the pillars, their verdicts and the number of findings. */
export const AuditReportedPayloadSchema = z.strictObject({
  pillars: z.array(
    z.strictObject({
      pillar: z.enum(AUDIT_PILLARS),
      verdict: z.enum(AUDIT_VERDICTS),
      findings: z.number().int().min(0).max(MAX_AUDIT_FINDINGS),
      reads: z
        .number()
        .int()
        .min(0)
        .max(MAX_AUDIT_READS + 10),
    }),
  ),
  commit: CommitIdSchema.optional(),
});
export type AuditReportedPayload = z.infer<typeof AuditReportedPayloadSchema>;

/** Input of `sync_requirements`: the agent that reads the documents into the register. */
export const SyncRequirementsInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
});
export type SyncRequirementsInput = z.infer<typeof SyncRequirementsInputSchema>;

/** True for a way to settle a gap. */
export function isGapDecision(value: string): value is GapDecision {
  return (GAP_DECISIONS as readonly string[]).includes(value);
}

/**
 * Input of `record_proof`: a proof for a requirement, of the kind the register expects of it
 * (never typed by the agent: the tool list stays short). A requirement that expects a measure gets
 * `measured` (the engine compares it with the budget and decides the result); the others get
 * `passed`.
 */
export const RecordProofInputSchema = z
  .strictObject({
    agent: AgentIdSchema.max(64),
    requirement: RegisteredRequirementInputSchema,
    passed: z.boolean().optional(),
    source: lineText(300),
    measured: z.number().finite().optional(),
  })
  .refine((input) => input.passed !== undefined || input.measured !== undefined, {
    message: "give `passed` (true or false), or `measured` for a requirement with a budget",
    path: ["passed"],
  })
  .refine((input) => input.passed === undefined || input.measured === undefined, {
    message: "give `passed` or `measured`, not both",
    path: ["measured"],
  });
export type RecordProofInput = z.infer<typeof RecordProofInputSchema>;

/**
 * Input of `settle_gap`: the creator's decision on a gap, taken at a `decision` point whose option
 * is the decision (`fix`, `accept` or `defer`), relayed with the point's id and the creator's
 * reason (for a deferral, it names the version). `option` is checked against the three decisions
 * but published as a plain string, to keep the tool list short.
 */
export const SettleGapInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  requirement: RegisteredRequirementInputSchema,
  option: z.string().refine(isGapDecision, { message: `expected ${GAP_DECISIONS.join(", ")}` }),
  checkpoint: CheckpointIdSchema,
  reason: longText(1000),
});
export type SettleGapInput = z.infer<typeof SettleGapInputSchema>;
