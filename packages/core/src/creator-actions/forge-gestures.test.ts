import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { type DecisionPrompt, ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  AgentSession,
  type AnswerRecorded,
  type AskCreatorResult,
  type ChatMessage,
  type CheckpointState,
  type CommandContext,
  type CreatorPrompt,
  type CreatorReply,
  computeProjection,
  createCommandRegistry,
  initCommand,
  type MainInspection,
  MemoryKeyStore,
  MemoryStateStore,
  messageDigest,
  normalizeChatText,
  type RecordedEvent,
  type RemoteBranchState,
  type RepositoryCreation,
  type RepositoryRequest,
  recordGitWorkflow,
  resolveProfile,
  type StoryForge,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import type { StoryDiff } from "../review/review-diff.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(21));
const SESSION = "5f0c-forge-session";
const START = Date.UTC(2026, 9, 4, 12, 0, 0);
const HEAD = "a".repeat(40);
const CI_HEAD = "c".repeat(40);
const URL_ORIGIN = "https://github.com/ada/shop.git";

/** The forge's tool and Git, in memory: what the engine reads and what it does. */
class FakeForge implements StoryForge {
  remotes: { name: string; url: string }[] = [];
  main: { branch: string | null; head: string | null } = { branch: "main", head: HEAD };
  repository = true;
  prefix = "";
  cliState: "ready" | "missing" | "logged_out" = "ready";
  /** `remote/branch` → state of the remote's branch. */
  remoteState = new Map<string, RemoteBranchState>();
  /** Local branches → commit. */
  branches = new Map<string, string>();
  pullRequestList: {
    number: number;
    url: string;
    state: "open" | "closed" | "merged";
    title: string;
    body: string;
  }[] = [];
  pr: {
    state: "open" | "closed" | "merged";
    head: string | null;
    merge_commit: string | null;
    base: string | null;
  } = {
    state: "open",
    head: CI_HEAD,
    merge_commit: null,
    base: "main",
  };
  mergeOutcome:
    | { ok: true; merge_commit: string | null }
    | { ok: false; reason: "head_moved" | "not_mergeable" | "failed"; message: string } = {
    ok: true,
    merge_commit: "m".repeat(40),
  };
  createOutcome: RepositoryCreation | undefined;
  pushOutcome:
    | { ok: true }
    | { ok: false; reason: "push_rejected" | "push_failed"; message: string } = { ok: true };

  readonly created: RepositoryRequest[] = [];
  readonly pushed: { remote: string; branch: string; commit: string }[] = [];
  readonly opened: { base: string; branch: string; title: string; body: string }[] = [];
  readonly merged: { commit: string; method: string }[] = [];

  async inspect(branch: string) {
    return {
      repository: this.repository as true,
      prefix: this.prefix,
      remotes: this.remotes,
      head: this.branches.get(branch) ?? null,
      commits: 1,
    };
  }
  async cli() {
    return this.cliState;
  }
  push = () => Promise.reject(new Error("unused"));
  async pullRequests() {
    return this.pullRequestList;
  }
  async create(
    _repository: unknown,
    draft: { base: string; branch: string; title: string; body: string },
  ) {
    this.opened.push(draft);
    return { number: 7, url: "https://github.com/ada/shop/pull/7" };
  }
  update = () => Promise.reject(new Error("unused"));
  async pullRequest() {
    return this.pr;
  }
  async merge(_repository: unknown, _number: number, request: { commit: string; method: string }) {
    this.merged.push(request);
    return this.mergeOutcome;
  }
  async inspectMain(): Promise<MainInspection> {
    if (!this.repository) return { repository: false };
    return {
      repository: true,
      prefix: this.prefix,
      remotes: this.remotes,
      branch: this.main.branch,
      head: this.main.head,
    };
  }
  async remoteBranch(remote: string, branch: string): Promise<RemoteBranchState> {
    return this.remoteState.get(`${remote}/${branch}`) ?? { state: "missing" };
  }
  async pushMain(remote: string, branch: string, commit: string) {
    this.pushed.push({ remote, branch, commit });
    return this.pushOutcome;
  }
  async createRepository(request: RepositoryRequest): Promise<RepositoryCreation> {
    this.created.push(request);
    if (this.createOutcome !== undefined) return this.createOutcome;
    const remote = {
      name: request.remote ?? "origin",
      url: `https://github.com/${request.owner ?? "ada"}/${request.name}.git`,
    };
    this.remotes.push(remote);
    return { ok: true, remote };
  }
}

/** The hook's store, in memory: the creator's messages as they are typed. */
class MemoryChatLog {
  readonly list: ChatMessage[] = [];

  say(text: string, at: number): void {
    const normalized = normalizeChatText(text);
    this.list.push({
      session: SESSION,
      at: new Date(at).toISOString(),
      digest: messageDigest(normalized),
      text: normalized,
    });
  }

  async messages(session: string): Promise<readonly ChatMessage[]> {
    return this.list.filter((message) => message.session === session);
  }
}

/** The AI tool's form, scripted for a point. */
class ScriptedPrompt implements CreatorPrompt {
  readonly asked: DecisionPrompt[] = [];
  constructor(
    readonly channel: string,
    private readonly replies: CreatorReply[],
  ) {}
  async ask(prompt: DecisionPrompt): Promise<CreatorReply> {
    this.asked.push(prompt);
    const next = this.replies.shift();
    if (next === undefined) throw new Error("no reply scripted");
    return next;
  }
}

const ciDiff = (paths: string[]): StoryDiff => ({
  diff: async () =>
    paths
      .map(
        (path) =>
          `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`,
      )
      .join(""),
});

async function product(
  options: {
    mode?: string;
    files?: string[];
    hooked?: boolean;
    /** The journal's backup, when the gesture must ask it to try again. */
    backup?: { kick: () => Promise<void>; report: () => Promise<undefined> };
  } = {},
) {
  const files = new MemoryFiles();
  let clock = START;
  const journalNow = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now: journalNow });
  const forge = new FakeForge();
  const merges: unknown[] = [];
  const workspace = {
    mergeBranch: async (request: unknown) => {
      merges.push(request);
      return { ok: true, commit: "d".repeat(40), merge_commit: "e".repeat(40) };
    },
  };
  const log = new MemoryChatLog();
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    keys,
    now: journalNow,
    interactive: true,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  if (options.mode !== undefined) {
    const text = await files.readText(".agentplugged/method.yaml");
    await files.writeText(
      ".agentplugged/method.yaml",
      `${text}validation:\n  mode: ${options.mode}\n`,
    );
  }
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    human: undefined,
    interactive: undefined,
    session: new AgentSession(START),
    now: () => clock + 500,
    storyForge: forge,
    ...(options.backup === undefined ? {} : { journalBackup: options.backup }),
    // The engine's own Git merge, recording what it was asked.
    storyWorkspace: workspace as never,
    storyDiff: ciDiff(options.files ?? [".github/workflows/ci.yml"]),
    chat: { log, hookInstalled: true, hooked: options.hooked ?? true },
  };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>, prompt?: CreatorPrompt) =>
    registry.run(name, prompt === undefined ? agent : { ...agent, creatorPrompt: prompt }, input);
  const request = async (action: Record<string, unknown>, reason = "the creator asked for it") => {
    const result = await call("request_creator_action", { agent: "main", action, reason });
    return result;
  };
  const requested = async (action: Record<string, unknown>) => {
    const result = await request(action);
    if (!result.ok) {
      throw new Error(
        `request failed: ${result.error.code} ${JSON.stringify(result.error.toPayload().details)}`,
      );
    }
    return result.value as {
      checkpoint: string;
      risk: string;
      irreversible: boolean;
      terminal_command: string;
    };
  };
  let typed = 0;
  /** The creator types a message: after the point opened, before the agent relays it. */
  const say = (text: string) => {
    typed += 1;
    log.say(text, clock + typed * 10);
  };
  /** The creator's messages are typed, then the agent relays them with the session id. */
  const answer = (checkpoint: string, input: Record<string, unknown>) => {
    say(String(input.quote));
    return call("answer_checkpoint", { agent: "main", checkpoint, session: SESSION, ...input });
  };
  const approve = (checkpoint: string, extra: Record<string, unknown> = {}) =>
    answer(checkpoint, {
      decision: "approved",
      quote: "yes, go ahead",
      ...extra,
    });
  const projection = async () => computeProjection((await journal.list()).events);
  const checkpoint = async (id: string) =>
    ((await projection()).state.checkpoints as Record<string, CheckpointState>)[
      id
    ] as CheckpointState;
  /** The creator at the terminal: `review`, with the forge's port the CLI gives it. */
  const review = (input: Record<string, unknown>) =>
    registry.run(
      "review",
      { ...human, storyForge: forge, storyDiff: agent.storyDiff as StoryDiff },
      input,
    );
  return {
    files,
    journal,
    forge,
    merges,
    call,
    answer,
    say,
    log,
    request,
    requested,
    approve,
    projection,
    checkpoint,
    human,
    review,
  };
}

const CREATE = { kind: "forge_repo_create", forge: "github", name: "shop" };
const PUSH = { kind: "forge_push_main" };
const MERGE = { kind: "forge_merge_ci", branch: "ci/base-workflows" };

const code = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? undefined : result.error?.code;
const details = (result: { ok: boolean; error?: { toPayload(): { details: unknown } } }) =>
  result.ok ? undefined : result.error?.toPayload().details;

describe("the repository to create", () => {
  it("is asked as an irreversible request the engine sets, private by default", async () => {
    const { requested, checkpoint } = await product();
    const asked = await requested(CREATE);
    // No gesture of the forge is irreversible (the creator undoes it), none needs a confirmation.
    expect(asked).toMatchObject({ risk: "medium", irreversible: false });
    expect(asked).not.toHaveProperty("terminal_command");
    const point = await checkpoint(asked.checkpoint);
    expect(point.title).toBe("Create the private GitHub repository shop");
    expect(point.summary).toContain("remote origin");
    expect(point.summary).toContain("Nothing is pushed");
    expect(point.irreversible).toBe(false);
    expect(point.confirmation).not.toContain("explicit");
  });

  it("is a high risk when the creator asks for a public repository", async () => {
    const { requested, checkpoint } = await product();
    const asked = await requested({ ...CREATE, visibility: "public", owner: "ada" });
    expect(asked.risk).toBe("high");
    expect((await checkpoint(asked.checkpoint)).title).toBe(
      "Create the public GitHub repository ada/shop",
    );
  });

  it("creates the repository with the forge's tool once the creator approves it with one answer", async () => {
    const { requested, approve, forge, checkpoint, projection } = await product();
    const asked = await requested(CREATE);
    expect(forge.created).toEqual([]);
    const result = await approve(asked.checkpoint);
    expect(result.ok).toBe(true);
    const value = (result as { value: AnswerRecorded }).value;
    expect(value.executed).toMatchObject({
      kind: "forge_repo_create",
      gesture: { kind: "forge_repo_create", status: "done", target: "github.com/ada/shop" },
    });
    expect(forge.created).toEqual([
      { forge: "github", host: "github.com", name: "shop", visibility: "private" },
    ]);
    const point = await checkpoint(asked.checkpoint);
    expect(point.status).toBe("resolved");
    expect(point.executed).toMatchObject({ source: "chat" });
    expect((await projection()).ignored).toEqual([]);
  });

  it("creates it from the AI tool's form, one click and no box to tick", async () => {
    const { requested, call, forge } = await product();
    const asked = await requested({ ...CREATE, name: "blog" });
    const prompt = new ScriptedPrompt("claude-code", [
      { action: "accept", content: { choice: "approve" } },
    ]);
    const result = await call(
      "ask_creator",
      { agent: "main", checkpoint: asked.checkpoint },
      prompt,
    );
    expect(result.ok).toBe(true);
    const value = (result as { value: AskCreatorResult }).value;
    expect(value).toMatchObject({ answered: true, executed: { gesture: { status: "done" } } });
    expect(forge.created).toHaveLength(1);
    // The form asks nothing more: no confirmation box.
    expect(prompt.asked[0]?.external_action).toBeNull();
  });

  it("does nothing when the creator refuses, asks for changes, or never answers", async () => {
    const { requested, answer, forge, checkpoint } = await product();
    const asked = await requested(CREATE);
    const refused = await answer(asked.checkpoint, {
      decision: "rejected",
      quote: "no, not now",
    });
    expect(refused.ok).toBe(true);
    expect((refused as { value: AnswerRecorded }).value.executed).toBeUndefined();
    expect(forge.created).toEqual([]);
    expect((await checkpoint(asked.checkpoint)).resolution?.decision).toBe("rejected");
  });

  it("runs on one answer and refuses a confirmation sent along", async () => {
    const { requested, answer, forge, checkpoint } = await product();
    const asked = await requested(CREATE);
    const extra = await answer(asked.checkpoint, {
      decision: "approved",
      quote: "yes",
      confirmation_quote: "yes, I confirm",
    });
    expect(code(extra)).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(forge.created).toEqual([]);
    expect((await checkpoint(asked.checkpoint)).status).toBe("open");
    const done = await answer(asked.checkpoint, { decision: "approved", quote: "yes" });
    expect(done.ok).toBe(true);
    expect(forge.created).toHaveLength(1);
  });

  it("at the strict level, only the terminal answers a high risk: the push, the merge, a public repository", async () => {
    const { requested, approve, forge } = await product({ mode: "strict" });
    const asked = await requested({ ...CREATE, visibility: "public" });
    const result = await approve(asked.checkpoint);
    expect(code(result)).toBe(ErrorCode.REVIEW_REQUIRED);
    expect(forge.created).toEqual([]);
  });

  it("is refused where the repository or the tool does not allow it, and when it is already so", async () => {
    const { request, forge } = await product();
    forge.cliState = "missing";
    expect(details(await request(CREATE))).toMatchObject({ reason: "cli_missing", cli: "gh" });
    forge.cliState = "logged_out";
    expect(details(await request(CREATE))).toMatchObject({ reason: "not_logged_in" });
    forge.cliState = "ready";
    forge.repository = false;
    expect(details(await request(CREATE))).toMatchObject({ reason: "no_repository" });
    forge.repository = true;
    forge.prefix = "app/";
    expect(details(await request(CREATE))).toMatchObject({ reason: "not_repository_root" });
    forge.prefix = "";
    forge.remotes = [{ name: "origin", url: "https://github.com/other/thing.git" }];
    expect(code(await request(CREATE))).toBe(ErrorCode.FORGE_GESTURE_FAILED);
    expect(details(await request(CREATE))).toMatchObject({ reason: "remote_exists" });
    // The repository asked for is already origin: nothing to create.
    forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    expect(code(await request({ ...CREATE, owner: "ada" }))).toBe(
      ErrorCode.CREATOR_ACTION_UNCHANGED,
    );
  });

  it("checks the name and the owner the agent gives, never a free text", async () => {
    const { request } = await product();
    for (const name of ["", "a b", "x.git", "-rf", "$(id)", "a/b"]) {
      expect(code(await request({ ...CREATE, name })), name).toBe(ErrorCode.INVALID_ARGUMENTS);
    }
    expect(code(await request({ ...CREATE, owner: "ada; rm" }))).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(code(await request({ ...CREATE, forge: "bitbucket" }))).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    expect(code(await request({ ...CREATE, visibility: "internal" }))).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    // The commit and the target are the engine's, never the agent's.
    expect(code(await request({ ...PUSH, commit: HEAD }))).toBe(ErrorCode.INVALID_ARGUMENTS);
  });

  it("tells the creator what failed when the forge refuses, and keeps the decision", async () => {
    const { requested, approve, forge, checkpoint } = await product();
    const asked = await requested(CREATE);
    forge.createOutcome = { ok: false, reason: "failed", message: "HTTP 500" };
    const result = await approve(asked.checkpoint);
    expect(code(result)).toBe(ErrorCode.CREATOR_ACTION_FAILED);
    expect(details(result)).toMatchObject({ kind: "forge_repo_create", reason: "forge_failed" });
    // The approval is recorded; asking again finds what is done.
    expect((await checkpoint(asked.checkpoint)).status).toBe("resolved");
  });
});

describe("the private repository of the journal", () => {
  /** A product whose origin is a public repository: the journal cannot go there. */
  async function publicOrigin(exposure: "public" | "private" = "public") {
    const backup = { kick: vi.fn(async () => {}), report: vi.fn(async () => undefined) };
    const subject = await product({ backup });
    subject.forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    (subject.journal as unknown as { remoteExposure: () => Promise<string> }).remoteExposure =
      async () => exposure;
    return { ...subject, backup };
  }
  const JOURNAL = { ...CREATE, name: "shop-journal" };

  it("creates a separate private repository as the remote agentplugged-journal, and has the journal sent there at once", async () => {
    const { requested, approve, forge, backup, checkpoint } = await publicOrigin();
    const asked = await requested(JOURNAL);
    expect(asked.risk).toBe("medium");
    expect((await checkpoint(asked.checkpoint)).summary).toContain("agentplugged-journal");
    const result = await approve(asked.checkpoint);
    expect(result.ok).toBe(true);
    expect((result as { value: AnswerRecorded }).value.executed).toMatchObject({
      gesture: { kind: "forge_repo_create", status: "done", target: "github.com/ada/shop-journal" },
    });
    expect(forge.created).toEqual([
      {
        forge: "github",
        host: "github.com",
        name: "shop-journal",
        visibility: "private",
        remote: "agentplugged-journal",
      },
    ]);
    // Origin stays what it was.
    expect(forge.remotes.map((remote) => remote.name)).toEqual(["origin", "agentplugged-journal"]);
    expect(backup.kick).toHaveBeenCalledTimes(1);
  });

  it("a repository created for a product without a remote has the journal sent there at once too", async () => {
    const backup = { kick: vi.fn(async () => {}), report: vi.fn(async () => undefined) };
    const { requested, approve } = await product({ backup });
    const asked = await requested(CREATE);
    expect((await approve(asked.checkpoint)).ok).toBe(true);
    expect(backup.kick).toHaveBeenCalledTimes(1);
  });

  it("is still refused when origin is private: the repository of the product is the journal's", async () => {
    const { request } = await publicOrigin("private");
    const result = await request(JOURNAL);
    expect(code(result)).toBe(ErrorCode.FORGE_GESTURE_FAILED);
    expect(details(result)).toMatchObject({ reason: "remote_exists", remote: "origin" });
  });

  it("never makes the journal's repository public", async () => {
    const { request } = await publicOrigin();
    const result = await request({ ...JOURNAL, visibility: "public" });
    expect(details(result)).toMatchObject({ reason: "remote_exists" });
  });

  it("finds it already done, and refuses another repository once the journal has its own", async () => {
    const { request, forge } = await publicOrigin();
    forge.remotes = [
      { name: "origin", url: URL_ORIGIN },
      { name: "agentplugged-journal", url: "https://github.com/ada/shop-journal.git" },
    ];
    expect(code(await request({ ...JOURNAL, owner: "ada" }))).toBe(
      ErrorCode.CREATOR_ACTION_UNCHANGED,
    );
    expect(details(await request({ ...CREATE, name: "elsewhere" }))).toMatchObject({
      reason: "remote_exists",
      remote: "agentplugged-journal",
    });
  });

  it("needs the forge's tool like any creation", async () => {
    const { request, forge } = await publicOrigin();
    forge.cliState = "logged_out";
    expect(details(await request(JOURNAL))).toMatchObject({ reason: "not_logged_in" });
  });
});

describe("the first push of the main branch", () => {
  async function pushing() {
    const subject = await product();
    subject.forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    return subject;
  }

  it("is asked with the commit and the repository the engine read, a high risk", async () => {
    const { requested, checkpoint } = await pushing();
    const asked = await requested(PUSH);
    expect(asked).toMatchObject({ risk: "high", irreversible: false });
    const point = await checkpoint(asked.checkpoint);
    expect(point.title).toBe("Push the main branch (main) to github.com/ada/shop");
    expect(point.creator_action).toMatchObject({
      kind: "forge_push_main",
      branch: "main",
      commit: HEAD,
      target: "github.com/ada/shop",
    });
    expect(point.summary).toContain("never forced");
  });

  it("pushes that commit to origin, once approved, and never otherwise", async () => {
    const { requested, approve, forge } = await pushing();
    const asked = await requested(PUSH);
    expect(forge.pushed).toEqual([]);
    const result = await approve(asked.checkpoint);
    expect(result.ok).toBe(true);
    expect(forge.pushed).toEqual([{ remote: "origin", branch: "main", commit: HEAD }]);
    expect((result as { value: AnswerRecorded }).value.executed?.gesture).toMatchObject({
      status: "done",
      target: "github.com/ada/shop",
      branch: "main",
    });
  });

  it("pushes onto a remote that is behind, and refuses one that is ahead or diverged: never forced", async () => {
    const { request, forge } = await pushing();
    forge.remoteState.set("origin/main", { state: "behind", head: "b".repeat(40) });
    expect((await request(PUSH)).ok).toBe(true);
    forge.remoteState.set("origin/main", { state: "ahead", head: "b".repeat(40) });
    expect(details(await request(PUSH))).toMatchObject({ reason: "remote_ahead" });
    forge.remoteState.set("origin/main", { state: "diverged", head: "b".repeat(40) });
    expect(details(await request(PUSH))).toMatchObject({ reason: "remote_diverged" });
    forge.remoteState.set("origin/main", { state: "unreadable", message: "no network" });
    expect(details(await request(PUSH))).toMatchObject({ reason: "remote_unreadable" });
    forge.remoteState.set("origin/main", { state: "same", head: HEAD });
    expect(code(await request(PUSH))).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
  });

  it("is refused without an origin, on another forge, or without a main branch", async () => {
    const { request, forge } = await pushing();
    forge.remotes = [];
    expect(details(await request(PUSH))).toMatchObject({ reason: "no_remote" });
    forge.remotes = [{ name: "origin", url: "https://example.com/ada/shop.git" }];
    expect(details(await request(PUSH))).toMatchObject({ reason: "unknown_forge" });
    forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    forge.main = { branch: null, head: null };
    expect(details(await request(PUSH))).toMatchObject({ reason: "no_main_branch" });
  });

  it("does not push when the main branch has a newer commit than the creator saw", async () => {
    const { requested, approve, forge, checkpoint } = await pushing();
    const asked = await requested(PUSH);
    forge.main = { branch: "main", head: "d".repeat(40) };
    const result = await approve(asked.checkpoint);
    expect(code(result)).toBe(ErrorCode.CREATOR_ACTION_STALE);
    expect(details(result)).toMatchObject({ reason: "head_moved" });
    expect(forge.pushed).toEqual([]);
    expect((await checkpoint(asked.checkpoint)).status).toBe("open");
  });

  it("does not push when origin points elsewhere than the repository the creator saw", async () => {
    const { requested, approve, forge, checkpoint } = await pushing();
    const asked = await requested(PUSH);
    forge.remotes = [{ name: "origin", url: "https://github.com/mallory/elsewhere.git" }];
    const result = await approve(asked.checkpoint);
    expect(code(result)).toBe(ErrorCode.CREATOR_ACTION_STALE);
    expect(details(result)).toMatchObject({ reason: "target_changed" });
    expect(forge.pushed).toEqual([]);
    expect((await checkpoint(asked.checkpoint)).status).toBe("open");
  });

  it("does not push over a remote that moved ahead after the request", async () => {
    const { requested, approve, forge } = await pushing();
    const asked = await requested(PUSH);
    forge.remoteState.set("origin/main", { state: "diverged", head: "e".repeat(40) });
    const result = await approve(asked.checkpoint);
    expect(code(result)).toBe(ErrorCode.FORGE_GESTURE_FAILED);
    expect(forge.pushed).toEqual([]);
  });

  it("says a push the remote refused, and keeps the approval", async () => {
    const { requested, approve, forge, checkpoint } = await pushing();
    const asked = await requested(PUSH);
    forge.pushOutcome = { ok: false, reason: "push_failed", message: "protected branch" };
    const result = await approve(asked.checkpoint);
    expect(code(result)).toBe(ErrorCode.CREATOR_ACTION_FAILED);
    expect(details(result)).toMatchObject({ reason: "forge_failed", message: "protected branch" });
    expect((await checkpoint(asked.checkpoint)).status).toBe("resolved");
  });
});

describe("the pull request of the CI", () => {
  async function merging(files?: string[]) {
    const subject = await product(files === undefined ? {} : { files });
    subject.forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    subject.forge.branches.set("ci/base-workflows", CI_HEAD);
    subject.forge.remoteState.set("origin/main", { state: "same", head: HEAD });
    subject.forge.remoteState.set("origin/ci/base-workflows", { state: "same", head: CI_HEAD });
    return subject;
  }

  it("opens the pull request when there is none, then merges it on the commit the creator saw", async () => {
    const { requested, approve, forge, checkpoint } = await merging();
    const asked = await requested(MERGE);
    expect(asked).toMatchObject({ risk: "high", irreversible: false });
    expect((await checkpoint(asked.checkpoint)).creator_action).toMatchObject({
      kind: "forge_merge_ci",
      branch: "ci/base-workflows",
      base: "main",
      commit: CI_HEAD,
      target: "github.com/ada/shop",
    });
    expect(forge.merged).toEqual([]);
    const result = await approve(asked.checkpoint);
    expect(result.ok).toBe(true);
    expect(forge.opened).toHaveLength(1);
    expect(forge.opened[0]).toMatchObject({
      base: "main",
      branch: "ci/base-workflows",
      title: "Set up the CI",
    });
    expect(forge.merged).toEqual([{ commit: CI_HEAD, method: "merge" }]);
    expect((result as { value: AnswerRecorded }).value.executed?.gesture).toMatchObject({
      status: "done",
      pr: 7,
    });
  });

  it("merges the pull request that is open, without opening another", async () => {
    const { requested, approve, forge } = await merging();
    forge.pullRequestList = [
      {
        number: 3,
        url: "https://github.com/ada/shop/pull/3",
        state: "open",
        title: "CI",
        body: "",
      },
    ];
    const asked = await requested(MERGE);
    await approve(asked.checkpoint);
    expect(forge.opened).toEqual([]);
    expect(forge.merged).toHaveLength(1);
  });

  it("merges only the CI: any other file in the branch makes the engine refuse", async () => {
    const { request } = await merging([".github/workflows/ci.yml", "src/app.ts"]);
    const refused = await request(MERGE);
    expect(code(refused)).toBe(ErrorCode.FORGE_GESTURE_FAILED);
    expect(details(refused)).toMatchObject({ reason: "not_ci_change", files: "src/app.ts" });
    const docsOnly = await merging([".agentplugged/docs/runbook.md"]);
    expect(details(await docsOnly.request(MERGE))).toMatchObject({ reason: "not_ci_change" });
    const both = await merging([".github/workflows/ci.yml", ".agentplugged/docs/runbook.md"]);
    expect((await both.request(MERGE)).ok).toBe(true);
    const gitlab = await merging([".gitlab-ci.yml"]);
    expect((await gitlab.request(MERGE)).ok).toBe(true);
    const nothing = await merging([]);
    expect(details(await nothing.request(MERGE))).toMatchObject({ reason: "not_ci_change" });
  });

  it("merges nothing it cannot read, and nothing that is not at the remote as read here", async () => {
    const { request, forge } = await merging();
    forge.remoteState.set("origin/ci/base-workflows", { state: "behind", head: "b".repeat(40) });
    expect(details(await request(MERGE))).toMatchObject({ reason: "branch_not_pushed" });
    forge.remoteState.set("origin/ci/base-workflows", { state: "missing" });
    expect(details(await request(MERGE))).toMatchObject({ reason: "branch_not_pushed" });
    forge.remoteState.set("origin/ci/base-workflows", { state: "same", head: CI_HEAD });
    forge.remoteState.set("origin/main", { state: "missing" });
    expect(details(await request(MERGE))).toMatchObject({
      reason: "branch_not_pushed",
      branch: "main",
    });
    forge.remoteState.set("origin/main", { state: "same", head: HEAD });
    forge.branches.delete("ci/base-workflows");
    expect(details(await request(MERGE))).toMatchObject({ reason: "branch_not_pushed" });
  });

  it("accepts only a branch of the CI, ci/…", async () => {
    const { request } = await merging();
    for (const branch of ["main", "feat/2-1-x", "ci", "ci/", "ci/../x", "ci/a b", "ci/$(id)"]) {
      expect(code(await request({ kind: "forge_merge_ci", branch })), branch).toBe(
        ErrorCode.INVALID_ARGUMENTS,
      );
    }
  });

  it("refuses a pull request that moved, or that the forge refuses, and says why", async () => {
    const { requested, approve, forge } = await merging();
    forge.pullRequestList = [
      {
        number: 3,
        url: "https://github.com/ada/shop/pull/3",
        state: "open",
        title: "CI",
        body: "",
      },
    ];
    const asked = await requested(MERGE);
    forge.pr = { state: "open", head: "f".repeat(40), merge_commit: null, base: "main" };
    expect(details(await approve(asked.checkpoint))).toMatchObject({ reason: "head_moved" });
    expect(forge.merged).toEqual([]);
    forge.pr = { state: "closed", head: CI_HEAD, merge_commit: null, base: "main" };
    expect(details(await approve(asked.checkpoint))).toMatchObject({
      reason: "pull_request_closed",
    });
    expect(forge.merged).toEqual([]);
  });

  it("is never merged by passing the forge's protections: its refusal is said and nothing is forced", async () => {
    const { requested, approve, forge } = await merging();
    const asked = await requested(MERGE);
    forge.mergeOutcome = { ok: false, reason: "not_mergeable", message: "required check missing" };
    const result = await approve(asked.checkpoint);
    expect(code(result)).toBe(ErrorCode.CREATOR_ACTION_FAILED);
    expect(details(result)).toMatchObject({ reason: "not_mergeable" });
    expect(forge.merged).toEqual([{ commit: CI_HEAD, method: "merge" }]);
  });

  it("finds a pull request the forge already merged on that commit: nothing more to do", async () => {
    const { request, forge } = await merging();
    forge.pullRequestList = [
      {
        number: 3,
        url: "https://github.com/ada/shop/pull/3",
        state: "merged",
        title: "CI",
        body: "",
      },
    ];
    forge.pr = { state: "merged", head: CI_HEAD, merge_commit: "m".repeat(40), base: "main" };
    expect(code(await request(MERGE))).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
  });
});

describe("no gesture of the forge without an answer the engine accepted", () => {
  it("ignores a forged execution, and the engine does nothing", async () => {
    const { requested, journal, forge, projection, checkpoint } = await product();
    forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    const asked = await requested(PUSH);
    const record = (await checkpoint(asked.checkpoint)).creator_action;
    const productId = (await journal.productId()) as string;
    await journal.appendAll([
      {
        type: "creator_action.executed",
        actor: { kind: "agent", agent: "main" },
        product: productId,
        provenance: "trusted",
        payload: { checkpoint: asked.checkpoint, action: record, source: "elicitation" },
      },
    ]);
    expect((await projection()).ignored.at(-1)?.reason).toBe("invalid");
    expect((await checkpoint(asked.checkpoint)).status).toBe("open");
    expect(forge.pushed).toEqual([]);
  });

  it("has no tool that does the gesture: only a request, which writes a checkpoint and nothing else", async () => {
    const registry = createCommandRegistry();
    const names = registry.agentCommands().map((command) => command.name);
    for (const name of names) {
      expect(name, name).not.toMatch(/push|merge_ci|create_repo|create_repository|forge/);
    }
    const { requested, forge, journal } = await product();
    forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    const before = (await journal.list()).events.map((event) => event.type);
    await requested(PUSH);
    const after = (await journal.list()).events.map((event) => event.type);
    expect(after.slice(before.length)).toEqual(["checkpoint.opened"]);
    expect(forge.pushed).toEqual([]);
    expect(forge.created).toEqual([]);
    expect(forge.merged).toEqual([]);
  });

  it("is carried out by the engine through the creator's terminal answer too, from the same rule", async () => {
    const { requested, forge, review, projection, checkpoint } = await product();
    forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    const asked = await requested(PUSH);
    expect(forge.pushed).toEqual([]);
    const resolved = await review({
      action: "resolve",
      checkpoint: asked.checkpoint,
      decision: "approved",
    });
    expect(resolved.ok).toBe(true);
    expect(forge.pushed).toEqual([{ remote: "origin", branch: "main", commit: HEAD }]);
    expect((resolved as { value: { executed?: unknown } }).value.executed).toMatchObject({
      kind: "forge_push_main",
      gesture: { status: "done" },
    });
    expect((await checkpoint(asked.checkpoint)).executed).toMatchObject({ source: "terminal" });
    expect((await projection()).ignored).toEqual([]);
  });

  it("does not run at the terminal either when the repository moved since the request", async () => {
    const { requested, forge, review, checkpoint } = await product();
    forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    const asked = await requested(PUSH);
    forge.main = { branch: "main", head: "d".repeat(40) };
    const resolved = await review({
      action: "resolve",
      checkpoint: asked.checkpoint,
      decision: "approved",
    });
    expect(code(resolved)).toBe(ErrorCode.CREATOR_ACTION_STALE);
    expect(forge.pushed).toEqual([]);
    expect((await checkpoint(asked.checkpoint)).status).toBe("open");
  });

  it("keeps a record that cannot be forged by an agent: the commit and the target are the engine's", async () => {
    const { requested, checkpoint, forge } = await product();
    forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    const asked = await requested(PUSH);
    const record = (await checkpoint(asked.checkpoint)).creator_action as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(
      ["branch", "commit", "kind", "reason", "target"].sort(),
    );
    expect(record.reason).toBe("the creator asked for it");
  });
});

describe("the gestures need a proof of the creator's words (security review)", () => {
  it("are approved in the chat of a tool without the hook, recorded unverified", async () => {
    const { requested, approve, forge, checkpoint } = await product({ hooked: false });
    const create = await requested(CREATE);
    const done = await approve(create.checkpoint);
    expect(done.ok).toBe(true);
    expect(forge.created).toHaveLength(1);
    expect((await checkpoint(create.checkpoint)).resolution?.assurance).toBe("chat_unverified");
  });

  it("keep the proof of the hook at the strict level, the terminal answering otherwise", async () => {
    const { requested, approve, forge } = await product({ hooked: false, mode: "strict" });
    const create = await requested(CREATE);
    const refused = await approve(create.checkpoint);
    expect(code(refused)).toBe(ErrorCode.REVIEW_REQUIRED);
    expect(details(refused)).toMatchObject({ reason: "unverified_forge" });
    expect(forge.created).toEqual([]);
  });
});

describe("the pull request of the CI, read whole and against the remote (review)", () => {
  async function merging(files?: string[]) {
    const subject = await product(files === undefined ? {} : { files });
    subject.forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    subject.forge.branches.set("ci/base-workflows", CI_HEAD);
    subject.forge.remoteState.set("origin/main", { state: "same", head: HEAD });
    subject.forge.remoteState.set("origin/ci/base-workflows", { state: "same", head: CI_HEAD });
    return subject;
  }

  it("refuses a diff whose path it cannot read, instead of leaving it out", async () => {
    for (const odd of ["a".repeat(501), "docs\\evil.md", "has space.md", 'quote".md']) {
      const subject = await merging([".github/workflows/ci.yml", odd]);
      expect(details(await subject.request(MERGE)), odd.slice(0, 20)).toMatchObject({
        reason: "diff_unreadable",
      });
    }
  });

  it("never lets the architecture through with the CI: it feeds the planned dependencies", async () => {
    const subject = await merging([
      ".github/workflows/ci.yml",
      ".agentplugged/docs/architecture.md",
    ]);
    expect(details(await subject.request(MERGE))).toMatchObject({ reason: "not_ci_change" });
  });

  it("shows the files it will merge in the point the creator confirms", async () => {
    const subject = await merging([".github/workflows/ci.yml", ".agentplugged/docs/runbook.md"]);
    const asked = await subject.requested(MERGE);
    const point = await subject.checkpoint(asked.checkpoint);
    expect(point.summary).toContain(".github/workflows/ci.yml, .agentplugged/docs/runbook.md");
    expect(point.creator_action).toMatchObject({
      files: [".github/workflows/ci.yml", ".agentplugged/docs/runbook.md"],
    });
  });

  it("needs the main branch at the remote to be the local one the diff is read against", async () => {
    const subject = await merging();
    subject.forge.remoteState.set("origin/main", { state: "behind", head: "b".repeat(40) });
    expect(details(await subject.request(MERGE))).toMatchObject({ reason: "main_not_pushed" });
  });

  it("refuses a pull request that merges into another branch than the main branch", async () => {
    const subject = await merging();
    subject.forge.pullRequestList = [
      {
        number: 3,
        url: "https://github.com/ada/shop/pull/3",
        state: "open",
        title: "CI",
        body: "",
      },
    ];
    subject.forge.pr = { state: "open", head: CI_HEAD, merge_commit: null, base: "release" };
    const refused = await subject.request(MERGE);
    expect(code(refused)).toBe(ErrorCode.CREATOR_ACTION_STALE);
    subject.forge.pr = { state: "open", head: CI_HEAD, merge_commit: null, base: null };
    expect(code(await subject.request(MERGE))).toBe(ErrorCode.CREATOR_ACTION_STALE);
    expect(subject.forge.merged).toEqual([]);
  });

  it("finds the merge already done even when the forge deleted the branch", async () => {
    const subject = await merging();
    const asked = await subject.requested(MERGE);
    // The creator approved; between the request and the answer the pull request was merged and
    // its branch deleted: asking again finds it done, nothing is opened nor merged twice.
    subject.forge.branches.delete("ci/base-workflows");
    subject.forge.remoteState.set("origin/ci/base-workflows", { state: "missing" });
    subject.forge.pullRequestList = [
      {
        number: 3,
        url: "https://github.com/ada/shop/pull/3",
        state: "merged",
        title: "CI",
        body: "",
      },
    ];
    subject.forge.pr = {
      state: "merged",
      head: CI_HEAD,
      merge_commit: "m".repeat(40),
      base: "main",
    };
    const result = await subject.approve(asked.checkpoint);
    // Already done: nothing to approve (as for a gesture done by hand), nothing done twice.
    expect(code(result)).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
    expect(subject.forge.opened).toEqual([]);
    expect(subject.forge.merged).toEqual([]);
  });
});

describe("what a pull request merged elsewhere proves (second review)", () => {
  it("is not the CI delivered when it was merged into another branch than the main branch", async () => {
    const { request, forge } = await product();
    forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    forge.branches.set("ci/base-workflows", CI_HEAD);
    forge.remoteState.set("origin/main", { state: "same", head: HEAD });
    forge.remoteState.set("origin/ci/base-workflows", { state: "same", head: CI_HEAD });
    forge.pullRequestList = [
      {
        number: 3,
        url: "https://github.com/ada/shop/pull/3",
        state: "merged",
        title: "CI",
        body: "",
      },
    ];
    forge.pr = { state: "merged", head: CI_HEAD, merge_commit: "m".repeat(40), base: "release" };
    // Not « already »: the main branch does not hold the CI, a new request is possible.
    expect((await request(MERGE)).ok).toBe(true);
  });
});

describe("a repository name already taken (review)", () => {
  it("says the name is taken, not that origin exists", async () => {
    const { requested, approve, forge } = await product();
    const asked = await requested(CREATE);
    forge.createOutcome = { ok: false, reason: "exists", message: "name already exists" };
    const result = await approve(asked.checkpoint);
    expect(code(result)).toBe(ErrorCode.CREATOR_ACTION_FAILED);
    expect(details(result)).toMatchObject({ reason: "name_taken" });
  });
});

describe("the events that open a gesture's request", () => {
  it("are version 14 of checkpoint.opened, and creator_action.executed at version 12", async () => {
    const { requested, journal } = await product();
    await requested(CREATE);
    const opened = (await journal.list()).events.find(
      (event) => event.type === "checkpoint.opened",
    );
    expect(opened?.v).toBe(14);
    expect(await journalIsReadable(journal)).toBe(true);
    const recorded: RecordedEvent | undefined = undefined;
    expect(recorded).toBeUndefined();
  });
});

async function journalIsReadable(journal: MemoryStateStore): Promise<boolean> {
  return (await computeProjection((await journal.list()).events)).ignored.length === 0;
}

describe("the release: staging into production", () => {
  const DEV = "d".repeat(40);
  const RELEASE = { kind: "release" };
  const STAGED = {
    integration: "dev",
    production: "main",
    story_branches: true,
    ci: "remote",
    merge: "pr",
    review: true,
  } as const;

  async function staged(merge: "pr" | "direct" = "pr") {
    const p = await product();
    await recordGitWorkflow(
      p.human,
      { workflow: { ...STAGED, merge }, previous: undefined },
      "terminal",
    );
    p.forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    p.forge.branches.set("dev", DEV);
    p.forge.branches.set("main", HEAD);
    p.forge.remoteState.set("origin/main", { state: "same", head: HEAD });
    p.forge.remoteState.set("origin/dev", { state: "same", head: DEV });
    p.forge.pr = { state: "open", head: DEV, merge_commit: null, base: "main" };
    return p;
  }

  it("is a high risk the engine sets, naming the branches and the commit", async () => {
    const { requested, checkpoint } = await staged();
    const asked = await requested(RELEASE);
    expect(asked).toMatchObject({ risk: "high", irreversible: false });
    const point = await checkpoint(asked.checkpoint);
    expect(point.title).toBe("Put into production: merge dev into main (0 stories)");
    expect(point.summary).toContain(DEV.slice(0, 12));
    expect(point.creator_action).toMatchObject({
      kind: "release",
      from: "dev",
      to: "main",
      commit: DEV,
    });
  });

  it("opens the pull request from staging into production and merges it on one answer, then records the release", async () => {
    const { requested, approve, forge, journal } = await staged();
    const asked = await requested(RELEASE);
    const result = await approve(asked.checkpoint);
    expect(result.ok ? undefined : JSON.stringify(details(result))).toBeUndefined();
    expect((result as { value: AnswerRecorded }).value.executed).toMatchObject({
      kind: "release",
      gesture: { status: "done", pr: 7, branch: "main", commit: DEV },
    });
    expect(forge.opened).toEqual([expect.objectContaining({ base: "main", branch: "dev" })]);
    expect(forge.merged).toEqual([{ commit: DEV, method: "merge" }]);
    const released = journal.events.find((event) => event.type === "git.released");
    expect(released?.payload).toMatchObject({
      from: "dev",
      to: "main",
      commit: DEV,
      via: "pr",
      pr: 7,
    });
  });

  it("is refused without a staging branch", async () => {
    const plain = await product();
    plain.forge.remotes = [{ name: "origin", url: URL_ORIGIN }];
    expect(details(await plain.request(RELEASE))).toMatchObject({ reason: "not_staged" });
  });

  it("merges by itself, in the repository, when the workflow has no pull request", async () => {
    const { requested, approve, forge, merges, journal } = await staged("direct");
    const asked = await requested(RELEASE);
    const result = await approve(asked.checkpoint);
    expect(result.ok).toBe(true);
    expect(merges).toEqual([
      expect.objectContaining({ from: "dev", into: "main", expect: DEV, method: "merge" }),
    ]);
    expect(forge.opened).toEqual([]);
    const released = journal.events.find((event) => event.type === "git.released");
    expect(released?.payload).toMatchObject({ via: "direct", merge_commit: "e".repeat(40) });
    expect(released?.payload).not.toHaveProperty("pr");
  });
});
