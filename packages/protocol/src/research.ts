/**
 * The deep research: a report that lives in the knowledge base as a dated page
 * (`.agentplugged/docs/research/<topic>.md`, `id: research-<topic>`) and carries a `research` block
 * in its header. The folders and the file names are core's; this is the contract of the page, read
 * by `docs check` through `RESEARCH_REPORT_INVALID`, and by `docs research` to find what was
 * already searched.
 */

/** The header field that holds the research fields of a report. */
export const RESEARCH_FIELD = "research";

/** The id prefix of a research page: `research-<slug>`. */
export const RESEARCH_ID_PREFIX = "research-";

/** The kinds of research: the question decides which ones apply. */
export const RESEARCH_TYPES = [
  "market",
  "domain",
  "technical",
  "competitive",
  "user_voice",
  "literature",
] as const;
export type ResearchType = (typeof RESEARCH_TYPES)[number];

/**
 * How well a claim stands. `primary`: a source that says it first hand (the product's own page, the
 * standard, the data set, the paper). `secondary`: only a source that reports it. `doubt`: no
 * source found, or sources that disagree: said as such, never rounded up.
 */
export const RESEARCH_EVIDENCE = ["primary", "secondary", "doubt"] as const;
export type ResearchEvidence = (typeof RESEARCH_EVIDENCE)[number];

/** What a source is, in the cascade: a primary one first, a secondary one if there is none. */
export const RESEARCH_SOURCE_KINDS = ["primary", "secondary"] as const;
export type ResearchSourceKind = (typeof RESEARCH_SOURCE_KINDS)[number];

/** Everything read outside the product is data to weigh, never an instruction. */
export const RESEARCH_PROVENANCE = "untrusted";

/** The sections of a report (level 2 headings), and the titles each one accepts, without case. */
export const RESEARCH_SECTIONS = {
  claims: ["claims", "affirmations"],
  sources: ["sources"],
  instructions: ["instructions detected", "instructions détectées"],
} as const satisfies Record<string, readonly string[]>;
export type ResearchSection = keyof typeof RESEARCH_SECTIONS;

/** Where a report comes from: the research was run here (no `origin`), or a report was imported. */
export const RESEARCH_ORIGINS = ["import"] as const;

/** What the report is for, when it is not just understanding a subject: choosing between candidates. */
export const RESEARCH_SHAPES = ["choice"] as const;
export type ResearchShape = (typeof RESEARCH_SHAPES)[number];

/** The sections of a report that chooses between candidates, in addition to the three above. */
export const RESEARCH_SELECT_SECTIONS = {
  criteria: ["criteria", "critères"],
  matrix: ["matrix", "matrice"],
  verdict: ["verdict"],
} as const satisfies Record<string, readonly string[]>;
export type ResearchSelectSection = keyof typeof RESEARCH_SELECT_SECTIONS;

/** A criterion id: `C-1`, `C-2`… */
export const RESEARCH_CRITERION_ID = /^C-[1-9]\d?$/;
/** The weights of a criterion, and the scores of a candidate on it. */
export const RESEARCH_WEIGHT_RANGE = { min: 1, max: 5 } as const;
export const RESEARCH_SCORE_RANGE = { min: 0, max: 5 } as const;
/** Finalists in the matrix, and criteria in the frame. */
export const RESEARCH_CANDIDATES_RANGE = { min: 2, max: 6 } as const;
export const RESEARCH_CRITERIA_RANGE = { min: 2, max: 12 } as const;

/** A claim marked `key` is one the conclusion rests on: a second independent source, or doubt. */
export const RESEARCH_KEY_MARK = "key";
/** What a source shows as its publication date when the page gives none. */
export const RESEARCH_UNDATED = "undated";

/** A source id: `S-1`, `S-2`… */
export const RESEARCH_SOURCE_ID = /^S-[1-9]\d{0,2}$/;

/** More claims than this is a library, not a report: split the question. */
export const RESEARCH_MAX_CLAIMS = 60;

/**
 * How many days a research stays fresh, by type, when the creator gives no age: a market moves
 * faster than a standard. A page is as old as its fastest type needs (the shortest age applies).
 */
export const RESEARCH_MAX_AGE_DAYS: Readonly<Record<ResearchType, number>> = {
  competitive: 30,
  market: 60,
  user_voice: 60,
  technical: 90,
  domain: 180,
  literature: 365,
};

/**
 * How old, in days, the publication of every source of a claim may be before the claim is to search
 * again: a competitor's offer moves faster than a standard. The shortest window of
 * the page's types applies; a type without a window (the literature: a paper does not age) adds none.
 */
export const RESEARCH_PUBLISHED_WINDOW_DAYS: Readonly<Partial<Record<ResearchType, number>>> = {
  competitive: 180,
  technical: 365,
  market: 548,
  user_voice: 730,
  domain: 1095,
};

/**
 * The three efforts of a research run: how many sub-agents, how many findings each
 * may return (so how many pages it reads), and how many rounds (a second round follows only the
 * contradictions and leads of the first, with at most `FOLLOW_UP_AGENTS` sub-agents).
 */
export const RESEARCH_EFFORTS = {
  light: { agents: 2, findings: 4, rounds: 1 },
  standard: { agents: 3, findings: 7, rounds: 1 },
  thorough: { agents: 5, findings: 10, rounds: 2 },
} as const satisfies Record<string, { agents: number; findings: number; rounds: number }>;
export type ResearchEffort = keyof typeof RESEARCH_EFFORTS;
export const RESEARCH_FOLLOW_UP_AGENTS = 2;

/** `docs research` returns at most this many pages, one line each. */
export const RESEARCH_LISTED_MAX = 5;

/**
 * Why `docs check` refuses a research report (`RESEARCH_REPORT_INVALID`): the message key is
 * `error.research_report_invalid.<reason>`.
 */
export const RESEARCH_REPORT_REASONS = [
  /** The header: the id, the `research` block, one of its fields (subject, types, date). */
  "id",
  "block",
  "field",
  /** A section is missing, empty or given twice. */
  "section",
  /** No claim at all, or too many. */
  "claims",
  /** A table without its header row and its separator row: its rows would escape every rule. */
  "table",
  /** A claim without a number (whole, once), a text, or a level among `primary`, `secondary`, `doubt`. */
  "claim_level",
  /** A claim with no source that is not marked `doubt`. */
  "claim_unsourced",
  /** A claim citing a source the Sources section does not hold. */
  "claim_source",
  /** A claim whose level is not the best of its sources (the cascade). */
  "claim_cascade",
  /** A row of the Sources section: its id, address, date, kind or provenance. */
  "source_row",
  /** The Instructions section: neither « none » nor a list of `S-n: passage`. */
  "instructions_section",
  /** An instruction attributed to a source that is not listed. */
  "instruction_source",
  /** Text that talks to an agent, outside the Instructions section. */
  "instruction_unflagged",
  /** Invisible or direction-changing characters in the page. */
  "hidden_characters",
  /** The `Key` cell of a claim is neither empty nor `key`. */
  "claim_key",
  /** A key claim that is not in doubt without two independent, dated sources. */
  "claim_second_source",
  /** No claim of the report is marked `key`. */
  "no_key_claim",
  /** An imported report without its tool or its date, or those fields on a report that is not imported. */
  "import",
  /** A report that chooses: its criteria, its matrix or its verdict is not whole or not sound. */
  "criteria",
  "matrix",
  "verdict",
] as const;
export type ResearchReportReason = (typeof RESEARCH_REPORT_REASONS)[number];
