import type { TestsSetupResult } from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";
import { displayText } from "./history-text.js";

/**
 * What `tests setup` did: the proposal written, or why not, then the runners of the
 * two levels, the line that runs the tests of a criterion, what must be installed (through the
 * creator's validation of installations) and what the plan leaves to check.
 */
export function formatTestsSetup(t: Translate, result: TestsSetupResult): string {
  const { plan } = result;
  const values = { path: result.path, stack: plan.stack };
  const lines: string[] = [];
  switch (result.status) {
    case "unknown_stack":
      lines.push(t("tests.setup.unknown"));
      break;
    case "invalid":
      lines.push(
        t("tests.setup.invalid", {
          ...values,
          problems: result.problems.map(displayText).join("; "),
        }),
      );
      break;
    default:
      lines.push(t(`tests.setup.${result.status}`, values));
  }
  if (plan.api !== null) {
    lines.push(
      t("tests.setup.runner", {
        level: t("tests.setup.level.api"),
        name: plan.api.name,
        how: t(`tests.setup.how.${plan.api.chosen}`),
      }),
    );
    lines.push(
      plan.e2e === null
        ? t("tests.setup.none")
        : t("tests.setup.runner", {
            level: t("tests.setup.level.e2e"),
            name: plan.e2e.name,
            how: t(`tests.setup.how.${plan.e2e.chosen}`),
          }),
    );
  }
  if (plan.line !== null) lines.push(t("tests.setup.line", { line: displayText(plan.line) }));
  for (const install of plan.installs) {
    lines.push(
      install.command === null
        ? t("tests.setup.install_manual", {
            ecosystem: install.ecosystem,
            packages: install.packages.join(" "),
          })
        : t("tests.setup.install", {
            ecosystem: install.ecosystem,
            command: displayText(install.command),
          }),
    );
  }
  for (const note of plan.notes) lines.push(t("tests.setup.note", { note: displayText(note) }));
  return `${lines.join("\n")}\n`;
}
