import { ErrorCode } from "@agentplugged/protocol";
import { projectWithKey } from "../agent-activity/agent-commands.js";
import { type CommandContext, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { estimatesOf, type LaneEstimate, type UsdRange, usageView } from "./usage-rules.js";

/**
 * What it costs to build the product, as the method says it: an estimate, from
 * what the engine writes in the journal (the product's own finished stories, else the method's
 * reference), summed over the stories of the plan. Never what a session really consumed: the real
 * cost belongs to an optional module, which plugs in through `CostSource` and whose
 * figures this engine does not print.
 */

/** A cost an optional module measured, handed over by a `CostSource`. The engine never prints it. */
export interface ProvidedCost extends UsdRange {
  /** Who measured it, for the module that shows it. */
  readonly source: string;
}

/** The extension point: an optional module gives the measured cost of the stories of a plan. */
export interface CostSource {
  provide(scope: {
    readonly stories: number;
  }): Promise<ProvidedCost | undefined> | ProvidedCost | undefined;
}

/** When the product pays for itself, from the creator's own declared figures. */
export interface BreakEven {
  readonly price: number;
  readonly variable: number;
  readonly fixed: number;
  /** What each customer leaves after their variable cost. */
  readonly margin: number;
  /** Customers needed to cover the fixed costs; null when each customer costs more than they pay. */
  readonly customers: number | null;
}

export interface CostsFound {
  readonly costs: "estimate";
  readonly standard: LaneEstimate;
  readonly fast: LaneEstimate;
  /** The stories of the plan the estimate is summed over, or null when none is known. */
  readonly stories: number | null;
  readonly from: "asked" | "documents" | "none";
  /** The estimate for all the stories (standard lane), or null without stories. */
  readonly product: UsdRange | null;
  readonly break_even: BreakEven | null;
  /** The measured cost, when a source is plugged in: for a module, never printed here. */
  readonly provided?: ProvidedCost;
}

/** The arguments of `docs costs`, `key=value` words, all optional. */
export interface CostsAsk {
  readonly stories?: number;
  readonly price?: number;
  readonly variable?: number;
  readonly fixed?: number;
}

const KEYS = ["stories", "price", "variable", "fixed"] as const;
const NUMBER_WORD = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,4})?$/;

/** The words of `docs costs`, or the word that is not valid. */
export function parseCostsAsk(words: readonly string[]): CostsAsk | { readonly invalid: string } {
  const ask: Record<string, number> = {};
  for (const word of words) {
    const [key, value, ...extra] = word.split("=");
    if (
      key === undefined ||
      !(KEYS as readonly string[]).includes(key) ||
      value === undefined ||
      extra.length > 0 ||
      !NUMBER_WORD.test(value) ||
      Object.hasOwn(ask, key) ||
      (key === "stories" && !/^[1-9]\d{0,5}$/.test(value))
    ) {
      return { invalid: word };
    }
    ask[key] = Number(value);
  }
  // The break-even needs all three figures of the creator, or none.
  const given = ["price", "variable", "fixed"].filter((key) => key in ask);
  if (given.length !== 0 && given.length !== 3) {
    return { invalid: `${given.join(",")} (price, variable and fixed come together)` };
  }
  return ask;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The customers at which `fixed` costs are covered, or null when no customer ever covers them. */
export function breakEvenOf(price: number, variable: number, fixed: number): BreakEven {
  // The count is made on the margin as given; only what is shown is rounded.
  const exact = price - variable;
  return {
    price,
    variable,
    fixed,
    margin: round2(exact),
    customers: exact > 1e-9 ? Math.max(0, Math.ceil(fixed / exact - 1e-9)) : null,
  };
}

/** The estimate of `stories` stories at the standard lane's range: the sum of the stories, never a global guess. */
export function productEstimate(standard: UsdRange, stories: number): UsdRange {
  return {
    low: round2(standard.low * stories),
    expected: round2(standard.expected * stories),
    high: round2(standard.high * stories),
  };
}

/** The costs found, from the estimates and what the creator asked. Pure. */
export function costsOf(input: {
  readonly estimates: ReturnType<typeof estimatesOf>;
  readonly ask: CostsAsk;
  /** The stories counted in the documents of the product, when `stories` is not asked. */
  readonly documented: number;
}): CostsFound {
  const { ask } = input;
  const stories = ask.stories ?? (input.documented > 0 ? input.documented : null);
  return {
    costs: "estimate",
    standard: input.estimates.standard,
    fast: input.estimates.fast,
    stories,
    from: ask.stories !== undefined ? "asked" : stories === null ? "none" : "documents",
    product: stories === null ? null : productEstimate(input.estimates.standard, stories),
    break_even:
      ask.price === undefined ? null : breakEvenOf(ask.price, ask.variable ?? 0, ask.fixed ?? 0),
  };
}

const range = (value: UsdRange) =>
  `low ${value.low} | expected ${value.expected} | high ${value.high}`;
const lane = (name: string, value: LaneEstimate) =>
  `costs: ${name} lane, per story: ${range(value)} (${value.basis === "history" ? `from ${value.stories} finished stories of this product` : "the method's reference"})`;

/**
 * The lines `docs costs` prints. An estimate, said so on every figure; the measured cost a source
 * may have provided is not among them.
 */
export function costsLines(found: CostsFound): string[] {
  const lines = [
    "costs: estimates in US dollars at the API's public prices, not costs; the figures you give are yours (declared)",
    lane("standard", found.standard),
    lane("fast", found.fast),
    found.product === null || found.stories === null
      ? "costs: product estimate: no stories yet (give stories=<n>, or write the stories first)"
      : `costs: product estimate for ${found.stories} stories (${found.from}, standard lane): ${range(found.product)}`,
  ];
  const even = found.break_even;
  if (even !== null) {
    const given = `price ${even.price}, variable ${even.variable}, fixed ${even.fixed} (declared by you)`;
    lines.push(
      even.customers === null
        ? `costs: break-even: never, each customer costs ${even.variable} for ${even.price} paid; ${given}`
        : even.fixed === 0
          ? `costs: break-even: no fixed cost declared, margin ${even.margin} per customer; ${given}`
          : `costs: break-even: ${even.customers} customers, margin ${even.margin} per customer; ${given}`,
    );
  }
  return lines;
}

/** The stories of the plan: documents of `.agentplugged/stories/` whose kind is `story`. */
async function documentedStories(context: CommandContext): Promise<number> {
  const prefix = ".agentplugged/stories/";
  let count = 0;
  for (const path of await context.files.listFiles(prefix.slice(0, -1))) {
    if (!path.startsWith(prefix) || !path.toLowerCase().endsWith(".md")) continue;
    const text = await context.files.readText(path).catch(() => undefined);
    if (text !== undefined && /^kind:\s*["']?story["']?\s*$/m.test(text.split(/\n---/)[0] ?? "")) {
      count += 1;
    }
  }
  return count;
}

/** The estimates the journal gives: the product's history when this machine can read it, else the reference. */
async function journalEstimates(context: CommandContext): Promise<ReturnType<typeof estimatesOf>> {
  const reference = estimatesOf([]);
  if (context.journal === undefined || !(await context.files.exists(METHOD_CONFIG_PATH))) {
    return reference;
  }
  const loaded = await loadMethodConfig(context.files);
  if (loaded instanceof AgentPluggedError) return reference;
  try {
    const listing = await context.journal.list();
    const { projection } = await projectWithKey(context, loaded.config, listing);
    return usageView({
      state: projection.state,
      stories: (projection.state.stories as Record<string, StoryState> | undefined) ?? {},
    }).estimates;
  } catch (error) {
    // A folder without Git has no journal: the method's reference.
    if (error instanceof AgentPluggedError) return reference;
    throw error;
  }
}

/** `docs costs [stories=<n>] [price=<x> variable=<y> fixed=<z>]`: reads, writes nothing. */
export async function findCosts(context: CommandContext, words: readonly string[]) {
  const ask = parseCostsAsk(words);
  if ("invalid" in ask) {
    return fail(
      new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
        reason: `docs costs ${ask.invalid} (stories=<n> price=<x> variable=<y> fixed=<z>)`,
      }),
    );
  }
  const found = costsOf({
    estimates: await journalEstimates(context),
    ask,
    documented: ask.stories === undefined ? await documentedStories(context) : 0,
  });
  const provided =
    context.costSource === undefined || found.stories === null
      ? undefined
      : await context.costSource.provide({ stories: found.stories });
  return ok<CostsFound>(provided === undefined ? found : { ...found, provided });
}
