import { describe, expect, it } from "vitest";
import { loadMachineKey, MemoryKeyStore } from "../journal/key-store.js";
import { MemoryStateStore } from "../journal/memory-state-store.js";
import { planPrimaryChange } from "./primary.js";
import { readPrimaryFacts, writePrimaryChange } from "./primary-write.js";

const PRODUCT = "01K6KXJ5G0PR0DVCT00000000A";

async function world() {
  const keys = new MemoryKeyStore();
  const machine = await loadMachineKey(keys);
  const store = new MemoryStateStore({ keys });
  await store.append({
    type: "git.workflow_set",
    actor: { kind: "system" },
    product: PRODUCT,
    provenance: "trusted",
    payload: { workflow: {}, previous: null, source: "init", forge: false },
  });
  return { store, machine };
}

describe("the facts a bridge reads before it becomes the main one", () => {
  it("lists the head of each writer and the hashes the bridge holds, and no main bridge yet", async () => {
    const { store, machine } = await world();
    const facts = await readPrimaryFacts(store, PRODUCT);
    expect(facts.current).toBeNull();
    expect(Object.keys(facts.heads)).toEqual([machine.device]);
    expect(facts.known.has(facts.heads[machine.device] as string)).toBe(true);
  });

  it("lets the plan accept the change, and the event it writes becomes the main bridge", async () => {
    const { store, machine } = await world();
    const facts = await readPrimaryFacts(store, PRODUCT);
    const plan = planPrimaryChange({
      current: facts.current,
      candidate: {
        bridge: machine.device,
        trusted: true,
        serves: true,
        online: true,
        protocol: 1,
        known: facts.known,
      },
      heads: facts.heads,
      protocol: 1,
    });
    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok || plan.payload === null) throw new Error("expected a change");
    const event = await writePrimaryChange(store, PRODUCT, plan.payload);
    expect(event.actor.kind).toBe("system");
    expect((await readPrimaryFacts(store, PRODUCT)).current).toBe(machine.device);
  });

  it("refuses the change while the bridge lacks an event the creator's device saw", async () => {
    const { store, machine } = await world();
    const facts = await readPrimaryFacts(store, PRODUCT);
    const plan = planPrimaryChange({
      current: null,
      candidate: {
        bridge: machine.device,
        trusted: true,
        serves: true,
        online: true,
        protocol: 1,
        known: facts.known,
      },
      heads: { ...facts.heads, "machine:ZZZZZZZZZZZZZZZZ": `sha256:${"A".repeat(43)}` },
      protocol: 1,
    });
    expect(plan).toMatchObject({ ok: false, code: "PRIMARY_BRIDGE_NOT_SYNCED" });
  });
});
