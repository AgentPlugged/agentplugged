import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { plainLine } from "./agent-content.js";
import { AgentIdSchema } from "./method-config.js";
import { ProofRunSchema } from "./requirements.js";
import { CommitIdSchema } from "./story.js";

/**
 * The acceptance criteria of a story proved by tests written first. A criterion is
 * named `AC-<story>-<n>` (`AC-2-3-2`: the second criterion of story 2-3), or `AC_2_3_2` where a
 * name takes no dash, in the name of its test or in a comment. For each criterion the journal holds
 * the runs the engine saw (or, without a command to run, the agent reported): a failing one before
 * the code, a passing one after it; or the declaration that the criterion cannot be tested through
 * the interface, with its reason.
 */

/** Event types of the criteria written by the engine, each at version 1. */
export const CRITERION_EVENT_TYPES = {
  /** A run of a criterion's test was seen, or the criterion was declared untestable. */
  recorded: "story.criterion_recorded",
} as const;

/** The most criteria of a story the engine follows. */
export const MAX_CRITERIA = 60;

/** What was seen of a criterion: its test failed (red), passed (green), or it has no test (untestable). */
export const CRITERION_RESULTS = ["red", "green", "untestable"] as const;
export type CriterionResult = (typeof CRITERION_RESULTS)[number];

/** Who saw it: the engine, which ran an accepted command, or the agent, who says so. */
export const CRITERION_ORIGINS = ["engine", "reported"] as const;
export type CriterionOrigin = (typeof CRITERION_ORIGINS)[number];

export const CriterionNumberSchema = z.int().min(1).max(MAX_CRITERIA);

/** `payload` of `story.criterion_recorded` (its story is the envelope's). */
export const CriterionRecordedPayloadSchema = z
  .strictObject({
    criterion: CriterionNumberSchema,
    result: z.enum(CRITERION_RESULTS),
    origin: z.enum(CRITERION_ORIGINS),
    /** Reported: the name of the test the agent ran. */
    test: plainLine(200).optional(),
    /** Untestable: why no result can be observed through the interface. */
    reason: plainLine(300).optional(),
    /** The commit the run was made at, and whether the copy had nothing uncommitted. */
    commit: CommitIdSchema.optional(),
    clean: z.boolean().optional(),
    /** Engine: the run of the command the creator accepted. */
    run: ProofRunSchema.optional(),
  })
  .refine((payload) => (payload.origin === "engine") === (payload.run !== undefined), {
    message: "a run is the engine's, and only the engine's",
    path: ["run"],
  })
  .refine((payload) => payload.result !== "untestable" || payload.origin === "reported", {
    message: "untestable is declared, never run",
    path: ["origin"],
  })
  .refine((payload) => (payload.result === "untestable") === (payload.reason !== undefined), {
    message: "a reason, for untestable only",
    path: ["reason"],
  })
  .refine(
    (payload) =>
      payload.origin !== "reported" ||
      payload.result === "untestable" ||
      payload.test !== undefined,
    { message: "name the test that was run", path: ["test"] },
  );
export type CriterionRecordedPayload = z.infer<typeof CriterionRecordedPayloadSchema>;

/** What an agent says it saw when the engine has no command to run: published as a plain string. */
function isSeen(value: string): boolean {
  return (CRITERION_RESULTS as readonly string[]).includes(value);
}

/**
 * Input of `record_criterion`: the engine runs the project's accepted test command filtered on the
 * criterion (nothing else to give), or, without one, `seen` (`red`, `green`, `untestable`) and
 * `note` (the test that was run; the reason when untestable) are the agent's own word.
 */
export const RecordCriterionInputSchema = z
  .strictObject({
    agent: AgentIdSchema.max(64),
    story: StoryIdSchema,
    criterion: CriterionNumberSchema,
    seen: z
      .string()
      .refine(isSeen, { message: `expected ${CRITERION_RESULTS.join(", ")}` })
      .optional(),
    note: plainLine(300).optional(),
  })
  .refine((input) => input.seen !== "untestable" || input.note !== undefined, {
    message: "give the reason in `note`",
    path: ["note"],
  });
export type RecordCriterionInput = z.infer<typeof RecordCriterionInputSchema>;

/**
 * A criterion's identifier as a test writes it, in the spelling of the language: `AC-17-3-2`, or
 * `AC_2_3_2` (a glued `test` prefix allowed: `TestAC_17_3_2`), any case; bounded (no letter nor
 * digit before it, no digit after it). The captures are the story's epic, its number, the criterion.
 */
export const CRITERION_REFERENCE =
  /(?<![A-Za-z0-9])(?:test)?AC[-_]([1-9]\d{0,5})[-_]([1-9]\d{0,5})[-_]([1-9]\d?)(?!\d)/gi;

/** The canonical id of a criterion (`AC-17-3-2`) from its story (`17-3`) and its number. */
export function criterionId(story: string, criterion: number): string {
  return `AC-${story}-${criterion}`;
}

/** The criteria a line cites: `{ story: "17-3", criterion: 2 }`, each once, in the line's order. */
export function criteriaInLine(
  text: string,
): ReadonlyArray<{ readonly story: string; readonly criterion: number }> {
  const found: Array<{ story: string; criterion: number }> = [];
  for (const match of text.matchAll(CRITERION_REFERENCE)) {
    const story = `${match[1] ?? ""}-${match[2] ?? ""}`;
    const criterion = Number(match[3]);
    if (!found.some((entry) => entry.story === story && entry.criterion === criterion)) {
      found.push({ story, criterion });
    }
  }
  return found;
}
