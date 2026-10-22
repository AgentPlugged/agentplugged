import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  createCommandRegistry,
  type Definition,
  NOAH_COMMANDS,
  RESPONSE_FORMS,
  readDefinitions,
} from "@agentplugged/core";
import { publishedTools } from "@agentplugged/mcp";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The bounded loop is Noah's, in a short skill and two short references; its tool is
 * an action of `story`, not a tool; only Noah hands work over; an agent calls the skills it
 * declares; and a turn of the loop costs a few hundred characters.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
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

/** Every text file of the method, with its relative path. */
function methodTexts(dir = methodDir, base = ""): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) return methodTexts(join(dir, entry.name), path);
    return /\.(md|yaml)$/.test(entry.name) ? [{ path, text: read(path) }] : [];
  });
}

describe("the skill chain-stories", () => {
  it("ships for Noah (and Izzy for the merge order), short, with its detail in references it names", () => {
    const skill = skills.find((definition) => definition.name === "chain-stories");
    expect(skill?.frontmatter).toMatchObject({ metadata: { agent: "noah izzy", phase: "build" } });
    const description = (skill?.frontmatter ?? { description: "" }) as { description: string };
    expect(description.description.length).toBeLessThanOrEqual(180);
    const body = read("skills/chain-stories/SKILL.md");
    expect(body.length).toBeLessThanOrEqual(2_400);
    const dir = join(methodDir, "skills", "chain-stories", "references");
    expect(readdirSync(dir).sort()).toEqual(["attempts.md", "merge-order.md", "stops.md"]);
    for (const file of readdirSync(dir)) {
      expect(body, file).toContain(`references/${file}`);
      expect(read(`skills/chain-stories/references/${file}`).length, file).toBeLessThanOrEqual(
        2_500,
      );
    }
  });

  it("is an action of the tool story, with no tool added, and Noah's contract names it", () => {
    const tools = publishedTools(
      new Map(
        createCommandRegistry()
          .agentCommands()
          .map((command) => [command.name, command] as const),
      ),
    );
    const story = tools.find((tool) => tool.name === "story");
    const properties = (story?.schema.properties ?? {}) as { action?: { enum?: string[] } };
    expect(properties.action?.enum).toContain("loop");
    // The fields are the ones the tool already publishes: nothing new on the list.
    const fields = Object.keys(story?.schema.properties ?? {});
    for (const field of ["story", "seen", "note", "agent"]) expect(fields).toContain(field);
    expect(fields).not.toContain("approach");
    expect(fields).not.toContain("result_of");
    expect(NOAH_COMMANDS.has("loop")).toBe(true);
    expect(read("agents/noah/SKILL.md")).toContain("`story.loop`");
  });

  it("names every stop the engine can answer, in the reference that presents them", () => {
    const stops = read("skills/chain-stories/references/stops.md");
    for (const reason of [
      "validation",
      "decision",
      "merge",
      "spend",
      "irreversible",
      "command",
      "gap",
      "creator_step",
      "attempts",
      "blocked",
      "outside",
    ]) {
      expect(stops, reason).toContain(`\`${reason}\``);
    }
  });

  it("answers a turn in a few hundred characters", () => {
    const run = {
      verdict: "run",
      step: "build",
      agent: "sam",
      story: "17-17",
      waiting: 2,
      attempts: { failed: 2, limit: 3 },
      tried: ["recompute the total at checkout, in the cart service", "cache the total in memory"],
      until: "1:green 2:green 3:red 4:no_test 5:untestable 6:never_red 7:green(reported)",
      line: "build · story 17-17 · sam. 2 points wait for the creator.",
    };
    const stop = {
      verdict: "stop",
      reason: "merge",
      subject: "G-7M2K9QX4TB",
      waiting: 3,
      point: { done: 4, decided: 2, deferred: 5 },
      line: "Stopped (merge) at G-7M2K9QX4TB. 3 points wait for the creator. Since you last answered: 4 stories done, 2 points decided by the agents, 5 deferred items open.",
    };
    const max = RESPONSE_FORMS["story.loop"]?.max ?? 0;
    expect(max).toBeGreaterThan(0);
    expect(JSON.stringify(run).length).toBeLessThanOrEqual(max);
    expect(JSON.stringify(stop).length).toBeLessThanOrEqual(max);
    // Typical turn: well under half the ceiling.
    expect(JSON.stringify(stop).length).toBeLessThan(400);
  });
});

describe("the delegation is bounded in the method itself", () => {
  it("lets only Noah, and the skills he owns, tell anyone to hand work over", () => {
    const noahOwned = new Set(
      skills
        .filter((skill) =>
          String((skill.frontmatter as { metadata?: { agent?: string } }).metadata?.agent ?? "")
            .split(" ")
            .includes("noah"),
        )
        .map((skill) => skill.name),
    );
    expect(noahOwned.has("chain-stories")).toBe(true);
    const offenders = methodTexts()
      .filter(({ path }) => {
        if (path.startsWith("agents/noah/")) return false;
        const skill = /^skills\/([^/]+)\//.exec(path)?.[1];
        return skill === undefined || !noahOwned.has(skill);
      })
      .filter(({ text }) => /agent\.delegate|`delegate`/.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("lets Noah call only the skills his menu declares, and each skill name agents that exist", () => {
    const noah = agents.find((agent) => agent.name === "noah");
    for (const item of noah?.agent?.menu ?? []) {
      if (item.skill === undefined) continue;
      const skill = skills.find((definition) => definition.name === item.skill);
      expect(skill, `noah calls ${item.skill}`).toBeDefined();
      const declared = (skill?.frontmatter ?? {}) as { metadata?: { agent?: string } };
      const owners = String(declared.metadata?.agent ?? "").split(" ");
      expect(owners, `${item.skill} is declared by noah?`).toContain("noah");
    }
    // Every skill is run by agents of the method: none is left to an agent that does not exist.
    const known = new Set(agents.map((agent) => agent.name));
    for (const skill of skills) {
      const owners = String(
        (skill.frontmatter as { metadata?: { agent?: string } }).metadata?.agent ?? "",
      )
        .split(" ")
        .filter((owner) => owner !== "");
      for (const owner of owners) expect(known.has(owner), `${skill.name}: ${owner}`).toBe(true);
    }
  });

  it("keeps the references of the skill where the skill is", () => {
    expect(existsSync(join(methodDir, "skills", "chain-stories", "SKILL.md"))).toBe(true);
  });
});
