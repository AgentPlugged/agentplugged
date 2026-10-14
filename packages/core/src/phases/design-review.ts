import { fromUtf8, gitBlobId, utf8 } from "@agentplugged/crypto";
import type { ResultStatus } from "@agentplugged/protocol";
import { documentOwner } from "../agents/agent-aliases.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { METHOD_DIR } from "../init/layout.js";
import type { AgentState } from "../projection/agent-reducers.js";
import type { WorkspaceFiles } from "../workspace-files.js";

/**
 * The security review joined to the end of the design phase. While Chloé is an
 * active agent, the end of `design` cites the architecture and her review of it in `documents`,
 * and the review cited is one Chloé submitted during the phase, for that very architecture.
 * Pure functions, shared by `open_checkpoint` (which refuses) and `next` (which calls Chloé).
 *
 * Chloé submits her review with `submit_result` (`complete`, no story) whose summary starts with
 * one line the engine reads, `REVIEW_LINE`:
 * `Architecture security review: verdict=<no-blocking|blocking> findings=<n> blocking=<n>
 * review=<blob> architecture=<blob>`, the blobs being the Git object ids (`git hash-object`) of
 * the review and of the architecture it reviewed.
 */

/** The agent whose review joins the end of the design phase. */
export const SECURITY_REVIEWER = "chloe";

/** Chloé's security review of the architecture, as `documents` of the checkpoint cite it. */
export const ARCHITECTURE_SECURITY_REVIEW_PATH = `${METHOD_DIR}/docs/security-reviews/architecture.md`;

/** The architecture, as `documents` of the checkpoint cite it. */
export const ARCHITECTURE_PATH = `${METHOD_DIR}/docs/architecture.md`;

/** How the first line of Chloé's result summary starts when it is the review of the architecture. */
export const REVIEW_LINE_PREFIX = "Architecture security review:";

const BLOB = "([0-9a-f]{40}|[0-9a-f]{64})";
const REVIEW_LINE = new RegExp(
  `^Architecture security review: verdict=(no-blocking|blocking) findings=(\\d{1,4}) blocking=(\\d{1,4}) review=${BLOB} architecture=${BLOB}$`,
);

/** The verdict of a review: no blocking finding, or blocking findings to fix before approval. */
export type ReviewVerdict = "no-blocking" | "blocking";

/** A review of the architecture Chloé submitted, read from her result. */
export interface ArchitectureReview {
  readonly verdict: ReviewVerdict;
  readonly findings: number;
  readonly blocking: number;
  /** Git object id of the review document submitted. */
  readonly review: string;
  /** Git object id of the architecture it reviewed. */
  readonly architecture: string;
  readonly status: ResultStatus;
  readonly at: string;
}

/**
 * The review a result's summary announces on its first line, or undefined: the line must match
 * exactly, and the verdict agree with the counts (`blocking` exactly when a finding blocks).
 */
export function parseReviewLine(
  summary: string,
): Omit<ArchitectureReview, "status" | "at"> | undefined {
  const first = summary.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = REVIEW_LINE.exec(first);
  if (match === null) return undefined;
  const verdict = match[1] as ReviewVerdict;
  const findings = Number(match[2]);
  const blocking = Number(match[3]);
  if (blocking > findings || (verdict === "blocking") !== blocking > 0) return undefined;
  return {
    verdict,
    findings,
    blocking,
    review: match[4] as string,
    architecture: match[5] as string,
  };
}

/** What the end of the design phase still lacks of the security review. */
export type SecurityReviewGap =
  /** Chloé submitted no review of the architecture during the phase. */
  | "not_submitted"
  /** A date of the journal cannot be read: nothing is assumed. */
  | "invalid_date"
  /** A document cites the review or the architecture with another case: give the exact path. */
  | "path_case"
  /** The review is not among the documents. */
  | "not_attached"
  /** The architecture is not among the documents. */
  | "architecture_not_attached"
  /** The review cited is not one Chloé submitted during the phase. */
  | "review_mismatch"
  /** The review cited covers another version of the architecture than the one cited. */
  | "stale"
  /** The working copy has no review file. */
  | "review_file_missing"
  /** The review file of the working copy is not the version cited. */
  | "review_file_changed"
  /** The review file's header does not say `owner: chloe`. */
  | "review_not_security_reviewer"
  /** The architecture of the working copy is not the version cited. */
  | "architecture_changed";

/** A path with `/` as separator, for comparison. */
function normalized(path: string): string {
  return path.replaceAll("\\", "/");
}

/** The time of `at`, or NaN when it cannot be read. */
function time(at: string): number {
  return Date.parse(at);
}

/**
 * Chloé's reviews of the architecture that count: `complete`, without a story (the reducer only
 * keeps those), recorded at or after `since`. `invalid_date` when a date cannot be read.
 */
export function reviewsSince(
  agents: Readonly<Record<string, AgentState | undefined>>,
  since: string | null,
): ArchitectureReview[] | "invalid_date" {
  const agent = Object.hasOwn(agents, SECURITY_REVIEWER) ? agents[SECURITY_REVIEWER] : undefined;
  const reviews = Object.values(agent?.architecture_reviews ?? {});
  const start = since === null ? Number.NEGATIVE_INFINITY : time(since);
  if (Number.isNaN(start)) return "invalid_date";
  const counted: ArchitectureReview[] = [];
  for (const review of reviews) {
    const at = time(review.at);
    if (Number.isNaN(at)) return "invalid_date";
    if (review.status === "complete" && at >= start) counted.push(review);
  }
  return counted;
}

/** The working copy as the check of an opened end reads it: the two files, or null. */
export interface DesignWorkingCopy {
  readonly review: Uint8Array | null;
  readonly architecture: Uint8Array | null;
}

/** True when `blob` is the Git object id of `bytes`, as written or with LF line endings. */
export function isBlobOf(blob: string, bytes: Uint8Array): boolean {
  const algorithm = blob.length === 64 ? "sha256" : "sha1";
  if (gitBlobId(bytes, algorithm) === blob) return true;
  const text = fromUtf8(bytes);
  if (text === undefined || !text.includes("\r\n")) return false;
  return gitBlobId(utf8(text.replaceAll("\r\n", "\n")), algorithm) === blob;
}

/**
 * What the end of the design phase lacks, or undefined. Nothing when Chloé is not active. Else,
 * in order: a review submitted during the phase; with `documents`, the review and the
 * architecture cited at their exact paths, the review cited being one Chloé submitted for the
 * architecture cited; with `workingCopy`, both files being the versions cited and the review's
 * header naming Chloé as owner. `architecture` (for `next`): the bytes of the working copy's
 * architecture, which some review must cover.
 */
export function designSecurityReviewGap(input: {
  /** The active agents of the product. */
  readonly active: ReadonlySet<string> | readonly string[];
  /** The agents of the projection (`state.agents`). */
  readonly agents: Readonly<Record<string, AgentState | undefined>>;
  /** When the design phase began, or null. */
  readonly since: string | null;
  /** The documents the checkpoint cites, when one is being opened. */
  readonly documents?: readonly { readonly path: string; readonly blob_sha: string }[];
  /** The files of the working copy, when one is being opened. */
  readonly workingCopy?: DesignWorkingCopy;
  /** The bytes of the working copy's architecture, for `next`. */
  readonly architecture?: Uint8Array;
}): SecurityReviewGap | undefined {
  const active =
    input.active instanceof Set
      ? input.active.has(SECURITY_REVIEWER)
      : (input.active as readonly string[]).includes(SECURITY_REVIEWER);
  if (!active) return undefined;
  const reviews = reviewsSince(input.agents, input.since);
  if (reviews === "invalid_date") return "invalid_date";
  if (reviews.length === 0) return "not_submitted";
  if (
    input.architecture !== undefined &&
    !reviews.some((review) => isBlobOf(review.architecture, input.architecture as Uint8Array))
  ) {
    return "stale";
  }
  const documents = input.documents;
  if (documents === undefined) return undefined;
  const find = (path: string) => {
    const exact = documents.find((document) => normalized(document.path) === path);
    if (exact !== undefined) return exact;
    const other = documents.find(
      (document) => normalized(document.path).toLowerCase() === path.toLowerCase(),
    );
    return other === undefined ? undefined : ("path_case" as const);
  };
  const cited = find(ARCHITECTURE_SECURITY_REVIEW_PATH);
  const architecture = find(ARCHITECTURE_PATH);
  if (cited === "path_case" || architecture === "path_case") return "path_case";
  if (cited === undefined) return "not_attached";
  if (architecture === undefined) return "architecture_not_attached";
  const matching = reviews.filter((review) => review.review === cited.blob_sha);
  if (matching.length === 0) return "review_mismatch";
  if (!matching.some((review) => review.architecture === architecture.blob_sha)) return "stale";
  const files = input.workingCopy;
  if (files === undefined) return undefined;
  if (files.review === null) return "review_file_missing";
  if (!isBlobOf(cited.blob_sha, files.review)) return "review_file_changed";
  const header = parseDocumentFile(ARCHITECTURE_SECURITY_REVIEW_PATH, fromUtf8(files.review) ?? "");
  // A review written before the renaming names the former identifier.
  const owner = header.owner?.value;
  if (owner === undefined || documentOwner(owner) !== SECURITY_REVIEWER) {
    return "review_not_security_reviewer";
  }
  if (files.architecture === null || !isBlobOf(architecture.blob_sha, files.architecture)) {
    return "architecture_changed";
  }
  return undefined;
}

/** The review a checkpoint cites, among those Chloé submitted (any time), or undefined. */
export function citedReview(
  agents: Readonly<Record<string, AgentState | undefined>>,
  documents: readonly { readonly path: string; readonly blob_sha: string }[],
): ArchitectureReview | undefined {
  const cited = documents.find(
    (document) => normalized(document.path) === ARCHITECTURE_SECURITY_REVIEW_PATH,
  );
  if (cited === undefined) return undefined;
  const agent = Object.hasOwn(agents, SECURITY_REVIEWER) ? agents[SECURITY_REVIEWER] : undefined;
  const reviews = agent?.architecture_reviews ?? {};
  return Object.hasOwn(reviews, cited.blob_sha) ? reviews[cited.blob_sha] : undefined;
}

/** The bytes of a file of the working copy, or null when it is missing or cannot be read. */
export async function readWorkingBytes(
  files: Pick<WorkspaceFiles, "exists" | "readBytes" | "readText">,
  path: string,
): Promise<Uint8Array | null> {
  if (!(await files.exists(path))) return null;
  try {
    return await files.readBytes(path);
  } catch {
    try {
      return utf8(await files.readText(path));
    } catch {
      return null;
    }
  }
}
