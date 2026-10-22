import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type KimiHooksState,
  kimiHooksState,
  withKimiHooks,
  withoutKimiHooks,
} from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";

/**
 * `agentplugged kimi-hooks install|remove|status`: the one place that touches the user's own Kimi
 * settings (`~/.kimi-code/config.toml`, or `$KIMI_CODE_HOME/config.toml`), where Kimi Code CLI
 * keeps its hooks. `sync` never writes there. The command adds, replaces or removes only the block
 * between its two markers (`@agentplugged/core`, `sync/kimi-hooks.ts`), copies the file first, and
 * does nothing when there is nothing to do.
 */

interface Environment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly engineVersion: string;
  /** The program of the engine that runs this command, when it can be named (tests give theirs). */
  readonly entry?: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => number;
}

/** The folder of Kimi's settings: `$KIMI_CODE_HOME`, else `.kimi-code` in the home folder. */
export function kimiHome(env: Readonly<Record<string, string | undefined>>): string {
  const given = env.KIMI_CODE_HOME?.trim();
  if (given) return given;
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();
  return join(home, ".kimi-code");
}

/** The user's Kimi settings file. */
export function kimiConfigPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(kimiHome(env), "config.toml");
}

/** The words that run the engine from the hook: this very version, through `npx`. */
export function kimiEngine(engineVersion: string): string {
  return `npx -y agentplugged@${engineVersion}`;
}

/** The program of this engine (`bin.js` next to the code that runs), or undefined for a test or a bundle without it. */
export function ownEntry(): string | undefined {
  try {
    const entry = fileURLToPath(new URL("./bin.js", import.meta.url));
    return existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

async function readIfThere(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

/** What the user's settings hold of the product's hooks; `missing` when the file cannot be read. */
export async function readKimiHooksState(
  env: Readonly<Record<string, string | undefined>>,
  engineVersion: string,
): Promise<KimiHooksState> {
  try {
    return kimiHooksState(
      await readIfThere(kimiConfigPath(env)),
      kimiEngine(engineVersion),
      existsSync,
    );
  } catch {
    return "missing";
  }
}

/** A name for the copy made before a write: the file's name, then the time to the second. */
function backupPath(path: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${path}.agentplugged-backup-${stamp}`;
}

/** Runs the command; the exit code. */
export async function runKimiHooks(
  environment: Environment,
  t: Translate,
  args: readonly string[],
): Promise<number> {
  const [action, ...extra] = args;
  if ((action !== "install" && action !== "remove" && action !== "status") || extra.length > 0) {
    environment.stderr(`${t("kimi_hooks.usage")}\n`);
    return 1;
  }
  const path = kimiConfigPath(environment.env);
  const engine = kimiEngine(environment.engineVersion);
  const entry = environment.entry ?? ownEntry();
  const say = (key: Parameters<Translate>[0], params: Record<string, string> = {}) =>
    environment.stdout(`${t(key, { path, ...params })}\n`);
  let text: string | undefined;
  try {
    text = await readIfThere(path);
  } catch (error) {
    environment.stderr(
      `${t("kimi_hooks.unreadable", { path, reason: error instanceof Error ? error.message : String(error) })}\n`,
    );
    return 1;
  }
  if (action === "status") {
    say(`kimi_hooks.status.${kimiHooksState(text, engine, existsSync)}`);
    return 0;
  }
  const edit =
    action === "install" ? withKimiHooks(text, engine, entry) : withoutKimiHooks(text ?? "");
  if (edit.kind === "refused") {
    environment.stderr(`${t(`kimi_hooks.refused.${edit.reason}`, { path })}\n`);
    return 1;
  }
  if (edit.kind === "unchanged") {
    say(action === "install" ? "kimi_hooks.already" : "kimi_hooks.nothing_to_remove");
    return 0;
  }
  try {
    let backup: string | undefined;
    if (text !== undefined) {
      const base = backupPath(path, (environment.now ?? Date.now)());
      // A copy already there (the same second) is never overwritten: the next free name.
      for (let n = 0; backup === undefined; n++) {
        const candidate = n === 0 ? base : `${base}-${n}`;
        try {
          await copyFile(path, candidate, constants.COPYFILE_EXCL);
          backup = candidate;
        } catch (error) {
          if ((error as { code?: string }).code !== "EEXIST" || n > 50) throw error;
        }
      }
    }
    if (edit.text === "" && action === "remove") {
      // Nothing else was in the file: it goes, the copy stays.
      await rm(path);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, edit.text, "utf8");
    }
    say(
      action === "install" ? "kimi_hooks.installed" : "kimi_hooks.removed",
      backup === undefined ? { backup: t("kimi_hooks.no_backup") } : { backup },
    );
    return 0;
  } catch (error) {
    environment.stderr(
      `${t("kimi_hooks.unwritable", { path, reason: error instanceof Error ? error.message : String(error) })}\n`,
    );
    return 1;
  }
}
