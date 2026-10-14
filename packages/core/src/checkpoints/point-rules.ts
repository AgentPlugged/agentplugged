import {
  type CheckpointRisk,
  type CheckpointSource,
  type CheckpointType,
  DEFAULT_VALIDATION_POINTS,
  NOAH_AGENT,
  type PhaseId,
  VALIDATION_POINTS,
  type ValidationMode,
  type ValidationPoint,
} from "@agentplugged/protocol";

/**
 * The points of validation, pure. The creator chooses which kinds of point wait for
 * them (`validation.points` of `method.yaml`); any other point is decided by the agent responsible
 * for it, with its reason in the journal, and the creator can reopen it. This module says which
 * kind a checkpoint is, whether the creator kept it, and who decides it when they did not.
 *
 * Never delegated, whatever the creator chose: what only the creator can decide or what asks for
 * their own gesture (an action of the creator's, a change of the memory, an installation to
 * validate, a permission), and what the engine opened to ask for help (a blocked result, a
 * conflict of substance, a review loop, the fast track, a forge to link). At the `strict` level, a
 * point at a high risk is the creator's too (the terminal and their key).
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

/**
 * What the creator chose, as the rules read it: the points they keep, and whether the level is
 * `strict`. Absent (`undefined`) while the creator has not chosen: every point waits for them.
 */
export interface Delegation {
  readonly fixed: readonly ValidationPoint[];
  readonly strict: boolean;
}

/** The delegation from the validation settings, or undefined when the creator has not chosen. */
export function delegationOf(settings: {
  readonly mode: ValidationMode;
  readonly points: readonly ValidationPoint[] | undefined;
}): Delegation | undefined {
  return settings.points === undefined
    ? undefined
    : { fixed: settings.points, strict: settings.mode === "strict" };
}

/** Why a point is not delegated. */
export type NotDelegated =
  /** The creator has not chosen their points yet: every point waits for them. */
  | "not_configured"
  /** An escalation, an action of the creator's, a memory change or a permission. */
  | "escalation"
  /** The creator keeps this kind of point. */
  | "kept"
  /** The `strict` level keeps a high risk for the terminal and the creator's key. */
  | "strict_high_risk"
  /** A merge whose changes touch the settings of the method: only the creator merges it. */
  | "touches_settings"
  /** The creator reopened it: it waits for their answer now. */
  | "reopened"
  /** The agent responsible handed it back to the creator (`escalate`): they answer it. */
  | "escalated";

/** A point the agents decide (with its kind), or why it waits for the creator. */
export type DelegationVerdict =
  | { readonly delegated: true; readonly kind: PointKind }
  | { readonly delegated: false; readonly why: NotDelegated; readonly kind?: PointKind };

/** Whether `checkpoint` is the agents' to decide, or waits for the creator, and why. */
export function delegationVerdict(
  checkpoint: PointCandidate,
  delegation: Delegation | undefined,
): DelegationVerdict {
  if (delegation === undefined) return { delegated: false, why: "not_configured" };
  const kind = pointKindOf(checkpoint);
  if (kind === undefined) return { delegated: false, why: "escalation" };
  if ((checkpoint.reopened_at ?? null) !== null) return { delegated: false, why: "reopened", kind };
  if ((checkpoint.escalated ?? null) !== null) return { delegated: false, why: "escalated", kind };
  if (delegation.strict && checkpoint.risk === "high") {
    return { delegated: false, why: "strict_high_risk", kind };
  }
  if (kind !== "other" && delegation.fixed.includes(kind)) {
    return { delegated: false, why: "kept", kind };
  }
  return { delegated: true, kind };
}

/** True when the agents decide `checkpoint` (the creator did not keep it). */
export function isDelegated(
  checkpoint: PointCandidate,
  delegation: Delegation | undefined,
): boolean {
  return delegationVerdict(checkpoint, delegation).delegated;
}

/**
 * The agents `next` proposes to decide each kind of point, in order of preference: the one that
 * reviews the work, never its author when another is active. The engine does not enforce this
 * order: any active agent may decide, but Noah (he never decides) and the creator's reopened
 * points.
 */
export const POINT_DECIDERS: Readonly<Record<PointKind, readonly string[]>> = {
  framing: ["maya", "iris", "stella", "lou"],
  architecture: ["chloe", "tess", "maya"],
  breakdown: ["maya", "quentin", "alex"],
  merge: ["quentin", "chloe", "tess"],
  release: ["quentin", "chloe", "omar"],
  publication: ["maya", "julien", "milo"],
  other: ["izzy", "maya", "alex"],
};

/**
 * The agent to ask to decide a point: the first of its kind's list that is active and is not its
 * author, else any other active agent but Noah, else its author, else null (no agent is active:
 * the creator decides). `active` lists the active agents' ids.
 */
export function deciderFor(
  kind: PointKind,
  openedBy: string | null,
  active: readonly string[],
): string | null {
  const usable = active.filter((agent) => agent !== NOAH_AGENT);
  const preferred = POINT_DECIDERS[kind].find(
    (agent) => usable.includes(agent) && agent !== openedBy,
  );
  if (preferred !== undefined) return preferred;
  const other = usable.find((agent) => agent !== openedBy);
  if (other !== undefined) return other;
  return openedBy !== null && usable.includes(openedBy) ? openedBy : null;
}

/** The points as `get_state` and `next` show them to the agents. */
export interface PointsView {
  /** The creator chose their points. False: every point waits for them, as before. */
  readonly configured: boolean;
  /** The points that wait for the creator: all of them while they have not chosen. */
  readonly fixed: readonly ValidationPoint[];
  /** The points the agents decide, with their reason: none while the creator has not chosen. */
  readonly delegated: readonly ValidationPoint[];
  /** The points to propose when the creator chooses: the defaults (framing, architecture…). */
  readonly proposed: readonly ValidationPoint[];
}

/** The view of the points from the creator's setting (`undefined`: not chosen yet). */
export function pointsView(points: readonly ValidationPoint[] | undefined): PointsView {
  return {
    configured: points !== undefined,
    fixed: points ?? VALIDATION_POINTS,
    delegated:
      points === undefined ? [] : VALIDATION_POINTS.filter((kind) => !points.includes(kind)),
    proposed: DEFAULT_VALIDATION_POINTS,
  };
}
