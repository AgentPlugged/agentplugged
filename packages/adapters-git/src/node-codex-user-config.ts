import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CodexUserConfig } from "@agentplugged/core";

/**
 * The user's `config.toml` of Codex (`$CODEX_HOME/config.toml`, `~/.codex/config.toml` by default),
 * where Codex records the hooks the creator approved. Read and written only by the question
 * `init`/`sync` asks the creator, with the merged text. The write goes through a
 * temporary file in the same folder, then a rename: a crash never leaves a half-written file.
 */
export class NodeCodexUserConfig implements CodexUserConfig {
  readonly path: string;

  constructor(options: { readonly home?: string; readonly codexHome?: string } = {}) {
    const codexHome = options.codexHome?.trim();
    this.path = join(
      codexHome !== undefined && codexHome !== ""
        ? codexHome
        : join(options.home ?? homedir(), ".codex"),
      "config.toml",
    );
  }

  async read(): Promise<string | undefined> {
    try {
      return await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(text: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // A link (a dotfiles manager) stays a link: the real file is the one replaced.
    let target = this.path;
    try {
      target = await realpath(this.path);
    } catch {
      // Missing: created below.
    }
    const temporary = `${target}.agentplugged-${process.pid}.tmp`;
    try {
      await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    } finally {
      // Gone after a rename; left behind when the rename was refused (the file is held open).
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
