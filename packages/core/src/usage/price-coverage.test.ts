import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PRICE_TABLE, priceOf } from "./price-table.js";

// Vite's glob: the method's model table, read as is (this package has no file system types).
// @ts-expect-error `import.meta.glob` is Vite's: the types of this package do not load it.
const MODELS: Record<string, string> = import.meta.glob("../../../../method/models.yaml", {
  query: "?raw",
  import: "default",
  eager: true,
});
const MODELS_YAML = Object.values(MODELS)[0] ?? "";

/**
 * Every model the method names must have a price in the table, or be said unknown on purpose.
 * A name the tools resolve (an alias) maps to the model it was seen to resolve to; an alias that
 * was not verified stays `unknown` (no price is guessed), and `inherit` names no model.
 */
const ALIASES: Readonly<Record<string, string | "unknown">> = {
  // Seen in the stream of Claude Code (`--model haiku`, `--model sonnet`).
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  // Not verified against the tool: no price is guessed.
  opus: "unknown",
  pro: "unknown",
  flash: "unknown",
};

describe("the price table and the models the method names", () => {
  const table = parse(MODELS_YAML) as Record<string, Record<string, { model: string }>>;

  it("prices every model of the method, or says explicitly that it is unknown", () => {
    const named = new Set<string>();
    for (const tiers of Object.values(table)) {
      for (const cell of Object.values(tiers)) named.add(cell.model);
    }
    named.delete("inherit");
    for (const name of named) {
      const resolved = Object.hasOwn(ALIASES, name) ? ALIASES[name] : name;
      expect(resolved, `${name} has neither a price nor an explicit "unknown"`).toBeDefined();
      if (resolved === "unknown") continue;
      expect(priceOf(resolved as string), `${name} -> ${resolved}`).toBeDefined();
    }
  });

  it("knows the current Claude 5 family at the prices of the official page", () => {
    expect(PRICE_TABLE.as_of).toBe("2026-10-17");
    expect(priceOf("claude-haiku-5-5")).toMatchObject({
      input: 0.1,
      output: 0.5,
      cache_read: 0.01,
    });
    expect(priceOf("claude-sonnet-5-5")).toMatchObject({ input: 2, output: 10, cache_read: 0.1 });
    expect(priceOf("claude-opus-5-5")).toMatchObject({ input: 4, output: 20 });
    expect(priceOf("claude-fable-5-1")).toMatchObject({ input: 10, output: 50 });
  });
});
