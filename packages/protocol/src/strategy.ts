/**
 * The documents of problem solving and of innovation strategy: a problem worked
 * through to a plan (Lou), a strategy and its business model built from the costs of the product
 * (Iris). They are notes of `.agentplugged/docs/strategy/`, validated like the other deliverables;
 * this is the contract of their content, `docs check` reads it.
 */

/** A problem analysis is `problem-<slug>`, an innovation strategy `innovation-<slug>`. */
export const PROBLEM_ID_PREFIX = "problem-";
export const INNOVATION_ID_PREFIX = "innovation-";

/** Sections of a problem analysis (level 2 headings), and the titles each one accepts. */
export const PROBLEM_SECTIONS = {
  problem: ["problem", "problème", "probleme"],
  boundaries: ["boundaries", "limites", "périmètre", "perimetre"],
  causes: ["causes", "root cause", "root causes", "cause racine", "causes racines"],
  forces: ["forces", "constraints", "contraintes"],
  options: ["options", "solutions"],
  choice: ["choice", "recommendation", "choix", "recommandation"],
  plan: ["plan", "action plan", "plan d'action"],
  checks: ["checks", "monitoring", "validation", "suivi", "contrôles", "controles"],
} as const satisfies Record<string, readonly string[]>;

/** Sections of an innovation strategy. */
export const INNOVATION_SECTIONS = {
  context: ["context", "contexte"],
  market: ["market", "marché", "marche"],
  model: ["model", "business model", "modèle", "modele", "modèle économique"],
  openings: ["openings", "disruption", "ruptures", "opportunités", "opportunites"],
  options: ["options"],
  direction: ["direction", "recommendation", "recommandation"],
  economics: ["economics", "costs", "coûts", "couts", "économie", "economie"],
  roadmap: ["roadmap", "feuille de route"],
  risks: ["risks", "metrics", "risques", "indicateurs", "metrics and risks"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Where a cost in the economics table comes from. The method knows two: an estimate (what the
 * engine writes in the journal, said as an estimate) and a declaration (what the creator states:
 * hosting, a domain, a tool). A cost the engine measured is never shown here: it stays in the
 * journal.
 */
export const COST_BASES = ["estimated", "declared"] as const;
export type CostBasis = (typeof COST_BASES)[number];

/** A cell that says a cost is estimated or declared, in either language. */
export const COST_BASIS_CELL =
  /^(?:\*\*)?\s*(estimated?|estimation|estim[ée]e?s?|estimatif|estimative|declared|d[ée]clar[ée]e?s?)\s*(?:\*\*)?$/i;

/**
 * What marks a cost as measured, actual or real: refused in the economics of the method. Read
 * on text with no accent, mark, invisible character, emphasis or capital letter (`plainWording`).
 */
export const COST_REAL_WORDING =
  /\b(?:real|actual|measured)\s+(?:costs?|spend(?:ing)?|spent)\b|\bactually\s+spent\b|\bcouts?\s+(?:reel|mesure|effectif|constate|depense)\w*|\bdepenses?\s+reel\w*|\breellement\s+(?:depens|consomm)\w*|\b(?:estimated|estime\w*)\s*(?:[/|]|vs\.?|versus|contre)\s*(?:real|actual|reel|mesure)\w*|\b(?:real|actual|reel|mesure)\w*\s*(?:[/|]|vs\.?|versus|contre)\s*(?:estimated|estime\w*)\b/;

/** A word that names a cost basis the method does not show, in a cell (same plain text). */
export const COST_REAL_CELL =
  /\b(?:real|reel\w*|actual|actually|measured|mesure\w*|effectif\w*|constate\w*)\b/;

/** The text as the patterns above read it. */
export function plainWording(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\p{M}\u200b-\u200f\u2060\ufeff\u00ad]/gu, "")
    .replace(/[*_`~]/g, "")
    .toLowerCase();
}

/** The line of the economics that states the break-even point. */
export const BREAK_EVEN_LINE = /(?:break[- ]?even|seuil de rentabilit[ée]|point mort)/i;
