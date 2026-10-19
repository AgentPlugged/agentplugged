// Starts the AgentPlugged engine's MCP server (`npx -y agentplugged@1.1.1 mcp`) for Claude Code.
// Why a launcher: Claude Code on Windows cannot start `npx` (`npx.cmd`) directly. The engine
// version is the one of this plugin, so one version only is in play.
import { spawn } from "node:child_process";

const ENGINE = "1.1.1";
const args = ["-y", `agentplugged@${ENGINE}`, "mcp"];
const windows = process.platform === "win32";
const child = windows
  ? spawn(`npx ${args.join(" ")}`, { stdio: "inherit", shell: true })
  : spawn("npx", args, { stdio: "inherit" });

// Through a Windows shell, kill would stop the shell only: the whole tree is stopped.
const stop = (signal) =>
  windows && child.pid !== undefined
    ? spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    : child.kill(signal);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
child.on("error", (error) => {
  console.error(`agentplugged: cannot start npx (${error.message}). Node.js 24 or later is required.`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
