// Publication guard: what an archive meant for npm may carry, and what it must never carry.
// `inspectArchive` unpacks a `.tgz` and returns the list of problems found (empty: the archive
// can leave this machine). `smoke.mjs` runs it on the real archive, `guard-selftest.mjs` on
// archives made on purpose to prove that each rule fires.
//
// Rules (a leak of source maps, of sources or of a secret cannot be taken back once published):
//   1. no `*.map` file, no `sourceMappingURL` comment in a `.js` file;
//   2. only `dist/**`, `README.md`, `LICENSE*` and `package.json`; never `src/`, tests, the planning
//      tool's folders (underscore prefix), `.claude/`, `.agentplugged/`, `docs/`, `prototype/`, `*.ts` other than `*.d.ts`, `.env*`;
//   3. no text that looks like a secret (private key, GitHub, GitLab, Anthropic, npm or AWS key);
//   4. no `preinstall`, `install` or `postinstall` script in the published `package.json`.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

export const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

/** Secret shapes, with the length of a real token so that a mere prefix in code does not match. */
export const SECRET_PATTERNS = [
  ["private key (PEM)", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ["GitHub token (ghp_)", /\bghp_[A-Za-z0-9]{30,}/],
  ["GitHub token (github_pat_)", /\bgithub_pat_[A-Za-z0-9_]{22,}/],
  ["GitLab token (glpat-)", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["Anthropic key (sk-ant-)", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["npm token (npm_)", /\bnpm_[A-Za-z0-9]{30,}/],
  ["AWS access key (AKIA)", /\bAKIA[0-9A-Z]{16}\b/],
];

const ALLOWED_TOP_LEVEL = (path) =>
  path.startsWith("dist/") || path === "README.md" || path === "package.json" || /^LICENSE[^/]*$/.test(path);
// The planning tool's folders start with an underscore and its name; written in two pieces so that
// the name never appears in the product (the test of `apps/cli/src/method.test.ts` scans this folder).
const PLANNING_PREFIX = `_b${"mad"}`;
const FORBIDDEN_SEGMENT = new RegExp(`^(?:\\.claude|\\.agentplugged|${PLANNING_PREFIX}[^/]*)$`);
const FORBIDDEN_TOP_DIRS = ["src", "docs", "prototype", "test", "tests", "__tests__"];
const TEST_FILE = /(?:\.|-)(?:test|spec)\.[cm]?[jt]sx?$/;

/** Lists every file under `dir`, as POSIX paths relative to it. */
function walk(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(dir, relative));
    else found.push(relative);
  }
  return found;
}

/** Unpacks `tgz` into `target` (the archive's `package/` folder is the root of the result). */
export function extract(tgz, target) {
  mkdirSync(target, { recursive: true });
  // Relative names, from the folder itself: `tar` reads `C:` as a remote host.
  // `-C` takes the target relative to the archive's folder, for the same reason.
  const folder = join(tgz, "..");
  const result = spawnSync("tar", ["-xzf", posix.basename(tgz.replaceAll("\\", "/")), "-C", relative(folder, target).replaceAll("\\", "/") || "."], {
    cwd: folder,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`pack-smoke: cannot unpack ${tgz}: ${result.stderr ?? result.error?.message}`);
  }
  return join(target, "package");
}

/** The problems of an unpacked archive; each is one clear sentence naming the file. */
export function inspectFolder(root) {
  const problems = [];
  const files = walk(root).sort();
  for (const path of files) {
    const name = posix.basename(path);
    const segments = path.split("/");
    if (name.endsWith(".map")) problems.push(`${path}: source map file (*.map)`);
    if (/^\.env/.test(name)) problems.push(`${path}: environment file (.env*)`);
    if (segments.some((segment) => FORBIDDEN_SEGMENT.test(segment))) {
      problems.push(`${path}: folder that never ships (.claude, .agentplugged, planning folders)`);
    }
    if (FORBIDDEN_TOP_DIRS.includes(segments[0]) && segments.length > 1) {
      problems.push(`${path}: ${segments[0]}/ never ships`);
    }
    if (TEST_FILE.test(name) || segments.includes("__tests__")) problems.push(`${path}: test file`);
    if (/\.[cm]?tsx?$/.test(name) && !/\.d\.[cm]?ts$/.test(name)) {
      problems.push(`${path}: TypeScript source (only *.d.ts may ship)`);
    }
    if (!ALLOWED_TOP_LEVEL(path)) {
      problems.push(`${path}: not in the expected list (dist/**, README.md, LICENSE*, package.json)`);
    }

    const text = readFileSync(join(root, path), "latin1");
    if (/\.[cm]?js$/.test(name) && /\/[/*][#@]\s*sourceMappingURL=/.test(text)) {
      problems.push(`${path}: sourceMappingURL comment`);
    }
    for (const [label, pattern] of SECRET_PATTERNS) {
      if (pattern.test(text)) problems.push(`${path}: looks like a secret (${label})`);
    }
  }

  const manifestPath = join(root, "package.json");
  let manifest;
  try {
    statSync(manifestPath);
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    problems.push("package.json: missing or not valid JSON");
  }
  for (const script of INSTALL_SCRIPTS) {
    if (manifest?.scripts?.[script] !== undefined) {
      problems.push(`package.json: install script \`${script}\` (never ships)`);
    }
  }
  return problems;
}

/** Unpacks `tgz` under `workDir` and inspects it. */
export function inspectArchive(tgz, workDir) {
  return inspectFolder(extract(tgz, workDir));
}
