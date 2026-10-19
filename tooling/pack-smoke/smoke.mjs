// Installation test of the published package, run by `pnpm smoke` (after `pnpm build`):
//   1. `pnpm --filter agentplugged pack`;
//   2. `npm install <tgz>` in a new temporary folder, from the public registry;
//   3. in that folder, made a Git repository, `npx agentplugged init --profile new-product`,
//      then `sync`, then `--version`;
//   4. no node-gyp, no install script, no ANSI color code in the output.
// Before all that, the publication guard (`guard.mjs`) refuses the archive, with a clear message,
// if it carries a source map, a file outside `dist/**`, `README.md`, `LICENSE*` and
// `package.json`, text that looks like a secret, or an npm install script; and its self-test
// (`guard-selftest.mjs`) proves first that each of those rules fires.
// Nothing is published: the archive stays on this machine and is deleted at the end.
//
// One install script is accepted, explicitly: `koffi`, the optional FFI of the
// Windows Hello adapter, declares `install: cnoke --prebuild`, which only looks for the prebuilt
// binary its own optional package (`@koromix/koffi-<platform>`) ships; it never compiles (no
// node-gyp, no binding.gyp). `koffi` stays out of the archive (never bundled): an optional
// dependency, loaded on Windows only. Every other package with an install script fails the run.
//
// The CLI runs with a keychain service of its own (`AGENTPLUGGED_KEYCHAIN_SERVICE`), deleted at
// the end, whatever happens, by the shared test helper (`@agentplugged/adapters-git/test-keychain`,
// built with the workspace), which also sweeps first the keys of the test services an interrupted
// run left; and without Windows Hello (`AGENTPLUGGED_PRESENCE=none`): the machine's
// real entries are never touched, and nothing ever prompts.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectArchive } from "./guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const cliDir = join(repoRoot, "apps/cli");
const manifest = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
const REGISTRY = "https://registry.npmjs.org/";
const WINDOWS = process.platform === "win32";
// biome-ignore lint/suspicious/noControlCharactersInRegex: looking for ANSI escape codes.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/;
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];
/** The only package whose install script is accepted, and the script it must be (see above). */
const ALLOWED_INSTALL_SCRIPTS = { koffi: /^node \.\/cnoke\.cjs .*--prebuild/ };
const KEYCHAIN_SERVICE = `agentplugged-smoke-${process.pid}-${Date.now()}`;

function fail(message) {
  throw new Error(`pack-smoke: ${message}`);
}

/** Runs a command and returns its output; fails on another exit code than `expectedStatus`. */
function run(command, args, cwd, env = {}, expectedStatus = 0) {
  const viaNode = /\.[cm]?js$/.test(command);
  const options = { cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 300_000 };
  // npm and npx are .cmd files on Windows: they run through the shell, as one quoted line.
  const quote = (arg) => (/[\s"&|<>^()]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg);
  const result = viaNode
    ? spawnSync(process.execPath, [command, ...args], options)
    : WINDOWS
      ? spawnSync([command, ...args].map(quote).join(" "), { ...options, shell: true })
      : spawnSync(command, args, options);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) fail(`${command} ${args.join(" ")}: ${result.error.message}`);
  if (result.status !== expectedStatus) {
    fail(`${command} ${args.join(" ")} exited with ${result.status}\n${output}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", output };
}

/**
 * Talks to the installed `agentplugged mcp` over its stdio: `initialize`, then `tools/list`,
 * then closes its input and waits for it to exit. Returns the names of the tools.
 */
async function mcpToolNames(cwd, env) {
  const options = { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] };
  const child = WINDOWS
    ? spawn("npx --no -- agentplugged mcp", { ...options, shell: true })
    : spawn("npx", ["--no", "--", "agentplugged", "mcp"], options);
  let buffer = "";
  let stderr = "";
  const waiting = new Map();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
      }
      newline = buffer.indexOf("\n");
    }
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const timeout = (what) =>
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`no answer to ${what}: ${stderr}`)), 120_000).unref(),
    );
  const request = (id, method, params) => {
    const answer = new Promise((resolve) => waiting.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return Promise.race([answer, timeout(method)]);
  };
  try {
    const init = await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pack-smoke", version: "1.0.0" },
    });
    if (init.error) fail(`initialize failed: ${JSON.stringify(init.error)}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = await request(2, "tools/list", {});
    if (list.error) fail(`tools/list failed: ${JSON.stringify(list.error)}`);
    return list.result.tools.map((tool) => tool.name).sort();
  } finally {
    child.stdin.end();
    const code = await Promise.race([exited, timeout("the end of stdin")]);
    if (code !== 0) fail(`mcp exited with ${code} after its input closed:\n${stderr}`);
  }
}

/** pnpm as it runs this script (`npm_execpath`), or the one on the PATH. */
const pnpm = process.env.npm_execpath && /pnpm/i.test(process.env.npm_execpath)
  ? process.env.npm_execpath
  : "pnpm";

/** Every installed package: none may run an install script or build a native module. */
function checkInstalledPackages(nodeModules) {
  const problems = [];
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".cache") continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        visit(path);
        continue;
      }
      const packageJson = join(path, "package.json");
      if (existsSync(packageJson)) {
        const pkg = JSON.parse(readFileSync(packageJson, "utf8"));
        const allowed = ALLOWED_INSTALL_SCRIPTS[pkg.name];
        const scripts = INSTALL_SCRIPTS.filter(
          (name) =>
            pkg.scripts?.[name] !== undefined &&
            !(allowed !== undefined && name === "install" && allowed.test(pkg.scripts[name])),
        );
        if (scripts.length > 0) problems.push(`${pkg.name}: install script (${scripts.join(", ")})`);
        if (existsSync(join(path, "binding.gyp")) || pkg.gypfile) {
          problems.push(`${pkg.name}: native module (binding.gyp)`);
        }
      }
      visit(join(path, "node_modules"));
    }
  };
  visit(nodeModules);
  return problems;
}

/** Things to undo at the end, whatever happens. */
const cleanups = [];

// The rules of the guard must fire before the real archive is trusted to them.
run(process.execPath, [join(here, "guard-selftest.mjs")], repoRoot);
// The install trials have their own machinery, proved before they are trusted to try the package.
run(process.execPath, ["--test", join(repoRoot, "tooling/install-trials/install-trials.test.mjs")], repoRoot);
// No source map, ever: the build must not ask for one (the guard also checks the archive).
if (!/^\s*sourcemap:\s*false,/m.test(readFileSync(join(cliDir, "tsdown.config.ts"), "utf8"))) {
  fail("apps/cli/tsdown.config.ts must set `sourcemap: false`");
}

const bin = join(cliDir, "dist/bin.js");
if (!existsSync(bin)) fail(`${bin} is missing: run \`pnpm build\` first.`);

// The shared test helper of the keychain: sweep first, delete at the end.
const { removeTestKeys, sweepStaleTestKeys } = await import(
  pathToFileURL(join(repoRoot, "packages/adapters-git/dist/test-keychain.js")).href
);
await sweepStaleTestKeys();

const work = mkdtempSync(join(tmpdir(), "agentplugged-smoke-"));
let succeeded = false;
// Registered before anything can create a key: the keys of the smoke are deleted whatever happens.
cleanups.push(() => removeTestKeys(KEYCHAIN_SERVICE));
try {
  // 1. The archive, exactly as `npm publish` would send it.
  const packDir = join(work, "pack");
  mkdirSync(packDir);
  run(pnpm, ["--filter", manifest.name, "pack", "--pack-destination", packDir], repoRoot);
  const archives = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) fail(`expected one archive, found: ${archives.join(", ") || "none"}`);
  const tgz = join(packDir, archives[0]);
  console.log(`pack-smoke: packed ${archives[0]}`);

  // The publication guard, on the archive itself.
  const leaks = inspectArchive(tgz, join(work, "unpacked"));
  if (leaks.length > 0) {
    fail(`the archive must not be published, it breaks the publication guard:\n  ${leaks.join("\n  ")}`);
  }
  console.log("pack-smoke: publication guard passed (no source map, only expected files, no secret, no install script)");

  // 2. A new folder, made a Git repository, where the archive is installed from the registry.
  const repo = join(work, "product");
  mkdirSync(repo);
  run("git", ["init", "--quiet"], repo);
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "smoke-product", private: true }, null, 2)}\n`);
  const install = run(
    "npm",
    ["install", tgz, `--registry=${REGISTRY}`, "--no-audit", "--no-fund", "--foreground-scripts", "--loglevel=info"],
    repo,
  );
  if (/node-gyp/i.test(install.output)) fail(`node-gyp ran during the installation:\n${install.output}`);
  const nodeModules = join(repo, "node_modules");
  const problems = checkInstalledPackages(nodeModules);
  if (problems.length > 0) fail(`install scripts or native modules:\n  ${problems.join("\n  ")}`);

  // The installed package carries the CLI and the method, and depends on public packages only.
  const installed = join(nodeModules, manifest.name);
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (installedManifest.version !== manifest.version) {
    fail(`installed version ${installedManifest.version}, expected ${manifest.version}`);
  }
  for (const [name, range] of Object.entries(installedManifest.dependencies ?? {})) {
    if (name.startsWith("@agentplugged/") || /^(workspace|catalog):/.test(String(range))) {
      fail(`dependency ${name}@${range} cannot be installed from npm`);
    }
  }
  const shipped = [
    "dist/bin.js",
    "dist/cli.js",
    "dist/method/models.yaml",
    "dist/method/doctor.yaml",
    "dist/method/skills",
    "dist/method/agents/iris/SKILL.md",
    "dist/method/LICENSE",
    "README.md",
    "LICENSE",
    "LICENSE-METHOD",
  ];
  for (const path of shipped) {
    if (!existsSync(join(installed, path))) fail(`${path} is missing from the package`);
  }
  if (existsSync(join(nodeModules, "@agentplugged"))) fail("an @agentplugged/* package was installed");

  // 3. The CLI, through npx, as a creator runs it. `--no`: never fetched from the registry.
  const env = {
    AGENTPLUGGED_LANG: "en",
    AGENTPLUGGED_KEYCHAIN_SERVICE: KEYCHAIN_SERVICE,
    AGENTPLUGGED_PRESENCE: "none",
    AGENTPLUGGED_ENVIRONMENT: "none",
  };
  const npxWithStatus = (status, ...args) => {
    const result = run("npx", ["--no", "--", "agentplugged", ...args], repo, env, status);
    if (ANSI.test(result.output)) fail(`ANSI color codes in the output of ${args.join(" ")}`);
    return result;
  };
  const npx = (...args) => npxWithStatus(0, ...args);
  const init = npx("init", "--profile", "new-product");
  if (!init.stdout.startsWith("Method installed in ")) fail(`unexpected init output:\n${init.output}`);
  const config = readFileSync(join(repo, ".agentplugged/method.yaml"), "utf8");
  if (!config.includes(`\nengine_version: ${manifest.version}\n`)) {
    fail(`method.yaml does not pin ${manifest.version}:\n${config}`);
  }
  if (!existsSync(join(repo, ".agentplugged/agents/iris/SKILL.md"))) fail("init did not install Iris");
  // The creator's key: created in the keychain, published in the journal (a Git repository).
  const humanKey =
    /\nYour validation key was created \(human:[\w-]{16}\): assurance locale\.\nIt is published in this product's journal\.\n/;
  if (!humanKey.test(init.stdout)) {
    fail(`init did not create and publish the creator's key:\n${init.output}`);
  }
  if (installedManifest.optionalDependencies?.koffi === undefined) {
    fail("koffi is not an optional dependency of the package");
  }
  // An agent never answers a checkpoint: without a terminal, review refuses before anything.
  const review = npxWithStatus(1, "review");
  if (!review.stderr.includes("REVIEW_NOT_INTERACTIVE")) {
    fail(`review ran without a terminal:\n${review.output}`);
  }

  const sync = npx("sync");
  if (!sync.stdout.startsWith("AI tool files synchronized in ")) fail(`unexpected sync output:\n${sync.output}`);
  const generated = [".claude/skills/iris/SKILL.md", ".agents/skills/iris/SKILL.md"];
  if (!generated.some((path) => existsSync(join(repo, path)))) fail("sync generated no file for Iris");
  // Noah, active in the main session without a command: his section of the constitution.
  if (!readFileSync(join(repo, "AGENTS.md"), "utf8").includes("## Main session: Noah")) {
    fail("the constitution has no section for Noah");
  }

  // The MCP server loads its SDK from the installed dependencies, and ends with its input.
  const mcp = npx("mcp");
  if (mcp.stdout !== "" || mcp.stderr !== "") fail(`unexpected mcp output:\n${mcp.output}`);
  const tools = await mcpToolNames(repo, env);
  // Ten grouped tools, each with an `action`.
  const expectedTools = [
    "agent",
    "chat",
    "checkpoint",
    "guard",
    "measure",
    "memory",
    "plan",
    "review",
    "state",
    "story",
  ];
  if (tools.join(",") !== expectedTools.join(",")) fail(`mcp lists ${tools.join(", ")}`);
  // sync declared the server, with the installed version, for the tools it targets.
  const pinned = `agentplugged@${manifest.version}`;
  const mcpFiles = [".mcp.json", ".cursor/mcp.json", ".agents/mcp_config.json"]
    .filter((path) => existsSync(join(repo, path)));
  for (const path of mcpFiles) {
    const declared = JSON.parse(readFileSync(join(repo, path), "utf8"));
    // `npx -y agentplugged@<v> mcp`, behind `cmd /c` on Windows.
    if (!(declared.mcpServers?.agentplugged?.args ?? []).includes(pinned)) {
      fail(`${path} does not declare ${pinned}: ${JSON.stringify(declared)}`);
    }
  }
  const codexConfig = join(repo, ".codex/config.toml");
  const codexDeclares = existsSync(codexConfig) && readFileSync(codexConfig, "utf8").includes(`"${pinned}"`);
  if (mcpFiles.length === 0 && !codexDeclares) fail("sync declared the MCP server for no tool");

  const version = npx("--version");
  if (version.stdout.trim() !== manifest.version) {
    fail(`--version printed "${version.stdout.trim()}", expected ${manifest.version}`);
  }

  // The bridge is distributed apart: the public command only launches it,
  // and with none installed it says where to get it and fails.
  const noBridge = npxWithStatus(1, "bridge", "status");
  if (!noBridge.stderr.includes("https://agentplugged.ai")) {
    fail(`bridge status did not say where to get the bridge:\n${noBridge.output}`);
  }

  // `pair` is the same launcher: no bridge, one sentence to get it, nothing written.
  const noBridgePair = npxWithStatus(1, "pair", "--no-open");
  if (!noBridgePair.stderr.includes("https://agentplugged.ai")) {
    fail(`pair did not say where to get the bridge:\n${noBridgePair.output}`);
  }

  // A product pinned to another engine: sync stops before writing anything.
  const configPath = join(repo, ".agentplugged/method.yaml");
  writeFileSync(configPath, config.replace(`engine_version: ${manifest.version}`, "engine_version: 0.0.9"));
  const mismatch = npxWithStatus(1, "sync");
  if (!mismatch.stderr.includes("ENGINE_VERSION_MISMATCH")) {
    fail(`sync did not stop on another pinned engine:\n${mismatch.output}`);
  }
  writeFileSync(configPath, config);

  succeeded = true;
  console.log(`pack-smoke: ${archives[0]} installs from npm, and init, sync and --version work.`);
} finally {
  for (const cleanup of cleanups) await cleanup().catch(() => {});
  if (succeeded) rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  else console.error(`pack-smoke: files kept in ${work}`);
}
