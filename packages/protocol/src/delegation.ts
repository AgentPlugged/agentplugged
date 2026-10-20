import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { hasControlCharacter } from "./deferred.js";
import { AgentIdSchema, SkillNameSchema } from "./method-config.js";

/**
 * Noah, the assistant of the AI tool's main session: the one
 * agent that routes the creator's requests to the right agent or skill. He hands work over with
 * `delegate`, which records the handover in the journal (`agent.delegated`); the AI tool runs it
 * itself.
 */

/** The identifier of the main session's assistant. */
export const NOAH_AGENT = "noah";

/**
 * How Noah hands work over: in the same conversation (`conversation`: a brief, a PRD, a UX
 * specification, an architecture, anything that needs an exchange with the creator), or to a
 * sub-agent of the AI tool (`autonomous`: a story, a review, a fix after CI, the knowledge base).
 */
export const DELEGATION_MODES = ["conversation", "autonomous"] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];

/** What a handover goes to: an agent of the method or a skill. */
export const DELEGATION_TARGET_KINDS = ["agent", "skill"] as const;
export type DelegationTargetKind = (typeof DELEGATION_TARGET_KINDS)[number];

/** Event types of the handovers, each at version 1. */
export const DELEGATION_EVENT_TYPES = {
  delegated: "agent.delegated",
} as const;

/**
 * The instruction Noah gives with a handover: 1 to 2000 characters, line breaks and tabs allowed,
 * no other control character.
 */
const BriefSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((text) => !hasControlCharacter(text, true), {
    message: "expected no control character but line breaks and tabs",
  });

/** Input of `delegate`: Noah's own id, the agent or skill, the mode, the brief, the story. */
export const DelegateInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  to: SkillNameSchema,
  mode: z.enum(DELEGATION_MODES),
  brief: BriefSchema,
  story: StoryIdSchema.optional(),
});
export type DelegateInput = z.infer<typeof DelegateInputSchema>;

/** `payload` of `agent.delegated` (its story, when it has one, is the envelope's). */
export const AgentDelegatedPayloadSchema = z.strictObject({
  to: SkillNameSchema,
  kind: z.enum(DELEGATION_TARGET_KINDS),
  mode: z.enum(DELEGATION_MODES),
  brief: BriefSchema,
});
export type AgentDelegatedPayload = z.infer<typeof AgentDelegatedPayloadSchema>;

/** Why `delegate` refuses a handover (`DELEGATION_INVALID`); nothing is written. */
export const DELEGATION_INVALID_REASONS = [
  /** No installed agent nor skill has this id (or it is `main`). */
  "unknown_target",
  /** The agent or skill is installed, but inactive for this product or disabled. */
  "inactive_target",
  /** Noah never hands work over to himself. */
  "self",
  /** The skill belongs to an active agent's menu: the work goes to that agent. */
  "skill_has_owner",
  /** A skill has no sub-agent of its own: it runs in the conversation only. */
  "skill_autonomous",
  /** A developer works on a story: one instance per story. */
  "story_required",
  /** Another developer already builds this story: a story never has two developers. */
  "story_taken",
  /** The profile's ceiling of stories built at once is reached. */
  "parallel_limit",
  /** The creator paused the team: nothing is handed over until they resume it. */
  "team_paused",
] as const;
export type DelegationInvalidReason = (typeof DELEGATION_INVALID_REASONS)[number];
