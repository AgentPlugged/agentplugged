import type { UsageModel } from "@agentplugged/protocol";

/**
 * The public prices of the API per model, the only basis of a cost shown in dollars:
 * what the measured tokens would cost at these prices, never an amount the creator was billed.
 * The table is dated and versioned: a new price makes a new version, and every amount shown names
 * the version it was computed with. A model absent from the table has no price (its tokens and
 * time are shown, its amount is not guessed).
 */
export interface ModelPrice {
  /** US dollars per million tokens. */
  readonly input: number;
  readonly output: number;
  readonly cache_write_5m: number;
  readonly cache_write_1h: number;
  readonly cache_read: number;
}

export interface PriceTable {
  /** Changes with every edit of a price: the date of the reading, then a letter if read twice a day. */
  readonly version: string;
  /** The day the prices were read at their source. */
  readonly as_of: string;
  readonly source: string;
  readonly models: Readonly<Record<string, ModelPrice>>;
}

/** A price from its input price: cache writes cost 1.25x (5 minutes) and 2x (1 hour). */
const price = (input: number, output: number, cacheRead: number): ModelPrice => ({
  input,
  output,
  cache_write_5m: input * 1.25,
  cache_write_1h: input * 2,
  cache_read: cacheRead,
});

/**
 * A Gemini price: Google bills the prompt cache by reading and by storage, never by a
 * write, so a cache write costs what plain input costs (the engine counts none for Antigravity).
 */
const gemini = (input: number, output: number, cacheRead: number): ModelPrice => ({
  input,
  output,
  cache_write_5m: input,
  cache_write_1h: input,
  cache_read: cacheRead,
});

/**
 * Claude: read on 2026-10-06 at https://platform.claude.com/docs/en/about-claude/pricing (US dollars per
 * million tokens; standard speed, global routing, no batch discount). Cache hits cost 0.1x the
 * input price, except Opus 5.5 (0.05x) and Fable 5.1 (0.025x).
 *
 * Gemini: read on 2026-10-07 at https://ai.google.dev/gemini-api/docs/pricing (paid tier, standard,
 * text; output includes the reasoning). Where Google prices a prompt of more than 200 000 tokens
 * higher (Pro), the table holds the price up to 200 000, the usual prompt. The 3.6 to 3.8 Flash
 * prices are those until 2026-12-31 (they double on 2027-01-01: a new version then). A model of
 * another maker that Antigravity offers (GPT-OSS) has no public price here: no amount.
 */
export const PRICE_TABLE: PriceTable = {
  version: "2026-10-07",
  as_of: "2026-10-07",
  source:
    "https://platform.claude.com/docs/en/about-claude/pricing and https://ai.google.dev/gemini-api/docs/pricing",
  models: {
    "claude-fable-5-1": price(10, 50, 0.25),
    "claude-fable-5": price(10, 50, 1),
    "claude-opus-5-5": price(4, 20, 0.2),
    "claude-opus-5": price(5, 25, 0.5),
    "claude-opus-4-8": price(5, 25, 0.5),
    "claude-opus-4-7": price(5, 25, 0.5),
    "claude-opus-4-6": price(5, 25, 0.5),
    "claude-opus-4-5": price(5, 25, 0.5),
    "claude-opus-4-1": price(15, 75, 1.5),
    "claude-opus-4": price(15, 75, 1.5),
    "claude-sonnet-5-5": price(2, 10, 0.2),
    "claude-sonnet-5": price(2, 10, 0.2),
    "claude-sonnet-4-6": price(3, 15, 0.3),
    "claude-sonnet-4-5": price(3, 15, 0.3),
    "claude-sonnet-4": price(3, 15, 0.3),
    "claude-haiku-4-5": price(1, 5, 0.1),
    "claude-haiku-3-5": price(0.8, 4, 0.08),
    "gemini-3.1-pro": gemini(2, 12, 0.2),
    "gemini-3.1-pro-preview": gemini(2, 12, 0.2),
    "gemini-3.8-flash": gemini(0.75, 3.75, 0.075),
    "gemini-3.7-flash": gemini(0.75, 3.75, 0.075),
    "gemini-3.6-flash": gemini(0.75, 3.75, 0.075),
    "gemini-3.5-flash": gemini(1.5, 9, 0.15),
    "gemini-3.5-flash-lite": gemini(0.3, 2.5, 0.03),
    "gemini-3.1-flash-lite": gemini(0.25, 1.5, 0.025),
    "gemini-2.5-pro": gemini(1.25, 10, 0.125),
    "gemini-2.5-flash": gemini(0.3, 2.5, 0.03),
    "gemini-2.5-flash-lite": gemini(0.1, 0.4, 0.01),
  },
};

/** A model as the table names it: lower case, without a context suffix (`[1m]`) or a date (`-20251001`). */
export function normalizeModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/u, "")
    .replace(/-\d{8}$/u, "");
}

/** The price of a model, or undefined when the table does not know it. */
export function priceOf(model: string, table: PriceTable = PRICE_TABLE): ModelPrice | undefined {
  const key = normalizeModel(model);
  return Object.hasOwn(table.models, key) ? table.models[key] : undefined;
}

/** What `models` would cost at the table's prices. */
export interface PricedModels {
  /** Dollars of the models the table knows, rounded to the micro-dollar. */
  readonly usd: number;
  /** False when a model has no price: `usd` then leaves it out. */
  readonly complete: boolean;
  readonly unpriced_models: readonly string[];
}

/** Dollars of one model's consumption at one price. */
export function usdOf(usage: UsageModel, rate: ModelPrice): number {
  const fiveMinutes = Math.max(0, usage.cache_write - usage.cache_write_1h);
  return (
    (usage.tokens_in * rate.input +
      usage.tokens_out * rate.output +
      fiveMinutes * rate.cache_write_5m +
      usage.cache_write_1h * rate.cache_write_1h +
      usage.cache_read * rate.cache_read) /
    1e6
  );
}

/** The cost of `models` at the table's prices: the sum of the priced ones, the others named. */
export function priceModels(
  models: readonly UsageModel[],
  table: PriceTable = PRICE_TABLE,
): PricedModels {
  let usd = 0;
  const unpriced = new Set<string>();
  for (const usage of models) {
    const rate = priceOf(usage.model, table);
    if (rate === undefined) unpriced.add(usage.model);
    else usd += usdOf(usage, rate);
  }
  return {
    usd: Math.round(usd * 1e6) / 1e6,
    complete: unpriced.size === 0,
    unpriced_models: [...unpriced].sort(),
  };
}
