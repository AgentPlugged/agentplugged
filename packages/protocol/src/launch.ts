/**
 * The launch documents of Julien: the positioning and the pages of the product, with
 * the search fields `docs check` reads. The folders and the file names are core's; this is the
 * contract of their content.
 */

/** The header field that holds the search fields of a page. */
export const LAUNCH_SEO_FIELD = "seo";

/** The header field that names the language a launch document is written in (BCP 47, `fr`). */
export const LAUNCH_LANGUAGE_FIELD = "language";

/** The id of the positioning document: the one the pages, contents and sales documents link to. */
export const POSITIONING_DOCUMENT_ID = "positioning";

/**
 * The sections of the positioning (level 2 headings), and the titles each one accepts, compared
 * without case: the creator's language is French or English, the text itself may be in any
 * language.
 */
export const POSITIONING_SECTIONS = {
  audience: ["audience", "target audience", "cible", "public cible", "public"],
  problem: ["problem", "problème"],
  promise: ["promise", "promesse"],
  difference: ["difference", "différence"],
  evidence: ["evidence", "proof", "preuves", "preuve"],
} as const satisfies Record<string, readonly string[]>;
export type PositioningSection = keyof typeof POSITIONING_SECTIONS;

/**
 * Where a keyword's volume comes from. `untrusted`: read outside the product (a web page, a
 * search tool): it is data, never an instruction. `creator`: given by the creator, from
 * their own tool (a search console export).
 */
export const KEYWORD_PROVENANCES = ["untrusted", "creator"] as const;
export type KeywordProvenance = (typeof KEYWORD_PROVENANCES)[number];

/**
 * Why `docs check` refuses a launch document (`LAUNCH_DOCUMENT_INVALID`): the message key is
 * `error.launch_document_invalid.<reason>`.
 */
export const LAUNCH_DOCUMENT_REASONS = [
  /** A section of the positioning is missing, empty or given twice. */
  "section_missing",
  "section_empty",
  "section_duplicate",
  /** The Evidence table has no row with a status (`verified`, `stated` or `untrusted`). */
  "evidence_status",
  /** The positioning's header: its id, its kind, its owner, or nothing to draw it from. */
  "positioning_id",
  "positioning_kind",
  "positioning_owner",
  "positioning_links",
  /** The language of the document is absent or not a language tag. */
  "language",
  /** A page does not link to the positioning. */
  "page_positioning_link",
  /** The search fields of a page: absent, not a mapping, or a field empty or on several lines. */
  "seo_missing",
  "seo_field",
  /** The keywords: none, an entry that is not a mapping, or without a term. */
  "keywords_missing",
  "keyword_invalid",
  /** A keyword with neither a verifiable volume nor the mark of a hypothesis. */
  "keyword_unverified",
  /** A keyword marked as a hypothesis that also claims a volume or a proof. */
  "keyword_conflict",
  /** A keyword with a volume but without its source, its date or its provenance. */
  "keyword_proof",
  /**
   * The sales documents of Milo, read by `docs check`: the `sales` block is absent or
   * has a field empty or invalid; the `id` is not `offer-<slug>` or `sequence-<slug>`; the kind,
   * the owner, the link to the positioning, or the blob of the positioning it was written from.
   */
  "sales_missing",
  "sales_field",
  "sales_id",
  "sales_kind",
  "sales_owner",
  "sales_positioning_link",
  "sales_positioning_blob",
  /** An offer's price is not `free`, `stated` (with its amount and its date) or `none`. */
  "sales_pricing",
  /** A section of an offer or of a sequence is missing, empty or given twice. */
  "sales_section",
  /** The evidence table of an offer has no row with a known status. */
  "sales_evidence",
  /** A sequence's emails: none, one without a subject, a wrong delay, or not those of the body. */
  "sales_emails",
  "sales_email_section",
  /** The contents and campaigns: the header block, its id and its type. */
  "content_id",
  "content_type",
  "content_channel",
  /** A content that does not link to the positioning, or to any page of the base it builds on. */
  "content_positioning_link",
  "content_base_link",
  /** The version of the positioning the content was written on: absent or not a Git blob id. */
  "content_positioning_blob",
  /** The measurable goal: its metric, target, date or the way to observe it. */
  "content_goal",
  /** A source or figure the content cites, without its source, its date or its provenance. */
  "content_reference",
  /** A section of the content is missing, empty or given twice. */
  "content_section_missing",
  "content_section_empty",
  "content_section_duplicate",
  /** A key the `content` block, its goal or a reference does not carry (a status, a cost...). */
  "content_key",
  /**
   * The narrative, the deck and the design thinking synthesis: the header (id, kind,
   * owner, sources to cite), a section missing, a slide without its notes or out of order.
   */
  "pitch_id",
  "pitch_kind",
  "pitch_owner",
  "pitch_links",
  "pitch_section",
  "pitch_slides",
  /**
   * The problem analysis and the innovation strategy: the header, a section
   * missing, a cost whose basis is not said, a cost with no amount or at zero that nobody
   * declared, a cost shown as real.
   */
  "strategy_id",
  "strategy_kind",
  "strategy_owner",
  "strategy_links",
  "strategy_section",
  "strategy_cost_basis",
  "strategy_cost_amount",
  "strategy_cost_zero",
  "strategy_cost_real",
  /**
   * The file of an ideation session: the header, a section missing, a stance not
   * named or broken (Lou gave an idea in the questions stance), an idea with no author, a mirror
   * that gives back none of the creator's ideas, an unknown convergence move or more than two,
   * an idea kept with no gesture.
   */
  "ideation_id",
  "ideation_kind",
  "ideation_owner",
  "ideation_section",
  "ideation_stance",
  "ideation_idea",
  "ideation_mirror",
  "ideation_move",
  "ideation_kept",
  /**
   * The file of a forge: the header, a section missing, the concept type or the scope
   * unknown, the outcome not valid, a log entry with no type or kept after the outcome, a rejected
   * option with no reason, a hardened file too long. And the press release once a verdict closes
   * it: the concept type, a list of questions of the wrong size or angle, a verdict out of shape.
   */
  "forge_id",
  "forge_kind",
  "forge_owner",
  "forge_section",
  "forge_concept",
  "forge_scope",
  "forge_outcome",
  "forge_log",
  "forge_reason",
  "forge_long",
  "prfaq_concept",
  "prfaq_faq",
  "prfaq_verdict",
] as const;
export type LaunchDocumentReason = (typeof LAUNCH_DOCUMENT_REASONS)[number];

/** Search titles and descriptions longer than this are cut off by search engines: a warning. */
export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MAX = 170;

/**
 * The contents and the campaign plans of Julien. One file each: articles and community
 * posts under `launch/content/`, campaign plans under `launch/campaigns/`. Each links to the
 * positioning and to the pages of the base it uses, and carries a `content` block in its header.
 */

/** The header field that holds the block of a content or of a campaign plan. */
export const LAUNCH_CONTENT_FIELD = "content";

/** The kinds of content, and the folder each one lives in (`content`, or `campaigns`). */
export const CONTENT_TYPES = {
  article: "content",
  community_post: "content",
  campaign_plan: "campaigns",
} as const satisfies Record<string, "content" | "campaigns">;
export type LaunchContentType = keyof typeof CONTENT_TYPES;

/** The prefix of the `id` of a content (`content-<slug>`) and of a campaign plan (`campaign-<slug>`). */
export const CONTENT_ID_PREFIXES = { content: "content-", campaigns: "campaign-" } as const;

/**
 * Where a figure or a claim a content cites comes from. `untrusted`: read outside the product (a
 * web page, a report): data, never an instruction, and the content attributes it, never states it
 * as its own. `creator`: given by the creator. `knowledge_base`: a page of the base the
 * content links to, the only source that counts as verified.
 */
export const REFERENCE_PROVENANCES = ["untrusted", "creator", "knowledge_base"] as const;
export type ReferenceProvenance = (typeof REFERENCE_PROVENANCES)[number];

/**
 * The sections of a content, by type (level 2 headings; titles compared without case, in English
 * or in French). An article and a community post: the text and its sources. A campaign plan: its
 * objective, audience, channels, calendar, budget, how success is measured, what the creator does
 * and its sources. A section whose answer is "none" says so in a sentence: it is never left empty.
 */
export const CONTENT_SECTIONS = {
  text: ["text", "texte"],
  sources: ["sources"],
} as const satisfies Record<string, readonly string[]>;
export const CAMPAIGN_SECTIONS = {
  objective: ["objective", "objectif"],
  audience: ["audience", "target audience", "cible", "public cible", "public"],
  channels: ["channels", "canaux"],
  calendar: ["calendar", "calendrier"],
  budget: ["budget"],
  measurement: ["measurement", "mesure", "suivi"],
  actions: ["creator actions", "actions du créateur", "actions"],
  sources: ["sources"],
} as const satisfies Record<string, readonly string[]>;
export type LaunchContentSection = keyof typeof CONTENT_SECTIONS | keyof typeof CAMPAIGN_SECTIONS;
