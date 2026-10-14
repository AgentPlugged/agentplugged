import { mkdir, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AgentPluggedError,
  parseRootPin,
  type RootPinStore,
  rootPinText,
} from "@agentplugged/core";
import { randomBytes, toHex } from "@agentplugged/crypto";
import { ErrorCode, type RootPin, ULID_PATTERN } from "@agentplugged/protocol";
import { renameWithRetry } from "./atomic-rename.js";

/** The pin is there and cannot be used: an error, never "no pin". */
function unreadable(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
    reason: `the root of trust pinned for this product cannot be read (${reason})`,
  });
}

/**
 * The root of trust of each product, pinned on this machine:
 * `~/.agentplugged/trust/<product id>/pin.json`, in the user's folder, never in a repository. The
 * folder is 0700 and the file 0600 where the system honours modes; it is written through a
 * temporary file then renamed, so that a crash leaves the old pin whole. A product id that is not
 * a ULID is refused: no path can be built from it. A file that is not a valid pin (its identifier
 * must be its key's), or that cannot be read, is an error: never "no pin", never another root.
 */
export class NodeRootPinStore implements RootPinStore {
  readonly #dir: string;
  readonly #onFlush: ((what: "file" | "folder") => void) | undefined;

  /**
   * `dir` and `onFlush` are for tests only: the engine uses `~/.agentplugged/trust`, the one
   * folder the deny rules protect, never a folder an environment variable could move. `onFlush`
   * hears each flush to the disk, the file's then the folder's.
   */
  constructor(
    options: { readonly dir?: string; readonly onFlush?: (what: "file" | "folder") => void } = {},
  ) {
    this.#dir = options.dir ?? join(homedir(), ".agentplugged", "trust");
    this.#onFlush = options.onFlush;
  }

  /** The folder. */
  get dir(): string {
    return this.#dir;
  }

  #file(product: string): string {
    if (!ULID_PATTERN.test(product)) throw new Error("not a product id");
    return join(this.#dir, product, "pin.json");
  }

  async read(product: string): Promise<RootPin | undefined> {
    if (!ULID_PATTERN.test(product)) return undefined;
    let text: string;
    try {
      text = await readFile(this.#file(product), "utf8");
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "ENOENT") return undefined;
      throw unreadable((error as { code?: string } | null)?.code ?? "unreadable");
    }
    const pin = parseRootPin(text);
    // A pin that is there and cannot be read is never taken for "no pin": the machine would fall
    // back on the journal's first creator key, which is what the pin is there to stop.
    if (pin === undefined) throw unreadable("it is not a valid pin");
    return pin;
  }

  async write(product: string, pin: RootPin): Promise<void> {
    const target = this.#file(product);
    const folder = join(this.#dir, product);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = join(folder, `.pin.${toHex(randomBytes(8))}.tmp`);
    try {
      // Durable before anything depends on it: the bytes are on the disk when the
      // temporary file is renamed, and the folder's entry is flushed after the rename.
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(rootPinText(pin), "utf8");
        await handle.sync();
        this.#onFlush?.("file");
      } finally {
        await handle.close();
      }
      await renameWithRetry(temporary, target);
      await syncFolder(folder);
      this.#onFlush?.("folder");
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

/**
 * Flushes a folder's entries to the disk (the new name of a renamed file). Where the system cannot
 * open a folder to flush it (Windows), the rename itself is what the system makes durable.
 */
async function syncFolder(folder: string): Promise<void> {
  try {
    const handle = await open(folder, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not supported here: nothing more to do.
  }
}
