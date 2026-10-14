// Stand-in programs for the imperfect machines of the install trials: a `gh` that
// cannot reach the network, a `docker` whose engine is stopped. Each one is a tiny launcher
// (`name` on Unix, `name.cmd` on Windows) around a Node script that plays the rules of a JSON
// file: the arguments it is called with, and what it prints and exits with.

import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { findOnPath, folderHolds, WINDOWS } from "./shells.mjs";

const PLAYER = `import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const name = process.argv[1].replace(/\\.shim\\.mjs$/, "").split(/[\\\\/]/).at(-1);
const rules = JSON.parse(readFileSync(join(here, name + ".rules.json"), "utf8"));
const args = process.argv.slice(2);
const rule = rules.find((entry) => entry.args.every((arg, index) => args[index] === arg));
const answer = rule ?? { stdout: "", stderr: name + ": unexpected arguments " + args.join(" "), status: 2 };
if (answer.stdout) process.stdout.write(answer.stdout + "\\n");
if (answer.stderr) process.stderr.write(answer.stderr + "\\n");
process.exit(answer.status ?? 0);
`;

/**
 * Writes the program `name` in `dir`. `rules`: `[{ args: [...], stdout, stderr, status }]`, matched
 * on the first arguments; any other call fails with status 2.
 */
export function writeShim(dir, name, rules, nodePath = process.execPath) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.rules.json`), `${JSON.stringify(rules, null, 2)}\n`);
  writeFileSync(join(dir, `${name}.shim.mjs`), PLAYER);
  const player = join(dir, `${name}.shim.mjs`);
  if (WINDOWS) {
    writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n"${nodePath}" "${player}" %*\r\n`);
  } else {
    const launcher = join(dir, name);
    writeFileSync(launcher, `#!/bin/sh\nexec '${nodePath.replaceAll("'", "'\\''")}' '${player.replaceAll("'", "'\\''")}' "$@"\n`);
    chmodSync(launcher, 0o755);
  }
  return dir;
}

/** A GitHub CLI that is installed but cannot reach GitHub (no network). */
export function offlineGh(dir) {
  return writeShim(dir, "gh", [
    { args: ["--version"], stdout: "gh version 2.60.0 (2026-01-01)", status: 0 },
    {
      args: ["auth", "status"],
      stderr: "error connecting to api.github.com: dial tcp: lookup api.github.com: no such host",
      status: 1,
    },
  ]);
}

/** A Docker whose command is installed but whose engine does not answer. */
export function stoppedDocker(dir) {
  return writeShim(dir, "docker", [
    { args: ["--version"], stdout: "Docker version 27.0.3, build 7d4bcd8", status: 0 },
    {
      args: ["info"],
      stderr:
        "error during connect: Get http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/info: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
      status: 1,
    },
  ]);
}

/**
 * A folder of links to everything in `dir` but the programs in `without`: the same PATH entry,
 * minus those programs (Unix: `gh` and `git` often share `/usr/bin`, which cannot be dropped).
 */
export function folderWithout(dir, without, farm) {
  mkdirSync(farm, { recursive: true });
  for (const entry of readdirSync(dir)) {
    if (without.includes(entry)) continue;
    try {
      symlinkSync(join(dir, entry), join(farm, entry));
    } catch {
      // An entry that cannot be linked is not one of the programs the trial needs.
    }
  }
  return farm;
}

/**
 * A PATH where `shims` come first and the programs in `without` are gone. On Unix a folder that
 * holds one of them is replaced by a folder of links to the rest (`farmRoot` says where to make
 * it); on Windows, or without `farmRoot`, the folder is dropped. Returns `{ path }`, or
 * `{ skipped }` when a program in `needs` would go with them (they share a folder).
 */
export function pathWithout({
  shims = [],
  without = [],
  needs = ["node", "npm"],
  base,
  env = process.env,
  farmRoot,
}) {
  const kept = [];
  let farms = 0;
  for (const dir of base.split(delimiter)) {
    if (dir === "") continue;
    if (!folderHolds(dir, without, env)) {
      kept.push(dir);
    } else if (!WINDOWS && farmRoot !== undefined) {
      farms += 1;
      kept.push(folderWithout(dir, without, join(farmRoot, String(farms))));
    }
  }
  const path = [...shims, ...kept].join(delimiter);
  for (const needed of needs) {
    if (findOnPath(needed, path, env) === undefined) {
      return { skipped: `${needed} lives in the same folder as ${without.join(" or ")}: the PATH cannot be cut around it` };
    }
  }
  return { path };
}
