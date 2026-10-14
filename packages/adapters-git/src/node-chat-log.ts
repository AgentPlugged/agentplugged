import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ChatLog,
  type ChatMessage,
  creatorText,
  messageDigest,
  normalizeChatText,
  sameProject,
} from "@agentplugged/core";
import {
  chatStoreDir,
  HEX_DIGEST,
  ISO_UTC,
  jsonLines,
  readSessionFile,
} from "./node-chat-store.js";

/**
 * The store of the creator's messages, as the Claude Code hook writes it:
 * `~/.agentplugged/chat/<first 32 hexadecimal characters of the SHA-256 of the session>.jsonl`,
 * one JSON line per message `{ v, session, at, digest, text }`. Read only: the engine never
 * writes it, and no MCP tool reaches it. A missing file, or a line that cannot be read, gives no
 * message; a line of another session (a hash collision) is left out.
 */
/** The hook's text cut (`MAX_TEXT`): its digest is the whole text's, which cannot be recomputed. */
const CUT_AT = 4000;

/**
 * What a line of the store proves: the creator's own text. A line an older hook
 * script recorded (a project not synchronised again yet, or a line written before the fix) may
 * hold the editor's context block before the typed text, or a text the tool injected (a
 * sub-agent's report, a notification): the block is removed (the digest follows the text), the
 * injected text is left out. A line already clean is returned as it is.
 */
function creatorLine(
  stored: string,
  digest: string,
): { readonly text: string; readonly digest: string } | undefined {
  const clean = creatorText(stored, false);
  if (clean === undefined) return undefined;
  if (clean === stored) return { text: stored, digest };
  if (stored.length >= CUT_AT) return undefined;
  const text = normalizeChatText(clean);
  return text === "" ? undefined : { text, digest: messageDigest(text) };
}

export class NodeChatLog implements ChatLog {
  readonly #dir: string;

  /**
   * `dir` is for tests only: the engine reads `~/.agentplugged/chat`, the one folder the deny
   * rules protect, never a folder an environment variable could move.
   */
  constructor(options: { readonly dir?: string } = {}) {
    this.#dir = chatStoreDir(options.dir);
  }

  /** The store's folder. */
  get dir(): string {
    return this.#dir;
  }

  async hasMessageFrom(project: string, via: string): Promise<boolean> {
    let names: string[];
    try {
      names = (await readdir(this.#dir)).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return false;
    }
    for (const name of names) {
      let text: string;
      try {
        text = await readFile(join(this.#dir, name), "utf8");
      } catch {
        continue;
      }
      for (const entry of jsonLines(text)) {
        if (
          entry.v === 1 &&
          entry.via === via &&
          typeof entry.project === "string" &&
          sameProject(entry.project, project)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  async messages(session: string): Promise<readonly ChatMessage[]> {
    const text = await readSessionFile(this.#dir, session, ".jsonl");
    if (text === undefined) return [];
    const messages: { readonly message: ChatMessage; readonly via: string }[] = [];
    for (const entry of jsonLines(text)) {
      if (
        entry.v === 1 &&
        entry.session === session &&
        typeof entry.at === "string" &&
        ISO_UTC.test(entry.at) &&
        typeof entry.digest === "string" &&
        HEX_DIGEST.test(entry.digest) &&
        typeof entry.text === "string"
      ) {
        const kept = creatorLine(entry.text, entry.digest);
        if (kept === undefined) continue;
        messages.push({
          message: {
            session,
            at: entry.at,
            digest: kept.digest,
            text: kept.text,
            ...(typeof entry.project === "string" ? { project: entry.project } : {}),
          },
          via: typeof entry.via === "string" ? entry.via : "",
        });
      }
    }
    return withoutTwins(messages);
  }
}

/**
 * Two hooks may record one message at the same moment: Cursor runs the project's hook (its lines
 * carry `via: "cursor"`) and, when Claude Code is targeted too, the one written for Claude Code (no
 * `via`), in parallel. The same text of one session, recorded by the two within this delay, is one
 * message: otherwise it could answer two points. Two lines of one writer are never merged.
 */
const TWIN_MS = 5000;

function withoutTwins(
  entries: readonly { readonly message: ChatMessage; readonly via: string }[],
): ChatMessage[] {
  const kept: { readonly message: ChatMessage; readonly via: string }[] = [];
  for (const entry of entries) {
    const at = Date.parse(entry.message.at);
    const twin = kept.some(
      (other) =>
        other.message.digest === entry.message.digest &&
        other.via !== entry.via &&
        Math.abs(Date.parse(other.message.at) - at) <= TWIN_MS,
    );
    if (!twin) kept.push(entry);
  }
  return kept.map((entry) => entry.message);
}
