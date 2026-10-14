import { gitBlobId, utf8 } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  checkDocumentsDetailed,
  type DocumentFile,
  OFFERS_DIR,
  POSITIONING_PATH,
  SEQUENCES_DIR,
} from "../index.js";
import { answered } from "../testing/checkpoint-state.js";

/** `docs check` on the offer pages and the email sequences of Milo. */

const OFFER = `${OFFERS_DIR}starter.md`;
const SEQUENCE = `${SEQUENCES_DIR}launch.md`;
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

const KB = `---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n`;

const EVIDENCE =
  "| Claim | Status | Source |\n| --- | --- | --- |\n| It syncs | verified | kb-index |\n";
const POSITIONING_TEXT = `---\nid: positioning\nkind: note\nowner: julien\nlinks: [kb-index]\nlanguage: en\n---\n# Positioning\n\n${[
  "Audience",
  "Problem",
  "Promise",
  "Difference",
]
  .map((title) => `## ${title}\n\nSomething true about it.\n`)
  .join("\n")}\n## Evidence\n\n${EVIDENCE}`;
const BLOB = gitBlobId(utf8(POSITIONING_TEXT), "sha1");

const OFFER_BODY = `# Offer\n\n## Text\n\nWhat you get.\n\n## Evidence\n\n${EVIDENCE}`;

function offer(
  options: { sales?: string; header?: string; body?: string; pricing?: string } = {},
): string {
  const pricing = options.pricing ?? "  pricing:\n    status: none\n";
  const sales =
    options.sales ??
    `sales:\n  goal: "Start a trial"\n  audience: "Solo makers"\n  positioning_blob: ${BLOB}\n${pricing}`;
  const header =
    options.header ??
    "id: offer-starter\nkind: note\nowner: milo\nlinks: [positioning]\nlanguage: en";
  return `---\n${header}\n${sales}---\n${options.body ?? OFFER_BODY}`;
}

const EMAILS = [
  { subject: "A quick question", delay: 0 },
  { subject: "Did you see my note?", delay: 3 },
];

function sequence(
  options: {
    emails?: { subject: string; delay: number }[];
    sales?: string;
    header?: string;
    body?: string;
    extra?: string;
  } = {},
): string {
  const emails = options.emails ?? EMAILS;
  const list = emails
    .map((email) => `    - subject: "${email.subject}"\n      delay_days: ${email.delay}\n`)
    .join("");
  const sales =
    options.sales ??
    `sales:\n  type: prospecting\n  goal: "Book a call"\n  audience: "Solo makers"\n  positioning_blob: ${BLOB}\n  opt_out: "An unsubscribe link in each email"\n  stop_condition: "A reply or an opt-out"\n  emails:\n${list}${options.extra ?? ""}`;
  const header =
    options.header ??
    "id: sequence-launch\nkind: note\nowner: milo\nlinks: [positioning]\nlanguage: en";
  const body =
    options.body ??
    `# Sequence\n\n${emails
      .map((email, index) => `## Email ${index + 1}\n\nSubject: ${email.subject}\n\nHello.\n`)
      .join("\n")}\n## Before you send\n\n- Check that you may write to them.\n`;
  return `---\n${header}\n${sales}---\n${body}`;
}

function check(files: Record<string, string>, checkpoints: ReturnType<typeof answered>[] = []) {
  const current: DocumentFile[] = Object.entries({
    ".agentplugged/docs/index.md": KB,
    [POSITIONING_PATH]: POSITIONING_TEXT,
    ...files,
  }).map(([path, text]) => ({ path, text }));
  return checkDocumentsDetailed({
    current,
    owners: new Set(["julien", "milo", "zoe"]),
    validations: { checkpoints, now: NOW },
  });
}

const salesProblems = (result: ReturnType<typeof check>) =>
  result.problems.filter((problem) => problem.code === ErrorCode.LAUNCH_DOCUMENT_INVALID);
const reasons = (result: ReturnType<typeof check>) =>
  salesProblems(result).map((problem) => problem.details.reason);
const warnings = (result: ReturnType<typeof check>) => result.warnings.map((entry) => entry.reason);

const approval = [
  answered("G-POS", "approved", "2026-10-03T02:00:00.000Z", [[POSITIONING_PATH, BLOB]], {
    type: "publication",
    opened_by: "julien",
  }),
];

describe("docs check: the offer pages", () => {
  it("accepts an offer with its header and its sections", () => {
    expect(check({ [OFFER]: offer() }, approval)).toMatchObject({ problems: [], warnings: [] });
  });

  it("leaves the other sales material alone", () => {
    const buyers =
      "---\nid: buyers\nkind: note\nowner: milo\nlinks: [positioning]\n---\n# Buyers\n";
    expect(check({ ".agentplugged/docs/sales/buyers.md": buyers }, approval).problems).toEqual([]);
  });

  it("refuses a header that is not Milo's offer", () => {
    const header = "id: starter\nkind: epic\nowner: sam\nlinks: [kb-index]";
    const result = check({ [OFFER]: offer({ header }) }, approval);
    expect(reasons(result)).toEqual(
      expect.arrayContaining(["sales_id", "sales_owner", "sales_positioning_link", "language"]),
    );
    expect(salesProblems(result)[0]?.message_key).toMatch(/^error\.launch_document_invalid\./);
  });

  it("accepts the creator as owner and a language other than English", () => {
    const header =
      "id: offer-pro\nkind: note\nowner: creator\nlinks: [positioning]\nlanguage: pt-BR";
    expect(check({ [OFFER]: offer({ header }) }, approval).problems).toEqual([]);
  });

  it("refuses an offer without its sales block, goal, audience or version of the positioning", () => {
    expect(reasons(check({ [OFFER]: offer({ sales: "" }) }, approval))).toEqual(["sales_missing"]);
    const sales = 'sales:\n  goal: ""\n  positioning_blob: nope\n  pricing:\n    status: none\n';
    const result = check({ [OFFER]: offer({ sales }) }, approval);
    expect(
      salesProblems(result).map((problem) => [problem.details.reason, problem.details.field]),
    ).toEqual([
      ["sales_field", "sales.goal"],
      ["sales_field", "sales.audience"],
      ["sales_positioning_blob", "sales.positioning_blob"],
    ]);
  });

  it("never lets an agent invent a price: free, none, or the creator's, with its date", () => {
    const priced = (lines: string) => check({ [OFFER]: offer({ pricing: lines }) }, approval);
    expect(priced("  pricing:\n    status: free\n").problems).toEqual([]);
    expect(
      priced(
        "  pricing:\n    status: stated\n    amount: 29 EUR per month\n    stated_on: 2026-10-03\n",
      ).problems,
    ).toEqual([]);
    // No price block, an unknown status, a price without its amount or its date, a future date.
    expect(reasons(priced(""))).toEqual(["sales_pricing"]);
    expect(reasons(priced("  pricing:\n    status: cheap\n"))).toEqual(["sales_pricing"]);
    expect(reasons(priced("  pricing:\n    status: stated\n"))).toEqual([
      "sales_pricing",
      "sales_pricing",
    ]);
    expect(
      reasons(priced("  pricing:\n    status: stated\n    amount: 9\n    stated_on: 2027-01-01\n")),
    ).toEqual(["sales_pricing"]);
    expect(
      reasons(priced("  pricing:\n    status: stated\n    amount: 9\n    stated_on: 2026-02-30\n")),
    ).toEqual(["sales_pricing"]);
    // A free or unpriced offer that still carries an amount is refused.
    const conflict = priced("  pricing:\n    status: free\n    amount: 5 EUR\n");
    expect(salesProblems(conflict).map((problem) => problem.details.field)).toEqual([
      "sales.pricing.amount",
    ]);
  });

  it("requires the text and an evidence table with a known status", () => {
    const missing = "# Offer\n\n## Text\n\n\n";
    const result = check({ [OFFER]: offer({ body: missing }) }, approval);
    expect(
      salesProblems(result).map((problem) => [problem.details.reason, problem.details.problem]),
    ).toEqual([
      ["sales_section", "missing"],
      ["sales_section", "empty"],
    ]);
    const unrated =
      "# Offer\n\n## Texte\n\nOk.\n\n## Preuves\n\n| Claim | Status |\n| --- | --- |\n| x | maybe |\n";
    expect(reasons(check({ [OFFER]: offer({ body: unrated }) }, approval))).toEqual([
      "sales_evidence",
    ]);
    const twice = `${OFFER_BODY}\n## Text\n\nAgain.\n`;
    expect(
      salesProblems(check({ [OFFER]: offer({ body: twice }) }, approval)).map(
        (problem) => problem.details.problem,
      ),
    ).toEqual(["duplicate"]);
  });

  it("refuses a marker of the template, in a field or in the body", () => {
    const sales = `sales:\n  goal: "<the one action>"\n  audience: "Solo makers"\n  positioning_blob: ${BLOB}\n  pricing:\n    status: none\n`;
    const result = check(
      { [OFFER]: offer({ sales, body: `${OFFER_BODY}\n<what is included>\n` }) },
      approval,
    );
    expect(result.problems.map((problem) => problem.code)).toEqual([
      ErrorCode.DOC_PLACEHOLDER_LEFT,
      ErrorCode.DOC_PLACEHOLDER_LEFT,
    ]);
  });

  it("handles several offers, one file each", () => {
    const second = offer({
      header: "id: offer-pro\nkind: note\nowner: milo\nlinks: [positioning]\nlanguage: en",
    });
    const result = check({ [OFFER]: offer(), [`${OFFERS_DIR}pro.md`]: second }, approval);
    expect(result.problems).toEqual([]);
  });
});

describe("docs check: the email sequences", () => {
  it("accepts a sequence with its emails, its opt-out, its stop condition and its reminders", () => {
    expect(check({ [SEQUENCE]: sequence() }, approval)).toMatchObject({
      problems: [],
      warnings: [],
    });
  });

  it("refuses a sequence without its type, opt-out or stop condition", () => {
    const sales = `sales:\n  type: spam\n  goal: "Book a call"\n  audience: "Solo makers"\n  positioning_blob: ${BLOB}\n  emails:\n    - subject: "A quick question"\n      delay_days: 0\n`;
    const body = `# S\n\n## Email 1\n\nSubject: A quick question\n\nHi.\n\n## Before you send\n\n- Check.\n`;
    const result = check({ [SEQUENCE]: sequence({ sales, body }) }, approval);
    expect(salesProblems(result).map((problem) => problem.details.field)).toEqual([
      "sales.type",
      "sales.opt_out",
      "sales.stop_condition",
    ]);
  });

  it("refuses emails without a subject, with a wrong delay, or none at all", () => {
    const wrong = sequence({
      emails: [
        { subject: "First", delay: 2 },
        { subject: "Second", delay: 0 },
        { subject: "Third", delay: 1.5 },
      ],
    });
    const result = check({ [SEQUENCE]: wrong }, approval);
    expect(
      salesProblems(result).map((problem) => [problem.details.reason, problem.details.field]),
    ).toEqual([
      ["sales_emails", "sales.emails.1.delay_days"],
      ["sales_emails", "sales.emails.2.delay_days"],
      ["sales_emails", "sales.emails.3.delay_days"],
    ]);
    const none = sequence({
      sales: `sales:\n  type: follow_up\n  goal: "g"\n  audience: "a"\n  positioning_blob: ${BLOB}\n  opt_out: "o"\n  stop_condition: "s"\n`,
      body: "# S\n\n## Before you send\n\n- Check.\n",
    });
    expect(reasons(check({ [SEQUENCE]: none }, approval))).toEqual(["sales_emails"]);
    const unnamed = sequence({ emails: [{ subject: "", delay: 0 }] });
    expect(reasons(check({ [SEQUENCE]: unnamed }, approval))).toContain("sales_emails");
  });

  it("requires one section per email, in order, with the subject of the header", () => {
    const drifted = sequence({
      body: "# S\n\n## Email 1\n\nSubject: Something else\n\nHi.\n\n## Email 2\n\nSubject: Did you see my note?\n\nHi.\n\n## Before you send\n\n- Check.\n",
    });
    const result = check({ [SEQUENCE]: drifted }, approval);
    expect(
      salesProblems(result).map((problem) => [problem.details.reason, problem.details.field]),
    ).toEqual([["sales_email_section", "body.1"]]);
    const missing = sequence({
      body: "# S\n\n## Email 1\n\nSubject: A quick question\n\nHi.\n\n## Before you send\n\n- Check.\n",
    });
    expect(reasons(check({ [SEQUENCE]: missing }, approval))).toEqual(["sales_email_section"]);
    const swapped = sequence({
      body: "# S\n\n## Email 2\n\nSubject: Did you see my note?\n\nHi.\n\n## Email 1\n\nSubject: A quick question\n\nHi.\n\n## Before you send\n\n- Check.\n",
    });
    expect(reasons(check({ [SEQUENCE]: swapped }, approval))).toEqual(["sales_email_section"]);
    const french = sequence({
      body: "# S\n\n## Courriel 1\n\nSubject: A quick question\n\nBonjour.\n\n## Courriel 2\n\nSubject: Did you see my note?\n\nBonjour.\n\n## Avant l'envoi\n\n- Vérifie.\n",
    });
    expect(check({ [SEQUENCE]: french }, approval).problems).toEqual([]);
    const empty = sequence({
      body: "# S\n\n## Email 1\n\nSubject: A quick question\n\nHi.\n\n## Email 2\n\n<!-- later -->\n\n## Before you send\n\n- Check.\n",
    });
    expect(reasons(check({ [SEQUENCE]: empty }, approval))).toEqual(["sales_email_section"]);
  });

  it("requires the reminders before sending, and that they are not empty", () => {
    const base = sequence();
    const without = base.slice(0, base.indexOf("## Before you send"));
    expect(reasons(check({ [SEQUENCE]: without }, approval))).toEqual(["sales_section"]);
    const empty = `${without}## Before you send\n\n-\n`;
    expect(
      salesProblems(check({ [SEQUENCE]: empty }, approval)).map(
        (problem) => problem.details.problem,
      ),
    ).toEqual(["empty"]);
    const french = `${without}## Avant l'envoi\n\n- Vérifie ton droit d'écrire.\n`;
    expect(check({ [SEQUENCE]: french }, approval).problems).toEqual([]);
  });

  it("warns, without failing, about a very long sequence", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      subject: `Email number ${index + 1}`,
      delay: index === 0 ? 0 : 2,
    }));
    const result = check({ [SEQUENCE]: sequence({ emails: many }) }, approval);
    expect(result.problems).toEqual([]);
    expect(warnings(result)).toEqual(["sales_sequence_long"]);
    const seven = check({ [SEQUENCE]: sequence({ emails: many.slice(0, 7) }) }, approval);
    expect(warnings(seven)).toEqual([]);
  });

  it("refuses a marker of the template left in a subject or a field", () => {
    const result = check(
      { [SEQUENCE]: sequence({ emails: [{ subject: "<subject of the first email>", delay: 0 }] }) },
      approval,
    );
    expect(result.problems.map((problem) => problem.code)).toContain(
      ErrorCode.DOC_PLACEHOLDER_LEFT,
    );
  });
});

describe("docs check: sales documents and the positioning they build on", () => {
  it("warns when the positioning is a draft, or changed since its approval", () => {
    const draft = check({ [OFFER]: offer(), [SEQUENCE]: sequence() }, []);
    expect(draft.problems).toEqual([]);
    expect(draft.warnings.map((entry) => [entry.reason, entry.details.state])).toEqual([
      ["sales_positioning_not_validated", "draft"],
      ["sales_positioning_not_validated", "draft"],
    ]);
    const stale = answered(
      "G-OLD",
      "approved",
      "2026-10-03T02:00:00.000Z",
      [[POSITIONING_PATH, "a".repeat(40)]],
      { type: "publication", opened_by: "julien" },
    );
    expect(warnings(check({ [OFFER]: offer() }, [stale]))).toEqual([
      "sales_positioning_not_validated",
    ]);
    expect(check({ [OFFER]: offer() }, [stale]).warnings[0]?.details.state).toBe("changed");
  });

  it("warns when a document was written from another version of the positioning", () => {
    const old = offer({
      sales: `sales:\n  goal: "g"\n  audience: "a"\n  positioning_blob: ${"b".repeat(40)}\n  pricing:\n    status: none\n`,
    });
    expect(warnings(check({ [OFFER]: old }, approval))).toEqual(["sales_positioning_moved"]);
    // The same sha256 as git writes it also counts as the version held.
    const sha256 = gitBlobId(utf8(POSITIONING_TEXT), "sha256");
    const modern = offer().replace(BLOB, sha256);
    expect(check({ [OFFER]: modern }, approval).warnings).toEqual([]);
  });

  it("does not read the validation without the checkpoints", () => {
    const result = checkDocumentsDetailed({
      current: [
        { path: ".agentplugged/docs/index.md", text: KB },
        { path: POSITIONING_PATH, text: POSITIONING_TEXT },
        { path: OFFER, text: offer() },
      ],
      owners: new Set(["julien", "milo", "zoe"]),
    });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("finds the offers and the sequences at any depth, by their folder", () => {
    const deep = `${OFFERS_DIR}2026/autumn.md`;
    const header = "id: offer-autumn\nkind: note\nowner: milo\nlinks: [positioning]\nlanguage: en";
    expect(check({ [deep]: offer({ header }) }, approval).problems).toEqual([]);
    expect(reasons(check({ [deep]: offer({ header, sales: "" }) }, approval))).toEqual([
      "sales_missing",
    ]);
  });
});

describe("docs check: what the review tightened", () => {
  it("refuses a kind other than a note", () => {
    const header =
      "id: offer-starter\nkind: decision\nowner: milo\nlinks: [positioning]\nlanguage: en";
    expect(reasons(check({ [OFFER]: offer({ header }) }, approval))).toContain("sales_kind");
  });

  it("warns, without failing, when there is no positioning at all", () => {
    const result = checkDocumentsDetailed({
      current: [
        { path: ".agentplugged/docs/index.md", text: KB },
        { path: OFFER, text: offer() },
      ],
      owners: new Set(["julien", "milo", "zoe"]),
      validations: { checkpoints: [], now: NOW },
    });
    expect(result.warnings.map((entry) => [entry.reason, entry.details.state])).toEqual([
      ["sales_positioning_not_validated", "absent"],
    ]);
  });

  it("refuses a goal, an audience or an amount that is only a dash, or has no figure", () => {
    const sales = `sales:\n  goal: "​"\n  audience: "-"\n  positioning_blob: ${BLOB}\n  pricing:\n    status: stated\n    amount: "to be decided"\n    stated_on: 2026-10-03\n`;
    const result = check({ [OFFER]: offer({ sales }) }, approval);
    expect(
      salesProblems(result).map((problem) => [problem.details.reason, problem.details.field]),
    ).toEqual([
      ["sales_field", "sales.goal"],
      ["sales_field", "sales.audience"],
      ["sales_pricing", "sales.pricing.amount"],
    ]);
    const negative = offer({
      pricing: "  pricing:\n    status: stated\n    amount: -5\n    stated_on: 2026-10-03\n",
    });
    expect(reasons(check({ [OFFER]: negative }, approval))).toEqual(["sales_pricing"]);
  });

  it("wants a source on every evidence row, and a known status on all of them", () => {
    const table = (rows: string) =>
      `# Offer\n\n## Text\n\nWhat you get.\n\n## Evidence\n\n| Claim | Status | Source |\n| --- | --- | --- |\n${rows}`;
    const bad = (rows: string) =>
      reasons(check({ [OFFER]: offer({ body: table(rows) }) }, approval));
    expect(bad("| It syncs | verified | kb-index |\n")).toEqual([]);
    expect(bad("| It syncs | verified | |\n")).toEqual(["sales_evidence"]);
    expect(bad("| It syncs | verified | kb-index |\n| Best ever | invented | me |\n")).toEqual([
      "sales_evidence",
    ]);
  });

  it("refuses a fake reply as a subject, and a delay beyond a year", () => {
    const reply = sequence({
      emails: [
        { subject: "Re: our call", delay: 0 },
        { subject: "Next", delay: 400 },
      ],
    });
    expect(
      salesProblems(check({ [SEQUENCE]: reply }, approval)).map((problem) => problem.details.field),
    ).toEqual(["sales.emails.1.subject", "sales.emails.2.delay_days"]);
    const french = sequence({ emails: [{ subject: "RE : notre appel", delay: 0 }] });
    expect(reasons(check({ [SEQUENCE]: french }, approval))).toContain("sales_emails");
  });

  it("wants the Subject line and a text after it, not the subject anywhere", () => {
    const only = sequence({
      body: "# S\n\n## Email 1\n\nSubject: A quick question\n\n## Email 2\n\nSubject: Did you see my note?\n\nHi.\n\n## Before you send\n\n- Check.\n",
    });
    expect(
      salesProblems(check({ [SEQUENCE]: only }, approval)).map((problem) => problem.details.field),
    ).toEqual(["body.1"]);
    const buried = sequence({
      body: "# S\n\n## Email 1\n\nA quick question, said in passing.\n\n## Email 2\n\nObjet : Did you see my note?\n\nHi.\n\n## Before you send\n\n- Check.\n",
    });
    expect(
      salesProblems(check({ [SEQUENCE]: buried }, approval)).map(
        (problem) => problem.details.field,
      ),
    ).toEqual(["body.1"]);
  });

  it("accepts the typographic apostrophe, and a sha256 version of the positioning on a sequence", () => {
    const sha256 = gitBlobId(utf8(POSITIONING_TEXT), "sha256");
    const typo = sequence().replace(BLOB, sha256).replace("## Before you send", "## Avant l’envoi");
    expect(check({ [SEQUENCE]: typo }, approval)).toMatchObject({ problems: [], warnings: [] });
  });

  it("refuses two sales documents with the same id", () => {
    const twin = check({ [OFFER]: offer(), [`${OFFERS_DIR}twin.md`]: offer() }, approval);
    expect(twin.problems.length).toBeGreaterThan(0);
  });
});
