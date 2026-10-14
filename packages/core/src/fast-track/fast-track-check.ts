import {
  CHECKPOINT_EVENT_TYPES,
  FAST_TRACK_EVENT_TYPES,
  FAST_TRACK_MAX_FILES,
  FAST_TRACK_OPTIONS,
  type FastTrackCheckedPayload,
  type FastTrackEngineReason,
  type FastTrackLeftPayload,
  type FastTrackReason,
} from "@agentplugged/protocol";
import { checkpointPayload, truncate } from "../checkpoints/checkpoint-rules.js";
import type { CommandContext } from "../command.js";
import type { EventDraft } from "../journal/state-store.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { parseDiff } from "../review/review-rules.js";
import {
  announcedFiles,
  type FastTrackVerdict,
  fastTrackVerdict,
  openExitCheckpoint,
  renamedPaths,
} from "./fast-track-rules.js";

/**
 * The engine's reading of a story's changes in the fast track. Each time a
 * commit is recorded for the story (a pull request opened or updated, a CI read), the engine reads
 * the diff of the story's branch since its base and writes what it found in the same write as the
 * event it follows: `story.fast_track_checked` and, when the changes are no longer a small change,
 * `story.fast_track_left` and the checkpoint that explains it to the creator. The agent gives
 * neither the verdict nor the files.
 */

/** Who writes the events: the actor, product and provenance of the event they follow. */
export interface FastTrackWriter {
  readonly actor: EventDraft["actor"];
  readonly product: string;
  readonly provenance: EventDraft["provenance"];
}

/** What the engine read of a commit, for a story in the fast track. */
export interface FastTrackReading {
  readonly commit: string;
  readonly verdict: FastTrackVerdict;
}

/**
 * Reads the changes of `head` in the story's branch. Undefined when there is nothing to write: the
 * story is not in the fast track (or left it), the engine already read this very commit, or Git
 * cannot give the diff (no reading is ever invented: the merge gate stays closed until one is
 * written).
 */
export async function readFastTrack(
  context: CommandContext,
  story: StoryState | undefined,
  head: string,
): Promise<FastTrackReading | undefined> {
  const track = story?.fast_track;
  const started = story?.started;
  if (track?.status !== "active" || started === undefined) return undefined;
  if (track.checked?.commit === head) return undefined;
  const source = context.storyDiff;
  if (source === undefined) return undefined;
  const diff = await source.diff(started.base, head, started.base_ref).catch(() => undefined);
  if (diff === undefined) return undefined;
  // A diff the engine cannot read whole proves nothing: an empty one (a branch with commits has
  // changes), or one announcing more files than were parsed.
  const files = parseDiff(diff);
  if (files.length === 0 || files.length < announcedFiles(diff)) return undefined;
  return { commit: head, verdict: fastTrackVerdict(files, renamedPaths(diff)) };
}

/** Why a change leaves the fast track, for the creator (the checkpoint's text, in English). */
const REASON_TEXT: Readonly<Record<FastTrackReason, string>> = {
  too_many_files: `it touches ${FAST_TRACK_MAX_FILES} files or more`,
  dependency_manifest: "it touches a dependency manifest or lockfile, so a dependency may be added",
  migration: "it touches a file of a data migration or of a data schema",
  interface_contract: "it touches a file of an interface's contract",
  ambiguous_intent: "its goal can be read two ways",
  irreversible_action: "a step of it could not be undone",
  growing_scope: "the change keeps growing past a small change",
  public_interface: "it changes a public interface",
  data_migration: "it needs a data migration",
  new_dependency: "it needs a new dependency",
};

/** The checkpoint that explains to the creator why a story left the fast track. */
export function exitCheckpointPayload(
  id: string,
  by: "engine" | "agent",
  reasons: readonly FastTrackReason[],
  detail: string | undefined,
) {
  const why = reasons.map((reason) => REASON_TEXT[reason]).join("; ");
  const who = by === "engine" ? "The engine read its changes" : "Its developer found";
  const found = detail === undefined ? "" : ` ${detail}`;
  return {
    ...checkpointPayload({
      type: "decision",
      risk: "medium",
      title: truncate(`Story ${id} leaves the fast track`, 120),
      summary: truncate(
        `Story ${id} was started in the fast track (a small change, EF-12), but it no longer is one: ${who} and ${why}.${found} It goes on in the full lane: framing and design where they are needed, then the same independent review and your validation before the merge. Until you answer, the story is blocked and cannot go to review.`,
        2000,
      ),
      options: [
        {
          id: FAST_TRACK_OPTIONS.fullLane,
          label: "Continue in the full lane",
          consequence:
            "The story goes on with its developer in the full lane; the review and your validation before the merge stay as they are.",
        },
        {
          id: FAST_TRACK_OPTIONS.stop,
          label: "Stop this story",
          consequence:
            "The story is abandoned: it is left aside, never presented for a merge and no longer counted among the stories being built; split it or write a new story.",
        },
      ],
      recommendation: FAST_TRACK_OPTIONS.fullLane,
      blocks: [
        { action: "story.review", story: id },
        { action: "story.complete", story: id },
      ],
    }),
    source: "fast_track" as const,
  };
}

/**
 * The events that record a reading (`story.fast_track_checked`), and, when the changes do not
 * fit, the exit: `story.fast_track_left` by the engine and the checkpoint that explains it (none
 * when one is already open for the story). They follow the event the caller writes.
 */
export function fastTrackEvents(
  reading: FastTrackReading,
  input: {
    readonly id: string;
    readonly checkpoints: readonly CheckpointState[];
    readonly writer: FastTrackWriter;
  },
): EventDraft[] {
  const { verdict, commit } = reading;
  const { id, writer } = input;
  const base = {
    actor: writer.actor,
    product: writer.product,
    story: id,
    provenance: writer.provenance,
  };
  const checked: FastTrackCheckedPayload = {
    commit,
    count: verdict.count,
    files: [...verdict.files],
    ...(verdict.truncated ? { files_truncated: true as const } : {}),
    ok: verdict.ok,
    reasons: [...verdict.reasons] as FastTrackEngineReason[],
  };
  const events: EventDraft[] = [
    { ...base, type: FAST_TRACK_EVENT_TYPES.checked, payload: checked },
  ];
  if (verdict.ok) return events;
  const named = verdict.files.slice(0, 3).join(", ");
  const detail = `${verdict.count} file(s) touched since the branch's base${named === "" ? "" : ` (${named}${verdict.count > 3 ? ", …" : ""})`}${
    verdict.reasons.includes("too_many_files")
      ? ` (a small change touches fewer than ${FAST_TRACK_MAX_FILES})`
      : ""
  }.`;
  const left: FastTrackLeftPayload = {
    by: "engine",
    reasons: [...verdict.reasons],
    detail,
    commit,
  };
  events.push({ ...base, type: FAST_TRACK_EVENT_TYPES.left, payload: left });
  if (openExitCheckpoint(input.checkpoints, id) === undefined) {
    events.push({
      ...base,
      type: CHECKPOINT_EVENT_TYPES.opened,
      payload: exitCheckpointPayload(id, "engine", verdict.reasons, detail),
    });
  }
  return events;
}

/** What `open_pull_request`, `story pr`, `check_ci` and `story ci` tell of the reading. */
export interface FastTrackOutcome {
  /** The changes fit a small change. */
  readonly ok: boolean;
  readonly count: number;
  readonly reasons: readonly FastTrackEngineReason[];
  /** The story went back to the full lane with this write, a checkpoint explains it. */
  readonly left: boolean;
}

export function outcomeOf(reading: FastTrackReading): FastTrackOutcome {
  return {
    ok: reading.verdict.ok,
    count: reading.verdict.count,
    reasons: reading.verdict.reasons,
    left: !reading.verdict.ok,
  };
}
