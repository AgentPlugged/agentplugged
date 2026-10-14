import { type DetectedTool, toolName, toolsFromDetection } from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  type PermissionMode,
  TOOL_IDS,
  type ToolId,
} from "@agentplugged/protocol";
import type { MenuOption } from "./menu.js";
import { chooseMany, chooseValue, type Prompter } from "./prompt.js";

/**
 * The questions `init` adds to the profile's: the AI tools to wire in, what their
 * permissions look like, and the sentence that ends the installation. Every question has a
 * recommended answer, which Enter gives.
 */

/** What the machine says of a tool, in a few words: found (and where), or not found. */
function toolHint(t: Translate, tool: DetectedTool | undefined): string {
  if (tool === undefined || !tool.found) return t("init.tools.hint.missing");
  if (tool.offPath !== undefined) return t("init.tools.hint.off_path", { dir: tool.offPath });
  return tool.version === undefined
    ? t("init.tools.hint.found")
    : t("init.tools.hint.found_version", { version: tool.version });
}

/**
 * Asks the AI tools to target: those found on the machine are ticked (all of them when none is,
 * the method works anyway), including one whose folder is not on the PATH.
 */
export async function chooseTools(
  t: Translate,
  prompter: Prompter,
  detected: readonly DetectedTool[],
  current?: readonly ToolId[],
): Promise<ToolId[]> {
  const initial = current ?? toolsFromDetection(detected);
  const picked = await chooseMany(t, prompter, {
    title: t("init.tools.title"),
    options: TOOL_IDS.map(
      (id): MenuOption => ({
        label: detected.find((tool) => tool.id === id)?.name ?? toolName(id),
        hint: toolHint(
          t,
          detected.find((tool) => tool.id === id),
        ),
      }),
    ),
    question: (fallback) => t("init.tools.prompt", { default: fallback }),
    fallback: TOOL_IDS.flatMap((id, index) => (initial.includes(id) ? [index] : [])),
  });
  return picked.flatMap((index) => TOOL_IDS[index] ?? []);
}

/**
 * Asks what the AI tool asks before it acts: protected by default; the mode that removes its
 * questions is offered with what it leaves without a guard.
 */
export const choosePermissionMode = (
  t: Translate,
  prompter: Prompter,
  current: PermissionMode | undefined,
): Promise<PermissionMode> =>
  chooseValue(t, prompter, {
    title: t("permissions.title"),
    values: PERMISSION_MODES,
    option: (mode) => ({
      label: t(`permissions.mode.${mode}`),
      hint: t(`permissions.mode.${mode}.description`),
    }),
    question: (fallback) => t("permissions.prompt", { default: fallback }),
    current,
    fallback: DEFAULT_PERMISSION_MODE,
  });

/** The permission mode line. */
export function formatPermissionMode(t: Translate, mode: PermissionMode): string {
  return `${t(`permissions.summary.${mode}`)}\n`;
}

/**
 * The sentence that ends the installation: what to do next, for the tools chosen. Once `sync` has
 * run, open the tool and write « noah ? »; otherwise `sync` first.
 */
export function formatNextStep(t: Translate, tools: readonly ToolId[], synced: boolean): string {
  const names = tools.map(toolName);
  const key = synced
    ? names.length === 1
      ? "init.done.noah"
      : "init.done.noah.several"
    : names.length === 1
      ? "init.done.sync_first"
      : "init.done.sync_first.several";
  return `${t(key, { tool: names[0] ?? "", tools: names.join(", ") })}\n`;
}
