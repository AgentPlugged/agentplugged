import { decryptFile, encryptedFileKeyId, encryptFile } from "@agentplugged/crypto";
import {
  ErrorCode,
  MAX_SENSITIVE_CONTENT_BYTES,
  ReadSensitiveInputSchema,
  type SensitiveArea,
  utf8Length,
  WriteSensitiveInputSchema,
} from "@agentplugged/protocol";
import { agentWriteContext, invalidInput } from "../agent-activity/agent-commands.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import {
  adoptRotatedKey,
  announcedKey,
  forgetProductKey,
  type ProductKey,
  productKeyById,
  productKeyMissing,
  readHeldProductKey,
  writingKey,
} from "../journal/product-key.js";
import type { StateStore } from "../journal/state-store.js";
import { isReservedMemoryPath } from "../memory/memory-files.js";
import { checkSensitivePath, fileBinding, workspacePath } from "./sensitive-files.js";

/**
 * The files of the Salle and of the memory: always written encrypted with the product
 * key (`agentplugged-enc:1:<key_id>`, then the ciphertext), bound to their product and path. Agents
 * read and write them through these two tools only: the generated permissions forbid reading or
 * writing `.agentplugged/salle/` and `.agentplugged/memory/` directly. A file in clear is never
 * served (`SENSITIVE_NOT_ENCRYPTED`): the creator encrypts it with `key seal`. The key never leaves
 * the keychain.
 */

/** What `read_sensitive` returns: the file's content in clear. */
export interface SensitiveFileRead {
  readonly area: SensitiveArea;
  readonly path: string;
  readonly content: string;
}

/** What `write_sensitive` returns: where the file was written, encrypted. */
export interface SensitiveFileWritten {
  readonly area: SensitiveArea;
  readonly path: string;
  /** Bytes of the content in clear (UTF-8). */
  readonly bytes: number;
}

/**
 * The product key of `product`, checked against the key the journal announces: else
 * `PRODUCT_KEY_MISSING` or `PRODUCT_KEY_MISMATCH`; a keychain failure is reported as such.
 */
export async function sensitiveKey(
  context: CommandContext,
  journal: StateStore,
  product: string,
): Promise<ProductKey> {
  const keys = context.keys ?? context.human?.keys;
  const listing = keys === undefined ? undefined : await journal.list();
  if (keys !== undefined && listing !== undefined) {
    // A renewal sealed for this machine is taken in first.
    await forgetProductKey(
      await adoptRotatedKey(keys, product, {
        events: listing.events,
        problems: listing.problems,
        allowTestTypes: context.allowTestTypes === true,
      }).catch(() => undefined),
    );
  }
  const key = keys === undefined ? undefined : await readHeldProductKey(keys, product);
  if (key === undefined || listing === undefined) throw productKeyMissing(product);
  try {
    // What is written is encrypted with the key the journal announces; what is read, with the
    // key the file names (see `fileKeyFor`).
    return await writingKey(
      await announcedKey(listing.events, {
        product,
        productKey: key,
        problems: listing.problems,
        allowTestTypes: context.allowTestTypes === true,
      }),
      key,
    );
  } catch (error) {
    await forgetProductKey(key);
    throw error;
  }
}

/** `INVALID_ARGUMENTS` on the `path` of `command`. */
function badPath(command: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command,
    field: "path",
    reason: `${command}: path: ${reason}`,
  });
}

/** `PRODUCT_KEY_MISMATCH` for a file encrypted under another key than the one held. */
function fileKeyMismatch(fileKeyId: string, heldKeyId: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.PRODUCT_KEY_MISMATCH, "error.product_key_file_mismatch", {
    file_key_id: fileKeyId,
    held_key_id: heldKeyId,
  });
}

export const readSensitiveCommand = defineCommand<SensitiveFileRead>({
  name: "read_sensitive",
  audience: "agent",
  description:
    "Read a file of the Salle (`area: salle`) or of the memory (`area: memory`), decrypted with the product key: these files are stored encrypted, never read them directly. `path` is relative to the area (for example `lessons.md`), without `..`. At most 256 KiB. A file found in clear is refused (SENSITIVE_NOT_ENCRYPTED): tell the creator. The lessons (`memory/lessons/`, `memory/retros/`) are read with `read_memory`, never here.",
  inputSchema: ReadSensitiveInputSchema,
  async run(context, input) {
    const parsed = ReadSensitiveInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("read_sensitive", parsed.error));
    const { agent, area } = parsed.data;
    const path = parsed.data.path.normalize("NFC");
    // The lessons are served by `read_memory` only, which serves what the creator approved, for
    // the agent they are for: never the raw files, retired or planted ones included.
    if (area === "memory" && isReservedMemoryPath(path)) {
      return fail(
        badPath(
          "read_sensitive",
          "memory/lessons/ and memory/retros/ are read with read_memory, which serves the lessons the creator approved",
        ),
      );
    }
    const target = await agentWriteContext(context, agent);
    if (target instanceof AgentPluggedError) return fail(target);
    let key: ProductKey | undefined;
    try {
      const refused = await checkSensitivePath(context.files, "read_sensitive", area, path);
      if (refused !== undefined) return fail(refused);
      const file = workspacePath(area, path);
      if (!(await context.files.exists(file))) {
        return fail(badPath("read_sensitive", `no file at ${area}/${path}`));
      }
      const text = await context.files.readText(file);
      if (encryptedFileKeyId(text) === undefined) {
        return fail(
          new AgentPluggedError(
            ErrorCode.SENSITIVE_NOT_ENCRYPTED,
            "error.sensitive_not_encrypted",
            {
              area,
              path,
            },
          ),
        );
      }
      key = await sensitiveKey(context, target.journal, target.product);
      // The key the file names: the current one, or one kept from before a renewal.
      const fileKeyId = encryptedFileKeyId(text) ?? "";
      const fileKey = await productKeyById(key, fileKeyId);
      if (fileKey === undefined) return fail(fileKeyMismatch(fileKeyId, key.keyId));
      const opened = await decryptFile(text, fileBinding(target.product, area, path), fileKey.key);
      if (!opened.ok) {
        if (opened.reason === "other_key") {
          return fail(fileKeyMismatch(fileKeyId, key.keyId));
        }
        return fail(
          new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
            reason: `read_sensitive: ${area}/${path} does not decrypt (altered, or moved from another path or product)`,
          }),
        );
      }
      if (utf8Length(opened.content) > MAX_SENSITIVE_CONTENT_BYTES) {
        return fail(badPath("read_sensitive", "the file is larger than 256 KiB"));
      }
      return ok({ area, path, content: opened.content });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    } finally {
      await forgetProductKey(key);
    }
  },
});

export const writeSensitiveCommand = defineCommand<SensitiveFileWritten>({
  name: "write_sensitive",
  audience: "agent",
  description:
    "Write a file of the Salle (`area: salle`) or of the memory (`area: memory`): it is stored encrypted with the product key, replacing any previous content. `path` is relative to the area (for example `lessons.md`), without `..`. At most 256 KiB of UTF-8. Never write these folders directly. `memory/lessons/` and `memory/retros/` are written by the engine only (propose_retrospective, record_lessons): refused here.",
  inputSchema: WriteSensitiveInputSchema,
  async run(context, input) {
    const parsed = WriteSensitiveInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("write_sensitive", parsed.error));
    const { agent, area, content } = parsed.data;
    const path = parsed.data.path.normalize("NFC");
    // The lessons and retrospectives of `memory/` are written by the engine, once the creator
    // approved them: never by an agent's own write.
    if (area === "memory" && isReservedMemoryPath(path)) {
      return fail(
        badPath(
          "write_sensitive",
          "memory/lessons/ and memory/retros/ are written by the engine, after the creator approves a retrospective (propose_retrospective)",
        ),
      );
    }
    const target = await agentWriteContext(context, agent);
    if (target instanceof AgentPluggedError) return fail(target);
    let key: ProductKey | undefined;
    try {
      const refused = await checkSensitivePath(context.files, "write_sensitive", area, path);
      if (refused !== undefined) return fail(refused);
      key = await sensitiveKey(context, target.journal, target.product);
      const sealed = await encryptFile(content, fileBinding(target.product, area, path), key.key);
      await context.files.writeText(workspacePath(area, path), sealed);
      return ok({ area, path, bytes: utf8Length(content) });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    } finally {
      await forgetProductKey(key);
    }
  },
});

/** The sensitive file tools, exposed to agents after the activity tools. */
export const sensitiveCommands = [readSensitiveCommand, writeSensitiveCommand] as const;
