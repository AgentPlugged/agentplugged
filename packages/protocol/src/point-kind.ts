import type { CheckpointRisk, CheckpointSource, CheckpointType } from "./checkpoint.js";
import type { PhaseId, ValidationPoint } from "./method-config.js";

/**
 * Which kind of point of validation a checkpoint is. Pure data and rules, shared by the engine
 * (who decides a point) and the web view (what the creator validated without changing a word).
 */

/** The kind of a point: one the creator may keep, `other` (always decided by an agent), or none. */
export type PointKind = ValidationPoint | "other";

/** What the rule reads of a checkpoint: an opened payload or its projected state. */
export interface PointCandidate {
  /** The documents it cites: their path says the kind better than the author's declared name. */
  readonly documents?: ReadonlyArray<{ readonly path: string }> | undefined;
  readonly type: CheckpointType;
  readonly risk: CheckpointRisk;
  readonly source?: CheckpointSource | null | undefined;
  readonly phase?: PhaseId | null | undefined;
  readonly opened_by?: string | null | undefined;
  readonly creator_action?: unknown;
  readonly memory?: unknown;
  /** Set once the creator reopened a point an agent had decided: it waits for them then. */
  readonly reopened_at?: string | null | undefined;
  /** Set once the agent responsible handed the point back to the creator, with its reason. */
  readonly escalated?: unknown;
}

/** The point each phase's end belongs to: the build has none (the agents decide its end). */
const PHASE_POINT: Readonly<Record<PhaseId, ValidationPoint | undefined>> = {
  framing: "framing",
  planning: "framing",
  design: "architecture",
  build: undefined,
  delivery: "release",
  launch: "publication",
};

/** The point a document belongs to, from the agent that wrote it. */
const DOCUMENT_POINT: Readonly<Record<string, ValidationPoint>> = {
  iris: "framing",
  lou: "framing",
  maya: "framing",
  stella: "framing",
  alex: "architecture",
  izzy: "breakdown",
  julien: "publication",
  milo: "publication",
};

/** The kind a document's path says: the architecture, the framing documents, the breakdown. */
function pointOfPaths(
  documents: ReadonlyArray<{ readonly path: string }> | undefined,
): ValidationPoint | undefined {
  for (const { path } of documents ?? []) {
    const name = path.toLowerCase().replaceAll("\\", "/");
    if (/(^|\/)architecture\.md$/.test(name)) return "architecture";
    if (/(^|\/)(brief|prfaq|prd|spec|ux)\.md$/.test(name)) return "framing";
    if (/(^|\/)(epics|stories)\//.test(name)) return "breakdown";
  }
  return undefined;
}

/**
 * The kind of a checkpoint, or undefined when it is never delegated (an escalation, an action of
 * the creator's, a memory change, a permission).
 */
export function pointKindOf(checkpoint: PointCandidate): PointKind | undefined {
  if ((checkpoint.creator_action ?? null) !== null || (checkpoint.memory ?? null) !== null) {
    return undefined;
  }
  if (checkpoint.source === "merge") return "merge";
  if (checkpoint.source !== null && checkpoint.source !== undefined) return undefined;
  switch (checkpoint.type) {
    case "story":
      return "merge";
    case "release":
      return "release";
    case "publication":
      return "publication";
    case "phase_end": {
      const point = checkpoint.phase == null ? undefined : PHASE_POINT[checkpoint.phase];
      return point ?? "other";
    }
    case "document":
      return (
        pointOfPaths(checkpoint.documents) ?? DOCUMENT_POINT[checkpoint.opened_by ?? ""] ?? "other"
      );
    case "decision":
      return "other";
    default:
      return undefined;
  }
}
