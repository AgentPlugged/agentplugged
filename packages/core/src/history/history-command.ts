import { ErrorCode } from "@agentplugged/protocol";
import { defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError, unexpected } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import { computeProjection } from "../projection/compute-projection.js";
import {
  filterHistory,
  type HistoryEntry,
  type HistoryFormat,
  historyCsv,
  historyEntries,
  historyFormatOf,
  historyJson,
  type IgnoredValidation,
  ignoredValidations,
  parseHistoryFilters,
} from "./history.js";

/** What `history --export` wrote. */
export interface HistoryExport {
  /** The path as given (relative to the current folder). */
  readonly path: string;
  readonly format: HistoryFormat;
  /** The validations written. */
  readonly count: number;
  /** With `--all`: the ignored answers written too; else null. */
  readonly ignored: number | null;
  /** True when an existing file was replaced (`--force`). */
  readonly replaced: boolean;
}

export interface HistoryResult {
  /** The validations kept by the filters, most recent first. */
  readonly entries: readonly HistoryEntry[];
  /** With `--all`: the answers the projection ignored, kept by the filters; else null. */
  readonly ignored: readonly IgnoredValidation[] | null;
  /** With `--export`: what was written. */
  readonly export: HistoryExport | null;
}

function invalid(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", { reason });
}

/**
 * `history [--story <e-s>] [--since <date>] [--decision <decision>] [--all]
 * [--export <file.json|file.csv> [--force]]`: the creator's validations, most recent first, from
 * the projection computed again from the whole journal (`state.validations[]`), never from
 * `state.json`. With `--all`, the answers the projection ignored, with their reason.
 *
 * With `--export`, what the filters keep (and, with `--all`, the ignored answers) is written to
 * `context.exportTarget` (the surface resolves the path and checks where it leads) as canonical
 * JSON or RFC 4180 CSV, by the file's extension. Without `--force` the file is created
 * exclusively, whole or not at all (`createText`): `FILE_EXISTS` when anything is there, even an
 * entry created meanwhile. With `--force` it is replaced atomically (`writeText`).
 *
 * A read command: it writes nothing to the journal nor to `state.json`, and never reads a key.
 * The creator's command only: never exposed over MCP.
 */
export const historyCommand = defineCommand<HistoryResult>({
  name: "history",
  async run(context, input) {
    const filters = parseHistoryFilters(input);
    if (filters instanceof AgentPluggedError) return fail(filters);
    const { all, export: exportPath, force } = input;
    if (all !== undefined && typeof all !== "boolean") return fail(invalid("--all"));
    if (force !== undefined && typeof force !== "boolean") return fail(invalid("--force"));
    let format: HistoryFormat | undefined;
    const target = context.exportTarget;
    if (exportPath !== undefined) {
      if (typeof exportPath !== "string" || exportPath.trim() === "") {
        return fail(invalid("--export"));
      }
      if (target === undefined) return fail(unexpected("no folder to export to is available here"));
      format = historyFormatOf(target.name);
      if (format === undefined) return fail(invalid(`--export ${exportPath} (.json, .csv)`));
    } else if (force === true) {
      return fail(invalid("--force (with --export only)"));
    }
    if (context.journal === undefined) return fail(unexpected("no journal is available here"));

    // The product is pinned by `method.yaml` when it names one; an invalid file is reported.
    let productId: string | undefined;
    if (await context.files.exists(METHOD_CONFIG_PATH)) {
      const loaded = await loadMethodConfig(context.files);
      if (loaded instanceof AgentPluggedError) return fail(loaded);
      productId = loaded.config.product_id;
    }
    try {
      const listing = await context.journal.list();
      const state = await computeProjection(listing.events, {
        problems: listing.problems,
        head: listing.head,
        ...(productId === undefined ? {} : { product: productId }),
        allowTestTypes: context.allowTestTypes === true,
      });
      const entries = filterHistory(historyEntries(state, listing.events), filters);
      const ignored =
        all === true ? filterHistory(ignoredValidations(state, listing.events), filters) : null;

      let written: HistoryExport | null = null;
      if (typeof exportPath === "string" && format !== undefined && target !== undefined) {
        const content =
          format === "json" ? historyJson(entries, ignored) : historyCsv(entries, ignored);
        const { files, name } = target;
        const fileExists = () =>
          new AgentPluggedError(ErrorCode.FILE_EXISTS, "error.file_exists", { path: exportPath });
        let replaced = false;
        if (force === true) {
          replaced = await files.exists(name);
          await files.writeText(name, content);
        } else if (files.createText !== undefined) {
          if (!(await files.createText(name, content))) return fail(fileExists());
        } else {
          // A port without exclusive creation: checked first, then written.
          if (await files.exists(name)) return fail(fileExists());
          await files.writeText(name, content);
        }
        written = {
          path: exportPath,
          format,
          count: entries.length,
          ignored: ignored === null ? null : ignored.length,
          replaced,
        };
      }
      return ok({ entries, ignored, export: written });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});
