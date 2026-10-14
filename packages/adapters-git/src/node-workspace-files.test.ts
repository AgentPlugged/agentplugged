import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeWorkspaceFiles } from "./node-workspace-files.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentplugged-files-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("NodeWorkspaceFiles.createText", () => {
  it("creates a file that does not exist, whole, and leaves no temporary file", async () => {
    const files = new NodeWorkspaceFiles(root);
    expect(await files.createText("h.json", "[]\n")).toBe(true);
    expect(await readFile(join(root, "h.json"), "utf8")).toBe("[]\n");
    expect(await readdir(root)).toEqual(["h.json"]);
  });

  it("never replaces an existing file", async () => {
    await writeFile(join(root, "h.json"), "kept");
    const files = new NodeWorkspaceFiles(root);
    expect(await files.createText("h.json", "new")).toBe(false);
    expect(await readFile(join(root, "h.json"), "utf8")).toBe("kept");
    expect(await readdir(root)).toEqual(["h.json"]);
  });
});
