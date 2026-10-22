import { describe, expect, it } from "vitest";
import {
  type AgentCommandResult,
  agentCommand,
  type CommandContext,
  type CommandInput,
  GENERATED_HEADER_HASH,
  initCommand,
  MODEL_INHERIT_REASON,
  MODELS_PATH,
  parseModelTable,
  renderOverrideTemplate,
  resolveProfile,
  type SyncResult,
  syncCommand,
  type ToolProbe,
  writeAgentSettings,
} from "../index.js";
import { MemoryFiles, SHIPPED_MODELS, shippedMethod } from "../testing/memory-files.js";

/** A machine without any AI tool: init targets the four tools. */
const noTools: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

function context(files: MemoryFiles): CommandContext {
  return { files, tools: noTools, method: shippedMethod(), actor: "human", engineVersion: "1.0.0" };
}

const CONFIG = ".agentplugged/method.yaml";
const CLAUDE = ".claude/agents/iris.md";
const CODEX = ".codex/agents/iris.toml";
const ANTIGRAVITY = ".agents/agents/iris.md";
const GEMINI = ".gemini/agents/iris.md";
const CURSOR = ".cursor/agents/iris.md";
const KIMI = ".kimi-code/agents/iris.md";

async function installed(): Promise<MemoryFiles> {
  const files = new MemoryFiles();
  const result = await initCommand.run(context(files), { profile: resolveProfile("new-product") });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  return files;
}

async function sync(files: MemoryFiles): Promise<SyncResult> {
  const result = await syncCommand.run(context(files), {});
  if (!result.ok) {
    throw new Error(`sync failed: ${result.error.code} ${JSON.stringify(result.error.details)}`);
  }
  return result.value;
}

async function agent(files: MemoryFiles, input: CommandInput): Promise<AgentCommandResult> {
  const result = await agentCommand.run(context(files), input);
  if (!result.ok) {
    throw new Error(`agent failed: ${result.error.code} ${JSON.stringify(result.error.details)}`);
  }
  return result.value;
}

const text = (files: MemoryFiles, path: string) => files.files.get(path) ?? "";

/** The frontmatter of a Markdown file, without its `---` lines. */
function frontmatter(files: MemoryFiles, path: string): string {
  const content = text(files, path);
  return content.slice(4, content.indexOf("\n---\n", 4) + 1);
}

/** The `model` lines of a Codex agent. */
function codexModel(files: MemoryFiles): string[] {
  return text(files, CODEX)
    .split("\n")
    .filter((line) => /^model(?:_reasoning_effort)? = /.test(line));
}

const DESCRIPTION = "description: Product analyst who frames a new product.";
/** The tools of the engine Claude Code's sub-agent for Iris is not given. */
const DENIED = "disallowedTools: mcp__agentplugged__review, mcp__agentplugged__measure\n";
const KIMI_DENIED =
  "disallowedTools:\n  - mcp__agentplugged__review\n  - mcp__agentplugged__measure\n";

describe("the shipped model table", () => {
  it("is valid and holds the values verified on 2026-10-02", () => {
    expect(SHIPPED_MODELS).toContain("verified on 2026-10-02");
    const table = parseModelTable("models.yaml", SHIPPED_MODELS);
    if (table instanceof Error) throw table;
    expect(table["claude-code"]).toEqual({
      reasoning: { model: "opus", effort: "high" },
      code: { model: "sonnet" },
      fast: { model: "haiku" },
      multimodal: { model: "sonnet" },
    });
    // Codex and Cursor keep the model of the session by default.
    expect(table.codex).toEqual({
      reasoning: { model: "inherit" },
      code: { model: "inherit" },
      fast: { model: "inherit" },
      multimodal: { model: "inherit" },
    });
    expect(table.antigravity).toEqual({
      reasoning: { model: "pro" },
      code: { model: "flash" },
      fast: { model: "flash" },
      multimodal: { model: "pro" },
    });
    // The retired Gemini CLI has no table any more.
    expect(Object.hasOwn(table, "gemini-cli")).toBe(false);
    expect(table.cursor).toEqual({
      reasoning: { model: "inherit" },
      code: { model: "inherit" },
      fast: { model: "inherit" },
      multimodal: { model: "inherit" },
    });
  });

  it("is copied by init as a generated file, refreshed when edited, kept when taken", async () => {
    const files = await installed();
    const copy = `${GENERATED_HEADER_HASH}\n${SHIPPED_MODELS}`;
    expect(text(files, MODELS_PATH)).toBe(copy);

    // Run again: nothing to do.
    const again = await initCommand.run(context(files), {});
    expect(again.ok && again.value.entries.find((e) => e.path === MODELS_PATH)?.action).toBe(
      "unchanged",
    );

    // A generated copy edited by hand is refreshed.
    files.seed(MODELS_PATH, copy.replace("model: opus", "model: sonnet"));
    const refreshed = await initCommand.run(context(files), {});
    expect(
      refreshed.ok && refreshed.value.entries.find((e) => e.path === MODELS_PATH)?.action,
    ).toBe("updated");
    expect(text(files, MODELS_PATH)).toBe(copy);

    // A copy without the header is the creator's: kept by init, and used by sync.
    files.seed(MODELS_PATH, SHIPPED_MODELS.replace("model: opus", "model: sonnet"));
    await initCommand.run(context(files), {});
    expect(text(files, MODELS_PATH)).not.toContain(GENERATED_HEADER_HASH);
    await sync(files);
    expect(frontmatter(files, CLAUDE)).toContain("\nmodel: sonnet\neffort: high\n");
  });

  it("is read from the shipped method while the copy carries the header", async () => {
    const files = await installed();
    // A hand edit with the header kept: init would wipe it, so sync ignores it too.
    const copy = text(files, MODELS_PATH);
    files.seed(MODELS_PATH, copy.replace("model: opus", "model: sonnet"));
    await sync(files);
    expect(frontmatter(files, CLAUDE)).toContain("\nmodel: opus\neffort: high\n");

    // A stale copy from an older engine (another value, header kept): the shipped table wins.
    files.seed(MODELS_PATH, copy.replace("model: pro", "model: pro-old"));
    await sync(files);
    expect(frontmatter(files, ANTIGRAVITY)).toContain("\nmodel: pro\n");
  });

  it("is read from the shipped method while the product has no copy", async () => {
    const files = await installed();
    files.files.delete(MODELS_PATH);
    await sync(files);
    expect(frontmatter(files, CLAUDE)).toContain("\nmodel: opus\neffort: high\n");
  });

  it("refuses an invalid copy before writing anything", async () => {
    const files = await installed();
    files.seed(MODELS_PATH, SHIPPED_MODELS.replace("model: haiku", 'model: ""'));
    const before = files.writes.length;
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("METHOD_CONFIG_INVALID");
      expect(result.error.details).toMatchObject({
        path: MODELS_PATH,
        field: "claude-code.fast.model",
      });
    }
    expect(files.writes.length).toBe(before);
  });
});

describe("sync: model of each agent", () => {
  it("writes the model of Iris's tier (reasoning) in each tool, with no fallback by default", async () => {
    const files = await installed();
    const result = await sync(files);
    expect(frontmatter(files, CLAUDE)).toBe(
      `name: iris\n${DESCRIPTION}\nmodel: opus\neffort: high\n${DENIED}`,
    );
    // Codex and Cursor name no model by default: a free account refuses a named one.
    expect(codexModel(files)).toEqual([]);
    expect(frontmatter(files, ANTIGRAVITY)).toBe(`name: iris\n${DESCRIPTION}\nmodel: pro\n`);
    expect(frontmatter(files, CURSOR)).toBe(`name: iris\n${DESCRIPTION}\nmodel: inherit\n`);
    // Nothing is written for the retired Gemini CLI.
    expect(files.files.has(GEMINI)).toBe(false);

    // Kimi's agent files take no model: its cell is always a fallback, whatever the table says.
    expect(frontmatter(files, KIMI)).toBe(`name: iris\n${DESCRIPTION}\n${KIMI_DENIED}`);
    expect(result.fallbacks.filter((f) => f.capability === "model").map((f) => f.client)).toEqual([
      "kimi",
    ]);
    expect(result.preferredTools).toEqual([]);
  });

  it("follows the tier chosen with agent edit --tier, at the next sync", async () => {
    const files = await installed();
    await sync(files);
    const edited = await agent(files, { action: "edit", id: "iris", tier: "fast" });
    expect(edited).toMatchObject({
      action: "edit",
      origin: "shipped",
      paths: [CONFIG],
      created: false,
      settings: { status: "updated", model_tier: "fast" },
    });
    expect(text(files, CONFIG)).toContain("\n  settings:\n    iris:\n      model_tier: fast\n");
    // No customisation is created by the settings.
    expect(files.files.has(".agentplugged/overrides/agents/iris.yaml")).toBe(false);

    await sync(files);
    expect(frontmatter(files, CLAUDE)).toBe(`name: iris\n${DESCRIPTION}\nmodel: haiku\n${DENIED}`);
    expect(codexModel(files)).toEqual([]);
    expect(frontmatter(files, ANTIGRAVITY)).toContain("\nmodel: flash\n");
    expect(frontmatter(files, CURSOR)).toContain("\nmodel: inherit\n");

    const same = await agent(files, { action: "edit", id: "iris", tier: "fast" });
    expect(same).toMatchObject({ settings: { status: "unchanged", model_tier: "fast" } });
  });

  it("uses the creator's models of method.yaml over the table, field by field", async () => {
    const files = await installed();
    files.seed(
      CONFIG,
      `${text(files, CONFIG)}models:\n  codex:\n    code:\n      model: gpt-6.2-sol\n      effort: medium\n`,
    );
    await agent(files, { action: "edit", id: "iris", tier: "code" });
    await sync(files);
    // A named model is written only because the creator chose it.
    expect(codexModel(files)).toEqual([
      'model = "gpt-6.2-sol"',
      'model_reasoning_effort = "medium"',
    ]);
    expect(frontmatter(files, CLAUDE)).toContain("\nmodel: sonnet\n");
  });

  it("refuses an empty model in method.yaml", async () => {
    const files = await installed();
    files.seed(CONFIG, `${text(files, CONFIG)}models:\n  codex:\n    code:\n      model: ""\n`);
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("METHOD_CONFIG_INVALID");
      expect(result.error.details.field).toBe("models.codex.code.model");
    }
  });

  it("keeps inherit, without effort, and reports the fallback of the tool", async () => {
    const files = await installed();
    files.seed(
      CONFIG,
      `${text(files, CONFIG)}models:\n  codex:\n    reasoning:\n      model: inherit\n  claude-code:\n    reasoning:\n      model: inherit\n`,
    );
    const result = await sync(files);
    expect(codexModel(files)).toEqual([]);
    expect(frontmatter(files, CLAUDE)).toBe(
      `name: iris\n${DESCRIPTION}\nmodel: inherit\n${DENIED}`,
    );
    expect(result.fallbacks.filter((f) => f.capability === "model").map((f) => f.client)).toEqual([
      "claude-code",
      "kimi",
    ]);
    const constitution = files.reference();
    expect(constitution).toContain(`- Claude Code, model: ${MODEL_INHERIT_REASON}`);
    // Codex and Cursor run on the session's model by design: not a fallback.
    expect(constitution).not.toContain("- Codex, model: ");
    expect(constitution).not.toContain("- Cursor, model: ");
  });

  it("still reads a Gemini CLI table of an older method.yaml, says so and writes nothing for it", async () => {
    const files = await installed();
    const tiers = ["reasoning", "code", "fast", "multimodal"]
      .map((tier) => `    ${tier}:\n      model: gemini-3-pro\n`)
      .join("");
    files.seed(CONFIG, `${text(files, CONFIG)}models:\n  gemini-cli:\n${tiers}`);
    const result = await sync(files);
    expect(result.fallbacks.filter((f) => f.capability === "model").map((f) => f.client)).toEqual([
      "kimi",
    ]);
    expect(result.warnings).toContainEqual({ kind: "gemini_legacy", path: ".gemini" });
    expect(files.files.has(GEMINI)).toBe(false);
    expect(files.reference()).not.toContain("Gemini CLI, model: ");
    expect(files.reference()).not.toContain("model: the model table");
  });

  it("drops the table's effort with effort: none", async () => {
    const files = await installed();
    files.seed(
      CONFIG,
      `${text(files, CONFIG)}models:\n  claude-code:\n    reasoning:\n      model: haiku\n      effort: none\n  codex:\n    reasoning:\n      model: gpt-6-astra\n      effort: none\n`,
    );
    await sync(files);
    expect(frontmatter(files, CLAUDE)).toBe(`name: iris\n${DESCRIPTION}\nmodel: haiku\n${DENIED}`);
    expect(codexModel(files)).toEqual(['model = "gpt-6-astra"']);
  });

  it("refuses an effort the tool does not know", async () => {
    const files = await installed();
    files.seed(
      CONFIG,
      `${text(files, CONFIG)}models:\n  claude-code:\n    reasoning:\n      effort: ultra\n`,
    );
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details.field).toBe("models.claude-code.reasoning.effort");
  });

  it("writes the same model fallbacks in the constitution when init runs again", async () => {
    const files = await installed();
    const base = text(files, CONFIG);
    const gemini = ["reasoning", "code", "fast", "multimodal"]
      .map((tier) => `    ${tier}:\n      model: gemini-3-pro\n`)
      .join("");
    files.seed(CONFIG, `${base}models:\n  gemini-cli:\n${gemini}`);
    expect((await initCommand.run(context(files), {})).ok).toBe(true);
    expect(files.reference()).not.toContain("- Gemini CLI, model: ");

    files.seed(CONFIG, `${base}models:\n  claude-code:\n    fast:\n      model: inherit\n`);
    expect((await initCommand.run(context(files), {})).ok).toBe(true);
    const constitution = files.reference();
    expect(constitution).toContain(`- Claude Code, model: ${MODEL_INHERIT_REASON}`);
    expect(constitution).not.toContain("Gemini CLI");
    // sync agrees: nothing to rewrite.
    const result = await sync(files);
    expect(result.entries.find((e) => e.path === "AGENTS.md")?.action).toBe("unchanged");
  });

  it("warns about settings that name no installed agent, and ignores them", async () => {
    const files = await installed();
    await agent(files, { action: "create", kind: "skill", id: "pricing", description: "Prices." });
    files.seed(
      CONFIG,
      text(files, CONFIG).replace(
        "\n  inactive:",
        "\n  settings:\n    irsi:\n      tool: codex\n    pricing:\n      model_tier: fast\n    iris:\n      tool: codex\n  inactive:",
      ),
    );
    const result = await sync(files);
    expect(result.warnings).toEqual([
      { kind: "unknown_setting", path: CONFIG, id: "irsi" },
      { kind: "unknown_setting", path: CONFIG, id: "pricing" },
    ]);
    expect(result.preferredTools.map((entry) => entry.id)).toEqual(["iris"]);
  });

  it("takes the tier of the customisation, and the one of method.yaml over it", async () => {
    const files = await installed();
    const override = ".agentplugged/overrides/agents/iris.yaml";
    files.seed(override, "model_tier: code\n");
    await sync(files);
    expect(frontmatter(files, CLAUDE)).toContain("\nmodel: sonnet\n");

    await agent(files, { action: "edit", id: "iris", tier: "fast" });
    await sync(files);
    expect(frontmatter(files, CLAUDE)).toContain("\nmodel: haiku\n");

    files.seed(override, "model_tier: huge\n");
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("OVERRIDE_INVALID");
      expect(result.error.details.field).toBe("model_tier");
    }
  });

  it("refuses an unknown tier in method.yaml", async () => {
    const files = await installed();
    files.seed(
      CONFIG,
      text(files, CONFIG).replace(
        "\n  inactive:",
        "\n  settings:\n    iris:\n      model_tier: huge\n  inactive:",
      ),
    );
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("METHOD_CONFIG_INVALID");
      expect(result.error.details.field).toBe("agents.settings.iris.model_tier");
    }
  });
});

describe("sync: preferred tool", () => {
  it("ends the description with the preferred tool, and still generates the agent everywhere", async () => {
    const files = await installed();
    await agent(files, { action: "edit", id: "iris", tool: "codex" });
    expect(text(files, CONFIG)).toContain("\n    iris:\n      tool: codex\n");
    const result = await sync(files);
    expect(result.preferredTools).toEqual([
      { id: "iris", name: "Iris", tool: "codex", targeted: true },
    ]);
    // Quoted in YAML: the sentence holds ": ".
    const described =
      'description: "Product analyst who frames a new product. Preferred tool: Codex."';
    for (const path of [CLAUDE, ANTIGRAVITY, CURSOR]) {
      expect(frontmatter(files, path), path).toContain(`\n${described}\n`);
    }
    expect(text(files, CODEX)).toContain(
      '\ndescription = "Product analyst who frames a new product. Preferred tool: Codex."\n',
    );
    for (const path of [".claude/skills/iris/SKILL.md", ".agents/skills/iris/SKILL.md"]) {
      expect(text(files, path), path).toContain(`\n${described}\n`);
      expect(text(files, path), path).toContain("\n  model_tier: reasoning\n");
    }
  });

  it("records a tool outside the list, and sync warns about it", async () => {
    const files = await installed();
    files.seed(
      CONFIG,
      text(files, CONFIG).replace(
        /tools:\n(?: {2}- .*\n)+/,
        "tools:\n  - claude-code\n  - codex\n",
      ),
    );
    const edited = await agent(files, { action: "edit", id: "iris", tool: "cursor" });
    expect(edited).toMatchObject({ settings: { status: "updated", tool: "cursor" } });
    const result = await sync(files);
    expect(result.preferredTools).toEqual([
      { id: "iris", name: "Iris", tool: "cursor", targeted: false },
    ]);
    expect(files.files.has(CLAUDE)).toBe(true);
    expect(files.files.has(CODEX)).toBe(true);
    expect(frontmatter(files, CLAUDE)).toContain("Preferred tool: Cursor.");
  });

  it("leaves the sentence out, and warns, when the description would exceed 1024 characters", async () => {
    const files = await installed();
    const skill = ".agentplugged/agents/iris/SKILL.md";
    const long = "x".repeat(1010);
    files.seed(skill, text(files, skill).replace(/description: .*\n/, `description: ${long}\n`));
    await agent(files, { action: "edit", id: "iris", tool: "codex" });
    const result = await sync(files);
    expect(result.warnings).toEqual([{ kind: "description_too_long", path: skill, id: "iris" }]);
    expect(result.preferredTools.map((entry) => entry.tool)).toEqual(["codex"]);
    expect(frontmatter(files, CLAUDE)).toContain(`\ndescription: ${long}\n`);
    expect(text(files, ".claude/skills/iris/SKILL.md")).not.toContain("Preferred tool");
  });

  it("keeps the tier when only --tool is given, and the tool when only --tier is", async () => {
    const files = await installed();
    await agent(files, { action: "edit", id: "iris", tier: "code" });
    const tool = await agent(files, { action: "edit", id: "iris", tool: "codex" });
    expect(tool).toMatchObject({ settings: { model_tier: "code", tool: "codex" } });
    const tier = await agent(files, { action: "edit", id: "iris", tier: "fast" });
    expect(tier).toMatchObject({ settings: { model_tier: "fast", tool: "codex" } });
    expect(text(files, CONFIG)).toContain(
      "\n    iris:\n      model_tier: fast\n      tool: codex\n",
    );
  });

  it("removes the settings with --tier default and --tool none", async () => {
    const files = await installed();
    const original = text(files, CONFIG);
    await agent(files, { action: "edit", id: "iris", tier: "fast", tool: "codex" });
    const removed = await agent(files, {
      action: "edit",
      id: "iris",
      tier: "default",
      tool: "none",
    });
    expect(removed).toMatchObject({ settings: { status: "updated" } });
    if (removed.action === "edit") expect(removed.settings).toEqual({ status: "updated" });
    expect(text(files, CONFIG)).toBe(original);
    await sync(files);
    expect(frontmatter(files, CLAUDE)).toBe(
      `name: iris\n${DESCRIPTION}\nmodel: opus\neffort: high\n${DENIED}`,
    );
  });
});

describe("agent edit --tier/--tool", () => {
  async function refused(files: MemoryFiles, input: CommandInput, code: string) {
    const before = files.snapshot();
    const writes = files.writes.length;
    const result = await agentCommand.run(context(files), input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
    expect(files.writes.length).toBe(writes);
    expect(files.snapshot()).toEqual(before);
    return result;
  }

  it("refuses an unknown tier or tool, and writes nothing", async () => {
    const files = await installed();
    await refused(files, { action: "edit", id: "iris", tier: "" }, "INVALID_ARGUMENTS");
    const tier = await refused(
      files,
      { action: "edit", id: "iris", tier: "huge" },
      "INVALID_ARGUMENTS",
    );
    if (!tier.ok) {
      expect(tier.error.details).toMatchObject({
        option: "tier",
        value: "huge",
        values: "reasoning, code, fast, multimodal, default",
      });
    }
    await refused(files, { action: "edit", id: "iris", tool: "zed" }, "INVALID_ARGUMENTS");
    await refused(files, { action: "edit", id: "ghost", tier: "huge" }, "INVALID_ARGUMENTS");
  });

  it("refuses --tier and --tool outside edit, on a skill and on an unknown id", async () => {
    const files = await installed();
    await refused(files, { action: "enable", id: "iris", tier: "fast" }, "INVALID_ARGUMENTS");
    await agent(files, { action: "create", kind: "skill", id: "pricing", description: "Prices." });
    await refused(files, { action: "edit", id: "pricing", tier: "fast" }, "INVALID_ARGUMENTS");
    await refused(files, { action: "edit", id: "ghost", tool: "codex" }, "AGENT_NOT_FOUND");
  });

  it("works on the creator's own agents", async () => {
    const files = await installed();
    await agent(files, {
      action: "create",
      id: "scout",
      title: "Market Scout",
      description: "Scouts markets.",
      domain: "product",
      phase: "framing",
    });
    const edited = await agent(files, { action: "edit", id: "scout", tier: "multimodal" });
    expect(edited).toMatchObject({ origin: "creator", settings: { model_tier: "multimodal" } });
    await sync(files);
    expect(frontmatter(files, ".agents/agents/scout.md")).toContain("\nmodel: pro\n");
    expect(frontmatter(files, ".cursor/agents/scout.md")).toContain("\nmodel: inherit\n");
  });

  it("keeps comments and CRLF line endings of method.yaml", () => {
    // Untouched lines stay byte for byte: no padding in `[...]`, no refolding of a long line.
    const ids = Array.from({ length: 12 }, (_, i) => `agent-number-${i}`).join(", ");
    const text = `# mine\r\nformat_version: 2\r\nengine_version: 1.0.0\r\nagents:\r\n  # who is on\r\n  enabled: [stella]\r\n  disabled: [${ids}]\r\n`;
    const written = writeAgentSettings(text, "iris", { model_tier: "code", tool: "codex" });
    if (typeof written !== "string") throw written;
    expect(written).toBe(
      `${text}  settings:\r\n    iris:\r\n      model_tier: code\r\n      tool: codex\r\n`,
    );
    expect(writeAgentSettings(written, "iris", {})).toBe(text);
  });

  it("shows the tier in the customisation template", async () => {
    const files = await installed();
    await agent(files, { action: "edit", id: "iris" });
    expect(text(files, ".agentplugged/overrides/agents/iris.yaml")).toContain(
      "\n# model_tier: reasoning\n",
    );
    expect(renderOverrideTemplate("iris", parseIris(), "fast")).toContain("\n# model_tier: fast\n");
  });
});

function parseIris() {
  return {
    name: "Iris",
    title: "Product Analyst",
    principles: [],
    persistent_facts: [],
    activation_steps_prepend: [],
    activation_steps_append: [],
    menu: [],
  };
}

describe("Kimi in the model table", () => {
  it("keeps the model of the session for every tier, in the shipped table and in an older copy", () => {
    const inherit = {
      reasoning: { model: "inherit" },
      code: { model: "inherit" },
      fast: { model: "inherit" },
      multimodal: { model: "inherit" },
    };
    const shipped = parseModelTable("models.yaml", SHIPPED_MODELS);
    if (shipped instanceof Error) throw shipped;
    expect(shipped.kimi).toEqual(inherit);
    // A copy taken before Kimi was supported has no `kimi` entry: it still reads, as `inherit`.
    const before = SHIPPED_MODELS.slice(0, SHIPPED_MODELS.indexOf("\n# Kimi"));
    const older = parseModelTable("models.yaml", before);
    if (older instanceof Error) throw older;
    expect(older.kimi).toEqual(inherit);
  });

  it("syncs a product whose own table copy predates Kimi", async () => {
    const files = await installed();
    files.seed(MODELS_PATH, SHIPPED_MODELS.slice(0, SHIPPED_MODELS.indexOf("\n# Kimi")));
    const result = await sync(files);
    expect(result.tools).toContain("kimi");
    expect(text(files, KIMI)).not.toMatch(/^model:/m);
  });

  it("refuses a model asked for Kimi in method.yaml: its agent files take none", async () => {
    const files = await installed();
    files.seed(CONFIG, `${text(files, CONFIG)}models:\n  kimi:\n    code:\n      model: kimi-k2\n`);
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("METHOD_CONFIG_INVALID");
  });
});
