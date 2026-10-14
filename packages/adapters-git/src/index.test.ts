import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeWorkspaceFiles, packageName } from "./index.js";

describe("adapters-git", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@agentplugged/adapters-git");
  });
});

describe("NodeWorkspaceFiles", () => {
  let root: string;
  let files: NodeWorkspaceFiles;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentplugged-fs-"));
    files = new NodeWorkspaceFiles(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("creates folders and reports what exists", async () => {
    expect(await files.exists("a/b")).toBe(false);
    await files.mkdir("a/b");
    await files.mkdir("a/b");
    expect(await files.exists("a/b")).toBe(true);
    expect(await files.exists("a")).toBe(true);
  });

  it("writes atomically, creating parents, and leaves no temporary file", async () => {
    await files.writeText("x/y/file.md", "one");
    await files.writeText("x/y/file.md", "two ✓");
    expect(await files.readText("x/y/file.md")).toBe("two ✓");
    expect(await readFile(join(root, "x/y/file.md"), "utf8")).toBe("two ✓");
    expect(await readdir(join(root, "x/y"))).toEqual(["file.md"]);
  });

  it("writes empty files", async () => {
    await files.writeText("d/.gitkeep", "");
    expect(await files.readText("d/.gitkeep")).toBe("");
  });

  it("reads existing files untouched", async () => {
    await writeFile(join(root, "crlf.md"), "a\r\nb");
    expect(await files.readText("crlf.md")).toBe("a\r\nb");
  });

  it("writes through a symbolic link and keeps the link", async (context) => {
    await writeFile(join(root, "AGENTS.md"), "real");
    try {
      await symlink("AGENTS.md", join(root, "CLAUDE.md"), "file");
    } catch {
      context.skip("this system refuses to create symbolic links");
    }
    await files.writeText("CLAUDE.md", "through the link");
    expect((await lstat(join(root, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("through the link");
    expect((await readdir(root)).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("fails to read a missing file", async () => {
    await expect(files.readText("missing")).rejects.toThrow();
  });

  it.each(["../outside", "a/../../outside", join(tmpdir(), "abs")])(
    "refuses paths outside the workspace (%s)",
    async (path) => {
      await expect(files.writeText(path, "x")).rejects.toThrow();
      expect(() => files.resolve(path)).toThrow();
    },
  );
});

describe("NodeWorkspaceFiles: bytes, listing and removal", () => {
  let root: string;
  let files: NodeWorkspaceFiles;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentplugged-fs-"));
    files = new NodeWorkspaceFiles(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("writes and reads raw bytes", async () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 137]);
    await files.writeBytes("a/b.bin", bytes);
    expect(await files.readBytes("a/b.bin")).toEqual(bytes);
  });

  it("lists a link to a file but does not follow a link to a folder", async (context) => {
    await files.writeText("real/inner.md", "inner");
    await files.writeText("d/file.md", "file");
    try {
      await symlink(join(root, "d/file.md"), join(root, "d/file-link.md"), "file");
      await symlink(join(root, "real"), join(root, "d/folder-link"), "dir");
    } catch {
      context.skip("this system refuses to create symbolic links");
    }
    expect(await files.listFiles("d")).toEqual(["d/file-link.md", "d/file.md"]);
  });

  it("lists files recursively, sorted, with / separators", async () => {
    await files.writeText("d/z.md", "z");
    await files.writeText("d/a/b/c.md", "c");
    await files.writeText("d/a.md", "a");
    await files.mkdir("d/empty");
    expect(await files.listFiles("d")).toEqual(["d/a.md", "d/a/b/c.md", "d/z.md"]);
    expect(await files.listFiles("missing")).toEqual([]);
    expect(await files.listFiles("d/a.md")).toEqual([]);
  });

  it("removes files and empty folders, and ignores missing paths", async () => {
    await files.writeText("d/e/f.md", "f");
    await expect(files.remove("d/e")).rejects.toThrow();
    await files.remove("d/e/f.md");
    await files.remove("d/e");
    await files.remove("d/e");
    expect(await files.exists("d/e")).toBe(false);
    expect(await files.exists("d")).toBe(true);
  });
});
