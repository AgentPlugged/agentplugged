import { sha256Hex, utf8 } from "@agentplugged/crypto";
import {
  CheckpointIdSchema,
  countWords,
  ErrorCode,
  PUBLICATION_DOCS_DIR,
  PUBLICATION_EXPORT_DIR,
  type PublicationRecord,
} from "@agentplugged/protocol";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import { isBlobOf, readWorkingBytes } from "../phases/design-review.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { computeProjection } from "../projection/compute-projection.js";
import {
  decodeStrict,
  invalidField,
  isPublication,
  isValidatedPublication,
  withoutHeader,
} from "./publication-rules.js";

/**
 * `publication <G-id>` and `publication export <G-id>`, the creator's:
 * the full text of a deliverable, one command away, and the deliverable ready to publish. Both read
 * the blobs the checkpoint cites, the versions the creator was shown and validated, never the
 * working copy as it is now. Nothing here publishes, sends or pays: the creator copies the text
 * or the files and publishes them themselves.
 */

export const PUBLICATION_ACTIONS = ["show", "export"] as const;

/** One file of a deliverable: its path, its blob, and its text (header of the method removed). */
export interface PublicationFile {
  readonly path: string;
  readonly blob: string;
  /** The text to publish, without the YAML header of the knowledge base. */
  readonly text: string;
  /** The file as stored, header included. */
  readonly raw: string;
  readonly words: number;
}

/** What the full text of a deliverable shows. */
export interface PublicationShown {
  readonly action: "show";
  readonly checkpoint: string;
  readonly title: string;
  readonly status: CheckpointState["status"];
  /** The creator's decision, or null while the checkpoint is open. */
  readonly decision: string | null;
  /** How the answer was given (`presence`, `chat`, `chat_unverified`, `elicitation`…), or null. */
  readonly assurance: string | null;
  readonly opened_by: string | null;
  readonly publication: PublicationRecord | null;
  /** The files asked for (all of them without `--file`). */
  readonly files: readonly PublicationFile[];
  /** How many files the deliverable holds in all. */
  readonly total_files: number;
  /** The words of the whole deliverable. */
  readonly total_words: number;
  /** The files carry the header of the method (`--raw`). */
  readonly raw: boolean;
}

/** One file written (or already there) by an export. */
export interface ExportedFile {
  readonly path: string;
  readonly source: string;
  readonly blob: string;
  readonly status: "written" | "unchanged" | "replaced";
}

/** What an export wrote, ready to publish. */
export interface PublicationExported {
  readonly action: "export";
  readonly checkpoint: string;
  readonly title: string;
  readonly directory: string;
  readonly files: readonly ExportedFile[];
  /** The sheet that goes with the files, in the same folder. */
  readonly sheet: string;
  readonly decision: string;
  readonly reservations: string | null;
}

export type PublicationResult = PublicationShown | PublicationExported;

function invalid(
  field: string,
  why: string,
  translated?: { readonly key: string; readonly params: Readonly<Record<string, string>> },
): AgentPluggedError {
  return invalidField("publication", field, why, translated);
}

/** The checkpoints of the journal, projected without the product key. */
async function checkpointsOf(context: CommandContext): Promise<Record<string, CheckpointState>> {
  if (context.journal === undefined) {
    throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
      reason: "no journal is available here",
    });
  }
  let product: string | undefined;
  if (await context.files.exists(METHOD_CONFIG_PATH)) {
    const loaded = await loadMethodConfig(context.files);
    if (loaded instanceof AgentPluggedError) throw loaded;
    product = loaded.config.product_id;
  }
  const listing = await context.journal.list();
  const projected = await computeProjection(listing.events, {
    problems: listing.problems,
    head: listing.head,
    ...(product === undefined ? {} : { product }),
    allowTestTypes: context.allowTestTypes === true,
  });
  return (projected.state.checkpoints as Record<string, CheckpointState> | undefined) ?? {};
}

/**
 * The texts of the blobs a publication cites. A blob Git lacks (the agent forgot `-w`) is read
 * from the working copy when that file still is that blob; else `blob_missing`.
 */
async function readFiles(
  context: CommandContext,
  checkpoint: CheckpointState,
): Promise<PublicationFile[] | AgentPluggedError> {
  const blobs =
    context.docsBase === undefined
      ? new Map<string, string>()
      : await context.docsBase.readBlobs(checkpoint.documents.map((document) => document.blob_sha));
  const files: PublicationFile[] = [];
  for (const [index, document] of checkpoint.documents.entries()) {
    let raw = blobs.get(document.blob_sha);
    if (raw === undefined) {
      const bytes = await readWorkingBytes(context.files, document.path);
      const text = bytes === null ? undefined : decodeStrict(bytes);
      if (bytes !== null && text !== undefined && isBlobOf(document.blob_sha, bytes)) raw = text;
    }
    if (raw === undefined) {
      return invalid(
        `documents.${index}`,
        `blob_missing: ${document.path} (${document.blob_sha}) is not in Git nor in the working copy`,
        {
          key: "publication.reason.blob_missing",
          params: { path: document.path, blob: document.blob_sha },
        },
      );
    }
    const text = withoutHeader(raw);
    files.push({
      path: document.path,
      blob: document.blob_sha,
      text,
      raw,
      words: countWords(text),
    });
  }
  return files;
}

function findPublication(
  checkpoints: Record<string, CheckpointState>,
  typed: unknown,
): CheckpointState | AgentPluggedError {
  const parsed = CheckpointIdSchema.safeParse(
    typeof typed === "string" ? typed.trim().toUpperCase() : "",
  );
  if (!parsed.success) return invalid("checkpoint", "expected a checkpoint id (G-…)");
  const found = Object.hasOwn(checkpoints, parsed.data) ? checkpoints[parsed.data] : undefined;
  if (found === undefined) {
    return new AgentPluggedError(ErrorCode.CHECKPOINT_NOT_FOUND, "error.checkpoint_not_found", {
      checkpoint: parsed.data,
    });
  }
  if (!isPublication(found)) {
    return invalid("checkpoint", `${found.id} is not a publication (it is a ${found.type})`, {
      key: "publication.reason.not_publication",
      params: { checkpoint: found.id, type: found.type },
    });
  }
  if (found.documents.length === 0) {
    return invalid("checkpoint", `no_text_recorded: ${found.id} records no file of full text`, {
      key: "publication.reason.no_text",
      params: { checkpoint: found.id },
    });
  }
  return found;
}

/** The sheet that goes with an export: what was validated, by whom, and the digest of each file. */
function sheetOf(
  checkpoint: CheckpointState,
  files: readonly (ExportedFile & { readonly sha256: string })[],
): string {
  const resolution = checkpoint.resolution;
  const presentation = checkpoint.publication;
  // The title is one line in the sheet, whatever the agent wrote.
  const title = checkpoint.title.replace(/\s+/g, " ").trim();
  const lines = [
    `# ${title}`,
    "",
    "Ready to publish. Generated by `agentplugged publication export`: AgentPlugged publishes, sends and pays nothing; you do.",
    "",
    `- Checkpoint: ${checkpoint.id}`,
    `- Validated: ${resolution?.decision ?? "?"} on ${resolution?.at ?? "?"}${resolution?.assurance === undefined ? "" : ` (${resolution.assurance})`}`,
  ];
  if (resolution?.note) lines.push(`- Reservations: ${resolution.note.replace(/\s+/g, " ")}`);
  if (presentation) {
    lines.push(
      `- Angle: ${presentation.angle}`,
      `- Audience: ${presentation.audience}`,
      "",
      "## Short version",
      "",
      ...presentation.short_version.split("\n").map((line) => `> ${line}`),
    );
  }
  lines.push("", "## Files", "");
  for (const file of files) {
    lines.push(
      `- \`${file.path}\`: SHA-256 ${file.sha256} (source ${file.source}, blob ${file.blob})`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function show(
  context: CommandContext,
  checkpoint: CheckpointState,
  input: Readonly<Record<string, unknown>>,
): Promise<PublicationShown | AgentPluggedError> {
  const read = await readFiles(context, checkpoint);
  if (read instanceof AgentPluggedError) return read;
  const only = input.file;
  if (only !== undefined && typeof only !== "string") return invalid("file", "expected a path");
  const chosen =
    only === undefined
      ? read
      : read.filter(
          (file) => file.path === only || file.path.slice(PUBLICATION_DOCS_DIR.length) === only,
        );
  if (chosen.length === 0) {
    return invalid("file", `${String(only)} is not one of the files of ${checkpoint.id}`, {
      key: "publication.reason.unknown_file",
      params: { file: String(only), checkpoint: checkpoint.id },
    });
  }
  return {
    action: "show",
    checkpoint: checkpoint.id,
    title: checkpoint.title,
    status: checkpoint.status,
    decision: checkpoint.resolution?.decision ?? null,
    assurance: checkpoint.resolution?.assurance ?? null,
    opened_by: checkpoint.opened_by,
    publication: checkpoint.publication ? { ...checkpoint.publication } : null,
    files: chosen,
    total_files: read.length,
    total_words: read.reduce((total, file) => total + file.words, 0),
    raw: input.raw === true,
  };
}

async function exportFiles(
  context: CommandContext,
  checkpoint: CheckpointState,
  input: Readonly<Record<string, unknown>>,
): Promise<PublicationExported | AgentPluggedError> {
  if (!isValidatedPublication(checkpoint)) {
    const decision = checkpoint.resolution?.decision ?? checkpoint.status;
    return invalid(
      "checkpoint",
      `not_validated: ${checkpoint.id} is ${decision}: only a deliverable you approved is exported`,
      {
        key: "publication.reason.not_validated",
        params: { checkpoint: checkpoint.id, decision },
      },
    );
  }
  const force = input.force === true;
  // An approval given in the chat without the hook's proof (tools without it): the creator can
  // validate it again with `review`, or export it knowingly.
  if (checkpoint.resolution?.assurance === "chat_unverified" && input.unverified !== true) {
    return invalid(
      "checkpoint",
      `unverified: ${checkpoint.id} was approved in the chat without proof: validate it with review, or use --unverified`,
      { key: "publication.reason.unverified", params: { checkpoint: checkpoint.id } },
    );
  }
  const read = await readFiles(context, checkpoint);
  if (read instanceof AgentPluggedError) return read;
  const directory = `${PUBLICATION_EXPORT_DIR}/${checkpoint.id}`;
  const sheet = `${PUBLICATION_EXPORT_DIR}/${checkpoint.id}.md`;
  const planned = read.map((file) => ({
    file,
    target: `${directory}/${file.path.slice(PUBLICATION_DOCS_DIR.length)}`,
  }));
  // No link on the way: a folder of exports that is a link would write elsewhere.
  for (const { target } of planned) {
    const segments = target.split("/");
    for (let end = 2; end <= segments.length; end++) {
      const prefix = segments.slice(0, end).join("/");
      if ((await context.files.isSymbolicLink?.(prefix)) === true) {
        return invalid("export", `symbolic_link: ${prefix} is a symbolic link`, {
          key: "publication.reason.symbolic_link",
          params: { path: prefix },
        });
      }
    }
  }
  if ((await context.files.isSymbolicLink?.(sheet)) === true) {
    return invalid("export", `symbolic_link: ${sheet} is a symbolic link`, {
      key: "publication.reason.symbolic_link",
      params: { path: sheet },
    });
  }
  // Nothing is written before every file is known to be writable: a file edited by hand is never
  // replaced without `--force`.
  const exported: (ExportedFile & { sha256: string })[] = [];
  const check = async (
    path: string,
    text: string,
  ): Promise<ExportedFile["status"] | AgentPluggedError> => {
    const there = (await context.files.exists(path))
      ? await context.files.readText(path).catch(() => undefined)
      : null;
    if (there === null) return "written";
    if (there === text) return "unchanged";
    if (force) return "replaced";
    return invalid(
      "export",
      `export_modified: ${path} differs from the validated text (edited by hand?): use --force to replace it`,
      { key: "publication.reason.export_modified", params: { path } },
    );
  };
  for (const { file, target } of planned) {
    const status = await check(target, file.text);
    if (status instanceof AgentPluggedError) return status;
    exported.push({
      path: target,
      source: file.path,
      blob: file.blob,
      status,
      sha256: sha256Hex(utf8(file.text)),
    });
  }
  const sheetText = sheetOf(checkpoint, exported);
  const sheetStatus = await check(sheet, sheetText);
  if (sheetStatus instanceof AgentPluggedError) return sheetStatus;
  for (const [index, { file, target }] of planned.entries()) {
    if (exported[index]?.status === "unchanged") continue;
    await context.files.mkdir(target.slice(0, target.lastIndexOf("/")));
    await context.files.writeText(target, file.text);
  }
  if (sheetStatus !== "unchanged") {
    await context.files.mkdir(PUBLICATION_EXPORT_DIR);
    await context.files.writeText(sheet, sheetText);
  }
  return {
    action: "export",
    checkpoint: checkpoint.id,
    title: checkpoint.title,
    directory,
    files: exported.map(({ sha256: _digest, ...file }) => file),
    sheet,
    decision: checkpoint.resolution?.decision ?? "approved",
    reservations: checkpoint.resolution?.note ?? null,
  };
}

export const publicationCommand = defineCommand<PublicationResult>({
  name: "publication",
  async run(context, input) {
    const action = input.action ?? "show";
    if (action !== "show" && action !== "export") {
      return fail(invalid("action", `expected ${PUBLICATION_ACTIONS.join(" or ")}`));
    }
    if (action === "export" && (input.file !== undefined || input.raw === true)) {
      return fail(invalid("export", "--file and --raw belong to the full text, not to the export"));
    }
    if (action === "show" && (input.force === true || input.unverified === true)) {
      return fail(invalid("show", "--force and --unverified belong to the export"));
    }
    try {
      const checkpoints = await checkpointsOf(context);
      const found = findPublication(checkpoints, input.checkpoint);
      if (found instanceof AgentPluggedError) return fail(found);
      const result =
        action === "show"
          ? await show(context, found, input)
          : await exportFiles(context, found, input);
      return result instanceof AgentPluggedError ? fail(result) : ok(result);
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});
