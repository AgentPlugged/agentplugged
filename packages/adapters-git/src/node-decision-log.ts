import type { DecisionLog, DecisionRecord } from "@agentplugged/core";
import {
  chatStoreDir,
  HEX_DIGEST,
  ISO_UTC,
  jsonLines,
  readSessionFile,
} from "./node-chat-store.js";

/**
 * The store of the creator's answers to the AI tool's question tool, as the
 * Claude Code hook writes it: `~/.agentplugged/chat/<first 32 hexadecimal characters of the SHA-256
 * of the session>.decisions.jsonl`, one JSON line per answered call `{ v, session, project, at,
 * fingerprint, answers: [{ question, answer, notes? }] }`. Read only: the engine never writes it, and
 * no MCP tool reaches it. A missing file, or a line that cannot be read, gives no record; a line of
 * another session (a hash collision) is left out.
 */

export class NodeDecisionLog implements DecisionLog {
  readonly #dir: string;

  /**
   * `dir` is for tests only: the engine reads `~/.agentplugged/chat`, the one folder the deny
   * rules protect, never a folder an environment variable could move.
   */
  constructor(options: { readonly dir?: string } = {}) {
    this.#dir = chatStoreDir(options.dir);
  }

  async records(session: string): Promise<readonly DecisionRecord[]> {
    const text = await readSessionFile(this.#dir, session, ".decisions.jsonl");
    if (text === undefined) return [];
    const records: DecisionRecord[] = [];
    for (const entry of jsonLines(text)) {
      if (
        entry.v !== 1 ||
        entry.session !== session ||
        typeof entry.at !== "string" ||
        !ISO_UTC.test(entry.at) ||
        typeof entry.fingerprint !== "string" ||
        !HEX_DIGEST.test(entry.fingerprint) ||
        !Array.isArray(entry.answers)
      ) {
        continue;
      }
      const answers: DecisionRecord["answers"][number][] = [];
      for (const raw of entry.answers) {
        const item = raw as Record<string, unknown>;
        if (typeof item?.question !== "string" || typeof item.answer !== "string") continue;
        answers.push({
          question: item.question,
          answer: item.answer,
          ...(typeof item.notes === "string" ? { notes: item.notes } : {}),
        });
      }
      records.push({
        session,
        at: entry.at,
        fingerprint: entry.fingerprint,
        answers,
        ...(typeof entry.project === "string" ? { project: entry.project } : {}),
        ...(entry.extra === true ? { extra: true as const } : {}),
      });
    }
    return records;
  }
}
