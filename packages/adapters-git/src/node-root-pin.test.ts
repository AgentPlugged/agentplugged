import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceIdOf, generateEd25519, toBase64url } from "@agentplugged/crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeRootPinStore } from "./node-root-pin.js";

const PRODUCT = "01K6KXJ5G0PR0DVCT00000000A";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentplugged-pin-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function pin() {
  const pair = await generateEd25519();
  return { device: deviceIdOf("human", pair.publicKey), public_key: toBase64url(pair.publicKey) };
}

describe("6.24 NodeRootPinStore: the pinned root, outside the repository", () => {
  it("reads no pin where none was written", async () => {
    expect(await new NodeRootPinStore({ dir }).read(PRODUCT)).toBeUndefined();
  });

  it("writes through a temporary file, reads it back and replaces it", async () => {
    const store = new NodeRootPinStore({ dir });
    const first = await pin();
    const second = await pin();
    await store.write(PRODUCT, first);
    expect(await store.read(PRODUCT)).toEqual(first);
    await store.write(PRODUCT, second);
    expect(await store.read(PRODUCT)).toEqual(second);
    expect(await readdir(join(dir, PRODUCT))).toEqual(["pin.json"]);
    if (process.platform !== "win32") {
      expect((await stat(join(dir, PRODUCT, "pin.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses a product id that is not a ULID, so no path can be built from it", async () => {
    const store = new NodeRootPinStore({ dir });
    for (const id of ["../x", "..", "a/b", "", "01k6kxj5g0pr0dvct00000000a"]) {
      await expect(store.write(id, await pin()), id).rejects.toThrow();
      expect(await store.read(id), id).toBeUndefined();
    }
  });

  it("flushes the file to the disk, then the folder's entry, before it returns", async () => {
    const flushed: string[] = [];
    const store = new NodeRootPinStore({ dir, onFlush: (what) => flushed.push(what) });
    await store.write(PRODUCT, await pin());
    expect(flushed).toEqual(["file", "folder"]);
  });

  it("fails, instead of reading no pin, when the file is there and is not a valid pin", async () => {
    const store = new NodeRootPinStore({ dir });
    const good = await pin();
    await store.write(PRODUCT, good);
    const file = join(dir, PRODUCT, "pin.json");
    for (const text of [
      "not json",
      "{}",
      JSON.stringify({ ...good, device: "human:AAAAAAAAAAAAAAAA" }),
      JSON.stringify({ ...good, device: good.device.replace("human", "phone") }),
      JSON.stringify({ ...good, extra: 1 }),
    ]) {
      await writeFile(file, text);
      await expect(store.read(PRODUCT), text).rejects.toMatchObject({ code: "UNEXPECTED" });
    }
  });
});
