import type { AgentOverride } from "@agentplugged/protocol";
import type { Definition } from "../method/definitions.js";
import { PUBLICATION_BOUNDARY, renderAgentBody, resolveAgent } from "../sync/agent-render.js";
import {
  BODY_CAP,
  DESCRIPTION_CAP,
  hasTrigger,
  MAX_LISTED,
  namesWhen,
  OVERLAP_LIMIT,
  overlap,
  referencesNamed,
  significantWords,
  unsafeProblems,
} from "./workshop-rules.js";

/**
 * Analysis and verification of an agent or a skill that exists: the method's or the
 * creator's. Pure: the command reads the files, these functions judge them. Nothing here writes.
 */

/** Whose it is: the method shipped with the engine, or the creator's own. */
export type Origin = "shipped" | "creator";

/** A body over this share of the ceiling is worth splitting before it grows. */
const HEAVY_SHARE = 0.7;

/** A menu instruction longer than this is a skill in disguise. */
const LONG_PROMPT = 600;

/** The gestures a finding can be settled with, one per proposal. */
export type Gesture =
  /** `guard.creator_action` `agent_edit` with the corrected `content`. */
  | "agent_edit"
  /** The creator's customisation file of a shipped agent (`.agentplugged/overrides/agents/`). */
  | "override"
  /** A copy of a shipped skill or agent, created as the creator's own (`agent_create`). */
  | "copy";

export interface Finding {
  readonly rule: string;
  /** `fix` breaks a rule of the engine; `tip` makes it clearer or lighter. */
  readonly severity: "fix" | "tip";
  readonly field: string;
  readonly detail: string;
  readonly gesture: Gesture;
}

export interface Subject {
  readonly definition: Definition;
  readonly origin: Origin;
  /** The creator's customisation of a shipped agent, when there is one. */
  readonly override?: AgentOverride | undefined;
  /** Every agent and skill of the product. */
  readonly all: readonly Definition[];
  /** The skills an agent's menu may call (active ones). */
  readonly skills: ReadonlySet<string>;
}

/** The size of the body as a session reads it (an agent's includes its persona and menu). */
export function bodySize(definition: Definition): number {
  return definition.kind === "agent"
    ? renderAgentBody(resolveAgent(definition)).length
    : definition.text.length;
}

/** The gesture that settles a finding on a thing of this origin. */
function gestureFor(subject: Subject): Gesture {
  if (subject.origin === "creator") return "agent_edit";
  return subject.definition.kind === "agent" ? "override" : "copy";
}

/** The lines of text of an agent or skill that tell it what to do, with their field. */
function texts(subject: Subject): Array<{ field: string; text: string }> {
  const { definition, override } = subject;
  const out: Array<{ field: string; text: string }> = [];
  // The lines of « never » forbid: a heading « never » starts a section whose lines are skipped.
  let skipping = false;
  for (const line of definition.body.split("\n")) {
    if (/^#{1,6}\s/.test(line)) skipping = /never does/i.test(line);
    if (!skipping && line.trim() !== "") out.push({ field: "SKILL.md", text: line });
  }
  const add = (field: string, list: readonly (string | undefined)[] | undefined) => {
    for (const [index, text] of (list ?? []).entries()) {
      if (text !== undefined) out.push({ field: `${field}.${index}`, text });
    }
  };
  const agent = definition.agent;
  if (agent !== undefined) {
    add("agent.yaml", [agent.role, agent.identity, agent.communication_style]);
    add("agent.yaml principles", agent.principles);
    add("agent.yaml persistent_facts", agent.persistent_facts);
    add("agent.yaml activation_steps_prepend", agent.activation_steps_prepend);
    add("agent.yaml activation_steps_append", agent.activation_steps_append);
    add(
      "agent.yaml menu",
      agent.menu.map((item) => item.prompt),
    );
  }
  if (override !== undefined) {
    add("override principles", override.principles);
    add("override persistent_facts", override.persistent_facts);
    add("override activation_steps_prepend", override.activation_steps_prepend);
    add("override activation_steps_append", override.activation_steps_append);
    add(
      "override menu",
      (override.menu ?? []).map((item) => item.prompt),
    );
    add("override", [override.role, override.identity, override.communication_style]);
  }
  return out;
}

/** The text of a creator's body under the heading that matches `heading`, up to the next one. */
function section(body: string, heading: RegExp): string | undefined {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^##\s/.test(line) && heading.test(line));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** What a creator's agent and skill bodies must say (the shape the engine writes from a definition). */
const SECTIONS: Readonly<Record<"agent" | "skill", ReadonlyArray<readonly [string, RegExp]>>> = {
  agent: [
    ["overview", /overview/i],
    ["produces", /produces/i],
    ["works", /works/i],
    ["never", /never does/i],
  ],
  skill: [
    ["steps", /steps/i],
    ["outputs", /outputs/i],
    ["rules", /rules/i],
  ],
};

/** The sections a creator's body lacks or leaves empty. */
export function missingSections(definition: Definition): string[] {
  return SECTIONS[definition.kind]
    .filter(([, heading]) => {
      const text = section(definition.body, heading);
      return text === undefined || text === "";
    })
    .map(([name]) => name);
}

/** True for a skeleton the terminal's template wrote and nobody filled in. */
export function isSkeleton(definition: Definition): boolean {
  return (
    definition.body.includes("Describe here what") ||
    (definition.agentText ?? "").includes("Example — replace it with")
  );
}

/** The references a body or an instruction names that the folder does not hold. */
function missingReferences(subject: Subject, extra: readonly string[]): string[] {
  const { definition } = subject;
  // An agent may send to the files of a skill its menu calls (`references/x.md` of that skill).
  const called = new Set(
    [...(definition.agent?.menu ?? []), ...(subject.override?.menu ?? [])].flatMap((item) =>
      item.skill === undefined ? [] : [item.skill],
    ),
  );
  const held = new Set(
    [definition, ...subject.all.filter((other) => called.has(other.name))].flatMap((owner) =>
      owner.annexes
        .filter((file) => file.startsWith("references/"))
        .map((file) => file.slice("references/".length).replace(/\.md$/, "")),
    ),
  );
  const named = new Set(referencesNamed([definition.body, ...extra].join("\n")));
  return [...named].filter((name) => !held.has(name));
}

/** The references the folder holds that nothing names. */
function unusedReferences(definition: Definition, extra: readonly string[]): string[] {
  const named = new Set(referencesNamed([definition.body, ...extra].join("\n")));
  return definition.annexes
    .filter((file) => file.startsWith("references/") && file.endsWith(".md"))
    .map((file) => file.slice("references/".length).replace(/\.md$/, ""))
    .filter((name) => !named.has(name));
}

/** Everything in an agent's files a reference may be named from. */
function extraTexts(subject: Subject): string[] {
  const { definition, override } = subject;
  return [
    definition.agentText ?? "",
    ...(override?.menu ?? []).map((item) => item.prompt ?? ""),
    ...(override?.principles ?? []),
  ];
}

/**
 * What can be better in an agent or a skill, a few lines, the most serious first. A `fix` breaks a
 * rule of the engine; a `tip` makes the thing clearer, lighter or easier to trigger. Each finding
 * names the one gesture that settles it.
 */
export function analyze(subject: Subject): Finding[] {
  const { definition } = subject;
  const gesture = gestureFor(subject);
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], rule: string, field: string, detail: string) =>
    findings.push({ rule, severity, field, detail, gesture });
  const description = (definition.frontmatter as { description: string }).description;

  for (const problem of unsafeProblems(texts(subject))) {
    add("fix", problem.rule, problem.field, problem.detail);
  }
  if (subject.origin === "creator" && isSkeleton(definition)) {
    add("fix", "skeleton", "SKILL.md", "still the template: write the definition");
  } else if (subject.origin === "creator") {
    const missing = missingSections(definition);
    if (missing.length > 0) {
      add("fix", "section_missing", "SKILL.md", `no ${missing.join(", ")} section`);
    }
  }
  if (description.length > DESCRIPTION_CAP) {
    add(
      "fix",
      "description_too_long",
      "description",
      `${description.length} characters, at most ${DESCRIPTION_CAP}: it is listed at every request`,
    );
  }
  if (!hasTrigger(description)) {
    add(
      "fix",
      "trigger_missing",
      "description",
      "a label, not a sentence: say what it is for and when it is called",
    );
  } else if (!namesWhen(description)) {
    add(
      "tip",
      "trigger_unclear",
      "description",
      "does not say when it is called: add the situation, the phase or who runs it",
    );
  }
  for (const [index, item] of (definition.agent?.menu ?? []).entries()) {
    if (item.skill !== undefined && !subject.skills.has(item.skill)) {
      add("fix", "skill_unknown", `menu.${index}.skill`, `no active skill named "${item.skill}"`);
    }
  }
  const extra = extraTexts(subject);
  for (const name of missingReferences(subject, extra)) {
    add(
      "fix",
      "reference_unknown",
      "SKILL.md",
      `references/${name}.md is named and does not exist`,
    );
  }
  const size = bodySize(definition);
  if (size > BODY_CAP) {
    // A shipped body over the ceiling is an exception the method documents: a tip, not a fault.
    add(
      subject.origin === "shipped" ? "tip" : "fix",
      "body_too_large",
      "SKILL.md",
      `${size} characters, at most ${BODY_CAP}`,
    );
  } else if (size > BODY_CAP * HEAVY_SHARE && definition.annexes.length === 0) {
    add(
      "tip",
      "body_heavy",
      "SKILL.md",
      `${size} characters read each time it runs: move the detail a step needs to references/`,
    );
  }
  for (const name of unusedReferences(definition, extra)) {
    add(
      "tip",
      "reference_unused",
      `references/${name}.md`,
      "no step sends to it: name it or drop it",
    );
  }
  for (const [index, item] of (definition.agent?.menu ?? []).entries()) {
    if ((item.prompt ?? "").length > LONG_PROMPT) {
      add(
        "tip",
        "menu_prompt_long",
        `menu.${index}.prompt`,
        `${(item.prompt ?? "").length} characters: make it a skill the item calls`,
      );
    }
  }
  if (definition.agent !== undefined && !definition.agent.identity && !definition.agent.role) {
    add("tip", "persona_thin", "agent.yaml", "no role and no identity: say who the agent is");
  }
  const mine = significantWords(`${definition.name} ${description}`);
  for (const other of subject.all) {
    if (other.name === definition.name || other.kind !== definition.kind) continue;
    const theirs = significantWords(
      `${other.name} ${(other.frontmatter as { description: string }).description}`,
    );
    if (overlap(mine, theirs) >= OVERLAP_LIMIT) {
      add(
        "tip",
        "description_overlap",
        "description",
        `reads almost like ${other.name}: sharpen when each one is called`,
      );
      break;
    }
  }
  const rank = (finding: Finding) => (finding.severity === "fix" ? 0 : 1);
  return findings.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_LISTED);
}

// ---------------------------------------------------------------------------------------------
// The small suite of verifications of a creation

export interface Check {
  readonly check: string;
  readonly ok: boolean;
  readonly detail?: string;
}

/**
 * The verifications the engine runs on an agent or a skill (the base the behaviour
 * evaluations extend): it is valid, it says when it is called (and answers the
 * phrases the creator expects), its sections are there, its links exist, it holds no instruction
 * that goes round a rule, it fits the ceilings, and an agent that publishes or sells carries the
 * publication boundary once rendered. `triggers` are phrases a creator would say; `existing` is
 * what the engine found of the files a fact names (`file:`).
 */
export function verify(
  subject: Subject,
  triggers: readonly string[],
  missingFacts: readonly string[],
): Check[] {
  const { definition } = subject;
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push({ check: name, ok, ...(ok || detail === undefined ? {} : { detail }) });
  const description = (definition.frontmatter as { description: string }).description;

  const size = bodySize(definition);
  check(
    "caps",
    description.length <= DESCRIPTION_CAP && (size <= BODY_CAP || subject.origin === "shipped"),
    `description ${description.length}/${DESCRIPTION_CAP}, body ${size}/${BODY_CAP}`,
  );
  check("trigger", hasTrigger(description), "the description is a label, not a sentence");
  if (triggers.length > 0) {
    const menu = (definition.agent?.menu ?? []).map((item) => item.description).join(" ");
    const known = significantWords(`${definition.name} ${description} ${menu}`);
    const unmatched = triggers.filter((phrase) => overlap(significantWords(phrase), known) === 0);
    check(
      "expected_triggers",
      unmatched.length === 0,
      `nothing in the name, the description or the menu answers: ${unmatched.map((p) => `« ${p} »`).join(", ")}`,
    );
  }
  if (subject.origin === "creator") {
    if (isSkeleton(definition)) {
      check("sections", false, "still the template: write the definition");
    } else {
      const missing = missingSections(definition);
      check("sections", missing.length === 0, `missing or empty: ${missing.join(", ")}`);
    }
  } else {
    check("sections", definition.body.trim() !== "", "empty body");
  }
  const extra = extraTexts(subject);
  const brokenLinks = [
    ...missingReferences(subject, extra).map((name) => `references/${name}.md`),
    ...(definition.agent?.menu ?? []).flatMap((item) =>
      item.skill !== undefined && !subject.skills.has(item.skill) ? [`skill ${item.skill}`] : [],
    ),
    ...missingFacts,
  ];
  check("links", brokenLinks.length === 0, `do not exist: ${brokenLinks.join(", ")}`);
  const unsafe = unsafeProblems(texts(subject));
  check("safety", unsafe.length === 0, unsafe.map((p) => p.detail).join("; "));
  if (definition.kind === "agent") {
    const resolved = resolveAgent(definition, subject.override);
    const body = renderAgentBody(resolved);
    const needsBoundary = ["marketing", "sales"].includes(resolved.domain ?? "");
    check(
      "publication_boundary",
      !needsBoundary || body.includes(PUBLICATION_BOUNDARY),
      "an agent of marketing or sales must carry the publication boundary",
    );
  }
  return checks;
}
