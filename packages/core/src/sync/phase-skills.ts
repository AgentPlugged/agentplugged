import type { MethodConfig, PhaseId } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { isSkipped, skippedPhases } from "../journey/journey-rules.js";
import type { Definition } from "../method/definitions.js";
import { activePhases, phaseProgress } from "../phases/phases.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { computeProjection } from "../projection/compute-projection.js";

/**
 * The skills a tool gets are those of the current phase: the list of their descriptions is read at
 * every request of a session, so the skills of the other phases are left out of it. A skill left
 * out is still called by its name: its definition stays in `.agentplugged/skills/<name>/`.
 */

/** The skills every phase installs: a change of course, a session to improve, a new agent. */
export const PHASE_SKILL_BASE: readonly string[] = [
  "correct-course",
  "improve-session",
  "workshop",
];

/** The skills of the phases a phase carries on: stories are still built while delivery runs. */
const CARRIED: Readonly<Partial<Record<PhaseId, readonly PhaseId[]>>> = {
  delivery: ["build"],
};

/** On the short path, one spec stands for the framing, the planning and the design. */
const SHORT_PATH_SKILLS: readonly string[] = [
  "write-spec",
  "security-review-architecture",
  "critique-deliverable",
];

/** What `sync` installs for: a phase (and whether the short path is taken), or every skill. */
export interface SkillPhase {
  readonly phase: PhaseId;
  readonly shortPath: boolean;
}

/** The name `sync` records for what it installed: the phase, or `all`. */
export function skillPhaseKey(phase: SkillPhase | undefined): PhaseId | "all" {
  return phase === undefined ? "all" : phase.phase;
}

/**
 * The definitions a tool gets: every agent, and the skills of the phase plus the fixed base.
 * Without a phase (no journal, every phase closed), every skill.
 */
export function skillsOfPhase(
  definitions: readonly Definition[],
  phase: SkillPhase | undefined,
): Definition[] {
  if (phase === undefined) return [...definitions];
  const phases = new Set<string>([phase.phase, ...(CARRIED[phase.phase] ?? [])]);
  return definitions.filter((definition) => {
    if (definition.kind !== "skill") return true;
    if (PHASE_SKILL_BASE.includes(definition.name)) return true;
    if (phase.shortPath && SHORT_PATH_SKILLS.includes(definition.name)) return true;
    // A skill that names no phase (one of the creator's) serves every phase.
    const own = (definition.frontmatter as { metadata?: { phase?: string } }).metadata?.phase;
    return own === undefined || phases.has(own);
  });
}

/**
 * The current phase of the product, from its journal; undefined when there is no journal to read
 * (a folder without Git, a test without one) or when no phase is current.
 */
export async function currentSkillPhase(
  context: CommandContext,
  config: MethodConfig,
): Promise<SkillPhase | undefined> {
  if (context.journal === undefined) return undefined;
  let state: Record<string, unknown>;
  try {
    const listing = await context.journal.list();
    state = (
      await computeProjection(listing.events, {
        problems: listing.problems,
        head: listing.head,
        ...(config.product_id === undefined ? {} : { product: config.product_id }),
        allowTestTypes: context.allowTestTypes === true,
      })
    ).state;
  } catch {
    // A journal that cannot be read (no repository, a damaged history) never stops `sync`.
    return undefined;
  }
  return skillPhaseOf(state, config, (context.now ?? Date.now)());
}

/** The current phase drawn from a projection already computed; undefined when none is current. */
export function skillPhaseOf(
  state: Record<string, unknown>,
  config: MethodConfig,
  now: number,
): SkillPhase | undefined {
  const progress = phaseProgress(
    Object.values(checkpointsOf(state)),
    activePhases(config.profile, skippedPhases(state)),
    now,
  );
  if (progress.current === null) return undefined;
  return { phase: progress.current, shortPath: isSkipped(state, "full_path") };
}
