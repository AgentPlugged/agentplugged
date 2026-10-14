import { z } from "zod";
import { MAX_QUOTE_LENGTH } from "./chat.js";
import { hasControlCharacter } from "./deferred.js";
import { AgentIdSchema } from "./method-config.js";
import { FINDING_SEVERITIES, ReviewPathSchema } from "./review.js";

/**
 * The critique of a deliverable. A document the creator is about to build on (the
 * brief, the PRD, the UX specification, the architecture) is attacked by a method, in a fresh
 * context, before it is validated. The report is closed: the engine refuses one that is not whole
 * and lists what is missing. The creator then makes one gesture per objection: keep it and correct
 * the document (its author does), keep it as a hypothesis the product follows until it is proved
 * or refuted, or drop it with a reason. A hypothesis is a register of its own, built to be taken up
 * again by the test of an idea.
 */

/** Event types, each at version 1. */
export const CRITIQUE_EVENT_TYPES = {
  /** A critique report, validated (`actor.kind: agent`). */
  reported: "critique.reported",
  /** Noah offered the critique of this version of a document: said once per version. */
  proposed: "critique.proposed",
  /** The creator's gestures on the objections of a critique, relayed by an agent. */
  settled: "critique.settled",
  /** The creator's decision on a hypothesis: proved, refuted, dropped, or still open. */
  closed: "hypothesis.closed",
} as const;

/** What one call of the action does. */
export const CRITIQUE_STEPS = ["report", "propose", "show", "settle", "close"] as const;
export type CritiqueStep = (typeof CRITIQUE_STEPS)[number];

/** The methods of critique; each is a short file of the skill, read when it is chosen. */
export const CRITIQUE_METHODS = [
  "pre_mortem",
  "red_team",
  "socratic",
  "first_principles",
  "devils_advocate",
  "inversion",
  "personas",
  // More families, one short file each, read one at a time.
  "divergence",
  "assumption_audit",
  "steelman",
  "failure_modes",
  "second_order",
  "domain_expert",
  "extreme_user",
  "compare_existing",
  "reframe",
  "subtraction",
  "judgment",
  "reconcile",
] as const;
export type CritiqueMethod = (typeof CRITIQUE_METHODS)[number];

/** Methods that stand alone: the test of an idea, and the reconciliation of the creator's inputs. */
export const SOLO_METHODS: readonly CritiqueMethod[] = ["personas", "reconcile"];
/** Methods a critique may blend, at most: the agent reads two files, never more. */
export const MAX_BLENDED_METHODS = 2;
/** Findings of a reconciliation, at most: what did not land, kept short. */
export const MAX_RECONCILED = 5;
/** The documents a reconciliation compares with the creator's sources. */
export const RECONCILE_KINDS = ["prd", "ux", "architecture"] as const;

/** The three gestures of the creator on an objection. */
export const CRITIQUE_GESTURES = ["fix", "hypothesis", "discard"] as const;
export type CritiqueGesture = (typeof CRITIQUE_GESTURES)[number];

/** How a hypothesis ends, or does not (`still_open`: looked at again, kept). */
export const HYPOTHESIS_OUTCOMES = ["proved", "refuted", "dropped", "still_open"] as const;
export type HypothesisOutcome = (typeof HYPOTHESIS_OUTCOMES)[number];

/** Objections one critique holds, at most: the creator's stack stays short. */
export const MAX_OBJECTIONS = 12;
/** Hypotheses open at the same time, at most: the creator closes some before keeping more. */
export const MAX_OPEN_HYPOTHESES = 40;
/** Versions of a document remembered as offered or criticised, at most. */
export const MAX_REMEMBERED_VERSIONS = 80;

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

/** `K-` then the last 10 characters of the ULID of the event that recorded the critique. */
export const CritiqueIdSchema = z.string().regex(/^K-[0-9A-HJKMNP-TV-Z]{10}$/, {
  message: "expected K- then 10 characters, for example K-7M2K9QX4TB",
});
export const CritiqueIdInputSchema = z.string().trim().toUpperCase().pipe(CritiqueIdSchema);

/** `H-` then the critique's 10 characters, `-`, the number of the objection. */
export const HypothesisIdSchema = z.string().regex(/^H-[0-9A-HJKMNP-TV-Z]{10}-[1-9]\d?$/, {
  message: "expected H-, 10 characters, - and a number, for example H-7M2K9QX4TB-2",
});
export const HypothesisIdInputSchema = z.string().trim().toUpperCase().pipe(HypothesisIdSchema);

/** The `item` of a call: a critique or a hypothesis, as typed. */
const ItemIdInputSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.union([CritiqueIdSchema, HypothesisIdSchema]));

/** The id of the critique recorded by the event `eventId`: stable, never renumbered. */
export function critiqueIdOf(eventId: string): string {
  return `K-${eventId.slice(-10)}`;
}

/** The id of the hypothesis kept from objection `n` of a critique. */
export function hypothesisIdOf(critique: string, n: number): string {
  return `H-${critique.slice(2)}-${n}`;
}

/** The critique a hypothesis comes from. */
export function critiqueOfHypothesis(hypothesis: string): string {
  return `K-${hypothesis.slice(2, 12)}`;
}

/**
 * One objection as the report gives it. The sections are optional here and required by the engine
 * (`validateCritiqueReport`), which then lists everything that is missing at once.
 */
export const ObjectionSchema = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES),
  /** The objection as a statement, one line: it is what a hypothesis kept from it says. */
  claim: lineText(200),
  /** The passage aimed at: a section heading of the document, or an identifier `EF-n`, `ENF-n`, `AD-n`. */
  passage: lineText(120).optional(),
  /** Why it holds: what in the passage breaks, and what follows. */
  argument: longText(600).optional(),
  /** What to change in the document. */
  proposal: lineText(200).optional(),
  /** What would prove or refute it; required for a graver objection than a minor one. */
  proof: lineText(200).optional(),
});
export type Objection = z.infer<typeof ObjectionSchema>;

/**
 * The documents a critique can aim at: the structuring ones (their kind is the `kind` of a call),
 * the press release and the idea itself, which is no file: it is tested before there
 * is a brief.
 */
export const CRITIQUE_DOCUMENT_KINDS = [
  "brief",
  "prd",
  "ux",
  "architecture",
  "spec",
  "prfaq",
  "idea",
] as const;
export type CritiqueDocumentKind = (typeof CRITIQUE_DOCUMENT_KINDS)[number];

/** The idea is one thing, not a file with versions: it is offered and tested under this one mark. */
export const IDEA_VERSION = "idea";

/** The file of a kind of document; the idea has none, its name stands in the registers. */
export function critiquePathOf(kind: CritiqueDocumentKind): string {
  return kind === "idea" ? ".agentplugged/docs/idea" : `.agentplugged/docs/${kind}.md`;
}

/** True for a gesture on an objection. */
export function isCritiqueGesture(value: string): value is CritiqueGesture {
  return (CRITIQUE_GESTURES as readonly string[]).includes(value);
}

/** True for a method of critique. */
export function isCritiqueMethod(value: string): value is CritiqueMethod {
  return (CRITIQUE_METHODS as readonly string[]).includes(value);
}

/** True for an outcome of a hypothesis. */
export function isHypothesisOutcome(value: string): value is HypothesisOutcome {
  return (HYPOTHESIS_OUTCOMES as readonly string[]).includes(value);
}

/**
 * One entry of `items`: the creator's gesture on an objection of a critique, by its number (from
 * 1): `fix`, `hypothesis` or `discard`; or, to close a hypothesis, how it ended (`proved`,
 * `refuted`, `dropped`, `still_open`), without a number.
 */
export const GestureSchema = z.strictObject({
  n: z
    .number()
    .int()
    .min(1)
    .max(MAX_OBJECTIONS + 3)
    .optional(),
  gesture: z.string().refine((value) => isCritiqueGesture(value) || isHypothesisOutcome(value), {
    message: `expected ${[...CRITIQUE_GESTURES, ...HYPOTHESIS_OUTCOMES].join(", ")}`,
  }),
  /** The creator's reason in their words; required to drop an objection or close a hypothesis. */
  reason: lineText(300).optional(),
});
export type Gesture = z.infer<typeof GestureSchema>;

/**
 * Input of the action `review.critique`, one flat shape for four steps, which the engine tells
 * apart (and lists what is missing for): the tool list stays short because the fields are those
 * the other actions of the tool already publish, but `item` and `quote`.
 * - report: `findings` (the objections), with `kind` (the document), `lenses` (the method, one) and
 *   `summary` (why this method, one line).
 * - propose: `kind` alone (Noah offers the critique of the present version of the document, once).
 * - show: `item` K-… alone: what is left to sort of that critique, and the corrections kept.
 * - settle: `item` K-… (the critique), `items` (one gesture per objection) and the creator's `quote`.
 * - close: `item` H-… (the hypothesis), `items` (one entry: how it ended, its reason) and `quote`.
 */
export const CritiqueInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  kind: z.enum(CRITIQUE_DOCUMENT_KINDS).optional(),
  lenses: z
    .array(
      z.string().refine(isCritiqueMethod, { message: `expected ${CRITIQUE_METHODS.join(", ")}` }),
    )
    .max(MAX_BLENDED_METHODS)
    .optional(),
  summary: lineText(300).optional(),
  findings: z
    .array(ObjectionSchema)
    .max(MAX_OBJECTIONS + 5)
    .optional(),
  /** The critique (`K-…`) to settle, or the hypothesis (`H-…`) to close. */
  item: ItemIdInputSchema.optional(),
  items: z
    .array(GestureSchema)
    .max(MAX_OBJECTIONS + 3)
    .optional(),
  /** The creator's words, as quoted: the trace of their gesture. */
  quote: z.string().max(MAX_QUOTE_LENGTH).trim().min(1).optional(),
});
export type CritiqueInput = z.infer<typeof CritiqueInputSchema>;

/**
 * What a call does, told by what it holds: findings report; a `K-` item alone shows what is left
 * to sort of that critique, with `items` and `quote` settles; an `H-` item closes; else it proposes.
 */
export function critiqueStepOf(input: CritiqueInput): CritiqueStep {
  if (input.findings !== undefined) return "report";
  if (input.item?.startsWith("K-") === true) {
    return input.items === undefined && input.quote === undefined ? "show" : "settle";
  }
  if (input.item?.startsWith("H-") === true) return "close";
  return "propose";
}

/** The git blob ids a document version is known by (SHA-1 and SHA-256, as written and in LF). */
const VersionsSchema = z
  .array(z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64}|idea)$/))
  .min(1)
  .max(4);

/** An objection as the journal keeps it: all its sections. */
export const KeptObjectionSchema = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES),
  claim: lineText(200),
  passage: lineText(120),
  argument: longText(600),
  proposal: lineText(200).optional(),
  proof: lineText(200).optional(),
});
export type KeptObjection = z.infer<typeof KeptObjectionSchema>;

/** `payload` of `critique.reported`. */
export const CritiqueReportedPayloadSchema = z.strictObject({
  document: ReviewPathSchema,
  versions: VersionsSchema,
  method: z.enum(CRITIQUE_METHODS),
  /** The second method of a blend. */
  blend: z.enum(CRITIQUE_METHODS).optional(),
  reason: lineText(300),
  objections: z.array(KeptObjectionSchema).max(MAX_OBJECTIONS),
});
export type CritiqueReportedPayload = z.infer<typeof CritiqueReportedPayloadSchema>;

/** `payload` of `critique.proposed`. */
export const CritiqueProposedPayloadSchema = z.strictObject({
  document: ReviewPathSchema,
  versions: VersionsSchema,
});
export type CritiqueProposedPayload = z.infer<typeof CritiqueProposedPayloadSchema>;

/** `payload` of `critique.settled`. */
export const CritiqueSettledPayloadSchema = z.strictObject({
  critique: CritiqueIdSchema,
  decisions: z
    .array(
      z.strictObject({
        n: z.number().int().min(1).max(MAX_OBJECTIONS),
        gesture: z.enum(CRITIQUE_GESTURES),
        reason: lineText(300).optional(),
      }),
    )
    .min(1)
    .max(MAX_OBJECTIONS),
  quote: z.string().max(MAX_QUOTE_LENGTH).trim().min(1),
});
export type CritiqueSettledPayload = z.infer<typeof CritiqueSettledPayloadSchema>;

/** `payload` of `hypothesis.closed`. */
export const HypothesisClosedPayloadSchema = z.strictObject({
  hypothesis: HypothesisIdSchema,
  outcome: z.enum(HYPOTHESIS_OUTCOMES),
  reason: lineText(300),
  quote: z.string().max(MAX_QUOTE_LENGTH).trim().min(1),
});
export type HypothesisClosedPayload = z.infer<typeof HypothesisClosedPayloadSchema>;
