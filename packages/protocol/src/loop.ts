import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { plainLine } from "./agent-content.js";
import { AgentIdSchema } from "./method-config.js";

/**
 * The bounded loop: while a session of the tool is open, the stories that are ready
 * follow one another without the creator, and the loop stops by itself at every point that is the
 * creator's. The engine decides what comes next (from `next`), why the loop stops, and how many
 * times a story may be tried again; the journal keeps each stop and each approach tried.
 *
 * Nothing here goes on without a session: the loop is read and written by the session's agents, one
 * call at a time. What reaches further (resuming with no session open, at night, on several
 * machines, a notice on the phone) belongs to the bridge and reads this journal; the engine knows
 * nothing of it.
 */

/** Event types of the loop, each at version 1. */
export const LOOP_EVENT_TYPES = {
  /** An approach to a story's tests was started, failed or went green. */
  attempt: "story.attempt_recorded",
  /** The loop stopped, with the reason. */
  stopped: "loop.stopped",
  /** The loop went on after a stop. */
  resumed: "loop.resumed",
} as const;

/** The failed approaches after which the creator is asked before another one is tried. */
export const LOOP_MAX_ATTEMPTS = 3;

/** The most approaches the journal keeps for a story, and the most the loop answers with. */
export const LOOP_MAX_RECORDED = 40;
export const LOOP_MAX_SHOWN = 3;

/**
 * Why the loop stopped. The first group is the creator's: a point that waits for them, by what it
 * asks (`validation`: a document, the end of a phase or a change of the memory; `decision`: a choice
 * between options; `merge`: a story's merge; `spend`: a budget; `irreversible`: a release, a
 * publication or an action of the creator's that cannot be undone; `command`: an installation or
 * a command to accept; `gap`: a gap of a requirement; `creator_step`: a step that is theirs). The
 * second is the loop's own.
 */
export const LOOP_STOP_REASONS = [
  "validation",
  "decision",
  "merge",
  "spend",
  "irreversible",
  "command",
  "gap",
  "creator_step",
  "attempts",
  "blocked",
  "outside",
  "done",
] as const;
export type LoopStopReason = (typeof LOOP_STOP_REASONS)[number];

/** What an attempt records: started (the approach is about to be tried), then failed or green. */
export const ATTEMPT_RESULTS = ["started", "failed", "green"] as const;
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];

/**
 * The search for a bug's cause is the same event with `kind: "hypothesis"`:
 * `approach` is the hypothesis, `confidence` its confidence from 1 to 10, `result` `started` while
 * it is tested, `failed` once ruled out and `green` once confirmed as the cause, `note` the
 * evidence. A hypothesis that was ruled out is refused again, like an approach that failed.
 */
export const HYPOTHESIS_KIND = "hypothesis" as const;
export const HYPOTHESIS_CONFIDENCES = { min: 1, max: 10 } as const;

/** `payload` of `story.attempt_recorded` (its story is the envelope's). */
export const AttemptRecordedPayloadSchema = z
  .strictObject({
    approach: plainLine(300),
    result: z.enum(ATTEMPT_RESULTS),
    /** Failed: why it failed, in a line (the failing test, the message that mattered). */
    note: plainLine(300).optional(),
    kind: z.literal(HYPOTHESIS_KIND).optional(),
    confidence: z.int().min(HYPOTHESIS_CONFIDENCES.min).max(HYPOTHESIS_CONFIDENCES.max).optional(),
  })
  .refine((payload) => (payload.confidence === undefined) === (payload.kind === undefined), {
    message: "a confidence goes with a hypothesis, and only with it",
    path: ["confidence"],
  });
export type AttemptRecordedPayload = z.infer<typeof AttemptRecordedPayloadSchema>;

/** `payload` of `loop.stopped`: the reason, and what it is about (a point `G-…`, a story, a step). */
export const LoopStoppedPayloadSchema = z.strictObject({
  reason: z.enum(LOOP_STOP_REASONS),
  subject: plainLine(80).optional(),
  detail: plainLine(300).optional(),
});
export type LoopStoppedPayload = z.infer<typeof LoopStoppedPayloadSchema>;

/** `payload` of `loop.resumed`: the stop it follows. */
export const LoopResumedPayloadSchema = z.strictObject({
  after: z.enum(LOOP_STOP_REASONS),
  subject: plainLine(80).optional(),
});
export type LoopResumedPayload = z.infer<typeof LoopResumedPayloadSchema>;

/**
 * What an agent says of an approach it has tried, or of a hypothesis; published as a
 * plain string. `hypothesis` declares one (`note`: `7/10 the statement`), `ruled_out` and
 * `confirmed` close it (`note`: the evidence).
 */
export const LOOP_SEEN = ["failed", "green", "hypothesis", "ruled_out", "confirmed"] as const;
export type LoopSeen = (typeof LOOP_SEEN)[number];
function isOutcome(value: string): boolean {
  return (LOOP_SEEN as readonly string[]).includes(value);
}

/**
 * Input of `loop`, in the three fields the tool already publishes (`story`, `seen`, `note`). With
 * none of them: a turn of the loop (Noah only), which answers what comes next and writes the stop
 * or the resumption. With `story` and `note`: the approach the story's developer is about to try
 * (refused when it was already tried and failed, or when the limit is reached). With `story` and
 * `seen` (`failed` or `green`): how the approach in progress ended, `note` saying why it failed.
 */
export const LoopInputSchema = z
  .strictObject({
    agent: AgentIdSchema.max(64),
    story: StoryIdSchema.optional(),
    seen: z
      .string()
      .refine(isOutcome, { message: "expected failed, green, hypothesis, ruled_out or confirmed" })
      .optional(),
    note: plainLine(300).optional(),
  })
  .refine(
    (input) =>
      (input.note === undefined && input.seen === undefined) === (input.story === undefined),
    {
      message: "a story goes with an approach (note) or a result (seen), and only with them",
      path: ["story"],
    },
  );
export type LoopInput = z.infer<typeof LoopInputSchema>;
