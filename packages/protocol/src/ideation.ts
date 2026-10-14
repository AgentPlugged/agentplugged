/**
 * The file of an ideation session: Lou's note, saved from the moment the question is
 * asked and completed batch by batch, so a session that stops can be picked up where it stopped.
 * It is a note of `.agentplugged/docs/ideas/`, named `ideation-<slug>.md`; this is the contract of
 * its content, `docs check` reads it. Notes of that folder that do not follow this name keep the
 * free form they had.
 */

export const IDEATION_ID_PREFIX = "ideation-";

/** Sections that every session holds, and the titles each one accepts (level 2 headings). */
export const IDEATION_SECTIONS = {
  question: ["question"],
} as const satisfies Record<string, readonly string[]>;

/** Sections that a session holds once it is finished (no `Next step:` line any more). */
export const IDEATION_DONE_SECTIONS = {
  ideas: ["ideas", "idées", "idees"],
  mirror: ["mirror", "miroir"],
  kept: ["kept", "retenu", "retenues", "gardées", "gardees"],
} as const satisfies Record<string, readonly string[]>;

/** The optional section of the convergence, where the moves are named. */
export const IDEATION_CONVERGENCE = ["convergence"] as const;

/**
 * The three stances, chosen once at the start. `questions`: Lou only asks, every idea is the
 * creator's. `exchange`: they trade ideas, each one marked with who had it. `proposal`: Lou opens
 * with a first list, then the creator reacts and adds theirs.
 */
export const IDEATION_STANCES = ["questions", "exchange", "proposal"] as const;
export type IdeationStance = (typeof IDEATION_STANCES)[number];

/** The words that name a stance, in either language of the method. */
export const IDEATION_STANCE_WORDS: Readonly<Record<IdeationStance, RegExp>> = {
  questions: /^(?:questions?|facilitat\w*|interrogat\w*)$/,
  exchange: /^(?:exchange|[eé]change|partner|partenaire)$/,
  proposal: /^(?:proposal|proposition|propos[ée]e?s?)$/,
};

/** Who had an idea: the mark at the start of each idea of the session. */
export const IDEATION_AUTHOR_MARK = /^\[\s*(creator|cr[ée]ateur|lou)\s*\]\s*/i;

/** The gestures an idea kept may lead to (the creator chooses; `later` leaves it open). */
export const IDEATION_GESTURES = ["hypothesis", "story", "decision", "nothing", "later"] as const;

/**
 * The words that name a gesture, in either language of the method, read from the start of what
 * follows the arrow (a short comment after the word is fine) on text with no accent.
 */
export const IDEATION_GESTURE_WORDS: Readonly<Record<(typeof IDEATION_GESTURES)[number], RegExp>> =
  {
    hypothesis: /^(?:hypothesis|hypothese)\b/,
    story: /^(?:stor(?:y|ies)|histoire)\b/,
    decision: /^decision\b/,
    nothing: /^(?:nothing|none|rien|aucune?)\b/,
    later: /^(?:later|plus tard|ouverte?|open)\b/,
  };

/** The six moves of the convergence, by the words that name them; a session chains two at most. */
export const IDEATION_MOVES: Readonly<Record<string, RegExp>> = {
  group: /\b(?:group\w*|cluster\w*|regroup\w*|affinit\w*|themes?|th[eè]mes?)\b/,
  impact_effort: /\bimpact\b/,
  nuf: /\bnuf\b|\bnew\b.*\buseful\b|\bnouveau\b.*\butile\b/,
  ranking: /\b(?:rank\w*|classe\w*|classement|vote|dot|priorit\w*|hierarch\w*)\b/,
  pmi: /\bpmi\b|\bplus\b.*\bminus\b|\bplus\b.*\bmoins\b/,
  moscow: /\bmoscow\b|\bmust\b.*\bshould\b|\bdoit\b.*\bdevrait\b|\bindispensable\b|\bsouhaitable\b/,
};
export const IDEATION_MOVES_MAX = 2;
