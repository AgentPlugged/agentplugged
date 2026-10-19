import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "@agentplugged/i18n";
import { afterEach, describe, expect, it } from "vitest";
import {
  BRIDGE_PACKAGE,
  BRIDGE_POINTER_FILE,
  bridgeInstallDir,
  findBridge,
  installBridgePackage,
  type LauncherEnvironment,
  runBridgeLauncher,
} from "./bridge-launcher.js";

const fr = createTranslator("fr");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A home of its own and a fake npm that puts the package where npm would put it. */
function setup(npm: "works" | "fails" | "no-program" = "works") {
  const root = mkdtempSync(join(tmpdir(), "ap-bridge-install-"));
  roots.push(root);
  const env = {
    USERPROFILE: root,
    HOME: root,
    LOCALAPPDATA: join(root, "AppData", "Local"),
    XDG_DATA_HOME: join(root, ".local", "share"),
  };
  const dir = bridgeInstallDir(env) ?? "";
  const npmCalls: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const environment: LauncherEnvironment = {
    argv: ["bridge", "install"],
    env,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    runNpm: async (args) => {
      npmCalls.push([...args]);
      if (npm === "fails") return { code: 1, output: "npm ERR! 404 Not Found\nmore" };
      const prefix = args[args.indexOf("--prefix") + 1] ?? "";
      writeFileSync(
        join(prefix, "package.json"),
        JSON.stringify({ private: true, dependencies: { [BRIDGE_PACKAGE]: "^1.0.0" } }),
      );
      if (npm === "works") {
        const program = join(prefix, "node_modules", BRIDGE_PACKAGE, "dist");
        mkdirSync(program, { recursive: true });
        writeFileSync(join(program, "bin.js"), "// fake bridge\n");
      }
      return { code: 0, output: "" };
    },
  };
  return { root, env, dir, environment, npmCalls, out, err };
}

describe("`agentplugged bridge install` gets the bridge as its own package", () => {
  it("installs it in a folder of its own, points to its program, and says what it does", async () => {
    const s = setup();
    expect(await installBridgePackage(s.environment, fr)).toBe(true);
    expect(s.npmCalls).toHaveLength(1);
    expect(s.npmCalls[0]?.slice(0, 2)).toEqual(["install", "--prefix"]);
    expect(s.npmCalls[0]).toContain("--omit=dev");
    expect(s.npmCalls[0]?.at(-1)).toBe(`${BRIDGE_PACKAGE}@latest`);
    const found = await findBridge(s.env);
    expect(found).toBe(join(s.dir, "package", "node_modules", BRIDGE_PACKAGE, "dist", "bin.js"));
    expect(JSON.parse(readFileSync(join(s.dir, BRIDGE_POINTER_FILE), "utf8")).entry).toBe(found);
    expect(s.out.join("")).toContain("Récupération du pont");
  });

  it("running it again updates the same folder: still one package, one pointer", async () => {
    const s = setup();
    await installBridgePackage(s.environment, fr);
    const first = await findBridge(s.env);
    await installBridgePackage(s.environment, fr);
    expect(await findBridge(s.env)).toBe(first);
    expect(s.npmCalls).toHaveLength(2);
  });

  it("when the download fails and a bridge is already there, keeps it and says so", async () => {
    const works = setup();
    await installBridgePackage(works.environment, fr);
    const failing = {
      ...works.environment,
      runNpm: async () => ({ code: 1, output: "network down" }),
    };
    expect(await installBridgePackage(failing, fr)).toBe(true);
    expect(works.err.join("")).toContain("celui qui est installé est gardé");
    expect(await findBridge(works.env)).toBeDefined();
  });

  it("when the download fails and nothing is installed, says nothing was installed", async () => {
    const s = setup("fails");
    expect(await installBridgePackage(s.environment, fr)).toBe(false);
    expect(s.err.join("")).toContain("Rien n'a été installé");
    expect(s.err.join("")).toContain("404");
    expect(await findBridge(s.env)).toBeUndefined();
  });

  it("a package without its program is not taken for an installation", async () => {
    const s = setup("no-program");
    expect(await installBridgePackage(s.environment, fr)).toBe(false);
    expect(await findBridge(s.env)).toBeUndefined();
  });

  it("a bridge kept elsewhere (AGENTPLUGGED_BRIDGE_ENTRY) is never fetched over", async () => {
    const s = setup();
    const entry = join(s.root, "dev-bridge.js");
    writeFileSync(entry, "// dev\n");
    const environment = { ...s.environment, env: { ...s.env, AGENTPLUGGED_BRIDGE_ENTRY: entry } };
    expect(await installBridgePackage(environment, fr)).toBe(true);
    expect(s.npmCalls).toEqual([]);
  });

  it("a package source with a shell metacharacter is refused before npm is run", async () => {
    const s = setup();
    const environment = {
      ...s.environment,
      env: { ...s.env, AGENTPLUGGED_BRIDGE_PACKAGE: "x & calc" },
    };
    expect(await installBridgePackage(environment, fr)).toBe(false);
    expect(s.npmCalls).toEqual([]);
  });

  it("the launcher fetches the bridge first, then runs it with `install`", async () => {
    const s = setup();
    const args: string[] = [];
    const environment: LauncherEnvironment = {
      ...s.environment,
      runNpm: async (npmArgs) => {
        const done = await s.environment.runNpm?.(npmArgs);
        const prefix = npmArgs[npmArgs.indexOf("--prefix") + 1] ?? "";
        writeFileSync(
          join(prefix, "node_modules", BRIDGE_PACKAGE, "dist", "bin.js"),
          "process.stdout.write(process.argv.slice(2).join(' '));\n",
        );
        args.push("npm");
        return done ?? { code: 1, output: "" };
      },
    };
    const code = await runBridgeLauncher(environment, fr);
    expect(code).toBe(0);
    expect(args).toEqual(["npm"]);
    expect(s.err.join("")).toBe("");
    expect(s.out.join("")).toContain("install");
  });

  it("`bridge start` never fetches anything", async () => {
    const s = setup();
    const code = await runBridgeLauncher({ ...s.environment, argv: ["bridge", "start"] }, fr);
    expect(code).toBe(1);
    expect(s.npmCalls).toEqual([]);
    expect(s.err.join("")).toContain("agentplugged bridge install");
  });
});
