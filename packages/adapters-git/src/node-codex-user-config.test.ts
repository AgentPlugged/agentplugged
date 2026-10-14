import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NodeCodexUserConfig } from "./node-codex-user-config.js";

const folders: string[] = [];
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agentplugged-codex-user-"));
  folders.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Codex's own config.toml", () => {
  it("lives in ~/.codex, or in CODEX_HOME when it is set", () => {
    expect(new NodeCodexUserConfig({ home: "/h" }).path).toBe(join("/h", ".codex", "config.toml"));
    expect(new NodeCodexUserConfig({ home: "/h", codexHome: "/elsewhere" }).path).toBe(
      join("/elsewhere", "config.toml"),
    );
    expect(new NodeCodexUserConfig({ home: "/h", codexHome: "  " }).path).toBe(
      join("/h", ".codex", "config.toml"),
    );
  });

  it("reads nothing from a missing file, creates the folder on a write, and leaves no temporary file", async () => {
    const home = folder();
    const config = new NodeCodexUserConfig({ home });
    expect(await config.read()).toBeUndefined();
    await config.write('model = "x"\n');
    expect(await config.read()).toBe('model = "x"\n');
    await config.write('model = "y"\n');
    expect(readFileSync(config.path, "utf8")).toBe('model = "y"\n');
    expect(readdirSync(join(home, ".codex"))).toEqual(["config.toml"]);
  });

  it("does not create the file by reading it", async () => {
    const home = folder();
    const config = new NodeCodexUserConfig({ home });
    writeFileSync(join(home, "other"), "");
    await config.read();
    expect(existsSync(config.path)).toBe(false);
  });
});
