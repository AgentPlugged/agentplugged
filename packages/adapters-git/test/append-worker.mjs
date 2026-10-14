// Child process of the journal tests and bench: appends events to the journal of a temporary
// repository through `GitStateStore`, run on the TypeScript sources, with an in-memory key.
// Prints one JSON line: its stats, its device and the ids it wrote.
//
// Usage: node append-worker.mjs <cwd> <seed-base64url> <count> <label> <machine-lock-path>

import "./source-hooks.mjs";

const { GitStateStore } = await import("../src/git-state-store.ts");
const { MemoryKeyStore } = await import("@agentplugged/core");

const [cwd, seed, countText, label, machineLockPath] = process.argv.slice(2);
const count = Number(countText);
const store = new GitStateStore({
  cwd,
  keys: new MemoryKeyStore(seed),
  machineLockPath,
  allowTestTypes: true,
});
const ids = [];
let device;
const started = performance.now();
for (let n = 1; n <= count; n++) {
  const event = await store.append({
    type: "test.appended",
    actor: { kind: "system" },
    product: "01JZ0000000000000000000000",
    provenance: "trusted",
    payload: { writer: label, n },
  });
  device = event.actor.device;
  ids.push(event.id);
}
const durationMs = performance.now() - started;
store.close();
process.stdout.write(`${JSON.stringify({ label, device, ids, durationMs, stats: store.stats })}\n`);
