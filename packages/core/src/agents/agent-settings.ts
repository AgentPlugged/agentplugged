import {
  type AgentSettings,
  MODEL_TIERS,
  type ModelTier,
  TOOL_IDS,
  type ToolId,
} from "@agentplugged/protocol";
import { isMap, parseDocument } from "yaml";
import { AgentPluggedError } from "../errors.js";
import { editedMethodText } from "../init/method-config.js";
import { invalidArgument } from "./create-fields.js";

/** `agent edit --tier default`: the tier of the agent's customisation or definition again. */
export const TIER_DEFAULT = "default";
/** `agent edit --tool none`: no preferred tool. */
export const TOOL_NONE = "none";

/** What `agent edit --tier/--tool` changes: a value to record, or `null` to remove it. */
export interface SettingsChange {
  readonly model_tier?: ModelTier | null;
  readonly tool?: ToolId | null;
}

/** Keys of `agents.settings.<id>`, in the order they are written. */
export const SETTINGS_KEYS = ["model_tier", "tool"] as const;

function choice<T extends string>(
  option: "tier" | "tool",
  value: unknown,
  values: readonly T[],
  reset: string,
): T | null | AgentPluggedError {
  if (value === reset) return null;
  if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as T;
  return invalidArgument("error.agent.invalid_choice", {
    option,
    value: String(value),
    values: [...values, reset].join(", "),
  });
}

/**
 * `tier` and `tool` of `agent edit`, checked before anything is read or written. Undefined when
 * neither is given.
 */
export function settingsChange(
  input: Readonly<Record<string, unknown>>,
): SettingsChange | AgentPluggedError | undefined {
  const { tier, tool } = input;
  if (tier === undefined && tool === undefined) return undefined;
  const change: { model_tier?: ModelTier | null; tool?: ToolId | null } = {};
  if (tier !== undefined) {
    const value = choice("tier", tier, MODEL_TIERS, TIER_DEFAULT);
    if (value instanceof AgentPluggedError) return value;
    change.model_tier = value;
  }
  if (tool !== undefined) {
    const value = choice("tool", tool, TOOL_IDS, TOOL_NONE);
    if (value instanceof AgentPluggedError) return value;
    change.tool = value;
  }
  return change;
}

/** Settings after a change: `null` removes a key, `undefined` keeps it. */
export function changedSettings(current: AgentSettings, change: SettingsChange): AgentSettings {
  const next: { model_tier?: ModelTier; tool?: ToolId } = { ...current };
  if (change.model_tier === null) delete next.model_tier;
  else if (change.model_tier !== undefined) next.model_tier = change.model_tier;
  if (change.tool === null) delete next.tool;
  else if (change.tool !== undefined) next.tool = change.tool;
  return next;
}

/**
 * Writes `agents.settings.<id>` into the text of `method.yaml`, keeping comments, other keys and
 * line endings. Empty settings are removed, then an empty `settings`, then an empty `agents`.
 */
export function writeAgentSettings(
  text: string,
  id: string,
  settings: AgentSettings,
): string | AgentPluggedError {
  const document = parseDocument(text);
  for (const key of SETTINGS_KEYS) {
    const value = settings[key];
    const path = ["agents", "settings", id, key];
    if (value !== undefined) document.setIn(path, value);
    else if (document.hasIn(path)) document.deleteIn(path);
  }
  for (const path of [["agents", "settings", id], ["agents", "settings"], ["agents"]]) {
    const node = document.getIn(path, true);
    if (isMap(node) && node.items.length === 0) document.deleteIn(path);
  }
  // No refolding and no padding in flow lists: untouched lines stay as the creator wrote them.
  return editedMethodText(document, text, true);
}
