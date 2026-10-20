import {
  DELEGATION_EVENT_TYPES,
  type DelegateInput,
  DelegateInputSchema,
  type DelegationInvalidReason,
  type DelegationTargetKind,
  ErrorCode,
  MAIN_SESSION_AGENT,
  type MethodConfig,
  NOAH_AGENT,
} from "@agentplugged/protocol";
import { agentEventCommand } from "../agent-activity/agent-commands.js";
import { currentDeveloper } from "../agents/agent-aliases.js";
import { roleForbidden } from "../agents/noah-role.js";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { parallelLimitProblem, storyJournalView } from "../stories/story-start.js";
import { isDeveloper } from "../sync/developers.js";
import { activeDefinitions, loadDefinitions } from "../sync/sync-command.js";
import { openPause } from "../team/team-rules.js";

/** What `delegate` reads of the installed definitions, once, before the write. */
export interface DelegationTarget {
  /** Agent or skill, when one with this id is installed. */
  readonly kind: DelegationTargetKind | undefined;
  /** Installed and active for this product (not inactive by the profile, not disabled). */
  readonly active: boolean;
  /** An agent of the `code` domain with a specialty: one instance per story. */
  readonly developer: boolean;
  /**
   * For a skill: the first active agent whose menu calls it, its owner. The work then goes to
   * that agent, never to the skill alone (Noah would run it himself).
   */
  readonly owner?: string;
}

/** `DELEGATION_INVALID`: the handover cannot go there; nothing is written. */
export function delegationInvalid(
  to: string,
  reason: DelegationInvalidReason,
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.DELEGATION_INVALID, `error.delegation_invalid.${reason}`, {
    to,
    reason,
    ...details,
  });
}

/** The target of a handover, as the working copy installs it. */
async function readTarget(
  context: CommandContext,
  config: MethodConfig,
  to: string,
): Promise<DelegationTarget | AgentPluggedError> {
  const definitions = await loadDefinitions(context.files);
  if (definitions instanceof AgentPluggedError) return definitions;
  const installed = definitions.find((definition) => definition.name === to);
  if (installed === undefined) return { kind: undefined, active: false, developer: false };
  const enabled = activeDefinitions(definitions, config);
  const active = enabled.some((definition) => definition.name === to);
  const owner =
    installed.kind === "skill"
      ? enabled.find(
          (definition) =>
            definition.kind === "agent" &&
            definition.name !== NOAH_AGENT &&
            (definition.agent?.menu ?? []).some((item) => item.skill === to),
        )?.name
      : undefined;
  return {
    kind: installed.kind,
    active,
    developer: isDeveloper(installed),
    ...(owner === undefined ? {} : { owner }),
  };
}

/** Why a handover's target is refused before the journal is read, or undefined. */
function targetProblem(
  input: DelegateInput,
  target: DelegationTarget,
): AgentPluggedError | undefined {
  if (input.to === NOAH_AGENT) return delegationInvalid(input.to, "self");
  if (input.to === MAIN_SESSION_AGENT || target.kind === undefined) {
    return delegationInvalid(input.to, "unknown_target");
  }
  if (!target.active) return delegationInvalid(input.to, "inactive_target");
  // A skill an agent owns goes through that agent (a developer's skill through the developer,
  // with its story): loaded alone, Noah would do the work himself.
  if (target.owner !== undefined) {
    return delegationInvalid(input.to, "skill_has_owner", { owner: target.owner });
  }
  // A skill has no sub-agent of its own: it runs in the conversation only.
  if (target.kind === "skill" && input.mode === "autonomous") {
    return delegationInvalid(input.to, "skill_autonomous");
  }
  if (target.developer && input.story === undefined) {
    return delegationInvalid(input.to, "story_required");
  }
  return undefined;
}

/**
 * `delegate`: Noah records a handover to an agent or a skill, in the
 * same conversation (`conversation`) or to a sub-agent (`autonomous`), with the brief he gives
 * it. The engine writes `agent.delegated`; the AI tool runs the handover.
 * Only Noah delegates (`ROLE_FORBIDDEN` otherwise). The target must be an active agent
 * or skill of the product, never Noah himself; a developer goes with its story, one instance per
 * story: a story another developer builds, or one more story past the profile's ceiling of
 * stories built at once, is refused (`DELEGATION_INVALID`), checked again under the journal lock.
 * It starts nothing by itself.
 */
export const delegateCommand = agentEventCommand<typeof DelegateInputSchema, DelegationTarget>({
  name: "delegate",
  description:
    "Noah only: record a handover to an agent or a skill before you hand the work over. `agent` is `noah`; `to` the agent or skill id (`iris`, `write-prd`…), active for this product, never `noah`; `mode` `conversation` (brief, PRD, UX specification, architecture: anything that needs an exchange with the creator; load the agent's definition into this conversation, it hands back to you when done) or `autonomous` (a story, a QA or security review, a fix after CI, the knowledge base: launch it as a sub-agent of your tool, in parallel when tasks are independent); `brief` the instruction you give it, in a few sentences; `story` the story it works on (required for a developer: one instance per story, \"Sam · story 4-2\"). The brief carries the creator's words and the decisions they approved, never an option still open. A skill an agent owns goes to that agent, and a skill runs in the conversation only. Refused, nothing written: ROLE_FORBIDDEN (only Noah delegates), DELEGATION_INVALID with the reason (unknown_target, inactive_target, self, skill_has_owner: hand over to its owner, skill_autonomous: a skill has no sub-agent, story_required, story_taken: another developer builds the story, a story never has two developers; parallel_limit: the profile's ceiling of stories built at once is reached). It records the handover only: the AI tool runs it, and `start_story` checks the story again when it starts.",
  inputSchema: DelegateInputSchema,
  needsState: (input) => input.story !== undefined,
  async prepare(input, context, _agents, config) {
    // Only Noah delegates: refused before the definitions are read.
    if (input.agent !== NOAH_AGENT) throw roleForbidden(input.agent, "delegate");
    const target = await readTarget(context, config, input.to);
    if (target instanceof AgentPluggedError) throw target;
    return target;
  },
  events(input, _state, prepared) {
    return {
      events: [
        {
          type: DELEGATION_EVENT_TYPES.delegated,
          story: input.story,
          payload: {
            to: input.to,
            kind: prepared?.kind ?? "agent",
            mode: input.mode,
            brief: input.brief,
          },
        },
      ],
    };
  },
  check(input, state, { config, now, prepared }) {
    if (input.agent !== NOAH_AGENT) return roleForbidden(input.agent, "delegate");
    // The creator paused the team: nothing is handed over until they resume it.
    if (openPause(state) !== undefined) return delegationInvalid(input.to, "team_paused");
    if (prepared === undefined) return delegationInvalid(input.to, "unknown_target");
    const refused = targetProblem(input, prepared);
    if (refused !== undefined) return refused;
    if (!prepared.developer || input.story === undefined) return undefined;
    // A story never has two developers, and the ceiling counts every instance.
    const view = storyJournalView(state, input.story, now);
    const started = view.story?.started;
    if (started !== undefined) {
      const builder = currentDeveloper(started.agent);
      if (builder !== input.to) {
        // The developer who builds it now: a retired one's successor.
        return delegationInvalid(input.to, "story_taken", { story: input.story, agent: builder });
      }
      return undefined;
    }
    const full = parallelLimitProblem(input.story, config.profile?.max_parallel_stories, view);
    if (full !== undefined) {
      return delegationInvalid(input.to, "parallel_limit", {
        story: input.story,
        limit: full.details.limit,
        building: full.details.building,
      });
    }
    return undefined;
  },
});
