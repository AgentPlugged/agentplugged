import { createRequire } from "node:module";
import { dirname } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  type Definition,
  PHASE_SKILL_BASE,
  readDefinitions,
  renderAgentBody,
  resolveAgent,
  skillsOfPhase,
} from "@agentplugged/core";
import { PHASE_IDS } from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The tools get the skills of the current phase only: the list of their descriptions is read at
 * every request. A skill of another phase stays callable: its definition is in
 * `.agentplugged/skills/`, and the menu row that calls it says so.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);

let definitions: Definition[];

beforeAll(async () => {
  const source = new NodeWorkspaceFiles(methodDir);
  const agents = await readDefinitions(source, "agents", "agent");
  const skills = await readDefinitions(source, "skills", "skill");
  if (!Array.isArray(agents) || !Array.isArray(skills)) throw new Error("invalid method");
  definitions = [...agents, ...skills];
});

const names = (list: readonly Definition[]) => list.map((d) => d.name);
const listSize = (list: readonly Definition[]) =>
  list.reduce((sum, d) => sum + d.frontmatterYaml.length, 0);

describe("the skills of the phase", () => {
  it("installs every skill when no phase is read, and every agent in each phase", () => {
    expect(skillsOfPhase(definitions, undefined)).toHaveLength(definitions.length);
    const agents = names(definitions.filter((d) => d.kind === "agent"));
    for (const phase of PHASE_IDS) {
      const installed = names(skillsOfPhase(definitions, { phase, shortPath: false }));
      for (const agent of agents) expect(installed, `${phase}: ${agent}`).toContain(agent);
      for (const skill of PHASE_SKILL_BASE)
        expect(installed, `${phase}: ${skill}`).toContain(skill);
    }
  });

  it("keeps the build's skills out of the framing, and the framing's out of the build", () => {
    const framing = names(skillsOfPhase(definitions, { phase: "framing", shortPath: false }));
    const build = names(skillsOfPhase(definitions, { phase: "build", shortPath: false }));
    expect(framing).toContain("write-brief");
    expect(framing).not.toContain("develop-story");
    expect(build).toContain("develop-story");
    expect(build).not.toContain("write-brief");
    expect(build).not.toContain("write-sales");
    // Stories are still built while the delivery runs.
    expect(names(skillsOfPhase(definitions, { phase: "delivery", shortPath: false }))).toContain(
      "develop-story",
    );
    // On the short path the spec and its reviews come with the build.
    const short = names(skillsOfPhase(definitions, { phase: "build", shortPath: true }));
    for (const skill of ["write-spec", "security-review-architecture", "critique-deliverable"]) {
      expect(short, skill).toContain(skill);
    }
  });

  it("shortens the list read at every request, and leaves no skill unreachable", () => {
    const all = listSize(definitions);
    for (const phase of PHASE_IDS) {
      const size = listSize(skillsOfPhase(definitions, { phase, shortPath: false }));
      expect(size, phase).toBeLessThan(all * 0.8);
    }
    // Every skill is installed in some phase: none is left only to its file.
    const reached = new Set(
      PHASE_IDS.flatMap((phase) => names(skillsOfPhase(definitions, { phase, shortPath: false }))),
    );
    for (const skill of definitions.filter((d) => d.kind === "skill")) {
      expect(reached.has(skill.name), skill.name).toBe(true);
    }
  });

  it("sends a menu row of another phase to the skill's definition", () => {
    const iris = definitions.find((d) => d.name === "iris") as Definition;
    const skill = resolveAgent(iris).agent.menu.find((item) => item.skill !== undefined)?.skill;
    if (skill === undefined) throw new Error("Iris calls no skill");
    const installed = renderAgentBody(resolveAgent(iris));
    expect(installed).toContain(`Skill \`${skill}\``);
    const away = renderAgentBody({ ...resolveAgent(iris), uninstalledSkills: new Set([skill]) });
    expect(away).toContain(`Read and follow \`.agentplugged/skills/${skill}/SKILL.md\``);
    expect(away).not.toContain(`| Skill \`${skill}\` |`);
  });
});
