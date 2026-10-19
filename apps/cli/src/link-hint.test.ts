import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "@agentplugged/i18n";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLinkedToWebApp, linkHint } from "./link-hint.js";

let data: string;
let product: string;
beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), "ap-bridge-"));
  product = join(data, "mon-produit");
  await mkdir(product, { recursive: true });
});
afterEach(async () => {
  await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const env = () => ({ AGENTPLUGGED_BRIDGE_HOME: join(data, "bridge") });

async function bridgeFiles(files: { binding?: boolean; products?: unknown[] }) {
  const dir = join(data, "bridge");
  await mkdir(dir, { recursive: true });
  if (files.binding === true) await writeFile(join(dir, "binding.json"), "{}");
  if (files.products !== undefined) {
    await writeFile(join(dir, "products.json"), JSON.stringify({ v: 1, products: files.products }));
  }
}

describe("the line that ends init", () => {
  it("names the command that links the product, in the creator's language", async () => {
    const french = await linkHint(createTranslator("fr"), product, env(), process.platform);
    expect(french).toContain("Pour le relier à ton application web : `npx agentplugged pair`");
    const english = await linkHint(createTranslator("en"), product, env(), process.platform);
    expect(english).toContain("To link it to your web app: `npx agentplugged pair`");
  });

  it("is there on a machine the bridge never linked", async () => {
    expect(await isLinkedToWebApp(product, env(), process.platform)).toBe(false);
  });

  it("is there when the machine is linked but does not serve this product yet", async () => {
    await bridgeFiles({ binding: true, products: [{ product: "X", path: join(data, "autre") }] });
    expect(await isLinkedToWebApp(product, env(), process.platform)).toBe(false);
  });

  it("is not there when the machine is linked and serves this product", async () => {
    await bridgeFiles({ binding: true, products: [{ product: "X", path: product }] });
    expect(await isLinkedToWebApp(product, env(), process.platform)).toBe(true);
    expect(
      await linkHint(createTranslator("en"), product, env(), process.platform),
    ).toBeUndefined();
  });

  it("is there when the registry exists but the machine has no link to an account", async () => {
    await bridgeFiles({ products: [{ product: "X", path: product }] });
    expect(await isLinkedToWebApp(product, env(), process.platform)).toBe(false);
  });

  it("is there when the registry cannot be read", async () => {
    await bridgeFiles({ binding: true });
    await writeFile(join(data, "bridge", "products.json"), "not json");
    expect(await isLinkedToWebApp(product, env(), process.platform)).toBe(false);
  });
});
