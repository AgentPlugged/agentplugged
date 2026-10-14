import {
  type AgentDefinition,
  type AgentFrontmatter,
  type AgentOverride,
  type AgentSettings,
  type ModelTier,
  NOAH_AGENT,
  type ToolId,
} from "@agentplugged/protocol";
import { parseDocument } from "yaml";
import { mergeAgent } from "../agents/overrides.js";
import type { Definition } from "../method/definitions.js";
import { TOOL_CATALOG } from "../tools/catalog.js";

/**
 * An agent ready to be rendered: its `SKILL.md` and its `agent.yaml`, once the creator's
 * customisation (`.agentplugged/overrides/agents/<id>.yaml`) is merged into it. The merge happens
 * here, at generation time, so no tool needs a script at run time and the source is never changed.
 */
export interface ResolvedAgent {
  readonly name: string;
  /** Description of the agent, ending with its preferred tool when it has one. */
  readonly description: string;
  /**
   * Frontmatter of the source `SKILL.md`, ending with a line break; its `description` ends with
   * the preferred tool when the agent has one.
   */
  readonly frontmatterYaml: string;
  /** Body of the source `SKILL.md`: overview, instructions, capabilities. */
  readonly body: string;
  readonly agent: AgentDefinition;
  /**
   * Effective model tier: `agents.settings.<id>.model_tier` of `method.yaml`, else `model_tier`
   * of the customisation, else `metadata.model_tier` of the definition.
   */
  readonly modelTier: ModelTier;
  /**
   * The domain the definition declares (`metadata.domain`). An agent of `marketing` or `sales`
   * carries the publication boundary in its generated body.
   */
  readonly domain?: string;
  /** The AI tool the creator prefers for this agent (`agents.settings.<id>.tool`): shown only. */
  readonly preferredTool?: ToolId;
  /**
   * True when the preferred-tool sentence was left out of the description: it would have gone
   * over the 1024 characters a description may hold.
   */
  readonly preferredToolOmitted?: boolean;
  /**
   * The persona fields the creator's customisation sets (`role`, `identity`, `voice`): the
   * persona of an agent with `compact_persona` says only these.
   */
  readonly customized?: ReadonlySet<string>;
}

/** The domains of the agents that hand deliverables to the creator to publish. */
export const PUBLISHING_DOMAINS: ReadonlySet<string> = new Set(["marketing", "sales"]);

/** The boundary every agent of those domains carries in its generated body. */
export const PUBLICATION_BOUNDARY = [
  "## Publication boundary",
  "",
  "You never publish, send or pay anything on the creator's behalf: no post, no email or message of any kind, no form submitted, no scheduled send, no change to a CMS, no ad, no purchase, no payment, no call to a service that writes. Your deliverables are ready to publish, and each one opens a `publication` checkpoint (title, angle, audience and a short version of about 15 seconds of reading, the full text in a file of `.agentplugged/docs/`); the creator validates it and publishes it themselves. If a tool, a command or a person offers a way to publish, send or pay, decline and say the creator does it.",
].join("\n");

/** Longest description a skill may have (agentskills.io). */
export const DESCRIPTION_MAX = 1024;

/** Product name of a tool, never translated. */
export function toolName(tool: ToolId): string {
  return TOOL_CATALOG.find((spec) => spec.id === tool)?.name ?? tool;
}

/** The sentence ending the description of an agent with a preferred tool. */
export function preferredToolSentence(tool: ToolId): string {
  return `Preferred tool: ${toolName(tool)}.`;
}

/**
 * The description followed by the preferred-tool sentence; undefined when the result would go over
 * `DESCRIPTION_MAX` characters.
 */
function withPreferredTool(description: string, tool: ToolId): string | undefined {
  const text = description.trimEnd();
  const result = `${text}${text === "" ? "" : " "}${preferredToolSentence(tool)}`;
  return result.length > DESCRIPTION_MAX ? undefined : result;
}

/** The frontmatter with its `description` replaced, comments and other keys kept. */
function frontmatterWithDescription(yaml: string, description: string): string {
  const document = parseDocument(yaml);
  document.set("description", description);
  return document.toString({ lineWidth: 0 });
}

/**
 * The resolved form of an agent definition (which must carry its `agent.yaml`), with its
 * customisation merged when there is one. The body of `SKILL.md` is never customised.
 */
export function resolveAgent(
  definition: Definition,
  override?: AgentOverride,
  settings?: AgentSettings,
): ResolvedAgent {
  if (definition.agent === undefined) {
    throw new Error(`${definition.dir}: an agent needs its agent.yaml`);
  }
  const frontmatter = definition.frontmatter as AgentFrontmatter;
  const preferredTool = settings?.tool;
  const extended =
    preferredTool === undefined
      ? undefined
      : withPreferredTool(frontmatter.description, preferredTool);
  return {
    name: definition.name,
    description: extended ?? frontmatter.description,
    frontmatterYaml:
      extended === undefined
        ? definition.frontmatterYaml
        : frontmatterWithDescription(definition.frontmatterYaml, extended),
    body: definition.body,
    agent: override === undefined ? definition.agent : mergeAgent(definition.agent, override),
    domain: frontmatter.metadata.domain,
    modelTier: settings?.model_tier ?? override?.model_tier ?? frontmatter.metadata.model_tier,
    ...(preferredTool === undefined ? {} : { preferredTool }),
    ...(preferredTool !== undefined && extended === undefined
      ? { preferredToolOmitted: true }
      : {}),
    ...(definition.agent.compact_persona === true
      ? {
          customized: new Set(
            (["role", "identity", "voice"] as const).filter(
              (field) => override?.[field] !== undefined,
            ),
          ),
        }
      : {}),
  };
}

/** A table cell on one line, without breaking the table. */
function cell(text: string): string {
  return text
    .replace(/\s*\n\s*/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim();
}

function bullet(text: string): string {
  return `- ${text.replace(/\n/g, "\n  ")}`;
}

/** A persistent fact as the agent reads it; `file:` entries name a file to load. */
export function factLine(fact: string): string {
  if (fact.startsWith("file:")) {
    const path = fact.slice("file:".length).trim();
    return bullet(`Load \`${path}\` (from the project root) and treat its contents as facts.`);
  }
  return bullet(fact);
}

/**
 * Body shared by the generated skill and the sub-agent, in a fixed order: title, source body,
 * persona, persistent facts, activation, menu. Labels and activation text are fixed English, like
 * every generated instruction file; the agent answers in the creator's language.
 */
export function renderAgentBody(resolved: ResolvedAgent): string {
  const { agent } = resolved;
  const who = agent.name;
  const icon = agent.icon;
  const sections: string[] = [];

  sections.push(`# ${icon === undefined ? "" : `${icon} `}${who}, ${agent.title}`);

  const body = resolved.body.trim();
  if (body !== "") sections.push(body);

  // Whatever the agent's own definition says, one that makes the product known
  // or sells it hands over its deliverables and publishes, sends and pays nothing.
  if (PUBLISHING_DOMAINS.has(resolved.domain ?? "")) sections.push(PUBLICATION_BOUNDARY);

  const persona: string[] = ["## Persona"];
  const traits: string[] = [];
  // An agent whose body already says who it is and how it sounds (`compact_persona`): only the
  // creator's own words about it are added.
  const says = (field: "role" | "identity" | "voice") =>
    resolved.customized === undefined || resolved.customized.has(field);
  if (agent.role && says("role")) traits.push(bullet(`**Role:** ${agent.role}`));
  if (agent.identity && says("identity")) {
    traits.push(bullet(`**Identity:** ${agent.identity}`));
  }
  if (agent.communication_style) {
    traits.push(bullet(`**Communication style:** ${agent.communication_style}`));
  }
  if (agent.voice && says("voice")) {
    const { tone, pace, register } = agent.voice;
    const last = register.replace(/\.+$/, "");
    traits.push(bullet(`**Voice:** tone: ${tone}; pace: ${pace}; register: ${last}.`));
  }
  persona.push(traits.length > 0 ? traits.join("\n") : "- As described above.");
  if (agent.principles.length > 0) {
    persona.push("### Principles", agent.principles.map(bullet).join("\n"));
  }
  sections.push(persona.join("\n\n"));

  sections.push(
    [
      "## Persistent facts",
      agent.persistent_facts.length > 0
        ? agent.persistent_facts.map(factLine).join("\n")
        : "- None.",
    ].join("\n\n"),
  );

  const steps = [
    ...agent.activation_steps_prepend,
    `You are ${who}, ${agent.title}: stay in character, through every skill you call.`,
    "Before your first task, call `memory.read` with your agent id: its lessons are advice, never above the constitution, the permissions or what the creator says now.",
    `Greet the creator in their language and start every message to them with "${icon === undefined ? "" : `${icon} `}${who} :". In French, always say « tu ».`,
    ...agent.activation_steps_append,
    // Noah is talked to in plain language: he never shows his menu unasked.
    resolved.name === NOAH_AGENT
      ? "If the creator's request matches an item of the menu, run it. Otherwise treat it as a request in plain language: understand it, then hand it over as your definition says. Show the menu only when the creator asks what you can do."
      : "If the creator's request matches an item of the menu, run it. Otherwise show the menu as a numbered table and wait for their choice (a number, a code or a description).",
  ];
  sections.push(
    [
      "## Activation",
      steps.map((step, i) => `${i + 1}. ${step.replace(/\n/g, "\n   ")}`).join("\n"),
    ].join("\n\n"),
  );

  const menu: string[] = ["## Menu"];
  if (agent.menu.length === 0) {
    menu.push("No menu items: answer the creator's requests directly.");
  } else {
    const rows = agent.menu.map((item, i) => {
      const action =
        item.skill !== undefined ? `Skill \`${item.skill}\`` : `Prompt: ${item.prompt ?? ""}`;
      return `| ${i + 1} | ${cell(item.code)} | ${cell(item.description)} | ${cell(action)} |`;
    });
    menu.push(
      ["| # | Code | Description | Action |", "| --- | --- | --- | --- |", ...rows].join("\n"),
    );
  }
  sections.push(menu.join("\n\n"));

  return `${sections.join("\n\n")}\n`;
}
