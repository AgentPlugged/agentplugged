import { z } from "zod";

/** Model tier an agent needs; translated into a concrete model per tool. */
export const MODEL_TIERS = ["reasoning", "code", "fast", "multimodal"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Clients of the model table: the AI tools as they read a sub-agent.
 */
export const MODEL_CLIENT_IDS = ["claude-code", "codex", "antigravity", "cursor"] as const;
export type ModelClientId = (typeof MODEL_CLIENT_IDS)[number];

/**
 * Key of the retired Gemini CLI in a model table or in the `models` section of `method.yaml`.
 * Older products still hold it: it is read, reported and ignored, never accepted for anything new.
 */
export const LEGACY_GEMINI_CLIENT = "gemini-cli";

/** Model value that keeps the model of the session: no model is chosen per agent. */
export const INHERIT_MODEL = "inherit";

const Value = z.string().trim().min(1);

/** Reasoning efforts of Claude Code sub-agents (`effort`). */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Reasoning efforts of Codex agents (`model_reasoning_effort`). */
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
/** In the `models` section of `method.yaml`: no effort line, whatever the table says. */
export const NO_EFFORT = "none";

/** A cell of Claude Code. */
const ClaudeCell = z.strictObject({ model: Value, effort: z.enum(CLAUDE_EFFORTS).optional() });
/** A cell of Codex. */
const CodexCell = z.strictObject({ model: Value, effort: z.enum(CODEX_EFFORTS).optional() });
/** A cell of a tool with a model only. */
const ModelOnly = z.strictObject({ model: Value });

function tiers<T extends z.ZodType>(cell: T) {
  return z.strictObject({ reasoning: cell, code: cell, fast: cell, multimodal: cell });
}

/**
 * The model table shipped with the method (`models.yaml`, copied into
 * `.agentplugged/models.yaml`): every client, every tier. Values are checked for form only: no
 * model API is called.
 */
export const ModelTableSchema = z.strictObject({
  "claude-code": tiers(ClaudeCell),
  codex: tiers(CodexCell),
  antigravity: tiers(ModelOnly),
  // Retired tool: tolerated in an older table, ignored.
  [LEGACY_GEMINI_CLIENT]: z.unknown().optional(),
  cursor: tiers(ModelOnly),
});

/** One cell of the table: the model, and the reasoning effort where the tool has one. */
export interface ModelChoice {
  readonly model: string;
  readonly effort?: string | undefined;
}

export type ModelTable = Readonly<Record<ModelClientId, Readonly<Record<ModelTier, ModelChoice>>>>;

function partialTiers<T extends z.ZodType>(cell: T) {
  return z
    .strictObject({
      reasoning: cell.optional(),
      code: cell.optional(),
      fast: cell.optional(),
      multimodal: cell.optional(),
    })
    .optional();
}

/**
 * `models` section of `method.yaml`: the creator's values, tool by tool and tier by tier. They
 * win over the table, field by field; `effort: none` removes the table's effort.
 */
export const ModelOverridesSchema = z.strictObject({
  "claude-code": partialTiers(
    z.strictObject({
      model: Value.optional(),
      effort: z.enum([...CLAUDE_EFFORTS, NO_EFFORT]).optional(),
    }),
  ),
  codex: partialTiers(
    z.strictObject({
      model: Value.optional(),
      effort: z.enum([...CODEX_EFFORTS, NO_EFFORT]).optional(),
    }),
  ),
  antigravity: partialTiers(ModelOnly.partial()),
  // Retired tool: tolerated in an older `method.yaml`, ignored.
  [LEGACY_GEMINI_CLIENT]: z.unknown().optional(),
  cursor: partialTiers(ModelOnly.partial()),
});

export type ModelOverrides = z.infer<typeof ModelOverridesSchema>;
