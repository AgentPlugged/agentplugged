import { z } from "zod";
import { AgentIdSchema, SkillNameSchema } from "./method-config.js";

/**
 * What agents declare through the MCP server: the input of each tool, the event types
 * it writes and their `payload`, and the structured result of an agent's run. An event's
 * agent is its `actor.agent` and its story the envelope's `story`: neither is repeated in the
 * `payload`.
 */

/** Event types written by the agents' commands, each at version 1. */
export const AGENT_EVENT_TYPES = {
  statusReported: "agent.status_reported",
  progressReported: "agent.progress_reported",
  costReported: "cost.reported",
  storyStatusChanged: "story.status_changed",
  resultRecorded: "agent.result_recorded",
} as const;

/** What an agent is doing. */
export const AGENT_STATUSES = ["working", "waiting", "idle", "blocked"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** The statuses an agent may give a story (validating one belongs to the creator). */
export const AGENT_STORY_STATUSES = ["in_progress", "in_review", "blocked"] as const;
export type AgentStoryStatus = (typeof AGENT_STORY_STATUSES)[number];

/** How an agent's run ended. */
export const RESULT_STATUSES = ["complete", "partial", "blocked"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** A story identifier in its canonical form, `<epic>-<story>` (`2-6`). */
export const StoryIdSchema = z.string().regex(/^\d{1,6}-\d{1,6}$/, {
  message: "expected <epic>-<story>, for example 2-6",
});

/**
 * The reserved agent id of the creator's main AI session (not an agent of the method): every
 * agent tool accepts it besides the product's active agents.
 */
export const MAIN_SESSION_AGENT = "main";

/** Tokens of one cost report: at most a billion each way. */
export const MAX_TOKENS_PER_REPORT = 1_000_000_000;

/** A free text of 1 to `max` characters. */
const text = (max: number) => z.string().trim().min(1).max(max);

const UsdSchema = z.number().finite().min(0).max(1_000_000);
const TokensSchema = z.number().int().min(0).max(MAX_TOKENS_PER_REPORT);

/** `payload` of `agent.status_reported`. */
export const StatusReportedPayloadSchema = z.strictObject({
  status: z.enum(AGENT_STATUSES),
  task: text(500).optional(),
  /** The skill started with a `working` status; a later report of the agent without it ends it. */
  skill: SkillNameSchema.optional(),
});

/** `payload` of `agent.progress_reported` (its story is the envelope's). */
export const ProgressReportedPayloadSchema = z.strictObject({
  percent: z.number().int().min(0).max(100).optional(),
  note: text(2000),
});

const COST_REQUIRED = "give usd, tokens_in, tokens_out or quota_percent";

/** How the tool bills the work: a real cost, or the equivalent of a subscription. */
export const COST_BILLINGS = ["usage", "subscription"] as const;
export type CostBilling = (typeof COST_BILLINGS)[number];

/** The task a cost belongs to, chosen by the agent: cumulative reports of a run replace each other. */
export const CostRunSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, {
  message: "expected 1 to 64 letters, digits, dots, hyphens or underscores",
});

/**
 * The fields of a cost: dollars, real or estimated, tokens, how the tool
 * bills (`subscription` is always estimated), the share of its quota used, and the task (`run`)
 * whose total so far a `cumulative` report gives.
 */
const costFields = {
  usd: UsdSchema.optional(),
  estimated: z.boolean(),
  tokens_in: TokensSchema.optional(),
  tokens_out: TokensSchema.optional(),
  billing: z.enum(COST_BILLINGS).optional(),
  quota_percent: z.number().finite().min(0).max(100).optional(),
  run: CostRunSchema.optional(),
  cumulative: z.boolean().optional(),
};

interface CheckedCost {
  readonly usd?: number | undefined;
  readonly estimated: boolean;
  readonly tokens_in?: number | undefined;
  readonly tokens_out?: number | undefined;
  readonly billing?: CostBilling | undefined;
  readonly quota_percent?: number | undefined;
  readonly run?: string | undefined;
  readonly cumulative?: boolean | undefined;
}

/**
 * The rules across a cost's fields: something measured, a subscription always estimated, and a
 * cumulative report always naming its run.
 */
function checkCost(cost: CheckedCost, context: z.RefinementCtx): void {
  if (
    cost.usd === undefined &&
    cost.tokens_in === undefined &&
    cost.tokens_out === undefined &&
    cost.quota_percent === undefined
  ) {
    context.addIssue({ code: "custom", path: [], message: COST_REQUIRED });
  }
  if (cost.billing === "subscription" && cost.estimated !== true) {
    context.addIssue({
      code: "custom",
      path: ["estimated"],
      message: "a subscription's cost is an equivalent: estimated must be true",
    });
  }
  if (cost.cumulative === true && cost.run === undefined) {
    context.addIssue({
      code: "custom",
      path: ["run"],
      message: "a cumulative report names its run",
    });
  }
}

/**
 * `payload` of `cost.reported` (version 2; version 1 converts as is): a cost in US
 * dollars, real or estimated, its tokens, billing, quota and run. Sensitive: written encrypted
 * with the product key; an older one in clear is read as is.
 */
export const CostReportedPayloadSchema = z.strictObject(costFields).superRefine(checkCost);
export type CostReportedPayload = z.infer<typeof CostReportedPayloadSchema>;

/** `payload` of `story.status_changed` (its story is the envelope's). */
export const StoryStatusChangedPayloadSchema = z.strictObject({
  status: z.enum(AGENT_STORY_STATUSES),
});

/**
 * The structured result of an agent's run, the `payload` of `agent.result_recorded`:
 * how it ended, what it did, and what it assumed, left open or found in conflict.
 */
export const AgentResultSchema = z.strictObject({
  status: z.enum(RESULT_STATUSES),
  summary: text(4000),
  assumptions: z.array(text(1000)).max(50),
  open_questions: z.array(text(1000)).max(50),
  conflicts: z.array(text(1000)).max(50),
});

export type AgentResult = z.infer<typeof AgentResultSchema>;

/** Every tool names the agent that calls it: an active agent of the product. */
const agent = AgentIdSchema.max(64);

/** Input of `report_status`. */
export const ReportStatusInputSchema = z.strictObject({
  agent,
  status: z.enum(AGENT_STATUSES),
  task: text(500).optional(),
  story: StoryIdSchema.optional(),
  skill: SkillNameSchema.optional(),
});

/** Input of `report_progress`. */
export const ReportProgressInputSchema = z.strictObject({
  agent,
  story: StoryIdSchema,
  percent: z.number().int().min(0).max(100).optional(),
  note: text(2000),
});

/** Input of `report_cost`. */
export const ReportCostInputSchema = z
  .strictObject({ agent, story: StoryIdSchema.optional(), ...costFields })
  .superRefine(checkCost);

/** Input of `update_story`. */
export const UpdateStoryInputSchema = z.strictObject({
  agent,
  story: StoryIdSchema,
  status: z.enum(AGENT_STORY_STATUSES),
});

/**
 * The end-of-run summary the creator reads: short and plain, what is done, what is
 * proven, what remains, what is expected from them. Noah and the other surfaces show this summary, not
 * the detail; the detail stays one call away (the progress notes, the pull request, the review).
 * Results already in the journal may be longer (`AgentResultSchema` keeps its old bounds).
 */
export const RESULT_SUMMARY_MAX = 800;
/** Each assumption, open question or conflict of a result: one plain sentence or two. */
export const RESULT_ITEM_MAX = 400;
export const RESULT_ITEMS_MAX = 10;

const shortText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(
      max,
      `${what}: at most ${max} characters; the long account goes in story.progress notes and in the pull request`,
    );

/** Input of `submit_result`: the agent, its story when it has one, and its result. */
export const SubmitResultInputSchema = z.strictObject({
  agent,
  story: StoryIdSchema.optional(),
  ...AgentResultSchema.shape,
  summary: shortText(RESULT_SUMMARY_MAX, "summary"),
  assumptions: z.array(shortText(RESULT_ITEM_MAX, "assumption")).max(RESULT_ITEMS_MAX),
  open_questions: z.array(shortText(RESULT_ITEM_MAX, "open question")).max(RESULT_ITEMS_MAX),
  conflicts: z.array(shortText(RESULT_ITEM_MAX, "conflict")).max(RESULT_ITEMS_MAX),
});

/** Input of the agents' `next`: nothing. */
export const NextInputSchema = z.strictObject({});

/**
 * A note the bridge writes about a run it drives: a stable code and its parameters, never a
 * sentence, so that each view tells it in the creator's language. Written `run:<code>` then, when
 * there are parameters, `?name=value&...` (percent-encoded). A note that does not start with
 * `run:` is free text written by an agent: shown as is, as the agent's own (untrusted) content.
 */
export const RUN_NOTE_PREFIX = "run:";

/**
 * - `cost_partial`: the run ended before the tool gave its final cost; the cost counted is the last
 *   report known (an estimate, a lower bound);
 * - `cost_unknown`: the tool gave no consumption (or a model with no price): no amount is claimed;
 * - `budget_alert`: the story's cost reached the alert ratio of its budget;
 * - `budget_exceeded`: the story's cost went over its budget and its agent was stopped for it;
 * - `budget_flagged`: the story's cost went over its budget and the setting only flags it.
 * - `activity`: what the run did, in numbers only (`read`, `edited`, `commands`, `failed`): never a
 *   path, a command or a text.
 */
export const RUN_NOTE_CODES = [
  "permission_denied",
  "failed",
  "timeout",
  "not_started",
  "cost_partial",
  "cost_unknown",
  "budget_alert",
  "budget_exceeded",
  "budget_flagged",
  "activity",
] as const;
export type RunNoteCode = (typeof RUN_NOTE_CODES)[number];

export type RunNoteParams = Readonly<Record<string, string | number>>;

export function formatRunNote(code: RunNoteCode, params: RunNoteParams = {}): string {
  const query = Object.entries(params)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return `${RUN_NOTE_PREFIX}${code}${query === "" ? "" : `?${query}`}`;
}

/** The code and parameters of a bridge's run note, or undefined for any other text. */
export function parseRunNote(
  text: string,
): { code: RunNoteCode; params: Record<string, string> } | undefined {
  if (!text.startsWith(RUN_NOTE_PREFIX)) return undefined;
  const [head = "", query = ""] = text.slice(RUN_NOTE_PREFIX.length).split("?", 2);
  const code = RUN_NOTE_CODES.find((known) => known === head);
  if (code === undefined) return undefined;
  const params: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const [name = "", value = ""] = pair.split("=", 2);
    try {
      params[decodeURIComponent(name)] = decodeURIComponent(value);
    } catch {
      // A malformed piece is left out.
    }
  }
  return { code, params };
}
