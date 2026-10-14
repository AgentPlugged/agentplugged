import type { AgentContent, SkillContent } from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { METHOD_DIR } from "../init/layout.js";
import {
  AGENT_FILE,
  type Definition,
  type DefinitionKind,
  parseDefinition,
  SKILL_FILE,
} from "../method/definitions.js";
import {
  REFERENCES_DIR,
  renderAgentSkill,
  renderAgentYaml,
  renderSkillFromContent,
  renderSkillReferences,
} from "./content-render.js";
import type { NewAgent } from "./templates.js";
import { bodySize } from "./workshop-analysis.js";
import { type Cost, costOf, type Draft } from "./workshop-rules.js";

/**
 * The files of an agent or a skill written from the definition the creator approved (
 * 17.15), and the definition they parse into. One function builds them for the three users: the
 * creation (which writes them), the request (which shows their cost before the creator answers)
 * and the workshop's check (which lists what is wrong), so that what is shown, checked and written
 * is the same thing.
 */

/** Folder of a definition under `.agentplugged/`. */
export function definitionDir(kind: DefinitionKind, id: string): string {
  return `${METHOD_DIR}/${kind === "agent" ? "agents" : "skills"}/${id}`;
}

export interface Built {
  /** Files to write, with their path relative to the definition's folder. */
  readonly files: ReadonlyArray<readonly [string, string]>;
  /** The files parsed back; an error when the engine would refuse to read what it wrote. */
  readonly definition: Definition | AgentPluggedError;
}

/** The files of a draft in the folder `dir`, and the definition they make. */
export function buildFromContent(dir: string, draft: Draft): Built {
  const files: Array<readonly [string, string]> = [];
  if (draft.kind === "skill") {
    const content = draft.content as SkillContent;
    const skill = { id: draft.id, description: draft.description ?? "" };
    files.push([SKILL_FILE, renderSkillFromContent(skill, content)]);
    const references = renderSkillReferences(content);
    for (const { name, text } of references) {
      files.push([`${REFERENCES_DIR}/${name}.md`, text]);
    }
    return {
      files,
      definition: parseDefinition(
        "skill",
        dir,
        draft.id,
        files[0]?.[1] ?? "",
        references.map(({ name }) => `${REFERENCES_DIR}/${name}.md`),
      ),
    };
  }
  const agent: NewAgent = {
    id: draft.id,
    title: draft.title ?? "",
    description: draft.description ?? "",
    domain: (draft.domain ?? "") as NewAgent["domain"],
    phase: (draft.phase ?? "") as NewAgent["phase"],
    ...(draft.name !== undefined ? { name: draft.name } : {}),
    ...(draft.icon !== undefined ? { icon: draft.icon } : {}),
    ...(draft.role !== undefined ? { role: draft.role } : {}),
  };
  const content = draft.content as AgentContent;
  const skillText = renderAgentSkill(agent, content);
  const yamlText = renderAgentYaml(agent, content);
  files.push([SKILL_FILE, skillText], [AGENT_FILE, yamlText]);
  return {
    files,
    definition: parseDefinition("agent", dir, draft.id, skillText, [], yamlText),
  };
}

/** What a draft costs once rendered; undefined when its files do not parse. */
export function costOfDraft(draft: Draft): Cost | undefined {
  const { definition } = buildFromContent(definitionDir(draft.kind, draft.id), draft);
  if (definition instanceof AgentPluggedError) return undefined;
  return costOf(draft.id, draft.description, bodySize(definition));
}
