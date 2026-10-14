import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import { afterAll } from "vitest";

// A keychain service per worker: two test files running side by side never share the machine
// key, the creator's key or a product key. Files of one worker run one after the other, and the
// service is emptied after each. The binaries the tests start inherit it.
const run = process.env.AGENTPLUGGED_TEST_KEYCHAIN_SERVICE;
if (run === undefined || run === "agentplugged") {
  throw new Error("AGENTPLUGGED_TEST_KEYCHAIN_SERVICE is not set: see vitest.config.ts");
}
const service = `${run}-w${process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "0"}`;
process.env.AGENTPLUGGED_KEYCHAIN_SERVICE = service;

afterAll(async () => {
  await removeTestKeys(service);
});
