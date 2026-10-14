import {
  criterionId,
  type QaCheck,
  type QaProof,
  type QaVerdict,
  qaProofBelongs,
} from "@agentplugged/protocol";
import type { StackEntry } from "../review/review-lenses.js";

/**
 * What the journal holds of a story's acceptance QA, and the rules that check a report (story
 * 18.5). Nothing here reads a file or a process: the rules are pure, the command feeds them.
 */

/** `state.stories.<id>.qa`: the latest report, whole; a new report replaces it. */
export interface QaRecord {
  readonly at: string;
  readonly by: string;
  readonly event: string;
  readonly commit: string | null;
  readonly clean: boolean | null;
  /** By criterion number. */
  readonly results: Readonly<Record<string, QaResult>>;
  /** Criteria nothing observable through the interface tells, with the reason. */
  readonly outside: Readonly<Record<string, string>>;
}

export interface QaResult {
  readonly verdict: QaVerdict;
  readonly origin: "engine" | "reported";
  readonly proofs: readonly QaProof[];
  readonly observed: string | null;
}

/** The most problems of a report told at once. */
const MAX_PROBLEMS = 8;

const numbers = (list: readonly number[]) => list.join(",");

/**
 * The problems of a report against the story's `count` criteria, as short lines the agent can fix.
 * A report is closed: every criterion once, played or declared outside the interface.
 */
export function reportProblems(story: string, count: number, check: QaCheck): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  const twice: number[] = [];
  const unknown: number[] = [];
  const entries = [
    ...check.scenarios.map((scenario) => scenario.criterion),
    ...(check.outside ?? []).map((entry) => entry.criterion),
  ];
  for (const n of entries) {
    if (n > count) unknown.push(n);
    else if (seen.has(n)) twice.push(n);
    seen.add(n);
  }
  if (unknown.length > 0) {
    problems.push(`unknown_criterion:${numbers(unknown)} (the story lists ${count})`);
  }
  if (twice.length > 0) problems.push(`listed_twice:${numbers(twice)}`);
  const missing: number[] = [];
  for (let n = 1; n <= count; n++) if (!seen.has(n)) missing.push(n);
  if (missing.length > 0) {
    problems.push(
      `not_whole: criteria ${numbers(missing)} need a scenario, or \`outside\` with a reason`,
    );
  }
  for (const scenario of check.scenarios) {
    const n = scenario.criterion;
    if (scenario.run === true) {
      if (
        scenario.verdict !== undefined ||
        scenario.proofs !== undefined ||
        scenario.observed !== undefined
      ) {
        problems.push(
          `${n}: run:true gives nothing else (the engine reads the verdict and the proofs)`,
        );
      }
      continue;
    }
    if (scenario.verdict === undefined) {
      problems.push(`${n}: give a verdict (passed, failed, blocked), or run:true`);
      continue;
    }
    if (scenario.verdict !== "passed" && scenario.observed === undefined) {
      problems.push(`${n}: ${scenario.verdict} needs \`observed\``);
    }
    const id = criterionId(story, n);
    for (const path of scenario.proofs ?? []) {
      if (!qaProofBelongs(path, id)) {
        problems.push(`${n}: ${path} does not carry ${id} in its name`);
      }
    }
  }
  return problems.slice(0, MAX_PROBLEMS);
}

/** Text safe to keep in the journal from what a page or a tool printed: no tag, one line, cut. */
export function safeObserved(text: string, max = 300): string {
  const flat = text
    .replace(/[<>]/g, " ")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(flat)) return "no readable detail";
  // By code point: a cut never splits an emoji, which the journal would refuse.
  const points = [...flat];
  return points.length <= max ? flat : `${points.slice(0, max - 1).join("")}…`;
}

const startsWith = (bytes: Uint8Array, at: number, mark: readonly number[]) =>
  mark.every((byte, index) => bytes[at + index] === byte);

/**
 * True when the bytes begin as the kind of file the name claims (PNG, JPEG, WebP, WebM, MP4): a
 * proof is something to look at, not a name given to any bytes. The content itself is not judged.
 */
export function looksLikeProof(path: string, bytes: Uint8Array): boolean {
  const name = path.toLowerCase();
  if (name.endsWith(".png")) return startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47]);
  if (name.endsWith(".jpg") || name.endsWith(".jpeg"))
    return startsWith(bytes, 0, [0xff, 0xd8, 0xff]);
  if (name.endsWith(".webp")) {
    return (
      startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])
    );
  }
  if (name.endsWith(".webm")) return startsWith(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3]);
  if (name.endsWith(".mp4")) return startsWith(bytes, 4, [0x66, 0x74, 0x79, 0x70]);
  return false;
}

/** What a criterion shows of its QA, for the trace and the walk through the change. */
export interface QaTrace {
  readonly verdict: QaVerdict;
  /** The proof files, in the order kept. */
  readonly proofs: readonly string[];
  readonly observed?: string;
}

/** The QA of criterion `n` in a record, when it was played; `outside` and absent give undefined. */
export function qaTraceOf(record: QaRecord | undefined, n: number): QaTrace | undefined {
  const result = record?.results[String(n)];
  if (result === undefined) return undefined;
  return {
    verdict: result.verdict,
    proofs: result.proofs.map((proof) => proof.path),
    ...(result.observed === null ? {} : { observed: result.observed }),
  };
}

/**
 * The failures of a QA as findings of the story: a scenario that failed is blocking (the product
 * does not do what the criterion says), one that could not be played is to fix. They join the
 * stack the creator reads at the merge, beside the findings of the reviewers.
 */
export function qaStackEntries(record: QaRecord | undefined): StackEntry[] {
  if (record === undefined) return [];
  const entries: StackEntry[] = [];
  for (const [key, result] of Object.entries(record.results)) {
    if (result.verdict === "passed") continue;
    const n = Number(key);
    entries.push({
      severity: result.verdict === "failed" ? "blocking" : "should_fix",
      title: `QA ${result.verdict}: ${result.observed ?? "no detail"}`,
      criterion: n,
      decision: null,
    });
  }
  return entries.sort((a, b) => (a.criterion ?? 0) - (b.criterion ?? 0));
}

/** The counts of a report, one bounded line: `passed 3, failed 1, blocked 0, outside 1`. */
export function qaLine(
  results: readonly { readonly verdict: QaVerdict }[],
  outside: number,
): string {
  const count = (verdict: QaVerdict) =>
    results.filter((result) => result.verdict === verdict).length;
  return `passed ${count("passed")}, failed ${count("failed")}, blocked ${count("blocked")}, outside ${outside}`;
}
