import { toBase64url } from "@agentplugged/crypto";
import {
  CheckpointElicitedPayloadSchema,
  type DecisionPrompt,
  ErrorCode,
  type StackPrompt,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentSession,
  type AgentStateView,
  type AskCreatorResult,
  type AskStackResult,
  type CheckpointState,
  type CommandContext,
  type CreatorPrompt,
  type CreatorReply,
  computeProjection,
  createCommandRegistry,
  DECISION_HOOK_PATH,
  type DecisionRecord,
  decisionChannels,
  historyEntries,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type QuestionReader,
  type QuestionScreen,
  type QuestionToolAccess,
  type QuestionToolDictation,
  questionsDigest,
  type RecordedEvent,
  resolveProfile,
  type StackOpened,
  type StackQuestionToolDictation,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { normalizeToolQuestions, screenProblem } from "./question-tool.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(29));
const START = Date.UTC(2026, 9, 5, 8, 0, 0);
const PROJECT = "/work/shop";
const SESSION = "6c1d-question-session";

/** The hook's store, in memory: answers added as the creator clicks them. */
class FakeDecisionLog {
  readonly list: DecisionRecord[] = [];
  async records(session: string): Promise<readonly DecisionRecord[]> {
    return this.list.filter((record) => record.session === session);
  }
}

/** The AI tool's form, scripted: each question gets the next reply. */
class ScriptedPrompt implements CreatorPrompt {
  readonly asked: DecisionPrompt[] = [];
  readonly stacks: StackPrompt[] = [];
  constructor(
    readonly channel: string,
    readonly replies: CreatorReply[],
  ) {}
  async ask(prompt: DecisionPrompt): Promise<CreatorReply> {
    this.asked.push(prompt);
    return this.replies.shift() ?? { action: "failed" };
  }
  async askStack(prompt: StackPrompt): Promise<CreatorReply> {
    this.stacks.push(prompt);
    return this.replies.shift() ?? { action: "failed" };
  }
}

/** A small renderer: `L-<choice>` for each choice (one question, whatever the risk), one `Approve` a point. */
function fakeAccess(available = true): QuestionToolAccess {
  return {
    available,
    render: (prompt): QuestionScreen | undefined => {
      const questions = [
        {
          question: `Decide ${prompt.checkpoint}: ${prompt.title}`,
          header: prompt.checkpoint,
          multiSelect: false,
          options: prompt.choices.map((choice) => ({
            label: `L-${choice.id}`,
            description: `does ${choice.decision}`,
          })),
        },
      ];
      const readers: QuestionReader[] = [
        {
          kind: "choice",
          choices: prompt.choices.map((choice) => ({
            label: `L-${choice.id}`,
            choice: choice.id,
          })),
        },
      ];
      return { questions, readers };
    },
    renderStack: (prompt) => {
      const screens: QuestionScreen[] = [];
      for (let start = 0; start < prompt.items.length; start += 4) {
        const items = prompt.items.slice(start, start + 4);
        screens.push({
          questions: items.map((item) => ({
            question: `Point ${item.n} ${item.checkpoint}: ${item.title}`,
            header: `Point ${item.n}`,
            multiSelect: false,
            options: [
              { label: "Approve", description: "yes" },
              { label: "Not now", description: "later" },
            ],
          })),
          readers: items.map(
            (item): QuestionReader => ({ kind: "point", n: item.n, yes: "Approve" }),
          ),
        });
      }
      return screens;
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

async function product(
  options: { mode?: string; hook?: boolean; available?: boolean; client?: string } = {},
) {
  const files = new MemoryFiles();
  let clock = START;
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({
    keys,
    now: () => {
      clock += 1000;
      return clock;
    },
  });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    keys,
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
  // `sync` wrote the hook's script (Claude Code is targeted); a project without it is a project that did not sync.
  if (options.hook === false) await files.remove(DECISION_HOOK_PATH);
  const session = new AgentSession(START);
  session.noteClient(options.client ?? "claude-code");
  const log = new FakeDecisionLog();
  let now = START + 3_600_000;
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    session,
    now: () => now,
    questionTool: fakeAccess(options.available ?? true),
    chat: { decisions: log, project: PROJECT, hooked: true, hookInstalled: true },
  };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>, prompt?: CreatorPrompt) =>
    registry.run(name, prompt === undefined ? agent : { ...agent, creatorPrompt: prompt }, input);
  const open = async (fields: Record<string, unknown> = {}) => {
    const result = await call("open_checkpoint", { ...DECISION, ...fields });
    if (!result.ok) throw new Error(`open failed: ${result.error.code}`);
    return (result.value as RecordedEvent).checkpoint as string;
  };
  const ask = async (id: string, prompt?: CreatorPrompt) => {
    const result = await call("ask_creator", { agent: "main", checkpoint: id }, prompt);
    if (!result.ok) throw new Error(`ask failed: ${result.error.code}`);
    return result.value as AskCreatorResult;
  };
  const dictate = async (id: string) => {
    const result = await ask(id);
    if (result.channel !== "question_tool")
      throw new Error(`not dictated: ${JSON.stringify(result)}`);
    return result as QuestionToolDictation;
  };
  /** The creator answers the dictated questions in the tool: the hook records it. */
  const click = (
    dictation: { fingerprint: string; questions: QuestionToolDictation["questions"] },
    answers: readonly (string | undefined)[],
    at: number,
    extra: { project?: string; notes?: string; session?: string; extra?: true } = {},
  ) => {
    log.list.push({
      session: extra.session ?? SESSION,
      project: extra.project ?? PROJECT,
      at: new Date(at).toISOString(),
      fingerprint: dictation.fingerprint,
      ...(extra.extra === true ? { extra: true as const } : {}),
      answers: dictation.questions.flatMap((question, index) => {
        const answer = answers[index];
        return answer === undefined
          ? []
          : [
              {
                question: question.question,
                answer,
                ...(index === 0 && extra.notes !== undefined ? { notes: extra.notes } : {}),
              },
            ];
      }),
    });
  };
  const answer = (id: string, extra: Record<string, unknown> = {}) =>
    call("answer_checkpoint", {
      agent: "main",
      checkpoint: id,
      via: "question_tool",
      session: SESSION,
      ...extra,
    });
  const projection = async () => computeProjection((await journal.list()).events);
  const checkpoint = async (id: string) =>
    ((await projection()).state.checkpoints as Record<string, CheckpointState>)[
      id
    ] as CheckpointState;
  return {
    files,
    journal,
    log,
    call,
    open,
    ask,
    dictate,
    click,
    answer,
    projection,
    checkpoint,
    session,
    agent,
    registry,
    tick: (ms: number) => {
      now += ms;
      return now;
    },
    now: () => now,
  };
}

const code = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? undefined : result.error?.code;
const details = (result: { ok: boolean; error?: { toPayload(): { details: unknown } } }) =>
  result.ok ? undefined : result.error?.toPayload().details;
const value = <T>(result: { ok: boolean; value?: unknown; error?: { code: string } }): T => {
  if (!result.ok) throw new Error(`failed: ${result.error?.code}`);
  return result.value as T;
};

describe("the question tool: fingerprint and screens", () => {
  const question = {
    question: "Which?",
    header: "G-AAAAAAAAAA",
    multiSelect: false,
    options: [
      { label: "A", description: "a" },
      { label: "B", description: "b" },
    ],
  };

  it("fingerprints the fields the tool shows, whatever the order and whatever else the input carries", () => {
    const base = questionsDigest([question]);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const reordered = {
      options: [
        { description: "a", label: "A", preview: "ignored" },
        { description: "b", label: "B" },
      ],
      multiSelect: false,
      header: "G-AAAAAAAAAA",
      question: "Which?",
      extra: 1,
    };
    expect(questionsDigest([reordered as never])).toBe(base);
    expect(questionsDigest([{ ...question, question: "Which one?" }])).not.toBe(base);
    expect(questionsDigest([{ ...question, options: [...question.options].reverse() }])).not.toBe(
      base,
    );
    expect(questionsDigest([{ ...question, multiSelect: true }])).not.toBe(base);
  });

  it("reads questions as the hook does: one to four, anything else is none", () => {
    expect(normalizeToolQuestions(undefined)).toBeUndefined();
    expect(normalizeToolQuestions([])).toBeUndefined();
    expect(normalizeToolQuestions(Array(5).fill(question))).toBeUndefined();
    expect(normalizeToolQuestions([{}])).toEqual([
      { question: "", header: "", multiSelect: false, options: [] },
    ]);
  });

  it("refuses a screen the tool cannot show", () => {
    const ok: QuestionScreen = {
      questions: [question],
      readers: [{ kind: "choice", choices: [] }],
    };
    expect(screenProblem(ok)).toBeUndefined();
    expect(screenProblem({ ...ok, questions: [] })).toBe("questions");
    expect(screenProblem({ ...ok, readers: [] })).toBe("readers");
    expect(screenProblem({ ...ok, questions: [{ ...question, header: "x".repeat(13) }] })).toBe(
      "header",
    );
    expect(
      screenProblem({
        ...ok,
        questions: [{ ...question, options: [question.options[0] as never] }],
      }),
    ).toBe("too_few_options");
    expect(
      screenProblem({
        ...ok,
        questions: [
          {
            ...question,
            options: Array.from({ length: 5 }, (_, i) => ({ label: `o${i}`, description: "d" })),
          },
        ],
      }),
    ).toBe("too_many_options");
    expect(
      screenProblem({
        ...ok,
        questions: [{ ...question, options: [question.options[0], question.options[0]] as never }],
      }),
    ).toBe("labels");
    expect(
      screenProblem({
        questions: [question, question],
        readers: [
          { kind: "choice", choices: [] },
          { kind: "choice", choices: [] },
        ],
      }),
    ).toBe("question");
  });
});

describe("ask_creator picks the channel, never guesses", () => {
  it("dictates the questions when no form can be shown, writes nothing and keeps the point open", async () => {
    const { open, ask, journal, checkpoint } = await product();
    const id = await open();
    const before = (await journal.list()).events.length;
    const result = await ask(id);
    expect(result).toMatchObject({
      checkpoint: id,
      asked: false,
      answered: false,
      reason: "unavailable",
      channel: "question_tool",
      via: "question_tool",
      tool: "AskUserQuestion",
    });
    const dictation = result as QuestionToolDictation;
    expect(dictation.fingerprint).toBe(questionsDigest(dictation.questions));
    expect(dictation.questions[0]?.options.map((option) => option.label)).toEqual([
      "L-option-1",
      "L-option-2",
      "L-changes",
    ]);
    expect((await journal.list()).events.length).toBe(before);
    expect((await checkpoint(id)).status).toBe("open");
  });

  it("dictates the same questions every time for the same point", async () => {
    const { open, dictate } = await product();
    const id = await open();
    const first = await dictate(id);
    const second = await dictate(id);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.questions).toEqual(first.questions);
  });

  it("dictates the questions at once when the client refuses the form at once, and remembers it", async () => {
    const { open, call, session } = await product();
    const first = await open();
    const second = await open({ title: "Another" });
    const prompt = new ScriptedPrompt("claude-code", [{ action: "decline", quick: true }]);
    const result = value<AskCreatorResult>(
      await call("ask_creator", { agent: "main", checkpoint: first }, prompt),
    );
    expect(result).toMatchObject({ channel: "question_tool", reason: "declined", asked: false });
    expect(session.form).toBe("refused");
    expect(prompt.asked).toHaveLength(1);
    // The next decision does not send a form the client refuses: the questions at once.
    const next = value<AskCreatorResult>(
      await call("ask_creator", { agent: "main", checkpoint: second }, prompt),
    );
    expect(next).toMatchObject({ channel: "question_tool" });
    expect(prompt.asked).toHaveLength(1);
  });

  it("falls back to the chat, and says so, when the refusal at once has no question tool behind it", async () => {
    const { open, call, session } = await product({ hook: false });
    const id = await open();
    const prompt = new ScriptedPrompt("claude-code", [{ action: "decline", quick: true }]);
    const result = value<AskCreatorResult>(
      await call("ask_creator", { agent: "main", checkpoint: id }, prompt),
    );
    expect(result).toMatchObject({
      asked: true,
      answered: false,
      reason: "declined",
      channel: "chat",
    });
    expect(session.form).toBe("refused");
  });

  it("keeps a refusal the creator took time over: no question tool behind their back", async () => {
    const { open, call, session } = await product();
    const id = await open();
    const prompt = new ScriptedPrompt("claude-code", [{ action: "decline" }]);
    const result = value<AskCreatorResult>(
      await call("ask_creator", { agent: "main", checkpoint: id }, prompt),
    );
    expect(result).toMatchObject({ asked: true, reason: "declined", channel: "chat" });
    expect(session.form).toBeUndefined();
  });

  it("remembers that a form worked, and keeps it first", async () => {
    const { open, call, session } = await product();
    const id = await open();
    const prompt = new ScriptedPrompt("claude-code", [
      { action: "accept", content: { choice: "option-1" } },
    ]);
    expect(
      value<AskCreatorResult>(await call("ask_creator", { agent: "main", checkpoint: id }, prompt)),
    ).toMatchObject({ answered: true, channel: "elicitation" });
    expect(session.form).toBe("works");
    const other = await open({ title: "Other" });
    const refused = new ScriptedPrompt("claude-code", [{ action: "decline", quick: true }]);
    await call("ask_creator", { agent: "main", checkpoint: other }, refused);
    // A form seen working is not forgotten by a later refusal.
    expect(session.form).toBe("works");
  });

  it("says the channels in get_state and next, and the form's real state", async () => {
    const { open, call, agent } = await product();
    const id = await open();
    const state = async (prompt?: CreatorPrompt) =>
      value<AgentStateView>(await call("get_state", { full: true }, prompt)).validation;
    expect(await state()).toMatchObject({
      elicitation: false,
      channels: {
        available: ["question_tool", "chat"],
        elicitation: "unavailable",
        question_tool: "available",
      },
    });
    const prompt = new ScriptedPrompt("claude-code", [{ action: "decline", quick: true }]);
    expect(await state(prompt)).toMatchObject({
      elicitation: true,
      channels: {
        available: ["elicitation", "question_tool", "chat"],
        elicitation: "untested",
        question_tool: "available",
      },
    });
    await call("ask_creator", { agent: "main", checkpoint: id }, prompt);
    expect(await state(prompt)).toMatchObject({
      elicitation: false,
      channels: {
        available: ["question_tool", "chat"],
        elicitation: "declined_by_client",
        question_tool: "available",
      },
    });
    const next = value<{ validation: { channels: { available: string[] } } }>(
      await call("next", {}, prompt),
    );
    expect(next.validation.channels.available).toEqual(["question_tool", "chat"]);
    expect((await decisionChannels({ ...agent, creatorPrompt: prompt })).elicitation).toBe(
      "declined_by_client",
    );
  });

  it("says hook_missing when the tool has the question tool and the project lacks the hook", async () => {
    const { open, call } = await product({ hook: false });
    const id = await open();
    const state = value<AgentStateView>(await call("get_state", { full: true }));
    expect(state.validation.channels).toEqual({
      available: ["chat"],
      elicitation: "unavailable",
      question_tool: "hook_missing",
    });
    expect(
      value<AskCreatorResult>(await call("ask_creator", { agent: "main", checkpoint: id })),
    ).toMatchObject({
      channel: "chat",
      reason: "unavailable",
    });
  });

  it("offers no question tool to a tool that has none (a headless run, Antigravity)", async () => {
    for (const setup of [{ available: false }, { client: "antigravity-client" }]) {
      const { open, call } = await product(setup);
      const id = await open();
      expect(
        value<AskCreatorResult>(await call("ask_creator", { agent: "main", checkpoint: id })),
      ).toMatchObject({ channel: "chat" });
    }
  });

  it("refuses the question tool at the strict level for a high risk: the terminal only", async () => {
    const { open, call } = await product({ mode: "strict" });
    const id = await open({ risk: "high" });
    const result = await call("ask_creator", { agent: "main", checkpoint: id });
    expect(code(result)).toBe(ErrorCode.REVIEW_REQUIRED);
  });

  it("falls back to the chat for a decision with more choices than the tool shows", async () => {
    const { open, ask } = await product();
    const id = await open({
      options: [1, 2, 3, 4].map((n) => ({ id: `o${n}`, label: `O${n}`, consequence: `c${n}` })),
      recommendation: "o1",
    });
    expect(await ask(id)).toMatchObject({ channel: "chat", reason: "too_many_choices" });
  });
});

describe("answer_checkpoint via the question tool", () => {
  it("records the option the creator clicked, from the hook's record, and shows its channel", async () => {
    const { open, dictate, click, answer, tick, checkpoint, journal } = await product();
    const id = await open();
    const dictation = await dictate(id);
    const at = tick(2000);
    click(dictation, ["L-option-1"], at - 1000);
    const result = value<{
      answered: boolean;
      channel: string;
      decision: string;
      option: string;
    }>(await answer(id));
    expect(result).toMatchObject({
      answered: true,
      channel: "question_tool",
      decision: "option_chosen",
      option: "stripe",
    });
    const resolution = (await checkpoint(id)).resolution;
    expect(resolution).toMatchObject({
      decision: "option_chosen",
      option: "stripe",
      source: "elicitation",
      assurance: "elicitation",
      via: "question_tool",
      channel: "claude-code",
      quote: null,
      relayed_by: "main",
    });
    // The hook's record is cited as proof, with the fingerprint of the questions.
    expect(resolution?.proof?.message.digest).toBe(dictation.fingerprint);
    const events = (await journal.list()).events;
    const entries = historyEntries(await computeProjection(events), events);
    expect(entries[0]).toMatchObject({
      source: "elicitation",
      via: "question_tool",
      channel: "claude-code",
      quote: null,
    });
    const written = events.find((event) => event.type === "checkpoint.elicited");
    expect(CheckpointElicitedPayloadSchema.safeParse(written?.payload).success).toBe(true);
    expect(written?.payload).toMatchObject({ via: "question_tool" });
  });

  it("takes no choice from the agent: a decision, an option, a note or a quote is refused", async () => {
    const { open, dictate, answer } = await product();
    const id = await open();
    await dictate(id);
    for (const extra of [
      { decision: "approved" },
      { option: "stripe" },
      { note: "ok" },
      { quote: "oui" },
    ]) {
      expect(code(await answer(id, extra))).toBe(ErrorCode.INVALID_ARGUMENTS);
    }
  });

  it("refuses when the engine dictated nothing for the point in this session", async () => {
    const { open, answer, click } = await product();
    const id = await open();
    click({ fingerprint: "a".repeat(64), questions: [] }, [], START + 3_600_001);
    const result = await answer(id);
    expect(code(result)).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect(details(result)).toMatchObject({ reason: "not_dictated", field: "question" });
  });

  it("refuses an answer to questions the agent wrote itself: the fingerprint is the engine's", async () => {
    const { open, dictate, answer, log, tick } = await product();
    const id = await open();
    const dictation = await dictate(id);
    const reworded = { ...dictation.questions[0], question: "Approve? (the agent's words)" };
    log.list.push({
      session: SESSION,
      project: PROJECT,
      at: new Date(tick(1000) - 500).toISOString(),
      fingerprint: questionsDigest([reworded as never]),
      answers: [{ question: reworded.question as string, answer: "L-option-1" }],
    });
    const result = await answer(id);
    expect(code(result)).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect(details(result)).toMatchObject({ reason: "no_answer" });
  });

  it("refuses an answer recorded before the engine dictated the questions", async () => {
    const { open, dictate, click, answer, now } = await product();
    const id = await open();
    const dictation = await dictate(id);
    click(dictation, ["L-option-1"], now() - 10_000);
    const result = await answer(id);
    expect(code(result)).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect(details(result)).toMatchObject({ reason: "before_dictation" });
  });

  it("refuses the answer of another session or another project", async () => {
    const { open, dictate, click, answer, tick } = await product();
    const id = await open();
    const dictation = await dictate(id);
    const at = tick(2000);
    click(dictation, ["L-option-1"], at - 500, { session: "another-session" });
    click(dictation, ["L-option-1"], at - 500, { project: "/work/other" });
    expect(details(await answer(id))).toMatchObject({ reason: "no_answer" });
  });

  it("needs the session the hook gave", async () => {
    const { open, dictate, click, call, tick } = await product();
    const id = await open();
    const dictation = await dictate(id);
    click(dictation, ["L-option-1"], tick(2000) - 500);
    const result = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: id,
      via: "question_tool",
    });
    expect(code(result)).toBe(ErrorCode.CHAT_SESSION_REQUIRED);
  });

  it("says when the project lacks the hook, and writes nothing", async () => {
    const { open, dictate, files, answer, journal } = await product();
    const id = await open();
    await dictate(id);
    await files.remove(DECISION_HOOK_PATH);
    const before = (await journal.list()).events.length;
    const result = await answer(id);
    expect(code(result)).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect(details(result)).toMatchObject({ reason: "question_hook_missing" });
    expect((await journal.list()).events.length).toBe(before);
  });

  it("records an answer once: the point is resolved, and a second call changes nothing", async () => {
    const { open, dictate, click, answer, tick, journal } = await product();
    const id = await open();
    const dictation = await dictate(id);
    click(dictation, ["L-option-2"], tick(2000) - 500);
    expect(value<{ answered: boolean }>(await answer(id)).answered).toBe(true);
    const count = (await journal.list()).events.length;
    expect(code(await answer(id))).toBe(ErrorCode.CHECKPOINT_NOT_OPEN);
    expect((await journal.list()).events.length).toBe(count);
  });

  it("never lets the same record answer two checkpoints in the journal", async () => {
    const { open, dictate, click, answer, tick, journal, checkpoint, agent } = await product();
    const first = await open();
    const dictation = await dictate(first);
    click(dictation, ["L-option-1"], tick(2000) - 500);
    expect(value<{ answered: boolean }>(await answer(first)).answered).toBe(true);
    // An agent that writes the same proof on another checkpoint (a forged event) is not counted.
    const second = await open({ title: "Second" });
    const events = (await journal.list()).events;
    const elicited = events.find((event) => event.type === "checkpoint.elicited");
    const forged = {
      ...(elicited?.payload as Record<string, unknown>),
      checkpoint: second,
    };
    await journal.appendAll([
      {
        type: "checkpoint.elicited",
        actor: { kind: "agent", agent: "main" },
        product: (await journal.productId()) as string,
        provenance: "trusted",
        payload: forged,
      } as never,
    ]);
    const projection = await computeProjection((await journal.list()).events);
    expect(projection.ignored.at(-1)?.reason).toBe("invalid");
    expect((await checkpoint(second)).status).toBe("open");
    expect(agent).toBeDefined();
  });

  it("records a change request with the note the tool gives, and asks for one when it gives none", async () => {
    const { open, dictate, click, answer, tick, checkpoint } = await product();
    const id = await open();
    const dictation = await dictate(id);
    click(dictation, ["L-changes"], tick(2000) - 1500);
    const needsNote = value<{ answered: boolean; reason: string; channel: string }>(
      await answer(id),
    );
    expect(needsNote).toMatchObject({ answered: false, reason: "note_required", channel: "chat" });
    expect((await checkpoint(id)).status).toBe("open");
    click(dictation, ["L-changes"], tick(500) - 100, { notes: "Use Adyen instead" });
    // The first click was read and refused: the creator's next one, with a note, is the one read.
    expect(value<{ answered: boolean }>(await answer(id)).answered).toBe(true);
    expect((await checkpoint(id)).resolution?.note).toBe("Use Adyen instead");
  });

  it("records a change request when the tool gave a note", async () => {
    const { open, dictate, click, answer, tick, checkpoint } = await product();
    const id = await open();
    const dictation = await dictate(id);
    click(dictation, ["L-changes"], tick(2000) - 1500, { notes: "Use Adyen instead" });
    const result = value<{ answered: boolean; decision: string; note: string }>(await answer(id));
    expect(result).toMatchObject({
      answered: true,
      decision: "changes_requested",
      note: "Use Adyen instead",
    });
    expect((await checkpoint(id)).resolution?.note).toBe("Use Adyen instead");
  });

  it("never takes the creator's own words (« Other ») for a choice, and hands them back", async () => {
    const { open, dictate, click, answer, tick, checkpoint } = await product();
    const id = await open();
    const dictation = await dictate(id);
    click(dictation, ["Maybe Stripe, I do not know"], tick(2000) - 1500);
    const result = value<{ answered: boolean; reason: string; creator_words: string }>(
      await answer(id),
    );
    expect(result).toMatchObject({
      answered: false,
      reason: "invalid",
      creator_words: "Maybe Stripe, I do not know",
    });
    expect((await checkpoint(id)).status).toBe("open");
  });

  it("asks a high risk in one question, and one click records it", async () => {
    const { open, dictate, click, answer, tick, journal, checkpoint } = await product();
    const id = await open({ risk: "high" });
    const dictation = await dictate(id);
    // One question, never a second one that asks for a confirmation.
    expect(dictation.questions).toHaveLength(1);
    click(dictation, ["L-option-1"], tick(2000) - 1500);
    expect(value<{ answered: boolean }>(await answer(id)).answered).toBe(true);
    expect((await checkpoint(id)).status).toBe("resolved");
    const event = (await journal.list()).events.find(
      (entry) => entry.type === "checkpoint.elicited",
    );
    expect(event?.payload).toMatchObject({ via: "question_tool" });
    expect(event?.payload).not.toHaveProperty("confirmed");
  });
});

describe("the question tool for a stack", () => {
  const DOCUMENT = {
    agent: "main",
    type: "document",
    risk: "low",
    title: "A document",
    summary: "Read it, then approve it.",
  };

  async function stackProduct(count: number) {
    const base = await product();
    const ids: string[] = [];
    for (let i = 1; i <= count; i++) {
      const result = await base.call("open_checkpoint", { ...DOCUMENT, title: `Document ${i}` });
      if (!result.ok) throw new Error(`open failed: ${result.error.code}`);
      ids.push((result.value as RecordedEvent).checkpoint as string);
    }
    const opened = await base.call("open_stack", { agent: "main", checkpoints: ids });
    if (!opened.ok) throw new Error(`open_stack failed: ${opened.error.code}`);
    const stack = (opened.value as StackOpened).stack;
    const dictate = async () => {
      const result = await base.call("ask_stack", { agent: "main", stack });
      return value<AskStackResult>(result) as StackQuestionToolDictation;
    };
    const answerStack = (extra: Record<string, unknown> = {}) =>
      base.call("answer_stack", {
        agent: "main",
        stack,
        via: "question_tool",
        session: SESSION,
        ...extra,
      });
    return { ...base, ids, stack, dictate, answerStack };
  }

  it("splits a stack of more than four points in screens of four at most", async () => {
    const { dictate } = await stackProduct(6);
    const result = await dictate();
    expect(result).toMatchObject({ channel: "question_tool", via: "question_tool" });
    expect(result.screens.map((screen) => screen.questions.length)).toEqual([4, 2]);
    expect(result.screens.map((screen) => screen.screen)).toEqual([1, 2]);
    expect(result.remaining).toHaveLength(6);
  });

  it("approves the points the creator approved, leaves the others open and never grows", async () => {
    const { dictate, click, answerStack, tick, checkpoint, ids, projection } =
      await stackProduct(3);
    const result = await dictate();
    const screen = result.screens[0] as StackQuestionToolDictation["screens"][number];
    click(screen, ["Approve", "Not now", "Approve"], tick(2000) - 1500);
    const answered = value<{
      answered: boolean;
      channel: string;
      approved: { n: number }[];
      remaining: { n: number }[];
    }>(await answerStack());
    expect(answered).toMatchObject({ answered: true, channel: "question_tool" });
    expect(answered.approved.map((item) => item.n)).toEqual([1, 3]);
    expect(answered.remaining.map((item) => item.n)).toEqual([2]);
    expect((await checkpoint(ids[0] as string)).resolution).toMatchObject({
      assurance: "elicitation",
      via: "question_tool",
      source: "elicitation",
    });
    expect((await checkpoint(ids[1] as string)).status).toBe("open");
    expect((await projection()).ignored).toEqual([]);
  });

  it("records an answer once: the same record answers no other point", async () => {
    const { dictate, click, answerStack, tick } = await stackProduct(2);
    const result = await dictate();
    click(result.screens[0] as never, ["Approve", "Approve"], tick(2000) - 1500);
    expect(value<{ answered: boolean }>(await answerStack()).answered).toBe(true);
    // Everything is answered: the stack is closed.
    expect(code(await answerStack())).toBe(ErrorCode.STACK_CLOSED);
  });

  it("writes nothing when the creator left every point open", async () => {
    const { dictate, click, answerStack, tick, journal } = await stackProduct(2);
    const result = await dictate();
    click(result.screens[0] as never, ["Not now", "Not now"], tick(2000) - 1500);
    const before = (await journal.list()).events.length;
    expect(value<{ answered: boolean; reason: string }>(await answerStack())).toMatchObject({
      answered: false,
      reason: "none_checked",
    });
    expect((await journal.list()).events.length).toBe(before);
  });

  it("needs a record of the dictated screens, never an agent's own", async () => {
    const { dictate, answerStack, log, tick } = await stackProduct(2);
    expect(code(await answerStack())).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    await dictate();
    log.list.push({
      session: SESSION,
      project: PROJECT,
      at: new Date(tick(1000) - 500).toISOString(),
      fingerprint: "c".repeat(64),
      answers: [],
    });
    const result = await answerStack();
    expect(code(result)).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect(details(result)).toMatchObject({ reason: "no_answer" });
  });

  it("asks a stack of six in two screens, and reads both", async () => {
    const { dictate, click, answerStack, tick } = await stackProduct(6);
    const result = await dictate();
    click(
      result.screens[0] as never,
      ["Approve", "Not now", "Not now", "Approve"],
      tick(2000) - 1500,
    );
    click(result.screens[1] as never, ["Approve", "Approve"], tick(10) - 5);
    const answered = value<{ approved: { n: number }[] }>(await answerStack());
    expect(answered.approved.map((item) => item.n)).toEqual([1, 4, 5, 6]);
  });
});

describe("what the reviews closed", () => {
  it("reads the creator's second click when the first was no choice", async () => {
    const { open, dictate, click, answer, tick, checkpoint } = await product();
    const id = await open();
    const dictation = await dictate(id);
    click(dictation, ["L-changes"], tick(2000) - 1500);
    expect(await answer(id)).toMatchObject({ ok: true, value: { reason: "note_required" } });
    // The creator answers again: their next click is the one read, not the first one again.
    click(dictation, ["L-option-1"], tick(500) - 100);
    const result = value<{ answered: boolean; option: string }>(await answer(id));
    expect(result).toMatchObject({ answered: true, option: "stripe" });
    expect((await checkpoint(id)).status).toBe("resolved");
  });

  it("reads the next click after the creator's own words", async () => {
    const { open, dictate, click, answer, tick } = await product();
    const id = await open({ risk: "high" });
    const dictation = await dictate(id);
    click(dictation, ["whatever I think"], tick(2000) - 1500);
    expect(await answer(id)).toMatchObject({ ok: true, value: { reason: "invalid" } });
    click(dictation, ["L-option-1"], tick(100) - 50);
    expect(value<{ answered: boolean }>(await answer(id)).answered).toBe(true);
  });

  it("stops dictating the same questions after three times: the chat takes over", async () => {
    const { open, ask, dictate } = await product();
    const id = await open();
    for (let i = 0; i < 3; i++) await dictate(id);
    expect(await ask(id)).toMatchObject({ channel: "chat", reason: "declined", answered: false });
  });

  it("never dictates behind the back of a creator who closed the form on purpose", async () => {
    const { open, call } = await product();
    const closed = await open();
    const other = await open({ title: "Other" });
    const slow = new ScriptedPrompt("claude-code", [{ action: "decline" }]);
    await call("ask_creator", { agent: "main", checkpoint: closed }, slow);
    // A refusal at once on another point: the session now knows the client refuses its forms.
    const quick = new ScriptedPrompt("claude-code", [{ action: "decline", quick: true }]);
    expect(
      value<AskCreatorResult>(
        await call("ask_creator", { agent: "main", checkpoint: other }, quick),
      ),
    ).toMatchObject({ channel: "question_tool" });
    // The first point stays in the chat, as the creator wanted.
    expect(
      value<AskCreatorResult>(await call("ask_creator", { agent: "main", checkpoint: closed })),
    ).toMatchObject({ channel: "chat", reason: "declined" });
  });

  it("takes a quick refusal for the creator's own once a form worked in the session", async () => {
    const { open, call, session } = await product();
    const first = await open();
    const second = await open({ title: "Second" });
    await call(
      "ask_creator",
      { agent: "main", checkpoint: first },
      new ScriptedPrompt("claude-code", [{ action: "accept", content: { choice: "option-1" } }]),
    );
    const result = value<AskCreatorResult>(
      await call(
        "ask_creator",
        { agent: "main", checkpoint: second },
        new ScriptedPrompt("claude-code", [{ action: "decline", quick: true }]),
      ),
    );
    expect(result).toMatchObject({ asked: true, reason: "declined", channel: "chat" });
    expect(session.form).toBe("works");
  });

  it("gives the right reason when the tool cannot show a decision: too many choices, or too few", async () => {
    const { open, registry, agent } = await product();
    const id = await open();
    const asking = (render: QuestionToolAccess["render"]) =>
      registry.run(
        "ask_creator",
        { ...agent, questionTool: { ...fakeAccess(), render } },
        { agent: "main", checkpoint: id },
      );
    const one = await asking((prompt) => ({
      questions: [
        {
          question: `Only ${prompt.checkpoint}`,
          header: prompt.checkpoint,
          multiSelect: false,
          options: [{ label: "L", description: "d" }],
        },
      ],
      readers: [{ kind: "choice", choices: [] }],
    }));
    expect(value<AskCreatorResult>(one)).toMatchObject({ channel: "chat", reason: "no_choice" });
    const five = await asking((prompt) => ({
      questions: [
        {
          question: `Five ${prompt.checkpoint}`,
          header: prompt.checkpoint,
          multiSelect: false,
          options: Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, description: "d" })),
        },
      ],
      readers: [{ kind: "choice", choices: [] }],
    }));
    expect(value<AskCreatorResult>(five)).toMatchObject({
      channel: "chat",
      reason: "too_many_choices",
    });
  });

  it("never reads a record whose call carried fields the engine did not dictate", async () => {
    const { open, dictate, click, answer, tick, checkpoint } = await product();
    const id = await open();
    const dictation = await dictate(id);
    click(dictation, ["L-option-1"], tick(2000) - 1500, { extra: true });
    const result = await answer(id);
    expect(code(result)).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect(details(result)).toMatchObject({ reason: "question_extra" });
    expect((await checkpoint(id)).status).toBe("open");
  });

  it("offers the question tool only when the project holds the hook as sync writes it", async () => {
    const { open, call, files } = await product();
    await open();
    const channels = async () =>
      value<AgentStateView>(await call("get_state", { full: true })).validation.channels
        .question_tool;
    expect(await channels()).toBe("available");
    const script = await files.readText(DECISION_HOOK_PATH);
    // Git may have changed the line endings: not a difference.
    await files.writeText(DECISION_HOOK_PATH, script.replace(/\n/g, "\r\n"));
    expect(await channels()).toBe("available");
    // A script that is not the engine's (edited, or an older engine's).
    await files.writeText(DECISION_HOOK_PATH, `${script}\n// edited`);
    expect(await channels()).toBe("hook_missing");
    await files.writeText(DECISION_HOOK_PATH, script);
    expect(await channels()).toBe("available");
    // Its handlers removed, or the hooks all disabled.
    const settings = JSON.parse(await files.readText(".claude/settings.json")) as {
      hooks: Record<string, { matcher?: string }[]>;
      disableAllHooks?: boolean;
    };
    const kept = JSON.stringify(settings);
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const without = JSON.parse(kept) as typeof settings;
      without.hooks[event] = (without.hooks[event] ?? []).filter(
        (group) => group.matcher !== "AskUserQuestion",
      );
      await files.writeText(".claude/settings.json", JSON.stringify(without));
      expect(await channels(), event).toBe("hook_missing");
    }
    await files.writeText(
      ".claude/settings.json",
      JSON.stringify({ ...settings, disableAllHooks: true }),
    );
    expect(await channels()).toBe("hook_missing");
    await files.writeText(".claude/settings.json", "{ not json");
    expect(await channels()).toBe("hook_missing");
    await files.writeText(".claude/settings.json", kept);
    expect(await channels()).toBe("available");
  });
});

describe("the stack's second chance", () => {
  async function stackOf(count: number) {
    const base = await product();
    const ids: string[] = [];
    for (let i = 1; i <= count; i++) {
      const opened = await base.call("open_checkpoint", {
        agent: "main",
        type: "document",
        risk: "low",
        title: `Doc ${i}`,
        summary: "Read it.",
      });
      ids.push(value<RecordedEvent>(opened).checkpoint as string);
    }
    const stack = value<StackOpened>(
      await base.call("open_stack", { agent: "main", checkpoints: ids }),
    ).stack;
    return { base, stack };
  }

  it("reads the creator's next click after a screen they left entirely open", async () => {
    const { base, stack } = await stackOf(2);
    const asked = value<AskStackResult>(await base.call("ask_stack", { agent: "main", stack }));
    const screen = (asked as StackQuestionToolDictation).screens[0] as never;
    base.click(screen, ["Not now", "Not now"], base.tick(2000) - 1500);
    const answer = () =>
      base.call("answer_stack", { agent: "main", stack, via: "question_tool", session: SESSION });
    expect(value<{ reason: string }>(await answer()).reason).toBe("none_checked");
    base.click(screen, ["Approve", "Not now"], base.tick(500) - 100);
    expect(value<{ approved: unknown[] }>(await answer()).approved).toHaveLength(1);
  });

  it("stops dictating a stack after three times", async () => {
    const { base, stack } = await stackOf(2);
    const ask = async () =>
      value<AskStackResult>(await base.call("ask_stack", { agent: "main", stack }));
    for (let i = 0; i < 3; i++) expect(await ask()).toMatchObject({ channel: "question_tool" });
    expect(await ask()).toMatchObject({ channel: "chat", reason: "declined" });
  });
});
