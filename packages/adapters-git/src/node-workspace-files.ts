import type { Dirent } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceFiles } from "@agentplugged/core";

let tempCounter = 0;

/** `WorkspaceFiles` on the local disk, confined to one root folder. */
export class NodeWorkspaceFiles implements WorkspaceFiles {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Absolute path of a workspace-relative path; refuses anything outside the root. */
  resolve(path: string): string {
    if (isAbsolute(path)) throw new Error(`Workspace paths must be relative: ${path}`);
    const absolute = resolve(this.root, path);
    const fromRoot = relative(this.root, absolute);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`Path escapes the workspace: ${path}`);
    }
    return absolute;
  }

  async isSymbolicLink(path: string): Promise<boolean> {
    try {
      return (await lstat(this.resolve(path))).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.resolve(path));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async readText(path: string): Promise<string> {
    return readFile(this.resolve(path), "utf8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.resolve(path)));
  }

  /**
   * Writes to a temporary file next to the target, then renames it over the target. A symbolic
   * link is followed, so the real file is replaced and the creator's link is kept.
   */
  async writeText(path: string, content: string): Promise<void> {
    await this.#write(path, content);
  }

  async writeBytes(path: string, content: Uint8Array): Promise<void> {
    await this.#write(path, content);
  }

  async #write(path: string, content: string | Uint8Array): Promise<void> {
    let target = this.resolve(path);
    const info = await lstat(target).catch(() => undefined);
    if (info?.isSymbolicLink()) target = await realpath(target);
    await mkdir(dirname(target), { recursive: true });
    tempCounter += 1;
    const temp = `${target}.${process.pid}.${Date.now()}.${tempCounter}.tmp`;
    try {
      await writeFile(
        temp,
        content,
        typeof content === "string" ? { encoding: "utf8", flag: "wx" } : { flag: "wx" },
      );
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  /**
   * Writes a temporary file next to the target, then hard-links it to the target, which fails
   * when anything is there (even an entry created meanwhile): the file appears whole or not at
   * all, and nothing is replaced. Where hard links are not supported, the target is created with
   * the exclusive flag `wx` (still never replacing anything).
   */
  async createText(path: string, content: string): Promise<boolean> {
    const target = this.resolve(path);
    tempCounter += 1;
    const temp = `${target}.${process.pid}.${Date.now()}.${tempCounter}.tmp`;
    try {
      await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
      try {
        await link(temp, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return false;
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV") {
          throw error;
        }
        try {
          await writeFile(target, content, { encoding: "utf8", flag: "wx" });
        } catch (fallback) {
          if ((fallback as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw fallback;
        }
      }
      return true;
    } finally {
      await rm(temp, { force: true });
    }
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(this.resolve(path), { recursive: true });
  }

  async listFiles(dir: string): Promise<string[]> {
    const base = this.resolve(dir);
    const found: string[] = [];
    const walk = async (absolute: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return;
        throw error;
      }
      for (const entry of entries) {
        const child = join(absolute, entry.name);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile() || (entry.isSymbolicLink() && (await isFile(child)))) {
          found.push(relative(this.root, child).split(sep).join("/"));
        }
      }
    };
    await walk(base);
    return found.sort();
  }

  /** The names directly in `dir`, in UTF-16 code unit order (`Array.prototype.sort`). */
  async listEntries(dir: string): Promise<string[]> {
    try {
      const names = await readdir(this.resolve(dir));
      return names.sort();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Missing, not a folder, or not readable: no entry, never a failure of the caller.
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
        return [];
      }
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    const target = this.resolve(path);
    const info = await lstat(target).catch(() => undefined);
    if (!info) return;
    if (info.isDirectory()) await rmdir(target);
    else await unlink(target);
  }
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() === true;
}
