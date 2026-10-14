import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("mcp", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@agentplugged/mcp");
  });
});
