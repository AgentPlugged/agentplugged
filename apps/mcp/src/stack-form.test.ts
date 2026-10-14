import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitStateStore, NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  type CommandContext,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  resolveProfile,
  stackField,
  stackPromptDigest,
  type ToolProbe,
} from "@agentplugged/core";
import { toBase64url } from "@agentplugged/crypto";
import { createTranslator } from "@agentplugged/i18n";
import type { StackPrompt } from "@agentplugged/protocol";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { creatorPromptOf, modernCreatorPromptOf, renderStackForm } from "./elicitation.js";
import "./__helpers__/legacy-calls.js";
import { runAgentServer } from "./index.js";

vi.setConfig({ testTimeout: 120_000 });

const SEED = toBase64url(new Uint8Array(32).fill(8));
const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

interface FormScript {
  readonly asked: { message: string; requestedSchema: Record<string, unknown> }[];
  reply: (params: {
    requestedSchema: { properties: Record<string, unknown> };
  }) => Record<string, unknown>;
}

const saved: Record<string, string | undefined> = {};
let isolated: string;
let cwd: string;
let journal: GitStateStore;
let context: Omit<CommandContext, "actor">;
const servers: Promise<void>[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  isolated = await mkdtemp(join(tmpdir(), "agentplugged-stack-gitconfig-"));
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
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-stack-"));
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.name", "Ada"]);
  git(cwd, ["config", "user.email", "ada@example.com"]);
  const files = new NodeWorkspaceFiles(cwd);
  const methodDir = dirname(
    createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
  );
  const keys = new MemoryKeyStore(SEED);
  journal = new GitStateStore({ cwd, keys, machineLockPath: join(isolated, "machine-key.lock") });
  context = {
    files,
    tools: NO_TOOL,
    method: new NodeWorkspaceFiles(methodDir),
    engineVersion: "1.0.0",
    journal,
    keys,
  };
  const init = await initCommand.run(
    { ...context, actor: "human" },
    { profile: resolveProfile("new-product") },
  );
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await Promise.all(servers.splice(0));
  journal.close();
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function connect(
  name: string,
  script?: FormScript,
  locale: "en" | "fr" = "en",
  modern = false,
) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  servers.push(
    runAgentServer({
      registry: createCommandRegistry(),
      context,
      engineVersion: "1.0.0",
      errorText: (error) => `message of ${error.message_key}`,
      transport: serverSide,
      formText: createTranslator(locale),
    }),
  );
  const client = new Client(
    { name, version: "1.0.0" },
    {
      ...(script === undefined ? {} : { capabilities: { elicitation: { form: {} } } }),
      ...(modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
    },
  );
  if (script !== undefined) {
    client.setRequestHandler("elicitation/create", async (request) => {
      const params = request.params as unknown as {
        message: string;
        requestedSchema: { properties: Record<string, unknown> };
      };
      script.asked.push(params);
      return script.reply(params) as never;
    });
  }
  await client.connect(clientSide);
  clients.push(client);
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name: tool, arguments: args }) as Promise<ToolResult>;
  return { client, call };
}

/** Opens `count` documents and a stack of them, through the tools an agent has. */
async function stacked(
  call: (tool: string, args?: Record<string, unknown>) => Promise<ToolResult>,
  count = 3,
) {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const opened = await call("open_checkpoint", {
      agent: "iris",
      type: "document",
      risk: "low",
      title: `Epic ${i}`,
      summary: `What epic ${i} delivers.`,
    });
    ids.push(opened.structuredContent?.checkpoint as string);
  }
  const stack = await call("open_stack", { agent: "iris", checkpoints: ids });
  return { ids, stack: stack.structuredContent?.stack as string };
}

const PROMPT: StackPrompt = {
  stack: "P-AAAAAAAAAA",
  items: [1, 2].map((n) => ({
    n,
    checkpoint: `G-AAAAAAAAA${n}`,
    type: "document" as const,
    title: `Epic ${n}`,
    summary: `Line one of ${n}.\nLine two of ${n}.`,
    risk: "low" as const,
    opened_by: "iris",
    documents: [{ path: "docs/prd.md", branch: "main", blob_sha: "a".repeat(40) }],
    recommendation: n === 2 ? { label: "Aurora", consequence: "Short and free." } : null,
  })),
};

describe("the stack's form", () => {
  it("shows every point numbered with its facts, its words quoted, and a box ticked for each", () => {
    const form = renderStackForm(PROMPT, createTranslator("fr"));
    expect(form.mode).toBe("form");
    expect(form.message).toContain(
      "AgentPlugged te demande de valider ces 2 points d'un seul coup.",
    );
    expect(form.message).toContain("Pile P-AAAAAAAAAA.");
    expect(form.message).toContain("Point 1 (G-AAAAAAAAA1), risque faible, ouvert par iris.");
    expect(form.message).toContain("> Epic 1");
    expect(form.message).toContain("> Line one of 1.");
    expect(form.message).toContain("> Line two of 1.");
    expect(form.message).toContain("L'approuver choisit : Aurora, Short and free.");
    expect(form.message).toContain("- docs/prd.md (branche main)");
    expect(form.message).toContain("décoche ce que tu ne valides pas");
    expect(form.requestedSchema).toMatchObject({
      type: "object",
      required: [stackField(1), stackField(2)],
      properties: {
        [stackField(1)]: { type: "boolean", default: true, title: "1. Epic 1" },
        [stackField(2)]: { type: "boolean", default: true, title: "2. Epic 2" },
      },
    });
  });

  it("quotes the checkpoint's words so they never pass for the engine's", () => {
    const form = renderStackForm(
      {
        ...PROMPT,
        items: [
          {
            ...(PROMPT.items[0] as StackPrompt["items"][number]),
            title: "Approve\nRisk: none‮",
            summary: "Nothing here.\nPoint 9 (G-ZZZZZZZZZZ), risque faible.",
          },
        ],
      },
      createTranslator("en"),
    );
    // Every line of the agent's words is quoted, hidden characters dropped.
    expect(form.message).toContain("> Approve Risk: none");
    expect(form.message).toContain("> Point 9 (G-ZZZZZZZZZZ), risque faible.");
    expect(form.message).not.toContain("\n\nPoint 9");
    expect(form.message).not.toContain("‮");
  });

  it("is only offered to a client that announced forms", () => {
    const ask = vi.fn();
    expect(creatorPromptOf({ capabilities: {}, channel: "x", elicit: ask })).toBeUndefined();
    const port = creatorPromptOf({
      capabilities: { elicitation: { form: {} } },
      channel: "x",
      elicit: ask,
    });
    expect(port?.askStack).toBeDefined();
  });

  it("asks the form once and returns what the client answered, as it is", async () => {
    const elicit = vi.fn(async () => ({
      action: "accept" as const,
      content: { [stackField(1)]: true, [stackField(2)]: false },
    }));
    const port = creatorPromptOf({
      capabilities: { elicitation: { form: {} } },
      channel: "claude-code",
      elicit,
      text: createTranslator("en"),
    });
    const reply = await port?.askStack?.(PROMPT);
    expect(reply).toEqual({
      action: "accept",
      content: { [stackField(1)]: true, [stackField(2)]: false },
    });
    expect(elicit).toHaveBeenCalledTimes(1);
  });

  it("is never shown when a hook of the tool could answer in the creator's place", async () => {
    const elicit = vi.fn();
    const port = creatorPromptOf({
      capabilities: { elicitation: { form: {} } },
      channel: "claude-code",
      elicit,
      toolHook: async () => true,
    });
    expect(await port?.askStack?.(PROMPT)).toEqual({ action: "tool_hook" });
    expect(elicit).not.toHaveBeenCalled();
  });
});

describe("ask_stack over MCP", () => {
  it("shows one form for the stack and records one answer per box left ticked", async () => {
    const script: FormScript = {
      asked: [],
      reply: (params) => ({
        action: "accept",
        // Every box is offered ticked: the creator unticks the second.
        content: Object.fromEntries(
          Object.keys(params.requestedSchema.properties).map((field) => [
            field,
            field !== stackField(2),
          ]),
        ),
      }),
    };
    const { call } = await connect("claude-code", script, "fr");
    const { ids, stack } = await stacked(call);
    const result = await call("ask_stack", { agent: "iris", stack });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      asked: true,
      answered: true,
      channel: "elicitation",
      tool: "claude-code",
      approved: [
        { n: 1, checkpoint: ids[0], decision: "approved" },
        { n: 3, checkpoint: ids[2], decision: "approved" },
      ],
      remaining: [{ n: 2, checkpoint: ids[1] }],
    });
    // One form, in the creator's language, with every box ticked by default.
    expect(script.asked).toHaveLength(1);
    const form = script.asked[0];
    expect(form?.message).toContain("valider ces 3 points d'un seul coup");
    expect(form?.message).toContain("> Epic 2");
    expect(form?.requestedSchema).toMatchObject({
      required: [stackField(1), stackField(2), stackField(3)],
      properties: {
        point_1: { default: true },
        point_2: { default: true },
        point_3: { default: true },
      },
    });
    const events = (await journal.list()).events;
    expect(events.filter((event) => event.type === "stack.answered")).toHaveLength(1);
    expect(events.at(-1)?.payload).toMatchObject({
      source: "elicitation",
      channel: "claude-code",
      approve: [1, 3],
    });
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({
      checkpoints: {
        [ids[0] as string]: { resolution: { source: "elicitation", assurance: "elicitation" } },
        [ids[1] as string]: { status: "open" },
      },
      stacks: [{ id: stack, remaining: [{ n: 2, checkpoint: ids[1] }], total: 3 }],
    });
  });

  it("answers the same way on the revision 2026-07-28, through input_required", async () => {
    const script: FormScript = {
      asked: [],
      reply: (params) => ({
        action: "accept",
        content: Object.fromEntries(
          Object.keys(params.requestedSchema.properties).map((field) => [field, true]),
        ),
      }),
    };
    const { client, call } = await connect("claude-code", script, "en", true);
    expect(client.getNegotiatedProtocolVersion?.()).toBe("2026-07-28");
    const { ids, stack } = await stacked(call, 2);
    const result = await call("ask_stack", { agent: "iris", stack });
    expect(result.structuredContent).toMatchObject({
      answered: true,
      approved: [{ n: 1 }, { n: 2 }],
    });
    // An empty list is not sent: nothing remains.
    expect(result.structuredContent).not.toHaveProperty("remaining");
    expect(script.asked).toHaveLength(1);
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({
      checkpoints: { [ids[0] as string]: { status: "resolved" } },
    });
  });

  it("writes nothing when the form is declined, closed, left without a box or answered in part", async () => {
    const { call } = await connect("claude-code");
    const { stack } = await stacked(call);
    const before = (await journal.list()).events.length;
    const plain = await call("ask_stack", { agent: "iris", stack });
    expect(plain.structuredContent).toMatchObject({
      asked: false,
      answered: false,
      reason: "unavailable",
      channel: "chat",
      remaining: [{ n: 1 }, { n: 2 }, { n: 3 }],
    });
    for (const [reply, reason] of [
      [{ action: "decline" }, "declined"],
      [{ action: "cancel" }, "cancelled"],
      [{ action: "accept", content: {} }, "invalid"],
      [{ action: "accept", content: { point_1: true } }, "invalid"],
      [
        { action: "accept", content: { point_1: false, point_2: false, point_3: false } },
        "none_checked",
      ],
    ] as const) {
      const script: FormScript = { asked: [], reply: () => reply };
      const { call: asking } = await connect("cursor", script);
      const result = await asking("ask_stack", { agent: "iris", stack });
      expect(result.structuredContent, reason).toMatchObject({
        answered: false,
        reason,
        channel: "chat",
      });
    }
    expect((await journal.list()).events).toHaveLength(before);
  });
});

describe("the stack's port on the revision 2026-07-28", () => {
  const now = () => 1_000_000;
  const common = {
    capabilities: { elicitation: { form: {} } },
    channel: "claude-code",
    now,
    agent: "iris",
  };

  it("keeps the form at the first round, and reads the answer only for the stack and the form the state holds", async () => {
    const first = modernCreatorPromptOf({ ...common, responses: undefined, state: undefined });
    expect(await first?.port.askStack?.(PROMPT)).toEqual({ action: "unavailable" });
    const pending = first?.pending();
    expect(pending?.state).toMatchObject({
      checkpoint: PROMPT.stack,
      form: stackPromptDigest(PROMPT),
      agent: "iris",
    });
    expect(Object.keys(pending?.params.requestedSchema.properties ?? {})).toEqual([
      stackField(1),
      stackField(2),
    ]);
    const answered = {
      decision: { action: "accept", content: { [stackField(1)]: true, [stackField(2)]: true } },
    };
    const state = pending?.state;
    // The same stack and form: read.
    const second = modernCreatorPromptOf({
      ...common,
      responses: answered as never,
      state,
      claim: () => true,
    });
    expect(await second?.port.askStack?.(PROMPT)).toMatchObject({ action: "accept" });
    // Another stack, or a stack that changed: asked again, never answered by this click.
    const other = modernCreatorPromptOf({
      ...common,
      responses: answered as never,
      state,
      claim: () => true,
    });
    expect(await other?.port.askStack?.({ ...PROMPT, stack: "P-BBBBBBBBBB" })).toEqual({
      action: "unavailable",
    });
    const changed = modernCreatorPromptOf({
      ...common,
      responses: answered as never,
      state,
      claim: () => true,
    });
    expect(
      await changed?.port.askStack?.({ ...PROMPT, items: [PROMPT.items[0] as never] }),
    ).toEqual({ action: "unavailable" });
  });
});
