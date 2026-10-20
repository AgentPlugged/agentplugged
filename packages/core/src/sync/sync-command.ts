import { sha256Hex } from "@agentplugged/crypto";
import {
  CursorCliConfigSchema,
  ErrorCode,
  LEGACY_GEMINI_CLIENT,
  type MethodConfig,
  NOAH_AGENT,
  type RuleAction,
  type ToolId,
} from "@agentplugged/protocol";
import { checkActiveMenus, loadOverrides } from "../agents/overrides.js";
import { loadSkillOverrides, skillSections } from "../agents/skill-overrides.js";
import {
  ANTIGRAVITY_PLUGIN_DIR,
  ANTIGRAVITY_PLUGIN_MANIFEST_PATH,
} from "../chat/antigravity-hook.js";
import { CODEX_POLICY_PATH } from "../chat/codex-hook.js";
import { CURSOR_HOOKS_PATH, CURSOR_POLICY_PATH } from "../chat/cursor-hook.js";
import { resolveValidationSettings } from "../chat/validation-settings.js";
import { defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import {
  constitutionTarget,
  renderConstitution,
  renderConstitutionReferenceFiles,
} from "../init/constitution.js";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  isGenerated,
  normalizeText,
  pointerStyleOf,
  removePointerBlock,
  renderImportFile,
  withPointerBlock,
} from "../init/generated.js";
import {
  METHOD_CONFIG_PATH,
  METHOD_CONSTITUTION_PATH,
  METHOD_DIR,
  REFERENCE_DIR,
  REFERENCE_LEGACY_PATH,
  ROOT_CONSTITUTION_PATH,
} from "../init/layout.js";
import { loadMethodConfig, writeTools } from "../init/method-config.js";
import {
  checkMenuSkills,
  type Definition,
  definitionFolders,
  definitionInvalid,
  readDefinitions,
  SKILL_FILE,
} from "../method/definitions.js";
import { DEFINITION_DIRS } from "../method/install-method.js";
import { effectiveTable, inheritClients, loadModelTable } from "../models/model-table.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import { type RulesSource, type RulesWarning, resolveRules } from "../rules/resolve-rules.js";
import { detectTools } from "../tools/detect-tools.js";
import { targetedTools } from "../tools/targeted-tools.js";
import type { AntigravityPolicy } from "../trust/antigravity-policy.js";
import { sameBytes } from "../values.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { type ResolvedAgent, resolveAgent } from "./agent-render.js";
import { type ClientId, fallbacksFor, type ToolFallback } from "./compatibility.js";
import { withCursorIgnoreBlock, withoutCursorIgnoreBlock } from "./cursor-ignore.js";
import { cleanLegacyGemini, hasLegacyGeminiFiles, isLegacyGeminiAgent } from "./gemini-legacy.js";
import { syncInputsFingerprint } from "./inputs.js";
import { loadManifest, renderManifest, SYNC_MANIFEST_PATH } from "./manifest.js";
import {
  engineCommand,
  engineWords,
  GEMINI_SETTINGS_PATH,
  MCP_JSON_FILES,
  mcpLaunch,
  parseMcpFile,
  reconcileMcpFile,
  renderMcpFile,
  withEngineCommand,
} from "./mcp.js";
import {
  CURSOR_FLAVOR,
  claudeFlavor,
  cursorDenyRules,
  denyRules,
  type mergeSettings,
  ownedRules,
  type PermissionList,
  type PermissionLists,
  parseSettings,
  reconcileSettings,
  renderSettings,
  type SettingsFlavor,
  type SettingsRecord,
} from "./permissions.js";
import {
  claudeCommandRules,
  claudeRulePermissions,
  codexRuleSettings,
  cursorRulePermissions,
} from "./rule-permissions.js";
import { GEMINI_MD_PATH, renderAntigravity } from "./targets/antigravity.js";
import {
  isGeneratedPluginManifest,
  renderAntigravityPlugin,
} from "./targets/antigravity-plugin.js";
import { CLAUDE_MD_PATH, CLAUDE_SETTINGS_PATH, renderClaudeCode } from "./targets/claude-code.js";
import { CODEX_CONFIG_PATH, renderCodex, renderCodexGuard } from "./targets/codex.js";
import {
  GENERATED_ROOTS,
  headerOf,
  isGeneratedPath,
  type RenderInput,
  skillFolderOf,
  type Target,
  type TargetGroup,
} from "./targets/common.js";
import {
  CURSOR_CLI_PATH,
  CURSOR_IGNORE_PATH,
  renderCursor,
  renderCursorGuard,
} from "./targets/cursor.js";
import { renderSharedSkills } from "./targets/shared-skills.js";
import { claudeTrustHooks, type TrustHooks, withTrustHooks } from "./trust-hooks.js";
import { worktreesFolderOf } from "./worktrees-folder.js";

export type SyncAction = "created" | "updated" | "unchanged" | "deleted";

export interface SyncEntry {
  readonly path: string;
  readonly action: SyncAction;
  /** The tool the file is for, or `shared` when several tools read it. */
  readonly group: TargetGroup;
}

/**
 * - `overwritten`: a generated file was modified by hand since the last `sync`, and regenerated.
 * - `conflict`: a file or folder without the header (the creator's) has the name of a generated
 *   one; it is left as is and nothing is generated there.
 * - `kept`: a file is no longer generated, but the creator changed it, took it (header removed)
 *   or owns its skill folder: kept, never deleted.
 * - `description_too_long`: the preferred-tool sentence would take the description of agent `id`
 *   (`path`, its `SKILL.md`) over 1024 characters, so it was left out.
 * - `unknown_setting`: `agents.settings.<id>` of `method.yaml` (`path`) names no installed agent,
 *   and is ignored.
 * - `local_engine`: `mcp` of `method.yaml` (`path`) names an absolute path (a local build): the
 *   generated files now hold a path of this machine, not to be shared.
 * - `gemini_legacy`: the project still holds what the retired Gemini CLI left (`path`): it is read
 *   and left as it is, and the cleanup removes what `sync` wrote.
 * - `gemini_unproven`: the cleanup cannot prove it wrote `path` (changed since, or no trace): it is
 *   listed and kept, removed only on confirmation.
 */
export interface SyncWarning {
  readonly kind:
    | "overwritten"
    | "conflict"
    | "kept"
    | "description_too_long"
    | "unknown_setting"
    | "local_engine"
    | "gemini_legacy"
    | "gemini_unproven";
  readonly path: string;
  /** The agent or settings key, for the last two kinds. */
  readonly id?: string;
}

export interface SyncResult {
  readonly entries: readonly SyncEntry[];
  readonly warnings: readonly SyncWarning[];
  /** Tools the files were generated for, in catalog order. */
  readonly tools: readonly ToolId[];
  /** Capabilities the targeted tools lack, also written in the constitution. */
  readonly fallbacks: readonly ToolFallback[];
  /**
   * `.codex/config.toml` was just created or updated: Codex reads it only once the project is
   * trusted, which the creator is reminded of.
   */
  readonly codexTrustReminder: boolean;
  /**
   * `.cursor/hooks.json` was just created or updated: Cursor runs the project's hooks only in a
   * workspace the creator trusts, which the creator is reminded of.
   */
  readonly cursorHooksReminder: boolean;
  /** Generated agents with a preferred tool, in definition order. */
  readonly preferredTools: readonly PreferredTool[];
  /** The permission rules written: where they come from, and what to report. */
  readonly rules?: SyncRules;
  /**
   * Present only for the cleanup of the retired Gemini CLI's files: how many files it listed
   * without being able to prove it wrote them.
   */
  readonly geminiCleanup?: { readonly listed: number };
}

/** What `sync` says about the permission rules. */
export interface SyncRules {
  readonly source: RulesSource;
  /** Locked rules loosened by hand (`RULE_LOCKED`), working copy looser than the main branch… */
  readonly warnings: readonly RulesWarning[];
  /** Actions whose `ask` was written as `deny` for the Cursor CLI (Cursor targeted only). */
  readonly cursorAskedAsDeny: readonly RuleAction[];
  /**
   * Settings files that receive `allow` rules from `sync` for the first time (an upgrade, or a
   * new product), with how many: said once, since agents then act without asking.
   */
  readonly allowAdded: readonly { readonly path: string; readonly count: number }[];
  /**
   * Our `allow` rules that a list of the creator's (`ask` or `deny`) also holds: the creator's
   * stricter rule wins in the tool, and it is said.
   */
  readonly conflicts: readonly {
    readonly path: string;
    readonly rule: string;
    readonly list: "ask" | "deny";
  }[];
}

/** Our `allow` rules a stricter list of the creator's also holds (not one `sync` put there). */
function allowConflicts(
  path: string,
  current: object | undefined,
  allow: readonly string[],
  ours: PermissionLists,
): SyncRules["conflicts"] {
  const permissions = (current as { permissions?: Record<string, unknown> } | undefined)
    ?.permissions;
  const found: Array<{ path: string; rule: string; list: "ask" | "deny" }> = [];
  for (const list of ["deny", "ask"] as const) {
    const value = permissions?.[list];
    if (!Array.isArray(value)) continue;
    const mine = new Set(ours[list] ?? []);
    for (const rule of allow) {
      if (value.includes(rule) && !mine.has(rule)) found.push({ path, rule, list });
    }
  }
  return found;
}

/** An agent's preferred tool (`agents.settings.<id>.tool`), shown in the summary. */
export interface PreferredTool {
  /** Agent identifier. */
  readonly id: string;
  /** Display name of the agent (`Iris`). */
  readonly name: string;
  readonly tool: ToolId;
  /**
   * False when the tool is not in `tools`: the agent is generated for the targeted tools all the
   * same, and the creator is warned.
   */
  readonly targeted: boolean;
}

type Operation =
  | { readonly kind: "write"; readonly path: string; readonly content: string | Uint8Array }
  | { readonly kind: "remove"; readonly path: string };

/** Decisions first, writes after: nothing is written when a definition or a setting is invalid. */
/** A POSIX, Windows (drive or UNC) absolute path. */
const isAbsolutePath = (word: string) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(word);

class SyncPlan {
  readonly entries: SyncEntry[] = [];
  readonly warnings: SyncWarning[] = [];
  readonly operations: Operation[] = [];
  /** Hashes of the generated files after this run, for the next manifest. */
  readonly hashes: Record<string, string> = {};
  /** Files deleted by this run, to prune the folders they leave empty. */
  readonly removed: string[] = [];

  constructor(
    readonly files: WorkspaceFiles,
    readonly previous: Readonly<Record<string, string>>,
  ) {}

  add(path: string, action: SyncAction, group: TargetGroup, operation?: Operation): void {
    this.entries.push({ path, action, group });
    if (operation) this.operations.push(operation);
    if (operation?.kind === "remove") this.removed.push(path);
  }

  warn(kind: SyncWarning["kind"], path: string, id?: string): void {
    this.warnings.push(id === undefined ? { kind, path } : { kind, path, id });
  }

  /**
   * A generated file: created, refreshed (a manual edit being reported), left as is, or skipped
   * when a file of the creator's (without header) holds its name. Files without a header of their
   * own (scripts, images) belong to a generated skill folder, already checked as a whole.
   */
  async target(target: Target): Promise<void> {
    const { path, content, group } = target;
    const write: Operation = { kind: "write", path, content };
    if (!(await this.files.exists(path))) {
      this.hashes[path] = sha256Hex(content);
      this.add(path, "created", group, write);
      return;
    }
    let currentHash: string;
    let same: boolean;
    if (typeof content === "string") {
      const current = normalizeText(await this.files.readText(path));
      // A text file without a header (the JSON of Antigravity's plugin) belongs to a folder whose
      // ownership was checked as a whole.
      const header = headerOf(path);
      if (header !== undefined && !isGenerated(current, header)) {
        this.warn("conflict", path);
        return;
      }
      same = current === content;
      currentHash = sha256Hex(current);
    } else {
      const current = await this.files.readBytes(path);
      same = sameBytes(current, content);
      currentHash = sha256Hex(current);
    }
    this.hashes[path] = sha256Hex(content);
    if (same) {
      this.add(path, "unchanged", group);
      return;
    }
    const recorded = this.previous[path];
    if (recorded !== undefined && recorded !== currentHash) this.warn("overwritten", path);
    else if (recorded === undefined && typeof content !== "string") this.warn("overwritten", path);
    this.add(path, "updated", group, write);
  }

  async apply(): Promise<void> {
    for (const operation of this.operations) {
      if (operation.kind === "remove") await this.files.remove(operation.path);
      else if (typeof operation.content === "string") {
        await this.files.writeText(operation.path, operation.content);
      } else await this.files.writeBytes(operation.path, operation.content);
    }
  }
}

/**
 * A skill folder is generated when its `SKILL.md` carries the header, or, without `SKILL.md`,
 * when every file in it was generated. An absent or empty folder is free.
 */
async function ownsSkillFolder(
  files: WorkspaceFiles,
  folder: string,
  previous: Readonly<Record<string, string>>,
): Promise<boolean> {
  const inside = await files.listFiles(folder);
  if (inside.length === 0) return true;
  const skill = `${folder}/${SKILL_FILE}`;
  if (inside.includes(skill)) return isGenerated(await files.readText(skill));
  return inside.every((path) => previous[path] !== undefined);
}

/**
 * Antigravity's plugin folder is generated when its `plugin.json` carries the mark, or,
 * without one, when every file in it was generated. An absent or empty folder is free.
 */
async function ownsPluginFolder(
  files: WorkspaceFiles,
  folder: string,
  previous: Readonly<Record<string, string>>,
): Promise<boolean> {
  const inside = await files.listFiles(folder);
  if (inside.length === 0) return true;
  if (inside.includes(ANTIGRAVITY_PLUGIN_MANIFEST_PATH)) {
    return isGeneratedPluginManifest(await files.readText(ANTIGRAVITY_PLUGIN_MANIFEST_PATH));
  }
  return inside.every((path) => previous[path] !== undefined);
}

/** Agents and skills of `.agentplugged/`, all validated; names must not collide. */
export async function loadDefinitions(
  files: WorkspaceFiles,
): Promise<Definition[] | AgentPluggedError> {
  const all: Definition[] = [];
  for (const [dir, kind] of DEFINITION_DIRS) {
    const definitions = await readDefinitions(files, `${METHOD_DIR}/${dir}`, kind);
    if (definitions instanceof AgentPluggedError) return definitions;
    for (const definition of definitions) {
      if (all.some((other) => other.name === definition.name)) {
        return definitionInvalid(
          `${definition.dir}/${SKILL_FILE}`,
          "name",
          `"${definition.name}" is already used by an agent`,
        );
      }
      all.push(definition);
    }
  }
  return checkMenuSkills(all) ?? all;
}

/**
 * Agents and skills to generate. Agents: (catalog minus `agents.inactive`) plus the creator's
 * agents plus `agents.enabled`, minus `agents.disabled`; the creator's agents are never in
 * `inactive`, which names catalog agents only (the developers of a specialty that is off among
 * them). Skills: all of them, minus `agents.disabled`.
 */
export function activeDefinitions(
  definitions: readonly Definition[],
  config: MethodConfig,
): Definition[] {
  const inactive = new Set(config.agents?.inactive ?? []);
  const enabled = new Set(config.agents?.enabled ?? []);
  const disabled = new Set(config.agents?.disabled ?? []);
  return definitions.filter(({ kind, name }) => {
    if (disabled.has(name)) return false;
    return kind !== "agent" || !inactive.has(name) || enabled.has(name);
  });
}

/** The names of the active agents (skills left out) of a product. */
export function activeAgentNames(
  definitions: readonly Definition[],
  config: MethodConfig,
): Set<string> {
  return new Set(
    activeDefinitions(definitions, config)
      .filter((definition) => definition.kind === "agent")
      .map((definition) => definition.name),
  );
}

/** Folders holding the files of each tool. */
const TOOL_ROOTS: Readonly<Record<ToolId, readonly string[]>> = {
  "claude-code": [".claude"],
  codex: [".agents", ".codex"],
  antigravity: [".agents", ".gemini"],
  cursor: [".agents", ".cursor"],
};

/** Folders each tool reads, kept even when empty while the tool is targeted. */
const TOOL_FOLDERS: Readonly<Record<ToolId, readonly string[]>> = {
  "claude-code": [".claude", ".claude/skills", ".claude/agents"],
  codex: [".agents", ".agents/skills", ".codex", ".codex/agents"],
  antigravity: [".agents", ".agents/skills", ".agents/agents"],
  cursor: [
    ".agents",
    ".agents/skills",
    ".cursor",
    ".cursor/agents",
    ".cursor/hooks",
    ".cursor/rules",
  ],
};

/** Generated folders of the targeted tools, in a fixed order. */
function rootsOf(tools: readonly ToolId[]): string[] {
  return GENERATED_ROOTS.filter((root) => tools.some((tool) => TOOL_ROOTS[tool].includes(root)));
}

/**
 * Removes the folders left empty by deletions, deepest first. The folders a targeted tool reads
 * (`.claude/skills`) stay; those of a tool no longer targeted go once empty.
 */
async function pruneEmptyFolders(
  files: WorkspaceFiles,
  removed: readonly string[],
  tools: readonly ToolId[],
) {
  const kept = new Set(tools.flatMap((tool) => TOOL_FOLDERS[tool]));
  const folders = new Set<string>();
  for (const path of removed) {
    if (!GENERATED_ROOTS.some((root) => path.startsWith(`${root}/`))) continue;
    const parts = path.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const folder = parts.slice(0, i).join("/");
      if (!kept.has(folder)) folders.add(folder);
    }
  }
  const deepestFirst = [...folders].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const folder of deepestFirst) {
    if (!(await files.exists(folder)) || (await files.listFiles(folder)).length > 0) continue;
    try {
      await files.remove(folder);
    } catch {
      // A folder the creator keeps (for example with empty sub-folders) stays.
    }
  }
}

/**
 * `CLAUDE.md` or `GEMINI.md`: generated when absent (an `@` import of the constitution), otherwise
 * the creator's file holds the import in its block. Returns true when the file is generated.
 */
async function planImportFile(
  plan: SyncPlan,
  path: string,
  group: TargetGroup,
  constitution: string,
  sameAs: (text: string) => "constitution" | "root-agents" | undefined,
  /** Files a generated one imports after the constitution. */
  also: readonly string[] = [],
): Promise<boolean> {
  const current = (await plan.files.exists(path)) ? await plan.files.readText(path) : undefined;
  const copy = current === undefined ? undefined : sameAs(current);
  if (copy !== undefined) {
    // The file is the constitution or AGENTS.md itself (for example a link): never rewritten.
    // A copy of the generated constitution is protected like it.
    plan.add(path, "unchanged", group);
    return copy === "constitution";
  }
  if (current === undefined || isGenerated(current)) {
    await plan.target({ path, content: renderImportFile(constitution, also), group });
    return true;
  }
  const updated = withPointerBlock(current, constitution, pointerStyleOf(path));
  const start = current.indexOf(BLOCK_BEGIN);
  if (start !== -1 && current.indexOf(BLOCK_END, start) === -1) {
    // A begin marker without its end: the block cannot be rewritten safely.
    plan.warn("conflict", path);
  } else if (updated === undefined) plan.add(path, "unchanged", group);
  else plan.add(path, "updated", group, { kind: "write", path, content: updated });
  return false;
}

interface SettingsFile {
  readonly path: string;
  readonly group: TargetGroup;
  readonly flavor: SettingsFlavor;
  /** Parsed content and text; undefined when the file is absent or not read. */
  readonly current: { readonly value: object; readonly text: string } | undefined;
}

/** Reads a JSON settings file, unless `sync` has nothing to do with it. */
async function readSettingsFile(
  files: WorkspaceFiles,
  path: string,
  needed: boolean,
  schema?: Parameters<typeof parseSettings>[2],
): Promise<{ value: object; text: string } | undefined | AgentPluggedError> {
  if (!needed || !(await files.exists(path))) return undefined;
  const text = await files.readText(path);
  const value = parseSettings(text, path, schema);
  return value instanceof AgentPluggedError ? value : { value, text };
}

/**
 * Our `deny` rules merged into a JSON settings file. A tool no longer targeted (`rules` empty)
 * gets its rules removed, and the file is deleted when nothing else was in it. Returns the rules
 * owned after this run.
 */
function planSettings(
  plan: SyncPlan,
  file: SettingsFile,
  rules: PermissionLists,
  previouslyOurs: PermissionLists,
  previous: SettingsRecord | undefined,
  /** Claude Code's settings: our hooks of untrusted content, undefined to remove. */
  hooks?: { readonly value: TrustHooks | undefined },
): { owned: Record<PermissionList, string[]>; record: SettingsRecord | undefined } {
  const { path, group, flavor, current } = file;
  const targeted = (rules.deny?.length ?? 0) > 0;
  const hadOurs = Object.values(previouslyOurs).some((list) => (list?.length ?? 0) > 0);
  if (!targeted && (current === undefined || (!hadOurs && !previous))) {
    return { owned: { deny: [], allow: [], ask: [] }, record: undefined };
  }
  const value = current?.value as Parameters<typeof mergeSettings>[0];
  // Our hooks leave before the file may be deleted; they are added once the rules are merged.
  const before =
    hooks !== undefined && !targeted && value !== undefined
      ? withTrustHooks(value, undefined)
      : value;
  const outcome = reconcileSettings(before, rules, previouslyOurs, flavor, previous);
  const owned = ownedRules(value, rules, previouslyOurs);
  const merged =
    hooks !== undefined && targeted && outcome.settings !== undefined
      ? withTrustHooks(outcome.settings, hooks.value)
      : outcome.settings;
  if (merged === undefined) {
    plan.add(path, "deleted", group, { kind: "remove", path });
  } else if (current === undefined) {
    plan.add(path, "created", group, { kind: "write", path, content: renderSettings(merged) });
  } else if (JSON.stringify(merged) === JSON.stringify(current.value)) {
    plan.add(path, "unchanged", group);
  } else {
    const content = renderSettings(merged, current.text);
    plan.add(path, "updated", group, { kind: "write", path, content });
  }
  return { owned, record: outcome.record };
}

export const syncCommand = defineCommand<SyncResult>({
  name: "sync",
  /**
   * Generates the files of the targeted AI tools (the `tools` list of `method.yaml`) from
   * `.agentplugged/agents/` and `.agentplugged/skills/`.
   */
  async run(
    { files, tools: probe, method, platform, mainBranch, projectRoot, extensionServers },
    options,
  ) {
    if (!(await files.exists(METHOD_CONFIG_PATH))) return fail(methodNotInstalled());
    // The cleanup of the retired Gemini CLI's files: it writes nothing else.
    if (options.clean_gemini === true) {
      return ok(await cleanLegacyGemini(files, options.yes === true));
    }
    const loaded = await loadMethodConfig(files);
    if (loaded instanceof AgentPluggedError) return fail(loaded);
    const definitions = await loadDefinitions(files);
    if (definitions instanceof AgentPluggedError) return fail(definitions);
    // Customisations are validated against every agent, active or not, before anything is written.
    const shipped = await definitionFolders(method, "agents");
    const overrides = await loadOverrides(files, definitions, shipped);
    if (overrides instanceof AgentPluggedError) return fail(overrides);
    // The same for the skills' customisations: the product's layer is rendered, the
    // personal one is only checked (generated files are shared through Git).
    const skillOverrides = await loadSkillOverrides(
      files,
      definitions,
      await definitionFolders(method, "skills"),
    );
    if (skillOverrides instanceof AgentPluggedError) return fail(skillOverrides);
    // No menu of an active agent may call a skill the creator disabled.
    const active = activeDefinitions(definitions, loaded.config);
    const deadRow = checkActiveMenus(active, overrides);
    if (deadRow !== undefined) return fail(deadRow);

    // The model table, with the creator's values of `method.yaml`.
    const table = await loadModelTable(files, method);
    if (table instanceof AgentPluggedError) return fail(table);
    const models = effectiveTable(table, loaded.config.models);

    const tools = await targetedTools(loaded.config, () => detectTools(probe));
    const has = (tool: ToolId) => tools.includes(tool);
    const manifest = await loadManifest(files);
    const previousCursor = manifest.cursor_permissions ?? [];
    // The permission rules in force: those of the main branch, locks applied.
    const resolvedRules = await resolveRules(loaded.config, mainBranch);
    // The validation level: at `strict` Codex keeps asking for approval.
    const validation = await resolveValidationSettings(loaded.config, mainBranch);

    // Settings are read (and refused when unreadable) before anything is written.
    const claudeSettings = await readSettingsFile(
      files,
      CLAUDE_SETTINGS_PATH,
      has("claude-code") ||
        manifest.permissions.length > 0 ||
        manifest.settings?.[CLAUDE_SETTINGS_PATH] !== undefined,
    );
    if (claudeSettings instanceof AgentPluggedError) return fail(claudeSettings);
    const cursorSettings = await readSettingsFile(
      files,
      CURSOR_CLI_PATH,
      has("cursor") ||
        previousCursor.length > 0 ||
        manifest.settings?.[CURSOR_CLI_PATH] !== undefined,
      CursorCliConfigSchema,
    );
    if (cursorSettings instanceof AgentPluggedError) return fail(cursorSettings);
    // The MCP files of the tools (`mcpServers`), read and refused when unreadable, before any write.
    const mcpFiles = new Map<string, { value: Record<string, unknown>; text: string }>();
    for (const file of MCP_JSON_FILES) {
      const needed =
        (has(file.tool) && file.legacy !== true) || manifest.settings?.[file.path] !== undefined;
      if (!needed || !(await files.exists(file.path))) continue;
      const text = await files.readText(file.path);
      const value = parseMcpFile(text, file.path, file.existingOnly);
      if (value instanceof AgentPluggedError) return fail(value);
      mcpFiles.set(file.path, { value, text });
    }

    // Instruction files import the constitution: it must exist (init writes it).
    const { target: constitution, rootAgents } = await constitutionTarget(files);
    if (!(await files.exists(constitution))) {
      return fail(
        new AgentPluggedError(ErrorCode.CONSTITUTION_MISSING, "error.constitution_missing", {
          path: constitution,
        }),
      );
    }
    const constitutionText = await files.readText(constitution);
    const sameAsConstitution = (text: string) => {
      const normalized = normalizeText(text);
      if (isGenerated(constitutionText) && normalizeText(constitutionText) === normalized) {
        return "constitution" as const;
      }
      const others = [constitutionText, rootAgents];
      return others.some((other) => other !== undefined && normalizeText(other) === normalized)
        ? ("root-agents" as const)
        : undefined;
    };

    const plan = new SyncPlan(files, manifest.files);

    // A `method.yaml` without `tools` gets the detected list once, so every later sync (and every
    // teammate) targets the same tools.
    if (loaded.config.tools === undefined) {
      const content = writeTools(loaded.text, tools);
      if (content instanceof AgentPluggedError) return fail(content);
      plan.add(METHOD_CONFIG_PATH, "updated", "shared", {
        kind: "write",
        path: METHOD_CONFIG_PATH,
        content,
      });
    }
    const settings = loaded.config.agents?.settings ?? {};
    // A key that names no installed agent (a typo, a skill, a deleted agent) is ignored, and said.
    const installedAgents = new Set(
      definitions.filter((d) => d.kind === "agent").map((d) => d.name),
    );
    for (const id of Object.keys(settings)) {
      if (!installedAgents.has(id)) plan.warn("unknown_setting", METHOD_CONFIG_PATH, id);
    }
    const agents = new Map<string, ResolvedAgent>();
    const preferredTools: PreferredTool[] = [];
    for (const definition of active) {
      if (definition.kind !== "agent") continue;
      const resolved = resolveAgent(
        definition,
        overrides.get(definition.name),
        Object.hasOwn(settings, definition.name) ? settings[definition.name] : undefined,
      );
      agents.set(definition.name, resolved);
      if (resolved.preferredToolOmitted === true) {
        plan.warn("description_too_long", `${definition.dir}/${SKILL_FILE}`, definition.name);
      }
      if (resolved.preferredTool !== undefined) {
        preferredTools.push({
          id: definition.name,
          name: resolved.agent.name,
          tool: resolved.preferredTool,
          targeted: has(resolved.preferredTool),
        });
      }
    }
    // The pinned engine through npx (`cmd /c` on Windows), or the creator's `mcp` of method.yaml.
    const launch = mcpLaunch(loaded.config.engine_version, {
      platform,
      ...(loaded.config.mcp === undefined ? {} : { override: loaded.config.mcp }),
    });
    // The engine as a shell runs it on this machine: the same launcher as the MCP
    // configuration, written wherever the method says `npx agentplugged`.
    const engine = engineCommand(launch);
    if (engineWords(launch).some(isAbsolutePath)) plan.warn("local_engine", METHOD_CONFIG_PATH);
    // The retired Gemini CLI: what it left is read, never written or removed here; said once.
    if (
      Object.hasOwn(table, LEGACY_GEMINI_CLIENT) ||
      Object.hasOwn(loaded.config.models ?? {}, LEGACY_GEMINI_CLIENT) ||
      (await hasLegacyGeminiFiles(files))
    ) {
      plan.warn("gemini_legacy", ".gemini");
    }
    const worktreesFolder = projectRoot === undefined ? undefined : worktreesFolderOf(projectRoot);
    const input: RenderInput = {
      source: files,
      definitions: active,
      agents,
      skillSections: skillSections(skillOverrides),
      constitution,
      models,
      mcpLaunch: launch,
      engineCommand: engine,
      ...(extensionServers === undefined ? {} : { extensionServers }),
      codexRules: {
        ...codexRuleSettings(resolvedRules.rules, validation.mode === "strict"),
        // Codex writes only in the project: the stories' working copies sit next to it.
        ...(worktreesFolder === undefined ? {} : { writableRoots: [worktreesFolder] }),
      },
    };

    const targets: Target[] = [];
    if (has("claude-code")) targets.push(...(await renderClaudeCode(input)));
    if (has("codex") || has("antigravity") || has("cursor")) {
      targets.push(...(await renderSharedSkills(input)));
    }
    if (has("codex")) targets.push(...renderCodex(input));
    if (has("antigravity")) targets.push(...renderAntigravity(input));
    if (has("cursor")) targets.push(...renderCursor(input));

    const produced = new Set<string>();
    const owned = new Map<string, boolean>();
    const planRendered = async (rendered: Target) => {
      // Markdown only: a Codex agent (TOML) is localised where its body is rendered.
      const target =
        typeof rendered.content === "string" && /.(md|mdc)$/i.test(rendered.path)
          ? { ...rendered, content: withEngineCommand(rendered.content, engine) }
          : rendered;
      produced.add(target.path);
      if (target.folder !== undefined) {
        let mine = owned.get(target.folder);
        if (mine === undefined) {
          mine =
            target.folder === ANTIGRAVITY_PLUGIN_DIR
              ? await ownsPluginFolder(files, target.folder, manifest.files)
              : await ownsSkillFolder(files, target.folder, manifest.files);
          owned.set(target.folder, mine);
          if (!mine) plan.warn("conflict", `${target.folder}/`);
        }
        if (!mine) return;
      }
      await plan.target(target);
    };
    for (const rendered of targets) await planRendered(rendered);

    // The `agentplugged` MCP server, declared in each targeted tool's MCP file with the pinned
    // engine version; an `agentplugged` server of the creator's is a conflict, left as is.
    const mcpConflicts = new Map<ClientId, string>();
    const settingsRecords: Record<string, SettingsRecord> = {};
    for (const file of MCP_JSON_FILES) {
      const targeted = has(file.tool) && file.legacy !== true;
      const previous = manifest.settings?.[file.path];
      if (!targeted && previous === undefined) continue;
      const current = mcpFiles.get(file.path);
      const outcome = reconcileMcpFile(
        file,
        current?.value,
        targeted,
        launch,
        previous,
        extensionServers ?? [],
      );
      if (outcome.record) settingsRecords[file.path] = outcome.record;
      if ((outcome.extraConflicts?.length ?? 0) > 0) plan.warn("conflict", file.path);
      if (outcome.conflict) {
        plan.warn("conflict", file.path);
        mcpConflicts.set(file.client, file.path);
      } else if (outcome.next === "same") {
        if (current !== undefined && targeted) plan.add(file.path, "unchanged", file.group);
      } else if (outcome.next === undefined) {
        plan.add(file.path, "deleted", file.group, { kind: "remove", path: file.path });
      } else {
        const content = renderMcpFile(outcome.next, current?.text);
        plan.add(file.path, current === undefined ? "created" : "updated", file.group, {
          kind: "write",
          path: file.path,
          content,
        });
      }
    }

    // The constitution, with the fallbacks of the targeted tools. The plugin of Antigravity CLI is
    // the creator's when its folder holds files that are not ours: nothing is written there, and what
    // the plugin brings is then a fallback.
    const antigravityPluginKept =
      has("antigravity") &&
      !(await ownsPluginFolder(files, ANTIGRAVITY_PLUGIN_DIR, manifest.files));
    if (has("antigravity")) {
      owned.set(ANTIGRAVITY_PLUGIN_DIR, !antigravityPluginKept);
      if (antigravityPluginKept) plan.warn("conflict", `${ANTIGRAVITY_PLUGIN_DIR}/`);
    }
    const codexConfigKept = plan.warnings.some(
      (warning) => warning.kind === "conflict" && warning.path === CODEX_CONFIG_PATH,
    );
    // Cursor's project hooks: `.cursor/hooks.json` is the creator's when it exists and
    // `sync` never wrote it (the manifest does not know it): then it is kept, with a warning.
    const cursorHooksKept =
      has("cursor") &&
      manifest.files[CURSOR_HOOKS_PATH] === undefined &&
      (await files.exists(CURSOR_HOOKS_PATH));
    if (cursorHooksKept) plan.warn("conflict", CURSOR_HOOKS_PATH);
    const fallbacks = fallbacksFor(tools, {
      codexConfigKept,
      cursorHooksKept,
      modelInherit: inheritClients(models),
      mcpConflicts,
      antigravityPluginKept,
    });
    // Noah's section: only while Noah is installed and active.
    const noah = active.some((d) => d.kind === "agent" && d.name === NOAH_AGENT);
    await plan.target({
      path: constitution,
      content: withEngineCommand(
        renderConstitution(fallbacks, resolvedRules.rules, noah ? { tools } : undefined),
        engine,
      ),
      group: "shared",
    });
    // The detail of the constitution, read on demand (corrections B), one file per
    // section.
    const referenceFiles = renderConstitutionReferenceFiles(
      fallbacks,
      resolvedRules.rules,
      noah ? { tools } : undefined,
    );
    for (const file of referenceFiles) {
      await plan.target({
        path: file.path,
        content: withEngineCommand(file.content, engine),
        group: "shared",
      });
    }
    // The reference of the older engine was one file; and a section that is no longer written
    // leaves its file behind. Generated ones go (by their header); one the creator took stays.
    const wanted = new Set(referenceFiles.map((file) => file.path));
    const stale = [
      REFERENCE_LEGACY_PATH,
      ...(await files.listFiles(REFERENCE_DIR)).filter((path) => !wanted.has(path)),
    ];
    for (const path of stale) {
      if (!(await files.exists(path))) continue;
      const text = normalizeText(await files.readText(path));
      // Generated, and as sync wrote it (when the manifest knows it): it goes. Changed by hand, or
      // taken by the creator: it stays, and the old file is said once.
      const recorded = manifest.files[path];
      const ours = isGenerated(text) && (recorded === undefined || recorded === sha256Hex(text));
      if (ours) plan.add(path, "deleted", "shared", { kind: "remove", path });
      else if (path === REFERENCE_LEGACY_PATH || isGenerated(text)) plan.warn("kept", path);
    }

    // CLAUDE.md and GEMINI.md import the constitution.
    let claudeMdGenerated = false;
    if (has("claude-code")) {
      produced.add(CLAUDE_MD_PATH);
      // Claude Code reads the root AGENTS.md only while no CLAUDE.md exists: when that file is
      // the creator's (the constitution then lives in `.agentplugged/`), the generated CLAUDE.md
      // imports it too, so creating CLAUDE.md never makes Claude Code lose it.
      const creatorsAgents =
        constitution === METHOD_CONSTITUTION_PATH && rootAgents !== undefined
          ? [ROOT_CONSTITUTION_PATH]
          : [];
      claudeMdGenerated = await planImportFile(
        plan,
        CLAUDE_MD_PATH,
        "claude-code",
        constitution,
        sameAsConstitution,
        creatorsAgents,
      );
    }
    let geminiMdGenerated = false;
    if (has("antigravity")) {
      produced.add(GEMINI_MD_PATH);
      geminiMdGenerated = await planImportFile(
        plan,
        GEMINI_MD_PATH,
        "antigravity",
        constitution,
        sameAsConstitution,
      );
    }

    // The permission profiles' inputs: `.claude/settings.json` and `.cursor/cli.json` (below), and
    // Antigravity's plugin, which has no settings file to hold them.
    const permissionInputs = {
      rootAgentsGenerated: rootAgents !== undefined && isGenerated(rootAgents),
      claudeMdGenerated,
      geminiMdGenerated,
      generatedRoots: rootsOf(tools),
      mcpConfigGenerated: has("claude-code") && !mcpConflicts.has("claude-code"),
    };
    // The permission rules join the protections.
    const { rules: ruleTable, mainBranch: resolvedMain } = resolvedRules;
    // The branches of the creator's workflow are guarded like the main branch (an agent
    // never pushes the integration branch: the engine does, once the creator approved).
    const mainName =
      [...new Set([resolvedMain, loaded.config.git?.integration, loaded.config.git?.production])]
        .filter((name): name is string => name !== undefined)
        .join("\n") || undefined;
    const claudeRules = claudeRulePermissions(ruleTable, mainName);
    const cursorRules = cursorRulePermissions(
      ruleTable,
      mainName,
      has("cursor") && !cursorHooksKept,
    );
    // Antigravity CLI's plugin: the MCP server and the hooks it reads from a plugin
    // only. Its hook applies the lists written for Claude Code, from the same functions.
    if (has("antigravity")) {
      const policy: AntigravityPolicy = {
        version: 1,
        rules: ruleTable,
        ...(mainName === undefined ? {} : { main_branch: mainName }),
        deny: unique([...denyRules(permissionInputs), ...claudeRules.deny]),
        ask: claudeRules.ask,
      };
      for (const rendered of renderAntigravityPlugin(input, policy)) await planRendered(rendered);
    }

    // Codex's hooks and rules: the script, the policy it and the engine's hook read, and
    // the rules of commands Codex applies itself. The permission lists are Claude Code's, and Codex's
    // own folder is protected on top of them.
    if (has("codex")) {
      const policy: AntigravityPolicy = {
        version: 1,
        rules: ruleTable,
        ...(mainName === undefined ? {} : { main_branch: mainName }),
        deny: unique([...denyRules(permissionInputs), ...claudeRules.deny, ...CODEX_HOME_DENY]),
        ask: claudeRules.ask,
      };
      for (const rendered of renderCodexGuard(input, policy, !codexConfigKept)) {
        await planRendered(rendered);
      }
    }

    // Cursor's hooks: the script, the policy it and the engine's hook read, and
    // `.cursor/hooks.json`. The permission lists are Claude Code's, and Cursor's own settings in the
    // home folder are protected on top of them.
    if (has("cursor") && !cursorHooksKept) {
      const policy: AntigravityPolicy = {
        version: 1,
        rules: ruleTable,
        ...(mainName === undefined ? {} : { main_branch: mainName }),
        deny: unique([...denyRules(permissionInputs), ...claudeRules.deny, ...CURSOR_HOME_DENY]),
        ask: claudeRules.ask,
      };
      for (const rendered of renderCursorGuard(input, policy)) {
        await planRendered(rendered);
      }
    }

    // `.cursorignore`: the secrets, in a block of the creator's file; the block leaves with
    // the tool, and so does the file when nothing else was in it.
    {
      const current = (await files.exists(CURSOR_IGNORE_PATH))
        ? await files.readText(CURSOR_IGNORE_PATH)
        : undefined;
      if (has("cursor")) {
        const next = withCursorIgnoreBlock(current);
        if (current === undefined) {
          plan.add(CURSOR_IGNORE_PATH, "created", "cursor", {
            kind: "write",
            path: CURSOR_IGNORE_PATH,
            content: next,
          });
        } else if (next === current) plan.add(CURSOR_IGNORE_PATH, "unchanged", "cursor");
        else {
          plan.add(CURSOR_IGNORE_PATH, "updated", "cursor", {
            kind: "write",
            path: CURSOR_IGNORE_PATH,
            content: next,
          });
        }
      } else if (current !== undefined) {
        const without = withoutCursorIgnoreBlock(current);
        if (without === undefined) {
          plan.add(CURSOR_IGNORE_PATH, "deleted", "cursor", {
            kind: "remove",
            path: CURSOR_IGNORE_PATH,
          });
        } else if (without !== current) {
          plan.add(CURSOR_IGNORE_PATH, "updated", "cursor", {
            kind: "write",
            path: CURSOR_IGNORE_PATH,
            content: without,
          });
        }
      }
    }

    // A tool left the list: the creator's CLAUDE.md or GEMINI.md loses our import block.
    for (const [path, tool, group] of [
      [CLAUDE_MD_PATH, "claude-code", "claude-code"],
      [GEMINI_MD_PATH, "antigravity", "antigravity"],
    ] as const) {
      if (has(tool) || !(await files.exists(path))) continue;
      const current = await files.readText(path);
      if (isGenerated(current)) continue;
      const without = removePointerBlock(current);
      if (without !== undefined)
        plan.add(path, "updated", group, { kind: "write", path, content: without });
    }

    // Generated files whose source is gone, whose agent became inactive or whose tool left the
    // list. Only paths sync can generate are considered; a file the creator changed or took is
    // kept and reported.
    for (const [path, recorded] of Object.entries(manifest.files).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (!isGeneratedPath(path)) continue;
      if (produced.has(path) || !(await files.exists(path))) continue;
      if (isLegacyGeminiAgent(path)) {
        // Written for the retired Gemini CLI: never deleted by `sync`, and its hash is kept so the
        // cleanup can still prove the file is as `sync` wrote it.
        plan.hashes[path] = recorded;
        continue;
      }
      const folder = skillFolderOf(path);
      if (folder !== undefined && !path.endsWith(`/${SKILL_FILE}`)) {
        const skill = `${folder}/${SKILL_FILE}`;
        if ((await files.exists(skill)) && !isGenerated(await files.readText(skill))) {
          plan.warn("kept", path);
          continue;
        }
      }
      let currentHash: string;
      const header = headerOf(path);
      if (header !== undefined) {
        const text = normalizeText(await files.readText(path));
        if (!isGenerated(text, header)) {
          plan.warn("kept", path);
          continue;
        }
        currentHash = sha256Hex(text);
      } else if (isHeaderlessJson(path)) {
        // The plugin's JSON: text without a header, kept by its hash as it was written.
        currentHash = sha256Hex(normalizeText(await files.readText(path)));
      } else {
        currentHash = sha256Hex(await files.readBytes(path));
      }
      if (currentHash !== recorded) {
        plan.warn("kept", path);
        continue;
      }
      plan.add(path, "deleted", groupOf(path), { kind: "remove", path });
    }

    const previousLists = manifest.permission_lists ?? {};
    const claude = planSettings(
      plan,
      {
        path: CLAUDE_SETTINGS_PATH,
        group: "claude-code",
        flavor: claudeFlavor(loaded.config.permissions?.mode),
        current: claudeSettings,
      },
      has("claude-code")
        ? {
            deny: claudeCommandRules(unique([...denyRules(permissionInputs), ...claudeRules.deny])),
            allow: claudeCommandRules(claudeRules.allow),
            ask: claudeCommandRules(claudeRules.ask),
          }
        : {},
      { deny: manifest.permissions, ...previousLists[CLAUDE_SETTINGS_PATH] },
      manifest.settings?.[CLAUDE_SETTINGS_PATH],
      // The hooks of untrusted content: written while Claude Code is targeted.
      { value: has("claude-code") ? claudeTrustHooks(ruleTable, mainName) : undefined },
    );
    const cursor = planSettings(
      plan,
      { path: CURSOR_CLI_PATH, group: "cursor", flavor: CURSOR_FLAVOR, current: cursorSettings },
      has("cursor")
        ? {
            deny: unique([...cursorDenyRules(permissionInputs), ...cursorRules.deny]),
            allow: cursorRules.allow,
          }
        : {},
      { deny: previousCursor, ...previousLists[CURSOR_CLI_PATH] },
      manifest.settings?.[CURSOR_CLI_PATH],
    );
    if (claude.record) settingsRecords[CLAUDE_SETTINGS_PATH] = claude.record;
    // What `sync` added to the retired Gemini CLI's settings stays recorded until the cleanup.
    const geminiRecord = manifest.settings?.[GEMINI_SETTINGS_PATH];
    if (geminiRecord !== undefined) settingsRecords[GEMINI_SETTINGS_PATH] = geminiRecord;
    if (cursor.record) settingsRecords[CURSOR_CLI_PATH] = cursor.record;
    const permissionLists: Record<string, { allow?: string[]; ask?: string[] }> = {};
    const allowAdded: Array<{ path: string; count: number }> = [];
    for (const [path, owned] of [
      [CLAUDE_SETTINGS_PATH, claude.owned],
      [CURSOR_CLI_PATH, cursor.owned],
    ] as const) {
      const lists = {
        ...(owned.allow.length > 0 ? { allow: owned.allow } : {}),
        ...(owned.ask.length > 0 ? { ask: owned.ask } : {}),
      };
      if (Object.keys(lists).length > 0) permissionLists[path] = lists;
      // The first `allow` rules sync writes in this file: agents now act without asking.
      if (owned.allow.length > 0 && (previousLists[path]?.allow?.length ?? 0) === 0) {
        allowAdded.push({ path, count: owned.allow.length });
      }
    }
    const conflicts = [
      ...(has("claude-code")
        ? allowConflicts(
            CLAUDE_SETTINGS_PATH,
            claudeSettings?.value,
            claudeCommandRules(claudeRules.allow),
            { deny: manifest.permissions, ...previousLists[CLAUDE_SETTINGS_PATH] },
          )
        : []),
      ...(has("cursor")
        ? allowConflicts(CURSOR_CLI_PATH, cursorSettings?.value, cursorRules.allow, {
            deny: previousCursor,
          })
        : []),
    ];

    await plan.apply();
    await pruneEmptyFolders(files, plan.removed, tools);

    const next = renderManifest({
      format_version: 1,
      files: plan.hashes,
      permissions: claude.owned.deny,
      ...(cursor.owned.deny.length > 0 ? { cursor_permissions: cursor.owned.deny } : {}),
      ...(Object.keys(settingsRecords).length > 0
        ? {
            settings: Object.fromEntries(
              Object.entries(settingsRecords).map(([path, record]) => [
                path,
                { created: record.created, keys: [...record.keys] },
              ]),
            ),
          }
        : {}),
      // What these files were generated from, read after the writes (`tools` may be added).
      inputs: await syncInputsFingerprint(files),
      ...(Object.keys(permissionLists).length > 0 ? { permission_lists: permissionLists } : {}),
    });
    const previousManifest = (await files.exists(SYNC_MANIFEST_PATH))
      ? await files.readText(SYNC_MANIFEST_PATH)
      : undefined;
    if (previousManifest !== next) await files.writeText(SYNC_MANIFEST_PATH, next);

    const codexTrustReminder = plan.entries.some(
      (entry) =>
        entry.path === CODEX_CONFIG_PATH &&
        (entry.action === "created" || entry.action === "updated"),
    );
    const cursorHooksReminder = plan.entries.some(
      (entry) =>
        entry.path === CURSOR_HOOKS_PATH &&
        (entry.action === "created" || entry.action === "updated"),
    );
    return ok({
      entries: plan.entries,
      warnings: plan.warnings,
      tools,
      fallbacks,
      codexTrustReminder,
      cursorHooksReminder,
      preferredTools,
      rules: {
        source: resolvedRules.source,
        warnings: resolvedRules.warnings,
        cursorAskedAsDeny: has("cursor") ? cursorRules.askedAsDeny : [],
        allowAdded,
        conflicts,
      },
    });
  },
});

/**
 * A JSON file that has no header: Antigravity's plugin files, Codex's policy and Cursor's hooks and
 * policy (text, kept by its hash).
 */
function isHeaderlessJson(path: string): boolean {
  return (
    (path.startsWith(`${ANTIGRAVITY_PLUGIN_DIR}/`) && path.endsWith(".json")) ||
    path === CODEX_POLICY_PATH ||
    path === CURSOR_HOOKS_PATH ||
    path === CURSOR_POLICY_PATH
  );
}

/**
 * Cursor's own settings in the home folder, and what it keeps of the conversations: an agent never
 * writes them (they hold hooks, rules, a login, the transcripts the proof of the chat is checked
 * against).
 */
const CURSOR_HOME_DENY = [
  "Edit(~/.cursor/hooks.json)",
  "Edit(~/.cursor/hooks/**)",
  "Edit(~/.cursor/cli-config.json)",
  "Edit(~/.cursor/mcp.json)",
  "Edit(~/.cursor/projects/**)",
  "Edit(~/.cursor/chats/**)",
];

/** Codex's own settings in the home folder: an agent never writes them (they hold hooks, rules, a login). */
const CODEX_HOME_DENY = [
  "Edit(~/.codex/config.toml)",
  "Edit(~/.codex/hooks.json)",
  "Edit(~/.codex/hooks/**)",
  "Edit(~/.codex/rules/**)",
];

function unique(rules: readonly string[]): string[] {
  return [...new Set(rules)];
}

/** The tool a generated path belongs to, for the summary. */
function groupOf(path: string): TargetGroup {
  if (path.startsWith(".claude/") || path === CLAUDE_MD_PATH) return "claude-code";
  if (path.startsWith(".codex/")) return "codex";
  if (
    path.startsWith(".gemini/") ||
    path.startsWith(".agents/agents/") ||
    path.startsWith(`${ANTIGRAVITY_PLUGIN_DIR}/`)
  ) {
    return "antigravity";
  }
  if (path === GEMINI_MD_PATH) return "antigravity";
  if (path.startsWith(".cursor/")) return "cursor";
  return "shared";
}
