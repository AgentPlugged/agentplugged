import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  BASE_TOOLS,
  type CourseRecord,
  changeFiles,
  chooseLenses,
  correctionLines,
  createCommandRegistry,
  critiqueStack,
  DEFAULT_RULES,
  type Definition,
  disallowedToolsFor,
  exposedCommands,
  isSensitiveChange,
  leftLines,
  lensDiff,
  missingLines,
  openedAnswer,
  parseDiff,
  planImport,
  planReaders,
  planRun,
  proofUsefulLines,
  RESPONSE_FORMS,
  ResponseMemory,
  readDefinitions,
  readerPasses,
  renderAgentBody,
  renderAgentSkill,
  renderConstitution,
  renderConstitutionReference,
  renderConstitutionReferenceFiles,
  researchLine,
  researchLines,
  resolveAgent,
  type SkillPhase,
  sensitivePath,
  shapeResponse,
  skillsOfPhase,
  type TestsSetupResult,
  TOOL_GROUPS,
  tableOffer,
  toolsCitedIn,
  toolsNeededBy,
  traceLine,
  type UsageReport,
  withToolNotation,
} from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { publishedTools, TOOL_DESCRIPTIONS } from "@agentplugged/mcp";
import { RoomSchema, RoundTableInputSchema, TOOL_IDS } from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { STATE_GET, STATE_NEXT } from "./__helpers__/response-samples.js";
import { formatTestsSetup } from "./tests-text.js";
import { formatUsage } from "./usage-text.js";

/**
 * The manual left the tool descriptions, so every capability and
 * every safety rule must still be somewhere an agent reads it, and the fixed cost of a request
 * stays under the thresholds. Real method, real constitution, real tool list.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const flat = (text: string) => text.replace(/\s+/g, " ");

let definitions: Definition[];

beforeAll(async () => {
  const source = new NodeWorkspaceFiles(methodDir);
  const agents = await readDefinitions(source, "agents", "agent");
  const skills = await readDefinitions(source, "skills", "skill");
  if (!Array.isArray(agents) || !Array.isArray(skills)) throw new Error("invalid method");
  definitions = [...agents, ...skills];
});

const assistant = { tools: [...TOOL_IDS] };
const agentsFile = renderConstitution([], DEFAULT_RULES, assistant);
const reference = renderConstitutionReference([], DEFAULT_RULES, assistant);

/** Every text file of the method, with its relative path. */
function methodTexts(dir = methodDir, base = ""): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) return methodTexts(join(dir, entry.name), path);
    return /\.(md|yaml|tmpl)$/.test(entry.name)
      ? [{ path, text: readFileSync(join(dir, entry.name), "utf8").replace(/\r\n/g, "\n") }]
      : [];
  });
}

describe("the correspondence table: no capability lost", () => {
  it("gives every agents' command a tool and an action, once, and names none that does not exist", () => {
    const commands = createCommandRegistry()
      .agentCommands()
      .map((command) => command.name)
      .sort();
    expect(commands).toHaveLength(65);
    expect(exposedCommands().sort()).toEqual(commands);
    expect(Object.keys(TOOL_GROUPS).length).toBeLessThanOrEqual(12);
    // No command in two actions: the count of actions is the count of commands.
    const actions = Object.values(TOOL_GROUPS).reduce(
      (sum, group) => sum + Object.keys(group.actions).length,
      0,
    );
    expect(actions).toBe(65);
  });

  it("keeps the manual of every action in the reference: description and fields", () => {
    const text = flat(reference);
    for (const command of createCommandRegistry().agentCommands()) {
      const description = flat(withToolNotation(command.description ?? ""));
      expect(text, command.name).toContain(description);
    }
    for (const [tool, group] of Object.entries(TOOL_GROUPS)) {
      expect(reference, tool).toContain(`\n## Tool: ${tool}\n`);
      for (const action of Object.keys(group.actions)) {
        expect(reference, `${tool}.${action}`).toContain(`### \`${tool}.${action}\``);
      }
    }
    // The fields of an action stay readable: the nested shape of `story.pr`'s `tests`, the renamed `what`.
    expect(flat(reference)).toMatch(/### `story\.pr`.*Fields: .*tests\*: \{[^}]*"status"/);
    expect(flat(reference)).toMatch(/### `guard\.request`.*Fields: .*what\*:/);
  });

  it("keeps every safety rule where an agent reads it: AGENTS.md, a tool description, a skill or the reference", () => {
    const corpus = flat(
      [
        agentsFile,
        reference,
        ...Object.values(TOOL_DESCRIPTIONS),
        ...methodTexts().map(({ text }) => text),
      ].join("\n"),
    ).toLowerCase();
    const rules = [
      // Taken from the descriptions of the 46 tools before they were grouped.
      "never write a dollar amount",
      "never read them directly",
      "never write these folders directly",
      "refused` means never",
      "never leave deferred work in a note or a file only",
      "only the creator drops an item",
      "a story never has two developers",
      "never bend a limit to keep a change in the fast track",
      "never run `gh` or `glab` yourself",
      "never the main branch, never forced",
      "never offer to accept the story without the ci",
      "only the creator may accept the story without it",
      "never the story's developer",
      "never ask for a confirmation, a sentence to repeat or a second message",
      "never approve to make the work go on",
      "you never answer for the creator",
      "never run the command yourself",
      "never skip a step yourself, the creator says it",
      "only noah delegates",
      "never the other reviewer's notes or comments, never the author's reasoning",
      "never post or read comments on the pull request yourself",
      "never present a point of a stack as approved yourself",
      "never ask again a stack the creator declined",
      "never override the constitution, the permissions or what the creator says now",
      "you never order, merge or resolve",
      "never by `git rebase` nor by rewriting the history",
      "never an agent's word",
      "never guess one",
      "never run `gh auth`, a package manager or a login yourself",
      "never start the work of a later phase",
      // The constitution's own.
      "never push or switch to the",
      "never merge a pull request",
      "never publish, send or pay",
      "never answer for the creator",
      "never waive",
      "never skip hooks",
    ];
    for (const rule of rules) expect(corpus, rule).toContain(rule);
  });

  it("writes only tools and actions that exist, in the texts of the method and of the constitution", () => {
    const names = Object.keys(TOOL_GROUPS).join("|");
    const citation = new RegExp(`\`(${names})\\.([a-z_]+)(?:[ \`])`, "g");
    // Event types, block actions, fields and files that read like `tool.action` but are none.
    const NOT_ACTIONS = new Set([
      "story.started",
      "story.status_changed",
      "story.pr_opened",
      "story.ci_reported",
      "story.merged",
      "story.merge_refreshed",
      "story.review",
      "story.complete",
      "review.reviewers",
      "review.untriaged",
      "agent.yaml",
      "state.merged",
      "state.merge_feedback",
    ]);
    const unknown: string[] = [];
    const texts = [
      ...methodTexts(),
      { path: "AGENTS.md", text: agentsFile },
      { path: "REFERENCE.md", text: reference },
    ];
    for (const { path, text } of texts) {
      for (const match of text.matchAll(citation)) {
        const [, tool, action] = match;
        if (NOT_ACTIONS.has(`${tool}.${action}`)) continue;
        if (TOOL_GROUPS[tool as string]?.actions[action as string] === undefined) {
          unknown.push(`${path}: ${tool}.${action}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("leaves no one-action tool name in what agents read", () => {
    // Not after a dot: `story.leave_fast_track` is the notation, `leave_fast_track` alone the old tool.
    const old = new RegExp(
      `(?<![\\w.])(${exposedCommands()
        .filter((n) => n.includes("_"))
        .join("|")})\\b`,
    );
    const stale: string[] = [];
    for (const { path, text } of [
      ...methodTexts(),
      { path: "AGENTS.md", text: agentsFile },
      { path: "REFERENCE.md", text: reference },
    ]) {
      // The reference keeps the old name once per action, in the heading-less line « command: »? No:
      // it is written in the notation everywhere.
      for (const line of text.split("\n")) {
        // The word may be a field or an event (`ci_waive`…): only the 46 tool names are checked.
        if (old.test(line.replace(/\bdeviation\b/g, "")))
          stale.push(`${path}: ${line.trim().slice(0, 120)}`);
      }
    }
    expect(stale).toEqual([]);
  });
});

/**
 * What Noah reads before his first answer: his definition, and the reference files the constitution
 * sends him to first. Before the merge of his role it was his skill and three files read at start
 * (`noah`, `talking`, his `conduct`): 34 243 characters; his definition now holds them.
 */
function noahStartup(): number {
  const skill = renderAgentSkill(
    resolveAgent(definitions.find((d) => d.name === "noah") as Definition),
  ).length;
  const files = renderConstitutionReferenceFiles([], DEFAULT_RULES, assistant);
  const table = agentsFile.slice(agentsFile.indexOf("## Where to read the detail"));
  // A file the table sends everyone to « before your first message » without leaving Noah out.
  const first = [...table.matchAll(/^- `([a-z-]+)`: before your first message(.*)$/gm)]
    .filter((match) => !(match[2] ?? "").includes("not Noah"))
    .map((match) => match[1]);
  // How to launch an agent in his tool: read before his first handover.
  const read = ["noah", ...first].reduce(
    (sum, name) =>
      sum + (files.find((file) => file.path.endsWith(`/${name}.md`))?.content.length ?? 0),
    0,
  );
  return skill + read;
}

describe("Noah is small", () => {
  it("holds his whole role in at most 12 000 bytes, and reads nothing else to start", () => {
    const dir = join(methodDir, "agents", "noah");
    const role = ["SKILL.md", "agent.yaml"].reduce(
      (sum, file) => sum + Buffer.byteLength(readFileSync(join(dir, file), "utf8")),
      0,
    );
    expect(role).toBeLessThanOrEqual(11_950);
    expect(existsSync(join(dir, "references", "conduct.md"))).toBe(false);
    // The constitution no longer sends him to its `noah` and `talking` files before he answers.
    expect(agentsFile).not.toContain("`noah`: if you are Noah");
    expect(agentsFile).toContain("`talking`: before your first message (not Noah)");
    // His definition, rendered, holds the three files he read at start (34 243 characters with
    // his skill before); his startup adds only the launch lines of the targeted tools.
    const skill = renderAgentSkill(
      resolveAgent(definitions.find((d) => d.name === "noah") as Definition),
    ).length;
    expect(skill).toBeLessThanOrEqual(11_900);
    expect(noahStartup()).toBeLessThanOrEqual(NOAH_STARTUP_CEILING);
  });

  it("names every reference he reads on demand, each short", () => {
    const noah = definitions.find((definition) => definition.name === "noah");
    if (noah === undefined) throw new Error("noah is not shipped");
    const rendered = renderAgentSkill(resolveAgent(noah));
    const dir = join(methodDir, "agents", "noah", "references");
    const files = readdirSync(dir).sort();
    expect(files.length).toBeGreaterThanOrEqual(5);
    const ceilings: Readonly<Record<string, number>> = {
      "decisions.md": 5_700,
      "team.md": 5_700,
      "environment.md": 2_850,
      "journey.md": 2_600,
      "facts.md": 2_050,
    };
    for (const file of files) {
      expect(rendered, file).toContain(`references/${file}`);
      const ceiling = ceilings[file];
      expect(ceiling, file).toBeDefined();
      expect(readFileSync(join(dir, file), "utf8").length, file).toBeLessThanOrEqual(ceiling ?? 0);
    }
  });

  it("keeps his rules: the contract, the creator's decisions, the engine alone merging", () => {
    const noah = flat(
      renderAgentSkill(resolveAgent(definitions.find((d) => d.name === "noah") as Definition)),
    );
    for (const rule of [
      "`ROLE_FORBIDDEN`",
      "Noah recommends, never decides",
      "never answers in their place",
      "never rewords their answer",
      "Only the engine merges",
      "never sends the creator to a terminal",
      "he cannot open one",
      // What protects the creator's decisions: the point first, then one question, one gesture.
      "the agent that owns the subject opens it first, then the creator is asked, once",
      "`anticipated: true` with the whole message in `quote`",
      "One validation, one gesture",
      "never asks for a second message",
      // What the bridge used to repeat at every message: his role says it once.
      "records it with `agent.delegate` BEFORE any launch",
      "Every sub-agent is a named agent of the team",
      "never a generic one: its cost has an owner",
      "a story never goes to two developers",
      "One independent review per pass: after 2 passes without agreement",
      "`agent.summarize`",
      "`exchanges` of `state.get`",
      "goes to THAT agent",
      "He holds the team (`agent.pause`) only after the creator said yes",
      "never resumes it",
      "he says « tu » to the creator, always",
      "never by a file's time or a declared status",
      "`change_method` in `state.next`",
      "Without a head",
      "never redone by another path",
      "No work of a later phase starts before the creator approved the current `phase_end`",
      "any other skill is `.agentplugged/skills/<name>/SKILL.md`",
    ]) {
      expect(noah, rule).toContain(rule);
    }
  });
});

describe("tools by role for Claude Code's sub-agents", () => {
  it("never leaves a sub-agent without a tool its definition or its skills cite", async () => {
    const source = new NodeWorkspaceFiles(methodDir);
    const input = {
      source,
      definitions,
    } as unknown as Parameters<typeof toolsNeededBy>[0];
    const skills = new Map(definitions.filter((d) => d.kind === "skill").map((d) => [d.name, d]));
    for (const definition of definitions.filter((d) => d.kind === "agent" && d.name !== "noah")) {
      const resolved = resolveAgent(definition);
      const needed = await toolsNeededBy(input, resolved);
      for (const tool of BASE_TOOLS) expect(needed, `${definition.name}: ${tool}`).toContain(tool);
      // What its own text cites, and what the skills of its menu cite.
      const own = toolsCitedIn(renderAgentBody(resolved));
      for (const item of resolved.agent.menu) {
        if (item.skill === undefined) continue;
        const skill = skills.get(item.skill);
        if (skill === undefined) continue;
        const annexes = skill.annexes
          .filter((file) => file.endsWith(".md"))
          .map((file) => readFileSync(join(methodDir, "skills", skill.name, file), "utf8"));
        for (const tool of toolsCitedIn([skill.text, ...annexes].join("\n"))) own.add(tool);
      }
      for (const tool of own) expect(needed, `${definition.name} cites ${tool}`).toContain(tool);
      const denied = await disallowedToolsFor(input, resolved);
      for (const tool of needed) {
        expect(denied, `${definition.name}: ${tool}`).not.toContain(`mcp__agentplugged__${tool}`);
      }
      // Every tool is either given or denied: nothing is forgotten.
      expect(denied.length + needed.length, definition.name).toBe(Object.keys(TOOL_GROUPS).length);
    }
  });

  it("never takes from a sub-agent a tool that the rules of AGENTS.md give every agent", () => {
    const universal = toolsCitedIn(agentsFile);
    for (const tool of universal) expect(BASE_TOOLS, tool).toContain(tool);
  });

  it("takes something away from the sub-agents whose work does not need it", async () => {
    const source = new NodeWorkspaceFiles(methodDir);
    const input = { source, definitions } as unknown as Parameters<typeof toolsNeededBy>[0];
    // Iris cites `review.critique` (skill test-idea) and so keeps the tool; Maya did not.
    // Maya's skill asks for the reconciliation of the inputs (`review.critique`) and
    // keeps the tool too; Zoe, whose skills do not cite it, still loses it.
    const maya = definitions.find((d) => d.name === "maya") as Definition;
    const denied = await disallowedToolsFor(input, resolveAgent(maya));
    expect(denied).not.toContain("mcp__agentplugged__review");
    const zoe = definitions.find((d) => d.name === "zoe") as Definition;
    expect(await disallowedToolsFor(input, resolveAgent(zoe))).toContain(
      "mcp__agentplugged__review",
    );
    expect(denied).toContain("mcp__agentplugged__measure");
  });
});

describe("the lists the tools load at every request stay short", () => {
  it("gives each skill and each agent a description of at most 180 characters", () => {
    for (const definition of definitions) {
      const description = (definition.frontmatter as { description: string }).description;
      expect(description.length, definition.name).toBeLessThanOrEqual(180);
    }
    const frontmatters = definitions
      .map((d) => d.frontmatterYaml.length)
      .reduce((a, b) => a + b, 0);
    // The ceiling is the measure, rounded up to the next 10: this list is loaded at every request
    // of Noah's session, so it only goes up when a capability is added on purpose. Some skills have
    // no menu row for Noah, to spare his body, and the descriptions of the developers drop the
    // phase their metadata already says.
    expect(frontmatters).toBeLessThanOrEqual(12_530);
  });
});

describe("the fixed cost of a request stays low", () => {
  it("keeps tools/list, AGENTS.md and Noah under the thresholds", () => {
    const registry = createCommandRegistry();
    const commands = new Map(registry.agentCommands().map((c) => [c.name, c] as const));
    const tools = publishedTools(commands).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.schema,
    }));
    const toolsList = JSON.stringify({ tools }).length;
    const noah = noahStartup();
    const session = toolsList + agentsFile.length + noah;
    // Each thing loaded at every request has its own ceiling, set just above its measure and
    // never raised without a reason:
    // - tools/list: the descriptions do not repeat what the schema's `action` enumeration and the
    //   reference files say; every action name and safety word stays;
    // - AGENTS.md: 6 000 (its own test below);
    // - Noah's startup: his definition and the launch lines (8 590 for his skill alone before, but
    //   he also read three files at start: 34 243 in all);
    // - the three together stay under their own ceiling (23 480 before, 49 133 with his reads).
    expect(toolsList).toBeLessThanOrEqual(8_960);
    expect(noah).toBeLessThanOrEqual(NOAH_STARTUP_CEILING);
    expect(session).toBeLessThanOrEqual(SESSION_CEILING);
  });
});

/**
 * The scenario « framing, then one story » (205 requests), recomputed from what the engine really
 * generates, with the same hypotheses. 1 token ≈ 4 characters.
 */
const TOKEN = 4;
/** Noah's startup and the fixed cost of one of his requests, as measured (they only go down). */
const NOAH_STARTUP_CEILING = 14_330;
const SESSION_CEILING = 29_060;
/** Total of the reference method on the scenario, in thousands of tokens. */
const REFERENCE_SCENARIO_K = 2_350;

const skillText = (name: string) =>
  (definitions.find((d) => d.name === name && d.kind === "skill") as Definition).text;
const agentBody = (name: string) =>
  renderAgentBody(
    resolveAgent(definitions.find((d) => d.name === name && d.kind === "agent") as Definition),
  );

/**
 * What a scenario asks of the engine: the requests of Noah, and each session that runs a skill
 * (its requests, the agent, the skill).
 */
interface Plan {
  readonly noah: number;
  readonly sessions: ReadonlyArray<readonly [number, string, string]>;
  /**
   * The phases Noah's requests spread over, evenly: the tools list the skills of the current
   * phase only (the full path by default: framing, planning, design, build).
   */
  readonly phases?: readonly SkillPhase[];
}

const FULL_PATH_PHASES: readonly SkillPhase[] = (
  ["framing", "planning", "design", "build"] as const
).map((phase) => ({ phase, shortPath: false }));

/** Three framing sessions of 25 requests, one builder of 40, two reviewers of 15; 60 for Noah. */
const FULL_PLAN: Plan = {
  noah: 60,
  sessions: [
    [25, "iris", "write-brief"],
    [25, "maya", "write-prd"],
    [25, "alex", "write-architecture"],
    [40, "hugo", "develop-story"],
    [30, "quentin", "review-story"],
  ],
};

/** The scenario's total in thousands of tokens, and its parts, for a plan. */
function scenario(plan: Plan = FULL_PLAN) {
  const registry = createCommandRegistry();
  const commands = new Map(registry.agentCommands().map((c) => [c.name, c] as const));
  const toolsList = JSON.stringify({
    tools: publishedTools(commands).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.schema,
    })),
  }).length;
  const noah = noahStartup();
  // Every agent is also a skill, and Noah has no sub-agent file; the skills are those of the phase.
  const phases = plan.phases ?? FULL_PATH_PHASES;
  const skillsList =
    phases
      .map((phase) =>
        skillsOfPhase(definitions, phase).reduce((sum, d) => sum + d.frontmatterYaml.length, 0),
      )
      .reduce((a, b) => a + b, 0) / phases.length;
  const agentsList = definitions
    .filter((d) => d.kind === "agent" && d.name !== "noah")
    .reduce((sum, d) => sum + d.frontmatterYaml.length, 0);
  const skillRules = (
    renderConstitutionReferenceFiles([], DEFAULT_RULES, assistant).find((file) =>
      file.path.endsWith("/skill-rules.md"),
    ) as { content: string }
  ).content.length;
  const REQUESTS = plan.noah + plan.sessions.reduce((sum, [requests]) => sum + requests, 0);
  // Every session that runs a skill also reads the rules the skills share (« skill-rules »).
  const bodies = plan.sessions.reduce(
    (sum, [requests, agent, skill]) =>
      sum + (requests * (agentBody(agent).length + skillText(skill).length + skillRules)) / TOKEN,
    0,
  );
  // Noah's 50 reads (25 of the state, 20 of the next step, 5 writes) are carried by the 23 requests
  // that follow each of them, on average.
  const memory = new ResponseMemory();
  const get = JSON.stringify(shapeResponse("state", "get", STATE_GET, memory));
  const again = JSON.stringify(shapeResponse("state", "get", STATE_GET, memory));
  const next = JSON.stringify(shapeResponse("state", "next", STATE_NEXT, memory));
  const reads = (get.length + 24 * again.length + 20 * next.length + 5 * 40) / TOKEN;
  const parts = {
    tools: (REQUESTS * toolsList) / TOKEN,
    agentsFile: (REQUESTS * agentsFile.length) / TOKEN,
    noah: (plan.noah * noah) / TOKEN,
    skillsList: (plan.noah * skillsList) / TOKEN,
    agentsList: (plan.noah * agentsList) / TOKEN,
    bodies,
    responses: reads * 23 * (plan.noah / FULL_PLAN.noah),
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v / 1000])) as Record<
      keyof typeof parts,
      number
    >,
    total: total / 1000,
  };
}

describe("the published descriptions send to files that exist", () => {
  it("never name the old REFERENCE.md, and each file it names is written by sync", () => {
    const written = renderConstitutionReferenceFiles([], DEFAULT_RULES, assistant).map(
      (file) => file.path,
    );
    for (const [tool, description] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(description, tool).not.toContain("REFERENCE.md");
      const named = /Ref: (tool-[a-z]+)\s*$/.exec(description)?.[1];
      expect(named, tool).toBe(`tool-${tool}`);
      expect(written, tool).toContain(`.agentplugged/reference/${named}.md`);
    }
  });
});

describe("AGENTS.md and the reference", () => {
  it("keeps AGENTS.md to the safety essentials, 6 000 characters at most", () => {
    expect(agentsFile.length).toBeLessThanOrEqual(5_780);
    // It was 14 239 characters before: the rest is read on demand, a file at a time.
    expect(renderConstitutionReferenceFiles([], DEFAULT_RULES, assistant).length).toBeGreaterThan(
      25,
    );
  });
});

/**
 * What is read only by the session that runs it: a body is not a cost for the other sessions, so a
 * new skill does not make the others shorten. What is paid at every request has its own strict
 * ceilings (the tests above: tools/list, AGENTS.md, the lists of names and descriptions, Noah; and
 * `scenario()` below). What is paid only when it serves is bounded one by one, and the ceilings
 * only go down:
 * - a skill is a work sheet (the step, the document and its size, what to read, the validation
 *   point, the product's own rules): its body at most `SKILL_CEILING`, each of its references at
 *   most `REFERENCE_CEILING`, the sheet and its references together at most `FOLDER_CEILING`, and
 *   no reference that nothing names;
 * - an agent's rendered body at most `BODY_CEILING`;
 * - no body grows past its recorded size by more than 5 % (and 300 characters at least), which
 *   stops the slow swelling a ceiling does not see. The record is this table: a body that grows on
 *   purpose raises its line.
 */
const SKILL_CEILING = 5_000;
const REFERENCE_CEILING = 2_500;
const FOLDER_CEILING = 8_000;
const BODY_CEILING = 13_100;
/**
 * The files the engine hands one by one to the readers and the judge of a review (`review.start`,
 * `review.export`): each reader reads its own, never the folder, so they count apart (each still
 * under `REFERENCE_CEILING`).
 */
const READER_FILES = /^(lens-.+|pass-.+|format|judge)\.md$/;
/** The size of each body when it was last measured, in characters. */
const BODY_RECORD: Readonly<Record<string, number>> = {
  "agent:alex": 9856,
  "agent:chloe": 10032,
  "agent:ethan": 7176,
  "agent:hugo": 7011,
  "agent:iris": 7084,
  "agent:izzy": 13056,
  "agent:jade": 7107,
  "agent:julien": 10409,
  "agent:lina": 7142,
  "agent:lou": 6897,
  "agent:maya": 8703,
  "agent:milo": 8641,
  "agent:noah": 11512,
  "agent:omar": 9746,
  "agent:quentin": 8242,
  "agent:sam": 7032,
  "agent:stella": 8364,
  "agent:tess": 7422,
  "agent:zoe": 9677,
  "skill:acceptance-qa": 2521,
  "skill:api-e2e-tests": 4124,
  "skill:audit-pillars": 1417,
  "skill:chain-stories": 1729,
  "skill:check-readiness": 1774,
  "skill:check-requirements": 3919,
  "skill:correct-course": 335,
  "skill:critique-deliverable": 1182,
  "skill:deep-research": 2386,
  "skill:develop-story": 4851,
  "skill:diagnose-bug": 3905,
  "skill:generate-knowledge-base": 4807,
  "skill:ideation": 2416,
  "skill:improve-code": 4030,
  "skill:improve-session": 2904,
  "skill:pitch": 2332,
  "skill:plan-sprint": 4022,
  "skill:resolve-merge-conflict": 3663,
  "skill:review-story": 3914,
  "skill:round-table": 1607,
  "skill:run-retrospective": 4686,
  "skill:security-review-architecture": 4014,
  "skill:setup-ci": 3868,
  "skill:split-into-stories": 4978,
  "skill:strategy": 2623,
  "skill:test-idea": 1476,
  "skill:workshop": 2140,
  "skill:write-architecture": 4982,
  "skill:write-brand": 2522,
  "skill:write-brief": 4991,
  "skill:write-content": 4996,
  "skill:write-positioning": 4994,
  "skill:write-prd": 4854,
  "skill:write-sales": 4985,
  "skill:write-spec": 1658,
  "skill:write-ux-spec": 4787,
};

describe("a body is read only when it serves: one ceiling each, no sum", () => {
  const bodyOf = (definition: Definition) =>
    definition.kind === "agent"
      ? renderAgentBody(resolveAgent(definition)).length
      : definition.body.length;
  const key = (definition: Definition) => `${definition.kind}:${definition.name}`;
  const skills = () => definitions.filter((definition) => definition.kind === "skill");
  const referencesOf = (name: string) => {
    const dir = join(methodDir, "skills", name, "references");
    return existsSync(dir)
      ? readdirSync(dir).map((file) => ({
          file,
          text: readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n"),
        }))
      : [];
  };

  it("keeps every skill a work sheet: its body, each reference and its folder under their ceilings", () => {
    for (const skill of skills()) {
      expect(skill.body.length, skill.name).toBeLessThanOrEqual(SKILL_CEILING);
      const references = referencesOf(skill.name);
      for (const { file, text } of references) {
        expect(text.length, `${skill.name}/${file}`).toBeLessThanOrEqual(REFERENCE_CEILING);
      }
      const folder =
        skill.body.length +
        references
          .filter(({ file }) => skill.name !== "review-story" || !READER_FILES.test(file))
          .reduce((sum, { text }) => sum + text.length, 0);
      expect(folder, `${skill.name}: the sheet and its references`).toBeLessThanOrEqual(
        FOLDER_CEILING,
      );
    }
  });

  it("leaves no reference that nothing names", () => {
    for (const skill of skills()) {
      const references = referencesOf(skill.name);
      for (const { file } of references) {
        // Named by the sheet or by another reference of the folder; the reader files by the engine.
        const named =
          skill.text.includes(file) ||
          references.some((other) => other.file !== file && other.text.includes(file)) ||
          (skill.name === "review-story" && READER_FILES.test(file));
        expect(named, `${skill.name}/${file}`).toBe(true);
      }
    }
  });

  it("keeps every agent under the ceiling, with no exception", () => {
    for (const definition of definitions.filter((d) => d.kind === "agent")) {
      expect(bodyOf(definition), key(definition)).toBeLessThanOrEqual(BODY_CEILING);
    }
    // The record names definitions that still exist (a rename updates it).
    const names = new Set(definitions.map(key));
    for (const name of Object.keys(BODY_RECORD)) expect(names.has(name), name).toBe(true);
  });

  it("keeps the reporting rules every agent reads short", () => {
    const reporting = renderConstitutionReferenceFiles([], DEFAULT_RULES, assistant).find((file) =>
      file.path.endsWith("/reporting.md"),
    );
    expect(reporting?.content.length ?? Infinity).toBeLessThanOrEqual(4_100);
  });

  it("stops a body from swelling past its recorded size by more than 5 %", () => {
    for (const definition of definitions) {
      const recorded = BODY_RECORD[key(definition)];
      // A new agent or skill has no record yet: only the ceiling holds it until the next story.
      if (recorded === undefined) continue;
      const allowed = Math.max(recorded * 1.05, recorded + 150);
      expect(bodyOf(definition), key(definition)).toBeLessThanOrEqual(allowed);
    }
  });
});

describe("lighter than the reference method on the scenario", () => {
  it("costs less than the reference's ≈ 2 350 k tokens, and says where the weight is", () => {
    const { parts, total } = scenario();
    expect(total, JSON.stringify(parts)).toBeLessThan(REFERENCE_SCENARIO_K);
    // Each ceiling below is the value measured by this test, rounded up at the first decimal, and
    // is raised only on purpose: the list of the tools and the constitution are no longer the weight
    // they were, and the descriptions of the tools do not repeat what the `action` enumeration of
    // the schema, the reference files and the commands' own descriptions already say.
    expect(parts.tools).toBeLessThanOrEqual(459.0);
    // 5 787 characters of AGENTS.md × 205 requests (the 6 000 of its own test is the story's figure).
    expect(parts.agentsFile).toBeLessThanOrEqual(296.1);
    // Noah's startup carried by his 60 requests: his definition and the launch lines. Before the
    // merge of his role the scenario counted his skill only (128.9 k), not the three files he read
    // at start (384.8 k more): 2 715 k in all, honestly counted.
    expect(parts.noah).toBeLessThanOrEqual(214.9);
    // The list of the skills of the current phase only (196.9 k when every skill was installed,
    // 104.0 k before the skills were merged into work sheets).
    expect(parts.skillsList).toBeLessThanOrEqual(99.6);
    expect(total).toBeLessThanOrEqual(1_995.5);
    // The reads of Noah carried by the requests that follow them (measured 264.1 k).
    expect(parts.responses).toBeLessThanOrEqual(264.2);
    // The bodies the scenario really loads (the five sessions and the shared rules): 908.0 k before
    // the skills became work sheets, 613.4 k since.
    expect(parts.bodies).toBeLessThanOrEqual(596.9);
  });
});

describe("the short path costs clearly less than the full path", () => {
  /**
   * « Framing, then one story » on a small project. One session writes the spec (25 requests) in
   * place of the three framing sessions; Noah has two documents fewer to validate and no phase end
   * (≈ 8 requests each), and asks the path once (≈ 4): 60 - 2 * 8 + 4.
   */
  const SHORT_PLAN: Plan = {
    noah: 48,
    // The short path skips the framing, the planning and the design: one phase, with the spec.
    phases: [{ phase: "build", shortPath: true }],
    sessions: [
      [25, "maya", "write-spec"],
      [40, "hugo", "develop-story"],
      [30, "quentin", "review-story"],
    ],
  };

  it("costs at most three quarters of the fixed cost of the full path", () => {
    const full = scenario();
    const short = scenario(SHORT_PLAN);
    // The guide and the template, read once at step 3 and carried by the 15 requests that follow,
    // which the full path's own references (checklists, templates) would add to its side too.
    const dir = join(methodDir, "skills", "write-spec");
    const read = ["references/spec-guide.md", "assets/spec-template.md"].reduce(
      (sum, file) => sum + readFileSync(join(dir, file), "utf8").length,
      0,
    );
    const carried = (15 * read) / TOKEN / 1000;
    expect(short.total + carried, JSON.stringify(short.parts)).toBeLessThanOrEqual(
      full.total * 0.75,
    );
    expect(short.parts.bodies).toBeLessThan(full.parts.bodies);
    expect(short.total).toBeLessThan(REFERENCE_SCENARIO_K);
  });

  it("stays clearly under the full path once Chloé reviews the design on both", () => {
    // The review of the architecture (15 requests, 2 more for Noah) and the review of the spec
    // (same session, same size: a short pass is shorter, this is the upper bound).
    const chloe = [15, "chloe", "security-review-architecture"] as const;
    const fullTotal = scenario({
      noah: FULL_PLAN.noah + 2,
      sessions: [...FULL_PLAN.sessions, chloe],
    }).total;
    const shortTotal = scenario({
      noah: SHORT_PLAN.noah + 2,
      sessions: [...SHORT_PLAN.sessions, chloe],
    }).total;
    expect(shortTotal, `${shortTotal} against ${fullTotal}`).toBeLessThanOrEqual(fullTotal * 0.75);
    expect(shortTotal).toBeLessThan(REFERENCE_SCENARIO_K);
    // The detail of the review of a spec is a file read when needed, short.
    const detail = join(methodDir, "skills", "security-review-architecture", "references");
    expect(readFileSync(join(detail, "spec-review.md"), "utf8").length).toBeLessThanOrEqual(2_500);
  });

  it("keeps the skill short and its detail in files read when needed", () => {
    const dir = join(methodDir, "skills", "write-spec");
    expect(skillText("write-spec").length).toBeLessThanOrEqual(2_000);
    // What the author reads besides the skill: the guide once, the template once.
    const guide = readFileSync(join(dir, "references", "spec-guide.md"), "utf8").length;
    const template = readFileSync(join(dir, "assets", "spec-template.md"), "utf8").length;
    expect(guide).toBeLessThanOrEqual(2_500);
    expect(template).toBeLessThanOrEqual(2_250);
    // And it is the only skill the short path adds: the spec is not five skills.
    expect(skillText("write-spec")).toContain("references/spec-guide.md");
  });
});

describe("a review in lenses costs less than the reference method", () => {
  const NL = String.fromCharCode(10);
  const references = join(methodDir, "skills", "review-story", "references");
  const sizeOf = (name: string) => readFileSync(join(references, name), "utf8").length;
  const STORY = 9_000;

  /** A diff of files of `chars` characters each (the line count follows). */
  const diffOf = (files: Array<[string, number]>) =>
    files
      .map(([path, chars]) => {
        const body = Array.from(
          { length: Math.ceil(chars / 40) },
          (_, i) => `+line ${i} of ${path}`,
        );
        return [
          `diff --git a/${path} b/${path}`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/${path}`,
          `@@ -0,0 +1,${body.length} @@`,
          ...body,
          "",
        ].join(NL);
      })
      .join("");

  /**
   * What a review adds on top of its readers: the judge rules on every finding (the
   * findings are given to it: `FINDINGS` of `FINDING_CHARS` characters in the typical case), and
   * the reader of verification gaps runs its short passes (their files, and the commit messages).
   */
  const FINDINGS = 6;
  const FINDING_CHARS = 300;
  const STATEMENTS_CHARS = 600;
  /** The sizes of the files of a review before the judge and the passes. */
  const BEFORE_18_2: Readonly<Record<string, number>> = {
    "format.md": 1_362,
    "judge.md": 1_353,
    "lens-edge-cases.md": 592,
    "lens-verification-gaps.md": 663,
  };

  /** Input tokens of a review, the way the reference counts them. */
  function cost(diff: string, withSecurity = false, findings = FINDINGS) {
    const files = changeFiles(parseDiff(diff));
    const reasons = files.some((file) => sensitivePath(file.path)) ? (["paths"] as const) : [];
    // The security review is a reviewer of its own: its lens counts only when asked.
    const lenses = chooseLenses(files, [...reasons]).filter(
      (choice) => withSecurity || choice.lens !== "security",
    );
    const lensFile = (lens: string) => sizeOf(`lens-${lens.replaceAll("_", "-")}.md`);
    const agent = (part: number, own: number) => (part + STORY + own + sizeOf("format.md")) / TOKEN;
    // The old way: one sub-agent per lens, then the judge.
    const before =
      lenses.reduce(
        (sum, choice) => sum + agent(lensDiff(diff, choice.lens).length, lensFile(choice.lens)),
        0,
      ) + agent(lensDiff(diff, "judge").length, sizeOf("judge.md"));
    const passes = readerPasses(files, true);
    const readers = planReaders("qa", lenses, isSensitiveChange(files, [...reasons]), passes);
    // The sizes of the files before the judge and no ruling on the findings.
    const sizeBefore = (name: string) => BEFORE_18_2[name] ?? sizeOf(name);
    const agentBefore = (part: number, own: number) =>
      (part + STORY + own + sizeBefore("format.md")) / TOKEN;
    const lensBefore = (lens: string) => sizeBefore(`lens-${lens.replaceAll("_", "-")}.md`);
    const lensesBefore = planReaders("qa", lenses, isSensitiveChange(files, [...reasons])).reduce(
      (sum, reader) =>
        sum +
        agentBefore(
          lensDiff(diff, [...reader.lenses, ...(reader.judge ? (["judge"] as const) : [])]).length,
          reader.lenses.reduce((own, lens) => own + lensBefore(lens), 0) +
            (reader.judge ? sizeBefore("judge.md") : 0),
        ),
      0,
    );
    const ruled = (findings * FINDING_CHARS) / TOKEN;
    const after = readers.reduce(
      (sum, reader) =>
        sum +
        agent(
          lensDiff(diff, [...reader.lenses, ...(reader.judge ? (["judge"] as const) : [])]).length,
          reader.lenses.reduce((own, lens) => own + lensFile(lens), 0) +
            (reader.judge ? sizeOf("judge.md") : 0) +
            (reader.passes ?? []).reduce((own, pass) => own + sizeOf(`pass-${pass}.md`), 0) +
            (reader.passes?.includes("assertions") ? STATEMENTS_CHARS : 0),
        ) +
        // The judge reads the findings it rules on, after the readers.
        (reader.judge ? ruled : 0),
      0,
    );
    // A small change with findings: a short fresh judge rules on them alone (no diff to read).
    const small = readers.length === 1 && readers[0]?.reader === "whole";
    const freshJudge =
      small && findings > 0
        ? (STORY + sizeOf("judge.md") + sizeOf("format.md")) / TOKEN + ruled
        : 0;
    // The reference: three reviewers, each on the whole diff, plus its
    // orchestration files (≈ 27 000 characters) and its prompts (≈ 20 000).
    const reference = (3 * diff.length + 27_000 + 20_000) / TOKEN;
    return {
      before,
      after: after + freshJudge,
      reference,
      lensesBefore,
      readers: readers.map((reader) => reader.reader),
    };
  }

  it("goes under the reference on a typical story, and under the old way", () => {
    // 29 files: sources, their tests, a few documents (≈ 115 000 characters).
    const typical = diffOf([
      ...Array.from(
        { length: 14 },
        (_, i) => [`src/area${i % 5}/file${i}.ts`, 4_000] as [string, number],
      ),
      ...Array.from(
        { length: 10 },
        (_, i) => [`src/area${i % 5}/file${i}.test.ts`, 4_500] as [string, number],
      ),
      ...Array.from({ length: 5 }, (_, i) => [`docs/page${i}.md`, 2_500] as [string, number]),
    ]);
    const { before, after, reference, readers, lensesBefore } = cost(typical);
    expect(readers).toEqual(["whole"]);
    // The old way cost more than the reference here.
    expect(before).toBeGreaterThan(reference);
    expect(after, `${after} against ${reference}`).toBeLessThan(reference);
    expect(after).toBeLessThan(before * 0.7);
    // One independent reading reads the whole diff once: it is not compared with the split reading.
    expect(lensesBefore).toBeGreaterThan(0);
  });

  it("keeps the split reading, a judge of its own and its bound for a high-risk story", () => {
    // The same story with a file of the authentication: three readers and a judge in a fresh context.
    const risky = diffOf([
      ...Array.from(
        { length: 14 },
        (_, i) => [`src/area${i % 5}/file${i}.ts`, 4_000] as [string, number],
      ),
      ...Array.from(
        { length: 10 },
        (_, i) => [`src/area${i % 5}/file${i}.test.ts`, 4_500] as [string, number],
      ),
      ["src/auth/login.ts", 3_000] as [string, number],
    ]);
    const { before, after, reference, readers, lensesBefore } = cost(risky);
    expect(readers).toEqual(["depth", "form", "judge"]);
    expect(after, `${after} against ${reference}`).toBeLessThan(reference);
    expect(after).toBeLessThan(before);
    // The rulings, the passes and the longer files cost under a tenth more than the lenses alone.
    expect(after, `${after} against ${lensesBefore}`).toBeLessThan(lensesBefore * 1.1);
  });

  it("stays under the reference on a change in between, one adversarial regard and no structure", () => {
    // 150 lines or so in 4 files: the adversarial lens, not the structure one.
    const middle = diffOf([
      ["src/a/one.ts", 2_000],
      ["src/a/one.test.ts", 2_500],
      ["src/a/two.ts", 1_500],
      ["src/a/two.test.ts", 1_500],
    ]);
    const { before, after, reference, readers } = cost(middle);
    expect(readers).toEqual(["whole"]);
    expect(after, `${after} against ${reference}`).toBeLessThan(reference);
    expect(after).toBeLessThan(before);
  });

  it("goes far under the reference on a small change, with one reader", () => {
    const small = diffOf([
      ["src/profile.ts", 600],
      ["src/profile.test.ts", 600],
    ]);
    const { before, after, reference, readers } = cost(small);
    expect(readers).toEqual(["whole"]);
    expect(after).toBeLessThan(reference);
    expect(after).toBeLessThan(before);
  });

  it("keeps a small change under the reference even when a fresh judge rules on its findings", () => {
    const small = diffOf([
      ["src/profile.ts", 600],
      ["src/profile.test.ts", 600],
    ]);
    const clean = cost(small, false, 0);
    const found = cost(small, false, 2);
    expect(found.readers).toEqual(["whole"]);
    // The common case reads one reader; with findings, a short judge (no diff) is added.
    expect(clean.after).toBeLessThan(found.after);
    expect(found.after, `${found.after} against ${found.reference}`).toBeLessThan(found.reference);
    expect(clean.after).toBeLessThan(clean.lensesBefore * 1.4);
  });

  it("reads a sensitive change with three readers and the judge, far under one reader per lens", () => {
    // Like the typical story, with one file on a sensitive path: the engine sees a security reason.
    const sensitive = diffOf([
      ["src/auth/session.ts", 4_000],
      ...Array.from(
        { length: 13 },
        (_, i) => [`src/area${i % 5}/file${i}.ts`, 4_000] as [string, number],
      ),
      ...Array.from(
        { length: 10 },
        (_, i) => [`src/area${i % 5}/file${i}.test.ts`, 4_500] as [string, number],
      ),
      ...Array.from({ length: 5 }, (_, i) => [`docs/page${i}.md`, 2_500] as [string, number]),
    ]);
    // The quality review alone (the security lens is the security reviewer's): under the reference.
    const quality = cost(sensitive);
    expect(quality.readers).toEqual(["depth", "form", "judge"]);
    expect(quality.after, `${quality.after} against ${quality.reference}`).toBeLessThan(
      quality.reference,
    );
    // With the security reader on the whole diff, as the reference counts it: the
    // security lens alone, depth and form, then the judge. A quarter lower than one reader per
    // lens, and under 1.3 times the reference (the reference is the bar).
    const whole = cost(sensitive, true);
    expect(whole.readers).toEqual(["security", "depth", "form", "judge"]);
    expect(whole.after).toBeLessThan(whole.before * 0.75);
    expect(whole.after, `${whole.after} against ${whole.reference}`).toBeLessThan(
      whole.reference * 1.3,
    );
  });
});

/**
 * An audit of one pillar loads the skill, the shape of the report and the
 * file of that pillar, never the other pillars' files, and what it asks of the engine is short.
 */
describe("an audit of one pillar reads only that pillar", () => {
  const PILLARS = [
    "quality",
    "architecture",
    "security",
    "dependencies",
    "performance",
    "tests",
    "interface",
    "accessibility",
  ];
  const texts = new Map(methodTexts().map(({ path, text }) => [path, text]));
  const reference = (name: string) =>
    texts.get(`skills/audit-pillars/references/${name}.md`) as string;

  it("keeps one short file for the pillars, and a skill that reads one section at a time", () => {
    const pillars = reference("pillars");
    expect(pillars).toBeDefined();
    expect(pillars.length).toBeLessThanOrEqual(2_500);
    for (const pillar of PILLARS) expect(pillars, pillar).toContain(pillar);
    const skill = skillText("audit-pillars");
    expect(skill.length).toBeLessThanOrEqual(1_700);
    expect(flat(skill)).toContain("read only its section of `references/pillars.md`");
    expect(flat(skill)).toContain("at most 40 project files per pillar");
    // The pillars' sections stay in the file: none is inlined in the skill.
    for (const pillar of PILLARS) expect(skill).not.toContain(`**${pillar}.`);
  });

  it("costs under two thousand tokens of method for one pillar, under what it cost before", () => {
    // A pillar costs the skill and the pillars' file (before: the skill, the shape of the report,
    // the method and the pillar's own file, 5 984 characters for the lightest).
    const one = skillText("audit-pillars").length + reference("pillars").length;
    // What the engine answers: the register view (bounded) and a typical report.
    const view = JSON.stringify({
      changed: false,
      register: {
        total: 24,
        proven: 17,
        failed: 1,
        unproven: 2,
        settled: 4,
        gaps: ["ENF-4:failed:measure", "ENF-9:no_proof:test", "ENF-12:stale:analysis"],
      },
    });
    const report = 2_400;
    const tokens = (one + view.length + report) / TOKEN;
    expect(tokens, `${Math.round(tokens)} tokens`).toBeLessThanOrEqual(2_000);
    expect(one).toBeLessThan(5_984);
  });

  it("answers the register's calls in a few characters", () => {
    expect(RESPONSE_FORMS["measure.requirements"]?.max).toBeLessThanOrEqual(700);
    expect(RESPONSE_FORMS["measure.proof"]?.kind).toBe("ack");
    expect(RESPONSE_FORMS["checkpoint.gap"]?.kind).toBe("ack");
    expect(RESPONSE_FORMS["review.audit"]?.kind).toBe("ack");
  });
});

/**
 * A critique reads the skill, the shape of the report and the file of the
 * one method it uses, never the other methods' files; what the engine answers is bounded; and it
 * adds no tool to the server (an action of the tool `review`).
 */
describe("the critique of a deliverable reads one method only", () => {
  const METHODS = [
    "pre_mortem",
    "red_team",
    "socratic",
    "first_principles",
    "devils_advocate",
    "inversion",
  ];
  const texts = new Map(methodTexts().map(({ path, text }) => [path, text]));
  const reference = (name: string) =>
    texts.get(`skills/critique-deliverable/references/${name}.md`) as string;

  it("keeps one file of methods, a line each, and a skill that sends to the one chosen", () => {
    expect(reference("methods")).toBeDefined();
    expect(reference("methods").length).toBeLessThanOrEqual(2_500);
    for (const method of METHODS)
      expect(reference("methods"), method).toContain(`- \`${method}\`:`);
    const skill = skillText("critique-deliverable");
    expect(skill.length).toBeLessThanOrEqual(1_800);
    expect(flat(skill)).toContain("the method's line of `references/methods.md`");
    for (const method of METHODS) expect(skill).not.toContain(`# ${method}`);
    // The detail is read when it is needed: the gestures only once the stack is shown.
    expect(reference("gestures").length).toBeLessThanOrEqual(1_800);
    expect(reference("format").length).toBeLessThanOrEqual(1_800);
  });

  it("costs a few thousand tokens for a typical critique", () => {
    const shared =
      skillText("critique-deliverable").length +
      reference("format").length +
      reference("choose").length +
      reference("gestures").length;
    const one = shared + reference("methods").length;
    // What the agent writes and the engine answers: eight objections of ≈ 450 characters, the
    // stack of eight lines, three gestures with the creator's words.
    const objections = Array.from({ length: 8 }, (_, index) => ({
      severity: index < 2 ? "blocking" : "should_fix",
      claim: `The objection number ${index + 1} is stated in one line, as a claim`,
      passage: `ENF-${index + 1}`,
    }));
    const stack = JSON.stringify(
      shapeResponse(
        "review",
        "critique",
        { critique: "K-7M2K9QX4TB", objections: 8, stack: critiqueStack(objections as never) },
        new ResponseMemory(),
      ),
    );
    const written = 8 * 450 + 3 * 120 + 300;
    const tokens = (one + stack.length + written) / TOKEN;
    expect(tokens, `${Math.round(tokens)} tokens`).toBeLessThanOrEqual(3_100);
    expect(one).toBeLessThan(7_100);
  });

  it("bounds what the engine answers, and adds no tool", () => {
    // The worst stack: twelve objections, each line at its longest.
    const worst = Array.from({ length: 12 }, () => ({
      severity: "blocking",
      claim: "x".repeat(300),
      passage: "ENF-12",
    }));
    const answer = JSON.stringify(
      shapeResponse(
        "review",
        "critique",
        { critique: "K-7M2K9QX4TB", objections: 12, stack: critiqueStack(worst as never) },
        new ResponseMemory(),
      ),
    );
    expect(answer.length).toBeLessThanOrEqual(RESPONSE_FORMS["review.critique"]?.max ?? 0);
    // The worst answer of a settling or of a look at what is left: the corrections kept for the
    // twelve objections, each proposal at its longest (the stack and the corrections share the twelve).
    const kept = Array.from({ length: 12 }, (_, index) => ({
      n: index + 1,
      severity: "blocking" as const,
      claim: "x",
      passage: "ENF-1",
      proposal: "p".repeat(300),
      proof: null,
      status: "fix" as const,
    }));
    const record = { id: "K-7M2K9QX4TB", objections: kept } as never;
    const corrections = JSON.stringify(
      shapeResponse(
        "review",
        "critique",
        {
          settled: { fix: 12, hypothesis: 0, discard: 0 },
          fix: {
            owner: "maya",
            proposals: correctionLines(
              record,
              kept.map((entry) => entry.n),
            ),
          },
          left: 0,
        },
        new ResponseMemory(),
      ),
    );
    expect(corrections.length).toBeLessThanOrEqual(RESPONSE_FORMS["review.critique"]?.max ?? 0);
    expect(TOOL_GROUPS.review?.actions.critique?.command).toBe("critique");
    expect(Object.keys(TOOL_GROUPS).length).toBeLessThanOrEqual(12);
  });
});

/**
 * Testing an idea reuses the critique's action and register (no tool, no
 * command), the skill is short, and an exercise reads only the files of the exercise it runs.
 * The forge, the kind of concept, the two lists of questions and the verdict join
 * the skill as files read only by the exercise that needs them; still no tool, no command.
 */
describe("testing an idea and the press release stay light", () => {
  const texts = new Map(methodTexts().map(({ path, text }) => [path, text]));
  const file = (path: string) => texts.get(`skills/${path}`) as string;
  const skill = () => skillText("test-idea");
  const critique = (name: string) => file(`critique-deliverable/references/${name}.md`);
  const own = (name: string) => file(`test-idea/references/${name}.md`);
  // The method of an exercise in one file may run to 2 300 characters; the others stay at 1 500.
  const LONG = ["forge", "prfaq", "faq"];
  const SHORT = ["personas"];

  it("keeps a short skill and short references, read only for the exercise that runs", () => {
    expect(skill().length).toBeLessThanOrEqual(1_800);
    for (const name of [...LONG, ...SHORT]) {
      expect(own(name), name).toBeDefined();
      expect(own(name).length, name).toBeLessThanOrEqual(LONG.includes(name) ? 2_300 : 1_500);
    }
    for (const template of ["prfaq", "forge"]) {
      expect(file(`test-idea/assets/${template}-template.md`).length).toBeLessThanOrEqual(1_200);
    }
    // The skill sends to each file; the exercise it does not run is never read.
    for (const name of ["personas", "prfaq", "forge", "faq"]) {
      expect(skill()).toContain(`references/${name}.md`);
    }
    // The report and the gestures are those of the critique, not copied.
    expect(own("personas")).toContain("critique-deliverable/references/format.md");
    expect(own("personas")).toContain("critique-deliverable/references/gestures.md");
  });

  it("costs a few thousand tokens for a typical exercise, and no tool is added", () => {
    // What the agent writes: five personas of ≈ 350 characters, the six bets of ≈ 450, three
    // gestures with the creator's words; for the release, ≈ 2 500 characters in four sections, two
    // lists of six questions of ≈ 200 characters and a verdict of ≈ 500; for the forge, twelve log
    // lines of ≈ 100 characters and a closed file of ≈ 800.
    const bets = skill().length + critique("format").length + critique("gestures").length;
    const test = bets + own("personas").length + 5 * 350 + 6 * 450 + 3 * 120;
    const forge =
      bets +
      own("forge").length +
      own("personas").length +
      file("test-idea/assets/forge-template.md").length +
      12 * 100 +
      800 +
      3 * 450 +
      3 * 120;
    const release =
      bets +
      own("forge").length +
      own("prfaq").length +
      own("faq").length +
      file("test-idea/assets/prfaq-template.md").length +
      2_500 +
      12 * 200 +
      500 +
      3 * 450;
    expect(test / TOKEN, `${Math.round(test / TOKEN)} tokens`).toBeLessThanOrEqual(3_100);
    expect(forge / TOKEN, `${Math.round(forge / TOKEN)} tokens`).toBeLessThanOrEqual(3_100);
    expect(release / TOKEN, `${Math.round(release / TOKEN)} tokens`).toBeLessThanOrEqual(4_300);
    expect(createCommandRegistry().agentCommands()).toHaveLength(65);
  });
});

/**
 * Design thinking, the story and the deck are one skill with three modes
 * (one name and one description paid at every request instead of three), the method of each mode
 * lives in files read only when that mode runs, and no tool is added.
 */
describe("design thinking, story and deck stay light", () => {
  const texts = new Map(methodTexts().map(({ path, text }) => [path, text]));
  const file = (path: string) => texts.get(`skills/pitch/${path}`) as string;
  const skill = () => skillText("pitch");
  const references = ["design", "design-implementation", "story", "deck"];

  it("keeps a short skill and short references, each sent to by the skill", () => {
    expect(skill().length).toBeLessThanOrEqual(3_000);
    for (const name of references) {
      expect(file(`references/${name}.md`), name).toBeDefined();
      expect(file(`references/${name}.md`).length, name).toBeLessThanOrEqual(2_500);
      expect(skill(), name).toContain(`references/${name}.md`);
    }
    for (const name of ["design", "narrative", "deck"]) {
      expect(file(`assets/${name}-template.md`).length, name).toBeLessThanOrEqual(1_200);
      expect(skill(), name).toContain(`assets/${name}-template.md`);
    }
    // One name and one description for the three modes, not three.
    const pitch = definitions.find((d) => d.name === "pitch") as Definition;
    const description = (pitch.frontmatter as { description: string }).description;
    expect(description.length).toBeLessThanOrEqual(150);
  });

  it("costs a few thousand tokens for a typical path of each mode, and no tool is added", () => {
    // What the agent writes: the document (≈ 3 000 characters) and six short exchanges.
    const path = (mode: string[], template: string) =>
      (skill().length +
        mode.reduce((sum, name) => sum + file(`references/${name}.md`).length, 0) +
        file(`assets/${template}-template.md`).length +
        3_000 +
        6 * 300) /
      TOKEN;
    for (const [mode, used, template] of [
      ["design thinking", ["design"], "design"],
      ["story", ["story"], "narrative"],
      ["deck", ["deck"], "deck"],
    ] as const) {
      const tokens = path([...used], template);
      expect(tokens, `${mode}: ${Math.round(tokens)} tokens`).toBeLessThanOrEqual(2_600);
    }
    // The last step of design thinking (implementation) is a seventh file, read only
    // when the course gets there; the whole course, with it, stays under 2 900 tokens.
    const whole = path(["design", "design-implementation"], "design");
    expect(whole, `design thinking to the end: ${Math.round(whole)} tokens`).toBeLessThanOrEqual(
      2_900,
    );
    expect(createCommandRegistry().agentCommands()).toHaveLength(65);
    expect(Object.keys(TOOL_GROUPS)).toHaveLength(10);
  });
});

/**
 * The tests of the criteria are written first and the engine sees them fail
 * then pass, and it costs the agent a few short answers: one action in a tool that exists, a verdict
 * for an answer, a few lines on a red, the method read once, only when a story is built.
 */
describe("the acceptance tests first cost few tokens", () => {
  const texts = new Map(methodTexts().map(({ path, text }) => [path, text]));
  const reference = texts.get("skills/develop-story/references/acceptance-tests.md") as string;

  it("adds one action to a tool that exists, and publishes two plain fields", () => {
    expect(Object.keys(TOOL_GROUPS)).toHaveLength(10);
    expect(TOOL_GROUPS.story?.actions.criterion?.command).toBe("record_criterion");
    const tool = publishedTools(
      new Map(
        createCommandRegistry()
          .agentCommands()
          .map((c) => [c.name, c] as const),
      ),
    ).find((entry) => entry.name === "story");
    const properties = (tool?.schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    expect(properties.criterion).toEqual({ type: "integer" });
    // What the agent saw is a plain string here, checked by the engine: no enumeration to publish.
    expect(properties.seen).toEqual({ type: "string" });
    expect(tool?.description).toContain("criterion");
  });

  /** The answers of `story.criterion` to a red and to a green, as the engine builds them. */
  const answers = () => {
    const log = ".agentplugged/.cache/proof-runs/criteria-20261012T120000Z.log";
    const trace = "1:green 2:green 3:red 4:no_test 5:untestable 6:never_red 7:green(reported)";
    const green = JSON.stringify({
      story: "17-3",
      criterion: 2,
      result: "green",
      origin: "engine",
      status: "green",
      ended: "exit",
      exit: 0,
      seconds: 3.4,
      trace,
    });
    const lines = proofUsefulLines(
      Array.from({ length: 400 }, (_, index) => `error ${index}: ${"x".repeat(300)}`).join("\n"),
    );
    const red = JSON.stringify({
      story: "17-3",
      criterion: 2,
      result: "red",
      origin: "engine",
      status: "red",
      ended: "exit",
      exit: 1,
      seconds: 3.4,
      lines,
      log,
      trace,
    });
    return { green, red, lines };
  };

  it("answers a run with a verdict, a red with at most 12 short lines, and a story with one line", () => {
    const { green, red, lines } = answers();
    expect(green.length).toBeLessThanOrEqual(260);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(red.length).toBeLessThanOrEqual(RESPONSE_FORMS["story.criterion"]?.max ?? 0);
    expect(red.length / TOKEN).toBeLessThan(500);
    // The line of a story with every criterion it can hold, bounded.
    const many = traceLine(
      Array.from({ length: 60 }, (_, index) => ({
        n: index + 1,
        status: "green" as const,
        origin: "reported" as const,
      })),
    );
    expect(many.length).toBeLessThanOrEqual(600);
    // What stops a review: one short line per criterion, twelve at most.
    const missing = missingLines(
      "17-3",
      Array.from({ length: 60 }, (_, index) => ({ n: index + 1, status: "never_red" as const })),
    );
    expect(missing.join("\n").length).toBeLessThanOrEqual(900);
  });

  it("keeps the method in a file read once, when a story is built", () => {
    expect(reference).toBeDefined();
    expect(reference.length / TOKEN).toBeLessThan(1_000);
    const skill = skillText("develop-story");
    // The skill names the file; the table of languages and the yaml are not in the skill.
    expect(skill).toContain("references/acceptance-tests.md");
    expect(skill).not.toContain("proofs.yaml");
    expect(skill).not.toContain("{criterion}");
    expect(flat(reference)).toContain("`AC-<story>-<n>`");
  });

  it("costs a few thousand tokens for a typical story of five criteria", () => {
    // Two calls per criterion: the red and the green; the method read once. The answers are built
    // as in the previous test: a typical red shows five lines of a hundred characters, the worst
    // one twelve (bounded by the engine).
    const { green, red: worst } = answers();
    const typical = JSON.stringify({
      ...JSON.parse(worst),
      lines: Array.from({ length: 5 }, () => "x".repeat(100)),
    });
    const method = reference.length / TOKEN;
    const story = (red: string) => 5 * ((red.length + green.length) / TOKEN) + method;
    expect(story(typical)).toBeLessThanOrEqual(1_700);
    // Even when every red shows its twelve lines.
    expect(story(worst)).toBeLessThanOrEqual(2_500);
    // The judge gets the line of the story instead of recomputing it from the diff.
    expect(RESPONSE_FORMS["review.start"]?.max).toBeLessThanOrEqual(900);
  });
});

/**
 * The engine runs the project's commands itself, and it costs the agent
 * almost nothing: one action in a tool that exists, a verdict for an answer, a few lines on a
 * failure, a method read only when it is needed.
 */
describe("the proofs the engine produces cost few tokens", () => {
  const texts = new Map(methodTexts().map(({ path, text }) => [path, text]));

  it("adds one action to a tool that exists, and no tool", () => {
    expect(Object.keys(TOOL_GROUPS)).toHaveLength(10);
    expect(TOOL_GROUPS.measure?.actions.run?.command).toBe("run_proof_command");
    const tool = publishedTools(
      new Map(
        createCommandRegistry()
          .agentCommands()
          .map((c) => [c.name, c] as const),
      ),
    ).find((entry) => entry.name === "measure");
    const properties = (tool?.schema.properties ?? {}) as Record<string, unknown>;
    // The name of the command goes in a field the tool already publishes: no new field either.
    expect(Object.keys(properties)).not.toContain("command");
    expect(Object.keys(properties)).toContain("source");
    expect(tool?.description).toContain("run (a command the creator accepted)");
  });

  it("answers a run with a verdict, and a failure with at most 12 short lines", () => {
    const log = ".agentplugged/.cache/proof-runs/tests-20261009T120000Z.log";
    const passed = JSON.stringify({
      command: "tests",
      ok: true,
      ended: "exit",
      exit: 0,
      seconds: 41.2,
      proved: ["ENF-2", "ENF-5"],
      failed: [],
      log,
    });
    expect(passed.length).toBeLessThanOrEqual(260);
    const output = Array.from(
      { length: 400 },
      (_, index) => `error number ${index}: ${"x".repeat(300)}`,
    ).join("\n");
    const lines = proofUsefulLines(output);
    expect(lines.length).toBeLessThanOrEqual(12);
    const failed = JSON.stringify({
      command: "tests",
      ok: false,
      ended: "exit",
      exit: 1,
      seconds: 41.2,
      proved: [],
      failed: ["ENF-2", "ENF-5"],
      lines,
      log,
    });
    expect(failed.length).toBeLessThanOrEqual(RESPONSE_FORMS["measure.run"]?.max ?? 0);
    expect(failed.length / TOKEN).toBeLessThan(400);
    expect(RESPONSE_FORMS["measure.run"]?.kind).toBe("decision");
  });

  it("keeps the method in a file read only when a command is to be run", () => {
    const skill = skillText("check-requirements");
    const reference = texts.get("skills/check-requirements/references/engine-proofs.md") as string;
    expect(reference).toBeDefined();
    expect(reference.length / TOKEN).toBeLessThan(700);
    // The skill names the file; none of its content is in the skill.
    expect(skill).toContain("references/engine-proofs.md");
    expect(skill).not.toContain("proof_commands");
    expect(skill).not.toContain("measured_after");
    expect(flat(reference)).toContain("Show `preview` to the creator as it is");
    expect(flat(reference)).toContain("never reword it");
  });
});

/**
 * The test framework and the API and end-to-end tests add no tool (the plan
 * is a command of the command line, the runs are `story.criterion`), one name and one
 * description to the lists, a short skill and one short file read when a mode runs.
 */
describe("the test framework and the API and end-to-end tests stay light", () => {
  const texts = new Map(methodTexts().map(({ path, text }) => [path, text]));
  const own = (name: string) => texts.get(`skills/api-e2e-tests/${name}`) as string;
  const references = ["ci"].map((name) => own(`references/${name}.md`));

  it("adds no tool and no action: the plan is for the creator's command line", () => {
    expect(createCommandRegistry().agentCommands()).toHaveLength(65);
    expect(createCommandRegistry().names()).toContain("tests");
    expect(exposedCommands()).not.toContain("tests");
    expect(Object.keys(TOOL_GROUPS)).toHaveLength(10);
  });

  it("keeps a short skill and short references, each sent to by the skill", () => {
    const skill = skillText("api-e2e-tests");
    expect(skill.length / TOKEN).toBeLessThan(1_200);
    for (const [index, name] of ["ci"].entries()) {
      expect(references[index]?.length ?? 0, name).toBeGreaterThan(0);
      expect((references[index] as string).length / TOKEN, name).toBeLessThan(1_000);
      expect(skill, name).toContain(`references/${name}.md`);
    }
    // The detail (the table of runners, the data rules) is not in the skill; the CI is in its file.
    expect(skill).not.toContain("Playwright");
    expect(skill).not.toContain("fixture");
    const description = (definitions.find((d) => d.name === "api-e2e-tests") as Definition)
      .frontmatter as { description: string };
    expect(description.description.length).toBeLessThanOrEqual(150);
  });

  it("answers the plan in a few lines, whatever the stack", () => {
    const worst: TestsSetupResult = {
      status: "exists",
      path: ".agentplugged/proofs.yaml",
      problems: [],
      plan: {
        stack: "node",
        ui: true,
        api: { name: "vitest", present: false, chosen: "default" },
        e2e: { name: "cypress", present: false, chosen: "asked" },
        line: `npx vitest run -t {criterion} --passWithNoTests && npx cypress run --env grep={criterion}`,
        installs: [
          { ecosystem: "npm", packages: ["vitest"], command: "npm install --save-dev vitest" },
          {
            ecosystem: "npm",
            packages: ["cypress", "@cypress/grep"],
            command: "npm install --save-dev cypress @cypress/grep",
          },
        ],
        notes: [
          "also found: python (this plan is for node; run it again where the other lives)",
          "cypress needs the @cypress/grep plugin to filter by name",
        ],
      },
    };
    const text = formatTestsSetup(createTranslator("en"), worst);
    expect(text.length).toBeLessThanOrEqual(1_200);
    expect(text.split("\n").length).toBeLessThanOrEqual(12);
  });

  it("costs a few thousand tokens to frame a product and cover five criteria", () => {
    const skill = skillText("api-e2e-tests");
    const plan = 1_200;
    // The red and the green of `story.criterion` for each criterion: a typical red of five short
    // lines (≈ 500 characters), and a green of ≈ 250 (measured).
    const perCriterion = 500 + 250;
    const frame = (skill.length + references.join("").length + plan) / TOKEN;
    const cover = (5 * perCriterion) / TOKEN;
    expect(frame, `${Math.round(frame)} tokens`).toBeLessThanOrEqual(1_900);
    expect(frame + cover, `${Math.round(frame + cover)} tokens`).toBeLessThanOrEqual(2_850);
  });
});

/**
 * A change of course is one action in a tool that exists (`plan.course`),
 * the skill is short and its detail is read when needed, and the engine answers a stack of at most
 * twelve lines whatever the size of the impact.
 */
describe("a change of course costs few tokens", () => {
  const texts = new Map(methodTexts().map(({ path, text }) => [path, text]));
  const own = (name: string) => texts.get(`skills/correct-course/${name}`) as string;

  it("adds one action to a tool that exists, and no tool", () => {
    expect(Object.keys(TOOL_GROUPS)).toHaveLength(10);
    expect(TOOL_GROUPS.plan?.actions.course?.command).toBe("correct_course");
    const tool = publishedTools(
      new Map(
        createCommandRegistry()
          .agentCommands()
          .map((c) => [c.name, c] as const),
      ),
    ).find((entry) => entry.name === "plan");
    const properties = (tool?.schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    // The step is checked by the engine and published as a plain string: no enumeration.
    expect(properties.step).toEqual({ type: "string" });
    expect(tool?.description).toContain("course (change of mind)");
  });

  it("keeps the skill short and its detail in files read when needed", () => {
    expect(own("SKILL.md").length).toBeLessThanOrEqual(900);
    for (const name of ["steps", "starts", "gestures"]) {
      expect(own(`references/${name}.md`), name).toBeDefined();
      expect(own(`references/${name}.md`).length, name).toBeLessThanOrEqual(1_400);
    }
    expect(own("SKILL.md")).toContain("references/steps.md");
    expect(flat(own("SKILL.md"))).not.toContain("step: decide");
  });

  it("answers at most twelve lines of the stack, however large the impact", () => {
    // The worst stack: eighty elements, each line at its longest, every proof going stale.
    const stack = Array.from({ length: 80 }, (_, index) => ({
      n: index + 1,
      kind: "story" as const,
      ref: `12-${index + 1}`,
      why: "x".repeat(200),
      status: "in_progress" as const,
      developer: "hugo",
      gesture: null,
      reason: null,
      decided_at: null,
    }));
    const course = {
      id: "C-7M2K9QX4TB",
      stack,
      more: 5_000,
      proofs: Array.from({ length: 20 }, (_, index) => `ENF-${index + 10}`),
    } as unknown as CourseRecord;
    const answer = JSON.stringify(
      shapeResponse("plan", "course", openedAnswer(course) as never, new ResponseMemory()),
    );
    expect(openedAnswer(course).stack).toHaveLength(12);
    expect(leftLines(course, 12).lines.every((line) => line.length <= 140)).toBe(true);
    expect(answer.length).toBeLessThanOrEqual(RESPONSE_FORMS["plan.course"]?.max ?? 0);
  });

  it("costs a few thousand tokens for a typical correction", () => {
    // The skill, then the steps; the starts and the gestures once each.
    const read =
      own("SKILL.md").length +
      ["steps", "starts", "gestures"].reduce(
        (sum, name) => sum + own(`references/${name}.md`).length,
        0,
      );
    // A typical change: two requirements, a document, three stories (one under way), a page.
    const entry = (kind: string, ref: string, why: string, extra: object = {}) => ({
      kind,
      ref,
      why,
      gesture: null,
      reason: null,
      decided_at: null,
      ...extra,
    });
    const course = {
      id: "C-7M2K9QX4TB",
      more: 0,
      proofs: ["ENF-1"],
      stack: [
        entry("requirement", "EF-1", "prd.md:10, the change starts here; 3 stories, 1 test file"),
        entry(
          "requirement",
          "ENF-1",
          "prd.md:12, the change starts here; 1 story, its proof goes stale",
        ),
        entry("document", ".agentplugged/docs/ux.md", "names EF-1 (line 10)"),
        entry("story", "1-2", "in progress · cites EF-1, 2 criteria, 1 test file", {
          status: "in_progress",
          developer: "hugo",
        }),
        entry("story", "1-3", "to do · cites EF-1, 2 criteria, 1 test file", { status: "todo" }),
        entry("story", "1-1", "done · cites EF-1, 2 criteria, 1 test file", { status: "done" }),
        entry("page", ".agentplugged/docs/reference/sign-in.md", "built on a touched document"),
      ],
    } as unknown as CourseRecord;
    const answered = [
      shapeResponse("plan", "course", openedAnswer(course) as never, new ResponseMemory()),
      {
        course: course.id,
        decided: { retire: 1, update: 5, keep: 1 },
        handoff: [{ owner: "maya", refs: ["retire EF-1", "ENF-1"] }],
        left: 0,
      },
      { course: course.id, closed: true },
    ]
      .map((answer) => JSON.stringify(answer))
      .join("").length;
    // What the agent writes: the change in a line, the creator's words twice, the starts, seven gestures.
    const written = 150 + 2 * 120 + 40 + 7 * 40;
    const tokens = (read + answered + written) / TOKEN;
    expect(tokens, `${Math.round(tokens)} tokens`).toBeLessThanOrEqual(1_450);
  });
});

/**
 * A deep research adds no tool (the report is a page of the knowledge base
 * checked by `docs check`, the lookup is `docs research`), the skill is short with its detail in
 * `references/`, and reusing a recent research costs a fraction of searching again.
 */
describe("a deep research is light, and reusing it is lighter", () => {
  const texts = new Map(methodTexts().map(({ path, text }) => [path, text]));
  const file = (path: string) => texts.get(`skills/deep-research/${path}`) as string;
  const skill = () => skillText("deep-research");

  it("keeps a short skill and short references, and adds no tool", () => {
    // The skill carries the modes (draft, import, select) and the plan with its price;
    // their detail is in two new references, read only when the mode serves.
    expect(skill().length).toBeLessThanOrEqual(2_950);
    expect(file("references/types.md").length).toBeLessThanOrEqual(2_600);
    expect(file("references/page-format.md").length).toBeLessThanOrEqual(3_150);
    expect(file("references/external.md").length).toBeLessThanOrEqual(2_300);
    expect(file("references/candidates.md").length).toBeLessThanOrEqual(2_300);
    expect(file("assets/page-template.md").length).toBeLessThanOrEqual(1_320);
    expect(createCommandRegistry().agentCommands()).toHaveLength(65);
    expect(Object.keys(TOOL_GROUPS)).toHaveLength(10);
  });

  it("costs a few thousand tokens to search (the web reads apart), and a fraction to reuse", () => {
    // Search: the skill, the types, the page format and the template; three sub-agents that each
    // read the rules (≈ 1 500 characters) and return 8 findings of ≈ 280 characters; the page the
    // agent writes (12 claims of ≈ 170 characters, 8 sources of ≈ 150, the header); a short answer.
    const rules = 1_500;
    // A finding also carries its publisher and its publication date (≈ 330 characters).
    const returned = 3 * 7 * 330;
    const page = 12 * 170 + 8 * 150 + 400;
    const search =
      skill().length +
      file("references/types.md").length +
      file("references/page-format.md").length +
      file("assets/page-template.md").length +
      3 * rules +
      returned +
      page +
      600;
    // Reuse: the skill, the lines the engine returns (five pages at most, a subject cut at 80
    // characters: the worst case for a line) and the answer in a few lines.
    const line = researchLine({
      path: ".agentplugged/docs/research/a-fairly-long-topic-name-for-the-market.md",
      subject: "x".repeat(200),
      types: ["market", "competitive", "user_voice"],
      imported: true,
      date: "2026-10-12",
      age_days: 1234,
      max_age_days: 365,
      fresh: false,
      sound: true,
      claims: 60,
      doubts: 60,
      flagged: 60,
      redo: Array.from({ length: 60 }, (_, index) => 100 + index),
    });
    expect(line.length).toBeLessThanOrEqual(330);
    const reuse = skill().length + 5 * line.length + 600;
    // 5 700; the dates, the key claims and the effort cost about 12 % more.
    expect(search / TOKEN, `${Math.round(search / TOKEN)} tokens`).toBeLessThanOrEqual(5_750);
    expect(reuse / TOKEN, `${Math.round(reuse / TOKEN)} tokens`).toBeLessThanOrEqual(1_260);
    expect(reuse).toBeLessThan(search / 2);
  });

  /**
   * Each way of working loads, before the web, less than the reference
   * method's files for the same way (sizes in characters: its skill 9 298, its
   * search 9 459, verification 4 222, synthesis 2 788, closing 1 797, draft 1 909, import 1 955,
   * selection 2 341, a type's pack ≈ 1 590, its template 460).
   */
  it("loads less than the reference method for every way of working", () => {
    const REFERENCE = { skill: 9_298, pack: 1_590, template: 460 };
    const referenceSearch =
      REFERENCE.skill + 9_459 + 4_222 + 2_788 + 1_797 + REFERENCE.pack + REFERENCE.template;
    const references = {
      search: referenceSearch,
      draft: REFERENCE.skill + 1_909 + REFERENCE.pack,
      import: REFERENCE.skill + 1_955 + 4_222 + 2_788 + 1_797 + REFERENCE.pack + REFERENCE.template,
      select: referenceSearch + 2_341,
    };
    const types = file("references/types.md").length;
    const format = file("references/page-format.md").length;
    const template = file("assets/page-template.md").length;
    const ours = {
      search: skill().length + types + format + template,
      draft: skill().length + file("references/external.md").length + types,
      import: skill().length + file("references/external.md").length + types + format + template,
      select: skill().length + types + format + template + file("references/candidates.md").length,
    };
    for (const way of ["search", "draft", "import", "select"] as const) {
      expect(ours[way], way).toBeLessThanOrEqual(references[way] * 0.75);
    }
  });

  it("announces the price of a search in a few short lines, before any sub-agent", () => {
    const lines = researchLines(planRun(5));
    expect(lines).toHaveLength(4);
    expect(lines.join("\n").length).toBeLessThanOrEqual(700);
    const [light, standard, thorough] = planRun(5).efforts;
    // The web reads dominate (≈ 3 000 tokens a page): light 8 reads, standard 21, thorough 60 with its second round.
    expect(standard?.tokens.expected ?? 0).toBeLessThanOrEqual(71_900);
    expect(light?.tokens.expected ?? 0).toBeLessThanOrEqual(29_600);
    expect(thorough?.tokens.expected ?? 0).toBeLessThanOrEqual(199_300);
    expect(planImport(40_000).efforts[0]?.tokens.expected ?? 0).toBeLessThanOrEqual(28_000);
  });
});

/**
 * A short skill, its detail in `references/`,
 * read when the situation needs it; only the persona of the agents seated is read; the turns are
 * bounded; no tool is added (an action of `chat`).
 */
describe("the round table stays light", () => {
  const texts = new Map(methodTexts().map(({ path, text }) => [path, text]));
  const reference = (name: string) =>
    texts.get(`skills/round-table/references/${name}.md`) as string;
  /** What a seated agent is read for in its file: who it is (Overview) and how it speaks (Persona). */
  const persona = (name: string) => {
    const body = agentBody(name);
    const section = (title: string, next: string) => {
      const start = body.indexOf(title);
      return body.slice(start, body.indexOf(next, start));
    };
    return `${section("## Overview", "\n## ")}${section("## Persona", "## Persistent facts")}`;
  };

  // The detail of an open conversation (who speaks, guests, saved rooms, independent
  // minds) is in files of its own, each read only when the situation comes up.
  const REFERENCES = ["table", "guests", "closing", "rooms"];

  it("keeps a skill under 1 800 characters and a short file for each situation", () => {
    expect(skillText("round-table").length).toBeLessThanOrEqual(1_800);
    for (const name of REFERENCES) {
      expect(reference(name), name).toBeDefined();
      expect(reference(name).length, name).toBeLessThanOrEqual(1_800);
    }
    // The skill sends to the detail instead of carrying it.
    for (const name of REFERENCES) {
      expect(skillText("round-table"), name).toContain(`references/${name}.md`);
    }
  });

  it("adds no tool: an action of `chat`, with the fields of the engine's record", () => {
    expect(Object.keys(TOOL_GROUPS).length).toBeLessThanOrEqual(12);
    expect(TOOL_GROUPS.chat?.actions.table?.command).toBe("round_table");
    expect(createCommandRegistry().agentCommands()).toHaveLength(65);
  });

  it("reads only the persona of the agents seated, a fraction of their files", () => {
    for (const name of ["maya", "quentin", "omar"]) {
      expect(persona(name).length, name).toBeGreaterThan(200);
      expect(persona(name).length, name).toBeLessThan(agentBody(name).length * 0.4);
    }
  });

  it("costs a few thousand tokens for a table of three agents in two rounds", () => {
    const shared = skillText("round-table").length + reference("table").length;
    const personas = ["maya", "quentin", "omar"].reduce(
      (sum, name) => sum + persona(name).length,
      0,
    );
    // What is said: the list in a line, two rounds of three turns of ≈ 350 characters, the
    // creator's two interventions, the synthesis and the question of the gesture.
    const said = 150 + 6 * 350 + 2 * 120 + 700 + 150;
    const closing = reference("closing").length;
    // The call is one the engine's own schema accepts.
    const record = {
      agent: "noah",
      table: {
        agents: ["maya", "quentin", "omar"].map((id) => ({ id, why: "x".repeat(80) })),
        synthesis: {
          topic: "x".repeat(120),
          agreed: ["x".repeat(150)],
          disputed: ["x".repeat(150)],
          advice: "x".repeat(200),
        },
        gesture: { type: "decision", subject: "x".repeat(100), owner: "maya" },
      },
      quote: "x".repeat(120),
    };
    expect(RoundTableInputSchema.safeParse(record).success).toBe(true);
    const call = JSON.stringify({ action: "table", ...record }).length;
    const answer = JSON.stringify(
      shapeResponse(
        "chat",
        "table",
        { gesture: "decision", owner: "maya", subject: "x".repeat(100), advice: "x".repeat(200) },
        new ResponseMemory(),
      ),
    );
    // A closing answers a few hundred characters; only the recall of a saved room is larger.
    expect(answer.length).toBeLessThanOrEqual(700);
    const tokens = (shared + personas + said + closing + call + answer.length) / TOKEN;
    // The file `table`, the rules of conduct and of the closing are read at the start and at the end.
    expect(tokens, `${Math.round(tokens)} tokens`).toBeLessThanOrEqual(3_400);
  });

  /**
   * A typical open session: five agents and a guest speak over four
   * rounds of three turns (≈ 300 characters each), the creator steps in three times, a saved room is
   * recalled, then the closing. The cost of each way of voicing the table, in tokens.
   */
  describe("costs, for a session of five agents and a guest in four rounds, by mode", () => {
    const TURN = 300;
    const ROUNDS = 4;
    const VOICES = 3;
    /** The sizes of the session, read when the definitions are loaded. */
    const session = () => {
      const names = ["maya", "quentin", "omar", "chloe", "sam"];
      const personas = names.reduce((sum, name) => sum + persona(name).length, 0);
      const said = 150 + ROUNDS * VOICES * TURN + 3 * 120 + 700 + 150;
      const guest = 400;
      const read =
        skillText("round-table").length +
        reference("table").length +
        reference("closing").length +
        reference("rooms").length;
      const closing = 1_700 + 360;
      /** What the voiced table costs: everything is read and said once, by one mind. */
      const voiced = read + personas + guest + said + closing + 1_200;
      return { voiced, persona: personas / names.length };
    };

    it("keeps the default mode, voiced, under 5 350 tokens", () => {
      const { voiced } = session();
      expect(voiced / TOKEN, `${Math.round(voiced / TOKEN)} tokens`).toBeLessThanOrEqual(5_350);
    });

    it("pays an independent round only when it matters, a sub-agent per voice each turn on request", () => {
      const { voiced, persona: heard } = session();
      const table = reference("table");
      const independence = table.length - table.indexOf("## Independent minds");
      // One round in four needs independent minds: three sub-agents that read the room so far.
      const whenItMatters = voiced + independence + VOICES * (heard + 2_500 + TURN);
      // Standing sub-agents: started once with the persona and the brief, then each turn they hear
      // the round just passed (≈ 900 characters) and answer; the host weaves their replies.
      const eachTurn =
        voiced +
        independence +
        VOICES * (heard + 500) +
        ROUNDS * VOICES * (900 + TURN) +
        ROUNDS * VOICES * TURN;
      expect(voiced).toBeLessThan(whenItMatters);
      expect(whenItMatters).toBeLessThan(eachTurn);
      expect(
        whenItMatters / TOKEN,
        `${Math.round(whenItMatters / TOKEN)} tokens`,
      ).toBeLessThanOrEqual(8_800);
      expect(eachTurn / TOKEN, `${Math.round(eachTurn / TOKEN)} tokens`).toBeLessThanOrEqual(
        11_600,
      );
    });

    it("reads a saved room as a summary: even the fullest room fits the answer's ceiling", () => {
      const full = RoomSchema.parse({
        name: "n".repeat(60),
        setting: "s".repeat(300),
        members: Array.from({ length: 12 }, (_, i) => `agent-${i + 10}`),
        guests: Array.from({ length: 6 }, (_, i) => ({
          id: `guest-voice-${i}`,
          name: "g".repeat(40),
          role: "r".repeat(80),
          persona: "p".repeat(240),
          field: "law",
        })),
        memory: true,
      });
      const room = {
        id: "i".repeat(40),
        ...full,
        remembers: true,
        absent: [],
        // The latest eight lines, a short total (1 200 characters, `recalledMemory`).
        memory: Array.from({ length: 6 }, () => "m".repeat(200)),
      };
      const answer = JSON.stringify(shapeResponse("chat", "table", { room }, new ResponseMemory()));
      expect(answer.length).toBeLessThanOrEqual(RESPONSE_FORMS["chat.table"]?.max ?? 0);
    });
  });

  it("bounds the three views: five lines a view, and a one-line offer in `next`", () => {
    const views = reference("rooms");
    expect(views).toContain("at most five lines");
    // The offer `next` makes, as the engine builds it for the shipped team: one short line.
    const offer = tableOffer("12-3", new Set(["maya", "omar", "quentin", "noah"]));
    expect(JSON.stringify({ table: offer }).length).toBeLessThanOrEqual(100);
  });
});

describe("measuring by step costs the agent nothing", () => {
  const row = (index: number) => ({
    key: `a-skill-named-at-length-${String(index).padStart(2, "0")}-${"x".repeat(30)}`,
    origin: "interval" as const,
    tokens_in: 1_234_567,
    tokens_out: 1_234_567,
    cache_read: 123_456_789,
    cache_write: 12_345_678,
    total: 138_049_601,
    share: 0.123,
  });

  it("adds no tool and no action to the agents' list: the report is the creator's command", () => {
    expect(exposedCommands()).not.toContain("usage");
    expect(
      createCommandRegistry()
        .agentCommands()
        .map((command) => command.name),
    ).not.toContain("usage");
  });

  it("keeps the report to the ten heaviest rows, and the whole session of improvement under 2 000 tokens", () => {
    const worst: UsageReport = {
      usage: "report",
      axis: "skill",
      story: "12-345",
      since: "2026-10-01",
      until: "2026-10-31",
      measured: true,
      sessions: 999,
      sessions_without_parts: 999,
      tokens_origin: { "claude-code": 1 },
      total: {
        tokens_in: 1_234_567_890,
        tokens_out: 1_234_567_890,
        cache_read: 1_234_567_890,
        cache_write: 1_234_567_890,
        total: 4_938_271_560,
      },
      rows: Array.from({ length: 40 }, (_, index) => row(index)),
      unattributed_share: 0.5,
      tools: { unmeasurable: ["cursor"], unread: ["codex", "antigravity"] },
      unreadable: false,
      estimates: {
        standard: { low: 2, expected: 6, high: 14, basis: "history", stories: 12 },
        fast: { low: 0.3, expected: 1, high: 4, basis: "reference", stories: 0 },
      },
      habits: {
        session: "claude-code:agent-0123456789abcdef0123456789abcdef",
        found: {
          skills_reloaded: [1, 2, 3].map((n) => ({
            skill: `skill-${n}`.padEnd(40, "x"),
            calls: n + 1,
          })),
          files_reread: [1, 2, 3].map((n) => ({
            path: `${"p/".repeat(30)}f${n}.ts`,
            reads: n + 3,
            chars: 99_999,
          })),
          tools_failing: [1, 2, 3].map((n) => ({
            tool: `mcp__server__tool${n}`.padEnd(40, "x"),
            calls: 9,
            errors: 4,
          })),
        },
      },
    };
    const text = formatUsage(createTranslator("en"), worst);
    expect(text.match(/a-skill-named/g)).toHaveLength(10);
    // The skill (about 2 900 characters) and the three views of the report (sessions, skills, one
    // session's habits), each at its worst (names of 70 characters): 3 000 tokens.
    const session = (shown: string) =>
      (skillText("improve-session").length + shown.length * 3) / TOKEN;
    expect(session(text), `${Math.round(session(text))} tokens`).toBeLessThanOrEqual(3_100);
    // With the names of a real product: under 2 000 tokens.
    const typical = formatUsage(createTranslator("en"), {
      ...worst,
      rows: worst.rows.slice(0, 6).map((one) => ({ ...one, key: (one.key ?? "").slice(0, 14) })),
      habits: {
        session: "claude-code:agent-1a2b3c",
        found: {
          skills_reloaded: [{ skill: "develop-story", calls: 2 }],
          files_reread: [{ path: "src/app.ts", reads: 4, chars: 12_000 }],
          tools_failing: [],
        },
      },
    });
    expect(session(typical), `${Math.round(session(typical))} tokens`).toBeLessThanOrEqual(2_000);
  });
});
