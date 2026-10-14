import type { CheckpointRisk, JourneyStep } from "@agentplugged/protocol";

/**
 * What the engine knows of each step of the proposed journey, in English (the
 * journal's language; the agents tell the creator in theirs): how risky it is to skip, what the
 * skip leaves out, which steps rest on it, the risk in one sentence and the lightest option. The
 * engine never refuses a skip: it says this once, in the question the creator answers.
 */
export interface StepInfo {
  /** What the creator names: « the PRD », « the review ». */
  readonly label: string;
  /** The risk of the creator's request (a high one goes to the terminal at the `strict` level). */
  readonly risk: CheckpointRisk;
  /** What the engine stops doing, as a clause after « the engine no longer… ». */
  readonly effect: string;
  /** The steps that rest on it: they go on without it. */
  readonly dependents: readonly JourneyStep[];
  /** The risk, in one sentence. */
  readonly danger: string;
  /** The lightest option, offered once. */
  readonly lighter: string;
}

export const JOURNEY_CATALOG: Readonly<Record<JourneyStep, StepInfo>> = {
  phase_framing: {
    label: "the framing phase",
    risk: "low",
    effect: "asks for a brief and for the approval of the end of the framing phase",
    dependents: ["brief", "phase_planning"],
    danger: "the next phases start without a framed idea, so they rest on what you tell the agents",
    lighter: "a one-paragraph brief instead of skipping the phase",
  },
  phase_planning: {
    label: "the planning phase",
    risk: "low",
    effect:
      "asks for a PRD and a UX specification, and for the approval of the end of the planning phase",
    dependents: ["prd", "ux", "phase_design", "breakdown"],
    danger: "the architecture and the stories are written without stated requirements",
    lighter: "a short PRD of the essential requirements",
  },
  phase_design: {
    label: "the design phase",
    risk: "low",
    effect:
      "asks for an architecture, for its security review and for the approval of the end of the design phase",
    dependents: ["architecture", "architecture_security", "breakdown"],
    danger: "the stories are built without shared technical decisions, so the code may diverge",
    lighter: "a minimal architecture: the stack and the few decisions that bind every story",
  },
  phase_build: {
    label: "the build phase",
    risk: "low",
    effect:
      "proposes the stories to the developers, and asks for the approval of the end of the build phase",
    dependents: ["breakdown", "sprint_planning"],
    danger: "nothing is built story by story: no branch, no review, no merge point is proposed",
    lighter: "one small story instead of the whole phase",
  },
  phase_delivery: {
    label: "the delivery phase",
    risk: "low",
    effect: "prepares a release, and asks for the approval of the end of the delivery phase",
    dependents: [],
    danger: "nothing prepares or validates a release: you ship it yourself",
    lighter: "a release checklist instead of the whole phase",
  },
  phase_launch: {
    label: "the launch phase",
    risk: "low",
    effect: "prepares the launch material, and asks for the approval of its publications",
    dependents: ["positioning"],
    danger: "nothing prepares the launch material: you write and publish it yourself",
    lighter: "the positioning alone, a page of who it is for and why",
  },
  full_path: {
    label: "the full path",
    risk: "low",
    effect:
      "asks for a brief, a PRD, a UX specification and an architecture, each validated, and for the end of the framing, planning and design phases",
    dependents: ["brief", "prd", "ux", "architecture"],
    danger:
      "one short spec stands for them, with the same identifiers (a product that grows is carried over without retyping), but the design is not given its own security review: the requirements, the story reviews and the security reviews of each story remain",
    lighter: "the short path, one spec, and the full path again in one word when the product grows",
  },
  brief: {
    label: "the brief",
    risk: "low",
    effect: "asks for a brief and for its validation",
    dependents: ["prd", "ux", "architecture", "breakdown"],
    danger: "the agents that follow lack the one-page statement of the idea",
    lighter: "a one-paragraph brief",
  },
  prd: {
    label: "the PRD",
    risk: "low",
    effect: "asks for a PRD and for its validation",
    dependents: ["architecture", "breakdown"],
    danger: "the stories have no requirements to cover, and nothing traces them back",
    lighter: "a short list of the requirements that matter",
  },
  ux: {
    label: "the UX specification",
    risk: "low",
    effect: "asks for a UX specification and for its validation",
    dependents: ["breakdown"],
    danger: "the screens and flows are decided by the developers story by story",
    lighter: "one page of the main screens and flows",
  },
  architecture: {
    label: "the architecture",
    risk: "low",
    effect: "asks for an architecture and for its validation",
    dependents: ["architecture_security", "breakdown", "story_review"],
    danger:
      "stories are built without shared technical decisions, and the reviewers have no reference to hold them to",
    lighter: "a minimal architecture: the stack and the few decisions that bind every story",
  },
  architecture_security: {
    label: "the security review of the architecture",
    risk: "high",
    effect: "waits for the security review of the architecture before the end of the design phase",
    dependents: [],
    danger: "a flaw of design can reach the code before anyone looked for it",
    lighter: "a review limited to the data, the identities and the outside calls",
  },
  readiness: {
    label: "the readiness gate",
    risk: "low",
    effect:
      "proposes a check that the documents agree and leave nothing to invent, before the stories are cut and before the first one starts",
    dependents: [],
    danger:
      "a contradiction between two documents, or a requirement no story carries, is found while building, which costs more",
    lighter: "the computed checks alone, without the agent's reading",
  },
  breakdown: {
    label: "the breakdown into stories",
    risk: "low",
    effect: "asks for epics and stories, and for their validation",
    dependents: ["sprint_planning", "story_contract", "story_order"],
    danger: "no story means no branch per story, no review and no merge point proposed",
    lighter: "a single epic with a few stories",
  },
  sprint_planning: {
    label: "the sprint planning",
    risk: "low",
    effect: "proposes a sprint, and waits for its validation before a story starts",
    dependents: ["story_order"],
    danger: "no ceiling of budget nor capacity is agreed before the stories start",
    lighter: "a sprint of the next two or three stories",
  },
  knowledge_base: {
    label: "the knowledge base",
    risk: "low",
    effect: "proposes the knowledge base of the product, and keeping its pages up to date",
    dependents: ["positioning"],
    danger:
      "the agents learn the product from the code alone, and the launch material lacks a source",
    lighter: "the map of the base alone",
  },
  positioning: {
    label: "the positioning",
    risk: "low",
    effect: "proposes the positioning before the launch pages",
    dependents: [],
    danger: "the launch pages have no common message to stand on",
    lighter: "three sentences: who it is for, what it does, why it differs",
  },
  retrospective: {
    label: "the retrospective",
    risk: "low",
    effect: "proposes the retrospective of a finished epic or sprint",
    dependents: [],
    danger: "the lessons of the epic are not recorded, so the same mistakes can come back",
    lighter: "a three-line retrospective: what worked, what did not, what to change",
  },
  ci_setup: {
    label: "the setting up of the CI",
    risk: "low",
    effect:
      "proposes writing the base workflows of the CI before the first story, and waiting for a CI on each story",
    dependents: ["story_ci"],
    danger: "nothing runs the tests on each change unless you run them yourself",
    lighter: "one workflow that runs the tests",
  },
  docs_check: {
    label: "the check of the documents",
    risk: "low",
    effect: "fails `docs check` when a document breaks a rule of the method",
    dependents: [],
    danger: "a malformed document (a broken link, a duplicated identifier) is only warned about",
    lighter: "keep the check and skip only the documents you do not want checked",
  },
  story_contract: {
    label: "the story's contract",
    risk: "medium",
    effect:
      "requires a story to be valid and validated at its current content before it starts, and its intent to stay the one you approved",
    dependents: ["story_review"],
    danger: "a story can start without being validated, or drift from the intent you approved",
    lighter: "validate the story file as it is, in one answer",
  },
  story_order: {
    label: "the order of the stories",
    risk: "medium",
    effect:
      "requires the dependencies of a story to be done before it starts, and its merge to follow the order of the graph",
    dependents: [],
    danger: "a story can be built or merged before the code it leans on exists",
    lighter: "keep the order and drop the one dependency that blocks",
  },
  story_deferred: {
    label: "the open deferred work",
    risk: "medium",
    effect: "locks a story's start and merge while an item of deferred work is open on it",
    dependents: [],
    danger: "work an agent set aside for this story can reach the main branch undone",
    lighter: "mark the item as treated, or drop it, instead of skipping the lock",
  },
  story_review: {
    label: "the independent review",
    risk: "medium",
    effect:
      "has a reviewer other than the developer review a story before its merge point, and its findings sorted",
    dependents: ["story_security"],
    danger: "the developer's work reaches the main branch with nobody having looked at it",
    lighter: "a quality review alone, without the security review",
  },
  story_security: {
    label: "the security review of a story",
    risk: "high",
    effect: "has the security reviewer review a story that concerns security",
    dependents: [],
    danger: "a flaw about identities, secrets or permissions can be merged unseen",
    lighter: "keep the quality review, which can still point at a security risk",
  },
  story_ci: {
    label: "the CI of a story",
    risk: "high",
    effect: "waits for a green CI on the story's branch before its review and its merge",
    dependents: ["story_review"],
    danger: "the tests of the story are not run before it reaches the main branch",
    lighter: "run the tests yourself and tell the agents the result",
  },
  story_trace: {
    label: "the traceability of a story",
    risk: "medium",
    effect: "holds a story's merge while a deviation from its requirements is open",
    dependents: [],
    danger: "work that drifts from the requirements it cites can be merged",
    lighter: "lift the deviation you accept, one by one",
  },
  story_fast_track: {
    label: "the check of the fast track",
    risk: "medium",
    effect: "holds a story's merge until the engine verified its change is small",
    dependents: [],
    danger: "a change that outgrew the fast track merges without the full lane's review",
    lighter: "send the story back to the full lane",
  },
};

/**
 * The warning the creator hears once, in one sentence, when a step is skipped: the steps that rest
 * on it and are still in the path (not skipped already), the risk, the lightest option. It is said
 * in the question the creator answers, never repeated afterwards.
 */
export function skipWarning(
  step: JourneyStep,
  alreadySkipped: ReadonlySet<JourneyStep>,
): { readonly dependents: readonly JourneyStep[]; readonly sentence: string } {
  const info = JOURNEY_CATALOG[step];
  const dependents = info.dependents.filter((other) => !alreadySkipped.has(other));
  const names = dependents.map((other) => JOURNEY_CATALOG[other].label);
  const rests =
    names.length === 0
      ? `Without ${info.label}: ${info.danger}.`
      : `Without ${info.label}, ${names.join(" and ")} go without it: ${info.danger}.`;
  return { dependents, sentence: `${rests.replace(/.$/, "")}; lightest option: ${info.lighter}.` };
}
