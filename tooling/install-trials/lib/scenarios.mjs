// The scenarios of the install trials. Each one is a short story about a machine: a
// clean one, then imperfect ones. A scenario types commands into a terminal and says what it
// expects: the right message and the right repair, not just a successful exit code.
//
// `everyShell`: played once per terminal (the first flow); the others are played once, in the
// native terminal of the platform.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PLANTED, TrialFailure, TrialSkip } from "./harness.mjs";
import { offlineGh, pathWithout, stoppedDocker } from "./shims.mjs";

/** The point `id` of a `doctor --json` answer; fails when the answer has no such point. */
export function pointOf(answer, id) {
  const point = answer.points?.find((entry) => entry.id === id);
  if (point === undefined) {
    throw new TrialFailure(`doctor has no point "${id}" (it has: ${(answer.points ?? []).map((p) => p.id).join(", ")})`);
  }
  return point;
}

/** A point the diagnosis of a failure read on the machine (status and sentence). */
export function observedPoint(answer, id) {
  const point = answer.diagnosis?.observed?.find((entry) => entry.id === id);
  if (point === undefined) {
    throw new TrialFailure(`the diagnosis read no "${id}" (it read: ${(answer.diagnosis?.observed ?? []).map((p) => p.id).join(", ")})`);
  }
  return point;
}

/** True when the answer says something to do: a command to run or steps to follow. */
export function hasRepair(point) {
  return point.fix !== undefined && ((point.fix.command?.length ?? 0) > 0 || (point.fix.steps?.en?.length ?? 0) > 0);
}

/** A folder name with spaces and accents, long enough for the long-path warning, short enough for Windows. */
export function longFolderName(parentLength) {
  const base = "Mon projet été à l'âge d'or ñ ü ";
  const wanted = Math.min(80, Math.max(40, 140 - parentLength));
  return base.repeat(4).slice(0, wanted).trimEnd();
}

/**
 * A machine with Node.js and no Git at all (the first minutes of many creators): `init` stops, the
 * creator is told plainly what is missing and where to look, and `doctor` has the repair.
 */
function checkMissingGit(t, product, env) {
  const init = t.cli(product, ["init", "--yes"], { env, status: "any" });
  t.expect(!/\n\s+at .*\(.*:\d+:\d+\)/.test(init.output), `init crashed with a stack:\n${init.output}`);
  t.expect(init.status !== 0, `init went on without Git (exit ${init.status}):\n${init.output}`);
  t.expect(/Git was not found/.test(init.output), `init did not say Git is missing:\n${init.output}`);
  t.expect(/npx agentplugged doctor/.test(init.output), `init did not point to \`npx agentplugged doctor\`:\n${init.output}`);
  const answer = t.json(product, ["doctor", "--json"], { env, status: 1 });
  const git = pointOf(answer, "git.installed");
  t.expect(git.status === "fail" && git.outcome === "missing", `git.installed is ${git.status}/${git.outcome}`);
  t.expect(hasRepair(git), "no repair is given for the missing Git");
  t.expect(answer.blocking === true, "a missing Git does not block");
}

/** Node.js and nothing else: no Git in the PATH, none in the folders Git installs itself in. */
async function noGitAnywhere(t) {
  const empty = join(t.machine.root, "empty");
  mkdirSync(empty, { recursive: true });
  const node = dirname(process.execPath);
  const env = {
    ...t.withPath(node),
    ProgramFiles: empty,
    "ProgramFiles(x86)": empty,
    LOCALAPPDATA: empty,
  };
  const product = t.product("no-git", { git: false });
  const looked = t.json(product, ["doctor", "--json"], { env, status: "any" });
  if (pointOf(looked, "git.installed").outcome !== "missing") {
    throw new TrialSkip("Git is next to Node.js, or in a folder the engine also looks in: this machine cannot be made one without Git");
  }
  checkMissingGit(t, product, env);
}

/** The flow of a creator on a machine like the others: install, `init`, `doctor`, `sync`, `next`, the report. */
async function installFlow(t) {
  const product = t.product(`flow-${t.shell}`);
  // Is Git there for the engine? Its own doctor says (the PATH, then the folders Git installs itself in).
  const before = t.json(product, ["doctor", "--json"], { status: "any" });
  const gitHere = pointOf(before, "git.installed").outcome !== "missing";
  const version = t.cli(product, ["--version"]);
  t.expect(version.stdout.trim() === t.machine.version, `--version printed "${version.stdout.trim()}", expected ${t.machine.version}`);

  if (!gitHere) {
    checkMissingGit(t, product, t.env);
    return;
  }
  const init = t.cli(product, ["init", "--yes"]);
  t.expect(init.output.includes("Method installed in"), `init did not report the installation:\n${init.output}`);
  const config = readFileSync(join(product, ".agentplugged", "method.yaml"), "utf8");
  t.expect(config.includes(`engine_version: ${t.machine.version}`), "method.yaml does not pin the engine version");

  // The keychain and the key agree: no key without a keychain, and the message says why.
  const answer = t.json(product, ["doctor", "--json"]);
  const keychain = pointOf(answer, "keychain");
  if (keychain.outcome === "ok") {
    t.expect(/Your validation key(?: was created|:)/.test(init.output), `init did not create the key although the keychain answers:\n${init.output}`);
  } else {
    t.expect(/No system keychain here/.test(init.output), `the keychain does not answer but init did not say so:\n${init.output}`);
    t.expect(hasRepair(keychain), "no repair is given for the keychain");
  }
  t.expect(answer.platform === process.platform, `doctor says ${answer.platform}`);
  t.expect(pointOf(answer, "node").status === "ok", "Node.js is not ok");
  t.expect(pointOf(answer, "git.installed").status === "ok", "Git is not ok");

  const plain = t.cli(product, ["doctor"], { status: "any" });
  t.expect(plain.stdout.includes("Checking your machine"), "doctor printed no report");
  t.expect(plain.status === (answer.blocking ? 1 : 0), `doctor exited with ${plain.status}, blocking is ${answer.blocking}`);

  const sync = t.cli(product, ["sync"]);
  t.expect(sync.stdout.startsWith("AI tool files synchronized in "), `unexpected sync output:\n${sync.output}`);
  t.expect(existsSync(join(product, "AGENTS.md")), "sync wrote no AGENTS.md");

  const next = t.cli(product, ["next"]);
  t.expect(next.stdout.trim() !== "", "next printed nothing");

  t.reportHasNoLeak(product);
}

/** Git outside the PATH of the terminal: told with the repair, never a crash. */
async function gitOutOfPath(t) {
  const cut = pathWithout({
    without: ["git"],
    base: t.env.PATH ?? t.env.Path ?? "",
    env: t.env,
    farmRoot: join(t.machine.root, "farm-git"),
  });
  if (cut.skipped) throw new TrialSkip(cut.skipped);
  const product = t.product("git-out-of-path");
  const env = t.withPath(cut.path);
  const init = t.cli(product, ["init", "--yes"], { env, status: "any" });
  t.expect(!/\n\s+at .*\(.*:\d+:\d+\)/.test(init.output), `init crashed with a stack:\n${init.output}`);
  t.expect(init.status === 0 || init.status === 1, `init exited with ${init.status}`);
  const answer = t.json(product, ["doctor", "--json"], { env, status: "any" });
  const git = pointOf(answer, "git.installed");
  if (git.outcome === "missing") {
    t.expect(/Git was not found \(not in your PATH, nor in its usual folders\)/.test(git.text.en), `unexpected sentence: ${git.text.en}`);
    t.expect(git.status === "fail" && answer.blocking === true, "a missing Git must block");
    t.expect(hasRepair(git), "no repair is given for the missing Git");
  } else {
    // Installed where the catalogue looks (Git for Windows, Homebrew), or known to the system's own
    // PATH (Windows): the engine says which, and how to put it where the terminal sees it.
    t.expect(["off_path", "stale"].includes(git.outcome), `git.installed is ${git.outcome}`);
    t.expect(
      git.outcome === "stale"
        ? /your system knows that folder, but this program was opened before/.test(git.text.en)
        : /which is not on your PATH/.test(git.text.en),
      `unexpected sentence: ${git.text.en}`,
    );
    t.expect(hasRepair(git), "no repair is given for Git outside the PATH");
  }
}

/** No GitHub CLI: the engine says so, plainly, with the repair, and everything else works. */
async function noGitHubCli(t) {
  // Git stays (it is on the same folder as gh on many Linux machines): only gh goes.
  const cut = pathWithout({
    without: ["gh"],
    needs: ["node", "npm", "git"],
    base: t.env.PATH ?? t.env.Path ?? "",
    env: t.env,
    farmRoot: join(t.machine.root, "farm-gh"),
  });
  if (cut.skipped) throw new TrialSkip(cut.skipped);
  const product = t.product("no-gh", { remote: true });
  const env = t.withPath(cut.path);
  t.cli(product, ["init", "--yes"], { env });
  const answer = t.json(product, ["doctor", "--json"], { env });
  const cli = pointOf(answer, "forge.cli");
  t.expect(cli.status === "warn", `forge.cli is ${cli.status}, a missing gh must not block`);
  if (cli.outcome === "missing") {
    t.expect(/gh was not found \(not in your PATH, nor in its usual folders\)/.test(cli.text.en), `unexpected sentence: ${cli.text.en}`);
    t.expect(JSON.stringify(cli.fix).includes("cli.github.com"), "the repair does not say where to get gh");
  } else {
    // Installed in a folder the catalogue knows (Homebrew), or the system's own PATH holds it (Windows).
    t.expect(["off_path", "stale"].includes(cli.outcome), `forge.cli is ${cli.outcome}`);
    t.expect(
      cli.outcome === "stale"
        ? /your system knows that folder, but this program was opened before/.test(cli.text.en)
        : /is installed in .* which is not on your PATH/.test(cli.text.en),
      `unexpected sentence: ${cli.text.en}`,
    );
    t.expect(hasRepair(cli), "no repair is given for gh outside the PATH");
  }
  t.expect(answer.blocking === false, "a missing gh blocked the product");
}

/** A GitHub CLI that cannot reach GitHub: « cannot tell », never « not connected ». */
async function noConnection(t) {
  const shims = join(t.machine.root, "shims-gh");
  offlineGh(shims);
  const product = t.product("gh-offline", { remote: true });
  const env = t.withPath([shims, t.env.PATH ?? t.env.Path ?? ""].join(t.delimiter));
  t.cli(product, ["init", "--yes"], { env });
  const answer = t.json(product, ["doctor", "--json"], { env });
  const login = pointOf(answer, "forge.login");
  t.expect(login.outcome === "unreadable", `forge.login is ${login.outcome}`);
  t.expect(login.text.en === "Cannot tell whether gh is connected to github.com (no network?)", `unexpected sentence: ${login.text.en}`);
  t.expect(login.status === "warn", "an unreachable network must not block");
}

/** A machine that lost its network after the installation: everything the engine does still works. */
async function offlineAfterInstall(t) {
  const product = t.product("offline");
  const env = {
    ...t.env,
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    npm_config_offline: "true",
  };
  const init = t.cli(product, ["init", "--yes"], { env });
  for (const args of [["sync"], ["next"], ["doctor", "--json"]]) {
    const result = t.cli(product, args, { env, status: "any" });
    t.expect(result.status === 0, `${args[0]} exited with ${result.status} offline:\n${result.output}`);
    t.expect(!/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|ETIMEDOUT/i.test(result.output), `${args[0]} reached for the network:\n${result.output}`);
  }
  t.expect(!/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(init.output), "init reached for the network");
}

/** No Git identity: told in words, with the repair, and the method is still installed. */
async function noGitIdentity(t) {
  const product = t.product("no-identity");
  const env = { ...t.env, GIT_CONFIG_GLOBAL: t.machine.emptyGitConfig };
  const init = t.cli(product, ["init", "--yes"], { env, status: "any" });
  t.expect(!/\n\s+at .*\(.*:\d+:\d+\)/.test(init.output), `init crashed with a stack:\n${init.output}`);
  t.expect(existsSync(join(product, ".agentplugged", "method.yaml")), `the method was not installed without an identity:\n${init.output}`);
  const answer = t.json(product, ["doctor", "--json"], { env, status: "any" });
  const identity = pointOf(answer, "git.identity");
  t.expect(identity.outcome === "unset" && identity.status === "warn", `git.identity is ${identity.status}/${identity.outcome}`);
  t.expect(/Git does not know your name and e-mail yet \(user\.name, user\.email\)/.test(identity.text.en), `unexpected sentence: ${identity.text.en}`);
  const fix = JSON.stringify(identity.fix);
  t.expect(fix.includes("git config --global user.name") && fix.includes("git config --global user.email"), `the repair does not say how to set the identity: ${fix}`);
}

/** Docker installed but stopped: the cause is told apart from « not installed » and « out of memory ». */
async function dockerStopped(t) {
  const shims = join(t.machine.root, "shims-docker");
  stoppedDocker(shims);
  const product = t.product("docker-stopped");
  const env = t.withPath([shims, t.env.PATH ?? t.env.Path ?? ""].join(t.delimiter));
  t.cli(product, ["init", "--yes"], { env });
  const answer = t.json(
    product,
    ["doctor", "--error", "error during connect: dockerDesktopLinuxEngine: The system cannot find the file specified", "--json"],
    { env, status: "any" },
  );
  const docker = observedPoint(answer, "docker.daemon");
  t.expect(/is installed .* but its engine does not answer/.test(docker.text.en), `docker.daemon says: ${docker.text.en}`);
  t.expect(answer.diagnosis.cause === "found", `the cause is ${answer.diagnosis.cause}`);
  t.expect(/but its engine does not answer/.test(answer.diagnosis.headline.en), `unexpected headline: ${answer.diagnosis.headline.en}`);
  t.expect(/Docker Desktop/.test(answer.diagnosis.next?.en ?? ""), `the repair does not say to open Docker: ${answer.diagnosis.next?.en}`);
  t.expect(!/not installed/i.test(answer.diagnosis.headline.en), "Docker was called not installed");
}

/** A folder with spaces, accents and a long path: everything works, and Windows is warned. */
async function longPathWithSpacesAndAccents(t) {
  const name = longFolderName(t.machine.products.length + 1);
  const product = t.product(name);
  t.expect(product.length > 100, `the folder is only ${product.length} characters long`);
  t.cli(product, ["init", "--yes"]);
  const answer = t.json(product, ["doctor", "--json"]);
  t.cli(product, ["sync"]);
  t.cli(product, ["next"]);
  if (process.platform === "win32") {
    const length = pointOf(answer, "path.length");
    t.expect(length.outcome === "long" && length.status === "warn", `path.length is ${length.status}/${length.outcome}`);
    t.expect(/characters long/.test(length.text.en) && hasRepair(length), "the long path is not told with a repair");
  } else {
    t.expect(!answer.points.some((point) => point.id === "path.length"), "path.length is only for Windows");
  }
  t.reportHasNoLeak(product, t.env, [name.slice(0, 14)]);
}

/** A proxy in the environment: found and named, the password never repeated. */
async function proxy(t) {
  const product = t.product("proxy");
  const env = { ...t.env, HTTPS_PROXY: `http://trial:${PLANTED.proxyPassword}@proxy.invalid:3128` };
  t.cli(product, ["init", "--yes"], { env });
  const result = t.cli(product, ["doctor", "--error", "connect ECONNRESET registry.npmjs.org", "--json"], { env, status: "any" });
  t.expect(!result.output.includes(PLANTED.proxyPassword), "the proxy password was repeated");
  const answer = JSON.parse(result.stdout);
  const network = observedPoint(answer, "network.proxy");
  t.expect(network.status === "warn", `network.proxy is ${network.status}`);
  t.expect(/HTTPS_PROXY \(proxy\.invalid\)/.test(network.text.en), `unexpected sentence: ${network.text.en}`);
  t.reportHasNoLeak(product, env);
}

/** Administrator rights and none: what the engine says is what the system is. */
async function administrator(t) {
  const product = t.product("admin");
  t.cli(product, ["init", "--yes"]);
  const answer = t.json(product, ["doctor", "--error", "EACCES: permission denied", "--json"], { status: "any" });
  const rights = observedPoint(answer, "admin.rights");
  // « ok »: the program has the rights; « warn »: it has not (the usual state of daily work).
  const has = rights.status === "ok";
  if (typeof process.getuid === "function") {
    t.expect(has === (process.getuid() === 0), `admin.rights says "${rights.text.en}" for uid ${process.getuid()}`);
  } else {
    t.expect(["ok", "warn"].includes(rights.status), `admin.rights is ${rights.status}`);
  }
  return `${has ? "with" : "without"} administrator rights`;
}

export const SCENARIOS = [
  { id: "install-flow", title: "install, init, doctor, sync, next, report", everyShell: true, run: installFlow },
  { id: "no-git", title: "Node.js and no Git at all", run: noGitAnywhere },
  { id: "git-out-of-path", title: "Git outside the PATH", run: gitOutOfPath },
  { id: "no-github-cli", title: "no GitHub CLI", run: noGitHubCli },
  { id: "no-connection", title: "GitHub CLI without a connection", run: noConnection },
  { id: "offline-after-install", title: "no network after the installation", run: offlineAfterInstall },
  { id: "no-git-identity", title: "no Git identity", run: noGitIdentity },
  { id: "docker-stopped", title: "Docker stopped", run: dockerStopped },
  { id: "long-path", title: "long folder path with spaces and accents", run: longPathWithSpacesAndAccents },
  { id: "proxy", title: "a proxy with a password", run: proxy },
  { id: "administrator", title: "administrator rights as the system has them", run: administrator },
];
