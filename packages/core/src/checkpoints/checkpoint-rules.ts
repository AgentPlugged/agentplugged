import {
  type AgentResult,
  type BlockableAction,
  type CheckpointBlock,
  type CheckpointCard,
  type CheckpointCriterion,
  type CheckpointOpenedPayload,
  type CheckpointRisk,
  type CheckpointStatus,
  type CheckpointType,
  type CheckpointVerdict,
  type ConfirmationMode,
  type CriterionOperator,
  type CriterionVerdict,
  type OpenCheckpointInput,
  type PhaseId,
  RECIPIENT_ROLES,
  type RecipientRole,
  type ResolutionDecision,
} from "@agentplugged/protocol";
import { blocksInForce } from "./resolution-rules.js";

/**
 * The rules of checkpoints, pure functions: the defaults `core` fixes (recipient,
 * confirmation), the checkpoint `submit_result` opens on `blocked`, the actions a checkpoint
 * blocks, and the verdict of its criteria on its measures.
 */

/** Who answers a checkpoint of each type, by default. */
export const DEFAULT_RECIPIENTS: Readonly<Record<CheckpointType, RecipientRole>> = {
  decision: "product",
  document: "product",
  story: "tech_lead",
  release: "tech_lead",
  permission: "security",
  publication: "product",
  phase_end: "product",
  creator_action: "creator",
  memory: "product",
};

const rank = (role: RecipientRole) => RECIPIENT_ROLES.indexOf(role);
const higher = (a: RecipientRole, b: RecipientRole) => (rank(a) >= rank(b) ? a : b);

/**
 * The recipient of a checkpoint: the type's default, replaced by the one asked only when it is
 * more demanding; a `high` risk goes at least to `tech_lead` (`security` for a permission); the
 * end of the design phase goes to `tech_lead` (the architecture to the technical lead).
 * Every role is the creator today: the role is recorded all the same.
 */
export function recipientFor(
  type: CheckpointType,
  risk: CheckpointRisk,
  requested?: RecipientRole,
  phase?: PhaseId,
): RecipientRole {
  // An action reserved to the creator goes to the creator, whatever its risk.
  if (type === "creator_action") return "creator";
  const base = type === "phase_end" && phase === "design" ? "tech_lead" : DEFAULT_RECIPIENTS[type];
  let role = requested !== undefined && rank(requested) > rank(base) ? requested : base;
  if (risk === "high") role = higher(role, type === "permission" ? "security" : "tech_lead");
  return role;
}

/**
 * How the answer is confirmed at the terminal: a gesture undoable for 10 s at `low` or
 * `medium` risk, the creator's presence at `high` risk. Nothing on top for an
 * irreversible action (the question names it; one answer is the creator's agreement).
 */
export function confirmationFor(risk: CheckpointRisk): ConfirmationMode[] {
  return [risk === "high" ? "presence" : "gesture_undo_10s"];
}

/**
 * The `payload` of `checkpoint.opened` from an agent's input: `irreversible` false, documents
 * and blocks empty when absent, recipient and confirmation fixed by the rules above.
 */
export function checkpointPayload(
  input: Omit<OpenCheckpointInput, "agent" | "story">,
): CheckpointOpenedPayload {
  const irreversible = input.irreversible ?? false;
  return {
    type: input.type,
    risk: input.risk,
    irreversible,
    recipient_role: recipientFor(input.type, input.risk, input.recipient_role, input.phase),
    confirmation: confirmationFor(input.risk),
    title: input.title,
    summary: input.summary,
    ...(input.card === undefined ? {} : { card: cardOf(input.card) }),
    documents: input.documents ?? [],
    blocks: input.blocks ?? [],
    ...(input.options === undefined ? {} : { options: input.options }),
    ...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
    ...(input.criteria === undefined ? {} : { criteria: input.criteria }),
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    ...(input.publication === undefined ? {} : { publication: { ...input.publication } }),
  };
}

/** `text` cut to `max` UTF-16 units, ending with `…` when cut (never half a surrogate pair). */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * The checkpoint a `blocked` result opens: a `story` checkpoint at `medium` risk, titled
 * `Blocked: <story or agent>`, whose summary is the result's followed by its open questions, and
 * which blocks completing and reviewing the story. A result without a story blocks nothing.
 */
export function blockedResultCheckpoint(
  agent: string,
  story: string | undefined,
  result: Pick<AgentResult, "summary" | "open_questions">,
): CheckpointOpenedPayload {
  const questions =
    result.open_questions.length === 0
      ? ""
      : `\n\nOpen questions:\n${result.open_questions.map((question) => `- ${question}`).join("\n")}`;
  return {
    ...checkpointPayload({
      type: "story",
      risk: "medium",
      title: truncate(`Blocked: ${story ?? agent}`, 120),
      summary: truncate(`${result.summary}${questions}`, 2000),
      blocks:
        story === undefined
          ? []
          : [
              { action: "story.complete", story },
              { action: "story.review", story },
            ],
    }),
    source: "blocked_result",
  };
}

/** What the reuse of a `blocked` result's checkpoint needs of a checkpoint. */
export interface ReusableCheckpoint {
  readonly id: string;
  readonly status: string;
  readonly story: string | null;
  readonly opened_by: string | null;
  readonly opened_event: string;
  readonly source: string | null;
}

/**
 * The checkpoint a `blocked` result of `agent` on `story` (undefined: none) opened and that is
 * still open, the first opened when there are several: a new `blocked` result reuses it instead
 * of opening another one.
 */
export function openBlockedResultCheckpoint(
  checkpoints: Iterable<ReusableCheckpoint>,
  agent: string,
  story: string | undefined,
): ReusableCheckpoint | undefined {
  return [...checkpoints]
    .sort(byOpening)
    .find(
      (checkpoint) =>
        checkpoint.status === "open" &&
        checkpoint.source === "blocked_result" &&
        checkpoint.opened_by === agent &&
        checkpoint.story === (story ?? null),
    );
}

/** Opening order: the full ULID of the event that opened each checkpoint. */
export function byOpening(
  a: { readonly opened_event: string },
  b: { readonly opened_event: string },
): number {
  return a.opened_event < b.opened_event ? -1 : a.opened_event > b.opened_event ? 1 : 0;
}

/**
 * The story a block applies to: its own, else its checkpoint's; undefined when it applies to
 * every story (`open_checkpoint` refuses such a block, but a journal may hold one).
 */
export function blockScope(
  block: CheckpointBlock,
  checkpointStory: string | null,
): string | undefined {
  return block.story ?? checkpointStory ?? undefined;
}

/** What the block check needs of a checkpoint. */
export interface BlockingCheckpoint {
  readonly id: string;
  readonly status: CheckpointStatus;
  readonly story: string | null;
  readonly blocks: readonly CheckpointBlock[];
  /** The ULID of the event that opened it. */
  readonly opened_event: string;
  /** The creator's answer: a waiver blocks again once its deadline is past. */
  readonly resolution?: {
    readonly decision: ResolutionDecision;
    readonly waiver_until: string | null;
  } | null;
  /** Its blocks no longer apply (a lifting answer, or superseded so). */
  readonly blocks_lifted?: boolean;
}

/**
 * The first checkpoint (in opening order) whose blocks apply at `now` (milliseconds, the system
 * clock: `blocksInForce`) and that blocks `action` on `story`: one of its blocks names the
 * action, on the same story or on every story. An action without a story (`story` undefined) is
 * blocked by any such checkpoint that blocks this action, whatever its story: a story-less
 * `complete` never slips past a block. Blocks apply while a checkpoint is open, after a refusal
 * until a superseding checkpoint is answered with a lifting decision, and once a waiver is past.
 */
export function blockingCheckpoint(
  checkpoints: Iterable<BlockingCheckpoint>,
  action: BlockableAction,
  story: string | undefined,
  now: number = Date.now(),
): BlockingCheckpoint | undefined {
  return [...checkpoints].sort(byOpening).find(
    (checkpoint) =>
      blocksInForce(checkpoint, now) &&
      checkpoint.blocks.some((block) => {
        if (block.action !== action) return false;
        const scope = blockScope(block, checkpoint.story);
        return story === undefined || scope === undefined || scope === story;
      }),
  );
}

/** True when `measure <op> threshold`. */
export function satisfies(measure: number, op: CriterionOperator, threshold: number): boolean {
  switch (op) {
    case ">=":
      return measure >= threshold;
    case "<=":
      return measure <= threshold;
    default:
      return measure === threshold;
  }
}

/**
 * The verdict of `criteria` on `measures`: a missing measure fails (`missing:<metric>`), a
 * `blocking` criterion not met fails, else a `reservation` criterion not met gives
 * `pass_with_reservations`, else `pass`. Each criterion is listed with its measure and result.
 */
export function verdictOf(
  criteria: readonly CheckpointCriterion[],
  measures: Readonly<Record<string, number>>,
): CheckpointVerdict {
  const judged: CriterionVerdict[] = criteria.map((criterion) => {
    const measure = Object.hasOwn(measures, criterion.metric)
      ? (measures[criterion.metric] as number)
      : null;
    return {
      id: criterion.id,
      metric: criterion.metric,
      op: criterion.op,
      threshold: criterion.threshold,
      severity: criterion.severity,
      measure,
      satisfied: measure !== null && satisfies(measure, criterion.op, criterion.threshold),
      reason: measure === null ? `missing:${criterion.metric}` : null,
    };
  });
  const reasons = [
    ...new Set(judged.flatMap((entry) => (entry.reason === null ? [] : [entry.reason]))),
  ];
  const unmet = (severity: string) =>
    judged.some((entry) => entry.severity === severity && !entry.satisfied);
  const result =
    reasons.length > 0 || unmet("blocking")
      ? "fail"
      : unmet("reservation")
        ? "pass_with_reservations"
        : "pass";
  return { result, reasons, criteria: judged };
}

/** A copy of a card, so that the journal's payload shares nothing with the agent's input. */
export function cardOf(card: CheckpointCard): CheckpointCard {
  return {
    effect: card.effect,
    ...(card.why === undefined ? {} : { why: { ...card.why } }),
    ...(card.risks === undefined ? {} : { risks: [...card.risks] }),
    ...(card.opinions === undefined
      ? {}
      : { opinions: card.opinions.map((opinion) => ({ ...opinion })) }),
  };
}
