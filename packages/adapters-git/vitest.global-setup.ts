import { sweepStaleTestKeys } from "./src/test-keychain.js";

/** Before the tests: deletes the keys an interrupted run left (test services dated an hour or more ago). */
export default async function setup(): Promise<void> {
  await sweepStaleTestKeys();
}
