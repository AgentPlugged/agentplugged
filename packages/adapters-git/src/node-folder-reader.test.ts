import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFolderReader } from "./node-folder-reader.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentplugged-folders-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("NodeFolderReader", () => {
  it("opens a real folder, read only through its own files", async () => {
    const copy = join(root, "shop.worktrees", "1-1");
    await mkdir(copy, { recursive: true });
    await writeFile(join(copy, "package.json"), "{}");
    const files = await new NodeFolderReader().open(copy);
    expect(files).toBeDefined();
    expect(await files?.readText("package.json")).toBe("{}");
    expect(await files?.exists("missing.json")).toBe(false);
  });

  it("refuses a folder that does not exist, a file, or a folder given with a trailing separator", async () => {
    const reader = new NodeFolderReader();
    expect(await reader.open(join(root, "nothing"))).toBeUndefined();
    await writeFile(join(root, "file"), "x");
    expect(await reader.open(join(root, "file"))).toBeUndefined();
    await mkdir(join(root, "dir"));
    expect(await reader.open(`${join(root, "dir")}/`)).toBeDefined();
  });

  it("refuses a symbolic link, and a folder under one: nothing leaves the working copy", async () => {
    await mkdir(join(root, "elsewhere", "1-1"), { recursive: true });
    const type = process.platform === "win32" ? "junction" : "dir";
    await symlink(join(root, "elsewhere"), join(root, "shop.worktrees"), type);
    const reader = new NodeFolderReader();
    // The link itself, and a real folder reached through it.
    expect(await reader.open(join(root, "shop.worktrees"))).toBeUndefined();
    expect(await reader.open(join(root, "shop.worktrees", "1-1"))).toBeUndefined();
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"), type);
    expect(await reader.open(join(root, "link"))).toBeUndefined();
    expect(await reader.open(join(root, "real"))).toBeDefined();
  });
});
