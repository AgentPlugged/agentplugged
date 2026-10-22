import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import {
  AgentSession,
  type CheckpointState,
  type CommandContext,
  type CreatorActionRequested,
  computeProjection,
  createCommandRegistry,
  type DocsBase,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  messageDigest,
  normalizeChatText,
  type PathsCommitRequest,
  resolveProfile,
  type StoryWorkspace,
  type StoryWorkspaceInspection,
  type StoryWorkspaceTarget,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "./memory-files.js";

/**
 * A product in memory with its journal, a creator who answers in the chat and an agent session:
 * the harness of the flows that go from the creator's word to the journal.
 */
const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

export const SEED = toBase64url(new Uint8Array(32).fill(7));
export const START = Date.UTC(2026, 9, 6, 12, 0, 0);
export const SESSION = "creator-session-1";
export const HEAD = "a".repeat(40);

/** The hook's store, in memory. */
class MemoryChatLog {
  readonly list: Array<{
    session: string;
    at: string;
    digest: string;
    text: string;
  }> = [];

  say(text: string, at: number): void {
    const normalized = normalizeChatText(text);
    this.list.push({
      session: SESSION,
      at: new Date(at).toISOString(),
      digest: messageDigest(normalized),
      text: normalized,
    });
  }

  async messages(session: string) {
    return this.list.filter((message) => message.session === session);
  }
}

class FakeWorkspace implements StoryWorkspace {
  readonly heads = new Map<string, string>();
  readonly hooks: unknown[] = [];
  /** The paths committed by the engine itself, one request per commit. */
  readonly pathCommits: PathsCommitRequest[] = [];
  commitPaths = async (request: PathsCommitRequest) => {
    this.pathCommits.push(request);
    return { ok: true as const, commit: "d".repeat(40) };
  };

  async inspect(target: StoryWorkspaceTarget): Promise<StoryWorkspaceInspection> {
    const head = this.heads.get(target.branch);
    return {
      repository: true,
      prefix: "",
      main: { ref: "main", commit: "c".repeat(40) },
      storyBlob: null,
      branch: head === undefined ? null : { commit: head, merged: false, storyBlob: null },
      checkedOut: null,
      target: { path: `/repos/shop.worktrees/${target.id}`, relative: "", exists: false },
    };
  }
  create = () => Promise.reject(new Error("unused"));
  discard = async () => true;
  readBlob = async () => undefined;
  storyFilesOn = async () => undefined;
  installCommitHook = async (files: unknown) => {
    this.hooks.push(files);
    return { status: "installed" as const, path: "/repos/shop/.git/hooks/commit-msg" };
  };
}

const NO_BASE: DocsBase = {
  read: async () => ({ found: false, reason: "no_repository" }),
  readBlobs: async () => new Map(),
  blobsInHistory: async () => new Set(),
};

export async function product(
  profile: "new-product" | "maintenance" = "new-product",
  agents: Record<string, string> = {},
) {
  const files = new MemoryFiles();
  let clock = START;
  const journalNow = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now: journalNow });
  const workspace = new FakeWorkspace();
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(agents),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now: journalNow,
    interactive: true,
    keys,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
    storyWorkspace: workspace,
    docsBase: NO_BASE,
  };
  const init = await initCommand.run(human, { profile: resolveProfile(profile) });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const log = new MemoryChatLog();
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    human: undefined,
    interactive: undefined,
    session: new AgentSession(START),
    now: () => START + 3_600_000,
    chat: { log, hookInstalled: true, hooked: true },
  };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown> = {}) =>
    registry.run(name, agent, input);
  const productId = (await journal.productId()) as string;
  const projection = async () => computeProjection((await journal.list()).events);
  const state = async () => (await projection()).state;
  const request = async (action: Record<string, unknown>, reason = "my choice") => {
    const result = await call("request_creator_action", { agent: "main", action, reason });
    if (!result.ok) throw new Error(`request failed: ${result.error.code}`);
    const value = result.value as CreatorActionRequested;
    const opened = journal.events.find((event) => event.id === value.id);
    return { ...value, time: Date.parse(opened?.at ?? "") };
  };
  /** The creator says it, the engine records it: one request, one answer. */
  const decide = async (action: Record<string, unknown>, said = "oui", reason = "my choice") => {
    const asked = await request(action, reason);
    log.say(said, asked.time + 100);
    const answered = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: asked.checkpoint,
      decision: "approved",
      quote: said,
      session: SESSION,
    });
    if (!answered.ok) throw new Error(`answer failed: ${answered.error.code}`);
    return asked;
  };
  const checkpoint = async (id: string) =>
    ((await state()).checkpoints as Record<string, CheckpointState>)[id];
  return {
    files,
    journal,
    workspace,
    human,
    agent,
    call,
    log,
    request,
    decide,
    state,
    projection,
    checkpoint,
    productId,
  };
}
