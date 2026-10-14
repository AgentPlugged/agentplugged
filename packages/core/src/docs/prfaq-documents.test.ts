import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { checkDocumentsDetailed, type DocumentFile } from "../index.js";

/** `docs check` on the press release, before and after a verdict closes it. */

const PATH = ".agentplugged/docs/prfaq.md";
const KB = `---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n`;
const HEADER = "id: prfaq\nkind: prfaq\nowner: iris\nlinks: []\nconcept: commercial";

const CUSTOMER = [
  "- [switch] Why not keep my spreadsheet? — It does the totals for you.",
  "- [safety] What happens to my data? — It stays on your machine.",
  "- [effort] How long to start? — Five minutes.",
  "- [effort] What does it cost? — 9 € a month. [assumption]",
  "- [rare] Does it work offline? — [open]",
  "- [dreaded] What if you stop maintaining it? — The files are plain text.",
];
const INTERNAL = [
  "- [build] What is the hardest part? — The import.",
  "- [last] How do we reach the first hundred? — Word of mouth.",
  "- [means] Who builds it? — One person, three months.",
  "- [danger] What kills it? — A big competitor copying the one feature.",
  "- [why-us] Why us? — We use it every day.",
  "- [avoided] What if nobody pays? — [open]",
];
const VERDICT = [
  "- Holds: the release is clear; the trust answers are honest.",
  "- Soft: the price rests on one guess → ask five freelancers before the launch.",
  "- Breaks: none",
];

interface Parts {
  header?: string;
  release?: string[] | null;
  customer?: string[] | null;
  internal?: string[] | null;
  verdict?: string[] | null;
}

function release(parts: Parts = {}): string {
  const block = (title: string, lines: string[] | null | undefined, fallback: string[]) =>
    lines === null ? [] : [`## ${title}`, "", ...(lines ?? fallback), ""];
  return [
    "---",
    parts.header ?? HEADER,
    "---",
    "# Press release: Plumb",
    "",
    ...block("Release", parts.release, ["2027-03-01 — Plumb lets freelancers invoice in one tap."]),
    ...block("Customer FAQ", parts.customer, CUSTOMER),
    ...block("Internal FAQ", parts.internal, INTERNAL),
    ...block("Verdict", parts.verdict, VERDICT),
  ].join("\n");
}

function reasons(text: string) {
  const current: DocumentFile[] = [
    { path: ".agentplugged/docs/index.md", text: KB },
    { path: PATH, text },
  ];
  return checkDocumentsDetailed({ current, owners: new Set(["iris", "zoe"]) })
    .problems.filter((problem) => problem.code === ErrorCode.LAUNCH_DOCUMENT_INVALID)
    .map((problem) => `${problem.details.reason}:${problem.details.problem}`);
}

describe("docs check: the press release", () => {
  it("accepts a closed release: two lists of 6 to 10 questions, every angle, a verdict", () => {
    expect(reasons(release())).toEqual([]);
  });

  it("holds a release in progress to nothing: no angle, no count, no concept, as in 17.10", () => {
    const old = release({
      header: "id: prfaq\nkind: prfaq\nowner: iris",
      customer: ["- How much does it cost? - [open]"],
      internal: ["- What must be true? - Freelancers pay monthly."],
      verdict: null,
    });
    expect(reasons(old)).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => `- Question ${i}`);
    expect(reasons(release({ customer: many, verdict: null }))).toEqual([]);
    // Closed, a list of twelve is too long.
    const tagged = Array.from({ length: 12 }, (_, i) => `- [switch] Question ${i}`);
    expect(reasons(release({ customer: [...tagged, ...CUSTOMER.slice(1)] }))).toEqual([
      "prfaq_faq:count",
    ]);
  });

  it("asks a closed release for 6 questions at least", () => {
    expect(reasons(release({ customer: CUSTOMER.slice(0, 5) }))).toEqual(
      expect.arrayContaining(["prfaq_faq:count"]),
    );
  });

  it("asks for the angle of each question, and every angle asked, the dreaded one included", () => {
    const untagged = [...CUSTOMER.slice(0, 5), "- Is there a free plan? — No."];
    expect(reasons(release({ customer: untagged }))).toEqual([
      "prfaq_faq:missing_angle",
      "prfaq_faq:angle",
    ]);
    const noDreaded = INTERNAL.map((line) => line.replace("[avoided]", "[danger]"));
    expect(reasons(release({ internal: noDreaded }))).toEqual(["prfaq_faq:missing_angle"]);
  });

  it("reads the angles in French and lets the question carry other tags", () => {
    const customer = [
      "- [changer] Pourquoi pas mon tableur ? — Il fait les totaux.",
      "- [sûreté] Et mes données ? — Elles restent chez toi.",
      "- [effort] Combien de temps pour démarrer ? — Cinq minutes.",
      "- [rare] Ça marche hors ligne ? — [open]",
      "- [redouté] Et si vous arrêtez ? — Les fichiers sont en texte.",
      "- [open] [effort] Et le prix ? — [assumption]",
    ];
    expect(reasons(release({ customer }))).toEqual([]);
  });

  it("asks both lists of a closed release", () => {
    expect(reasons(release({ internal: null }))).toEqual(["prfaq_faq:missing"]);
  });

  it("asks a closed release for its concept type, and checks one that is named", () => {
    const bare = "id: prfaq\nkind: prfaq\nowner: iris\nlinks: []";
    expect(reasons(release({ header: bare }))).toEqual(["prfaq_concept:missing"]);
    expect(reasons(release({ header: `${bare}\nconcept: startup` }))).toEqual([
      "prfaq_concept:unknown",
    ]);
    expect(reasons(release({ header: `${bare}\nconcept: community` }))).toEqual([]);
  });

  it("asks the verdict for its three categories, the last two with what to do", () => {
    expect(reasons(release({ verdict: VERDICT.slice(0, 2) }))).toEqual(["prfaq_verdict:missing"]);
    const noMove = VERDICT.map((line) =>
      line.replace(" → ask five freelancers before the launch", ""),
    );
    expect(reasons(release({ verdict: noMove }))).toEqual(["prfaq_verdict:move"]);
    const cracked = [VERDICT[0] as string, VERDICT[1] as string, "- Breaks: nobody pays"];
    expect(reasons(release({ verdict: cracked }))).toEqual(["prfaq_verdict:move"]);
    const fixed = [
      VERDICT[0] as string,
      VERDICT[1] as string,
      "- Breaks: nobody pays → sell ten before building",
    ];
    expect(reasons(release({ verdict: fixed }))).toEqual([]);
  });

  it("reads the verdict in French, with items on sub-lines", () => {
    const verdict = [
      "- Tient : le communiqué est clair.",
      "- Fragile :",
      "  - le prix repose sur une intuition → demander à cinq indépendants",
      "  - le canal n'est pas choisi → en tester deux",
      "- Casse : rien",
    ];
    expect(reasons(release({ verdict }))).toEqual([]);
  });

  it("reads an item over several lines, and several items in bullets, each with its own move", () => {
    const verdict = [
      "- Holds: clear.",
      "- Soft: the price rests on a guess → ask five freelancers;",
      "  then check the churn before the launch",
      "- Breaks:",
      "  - nobody pays → sell ten before building",
      "  - the channel is unknown",
    ];
    // The second item of Breaks has no move; the first of Soft goes on over two lines.
    expect(reasons(release({ verdict }))).toEqual(["prfaq_verdict:move"]);
    const fixed = [...verdict.slice(0, 5), "  - the channel is unknown → try two"];
    expect(reasons(release({ verdict: fixed }))).toEqual([]);
  });

  it("refuses a category named but empty, and accepts `none` and `rien`", () => {
    expect(reasons(release({ verdict: ["- Holds: clear.", "- Soft:", "- Breaks: none"] }))).toEqual(
      ["prfaq_verdict:empty"],
    );
    expect(
      reasons(release({ verdict: ["- Tient : clair.", "- Fragile : rien", "- Casse : rien"] })),
    ).toEqual([]);
  });

  it("ignores other kinds of document", () => {
    const note =
      "---\nid: n\nkind: note\nowner: iris\nlinks: []\n---\n# N\n\n## Verdict\n\nnothing\n";
    expect(reasons(note)).toEqual([]);
  });
});
