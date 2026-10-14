import {
  type AgentDefinition,
  type AgentOverride,
  AgentOverrideSchema,
  ErrorCode,
  type ModelTier,
  menuKey,
} from "@agentplugged/protocol";
import { stringify } from "yaml";
import { AgentPluggedError, reasonDetails } from "../errors.js";
import { normalizeText } from "../init/generated.js";
import { METHOD_DIR } from "../init/layout.js";
import { ROOT_FIELD } from "../init/method-config.js";
import {
  AGENT_FILE,
  type Definition,
  definitionInvalid,
  parseYaml,
  type SafeParser,
} from "../method/definitions.js";
import { orphanReason } from "../sync/developers.js";
import type { WorkspaceFiles } from "../workspace-files.js";

/** Customisations of agents, one file per agent: `<id>.yaml`. `init` never touches them. */
export const AGENT_OVERRIDES_DIR = `${METHOD_DIR}/overrides/agents`;

const OVERRIDE_EXTENSION = ".yaml";

export function overridePath(id: string): string {
  return `${AGENT_OVERRIDES_DIR}/${id}${OVERRIDE_EXTENSION}`;
}

export function overrideInvalid(
  path: string,
  field: string,
  reason: string,
  messageKey = "error.override_invalid",
  params: Record<string, unknown> = {},
): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.OVERRIDE_INVALID, messageKey, {
    path,
    field,
    ...reasonDetails(reason),
    ...params,
  });
}

/** Parses a customisation; a file holding only comments is an empty customisation. */
export function parseOverride(path: string, raw: string): AgentOverride | AgentPluggedError {
  const schema = AgentOverrideSchema as SafeParser<AgentOverride>;
  return parseYaml(path, normalizeText(raw), schema, (p, f, r) => overrideInvalid(p, f, r), {});
}

/**
 * Every customisation of `.agentplugged/overrides/agents/`, validated, by agent id. Refused: a
 * file that names no agent of `.agentplugged/agents/` (active or not), a file for one of the
 * creator's own agents (not in `shipped`: their files are edited directly), and a menu item calling an unknown skill. Files that are not `<id>.yaml`
 * directly in the folder (such as `.gitkeep`) are ignored.
 */
export async function loadOverrides(
  files: WorkspaceFiles,
  definitions: readonly Definition[],
  shipped: ReadonlySet<string>,
): Promise<Map<string, AgentOverride> | AgentPluggedError> {
  const agents = new Set(definitions.filter((d) => d.kind === "agent").map((d) => d.name));
  const skills = new Set(definitions.filter((d) => d.kind === "skill").map((d) => d.name));
  const overrides = new Map<string, AgentOverride>();
  for (const path of await files.listFiles(AGENT_OVERRIDES_DIR)) {
    const name = path.slice(AGENT_OVERRIDES_DIR.length + 1);
    if (name.includes("/") || !name.endsWith(OVERRIDE_EXTENSION)) continue;
    const id = name.slice(0, -OVERRIDE_EXTENSION.length);
    if (!agents.has(id)) {
      const reason = orphanReason(id);
      return overrideInvalid(path, ROOT_FIELD, reason, "error.override_orphan", { id });
    }
    if (!shipped.has(id)) {
      const reason = `"${id}" is the creator's own agent: edit its files directly`;
      return overrideInvalid(path, ROOT_FIELD, reason, "error.override_own_agent", { id });
    }
    const override = parseOverride(path, await files.readText(path));
    if (override instanceof AgentPluggedError) return override;
    for (const [index, item] of (override.menu ?? []).entries()) {
      if (item.skill !== undefined && !skills.has(item.skill)) {
        return overrideInvalid(
          path,
          `menu.${index}.skill`,
          `unknown skill "${item.skill}"`,
          "error.override_invalid",
          { reason_key: "reason.unknown_skill", skill: item.skill },
        );
      }
    }
    overrides.set(id, override);
  }
  return overrides;
}

/**
 * Every menu item of an active agent (its own items not replaced, then its customisation) calls an
 * active skill: a skill the creator disabled would leave a dead menu row. Checked before writing.
 */
export function checkActiveMenus(
  active: readonly Definition[],
  overrides: ReadonlyMap<string, AgentOverride>,
): AgentPluggedError | undefined {
  const skills = new Set(active.filter((d) => d.kind === "skill").map((d) => d.name));
  for (const definition of active) {
    const agent = definition.agent;
    if (definition.kind !== "agent" || agent === undefined) continue;
    const override = overrides.get(definition.name);
    const replaced = new Set((override?.menu ?? []).map((item) => menuKey(item.code)));
    for (const [index, item] of agent.menu.entries()) {
      if (item.skill === undefined || skills.has(item.skill) || replaced.has(menuKey(item.code))) {
        continue;
      }
      return definitionInvalid(
        `${definition.dir}/${AGENT_FILE}`,
        `menu.${index}.skill`,
        `skill "${item.skill}" is disabled`,
        "error.menu_skill_disabled",
        { skill: item.skill },
      );
    }
    for (const [index, item] of (override?.menu ?? []).entries()) {
      if (item.skill === undefined || skills.has(item.skill)) continue;
      return overrideInvalid(
        overridePath(definition.name),
        `menu.${index}.skill`,
        `skill "${item.skill}" is disabled`,
        "error.menu_skill_disabled",
        { skill: item.skill },
      );
    }
  }
  return undefined;
}

/**
 * The agent once its customisation is applied:
 * - a scalar of the customisation replaces the agent's own; `voice` is replaced whole;
 * - `menu`: an item with the code of an existing item replaces it, in place; a new code is added
 *   at the end;
 * - the other lists are added after the agent's own.
 * Applied at render time only, so running `sync` again never applies it twice.
 */
export function mergeAgent(base: AgentDefinition, override: AgentOverride): AgentDefinition {
  const menu = base.menu.map((item) => {
    const replacement = override.menu?.find((other) => menuKey(other.code) === menuKey(item.code));
    return replacement ?? item;
  });
  const known = new Set(base.menu.map((item) => menuKey(item.code)));
  for (const item of override.menu ?? []) {
    if (!known.has(menuKey(item.code))) menu.push(item);
  }
  return {
    ...base,
    ...(override.icon !== undefined ? { icon: override.icon } : {}),
    ...(override.role !== undefined ? { role: override.role } : {}),
    ...(override.identity !== undefined ? { identity: override.identity } : {}),
    ...(override.communication_style !== undefined
      ? { communication_style: override.communication_style }
      : {}),
    ...(override.voice !== undefined ? { voice: override.voice } : {}),
    principles: [...base.principles, ...(override.principles ?? [])],
    persistent_facts: [...base.persistent_facts, ...(override.persistent_facts ?? [])],
    activation_steps_prepend: [
      ...base.activation_steps_prepend,
      ...(override.activation_steps_prepend ?? []),
    ],
    activation_steps_append: [
      ...base.activation_steps_append,
      ...(override.activation_steps_append ?? []),
    ],
    menu,
  };
}

/** YAML of `value` under `key`, every line commented out. */
function commented(key: string, value: unknown): string {
  return stringify({ [key]: value }, { lineWidth: 96 })
    .trimEnd()
    .split("\n")
    .map((line) => `# ${line}`)
    .join("\n");
}

/**
 * The commented template of a customisation: every customisable field, commented out, with the
 * merge rules. Scalars show the agent's current value; lists show what an addition looks like,
 * and the menu shows how to replace the agent's first item.
 */
export function renderOverrideTemplate(
  id: string,
  agent: AgentDefinition,
  modelTier: ModelTier = "reasoning",
): string {
  const who = agent.name;
  const scalar = (key: "icon" | "role" | "identity" | "communication_style", example: string) =>
    commented(key, agent[key] ?? example);
  const first = agent.menu[0];
  const menuExample = first
    ? [{ ...first, description: `${first.description} (adjusted)` }]
    : [{ code: "EX", description: "A new menu item", prompt: "What the agent does." }];
  return `${[
    `# Customisation of ${who} (\`${id}\`) for this product, applied by \`npx agentplugged sync\`.`,
    `# \`init\` never touches this file, even when it updates ${who}: your changes survive updates.`,
    "# Uncomment the fields you want to change. Fields left commented keep their value.",
    "#",
    "# A customisation can replace or add, never remove: nothing of the agent can be deleted here.",
    "#",
    "# Merge rules, applied at every sync (never twice):",
    `# - icon, role, identity, communication_style: your value replaces ${who}'s own;`,
    `# - voice: your tone, pace and register replace ${who}'s voice whole;`,
    `# - menu: an item with the code of one of ${who}'s items replaces it, at its place;`,
    "#   an item with a new code is added at the end of the menu;",
    "# - principles, persistent_facts, activation_steps_prepend, activation_steps_append:",
    `#   your entries are added after ${who}'s own.`,
    `# \`name\` and \`title\` define ${who} and cannot be customised. The body of SKILL.md cannot`,
    "# be customised either.",
    "",
    scalar("icon", "🙂"),
    scalar("role", "What the agent is for."),
    scalar("identity", "Who the agent is."),
    scalar("communication_style", "How the agent speaks."),
    "",
    `# Model tier: reasoning, code, fast or multimodal. It replaces ${who}'s own; the tier set by`,
    `# \`npx agentplugged agent edit ${id} --tier <tier>\` (in method.yaml) wins over both.`,
    commented("model_tier", modelTier),
    "",
    commented("principles", ["A principle added after the agent's own."]),
    commented("persistent_facts", [
      "A fact about this product.",
      "file:.agentplugged/docs/facts.md",
    ]),
    commented("activation_steps_prepend", ["A step run before the agent's own steps."]),
    commented("activation_steps_append", ["A step run after the agent's own steps."]),
    "",
    commented("menu", menuExample),
    "",
    "# Voice of the agent for the spoken briefing, replaced whole: give tone, pace and register.",
    commented(
      "voice",
      agent.voice ?? { tone: "Warm and steady", pace: "Unhurried", register: "Plain, friendly" },
    ),
  ].join("\n")}\n`;
}
