import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitStateStore, NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  agentActivityCommands,
  type Command,
  type CommandContext,
  CommandRegistry,
  createCommandRegistry,
  defineCommand,
  exposedCommands,
  initCommand,
  MemoryKeyStore,
  resolveProfile,
  type StateStore,
  TOOL_GROUPS,
  type ToolProbe,
  toolCallOf,
  toolInputOf,
} from "@agentplugged/core";
import { toBase64url } from "@agentplugged/crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./__helpers__/legacy-calls.js";
import { MCP_SERVER_NAME, runAgentServer } from "./index.js";

// Real temporary repositories: slower than vitest's 5 s default.
vi.setConfig({ testTimeout: 120_000 });

const SEED = toBase64url(new Uint8Array(32).fill(5));
const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};
/** The most a tool description may hold (Claude Code cuts at 2048). */
const MAX_TOOL_DESCRIPTION_LENGTH = 400;
const WHITELIST = [
  "agent",
  "chat",
  "checkpoint",
  "guard",
  "measure",
  "memory",
  "plan",
  "review",
  "state",
  "story",
];

/** Runs git in a test repository; never in this one, never on the network. */
function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const saved: Record<string, string | undefined> = {};
let isolated: string;
let cwd: string;
let journal: GitStateStore;
let client: Client;
let served: Promise<void>;
let errors: Error[];
/** The context the server runs every call with. */
let baseContext: Omit<CommandContext, "actor">;

beforeAll(async () => {
  isolated = await mkdtemp(join(tmpdir(), "agentplugged-mcp-gitconfig-"));
  const global = join(isolated, "gitconfig");
  await writeFile(global, "");
  const env = {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: await realpath(tmpdir()),
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-mcp-"));
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.name", "Ada"]);
  git(cwd, ["config", "user.email", "ada@example.com"]);
  const files = new NodeWorkspaceFiles(cwd);
  const methodDir = dirname(
    createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
  );
  // The keychain: the machine key, and the product key `init` creates.
  const keys = new MemoryKeyStore(SEED);
  journal = new GitStateStore({
    cwd,
    keys,
    machineLockPath: join(isolated, "machine-key.lock"),
  });
  baseContext = {
    files,
    tools: NO_TOOL,
    method: new NodeWorkspaceFiles(methodDir),
    engineVersion: "1.0.0",
    journal,
    keys,
  };
  const init = await initCommand.run(
    { ...baseContext, actor: "human" },
    { profile: resolveProfile("new-product") },
  );
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  errors = [];
  served = runAgentServer({
    registry: createCommandRegistry(),
    context: baseContext,
    engineVersion: "1.0.0",
    errorText: (error) => `message of ${error.message_key}`,
    transport: serverSide,
    onerror: (error) => errors.push(error),
  });
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  await served;
  journal.close();
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
};

const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<ToolResult>;

describe("MCP server", () => {
  it("exposes no tool that publishes, sends a message or pays", async () => {
    const { tools } = await client.listTools();
    // The only tools whose name says "publish" act on a story's pull request, for its developer or
    // reviewers (the forge, with the engine's fixed text): none reaches a channel of the creator's.
    const FORGE = new Set(["review.publish"]);
    const VERBS = new Set([
      "publish",
      "send",
      "mail",
      "email",
      "message",
      "pay",
      "payment",
      "charge",
      "invoice",
      "post",
      "tweet",
      "deploy",
      "checkout",
      "purchase",
      "buy",
      "refund",
      "transfer",
    ]);
    // The tools are grouped: every action is named, with its tool, the same way.
    for (const [name, group] of Object.entries(TOOL_GROUPS)) {
      for (const action of Object.keys(group.actions)) {
        const called = `${name}.${action}`;
        if (FORGE.has(called)) continue;
        for (const word of `${name}_${action}`.split("_"))
          expect(VERBS.has(word), called).toBe(false);
      }
    }
    // No description tells an agent to publish, send or pay either, outside the forge tools
    // (a review posted on a story's pull request, the story's own pull request) and the checkpoint
    // actions that are recorded, never carried out (`publication.publish`, `release.deploy`).
    const SENDS =
      /\b(send (an? )?(email|mail|message)|post (on|to) (twitter|linkedin|social)|charge (the )?card|make a payment|pay for)\b/i;
    for (const tool of tools) {
      expect(tool.description ?? "", tool.name).not.toMatch(SENDS);
    }
    // No tool takes an address, a recipient, a channel or an amount.
    const FIELD =
      /^(cc|bcc|recipient|recipients|email|address|channel|webhook|url|amount|price|currency|card_number|payment_card|iban)$/i;
    for (const tool of tools) {
      for (const field of Object.keys(tool.inputSchema.properties ?? {})) {
        expect(field, `${tool.name}.${field}`).not.toMatch(FIELD);
      }
    }
    // The deliverables' commands are the creator's: `publication` is not an agents' tool.
    expect(tools.map((tool) => tool.name)).not.toContain("publication");
  });

  it("the registry of trusted devices is not an agents' tool: the list is unchanged, none writes a device event", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(WHITELIST);
    // No tool is named after a device or trust event, and none takes an event type to write.
    expect(
      tools.map((tool) => tool.name).filter((name) => /device|pair|trust|dismiss/.test(name)),
    ).toEqual([]);
    for (const tool of tools) {
      for (const field of Object.keys(tool.inputSchema.properties ?? {})) {
        expect(field, `${tool.name}.${field}`).not.toMatch(
          /^(event_type|type_of_event|device_event)$/,
        );
      }
    }
  });

  it("announces itself and lists exactly the agents' tools", async () => {
    expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(WHITELIST);
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      // Claude Code cuts a description past 2048 characters (the journal of its MCP
      // connection says "description truncated"): a rule beyond the cut is never read.
      expect((tool.description ?? "").length, tool.name).toBeLessThanOrEqual(
        MAX_TOOL_DESCRIPTION_LENGTH,
      );
      expect(tool.inputSchema.type, tool.name).toBe("object");
      // Lean: no `$schema`, no `additionalProperties`, no pattern; the engine
      // refuses an `actor` or any field outside the action's own, whatever the schema says.
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(
        /$schema|additionalProperties|pattern/,
      );
    }
    const agent = tools.find((tool) => tool.name === "agent");
    expect(Object.keys(agent?.inputSchema.properties ?? {}).sort()).toEqual([
      "action",
      "agent",
      "brief",
      "mode",
      "skill",
      "status",
      "story",
      "task",
      "to",
      "workshop",
    ]);
    expect(agent?.inputSchema.required).toEqual(["action"]);
  });

  it("answer_checkpoint: unverified without the hook, refused for Claude Code without a message", async () => {
    const decision = {
      agent: "iris",
      type: "decision",
      risk: "medium",
      title: "Pick a name",
      summary: "Which name?",
      options: [
        { id: "a", label: "A", consequence: "a" },
        { id: "b", label: "B", consequence: "b" },
      ],
      recommendation: "b",
    };
    // Claude Code (the client's name): the hook must have recorded the creator's message.
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const claudeServed = runAgentServer({
      registry: createCommandRegistry(),
      context: {
        ...baseContext,
        chat: { log: { messages: async () => [] } },
      },
      engineVersion: "1.0.0",
      errorText: (error) => `message of ${error.message_key}`,
      transport: serverSide,
    });
    const claude = new Client({ name: "claude-code", version: "2.1.300" });
    await claude.connect(clientSide);
    const opened = (await claude.callTool({
      name: "open_checkpoint",
      arguments: decision,
    })) as ToolResult;
    const id = opened.structuredContent?.checkpoint as string;
    const refused = (await claude.callTool({
      name: "answer_checkpoint",
      arguments: { agent: "iris", checkpoint: id, decision: "approved", quote: "ok", session: "s" },
    })) as ToolResult;
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: "CHAT_QUOTE_NOT_FOUND" });
    await claude.close();
    await claudeServed;

    // Another client (no hook): accepted, unverified.
    const answered = await call("answer_checkpoint", {
      agent: "iris",
      checkpoint: id,
      decision: "approved",
      quote: "ok",
    });
    expect(answered.isError).toBeFalsy();
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({
      checkpoints: { [id]: { status: "resolved", resolution: { assurance: "chat_unverified" } } },
      validation: { mode: "chat", proof: "unverified" },
    });
  });

  it("answers the state without what is empty, and says its hint once per session", async () => {
    const first = await call("get_state", {});
    expect(first.isError).toBeFalsy();
    const said = first.structuredContent ?? {};
    expect(said.more).toEqual(expect.stringContaining("This is a summary"));
    // The time of the engine in UTC, the idle agents and the empty lists are not sent.
    expect(said.clock).not.toHaveProperty("now");
    expect(said).not.toHaveProperty("agents_idle");
    expect(said).not.toHaveProperty("merged_order");
    expect(said).not.toHaveProperty("detail");
    const second = await call("get_state", {});
    expect(second.structuredContent).not.toHaveProperty("more");
    // The detail asked for is whole: nothing is cut from it.
    const full = await call("get_state", { full: true });
    expect(full.structuredContent).toHaveProperty("clock.now");
  });

  it("refuses a result whose summary is longer than the creator can read, and says where the rest goes", async () => {
    const refused = await call("submit_result", {
      agent: "iris",
      status: "complete",
      summary: "x".repeat(801),
      assumptions: [],
      open_questions: [],
      conflicts: [],
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("at most 800 characters");
    expect(JSON.stringify(refused)).toContain("story.progress notes");
    const accepted = await call("submit_result", {
      agent: "iris",
      status: "complete",
      summary: "x".repeat(800),
      assumptions: [],
      open_questions: [],
      conflicts: [],
    });
    expect(accepted.isError).toBeFalsy();
    expect(Object.keys(accepted.structuredContent ?? {})).toEqual(["id"]);
  });

  it("report_status writes a signed agent event, then get_state shows it", async () => {
    const reported = await call("report_status", {
      agent: "iris",
      status: "working",
      task: "brief",
    });
    expect(reported.isError).toBeFalsy();
    // A write answers with its identifier only: never the type nor the time of the event.
    expect(Object.keys(reported.structuredContent ?? {})).toEqual(["id"]);

    const listing = await journal.list();
    const event = listing.events.find((entry) => entry.type === "agent.status_reported");
    expect(event?.actor).toMatchObject({ kind: "agent", agent: "iris" });
    expect(event?.id).toBe(reported.structuredContent?.id);

    const state = await call("get_state", { full: true });
    expect(state.isError).toBeFalsy();
    expect(state.structuredContent).toMatchObject({
      agents: { iris: { status: "working", task: "brief", story: null } },
      journal_head: listing.head,
    });
    expect(JSON.parse(state.content[0]?.text ?? "{}")).toEqual(state.structuredContent);
    expect(errors).toEqual([]);
  });

  describe("grouped tools", () => {
    const raw = (result: unknown) => (result as { raw: Record<string, unknown> }).raw;

    it("publishes ten tools of at most 400 characters each, whose safety words are kept", async () => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(WHITELIST);
      expect(tools.length).toBeLessThanOrEqual(12);
      for (const tool of tools) {
        expect((tool.description ?? "").length, tool.name).toBeLessThanOrEqual(400);
        // The action the tool takes is listed in its description and in its schema.
        const actions = Object.keys(TOOL_GROUPS[tool.name]?.actions ?? {});
        const schemaActions = (
          tool.inputSchema.properties?.action as { enum?: string[] } | undefined
        )?.enum;
        expect(schemaActions, tool.name).toEqual(actions);
        for (const action of actions) expect(tool.description, tool.name).toContain(action);
      }
      const text = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
      // The prohibitions that stay in the agent's sight, whatever the reference says.
      expect(text("chat")).toMatch(/Never answer, reword or waive for the creator/);
      expect(text("checkpoint")).toMatch(/Never answer for the creator/);
      expect(text("story")).toMatch(/Never skip hooks or push the main branch/);
      expect(text("story")).toMatch(/never merge/);
      expect(text("review")).toMatch(/Never review a story you built/);
      expect(text("guard")).toMatch(/refused means never/);
      expect(text("guard")).toMatch(/never read salle\/ or memory\/ files directly/);
      expect(text("memory")).toMatch(
        /Never record or promote a lesson before the creator approved/,
      );
      expect(text("measure")).toMatch(/never invent an amount/);
    });

    it("costs at most 8 960 characters in tools/list, schemas included (about 8 900 as the client lists them)", async () => {
      const { tools } = await client.listTools();
      expect(JSON.stringify(tools).length).toBeLessThanOrEqual(8_960);
    });

    it("reaches every engine command through its tool and action, and no other tool does", async () => {
      const commands = createCommandRegistry()
        .agentCommands()
        .map((command) => command.name)
        .sort();
      // The table covers every agents' command, once, and names none that does not exist.
      expect(exposedCommands().sort()).toEqual(commands);
      const called = new Set<string>();
      for (const [name, group] of Object.entries(TOOL_GROUPS)) {
        for (const [action, spec] of Object.entries(group.actions)) {
          expect(called.has(spec.command), spec.command).toBe(false);
          called.add(spec.command);
          expect(toolCallOf(spec.command)).toEqual({ tool: name, action });
          expect(toolInputOf(spec.command, { agent: "iris" })).toEqual({
            tool: name,
            input: { action, agent: "iris" },
          });
        }
      }
    });

    it("refuses an unknown or missing action, and runs nothing", async () => {
      const before = await journal.head();
      for (const args of [
        {},
        { action: "nope" },
        { action: 3 },
        { agent: "iris", status: "idle" },
      ]) {
        const result = (await client.callTool({ name: "agent", arguments: args })) as ToolResult;
        expect(result.isError, JSON.stringify(args)).toBe(true);
        expect(result.content[0]?.text).toMatch(
          /^Error INVALID_ARGUMENTS: .*expected one of status, delegate/s,
        );
      }
      expect(await journal.head()).toBe(before);
    });

    it("keeps the guards of each command: the role of Noah, the strict input, the renamed field", async () => {
      const before = await journal.head();
      // Noah's contract is still checked per command, whatever the tool: `story.start` is not his.
      const noah = (await client.callTool({
        name: "story",
        arguments: { action: "start", agent: "noah", story: "1-1" },
      })) as ToolResult;
      expect(noah.isError).toBe(true);
      expect(noah.content[0]?.text).toContain("ROLE_FORBIDDEN");
      // The same for `checkpoint.open` and `checkpoint.decide`.
      for (const action of ["open", "decide"]) {
        const refused = (await client.callTool({
          name: "checkpoint",
          arguments: { action, agent: "noah", checkpoint: "G-0000000000" },
        })) as ToolResult;
        expect(refused.content[0]?.text, action).toContain("ROLE_FORBIDDEN");
      }
      // An actor is no field of any action: the command refuses it, the schema's silence changes nothing.
      const usurped = (await client.callTool({
        name: "agent",
        arguments: { action: "status", agent: "iris", status: "idle", actor: { kind: "human" } },
      })) as ToolResult;
      expect(usurped.content[0]?.text).toContain("INVALID_ARGUMENTS");
      // A field of another action is refused too, and the old `action` field is `what`.
      const stray = (await client.callTool({
        name: "agent",
        arguments: { action: "status", agent: "iris", status: "idle", brief: "x" },
      })) as ToolResult;
      expect(stray.content[0]?.text).toContain("INVALID_ARGUMENTS");
      const unnamed = (await client.callTool({
        name: "guard",
        arguments: { action: "request", agent: "iris", detail: "npm install left-pad" },
      })) as ToolResult;
      expect(unnamed.isError).toBe(true);
      expect(unnamed.content[0]?.text).toContain("INVALID_ARGUMENTS");
      expect(unnamed.content[0]?.text).toContain('\\"what\\"');
      const bogus = (await client.callTool({
        name: "guard",
        arguments: { action: "request", what: "bogus", agent: "iris", detail: "x" },
      })) as ToolResult;
      expect(bogus.isError).toBe(true);
      expect(bogus.content[0]?.text).toContain("INVALID_ARGUMENTS");
      expect(await journal.head()).toBe(before);
    });

    it("answers in one compact text, without structuredContent, and says what to fix", async () => {
      const ok = await call("report_status", { agent: "iris", status: "working", task: "brief" });
      const wire = raw(ok);
      expect(wire.structuredContent).toBeUndefined();
      const content = wire.content as Array<{ text: string }>;
      expect(content).toHaveLength(1);
      expect(content[0]?.text).not.toContain("\n");
      expect(content[0]?.text).not.toMatch(/": /);
      const bad = await call("report_progress", { agent: "iris", story: "2-6" });
      const failure = raw(bad);
      expect(failure.structuredContent).toBeUndefined();
      expect(failure.isError).toBe(true);
      const text = (failure.content as Array<{ text: string }>)[0]?.text ?? "";
      expect((failure.content as unknown[]).length).toBe(1);
      // The refusal names the field and what the action expects (the schemas published are lean).
      expect(text).toContain("INVALID_ARGUMENTS");
      expect(text).toContain('"field":"note"');
      expect(text).toContain('"expected":');
      expect(text).toContain('\\"required\\":[\\"agent\\",\\"story\\",\\"note\\"]');
    });

    it("never rewrites what the creator or an agent said: a note naming next or get_state comes back word for word", async () => {
      const task = "run `next` then get_state, report_progress and `delegate` (npx agentplugged)";
      await call("report_status", { agent: "iris", status: "working", task });
      const state = await call("get_state", { full: true });
      const agents = state.structuredContent?.agents as Record<string, { task?: string }>;
      expect(agents.iris?.task).toBe(task);
      // The text on the wire is the same as the one the journal kept.
      expect(JSON.stringify(raw(state).content)).toContain("get_state, report_progress");
      const written = (await journal.list()).events.find(
        (event) => event.type === "agent.status_reported",
      );
      expect(JSON.stringify(written?.payload)).toContain("get_state, report_progress");
    });

    it("leaves npx agentplugged alone in what was said, with a launcher set", async () => {
      const engine = String.raw`node "C:Workin.js"`;
      const { other, done } = await start({ engineCommand: engine });
      const task = "tell them to run npx agentplugged sync, then get_state";
      await other.callTool({
        name: "report_status",
        arguments: { agent: "iris", status: "working", task },
      });
      const state = (await other.callTool({
        name: "get_state",
        arguments: { full: true },
      })) as ToolResult;
      const agents = state.structuredContent?.agents as Record<string, { task?: string }>;
      expect(agents.iris?.task).toBe(task);
      await other.close();
      await done;
    });

    it("writes the grouped notation in the texts it returns, not the engine's command names", async () => {
      const next = await call("next", {});
      expect(next.content[0]?.text).not.toMatch(
        /\b(get_state|report_status|open_checkpoint|answer_checkpoint|start_story|delegate)\b/,
      );
    });
  });

  it("refuses an actor in the input and an unknown agent, writing nothing", async () => {
    // `init` announced the product key: the journal holds that, and nothing more.
    const before = await journal.head();
    const usurped = await call("report_status", {
      agent: "iris",
      status: "working",
      actor: { kind: "human" },
    });
    expect(usurped.isError).toBe(true);
    expect(usurped.structuredContent).toMatchObject({
      code: "INVALID_ARGUMENTS",
      message_key: "error.invalid_arguments",
      details: { field: "actor" },
    });
    // One text: the message, then what to fix: the field and what the action expects.
    expect(usurped.content).toHaveLength(1);
    expect(usurped.content[0]?.text).toMatch(
      /^Error INVALID_ARGUMENTS: message of error\.invalid_arguments\n\{.*"field":"actor".*"expected":/,
    );

    const ghost = await call("report_status", { agent: "ghost", status: "working" });
    expect(ghost.isError).toBe(true);
    expect(ghost.structuredContent).toEqual({
      code: "AGENT_NOT_FOUND",
      message_key: "error.agent_not_active",
      details: { id: "ghost" },
    });
    // A single text, with nothing repeated.
    expect(ghost.content).toHaveLength(1);
    expect(await journal.head()).toBe(before);
  });

  it("records a structured result that get_state shows, and refuses an invalid one", async () => {
    const result = {
      agent: "iris",
      story: "2-6",
      status: "complete",
      summary: "Brief written.",
      assumptions: ["B2B"],
      open_questions: ["Which pricing?"],
      conflicts: [],
    };
    expect((await call("submit_result", result)).isError).toBeFalsy();
    const invalid = await call("submit_result", { ...result, status: "done" });
    expect(invalid.structuredContent).toMatchObject({
      code: "INVALID_ARGUMENTS",
      details: { field: "status" },
    });
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({
      stories: { "2-6": { results: { iris: { status: "complete", summary: "Brief written." } } } },
      open_points: [{ kind: "question", text: "Which pricing?", agent: "iris", story: "2-6" }],
    });
  });

  it("refuses update_story to review while a decision blocks it, and get_state shows the decision", async () => {
    const options = [
      { id: "stripe", label: "Stripe", consequence: "Fast to ship." },
      { id: "paddle", label: "Paddle", consequence: "Handles VAT." },
      { id: "later", label: "Later", consequence: "No payments at launch." },
    ];
    const opened = await call("open_checkpoint", {
      agent: "iris",
      type: "decision",
      risk: "medium",
      title: "Payment provider",
      summary: "Which provider do we launch with?",
      story: "2-6",
      blocks: [{ action: "story.review", story: "2-6" }],
      options,
      recommendation: "paddle",
    });
    expect(opened.isError).toBeFalsy();
    const id = opened.structuredContent?.checkpoint as string;
    expect(id).toMatch(/^G-[0-9A-HJKMNP-TV-Z]{10}$/);

    const head = await journal.head();
    const refused = await call("update_story", {
      agent: "iris",
      story: "2-6",
      status: "in_review",
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toEqual({
      code: "CHECKPOINT_OPEN",
      message_key: "error.checkpoint_open",
      details: { checkpoint: id, action: "story.review" },
    });
    expect(await journal.head()).toBe(head);
    const elsewhere = await call("update_story", {
      agent: "iris",
      story: "2-7",
      status: "in_review",
    });
    expect(elsewhere.isError).toBeFalsy();

    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({
      checkpoints: {
        [id]: {
          type: "decision",
          status: "open",
          recipient_role: "product",
          confirmation: ["gesture_undo_10s"],
          options,
          recommendation: "paddle",
        },
      },
      stories: { "2-6": { waiting_on: [id] } },
    });
  });

  it("opens a checkpoint on a blocked result, in one journal commit", async () => {
    // On an existing journal: the result and its checkpoint make one more commit.
    expect((await call("report_status", { agent: "iris", status: "working" })).isError).toBeFalsy();
    const before = Number(git(cwd, ["rev-list", "--count", "agentplugged/journal"]));
    const blocked = await call("submit_result", {
      agent: "iris",
      story: "2-6",
      status: "blocked",
      summary: "No API key.",
      assumptions: [],
      open_questions: ["Which key?"],
      conflicts: [],
    });
    expect(blocked.isError).toBeFalsy();
    const id = blocked.structuredContent?.checkpoint as string;
    const listing = await journal.list();
    const types = listing.events.map((event) => event.type);
    expect(types.slice(-2)).toEqual(["agent.result_recorded", "checkpoint.opened"]);
    expect(Number(git(cwd, ["rev-list", "--count", "agentplugged/journal"]))).toBe(before + 1);
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({
      checkpoints: { [id]: { type: "story", title: "Blocked: 2-6" } },
      stories: { "2-6": { waiting_on: [id] } },
    });
  });

  it("sees a checkpoint another journal instance opened between the call's start and its write", async () => {
    const elsewhere = new GitStateStore({
      cwd,
      keys: new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(6))),
      machineLockPath: join(isolated, "machine-key-other.lock"),
    });
    let opened: string | undefined;
    const racing = withAppendAll(journal, async (drafts, options) => {
      const other = await createCommandRegistry().run(
        "open_checkpoint",
        { ...baseContext, actor: "agent", journal: elsewhere },
        {
          agent: "iris",
          type: "story",
          risk: "medium",
          title: "Wait",
          summary: "Opened meanwhile.",
          story: "2-6",
          blocks: [{ action: "story.review" }],
        },
      );
      opened = other.ok ? (other.value as { checkpoint: string }).checkpoint : undefined;
      return journal.appendAll(drafts, options);
    });
    try {
      const { other, done } = await start({ journal: racing });
      const refused = (await other.callTool({
        name: "update_story",
        arguments: { agent: "iris", story: "2-6", status: "in_review" },
      })) as ToolResult;
      expect(opened).toMatch(/^G-/);
      expect(refused.structuredContent).toEqual({
        code: "CHECKPOINT_OPEN",
        message_key: "error.checkpoint_open",
        details: { checkpoint: opened, action: "story.review" },
      });
      const types = (await journal.list()).events.map((event) => event.type);
      expect(types).not.toContain("story.status_changed");
      await other.close();
      await done;
    } finally {
      elsewhere.close();
    }
  });

  it("an unknown tool is not served", async () => {
    await expect(client.callTool({ name: "init", arguments: {} })).rejects.toThrow();
  });

  it("encrypts a cost in the journal, and get_state shows no cost", async () => {
    const reported = await call("report_cost", { agent: "iris", usd: 4.56, estimated: false });
    expect(reported.isError).toBeFalsy();
    const listing = await journal.list();
    const cost = listing.events.find((entry) => entry.type === "cost.reported");
    expect(cost?.payload).toBeUndefined();
    expect(cost?.payload_enc?.alg).toBe("xchacha20poly1305");
    expect(JSON.stringify(listing.events)).not.toContain("4.56");
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).not.toHaveProperty("costs");
    expect(JSON.stringify(state.structuredContent)).not.toContain("4.56");
  });

  it("writes and reads a memory file encrypted, never outside its area", async () => {
    const written = await call("write_sensitive", {
      agent: "iris",
      area: "memory",
      path: "lessons.md",
      content: "Toujours relire le plan.",
    });
    expect(written.isError).toBeFalsy();
    const onDisk = readFileSync(join(cwd, ".agentplugged/memory/lessons.md"), "utf8");
    expect(onDisk.startsWith("agentplugged-enc:1:pk:")).toBe(true);
    expect(onDisk).not.toContain("relire");
    const read = await call("read_sensitive", {
      agent: "iris",
      area: "memory",
      path: "lessons.md",
    });
    expect(read.structuredContent).toMatchObject({ content: "Toujours relire le plan." });
    const escaped = await call("read_sensitive", { agent: "iris", area: "memory", path: "../x" });
    expect(escaped.isError).toBe(true);
    expect(escaped.structuredContent).toMatchObject({ code: "INVALID_ARGUMENTS" });
  });

  it("refuses an area that is a symbolic link (a junction on Windows): nothing written", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "agentplugged-outside-"));
    try {
      const area = join(cwd, ".agentplugged", "memory");
      await rm(area, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      await symlink(elsewhere, area, process.platform === "win32" ? "junction" : "dir");
      const written = await call("write_sensitive", {
        agent: "iris",
        area: "memory",
        path: "x.md",
        content: "x",
      });
      expect(written.isError).toBe(true);
      expect(written.structuredContent).toMatchObject({ code: "INVALID_ARGUMENTS" });
      expect(await readdir(elsewhere)).toEqual([]);
      // A dangling link is refused too.
      await rm(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      const dangling = await call("write_sensitive", {
        agent: "iris",
        area: "memory",
        path: "x.md",
        content: "x",
      });
      expect(dangling.structuredContent).toMatchObject({ code: "INVALID_ARGUMENTS" });
    } finally {
      await rm(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

/** A second server on the same product, with another journal or registry. */
async function start(options: {
  journal?: StateStore;
  registry?: CommandRegistry;
  drainTimeoutMs?: number;
  engineCommand?: string;
}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const stderr: Error[] = [];
  const done = runAgentServer({
    registry: options.registry ?? createCommandRegistry(),
    context: { ...baseContext, journal: options.journal ?? journal },
    engineVersion: "1.0.0",
    errorText: (error) => `message of ${error.message_key}`,
    transport: serverSide,
    onerror: (error) => stderr.push(error),
    ...(options.engineCommand === undefined ? {} : { engineCommand: options.engineCommand }),
    ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
  });
  const other = new Client({ name: "test-client", version: "1.0.0" });
  await other.connect(clientSide);
  return { other, done, stderr };
}

/**
 * `store` with another `appendAll` (called once with every draft of a write; `append` goes
 * through it): every other method is the store's own.
 */
function withAppendAll(store: StateStore, appendAll: StateStore["appendAll"]): StateStore {
  return {
    append: async (draft) => {
      const [event] = await appendAll([draft]);
      if (event === undefined) throw new Error("nothing appended");
      return event;
    },
    appendAll,
    appendHuman: (events, options) => store.appendHuman(events, options),
    list: () => store.list(),
    head: () => store.head(),
    productId: () => store.productId(),
    projected: () => store.projected(),
    markProjected: (position, previous) => store.markProjected(position, previous),
    history: (from, to) => store.history(from, to),
  };
}

/** The real journal, whose `append` waits for `release()`. */
function gated(store: StateStore) {
  let release: () => void = () => {};
  let started: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wrapped = withAppendAll(store, async (drafts, options) => {
    started();
    await gate;
    return store.appendAll(drafts, options);
  });
  return { wrapped, release, entered };
}

describe("MCP server: edge cases", () => {
  it("writes the event of a call still running when the client closes the connection", async () => {
    const { wrapped, release, entered } = gated(journal);
    const { other, done, stderr } = await start({ journal: wrapped });
    const pending = other
      .callTool({ name: "report_status", arguments: { agent: "iris", status: "idle" } })
      .catch(() => undefined);
    await entered;
    await other.close();
    release();
    await done;
    await pending;
    const listing = await journal.list();
    expect(listing.events.map((event) => event.type)).toContain("agent.status_reported");
    expect(stderr).toEqual([]);
  });

  it("gives up on calls still running after the drain timeout, and says so", async () => {
    const { wrapped, entered } = gated(journal);
    const { other, done, stderr } = await start({ journal: wrapped, drainTimeoutMs: 50 });
    other
      .callTool({ name: "report_status", arguments: { agent: "iris", status: "idle" } })
      .catch(() => undefined);
    await entered;
    await other.close();
    await done;
    expect(stderr.map((error) => error.message)).toEqual([
      "agentplugged mcp: calls still running after 50 ms were abandoned",
    ]);
  });

  it("returns UNEXPECTED when the journal fails without an expected error", async () => {
    const broken = withAppendAll(journal, () => Promise.reject(new Error("disk unplugged")));
    const { other, done } = await start({ journal: broken });
    const result = (await other.callTool({
      name: "report_status",
      arguments: { agent: "iris", status: "idle" },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "UNEXPECTED",
      message_key: "error.unexpected",
      details: { reason: "disk unplugged" },
    });
    await other.close();
    await done;
  });

  it("writes the launcher of this machine in the texts it returns", async () => {
    const say: Command = defineCommand({
      name: "say_command",
      audience: "agent",
      description: "Returns a command line of the engine, in a value and in an error.",
      run: async () => ({
        ok: true,
        value: {
          command: "npx agentplugged review G-1",
          steps: ["npx agentplugged docs check"],
          // What an agent or the creator said is never touched.
          note: "run npx agentplugged next",
          pinned: "npx agentplugged@1.0.0 sync",
          count: 3,
        },
      }),
    });
    const registry = new CommandRegistry([...agentActivityCommands, say]);
    const engine = String.raw`node "C:\Work\agent plugged\bin.js"`;
    const { other, done } = await start({ registry, engineCommand: engine });
    const result = (await other.callTool({ name: "say_command", arguments: {} })) as ToolResult;
    expect(result.structuredContent).toEqual({
      command: `${engine} review G-1`,
      steps: [`${engine} docs check`],
      note: "run npx agentplugged next",
      pinned: "npx agentplugged@1.0.0 sync",
      count: 3,
    });
    // The text the agent reads is the same JSON, escaped.
    expect(JSON.parse(result.content[0]?.text ?? "{}").command).toBe(`${engine} review G-1`);
    await other.close();
    await done;
    // Without a launcher, the texts are as the engine wrote them.
    const plain = await start({ registry });
    const same = (await plain.other.callTool({ name: "say_command", arguments: {} })) as ToolResult;
    expect(same.structuredContent?.command).toBe("npx agentplugged review G-1");
    await plain.other.close();
    await plain.done;
  });

  it("knows the Antigravity conversation of a call from its _meta, and only from there", async () => {
    const who: Command = defineCommand({
      name: "who_calls",
      audience: "agent",
      description: "Returns what the call knows of where it comes from.",
      run: async (context) => ({
        ok: true,
        value: {
          conversation: context.conversation ?? null,
          client: context.session?.client ?? null,
          ids: context.session?.ids ?? [],
        },
      }),
    });
    const registry = new CommandRegistry([...agentActivityCommands, who]);
    const { other, done } = await start({ registry });
    const conversation = "9eae3f94-67bd-4732-aee1-32feeb86e0ba";
    const key = "antigravity.google/conversation_id";
    // An argument is the agent's: it never names a conversation.
    const argument = (await other.callTool({
      name: "who_calls",
      arguments: { [key]: conversation, conversation },
    })) as ToolResult;
    expect(argument.structuredContent).toMatchObject({ conversation: null, ids: [] });
    // A malformed id in `_meta` is no conversation.
    const bad = (await other.callTool({
      name: "who_calls",
      arguments: {},
      _meta: { [key]: "x; drop table" },
    })) as ToolResult;
    expect(bad.structuredContent).toMatchObject({ conversation: null, ids: [] });
    const named = (await other.callTool({
      name: "who_calls",
      arguments: {},
      _meta: { [key]: conversation },
    })) as ToolResult;
    expect(named.structuredContent).toMatchObject({ conversation, ids: [conversation] });
    // The conversation is one of the session's ids from then on; the next call names its own.
    const next = "11111111-2222-3333-4444-555555555555";
    const other2 = (await other.callTool({
      name: "who_calls",
      arguments: {},
      _meta: { [key]: next },
    })) as ToolResult;
    expect(other2.structuredContent).toMatchObject({
      conversation: next,
      ids: [conversation, next],
    });
    await other.close();
    await done;
  });

  it("gives a command without input schema an empty input", async () => {
    const echo: Command = defineCommand({
      name: "echo_input",
      audience: "agent",
      description: "Returns its input.",
      run: async (_context, input) => ({ ok: true, value: { input } }),
    });
    const registry = new CommandRegistry([...agentActivityCommands, echo]);
    const { other, done } = await start({ registry });
    const result = (await other.callTool({ name: "echo_input", arguments: {} })) as ToolResult;
    expect(result.structuredContent).toEqual({ input: {} });
    await other.close();
    await done;
  });
});
