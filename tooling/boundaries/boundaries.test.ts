import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

// Each case spawns dependency-cruiser; the first one pays its cold start.
vi.setConfig({ testTimeout: 180_000 });

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const config = join(repoRoot, ".dependency-cruiser.cjs");
const depcruise = join(repoRoot, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");

const scratch = mkdtempSync(join(tmpdir(), "boundaries-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Writes a small tree of source files and cruises it with the repository configuration. */
function cruise(name: string, files: Record<string, string>) {
  const cwd = join(scratch, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const targets = ["apps", "packages"].filter((dir) => Object.keys(files).some((p) => p.startsWith(`${dir}/`)));
  const result = spawnSync(
    process.execPath,
    [depcruise, ...targets, "--config", config, "--output-type", "err-long"],
    { cwd, encoding: "utf8", timeout: 120_000 },
  );
  // err-long wraps comments over several lines.
  const output = `${result.stdout}${result.stderr}`.replace(/\s+/g, " ");
  return { status: result.status, output };
}

describe("import boundaries", () => {
  it("accepts a tree that follows the allowed dependency graph", () => {
    const { status, output } = cruise("compliant", {
      "packages/protocol/src/index.ts": 'export const protocol = "protocol";\n',
      "packages/crypto/src/index.ts":
        'import { randomBytes } from "node:crypto";\nimport "libsodium-wrappers";\nimport { protocol } from "../../protocol/src/index.js";\nexport const crypto = [protocol, randomBytes];\n',
      "packages/core/src/index.ts":
        'import { crypto } from "../../crypto/src/index.js";\nimport { protocol } from "../../protocol/src/index.js";\nexport const core = [crypto, protocol];\n',
      "packages/adapters-git/src/index.ts":
        'import { core } from "../../core/src/index.js";\nexport const adaptersGit = core;\n',
    });
    expect(output).toContain("no dependency violations found");
    expect(status).toBe(0);
  });

  it.each([
    [
      "core-imports-app",
      "core-no-apps-or-adapters",
      "must not import any app",
      {
        "packages/core/src/index.ts": 'import "@agentplugged/cli";\nexport const core = "core";\n',
      },
    ],
    [
      "core-imports-adapter",
      "core-no-apps-or-adapters",
      "must not import any app",
      {
        "packages/adapters-git/src/index.ts": 'export const adaptersGit = "adapters-git";\n',
        "packages/core/src/index.ts":
          'import { adaptersGit } from "../../adapters-git/src/index.js";\nexport const core = adaptersGit;\n',
      },
    ],
    [
      "libsodium-outside-crypto",
      "crypto-libs-only-in-crypto",
      "Only packages/crypto",
      { "packages/protocol/src/index.ts": 'import "libsodium-wrappers";\nexport const protocol = "protocol";\n' },
    ],
    [
      "node-crypto-outside-crypto",
      "crypto-libs-only-in-crypto",
      "Only packages/crypto",
      { "packages/core/src/index.ts": 'import { createHash } from "node:crypto";\nexport const core = createHash;\n' },
    ],
    [
      "bare-crypto-outside-crypto",
      "crypto-libs-only-in-crypto",
      "Only packages/crypto",
      { "packages/core/src/index.ts": 'import { createHash } from "crypto";\nexport const core = createHash;\n' },
    ],
    [
      "tweetnacl-outside-crypto",
      "crypto-libs-only-in-crypto",
      "Only packages/crypto",
      { "packages/protocol/src/index.ts": 'import "tweetnacl";\nexport const protocol = "protocol";\n' },
    ],
    [
      "noble-outside-crypto",
      "crypto-libs-only-in-crypto",
      "Only packages/crypto",
      { "packages/protocol/src/index.ts": 'import "@noble/curves/ed25519";\nexport const protocol = "protocol";\n' },
    ],
  ] as const)("fails %s and names rule %s with its comment", (fixture, rule, comment, files) => {
    const { status, output } = cruise(fixture, { ...files });
    expect(status).not.toBe(0);
    expect(output).toContain(`error ${rule}:`);
    expect(output).toContain(comment);
  });
});
