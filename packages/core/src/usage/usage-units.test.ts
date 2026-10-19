import type { UsageModel } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import type { StoryState } from "../projection/agent-reducers.js";
import { normalizeModel, PRICE_TABLE, priceModels, priceOf } from "./price-table.js";
import { readClaudeTranscript, readCodexRollout } from "./trace-readers.js";
import {
  estimatesOf,
  figuresOf,
  finishedStories,
  REFERENCE_ESTIMATES,
  type UsageSessionState,
  usageView,
} from "./usage-rules.js";

const MODEL = (over: Partial<UsageModel> = {}): UsageModel => ({
  model: "claude-opus-5-5",
  messages: 1,
  tokens_in: 0,
  tokens_out: 0,
  cache_read: 0,
  cache_write: 0,
  cache_write_1h: 0,
  ...over,
});

const assistant = (
  id: string,
  at: string,
  usage: Record<string, unknown>,
  model = "claude-opus-5-5",
) => JSON.stringify({ type: "assistant", timestamp: at, message: { id, model, usage } });

describe("the price table", () => {
  it("is dated, versioned and sourced", () => {
    expect(PRICE_TABLE.version).toBe("2026-10-17");
    expect(PRICE_TABLE.as_of).toBe("2026-10-17");
    expect(PRICE_TABLE.source).toContain("platform.claude.com");
    expect(PRICE_TABLE.source).toContain("ai.google.dev/gemini-api/docs/pricing");
  });

  it("holds the public prices read at their source", () => {
    expect(priceOf("claude-opus-5-5")).toEqual({
      input: 4,
      output: 20,
      cache_write_5m: 5,
      cache_write_1h: 8,
      cache_read: 0.2,
    });
    expect(priceOf("claude-sonnet-5-5")).toEqual({
      input: 2,
      output: 10,
      cache_write_5m: 2.5,
      cache_write_1h: 4,
      cache_read: 0.1,
    });
    expect(priceOf("claude-haiku-4-5-20251001")?.output).toBe(5);
  });

  it("normalises a model name and knows no price for an unknown one", () => {
    expect(normalizeModel("Claude-Haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(priceOf("gpt-5-codex")).toBeUndefined();
    expect(priceOf("constructor")).toBeUndefined();
  });

  it("prices each kind of token apart, and names the models it cannot price", () => {
    const priced = priceModels([
      MODEL({
        tokens_in: 1_000_000,
        tokens_out: 1_000_000,
        cache_read: 1_000_000,
        cache_write: 2_000_000,
        cache_write_1h: 1_000_000,
      }),
      MODEL({ model: "gpt-5-codex", tokens_in: 5_000_000 }),
    ]);
    // 4 + 20 + 0.2 + 5 (1M at 5 minutes) + 8 (1M at 1 hour)
    expect(priced.usd).toBe(37.2);
    expect(priced.complete).toBe(false);
    expect(priced.unpriced_models).toEqual(["gpt-5-codex"]);
  });
});

describe("Claude Code's transcript", () => {
  it("counts an answer once, with the largest of each count its streamed lines hold", () => {
    const text = [
      assistant("m1", "2026-10-06T10:00:00Z", {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_1h_input_tokens: 50 },
      }),
      assistant("m1", "2026-10-06T10:00:02Z", {
        input_tokens: 10,
        output_tokens: 425,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_1h_input_tokens: 50 },
      }),
      assistant("m2", "2026-10-06T10:01:00Z", {
        input_tokens: 2,
        output_tokens: 7,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 0,
      }),
    ].join("\n");
    const summary = readClaudeTranscript(text);
    expect(summary.models).toEqual([
      {
        model: "claude-opus-5-5",
        messages: 2,
        tokens_in: 12,
        tokens_out: 432,
        cache_read: 110,
        cache_write: 50,
        cache_write_1h: 50,
      },
    ]);
    expect(summary.started_at).toBe("2026-10-06T10:00:00.000Z");
    expect(summary.ended_at).toBe("2026-10-06T10:01:00.000Z");
  });

  it("splits models, skips synthetic answers, other lines and a half-written last line", () => {
    const text = [
      JSON.stringify({ type: "user", timestamp: "2026-10-06T10:00:00Z", message: {} }),
      assistant(
        "a",
        "2026-10-06T10:00:10Z",
        { input_tokens: 3, output_tokens: 4 },
        "claude-sonnet-5-5",
      ),
      assistant("b", "2026-10-06T10:00:20Z", { input_tokens: 9, output_tokens: 9 }, "<synthetic>"),
      JSON.stringify({ type: "attachment", timestamp: "2026-10-06T23:00:00Z" }),
      assistant(
        "c",
        "2026-10-06T10:00:30Z",
        { input_tokens: 1, output_tokens: 1 },
        "claude-haiku-4-5-20251001",
      ),
      '{"type":"assistant","timestamp":"2026-10-06T10:00:40Z","message":{"id":"half',
    ].join("\n");
    const summary = readClaudeTranscript(text);
    expect(summary.models.map((model) => model.model)).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5-5",
    ]);
    expect(summary.ended_at).toBe("2026-10-06T10:00:30.000Z");
  });

  it("counts the time a session worked: a gap over five minutes is the creator away", () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 6, 10, minutes)).toISOString();
    const text = [0, 2, 4, 60, 62]
      .map((minutes, index) => assistant(`m${index}`, at(minutes), { input_tokens: 1 }))
      .join("\n");
    expect(readClaudeTranscript(text).active_ms).toBe(6 * 60 * 1000);
  });

  it("reads an empty or foreign trace as consuming nothing", () => {
    expect(readClaudeTranscript("").models).toEqual([]);
    expect(readClaudeTranscript("not json\n[1]\n").models).toEqual([]);
  });
});

describe("Codex's rollout", () => {
  it("reads the last running total, cached input apart", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-10-06T10:00:00Z",
        type: "turn_context",
        payload: { model: "gpt-5-codex" },
      }),
      JSON.stringify({
        timestamp: "2026-10-06T10:01:00Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-10-06T10:02:00Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 90 },
          },
        },
      }),
    ].join("\n");
    const summary = readCodexRollout(text);
    expect(summary.models).toEqual([
      {
        model: "gpt-5-codex",
        messages: 2,
        tokens_in: 1000,
        tokens_out: 90,
        cache_read: 2000,
        cache_write: 0,
        cache_write_1h: 0,
      },
    ]);
    expect(summary.active_ms).toBe(2 * 60 * 1000);
  });

  const row = (at: string, type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ timestamp: at, type, payload });
  const count = (at: string, total: Record<string, number> | null) =>
    row(at, "event_msg", {
      type: "token_count",
      info: total === null ? null : { total_token_usage: total },
    });

  it("measures a rollout as Codex 0.160.1 really writes it (captured 2026-10-06): responses, totals and an unreadable `info`", () => {
    const usage = (input: number, cached: number, output: number, reasoning: number) => ({
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: reasoning,
      total_tokens: input + output,
    });
    const record = (at: string, id: string, last: ReturnType<typeof usage>, total = last) =>
      row(at, "token_usage_record", {
        thread_id: "01a1134f-d831-7bd3-a107-97ab1ef0afcb",
        turn_id: "01a1134f-d95d-7051-81fe-10cdc98d95af",
        session_id: "01a1134f-d831-7bd3-a107-97ab1ef0afcb",
        root_turn_id: "01a1134f-d95d-7051-81fe-10cdc98d95af",
        response_id: id,
        usage: last,
        turn_token_usage: total,
        thread_token_usage: total,
      });
    const total = (at: string, last: ReturnType<typeof usage>, sum: ReturnType<typeof usage>) =>
      row(at, "event_msg", {
        type: "token_count",
        info: { total_token_usage: sum, last_token_usage: last, model_context_window: 258400 },
        rate_limits: { limit_id: "codex", primary: null, secondary: null, credits: null },
      });
    const first = usage(1000, 400, 50, 10);
    const second = usage(1100, 450, 55, 10);
    const both = usage(2100, 850, 105, 20);
    const text = [
      row("2026-10-06T22:22:42.000Z", "session_meta", {
        id: "01a1134f-d831-7bd3-a107-97ab1ef0afcb",
        cwd: "/work/product",
        originator: "codex_exec",
        source: "exec",
        cli_version: "0.160.1",
      }),
      row("2026-10-06T22:22:43.000Z", "turn_context", {
        model: "gpt-6-luna",
        approval_policy: "never",
      }),
      record("2026-10-06T22:22:45.000Z", "resp_0", first),
      total("2026-10-06T22:22:54.000Z", first, first),
      record("2026-10-06T22:22:54.082Z", "resp_1", second, both),
      total("2026-10-06T22:22:54.084Z", second, both),
    ].join("\n");
    // Per response, what the cache did not serve: 1000 + 1100 in, minus 850 read from the cache.
    expect(readCodexRollout(text).models).toEqual([
      {
        model: "gpt-6-luna",
        messages: 2,
        tokens_in: 1250,
        tokens_out: 105,
        cache_read: 850,
        cache_write: 0,
        cache_write_1h: 0,
      },
    ]);
    // Without the per-response records, the growth of the total gives the same figures.
    const totals = text
      .split("\n")
      .filter((line) => !line.includes("token_usage_record"))
      .join("\n");
    expect(readCodexRollout(totals).models[0]).toMatchObject({
      tokens_in: 1250,
      tokens_out: 105,
      cache_read: 850,
    });
    // A session that stopped on the usage limit: `info` is null, nothing is measured.
    const refused = [
      row("2026-10-06T22:07:12.000Z", "turn_context", { model: "gpt-6-luna" }),
      row("2026-10-06T22:07:16.000Z", "event_msg", {
        type: "token_count",
        info: null,
        rate_limits: { limit_id: "premium", primary: null },
      }),
    ].join("\n");
    expect(readCodexRollout(refused).models).toEqual([]);
  });

  it("counts what each model consumed when the session changes model, from the growth of the total", () => {
    const text = [
      row("2026-10-06T10:00:00Z", "turn_context", { model: "gpt-5-codex" }),
      count("2026-10-06T10:01:00Z", {
        input_tokens: 1000,
        cached_input_tokens: 400,
        output_tokens: 100,
      }),
      row("2026-10-06T10:02:00Z", "turn_context", { model: "gpt-5.5" }),
      count("2026-10-06T10:03:00Z", {
        input_tokens: 4000,
        cached_input_tokens: 1400,
        output_tokens: 300,
      }),
    ].join("\n");
    expect(readCodexRollout(text).models).toEqual([
      {
        model: "gpt-5-codex",
        messages: 1,
        tokens_in: 600,
        tokens_out: 100,
        cache_read: 400,
        cache_write: 0,
        cache_write_1h: 0,
      },
      {
        model: "gpt-5.5",
        messages: 1,
        tokens_in: 2000,
        tokens_out: 200,
        cache_read: 1000,
        cache_write: 0,
        cache_write_1h: 0,
      },
    ]);
  });

  it("counts an event repeated, an empty one and a total that went back down only once", () => {
    const same = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50 };
    const text = [
      row("2026-10-06T10:00:00Z", "turn_context", { model: "gpt-5-codex" }),
      count("2026-10-06T10:00:10Z", same),
      count("2026-10-06T10:00:20Z", same),
      count("2026-10-06T10:00:30Z", null),
      // A new baseline (the session was compacted): what it holds is new.
      count("2026-10-06T10:00:40Z", {
        input_tokens: 300,
        cached_input_tokens: 0,
        output_tokens: 20,
      }),
    ].join("\n");
    const [only] = readCodexRollout(text).models;
    expect(only).toMatchObject({ messages: 2, tokens_in: 1300, tokens_out: 70, cache_read: 0 });
  });

  it("reads the cached count under either of its names, and never more cached than input", () => {
    const text = [
      row("2026-10-06T10:00:00Z", "turn_context", { model: "gpt-5-codex" }),
      count("2026-10-06T10:00:10Z", { input_tokens: 1000, cached_tokens: 700, output_tokens: 10 }),
      count("2026-10-06T10:00:20Z", { input_tokens: 1500, cached_tokens: 9000, output_tokens: 20 }),
    ].join("\n");
    const [only] = readCodexRollout(text).models;
    expect(only?.cache_read).toBe(700 + 500);
    expect(only?.tokens_in).toBe(300);
  });

  it("prefers the per-response records, each response once, over the running totals", () => {
    const record = (id: string, input: number, out: number) =>
      row("2026-10-06T10:01:00Z", "token_usage_record", {
        response_id: id,
        input_tokens: input,
        cached_input_tokens: 100,
        output_tokens: out,
      });
    const text = [
      row("2026-10-06T10:00:00Z", "turn_context", { model: "gpt-5-codex" }),
      count("2026-10-06T10:00:30Z", {
        input_tokens: 99999,
        cached_input_tokens: 0,
        output_tokens: 99999,
      }),
      record("r1", 500, 10),
      record("r1", 500, 25),
      record("r2", 800, 30),
    ].join("\n");
    expect(readCodexRollout(text).models).toEqual([
      {
        model: "gpt-5-codex",
        messages: 2,
        tokens_in: 400 + 700,
        tokens_out: 25 + 30,
        cache_read: 200,
        cache_write: 0,
        cache_write_1h: 0,
      },
    ]);
  });

  it("measures nothing of a rollout whose shape is not known, rather than a wrong figure", () => {
    const text = [
      row("2026-10-06T10:00:00Z", "turn_context", { model: "gpt-5-codex" }),
      row("2026-10-06T10:00:05Z", "event_msg", { type: "token_count", info: { usage: { in: 5 } } }),
      "not json",
    ].join("\n");
    expect(readCodexRollout(text).models).toEqual([]);
  });
});

const SESSION = (over: Partial<UsageSessionState> = {}): UsageSessionState => ({
  source: "claude-code",
  session: "s1",
  story: "1-1",
  agent: "sam",
  basis: "journal",
  started_at: "2026-10-06T10:00:00.000Z",
  ended_at: "2026-10-06T11:00:00.000Z",
  active_ms: 600_000,
  models: [MODEL({ tokens_out: 1_000_000 })],
  at: "2026-10-06T11:00:00.000Z",
  event: "E1",
  ...over,
});

describe("the estimates", () => {
  const merged = { merged: { at: "x" } } as unknown as StoryState;

  it("starts from the method's prudent reference, and says so", () => {
    const estimates = estimatesOf([]);
    expect(estimates.standard).toMatchObject({ basis: "reference", stories: 0 });
    expect(estimates.standard).toMatchObject(REFERENCE_ESTIMATES.standard);
    expect(estimates.fast.basis).toBe("reference");
  });

  it("rests on the product's measured stories from three on, with a range", () => {
    const sessions = [2, 4, 6, 8].map((usd, index) =>
      SESSION({
        session: `s${index}`,
        story: `1-${index + 1}`,
        // 1M output tokens of Opus 5.5 cost $20: scale by the wanted dollars.
        models: [MODEL({ tokens_out: (usd / 20) * 1_000_000 })],
      }),
    );
    const stories = Object.fromEntries(
      [1, 2, 3, 4].map((index) => [`1-${index}`, merged] as const),
    );
    const finished = finishedStories(stories, sessions);
    expect(finished.map((story) => story.usd)).toEqual([2, 4, 6, 8]);
    const estimates = estimatesOf(finished);
    expect(estimates.standard).toEqual({
      low: 2.5,
      expected: 5,
      high: 7.5,
      basis: "history",
      stories: 4,
    });
    // The fast lane has no history: still the reference.
    expect(estimates.fast.basis).toBe("reference");
  });

  it("leaves out a story that is not merged, unpriced, or free", () => {
    const sessions = [
      SESSION({ story: "1-1" }),
      SESSION({ session: "s2", story: "1-2" }),
      SESSION({
        session: "s3",
        story: "1-3",
        models: [MODEL({ model: "gpt-5-codex", tokens_in: 9 })],
      }),
    ];
    const finished = finishedStories({ "1-1": merged, "1-3": merged }, sessions);
    expect(finished.map((story) => story.story)).toEqual(["1-1"]);
  });

  it("gives the range the guard of plan_sprint keeps a budget in: three times off, either way", () => {
    const estimates = estimatesOf([]);
    // The reference spans $0.30 to $14: a budget may sit between $0.10 and $42.
    expect(estimates.guard).toEqual({ low: 0.1, high: 42, factor: 3 });
  });
});

describe("the figures and the view", () => {
  it("adds sessions, prices them at the table and counts tokens and time", () => {
    const figures = figuresOf([
      SESSION({ models: [MODEL({ tokens_in: 1_000_000, tokens_out: 500_000 })] }),
      SESSION({
        session: "s2",
        active_ms: 60_000,
        models: [MODEL({ tokens_out: 500_000, cache_read: 5_000_000 })],
      }),
    ]);
    expect(figures).toMatchObject({
      sessions: 2,
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
      cache_read: 5_000_000,
      active_ms: 660_000,
      complete: true,
    });
    // 4 + 10 + 10 + 1
    expect(figures.usd).toBe(25);
  });

  it("shows estimates only: never what a story, a sprint or the product really cost", () => {
    const view = usageView({
      state: {
        usage: {
          sessions: {
            "claude-code:s1": SESSION({ models: [MODEL({ tokens_out: 400_000 })] }),
            "claude-code:s2": SESSION({ session: "s2", story: null, agent: "main", basis: "none" }),
          },
        },
      },
      stories: {},
    });
    expect(Object.keys(view).sort()).toEqual(["estimates", "table"]);
    expect(view.table.version).toBe(PRICE_TABLE.version);
    expect(view.estimates.standard.basis).toBe("reference");
    expect(JSON.stringify(view)).not.toContain("tokens_out");
  });

  it("lets the measured history refine the estimates without showing it", () => {
    const merged = { merged: { at: "x" } } as unknown as StoryState;
    const sessions = Object.fromEntries(
      [2, 4, 6].map((usd, index) => [
        `claude-code:s${index}`,
        SESSION({
          session: `s${index}`,
          story: `1-${index + 1}`,
          models: [MODEL({ tokens_out: (usd / 20) * 1_000_000 })],
        }),
      ]),
    );
    const view = usageView({
      state: { usage: { sessions } },
      stories: { "1-1": merged, "1-2": merged, "1-3": merged },
    });
    expect(view.estimates.standard).toMatchObject({ basis: "history", stories: 3, expected: 4 });
    expect(Object.keys(view).sort()).toEqual(["estimates", "table"]);
  });
});

describe("the estimates never hand back a real cost", () => {
  it("gives the history's range on a half-dollar grid, pushed out", () => {
    const merged = { merged: { at: "x" } } as unknown as StoryState;
    const sessions = Object.fromEntries(
      [2.13, 4.37, 6.91].map((usd, index) => [
        `claude-code:s${index}`,
        SESSION({
          session: `s${index}`,
          story: `1-${index + 1}`,
          models: [MODEL({ tokens_out: (usd / 20) * 1_000_000 })],
        }),
      ]),
    );
    const view = usageView({
      state: { usage: { sessions } },
      stories: { "1-1": merged, "1-2": merged, "1-3": merged },
    });
    const { low, expected, high } = view.estimates.standard;
    for (const value of [low, expected, high]) expect(value % 0.5).toBe(0);
    expect([2.13, 4.37, 6.91]).not.toContain(expected);
    expect(low).toBeLessThanOrEqual(2.5);
    expect(high).toBeGreaterThanOrEqual(6.5);
  });
});
