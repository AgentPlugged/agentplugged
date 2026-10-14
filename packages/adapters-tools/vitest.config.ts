import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each probe test spawns real processes (cmd.exe on Windows): allow for a loaded CI runner.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
