#!/usr/bin/env node
// Kept to syntax old Node.js versions parse: on them, the CLI itself (Node.js 24 features) could
// fail with an obscure error, so the version is checked before the CLI is loaded.
const REQUIRED_MAJOR = 24;
const current = process.versions.node;
if (Number(current.split(".")[0]) < REQUIRED_MAJOR) {
  process.stderr.write(
    `agentplugged needs Node.js ${REQUIRED_MAJOR} or later; this is Node.js ${current}.\n` +
      `agentplugged a besoin de Node.js ${REQUIRED_MAJOR} ou plus récent ; celui-ci est en ${current}.\n`,
  );
  process.exitCode = 1;
} else {
  import("./cli.js").catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}
