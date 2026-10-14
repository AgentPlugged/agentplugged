import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommonMemory } from "@agentplugged/core";
import { randomBytes, toHex } from "@agentplugged/crypto";
import { renameWithRetry } from "./atomic-rename.js";

/**
 * The common memory of the creator's products: `~/.agentplugged/memory/<C-id>.json`,
 * one encrypted file per promoted lesson, in the user's folder, beside the store of the creator's
 * messages and like it never in a repository. The engine encrypts what it writes here with a key
 * derived from the machine key; this adapter only moves files. Entries are written through a
 * temporary file then renamed (a crash leaves the old entry whole), the folder is 0700 and the
 * files 0600. An id that is not `C-` and 10 characters is refused: no path can be built from it.
 */
const ENTRY_ID = /^C-[0-9A-HJKMNP-TV-Z]{10}$/;
const SUFFIX = ".json";

/** `ENOENT`: the folder or the file is not there. */
function isMissing(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOENT";
}

export class NodeCommonMemory implements CommonMemory {
  readonly #dir: string;

  /**
   * `dir` is for tests only: the engine uses `~/.agentplugged/memory`, the one folder the deny
   * rules protect, never a folder an environment variable could move.
   */
  constructor(options: { readonly dir?: string } = {}) {
    this.#dir = options.dir ?? join(homedir(), ".agentplugged", "memory");
  }

  /** The folder. */
  get dir(): string {
    return this.#dir;
  }

  async list(): Promise<readonly string[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (error) {
      // No folder yet is an empty memory; any other failure (rights, disk) is not "empty".
      if (isMissing(error)) return [];
      throw error;
    }
    return names
      .filter((name) => name.endsWith(SUFFIX) && ENTRY_ID.test(name.slice(0, -SUFFIX.length)))
      .map((name) => name.slice(0, -SUFFIX.length));
  }

  async read(id: string): Promise<string | undefined> {
    if (!ENTRY_ID.test(id)) return undefined;
    try {
      return await readFile(join(this.#dir, `${id}${SUFFIX}`), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async write(id: string, text: string): Promise<void> {
    if (!ENTRY_ID.test(id)) throw new Error(`not a common memory id: ${id}`);
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const target = join(this.#dir, `${id}${SUFFIX}`);
    // A name nobody can guess, created only when it does not exist: a link left there is not followed.
    const temporary = join(this.#dir, `.${id}.${toHex(randomBytes(8))}.tmp`);
    try {
      await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await renameWithRetry(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
