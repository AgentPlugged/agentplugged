import { DEFAULT_ALERT_RATIO, DEFAULT_ON_EXCEED, type MethodConfig } from "@agentplugged/protocol";
import type { BudgetSettingsInForce } from "./budget-rules.js";

/**
 * The single entry point of the budget settings: the alert ratio and what going over a ceiling
 * does. Everything that applies a budget reads them here, from the configuration the product
 * owns; a later source (the subscriber's settings kept on the servers) changes this function only.
 * A test fails when another module of the budget reads `budgets` itself.
 */
export function budgetSettings(config: Pick<MethodConfig, "budgets">): BudgetSettingsInForce {
  const budgets = config.budgets;
  return {
    alert_ratio: budgets?.alert_ratio ?? DEFAULT_ALERT_RATIO,
    on_exceed: budgets?.on_exceed ?? DEFAULT_ON_EXCEED,
  };
}
