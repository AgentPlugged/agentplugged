// Install trials: the packaged CLI, installed in a new folder and typed into the
// terminals creators use, on a clean machine and on imperfect ones.
//
//   node tooling/install-trials/trial.mjs --package <agentplugged-x.y.z.tgz | agentplugged@x.y.z>
//        [--shell native|all|bash,zsh,...] [--scenario <id>]... [--work <folder>] [--summary <file>] [--keep]
//
// With an archive (`pnpm --filter agentplugged pack`), the package is installed from it, like
// `pack-smoke`; with `agentplugged@<version>`, the commands are `npx agentplugged@<version> …`
// themselves, fetched from the registry (what the publication workflow runs). Nothing here touches
// the machine's own settings: the trial has its own home, its own Git settings, its own keychain
// service and its own npm cache, all removed at the end.
//
// Exit code 0: every step passed (steps the machine prevents are told, as warnings or skips);
// 1: a step failed; 2: the trial could not start.

import { appendFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMachine,
  newProduct,
  TrialFailure,
  TrialSkip,
  TrialWarning,
  typeCommand,
} from "./lib/harness.mjs";
import { SCENARIOS } from "./lib/scenarios.mjs";
import { findShell, shellsHere } from "./lib/shells.mjs";
import { summaryMarkdown } from "./lib/summary.mjs";

function parseArguments(argv) {
  const options = { shells: "native", scenarios: [], keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--package") options.spec = argv[++i];
    else if (arg === "--shell") options.shells = argv[++i];
    else if (arg === "--scenario") options.scenarios.push(argv[++i]);
    else if (arg === "--work") options.work = argv[++i];
    else if (arg === "--summary") options.summary = argv[++i];
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const USAGE =
  "usage: node tooling/install-trials/trial.mjs --package <agentplugged-x.y.z.tgz | agentplugged@x.y.z> [--shell native|all|<list>] [--scenario <id>]... [--work <folder>] [--summary <file>] [--keep]";

/** The terminals to type into, by the option. */
export function chooseShells(option, env = process.env) {
  const here = shellsHere();
  if (option === "native") {
    const first = here.find((shell) => findShell(shell, env) !== undefined);
    return first === undefined ? [] : [first];
  }
  if (option === "all") return here;
  return option.split(",").map((name) => name.trim()).filter(Boolean);
}

/** The text of a command's output, cut to what a person reads. */
function tail(text, max = 1800) {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

/** What a scenario gets to work with. */
function contextOf(machine, shell, log) {
  const PATH_NAMES = (env) => Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
  const shellPath = findShell(shell, machine.env);
  const context = {
    machine,
    shell,
    delimiter,
    env: machine.env,
    expect(condition, message) {
      if (!condition) throw new TrialFailure(message);
    },
    /** The environment with another PATH (the one key the system reads, whatever its case). */
    withPath(path) {
      const env = { ...machine.env };
      for (const key of PATH_NAMES(env)) delete env[key];
      env[process.platform === "win32" ? "Path" : "PATH"] = path;
      return env;
    },
    product(name, options) {
      return newProduct(machine, name, options);
    },
    cli(product, args, { env = machine.env, status = 0 } = {}) {
      const result = typeCommand({ shell, shellPath, argv: machine.npx(args), cwd: product, env });
      if ((shell === "powershell" || shell === "pwsh") && /running scripts is disabled|UnauthorizedAccess/i.test(result.output)) {
        throw new TrialWarning(
          "PowerShell's execution policy blocks npx.ps1 on this machine: type `npx.cmd agentplugged …` or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (the engine never started)",
        );
      }
      log(`  $ ${result.line}  → ${result.status}`);
      if (status !== "any" && result.status !== status) {
        throw new TrialFailure(
          `${result.line}\n  exited with ${result.status}, expected ${status}\n${tail(result.output)}`,
        );
      }
      return result;
    },
    json(product, args, options) {
      const result = context.cli(product, args, options);
      try {
        return JSON.parse(result.stdout);
      } catch {
        throw new TrialFailure(`${result.line}\n  did not print JSON:\n${tail(result.output)}`);
      }
    },
    /** `doctor --report` carries nothing personal: the trial's own private values, and the planted ones. */
    reportHasNoLeak(product, env = machine.env, extra = []) {
      const report = context.cli(product, ["doctor", "--report"], { env });
      context.expect(report.stdout.includes("# AgentPlugged: environment report"), `no report:\n${tail(report.output)}`);
      context.expect(report.stdout.includes("## Removed from this report"), "the report does not list what it removes");
      const text = report.stdout.toLowerCase();
      const values = [...machine.privateValues(), ...extra].filter((value) => value.length >= 3);
      for (const value of values) {
        context.expect(!text.includes(value.toLowerCase()), `the report carries "${value}"`);
      }
      context.expect(!/ghp_|npm_[a-z0-9]{20}/i.test(report.stdout), "the report carries a token");
    },
  };
  return context;
}

/** Plays the scenarios; returns the results, one per scenario and terminal. */
export async function play({ machine, shells, scenarios, log = console.log }) {
  const results = [];
  const native = shells[0];
  const blocked = new Set();
  for (const scenario of scenarios) {
    const where = scenario.everyShell ? shells : native === undefined ? [] : [native];
    for (const shell of where) {
      const label = `[${shell}] ${scenario.title}`;
      if (blocked.has(shell)) {
        results.push({ scenario: scenario.id, shell, title: scenario.title, status: "skip", detail: "this terminal is blocked, see above" });
        continue;
      }
      log(`\n${label}`);
      try {
        if (findShell(shell, machine.env) === undefined) throw new TrialSkip(`${shell} is not on this machine`);
        const detail = await scenario.run(contextOf(machine, shell, log));
        results.push({ scenario: scenario.id, shell, title: scenario.title, status: "pass", detail: typeof detail === "string" ? detail : "" });
        log("  ok");
      } catch (error) {
        const status = error instanceof TrialSkip ? "skip" : error instanceof TrialWarning ? "warn" : "fail";
        if (status === "warn") blocked.add(shell);
        const detail = error instanceof Error ? error.message : String(error);
        results.push({ scenario: scenario.id, shell, title: scenario.title, status, detail });
        log(`  ${status.toUpperCase()}: ${detail}`);
      }
    }
  }
  return results;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.help || options.spec === undefined) {
    console.error(USAGE);
    return options.help ? 0 : 2;
  }
  const unknown = options.scenarios.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
  if (unknown.length > 0) {
    console.error(`unknown scenario: ${unknown.join(", ")} (known: ${SCENARIOS.map((s) => s.id).join(", ")})`);
    return 2;
  }
  const scenarios = options.scenarios.length === 0 ? SCENARIOS : SCENARIOS.filter((s) => options.scenarios.includes(s.id));
  const log = (line) => console.log(line);
  let machine;
  let results;
  try {
    machine = createMachine({ spec: options.spec, work: options.work, log });
    machine.install();
    const shells = chooseShells(options.shells, machine.env);
    if (shells.length === 0) {
      console.error("no terminal of the platform was found");
      return 2;
    }
    log(`agentplugged ${machine.version} (${machine.mode}) on ${process.platform}/${process.arch}, Node ${process.version}, terminals: ${shells.join(", ")}`);
    results = await play({ machine, shells, scenarios, log });
  } catch (error) {
    console.error(`the trial could not run: ${error.message}`);
    return 2;
  } finally {
    if (machine !== undefined && !options.keep) machine.cleanup();
  }
  const markdown = summaryMarkdown({
    version: machine.version,
    mode: machine.mode,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    results,
  });
  console.log(`\n${markdown}`);
  const target = options.summary ?? process.env.GITHUB_STEP_SUMMARY;
  if (target) appendFileSync(target, `${markdown}\n`);
  // A trial where nothing passed proved nothing: red, even if nothing failed either.
  return results.some((result) => result.status === "fail") || !results.some((result) => result.status === "pass")
    ? 1
    : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
