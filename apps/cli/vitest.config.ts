import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// Every test of the CLI, in process or through the built binary (which inherits the
// environment), uses keychain services of this run only, deleted afterwards
// (`vitest.global-setup.ts`): the machine's real entries `agentplugged/machine` and
// `agentplugged/human` are never touched. `vitest.setup.ts` gives each worker a service of its
// own, derived from the one of the run. Windows Hello is turned off: no test ever prompts; the
// review tests give a software authenticator.
process.env.AGENTPLUGGED_TEST_KEYCHAIN_SERVICE ??= `agentplugged-test-cli-${process.pid}-${Date.now()}`;

/**
 * Most tests chain tens of processes (the built binary, Git): on Windows each spawn costs
 * 100 ms or more once the machine is busy. One worker per core, next to another package's tests
 * or another run, starved them past their budget; a third of the cores keeps each test's latency
 * bounded.
 */
const MAX_WORKERS = Math.max(2, Math.floor(availableParallelism() / 3));

export default defineConfig({
  test: {
    // Many tests spawn the built binary or git: allow for a loaded machine (parallel builds, CI runner).
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: MAX_WORKERS,
    env: {
      AGENTPLUGGED_TEST_KEYCHAIN_SERVICE: process.env.AGENTPLUGGED_TEST_KEYCHAIN_SERVICE,
      AGENTPLUGGED_PRESENCE: "none",
      // No test looks at the real machine (git, gh, the keychain) unless it gives its own.
      AGENTPLUGGED_ENVIRONMENT: "none",
    },
    setupFiles: ["./vitest.setup.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
  },
});
