import { sha256Hex } from "@agentplugged/crypto";
import { significantWords } from "../agents/workshop-rules.js";
import type { TriggerQuery } from "./eval-cases.js";
import { callsOfLine, type ToolCall } from "./eval-transcript.js";

/**
 * When a skill is called, and when it stays quiet, pure. Two measures, one question:
 * - by words (free, the same every time, in the normal test suite): which skill the words of a
 *   request point to, among the descriptions an agent reads at every request;
 * - for real (an agent runs the request): did it load the skill. Only a call counts, never a
 *   skill's name seen in a list.
 */

export interface Candidate {
  readonly name: string;
  readonly description: string;
}

/** The first letters of a word: « review », « reviews », « reviewing » are one. */
const stem = (word: string) => word.slice(0, 5);

function stemsOf(text: string): Set<string> {
  return new Set([...significantWords(text)].map(stem));
}

/** What the words of a request point to: the skill with the most words in common, if it stands out. */
export interface Route {
  readonly skill?: string;
  readonly score: number;
  readonly second: number;
}

/**
 * A request points to the skill whose name and description share the most words with it, and only
 * when it leads: two skills at the same score are a request the descriptions do not tell apart.
 * The name counts whole (« prd » is three letters, still a word).
 */
export function routeByWords(query: string, candidates: readonly Candidate[]): Route {
  const asked = stemsOf(query);
  const askedWords = new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const scores = candidates.map((candidate) => {
    const known = stemsOf(candidate.description);
    let score = 0;
    for (const word of asked) if (known.has(word)) score += 1;
    for (const part of candidate.name.toLowerCase().split("-")) {
      if (part.length >= 2 && askedWords.has(part)) score += 1;
    }
    return { name: candidate.name, score };
  });
  scores.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const best = scores[0];
  const second = scores[1]?.score ?? 0;
  if (best === undefined || best.score === 0 || best.score === second) {
    return { score: best?.score ?? 0, second };
  }
  return { skill: best.name, score: best.score, second };
}

/** One query judged: did the skill fire, and was that right. */
export interface QueryVerdict {
  readonly query: string;
  readonly should_trigger: boolean;
  readonly fired: boolean;
  readonly ok: boolean;
}

export interface TriggerScore {
  readonly verdicts: readonly QueryVerdict[];
  /** Must fire, did not: the description is too narrow here. */
  readonly missed: number;
  /** Must stay quiet, fired: the description is too broad here. */
  readonly wrong: number;
  readonly correct: number;
  readonly total: number;
}

export function scoreTriggers(
  queries: readonly TriggerQuery[],
  fired: (query: string) => boolean,
): TriggerScore {
  const verdicts = queries.map((entry) => {
    const did = fired(entry.query);
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      fired: did,
      ok: did === entry.should_trigger,
    };
  });
  return {
    verdicts,
    missed: verdicts.filter((v) => v.should_trigger && !v.fired).length,
    wrong: verdicts.filter((v) => !v.should_trigger && v.fired).length,
    correct: verdicts.filter((v) => v.ok).length,
    total: verdicts.length,
  };
}

/** The measure by words: a request fires the skill when the words point to it. */
export function scoreTriggersByWords(
  skill: string,
  queries: readonly TriggerQuery[],
  candidates: readonly Candidate[],
): TriggerScore {
  return scoreTriggers(queries, (query) => routeByWords(query, candidates).skill === skill);
}

// ---------------------------------------------------------------------------------------------
// The split: improve a description on one part of the queries, judge it on the other

export type QuerySet = "train" | "test";

/** The share of each side that trains: the rest is held out, never shown to whoever improves. */
export const TRAIN_SHARE = 0.6;

/** An id of a query that does not move when others are added: the start of its hash. */
export const queryId = (query: string): string =>
  sha256Hex(query.toLowerCase().replace(/\s+/gu, " ").trim()).slice(0, 8);

/**
 * Splits the queries 60/40, the same way every time, keeping the share of queries that must fire
 * and of those that must not in both halves (a split that put all the near misses in one half
 * would hide the false positives from the other). The order is by hash, so it does not depend on
 * the order the creator wrote them in, and a query never changes sides when another is added.
 */
export function splitQueries(queries: readonly TriggerQuery[]): {
  train: TriggerQuery[];
  test: TriggerQuery[];
} {
  const train: TriggerQuery[] = [];
  const test: TriggerQuery[] = [];
  for (const side of [true, false]) {
    const group = queries
      .filter((entry) => entry.should_trigger === side)
      .sort((a, b) => queryId(a.query).localeCompare(queryId(b.query)));
    // At least one in each half when the side has two or more.
    const cut =
      group.length < 2
        ? group.length
        : Math.min(group.length - 1, Math.max(1, Math.round(group.length * TRAIN_SHARE)));
    train.push(...group.slice(0, cut));
    test.push(...group.slice(cut));
  }
  return { train, test };
}

// ---------------------------------------------------------------------------------------------
// For real: did the agent load the skill

function loads(call: ToolCall, skill: string): boolean {
  if (call.name === "Skill") {
    const named = call.input.skill ?? call.input.name ?? call.input.command;
    return typeof named === "string" && named.replace(/^\//u, "") === skill;
  }
  if (call.name === "Read") {
    const path = call.input.file_path;
    return typeof path === "string" && path.replaceAll("\\", "/").includes(`/skills/${skill}/`);
  }
  return false;
}

/** True when one of the calls loads the skill (its tool, or a read of its folder). */
export function skillLoaded(calls: readonly ToolCall[], skill: string): boolean {
  return calls.some((call) => loads(call, skill));
}

/** True when this line of the stream is the call that loads the skill: the run can stop there. */
export function lineLoadsSkill(line: string, skill: string): boolean {
  return callsOfLine(line).some((call) => loads(call, skill));
}
