import { availableParallelism } from "node:os";
import { removeTestKeys, sweepStaleTestKeys } from "@agentplugged/adapters-git/test-keychain";

/**
 * Before the tests: deletes the keys a run that was interrupted left (test services dated an hour
 * or more ago). After them: deletes the entries the tests created in their keychain services, the
 * one of the run and the one of each worker (`<run>-w<n>`, see `vitest.setup.ts`).
 */
export default async function setup(): Promise<() => Promise<void>> {
  await sweepStaleTestKeys();
  return async () => {
    const run = process.env.AGENTPLUGGED_TEST_KEYCHAIN_SERVICE;
    if (run === undefined) return;
    // Worker numbers are 1-based and never exceed the worker count: doubled, for margin.
    const workers = Math.max(availableParallelism(), 8) * 2;
    await removeTestKeys([run, ...Array.from({ length: workers + 1 }, (_, n) => `${run}-w${n}`)]);
  };
}
