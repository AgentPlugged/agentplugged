// Install trials on the creator's own machine, in one command:
//
//   pnpm trials                      what the machine allows: here, then Linux (WSL), then Windows Sandbox
//   pnpm trials here                 this machine, in a temporary folder of its own (no virtual machine, no rights)
//   pnpm trials sandbox              a clean, disposable Windows (Windows Sandbox: Windows 11 Pro, Enterprise or Education)
//   pnpm trials linux                a Linux distribution of WSL (Ubuntu, Debian…), work done on its own disk
//   pnpm trials sandbox --dry-run    writes the Windows Sandbox file and says what it would do; starts nothing
//
//   options: --package <agentplugged-x.y.z.tgz | agentplugged@x.y.z>   (by default, the archive `pnpm pack` makes now;
//            run `pnpm build` first), --node <major> (24 by default, for sandbox and linux), --distro <name>.
//
// `here` changes nothing on the machine. `sandbox` and `linux` start a virtual machine or a WSL
// distribution only when YOU run this command; nothing is installed on your Windows (the Linux
// side keeps a Node.js copy in ~/.cache/agentplugged-trials). Exit code: 0 all passed, 1 a trial
// failed, 2 a trial could not start (the message says what to enable).

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const WINDOWS = process.platform === "win32";
const SANDBOX_EXE = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsSandbox.exe");

const USAGE =
  "usage: pnpm trials [here|sandbox|linux|all] [--package <tgz|agentplugged@x.y.z>] [--node <major>] [--distro <name>] [--dry-run]";

export function parseArguments(argv) {
  const options = { mode: "auto", node: "24", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["here", "sandbox", "linux", "all", "auto"].includes(arg)) options.mode = arg;
    else if (arg === "--package") options.spec = argv[++i];
    else if (arg === "--node") options.node = argv[++i];
    else if (arg === "--distro") options.distro = argv[++i];
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^\d{2}$/.test(options.node)) throw new Error(`--node takes a major version such as 24, not "${options.node}"`);
  if (options.distro !== undefined && !/^[\w.-]+$/.test(options.distro)) throw new Error("--distro takes a distribution name");
  return options;
}

// --- Windows Sandbox ---------------------------------------------------------------------------

const SANDBOX_IN = "C:\\Trial\\in";
const SANDBOX_OUT = "C:\\Trial\\out";

/** The Windows Sandbox configuration: the trial's files read-only, a results folder writable, a bootstrap at logon. */
export function sandboxConfiguration({ inFolder, outFolder, node, archive }) {
  const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>Enable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${escape(inFolder)}</HostFolder>
      <SandboxFolder>${SANDBOX_IN}</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>${escape(outFolder)}</HostFolder>
      <SandboxFolder>${SANDBOX_OUT}</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File ${SANDBOX_IN}\\sandbox-bootstrap.ps1 -Node ${node} -Package ${escape(archive)}</Command>
  </LogonCommand>
</Configuration>
`;
}

/** Copies the trial's files and the package where the sandbox will read them. Returns the folders. */
function stageSandbox(spec, node) {
  const root = mkdtempSync(join(tmpdir(), "agentplugged-sandbox-"));
  const inFolder = join(root, "in");
  const outFolder = join(root, "out");
  mkdirSync(outFolder, { recursive: true });
  cpSync(here, join(inFolder, "install-trials"), {
    recursive: true,
    filter: (path) => !/\.test\.mjs$/.test(path),
  });
  // The bootstrap sits next to the files it starts.
  copyFileSync(join(here, "sandbox-bootstrap.ps1"), join(inFolder, "sandbox-bootstrap.ps1"));
  let archive = spec;
  if (/\.tgz$/i.test(spec)) {
    copyFileSync(spec, join(inFolder, basename(spec)));
    archive = `${SANDBOX_IN}\\${basename(spec)}`;
  }
  const wsb = join(root, "agentplugged-trials.wsb");
  writeFileSync(wsb, sandboxConfiguration({ inFolder, outFolder, node, archive }));
  return { root, inFolder, outFolder, wsb };
}

const ENABLE_SANDBOX = [
  "Windows Sandbox is not turned on on this machine (it needs Windows 11 Pro, Enterprise or Education and virtualization in the BIOS).",
  "To turn it on, once: open PowerShell as administrator and run",
  "    Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All",
  "then restart Windows and run this command again.",
].join("\n");

async function runSandbox(options, spec) {
  if (!WINDOWS) return { status: "unavailable", message: "Windows Sandbox only exists on Windows." };
  if (!existsSync(SANDBOX_EXE) && !options.dryRun) return { status: "unavailable", message: ENABLE_SANDBOX };
  const staged = stageSandbox(spec, options.node);
  if (options.dryRun) {
    return {
      status: "dry-run",
      message: `Windows Sandbox file written: ${staged.wsb}\nIt would open a clean, disposable Windows, install Node.js ${options.node}, try the package without Git, then with Git, and write its results in ${staged.outFolder}.\n(Nothing was started.)`,
    };
  }
  console.log(`Opening Windows Sandbox (a clean Windows, thrown away when you close it).\nResults will appear in ${staged.outFolder}`);
  console.log("This takes several minutes: Node.js and Git are downloaded inside the sandbox. Do not close its window before the results appear here.");
  spawnSync(SANDBOX_EXE, [staged.wsb], { stdio: "ignore" });
  const exitFile = join(staged.outFolder, "exit-code.txt");
  const started = Date.now();
  // The file is written last, and may be read while it is still empty: wait for a number.
  const codeOf = () => {
    try {
      return /^\d+$/.test(readFileSync(exitFile, "utf8").trim()) ? Number(readFileSync(exitFile, "utf8").trim()) : undefined;
    } catch {
      return undefined;
    }
  };
  while (codeOf() === undefined) {
    if (Date.now() - started > 45 * 60_000) {
      return { status: "failed", message: `No result after 45 minutes (the sandbox window closed too early?); look at ${staged.outFolder}` };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
  }
  const summaries = readdirSync(staged.outFolder).filter((name) => name.endsWith(".md")).sort();
  for (const name of summaries) console.log(`\n${readFileSync(join(staged.outFolder, name), "utf8")}`);
  const code = codeOf();
  const result = { status: code === 0 ? "passed" : "failed", message: `Windows Sandbox: results kept in ${staged.outFolder}` };
  if (code === 0) rmSync(staged.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  return result;
}

// --- WSL -------------------------------------------------------------------------------------

/** The distributions `wsl -l -q` lists (its output is UTF-16), without the ones Docker keeps for itself. */
export function parseDistributions(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf16le") : String(buffer);
  return text
    .replaceAll("\u0000", "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\(Default\)/i, "").trim())
    .filter((name) => name !== "" && !/^docker-desktop(?:-data)?$/i.test(name) && !/^rancher-desktop/i.test(name));
}

/** A Windows path as WSL sees it: `C:\a\b` becomes `/mnt/c/a/b`. */
export function wslPath(windowsPath) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (match === null) throw new Error(`not a Windows drive path: ${windowsPath}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

const ENABLE_WSL = [
  "No Linux distribution is installed in WSL (Docker's own does not count).",
  "To install one, once: open PowerShell as administrator and run",
  "    wsl --install -d Ubuntu",
  "then restart Windows, open Ubuntu once to create its user, and run this command again.",
].join("\n");

function runLinux(options, spec) {
  if (!WINDOWS) return { status: "unavailable", message: "This machine is not Windows: `pnpm trials here` tries your own Linux or macOS." };
  const listed = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "buffer", timeout: 30_000 });
  if (listed.error || listed.status !== 0) return { status: "unavailable", message: `WSL is not available.\n${ENABLE_WSL}` };
  const distributions = parseDistributions(listed.stdout);
  const distro = options.distro ?? distributions[0];
  if (distro === undefined) return { status: "unavailable", message: ENABLE_WSL };
  if (options.distro !== undefined && !distributions.includes(options.distro)) {
    return { status: "unavailable", message: `"${options.distro}" is not one of your WSL distributions (${distributions.join(", ")}).` };
  }
  const script = wslPath(join(here, "wsl-bootstrap.sh"));
  const archive = /\.tgz$/i.test(spec) ? wslPath(resolve(spec)) : spec;
  console.log(`Trying the package in ${distro} (WSL). Work is done in its own temporary folder; Node.js is kept in ~/.cache/agentplugged-trials.`);
  if (options.dryRun) {
    return { status: "dry-run", message: `Would run: wsl.exe -d ${distro} -- sh ${script} ${options.node} ${archive}\n(Nothing was started.)` };
  }
  const run = spawnSync("wsl.exe", ["-d", distro, "--", "sh", script, options.node, archive], { stdio: "inherit" });
  return { status: run.status === 0 ? "passed" : "failed", message: `Linux (${distro}, WSL)` };
}

// --- This machine ------------------------------------------------------------------------------

function runHere(spec) {
  console.log("Trying the package on this machine, in a temporary folder of its own (nothing of yours is touched).");
  const run = spawnSync(process.execPath, [join(here, "trial.mjs"), "--package", spec, "--shell", "native"], { stdio: "inherit" });
  return { status: run.status === 0 ? "passed" : run.status === 1 ? "failed" : "unavailable", message: "this machine" };
}

// --- The package -------------------------------------------------------------------------------

/** The archive `pnpm pack` makes from the built CLI, in a temporary folder; or the package asked for. */
export function packageToTry(spec) {
  if (spec !== undefined) return { spec: /\.tgz$/i.test(spec) ? resolve(spec) : spec, cleanup() {} };
  if (!existsSync(join(repoRoot, "apps", "cli", "dist", "bin.js"))) {
    throw new Error("the CLI is not built: run `pnpm build` first (or give --package).");
  }
  const folder = mkdtempSync(join(tmpdir(), "agentplugged-trials-pack-"));
  const pnpm = process.env.npm_execpath && /pnpm/i.test(process.env.npm_execpath) ? process.env.npm_execpath : undefined;
  const command = pnpm === undefined ? "pnpm" : process.execPath;
  const args = [...(pnpm === undefined ? [] : [pnpm]), "--filter", "agentplugged", "pack", "--pack-destination", folder];
  const packed = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", shell: pnpm === undefined && WINDOWS });
  const archive = existsSync(folder) ? readdirSync(folder).find((name) => name.endsWith(".tgz")) : undefined;
  if (packed.status !== 0 || archive === undefined) {
    throw new Error(`pnpm pack failed:\n${packed.stdout ?? ""}${packed.stderr ?? ""}`);
  }
  return { spec: join(folder, archive), cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  let packed;
  try {
    packed = packageToTry(options.spec);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const outcomes = [];
  try {
    const wanted = options.mode === "auto" || options.mode === "all" ? ["here", "linux", "sandbox"] : [options.mode];
    for (const mode of wanted) {
      console.log(`\n=== ${mode} ===`);
      let outcome;
      try {
        outcome =
          mode === "here" ? runHere(packed.spec) : mode === "linux" ? runLinux(options, packed.spec) : await runSandbox(options, packed.spec);
      } catch (error) {
        // A folder that cannot be copied, a path WSL cannot see: told, not a stack.
        outcome = { status: "unavailable", message: `${mode} could not start: ${error.message}` };
      }
      outcomes.push({ mode, ...outcome });
      if (outcome.status === "unavailable" || outcome.status === "dry-run") console.log(outcome.message);
    }
  } finally {
    packed.cleanup();
  }
  console.log("\n--- Summary ---");
  for (const outcome of outcomes) console.log(`${outcome.mode}: ${outcome.status}${outcome.status === "unavailable" && options.mode === "auto" ? " (see above how to enable it)" : ""}`);
  if (outcomes.some((outcome) => outcome.status === "failed")) return 1;
  // Asked by name and impossible: the creator needs to know. In auto mode, only `here` is a must.
  const must = options.mode === "auto" ? ["here"] : outcomes.map((outcome) => outcome.mode);
  return outcomes.some((outcome) => outcome.status === "unavailable" && must.includes(outcome.mode)) ? 2 : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
