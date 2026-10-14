/**
 * The brand, as contracts that `docs check` reads: the platform of the brand
 * (Julien: mission, values, voice…) and the visual identity (Stella: symbol, palette, type, the
 * fixed rules). The tokens of the identity are the format of the UX specification (`ux.ts`); the
 * fixed rules are declared in the header of the identity under `brand_rules`, in a form a program
 * can verify. The folder and the file names are core's; this is the contract of the content.
 */

export const BRAND_DOCUMENT_ID = "brand";
export const IDENTITY_DOCUMENT_ID = "identity";

/** Header keys of the identity: the fixed rules, and the style files of the code they also bind. */
export const BRAND_RULES_FIELD = "brand_rules";
export const BRAND_STYLE_FILES_FIELD = "style_files";

/** The sections of the brand platform (level 2 headings, compared without case). */
export const BRAND_SECTIONS = {
  mission: ["mission"],
  values: ["values", "valeurs"],
  personality: ["personality", "personnalité", "personnalite"],
  promise: ["promise", "promesse"],
  not: ["what the brand is not", "ce que la marque n'est pas", "la marque n'est pas"],
  voice: ["voice and tone", "voix et ton"],
  name: ["name and slogan", "nom et slogan"],
} as const satisfies Record<string, readonly string[]>;

/** One decision per section of the identity (level 2 headings). */
export const IDENTITY_SECTIONS = {
  symbol: ["symbol and logotype", "symbole et logotype"],
  palette: ["palette"],
  typography: ["typography", "typographie"],
  signature: ["signature object", "objet signature"],
  screens: ["key screens", "écrans clés", "ecrans cles"],
  rules: ["fixed rules", "règles fixes", "regles fixes"],
} as const satisfies Record<string, readonly string[]>;

/** The variants the symbol section must show, by the words that name them. */
export const IDENTITY_VARIANTS = {
  light: /\b(?:light|clair\w*)\b/i,
  dark: /\b(?:dark|sombre|fonc[eé]\w*)\b/i,
  icon: /\b(?:icon|ic[oô]ne)\b/i,
} as const;

/** The identity draws exactly this many key screens, « to settle the identity, not the journey ». */
export const IDENTITY_SCREENS = 3;

/** The columns of the table of the voice: what to say, what to avoid. */
export const BRAND_VOICE_COLUMNS = {
  say: /^(?:to say|say|à dire|a dire|dire)$/i,
  avoid: /^(?:to avoid|avoid|à éviter|a eviter|éviter|eviter)$/i,
} as const;
export const BRAND_VOICE_MIN = { rules: 3, examples: 2 } as const;
export const BRAND_NOT_MIN = 2;
export const BRAND_PROMISE_MAX = 200;

/** What the availability of a name must say: it is a lead to check, not a fact. */
export const BRAND_TO_VERIFY =
  /(?:à vérifier|a verifier|to verify|to check|unverified|non vérifié)/i;

/** The fixed rules a program can verify, and `manual` for the ones it cannot. */
export const BRAND_RULE_KINDS = [
  "reserved_color",
  "palette_only",
  "font_role",
  "font_families",
  "radius_scale",
  "no_gradient",
  "contrast",
  "manual",
] as const;
export type BrandRuleKind = (typeof BRAND_RULE_KINDS)[number];

/** AA contrast of text: 4.5, and 3 for large text. */
export const CONTRAST_AA = 4.5;
export const CONTRAST_AA_LARGE = 3;

export const BRAND_RULES_MAX = 20;
export const BRAND_STYLE_FILES_MAX = 20;
export const BRAND_FINDINGS_PER_RULE = 5;

/** The identity page is one HTML file, as small as a mock-up page. */
export const IDENTITY_PAGE_FILE = "identity.html";
export const IDENTITY_PAGE_MAX_BYTES = 60_000;
export const STYLE_FILE_MAX_BYTES = 200_000;

/** Why a problem of the brand is raised (`docs check`). */
export const BRAND_DOCUMENT_REASONS = [
  /** The header: `id`, `kind`, `owner` or `links` of the platform or of the identity. */
  "brand_header",
  /** A section missing, empty or given twice, or one that has not its shape. */
  "brand_section",
  /** The promise is not one sentence; the voice has not its rules or its two-column examples. */
  "brand_promise",
  "brand_voice",
  /** The availability of the name is not presented as a lead to check. */
  "brand_availability",
  /** A colour with no written role, or a role for no colour. */
  "identity_palette",
  /** A fixed rule that is not valid, or not written in the section of the rules. */
  "identity_rules",
  /** The identity page or a style file: missing, too big, unsafe. */
  "identity_page",
  "identity_styles",
  /** A token the UX specification defines with another value than the identity's. */
  "identity_drift",
  /** A finding of a fixed rule on a page or a style file. */
  "brand_rule",
] as const;
export type BrandDocumentReason = (typeof BRAND_DOCUMENT_REASONS)[number];
