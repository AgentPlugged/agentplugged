import { type CritiqueInput, MAX_OPEN_HYPOTHESES } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CritiqueRecord,
  correctionLines,
  critiqueOffer,
  critiqueStack,
  critiqueView,
  deliveredAfter,
  documentRisk,
  type HypothesisRecord,
  hypothesesDue,
  ideaOffer,
  openStack,
  passageFound,
  refsOf,
  validateClose,
  validateCritiqueReport,
  validateSettle,
  versionsOf,
  wasOffered,
} from "./critique-rules.js";

/**
 * The rules of the critique of a deliverable, pure: the passage checked against the
 * document, the whole report, the stack, the gestures, what an evidence brings back, when to offer.
 */

const DOCUMENT = [
  "---",
  "id: prd",
  "kind: prd",
  "owner: maya",
  "---",
  "# Product requirements",
  "",
  "## Exports",
  "",
  "- EF-3: The visitor exports their data.",
  "- ENF-1: A page answers in at most 300 ms.",
  "",
  "## Sécurité des données",
  "",
].join("\n");

const report = (extra: Partial<CritiqueInput> = {}): CritiqueInput => ({
  agent: "quentin",
  kind: "prd",
  lenses: ["pre_mortem"],
  summary: "Requirements fail by what they forgot.",
  findings: [
    {
      severity: "blocking",
      claim: "An export of a whole account can time out.",
      passage: "EF-3",
      argument: "Nothing bounds the number of rows an export reads.",
      proposal: "Cap the export or make it asynchronous.",
      proof: "Export 100 000 rows in a test.",
    },
  ],
  ...extra,
});

describe("the passage a critique aims at", () => {
  it("finds an identifier in the text, whole: EF-3 is not in EF-30", () => {
    expect(passageFound(DOCUMENT, "EF-3")).toBe(true);
    expect(passageFound(DOCUMENT, "ef-3")).toBe(true);
    expect(passageFound(DOCUMENT, "EF-30")).toBe(false);
    expect(passageFound("- EF-30: other", "EF-3")).toBe(false);
    expect(passageFound(DOCUMENT, "EF-3 and ENF-1")).toBe(true);
    expect(passageFound(DOCUMENT, "EF-3 and ENF-2")).toBe(false);
  });

  it("finds a heading, without accents nor case, and refuses a passage that is nowhere", () => {
    expect(passageFound(DOCUMENT, "Exports")).toBe(true);
    expect(passageFound(DOCUMENT, "securite des donnees")).toBe(true);
    expect(passageFound(DOCUMENT, "## Exports")).toBe(true);
    expect(passageFound(DOCUMENT, "Pricing")).toBe(false);
    // Words of the body are not headings; a too short passage is nothing.
    expect(passageFound(DOCUMENT, "visitor")).toBe(false);
    expect(passageFound(DOCUMENT, "ok")).toBe(false);
  });

  it("lets a passage shorten a heading, never extend it nor borrow a word of another", () => {
    expect(passageFound(DOCUMENT, "Sécurité")).toBe(true);
    expect(passageFound(DOCUMENT, "des données")).toBe(true);
    expect(passageFound(DOCUMENT, "Exports and imports")).toBe(false);
    expect(passageFound(DOCUMENT, "Product requirements for exports")).toBe(false);
    // A word is a whole word: « Export » is not a run of the words of « Exports ».
    expect(passageFound(DOCUMENT, "Export")).toBe(false);
  });

  it("ignores what is in a code block: a heading or an identifier there is no passage", () => {
    const text = [
      "# Spec",
      "",
      "## Real",
      "",
      "```md",
      "## Hidden heading",
      "- EF-9: only in code",
      "```",
      "",
      "- EF-1: outside",
    ].join("\n");
    expect(passageFound(text, "Real")).toBe(true);
    expect(passageFound(text, "EF-1")).toBe(true);
    expect(passageFound(text, "Hidden heading")).toBe(false);
    expect(passageFound(text, "EF-9")).toBe(false);
  });

  it("names the identifiers of a passage, once each, in upper case", () => {
    expect(refsOf("see ef-3, ENF-1 and EF-3 again")).toEqual(["EF-3", "ENF-1"]);
    expect(refsOf("Exports")).toEqual([]);
  });

  it("knows a version of a document by its Git blob ids, as written and in LF", () => {
    const crlf = versionsOf("a\r\nb");
    const lf = versionsOf("a\nb");
    expect(crlf.length).toBe(4);
    expect(lf.length).toBe(2);
    expect(crlf.filter((id) => lf.includes(id))).toHaveLength(2);
  });
});

describe("a whole report", () => {
  it("accepts a whole report, with or without objections", () => {
    expect(validateCritiqueReport(report(), DOCUMENT)).toEqual([]);
    expect(validateCritiqueReport(report({ findings: [] }), DOCUMENT)).toEqual([]);
  });

  it("lists everything that is missing at once, by objection", () => {
    const bare: CritiqueInput = {
      agent: "quentin",
      findings: [
        { severity: "should_fix", claim: "One." },
        { severity: "minor", claim: "Two.", passage: "Pricing", argument: "short" },
      ],
    };
    expect(validateCritiqueReport(bare, DOCUMENT)).toEqual([
      "kind_missing",
      "method_missing",
      "summary_missing",
      "passage_missing:1",
      "argument_missing:1",
      "proposal_missing:1",
      "proof_missing:1",
      "passage_unknown:2",
      "argument_missing:2",
    ]);
  });

  it("refuses a new report of a version whose critique still waits for the creator", () => {
    const waiting = critique(["open", "fix"]);
    expect(validateCritiqueReport(report(), DOCUMENT, waiting)).toEqual([
      `critique_unsorted:${waiting.id}`,
    ]);
    // Sorted, or made for another version of the document: a new critique is welcome.
    expect(validateCritiqueReport(report(), DOCUMENT, critique(["fix", "discard"]))).toEqual([]);
    expect(
      validateCritiqueReport(report(), DOCUMENT, { ...waiting, versions: ["c".repeat(40)] }),
    ).toEqual([]);
    // Even a report without objection cannot wipe a stack that was not sorted.
    expect(validateCritiqueReport(report({ findings: [] }), DOCUMENT, waiting)).toHaveLength(1);
  });

  it("refuses a field the call does not use, a document it cannot read and too many objections", () => {
    expect(validateCritiqueReport(report({ item: "K-7M2K9QX4TB" }), DOCUMENT)).toEqual([
      "unexpected:item",
    ]);
    expect(validateCritiqueReport(report({ lenses: [] }), DOCUMENT)).toEqual(["method_missing"]);
    expect(validateCritiqueReport(report(), undefined)).toContain("document_not_found");
    const many = Array.from({ length: 13 }, () => ({
      severity: "minor" as const,
      claim: "x",
      passage: "EF-3",
      argument: "long enough to count",
    }));
    expect(validateCritiqueReport(report({ findings: many }), DOCUMENT)).toContain(
      "too_many_objections:13>12",
    );
  });
});

describe("the stack the creator reads", () => {
  it("puts the graver first, one line each, with the number of the report", () => {
    const lines = critiqueStack([
      { severity: "minor", claim: "A detail.", passage: "Exports" },
      { severity: "blocking", claim: "No limit on exports.", passage: "EF-3" },
      { severity: "should_fix", claim: "Vague speed.", passage: "ENF-1" },
      { severity: "blocking", claim: "Second blocking.", passage: "EF-9" },
    ]);
    expect(lines).toEqual([
      "2. blocking · EF-3 — No limit on exports.",
      "4. blocking · EF-9 — Second blocking.",
      "3. should_fix · ENF-1 — Vague speed.",
      "1. minor · Exports — A detail.",
    ]);
  });

  it("cuts a long line, so the stack stays short", () => {
    const [line] = critiqueStack([
      { severity: "minor", claim: "word ".repeat(100), passage: "Exports" },
    ]);
    expect(line?.length).toBeLessThanOrEqual(120);
    expect(line?.endsWith("…")).toBe(true);
  });
});

const DOC_VERSION = versionsOf(DOCUMENT)[0] as string;

const critique = (statuses: Array<"open" | "fix" | "hypothesis" | "discard">): CritiqueRecord => ({
  id: "K-7M2K9QX4TB",
  at: "2026-10-09T10:00:00.000Z",
  document: ".agentplugged/docs/prd.md",
  method: "pre_mortem",
  versions: [DOC_VERSION],
  by: "quentin",
  objections: statuses.map((status, index) => ({
    n: index + 1,
    severity: "should_fix" as const,
    claim: `Claim ${index + 1}`,
    passage: "EF-3",
    proposal: "Change it.",
    proof: index === 1 ? null : "Run the export.",
    status,
  })),
});

const settle = (items: CritiqueInput["items"], quote = "voilà") =>
  ({
    agent: "quentin",
    item: "K-7M2K9QX4TB",
    items,
    quote,
  }) as CritiqueInput;

describe("the creator's gestures", () => {
  it("accepts the three gestures on open objections, some now and the rest later", () => {
    const known = critique(["open", "open", "open"]);
    expect(
      validateSettle(
        settle([
          { n: 1, gesture: "fix" },
          { n: 3, gesture: "hypothesis" },
        ]),
        known,
        0,
      ),
    ).toEqual([]);
    expect(
      validateSettle(settle([{ n: 2, gesture: "discard", reason: "Out of scope." }]), known, 0),
    ).toEqual([]);
  });

  it("asks a reason to drop, a proof to follow a hypothesis, and the creator's words", () => {
    const known = critique(["open", "open"]);
    expect(validateSettle(settle([{ n: 1, gesture: "discard" }]), known, 0)).toEqual([
      "reason_missing:1",
    ]);
    // Objection 2 carries no proof in this report.
    expect(validateSettle(settle([{ n: 2, gesture: "hypothesis" }]), known, 0)).toEqual([
      "proof_missing:2",
    ]);
    const mute = { ...settle([{ n: 1, gesture: "fix" }]), quote: undefined };
    expect(validateSettle(mute, known, 0)).toEqual(["quote_missing"]);
  });

  it("refuses an unknown critique or objection, a repeat, and one already sorted", () => {
    expect(validateSettle(settle([{ n: 1, gesture: "fix" }]), undefined, 0)).toEqual([
      "critique_unknown",
    ]);
    // A gesture the creator cannot make, an entry without its number, a field of another call.
    const known = critique(["open", "open"]);
    expect(
      validateSettle(settle([{ gesture: "fix" }, { n: 2, gesture: "proved" }]), known, 0),
    ).toEqual(["n_missing:1", "gesture_unknown:2"]);
    expect(
      validateSettle({ ...settle([{ n: 1, gesture: "fix" }]), summary: "x" }, known, 0),
    ).toEqual(["unexpected:summary"]);
    const sorted = critique(["fix", "open"]);
    expect(
      validateSettle(
        settle([
          { n: 1, gesture: "fix" },
          { n: 2, gesture: "fix" },
          { n: 2, gesture: "fix" },
          { n: 5, gesture: "fix" },
        ]),
        sorted,
        0,
      ),
    ).toEqual(["objection_settled:1", "decision_repeated:2", "objection_unknown:5"]);
  });

  it("keeps the open hypotheses bounded: the creator closes some before keeping more", () => {
    const known = critique(["open"]);
    expect(
      validateSettle(settle([{ n: 1, gesture: "hypothesis" }]), known, MAX_OPEN_HYPOTHESES),
    ).toEqual([`hypotheses_full:${MAX_OPEN_HYPOTHESES}+1>${MAX_OPEN_HYPOTHESES}`]);
  });

  it("closes a hypothesis only with an outcome, a reason and the creator's words", () => {
    const hypothesis = hypothesisRecord();
    const close = (extra: Partial<CritiqueInput>) =>
      ({ agent: "quentin", item: hypothesis.id, ...extra }) as CritiqueInput;
    expect(validateClose(close({}), hypothesis)).toEqual(["closing_missing", "quote_missing"]);
    expect(
      validateClose(close({ items: [{ gesture: "proved" }], quote: "oui" }), hypothesis),
    ).toEqual(["reason_missing"]);
    expect(
      validateClose(close({ items: [{ gesture: "fix", reason: "x" }], quote: "oui" }), hypothesis),
    ).toEqual(["outcome_unknown"]);
    expect(
      validateClose(
        close({ items: [{ gesture: "proved", reason: "Measured." }], quote: "oui" }),
        hypothesis,
      ),
    ).toEqual([]);
    expect(
      validateClose(
        close({ items: [{ gesture: "still_open", reason: "Not yet." }], quote: "oui" }),
        undefined,
      ),
    ).toEqual(["hypothesis_unknown"]);
  });
});

function hypothesisRecord(extra: Partial<HypothesisRecord> = {}): HypothesisRecord {
  return {
    id: "H-7M2K9QX4TB-1",
    critique: "K-7M2K9QX4TB",
    n: 1,
    claim: "An export can time out.",
    document: ".agentplugged/docs/prd.md",
    passage: "ENF-1",
    refs: ["ENF-1"],
    proof: "Run the export.",
    severity: "blocking",
    since: "2026-10-09T10:00:00.000Z",
    seen: null,
    by: "quentin",
    ...extra,
  };
}

const registerWith = (provedAt: string | null, stories: string[] = []) => ({
  items: {
    "ENF-1": {
      stories,
      proved: provedAt === null ? null : { at: provedAt, result: "pass" },
    },
  },
});

describe("what brings a hypothesis back", () => {
  const state = (hypotheses: HypothesisRecord[], rest: Record<string, unknown> = {}) => ({
    hypotheses: Object.fromEntries(hypotheses.map((h) => [h.id, h])),
    ...rest,
  });

  it("brings it back when a proof of a requirement its passage names arrives after it", () => {
    const open = hypothesisRecord();
    expect(hypothesesDue(state([open], { requirements: registerWith(null) })).due).toEqual([]);
    expect(
      hypothesesDue(state([open], { requirements: registerWith("2026-10-09T09:00:00.000Z") })).due,
    ).toEqual([]);
    expect(
      hypothesesDue(state([open], { requirements: registerWith("2026-10-09T11:00:00.000Z") })).due,
    ).toEqual([{ id: open.id, claim: open.claim, why: "proof pass for ENF-1" }]);
  });

  it("stays quiet after the creator looked and kept it open, until a newer evidence", () => {
    const looked = hypothesisRecord({ seen: "2026-10-09T12:00:00.000Z" });
    expect(
      hypothesesDue(state([looked], { requirements: registerWith("2026-10-09T11:00:00.000Z") }))
        .due,
    ).toEqual([]);
    expect(
      hypothesesDue(state([looked], { requirements: registerWith("2026-10-09T13:00:00.000Z") }))
        .due,
    ).toHaveLength(1);
  });

  it("brings it back when a story that cites the passage is delivered after it", () => {
    const open = hypothesisRecord({ passage: "EF-3", refs: ["EF-3"] });
    const delivered = {
      id: "cp",
      type: "story",
      story: "1-1",
      status: "resolved",
      source: "agent",
      documents: [],
      resolution: { decision: "approved", at: "2026-10-09T11:00:00.000Z" },
    };
    const rest = {
      stories: { "1-1": {} },
      checkpoints: { cp: delivered },
    };
    const cites = new Map([["EF-3", ["1-1"]]]);
    expect(hypothesesDue(state([open], rest), cites).due[0]?.why).toBe(
      "story 1-1 delivered (EF-3)",
    );
    // A story that does not cite it brings nothing back.
    expect(hypothesesDue(state([open], rest), new Map()).due).toEqual([]);
  });

  it("shows three at most, and counts the others", () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      hypothesisRecord({ id: `H-7M2K9QX4TB-${index + 1}`, n: index + 1 }),
    );
    const result = hypothesesDue(
      state(many, { requirements: registerWith("2026-10-09T11:00:00.000Z") }),
    );
    expect(result.due).toHaveLength(3);
    expect(result.more).toBe(2);
  });
});

describe("what state says of the critique", () => {
  it("says nothing when there is nothing", () => {
    expect(critiqueView({})).toBeUndefined();
  });

  it("lists five hypotheses at most, the graver first, and the critiques not sorted", () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      hypothesisRecord({
        id: `H-7M2K9QX4TB-${index + 1}`,
        n: index + 1,
        severity: index === 6 ? "blocking" : "minor",
        since: `2026-10-09T10:0${index}:00.000Z`,
      }),
    );
    const view = critiqueView({
      hypotheses: Object.fromEntries(many.map((h) => [h.id, h])),
      critiques: { "K-7M2K9QX4TB": critique(["open", "fix", "open"]) },
    });
    expect(view?.open).toBe(7);
    expect(view?.hypotheses).toHaveLength(5);
    expect(view?.hypotheses[0]).toContain("H-7M2K9QX4TB-7");
    expect(view?.more).toBe(2);
    expect(view?.awaiting).toEqual(["K-7M2K9QX4TB · prd.md · 2 left"]);
  });
});

describe("when a critique is offered", () => {
  it("marks a document important, an architecture that speaks of security, a PRD with a security requirement", () => {
    const important = "---\nid: brief\nkind: brief\nowner: iris\nimportant: true\n---\n# Brief\n";
    expect(documentRisk(".agentplugged/docs/brief.md", important, false)).toBe("important");
    const architecture =
      "---\nid: architecture\nkind: architecture\nowner: alex\n---\n# Architecture\n\nWe store passwords hashed.\n";
    expect(documentRisk(".agentplugged/docs/architecture.md", architecture, false)).toBe(
      "sensitive_data",
    );
    expect(documentRisk(".agentplugged/docs/prd.md", DOCUMENT, true)).toBe("security_requirements");
    // An architecture speaks of tokens and permissions all the time: that is no sensitive data.
    const plainArchitecture =
      "---\nid: architecture\nkind: architecture\nowner: alex\n---\n# Architecture\n\nDesign tokens, file permissions, an upload folder and a cookie banner.\n";
    expect(
      documentRisk(".agentplugged/docs/architecture.md", plainArchitecture, false),
    ).toBeUndefined();
    // Nothing at risk, nothing offered.
    expect(documentRisk(".agentplugged/docs/prd.md", DOCUMENT, false)).toBeUndefined();
    expect(documentRisk(".agentplugged/docs/ux.md", DOCUMENT, true)).toBeUndefined();
  });

  const BLOB = "a".repeat(40);
  const OTHER = "b".repeat(40);
  const cited = [{ path: ".agentplugged/docs/prd.md", blob_sha: BLOB }];
  const risks = new Map([[".agentplugged/docs/prd.md", "security_requirements" as const]]);

  it("offers a document at risk whose version was not offered, and each version once", () => {
    expect(critiqueOffer({}, cited, risks)).toEqual({
      kind: "prd",
      why: "security_requirements",
    });
    const offered = { critiqued: { ".agentplugged/docs/prd.md": [BLOB] } };
    expect(wasOffered(offered, ".agentplugged/docs/prd.md", [BLOB.toUpperCase()])).toBe(true);
    expect(critiqueOffer(offered, cited, risks)).toBeUndefined();
    // A new version of the document is offered again.
    expect(
      critiqueOffer(offered, [{ path: ".agentplugged/docs/prd.md", blob_sha: OTHER }], risks),
    ).toMatchObject({ kind: "prd" });
  });

  it("offers nothing for a document at no risk, nor for a file that is not a structuring document", () => {
    expect(critiqueOffer({}, cited, new Map())).toBeUndefined();
    expect(
      critiqueOffer(
        {},
        [{ path: "src/app.ts", blob_sha: BLOB }],
        new Map([["src/app.ts", "important" as const]]),
      ),
    ).toBeUndefined();
  });
});

describe("what is left to sort, and what to correct", () => {
  it("shows the objections not sorted yet, the graver first, with the numbers of the report", () => {
    const known = critique(["open", "fix", "open", "discard"]);
    expect(openStack(known)).toEqual([
      "1. should_fix · EF-3 — Claim 1",
      "3. should_fix · EF-3 — Claim 3",
    ]);
  });

  it("gives the author the proposal of each objection kept for correction, one line each", () => {
    const known = critique(["fix", "open", "fix"]);
    expect(correctionLines(known, [1, 3])).toEqual(["1. Change it.", "3. Change it."]);
    expect(correctionLines(known, [])).toEqual([]);
  });
});

describe("the offer once per version, whatever the line endings", () => {
  it("knows a version offered from a copy with CRLF when the point cites its LF blob", () => {
    const lf = "---\nid: prd\nkind: prd\nowner: maya\n---\n# PRD\n\nline\n";
    const crlf = lf.replaceAll("\n", "\r\n");
    const state = { critiqued: { ".agentplugged/docs/prd.md": versionsOf(crlf) } };
    const risks = new Map([[".agentplugged/docs/prd.md", "important" as const]]);
    const asLf = [{ path: ".agentplugged/docs/prd.md", blob_sha: versionsOf(lf)[0] as string }];
    const asCrlf = [{ path: ".agentplugged/docs/prd.md", blob_sha: versionsOf(crlf)[0] as string }];
    expect(critiqueOffer(state, asLf, risks)).toBeUndefined();
    expect(critiqueOffer(state, asCrlf, risks)).toBeUndefined();
    // Another text is another version.
    const other = [
      { path: ".agentplugged/docs/prd.md", blob_sha: versionsOf(lf + "more")[0] as string },
    ];
    expect(critiqueOffer(state, other, risks)).toMatchObject({ kind: "prd" });
  });
});

describe("when a story was delivered", () => {
  const delivered = {
    stories: { "1-1": {} },
    checkpoints: {
      cp: {
        id: "cp",
        type: "story",
        story: "1-1",
        status: "resolved",
        source: "agent",
        documents: [],
        resolution: { decision: "approved", at: "2026-10-09T11:00:00.000Z" },
      },
    },
  };

  it("is true only for a delivery after the date, so the stories' files are read when it matters", () => {
    expect(deliveredAfter(delivered, "2026-10-09T10:00:00.000Z")).toBe(true);
    expect(deliveredAfter(delivered, "2026-10-09T12:00:00.000Z")).toBe(false);
    expect(deliveredAfter({}, "2026-10-09T10:00:00.000Z")).toBe(false);
  });
});

describe("the test of an idea and the press release", () => {
  const ideaReport = (extra: Partial<CritiqueInput> = {}): CritiqueInput =>
    report({
      kind: "idea",
      lenses: ["personas"],
      summary: "A demanding customer, the competitor and a skeptical investor.",
      findings: [
        {
          severity: "should_fix",
          claim: "Freelancers will pay for this every month.",
          passage: "Willingness to pay",
          argument: "The investor sees no one who paid for the first version yet.",
          proposal: "Ask five freelancers to pre-order.",
          proof: "Five pre-orders in two weeks.",
        },
      ],
      ...extra,
    });

  it("accepts a report on the idea, which is no file: nothing to read, the passage is a free label", () => {
    expect(validateCritiqueReport(ideaReport(), undefined)).toEqual([]);
    // A document, by contrast, must be there.
    expect(validateCritiqueReport(report({ kind: "prfaq" }), undefined)).toContain(
      "document_not_found",
    );
    // The label is still required, and so are the argument and the proof of a graver objection.
    const bare = ideaReport({ findings: [{ severity: "blocking", claim: "No buyer." }] });
    expect(validateCritiqueReport(bare, undefined)).toEqual(
      expect.arrayContaining(["passage_missing:1", "argument_missing:1", "proof_missing:1"]),
    );
  });

  it("checks the passages of the press release in its text, like any document", () => {
    const text =
      "---\nid: prfaq\nkind: prfaq\nowner: iris\n---\n# Press release\n\n## Customer FAQ\n";
    const aimed = (passage: string) =>
      report({
        kind: "prfaq",
        lenses: ["personas"],
        findings: [{ ...report().findings?.[0], passage } as never],
      });
    expect(validateCritiqueReport(aimed("Customer FAQ"), text)).toEqual([]);
    expect(validateCritiqueReport(aimed("Pricing FAQ"), text)).toEqual(["passage_unknown:1"]);
  });

  it("never lets a new test of the idea erase the bets the creator did not sort", () => {
    const previous = {
      id: "K-7M2K9QX4TB",
      at: "2026-10-09T10:00:00.000Z",
      document: ".agentplugged/docs/idea",
      method: "personas",
      versions: ["idea"],
      by: "iris",
      objections: [{ n: 1, status: "open" }],
    } as unknown as CritiqueRecord;
    expect(validateCritiqueReport(ideaReport(), undefined, previous)).toContain(
      "critique_unsorted:K-7M2K9QX4TB",
    );
    (previous.objections[0] as { status: string }).status = "hypothesis";
    expect(validateCritiqueReport(ideaReport(), undefined, previous)).toEqual([]);
  });

  it("offers the idea once for the product, and remembers it once a test was reported", () => {
    expect(ideaOffer({})).toEqual({ kind: "idea", why: "new_product" });
    const offered = { critiqued: { ".agentplugged/docs/idea": ["idea"] } };
    expect(ideaOffer(offered)).toBeUndefined();
    expect(wasOffered(offered, ".agentplugged/docs/idea", ["idea"])).toBe(true);
  });

  it("brings back a bet of the idea or of the press release on the first story delivered after it", () => {
    const bet = (document: string, extra: Partial<HypothesisRecord> = {}) =>
      hypothesisRecord({ document, passage: "Willingness to pay", refs: [], ...extra });
    const delivered = (at: string) => ({
      stories: { "1-1": {} },
      checkpoints: {
        cp: {
          id: "cp",
          type: "story",
          story: "1-1",
          status: "resolved",
          source: "agent",
          documents: [],
          resolution: { decision: "approved", at },
        },
      },
    });
    const state = (hypothesis: HypothesisRecord, rest: Record<string, unknown>) => ({
      hypotheses: { [hypothesis.id]: hypothesis },
      ...rest,
    });
    const idea = bet(".agentplugged/docs/idea");
    expect(hypothesesDue(state(idea, {})).due).toEqual([]);
    expect(hypothesesDue(state(idea, delivered("2026-10-09T09:00:00.000Z"))).due).toEqual([]);
    expect(hypothesesDue(state(idea, delivered("2026-10-09T11:00:00.000Z"))).due).toEqual([
      { id: idea.id, claim: idea.claim, why: "story 1-1 delivered" },
    ]);
    const release = bet(".agentplugged/docs/prfaq.md");
    expect(hypothesesDue(state(release, delivered("2026-10-09T11:00:00.000Z"))).due).toHaveLength(
      1,
    );
    // Kept open by the creator: quiet until the next delivery. A bet on a PRD passage is not one of the idea.
    const looked = bet(".agentplugged/docs/idea", { seen: "2026-10-09T12:00:00.000Z" });
    expect(hypothesesDue(state(looked, delivered("2026-10-09T11:00:00.000Z"))).due).toEqual([]);
    const prd = bet(".agentplugged/docs/prd.md");
    expect(hypothesesDue(state(prd, delivered("2026-10-09T11:00:00.000Z"))).due).toEqual([]);
  });
});

/**
 * The families of methods the engine accepts, a blend of two, and the reconciliation
 * of the creator's inputs, held to five findings.
 */
describe("methods, blends and reconciliation", () => {
  const FAMILIES = [
    "divergence",
    "assumption_audit",
    "steelman",
    "failure_modes",
    "second_order",
    "domain_expert",
    "extreme_user",
    "compare_existing",
    "reframe",
    "subtraction",
    "judgment",
  ] as const;

  it("accepts every family of method alone, and a blend of two different ones", () => {
    for (const method of FAMILIES) {
      expect(validateCritiqueReport(report({ lenses: [method] }), DOCUMENT), method).toEqual([]);
    }
    expect(
      validateCritiqueReport(report({ lenses: ["divergence", "failure_modes"] }), DOCUMENT),
    ).toEqual([]);
  });

  it("refuses no method, the same method twice, and a solo method in a blend", () => {
    expect(validateCritiqueReport(report({ lenses: [] }), DOCUMENT)).toContain("method_missing");
    expect(validateCritiqueReport(report({ lenses: ["steelman", "steelman"] }), DOCUMENT)).toEqual([
      "method_repeated",
    ]);
    for (const solo of ["personas", "reconcile"] as const) {
      expect(validateCritiqueReport(report({ lenses: [solo, "steelman"] }), DOCUMENT)).toContain(
        "method_alone",
      );
    }
  });

  it("holds a reconciliation to five findings, on a PRD, a UX specification or an architecture", () => {
    const finding = (n: number) => ({
      severity: "should_fix" as const,
      claim: `The creator's idea number ${n} did not land.`,
      passage: "Exports",
      argument: `Brief: « the export must feel instant » (idea ${n}); nothing in the PRD says so.`,
      proposal: "Add it to the section, in the creator's words.",
      proof: "The creator confirms it still holds.",
    });
    const five = Array.from({ length: 5 }, (_, i) => finding(i + 1));
    const six = [...five, finding(6)];
    expect(
      validateCritiqueReport(report({ lenses: ["reconcile"], findings: five }), DOCUMENT),
    ).toEqual([]);
    expect(
      validateCritiqueReport(report({ lenses: ["reconcile"], findings: six }), DOCUMENT),
    ).toEqual(["too_many_objections:6>5"]);
    // Another method may still hold up to twelve.
    expect(validateCritiqueReport(report({ findings: six }), DOCUMENT)).toEqual([]);
    // Nothing missed is a valid answer; a brief is not reconciled with itself.
    expect(
      validateCritiqueReport(report({ lenses: ["reconcile"], findings: [] }), DOCUMENT),
    ).toEqual([]);
    expect(
      validateCritiqueReport(report({ lenses: ["reconcile"], kind: "brief" }), DOCUMENT),
    ).toEqual(["reconcile_kind:brief"]);
    // The finding is still aimed at a passage the engine finds in the document.
    expect(
      validateCritiqueReport(
        report({ lenses: ["reconcile"], findings: [{ ...finding(1), passage: "Mood" }] }),
        DOCUMENT,
      ),
    ).toEqual(["passage_unknown:1"]);
  });
});
