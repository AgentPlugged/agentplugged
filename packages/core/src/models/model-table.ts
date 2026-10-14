import {
  ErrorCode,
  INHERIT_MODEL,
  MODEL_CLIENT_IDS,
  MODEL_TIERS,
  type ModelChoice,
  type ModelClientId,
  type ModelOverrides,
  type ModelTable,
  ModelTableSchema,
  type ModelTier,
  NO_EFFORT,
} from "@agentplugged/protocol";
import { AgentPluggedError, reasonDetails } from "../errors.js";
import { GENERATED_HEADER_HASH, isGenerated, normalizeText } from "../init/generated.js";
import { MODELS_PATH } from "../init/layout.js";
import { parseYaml, type SafeParser } from "../method/definitions.js";
import type { MethodSource } from "../method/method-source.js";
import type { WorkspaceFiles } from "../workspace-files.js";

/** The model table in the shipped method, next to `agents/` and `skills/`. */
export const SHIPPED_MODELS_FILE = "models.yaml";

function modelTableInvalid(path: string, field: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.METHOD_CONFIG_INVALID, "error.method_config_invalid", {
    path,
    field,
    ...reasonDetails(reason),
  });
}

/** Parses and validates a model table; the error names the file and the field. */
export function parseModelTable(path: string, text: string): ModelTable | AgentPluggedError {
  const schema = ModelTableSchema as SafeParser<ModelTable>;
  return parseYaml(path, normalizeText(text), schema, modelTableInvalid);
}

/**
 * The shipped table, as text and validated. Read by `init` (to copy it) and by `sync` when the
 * product has no copy yet.
 */
export async function readShippedTable(
  method: MethodSource,
): Promise<{ text: string; table: ModelTable } | AgentPluggedError> {
  let text: string;
  try {
    text = normalizeText(await method.readText(SHIPPED_MODELS_FILE));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return modelTableInvalid(SHIPPED_MODELS_FILE, "(root)", reason);
  }
  const table = parseModelTable(SHIPPED_MODELS_FILE, text);
  return table instanceof AgentPluggedError ? table : { text, table };
}

/** `.agentplugged/models.yaml`: the shipped table with the generated header. */
export function renderModelsFile(shippedText: string): string {
  return `${GENERATED_HEADER_HASH}\n${normalizeText(shippedText)}`;
}

/**
 * The product's table: its copy `.agentplugged/models.yaml` when the creator took it (header
 * removed), otherwise the shipped table. A generated copy is never read: `init` would overwrite a
 * hand edit, and an engine upgrade must not leave a stale copy in use.
 */
export async function loadModelTable(
  files: WorkspaceFiles,
  method: MethodSource,
): Promise<ModelTable | AgentPluggedError> {
  if (await files.exists(MODELS_PATH)) {
    const text = await files.readText(MODELS_PATH);
    if (!isGenerated(text, GENERATED_HEADER_HASH)) return parseModelTable(MODELS_PATH, text);
  }
  const shipped = await readShippedTable(method);
  return shipped instanceof AgentPluggedError ? shipped : shipped.table;
}

/**
 * The table once the creator's values (`models` of `method.yaml`) are applied: they win field
 * by field, tool by tool and tier by tier.
 */
export function effectiveTable(table: ModelTable, overrides: ModelOverrides = {}): ModelTable {
  const result = {} as Record<ModelClientId, Record<ModelTier, ModelChoice>>;
  for (const client of MODEL_CLIENT_IDS) {
    const tiers = {} as Record<ModelTier, ModelChoice>;
    for (const tier of MODEL_TIERS) {
      const base = table[client][tier];
      const own = overrides[client]?.[tier] as { model?: string; effort?: string } | undefined;
      const model = own?.model ?? base.model;
      // `effort: none` in method.yaml removes the table's effort.
      const chosen = own?.effort ?? base.effort;
      const effort = chosen === NO_EFFORT ? undefined : chosen;
      tiers[tier] = effort === undefined ? { model } : { model, effort };
    }
    result[client] = tiers;
  }
  return result;
}

/** True when the cell keeps the model of the session. */
export function isInherit(choice: ModelChoice): boolean {
  return choice.model === INHERIT_MODEL;
}

/** Codex and Cursor keep the session's model by default: that is not a degraded case. */
const INHERIT_BY_DESIGN: readonly ModelClientId[] = ["codex", "cursor"];

/**
 * Clients for which at least one tier keeps the model of the session: a "model" fallback, except
 * Codex and Cursor, whose agents run on the session's model by default (a free account refuses a
 * named one).
 */
export function inheritClients(table: ModelTable): Set<ModelClientId> {
  return new Set(
    MODEL_CLIENT_IDS.filter(
      (client) =>
        !INHERIT_BY_DESIGN.includes(client) &&
        MODEL_TIERS.some((tier) => isInherit(table[client][tier])),
    ),
  );
}
