import { describe, expect, it } from "vitest";
import { isEngineCommand } from "./command-match.js";

describe("the trust gate lets the engine's own launcher through", () => {
  it("recognises npx, the binary and the local build, quoted or not", () => {
    for (const command of [
      "npx agentplugged docs check",
      "npx -y agentplugged@1.0.0 next",
      "agentplugged docs check",
      "node /work/apps/cli/dist/bin.js docs check",
      'node "/work/agent plugged/dist/main.js" next',
      String.raw`node "C:\Work\agent plugged\dist\main.js" next`,
      String.raw`node C:\Work\dist\bin.js docs check`,
      "node '/work/agent plugged/bin.js' docs check",
    ]) {
      expect(isEngineCommand(command), command).toBe(true);
    }
    for (const command of ["node evil.js", "node /tmp/x/other.js docs", "npx some-package"]) {
      expect(isEngineCommand(command), command).toBe(false);
    }
  });
});
