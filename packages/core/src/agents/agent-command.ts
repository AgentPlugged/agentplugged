import {
  type AgentContent,
  AgentDefinitionSchema,
  type AgentFrontmatter,
  type AgentSettings,
  ErrorCode,
  isSkillOverrideContent,
  type MethodConfig,
  type ModelTier,
  type SkillContent,
  SkillOverrideSchema,
  type ToolId,
} from "@agentplugged/protocol";
import { isMap, parseDocument } from "yaml";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { normalizeText } from "../init/generated.js";
import { METHOD_CONFIG_PATH, METHOD_DIR } from "../init/layout.js";
import { editedMethodText, loadMethodConfig, parseMethodConfig } from "../init/method-config.js";
import {
  AGENT_FILE,
  type Definition,
  type DefinitionKind,
  definitionFolders,
  parseDefinition,
  parseYaml,
  SKILL_FILE,
} from "../method/definitions.js";
import { DEFINITION_DIRS } from "../method/install-method.js";
import type { MethodSource } from "../method/method-source.js";
import { AGENT_DOMAINS, DEVELOPER_SPECIALTIES, specialtyOf } from "../profile/catalog.js";
import { writeProfile } from "../profile/profile.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import { activeDefinitions, loadDefinitions } from "../sync/sync-command.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import {
  changedSettings,
  SETTINGS_KEYS,
  type SettingsChange,
  settingsChange,
  writeAgentSettings,
} from "./agent-settings.js";
import {
  REFERENCES_DIR,
  renderAgentBody,
  renderSkillBody,
  renderSkillReferences,
  replaceBody,
  setAgentContent,
} from "./content-render.js";
import {
  type CreateField,
  givenAnswers,
  invalidArgument,
  kindOf,
  parseContent,
  REQUIRED_FIELDS,
  validateGivenAnswers,
  validateNewId,
} from "./create-fields.js";
import {
  loadOverrides,
  mergeAgent,
  overridePath,
  parseOverride,
  renderOverrideTemplate,
} from "./overrides.js";
import {
  checkSkillOverrideRequest,
  ensurePersonalIgnore,
  loadSkillLayers,
  type OverrideCost,
  overrideCostWithFiles,
  renderSkillOverrideTemplate,
  type SkillLayer,
  skillOverridePath,
} from "./skill-overrides.js";
import {
  displayName,
  type NewAgent,
  renderAgentSkillTemplate,
  renderAgentYamlTemplate,
  renderSkillTemplate,
} from "./templates.js";
import { bodySize } from "./workshop-analysis.js";
import { buildFromContent, definitionDir } from "./workshop-build.js";
import {
  bodyProblems,
  type Cost,
  costOf,
  type Draft,
  draftProblems,
  type Known,
  listProblems,
  type Problem,
} from "./workshop-rules.js";

export const AGENT_ACTIONS = ["create", "edit", "enable", "disable"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/** Who an agent or skill comes from: the shipped method, or the creator. */
export type AgentOrigin = "shipped" | "creator";

/** The creator's settings of an agent after `agent edit --tier/--tool`. */
export interface SettingsOutcome {
  /** `unchanged` when `method.yaml` already held these settings. */
  readonly status: "updated" | "unchanged";
  readonly model_tier?: ModelTier;
  readonly tool?: ToolId;
}

export type AgentCommandResult =
  | {
      readonly action: "create";
      readonly kind: DefinitionKind;
      readonly id: string;
      /** Files written, in order. */
      readonly paths: readonly string[];
      /** A definition the workshop checked: what the addition costs in tokens. */
      readonly cost?: Cost;
    }
  | {
      readonly action: "edit";
      readonly kind: DefinitionKind;
      readonly id: string;
      readonly origin: AgentOrigin;
      /**
       * Files to edit: the creator's own files (validated), or the customisation of a shipped
       * agent.
       */
      readonly paths: readonly string[];
      /** True when the customisation template was just created. */
      readonly created: boolean;
      /**
       * Present when `tier` or `tool` was given: the settings were written in `method.yaml` (the
       * only path then), and no customisation was created.
       */
      readonly settings?: SettingsOutcome;
      /**
       * Present when `content` was given: the definition was written in the creator's own files
       * (`paths` lists those that changed); `unchanged` when they already held it.
       */
      readonly content?: { readonly status: "updated" | "unchanged" };
      /**
       * A shipped skill's customisation: the layer written or checked, and what the
       * product's and the personal layers add together each time the skill runs.
       */
      readonly customisation?: { readonly layer: SkillLayer; readonly cost: OverrideCost };
    }
  | {
      readonly action: "enable" | "disable";
      readonly id: string;
      /** `unchanged` when `method.yaml` already gave that result. */
      readonly status: "updated" | "unchanged";
    };

function notFound(id: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.AGENT_NOT_FOUND, "error.agent_not_found", { id });
}

export { definitionDir };

/** Every identifier already taken, and where it comes from. */
export interface KnownIds {
  /** Agents and skills shipped with the engine, by kind. */
  readonly shipped: ReadonlyMap<string, DefinitionKind>;
  /** Agents of the method's catalog (some are not shipped yet). */
  readonly catalog: ReadonlySet<string>;
  /** Folders of `.agentplugged/agents/` and `.agentplugged/skills/`, by kind. */
  readonly installed: ReadonlyMap<string, DefinitionKind>;
}

export async function knownIds(files: WorkspaceFiles, method: MethodSource): Promise<KnownIds> {
  const shipped = new Map<string, DefinitionKind>();
  const installed = new Map<string, DefinitionKind>();
  for (const [dir, kind] of DEFINITION_DIRS) {
    for (const name of await definitionFolders(method, dir)) shipped.set(name, kind);
    for (const name of await definitionFolders(files, `${METHOD_DIR}/${dir}`)) {
      installed.set(name, kind);
    }
  }
  const catalog = new Set<string>(Object.keys(AGENT_DOMAINS));
  return { shipped, catalog, installed };
}

/**
 * Checks `agent create` before anything is asked or written: the method is installed, the kind
 * is `agent` or `skill`, the id is valid and taken by no agent or skill (shipped, in the catalog
 * or the creator's), and every option given is valid (a skill takes no agent option). The CLI
 * calls it before the first question.
 */
export async function checkCreate(
  context: Pick<CommandContext, "files" | "method">,
  input: Readonly<Record<string, unknown>>,
): Promise<AgentPluggedError | undefined> {
  if (!(await context.files.exists(METHOD_CONFIG_PATH))) return methodNotInstalled();
  const kind = kindOf(input.kind);
  if (kind instanceof AgentPluggedError) return kind;
  const id = validateNewId(kind, input.id);
  if (id instanceof AgentPluggedError) return id;
  const known = await knownIds(context.files, context.method);
  const taken =
    known.shipped.has(id) ||
    known.catalog.has(id) ||
    known.installed.has(id) ||
    (await context.files.exists(definitionDir("agent", id))) ||
    (await context.files.exists(definitionDir("skill", id)));
  if (taken) return new AgentPluggedError(ErrorCode.AGENT_EXISTS, "error.agent_exists", { id });
  return validateGivenAnswers(kind, givenAnswers(input));
}

async function create(
  context: CommandContext,
  input: Readonly<Record<string, unknown>>,
): Promise<AgentCommandResult | AgentPluggedError> {
  const problem = await checkCreate(context, input);
  if (problem !== undefined) return problem;
  const kind = kindOf(input.kind) as DefinitionKind; // checked above
  const id = input.id as string;
  const answers = givenAnswers(input);
  // The complete definition, written as given; none: the commented template.
  const content = input.content === undefined ? undefined : parseContent(kind, input.content);
  if (content instanceof AgentPluggedError) return content;
  // With a definition the workshop lists everything missing at once; the template
  // of the terminal asks for the first missing option.
  if (content !== undefined) return createFromContent(context, kind, id, answers, content);
  const missing = REQUIRED_FIELDS[kind].find((field) => answers[field] === undefined);
  if (missing !== undefined) return invalidArgument("error.agent.required", { option: missing });
  const value = (field: CreateField) => answers[field] ?? "";

  const dir = definitionDir(kind, id);
  const writes: Array<readonly [string, string]> = [];
  if (kind === "skill") {
    writes.push([
      `${dir}/${SKILL_FILE}`,
      renderSkillTemplate({ id, description: value("description") }),
    ]);
  } else {
    const agent: NewAgent = {
      id,
      title: value("title"),
      description: value("description"),
      domain: value("domain") as NewAgent["domain"], // validated above
      phase: value("phase") as NewAgent["phase"],
      ...(answers.name !== undefined ? { name: answers.name } : {}),
      ...(answers.icon !== undefined ? { icon: answers.icon } : {}),
      ...(answers.role !== undefined ? { role: answers.role } : {}),
    };
    writes.push([`${dir}/${SKILL_FILE}`, renderAgentSkillTemplate(agent)]);
    writes.push([`${dir}/${AGENT_FILE}`, renderAgentYamlTemplate(agent)]);
  }

  // Validated before anything is written.
  const [skill, agentYaml] = writes.map(([, content]) => content);
  const parsed = parseDefinition(kind, dir, id, skill ?? "", [], agentYaml);
  if (parsed instanceof AgentPluggedError) return parsed;

  for (const [path, content] of writes) await context.files.writeText(path, content);
  return { action: "create", kind, id, paths: writes.map(([path]) => path) };
}

/**
 * The refusal of the workshop: everything wrong with an addition, listed, so that
 * the creator or the agent fixes it in one go. Nothing was written.
 */
export function workshopRefused(
  kind: DefinitionKind,
  id: string,
  problems: readonly Problem[],
): AgentPluggedError {
  return invalidArgument("error.agent.workshop_refused", {
    kind,
    id,
    count: problems.length,
    problems: listProblems(problems),
  });
}

/** What the workshop's rules need to know of the product. */
export async function workshopKnown(
  context: Pick<CommandContext, "files" | "method">,
  /** The thing being completed: its own name and id are not a collision. */
  self?: string,
): Promise<{ known: Known; definitions: Definition[]; config: MethodConfig } | AgentPluggedError> {
  const loaded = await loadMethodConfig(context.files);
  if (loaded instanceof AgentPluggedError) return loaded;
  const definitions = await loadDefinitions(context.files);
  if (definitions instanceof AgentPluggedError) return definitions;
  const ids = await knownIds(context.files, context.method);
  const taken = new Set<string>([...ids.shipped.keys(), ...ids.catalog, ...ids.installed.keys()]);
  if (self !== undefined) taken.delete(self);
  const agentNames = new Map<string, string>();
  for (const definition of definitions) {
    if (definition.kind === "agent" && definition.name !== self && definition.agent !== undefined) {
      agentNames.set(definition.name, definition.agent.name.toLowerCase());
    }
  }
  const skills = new Set(
    activeDefinitions(definitions, loaded.config)
      .filter((definition) => definition.kind === "skill")
      .map((definition) => definition.name),
  );
  return { known: { taken, agentNames, skills }, definitions, config: loaded.config };
}

/**
 * `agent create` with the complete definition: the workshop checks it whole (story
 * 17.15: name, fields, description, instructions, links, ceilings), then writes exactly what was
 * approved, a skill's files of detail included. Nothing is written when anything is wrong.
 */
async function createFromContent(
  context: CommandContext,
  kind: DefinitionKind,
  id: string,
  answers: Partial<Record<CreateField, string>>,
  content: AgentContent | SkillContent,
): Promise<AgentCommandResult | AgentPluggedError> {
  const known = await workshopKnown(context);
  if (known instanceof AgentPluggedError) return known;
  const draft: Draft = { kind, id, ...answers, content };
  const dir = definitionDir(kind, id);
  const built = buildFromContent(dir, draft);
  const problems = draftProblems(draft, known.known);
  // The files are checked before they are written; a refusal of the engine's schema comes after
  // the list of what the workshop found, which usually says why.
  if (problems.length > 0) return workshopRefused(kind, id, problems);
  if (built.definition instanceof AgentPluggedError) return built.definition;
  const heavy = bodyProblems(bodySize(built.definition));
  if (heavy.length > 0) return workshopRefused(kind, id, heavy);

  const paths = built.files.map(([path]) => `${dir}/${path}`);
  for (const [index, [, text]] of built.files.entries()) {
    await context.files.writeText(paths[index] as string, text);
  }
  return {
    action: "create",
    kind,
    id,
    paths,
    cost: costOf(id, draft.description, bodySize(built.definition)),
  };
}

/** Reads and validates one definition folder. */
async function readOne(
  source: MethodSource,
  dir: string,
  kind: DefinitionKind,
  id: string,
): Promise<Definition | AgentPluggedError> {
  const files = await source.listFiles(dir);
  const has = (file: string) => files.includes(`${dir}/${file}`);
  const skill = has(SKILL_FILE) ? await source.readText(`${dir}/${SKILL_FILE}`) : "";
  const agentRaw =
    kind === "agent" && has(AGENT_FILE) ? await source.readText(`${dir}/${AGENT_FILE}`) : undefined;
  return parseDefinition(kind, dir, id, skill, [], agentRaw);
}

/**
 * `agent edit <skill>` on a skill shipped with the method: the customisation of the
 * product (`shared`) or the person's own (`personal`). The commented template is written when the
 * file is not there; a file that is there is checked, everything wrong listed at once.
 */
async function editSkill(
  context: CommandContext,
  id: string,
  layer: SkillLayer,
): Promise<AgentCommandResult | AgentPluggedError> {
  const path = skillOverridePath(id, layer);
  const created = !(await context.files.exists(path));
  if (layer === "personal") await ensurePersonalIgnore(context.files);
  if (created) await context.files.writeText(path, renderSkillOverrideTemplate(id, layer));
  const layers = await loadSkillLayers(context.files, id);
  if (layers instanceof AgentPluggedError) return layers;
  return {
    action: "edit",
    kind: "skill",
    id,
    origin: "shipped",
    paths: [path],
    created,
    customisation: { layer, cost: await overrideCostWithFiles(context.files, id, layers) },
  };
}

async function edit(
  context: CommandContext,
  id: string,
  layer: SkillLayer = "shared",
): Promise<AgentCommandResult | AgentPluggedError> {
  const { files, method } = context;
  const known = await knownIds(files, method);
  const shippedKind = known.shipped.get(id);
  if (shippedKind === "skill") {
    // Only an installed skill can be customised: the file would name nothing else.
    if (known.installed.get(id) !== "skill") return notFound(id);
    return await editSkill(context, id, layer);
  }
  if (layer === "personal") return invalidArgument("error.agent.personal_skill_only", { id });

  const kind = known.installed.get(id);
  // A shipped agent missing from `.agentplugged/agents/` (init not run since): a customisation
  // would name no agent and break every sync.
  if (kind === undefined) return notFound(id);
  const dir = definitionDir(kind, id);
  const definition = await readOne(files, dir, kind, id);
  if (definition instanceof AgentPluggedError) return definition;

  if (shippedKind === "agent") {
    // A shipped agent is customised in `overrides/`, never in its own files.
    const path = overridePath(id);
    if (await files.exists(path)) {
      const current = parseOverride(path, await files.readText(path));
      if (current instanceof AgentPluggedError) return current;
      return {
        action: "edit",
        kind: "agent",
        id,
        origin: "shipped",
        paths: [path],
        created: false,
      };
    }
    if (definition.agent === undefined) return notFound(id);
    const tier = (definition.frontmatter as AgentFrontmatter).metadata.model_tier;
    await files.writeText(path, renderOverrideTemplate(id, definition.agent, tier));
    return { action: "edit", kind: "agent", id, origin: "shipped", paths: [path], created: true };
  }
  const paths = [`${dir}/${SKILL_FILE}`, ...(kind === "agent" ? [`${dir}/${AGENT_FILE}`] : [])];
  return { action: "edit", kind, id, origin: "creator", paths, created: false };
}

/**
 * `agent_edit` with `content`: completes an agent or skill of the creator's, a
 * skeleton for instance, with the definition they approved. The body of `SKILL.md` is replaced and,
 * for an agent, `principles` and `menu` (and `identity`, `communication_style` and
 * `persistent_facts` when the definition gives them) in `agent.yaml`; the rest of the files stays.
 * A shipped agent or skill is never written (its changes live in `overrides/`). Files are checked
 * before they are written.
 */
async function editContent(
  context: CommandContext,
  id: string,
  raw: unknown,
  layer: SkillLayer = "shared",
): Promise<AgentCommandResult | AgentPluggedError> {
  const { files, method } = context;
  const known = await knownIds(files, method);
  // The content of a skill shipped with the method is its customisation, whole.
  if (known.shipped.get(id) === "skill" && isSkillOverrideContent(raw as Record<string, unknown>)) {
    if (known.installed.get(id) !== "skill") return notFound(id);
    return await writeSkillOverride(context, id, raw, layer);
  }
  if (known.shipped.has(id)) return invalidArgument("error.agent.shipped_content", { id });
  if (layer === "personal") return invalidArgument("error.agent.personal_skill_only", { id });
  const kind = known.installed.get(id);
  if (kind === undefined) return notFound(id);
  const content = parseContent(kind, raw);
  if (content instanceof AgentPluggedError) return content;

  const dir = definitionDir(kind, id);
  const skillPath = `${dir}/${SKILL_FILE}`;
  const agentPath = `${dir}/${AGENT_FILE}`;
  const skillText = await files.readText(skillPath);
  const bad = () => invalidArgument("error.agent.content_unreadable", { id });
  const skillNext = replaceBody(
    skillText,
    kind === "agent"
      ? renderAgentBody(
          (await agentNameOf(files, agentPath)) ?? displayName(id),
          content as AgentContent,
        )
      : renderSkillBody(content as SkillContent),
  );
  if (skillNext === undefined) return bad();
  const writes: Array<readonly [string, string, string]> = [[skillPath, skillText, skillNext]];
  let agentNext: string | undefined;
  if (kind === "agent") {
    const agentText = await files.readText(agentPath);
    agentNext = setAgentContent(agentText, content as AgentContent);
    if (agentNext === undefined) return bad();
    writes.push([agentPath, agentText, agentNext]);
  }
  // A skill's files of detail: written or updated, never deleted.
  const details = kind === "skill" ? renderSkillReferences(content as SkillContent) : [];
  for (const { name, text } of details) {
    const path = `${dir}/${REFERENCES_DIR}/${name}.md`;
    writes.push([path, (await files.exists(path)) ? await files.readText(path) : "", text]);
  }
  // Validated before anything is written.
  const parsed = parseDefinition(
    kind,
    dir,
    id,
    skillNext,
    details.map(({ name }) => `${REFERENCES_DIR}/${name}.md`),
    agentNext,
  );
  if (parsed instanceof AgentPluggedError) return parsed;
  // The workshop's rules on the definition: instructions, links, ceilings. The
  // identity (name, description) is not what an edit changes.
  const workshop = await workshopKnown(context, id);
  if (workshop instanceof AgentPluggedError) return workshop;
  const draft: Draft = {
    kind,
    id,
    description: (parsed.frontmatter as { description: string }).description,
    content,
  };
  const problems = [
    ...draftProblems(draft, workshop.known, "edit"),
    ...bodyProblems(bodySize(parsed)),
  ];
  if (problems.length > 0) return workshopRefused(kind, id, problems);
  const changed = writes.filter(
    ([, before, after]) => normalizeText(before) !== normalizeText(after),
  );
  for (const [path, , after] of changed) await files.writeText(path, after);
  return {
    action: "edit",
    kind,
    id,
    origin: "creator",
    paths: changed.map(([path]) => path),
    created: false,
    content: { status: changed.length === 0 ? "unchanged" : "updated" },
  };
}

/**
 * `agent_edit` with a customisation: the whole content of one layer of a shipped
 * skill's customisation, checked as `sync` checks it (everything wrong at once) and written as
 * given. The method itself is never written.
 */
async function writeSkillOverride(
  context: CommandContext,
  id: string,
  raw: unknown,
  layer: SkillLayer,
): Promise<AgentCommandResult | AgentPluggedError> {
  const parsed = SkillOverrideSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return invalidArgument("error.agent.content_invalid", {
      field: (issue?.path ?? []).join("."),
      reason: issue?.message ?? "invalid",
    });
  }
  const checked = await checkSkillOverrideRequest(context.files, id, layer, parsed.data);
  if (checked instanceof AgentPluggedError) return checked;
  if (layer === "personal") await ensurePersonalIgnore(context.files);
  const path = skillOverridePath(id, layer);
  const before = (await context.files.exists(path))
    ? await context.files.readText(path)
    : undefined;
  const changed = before === undefined || normalizeText(before) !== normalizeText(checked.text);
  if (changed) await context.files.writeText(path, checked.text);
  return {
    action: "edit",
    kind: "skill",
    id,
    origin: "shipped",
    paths: changed ? [path] : [],
    created: before === undefined,
    content: { status: changed ? "updated" : "unchanged" },
    customisation: { layer, cost: await overrideCostWithFiles(context.files, id, checked.layers) },
  };
}

/** The display name an agent's `agent.yaml` gives (the headings of its body use it). */
async function agentNameOf(files: WorkspaceFiles, path: string): Promise<string | undefined> {
  const parsed = parseYaml(path, await files.readText(path), AgentDefinitionSchema);
  return parsed instanceof AgentPluggedError ? undefined : parsed.name;
}

/**
 * `agent edit <id> --tier/--tool`: records the creator's settings of an agent (shipped or theirs)
 * in `agents.settings.<id>` of `method.yaml`. A skill has no settings.
 */
async function editSettings(
  context: CommandContext,
  id: string,
  change: SettingsChange,
): Promise<AgentCommandResult | AgentPluggedError> {
  const { files, method } = context;
  const loaded = await loadMethodConfig(files);
  if (loaded instanceof AgentPluggedError) return loaded;
  const known = await knownIds(files, method);
  const kind = known.installed.get(id);
  if (kind === undefined) return notFound(id);
  if (kind === "skill") return invalidArgument("error.agent.skill_settings", { id });

  const all = loaded.config.agents?.settings ?? {};
  const current: AgentSettings = Object.hasOwn(all, id) ? (all[id] ?? {}) : {};
  const next = changedSettings(current, change);
  const same = SETTINGS_KEYS.every((key) => current[key] === next[key]);
  if (!same) {
    const content = writeAgentSettings(loaded.text, id, next);
    if (content instanceof AgentPluggedError) return content;
    await files.writeText(METHOD_CONFIG_PATH, content);
  }
  return {
    action: "edit",
    kind: "agent",
    id,
    origin: known.shipped.get(id) === "agent" ? "shipped" : "creator",
    paths: [METHOD_CONFIG_PATH],
    created: false,
    settings: { status: same ? "unchanged" : "updated", ...next },
  };
}

/** The list at `agents.<key>` of `method.yaml`. */
function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Writes `agents.enabled` and `agents.disabled` into the text of `method.yaml`, keeping comments,
 * other keys and line endings. An empty list is removed, and so is an empty `agents` section.
 */
export function writeAgentLists(
  text: string,
  enabled: readonly string[],
  disabled: readonly string[],
): string | AgentPluggedError {
  const document = parseDocument(text);
  for (const [key, list] of [
    ["enabled", enabled],
    ["disabled", disabled],
  ] as const) {
    if (list.length > 0) document.setIn(["agents", key], document.createNode([...list]));
    else if (document.hasIn(["agents", key])) document.deleteIn(["agents", key]);
  }
  const agents = document.get("agents", true);
  if (isMap(agents) && agents.items.length === 0) document.delete("agents");
  return editedMethodText(document, text);
}

/**
 * New `enabled` and `disabled` lists. Enable: out of `disabled`, into `enabled` only when the
 * profile makes it inactive. Disable: out of `enabled`, into `disabled` unless the profile already
 * makes it inactive and it was not enabled. Enabling what was disabled thus returns to following
 * the profile.
 */
export function toggledLists(
  agents: MethodConfig["agents"],
  action: "enable" | "disable",
  id: string,
): { enabled: string[]; disabled: string[] } {
  const inactive = listOf(agents?.inactive).includes(id);
  const enabled = listOf(agents?.enabled);
  const disabled = listOf(agents?.disabled);
  const without = (list: string[]) => list.filter((other) => other !== id);
  const add = (list: string[]) => (list.includes(id) ? list : [...list, id]);
  if (action === "enable") {
    return { enabled: inactive ? add(enabled) : enabled, disabled: without(disabled) };
  }
  const wasEnabled = enabled.includes(id);
  return {
    enabled: without(enabled),
    disabled: inactive && !wasEnabled ? disabled : add(disabled),
  };
}

/**
 * A skill stays callable while an active agent's menu (with its customisation) calls it: it
 * cannot be disabled. Returns the first such agent.
 */
async function agentCalling(
  context: CommandContext,
  config: MethodConfig,
  skill: string,
): Promise<string | undefined | AgentPluggedError> {
  const definitions = await loadDefinitions(context.files);
  if (definitions instanceof AgentPluggedError) return definitions;
  const shipped = await definitionFolders(context.method, "agents");
  const overrides = await loadOverrides(context.files, definitions, shipped);
  if (overrides instanceof AgentPluggedError) return overrides;
  for (const definition of activeDefinitions(definitions, config)) {
    if (definition.kind !== "agent" || definition.agent === undefined) continue;
    const override = overrides.get(definition.name);
    const agent = override ? mergeAgent(definition.agent, override) : definition.agent;
    if (agent.menu.some((item) => item.skill === skill)) return definition.name;
  }
  return undefined;
}

async function toggle(
  context: CommandContext,
  action: "enable" | "disable",
  id: string,
): Promise<AgentCommandResult | AgentPluggedError> {
  const { files, method } = context;
  const loaded = await loadMethodConfig(files);
  if (loaded instanceof AgentPluggedError) return loaded;
  // Only what has files can be generated: a catalog agent not shipped yet is not found.
  const kind = (await knownIds(files, method)).installed.get(id);
  if (kind === undefined) return notFound(id);

  // Enabling a developer whose specialty is off turns the specialty on too: the
  // profile stays the one record of who works on the product, and `agents.inactive` is computed
  // from it again, so the developer is no longer a mere exception to it.
  let text = loaded.text;
  let config = loaded.config;
  let specialtyOn = false;
  const specialty = action === "enable" && kind === "agent" ? specialtyOf(id) : undefined;
  const profile = config.profile;
  if (
    specialty !== undefined &&
    profile !== undefined &&
    profile.domains.includes("code") &&
    !profile.specialties.includes(specialty)
  ) {
    const written = writeProfile(text, {
      ...profile,
      specialties: DEVELOPER_SPECIALTIES.filter(
        (other) => other === specialty || profile.specialties.includes(other),
      ),
    });
    if (written instanceof AgentPluggedError) return written;
    const reread = parseMethodConfig(written);
    if (reread instanceof AgentPluggedError) return reread;
    text = written;
    config = reread;
    specialtyOn = true;
  }

  const agents = config.agents;
  const toggled = toggledLists(agents, action, id);
  // An exception the specialty now makes useless would outlive the specialty: drop it.
  const enabled = specialtyOn ? toggled.enabled.filter((other) => other !== id) : toggled.enabled;
  const { disabled } = toggled;
  const same = (a: readonly string[], b: readonly string[]) => a.join(",") === b.join(",");
  if (
    !specialtyOn &&
    same(enabled, listOf(agents?.enabled)) &&
    same(disabled, listOf(agents?.disabled))
  ) {
    return { action, id, status: "unchanged" };
  }
  if (action === "disable" && kind === "skill") {
    const next: MethodConfig = { ...config, agents: { ...agents, enabled, disabled } };
    const agent = await agentCalling(context, next, id);
    if (agent instanceof AgentPluggedError) return agent;
    if (agent !== undefined) return invalidArgument("error.agent.skill_in_use", { id, agent });
  }
  const content = writeAgentLists(text, enabled, disabled);
  if (content instanceof AgentPluggedError) return content;
  await files.writeText(METHOD_CONFIG_PATH, content);
  return { action, id, status: "updated" };
}

/**
 * The creator's agents and skills: `input.action` is `create`, `edit`, `enable` or `disable`, and
 * `input.id` the identifier. `create` also reads `kind` (`agent` or `skill`), `name`, `title`,
 * `description`, `domain`, `phase`, `icon` and `role`; `edit` also reads `tier` (a model tier, or
 * `default`) and `tool` (a tool id, or `none`), recorded in `method.yaml`. Both also read
 * `content` (from a creator's request only, never from the terminal): the complete
 * definition of an agent or skill, written as given instead of the template (`create`) or over
 * the body and menu of a creator's agent (`edit`, alone: never with `tier` or `tool`). Nothing is
 * ever deleted, and no editor is opened.
 */
export const agentCommand = defineCommand<AgentCommandResult>({
  name: "agent",
  async run(context, input) {
    const action = input.action;
    if (typeof action !== "string" || !(AGENT_ACTIONS as readonly string[]).includes(action)) {
      return fail(
        invalidArgument("error.agent.unknown_action", {
          action: String(action ?? ""),
          actions: AGENT_ACTIONS.join(", "),
        }),
      );
    }
    // `tier` and `tool` belong to `edit`; they are checked before anything is read.
    const change = settingsChange(input);
    if (change instanceof AgentPluggedError) return fail(change);
    if (input.content !== undefined && action !== "create" && action !== "edit") {
      return fail(invalidArgument("error.agent.content_create_edit_only", { action }));
    }
    if (input.content !== undefined && change !== undefined) {
      return fail(invalidArgument("error.agent.content_alone"));
    }
    if (input.layer !== undefined && (change !== undefined || action !== "edit")) {
      return fail(invalidArgument("error.agent.layer_alone", { action }));
    }
    if (change !== undefined && action !== "edit") {
      return fail(invalidArgument("error.agent.settings_edit_only", { action }));
    }
    if (!(await context.files.exists(METHOD_CONFIG_PATH))) return fail(methodNotInstalled());
    if (action === "create") {
      const created = await create(context, input);
      return created instanceof AgentPluggedError ? fail(created) : ok(created);
    }
    const id = input.id;
    if (typeof id !== "string" || id === "")
      return fail(invalidArgument("error.agent.id_required"));
    const layer: SkillLayer = input.layer === "personal" ? "personal" : "shared";
    const result =
      action !== "edit"
        ? await toggle(context, action as "enable" | "disable", id)
        : input.content !== undefined
          ? await editContent(context, id, input.content, layer)
          : change !== undefined
            ? await editSettings(context, id, change)
            : await edit(context, id, layer);
    return result instanceof AgentPluggedError ? fail(result) : ok(result);
  },
});
