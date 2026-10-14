/** The CLI, loaded by `bin.ts` once the Node.js version is known to be supported. */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ENGINE_CHILD_ENV } from "./launcher-env.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

if (process.argv[2] === "mcp" && process.env[ENGINE_CHILD_ENV] !== "1") {
  // The AI tool starts a stable launcher, which runs the engine of a version in a child
  // process and moves to a newer one between two calls, never cutting the connection.
  const { runLauncher } = await import("./launcher.js");
  process.exitCode = await runLauncher({
    args: process.argv.slice(3),
    cwd: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: (text) => process.stderr.write(text),
    version: manifest.version,
    selfEntry: fileURLToPath(new URL("./bin.js", import.meta.url)),
  });
} else {
  const { main } = await import("./main.js");
  process.exitCode = await main({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    engineVersion: manifest.version,
    installedEngineVersion: async () => {
      try {
        const now = JSON.parse(
          await readFile(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version?: string };
        return now.version;
      } catch {
        return undefined;
      }
    },
    systemLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdin: process.stdin,
    stdoutStream: process.stdout,
    platform: process.platform,
    // Questions need someone to read them and to answer them.
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  });
}
