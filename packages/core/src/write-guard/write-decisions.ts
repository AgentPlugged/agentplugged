import { blockOf } from "../docs/architecture-decisions.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { normalizeText } from "../init/generated.js";
import { settle } from "./write-path.js";
import { globSource, pathSuffixes } from "./write-scope.js";

/**
 * The architecture decisions the guard before a write can check (AD-n). A decision is
 * checked only when its block holds a line in the **checkable form**, which the architecture
 * declares itself:
 *
 * - `Guard: no dependency <name>`: no manifest (`package.json`, `requirements.txt`, `Cargo.toml`…)
 *   is written with that dependency;
 * - `Guard: never import <module> from <folder or glob>`: no file there is written with an import
 *   of that module (a package, or a folder of the project).
 *
 * `Garde :`, `pas de dépendance <nom>` and `jamais importer <module> depuis <dossier>` say the same.
 * Anything else a decision says is prose: it is not a rule, and a write is never refused for it.
 */

/** One checkable line of a decision. */
export type Guard =
  | { readonly id: string; readonly kind: "dependency"; readonly name: string }
  | {
      readonly id: string;
      readonly kind: "import";
      readonly module: string;
      readonly from: string;
    };

/** The checkable decisions of an architecture, and how many active decisions it has without one. */
export interface DecisionGuards {
  readonly guards: readonly Guard[];
  /** Active decisions (`AD-n`, not retired) that state no checkable line. */
  readonly unverifiable: number;
}

const LABEL =
  /^\s*(?:[-*+]\s+|\d{1,9}[.)]\s+)?(?:\*\*|__)?\s*(?:guard|garde)\s*(?::\s*(?:\*\*|__)?|(?:\*\*|__)\s*:)\s*/i;

const NAME = "[`'\"]?([@\\w][\\w@./:-]{0,99}?)[`'\"]?";
const NO_DEPENDENCY = new RegExp(
  `^(?:no|aucune?|pas de)\\s+(?:dependency|d[ée]pendance)\\s+${NAME}\\s*[.;]?$`,
  "i",
);
const NEVER_IMPORT = new RegExp(
  `^(?:never\\s+import|jamais\\s+(?:d['’]import(?:er)?(?:\\s+de)?|importer))\\s+${NAME}\\s+(?:from|depuis)\\s+[\`'"]?([\\w@./*-]{1,200}?)[\`'"]?\\s*[.;]?$`,
  "i",
);

/** The checkable lines of the active decisions of an architecture document. */
export function decisionGuards(path: string, text: string): DecisionGuards {
  const parsed = parseDocumentFile(path, text);
  const lines = normalizeText(text).normalize("NFC").split("\n");
  const guards: Guard[] = [];
  let unverifiable = 0;
  for (const definition of parsed.definitions) {
    if (!/^AD-\d{1,4}$/.test(definition.id) || definition.retired) continue;
    const before = guards.length;
    for (const line of blockOf(lines, definition.line - 1)) {
      const label = LABEL.exec(line);
      if (label === null) continue;
      // A closing mark of bold, but not the `**` of a glob (`src/ui/**`).
      const rule = line
        .slice(label[0].length)
        .replace(/(?<!\/)(?:\*\*|__)\s*$/, "")
        .trim();
      const dependency = NO_DEPENDENCY.exec(rule);
      if (dependency !== null) {
        guards.push({ id: definition.id, kind: "dependency", name: dependency[1] ?? "" });
        continue;
      }
      const forbidden = NEVER_IMPORT.exec(rule);
      if (forbidden !== null) {
        guards.push({
          id: definition.id,
          kind: "import",
          module: forbidden[1] ?? "",
          from: forbidden[2] ?? "",
        });
      }
    }
    if (guards.length === before) unverifiable++;
  }
  return { guards, unverifiable };
}

/** The manifests where a dependency is declared, by file name. */
const MANIFESTS = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

const escapeText = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A glob or a folder (`src/ui/**`, `src/ui/`, `src/ui`) as a test on a path, at any depth of it. */
function globTest(glob: string): (path: string) => boolean {
  const folder = glob.endsWith("/") || (!/[*?]/.test(glob) && !/\.[A-Za-z0-9]{1,6}$/.test(glob));
  // The same glob as the scope's (jokers folded and bounded), compared without regard to case.
  const regex = new RegExp(
    `^${globSource(glob.replace(/\/$/, ""))}${folder ? "(?:/.*)?" : ""}$`,
    "i",
  );
  return (path) => pathSuffixes(path).some((candidate) => regex.test(candidate));
}

/** True when `text` declares `name` as a dependency (the name as a whole word, not a part of one). */
function declares(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w@/.-])${escapeText(name)}(?![\\w.-])`).test(text);
}

const IMPORT_LINE = /\b(?:import|from|require|include|using|load|source|export)\b/;
const QUOTED = /(["'`])([^"'`\n]{1,300})\1/g;

/**
 * True when the file `path` writes `text` with an import of `module`: a package (`pg`, `pg/lib`) or
 * a folder of the project (`src/db/`), whether it is written from the root or relative to `path`.
 */
function imports(text: string, module: string, path: string): boolean {
  const bare = module.replace(/\/$/, "");
  // Blanks of the line only (`[ \t]`, never `\s`, which would run over the blank lines before it).
  const python = new RegExp(
    `^[ \\t]*(?:import|from)[ \\t]+${escapeText(bare.replaceAll("/", "."))}(?:[.\\s,]|$)`,
    "m",
  );
  const rust = new RegExp(`^[ \\t]*use[ \\t]+${escapeText(bare)}(?:::|;)`, "m");
  if (python.test(text) || rust.test(text)) return true;
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  for (const line of text.split("\n")) {
    if (!IMPORT_LINE.test(line)) continue;
    for (const match of line.matchAll(QUOTED)) {
      const written = match[2] ?? "";
      const relative = written.startsWith(".");
      // A relative import is placed from the folder of the file that writes it.
      const value = relative ? settle(`${folder}/${written}`) : written;
      if (value === undefined) continue;
      if (value === bare || value.startsWith(`${bare}/`)) return true;
      if (relative && (value.endsWith(`/${bare}`) || value.includes(`/${bare}/`))) return true;
    }
  }
  return false;
}

/** A decision the write contradicts, and what in it does: a dependency or a module, never a value. */
export interface DecisionViolation {
  readonly decision: string;
  readonly detail: string;
}

/**
 * The first checkable decision a write contradicts, or undefined. `path` is relative to the
 * story's working copy; `text` is what the write adds (the content, the replacement).
 */
export function decisionViolation(
  guards: readonly Guard[],
  path: string,
  text: string,
): DecisionViolation | undefined {
  const name = path.split("/").at(-1) ?? "";
  for (const guard of guards) {
    if (guard.kind === "dependency") {
      if (MANIFESTS.has(name) && declares(text, guard.name)) {
        return { decision: guard.id, detail: `dependency ${guard.name}` };
      }
    } else if (globTest(guard.from)(path) && imports(text, guard.module, path)) {
      return { decision: guard.id, detail: `import of ${guard.module} from ${guard.from}` };
    }
  }
  return undefined;
}
