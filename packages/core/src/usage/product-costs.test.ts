import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import {
  breakEvenOf,
  type CostSource,
  costsLines,
  costsOf,
  findCosts,
  parseCostsAsk,
  productEstimate,
} from "./product-costs.js";
import { estimatesOf, type FinishedStory, REFERENCE_ESTIMATES } from "./usage-rules.js";

/**
 * The method gives the cost of the product as an estimate, from what
 * the engine writes in the journal, and never as the cost really measured; an optional module plugs in
 * through a generic point that this engine does not print.
 */

const reference = estimatesOf([]);
const word = /real|actual|measured|r[ée]el|mesur/i;

describe("the arguments of docs costs", () => {
  it("reads key=value words and refuses the rest", () => {
    expect(parseCostsAsk([])).toEqual({});
    expect(parseCostsAsk(["stories=40"])).toEqual({ stories: 40 });
    expect(parseCostsAsk(["price=19", "variable=2.5", "fixed=120"])).toEqual({
      price: 19,
      variable: 2.5,
      fixed: 120,
    });
    for (const bad of [
      ["stories=0"],
      ["stories=2.5"],
      ["stories=-3"],
      ["stories=x"],
      ["stories=4", "stories=5"],
      ["cost=4"],
      ["price=19"],
      ["price=19", "variable=1"],
      ["fixed=12", "variable=1"],
      ["price=1e9", "variable=1", "fixed=1"],
    ]) {
      expect(parseCostsAsk(bad), bad.join(" ")).toHaveProperty("invalid");
    }
  });
});

describe("the break-even point, from the creator's own figures", () => {
  it("is the fixed costs over what each customer leaves, rounded up", () => {
    expect(breakEvenOf(19, 2.5, 120)).toMatchObject({ margin: 16.5, customers: 8 });
    expect(breakEvenOf(10, 0, 100).customers).toBe(10);
    expect(breakEvenOf(10, 5, 101).customers).toBe(21);
  });

  it("is never when a customer costs as much as they pay, and needs no customer for no fixed cost", () => {
    expect(breakEvenOf(5, 5, 100).customers).toBeNull();
    expect(breakEvenOf(5, 9, 100).customers).toBeNull();
    expect(breakEvenOf(5, 1, 0).customers).toBe(0);
  });

  it("counts on the margin as given, and rounds only what it shows", () => {
    expect(breakEvenOf(10, 9.996, 1).customers).toBe(250);
    expect(breakEvenOf(0.014, 0, 1).customers).toBe(72);
    expect(breakEvenOf(0, 0, 0).customers).toBeNull();
  });

  it("never rounds a customer short: customers * margin always covers the fixed costs (300 draws)", () => {
    let seed = 11;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 300; round += 1) {
      const price = Math.round(next() * 20000) / 100;
      const variable = Math.round(next() * 20000) / 100;
      const fixed = Math.round(next() * 500000) / 100;
      const even = breakEvenOf(price, variable, fixed);
      if (even.customers === null) {
        expect(price - variable).toBeLessThanOrEqual(0.0001);
      } else {
        expect(even.customers * (price - variable) + 0.01).toBeGreaterThanOrEqual(fixed);
        expect(Math.max(0, even.customers - 1) * (price - variable)).toBeLessThanOrEqual(
          fixed + 0.01,
        );
      }
    }
  });
});

describe("the estimate of the product", () => {
  it("is the sum of its stories at the standard lane, never a global figure", () => {
    expect(productEstimate(REFERENCE_ESTIMATES.standard, 40)).toEqual({
      low: 80,
      expected: 240,
      high: 560,
    });
    const found = costsOf({ estimates: reference, ask: {}, documented: 12 });
    expect(found).toMatchObject({ stories: 12, from: "documents", costs: "estimate" });
    expect(found.product).toEqual({ low: 24, expected: 72, high: 168 });
    // What the creator asks wins over what the documents hold; without any story, no total.
    expect(costsOf({ estimates: reference, ask: { stories: 5 }, documented: 12 })).toMatchObject({
      stories: 5,
      from: "asked",
    });
    expect(costsOf({ estimates: reference, ask: {}, documented: 0 })).toMatchObject({
      stories: null,
      from: "none",
      product: null,
    });
  });

  it("is never a silent zero: every figure is above zero, and said to be an estimate", () => {
    const lines = costsLines(costsOf({ estimates: reference, ask: { stories: 3 }, documented: 0 }));
    expect(lines[0]).toContain("estimates");
    for (const line of lines.slice(1)) expect(line, line).toMatch(/\d/);
    expect(lines.join("\n")).not.toMatch(/(?:low|expected|high|for) 0(?![.\d])/);
    // With no story to sum over, it says so instead of printing a zero total.
    const none = costsLines(costsOf({ estimates: reference, ask: {}, documented: 0 }));
    expect(none.join("\n")).toContain("no stories yet");
    expect(none.join("\n")).not.toMatch(/product estimate for/);
  });

  it("comes from the product's own finished stories once there are enough, on the half-dollar grid", () => {
    const finished: FinishedStory[] = [4.13, 5.27, 6.91, 7.33].map((usd, index) => ({
      story: `1-${index + 1}`,
      lane: "standard",
      usd,
    }));
    const text = costsLines(
      costsOf({ estimates: estimatesOf(finished), ask: { stories: 10 }, documented: 0 }),
    ).join("\n");
    expect(text).toContain("from 4 finished stories of this product");
    // The real cents of those stories are nowhere: the history is rounded outward onto a grid.
    for (const usd of finished.map((story) => story.usd)) expect(text).not.toContain(String(usd));
  });
});

describe("the engine never shows the real cost", () => {
  const measured: CostSource = {
    provide: () => ({ source: "extension", low: 123.45, expected: 234.56, high: 345.67 }),
  };
  const context = (costSource?: CostSource) =>
    ({
      files: {
        exists: async () => false,
        listFiles: async () => [],
        readText: async () => "",
      },
      ...(costSource === undefined ? {} : { costSource }),
    }) as unknown as CommandContext;

  it("says only estimates, without the words real, actual or measured", () => {
    const text = costsLines(
      costsOf({
        estimates: reference,
        ask: { stories: 7, price: 19, variable: 2, fixed: 100 },
        documented: 0,
      }),
    ).join("\n");
    expect(text).not.toMatch(word);
    expect(text).toContain("break-even");
  });

  it("lets an optional module provide the measured cost, and prints none of it", async () => {
    const free = await findCosts(context(), ["stories=7"]);
    expect(free.ok).toBe(true);
    if (!free.ok) return;
    expect(free.value).not.toHaveProperty("provided");
    const withSource = await findCosts(context(measured), ["stories=7"]);
    expect(withSource.ok).toBe(true);
    if (!withSource.ok) return;
    // The module gets the figures through the result...
    expect(withSource.value.provided).toMatchObject({ source: "extension", expected: 234.56 });
    // ...and the public text is the same, line for line.
    expect(costsLines(withSource.value)).toEqual(costsLines(free.value));
    expect(costsLines(withSource.value).join("\n")).not.toMatch(/123|234|345|extension/);
  });

  it("asks nothing of the source without a story to sum over", async () => {
    let asked = 0;
    const source: CostSource = {
      provide: () => {
        asked += 1;
        return undefined;
      },
    };
    const found = await findCosts(context(source), []);
    expect(found.ok && found.value.stories).toBeNull();
    expect(asked).toBe(0);
  });

  it("refuses an argument it does not know", async () => {
    const refused = await findCosts(context(), ["real=3"]);
    expect(refused.ok).toBe(false);
  });
});
