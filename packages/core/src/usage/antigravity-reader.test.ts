import { describe, expect, it } from "vitest";
import {
  antigravityModelAt,
  antigravityModelId,
  antigravityPlace,
  antigravityTraceInfo,
  readAntigravityTranscript,
} from "./antigravity-reader.js";
import { measureTraces } from "./measure-usage.js";
import { PRICE_TABLE, priceModels, priceOf } from "./price-table.js";

/** The transcript lines as Antigravity writes them (shape read on real transcripts, 2026-10-07). */
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 5, 10, 0, seconds)).toISOString();
const row = (step: number, seconds: number, type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    step_index: step,
    source: type === "PLANNER_RESPONSE" ? "MODEL" : "SYSTEM",
    type,
    status: "DONE",
    created_at: at(seconds),
    ...extra,
  });
const planner = (step: number, seconds: number, input: number, cache: number, output: number) =>
  row(step, seconds, "PLANNER_RESPONSE", {
    input_tokens: input,
    cache_read_tokens: cache,
    output_tokens: output,
    thinking: "…",
  });
const chose = (step: number, seconds: number, from: string, to: string, extra = "") =>
  row(step, seconds, "USER_INPUT", {
    content: `<USER_REQUEST>go</USER_REQUEST>\n${extra}<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from ${from} to ${to}. No need to comment on this change if the user doesn't ask about it.\n</USER_SETTINGS_CHANGE>`,
  });

describe("reading an Antigravity transcript", () => {
  it("names the models the way the engine does", () => {
    expect(antigravityModelId("Gemini 3.1 Pro (Low)")).toBe("gemini-3.1-pro");
    expect(antigravityModelId("Gemini 3.1 Pro (High)")).toBe("gemini-3.1-pro");
    expect(antigravityModelId("Claude Sonnet 4.6 (Thinking)")).toBe("claude-sonnet-4-6");
    expect(antigravityModelId("GPT-OSS 120B (Medium)")).toBe("gpt-oss-120b");
    expect(antigravityModelId("None")).toBeUndefined();
  });

  it("counts each answer once, with the model the creator had chosen", () => {
    const text = [
      chose(0, 0, "None", "Gemini 3.1 Pro (Low)"),
      planner(2, 10, 1000, 500, 100),
      planner(5, 20, 200, 1500, 50),
      chose(8, 30, "Gemini 3.1 Pro (Low)", "Claude Sonnet 4.6 (Thinking)"),
      planner(9, 40, 300, 0, 70),
      // The same step written again, a step without any figure, a tool step.
      planner(9, 40, 300, 0, 70),
      row(10, 41, "PLANNER_RESPONSE", { content: "text only" }),
      row(11, 42, "GENERIC", { content: "tool output" }),
    ].join("\n");
    const summary = readAntigravityTranscript(text);
    expect(summary.models).toEqual([
      {
        model: "claude-sonnet-4-6",
        messages: 1,
        tokens_in: 300,
        tokens_out: 70,
        cache_read: 0,
        cache_write: 0,
        cache_write_1h: 0,
      },
      {
        model: "gemini-3.1-pro",
        messages: 2,
        tokens_in: 1200,
        tokens_out: 150,
        cache_read: 2000,
        cache_write: 0,
        cache_write_1h: 0,
      },
    ]);
    expect(summary.answers).toHaveLength(3);
    expect(summary.started_at).toBe(at(0));
    expect(summary.ended_at).toBe(at(42));
    expect(summary.active_ms).toBe(42_000);
  });

  it("gives an unknown model when the trace never says which, and a parent's model to a sub-agent", () => {
    const text = [planner(2, 10, 10, 20, 5)].join("\n");
    expect(readAntigravityTranscript(text).models[0]?.model).toBe("unknown");
    expect(readAntigravityTranscript(text, "gemini-3.1-pro").models[0]?.model).toBe(
      "gemini-3.1-pro",
    );
  });

  it("reads the model a conversation ran on at a time", () => {
    const text = [
      chose(0, 0, "None", "Gemini 3.1 Pro (Low)"),
      chose(1, 60, "Gemini 3.1 Pro (Low)", "Claude Sonnet 4.6 (Thinking)"),
    ].join("\n");
    expect(antigravityModelAt(text, Date.parse(at(30)))).toBe("gemini-3.1-pro");
    expect(antigravityModelAt(text, Date.parse(at(90)))).toBe("claude-sonnet-4-6");
    expect(antigravityModelAt("", 0, "gpt-oss-120b")).toBe("gpt-oss-120b");
  });

  it("reads the model in force before the first change told, and a change written without a time", () => {
    const text = [
      chose(0, 5, "Gemini 3.1 Pro (High)", "Claude Sonnet 4.6 (Thinking)"),
      row(1, 0, "USER_INPUT", {
        created_at: "not a date",
        content:
          "changed setting `Model Selection` from Claude Sonnet 4.6 (Thinking) to GPT-OSS 120B (Medium). No need",
      }),
    ].join("\n");
    expect(antigravityModelAt(text, Date.parse(at(1)))).toBe("gemini-3.1-pro");
    // The change without a time is read at the time of the one before it, never before it.
    expect(antigravityModelAt(text, Date.parse(at(6)))).toBe("gpt-oss-120b");
  });

  it("ignores a half-written last line", () => {
    const text = `${planner(2, 10, 10, 20, 5)}\n{"step_index":3,"type":"PLANNER_RES`;
    expect(readAntigravityTranscript(text, "gemini-3.1-pro").models[0]?.messages).toBe(1);
  });
});

describe("what a conversation says of itself", () => {
  const brief = (sender: string, content: string, seconds = 5) =>
    row(1, seconds, "SYSTEM_MESSAGE", {
      content: `The following is a <SYSTEM_MESSAGE>\n[Message] timestamp=${at(seconds)} sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=${content}\n</SYSTEM_MESSAGE>`,
    });

  it("tells the creator's conversation from a sub-agent's, and its agent", () => {
    expect(antigravityTraceInfo(chose(0, 0, "None", "Gemini 3.1 Pro (Low)"))).toEqual({
      kind: "main",
    });
    const sub = antigravityTraceInfo(
      [
        brief("parent-1", 'La story 1-2 est démarrée. Ton agent id MCP est "Hugo". Développe.'),
      ].join("\n"),
    );
    expect(sub).toMatchObject({
      kind: "sub",
      parent: "parent-1",
      agent_type: "hugo",
      started_at: Date.parse(at(5)),
    });
    expect(sub.description).toContain("story 1-2");
    expect(antigravityTraceInfo(brief("p", "Tu es Lina. Développe la story 2-1.")).agent_type).toBe(
      "lina",
    );
    expect(
      antigravityTraceInfo(brief("p", 'Revue QA. Appelle start_review avec agent="quentin".'))
        .agent_type,
    ).toBe("quentin");
  });

  it("is still a sub-agent when the creator then talks to it", () => {
    const text = [brief("parent-1", "Tu es Hugo."), chose(3, 30, "None", "Gemini 3.1 Pro (Low)")];
    expect(antigravityTraceInfo(text.join("\n")).kind).toBe("sub");
  });

  it("takes a name after « Tu es » only when it is a name, without its accents", () => {
    expect(antigravityTraceInfo(brief("p", "Tu es un expert. Revue.")).agent_type).toBeUndefined();
    expect(antigravityTraceInfo(brief("p", "Tu es Chloé. Revue.")).agent_type).toBe("chloe");
  });

  it("finds the agent a conversation acts as in the product's tools", () => {
    const call = row(2, 10, "PLANNER_RESPONSE", {
      input_tokens: 1,
      tool_calls: [
        { name: "call_mcp_tool", args: { Arguments: '{"agent":"izzy","story":"1-1"}' } },
      ],
    });
    expect(
      antigravityTraceInfo([brief("p", "Fais la rétrospective."), call].join("\n")),
    ).toMatchObject({ agent_type: "izzy" });
  });
});

describe("the folder a conversation worked in", () => {
  const places = ["C:\\Users\\Me\\site", "C:\\Users\\Me\\site.worktrees\\1-2"];
  const view = (path: string, step = 2) =>
    row(step, 10, "PLANNER_RESPONSE", {
      input_tokens: 1,
      tool_calls: [{ name: "view_file", args: { AbsolutePath: `"${path}"` } }],
    });
  const open = (path: string) =>
    row(0, 0, "USER_INPUT", {
      content: `<ADDITIONAL_METADATA>\nActive Document: ${path} (LANGUAGE_UNSPECIFIED)\n</ADDITIONAL_METADATA>`,
    });

  it("belongs to the product when most of the files it works on are inside, to the place with the most", () => {
    expect(
      antigravityPlace(
        [open("c:\\Users\\Me\\site\\docs\\brief.md"), view("c:/users/me/site/a")].join("\n"),
        places,
      ),
    ).toBe(0);
    expect(
      antigravityPlace(
        [
          view("C:\\Users\\Me\\site.worktrees\\1-2\\src\\a.ts"),
          view("c:/users/me/site.worktrees/1-2/b"),
        ].join("\n"),
        places,
      ),
    ).toBe(1);
  });

  it("does not take a sibling folder for the product, nor the tool's own files for the work", () => {
    expect(antigravityPlace(view("c:/users/me/site-other/a"), places)).toBe("elsewhere");
    expect(
      antigravityPlace(
        [view("C:/Users/Me/.gemini/antigravity/brain/x/out.txt"), view("c:/users/me/site/a")].join(
          "\n",
        ),
        places,
      ),
    ).toBe(0);
    expect(
      antigravityPlace(
        [
          view("c:/users/me/engine/a"),
          view("c:/users/me/engine/b"),
          view("c:/users/me/site/a"),
        ].join("\n"),
        places,
      ),
    ).toBe("elsewhere");
  });

  it("reads the paths of a machine that is not Windows, files URIs comprised", () => {
    const posix = ["/home/me/site", "/home/me/site.worktrees/1-2"];
    expect(antigravityPlace(view("/home/me/site/a"), posix)).toBe(0);
    expect(antigravityPlace(open("file:///home/me/site.worktrees/1-2/src"), posix)).toBe(1);
    expect(antigravityPlace(view("/home/me/other/a"), posix)).toBe("elsewhere");
  });

  it("counts each file once: a document open for the whole conversation is one file", () => {
    const text = [
      open("c:\\Users\\Me\\other\\a.md"),
      open("c:\\Users\\Me\\other\\a.md"),
      open("c:\\Users\\Me\\other\\a.md"),
      view("c:/users/me/site/a"),
      view("c:/users/me/site/b"),
    ].join("\n");
    expect(antigravityPlace(text, places)).toBe(0);
  });

  it("names no place for a conversation that names no file", () => {
    expect(antigravityPlace(planner(2, 10, 1, 1, 1), places)).toBeUndefined();
  });
});

describe("measuring an Antigravity session", () => {
  it("measures it like the other tools: tied to its story, the answers counted once", () => {
    const text = [planner(2, 10, 1000, 4000, 100), planner(5, 20, 100, 6000, 50)].join("\n");
    const trace = {
      source: "antigravity" as const,
      id: "conv-1",
      kind: "sub" as const,
      agent_type: "hugo",
      description: "Développe la story 1-2",
      model: "gemini-3.1-pro",
      text,
    };
    const first = measureTraces([trace, trace], []).sessions;
    expect(first).toHaveLength(1);
    expect(first[0]?.payload).toMatchObject({
      source: "antigravity",
      session: "conv-1",
      agent: "hugo",
      models: [
        {
          model: "gemini-3.1-pro",
          messages: 2,
          tokens_in: 1100,
          tokens_out: 150,
          cache_read: 10000,
        },
      ],
    });
  });

  it("prices Gemini at the table's prices, and leaves a model without a price without an amount", () => {
    expect(PRICE_TABLE.version).toBe("2026-10-17");
    expect(priceOf("gemini-3.1-pro")).toMatchObject({ input: 2, output: 12, cache_read: 0.2 });
    const priced = priceModels([
      {
        model: "gemini-3.1-pro",
        messages: 1,
        tokens_in: 1_000_000,
        tokens_out: 1_000_000,
        cache_read: 1_000_000,
        cache_write: 0,
        cache_write_1h: 0,
      },
      {
        model: "gpt-oss-120b",
        messages: 1,
        tokens_in: 5,
        tokens_out: 5,
        cache_read: 5,
        cache_write: 0,
        cache_write_1h: 0,
      },
    ]);
    expect(priced.usd).toBe(14.2);
    expect(priced.complete).toBe(false);
    expect(priced.unpriced_models).toEqual(["gpt-oss-120b"]);
  });
});
