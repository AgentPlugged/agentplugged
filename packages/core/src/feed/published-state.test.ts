import { PublishedPhasesSchema, PublishedStateSchema } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { renderMethodConfig } from "../init/method-config.js";
import { loadMachineKey, MemoryKeyStore } from "../journal/key-store.js";
import { MemoryStateStore } from "../journal/memory-state-store.js";
import { publishesFor } from "../machines/primary.js";
import { writePrimaryChange } from "../machines/primary-write.js";
import { inactiveAgents } from "../profile/catalog.js";
import { resolveProfile } from "../profile/profile.js";
import { computeProjection } from "../projection/compute-projection.js";
import { cursorOfEvents, publishedPhases, readPublishedState } from "./published-state.js";

const PRODUCT = "01K6KXJ5G0PR0DVCT00000000A";

async function world() {
  const keys = new MemoryKeyStore();
  const machine = await loadMachineKey(keys);
  const store = new MemoryStateStore({ keys });
  const write = () =>
    store.append({
      type: "git.workflow_set",
      actor: { kind: "system" },
      product: PRODUCT,
      provenance: "trusted",
      payload: { workflow: {}, previous: null, source: "init", forge: false },
    });
  await write();
  return { store, machine, write, keys };
}

describe("the published state of a product", () => {
  it("is the projection the engine computes, with the trust, the machines and the import around it", async () => {
    const { store, keys } = await world();
    const read = await readPublishedState(store, PRODUCT, { keys });
    const listing = await store.list();
    const projection = await computeProjection(listing.events, {
      problems: listing.problems,
      head: listing.head,
      product: PRODUCT,
    });
    expect(read.state.projection).toEqual(projection);
    expect(PublishedStateSchema.safeParse(read.state).success).toBe(true);
    expect(read.state.trust).toEqual({ blocked: false, devices: {}, revoked: [] });
    expect(read.state.machines.primary).toBeNull();
    expect(read.state.import.state).toBe("none");
    expect(read.head).toBe(listing.head);
  });

  it("carries a cursor that moves with each event and names the head of each writer", async () => {
    const { store, machine, write } = await world();
    const first = await readPublishedState(store, PRODUCT);
    expect(first.cursor.n).toBeGreaterThan(0);
    expect(Object.keys(first.cursor.heads)).toEqual([machine.device]);
    await write();
    const second = await readPublishedState(store, PRODUCT);
    expect(second.cursor.n).toBe(first.cursor.n + 1);
    expect(second.cursor.heads[machine.device]).not.toBe(first.cursor.heads[machine.device]);
    expect(cursorOfEvents((await store.list()).events)).toEqual(second.cursor);
    expect(second.latestEventAt).not.toBeNull();
  });

  it("says which bridge is the main one, as the journal does", async () => {
    const { store, machine } = await world();
    await writePrimaryChange(store, PRODUCT, { bridge: machine.device, previous: null });
    const read = await readPublishedState(store, PRODUCT, { importState: "running" });
    expect(read.state.machines.primary).toBe(machine.device);
    expect(read.state.import.state).toBe("running");
  });

  it("is deterministic: the same journal gives the same state", async () => {
    const { store } = await world();
    const a = await readPublishedState(store, PRODUCT);
    const b = await readPublishedState(store, PRODUCT);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });
});

describe("the phases of a product", () => {
  const config = () => {
    const profile = resolveProfile("new-product");
    return renderMethodConfig({
      format_version: 2,
      engine_version: "1.0.0",
      profile,
      agents: { inactive: inactiveAgents(profile) },
    });
  };

  it("are published under the profile on the machine, and only then", async () => {
    const { store } = await world();
    const without = await readPublishedState(store, PRODUCT);
    expect(without.state.projection.state).not.toHaveProperty("phases");
    const read = await readPublishedState(store, PRODUCT, { methodConfig: config() });
    const phases = PublishedPhasesSchema.parse(read.state.projection.state.phases);
    expect(phases.current).toBe("framing");
    expect(phases.phases.find((entry) => entry.id === "framing")?.status).toBe("in_progress");
    expect(phases.phases.find((entry) => entry.id === "build")?.status).toBe("upcoming");
    expect(phases.phases).toHaveLength(6);
    expect(PublishedStateSchema.safeParse(read.state).success).toBe(true);
  });

  it("are left out when the profile cannot be read, never guessed", async () => {
    expect(publishedPhases({}, undefined, 0)).toBeUndefined();
    expect(publishedPhases({}, "not: [valid", 0)).toBeUndefined();
  });
});

describe("the import of a history", () => {
  it("reads the first events only while it is under way, with the product's own totals", async () => {
    const { store, write } = await world();
    for (let index = 0; index < 5; index += 1) await write();
    const whole = await readPublishedState(store, PRODUCT);
    expect(whole.totals.events).toBe((await store.list()).events.length);

    const part = await readPublishedState(store, PRODUCT, {
      importState: "running",
      importTotals: whole.totals,
      upTo: 3,
    });
    expect(part.state.import).toEqual({
      state: "running",
      progress: { events_done: 3, events_total: whole.totals.events },
      stories: 0,
      validations: 0,
    });
    expect(part.cursor.n).toBe(3);
    expect(PublishedStateSchema.safeParse(part.state).success).toBe(true);
    expect(part.totals.events).toBe(3);
  });

  it("tells the refused events once all the events are in, and shows the live numbers when done", async () => {
    const { store } = await world();
    const whole = await readPublishedState(store, PRODUCT);
    const done = await readPublishedState(store, PRODUCT, { importState: "done" });
    expect(done.state.import).toEqual({
      state: "done",
      progress: { events_done: whole.totals.events, events_total: whole.totals.events },
      stories: 0,
      validations: 0,
      ignored: 0,
    });
  });

  it("leaves the import out of a product that imports nothing", async () => {
    const { store } = await world();
    expect((await readPublishedState(store, PRODUCT)).state.import).toEqual({ state: "none" });
  });
});

describe("who publishes", () => {
  const self = "machine:AAAAAAAAAAAAAAAA";
  const other = "machine:BBBBBBBBBBBBBBBB";
  it("is the main bridge, and only it", () => {
    expect(publishesFor(self, self, [self, other])).toBe(true);
    expect(publishesFor(self, other, [self, other])).toBe(false);
  });
  it("is the only trusted machine while none was chosen", () => {
    expect(publishesFor(self, null, [self])).toBe(true);
    expect(publishesFor(self, null, [self, other])).toBe(false);
    expect(publishesFor(self, null, [])).toBe(false);
  });
});
