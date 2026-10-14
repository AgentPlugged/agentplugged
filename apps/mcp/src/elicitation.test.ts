import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitStateStore, NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  type CommandContext,
  createCommandRegistry,
  decisionPrompt,
  formDigest,
  initCommand,
  MemoryKeyStore,
  resolveProfile,
  type ToolProbe,
} from "@agentplugged/core";
import { toBase64url } from "@agentplugged/crypto";
import { createTranslator } from "@agentplugged/i18n";
import type { DecisionPrompt } from "@agentplugged/protocol";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { creatorPromptOf, modernCreatorPromptOf, renderForm, showsForms } from "./elicitation.js";
import "./__helpers__/legacy-calls.js";
import { runAgentServer } from "./index.js";

vi.setConfig({ testTimeout: 120_000 });

const SEED = toBase64url(new Uint8Array(32).fill(7));
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

/** What the test client answers to the server's forms, and what it was asked. */
interface FormScript {
  readonly asked: { message: string; requestedSchema: Record<string, unknown> }[];
  reply: (params: { requestedSchema: Record<string, unknown> }) => Record<string, unknown>;
}

const saved: Record<string, string | undefined> = {};
let isolated: string;
let cwd: string;
let journal: GitStateStore;
let context: Omit<CommandContext, "actor">;
const servers: Promise<void>[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  isolated = await mkdtemp(join(tmpdir(), "agentplugged-elicit-gitconfig-"));
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
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-elicit-"));
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

/** A client of the server: with or without forms, answering them as `script` says. */
async function connect(
  name: string,
  script?: FormScript,
  locale: "en" | "fr" = "en",
  modern = false,
  cursorFormProbeMs?: number,
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
      ...(cursorFormProbeMs === undefined ? {} : { cursorFormProbeMs }),
    }),
  );
  const client = new Client(
    { name, version: "1.0.0" },
    {
      ...(script === undefined ? {} : { capabilities: { elicitation: { form: {} } } }),
      // The revision 2026-07-28, where the form rides the call (`input_required`).
      ...(modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
    },
  );
  if (script !== undefined) {
    client.setRequestHandler("elicitation/create", async (request) => {
      const params = request.params as unknown as {
        message: string;
        requestedSchema: Record<string, unknown>;
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

const DECISION = {
  agent: "iris",
  type: "decision",
  risk: "medium",
  title: "Pick a name",
  summary: "Which name do we ship?",
  options: [
    { id: "a", label: "Aurora", consequence: "Short and free." },
    { id: "b", label: "Beacon", consequence: "Taken in two countries." },
  ],
  recommendation: "a",
};

describe("ask_creator over MCP", () => {
  it("asks in the client's form when it announced forms, and records the click", async () => {
    const script: FormScript = {
      asked: [],
      reply: () => ({ action: "accept", content: { choice: "option-2" } }),
    };
    const { call } = await connect("claude-code", script, "fr");
    const opened = await call("open_checkpoint", DECISION);
    const id = opened.structuredContent?.checkpoint as string;
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({ validation: { elicitation: true } });
    const asked = await call("ask_creator", { agent: "iris", checkpoint: id });
    expect(asked.isError).toBeFalsy();
    expect(asked.structuredContent).toMatchObject({
      answered: true,
      decision: "option_chosen",
      option: "b",
      tool: "claude-code",
    });
    // One gesture (corrections B): one question, no note field, recorded at once.
    expect(script.asked).toHaveLength(1);
    // The form: in the creator's language, the recommendation marked, no default anywhere.
    const form = script.asked[0];
    expect(form?.message).toContain("AgentPlugged te demande ta décision.");
    expect(form?.message).toContain("- Aurora (recommandé) : Short and free.");
    expect(form?.message).toContain("Risque : moyen.");
    expect(form?.message).toContain(`Point ${id}, ouvert par iris.`);
    expect(form?.message).toContain("> Pick a name");
    expect(JSON.stringify(form?.requestedSchema)).not.toContain('"default"');
    expect(form?.requestedSchema).toMatchObject({
      type: "object",
      required: ["choice"],
      properties: {
        choice: {
          type: "string",
          title: "Ta décision",
          oneOf: [
            { const: "option-1", title: "Aurora (recommandé)" },
            { const: "option-2", title: "Beacon" },
            { const: "changes", title: "Aucune : demander des changements" },
          ],
        },
      },
    });
    const listing = await journal.list();
    const event = listing.events.at(-1);
    expect(event?.type).toBe("checkpoint.elicited");
    expect(event?.payload).toMatchObject({ source: "elicitation", channel: "claude-code" });
    const after = await call("get_state", { full: true });
    expect(after.structuredContent).toMatchObject({
      checkpoints: {
        [id]: {
          status: "resolved",
          resolution: { source: "elicitation", assurance: "elicitation" },
        },
      },
    });
  });

  it("gives Cursor a short delay to show a first form, then asks in the chat and sends no other", async () => {
    // Reports show Cursor's form not displayed on Windows, the call staying pending: it never answers.
    const hung: FormScript = { asked: [], reply: () => new Promise(() => {}) as never };
    const stuck = await connect("cursor-vscode", hung, "en", false, 300);
    const opened = await stuck.call("open_checkpoint", DECISION);
    const id = opened.structuredContent?.checkpoint as string;
    const started = Date.now();
    const result = await stuck.call("ask_creator", { agent: "iris", checkpoint: id });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(result.structuredContent).toMatchObject({
      asked: true,
      answered: false,
      reason: "failed",
      channel: "chat",
    });
    expect(hung.asked).toHaveLength(1);
    // No other form is sent in this session: the chat is used from now on.
    const again = await stuck.call("ask_creator", { agent: "iris", checkpoint: id });
    expect(again.structuredContent).toMatchObject({ answered: false, channel: "chat" });
    expect(hung.asked).toHaveLength(1);
    // The state tells the agents the form is no channel here.
    const state = await stuck.call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({ validation: { elicitation: false } });

    // A Cursor whose form is answered in time is waited for as in any other tool afterwards.
    const shown: FormScript = {
      asked: [],
      reply: () => ({ action: "accept", content: { choice: "option-1" } }),
    };
    const fine = await connect("cursor-vscode", shown, "en", false, 300);
    const second = await fine.call("open_checkpoint", DECISION);
    const answered = await fine.call("ask_creator", {
      agent: "iris",
      checkpoint: second.structuredContent?.checkpoint as string,
    });
    expect(answered.structuredContent).toMatchObject({ answered: true, decision: "option_chosen" });
  });

  it("falls back to the chat without the capability, and on decline or cancel", async () => {
    const plain = await connect("codex");
    const opened = await plain.call("open_checkpoint", DECISION);
    const id = opened.structuredContent?.checkpoint as string;
    const state = await plain.call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({ validation: { elicitation: false } });
    expect(
      (await plain.call("ask_creator", { agent: "iris", checkpoint: id })).structuredContent,
    ).toEqual({
      checkpoint: id,
      asked: false,
      answered: false,
      reason: "unavailable",
      channel: "chat",
    });
    for (const [action, reason] of [
      ["decline", "declined"],
      ["cancel", "cancelled"],
    ] as const) {
      const script: FormScript = { asked: [], reply: () => ({ action }) };
      const { call } = await connect("cursor", script);
      const result = await call("ask_creator", { agent: "iris", checkpoint: id });
      expect(result.structuredContent).toMatchObject({ answered: false, reason, channel: "chat" });
      expect(script.asked).toHaveLength(1);
    }
    // A client that accepts with content outside the schema chose nothing.
    const odd: FormScript = {
      asked: [],
      reply: () => ({ action: "accept", content: { choice: "zzz" } }),
    };
    const third = await connect("cursor", odd);
    const result = await third.call("ask_creator", { agent: "iris", checkpoint: id });
    expect(result.structuredContent).toMatchObject({ answered: false, channel: "chat" });
    const events = (await journal.list()).events;
    expect(events.some((event) => event.type === "checkpoint.elicited")).toBe(false);
  });
});

describe("the form in one question (corrections B)", () => {
  it("records a choice at once, with no note field and no neutral entry", async () => {
    const script: FormScript = {
      asked: [],
      reply: () => ({ action: "accept", content: { choice: "option-1" } }),
    };
    const { call } = await connect("codex", script, "fr");
    const opened = await call("open_checkpoint", DECISION);
    const id = opened.structuredContent?.checkpoint as string;
    const asked = await call("ask_creator", { agent: "iris", checkpoint: id });
    expect(asked.structuredContent).toMatchObject({
      answered: true,
      decision: "option_chosen",
      option: "a",
    });
    expect(asked.structuredContent).not.toHaveProperty("note");
    expect(script.asked).toHaveLength(1);
    const schema = JSON.stringify(script.asked[0]?.requestedSchema);
    expect(schema).not.toContain('"note"');
    expect(schema).not.toContain("choisis");
    expect(schema).not.toContain("choose");
    expect(script.asked[0]?.requestedSchema).toMatchObject({ required: ["choice"] });
  });

  it("asks the note in a second question, only for a request for changes", async () => {
    const script: FormScript = {
      asked: [],
      reply: (params) =>
        "choice" in (params.requestedSchema.properties as Record<string, unknown>)
          ? { action: "accept", content: { choice: "changes" } }
          : { action: "accept", content: { note: "Plus court, s'il te plaît." } },
    };
    const { call } = await connect("codex", script, "fr");
    const opened = await call("open_checkpoint", DECISION);
    const id = opened.structuredContent?.checkpoint as string;
    const asked = await call("ask_creator", { agent: "iris", checkpoint: id });
    expect(asked.structuredContent).toMatchObject({
      answered: true,
      decision: "changes_requested",
      note: "Plus court, s'il te plaît.",
    });
    expect(script.asked).toHaveLength(2);
    // The second question: one required field, the note; no choice again.
    const second = script.asked[1];
    expect(second?.requestedSchema).toMatchObject({
      required: ["note"],
      properties: { note: { type: "string", minLength: 1 } },
    });
    expect(Object.keys(second?.requestedSchema.properties as object)).toEqual(["note"]);
    expect(second?.message).toContain("Tu demandes des changements");
    expect(second?.message).toContain("> Pick a name");
    const event = (await journal.list()).events.at(-1);
    expect(event?.type).toBe("checkpoint.elicited");
  });

  it("records nothing when the creator walks away from the second question", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const script: FormScript = {
        asked: [],
        reply: (params) =>
          "choice" in (params.requestedSchema.properties as Record<string, unknown>)
            ? { action: "accept", content: { choice: "changes" } }
            : { action },
      };
      const { call } = await connect("codex", script, "fr");
      const opened = await call("open_checkpoint", DECISION);
      const id = opened.structuredContent?.checkpoint as string;
      const asked = await call("ask_creator", { agent: "iris", checkpoint: id });
      expect(asked.structuredContent).toMatchObject({ answered: false, channel: "chat" });
      expect(script.asked).toHaveLength(2);
      const events = (await journal.list()).events;
      expect(events.some((event) => event.type === "checkpoint.elicited")).toBe(false);
    }
  });

  it("puts the question first and the technical details last, in the creator's language", () => {
    const form = renderForm(
      {
        checkpoint: "G-7M2K9QX4TB",
        type: "creator_action",
        title: "Accepter la story 1-1 sans sa CI",
        summary: "La CI ne peut pas être lue.",
        risk: "high",
        irreversible: false,
        opened_by: "noah",
        documents: [],
        options: [],
        recommendation: null,
        creator_action: { kind: "ci_waive", story: "1-1", commit: "ac558c6e" },
        publication: null,
        choices: [
          { id: "approve", decision: "approved", recommended: false, needs_note: false },
          { id: "reject", decision: "rejected", recommended: false, needs_note: true },
        ],
        external_action: null,
      } as never,
      createTranslator("fr"),
    );
    const message = form.message;
    expect(message.indexOf("> Accepter la story 1-1 sans sa CI")).toBeGreaterThan(0);
    expect(message.indexOf("> Accepter la story 1-1 sans sa CI")).toBeLessThan(
      message.indexOf("Point G-7M2K9QX4TB"),
    );
    expect(message.indexOf("> Accepter la story 1-1 sans sa CI")).toBeLessThan(
      message.indexOf("kind: ci_waive"),
    );
    expect(message.startsWith("AgentPlugged te demande ta décision.")).toBe(true);
    expect(message.trimEnd().split("\n").at(-1)).toContain("kind: ci_waive");
    const choice = (form.requestedSchema.properties.choice as { oneOf: { title: string }[] }).oneOf;
    expect(choice.map((entry) => entry.title)).toEqual(["Approuver", "Refuser"]);
  });
});

describe("ask_creator on the revision 2026-07-28", () => {
  it("asks through input_required and records the click, as on the earlier revisions", async () => {
    const script: FormScript = {
      asked: [],
      reply: () => ({ action: "accept", content: { choice: "option-2" } }),
    };
    const { client, call } = await connect("claude-code", script, "fr", true);
    // Not a 2025 handshake: the revision the journal of Claude Code shows.
    expect(client.getNegotiatedProtocolVersion?.()).toBe("2026-07-28");
    const opened = await call("open_checkpoint", DECISION);
    const id = opened.structuredContent?.checkpoint as string;
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({ validation: { elicitation: true } });
    const asked = await call("ask_creator", { agent: "iris", checkpoint: id });
    expect(asked.isError).toBeFalsy();
    expect(asked.structuredContent).toMatchObject({
      answered: true,
      decision: "option_chosen",
      option: "b",
      tool: "claude-code",
    });
    // One form, the same as on the earlier revisions: creator's language, recommendation
    // marked, no default anywhere, no neutral entry, no note field.
    expect(script.asked).toHaveLength(1);
    const form = script.asked[0];
    expect(form?.message).toContain("AgentPlugged te demande ta décision.");
    expect(form?.message).toContain("- Aurora (recommandé) : Short and free.");
    expect(JSON.stringify(form?.requestedSchema)).not.toContain('"default"');
    expect(form?.requestedSchema).toMatchObject({
      required: ["choice"],
      properties: { choice: { oneOf: [{}, {}, {}] } },
    });
    const event = (await journal.list()).events.at(-1);
    expect(event?.type).toBe("checkpoint.elicited");
    expect(event?.payload).toMatchObject({
      source: "elicitation",
      channel: "claude-code",
      decision: "option_chosen",
    });
    const after = await call("get_state", { full: true });
    expect(after.structuredContent).toMatchObject({
      checkpoints: {
        [id]: {
          status: "resolved",
          resolution: { source: "elicitation", assurance: "elicitation" },
        },
      },
    });
  });

  it("writes nothing on decline or cancel, and keeps the point out of new forms", async () => {
    const opened = await (await connect("cursor")).call("open_checkpoint", DECISION);
    const id = opened.structuredContent?.checkpoint as string;
    for (const [action, reason] of [
      ["decline", "declined"],
      ["cancel", "cancelled"],
    ] as const) {
      const script: FormScript = { asked: [], reply: () => ({ action }) };
      const { call } = await connect("cursor", script, "en", true);
      const result = await call("ask_creator", { agent: "iris", checkpoint: id });
      expect(result.structuredContent).toMatchObject({ answered: false, reason, channel: "chat" });
      expect(script.asked).toHaveLength(1);
      // The creator refused the form in this session: no new form, the chat takes over.
      const again = await call("ask_creator", { agent: "iris", checkpoint: id });
      expect(again.structuredContent).toMatchObject({ answered: false, reason: "declined" });
      expect(script.asked).toHaveLength(1);
    }
    // A choice outside the form: nothing recorded.
    const odd: FormScript = {
      asked: [],
      reply: () => ({ action: "accept", content: { choice: "zzz" } }),
    };
    const third = await connect("cursor", odd, "en", true);
    expect(
      (await third.call("ask_creator", { agent: "iris", checkpoint: id })).structuredContent,
    ).toMatchObject({ answered: false, reason: "invalid", channel: "chat" });
    expect((await journal.list()).events.some((e) => e.type === "checkpoint.elicited")).toBe(false);
  });

  it("falls back to the chat for a client of this revision that shows no forms", async () => {
    const { call } = await connect("codex", undefined, "en", true);
    const opened = await call("open_checkpoint", DECISION);
    const id = opened.structuredContent?.checkpoint as string;
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({ validation: { elicitation: false } });
    expect(
      (await call("ask_creator", { agent: "iris", checkpoint: id })).structuredContent,
    ).toEqual({
      checkpoint: id,
      asked: false,
      answered: false,
      reason: "unavailable",
      channel: "chat",
    });
  });

  it("returns the form as input_required, with nothing written, to a client that answers by hand", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    servers.push(
      runAgentServer({
        registry: createCommandRegistry(),
        context,
        engineVersion: "1.0.0",
        errorText: (error) => `message of ${error.message_key}`,
        transport: serverSide,
      }),
    );
    const manual = new Client(
      { name: "claude-code", version: "2.1.289" },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: { pin: "2026-07-28" } },
        inputRequired: { autoFulfill: false },
      },
    );
    await manual.connect(clientSide);
    clients.push(manual);
    const opened = (await manual.callTool({
      name: "open_checkpoint",
      arguments: DECISION,
    })) as ToolResult;
    const id = opened.structuredContent?.checkpoint as string;
    const round = (await manual.callTool(
      { name: "ask_creator", arguments: { agent: "iris", checkpoint: id } },
      { allowInputRequired: true },
    )) as unknown as {
      resultType?: string;
      inputRequests?: Record<string, { method: string; params: Record<string, unknown> }>;
      requestState?: string;
    };
    expect(round.resultType).toBe("input_required");
    const request = round.inputRequests?.decision;
    expect(request?.method).toBe("elicitation/create");
    expect(request?.params.mode).toBe("form");
    expect(String(request?.params.message)).toContain(`Checkpoint ${id}, opened by iris.`);
    // The state is sealed: signed, never a plain value the client could make.
    expect(round.requestState).toMatch(/^v1\./);
    expect((await journal.list()).events.some((e) => e.type === "checkpoint.elicited")).toBe(false);
    const retry = (state: string | undefined, content: Record<string, unknown>) =>
      manual.callTool(
        {
          name: "ask_creator",
          arguments: { agent: "iris", checkpoint: id },
          inputResponses: { decision: { action: "accept", content } },
          ...(state === undefined ? {} : { requestState: state }),
        } as never,
        { allowInputRequired: true },
      ) as unknown as Promise<ToolResult & { resultType?: string }>;
    // A state the client altered is refused by the protocol layer, before the engine: nothing
    // is written. The client cannot make one either.
    await expect(retry(`${round.requestState}x`, { choice: "option-1" })).rejects.toThrow();
    await expect(retry("v1.forged.forged", { choice: "option-1" })).rejects.toThrow();
    expect((await journal.list()).events.some((e) => e.type === "checkpoint.elicited")).toBe(false);
    // An answer with no state is not read: the form is asked again.
    expect((await retry(undefined, { choice: "option-1" })).resultType).toBe("input_required");
    // The answer under the state the server sealed is recorded, once.
    const done = await retry(round.requestState, { choice: "option-1" });
    expect(done.structuredContent).toMatchObject({
      answered: true,
      decision: "option_chosen",
      option: "a",
      tool: "claude-code",
    });
    const replay = await retry(round.requestState, { choice: "option-2" });
    expect(replay.isError).toBe(true);
    expect(
      (await journal.list()).events.filter((e) => e.type === "checkpoint.elicited"),
    ).toHaveLength(1);
  });
});

describe("the port of the revision 2026-07-28", () => {
  const sealedPrompt: DecisionPrompt = {
    checkpoint: "G-AAAAAAAAAA",
    type: "decision",
    title: "Pick a name",
    summary: "Which name?",
    risk: "medium",
    irreversible: false,
    opened_by: "iris",
    documents: [],
    options: [],
    recommendation: null,
    creator_action: null,
    choices: [
      { id: "approve", decision: "approved", recommended: false, needs_note: false },
      { id: "changes", decision: "changes_requested", recommended: false, needs_note: true },
    ],
    external_action: null,
  };
  const capabilities = { elicitation: { form: {} } };
  const answer = { decision: { action: "accept", content: { choice: "approve" } } };

  function port(overrides: Record<string, unknown>) {
    return modernCreatorPromptOf({
      capabilities,
      channel: "claude-code",
      responses: undefined,
      state: undefined,
      now: () => 1_000,
      agent: "iris",
      ...overrides,
    });
  }
  const seal = (overrides: Record<string, unknown> = {}) => ({
    checkpoint: sealedPrompt.checkpoint,
    form: formDigest(sealedPrompt),
    agent: "iris",
    until: 5_000,
    ...overrides,
  });

  it("builds the form at the first round, and reads nothing from an answer without state", async () => {
    const first = port({});
    expect(await first?.port.ask(sealedPrompt)).toEqual({ action: "unavailable" });
    const pending = first?.pending();
    expect(pending?.params.mode).toBe("form");
    expect(pending?.state).toEqual({
      checkpoint: "G-AAAAAAAAAA",
      form: formDigest(sealedPrompt),
      agent: "iris",
      until: 1_000 + 10 * 60 * 1000,
    });
    // An answer that comes with no sealed state is not read: the form is asked again.
    const stray = port({ responses: answer });
    expect(await stray?.port.ask(sealedPrompt)).toEqual({ action: "unavailable" });
    expect(stray?.pending()).toBeDefined();
  });

  it("reads the answer only for the point and the decision object the state holds", async () => {
    const same = port({ responses: answer, state: seal() });
    expect(await same?.port.ask(sealedPrompt)).toEqual({
      action: "accept",
      content: { choice: "approve" },
    });
    expect(same?.pending()).toBeUndefined();
    // The decision object changed meanwhile: the click was given to another form, ask again.
    const changed = port({ responses: answer, state: seal() });
    expect(await changed?.port.ask({ ...sealedPrompt, title: "Pick another name" })).toEqual({
      action: "unavailable",
    });
    expect(changed?.pending()).toBeDefined();
    // Another point: the same.
    const other = port({ responses: answer, state: seal({ checkpoint: "G-BBBBBBBBBB" }) });
    expect(await other?.port.ask(sealedPrompt)).toEqual({ action: "unavailable" });
    // Another agent's state: the same.
    const stranger = port({ responses: answer, state: seal(), agent: "rose" });
    expect(await stranger?.port.ask(sealedPrompt)).toEqual({ action: "unavailable" });
    // A state that is not ours in shape counts for nothing.
    const odd = port({ responses: answer, state: "x" });
    expect(await odd?.port.ask(sealedPrompt)).toEqual({ action: "unavailable" });
  });

  it("reads a state once: the replay of an answer is asked again", async () => {
    const used = new Set<string>();
    const claim = (key: string) => {
      const fresh = !used.has(key);
      used.add(key);
      return fresh;
    };
    const first = port({ responses: answer, state: seal(), claim });
    expect(await first?.port.ask(sealedPrompt)).toEqual({
      action: "accept",
      content: { choice: "approve" },
    });
    const replay = port({ responses: answer, state: seal(), claim });
    expect(await replay?.port.ask(sealedPrompt)).toEqual({ action: "unavailable" });
    expect(replay?.pending()).toBeDefined();
  });

  it("counts nothing after the deadline, once the call is cancelled, nor past a hook of the tool", async () => {
    const late = port({ responses: answer, state: seal({ until: 999 }) });
    expect(await late?.port.ask(sealedPrompt)).toEqual({ action: "failed" });
    const aborted = port({ responses: answer, state: seal(), aborted: () => true });
    expect(await aborted?.port.ask(sealedPrompt)).toEqual({ action: "failed" });
    const hooked = port({ responses: answer, state: seal(), toolHook: async () => true });
    expect(await hooked?.port.ask(sealedPrompt)).toEqual({ action: "tool_hook" });
    expect(hooked?.pending()).toBeUndefined();
    const broken = port({
      responses: answer,
      state: seal(),
      toolHook: async () => {
        throw new Error("unreadable settings");
      },
    });
    expect(await broken?.port.ask(sealedPrompt)).toEqual({ action: "tool_hook" });
  });

  it("reads decline and cancel as they are, and is absent without the capability", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const reply = port({ responses: { decision: { action } }, state: seal() });
      expect(await reply?.port.ask(sealedPrompt)).toEqual({ action });
    }
    expect(port({ capabilities: {} })).toBeUndefined();
    // A bare `elicitation: {}` means forms (the protocol), `{ url }` alone does not.
    expect(port({ capabilities: { elicitation: {} } })).toBeDefined();
    expect(port({ capabilities: { elicitation: { url: {} } } })).toBeUndefined();
    expect(port({ capabilities: { elicitation: { form: {}, url: {} } } })).toBeDefined();
    expect(port({ capabilities: undefined })).toBeUndefined();
  });
});

describe("the form", () => {
  const prompt: DecisionPrompt = {
    checkpoint: "G-AAAAAAAAAA",
    type: "creator_action",
    title: "Waive the CI of story 4-3",
    summary: "The story can be merged without its CI.",
    risk: "high",
    irreversible: true,
    opened_by: null,
    documents: [],
    options: [],
    recommendation: null,
    creator_action: null,
    choices: [
      { id: "approve", decision: "approved", recommended: false, needs_note: false },
      { id: "reject", decision: "rejected", recommended: false, needs_note: true },
      { id: "changes", decision: "changes_requested", recommended: false, needs_note: true },
    ],
    external_action: { action: "Waive the CI of story 4-3‮" },
  };

  it("shows the definition of an agent to create whole, quoted, section by section", () => {
    const content = {
      overview: "Rose recrute des voisins.",
      produces: ["Une annonce", "Un suivi"],
      works: ["Une question à la fois"],
      never: ["Ne publie rien"],
      principles: ["Le créateur décide"],
      menu: [{ code: "AN", description: "Annonce", prompt: "Rédige l'annonce." }],
    };
    const form = renderForm(
      {
        ...prompt,
        title: "Create the agent rose",
        risk: "medium",
        irreversible: false,
        external_action: null,
        opened_by: "noah",
        creator_action: {
          kind: "agent_create",
          id: "rose",
          title: "Recrutement local",
          description: "Recrute des voisins.",
          domain: "marketing",
          phase: "launch",
          reason: "voisins",
          content,
        },
      },
      createTranslator("fr"),
    );
    expect(form.message).toContain("Définition qui sera écrite, telle que noah l'a rédigée :");
    expect(form.message).toContain("Présentation :\n> Rose recrute des voisins.");
    expect(form.message).toContain("Ce qu'il produit :\n> Une annonce\n> Un suivi");
    expect(form.message).toContain("Menu :\n> AN · Annonce — Rédige l'annonce.");
    // Not a `[object Object]` in the one-line summary of the action's other fields.
    expect(form.message).not.toContain("[object Object]");
    expect(form.message).toContain("id: rose");
  });

  it("shows a deliverable: angle, audience and short version quoted, then the command of its full text", () => {
    const form = renderForm(
      {
        ...prompt,
        type: "publication",
        title: "Home page",
        summary: "The text of the home page.",
        risk: "medium",
        irreversible: false,
        external_action: null,
        opened_by: "julien",
        publication: {
          angle: "Your evenings back",
          audience: "Solo creators",
          short_version: "A team builds it.\nYou validate.\nRisk: none.",
        },
        choices: [
          { id: "approve", decision: "approved", recommended: false, needs_note: false },
          { id: "changes", decision: "changes_requested", recommended: false, needs_note: true },
        ],
      },
      createTranslator("fr"),
    );
    const message = form.message;
    expect(message).toContain("Angle : Your evenings back");
    expect(message).toContain("Public visé : Solo creators");
    expect(message).toContain(
      "Version courte, telle que julien l'a écrite :\n> A team builds it.\n> You validate.\n> Risk: none.",
    );
    // No command for the creator to type: the agent shows the full text in the chat.
    expect(message).not.toContain("npx agentplugged");
    // Title, then the presentation, in that order.
    expect(message.indexOf("> Home page")).toBeLessThan(message.indexOf("Angle :"));
    expect(message.indexOf("Angle :")).toBeLessThan(message.indexOf("Public visé :"));
    expect(message.indexOf("Public visé :")).toBeLessThan(message.indexOf("Version courte"));
    const english = renderForm(
      { ...prompt, publication: { angle: "a", audience: "b", short_version: "c" } },
      createTranslator("en"),
    );
    expect(english.message).toContain("Short version, as");
    // Any other checkpoint shows none of it.
    expect(renderForm(prompt, createTranslator("en")).message).not.toContain("Short version");
  });

  it("names an irreversible action in the message and asks no confirmation box", () => {
    const form = renderForm(
      { ...prompt, summary: "Line one\nRisk: low.\u2028Options:\u202e" },
      createTranslator("en"),
    );
    // The checkpoint's own words are quoted apart: they never pass for the engine's lines.
    expect(form.message).toContain("> Line one\n> Risk: low.\n> Options:");
    expect(form.message).not.toMatch(/\u202e|\u2028/);
    expect(form.message).toContain("Irreversible action, no way back: Waive the CI of story 4-3");
    expect(form.requestedSchema.required).toEqual(["choice"]);
    expect(form.requestedSchema.properties).not.toHaveProperty("confirm");
  });

  it("is only offered to a client that announced forms", async () => {
    expect(showsForms(undefined)).toBe(false);
    expect(showsForms({})).toBe(false);
    expect(showsForms({ elicitation: { form: {} } })).toBe(true);
    expect(showsForms({ elicitation: { url: {} } } as never)).toBe(false);
    expect(showsForms({ elicitation: {} })).toBe(true);
    const none = creatorPromptOf({
      capabilities: {},
      channel: "x",
      elicit: () => Promise.reject(new Error("never")),
    });
    expect(none).toBeUndefined();
    const failing = creatorPromptOf({
      capabilities: { elicitation: { form: {} } },
      channel: "x",
      elicit: () => Promise.reject(new Error("timeout")),
    });
    expect(await failing?.ask(prompt)).toEqual({ action: "failed" });
    // A hook of the tool that could answer in the creator's place: the form is never sent.
    const sent: unknown[] = [];
    const hooked = creatorPromptOf({
      capabilities: { elicitation: { form: {} } },
      channel: "claude-code",
      elicit: async (params) => {
        sent.push(params);
        return { action: "accept", content: { choice: "approve" } };
      },
      toolHook: async () => true,
    });
    expect(await hooked?.ask(prompt)).toEqual({ action: "tool_hook" });
    expect(sent).toEqual([]);
    // A tool call the client cancelled: the click counts for nothing.
    const cancelled = creatorPromptOf({
      capabilities: { elicitation: { form: {} } },
      channel: "claude-code",
      elicit: async () => ({ action: "accept", content: { choice: "approve" } }),
      aborted: () => true,
    });
    expect(await cancelled?.ask(prompt)).toEqual({ action: "failed" });
  });

  it("matches the engine's decision object", () => {
    // The same field names on both sides.
    const form = renderForm(prompt, createTranslator("fr"));
    expect(Object.keys(form.requestedSchema.properties)).toEqual(["choice"]);
    expect(typeof decisionPrompt).toBe("function");
  });
});
