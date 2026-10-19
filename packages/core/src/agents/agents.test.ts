import { AgentDefinitionSchema } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  type AgentCommandResult,
  activeDefinitions,
  agentCommand,
  type CommandContext,
  type CommandInput,
  GENERATED_HEADER,
  initCommand,
  mergeAgent,
  parseOverride,
  profileCommand,
  readDefinitions,
  renderOverrideTemplate,
  resolveProfile,
  type SyncResult,
  syncCommand,
  type ToolProbe,
  writeAgentLists,
  writeProfile,
} from "../index.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";

/** A machine without any AI tool: init targets the four tools. */
const noTools: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

function context(files: MemoryFiles): CommandContext {
  return {
    files,
    tools: noTools,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
  };
}

const CONFIG = ".agentplugged/method.yaml";
const OVERRIDE = ".agentplugged/overrides/agents/iris.yaml";
const IRIS_SKILL = ".claude/skills/iris/SKILL.md";

async function installed(preset: Parameters<typeof resolveProfile>[0] = "new-product") {
  const files = new MemoryFiles();
  const result = await initCommand.run(context(files), { profile: resolveProfile(preset) });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  return files;
}

async function agent(files: MemoryFiles, input: CommandInput) {
  return agentCommand.run(context(files), input);
}

async function agentOk(files: MemoryFiles, input: CommandInput): Promise<AgentCommandResult> {
  const result = await agent(files, input);
  if (!result.ok) {
    throw new Error(`agent failed: ${result.error.code} ${JSON.stringify(result.error.details)}`);
  }
  return result.value;
}

async function sync(files: MemoryFiles): Promise<SyncResult> {
  const result = await syncCommand.run(context(files), {});
  if (!result.ok) {
    throw new Error(`sync failed: ${result.error.code} ${JSON.stringify(result.error.details)}`);
  }
  return result.value;
}

async function failure(files: MemoryFiles, input: CommandInput) {
  const before = files.writes.length;
  const result = await agent(files, input);
  expect(result.ok).toBe(false);
  expect(files.writes.length).toBe(before);
  if (result.ok) throw new Error("expected a failure");
  return result.error;
}

const SCOUT = {
  action: "create",
  id: "scout",
  title: "Market Scout",
  description: "Scouts the market for a new product.",
  domain: "product",
  phase: "framing",
};

const SCOUT_FILES = [
  ".agentplugged/agents/scout/SKILL.md",
  ".agentplugged/agents/scout/agent.yaml",
];

describe("agent create", () => {
  it("creates a valid agent from the commented template, generated everywhere by sync", async () => {
    const files = await installed();
    const created = await agentOk(files, SCOUT);
    expect(created).toEqual({ action: "create", kind: "agent", id: "scout", paths: SCOUT_FILES });

    const skill = files.files.get(SCOUT_FILES[0] ?? "") ?? "";
    expect(skill).toMatch(/^---\nname: scout\ndescription: "Scouts the market/);
    expect(skill).toContain("\n  domain: product\n  phase: framing\n");
    for (const heading of ["## Overview", "## What Scout produces", "## How Scout works"]) {
      expect(skill).toContain(`\n${heading}\n`);
    }
    const yaml = files.files.get(SCOUT_FILES[1] ?? "") ?? "";
    expect(yaml).toContain('\nname: "Scout"\ntitle: "Market Scout"\n');
    expect(yaml).toContain("\nprinciples: []\n");
    expect(yaml).toContain("\npersistent_facts: []\n");
    expect(yaml).toContain("\nmenu:\n  - code: EX\n");
    expect(yaml).toMatch(/\n {4}prompt: "/);

    const definitions = await readDefinitions(files, ".agentplugged/agents", "agent");
    expect(Array.isArray(definitions)).toBe(true);

    await sync(files);
    for (const path of [
      ".claude/skills/scout/SKILL.md",
      ".claude/agents/scout.md",
      ".agents/skills/scout/SKILL.md",
      ".codex/agents/scout.toml",
      ".agents/agents/scout.md",
      ".cursor/agents/scout.md",
    ]) {
      expect(files.files.has(path), path).toBe(true);
    }
    expect(files.files.get(".claude/skills/scout/SKILL.md")).toContain(
      `${GENERATED_HEADER}\n# Scout, Market Scout\n`,
    );
  });

  it("keeps the icon and role given", async () => {
    const files = await installed();
    await agentOk(files, { ...SCOUT, icon: "🧭", role: "Finds markets." });
    const yaml = files.files.get(SCOUT_FILES[1] ?? "") ?? "";
    expect(yaml).toContain('\nicon: "🧭"\n');
    expect(yaml).toContain('\nrole: "Finds markets."\n');
  });

  it("creates a skill with its SKILL.md only", async () => {
    const files = await installed();
    const created = await agentOk(files, {
      action: "create",
      kind: "skill",
      id: "pricing",
      description: "Sets the price.",
    });
    expect(created).toEqual({
      action: "create",
      kind: "skill",
      id: "pricing",
      paths: [".agentplugged/skills/pricing/SKILL.md"],
    });
    expect([...files.files.keys()].filter((p) => p.includes("/pricing/"))).toEqual([
      ".agentplugged/skills/pricing/SKILL.md",
    ]);
    await sync(files);
    expect(files.files.has(".claude/skills/pricing/SKILL.md")).toBe(true);
  });

  it.each([
    ["a shipped agent", "iris"],
    ["a catalog agent", "stella"],
    ["a developer of the catalog", "jade"],
  ])("refuses %s with AGENT_EXISTS and writes nothing", async (_name, id) => {
    const files = await installed();
    const error = await failure(files, { action: "create", id });
    expect(error.code).toBe("AGENT_EXISTS");
    expect(error.details).toEqual({ id });
  });

  it("refuses an id already used by the creator, agent or skill", async () => {
    const files = await installed();
    await agentOk(files, SCOUT);
    expect((await failure(files, { ...SCOUT, kind: "skill" })).code).toBe("AGENT_EXISTS");
    await agentOk(files, { action: "create", kind: "skill", id: "pricing", description: "d" });
    expect((await failure(files, { ...SCOUT, id: "pricing" })).code).toBe("AGENT_EXISTS");
  });

  it.each([
    ["no id", { ...SCOUT, id: undefined }, "error.agent.id_required", {}],
    ["an invalid id", { ...SCOUT, id: "Scout" }, "error.agent.invalid_id", { id: "Scout" }],
    ["an agent id starting with a digit", { ...SCOUT, id: "2d" }, "error.agent.invalid_id", {}],
    [
      "an invalid skill id",
      { action: "create", kind: "skill", id: "-x", description: "d" },
      "error.agent.invalid_skill_id",
      {},
    ],
    ["no title", { ...SCOUT, title: undefined }, "error.agent.required", { option: "title" }],
    [
      "a blank description",
      { ...SCOUT, description: " " },
      "error.agent.required",
      { option: "description" },
    ],
    ["no domain", { ...SCOUT, domain: undefined }, "error.agent.required", { option: "domain" }],
    [
      "an unknown domain",
      { ...SCOUT, domain: "legal" },
      "error.agent.invalid_choice",
      { option: "domain", value: "legal" },
    ],
    [
      "an unknown phase",
      { ...SCOUT, phase: "dreaming" },
      "error.agent.invalid_choice",
      { option: "phase", value: "dreaming" },
    ],
    [
      "an icon over 8 characters",
      { ...SCOUT, icon: "far too long" },
      "error.agent.too_long",
      { option: "icon", max: 8 },
    ],
    [
      "a name over 40 characters",
      { ...SCOUT, name: "n".repeat(41) },
      "error.agent.too_long",
      { option: "name", max: 40 },
    ],
    ["an unknown kind", { ...SCOUT, kind: "robot" }, "error.agent.unknown_kind", { kind: "robot" }],
    [
      "agent options for a skill",
      { ...SCOUT, kind: "skill", id: "pricing", icon: "x" },
      "error.agent.skill_options",
      { options: "--title, --icon, --domain, --phase" },
    ],
  ])(
    "refuses %s with INVALID_ARGUMENTS and its own message",
    async (_name, input, key, details) => {
      const files = await installed();
      const error = await failure(files, input);
      expect(error.code).toBe("INVALID_ARGUMENTS");
      expect(error.message_key).toBe(key);
      expect(error.details).toMatchObject(details);
    },
  );

  it("uses the display name given", async () => {
    const files = await installed();
    await agentOk(files, { ...SCOUT, id: "lena", name: "Léna" });
    const yaml = files.files.get(".agentplugged/agents/lena/agent.yaml") ?? "";
    expect(yaml).toContain('\nname: "Léna"\n');
    expect(files.files.get(".agentplugged/agents/lena/SKILL.md")).toContain(
      "<!-- Who Léna is, and when the creator calls Léna.",
    );
  });

  it("asks for init first", async () => {
    const files = new MemoryFiles();
    expect((await failure(files, SCOUT)).code).toBe("METHOD_NOT_INSTALLED");
  });
});

describe("agent edit", () => {
  it("creates the commented customisation of a shipped agent once, and never opens an editor", async () => {
    const files = await installed();
    const first = await agentOk(files, { action: "edit", id: "iris" });
    expect(first).toEqual({
      action: "edit",
      kind: "agent",
      id: "iris",
      origin: "shipped",
      paths: [OVERRIDE],
      created: true,
    });
    const template = files.files.get(OVERRIDE) ?? "";
    for (const field of [
      "icon",
      "role",
      "identity",
      "communication_style",
      "principles",
      "persistent_facts",
      "activation_steps_prepend",
      "activation_steps_append",
      "menu",
      "voice",
    ]) {
      expect(template).toContain(`\n# ${field}:`);
    }
    expect(template).toContain("Merge rules");
    expect(template).toContain("\n# icon: 🔎\n");
    expect(template).not.toMatch(/^(name|title):/m);
    // Only comments: an empty customisation, and sync renders Iris as before.
    expect(parseOverride(OVERRIDE, template)).toEqual({});

    files.seed(OVERRIDE, `${template}icon: "🧭"\n`);
    const second = await agentOk(files, { action: "edit", id: "iris" });
    expect(second).toMatchObject({ paths: [OVERRIDE], created: false });
    expect(files.files.get(OVERRIDE)).toBe(`${template}icon: "🧭"\n`);
  });

  it("shows the agent's own voice in the template, or a default one, ready to uncomment", () => {
    const base = AgentDefinitionSchema.parse({ name: "Iris", title: "Analyst" });
    const voice = { tone: "Warm and curious", pace: "Unhurried", register: "Plain" };
    /** The commented `voice:` block of a template, uncommented. */
    const voiceBlock = (template: string) => {
      const lines = template.split("\n");
      const start = lines.indexOf("# voice:");
      return lines
        .slice(start, start + 4)
        .map((line) => line.replace(/^# /, ""))
        .join("\n");
    };

    const own = voiceBlock(renderOverrideTemplate("iris", { ...base, voice }));
    expect(parseOverride(OVERRIDE, own)).toEqual({ voice });

    const fallback = voiceBlock(renderOverrideTemplate("iris", base));
    expect(parseOverride(OVERRIDE, fallback)).toEqual({
      voice: { tone: "Warm and steady", pace: "Unhurried", register: "Plain, friendly" },
    });
  });

  it("validates the creator's own files and gives their paths", async () => {
    const files = await installed();
    await agentOk(files, SCOUT);
    expect(await agentOk(files, { action: "edit", id: "scout" })).toEqual({
      action: "edit",
      kind: "agent",
      id: "scout",
      origin: "creator",
      paths: SCOUT_FILES,
      created: false,
    });
    files.seed(SCOUT_FILES[1] ?? "", "name: Scout\n");
    const error = await failure(files, { action: "edit", id: "scout" });
    expect(error.code).toBe("AGENT_DEFINITION_INVALID");
    expect(error.details).toMatchObject({ path: SCOUT_FILES[1], field: "title" });
  });

  it("reports an invalid customisation", async () => {
    const files = await installed();
    files.seed(OVERRIDE, "title: X\n");
    const error = await failure(files, { action: "edit", id: "iris" });
    expect(error.code).toBe("OVERRIDE_INVALID");
    expect(error.details).toMatchObject({
      path: OVERRIDE,
      field: "title",
      reason_key: "reason.notCustomisable",
    });
  });

  it("does not know an id without files", async () => {
    const files = await installed();
    expect((await failure(files, { action: "edit", id: "stella" })).code).toBe("AGENT_NOT_FOUND");
  });

  it("refuses a shipped agent missing from .agentplugged/agents/ without writing", async () => {
    const files = await installed();
    files.removeDir(".agentplugged/agents/iris");
    expect((await failure(files, { action: "edit", id: "iris" })).code).toBe("AGENT_NOT_FOUND");
    expect(files.files.has(OVERRIDE)).toBe(false);
  });

  it("customises a shipped skill in overrides/skills, and gives it no model tier nor tool", async () => {
    const method = shippedMethod({
      "skills/brainstorm/SKILL.md": "---\nname: brainstorm\ndescription: Ideas.\n---\n# B\n",
    });
    const files = new MemoryFiles();
    const ctx = { ...context(files), method };
    expect((await initCommand.run(ctx, {})).ok).toBe(true);
    const result = await agentCommand.run(ctx, { action: "edit", id: "brainstorm" });
    expect(result.ok && result.value).toMatchObject({
      origin: "shipped",
      kind: "skill",
      paths: [".agentplugged/overrides/skills/brainstorm.yaml"],
      created: true,
    });
    const settings = await agentCommand.run(ctx, {
      action: "edit",
      id: "brainstorm",
      tier: "fast",
    });
    expect(settings.ok).toBe(false);
    if (settings.ok) return;
    expect(settings.error.message_key).toBe("error.agent.skill_settings");
  });
});

describe("customisation of a shipped agent", () => {
  const CUSTOM = `icon: "🧭"
principles:
  - Ask for evidence.
menu:
  - code: fp
    description: Frame the problem, our way
    prompt: Frame it our way.
  - code: NW
    description: New item
    prompt: Do something new.
`;

  it("is merged at render time, then survives init and is never applied twice", async () => {
    const files = await installed();
    await agentOk(files, { action: "edit", id: "iris" });
    files.seed(OVERRIDE, `${files.files.get(OVERRIDE)}${CUSTOM}`);
    await sync(files);

    const skill = files.files.get(IRIS_SKILL) ?? "";
    expect(skill).toContain("\n# 🧭 Iris, Product Analyst\n");
    expect(skill).toContain("### Principles\n\n- Problem first.\n- Ask for evidence.\n");
    expect(skill).toContain(
      "| 1 | fp | Frame the problem, our way | Prompt: Frame it our way. |\n| 2 | BR | Brainstorm | Prompt: Brainstorm ideas. |\n| 3 | NW | New item | Prompt: Do something new. |\n",
    );
    expect(files.files.get(".codex/agents/iris.toml")).toContain("# 🧭 Iris");
    // The source is never changed.
    expect(files.files.get(".agentplugged/agents/iris/agent.yaml")).toBe(SHIPPED_IRIS_AGENT);
    const overrideBefore = files.files.get(OVERRIDE);

    // An update: Iris refreshed by init, the customisation left alone.
    files.seed(".agentplugged/agents/iris/agent.yaml", "name: Iris\ntitle: Old\n");
    files.writes.length = 0;
    const again = await initCommand.run(context(files), {});
    expect(again.ok).toBe(true);
    expect(files.files.get(".agentplugged/agents/iris/agent.yaml")).toBe(SHIPPED_IRIS_AGENT);
    expect(files.files.get(OVERRIDE)).toBe(overrideBefore);
    expect(files.writes.some((path) => path.includes("/overrides/"))).toBe(false);

    const resync = await sync(files);
    expect(resync.entries.find((entry) => entry.path === IRIS_SKILL)?.action).toBe("unchanged");
    expect((files.files.get(IRIS_SKILL) ?? "").split("- Ask for evidence.").length).toBe(2);
  });

  it.each([
    ["name", "name: X\n", "name"],
    ["title", "title: X\n", "title"],
    ["an unknown field", "mood: happy\n", "mood"],
    [
      "a menu item calling an unknown skill",
      "menu:\n  - code: X\n    description: d\n    skill: nope\n",
      "menu.0.skill",
    ],
    ["broken YAML", "icon: [\n", "(root)"],
  ])("stops sync on %s before any write", async (_name, yaml, field) => {
    const files = await installed();
    files.seed(OVERRIDE, yaml);
    files.writes.length = 0;
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("OVERRIDE_INVALID");
    expect(result.error.details).toMatchObject({ path: OVERRIDE, field });
    expect(files.writes).toEqual([]);
  });

  it("stops sync on a customisation without agent", async () => {
    const files = await installed();
    const ghost = ".agentplugged/overrides/agents/ghost.yaml";
    files.seed(ghost, "icon: x\n");
    files.writes.length = 0;
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("OVERRIDE_INVALID");
    expect(result.error.message_key).toBe("error.override_orphan");
    expect(result.error.details).toMatchObject({ path: ghost, field: "(root)", id: "ghost" });
    expect(files.writes).toEqual([]);
  });

  it("stops sync on a customisation of the creator's own agent", async () => {
    const files = await installed();
    await agentOk(files, SCOUT);
    const path = ".agentplugged/overrides/agents/scout.yaml";
    files.seed(path, "icon: x\n");
    files.writes.length = 0;
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("OVERRIDE_INVALID");
    expect(result.error.message_key).toBe("error.override_own_agent");
    expect(result.error.details).toMatchObject({ path, id: "scout" });
    expect(files.writes).toEqual([]);
  });

  it("ignores other files of the folder", async () => {
    const files = await installed();
    files.seed(".agentplugged/overrides/agents/.gitkeep", "");
    files.seed(".agentplugged/overrides/agents/notes.txt", "x");
    await sync(files);
  });
});

describe("mergeAgent", () => {
  const base = AgentDefinitionSchema.parse({
    name: "Iris",
    title: "Analyst",
    icon: "🔎",
    role: "Base role.",
    principles: ["a"],
    persistent_facts: ["f"],
    activation_steps_prepend: ["p"],
    activation_steps_append: ["q"],
    menu: [
      { code: "A", description: "a", prompt: "a" },
      { code: "B", description: "b", prompt: "b" },
    ],
  });

  it("replaces scalars, replaces menu items in place, appends new codes and lists", () => {
    expect(
      mergeAgent(base, {
        role: "New role.",
        principles: ["b"],
        persistent_facts: ["g"],
        activation_steps_prepend: ["p2"],
        activation_steps_append: ["q2"],
        menu: [
          { code: "C", description: "c", prompt: "c" },
          { code: "a", description: "a2", skill: "x" },
        ],
      }),
    ).toEqual({
      ...base,
      role: "New role.",
      principles: ["a", "b"],
      persistent_facts: ["f", "g"],
      activation_steps_prepend: ["p", "p2"],
      activation_steps_append: ["q", "q2"],
      menu: [
        { code: "a", description: "a2", skill: "x" },
        { code: "B", description: "b", prompt: "b" },
        { code: "C", description: "c", prompt: "c" },
      ],
    });
  });

  it("leaves the agent as is for an empty customisation", () => {
    expect(mergeAgent(base, {})).toEqual(base);
  });

  it("replaces the voice whole, and keeps it when the customisation has none", () => {
    const voiced = { ...base, voice: { tone: "Warm", pace: "Slow", register: "Plain" } };
    const voice = { tone: "Crisp", pace: "Brisk", register: "Formal" };
    expect(mergeAgent(voiced, { voice }).voice).toEqual(voice);
    expect(mergeAgent(voiced, { role: "r" }).voice).toEqual(voiced.voice);
    expect(mergeAgent(base, { voice }).voice).toEqual(voice);
  });
});

describe("agent enable and disable", () => {
  it("disables a shipped agent: listed, then its files are deleted by sync", async () => {
    const files = await installed();
    await sync(files);
    expect(files.files.has(IRIS_SKILL)).toBe(true);

    expect(await agentOk(files, { action: "disable", id: "iris" })).toEqual({
      action: "disable",
      id: "iris",
      status: "updated",
    });
    expect(files.files.get(CONFIG)).toContain("\n  disabled:\n    - iris\n");
    const result = await sync(files);
    for (const path of [IRIS_SKILL, ".claude/agents/iris.md", ".codex/agents/iris.toml"]) {
      expect(result.entries.find((entry) => entry.path === path)?.action, path).toBe("deleted");
      expect(files.files.has(path)).toBe(false);
    }

    // Again: nothing to write.
    files.writes.length = 0;
    expect(await agentOk(files, { action: "disable", id: "iris" })).toMatchObject({
      status: "unchanged",
    });
    expect(files.writes).toEqual([]);

    // Enabled again: back to following the profile, in neither list.
    await agentOk(files, { action: "enable", id: "iris" });
    const config = files.files.get(CONFIG) ?? "";
    expect(config).not.toContain("disabled");
    expect(config).not.toContain("enabled");
    await sync(files);
    expect(files.files.has(IRIS_SKILL)).toBe(true);

    // Active through the profile and not disabled: enabling changes nothing.
    files.writes.length = 0;
    expect(await agentOk(files, { action: "enable", id: "iris" })).toMatchObject({
      status: "unchanged",
    });
    expect(files.writes).toEqual([]);
  });

  it("does not enable a catalog agent without files", async () => {
    const files = await installed("maintenance");
    const error = await failure(files, { action: "enable", id: "stella" });
    expect(error.code).toBe("AGENT_NOT_FOUND");
  });

  it("disables an enabled agent the profile leaves out by pinning it in disabled", async () => {
    const files = await installed("maintenance");
    files.seed(".agentplugged/agents/stella/SKILL.md", SHIPPED_LEA);
    files.seed(".agentplugged/agents/stella/agent.yaml", "name: Stella\ntitle: UX Designer\n");
    // Inactive by profile, not enabled: already off.
    expect(await agentOk(files, { action: "disable", id: "stella" })).toMatchObject({
      status: "unchanged",
    });
    await agentOk(files, { action: "enable", id: "stella" });
    await agentOk(files, { action: "disable", id: "stella" });
    const config = files.files.get(CONFIG) ?? "";
    expect(config).toContain("\n  disabled:\n    - stella\n");
    expect(config).not.toContain("enabled");
  });

  it("enables a skill the creator disabled: back to neutral", async () => {
    const files = await installed();
    await agentOk(files, { action: "create", kind: "skill", id: "pricing", description: "d" });
    await agentOk(files, { action: "disable", id: "pricing" });
    expect(files.files.get(CONFIG)).toContain("\n  disabled:\n    - pricing\n");
    await agentOk(files, { action: "enable", id: "pricing" });
    expect(files.files.get(CONFIG)).not.toContain("pricing");
    await sync(files);
    expect(files.files.has(".agents/skills/pricing/SKILL.md")).toBe(true);
  });

  it("enables an agent left out by the maintenance profile", async () => {
    const files = await installed("maintenance");
    files.seed(".agentplugged/agents/stella/SKILL.md", SHIPPED_LEA);
    files.seed(".agentplugged/agents/stella/agent.yaml", "name: Stella\ntitle: UX Designer\n");
    await sync(files);
    expect(files.files.has(".claude/skills/stella/SKILL.md")).toBe(false);

    await agentOk(files, { action: "enable", id: "stella" });
    const config = files.files.get(CONFIG) ?? "";
    expect(config).toContain("\n  enabled:\n    - stella\n");
    expect(config).toMatch(/\n {2}inactive:\n(?: {4}- .+\n)* {4}- stella\n/);
    await sync(files);
    expect(files.files.has(".claude/skills/stella/SKILL.md")).toBe(true);
  });

  it("turns a developer's specialty on with the developer", async () => {
    const files = await installed();
    files.seed(
      ".agentplugged/agents/jade/SKILL.md",
      SHIPPED_IRIS.replace("name: iris", "name: jade").replace("domain: product", "domain: code"),
    );
    files.seed(".agentplugged/agents/jade/agent.yaml", "name: Jade\ntitle: Mobile Developer\n");
    await sync(files);
    expect(files.files.has(".claude/skills/jade/SKILL.md")).toBe(false);
    expect(parse(files.files.get(CONFIG) ?? "").profile.specialties).toEqual([
      "backend",
      "frontend",
    ]);

    expect(await agentOk(files, { action: "enable", id: "jade" })).toMatchObject({
      status: "updated",
    });
    const config = parse(files.files.get(CONFIG) ?? "");
    expect(config.profile.specialties).toEqual(["backend", "frontend", "mobile"]);
    // The profile now says it: Jade is no longer an exception to it.
    expect(config.agents.inactive).not.toContain("jade");
    expect(config.agents.enabled).toBeUndefined();
    await sync(files);
    expect(files.files.has(".claude/skills/jade/SKILL.md")).toBe(true);

    // Again: nothing to write.
    files.writes.length = 0;
    expect(await agentOk(files, { action: "enable", id: "jade" })).toMatchObject({
      status: "unchanged",
    });
    expect(files.writes).toEqual([]);

    // Disabling Jade leaves the specialty alone (another developer may carry it).
    await agentOk(files, { action: "disable", id: "jade" });
    const disabled = parse(files.files.get(CONFIG) ?? "");
    expect(disabled.profile.specialties).toContain("mobile");
    expect(disabled.agents.disabled).toEqual(["jade"]);
    await agentOk(files, { action: "enable", id: "jade" });
    expect(parse(files.files.get(CONFIG) ?? "").agents?.disabled).toBeUndefined();
  });

  it("drops the exception an older enable left once the specialty comes on", async () => {
    const files = await installed();
    files.seed(
      ".agentplugged/agents/jade/SKILL.md",
      SHIPPED_IRIS.replace("name: iris", "name: jade").replace("domain: product", "domain: code"),
    );
    files.seed(".agentplugged/agents/jade/agent.yaml", "name: Jade\ntitle: Mobile Developer\n");
    const text = writeAgentLists(files.files.get(CONFIG) ?? "", ["jade"], []);
    if (typeof text !== "string") throw new Error("lists");
    files.seed(CONFIG, text);
    await agentOk(files, { action: "enable", id: "jade" });
    const config = parse(files.files.get(CONFIG) ?? "");
    expect(config.profile.specialties).toContain("mobile");
    expect(config.agents?.enabled).toBeUndefined();
  });

  it("leaves the profile alone when the code domain is off, or for another agent", async () => {
    const files = await installed("launch-only");
    files.seed(
      ".agentplugged/agents/jade/SKILL.md",
      SHIPPED_IRIS.replace("name: iris", "name: jade").replace("domain: product", "domain: code"),
    );
    files.seed(".agentplugged/agents/jade/agent.yaml", "name: Jade\ntitle: Mobile Developer\n");
    await agentOk(files, { action: "enable", id: "jade" });
    const config = parse(files.files.get(CONFIG) ?? "");
    expect(config.profile.specialties).toEqual([]);
    expect(config.agents.enabled).toEqual(["jade"]);
  });

  it("disables a creator's agent, and a skill, which is no longer generated", async () => {
    const files = await installed();
    await agentOk(files, SCOUT);
    await agentOk(files, { action: "create", kind: "skill", id: "pricing", description: "d" });
    await sync(files);
    expect(files.files.has(".agents/skills/pricing/SKILL.md")).toBe(true);

    await agentOk(files, { action: "disable", id: "scout" });
    await agentOk(files, { action: "disable", id: "pricing" });
    await sync(files);
    expect(files.files.has(".claude/skills/scout/SKILL.md")).toBe(false);
    expect(files.files.has(".claude/skills/pricing/SKILL.md")).toBe(false);
    expect(files.files.has(".agents/skills/pricing/SKILL.md")).toBe(false);
    // The creator's sources are never deleted.
    expect(files.files.has(SCOUT_FILES[0] ?? "")).toBe(true);
    expect(files.files.has(".agentplugged/skills/pricing/SKILL.md")).toBe(true);
  });

  it("keeps comments and line endings of method.yaml", async () => {
    const files = await installed();
    const crlf = `# My product\r\n${(files.files.get(CONFIG) ?? "").replace(/\n/g, "\r\n")}`;
    files.seed(CONFIG, crlf);
    await agentOk(files, { action: "disable", id: "iris" });
    const written = files.files.get(CONFIG) ?? "";
    expect(written.startsWith("# My product\r\n")).toBe(true);
    expect(written.replace(/\r\n/g, "")).not.toContain("\n");
    expect(written).toContain("\r\n  disabled:\r\n    - iris\r\n");

    // The last entry removed: the list goes, and `agents` keeps `inactive`.
    await agentOk(files, { action: "enable", id: "iris" });
    const back = files.files.get(CONFIG) ?? "";
    expect(back).not.toContain("disabled");
    expect(back).toContain("\r\n  inactive:\r\n    - jade\r\n");
  });

  it("writes an agents section into a method.yaml without profile, and removes it", async () => {
    const base = "format_version: 2\nengine_version: 1.0.0\n";
    const files = new MemoryFiles({
      [CONFIG]: base,
      ".agentplugged/agents/iris/SKILL.md": SHIPPED_IRIS,
      ".agentplugged/agents/iris/agent.yaml": SHIPPED_IRIS_AGENT,
    });
    await agentOk(files, { action: "disable", id: "iris" });
    expect(files.files.get(CONFIG)).toBe(`${base}agents:\n  disabled:\n    - iris\n`);
    await agentOk(files, { action: "enable", id: "iris" });
    expect(files.files.get(CONFIG)).toBe(base);
    files.seed(
      CONFIG,
      "format_version: 2\nengine_version: 1.0.0\nagents:\n  enabled:\n    - iris\n",
    );
    await agentOk(files, { action: "disable", id: "iris" });
    expect(files.files.get(CONFIG)).toBe(
      "format_version: 2\nengine_version: 1.0.0\nagents:\n  disabled:\n    - iris\n",
    );
  });

  it("refuses an unknown id with AGENT_NOT_FOUND", async () => {
    const files = await installed();
    for (const action of ["enable", "disable"]) {
      const error = await failure(files, { action, id: "ghost" });
      expect(error.code).toBe("AGENT_NOT_FOUND");
      expect(error.details).toEqual({ id: "ghost" });
    }
  });

  it("refuses an unknown action and a missing id", async () => {
    const files = await installed();
    expect((await failure(files, { action: "delete", id: "iris" })).code).toBe("INVALID_ARGUMENTS");
    expect((await failure(files, { action: "enable" })).code).toBe("INVALID_ARGUMENTS");
  });

  it("refuses a method.yaml listing an id in both lists", async () => {
    const files = await installed();
    files.seed(
      CONFIG,
      `${files.files.get(CONFIG)}`.replace(
        "agents:\n",
        "agents:\n  enabled: [iris]\n  disabled: [iris]\n",
      ),
    );
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("METHOD_CONFIG_INVALID");
      expect(result.error.details.field).toBe("agents.disabled.0");
    }
  });
});

describe("init and the creator's files", () => {
  it("never creates, changes or deletes anything in overrides/ or the creator's folders", async () => {
    const files = await installed();
    await agentOk(files, SCOUT);
    await agentOk(files, { action: "create", kind: "skill", id: "pricing", description: "d" });
    files.seed(OVERRIDE, "icon: x\n");
    files.seed(".agentplugged/overrides/notes.md", "mine");
    const mine = (path: string) =>
      path.startsWith(".agentplugged/overrides/") ||
      path.startsWith(".agentplugged/agents/scout/") ||
      path.startsWith(".agentplugged/skills/pricing/");
    const before = [...files.files].filter(([path]) => mine(path));

    files.writes.length = 0;
    files.removals.length = 0;
    const result = await initCommand.run(context(files), {});
    expect(result.ok).toBe(true);
    expect(files.writes.filter(mine)).toEqual([]);
    expect(files.removals).toEqual([]);
    expect([...files.files].filter(([path]) => mine(path))).toEqual(before);
  });
});

/** A Stella definition, standing for a catalog agent shipped later. */
const SHIPPED_LEA = `---
name: stella
description: UX designer.
metadata:
  domain: ux
  phase: design
  risk: low
  model_tier: multimodal
---
# Stella
`;

describe("disabled skills and menus", () => {
  const MENU = "menu:\n  - code: PR\n    description: Price it\n    skill: pricing\n";

  async function withPricing() {
    const files = await installed();
    await agentOk(files, SCOUT);
    await agentOk(files, { action: "create", kind: "skill", id: "pricing", description: "d" });
    return files;
  }

  function disableInConfig(files: MemoryFiles, id: string) {
    const content = writeAgentLists(files.files.get(CONFIG) ?? "", [], [id]);
    if (typeof content !== "string") throw new Error(content.code);
    files.seed(CONFIG, content);
  }

  it("refuses to disable a skill an active agent's menu calls, naming the agent", async () => {
    const files = await withPricing();
    files.seed(SCOUT_FILES[1] ?? "", `name: Scout\ntitle: Market Scout\n${MENU}`);
    const error = await failure(files, { action: "disable", id: "pricing" });
    expect(error.code).toBe("INVALID_ARGUMENTS");
    expect(error.message_key).toBe("error.agent.skill_in_use");
    expect(error.details).toEqual({ id: "pricing", agent: "scout" });

    // Once the agent is disabled, the skill can be too.
    await agentOk(files, { action: "disable", id: "scout" });
    await agentOk(files, { action: "disable", id: "pricing" });
  });

  it("refuses it too when the call comes from a customisation", async () => {
    const files = await withPricing();
    files.seed(OVERRIDE, MENU);
    const error = await failure(files, { action: "disable", id: "pricing" });
    expect(error.details).toEqual({ id: "pricing", agent: "iris" });
  });

  it("stops sync on an agent's menu calling a disabled skill", async () => {
    const files = await withPricing();
    files.seed(SCOUT_FILES[1] ?? "", `name: Scout\ntitle: Market Scout\n${MENU}`);
    disableInConfig(files, "pricing");
    files.writes.length = 0;
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("AGENT_DEFINITION_INVALID");
    expect(result.error.message_key).toBe("error.menu_skill_disabled");
    expect(result.error.details).toMatchObject({
      path: SCOUT_FILES[1],
      field: "menu.0.skill",
      skill: "pricing",
    });
    expect(files.writes).toEqual([]);
  });

  it("stops sync on a customisation calling a disabled skill", async () => {
    const files = await withPricing();
    files.seed(OVERRIDE, MENU);
    disableInConfig(files, "pricing");
    files.writes.length = 0;
    const result = await syncCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("OVERRIDE_INVALID");
    expect(result.error.message_key).toBe("error.menu_skill_disabled");
    expect(result.error.details).toMatchObject({ path: OVERRIDE, field: "menu.0.skill" });
    expect(files.writes).toEqual([]);
  });

  it("accepts a disabled skill called only by an inactive agent, or replaced by a customisation", async () => {
    const files = await withPricing();
    files.seed(
      SCOUT_FILES[1] ?? "",
      `name: Scout\ntitle: Market Scout\n${MENU.replace("PR", "FP")}`,
    );
    disableInConfig(files, "pricing");
    const config = files.files.get(CONFIG) ?? "";
    files.seed(
      CONFIG,
      config.replace("  disabled:\n    - pricing\n", "  disabled:\n    - pricing\n    - scout\n"),
    );
    await sync(files);
  });
});

describe("writeAgentLists", () => {
  it("writes into a flow-style agents section", () => {
    const text = "format_version: 2\nengine_version: 1.0.0\nagents: { inactive: [alex] }\n";
    const written = writeAgentLists(text, ["alex"], ["iris"]);
    expect(typeof written).toBe("string");
    expect(parse(written as string)).toEqual({
      format_version: 2,
      engine_version: "1.0.0",
      agents: { inactive: ["alex"], enabled: ["alex"], disabled: ["iris"] },
    });
    expect(parse(writeAgentLists(written as string, [], []) as string)).toEqual({
      format_version: 2,
      engine_version: "1.0.0",
      agents: { inactive: ["alex"] },
    });
  });
});

describe("activeDefinitions", () => {
  const def = (kind: "agent" | "skill", name: string) =>
    ({ kind, name }) as unknown as Parameters<typeof activeDefinitions>[0][number];
  const all = [
    def("agent", "iris"),
    def("agent", "stella"),
    def("agent", "scout"),
    def("skill", "s"),
  ];
  const base = { format_version: 2, engine_version: "1.0.0" } as const;
  const names = (config: Parameters<typeof activeDefinitions>[1]) =>
    activeDefinitions(all, config).map((d) => d.name);

  it("keeps everything without lists", () => {
    expect(names(base)).toEqual(["iris", "stella", "scout", "s"]);
  });

  it("applies inactive, then enabled, then disabled", () => {
    expect(names({ ...base, agents: { inactive: ["stella"] } })).toEqual(["iris", "scout", "s"]);
    expect(names({ ...base, agents: { inactive: ["stella"], enabled: ["stella"] } })).toEqual([
      "iris",
      "stella",
      "scout",
      "s",
    ]);
    expect(names({ ...base, agents: { disabled: ["scout", "s", "iris"] } })).toEqual(["stella"]);
  });
});

describe("profile and the creator's lists", () => {
  it("keeps agents.enabled and agents.disabled when the profile changes", async () => {
    const files = await installed("maintenance");
    files.seed(".agentplugged/agents/stella/SKILL.md", SHIPPED_LEA);
    files.seed(".agentplugged/agents/stella/agent.yaml", "name: Stella\ntitle: UX Designer\n");
    await agentOk(files, { action: "enable", id: "stella" });
    await agentOk(files, { action: "create", kind: "skill", id: "pricing", description: "d" });
    await agentOk(files, { action: "disable", id: "pricing" });
    const changed = writeProfile(files.files.get(CONFIG) ?? "", resolveProfile("prototype"));
    expect(typeof changed).toBe("string");
    const result = await profileCommand.run(context(files), {
      profile: resolveProfile("prototype"),
    });
    expect(result.ok).toBe(true);
    const config = parse(files.files.get(CONFIG) ?? "");
    expect(config.profile.preset).toBe("prototype");
    expect(config.agents.enabled).toEqual(["stella"]);
    expect(config.agents.disabled).toEqual(["pricing"]);
    expect(parse(changed as string).agents.disabled).toEqual(["pricing"]);
  });
});
