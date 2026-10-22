import type { WorkspaceFiles } from "../workspace-files.js";

/**
 * The project profile scan: what the product's own files say about how it is built, tested and
 * kept tidy, read once by the engine so that no agent rediscovers it. Deterministic, no AI, no
 * dependency: every line carries the file it comes from, and nothing is stated that no file says.
 * The detectors below are a table of ecosystems; adding one never changes an agent.
 */

/** A command the project defines, with the file that defines it. */
export interface ProfileCommand {
  readonly name: "test" | "build" | "lint" | "typecheck" | "format" | "run";
  readonly command: string;
  readonly source: string;
}

/** A piece of advice and the reason that justifies it (no advice without its reason). */
export interface ProfileAdvice {
  readonly advice: string;
  readonly why: string;
}

export interface ProjectScan {
  /** Languages, runtimes and tools found, each with the file that shows it. */
  readonly stack: readonly string[];
  readonly commands: readonly ProfileCommand[];
  /** Conventions the repository states itself (formatter, editor settings, pinned runtime, CI). */
  readonly conventions: readonly string[];
  /** The top-level folders that hold the product, and where its tests live. */
  readonly layout: readonly string[];
  readonly advice: readonly ProfileAdvice[];
}

/** Longest manifest read (bytes): a larger one is data, not a manifest. */
const MAX_MANIFEST = 200_000;
const MAX_LAYOUT = 12;

/** Root entries that are not product folders. */
const NOT_LAYOUT = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "tmp",
  "temp",
  "bin",
  "obj",
  "venv",
  "env",
  "docs",
  "doc",
  "scripts",
  "public",
  "assets",
  "images",
  "licenses",
  "license",
]);
const TEST_FOLDERS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);

interface Reader {
  readonly entries: ReadonlySet<string>;
  /** Text of a root file, undefined when absent or too large. */
  text(name: string): Promise<string | undefined>;
}

function lower(entries: readonly string[]): Map<string, string> {
  return new Map(entries.map((entry) => [entry.toLowerCase(), entry]));
}

/** The script a manifest names `name`, as a command, or undefined. */
const pick = (record: Record<string, unknown> | undefined, name: string): string | undefined => {
  const value = record?.[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Libraries worth naming in the stack: a short, well-known set, found in a dependency list. */
const KNOWN_PACKAGES: ReadonlyArray<readonly [string, string]> = [
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@angular/core", "Angular"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["@nestjs/core", "NestJS"],
  ["vitest", "Vitest"],
  ["jest", "Jest"],
  ["mocha", "Mocha"],
  ["@playwright/test", "Playwright"],
  ["cypress", "Cypress"],
  ["@biomejs/biome", "Biome"],
  ["eslint", "ESLint"],
  ["prettier", "Prettier"],
];

async function scanNode(reader: Reader, out: Mutable): Promise<void> {
  const raw = await reader.text("package.json");
  if (raw === undefined) return;
  let manifest: Record<string, unknown> | undefined;
  try {
    manifest = asRecord(JSON.parse(raw));
  } catch {
    out.stack.push("Node.js project (package.json is not valid JSON)");
    return;
  }
  if (manifest === undefined) return;
  const lockfiles = [
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
  ].filter((name) => reader.entries.has(name));
  const declared = pick(manifest, "packageManager")?.split("@")[0];
  const byLock: Record<string, string> = {
    "pnpm-lock.yaml": "pnpm",
    "yarn.lock": "yarn",
    "bun.lock": "bun",
    "bun.lockb": "bun",
    "package-lock.json": "npm",
  };
  const manager =
    declared !== undefined && declared !== "" ? declared : (byLock[lockfiles[0] ?? ""] ?? "npm");
  const typed = reader.entries.has("tsconfig.json");
  const engines = pick(asRecord(manifest.engines), "node");
  out.stack.push(
    `${typed ? "TypeScript" : "JavaScript"} on Node.js${engines === undefined ? "" : ` ${engines}`}, ${manager} (package.json${lockfiles.length > 0 ? `, ${lockfiles[0]}` : ""})`,
  );
  const dependencies = {
    ...asRecord(manifest.dependencies),
    ...asRecord(manifest.devDependencies),
  };
  const known = KNOWN_PACKAGES.filter(([name]) => name in dependencies).map(([, label]) => label);
  if (known.length > 0) out.stack.push(`Libraries: ${known.join(", ")} (package.json)`);
  const scripts = asRecord(manifest.scripts);
  const run = (name: string) => (manager === "yarn" ? `yarn ${name}` : `${manager} run ${name}`);
  const add = (kind: ProfileCommand["name"], script: string, command = run(script)) => {
    if (pick(scripts, script) !== undefined) {
      out.commands.push({ name: kind, command, source: `package.json scripts.${script}` });
    }
  };
  add("test", "test", manager === "yarn" ? "yarn test" : `${manager} test`);
  add("build", "build");
  add("lint", "lint");
  add("typecheck", "typecheck");
  add("typecheck", "type-check");
  add("format", "format");
  add("run", "dev");
  if (pick(scripts, "dev") === undefined) add("run", "start");
  if (lockfiles.length > 1) {
    out.advice.push({
      advice: `Pick one package manager (${manager}) and delete the other lockfiles.`,
      why: `${lockfiles.join(" and ")} are all committed: two managers rewrite each other's lockfile.`,
    });
  } else if (lockfiles.length === 1) {
    out.advice.push({
      advice: `Install with ${manager} only.`,
      why: `${lockfiles[0]} is committed: another manager would rewrite it and change versions.`,
    });
  }
  if (manifest.workspaces !== undefined || reader.entries.has("pnpm-workspace.yaml")) {
    out.advice.push({
      advice: "Run a package's commands from that package, not from the root, when you touch one.",
      why: "the repository holds several packages (workspaces): the root command runs them all.",
    });
  }
}

async function scanPython(reader: Reader, out: Mutable): Promise<void> {
  const pyproject = await reader.text("pyproject.toml");
  const requirements = await reader.text("requirements.txt");
  const hasSetup = reader.entries.has("setup.py") || reader.entries.has("pipfile");
  if (pyproject === undefined && requirements === undefined && !hasSetup) return;
  const runner = reader.entries.has("uv.lock")
    ? "uv run "
    : reader.entries.has("poetry.lock")
      ? "poetry run "
      : "";
  const source = pyproject !== undefined ? "pyproject.toml" : "requirements.txt";
  const text = `${pyproject ?? ""}\n${requirements ?? ""}`.toLowerCase();
  out.stack.push(`Python (${source}${runner === "" ? "" : `, ${runner.trim()}`})`);
  if (/pytest/.test(text)) out.commands.push({ name: "test", command: `${runner}pytest`, source });
  if (/\[tool\.ruff|\bruff\b/.test(text)) {
    out.commands.push({ name: "lint", command: `${runner}ruff check`, source });
  }
  if (/\[tool\.mypy|\bmypy\b/.test(text)) {
    out.commands.push({ name: "typecheck", command: `${runner}mypy .`, source });
  }
  if (runner !== "") {
    out.advice.push({
      advice: `Run Python tools through \`${runner.trim()}\`.`,
      why: `${runner.startsWith("uv") ? "uv.lock" : "poetry.lock"} is committed: a bare \`python\` or \`pytest\` runs outside the project environment.`,
    });
  }
}

function scanSimple(reader: Reader, out: Mutable): void {
  const has = (name: string) => reader.entries.has(name);
  if (has("cargo.toml")) {
    out.stack.push("Rust (Cargo.toml)");
    out.commands.push({ name: "test", command: "cargo test", source: "Cargo.toml" });
    out.commands.push({ name: "build", command: "cargo build", source: "Cargo.toml" });
  }
  if (has("go.mod")) {
    out.stack.push("Go (go.mod)");
    out.commands.push({ name: "test", command: "go test ./...", source: "go.mod" });
    out.commands.push({ name: "build", command: "go build ./...", source: "go.mod" });
    out.commands.push({ name: "lint", command: "go vet ./...", source: "go.mod" });
  }
  if (has("pom.xml")) {
    out.stack.push("Java (pom.xml)");
    out.commands.push({ name: "test", command: "mvn test", source: "pom.xml" });
  }
  const gradle = ["build.gradle", "build.gradle.kts"].find(has);
  if (gradle !== undefined) {
    const wrapper = has("gradlew") ? "./gradlew" : "gradle";
    out.stack.push(`JVM, Gradle (${gradle})`);
    out.commands.push({ name: "test", command: `${wrapper} test`, source: gradle });
    out.commands.push({ name: "build", command: `${wrapper} build`, source: gradle });
  }
  const dotnet = [...reader.entries].find((name) => /\.(?:sln|slnx|csproj|fsproj)$/.test(name));
  if (dotnet !== undefined) {
    out.stack.push(`.NET (${dotnet})`);
    out.commands.push({ name: "test", command: "dotnet test", source: dotnet });
    out.commands.push({ name: "build", command: "dotnet build", source: dotnet });
  }
  if (has("gemfile")) {
    out.stack.push("Ruby (Gemfile)");
    if (has(".rspec")) {
      out.commands.push({ name: "test", command: "bundle exec rspec", source: ".rspec" });
    }
  }
  if (has("mix.exs")) {
    out.stack.push("Elixir (mix.exs)");
    out.commands.push({ name: "test", command: "mix test", source: "mix.exs" });
  }
  if (has("package.swift")) {
    out.stack.push("Swift (Package.swift)");
    out.commands.push({ name: "test", command: "swift test", source: "Package.swift" });
  }
  if (has("pubspec.yaml")) {
    out.stack.push("Dart (pubspec.yaml)");
  }
}

async function scanComposer(reader: Reader, out: Mutable): Promise<void> {
  const raw = await reader.text("composer.json");
  if (raw === undefined) return;
  out.stack.push("PHP (composer.json)");
  try {
    const scripts = asRecord(asRecord(JSON.parse(raw))?.scripts);
    if (scripts?.test !== undefined) {
      out.commands.push({
        name: "test",
        command: "composer test",
        source: "composer.json scripts.test",
      });
    }
  } catch {
    // An unreadable manifest says nothing more.
  }
}

/** The targets of a Makefile the profile names (a target is a command only when it is written). */
async function scanMake(reader: Reader, out: Mutable): Promise<void> {
  const text = await reader.text("Makefile");
  if (text === undefined) return;
  const targets = new Set(
    [...text.matchAll(/^([a-z][\w-]*)\s*:(?!=)/gm)].map((match) => match[1] as string),
  );
  const names: Array<[ProfileCommand["name"], string]> = [
    ["test", "test"],
    ["build", "build"],
    ["lint", "lint"],
    ["format", "fmt"],
    ["format", "format"],
  ];
  for (const [kind, target] of names) {
    if (targets.has(target) && !out.commands.some((command) => command.name === kind)) {
      out.commands.push({ name: kind, command: `make ${target}`, source: `Makefile ${target}:` });
    }
  }
}

const TOOLING: ReadonlyArray<readonly [string[], string, string]> = [
  [["biome.json", "biome.jsonc"], "Biome formats and lints", "its config is committed"],
  [
    [".prettierrc", ".prettierrc.json", ".prettierrc.js", "prettier.config.js"],
    "Prettier formats",
    "its config is committed",
  ],
  [
    [".eslintrc", ".eslintrc.json", ".eslintrc.js", "eslint.config.js", "eslint.config.mjs"],
    "ESLint lints",
    "its config is committed",
  ],
  [["rustfmt.toml", ".rustfmt.toml"], "rustfmt formats", "its config is committed"],
  [[".golangci.yml", ".golangci.yaml"], "golangci-lint lints", "its config is committed"],
  [[".rubocop.yml"], "RuboCop lints", "its config is committed"],
  [
    [".editorconfig"],
    "EditorConfig sets indentation and line endings",
    ".editorconfig is committed",
  ],
];

const CI_FILES = [
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  "jenkinsfile",
  ".travis.yml",
  "bitbucket-pipelines.yml",
  "appveyor.yml",
];

async function scanConventions(reader: Reader, files: WorkspaceFiles, out: Mutable): Promise<void> {
  for (const [names, label, why] of TOOLING) {
    const found = names.find((name) => reader.entries.has(name.toLowerCase()));
    if (found === undefined) continue;
    out.conventions.push(`${label} (${found}).`);
    if (label.startsWith("Biome") || label.startsWith("Prettier") || label.startsWith("rustfmt")) {
      out.advice.push({
        advice: `Format with the project's formatter, not by hand.`,
        why: `${found}: ${why}, and a style-only diff is noise in a review.`,
      });
    }
  }
  for (const pinned of [".nvmrc", ".node-version", ".python-version", ".tool-versions"]) {
    if (!reader.entries.has(pinned)) continue;
    const value = (await reader.text(pinned))?.split("\n")[0]?.trim();
    out.conventions.push(`Runtime version pinned: ${value ?? "see file"} (${pinned}).`);
  }
  let workflows: string[] = [];
  try {
    workflows = ((await files.listEntries?.(".github/workflows")) ?? []).filter((name) =>
      /\.ya?ml$/i.test(name),
    );
  } catch {
    workflows = [];
  }
  if (workflows.length > 0) {
    out.conventions.push(`CI: GitHub Actions (${workflows.slice(0, 4).join(", ")}).`);
  }
  const ci = CI_FILES.find((name) => reader.entries.has(name));
  if (ci !== undefined) out.conventions.push(`CI: ${ci}.`);
  if (reader.entries.has("dockerfile") || reader.entries.has("docker-compose.yml")) {
    out.conventions.push("Containers: Dockerfile or docker-compose.yml at the root.");
  }
  if (reader.entries.has("tsconfig.json")) {
    out.conventions.push("TypeScript: tsconfig.json at the root.");
  }
}

interface Mutable {
  stack: string[];
  commands: ProfileCommand[];
  conventions: string[];
  layout: string[];
  advice: ProfileAdvice[];
}

/** Reads the product's root and says what it is. Never throws: an unreadable file says nothing. */
export async function scanProject(files: WorkspaceFiles): Promise<ProjectScan> {
  const out: Mutable = { stack: [], commands: [], conventions: [], layout: [], advice: [] };
  let names: string[] = [];
  try {
    names = (await files.listEntries?.("")) ?? [];
  } catch {
    names = [];
  }
  const byLower = lower(names);
  const reader: Reader = {
    entries: new Set(byLower.keys()),
    async text(name) {
      const actual = byLower.get(name.toLowerCase());
      if (actual === undefined) return undefined;
      try {
        const text = await files.readText(actual);
        return text.length > MAX_MANIFEST ? undefined : text.replace(/\r\n/g, "\n");
      } catch {
        return undefined;
      }
    },
  };
  await scanNode(reader, out);
  await scanPython(reader, out);
  scanSimple(reader, out);
  await scanComposer(reader, out);
  await scanMake(reader, out);
  await scanConventions(reader, files, out);
  // Only a real folder is a folder: a root file without an extension (Makefile, LICENSE) is not.
  const folders: string[] = [];
  for (const name of names) {
    if (name.includes(".") || name.startsWith("_") || NOT_LAYOUT.has(name.toLowerCase())) continue;
    if (folders.length >= 30) break;
    try {
      if (((await files.listEntries?.(name)) ?? []).length > 0) folders.push(name);
    } catch {
      // Unreadable: not listed.
    }
  }
  const tests = folders.filter((name) => TEST_FOLDERS.has(name.toLowerCase()));
  const product = folders.filter((name) => !TEST_FOLDERS.has(name.toLowerCase()));
  if (product.length > 0) out.layout.push(`Folders: ${product.slice(0, MAX_LAYOUT).join(", ")}.`);
  if (tests.length > 0) out.layout.push(`Tests live in: ${tests.join(", ")}.`);
  if (!out.commands.some((command) => command.name === "test") && out.stack.length > 0) {
    out.advice.push({
      advice: "No test command was found: ask the creator for it before inventing one.",
      why: "no manifest or Makefile of the root defines it; a guessed command proves nothing.",
    });
  }
  return out;
}
