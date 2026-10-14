import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { canonicalStoryId, DeferredIdInputSchema, hasControlCharacter } from "./deferred.js";
import { AgentIdSchema, CI_FORGE_IDS } from "./method-config.js";
import { CommitIdSchema } from "./story.js";

/**
 * The independent review of a story's pull request. A reviewer of the quality domain
 * (`qa`) and, for a story that concerns security, one of the security domain (`security`) each
 * read the diff of the story's branch the engine writes to a file, then submit their findings:
 * the engine computes the verdict and writes `story.reviewed`. The reviews given while a story is
 * in review make one pass; a pass is closed once every review it needs is in. The story's
 * developer sorts each finding of a closed pass (`story.review_triaged`): fix, defer or reject,
 * with its root cause. The engine posts each closed pass on the pull request
 * (`story.review_published`).
 */

/** Event types of a story's review, each at version 1. */
export const REVIEW_EVENT_TYPES = {
  reviewed: "story.reviewed",
  triaged: "story.review_triaged",
  published: "story.review_published",
  /** A review of a change that belongs to no story (a range, a branch, a pasted diff). */
  freeReviewed: "review.free_reviewed",
} as const;

/** The two reviews of a pass: quality, and security for a story that concerns it. */
export const REVIEW_KINDS = ["qa", "security"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** The domain of the agents who give each review. */
export const REVIEW_DOMAINS: Readonly<Record<ReviewKind, string>> = {
  qa: "quality",
  security: "security",
};

/** How much a finding weighs: it blocks the merge, should be fixed, or is minor. */
export const FINDING_SEVERITIES = ["blocking", "should_fix", "minor"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * The lenses of a review: independent regards on one change, each a short skill read
 * when it runs. The engine chooses which ones a change needs (`chooseLenses`); `judge` is the
 * last pass, apart, with a fresh context.
 */
export const REVIEW_LENSES = [
  "adversarial",
  "edge_cases",
  "verification_gaps",
  "structure",
  "prose",
  "security",
  "relevance",
] as const;
export type ReviewLens = (typeof REVIEW_LENSES)[number];
export const JUDGE_LENS = "judge" as const;
/** What a finding names as its origin: a lens, or the judge. */
export const FINDING_LENSES = [...REVIEW_LENSES, JUDGE_LENS] as const;
export type FindingLens = (typeof FINDING_LENSES)[number];

/**
 * What the judge rules on each finding of a lens, in a fresh context and before the
 * developer sees anything: the finding stands (`confirmed`, at the severity the judge gives),
 * is wrong (`refuted`, with the place that proves it), or cannot be settled (`undecided`).
 */
export const RULING_STATUSES = ["confirmed", "refuted", "undecided"] as const;
export type RulingStatus = (typeof RULING_STATUSES)[number];
/** What a finding keeps of its ruling: a refuted finding is counted and never shown. */
export const KEPT_RULINGS = ["confirmed", "undecided"] as const;
/** A finding whose cause is a badly written story: the story is amended, the code is not patched around it. */
export const STORY_CAUSE = "story" as const;
/** A lens or the judge that gave no report: the review says it is possibly incomplete. */
export const SILENT_PARTS = [...REVIEW_LENSES, JUDGE_LENS] as const;
export type SilentPart = (typeof SILENT_PARTS)[number];

/** The verdict of a review, computed by the engine from its findings. */
export const REVIEW_VERDICTS = ["pass", "pass_with_reservations", "fail"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** What the developer does with a finding: fix it, defer it (an item of deferred work), reject it. */
export const TRIAGE_DECISIONS = ["fix", "defer", "reject"] as const;
export type TriageDecision = (typeof TRIAGE_DECISIONS)[number];

/**
 * Why a story concerns security: its diff touches a sensitive path, its approved text
 * speaks of security, its header names a security reviewer, or the quality reviewer asked.
 */
export const SECURITY_REASONS = ["paths", "words", "reviewer", "qa_flag"] as const;
export type SecurityReason = (typeof SECURITY_REASONS)[number];

/** Findings one review holds, at most; triage items one call gives, at most. */
export const MAX_REVIEW_FINDINGS = 100;
export const MAX_TRIAGE_ITEMS = 100;
/** Closed passes without agreement before the creator is asked. */
export const MAX_REVIEW_PASSES = 5;

/** Acceptance criteria a story may hold, at most. */
export const MAX_CRITERIA = 99;

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

/** A path of the repository, relative, with `/`: never absolute, never `..`. */
export const ReviewPathSchema = lineText(500)
  .transform((path) => path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, ""))
  .refine((path) => !path.startsWith("/") && !/^[a-z]:/i.test(path), {
    message: "expected a path relative to the repository",
  })
  .refine((path) => !path.split("/").includes(".."), { message: "expected no .. segment" });

/** One finding of a review: what, how much it weighs, and where (a line only with a path). */
export const ReviewFindingSchema = z
  .strictObject({
    severity: z.enum(FINDING_SEVERITIES),
    title: lineText(200),
    detail: longText(2000).optional(),
    path: ReviewPathSchema.optional(),
    line: z.number().int().min(1).max(10_000_000).optional(),
    /** The lens that found it, the criterion it threatens, what the agent advises. */
    lens: z.enum(FINDING_LENSES).optional(),
    criterion: z.number().int().min(1).max(MAX_CRITERIA).optional(),
    recommendation: lineText(200).optional(),
    /** The other lenses that found the same thing (merged by the engine). */
    also: z.array(z.enum(FINDING_LENSES)).max(FINDING_LENSES.length).optional(),
    /** What the judge ruled (a finding it could not settle is `undecided`), set by the engine. */
    ruling: z.enum(KEPT_RULINGS).optional(),
    /** The judge found its cause in the story itself, set by the engine. */
    cause: z.literal(STORY_CAUSE).optional(),
  })
  .refine((finding) => finding.line === undefined || finding.path !== undefined, {
    message: "a line goes with a path",
    path: ["line"],
  });
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/** One finding as a lens reports it: closed sections, checked by the engine (`validateLensReports`). */
export const LensFindingSchema = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES),
  title: lineText(200),
  /** The proof: what was seen, why it matters. Required (checked by the engine). */
  evidence: longText(1000).optional(),
  /** The acceptance criterion threatened (its number, from 1), or null when none. Required. */
  criterion: z.number().int().min(1).max(MAX_CRITERIA).nullable().optional(),
  /** What to do about it; required for a blocking finding and one to fix. */
  recommendation: lineText(200).optional(),
  path: ReviewPathSchema.optional(),
  line: z.number().int().min(1).max(10_000_000).optional(),
});
export type LensFinding = z.infer<typeof LensFindingSchema>;

/** The report of one lens: its summary, what it covered, its findings (possibly none). */
export const LensReportSchema = z.strictObject({
  lens: z.enum(REVIEW_LENSES),
  summary: longText(500),
  covered: z.array(lineText(120)).max(12).optional(),
  findings: z.array(LensFindingSchema).max(MAX_REVIEW_FINDINGS),
});
export type LensReport = z.infer<typeof LensReportSchema>;

/** The judge's verdict on one acceptance criterion. */
export const JUDGE_STATUSES = ["met", "partly", "unmet"] as const;
export type JudgeStatus = (typeof JUDGE_STATUSES)[number];

/** A finding of a lens as the judge names it: its lens, then its rank in that lens's report (`edge_cases#2`). */
export const FindingRefSchema = z.string().regex(/^[a-z_]+#[1-9]\d{0,2}$/, {
  message: "expected a lens then # then the rank of the finding, for example edge_cases#2",
});

/** Findings the judge may rule in one review, at most. */
export const MAX_RULINGS = MAX_REVIEW_FINDINGS * 7;

/** The judge's ruling on one finding of a lens. */
export const RulingSchema = z.strictObject({
  finding: FindingRefSchema,
  status: z.enum(RULING_STATUSES),
  /** The final severity of a confirmed finding (required then): the reader's own is set aside. */
  severity: z.enum(FINDING_SEVERITIES).optional(),
  /** What was read to rule: required. */
  evidence: longText(500).optional(),
  /** The place that proves a refutation (file:line or a test), required for `refuted`. */
  at: lineText(200).optional(),
  /** The cause is the story itself (ambiguous, contradictory, impossible): amend it. */
  cause: z.literal(STORY_CAUSE).optional(),
});
export type Ruling = z.infer<typeof RulingSchema>;

/** The last pass, in a fresh context: each criterion of the story, and the gap with the real need. */
export const JudgeReportSchema = z.strictObject({
  summary: longText(500),
  criteria: z
    .array(
      z.strictObject({
        criterion: z.number().int().min(1).max(MAX_CRITERIA),
        status: z.enum(JUDGE_STATUSES),
        evidence: longText(500).optional(),
        recommendation: lineText(200).optional(),
        cause: z.literal(STORY_CAUSE).optional(),
      }),
    )
    .max(MAX_CRITERIA),
  /** A ruling on each finding the lenses gave, none missing nor twice. */
  findings: z.array(RulingSchema).max(MAX_RULINGS).optional(),
  /** The gap between the story's intent and what was delivered, or null when there is none. */
  gap: longText(500).nullable().optional(),
});
export type JudgeReport = z.infer<typeof JudgeReportSchema>;

/**
 * A lens, or the judge, that gave no report or ran out of time: said in its place, never
 * hidden nor invented. The review then says it is possibly incomplete.
 */
export const SilentLensSchema = z.strictObject({
  lens: z.enum(REVIEW_LENSES),
  silent: z.literal(true),
});
export type SilentLens = z.infer<typeof SilentLensSchema>;
export const SilentJudgeSchema = z.strictObject({ silent: z.literal(true) });
export type SilentJudge = z.infer<typeof SilentJudgeSchema>;

/** True for the placeholder of a lens that stayed silent. */
export const isSilentLens = (report: LensReport | SilentLens): report is SilentLens =>
  "silent" in report;
/** True for the placeholder of a judge that stayed silent. */
export const isSilentJudge = (report: JudgeReport | SilentJudge): report is SilentJudge =>
  "silent" in report;

/** Why a pass needs a security review, as the engine computed it. */
export const ReviewSecuritySchema = z.strictObject({
  reasons: z
    .array(z.enum(SECURITY_REASONS))
    .max(SECURITY_REASONS.length)
    .refine((reasons) => new Set(reasons).size === reasons.length, {
      message: "reasons must differ",
    }),
  /** No active agent of the security domain: the pass waits for no security review. */
  unavailable: z.literal(true).optional(),
});
export type ReviewSecurity = z.infer<typeof ReviewSecuritySchema>;

/** `payload` of `story.reviewed` (its story is the envelope's). */
export const StoryReviewedPayloadSchema = z.strictObject({
  kind: z.enum(REVIEW_KINDS),
  /** The head of the story's branch the review read. */
  commit: CommitIdSchema,
  summary: longText(2000),
  findings: z.array(ReviewFindingSchema).max(MAX_REVIEW_FINDINGS),
  verdict: z.enum(REVIEW_VERDICTS),
  security: ReviewSecuritySchema,
  /** The lenses that ran with their findings before the merge, findings merged away. */
  lenses: z
    .array(
      z.strictObject({
        lens: z.enum(REVIEW_LENSES),
        findings: z.number().int().min(0).max(MAX_REVIEW_FINDINGS),
      }),
    )
    .max(REVIEW_LENSES.length)
    .optional(),
  merged: z.number().int().min(0).max(10_000).optional(),
  /** The lenses the engine required of this review (an audit: what it asked, what came back). */
  asked: z.array(z.enum(REVIEW_LENSES)).max(REVIEW_LENSES.length).optional(),
  judge: z
    .strictObject({
      met: z.number().int().min(0).max(MAX_CRITERIA),
      partly: z.number().int().min(0).max(MAX_CRITERIA),
      unmet: z.number().int().min(0).max(MAX_CRITERIA),
    })
    .optional(),
  /** How the judge ruled on the lenses' findings (counted before the merge). */
  ruled: z
    .strictObject({
      confirmed: z.number().int().min(0).max(MAX_RULINGS),
      refuted: z.number().int().min(0).max(MAX_RULINGS),
      undecided: z.number().int().min(0).max(MAX_RULINGS),
    })
    .optional(),
  /** The refuted findings, kept for the audit and shown to nobody: the lens, the finding, the proof. */
  refuted: z
    .array(
      z.strictObject({
        lens: z.enum(REVIEW_LENSES),
        severity: z.enum(FINDING_SEVERITIES),
        title: lineText(200),
        at: lineText(200).optional(),
      }),
    )
    .max(MAX_REVIEW_FINDINGS)
    .optional(),
  /** The lenses (or the judge) that gave no report: the review is possibly incomplete. */
  silent: z.array(z.enum(SILENT_PARTS)).max(SILENT_PARTS.length).optional(),
});
export type StoryReviewedPayload = z.infer<typeof StoryReviewedPayloadSchema>;

/**
 * `payload` of `review.free_reviewed`: the review of a change that belongs to no story,
 * recorded in the journal with no story. `commit` is the hash of the diff read (what the review is
 * about), `source` where the diff came from, `intent` the one sentence the judge read it against.
 */
export const FreeReviewedPayloadSchema = StoryReviewedPayloadSchema.omit({
  kind: true,
  security: true,
}).extend({
  source: lineText(200),
  intent: lineText(300),
  files: z.number().int().min(0).max(1_000_000),
});
export type FreeReviewedPayload = z.infer<typeof FreeReviewedPayloadSchema>;

/** `R-` then the last 10 characters of the ULID of the event that recorded the review. */
export const ReviewIdSchema = z.string().regex(/^R-[0-9A-HJKMNP-TV-Z]{10}$/, {
  message: "expected R- then 10 characters, for example R-7M2K9QX4TB",
});

/** A finding: its review's id, then its rank in that review (`R-7M2K9QX4TB-2`). */
export const FindingIdSchema = z.string().regex(/^R-[0-9A-HJKMNP-TV-Z]{10}-[1-9]\d{0,2}$/, {
  message: "expected a finding id, for example R-7M2K9QX4TB-2",
});

/** A finding id as typed (lower case, spaces): trimmed and in upper case, then checked. */
export const FindingIdInputSchema = z.string().trim().toUpperCase().pipe(FindingIdSchema);

/** The id of the review recorded by the event `eventId`: stable, never renumbered. */
export function reviewIdOf(eventId: string): string {
  return `R-${eventId.slice(-10)}`;
}

/** The id of the `rank`-th finding (from 1) of the review recorded by `eventId`. */
export function findingIdOf(eventId: string, rank: number): string {
  return `${reviewIdOf(eventId)}-${rank}`;
}

/** One finding sorted by the story's developer. */
export const TriageItemSchema = z
  .strictObject({
    finding: FindingIdSchema,
    decision: z.enum(TRIAGE_DECISIONS),
    /** The root cause, in one line: findings of one cause carry the same words. */
    root_cause: lineText(200),
    /** Why it is rejected (required for `reject`). */
    reason: longText(1000).optional(),
    /** The item of deferred work it went to (required for `defer`, and only there). */
    deferred: z
      .string()
      .regex(/^D-[0-9A-HJKMNP-TV-Z]{10}$/)
      .optional(),
  })
  .refine((item) => item.decision !== "reject" || item.reason !== undefined, {
    message: "a rejected finding needs its reason",
    path: ["reason"],
  })
  .refine((item) => (item.decision === "defer") === (item.deferred !== undefined), {
    message: "a deferred finding needs its item of deferred work (D-…), and only it",
    path: ["deferred"],
  });
export type TriageItem = z.infer<typeof TriageItemSchema>;

const triageItems = <T extends z.ZodType<{ finding: string }>>(item: T) =>
  z
    .array(item)
    .min(1)
    .max(MAX_TRIAGE_ITEMS)
    .refine((items) => new Set(items.map((entry) => entry.finding)).size === items.length, {
      message: "each finding once",
    });

/** `payload` of `story.review_triaged`. */
export const StoryReviewTriagedPayloadSchema = z.strictObject({
  items: triageItems(TriageItemSchema),
});
export type StoryReviewTriagedPayload = z.infer<typeof StoryReviewTriagedPayloadSchema>;

/**
 * `payload` of `story.review_published`: one review of a closed pass posted on the pull request
 * (one event per review, so that a review the forge took is never posted twice).
 */
export const StoryReviewPublishedPayloadSchema = z.strictObject({
  pass: z.number().int().min(1).max(10_000),
  kind: z.enum(REVIEW_KINDS),
  forge: z.enum(CI_FORGE_IDS),
  pr: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /** Findings posted on their line. */
  comments: z
    .number()
    .int()
    .min(0)
    .max(MAX_REVIEW_FINDINGS * 2),
  /** Findings outside the diff's lines, written in the review's text. */
  notes: z
    .number()
    .int()
    .min(0)
    .max(MAX_REVIEW_FINDINGS * 2),
});
export type StoryReviewPublishedPayload = z.infer<typeof StoryReviewPublishedPayloadSchema>;

const agent = AgentIdSchema.max(64);
const story = StoryIdSchema.overwrite(canonicalStoryId);

/** The one sentence a free review is judged against, and the longest pasted diff. */
export const MAX_INTENT = 300;
export const MAX_PASTED_DIFF = 2_000_000;

/**
 * A change that belongs to no story: a `source` (`uncommitted`, `<from>..<to>` a range
 * of commits, `branch:<name>`, `pr:<number>`) or a pasted `diff`, and the `intent` in one sentence,
 * the only criterion the judge reads it against.
 */
export const FreeChangeSchema = z
  .strictObject({
    source: lineText(200).optional(),
    diff: z.string().min(1).max(MAX_PASTED_DIFF).optional(),
    intent: lineText(MAX_INTENT),
  })
  .refine((change) => (change.source === undefined) !== (change.diff === undefined), {
    message: "give a source or a diff: one of the two",
    path: ["source"],
  });
export type FreeChange = z.infer<typeof FreeChangeSchema>;

/**
 * Input of `start_review` (and `export_review`): a story, or a free change. Only the quality
 * review is free.
 */
export const StartReviewInputSchema = z
  .strictObject({
    agent,
    story: story.optional(),
    kind: z.enum(REVIEW_KINDS),
    /** Lenses the creator asks for besides the ones the engine chose. */
    more: z.array(z.enum(REVIEW_LENSES)).max(REVIEW_LENSES.length).optional(),
    /** The change to review when it belongs to no story. */
    free: FreeChangeSchema.optional(),
  })
  .refine((input) => (input.story === undefined) !== (input.free === undefined), {
    message: "give a story, or a free change (`free`): one of the two",
    path: ["story"],
  })
  .refine((input) => input.free === undefined || input.kind === "qa", {
    message: "only the quality review is free",
    path: ["kind"],
  });
export type StartReviewInput = z.infer<typeof StartReviewInputSchema>;

/** Input of `submit_review`: never a verdict, computed by the engine. */
export const SubmitReviewInputSchema = z
  .strictObject({
    agent,
    /** Absent for a free review: `commit` then names it. */
    story: story.optional(),
    kind: z.enum(REVIEW_KINDS),
    /** The commit `start_review` gave: the review is about it. */
    commit: CommitIdSchema,
    summary: longText(2000),
    findings: z.array(ReviewFindingSchema).max(MAX_REVIEW_FINDINGS),
    /** The reports of the lenses `start_review` chose, and the judge's. */
    lenses: z
      .array(z.union([LensReportSchema, SilentLensSchema]))
      .max(REVIEW_LENSES.length)
      .optional(),
    judge: z.union([JudgeReportSchema, SilentJudgeSchema]).optional(),
    /** The quality reviewer asks for a security review of the story. */
    security: z.boolean().optional(),
  })
  .refine((input) => input.security === undefined || input.kind === "qa", {
    message: "only the quality review asks for a security review",
    path: ["security"],
  })
  .refine(
    (input) =>
      (input.lenses === undefined && input.judge === undefined) || input.findings.length === 0,
    {
      message: "with lenses, the findings come from their reports: send `findings` empty",
      path: ["findings"],
    },
  );
export type SubmitReviewInput = z.infer<typeof SubmitReviewInputSchema>;

/** Input of `triage_review`: finding ids and item ids read without case. */
export const TriageReviewInputSchema = z.strictObject({
  agent,
  story,
  items: triageItems(
    z
      .strictObject({
        finding: FindingIdInputSchema,
        decision: z.enum(TRIAGE_DECISIONS),
        root_cause: lineText(200),
        reason: longText(1000).optional(),
        deferred: DeferredIdInputSchema.optional(),
      })
      .refine((item) => item.decision !== "reject" || item.reason !== undefined, {
        message: "a rejected finding needs its reason",
        path: ["reason"],
      })
      .refine((item) => (item.decision === "defer") === (item.deferred !== undefined), {
        message: "a deferred finding needs its item of deferred work (D-…), and only it",
        path: ["deferred"],
      }),
  ),
});
export type TriageReviewInput = z.infer<typeof TriageReviewInputSchema>;

/** Input of `get_review` and `publish_review`. */
export const StoryReviewInputSchema = z.strictObject({ agent, story });
export type StoryReviewInput = z.infer<typeof StoryReviewInputSchema>;

/** Why a review cannot start, be given, sorted, read or posted (`REVIEW_NOT_POSSIBLE`). */
export const REVIEW_NOT_POSSIBLE_REASONS = [
  "unknown_story",
  "not_started",
  "done",
  "not_in_review",
  "not_reviewer",
  "not_independent",
  "ci_not_green",
  "head_moved",
  "already_reviewed",
  "same_reviewer",
  "security_not_required",
  "branch_missing",
  "no_diff",
  "not_developer",
  "not_allowed",
  "unknown_finding",
  "already_triaged",
  "pass_open",
  "deferred_unknown",
  "report_invalid",
  "source_invalid",
  "free_unknown",
  "free_not_reviewer",
] as const;
export type ReviewNotPossibleReason = (typeof REVIEW_NOT_POSSIBLE_REASONS)[number];
