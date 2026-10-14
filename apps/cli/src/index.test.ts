import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("cli", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("agentplugged");
  });
});
