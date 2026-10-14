/**
 * The scope of a story, for the guard before a write: the files and folders the
 * story names, read from its approved text, plus what the creator added (`scope_widen`). Pure: no
 * file, no journal. A path is compared relative to the story's working copy, with `/`.
 */

/** A file or a folder the story names. A folder ends with `/`; `*` and `**` are globs. */
export interface ScopeEntry {
  readonly pattern: string;
  readonly folder: boolean;
}

/** The extensions a bare file name is read as a file with (`economy.test.ts`), never prose. */
const FILE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|yaml|yml|toml|py|rs|go|java|kt|rb|php|css|scss|html|sql|sh|ps1|vue|svelte|swift|cs|cpp|c|h|lock|txt|tmpl|xml|ini|cfg|env";

const CODE_SPAN = /`([^`\n]{1,200})`/g;
const BARE_PATH = new RegExp(
  `(?<![\\w@./:~-])((?:\\./)?[\\w@.-]+(?:/[\\w@.*-]+)*\\.(?:${FILE_EXTENSIONS}))(?![\\w/-])`,
  "g",
);
// A path in running text needs a directory and a slash to be read: `packages/core/src/chat/`.
const BARE_FOLDER = /(?<![\w@./:~-])((?:\.\/)?[\w@.-]+(?:\/[\w@.*-]+)+\/)(?![\w])/g;

// A whole segment that is a placeholder, never a name: `<module>`, `{module}`, `[module]`, `:module`.
const TEMPLATE_SEGMENT =
  /^(?:<[A-Za-z_][\w-]*>|\{[A-Za-z_][\w-]*\}|\[[A-Za-z_][\w-]*\]|:[A-Za-z_][\w-]*)$/;

/** A token read as a path of the project, or undefined (a URL, an absolute path, a word). */
function pathOf(token: string): ScopeEntry | undefined {
  let text = token
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\{project-root\}\//, "")
    .replace(/^\.\//, "");
  // A placeholder segment stands for one name: a single folder or file, nothing wider.
  if (text.includes("/")) {
    // A path that opens with a placeholder has no literal folder to anchor it: it would name the whole tree.
    if (TEMPLATE_SEGMENT.test(text.split("/")[0] ?? "")) return undefined;
    text = text
      .split("/")
      .map((part) => (TEMPLATE_SEGMENT.test(part) ? "*" : part))
      .join("/");
  }
  // Annotations after a path: `file.ts:12`, `file.ts#L3`.
  text = text.replace(/[:#][\w,-]*$/, "");
  if (text === "" || text.length > 200) return undefined;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|~|[A-Za-z]:)/.test(text) || text.includes("//")) return undefined;
  if (
    text
      .replace(/\/$/, "")
      .split("/")
      .some((part) => part === ".." || part === "")
  ) {
    return undefined;
  }
  if (!/^[\w@.*/-]+$/.test(text)) return undefined;
  const folder = text.endsWith("/");
  // A name with no extension and no slash is a word, not a path.
  if (!folder && !text.includes("/") && !new RegExp(`\\.(?:${FILE_EXTENSIONS})$`).test(text)) {
    return undefined;
  }
  // A folder written without its slash in a code span (`packages/core/src/chat`): a folder when its
  // last name has no extension.
  if (!folder && text.includes("/") && !/\.[A-Za-z0-9]{1,6}$/.test(text.split("/").at(-1) ?? "")) {
    return { pattern: `${text}/`, folder: true };
  }
  return { pattern: text, folder };
}

/**
 * The files and folders a text names: those in code spans (`packages/core/src/chat/`), and those
 * written bare when they look like a file (`economy.test.ts`) or a folder (`a/b/`). A URL, an
 * absolute path or a word is no path. At most 200, in order, each once.
 */
export function pathsNamedIn(source: string): ScopeEntry[] {
  // The root of the project is no part of a path: `{project-root}/apps/cli/` is `apps/cli/`.
  const text = source.replaceAll("{project-root}/", "");
  const found = new Map<string, ScopeEntry>();
  const add = (token: string) => {
    const entry = pathOf(token);
    if (entry !== undefined && found.size < 200 && !found.has(entry.pattern)) {
      found.set(entry.pattern, entry);
    }
  };
  for (const match of text.matchAll(CODE_SPAN)) {
    // A span may hold several paths (`a.ts, b.ts`) or a command: read each word.
    for (const word of (match[1] ?? "").split(/[\s,;()]+/)) if (word !== "") add(word);
  }
  const outside = text.replace(CODE_SPAN, " ");
  for (const match of outside.matchAll(BARE_PATH)) add(match[1] ?? "");
  for (const match of outside.matchAll(BARE_FOLDER)) add(match[1] ?? "");
  return [...found.values()];
}

/** The most `*` a glob may hold (`**` counts for two): a glob with more matches nothing. */
export const MAX_JOKERS = 6;

/** A glob (`*` one name, `**` any depth, `?` one character) as a regular expression source. */
export function globSource(source: string): string {
  // Repeated jokers say nothing more and cost a lot to match: they are folded, and a glob with many
  // of them (written by hand, or by an agent whose widening the creator reads) matches nothing.
  const glob = source.replace(/(?:\*\*\/)+/g, "**/").replace(/\*{3,}/g, "**");
  if ((glob.match(/\*/g) ?? []).length > MAX_JOKERS) return "(?!)";
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char === "*") {
      if (glob.charAt(i + 1) === "*") {
        i++;
        if (glob.charAt(i + 1) === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** The path with its leading folders cut one by one: `a/b/c.ts` gives itself, `b/c.ts`, `c.ts`. */
export function pathSuffixes(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, index) => parts.slice(index).join("/"));
}

/** The folder of a file path (`a/b/c.ts` gives `a/b/`), `` at the root. */
function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at + 1);
}

const compiled = new WeakMap<ScopeEntry, RegExp>();

/** An entry as a test on a path: a folder by its start, a file whole; case aside (Windows, macOS). */
function regexOf(entry: ScopeEntry): RegExp {
  let regex = compiled.get(entry);
  if (regex === undefined) {
    regex = new RegExp(`^${globSource(entry.pattern)}${entry.folder ? "" : "$"}`, "i");
    compiled.set(entry, regex);
  }
  return regex;
}

/** True when `path` is the entry's file, inside its folder, or next to a file it names. */
function matches(entry: ScopeEntry, path: string): boolean {
  const regex = regexOf(entry);
  const folder = entry.folder ? "" : folderOf(entry.pattern).toLowerCase();
  // The path in the working copy, or in a folder of the product inside it (a monorepo's subfolder).
  for (const candidate of pathSuffixes(path)) {
    if (regex.test(candidate)) return true;
    // Next to a file the story names: a new neighbour is part of the same change.
    if (folder !== "" && folderOf(candidate).toLowerCase() === folder) return true;
  }
  return false;
}

/**
 * Safe exceptions: what a story never needs to name. Tests and their helpers, documents, the
 * method's own folders, generated output and lock files.
 */
const SAFE = [
  /(?:^|\/)__[a-z]+__\//i,
  /(?:^|\/)(?:tests?|spec|specs|e2e|fixtures?|docs?|\.agentplugged|\.claude|\.turbo|node_modules|dist|build|coverage|\.next|target)\//i,
  /\.(?:test|spec)\.[a-z0-9]+$/i,
  /\.(?:md|mdx|txt|rst)$/i,
  /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/i,
];

/** True when no story needs to name the path (safe exceptions). */
export function isSafePath(path: string): boolean {
  return SAFE.some((rule) => rule.test(path));
}

/**
 * Whether a path is inside the scope: a safe exception, or matched by an entry. `undefined` when
 * the scope holds no entry at all (nothing is known, so nothing can be refused).
 */
export function inScope(path: string, entries: readonly ScopeEntry[]): boolean | undefined {
  if (entries.length === 0) return undefined;
  if (isSafePath(path)) return true;
  return entries.some((entry) => matches(entry, path));
}

/**
 * The paths the creator added, as entries. A name with no slash and no extension (`scripts`) is a
 * folder here: the creator named it on purpose.
 */
export function widenedEntries(paths: readonly string[]): ScopeEntry[] {
  return paths.flatMap((path) => {
    const entry = pathOf(path);
    if (entry !== undefined) return [entry];
    return /^[\w@.*-]+$/.test(path) && path !== ".." ? [{ pattern: `${path}/`, folder: true }] : [];
  });
}
