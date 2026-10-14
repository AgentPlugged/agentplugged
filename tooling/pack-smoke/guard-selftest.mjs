// Proof that every rule of the publication guard fires: archives are made on purpose, one per
// rule, each from a clean package plus one fault. Run alone by `pnpm smoke:guard`, and first by
// `pnpm smoke`. Exits with a non-zero code when a rule does not fire, or when the clean package
// is refused.
//
// Fake secrets are assembled from pieces so that this file itself never looks like a leak.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectArchive } from "./guard.mjs";

const alnum = (n) => "a1B2".repeat(Math.ceil(n / 4)).slice(0, n);
const CLEAN_MANIFEST = { name: "agentplugged", version: "0.0.0", scripts: { build: "tsdown" } };

/** The files of a package that passes: the base of every case. */
function cleanFiles() {
  return {
    "package.json": JSON.stringify(CLEAN_MANIFEST),
    "README.md": "# agentplugged\n",
    LICENSE: "FSL-1.1-MIT\n",
    "LICENSE-METHOD": "MIT\n",
    "dist/bin.js": "export {};\n",
    "dist/cli.d.ts": "export {};\n",
    "dist/method/models.yaml": "tiers: {}\n",
  };
}

/** [name, files added or replaced, text the problems must mention]. */
const CASES = [
  ["source map file", { "dist/cli.js.map": "{}" }, "dist/cli.js.map: source map file"],
  ["sourceMappingURL comment", { "dist/cli.js": "export {};\n//# sourceMappingURL=cli.js.map\n" }, "dist/cli.js: sourceMappingURL"],
  ["src/ folder", { "src/main.ts": "export {};\n" }, "src/main.ts: src/ never ships"],
  ["test file", { "dist/main.test.js": "export {};\n" }, "dist/main.test.js: test file"],
  ["planning folder", { [`_b${"mad"}-output/notes.md`]: "x\n" }, `_b${"mad"}-output/notes.md: folder that never ships`],
  [".claude folder", { ".claude/settings.json": "{}" }, ".claude/settings.json: folder that never ships"],
  [".agentplugged folder", { ".agentplugged/method.yaml": "x: 1\n" }, ".agentplugged/method.yaml: folder that never ships"],
  ["docs folder", { "docs/etude.md": "x\n" }, "docs/etude.md: docs/ never ships"],
  ["prototype folder", { "prototype/index.html": "<p>x</p>" }, "prototype/index.html: prototype/ never ships"],
  ["TypeScript source", { "dist/extra.ts": "export const a = 1;\n" }, "dist/extra.ts: TypeScript source"],
  [".env file", { ".env": "A=1\n" }, ".env: environment file"],
  ["file outside the list", { "CHANGELOG.md": "x\n" }, "CHANGELOG.md: not in the expected list"],
  ["PEM private key", { "dist/key.js": "const k = `-----BEGIN PRIVATE KEY-----`;\n" }, "private key (PEM)"],
  ["GitHub token ghp_", { "dist/a.js": `const t = "ghp_${alnum(36)}";\n` }, "GitHub token (ghp_)"],
  ["GitHub token github_pat_", { "dist/a.js": `const t = "github_pat_${alnum(40)}";\n` }, "GitHub token (github_pat_)"],
  ["GitLab token glpat-", { "dist/a.js": `const t = "glpat-${alnum(24)}";\n` }, "GitLab token (glpat-)"],
  ["Anthropic key sk-ant-", { "dist/a.js": `const t = "sk-ant-${alnum(40)}";\n` }, "Anthropic key (sk-ant-)"],
  ["npm token npm_", { "dist/a.js": `const t = "npm_${alnum(36)}";\n` }, "npm token (npm_)"],
  ["AWS key AKIA", { "dist/a.js": `const t = "AKIA${"A1B2C3D4E5F6G7H8".slice(0, 16)}";\n` }, "AWS access key (AKIA)"],
  ...["preinstall", "install", "postinstall"].map((script) => [
    `${script} script`,
    { "package.json": JSON.stringify({ ...CLEAN_MANIFEST, scripts: { [script]: "node setup.js" } }) },
    `install script \`${script}\``,
  ]),
];

function pack(work, name, files) {
  const dir = join(work, `${name.replace(/\W+/g, "-")}-src`);
  for (const [path, content] of Object.entries({ ...cleanFiles(), ...files })) {
    mkdirSync(join(dir, "package", dirname(path)), { recursive: true });
    writeFileSync(join(dir, "package", path), content);
  }
  const archive = `${name.replace(/\W+/g, "-")}.tgz`;
  const result = spawnSync("tar", ["-czf", join("..", archive), "package"], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot build the test archive ${archive}: ${result.stderr}`);
  return join(work, archive);
}

const work = mkdtempSync(join(tmpdir(), "agentplugged-guard-"));
let failures = 0;
try {
  const clean = inspectArchive(pack(work, "clean", {}), join(work, "out-clean"));
  if (clean.length > 0) {
    failures++;
    console.error(`guard-selftest: the clean package was refused:\n  ${clean.join("\n  ")}`);
  }
  for (const [name, files, expected] of CASES) {
    const problems = inspectArchive(pack(work, name, files), join(work, `out-${name.replace(/\W+/g, "-")}`));
    if (problems.some((problem) => problem.includes(expected))) {
      console.log(`guard-selftest: ok, ${name} is refused`);
    } else {
      failures++;
      console.error(`guard-selftest: FAILED, ${name} was not refused as "${expected}": ${JSON.stringify(problems)}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
if (failures > 0) {
  console.error(`guard-selftest: ${failures} rule(s) did not fire.`);
  process.exit(1);
}
console.log(`guard-selftest: the ${CASES.length} rules fire, the clean package passes.`);
