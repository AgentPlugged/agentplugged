/**
 * The common memory of the creator's products: one encrypted file per promoted
 * lesson, kept on the machine, outside every repository (`~/.agentplugged/memory/`). The port is
 * the folder; the encryption and the rules are the engine's (`memory-files.ts`). Nothing here
 * ever leaves the machine.
 */
export interface CommonMemory {
  /** The entry ids (`C-…`) present, in any order. */
  list(): Promise<readonly string[]>;
  /** The encrypted text of an entry, or undefined when there is none. */
  read(id: string): Promise<string | undefined>;
  /** Writes an entry (atomically), replacing any previous text. */
  write(id: string, text: string): Promise<void>;
}

/** A common memory in memory: tests, and processes that must not touch the user's folder. */
export class MemoryCommonMemory implements CommonMemory {
  readonly entries = new Map<string, string>();

  async list(): Promise<readonly string[]> {
    return [...this.entries.keys()];
  }

  async read(id: string): Promise<string | undefined> {
    return this.entries.get(id);
  }

  async write(id: string, text: string): Promise<void> {
    this.entries.set(id, text);
  }
}
