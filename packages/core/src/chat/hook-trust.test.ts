import { toBase64url } from "@agentplugged/crypto";
import { describe, expect, it } from "vitest";
import {
  AgentSession,
  type ChatLog,
  type CommandContext,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  resolveProfile,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { hooksUntrustedOf } from "./hook-trust.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const PROJECT = "C:\\Users\\Ada\\Desktop\\demo";

/** A store that holds messages recorded for some (project, tool) pairs. */
function store(recorded: readonly (readonly [string, string])[]): ChatLog {
  return {
    messages: async () => [],
    hasMessageFrom: async (project, via) =>
      recorded.some(([p, v]) => p.toLowerCase() === project.toLowerCase() && v === via),
  };
}

async function stateOf(client: string | undefined, log: ChatLog | undefined) {
  const files = new MemoryFiles();
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const session = new AgentSession(Date.now(), undefined);
  session.noteClient(client);
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    journal: new MemoryStateStore({
      keys: new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(5))),
    }),
    session,
    chat: { project: PROJECT, ...(log === undefined ? {} : { log }) },
  };
  const result = await createCommandRegistry().run("get_state", agent, {});
  if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
  return { value: result.value as Record<string, unknown>, agent };
}

describe("hooks_untrusted: Codex and Cursor hooks nobody approved", () => {
  it("is carried by get_state for Codex when no message was ever recorded for the project", async () => {
    const { value } = await stateOf("codex_vscode", store([]));
    expect(value.hooks_untrusted).toMatchObject({ tool: "codex" });
    const notice = value.hooks_untrusted as { gesture: string; missing: string };
    expect(notice.gesture).toContain("Review hooks");
    expect(notice.gesture).toContain("/hooks");
    expect(notice.missing).toContain("not recorded");
  });

  it("names Cursor's gesture: Trust, then a restart", async () => {
    const { value } = await stateOf("cursor-vscode", store([]));
    const notice = value.hooks_untrusted as { tool: string; gesture: string };
    expect(notice.tool).toBe("cursor");
    expect(notice.gesture).toContain("Trust");
    expect(notice.gesture).toContain("restart");
  });

  it("goes away as soon as a message of that tool is recorded for this project", async () => {
    const codex = await stateOf("codex-mcp-client", store([[PROJECT, "codex"]]));
    expect(codex.value.hooks_untrusted).toBeUndefined();
    const cursor = await stateOf("cursor-vscode", store([[PROJECT, "cursor"]]));
    expect(cursor.value.hooks_untrusted).toBeUndefined();
  });

  it("is not lifted by a message of another tool or of another project", async () => {
    const other = await stateOf(
      "codex-mcp-client",
      store([
        [PROJECT, "cursor"],
        ["C:\\Users\\Ada\\Desktop\\elsewhere", "codex"],
      ]),
    );
    expect(other.value.hooks_untrusted).toMatchObject({ tool: "codex" });
  });

  it("says nothing for another tool, or when the store cannot say", async () => {
    expect((await stateOf("claude-code", store([]))).value.hooks_untrusted).toBeUndefined();
    expect((await stateOf(undefined, store([]))).value.hooks_untrusted).toBeUndefined();
    expect((await stateOf("codex-mcp-client", undefined)).value.hooks_untrusted).toBeUndefined();
    const silent: ChatLog = { messages: async () => [] };
    const { agent } = await stateOf("codex-mcp-client", silent);
    expect(await hooksUntrustedOf(agent)).toBeUndefined();
  });
});
