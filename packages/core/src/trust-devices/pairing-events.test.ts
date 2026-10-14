import { deviceIdOf, generateEd25519, generateX25519, toBase64url } from "@agentplugged/crypto";
import { DEVICE_TRUST_EVENT_TYPES, type RootPin } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { loadMachineKey, MemoryKeyStore } from "../journal/key-store.js";
import { MemoryStateStore } from "../journal/memory-state-store.js";
import {
  buildPairedPayload,
  buildProvisionalRevocation,
  pairedHeadIfTrusted,
  readDeviceTrust,
  writeConfirmedDevice,
  writePairedDevice,
  writeProvisionalRevocation,
} from "./pairing-events.js";

const PRODUCT = "01K6KXJ5G0PR0DVCT00000000A";
const NOW = "2026-10-08T10:00:00.000Z";

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
  const sig = await generateEd25519();
  const enc = await generateX25519();
  const browser = deviceIdOf("browser", sig.publicKey);
  const pin: RootPin = { device: machine.device, public_key: toBase64url(machine.publicKey) };
  const payload = await buildPairedPayload(
    {
      device: browser,
      kind: "browser",
      sigKey: toBase64url(sig.publicKey),
      encKey: toBase64url(enc.publicKey),
      bridge: machine.device,
      provisional: true,
      issuedAt: NOW,
    },
    { device: machine.device, secretKey: machine.secretKey },
  );
  return { store, machine, browser, pin, payload };
}

describe("the events of trust a pairing writes, through core", () => {
  it("writes device.paired once as the system, and the registry trusts the device once read back", async () => {
    const { store, browser, pin, payload } = await world();
    const first = await writePairedDevice(store, PRODUCT, payload);
    expect(first.written).toBe(true);
    expect(first.event.actor.kind).toBe("system");
    expect(first.event.type).toBe(DEVICE_TRUST_EVENT_TYPES.paired);
    const again = await writePairedDevice(store, PRODUCT, payload);
    expect(again.written).toBe(false);
    expect(again.event.id).toBe(first.event.id);
    expect(await pairedHeadIfTrusted(store, PRODUCT, pin, browser)).toMatch(/^sha256:/);
    const { view } = await readDeviceTrust(store, PRODUCT, pin);
    expect(view?.devices.some((device) => device.device === browser)).toBe(true);
  });

  it("a device nobody authorized is not read back as trusted", async () => {
    const { store, browser, machine, payload } = await world();
    const stranger = await generateEd25519();
    const strangerPin: RootPin = {
      device: deviceIdOf("machine", stranger.publicKey),
      public_key: toBase64url(stranger.publicKey),
    };
    await writePairedDevice(store, PRODUCT, payload);
    // The journal says the machine authorized it; a machine that pinned another root does not follow.
    expect(await pairedHeadIfTrusted(store, PRODUCT, strangerPin, browser)).toBeUndefined();
    expect(machine.device).not.toBe(strangerPin.device);
  });

  it("confirms the handover, or takes a provisional device back; each once", async () => {
    const { store, browser, machine, pin, payload } = await world();
    await writePairedDevice(store, PRODUCT, payload);
    const confirmed = await writeConfirmedDevice(store, PRODUCT, {
      device: browser,
      issued_at: NOW,
    });
    expect(confirmed.written).toBe(true);
    expect(
      (await writeConfirmedDevice(store, PRODUCT, { device: browser, issued_at: NOW })).written,
    ).toBe(false);
    const { view } = await readDeviceTrust(store, PRODUCT, pin);
    expect(view?.devices.find((device) => device.device === browser)?.provisional).toBe(false);

    const second = await world();
    await writePairedDevice(second.store, PRODUCT, second.payload);
    const revocation = await buildProvisionalRevocation({
      device: second.browser,
      bridge: second.machine.device,
      bridgeSecretKey: second.machine.secretKey,
      issuedAt: NOW,
    });
    expect((await writeProvisionalRevocation(second.store, PRODUCT, revocation)).written).toBe(
      true,
    );
    expect(
      await pairedHeadIfTrusted(second.store, PRODUCT, second.pin, second.browser),
    ).toBeUndefined();
    expect(machine.device).not.toBe(second.machine.device);
  });

  it("the journal itself refuses these events from an agent", async () => {
    const { store, payload } = await world();
    await expect(
      store.append({
        type: DEVICE_TRUST_EVENT_TYPES.paired,
        actor: { kind: "agent", agent: "sam" },
        product: PRODUCT,
        provenance: "trusted",
        payload,
      }),
    ).rejects.toMatchObject({ code: "EVENT_INVALID" });
  });
});
