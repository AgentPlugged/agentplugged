import type {
  CheckpointOption,
  CheckpointRisk,
  CheckpointSource,
  CheckpointType,
  RecipientRole,
} from "@agentplugged/protocol";

/**
 * The `auto` level: the engine applies on its own the recommended option of
 * a low-risk `decision`, and the creator can reopen it. Never an irreversible action, and never
 * what the method keeps for the creator: a story's validation (before its merge), a document (it
 * validates stories), a release, a publication, a permission or the end of a phase. Never a
 * checkpoint the engine opened itself (a blocked result, an installation to validate, a forge to link),
 * one that supersedes a refused checkpoint, one with criteria, nor one for security
 * (what a session has read changes nothing).
 */

/**
 * The types the engine may answer on its own: a `decision` only. A `document` approval validates
 * stories, freezes their intent and puts a sprint in force: always the creator's.
 */
export const AUTO_TYPES: ReadonlySet<CheckpointType> = new Set(["decision"]);

/** What the rule reads of a checkpoint (an opened payload, or its projected state). */
export interface AutoCandidate {
  readonly type: CheckpointType;
  readonly risk: CheckpointRisk;
  readonly irreversible: boolean;
  readonly options?: readonly CheckpointOption[] | null | undefined;
  readonly recommendation?: string | null | undefined;
  readonly source?: CheckpointSource | null | undefined;
  /** A refused checkpoint it supersedes: approving it would lift that refusal's blocks. */
  readonly supersedes?: string | null | undefined;
  /** Measured criteria: the verdict decides, never an automatic answer before any measure. */
  readonly criteria?: readonly unknown[] | null | undefined;
  readonly recipient_role?: RecipientRole | undefined;
}

/**
 * True for a checkpoint the creator can reopen: one the engine applied on its own, or
 * one an agent decided because the creator did not keep that kind of point.
 */
export function isReopenable(checkpoint: {
  readonly status: string;
  readonly resolution: { readonly source: string } | null;
}): boolean {
  return (
    checkpoint.status === "resolved" &&
    (checkpoint.resolution?.source === "auto" || checkpoint.resolution?.source === "agent")
  );
}

/** The option the engine applies at the `auto` level, or undefined when it never answers this. */
export function autoOption(checkpoint: AutoCandidate): string | undefined {
  const recommendation = checkpoint.recommendation ?? undefined;
  if (
    checkpoint.risk !== "low" ||
    checkpoint.irreversible ||
    !AUTO_TYPES.has(checkpoint.type) ||
    (checkpoint.source ?? undefined) !== undefined ||
    (checkpoint.supersedes ?? undefined) !== undefined ||
    (checkpoint.criteria ?? undefined) !== undefined ||
    checkpoint.recipient_role === "security" ||
    recommendation === undefined ||
    !(checkpoint.options ?? []).some((option) => option.id === recommendation)
  ) {
    return undefined;
  }
  return recommendation;
}
