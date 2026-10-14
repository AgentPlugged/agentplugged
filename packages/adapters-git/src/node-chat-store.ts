import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@agentplugged/crypto";

/**
 * What the readers of the chat store have in common (`~/.agentplugged/chat/`, written by the
 * hooks): the folder, the file of a session, a date as the hook writes it, and the lines of a file.
 */

/** A date as the hook writes it (`toISOString`). */
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A SHA-256 as hexadecimal text. */
export const HEX_DIGEST = /^[0-9a-f]{64}$/;

/** The store's folder: `dir` is for tests only, the engine never reads another one. */
export function chatStoreDir(dir: string | undefined): string {
  return dir ?? join(homedir(), ".agentplugged", "chat");
}

/** The text of the file the hook keeps for `session` (`<32 hex of its SHA-256><suffix>`), or undefined. */
export async function readSessionFile(
  dir: string,
  session: string,
  suffix: string,
): Promise<string | undefined> {
  const name = `${sha256Hex(session).slice(0, 32)}${suffix}`;
  try {
    return await readFile(join(dir, name), "utf8");
  } catch {
    return undefined;
  }
}

/** The JSON lines of a store file; a line cut by a crash, or blank, is left out. */
export function jsonLines(text: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry: unknown = JSON.parse(line);
      // A line that parses to `null` or to a value that is not an object proves nothing.
      if (typeof entry === "object" && entry !== null)
        entries.push(entry as Record<string, unknown>);
    } catch {
      // A line cut by a crash: left out.
    }
  }
  return entries;
}
