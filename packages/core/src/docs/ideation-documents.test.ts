import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { checkDocumentsDetailed, type DocumentFile, IDEATION_DIR } from "../index.js";

/** `docs check` on the file of an ideation session, at every stage of its life. */

const SESSION = `${IDEATION_DIR}ideation-onboarding.md`;
const KB = `---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n`;
const HEADER = "id: ideation-onboarding\nkind: note\nowner: lou\nlinks: []\nlanguage: en";

interface Options {
  header?: string;
  next?: string | null;
  stance?: string;
  ideas?: string;
  convergence?: string | null;
  mirror?: string;
  kept?: string;
  question?: string | null;
}

const IDEAS = [
  "### Yes, and",
  "- [creator] Let people try the product before they sign up",
  "- [lou] A guided tour that skips itself when the user already knows",
  "- [creator] A first screen with a single button",
  "### Without its star",
  "- [creator] Remove the dashboard and keep only the weekly email",
  "- [creator] No account, a link that keeps the work",
].join("\n");

function session(options: Options = {}): string {
  const next = options.next === undefined ? null : options.next;
  const lines = [
    "# Ideation: onboarding",
    ...(next === null ? [] : [`Next step: ${next}`]),
    `Stance: ${options.stance ?? "exchange"}`,
    ...(options.question === null
      ? []
      : ["## Question", "How do new users reach their first result faster?"]),
    "## Ideas",
    options.ideas ?? IDEAS,
    ...(options.convergence === null || options.convergence === undefined
      ? []
      : ["## Convergence", options.convergence]),
    "## Mirror",
    options.mirror ??
      "You said: Let people try the product before they sign up. And: A first screen with a single button. And: No account, a link that keeps the work.\n\nLink: the first and the third are one idea, the product without a door.",
    "## Kept",
    options.kept ??
      "- No account, a link that keeps the work → hypothesis\n- A first screen with a single button → story",
  ];
  return `---\n${options.header ?? HEADER}\n---\n${lines.join("\n\n")}\n`;
}

function check(files: Record<string, string>) {
  const current: DocumentFile[] = Object.entries({
    ".agentplugged/docs/index.md": KB,
    ...files,
  }).map(([path, text]) => ({ path, text }));
  return checkDocumentsDetailed({ current, owners: new Set(["lou", "zoe"]) });
}
const reasons = (text: string, path = SESSION) =>
  check({ [path]: text })
    .problems.filter((problem) => problem.code === ErrorCode.LAUNCH_DOCUMENT_INVALID)
    .map((problem) => problem.details.reason);

describe("docs check: a session of ideas", () => {
  it("accepts a finished session, and one still going on that holds only its question", () => {
    expect(check({ [SESSION]: session() }).problems).toEqual([]);
    // Saved from the first question: the stance and the question, nothing else yet.
    const started = `---\n${HEADER}\n---\n# Ideation: onboarding\n\nNext step: pick the first technique\nStance: questions\n\n## Question\n\nHow do new users reach their first result faster?\n`;
    expect(check({ [SESSION]: started }).problems).toEqual([]);
  });

  it("accepts a session cut half way: ideas saved, no mirror yet", () => {
    const cut = session({ next: "continue Without its star" });
    const text = cut.replace(/\n## Mirror[\s\S]*$/, "\n");
    expect(reasons(text)).toEqual([]);
  });

  it("asks a finished session for its mirror and for what was kept, but not while it goes on", () => {
    const finished = session().replace(/\n## Kept[\s\S]*$/, "\n");
    expect(reasons(finished)).toEqual(["ideation_section"]);
    expect(reasons(session({ next: "converge" }).replace(/\n## Kept[\s\S]*$/, "\n"))).toEqual([]);
  });

  it("leaves alone a note of the folder that is not a session, and accepts no links", () => {
    expect(
      check({
        [`${IDEATION_DIR}2026-10-01-names.md`]:
          "---\nid: names\nkind: note\nowner: lou\nlinks: [kb-index]\n---\n# Names\nAnything.\n",
      }).problems,
    ).toEqual([]);
    expect(reasons(session())).toEqual([]);
  });

  it("refuses an id that is not the file's, a wrong owner and a wrong kind", () => {
    const header = "id: ideation-other\nkind: epic\nowner: sam\nlinks: []\nlanguage: en";
    expect(reasons(session({ header })).sort()).toEqual([
      "ideation_id",
      "ideation_kind",
      "ideation_owner",
    ]);
  });

  it("needs a stance that is one of the three, in either language", () => {
    expect(reasons(session({ stance: "something else" }))).toEqual(["ideation_stance"]);
    expect(reasons(session({ stance: "proposal" }))).toEqual([]);
    expect(reasons(session({ stance: "échange" }))).toEqual([]);
    const none = session().replace(/Stance: exchange\n\n/, "");
    expect(reasons(none)).toEqual(["ideation_stance"]);
  });

  it("marks who had each idea, and gives Lou no idea in the questions stance", () => {
    const unmarked = IDEAS.replace("- [lou] ", "- ");
    expect(reasons(session({ ideas: unmarked }))).toEqual(["ideation_idea"]);
    // One seed from Lou per technique is the exception the creator may ask for; two are not.
    expect(reasons(session({ stance: "questions" }))).toEqual([]);
    const two = IDEAS.replace(
      "- [creator] A first screen",
      "- [lou] A second seed\n- [creator] A first screen",
    );
    expect(reasons(session({ stance: "questions", ideas: two }))).toEqual(["ideation_stance"]);
    // The next technique gets its own seed.
    const next = `${IDEAS}\n- [lou] A seed under the second technique`;
    expect(reasons(session({ stance: "questions", ideas: next }))).toEqual([]);
    const theirs = IDEAS.replace("- [lou] ", "- [créateur] ");
    expect(reasons(session({ stance: "questions", ideas: theirs }))).toEqual([]);
  });

  it("follows a change of stance made in the middle of the session", () => {
    // Exchange first (Lou gives ideas), then the creator asks for questions only.
    const lou = (n: number) => `- [lou] Idea ${n} of mine`;
    const ideas = `### One\n${lou(1)}\n${lou(2)}\nStance: questions\n### Two\n- [creator] Mine\n${lou(3)}`;
    expect(reasons(session({ stance: "exchange", ideas, mirror: "Mine" }))).toEqual([]);
    // Back in questions, a second seed under the same technique is refused.
    const more = `${ideas}\n${lou(4)}`;
    expect(reasons(session({ stance: "exchange", ideas: more, mirror: "Mine" }))).toEqual([
      "ideation_stance",
    ]);
  });

  it("reads a stance followed by a remark, and an empty line as no stance", () => {
    expect(reasons(session({ stance: "questions (Lou only asks)" }))).toEqual([]);
    expect(reasons(session({ stance: "" }))).toEqual(["ideation_stance"]);
  });

  it("wants the mirror to give back the creator's own ideas, as written", () => {
    expect(reasons(session({ mirror: "Everything was great, here are the themes." }))).toEqual([
      "ideation_mirror",
    ]);
    // Only the idea of Lou given back is not a mirror of the creator.
    const lou = "A guided tour that skips itself when the user already knows.";
    expect(reasons(session({ mirror: lou }))).toEqual(["ideation_mirror"]);
    // Smoothed words are not the creator's words.
    const smoothed =
      "They want a try-before-signup flow, a one-button start and a link without account.";
    expect(reasons(session({ mirror: smoothed }))).toEqual(["ideation_mirror"]);
    // Fewer than three ideas of the creator: all of them are given back.
    const few = "- [creator] One idea only\n- [lou] Another";
    expect(reasons(session({ ideas: few, mirror: "One idea only" }))).toEqual([]);
    expect(reasons(session({ ideas: few, mirror: "Something else" }))).toEqual(["ideation_mirror"]);
  });

  it("names one or two convergence moves of the six, never three, never an unknown one", () => {
    const ok = (convergence: string) => reasons(session({ convergence }));
    expect(ok("Move: group by theme\n\nThree groups.")).toEqual([]);
    expect(ok("Move: impact and effort\n\nMove: New, useful, feasible\n\nScores.")).toEqual([]);
    expect(ok("Mouvement : classement forcé\n\nTop 3.")).toEqual([]);
    expect(ok("Move: plus, minus, interesting\n\nOne idea tested.")).toEqual([]);
    expect(ok("Move: must, should, could, not now\n\nScope.")).toEqual([]);
    expect(ok("Move: group\n\nMove: impact\n\nMove: ranking\n\nToo much.")).toEqual([
      "ideation_move",
    ]);
    expect(ok("Move: tarot reading\n\nVibes.")).toEqual(["ideation_move"]);
    expect(ok("They liked the second group.")).toEqual(["ideation_move"]);
  });

  it("counts every move named on a line, and reads bold labels and French names", () => {
    const ok = (convergence: string) => reasons(session({ convergence }));
    // Three moves on one line are three moves.
    expect(ok("Move: group, impact and ranking\n\nAll at once.")).toEqual(["ideation_move"]);
    expect(ok("**Move:** group by theme\n\nA bold label.")).toEqual([]);
    expect(ok("Mouvement : hiérarchisation forcée\n\nTop 3.")).toEqual([]);
    expect(ok("Mouvement : indispensable, souhaitable, possible\n\nLe périmètre.")).toEqual([]);
    expect(ok("- Move: impact and effort\n- Move: group\n\nTwo as bullets.")).toEqual([]);
  });

  it("needs a gesture on every idea kept, and leaves the choice to the creator", () => {
    expect(reasons(session({ kept: "- A first screen with a single button" }))).toEqual([
      "ideation_kept",
    ]);
    expect(reasons(session({ kept: "- A single button → maybe" }))).toEqual(["ideation_kept"]);
    for (const gesture of [
      "decision",
      "nothing",
      "later",
      "hypothèse",
      "rien",
      "plus tard",
      "story (for Izzy)",
      "**hypothèse** suivie",
    ]) {
      expect(
        reasons(session({ kept: `- A first screen with a single button → ${gesture}` })),
      ).toEqual([]);
    }
  });

  it("lets the creator keep nothing: one plain line is enough", () => {
    expect(reasons(session({ kept: "Nothing kept: none of it fits the product." }))).toEqual([]);
    expect(reasons(session({ kept: "Rien retenu pour l'instant." }))).toEqual([]);
  });

  it("checks a file whatever its slug, and a mirror that quotes distinct ideas", () => {
    // A slug the id cannot match is reported instead of leaving the file unchecked.
    const accented = `${IDEATION_DIR}ideation-idées.md`;
    expect(reasons(session(), accented)).toContain("ideation_id");
    // Three identical ideas are one idea: quoting it once is enough.
    const same = "- [creator] Same thing\n- [creator] Same thing\n- [creator] Same thing";
    expect(reasons(session({ ideas: same, mirror: "Same thing" }))).toEqual([]);
    // A space before French punctuation does not make a different idea.
    const french =
      "- [creator] Et si on partait de zéro ?\n- [creator] Un autre\n- [creator] Encore";
    const mirror = "Et si on partait de zéro? Un autre. Encore.";
    expect(reasons(session({ ideas: french, mirror }))).toEqual([]);
  });

  it("does not take an empty Next step for a session still going on", () => {
    const empty = session().replace(
      "# Ideation: onboarding\n",
      "# Ideation: onboarding\n\nNext step:\n",
    );
    expect(reasons(empty)).toEqual([]);
  });

  it("refuses a template marker left in the file", () => {
    const text = session({ next: "<technique in progress>" });
    const codes = check({ [SESSION]: text }).problems.map((problem) => problem.code);
    expect(codes).toContain(ErrorCode.DOC_PLACEHOLDER_LEFT);
  });
});
