import {
  MAX_REMEMBERED_OFFERS,
  MAX_SESSION_MEMORY_LINES,
  MAX_TABLE_AGENTS,
  MAX_TABLE_GUESTS,
  MIN_TABLE_AGENTS,
  NOAH_AGENT,
  type RoundTableCall,
  TABLE_ANGLES,
  THREE_VIEWS_AGENTS,
} from "@agentplugged/protocol";
import { normalizedPath } from "../critique/critique-rules.js";
import { METHOD_DIR } from "../init/layout.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { isMergeCheckpoint } from "../projection/merge-reducers.js";
import { openMergeCheckpoint, reviewOf } from "../review/review-rules.js";

/**
 * The round table of agents, as pure rules. The engine decides what a closed table
 * must hold (who sat and why, the synthesis, the gesture and the creator's words), which gesture
 * leads to whom, and when the three views of a story are worth offering. It never plays an agent,
 * keeps the debate, or follows one live: that is outside this engine.
 */

/** The agent who creates a story from a conclusion. */
export const STORY_OWNER = "izzy";

/** The folder of the product's documents: the only ones a table may ask to update. */
const DOCS_DIR = `${METHOD_DIR}/docs/`;

/** What the preparation reads of the working copy, for a gesture on a document. */
export interface TablePrepared {
  readonly documentExists: boolean;
  /** The `owner` of the document's header, when it has one. */
  readonly documentOwner: string | undefined;
  /** Who takes the gesture over, once the team is known (undefined: no gesture to hand over). */
  readonly owner?: string | undefined;
  /** What the saved room named by the call is (read only for a call that names one). */
  readonly room?: { readonly problems: readonly string[]; readonly remembers: boolean } | undefined;
}

/** True for a Markdown file of the product's documents, without a way out of the folder. */
export function isDocsPath(path: string): boolean {
  const segments = path.split("/");
  return (
    path.startsWith(DOCS_DIR) &&
    path.endsWith(".md") &&
    !segments.includes("..") &&
    !segments.includes("")
  );
}

/** The facts a call is checked against. */
export interface TableFacts {
  /** The active agents of the product. */
  readonly active: ReadonlySet<string>;
  readonly state: Readonly<Record<string, unknown>>;
  readonly prepared: TablePrepared | undefined;
}

function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** `state.tables.offered`: the stories whose three views were offered, the latest last. */
export function offeredStories(state: Readonly<Record<string, unknown>>): string[] {
  const tables = state.tables as { offered?: string[] } | undefined;
  return tables?.offered ?? [];
}

/** True when Noah already offered the three views of this story. */
export function wasTableOffered(state: Readonly<Record<string, unknown>>, story: string): boolean {
  return offeredStories(state).includes(story);
}

/** Remembers an offer, at most `MAX_REMEMBERED_OFFERS` (the oldest forgotten). */
export function withOffer(offered: readonly string[], story: string): string[] {
  return offered.includes(story) ? [...offered] : [...offered, story].slice(-MAX_REMEMBERED_OFFERS);
}

/** The story as the state keeps it, when the product knows it. */
function storyIn(state: Readonly<Record<string, unknown>>, id: string): StoryState | undefined {
  return own(state.stories as Record<string, StoryState> | undefined, id);
}

/**
 * True when the story is sensitive: its latest review pass found a reason of security (the diff
 * touches a sensitive path, its text speaks of security, its header names a security reviewer, or
 * the quality reviewer asked). The same reasons that send a story to the security reviewer.
 */
export function sensitiveStory(state: Readonly<Record<string, unknown>>, id: string): boolean {
  const pass = reviewOf(storyIn(state, id))?.passes.at(-1);
  return pass !== undefined && pass.security.reasons.length > 0;
}

/** The three views, as `next` offers them: the story and who takes each side. */
export interface TableOffer {
  readonly format: "three_views";
  readonly story: string;
  /** Product, delivery and quality, in this order. */
  readonly agents: readonly string[];
}

/** The agent of each side of the three views, when the team has all three. */
export function threeViewsAgents(active: ReadonlySet<string>): string[] | undefined {
  const agents = TABLE_ANGLES.map((angle) => THREE_VIEWS_AGENTS[angle]);
  return agents.every((agent) => active.has(agent)) ? agents : undefined;
}

/**
 * The story whose three views are worth offering: the point that waits is its merge, it is
 * sensitive, and the offer was never made for it. Once per story, whatever the answer. Reads the
 * state only: the team is looked at (`tableOffer`) when there is a story to offer.
 */
export function tableCandidate(
  state: Readonly<Record<string, unknown>>,
  checkpoint: Pick<CheckpointState, "type" | "story" | "source"> | undefined,
): string | undefined {
  if (checkpoint === undefined || !isMergeCheckpoint(checkpoint)) return undefined;
  const story = checkpoint.story;
  if (story === null || wasTableOffered(state, story) || !sensitiveStory(state, story)) {
    return undefined;
  }
  return story;
}

/** The offer for that story, when the team has the three sides. */
export function tableOffer(story: string, active: ReadonlySet<string>): TableOffer | undefined {
  const agents = threeViewsAgents(active);
  return agents === undefined ? undefined : { format: "three_views", story, agents };
}

/** The stray fields of a call, as codes. */
function strays(input: RoundTableCall, allowed: readonly string[]): string[] {
  const ok = new Set(["agent", ...allowed]);
  return Object.entries(input)
    .filter(([field, value]) => value !== undefined && !ok.has(field))
    .map(([field]) => `unexpected:${field}`);
}

/** What is wrong with the recall of a saved room, as codes. */
export function validateRecall(input: RoundTableCall, facts: TableFacts): string[] {
  return [...strays(input, ["room"]), ...(facts.prepared?.room?.problems ?? ["room_unknown"])];
}

/** What is wrong with the offer of the three views, as codes; empty when it is whole. */
export function validateProposal(input: RoundTableCall, facts: TableFacts): string[] {
  const problems = strays(input, ["story"]);
  if (input.story === undefined) return [...problems, "story_missing"];
  if (storyIn(facts.state, input.story) === undefined) problems.push("story_unknown");
  else if (!sensitiveStory(facts.state, input.story)) problems.push("story_not_sensitive");
  // What `next` offers, no more: the story's merge waits and the team has the three sides.
  const checkpoints = Object.values(
    (facts.state.checkpoints ?? {}) as Record<string, CheckpointState>,
  );
  if (openMergeCheckpoint(checkpoints, input.story) === undefined) {
    problems.push("merge_not_waiting");
  }
  if (threeViewsAgents(facts.active) === undefined) problems.push("team_incomplete");
  if (wasTableOffered(facts.state, input.story)) problems.push("already_offered");
  return problems;
}

/** What is wrong with the guests (who are not of the team), as codes. */
function guestProblems(input: RoundTableCall, facts: TableFacts): string[] {
  const guests = input.guests ?? [];
  const problems: string[] = [];
  if (guests.length > MAX_TABLE_GUESTS) problems.push(`guests_count:0-${MAX_TABLE_GUESTS}`);
  const team = new Set((input.agents ?? []).map((agent) => agent.id));
  const seen = new Set<string>();
  for (const { id } of guests) {
    if (seen.has(id)) problems.push(`guest_twice:${id}`);
    seen.add(id);
    // A guest is never an agent of the team, nor the one who leads: the ids stay apart.
    if (team.has(id) || facts.active.has(id) || id === NOAH_AGENT) {
      problems.push(`guest_is_agent:${id}`);
    }
  }
  return problems;
}

/** What is wrong with the saved room a call names, and with the memory it brings, as codes. */
function roomProblems(input: RoundTableCall, facts: TableFacts): string[] {
  const memory = input.memory ?? [];
  if (input.room === undefined) return memory.length > 0 ? ["memory_without_room"] : [];
  const problems = [...(facts.prepared?.room?.problems ?? ["room_unknown"])];
  if (memory.length > MAX_SESSION_MEMORY_LINES) {
    problems.push(`memory_count:0-${MAX_SESSION_MEMORY_LINES}`);
  }
  if (memory.length > 0 && facts.prepared?.room?.remembers !== true) problems.push("memory_off");
  return problems;
}

/** What is wrong with the sitting of the agents, as codes. */
function agentProblems(input: RoundTableCall, facts: TableFacts): string[] {
  const agents = input.agents ?? [];
  const problems: string[] = [];
  if (agents.length > MAX_TABLE_AGENTS) problems.push(`agents_count:0-${MAX_TABLE_AGENTS}`);
  if (agents.length + (input.guests?.length ?? 0) < MIN_TABLE_AGENTS) {
    problems.push(`seats_count:${MIN_TABLE_AGENTS}+`);
  }
  const seen = new Set<string>();
  for (const { id } of agents) {
    if (seen.has(id)) problems.push(`agent_twice:${id}`);
    seen.add(id);
    // The leader of the table never sits at it: he voices no opinion of his own.
    if (id === NOAH_AGENT || id === "main") problems.push(`agent_leads:${id}`);
    else if (!facts.active.has(id)) problems.push(`agent_absent:${id}`);
  }
  return problems;
}

/** What is wrong with the three views format, as codes. */
function threeViewsProblems(input: RoundTableCall, facts: TableFacts): string[] {
  const problems: string[] = [];
  if (input.story === undefined) problems.push("three_views:story_missing");
  else if (storyIn(facts.state, input.story) === undefined) problems.push("story_unknown");
  const angles = (input.agents ?? []).map((agent) => agent.angle);
  if (
    angles.length !== TABLE_ANGLES.length ||
    !TABLE_ANGLES.every((angle) => angles.includes(angle))
  ) {
    problems.push("three_views:one_agent_per_angle");
  }
  return problems;
}

/** What is wrong with the gesture, as codes. */
function gestureProblems(input: RoundTableCall, facts: TableFacts): string[] {
  const gesture = input.gesture;
  if (gesture === undefined) return ["gesture_missing"];
  const sitting = new Set((input.agents ?? []).map((agent) => agent.id));
  const subject = gesture.subject;
  switch (gesture.type) {
    case "none":
      return subject === undefined && gesture.owner === undefined ? [] : ["gesture:none_is_bare"];
    case "decision": {
      const problems: string[] = [];
      if (subject === undefined) problems.push("gesture:subject_missing");
      if (gesture.owner === undefined) problems.push("gesture:owner_missing");
      else if ((input.guests ?? []).some((guest) => guest.id === gesture.owner)) {
        problems.push("gesture:owner_is_guest");
      } else if (!sitting.has(gesture.owner)) problems.push("gesture:owner_not_at_table");
      return problems;
    }
    case "story": {
      const problems: string[] = [];
      if (subject === undefined) problems.push("gesture:subject_missing");
      if (gesture.owner !== undefined && gesture.owner !== STORY_OWNER) {
        problems.push("gesture:owner_is_not_chosen");
      }
      if (!facts.active.has(STORY_OWNER)) problems.push(`agent_absent:${STORY_OWNER}`);
      return problems;
    }
    default: {
      const problems: string[] = [];
      if (gesture.owner !== undefined) problems.push("gesture:owner_is_not_chosen");
      if (subject === undefined) return [...problems, "gesture:subject_missing"];
      const path = normalizedPath(subject);
      if (!isDocsPath(path)) {
        problems.push("gesture:document_out_of_docs");
      } else if (facts.prepared?.documentExists !== true) problems.push("gesture:document_missing");
      return problems;
    }
  }
}

/**
 * What is wrong with the closing of a table, as short codes the agent can fix; empty when whole.
 * Everyone who spoke (two seats at least; up to twelve agents of the team and eight guests), each
 * agent there for a reason and present in the team, each guest apart from the team; a synthesis
 * that says something (an agreement or a disagreement, and the advice); a gesture the engine can
 * hand over; and the creator's own words, which choose the gesture.
 */
export function validateClosing(input: RoundTableCall, facts: TableFacts): string[] {
  const problems = [
    ...strays(input, [
      "story",
      "agents",
      "guests",
      "synthesis",
      "gesture",
      "quote",
      "room",
      "memory",
    ]),
    ...agentProblems(input, facts),
    ...guestProblems(input, facts),
    ...roomProblems(input, facts),
  ];
  const synthesis = input.synthesis;
  if ((synthesis?.agreed?.length ?? 0) + (synthesis?.disputed?.length ?? 0) === 0) {
    problems.push("synthesis_empty");
  }
  if (synthesis?.format === "three_views") {
    problems.push(...threeViewsProblems(input, facts));
    if (input.guests !== undefined || input.room !== undefined)
      problems.push("three_views:no_room");
  } else {
    if (input.agents?.some((agent) => agent.angle !== undefined)) {
      problems.push("angle_without_format");
    }
    if (input.story !== undefined) problems.push("unexpected:story");
  }
  problems.push(...gestureProblems(input, facts));
  if (input.quote === undefined) problems.push("quote_missing");
  return problems;
}

/**
 * Who takes the gesture over, from the closing: the agent who opens the point (`decision`, chosen
 * among those at the table), Izzy for a story, the author of the document for an update (the
 * creator themself when the document has no author present: the proposals are then offered, nothing
 * is changed). Undefined for `none`.
 */
export function gestureOwner(
  input: RoundTableCall,
  facts: Pick<TableFacts, "active" | "prepared">,
): string | undefined {
  const gesture = input.gesture;
  if (gesture === undefined || gesture.type === "none") return undefined;
  if (gesture.type === "decision") return gesture.owner;
  if (gesture.type === "story") return STORY_OWNER;
  const owner = facts.prepared?.documentOwner;
  return owner !== undefined && facts.active.has(owner) ? owner : "creator";
}
