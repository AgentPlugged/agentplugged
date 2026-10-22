import { ErrorCode } from "@agentplugged/protocol";
import { METHOD_DIR } from "../init/layout.js";
import type { WorkspaceFiles } from "../workspace-files.js";

/**
 * One registry of identical refusals, for every command the engine refuses. A refusal is keyed by
 * its action (the command), its code, its target (the story, the point or the file the call was
 * about) and its reason: the same key again, with nothing done in between, is the same failure. The
 * second one tells the agent not to try a third time, and `state.next` carries `change_method`.
 *
 * It lives in a file of this machine (`.agentplugged/.cache/`, ignored by Git) because the engine
 * answers each call in a process of its own: the file is the memory between two calls. A success
 * of the same action on the same target clears its refusals (the cause may be gone),
 * and a refusal not repeated within `FRESH_MS` is forgotten.
 */
export const REFUSALS_PATH = `${METHOD_DIR}/.cache/refusals.json`;

/** A refusal said once stays in `state.next` this long (milliseconds). */
export const FRESH_MS = 5 * 60 * 1000;
/** A refusal repeated stays in `state.next` this long (milliseconds). */
export const REPEATED_MS = 6 * 60 * 60 * 1000;
/** The most keys kept: the oldest go first. */
const MAX_ENTRIES = 40;
/** The longest reason kept in a key. */
const REASON_MAX = 120;

/** What failed: the engine's refusal of one action, as the registry counts it. */
export interface RefusalEntry {
  readonly key: string;
  /** The command (`start_story`). */
  readonly action: string;
  readonly code: string;
  /** What the call was about (a story, a point, a file), or an empty string. */
  readonly target: string;
  readonly count: number;
  readonly first_at: string;
  readonly at: string;
}

/**
 * The codes that say « try again in a moment » (a lock, the network, a cancelled call): they are
 * never counted, a second try is the right answer to them.
 */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  ErrorCode.JOURNAL_BUSY,
  ErrorCode.JOURNAL_PUSH_REJECTED,
  ErrorCode.JOURNAL_REMOTE_UNREACHABLE,
  ErrorCode.JOURNAL_CONFLICT,
  ErrorCode.CANCELLED,
]);

const TARGET_FIELDS = [
  "story",
  "checkpoint",
  "id",
  "stack",
  "deviation",
  "sprint",
  "path",
  "file",
  "document",
  "page",
  "agent",
] as const;

/** What a call is about: the first of its usual fields that holds a short word or path. */
export function targetOf(input: Readonly<Record<string, unknown>>): string {
  for (const field of TARGET_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value !== "" && value.length <= 160) return value;
  }
  return "";
}

/** The key of a refusal: action, code, target and reason, so that two causes never merge. */
export function refusalKey(action: string, code: string, target: string, reason: string): string {
  return [action, code, target, reason.slice(0, REASON_MAX)].join("|");
}

/** The reason a refusal carries in its details, in a few words (with its message key). */
export function reasonOf(details: Readonly<Record<string, unknown>>, messageKey: string): string {
  for (const field of ["reason", "field", "why", "kind", "checkpoint", "story", "item"]) {
    const value = details[field];
    if (typeof value === "string" && value !== "") return `${messageKey}:${value}`;
  }
  return messageKey;
}

/** True for a refusal too old to count: once said and left alone, or repeated long ago. */
export function isForgotten(entry: RefusalEntry, now: number): boolean {
  const age = now - Date.parse(entry.at);
  return age > (entry.count >= 2 ? REPEATED_MS : FRESH_MS);
}

/** The registry after one more refusal: the same key counts once more, a new one starts at one. */
export function recordRefusal(
  entries: readonly RefusalEntry[],
  refusal: { action: string; code: string; target: string; reason: string },
  at: string,
): { entries: RefusalEntry[]; entry: RefusalEntry } {
  const key = refusalKey(refusal.action, refusal.code, refusal.target, refusal.reason);
  const before = entries.find((entry) => entry.key === key);
  const entry: RefusalEntry =
    before !== undefined && !isForgotten(before, Date.parse(at))
      ? { ...before, count: before.count + 1, at }
      : {
          key,
          action: refusal.action,
          code: refusal.code,
          target: refusal.target,
          count: 1,
          first_at: at,
          at,
        };
  const kept = entries.filter((other) => other.key !== key);
  return { entries: [...kept, entry].slice(-MAX_ENTRIES), entry };
}

/**
 * The registry after a success: the same action on the same target worked, so what it was refused
 * for may be gone and those keys start again.
 */
export function clearRefusals(
  entries: readonly RefusalEntry[],
  action: string,
  target: string,
): RefusalEntry[] {
  return entries.filter((entry) => entry.action !== action || entry.target !== target);
}

/** The refusals still worth telling, the latest first. */
export function liveRefusals(entries: readonly RefusalEntry[], now: number): RefusalEntry[] {
  return entries
    .filter((entry) => !isForgotten(entry, now))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Reads the registry; an unreadable or missing file is an empty one. */
export async function readRefusals(files: WorkspaceFiles): Promise<RefusalEntry[]> {
  try {
    if (!(await files.exists(REFUSALS_PATH))) return [];
    const data: unknown = JSON.parse(await files.readText(REFUSALS_PATH));
    if (!Array.isArray(data)) return [];
    return data.filter(
      (entry): entry is RefusalEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RefusalEntry).key === "string" &&
        Number.isFinite((entry as RefusalEntry).count) &&
        Number.isFinite(Date.parse(String((entry as RefusalEntry).at))),
    );
  } catch {
    return [];
  }
}

/** Writes the registry, or removes its file when it is empty. Never throws: it is a memory, not a gate. */
export async function writeRefusals(
  files: WorkspaceFiles,
  entries: readonly RefusalEntry[],
): Promise<void> {
  try {
    if (entries.length === 0) await files.remove(REFUSALS_PATH);
    else await files.writeText(REFUSALS_PATH, `${JSON.stringify(entries)}\n`);
  } catch {
    // The registry is best effort.
  }
}

/**
 * What to do after a refusal, by code, for the agent that reads it: the gesture, never a retry of
 * the same call. Codes not listed say nothing more than their message.
 */
export const REFUSAL_GESTURES: Readonly<Record<string, string>> = {
  [ErrorCode.ROLE_FORBIDDEN]:
    "This action is not in your role. Hand the work to the agent it belongs to (agent.delegate) or ask Noah; do not call it again.",
  [ErrorCode.CHECKPOINT_OPEN]:
    "A point for the creator blocks this action. Read state.next: it names the point; go on with other work and do not retry before it is answered.",
  [ErrorCode.CHECKPOINT_NOT_FOUND]:
    "No such point. Read state.next (`waiting`, `decisions`) for the real identifier.",
  [ErrorCode.CHECKPOINT_NOT_OPEN]:
    "This point is already settled. Read state.next for what waits now.",
  [ErrorCode.INVALID_ARGUMENTS]:
    "The call is malformed: send the fields in `expected` (or the `field` named), nothing else, then call once more.",
  [ErrorCode.UNKNOWN_COMMAND]:
    "This action does not exist for you. The tools and actions are the ones the server lists.",
  [ErrorCode.MERGE_FAILED]:
    "The merge was not done. Read state.next (`waiting[].failure`): it says what to fix; fix that, then ask again once.",
  [ErrorCode.MERGE_NOT_READY]:
    "The story is not ready to merge. Read state.next for the step that comes first (review, CI, a pull request).",
  [ErrorCode.MERGE_CONFLICT]:
    "The branch conflicts with main. Resolve it on the story's branch, run the tests again, then ask once more.",
  [ErrorCode.STORY_LOCKED]:
    "Open deferred-work items lock this story. Close or drop them (plan.complete_deferred), or tell Noah; do not retry before.",
  [ErrorCode.STORY_NOT_STARTABLE]:
    "This story cannot start yet. Read the reason in the message, fix that (a validation, a dependency) and start once more.",
  [ErrorCode.REVIEW_REQUIRED]:
    "Only the creator at the terminal answers this point: tell Noah to give them the command named; do not answer it yourself.",
  [ErrorCode.REVIEW_NOT_POSSIBLE]:
    "The review cannot run now. Read state.next for the step that comes first.",
  [ErrorCode.PHASE_NOT_CURRENT]:
    "That phase is not the current one. Read state.next (`phase`) and work on the current phase only.",
  [ErrorCode.DOCUMENT_NOT_COMMITTED]:
    "Commit the cited documents on the branch the point names, then open the point again once.",
  [ErrorCode.CRITERIA_NOT_PROVEN]:
    "Some criteria have no proof. Record each (story.criterion), red then green, then submit again.",
  [ErrorCode.BUDGET_EXCEEDED]:
    "The budget is reached. Stop spending: report it to Noah, who asks the creator.",
  [ErrorCode.SPRINT_INVALID]:
    "The sprint is not valid. Fix what the message lists (validation, dependency, capacity), then propose it once more.",
  [ErrorCode.STORY_SHEET_TOO_LONG]:
    "The story sheet is over its length. Cut the story in two, then run `docs sheet` again.",
  [ErrorCode.STORY_INTENT_CHANGED]:
    "The story intent no longer matches the one the creator approved. Restore the approved intent in the story file, or open its document point again for the creator.",
  [ErrorCode.PULL_REQUEST_NOT_OPENABLE]:
    "No pull request can be opened now. Read the reason in the message, fix that, then ask once.",
  [ErrorCode.PULL_REQUEST_FAILED]:
    "The forge refused the pull request. Read the reason in the message; do not retry the same call.",
  [ErrorCode.FORGE_NOT_LINKED]:
    "The repository has no usable forge here. Tell Noah: the creator links it, you cannot.",
  [ErrorCode.CI_UNAVAILABLE]: "The CI result is not available. Tell Noah; do not poll in a loop.",
  [ErrorCode.DELEGATION_INVALID]:
    "The delegation is not valid. Read the reason, give a story and an active agent, then delegate once more.",
  [ErrorCode.AGENT_NOT_CLOSER]:
    "Only the agent that closes this phase may do this. Hand it over to that agent.",
  [ErrorCode.DOCUMENT_REVIEW_OPEN]:
    "A document of this phase still waits for the creator. Read state.next and wait for the answer.",
  [ErrorCode.SECURITY_REVIEW_MISSING]:
    "The security review is missing. Ask Chloé for it first, then call again.",
  [ErrorCode.METHOD_NOT_INSTALLED]:
    "The method is not installed here. Tell the creator to run `npx agentplugged init`.",
  [ErrorCode.ENGINE_VERSION_MISMATCH]:
    "The engine is not the version the product pins. Tell the creator; do not go on with this version.",
  [ErrorCode.UPGRADE_REQUIRED]:
    "The product needs a newer engine or a migration. Tell the creator; do not go on.",
  [ErrorCode.STACK_NOT_FOUND]: "No such stack. Open one (chat.stack_open) from state.next `pile`.",
  [ErrorCode.STACK_CLOSED]: "This stack is closed. Read state.next for what waits now.",
  [ErrorCode.FAST_TRACK_NOT_POSSIBLE]:
    "The fast lane is not possible for this story. Follow the full steps of state.next.",
  [ErrorCode.DEVIATION_NOT_ALLOWED]: "You may not do this about a deviation. Report it to Noah.",
};

/** The gesture after a refusal with this code, or undefined. */
export function gestureOf(code: string): string | undefined {
  return Object.hasOwn(REFUSAL_GESTURES, code) ? REFUSAL_GESTURES[code] : undefined;
}

/** What a refusal said twice means: the same call again is refused again. */
export function repeatedGesture(times: number, gesture: string | undefined): string {
  const base = `Refused ${times} times for the same cause: do not try it again the same way. Change the method: have the cause investigated, or put the block to the creator in one question.`;
  return gesture === undefined ? base : `${base} ${gesture}`;
}
