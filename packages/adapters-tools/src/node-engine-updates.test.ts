import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  engineDir,
  engineEntry,
  isInstalledEngine,
  isReleaseVersion,
  packageDir,
} from "./engine-store.js";
import { cleanSummary, NodeEngineUpdates, registryOf, releaseOf } from "./node-engine-updates.js";

vi.setConfig({ testTimeout: 120_000 });

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentplugged-engine-updates-"));
  home = join(root, "home");
  mkdirSync(home);
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

describe("the versions' folders", () => {
  it("names a folder per release version, and nothing else", () => {
    expect(isReleaseVersion("0.2.0")).toBe(true);
    for (const bad of ["0.2", "latest", "1.2.3-beta.1", "../1.2.3", "1.2.3/..", "01.2.3", "", 3]) {
      expect(isReleaseVersion(bad), String(bad)).toBe(false);
    }
    expect(engineDir("0.2.0", home)).toBe(join(home, ".agentplugged", "engines", "0.2.0"));
    expect(() => engineDir("../x", home)).toThrow();
  });

  it("knows a version is installed only when the package of exactly that version is whole there", () => {
    const folder = engineDir("0.2.0", home);
    expect(isInstalledEngine(folder, "0.2.0")).toBe(false);
    mkdirSync(join(packageDir(folder), "dist"), { recursive: true });
    writeFileSync(
      join(packageDir(folder), "package.json"),
      JSON.stringify({ name: "agentplugged", version: "0.2.0" }),
    );
    expect(isInstalledEngine(folder, "0.2.0")).toBe(false);
    writeFileSync(engineEntry(folder), "");
    expect(isInstalledEngine(folder, "0.2.0")).toBe(true);
    expect(isInstalledEngine(folder, "0.3.0")).toBe(false);
    writeFileSync(
      join(packageDir(folder), "package.json"),
      JSON.stringify({ name: "another", version: "0.2.0" }),
    );
    expect(isInstalledEngine(folder, "0.2.0")).toBe(false);
  });
});

describe("the registry's reply", () => {
  it("is the registry npm is configured with, over https (http only to this machine)", () => {
    expect(registryOf({})).toBe("https://registry.npmjs.org");
    expect(registryOf({ npm_config_registry: "https://registry.example.com/npm/" })).toBe(
      "https://registry.example.com/npm",
    );
    expect(registryOf({ NPM_CONFIG_REGISTRY: "http://127.0.0.1:4873/" })).toBe(
      "http://127.0.0.1:4873",
    );
    expect(registryOf({ npm_config_registry: "http://localhost:4873" })).toBe(
      "http://localhost:4873",
    );
    for (const refused of [
      "http://registry.example.com/",
      "ftp://registry.example.com/",
      "https://user:pass@registry.example.com/",
      "not a url",
      "file:///etc/passwd",
      "",
    ]) {
      expect(registryOf({ npm_config_registry: refused }), refused).toBe(
        "https://registry.npmjs.org",
      );
    }
  });

  it("shows a summary as one clean short line, never as an instruction", () => {
    expect(cleanSummary("Faster\nmerges\t\u0000now")).toBe("Faster merges now");
    // Invisible characters (zero-width, bidi marks, language tags) never reach the agent's context.
    expect(cleanSummary("Fast\u200ber\u202e merges\u{e0041}\u{e0042}")).toBe("Fast er merges");
    expect(cleanSummary("   ")).toBeUndefined();
    expect(cleanSummary(42)).toBeUndefined();
    const long = cleanSummary("x".repeat(500)) as string;
    expect([...long].length).toBe(200);
    expect(long.endsWith("…")).toBe(true);
  });

  it("is a release of the package agentplugged, never a pre-release or another package", () => {
    expect(releaseOf({ name: "agentplugged", version: "0.2.0", releaseSummary: "Hi." })).toEqual({
      version: "0.2.0",
      summary: "Hi.",
    });
    expect(releaseOf({ name: "agentplugged", version: "0.2.0" })).toEqual({ version: "0.2.0" });
    for (const reply of [
      { name: "evil", version: "0.2.0" },
      { name: "agentplugged", version: "0.2.0-beta.1" },
      { name: "agentplugged", version: "latest" },
      { name: "agentplugged", version: "../0.2.0" },
      { name: "agentplugged" },
      [],
      null,
      "agentplugged",
    ]) {
      expect(releaseOf(reply), JSON.stringify(reply)).toBeUndefined();
    }
  });
});

/** A registry that answers with what the test says, counting its requests. */
function fakeFetch(answer: () => Response | Promise<Response>) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return await answer();
  }) as typeof fetch;
  return { fn, requests };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function updates(options: Partial<ConstructorParameters<typeof NodeEngineUpdates>[0]> = {}) {
  let now = NOW;
  const instance = new NodeEngineUpdates({
    engineVersion: "0.1.0",
    cwd: root,
    env: {},
    home,
    now: () => now,
    ...options,
  });
  return {
    instance,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("the check of the registry (at most twice a day)", () => {
  it("asks once for the latest version, with nothing of the project, and keeps the answer", async () => {
    const registry = fakeFetch(() =>
      json({ name: "agentplugged", version: "0.2.0", releaseSummary: "Updates itself." }),
    );
    const { instance } = updates({
      fetch: registry.fn,
      env: { npm_config_registry: "http://127.0.0.1:1/" },
    });
    // Never waits for the network: the first call has nothing yet and starts the request.
    expect(await instance.latest()).toBeUndefined();
    await instance.refresh();
    expect(registry.requests).toHaveLength(1);
    expect(registry.requests[0]?.url).toBe("http://127.0.0.1:1/agentplugged/latest");
    const init = registry.requests[0]?.init;
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(init?.body).toBeUndefined();
    expect(init?.method).toBeUndefined();
    expect(await instance.latest()).toEqual({ version: "0.2.0", summary: "Updates itself." });
    const kept = JSON.parse(readFileSync(join(home, ".agentplugged", "update-check.json"), "utf8"));
    expect(kept.latest).toEqual({ version: "0.2.0", summary: "Updates itself." });
    expect(kept.checked_at).toBe(new Date(NOW).toISOString());
  });

  it("does not ask again before half a day, then asks again", async () => {
    const registry = fakeFetch(() => json({ name: "agentplugged", version: "0.2.0" }));
    const { instance, advance } = updates({ fetch: registry.fn });
    await instance.refresh();
    advance(11 * 3_600_000);
    await instance.latest();
    await instance.refresh();
    expect(registry.requests).toHaveLength(1);
    advance(2 * 3_600_000);
    await instance.refresh();
    expect(registry.requests).toHaveLength(2);
  });

  it("does not ask at all when the check is off, and shows nothing", async () => {
    const registry = fakeFetch(() => json({ name: "agentplugged", version: "0.2.0" }));
    const { instance } = updates({ fetch: registry.fn });
    await instance.refresh();
    await instance.saveSettings({ check: false });
    expect(await instance.latest()).toBeUndefined();
    const second = updates({ fetch: registry.fn, home });
    await second.instance.refresh({ force: true });
    expect(registry.requests).toHaveLength(1);
  });

  it("is silence when the registry is unreachable, the package unknown or the reply wrong", async () => {
    const replies: Array<() => Response | Promise<Response>> = [
      () => Promise.reject(new TypeError("fetch failed")),
      () => json({ error: "Not found" }, 404),
      () => new Response("<html>", { status: 200 }),
      () => json({ name: "other", version: "9.9.9" }),
      () => json({ name: "agentplugged", version: "latest" }),
      () => new Response("x".repeat(300_000), { status: 200 }),
      () => json({ name: "agentplugged", version: "0.2.0" }, 500),
    ];
    for (const reply of replies) {
      const registry = fakeFetch(reply);
      const dir = mkdtempSync(join(root, "h-"));
      const { instance } = updates({ fetch: registry.fn, home: dir });
      await expect(instance.refresh()).resolves.toBeUndefined();
      expect(await instance.latest()).toBeUndefined();
      // The attempt counts: not asked again before half a day.
      await instance.refresh();
      expect(registry.requests).toHaveLength(1);
    }
  });

  it("keeps the last good answer when the next request fails", async () => {
    let good = true;
    const registry = fakeFetch(() =>
      good ? json({ name: "agentplugged", version: "0.2.0" }) : json({}, 404),
    );
    const { instance, advance } = updates({ fetch: registry.fn });
    await instance.refresh();
    good = false;
    advance(13 * 3_600_000);
    await instance.refresh();
    expect(registry.requests).toHaveLength(2);
    expect(await instance.latest()).toEqual({ version: "0.2.0" });
  });

  it("asks again at once when the creator asks (force)", async () => {
    const registry = fakeFetch(() => json({ name: "agentplugged", version: "0.2.0" }));
    const { instance } = updates({ fetch: registry.fn });
    await instance.refresh();
    await instance.refresh({ force: true });
    expect(registry.requests).toHaveLength(2);
  });

  it("tells the listener after each check, whether the registry was asked or not", async () => {
    const registry = fakeFetch(() => json({ name: "agentplugged", version: "0.2.0" }));
    const onChecked = vi.fn();
    const { instance } = updates({ fetch: registry.fn, onChecked });
    await instance.refresh();
    await instance.refresh();
    expect(onChecked).toHaveBeenCalledTimes(2);
    expect(registry.requests).toHaveLength(1);
  });
});

describe("the two settings of the machine", () => {
  it("check on, auto off, by default", async () => {
    const { instance } = updates();
    expect(await instance.settings()).toEqual({ check: true, auto: false });
  });

  it("are kept in settings.json, one at a time, and read again", async () => {
    const { instance } = updates();
    expect(await instance.saveSettings({ auto: true })).toEqual({ check: true, auto: true });
    expect(await instance.saveSettings({ check: false })).toEqual({ check: false, auto: true });
    expect(await updates().instance.settings()).toEqual({ check: false, auto: true });
    const file = JSON.parse(readFileSync(join(home, ".agentplugged", "settings.json"), "utf8"));
    expect(file).toEqual({ updates: { check: false, auto: true } });
  });

  it("fall back on the defaults when the file is not what it should be", async () => {
    mkdirSync(join(home, ".agentplugged"));
    writeFileSync(
      join(home, ".agentplugged", "settings.json"),
      '{"updates":{"check":"no","auto":1}}',
    );
    expect(await updates().instance.settings()).toEqual({ check: true, auto: false });
    writeFileSync(join(home, ".agentplugged", "settings.json"), "not json");
    expect(await updates().instance.settings()).toEqual({ check: true, auto: false });
  });

  it("keeps the automatic update's note beside the registry's answer", async () => {
    const registry = fakeFetch(() => json({ name: "agentplugged", version: "0.2.0" }));
    const { instance } = updates({ fetch: registry.fn });
    await instance.refresh();
    const note = { from: "0.1.0", to: "0.2.0", at: new Date(NOW).toISOString() };
    await instance.noteAutoUpdate(note);
    expect(await instance.lastAutoUpdate()).toEqual(note);
    expect(await instance.latest()).toEqual({ version: "0.2.0" });
  });
});

/** `agentplugged` of a version, packed as the registry serves it: a small package with a script. */
function packPackage(version: string, options: { bin?: string; manifestVersion?: string } = {}) {
  const source = mkdtempSync(join(root, "pkg-"));
  mkdirSync(join(source, "dist"));
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "agentplugged",
      version: options.manifestVersion ?? version,
      bin: { agentplugged: "dist/bin.js" },
      files: ["dist"],
    }),
  );
  writeFileSync(
    join(source, "dist", "bin.js"),
    options.bin ??
      `import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
if (process.env.FAKE_FAIL === process.argv[2]) { console.error("boom: " + process.argv[2]); process.exit(3); }
`,
  );
  const out = mkdtempSync(join(root, "tgz-"));
  const packed = spawnSync(
    process.execPath,
    [
      join(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js"),
      "pack",
      "--pack-destination",
      out,
      "--silent",
    ],
    { cwd: source, encoding: "utf8" },
  );
  if (packed.status !== 0) {
    // A Node.js without its bundled npm: npm from the PATH.
    const viaPath = spawnSync("npm", ["pack", "--pack-destination", out, "--silent"], {
      cwd: source,
      encoding: "utf8",
      shell: true,
    });
    if (viaPath.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}${viaPath.stderr}`);
  }
  const file = readdirSync(out)[0] as string;
  return readFileSync(join(out, file));
}

/** A registry on this machine serving `agentplugged` at the versions given, and counting requests. */
async function localRegistry(versions: Record<string, Buffer>) {
  const hits: string[] = [];
  let origin = "";
  const server: Server = createServer((request, response) => {
    hits.push(request.url ?? "");
    const url = request.url ?? "";
    if (url === "/agentplugged") {
      const entries = Object.fromEntries(
        Object.keys(versions).map((version) => [
          version,
          {
            name: "agentplugged",
            version,
            dist: {
              tarball: `${origin}/agentplugged/-/agentplugged-${version}.tgz`,
            },
          },
        ]),
      );
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name: "agentplugged", "dist-tags": {}, versions: entries }));
      return;
    }
    const match = /^\/agentplugged\/-\/agentplugged-(.+)\.tgz$/.exec(url);
    const body = match === null ? undefined : versions[match[1] as string];
    if (body === undefined) {
      response.statusCode = 404;
      response.end("{}");
      return;
    }
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("installing a version in its own folder (a registry on this machine)", () => {
  it("installs exactly that version of the package, scripts off, and leaves nothing else behind", async () => {
    const registry = await localRegistry({ "1.2.3": packPackage("1.2.3") });
    try {
      const { instance } = updates({
        env: { ...process.env, npm_config_registry: registry.origin },
      });
      expect(await instance.isInstalled("1.2.3")).toBe(false);
      expect(await instance.install("1.2.3")).toEqual({ ok: true });
      expect(await instance.isInstalled("1.2.3")).toBe(true);
      const folder = engineDir("1.2.3", home);
      expect(existsSync(engineEntry(folder))).toBe(true);
      expect(readdirSync(join(home, ".agentplugged", "engines"))).toEqual(["1.2.3"]);
      // Already there, whole: nothing is asked of the registry again.
      const before = registry.hits.length;
      expect(await instance.install("1.2.3")).toEqual({ ok: true });
      expect(registry.hits).toHaveLength(before);
    } finally {
      await registry.close();
    }
  });

  it("refuses what is not a release version, without running anything", async () => {
    const { instance } = updates();
    for (const bad of ["latest", "1.2", "../evil", "1.2.3-beta.1", "1.2.3 && echo"]) {
      expect(await instance.install(bad), bad).toEqual({ ok: false, reason: "bad_version" });
      expect(await instance.upgradeProduct(bad), bad).toEqual({
        ok: false,
        reason: "bad_version",
      });
    }
    expect(existsSync(join(home, ".agentplugged", "engines"))).toBe(false);
  });

  it("fails cleanly when the registry has no such version", async () => {
    const registry = await localRegistry({ "1.2.3": packPackage("1.2.3") });
    try {
      const { instance } = updates({
        env: { ...process.env, npm_config_registry: registry.origin },
      });
      const result = await instance.install("9.9.9");
      expect(result).toMatchObject({ ok: false, reason: "install_failed" });
      expect(existsSync(engineDir("9.9.9", home))).toBe(false);
      // No half-made folder is left.
      const left = existsSync(join(home, ".agentplugged", "engines"))
        ? readdirSync(join(home, ".agentplugged", "engines"))
        : [];
      expect(left).toEqual([]);
    } finally {
      await registry.close();
    }
  });

  it("refuses a package that is not the version asked for, and leaves nothing", async () => {
    const registry = await localRegistry({
      "1.2.3": packPackage("1.2.3", { manifestVersion: "6.6.6" }),
    });
    try {
      const { instance } = updates({
        env: { ...process.env, npm_config_registry: registry.origin },
      });
      const result = await instance.install("1.2.3");
      expect(result).toMatchObject({ ok: false });
      expect(await instance.isInstalled("1.2.3")).toBe(false);
      expect(existsSync(engineDir("1.2.3", home))).toBe(false);
    } finally {
      await registry.close();
    }
  });

  it("brings the product to the version with that version's own engine: init then sync, in the product", async () => {
    const registry = await localRegistry({ "1.2.3": packPackage("1.2.3") });
    const log = join(root, "fake.log");
    const product = join(root, "product");
    mkdirSync(product);
    try {
      const env = { ...process.env, npm_config_registry: registry.origin, FAKE_LOG: log };
      const { instance } = updates({ env, cwd: product });
      expect(await instance.upgradeProduct("1.2.3")).toEqual({
        ok: false,
        reason: "not_installed",
      });
      expect(await instance.install("1.2.3")).toEqual({ ok: true });
      expect(await instance.upgradeProduct("1.2.3")).toEqual({ ok: true });
      const runs = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
      expect(runs.map((run) => run.args)).toEqual([["init", "--upgrade-engine"], ["sync"]]);
      expect(runs.every((run) => run.cwd.toLowerCase() === product.toLowerCase())).toBe(true);
    } finally {
      await registry.close();
    }
  });

  it("says why the product could not be brought to the version, and stops there", async () => {
    const registry = await localRegistry({ "1.2.3": packPackage("1.2.3") });
    const log = join(root, "fake.log");
    try {
      const env = {
        ...process.env,
        npm_config_registry: registry.origin,
        FAKE_LOG: log,
        FAKE_FAIL: "init",
      };
      const { instance } = updates({ env, cwd: root });
      await instance.install("1.2.3");
      const result = await instance.upgradeProduct("1.2.3");
      expect(result).toMatchObject({ ok: false, reason: "product_update_failed" });
      expect((result as { message: string }).message).toContain("boom: init");
      // `sync` did not run after the failure.
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      await registry.close();
    }
  });
});
