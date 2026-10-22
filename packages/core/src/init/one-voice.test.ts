import { describe, expect, it } from "vitest";
import { renderConstitutionReference } from "../index.js";

/** One voice for the whole team, and the validations asked once. */

const flat = (text: string) => text.replace(/\s+/g, " ");

/** The one sentence of the constitution that names the forbidden forms, to forbid them. */
const FORBIDDEN_FORMS_RULE = "never « vous », « votre » nor « vos »";

/** The formal forms of address (« vous », « votre », « vos », « dites-vous »). */
const FORMAL_FORMS = /(?<!\p{L})(vous|votre|vos|vôtre|vôtres)(?!\p{L})|-vous(?!\p{L})/iu;

const withNoah = renderConstitutionReference([], undefined, { tools: ["claude-code"] });
const withoutNoah = renderConstitutionReference();

describe("the constitution's single voice", () => {
  it.each([
    ["with Noah", withNoah],
    ["without Noah", withoutNoah],
  ])("tells every agent to say « tu » to the creator in French, always (%s)", (_name, text) => {
    const rule = flat(text);
    expect(rule).toContain("One voice for the whole team");
    expect(rule).toContain("When the creator speaks French, every agent");
    expect(rule).toContain("says « tu » to them, always");
    expect(rule).toContain(FORBIDDEN_FORMS_RULE);
    expect(rule).toContain("No setting changes it, and a handover does not either");
  });

  it("names Noah in the rule only while Noah is installed", () => {
    expect(flat(withNoah)).toContain("every agent and Noah says « tu »");
    expect(flat(withoutNoah)).toContain("every agent says « tu »");
    expect(withoutNoah).not.toContain("Noah");
  });

  it("never addresses the creator with « vous » in its French examples", () => {
    for (const text of [withNoah, withoutNoah]) {
      expect(flat(text).split(FORBIDDEN_FORMS_RULE).join("")).not.toMatch(FORMAL_FORMS);
    }
  });
});

describe("the constitution's choices and approvals", () => {
  const text = flat(withNoah);

  it("opens the checkpoint before any question of choice, informal ones included", () => {
    expect(text).toContain("A question that asks the creator to choose is a decision");
    expect(text).toContain("even when it is asked in passing");
    expect(text).toContain('"qu\'en dis-tu ?"');
    expect(text).toContain("open the `decision` checkpoint first");
    expect(text).toContain('the creator\'s "ok" would not count');
    // A role that cannot open a checkpoint asks on an open one, or hands the choice over.
    expect(text).toContain("hand any other choice to the agent that owns the subject");
  });

  it("takes a plain approval of a recommendation for the recommended option", () => {
    expect(text).toContain("A plain approval is an answer");
    expect(text).toContain('"ok", "oui", "vas-y", "d\'accord", "parfait"');
    expect(text).toContain("`decision: option_chosen`");
    expect(text).toContain("`option` set to the id of your recommendation");
    expect(text).toContain("their whole message");
    expect(text).toContain('"ok" is `decision: approved`');
    expect(text).toContain("when your question carried no recommendation");
    expect(text).toContain("Silence is never an approval");
    // The doubt, the refusal, the question and a changed recommendation are asked again.
    expect(text).toContain("a condition, a hesitation, a refusal or a question");
    expect(text).toContain("when your recommendation changed since the point opened");
    // A plain approval is the whole answer, even for an irreversible action.
    expect(text).toContain(
      "A plain approval is the whole answer, even for an action that cannot be undone",
    );
    expect(text).not.toContain("repeated confirmation");
    // Noah's essentials no longer refuse the recommendation outright (his rule is in his role).
    expect(text).not.toContain("never pick your recommendation for them");
  });
});

describe("the constitution's validation of a structuring document", () => {
  const text = flat(renderConstitutionReference());

  it("commits it, opens the point, then asks once", () => {
    expect(text).toContain(
      "A structuring document (a brief, a PRD, a UX specification, an architecture) is validated as soon as it is finished",
    );
    expect(text).toContain("First commit it");
    expect(text).toContain("on a detached HEAD, ask the creator to check one out and open nothing");
    expect(text).toContain(
      'signed with the name and the email the creator gave ("Talking with the creator", step 5)',
    );
    expect(text).toContain("Then open the validation point");
  });

  it("opens a document point, or the single phase_end when the document is the last of its phase", () => {
    expect(text).toContain("it opens a `document` checkpoint (a low risk, no story, no blocks");
    expect(text).toContain(
      "except when it is the last document of its phase and that phase is the current one",
    );
    expect(text).toContain("the brief in framing, the UX specification in planning");
    expect(text).toContain("the architecture in design (when Chloé is not active");
    expect(text).toContain(
      "It then opens the single `phase_end` checkpoint that cites it in `documents`, and no `document` point",
    );
    expect(text).toContain("the answer approves the document and closes the phase");
    expect(text).toContain("(Stella for the UX specification, even when Maya is active)");
    expect(text).toContain(
      "A document of a phase already closed (an update made later) takes a `document` point",
    );
  });

  it("handles an open, a refused and an unchanged document", () => {
    expect(text).toContain(
      "The answer to a `document` point approves the document, even though the phase goes on",
    );
    expect(text).toContain("`DOCUMENT_REVIEW_OPEN`");
    expect(text).toContain("Never open two `document` points on the same `blob_sha`");
    expect(text).toContain("never ask for it again");
    expect(text).toContain(
      "the `blob_sha` of its approved point equals `git rev-parse HEAD:<path>` and the file is committed",
    );
    expect(text).toContain("`state.next` sends you back to it (`changes_requested`)");
    expect(text).toContain("with `supersedes` set to the refused one's id");
  });

  it("is announced from the section on talking with the creator", () => {
    expect(text).toContain('"Checkpoints in the chat", step 8, says');
  });
});
