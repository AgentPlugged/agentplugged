import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { CheckpointIdSchema } from "./checkpoint.js";
import { AgentIdSchema } from "./method-config.js";

/**
 * Sprints: the scrum master proposes a goal, stories in order and the capacity that
 * builds them (`plan_sprint`); `core` checks the proposal, then writes in one append the
 * `document` checkpoint that submits it to the creator and the `sprint.planned` event that names
 * that checkpoint. A sprint is in force only once the creator approves its checkpoint. Its id is
 * drawn from its event (`S-` then the last 10 characters of its ULID), never written in the
 * `payload`.
 */

/** Event types of sprints, each at version 1. */
export const SPRINT_EVENT_TYPES = {
  planned: "sprint.planned",
} as const;

/** Stories in one sprint, at most. */
export const MAX_SPRINT_STORIES = 100;

/** Agents, and humans, in one sprint's capacity, at most. */
export const MAX_SPRINT_CAPACITY = 20;

/** The largest amount a sprint records, in US dollars: a story's budget or the total. */
export const MAX_SPRINT_USD = 1_000_000;

/** The prefix of a sprint checkpoint's title, before the goal. */
export const SPRINT_TITLE_PREFIX = "Sprint: ";

/** A checkpoint's title holds 120 characters: the goal fits after the prefix, never cut. */
export const MAX_SPRINT_GOAL = 120 - SPRINT_TITLE_PREFIX.length;

/** A checkpoint's summary holds 2000 characters: the planner's text and the generated lines. */
export const MAX_SPRINT_CHECKPOINT_SUMMARY = 2000;

/** `S-` then the last 10 characters of the ULID of the event that planned the sprint. */
export const SprintIdSchema = z.string().regex(/^S-[0-9A-HJKMNP-TV-Z]{10}$/, {
  message: "expected S- then 10 characters, for example S-7M2K9QX4TB",
});

/** The id of the sprint planned by the event `eventId`: stable, never renumbered. */
export function sprintIdOf(eventId: string): string {
  return `S-${eventId.slice(-10)}`;
}

/** A sprint goal: one line, short enough for the checkpoint's title to hold it whole. */
const GoalSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SPRINT_GOAL)
  .refine((goal) => !/[\r\n]/.test(goal), { message: "expected a single line" });

const unique = <T extends z.ZodType<string>>(item: T, min: number, max: number, what: string) =>
  z
    .array(item)
    .min(min)
    .max(max)
    .refine((items) => new Set(items).size === items.length, {
      message: `${what} must differ`,
    });

/** The stories a planner proposes, in the order they are built. */
const SprintStoryIdsSchema = unique(StoryIdSchema, 1, MAX_SPRINT_STORIES, "stories");

const UsdSchema = z.number().finite().min(0).max(MAX_SPRINT_USD);

/** Who builds a story: an agent, or `creator` (the same format as a document's `owner`). */
const OwnerSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * One story of a recorded sprint: its id, and its owner and budget as they were when the sprint
 * was checked. `next` reads them from here, never from the working copy.
 */
export const SprintStoryEntrySchema = z.strictObject({
  id: StoryIdSchema,
  owner: OwnerSchema,
  budget_usd: UsdSchema,
});
export type SprintStoryEntry = z.infer<typeof SprintStoryEntrySchema>;

/**
 * Who builds the sprint: the agents (developers, or any active agent that owns a story) and the
 * number of humans. The engine never estimates a load: it records what the planner declared.
 */
export const SprintCapacitySchema = z.strictObject({
  agents: unique(AgentIdSchema.max(64), 0, MAX_SPRINT_CAPACITY, "agents"),
  humans: z.int().min(0).max(MAX_SPRINT_CAPACITY),
});
export type SprintCapacity = z.infer<typeof SprintCapacitySchema>;

/** `payload` of `sprint.planned`: the sprint as `core` checked it, and its checkpoint. */
export const SprintPlannedPayloadSchema = z.strictObject({
  goal: GoalSchema,
  /** The stories in order, each with its owner and budget. */
  stories: z
    .array(SprintStoryEntrySchema)
    .min(1)
    .max(MAX_SPRINT_STORIES)
    .refine((stories) => new Set(stories.map((story) => story.id)).size === stories.length, {
      message: "stories must differ",
    }),
  capacity: SprintCapacitySchema,
  /** The sum of the stories' `budget_usd`, rounded to the micro-dollar. */
  budget_usd: UsdSchema,
  /** The ceiling the creator gave, when there is one. */
  budget_limit_usd: UsdSchema.positive().optional(),
  /** The `document` checkpoint opened in the same write, which submits the sprint. */
  checkpoint: CheckpointIdSchema,
});
export type SprintPlannedPayload = z.infer<typeof SprintPlannedPayloadSchema>;

/** Input of `plan_sprint`. */
export const PlanSprintInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  goal: GoalSchema,
  stories: SprintStoryIdsSchema,
  capacity: SprintCapacitySchema,
  budget_limit_usd: UsdSchema.positive().optional(),
  /**
   * Why this sprint: the reasons for the order, the risks, what was left out. It shares the
   * checkpoint's summary with the generated lines (`too_long` when it does not fit).
   */
  summary: z.string().trim().min(1).max(1500),
});
export type PlanSprintInput = z.infer<typeof PlanSprintInputSchema>;

/** Why `plan_sprint` refuses a proposal (`SPRINT_INVALID`). */
export const SPRINT_PROBLEM_REASONS = [
  "unknown_story",
  "duplicate_story",
  "invalid_story",
  "not_validated",
  "done",
  "dependency_missing",
  "dependency_later",
  "agent_inactive",
  "no_capacity",
  "owner_unavailable",
  "over_budget",
  "proposal_open",
  /** The checkpoint's summary cannot hold the generated lines, or the planner's text with them. */
  "too_long",
  /** A story file that could not be read. */
  "unreadable",
  /** A story's budget more than three times off what the product measured, or the method's reference. */
  "budget_out_of_range",
] as const;
export type SprintProblemReason = (typeof SPRINT_PROBLEM_REASONS)[number];
