import type { WorkspaceFiles } from "../workspace-files.js";

/**
 * The product's files as a command would leave them, without touching them: reads
 * go to the files, writes stay in memory and are read back. A creator's action that changes files
 * (`profile`, `agent`) is tried on it first, by the very command of the terminal, so a request is
 * checked exactly as the terminal would check it, and nothing is written before the creator
 * approves it.
 */
export class DryRunFiles implements WorkspaceFiles {
  readonly #base: WorkspaceFiles;
  readonly #written = new Map<string, string | Uint8Array>();

  constructor(base: WorkspaceFiles) {
    this.#base = base;
  }

  /** The paths the command wrote, in order. */
  get written(): readonly string[] {
    return [...this.#written.keys()];
  }

  async exists(path: string): Promise<boolean> {
    if (this.#written.has(path)) return true;
    const prefix = `${path}/`;
    if ([...this.#written.keys()].some((written) => written.startsWith(prefix))) return true;
    return this.#base.exists(path);
  }

  async readText(path: string): Promise<string> {
    const written = this.#written.get(path);
    if (written === undefined) return this.#base.readText(path);
    if (typeof written === "string") return written;
    throw new Error(`dry run: ${path} was written as bytes`);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const written = this.#written.get(path);
    if (written === undefined) return this.#base.readBytes(path);
    if (typeof written !== "string") return written;
    throw new Error(`dry run: ${path} was written as text`);
  }

  async writeText(path: string, content: string): Promise<void> {
    this.#written.set(path, content);
  }

  async writeBytes(path: string, content: Uint8Array): Promise<void> {
    this.#written.set(path, content);
  }

  async mkdir(_path: string): Promise<void> {}

  async listFiles(dir: string): Promise<string[]> {
    const prefix = dir === "" ? "" : `${dir}/`;
    const all = new Set(await this.#base.listFiles(dir));
    for (const path of this.#written.keys()) if (path.startsWith(prefix)) all.add(path);
    return [...all].sort();
  }

  async listEntries(dir: string): Promise<string[]> {
    const base = (await this.#base.listEntries?.(dir)) ?? [];
    const prefix = dir === "" ? "" : `${dir}/`;
    const all = new Set(base);
    for (const path of this.#written.keys()) {
      if (!path.startsWith(prefix)) continue;
      const entry = path.slice(prefix.length).split("/")[0];
      if (entry !== undefined && entry !== "") all.add(entry);
    }
    return [...all].sort();
  }

  async isSymbolicLink(path: string): Promise<boolean> {
    if (this.#written.has(path)) return false;
    return (await this.#base.isSymbolicLink?.(path)) ?? false;
  }

  async remove(path: string): Promise<void> {
    // A dry run never removes: the command's removal is not carried over.
    this.#written.delete(path);
  }

  async createText(path: string, content: string): Promise<boolean> {
    if (await this.exists(path)) return false;
    this.#written.set(path, content);
    return true;
  }
}
