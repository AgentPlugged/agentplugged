// Import boundaries between the packages of the monorepo.
// Each rule has a stable name, shown by `--output-type err-long` on failure.

const { existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

/** Path of an internal package, whether resolved (a real file) or unresolved (the module name). */
const internal = (dirs, names) =>
  `^(?:(?:${dirs})/|(?:node_modules/)?@agentplugged/(?:${names})(?:/|$))`;

/** Every app present in apps/: a new app is covered without editing this file. */
const appsDir = join(__dirname, "apps");
const appNames = existsSync(appsDir)
  ? readdirSync(appsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  : [];

const appsOrAdapters = internal(
  "apps/[^/]+|packages/adapters-[^/]+",
  [...appNames, "adapters-[^/]+"].join("|"),
);

const cryptoLibs =
  "^(?:node:)?crypto$|(?:^|/node_modules/|^node_modules/)(?:libsodium[^/]*|sodium-[^/]+|tweetnacl[^/]*|@noble/[^/]+|@cipherman/[^/]+|@scure/[^/]+|@stablelib/[^/]+|@simplewebauthn/[^/]+|crypto-js|node-forge)(?:/|$)";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-no-apps-or-adapters",
      comment:
        "The core (packages/core) must not import any app or any adapter (adapters-*): they depend on the core, never the other way round.",
      severity: "error",
      from: { path: "^packages/core/" },
      to: { path: appsOrAdapters },
    },
    {
      name: "crypto-libs-only-in-crypto",
      comment:
        "Only packages/crypto may import a cryptographic library (libsodium, sodium-*, tweetnacl, @noble/*, @scure/*, @stablelib/*, @simplewebauthn/*, crypto-js, node-forge, node:crypto): every other package must go through @agentplugged/crypto.",
      severity: "error",
      from: { pathNot: "^packages/crypto/" },
      to: { path: cryptoLibs },
    },
  ],
  options: {
    doNotFollow: { path: "(?:^|/)node_modules/" },
    exclude: { path: "(?:^|/)(?:dist|coverage|\\.turbo)/" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      // Internal imports resolve to src/, not to dist/, which is excluded.
      conditionNames: ["@agentplugged/source", "import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};
