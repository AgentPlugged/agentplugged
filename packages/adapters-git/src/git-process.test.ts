import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runGit } from "./git-process.js";

describe("runGit", () => {
  it("passes the env argument to Git", async () => {
    const run = await runGit(tmpdir(), ["config", "--get", "x.y"], undefined, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "x.y",
      GIT_CONFIG_VALUE_0: "v",
    });
    expect(run.status).toBe(0);
    expect(run.stdout.toString("utf8").trim()).toBe("v");
  });
});
