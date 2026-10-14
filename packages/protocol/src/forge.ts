/**
 * The forge of an idea and the press release, as contracts that `docs check` reads.
 *
 * The forge is a questioning conversation that ends in one of three outcomes. Its file is a note
 * of `.agentplugged/docs/ideas/`, named `forge-<slug>.md`, saved from the first answer (a short
 * log, so a stopped conversation is picked up where it stopped) and distilled at the end into a few
 * lines that the brief starts from. The press release (`prfaq`) keeps its sections; once a verdict
 * closes it, its two question lists and the verdict have a fixed shape.
 */

export const FORGE_ID_PREFIX = "forge-";

/** The kinds of concept. The same word calibrates the forge and the questions of the release. */
export const CONCEPT_TYPES = ["commercial", "internal", "open-source", "community"] as const;
export type ConceptType = (typeof CONCEPT_TYPES)[number];

/** The header key that names the concept type, in the forge file and in the press release. */
export const CONCEPT_FIELD = "concept";

/** What the idea is about: `new` (default) or `change` of a project that already has documents. */
export const FORGE_SCOPE_FIELD = "scope";
export const FORGE_SCOPES = ["new", "change"] as const;

/** The three outcomes, by the words that name them (either language of the method). */
export const FORGE_OUTCOMES = ["hardened", "killed", "clearer"] as const;
export type ForgeOutcome = (typeof FORGE_OUTCOMES)[number];
export const FORGE_OUTCOME_WORDS: Readonly<Record<ForgeOutcome, RegExp>> = {
  hardened: /^(?:hardened|durcie?)$/,
  killed: /^(?:killed|tuee?)$/,
  clearer: /^(?:clearer|clarified|clarifiee?|plus clair\w*)$/,
};

/** Sections: the idea always; each outcome has the one(s) it needs (level 2 headings). */
export const FORGE_IDEA_SECTION = ["idea", "idée", "idee"] as const;
export const FORGE_LOG_SECTION = ["log", "journal"] as const;
export const FORGE_OUTCOME_SECTIONS = {
  hardened: {
    decisions: ["decisions", "décisions"],
    rejected: ["rejected", "écartées", "ecartees", "écartés", "ecartes"],
  },
  killed: { cause: ["cause"] },
  clearer: { understood: ["clearer", "understood", "compris", "plus clair"] },
} as const satisfies Record<ForgeOutcome, Record<string, readonly string[]>>;

/** A closed file is a handoff, not a document: past this many non-empty lines it is too long. */
export const FORGE_MAX_LINES = 40;

/**
 * The types of an entry of the log, by the word between brackets that opens the line: what they
 * chose, a belief nobody has proved (a bet), a gap, a path ruled out, a point settled for good, a
 * path to follow.
 */
export const FORGE_LOG_TYPES = ["chose", "bet", "gap", "out", "fixed", "path"] as const;
export const FORGE_LOG_WORDS: Readonly<Record<(typeof FORGE_LOG_TYPES)[number], RegExp>> = {
  chose: /^(?:chose|choix|choisi\w*)$/,
  bet: /^(?:bets?|paris?)$/,
  gap: /^(?:gaps?|faille|trou)$/,
  out: /^(?:out|ecarte\w*|exclu\w*)$/,
  fixed: /^(?:fixed|acquis|tranche\w*)$/,
  path: /^(?:paths?|piste)$/,
};

/** The press release: its sections, by the titles each accepts (level 2 headings). */
export const PRFAQ_SECTIONS = {
  release: ["release", "communiqué", "communique"],
  customer: ["customer faq", "faq clients", "faq client", "faq customers"],
  internal: ["internal faq", "faq interne", "faq internes"],
  verdict: ["verdict"],
} as const satisfies Record<string, readonly string[]>;

/** Each list holds 6 to 10 questions, each tagged with its angle between brackets. */
export const PRFAQ_QUESTIONS_MIN = 6;
export const PRFAQ_QUESTIONS_MAX = 10;

/**
 * The angles of the readers' questions: why switch, is it safe, what effort, the rare case, the
 * question the team would rather not hear. And of the team's: can we build it, will it last, with
 * what means, what can go wrong, why us, and what the creator avoids saying.
 */
export const PRFAQ_CUSTOMER_ANGLES = ["switch", "safety", "effort", "rare", "dreaded"] as const;
export const PRFAQ_INTERNAL_ANGLES = [
  "build",
  "last",
  "means",
  "danger",
  "why-us",
  "avoided",
] as const;
export type PrfaqAngle = (typeof PRFAQ_CUSTOMER_ANGLES | typeof PRFAQ_INTERNAL_ANGLES)[number];

/** The words that name an angle (either language), on text without accents. */
export const PRFAQ_ANGLE_WORDS: Readonly<Record<PrfaqAngle, RegExp>> = {
  switch: /^(?:switch|changer|bascul\w*)$/,
  safety: /^(?:safety|surete|securite)$/,
  effort: /^effort$/,
  rare: /^(?:rare|exception)$/,
  dreaded: /^(?:dreaded|redout\w*)$/,
  build: /^(?:build|construire|realiser)$/,
  last: /^(?:last|durer|duree)$/,
  means: /^(?:means|moyens)$/,
  danger: /^(?:danger|peril)$/,
  "why-us": /^(?:why-?us|pourquoi-?nous)$/,
  avoided: /^(?:avoided|evit\w*)$/,
};

/** The verdict names three categories, one line each; the last two say what to do. */
export const PRFAQ_VERDICT_CATEGORIES = ["holds", "soft", "breaks"] as const;
export type PrfaqVerdictCategory = (typeof PRFAQ_VERDICT_CATEGORIES)[number];
export const PRFAQ_VERDICT_WORDS: Readonly<Record<PrfaqVerdictCategory, RegExp>> = {
  holds: /^(?:holds?|tient)$/,
  soft: /^(?:soft|fragile)$/,
  breaks: /^(?:breaks?|casse)$/,
};
/** A line of the verdict that says there is nothing in a category. */
export const PRFAQ_VERDICT_NONE = /^(?:none|nothing|aucune?|rien)\b/;
