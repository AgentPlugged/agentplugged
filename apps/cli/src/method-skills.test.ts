import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  AGENT_DOMAINS,
  checkDocuments,
  type Definition,
  type DocumentFile,
  GENERATED_HEADER,
  mockupFaults,
  parseDocumentFile,
  readDefinitions,
  uxDocumentChecks,
  uxElementsOf,
  withGeneratedHeader,
} from "@agentplugged/core";
import type { SkillFrontmatter } from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { sharedRules } from "./__helpers__/shared-rules.js";

/** The shipped method: the `@agentplugged/method` package of the monorepo. */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);

/**
 * The workflows of the product team: the agent that calls each one from its menu (and the menu
 * code), its phase, the document it writes from its template, and that document's kind.
 */
const WORKFLOWS = {
  "write-brief": {
    agent: "iris",
    code: "BR",
    phase: "framing",
    template: "assets/brief-template.md",
    checklist: "references/brief-checklist.md",
    document: ".agentplugged/docs/brief.md",
    kind: "brief",
  },
  "write-prd": {
    agent: "maya",
    code: "PR",
    phase: "planning",
    template: "assets/prd-template.md",
    checklist: "references/prd-checklist.md",
    document: ".agentplugged/docs/prd.md",
    kind: "prd",
  },
  "write-ux-spec": {
    agent: "stella",
    code: "UX",
    phase: "planning",
    template: "assets/ux-template.md",
    checklist: "references/ux-checklist.md",
    document: ".agentplugged/docs/ux.md",
    kind: "ux",
  },
} as const;

type WorkflowId = keyof typeof WORKFLOWS;
const WORKFLOW_IDS = Object.keys(WORKFLOWS) as WorkflowId[];

/** What every workflow does, in its steps: the method's reporting and checks. */
const COMMON_STEPS = [
  "`agent.status`",
  "`state.get`",
  "`phase.current`",
  "One question at a time",
  "`npx agentplugged docs check`",
  "`story.result`",
  "`idle`",
  // Review mode is a critique only.
  "never copy the template",
  "never open the end of the phase",
  // An inactive agent stops early, and still reports.
  "go straight to the last step (Report) with `partial`",
  // Decisions: opened, marked, applied whatever the answer.
  "`type: decision`",
  "never before an identifier",
  // Applying a resolution is written once, in the reference (« Applying a resolution »).
  'and apply it as "Applying a resolution" says',
  // The decision gate, then the end of the phase: committed first, refused ends reopened.
  "Decision gate",
  "by any agent",
  "`npx agentplugged next --json`",
  "`changes_requested`",
  "`phase_review`",
  "`git branch --show-current`",
  "`git commit`",
  "`git rev-parse HEAD:",
  "(`docs check` refuses it)",
  "every `<…>` placeholder",
];

/** The other templates a workflow ships, with the document each one becomes. */
const OTHER_TEMPLATES: ReadonlyArray<{
  readonly skill: string;
  readonly template: string;
  readonly document: string;
}> = [
  {
    skill: "write-brief",
    template: "assets/research-note-template.md",
    document: ".agentplugged/docs/research/topic.md",
  },
  // The press release written before building.
  {
    skill: "test-idea",
    template: "assets/prfaq-template.md",
    document: ".agentplugged/docs/prfaq.md",
  },
];

let skills: Map<string, Definition>;
let agents: Map<string, Definition>;

beforeAll(async () => {
  const method = new NodeWorkspaceFiles(methodDir);
  const loadedSkills = await readDefinitions(method, "skills", "skill");
  const loadedAgents = await readDefinitions(method, "agents", "agent");
  if (!Array.isArray(loadedSkills) || !Array.isArray(loadedAgents)) {
    throw new Error("invalid shipped definition");
  }
  skills = new Map(loadedSkills.map((definition) => [definition.name, definition]));
  agents = new Map(loadedAgents.map((definition) => [definition.name, definition]));
});

function skillOf(id: WorkflowId): Definition {
  const definition = skills.get(id);
  if (definition === undefined) throw new Error(`${id} is not shipped`);
  return definition;
}

/** A file of a skill's folder, as shipped. */
function annex(id: string, path: string): string {
  return readFileSync(join(methodDir, "skills", id, path), "utf8").replace(/\r\n/g, "\n");
}

const flat = (text: string) => text.replace(/\s+/g, " ");

describe("the shipped workflows", () => {
  it("ships every workflow as a valid skill", () => {
    for (const id of WORKFLOW_IDS) expect([...skills.keys()], id).toContain(id);
  });

  it("calls only shipped skills from the agents' menus", () => {
    for (const agent of agents.values()) {
      for (const item of agent.agent?.menu ?? []) {
        if (item.skill === undefined) continue;
        expect(skills.has(item.skill), `${agent.name} ${item.code}: ${item.skill}`).toBe(true);
      }
    }
  });

  it.each(WORKFLOW_IDS)("ties %s to its agent, its phase and its menu item", (id) => {
    const expected = WORKFLOWS[id];
    const metadata = (skillOf(id).frontmatter as SkillFrontmatter).metadata;
    expect(metadata).toMatchObject({ agent: expected.agent, phase: expected.phase });
    const menu = agents.get(expected.agent)?.agent?.menu ?? [];
    const item = menu.find((entry) => entry.code === expected.code);
    expect(item?.skill).toBe(id);
    expect(item?.prompt).toBeUndefined();
  });

  it.each(WORKFLOW_IDS)("gives %s its sections, its steps and its files", (id) => {
    const { body, annexes } = skillOf(id);
    for (const title of ["Overview", "Before you start", "Steps", "Rules"]) {
      const headings = body.split("\n").filter((line) => line === `## ${title}`);
      expect(headings, `${id}: ## ${title}`).toHaveLength(1);
    }
    const text = flat(body);
    for (const step of COMMON_STEPS) expect(text, `${id}: ${step}`).toContain(step);
    expect(text).toContain(`\`agent: ${WORKFLOWS[id].agent}\``);
    expect(text).toContain(`\`${WORKFLOWS[id].document}\``);
    expect(text).toContain(`\`${WORKFLOWS[id].template}\``);
    expect(text).toContain(`\`${WORKFLOWS[id].checklist}\``);
    expect(annexes).toContain(WORKFLOWS[id].template);
    expect(annexes).toContain(WORKFLOWS[id].checklist);
  });

  it("makes Iris ask, research, check, report and open the end of framing", () => {
    const text = flat(skillOf("write-brief").body);
    for (const step of [
      "`.agentplugged/docs/research/<topic>.md`",
      "Search only once the creator agrees",
      "`guard.external_read`",
      "Never invent a figure",
      "`decision` checkpoint",
      "`type: phase_end`, `phase: framing`",
      "`git rev-parse HEAD:.agentplugged/docs/brief.md`",
      "while `phase.current` is `framing`",
      "`assets/research-note-template.md`",
      "`research-<topic>`",
    ]) {
      expect(text, step).toContain(step);
    }
    expect(skillOf("write-brief").annexes).toContain("assets/research-note-template.md");
  });

  /** Every template, as shipped, at the path of the document it becomes. */
  function templates(): DocumentFile[] {
    return [
      ...WORKFLOW_IDS.map((id) => ({
        path: WORKFLOWS[id].document,
        text: annex(id, WORKFLOWS[id].template),
      })),
      ...OTHER_TEMPLATES.map(({ skill, template, document }) => ({
        path: document,
        text: annex(skill, template),
      })),
    ];
  }
  const owners = new Set(Object.keys(AGENT_DOMAINS));

  it("ships templates that pass docs check", () => {
    expect(checkDocuments({ current: templates(), owners })).toEqual([]);
    for (const id of WORKFLOW_IDS) {
      const parsed = parseDocumentFile(WORKFLOWS[id].document, annex(id, WORKFLOWS[id].template));
      expect(parsed.header).toMatchObject({
        kind: WORKFLOWS[id].kind,
        owner: WORKFLOWS[id].agent,
      });
    }
    const note = parseDocumentFile(
      ".agentplugged/docs/research/topic.md",
      annex("write-brief", "assets/research-note-template.md"),
    );
    expect(note.header).toMatchObject({ id: "research-topic", kind: "note", owner: "iris" });
    expect(note.definitions).toEqual([]);
  });

  it("refuses a template copied with its generated line, and accepts it once the line is gone", () => {
    // As `sync` renders them in a tool's skill folder: the marker right after the header.
    const rendered = templates().map((file) => ({
      ...file,
      text: withGeneratedHeader(file.text),
    }));
    const problems = checkDocuments({ current: rendered, owners });
    expect(problems.map((problem) => [problem.details.path, problem.details.reason_key])).toEqual(
      rendered.map((file) => [file.path, "reason.doc_generated_marker"]).sort(),
    );
    // What the skills ask: remove that line.
    const cleaned = rendered.map((file) => ({
      ...file,
      text: file.text.replace(`${GENERATED_HEADER}\n`, ""),
    }));
    expect(checkDocuments({ current: cleaned, owners })).toEqual([]);
  });

  it("keeps requirement identifiers out of the brief", () => {
    const brief = parseDocumentFile(
      WORKFLOWS["write-brief"].document,
      annex("write-brief", WORKFLOWS["write-brief"].template),
    );
    expect(brief.definitions).toEqual([]);
  });

  it("makes Maya number the requirements for good and ask a decision for each ambiguity", () => {
    const text = flat(skillOf("write-prd").body);
    for (const step of [
      "`PU-n`",
      "`EF-n`",
      "`ENF-n`",
      "`MS-n`",
      "the highest ever used, retired ones included, plus one",
      "`EF-2 : (retirée) …`",
      "`EF-2 : (retired) …`",
      "`type: decision`",
      "two to four options",
      "`recommendation`",
      "Never choose in the creator's place",
      "`[open: G-…]`",
      "counter-metric",
      "`npx agentplugged next --json`",
      "**A UX specification is still to come**",
      "`type: phase_end`, `phase: planning`",
      "by any agent (yours and Stella's)",
      "only when `.agentplugged/docs/ux.md` exists",
      "`[open: G-…]` at the end of the sentence concerned",
    ]) {
      expect(text, step).toContain(step);
    }
  });

  it("makes Stella link the experience to the requirements and check its accessibility", () => {
    const { body, annexes } = skillOf("write-ux-spec");
    const text = flat(body);
    for (const step of [
      "it does not need an approval",
      "Maya writes the PRD first",
      "`npx agentplugged agent enable maya`",
      "two or three directions",
      "hexadecimal values for light and dark modes",
      "One key flow per journey (`PU-n`)",
      "you never write a requirement",
      "`type: decision`",
      "`references/accessibility-check.md`",
      '"Accessibility check" section',
      "`npx agentplugged next --json`",
      "`agent` is `stella`",
      "`type: phase_end`, `phase: planning`",
    ]) {
      expect(text, step).toContain(step);
    }
    expect(annexes).toContain("references/accessibility-check.md");
    const check = flat(annex("write-ux-spec", "references/accessibility-check.md"));
    for (const item of [
      "4.5:1",
      "18.66px — 14pt — bold",
      "Keyboard",
      "Focus order",
      "Target size",
      "reduce motion",
      "Text spacing",
      "Content on hover or focus",
      "Orientation",
      "Bypass blocks",
      "Each page has a title",
      "Redundant entry",
      "Accessible authentication",
    ]) {
      expect(check, item).toContain(item);
    }
    // The template's sample values are marked, and the checklist names them.
    const template = annex("write-ux-spec", WORKFLOWS["write-ux-spec"].template);
    expect(template).toMatch(/"#FFFFFF".*\(sample\)/);
    expect(annex("write-ux-spec", WORKFLOWS["write-ux-spec"].checklist)).toContain("`#FFFFFF`");
  });

  it("makes the other menu items reuse the skills' rules instead of their own copy", () => {
    const prompt = (agent: string, code: string) =>
      flat(agents.get(agent)?.agent?.menu.find((item) => item.code === code)?.prompt ?? "");
    expect(prompt("stella", "AC")).toContain(
      "`.agentplugged/skills/write-ux-spec/references/accessibility-check.md`",
    );
    // Updating the PRD after a change of mind is the skill `correct-course`, which sends
    // to the sections of `write-prd` instead of copying them.
    expect(agents.get("maya")?.agent?.menu.find((item) => item.code === "UP")?.skill).toBe(
      "correct-course",
    );
    expect(flat(annex("correct-course", "references/steps.md"))).toContain(
      "`write-prd` « Identifiers » and « Decisions »",
    );
    const validate = prompt("maya", "VP");
    for (const rule of [
      "`.agentplugged/skills/write-prd/references/prd-checklist.md`",
      "decision gate",
      "by any agent",
      "only when `.agentplugged/docs/ux.md` exists",
      "`changes_requested`",
      "`supersedes`",
      "Commit the PRD on the working branch",
    ]) {
      expect(validate, rule).toContain(rule);
    }
  });

  it("defines the four requirement prefixes in the PRD template, and none in the UX one", () => {
    const prd = parseDocumentFile(
      WORKFLOWS["write-prd"].document,
      annex("write-prd", WORKFLOWS["write-prd"].template),
    );
    const prefixes = new Set(prd.definitions.map((definition) => definition.id.split("-")[0]));
    expect([...prefixes].sort()).toEqual(["EF", "ENF", "MS", "PU"]);
    expect(prd.header?.links).toEqual(["brief"]);

    const uxText = annex("write-ux-spec", WORKFLOWS["write-ux-spec"].template);
    const ux = parseDocumentFile(WORKFLOWS["write-ux-spec"].document, uxText);
    expect(ux.definitions).toEqual([]);
    expect(ux.header?.links).toEqual(["prd", "PU-1", "EF-1"]);
    // The tokens are in the header, and the sections the checks read are there.
    expect(Object.keys(ux.tokens?.value as object)).toEqual([
      "color",
      "type",
      "space",
      "radius",
      "shadow",
    ]);
    expect(uxElementsOf(uxText).map((element) => element.id)).toEqual(["UX-1", "UX-2"]);
    for (const section of [
      "# Part 1 — Visual identity",
      "# Part 2 — Behaviour",
      "## Key flows",
      "## States",
      "## Accessibility check",
      "## Key screens",
      "## Screen sketches",
      "## Elements to build",
      "## Traceability",
    ]) {
      expect(uxText.split("\n"), section).toContain(section);
    }
  });
});

describe("the visual part of the UX specification", () => {
  const read = (path: string) => annex("write-ux-spec", path);

  it("ships a page frame that passes the engine's own rules, with the policy that loads nothing", () => {
    const page = read("assets/mockup-page.html");
    expect(mockupFaults(page)).toEqual([]);
    expect(page).not.toMatch(/<script|https?:\/\/|url\(/i);
  });

  it("ships a template whose samples pass, and whose sample page is reported once the pages are read", () => {
    const text = read("assets/ux-template.md");
    const document = parseDocumentFile(".agentplugged/docs/ux.md", text);
    expect(uxDocumentChecks({ documents: [document], textOf: () => text }).problems).toEqual([]);
    // Left as it is in a product, its sample page is missing: the template cannot be validated as is.
    const withPages = uxDocumentChecks({
      documents: [document],
      textOf: () => text,
      mockups: new Map(),
    });
    expect(withPages.problems.map((problem) => problem.details.reason)).toEqual([
      "ux_mockup_missing",
    ]);
  });

  it("sends from the skill to its references at the steps that need them, and keeps the skill short", () => {
    const skill = flat(skillOf("write-ux-spec").text);
    for (const part of [
      "`references/tokens-and-sketches.md`",
      "`references/mockups.md`",
      "`ui_system`",
      "`UX-n`",
      "two to four key screens",
      "`.agentplugged/docs/ux-mockups/`",
    ]) {
      expect(skill, part).toContain(part);
    }
    expect(read("references/mockups.md").length).toBeLessThanOrEqual(4_500);
    expect(read("references/tokens-and-sketches.md").length).toBeLessThanOrEqual(4_500);
  });

  it("has the stories carry the elements and the sketches", () => {
    const split = flat(skills.get("split-into-stories")?.text ?? "");
    expect(split).toContain("`UX-n`");
    expect(split).toContain(
      "takes that screen's sketch in `ux.md` as a criterion, by region number",
    );
    expect(split).toContain("`ux_element_uncovered`");
  });
});

describe("the rules every workflow shares", () => {
  it("applies a resolution as the reference says, once, for every workflow that asks a decision", () => {
    const shared = sharedRules();
    for (const part of [
      "Applying a resolution:",
      "`option_chosen` — apply `resolution.option`",
      "`approved` or `approved_with_reservations` — apply your recommendation, with the note",
      "`rejected` or `changes_requested` — read the note, ask the creator what they want",
      "open a new decision with `supersedes` set to the refused one's id",
    ]) {
      expect(shared, part).toContain(part);
    }
    let asking = 0;
    for (const skill of skills.values()) {
      if (skill.text.includes("**Apply:**")) {
        asking++;
        expect(skill.text, skill.name).toContain('apply it as "Applying a resolution" says');
      }
    }
    expect(asking).toBeGreaterThanOrEqual(8);
  });
});
