import type { CriterionStatus } from "../criteria/criterion-rules.js";
import type { StoryTrace } from "../criteria/criterion-trace.js";
import type { QaTrace } from "../qa/qa-rules.js";
import type { ReuseReport } from "../reuse/reuse.js";
import { isTestPath } from "../trace/test-references.js";
import { changeFacts, isDocumentPath, isLockfile, type StackEntry } from "./review-lenses.js";
import { type DiffFile, sensitivePath } from "./review-rules.js";

/**
 * The walk through a change for the creator, computed and never written by an agent:
 * the files in the order to read them (the riskiest first), why each one, the lines to look at,
 * and for each acceptance criterion how to see it by hand, saying first what the tests already
 * prove. It is drawn from what the engine already holds (the diff, the open findings of the
 * review, the trace of the criteria, the proved duplicates, what the write guard refused, the
 * user journeys of the UX specification) and fits in the room left in the merge checkpoint, beside
 * the stack of the findings and never repeating it.
 */

/** A criterion as the walk reads it: its text, where it stands, the tests that cite it. */
export interface WalkCriterion {
  readonly n: number;
  readonly text: string;
  readonly status: CriterionStatus;
  readonly origin: "engine" | "reported" | null;
  /** `path:line` of the tests that cite it, as the trace found them. */
  readonly tests: readonly string[];
  /** Why it is declared untestable, when it is. */
  readonly reason?: string | undefined;
  /** What the acceptance QA in a browser saw of it. */
  readonly qa?: QaTrace | undefined;
}

/** A journey of the UX specification: its name, what it covers and its first steps. */
export interface UxFlow {
  readonly name: string;
  readonly covers: readonly string[];
  readonly steps: readonly string[];
}

export interface WalkInputs {
  readonly files: readonly DiffFile[];
  /** The findings of the review that are not fixed (`StackEntry`, as the stack reads them). */
  readonly findings: readonly StackEntry[];
  readonly criteria: readonly WalkCriterion[];
  readonly reuse?: ReuseReport | undefined;
  /** Files the guard before a write refused, or whose scope the creator widened. */
  readonly guarded?: readonly string[] | undefined;
  readonly flows?: readonly UxFlow[] | undefined;
  /** The requirements of the story, for the journeys that cover them. */
  readonly requirements?: readonly string[] | undefined;
}

/** A file to read, with why and where. */
export interface WalkStop {
  readonly path: string;
  /** The lines to look at: closed ranges of the new side, at most `MAX_RANGES`. */
  readonly ranges: readonly (readonly [number, number])[];
  readonly score: number;
  /** Stable short reasons, in the order they weigh. */
  readonly why: readonly string[];
}

/** How to see one criterion by hand. */
export interface WalkStep {
  readonly n: number;
  /** The tests prove it (the engine saw them fail, then pass): nothing to redo. */
  readonly proven: boolean;
  /** Where the tests that cover it are, when any. */
  readonly covered: string | null;
  /** What to do, then what to expect (at most `MAX_ACTIONS` + 1 lines). */
  readonly steps: readonly string[];
  /** The QA in a browser, one short phrase with the first proof; null when it was not played. */
  readonly qa: string | null;
}

export interface Walkthrough {
  readonly stops: readonly WalkStop[];
  /** Files left out of `stops` (lower risk, locks and the like), counted. */
  readonly more: number;
  readonly steps: readonly WalkStep[];
}

/** The weight of each reason a file is read early: the order is the engine's, not an agent's. */
export const WEIGHTS = {
  blocking: 100,
  should_fix: 40,
  minor: 10,
  sensitive: 50,
  dependencies: 50,
  migrations: 50,
  guard: 40,
  duplicate: 30,
  twin: 10,
  criterion: 15,
  created: 5,
} as const;

/** Files shown in the walk, ranges per file, hand-test actions per criterion. */
export const WALK_STOPS = 6;
export const MAX_RANGES = 3;
export const MAX_ACTIONS = 2;
/** Criteria with a line of their own in the text (the rest is counted). */
export const WALK_STEPS = 8;
/** The text of the walk, at most: one screen beside the stack of the findings. */
export const WALK_CHARS = 900;
/** Below this room, the walk is not shown (a fragment would only mislead). */
export const WALK_MIN_CHARS = 160;

const PATH_SHOWN = 46;
const FLOW_STEP = 36;
const EXPECT = 70;

const slash = (path: string) => path.replaceAll("\\", "/");
const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
const tail = (text: string, max: number) =>
  text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** The name of a source or test file with what marks it a test taken off: `a/foo.test.ts` -> `foo`. */
function stemOf(path: string): string {
  const name = slash(path).split("/").at(-1) ?? "";
  const bare = name.replace(/\.[^.]+$/, "");
  return bare
    .replace(/^test[_-]/i, "")
    .replace(/(?:[._-](?:test|tests|spec|specs|e2e|cy)|(?<=[a-z0-9])(?:Test|Tests|Spec))$/, "")
    .toLowerCase();
}

/** Contiguous added lines of a file, as closed ranges. */
function addedRanges(file: DiffFile): [number, number][] {
  const added = [...file.lines].filter(([, old]) => old === null).map(([line]) => line);
  added.sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const line of added) {
    const last = ranges.at(-1);
    if (last !== undefined && line === last[1] + 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges;
}

/** Closed ranges merged when they touch or overlap, in line order. */
function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = ranges.map(([a, b]): [number, number] => [a, b]).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

const rangeText = (ranges: readonly (readonly [number, number])[]) =>
  ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",");

/** The folder of a file, without the folder of tests that may hold its test (`a/__tests__` -> `a`). */
function homeOf(path: string): string {
  return slash(path)
    .split("/")
    .slice(0, -1)
    .join("/")
    .replace(/(?:^|\/)(?:__tests__|tests?|specs?)$/i, "");
}

/**
 * The criteria a source file serves: those cited by a test that carries its name and sits beside
 * it (or in its folder of tests), so that two `index.ts` of one repository are not mistaken.
 */
function servedBy(path: string, criteria: readonly WalkCriterion[]): number[] {
  const stem = stemOf(path);
  if (stem === "") return [];
  return criteria
    .filter((criterion) =>
      criterion.tests.some((place) => {
        const test = place.replace(/:\d+$/, "");
        return stemOf(test) === stem && homeOf(test) === homeOf(path);
      }),
    )
    .map((criterion) => criterion.n);
}

/**
 * True when a place the guard acted on is this file: the guard keeps the path as the write named it
 * (often absolute), a widened scope may be a folder (`packages/`).
 */
function guardedMatch(place: string, path: string): boolean {
  if (place.endsWith("/")) {
    const folders = path.split("/").slice(0, -1);
    return folders.some((_, index) => {
      const folder = `${folders.slice(0, index + 1).join("/")}/`;
      return place === folder || place.endsWith(`/${folder}`);
    });
  }
  return place === path || place.endsWith(`/${path}`);
}

/** The files to read, in order: the weightiest first, ties in path order; locks left out. */
function stopsOf(inputs: WalkInputs): { stops: WalkStop[]; more: number } {
  const found: WalkStop[] = [];
  let skipped = 0;
  const entries = inputs.findings.filter((entry) => entry.decision !== "fix");
  const guarded = (inputs.guarded ?? []).map(slash);
  for (const file of inputs.files) {
    const path = slash(file.path);
    if (isLockfile(path)) {
      skipped++;
      continue;
    }
    const facts = changeFacts([{ path, added: file.added, removed: file.removed }]);
    const reasons: { weight: number; reason: string }[] = [];
    let score = 0;
    const add = (weight: number, reason: string) => {
      score += weight;
      reasons.push({ weight, reason });
    };
    const lines: { range: [number, number]; weight: number }[] = [];
    const mine = entries.filter((entry) => entry.path !== undefined && slash(entry.path) === path);
    for (const entry of mine) {
      if (entry.line !== undefined) {
        lines.push({ range: [entry.line, entry.line], weight: WEIGHTS[entry.severity] });
      }
    }
    const blocking = mine.filter((entry) => entry.severity === "blocking").length;
    const fix = mine.filter((entry) => entry.severity === "should_fix").length;
    const minor = mine.length - blocking - fix;
    if (blocking > 0)
      add(WEIGHTS.blocking, `${blocking} blocking finding${blocking === 1 ? "" : "s"} open`);
    if (fix > 0) add(WEIGHTS.should_fix, `${fix} finding${fix === 1 ? "" : "s"} to fix open`);
    if (minor > 0) add(WEIGHTS.minor, `${minor} minor finding${minor === 1 ? "" : "s"} open`);
    if (facts.dependencies) add(WEIGHTS.dependencies, "dependencies");
    if (facts.migrations) add(WEIGHTS.migrations, "migration");
    if (sensitivePath(path)) add(WEIGHTS.sensitive, "sensitive path");
    if (guarded.some((place) => guardedMatch(place, path))) {
      add(WEIGHTS.guard, "guard refused or widened");
    }
    for (const duplicate of inputs.reuse?.duplicates ?? []) {
      if (slash(duplicate.here.path) !== path) continue;
      lines.push({ range: [duplicate.here.from, duplicate.here.to], weight: WEIGHTS.duplicate });
      add(
        WEIGHTS.duplicate,
        `repeats ${tail(slash(duplicate.there.path), 30)}:${duplicate.there.from}`,
      );
      break;
    }
    const twin = (inputs.reuse?.twins ?? []).find((candidate) => slash(candidate.path) === path);
    if (twin !== undefined) {
      lines.push({ range: [twin.line, twin.line], weight: WEIGHTS.twin });
      add(WEIGHTS.twin, `may repeat ${twin.twin.name}`);
    }
    const served = [
      ...new Set([
        ...servedBy(path, inputs.criteria),
        ...mine.flatMap((entry) => (entry.criterion === undefined ? [] : [entry.criterion])),
      ]),
    ].sort((a, b) => a - b);
    if (served.length > 0) add(WEIGHTS.criterion, `criterion ${served.join(",")}`);
    if (file.old_path === null) score += WEIGHTS.created;
    // A test or a document is read after the code, unless a finding sits on it.
    const test = isTestPath(path);
    if ((test || isDocumentPath(path)) && mine.length === 0) score = Math.floor(score / 2);
    // The heaviest reason first, so the shortest rendering keeps the one that matters.
    const why = reasons
      .map((entry, index) => ({ ...entry, index }))
      .sort((a, b) => b.weight - a.weight || a.index - b.index)
      .map((entry) => entry.reason);
    if (test) why.push("test");
    // The ranges that weigh most are kept, shown in line order.
    const chosen = lines
      .map((entry, index) => ({ ...entry, index }))
      .sort((a, b) => b.weight - a.weight || a.index - b.index)
      .slice(0, MAX_RANGES)
      .map((entry) => entry.range);
    const ranges = chosen.length > 0 ? mergeRanges(chosen) : addedRanges(file).slice(0, MAX_RANGES);
    found.push({ path, ranges, score, why });
  }
  // At equal weight, code before tests before documents, then by path: the same walk for the same change.
  const kindRank = (path: string) => (isTestPath(path) ? 1 : isDocumentPath(path) ? 2 : 0);
  found.sort(
    (a, b) =>
      b.score - a.score ||
      kindRank(a.path) - kindRank(b.path) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return {
    stops: found.slice(0, WALK_STOPS),
    more: Math.max(0, found.length - WALK_STOPS) + skipped,
  };
}

/** Commands the criterion writes between backticks: the way to run what it describes. */
function commandsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/`([^`\n]{3,100})`/g)) {
    const code = (match[1] ?? "").trim();
    const command =
      /^(?:corepack|pnpm|npm|npx|yarn|bun|node|deno|git|gh|docker|make|cargo|go|dotnet|python3?|pip|uv|pytest|ruby|bundle|php|composer|mvn|gradle|curl|agentplugged)\b/.test(
        code,
      );
    if (command && !found.includes(code)) found.push(code);
  }
  return found;
}

/** The ids of requirements a text cites (`EF-12`, `PU-3`). */
const idsIn = (text: string) => [...text.matchAll(/\b(?:EF|ENF|PU)-\d{1,4}\b/g)].map((m) => m[0]);

/** The criteria's actions for one criterion: commands first, else the journey it follows, else a plain check. */
function actionsOf(criterion: WalkCriterion, inputs: WalkInputs): string[] {
  const actions = commandsIn(criterion.text).map((command) => `run \`${command}\``);
  if (actions.length < MAX_ACTIONS) {
    const own = idsIn(criterion.text);
    const wanted = own.length > 0 ? own : actions.length === 0 ? (inputs.requirements ?? []) : [];
    const flow = (inputs.flows ?? []).find((candidate) =>
      candidate.covers.some((id) => wanted.includes(id)),
    );
    if (flow !== undefined && flow.steps.length > 0) {
      actions.push(
        `follow the journey "${cut(flow.name, 40)}": ${flow.steps
          .slice(0, 3)
          .map((step) => cut(flat(step), FLOW_STEP))
          .join(" > ")}`,
      );
    }
  }
  if (actions.length === 0) actions.push("open it where the change shows and try it");
  return actions.slice(0, MAX_ACTIONS);
}

/** The criterion's own words, short: what to see when it works. */
const expectOf = (text: string) => cut(flat(text.replace(/`/g, "")).replace(/[.;:]+$/, ""), EXPECT);

/** What the acceptance QA in a browser saw of a criterion, in a phrase with its first proof. */
function qaPhrase(qa: QaTrace | undefined): string | null {
  if (qa === undefined) return null;
  if (qa.verdict === "passed") {
    const first = qa.proofs[0];
    const more = qa.proofs.length - 1;
    return `passed${first === undefined ? "" : ` (${tail(first, 40)}${more > 0 ? ` +${more}` : ""})`}`;
  }
  return `${qa.verdict}${qa.observed === undefined ? "" : `: ${cut(flat(qa.observed), 50)}`}`;
}

/** The text of the QA part, at most this long: what failed first, the rest counted. */
export const QA_WALK_CHARS = 300;

/** What the acceptance QA in a browser saw, failures first, within `QA_WALK_CHARS`; empty when it did not play. */
function qaText(steps: readonly WalkStep[]): string {
  const seen = steps.filter((step) => step.qa !== null);
  const worst = (step: WalkStep) => (step.qa?.startsWith("passed") === true ? 1 : 0);
  const ordered = [...seen].sort((a, b) => worst(a) - worst(b) || a.n - b.n);
  const shown: string[] = [];
  let used = 0;
  for (const step of ordered) {
    const text = `AC${step.n} ${step.qa}`;
    if (shown.length > 0 && used + text.length + 3 > QA_WALK_CHARS) break;
    shown.push(text);
    used += text.length + 3;
  }
  if (shown.length === 0) return "";
  const left = seen.length - shown.length;
  return `Played in a browser by QA: ${shown.join(" ; ")}${left > 0 ? ` ; +${left} more` : ""}.`;
}

function stepsOf(inputs: WalkInputs): WalkStep[] {
  return inputs.criteria.map((criterion): WalkStep => {
    const proven =
      (criterion.status === "green" || criterion.status === "covered") &&
      criterion.origin !== "reported";
    const covered = criterion.tests[0] ?? null;
    const reason = criterion.status === "untestable" ? criterion.reason : undefined;
    return {
      n: criterion.n,
      proven,
      covered,
      qa: qaPhrase(criterion.qa),
      steps: [
        ...actionsOf(criterion, inputs),
        `expect: ${reason === undefined ? expectOf(criterion.text) : `${expectOf(criterion.text)} (no test: ${cut(reason, 50)})`}`,
      ],
    };
  });
}

/** The walk through a change: pure, the same inputs always give the same walk. */
export function walkthrough(inputs: WalkInputs): Walkthrough {
  const { stops, more } = stopsOf(inputs);
  return { stops, more, steps: stepsOf(inputs) };
}

interface Shape {
  /** Stops shown. */
  readonly stops: number;
  /** Criteria that keep a line of their own. */
  readonly lines: number;
  /** Lines of criteria the tests prove are kept (else they are said in one phrase). */
  readonly proven: boolean;
  /** Reasons shown per stop. */
  readonly reasons: number;
  /** Actions shown per criterion (0: the expectation alone). */
  readonly actions: number;
}

function stopText(stop: WalkStop, index: number, shape: Shape): string {
  const where = `${tail(stop.path, PATH_SHOWN)}${stop.ranges.length === 0 ? "" : `:${rangeText(stop.ranges)}`}`;
  const why = stop.why.slice(0, shape.reasons).join(", ");
  return `${index + 1}) ${where}${why === "" ? "" : ` (${why})`}`;
}

function stepText(step: WalkStep, shape: Shape): string {
  const head = step.proven
    ? `AC${step.n} (tests cover it${step.covered === null ? "" : `: ${tail(step.covered, 32)}`})`
    : `AC${step.n}`;
  const actions = step.steps.slice(0, Math.max(0, Math.min(shape.actions, step.steps.length - 1)));
  const expect = step.steps.at(-1) ?? "";
  return `${head} ${[...actions, expect].join("; ")}`;
}

function render(walk: Walkthrough, shape: Shape): string {
  const stops = walk.stops.slice(0, shape.stops);
  const left = walk.stops.length - stops.length + walk.more;
  const proven = walk.steps.filter((step) => step.proven);
  const listed = walk.steps
    .filter((step) => !step.proven || shape.proven)
    .slice(0, Math.max(0, shape.lines));
  const hidden = walk.steps.filter(
    (step) => (!step.proven || shape.proven) && !listed.includes(step),
  ).length;
  const parts: string[] = [];
  if (stops.length > 0) {
    parts.push(
      `Read first, riskiest first: ${stops.map((stop, index) => stopText(stop, index, shape)).join(" ; ")}${left > 0 ? ` ; +${left} more file${left === 1 ? "" : "s"}, lower risk` : ""}.`,
    );
  }
  if (walk.steps.length > 0) {
    const skip =
      proven.length === 0 || shape.proven
        ? ""
        : ` Tests already prove ${proven.map((step) => step.n).join(",")} of ${walk.steps.length}: do not redo.`;
    const lines = listed.map((step) => stepText(step, shape));
    if (hidden > 0) {
      lines.push(
        `${lines.length === 0 ? "" : "+"}${hidden} criteri${hidden === 1 ? "on" : "a"}, see the story`,
      );
    }
    const seen = qaText(walk.steps);
    if (seen !== "") parts.push(seen);
    // Everything proven by the tests: nothing to try, and the sentence says so.
    if (lines.length > 0) parts.push(`To try by hand: ${lines.join(" ; ")}.${skip}`);
    else if (skip !== "") parts.push(skip.trim());
  }
  return parts.join(" ");
}

/**
 * The walk as the creator reads it, at most `max` characters (`WALK_CHARS` when the room allows):
 * empty when there is nothing to walk or no room. The text shrinks in a fixed order (the lines of
 * the criteria the tests prove, then the actions, then the reasons, then the files), never by
 * cutting a sentence in two, and the riskiest file and the first criterion survive to the end.
 */
export function walkthroughText(walk: Walkthrough, max: number = WALK_CHARS): string {
  const room = Math.min(max, WALK_CHARS);
  if (room < WALK_MIN_CHARS || (walk.stops.length === 0 && walk.steps.length === 0)) return "";
  const shapes: Shape[] = [];
  const stops = Math.min(walk.stops.length, WALK_STOPS);
  const lines = Math.min(walk.steps.length, WALK_STEPS);
  for (const proven of [true, false]) {
    for (const actions of [MAX_ACTIONS, 1, 0]) {
      shapes.push({ stops, lines, proven, reasons: 3, actions });
    }
  }
  for (const reasons of [2, 1]) shapes.push({ stops, lines, proven: false, reasons, actions: 0 });
  for (let s = stops - 1; s >= 1; s--) {
    shapes.push({ stops: s, lines, proven: false, reasons: 1, actions: 0 });
  }
  for (let l = lines - 1; l >= 1; l--) {
    shapes.push({ stops: Math.min(stops, 1), lines: l, proven: false, reasons: 1, actions: 0 });
  }
  for (const shape of shapes) {
    const text = render(walk, shape);
    if (text.length <= room) return text;
  }
  // Nothing fits whole: the riskiest file alone, cut at the room.
  return cut(
    render(walk, { stops: Math.min(stops, 1), lines: 0, proven: false, reasons: 1, actions: 0 }),
    room,
  );
}

/** The criteria of a story as the walk reads them: its listed text and the trace the engine computed. */
export function walkCriteria(
  listed: readonly string[],
  trace: StoryTrace | undefined,
): WalkCriterion[] {
  if (trace === undefined) return [];
  return trace.criteria.map((entry) => ({
    n: entry.n,
    text: listed[entry.n - 1] ?? "",
    status: entry.status,
    origin: entry.origin,
    tests: entry.tests,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    ...(entry.qa === undefined ? {} : { qa: entry.qa }),
  }));
}

/** The longest summary a checkpoint holds. */
export const CHECKPOINT_SUMMARY_MAX = 2000;

/**
 * The walk for the room a merge checkpoint's summary leaves once everything else is in it, without
 * the space that joins it to the text before. Empty when there is no room, so the usual closing
 * sentence (the gesture of the merge) is never cut.
 */
export function walkSlot(walk: Walkthrough, bareSummary: string): string {
  return walkthroughText(walk, CHECKPOINT_SUMMARY_MAX - bareSummary.length - 1);
}

/**
 * The journeys of the UX specification (`## Key flows`): each `### name`, the requirements on its
 * `Covers:` line, and its numbered steps. Anything else in the text is ignored.
 */
export function uxFlows(text: string): UxFlow[] {
  const section = /^## Key flows\s*$/im.exec(text);
  if (section === null) return [];
  const body = text.slice(section.index + section[0].length);
  const next = /^#{1,2} (?!#)/m.exec(body);
  const flows: UxFlow[] = [];
  for (const block of (next === null ? body : body.slice(0, next.index)).split(/^### /m).slice(1)) {
    const [name = "", ...rest] = block.split("\n");
    const covers = rest.flatMap((line) => (/^\s*Covers:/i.test(line) ? idsIn(line) : []));
    const steps = rest
      .map((line) => /^\s*\d+\.\s+(.+)$/.exec(line)?.[1])
      .filter((step): step is string => step !== undefined);
    if (name.trim() !== "" && covers.length > 0 && steps.length > 0) {
      flows.push({ name: name.trim(), covers, steps });
    }
  }
  return flows;
}
