import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { knownOwners } from "../docs/docs-command.js";
import {
  agentCommand,
  BLOCK_BEGIN,
  type CommandContext,
  GENERATED_HEADER,
  importsOutsideBlock,
  initCommand,
  pointerBlock,
  resolveProfile,
  type SyncResult,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { fixtureAgent, MemoryFiles, shippedMethod } from "../testing/memory-files.js";

/** Iris and Noah, as the method ships them in these tests. */
const METHOD = shippedMethod(fixtureAgent("noah", { name: "Noah" }));

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

function context(files: MemoryFiles): CommandContext {
  return { files, tools: NO_TOOL, method: METHOD, actor: "human", engineVersion: "1.0.0" };
}

const CONFIG = ".agentplugged/method.yaml";

async function installed(
  initial: Record<string, string> = {},
  tools?: readonly string[],
): Promise<MemoryFiles> {
  const files = new MemoryFiles(initial);
  const result = await initCommand.run(context(files), { profile: resolveProfile("new-product") });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  if (tools !== undefined) {
    const text = (files.files.get(CONFIG) ?? "").replace(/tools:\n(?: {2}- .*\n)+/, "");
    files.seed(CONFIG, `${text}tools: [${tools.join(", ")}]\n`);
  }
  return files;
}

async function sync(files: MemoryFiles): Promise<SyncResult> {
  const result = await syncCommand.run(context(files), {});
  if (!result.ok) throw new Error(`sync failed: ${result.error.code}`);
  return result.value;
}

const SECTION = "## Main session: Noah";

/** Noah's sub-agent file in each tool: never generated. */
const NOAH_SUB_AGENTS = [
  ".claude/agents/noah.md",
  ".codex/agents/noah.toml",
  ".agents/agents/noah.md",
  ".gemini/agents/noah.md",
  ".cursor/agents/noah.md",
];

/** What each tool reads that brings it the constitution, and so Noah's section. */
const READS: Readonly<Record<string, readonly [string, string][]>> = {
  "claude-code": [["CLAUDE.md", "@AGENTS.md"]],
  codex: [],
  antigravity: [["GEMINI.md", "@AGENTS.md"]],
  cursor: [[".cursor/rules/agentplugged.mdc", "`AGENTS.md`"]],
};

/** A line of the section that is about one tool only. */
const HANDOVER: Readonly<Record<string, string>> = {
  "claude-code": "- Claude Code: your full definition is the skill `noah`",
  codex: "- Codex: your full definition is",
  antigravity: "- Antigravity CLI and Gemini CLI:",
  cursor: "- Cursor: your full definition is",
};

describe("Noah in the generated files", () => {
  it("is in the constitution init writes, for the main session only", async () => {
    const files = await installed();
    const short = files.files.get("AGENTS.md") ?? "";
    expect(short).toContain(SECTION);
    expect(short).toContain("never answer for the creator");
    const constitution = files.reference();
    expect(constitution).toContain(SECTION);
    expect(constitution).toContain("ignore this section and follow\nyour own definition");
    // Before the reporting rules, which say who the main session reports as.
    expect(constitution.indexOf(SECTION)).toBeLessThan(constitution.indexOf("## Reporting"));
    expect(constitution).toContain("in the main session, Noah reports as `noah`");
    expect(constitution).toContain("When your work is done, hand back to Noah");
  });

  it.each(["claude-code", "codex", "antigravity", "cursor"])(
    "reaches %s, never as a sub-agent, without writing a deliverable nor code",
    async (tool) => {
      const files = await installed({}, [tool]);
      await sync(files);
      const constitution = files.reference();
      const shortSection = files.files.get("AGENTS.md") ?? "";
      // The short section sends to the reference for the hand-over of the tool.
      expect(shortSection, tool).toContain("reference file `noah`");
      for (const line of Object.values(HANDOVER)) expect(shortSection, tool).not.toContain(line);
      const section = constitution.slice(
        constitution.indexOf(SECTION),
        constitution.indexOf("## Reporting"),
      );
      expect(section).toContain(SECTION);
      // The definition lives in the method; what depends on the tool, here, for this tool only.
      for (const [other, line] of Object.entries(HANDOVER)) {
        if (other === tool) expect(section, other).toContain(line);
        else expect(section, other).not.toContain(line);
      }
      // His contract: no deliverable, no code, no checkpoint, never in the creator's place.
      const flat = section.replace(/\s+/g, " ");
      for (const rule of [
        "Never write in `.agentplugged/docs/`, `epics/` or `stories/`",
        "never write code",
        "never open a checkpoint",
        "never answer for the creator",
        "`ROLE_FORBIDDEN`",
        "`agent.delegate`",
        "`chat.answer`",
        "one at a time",
        "eight at most",
        "belong to Izzy",
        "`guard.creator_action`",
      ]) {
        expect(flat, rule).toContain(rule);
      }
      // The tool reads the constitution.
      for (const [path, needle] of READS[tool] ?? []) {
        expect(files.files.get(path), path).toContain(needle);
      }
      // Never a sub-agent: his place is the main session. Iris is one.
      for (const path of NOAH_SUB_AGENTS) expect(files.files.has(path), path).toBe(false);
      const iris = {
        "claude-code": ".claude/agents/iris.md",
        codex: ".codex/agents/iris.toml",
        antigravity: ".agents/agents/iris.md",
        cursor: ".cursor/agents/iris.md",
      }[tool] as string;
      expect(files.files.has(iris)).toBe(true);
      // His skill brings him back by name (`/noah`), and he does not show his menu unasked.
      const skill =
        files.files.get(".claude/skills/noah/SKILL.md") ??
        files.files.get(".agents/skills/noah/SKILL.md") ??
        "";
      expect(skill).toContain("Show the menu only when the creator asks");
    },
  );

  it("leaves the section out once Noah is disabled, and the main session reports as main", async () => {
    const files = await installed({}, ["claude-code"]);
    await sync(files);
    const disabled = await agentCommand.run(context(files), { action: "disable", id: "noah" });
    expect(disabled.ok).toBe(true);
    await sync(files);
    const constitution = files.files.get("AGENTS.md") ?? "";
    expect(constitution).not.toContain(SECTION);
    expect(constitution).not.toContain("hand back to Noah");
    expect(constitution).toContain("uses the reserved id `main`");
    expect(files.files.has(".claude/skills/noah/SKILL.md")).toBe(false);
    // Init does not write it back either.
    const again = await initCommand.run(context(files), {});
    expect(again.ok).toBe(true);
    expect(files.files.get("AGENTS.md")).not.toContain(SECTION);
  });
});

describe("CLAUDE.md: nothing lost, nothing doubled", () => {
  it("imports the creator's AGENTS.md too, which Claude Code read before CLAUDE.md existed", async () => {
    const files = await installed({ "AGENTS.md": "# Our rules\n\nUse tabs.\n" }, ["claude-code"]);
    await sync(files);
    expect(files.files.get("CLAUDE.md")).toBe(
      `${GENERATED_HEADER}\n@.agentplugged/AGENTS.md\n@AGENTS.md\n`,
    );
    expect(files.files.get(".agentplugged/AGENTS.md")).toContain(SECTION);
  });

  it("imports the generated constitution once", async () => {
    const files = await installed({}, ["claude-code"]);
    await sync(files);
    expect(files.files.get("CLAUDE.md")).toBe(`${GENERATED_HEADER}\n@AGENTS.md\n`);
  });

  it("adds no block to a creator's CLAUDE.md that already imports the constitution", async () => {
    const mine = "# Mine\n\n@AGENTS.md\n";
    const files = await installed({ "CLAUDE.md": mine }, ["claude-code"]);
    await sync(files);
    expect(files.files.get("CLAUDE.md")).toBe(mine);
  });

  it("removes the block an earlier version added next to the creator's own import", async () => {
    const files = await installed({ "CLAUDE.md": "# Mine\n" }, ["claude-code"]);
    await sync(files);
    const withBlock = files.files.get("CLAUDE.md") ?? "";
    expect(withBlock).toContain(BLOCK_BEGIN);
    // The creator then imports it on their own: the block goes, their import stays.
    files.seed("CLAUDE.md", withBlock.replace("# Mine\n", "# Mine\n\n@./AGENTS.md\n"));
    await sync(files);
    const after = files.files.get("CLAUDE.md") ?? "";
    expect(after).not.toContain(BLOCK_BEGIN);
    expect(after.match(/@(\.\/)?AGENTS\.md/g)).toEqual(["@./AGENTS.md"]);
  });

  it("does the same in GEMINI.md", async () => {
    const mine = "@AGENTS.md\n";
    const files = await installed({ "GEMINI.md": mine }, ["antigravity"]);
    await sync(files);
    expect(files.files.get("GEMINI.md")).toBe(mine);
  });

  it("reads an import within a sentence or a list, never in code nor in a comment", () => {
    for (const text of ["See @AGENTS.md for the rules.\n", "- @AGENTS.md\n", "@./AGENTS.md\r\n"]) {
      expect(importsOutsideBlock(text, "AGENTS.md"), text).toBe(true);
    }
    for (const text of [
      "```\n@AGENTS.md\n```\n",
      "~~~md\n@AGENTS.md\n~~~\n",
      "Write `@AGENTS.md` to import it.\n",
      "<!-- @AGENTS.md -->\n",
      "mail@AGENTS.md\n",
      "@AGENTS.md.bak\n",
      `${BLOCK_BEGIN}\n@AGENTS.md\n`,
    ]) {
      expect(importsOutsideBlock(text, "AGENTS.md"), text).toBe(false);
    }
    // Our own block is never the creator's import.
    expect(
      importsOutsideBlock(`# Mine\n\n${pointerBlock("AGENTS.md", "import")}\n`, "AGENTS.md"),
    ).toBe(false);
  });

  it("keeps the block when the creator's import sits in a code block", async () => {
    const files = await installed({ "CLAUDE.md": "# Mine\n\n```\n@AGENTS.md\n```\n" }, [
      "claude-code",
    ]);
    await sync(files);
    expect(files.files.get("CLAUDE.md")).toContain(BLOCK_BEGIN);
  });

  it("adds no block at init either when the creator's CLAUDE.md imports the constitution", async () => {
    const mine = "# Mine\n\nSee @AGENTS.md.\n";
    const files = await installed({ "CLAUDE.md": mine }, ["claude-code"]);
    expect(files.files.get("CLAUDE.md")).toBe(mine);
  });
});

describe("the shipped Noah and the creator's folders", () => {
  it("lets no document name Noah as its owner", async () => {
    const files = await installed();
    expect(files.files.has(".agentplugged/agents/noah/SKILL.md")).toBe(true);
    const owners = await knownOwners(files);
    expect(owners.has("iris")).toBe(true);
    expect(owners.has("noah")).toBe(false);
  });

  it("refuses to install over a skill of the creator's named after a shipped agent", async () => {
    const files = new MemoryFiles({
      ".agentplugged/skills/noah/SKILL.md": "---\nname: noah\ndescription: Mine.\n---\nBody\n",
    });
    const result = await initCommand.run(context(files), {
      profile: resolveProfile("new-product"),
    });
    expect(result.ok ? undefined : result.error).toMatchObject({
      code: ErrorCode.AGENT_ID_CONFLICT,
      details: { id: "noah", path: ".agentplugged/skills/noah/" },
    });
    expect(files.files.has(".agentplugged/agents/noah/SKILL.md")).toBe(false);
  });
});
