import type { CommandContext } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { AgentPluggedError } from "../errors.js";
import { loadMethodConfig } from "../init/method-config.js";
import type { NextStep } from "../next/next.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { activeAgentNames, loadDefinitions } from "../sync/sync-command.js";
import { type TableOffer, tableCandidate, tableOffer } from "./table-rules.js";

/** What `next` adds for the round table, when there is something to say. */
export interface TableNext {
  /** Offer, once per story, the three views of the sensitive story whose merge waits. */
  readonly table?: TableOffer;
}

/** The active agents of the product, or undefined when they cannot be read. */
async function activeTeam(context: CommandContext): Promise<ReadonlySet<string> | undefined> {
  const loaded = await loadMethodConfig(context.files);
  const definitions = await loadDefinitions(context.files);
  if (loaded instanceof AgentPluggedError || definitions instanceof AgentPluggedError) {
    return undefined;
  }
  return activeAgentNames(definitions, loaded.config);
}

/**
 * The three views of a sensitive story, when the step is the creator's validation of its merge, the
 * offer was never made for it and the team has the product, delivery and quality sides. The team is
 * read (`team`) only for a story to offer.
 */
export async function tableNextOf(
  state: Readonly<Record<string, unknown>>,
  step: Pick<NextStep, "step" | "checkpoint">,
  team: () => Promise<ReadonlySet<string> | undefined>,
): Promise<TableNext> {
  if (step.step !== "validation" || step.checkpoint === null) return {};
  const checkpoints = (state.checkpoints ?? {}) as Record<string, CheckpointState>;
  if (!Object.hasOwn(checkpoints, step.checkpoint)) return {};
  const story = tableCandidate(state, checkpoints[step.checkpoint]);
  if (story === undefined) return {};
  const active = await team();
  const offer = active === undefined ? undefined : tableOffer(story, active);
  return offer === undefined ? {} : { table: offer };
}

/** What `next` says of the round table. Reads the journal and, only for a candidate, the team. */
export async function tableNext(context: CommandContext, step: NextStep): Promise<TableNext> {
  if (step.step !== "validation") return {};
  return tableNextOf(await currentState(context), step, () => activeTeam(context));
}
