import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The first libsodium / WebAuthn load is slow on a cold CI runner: allow it.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    // The vectors generators import this package by name: in tests, they run on the sources.
    alias: [
      {
        find: /^@agentplugged\/crypto\/testing$/,
        replacement: fileURLToPath(new URL("./src/testing.ts", import.meta.url)),
      },
      {
        find: /^@agentplugged\/crypto$/,
        replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
    ],
  },
});
