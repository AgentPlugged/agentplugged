import { fromUtf8 } from "@agentplugged/crypto";
import {
  type CheckpointDocument,
  ErrorCode,
  hasHiddenCharacter,
  hasMisleadingControl,
  PUBLICATION_DOCS_DIR,
  type PublicationRecord,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { isBlobOf, readWorkingBytes } from "../phases/design-review.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { WorkspaceFiles } from "../workspace-files.js";

/**
 * The rules of the `publication` checkpoint, pure functions and the
 * reads of the working copy that `open_checkpoint` needs: what the creator is shown is checked
 * against the text that stays one command away.
 */

/** The decisions that make a deliverable ready to publish (a validation, with or without reserves). */
const VALIDATING = new Set(["approved", "approved_with_reservations"]);

/** True for a checkpoint that presents a deliverable. */
export function isPublication(checkpoint: Pick<CheckpointState, "type">): boolean {
  return checkpoint.type === "publication";
}

/**
 * True when the creator validated the deliverable: the checkpoint is answered with an approval.
 * A refused (`rejected`), sent-back (`changes_requested`) or still open checkpoint is not ready.
 */
export function isValidatedPublication(
  checkpoint: Pick<CheckpointState, "type" | "status" | "resolution">,
): boolean {
  return (
    isPublication(checkpoint) &&
    checkpoint.status === "resolved" &&
    checkpoint.resolution !== null &&
    VALIDATING.has(checkpoint.resolution.decision)
  );
}

/** A text decoded as UTF-8, or undefined when the bytes are not valid UTF-8. */
export function decodeStrict(bytes: Uint8Array): string | undefined {
  return fromUtf8(bytes);
}

/**
 * The text of a deliverable without the YAML header the knowledge base requires on its documents
 * (`id`, `kind`, `owner`, `links`): that header is the method's, not the text to publish. A file
 * that does not start with a header is returned whole; so is a header never closed.
 */
export function withoutHeader(text: string): string {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const opening = /^---[ \t]*\r?\n/.exec(source);
  if (opening === null) return text;
  const rest = source.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (closing === null) return text;
  // Only a real header goes: its first line is a `key: value` of the knowledge base. A horizontal
  // rule and the lines after it are part of the text.
  const first = rest
    .slice(0, closing.index)
    .split(/\r?\n/)
    .find((line) => line.trim() !== "");
  if (first !== undefined && !/^[A-Za-z_][\w-]*\s*:/.test(first)) return text;
  return rest.slice(closing.index + closing[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
}

/** `INVALID_ARGUMENTS` for `field` of a command, with the usual shape. */
export function invalidField(
  command: string,
  field: string,
  why: string,
  /** A message of the catalogs (`publication.reason.*`) and its values, for the creator's commands. */
  translated?: { readonly key: string; readonly params: Readonly<Record<string, string>> },
): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command,
    field,
    reason: `${command}: ${field}: ${why}`,
    ...(translated === undefined ? {} : { reason_key: translated.key, ...translated.params }),
  });
}

/** The most a file of a deliverable holds, and the most all of them hold. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

/** Names Windows reserves, with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why a path cannot be exported on every system, or undefined. */
function portableProblem(path: string): string | undefined {
  for (const part of path.split("/")) {
    if (/[<>:"|?*\p{Cc}]/u.test(part))
      return `${part} holds a character not allowed in a file name`;
    if (/[. ]$/.test(part)) return `${part} ends with a dot or a space`;
    if (WINDOWS_RESERVED.test(part)) return `${part} is a reserved file name`;
  }
  return path.length > 240 ? "the path is too long" : undefined;
}

/**
 * Why a `publication` checkpoint cannot be opened as given, or undefined. Every file it cites is a
 * file of the knowledge base (`.agentplugged/docs/`) that exists in the working copy under no
 * symbolic link, is text (valid UTF-8, not empty, at most 2 MB) and is, byte for byte, the version
 * `blob_sha` names: the creator validates that blob, the full text and the export come from it. No
 * file is cited twice (by path or by blob, case aside), and none holds a control character or a
 * writing-direction override: what the creator reads is what is published. The short version must
 * not be longer than the full text it stands for.
 */
export async function publicationOpenProblem(
  input: {
    readonly documents?: readonly CheckpointDocument[] | undefined;
    readonly publication?: PublicationRecord | undefined;
    readonly title?: string | undefined;
  },
  files: Pick<WorkspaceFiles, "exists" | "readBytes" | "readText"> & {
    isSymbolicLink?(path: string): Promise<boolean>;
  },
): Promise<AgentPluggedError | undefined> {
  const command = "open_checkpoint";
  const documents = input.documents ?? [];
  if (input.title !== undefined && hasHiddenCharacter(input.title, false)) {
    return invalidField(command, "title", "expected one line of visible characters");
  }
  const paths = new Set<string>();
  const blobs = new Set<string>();
  let length = 0;
  let bytesTotal = 0;
  for (const [index, document] of documents.entries()) {
    const field = `documents.${index}.path`;
    if (document.path.includes("\\") || !document.path.startsWith(PUBLICATION_DOCS_DIR)) {
      return invalidField(command, field, `expected a file under ${PUBLICATION_DOCS_DIR}`);
    }
    const portable = portableProblem(document.path);
    if (portable !== undefined) return invalidField(command, field, portable);
    const key = document.path.toLowerCase();
    if (paths.has(key) || blobs.has(document.blob_sha)) {
      return invalidField(command, field, "a file is cited twice");
    }
    paths.add(key);
    blobs.add(document.blob_sha);
    if (document.path.slice(PUBLICATION_DOCS_DIR.length) === "") {
      return invalidField(command, field, "expected a file");
    }
    // Neither the file nor any folder above it is a link: a link could lead outside the project.
    const segments = document.path.split("/");
    for (let end = 2; end <= segments.length; end++) {
      if ((await files.isSymbolicLink?.(segments.slice(0, end).join("/"))) === true) {
        return invalidField(command, field, "a symbolic link is not a deliverable");
      }
    }
    const bytes = await readWorkingBytes(files, document.path);
    if (bytes === null) return invalidField(command, field, `${document.path} was not found`);
    bytesTotal += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || bytesTotal > MAX_TOTAL_BYTES) {
      return invalidField(
        command,
        field,
        "the deliverable is too large (2 MB a file, 10 MB in all)",
      );
    }
    const text = decodeStrict(bytes);
    if (text === undefined || !text.isWellFormed()) {
      return invalidField(command, field, "expected a UTF-8 text file");
    }
    if (hasMisleadingControl(text)) {
      return invalidField(
        command,
        field,
        `${document.path} holds a control character or a writing-direction override`,
      );
    }
    const body = withoutHeader(text).trim();
    if (body === "") return invalidField(command, field, `${document.path} holds no text`);
    if (!isBlobOf(document.blob_sha, bytes)) {
      return invalidField(
        command,
        `documents.${index}.blob_sha`,
        `${document.path} changed: cite the blob of its current content (git rev-parse HEAD:<path>, once committed)`,
      );
    }
    length += body.length;
  }
  const short = input.publication?.short_version;
  if (short !== undefined && documents.length > 0 && short.length > length) {
    return invalidField(
      command,
      "publication.short_version",
      "the short version is longer than the full text it presents",
    );
  }
  return undefined;
}

/**
 * The deliverables the creator sent back with an instruction (`changes_requested`) that no later
 * `publication` checkpoint supersedes, oldest first, from `since` (the start of the current phase)
 * on: the agent that produced one takes the instruction up, then opens a new `publication`
 * checkpoint with `supersedes` set to this one. A refusal (`rejected`) is the creator's last word
 * and sends nothing back.
 */
export function sentBackPublications(
  checkpoints: readonly CheckpointState[],
  since: string | null = null,
): CheckpointState[] {
  const superseded = new Set(
    checkpoints.flatMap((checkpoint) =>
      checkpoint.supersedes === null || !isPublication(checkpoint) ? [] : [checkpoint.supersedes],
    ),
  );
  const from = since === null ? Number.NEGATIVE_INFINITY : Date.parse(since);
  return checkpoints
    .filter(
      (checkpoint) =>
        isPublication(checkpoint) &&
        checkpoint.status === "resolved" &&
        checkpoint.resolution?.decision === "changes_requested" &&
        !superseded.has(checkpoint.id) &&
        Date.parse(checkpoint.resolution.at) >= from,
    )
    .sort((a, b) =>
      a.opened_event < b.opened_event ? -1 : a.opened_event > b.opened_event ? 1 : 0,
    );
}
