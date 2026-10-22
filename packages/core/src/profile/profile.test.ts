import type { Profile } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  activeAgents,
  type CommandContext,
  createCommandRegistry,
  inactiveAgents,
  initCommand,
  PROFILE_PRESET_IDS,
  profileCommand,
  readProfile,
  resolveProfile,
  type ToolProbe,
  type WorkspaceFiles,
  writeProfile,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const CONFIG = ".agentplugged/method.yaml";

const noTools: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

function context(files: WorkspaceFiles): CommandContext {
  return { files, tools: noTools, method: shippedMethod(), actor: "human", engineVersion: "1.2.3" };
}

const BASE = "format_version: 2\nengine_version: 1.2.3\n";

describe("profiles", () => {
  it("resolves the four presets", () => {
    expect(PROFILE_PRESET_IDS.map((preset) => resolveProfile(preset))).toEqual([
      {
        preset: "new-product",
        domains: [
          "product",
          "ux",
          "architecture",
          "code",
          "quality",
          "security",
          "delivery",
          "docs",
          "creativity",
          "marketing",
          "sales",
        ],
        phases: ["framing", "planning", "design", "build", "delivery", "launch"],
        specialties: ["backend", "frontend"],
      },
      {
        preset: "maintenance",
        domains: ["code", "quality", "security", "delivery", "docs"],
        phases: ["design", "build", "delivery"],
        specialties: ["backend", "frontend"],
      },
      {
        preset: "launch-only",
        domains: ["product", "creativity", "marketing", "sales"],
        phases: ["framing", "launch"],
        specialties: [],
      },
      {
        preset: "prototype",
        domains: ["product", "ux", "code"],
        phases: ["framing", "build"],
        specialties: ["backend", "frontend"],
      },
    ]);
  });

  it("keeps everyone active for a new product but the mobile developer", () => {
    expect(inactiveAgents(resolveProfile("new-product"))).toEqual(["jade"]);
  });

  it("deactivates the right agents for maintenance", () => {
    const profile = resolveProfile("maintenance");
    expect(inactiveAgents(profile)).toEqual([
      "alex",
      "basile",
      "iris",
      "izzy",
      "jade",
      "julien",
      "lou",
      "maya",
      "milo",
      "stella",
    ]);
    expect(activeAgents(profile)).toEqual(expect.arrayContaining(["sam", "ethan", "hugo", "lina"]));
  });

  it("turns every specialty off and deactivates the developers when code is removed", () => {
    const profile = resolveProfile("new-product", {
      domains: ["product", "ux", "quality"],
    });
    expect(profile.specialties).toEqual([]);
    expect(inactiveAgents(profile)).toEqual(
      expect.arrayContaining(["sam", "ethan", "hugo", "lina", "jade"]),
    );
  });

  it("turns backend and frontend on when code is added to a preset without any", () => {
    expect(resolveProfile("launch-only", { domains: ["code"] }).specialties).toEqual([
      "backend",
      "frontend",
    ]);
  });

  it("activates the developers of the specialties chosen, in catalog order", () => {
    const profile = resolveProfile("new-product", {
      specialties: ["mobile", "backend", "mobile"],
      max_parallel_stories: 3,
    });
    expect(profile.specialties).toEqual(["backend", "mobile"]);
    expect(profile.max_parallel_stories).toBe(3);
    const active = activeAgents(profile);
    expect(active).toEqual(expect.arrayContaining(["sam", "ethan", "jade"]));
    expect(active).not.toContain("hugo");
    expect(inactiveAgents(profile)).toEqual(["hugo", "lina"]);
  });

  it("keeps the catalog order and drops duplicates", () => {
    const profile = resolveProfile("prototype", {
      domains: ["code", "product", "code"],
      phases: ["build", "framing"],
    });
    expect(profile.domains).toEqual(["product", "code"]);
    expect(profile.phases).toEqual(["framing", "build"]);
  });
});

describe("writeProfile", () => {
  it("adds the profile and inactive agents, keeping comments and other keys", () => {
    const text = `# tuned by hand\n${BASE}`;
    const out = writeProfile(text, resolveProfile("maintenance"));
    expect(typeof out).toBe("string");
    expect(out).toBe(
      [
        "# tuned by hand",
        "format_version: 2",
        "engine_version: 1.2.3",
        "profile:",
        "  preset: maintenance",
        "  domains:",
        "    - code",
        "    - quality",
        "    - security",
        "    - delivery",
        "    - docs",
        "  phases:",
        "    - design",
        "    - build",
        "    - delivery",
        "  specialties:",
        "    - backend",
        "    - frontend",
        "agents:",
        "  inactive:",
        "    - alex",
        "    - basile",
        "    - iris",
        "    - izzy",
        "    - jade",
        "    - julien",
        "    - lou",
        "    - maya",
        "    - milo",
        "    - stella",
        "",
      ].join("\n"),
    );
  });

  it("is stable when written twice, and keeps comments inside the profile", () => {
    const first = writeProfile(BASE, resolveProfile("prototype")) as string;
    expect(writeProfile(first, resolveProfile("prototype"))).toBe(first);
    const commented = first.replace("profile:\n", "profile: # mine\n");
    const changed = writeProfile(commented, resolveProfile("maintenance")) as string;
    expect(changed).toContain("profile:\n  # mine\n  preset: maintenance\n");
  });

  it("keeps CRLF line endings", () => {
    const out = writeProfile(BASE.replace(/\n/g, "\r\n"), resolveProfile("prototype")) as string;
    expect(
      out.split("\n").every((line, i, all) => i === all.length - 1 || line.endsWith("\r")),
    ).toBe(true);
  });

  it("rejects no specialty while code is active, on profile.specialties", () => {
    const out = writeProfile(BASE, resolveProfile("new-product", { specialties: [] }));
    expect(out).toMatchObject({
      code: "METHOD_CONFIG_INVALID",
      details: { field: "profile.specialties" },
    });
  });

  it("rejects a specialty without code on profile.specialties", () => {
    const out = writeProfile(BASE, resolveProfile("launch-only", { specialties: ["backend"] }));
    expect(out).toMatchObject({ details: { field: "profile.specialties" } });
  });

  it.each([0, 100, 1.5])("rejects a ceiling of %s stories at once", (max_parallel_stories) => {
    const out = writeProfile(BASE, resolveProfile("new-product", { max_parallel_stories }));
    expect(out).toMatchObject({ details: { field: "profile.max_parallel_stories" } });
  });

  it("writes the ceiling, and removes it when the profile has none", () => {
    const capped = writeProfile(
      BASE,
      resolveProfile("new-product", { max_parallel_stories: 2 }),
    ) as string;
    expect(capped).toContain("  max_parallel_stories: 2\n");
    expect(writeProfile(capped, resolveProfile("new-product"))).not.toContain(
      "max_parallel_stories",
    );
  });
});

describe("init with a profile", () => {
  async function init(files: MemoryFiles, profile?: Profile) {
    const result = await initCommand.run(context(files), profile ? { profile } : {});
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  }

  it("writes the profile with method.yaml", async () => {
    const files = new MemoryFiles();
    const result = await init(files, resolveProfile("maintenance"));
    expect(result.profile?.preset).toBe("maintenance");
    const yaml = files.files.get(CONFIG) ?? "";
    expect(yaml).toContain("preset: maintenance");
    expect(yaml).not.toContain("framing");
    expect(yaml).not.toContain("planning");
    expect(await readProfile(files)).toMatchObject({
      installed: true,
      profile: resolveProfile("maintenance"),
    });
  });

  it("adds a profile to a method.yaml without one, keeping its comment", async () => {
    const files = new MemoryFiles({ [CONFIG]: `# mine\n${BASE}` });
    const result = await init(files, resolveProfile("new-product"));
    const yaml = files.files.get(CONFIG) ?? "";
    expect(yaml.startsWith("# mine\n")).toBe(true);
    expect(yaml).toContain("inactive:\n    - jade\n");
    expect(result.entries.find((entry) => entry.path === CONFIG)?.action).toBe("updated");
  });

  it("never changes a recorded profile", async () => {
    const files = new MemoryFiles();
    await init(files, resolveProfile("prototype"));
    const before = files.files.get(CONFIG);
    files.writes.length = 0;
    const result = await init(files, resolveProfile("maintenance"));
    expect(files.files.get(CONFIG)).toBe(before);
    expect(files.writes.includes(CONFIG)).toBe(false);
    expect(result.profile?.preset).toBe("prototype");
  });

  it("rejects an invalid profile before writing anything", async () => {
    const files = new MemoryFiles();
    const result = await initCommand.run(context(files), {
      profile: { ...resolveProfile("prototype"), max_parallel_stories: 0 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details.field).toBe("profile.max_parallel_stories");
    expect(files.writes).toEqual([]);
  });

  it("reports an incoherent profile in method.yaml with its line", async () => {
    const files = new MemoryFiles({
      [CONFIG]: `${BASE}profile:\n  preset: prototype\n  domains: [product]\n  phases: [build]\n  specialties: [backend]\n`,
    });
    const result = await initCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details).toMatchObject({ field: "profile.specialties", line: 7 });
  });
});

describe("profile command", () => {
  it("is registered", () => {
    expect(createCommandRegistry().names()).toEqual([
      "init",
      "profile",
      "sync",
      "agent",
      "journal",
      "review",
      "key",
      "trust",
      "docs",
      "history",
      "next",
      "rules",
      "migrate",
      "deferred",
      "story",
      "ci",
      "tests",
      "trace",
      "usage",
      "publication",
      "doctor",
    ]);
  });

  it("changes only method.yaml when a domain is removed", async () => {
    const files = new MemoryFiles({ ".agentplugged/docs/prd.md": "prd" });
    await initCommand.run(context(files), { profile: resolveProfile("new-product") });
    files.writes.length = 0;
    const current = ((await readProfile(files)) as { profile: Profile }).profile;
    const profile = resolveProfile(current.preset, {
      domains: current.domains.filter((domain) => domain !== "docs"),
      phases: current.phases,
      specialties: current.specialties,
    });
    const result = await profileCommand.run(context(files), { profile });
    expect(result.ok && result.value.action).toBe("updated");
    expect(files.writes).toEqual([CONFIG]);
    expect(files.files.get(".agentplugged/docs/prd.md")).toBe("prd");
    expect(files.files.get(CONFIG)).toContain("inactive:\n    - jade\n    - zoe\n");

    files.writes.length = 0;
    const again = await profileCommand.run(context(files), { profile });
    expect(again.ok && again.value.action).toBe("unchanged");
    expect(files.writes).toEqual([]);
  });

  it("reads a missing method.yaml as not installed", async () => {
    expect(await readProfile(new MemoryFiles())).toEqual({ installed: false, profile: undefined });
    expect(await readProfile(new MemoryFiles({ [CONFIG]: BASE }))).toEqual({
      installed: true,
      profile: undefined,
    });
  });

  it("asks for init first", async () => {
    const result = await profileCommand.run(context(new MemoryFiles()), {
      profile: resolveProfile("prototype"),
    });
    expect(!result.ok && result.error.code).toBe("METHOD_NOT_INSTALLED");
  });

  it("requires a profile", async () => {
    const result = await profileCommand.run(context(new MemoryFiles({ [CONFIG]: BASE })), {});
    expect(!result.ok && result.error.code).toBe("INVALID_ARGUMENTS");
  });

  it("reports an unknown specialty on profile.specialties", async () => {
    const files = new MemoryFiles({ [CONFIG]: BASE });
    const result = await profileCommand.run(context(files), {
      profile: { ...resolveProfile("new-product"), specialties: ["ruby"] },
    });
    expect(!result.ok && result.error.toPayload()).toMatchObject({
      code: "METHOD_CONFIG_INVALID",
      details: { field: "profile.specialties.0" },
    });
    expect(files.writes).toEqual([]);
  });
});

describe("profile command: same values", () => {
  it("writes nothing when the profile equals the recorded one, whatever the layout", async () => {
    const files = new MemoryFiles({ [CONFIG]: BASE });
    await profileCommand.run(context(files), { profile: resolveProfile("prototype") });
    // Same values, written by hand in another layout.
    const text = (files.files.get(CONFIG) ?? "")
      .replace(/domains:\n( {4}- \w+\n)+/, "domains: [product, ux, code]\n")
      .replace(/phases:\n( {4}- \w+\n)+/, "phases: [framing, build]\n");
    files.files.set(CONFIG, text);
    files.writes.length = 0;
    const result = await profileCommand.run(context(files), {
      profile: resolveProfile("prototype"),
    });
    expect(result.ok && result.value.action).toBe("unchanged");
    expect(files.writes).toEqual([]);
    expect(files.files.get(CONFIG)).toBe(text);
  });
});

describe("method.yaml: agents.inactive", () => {
  const withProfile = writeProfile(BASE, resolveProfile("prototype")) as string;

  it.each([
    ["an unknown agent", `${BASE}agents:\n  inactive: [nobody]\n`, 4],
    ["a duplicate agent", `${BASE}agents:\n  inactive: [alex, alex]\n`, 4],
    ["a list that does not match the profile", withProfile.replace("    - chloe\n", ""), 17],
    ["a profile without the list", withProfile.slice(0, withProfile.indexOf("agents:")), undefined],
  ])("rejects %s", async (_name, yaml, line) => {
    const files = new MemoryFiles({ [CONFIG]: yaml });
    const result = await initCommand.run(context(files), {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("METHOD_CONFIG_INVALID");
    expect(result.error.details.field).toBe("agents.inactive");
    expect(result.error.details.line).toBe(line);
    expect(files.writes).toEqual([]);
  });

  it("accepts known agents without a profile", async () => {
    const files = new MemoryFiles({ [CONFIG]: `${BASE}agents:\n  inactive: [alex]\n` });
    expect((await initCommand.run(context(files), {})).ok).toBe(true);
  });
});
