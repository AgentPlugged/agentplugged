import {
  type AgentContent,
  AgentContentSchema,
  AgentIdSchema,
  DOMAIN_IDS,
  ErrorCode,
  MAIN_SESSION_AGENT,
  PHASE_IDS,
  type SkillContent,
  SkillContentSchema,
  SkillNameSchema,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import type { DefinitionKind } from "../method/definitions.js";
import { NAME_MAX } from "./templates.js";

/** What `agent create` reads besides the id and the kind. */
export const CREATE_FIELDS = [
  "name",
  "title",
  "description",
  "icon",
  "role",
  "domain",
  "phase",
] as const;
export type CreateField = (typeof CREATE_FIELDS)[number];

/** Fields that only make sense for an agent: refused for a skill. */
export const AGENT_ONLY_FIELDS: readonly CreateField[] = [
  "name",
  "title",
  "icon",
  "role",
  "domain",
  "phase",
];

/** Fields without which nothing is created. */
export const REQUIRED_FIELDS: Readonly<Record<DefinitionKind, readonly CreateField[]>> = {
  agent: ["title", "description", "domain", "phase"],
  skill: ["description"],
};

/** Limits of `agent.yaml` (`name`, `icon`) and of the `SKILL.md` frontmatter (`description`). */
const MAX_LENGTH: Partial<Record<CreateField, number>> = {
  name: NAME_MAX,
  icon: 8,
  description: 1024,
};

const CHOICES: Partial<Record<CreateField, readonly string[]>> = {
  domain: DOMAIN_IDS,
  phase: PHASE_IDS,
};

/** An `INVALID_ARGUMENTS` error with its own message (translated by the surfaces). */
export function invalidArgument(
  messageKey: string,
  params: Record<string, string | number> = {},
): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, messageKey, params);
}

/** Checks one answer of `agent create`; the error names the option. */
export function validateCreateField(
  field: CreateField,
  value: string,
): AgentPluggedError | undefined {
  const text = value.trim();
  if (text === "") return invalidArgument("error.agent.required", { option: field });
  const choices = CHOICES[field];
  if (choices !== undefined && !choices.includes(text)) {
    return invalidArgument("error.agent.invalid_choice", {
      option: field,
      value: text,
      values: choices.join(", "),
    });
  }
  const max = MAX_LENGTH[field];
  if (max !== undefined && text.length > max) {
    return invalidArgument("error.agent.too_long", { option: field, max });
  }
  return undefined;
}

/** The answers given: trimmed strings; blank values count as absent. */
export function givenAnswers(
  input: Readonly<Record<string, unknown>>,
): Partial<Record<CreateField, string>> {
  const answers: Partial<Record<CreateField, string>> = {};
  for (const field of CREATE_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim() !== "") answers[field] = value.trim();
  }
  return answers;
}

/** `agent` (default) or `skill`. */
export function kindOf(value: unknown): DefinitionKind | AgentPluggedError {
  if (value === undefined || value === "agent") return "agent";
  if (value === "skill") return "skill";
  return invalidArgument("error.agent.unknown_kind", { kind: String(value) });
}

/**
 * Checks an identifier for a new agent (lowercase kebab-case starting with a letter) or skill
 * (the skill name rule, which also allows a leading digit).
 */
export function validateNewId(kind: DefinitionKind, id: unknown): string | AgentPluggedError {
  if (typeof id !== "string" || id === "") return invalidArgument("error.agent.id_required");
  const schema = kind === "agent" ? AgentIdSchema.pipe(SkillNameSchema) : SkillNameSchema;
  // `main` is the main session's own identifier in every call an agent makes.
  if (schema.safeParse(id).success && id !== MAIN_SESSION_AGENT) return id;
  return invalidArgument(
    kind === "agent" ? "error.agent.invalid_id" : "error.agent.invalid_skill_id",
    { id },
  );
}

/**
 * The options given to `agent create`, before any question: a skill takes no agent option, and
 * every given value must be valid.
 */
export function validateGivenAnswers(
  kind: DefinitionKind,
  answers: Partial<Record<CreateField, string>>,
): AgentPluggedError | undefined {
  if (kind === "skill") {
    const misplaced = AGENT_ONLY_FIELDS.filter((field) => answers[field] !== undefined);
    if (misplaced.length > 0) {
      return invalidArgument("error.agent.skill_options", {
        options: misplaced.map((field) => `--${field}`).join(", "),
      });
    }
  }
  for (const field of CREATE_FIELDS) {
    const value = answers[field];
    if (value === undefined) continue;
    const error = validateCreateField(field, value);
    if (error !== undefined) return error;
  }
  return undefined;
}

/**
 * The complete definition given with a creation or an edit, checked for the kind it
 * is written for (an agent or a skill): the error names the field.
 */
export function parseContent(
  kind: DefinitionKind,
  raw: unknown,
): AgentContent | SkillContent | AgentPluggedError {
  const parsed = (kind === "agent" ? AgentContentSchema : SkillContentSchema).safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = ["content", ...(issue?.path ?? [])].map(String).join(".");
  return invalidArgument("error.agent.content_invalid", {
    kind,
    field,
    reason: issue?.message ?? "invalid",
  });
}
