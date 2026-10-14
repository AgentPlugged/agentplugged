import type { Readable, Writable } from "node:stream";
import {
  type AgentPluggedError,
  AgentSession,
  type Command,
  type CommandContext,
  type CommandRegistry,
  inputShapeOf,
  isAntigravityClient,
  isCodexClient,
  isCursorClient,
  isHookedClient,
  publishedShape,
  ResponseMemory,
  shapeResponse,
  TOOL_GROUPS,
  toolCallOf,
  toolNotation,
  withEngineCommand,
  withToolNotation,
} from "@agentplugged/core";
import { randomBytes } from "@agentplugged/crypto";
import type { Translate } from "@agentplugged/i18n";
import { ErrorCode, type ErrorPayload } from "@agentplugged/protocol";
import {
  type CallToolResult,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  type ClientCapabilities,
  createRequestStateCodec,
  type InputRequiredResult,
  inputRequired,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  type ServerContext,
  type StandardSchemaWithJSON,
  type Transport,
} from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { z } from "zod";
import { creatorPromptOf, FORM_KEY, type FormState, modernCreatorPromptOf } from "./elicitation.js";
import { questionToolOf } from "./question-tool.js";
import { advertisedJson, type PublishedTool, publishedTools } from "./tool-groups.js";

/** Name of the server, as the AI tools' configurations declare it (`mcpServers.agentplugged`). */
export const MCP_SERVER_NAME = "agentplugged";

/** An error's English text: the message of the `en` catalog, given by the surface. */
export type ErrorText = (error: ErrorPayload) => string;

export interface AgentServerOptions {
  readonly registry: CommandRegistry;
  /** The context of every call: `actor` must be `agent` (set here, never read from the input). */
  readonly context: Omit<CommandContext, "actor">;
  /** Version of the running engine, announced to the client. */
  readonly engineVersion: string;
  /** English message of an error, for the agent reading it. */
  readonly errorText: ErrorText;
  /**
   * The command that runs the engine on this machine (`method.yaml`): written in
   * place of `npx agentplugged` in every text a tool returns, so an agent never reads a launcher
   * that does not work here.
   */
  readonly engineCommand?: string;
  /**
   * The creator's language for the forms the engine asks in the AI tool (
   * `ask_creator`): the creator reads them, not the agent. English when absent.
   */
  readonly formText?: Translate;
  /**
   * True when a hook of the AI tool could answer the engine's forms in the creator's place
   * (Claude Code's `Elicitation` and `ElicitationResult` hooks): read before each
   * form, which is then never sent.
   */
  readonly elicitationHooked?: () => Promise<boolean>;
  /**
   * True when a hook of another maker could answer the question tool in the creator's place (story
   * 3.25: a `PreToolUse` or `PermissionRequest` hook on it): read at each call, the engine then does
   * not dictate its questions there.
   */
  readonly questionToolHooked?: () => Promise<boolean>;
  /**
   * Awaited before each command runs (the engine fetches the journal other machines
   * wrote, within a short time limit of its own). Never fails a call.
   */
  readonly beforeCall?: () => Promise<void>;
  /**
   * How the AI tool was started (`CLAUDE_CODE_ENTRYPOINT` of the server's environment): a headless
   * run (`sdk-…`) has no person to answer the question tool. Unknown: a person is
   * assumed.
   */
  readonly entrypoint?: string;
  /**
   * The secret that seals the state of a form (revision 2026-07-28): given by the launcher of the
   * server so that a form asked by one engine is answered by the next one when the
   * session moves to a newer version. A key of this process alone when absent.
   */
  readonly formStateKey?: Uint8Array;
  /**
   * How long Cursor is given to show a first form, in milliseconds: 90 seconds when
   * absent. For tests.
   */
  readonly cursorFormProbeMs?: number;
}

/**
 * True for a protocol revision without server-to-client requests (2026-07-28 and later): the
 * form rides the multi-round-trip requests of the call itself (`input_required`)
 * instead of a request of the server.
 */
function modernEra(version: string | undefined): boolean {
  return version !== undefined && version >= "2026-07-28";
}

/** How long the sealed state of a form stays readable: well past the answer's own deadline. */
const FORM_STATE_TTL_SECONDS = 3600;

/** The agent a call names (`agent` of `ask_creator`), as the state keeps it: trimmed, lower case. */
function askingAgent(input: unknown): string {
  const agent = (input as { agent?: unknown } | null | undefined)?.agent;
  return typeof agent === "string" ? agent.trim().toLowerCase() : "";
}

/** The client name Antigravity CLI announces; used when a call carries its conversation only. */
const ANTIGRAVITY_CLIENT = "antigravity-client";

/** The key of the request's `_meta` in which Antigravity names the conversation of the call. */
const ANTIGRAVITY_CONVERSATION_KEY = "antigravity.google/conversation_id";

/** The Antigravity conversation a call comes from (its id), or undefined. */
function antigravityConversation(request: ServerContext): string | undefined {
  const meta = request.mcpReq._meta as Record<string, unknown> | undefined;
  const id = meta?.[ANTIGRAVITY_CONVERSATION_KEY];
  return typeof id === "string" && /^[0-9a-f-]{8,64}$/i.test(id.trim()) ? id.trim() : undefined;
}

/** A reserved key of the request's `_meta` envelope (2026-07-28), as the client sent it. */
function envelopeKey(request: ServerContext, key: string): unknown {
  return (request.mcpReq.envelope as Record<string, unknown> | undefined)?.[key];
}

/** How often the server tells the client it is still waiting for the creator's answer. */
const PROGRESS_INTERVAL_MS = 15_000;

/**
 * How long Cursor is given to show a first form: reports show its form not displayed
 * on Windows, the call staying pending until cancelled by hand. No answer within this delay: the
 * question goes to the chat, and no other form is sent in the session. Once a form was answered,
 * Cursor is waited for as long as any other tool.
 */
const CURSOR_FORM_PROBE_MS = 90_000;

/**
 * Sends the form, tied to the tool call in flight: cancelling the call closes the form, and,
 * when the client asked for progress, a notification every 15 s keeps its request alive while
 * the creator decides.
 */
async function waitForCreator(
  request: ServerContext,
  params: Parameters<ServerContext["mcpReq"]["elicitInput"]>[0],
  options: { readonly timeout: number },
) {
  const token = request.mcpReq._meta?.progressToken;
  let progress = 0;
  const timer =
    token === undefined
      ? undefined
      : setInterval(() => {
          progress += 1;
          request.mcpReq
            .notify({
              method: "notifications/progress",
              params: { progressToken: token, progress, message: "waiting for the creator" },
            })
            .catch(() => undefined);
        }, PROGRESS_INTERVAL_MS);
  try {
    return await request.mcpReq.elicitInput(params, {
      timeout: options.timeout,
      signal: request.mcpReq.signal,
    });
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}

/**
 * The fields of a result that the engine itself writes and that name tools: there the
 * old command names are written as the grouped tool and action. Every other string of a result is
 * what the creator or an agent said (notes, quotes, answers, summaries, documents): it is the proof
 * of what was said and stays word for word.
 */
const ENGINE_TEXT_KEYS: ReadonlySet<string> = new Set([
  "next_step",
  "command",
  "full_text_command",
  "steps",
]);

/** The error fields the engine writes (the others may echo what was sent). */
const ENGINE_ERROR_KEYS: ReadonlySet<string> = new Set(["reason"]);

/**
 * `value` with the engine command in every string it holds (objects and arrays included), and the
 * tool notation in the strings of `notated` keys only (`"all"`: in every string, for a text the
 * engine wrote whole, such as an error message).
 */
function localized<T>(
  value: T,
  engine: string | undefined,
  notated: ReadonlySet<string> | "all" = ENGINE_TEXT_KEYS,
): T {
  const walk = (item: unknown, key: string | undefined, engineNote = false): unknown => {
    if (typeof item === "string") {
      // Only the engine's own texts are touched: what was said stays word for word. The note of
      // a cut list (`omitted` and `read` beside it) is the engine's too.
      const mine = key === "note" && engineNote;
      if (notated !== "all" && !mine && (key === undefined || !notated.has(key))) return item;
      const named = withToolNotation(item);
      return engine === undefined ? named : withEngineCommand(named, engine);
    }
    if (Array.isArray(item)) return item.map((entry) => walk(entry, key));
    if (typeof item === "object" && item !== null) {
      const cut = "omitted" in item && "read" in item;
      return Object.fromEntries(Object.entries(item).map(([k, entry]) => [k, walk(entry, k, cut)]));
    }
    return item;
  };
  return walk(value, undefined) as T;
}

/**
 * The schema advertised in `tools/list` (the JSON Schema of the command's `protocol` schema),
 * whose SDK-side validation lets every value through: the command checks its input itself, so a
 * refused input comes back as the same `{ code, message_key, details }` as any other error,
 * instead of a protocol error of the SDK's.
 */
function advertised(schema: z.ZodType): StandardSchemaWithJSON {
  const standard = schema["~standard"] as unknown as StandardSchemaWithJSON["~standard"];
  return {
    "~standard": {
      ...standard,
      validate: (value: unknown) => ({ value }),
    },
  } as StandardSchemaWithJSON;
}

/**
 * An error as one text: the code and the message, then, in compact JSON, only the
 * details the message does not already say (the field to fix, the checkpoint in the way…). The
 * text is the whole answer: no second block that repeats it, no `structuredContent`.
 */
/** `story.progress` for the command `report_progress`; undefined for anything else. */
function commandNotation(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const call = toolCallOf(command);
  return call === undefined ? undefined : toolNotation(call);
}

/** The input an action expects, as compact JSON Schema (published field names). */
function expectedOf(command: Command, rename: Readonly<Record<string, string>>): string {
  const shape = inputShapeOf(command);
  return shape === undefined ? "" : JSON.stringify(publishedShape(shape, rename));
}

function errorResult(error: ErrorPayload, errorText: ErrorText): CallToolResult {
  const payload: ErrorPayload = {
    code: error.code,
    message_key: error.message_key,
    details: { ...error.details },
  };
  const message = errorText(payload);
  const extra = Object.fromEntries(
    Object.entries(payload.details).filter(([key, value]) => {
      // What fixes a call is always kept; a short value is never taken for « already said ».
      if (key === "field" || key === "expected") return true;
      if (typeof value !== "string" || value.length < 4) return true;
      return !message.includes(value);
    }),
  );
  const tail = Object.keys(extra).length === 0 ? "" : `\n${JSON.stringify(extra)}`;
  return {
    isError: true,
    content: [{ type: "text", text: `Error ${payload.code}: ${message}${tail}` }],
  };
}

/**
 * A success as one text of compact JSON. `content` is what every client reads (MCP
 * specification: structured content is only « also » serialized in a text block, and this server
 * declares no output schema), so `structuredContent` would only double the tokens.
 */
function successResult(value: unknown): CallToolResult {
  const structured =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return { content: [{ type: "text", text: JSON.stringify(structured) }] };
}

/** Calls in flight: the server waits for them before the journal is released. */
export class PendingCalls {
  readonly #calls = new Set<Promise<unknown>>();

  track<T>(call: Promise<T>): Promise<T> {
    this.#calls.add(call);
    const done = () => this.#calls.delete(call);
    call.then(done, done);
    return call;
  }

  /**
   * Waits for the calls in flight, at most `timeoutMs`; true when they all ended, false when
   * some were still running at the deadline.
   */
  async settled(timeoutMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      if (Number.isFinite(timeoutMs)) timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const drained = (async () => {
      while (this.#calls.size > 0) await Promise.allSettled([...this.#calls]);
      return true as const;
    })();
    try {
      return await Promise.race([drained, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * One MCP server instance: a tool for each command the registry reserves to agents, with the
 * command's name, description and input schema, and no logic of its own. Every call runs the
 * command with `actor: "agent"`, without the creator's key access (`human`), in the session of
 * this instance (`AgentSession`).
 */
export function createAgentServer(
  options: AgentServerOptions,
  pending: PendingCalls = new PendingCalls(),
): McpServer {
  // The state a form leaves with the client between two rounds of a call (revision 2026-07-28) is
  // sealed, signed with a key of this process alone: the client reads it and echoes it, never
  // makes one.
  const formState = createRequestStateCodec<FormState>({
    key: options.formStateKey ?? randomBytes(32),
    ttlSeconds: FORM_STATE_TTL_SECONDS,
  });
  // The states already read (an answer counts once): kept until their own deadline.
  const usedStates = new Map<string, number>();
  const claimState = (key: string, until: number): boolean => {
    const now = (shared.now ?? Date.now)();
    for (const [used, deadline] of usedStates) if (deadline < now) usedStates.delete(used);
    if (usedStates.has(key)) return false;
    usedStates.set(key, until);
    return true;
  };
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: options.engineVersion },
    { capabilities: { tools: {} }, requestState: { verify: formState.verify } },
  );
  // Never the creator's key nor a terminal: an agent cannot sign as the creator.
  const { human: _human, interactive: _interactive, ...shared } = options.context;
  // One server per session of the AI tool: the session keeps what made it untrusted.
  const session = shared.session ?? new AgentSession((shared.now ?? Date.now)());
  const context: CommandContext = { ...shared, actor: "agent", session };
  const commands = new Map(
    options.registry.agentCommands().map((command) => [command.name, command] as const),
  );
  // The commands are published grouped by domain, one tool with an `action` each.
  // What this session was already told (a warning, a hint): the answers do not repeat it.
  const responses = new ResponseMemory();
  const grouped = new Set<string>();
  for (const tool of publishedTools(commands)) {
    for (const spec of Object.values(TOOL_GROUPS[tool.name]?.actions ?? {})) {
      grouped.add(spec.command);
    }
    registerGroup(server, tool);
  }
  // A command no group holds (a surface's own, tests) is published alone, as it always was.
  for (const command of commands.values()) {
    if (!grouped.has(command.name)) registerTool(server, command);
  }

  function registerGroup(target: McpServer, tool: PublishedTool) {
    const runners = new Map<string, ReturnType<typeof runnerOf>>();
    const handler = async (
      input: unknown,
      request: ServerContext,
    ): Promise<CallToolResult | InputRequiredResult> => {
      const given = (
        typeof input === "object" && input !== null && !Array.isArray(input) ? input : {}
      ) as Record<string, unknown>;
      const { action, ...rest } = given;
      const command = typeof action === "string" ? tool.actions.get(action) : undefined;
      const spec = typeof action === "string" ? TOOL_GROUPS[tool.name]?.actions[action] : undefined;
      if (command === undefined || spec === undefined) {
        const listed = [...tool.actions.keys()].join(", ");
        return errorResult(
          {
            code: ErrorCode.INVALID_ARGUMENTS,
            message_key: "error.invalid_arguments",
            details: {
              command: tool.name,
              field: "action",
              reason: `${tool.name}: action: expected one of ${listed}`,
            },
          },
          options.errorText,
        );
      }
      // The published field `what` is the command's `action` (see `TOOL_GROUPS`).
      const forCommand: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(rest)) {
        forCommand[spec.rename?.[field] ?? field] = value;
      }
      let runner = runners.get(command.name);
      if (runner === undefined) {
        runner = runnerOf(command, spec.rename ?? {}, (value) =>
          shapeResponse(tool.name, action as string, value, responses),
        );
        runners.set(command.name, runner);
      }
      return runner(forCommand, request);
    };
    target.registerTool(
      tool.name,
      { description: tool.description, inputSchema: advertisedJson(tool.schema) },
      ((input: unknown, request: ServerContext) => pending.track(handler(input, request))) as never,
    );
  }

  function registerTool(target: McpServer, command: Command) {
    const run = runnerOf(command);
    const config = {
      description: command.description ?? command.name,
      ...(command.inputSchema === undefined
        ? {}
        : { inputSchema: advertised(command.inputSchema) }),
    };
    // Without an input schema, the SDK passes its request context only: the command gets `{}`.
    const handler =
      command.inputSchema === undefined
        ? (request: ServerContext) => pending.track(run({}, request))
        : (input: unknown, request: ServerContext) => pending.track(run(input, request));
    target.registerTool(command.name, config, handler as never);
  }

  /**
   * The function that runs one engine command for a call. For an action of a grouped tool,
   * `rename` is its published fields' renames, and a refusal of the input then says what the
   * action expects.
   */
  function runnerOf(
    command: Command,
    rename?: Readonly<Record<string, string>>,
    shape?: (value: unknown) => unknown,
  ) {
    const run = async (
      input: unknown,
      request?: ServerContext,
    ): Promise<CallToolResult | InputRequiredResult> => {
      // The client's name as it introduced itself: Claude Code has the hook that
      // proves the chat's quotes. Set by the protocol's handshake, never by a tool's input.
      // From revision 2026-07-28 there is no handshake: the name rides every request.
      const envelopeName = (
        request === undefined ? undefined : envelopeKey(request, CLIENT_INFO_META_KEY)
      ) as { name?: unknown } | undefined;
      const client =
        server.server.getClientVersion()?.name ??
        (typeof envelopeName?.name === "string" ? envelopeName.name : undefined);
      // Antigravity names the conversation a call comes from in the request's `_meta`
      // (a field the client sets, never the agent), including when its handshake gives no client
      // name. The conversation is one of the session's ids, so what the hooks recorded under it
      // (external reads) counts here, and an answer from the chat is proved by its messages alone.
      const conversation = request === undefined ? undefined : antigravityConversation(request);
      if (conversation !== undefined) {
        session.noteClient(ANTIGRAVITY_CLIENT);
        session.learn(conversation);
      }
      session.noteClient(client);
      // When the client announced that it shows forms, the engine may ask the creator
      // itself, in a form tied to this very call (`ask_creator`). From revision
      // 2026-07-28 the form is an `input_required` result the client answers by retrying the call.
      const version = (
        request === undefined ? undefined : envelopeKey(request, PROTOCOL_VERSION_META_KEY)
      ) as string | undefined;
      const modern =
        request !== undefined &&
        modernEra(
          typeof version === "string" ? version : server.server.getNegotiatedProtocolVersion(),
        );
      const common = {
        channel: session.client ?? client ?? "mcp-client",
        ...(options.formText === undefined ? {} : { text: options.formText }),
        ...(options.engineCommand === undefined
          ? {}
          : {
              localize: (text: string) => withEngineCommand(text, options.engineCommand as string),
            }),
        ...(options.elicitationHooked === undefined ? {} : { toolHook: options.elicitationHooked }),
        // In Cursor a form may stay pending without ever showing (Windows reports): until
        // one was answered in this session, it is given a short delay, then the chat is used.
        ...(isCursorClient(session.client) && session.form !== "works"
          ? { timeoutMs: options.cursorFormProbeMs ?? CURSOR_FORM_PROBE_MS }
          : {}),
      };
      const modernPrompt =
        request !== undefined && modern
          ? modernCreatorPromptOf({
              ...common,
              capabilities: envelopeKey(request, CLIENT_CAPABILITIES_META_KEY) as
                | ClientCapabilities
                | undefined,
              responses: request.mcpReq.inputResponses,
              state: request.mcpReq.requestState(),
              now: shared.now ?? Date.now,
              agent: askingAgent(input),
              claim: claimState,
              aborted: () => request.mcpReq.signal.aborted,
            })
          : undefined;
      const creatorPrompt =
        request === undefined || modern
          ? modernPrompt?.port
          : creatorPromptOf({
              ...common,
              capabilities: server.server.getClientCapabilities(),
              elicit: (params, elicitOptions) => waitForCreator(request, params, elicitOptions),
              aborted: () => request.mcpReq.signal.aborted,
            });
      // The AI tool's question tool as a channel of the decisions, in Claude Code with a
      // person at it. The engine dictates the questions; a hook records the creator's answers.
      const anotherHook = await options.questionToolHooked?.().catch(() => true);
      const questionTool = questionToolOf({
        available:
          isHookedClient(session.client) &&
          !isAntigravityClient(session.client) &&
          !isCodexClient(session.client) &&
          !isCursorClient(session.client) &&
          !(options.entrypoint ?? "").toLowerCase().startsWith("sdk") &&
          anotherHook !== true,
        ...(options.formText === undefined ? {} : { text: options.formText }),
        ...(options.engineCommand === undefined
          ? {}
          : {
              localize: (text: string) => withEngineCommand(text, options.engineCommand as string),
            }),
      });
      const callContext: CommandContext = {
        ...context,
        ...(conversation === undefined ? {} : { conversation }),
        ...(creatorPrompt === undefined ? {} : { creatorPrompt }),
        questionTool,
      };
      try {
        await options.beforeCall?.().catch(() => {});
        const result = await options.registry.run(
          command.name,
          callContext,
          (input ?? {}) as Record<string, unknown>,
        );
        // The form of the first round: the call is not over, the client answers it and retries.
        const form = modernPrompt?.pending();
        if (form !== undefined && request !== undefined) {
          return inputRequired({
            inputRequests: { [FORM_KEY]: inputRequired.elicit(form.params) },
            requestState: await formState.mint(form.state, request),
          });
        }
        const engine = options.engineCommand;
        if (result.ok) {
          const value = localized(result.value, engine);
          return successResult(shape === undefined ? value : shape(value));
        }
        const refused = (result.error as AgentPluggedError).toPayload();
        // A refused input says what the action expects: the schemas the tools publish
        // are lean, so the way to fix a call is in the refusal.
        const hinted =
          refused.code === ErrorCode.INVALID_ARGUMENTS && rename !== undefined
            ? { ...refused, details: { ...refused.details, expected: expectedOf(command, rename) } }
            : refused;
        // The command a refusal names (`delegate`, `next`: plain words the text rewriting leaves
        // alone) is named as the tool and action that reach it.
        const named = commandNotation(hinted.details.command);
        // A field the action publishes under another name (`what`) is named as published.
        const field = hinted.details.field;
        const back = Object.fromEntries(
          Object.entries(rename ?? {}).map(([from, to]) => [to, from]),
        );
        const published =
          typeof field === "string" && rename !== undefined
            ? field.replace(/^[^.]+/, (head) => back[head] ?? head)
            : field;
        const payload = {
          ...hinted,
          details: {
            ...hinted.details,
            ...(named === undefined ? {} : { command: named }),
            ...(published === undefined ? {} : { field: published }),
          },
        };
        return errorResult(localized(payload, engine, ENGINE_ERROR_KEYS), (shown) =>
          localized(options.errorText(shown), engine, "all"),
        );
      } catch (error) {
        const payload: ErrorPayload = {
          code: ErrorCode.UNEXPECTED,
          message_key: "error.unexpected",
          details: { reason: error instanceof Error ? error.message : String(error) },
        };
        return errorResult(payload, options.errorText);
      }
    };
    return run;
  }
  return server;
}

/**
 * Wraps a transport to know when the connection ends (stdin closed by the client, or an error):
 * the stdio entry owns the transport and its callbacks, this only observes them.
 */
class WatchedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  readonly closed: Promise<void>;
  #resolve: () => void = () => {};

  constructor(readonly inner: Transport) {
    this.closed = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  async start(): Promise<void> {
    this.inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => {
      this.onclose?.();
      this.#resolve();
    };
    await this.inner.start();
  }

  send(...args: Parameters<Transport["send"]>): Promise<void> {
    return this.inner.send(...args);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

export interface RunOptions extends AgentServerOptions {
  /** The connection; by default `stdin` and `stdout` (`StdioServerTransport`). */
  readonly transport?: Transport;
  /** Where messages are read (this process's stdin by default). */
  readonly stdin?: Readable;
  /** Where messages are written (this process's stdout by default). */
  readonly stdout?: Writable;
  /** Out-of-band errors (never written to stdout, which carries the protocol). */
  readonly onerror?: (error: Error) => void;
  /** How long the calls in flight may still run once the connection ends (30 s by default). */
  readonly drainTimeoutMs?: number;
}

/** How long the calls in flight may still run once the client closed the connection. */
export const DRAIN_TIMEOUT_MS = 30_000;

/**
 * Serves the agents' tools over stdio until the client closes the connection (end of stdin),
 * then waits for the calls in flight (at most `drainTimeoutMs`, reported through `onerror` when
 * some are still running) and returns: the caller releases the journal (its `git` processes)
 * afterwards. No network port is ever opened.
 */
export async function runAgentServer(options: RunOptions): Promise<void> {
  const pending = new PendingCalls();
  const transport = new WatchedTransport(
    options.transport ?? new StdioServerTransport(options.stdin, options.stdout),
  );
  const handle = serveStdio(() => createAgentServer(options, pending), {
    transport,
    ...(options.onerror === undefined ? {} : { onerror: options.onerror }),
  });
  await transport.closed;
  const timeout = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
  if (!(await pending.settled(timeout))) {
    options.onerror?.(
      new Error(`agentplugged mcp: calls still running after ${timeout} ms were abandoned`),
    );
  }
  await handle.close();
}
