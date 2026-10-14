import { sha256Hex } from "@agentplugged/crypto";
import type { Dependencies, DependencyEcosystem } from "@agentplugged/protocol";
import type { WorkspaceFiles } from "../workspace-files.js";
import { isEngineCommand, scriptParts } from "./command-match.js";
import { type InstallFolder, type InstallFolders, ROOT_SCOPE } from "./install-folders.js";

/**
 * Which installations the approved architecture plans, pure but for the few project
 * files it reads. The architecture declares its dependencies (`dependencies` in its header,
 * `trust/planned-dependencies.ts`); a command is « planned » only when **every** installation it
 * holds names declared packages, from the ecosystem's official registry, and nothing in the project
 * redirects that registry or runs code of its own at install time. In doubt, it is not planned: the
 * validation applies, as before. Never guessed.
 *
 * Three more things: the folder an installation runs in (`cd <working copy of a story>`,
 * `--prefix`, `-C`, `--cwd`), the **identity** of an installation (what an approval covers: the
 * manager, the packages, the options, never a version nor how the output is shown), and the level
 * « official »: an installation the architecture does not declare, but that is read without any
 * doubt and takes only plain names from the official registry.
 */

/** One installation a command holds, as the engine reads it. */
export type InstallTarget =
  /** Named packages (`npm install react`, `pip install requests`, `npx supabase …`). */
  | {
      readonly kind: "packages";
      readonly ecosystem: DependencyEcosystem;
      readonly manager: string;
      /** The verb as an approval compares it (`add`, `run` for a package runner, `install`…). */
      readonly verb: string;
      readonly packages: readonly string[];
      /** The options the command gives, lower case, as written. */
      readonly options: readonly string[];
      /** The arguments a package runner gives the program it runs (`npx supabase init --force`). */
      readonly runnerArgs?: readonly string[];
      /** The version of the package a runner runs, as written (`2.119.0`, `latest`), `""` for none. */
      readonly runnerVersion?: string;
      /** What a runner's tool is told to install (`npx expo install a b`): the packages and options read. */
      readonly runnerInstall?: {
        readonly names: readonly string[];
        readonly options: readonly string[];
      };
      /** The folder the command itself names (`cd`, `--prefix`, `-C`, `--cwd`), as written. */
      readonly workdir?: string;
    }
  /** The manifest's own dependencies (`npm install`, `npm ci`, `pnpm install`, `yarn`). */
  | {
      readonly kind: "manifest";
      readonly ecosystem: DependencyEcosystem;
      readonly manager: string;
      readonly verb: string;
      readonly options: readonly string[];
      readonly workdir?: string;
    }
  /**
   * An installation the engine cannot read: a source that is not the official registry (a URL, a
   * path, a Git repository, an alias, another registry or index), an option it does not know, a
   * requirements file, a shell construct. Never planned, never official.
   */
  | { readonly kind: "unreadable"; readonly manager: string };

/** What a command's installations come to. */
export interface InstallReading {
  /** The installations of the command, in order; empty when it holds none. */
  readonly targets: readonly InstallTarget[];
}

/** Characters a shell reads: a word that holds one is never a package. */
const SHELL_CHARS = /[$`;|&<>(){}*?~\\"'\r\n]/;

/**
 * How a command shows its output, which changes nothing about what it installs: `2>&1`, `>&2`,
 * `> /dev/null`, `2>/dev/null`, `&> /dev/null`. Any other redirection is not read.
 */
function withoutDecoration(words: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (/^\d?>&\d$/.test(word) || /^(?:\d?>>?|&>>?)\/dev\/null$/.test(word)) continue;
    if (/^(?:\d?>>?|&>>?)$/.test(word) && words[index + 1] === "/dev/null") {
      index += 1;
      continue;
    }
    kept.push(word);
  }
  return kept;
}

/** The words of a subcommand, quotes of a whole word taken off, output decoration left out. */
function wordsOf(subcommand: string): string[] {
  return withoutDecoration(
    subcommand
      .trim()
      .split(/\s+/)
      .filter((word) => word !== "")
      .map((word) => word.replace(/^(["'])(.*)\1$/, "$2")),
  );
}

/** Options that change nothing about where the packages come from, by manager family. */
const NPM_FLAGS = new Set([
  "-D",
  "--save-dev",
  "-P",
  "--save-prod",
  "-O",
  "--save-optional",
  "-E",
  "--save-exact",
  "--save",
  "--no-save",
  "--no-audit",
  "--no-fund",
  "--prefer-offline",
  "--legacy-peer-deps",
  "--ignore-scripts",
  "--frozen-lockfile",
  "--silent",
  "--dev",
  "--exact",
  "-y",
  "--yes",
]);
const PIP_FLAGS = new Set([
  "-q",
  "--quiet",
  "-u",
  "--upgrade",
  "--no-cache-dir",
  "--user",
  "--no-deps",
]);
const CARGO_FLAGS = new Set(["--dev", "-D", "--build", "--locked", "--quiet", "-q"]);
const GEM_FLAGS = new Set(["--no-document", "--no-ri", "--no-rdoc"]);
const NO_FLAGS = new Set<string>();

/** The options that name the folder a manager works in, by manager: `--prefix x`, `-C x`, `--cwd x`. */
const WORKDIR_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["--prefix"]),
  pnpm: new Set(["-C", "--dir"]),
  yarn: new Set(["--cwd"]),
  bun: new Set(["--cwd"]),
};

/** A name as a package manager of this ecosystem writes it: a plain name, never a source. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CRATE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const GO_MODULE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[A-Za-z0-9._~-]+)+$/;
const GEM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMPOSER_NAME = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/;

/** A version after a name: a range or a tag, never a source (`:` and `/` are sources). */
const VERSION = /^[\w.^~<>=*|+-]+$/;

/**
 * A name or a version that ends like a file (`evil.tgz`, `x.whl`, `y.gem`): the manager reads a
 * local archive of that name, and its scripts run. Never a name of the registry.
 */
const ARCHIVE_LIKE = /\.(?:tgz|tar|tar\.gz|tar\.bz2|tar\.xz|zip|whl|egg|gem|git|jar|nupkg|crate)$/i;

/** An npm spec, `name`, `name@version`, `@scope/name@version`: the name, or undefined. */
function npmPackage(spec: string): string | undefined {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : undefined;
  if (!NPM_NAME.test(name) || ARCHIVE_LIKE.test(name)) return undefined;
  if (version !== undefined && (!VERSION.test(version) || ARCHIVE_LIKE.test(version))) {
    return undefined;
  }
  return name;
}

/**
 * A Python requirement: `name`, `name==1.2`: the name, or undefined. An extra (`name[extra]`) installs
 * other packages: it is not read.
 */
function pypiPackage(spec: string): string | undefined {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:(?:==|>=|<=|~=|!=|>|<)([\w.*+-]+))?$/.exec(spec);
  if (match?.[1] === undefined || !PYPI_NAME.test(match[1]) || ARCHIVE_LIKE.test(match[1])) {
    return undefined;
  }
  if (match[2] !== undefined && ARCHIVE_LIKE.test(match[2])) return undefined;
  return match[1];
}

/** `name` or `name@version` (a crate, a Go module, a gem's `name`). */
function atVersion(spec: string, pattern: RegExp): string | undefined {
  const at = spec.indexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : undefined;
  if (!pattern.test(name) || ARCHIVE_LIKE.test(name)) return undefined;
  if (version !== undefined && (!VERSION.test(version) || ARCHIVE_LIKE.test(version))) {
    return undefined;
  }
  return name;
}

/** `vendor/package` or `vendor/package:^1.0` (Composer). */
function composerPackage(spec: string): string | undefined {
  const colon = spec.indexOf(":");
  const name = colon > 0 ? spec.slice(0, colon) : spec;
  const version = colon > 0 ? spec.slice(colon + 1) : undefined;
  if (!COMPOSER_NAME.test(name)) return undefined;
  if (version !== undefined && !VERSION.test(version)) return undefined;
  return name;
}

/** What an installation's arguments come to. */
interface ParsedArguments {
  readonly names: string[];
  readonly options: string[];
  readonly workdir?: string;
}

/**
 * Reads the packages and options of an installation's arguments, or undefined when any is not plain.
 * `folderFlags`: the options that name the folder the manager works in (`--prefix x`, `--prefix=x`).
 */
function readPackages(
  args: readonly string[],
  flags: ReadonlySet<string>,
  read: (spec: string) => string | undefined,
  folderFlags: ReadonlySet<string> = NO_FLAGS,
): ParsedArguments | undefined {
  const names: string[] = [];
  const options: string[] = [];
  let workdir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? "";
    if (SHELL_CHARS.test(word)) return undefined;
    if (word.startsWith("-")) {
      const equals = word.indexOf("=");
      const flag = equals > 0 ? word.slice(0, equals) : word;
      if (folderFlags.has(flag)) {
        const value = equals > 0 ? word.slice(equals + 1) : args[++index];
        if (value === undefined || value === "" || value.startsWith("-")) return undefined;
        if (SHELL_CHARS.test(value) || workdir !== undefined) return undefined;
        workdir = value;
        continue;
      }
      // A short option keeps its case (`-D` is not `-d`), a long one does not.
      const key = word.startsWith("--") ? word.toLowerCase() : word;
      if (!flags.has(key)) return undefined;
      options.push(key);
      continue;
    }
    const name = read(word);
    if (name === undefined) return undefined;
    names.push(name);
  }
  return { names, options, ...(workdir === undefined ? {} : { workdir }) };
}

const unreadable = (manager: string): InstallTarget => ({ kind: "unreadable", manager });

/** The target of named packages: unreadable when none is named or any is not plain. */
function packagesOf(
  parsed: ParsedArguments | undefined,
  base: { ecosystem: DependencyEcosystem; manager: string; verb: string },
): InstallTarget {
  if (parsed === undefined || parsed.names.length === 0) return unreadable(base.manager);
  return {
    kind: "packages",
    ...base,
    packages: parsed.names,
    options: parsed.options,
    ...(parsed.workdir === undefined ? {} : { workdir: parsed.workdir }),
  };
}

/** The installation a subcommand holds, or undefined when it holds none. */
function targetOf(subcommand: string): InstallTarget | undefined {
  const [program = "", ...rest] = wordsOf(subcommand);
  switch (program) {
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun": {
      // The folder option may come before the verb: `npm --prefix dir install x`, `pnpm -C dir add x`.
      const folderFlags = WORKDIR_FLAGS[program] ?? NO_FLAGS;
      let words = rest;
      let before: string | undefined;
      while (words[0] !== undefined && words[0].startsWith("-")) {
        const equals = words[0].indexOf("=");
        const flag = equals > 0 ? words[0].slice(0, equals) : words[0];
        if (!folderFlags.has(flag)) break;
        const value = equals > 0 ? words[0].slice(equals + 1) : words[1];
        if (value === undefined || value === "" || value.startsWith("-"))
          return unreadable(program);
        if (SHELL_CHARS.test(value) || before !== undefined) return unreadable(program);
        before = value;
        words = words.slice(equals > 0 ? 1 : 2);
      }
      const verb = words[0];
      const args = words.slice(1);
      const installing =
        verb !== undefined && ["install", "i", "add", "ci"].includes(verb) && program !== "yarn"
          ? verb
          : program === "yarn" && (verb === undefined || verb === "install" || verb === "add")
            ? (verb ?? "install")
            : undefined;
      if ((program === "pnpm" || program === "yarn") && verb === "dlx") {
        return runnerOf(program, args, before);
      }
      if (program === "bun" && verb === "x") return runnerOf(program, args, before);
      if (installing === undefined) return undefined;
      const parsed = readPackages(args, NPM_FLAGS, npmPackage, folderFlags);
      if (parsed === undefined) return unreadable(program);
      if (before !== undefined && parsed.workdir !== undefined) return unreadable(program);
      const workdir = before ?? parsed.workdir;
      const withFolder = workdir === undefined ? {} : { workdir };
      // `ci`, and an install or add without a name, install the manifest's own dependencies.
      if (parsed.names.length === 0) {
        return installing === "add"
          ? unreadable(program)
          : {
              kind: "manifest",
              ecosystem: "npm",
              manager: program,
              verb: installing === "ci" ? "ci" : "install",
              options: parsed.options,
              ...withFolder,
            };
      }
      if (installing === "ci") return unreadable(program);
      return {
        kind: "packages",
        ecosystem: "npm",
        manager: program,
        // `install`, `i` and `add` name the same thing: packages to add.
        verb: "add",
        packages: parsed.names,
        options: parsed.options,
        ...withFolder,
      };
    }
    case "npx":
    case "bunx":
      return runnerOf(program, rest, undefined);
    case "pip":
    case "pip3": {
      if (rest[0] !== "install") return undefined;
      return packagesOf(readPackages(rest.slice(1), PIP_FLAGS, pypiPackage), {
        ecosystem: "pypi",
        manager: program,
        verb: "install",
      });
    }
    case "python":
    case "python3": {
      if (rest[0] !== "-m" || rest[1] !== "pip" || rest[2] !== "install") return undefined;
      return packagesOf(readPackages(rest.slice(3), PIP_FLAGS, pypiPackage), {
        ecosystem: "pypi",
        manager: "pip",
        verb: "install",
      });
    }
    case "uv": {
      const pip = rest[0] === "pip" && rest[1] === "install";
      if (rest[0] !== "add" && !pip) return undefined;
      return packagesOf(readPackages(rest.slice(pip ? 2 : 1), PIP_FLAGS, pypiPackage), {
        ecosystem: "pypi",
        manager: "uv",
        verb: pip ? "pip install" : "add",
      });
    }
    case "poetry": {
      if (rest[0] !== "add") return undefined;
      return packagesOf(readPackages(rest.slice(1), PIP_FLAGS, pypiPackage), {
        ecosystem: "pypi",
        manager: "poetry",
        verb: "add",
      });
    }
    case "cargo": {
      if (rest[0] !== "add" && rest[0] !== "install") return undefined;
      return packagesOf(
        readPackages(rest.slice(1), CARGO_FLAGS, (spec) => atVersion(spec, CRATE_NAME)),
        { ecosystem: "crates", manager: "cargo", verb: rest[0] ?? "add" },
      );
    }
    case "go": {
      if (rest[0] !== "get" && rest[0] !== "install") return undefined;
      return packagesOf(
        readPackages(rest.slice(1), NO_FLAGS, (spec) => atVersion(spec, GO_MODULE)),
        { ecosystem: "go", manager: "go", verb: rest[0] ?? "get" },
      );
    }
    case "gem": {
      if (rest[0] !== "install") return undefined;
      return packagesOf(
        readPackages(rest.slice(1), GEM_FLAGS, (spec) =>
          GEM_NAME.test(spec) && !ARCHIVE_LIKE.test(spec) ? spec : undefined,
        ),
        { ecosystem: "rubygems", manager: "gem", verb: "install" },
      );
    }
    case "bundle": {
      if (rest[0] !== "add") return undefined;
      return packagesOf(
        readPackages(rest.slice(1), NO_FLAGS, (spec) =>
          GEM_NAME.test(spec) && !ARCHIVE_LIKE.test(spec) ? spec : undefined,
        ),
        { ecosystem: "rubygems", manager: "bundle", verb: "add" },
      );
    }
    case "composer": {
      if (rest[0] !== "require") return undefined;
      return packagesOf(readPackages(rest.slice(1), NO_FLAGS, composerPackage), {
        ecosystem: "packagist",
        manager: "composer",
        verb: "require",
      });
    }
    default:
      return undefined;
  }
}

/** What a package may be run with and still be only what the architecture planned. */
const RUNNER_ARGUMENTS = new Set(["--version", "-v", "--help", "-h", "init"]);

/**
 * Tools that install other packages from sources the engine would read (a package manager, an
 * installer): run through a runner they could take any source, so such a line is not read.
 */
const INSTALLER_TOOLS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "bunx",
  "pnpx",
  "pip",
  "pip3",
  "pipx",
  "uv",
  "uvx",
  "poetry",
  "corepack",
  "cargo",
  "gem",
  "composer",
]);

/**
 * What a program run by a runner may be given and still be read: no source (a URL, a scheme such as
 * `github:`, `file:`, a path that starts a directory, `../`, or `--option=<that>`) and none of the options
 * that name another registry, folder, package or code to load.
 */
const RUNNER_SOURCE_ARGUMENT = /(?:^|=)(?:[A-Za-z][A-Za-z0-9+.-]*:|\.{1,2}[\\/]|[\\/])/;
const RUNNER_RISKY_OPTION =
  /^--(?:registry|index-url|extra-index-url|userconfig|globalconfig|prefix|cwd|package|node-options|require|loader|import|eval|print)(?:=|$)/i;

/**
 * A package runner (`npx`, `bunx`, `pnpm dlx`): the first word that is not an option is the
 * package it downloads and runs, the rest are that program's own arguments. Only `-y` and
 * `--yes` are read as options before it. The arguments are read when they hold nothing a shell
 * reads; the architecture plans a run only with the few the engine knows (`RUNNER_ARGUMENTS`).
 */
function runnerOf(
  manager: string,
  words: readonly string[],
  workdir: string | undefined,
): InstallTarget {
  let index = 0;
  while (index < words.length && ["-y", "--yes"].includes((words[index] ?? "").toLowerCase())) {
    index += 1;
  }
  const spec = words[index];
  if (spec === undefined || spec.startsWith("-") || SHELL_CHARS.test(spec)) {
    return unreadable(manager);
  }
  const runnerArgs = words.slice(index + 1);
  if (runnerArgs.some((word) => SHELL_CHARS.test(word))) return unreadable(manager);
  const name = npmPackage(spec);
  if (name === undefined || INSTALLER_TOOLS.has(name)) return unreadable(manager);
  if (
    runnerArgs.some((word) => RUNNER_SOURCE_ARGUMENT.test(word) || RUNNER_RISKY_OPTION.test(word))
  ) {
    return unreadable(manager);
  }
  // A tool told to install (`npx expo install react`) installs what it names: those are read as the
  // packages of any installation (plain names of the registry, known options), or the line is not.
  const verbAt = runnerArgs.findIndex((word) => !word.startsWith("-"));
  let install: { names: string[]; options: string[] } | undefined;
  if (verbAt >= 0 && ["install", "add", "i"].includes(runnerArgs[verbAt] ?? "")) {
    const rest = runnerArgs.slice(verbAt + 1);
    const parsed = readPackages(rest, NPM_FLAGS, npmPackage);
    if (parsed === undefined || (parsed.names.length === 0 && rest.length > 0)) {
      return unreadable(manager);
    }
    install = { names: parsed.names, options: parsed.options };
  }
  return {
    kind: "packages",
    ecosystem: "npm",
    manager,
    verb: "run",
    packages: [name],
    options: [],
    runnerArgs,
    ...(install === undefined ? {} : { runnerInstall: install }),
    runnerVersion: spec.lastIndexOf("@") > 0 ? spec.slice(spec.lastIndexOf("@") + 1) : "",
    ...(workdir === undefined ? {} : { workdir }),
  };
}

/**
 * Programs that install, or run what they download: with a verb the engine does not read as a
 * harmless one, the installation is unreadable (never planned), not ignored. The verbs they take
 * that install nothing (`npm test`, `cargo build`) are listed.
 */
const HARMLESS_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set([
    "run",
    "run-script",
    "test",
    "t",
    "start",
    "build",
    "lint",
    "ls",
    "list",
    "view",
    "info",
    "outdated",
    "audit",
    "why",
    "help",
    "version",
  ]),
  pnpm: new Set([
    "run",
    "test",
    "t",
    "start",
    "build",
    "lint",
    "ls",
    "list",
    "view",
    "info",
    "outdated",
    "audit",
    "why",
    "help",
  ]),
  yarn: new Set([
    "run",
    "test",
    "start",
    "build",
    "lint",
    "ls",
    "list",
    "info",
    "why",
    "help",
    "version",
  ]),
  bun: new Set(["run", "test", "build", "pm", "help"]),
  pip: new Set(["list", "show", "freeze", "check", "help"]),
  pip3: new Set(["list", "show", "freeze", "check", "help"]),
  uv: new Set(["help", "version"]),
  poetry: new Set(["show", "check", "about", "help"]),
  cargo: new Set([
    "build",
    "test",
    "check",
    "run",
    "fmt",
    "clippy",
    "doc",
    "clean",
    "version",
    "help",
  ]),
  go: new Set(["build", "test", "vet", "fmt", "run", "version", "env", "list", "clean"]),
  gem: new Set(["list", "environment", "help"]),
  bundle: new Set(["help", "version"]),
  composer: new Set(["list", "validate", "show", "help"]),
  pipx: new Set(["list", "help"]),
  uvx: new Set(["help"]),
  brew: new Set(["list", "info", "search", "help"]),
};
const HARMLESS_FLAGS = new Set(["-v", "-V", "--version", "-h", "--help"]);

/** True for an installer called with a verb that installs nothing, or with no verb. */
function harmless(program: string, rest: readonly string[]): boolean {
  const verb = rest[0];
  if (verb === undefined) return program !== "yarn";
  if (verb.startsWith("-")) return HARMLESS_FLAGS.has(verb) && rest.length === 1;
  return HARMLESS_VERBS[program]?.has(verb) === true;
}

/** A shell started on a command line given to it: its inner commands are read on their own. */
const SHELL_WRAPPER = /^(?:ba|z|da|k)?sh\s+-[a-z]*c\b/;

/** Statements that change what the next command does: a variable, a directory, a shell setting. */
const CONTEXT_CHANGE =
  /^(?:export|declare|typeset|readonly|local|source|\.|eval|alias|unset|cd|pushd|popd|chdir)$/;

/**
 * How a command shows what it printed: `| tail -15`, `| head -n 20`, with a count and no file, which
 * only cut the output of the command before them. Any other filter (`grep`, `tee`, `sed`, a file
 * argument) is a command of its own, and not read.
 */
const OUTPUT_FILTER = /^(?:tail|head)(?:\s+(?:-n\s*\d{1,4}|-\d{1,4}))?$/;

/**
 * The only `cd` read: the line starts with it, followed by `&&` (a `cd` that fails stops the line, so
 * the installation never runs in the folder the tool was in), the folder a plain word or a quoted
 * one that holds only the characters of a path (`plainFolder` checks the rest).
 */
const CD_PREFIX =
  /^\s*cd\s+(?:"([A-Za-z0-9_./:+@%\- ]+)"|'([A-Za-z0-9_./:+@%\- ]+)'|([A-Za-z0-9_./:+@%-]+))[ \t]*&&[ \t]*/;

/** The first word of a command as written, an opening group and its quotes left out. */
function firstWord(text: string): string {
  return (
    text
      .trim()
      .replace(/^[({\s]+/, "")
      .split(/\s+/)[0] ?? ""
  ).replace(/^["']|["']$/g, "");
}

/**
 * The installations a command line holds: each subcommand the shell would run (the shell analyser
 * brings a line back to them, `bash -c`, `$(…)` and `&&` included), other than the
 * engine's own. An installation is read as such only when it is written plainly: the manager is
 * the first word (no variable before it, no `env`, `sudo`, `time`…), no directory, variable or shell
 * setting was changed before it in the same line (`export npm_config_registry=…`), and its verb is
 * one the engine reads. Anything else is `unreadable`: the validation applies.
 *
 * Two more things are read: one leading `cd <folder> &&` (the folder becomes the `workdir`
 * of every installation of the line, the engine then decides whether it is a working copy of a
 * story), and how the output is shown (`2>&1`, `| tail -15`), which is no part of the installation.
 * Any other `cd`, `pushd`, `;` after a `cd`, group or wrapper stays unreadable.
 */
export function readInstalls(command: string): InstallReading {
  const cd = CD_PREFIX.exec(command);
  const folder = cd === null ? undefined : (cd[1] ?? cd[2] ?? cd[3]);
  const body = cd === null ? command : command.slice(cd[0].length);
  // `cd x && a & b`: the shell runs `cd x && a` in the background, `b` where the tool was. A lone `&`
  // after a `cd` (not `&&`, `>&`, `&>`) leaves the folder of what follows unknown: nothing is read.
  if (cd !== null && /(?<![&>])&(?![&>])/.test(body.replaceAll(/\d?>&\d?|&>>?/g, " "))) {
    const names = scriptParts(body)
      .map((part) => wordsOf(part.command)[0] ?? "")
      .filter((name) => name !== "");
    return { targets: [unreadable(names[0] ?? "")] };
  }
  const parts = scriptParts(body);
  const changed = parts.some(
    (part) =>
      CONTEXT_CHANGE.test(firstWord(part.raw)) ||
      (part.command === "" && /^[A-Za-z_]\w*=/.test(firstWord(part.raw))),
  );
  const targets: InstallTarget[] = [];
  // Any other command on the line (an `echo` into `.npmrc`, a `sed` on `package.json`, a function
  // that shadows the manager, `npm run`, which runs the project's own code) could change what the
  // installation takes after the project's files were read: such a line is not read as planned.
  let foreign = false;
  for (const part of parts) {
    if (part.command === "" || isEngineCommand(part.command)) continue;
    // `bash -c "…"` only wraps what the shell analyser already read part by part.
    if (SHELL_WRAPPER.test(part.command)) continue;
    // `| tail -15`: the output of the command before it, cut.
    if (OUTPUT_FILTER.test(part.command)) continue;
    const words = wordsOf(part.command);
    const program = words[0] ?? "";
    let target = targetOf(part.command);
    if (target === undefined) {
      // `python -m pip …` is pip's: its verbs are read as pip's own.
      const asPip =
        (program === "python" || program === "python3") && words[1] === "-m" && words[2] === "pip";
      const manager = asPip ? "pip" : program;
      const rest = asPip ? words.slice(3) : words.slice(1);
      if (!Object.hasOwn(HARMLESS_VERBS, manager) || harmless(manager, rest)) {
        foreign = true;
        continue;
      }
      target = unreadable(manager);
    }
    if (changed || firstWord(part.raw).toLowerCase() !== program.toLowerCase()) {
      target = unreadable(target.manager);
    }
    // The folder of the `cd`: two folders named for one installation are not read.
    if (folder !== undefined && target.kind !== "unreadable") {
      target =
        target.workdir === undefined ? { ...target, workdir: folder } : unreadable(target.manager);
    }
    targets.push(target);
  }
  return {
    targets: foreign ? targets.map((target) => unreadable(target.manager)) : targets,
  };
}

/** A name as an ecosystem compares it: npm and crates are exact lower case, Python is PEP 503. */
export function normalizedName(ecosystem: DependencyEcosystem, name: string): string {
  if (ecosystem === "go") return name;
  const lower = name.toLowerCase();
  return ecosystem === "pypi" ? lower.replace(/[-_.]+/g, "-") : lower;
}

/**
 * Options that only change how the output looks, not what is installed: left out of the identity
 * of an installation (`--silent`, `--quiet`, `--no-fund`, `--yes`).
 */
const COSMETIC_OPTIONS = new Set([
  "--silent",
  "-q",
  "--quiet",
  "--no-fund",
  "--no-audit",
  "--prefer-offline",
  "--save",
  "-y",
  "--yes",
]);

/** The options that are two spellings of one: compared as the long one. */
const OPTION_ALIASES: Readonly<Record<string, string>> = {
  "-D": "--save-dev",
  "--dev": "--save-dev",
  "-P": "--save-prod",
  "-O": "--save-optional",
  "-E": "--save-exact",
  "--exact": "--save-exact",
  "-u": "--upgrade",
};

/** The options of an installation as an approval compares them: sorted, aliases joined, cosmetic left out. */
function identityOptions(options: readonly string[]): string {
  return [
    ...new Set(
      options
        .filter((option) => !COSMETIC_OPTIONS.has(option))
        .map((option) => OPTION_ALIASES[option] ?? option),
    ),
  ]
    .sort()
    .join(",");
}

/**
 * What an approval of an installation covers: the **identity** of what the command
 * installs, so that the same installation is one point however it is written.
 *
 * - it is, (« one validation covers the family of an action »): the ecosystem and
 *   the **names** of the packages (compared as the ecosystem does, in any order); for a package
 *   runner (`npx`, `pnpm dlx`, `bunx`), the executor, the tool **and its version as written**, never
 *   what the tool is told (`init`, `start`, `test db --linked`); for the manifest's own
 *   dependencies (`npm install`, `npm ci`, `pnpm install`, `yarn`), the working copy it runs in (what
 *   it installs is that copy's manifest);
 * - it is not: the manager (`npm install`, `npm ci` and `pnpm install` of one working copy are one
 *   approval), the verb (`install`, `i`, `add`, `ci`), the options the engine reads (they all leave
 *   the source of the packages as it is), a version of a package (`react-test-renderer@19` and
 *   `@19.2.3`), how the output is shown (`2>&1`, `| tail -15`), the folder of a named installation
 *   (another working copy of the product), the order of the packages.
 *
 * A package that is added or another registry is another installation. Undefined when the command
 * holds an installation the engine cannot read (an option it does not know, a source that is not
 * the official registry): its whole text is then what an approval covers.
 */
export function installIdentity(
  targets: readonly InstallTarget[],
  scopeOf: (target: InstallTarget) => string | undefined,
): string | undefined {
  if (targets.length === 0) return undefined;
  const entries: string[] = [];
  for (const target of targets) {
    if (target.kind === "unreadable") return undefined;
    if (target.kind === "manifest") {
      const scope = scopeOf(target);
      if (scope === undefined) return undefined;
      entries.push(["manifest", target.ecosystem, scope].join("|"));
      continue;
    }
    if (target.runnerArgs !== undefined) {
      // A package runner (`npx --yes supabase@2.119.0 start`): the installation is the tool at its
      // version, run by this executor. What the tool is then told (`init`, `start`, `test db`) is its
      // own business and no new installation; another version, another tool, another executor is.
      entries.push(
        [
          "runner",
          target.ecosystem,
          target.manager,
          normalizedName(target.ecosystem, target.packages[0] ?? ""),
          target.runnerVersion ?? "",
          // A tool told to install (`npx expo install leftpad`) installs what it names: those names
          // and options are part of the approval, as for any installation.
          target.runnerInstall === undefined
            ? ""
            : `${[...new Set(target.runnerInstall.names.map((name) => normalizedName(target.ecosystem, name)))].sort().join(",")} ${identityOptions(target.runnerInstall.options)}`,
        ].join("|"),
      );
      continue;
    }
    entries.push(
      [
        "packages",
        target.ecosystem,
        [...new Set(target.packages.map((name) => normalizedName(target.ecosystem, name)))]
          .sort()
          .join(","),
      ].join("|"),
    );
  }
  return `install-identity:v2\n${[...new Set(entries)].sort().join("\n")}`;
}

/**
 * The digest of an installation's identity. The control character in front keeps it apart from the
 * digest of any request text, which `normalizeDetail` never lets hold one.
 */
export function identityDigest(identity: string): string {
  return sha256Hex(`install_dependency\n\u0000${identity}`);
}

/** Files that point a package manager at another registry, or run code of the project's own. */
const REGISTRY_FILES: Readonly<Record<DependencyEcosystem, readonly string[]>> = {
  npm: [".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", "bunfig.toml"],
  pypi: ["pip.conf", "uv.toml"],
  crates: [".cargo/config.toml", ".cargo/config"],
  go: [],
  rubygems: [".gemrc", ".bundle/config"],
  packagist: [],
};

/** Words in a project file that name another registry or index. */
const REDIRECTS: Readonly<Record<DependencyEcosystem, RegExp | undefined>> = {
  npm: undefined,
  pypi: /index-url|extra-index|find-links|\[\[tool\.uv\.index\]\]|\[tool\.uv\.sources\]|tool\.poetry\.source|trusted-host/i,
  // `[patch]` and `[replace]` point a crate at another source, and so does a dependency taken from Git or a path.
  crates: /^\s*\[(?:patch|replace)\b|\bgit\s*=|\bpath\s*=/m,
  // `replace` points a module at another source (`go.mod`).
  go: /^\s*replace\b/m,
  // A source other than rubygems.org, or a gem taken from a repository or a path (the `Gemfile`).
  rubygems:
    /^\s*(?:source|git_source)\s+["'](?!https:\/\/rubygems\.org\/?["'])|\b(?:git|github|path):/m,
  packagist: /"repositories"/,
};

/** The project files that may redirect an ecosystem's registry, besides `REGISTRY_FILES`. */
const REDIRECT_SOURCES: Readonly<Record<DependencyEcosystem, readonly string[]>> = {
  npm: [],
  pypi: ["pyproject.toml", "requirements.txt"],
  crates: ["Cargo.toml"],
  go: ["go.mod"],
  rubygems: ["Gemfile"],
  packagist: ["composer.json"],
};

async function readIfThere(files: WorkspaceFiles, path: string): Promise<string | undefined> {
  try {
    return (await files.exists(path)) ? await files.readText(path) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the project redirects the ecosystem's registry or runs code of its own at install time:
 * a registry file (`.npmrc`, `.pnpmfile.cjs`, `pip.conf`, `.cargo/config.toml`…) is there, or a
 * manifest names another index or repository. The official source can no longer be told: the
 * installation is not planned.
 */
export async function registryRedirected(
  files: WorkspaceFiles,
  ecosystem: DependencyEcosystem,
): Promise<boolean> {
  for (const path of REGISTRY_FILES[ecosystem]) {
    if (await files.exists(path).catch(() => true)) return true;
  }
  const pattern = REDIRECTS[ecosystem];
  if (pattern !== undefined) {
    for (const path of REDIRECT_SOURCES[ecosystem]) {
      const text = await readIfThere(files, path);
      if (text !== undefined && pattern.test(text)) return true;
    }
  }
  return false;
}

/** The scripts npm, pnpm, yarn and bun run on their own when installing. */
const LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "preprepare",
  "postprepare",
  "prepublish",
];

/** Manifest fields that point a package at another source or change what is installed. */
const REDIRECTING_FIELDS = [
  "overrides",
  "resolutions",
  "pnpm",
  "bundledDependencies",
  "bundleDependencies",
  "dependenciesMeta",
  "patchedDependencies",
];

/** Project files that make an installation read something else than the manifest's registry names. */
const WORKSPACE_FILES = ["pnpm-workspace.yaml", "bun.lockb", ".pnpmfile.cjs", ".yarn/plugins"];

/** Lockfiles: every address they hold must be of the official registry. */
const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
];
const OFFICIAL_ADDRESS = /^https:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\//;

/**
 * A JSON lockfile without the fields that only carry a link for people to read (`funding`,
 * `homepage`, `repository`, `bugs`): they hold addresses that are no source of any package.
 */
function withoutLinks(path: string, text: string): string {
  if (!path.endsWith(".json")) return text;
  try {
    const drop = new Set(["funding", "homepage", "repository", "bugs", "author", "contributors"]);
    const clean = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(clean);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !drop.has(key))
          .map(([key, inner]) => [key, clean(inner)]),
      );
    };
    return JSON.stringify(clean(JSON.parse(text)));
  } catch {
    return text;
  }
}

/** True when a lockfile (npm, pnpm, yarn, bun) points anywhere but the official registry. */
async function lockfileRedirected(files: WorkspaceFiles): Promise<boolean> {
  for (const path of LOCKFILES) {
    const raw = await readIfThere(files, path);
    if (raw === undefined) continue;
    const text = withoutLinks(path, raw);
    const addresses =
      text.match(/(?:https?|git\+[a-z]+|ssh|file|link|github|gitlab|bitbucket):[^\s"',)]*/g) ?? [];
    for (const address of addresses) {
      if (!OFFICIAL_ADDRESS.test(address)) return true;
    }
  }
  return false;
}

/**
 * True when what an npm-family installation takes from the project is all planned: the
 * dependencies the manifest (`package.json`, at the root) lists are all declared, from the official
 * registry (a version, never a URL, a path or a Git source), the manifest holds no workspace, no
 * override or resolution, and runs no script of its own when installing, and no lockfile points
 * anywhere but the official registry. `absentOk`: an install that names its packages may create the
 * manifest. Anything else, an unreadable manifest included, is false.
 *
 * `declared` undefined (the level « official »): the names of the dependencies are not
 * compared, everything else is: what the manifest holds may come from the creator's earlier
 * decisions, but the manifest and the lockfiles must send nothing anywhere but the official registry
 * and run nothing at install time.
 */
export async function manifestPlanned(
  files: WorkspaceFiles,
  declared: ReadonlySet<string> | undefined,
  absentOk = false,
): Promise<boolean> {
  for (const path of WORKSPACE_FILES) {
    if (await files.exists(path).catch(() => true)) return false;
  }
  if (await lockfileRedirected(files)) return false;
  const text = await readIfThere(files, "package.json");
  if (text === undefined) return absentOk;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return false;
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const record = manifest as Record<string, unknown>;
  if (record.workspaces !== undefined) return false;
  if (REDIRECTING_FIELDS.some((field) => record[field] !== undefined)) return false;
  const manager = record.packageManager;
  if (typeof manager === "string" && /[:/]/.test(manager)) return false;
  const scripts = record.scripts;
  if (scripts !== null && typeof scripts === "object") {
    if (LIFECYCLE_SCRIPTS.some((name) => Object.hasOwn(scripts, name))) return false;
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const section = record[field];
    if (section === undefined) continue;
    if (section === null || typeof section !== "object" || Array.isArray(section)) return false;
    for (const [name, version] of Object.entries(section)) {
      if (declared !== undefined && !declared.has(normalizedName("npm", name))) return false;
      if (typeof version !== "string" || version.includes(":") || version.includes("/")) {
        return false;
      }
      if (ARCHIVE_LIKE.test(version.trim())) return false;
      if (!/^[\w.^~<>=*|\s-]*$/.test(version)) return false;
    }
  }
  return true;
}

/**
 * The level « official » can be switched off here: the engine then reads an installation
 * as planned or not, as before the story. A release changes it; the creator has no setting for it.
 */
export const OFFICIAL_LEVEL = true;

/**
 * The managers whose « official source » the engine can tell from the project's files: npm and its
 * runners, pip, cargo and gem. Go takes its sources from any Git repository, and composer, bundler,
 * uv and poetry run the project's own files (`composer.json` scripts, a `Gemfile`, a `pyproject.toml`):
 * their installations are planned (declared) or validated, never official.
 */
const OFFICIAL_MANAGERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "bunx",
  "pip",
  "pip3",
  "cargo",
  "gem",
]);

/** What `plannedInstall` says. */
export interface InstallVerdict {
  /** The installations of the command, in order; empty when it holds none. */
  readonly targets: readonly InstallTarget[];
  /**
   * The approved architecture plans this command: every package is declared, from the
   * official registry, in a project that redirects nothing and runs nothing at install time.
   */
  readonly planned: boolean;
  /**
   * The command is read without any doubt (every installation names plain packages of
   * the official registry, the folder is the product's or a working copy of one of its stories, the
   * project redirects nothing and runs nothing at install time), but the architecture does not
   * declare all of them. True for a planned command as well as for an undeclared one.
   */
  readonly official: boolean;
  /**
   * Why the command is not planned. `no_install`: it holds no installation; `no_architecture`: no
   * approved architecture declares anything; `undeclared`: a package the architecture does not
   * declare; `unreadable`: a source, an option or a shell construct the engine does not know;
   * `redirected`: the project redirects the registry or runs code at install time; `folder`: the
   * folder is not the product's nor a working copy of one of its stories.
   */
  readonly reason?:
    | "no_install"
    | "undeclared"
    | "unreadable"
    | "redirected"
    | "no_architecture"
    | "folder";
  /** What an approval covers (`installIdentity`): undefined when a part of the command is unreadable. */
  readonly identity?: string;
  /**
   * The story whose working copy every installation of the command runs in, when there is
   * one: an approval of the family of the action then holds for the whole story.
   */
  readonly story?: string;
}

/** An installation of a command and the folder it runs in. */
interface Resolved {
  readonly target: InstallTarget;
  readonly folder: InstallFolder | undefined;
}

/**
 * Whether a command's installations are all planned by the architecture (`declared`: the approved
 * architecture's dependencies, undefined when there is none): every installation names only
 * declared packages (or, for the manifest's own, a manifest that lists only declared ones), from
 * the official registry, in a project that redirects nothing. A command without an installation is
 * `no_install`, never planned: the gate does not let through what it did not read. `folders` finds
 * the folder of each installation (the product's, or the working copy of a story); without a known
 * folder nothing is read as planned nor official.
 */
export async function plannedInstall(
  command: string,
  declared: Dependencies | undefined,
  folders: InstallFolders,
): Promise<InstallVerdict> {
  const { targets } = readInstalls(command);
  if (targets.length === 0) {
    return { targets, planned: false, official: false, reason: "no_install" };
  }
  const resolved: Resolved[] = [];
  for (const target of targets) {
    resolved.push({
      target,
      folder: target.kind === "unreadable" ? undefined : await folders(target.workdir),
    });
  }
  const scopes = new Map<InstallTarget, string>();
  for (const entry of resolved) {
    if (entry.folder !== undefined) scopes.set(entry.target, entry.folder.scope);
  }
  // An approval never covers an installation whose folder is not the product's own nor a working
  // copy of one of its stories: the folder is then part of what the creator approved (the whole text).
  const identity = resolved.some(
    (entry) => entry.folder === undefined && entry.target.kind !== "unreadable",
  )
    ? undefined
    : installIdentity(targets, (target) => scopes.get(target));
  const stories = new Set([...scopes.values()].filter((scope) => scope !== ROOT_SCOPE));
  const story = stories.size === 1 ? [...stories][0] : undefined;
  const withIdentity = {
    ...(identity === undefined ? {} : { identity }),
    ...(story === undefined ? {} : { story }),
  };
  if (resolved.some((entry) => entry.target.kind === "unreadable")) {
    return { targets, planned: false, official: false, reason: "unreadable", ...withIdentity };
  }
  if (resolved.some((entry) => entry.folder === undefined)) {
    return { targets, planned: false, official: false, reason: "folder", ...withIdentity };
  }
  // Level « official »: plain names of the official registry, a project that redirects nothing.
  let official = OFFICIAL_LEVEL;
  let redirected = false;
  for (const { target, folder } of resolved) {
    if (folder === undefined || target.kind === "unreadable") continue;
    if (!OFFICIAL_MANAGERS.has(target.manager)) official = false;
    if (await registryRedirected(folder.files, target.ecosystem)) {
      redirected = true;
      official = false;
      continue;
    }
    if (target.kind === "manifest") {
      official = false;
      continue;
    }
    if (target.ecosystem === "npm" && !(await manifestPlanned(folder.files, undefined, true))) {
      official = false;
    }
  }
  if (declared === undefined) {
    return {
      targets,
      planned: false,
      official,
      reason: redirected ? "redirected" : "no_architecture",
      ...withIdentity,
    };
  }
  let reason: InstallVerdict["reason"];
  for (const { target, folder } of resolved) {
    if (folder === undefined || target.kind === "unreadable") continue;
    const names = new Set(
      (declared[target.ecosystem] ?? []).map((name) => normalizedName(target.ecosystem, name)),
    );
    if (await registryRedirected(folder.files, target.ecosystem)) {
      reason = "redirected";
      break;
    }
    // An npm-family installation takes the whole manifest with it, whatever it names.
    if (target.ecosystem === "npm") {
      if (!(await manifestPlanned(folder.files, names, target.kind === "packages"))) {
        reason = "undeclared";
        break;
      }
      if (target.kind === "manifest") continue;
    }
    if (target.kind === "manifest") {
      reason = "unreadable";
      break;
    }
    // What a package runner is given is not what the architecture planned, beyond a few arguments.
    if (!(target.runnerArgs ?? []).every((word) => RUNNER_ARGUMENTS.has(word))) {
      reason = "unreadable";
      break;
    }
    if (!target.packages.every((name) => names.has(normalizedName(target.ecosystem, name)))) {
      reason = "undeclared";
      break;
    }
  }
  if (reason !== undefined) {
    return { targets, planned: false, official, reason, ...withIdentity };
  }
  return { targets, planned: true, official: true, ...withIdentity };
}
