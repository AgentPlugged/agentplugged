import { toBase64url } from "@agentplugged/crypto";
import { ErrorCode, type MethodConfig } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentSession,
  type AgentStateView,
  ANTIGRAVITY_HOOK_PATH,
  autoOption,
  type ChatMessage,
  type CheckpointState,
  CODEX_HOOK_PATH,
  type CommandContext,
  CURSOR_HOOK_PATH,
  chatClientOf,
  chatHookPath,
  computeProjection,
  createCommandRegistry,
  historyEntries,
  initCommand,
  isAntigravityClient,
  isCodexClient,
  isCursorClient,
  isHookedClient,
  MemoryKeyStore,
  MemoryStateStore,
  messageDigest,
  normalizeChatText,
  PROMPT_HOOK_PATH,
  proofSession,
  type RecordedEvent,
  resolveProfile,
  resolveValidationSettings,
  type ToolProbe,
  type ValidationEntry,
} from "../index.js";
import type { MainBranchReader } from "../rules/main-branch.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(9));
const START = Date.UTC(2026, 9, 3, 12, 0, 0);
const SESSION = "5f0c-session-a";

/** The journal's clock: one second per event. */
function clock() {
  let now = START;
  return () => {
    now += 1000;
    return now;
  };
}

/** The hook's store, in memory: messages added as the creator types them. */
class MemoryChatLog {
  readonly list: ChatMessage[] = [];

  say(text: string, at: number, session = SESSION, project?: string): ChatMessage {
    const normalized = normalizeChatText(text);
    const message = {
      session,
      at: new Date(at).toISOString(),
      digest: messageDigest(normalized),
      text: normalized,
      ...(project === undefined ? {} : { project }),
    };
    this.list.push(message);
    return message;
  }

  async messages(session: string): Promise<readonly ChatMessage[]> {
    return this.list.filter((message) => message.session === session);
  }
}

interface Options {
  /** `validation.mode` written in `method.yaml`. */
  readonly mode?: string;
  /** `installs.mode` written in `method.yaml` (`visible` without it). */
  readonly installs?: string;
  /** The tool has the hook (Claude Code). */
  readonly hooked?: boolean;
  readonly client?: string;
  /** The project holds the hook's script (true by default). */
  readonly installed?: boolean;
  /** The product's folder: only the messages of this project count. */
  readonly project?: string;
  /** Antigravity's conversation the calls come from. */
  readonly conversation?: string;
  /** The engine looks for the hook's script in the project (no `hookInstalled` given). */
  readonly lookForScript?: boolean;
}

async function product(options: Options = {}) {
  const files = new MemoryFiles();
  const journal = new MemoryStateStore({ keys: new MemoryKeyStore(SEED), now: clock() });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
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
  if (options.installs !== undefined) {
    const text = await files.readText(".agentplugged/method.yaml");
    await files.writeText(
      ".agentplugged/method.yaml",
      `${text}installs:
  mode: ${options.installs}
`,
    );
  }
  const log = new MemoryChatLog();
  let now = START + 3_600_000;
  const session = new AgentSession(START);
  if (options.client !== undefined) session.noteClient(options.client);
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    journal,
    session,
    now: () => now,
    ...(options.conversation === undefined ? {} : { conversation: options.conversation }),
    chat: {
      log,
      ...(options.lookForScript === true ? {} : { hookInstalled: options.installed ?? true }),
      ...(options.hooked === undefined ? {} : { hooked: options.hooked }),
      ...(options.project === undefined ? {} : { project: options.project }),
    },
  };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown> = {}) =>
    registry.run(name, agent, input);
  const recorded = async (name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
    return result.value as RecordedEvent;
  };
  const state = async () => {
    const result = await call("get_state", { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  /** Opens a checkpoint; the creator's later messages come after it. */
  const open = async (fields: Record<string, unknown> = {}) => {
    const opened = await recorded("open_checkpoint", { ...DECISION, ...fields });
    return { ...opened, id: opened.checkpoint as string, time: Date.parse(opened.at) };
  };
  const projection = () => computeProjection(journal.events);
  return {
    files,
    journal,
    log,
    call,
    recorded,
    state,
    open,
    projection,
    setNow: (value: number) => {
      now = value;
    },
  };
}

const OPTIONS = [
  { id: "stripe", label: "Stripe", consequence: "Fast to ship." },
  { id: "paddle", label: "Paddle", consequence: "Handles VAT for us." },
];

const DECISION = {
  agent: "main",
  type: "decision",
  risk: "medium",
  title: "Payment provider",
  summary: "Which provider do we launch with?",
  story: "2-6",
  blocks: [{ action: "story.review", story: "2-6" }],
  options: OPTIONS,
  recommendation: "paddle",
};

const answer = (checkpoint: string, fields: Record<string, unknown> = {}) => ({
  agent: "main",
  checkpoint,
  decision: "approved",
  quote: "Valide",
  session: SESSION,
  ...fields,
});

describe("validation level", () => {
  const config = { format_version: 2, engine_version: "1.0.0" } as MethodConfig;
  const reader = (text: string | undefined): MainBranchReader => ({
    read: async () => ({ found: true, branch: "origin/main", text }),
  });

  it("is chat without a setting, the main branch's otherwise, strict when unreadable there", async () => {
    expect((await resolveValidationSettings(config, undefined)).mode).toBe("chat");
    expect(
      (await resolveValidationSettings({ ...config, validation: { mode: "auto" } }, undefined))
        .mode,
    ).toBe("auto");
    // The main branch wins over the working copy.
    const main = await resolveValidationSettings(
      { ...config, validation: { mode: "auto" } },
      reader("validation:\n  mode: strict\n"),
    );
    expect(main).toEqual({ mode: "strict", source: "main", warning: null, unpublished: null });
    expect((await resolveValidationSettings(config, reader("format_version: 2\n"))).mode).toBe(
      "chat",
    );
    const broken = await resolveValidationSettings(config, reader("validation:\n  mode: fast\n"));
    expect(broken).toEqual({
      mode: "strict",
      source: "main",
      warning: { kind: "main_validation_invalid", branch: "origin/main" },
      unpublished: null,
    });
  });

  it("applies the settings of the local main branch at once, and says what is not published", async () => {
    const local: MainBranchReader = {
      read: async () => ({
        found: true,
        branch: "main",
        text: "validation:\n  mode: auto\n  points: [framing]\n",
        unpublished: { remote: "origin/main", ahead: 2 },
      }),
    };
    const settings = await resolveValidationSettings(config, local);
    expect(settings).toMatchObject({
      mode: "auto",
      points: ["framing"],
      source: "main",
      unpublished: { branch: "main", remote: "origin/main", ahead: 2 },
    });
  });
});

describe("answer_checkpoint with the hook", () => {
  it("records the creator's quoted answer, proved by the hook: via the chat, assurance chat", async () => {
    const { call, open, log, state, journal } = await product({ hooked: true });
    const opened = await open();
    const message = log.say("Valide !", opened.time + 5000);
    const result = await call("answer_checkpoint", answer(opened.id, { quote: "« valide »" }));
    expect(result.ok).toBe(true);
    const event = journal.events.at(-1);
    expect(event?.type).toBe("checkpoint.answered");
    expect(event?.actor).toMatchObject({ kind: "agent", agent: "main" });
    expect(event?.payload).toEqual({
      checkpoint: opened.id,
      decision: "approved",
      source: "chat",
      quote: "« valide »",
      proof: { message: { digest: message.digest, at: message.at } },
    });
    const view = await state();
    const checkpoint = view.checkpoints[opened.id] as CheckpointState;
    expect(checkpoint.status).toBe("resolved");
    expect(checkpoint.resolution).toMatchObject({
      source: "chat",
      assurance: "chat",
      quote: "« valide »",
      relayed_by: "main",
    });
    expect(view.stories["2-6"]?.waiting_on).toEqual([]);
  });

  it("knows the hook from the MCP client's name", async () => {
    const { call, open, log } = await product({ client: "claude-code" });
    const opened = await open();
    const refused = await call("answer_checkpoint", answer(opened.id));
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    log.say("valide", opened.time + 1000);
    expect((await call("answer_checkpoint", answer(opened.id))).ok).toBe(true);
  });

  it("refuses a quote the creator never sent: nothing written, the checkpoint stays open", async () => {
    const { call, open, journal, state } = await product({ hooked: true });
    const opened = await open();
    const before = journal.events.length;
    const result = await call("answer_checkpoint", answer(opened.id));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect(result.error.details).toMatchObject({ checkpoint: opened.id, reason: "no_message" });
    expect(journal.events.length).toBe(before);
    expect((await state()).checkpoints[opened.id]?.status).toBe("open");
  });

  it("refuses a message sent before the checkpoint opened, a part of a message, another session", async () => {
    const { call, open, log } = await product({ hooked: true });
    log.say("valide", START + 500);
    const opened = await open();
    const before = await call("answer_checkpoint", answer(opened.id));
    expect(before.ok ? undefined : before.error.details.reason).toBe("before_opening");

    log.say("Ne valide pas", opened.time + 1000);
    const partial = await call("answer_checkpoint", answer(opened.id));
    expect(partial.ok ? undefined : partial.error.details.reason).toBe("before_opening");

    log.say("valide", opened.time + 2000, "another-session");
    const other = await call("answer_checkpoint", answer(opened.id));
    expect(other.ok).toBe(false);
    const elsewhere = await call(
      "answer_checkpoint",
      answer(opened.id, { session: "another-session" }),
    );
    expect(elsewhere.ok).toBe(true);
  });

  it("accepts the agreement given just before the point opened, for exactly its decision", async () => {
    const { call, open, log, state, journal } = await product({ hooked: true });
    const opened = await open();
    // « C déjà validé », said while the agent was still opening the point: five minutes before.
    log.say("valide", opened.time - 5 * 60_000);
    // Without the flag, the message of before the opening is refused as ever.
    const plain = await call("answer_checkpoint", answer(opened.id));
    expect(plain.ok ? undefined : plain.error.details.reason).toBe("before_opening");
    const anticipated = await call("answer_checkpoint", answer(opened.id, { anticipated: true }));
    expect(anticipated.ok).toBe(true);
    expect((await state()).checkpoints[opened.id]?.status).toBe("resolved");
    // The journal says so, and the engine's projection took it (nothing ignored).
    const written = journal.events.filter((event) => event.type === "checkpoint.answered");
    expect(written).toHaveLength(1);
    expect(written[0]?.payload).toMatchObject({ anticipated: true, quote: "Valide" });
    expect((await computeProjection(journal.events)).ignored).toEqual([]);
  });

  it("never reaches further back than a few minutes, nor reuses a message", async () => {
    const { call, open, log } = await product({ hooked: true });
    const opened = await open();
    log.say("valide", opened.time - 40 * 60_000);
    const old = await call("answer_checkpoint", answer(opened.id, { anticipated: true }));
    expect(old.ok ? undefined : old.error.details.reason).toBe("before_opening");
    log.say("valide", opened.time - 60_000);
    expect((await call("answer_checkpoint", answer(opened.id, { anticipated: true }))).ok).toBe(
      true,
    );
    const second = await open({ story: "2-7", blocks: [] });
    const again = await call("answer_checkpoint", answer(second.id, { anticipated: true }));
    expect(again.ok ? undefined : again.error.details.reason).toBe("already_cited");
  });

  it("never lets an early agreement answer a high risk, and cites the one closest to the opening", async () => {
    const { call, open, log } = await product({ hooked: true });
    const risky = await open({ risk: "high" });
    log.say("valide", risky.time - 60_000);
    const refused = await call("answer_checkpoint", answer(risky.id, { anticipated: true }));
    expect(refused.ok ? undefined : refused.error.details.reason).toBe("before_opening");
    const plain = await open({ story: "2-8", blocks: [] });
    log.say("valide", plain.time - 20 * 60_000);
    log.say("valide", plain.time - 2 * 60_000);
    expect((await call("answer_checkpoint", answer(plain.id, { anticipated: true }))).ok).toBe(
      true,
    );
  });

  it("refuses a question for an answer, and a message older than a day", async () => {
    const { call, open, log, setNow } = await product({ hooked: true });
    const opened = await open();
    log.say("On valide ?", opened.time + 1000);
    const question = await call("answer_checkpoint", answer(opened.id, { quote: "on valide" }));
    expect(question.ok ? undefined : question.error.details.reason).toBe("no_message");
    log.say("on valide", opened.time + 2000);
    setNow(opened.time + 2000 + 25 * 3_600_000);
    const old = await call("answer_checkpoint", answer(opened.id, { quote: "on valide" }));
    expect(old.ok ? undefined : old.error.details.reason).toBe("no_message");
  });

  it("uses one message for one checkpoint only", async () => {
    const { call, open, log } = await product({ hooked: true });
    const first = await open();
    const second = await open({ story: "2-7", blocks: [] });
    log.say("valide", second.time + 1000);
    expect((await call("answer_checkpoint", answer(first.id))).ok).toBe(true);
    const again = await call("answer_checkpoint", answer(second.id));
    expect(again.ok ? undefined : again.error.details.reason).toBe("already_cited");
    log.say("valide", second.time + 2000);
    expect((await call("answer_checkpoint", answer(second.id))).ok).toBe(true);
  });

  it("needs the tool's session id", async () => {
    const { call, open, log } = await product({ hooked: true });
    const opened = await open();
    log.say("valide", opened.time + 1000);
    const result = await call("answer_checkpoint", answer(opened.id, { session: undefined }));
    expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.CHAT_SESSION_REQUIRED);
  });

  it("chooses an option the checkpoint has, and refuses a closed checkpoint", async () => {
    const { call, open, log, state } = await product({ hooked: true });
    const opened = await open();
    log.say("prends l'option 2", opened.time + 1000);
    const unknown = await call(
      "answer_checkpoint",
      answer(opened.id, { decision: "option_chosen", option: "nope", quote: "prends l'option 2" }),
    );
    expect(unknown.ok ? undefined : unknown.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    const chosen = await call(
      "answer_checkpoint",
      answer(opened.id, {
        decision: "option_chosen",
        option: "paddle",
        quote: "Prends l’option 2",
      }),
    );
    expect(chosen.ok).toBe(true);
    expect((await state()).checkpoints[opened.id]?.resolution).toMatchObject({
      decision: "option_chosen",
      option: "paddle",
    });
    log.say("valide", opened.time + 2000);
    const closed = await call("answer_checkpoint", answer(opened.id));
    expect(closed.ok ? undefined : closed.error.code).toBe(ErrorCode.CHECKPOINT_NOT_OPEN);
    const missing = await call("answer_checkpoint", answer("G-0000000000"));
    expect(missing.ok ? undefined : missing.error.code).toBe(ErrorCode.CHECKPOINT_NOT_FOUND);
  });

  it("keeps a refusal's blocks, with the quote as its note", async () => {
    const { call, open, log, state } = await product({ hooked: true });
    const opened = await open();
    log.say("non, refais-le", opened.time + 1000);
    const refused = await call(
      "answer_checkpoint",
      answer(opened.id, { decision: "rejected", quote: "Non, refais-le." }),
    );
    expect(refused.ok).toBe(true);
    const view = await state();
    expect(view.checkpoints[opened.id]?.resolution?.note).toBe("Non, refais-le.");
    expect(view.stories["2-6"]?.waiting_on).toEqual([opened.id]);
  });
});

describe("irreversible actions in the chat: one message is the whole answer", () => {
  const IRREVERSIBLE = { type: "release", risk: "medium", irreversible: true, options: undefined };

  it("validates with one message, no confirmation, and traces the proof", async () => {
    const { call, open, log, journal, state } = await product({ hooked: true });
    const opened = await open({ ...IRREVERSIBLE, recommendation: undefined });
    const message = log.say("fusionne la story 2.6", opened.time + 1000);
    const done = await call(
      "answer_checkpoint",
      answer(opened.id, { quote: "fusionne la story 2.6" }),
    );
    expect(done.ok).toBe(true);
    const payload = journal.events.at(-1)?.payload;
    expect(payload).toMatchObject({ proof: { message: { digest: message.digest } } });
    expect(payload).not.toHaveProperty("confirmation_quote");
    const resolution = (await state()).checkpoints[opened.id]?.resolution;
    // The trace stays whole: who, what, when, proof, channel.
    expect(resolution).toMatchObject({
      decision: expect.any(String),
      assurance: "chat",
      source: "chat",
      relayed_by: "main",
      quote: "fusionne la story 2.6",
    });
    expect(resolution?.at).toEqual(expect.any(String));
  });

  it("refuses a confirmation sent along: the engine asks for none", async () => {
    const { call, open, log } = await product({ hooked: true });
    const opened = await open({ ...IRREVERSIBLE, recommendation: undefined });
    log.say("fusionne", opened.time + 1000);
    const result = await call(
      "answer_checkpoint",
      answer(opened.id, { quote: "fusionne", confirmation_quote: "oui je confirme" }),
    );
    expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });

  it("without the hook, one message answers it, recorded unverified", async () => {
    const { call, open, state } = await product();
    const opened = await open({ ...IRREVERSIBLE, recommendation: undefined });
    const done = await call("answer_checkpoint", answer(opened.id, { quote: "fusionne" }));
    expect(done.ok).toBe(true);
    expect((await state()).checkpoints[opened.id]?.resolution?.assurance).toBe("chat_unverified");
  });
});

describe("answer_checkpoint without hooks", () => {
  it("accepts the answer unverified: chat_unverified everywhere", async () => {
    const { call, open, state, journal, projection } = await product({ client: "cursor" });
    const opened = await open();
    const result = await call("answer_checkpoint", answer(opened.id, { session: undefined }));
    expect(result.ok).toBe(true);
    expect(journal.events.at(-1)?.payload).not.toHaveProperty("proof");
    const view = await state();
    expect(view.checkpoints[opened.id]?.resolution?.assurance).toBe("chat_unverified");
    expect(view.validation).toMatchObject({ mode: "chat", proof: "unverified" });
    const [entry] = historyEntries(await projection(), journal.events);
    expect(entry).toMatchObject({
      source: "chat",
      assurance: "chat_unverified",
      quote: "Valide",
      relayed_by: "main",
    });
  });

  it("answers an installation the creator validates unverified at the chat level", async () => {
    const { call, recorded, state } = await product({ installs: "validate" });
    const gate = await recorded("request_action", {
      agent: "main",
      action: "install_dependency",
      detail: "npm install left-pad",
    });
    const result = await call("answer_checkpoint", answer(gate.checkpoint as string));
    expect(result.ok).toBe(true);
    expect((await state()).checkpoints[gate.checkpoint as string]?.resolution?.assurance).toBe(
      "chat_unverified",
    );
  });

  it("keeps the terminal for it at the strict level only", async () => {
    const { call, recorded } = await product({ mode: "strict", installs: "validate" });
    const gate = await recorded("request_action", {
      agent: "main",
      action: "install_dependency",
      detail: "npm install left-pad",
    });
    const result = await call("answer_checkpoint", answer(gate.checkpoint as string));
    expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.REVIEW_REQUIRED);
    expect(result.ok ? undefined : result.error.details).toMatchObject({
      reason: "strict_high_risk",
      command: `npx agentplugged review ${gate.checkpoint}`,
    });
  });
});

describe("strict level", () => {
  it("sends a high risk to review, answers the rest in the chat", async () => {
    const { call, open, log, state } = await product({ mode: "strict", hooked: true });
    const high = await open({ risk: "high" });
    log.say("valide", high.time + 1000);
    const refused = await call("answer_checkpoint", answer(high.id));
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.REVIEW_REQUIRED);
    expect(refused.ok ? undefined : refused.error.details).toMatchObject({
      reason: "strict_high_risk",
      command: `npx agentplugged review ${high.id}`,
    });
    expect((await state()).validation.review).toEqual([high.id]);
    const medium = await open({ story: "2-7", blocks: [] });
    log.say("ok", medium.time + 1000);
    expect((await call("answer_checkpoint", answer(medium.id, { quote: "ok" }))).ok).toBe(true);
  });
});

describe("auto level", () => {
  it("applies the recommended option of a low-risk checkpoint, and the creator reopens it", async () => {
    const { call, open, log, state, journal, projection } = await product({
      mode: "auto",
      hooked: true,
    });
    const low = await open({ risk: "low" });
    expect(low.auto_applied).toEqual({ checkpoint: low.id, option: "paddle" });
    const auto = journal.events.at(-1);
    expect(auto?.type).toBe("checkpoint.auto_applied");
    expect(auto?.actor.kind).toBe("system");
    let view = await state();
    expect(view.checkpoints[low.id]?.resolution).toMatchObject({
      source: "auto",
      assurance: "system",
      option: "paddle",
    });
    expect(view.stories["2-6"]?.waiting_on).toEqual([]);

    // The medium risk goes through the chat.
    const medium = await open({ story: "2-7", blocks: [] });
    expect(medium.auto_applied).toBeUndefined();
    expect((await state()).checkpoints[medium.id]?.status).toBe("open");

    // Reopened from the chat: open again, blocking again.
    const notReopenable = await call(
      "answer_checkpoint",
      answer(medium.id, { decision: "reopen", quote: "annule" }),
    );
    expect(notReopenable.ok ? undefined : notReopenable.error.code).toBe(
      ErrorCode.CHECKPOINT_NOT_REOPENABLE,
    );
    log.say("annule ça", Date.parse(auto?.at as string) + 1000);
    const reopened = await call(
      "answer_checkpoint",
      answer(low.id, { decision: "reopen", quote: "Annule ça" }),
    );
    expect(reopened.ok).toBe(true);
    view = await state();
    expect(view.checkpoints[low.id]?.status).toBe("open");
    expect(view.checkpoints[low.id]?.resolution).toBeNull();
    expect(view.stories["2-6"]?.waiting_on).toEqual([low.id]);
    const validations = (await projection()).state.validations as ValidationEntry[];
    expect(validations.map((entry) => [entry.decision, entry.source])).toEqual([
      ["option_chosen", "auto"],
      ["reopened", "chat"],
    ]);
  });

  it("never applies an irreversible, a story, a document, a permission, a superseding, a measured or a security checkpoint on its own", async () => {
    const { open } = await product({ mode: "auto" });
    for (const fields of [
      { risk: "low", irreversible: true },
      { risk: "low", type: "story" },
      { risk: "low", type: "document" },
      { risk: "low", type: "permission" },
      {
        risk: "low",
        criteria: [{ id: "c", metric: "coverage", op: ">=", threshold: 1, severity: "blocking" }],
      },
      { risk: "low", recipient_role: "security" },
    ]) {
      const opened = await open({ story: "2-8", blocks: [], ...fields });
      expect(opened.auto_applied).toBeUndefined();
    }
  });

  it("applies a checkpoint of a session that read external content too", async () => {
    const { open, recorded } = await product({ mode: "auto" });
    await recorded("record_external_read", {
      tool: "WebFetch",
      source: "https://example.com/page",
    });
    expect((await open({ risk: "low" })).auto_applied).toEqual({
      checkpoint: expect.stringMatching(/^G-/),
      option: "paddle",
    });
  });

  it("leaves a low-risk checkpoint open at the chat level", async () => {
    const { open } = await product();
    expect((await open({ risk: "low" })).auto_applied).toBeUndefined();
  });
});

describe("projection of the chat's events", () => {
  it("ignores an automatic application not written with its checkpoint, or by an agent", async () => {
    const { journal, open, projection, recorded } = await product();
    const opened = await open({ risk: "low" });
    await recorded("report_status", { agent: "main", status: "working" });
    const product_id = journal.events.at(-1)?.product as string;
    await journal.appendAll([
      {
        type: "checkpoint.auto_applied",
        actor: { kind: "system" },
        product: product_id,
        provenance: "trusted",
        payload: { checkpoint: opened.id, decision: "option_chosen", option: "paddle" },
      },
      {
        type: "checkpoint.answered",
        actor: { kind: "system" },
        product: product_id,
        provenance: "trusted",
        payload: { checkpoint: opened.id, decision: "approved", source: "chat", quote: "ok" },
      },
    ]);
    const state = await projection();
    expect(state.ignored.map((entry) => entry.reason)).toEqual(["invalid", "invalid"]);
    const checkpoints = state.state.checkpoints as Record<string, CheckpointState>;
    expect(checkpoints[opened.id]?.status).toBe("open");
  });
});

describe("review findings", () => {
  it("never applies a checkpoint that supersedes another", () => {
    const base = {
      type: "decision" as const,
      risk: "low" as const,
      irreversible: false,
      options: [
        { id: "a", label: "A", consequence: "a" },
        { id: "b", label: "B", consequence: "b" },
      ],
      recommendation: "b",
    };
    expect(autoOption(base)).toBe("b");
    expect(autoOption({ ...base, supersedes: "G-AAAAAAAAAA" })).toBeUndefined();
    // What a session read is no reason to refuse.
    expect(autoOption({ ...base, untrusted: { reads: [{}] } } as never)).toBe("b");
  });

  it("answers hook_missing in Claude Code without the hook's script, never unverified", async () => {
    const { call, open, log } = await product({ hooked: true, installed: false });
    const opened = await open();
    log.say("valide", opened.time + 1000);
    const result = await call("answer_checkpoint", answer(opened.id));
    expect(result.ok ? undefined : result.error.details).toMatchObject({ reason: "hook_missing" });
  });

  it("knows Codex's hook from its client name, and looks for its own script", async () => {
    for (const name of ["codex-mcp-client", "codex_vscode", "Codex Desktop", "codex"]) {
      expect(isCodexClient(name), name).toBe(true);
      expect(isHookedClient(name), name).toBe(true);
      expect(chatHookPath(name)).toBe(CODEX_HOOK_PATH);
    }
    for (const name of [
      "claude-code",
      "cursor",
      "my-codex-fork",
      "antigravity-client",
      undefined,
    ]) {
      expect(isCodexClient(name), String(name)).toBe(false);
    }
    // The project holds Claude Code's script only: for Codex that is no hook at all.
    const claudeOnly = await product({ client: "codex-mcp-client", lookForScript: true });
    await claudeOnly.files.writeText(PROMPT_HOOK_PATH, "// script");
    const first = await claudeOnly.open();
    claudeOnly.log.say("valide", first.time + 1000);
    const missing = await claudeOnly.call("answer_checkpoint", answer(first.id));
    expect(missing.ok ? undefined : missing.error.details).toMatchObject({
      reason: "hook_missing",
    });

    const { call, open, log, files } = await product({
      client: "codex-mcp-client",
      lookForScript: true,
    });
    await files.writeText(CODEX_HOOK_PATH, "// script");
    const opened = await open();
    // The hook did not record the message (the creator has not approved the hooks yet): refused, not unverified.
    const refused = await call("answer_checkpoint", answer(opened.id));
    expect(refused.ok ? undefined : refused.error.details).toMatchObject({ reason: "no_message" });
    log.say("valide", opened.time + 1000);
    expect((await call("answer_checkpoint", answer(opened.id))).ok).toBe(true);
  });

  it("knows the Cursor editor's hook from its client name, and only the editor's", async () => {
    expect(isCursorClient("cursor-vscode")).toBe(true);
    expect(isHookedClient("cursor-vscode")).toBe(true);
    expect(chatHookPath("cursor-vscode")).toBe(CURSOR_HOOK_PATH);
    // The CLI does not emit the hook that records the messages (forum, 2026-08-21): not a hooked client.
    for (const name of ["cursor", "cursor-cli", "cursor-agent", "my-cursor-vscode", undefined]) {
      expect(isCursorClient(name), String(name)).toBe(false);
      expect(isHookedClient(name), String(name)).toBe(false);
    }
    const claudeOnly = await product({ client: "cursor-vscode", lookForScript: true });
    await claudeOnly.files.writeText(PROMPT_HOOK_PATH, "// script");
    const first = await claudeOnly.open();
    claudeOnly.log.say("valide", first.time + 1000);
    const missing = await claudeOnly.call("answer_checkpoint", answer(first.id));
    expect(missing.ok ? undefined : missing.error.details).toMatchObject({
      reason: "hook_missing",
    });

    const { call, open, log, files } = await product({
      client: "cursor-vscode",
      lookForScript: true,
    });
    await files.writeText(CURSOR_HOOK_PATH, "// script");
    const opened = await open();
    // The hook did not record the message (the workspace is not trusted): refused, not unverified.
    const refused = await call("answer_checkpoint", answer(opened.id));
    expect(refused.ok ? undefined : refused.error.details).toMatchObject({ reason: "no_message" });
    log.say("valide", opened.time + 1000);
    expect((await call("answer_checkpoint", answer(opened.id))).ok).toBe(true);

    // The Cursor CLI answers are recorded unverified, said so, as for a tool without hook.
    const cli = await product({ client: "cursor-cli" });
    const cliOpened = await cli.open();
    expect(
      (await cli.call("answer_checkpoint", answer(cliOpened.id, { session: undefined }))).ok,
    ).toBe(true);
  });

  it("knows Antigravity CLI's hook from its client name, and looks for its own script", async () => {
    // The project holds Claude Code's script only: for Antigravity that is no hook at all.
    const claudeOnly = await product({
      client: "antigravity-client",
      conversation: SESSION,
      lookForScript: true,
    });
    await claudeOnly.files.writeText(PROMPT_HOOK_PATH, "// script");
    const first = await claudeOnly.open();
    claudeOnly.log.say("valide", first.time + 1000);
    const missing = await claudeOnly.call("answer_checkpoint", answer(first.id));
    expect(missing.ok ? undefined : missing.error.details).toMatchObject({
      reason: "hook_missing",
    });

    const { call, open, log, files } = await product({
      client: "antigravity-client",
      conversation: SESSION,
      lookForScript: true,
    });
    await files.writeText(ANTIGRAVITY_HOOK_PATH, "// script");
    const opened = await open();
    const refused = await call("answer_checkpoint", answer(opened.id));
    expect(refused.ok ? undefined : refused.error.details).toMatchObject({ reason: "no_message" });
    log.say("valide", opened.time + 1000);
    expect((await call("answer_checkpoint", answer(opened.id))).ok).toBe(true);
    // An Antigravity client whose call names no conversation (no `_meta`): the session the agent
    // gives is its own word, and proves nothing.
    const unbound = await product({ client: "antigravity-client", lookForScript: true });
    await unbound.files.writeText(ANTIGRAVITY_HOOK_PATH, "// script");
    const lone = await unbound.open();
    unbound.log.say("valide", lone.time + 1000);
    const unproved = await unbound.call("answer_checkpoint", answer(lone.id));
    expect(unproved.ok ? undefined : unproved.error.details).toMatchObject({
      reason: "no_message",
    });
    // Claude Code's own script does not make Antigravity's missing one a hook.
    expect(chatHookPath("antigravity-client")).toBe(ANTIGRAVITY_HOOK_PATH);
    expect(chatHookPath("claude-code")).toBe(PROMPT_HOOK_PATH);
    expect(chatHookPath(undefined)).toBe(PROMPT_HOOK_PATH);
    for (const name of [
      "antigravity-client",
      "Antigravity",
      "antigravity_cli",
      "antigravity cli",
    ]) {
      expect(isAntigravityClient(name), name).toBe(true);
      expect(isHookedClient(name), name).toBe(true);
    }
    for (const name of [
      "antigravity-evil",
      "my-antigravity-client",
      "gemini-cli",
      "cursor",
      undefined,
    ]) {
      expect(isAntigravityClient(name), String(name)).toBe(false);
    }
  });

  it("proves an answer by the messages of the conversation the call comes from, and no other", async () => {
    const conversation = "9eae3f94-67bd-4732-aee1-32feeb86e0ba";
    const nested = "3d01a65d-7dd1-4126-9a93-0330910bf34b";
    const { call, open, log } = await product({
      client: "antigravity-client",
      conversation,
      installed: true,
    });
    const opened = await open();
    // A session an agent started itself (`agy -p`), or a sub-agent's: its own conversation, with
    // a message "of the creator" the hook recorded under that id.
    log.say("valide", opened.time + 1000, nested);
    const forged = await call("answer_checkpoint", answer(opened.id, { session: nested }));
    expect(forged.ok ? undefined : forged.error.code).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect(forged.ok ? undefined : forged.error.details.reason).toBe("no_message");
    // No other conversation either when the agent names none.
    const none = await call("answer_checkpoint", answer(opened.id, { session: undefined }));
    expect(none.ok ? undefined : none.error.code).toBe(ErrorCode.CHAT_SESSION_REQUIRED);
    // The conversation's own message, whatever the case of its id.
    log.say("valide", opened.time + 2000, conversation);
    const own = await call(
      "answer_checkpoint",
      answer(opened.id, { session: conversation.toUpperCase() }),
    );
    expect(own.ok).toBe(true);
  });

  it("takes a call that names an Antigravity conversation for Antigravity, whatever name the client announced", async () => {
    const conversation = "9eae3f94-67bd-4732-aee1-32feeb86e0ba";
    const { call, open, log, files } = await product({
      client: "some-editor",
      conversation,
      lookForScript: true,
    });
    await files.writeText(ANTIGRAVITY_HOOK_PATH, "// script");
    const opened = await open();
    log.say("valide", opened.time + 1000, conversation);
    expect((await call("answer_checkpoint", answer(opened.id, { session: conversation }))).ok).toBe(
      true,
    );
    expect(chatClientOf({ conversation })).toBe("antigravity-client");
    expect(chatClientOf({ session: { client: "claude-code" } })).toBe("claude-code");
    expect(chatClientOf({})).toBeUndefined();
  });

  it("keeps the session the agent names where the tool names no conversation (Claude Code)", () => {
    expect(proofSession("abc", undefined)).toBe("abc");
    expect(proofSession(undefined, undefined)).toBeUndefined();
    expect(proofSession(undefined, "conv")).toBeUndefined();
    expect(proofSession("CONV", " conv ")).toBe("conv");
    expect(proofSession("other", "conv")).toBeUndefined();
  });

  it("counts only the messages of this project's sessions", async () => {
    const { call, open, log } = await product({ hooked: true, project: "C:\\Work\\Product" });
    const opened = await open();
    log.say("valide", opened.time + 1000, SESSION, "C:/Work/Other");
    const other = await call("answer_checkpoint", answer(opened.id));
    expect(other.ok ? undefined : other.error.details.reason).toBe("no_message");
    log.say("valide", opened.time + 2000, SESSION, "c:/work/product/");
    expect((await call("answer_checkpoint", answer(opened.id))).ok).toBe(true);
  });

  it("asks no confirmation to refuse an irreversible action", async () => {
    const { call, open, log } = await product({ hooked: true });
    const opened = await open({
      type: "release",
      irreversible: true,
      options: undefined,
      recommendation: undefined,
    });
    log.say("non", opened.time + 1000);
    const refused = await call(
      "answer_checkpoint",
      answer(opened.id, { decision: "rejected", quote: "non" }),
    );
    expect(refused.ok).toBe(true);
  });

  it("lets the message of a reopening answer the checkpoint next", async () => {
    const { call, open, log, journal, state } = await product({ mode: "auto", hooked: true });
    const low = await open({ risk: "low" });
    const at = Date.parse(journal.events.at(-1)?.at as string);
    log.say("annule et prends stripe", at + 1000);
    const quote = "annule et prends stripe";
    expect(
      (await call("answer_checkpoint", answer(low.id, { decision: "reopen", quote }))).ok,
    ).toBe(true);
    const chosen = await call(
      "answer_checkpoint",
      answer(low.id, { decision: "option_chosen", option: "stripe", quote }),
    );
    expect(chosen.ok).toBe(true);
    expect((await state()).checkpoints[low.id]?.resolution?.option).toBe("stripe");
  });

  it("ignores in the journal a proof that does not hold together", async () => {
    const { journal, open, projection } = await product();
    const opened = await open();
    const product_id = journal.events.at(-1)?.product as string;
    await journal.appendAll([
      {
        type: "checkpoint.answered",
        actor: { kind: "agent", agent: "main" },
        product: product_id,
        provenance: "trusted",
        payload: {
          checkpoint: opened.id,
          decision: "approved",
          source: "chat",
          quote: "valide",
          proof: {
            message: { digest: "b".repeat(64), at: new Date(opened.time + 1).toISOString() },
          },
        },
      },
    ]);
    const state = await projection();
    expect(state.ignored.map((entry) => entry.reason)).toEqual(["invalid"]);
  });

  it("holds a reopening seen before its checkpoint, then applies it", async () => {
    const { journal, open, projection } = await product({ mode: "auto" });
    const low = await open({ risk: "low" });
    const product_id = journal.events.at(-1)?.product as string;
    await journal.appendAll([
      {
        type: "checkpoint.reopened",
        actor: { kind: "agent", agent: "main" },
        product: product_id,
        provenance: "trusted",
        payload: { checkpoint: low.id, source: "chat", quote: "annule" },
      },
    ]);
    // Projected in another order (the reopening first): the result is the same.
    const events = [...journal.events];
    const reopening = events.pop();
    const reordered = await computeProjection([
      ...events.filter(
        (event) => event.type === "device.registered" || event.type === "product.created",
      ),
      ...(reopening === undefined ? [] : [reopening]),
      ...events.filter(
        (event) => event.type !== "device.registered" && event.type !== "product.created",
      ),
    ]);
    const direct = await projection();
    for (const state of [direct, reordered]) {
      const checkpoints = state.state.checkpoints as Record<string, CheckpointState>;
      expect(checkpoints[low.id]?.status).toBe("open");
    }
  });
});

describe("the merge gate", () => {
  it("only refuses a held merge checkpoint from the chat, never approves it", async () => {
    const { call, open, log, journal, state } = await product({ hooked: true });
    const merge = await open({
      type: "story",
      risk: "medium",
      story: "2-9",
      blocks: [],
      options: undefined,
      recommendation: undefined,
    });
    const product_id = journal.events.at(-1)?.product as string;
    await journal.appendAll([
      {
        type: "story.started",
        actor: { kind: "agent", agent: "main" },
        product: product_id,
        story: "2-9",
        provenance: "trusted",
        payload: {
          agent: "main",
          branch: "feat/2-9-chat",
          base: "a".repeat(40),
          base_ref: "main",
          worktree: "../product.worktrees/2-9",
        },
      },
    ]);
    log.say("valide", merge.time + 1000);
    const approved = await call("answer_checkpoint", answer(merge.id));
    expect(approved.ok ? undefined : approved.error.code).toBe(ErrorCode.MERGE_NOT_READY);
    log.say("non, pas encore", merge.time + 2000);
    const refused = await call(
      "answer_checkpoint",
      answer(merge.id, { decision: "rejected", quote: "non, pas encore" }),
    );
    expect(refused.ok).toBe(true);
    expect((await state()).checkpoints[merge.id]?.resolution?.decision).toBe("rejected");
  });
});

describe("a plain approval of a recommendation", () => {
  /** What the method tells an agent to record for "ok": the recommendation, the whole message. */
  const approve = (checkpoint: string, quote: string) =>
    answer(checkpoint, { decision: "option_chosen", option: "paddle", quote });

  it.each(["ok", "oui", "vas-y", "d'accord", "parfait"])(
    "records « %s » as the recommended option, with the whole message as the quote",
    async (message) => {
      const { call, open, log, state, journal } = await product({ hooked: true });
      const opened = await open();
      const said = log.say(message, opened.time + 1000);
      const result = await call("answer_checkpoint", approve(opened.id, message));
      expect(result.ok).toBe(true);
      expect(journal.events.at(-1)?.payload).toMatchObject({
        decision: "option_chosen",
        option: "paddle",
        quote: message,
        proof: { message: { digest: said.digest } },
      });
      const checkpoint = (await state()).checkpoints[opened.id] as CheckpointState;
      expect(checkpoint.resolution).toMatchObject({
        decision: "option_chosen",
        option: "paddle",
        quote: message,
        assurance: "chat",
      });
    },
  );

  it("counts only after the checkpoint opened: an « ok » sent before it is refused", async () => {
    const { call, open, log, state } = await product({ hooked: true });
    // The agent asked "qu'en dis-tu ?" with no point open: the creator's « ok » predates it.
    log.say("ok", START + 500);
    const opened = await open();
    const refused = await call("answer_checkpoint", approve(opened.id, "ok"));
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect((await state()).checkpoints[opened.id]?.status).toBe("open");
    // Asked again on the open point, the same word counts.
    log.say("ok", opened.time + 1000);
    expect((await call("answer_checkpoint", approve(opened.id, "ok"))).ok).toBe(true);
  });

  it("still refuses an option the checkpoint does not have", async () => {
    const { call, open, log } = await product({ hooked: true });
    const opened = await open();
    log.say("ok", opened.time + 1000);
    const result = await call(
      "answer_checkpoint",
      answer(opened.id, { decision: "option_chosen", option: "other", quote: "ok" }),
    );
    expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });
});

describe("validating a document, then the end of its phase", () => {
  const BRIEF = {
    path: ".agentplugged/docs/brief.md",
    branch: "main",
    blob_sha: "b".repeat(40),
  };
  /** A `document` point on a document of the phase: no story, no blocks. */
  const documentPoint = {
    agent: "iris",
    type: "document",
    risk: "low",
    title: "Brief",
    summary: "The brief.",
    story: undefined,
    blocks: [],
    options: undefined,
    recommendation: undefined,
    documents: [BRIEF],
  };

  it("a validated document approves the document, not the phase: the phase goes on", async () => {
    const { call, open, log, state } = await product({ hooked: true });
    const point = await open(documentPoint);
    log.say("tout est ok pour moi", point.time + 1000);
    const result = await call(
      "answer_checkpoint",
      answer(point.id, { quote: "tout est ok pour moi" }),
    );
    expect(result.ok).toBe(true);
    const view = await state();
    expect(view.checkpoints[point.id]?.resolution?.decision).toBe("approved");
    expect(view.phase).toMatchObject({ current: "framing", status: "in_progress" });
  });

  it("the end of the phase then cites the same document, and one answer closes the phase", async () => {
    const { call, open, log, state } = await product({ hooked: true });
    const point = await open(documentPoint);
    log.say("ok", point.time + 1000);
    await call("answer_checkpoint", answer(point.id, { quote: "ok" }));
    const end = await open({
      ...documentPoint,
      type: "phase_end",
      phase: "framing",
      title: "End of framing",
    });
    expect((await state()).phase).toMatchObject({ current: "framing", status: "in_review" });
    log.say("oui", end.time + 1000);
    expect((await call("answer_checkpoint", answer(end.id, { quote: "oui" }))).ok).toBe(true);
    expect((await state()).phase.current).toBe("planning");
  });

  it("without a prior document point, one phase_end validates the document and ends the phase", async () => {
    const { call, open, log, state } = await product({ hooked: true });
    const end = await open({
      ...documentPoint,
      type: "phase_end",
      phase: "framing",
      title: "End of framing",
    });
    log.say("tout est ok pour moi", end.time + 1000);
    expect(
      (await call("answer_checkpoint", answer(end.id, { quote: "tout est ok pour moi" }))).ok,
    ).toBe(true);
    const view = await state();
    expect(view.phase.current).toBe("planning");
    // The documents it cites are read through the `checkpoint` option.
    const whole = await call("get_state", { checkpoint: end.id });
    expect(
      whole.ok ? (whole.value as { checkpoint: CheckpointState }).checkpoint.documents : null,
    ).toEqual([BRIEF]);
  });
});
