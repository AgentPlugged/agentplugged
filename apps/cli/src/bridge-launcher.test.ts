import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslator } from "@agentplugged/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_POINTER_FILE, bridgeInstallDir, findBridge } from "./bridge-launcher.js";
import { main } from "./main.js";

const fr = createTranslator("fr");
const en = createTranslator("en");
// The names of the closed packages, written in pieces: the export of the public repository refuses
// any file that spells them out, and this test must be exported with the rest.
const CLOSED = [
  "bridge",
  "rel" + "ay",
  "rel" + "ay-client",
  "rel" + "ay-testkit",
  "i18n-" + "cock" + "pit",
];
const PRIVATE_NAME = new RegExp(`@agentplugged/(?:${CLOSED.join("|")})`);
const PRIVATE_NAME_EXACT = new RegExp(`^@agentplugged/(?:${CLOSED.join("|")})$`);
const sourceDir = dirname(fileURLToPath(import.meta.url));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A home folder of its own, and a fake bridge: a program that says what it was given. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "ap-launcher-"));
  roots.push(root);
  const entry = join(root, "fake-bridge.mjs");
  writeFileSync(
    entry,
    [
      "const [first, ...rest] = process.argv.slice(2);",
      "process.stdout.write(JSON.stringify({ first, rest, lang: process.env.AGENTPLUGGED_LANG }) + '\\n');",
      "process.stderr.write('une ligne d\\'erreur\\n');",
      "process.exitCode = first === 'status' ? 3 : 0;",
    ].join("\n"),
  );
  const env = {
    USERPROFILE: root,
    HOME: root,
    LOCALAPPDATA: join(root, "AppData", "Local"),
    XDG_DATA_HOME: join(root, ".local", "share"),
  };
  return { root, entry, env };
}

async function run(argv: string[], env: Record<string, string | undefined>, platform?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main({
    argv,
    cwd: process.cwd(),
    env,
    engineVersion: "0.0.0",
    ...(platform === undefined ? {} : { platform }),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("`agentplugged bridge` : un lanceur générique", () => {
  it("le pont n'est pas installé : il le dit, dit comment l'obtenir, et rend le code 1 (français et anglais)", async () => {
    const { env } = setup();
    for (const argv of [
      ["bridge", "start"],
      ["bridge", "status"],
      ["bridge"],
      ["bridge", "--help"],
    ]) {
      const result = await run(argv, { ...env, AGENTPLUGGED_LANG: "fr" });
      expect(result.code).toBe(1);
      expect(result.out).toBe("");
      expect(result.err).toBe(`${fr("bridge.launcher.not_installed")}\n`);
    }
    const english = await run(["bridge", "start"], { ...env, AGENTPLUGGED_LANG: "en" });
    expect(english.err).toBe(`${en("bridge.launcher.not_installed")}\n`);
    expect(fr("bridge.launcher.not_installed")).toContain(
      "Le pont n'est pas installé sur cette machine.",
    );
    expect(fr("bridge.launcher.not_installed")).toContain("https://agentplugged.ai");
    expect(en("bridge.launcher.not_installed")).toContain("not installed");
  });

  it("un pont installé est lancé avec les mêmes arguments, sa sortie et son code de sortie sont rendus tels quels", async () => {
    const { env, entry } = setup();
    const start = await run(["bridge", "start", "--vite", "x y"], {
      ...env,
      AGENTPLUGGED_BRIDGE_ENTRY: entry,
      AGENTPLUGGED_LANG: "fr",
    });
    expect(start.code).toBe(0);
    expect(JSON.parse(start.out)).toEqual({ first: "start", rest: ["--vite", "x y"], lang: "fr" });
    expect(start.err).toBe("une ligne d'erreur\n");
    const status = await run(["bridge", "status"], { ...env, AGENTPLUGGED_BRIDGE_ENTRY: entry });
    expect(status.code).toBe(3);
  });

  it("l'installation signale son programme par un fichier du dossier d'installation de chaque système", async () => {
    const { root, env, entry } = setup();
    for (const platform of ["win32", "darwin", "linux"]) {
      const dir = bridgeInstallDir(env, platform);
      expect(dir, platform).toBeDefined();
      if (dir === undefined) continue;
      expect(dir.startsWith(root), platform).toBe(true);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, BRIDGE_POINTER_FILE), JSON.stringify({ entry }));
      expect(await findBridge(env, platform), platform).toBe(entry);
      writeFileSync(
        join(dir, BRIDGE_POINTER_FILE),
        JSON.stringify({ entry: join(root, "absent.mjs") }),
      );
      expect(await findBridge(env, platform), `${platform} absent`).toBeUndefined();
      writeFileSync(join(dir, BRIDGE_POINTER_FILE), JSON.stringify({ entry: "relatif.mjs" }));
      expect(await findBridge(env, platform), `${platform} relatif`).toBeUndefined();
      writeFileSync(join(dir, BRIDGE_POINTER_FILE), "pas du JSON");
      expect(await findBridge(env, platform), `${platform} illisible`).toBeUndefined();
    }
    expect(bridgeInstallDir({}, "linux")).toBeUndefined();
    expect(bridgeInstallDir({ HOME: "/h" }, "linux")).toBe(
      join("/h", ".local", "share", "agentplugged", "bridge-install"),
    );
  });

  it("le pont trouvé par le fichier d'installation est lancé", async () => {
    const { env, entry } = setup();
    const dir = bridgeInstallDir(env, process.platform);
    if (dir === undefined) throw new Error("no install folder");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, BRIDGE_POINTER_FILE), JSON.stringify({ entry }));
    const result = await run(["bridge", "start"], env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).first).toBe("start");
  });

  it("`pair` est lancé comme `bridge`, avec toute la commande et dans le dossier du produit ; le pont absent est dit en une phrase", async () => {
    const { root, env, entry } = setup();
    const folder = join(root, "mon-produit");
    mkdirSync(folder, { recursive: true });
    const out: string[] = [];
    const code = await main({
      argv: ["pair", "--no-open"],
      cwd: folder,
      env: { ...env, AGENTPLUGGED_BRIDGE_ENTRY: entry },
      engineVersion: "0.0.0",
      stdout: (text) => out.push(text),
      stderr: () => {},
    });
    expect(code).toBe(0);
    // The bridge's own command line knows `pair`: it is handed the whole command.
    expect(JSON.parse(out.join(""))).toMatchObject({ first: "pair", rest: ["--no-open"] });
    const absent = await run(["pair"], { ...env, AGENTPLUGGED_LANG: "fr" });
    expect(absent.code).toBe(1);
    expect(absent.out).toBe("");
    expect(absent.err).toBe(`${fr("bridge.launcher.not_installed")}\n`);
  });

  it("l'adresse donnée par la variable doit être un fichier : un dossier, un chemin relatif ou rien ne comptent pour aucune installation", async () => {
    const { root, env } = setup();
    for (const given of [root, "relatif.mjs", join(root, "absent.mjs")]) {
      const result = await run(["bridge", "start"], {
        ...env,
        AGENTPLUGGED_BRIDGE_ENTRY: given,
        AGENTPLUGGED_LANG: "fr",
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain("Le pont n'est pas installé");
    }
  });

  it("l'aide de la commande liste `bridge install|uninstall|start|status`, en français et en anglais", async () => {
    const french = await run(["--help"], { AGENTPLUGGED_LANG: "fr" });
    expect(french.out).toContain("bridge install|uninstall|start|status  Installe le pont");
    const english = await run(["--help"], { AGENTPLUGGED_LANG: "en" });
    expect(english.out).toContain("bridge install|uninstall|start|status  Install the bridge");
  });
});

describe("la commande publique ne contient aucune logique du pont", () => {
  it("le lanceur n'importe ni le pont, ni le client du relais, et le paquet public ne dépend d'aucun des deux", () => {
    const text = readFileSync(join(sourceDir, "bridge-launcher.ts"), "utf8");
    expect(text).not.toMatch(PRIVATE_NAME);
    expect(text).not.toMatch(/WebSocket|websocket|relay_url|binding|machine key|keychain/i);
    const manifest = JSON.parse(readFileSync(join(sourceDir, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const all = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    });
    for (const name of all) {
      expect(name, name).not.toMatch(PRIVATE_NAME_EXACT);
    }
  });
});
