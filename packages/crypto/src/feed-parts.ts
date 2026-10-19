import { FEED_PARTS_MAX, type FeedPart, FeedPartSchema } from "@agentplugged/protocol";
import { fromBase64url, toBase64url } from "./encoding.js";
import { sha256 } from "./hash.js";

/**
 * A snapshot or a change larger than what the relay carries in one envelope is cut into parts,
 * each sent as its own message. The receiver puts them together and checks the fingerprint of the
 * whole before it uses it: a part that is missing, altered or foreign makes the whole be dropped,
 * and the receiver asks again.
 */

/** The fingerprint of a whole content, in the form a part carries it. */
export function contentDigest(content: Uint8Array): string {
  return toBase64url(sha256(content));
}

/**
 * Cuts `content` into parts of at most `maxPartBytes` bytes each (at least one part). `id` is the
 * same for all of them.
 */
export function splitIntoParts(content: Uint8Array, id: string, maxPartBytes: number): FeedPart[] {
  if (!Number.isSafeInteger(maxPartBytes) || maxPartBytes < 1) {
    throw new RangeError("a part holds at least one byte");
  }
  if (content.length === 0) throw new RangeError("there is nothing to cut");
  const count = Math.ceil(content.length / maxPartBytes);
  if (count > FEED_PARTS_MAX) throw new RangeError("the content is too large to be cut into parts");
  const digest = contentDigest(content);
  const parts: FeedPart[] = [];
  for (let index = 0; index < count; index += 1) {
    parts.push({
      id,
      index,
      count,
      digest,
      data: toBase64url(content.subarray(index * maxPartBytes, (index + 1) * maxPartBytes)),
    });
  }
  return parts;
}

export type PartVerdict =
  | { readonly status: "incomplete" }
  | { readonly status: "complete"; readonly id: string; readonly content: Uint8Array }
  /** The whole does not match its fingerprint, or the parts disagree: dropped, to ask again. */
  | { readonly status: "rejected"; readonly id: string; readonly reason: PartRejection }
  | { readonly status: "ignored" };

export type PartRejection = "digest_mismatch" | "inconsistent" | "malformed";

interface Group {
  readonly count: number;
  readonly digest: string;
  readonly parts: Map<number, string>;
  readonly startedAt: number;
}

export interface PartAssemblerOptions {
  /** How many messages may be put together at the same time; the oldest is dropped beyond that. */
  readonly maxGroups?: number;
  /** The largest whole, in bytes, the assembler agrees to build. */
  readonly maxBytes?: number;
}

/** Puts parts together. Pure state, nothing is written anywhere. */
export class PartAssembler {
  readonly #groups = new Map<string, Group>();
  readonly #maxGroups: number;
  readonly #maxBytes: number;

  constructor(options: PartAssemblerOptions = {}) {
    this.#maxGroups = options.maxGroups ?? 8;
    this.#maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  }

  /** The messages that wait for parts, oldest first. */
  waiting(): ReadonlyArray<{ id: string; startedAt: number }> {
    return [...this.#groups].map(([key, group]) => ({
      id: key.slice(key.indexOf("|") + 1),
      startedAt: group.startedAt,
    }));
  }

  /** Drops what waited since before `before` (the clock of the caller); returns how many. */
  expire(before: number): number {
    let dropped = 0;
    for (const [id, group] of this.#groups) {
      if (group.startedAt < before) {
        this.#groups.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Drops everything that waits (the connection was lost, the view asks again). */
  clear(): void {
    this.#groups.clear();
  }

  /** `scope` names who sent the part: two senders' parts never mix, whatever their ids. */
  add(value: unknown, now: number, scope = ""): PartVerdict {
    const parsed = FeedPartSchema.safeParse(value);
    if (!parsed.success) return { status: "rejected", id: "", reason: "malformed" };
    const part = parsed.data;
    if (part.index >= part.count) {
      return { status: "rejected", id: part.id, reason: "malformed" };
    }
    const key = `${scope}|${part.id}`;
    let group = this.#groups.get(key);
    if (group === undefined) {
      group = { count: part.count, digest: part.digest, parts: new Map(), startedAt: now };
      this.#groups.set(key, group);
      while (this.#groups.size > this.#maxGroups) {
        const oldest = this.#groups.keys().next().value;
        if (oldest === undefined) break;
        this.#groups.delete(oldest);
      }
    }
    if (group.count !== part.count || group.digest !== part.digest) {
      this.#groups.delete(key);
      return { status: "rejected", id: part.id, reason: "inconsistent" };
    }
    const known = group.parts.get(part.index);
    if (known !== undefined) {
      // A part seen again is the same one, or the message is not what it claims.
      if (known === part.data) return { status: "ignored" };
      this.#groups.delete(key);
      return { status: "rejected", id: part.id, reason: "inconsistent" };
    }
    group.parts.set(part.index, part.data);
    if (group.parts.size < group.count) return { status: "incomplete" };

    this.#groups.delete(key);
    const pieces: Uint8Array[] = [];
    let total = 0;
    for (let index = 0; index < group.count; index += 1) {
      const bytes = fromBase64url(group.parts.get(index) as string);
      if (bytes === undefined) return { status: "rejected", id: part.id, reason: "malformed" };
      total += bytes.length;
      if (total > this.#maxBytes) return { status: "rejected", id: part.id, reason: "malformed" };
      pieces.push(bytes);
    }
    const content = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) {
      content.set(piece, offset);
      offset += piece.length;
    }
    if (contentDigest(content) !== group.digest) {
      return { status: "rejected", id: part.id, reason: "digest_mismatch" };
    }
    return { status: "complete", id: part.id, content };
  }
}
