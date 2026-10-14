import { z } from "zod";
import { MAX_QUOTE_LENGTH } from "./chat.js";
import { hasControlCharacter } from "./deferred.js";
import { AgentIdSchema } from "./method-config.js";
import { FINDING_SEVERITIES } from "./review.js";

/**
 * The readiness gate. Before the stories are built, the engine computes what can be
 * computed on the plan as a whole (documents present, validated and unchanged, identifiers known,
 * requirements, stories, journeys and decisions traced both ways), and one agent judges what only
 * a reading can tell: documents that contradict each other, and the places where a developer would
 * have to settle alone a point no document writes down. The agent's report is closed: the engine refuses one
 * that is not whole, and checks every passage against the document it names. The verdict (ready,
 * reserves, blocking) is the engine's, from both. The creator then makes one gesture per finding:
 * have its author correct the document, or accept it with a reason of their own.
 */

/** Event types, each at version 1. */
export const READINESS_EVENT_TYPES = {
  /** A judged report, validated, with the verdict the engine computed (`actor.kind: agent`). */
  reported: "readiness.reported",
  /** The creator's gestures on the findings, relayed by an agent with their words. */
  settled: "readiness.settled",
} as const;

/** The verdicts, from the best to the worst. */
export const READINESS_VERDICTS = ["ready", "reserves", "blocking"] as const;
export type ReadinessVerdict = (typeof READINESS_VERDICTS)[number];

/** What a judged finding is: two documents that disagree, or a decision nothing records. */
export const READINESS_FINDING_KINDS = ["conflict", "gap"] as const;
export type ReadinessFindingKind = (typeof READINESS_FINDING_KINDS)[number];

/** What a call does, told by what it holds. */
export const READINESS_STEPS = ["check", "report", "settle"] as const;
export type ReadinessStep = (typeof READINESS_STEPS)[number];

/** The two gestures of the creator on a finding. */
export const READINESS_GESTURES = ["fix", "accept"] as const;
export type ReadinessGesture = (typeof READINESS_GESTURES)[number];

/** Judged findings one report holds, at most (the short path: `MAX_SHORT_FINDINGS`). */
export const MAX_READINESS_FINDINGS = 12;
export const MAX_SHORT_FINDINGS = 6;
/** Passages one judged finding names, at most. */
export const MAX_READINESS_PASSAGES = 3;
/** The findings a call lists, the graver first: the rest is counted. */
export const MAX_READINESS_LISTED = 12;
/** The option of the decision a blocking verdict opens by which the creator goes on all the same. */
export const READINESS_GO_ON = "go_on";
export const READINESS_FIX_FIRST = "fix_first";

const NO_CONTROL = { message: "expected no control character" };

const lineText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !/[\r\n]/.test(text), { message: "expected a single line" })
    .refine((text) => !hasControlCharacter(text, false), NO_CONTROL);

/**
 * One judged finding as the report gives it. `passages` are `<document>: <passage>`: the document
 * by its id or its file name, then a heading or an identifier (`EF-n`, `ENF-n`, `PU-n`, `AD-n`) it
 * holds; the first one is the document to correct.
 */
export const ReadinessFindingSchema = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES),
  kind: z.enum(READINESS_FINDING_KINDS),
  /** The finding as a statement, one line. */
  claim: lineText(200),
  passages: z.array(lineText(120)).min(1).max(MAX_READINESS_PASSAGES),
  /** What to change, and in which document; required unless minor (the engine says so). */
  proposal: lineText(200).optional(),
});
export type ReadinessFinding = z.infer<typeof ReadinessFindingSchema>;

/** One gesture of the creator: the finding (`J<n>` of the report, or the engine's key), the gesture. */
export const ReadinessGestureSchema = z.strictObject({
  id: lineText(80),
  gesture: z.enum(READINESS_GESTURES),
  /** The creator's reason in their words; required to accept a finding. */
  reason: lineText(300).optional(),
});
export type ReadinessGestureInput = z.infer<typeof ReadinessGestureSchema>;

/**
 * Input of the action `review.ready`, one flat shape for three steps, which the engine tells apart
 * (and lists what is missing for); the fields are those the other actions of the tool publish.
 * - check: `agent` alone. Writes nothing: what the engine computed, and what is left to judge.
 * - report: `summary` (what was read and the answer to the question, one line) and `findings`
 *   (possibly none).
 * - settle: `items` (one gesture per finding) and the creator's words in `quote`.
 */
export const ReadyInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  summary: lineText(300).optional(),
  findings: z
    .array(ReadinessFindingSchema)
    .max(MAX_READINESS_FINDINGS + 5)
    .optional(),
  items: z
    .array(ReadinessGestureSchema)
    .min(1)
    .max(MAX_READINESS_FINDINGS * 2)
    .optional(),
  /** The creator's words, as quoted: the trace of their gesture. */
  quote: z.string().max(MAX_QUOTE_LENGTH).trim().min(1).optional(),
});
export type ReadyInput = z.infer<typeof ReadyInputSchema>;

/** What a call does, told by what it holds. */
export function readinessStepOf(input: ReadyInput): ReadinessStep {
  if (input.findings !== undefined || input.summary !== undefined) return "report";
  if (input.items !== undefined || input.quote !== undefined) return "settle";
  return "check";
}

/** A judged finding as the journal keeps it. */
export const KeptReadinessFindingSchema = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES),
  kind: z.enum(READINESS_FINDING_KINDS),
  claim: lineText(200),
  passages: z.array(lineText(120)).min(1).max(MAX_READINESS_PASSAGES),
  proposal: lineText(200).optional(),
  /** The agent that corrects the first document, from its header. */
  owner: lineText(64),
});
export type KeptReadinessFinding = z.infer<typeof KeptReadinessFindingSchema>;

/** `payload` of `readiness.reported`. */
export const ReadinessReportedPayloadSchema = z.strictObject({
  /** The Git blob ids' digest of the documents read: a change of any of them makes the report stale. */
  mark: z.string().regex(/^[0-9a-f]{40}$/),
  stage: z.enum(["breakdown", "build"]),
  path: z.enum(["full", "short"]),
  summary: lineText(300),
  verdict: z.enum(READINESS_VERDICTS),
  /** The engine's findings open when the report was made, by severity. */
  engine: z.strictObject({
    blocking: z.number().int().min(0),
    should_fix: z.number().int().min(0),
    minor: z.number().int().min(0),
  }),
  findings: z.array(KeptReadinessFindingSchema).max(MAX_READINESS_FINDINGS),
  /** The keys of the blocking findings open then: the creator's "go on" waives exactly these. */
  waivable: z.array(lineText(80)).max(60).optional(),
  /** The `decision` checkpoint a blocking verdict opened (or reused) in the same write. */
  checkpoint: z
    .string()
    .regex(/^G-[0-9A-HJKMNP-TV-Z]{10}$/)
    .optional(),
});
export type ReadinessReportedPayload = z.infer<typeof ReadinessReportedPayloadSchema>;

/** `payload` of `readiness.settled`. */
export const ReadinessSettledPayloadSchema = z.strictObject({
  decisions: z
    .array(
      z.strictObject({
        id: lineText(80),
        gesture: z.enum(READINESS_GESTURES),
        reason: lineText(300).optional(),
      }),
    )
    .min(1)
    .max(MAX_READINESS_FINDINGS * 2),
  quote: z.string().max(MAX_QUOTE_LENGTH).trim().min(1),
});
export type ReadinessSettledPayload = z.infer<typeof ReadinessSettledPayloadSchema>;

/** The id of the report recorded by the event `eventId`: `R-` and the last 10 characters of its ULID. */
export function readinessIdOf(eventId: string): string {
  return `R-${eventId.slice(-10)}`;
}
