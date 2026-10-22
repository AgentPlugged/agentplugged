import { DOMAIN_IDS, type MethodConfig } from "@agentplugged/protocol";
import { KNOWLEDGE_BASE_WRITER } from "../docs/knowledge-base.js";
import type { WorkspaceFiles } from "../workspace-files.js";

/**
 * Root entries that say nothing about the product, in lowercase: Git, the method,
 * the files of the AI tools and coding assistants, the hosting of the repository, and what a fresh
 * repository or an editor brings.
 */
const NOT_THE_PRODUCT: ReadonlySet<string> = new Set([
  ".git",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".gitkeep",
  ".github",
  ".agentplugged",
  "agents.md",
  "claude.md",
  "gemini.md",
  ".claude",
  ".agents",
  ".codex",
  ".cursor",
  ".cursorrules",
  ".cursorignore",
  ".gemini",
  ".kimi-code",
  ".mcp.json",
  ".windsurf",
  ".windsurfrules",
  ".continue",
  ".editorconfig",
  ".vscode",
  ".vs",
  ".idea",
  ".fleet",
  ".zed",
  ".devcontainer",
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
]);

/** README, licence and copying files, whatever their extension. */
const NOT_THE_PRODUCT_PREFIXES = ["readme", "license", "licence", "copying"] as const;

/** What installing agentplugged with a package manager leaves at the root. */
const PACKAGE_MANIFEST = "package.json";
const INSTALL_ENTRIES: ReadonlySet<string> = new Set([
  "node_modules",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

/** The dependency sections of a `package.json`. */
const DEPENDENCY_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function isProductEntry(name: string): boolean {
  const lower = name.toLowerCase();
  if (NOT_THE_PRODUCT.has(lower) || lower.startsWith(".aider")) return false;
  return !NOT_THE_PRODUCT_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix}.`),
  );
}

/**
 * True when `package.json` only installs agentplugged: its one dependency, in any section, is
 * `agentplugged`. Unreadable or anything else: the product's own manifest.
 */
async function installsOnlyAgentplugged(files: WorkspaceFiles): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(await files.readText(PACKAGE_MANIFEST));
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return false;
    const names = new Set<string>();
    for (const key of DEPENDENCY_KEYS) {
      const section = (manifest as Record<string, unknown>)[key];
      if (section === undefined) continue;
      if (typeof section !== "object" || section === null) return false;
      for (const name of Object.keys(section)) names.add(name);
    }
    return names.size === 1 && names.has("agentplugged");
  } catch {
    return false;
  }
}

/**
 * True when the product's folder already holds the product: an entry at its root
 * other than those of `NOT_THE_PRODUCT` (and `.aider*`), a README, a licence, or what installing
 * agentplugged alone leaves (a `package.json` whose one dependency is `agentplugged`, its lock
 * file, `node_modules`). `init` asks before it writes anything. False when the files cannot be
 * listed or read: `init` never fails on it.
 */
export async function detectExistingProduct(files: WorkspaceFiles): Promise<boolean> {
  if (files.listEntries === undefined) return false;
  try {
    const entries = (await files.listEntries("")).filter(isProductEntry);
    if (!entries.some((name) => name.toLowerCase() === PACKAGE_MANIFEST)) return entries.length > 0;
    const install = await installsOnlyAgentplugged(files);
    return entries.some(
      (name) =>
        !install ||
        (name.toLowerCase() !== PACKAGE_MANIFEST && !INSTALL_ENTRIES.has(name.toLowerCase())),
    );
  } catch {
    return false;
  }
}

/**
 * True when the method came to a product that already existed: `origin: existing`, or no
 * `origin` and the `maintenance` profile. `origin: new` (the creator's word) says otherwise.
 */
export function isExistingProduct(config: MethodConfig): boolean {
  if (config.origin !== undefined) return config.origin === "existing";
  return config.profile?.preset === "maintenance";
}

/**
 * True when `next` may call Zoé for the knowledge base: an existing product, the `docs` domain
 * on (every domain without a profile), and Zoé neither inactive nor disabled.
 */
export function knowledgeBaseExpected(config: MethodConfig): boolean {
  const domains = config.profile?.domains ?? DOMAIN_IDS;
  const off = [...(config.agents?.inactive ?? []), ...(config.agents?.disabled ?? [])];
  return (
    isExistingProduct(config) && domains.includes("docs") && !off.includes(KNOWLEDGE_BASE_WRITER)
  );
}
