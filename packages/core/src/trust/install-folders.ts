import type { CommandContext } from "../command.js";
import type { WorkspaceFiles } from "../workspace-files.js";

/**
 * Where an installation runs. A developer launched in the main repository writes
 * `cd <working copy of the story> && npm install …` (or `npm --prefix`, `pnpm -C`, `yarn --cwd`):
 * the engine reads the command as run **in that working copy**, and reads that copy's manifest and
 * lockfiles, but only when the folder is a working copy of a story of this product that the journal
 * knows (`story.started` and its `worktree`). Any other folder is not read: never a free path, never
 * `..`, never a symbolic link that leaves the working copy.
 */

/**
 * Port through which `core` opens a folder of the machine other than the product's own: the working
 * copy of a story. Implemented in `adapters-git`. It gives the files of `absolute` only when it is a
 * real folder: it exists, is not a symbolic link, and none of its parents is one (its real path is
 * the very path asked); undefined otherwise. Read only.
 */
export interface FolderReader {
  open(absolute: string): Promise<WorkspaceFiles | undefined>;
}

/** A folder an installation runs in: its files, and whose it is. */
export interface InstallFolder {
  readonly files: WorkspaceFiles;
  /** `root`: the product's own folder; else the id of the story whose working copy it is. */
  readonly scope: string;
}

/** The product's own folder as the scope of an installation. */
export const ROOT_SCOPE = "root";

/**
 * Finds the folder an installation runs in: `workdir` is the folder the command itself names (a
 * `cd`, `--prefix`, `-C`, `--cwd`), undefined when it names none (the folder the tool runs the
 * command in is then the one the hook gave). Undefined when the folder is unknown or not allowed.
 */
export type InstallFolders = (workdir: string | undefined) => Promise<InstallFolder | undefined>;

/** The folders of a product that has no working copy: only its own. */
export function onlyRoot(files: WorkspaceFiles): InstallFolders {
  return async (workdir) => (workdir === undefined ? { files, scope: ROOT_SCOPE } : undefined);
}

/** True for the platforms whose file names are compared without their case. */
const caseInsensitive = (platform: string | undefined) => platform === "win32";

/**
 * One folder as a key to compare: separators `/`, no repeated nor trailing separator, a Git Bash
 * drive (`/c/Users`) as `C:/Users` on Windows, lower case on Windows. Not a safety check by itself
 * (`plainFolder` is).
 */
export function folderKey(path: string, platform?: string): string {
  let text = path
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/");
  if (platform === "win32") text = text.replace(/^\/([A-Za-z])(?=\/|$)/, "$1:");
  text = text.replace(/\/+$/, "");
  return caseInsensitive(platform) ? text.toLowerCase() : text;
}

/**
 * A folder written in a command, kept only when it is plain: absolute (a drive or a root), made of
 * names and nothing else (no `..`, `.`, `~`, variable, glob, quote, backslash, space at the end of a
 * name, or a Windows alternate stream), so that what the shell goes to is what the engine reads. The
 * text as written otherwise, undefined for anything else.
 */
export function plainFolder(text: string, platform?: string): string | undefined {
  if (text === "" || text.length > 1000) return undefined;
  if (!/^[A-Za-z0-9_./:+@%\- ]+$/.test(text)) return undefined;
  if (text.includes("\\") || text.startsWith("//")) return undefined;
  const absolute = text.startsWith("/") || /^[A-Za-z]:\//.test(text);
  if (!absolute) return undefined;
  // A drive's colon only: `C:/…`; any other `:` would be a stream or a device on Windows.
  const rest = /^[A-Za-z]:/.test(text) ? text.slice(2) : text;
  if (rest.includes(":")) return undefined;
  if (text !== text.trim()) return undefined;
  for (const name of text.split("/").slice(/^[A-Za-z]:/.test(text) ? 1 : 0)) {
    if (name === "." || name === "..") return undefined;
    if (name !== "" && /[. ]$/.test(name)) return undefined;
  }
  return text;
}

/** The last name of a folder path, and its parent folder (both as written). */
function split(path: string): { parent: string; name: string } | undefined {
  const text = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  const at = text.lastIndexOf("/");
  if (at < 0) return undefined;
  const name = text.slice(at + 1);
  return name === "" ? undefined : { parent: text.slice(0, at), name };
}

/** The working copies of the stories the journal knows, by the key of their folder. */
export interface StoryFolder {
  readonly story: string;
  readonly absolute: string;
}

/**
 * The working copy of each story that started (`story.started`), as an absolute path: the engine
 * writes it `../<product folder>.worktrees/<story id>`, relative to the product's folder. Any other
 * shape is not a working copy of this product and is left out.
 */
export function storyFolders(
  root: string,
  stories: Readonly<Record<string, { readonly started?: { readonly worktree: string } }>>,
  platform?: string,
): Map<string, StoryFolder> {
  const folders = new Map<string, StoryFolder>();
  const product = split(root);
  if (product === undefined) return folders;
  for (const [story, state] of Object.entries(stories)) {
    const worktree = state.started?.worktree;
    if (worktree === undefined) continue;
    const match = /^\.\.\/([^/]+)\.worktrees\/([^/]+)$/.exec(worktree);
    if (match === null || match[2] !== story) continue;
    if (folderKey(match[1] ?? "", platform) !== folderKey(product.name, platform)) continue;
    const absolute = `${product.parent}/${product.name}.worktrees/${story}`;
    folders.set(folderKey(absolute, platform), { story, absolute });
  }
  return folders;
}

/**
 * The installation folders of a call. `cwd` is the folder the tool runs the command
 * in, given by its hook; `root` is the product's folder. A folder is the product's own, or the
 * working copy of a story of this product, or unknown (undefined: never read as planned).
 */
export function installFolders(
  context: Pick<CommandContext, "files" | "folders" | "platform" | "chat">,
  stories: Readonly<Record<string, { readonly started?: { readonly worktree: string } }>>,
  cwd: string | undefined,
): InstallFolders {
  const root = context.chat?.project;
  const platform = context.platform;
  return async (workdir) => {
    if (root === undefined) return undefined;
    // A folder the command names is read from its text, and only a plain one; the one the hook
    // gives is the tool's own and read as it is.
    const text = workdir === undefined ? cwd : plainFolder(workdir, platform);
    if (text === undefined) return undefined;
    const key = folderKey(text, platform);
    if (key === folderKey(root, platform)) return { files: context.files, scope: ROOT_SCOPE };
    const found = storyFolders(root, stories, platform).get(key);
    if (found === undefined || context.folders === undefined) return undefined;
    // The folder opened is the one the journal names, never the text of the command.
    const files = await context.folders.open(found.absolute).catch(() => undefined);
    return files === undefined ? undefined : { files, scope: found.story };
  };
}
