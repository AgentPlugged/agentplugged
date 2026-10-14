import {
  RESEARCH_LISTED_MAX,
  RESEARCH_MAX_AGE_DAYS,
  RESEARCH_PUBLISHED_WINDOW_DAYS,
  type ResearchType,
} from "@agentplugged/protocol";
import type { ParsedDocument } from "./parse-document.js";
import { reportIsSound, summaryOfReport } from "./research-documents.js";
import { planLines, type ResearchPlanned } from "./research-plan.js";
import { safeLine } from "./research-scan.js";

/**
 * `docs research <subject> [max_age=<days>]`: what was already searched about a
 * subject, in one line per page, so that an agent reuses a recent research instead of searching
 * again and only searches what is missing or has aged. Pure: the pages are read by the caller.
 * The subject and the path of a page are text of outside origin: they reach the agent cleaned,
 * cut, and replaced by a mark when they talk to an agent; a page that `docs check` would refuse is
 * listed as `unsound`, never as fresh.
 */

const DAY = 86_400_000;
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "about",
  "of",
  "to",
  "in",
  "on",
  "by",
  "an",
  "as",
  "at",
  "or",
  "is",
  "it",
  "de",
  "la",
  "le",
  "du",
  "en",
  "un",
  "et",
  "au",
  "ou",
  "les",
  "des",
  "une",
  "pour",
  "dans",
  "sur",
  "avec",
  "est",
  "que",
]);
/** At most this many claim numbers per list; the rest is a count. */
const LISTED_NUMBERS = 8;
/** What a line may carry of a page's subject and path. */
const SUBJECT_SHOWN = 80;
const PATH_SHOWN = 100;

/**
 * The words that identify a subject, in any alphabet: no accents or case, no small word (a word of
 * one letter, a stop word), no plural `s` on a Latin word. A number alone is a word (`python 3`).
 */
export function subjectWords(text: string): string[] {
  const words = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => (word.length >= 2 || /^\p{N}$/u.test(word)) && !STOPWORDS.has(word))
    .map((word) => (/^[a-z]{3,}s$/.test(word) ? word.slice(0, -1) : word));
  return [...new Set(words)];
}

/**
 * True when two subjects are the same question: at least 60 % of the smaller one's words are shared.
 * A subject of one word is the same only as that word alone, so that a thin page never answers a
 * longer question.
 */
export function sameSubject(query: readonly string[], subject: readonly string[]): boolean {
  const smaller = Math.min(query.length, subject.length);
  if (smaller === 0) return false;
  // Numbers tell versions, years and sizes apart (`python 2`, `python 3`): they must be the same.
  const figures = (words: readonly string[]) => words.filter((word) => /^\p{N}+$/u.test(word));
  const [a, b] = [figures(query), figures(subject)];
  if (a.length !== b.length || a.some((word) => !b.includes(word))) return false;
  const shared = query.filter((word) => subject.includes(word)).length;
  if (smaller === 1) return shared === 1 && query.length === subject.length;
  return shared >= Math.ceil(smaller * 0.6);
}

export interface ResearchHit {
  /** True for a report imported from another tool: it ages from the day it was made. */
  readonly imported: boolean;
  readonly path: string;
  readonly subject: string;
  readonly types: readonly string[];
  readonly date: string;
  readonly age_days: number;
  readonly max_age_days: number;
  readonly fresh: boolean;
  /** False when `docs check` would refuse the page: it is never fresh then. */
  readonly sound: boolean;
  readonly claims: number;
  readonly doubts: number;
  readonly flagged: number;
  /** The claims to search again: in doubt, or resting only on sources that have aged. */
  readonly redo: readonly number[];
}

export interface ResearchFound {
  readonly research: "find";
  readonly hits: readonly ResearchHit[];
  /** Pages found beyond the ones listed. */
  readonly more: number;
}

/** A page of the knowledge base, parsed, with its text. */
export interface ResearchPage {
  readonly document: ParsedDocument;
  readonly text: string;
}

/** Whole days since a date; infinite for a date that is not one or lies in the future. */
const ageInDays = (date: string, now: number): number => {
  const at = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(at) || at > now) return Number.POSITIVE_INFINITY;
  return Math.floor((now - at) / DAY);
};

/** How many days a research of these types stays fresh when the creator gives no age. */
export function defaultMaxAge(types: readonly string[]): number {
  const ages = types.flatMap((type) => {
    const age = RESEARCH_MAX_AGE_DAYS[type as ResearchType];
    return age === undefined ? [] : [age];
  });
  return ages.length === 0 ? Math.min(...Object.values(RESEARCH_MAX_AGE_DAYS)) : Math.min(...ages);
}

/**
 * How many days after its publication a source still backs a claim, by the page's types: the
 * shortest window of its types (a type without one, the literature, adds none); infinite without any.
 */
export function publishedWindow(types: readonly string[]): number {
  const windows = types.flatMap((type) => {
    const days = RESEARCH_PUBLISHED_WINDOW_DAYS[type as ResearchType];
    return days === undefined ? [] : [days];
  });
  return windows.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...windows);
}

/** The research pages about a subject, the most recent first, at most `RESEARCH_LISTED_MAX`. */
export function findResearch(input: {
  readonly pages: readonly ResearchPage[];
  readonly subject: string;
  readonly now: number;
  readonly maxAgeDays?: number;
}): ResearchFound {
  const wanted = subjectWords(input.subject);
  const hits: ResearchHit[] = [];
  for (const { document, text } of input.pages) {
    const report = summaryOfReport(document);
    if (report === undefined || !sameSubject(wanted, subjectWords(report.subject))) continue;
    const max = input.maxAgeDays ?? defaultMaxAge(report.types);
    const window = publishedWindow(report.types);
    // A source is aged when it was read too long ago, or published longer ago than the type allows:
    // a figure read yesterday from a four-year-old study is still four years old.
    const aged = (id: string): boolean => {
      const source = report.sources.get(id);
      return (
        source === undefined ||
        ageInDays(source.read, input.now) > max ||
        (source.published !== undefined && ageInDays(source.published, input.now) > window)
      );
    };
    const redo = report.claims
      .filter(
        (claim) =>
          claim.level === "doubt" ||
          claim.sources.length === 0 ||
          claim.sources.every((id) => aged(id)),
      )
      .map((claim) => claim.n);
    // A claim with sources, all aged (read long ago, or published before the window): the page is
    // not fresh, whatever its date says, and the claim is listed in `redo`.
    const agedClaims = report.claims.filter(
      (claim) => claim.level !== "doubt" && claim.sources.length > 0 && claim.sources.every(aged),
    ).length;
    const age = ageInDays(report.madeOn ?? report.date, input.now);
    const sound = reportIsSound(document, text, input.now);
    hits.push({
      imported: report.madeOn !== undefined,
      path: document.path,
      subject: report.subject,
      types: report.types,
      date: report.date,
      age_days: age,
      max_age_days: max,
      fresh: sound && age <= max && agedClaims === 0,
      sound,
      claims: report.claims.length,
      doubts: report.claims.filter((claim) => claim.level === "doubt").length,
      flagged: report.flagged,
      redo,
    });
  }
  hits.sort(
    (a, b) =>
      (a.age_days === b.age_days ? 0 : a.age_days < b.age_days ? -1 : 1) ||
      (a.path < b.path ? -1 : 1),
  );
  return {
    research: "find",
    hits: hits.slice(0, RESEARCH_LISTED_MAX),
    more: Math.max(0, hits.length - RESEARCH_LISTED_MAX),
  };
}

/** The numbers of a list, cut after a few. */
function numbers(list: readonly number[]): string {
  if (list.length === 0) return "none";
  const shown = list.slice(0, LISTED_NUMBERS).join(",");
  return list.length > LISTED_NUMBERS ? `${shown},+${list.length - LISTED_NUMBERS}` : shown;
}

/** One bounded line for a page: what comes from the page is cleaned and cut. */
export function researchLine(hit: ResearchHit): string {
  const status = !hit.sound ? "unsound: run docs check" : hit.fresh ? "fresh" : "old";
  const age = Number.isFinite(hit.age_days) ? `${hit.age_days}d` : "date ahead";
  return [
    safeLine(hit.path, PATH_SHOWN),
    safeLine(hit.subject, SUBJECT_SHOWN),
    `${hit.types.join("+")}${hit.imported ? "+import" : ""}`,
    `${hit.date} (${age}, ${status}, max ${hit.max_age_days}d)`,
    `claims ${hit.claims}, doubt ${hit.doubts}, flagged ${hit.flagged}`,
    `redo ${numbers(hit.redo)}`,
  ].join(" | ");
}

/** The lines `docs research` prints: one per page, or `research: none`. */
export function researchLines(found: ResearchFound | ResearchPlanned): string[] {
  if (found.research === "plan") return planLines(found);
  if (found.hits.length === 0) return ["research: none"];
  return [
    ...found.hits.map((hit) => `research: ${researchLine(hit)}`),
    ...(found.more > 0 ? [`research: +${found.more} more`] : []),
  ];
}
