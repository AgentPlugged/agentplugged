import { gitBlobId, utf8 } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  checkDocumentsDetailed,
  DECK_PATH,
  DESIGN_DIR,
  type DocumentFile,
  NARRATIVE_PATH,
} from "../index.js";
import { answered } from "../testing/checkpoint-state.js";

/** `docs check` on the narrative, the deck and the design thinking synthesis. */

const DESIGN = `${DESIGN_DIR}onboarding.md`;
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const KB = `---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n`;

function narrative(options: { header?: string; body?: string } = {}): string {
  const header =
    options.header ?? "id: narrative\nkind: note\nowner: julien\nlinks: [kb-index]\nlanguage: en";
  const body =
    options.body ??
    "# Narrative\n\n## Audience\n\nSolo makers.\n\n## Story\n\nA maker loses a week to rework.\n\n## Proof\n\n| Claim | Status | Source |\n| --- | --- | --- |\n| 40% fewer tokens | stated | kb-index |\n\n## Ask\n\nTry it on one story.\n";
  return `---\n${header}\n---\n${body}`;
}

const SLIDES = [1, 2, 3]
  .map((n) => `## Slide ${n}\n\nOne idea ${n}.\n\nNotes: say it slowly.\n`)
  .join("\n");

function deck(options: { header?: string; body?: string } = {}): string {
  const header =
    options.header ??
    "id: deck\nkind: note\nowner: julien\nlinks: [narrative, kb-index]\nlanguage: en";
  return `---\n${header}\n---\n${options.body ?? `# Deck\n\n${SLIDES}`}`;
}

function design(options: { header?: string; body?: string } = {}): string {
  const header =
    options.header ??
    "id: design-onboarding\nkind: note\nowner: stella\nlinks: [kb-index]\nlanguage: en";
  const body =
    options.body ??
    "# Design thinking\n\n## Empathy\n\nThey give up at the first screen.\n\n## Definition\n\nHow might we get them to a first result?\n\n## Ideas\n\n- A guided first run.\n\n## Prototype\n\nA paper flow.\n\n## Test\n\nFive people, one task.\n";
  return `---\n${header}\n---\n${body}`;
}

function check(files: Record<string, string>, checkpoints: ReturnType<typeof answered>[] = []) {
  const current: DocumentFile[] = Object.entries({
    ".agentplugged/docs/index.md": KB,
    ...files,
  }).map(([path, text]) => ({ path, text }));
  return checkDocumentsDetailed({
    current,
    owners: new Set(["julien", "stella", "zoe"]),
    validations: { checkpoints, now: NOW },
  });
}

const reasons = (result: ReturnType<typeof check>) =>
  result.problems
    .filter((problem) => problem.code === ErrorCode.LAUNCH_DOCUMENT_INVALID)
    .map((problem) => problem.details.reason);
const warnings = (result: ReturnType<typeof check>) => result.warnings.map((entry) => entry.reason);

describe("docs check: the narrative, the deck and the design synthesis", () => {
  it("accepts the three documents with their header and their sections", () => {
    const result = check({
      [NARRATIVE_PATH]: narrative(),
      [DECK_PATH]: deck(),
      [DESIGN]: design(),
    });
    expect(result.problems).toEqual([]);
    // The deck links the narrative, which no checkpoint validated.
    expect(warnings(result)).toEqual(["pitch_narrative_not_validated"]);
  });

  it("refuses a header that is not the owner's, and a document with no source", () => {
    const header = "id: story\nkind: epic\nowner: sam\nlinks: []";
    const result = check({ [NARRATIVE_PATH]: narrative({ header }) });
    expect(reasons(result)).toEqual(
      expect.arrayContaining(["pitch_id", "pitch_owner", "pitch_links", "language"]),
    );
    // Stella's synthesis cannot be Julien's, nor the other way round.
    const other = check({
      [DESIGN]: design({
        header: "id: design-a\nkind: note\nowner: julien\nlinks: [kb-index]\nlanguage: en",
      }),
    });
    expect(reasons(other)).toEqual(["pitch_owner"]);
    expect(
      check({
        [DESIGN]: design({
          header: "id: design-a b\nkind: note\nowner: stella\nlinks: [kb-index]\nlanguage: en",
        }),
      }).problems,
    ).not.toEqual([]);
  });

  it("refuses a missing, empty or doubled section", () => {
    const noProof = narrative({
      body: "# N\n\n## Audience\n\nSolo.\n\n## Story\n\nOnce.\n\n## Ask\n\nTry.\n\n## Ask\n\nAgain.\n",
    });
    const result = check({ [NARRATIVE_PATH]: noProof });
    expect(
      result.problems.map((problem) => [problem.details.section, problem.details.problem]),
    ).toEqual([
      ["proof", "missing"],
      ["ask", "duplicate"],
    ]);
    const empty = design({ body: "# D\n\n## Empathy\n\n## Definition\n\nx\n" });
    expect(reasons(check({ [DESIGN]: empty }))).toHaveLength(4);
  });

  it("accepts the headings of a creator who writes in French", () => {
    const french = design({
      body: "# D\n\n## Empathie\n\nx\n\n## Définition\n\nx\n\n## Idées\n\nx\n\n## Prototype\n\nx\n\n## Tests\n\nx\n",
    });
    expect(check({ [DESIGN]: french }).problems).toEqual([]);
  });

  it("refuses a deck with too few slides, out of order, or without notes", () => {
    expect(
      reasons(check({ [DECK_PATH]: deck({ body: "# D\n\n## Slide 1\n\nx\n\nNotes: y\n" }) })),
    ).toEqual(["pitch_slides"]);
    const order = SLIDES.replace("Slide 2", "Slide 4");
    expect(reasons(check({ [DECK_PATH]: deck({ body: `# D\n\n${order}` }) }))).toEqual([
      "pitch_slides",
    ]);
    const noNotes = SLIDES.replace("Notes: say it slowly.\n", "").replace(
      "Notes: say it slowly.",
      "",
    );
    const result = check({ [DECK_PATH]: deck({ body: `# D\n\n${noNotes}` }) });
    expect(result.problems.map((problem) => problem.details.problem)).toContain("notes");
    const french =
      "# D\n\n## Diapositive 1\n\na\n\nNotes de l'orateur : b\n\n## Diapositive 2\n\na\n\nNotes : b\n\n## Diapositive 3\n\na\n\nSpeaker notes: b\n";
    expect(
      check({ [NARRATIVE_PATH]: narrative(), [DECK_PATH]: deck({ body: french }) }).problems,
    ).toEqual([]);
  });

  it("warns when a slide holds more than one idea", () => {
    const dense = `# D\n\n## Slide 1\n\n${["a", "b", "c", "d", "e", "f", "g"].join("\n")}\n\nNotes: y\n\n${SLIDES.split("\n\n").slice(3).join("\n\n")}`;
    expect(warnings(check({ [DECK_PATH]: deck({ body: dense }) }))).toContain("pitch_slide_dense");
  });

  it("marks a figure with no source, and leaves a sourced or flagged one alone", () => {
    const bare = narrative({
      body: "# N\n\n## Audience\n\nSolo.\n\n## Story\n\n9 out of 10 makers lose a week.\nIt saves 40% of the cost [source: kb-index].\nAnd 3x the speed [to verify].\nSee EF-12 for 20% fewer steps.\n\n## Proof\n\nNone yet.\n\n## Ask\n\nTry.\n",
    });
    const result = check({ [NARRATIVE_PATH]: bare });
    expect(result.problems).toEqual([]);
    const [entry] = result.warnings;
    expect(entry?.reason).toBe("pitch_figure_unsourced");
    expect(entry?.details).toMatchObject({ count: 1 });
  });

  it("reads the notes line as a creator writes it, and the heading of a slide for figures", () => {
    const styled =
      "# D\n\n## Slide 1\n\na\n\n**Notes :** b\n\n## Slide 2\n\na\n\n- Notes: b\n\n## Slide 3\n\na\n\nNotes de l’orateur : b\n";
    expect(
      check({ [NARRATIVE_PATH]: narrative(), [DECK_PATH]: deck({ body: styled }) }).problems,
    ).toEqual([]);
    const titled = SLIDES.replace("## Slide 2", "## Slide 2 — 10x faster");
    const result = check({
      [NARRATIVE_PATH]: narrative(),
      [DECK_PATH]: deck({ body: `# D\n\n${titled}` }),
    });
    expect(result.warnings.map((entry) => [entry.reason, entry.details.count])).toEqual([
      ["pitch_narrative_not_validated", undefined],
      ["pitch_figure_unsourced", 1],
    ]);
  });

  it("does not skip a section that only has « source » in its title, nor trust a figure cell", () => {
    const body =
      "# D\n\n## Slide 1 — Open source\n\n3 customers already.\n\nNotes: b\n\n## Slide 2\n\n| Plan | Price | Source |\n| --- | --- | --- |\n| Pro | 20 $ | 20 $ |\n\nNotes: b\n\n## Slide 3\n\na\n\nNotes: b\n";
    const result = check({
      [NARRATIVE_PATH]: narrative(),
      [DECK_PATH]: deck({ body }),
    });
    expect(
      result.warnings.find((entry) => entry.reason === "pitch_figure_unsourced")?.details,
    ).toMatchObject({ count: 2 });
  });

  it("counts a table as one line, and a comment over several lines as nothing", () => {
    const table = `| A | B |\n| --- | --- |\n${"| 1 | 2 |\n".repeat(8)}`;
    const body = `# D\n\n## Slide 1\n\n${table}\n<!-- guidance\n40% of users\n-->\n\nNotes: b\n\n${SLIDES.split("\n\n").slice(3).join("\n\n")}`;
    const result = check({ [NARRATIVE_PATH]: narrative(), [DECK_PATH]: deck({ body }) });
    expect(result.problems).toEqual([]);
    expect(warnings(result)).toEqual(["pitch_narrative_not_validated"]);
  });

  it("reads the narrative's validation from the checkpoint that cites its version", () => {
    const text = narrative();
    const blob = gitBlobId(utf8(text), "sha1");
    const approval = answered(
      "G-NAR",
      "approved",
      "2026-10-12T02:00:00.000Z",
      [[NARRATIVE_PATH, blob]],
      {
        type: "publication",
        opened_by: "julien",
      },
    );
    expect(check({ [NARRATIVE_PATH]: text, [DECK_PATH]: deck() }, [approval]).warnings).toEqual([]);
    const stale = answered(
      "G-OLD",
      "approved",
      "2026-10-12T02:00:00.000Z",
      [[NARRATIVE_PATH, "a".repeat(40)]],
      {
        type: "publication",
        opened_by: "julien",
      },
    );
    const changed = check({ [NARRATIVE_PATH]: text, [DECK_PATH]: deck() }, [stale]);
    expect(changed.warnings.map((entry) => entry.details.state)).toEqual(["changed"]);
    // A deck that does not link the narrative is not held by it.
    const free = deck({
      header: "id: deck\nkind: note\nowner: julien\nlinks: [kb-index]\nlanguage: en",
    });
    expect(check({ [NARRATIVE_PATH]: text, [DECK_PATH]: free }).warnings).toEqual([]);
  });

  it("refuses a template marker left in the text", () => {
    const left = narrative({
      body: "# N\n\n## Audience\n\n<who they are>\n\n## Story\n\nx\n\n## Proof\n\nx\n\n## Ask\n\nx\n",
    });
    expect(check({ [NARRATIVE_PATH]: left }).problems.map((problem) => problem.code)).toEqual([
      ErrorCode.DOC_PLACEHOLDER_LEFT,
    ]);
  });
});
