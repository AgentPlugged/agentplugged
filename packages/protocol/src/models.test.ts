import { describe, expect, it } from "vitest";
import {
  AgentOverrideSchema,
  AgentsSchema,
  MethodConfigSchema,
  MODEL_CLIENT_IDS,
  MODEL_TIERS,
  ModelTableSchema,
} from "./index.js";

type Cell = { model: string; effort?: string };

function table(cell = (client: string): Cell => ({ model: `${client}-model` })) {
  return Object.fromEntries(
    MODEL_CLIENT_IDS.map((client) => [
      client,
      Object.fromEntries(MODEL_TIERS.map((tier) => [tier, cell(client)])),
    ]),
  );
}

describe("ModelTableSchema", () => {
  it("accepts every client and tier, with an effort for Claude Code and Codex", () => {
    const value = table();
    value["claude-code"] = {
      ...value["claude-code"],
      reasoning: { model: "opus", effort: "high" },
    };
    value.codex = { ...value.codex, code: { model: "gpt-6.1-sol", effort: "medium" } };
    expect(ModelTableSchema.parse(value)).toEqual(value);
  });

  it("requires every client and every tier", () => {
    const value = table();
    delete (value.cursor as Record<string, unknown>).fast;
    expect(ModelTableSchema.safeParse(value).error?.issues[0]?.path).toEqual(["cursor", "fast"]);
    const without = table();
    delete without["gemini-cli"];
    expect(ModelTableSchema.safeParse(without).error?.issues[0]?.path).toEqual(["gemini-cli"]);
  });

  it("refuses an effort where the tool has none, an empty model and an unknown tool", () => {
    const effort = table();
    effort.cursor = { ...effort.cursor, code: { model: "x", effort: "high" } };
    expect(ModelTableSchema.safeParse(effort).error?.issues[0]?.code).toBe("unrecognized_keys");
    const empty = table();
    empty.codex = { ...empty.codex, fast: { model: " " } };
    expect(ModelTableSchema.safeParse(empty).error?.issues[0]?.path).toEqual([
      "codex",
      "fast",
      "model",
    ]);
    expect(ModelTableSchema.safeParse({ ...table(), zed: {} }).success).toBe(false);
  });

  it.each([
    ["claude-code", "minimal"],
    ["claude-code", "ultra"],
    ["claude-code", "none"],
    ["codex", "huge"],
    ["codex", "none"],
  ])("refuses the %s effort %j in the table", (client, effort) => {
    const value = table();
    value[client] = { ...value[client], fast: { model: "x", effort } };
    expect(ModelTableSchema.safeParse(value).error?.issues[0]?.path).toEqual([
      client,
      "fast",
      "effort",
    ]);
  });

  it("accepts each tool's own efforts", () => {
    const value = table();
    value["claude-code"] = { ...value["claude-code"], fast: { model: "x", effort: "max" } };
    value.codex = { ...value.codex, fast: { model: "x", effort: "minimal" } };
    expect(ModelTableSchema.safeParse(value).success).toBe(true);
    value.codex = { ...value.codex, fast: { model: "x", effort: "ultra" } };
    expect(ModelTableSchema.safeParse(value).success).toBe(true);
  });
});

describe("MethodConfigSchema: models and agents.settings", () => {
  const base = { format_version: 2, engine_version: "1.0.0" };

  it("accepts partial model overrides, tool by tool and tier by tier", () => {
    const config = {
      ...base,
      models: {
        codex: { code: { model: "gpt-6.2-sol" } },
        "claude-code": { fast: { effort: "low" }, reasoning: { model: "haiku", effort: "none" } },
      },
    };
    expect(MethodConfigSchema.parse(config)).toEqual(config);
  });

  it.each([
    [{ "claude-code": { code: { effort: "ultra" } } }, ["models", "claude-code", "code", "effort"]],
    [{ codex: { code: { effort: "huge" } } }, ["models", "codex", "code", "effort"]],
    [{ codex: { code: { model: "" } } }, ["models", "codex", "code", "model"]],
    [{ codex: { huge: { model: "x" } } }, ["models", "codex"]],
    [{ antigravity: { code: { effort: "high" } } }, ["models", "antigravity", "code"]],
    [{ zed: {} }, ["models"]],
  ])("refuses the models %j", (models, path) => {
    const result = MethodConfigSchema.safeParse({ ...base, models });
    expect(result.error?.issues[0]?.path).toEqual(path);
  });

  it("accepts settings by agent: tier and preferred tool", () => {
    const agents = { settings: { iris: { model_tier: "fast", tool: "codex" }, scout: {} } };
    expect(AgentsSchema.parse(agents)).toEqual(agents);
  });

  it.each([
    [{ iris: { model_tier: "huge" } }, ["settings", "iris", "model_tier"]],
    [{ iris: { tool: "zed" } }, ["settings", "iris", "tool"]],
    [{ iris: { color: "red" } }, ["settings", "iris"]],
  ])("refuses the settings %j", (settings, path) => {
    expect(AgentsSchema.safeParse({ settings }).error?.issues[0]?.path).toEqual(path);
  });
});

describe("AgentOverrideSchema: model_tier", () => {
  it("accepts a known tier and refuses an unknown one", () => {
    expect(AgentOverrideSchema.parse({ model_tier: "code" })).toEqual({ model_tier: "code" });
    expect(AgentOverrideSchema.safeParse({ model_tier: "huge" }).error?.issues[0]?.path).toEqual([
      "model_tier",
    ]);
  });
});
