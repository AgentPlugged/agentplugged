import {
  type AgentDefinition,
  AgentDefinitionSchema,
  type AgentFrontmatter,
  AgentFrontmatterSchema,
  ErrorCode,
  type SkillFrontmatter,
  SkillFrontmatterSchema,
} from "@agentplugged/protocol";
import { parseDocument } from "yaml";
import { AgentPluggedError, reasonDetails } from "../errors.js";
import { normalizeText, splitFrontmatter } from "../init/generated.js";
import { ROOT_FIELD } from "../init/method-config.js";
import type { MethodSource } from "./method-source.js";

export type DefinitionKind = "agent" | "skill";

/** File name of a definition, in its folder. */
export const SKILL_FILE = "SKILL.md";

/** Persona, activation and menu of an agent, next to its `SKILL.md`. */
export const AGENT_FILE = "agent.yaml";

/** Folders copied along with `SKILL.md`. */
export const ANNEX_DIRS = ["references", "scripts", "assets"] as const;

/** An agent or skill read from its folder and validated. */
export interface Definition {
  readonly kind: DefinitionKind;
  readonly name: string;
  /** Folder of the definition, e.g. `.agentplugged/agents/iris`. */
  readonly dir: string;
  /** Normalised text of `SKILL.md` (LF line endings, no byte-order mark). */
  readonly text: string;
  /** YAML of the frontmatter, ending with a line break. */
  readonly frontmatterYaml: string;
  readonly body: string;
  readonly frontmatter: AgentFrontmatter | SkillFrontmatter;
  /** `agent.yaml`, validated: present for every agent, absent for a skill. */
  readonly agent?: AgentDefinition;
  /** Normalised text of `agent.yaml`, as read. */
  readonly agentText?: string;
  /** Files of `references/`, `scripts/` and `assets/`, relative to `dir`, sorted. */
  readonly annexes: readonly string[];
}

export function definitionInvalid(
  path: string,
  field: string,
  reason: string,
  messageKey = "error.agent_definition_invalid",
  params: Record<string, unknown> = {},
): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.AGENT_DEFINITION_INVALID, messageKey, {
    path,
    field,
    ...reasonDetails(reason),
    ...params,
  });
}

interface Issue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly keys?: readonly string[];
}

export interface SafeParser<T> {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: readonly Issue[] } };
}

/**
 * Parses YAML and validates it. The error names the file and the field (for example
 * `menu.0.prompt`), or `(root)` for a syntax error. `empty` stands for a document without any
 * value (only comments), when that is allowed.
 */
export function parseYaml<T>(
  path: string,
  yaml: string,
  schema: SafeParser<T>,
  invalid: (path: string, field: string, reason: string) => AgentPluggedError = definitionInvalid,
  empty?: unknown,
): T | AgentPluggedError {
  const document = parseDocument(yaml, { uniqueKeys: true });
  const syntaxError = document.errors[0];
  if (syntaxError) {
    const reason = syntaxError.message.split("\n")[0] ?? syntaxError.code;
    return invalid(path, ROOT_FIELD, reason);
  }
  const value = document.toJS();
  const result = schema.safeParse(value == null && empty !== undefined ? empty : value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const fieldPath: PropertyKey[] = [...(issue?.path ?? [])];
  const unknownKey = issue?.code === "unrecognized_keys" ? issue.keys?.[0] : undefined;
  if (unknownKey !== undefined) fieldPath.push(unknownKey);
  const field = fieldPath.length > 0 ? fieldPath.map(String).join(".") : ROOT_FIELD;
  return invalid(path, field, issue?.message ?? "invalid");
}

/**
 * Parses and validates a definition found in the folder `name`: its `SKILL.md` and, for an
 * agent, its `agent.yaml` (required). The `name` of `SKILL.md` must equal
 * the folder name; the `name` of `agent.yaml` is the display name.
 */
export function parseDefinition(
  kind: DefinitionKind,
  dir: string,
  name: string,
  raw: string,
  annexes: readonly string[],
  agentRaw?: string,
): Definition | AgentPluggedError {
  const path = `${dir}/${SKILL_FILE}`;
  const text = normalizeText(raw);
  const parts = splitFrontmatter(text);
  if (parts === undefined) return definitionInvalid(path, ROOT_FIELD, "frontmatter is missing");
  const schema: SafeParser<AgentFrontmatter | SkillFrontmatter> =
    kind === "agent" ? AgentFrontmatterSchema : SkillFrontmatterSchema;
  const frontmatter = parseYaml(path, parts.yaml, schema);
  if (frontmatter instanceof AgentPluggedError) return frontmatter;
  if (frontmatter.name !== name) {
    return definitionInvalid(path, "name", `must equal the folder name "${name}"`);
  }
  const definition: Definition = {
    kind,
    name,
    dir,
    text,
    frontmatterYaml: parts.yaml,
    body: parts.body,
    frontmatter,
    annexes,
  };
  if (kind !== "agent") return definition;

  const agentPath = `${dir}/${AGENT_FILE}`;
  if (agentRaw === undefined) {
    return definitionInvalid(agentPath, ROOT_FIELD, "agent.yaml is missing");
  }
  const agentText = normalizeText(agentRaw);
  const agent = parseYaml(agentPath, agentText, AgentDefinitionSchema);
  if (agent instanceof AgentPluggedError) return agent;
  return { ...definition, agent, agentText };
}

/**
 * Reads every definition under `base` (one folder per agent or skill), sorted by name. Files
 * directly in `base` (such as `.gitkeep`) are ignored. The first invalid definition is reported.
 */
export async function readDefinitions(
  source: MethodSource,
  base: string,
  kind: DefinitionKind,
): Promise<Definition[] | AgentPluggedError> {
  const byFolder = new Map<string, string[]>();
  for (const path of await source.listFiles(base)) {
    const rest = path.slice(base.length + 1);
    const slash = rest.indexOf("/");
    if (slash === -1) continue;
    const folder = rest.slice(0, slash);
    const inner = rest.slice(slash + 1);
    const list = byFolder.get(folder) ?? [];
    list.push(inner);
    byFolder.set(folder, list);
  }
  const definitions: Definition[] = [];
  for (const folder of [...byFolder.keys()].sort()) {
    const dir = `${base}/${folder}`;
    const inner = byFolder.get(folder) ?? [];
    if (!inner.includes(SKILL_FILE)) {
      return definitionInvalid(`${dir}/${SKILL_FILE}`, ROOT_FIELD, "SKILL.md is missing");
    }
    const annexes = inner
      .filter((file) => ANNEX_DIRS.some((annex) => file.startsWith(`${annex}/`)))
      .sort();
    const agentRaw =
      kind === "agent" && inner.includes(AGENT_FILE)
        ? await source.readText(`${dir}/${AGENT_FILE}`)
        : undefined;
    const parsed = parseDefinition(
      kind,
      dir,
      folder,
      await source.readText(`${dir}/${SKILL_FILE}`),
      annexes,
      agentRaw,
    );
    if (parsed instanceof AgentPluggedError) return parsed;
    definitions.push(parsed);
  }
  return definitions;
}

/**
 * Every menu item calling a skill names one of the loaded skills: a dead menu row is refused
 * (`menu.N.skill` of the agent's `agent.yaml`).
 */
export function checkMenuSkills(definitions: readonly Definition[]): AgentPluggedError | undefined {
  const skills = new Set(definitions.filter((d) => d.kind === "skill").map((d) => d.name));
  for (const definition of definitions) {
    const menu = definition.agent?.menu ?? [];
    for (const [index, item] of menu.entries()) {
      if (item.skill !== undefined && !skills.has(item.skill)) {
        return definitionInvalid(
          `${definition.dir}/${AGENT_FILE}`,
          `menu.${index}.skill`,
          `unknown skill "${item.skill}"`,
          "error.agent_definition_invalid",
          { reason_key: "reason.unknown_skill", skill: item.skill },
        );
      }
    }
  }
  return undefined;
}

/** Names of the sub-folders of `base` that hold at least one file. */
export async function definitionFolders(source: MethodSource, base: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (const path of await source.listFiles(base)) {
    const rest = path.slice(base.length + 1);
    const slash = rest.indexOf("/");
    if (slash > 0) names.add(rest.slice(0, slash));
  }
  return names;
}

/** Annex files whose text is normalised and marked with the header: Markdown files. */
export function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}
