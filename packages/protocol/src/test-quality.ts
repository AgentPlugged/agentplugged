import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { hasControlCharacter } from "./deferred.js";
import { AgentIdSchema } from "./method-config.js";
import { ReviewPathSchema } from "./review.js";
import { CommitIdSchema } from "./story.js";

/**
 * The quality of the tests. A test that passes proves nothing if it cannot fail, so the
 * engine looks at the tests three ways, none of which costs the creator a thing: a graded review of
 * the tests (a fixed grid the agent fills and the engine marks), a light mutation check on the code
 * a story changed (the engine breaks the code a little, runs the tests the creator accepted, and
 * says which breaks no test noticed) and the holes of the coverage tied to the requirements.
 */

/** Event type, at version 1. */
export const TEST_REVIEW_EVENT_TYPES = { reviewed: "tests.reviewed" } as const;

/** The criteria of the grid, each marked on its own. */
export const TEST_CRITERIA = [
  "active",
  "assertions",
  "determinism",
  "isolation",
  "readability",
  "speed",
  "data",
  "risk",
] as const;
export type TestCriterion = (typeof TEST_CRITERIA)[number];

export const TEST_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type TestSeverity = (typeof TEST_SEVERITIES)[number];

/**
 * The rows of the grid: what a reviewer may report, each under one criterion and with the weight
 * fixed here. A reviewer says which row a test falls under and never how much it weighs, so two
 * reviews of the same tests mark the same.
 */
export const TEST_ROWS = [
  { id: "skipped", criterion: "active", severity: "critical" },
  { id: "focused", criterion: "active", severity: "critical" },
  { id: "no_assertion", criterion: "assertions", severity: "critical" },
  { id: "tautology", criterion: "assertions", severity: "critical" },
  { id: "self_mock", criterion: "assertions", severity: "critical" },
  { id: "unreachable", criterion: "assertions", severity: "critical" },
  { id: "shape_only", criterion: "assertions", severity: "high" },
  { id: "conditional", criterion: "assertions", severity: "high" },
  { id: "unawaited", criterion: "assertions", severity: "medium" },
  { id: "hard_wait", criterion: "determinism", severity: "high" },
  { id: "wall_clock", criterion: "determinism", severity: "high" },
  { id: "uncontrolled", criterion: "determinism", severity: "medium" },
  { id: "navigate_then_read", criterion: "determinism", severity: "medium" },
  { id: "fragile_selector", criterion: "determinism", severity: "low" },
  { id: "shared_state", criterion: "isolation", severity: "high" },
  { id: "order_dependent", criterion: "isolation", severity: "high" },
  { id: "leftover", criterion: "isolation", severity: "medium" },
  { id: "real_service", criterion: "isolation", severity: "medium" },
  { id: "oversize", criterion: "readability", severity: "high" },
  { id: "multi_concern", criterion: "readability", severity: "medium" },
  { id: "deep_nesting", criterion: "readability", severity: "medium" },
  { id: "ungrouped", criterion: "readability", severity: "low" },
  { id: "vague_name", criterion: "readability", severity: "low" },
  { id: "magic_value", criterion: "readability", severity: "low" },
  { id: "slow", criterion: "speed", severity: "medium" },
  { id: "heavy_setup", criterion: "speed", severity: "low" },
  { id: "real_data", criterion: "data", severity: "high" },
  { id: "repeated_payload", criterion: "data", severity: "medium" },
  { id: "hidden_data", criterion: "data", severity: "low" },
  { id: "denied_untested", criterion: "risk", severity: "high" },
  { id: "happy_path_only", criterion: "risk", severity: "medium" },
  { id: "wrong_level", criterion: "risk", severity: "medium" },
  { id: "raw_event", criterion: "risk", severity: "medium" },
] as const satisfies ReadonlyArray<{
  id: string;
  criterion: TestCriterion;
  severity: TestSeverity;
}>;
export type TestRowId = (typeof TEST_ROWS)[number]["id"];

const ROW_IDS = TEST_ROWS.map((row) => row.id) as unknown as [TestRowId, ...TestRowId[]];

export const TEST_CRITERION_VERDICTS = ["ok", "issues", "not_applicable"] as const;
export type TestCriterionVerdict = (typeof TEST_CRITERION_VERDICTS)[number];

/** The most test files a review lists as read, and the most findings it holds. */
export const MAX_TEST_READS = 60;
export const MAX_TEST_FINDINGS = 60;

const lineText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !hasControlCharacter(text, false), {
      message: "expected no control character",
    });

/** One test that falls under a row: where it is, and why in one line. */
export const TestFindingSchema = z.strictObject({
  criterion: z.enum(TEST_CRITERIA),
  row: z.enum(ROW_IDS),
  /** `path` or `path:line`, then the test's name when it has one. */
  test: lineText(220),
  reason: lineText(240),
  /** What to do. */
  fix: lineText(200).optional(),
});
export type TestFinding = z.infer<typeof TestFindingSchema>;

/** What the reviewer saw of one criterion. */
export const TestCriterionResultSchema = z.strictObject({
  criterion: z.enum(TEST_CRITERIA),
  verdict: z.enum(TEST_CRITERION_VERDICTS),
  /** Why a criterion does not apply (`not_applicable`), in one line. */
  note: lineText(200).optional(),
});
export type TestCriterionResult = z.infer<typeof TestCriterionResultSchema>;

/** The review of the tests, in its fixed form: the engine marks it, the agent does not. */
export const TestGridSchema = z.strictObject({
  /** The test files read (at least one, 60 at most). */
  reads: z.array(ReviewPathSchema).max(MAX_TEST_READS + 10),
  /** One entry per criterion of the grid, none twice. */
  criteria: z.array(TestCriterionResultSchema).max(TEST_CRITERIA.length),
  findings: z.array(TestFindingSchema).max(MAX_TEST_FINDINGS),
});
export type TestGrid = z.infer<typeof TestGridSchema>;

/** The most mutations a check runs, and its longest duration, in seconds. */
export const MAX_MUTATIONS = 30;
export const DEFAULT_MUTATIONS = 8;
export const MAX_MUTATION_SECONDS = 1800;
export const DEFAULT_MUTATION_SECONDS = 300;

/** What the mutation check is asked: the bounds, and the command that runs the tests. */
export const MutationRequestSchema = z.strictObject({
  /** The most breaks (8 without, 30 at most). */
  max: z.number().int().min(1).max(MAX_MUTATIONS).optional(),
  /** The longest the whole check runs, in seconds (300 without, 1 800 at most). */
  seconds: z.number().int().min(10).max(MAX_MUTATION_SECONDS).optional(),
  /** The declared command that runs the tests; the one that runs a criterion's tests without. */
  command: z.string().trim().min(1).max(40).optional(),
});
export type MutationRequest = z.infer<typeof MutationRequestSchema>;

/**
 * Input of `review_tests`: the review of the tests of a story (or of the product when `story` is
 * absent), with the grid the agent filled, the mutation check on the story's changes, and the holes
 * of the coverage proposed as work to decide.
 */
export const ReviewTestsCheckSchema = z.strictObject({
  grid: TestGridSchema.optional(),
  /** Run the mutation check on the story's changes, with its bounds. */
  mutation: MutationRequestSchema.optional(),
  /** Record the holes as work to propose to the creator, one gesture each. */
  propose: z.boolean().optional(),
});
export type ReviewTestsCheck = z.infer<typeof ReviewTestsCheckSchema>;

/** One field, `check`, holds the three parts: a name less on the list of tools every request loads. */
export const ReviewTestsInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  story: StoryIdSchema.optional(),
  check: ReviewTestsCheckSchema.optional(),
});
export type ReviewTestsInput = z.infer<typeof ReviewTestsInputSchema>;

export const TEST_GRADES = ["A", "B", "C", "D", "F"] as const;
export type TestGrade = (typeof TEST_GRADES)[number];

export const TEST_VERDICTS = ["sound", "to_improve", "to_fix", "blocked"] as const;
export type TestVerdict = (typeof TEST_VERDICTS)[number];

/** `payload` of `tests.reviewed`: the marks, and what the mutation check found. */
export const TestsReviewedPayloadSchema = z.strictObject({
  story: StoryIdSchema.optional(),
  commit: CommitIdSchema.optional(),
  score: z.number().int().min(0).max(100).optional(),
  grade: z.enum(TEST_GRADES).optional(),
  verdict: z.enum(TEST_VERDICTS).optional(),
  criteria: z
    .array(
      z.strictObject({
        criterion: z.enum(TEST_CRITERIA),
        score: z.number().int().min(0).max(100),
      }),
    )
    .max(TEST_CRITERIA.length)
    .optional(),
  findings: z.number().int().min(0).max(MAX_TEST_FINDINGS).optional(),
  mutation: z
    .strictObject({
      ran: z.number().int().min(0).max(MAX_MUTATIONS),
      killed: z.number().int().min(0).max(MAX_MUTATIONS),
      survived: z.number().int().min(0).max(MAX_MUTATIONS),
    })
    .optional(),
  gaps: z.number().int().min(0).max(1000),
});
export type TestsReviewedPayload = z.infer<typeof TestsReviewedPayloadSchema>;
