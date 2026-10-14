/**
 * The documents that convince: the narrative and the deck of the launch (Julien), and
 * the design thinking synthesis (Stella). They are notes of `.agentplugged/docs/launch/`, validated
 * like the other deliverables; this is the contract of their content, `docs check` reads it.
 */

/** The ids of the two documents of the launch that have a single file each. */
export const NARRATIVE_DOCUMENT_ID = "narrative";
export const DECK_DOCUMENT_ID = "deck";

/** A design thinking synthesis is `design-<slug>`. */
export const DESIGN_ID_PREFIX = "design-";

/** Sections of the narrative (level 2 headings), and the titles each one accepts. */
export const NARRATIVE_SECTIONS = {
  audience: ["audience", "public", "cible"],
  story: ["story", "histoire", "récit"],
  proof: ["proof", "evidence", "preuves", "preuve"],
  ask: ["ask", "call to action", "appel", "demande"],
} as const satisfies Record<string, readonly string[]>;

/** Sections of a design thinking synthesis. */
export const DESIGN_SECTIONS = {
  empathy: ["empathy", "empathie"],
  definition: ["definition", "définition"],
  ideas: ["ideas", "idées", "idees", "idéation", "ideation"],
  prototype: ["prototype"],
  test: ["test", "tests"],
} as const satisfies Record<string, readonly string[]>;

/** A slide of the deck is a section `## Slide 3` (or `## Slide 3 — title`). */
export const DECK_SLIDE_TITLE = /^(?:slide|diapositive) (\d{1,3})(?:\s*[-—–:].*)?$/;

/** The line of a slide that opens the notes of the speaker. */
export const DECK_NOTES_LINE =
  /^\s*(?:[>*-]\s+)?\**\s*(?:speaker notes|notes de l['’]orateur|notes)\s*\**\s*:\s*\**/i;

/** A slide carries one idea: past this many lines of content, the slide holds more. */
export const DECK_SLIDE_MAX_LINES = 6;

/** The fewest slides a deck has. */
export const DECK_SLIDES_MIN = 3;

/**
 * What marks a figure as sourced or as to be checked: a source, a requirement or a link, or the
 * mark that says it is to verify.
 */
export const PITCH_FIGURE_MARK =
  /\[(?:source|src|to verify|à vérifier|a verifier|assumption|hypoth[èe]se)\b[^\]]*\]|https?:\/\/|\b(?:EF|ENF|PU|MS|AD)-\d+\b/i;
