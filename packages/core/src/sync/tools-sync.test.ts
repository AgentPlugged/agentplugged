import { describe, expect, it } from "vitest";
import {
  BLOCK_BEGIN,
  CAPABILITIES,
  COMPATIBILITY,
  type CommandContext,
  cursorDenyRules,
  denyRules,
  GENERATED_HEADER,
  GENERATED_HEADER_HASH,
  initCommand,
  pointerBlock,
  profileCommand,
  renderCodexHooks,
  resolveProfile,
  type SyncResult,
  syncCommand,
  type ToolProbe,
  tomlMultiline,
  tomlString,
  withEngineCommand,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { CODEX_CONFIG_KEPT_REASON } from "./compatibility.js";
import { SYNC_MANIFEST_PATH } from "./manifest.js";

/** The engine's command in the generated text: the pinned `npx` launch of these tests. */
const localized = (text: string) => withEngineCommand(text, "npx -y agentplugged@1.0.0");

/** A machine where `found` commands exist (`claude`, `codex`, `agy`, `cursor-agent`...). */
function machine(...found: string[]): ToolProbe {
  return {
    which: async (names) => {
      const name = names.find((candidate) => found.includes(candidate));
      return name === undefined ? undefined : { name, path: `/usr/bin/${name}` };
    },
    version: async () => "1.0.0",
    extensions: async () => [],
  };
}

const NO_TOOL = machine();

function context(files: MemoryFiles, tools: ToolProbe = NO_TOOL): CommandContext {
  return { files, tools, method: shippedMethod(), actor: "human", engineVersion: "1.0.0" };
}

async function installed(
  initial: Record<string, string> = {},
  tools: ToolProbe = NO_TOOL,
): Promise<MemoryFiles> {
  const files = new MemoryFiles(initial);
  const result = await initCommand.run(context(files, tools), {
    profile: resolveProfile("new-product"),
  });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  return files;
}

async function sync(files: MemoryFiles, tools: ToolProbe = NO_TOOL): Promise<SyncResult> {
  const result = await syncCommand.run(context(files, tools), {});
  if (!result.ok) {
    throw new Error(`sync failed: ${result.error.code} ${JSON.stringify(result.error.details)}`);
  }
  return result.value;
}

const CONFIG = ".agentplugged/method.yaml";

/** Rewrites the `tools` list of `method.yaml`; `undefined` removes it. */
function setTools(files: MemoryFiles, tools: readonly string[] | undefined) {
  const text = (files.files.get(CONFIG) ?? "").replace(/tools:\n(?: {2}- .*\n)+/, "");
  const list = tools === undefined ? "" : `tools: [${tools.join(", ")}]\n`;
  files.seed(CONFIG, `${text}${list}`);
}

function actions(result: SyncResult): Record<string, string> {
  return Object.fromEntries(result.entries.map((entry) => [entry.path, entry.action]));
}

const json = (files: MemoryFiles, path: string) => JSON.parse(files.files.get(path) ?? "null");

/** Decodes a TOML basic or multi-line basic string, as a TOML parser would. */
function decodeToml(literal: string): string {
  const multi = literal.startsWith('"""');
  let body = multi ? literal.slice(3, -3) : literal.slice(1, -1);
  if (multi && body.startsWith("\n")) body = body.slice(1);
  // No quote left once escapes are removed: nothing can close the string early.
  expect(body.replace(/\\./g, "").includes('"')).toBe(false);
  return body.replace(/\\(u[0-9A-F]{4}|.)/g, (_match, code: string) => {
    if (code.startsWith("u") && code.length === 5) {
      return String.fromCharCode(Number.parseInt(code.slice(1), 16));
    }
    return { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" }[code] ?? `?${code}`;
  });
}

describe("sync to the four tools", () => {
  it("generates every tool's files, the shared skill once, and reports the fallbacks", async () => {
    const files = await installed();
    expect(files.files.get(CONFIG)).toContain(
      "tools:\n  - claude-code\n  - codex\n  - antigravity\n  - cursor\n",
    );
    const result = await sync(files);
    expect(result.tools).toEqual(["claude-code", "codex", "antigravity", "cursor"]);
    expect(result.warnings).toEqual([]);

    const created = result.entries.filter((entry) => entry.action === "created");
    expect(created.map((entry) => entry.path).sort()).toEqual(
      [
        ".claude/skills/iris/SKILL.md",
        ".claude/agents/iris.md",
        "CLAUDE.md",
        ".claude/settings.json",
        ".claude/hooks/agentplugged-prompt.mjs",
        ".claude/hooks/agentplugged-decision.mjs",
        ".agents/skills/iris/SKILL.md",
        ".codex/agents/iris.toml",
        ".codex/config.toml",
        // Codex's hooks and rules of commands.
        ".codex/hooks/agentplugged-codex.mjs",
        ".codex/hooks/agentplugged-policy.json",
        ".codex/rules/agentplugged.rules",
        ".agents/agents/iris.md",
        ".gemini/agents/iris.md",
        "GEMINI.md",
        ".cursor/agents/iris.md",
        ".cursor/rules/agentplugged.mdc",
        ".cursor/cli.json",
        // Cursor's hooks, their policy and the secrets kept from its agent.
        ".cursor/hooks.json",
        ".cursor/hooks/agentplugged-cursor.mjs",
        ".cursor/hooks/agentplugged-policy.json",
        ".cursorignore",
        ".mcp.json",
        // Antigravity CLI's project plugin: its MCP server and its hooks.
        ".agents/plugins/agentplugged/plugin.json",
        ".agents/plugins/agentplugged/mcp_config.json",
        ".agents/plugins/agentplugged/hooks.json",
        ".agents/plugins/agentplugged/policy.json",
        ".agents/plugins/agentplugged/hooks/agentplugged-antigravity.mjs",
        ".cursor/mcp.json",
      ].sort(),
    );
    // The shared skill is written once, and is the same as Claude Code's.
    expect(result.entries.filter((e) => e.path === ".agents/skills/iris/SKILL.md")).toHaveLength(1);
    expect(files.files.get(".agents/skills/iris/SKILL.md")).toBe(
      files.files.get(".claude/skills/iris/SKILL.md"),
    );
    expect(result.entries.find((e) => e.path === ".agents/skills/iris/SKILL.md")?.group).toBe(
      "shared",
    );
    expect(result.entries.find((e) => e.path === ".codex/config.toml")?.group).toBe("codex");

    // The constitution was written by init with the same fallbacks: nothing to change.
    expect(actions(result)["AGENTS.md"]).toBe("unchanged");
    expect(files.files.get("AGENTS.md")).toContain("`fallbacks`");
    const constitution = files.reference();
    expect(constitution).toContain("\n## Tool fallbacks\n");
    expect(constitution).toContain("without a technical guard");
    expect(result.fallbacks.map((f) => `${f.client}.${f.capability}`)).toEqual([
      // Codex's hooks apply the rules, record the creator's messages and the installations.
      "codex.rules",
      "codex.untrusted",
      "codex.isolation",
      "codex.decisions",
      // Antigravity CLI's plugin applies the rules, records the reads and the creator's messages.
      "antigravity.isolation",
      "antigravity.decisions",
      "gemini-cli.permissions",
      "gemini-cli.model",
      "gemini-cli.mcp",
      "gemini-cli.rules",
      "gemini-cli.untrusted",
      "gemini-cli.chat_proof",
      "gemini-cli.isolation",
      "gemini-cli.decisions",
      "gemini-cli.installs",
      // The traces of Gemini CLI are not read.
      "gemini-cli.usage",
      // Cursor's hooks apply the permissions, record the reads, the creator's messages and the installations.
      "cursor.rules",
      "cursor.isolation",
      "cursor.decisions",
      "cursor.usage",
    ]);
    for (const fallback of result.fallbacks) {
      expect(files.reference()).toContain(
        `- ${fallback.name}, ${fallback.capability}: ${localized(fallback.reason)}`,
      );
    }

    // Nothing outside the project.
    for (const path of [...files.files.keys(), ...files.binaries.keys()]) {
      expect(path.startsWith("~") || path.startsWith("/")).toBe(false);
    }
  });

  it("renders each sub-agent with the frontmatter its tool expects", async () => {
    const files = await installed();
    await sync(files);
    const description = "description: Product analyst who frames a new product.";
    // Iris is a `reasoning` agent: each tool gets the model of that tier.
    expect(files.files.get(".agents/agents/iris.md")).toMatch(
      new RegExp(`^---\\nname: iris\\n${description}\\nmodel: pro\\n---\\n`),
    );
    expect(files.files.get(".gemini/agents/iris.md")).toMatch(
      new RegExp(`^---\\nname: iris\\n${description}\\nkind: local\\n---\\n`),
    );
    // Cursor keeps the session's model unless the creator names one.
    expect(files.files.get(".cursor/agents/iris.md")).toMatch(
      new RegExp(`^---\\nname: iris\\n${description}\\nmodel: inherit\\n---\\n`),
    );
    for (const path of [
      ".agents/agents/iris.md",
      ".gemini/agents/iris.md",
      ".cursor/agents/iris.md",
    ]) {
      const text = files.files.get(path) ?? "";
      expect(text).toContain(`---\n${GENERATED_HEADER}\n# 🔎 Iris, Product Analyst\n`);
      expect(text).toContain("\n## Activation\n");
      expect(text).toContain("\n## Menu\n");
    }

    const toml = files.files.get(".codex/agents/iris.toml") ?? "";
    const lines = toml.split("\n");
    expect(lines[0]).toBe(GENERATED_HEADER_HASH);
    expect(lines[1]).toBe('name = "iris"');
    expect(lines[2]).toBe('description = "Product analyst who frames a new product."');
    // No model by default, the session's own.
    expect(lines[3]).toBe('developer_instructions = """');
    const literal = toml.slice(toml.indexOf('"""'), toml.lastIndexOf('"""') + 3);
    const instructions = decodeToml(literal);
    expect(instructions.startsWith("# 🔎 Iris, Product Analyst\n")).toBe(true);
    expect(instructions).toBe(
      (files.files.get(".cursor/agents/iris.md") ?? "").split(`${GENERATED_HEADER}\n`)[1],
    );

    // No approval (the sandbox is the boundary), the engine's tools run without asking, and
    // the project's hooks, the same on every machine and every engine version.
    expect(files.files.get(".codex/config.toml")).toBe(
      `${GENERATED_HEADER_HASH}\nsandbox_mode = "workspace-write"\napproval_policy = { granular = { mcp_elicitations = true, rules = false, sandbox_approval = false, request_permissions = false, skill_approval = false } }\nweb_search = "live"\n\n[sandbox_workspace_write]\nnetwork_access = true\n\n[mcp_servers.agentplugged]\ncommand = "npx"\nargs = ["-y", "agentplugged@1.0.0", "mcp"]\ndefault_tools_approval_mode = "approve"\n\n${renderCodexHooks()}`,
    );
    expect(renderCodexHooks()).not.toContain("1.0.0");
    expect(files.files.get("GEMINI.md")).toBe(`${GENERATED_HEADER}\n@AGENTS.md\n`);
    expect(files.files.get(".cursor/rules/agentplugged.mdc")).toBe(
      `---\ndescription: AgentPlugged method constitution\nalwaysApply: true\n---\n${GENERATED_HEADER}\nThis project uses the AgentPlugged method. Read and follow \`AGENTS.md\` before any work.\n`,
    );
  });

  it("lists the folder of the stories' working copies in Codex's writable_roots, hooks untouched", async () => {
    const files = await installed();
    const run = async (projectRoot: string | undefined) => {
      const result = await syncCommand.run(
        { ...context(files), ...(projectRoot === undefined ? {} : { projectRoot }) },
        {},
      );
      expect(result.ok).toBe(true);
      return files.files.get(".codex/config.toml") ?? "";
    };
    const without = await run(undefined);
    expect(without).not.toContain("writable_roots");
    const posix = await run("/home/ada/demo");
    expect(posix).toContain(
      '[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = ["/home/ada/demo.worktrees"]\n',
    );
    const windows = await run("C:\\Users\\Ada\\Desktop\\demo-zero");
    expect(windows).toContain(
      'writable_roots = ["C:\\\\Users\\\\Ada\\\\Desktop\\\\demo-zero.worktrees"]',
    );
    // Run from a working copy, the folder is its parent.
    expect(await run("/home/ada/demo.worktrees/1-2")).toContain(
      'writable_roots = ["/home/ada/demo.worktrees"]',
    );
    // The hooks do not change: Codex's approval is kept against their definitions.
    const hooksOf = (text: string) => text.slice(text.indexOf("[[hooks."));
    expect(hooksOf(posix)).toBe(hooksOf(without));
    expect(hooksOf(posix)).toBe(renderCodexHooks());
  });

  it("writes the same forbidden paths for Cursor CLI as for Claude Code", async () => {
    // What sync protects with the four tools targeted and every root file generated.
    const protections = {
      rootAgentsGenerated: true,
      claudeMdGenerated: true,
      geminiMdGenerated: true,
      generatedRoots: [".claude", ".agents", ".codex", ".gemini", ".cursor"],
      mcpConfigGenerated: true,
    };
    const files = await installed();
    await sync(files);
    const deny: string[] = json(files, ".cursor/cli.json").permissions.deny;
    expect(deny).toEqual(
      expect.arrayContaining([
        "Write(.agentplugged/method.yaml)",
        "Write(.claude/**)",
        "Write(.agents/**)",
        "Write(.codex/**)",
        "Write(.gemini/**)",
        "Write(.cursor/**)",
        "Write(AGENTS.md)",
        "Write(CLAUDE.md)",
        "Write(GEMINI.md)",
        "Write(**/.env)",
        "Write(~/.ssh/**)",
        "Read(**/.env)",
        "Read(~/.ssh/**)",
        "Shell(git:push *agentplugged/journal*)",
        "Shell(gh:pr merge*)",
        "Shell(glab:mr merge*)",
      ]),
    );
    expect(deny.some((rule) => /docs|epics|stories/.test(rule))).toBe(false);
    const claude: string[] = json(files, ".claude/settings.json").permissions.deny;
    // The same protections in both tools; the permission rules differ: an `ask`
    // becomes a `deny` for Cursor CLI, and SQL patterns are written for Claude Code only.
    expect(cursorDenyRules(protections).length).toBe(denyRules(protections).length);
    expect(claude).toEqual(expect.arrayContaining(denyRules(protections)));
    expect(deny).toEqual(expect.arrayContaining(cursorDenyRules(protections)));
    expect(claude).toContain("Edit(/.cursor/**)");
    expect(claude).toContain("Edit(/GEMINI.md)");
    const manifest = json(files, SYNC_MANIFEST_PATH);
    expect(manifest.cursor_permissions).toEqual(deny);
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

  it("regenerates a TOML agent modified by hand and reports it", async () => {
    const files = await installed();
    await sync(files);
    const path = ".codex/agents/iris.toml";
    const generated = files.files.get(path) ?? "";
    files.seed(path, `${generated}model = "x"\n`);
    const result = await sync(files);
    expect(result.warnings).toEqual([{ kind: "overwritten", path }]);
    expect(files.files.get(path)).toBe(generated);
  });
});

describe("compatibility matrix", () => {
  it("is honoured cell by cell: native files generated, fallbacks announced", async () => {
    const files = await installed();
    const result = await sync(files);
    const constitution = files.reference();
    for (const entry of COMPATIBILITY) {
      for (const capability of CAPABILITIES) {
        const cell = entry.cells[capability];
        const where = `${entry.client} × ${capability}`;
        for (const template of cell.files) {
          const path = template.replace("<id>", "iris");
          expect(files.files.has(path), `${where}: ${path}`).toBe(true);
        }
        const announced = result.fallbacks.find(
          (f) => f.client === entry.client && f.capability === capability,
        );
        if (cell.support === "native") {
          // What the engine measures is read from the tool's own traces: `sync` writes no file for it.
          if (capability !== "usage") expect(cell.files.length, where).toBeGreaterThan(0);
          expect(announced, where).toBeUndefined();
        } else {
          expect(cell.reason, where).toBeTruthy();
          expect(announced?.reason, where).toBe(cell.reason);
          expect(constitution, where).toContain(
            `- ${entry.name}, ${capability}: ${localized(cell.reason ?? "")}`,
          );
        }
      }
    }
  });

  it("announces only the fallbacks of the targeted tools", async () => {
    const files = await installed({}, machine("claude"));
    const result = await sync(files, machine("claude"));
    expect(result.fallbacks).toEqual([]);
    expect(files.files.get("AGENTS.md")).not.toContain("Tool fallbacks");

    setTools(files, ["claude-code", "codex"]);
    const again = await sync(files);
    expect(again.fallbacks.map((f) => `${f.client}.${f.capability}`)).toEqual([
      "codex.rules",
      "codex.untrusted",
      "codex.isolation",
      "codex.decisions",
    ]);
    expect(actions(again)["AGENTS.md"]).toBe("updated");
    expect(files.reference()).toContain("- Codex, rules: ");
  });
});

describe("sync: the tools list", () => {
  it("deletes the files of a tool removed from the list, and only ours in its settings", async () => {
    const files = await installed({
      ".cursor/cli.json": JSON.stringify({ permissions: { allow: ["Shell(ls)"] } }),
    });
    await sync(files);
    expect(json(files, ".cursor/cli.json").permissions.deny.length).toBeGreaterThan(0);

    setTools(files, ["claude-code", "codex", "antigravity"]);
    const result = await sync(files);
    expect(actions(result)).toMatchObject({
      ".cursor/agents/iris.md": "deleted",
      ".cursor/rules/agentplugged.mdc": "deleted",
      ".cursor/cli.json": "updated",
      ".agents/skills/iris/SKILL.md": "unchanged",
    });
    expect(result.entries.find((e) => e.path === ".cursor/agents/iris.md")?.group).toBe("cursor");
    expect(files.files.has(".cursor/agents/iris.md")).toBe(false);
    expect(files.dirs.has(".cursor/agents")).toBe(false);
    expect(files.dirs.has(".cursor/rules")).toBe(false);
    // Our rules, and the `deny` list sync introduced, are gone; the rest is the creator's.
    expect(json(files, ".cursor/cli.json")).toEqual({ permissions: { allow: ["Shell(ls)"] } });
    expect(json(files, SYNC_MANIFEST_PATH).settings?.[".cursor/cli.json"]).toBeUndefined();
    expect(json(files, SYNC_MANIFEST_PATH).cursor_permissions).toBeUndefined();
    expect(json(files, ".claude/settings.json").permissions.deny).not.toContain(
      "Edit(/.cursor/**)",
    );

    // Run again: nothing left to do for Cursor.
    files.writes.length = 0;
    const again = await sync(files);
    expect(again.entries.some((e) => e.path.startsWith(".cursor/"))).toBe(false);
    expect(files.writes).toEqual([]);
  });

  it("deletes a settings file it created once its tool leaves the list", async () => {
    const files = await installed();
    await sync(files);
    setTools(files, ["codex"]);
    const result = await sync(files);
    expect(actions(result)).toMatchObject({
      ".claude/settings.json": "deleted",
      ".claude/agents/iris.md": "deleted",
      ".claude/skills/iris/SKILL.md": "deleted",
      "CLAUDE.md": "deleted",
      ".cursor/cli.json": "deleted",
      "GEMINI.md": "deleted",
      ".gemini/agents/iris.md": "deleted",
      ".agents/agents/iris.md": "deleted",
      ".agents/skills/iris/SKILL.md": "unchanged",
      ".codex/config.toml": "unchanged",
    });
    expect(files.dirs.has(".claude")).toBe(false);
    expect(files.dirs.has(".cursor")).toBe(false);
    expect(files.dirs.has(".gemini")).toBe(false);
    expect(files.dirs.has(".agents/agents")).toBe(false);
    expect(files.dirs.has(".agents/skills/iris")).toBe(true);
    expect(json(files, SYNC_MANIFEST_PATH).permissions).toEqual([]);
  });

  it("keeps the generated files of a removed tool when they were edited by hand", async () => {
    const files = await installed();
    await sync(files);
    files.seed(".codex/config.toml", `${files.files.get(".codex/config.toml")}model = "x"\n`);
    setTools(files, ["claude-code"]);
    const result = await sync(files);
    expect(result.warnings).toContainEqual({ kind: "kept", path: ".codex/config.toml" });
    expect(files.files.has(".codex/config.toml")).toBe(true);
    expect(actions(result)[".codex/agents/iris.toml"]).toBe("deleted");
  });

  it("uses the detected tools when method.yaml has no list (older files)", async () => {
    const files = await installed({}, machine("codex"));
    setTools(files, undefined);
    expect(files.files.get(CONFIG)).not.toContain("tools");
    const result = await sync(files, machine("codex"));
    expect(result.tools).toEqual(["codex"]);
    expect(files.files.has(".codex/agents/iris.toml")).toBe(true);
    expect(files.files.has(".agents/skills/iris/SKILL.md")).toBe(true);
    expect(files.files.has(".claude/settings.json")).toBe(false);
    expect(files.files.has("CLAUDE.md")).toBe(false);
    // The detected list is written once, comments kept, and reported.
    expect(files.files.get(CONFIG)).toMatch(/\ntools:\n {2}- codex\n$/);
    expect(actions(result)[CONFIG]).toBe("updated");
  });

  it("keeps the first detected list when a teammate detects other tools", async () => {
    const files = await installed({}, machine("codex"));
    setTools(files, undefined);
    files.seed(
      CONFIG,
      `# team settings\r\n${(files.files.get(CONFIG) ?? "").replace(/\n/g, "\r\n")}`,
    );
    await sync(files, machine("codex"));
    const text = files.files.get(CONFIG) ?? "";
    expect(text.startsWith("# team settings\r\n")).toBe(true);
    expect(text).toContain("\r\ntools:\r\n  - codex\r\n");
    expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false);

    // A teammate with Cursor only: the recorded list wins, nothing of Codex is deleted.
    files.writes.length = 0;
    const second = await sync(files, machine("cursor-agent"));
    expect(second.tools).toEqual(["codex"]);
    expect(actions(second)[CONFIG]).toBeUndefined();
    expect(files.writes).toEqual([]);
    expect(files.files.has(".codex/agents/iris.toml")).toBe(true);
    expect(files.files.has(".cursor/agents/iris.md")).toBe(false);
  });

  it("removes the import block from the creator's CLAUDE.md and GEMINI.md when their tool leaves", async () => {
    const files = await installed({ "CLAUDE.md": "claude\r\n", "GEMINI.md": "gemini" });
    await sync(files);
    expect(files.files.get("CLAUDE.md")).toContain(BLOCK_BEGIN);
    setTools(files, ["codex"]);
    const result = await sync(files);
    expect(actions(result)).toMatchObject({ "CLAUDE.md": "updated", "GEMINI.md": "updated" });
    expect(files.files.get("CLAUDE.md")).toBe("claude\r\n");
    expect(files.files.get("GEMINI.md")).toBe("gemini\n");

    // init no longer adds them back while the tools are not targeted.
    files.writes.length = 0;
    await initCommand.run(context(files), {});
    expect(files.files.get("CLAUDE.md")).toBe("claude\r\n");
    expect(files.files.get("GEMINI.md")).toBe("gemini\n");
    const again = await sync(files);
    expect(actions(again)["CLAUDE.md"]).toBeUndefined();
  });

  it("leaves AGENTS.md without fallbacks when init runs again after the list changed", async () => {
    const files = await installed();
    setTools(files, ["claude-code"]);
    await sync(files);
    const constitution = files.files.get("AGENTS.md") ?? "";
    expect(constitution).not.toContain("Tool fallbacks");
    const result = await initCommand.run(context(files), {});
    expect(result.ok && result.value.entries.find((e) => e.path === "AGENTS.md")?.action).toBe(
      "unchanged",
    );
    expect(files.files.get("AGENTS.md")).toBe(constitution);
  });

  it.each([
    ["an unknown tool", "tools: [vim]\n", "tools.0"],
    ["an empty list", "tools: []\n", "tools"],
  ])("stops before any write on %s", async (_name, line, field) => {
    const files = await installed();
    setTools(files, undefined);
    files.seed(CONFIG, `${files.files.get(CONFIG)}${line}`);
    files.writes.length = 0;
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("METHOD_CONFIG_INVALID");
      expect(result.error.details).toMatchObject({ field });
    }
    expect(files.writes).toEqual([]);
  });

  it("init writes the detected tools on creation only; profile leaves them", async () => {
    const files = await installed({}, machine("claude", "agy"));
    expect(files.files.get(CONFIG)).toMatch(/\ntools:\n {2}- claude-code\n {2}- antigravity\n$/);
    const changed = await profileCommand.run(context(files), {
      profile: resolveProfile("prototype"),
    });
    expect(changed.ok).toBe(true);
    expect(files.files.get(CONFIG)).toContain("tools:\n  - claude-code\n  - antigravity\n");

    const older = await installed({
      [CONFIG]: "format_version: 2\nengine_version: 1.0.0\n",
    });
    expect(older.files.get(CONFIG)).not.toContain("tools");
  });
});

describe("sync: settings when a tool leaves the list", () => {
  it("removes only what sync added to the creator's settings.json", async () => {
    const mine = { env: { A: "1" } };
    const files = await installed({ ".claude/settings.json": JSON.stringify(mine) });
    await sync(files);
    const record = json(files, SYNC_MANIFEST_PATH).settings[".claude/settings.json"];
    expect(record).toEqual({
      created: false,
      keys: [
        "permissions",
        "permissions.deny",
        "permissions.allow",
        "permissions.disableBypassPermissionsMode",
      ],
    });
    setTools(files, ["codex"]);
    const result = await sync(files);
    expect(actions(result)[".claude/settings.json"]).toBe("updated");
    expect(json(files, ".claude/settings.json")).toEqual(mine);
    expect(json(files, SYNC_MANIFEST_PATH).settings).toBeUndefined();
  });

  it("keeps the creator's own disableBypassPermissionsMode and deny list", async () => {
    const mine = {
      permissions: { deny: ["Read(/secret/**)"], disableBypassPermissionsMode: "disable" },
    };
    const files = await installed({ ".claude/settings.json": JSON.stringify(mine) });
    await sync(files);
    setTools(files, ["codex"]);
    await sync(files);
    expect(json(files, ".claude/settings.json")).toEqual(mine);
  });

  it("keeps a creator's file holding only {} or $schema", async () => {
    for (const mine of [
      {},
      { $schema: "https://json.schemastore.org/claude-code-settings.json" },
    ]) {
      const files = await installed({ ".claude/settings.json": JSON.stringify(mine) });
      await sync(files);
      setTools(files, ["codex"]);
      const result = await sync(files);
      expect(actions(result)[".claude/settings.json"]).toBe("updated");
      expect(json(files, ".claude/settings.json")).toEqual(mine);
    }
  });

  it("deletes a cli.json it created once Cursor leaves the list", async () => {
    const files = await installed();
    await sync(files);
    expect(json(files, SYNC_MANIFEST_PATH).settings[".cursor/cli.json"].created).toBe(true);
    setTools(files, ["codex"]);
    const result = await sync(files);
    expect(actions(result)[".cursor/cli.json"]).toBe("deleted");
    expect(files.files.has(".cursor/cli.json")).toBe(false);
  });

  it("accepts a Cursor setting outside the Claude schema", async () => {
    const mine = { editor: { vimMode: true }, permissions: { allow: ["Read(**)"], ask: 3 } };
    const files = await installed({ ".cursor/cli.json": JSON.stringify(mine) });
    await sync(files);
    expect(json(files, ".cursor/cli.json").permissions.ask).toBe(3);
  });
});

describe("sync: the creator's files", () => {
  it("adds the import block to the creator's GEMINI.md", async () => {
    const files = await installed({ "GEMINI.md": "mine\n" });
    expect(files.files.get("GEMINI.md")).toBe(`mine\n\n${pointerBlock("AGENTS.md", "import")}\n`);
    const result = await sync(files);
    expect(actions(result)["GEMINI.md"]).toBe("unchanged");
    expect(files.files.get("GEMINI.md")?.split(BLOCK_BEGIN)).toHaveLength(2);
    expect(files.files.get("GEMINI.md")).toContain("\n@AGENTS.md\n");
    expect(json(files, ".claude/settings.json").permissions.deny).not.toContain("Edit(/GEMINI.md)");
  });

  it("keeps protecting a GEMINI.md that is a copy of the generated constitution", async () => {
    const files = await installed();
    files.seed("GEMINI.md", files.files.get("AGENTS.md") ?? "");
    files.seed("CLAUDE.md", files.files.get("AGENTS.md") ?? "");
    const result = await sync(files);
    expect(actions(result)["GEMINI.md"]).toBe("unchanged");
    const claude: string[] = json(files, ".claude/settings.json").permissions.deny;
    expect(claude).toContain("Edit(/GEMINI.md)");
    expect(claude).toContain("Edit(/CLAUDE.md)");
    const cursor: string[] = json(files, ".cursor/cli.json").permissions.deny;
    expect(cursor).toContain("Write(GEMINI.md)");
    expect(cursor).toContain("Write(CLAUDE.md)");
  });

  it("merges our rules into the creator's cli.json and keeps the rest", async () => {
    const mine = { version: 1, permissions: { allow: ["Shell(npm)"], deny: ["Read(secret/**)"] } };
    const files = await installed({ ".cursor/cli.json": JSON.stringify(mine) });
    const result = await sync(files);
    expect(actions(result)[".cursor/cli.json"]).toBe("updated");
    const merged = json(files, ".cursor/cli.json");
    expect(merged.version).toBe(1);
    expect(merged.permissions.allow[0]).toBe("Shell(npm)");
    expect(merged.permissions.allow).toContain("Write(**)");
    expect(merged.permissions.deny[0]).toBe("Read(secret/**)");
    expect(merged.permissions.deny).toContain("Write(.cursor/**)");
  });

  it("refuses an unreadable cli.json and writes nothing", async () => {
    const files = await installed({ ".cursor/cli.json": "{ nope" });
    files.writes.length = 0;
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SETTINGS_INVALID");
      expect(result.error.details.path).toBe(".cursor/cli.json");
    }
    expect(files.writes).toEqual([]);
  });

  it("leaves the creator's .codex/config.toml as is, warns, and says so in the fallback", async () => {
    const mine = 'model = "o9"\n';
    const files = await installed({ ".codex/config.toml": mine });
    const result = await sync(files);
    expect(files.files.get(".codex/config.toml")).toBe(mine);
    expect(result.warnings).toEqual([{ kind: "conflict", path: ".codex/config.toml" }]);
    expect(json(files, SYNC_MANIFEST_PATH).files[".codex/config.toml"]).toBeUndefined();
    expect(result.codexTrustReminder).toBe(false);
    const codex = result.fallbacks.find((f) => f.client === "codex");
    expect(codex?.id).toBe("codex.permissions.config-kept");
    expect(codex?.reason).toBe(CODEX_CONFIG_KEPT_REASON);
    const constitution = files.reference();
    expect(constitution).toContain(`- Codex, permissions: ${CODEX_CONFIG_KEPT_REASON}`);
    expect(constitution).not.toContain("workspace-write");
  });

  it("asks to trust the project only when .codex/config.toml is written", async () => {
    const files = await installed();
    expect((await sync(files)).codexTrustReminder).toBe(true);
    expect((await sync(files)).codexTrustReminder).toBe(false);
  });

  it("writes the fallbacks into .agentplugged/AGENTS.md when the root AGENTS.md is the creator's", async () => {
    const files = await installed({ "AGENTS.md": "my rules\n" });
    await sync(files);
    expect(files.reference()).toContain("\n## Tool fallbacks\n");
    expect(files.files.get(".agentplugged/AGENTS.md")).toContain("`fallbacks`");
    expect(files.files.get("AGENTS.md")).not.toContain("Tool fallbacks");
    expect(files.files.get("GEMINI.md")).toBe(`${GENERATED_HEADER}\n@.agentplugged/AGENTS.md\n`);
    expect(files.files.get(".cursor/rules/agentplugged.mdc")).toContain(
      "Read and follow `.agentplugged/AGENTS.md`",
    );
  });
});

describe("TOML strings", () => {
  it.each([
    ["plain", "Product analyst"],
    ["quotes and backslashes", 'Say "hi" \\ then C:\\path'],
    ["triple quotes", 'a """ b """"'],
    ["control characters", "bell\u0007 tab\t cr\r"],
    ["line breaks", "one\ntwo\n\nthree\n"],
  ])("round-trips %s", (_name, text) => {
    expect(decodeToml(tomlMultiline(text))).toBe(text);
    const single = tomlString(text);
    expect(single.includes("\n")).toBe(false);
    expect(decodeToml(single)).toBe(text);
  });
});
