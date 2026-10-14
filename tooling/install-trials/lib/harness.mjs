// The machine of an install trial: a work folder, an environment that cannot touch the
// real one (own home, own Git settings, own keychain service, own npm cache), the package installed
// from the archive `pnpm pack` made (or fetched from the registry by `npx agentplugged@<version>`),
// and commands typed into a real terminal, the way a creator types them.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import { findOnPath, findShell, lineFor, shellInvocation, WINDOWS } from "./shells.mjs";

/** A trial step that failed: the message says what was expected and what came. */
export class TrialFailure extends Error {}
/** A step the machine itself prevents, which the product cannot repair (reported, never silent). */
export class TrialWarning extends Error {}
/** A step that does not apply on this machine (said, not hidden). */
export class TrialSkip extends Error {}

export const TRIAL_IDENTITY = { name: "Trial Runner", email: "trial-runner@example.invalid" };
/** A token and a proxy password planted in the environment: no report may ever carry them. */
export const PLANTED = {
  // Assembled from pieces: the public export refuses a file that looks like it holds a token.
  token: ["ghp", "_", "trialPlantedToken0123456789abcdefghij"].join(""),
  proxyPassword: "trialProxyPassw0rd",
};

const REGISTRY = "https://registry.npmjs.org/";

/** Runs a program with its output captured. npm and npx are `.cmd` files on Windows: through a shell. */
export function runPlain(command, args, { cwd, env, timeoutMs = 300_000 } = {}) {
  const quote = (arg) => (/[\s"&|<>^()]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg);
  const options = { cwd, env, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] };
  const result = WINDOWS
    ? spawnSync([command, ...args].map(quote).join(" "), { ...options, shell: true })
    : spawnSync(command, args, options);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/** What `pnpm pack` made, or a name@version of the registry. */
export function describeSpec(spec) {
  if (/\.tgz$/i.test(spec)) {
    // Either separator: a Windows path must read the same on a Linux runner.
    const name = basename(spec.replaceAll("\\", "/"));
    const version = /^agentplugged-(\d+\.\d+\.\d+[\w.+-]*)\.tgz$/.exec(name)?.[1];
    return { mode: "tarball", spec, version };
  }
  const match = /^agentplugged@(\d+\.\d+\.\d+[\w.+-]*)$/.exec(spec);
  if (match === null) {
    throw new Error(`the package must be a .tgz archive or agentplugged@<version>, not "${spec}"`);
  }
  return { mode: "registry", spec, version: match[1] };
}

/**
 * Sets up the machine of a trial and installs the package. `cleanup()` removes the work folder and
 * the keychain entries of the trial; it is safe to call twice.
 */
export function createMachine({ spec: given, work, log = () => {} }) {
  // An archive is named by a path relative to where the command was typed: made absolute here, since
  // the install runs in another folder.
  const spec = /\.tgz$/i.test(given) ? resolvePath(given) : given;
  const described = describeSpec(spec);
  // The folder is deleted at the end: it must be one the trial makes, or an empty one it was given.
  if (work !== undefined && existsSync(work) && readdirSync(work).length > 0) {
    throw new Error(`the work folder ${work} is not empty: the trial deletes it when it ends`);
  }
  const root = work ?? mkdtempSync(join(tmpdir(), "agentplugged-trial-"));
  mkdirSync(root, { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const gitConfig = join(root, "gitconfig");
  writeFileSync(gitConfig, `[user]\n\tname = ${TRIAL_IDENTITY.name}\n\temail = ${TRIAL_IDENTITY.email}\n[init]\n\tdefaultBranch = main\n`);
  const emptyGitConfig = join(root, "gitconfig-empty");
  writeFileSync(emptyGitConfig, "");
  const service = `agentplugged-trial-${process.pid}-${Date.now()}`;
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    AGENTPLUGGED_LANG: "en",
    AGENTPLUGGED_KEYCHAIN_SERVICE: service,
    AGENTPLUGGED_PRESENCE: "none",
    npm_config_cache: join(root, "npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_yes: "true",
    npm_config_audit: "false",
    NO_COLOR: "1",
    TRIAL_API_TOKEN: PLANTED.token,
  };
  for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    delete env[name];
  }
  const runtime = join(root, "runtime");
  const products = described.mode === "tarball" ? join(runtime, "products") : join(root, "products");
  mkdirSync(products, { recursive: true });

  const machine = {
    ...described,
    root,
    home,
    env,
    emptyGitConfig,
    gitConfig,
    products,
    runtime,
    service,
    /** What no report may carry, whoever reads it. */
    privateValues() {
      const values = [root, home, TRIAL_IDENTITY.name, TRIAL_IDENTITY.email, PLANTED.token, PLANTED.proxyPassword];
      const realHome = process.env.USERPROFILE ?? process.env.HOME;
      if (realHome) values.push(realHome);
      try {
        const user = userInfo().username;
        // An account every machine has says nothing about the person (the report keeps those).
        if (user.length >= 3 && !/^(?:root|admin|administrator)$/i.test(user)) values.push(user);
      } catch {
        // No account entry: nothing to add.
      }
      return values;
    },
    install() {
      if (described.mode !== "tarball") return;
      mkdirSync(runtime, { recursive: true });
      writeFileSync(join(runtime, "package.json"), `${JSON.stringify({ name: "trial-runtime", private: true }, null, 2)}\n`);
      log(`installing ${basename(spec)} in a new folder`);
      const install = runPlain(
        "npm",
        ["install", spec, `--registry=${REGISTRY}`, "--no-audit", "--no-fund", "--foreground-scripts"],
        { cwd: runtime, env },
      );
      if (install.status !== 0) {
        throw new Error(`npm install ${basename(spec)} failed (${install.status}):\n${install.stdout}${install.stderr}`);
      }
      const manifest = JSON.parse(readFileSync(join(runtime, "node_modules", "agentplugged", "package.json"), "utf8"));
      machine.version = manifest.version;
    },
    /** The command a creator types to run the engine: `npx agentplugged …` or `npx agentplugged@<v> …`. */
    npx(args) {
      // No option before the package: `npx --no agentplugged --version` prints npm's version, not ours.
      return described.mode === "tarball"
        ? ["npx", "agentplugged", ...args]
        : ["npx", `agentplugged@${described.version}`, ...args];
    },
    cleanup() {
      deleteKeychainEntries(machine);
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        // A file still held by an antivirus: the folder is in the temporary folder, the system empties it.
      }
    },
  };
  return machine;
}

/** Deletes the keychain entries the trial created, through the module the package installed. */
function deleteKeychainEntries(machine) {
  if (machine.mode !== "tarball") return;
  const manifest = join(machine.runtime, "package.json");
  if (!existsSync(manifest)) return;
  const script = `
    const { createRequire } = require("node:module");
    const { AsyncEntry } = createRequire(process.argv[1])("@napi-rs/keyring");
    (async () => {
      for (const account of ["machine", "human", "human-presence"]) {
        await new AsyncEntry(process.argv[2], account).deleteCredential().catch(() => false);
      }
    })();
  `;
  spawnSync(process.execPath, ["-e", script, manifest, machine.service], { encoding: "utf8", timeout: 60_000 });
}

/**
 * A new product folder, a Git repository. With `remote`, its origin is a GitHub address, so that the
 * forge checks apply (no network is used; a clone whose origin does not answer is another story).
 */
export function newProduct(machine, name, { remote = false, git: repository = true } = {}) {
  const dir = join(machine.products, name);
  mkdirSync(dir, { recursive: true });
  // A machine without Git (the first minutes of a creator who has only Node.js): a plain folder.
  if (!repository || findOnPath("git", machine.env.PATH ?? machine.env.Path ?? "", machine.env) === undefined) {
    return dir;
  }
  const git = (args) => {
    const run = runPlain("git", args, { cwd: dir, env: machine.env });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
  };
  git(["init", "--quiet"]);
  if (remote) git(["remote", "add", "origin", "https://github.com/trial-owner/trial-product.git"]);
  return dir;
}

/** Runs one command in a terminal, as typed. Returns status, stdout, stderr, and both together. */
export function typeCommand({ shell, shellPath: given, argv, cwd, env, timeoutMs = 240_000 }) {
  // The terminal is looked for with the whole PATH of the machine, not the cut one of a scenario.
  const shellPath = given ?? findShell(shell, env);
  if (shellPath === undefined) throw new TrialSkip(`${shell} is not on this machine`);
  const { command, args, verbatim } = shellInvocation(shell, shellPath, lineFor(shell, argv));
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsVerbatimArguments: verbatim,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new TrialFailure(`${shell}: ${argv.join(" ")}: ${result.error.message}`);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, stdout, stderr, output: `${stdout}${stderr}`, line: lineFor(shell, argv) };
}

