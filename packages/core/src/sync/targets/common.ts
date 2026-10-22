import {
  type ModelChoice,
  type ModelClientId,
  type ModelTable,
  NOAH_AGENT,
  type ToolId,
} from "@agentplugged/protocol";
import { stringify } from "yaml";
import { withCustomisation } from "../../agents/skill-overrides.js";
import { GENERATED_HEADER_SLASH } from "../../chat/prompt-hook.js";
import {
  GENERATED_HEADER,
  GENERATED_HEADER_HASH,
  normalizeText,
  withGeneratedHeader,
} from "../../init/generated.js";
import { type Definition, isMarkdown, SKILL_FILE } from "../../method/definitions.js";
import type { MethodSource } from "../../method/method-source.js";
import { isInherit } from "../../models/model-table.js";
import { type ResolvedAgent, renderAgentBody } from "../agent-render.js";
import type { ExtensionMcpServer, McpServerLaunch } from "../mcp.js";
import { type SkillPhase, skillsOfPhase } from "../phase-skills.js";
import type { CodexRuleSettings } from "../rule-permissions.js";

/** Who a generated file is for: one tool, or several (`shared`). */
export type TargetGroup = ToolId | "shared";

/** A file `sync` wants on disk. */
export interface Target {
  readonly path: string;
  /** Text (normalised, LF) or raw bytes. */
  readonly content: string | Uint8Array;
  readonly group: TargetGroup;
  /**
   * Skill folder the file belongs to (`.claude/skills/<name>`, `.agents/skills/<name>`): the
   * folder is owned as a whole. Undefined for a stand-alone file.
   */
  readonly folder?: string;
}

/** What one tool's renderer receives. */
export interface RenderInput {
  readonly source: MethodSource;
  /** Every agent (active only) and skill to generate. */
  readonly definitions: readonly Definition[];
  /** Resolved form of each agent, by name. */
  readonly agents: ReadonlyMap<string, ResolvedAgent>;
  /** Path of the constitution: `AGENTS.md` or `.agentplugged/AGENTS.md`. */
  readonly constitution: string;
  /** The model table, with the creator's values of `method.yaml` applied. */
  readonly models: ModelTable;
  /** How the AI tools start the `agentplugged` MCP server (`mcpLaunch`). */
  readonly mcpLaunch: McpServerLaunch;
  /** Extra MCP servers a program built on the engine asks to declare beside `agentplugged`. */
  readonly extensionServers?: readonly ExtensionMcpServer[];
  /**
   * The command that runs the engine from a shell on this machine (`engineCommand`), written in
   * place of `npx agentplugged` in everything generated for the agents.
   */
  readonly engineCommand: string;
  /** Codex's settings for the permission rules in force; Codex's defaults if absent. */
  readonly codexRules?: CodexRuleSettings;
  /**
   * The product's customisation of each shipped skill that has one, as the section
   * `sync` appends to its `SKILL.md`, by skill name. A skill without one is rendered as it is.
   */
  readonly skillSections?: ReadonlyMap<string, string>;
  /** The current phase: only its skills get a folder. Absent, every skill does. */
  readonly skillPhase?: SkillPhase;
}

/** The model of an agent's tier for one client. */
export function modelOf(
  input: RenderInput,
  client: ModelClientId,
  agent: ResolvedAgent,
): ModelChoice {
  return input.models[client][agent.modelTier];
}

/**
 * Frontmatter fields of a Markdown sub-agent: `model` (`inherit` kept as is) and, where the
 * tool has one (`effortKey`), the reasoning effort, left out with `inherit`.
 */
export function modelFields(choice: ModelChoice, effortKey?: string): Record<string, string> {
  const fields: Record<string, string> = { model: choice.model };
  if (effortKey !== undefined && choice.effort !== undefined && !isInherit(choice)) {
    fields[effortKey] = choice.effort;
  }
  return fields;
}

/** Folders whose skill sub-folders (`<root>/<name>/`) are owned as a whole. */
export const SKILL_ROOTS = [".claude/skills", ".agents/skills"] as const;

/**
 * Folders and files `sync` may generate, delete and protect. A manifest entry outside them is
 * never deleted.
 */
export const GENERATED_ROOTS = [
  ".claude",
  ".agents",
  ".codex",
  ".gemini",
  ".cursor",
  ".kimi-code",
] as const;
export const GENERATED_ROOT_FILES = ["CLAUDE.md", "GEMINI.md"] as const;

export function isGeneratedPath(path: string): boolean {
  return (
    GENERATED_ROOTS.some((root) => path.startsWith(`${root}/`)) ||
    (GENERATED_ROOT_FILES as readonly string[]).includes(path)
  );
}

/** The skill folder holding `path`, if any. */
export function skillFolderOf(path: string): string | undefined {
  for (const root of SKILL_ROOTS) {
    const prefix = `${root}/`;
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length).split("/")[0];
    return name ? `${prefix}${name}` : undefined;
  }
  return undefined;
}

/**
 * Header a generated text file starts with, by its path; undefined for files copied byte for
 * byte (annexes other than Markdown).
 */
export function headerOf(path: string): string | undefined {
  const lower = path.toLowerCase();
  // In a skill folder, only Markdown is rendered with the header; anything else (even `.mdc`) is
  // copied byte for byte and owned by its manifest hash alone.
  if (skillFolderOf(path) !== undefined) return isMarkdown(path) ? GENERATED_HEADER : undefined;
  if (lower.endsWith(".md") || lower.endsWith(".mdc")) return GENERATED_HEADER;
  if (lower.endsWith(".toml") || lower.endsWith(".rules")) return GENERATED_HEADER_HASH;
  if (lower.endsWith(".mjs")) return GENERATED_HEADER_SLASH;
  return undefined;
}

/** Generated `SKILL.md` of an agent: source frontmatter, header, then the assembled body. */
export function renderAgentSkill(resolved: ResolvedAgent): string {
  return `---\n${resolved.frontmatterYaml}---\n${GENERATED_HEADER}\n${renderAgentBody(resolved)}`;
}

/** A Markdown sub-agent: the given frontmatter, the header, then the agent's body. */
export function renderMarkdownAgent(
  resolved: ResolvedAgent,
  frontmatter: Readonly<Record<string, string | readonly string[]>>,
): string {
  const yaml = stringify({ ...frontmatter }, { lineWidth: 0 });
  return `---\n${yaml}---\n${GENERATED_HEADER}\n${renderAgentBody(resolved)}`;
}

/**
 * The sub-agents of a tool that reads `<dir>/<name>.md` with `name`, `description`, `model`: one
 * file per agent, its model chosen for `client`.
 */
export function renderAgentFiles(
  input: RenderInput,
  client: ModelClientId,
  dir: string,
  group: TargetGroup,
): Target[] {
  return agentsOf(input).map((agent) => ({
    path: `${dir}/${agent.name}.md`,
    content: renderMarkdownAgent(agent, {
      name: agent.name,
      description: agent.description,
      ...modelFields(modelOf(input, client, agent)),
    }),
    group,
  }));
}

/**
 * The skill folder `<root>/<name>/` of one agent or skill, with its annexes. An agent's
 * `agent.yaml` is rendered into `SKILL.md`, never copied. Markdown files carry the header; other
 * annexes (scripts, images) are copied byte for byte.
 */
export async function renderSkillFolder(
  input: RenderInput,
  definition: Definition,
  root: string,
  group: TargetGroup,
): Promise<Target[]> {
  const folder = `${root}/${definition.name}`;
  const resolved = input.agents.get(definition.name);
  const skill =
    definition.kind === "agent" && resolved !== undefined
      ? renderAgentSkill(resolved)
      : withGeneratedHeader(
          withCustomisation(definition.text, input.skillSections?.get(definition.name)),
        );
  const targets: Target[] = [{ path: `${folder}/${SKILL_FILE}`, content: skill, folder, group }];
  for (const annex of definition.annexes) {
    const from = `${definition.dir}/${annex}`;
    const content = isMarkdown(annex)
      ? withGeneratedHeader(normalizeText(await input.source.readText(from)))
      : await input.source.readBytes(from);
    targets.push({ path: `${folder}/${annex}`, content, folder, group });
  }
  return targets;
}

/** Skill folders of every agent, and of the skills of the current phase, under `root`. */
export async function renderSkillFolders(
  input: RenderInput,
  root: string,
  group: TargetGroup,
): Promise<Target[]> {
  const targets: Target[] = [];
  for (const definition of skillsOfPhase(input.definitions, input.skillPhase)) {
    targets.push(...(await renderSkillFolder(input, definition, root, group)));
  }
  return targets;
}

/**
 * The resolved agents each tool gets as a sub-agent, in definition order. Noah, the main
 * session's assistant, is never one: he lives in the main session, from
 * where he launches the sub-agents; his skill folder is generated like any other.
 */
export function agentsOf(input: RenderInput): ResolvedAgent[] {
  return input.definitions
    .filter((definition) => definition.kind === "agent" && definition.name !== NOAH_AGENT)
    .map((definition) => input.agents.get(definition.name))
    .filter((agent): agent is ResolvedAgent => agent !== undefined);
}
