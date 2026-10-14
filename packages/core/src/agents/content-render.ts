import type { AgentContent, SkillContent } from "@agentplugged/protocol";
import { isMap, isSeq, parseDocument } from "yaml";
import { normalizeText, splitFrontmatter } from "../init/generated.js";
import { displayName, type NewAgent, type NewSkill } from "./templates.js";

/**
 * The files of an agent or skill written from the complete definition the creator approved (story
 * 3.17): the text of the definition as recorded, in the anatomy of the shipped agents, with no
 * template text, no placeholder and no comment of ours. The same function renders what is written
 * on a creation and what completes a skeleton (`agent_edit`), so that the two follow one format.
 */

/** A YAML scalar on one line: a JSON string is a valid YAML double-quoted scalar. */
function scalar(text: string): string {
  return JSON.stringify(text);
}

const bullets = (items: readonly string[]) => items.map((item) => `- ${item}`).join("\n");
const numbered = (items: readonly string[]) =>
  items.map((item, index) => `${index + 1}. ${item}`).join("\n");

/** The body of an agent's `SKILL.md`: what it is, produces, does, and never does. */
export function renderAgentBody(name: string, content: AgentContent): string {
  return `## Overview

${content.overview}

## What ${name} produces

${bullets(content.produces)}

## How ${name} works

${bullets(content.works)}

## What ${name} never does

${bullets(content.never)}
`;
}

/** Folder of the files of detail of a skill, next to its `SKILL.md`. */
export const REFERENCES_DIR = "references";

/**
 * The body of a skill's `SKILL.md`: its steps, what it produces and the rules it follows, then,
 * when the skill has files of detail, the list of those it may read.
 */
export function renderSkillBody(content: SkillContent): string {
  const references =
    content.references === undefined
      ? ""
      : `
## References

Read a file only when a step needs it.

${bullets(content.references.map((reference) => `\`${REFERENCES_DIR}/${reference.name}.md\``))}
`;
  return `## Steps

${numbered(content.steps)}

## Outputs

${bullets(content.outputs)}

## Rules

${bullets(content.rules)}
${references}`;
}

/** The files of detail of a skill (`references/<name>.md`), as approved: name and text. */
export function renderSkillReferences(
  content: SkillContent,
): Array<{ readonly name: string; readonly text: string }> {
  return (content.references ?? []).map((reference) => ({
    name: reference.name,
    text: `# ${displayName(reference.name)}\n\n${bullets(reference.lines)}\n`,
  }));
}

/** `SKILL.md` of a new agent: portable frontmatter without comment, then the approved body. */
export function renderAgentSkill(agent: NewAgent, content: AgentContent): string {
  const name = agent.name ?? displayName(agent.id);
  return `---
name: ${agent.id}
description: ${scalar(agent.description)}
metadata:
  domain: ${agent.domain}
  phase: ${agent.phase}
  risk: low
  model_tier: reasoning
---
${renderAgentBody(name, content)}`;
}

/** `SKILL.md` of a new skill: portable frontmatter, then the approved body. */
export function renderSkillFromContent(skill: NewSkill, content: SkillContent): string {
  return `---
name: ${skill.id}
description: ${scalar(skill.description)}
---
${renderSkillBody(content)}`;
}

/** The lines of `agent.yaml` the definition fills: identity, principles, facts and menu. */
function contentYaml(content: AgentContent): string[] {
  const lines: string[] = [];
  if (content.identity !== undefined) lines.push(`identity: ${scalar(content.identity)}`);
  if (content.communication_style !== undefined) {
    lines.push(`communication_style: ${scalar(content.communication_style)}`);
  }
  lines.push("principles:", ...content.principles.map((text) => `  - ${scalar(text)}`));
  if (content.persistent_facts !== undefined && content.persistent_facts.length > 0) {
    lines.push("persistent_facts:", ...content.persistent_facts.map((t) => `  - ${scalar(t)}`));
  }
  lines.push("menu:");
  for (const item of content.menu) {
    lines.push(
      `  - code: ${scalar(item.code)}`,
      `    description: ${scalar(item.description)}`,
      item.skill !== undefined
        ? `    skill: ${scalar(item.skill)}`
        : `    prompt: ${scalar(item.prompt ?? "")}`,
    );
  }
  return lines;
}

/** `agent.yaml` of a new agent: its identity and the approved definition, without comment. */
export function renderAgentYaml(agent: NewAgent, content: AgentContent): string {
  const name = agent.name ?? displayName(agent.id);
  const lines = [`name: ${scalar(name)}`, `title: ${scalar(agent.title)}`];
  if (agent.icon !== undefined) lines.push(`icon: ${scalar(agent.icon)}`);
  if (agent.role !== undefined) lines.push(`role: ${scalar(agent.role)}`);
  lines.push(...contentYaml(content));
  return `${lines.join("\n")}\n`;
}

/** The guidance comments the terminal's template puts in the frontmatter of an agent. */
const TEMPLATE_FRONTMATTER_COMMENTS: ReadonlySet<string> = new Set([
  "# Risk of the agent's actions: low, medium or high.",
  "# Model the agent needs: reasoning, code, fast or multimodal.",
]);

/** True for an `agent.yaml` the terminal's template wrote and nobody has filled in. */
function isSkeletonYaml(yaml: string): boolean {
  return yaml.includes("Example — replace it with");
}

/**
 * `SKILL.md` of an agent or skill of the creator's with its body replaced by the approved one: the
 * frontmatter stays as it is. Undefined when the text has no frontmatter.
 */
export function replaceBody(skillText: string, body: string): string | undefined {
  let text = normalizeText(skillText);
  const parts = splitFrontmatter(text);
  if (parts === undefined) return undefined;
  if (parts.body === "" && !text.endsWith("\n")) text = `${text}\n`;
  // The template's two guidance comments in the frontmatter are not the creator's.
  const head = text
    .slice(0, text.length - parts.body.length)
    .split("\n")
    .filter((line) => !TEMPLATE_FRONTMATTER_COMMENTS.has(line.trim()))
    .join("\n");
  return `${head}${body}`;
}

/**
 * `agent.yaml` of a creator's agent with the approved definition set: `principles`, `menu` and,
 * when the definition gives them, `identity`, `communication_style` and `persistent_facts` are
 * replaced; every other key and comment stays. Undefined when the file is not a YAML mapping.
 */
export function setAgentContent(yaml: string, content: AgentContent): string | undefined {
  const document = parseDocument(yaml, { uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents)) return undefined;
  const set = (key: string, value: unknown) => document.set(key, document.createNode(value));
  if (content.identity !== undefined) set("identity", content.identity);
  if (content.communication_style !== undefined) {
    set("communication_style", content.communication_style);
  }
  set("principles", [...content.principles]);
  if (content.persistent_facts !== undefined)
    set("persistent_facts", [...content.persistent_facts]);
  set(
    "menu",
    content.menu.map(({ code, description, prompt, skill }) => ({
      code,
      description,
      ...(skill !== undefined ? { skill } : { prompt }),
    })),
  );
  // Long texts stay on one line, as the rest of the file.
  const seq = document.get("menu", true);
  if (isSeq(seq)) seq.flow = false;
  let output = document.toString({ lineWidth: 0 });
  // A skeleton's comments are all the template's guidance for filling it: once filled, none stays.
  if (isSkeletonYaml(yaml)) {
    output = output
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "");
  }
  if (yaml.includes("\r\n")) output = output.replace(/\r?\n/g, "\r\n");
  return output;
}
