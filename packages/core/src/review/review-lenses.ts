import {
  type FindingLens,
  JUDGE_LENS,
  type JudgeReport,
  type LensFinding,
  type LensReport,
  REVIEW_LENSES,
  type ReviewFinding,
  type ReviewKind,
  type ReviewLens,
  type Ruling,
  type RulingStatus,
  type SecurityReason,
  type SilentPart,
  type TriageDecision,
} from "@agentplugged/protocol";
import type { DiffFile } from "./review-rules.js";

/**
 * The lenses of a review, pure. A change is read by independent lenses, each a short
 * skill run in its own context; the engine decides which lenses a change needs (`chooseLenses`),
 * refuses a report that is not whole (`validateLensReports`, `validateJudge`), merges what the
 * lenses found without ever losing a blocking finding (`mergeLensReports`), and builds the short
 * stack the creator reads (`creatorStack`). No agent decides any of it.
 */

/** A file of the change, as the diff counts it. */
export interface ChangeFile {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** The diff creates the file. */
  readonly created?: boolean;
}

/** A lens the engine chose, with why (stable codes: the agent says them in the creator's words). */
export interface LensChoice {
  readonly lens: ReviewLens;
  readonly why: readonly string[];
}

const DOCUMENT_EXTENSIONS = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
/** Files that steer an agent (skills, agents, rules): behaviour, so read as code. */
const INSTRUCTIONS =
  /(?:^|\/)(?:SKILL|AGENTS|CLAUDE|GEMINI)\.md$|(?:^|\/)(?:skills|agents|\.claude|\.cursor)\//i;
const SOURCE_EXTENSIONS =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|cs|cpp|c|h|scala|sh|ps1|sql|vue|svelte)$/i;
const TEST_PATH = /(?:\.(?:test|spec)\.|(?:^|\/)(?:tests?|__tests__)\/)/i;
const MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "pipfile",
  "pipfile.lock",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "requirements.txt",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "pubspec.yaml",
  "mix.exs",
]);
const MIGRATION = /(?:^|\/)(?:migrations?|db\/migrate)\/|\.sql$|(?:^|\/)schema\.prisma$/i;
/** Documents whose weight asks for the adversarial regard whatever their size. */
const WEIGHTY_DOCUMENT = /(?:^|[/._-])(?:prd|architecture|ux|security|threat)/i;

const lower = (path: string) => path.replaceAll("\\", "/");
const baseName = (path: string) => lower(path).split("/").at(-1)?.toLowerCase() ?? "";

/**
 * True for a file that is prose (a document), not code: never an instruction file, a dependency
 * manifest (`requirements.txt`) or a file of secrets, whatever its extension says.
 */
export function isDocumentPath(path: string): boolean {
  const p = lower(path);
  const name = baseName(p);
  if (INSTRUCTIONS.test(p) || MANIFESTS.has(name) || name.startsWith(".env")) return false;
  return DOCUMENT_EXTENSIONS.test(p);
}

export interface ChangeFacts {
  /** `document` when every changed file is prose. */
  readonly kind: "code" | "document";
  readonly lines: number;
  readonly documentLines: number;
  readonly files: number;
  readonly folders: number;
  readonly dependencies: boolean;
  readonly migrations: boolean;
  /** A new source file that is not a test. */
  readonly newSource: boolean;
  readonly weightyDocument: boolean;
}

/** The files of a parsed diff, as the lens choice reads them. */
export function changeFiles(files: readonly DiffFile[]): ChangeFile[] {
  return files.map((file) => ({
    path: file.path,
    added: file.added,
    removed: file.removed,
    created: file.old_path === null,
  }));
}

/** What the engine knows of a change before it chooses: its files, counted. */
export function changeFacts(files: readonly ChangeFile[]): ChangeFacts {
  const documents = files.filter((file) => isDocumentPath(file.path));
  const count = (list: readonly ChangeFile[]) =>
    list.reduce((sum, file) => sum + file.added + file.removed, 0);
  return {
    kind: files.length > 0 && documents.length === files.length ? "document" : "code",
    lines: count(files),
    documentLines: count(documents),
    files: files.length,
    folders: new Set(files.map((file) => lower(file.path).split("/").slice(0, -1).join("/"))).size,
    dependencies: files.some((file) => MANIFESTS.has(baseName(file.path))),
    migrations: files.some((file) => MIGRATION.test(lower(file.path))),
    newSource: files.some(
      (file) =>
        file.created === true && SOURCE_EXTENSIONS.test(file.path) && !TEST_PATH.test(file.path),
    ),
    weightyDocument: documents.some((file) => WEIGHTY_DOCUMENT.test(lower(file.path))),
  };
}

/** A code change of at least this many lines gets the cases nobody wrote down looked at. */
export const EDGE_CASES_LINES = 20;
/** A change of at least this many lines (or files) gets the adversarial regard. */
export const ADVERSARIAL_LINES = 150;
export const ADVERSARIAL_FILES = 8;
/** A change over this many files, or folders, gets the structure regard. */
export const STRUCTURE_FILES = 5;
export const STRUCTURE_FOLDERS = 3;
/** Prose in a code change is read for its words from this many lines. */
export const PROSE_LINES = 10;

/**
 * The lenses a change needs, with why: a small change without risk gets few, a
 * sensitive one (secrets, access, dependencies, migrations: `securityReasons` not empty) all of
 * them, the security lens included. `more` are the lenses the creator asked for besides.
 */
export function chooseLenses(
  files: readonly ChangeFile[],
  securityReasons: readonly SecurityReason[],
  more: readonly ReviewLens[] = [],
): LensChoice[] {
  const facts = changeFacts(files);
  const sensitive = securityReasons.length > 0 || facts.dependencies || facts.migrations;
  const risk: string[] = [
    ...securityReasons.map((reason) => `security_${reason}`),
    ...(facts.dependencies ? ["dependencies"] : []),
    ...(facts.migrations ? ["migrations"] : []),
  ];
  const chosen = new Map<ReviewLens, string[]>();
  const add = (lens: ReviewLens, ...why: string[]) => {
    if (why.length > 0) chosen.set(lens, [...(chosen.get(lens) ?? []), ...why]);
  };
  const when = (condition: boolean, code: string) => (condition ? [code] : []);

  add("relevance", "always");
  add("verification_gaps", "always");
  if (facts.kind === "document") {
    add("structure", "document");
    add("prose", "document");
    add("adversarial", ...when(facts.weightyDocument, "weighty_document"), ...risk);
    add("adversarial", ...when(facts.lines >= ADVERSARIAL_LINES, "size"));
  } else {
    add("edge_cases", ...when(facts.lines >= EDGE_CASES_LINES, "size"));
    add("edge_cases", ...when(facts.newSource, "new_code"), ...risk);
    add("adversarial", ...when(facts.lines >= ADVERSARIAL_LINES, "size"));
    add("adversarial", ...when(facts.files >= ADVERSARIAL_FILES, "files"), ...risk);
    add("structure", ...when(facts.files >= STRUCTURE_FILES, "files"));
    add("structure", ...when(facts.folders >= STRUCTURE_FOLDERS, "folders"), ...risk);
    add("prose", ...when(facts.documentLines >= PROSE_LINES, "documents"));
    add("prose", ...(sensitive && facts.documentLines > 0 ? ["sensitive"] : []));
  }
  add("security", ...securityReasons.map((reason) => `security_${reason}`));
  for (const lens of more) if (!chosen.has(lens)) add(lens, "requested");
  return REVIEW_LENSES.filter((lens) => chosen.has(lens)).map((lens) => ({
    lens,
    why: [...new Set(chosen.get(lens))],
  }));
}

/** A change of at least this many lines, or files, is big enough to be read lens by lens. */
export const BIG_LINES = 6000;
export const BIG_FILES = 100;

/**
 * True when a change is sensitive: a security reason, a dependency, a
 * migration, or a big change. A sensitive change is read by three readers (security alone, depth,
 * form) and the judge alone; the engine decides it, never the agent, and a lens is
 * never dropped for it.
 */
export function isSensitiveChange(
  files: readonly ChangeFile[],
  securityReasons: readonly SecurityReason[],
): boolean {
  const facts = changeFacts(files);
  return (
    securityReasons.length > 0 ||
    facts.dependencies ||
    facts.migrations ||
    facts.lines >= BIG_LINES ||
    facts.files >= BIG_FILES
  );
}

/** What a reader is called: a lens when it reads that one alone, else one of the groups. */
export type ReaderId = ReviewLens | "depth" | "form" | "whole" | typeof JUDGE_LENS;

/**
 * A reader: one sub-agent, one reading of its part of the diff, one
 * report per lens it carries. `judge` is true when it also does the judge's criterion-by-criterion
 * check (small change without risk only); a lone judge is a reader of its own with no lens.
 */
export interface Reader {
  readonly reader: ReaderId;
  readonly lenses: readonly ReviewLens[];
  readonly judge: boolean;
  /** The short passes this reader runs after its lenses, each read from its own file. */
  readonly passes?: readonly ReaderPass[];
}

/**
 * The short passes added to the reader of verification gaps, decided by the engine:
 * `removals` when the change takes code away (what did the removed code guarantee, and where does
 * that live now?), `assertions` when there is something the change says of itself to test (the
 * story's criteria, the commit messages, the intent), each tried against the code already walked.
 */
export const READER_PASSES = ["removals", "assertions"] as const;
export type ReaderPass = (typeof READER_PASSES)[number];

/** Lines removed from code (tests included, documents and lockfiles not) that call for the removals pass. */
export const REMOVAL_LINES = 5;

/** The passes a change calls for: removals when it takes code away, assertions when it has any. */
export function readerPasses(files: readonly ChangeFile[], assertions: boolean): ReaderPass[] {
  const removed = files
    .filter((file) => !isDocumentPath(file.path) && !isLockfile(file.path))
    .reduce((sum, file) => sum + file.removed, 0);
  return [
    ...(removed >= REMOVAL_LINES ? (["removals"] as const) : []),
    ...(assertions ? (["assertions"] as const) : []),
  ];
}

/** The lenses that look for what breaks, and the lenses that look at what the change is. */
const DEPTH_LENSES: readonly ReviewLens[] = ["adversarial", "edge_cases", "verification_gaps"];

/**
 * Who reads what. Every chosen lens is carried by exactly one reader, whatever the
 * grouping; the judge is carried by exactly one reader.
 *
 * - small change without risk (no adversarial nor structure lens, not sensitive): a single reader
 *   carries every lens and the judge's check, no sub-agent more;
 * - otherwise (sensitive included): `security` alone on the whole diff, `depth`
 *   (adversarial, edge cases, verification gaps) and `form` (structure, relevance, prose), then
 *   the judge alone in a fresh context. A reader without a lens does not exist.
 *
 * The security lens always has a reader of its own. A review of kind `security` has one reader.
 */
export function planReaders(
  kind: ReviewKind,
  chosen: readonly LensChoice[],
  sensitive: boolean,
  passes: readonly ReaderPass[] = [],
): Reader[] {
  // The passes go to the one reader that carries the verification gaps (a lens of every quality review).
  const planned = planFor(kind, chosen, sensitive);
  if (passes.length === 0) return planned;
  const carrier = planned.findIndex((reader) => reader.lenses.includes("verification_gaps"));
  return planned.map((reader, index) => (index === carrier ? { ...reader, passes } : reader));
}

function planFor(kind: ReviewKind, chosen: readonly LensChoice[], sensitive: boolean): Reader[] {
  const lenses = chosen.map((choice) => choice.lens);
  if (kind === "security") {
    return lenses.length === 0 ? [] : [{ reader: "security", lenses: ["security"], judge: false }];
  }
  const security = lenses.filter((lens) => lens === "security");
  const others = lenses.filter((lens) => lens !== "security");
  const alone = (lens: ReviewLens): Reader => ({ reader: lens, lenses: [lens], judge: false });
  const judge: Reader = { reader: JUDGE_LENS, lenses: [], judge: true };
  const small = !sensitive && !others.includes("adversarial") && !others.includes("structure");
  const readers: Reader[] = security.map(alone);
  if (small) {
    return [...readers, { reader: "whole", lenses: others, judge: true }];
  }
  const depth = others.filter((lens) => DEPTH_LENSES.includes(lens));
  const form = others.filter((lens) => !DEPTH_LENSES.includes(lens));
  if (depth.length > 0) readers.push({ reader: "depth", lenses: depth, judge: false });
  if (form.length > 0) readers.push({ reader: "form", lenses: form, judge: false });
  return [...readers, judge];
}

/**
 * The lenses a review of `kind` must report: the chosen ones, the security lens being the
 * security reviewer's. With no security reviewer to give it (`securityByQa`), the quality
 * review carries the security lens itself, so that a sensitive change is never read without it.
 */
export function requiredLenses(
  kind: ReviewKind,
  chosen: readonly LensChoice[],
  securityByQa = false,
): ReviewLens[] {
  return kind === "security"
    ? ["security"]
    : chosen.map((choice) => choice.lens).filter((lens) => lens !== "security" || securityByQa);
}

/** True when a report of lens `lens` may come with a review of `kind`. */
function allowedLens(kind: ReviewKind, lens: ReviewLens, securityByQa: boolean): boolean {
  return kind === "security" ? lens === "security" : lens !== "security" || securityByQa;
}

/** A proof shorter than this is not one (« ok »): the engine asks for it again. */
export const MIN_EVIDENCE = 10;

/**
 * What is wrong with the reports of a review, as short codes the agent can fix:
 * a missing, repeated or foreign lens; a section a report must hold and does not; a criterion
 * that does not exist. Empty when the reports are whole.
 */
export function validateLensReports(
  reports: readonly LensReport[],
  context: {
    kind: ReviewKind;
    required: readonly ReviewLens[];
    criteria: number;
    /** No security reviewer is active: the quality review carries the security lens. */
    securityByQa?: boolean;
    /** The lenses (or the judge) declared silent: they owe no report. */
    silent?: readonly SilentPart[];
  },
): string[] {
  const problems: string[] = [];
  const seen = new Set<ReviewLens>();
  const silent = new Set<SilentPart>(context.silent ?? []);
  for (const report of reports) {
    if (seen.has(report.lens)) problems.push(`lens_repeated:${report.lens}`);
    seen.add(report.lens);
    if (!allowedLens(context.kind, report.lens, context.securityByQa === true)) {
      problems.push(`lens_not_allowed:${report.lens}`);
    }
    if (report.covered === undefined || report.covered.length === 0) {
      problems.push(`covered_missing:${report.lens}`);
    }
    report.findings.forEach((finding, index) => {
      const where = `${report.lens}#${index + 1}`;
      if (finding.evidence === undefined || finding.evidence.length < MIN_EVIDENCE) {
        problems.push(`evidence_missing:${where}`);
      }
      if (finding.criterion === undefined) problems.push(`criterion_missing:${where}`);
      else if (finding.criterion !== null && finding.criterion > context.criteria) {
        problems.push(`criterion_unknown:${where}:${finding.criterion}`);
      }
      if (finding.severity !== "minor" && finding.recommendation === undefined) {
        problems.push(`recommendation_missing:${where}`);
      }
      if (finding.line !== undefined && finding.path === undefined) {
        problems.push(`line_without_path:${where}`);
      }
    });
  }
  for (const lens of context.required) {
    if (silent.has(lens) && seen.has(lens)) problems.push(`silent_but_reported:${lens}`);
    else if (!seen.has(lens) && !silent.has(lens)) problems.push(`lens_missing:${lens}`);
  }
  for (const part of silent) {
    if (part !== JUDGE_LENS && !context.required.includes(part)) {
      problems.push(`silent_not_asked:${part}`);
    }
  }
  // A review where nobody spoke is not a review: it is reported partial, not submitted.
  const spoke = context.required.some((lens) => !silent.has(lens));
  if (context.required.length > 0 && !spoke) problems.push("nothing_reported");
  return problems;
}

/** The name of each finding of the reports, as the judge rules on it (`edge_cases#2`). */
export function findingRefs(reports: readonly LensReport[]): string[] {
  return reports.flatMap((report) =>
    report.findings.map((_, index) => `${report.lens}#${index + 1}`),
  );
}

/**
 * What is wrong with the judge's report: every criterion of the story judged once, with its
 * evidence, and what to do when it is not met. The judge never sees the lenses: nothing here
 * refers to them.
 */
/** A place in the code: a file with its extension, then possibly a line (`src/a.ts:12`). */
const PLACE = /[\w@+-][\w.@+/-]*\.[A-Za-z0-9]{1,10}(?::\d+)?/;
const PLACE_WITH_LINE = /[\w@+-][\w.@+/-]*\.[A-Za-z0-9]{1,10}:\d+/;
/** What a judge must write to set aside or lower a finding a reader called blocking. */
export const MIN_SETTING_ASIDE = 40;

/** The severity each finding of the reports was given by its reader, by its name (`edge_cases#2`). */
export function findingSeverities(
  reports: readonly LensReport[],
): Readonly<Record<string, ReviewFinding["severity"]>> {
  return Object.fromEntries(
    reports.flatMap((report) =>
      report.findings.map((entry, index) => [`${report.lens}#${index + 1}`, entry.severity]),
    ),
  );
}

export function validateJudge(
  judge: JudgeReport | undefined,
  criteria: number,
  /** The findings of the lenses (`findingRefs`), each of which the judge rules once. */
  refs: readonly string[] = [],
  /** What their readers called them (`findingSeverities`): a blocking one is not set aside lightly. */
  severities: Readonly<Record<string, ReviewFinding["severity"]>> = {},
): string[] {
  if (judge === undefined) return ["judge_missing"];
  const problems: string[] = [];
  const ruled = new Set<string>();
  for (const ruling of judge.findings ?? []) {
    const where = ruling.finding;
    if (!refs.includes(where)) problems.push(`judge_finding_unknown:${where}`);
    else if (ruled.has(where)) problems.push(`judge_finding_repeated:${where}`);
    ruled.add(where);
    const written = ruling.evidence?.length ?? 0;
    const blocking = severities[where] === "blocking";
    // Setting aside or lowering what a reader called blocking asks for more than a word.
    const lowers =
      blocking &&
      (ruling.status === "refuted" ||
        (ruling.status === "confirmed" && ruling.severity !== "blocking"));
    if (written < MIN_EVIDENCE || (lowers && written < MIN_SETTING_ASIDE)) {
      problems.push(`judge_finding_evidence_missing:${where}`);
    }
    if (ruling.status === "confirmed" && ruling.severity === undefined) {
      problems.push(`judge_finding_severity_missing:${where}`);
    }
    // A refutation names the place that shows it: a file, and for a blocking finding, a line.
    if (
      ruling.status === "refuted" &&
      (ruling.at === undefined || !(blocking ? PLACE_WITH_LINE : PLACE).test(ruling.at))
    ) {
      problems.push(`judge_finding_proof_missing:${where}`);
    }
  }
  for (const ref of refs) if (!ruled.has(ref)) problems.push(`judge_finding_missing:${ref}`);
  const seen = new Set<number>();
  for (const entry of judge.criteria) {
    if (entry.criterion > criteria) problems.push(`judge_criterion_unknown:${entry.criterion}`);
    else if (seen.has(entry.criterion))
      problems.push(`judge_criterion_repeated:${entry.criterion}`);
    seen.add(entry.criterion);
    if (entry.evidence === undefined || entry.evidence.length < MIN_EVIDENCE) {
      problems.push(`judge_evidence_missing:${entry.criterion}`);
    }
    if (entry.status !== "met" && entry.recommendation === undefined) {
      problems.push(`judge_recommendation_missing:${entry.criterion}`);
    }
  }
  for (let n = 1; n <= criteria; n += 1) {
    if (!seen.has(n)) problems.push(`judge_criterion_missing:${n}`);
  }
  if (judge.gap === undefined) problems.push("judge_gap_missing");
  return problems;
}

const RANK = { blocking: 0, should_fix: 1, minor: 2 } as const;

/** The judge's report as findings: a criterion not met blocks, one partly met is to fix. */
export function judgeFindings(judge: JudgeReport): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const entry of judge.criteria) {
    if (entry.status === "met") continue;
    findings.push({
      severity: entry.status === "unmet" ? "blocking" : "should_fix",
      title: `Criterion ${entry.criterion} is ${entry.status === "unmet" ? "not met" : "only partly met"}`,
      ...(entry.evidence === undefined ? {} : { detail: entry.evidence }),
      lens: JUDGE_LENS,
      ...(entry.cause === undefined ? {} : { cause: entry.cause }),
      criterion: entry.criterion,
      ...(entry.recommendation === undefined ? {} : { recommendation: entry.recommendation }),
    });
  }
  if (judge.gap !== undefined && judge.gap !== null) {
    findings.push({
      severity: "should_fix",
      title: "Gap between the story's intent and what was delivered",
      detail: judge.gap,
      lens: JUDGE_LENS,
    });
  }
  return findings;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "not",
  "with",
  "that",
  "this",
  "from",
  "are",
  "les",
  "des",
  "pas",
  "une",
  "est",
  "dans",
  "pour",
  "sans",
  "que",
  "qui",
  "sur",
]);

function words(title: string): Set<string> {
  return new Set(
    title
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  );
}

function similarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Lines apart for two findings of one file to be about the same place. */
export const SAME_PLACE_LINES = 3;
/** Words two titles share, over the words they hold, for the same thing said twice. */
export const SAME_WORDS = 0.4;
export const SAME_WORDS_UNLOCATED = 0.6;
/** With the same line, or the same criterion, fewer words are enough: never none. */
export const SAME_WORDS_SAME_LINE = 0.2;
export const SAME_WORDS_SAME_CRITERION = 0.25;

/**
 * True when two findings are the same finding seen by two lenses. Two defects of one file are
 * never one for being near or for threatening one criterion: their titles must say the same
 * thing too, and two blocking findings need the strictest likeness of all. Unlocated findings
 * (no path) are merged on their words alone, with the strictest likeness.
 */
export function sameFinding(a: ReviewFinding, b: ReviewFinding): boolean {
  const words = similarity(a.title, b.title);
  if (a.path === undefined || b.path === undefined) {
    return a.path === b.path && words >= SAME_WORDS_UNLOCATED;
  }
  if (a.path !== b.path) return false;
  const near =
    a.line === undefined || b.line === undefined || Math.abs(a.line - b.line) <= SAME_PLACE_LINES;
  if (!near) return false;
  if (words >= SAME_WORDS) return true;
  // Two blocking findings are two until their titles say the same thing.
  if (a.severity === "blocking" && b.severity === "blocking") return false;
  const sameLine = a.line !== undefined && a.line === b.line;
  const sameCriterion = a.criterion !== undefined && a.criterion === b.criterion;
  return (
    (sameLine && words >= SAME_WORDS_SAME_LINE) ||
    (sameCriterion &&
      a.line !== undefined &&
      b.line !== undefined &&
      words >= SAME_WORDS_SAME_CRITERION)
  );
}

const DETAIL_MAX = 2000;

/** One group of findings that are one finding: the strictest leads, nothing of the others is lost. */
function fuse(group: readonly ReviewFinding[]): ReviewFinding {
  const lead = group.reduce((best, finding) =>
    RANK[finding.severity] < RANK[best.severity] ? finding : best,
  );
  const others = group.filter((finding) => finding !== lead);
  const also = [
    ...new Set(
      [...others.map((finding) => finding.lens), ...others.flatMap((finding) => finding.also ?? [])]
        .filter((lens): lens is FindingLens => lens !== undefined)
        .filter((lens) => lens !== lead.lens),
    ),
  ];
  // What the others said is kept: their title, criterion, advice and proof, cut to stay short.
  const extra = others
    .filter((finding) => finding.title !== lead.title || finding.detail !== lead.detail)
    .map((finding) =>
      [
        `${finding.lens ?? "?"}: ${finding.title}`,
        finding.criterion === undefined ? "" : ` [criterion ${finding.criterion}]`,
        finding.recommendation === undefined ? "" : ` -> ${finding.recommendation}`,
        finding.detail === undefined ? "" : ` (${finding.detail.slice(0, 300)})`,
      ].join(""),
    );
  const detail = [lead.detail, ...(extra.length > 0 ? [`Also: ${extra.join(" | ")}`] : [])]
    .filter((part): part is string => part !== undefined)
    .join("\n")
    .slice(0, DETAIL_MAX);
  const criterion =
    lead.criterion ?? group.find((finding) => finding.criterion !== undefined)?.criterion;
  const recommendation =
    lead.recommendation ??
    group.find((finding) => finding.recommendation !== undefined)?.recommendation;
  // Said unverified only when every member is a lens finding the judge could not settle: a member
  // that is the judge's own, or proved by the engine, makes it a finding that stands.
  const ruling = group.some((finding) => finding.ruling === undefined)
    ? undefined
    : group.some((finding) => finding.ruling === "confirmed")
      ? "confirmed"
      : "undecided";
  const cause = group.find((finding) => finding.cause !== undefined)?.cause;
  return {
    severity: lead.severity,
    title: lead.title,
    ...(detail === "" ? {} : { detail }),
    ...(lead.path === undefined ? {} : { path: lead.path }),
    ...(lead.line === undefined ? {} : { line: lead.line }),
    ...(lead.lens === undefined ? {} : { lens: lead.lens }),
    ...(criterion === undefined ? {} : { criterion }),
    ...(recommendation === undefined ? {} : { recommendation }),
    ...(also.length === 0 ? {} : { also }),
    ...(ruling === undefined ? {} : { ruling }),
    ...(cause === undefined ? {} : { cause }),
  };
}

/** Findings of one review, at most (`MAX_REVIEW_FINDINGS`): the least severe go first when over. */
const KEEP = 100;

/** The result of merging the lenses' reports. */
export interface MergedReview {
  readonly findings: ReviewFinding[];
  /** Findings the lenses and the judge gave in all. */
  readonly raw: number;
  /** Findings merged into another (the same finding seen twice). */
  readonly merged: number;
  readonly lenses: readonly { lens: ReviewLens; findings: number }[];
  readonly judge?: { met: number; partly: number; unmet: number };
  /** How the judge ruled on the lenses' findings, and the refuted ones (counted, never shown). */
  readonly ruled?: { confirmed: number; refuted: number; undecided: number };
  readonly refuted: readonly RefutedFinding[];
}

/** A finding the judge refuted with its proof: kept for the audit, shown to nobody. */
export interface RefutedFinding {
  readonly lens: ReviewLens;
  readonly severity: ReviewFinding["severity"];
  readonly title: string;
  readonly at?: string;
}

/**
 * What the judge's ruling does to a finding of a lens: refuted, it is gone (counted);
 * confirmed, it takes the severity the judge gives, the reader's own set aside; undecided, it stays
 * but never blocks (a blocking finding nobody could settle is one to fix, said unverified). The
 * security lens is the exception: a judge never sets its findings aside nor lowers them (a false
 * alarm costs a look, a miss costs more), so a refutation leaves the finding standing, unverified.
 */
function ruledFinding(
  lens: ReviewLens,
  finding: LensFinding,
  ruling: Ruling | undefined,
):
  | { severity: ReviewFinding["severity"]; ruling?: "confirmed" | "undecided"; as: RulingStatus }
  | undefined {
  if (ruling === undefined) return { severity: finding.severity, as: "confirmed" };
  if (lens === "security") {
    if (ruling.status === "confirmed") {
      const severity =
        RANK[ruling.severity ?? finding.severity] < RANK[finding.severity]
          ? (ruling.severity ?? finding.severity)
          : finding.severity;
      return { severity, ruling: "confirmed", as: "confirmed" };
    }
    return { severity: finding.severity, ruling: "undecided", as: "undecided" };
  }
  if (ruling.status === "refuted") return undefined;
  if (ruling.status === "confirmed") {
    return {
      severity: ruling.severity ?? finding.severity,
      ruling: "confirmed",
      as: "confirmed",
    };
  }
  return {
    severity: finding.severity === "blocking" ? "should_fix" : finding.severity,
    ruling: "undecided",
    as: "undecided",
  };
}

/**
 * Merges what the lenses and the judge found: the same finding seen by several
 * lenses is one, kept at the strictest severity with every lens that saw it; each finding is
 * linked to the criterion it threatens; blocking first. A blocking finding is never merged
 * away nor dropped by the merge: the verdict of the merged review is the verdict of the
 * strictest report. Reports are read in the lenses' fixed order, so the same reports always
 * merge the same way. `engine` are the findings the engine itself proved (the
 * duplicates): they join the others, and no reviewer can leave them out.
 */
export function mergeLensReports(
  reports: readonly LensReport[],
  judge?: JudgeReport,
  engine: readonly ReviewFinding[] = [],
): MergedReview {
  const ordered = REVIEW_LENSES.flatMap((lens) => reports.filter((report) => report.lens === lens));
  const rulings = new Map((judge?.findings ?? []).map((ruling) => [ruling.finding, ruling]));
  const refuted: RefutedFinding[] = [];
  const ruled = { confirmed: 0, refuted: 0, undecided: 0 };
  const raw: ReviewFinding[] = [
    ...engine,
    ...ordered.flatMap((report) =>
      report.findings.flatMap((finding, index): ReviewFinding[] => {
        const ruling = rulings.get(`${report.lens}#${index + 1}`);
        const kept = ruledFinding(report.lens, finding, ruling);
        if (ruling !== undefined) ruled[kept?.as ?? "refuted"] += 1;
        if (kept === undefined) {
          refuted.push({
            lens: report.lens,
            severity: finding.severity,
            title: finding.title,
            ...(ruling?.at === undefined ? {} : { at: ruling.at }),
          });
          return [];
        }
        return [
          {
            severity: kept.severity,
            title: finding.title,
            ...(finding.evidence === undefined ? {} : { detail: finding.evidence }),
            ...(finding.path === undefined ? {} : { path: finding.path }),
            ...(finding.line === undefined ? {} : { line: finding.line }),
            lens: report.lens,
            ...(finding.criterion === undefined || finding.criterion === null
              ? {}
              : { criterion: finding.criterion }),
            ...(finding.recommendation === undefined
              ? {}
              : { recommendation: finding.recommendation }),
            ...(kept.ruling === undefined ? {} : { ruling: kept.ruling }),
            ...(ruling?.cause === undefined ? {} : { cause: ruling.cause }),
          },
        ];
      }),
    ),
    ...(judge === undefined ? [] : judgeFindings(judge)),
  ];
  const groups: ReviewFinding[][] = [];
  for (const finding of raw) {
    const group = groups.find((members) => members.some((member) => sameFinding(member, finding)));
    if (group === undefined) groups.push([finding]);
    else group.push(finding);
  }
  const fused = groups
    .map(fuse)
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => RANK[a.finding.severity] - RANK[b.finding.severity] || a.index - b.index)
    .map(({ finding }) => finding)
    .slice(0, KEEP);
  return {
    findings: fused,
    raw: raw.length,
    merged: raw.length - groups.length,
    lenses: ordered.map((report) => ({ lens: report.lens, findings: report.findings.length })),
    refuted,
    ...(rulings.size === 0 ? {} : { ruled }),
    ...(judge === undefined
      ? {}
      : {
          judge: {
            met: judge.criteria.filter((entry) => entry.status === "met").length,
            partly: judge.criteria.filter((entry) => entry.status === "partly").length,
            unmet: judge.criteria.filter((entry) => entry.status === "unmet").length,
          },
        }),
  };
}

/** A finding as the creator's stack reads it. */
export interface StackEntry {
  readonly severity: ReviewFinding["severity"];
  readonly title: string;
  readonly path?: string | undefined;
  readonly line?: number | undefined;
  readonly criterion?: number | undefined;
  readonly lens?: FindingLens | undefined;
  readonly recommendation?: string | undefined;
  /** The judge could not settle it (`undecided`), or found its cause in the story. */
  readonly ruling?: "confirmed" | "undecided" | undefined;
  readonly cause?: "story" | undefined;
  /** How the developer sorted it, when they did. */
  readonly decision: TriageDecision | null;
}

/** Entries shown to the creator at most (the blocking ones always are). */
export const STACK_SHOWN = 7;

export interface CreatorStack {
  /** Findings fixed before the creator is shown anything: counted, never listed. */
  readonly fixed: number;
  /** Blocking first, then to fix, then minor; one line each. */
  readonly lines: readonly string[];
  /** Findings left out of the lines (minor ones past the limit, or no room for): counted. */
  readonly hidden: number;
  /** Among them, the blocking ones (only when the lines cannot hold them all). */
  readonly hiddenBlocking: number;
  /** The lenses (or the judge) that gave no report: the review is possibly incomplete. */
  readonly incomplete: readonly SilentPart[];
  /** Open findings whose cause is the story itself (amend it, never patch the code). */
  readonly story: number;
  /** The findings the judge refuted with proof, and how many of them a reader called blocking. */
  readonly refuted: number;
  readonly refutedBlocking: number;
}

const LINE_MAX = 180;
const LINE_MIN = 60;
const ADVICE_MAX = 70;
const PATH_MAX = 50;
/** The text of the stack, at most: the checkpoint it goes in is cut at 2 000 characters. */
export const STACK_CHARS = 1000;
const SEPARATOR = " ; ";

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * One line of the stack: severity, place, criterion, the finding and what the agent advises. It
 * is the title that gives way when the line is long, never the advice.
 */
export function stackLine(entry: StackEntry, max: number = LINE_MAX): string {
  // The room shrinks the path and the advice before the title: a line never exceeds `max`.
  const pathMax = Math.min(PATH_MAX, Math.max(12, Math.floor(max / 3)));
  const adviceMax = Math.min(ADVICE_MAX, Math.max(12, Math.floor(max / 3)));
  const path =
    entry.path === undefined
      ? ""
      : entry.path.length > pathMax
        ? `…${entry.path.slice(-(pathMax - 1))}`
        : entry.path;
  const place = path === "" ? "" : ` ${path}${entry.line === undefined ? "" : `:${entry.line}`}`;
  const criterion = entry.criterion === undefined ? "" : ` [criterion ${entry.criterion}]`;
  const flags = [
    ...(entry.ruling === "undecided" ? ["unverified"] : []),
    ...(entry.cause === "story" ? ["story"] : []),
  ];
  const head = `${entry.severity}${flags.length === 0 ? "" : ` (${flags.join(", ")})`}${place}${criterion}: `;
  const advice =
    entry.recommendation === undefined ? "" : ` -> ${cut(entry.recommendation, adviceMax)}`;
  const line = `${head}${cut(entry.title, Math.max(8, max - head.length - advice.length))}${advice}`;
  return cut(line, max);
}

/**
 * The stack the creator reads: short, blocking findings first, each in one line with
 * the agent's advice; the findings the developer fixed are counted, not shown. The lines fit in
 * `STACK_CHARS`: each blocking finding has its line, shortened when they are many; past what the
 * room holds, the findings left out are counted, the blocking ones apart, never dropped silently.
 */
export function creatorStack(
  entries: readonly StackEntry[],
  shown: number = STACK_SHOWN,
  silent: readonly SilentPart[] = [],
  refuted: { readonly total: number; readonly blocking: number } = { total: 0, blocking: 0 },
): CreatorStack {
  const fixed = entries.filter((entry) => entry.decision === "fix").length;
  const open = entries
    .filter((entry) => entry.decision !== "fix")
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => RANK[a.entry.severity] - RANK[b.entry.severity] || a.index - b.index)
    .map(({ entry }) => entry);
  const blocking = open.filter((entry) => entry.severity === "blocking").length;
  const room = Math.floor(STACK_CHARS / (LINE_MIN + SEPARATOR.length));
  const count = Math.min(room, Math.max(shown, blocking), open.length);
  const max = Math.min(
    LINE_MAX,
    Math.max(LINE_MIN, Math.floor(STACK_CHARS / Math.max(1, count)) - SEPARATOR.length),
  );
  const kept = open.slice(0, count);
  const left = open.slice(count);
  return {
    fixed,
    lines: kept.map((entry) => stackLine(entry, max)),
    hidden: left.length,
    hiddenBlocking: left.filter((entry) => entry.severity === "blocking").length,
    incomplete: silent,
    story: open.filter((entry) => entry.cause === "story").length,
    refuted: refuted.total,
    refutedBlocking: refuted.blocking,
  };
}

/** What the creator reads of the review in the merge checkpoint: the fixed ones counted, the rest in lines. */
export function stackText(stack: CreatorStack | undefined): string {
  if (
    stack === undefined ||
    (stack.fixed === 0 &&
      stack.lines.length === 0 &&
      stack.incomplete.length === 0 &&
      stack.refuted === 0)
  ) {
    return "";
  }
  const fixed =
    stack.fixed === 0 ? "" : ` ${stack.fixed} finding(s) were fixed before you saw them.`;
  const more =
    stack.hidden === 0
      ? ""
      : ` (+${stack.hidden} more not shown${stack.hiddenBlocking === 0 ? "" : `, ${stack.hiddenBlocking} of them blocking`})`;
  const open =
    stack.lines.length === 0
      ? ""
      : ` Left open, blocking first: ${stack.lines.join(SEPARATOR)}${more}.`;
  // An empty stack is not a clean review when a lens said nothing: the creator is told.
  const incomplete =
    stack.incomplete.length === 0
      ? ""
      : ` Review possibly incomplete: no report from ${stack.incomplete.join(", ")}.`;
  const story =
    stack.story === 0
      ? ""
      : ` ${stack.story} finding(s) come from the story itself: amend the story, do not patch the code around it.`;
  // What the judge set aside is counted, never listed; a blocking finding set aside is said.
  const refuted =
    stack.refuted === 0
      ? ""
      : ` The judge refuted ${stack.refuted} finding(s) with proof${stack.refutedBlocking === 0 ? "" : ` (${stack.refutedBlocking} called blocking by a reader)`}.`;
  return `${fixed}${open}${refuted}${story}${incomplete}`;
}

const DIFF_HEADER = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/m;

const LOCKFILE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|pipfile\.lock|cargo\.lock|gemfile\.lock|composer\.lock|go\.sum|pubspec\.lock|mix\.lock|podfile\.lock|packages\.lock\.json)$/i;

/** What a changed file is, for the part of the diff each lens reads. */
type FileClass = "lock" | "document" | "test" | "code";

function classOf(path: string): FileClass {
  const p = lower(path);
  if (LOCKFILE.test(p)) return "lock";
  if (isDocumentPath(p)) return "document";
  return TEST_PATH.test(p) ? "test" : "code";
}

/** True for a lockfile: generated, never read line by line. */
export function isLockfile(path: string): boolean {
  return LOCKFILE.test(lower(path));
}

/** The classes of file each lens reads: never more than it needs. */
const LENS_READS: Readonly<Record<ReviewLens | "judge", readonly FileClass[]>> = {
  adversarial: ["code"],
  // The proof of a case is the verification lens's work: this one reads the code alone.
  edge_cases: ["code"],
  verification_gaps: ["code", "test"],
  structure: ["code"],
  prose: ["document"],
  relevance: ["code", "document"],
  // The security reviewer reads everything, lockfiles included.
  security: ["code", "test", "document", "lock"],
  // The judge looks at behaviour, its proof and what the story asked in writing.
  judge: ["code", "test", "document"],
};

/**
 * The part of a diff a lens reads: its own kind of file, a lockfile
 * reduced to a line, and for a change made only of documents the documents themselves. The
 * lenses of one review thus read less than the whole diff each; nothing outside the diff.
 */
export function lensDiff(
  diff: string,
  reader: ReviewLens | typeof JUDGE_LENS | readonly (ReviewLens | typeof JUDGE_LENS)[],
): string {
  const parts = typeof reader === "string" ? [reader] : reader;
  const chunks = diff.split(/^(?=diff --git )/m);
  // A reader of several lenses reads the union of what each reads, once.
  const reads = new Set(parts.flatMap((part) => LENS_READS[part]));
  const everything = parts.includes("security");
  const paths = chunks.flatMap((chunk) => {
    const header = DIFF_HEADER.exec(chunk);
    return header === null ? [] : [header[2] as string];
  });
  const documentsOnly = paths.length > 0 && paths.every(isDocumentPath);
  const kept: string[] = [];
  for (const chunk of chunks) {
    const header = DIFF_HEADER.exec(chunk);
    if (header === null) continue;
    const path = header[2] as string;
    // A renamed file is read as code when either of its names is: a `.env` renamed `.md` stays one.
    const kind = [classOf(header[1] as string), classOf(path)].includes("code")
      ? "code"
      : classOf(path);
    if (!everything && /^(?:Binary files .* differ|GIT binary patch)$/m.test(chunk)) {
      kept.push(`diff --git a/${path} b/${path}\n# binary file, not shown\n`);
    } else if (kind === "lock" && !everything) {
      const lines = chunk.split("\n");
      const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
      const removed = lines.filter(
        (line) => line.startsWith("-") && !line.startsWith("---"),
      ).length;
      kept.push(`diff --git a/${path} b/${path}\n# lockfile, not shown: +${added} -${removed}\n`);
    } else if (reads.has(kind) || (documentsOnly && kind === "document")) {
      kept.push(chunk.endsWith("\n") ? chunk : `${chunk}\n`);
    }
  }
  return kept.length > 0 ? kept.join("") : "# nothing of this diff is for this lens\n";
}

/** Where the part of the diff a lens (or the judge) reads is written: next to the whole diff. */
export function lensDiffPathOf(diffPath: string, reader: ReaderId): string {
  return diffPath.replace(/\.diff$/, `.${reader}.diff`);
}
