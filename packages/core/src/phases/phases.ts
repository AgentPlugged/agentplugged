import { DOMAIN_IDS, type DomainId, PHASE_IDS, type PhaseId } from "@agentplugged/protocol";
import { byOpening } from "../checkpoints/checkpoint-rules.js";
import { liftsBlocks, statusAt } from "../checkpoints/resolution-rules.js";
import { DEVELOPER_AGENTS } from "../profile/catalog.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";

/**
 * The phases of the method: each one is closed by the creator's approval
 * of its `phase_end` checkpoint. Which phase is current is drawn from the journal (the approved
 * `phase_end` checkpoints), never from a document. Pure functions.
 */

/** The domains each phase serves: a phase whose domains are all inactive is skipped. */
export const PHASE_DOMAINS: Readonly<Record<PhaseId, readonly DomainId[]>> = {
  framing: ["product", "creativity"],
  planning: ["product", "ux"],
  design: ["architecture"],
  build: ["code"],
  delivery: ["delivery"],
  launch: ["marketing", "sales"],
};

/**
 * The agents that build stories, in order: the method's developers. The quick lane is
 * a mode of the developer a story goes to, not an agent of its own.
 */
export const STORY_BUILDERS: readonly string[] = DEVELOPER_AGENTS;

/**
 * The agents that may open the end of each phase, in order of preference: the first active one
 * is the one `next` proposes; `open_checkpoint` refuses any agent not listed here.
 */
export const PHASE_CLOSERS: Readonly<Record<PhaseId, readonly string[]>> = {
  framing: ["iris", "lou"],
  planning: ["maya", "stella"],
  design: ["alex"],
  build: ["izzy", ...STORY_BUILDERS],
  delivery: ["omar"],
  launch: ["julien", "milo"],
};

/** The phases that repeat once every active phase was closed (the build loops story by story). */
export const REPEATING_PHASES: readonly PhaseId[] = ["build", "delivery", "launch"];

/** The status of a phase. */
export type PhaseStatus = "done" | "in_progress" | "in_review" | "upcoming" | "skipped";

/** The active phases: listed by the profile (all without one) and serving an active domain. */
export function activePhases(
  profile:
    | { readonly domains: readonly DomainId[]; readonly phases: readonly PhaseId[] }
    | undefined,
  /** The phases the creator skipped: left out as if the profile did not list them. */
  skipped?: ReadonlySet<PhaseId>,
): PhaseId[] {
  const domains: readonly DomainId[] = profile?.domains ?? DOMAIN_IDS;
  const listed: readonly PhaseId[] = profile?.phases ?? PHASE_IDS;
  return PHASE_IDS.filter(
    (phase) =>
      listed.includes(phase) &&
      PHASE_DOMAINS[phase].some((domain) => domains.includes(domain)) &&
      skipped?.has(phase) !== true,
  );
}

/**
 * A `phase_end` checkpoint the progress does not use: open while its phase is not the current one,
 * or approved out of turn (an earlier profile, an old journal, two machines apart). Shown as a
 * warning, never silently dropped.
 */
export interface StrayPhaseEnd {
  readonly checkpoint: string;
  readonly phase: PhaseId | null;
  readonly reason: "open_not_current" | "approved_out_of_turn";
}

/** Where the phases stand. */
export interface PhaseProgress {
  /** The current phase, or null (no active phase, or every one closed without a repeating one). */
  readonly current: PhaseId | null;
  /** When the current phase began: the approval that opened it, or null for the first one. */
  readonly since: string | null;
  /** The open `phase_end` checkpoint of the current phase (the first opened), or null. */
  readonly open: CheckpointState | null;
  /**
   * The last `phase_end` checkpoint of the current phase, refused (`rejected`,
   * `changes_requested`) during it, when none was opened after it; else null.
   */
  readonly refused: CheckpointState | null;
  /** Every phase of the method, in order, with its status. */
  readonly phases: ReadonlyArray<{ readonly id: PhaseId; readonly status: PhaseStatus }>;
  /** The `phase_end` checkpoints left aside, in opening order. */
  readonly stray: readonly StrayPhaseEnd[];
}

/** The phase after `phase`: the next active one, else the first repeating one, else null. */
function following(phase: PhaseId, active: readonly PhaseId[]): PhaseId | null {
  const index = active.indexOf(phase);
  const next = active[index + 1];
  if (next !== undefined) return next;
  return active.find((candidate) => REPEATING_PHASES.includes(candidate)) ?? null;
}

/**
 * True when the creator approved the checkpoint at `now`: answered with a lifting decision other
 * than a waiver (a waiver lapses; it never closes a phase nor counts as an approval).
 */
export function approvedAt(checkpoint: CheckpointState, now: number): boolean {
  return (
    statusAt(checkpoint, now) === "resolved" &&
    checkpoint.resolution !== null &&
    checkpoint.resolution.decision !== "waived" &&
    liftsBlocks(checkpoint.resolution.decision)
  );
}

/** The order of the answers: their date, then the ULID of the answering event. */
export function byAnswer(a: CheckpointState, b: CheckpointState): number {
  const at = Date.parse(a.resolution?.at ?? "") - Date.parse(b.resolution?.at ?? "");
  if (at !== 0 && !Number.isNaN(at)) return at;
  const ea = a.resolution?.event ?? "";
  const eb = b.resolution?.event ?? "";
  return ea < eb ? -1 : ea > eb ? 1 : 0;
}

/**
 * The progress of the phases, from the checkpoints of the projection: from the first active
 * phase, each `phase_end` approved (a lifting decision, never a waiver), in the order of the
 * answers, that closes the current phase moves to the following one; the others are reported in
 * `stray`. After the last active phase, the method loops on the first active repeating phase
 * (`build`, `delivery`, `launch`). `now` (milliseconds) reads the status of a checkpoint.
 */
export function phaseProgress(
  checkpoints: Iterable<CheckpointState>,
  active: readonly PhaseId[],
  now: number,
): PhaseProgress {
  const ends = [...checkpoints].filter((checkpoint) => checkpoint.type === "phase_end");
  const approved = ends.filter((checkpoint) => approvedAt(checkpoint, now)).sort(byAnswer);
  let current: PhaseId | null = active[0] ?? null;
  let since: string | null = null;
  const done = new Set<PhaseId>();
  const used = new Set<string>();
  for (const checkpoint of approved) {
    if (current === null || checkpoint.phase !== current || checkpoint.resolution === null) {
      continue;
    }
    used.add(checkpoint.id);
    done.add(current);
    since = checkpoint.resolution.at;
    current = following(current, active);
  }
  const isOpen = (checkpoint: CheckpointState) => statusAt(checkpoint, now) === "open";
  const ofCurrent =
    current === null
      ? []
      : ends.filter((checkpoint) => (checkpoint.phase ?? null) === current).sort(byOpening);
  const open = ofCurrent.find(isOpen) ?? null;
  const last = ofCurrent.at(-1);
  const refused =
    open === null &&
    last !== undefined &&
    last.resolution !== null &&
    statusAt(last, now) === "resolved" &&
    !liftsBlocks(last.resolution.decision) &&
    (since === null || Date.parse(last.resolution.at) >= Date.parse(since))
      ? last
      : null;
  const stray = [...ends].sort(byOpening).flatMap((checkpoint): StrayPhaseEnd[] => {
    const phase = checkpoint.phase ?? null;
    if (isOpen(checkpoint) && (current === null || phase !== current)) {
      return [{ checkpoint: checkpoint.id, phase, reason: "open_not_current" }];
    }
    if (approvedAt(checkpoint, now) && !used.has(checkpoint.id)) {
      return [{ checkpoint: checkpoint.id, phase, reason: "approved_out_of_turn" }];
    }
    return [];
  });
  // A phase after the current one is upcoming, even when an earlier loop closed it.
  const position = current === null ? PHASE_IDS.length : PHASE_IDS.indexOf(current);
  const phases = PHASE_IDS.map((id, index) => {
    let status: PhaseStatus;
    if (!active.includes(id)) status = "skipped";
    else if (id === current) status = open === null ? "in_progress" : "in_review";
    else if (index < position && done.has(id)) status = "done";
    else status = "upcoming";
    return { id, status };
  });
  return { current, since, open, refused, phases, stray };
}

/**
 * The phase that was current at `time` (milliseconds), by the same walk as `phaseProgress`: each
 * approved `phase_end` closes the current phase at the time of its answer. Used to tie the sessions
 * the engine measured to a phase; undefined when no phase is active.
 */
export function phaseAt(
  time: number,
  checkpoints: Iterable<CheckpointState>,
  active: readonly PhaseId[],
  now: number,
): PhaseId | undefined {
  const approved = [...checkpoints]
    .filter((checkpoint) => checkpoint.type === "phase_end" && approvedAt(checkpoint, now))
    .sort(byAnswer);
  let current: PhaseId | null = active[0] ?? null;
  for (const checkpoint of approved) {
    if (current === null || checkpoint.phase !== current || checkpoint.resolution === null) {
      continue;
    }
    if (time <= Date.parse(checkpoint.resolution.at)) return current;
    current = following(current, active);
  }
  return current ?? undefined;
}

/** The times (milliseconds) the approved `phase_end` checkpoints were answered, in order. */
export function phaseEndTimes(checkpoints: Iterable<CheckpointState>, now: number): number[] {
  return [...checkpoints]
    .filter((checkpoint) => checkpoint.type === "phase_end" && approvedAt(checkpoint, now))
    .sort(byAnswer)
    .flatMap((checkpoint) =>
      checkpoint.resolution === null ? [] : [Date.parse(checkpoint.resolution.at)],
    )
    .filter((time) => !Number.isNaN(time));
}

/**
 * The structuring documents of the method: the brief, the PRD, the UX specification
 * and the architecture. Each is validated by a `document` checkpoint of its own (or by the
 * `phase_end` that carries it, when it is the last of its phase).
 */
export const STRUCTURING_DOCUMENT_PATHS: readonly string[] = [
  ".agentplugged/docs/brief.md",
  // The press release written before building, validated like the brief.
  ".agentplugged/docs/prfaq.md",
  ".agentplugged/docs/prd.md",
  // The short path's one spec, validated like the documents it stands for.
  ".agentplugged/docs/spec.md",
  ".agentplugged/docs/ux.md",
  ".agentplugged/docs/architecture.md",
];

/** The agent that writes the knowledge base: its reviews follow their own rules. */
const KNOWLEDGE_BASE_AUTHOR = "zoe";

/**
 * True for the `document` checkpoint of a structuring document: no story, no blocks,
 * not a review of the knowledge base, citing one of the documents (a sprint's or a breakdown's
 * checkpoint cites none of them).
 */
export function isDocumentReview(checkpoint: CheckpointState): boolean {
  return (
    checkpoint.type === "document" &&
    (checkpoint.story ?? null) === null &&
    checkpoint.blocks.length === 0 &&
    checkpoint.opened_by !== KNOWLEDGE_BASE_AUTHOR &&
    checkpoint.documents.some((cited) =>
      STRUCTURING_DOCUMENT_PATHS.includes(cited.path.replace(/\\/g, "/").replace(/^\.\//, "")),
    )
  );
}

/** The documents' checkpoints opened since `since` (the beginning of the phase), or all. */
function reviewsSince(
  checkpoints: Iterable<CheckpointState>,
  since: string | null,
): CheckpointState[] {
  const from = since === null ? Number.NEGATIVE_INFINITY : Date.parse(since);
  return [...checkpoints]
    .filter(
      (checkpoint) => isDocumentReview(checkpoint) && !(Date.parse(checkpoint.opened_at) < from),
    )
    .sort(byOpening);
}

/** A structuring document's checkpoint of the current phase still waiting for the creator. */
export function openDocumentReview(
  checkpoints: Iterable<CheckpointState>,
  since: string | null,
  now: number,
): CheckpointState | undefined {
  return reviewsSince(checkpoints, since).find(
    (checkpoint) => statusAt(checkpoint, now) === "open",
  );
}

/**
 * The first structuring document's checkpoint the creator refused (`rejected`,
 * `changes_requested`) that no other one supersedes yet: its author reworks the document and
 * opens a new one with `supersedes`. Undefined when none.
 */
export function refusedDocumentReview(
  checkpoints: Iterable<CheckpointState>,
  since: string | null,
  now: number,
): CheckpointState | undefined {
  const all = [...checkpoints];
  const superseded = new Set(all.flatMap((checkpoint) => checkpoint.supersedes ?? []));
  return reviewsSince(all, since).find(
    (checkpoint) =>
      !superseded.has(checkpoint.id) &&
      statusAt(checkpoint, now) === "resolved" &&
      checkpoint.resolution !== null &&
      !liftsBlocks(checkpoint.resolution.decision),
  );
}
