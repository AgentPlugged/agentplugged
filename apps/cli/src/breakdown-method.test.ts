import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { checkDocuments, readDefinitions } from "@agentplugged/core";
import { describe, expect, it } from "vitest";

/** The shipped method: the `@agentplugged/method` package of the monorepo. */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const skillDir = join(methodDir, "skills", "split-into-stories");
const read = (path: string) => readFileSync(join(skillDir, path), "utf8");

const doc = (id: string, kind: string, owner: string, body: string) =>
  `---\nid: ${id}\nkind: ${kind}\nowner: ${owner}\n---\n# ${id}\n\n${body}\n`;

describe("the split-into-stories skill", () => {
  it("ships as a skill with its two templates, copied as they are", async () => {
    const skills = await readDefinitions(new NodeWorkspaceFiles(methodDir), "skills", "skill");
    if (!Array.isArray(skills)) throw new Error(JSON.stringify(skills.details));
    const skill = skills.find((definition) => definition.name === "split-into-stories");
    expect(skill?.annexes).toEqual(["assets/epic.md.tmpl", "assets/story.md.tmpl"]);
  });

  /** The templates filled as Izzy fills them: every `<…>` marker replaced by real text. */
  const fill = (text: string) =>
    text.replace("<short slug>", "sign-in").replace(/<([^<>\n]+)>/g, (_, inner) => `Ada: ${inner}`);

  function checkTemplates(epic: string, story: string) {
    return checkDocuments({
      current: [
        {
          path: ".agentplugged/docs/prd.md",
          text: doc("prd", "prd", "maya", "EF-1 : Ada signs in.\nENF-1 : Pages answer fast."),
        },
        {
          path: ".agentplugged/docs/architecture.md",
          text: doc("architecture", "architecture", "alex", ""),
        },
        { path: ".agentplugged/docs/ux.md", text: doc("ux", "ux", "stella", "") },
        { path: ".agentplugged/epics/epic-1.md", text: epic },
        { path: ".agentplugged/stories/1-1.md", text: story.replace("[EF-1]", "[EF-1, ENF-1]") },
      ],
      owners: new Set(["maya", "alex", "stella", "izzy", "sam", "quentin"]),
    });
  }

  it("gives templates whose headers and sections pass docs check once filled", () => {
    const epic = fill(read("assets/epic.md.tmpl"));
    const story = fill(read("assets/story.md.tmpl"));
    expect(story).not.toMatch(/<[^<>\n]*>/);
    expect(checkTemplates(epic, story)).toEqual([]);
  });

  it("flags the raw templates: every marker left behind", () => {
    const problems = checkTemplates(read("assets/epic.md.tmpl"), read("assets/story.md.tmpl"));
    const codes = new Set(problems.map((problem) => problem.code));
    expect([...codes].sort()).toEqual(["DOC_HEADER_INVALID", "DOC_PLACEHOLDER_LEFT"]);
    // The branch `feat/1-1-<short slug>` is no branch name: the only header problem.
    expect(
      problems
        .filter((problem) => problem.code === "DOC_HEADER_INVALID")
        .map((problem) => problem.details.field),
    ).toEqual(["branch"]);
    const files = new Set(problems.map((problem) => problem.details.path));
    expect([...files].sort()).toEqual([
      ".agentplugged/epics/epic-1.md",
      ".agentplugged/stories/1-1.md",
    ]);
  });

  it("is on Izzy's menu, and names the checks and the checkpoint that end it", async () => {
    const agents = await readDefinitions(new NodeWorkspaceFiles(methodDir), "agents", "agent");
    if (!Array.isArray(agents)) throw new Error(JSON.stringify(agents.details));
    const izzy = agents.find((definition) => definition.name === "izzy");
    expect(izzy?.agent?.menu.find((item) => item.skill === "split-into-stories")?.code).toBe("BS");
    const text = read("SKILL.md").replace(/\s+/g, " ");
    for (const term of [
      "npx agentplugged docs check",
      "REQ_NOT_COVERED",
      "STORY_DEPENDENCY_FORWARD",
      "`type: document`",
      "git rev-parse HEAD:<path>",
      "`out_of_scope`",
      "## Intent",
    ]) {
      expect(text, term).toContain(term);
    }
  });
});
