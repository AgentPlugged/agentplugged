/**
 * The journey is proposed, never imposed. The method offers a complete path (the
 * phases, their documents, the reviews, the CI, the retrospective…), and the creator may skip any
 * step of it with one answer in the chat (« no PRD », « no security review for this story »,
 * « merge without CI »). The engine records what was skipped (`step_skip`, a creator's
 * action, so it is proved like any other answer of the creator), recomputes what follows, and turns
 * the checks of that step into warnings. An agent never skips a step by itself: the creator says it.
 */

/**
 * The steps of the journey that the creator may skip, in the order of the journey. The first group
 * is the product's (no story): the phases, their documents, and the work around them. The second
 * group is a story's (`story` names it; none stands for every story).
 */
export const JOURNEY_STEPS = [
  // The phases: a skipped phase counts as passed, its end needs no approval.
  "phase_framing",
  "phase_planning",
  "phase_design",
  "phase_build",
  "phase_delivery",
  "phase_launch",
  // The full path: skipped, one short spec stands for the brief, the PRD and the architecture
  //; taking it up again goes back to the full path.
  "full_path",
  // The structuring documents, and what rests on the architecture.
  "brief",
  "prd",
  "ux",
  "architecture",
  "architecture_security",
  // The work around them.
  // The readiness gate before the first story.
  "readiness",
  "breakdown",
  "sprint_planning",
  "knowledge_base",
  "positioning",
  "retrospective",
  "ci_setup",
  "docs_check",
  // A story's steps.
  "story_contract",
  "story_order",
  "story_deferred",
  "story_review",
  "story_security",
  "story_ci",
  "story_trace",
  "story_fast_track",
] as const;
export type JourneyStep = (typeof JOURNEY_STEPS)[number];

/** The steps that belong to a story (`story` optional: absent stands for every story). */
export const JOURNEY_STORY_STEPS: ReadonlySet<JourneyStep> = new Set<JourneyStep>([
  "story_contract",
  "story_order",
  "story_deferred",
  "story_review",
  "story_security",
  "story_ci",
  "story_trace",
  "story_fast_track",
]);

/** True for a step of a story. */
export function isStoryStep(step: JourneyStep): boolean {
  return JOURNEY_STORY_STEPS.has(step);
}

/** The phases' steps, by phase. */
export const PHASE_STEPS = {
  framing: "phase_framing",
  planning: "phase_planning",
  design: "phase_design",
  build: "phase_build",
  delivery: "phase_delivery",
  launch: "phase_launch",
} as const satisfies Record<string, JourneyStep>;
