import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { checkDocumentsDetailed, type DocumentFile, IDEATION_DIR } from "../index.js";

/** `docs check` on the file of a forge, at every stage of its life. */

const FORGE = `${IDEATION_DIR}forge-tour.md`;
const KB = `---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n`;
const HEADER =
  "id: forge-tour\nkind: note\nowner: iris\nlinks: []\nlanguage: en\nconcept: commercial";

interface Options {
  header?: string;
  body: string;
}

const file = (options: Options) =>
  `---\n${options.header ?? HEADER}\n---\n# Forge: tour\n\n${options.body}\n`;

const HARDENED = [
  "Outcome: hardened",
  "## Idea",
  "A guided tour that skips itself when the user already knows the product.",
  "## Decisions",
  "- The tour is opt-out, never forced.",
  "## Rejected",
  "- A video tour — nobody watches it, and it is costly to keep current.",
  "- A checklist in the corner: it competes with the product's own first screen.",
].join("\n\n");

function check(files: Record<string, string>) {
  const current: DocumentFile[] = Object.entries({
    ".agentplugged/docs/index.md": KB,
    ...files,
  }).map(([path, text]) => ({ path, text }));
  return checkDocumentsDetailed({ current, owners: new Set(["iris", "zoe", "lou"]) });
}
const reasons = (text: string, path = FORGE) =>
  check({ [path]: text })
    .problems.filter((problem) => problem.code === ErrorCode.LAUNCH_DOCUMENT_INVALID)
    .map((problem) => problem.details.reason);

describe("docs check: a forge", () => {
  it("accepts a hardened file, a killed one and a clearer one", () => {
    expect(reasons(file({ body: HARDENED }))).toEqual([]);
    const killed = ["Outcome: killed", "## Idea", "A tour.", "## Cause", "Nobody asked for it."];
    expect(reasons(file({ body: killed.join("\n\n") }))).toEqual([]);
    const clearer = [
      "Outcome: clearer",
      "## Idea",
      "A tour.",
      "## Clearer",
      "The user is the buyer.",
    ];
    expect(reasons(file({ body: clearer.join("\n\n") }))).toEqual([]);
  });

  it("accepts a forge still going on: the idea and a typed log, no outcome yet", () => {
    const going = [
      "## Idea",
      "A guided tour.",
      "## Log",
      "- [chose] opt-out, never forced",
      "- [gap] nobody has said who pays",
      "- [fixed] the tour is for the first session only",
    ].join("\n\n");
    expect(reasons(file({ body: going }))).toEqual([]);
  });

  it("refuses an entry of the log with no type, and a log kept after the outcome", () => {
    const body = "## Idea\n\nA tour.\n\n## Log\n\n- we talked about the price\n- [chose] opt-out";
    expect(reasons(file({ body }))).toEqual(["forge_log"]);
    const kept = `${HARDENED}\n\n## Log\n\n- [chose] opt-out`;
    expect(reasons(file({ body: kept }))).toEqual(["forge_log"]);
  });

  it("reads the types of the log and the outcome in French too", () => {
    const body = [
      "Issue : durcie",
      "## Idée",
      "Une visite guidée.",
      "## Décisions",
      "- Elle se saute.",
      "## Écartées",
      "- Une vidéo : personne ne la regarde.",
    ].join("\n\n");
    expect(reasons(file({ body }))).toEqual([]);
    const going =
      "## Idée\n\nUne visite guidée.\n\n## Journal\n\n- [choix] elle se saute\n- [faille] qui paie ?\n- [pari] personne ne regarde une vidéo";
    expect(reasons(file({ body: going }))).toEqual([]);
  });

  it("refuses an outcome that is not one of the three", () => {
    expect(reasons(file({ body: HARDENED.replace("hardened", "promising") }))).toEqual([
      "forge_outcome",
    ]);
  });

  it("asks each outcome for what it keeps", () => {
    const noDecisions = HARDENED.replace(/## Decisions\n\n- .*\n\n/, "");
    expect(reasons(file({ body: noDecisions }))).toEqual(["forge_section"]);
    const noCause = ["Outcome: killed", "## Idea", "A tour."].join("\n\n");
    expect(reasons(file({ body: noCause }))).toEqual(["forge_section"]);
    const noClearer = ["Outcome: clearer", "## Idea", "A tour."].join("\n\n");
    expect(reasons(file({ body: noClearer }))).toEqual(["forge_section"]);
  });

  it("reads the outcome under the title only, never in the idea the creator wrote", () => {
    const body = [
      "## Idea",
      "Issue: we launch in March. Outcome: users save time.",
      "## Log",
      "- [path] first",
    ];
    expect(reasons(file({ body: body.join("\n\n") }))).toEqual([]);
  });

  it("reads reasons in numbered lists, and wants a few words, not a link or a lone word", () => {
    const numbered = HARDENED.replace(
      /- A video tour.*\n/,
      "1. A video tour — nobody watches it\n",
    );
    expect(
      reasons(
        file({
          body: numbered.replace(
            /- A checklist.*$/,
            "2. A checklist: it competes with the first screen",
          ),
        }),
      ),
    ).toEqual([]);
    const link = HARDENED.replace(/- A video tour.*\n/, "- A video tour: https://example.com\n");
    expect(reasons(file({ body: link }))).toEqual(["forge_reason"]);
    const lone = HARDENED.replace(/- A video tour.*\n/, "- A video tour — costly\n");
    expect(reasons(file({ body: lone }))).toEqual(["forge_reason"]);
  });

  it("keeps the options turned down with a reason, at least one", () => {
    const noReason = HARDENED.replace(/- A video tour.*\n/, "- A video tour\n");
    expect(reasons(file({ body: noReason }))).toEqual(["forge_reason"]);
    const none = HARDENED.replace(/## Rejected[\s\S]*$/, "## Rejected\n\nNothing was turned down.");
    expect(reasons(file({ body: none }))).toEqual(["forge_reason"]);
  });

  it("keeps a closed file short: it is a handoff, not a document", () => {
    const long = `${HARDENED}\n\n${Array.from({ length: 45 }, (_, i) => `Line ${i}`).join("\n")}`;
    expect(reasons(file({ body: long }))).toEqual(["forge_long"]);
  });

  it("needs the concept type, one of the four, in the header", () => {
    const without = "id: forge-tour\nkind: note\nowner: iris\nlinks: []\nlanguage: en";
    expect(reasons(file({ header: without, body: HARDENED }))).toEqual(["forge_concept"]);
    expect(reasons(file({ header: `${without}\nconcept: startup`, body: HARDENED }))).toEqual([
      "forge_concept",
    ]);
    expect(reasons(file({ header: `${without}\nconcept: open source`, body: HARDENED }))).toEqual(
      [],
    );
  });

  it("makes a change to an existing project name the documents it was checked against", () => {
    const change = `${HEADER}\nscope: change`;
    expect(reasons(file({ header: change, body: HARDENED }))).toEqual(["forge_scope"]);
    const linked = change.replace("links: []", "links: [kb-index]");
    expect(reasons(file({ header: linked, body: HARDENED }))).toEqual([]);
    expect(reasons(file({ header: `${HEADER}\nscope: both`, body: HARDENED }))).toEqual([
      "forge_scope",
    ]);
  });

  it("refuses an id that is not the file's, a wrong owner and a wrong kind", () => {
    const header =
      "id: forge-other\nkind: epic\nowner: sam\nlinks: []\nlanguage: en\nconcept: internal";
    expect(reasons(file({ header, body: HARDENED })).sort()).toEqual([
      "forge_id",
      "forge_kind",
      "forge_owner",
    ]);
  });

  it("leaves alone the other notes of the folder", () => {
    expect(
      check({
        [`${IDEATION_DIR}2026-10-01-names.md`]:
          "---\nid: names\nkind: note\nowner: lou\nlinks: [kb-index]\n---\n# Names\nAnything.\n",
      }).problems,
    ).toEqual([]);
  });
});
