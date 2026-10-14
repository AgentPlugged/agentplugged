import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { GitStateStore, NodeKeyStore } from "@agentplugged/adapters-git";
import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import {
  type HumanKey,
  humanDevice,
  loadHumanKey,
  localeSigner,
  MemoryRootPinStore,
  prepareHumanEvents,
} from "@agentplugged/core";
import { generateEd25519, toBase64url } from "@agentplugged/crypto";
import { HUMAN_EVENT_TYPES } from "@agentplugged/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.js";

// Real repositories and the system keychain: slower than 5 s.
vi.setConfig({ testTimeout: 120_000 });

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
/** A keychain service of this file only, deleted after each test: never the real entries. */
const service = `agentplugged-test-trust-${process.pid}-${Date.now()}`;

let cwd: string;
let home: string;
let env: Record<string, string>;
let pins: MemoryRootPinStore;

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function keychainAvailable(): Promise<boolean> {
  try {
    await new NodeKeyStore({ service }).readHumanSecret();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/platform secure storage|no storage access|secret service|dbus|keyutils/i.test(message)) {
      return false;
    }
    throw error;
  }
}

beforeEach(async (context) => {
  if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-trust-"));
  home = await mkdtemp(join(tmpdir(), "agentplugged-trust-home-"));
  await writeFile(join(home, ".gitconfig"), "");
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(home|userprofile)$/i.test(key)) inherited[key] = value;
  }
  env = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    AGENTPLUGGED_LANG: "en",
    npm_config_registry: "http://127.0.0.1:9/",
    AGENTPLUGGED_KEYCHAIN_SERVICE: service,
    AGENTPLUGGED_PRESENCE: "none",
    AGENTPLUGGED_ENVIRONMENT: "none",
    GIT_CEILING_DIRECTORIES: await realpath(tmpdir()),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Ada"]);
  git(["config", "user.email", "ada@example.com"]);
  pins = new MemoryRootPinStore();
});

afterEach(async () => {
  await removeTestKeys(service);
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function cli(
  args: string[],
  options: { answers?: string[]; interactive?: boolean; lang?: string } = {},
) {
  let stdout = "";
  let stderr = "";
  const answers = options.answers ?? [];
  const status = await main({
    argv: args,
    cwd,
    env: { ...env, PATH: process.env.PATH ?? "", AGENTPLUGGED_LANG: options.lang ?? "en" },
    engineVersion: VERSION,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: Readable.from(answers.length === 0 ? [] : [answers.map((a) => `${a}\n`).join("")]),
    interactive: options.interactive ?? true,
    rootPins: pins,
  });
  return { status, stdout, stderr };
}

function journal() {
  return new GitStateStore({
    cwd,
    keys: new NodeKeyStore({ service }),
    machineLockPath: join(home, ".agentplugged", "machine-key.lock"),
  });
}

/** `init`, then this machine's root pinned and a creator key registered with the id zero. */
async function forgedProduct() {
  const init = await cli(["init", "--profile", "new-product"], { interactive: false });
  expect(init.status, init.stderr).toBe(0);
  const keys = new NodeKeyStore({ service });
  const ada = (await loadHumanKey(keys, { create: false })) as HumanKey;
  const store = journal();
  try {
    const product = (await store.productId()) as string;
    pins.pins.set(product, { device: ada.device, public_key: toBase64url(ada.publicKey) });
    const pair = await generateEd25519({ seed: new Uint8Array(32).fill(66) });
    const forger: HumanKey = {
      publicKey: pair.publicKey,
      secretKey: pair.secretKey,
      device: humanDevice(pair.publicKey),
      created: false,
    };
    const events = await prepareHumanEvents({
      key: forger,
      drafts: [
        {
          type: HUMAN_EVENT_TYPES.keyRegistered,
          payload: { public_key: toBase64url(pair.publicKey) },
          signer: localeSigner(forger),
        },
      ],
      deviceHead: null,
      product,
      newId: () => "00000000000000000000000000",
      now: () => Date.now(),
    });
    await store.appendHuman(events);
    return { product, forger, id: events[0]?.id as string, ada };
  } finally {
    store.close();
  }
}

async function blocked(): Promise<boolean> {
  const check = await cli(["trust", "dismiss"], { answers: ["n"] });
  return check.stdout.includes("no order is given");
}

describe("6.24 trust dismiss at the terminal", () => {
  it("refuses a script, and what is not dismiss, before anything", async () => {
    const noTerminal = await cli(["trust", "dismiss"], { interactive: false });
    expect(noTerminal.status).toBe(1);
    expect(noTerminal.stderr).toContain("needs an interactive terminal");
    for (const args of [["trust"], ["trust", "forgive"], ["trust", "dismiss", "now"]]) {
      const bad = await cli(args);
      expect(bad.status, args.join(" ")).toBe(1);
      expect(bad.stderr).toContain("trust dismiss");
    }
  });

  it("has nothing to do without a pinned root, or when the journal agrees", async () => {
    const init = await cli(["init", "--profile", "new-product"], { interactive: false });
    expect(init.status, init.stderr).toBe(0);
    const unpinned = await cli(["trust", "dismiss"]);
    expect(unpinned.status).toBe(0);
    expect(unpinned.stdout).toContain("has not pinned a root of trust");
    const store = journal();
    const keys = new NodeKeyStore({ service });
    const ada = (await loadHumanKey(keys, { create: false })) as HumanKey;
    try {
      pins.pins.set((await store.productId()) as string, {
        device: ada.device,
        public_key: toBase64url(ada.publicKey),
      });
    } finally {
      store.close();
    }
    const agrees = await cli(["trust", "dismiss"]);
    expect(agrees.status).toBe(0);
    expect(agrees.stdout).toContain("the journal agrees with the root of trust");
  });

  it("names the event, keeps it when the answer is not yes, dismisses it when it is", async () => {
    const forged = await forgedProduct();
    const kept = await cli(["trust", "dismiss"], { answers: [""] });
    expect(kept.status).toBe(0);
    expect(kept.stdout).toContain(forged.forger.device);
    expect(kept.stdout).toContain(forged.id);
    expect(kept.stdout).toContain("Dismiss this event? (y/N)");
    expect(kept.stdout).toContain("no order is given for this product");
    expect(await blocked()).toBe(true);

    const done = await cli(["trust", "dismiss"], { answers: ["y"] });
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain("Orders are allowed again for this product.");
    expect(await blocked()).toBe(false);
    const again = await cli(["trust", "dismiss"]);
    expect(again.stdout).toContain("the journal agrees with the root of trust");
  });

  it("asks in French, with « o/N »", async () => {
    await forgedProduct();
    const kept = await cli(["trust", "dismiss"], { answers: ["n"], lang: "fr" });
    expect(kept.stdout).toContain("Écarter cet événement ? (o/N)");
    const done = await cli(["trust", "dismiss"], { answers: ["o"], lang: "fr" });
    expect(done.stdout).toContain("Écarté.");
  });

  it("is listed in the usage", async () => {
    const help = await cli(["--help"]);
    expect(help.stdout).toContain("trust dismiss");
  });
});
