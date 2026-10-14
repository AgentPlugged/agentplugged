import {
  type GitWorkflow,
  isStoryStep,
  type JourneyStep,
  PHASE_STEPS,
  type PhaseId,
  resolveGitWorkflow,
} from "@agentplugged/protocol";

/**
 * The steps the creator skipped, pure. The journey is a proposal: a skip is the
 * creator's own answer (a `step_skip` creator's action, proved like any other answer), recorded in
 * the projection (`state.skips`) with who said it and why; the engine reads it where it used to
 * demand the step, and what it checked becomes a warning. Nothing here refuses anything.
 */

/** A step skipped, as the projection keeps it. */
export interface SkipState {
  readonly step: JourneyStep;
  /** The story it covers, or null for the product (or for every story). */
  readonly story: string | null;
  /** The creator's reason, as they gave it (« no reason given » when they gave none). */
  readonly reason: string;
  /** Who decided it: the creator (`creator`), or their device at the terminal. */
  readonly by: string;
  /** Where the answer was given: the chat, the AI tool's form or the terminal. */
  readonly source: string;
  readonly at: string;
  /** The `creator_action.executed` that recorded it. */
  readonly event: string;
  /** The `creator_action` checkpoint the creator answered. */
  readonly checkpoint: string;
}

/** `state.skips`: the steps skipped now, by `skipKey`. */
export type Skips = Readonly<Record<string, SkipState>>;

type State = Readonly<Record<string, unknown>>;

/** The key of a skip: the step, with `@<story>` for one story of a story's step. */
export function skipKey(step: JourneyStep, story?: string | null): string {
  return story === undefined || story === null ? step : `${step}@${story}`;
}

/** The skips of a projection's state (an empty record when there are none). */
export function skipsOf(state: State): Skips {
  const value = state.skips;
  return typeof value === "object" && value !== null ? (value as Skips) : {};
}

function has(skips: Skips, key: string): boolean {
  return Object.hasOwn(skips, key);
}

/**
 * True when the creator skipped `step`: a step of the product by itself; a step of a story for
 * every story, or for `story` when it is given (the skips of one story never reach another).
 */
export function isSkipped(state: State, step: JourneyStep, story?: string | null): boolean {
  const skips = skipsOf(state);
  if (has(skips, skipKey(step))) return true;
  if (chosenOut(state, step)) return true;
  // No CI set up by the creator's choice: the stories go without a CI too.
  if (step === "story_ci" && has(skips, skipKey("ci_setup"))) return true;
  return isStoryStep(step) && story !== undefined && story !== null
    ? has(skips, skipKey(step, story))
    : false;
}

/**
 * A step the creator's Git workflow leaves out, by their choice of workflow rather than a
 * skip of the journey: no CI (or a CI on their machine with no forge to read it from, so none to set
 * up either), no review before the merge. The gates read it where they read a skip, so no rule supposes a workflow.
 */
function chosenOut(state: State, step: JourneyStep): boolean {
  if (step !== "story_ci" && step !== "story_review" && step !== "ci_setup") return false;
  const record = state.git_workflow as
    | {
        readonly workflow?: { readonly ci?: string; readonly review?: boolean };
        readonly forge?: boolean;
      }
    | undefined;
  const workflow = record?.workflow;
  if (workflow === undefined) return false;
  if (step === "story_review") return workflow.review === false;
  // No CI to read: none chosen, or on the creator's machine with no forge to read it from (none to
  // set up either). Without a pull request, a story's CI cannot be read from the forge: a merge by the
  // engine, or no branch per story, never waits for one.
  const none = workflow.ci === "none" || (workflow.ci === "local" && record?.forge !== true);
  if (step === "ci_setup") return none;
  const merge = resolveGitWorkflow(workflow as GitWorkflow).merge;
  return none || merge === "direct";
}

/** True when that very skip (this step, this story or none) is recorded: what a resume undoes. */
export function isSkippedExactly(state: State, step: JourneyStep, story?: string | null): boolean {
  return has(skipsOf(state), skipKey(step, story));
}

/** The steps skipped, in the order the creator skipped them. */
export function skippedList(state: State): SkipState[] {
  return Object.values(skipsOf(state)).sort((a, b) =>
    a.event < b.event ? -1 : a.event > b.event ? 1 : 0,
  );
}

/** The steps skipped without a story, as a set (what the one-sentence warning compares with). */
export function skippedSteps(state: State): Set<JourneyStep> {
  return new Set(
    skippedList(state)
      .filter((skip) => skip.story === null)
      .map((skip) => skip.step),
  );
}

/** The phases the creator skipped. */
export function skippedPhases(state: State): Set<PhaseId> {
  const phases = new Set<PhaseId>();
  for (const [phase, step] of Object.entries(PHASE_STEPS)) {
    if (isSkipped(state, step)) phases.add(phase as PhaseId);
  }
  // On the short path one spec stands for the framing, the planning and the design.
  if (isSkipped(state, "full_path")) {
    for (const phase of ["framing", "planning", "design"] as const) phases.add(phase);
  }
  return phases;
}

/**
 * The step a document of `.agentplugged/` belongs to, or undefined: the problems `docs check` finds
 * in it become warnings when that step is skipped. A story's file is the story's contract (and the
 * breakdown); the launch and sales documents belong to the launch phase.
 */
export function documentStep(
  path: string,
): { readonly step: JourneyStep; readonly story?: string } | undefined {
  const clean = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const inside = (dir: string) => clean.includes(`.agentplugged/${dir}/`);
  if (inside("stories")) {
    const name = clean.slice(clean.lastIndexOf("/") + 1);
    const story = /^(\d{1,6})-(\d{1,6})(?![0-9])/.exec(name);
    return story === null
      ? { step: "breakdown" }
      : { step: "breakdown", story: `${Number(story[1])}-${Number(story[2])}` };
  }
  if (inside("epics")) return { step: "breakdown" };
  if (clean.endsWith(".agentplugged/docs/launch/positioning.md")) return { step: "positioning" };
  if (clean.includes(".agentplugged/docs/launch/") || clean.includes(".agentplugged/docs/sales/")) {
    return { step: "phase_launch" };
  }
  if (clean.includes(".agentplugged/docs/security-reviews/"))
    return { step: "architecture_security" };
  const name = clean.slice(clean.lastIndexOf("/") + 1).toLowerCase();
  if (clean.includes(".agentplugged/docs/")) {
    if (name === "brief.md" || name === "prfaq.md") return { step: "brief" };
    if (name === "prd.md") return { step: "prd" };
    if (name === "ux.md") return { step: "ux" };
    if (name === "architecture.md") return { step: "architecture" };
    if (name === "index.md" || clean.includes(".agentplugged/docs/knowledge/")) {
      return { step: "knowledge_base" };
    }
  }
  return undefined;
}

/**
 * True when a problem found in the document `path` is only a warning: the creator skipped the
 * check of the documents, or the step the document belongs to (and, for a story's file, its
 * contract, for every story or for that one).
 */
export function documentProblemIsWarning(state: State, path: string): boolean {
  if (isSkipped(state, "docs_check")) return true;
  const owner = documentStep(path);
  if (owner === undefined) return false;
  if (skippedWithItsPhase(state, owner.step)) return true;
  return (
    owner.step === "breakdown" &&
    owner.story !== undefined &&
    isSkipped(state, "story_contract", owner.story)
  );
}

/**
 * True when the step is skipped, or the phase it belongs to is (no planning phase, no PRD to ask
 * for, to validate or to check).
 */
export function skippedWithItsPhase(state: State, step: JourneyStep): boolean {
  if (isSkipped(state, step)) return true;
  const phase = phaseOfStep(step);
  return phase !== undefined && isSkipped(state, PHASE_STEPS[phase]);
}

/** The phase a document step belongs to, or undefined. */
export function phaseOfStep(step: JourneyStep): PhaseId | undefined {
  switch (step) {
    case "brief":
      return "framing";
    case "prd":
    case "ux":
      return "planning";
    case "architecture":
    case "architecture_security":
      return "design";
    case "positioning":
    case "phase_launch":
      return "launch";
    default:
      return undefined;
  }
}
