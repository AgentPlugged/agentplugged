import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  activeDefinitions,
  type Definition,
  readDefinitions,
  renderAgentBody,
  renderConstitutionReference,
  resolveAgent,
  resolveProfile,
} from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { METHOD_FORMAT_VERSION, type MethodConfig } from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { noahCorpus } from "./__helpers__/noah-text.js";

/** The developers build a story from the story alone, with the develop-story skill. */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const SKILL = "develop-story";
/** The developers by specialty. */
const DEVELOPERS: readonly string[] = ["sam", "ethan", "hugo", "lina", "jade"];
const flat = (text: string) => text.replace(/\s+/g, " ");
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");

let agents: Definition[];
let skills: Definition[];

beforeAll(async () => {
  const source = new NodeWorkspaceFiles(methodDir);
  const shippedAgents = await readDefinitions(source, "agents", "agent");
  const shippedSkills = await readDefinitions(source, "skills", "skill");
  if (!Array.isArray(shippedAgents) || !Array.isArray(shippedSkills)) {
    throw new Error("invalid shipped method");
  }
  agents = shippedAgents;
  skills = shippedSkills;
});

const agentNamed = (id: string) => {
  const found = agents.find((definition) => definition.name === id);
  if (found === undefined) throw new Error(`${id} is not shipped`);
  return found;
};

describe("the develop-story skill", () => {
  it("ships for the developers, called from each one's MK", () => {
    const skill = skills.find((definition) => definition.name === SKILL);
    expect(skill?.frontmatter).toMatchObject({
      metadata: { agent: "sam ethan hugo lina jade", phase: "build" },
    });
    for (const id of DEVELOPERS) {
      const item = agentNamed(id).agent?.menu.find((entry) => entry.code === "MK");
      expect(item?.skill, id).toBe(SKILL);
      expect(item?.prompt, id).toBeUndefined();
      expect(flat(read(`agents/${id}/agent.yaml`)), id).toContain("skill: develop-story");
    }
    expect(read("README.md")).toContain(
      "| `develop-story` | Sam, Ethan, Hugo, Lina, Jade (`MK`) | build |",
    );
  });

  it("ends with a short summary the creator reads, which never hides a failure", () => {
    const skill = flat(read("skills/develop-story/SKILL.md"));
    expect(skill).toContain("800 characters at most, the outcome first");
    expect(skill).toContain("it never hides a failure");
    expect(skill).toContain("the long account goes in `story.progress` and the pull request");
    // Noah tells that summary, not the detail, and a partial or blocked result first.
    const noah = flat(noahCorpus(methodDir));
    expect(noah).toContain("`story.result` summary (800 characters at most");
    expect(noah).toContain("a partial or blocked result is said as such, before anything else");
    expect(noah).toContain(
      "The detail (the progress notes, the pull request, the review) stays one call away",
    );
  });

  it("reaches every developer of the specialties at work", () => {
    const config = {
      format_version: METHOD_FORMAT_VERSION,
      engine_version: "1.0.0",
      profile: resolveProfile("new-product", { specialties: ["backend", "mobile"] }),
      agents: { inactive: ["hugo", "lina"] },
    } as MethodConfig;
    const active = activeDefinitions([...agents, ...skills], config).filter((definition) =>
      DEVELOPERS.includes(definition.name),
    );
    expect(active.map((definition) => definition.name).sort()).toEqual(["ethan", "jade", "sam"]);
    for (const definition of active) {
      const item = resolveAgent(definition).agent.menu.find((entry) => entry.code === "MK");
      expect(item?.skill, definition.name).toBe(SKILL);
      expect(item?.prompt, definition.name).toBeUndefined();
      expect(renderAgentBody(resolveAgent(definition)), definition.name).toContain(SKILL);
    }
  });

  it("keeps its sections in order", () => {
    const headings = read(`skills/${SKILL}/SKILL.md`)
      .split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings).toEqual([
      "## Before you start",
      "## Decisions",
      "## Resume",
      "## Steps",
      "## Budget",
      "## Never",
    ]);
  });

  it("builds from the story and what it cites, in the story's working copy", () => {
    const text = flat(read(`skills/${SKILL}/SKILL.md`));
    for (const term of [
      // A fresh context: the story and what it cites, never a conversation.
      "Forget the conversation",
      "only what it cites",
      ".agentplugged/docs/index.md",
      "`story.start`",
      "`workdir`",
      "`STORY_NOT_STARTABLE`",
      "`STORY_LOCKED`",
      "npx agentplugged docs check",
      // Tests first, commits that cite the story, progress.
      "watch it fail for the right reason",
      "`feat(2-3): sign-in form (EF-12)`",
      "`story.progress`",
      // A decision instead of a guess, the intent untouched.
      "`type: decision`",
      "`story.review`",
      "Never edit the `## Intent`",
      "`STORY_INTENT_CHANGED`",
      "references/self-check.md",
      // A structured result that moves the story to review; no cost is announced.
      "`measure.cost`",
      "`story.result`",
      "moves the story to review",
      // A story marked blocked goes back in progress before its result.
      "`story.status` with `in_progress` again",
      "`CHECKPOINT_OPEN`",
      "npx agentplugged next --json",
      // Resuming from the journal and the branch.
      "`git log`",
    ]) {
      expect(text, term).toContain(term);
    }
    // No pull request, no push, no merge: later stories.
    expect(text).toContain("never push, force-push, open the pull request or merge");
    const check = flat(read(`skills/${SKILL}/references/self-check.md`));
    expect(check).toContain("`git show <blob_sha>`");
    expect(check).toContain("only that section");
    expect(check).not.toContain("checkout");
    expect(check).toContain("`STORY_INTENT_CHANGED`");
  });

  it("writes the test of each criterion first, from its words, and the engine sees it fail", () => {
    const text = flat(read(`skills/${SKILL}/SKILL.md`));
    for (const term of [
      // A scenario per criterion, from its words alone; untestable with its reason.
      "a scenario drawn from its words alone",
      "declared untestable with its reason",
      "`seen: untestable`",
      // The id of the criterion in the test's name, in any language; the engine records the red, then the green.
      "never the code",
      "`AC-4-2-1`",
      "`AC_4_2_1` where a name takes no dash",
      "`story.criterion`: the engine runs the project's test command and records the red",
      "`story.criterion` again: the green",
      // The detail is read when needed, not carried.
      "`references/acceptance-tests.md`",
      "`CRITERIA_NOT_PROVEN`",
      "the engine saw failing, then passing",
    ]) {
      expect(text, term).toContain(term);
    }
    const detail = flat(read(`skills/${SKILL}/references/acceptance-tests.md`));
    for (const term of [
      "words of the criterion alone",
      "`AC-<story>-<n>`",
      "`AC-4-2-1`",
      "`AC_4_2_1`",
      "for the right reason",
      "`never_red`",
      "`{criterion}`",
      "marked `reported`",
      "`covered`",
      "`CRITERIA_NOT_PROVEN`",
      "does not recompute it",
    ]) {
      expect(detail, term).toContain(term);
    }
    // The quick lane does not ask for a red when a test already covers the criterion.
    expect(flat(read("skills/quick-lane/SKILL.md"))).toContain("needs no red");
    // The judge takes the engine's trace as it is.
    const judge = flat(read("skills/review-story/references/judge.md"));
    expect(judge).toContain("`trace`");
    expect(judge).toContain("never recompute it");
    expect(flat(read("skills/review-story/SKILL.md"))).toContain("`criteria` with their `trace`");
    // The self-check asks for the engine's red and green.
    expect(flat(read(`skills/${SKILL}/references/self-check.md`))).toContain("by the engine");
  });

  it("tells every agent that a complete result moves its story to review", () => {
    const constitution = flat(renderConstitutionReference());
    expect(constitution).toContain(
      "Your `complete` result on a story you started (`story.start`) and that is `in_progress` moves it to `in_review` too.",
    );
    expect(constitution).toContain("(`STORY_INTENT_CHANGED`)");
  });

  it("explains a changed intent on the branch in both languages", () => {
    for (const lang of ["fr", "en"] as const) {
      const text = createTranslator(lang)("error.story_intent_changed.on_branch", {
        story: "1-3",
        branch: "feat/1-3-work",
        checkpoint: "G-0000000001",
      });
      expect(text, lang).toContain("feat/1-3-work");
      expect(text, lang).toContain("G-0000000001");
      expect(text, lang).not.toMatch(/\{[a-z_]+\}/);
    }
    // Addressed to the agent: the creator approved the intent.
    expect(createTranslator("fr")("error.story_intent_changed.on_branch", {})).toContain(
      "l'intention que le créateur a validée",
    );
    for (const lang of ["fr", "en"] as const) {
      expect(createTranslator(lang)("error.story_intent_changed.on_branch", {}), lang).toContain(
        "`document`",
      );
    }
  });
});
