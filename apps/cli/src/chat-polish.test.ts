import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { type Definition, readDefinitions } from "@agentplugged/core";
import { beforeAll, describe, expect, it } from "vitest";
import { noahCorpus } from "./__helpers__/noah-text.js";
import { SHARED_RULES_POINTER, sharedRules } from "./__helpers__/shared-rules.js";

/** The shipped method polishes the conversation in the chat. */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);

const flat = (text: string) => text.replace(/\s+/g, " ");
const read = (path: string) => flat(readFileSync(join(methodDir, path), "utf8"));

let skills: Definition[];
let agents: Definition[];

beforeAll(async () => {
  const source = new NodeWorkspaceFiles(methodDir);
  const shippedSkills = await readDefinitions(source, "skills", "skill");
  const shippedAgents = await readDefinitions(source, "agents", "agent");
  if (!Array.isArray(shippedSkills) || !Array.isArray(shippedAgents)) {
    throw new Error("invalid shipped method");
  }
  skills = shippedSkills;
  agents = shippedAgents;
});

describe("every skill that asks the creator for a validation opens the checkpoint first", () => {
  it("carries the rule: each skill points to the shared rules, which name the constitution's section", () => {
    expect(skills.length).toBeGreaterThanOrEqual(12);
    // Written once in the reference, pointed to by every skill.
    const shared = sharedRules();
    expect(shared.toLowerCase()).toContain("open the checkpoint **before** you ask");
    expect(shared).toContain('("Talking with the creator")');
    expect(shared).toContain("Never ask for the same validation twice");
    for (const skill of skills) {
      expect(flat(skill.text), skill.name).toContain(SHARED_RULES_POINTER);
    }
  });

  it("the brief, the PRD and the UX specification ask for the approval once, after the opening", () => {
    for (const id of ["write-brief", "write-prd", "write-ux-spec"]) {
      const text = read(`skills/${id}/SKILL.md`);
      expect(text, id).toContain("Do not ask them to approve it here");
      expect(text, id).toContain("Open it first, then ask the creator whether");
    }
    // No step still makes the creator agree before the end of phase is open.
    expect(read("skills/write-brief/SKILL.md")).not.toContain("until the creator says it reflects");
    expect(read("skills/write-prd/SKILL.md")).not.toContain("revise until the creator agrees");
    expect(read("skills/write-ux-spec/SKILL.md")).not.toContain("revise until the creator agrees");
  });

  it("the architecture, the breakdown, the sprint and the knowledge base ask after the opening", () => {
    expect(read("skills/split-into-stories/SKILL.md")).toContain(
      "Only once the checkpoints are open, ask the creator whether the breakdown suits them",
    );
    expect(read("skills/plan-sprint/SKILL.md")).toContain(
      "Ask whether the sprint suits them only now, once, since the checkpoint is open",
    );
    expect(read("skills/generate-knowledge-base/SKILL.md")).toContain(
      "the checkpoint being open, ask once whether the base suits them",
    );
    expect(read("agents/alex/agent.yaml")).toContain(
      "Open the checkpoint first, then ask them once",
    );
  });
});

describe("Noah, the main session's assistant", () => {
  const noah = () => {
    if (!agents.some((definition) => definition.name === "noah")) {
      throw new Error("Noah is not shipped");
    }
    // His definition and its references, where the detail of his work is read from.
    return flat(noahCorpus(methodDir));
  };

  it("begins every message with his icon and his name, and says each handover both ways", () => {
    const text = noah();
    expect(text).toContain(
      "Every message he writes to the creator begins with his icon and his name",
    );
    expect(text).toContain("announced in both directions");
    expect(text).toContain("🔎 Iris : I give the hand back to Noah.");
  });

  it("waits while the work is out and works again when the hand comes back", () => {
    const text = noah();
    expect(text).toContain("declares himself `waiting` with `agent.status` while the work is out");
    expect(text).toContain("`working` again as soon as the hand comes back to him");
    expect(text).toContain("declare yourself `waiting` with `agent.status`, then hand over");
    expect(text).toContain("declare yourself `working` again");
  });

  it("offers a fresh conversation per phase, resumes without asking again, keeps talks in the conversation", () => {
    const text = noah();
    expect(text).toContain("One conversation per phase, to spare the creator's tokens");
    expect(text).toContain("When a phase ends");
    expect(text).toContain("everything is saved in the documents and the journal");
    expect(text).toContain("starting from an empty context costs less");
    expect(text).toContain("Let's pick up");
    expect(text).toContain("without asking again what was already decided");
    expect(text).toContain("never in the middle of a question he asked the creator");
    expect(text).toContain("a sub-agent cannot talk with the creator");
    expect(text).toContain("relaying every message would cost more");
    // What depends on the AI tool lives in the generated constitution, never in his definition.
    expect(text).not.toContain("/clear");
  });

  it("keeps the engine's inner workings to himself and shows local time", () => {
    const text = noah();
    expect(text).toContain("keeps the engine's inner workings to himself");
    expect(text).toContain("unless one of them blocks an action");
    expect(text).toContain("in the creator's local time (`clock` in `state.get`), never in UTC");
    expect(text).toContain(
      'never asks the creator "does it suit you?" about a document whose checkpoint is not open',
    );
  });
});
