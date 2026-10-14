import {
  DECK_DOCUMENT_ID,
  DECK_NOTES_LINE,
  DECK_SLIDE_MAX_LINES,
  DECK_SLIDE_TITLE,
  DECK_SLIDES_MIN,
  DESIGN_ID_PREFIX,
  DESIGN_SECTIONS,
  NARRATIVE_DOCUMENT_ID,
  NARRATIVE_SECTIONS,
  PITCH_FIGURE_MARK,
} from "@agentplugged/protocol";
import { METHOD_DIR } from "../init/layout.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { DocsProblem, DocsWarning } from "./docs-base.js";
import { pathKey } from "./knowledge-freshness.js";
import {
  deliverableStatus,
  figuresOf,
  invalid,
  type LaunchCheck,
  type LaunchCheckInput,
  placeholderProblems,
  visibleText,
} from "./launch-documents.js";
import { noteHeaderProblems, noteSectionProblems } from "./note-documents.js";
import { type ParsedDocument, type Section, tableCells } from "./parse-document.js";
import { warning } from "./story-rules.js";

/**
 * The documents that convince, as pure functions: the narrative of the product for
 * an audience and the deck that carries it (Julien), the design thinking synthesis (Stella). They
 * are notes of the launch folder, validated by a checkpoint like the positioning. `docs check`
 * verifies what a program can: the header (id, owner, the documents they are drawn from), the
 * sections, the slides with their notes, and that a figure carries its source or the mark that
 * says it is to verify. Whether the narrative is validated is read from the checkpoints.
 */

/** The narrative and the deck: one file each. */
export const NARRATIVE_PATH = `${METHOD_DIR}/docs/launch/narrative.md`;
export const DECK_PATH = `${METHOD_DIR}/docs/launch/deck.md`;

/** The page that draws the deck, written next to it by `docs slides`. */
export const DECK_PAGE_PATH = `${METHOD_DIR}/docs/launch/deck.html`;

/** The design thinking syntheses: one file each, under this folder. */
export const DESIGN_DIR = `${METHOD_DIR}/docs/launch/design/`;

type Kind = "narrative" | "deck" | "design";

/** The kind of pitch document a file is, or undefined. */
export function pitchKindOf(document: ParsedDocument): Kind | undefined {
  const path = pathKey(document.path);
  if (path === NARRATIVE_PATH) return "narrative";
  if (path === DECK_PATH) return "deck";
  return path.startsWith(DESIGN_DIR) ? "design" : undefined;
}

/** Who may own each: the agent that carries it, or the creator. */
const OWNERS: Record<Kind, ReadonlySet<string>> = {
  narrative: new Set(["julien", "creator"]),
  deck: new Set(["julien", "creator"]),
  design: new Set(["stella", "creator"]),
};

/** The checkpoints that validate a deliverable of the launch. */
const VALIDATING = ["publication", "document"] as const;

/** Whether the deck is validated: the same reading as the narrative's, of the file as it stands. */
export function deckStatus(
  text: string | undefined,
  checkpoints: Iterable<CheckpointState>,
  now: number,
) {
  return deliverableStatus(DECK_PATH, text, checkpoints, now, VALIDATING);
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function headerProblems(document: ParsedDocument, kind: Kind): DocsProblem[] {
  const idOk =
    kind === "design"
      ? document.id?.startsWith(DESIGN_ID_PREFIX) &&
        SLUG_PATTERN.test(document.id.slice(DESIGN_ID_PREFIX.length))
      : document.id === (kind === "narrative" ? NARRATIVE_DOCUMENT_ID : DECK_DOCUMENT_ID);
  return noteHeaderProblems(document, {
    reasons: {
      id: "pitch_id",
      kind: "pitch_kind",
      owner: "pitch_owner",
      links: "pitch_links",
      section: "pitch_section",
    },
    expected: kind === "design" ? `${DESIGN_ID_PREFIX}<slug>` : kind,
    idOk: idOk === true,
    owners: OWNERS[kind],
    agent: kind === "design" ? "stella" : "julien",
  });
}

/** The lines of a slide before its notes line, and the notes (the first line without its mark). */
export function slideParts(section: Section): {
  content: string[];
  notes: string[];
  noted: boolean;
} {
  const at = section.lines.findIndex((line) => DECK_NOTES_LINE.test(line));
  if (at === -1) return { content: [...section.lines], notes: [], noted: false };
  const first = (section.lines[at] ?? "").replace(DECK_NOTES_LINE, "");
  return {
    content: section.lines.slice(0, at),
    notes: [first, ...section.lines.slice(at + 1)],
    noted: true,
  };
}

/** The text of a slide before its notes line, and what the notes hold. */
function splitSlide(section: Section): { content: string[]; notes: string; noted: boolean } {
  const { content, notes, noted } = slideParts(section);
  return { content, notes: noted ? visibleText(notes) : "", noted };
}

/** The lines a slide shows: the filled ones, a table counting as one. */
function contentLines(text: string): number {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const table = lines.some((line) => /^\s*\|/.test(line));
  return lines.filter((line) => !/^\s*\|/.test(line)).length + (table ? 1 : 0);
}

function slideChecks(document: ParsedDocument): LaunchCheck {
  const { path } = document;
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  const slides = document.sections.filter((section) => DECK_SLIDE_TITLE.test(section.title));
  const numbers = slides.map((section) => Number(DECK_SLIDE_TITLE.exec(section.title)?.[1]));
  const ordered = numbers.every((number, index) => number === index + 1);
  if (slides.length < DECK_SLIDES_MIN || !ordered) {
    problems.push(
      invalid(path, slides[0]?.line ?? 1, "pitch_slides", {
        field: "body",
        problem: slides.length < DECK_SLIDES_MIN ? "few" : "order",
        min: DECK_SLIDES_MIN,
        found: slides.length,
      }),
    );
  }
  for (const section of slides) {
    const { content, notes, noted } = splitSlide(section);
    const shown = visibleText(content);
    if (shown === "" || !noted || notes === "") {
      problems.push(
        invalid(path, section.line, "pitch_slides", {
          field: section.title,
          problem: shown === "" ? "empty" : "notes",
          min: DECK_SLIDES_MIN,
          found: slides.length,
        }),
      );
    } else if (contentLines(shown) > DECK_SLIDE_MAX_LINES) {
      warnings.push(
        warning("pitch_slide_dense", {
          path,
          line: section.line,
          slide: section.title,
          max: DECK_SLIDE_MAX_LINES,
        }),
      );
    }
  }
  return { problems, warnings };
}

/** True when a line of text names a source, or says the figure is to verify. */
function sourcedLine(line: string): boolean {
  if (PITCH_FIGURE_MARK.test(line)) return true;
  // A table row of claims: the last cell is the source (and not the figure itself).
  if (!/^\s*\|/.test(line)) return false;
  const cells = tableCells(line);
  const last = cells.at(-1) ?? "";
  return cells.length >= 3 && visibleText([last]) !== "" && figuresOf(last).length === 0;
}

/** The sections that list sources: a figure there is the source's own. */
const SOURCE_SECTION = /^(?:sources?|références?|references?)$/;

/** A figure stated with neither a source nor the mark « to verify »: a warning, never a refusal. */
export function figureWarnings(document: ParsedDocument): DocsWarning[] {
  const bare: Array<{ line: number; figure: string }> = [];
  for (const section of document.sections) {
    if (SOURCE_SECTION.test(section.title)) continue;
    // The heading is read too: a slide's title is its claim.
    const heading = figuresOf(section.title)[0];
    if (heading !== undefined && !sourcedLine(section.title)) {
      bare.push({ line: section.line, figure: heading.figure });
    }
    let fenced = false;
    let comment = false;
    section.lines.forEach((text, index) => {
      if (/^\s*```/.test(text)) fenced = !fenced;
      const inside = comment || /<!--/.test(text);
      if (inside) comment = !/-->/.test(text);
      if (fenced || inside || sourcedLine(text)) return;
      const figure = figuresOf(text)[0];
      if (figure !== undefined)
        bare.push({ line: section.line + 1 + index, figure: figure.figure });
    });
  }
  const first = bare[0];
  return first === undefined
    ? []
    : [
        warning("pitch_figure_unsourced", {
          path: document.path,
          line: first.line,
          figure: first.figure,
          count: bare.length,
        }),
      ];
}

/**
 * The rules of the narrative, the deck and the design syntheses. Warnings: a figure with no
 * source, a slide that holds more than one idea, and a deck built on a narrative that is not
 * validated (or was edited since).
 */
export function pitchDocumentChecks(input: LaunchCheckInput): LaunchCheck {
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  const narrative = input.documents.find((document) => pitchKindOf(document) === "narrative");
  const narrativeStatus =
    input.validations === undefined || narrative === undefined
      ? undefined
      : deliverableStatus(
          NARRATIVE_PATH,
          input.textOf(narrative.path),
          input.validations.checkpoints,
          input.validations.now,
          VALIDATING,
        );
  for (const document of input.documents) {
    const kind = pitchKindOf(document);
    if (kind === undefined) continue;
    problems.push(...headerProblems(document, kind), ...placeholderProblems(document));
    if (kind === "deck") {
      const slides = slideChecks(document);
      problems.push(...slides.problems);
      warnings.push(...slides.warnings);
      if (
        narrativeStatus !== undefined &&
        narrativeStatus.state !== "validated" &&
        document.links.some((link) => link.value === NARRATIVE_DOCUMENT_ID)
      ) {
        warnings.push(
          warning("pitch_narrative_not_validated", {
            path: document.path,
            state: narrativeStatus.state,
          }),
        );
      }
    } else {
      problems.push(
        ...noteSectionProblems(
          document,
          kind === "narrative" ? NARRATIVE_SECTIONS : DESIGN_SECTIONS,
          "pitch_section",
        ),
      );
    }
    warnings.push(...figureWarnings(document));
  }
  return { problems, warnings };
}
