import {
  type AgentCommandResult,
  type CreateField,
  DOMAIN_IDS,
  displayName,
  METHOD_CONFIG_PATH,
  PHASE_IDS,
  type SettingsOutcome,
  toolName,
  validateCreateField,
} from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";
import { errorMessage } from "./error-text.js";
import { askChoice, askText, type Prompter } from "./prompt.js";

/** Answers of `agent create`, from the options or the questions. */
export type CreateAnswers = { [field in CreateField]?: string | undefined };

function numbered(labels: readonly string[]): string {
  const width = String(labels.length).length;
  return labels.map((label, i) => `  ${String(i + 1).padStart(width)}. ${label}`).join("\n");
}

/**
 * Asks for what the options did not give, checking each answer as it is typed. An agent: display
 * name (defaults to the one derived from the id), title, description, icon, role, domain (from the
 * catalog) and phase. A skill: its description only.
 */
export async function askCreateAnswers(
  t: Translate,
  prompter: Prompter,
  kind: "agent" | "skill",
  id: string,
  given: CreateAnswers,
): Promise<CreateAnswers> {
  const answers: CreateAnswers = { ...given };
  const ask = async (
    field: CreateField,
    question: string,
    required: boolean,
    fallback?: string,
  ) => {
    if (answers[field] !== undefined) return;
    const check = (answer: string) => {
      const error = validateCreateField(field, answer);
      return error === undefined ? undefined : errorMessage(t, error);
    };
    answers[field] = await askText(t, prompter, question, {
      required,
      check,
      ...(fallback !== undefined ? { fallback } : {}),
    });
  };
  // One of a catalog, numbered; the first is what Enter gives.
  const pick = async <T extends string>(
    ids: readonly T[],
    title: string,
    labels: readonly string[],
    question: (fallback: string) => string,
  ): Promise<T | undefined> => {
    prompter.say(title);
    prompter.say(numbered(labels));
    return ids[await askChoice(t, prompter, question, ids.length, 0)];
  };
  if (kind === "skill") {
    await ask("description", t("agent.prompt.description"), true);
    return answers;
  }
  const name = displayName(id);
  await ask("name", t("agent.prompt.name", { default: name }), true, name);
  await ask("title", t("agent.prompt.title"), true);
  await ask("description", t("agent.prompt.description"), true);
  await ask("icon", t("agent.prompt.icon"), false);
  await ask("role", t("agent.prompt.role"), false);
  answers.domain ??= await pick(
    DOMAIN_IDS,
    t("agent.prompt.domain.title"),
    DOMAIN_IDS.map((domain) => t(`profile.domain.${domain}`)),
    (fallback) => t("agent.prompt.domain", { default: fallback }),
  );
  answers.phase ??= await pick(
    PHASE_IDS,
    t("agent.prompt.phase.title"),
    PHASE_IDS.map((phase) => t(`profile.phase.${phase}`)),
    (fallback) => t("agent.prompt.phase", { default: fallback }),
  );
  return answers;
}

/** The settings of an agent after `agent edit --tier/--tool`, then the next step. */
function formatSettings(t: Translate, id: string, settings: SettingsOutcome): string {
  const tier =
    settings.model_tier === undefined
      ? t("agent.settings.tier.default")
      : t("agent.settings.tier", { tier: settings.model_tier });
  const tool =
    settings.tool === undefined
      ? t("agent.settings.tool.none")
      : t("agent.settings.tool", { tool: toolName(settings.tool) });
  const title = t(`agent.settings.${settings.status}`, { id, path: METHOD_CONFIG_PATH });
  const next = settings.status === "updated" ? `${t("sync.next_step")}\n` : "";
  return `${title}\n  ${tier}\n  ${tool}\n${next}`;
}

/** What `agent` did, then the next step when the AI tools need a new sync. */
export function formatAgentResult(t: Translate, result: AgentCommandResult): string {
  const list = (paths: readonly string[]) => paths.map((path) => `  ${path}`).join("\n");
  switch (result.action) {
    case "create":
      return `${t(result.kind === "skill" ? "agent.created.skill" : "agent.created.agent", {
        id: result.id,
      })}\n${list(result.paths)}\n${t("sync.next_step")}\n`;
    case "edit": {
      if (result.settings !== undefined) return formatSettings(t, result.id, result.settings);
      const key =
        result.origin === "creator"
          ? "agent.edit.creator"
          : result.created
            ? "agent.edit.override.created"
            : "agent.edit.override.existing";
      return `${t(key, { id: result.id })}\n${list(result.paths)}\n`;
    }
    case "enable":
    case "disable": {
      const line = t(`agent.${result.action}.${result.status}`, {
        id: result.id,
        path: METHOD_CONFIG_PATH,
      });
      return result.status === "updated" ? `${line}\n${t("sync.next_step")}\n` : `${line}\n`;
    }
  }
}
