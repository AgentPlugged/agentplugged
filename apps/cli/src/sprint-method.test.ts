import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { readDefinitions, renderConstitutionReference } from "@agentplugged/core";
import { describe, expect, it } from "vitest";

/** The shipped method: the `@agentplugged/method` package of the monorepo. */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const flat = (text: string) => text.replace(/\s+/g, " ");
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");

describe("the plan-sprint skill", () => {
  it("ships as Izzy's skill, called from her SP item", async () => {
    const skills = await readDefinitions(new NodeWorkspaceFiles(methodDir), "skills", "skill");
    if (!Array.isArray(skills)) throw new Error(JSON.stringify(skills.details));
    const skill = skills.find((definition) => definition.name === "plan-sprint");
    expect(skill?.frontmatter).toMatchObject({ metadata: { agent: "izzy", phase: "build" } });
    const agents = await readDefinitions(new NodeWorkspaceFiles(methodDir), "agents", "agent");
    if (!Array.isArray(agents)) throw new Error(JSON.stringify(agents.details));
    const izzy = agents.find((definition) => definition.name === "izzy");
    const item = izzy?.agent?.menu.find((entry) => entry.code === "SP");
    expect(item?.skill).toBe("plan-sprint");
    expect(item?.prompt).toBeUndefined();
  });

  it("records the sprint in the journal, checked by plan.sprint, and never in a file", () => {
    const text = flat(read("skills/plan-sprint/SKILL.md"));
    for (const term of [
      "`agent: izzy`",
      "`plan.sprint`",
      "`SPRINT_INVALID`",
      "`not_validated`",
      "`dependency_later`",
      "`proposal_open`",
      "`profile.specialties`",
      "npx agentplugged docs check",
      "npx agentplugged next --json",
      "`story.result`",
    ]) {
      expect(text, term).toContain(term);
    }
    const izzy = `${read("agents/izzy/SKILL.md")}\n${read("agents/izzy/agent.yaml")}`;
    expect(izzy).not.toContain("sprint-plan.md");
    expect(flat(izzy)).toContain("`plan.sprint`");
    expect(read("README.md")).toContain("| `plan-sprint` | Izzy (`SP`) | build |");
  });

  it("tells every agent to record a sprint only with plan.sprint", () => {
    const constitution = flat(renderConstitutionReference());
    expect(constitution).toContain("Record a sprint only with `plan.sprint`");
    expect(constitution).toContain("`SPRINT_INVALID`");
  });
});
