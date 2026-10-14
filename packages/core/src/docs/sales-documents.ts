import {
  ErrorCode,
  OFFER_ID_PREFIX,
  OFFER_PRICING_STATUSES,
  OFFER_SECTIONS,
  POSITIONING_DOCUMENT_ID,
  SEQUENCE_EMAIL_TITLE,
  SEQUENCE_ID_PREFIX,
  SEQUENCE_LONG_WARNING,
  SEQUENCE_SECTIONS,
  SEQUENCE_TYPES,
} from "@agentplugged/protocol";
import { documentOwner } from "../agents/agent-aliases.js";
import { METHOD_DIR } from "../init/layout.js";
import { isRecord } from "../values.js";
import type { DocsProblem, DocsWarning } from "./docs-base.js";
import { blobIdsOf, pathKey } from "./knowledge-freshness.js";
import {
  DATE_PATTERN,
  invalid,
  isLine,
  isPositioning,
  type LaunchCheck,
  type LaunchCheckInput,
  languageProblem,
  placeholderProblems,
  positioningStatus,
  visibleText,
} from "./launch-documents.js";
import { type ParsedDocument, placeholdersOf, type Section, tableCells } from "./parse-document.js";
import { warning } from "./story-rules.js";

/**
 * The sales documents of Milo, as pure functions: the offer pages and the email
 * sequences he writes from a validated positioning. `docs check` verifies what a program can: the
 * header (id, owner, link to the positioning, the version of the positioning it was written
 * from), the goal and the audience of each document, that a price is the creator's (never an
 * invented one), that a sequence carries, for every email, its subject, its delay and its text,
 * and the stop condition, the way to opt out and the reminders before sending. Whether the
 * positioning is validated is read from the checkpoints, as for the launch documents.
 */

/** The offer pages: one file each, under this folder. */
export const OFFERS_DIR = `${METHOD_DIR}/docs/sales/offers/`;

/** The email sequences: one file each, under this folder. */
export const SEQUENCES_DIR = `${METHOD_DIR}/docs/sales/sequences/`;

/** True for an offer page. */
export function isOffer(document: ParsedDocument): boolean {
  return pathKey(document.path).startsWith(OFFERS_DIR);
}

/** True for an email sequence. */
export function isSequence(document: ParsedDocument): boolean {
  return pathKey(document.path).startsWith(SEQUENCES_DIR);
}

/** The owners a sales document may name: Milo (also under a former identifier), or the creator. */
const SALES_OWNERS: ReadonlySet<string> = new Set(["milo", "creator"]);

/** The statuses a row of the Evidence table may carry. */
const EVIDENCE_STATUSES: ReadonlySet<string> = new Set(["verified", "stated", "untrusted"]);

/** A slug: lowercase words joined by dashes. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A Git blob id: SHA-1 or SHA-256, in hexadecimal. */
const BLOB_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type Details = Record<string, unknown>;
type Kind = "offer" | "sequence";

export const realDate = (value: unknown, now: number | undefined): boolean => {
  if (typeof value !== "string") return false;
  const date = DATE_PATTERN.exec(value);
  return (
    date !== null &&
    new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])))
      .toISOString()
      .slice(0, 10) === value &&
    (now === undefined || Date.parse(`${value}T00:00:00Z`) <= now)
  );
};

/** A line with a letter or a digit in it: not blank, not invisible characters, not a dash. */
const isText = (value: unknown): value is string =>
  isLine(value) && /[\p{L}\p{N}]/u.test(value.replace(/[​-‍⁠﻿]/g, ""));

/** A subject that pretends to answer or to forward a message that was never sent. */
const FAKE_REPLY = /^\s*(?:re|fwd?|tr|rv)\s*:/i;

/** The longest wait between two emails: a year. Past it, the sequence is not a sequence. */
const DELAY_MAX_DAYS = 365;

/**
 * The Evidence table of an offer: at least one row with a known status and a source, and no row
 * with a status that is not one of the three (a claim rated `invented` is not rated).
 */
function offerEvidenceRated(section: Section): boolean {
  const rows = section.lines
    .filter((line) => line.includes("|"))
    .map((line) => tableCells(line))
    .filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell)));
  const data = rows.slice(1);
  const status = (cells: string[]) => (cells[1] ?? "").replaceAll("`", "").toLowerCase();
  return (
    data.some(
      (cells) => EVIDENCE_STATUSES.has(status(cells)) && visibleText([cells[2] ?? ""]) !== "",
    ) && data.every((cells) => EVIDENCE_STATUSES.has(status(cells)))
  );
}

/** Which problem a required section has: none, absent, given twice or empty. */
export function sectionState(
  sections: readonly Section[],
  titles: readonly string[],
): { section?: Section; problem?: "missing" | "duplicate" | "empty" } {
  const [first, second] = sections.filter((candidate) => titles.includes(candidate.title));
  if (first === undefined) return { problem: "missing" };
  if (second !== undefined) return { section: second, problem: "duplicate" };
  return visibleText(first.lines) === ""
    ? { section: first, problem: "empty" }
    : { section: first };
}

function requiredSection(
  document: ParsedDocument,
  key: string,
  titles: readonly string[],
): DocsProblem[] {
  const { section, problem } = sectionState(document.sections, titles);
  if (problem === undefined) {
    return key === "evidence" && section !== undefined && !offerEvidenceRated(section)
      ? [
          invalid(document.path, section.line, "sales_evidence", {
            section: key,
            heading: `## ${titles[0]?.replace(/^./, (letter) => letter.toUpperCase())}`,
          }),
        ]
      : [];
  }
  return [
    invalid(document.path, section?.line ?? 1, "sales_section", {
      section: key,
      problem,
      heading: `## ${titles[0]?.replace(/^./, (letter) => letter.toUpperCase())}`,
    }),
  ];
}

/** The header every sales document shares: id, kind, owner, links, language. */
function headerProblems(document: ParsedDocument, kind: Kind): DocsProblem[] {
  const { path } = document;
  const problems: DocsProblem[] = [];
  const prefix = kind === "offer" ? OFFER_ID_PREFIX : SEQUENCE_ID_PREFIX;
  if (
    document.id !== undefined &&
    !(document.id.startsWith(prefix) && SLUG_PATTERN.test(document.id.slice(prefix.length)))
  ) {
    problems.push(
      invalid(path, document.idLine, "sales_id", { field: "id", expected: `${prefix}<slug>` }),
    );
  }
  if (document.kind !== undefined && document.kind.value !== "note") {
    problems.push(
      invalid(path, document.kind.line, "sales_kind", { field: "kind", expected: "note" }),
    );
  }
  if (document.owner !== undefined && !SALES_OWNERS.has(documentOwner(document.owner.value))) {
    problems.push(
      invalid(path, document.owner.line, "sales_owner", {
        field: "owner",
        owner: document.owner.value,
      }),
    );
  }
  if (!document.links.some((link) => link.value === POSITIONING_DOCUMENT_ID)) {
    problems.push(
      invalid(path, document.links[0]?.line ?? 1, "sales_positioning_link", {
        field: "links",
        expected: POSITIONING_DOCUMENT_ID,
      }),
    );
  }
  problems.push(...languageProblem(document));
  return problems;
}

/** A field of the `sales` block that is a line of text. */
function lineField(
  path: string,
  line: number,
  fields: Record<string, unknown>,
  key: string,
): DocsProblem[] {
  return isText(fields[key]) ? [] : [invalid(path, line, "sales_field", { field: `sales.${key}` })];
}

function pricingProblems(
  path: string,
  line: number,
  value: unknown,
  now: number | undefined,
): DocsProblem[] {
  const field = (key: string) => ({ field: `sales.pricing.${key}` });
  if (!isRecord(value)) return [invalid(path, line, "sales_pricing", field("status"))];
  const status = value.status;
  if (
    typeof status !== "string" ||
    !(OFFER_PRICING_STATUSES as readonly string[]).includes(status)
  ) {
    return [invalid(path, line, "sales_pricing", field("status"))];
  }
  // A price is the creator's: its amount comes with the date of their decision, and a free or
  // unpriced offer carries none.
  if (status === "stated") {
    return [
      ...((isLine(value.amount) && /\d/.test(value.amount)) ||
      (typeof value.amount === "number" && Number.isFinite(value.amount) && value.amount >= 0)
        ? []
        : [invalid(path, line, "sales_pricing", field("amount"))]),
      ...(realDate(value.stated_on, now)
        ? []
        : [invalid(path, line, "sales_pricing", field("stated_on"))]),
    ];
  }
  const extra = ["amount", "stated_on"].find(
    (key) => value[key] !== undefined && value[key] !== null,
  );
  return extra === undefined ? [] : [invalid(path, line, "sales_pricing", field(extra))];
}

/** The subjects, delays and bodies of the emails of a sequence. */
function emailProblems(
  document: ParsedDocument,
  line: number,
  emails: unknown,
): { problems: DocsProblem[]; count: number } {
  const { path } = document;
  if (!Array.isArray(emails) || emails.length === 0) {
    return { problems: [invalid(path, line, "sales_emails", { field: "sales.emails" })], count: 0 };
  }
  const problems: DocsProblem[] = [];
  const subjects: (string | undefined)[] = [];
  emails.forEach((entry: unknown, index) => {
    const at = { index: index + 1 };
    if (!isRecord(entry) || !isText(entry.subject) || FAKE_REPLY.test(entry.subject)) {
      problems.push(
        invalid(path, line, "sales_emails", { field: `sales.emails.${index + 1}.subject`, ...at }),
      );
      subjects.push(undefined);
      return;
    }
    subjects.push(entry.subject.trim());
    // The first email goes out at the start; each other one waits at least a day after the last.
    const delay = entry.delay_days;
    const valid =
      typeof delay === "number" &&
      Number.isInteger(delay) &&
      (index === 0 ? delay === 0 : delay >= 1 && delay <= DELAY_MAX_DAYS);
    if (!valid) {
      problems.push(
        invalid(path, line, "sales_emails", {
          field: `sales.emails.${index + 1}.delay_days`,
          ...at,
        }),
      );
    }
  });
  // The body holds one section per email, in order, with the subject as written in the header.
  const bodies = document.sections.filter((section) => SEQUENCE_EMAIL_TITLE.test(section.title));
  const numbers = bodies.map((section) => Number(SEQUENCE_EMAIL_TITLE.exec(section.title)?.[1]));
  const ordered =
    numbers.length === emails.length && numbers.every((number, index) => number === index + 1);
  if (!ordered) {
    problems.push(
      invalid(path, bodies[0]?.line ?? line, "sales_email_section", {
        field: "body",
        expected: emails.length,
        found: bodies.length,
      }),
    );
    return { problems, count: emails.length };
  }
  bodies.forEach((section, index) => {
    const subject = subjects[index];
    // The line `Subject: …` repeats the header's subject, and the email says something more.
    const lines = section.lines.filter((text) => !/^\s*```/.test(text));
    const at = lines.findIndex(
      (text) =>
        /^\s*(?:subject|objet|sujet)\s*:/i.test(text) &&
        (subject === undefined || text.includes(subject)),
    );
    const rest = at === -1 ? [] : lines.filter((_, position) => position !== at);
    if (at === -1 || visibleText(rest) === "") {
      problems.push(
        invalid(path, section.line, "sales_email_section", {
          field: `body.${index + 1}`,
          index: index + 1,
          section: section.title,
        }),
      );
    }
  });
  return { problems, count: emails.length };
}

/** The strings of the `sales` block a template marker must not be left in. */
function markedTexts(fields: Record<string, unknown>): string[] {
  const texts: unknown[] = [fields.goal, fields.audience, fields.opt_out, fields.stop_condition];
  if (isRecord(fields.pricing)) texts.push(fields.pricing.amount, fields.pricing.stated_on);
  if (Array.isArray(fields.emails)) {
    for (const entry of fields.emails as unknown[]) if (isRecord(entry)) texts.push(entry.subject);
  }
  return texts.filter(isLine);
}

function salesDocumentProblems(
  document: ParsedDocument,
  kind: Kind,
  now: number | undefined,
): LaunchCheck & { blob?: string; count?: number } {
  const { path } = document;
  const problems = headerProblems(document, kind);
  const warnings: DocsWarning[] = [];
  const sales = document.sales;
  const line = sales?.line ?? 1;
  if (!isRecord(sales?.value)) {
    problems.push(invalid(path, line, "sales_missing", { field: "sales" }));
    return { problems, warnings };
  }
  const fields = sales.value;
  problems.push(
    ...lineField(path, line, fields, "goal"),
    ...lineField(path, line, fields, "audience"),
  );
  const blob = fields.positioning_blob;
  const blobOk = typeof blob === "string" && BLOB_PATTERN.test(blob);
  if (!blobOk) {
    problems.push(
      invalid(path, line, "sales_positioning_blob", { field: "sales.positioning_blob" }),
    );
  }
  let count: number | undefined;
  if (kind === "offer") {
    problems.push(...pricingProblems(path, line, fields.pricing, now));
    for (const key of Object.keys(OFFER_SECTIONS) as (keyof typeof OFFER_SECTIONS)[]) {
      problems.push(...requiredSection(document, key, OFFER_SECTIONS[key]));
    }
  } else {
    if (
      typeof fields.type !== "string" ||
      !(SEQUENCE_TYPES as readonly string[]).includes(fields.type)
    ) {
      problems.push(invalid(path, line, "sales_field", { field: "sales.type" }));
    }
    problems.push(
      ...lineField(path, line, fields, "opt_out"),
      ...lineField(path, line, fields, "stop_condition"),
    );
    const emails = emailProblems(document, line, fields.emails);
    problems.push(...emails.problems);
    count = emails.count;
    if (count > SEQUENCE_LONG_WARNING) {
      warnings.push(warning("sales_sequence_long", { path, count, max: SEQUENCE_LONG_WARNING }));
    }
    problems.push(...requiredSection(document, "before_send", SEQUENCE_SECTIONS.before_send));
  }
  // A template marker left in a field of the block: it would be sent as it is.
  for (const marker of markedTexts(fields).flatMap((text) => placeholdersOf(text))) {
    problems.push({
      code: ErrorCode.DOC_PLACEHOLDER_LEFT,
      message_key: "error.doc_placeholder_left",
      details: { path, line, marker } satisfies Details,
    });
  }
  problems.push(...placeholderProblems(document));
  return {
    problems,
    warnings,
    ...(blobOk ? { blob } : {}),
    ...(count === undefined ? {} : { count }),
  };
}

/**
 * The rules of the sales documents: each offer page and each email sequence. Warnings: a
 * sequence longer than a reader will follow, a document written while the positioning it builds on
 * is not validated, and one written from a version of the positioning that is no longer the
 * file's.
 */
export function salesDocumentChecks(input: LaunchCheckInput): LaunchCheck {
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  const positioning = input.documents.find(isPositioning);
  const positioningText = positioning === undefined ? undefined : input.textOf(positioning.path);
  const held = positioningText === undefined ? undefined : blobIdsOf(positioningText);
  const status =
    input.validations === undefined
      ? undefined
      : positioningStatus(positioningText, input.validations.checkpoints, input.validations.now);
  for (const document of input.documents) {
    const kind: Kind | undefined = isOffer(document)
      ? "offer"
      : isSequence(document)
        ? "sequence"
        : undefined;
    if (kind === undefined) continue;
    const result = salesDocumentProblems(document, kind, input.validations?.now);
    problems.push(...result.problems);
    warnings.push(...result.warnings);
    if (status !== undefined && status.state !== "validated") {
      warnings.push(
        warning("sales_positioning_not_validated", { path: document.path, state: status.state }),
      );
    }
    if (held !== undefined && result.blob !== undefined && !held.includes(result.blob)) {
      warnings.push(warning("sales_positioning_moved", { path: document.path }));
    }
  }
  return { problems, warnings };
}
