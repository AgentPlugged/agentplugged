import {
  CONCEPT_FIELD,
  CONCEPT_TYPES,
  FORGE_ID_PREFIX,
  FORGE_IDEA_SECTION,
  FORGE_LOG_SECTION,
  FORGE_LOG_WORDS,
  FORGE_MAX_LINES,
  FORGE_OUTCOME_SECTIONS,
  FORGE_OUTCOME_WORDS,
  FORGE_SCOPE_FIELD,
  FORGE_SCOPES,
  type ForgeOutcome,
} from "@agentplugged/protocol";
import type { DocsProblem } from "./docs-base.js";
import { bare, clip, IDEATION_DIR, plain } from "./ideation-documents.js";
import { pathKey } from "./knowledge-freshness.js";
import {
  invalid,
  type LaunchCheck,
  type LaunchCheckInput,
  placeholderProblems,
} from "./launch-documents.js";
import { noteHeaderProblems, noteSectionProblems } from "./note-documents.js";
import type { ParsedDocument } from "./parse-document.js";
import { sectionState } from "./sales-documents.js";

/**
 * The file of a forge (Iris), as pure functions. It is saved from the first answer
 * (a log of typed entries, so a stopped conversation is picked up where it stopped) and distilled
 * at the end, on one of three outcomes, into a few lines the brief starts from: the log goes, the
 * decisions and the options turned down with their reasons stay (hardened), the cause (killed) or
 * what is clearer (clearer). Only the shape is checked; what is decided stays the creator's.
 */

/** A forge is a file `forge-<anything>.md` of the folder of the ideas; its `id` is its name. */
export function isForgeFile(document: ParsedDocument): boolean {
  const path = pathKey(document.path);
  if (!path.startsWith(IDEATION_DIR)) return false;
  const name = path.slice(IDEATION_DIR.length);
  return name.startsWith(FORGE_ID_PREFIX) && name.endsWith(".md") && !name.includes("/");
}

const OUTCOME_LINE = /^(?:outcome|issue|r[eé]sultat)[ \t]*:[ \t]*(.*)$/im;
const BULLET = /^(?:[-*]|\d+[.)])\s+(.*)$/;
const LOG_TAG = /^\[\s*([^\]]+?)\s*\]\s*\S/;
/** What separates an option from its reason: a dash, a colon and a space, an arrow, « because ». */
const SEPARATOR = /\s[—–-]\s+|:\s+|\s*(?:→|->)\s*|\s+(?:because|parce que)\s+/i;

/** A reason is at least two words after the separator (a bare link or a lone word is not one). */
function hasReason(text: string): boolean {
  const found = SEPARATOR.exec(text);
  if (found === null) return false;
  const rest = text.slice(found.index + found[0].length);
  return rest.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length >= 2;
}

/** The concept type a header names, read as written (spaces and underscores read as hyphens). */
export function conceptOf(value: unknown): string | undefined {
  return typeof value === "string"
    ? plain(value)
        .trim()
        .replace(/[\s_]+/g, "-")
    : undefined;
}

/** The problem a concept type of the header has, if any: absent or not one of the four. */
export function conceptProblem(
  document: ParsedDocument,
  required: boolean,
  reason: "forge_concept" | "prfaq_concept",
): DocsProblem[] {
  // A header that does not read is reported by the header checks, not twice.
  if (document.header === undefined) return [];
  const value = (document.header as Record<string, unknown>)[CONCEPT_FIELD];
  if (value === undefined) {
    return required ? [invalid(document.path, 1, reason, { problem: "missing" })] : [];
  }
  const concept = conceptOf(value);
  return (CONCEPT_TYPES as readonly string[]).includes(concept ?? "")
    ? []
    : [invalid(document.path, 1, reason, { problem: "unknown", value: clip(String(value)) })];
}

function outcomeOf(text: string): { outcome?: ForgeOutcome; found: boolean; word: string } {
  const found = OUTCOME_LINE.exec(bare(text));
  if (found === null) return { found: false, word: "" };
  const value = plain(found[1] ?? "").trim();
  const outcome = (Object.keys(FORGE_OUTCOME_WORDS) as ForgeOutcome[]).find((name) =>
    FORGE_OUTCOME_WORDS[name].test(value.replace(/[.\s]+$/, "")),
  );
  return { found: true, word: value, ...(outcome === undefined ? {} : { outcome }) };
}

function scopeProblems(document: ParsedDocument): DocsProblem[] {
  const value = (document.header as Record<string, unknown> | undefined)?.[FORGE_SCOPE_FIELD];
  if (value === undefined) return [];
  if (!(FORGE_SCOPES as readonly unknown[]).includes(value)) {
    return [invalid(document.path, 1, "forge_scope", { problem: "unknown" })];
  }
  // A change to a project that exists stands on its documents: the claim is checked against them.
  return value === "change" && document.links.length === 0
    ? [invalid(document.path, 1, "forge_scope", { problem: "links" })]
    : [];
}

/** Each entry of the log opens with its type between brackets; once the outcome is there, no log. */
function logProblems(document: ParsedDocument, closed: boolean): DocsProblem[] {
  const log = document.sections.find((section) =>
    (FORGE_LOG_SECTION as readonly string[]).includes(section.title),
  );
  if (log === undefined) return [];
  if (closed)
    return [invalid(document.path, log.line, "forge_log", { problem: "kept", detail: "## Log" })];
  return log.lines.flatMap((text, index) => {
    const bullet = BULLET.exec(text);
    if (bullet === null) return [];
    const word = plain(LOG_TAG.exec(bullet[1] ?? "")?.[1] ?? "").trim();
    const known = Object.values(FORGE_LOG_WORDS).some((pattern) => pattern.test(word));
    return known
      ? []
      : [
          invalid(document.path, log.line + 1 + index, "forge_log", {
            problem: "type",
            detail: clip(bullet[1] ?? ""),
          }),
        ];
  });
}

/** A hardened file keeps the options turned down, each with its reason: at least one, all reasoned. */
function rejectedProblems(document: ParsedDocument): DocsProblem[] {
  const { section } = sectionState(document.sections, FORGE_OUTCOME_SECTIONS.hardened.rejected);
  if (section === undefined) return [];
  const bullets = section.lines.flatMap((text, index) => {
    const bullet = BULLET.exec(text);
    return bullet === null ? [] : [{ line: section.line + 1 + index, text: bullet[1] ?? "" }];
  });
  if (bullets.length === 0) {
    return [
      invalid(document.path, section.line, "forge_reason", {
        problem: "none",
        detail: "## Rejected",
      }),
    ];
  }
  return bullets
    .filter((bullet) => !hasReason(bullet.text))
    .map((bullet) =>
      invalid(document.path, bullet.line, "forge_reason", {
        problem: "reason",
        detail: clip(bullet.text),
      }),
    );
}

/** The rules of the files of the forge: header, idea, log, outcome, what each outcome keeps. */
export function forgeDocumentChecks(input: LaunchCheckInput): LaunchCheck {
  const problems: DocsProblem[] = [];
  for (const document of input.documents) {
    if (!isForgeFile(document)) continue;
    const raw = (input.textOf(document.path) ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
    const file = pathKey(document.path).slice(IDEATION_DIR.length).replace(/\.md$/, "");
    // The outcome line stands under the title, before the first section: never in the creator's idea.
    const preamble = body.split(/^##[ \t]/m)[0] ?? body;
    const { outcome, found, word } = outcomeOf(preamble);
    problems.push(
      ...noteHeaderProblems(document, {
        reasons: {
          id: "forge_id",
          kind: "forge_kind",
          owner: "forge_owner",
          section: "forge_section",
        },
        expected: file,
        idOk: document.id === file,
        owners: new Set(["iris", "creator"]),
        agent: "iris",
      }),
      ...placeholderProblems(document),
      ...conceptProblem(document, true, "forge_concept"),
      ...scopeProblems(document),
      ...noteSectionProblems(document, { idea: FORGE_IDEA_SECTION }, "forge_section"),
      ...logProblems(document, found),
    );
    if (!found) continue;
    if (outcome === undefined) {
      problems.push(invalid(document.path, 1, "forge_outcome", { outcome: clip(word) }));
      continue;
    }
    problems.push(
      ...noteSectionProblems(document, FORGE_OUTCOME_SECTIONS[outcome], "forge_section"),
    );
    if (outcome === "hardened") problems.push(...rejectedProblems(document));
    const lines = body.split(/\r?\n/).filter((line) => line.trim() !== "").length;
    if (lines > FORGE_MAX_LINES) {
      problems.push(invalid(document.path, 1, "forge_long", { lines, max: FORGE_MAX_LINES }));
    }
  }
  return { problems, warnings: [] };
}
