import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeWorkspaceFiles } from "./node-workspace-files.js";

// `readdir` stays the real one, except where a test makes it fail.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentplugged-entries-"));
});

afterEach(async () => {
  vi.mocked(readdir).mockClear();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const failure = (code: string) => Object.assign(new Error(`${code}: test`), { code });

describe("NodeWorkspaceFiles.listEntries", () => {
  it("lists the names directly in a folder, files and folders, in UTF-16 code unit order", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "deep.ts"), "");
    for (const name of ["b.md", "C.md", "a.md", "é.md", "_x"]) {
      await writeFile(join(root, name), "");
    }
    const files = new NodeWorkspaceFiles(root);
    expect(await files.listEntries("")).toEqual(["C.md", "_x", "a.md", "b.md", "src", "é.md"]);
    expect(await files.listEntries("src")).toEqual(["deep.ts"]);
  });

  it("sees no entry in a missing folder or a file", async () => {
    await writeFile(join(root, "file.txt"), "");
    const files = new NodeWorkspaceFiles(root);
    expect(await files.listEntries("missing")).toEqual([]);
    expect(await files.listEntries("file.txt")).toEqual([]);
  });

  it.each(["EACCES", "EPERM"])("sees no entry in a folder it may not read (%s)", async (code) => {
    vi.mocked(readdir).mockRejectedValueOnce(failure(code));
    expect(await new NodeWorkspaceFiles(root).listEntries("")).toEqual([]);
  });

  it("lets any other failure through", async () => {
    vi.mocked(readdir).mockRejectedValueOnce(failure("EIO"));
    await expect(new NodeWorkspaceFiles(root).listEntries("")).rejects.toThrow("EIO");
  });
});
