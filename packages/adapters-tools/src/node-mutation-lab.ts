import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type CopyOpening,
  insideProject,
  type MutationCopy,
  type MutationLab,
} from "@agentplugged/core";
import { gitOutput, NodeProofRunner, workspaceBase } from "./node-proof-runner.js";

/**
 * The throwaway copy of the mutation check. It copies the whole working tree of the
 * story (or of the project), installed dependencies and uncommitted changes included, but not Git's
 * own folder, into a folder of its own under the system's temporary folder; the check then writes
 * only there. Nothing in the creator's folder is ever written: every write is checked to land on an
 * existing regular file inside the copy (no link followed out of it), the copy is bounded in files,
 * size and time, and `close` removes it, whatever the check did.
 */

export interface NodeMutationLabOptions {
  /** The project's folder: the copy is of it, or of a story's working copy of the same repository. */
  readonly root: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Where the copies are made; the system's temporary folder when absent. Tests give their own. */
  readonly temporary?: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

/** The most files and bytes a copy holds: a project beyond is refused, not copied half. */
export const MAX_COPY_FILES = 150_000;
export const MAX_COPY_BYTES = 3 * 1024 * 1024 * 1024;

const PREFIX = "agentplugged-mutation-";
const MARKER = ".agentplugged-mutation";
/** A copy left behind by a process that died is removed after this long. */
const STALE_MS = 6 * 60 * 60 * 1000;

class Refused extends Error {}

interface Limits {
  files: number;
  bytes: number;
  deadline: number;
}

/** True for a folder that is another working copy of the repository (a nested worktree). */
async function isNestedWorktree(folder: string): Promise<boolean> {
  try {
    const found = await readFile(join(folder, ".git"), "utf8");
    return /^gitdir:.*[\\/]worktrees[\\/]/.test(found);
  } catch {
    return false;
  }
}

/**
 * Copies `from` into `to`: files and folders as they are, `.git` and the other working copies of the
 * repository left out. A link that points inside `from` is made to point at the same place inside
 * `to` (after the walk, when its target exists); one that points elsewhere is kept as it is.
 */
async function copyTree(from: string, to: string, limits: Limits): Promise<void> {
  const used = { files: 0, bytes: 0 };
  const links: Array<{ target: string; destination: string; folder: boolean; origin: string }> = [];
  const walk = async (source: string, target: string): Promise<void> => {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (Date.now() > limits.deadline) throw new Refused("copy_too_slow");
      if (entry.name === ".git") continue;
      const origin = join(source, entry.name);
      const destination = join(target, entry.name);
      if (entry.isDirectory()) {
        if (!(await isNestedWorktree(origin))) await walk(origin, destination);
        continue;
      }
      used.files += 1;
      if (used.files > limits.files) throw new Refused("copy_too_big");
      if (entry.isSymbolicLink()) {
        const link = await readlink(origin);
        const folder = await stat(origin).then(
          (found) => found.isDirectory(),
          () => false,
        );
        const plain = link.replace(/^\\\\\?\\/, "");
        // Compared on the real path: `from` is one, and a link may spell the same folder
        // otherwise (a Windows short name such as RUNNER~1, another case, a link on the way).
        const real = isAbsolute(plain) ? await realpath(plain).catch(() => plain) : undefined;
        const target =
          real !== undefined && within(from, real) ? join(to, relative(from, real)) : link;
        links.push({ target, destination, folder, origin });
        continue;
      }
      if (!entry.isFile()) continue;
      const size = (await lstat(origin)).size;
      used.bytes += size;
      if (used.bytes > limits.bytes) throw new Refused("copy_too_big");
      await copyFile(origin, destination);
    }
  };
  await walk(from, to);
  for (const { target, destination, folder, origin } of links) {
    try {
      await symlink(target, destination, folder ? "junction" : "file");
    } catch {
      // A link that cannot be made (no right to on Windows): the file it points to is copied.
      if (!folder) await copyFile(origin, destination).catch(() => undefined);
    }
  }
}

/** True when `path` is `root` or lies inside it. */
function within(root: string, path: string): boolean {
  const inside = relative(root, path);
  return (
    inside === "" || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside))
  );
}

class NodeMutationCopy implements MutationCopy {
  readonly runner: NodeProofRunner;
  readonly #folder: string;
  readonly #root: string;

  constructor(folder: string, root: string, project: string, options: NodeMutationLabOptions) {
    this.#folder = folder;
    this.#root = root;
    this.runner = new NodeProofRunner({
      root: project,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    });
  }

  /** The file of the copy for a project path, or undefined when it would not lie inside it. */
  async #file(path: string): Promise<string | undefined> {
    if (!insideProject(path)) return undefined;
    const target = resolve(this.#root, path);
    if (!within(this.#root, target)) return undefined;
    try {
      // The folders on the way are real folders of the copy, not links that lead out of it.
      const parent = await realpath(dirname(target));
      return within(await realpath(this.#root), parent) ? target : undefined;
    } catch {
      return undefined;
    }
  }

  async read(path: string): Promise<string | undefined> {
    const file = await this.#file(path);
    if (file === undefined) return undefined;
    try {
      const text = await readFile(file, "utf8");
      return text.includes("\u0000") ? undefined : text;
    } catch {
      return undefined;
    }
  }

  async write(path: string, text: string): Promise<void> {
    const file = await this.#file(path);
    if (file === undefined) throw new Error(`refused: ${path} is not a file of the copy`);
    // An existing regular file only, never through a link.
    const found = await lstat(file);
    if (!found.isFile()) throw new Error(`refused: ${path} is not a regular file`);
    await writeFile(file, text, "utf8");
    // A later time than the original, so that a tool that compares times sees the change.
    const now = new Date();
    await utimes(file, now, now).catch(() => undefined);
  }

  async close(): Promise<string | undefined> {
    try {
      await rm(this.#folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Reported below by what is still there.
    }
    return existsSync(this.#folder) ? this.#folder : undefined;
  }
}

export class NodeMutationLab implements MutationLab {
  readonly #options: NodeMutationLabOptions;
  readonly #root: string;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: NodeMutationLabOptions) {
    this.#options = options;
    this.#root = resolve(options.root);
    this.#env = options.env ?? process.env;
  }

  /** Removes the copies a process that died left behind (marked, and older than `STALE_MS`). */
  async #sweep(temporary: string): Promise<void> {
    try {
      for (const entry of await readdir(temporary, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
        const folder = join(temporary, entry.name);
        const marker = await lstat(join(folder, MARKER)).catch(() => undefined);
        if (marker !== undefined && Date.now() - marker.mtimeMs > STALE_MS) {
          await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
      }
    } catch {
      // Best effort.
    }
  }

  async open(workspace: string | undefined, seconds: number): Promise<CopyOpening> {
    const base = await workspaceBase(this.#root, workspace, this.#env);
    if (typeof base !== "string") return { refused: "not_a_working_copy" };
    const top =
      (await gitOutput(base, ["rev-parse", "--show-toplevel"], this.#env))?.trim() || base;
    const source = await realpath(resolve(top)).catch(() => undefined);
    const project = await realpath(base).catch(() => undefined);
    if (source === undefined || project === undefined || !within(source, project)) {
      return { refused: "not_a_working_copy" };
    }
    const temporary = resolve(this.#options.temporary ?? tmpdir());
    await this.#sweep(temporary);
    const folder = await mkdtemp(join(temporary, PREFIX));
    const root = join(folder, "copy");
    try {
      // Never a copy inside what it copies: it would copy itself.
      if (within(source, await realpath(folder))) throw new Refused("copy_inside_the_project");
      await writeFile(join(folder, MARKER), String(Date.now()), "utf8");
      await copyTree(source, root, {
        files: this.#options.maxFiles ?? MAX_COPY_FILES,
        bytes: this.#options.maxBytes ?? MAX_COPY_BYTES,
        deadline: Date.now() + seconds * 1000,
      });
    } catch (error) {
      await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
        () => undefined,
      );
      return { refused: error instanceof Refused ? error.message : "copy_failed" };
    }
    const inner = relative(source, project);
    return {
      copy: new NodeMutationCopy(
        folder,
        root,
        inner === "" ? root : join(root, inner),
        this.#options,
      ),
    };
  }
}
