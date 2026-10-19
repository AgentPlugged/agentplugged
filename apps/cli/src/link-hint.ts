import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Translate } from "@agentplugged/i18n";

/**
 * The one line that ends `init` when this product is not linked to the web app yet: the command
 * that does it, nothing asked, nothing done. The method works alone either way. Whether the product
 * is already served is read from the bridge's own registry on this machine (a file the bridge
 * writes; this program never writes it), the way `bridge` finds its program: the command line only
 * launches the bridge and holds none of its logic.
 */

/** Where the bridge keeps its files on each system (the same folders the bridge uses). */
function bridgeDataDir(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): string {
  const given = env.AGENTPLUGGED_BRIDGE_HOME?.trim();
  if (given) return resolve(given);
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();
  const usable = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed && isAbsolute(trimmed) ? trimmed : undefined;
  };
  if (platform === "win32") {
    return join(
      usable(env.LOCALAPPDATA) ?? join(home, "AppData", "Local"),
      "AgentPlugged",
      "bridge",
    );
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "AgentPlugged", "bridge");
  }
  return join(
    usable(env.XDG_STATE_HOME) ?? join(home, ".local", "state"),
    "agentplugged",
    "bridge",
  );
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** True when this machine is linked to an account and serves the product in `root`. */
export async function isLinkedToWebApp(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): Promise<boolean> {
  const dir = bridgeDataDir(env, platform);
  if ((await readJson(join(dir, "binding.json"))) === undefined) return false;
  const registry = (await readJson(join(dir, "products.json"))) as
    | { products?: Array<{ path?: unknown }> }
    | undefined;
  const same = (a: string, b: string): boolean =>
    platform === "win32"
      ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
      : resolve(a) === resolve(b);
  return (registry?.products ?? []).some(
    (entry) => typeof entry.path === "string" && same(entry.path, root),
  );
}

/** The line, or nothing when the product is linked already. */
export async function linkHint(
  t: Translate,
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): Promise<string | undefined> {
  if (await isLinkedToWebApp(root, env, platform)) return undefined;
  return `\n${t("init.link.hint")}\n`;
}
