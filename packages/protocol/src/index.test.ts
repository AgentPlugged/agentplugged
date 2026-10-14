import { describe, expect, it } from "vitest";
import {
  AgentsSchema,
  CursorCliConfigSchema,
  DOMAIN_IDS,
  ErrorPayloadSchema,
  ISSUE,
  issueName,
  MethodConfigSchema,
  PHASE_IDS,
  PROFILE_PRESET_IDS,
  ProfileSchema,
  packageName,
  SyncManifestSchema,
  TOOL_IDS,
} from "./index.js";

describe("protocol", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@agentplugged/protocol");
  });
});

describe("MethodConfigSchema", () => {
  it("accepts a minimal config", () => {
    const config = { format_version: 2, engine_version: "0.3.0-beta.1+build.5" };
    expect(MethodConfigSchema.parse(config)).toEqual(config);
  });

  it("rejects a format_version other than the literal 1", () => {
    const result = MethodConfigSchema.safeParse({ format_version: "x", engine_version: "1.0.0" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["format_version"]);
  });

  it.each(["1.0", "v1.0.0", "01.0.0", "1.0.0-", ""])("rejects engine_version %j", (version) => {
    const result = MethodConfigSchema.safeParse({ format_version: 2, engine_version: version });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["engine_version"]);
  });

  it("rejects missing fields", () => {
    const result = MethodConfigSchema.safeParse({ format_version: 2 });
    expect(result.error?.issues[0]?.path).toEqual(["engine_version"]);
  });

  it("rejects unknown keys (strict object)", () => {
    const result = MethodConfigSchema.safeParse({
      format_version: 2,
      engine_version: "1.0.0",
      extra: true,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
  });
});

describe("MethodConfigSchema: profile and agents", () => {
  const base = { format_version: 2, engine_version: "1.0.0" };
  const profile = {
    preset: "prototype",
    domains: ["product", "ux", "code"],
    phases: ["framing", "build"],
    specialties: ["backend", "frontend"],
  };

  it("accepts a config with a profile and inactive agents", () => {
    const config = { ...base, profile, agents: { inactive: ["alex", "jade"] } };
    expect(MethodConfigSchema.parse(config)).toEqual(config);
  });

  it("accepts a config without profile", () => {
    expect(MethodConfigSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a ceiling of stories at once", () => {
    const capped = { ...profile, max_parallel_stories: 3 };
    expect(ProfileSchema.parse(capped)).toEqual(capped);
  });

  it.each([
    ["no specialty while code is active", { ...profile, specialties: [] }],
    ["a specialty while code is inactive", { ...profile, domains: ["product"] }],
    ["a duplicate specialty", { ...profile, specialties: ["backend", "backend"] }],
  ])("rejects %s on profile.specialties", (_name, value) => {
    const result = ProfileSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["specialties"]);
    const nested = MethodConfigSchema.safeParse({ ...base, profile: value });
    expect(nested.error?.issues[0]?.path).toEqual(["profile", "specialties"]);
  });

  it.each([
    ["a language as specialty", { ...profile, specialties: ["ruby"] }, "specialties"],
    ["the count of format 1", { ...profile, developers: 2 }, undefined],
    ["a ceiling of 0", { ...profile, max_parallel_stories: 0 }, "max_parallel_stories"],
    ["a ceiling over 99", { ...profile, max_parallel_stories: 100 }, "max_parallel_stories"],
    ["a fractional ceiling", { ...profile, max_parallel_stories: 1.5 }, "max_parallel_stories"],
  ])("rejects %s", (_name, value, field) => {
    const result = ProfileSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (field) expect(result.error?.issues[0]?.path[0]).toBe(field);
  });

  it.each([
    ["an unknown preset", { ...profile, preset: "custom" }, "preset"],
    ["an unknown domain", { ...profile, domains: ["code", "legal"] }, "domains"],
    ["a duplicate phase", { ...profile, phases: ["build", "build"] }, "phases"],
    ["no phase", { ...profile, phases: [] }, "phases"],
    ["an unknown key", { ...profile, autonomy: 3 }, undefined],
  ])("rejects %s", (_name, value, field) => {
    const result = ProfileSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (field) expect(result.error?.issues[0]?.path[0]).toBe(field);
  });

  it("rejects an invalid agent identifier", () => {
    expect(AgentsSchema.safeParse({ inactive: ["Sam"] }).success).toBe(false);
    expect(AgentsSchema.safeParse({ inactive: [], extra: 1 }).success).toBe(false);
  });

  it("accepts the creator's enabled and disabled lists, agents or skills", () => {
    const agents = { inactive: ["stella"], enabled: ["stella"], disabled: ["iris", "2d-pricing"] };
    expect(AgentsSchema.parse(agents)).toEqual(agents);
    expect(AgentsSchema.parse({ enabled: ["scout"] })).toEqual({ enabled: ["scout"] });
  });

  it.each([
    ["an id in both lists", { enabled: ["iris"], disabled: ["iris"] }, ["disabled", 0]],
    ["a duplicate id", { disabled: ["iris", "iris"] }, ["disabled"]],
    ["an invalid id", { enabled: ["Scout"] }, ["enabled", 0]],
  ])("rejects %s", (_name, value, path) => {
    const result = AgentsSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(path);
  });

  it("lists stable identifiers", () => {
    expect(DOMAIN_IDS).toHaveLength(11);
    expect(PHASE_IDS).toEqual(["framing", "planning", "design", "build", "delivery", "launch"]);
    expect(PROFILE_PRESET_IDS).toEqual(["new-product", "maintenance", "launch-only", "prototype"]);
  });
});

describe("MethodConfigSchema: tools", () => {
  const base = { format_version: 2, engine_version: "1.0.0" };

  it("lists the four tool identifiers", () => {
    expect(TOOL_IDS).toEqual(["claude-code", "codex", "antigravity", "cursor"]);
  });

  it("accepts a list of known tools, and no list at all (older files)", () => {
    const config = { ...base, tools: ["codex", "cursor"] };
    expect(MethodConfigSchema.parse(config)).toEqual(config);
    expect(MethodConfigSchema.safeParse(base).success).toBe(true);
  });

  it.each([
    ["an unknown tool", ["vim"], ["tools", 0]],
    ["an empty list", [], ["tools"]],
    ["a duplicate tool", ["codex", "codex"], ["tools"]],
    ["a string", "codex", ["tools"]],
  ])("rejects %s", (_name, tools, path) => {
    const result = MethodConfigSchema.safeParse({ ...base, tools });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(path);
  });
});

describe("SyncManifestSchema", () => {
  it("accepts a manifest with or without Cursor rules", () => {
    const manifest = { format_version: 1, files: {}, permissions: [] };
    expect(SyncManifestSchema.safeParse(manifest).success).toBe(true);
    const cursor = { ...manifest, cursor_permissions: ["Write(.cursor/**)"] };
    expect(SyncManifestSchema.parse(cursor)).toEqual(cursor);
    const settings = {
      ...manifest,
      settings: { ".cursor/cli.json": { created: false, keys: ["permissions.deny"] } },
    };
    expect(SyncManifestSchema.parse(settings)).toEqual(settings);
  });
});

describe("CursorCliConfigSchema", () => {
  it("keeps unknown keys and checks allow and deny when present", () => {
    const config = { version: 1, editor: { vimMode: true }, permissions: { allow: ["Shell(ls)"] } };
    expect(CursorCliConfigSchema.parse(config)).toEqual(config);
    expect(CursorCliConfigSchema.safeParse({}).success).toBe(true);
    expect(CursorCliConfigSchema.safeParse({ permissions: { allow: "x" } }).success).toBe(false);
    expect(CursorCliConfigSchema.safeParse({ permissions: { deny: [1] } }).success).toBe(false);
    expect(CursorCliConfigSchema.safeParse([]).success).toBe(false);
  });
});

describe("ErrorPayloadSchema", () => {
  it("accepts a well-formed payload", () => {
    const payload = {
      code: "METHOD_CONFIG_INVALID",
      message_key: "error.method_config_invalid",
      details: { field: "format_version", line: 1 },
    };
    expect(ErrorPayloadSchema.parse(payload)).toEqual(payload);
  });

  it.each(["method_config_invalid", "Method", "A__B", "_A"])("rejects code %j", (code) => {
    expect(ErrorPayloadSchema.safeParse({ code, message_key: "k", details: {} }).success).toBe(
      false,
    );
  });
});

describe("ISSUE", () => {
  it("names the stable messages the schemas use", () => {
    const result = AgentsSchema.safeParse({ enabled: ["iris"], disabled: ["iris"] });
    expect(issueName(result.error?.issues[0]?.message)).toBe("alsoEnabled");
    expect(ISSUE.duplicateCode).toBe("duplicate code");
    expect(issueName("something else")).toBeUndefined();
  });
});
