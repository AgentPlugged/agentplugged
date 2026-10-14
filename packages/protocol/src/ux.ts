/**
 * The visual part of the UX specification, as contracts that `docs check` reads: the
 * design tokens in the header of `ux.md`, the elements that stories must cover (`UX-n`), the key
 * screens with their sketch and their mock-up page. The folder and the file names are core's; this
 * is the contract of the content.
 */

/** Header key that holds the design tokens (a map of groups), and the one that names a UI system. */
export const UX_TOKENS_FIELD = "tokens";
export const UX_SYSTEM_FIELD = "ui_system";

/**
 * The groups of tokens, and the prefix a token is named by (`{color.primary}`). With a UI system
 * declared in the header, the group `ui` names what that system already gives (`{ui.button}`): the
 * specification then holds only the difference.
 */
export const UX_TOKEN_GROUPS = ["color", "type", "space", "radius", "shadow"] as const;
export type UxTokenGroup = (typeof UX_TOKEN_GROUPS)[number];
export const UX_SYSTEM_GROUP = "ui";

/** An element of the specification that a story must carry: a component, a state, an access fix. */
export const UX_ELEMENT_PATTERN = /^UX-[1-9]\d{0,5}$/;

/** Sections of `ux.md` the checks read (level 2 headings, compared without case). */
export const UX_SECTIONS = {
  key_screens: ["key screens", "écrans clés", "ecrans cles"],
  sketches: ["screen sketches", "croquis des écrans", "croquis des ecrans"],
  architecture: ["information architecture", "architecture de l'information"],
} as const satisfies Record<string, readonly string[]>;

/** The cell of a key screen that says its layout is built from the tables alone (a creator's choice). */
export const UX_TABLES_ONLY =
  /^(?:none|no mock-?up|table only|aucune?|sans maquette|tableaux? seul(?:s)?)$/i;

/** Mock-up pages live in this folder of `.agentplugged/docs/`, one page per file. */
export const UX_MOCKUP_DIR = "ux-mockups";
export const UX_MOCKUP_FILE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
/** The size of one page, in bytes, and how many pages a specification keeps. */
export const UX_MOCKUP_MAX_BYTES = 30_000;
export const UX_MOCKUP_MAX_FILES = 8;
/** Key screens a specification draws (2 to 4): outside, a warning. */
export const UX_KEY_SCREENS = { min: 2, max: 4 } as const;

/** Why a problem of the UX specification or of a mock-up page is raised (`docs check`). */
export const UX_DOCUMENT_REASONS = [
  /** The `tokens` block: a group, a value or a colour that is not valid. */
  "ux_tokens",
  /** A `{token}` used in the specification that the header does not define. */
  "ux_token_undefined",
  /** An element `UX-n` defined twice. */
  "ux_element_duplicate",
  /** An element `UX-n` that no story carries. */
  "ux_element_uncovered",
  /** A link to a page that is not in the folder of the pages, or that leaves it. */
  "ux_mockup_missing",
  "ux_mockup_path",
  /** A key screen with no page and no word saying the tables stand alone. */
  "ux_screen_unmocked",
  /** A screen with no sketch, or a sketch whose numbered regions do not match its drawing. */
  "ux_sketch",
  /** A page that is too big, or that is not self-contained and safe. */
  "ux_mockup_size",
  "ux_mockup_unsafe",
] as const;
export type UxDocumentReason = (typeof UX_DOCUMENT_REASONS)[number];
