import { withCustomisation } from "../agents/skill-overrides.js";
import { TOOL_GROUPS } from "../mcp-tools.js";
import { type Definition, isMarkdown } from "../method/definitions.js";
import type { ResolvedAgent } from "./agent-render.js";
import { renderAgentBody } from "./agent-render.js";
import { MCP_SERVER_NAME } from "./mcp.js";
import type { RenderInput } from "./targets/common.js";

/**
 * The tools every sub-agent keeps: the constitution has each agent read the state and
 * the memory, declare its activity, end with its result, open the points it needs the creator for
 * and report what it read outside.
 */
export const BASE_TOOLS: readonly string[] = [
  "state",
  "agent",
  "story",
  "memory",
  "guard",
  "checkpoint",
  // Rules of AGENTS.md for every agent: defer work (`plan.defer`), ask and answer (`chat`).
  "plan",
  "chat",
];

const TOOL_NAMES = Object.keys(TOOL_GROUPS);
// No closing backtick required: `story.pr {…}` and `story.pr` both cite the tool.
const CITATION = new RegExp(`\`(${TOOL_NAMES.join("|")})\\.[a-z_]+\\b`, "g");

/** The tools a text cites in the notation `tool.action` (between backticks). */
export function toolsCitedIn(text: string): Set<string> {
  const cited = new Set<string>();
  for (const match of text.matchAll(CITATION)) {
    const tool = match[1];
    if (tool !== undefined) cited.add(tool);
  }
  return cited;
}

/** The skills an agent can reach: its menu's, and those they name in backticks, transitively. */
function reachableSkills(
  agent: ResolvedAgent,
  skills: ReadonlyMap<string, Definition>,
  textOf: (definition: Definition) => Promise<string>,
): Promise<Definition[]> {
  const found = new Map<string, Definition>();
  const walk = async (name: string): Promise<void> => {
    const skill = skills.get(name);
    if (skill === undefined || found.has(name)) return;
    found.set(name, skill);
    const text = await textOf(skill);
    for (const [other] of skills) if (text.includes(`\`${other}\``)) await walk(other);
  };
  const start = async () => {
    for (const item of agent.agent.menu) if (item.skill !== undefined) await walk(item.skill);
    for (const [other] of skills) {
      if (renderAgentBody(agent).includes(`\`${other}\``)) await walk(other);
    }
    return [...found.values()];
  };
  return start();
}

/**
 * The tools an agent's sub-agent needs: the base ones, and every tool its definition, its menu's
 * skills and what they reference cite. It is the single list the Claude Code sub-agent file is
 * written from, so a tool a skill cites can never be missing.
 */
export async function toolsNeededBy(input: RenderInput, agent: ResolvedAgent): Promise<string[]> {
  const skills = new Map(
    input.definitions
      .filter((definition) => definition.kind === "skill")
      .map((definition) => [definition.name, definition] as const),
  );
  const cache = new Map<string, string>();
  const textOf = async (definition: Definition): Promise<string> => {
    const known = cache.get(definition.name);
    if (known !== undefined) return known;
    // The product's customisation counts: a tool its steps cite must not be denied.
    const parts = [withCustomisation(definition.text, input.skillSections?.get(definition.name))];
    for (const annex of definition.annexes) {
      if (isMarkdown(annex)) parts.push(await input.source.readText(`${definition.dir}/${annex}`));
    }
    const all = parts.join("\n");
    cache.set(definition.name, all);
    return all;
  };
  const texts = [renderAgentBody(agent)];
  for (const skill of await reachableSkills(agent, skills, textOf)) texts.push(await textOf(skill));
  const needed = new Set<string>(BASE_TOOLS);
  for (const text of texts) for (const tool of toolsCitedIn(text)) needed.add(tool);
  return TOOL_NAMES.filter((tool) => needed.has(tool));
}

/** The name Claude Code gives a tool of the engine's server: `mcp__agentplugged__<tool>`. */
export function claudeToolName(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool}`;
}

/**
 * The tools of the engine a sub-agent does not get, as Claude Code's `disallowedTools` names them.
 * A denylist and not an allowlist: Claude Code's documentation says a `tools` allowlist leaves the
 * sub-agent with only what it lists (no `Read`, no `Bash`, no other MCP server) unless every
 * built-in tool is listed too.
 */
export async function disallowedToolsFor(
  input: RenderInput,
  agent: ResolvedAgent,
): Promise<string[]> {
  const needed = new Set(await toolsNeededBy(input, agent));
  return TOOL_NAMES.filter((tool) => !needed.has(tool)).map(claudeToolName);
}
