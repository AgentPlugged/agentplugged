import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { readDefinitions } from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { MEMORY_INVALID_REASONS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { withNoah } from "./__helpers__/noah-text.js";
import { SHARED_RULES_POINTER, sharedRules } from "./__helpers__/shared-rules.js";

/** The shipped method: the `@agentplugged/method` package of the monorepo. */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const flat = (text: string) => text.replace(/\s+/g, " ");
const read = withNoah(methodDir, (path: string) =>
  readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n"),
);

describe("the run-retrospective skill", () => {
  it("ships as Izzy's skill, called from her RT item, with eight items", async () => {
    const files = new NodeWorkspaceFiles(methodDir);
    const skills = await readDefinitions(files, "skills", "skill");
    const agents = await readDefinitions(files, "agents", "agent");
    if (!Array.isArray(skills) || !Array.isArray(agents)) throw new Error("invalid method");
    const skill = skills.find((definition) => definition.name === "run-retrospective");
    expect(skill?.frontmatter).toMatchObject({ metadata: { agent: "izzy", phase: "build" } });
    const izzy = agents.find((definition) => definition.name === "izzy");
    expect(izzy?.agent?.menu.find((entry) => entry.code === "RT")?.skill).toBe("run-retrospective");
    expect(izzy?.agent?.menu.length).toBe(8);
    // The readiness check of the old RD item is the first step of the breakdown.
    expect(izzy?.agent?.menu.some((entry) => entry.code === "RD")).toBe(false);
    expect(flat(read("skills/split-into-stories/SKILL.md"))).toContain(
      "Step 1: check that the plan can be cut",
    );
  });

  it("goes through the engine only: proposal, approval in the chat, record, promotion", () => {
    const text = flat(read("skills/run-retrospective/SKILL.md"));
    for (const term of [
      "`agent: izzy`",
      "`memory.read`",
      "`memory.retrospective`",
      "`memory.record`",
      "`memory.promote_propose`",
      "`memory.promote`",
      "`chat.answer`",
      "`approved_with_reservations`",
      "`except`",
      "`replaces`",
      "`retire`",
      "`scope_not_finished`",
      "`chat.ask`",
      "npx agentplugged next --json",
      "`story.result`",
      "counts only",
      "every product of theirs on this machine will read it",
      "Never promote several lessons in one checkpoint",
      "Never copy a lesson or an action into a document",
      "Hand back to Noah",
    ]) {
      expect(text, term).toContain(term);
    }
    // The checkpoint is open before the creator is asked, whole and once.
    expect(text).toContain("**Only now**, with the checkpoint open");
  });

  it("names no language, framework nor tool", () => {
    const text = read("skills/run-retrospective/SKILL.md");
    expect(text).not.toMatch(/\b(typescript|javascript|python|rust|react|django|rails|docker)\b/i);
  });

  it("tells every agent to read the memory first, and Noah to leave the retrospectives to Izzy", () => {
    const noah = flat(read("agents/noah/SKILL.md"));
    expect(noah).toContain("`state.get`, `state.next` and `memory.read` to read");
    expect(noah).toContain("The retrospectives belong to Izzy");
    expect(noah).toContain("He never records a lesson, proposes one nor promotes one himself");
    // The rule is written once in the reference; each skill points to it.
    expect(sharedRules()).toContain(
      "At the start of the task, call `memory.read` with your agent id",
    );
    for (const skill of ["develop-story", "plan-sprint", "write-prd", "review-story"]) {
      expect(flat(read(`skills/${skill}/SKILL.md`)), skill).toContain(SHARED_RULES_POINTER);
      expect(flat(read(`skills/${skill}/SKILL.md`)), skill).toContain("start with `memory.read`");
    }
    expect(read("README.md")).toContain("| `run-retrospective` | Izzy (`RT`) | build |");
  });
});

describe("the texts of the memory", () => {
  const fr = createTranslator("fr");
  const en = createTranslator("en");
  const details = {
    scope: "epic 4",
    status: "open",
    lesson: "L-7M2K9QX4TB-1",
    active: 100,
    checkpoint: "G-7M2K9QX4TB",
    common: "C-7M2K9QX4TB",
  };

  it("explains every refusal, in French with « tu » and in English", () => {
    for (const reason of MEMORY_INVALID_REASONS) {
      const key = `error.memory_invalid.${reason}` as Parameters<typeof fr>[0];
      const french = fr(key, details);
      expect(french, reason).not.toBe(key);
      expect(french, reason).toContain("Rien n'a été écrit");
      expect(french, reason).not.toMatch(/\b(vous|votre|vos)\b/i);
      const english = en(key, details);
      expect(english, reason).not.toBe(key);
      expect(english, reason).toContain("Nothing was written");
    }
  });

  it("names the memory checkpoint and the new steps", () => {
    expect(fr("checkpoint.type.memory")).toBe("mémoire");
    expect(en("checkpoint.type.memory")).toBe("memory");
    expect(fr("next.step.retrospective")).toContain("Rétrospective");
    expect(en("next.step.memory_record")).toContain("memory");
  });
});
