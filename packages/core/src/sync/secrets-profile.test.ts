import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  initCommand,
  type MainBranchReader,
  resolveProfile,
  rulesCommand,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const CONFIG = ".agentplugged/method.yaml";
const CLAUDE = ".claude/settings.json";
const CURSOR = ".cursor/cli.json";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => "1.0.0",
  extensions: async () => [],
};

function context(
  files: MemoryFiles,
  extra: Partial<Pick<CommandContext, "interactive" | "mainBranch" | "actor">> = {},
): CommandContext {
  return {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    ...extra,
  };
}

async function product(): Promise<MemoryFiles> {
  const files = new MemoryFiles();
  const result = await initCommand.run(context(files), { profile: resolveProfile("new-product") });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  return files;
}

async function sync(files: MemoryFiles, mainBranch?: MainBranchReader): Promise<void> {
  const result = await syncCommand.run(
    context(files, mainBranch === undefined ? {} : { mainBranch }),
    {},
  );
  if (!result.ok) throw new Error(`sync failed: ${result.error.code}`);
}

const permissions = (files: MemoryFiles, path: string) =>
  (JSON.parse(files.files.get(path) ?? "null") as { permissions: Record<string, string[]> })
    .permissions;

/** What an agent must never read, by tool syntax: secret files, keychains, keys, `~/.ssh`. */
const NEVER_READ = [
  "~/.ssh/**",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/*.p12",
  "**/.npmrc",
  "**/.netrc",
  "**/.env",
  "~/Library/Keychains/**",
  "~/.local/share/keyrings/**",
  "~/AppData/Roaming/Microsoft/Credentials/**",
  "~/AppData/Local/Microsoft/Credentials/**",
  "~/AppData/Roaming/Microsoft/Protect/**",
  // The bridge's own folder: its keys and its link (on each system).
  "~/AppData/Local/AgentPlugged/bridge/**",
  "~/Library/Application Support/AgentPlugged/bridge/**",
  "~/.local/state/agentplugged/bridge/**",
  "~/.agentplugged/trust/**",
  "~/.agentplugged/keys/**",
];

describe("the permission profiles keep the secrets from the agents", () => {
  it("denies the reading of secrets, keychains, device keys and ~/.ssh in Claude Code and Cursor", async () => {
    const files = await product();
    await sync(files);
    const claude = permissions(files, CLAUDE);
    const cursor = permissions(files, CURSOR);
    for (const path of NEVER_READ) {
      expect(claude.deny).toContain(`Read(${path})`);
      expect(cursor.deny).toContain(`Read(${path})`);
      // Not even a creator's rule of the same name above in `allow` lifts a deny: none is written.
      expect(claude.allow ?? []).not.toContain(`Read(${path})`);
      expect(cursor.allow ?? []).not.toContain(`Read(${path})`);
    }
  });

  it("keeps them denied when method.yaml is edited by hand to loosen the rule", async () => {
    for (const value of ["allow", "ask"]) {
      const files = await product();
      files.seed(CONFIG, `${files.files.get(CONFIG) ?? ""}rules:\n  read_secrets: ${value}\n`);
      await sync(files);
      for (const [path, tool] of [
        [CLAUDE, "claude"],
        [CURSOR, "cursor"],
      ] as const) {
        const lists = permissions(files, path);
        for (const secret of NEVER_READ) {
          expect(lists.deny, `${tool} ${secret}`).toContain(`Read(${secret})`);
          expect(lists.allow ?? []).not.toContain(`Read(${secret})`);
          expect(lists.ask ?? []).not.toContain(`Read(${secret})`);
        }
      }
    }
  });

  it("keeps them denied when the main branch's rules are loosened", async () => {
    const files = await product();
    const config = files.files.get(CONFIG) ?? "";
    const main: MainBranchReader = {
      read: async () => ({
        found: true,
        branch: "main",
        text: `${config}rules:\n  read_secrets: allow\n`,
      }),
    };
    await sync(files, main);
    const claude = permissions(files, CLAUDE);
    for (const path of NEVER_READ) expect(claude.deny).toContain(`Read(${path})`);
  });

  it("is not settable by the command, whoever runs it: an agent, a terminal or a script", async () => {
    for (const actor of ["agent", "human"] as const) {
      for (const interactive of [true, false]) {
        const files = await product();
        const before = files.files.get(CONFIG);
        const result = await rulesCommand.run(context(files, { actor, interactive }), {
          action: "set",
          rule: "read_secrets",
          value: "allow",
        });
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        // Refused for the lock when the command could run, or for want of a terminal: never applied.
        expect([ErrorCode.RULE_LOCKED, ErrorCode.REVIEW_NOT_INTERACTIVE]).toContain(
          result.error.code,
        );
        expect(files.files.get(CONFIG)).toBe(before);
      }
    }
  });
});
