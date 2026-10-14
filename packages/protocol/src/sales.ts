/**
 * The sales documents of Milo: the offer pages and the email sequences he writes
 * from a validated positioning. The folders and the file names are core's; this is the contract
 * of their content, read by `docs check` through `LAUNCH_DOCUMENT_INVALID`.
 */

/** The header field that holds the sales fields of an offer page or of an email sequence. */
export const SALES_FIELD = "sales";

/** The id prefixes of the two kinds of sales document: `offer-<slug>` and `sequence-<slug>`. */
export const OFFER_ID_PREFIX = "offer-";
export const SEQUENCE_ID_PREFIX = "sequence-";

/**
 * What an offer page says about its price. `free`: the product costs nothing. `stated`: the
 * creator decided the price (the `amount`, with the date `stated_on` of their decision). `none`:
 * the page names no price. A price is never anything else: Milo invents none.
 */
export const OFFER_PRICING_STATUSES = ["free", "stated", "none"] as const;
export type OfferPricingStatus = (typeof OFFER_PRICING_STATUSES)[number];

/** The goal of a sequence: reach people who do not know the product yet, or follow up on a contact. */
export const SEQUENCE_TYPES = ["prospecting", "follow_up"] as const;
export type SequenceType = (typeof SEQUENCE_TYPES)[number];

/**
 * The sections of an offer page and of an email sequence (level 2 headings), and the titles each
 * one accepts, compared without case: the creator's language is French or English.
 */
export const OFFER_SECTIONS = {
  text: ["text", "texte"],
  evidence: ["evidence", "proof", "preuves", "preuve"],
} as const satisfies Record<string, readonly string[]>;
export const SEQUENCE_SECTIONS = {
  before_send: ["before you send", "avant l'envoi", "avant l’envoi"],
} as const satisfies Record<string, readonly string[]>;
export type SalesSection = keyof typeof OFFER_SECTIONS | keyof typeof SEQUENCE_SECTIONS;

/** The title of the section of one email: `Email 1`, `Courriel 2`, in the creator's language. */
export const SEQUENCE_EMAIL_TITLE = /^(?:e-?mail|courriel|message) (\d{1,3})$/;

/** A sequence longer than this many emails is a warning: nobody reads a ten-message chase. */
export const SEQUENCE_LONG_WARNING = 7;
