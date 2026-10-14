import { toBase64url } from "@agentplugged/crypto";
import { ErrorCode, SESSION_EVENT_TYPES } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentPluggedError,
  AgentSession,
  type AgentStateView,
  type CheckpointState,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  DEFAULT_RULES,
  type ExternalReadEntry,
  gateDecision,
  initCommand,
  type MainBranchReader,
  MemoryKeyStore,
  MemoryStateStore,
  type RecordedEvent,
  type RequestActionResult,
  readSource,
  resolveProfile,
  type StateStore,
  type ToolProbe,
} from "../index.js";
import { hookValue } from "../sync/trust-hooks.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { commandMatches, engineCommandOnly, subcommands } from "./command-match.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(9));
const CONFIG = ".agentplugged/method.yaml";
const HOUR = 60 * 60 * 1000;

/** A clock that moves one second per call, and can jump. */
function clock() {
  let now = Date.UTC(2026, 9, 3, 12, 0, 0);
  const tick = () => {
    now += 1000;
    return now;
  };
  tick.jump = (ms: number) => {
    now += ms;
  };
  return tick;
}

type HookDecision = {
  hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string };
};

/**
 * A product, the creator's context, and an agent's context in one session of an AI tool.
 * `mainBranch`: a main branch of that name holding the working copy's `method.yaml`.
 * `installs`: the creator's installs mode (visible by default).
 */
async function product(
  rules = "",
  options: { mainBranch?: string; installs?: "validate" | "visible" } = {},
) {
  const files = new MemoryFiles();
  const now = clock();
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now });
  const reader: MainBranchReader | undefined =
    options.mainBranch === undefined
      ? undefined
      : {
          read: async (path) => ({
            found: true,
            branch: options.mainBranch as string,
            text: files.files.get(path),
          }),
        };
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    human: { keys },
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  if (options.installs !== undefined) {
    files.seed(CONFIG, `${files.files.get(CONFIG) ?? ""}installs:\n  mode: ${options.installs}\n`);
  }
  if (rules !== "") files.seed(CONFIG, `${files.files.get(CONFIG) ?? ""}rules:\n${rules}`);
  const registry = createCommandRegistry();
  const inSession = (
    session: AgentSession | undefined,
    store: StateStore = journal,
  ): CommandContext => ({
    ...human,
    actor: "agent",
    human: undefined,
    interactive: false,
    journal: store,
    ...(reader === undefined ? {} : { mainBranch: reader }),
    ...(session === undefined ? {} : { session }),
  });
  const session = new AgentSession(now());
  const agent = inSession(session);
  const call = async <T>(name: string, input: Record<string, unknown>, context = agent) => {
    const result = await registry.run(name, context, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
    return result.value as T;
  };
  const approve = async (checkpoint: string, decision = "approved") => {
    const result = await registry.run("review", human, {
      action: "resolve",
      checkpoint,
      decision,
      ...(decision === "approved" ? {} : { note: "No." }),
    });
    if (!result.ok) throw new Error(`review failed: ${result.error.code}`);
  };
  const projection = async () => {
    const listing = await journal.list();
    return computeProjection(listing.events, { problems: listing.problems });
  };
  return {
    files,
    journal,
    now,
    registry,
    human,
    session,
    agent,
    inSession,
    call,
    approve,
    projection,
  };
}

/** A journal whose `method` fails with `JOURNAL_BUSY`; everything else goes to `journal`. */
function failing(journal: StateStore, method: "append" | "list" | "appendAll"): StateStore {
  return new Proxy(journal, {
    get(target, property) {
      if (property === method) {
        return async () => {
          throw new AgentPluggedError(ErrorCode.JOURNAL_BUSY, "error.journal_busy", {});
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const INSTALL = {
  agent: "iris",
  action: "install_dependency",
  detail: "npm  install left-pad",
  story: "2-6",
};

describe("a session that read external content (a trace, never a block)", () => {
  it("starts trusted, internet allowed by default, whatever the agent declares", async () => {
    const { call, journal } = await product();
    await call<RecordedEvent>("report_status", { agent: "iris", status: "working" });
    expect(journal.events.at(-1)?.provenance).toBe("trusted");
    const view = await call<AgentStateView>("get_state", { full: true });
    expect(view.session).toEqual({ trusted: true, reads: [] });
    expect(view.external_reads).toEqual({ total: 0, recent: [] });
    expect(DEFAULT_RULES.internet).toBe("allow");
  });

  it("is untrusted without a session (a direct call), by caution", async () => {
    const { call, inSession, journal } = await product();
    const direct = inSession(undefined);
    await call<RecordedEvent>("report_status", { agent: "iris", status: "working" }, direct);
    expect(journal.events.at(-1)?.provenance).toBe("untrusted");
  });

  it("is marked at its first external read, which the journal and the state show", async () => {
    const { call, journal, projection } = await product();
    await call("record_external_read", {
      tool: "WebFetch",
      source: "https://user@Evil.Example:8443/page?q=1",
      session: "s-1",
    });
    const read = journal.events.at(-1);
    expect(read?.type).toBe(SESSION_EVENT_TYPES.externalRead);
    expect(read?.provenance).toBe("untrusted");
    expect(read?.actor).toMatchObject({ kind: "agent", agent: "main" });
    expect(read?.payload).toEqual({
      tool: "WebFetch",
      source: "evil.example:8443",
      session: "s-1",
    });
    // The same read again is not written twice.
    const count = journal.events.length;
    await call("record_external_read", { tool: "WebFetch", source: "https://evil.example:8443/" });
    expect(journal.events).toHaveLength(count);

    await call<RecordedEvent>("report_status", { agent: "iris", status: "working" });
    expect(journal.events.at(-1)?.provenance).toBe("untrusted");
    const view = await call<AgentStateView>("get_state", { full: true });
    expect(view.session).toEqual({
      trusted: false,
      reads: [{ tool: "WebFetch", source: "evil.example:8443" }],
    });
    // The history: who read, when, from what.
    expect(view.external_reads).toEqual({
      total: 1,
      recent: [
        {
          tool: "WebFetch",
          source: "evil.example:8443",
          agent: "main",
          at: read?.at,
        },
      ],
    });
    const { state } = await projection();
    expect(state.external_reads as ExternalReadEntry[]).toMatchObject([
      { tool: "WebFetch", source: "evil.example:8443", session: "s-1", agent: "main" },
    ]);
  });

  it("blocks nothing: the actions of the session proceed, and no checkpoint opens for what it read", async () => {
    const { call, journal } = await product("  destructive_command: ask\n");
    await call("record_external_read", { tool: "WebFetch", source: "https://evil.example/" });
    const count = journal.events.length;
    for (const action of [
      { action: "install_dependency", detail: "npm install left-pad" },
      { action: "destructive_command", detail: "rm -rf build" },
      { action: "deploy", detail: "deploy the site" },
      { action: "other", detail: "send the report" },
    ]) {
      expect(
        await call<RequestActionResult>("request_action", { agent: "iris", ...action }),
        action.action,
      ).toEqual({ decision: "proceed", reason: "allowed" });
    }
    expect(
      await call("check_action", { action: "install_dependency", command: "npm i x" }),
    ).toEqual({});
    // Nothing waits: the only events written are the records of the two installations.
    expect(journal.events.slice(count).map((event) => event.type)).toEqual([
      "install.recorded",
      "install.recorded",
    ]);
  });

  it("joins a read to the session only once it is written", async () => {
    const { call, registry, inSession, journal, session } = await product();
    const broken = inSession(session, failing(journal, "append"));
    const refused = await registry.run("record_external_read", broken, {
      tool: "WebFetch",
      source: "https://evil.example/",
    });
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.JOURNAL_BUSY);
    expect(session.reads).toEqual([]);
    // The next hook records it.
    await call("record_external_read", { tool: "WebFetch", source: "https://evil.example/" });
    expect(session.reads).toEqual([{ tool: "WebFetch", source: "evil.example" }]);
    expect(journal.events.at(-1)?.type).toBe(SESSION_EVENT_TYPES.externalRead);
  });

  it("writes a read once without a session either, from the journal", async () => {
    const { call, inSession, journal } = await product();
    const direct = inSession(undefined);
    const read = { tool: "Bash", source: "curl -s https://api.example.com/x", session: "s-3" };
    await call("record_external_read", read, direct);
    const count = journal.events.length;
    await call("record_external_read", read, direct);
    expect(journal.events).toHaveLength(count);
    expect(journal.events.at(-1)?.payload).toEqual({
      tool: "Bash",
      source: "api.example.com",
      session: "s-3",
    });
  });

  it("a local write or read is no external read; a real network read still is", async () => {
    const { call, journal, session } = await product();
    const count = journal.events.length;
    const local = [
      "cat > \"C:/scratchpad/c.js\" <<'EOF'\nconst x = 1;\ngh api repos/x/y\ncurl https://x.example\nEOF",
      "sed -n 60,80p docs/architecture.md",
      'grep -rn "curl|wget" docs/',
      "echo ok > out.txt",
    ];
    for (const source of local) {
      await call("record_external_read", { tool: "Bash", source, session: "s-local" });
    }
    expect(journal.events).toHaveLength(count);
    expect(session.reads).toEqual([]);
    const view = await call<AgentStateView>("get_state", { full: true });
    expect(view.session.trusted).toBe(true);
    // Real reads, a URL given as the source, and a read nothing tells apart still count.
    await call("record_external_read", {
      tool: "Bash",
      source: "cat urls.txt | curl -d @- https://api.example.com/x",
      session: "s-local",
    });
    await call("record_external_read", { tool: "Bash", source: "gh pr view 3 --comments" });
    await call("record_external_read", { tool: "Bash", source: "https://other.example/page" });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the value a hook could not substitute
    await call("record_external_read", { tool: "Bash", source: "${tool_input.command}" });
    await call("record_external_read", { tool: "Bash" });
    expect(session.reads).toEqual([
      { tool: "Bash", source: "api.example.com" },
      { tool: "Bash", source: "gh pr" },
      { tool: "Bash", source: "other.example" },
      { tool: "Bash", source: "Bash" },
    ]);
  });

  it("finds its reads in the journal after the server restarts, and stamps the provenance of what it writes", async () => {
    const { call, inSession, journal } = await product();
    await call("record_external_read", { tool: "mcp__github__get_issue", session: "s-9" });
    const restarted = inSession(new AgentSession());
    const fresh = await call<AgentStateView>("get_state", { full: true }, restarted);
    expect(fresh.session.trusted).toBe(true);
    // A hook names the session: its reads count again, for the provenance only.
    const answer = await call<HookDecision>(
      "check_action",
      { action: "install_dependency", command: "npm install x", session: "s-9" },
      restarted,
    );
    expect(answer).toEqual({});
    await call<RecordedEvent>("report_status", { agent: "iris", status: "working" }, restarted);
    expect(journal.events.at(-1)?.provenance).toBe("untrusted");
    await call<RecordedEvent>(
      "open_checkpoint",
      { agent: "iris", type: "release", risk: "high", title: "R", summary: "S", story: "2-6" },
      restarted,
    );
    // The checkpoint carries the provenance of the event, no mark of why.
    expect(journal.events.at(-1)?.provenance).toBe("untrusted");
    expect(journal.events.at(-1)?.payload).not.toHaveProperty("untrusted");
  });

  it("opens a checkpoint like any session's: no mark, no wait", async () => {
    const { call, journal } = await product();
    await call("record_external_read", { tool: "WebFetch", source: "https://evil.example/" });
    await call<RecordedEvent>("open_checkpoint", {
      agent: "iris",
      type: "release",
      risk: "high",
      title: "Release 1.0",
      summary: "Ship it.",
      story: "2-6",
    });
    const opened = journal.events.at(-1);
    expect(opened?.provenance).toBe("untrusted");
    expect(opened?.payload).not.toHaveProperty("untrusted");
    const view = await call<AgentStateView>("get_state", { full: true });
    const checkpoint = Object.values(view.checkpoints)[0] as CheckpointState;
    expect(checkpoint.untrusted).toBeNull();
    expect(checkpoint.provenance).toBe("untrusted");
  });

  it("refuses an input that is not one", async () => {
    const { registry, agent } = await product();
    const refused = await registry.run("request_action", agent, { ...INSTALL, action: "dance" });
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    const unknown = await registry.run("request_action", agent, { ...INSTALL, agent: "ghost" });
    expect(unknown.ok ? undefined : unknown.error.code).toBe(ErrorCode.AGENT_NOT_FOUND);
  });
});

describe("gate of high-risk actions", () => {
  it("lets everything through by default, refuses what a deny rule forbids", async () => {
    const { call, journal } = await product();
    // The installations are recorded in the activity (visible mode), nothing is asked.
    expect(await call<RequestActionResult>("request_action", INSTALL)).toEqual({
      decision: "proceed",
      reason: "allowed",
    });
    const count = journal.events.length;
    // A mass deletion and a push to the main branch are denied by the rules in force.
    expect(
      await call<RequestActionResult>("request_action", {
        agent: "iris",
        action: "destructive_command",
        detail: "rm -rf ~",
      }),
    ).toEqual({ decision: "refused", reason: "rule_deny" });
    expect(
      await call<RequestActionResult>("request_action", {
        agent: "iris",
        action: "push_main",
        detail: "git push origin main",
      }),
    ).toEqual({ decision: "refused", reason: "rule_deny" });
    expect(journal.events).toHaveLength(count);
  });

  it("opens a checkpoint for an installation only when the creator validates them, then waits until they approve", async () => {
    const { call, journal, approve, session } = await product("", { installs: "validate" });
    const first = await call<RequestActionResult>("request_action", INSTALL);
    expect(first).toMatchObject({ decision: "wait", reason: "open" });
    const id = first.checkpoint as string;
    expect(id).toMatch(/^G-/);
    const opened = journal.events.at(-1);
    expect(opened?.actor).toMatchObject({ kind: "agent", agent: "iris" });
    expect(opened?.story).toBe("2-6");
    expect(opened?.payload).toMatchObject({
      type: "permission",
      risk: "high",
      irreversible: false,
      recipient_role: "security",
      confirmation: ["presence"],
      source: "untrusted_action",
      request: {
        action: "install_dependency",
        detail: "npm install left-pad",
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        sessions: [session.instance],
      },
      blocks: [{ action: "permission.use", story: "2-6" }],
      title: "Install a dependency: npm install left-pad",
    });
    expect(opened?.payload).not.toHaveProperty("untrusted");

    const count = journal.events.length;
    const again = await call<RequestActionResult>("request_action", {
      ...INSTALL,
      detail: " npm install   left-pad ",
    });
    expect(again).toMatchObject({ decision: "wait", checkpoint: id });
    expect(journal.events).toHaveLength(count);

    await approve(id);
    const approved = await call<RequestActionResult>("request_action", INSTALL);
    expect(approved).toEqual({ decision: "proceed", reason: "approved", checkpoint: id });
  });

  it("holds an approval for the same session only, for the story, and for one hour without one", async () => {
    const { call, approve, inSession, now } = await product("", { installs: "validate" });
    const first = await call<RequestActionResult>("request_action", INSTALL);
    await approve(first.checkpoint as string);
    // Another session asks the same: a checkpoint of its own.
    const other = inSession(new AgentSession());
    const elsewhere = await call<RequestActionResult>("request_action", INSTALL, other);
    expect(elsewhere.decision).toBe("wait");
    expect(elsewhere.checkpoint).not.toBe(first.checkpoint);
    // Past the hour, an installation approved for its story still holds (the family of
    // the action is validated once for the story).
    now.jump(HOUR);
    const later = await call<RequestActionResult>("request_action", INSTALL);
    expect(later).toMatchObject({ decision: "proceed", reason: "approved" });
    // Without a story, the approval holds for one hour only.
    const nameless = { agent: "iris", action: "install_dependency", detail: "npm install zod" };
    const named = await call<RequestActionResult>("request_action", nameless);
    await approve(named.checkpoint as string);
    now.jump(HOUR);
    const again = await call<RequestActionResult>("request_action", nameless);
    expect(again.decision).toBe("wait");
    expect(again.checkpoint).not.toBe(named.checkpoint);
  });

  it("refuses what the creator refused or sent back", async () => {
    const { call, approve } = await product("", { installs: "validate" });
    const asked = await call<RequestActionResult>("request_action", INSTALL);
    await approve(asked.checkpoint as string, "rejected");
    expect(await call<RequestActionResult>("request_action", INSTALL)).toMatchObject({
      decision: "refused",
      reason: "rejected",
    });
    const clean = { ...INSTALL, detail: "npm install lodash" };
    const second = await call<RequestActionResult>("request_action", clean);
    await approve(second.checkpoint as string, "changes_requested");
    expect(await call<RequestActionResult>("request_action", clean)).toMatchObject({
      decision: "refused",
      reason: "rejected",
    });
  });

  it("identifies a request by its whole text, and cuts what it shows without splitting emoji", async () => {
    const { call, journal } = await product("", { installs: "validate" });
    const long = `npm install ${"🚀".repeat(300)}`;
    const first = await call<RequestActionResult>("request_action", {
      agent: "iris",
      action: "install_dependency",
      detail: `${long} a`,
    });
    const payload = journal.events.at(-1)?.payload as {
      title: string;
      request: { detail: string };
    };
    for (const text of [payload.title, payload.request.detail]) {
      expect(text.length).toBeLessThanOrEqual(500);
      expect(text.endsWith("…")).toBe(true);
      expect(text.isWellFormed()).toBe(true);
    }
    const second = await call<RequestActionResult>("request_action", {
      agent: "iris",
      action: "install_dependency",
      detail: `${long} b`,
    });
    expect(second.checkpoint).not.toBe(first.checkpoint);
  });

  it("answers Claude Code's hook: a denial naming the checkpoint, then nothing once approved", async () => {
    const { call, approve, journal } = await product("", { installs: "validate" });
    const hook = { action: "install_dependency", command: "pnpm add zod", session: "s-2" };
    const denied = await call<HookDecision>("check_action", hook);
    expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
    const opened = journal.events.at(-1);
    expect(opened?.actor).toMatchObject({ kind: "agent", agent: "main" });
    const id = `G-${opened?.id.slice(-10)}`;
    expect(denied.hookSpecificOutput?.permissionDecisionReason).toContain(
      `checkpoint ${id} waits for their answer in the chat`,
    );
    await approve(id);
    expect(await call("check_action", hook)).toEqual({});
  });

  it("lets the command through once its request_action was approved, whatever the story", async () => {
    const { call, approve, journal } = await product("", { installs: "validate" });
    const asked = await call<RequestActionResult>("request_action", INSTALL);
    await approve(asked.checkpoint as string);
    const count = journal.events.length;
    const hook = { action: "install_dependency", command: "npm install  left-pad", session: "s-4" };
    expect(await call("check_action", hook)).toEqual({});
    expect(journal.events).toHaveLength(count);
  });

  it("fails closed when it cannot check the command", async () => {
    const { call, registry, inSession, journal, session } = await product("", {
      installs: "validate",
    });
    const busy = inSession(session, failing(journal, "list"));
    const answer = await registry.run("check_action", busy, {
      action: "install_dependency",
      command: "npm install x",
    });
    expect(answer.ok).toBe(true);
    expect((answer as { value: HookDecision }).value.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "AgentPlugged n'a pas pu vérifier cette commande (JOURNAL_BUSY) ; réessaie.",
    });
    const locked = inSession(session, failing(journal, "appendAll"));
    const closed = await call<HookDecision>(
      "check_action",
      { action: "install_dependency", command: "npm install y" },
      locked,
    );
    expect(closed.hookSpecificOutput?.permissionDecisionReason).toContain("(JOURNAL_BUSY)");
    const invalid = await call<HookDecision>("check_action", { action: "dance", command: "x" });
    expect(invalid.hookSpecificOutput?.permissionDecisionReason).toContain("(INVALID_ARGUMENTS)");
  });

  it("checks the command again: a harmless one or the engine's own opens nothing", async () => {
    const { call, journal } = await product("", { installs: "validate" });
    const count = journal.events.length;
    for (const command of [
      "git status",
      "npx agentplugged docs check",
      "npx -y agentplugged@1.0.0 next && pnpm dlx agentplugged docs check",
    ]) {
      expect(await call("check_action", { action: "install_dependency", command })).toEqual({});
    }
    expect(journal.events).toHaveLength(count);
    const exempt = await call<RequestActionResult>("request_action", {
      agent: "iris",
      action: "install_dependency",
      detail: "npx agentplugged docs check",
    });
    expect(exempt).toMatchObject({ decision: "proceed", reason: "exempt" });
    // A line that also runs another program is read as an installation of its own.
    const answer = await call<HookDecision>("check_action", {
      action: "install_dependency",
      command: "npx agentplugged docs check; npx left-pad",
    });
    expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("splits commands as Claude Code does", () => {
    expect(subcommands("A=1 B='x y' npm i x; echo ok | tee log & ls\nC=\"q r\" pwd")).toEqual([
      "npm i x",
      "echo ok",
      "tee log",
      "ls",
      "pwd",
    ]);
    expect(engineCommandOnly("bunx agentplugged next")).toBe(true);
    expect(engineCommandOnly("npx agentplugged-evil x")).toBe(false);
    expect(engineCommandOnly("")).toBe(false);
  });

  it("matches the main branch sync wrote the hooks with", async () => {
    expect(commandMatches("push_main", "git push origin trunk", "trunk")).toBe(true);
    expect(commandMatches("push_main", "git push origin trunk")).toBe(false);
    // push_main is locked to deny (it can never be ask): the gate refuses it before anything.
    const { call, journal } = await product("  push_main: ask\n", { mainBranch: "trunk" });
    const count = journal.events.length;
    const answer = await call<HookDecision>("check_action", {
      action: "push_main",
      command: "git push origin trunk",
    });
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toBe(
      "AgentPlugged: the permission rules deny this action.",
    );
    expect(journal.events).toHaveLength(count);
  });

  it("lets the hook of an installation through by default, and records it in the activity", async () => {
    const { call, journal } = await product();
    const count = journal.events.length;
    const answer = await call("check_action", {
      action: "install_dependency",
      command: "npm install x",
    });
    expect(answer).toEqual({});
    expect(journal.events.slice(count).map((event) => event.type)).toEqual(["install.recorded"]);
  });

  it("decides in order: engine command, deny rule, then proceeds unless the creator validates installations", () => {
    const request = { action: "install_dependency" as const, detail: "npm i x", story: undefined };
    const rules = { ...DEFAULT_RULES, install_dependency: "deny" as const };
    const identities = ["server:a"];
    expect(
      gateDecision({ request, trust: { rules, identities }, checkpoints: [], now: 0 }),
    ).toEqual({ kind: "refused", reason: "rule_deny" });
    expect(
      gateDecision({
        request: { ...request, detail: "npx agentplugged sync" },
        trust: { rules, identities },
        checkpoints: [],
        now: 0,
      }),
    ).toEqual({ kind: "proceed", reason: "exempt" });
    expect(
      gateDecision({
        request,
        trust: { rules: DEFAULT_RULES, identities },
        checkpoints: [],
        now: 0,
      }),
    ).toEqual({ kind: "proceed", reason: "allowed" });
    expect(
      gateDecision({
        request,
        trust: { rules: DEFAULT_RULES, identities },
        checkpoints: [],
        now: 0,
        install: { mode: "validate", planned: false },
      }),
    ).toEqual({ kind: "open" });
  });
});

describe("readSource", () => {
  it("keeps the host of a URL, a server for another MCP tool, and never a search query", () => {
    expect(readSource("WebFetch", "https://docs.example.com/a?b")).toEqual({
      tool: "WebFetch",
      source: "docs.example.com",
    });
    expect(readSource("WebFetch", hookValue("tool_input.url"))).toEqual({
      tool: "WebFetch",
      source: "WebFetch",
    });
    expect(readSource("WebSearch", "secret query")).toEqual({
      tool: "WebSearch",
      source: "web search",
    });
    expect(readSource("mcp__slack__read_channel", "")).toEqual({
      tool: "mcp__slack__read_channel",
      source: "slack (MCP: read_channel)",
    });
    expect(readSource("Bash", "gh issue view 4 --comments")).toEqual({
      tool: "Bash",
      source: "gh issue",
    });
    expect(readSource("Bash", "git clone 'https://git.example.org/x.git'")).toEqual({
      tool: "Bash",
      source: "git.example.org",
    });
    expect(readSource("Comment", "issue #4\u001b[31m")).toEqual({
      tool: "Comment",
      source: "issue #4 [31m",
    });
    const long = readSource("Comment", "😀".repeat(150)).source;
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.isWellFormed()).toBe(true);
  });
});

describe("what the installations leave in the journal", () => {
  it("records an installation the engine cannot read too: nothing is installed out of sight", async () => {
    const { call, journal } = await product();
    const count = journal.events.length;
    const answer = await call("check_action", {
      action: "install_dependency",
      command: "npm install github:someone/some-repo",
      session: "s-u",
    });
    expect(answer).toEqual({});
    const recorded = journal.events.slice(count);
    expect(recorded.map((event) => event.type)).toEqual(["install.recorded"]);
    expect(recorded[0]?.payload).toMatchObject({
      ecosystem: "other",
      manager: "npm",
      planned: false,
      unreadable: true,
    });
  });

  it("never refuses an installation because the gate could not check it, unless the creator validates them", async () => {
    const open = await product();
    const busy = open.inSession(open.session, failing(open.journal, "list"));
    const free = await open.call<HookDecision>(
      "check_action",
      { action: "install_dependency", command: "npm install x" },
      busy,
    );
    expect(free).toEqual({});
    const strict = await product("", { installs: "validate" });
    const busyStrict = strict.inSession(strict.session, failing(strict.journal, "list"));
    const closed = await strict.call<HookDecision>(
      "check_action",
      { action: "install_dependency", command: "npm install x" },
      busyStrict,
    );
    expect(closed.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});
