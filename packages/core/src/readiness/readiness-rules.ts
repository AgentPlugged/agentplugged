import { gitBlobId, utf8 } from "@agentplugged/crypto";
import {
  ErrorCode,
  type FindingSeverity,
  MAX_READINESS_FINDINGS,
  MAX_READINESS_LISTED,
  MAX_SHORT_FINDINGS,
  type ReadinessVerdict,
  type ReadyInput,
} from "@agentplugged/protocol";
import { passageFound, refsOf } from "../critique/critique-rules.js";
import type { DocsProblem } from "../docs/docs-base.js";
import { blobIdsOf, pathKey, validatedVersions } from "../docs/knowledge-freshness.js";
import type { ParsedDocument } from "../docs/parse-document.js";
import { storiesOf } from "../docs/story-rules.js";
import { METHOD_DIR } from "../init/layout.js";
import {
  documentProblemIsWarning,
  isSkipped,
  skippedWithItsPhase,
} from "../journey/journey-rules.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import {
  type Acceptance,
  isJudgedKey,
  judgedKey,
  type ReadinessReport,
  type ReadinessState,
  readinessOf,
} from "./readiness-record.js";

/**
 * The readiness gate, as pure rules. The engine computes what the plan as a whole
 * lets it compute (`analyse`), decides what a whole judged report is (`validateReadyReport`) and
 * which gestures it accepts (`validateSettle`), and gives the verdict from both (`gateOf`). The
 * agent judges the rest: documents that contradict each other, decisions nothing records. Nothing
 * here knows a language, a tool or a model.
 */

const DOCS = `${METHOD_DIR}/docs/`;
const EPICS = `${METHOD_DIR}/epics/`;
const STORIES = `${METHOD_DIR}/stories/`;

/** The structuring documents the gate reads, by kind. */
const STRUCTURING = ["prd", "ux", "architecture", "spec"] as const;
/** Documents of intent read with them (they are in the digest, never required nor validated). */
const INTENT = ["brief", "prfaq"] as const;

export type Stage = "breakdown" | "build";
export type Track = "full" | "short";

/** What `prepare` reads of the working copy: the planning documents and what `docs check` finds. */
export interface ReadyCopy {
  /** The planning documents (structuring, intent, epics, stories), parsed. */
  readonly documents: readonly ParsedDocument[];
  readonly texts: ReadonlyMap<string, string>;
  /** The problems `docs check` finds in them (rules of the documents alone, no base). */
  readonly problems: readonly DocsProblem[];
  /** The profile has a UX domain. */
  readonly needsUx: boolean;
}

/** A finding of the engine, or a judged one, as listed. */
export interface Listed {
  readonly key: string;
  readonly severity: FindingSeverity;
  readonly origin: "engine" | "agent";
  /** One line, in the engine's language (the agent says it to the creator in theirs). */
  readonly text: string;
  /** The agent that corrects the document, or `creator`. */
  readonly owner: string;
  /** What to do, short. */
  readonly fix: string;
}

export interface Inventory {
  readonly track: Track;
  readonly stage: Stage;
  /** The structuring and intent documents present, by path. */
  readonly documents: readonly string[];
  readonly epics: number;
  readonly stories: number;
  /** Active identifiers defined by the requirements and decisions documents, by prefix. */
  readonly ids: Readonly<Record<string, number>>;
}

export interface Analysis {
  readonly inventory: Inventory;
  /** The digest of the documents the gate reads. */
  readonly mark: string;
  /** The findings of the engine, the graver first. */
  readonly findings: readonly Listed[];
}

const RANK: Record<FindingSeverity, number> = { blocking: 0, should_fix: 1, minor: 2 };
const bySeverity = (a: Listed, b: Listed) =>
  RANK[a.severity] - RANK[b.severity] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const kindOf = (document: ParsedDocument) => document.kind?.value;
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** True for a planning document: what the gate reads. */
export function isPlanningPath(path: string): boolean {
  if (path.startsWith(EPICS) || path.startsWith(STORIES)) return path.toLowerCase().endsWith(".md");
  if (!path.startsWith(DOCS)) return false;
  const rest = path.slice(DOCS.length);
  return (
    !rest.includes("/") &&
    [...STRUCTURING, ...INTENT].some((name) => rest.toLowerCase() === `${name}.md`)
  );
}

function ownerOf(document: ParsedDocument | undefined, fallback: string): string {
  return document?.owner?.value ?? fallback;
}

/** The track: the short path when a spec stands for the documents and the creator took it. */
function trackOf(copy: ReadyCopy, state: Readonly<Record<string, unknown>>): Track {
  const hasSpec = copy.documents.some((d) => kindOf(d) === "spec" && d.path === `${DOCS}spec.md`);
  return hasSpec && isSkipped(state, "full_path") ? "short" : "full";
}

/** The digest of the documents read: their paths and their versions (line endings ignored). */
export function markOf(copy: ReadyCopy): string {
  const lines = copy.documents
    .map(
      (d) =>
        `${d.path}\t${gitBlobId(utf8((copy.texts.get(d.path) ?? "").replaceAll("\r\n", "\n")), "sha1")}`,
    )
    .sort();
  return gitBlobId(utf8(lines.join("\n")), "sha1");
}

function short(text: string, max = 140): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const SHORT_PATH = (path: string) => path.replace(`${METHOD_DIR}/`, "");

const STRUCTURAL: ReadonlySet<string> = new Set([
  ErrorCode.DOC_LINK_DANGLING,
  ErrorCode.REQ_ID_DUPLICATE,
  ErrorCode.DOC_ID_DUPLICATE,
  ErrorCode.STORY_DEPENDENCY_FORWARD,
  ErrorCode.STORY_DEPENDENCY_CYCLE,
]);

/** What the engine computes of the plan as a whole. Pure; the state gives validations and skips. */
export function analyse(
  copy: ReadyCopy,
  state: Readonly<Record<string, unknown>>,
  now: number,
): Analysis {
  const track = trackOf(copy, state);
  const docs = copy.documents;
  const byPath = new Map(docs.map((d) => [d.path, d] as const));
  const epics = docs.filter((d) => d.path.startsWith(EPICS) && kindOf(d) !== "story");
  const stories = storiesOf(docs);
  const stage: Stage = epics.length + stories.size > 0 ? "build" : "breakdown";
  const found: Listed[] = [];
  const add = (item: Listed) => found.push(item);

  // Active identifiers the requirements and decisions documents define.
  const defined = new Map<string, { path: string }>();
  for (const d of docs) {
    if (!STRUCTURING.some((k) => k === kindOf(d))) continue;
    for (const definition of d.definitions) {
      if (!definition.retired && !defined.has(definition.id)) {
        defined.set(definition.id, { path: d.path });
      }
    }
  }
  const ids: Record<string, number> = {};
  for (const id of defined.keys()) {
    const prefix = id.slice(0, id.indexOf("-"));
    ids[prefix] = (ids[prefix] ?? 0) + 1;
  }

  // 1. Documents present, validated, unchanged.
  const present = (kind: string) =>
    docs.find((d) => kindOf(d) === kind && d.path.toLowerCase() === `${DOCS}${kind}.md`);
  const required: string[] = track === "short" ? ["spec"] : ["prd", "architecture"];
  const hasJourneys = [...defined.keys()].some((id) => id.startsWith("PU-"));
  if (track === "full" && copy.needsUx && hasJourneys) required.push("ux");
  for (const kind of required) {
    if (present(kind) === undefined && !skippedWithItsPhase(state, kind as never)) {
      add({
        key: `doc_missing:${kind}`,
        severity: "blocking",
        origin: "engine",
        text: `The ${kind} is missing and the plan rests on decisions it should record.`,
        owner: "creator",
        fix: `Have the ${kind} written and validated, or say the step is skipped.`,
      });
    }
  }
  const versions = validatedVersions(
    Object.values((state.checkpoints ?? {}) as Record<string, CheckpointState>),
    now,
  );
  for (const d of docs) {
    const kind = kindOf(d);
    if (!STRUCTURING.some((k) => k === kind) || d.path.toLowerCase() !== `${DOCS}${kind}.md`)
      continue;
    if (kind !== "spec" && skippedWithItsPhase(state, kind as never)) continue;
    const validated = versions.get(pathKey(d.path));
    const mine = new Set(blobIdsOf(copy.texts.get(d.path) ?? ""));
    const owner = ownerOf(d, "creator");
    if (validated === undefined) {
      add({
        key: `doc_unvalidated:${kind}`,
        severity: "blocking",
        origin: "engine",
        text: `${SHORT_PATH(d.path)} was never validated by the creator: a draft is not an input.`,
        owner,
        fix: "Present it for the creator's validation.",
      });
    } else if (!mine.has(validated.blob)) {
      add({
        key: `doc_changed:${kind}@${[...mine].find((id) => id.length === 40)?.slice(0, 8) ?? ""}`,
        severity: "should_fix",
        origin: "engine",
        text: `${SHORT_PATH(d.path)} changed since the creator validated it.`,
        owner,
        fix: "Present the new version for the creator's validation.",
      });
    }
  }

  // 2. What `docs check` finds in the planning documents.
  const unknown = new Map<string, { first: DocsProblem; count: number }>();
  const grouped = new Map<string, { first: DocsProblem; count: number }>();
  const uncovered: DocsProblem[] = [];
  const uxUncovered: DocsProblem[] = [];
  for (const problem of copy.problems) {
    const path = String(problem.details.path ?? "");
    if (!isPlanningPath(path) || documentProblemIsWarning(state, path)) continue;
    if (problem.code === ErrorCode.REQ_NOT_COVERED) {
      uncovered.push(problem);
      continue;
    }
    // An element of the UX specification that no story carries has its own finding.
    if (problem.details.reason === "ux_element_uncovered") {
      uxUncovered.push(problem);
      continue;
    }
    const bucket = problem.code === ErrorCode.DOC_LINK_DANGLING ? unknown : grouped;
    const key =
      problem.code === ErrorCode.DOC_LINK_DANGLING
        ? String(problem.details.link ?? "?")
        : problem.code;
    const known = bucket.get(key);
    if (known === undefined) bucket.set(key, { first: problem, count: 1 });
    else known.count += 1;
  }
  const more = (count: number) => (count > 1 ? ` (+${count - 1} more)` : "");
  const where = (p: DocsProblem) => `${SHORT_PATH(String(p.details.path))}:${p.details.line}`;
  const authorOf = (p: DocsProblem) =>
    ownerOf(
      byPath.get(String(p.details.path)),
      String(p.details.path).startsWith(DOCS) ? "creator" : "izzy",
    );
  for (const [link, { first, count }] of unknown) {
    add({
      key: `unknown_id:${link.slice(0, 50)}`,
      severity: "blocking",
      origin: "engine",
      text: `${link} is cited in ${where(first)}${more(count)} and defined nowhere.`,
      owner: authorOf(first),
      fix: "Correct the citation, or have the identifier defined by its document.",
    });
  }
  for (const [code, { first, count }] of grouped) {
    add({
      key: `docs_check:${code}@${where(first).slice(0, 40)}`,
      severity: STRUCTURAL.has(code) ? "blocking" : "should_fix",
      origin: "engine",
      text: `docs check: ${code} at ${where(first)}${more(count)}.`,
      owner: authorOf(first),
      fix: "Run docs check and correct what it reports.",
    });
  }

  // 3. The trace in both directions, once there is something to trace to.
  if (stage === "build" && stories.size === 0) {
    add({
      key: "stories_missing",
      severity: "should_fix",
      origin: "engine",
      text: "Epics are written but no story is: nothing is traced to a requirement yet.",
      owner: "izzy",
      fix: "Write the stories of the epics.",
    });
  }
  if (stage === "build") {
    const cited = new Set<string>();
    for (const d of [...epics, ...stories.values()]) {
      for (const id of refsOf(copy.texts.get(d.path) ?? "")) cited.add(id);
    }
    for (const problem of uncovered) {
      const id = String(problem.details.id);
      add({
        key: `req_uncovered:${id}`,
        severity: "should_fix",
        origin: "engine",
        text: `${id} is carried by no story and left out of no epic.`,
        owner: "izzy",
        fix: "Add a story for it, or write it in an epic's out_of_scope.",
      });
    }
    for (const problem of uxUncovered) {
      const id = String(problem.details.id);
      add({
        key: `ux_element_orphan:${id}`,
        severity: "should_fix",
        origin: "engine",
        text: `The UX element ${id} (${where(problem)}) is carried by no story.`,
        owner: "izzy",
        fix: "Name it in the Context of the story that builds it, or retire it in ux.md.",
      });
    }
    for (const [id, { path }] of defined) {
      if (cited.has(id)) continue;
      if (id.startsWith("PU-")) {
        add({
          key: `journey_orphan:${id}`,
          severity: "should_fix",
          origin: "engine",
          text: `The journey ${id} (${SHORT_PATH(path)}) is cited by no epic and no story.`,
          owner: "izzy",
          fix: "Add the story that delivers it, or retire the journey.",
        });
      } else if (id.startsWith("AD-")) {
        add({
          key: `decision_orphan:${id}`,
          severity: "minor",
          origin: "engine",
          text: `The decision ${id} is cited by no epic and no story.`,
          owner: "izzy",
          fix: "Bind a story to it, or retire the decision.",
        });
      }
    }
    for (const [id, story] of stories) {
      if ((story.story?.requirements.length ?? 0) > 0) continue;
      add({
        key: `story_orphan:${id}`,
        severity: "should_fix",
        origin: "engine",
        text: `Story ${id} traces to no requirement.`,
        owner: ownerOf(story, "izzy"),
        fix: "Name the requirement it serves, or drop the story.",
      });
    }
  }

  const intent = docs
    .filter(
      (d) => [...STRUCTURING, ...INTENT].some((k) => k === kindOf(d)) && d.path.startsWith(DOCS),
    )
    .map((d) => d.path)
    .sort();
  return {
    inventory: { track, stage, documents: intent, epics: epics.length, stories: stories.size, ids },
    mark: markOf(copy),
    findings: found.sort(bySeverity),
  };
}

// ---------------------------------------------------------------------------------------------
// The gate: engine and judgment together
// ---------------------------------------------------------------------------------------------

export interface Gate {
  readonly analysis: Analysis;
  /** `none`: never judged; `stale`: the documents changed since; `current`. */
  readonly judged: "none" | "stale" | "current";
  readonly report: ReadinessReport | undefined;
  /** What is left to settle, the graver first: the engine's findings and the judged ones. */
  readonly open: readonly Listed[];
  readonly accepted: number;
  readonly verdict: ReadinessVerdict;
  /** The creator answered the blocking verdict's decision by going on all the same. */
  readonly waived: boolean;
}

/** The verdict from the findings left open. */
export function verdictOf(open: readonly Pick<Listed, "severity">[]): ReadinessVerdict {
  if (open.some((f) => f.severity === "blocking")) return "blocking";
  return open.some((f) => f.severity === "should_fix") ? "reserves" : "ready";
}

function judgedListed(report: ReadinessReport): Listed[] {
  return report.findings.map((f) => ({
    key: judgedKey(f.n),
    severity: f.severity,
    origin: "agent" as const,
    text: `${f.kind}: ${f.claim} [${f.passages.join(" | ")}]`,
    owner: f.owner,
    fix: f.proposal ?? "Correct the document.",
  }));
}

/**
 * The blocking findings the creator went on with all the same: the keys the latest report recorded,
 * once the decision it opened was answered `go_on`. They stay waived when the documents change (a new
 * finding is still asked), so the same blocking points are not put to the creator again.
 */
export function waivedKeysOf(state: Readonly<Record<string, unknown>>): Set<string> {
  const report = readinessOf(state)?.report ?? undefined;
  if (report?.checkpoint == null) return new Set();
  const checkpoint = ((state.checkpoints ?? {}) as Record<string, CheckpointState>)[
    report.checkpoint
  ];
  const goneOn =
    checkpoint?.status === "resolved" &&
    checkpoint.resolution?.option === "go_on" &&
    checkpoint.resolution.decision !== "waived";
  return goneOn ? new Set(report.waivable) : new Set();
}

/** The gate as it stands: `judged` tells whether the agent's reading still holds. */
export function gateOf(
  analysis: Analysis,
  state: Readonly<Record<string, unknown>>,
  acceptedOverride?: Readonly<Record<string, Acceptance>>,
): Gate {
  const record: ReadinessState | undefined = readinessOf(state);
  const report = record?.report ?? undefined;
  const accepted = acceptedOverride ?? record?.accepted ?? {};
  const current =
    report !== undefined &&
    report.mark === analysis.mark &&
    report.stage === analysis.inventory.stage;
  const judged = report === undefined ? "none" : current ? "current" : "stale";
  const all = [
    ...analysis.findings,
    ...(current && report !== undefined ? judgedListed(report) : []),
  ];
  const waivedKeys = waivedKeysOf(state);
  const open = all
    .filter((f) => !Object.hasOwn(accepted, f.key) && !waivedKeys.has(f.key))
    .sort(bySeverity);
  const waived = waivedKeys.size > 0;
  return {
    analysis,
    judged,
    report: report,
    open,
    accepted: all.length - open.length,
    verdict: verdictOf(open),
    waived,
  };
}

/** True when the gate is behind us: judged on these documents, and not blocking (or waived). */
export function gatePassed(gate: Gate): boolean {
  return gate.judged === "current" && gate.verdict !== "blocking";
}

/** One line per open finding, the graver first, at most `MAX_READINESS_LISTED`. */
export function stackOf(open: readonly Listed[]): { lines: string[]; more: number } {
  return {
    lines: open
      .slice(0, MAX_READINESS_LISTED)
      .map((f) => short(`${f.key} · ${f.severity} · ${f.text}`, 150)),
    more: Math.max(0, open.length - MAX_READINESS_LISTED),
  };
}

export function countsOf(open: readonly Pick<Listed, "severity">[]) {
  return {
    blocking: open.filter((f) => f.severity === "blocking").length,
    should_fix: open.filter((f) => f.severity === "should_fix").length,
    minor: open.filter((f) => f.severity === "minor").length,
  };
}

// ---------------------------------------------------------------------------------------------
// What a whole report is
// ---------------------------------------------------------------------------------------------

/** The document a passage's first part names: its id, its file name or its path, once. */
export function documentNamed(copy: ReadyCopy, ref: string): ParsedDocument | undefined {
  const wanted = ref.trim().toLowerCase().replace(/\.md$/, "");
  if (wanted === "") return undefined;
  const hits = copy.documents.filter((d) => {
    const path = d.path.toLowerCase().replace(/\.md$/, "");
    return (
      d.id?.toLowerCase() === wanted ||
      nameOf(d.path).toLowerCase() === wanted ||
      path === wanted ||
      path.endsWith(`/${wanted}`)
    );
  });
  return hits.length === 1 ? hits[0] : undefined;
}

/** Splits `<document>: <passage>`; undefined without the colon. */
function splitPassage(passage: string): { doc: string; text: string } | undefined {
  const at = passage.indexOf(":");
  if (at <= 0) return undefined;
  const text = passage.slice(at + 1).trim();
  return text === "" ? undefined : { doc: passage.slice(0, at), text };
}

/** What is wrong with a judged report, as short codes. Empty when whole. */
export function validateReadyReport(input: ReadyInput, copy: ReadyCopy, track: Track): string[] {
  const problems: string[] = [];
  for (const field of ["items", "quote"] as const) {
    if (input[field] !== undefined) problems.push(`unexpected:${field}`);
  }
  if (copy.documents.length === 0) problems.push("nothing_to_check");
  if (input.summary === undefined || input.summary.length < 20) problems.push("summary_missing");
  const findings = input.findings ?? [];
  if (input.findings === undefined) problems.push("findings_missing");
  const cap = track === "short" ? MAX_SHORT_FINDINGS : MAX_READINESS_FINDINGS;
  if (findings.length > cap) problems.push(`too_many_findings:${findings.length}>${cap}`);
  findings.forEach((finding, index) => {
    const n = index + 1;
    if (finding.severity !== "minor" && finding.proposal === undefined) {
      problems.push(`proposal_missing:${n}`);
    }
    const named = new Set<string>();
    finding.passages.forEach((passage, k) => {
      const parts = splitPassage(passage);
      if (parts === undefined) {
        problems.push(`passage_format:${n}.${k + 1}`);
        return;
      }
      const document = documentNamed(copy, parts.doc);
      if (document === undefined) {
        problems.push(`document_unknown:${n}.${k + 1}`);
        return;
      }
      named.add(document.path);
      if (!passageFound(copy.texts.get(document.path) ?? "", parts.text)) {
        problems.push(`passage_unknown:${n}.${k + 1}`);
      }
    });
    if (finding.kind === "conflict" && named.size < 2) problems.push(`conflict_one_document:${n}`);
  });
  return problems;
}

/** The agent that corrects a judged finding: the owner of the first document it names. */
export function ownerOfFinding(copy: ReadyCopy, passages: readonly string[]): string {
  const parts = splitPassage(passages[0] ?? "");
  const document = parts === undefined ? undefined : documentNamed(copy, parts.doc);
  return ownerOf(document, "creator");
}

/** What is wrong with the creator's gestures. */
export function validateSettle(input: ReadyInput, gate: Gate): string[] {
  const problems: string[] = [];
  for (const field of ["summary", "findings"] as const) {
    if (input[field] !== undefined) problems.push(`unexpected:${field}`);
  }
  if (input.quote === undefined) problems.push("quote_missing");
  const items = input.items ?? [];
  if (items.length === 0) problems.push("items_missing");
  const open = new Set(gate.open.map((f) => f.key));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) problems.push(`repeated:${item.id}`);
    seen.add(item.id);
    if (!open.has(item.id)) {
      problems.push(isJudgedKey(item.id) ? `not_open:${item.id}` : `unknown_finding:${item.id}`);
    }
    if (item.gesture === "accept" && item.reason === undefined) {
      problems.push(`reason_missing:${item.id}`);
    }
  }
  return problems;
}

/** The fix to hand to each author: the findings kept for correction, by owner. */
export function fixesOf(open: readonly Listed[], keys: readonly string[]) {
  const wanted = new Set(keys);
  const byOwner = new Map<string, string[]>();
  for (const f of open) {
    if (!wanted.has(f.key)) continue;
    const list = byOwner.get(f.owner) ?? [];
    list.push(short(`${f.key} — ${f.fix}`, 160));
    byOwner.set(f.owner, list);
  }
  return [...byOwner].map(([owner, lines]) => ({ owner, lines }));
}
