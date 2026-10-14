import { gitBlobId, utf8 } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  checkDocumentsDetailed,
  type DocumentFile,
  POSITIONING_PATH,
  positioningStatus,
} from "../index.js";
import { answered, checkpointState } from "../testing/checkpoint-state.js";

/** `docs check` on the positioning and the pages of the launch. */

const PAGE = ".agentplugged/docs/launch/pages/home.md";
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

const KB = `---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n`;

const EVIDENCE =
  "| Claim | Status | Source |\n| --- | --- | --- |\n| It syncs | verified | kb-index |\n";
const SECTIONS = ["Audience", "Problem", "Promise", "Difference"]
  .map((title) => `## ${title}\n\nSomething true about it.\n`)
  .concat(`## Evidence\n\n${EVIDENCE}`)
  .join("\n");

function positioning(header = "", body = SECTIONS): string {
  const fields = {
    id: "id: positioning",
    kind: "kind: note",
    owner: "owner: julien",
    links: "links: [kb-index]",
    language: "language: en",
  };
  const lines = Object.entries(fields)
    .filter(([key]) => !header.split(" ").includes(`-${key}`))
    .map(([, line]) => line);
  return `---\n${lines.join("\n")}\n${header.replace(/-\w+/g, "").trim()}\n---\n# Positioning\n\n${body}`;
}

const MEASURED = `    - term: "snippet manager"
      volume: 1900
      source: "Search console export"
      as_of: 2026-10-01
      provenance: creator`;
const HYPOTHESIS = `    - term: "keep my snippets"
      hypothesis: true`;

function page(seo: string, links = "[positioning]", extra = "language: en"): string {
  return `---\nid: page-home\nkind: note\nowner: julien\nlinks: ${links}\n${extra}\n${seo}---\n# Home\n\nText.\n`;
}

const SEO = (keywords = `${MEASURED}\n${HYPOTHESIS}`, rest = "") =>
  `seo:\n  intent: "Find a snippet manager"\n  title: "A snippet manager"\n  description: "Keep your snippets."\n${rest}  keywords:\n${keywords}\n`;

function check(files: Record<string, string>, validations?: Parameters<typeof checkWith>[1]) {
  return checkWith(files, validations);
}

function checkWith(
  files: Record<string, string>,
  validations?: {
    checkpoints: Parameters<typeof positioningStatus>[1];
    now: number;
  },
) {
  const current: DocumentFile[] = Object.entries({
    ".agentplugged/docs/index.md": KB,
    ...files,
  }).map(([path, text]) => ({ path, text }));
  return checkDocumentsDetailed({
    current,
    owners: new Set(["julien", "zoe"]),
    ...(validations === undefined
      ? {}
      : { validations: { checkpoints: [...validations.checkpoints], now: validations.now } }),
  });
}

const launchProblems = (result: ReturnType<typeof check>) =>
  result.problems.filter((problem) => problem.code === ErrorCode.LAUNCH_DOCUMENT_INVALID);
const reasons = (result: ReturnType<typeof check>) =>
  launchProblems(result).map((problem) => problem.details.reason);

describe("docs check: the positioning", () => {
  it("accepts a positioning with its header and its five sections", () => {
    expect(check({ [POSITIONING_PATH]: positioning() }).problems).toEqual([]);
  });

  it("accepts the titles in French, and the creator as owner", () => {
    const french = ["Cible", "Problème", "Promesse", "Différence", "Preuves"]
      .map((title) =>
        title === "Preuves" ? `## ${title}\n\n${EVIDENCE}` : `## ${title}\n\nUne chose vraie.\n`,
      )
      .join("\n");
    const text = positioning("", french).replace("owner: julien", "owner: creator");
    expect(check({ [POSITIONING_PATH]: text }).problems).toEqual([]);
  });

  it("refuses a missing, empty or doubled section", () => {
    const body = [
      "## Audience\n\nWho.\n",
      "## Problem\n\n",
      "## Difference\n\nHow.\n",
      `## Evidence\n\n${EVIDENCE}`,
      "## Evidence\n\nTwice.\n",
    ].join("\n");
    const result = check({ [POSITIONING_PATH]: positioning("", body) });
    expect(
      launchProblems(result).map((problem) => [problem.details.reason, problem.details.section]),
    ).toEqual([
      ["section_missing", "promise"],
      ["section_empty", "problem"],
      ["section_duplicate", "evidence"],
    ]);
    expect(launchProblems(result)[1]?.message_key).toBe(
      "error.launch_document_invalid.section_empty",
    );
  });

  it("does not count a comment, a dash or an invisible character as content", () => {
    for (const nothing of ["<!-- TODO -->", "-", "\u200B", "<!-- a\nb -->\n\n  "]) {
      const body = SECTIONS.replace(
        "## Problem\n\nSomething true about it.",
        `## Problem\n\n${nothing}`,
      );
      expect(reasons(check({ [POSITIONING_PATH]: positioning("", body) })), nothing).toEqual([
        "section_empty",
      ]);
    }
  });

  it("wants an evidence table with a known status in its second column", () => {
    const body = (evidence: string) => SECTIONS.replace(EVIDENCE, evidence);
    for (const evidence of [
      "Trust me.\n",
      "| Claim | Status |\n| --- | --- |\n| It syncs | sure |\n",
    ]) {
      expect(reasons(check({ [POSITIONING_PATH]: positioning("", body(evidence)) }))).toEqual([
        "evidence_status",
      ]);
    }
    for (const status of ["stated", "untrusted", "`verified`", "Verified"]) {
      const ok = body(`| Claim | Status | Source |\n| --- | --- | --- |\n| x | ${status} | y |\n`);
      expect(check({ [POSITIONING_PATH]: positioning("", ok) }).problems, status).toEqual([]);
    }
  });

  it("refuses another id, kind or owner, no document to draw from, and no language", () => {
    const text = positioning("")
      .replace("id: positioning", "id: pitch")
      .replace("kind: note", "kind: brief")
      .replace("owner: julien", "owner: zoe")
      .replace("links: [kb-index]", "links: [EF-1]")
      .replace("language: en\n", "");
    const result = check({ [POSITIONING_PATH]: text });
    expect(new Set(reasons(result))).toEqual(
      new Set([
        "positioning_id",
        "positioning_kind",
        "positioning_owner",
        "positioning_links",
        "language",
      ]),
    );
  });

  it("leaves a document of another folder alone", () => {
    expect(
      check({
        ".agentplugged/docs/launch/notes.md": positioning("").replace(
          "id: positioning",
          "id: notes",
        ),
      }).problems,
    ).toEqual([]);
  });

  it("refuses a template marker left in the body", () => {
    const result = check({
      [POSITIONING_PATH]: positioning("", `${SECTIONS}\n<what changed it>\n`),
    });
    expect(result.problems.map((problem) => problem.code)).toContain(
      ErrorCode.DOC_PLACEHOLDER_LEFT,
    );
  });
});

describe("docs check: the pages", () => {
  const files = (text: string) => ({ [POSITIONING_PATH]: positioning(), [PAGE]: text });

  it("accepts a page with a measured keyword and a hypothesis", () => {
    expect(check(files(page(SEO()))).problems).toEqual([]);
  });

  it("refuses a page without positioning link, language or search fields", () => {
    expect(new Set(reasons(check(files(page(SEO(), "[kb-index]", "")))))).toEqual(
      new Set(["page_positioning_link", "language"]),
    );
    expect(reasons(check(files(page("", "[positioning]"))))).toEqual(["seo_missing"]);
    expect(reasons(check(files(page("seo: yes\n"))))).toEqual(["seo_missing"]);
  });

  it("refuses an empty or multi-line intent, title or description", () => {
    const seo = `seo:\n  intent: ""\n  title: "Two\\nlines"\n  keywords:\n${HYPOTHESIS}\n`;
    const result = check(files(page(seo)));
    expect(launchProblems(result).map((problem) => problem.details.field)).toEqual([
      "seo.intent",
      "seo.title",
      "seo.description",
    ]);
  });

  it("refuses a page that targets no keyword", () => {
    expect(reasons(check(files(page(SEO("    []"))))).includes("keywords_missing")).toBe(true);
    expect(
      reasons(check(files(page("seo:\n  intent: a\n  title: b\n  description: c\n")))),
    ).toEqual(["keywords_missing"]);
  });

  it("marks a keyword without volume data: it must be a hypothesis", () => {
    const result = check(files(page(SEO(`    - term: "snippet manager"`))));
    expect(launchProblems(result)).toMatchObject([
      {
        message_key: "error.launch_document_invalid.keyword_unverified",
        details: { reason: "keyword_unverified", keyword: "snippet manager", index: 0 },
      },
    ]);
    // An explicit false is the same: nothing says it is a hypothesis.
    expect(reasons(check(files(page(SEO(`    - term: "x"\n      hypothesis: false`)))))).toEqual([
      "keyword_unverified",
    ]);
  });

  it("refuses a hypothesis that claims a volume or a source", () => {
    const claimed = `    - term: "x"\n      hypothesis: true\n      volume: 500`;
    expect(launchProblems(check(files(page(SEO(claimed)))))).toMatchObject([
      { details: { reason: "keyword_conflict", field: "seo.keywords.0.volume" } },
    ]);
    const sourced = `    - term: "x"\n      hypothesis: true\n      source: "a tool"`;
    expect(reasons(check(files(page(SEO(sourced)))))).toEqual(["keyword_conflict"]);
  });

  it("refuses a volume without its source, its date or its provenance", () => {
    const bare = `    - term: "x"\n      volume: 500`;
    expect(
      launchProblems(check(files(page(SEO(bare))))).map((problem) => problem.details.field),
    ).toEqual(["seo.keywords.0.source", "seo.keywords.0.as_of", "seo.keywords.0.provenance"]);
    const invented = `    - term: "x"\n      volume: -3\n      source: "t"\n      as_of: 2026-02-31\n      provenance: me`;
    expect(
      launchProblems(check(files(page(SEO(invented))))).map((problem) => problem.details.field),
    ).toEqual(["seo.keywords.0.volume", "seo.keywords.0.as_of", "seo.keywords.0.provenance"]);
  });

  it("accepts the language tag of a product other than the creator's, and refuses a name", () => {
    expect(check(files(page(SEO(), "[positioning]", "language: pt-BR"))).problems).toEqual([]);
    for (const language of ["english", "pt_BR", "FR", "fr-"]) {
      expect(
        reasons(check(files(page(SEO(), "[positioning]", `language: ${language}`)))),
        language,
      ).toEqual(["language"]);
    }
  });

  it("lets a hypothesis carry no other field, and refuses a volume source left as a template", () => {
    const note = `    - term: "x"\n      hypothesis: true\n      note: "volume 9000"`;
    expect(launchProblems(check(files(page(SEO(note)))))).toMatchObject([
      { details: { reason: "keyword_conflict", field: "seo.keywords.0.note" } },
    ]);
    const template = `    - term: "x"\n      volume: 0\n      source: "<tool the volume comes from>"\n      as_of: 2026-01-01\n      provenance: untrusted`;
    expect(launchProblems(check(files(page(SEO(template)))))).toMatchObject([
      { details: { reason: "keyword_proof", field: "seo.keywords.0.source" } },
    ]);
  });

  it("refuses a measure dated in the future once the clock is known", () => {
    const future = `    - term: "x"\n      volume: 10\n      source: "export"\n      as_of: 2099-01-01\n      provenance: creator`;
    const text = positioning();
    const withClock = check(
      { [POSITIONING_PATH]: text, [PAGE]: page(SEO(future)) },
      { checkpoints: [], now: NOW },
    );
    expect(launchProblems(withClock)).toMatchObject([
      { details: { reason: "keyword_proof", field: "seo.keywords.0.as_of" } },
    ]);
    expect(launchProblems(check({ [POSITIONING_PATH]: text, [PAGE]: page(SEO(future)) }))).toEqual(
      [],
    );
  });

  it("refuses an invalid entry, naming its index", () => {
    const result = check(
      files(page(SEO(`${HYPOTHESIS}\n    - nope\n    - term: "y"\n      hypothesis: maybe`))),
    );
    expect(launchProblems(result)).toMatchObject([
      { details: { reason: "keyword_invalid", index: 1 } },
      { details: { reason: "keyword_invalid", index: 2, field: "seo.keywords.2.hypothesis" } },
    ]);
  });

  it("refuses a template marker in a search field", () => {
    const seo = `seo:\n  intent: "<what they want>"\n  title: "A snippet manager"\n  description: "d"\n  keywords:\n${HYPOTHESIS}\n`;
    const result = check(files(page(seo)));
    expect(result.problems.map((problem) => problem.code)).toEqual([
      ErrorCode.DOC_PLACEHOLDER_LEFT,
    ]);
  });

  it("warns, without failing, about a title or a description search engines cut", () => {
    const seo = `seo:\n  intent: "i"\n  title: "${"t".repeat(71)}"\n  description: "${"d".repeat(171)}"\n  keywords:\n${HYPOTHESIS}\n`;
    const result = check(files(page(seo)));
    expect(result.problems).toEqual([]);
    expect(result.warnings.map((warning) => warning.reason)).toEqual([
      "launch_seo_title_long",
      "launch_seo_description_long",
    ]);
  });

  it("reads a folded or literal YAML block as one line, and counts characters, not code units", () => {
    const folded = `seo:\n  intent: >\n    Find a manager\n  title: |\n    A snippet manager\n  description: "d"\n  keywords:\n${HYPOTHESIS}\n`;
    expect(check(files(page(folded))).problems).toEqual([]);
    const emojis = `seo:\n  intent: "i"\n  title: "${"😀".repeat(36)}"\n  description: "d"\n  keywords:\n${HYPOTHESIS}\n`;
    expect(check(files(page(emojis))).warnings).toEqual([]);
  });

  it("reads pages at any depth of the pages folder", () => {
    const deep = ".agentplugged/docs/launch/pages/features/sync.md";
    expect(
      reasons(
        check({
          [POSITIONING_PATH]: positioning(),
          [deep]: page("").replace("id: page-home", "id: page-sync"),
        }),
      ),
    ).toEqual(["seo_missing"]);
  });
});

describe("the positioning is validated by its publication", () => {
  const text = positioning();
  const blob = gitBlobId(utf8(text), "sha1");
  const hour = (n: number) => new Date(Date.UTC(2026, 9, 3, n)).toISOString();
  const publication = (id: string, decision: "approved" | "rejected", at: string, sha = blob) =>
    answered(id, decision, at, [[POSITIONING_PATH, sha]], {
      type: "publication",
      opened_by: "julien",
    });

  it("is absent, a draft, validated or changed", () => {
    expect(positioningStatus(undefined, [], NOW)).toEqual({ state: "absent" });
    expect(positioningStatus(text, [], NOW)).toEqual({ state: "draft" });
    const open = checkpointState("G-OPEN", {
      type: "publication",
      documents: [{ path: POSITIONING_PATH, branch: "main", blob_sha: blob }],
    });
    expect(positioningStatus(text, [open], NOW).state).toBe("draft");
    expect(positioningStatus(text, [publication("G-1", "approved", hour(2))], NOW)).toEqual({
      state: "validated",
      checkpoint: "G-1",
    });
    expect(
      positioningStatus(`${text}\nEdited.\n`, [publication("G-1", "approved", hour(2))], NOW),
    ).toEqual({
      state: "changed",
      checkpoint: "G-1",
    });
  });

  it("reads the line endings Git would store, and the SHA-256 of a SHA-256 repository", () => {
    const crlf = text.replaceAll("\n", "\r\n");
    expect(positioningStatus(crlf, [publication("G-1", "approved", hour(2))], NOW).state).toBe(
      "validated",
    );
    const sha256 = gitBlobId(utf8(text), "sha256");
    expect(
      positioningStatus(text, [publication("G-2", "approved", hour(2), sha256)], NOW).state,
    ).toBe("validated");
  });

  it("counts neither a refusal, nor a document or a phase end, and the last answer wins", () => {
    expect(positioningStatus(text, [publication("G-1", "rejected", hour(2))], NOW).state).toBe(
      "draft",
    );
    const document = answered("G-D", "approved", hour(2), [[POSITIONING_PATH, blob]], {
      type: "document",
    });
    expect(positioningStatus(text, [document], NOW).state).toBe("draft");
    const old = publication("G-1", "approved", hour(2), "b".repeat(40));
    const recent = publication("G-2", "approved", hour(4));
    expect(positioningStatus(text, [recent, old], NOW)).toEqual({
      state: "validated",
      checkpoint: "G-2",
    });
    const refusedLater = publication("G-3", "rejected", hour(6));
    expect(positioningStatus(text, [old, refusedLater], NOW).state).toBe("changed");
  });

  it("does not validate on a reservation-less choice, a waiver or an option picked", () => {
    const base = { type: "publication" as const, opened_by: "julien" };
    const reserved = answered(
      "G-R",
      "approved_with_reservations",
      hour(2),
      [[POSITIONING_PATH, blob]],
      base,
    );
    expect(positioningStatus(text, [reserved], NOW).state).toBe("validated");
    const waived = answered("G-W", "waived", hour(2), [[POSITIONING_PATH, blob]], base);
    expect(positioningStatus(text, [waived], NOW).state).toBe("draft");
    const picked = answered("G-O", "option_chosen", hour(2), [[POSITIONING_PATH, blob]], base);
    expect(positioningStatus(text, [picked], NOW).state).toBe("draft");
  });

  it("keeps a validation a later refusal of the same version does not undo", () => {
    const approved = publication("G-1", "approved", hour(2));
    const refused = publication("G-2", "rejected", hour(5));
    expect(positioningStatus(text, [approved, refused], NOW)).toEqual({
      state: "validated",
      checkpoint: "G-1",
    });
  });

  it("warns about a page built on a positioning that is not validated", () => {
    const files = { [POSITIONING_PATH]: text, [PAGE]: page(SEO()) };
    const draft = check(files, { checkpoints: [], now: NOW });
    expect(draft.warnings).toMatchObject([
      { reason: "launch_positioning_not_validated", details: { path: PAGE, state: "draft" } },
    ]);
    const validated = check(files, {
      checkpoints: [publication("G-1", "approved", hour(2))],
      now: NOW,
    });
    expect(validated.warnings).toEqual([]);
    expect(check(files).warnings).toEqual([]);
  });
});
