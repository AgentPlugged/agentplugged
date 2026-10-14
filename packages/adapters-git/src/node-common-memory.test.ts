import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCommonMemory } from "./node-common-memory.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentplugged-common-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("NodeCommonMemory", () => {
  it("lists nothing in a folder that does not exist", async () => {
    expect(await new NodeCommonMemory({ dir: join(dir, "nowhere") }).list()).toEqual([]);
  });

  it("writes an entry through a temporary file, reads it back and lists it", async () => {
    const memory = new NodeCommonMemory({ dir: join(dir, "memory") });
    await memory.write("C-7M2K9QX4TB", "first");
    await memory.write("C-7M2K9QX4TB", "second");
    expect(await memory.read("C-7M2K9QX4TB")).toBe("second");
    expect(await memory.list()).toEqual(["C-7M2K9QX4TB"]);
    // No temporary file is left behind.
    expect(await readdir(join(dir, "memory"))).toEqual(["C-7M2K9QX4TB.json"]);
    if (process.platform !== "win32") {
      expect((await stat(join(dir, "memory", "C-7M2K9QX4TB.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses an id that is not one, so no path can be built from it", async () => {
    const memory = new NodeCommonMemory({ dir });
    for (const id of ["../x", "C-../../x", "c-7m2k9qx4tb", "C-7M2K9QX4TB/a", ""]) {
      await expect(memory.write(id, "x"), id).rejects.toThrow();
      expect(await memory.read(id), id).toBeUndefined();
    }
    await writeFile(join(dir, "notes.json"), "x");
    await writeFile(join(dir, "C-7M2K9QX4TB.txt"), "x");
    expect(await memory.list()).toEqual([]);
  });

  it("keeps its folder under the user's home by default, never moved by a variable", () => {
    const previous = process.env.AGENTPLUGGED_MEMORY_DIR;
    process.env.AGENTPLUGGED_MEMORY_DIR = join(dir, "moved");
    try {
      expect(new NodeCommonMemory().dir).toMatch(/\.agentplugged[\\/]memory$/);
    } finally {
      if (previous === undefined) delete process.env.AGENTPLUGGED_MEMORY_DIR;
      else process.env.AGENTPLUGGED_MEMORY_DIR = previous;
    }
  });
});
