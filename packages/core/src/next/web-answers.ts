import type { AgentState } from "../projection/agent-reducers.js";
import { type CheckpointState, checkpointsOf } from "../projection/checkpoint-reducers.js";
import { isMergeCheckpoint } from "../projection/merge-reducers.js";

/**
 * What an agent learns of the answers the creator gave from the web view. An answer given in
 * the chat reaches the agent because the agent is the one who relays it; an answer clicked in a
 * browser reaches nobody, the machine only writes it in the journal. So `next`, which an agent reads
 * at each step, carries it: the points that agent opened, answered from the web, since the agent
 * last wrote anything. The agent acts on it (the answer is then older than its own last event and
 * says nothing more), and an agent that does not is told again at its next reading. Nothing is
 * written, nothing is kept: the journal alone says who answered what and when.
 */

/** An answer the creator gave from the web to a point an agent opened. */
export interface WebAnswerNote {
  /** The agent that opened the point, and the only one it concerns. */
  readonly agent: string;
  readonly checkpoint: string;
  readonly title: string;
  readonly decision: string;
  readonly option?: string;
  /** The creator's reason, cut to a few lines. */
  readonly note?: string;
}

/** How long an answer is told: older, nobody is waiting for it. */
const TELL_FOR_MS = 24 * 60 * 60 * 1000;

/** The most answers told at once (the newest): the agent reads the rest with `state.get`. */
const MOST = 3;

/** Longest title and reason told, in characters: the full text is one `state.get` away. */
const TITLE_MAX = 120;
const NOTE_MAX = 300;

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * The answers from the web view that an agent has not acted on yet: the points it opened, answered
 * with `source: web` or `source: mobile`, whose answer is later than its last event of any kind. A story's merge is left out
 * (its own step tells the developer what to do, and an approved one is merged).
 */
export function webAnswersNote(
  state: Readonly<Record<string, unknown>>,
  now: number,
): readonly WebAnswerNote[] {
  const agents = (state.agents as Record<string, AgentState> | undefined) ?? {};
  const told: Array<WebAnswerNote & { readonly at: number }> = [];
  for (const point of Object.values(checkpointsOf(state)) as CheckpointState[]) {
    const resolution = point.resolution ?? null;
    if (point.status !== "resolved" || resolution === null) continue;
    // From the web view: a browser's order or a phone's. Neither is relayed by the agent itself.
    if (resolution.source !== "web" && resolution.source !== "mobile") continue;
    const agent = point.opened_by;
    if (agent === null || agent === undefined || isMergeCheckpoint(point)) continue;
    const at = Date.parse(resolution.at);
    if (!(now - at < TELL_FOR_MS)) continue;
    const signal = Object.hasOwn(agents, agent)
      ? Date.parse((agents[agent] as AgentState).last_signal_at)
      : Number.NEGATIVE_INFINITY;
    if (!(at > signal)) continue;
    told.push({
      agent,
      checkpoint: point.id,
      title: cut(point.title, TITLE_MAX),
      decision: resolution.decision,
      ...(resolution.option === null ? {} : { option: resolution.option }),
      ...(resolution.note === null ? {} : { note: cut(resolution.note, NOTE_MAX) }),
      at,
    });
  }
  return told
    .sort((a, b) => b.at - a.at)
    .slice(0, MOST)
    .map(({ at: _at, ...answer }) => answer);
}
