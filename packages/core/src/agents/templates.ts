import type { DomainId, PhaseId } from "@agentplugged/protocol";

/** What the creator gives for a new agent. */
export interface NewAgent {
  readonly id: string;
  /** Display name (`Stella`); derived from the id when absent. */
  readonly name?: string;
  readonly title: string;
  readonly description: string;
  readonly domain: DomainId;
  readonly phase: PhaseId;
  readonly icon?: string;
  readonly role?: string;
}

/** What the creator gives for a new skill. */
export interface NewSkill {
  readonly id: string;
  readonly description: string;
}

/** Longest display name `agent.yaml` accepts. */
export const NAME_MAX = 40;

/** Display name from an identifier: `market-scout` gives `Market Scout`. */
export function displayName(id: string): string {
  const words = id.split("-").map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
  return words.join(" ").slice(0, NAME_MAX).trim();
}

/** A YAML scalar on one line: a JSON string is a valid YAML double-quoted scalar. */
function scalar(text: string): string {
  return JSON.stringify(text);
}

/** The three sections of a new body, with what to write in each. */
function body(name: string): string {
  return `## Overview

<!-- Who ${name} is, and when the creator calls ${name}. Two or three sentences. -->

${name} helps the creator. Describe here what ${name} is for.

## What ${name} produces

<!-- The documents, decisions or changes ${name} delivers, and where they are written. -->

- Describe each result ${name} produces.

## How ${name} works

<!-- The rules ${name} follows while working: how it asks, what it never does, how it ends. -->

- Describe how ${name} works with the creator.
`;
}

/**
 * `SKILL.md` of a new agent: portable frontmatter, the agent's own fields in `metadata` (risk and
 * model tier start at `low` and `reasoning`), then the commented body.
 */
export function renderAgentSkillTemplate(agent: NewAgent): string {
  const name = agent.name ?? displayName(agent.id);
  return `---
name: ${agent.id}
description: ${scalar(agent.description)}
metadata:
  domain: ${agent.domain}
  phase: ${agent.phase}
  # Risk of the agent's actions: low, medium or high.
  risk: low
  # Model the agent needs: reasoning, code, fast or multimodal.
  model_tier: reasoning
---
${body(name)}`;
}

/** `agent.yaml` of a new agent: persona, empty lists and one example menu item. */
export function renderAgentYamlTemplate(agent: NewAgent): string {
  const name = agent.name ?? displayName(agent.id);
  const lines = [
    `# ${name}: who the agent is and what it offers. \`name\` (display name) and \`title\` define`,
    "# the agent. Edit this file freely: it is yours, and `init` never touches it. Run",
    "# `npx agentplugged sync` after each change.",
    "",
    `name: ${scalar(name)}`,
    `title: ${scalar(agent.title)}`,
    agent.icon === undefined
      ? '# icon: "🙂"  # Shown at the start of every message.'
      : `icon: ${scalar(agent.icon)}`,
    "",
    agent.role === undefined
      ? "# role: What the agent is for, in one or two sentences."
      : `role: ${scalar(agent.role)}`,
    "# identity: Who the agent is: background, experience, what drives it.",
    "# communication_style: How the agent speaks to the creator.",
    "# voice:  # How the agent sounds in the spoken briefing; give all three, in a few words.",
    "#   tone: Warm and steady",
    "#   pace: Unhurried",
    "#   register: Plain, friendly",
    "",
    "# Rules the agent always follows, one per line.",
    "principles: []",
    "# Facts the agent keeps in mind: a sentence, or `file:<path from the project root>`.",
    "persistent_facts: []",
    "# Extra steps run before and after the agent's own activation.",
    "activation_steps_prepend: []",
    "activation_steps_append: []",
    "",
    "# What the agent offers. Each item has a code, a description, and either `prompt` (what to do)",
    "# or `skill` (a skill of `.agentplugged/skills/` to call).",
    "menu:",
    "  - code: EX",
    `    description: ${scalar(`Example — replace it with what ${name} offers`)}`,
    `    prompt: ${scalar(`Describe what ${name} does when the creator picks this item.`)}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** `SKILL.md` of a new skill: portable frontmatter, then the commented body. */
export function renderSkillTemplate(skill: NewSkill): string {
  const name = displayName(skill.id);
  return `---
name: ${skill.id}
description: ${scalar(skill.description)}
---
${body(name)}`;
}
