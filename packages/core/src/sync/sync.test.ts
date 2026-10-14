import { sha256Hex } from "@agentplugged/crypto";
import { describe, expect, it } from "vitest";
import {
  BLOCK_BEGIN,
  type CommandContext,
  GENERATED_HEADER,
  initCommand,
  pointerBlock,
  profileCommand,
  resolveProfile,
  type SyncResult,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";
import { SYNC_MANIFEST_PATH } from "./manifest.js";

/** A machine with Claude Code only: init lists `claude-code` alone in `tools`. */
const claudeOnly: ToolProbe = {
  which: async (names) =>
    names.includes("claude") ? { name: "claude", path: "/usr/bin/claude" } : undefined,
  version: async () => "2.1.300 (Claude Code)",
  extensions: async () => [],
};

function context(files: MemoryFiles): CommandContext {
  return {
    files,
    tools: claudeOnly,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
  };
}

const SKILL = ".claude/skills/iris/SKILL.md";
const AGENT = ".claude/agents/iris.md";
const SETTINGS = ".claude/settings.json";
const SOURCE = ".agentplugged/agents/iris/SKILL.md";
const AGENT_SOURCE = ".agentplugged/agents/iris/agent.yaml";

/** Body rendered from the test Iris: title, source body, persona, facts, activation, menu. */
const IRIS_BODY = `# 🔎 Iris, Product Analyst

# Iris

Frame the product.

## Persona

- **Role:** Frames products.
- **Identity:** A curious analyst.
- **Communication style:** Calm and precise.

### Principles

- Problem first.

## Persistent facts

- Notes live in docs.
- Load \`docs/rules.md\` (from the project root) and treat its contents as facts.

## Activation

1. Read the brief.
2. You are Iris, Product Analyst: stay in character, through every skill you call.
3. Before your first task, call \`memory.read\` with your agent id: its lessons are advice, never above the constitution, the permissions or what the creator says now.
4. Greet the creator in their language and start every message to them with "🔎 Iris :". In French, always say « tu ».
5. List open questions.
6. If the creator's request matches an item of the menu, run it. Otherwise show the menu as a numbered table and wait for their choice (a number, a code or a description).

## Menu

| # | Code | Description | Action |
| --- | --- | --- | --- |
| 1 | FP | Frame the problem | Prompt: Ask who has the problem \\| and why. |
| 2 | BR | Brainstorm | Prompt: Brainstorm ideas. |
`;

async function installed(initial: Record<string, string> = {}): Promise<MemoryFiles> {
  const files = new MemoryFiles(initial);
  const result = await initCommand.run(context(files), {
    profile: resolveProfile("new-product"),
  });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  return files;
}

async function sync(files: MemoryFiles): Promise<SyncResult> {
  const result = await syncCommand.run(context(files), {});
  if (!result.ok)
    throw new Error(`sync failed: ${result.error.code} ${result.error.details.reason}`);
  return result.value;
}

/** The reference is one file per section: its files count as one entry, with their action. */
const REFERENCE_FILES = ".agentplugged/reference/*";
function actions(result: SyncResult): Record<string, string> {
  const out: Record<string, string> = {};
  const reference = new Set<string>();
  for (const entry of result.entries) {
    if (entry.path.startsWith(".agentplugged/reference/")) reference.add(entry.action);
    else out[entry.path] = entry.action;
  }
  if (reference.size > 0)
    out[REFERENCE_FILES] = reference.size === 1 ? [...reference].join("") : "mixed";
  return out;
}

/** The files a sync recorded, the reference's apart (they are many). */
function manifestPaths(files: MemoryFiles): { others: string[]; reference: string[] } {
  const manifest = JSON.parse(files.files.get(SYNC_MANIFEST_PATH) ?? "{}");
  const all = Object.keys(manifest.files);
  return {
    others: all.filter((path) => !path.startsWith(".agentplugged/reference/")),
    reference: all.filter((path) => path.startsWith(".agentplugged/reference/")),
  };
}

/** The script of the chat's hook, generated for Claude Code. */
const PROMPT_HOOK = ".claude/hooks/agentplugged-prompt.mjs";
const DECISION_HOOK = ".claude/hooks/agentplugged-decision.mjs";

const settingsOf = (files: MemoryFiles) => JSON.parse(files.files.get(SETTINGS) ?? "{}");

describe("init copies the shipped method", () => {
  it("copies Iris, refreshes it when it differs, and never touches the creator's agents", async () => {
    const files = await installed({ ".agentplugged/agents/mine/SKILL.md": "mine" });
    expect(files.files.get(SOURCE)).toBe(SHIPPED_IRIS);
    expect(files.files.get(AGENT_SOURCE)).toBe(SHIPPED_IRIS_AGENT);

    files.seed(SOURCE, "changed");
    const again = await initCommand.run(context(files), {});
    expect(again.ok && again.value.entries.find((e) => e.path.includes("iris"))?.action).toBe(
      "updated",
    );
    expect(files.files.get(SOURCE)).toBe(SHIPPED_IRIS);
    expect(files.files.get(".agentplugged/agents/mine/SKILL.md")).toBe("mine");

    files.seed(SOURCE, SHIPPED_IRIS.replace(/\n/g, "\r\n"));
    files.writes.length = 0;
    const third = await initCommand.run(context(files), {});
    expect(third.ok && third.value.entries.find((e) => e.path.includes("iris"))?.action).toBe(
      "unchanged",
    );
    expect(files.writes).toEqual([]);
  });

  it("copies a shipped agent's annexes, Markdown as text and others as bytes", async () => {
    const method = shippedMethod({ "agents/iris/references/x.md": "# X\r\n" });
    const bytes = new Uint8Array([0, 255, 13, 10]);
    method.seedBytes("agents/iris/assets/x.bin", bytes);
    const files = new MemoryFiles();
    const first = await initCommand.run({ ...context(files), method }, {});
    expect(first.ok).toBe(true);
    expect(files.files.get(".agentplugged/agents/iris/references/x.md")).toBe("# X\n");
    expect(files.binaries.get(".agentplugged/agents/iris/assets/x.bin")).toEqual(bytes);

    files.seedBytes(".agentplugged/agents/iris/assets/x.bin", new Uint8Array([1]));
    files.writes.length = 0;
    const again = await initCommand.run({ ...context(files), method }, {});
    expect(again.ok && again.value.entries.find((e) => e.path.includes("iris"))?.action).toBe(
      "updated",
    );
    expect(files.writes).toEqual([".agentplugged/agents/iris/assets/x.bin"]);
    expect(files.binaries.get(".agentplugged/agents/iris/assets/x.bin")).toEqual(bytes);
  });

  it("refuses an invalid shipped agent before writing anything", async () => {
    const files = new MemoryFiles();
    const method = shippedMethod({ "agents/iris/SKILL.md": "no frontmatter" });
    const result = await initCommand.run({ ...context(files), method }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AGENT_DEFINITION_INVALID");
    expect(files.writes).toEqual([]);
  });
});

describe("sync to Claude Code", () => {
  it("generates the skill, the sub-agent, CLAUDE.md and the settings on the first run", async () => {
    const files = await installed();
    const result = await sync(files);

    expect(actions(result)).toEqual({
      [SKILL]: "created",
      [AGENT]: "created",
      "CLAUDE.md": "created",
      "AGENTS.md": "unchanged",
      [REFERENCE_FILES]: "unchanged",
      [SETTINGS]: "created",
      ".mcp.json": "created",
      [PROMPT_HOOK]: "created",
      [DECISION_HOOK]: "created",
    });
    expect(result.warnings).toEqual([]);

    const frontmatter = SHIPPED_IRIS.slice(0, SHIPPED_IRIS.indexOf("# Iris"));
    expect(files.files.get(SKILL)).toBe(`${frontmatter}${GENERATED_HEADER}\n${IRIS_BODY}`);
    expect(files.files.get(AGENT)).toBe(
      `---\nname: iris\ndescription: Product analyst who frames a new product.\nmodel: opus\neffort: high\ndisallowedTools: mcp__agentplugged__review, mcp__agentplugged__measure\n---\n${GENERATED_HEADER}\n${IRIS_BODY}`,
    );
    expect(files.files.has(".claude/skills/iris/agent.yaml")).toBe(false);
    expect(files.files.get("CLAUDE.md")).toBe(`${GENERATED_HEADER}\n@AGENTS.md\n`);

    const settings = settingsOf(files);
    expect(settings.$schema).toBe("https://json.schemastore.org/claude-code-settings.json");
    expect(settings.permissions.disableBypassPermissionsMode).toBe("disable");
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        // The files that carry the rules.
        "Edit(/.agentplugged/method.yaml)",
        "Edit(/.agentplugged/AGENTS.md)",
        "Edit(/.agentplugged/reference/**)",
        "Edit(/.claude/**)",
        "Edit(/AGENTS.md)",
        "Edit(/CLAUDE.md)",
        "Edit(**/.env)",
        "Edit(**/.env.local)",
        "Edit(~/.ssh/**)",
        "Read(~/.ssh/**)",
        "Read(**/.env)",
        "Read(**/.env.local)",
        "Read(**/.env.*.local)",
        "Read(**/.env.production*)",
        "Bash(git push *agentplugged/journal*)",
        "Bash(git checkout agentplugged/journal*)",
        "Bash(git switch agentplugged/journal*)",
        "Bash(gh pr merge*)",
        "Bash(glab mr merge*)",
      ]),
    );
    const deny: string[] = settings.permissions.deny;
    expect(deny.some((rule) => /docs|epics|stories/.test(rule))).toBe(false);
    // A lone backslash before the closing parenthesis would escape it: the rules of the root of a
    // Windows disk are written with that one backslash doubled, for both shell tools.
    const written: string[] = [
      ...deny,
      ...(settings.permissions.allow ?? []),
      ...(settings.permissions.ask ?? []),
    ];
    expect(written.filter((rule) => /(?<!\\)\\\)$/.test(rule))).toEqual([]);
    expect(deny).toEqual(
      expect.arrayContaining([
        "Bash(rd /s* C:\\\\)",
        "Bash(Remove-Item *-r* C:\\\\)",
        "Bash(rd /s* C:/)",
        "PowerShell(rd /s* C:\\\\)",
        "PowerShell(Remove-Item *-r* C:\\\\)",
        "PowerShell(rd /s* C:/)",
        "PowerShell(gh pr merge*)",
        "PowerShell(git push *agentplugged/journal*)",
      ]),
    );
    // Every command rule has its twin for the other shell tool.
    for (const rule of written.filter((entry) => entry.startsWith("Bash("))) {
      expect(written).toContain(`PowerShell${rule.slice("Bash".length)}`);
    }
    expect(files.files.has(".claude/settings.local.json")).toBe(false);

    const manifest = JSON.parse(files.files.get(SYNC_MANIFEST_PATH) ?? "{}");
    const recorded = manifestPaths(files);
    expect(recorded.others.sort()).toEqual(
      [AGENT, SKILL, "AGENTS.md", "CLAUDE.md", PROMPT_HOOK, DECISION_HOOK].sort(),
    );
    // One file per section of the reference.
    expect(recorded.reference).toContain(".agentplugged/reference/reporting.md");
    expect(recorded.reference).toContain(".agentplugged/reference/tool-story.md");
    expect(manifest.permissions).toEqual(deny);
  });

  it("writes nothing when run again", async () => {
    const files = await installed();
    await sync(files);
    const before = files.snapshot();
    files.writes.length = 0;
    const result = await sync(files);
    expect(result.entries.every((entry) => entry.action === "unchanged")).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(files.writes).toEqual([]);
    expect(files.snapshot()).toEqual(before);
  });

  it("updates only Iris's two files when her description changes", async () => {
    const files = await installed();
    await sync(files);
    files.seed(SOURCE, SHIPPED_IRIS.replace("frames a new product", "frames products"));
    files.writes.length = 0;
    const result = await sync(files);
    expect(actions(result)).toEqual({
      [SKILL]: "updated",
      [AGENT]: "updated",
      "CLAUDE.md": "unchanged",
      "AGENTS.md": "unchanged",
      [REFERENCE_FILES]: "unchanged",
      [SETTINGS]: "unchanged",
      ".mcp.json": "unchanged",
      [PROMPT_HOOK]: "unchanged",
      [DECISION_HOOK]: "unchanged",
    });
    expect(result.warnings).toEqual([]);
    expect(files.writes.sort()).toEqual([AGENT, SKILL, SYNC_MANIFEST_PATH].sort());
    expect(files.files.get(AGENT)).toContain("description: Product analyst who frames products.");
  });

  it("regenerates a file modified by hand and reports it", async () => {
    const files = await installed();
    await sync(files);
    const generated = files.files.get(AGENT) ?? "";
    files.seed(AGENT, `${generated}\nMy own line.\n`);
    const result = await sync(files);
    expect(actions(result)[AGENT]).toBe("updated");
    expect(result.warnings).toEqual([{ kind: "overwritten", path: AGENT }]);
    expect(files.files.get(AGENT)).toBe(generated);
  });

  it("does not report a CRLF checkout of a generated file", async () => {
    const files = await installed();
    await sync(files);
    files.seed(AGENT, (files.files.get(AGENT) ?? "").replace(/\n/g, "\r\n"));
    files.writes.length = 0;
    const result = await sync(files);
    expect(actions(result)[AGENT]).toBe("unchanged");
    expect(files.writes).toEqual([]);
  });

  it("deletes and announces the files of an agent that became inactive", async () => {
    const files = await installed();
    await sync(files);
    const changed = await profileCommand.run(context(files), {
      profile: resolveProfile("maintenance"),
    });
    expect(changed.ok).toBe(true);
    const result = await sync(files);
    expect(actions(result)).toEqual({
      "CLAUDE.md": "unchanged",
      "AGENTS.md": "unchanged",
      [REFERENCE_FILES]: "unchanged",
      [SKILL]: "deleted",
      [AGENT]: "deleted",
      [SETTINGS]: "unchanged",
      ".mcp.json": "unchanged",
      [PROMPT_HOOK]: "unchanged",
      [DECISION_HOOK]: "unchanged",
    });
    expect(files.files.has(SKILL)).toBe(false);
    expect(files.files.has(AGENT)).toBe(false);
    expect(files.dirs.has(".claude/skills/iris")).toBe(false);
    expect(files.dirs.has(".claude/skills")).toBe(true);
    expect(manifestPaths(files).others).toEqual([
      DECISION_HOOK,
      PROMPT_HOOK,
      "AGENTS.md",
      "CLAUDE.md",
    ]);
  });

  it("leaves the creator's skill folder alone and warns", async () => {
    const files = await installed({ [SKILL]: "---\nname: iris\n---\nmine\n" });
    const result = await sync(files);
    expect(files.files.get(SKILL)).toBe("---\nname: iris\n---\nmine\n");
    expect(result.warnings).toEqual([{ kind: "conflict", path: ".claude/skills/iris/" }]);
    expect(actions(result)[SKILL]).toBeUndefined();
    expect(actions(result)[AGENT]).toBe("created");
    const manifest = JSON.parse(files.files.get(SYNC_MANIFEST_PATH) ?? "{}");
    expect(manifest.files[SKILL]).toBeUndefined();
  });

  it("leaves a creator's sub-agent file alone and warns", async () => {
    const files = await installed({ [AGENT]: "my agent\n" });
    const result = await sync(files);
    expect(files.files.get(AGENT)).toBe("my agent\n");
    expect(result.warnings).toEqual([{ kind: "conflict", path: AGENT }]);
  });

  it("keeps a generated file the creator took (header removed) once it is no longer produced", async () => {
    const files = await installed();
    await sync(files);
    files.seed(AGENT, "now mine\n");
    await profileCommand.run(context(files), { profile: resolveProfile("maintenance") });
    const result = await sync(files);
    expect(files.files.get(AGENT)).toBe("now mine\n");
    expect(result.warnings).toEqual([{ kind: "kept", path: AGENT }]);
    expect(actions(result)[SKILL]).toBe("deleted");
  });

  it("merges into existing settings and keeps everything else", async () => {
    const mine = {
      env: { FOO: "bar" },
      permissions: { allow: ["Bash(npm test)"], deny: ["Read(/secret/**)"], defaultMode: "plan" },
      hooks: {},
    };
    const files = await installed({ [SETTINGS]: JSON.stringify(mine) });
    const result = await sync(files);
    expect(actions(result)[SETTINGS]).toBe("updated");
    const settings = settingsOf(files);
    expect(settings.$schema).toBeUndefined();
    expect(settings.env).toEqual({ FOO: "bar" });
    // The creator's (empty) hooks receive those of untrusted content.
    expect(Object.keys(settings.hooks)).toEqual(["PreToolUse", "PostToolUse", "UserPromptSubmit"]);
    expect(settings.permissions.allow[0]).toBe("Bash(npm test)");
    expect(settings.permissions.allow).toContain("Edit(/**)");
    expect(settings.permissions.defaultMode).toBe("plan");
    expect(settings.permissions.deny[0]).toBe("Read(/secret/**)");
    expect(settings.permissions.deny).toContain("Edit(/.claude/**)");
    expect(settings.permissions.disableBypassPermissionsMode).toBe("disable");
  });

  it("removes only its own rules when it no longer produces them", async () => {
    const files = await installed();
    await sync(files);
    // The creator writes their own CLAUDE.md: it is no longer generated.
    files.seed("CLAUDE.md", "my instructions\n");
    const settings = settingsOf(files);
    settings.permissions.deny.push("Read(/mine/**)");
    files.seed(SETTINGS, JSON.stringify(settings, null, 2));
    const result = await sync(files);
    expect(actions(result)["CLAUDE.md"]).toBe("updated");
    expect(files.files.get("CLAUDE.md")).toBe(
      `my instructions\n\n${pointerBlock("AGENTS.md", "import")}\n`,
    );
    const deny: string[] = settingsOf(files).permissions.deny;
    expect(deny).not.toContain("Edit(/CLAUDE.md)");
    expect(deny).toContain("Edit(/AGENTS.md)");
    expect(deny).toContain("Read(/mine/**)");
  });

  it("refuses unreadable settings and writes nothing", async () => {
    for (const text of ["{ nope", "[]", '{"permissions": {"deny": "x"}}']) {
      const files = await installed({ [SETTINGS]: text });
      files.writes.length = 0;
      const result = await syncCommand.run(context(files), {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("SETTINGS_INVALID");
        expect(result.error.details.path).toBe(SETTINGS);
      }
      expect(files.writes).toEqual([]);
    }
  });

  it.each([
    [
      "a name that differs from the folder",
      SHIPPED_IRIS.replace("name: iris", "name: iriss"),
      "name",
    ],
    [
      "an unknown domain",
      SHIPPED_IRIS.replace("domain: product", "domain: legal"),
      "metadata.domain",
    ],
    [
      "a key outside the standard",
      SHIPPED_IRIS.replace("name: iris", "name: iris\nmodel: x"),
      "model",
    ],
    ["no frontmatter", "# Iris\n", "(root)"],
    ["unreadable YAML", "---\nname: [iris\n---\n", "(root)"],
  ])("stops before any write on %s", async (_name, text, field) => {
    const files = await installed();
    files.seed(SOURCE, text);
    files.writes.length = 0;
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AGENT_DEFINITION_INVALID");
      expect(result.error.message_key).toBe("error.agent_definition_invalid");
      expect(result.error.details).toMatchObject({ path: SOURCE, field });
    }
    expect(files.writes).toEqual([]);
  });

  it("reports a folder without SKILL.md and a skill named like an agent", async () => {
    const missing = await installed({ ".agentplugged/agents/ghost/notes.md": "x" });
    const first = await syncCommand.run(context(missing), {});
    expect(!first.ok && first.error.details.path).toBe(".agentplugged/agents/ghost/SKILL.md");

    // Added after init (init refuses it): sync refuses it too.
    const twice = await installed();
    twice.seed(".agentplugged/skills/iris/SKILL.md", "---\nname: iris\ndescription: d\n---\n");
    const second = await syncCommand.run(context(twice), {});
    expect(!second.ok && second.error.details).toMatchObject({
      path: ".agentplugged/skills/iris/SKILL.md",
      field: "name",
    });
  });

  it("fails with METHOD_NOT_INSTALLED without .agentplugged/", async () => {
    const files = new MemoryFiles();
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("METHOD_NOT_INSTALLED");
    expect(files.writes).toEqual([]);
  });

  it("adds the import block to the creator's CLAUDE.md, once", async () => {
    const files = await installed({ "CLAUDE.md": "mine\n" });
    expect(files.files.get("CLAUDE.md")).toBe(`mine\n\n${pointerBlock("AGENTS.md", "import")}\n`);
    const result = await sync(files);
    expect(actions(result)["CLAUDE.md"]).toBe("unchanged");
    expect(files.files.get("CLAUDE.md")?.split(BLOCK_BEGIN)).toHaveLength(2);
    expect(settingsOf(files).permissions.deny).not.toContain("Edit(/CLAUDE.md)");
  });

  it("imports .agentplugged/AGENTS.md when the root AGENTS.md is the creator's", async () => {
    const files = await installed({ "AGENTS.md": "my rules\n" });
    await sync(files);
    // And the creator's AGENTS.md, which Claude Code read before CLAUDE.md existed.
    expect(files.files.get("CLAUDE.md")).toBe(
      `${GENERATED_HEADER}\n@.agentplugged/AGENTS.md\n@AGENTS.md\n`,
    );
    expect(settingsOf(files).permissions.deny).not.toContain("Edit(/AGENTS.md)");
  });

  it("copies annexes and generates the creator's skills", async () => {
    const files = await installed({
      ".agentplugged/agents/iris/references/guide.md": "# Guide\n",
      ".agentplugged/agents/iris/notes.txt": "not copied",
      ".agentplugged/skills/write-prd/SKILL.md":
        "---\nname: write-prd\ndescription: Writes a PRD.\n---\nBody\n",
    });
    const image = new Uint8Array([137, 80, 78, 71, 0, 255]);
    files.seedBytes(".agentplugged/agents/iris/assets/logo.png", image);
    const result = await sync(files);
    expect(actions(result)).toMatchObject({
      ".claude/skills/iris/references/guide.md": "created",
      ".claude/skills/iris/assets/logo.png": "created",
      ".claude/skills/write-prd/SKILL.md": "created",
    });
    expect(files.files.get(".claude/skills/iris/references/guide.md")).toBe(
      `${GENERATED_HEADER}\n# Guide\n`,
    );
    expect(files.binaries.get(".claude/skills/iris/assets/logo.png")).toEqual(image);
    expect(files.files.has(".claude/skills/iris/notes.txt")).toBe(false);
    expect(files.files.has(".claude/agents/write-prd.md")).toBe(false);

    // The asset disappears from the source: its copy is deleted, and its folder too.
    files.binaries.delete(".agentplugged/agents/iris/assets/logo.png");
    const again = await sync(files);
    expect(actions(again)[".claude/skills/iris/assets/logo.png"]).toBe("deleted");
    expect(files.dirs.has(".claude/skills/iris/assets")).toBe(false);
    expect(files.dirs.has(".claude/skills/iris")).toBe(true);
  });

  it("replaces the single REFERENCE.md of the older engine by one file per section", async () => {
    const files = await installed();
    await sync(files);
    // A project synchronized by the older engine: one generated REFERENCE.md, recorded in the manifest.
    const old = `${GENERATED_HEADER}\n# Method reference\n`;
    files.seed(".agentplugged/REFERENCE.md", old);
    const manifest = JSON.parse(files.files.get(SYNC_MANIFEST_PATH) ?? "{}");
    manifest.files[".agentplugged/REFERENCE.md"] = sha256Hex(old);
    files.seed(SYNC_MANIFEST_PATH, JSON.stringify(manifest));
    const result = await sync(files);
    expect(actions(result)[".agentplugged/REFERENCE.md"]).toBe("deleted");
    expect(files.files.has(".agentplugged/REFERENCE.md")).toBe(false);
    expect(files.files.has(".agentplugged/reference/reporting.md")).toBe(true);
    // A generated REFERENCE.md the creator changed by hand is kept too, and said.
    const edited = `${old}my note\n`;
    files.seed(".agentplugged/REFERENCE.md", edited);
    manifest.files[".agentplugged/REFERENCE.md"] = sha256Hex(old);
    files.seed(SYNC_MANIFEST_PATH, JSON.stringify(manifest));
    await sync(files);
    expect(files.files.get(".agentplugged/REFERENCE.md")).toBe(edited);
    // The creator's own REFERENCE.md (header removed) is kept, and said.
    const mine = "my own reference\n";
    files.seed(".agentplugged/REFERENCE.md", mine);
    manifest.files[".agentplugged/REFERENCE.md"] = sha256Hex(old);
    files.seed(SYNC_MANIFEST_PATH, JSON.stringify(manifest));
    const kept = await sync(files);
    expect(files.files.get(".agentplugged/REFERENCE.md")).toBe(mine);
    expect(kept.warnings).toContainEqual({ kind: "kept", path: ".agentplugged/REFERENCE.md" });
  });

  it("recognises generated files by their header when the manifest is lost", async () => {
    const files = await installed();
    await sync(files);
    files.files.delete(SYNC_MANIFEST_PATH);
    files.writes.length = 0;
    const result = await sync(files);
    expect(result.entries.every((entry) => entry.action === "unchanged")).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(files.writes).toEqual([SYNC_MANIFEST_PATH]);
  });

  it("updates only Iris's two files when her agent.yaml changes", async () => {
    const files = await installed();
    await sync(files);
    files.seed(AGENT_SOURCE, SHIPPED_IRIS_AGENT.replace("Problem first.", "Users first."));
    const result = await sync(files);
    expect(actions(result)).toEqual({
      [SKILL]: "updated",
      [AGENT]: "updated",
      "CLAUDE.md": "unchanged",
      "AGENTS.md": "unchanged",
      [REFERENCE_FILES]: "unchanged",
      [SETTINGS]: "unchanged",
      ".mcp.json": "unchanged",
      [PROMPT_HOOK]: "unchanged",
      [DECISION_HOOK]: "unchanged",
    });
    expect(files.files.get(SKILL)).toContain("\n- Users first.\n");
    expect(files.files.get(AGENT)).toContain("\n- Users first.\n");
  });

  it.each([
    [
      "a menu item with both skill and prompt",
      SHIPPED_IRIS_AGENT.replace("    prompt: Brainstorm ideas.", "    prompt: Go.\n    skill: x"),
      "menu.1.prompt",
    ],
    [
      "a display name over 40 characters",
      SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${"x".repeat(41)}`),
      "name",
    ],
    [
      "a menu skill that names no loaded skill",
      SHIPPED_IRIS_AGENT.replace("    prompt: Brainstorm ideas.", "    skill: brainstorm"),
      "menu.1.skill",
    ],
    ["no title", SHIPPED_IRIS_AGENT.replace("title: Product Analyst\n", ""), "title"],
    ["an unknown key", `${SHIPPED_IRIS_AGENT}mood: happy\n`, "mood"],
    ["unreadable YAML", "name: [iris\n", "(root)"],
  ])("stops before any write on an agent.yaml with %s", async (_name, text, field) => {
    const files = await installed();
    files.seed(AGENT_SOURCE, text);
    files.writes.length = 0;
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AGENT_DEFINITION_INVALID");
      expect(result.error.details).toMatchObject({ path: AGENT_SOURCE, field });
    }
    expect(files.writes).toEqual([]);
  });

  it("requires agent.yaml next to an agent's SKILL.md", async () => {
    const files = await installed();
    files.files.delete(AGENT_SOURCE);
    const result = await syncCommand.run(context(files), {});
    expect(!result.ok && result.error.details).toMatchObject({
      path: AGENT_SOURCE,
      field: "(root)",
    });
  });

  it("renders an agent without icon, persona details or menu", async () => {
    const files = await installed();
    files.seed(AGENT_SOURCE, "name: Iris\ntitle: Product Analyst\n");
    await sync(files);
    const skill = files.files.get(SKILL) ?? "";
    expect(skill).toContain(`${GENERATED_HEADER}\n# Iris, Product Analyst\n`);
    expect(skill).toContain("## Persona\n\n- As described above.\n");
    expect(skill).not.toContain("**Voice:**");
    expect(skill).toContain("## Persistent facts\n\n- None.\n");
    expect(skill).toContain(
      '\n3. Greet the creator in their language and start every message to them with "Iris :". In French, always say « tu ».\n',
    );
    expect(skill).toContain("## Menu\n\nNo menu items: answer the creator's requests directly.\n");
  });

  it("renders the display name verbatim and a menu row calling a loaded skill", async () => {
    const files = await installed({
      ".agentplugged/skills/brainstorm/SKILL.md":
        "---\nname: brainstorm\ndescription: Brainstorms.\n---\nBody\n",
    });
    files.seed(
      AGENT_SOURCE,
      SHIPPED_IRIS_AGENT.replace("name: Iris", "name: Stella").replace(
        "    prompt: Brainstorm ideas.",
        "    skill: brainstorm",
      ),
    );
    await sync(files);
    const skill = files.files.get(SKILL) ?? "";
    expect(skill).toContain("\n# 🔎 Stella, Product Analyst\n");
    expect(skill).toContain("You are Stella, Product Analyst: stay in character");
    expect(skill).toContain("| 2 | BR | Brainstorm | Skill `brainstorm` |");
  });

  it("renders the voice in the persona, and a customisation replaces it whole", async () => {
    const files = await installed();
    files.seed(
      AGENT_SOURCE,
      `${SHIPPED_IRIS_AGENT}voice:\n  tone: Warm and curious\n  pace: Unhurried\n  register: Plain\n`,
    );
    await sync(files);
    const voiced = files.files.get(SKILL) ?? "";
    expect(voiced).toContain(
      "- **Communication style:** Calm and precise.\n- **Voice:** tone: Warm and curious; pace: Unhurried; register: Plain.\n\n### Principles",
    );
    expect(files.files.get(AGENT)).toContain("- **Voice:** tone: Warm and curious;");

    files.seed(
      ".agentplugged/overrides/agents/iris.yaml",
      "voice:\n  tone: Crisp\n  pace: Brisk\n  register: Formal.\n",
    );
    await sync(files);
    const replaced = files.files.get(SKILL) ?? "";
    expect(replaced).toContain("- **Voice:** tone: Crisp; pace: Brisk; register: Formal.\n");
    expect(replaced).not.toContain("Formal..");
    expect(replaced).not.toContain("Warm and curious");
  });

  it("refuses a voice with an unknown key", async () => {
    const files = await installed();
    files.seed(
      AGENT_SOURCE,
      `${SHIPPED_IRIS_AGENT}voice:\n  tone: t\n  pace: p\n  register: r\n  accent: a\n`,
    );
    files.writes.length = 0;
    const result = await syncCommand.run(context(files), {});
    expect(!result.ok && result.error.code).toBe("AGENT_DEFINITION_INVALID");
    expect(!result.ok && result.error.details).toMatchObject({
      path: AGENT_SOURCE,
      field: "voice.accent",
    });
    expect(files.writes).toEqual([]);
  });
});

describe("sync: developers", () => {
  /** A developer of the creator's own specialty: an agent of `code` with a specialty. */
  const EMBEDDED = {
    ".agentplugged/agents/kiln/SKILL.md": SHIPPED_IRIS.replace("name: iris", "name: kiln")
      .replace("domain: product", "domain: code")
      .replace("phase: framing", "phase: build")
      .replace("model_tier: reasoning", "model_tier: code\n  specialty: embedded"),
    ".agentplugged/agents/kiln/agent.yaml": SHIPPED_IRIS_AGENT.replace("name: Iris", "name: Kiln"),
  };

  it("runs each developer's sub-agent in a worktree of its own, with its tier's model", async () => {
    const files = await installed(EMBEDDED);
    await sync(files);
    const developer = files.files.get(".claude/agents/kiln.md") ?? "";
    expect(developer).toMatch(/^---\nname: kiln\n/);
    expect(developer).toContain("\nmodel: sonnet\n");
    expect(developer).toContain("\nisolation: worktree\n");
    // Any other agent shares the session's working copy.
    const iris = files.files.get(AGENT) ?? "";
    expect(iris).toContain("\nmodel: opus\n");
    expect(iris).not.toContain("isolation");
  });
});

describe("sync: removals and ownership", () => {
  /** Manifest written by the last sync. */
  const manifestOf = (files: MemoryFiles) =>
    JSON.parse(files.files.get(SYNC_MANIFEST_PATH) ?? "{}") as {
      files: Record<string, string>;
      permissions: string[];
    };

  async function deactivateIris(files: MemoryFiles) {
    const changed = await profileCommand.run(context(files), {
      profile: resolveProfile("maintenance"),
    });
    expect(changed.ok).toBe(true);
  }

  it("keeps and reports a stale generated file edited by hand", async () => {
    const files = await installed();
    await sync(files);
    files.seed(AGENT, `${files.files.get(AGENT)}my note\n`);
    await deactivateIris(files);
    const result = await sync(files);
    expect(files.files.get(AGENT)).toContain("my note");
    expect(result.warnings).toEqual([{ kind: "kept", path: AGENT }]);
    expect(actions(result)[SKILL]).toBe("deleted");
    expect(manifestOf(files).files[AGENT]).toBeUndefined();
  });

  it("keeps and reports a stale binary annex edited by hand", async () => {
    const files = await installed();
    const logo = ".agentplugged/agents/iris/assets/logo.png";
    files.seedBytes(logo, new Uint8Array([1, 2, 3]));
    await sync(files);
    const copy = ".claude/skills/iris/assets/logo.png";
    files.seedBytes(copy, new Uint8Array([9, 9]));
    files.binaries.delete(logo);
    const result = await sync(files);
    expect(files.binaries.get(copy)).toEqual(new Uint8Array([9, 9]));
    expect(result.warnings).toEqual([{ kind: "kept", path: copy }]);
  });

  it("keeps and reports the files of a skill folder the creator took", async () => {
    const files = await installed();
    const logo = ".agentplugged/agents/iris/assets/logo.png";
    files.seedBytes(logo, new Uint8Array([1, 2, 3]));
    await sync(files);
    const copy = ".claude/skills/iris/assets/logo.png";
    files.seed(SKILL, "---\nname: iris\n---\nnow mine\n");
    await deactivateIris(files);
    const result = await sync(files);
    expect(files.files.get(SKILL)).toBe("---\nname: iris\n---\nnow mine\n");
    expect(files.binaries.get(copy)).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.warnings).toEqual([
      { kind: "kept", path: SKILL },
      { kind: "kept", path: copy },
    ]);
    expect(actions(result)[AGENT]).toBe("deleted");
  });

  it("never deletes a manifest entry outside .claude/ and CLAUDE.md", async () => {
    const files = await installed();
    await sync(files);
    const manifest = manifestOf(files);
    files.seed(".agentplugged/docs/prd.md", "prd");
    manifest.files[".agentplugged/docs/prd.md"] = "0".repeat(64);
    files.seed(SYNC_MANIFEST_PATH, JSON.stringify({ format_version: 1, ...manifest }));
    const result = await sync(files);
    expect(files.files.get(".agentplugged/docs/prd.md")).toBe("prd");
    expect(result.warnings).toEqual([]);
  });

  it("leaves a creator's skill folder without SKILL.md alone", async () => {
    const files = await installed({ ".claude/skills/iris/notes.md": "mine" });
    const result = await sync(files);
    expect(result.warnings).toEqual([{ kind: "conflict", path: ".claude/skills/iris/" }]);
    expect(files.files.has(SKILL)).toBe(false);
    expect(files.files.get(".claude/skills/iris/notes.md")).toBe("mine");
  });

  it("regenerates a generated skill folder whose SKILL.md was deleted", async () => {
    const files = await installed({ ".agentplugged/agents/iris/references/guide.md": "# Guide\n" });
    await sync(files);
    files.files.delete(SKILL);
    const result = await sync(files);
    expect(actions(result)[SKILL]).toBe("created");
    expect(result.warnings).toEqual([]);
  });
});

describe("sync: constitution, CLAUDE.md and settings", () => {
  it("fails before writing when the constitution is missing", async () => {
    const files = await installed();
    files.files.delete("AGENTS.md");
    files.writes.length = 0;
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONSTITUTION_MISSING");
      expect(result.error.details.path).toBe("AGENTS.md");
    }
    expect(files.writes).toEqual([]);
  });

  it("warns about a CLAUDE.md block without end marker and leaves the file", async () => {
    const claude = `mine\n${BLOCK_BEGIN}\nhalf a block\n`;
    const files = await installed();
    files.seed("CLAUDE.md", claude);
    const result = await sync(files);
    expect(files.files.get("CLAUDE.md")).toBe(claude);
    expect(result.warnings).toEqual([{ kind: "conflict", path: "CLAUDE.md" }]);
  });

  it("leaves a CLAUDE.md that is the constitution itself (a link to AGENTS.md)", async () => {
    const files = await installed();
    files.seed("CLAUDE.md", files.files.get("AGENTS.md") ?? "");
    const result = await sync(files);
    expect(actions(result)["CLAUDE.md"]).toBe("unchanged");
    expect(files.files.get("CLAUDE.md")).toBe(files.files.get("AGENTS.md"));
    // It is the constitution: still protected.
    expect(settingsOf(files).permissions.deny).toContain("Edit(/CLAUDE.md)");
  });

  it("deletes a byte-copied annex with a Markdown-like extension by its hash alone", async () => {
    const files = await installed();
    const source = ".agentplugged/agents/iris/assets/rule.mdc";
    files.seedBytes(source, new Uint8Array([110, 111, 10]));
    await sync(files);
    const copy = ".claude/skills/iris/assets/rule.mdc";
    expect(files.binaries.has(copy)).toBe(true);
    files.binaries.delete(source);
    const result = await sync(files);
    expect(actions(result)[copy]).toBe("deleted");
    expect(result.warnings).toEqual([]);
    const again = await sync(files);
    expect(again.warnings).toEqual([]);
  });

  it("does not claim a rule the creator already had", async () => {
    const files = await installed({
      [SETTINGS]: JSON.stringify({ permissions: { deny: ["Edit(/.claude/**)"] } }),
    });
    await sync(files);
    const manifest = JSON.parse(files.files.get(SYNC_MANIFEST_PATH) ?? "{}");
    expect(manifest.permissions).not.toContain("Edit(/.claude/**)");
    expect(manifest.permissions).toContain("Edit(/CLAUDE.md)");
    // Even when sync stops producing it, the creator's rule stays.
    files.seed("CLAUDE.md", "my instructions\n");
    await sync(files);
    expect(settingsOf(files).permissions.deny).toContain("Edit(/.claude/**)");
    expect(settingsOf(files).permissions.deny).not.toContain("Edit(/CLAUDE.md)");
  });

  it("keeps CRLF line endings when it merges settings", async () => {
    const files = await installed({ [SETTINGS]: '{\r\n  "env": { "A": "1" }\r\n}\r\n' });
    await sync(files);
    const text = files.files.get(SETTINGS) ?? "";
    expect(text).toContain('"env"');
    expect(
      text.split("\n").every((line, i, all) => i === all.length - 1 || line.endsWith("\r")),
    ).toBe(true);
  });
});
