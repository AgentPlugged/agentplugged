import { existsSync, readFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "tsdown";

/** The method shipped by `init`: the `@agentplugged/method` package of the monorepo. */
const methodManifest = createRequire(import.meta.url).resolve("@agentplugged/method/package.json");
const methodDir = dirname(methodManifest);
/**
 * What the published package carries of it, copied into `dist/method/`: its `files`, so its
 * `LICENSE` (MIT, unlike the engine's FSL-1.1-MIT) travels with it.
 */
const METHOD_ENTRIES = (
  JSON.parse(readFileSync(methodManifest, "utf8")) as { files: string[] }
).files.filter((entry) => entry !== "README.md");

export default defineConfig({
  // `bin.ts` checks the Node.js version, then loads `cli.ts` (its own chunk, `dist/cli.js`).
  entry: ["src/bin.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: false,
  fixedExtension: false,
  hash: false,
  // The internal packages are bundled: only public npm packages (zod, yaml) stay dependencies.
  // A native module (the system keychain) is never bundled: no platform binary in the package.
  // The CLI declares it as a dependency once one of its commands writes to the journal. The FFI
  // of Windows Hello (`koffi`) is an optional dependency, loaded on Windows only.
  deps: { alwaysBundle: /^@agentplugged\//, neverBundle: [/^@napi-rs\//, /^koffi$/] },
  hooks: {
    async "build:done"() {
      const target = join("dist", "method");
      await rm(target, { recursive: true, force: true });
      for (const entry of METHOD_ENTRIES) {
        const source = join(methodDir, entry);
        if (!existsSync(source)) {
          throw new Error(`The method has no ${entry} (${source}): the build cannot ship it.`);
        }
        await cp(source, join(target, entry), { recursive: true });
      }
    },
  },
});
