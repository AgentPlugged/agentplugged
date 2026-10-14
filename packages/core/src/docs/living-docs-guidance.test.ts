import { TOOL_IDS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import zoeAgent from "../../../../method/agents/zoe/agent.yaml?raw";
import developStory from "../../../../method/skills/develop-story/SKILL.md?raw";
import livingDocs from "../../../../method/skills/generate-knowledge-base/references/living-docs.md?raw";
import zoeSkill from "../../../../method/skills/generate-knowledge-base/SKILL.md?raw";
import quickLane from "../../../../method/skills/quick-lane/SKILL.md?raw";
import { DEFAULT_RULES } from "../index.js";
import { renderConstitution, renderConstitutionReference } from "../init/constitution.js";
import { fallbacksFor } from "../sync/compatibility.js";

/** What the agents are told, in the words the engine writes. */

const fallbacks = fallbacksFor([...TOOL_IDS]);
const assistant = { tools: [...TOOL_IDS] };
const flat = (text: string) => text.replace(/\s+/g, " ");

describe("the agents read the base first, the code when in doubt", () => {
  it("the short constitution says it in one sentence, with the notice's name", () => {
    const short = renderConstitution(fallbacks, DEFAULT_RULES, assistant);
    expect(flat(short)).toContain("is behind: read the code, assert nothing from it");
  });

  it("the reference explains the notice and the background update", () => {
    const text = flat(renderConstitutionReference(fallbacks, DEFAULT_RULES, assistant));
    expect(text).toContain("opens with a late notice");
    expect(text).toContain("`late_pages`");
    expect(text).toContain("`background`");
    expect(text).toContain("no developer waits for it");
  });

  it("the development skills carry the rule", () => {
    for (const skill of [developStory, quickLane]) {
      expect(flat(skill)).toContain("`agentplugged:late`");
      expect(flat(skill)).toContain("assert nothing from that page");
    }
  });
});

describe("Zoé's work", () => {
  const skill = flat(`${zoeSkill} ${livingDocs}`);

  it("builds the base of a new product short and without a question", () => {
    expect(skill).toContain("## A new product");
    expect(skill).toContain("ask nothing");
    expect(skill).toContain("`index.md`, `vision.md` and `conventions.md`");
  });

  it("confronts the documentation of an existing product with the code", () => {
    expect(skill).toContain("## A product with its own documentation");
    expect(skill).toContain("it never enters the base");
    expect(skill).toContain("Documentation found");
  });

  it("updates in the background, by paragraph, and never touches the notice", () => {
    expect(skill).toContain("never makes a story wait");
    expect(skill).toContain("You remove the notice");
    expect(flat(zoeAgent)).toContain("you delete it in the commit");
  });

  it("writes the notes of a delivered version and updates the user guides", () => {
    expect(skill).toContain("## A version delivered");
    expect(skill).toContain("`release_notes`");
    expect(skill).toContain("update the user guides");
    expect(skill).toContain("future help centre");
  });
});
