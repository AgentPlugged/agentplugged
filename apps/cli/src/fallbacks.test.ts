import { type ClientId, fallbacksFor, MCP_JSON_FILES, TOOL_CATALOG } from "@agentplugged/core";
import { fallbackReason } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";
import { agentCall } from "./next-text.js";

describe("French fallback reasons", () => {
  it("translate every MCP fallback sync can announce", () => {
    const tools = TOOL_CATALOG.map((spec) => spec.id);
    const conflicts = new Map<ClientId, string>(
      MCP_JSON_FILES.map((file) => [file.client, file.path]),
    );
    const produced = [
      ...fallbacksFor(tools),
      ...fallbacksFor(tools, { codexConfigKept: true, mcpConflicts: conflicts }),
      ...fallbacksFor(tools, { mcpConflicts: conflicts }),
    ].filter((fallback) => fallback.capability === "mcp");
    const ids = new Set(produced.map((fallback) => fallback.id));
    expect(ids).toContain("codex.mcp.config-kept");
    for (const file of MCP_JSON_FILES) expect(ids).toContain(`${file.client}.mcp.conflict`);
    for (const fallback of produced) {
      const french = fallbackReason("fr", fallback.id, "ENGLISH", fallback.params);
      expect(french, fallback.id).not.toBe("ENGLISH");
      expect(french, fallback.id).not.toMatch(/\{\w+\}/);
      if (fallback.params?.path) expect(french, fallback.id).toContain(fallback.params.path);
    }
  });

  it("translate every fallback of Kimi Code CLI, none left in English", () => {
    const kimi = fallbacksFor(["kimi"]);
    // Everything Kimi lacks: nothing but skills, agents and the project MCP file is native.
    expect(kimi.map((fallback) => fallback.capability)).toEqual([
      "instructions",
      "permissions",
      "model",
      "rules",
      "untrusted",
      "chat_proof",
      "isolation",
      "decisions",
      "installs",
      "usage",
      "budget",
    ]);
    for (const fallback of kimi) {
      const french = fallbackReason("fr", fallback.id, "ENGLISH");
      expect(french, fallback.id).not.toBe("ENGLISH");
      expect(french, fallback.id).not.toMatch(/\{\w+\}/);
    }
  });
});

describe("how the creator calls an agent in Kimi Code CLI", () => {
  it("is the skill command", () => {
    expect(agentCall("kimi", "iris")).toBe("/skill:iris");
  });
});
