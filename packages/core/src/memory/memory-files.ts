import {
  commonMemoryKey,
  decryptFile,
  encryptedFileKeyId,
  encryptFile,
  wipeBytes,
} from "@agentplugged/crypto";
import { CommonLessonIdSchema, ErrorCode, type MemoryInvalidReason } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { readMachineKey } from "../journal/key-store.js";
import { fileBinding, workspacePath } from "../sensitive/sensitive-files.js";
import type { CommonMemory } from "./common-memory.js";
import { type LessonRecord, lessonFile, parseLessonRecord, recordDigest } from "./memory-rules.js";

/**
 * The files of the memory: the lessons of a product in `.agentplugged/memory/lessons/`
 * (encrypted with the product key, bound to the product and the path) and the entries
 * of the common memory (encrypted with the key derived from the machine key). Every read checks
 * what it decrypts: a lesson against the digest the journal anchors, an entry against its id.
 */

/** The prefixes of `memory/` the engine alone writes: agents never write them directly. */
export const RESERVED_MEMORY_PREFIXES = ["lessons/", "retros/"] as const;

/** True when `path` (inside `memory/`) is one the engine writes (NFC, any case). */
export function isReservedMemoryPath(path: string): boolean {
  const lower = path.normalize("NFC").toLowerCase();
  return RESERVED_MEMORY_PREFIXES.some(
    (prefix) => lower === prefix.slice(0, -1) || lower.startsWith(prefix),
  );
}

/** `MEMORY_INVALID` with its reason, and what names the thing. */
export function memoryInvalid(
  reason: MemoryInvalidReason,
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.MEMORY_INVALID, `error.memory_invalid.${reason}`, {
    reason,
    ...details,
  });
}

/** The product id common-memory files are bound to (never a product's). */
export const COMMON_BINDING_PRODUCT = "common-memory";

function commonBinding(id: string) {
  return { productId: COMMON_BINDING_PRODUCT, path: `.agentplugged/memory/${id}.json` };
}

/** What a lesson's file holds, written encrypted (the whole record, digest-covered). */
export async function writeLessonFile(
  context: CommandContext,
  product: string,
  key: Uint8Array,
  record: LessonRecord,
): Promise<void> {
  const text = `${JSON.stringify(record)}\n`;
  const sealed = await encryptFile(
    text,
    fileBinding(product, "memory", lessonFile(record.id)),
    key,
  );
  await context.files.writeText(workspacePath("memory", lessonFile(record.id)), sealed);
}

export type LessonRead =
  | { readonly ok: true; readonly record: LessonRecord }
  | { readonly ok: false; readonly reason: "missing" | "altered" };

/** A lesson's file, decrypted and checked against the digest the journal anchors. */
export async function readLessonFile(
  context: CommandContext,
  product: string,
  key: Uint8Array,
  id: string,
  digest: string,
): Promise<LessonRead> {
  const path = workspacePath("memory", lessonFile(id));
  let text: string;
  try {
    if (!(await context.files.exists(path))) return { ok: false, reason: "missing" };
    text = await context.files.readText(path);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (encryptedFileKeyId(text) === undefined) return { ok: false, reason: "altered" };
  const opened = await decryptFile(text, fileBinding(product, "memory", lessonFile(id)), key);
  if (!opened.ok) return { ok: false, reason: "altered" };
  const record = parseLessonRecord(opened.content);
  if (record === undefined || record.id !== id || recordDigest(record) !== digest) {
    return { ok: false, reason: "altered" };
  }
  return { ok: true, record };
}

/** The ids of the files of `memory/lessons/` (without `.json`), for the unanchored ones. */
export async function lessonFileIds(context: CommandContext): Promise<string[]> {
  const prefix = `${workspacePath("memory", "lessons")}/`;
  try {
    return (await context.files.listFiles(workspacePath("memory", "lessons")))
      .map((file) => file.normalize("NFC").replaceAll("\\", "/"))
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length));
  } catch {
    return [];
  }
}

/** One entry of the common memory, as its file holds it. */
export interface CommonEntry {
  readonly v: 1;
  readonly id: string;
  readonly status: "active" | "superseded" | "retired";
  readonly title: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly agents: readonly string[];
  readonly origin: {
    readonly product: string;
    readonly lesson: string;
    readonly checkpoint: string;
  };
  readonly promoted_at: string;
  readonly superseded_by?: string;
}

function parseEntry(text: string): CommonEntry | undefined {
  try {
    const value = JSON.parse(text) as Partial<CommonEntry>;
    if (
      value.v === 1 &&
      typeof value.id === "string" &&
      CommonLessonIdSchema.safeParse(value.id).success &&
      (value.status === "active" || value.status === "superseded" || value.status === "retired") &&
      typeof value.title === "string" &&
      typeof value.text === "string" &&
      Array.isArray(value.tags) &&
      Array.isArray(value.agents) &&
      typeof value.origin === "object" &&
      value.origin !== null &&
      typeof value.promoted_at === "string"
    ) {
      return value as CommonEntry;
    }
  } catch {
    // Not JSON.
  }
  return undefined;
}

/**
 * The key of the common memory of this machine, derived from the machine key; undefined when the
 * machine has none (never created here: reading never creates a key). Wipe it after use.
 */
export async function openCommonKey(context: CommandContext): Promise<Uint8Array | undefined> {
  const keys = context.keys ?? context.human?.keys;
  if (keys === undefined) return undefined;
  const machine = await readMachineKey(keys);
  if (machine === undefined) return undefined;
  try {
    return await commonMemoryKey(machine.secretKey);
  } finally {
    await wipeBytes(machine.secretKey);
  }
}

export type EntryRead =
  | { readonly ok: true; readonly entry: CommonEntry }
  | { readonly ok: false; readonly reason: "missing" | "altered" };

/** An entry of the common memory, decrypted and checked against its id. */
export async function readCommonEntry(
  memory: CommonMemory,
  key: Uint8Array,
  id: string,
): Promise<EntryRead> {
  const text = await memory.read(id);
  if (text === undefined) return { ok: false, reason: "missing" };
  if (encryptedFileKeyId(text) === undefined) return { ok: false, reason: "altered" };
  const opened = await decryptFile(text, commonBinding(id), key);
  if (!opened.ok) return { ok: false, reason: "altered" };
  const entry = parseEntry(opened.content);
  return entry === undefined || entry.id !== id
    ? { ok: false, reason: "altered" }
    : { ok: true, entry };
}

/** Writes an entry of the common memory, encrypted and bound to its id. */
export async function writeCommonEntry(
  memory: CommonMemory,
  key: Uint8Array,
  entry: CommonEntry,
): Promise<void> {
  await memory.write(
    entry.id,
    await encryptFile(`${JSON.stringify(entry)}\n`, commonBinding(entry.id), key),
  );
}
