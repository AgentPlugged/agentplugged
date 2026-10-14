import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { checkDocumentsDetailed, type DocumentFile, STRATEGY_DIR } from "../index.js";

/** `docs check` on the problem analyses and the innovation strategies. */

const PROBLEM = `${STRATEGY_DIR}problem-signup-drop.md`;
const STRATEGY = `${STRATEGY_DIR}innovation-pricing.md`;
const KB = `---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n`;

function problem(options: { header?: string; body?: string } = {}): string {
  const header =
    options.header ??
    "id: problem-signup-drop\nkind: note\nowner: lou\nlinks: [kb-index]\nlanguage: en";
  const body =
    options.body ??
    "# Problem: signup drop\n\n## Problem\n\nHalf of the visitors leave at the signup form.\n\n## Boundaries\n\nOnly on mobile, only the first visit.\n\n## Causes\n\nThe form asks for a card before any value is shown.\n\n## Forces\n\nA quick fix is wanted; the payment step is shared.\n\n## Options\n\n- Ask for the card later.\n- Remove the form.\n\n## Choice\n\nAsk for the card later.\n\n## Plan\n\n1. Move the card step.\n\n## Checks\n\nSignup completion, weekly.\n";
  return `---\n${header}\n---\n${body}`;
}

const COSTS = [
  "| Cost | Basis | Amount | Source |",
  "| --- | --- | --- | --- |",
  "| Build the product, 40 stories | estimated | 240 USD | `docs costs`, from the method's reference |",
  "| Hosting, a month | declared | 12 USD | you |",
].join("\n");

const ECONOMICS = (
  costs = COSTS,
  rest = "Price: 19 USD a month [source: you].\n\nBreak-even: 7 customers [source: docs costs].",
) => `${costs}\n\n${rest}\n`;

function strategy(options: { header?: string; economics?: string } = {}): string {
  const header =
    options.header ??
    "id: innovation-pricing\nkind: note\nowner: iris\nlinks: [kb-index]\nlanguage: en";
  const body = [
    "# Innovation strategy: pricing",
    "## Context\n\nA solo maker sells a notes tool.",
    "## Market\n\nMakers pay for tools that save them time [source: kb-index].",
    "## Model\n\nA monthly subscription; the cost per customer is mostly hosting.",
    "## Openings\n\nOnly makers who work alone are served by nobody.",
    "## Options\n\n- Subscription.\n- One-off licence.\n- Free with a paid team plan.",
    "## Direction\n\nSubscription first.",
    `## Economics\n\n${options.economics ?? ECONOMICS()}`,
    "## Roadmap\n\nPhase 1: ten paying makers.",
    "## Risks\n\nChurn above 8 percent a month kills it [to verify].",
  ].join("\n\n");
  return `---\n${header}\n---\n${body}`;
}

function check(files: Record<string, string>) {
  const current: DocumentFile[] = Object.entries({
    ".agentplugged/docs/index.md": KB,
    ...files,
  }).map(([path, text]) => ({ path, text }));
  return checkDocumentsDetailed({ current, owners: new Set(["lou", "iris", "zoe"]) });
}

const reasons = (result: ReturnType<typeof check>) =>
  result.problems
    .filter((problem) => problem.code === ErrorCode.LAUNCH_DOCUMENT_INVALID)
    .map((problem) => problem.details.reason);
const warnings = (result: ReturnType<typeof check>) => result.warnings.map((entry) => entry.reason);
const economics = (text: string) => reasons(check({ [STRATEGY]: strategy({ economics: text }) }));

describe("docs check: the problem analysis and the strategy", () => {
  it("accepts a whole problem analysis and a whole strategy", () => {
    const result = check({ [PROBLEM]: problem(), [STRATEGY]: strategy() });
    expect(result.problems).toEqual([]);
    expect(warnings(result)).toEqual([]);
  });

  it("refuses an id that is not the file's, a wrong owner, no source and a missing section", () => {
    const header = "id: problem-other\nkind: epic\nowner: sam\nlinks: []";
    expect(reasons(check({ [PROBLEM]: problem({ header }) })).sort()).toEqual([
      "language",
      "strategy_id",
      "strategy_kind",
      "strategy_links",
      "strategy_owner",
    ]);
    const body = problem().replace(
      "## Causes\n\nThe form asks for a card before any value is shown.\n\n",
      "",
    );
    expect(reasons(check({ [PROBLEM]: body.replace(/^/, "") }))).toEqual(["strategy_section"]);
    // A strategy is the iris's: Lou's name on it is refused.
    const lou = "id: innovation-pricing\nkind: note\nowner: lou\nlinks: [kb-index]\nlanguage: en";
    expect(reasons(check({ [STRATEGY]: strategy({ header: lou }) }))).toEqual(["strategy_owner"]);
  });

  it("leaves alone a file of the folder that is not a problem or a strategy", () => {
    expect(
      check({
        [`${STRATEGY_DIR}notes.md`]:
          "---\nid: notes\nkind: note\nowner: lou\nlinks: [kb-index]\n---\n# Notes\n",
      }).problems,
    ).toEqual([]);
  });

  it("warns of a market figure with no source", () => {
    const body = strategy().replace(" [source: kb-index]", " by 40% a year");
    expect(warnings(check({ [STRATEGY]: body }))).toContain("pitch_figure_unsourced");
  });
});

describe("docs check: the costs of the economics", () => {
  it("accepts the costs in French as well", () => {
    const costs = [
      "| Coût | Base | Montant | Source |",
      "| --- | --- | --- | --- |",
      "| Construire le produit, 40 stories | estimé | 240 USD | `docs costs` |",
      "| Hébergement | déclaré | 12 USD | toi |",
    ].join("\n");
    const rest =
      "Prix : 19 USD par mois [source : toi].\n\nSeuil de rentabilité : 7 clients [source : docs costs].";
    expect(economics(ECONOMICS(costs, rest))).toEqual([]);
  });

  it("refuses a cost that does not say whether it is estimated or declared", () => {
    const costs = COSTS.replace("| estimated |", "| about |");
    expect(economics(ECONOMICS(costs))).toEqual(["strategy_cost_basis"]);
    // No cost table at all, or a table with no basis column: the costs are not sourced.
    expect(
      economics("Hosting costs about 12 USD.\n\nBreak-even: 7 customers [source: you]."),
    ).toEqual(["strategy_cost_basis"]);
    const noBasis = "| Cost | Amount | Source |\n| --- | --- | --- |\n| Hosting | 12 USD | you |\n";
    expect(economics(ECONOMICS(noBasis))).toContain("strategy_cost_basis");
  });

  it("refuses a missing amount, and a zero that is an estimate", () => {
    expect(economics(ECONOMICS(COSTS.replace("12 USD", "to see")))).toEqual([
      "strategy_cost_amount",
    ]);
    expect(economics(ECONOMICS(COSTS.replace("12 USD", "")))).toEqual(["strategy_cost_amount"]);
    expect(economics(ECONOMICS(COSTS.replace("240 USD", "0")))).toEqual(["strategy_cost_zero"]);
    expect(economics(ECONOMICS(COSTS.replace("240 USD", "free")))).toEqual(["strategy_cost_zero"]);
    expect(economics(ECONOMICS(COSTS.replace("240 USD", "0.00 USD")))).toEqual([
      "strategy_cost_zero",
    ]);
  });

  it("reads an amount whatever its separators: 1 200, 3,5, 2–14", () => {
    for (const amount of ["1 200 USD", "1 200 USD", "3,5 EUR", "2–14 USD", "33"]) {
      expect(economics(ECONOMICS(COSTS.replace("240 USD", amount))), amount).toEqual([]);
    }
  });

  it("accepts a zero the creator declares: a free plan is a declaration, not a guess", () => {
    expect(economics(ECONOMICS(COSTS.replace("12 USD", "0")))).toEqual([]);
    expect(economics(ECONOMICS(COSTS.replace("12 USD", "gratuit")))).toEqual([]);
  });

  it("never shows a cost as real, actual or measured", () => {
    for (const basis of ["real", "actual", "measured", "réel", "mesuré", "Real"]) {
      expect(economics(ECONOMICS(COSTS.replace("| estimated |", `| ${basis} |`))), basis).toEqual([
        "strategy_cost_real",
      ]);
    }
    for (const wording of [
      "The real cost of a story is 6 USD.",
      "Estimated / real: 6 USD.",
      "Le coût réel est de 6 USD.",
      "estimé/réel : 6",
      "Measured spend so far: 40 USD.",
    ]) {
      const text = ECONOMICS(COSTS, `${wording}\n\nBreak-even: 7 customers [source: docs costs].`);
      expect(economics(text), wording).toEqual(["strategy_cost_real"]);
    }
    // Words about real customers are not about costs.
    const fine =
      "Real customers pay 19 USD a month [source: you].\n\nBreak-even: 7 customers [source: docs costs].";
    expect(economics(ECONOMICS(COSTS, fine))).toEqual([]);
  });

  it("sees through the disguises of a real cost: other cells, emphasis, accents, a comment after the sentence", () => {
    for (const cell of [
      "measured on 14 stories",
      "actual: 118",
      "`measured`",
      "Réel",
      "réel",
      "r​e​el",
    ]) {
      const costs = COSTS.replace("| declared |", `| declared ${cell} |`).replace(
        "declared R",
        "R",
      );
      expect(economics(ECONOMICS(costs.replace("you |", `${cell} |`))), cell).toContain(
        "strategy_cost_real",
      );
    }
    for (const wording of [
      "real **cost**: 6 USD.",
      "Estimated vs actual: 6 USD.",
      "Le coût effectif est de 6 USD.",
      "Coût réel : 6.",
      "Le coût réel est de 6 USD <!-- x -->",
      "Actually spent so far: 40 USD.",
      "~~~\nreal cost\n~~~",
    ]) {
      const text = ECONOMICS(COSTS, `${wording}\n\nBreak-even: 7 customers [source: docs costs].`);
      expect(economics(text), wording).toEqual(["strategy_cost_real"]);
    }
    // The direction, where the price is argued, is read too.
    const direction = strategy().replace(
      "Subscription first.",
      "Subscription first, the real cost is 6.",
    );
    expect(reasons(check({ [STRATEGY]: direction }))).toEqual(["strategy_cost_real"]);
    // A comment that hides a sentence is not read, a sentence before it is.
    expect(
      economics(
        ECONOMICS(COSTS, "<!-- real cost -->\n\nBreak-even: 7 customers [source: docs costs]."),
      ),
    ).toEqual([]);
  });

  it("refuses a negative amount, and takes the amount column over a period column", () => {
    expect(economics(ECONOMICS(COSTS.replace("12 USD", "-12 USD")))).toEqual([
      "strategy_cost_amount",
    ]);
    expect(economics(ECONOMICS(COSTS.replace("12 USD", "−12 USD")))).toEqual([
      "strategy_cost_amount",
    ]);
    const periods = [
      "| Cost | Period (per month) | Basis | Amount | Source |",
      "| --- | --- | --- | --- | --- |",
      "| Hosting | monthly | estimated | 0 | you |",
    ].join("\n");
    expect(economics(ECONOMICS(periods))).toEqual(["strategy_cost_zero"]);
  });

  it("warns when no break-even point is given, never refuses", () => {
    const result = check({
      [STRATEGY]: strategy({ economics: ECONOMICS(COSTS, "Price: 19 USD a month [source: you].") }),
    });
    expect(result.problems).toEqual([]);
    expect(warnings(result)).toEqual(["strategy_no_break_even"]);
  });

  it("holds over many tables: an estimate is never silently zero, a declaration may be (300 draws)", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 300; round += 1) {
      const rows = Array.from({ length: 1 + Math.floor(next() * 5) }, (_, index) => {
        const declared = next() < 0.5;
        const zero = next() < 0.3;
        const amount = zero
          ? ["0", "0,00", "free", "gratuit", "none"][Math.floor(next() * 5)]
          : `${1 + Math.floor(next() * 900)} USD`;
        return {
          declared,
          zero,
          line: `| Cost ${index} | ${declared ? "declared" : "estimated"} | ${amount} | you |`,
        };
      });
      const table = [
        "| Cost | Basis | Amount | Source |",
        "| --- | --- | --- | --- |",
        ...rows.map((row) => row.line),
      ].join("\n");
      const refused = rows.filter((row) => row.zero && !row.declared).length;
      const found = economics(ECONOMICS(table));
      expect(
        found.filter((reason) => reason === "strategy_cost_zero"),
        table,
      ).toHaveLength(refused);
      expect(found.filter((reason) => reason !== "strategy_cost_zero")).toEqual([]);
    }
  });
});
