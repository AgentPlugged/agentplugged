import { describe, expect, it } from "vitest";
import {
  ClaudeSettingsSchema,
  ErrorCode,
  MethodConfigSchema,
  RULE_ACTIONS,
  RULE_VALUES,
  RulesSchema,
  SyncManifestSchema,
} from "./index.js";

const base = { format_version: 2, engine_version: "1.0.0" };

describe("rules of method.yaml", () => {
  it("names the nine actions and the three values, in a stable order", () => {
    expect(RULE_ACTIONS).toEqual([
      "read_files",
      "edit_code",
      "run_checks",
      "install_dependency",
      "internet",
      "destructive_command",
      "push_main",
      "force_push",
      "read_secrets",
    ]);
    expect(RULE_VALUES).toEqual(["allow", "ask", "deny"]);
  });

  it("accepts any value for any action, a locked one included (core applies the lock)", () => {
    const config = { ...base, rules: { internet: "allow", push_main: "allow" } };
    expect(MethodConfigSchema.parse(config)).toEqual(config);
    expect(MethodConfigSchema.safeParse(base).success).toBe(true);
    expect(RulesSchema.safeParse({}).success).toBe(true);
  });

  it.each([
    ["an unknown action", { teleport: "allow" }, ["rules"]],
    ["an unknown value", { internet: "maybe" }, ["rules", "internet"]],
    ["a list", ["internet"], ["rules"]],
  ])("rejects %s", (_name, rules, path) => {
    const result = MethodConfigSchema.safeParse({ ...base, rules });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(path);
  });

  it("has the RULE_LOCKED error code", () => {
    expect(ErrorCode.RULE_LOCKED).toBe("RULE_LOCKED");
  });

  it("reads allow and ask in Claude Code settings, and records them in the manifest", () => {
    const settings = { permissions: { allow: ["WebFetch"], ask: ["WebSearch"], deny: [] } };
    expect(ClaudeSettingsSchema.parse(settings)).toEqual(settings);
    expect(ClaudeSettingsSchema.safeParse({ permissions: { ask: "x" } }).success).toBe(false);
    const manifest = {
      format_version: 1,
      files: {},
      permissions: [],
      permission_lists: { ".claude/settings.json": { allow: ["WebFetch"], ask: [] } },
    };
    expect(SyncManifestSchema.parse(manifest)).toEqual(manifest);
  });
});
