import { type ClientId, fallbacksFor, MCP_JSON_FILES, TOOL_CATALOG } from "@agentplugged/core";
import { fallbackReason } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";

describe("French fallback reasons", () => {
  it("translate every MCP fallback sync can announce", () => {
    const tools = TOOL_CATALOG.map((spec) => spec.id);
    const conflicts = new Map<ClientId, string>(
      MCP_JSON_FILES.map((file) => [file.client, file.path]),
    );
    const produced = [
      ...fallbacksFor(tools),
      ...fallbacksFor(tools, { codexConfigKept: true, mcpConflicts: conflicts }),
      ...fallbacksFor(tools, { mcpConflicts: conflicts, mcpFileAbsent: new Set() }),
    ].filter((fallback) => fallback.capability === "mcp");
    const ids = new Set(produced.map((fallback) => fallback.id));
    expect(ids).toContain("codex.mcp.config-kept");
    expect(ids).toContain("gemini-cli.mcp");
    for (const file of MCP_JSON_FILES) expect(ids).toContain(`${file.client}.mcp.conflict`);
    for (const fallback of produced) {
      const french = fallbackReason("fr", fallback.id, "ENGLISH", fallback.params);
      expect(french, fallback.id).not.toBe("ENGLISH");
      expect(french, fallback.id).not.toMatch(/\{\w+\}/);
      if (fallback.params?.path) expect(french, fallback.id).toContain(fallback.params.path);
    }
  });
});
