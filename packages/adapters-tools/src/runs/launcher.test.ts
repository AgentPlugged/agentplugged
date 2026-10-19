import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunRequestInvalid } from "./contract.js";
import { resolveLauncher } from "./launcher.js";

describe("resolveLauncher", () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "agentplugged-launcher-"));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  const shim = (target: string) =>
    `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\${target}"   %*\r\n`;

  it("starts a native program as it is, and anything on another system than Windows as it is", async () => {
    expect(await resolveLauncher("C:\\tools\\claude.exe", { platform: "win32" })).toEqual({
      file: "C:\\tools\\claude.exe",
      prefixArgs: [],
    });
    expect(await resolveLauncher("/usr/local/bin/claude", { platform: "linux" })).toEqual({
      file: "/usr/local/bin/claude",
      prefixArgs: [],
    });
  });

  // These resolve real files through Windows paths, so they only run on Windows.
  it.runIf(process.platform === "win32")(
    "finds the real program behind the script an npm install leaves, and never runs the script",
    async () => {
      const exe = join(folder, "node_modules", "tool", "bin", "tool.exe");
      await mkdir(join(folder, "node_modules", "tool", "bin"), { recursive: true });
      await writeFile(exe, "");
      const cmd = join(folder, "tool.cmd");
      await writeFile(cmd, shim("node_modules\\tool\\bin\\tool.exe"));
      expect(await resolveLauncher(cmd, { platform: "win32" })).toEqual({
        file: exe,
        prefixArgs: [],
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "runs a Node script's program with Node, and does not take Node itself for the program",
    async () => {
      const js = join(folder, "node_modules", "tool", "cli.js");
      await mkdir(join(folder, "node_modules", "tool"), { recursive: true });
      await writeFile(js, "");
      await writeFile(join(folder, "node.exe"), "");
      const cmd = join(folder, "tool.cmd");
      await writeFile(
        cmd,
        `${shim("node.exe")}"%dp0%\\node.exe" "%dp0%\\node_modules\\tool\\cli.js" %*\r\n`,
      );
      expect(
        await resolveLauncher(cmd, { platform: "win32", nodePath: "C:\\node\\node.exe" }),
      ).toEqual({
        file: "C:\\node\\node.exe",
        prefixArgs: [js],
      });
    },
  );

  it("refuses a script whose program is missing, an unreadable one and a program of another kind", async () => {
    const cmd = join(folder, "tool.cmd");
    await writeFile(cmd, shim("node_modules\\gone\\gone.exe"));
    await expect(resolveLauncher(cmd, { platform: "win32" })).rejects.toBeInstanceOf(
      RunRequestInvalid,
    );
    await expect(
      resolveLauncher(join(folder, "absent.cmd"), { platform: "win32" }),
    ).rejects.toBeInstanceOf(RunRequestInvalid);
    await expect(
      resolveLauncher("C:\\tools\\tool.ps1", { platform: "win32" }),
    ).rejects.toBeInstanceOf(RunRequestInvalid);
  });
});
