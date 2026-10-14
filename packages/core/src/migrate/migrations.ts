import { METHOD_FORMAT_VERSION, MigrationStepIdSchema } from "@agentplugged/protocol";
import { parseDocument } from "yaml";
import { AgentPluggedError } from "../errors.js";
import {
  methodConfigInvalid,
  parseMethodConfig,
  stringifyMethodDocument,
} from "../init/method-config.js";
import { writeProductId } from "../journal/product-id.js";
import type { MethodSource } from "../method/method-source.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import {
  type MigrationFilePlan,
  type MigrationNote,
  planRenameAgentsFiles,
  RENAME_AGENTS_STEP,
  renameAgentsText,
} from "./rename-agents.js";

export type { MigrationFileOperation, MigrationFilePlan, MigrationNote } from "./rename-agents.js";

/**
 * One step of the format of `.agentplugged/`: from format `from` to `from + 1`.
 * `apply` is pure: it turns the text of `method.yaml` at format `from` into its text at the next
 * format, keeping the creator's comments (`stringifyMethodDocument` writes an edited document as
 * every other edit does); the engine then writes `format_version` itself. A step never touches
 * the journal. A step may also change other files of `.agentplugged/`: `planFiles`
 * plans them from the working copy, nothing written, and `notes` says what the creator should
 * know of its changes to `method.yaml`.
 */
export interface FormatMigration {
  readonly from: number;
  /** Stable once shipped, in kebab-case: recorded by `method.migrated` (`steps`). */
  readonly id: string;
  apply(text: string): string;
  /** What the change of `method.yaml` means for the creator, read from its text at `from`. */
  notes?(text: string): readonly MigrationNote[];
  /** The other files of `.agentplugged/` this step writes or removes, nothing written. */
  planFiles?(
    files: WorkspaceFiles,
    method: MethodSource,
  ): Promise<MigrationFilePlan | AgentPluggedError>;
}

/**
 * The migrations shipped with the engine, in order. A format change adds its step here, with its
 * tests; a step is never removed nor changed once shipped.
 * - 1 → 2: `rename-agents`, the team renamed and the developers by specialty.
 */
export const METHOD_MIGRATIONS: readonly FormatMigration[] = [
  {
    from: 1,
    id: RENAME_AGENTS_STEP,
    apply: (text) => renameAgentsText(text).text,
    notes: (text) => renameAgentsText(text).notes,
    planFiles: planRenameAgentsFiles,
  },
];

const FORMAT_FIELD = "format_version";

/**
 * The steps from format `from` to format `to`, in order: one per format, each found once in
 * `migrations`. A missing step gives `METHOD_CONFIG_INVALID` on `format_version`.
 */
export function planMigration(
  from: number,
  to: number,
  migrations: readonly FormatMigration[],
): FormatMigration[] | AgentPluggedError {
  const steps: FormatMigration[] = [];
  for (let format = from; format < to; format++) {
    const found = migrations.filter((step) => step.from === format);
    const step = found[0];
    if (
      found.length !== 1 ||
      step === undefined ||
      !MigrationStepIdSchema.safeParse(step.id).success
    ) {
      return methodConfigInvalid(
        FORMAT_FIELD,
        found.length > 1
          ? `several migrations from format ${format}`
          : `no migration from format ${format} to format ${format + 1}`,
      );
    }
    steps.push(step);
  }
  return steps;
}

/** The `format_version` written in `method.yaml`, read without the schema (an older format). */
export function readFormat(text: string): number | AgentPluggedError {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    const parsed = parseMethodConfig(text);
    return parsed instanceof AgentPluggedError
      ? parsed
      : methodConfigInvalid(FORMAT_FIELD, "invalid");
  }
  const raw: unknown = document.toJS();
  const format =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)[FORMAT_FIELD]
      : undefined;
  if (typeof format !== "number" || !Number.isInteger(format) || format < 0) {
    const parsed = parseMethodConfig(text);
    return parsed instanceof AgentPluggedError
      ? parsed
      : methodConfigInvalid(FORMAT_FIELD, "a whole number is expected");
  }
  return format;
}

/** A top-level value of `method.yaml`, read without the schema. */
export function readTopLevel(text: string, key: string): unknown {
  const document = parseDocument(text);
  if (document.errors.length > 0) return undefined;
  const raw: unknown = document.toJS();
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)[key]
    : undefined;
}

function setTopLevel(text: string, key: string, value: unknown): string {
  const document = parseDocument(text);
  document.set(key, value);
  return stringifyMethodDocument(document, text);
}

/**
 * The text of `method.yaml` once migrated: each step applied in order, `format_version` set after
 * each, then `engine_version` set to the running engine and `product_id` added when missing.
 * Comments and line endings are kept. The result must be a valid `method.yaml` of the current
 * format; a step that throws or leaves it invalid gives `METHOD_CONFIG_INVALID`, nothing written.
 */
export function applyMigration(
  text: string,
  steps: readonly FormatMigration[],
  options: { readonly engineVersion: string; readonly productId: string },
): string | AgentPluggedError {
  let current = text;
  for (const step of steps) {
    try {
      current = setTopLevel(step.apply(current), FORMAT_FIELD, step.from + 1);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return methodConfigInvalid(FORMAT_FIELD, `migration ${step.id}: ${reason}`);
    }
  }
  if (readFormat(current) !== METHOD_FORMAT_VERSION) {
    return methodConfigInvalid(FORMAT_FIELD, `format ${METHOD_FORMAT_VERSION} is expected`);
  }
  current = setTopLevel(current, "engine_version", options.engineVersion);
  if (readTopLevel(current, "product_id") === undefined) {
    const added = writeProductId(current, options.productId);
    if (added instanceof AgentPluggedError) return added;
    current = added;
  }
  // The line endings of the creator's file, whatever a step wrote.
  if (text.includes("\r\n")) current = current.replace(/\r?\n/g, "\r\n");
  const checked = parseMethodConfig(current);
  return checked instanceof AgentPluggedError ? checked : current;
}

/**
 * What the steps' changes to `method.yaml` mean for the creator, each step read on
 * the text it receives. A step that throws says nothing: `applyMigration` reports it.
 */
export function migrationNotes(text: string, steps: readonly FormatMigration[]): MigrationNote[] {
  const notes: MigrationNote[] = [];
  let current = text;
  for (const step of steps) {
    try {
      notes.push(...(step.notes?.(current) ?? []));
      current = step.apply(current);
    } catch {
      return notes;
    }
  }
  return notes;
}

/**
 * The other files of `.agentplugged/` the steps change, planned from the working copy, nothing
 * written. Several steps changing the same path: the later one wins.
 */
export async function planMigrationFiles(
  steps: readonly FormatMigration[],
  files: WorkspaceFiles,
  method: MethodSource,
): Promise<MigrationFilePlan | AgentPluggedError> {
  const operations = new Map<string, MigrationFilePlan["operations"][number]>();
  const notes: MigrationNote[] = [];
  for (const step of steps) {
    if (step.planFiles === undefined) continue;
    const plan = await step.planFiles(files, method);
    if (plan instanceof AgentPluggedError) return plan;
    for (const operation of plan.operations) operations.set(operation.path, operation);
    notes.push(...plan.notes);
  }
  // Writes before removes, each in the order its step gives: stopped in between, a
  // customisation exists twice, never nowhere.
  const all = [...operations.values()];
  const ordered = [
    ...all.filter((operation) => operation.action === "write"),
    ...all.filter((operation) => operation.action === "remove"),
  ];
  return { operations: ordered, notes };
}
