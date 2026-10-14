import { sha256Hex } from "@agentplugged/crypto";
import type { FreeChange } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { deliveryRemote } from "../stories/pull-request.js";
import { forgeRepositoryOf } from "../stories/story-forge.js";
import type { FreeDiffRequest } from "./review-diff.js";

/**
 * The free review: a change that belongs to no story, read with the same lenses and a
 * judge on the intent given in one sentence. Where its diff comes from (`parseSource`, `readFree`)
 * and how it is named (`freeIdOf`) are decided here, pure or through the ports; the commands write
 * the cache and the journal.
 */

/** Where a free review reads its diff. */
export type FreeSource =
  | FreeDiffRequest
  | { readonly kind: "pr"; readonly number: number }
  | { readonly kind: "pasted" };

/** A ref a free review names: never an option, never a range. */
const REF = /^[A-Za-z0-9_][\w./@{}^~+-]{0,199}$/;

/**
 * The source a free review reads, from the words of `start_review`: `uncommitted`, `pr:<number>`,
 * `branch:<name>` (against the main branch), or a range of commits `<from>..<to>` / `<from>...<to>`.
 * Undefined when it is none of these (a ref that could pass for an option is refused).
 */
export function parseSource(source: string): FreeSource | undefined {
  const text = source.trim();
  if (text === "uncommitted") return { kind: "uncommitted" };
  const pr = /^pr:#?([1-9]\d{0,8})$/i.exec(text);
  if (pr !== null) return { kind: "pr", number: Number(pr[1]) };
  const branch = /^branch:(.+)$/i.exec(text);
  if (branch !== null) {
    const name = (branch[1] as string).trim();
    return REF.test(name) && !name.includes("..") ? { kind: "branch", name } : undefined;
  }
  const range = /^(.+?)(\.{2,3})(.+)$/.exec(text);
  if (range !== null && (range[2] as string).length <= 3) {
    const from = (range[1] as string).trim();
    const to = (range[3] as string).trim();
    if (REF.test(from) && REF.test(to) && !from.includes("..") && !to.includes("..")) {
      return { kind: "range", from, to, dots: range[2] as ".." | "..." };
    }
  }
  return undefined;
}

/** How a source is named in the journal and to the creator. */
export function sourceLabel(source: FreeSource): string {
  switch (source.kind) {
    case "uncommitted":
      return "uncommitted work";
    case "pasted":
      return "pasted diff";
    case "pr":
      return `pr:${source.number}`;
    case "branch":
      return `branch:${source.name}`;
    case "range":
      return `${source.from}${source.dots}${source.to}`;
  }
}

/**
 * What names a free review: the hash of the diff read and of the intent it is judged against (64
 * hexadecimal characters, like a commit id). Another intent is another review of the same diff.
 */
export function freeIdOf(diff: string, intent: string): string {
  return sha256Hex(`${intent}\0${diff}`);
}

/** What a free review read. */
export interface FreeRead {
  readonly label: string;
  readonly diff: string;
  /** The messages of the commits it holds, or empty. */
  readonly messages: string;
}

/** Why a free review cannot read its diff: a short code and a few words. */
export interface FreeProblem {
  readonly why: string;
}

/** Looks like a unified diff the lenses can read: at least one `diff --git` header. */
export function isUnifiedDiff(text: string): boolean {
  return /^diff --git /m.test(text);
}

/**
 * Reads the diff of a free review. A pasted diff is the text itself; the others go through Git or
 * the forge (the agent never runs `git` nor `gh` for it). A problem says why, in few words.
 */
export async function readFree(
  context: CommandContext,
  input: Pick<FreeChange, "source" | "diff">,
): Promise<FreeRead | FreeProblem> {
  if (input.diff !== undefined) {
    return isUnifiedDiff(input.diff)
      ? { label: sourceLabel({ kind: "pasted" }), diff: input.diff, messages: "" }
      : { why: "the pasted text is not a git diff (no `diff --git` header)" };
  }
  const source = input.source === undefined ? undefined : parseSource(input.source);
  if (source === undefined) {
    return {
      why: "the source is none of `uncommitted`, `<from>..<to>`, `branch:<name>`, `pr:<number>`",
    };
  }
  const label = sourceLabel(source);
  if (source.kind === "pr") return await readPullRequest(context, source.number, label);
  if (source.kind === "pasted") return { why: "no diff given" };
  const reader = context.storyDiff?.free;
  if (reader === undefined) return { why: "Git cannot be read here" };
  const read = await reader.call(context.storyDiff, source).catch(() => undefined);
  if (read === undefined) return { why: `Git cannot read ${label}` };
  return isUnifiedDiff(read.diff)
    ? { label, diff: read.diff, messages: read.messages }
    : { why: `${label} has no change to review` };
}

async function readPullRequest(
  context: CommandContext,
  number: number,
  label: string,
): Promise<FreeRead | FreeProblem> {
  const forge = context.storyForge;
  if (forge?.inspectMain === undefined || forge.pullRequestDiff === undefined) {
    return { why: "the forge cannot be read here" };
  }
  try {
    const main = await forge.inspectMain();
    const remotes = main.repository ? (main.remotes ?? []) : [];
    const remote = deliveryRemote(remotes, "origin/main");
    if (remote === undefined) return { why: "no remote of the repository is on a known forge" };
    const located = forgeRepositoryOf(remote.url);
    if (!("forge" in located)) {
      return { why: "no remote of the repository is on a known forge" };
    }
    if ((await forge.cli(located)) !== "ready") {
      return { why: `the forge's tool is missing or logged out for ${located.host}` };
    }
    const diff = await forge.pullRequestDiff(located, number);
    return isUnifiedDiff(diff)
      ? { label, diff, messages: "" }
      : { why: `${label} has no change to review` };
  } catch {
    return { why: `the forge could not give ${label}` };
  }
}
