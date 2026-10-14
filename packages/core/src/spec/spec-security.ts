import { fromUtf8 } from "@agentplugged/crypto";
import { documentOwner } from "../agents/agent-aliases.js";
import { statusAt } from "../checkpoints/resolution-rules.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { METHOD_DIR } from "../init/layout.js";
import {
  type ArchitectureReview,
  designSecurityReviewGap,
  isBlobOf,
  reviewsSince,
  SECURITY_REVIEWER,
} from "../phases/design-review.js";
import type { AgentState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";

/**
 * The security review of the short path's design. The short path has no
 * architecture, so Chloé reviews the spec, with the same skill, the same result line (the blob
 * cited as `architecture=` is the spec's) and the same consequences. Pure functions, read by `next`.
 */

/** Chloé's review of the spec, as the skill writes it. */
export const SPEC_SECURITY_REVIEW_PATH = `${METHOD_DIR}/docs/security-reviews/spec.md`;

/** The answer of Chloé's decision point that accepts the findings: the creator's own word. */
export const ACCEPT_OPTION = "accept";

/** What `next` does about the spec's security review: call Chloé, or wait for the creator. */
export type SpecSecurityGate =
  | { readonly kind: "call" }
  | { readonly kind: "invalid_date" }
  | { readonly kind: "wait"; readonly checkpoint: CheckpointState };

/** The reviews of exactly this version of the spec (every verdict). */
function reviewsOfSpec(
  agents: Readonly<Record<string, AgentState | undefined>>,
  spec: Uint8Array,
): ArchitectureReview[] {
  const reviews = reviewsSince(agents, null);
  return reviews === "invalid_date"
    ? []
    : reviews.filter((review) => isBlobOf(review.architecture, spec));
}

/**
 * What the spec still needs, or undefined when its review is done and its findings answered.
 * Called when Chloé is an active agent (else the short path is as the full one: no reviewer, no
 * gate). In order: a review of this very version of the spec, whose document is in the working
 * copy as submitted and says `owner: chloe` (a line alone is not a review); then, on a blocking
 * verdict (any review of this version is enough: a later, milder one does not cancel it), the
 * creator's answer to the decision Chloé opened after it, and that answer must accept the risk.
 */
export function specSecurityGate(input: {
  readonly active: ReadonlySet<string> | readonly string[];
  readonly agents: Readonly<Record<string, AgentState | undefined>>;
  readonly spec: Uint8Array;
  /** The bytes of `SPEC_SECURITY_REVIEW_PATH` in the working copy, or null. */
  readonly review: Uint8Array | null;
  readonly checkpoints: readonly CheckpointState[];
  readonly now: number;
}): SpecSecurityGate | undefined {
  const gap = designSecurityReviewGap({
    active: input.active,
    agents: input.agents,
    since: null,
    architecture: input.spec,
  });
  if (gap === undefined && !isActive(input.active)) return undefined;
  if (gap === "invalid_date") return { kind: "invalid_date" };
  if (gap !== undefined) return { kind: "call" };
  const covering = reviewsOfSpec(input.agents, input.spec);
  const file = input.review;
  if (file === null || !covering.some((review) => isBlobOf(review.review, file))) {
    return { kind: "call" };
  }
  const owner = parseDocumentFile(SPEC_SECURITY_REVIEW_PATH, fromUtf8(file) ?? "").owner?.value;
  if (owner === undefined || documentOwner(owner) !== SECURITY_REVIEWER) return { kind: "call" };
  const blocking = covering
    .filter((review) => review.verdict === "blocking")
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (blocking === undefined) return undefined;
  const reviewedAt = Date.parse(blocking.at);
  const decisions = input.checkpoints.filter(
    (checkpoint) =>
      checkpoint.opened_by === SECURITY_REVIEWER &&
      checkpoint.type === "decision" &&
      checkpoint.story === null &&
      Date.parse(checkpoint.opened_at) >= reviewedAt,
  );
  const waiting = decisions.find((checkpoint) => statusAt(checkpoint, input.now) === "open");
  if (waiting !== undefined) return { kind: "wait", checkpoint: waiting };
  const accepted = decisions.some(
    (checkpoint) =>
      statusAt(checkpoint, input.now) === "resolved" &&
      checkpoint.resolution?.decision === "option_chosen" &&
      checkpoint.resolution.option === ACCEPT_OPTION,
  );
  // Any other answer leaves the findings standing: Chloé is called to put them to the creator again
  // (the spec corrected is another version, reviewed again; the full path lifts the gate).
  return accepted ? undefined : { kind: "call" };
}

function isActive(active: ReadonlySet<string> | readonly string[]): boolean {
  return active instanceof Set
    ? active.has(SECURITY_REVIEWER)
    : (active as readonly string[]).includes(SECURITY_REVIEWER);
}
