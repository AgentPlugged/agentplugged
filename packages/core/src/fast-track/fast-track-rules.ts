import {
  FAST_TRACK_ENGINE_REASONS,
  FAST_TRACK_MAX_FILES,
  FAST_TRACK_OPTIONS,
  type FastTrackEngineReason,
  MAX_FAST_TRACK_FILES,
  RepositoryPathSchema,
} from "@agentplugged/protocol";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { DiffFile } from "../review/review-rules.js";

/**
 * The rules of the fast track, pure: what the engine reads of a story's
 * changes to decide whether they are still a small change, and where the merge gate stands for a
 * story in the fast track or one that left it.
 */

/** Names of files that declare or lock the dependencies of a project, in any ecosystem. */
const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  "pipfile",
  "pipfile.lock",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "setup.py",
  "setup.cfg",
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  "cargo.toml",
  "cargo.lock",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.lockfile",
  "libs.versions.toml",
  "packages.config",
  "directory.packages.props",
  "directory.build.props",
  "nuget.config",
  "package.swift",
  "package.resolved",
  "podfile",
  "podfile.lock",
  "cartfile",
  "cartfile.resolved",
  "pubspec.yaml",
  "pubspec.lock",
  "mix.exs",
  "mix.lock",
  "rebar.config",
  "rebar.lock",
  "stack.yaml",
  "cabal.project",
  "cpanfile",
  "cpanfile.snapshot",
  "makefile.pl",
  "build.pl",
  "conanfile.txt",
  "conanfile.py",
  "vcpkg.json",
  "flake.nix",
  "flake.lock",
  "renv.lock",
  "environment.yml",
  "environment.yaml",
  "project.clj",
  "deps.edn",
  ".gitmodules",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".tool-versions",
  "brewfile",
  "chart.yaml",
  "bower.json",
  "elm.json",
  "build.sbt",
  "dub.json",
  "dub.sdl",
  "shard.yml",
  "shard.lock",
]);

/** Names of dependency files recognised by their shape (any project name before the extension). */
const DEPENDENCY_NAMES = [
  /^requirements.*\.(?:txt|in)$/,
  /^constraints.*\.(?:txt|in)$/,
  /^(?:docker|container)file(?:[._-].*)?$/,
  /\.(?:docker|container)file$/,
  /^docker-compose.*\.ya?ml$/,
  /\.(?:cs|fs|vb)proj$/,
  /\.gemspec$/,
  /\.cabal$/,
  /\.nuspec$/,
];

/** Folders whose files change the shape of the data. */
const MIGRATION_FOLDERS = new Set([
  "migrations",
  "migration",
  "migrate",
  "alembic",
  "flyway",
  "liquibase",
  "evolutions",
]);

/** Names of migration files by their shape: `…_migration_…`, `…-migrate-…`. */
const MIGRATION_NAME = /(?:^|[._-])migrat(?:e|es|ion|ions)(?:[._-]|$)/;

/** Extensions of the files that describe or change a data schema. */
const MIGRATION_EXTENSIONS = [".sql", ".ddl", ".prisma"];

/** Extensions of the files that are an interface's contract. */
const INTERFACE_EXTENSIONS = [
  ".proto",
  ".graphql",
  ".graphqls",
  ".gql",
  ".thrift",
  ".avsc",
  ".wsdl",
  ".tsp",
  ".smithy",
  ".d.ts",
  ".d.mts",
  ".d.cts",
];

/** `openapi.yaml`, `swagger.json`, `asyncapi-v2.yml`… */
const INTERFACE_NAME = /(?:^|[._-])(?:openapi|swagger|asyncapi)(?:[._-].*)?\.(?:json|ya?ml)$/;

/** Folders whose files describe an interface. */
const INTERFACE_FOLDERS = new Set(["openapi", "swagger", "asyncapi", "proto", "protos"]);

function normalized(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function baseName(path: string): string {
  return normalized(path).split("/").at(-1) ?? "";
}

/** True for a dependency manifest or lockfile: a dependency may be added or changed. */
export function dependencyPath(path: string): boolean {
  const name = baseName(path);
  if (DEPENDENCY_FILES.has(name) || DEPENDENCY_NAMES.some((pattern) => pattern.test(name))) {
    return true;
  }
  // `requirements/base.txt`, `requirements/dev.in`.
  const parts = normalized(path).split("/");
  return parts.slice(0, -1).includes("requirements") && /\.(?:txt|in)$/.test(name);
}

/** True for a file of a data migration or of a data schema. */
export function migrationPath(path: string): boolean {
  const lower = normalized(path);
  const parts = lower.split("/");
  const name = parts.at(-1) ?? "";
  if (parts.slice(0, -1).some((part) => MIGRATION_FOLDERS.has(part))) return true;
  if (MIGRATION_EXTENSIONS.some((extension) => name.endsWith(extension))) return true;
  if (name === "schema.rb" || name === "structure.sql") return true;
  return MIGRATION_NAME.test(name);
}

/** True for a file of an interface's contract (OpenAPI, protobuf, GraphQL, type declarations). */
export function interfacePath(path: string): boolean {
  const name = baseName(path);
  const folders = normalized(path).split("/").slice(0, -1);
  if (folders.some((part) => INTERFACE_FOLDERS.has(part)) && /\.(?:json|ya?ml|proto)$/.test(name)) {
    return true;
  }
  return (
    INTERFACE_EXTENSIONS.some((extension) => name.endsWith(extension)) || INTERFACE_NAME.test(name)
  );
}

/** What the engine reads of a commit's changes (the payload of `story.fast_track_checked`). */
export interface FastTrackVerdict {
  /** The files touched, a renamed file counted by both of its paths. */
  readonly count: number;
  /** Their paths, as a payload may hold them (at most `MAX_FAST_TRACK_FILES`). */
  readonly files: readonly string[];
  /** Some touched paths are not listed in `files`. */
  readonly truncated: boolean;
  readonly ok: boolean;
  readonly reasons: readonly FastTrackEngineReason[];
}

/**
 * The verdict on a story's changes (a parsed `git diff`): a small change touches fewer than
 * `FAST_TRACK_MAX_FILES` files, tests included, and touches no dependency manifest, no migration
 * and no file of an interface's contract. A renamed file counts both of its paths and each is
 * classified: moving a manifest or a migration is touching it.
 */
export function fastTrackVerdict(
  diff: readonly DiffFile[],
  extra: readonly string[] = [],
): FastTrackVerdict {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const file of diff) {
    for (const path of [file.path, file.old_path]) {
      if (path === null || path === "" || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  for (const path of extra) {
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  // Never fewer than the diff's own blocks: a header Git wrote oddly cannot hide a file.
  const count = Math.max(paths.length, diff.length);
  const reasons: FastTrackEngineReason[] = [];
  if (count >= FAST_TRACK_MAX_FILES) reasons.push("too_many_files");
  if (paths.some(dependencyPath)) reasons.push("dependency_manifest");
  if (paths.some(migrationPath)) reasons.push("migration");
  if (paths.some(interfacePath)) reasons.push("interface_contract");
  const listable = paths.filter((path) => RepositoryPathSchema.safeParse(path).success);
  const files = listable.slice(0, MAX_FAST_TRACK_FILES);
  return {
    count,
    files,
    truncated: files.length < count,
    ok: reasons.length === 0,
    // The payload's order, whatever the order the rules ran in.
    reasons: FAST_TRACK_ENGINE_REASONS.filter((reason) => reasons.includes(reason)),
  };
}

/** Why the merge gate holds a story in (or out of) the fast track. */
export type FastTrackHold =
  /** In the fast track, the commit the CI covers was never read by the engine. */
  | "unverified"
  /** In the fast track, the engine read the commit and it does not fit (the exit is pending). */
  | "exceeded"
  /** Left for the full lane; the checkpoint that explains it waits for the creator's answer. */
  | "left_open"
  /** Left for the full lane; the creator chose to stop the story. */
  | "stopped";

/** The story's checkpoint that explains its exit from the fast track, open or not. */
export function exitCheckpoints(
  checkpoints: readonly CheckpointState[],
  id: string,
): CheckpointState[] {
  return checkpoints.filter(
    (checkpoint) => checkpoint.story === id && checkpoint.source === "fast_track",
  );
}

/** The story's open checkpoint of exit from the fast track, if any. */
export function openExitCheckpoint(
  checkpoints: readonly CheckpointState[],
  id: string,
): CheckpointState | undefined {
  return exitCheckpoints(checkpoints, id).find((checkpoint) => checkpoint.status === "open");
}

/**
 * Where the fast track stands for the merge gate (the review gate): `undefined` when
 * it holds nothing back (a story in the full lane from the start, a verified small change, a story
 * that left whose checkpoint the creator answered by continuing). `head` is the branch's head when
 * the caller read it.
 */
export function fastTrackHold(
  story: StoryState | undefined,
  checkpoints: readonly CheckpointState[],
  id: string,
  head?: string,
  /** The creator skipped the story's CI: the commit the engine read need not be a CI's. */
  ciSkipped = false,
): FastTrackHold | undefined {
  const track = story?.fast_track;
  if (track === undefined) return undefined;
  if (track.status === "left") {
    const exits = exitCheckpoints(checkpoints, id);
    if (exits.some((checkpoint) => checkpoint.status !== "resolved")) return "left_open";
    // The creator continues in the full lane (every exit checkpoint answered so), or the story
    // stays out of the merge: a refusal or a « stop » is never undone by another answer.
    const continues = (checkpoint: CheckpointState) => {
      const answered = checkpoint.resolution ?? null;
      return (
        answered !== null &&
        (answered.decision === "approved" ||
          answered.decision === "approved_with_reservations" ||
          (answered.decision === "option_chosen" &&
            answered.option === FAST_TRACK_OPTIONS.fullLane))
      );
    };
    return exits.every(continues) && exits.length > 0 ? undefined : "stopped";
  }
  const checked = track.checked;
  if (checked === undefined) return "unverified";
  if (!checked.ok) return "exceeded";
  if (!ciSkipped && (story?.ci === undefined || checked.commit !== story.ci.commit)) {
    return "unverified";
  }
  if (head !== undefined && checked.commit !== head) return "unverified";
  return undefined;
}

/**
 * The paths a diff names on its `rename from` / `rename to` / `copy from` / `copy to` lines: the
 * header of a pure rename carries no `---` line, and a path with a space may split in more than one
 * way there. Quoted (escaped) paths are left to the header.
 */
export function renamedPaths(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (match?.[1] !== undefined && !match[1].startsWith('"')) found.push(match[1]);
  }
  return found;
}

/** The blocks a diff announces: its `diff --git` lines. */
export function announcedFiles(text: string): number {
  return text.split("\n").filter((line) => line.startsWith("diff --git ")).length;
}
