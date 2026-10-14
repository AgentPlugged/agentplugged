import type { LaunchDocumentReason } from "@agentplugged/protocol";
import { documentOwner } from "../agents/agent-aliases.js";
import type { DocsProblem } from "./docs-base.js";
import { invalid, languageProblem } from "./launch-documents.js";
import type { ParsedDocument } from "./parse-document.js";
import { sectionState } from "./sales-documents.js";

/**
 * What the notes that guide the creator share (the pitch documents, the problem
 * analyses and strategies): a header that names the document, its owner and the
 * documents it is drawn from, and the sections it must hold. Pure functions over a parsed document.
 */

/** The reasons of one family of notes: `pitch_*` or `strategy_*`. */
export interface NoteReasons {
  readonly id: LaunchDocumentReason;
  readonly kind: LaunchDocumentReason;
  readonly owner: LaunchDocumentReason;
  /** Absent when the note may be written from nothing (a session of ideas): then `links` is optional. */
  readonly links?: LaunchDocumentReason;
  readonly section: LaunchDocumentReason;
}

export interface NoteHeader {
  readonly reasons: NoteReasons;
  /** What `id` must be, as said to the creator. */
  readonly expected: string;
  /** Whether the document's `id` is right. */
  readonly idOk: boolean;
  /** Who may own it: the agent that carries it, or the creator. */
  readonly owners: ReadonlySet<string>;
  /** The agent named when the owner is wrong. */
  readonly agent: string;
}

/**
 * The header of a note: its `id`, `kind: note`, an owner among those allowed, at least one
 * document it is drawn from (a page with no source is a page started blank), and its language.
 */
export function noteHeaderProblems(document: ParsedDocument, header: NoteHeader): DocsProblem[] {
  const { path } = document;
  const { reasons } = header;
  const problems: DocsProblem[] = [];
  if (document.id !== undefined && !header.idOk) {
    problems.push(
      invalid(path, document.idLine, reasons.id, { field: "id", expected: header.expected }),
    );
  }
  if (document.kind !== undefined && document.kind.value !== "note") {
    problems.push(
      invalid(path, document.kind.line, reasons.kind, { field: "kind", expected: "note" }),
    );
  }
  if (document.owner !== undefined && !header.owners.has(documentOwner(document.owner.value))) {
    problems.push(
      invalid(path, document.owner.line, reasons.owner, {
        field: "owner",
        owner: document.owner.value,
        expected: header.agent,
      }),
    );
  }
  if (document.links.length === 0 && reasons.links !== undefined) {
    problems.push(invalid(path, 1, reasons.links, { field: "links" }));
  }
  problems.push(...languageProblem(document));
  return problems;
}

/** The sections a note must hold, once each, with something in them. */
export function noteSectionProblems(
  document: ParsedDocument,
  titles: Readonly<Record<string, readonly string[]>>,
  reason: LaunchDocumentReason,
): DocsProblem[] {
  const problems: DocsProblem[] = [];
  for (const [key, accepted] of Object.entries(titles)) {
    const { section, problem } = sectionState(document.sections, accepted);
    if (problem === undefined) continue;
    problems.push(
      invalid(document.path, section?.line ?? 1, reason, {
        section: key,
        problem,
        heading: `## ${accepted[0]?.replace(/^./, (letter) => letter.toUpperCase())}`,
      }),
    );
  }
  return problems;
}
