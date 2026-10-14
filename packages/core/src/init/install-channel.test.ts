import { describe, expect, it } from "vitest";
import { AgentPluggedError } from "../errors.js";
import { MemoryFiles } from "../testing/memory-files.js";
import {
  INSTALL_CHANNEL_PATH,
  INSTALL_CHANNELS,
  readInstallChannel,
  validateInstallChannel,
  writeInstallChannel,
} from "./install-channel.js";

describe("the install channel", () => {
  it("is noted in the ignored cache folder, so that it is a fact about this machine only", () => {
    expect(INSTALL_CHANNEL_PATH).toBe(".agentplugged/.cache/install-channel");
    expect(INSTALL_CHANNELS).toEqual(["claude-plugin"]);
  });

  it("is read back, and absent means no store (npm)", async () => {
    const files = new MemoryFiles();
    expect(await readInstallChannel(files)).toBeUndefined();
    await writeInstallChannel(files, "claude-plugin");
    expect(files.files.get(INSTALL_CHANNEL_PATH)).toBe("claude-plugin\n");
    expect(await readInstallChannel(files)).toBe("claude-plugin");
  });

  it("ignores a note it does not know instead of reporting a store that does not exist", async () => {
    const files = new MemoryFiles();
    files.seed(INSTALL_CHANNEL_PATH, "somewhere\n");
    expect(await readInstallChannel(files)).toBeUndefined();
  });

  it("validates what a caller gives", () => {
    expect(validateInstallChannel("claude-plugin")).toBe("claude-plugin");
    for (const bad of ["npm", "", undefined, 3, "claude-plugin ", "CLAUDE-PLUGIN"]) {
      expect(validateInstallChannel(bad)).toBeInstanceOf(AgentPluggedError);
    }
  });
});
