import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { describe, expect, it } from "vitest";
import {
  AgentSession,
  type CommandContext,
  createCommandRegistry,
  initCommand,
  type JournalBackupView,
  MemoryKeyStore,
  MemoryStateStore,
  resolveProfile,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(38));
const START = Date.UTC(2026, 9, 7, 12, 0, 0);

const BLOCKED: JournalBackupView = {
  status: "blocked",
  reason: "no_remote",
  since: "2026-10-07T11:00:00.000Z",
  action: "Tell the creator ONCE ...",
};

/** The backup as the MCP server gives it: what it reports, and how many times it was asked. */
function fakeBackup(view: JournalBackupView | undefined) {
  const asked: Array<boolean | undefined> = [];
  return {
    asked,
    report: async (options?: { consume?: boolean }) => {
      asked.push(options?.consume);
      return view;
    },
    kick: async () => {},
  };
}

async function product(backup?: ReturnType<typeof fakeBackup>) {
  const files = new MemoryFiles();
  let clock = START;
  const now = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    keys,
    now,
    interactive: true,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    human: undefined,
    interactive: undefined,
    session: new AgentSession(START),
    now: () => clock + 500,
    ...(backup === undefined ? {} : { journalBackup: backup }),
  };
  const registry = createCommandRegistry();
  return (name: string) =>
    registry.run(name, agent, {}) as Promise<{ value: Record<string, unknown> }>;
}

describe("the backup of the journal in next and get_state", () => {
  it("says nothing while the journal is saved: the creator and the agents see nothing", async () => {
    const backup = fakeBackup(undefined);
    const call = await product(backup);
    for (const name of ["next", "get_state"]) {
      expect((await call(name)).value).not.toHaveProperty("journal_backup");
    }
  });

  it("says nothing either without a backup (a command of the CLI, a product that is not a repository)", async () => {
    const call = await product();
    expect((await call("get_state")).value).not.toHaveProperty("journal_backup");
  });

  it("gives what is wrong, since when, and what Noah says once, in both", async () => {
    const backup = fakeBackup(BLOCKED);
    const call = await product(backup);
    for (const name of ["next", "get_state"]) {
      expect((await call(name)).value.journal_backup).toEqual(BLOCKED);
    }
    // Reading it is what tells it: the engine marks it told, so Noah says it once.
    expect(backup.asked).toEqual([true, true]);
  });
});
