import { toBase64url } from "@agentplugged/crypto";
import { ErrorCode, METHOD_EVENT_TYPES, MethodConfigSchema } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  type CommandContext,
  createCommandRegistry,
  MemoryKeyStore,
  MemoryStateStore,
  type MigrateResult,
} from "../index.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";
import { planRenameAgentsFiles, renameAgentsText } from "./rename-agents.js";

/**
 * The format step `rename-agents`: with the alias table, the only place of the
 * product that names the former agents, and these are its tests.
 */

const CONFIG = ".agentplugged/method.yaml";

/** `method.yaml` once migrated, as the tests read it. */
interface Migrated {
  readonly format_version?: number;
  readonly profile: {
    readonly developers?: number;
    readonly specialties: readonly string[];
    readonly max_parallel_stories?: number;
  };
  readonly agents: {
    readonly enabled: readonly string[];
    readonly disabled: readonly string[];
    readonly inactive: readonly string[];
    readonly settings: Readonly<Record<string, unknown>>;
  };
}
const ENGINE = "1.1.0";
const PRODUCT_ID = "01JZ4444444444444444444444";
const SEED = toBase64url(new Uint8Array(32).fill(5));

/** A shipped agent of the fixture method: a `SKILL.md` and an `agent.yaml`. */
function shippedAgent(id: string, extra: Record<string, string> = {}) {
  const skill = SHIPPED_IRIS.replace("name: iris", `name: ${id}`);
  const agent = SHIPPED_IRIS_AGENT.replace(
    "name: Iris",
    `name: ${id[0]?.toUpperCase()}${id.slice(1)}`,
  );
  return { [`agents/${id}/SKILL.md`]: skill, [`agents/${id}/agent.yaml`]: agent, ...extra };
}

/** The method of format 2 as the fixture ships it: a few of the renamed team. */
function method() {
  return shippedMethod({
    ...shippedAgent("maya"),
    ...shippedAgent("izzy"),
    ...shippedAgent("sam"),
    ...shippedAgent("ethan"),
  });
}

/** A product of format 1, with the former names everywhere. */
const FORMAT_1 = `# Réglages d'Ada : garder ce commentaire
format_version: 1
engine_version: 1.0.0
product_id: ${PRODUCT_ID}
profile:
  preset: new-product
  domains: [product, ux, architecture, code, quality, security, delivery, docs, creativity, marketing, sales]
  phases: [framing, planning, design, build, delivery, launch]
  developers: 3 # trois en parallèle
agents:
  inactive: []
  enabled: [muse]
  disabled: [lyra, rex]
  settings:
    marc:
      model_tier: fast
    sam:
      tool: codex
    nova:
      model_tier: reasoning
    rex:
      tool: cursor
    nova-2:
      tool: codex
`;

const FORMER_FILES = {
  ".agentplugged/agents/marc/SKILL.md": "former",
  ".agentplugged/agents/marc/agent.yaml": "former",
  ".agentplugged/agents/sam/SKILL.md": "former scrum master",
  ".agentplugged/agents/sam/agent.yaml": "former scrum master",
  ".agentplugged/agents/sam/references/old.md": "former annex",
  ".agentplugged/agents/nova/SKILL.md": "former",
  ".agentplugged/agents/rex/SKILL.md": "former",
  ".agentplugged/overrides/agents/marc.yaml": "icon: M # Ada\n",
  ".agentplugged/overrides/agents/sam.yaml": "icon: S\n",
  ".agentplugged/overrides/agents/nova.yaml": "icon: N\n",
  ".agentplugged/overrides/agents/orion.yaml": "icon: O\n",
  ".agentplugged/overrides/agents/rex.yaml": "icon: R\n",
  ".agentplugged/overrides/agents/nova-2.yaml": "icon: N2\n",
  ".agentplugged/overrides/agents/iris.yaml": "icon: I\n",
};

describe("rename-agents: method.yaml", () => {
  it("turns N developers into backend and frontend with a ceiling of N, keeping comments", () => {
    const { text, notes } = renameAgentsText(FORMAT_1);
    const config = parse(text) as Migrated;
    expect(text).toContain("# Réglages d'Ada : garder ce commentaire");
    expect(config.profile.developers).toBeUndefined();
    expect(config.profile.specialties).toEqual(["backend", "frontend"]);
    expect(config.profile.max_parallel_stories).toBe(3);
    expect(notes).toContainEqual({
      kind: "specialties",
      developers: 3,
      specialties: ["backend", "frontend"],
      max_parallel_stories: 3,
    });
    // Valid at format 2 once the engine sets the format.
    expect(MethodConfigSchema.safeParse({ ...config, format_version: 2 }).success).toBe(true);
  });

  it("turns no developer into no specialty and no ceiling", () => {
    const { text, notes } = renameAgentsText(
      FORMAT_1.replace(
        "domains: [product, ux, architecture, code,",
        "domains: [product, ux, architecture,",
      ).replace("developers: 3 # trois en parallèle", "developers: 0"),
    );
    const config = parse(text) as Migrated;
    expect(config.profile.specialties).toEqual([]);
    expect(config.profile.max_parallel_stories).toBeUndefined();
    expect(notes[0]).toEqual({
      kind: "specialties",
      developers: 0,
      specialties: [],
      max_parallel_stories: null,
    });
  });

  it.each(["three", "-2", "2.5", "null"])(
    "refuses a count of developers that format 1 never held (%s)",
    (count) => {
      expect(() =>
        renameAgentsText(
          FORMAT_1.replace("developers: 3 # trois en parallèle", `developers: ${count}`),
        ),
      ).toThrow("profile.developers");
    },
  );

  it("renames the ids of the lists and settings, the scrum master first", () => {
    const { text, notes } = renameAgentsText(FORMAT_1);
    const agents = (parse(text) as Migrated).agents;
    expect(agents.enabled).toEqual(["lou"]);
    expect(agents.disabled).toEqual(["julien"]);
    expect(Object.keys(agents.settings)).toEqual(["maya", "izzy", "sam", "ethan"]);
    expect(agents.settings.izzy).toEqual({ tool: "codex" });
    expect(agents.settings.sam).toEqual({ model_tier: "reasoning" });
    // The quick lane's settings go to the first backend developer still free.
    expect(agents.settings.ethan).toEqual({ tool: "cursor" });
    expect(notes).toContainEqual({ kind: "setting_moved", from: "sam", to: "izzy" });
    expect(notes).toContainEqual({ kind: "setting_moved", from: "nova", to: "sam" });
    expect(notes).toContainEqual({ kind: "setting_moved", from: "rex", to: "ethan" });
    expect(notes).toContainEqual({ kind: "setting_dropped", from: "nova-2" });
    expect(notes).toContainEqual({ kind: "list_dropped", from: "rex" });
    // The mobile developer waits for its specialty.
    expect(agents.inactive).toEqual(["jade"]);
  });
});

describe("rename-agents: files", () => {
  it("moves the customisations, retires the leftovers and replaces the former copies", async () => {
    const files = new MemoryFiles({ [CONFIG]: FORMAT_1, ...FORMER_FILES });
    const plan = await planRenameAgentsFiles(files, method());
    if (!("operations" in plan)) throw new Error(plan.code);
    const writes = new Map(
      plan.operations
        .filter((operation) => operation.action === "write")
        .map((operation) => [operation.path, operation.content]),
    );
    const removes = plan.operations
      .filter((operation) => operation.action === "remove")
      .map((operation) => operation.path);
    const overrides = ".agentplugged/overrides/agents";
    expect(writes.get(`${overrides}/maya.yaml`)).toBe("icon: M # Ada\n");
    expect(writes.get(`${overrides}/izzy.yaml`)).toBe("icon: S\n");
    expect(writes.get(`${overrides}/sam.yaml`)).toBe("icon: N\n");
    expect(writes.get(`${overrides}/ethan.yaml`)).toBe("icon: O\n");
    // Both backend developers taken: the quick lane's customisation is kept aside, unread.
    expect(writes.get(`${overrides}/retired/rex.yaml`)).toBe("icon: R\n");
    expect(writes.get(`${overrides}/retired/nova-2.yaml`)).toBe("icon: N2\n");
    expect(writes.has(`${overrides}/iris.yaml`)).toBe(false);
    expect(removes).toEqual(
      expect.arrayContaining([
        `${overrides}/marc.yaml`,
        `${overrides}/nova.yaml`,
        `${overrides}/rex.yaml`,
        ".agentplugged/agents/marc/SKILL.md",
        ".agentplugged/agents/nova/SKILL.md",
        ".agentplugged/agents/rex/SKILL.md",
        ".agentplugged/agents/sam/references/old.md",
      ]),
    );
    // `sam.yaml` is written again (Nova's), never removed; the method is copied again.
    expect(removes).not.toContain(`${overrides}/sam.yaml`);
    expect(writes.has(".agentplugged/agents/maya/SKILL.md")).toBe(true);
    expect(writes.has(".agentplugged/agents/sam/SKILL.md")).toBe(true);
    expect(plan.notes).toContainEqual({ kind: "override_moved", from: "marc", to: "maya" });
    expect(plan.notes).toContainEqual({
      kind: "override_retired",
      from: "rex",
      path: `${overrides}/retired/rex.yaml`,
    });
    expect(files.writes).toEqual([]);
  });

  it.each([
    [".agentplugged/agents/maya/SKILL.md", "maya"],
    [".agentplugged/skills/stella/SKILL.md", "stella"],
    [".agentplugged/agents/quick-lane/SKILL.md", "quick-lane"],
  ])(
    "stops on an agent or a skill of the creator's named like the new team (%s)",
    async (path, id) => {
      const files = new MemoryFiles({ [CONFIG]: FORMAT_1, [path]: "Ada's own" });
      const plan = await planRenameAgentsFiles(files, method());
      expect("code" in plan && plan.toPayload()).toMatchObject({
        code: ErrorCode.AGENT_ID_CONFLICT,
        details: { id },
      });
    },
  );

  it.each([
    ["after its writes, before its removals", "writes"],
    ["after its customisations only", "overrides"],
    ["after its first customisation", "first"],
  ])("runs again when a run stopped %s, without moving anything twice", async (_name, upTo) => {
    const files = new MemoryFiles({ [CONFIG]: FORMAT_1, ...FORMER_FILES });
    const first = await planRenameAgentsFiles(files, method());
    if (!("operations" in first)) throw new Error(first.code);
    for (const operation of first.operations) {
      if (operation.action !== "write") break;
      if (upTo === "overrides" && !operation.path.includes("/overrides/")) break;
      if (upTo === "first" && operation !== first.operations[0]) break;
      files.seed(operation.path, String(operation.content));
    }
    const again = await planRenameAgentsFiles(files, method());
    if (!("operations" in again)) throw new Error(`${again.code} ${JSON.stringify(again.details)}`);
    for (const operation of again.operations) {
      if (operation.action === "remove") files.remove(operation.path);
      else files.seed(operation.path, String(operation.content));
    }
    const overrides = ".agentplugged/overrides/agents";
    // Nova's customisation stays the backend developer's, the scrum master's goes to Izzy.
    expect(files.files.get(`${overrides}/sam.yaml`)).toBe("icon: N\n");
    expect(files.files.get(`${overrides}/izzy.yaml`)).toBe("icon: S\n");
    expect(files.files.get(`${overrides}/maya.yaml`)).toBe("icon: M # Ada\n");
    for (const id of ["marc", "nova", "orion", "rex", "nova-2"]) {
      expect(files.files.has(`${overrides}/${id}.yaml`), id).toBe(false);
    }
  });

  it("keeps aside a customisation without successor under a free name", async () => {
    const overrides = ".agentplugged/overrides/agents";
    const files = new MemoryFiles({
      [CONFIG]: FORMAT_1,
      [`${overrides}/nova-2.yaml`]: "icon: N2\n",
      [`${overrides}/retired/nova-2.yaml`]: "icon: kept by Ada\n",
    });
    const plan = await planRenameAgentsFiles(files, method());
    if (!("operations" in plan)) throw new Error(plan.code);
    expect(plan.notes).toContainEqual({
      kind: "override_retired",
      from: "nova-2",
      path: `${overrides}/retired/nova-2-2.yaml`,
    });
  });

  it("recognises the method's own copy left by a run stopped after its files", async () => {
    const shipped = method();
    const files = new MemoryFiles({
      [CONFIG]: FORMAT_1,
      ".agentplugged/agents/maya/SKILL.md": await shipped.readText("agents/maya/SKILL.md"),
    });
    const plan = await planRenameAgentsFiles(files, shipped);
    expect("operations" in plan).toBe(true);
  });
});

describe("migrate to format 2", () => {
  function setup(extra: Record<string, string> = {}) {
    const files = new MemoryFiles({ [CONFIG]: FORMAT_1, ...FORMER_FILES, ...extra });
    const keys = new MemoryKeyStore(SEED);
    let now = Date.UTC(2026, 9, 3, 12, 0, 0);
    const journal = new MemoryStateStore({ keys, now: () => (now += 1000) });
    const context: CommandContext = {
      files,
      tools: {
        which: async () => undefined,
        version: async () => undefined,
        extensions: async () => [],
      },
      method: method(),
      actor: "human",
      engineVersion: ENGINE,
      interactive: true,
      journal,
      keys,
    };
    const registry = createCommandRegistry();
    const run = (name: string, input: Record<string, unknown> = {}) =>
      registry.run(name, context, input);
    return { files, journal, run };
  }

  it("stops every other command with MIGRATION_REQUIRED, nothing written", async () => {
    const { files, run } = setup();
    const result = await run("sync");
    expect(!result.ok && result.error.code).toBe(ErrorCode.MIGRATION_REQUIRED);
    expect(files.writes).toEqual([]);
  });

  it("shows the plan with --check, then migrates: event, files, method.yaml", async () => {
    const { files, journal, run } = setup();
    const check = await run("migrate", { check: true });
    if (!check.ok) throw new Error(check.error.code);
    const planned = check.value as MigrateResult;
    expect(planned).toMatchObject({ status: "planned", from_format: 1, to_format: 2 });
    expect(planned.steps).toEqual(["rename-agents"]);
    expect(planned.notes).toContainEqual(expect.objectContaining({ kind: "specialties" }));
    expect(files.writes).toEqual([]);
    expect(journal.events).toEqual([]);

    const result = await run("migrate");
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value).toMatchObject({ status: "migrated", event: "written" });
    const config = parse(files.files.get(CONFIG) ?? "") as Migrated;
    expect(config.format_version).toBe(2);
    expect(config.profile.specialties).toEqual(["backend", "frontend"]);
    expect(files.files.get(".agentplugged/overrides/agents/maya.yaml")).toBe("icon: M # Ada\n");
    expect(files.files.has(".agentplugged/agents/marc/SKILL.md")).toBe(false);
    const events = journal.events.filter((event) => event.type === METHOD_EVENT_TYPES.migrated);
    expect(events.map((event) => event.payload)).toEqual([
      {
        from_format: 1,
        to_format: 2,
        from_engine: "1.0.0",
        to_engine: ENGINE,
        steps: ["rename-agents"],
      },
    ]);
    // `method.yaml` is written last.
    expect(files.writes.at(-1)).toBe(CONFIG);
  });

  it("stops on an agent of the creator's named like the new team, nothing written", async () => {
    const { files, journal, run } = setup({ ".agentplugged/agents/julien/SKILL.md": "Ada's" });
    const result = await run("migrate");
    expect(!result.ok && result.error.toPayload()).toMatchObject({
      code: ErrorCode.AGENT_ID_CONFLICT,
      details: { id: "julien", path: ".agentplugged/agents/julien/" },
    });
    expect(files.writes).toEqual([]);
    expect(journal.events).toEqual([]);
  });
});
