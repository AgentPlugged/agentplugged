// The result of a trial as a Markdown table (what the workflow puts in the job summary and the
// creator reads after a local run).

const SYMBOL = { pass: "✅", fail: "❌", warn: "⚠️", skip: "⏭️" };

/** One line of the first sentence of a detail, with no pipe that would break a table. */
function cell(text) {
  return (text ?? "").split("\n")[0].replaceAll("|", "\\|").slice(0, 200);
}

export function counts(results) {
  const total = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const result of results) total[result.status] += 1;
  return total;
}

export function summaryMarkdown({ version, mode, platform, node, results }) {
  const total = counts(results);
  const lines = [
    `## Install trials: agentplugged ${version} on ${platform}, Node ${node} (${mode})`,
    "",
    `${total.pass} passed, ${total.fail} failed, ${total.warn} warning(s), ${total.skip} skipped`,
    "",
    "| | Terminal | Scenario | Detail |",
    "|---|---|---|---|",
  ];
  for (const result of results) {
    lines.push(`| ${SYMBOL[result.status]} | ${result.shell} | ${result.title} | ${cell(result.detail)} |`);
  }
  const failures = results.filter((result) => result.status === "fail");
  if (failures.length > 0) {
    lines.push("", "### Failures", "");
    for (const failure of failures) {
      lines.push(`**[${failure.shell}] ${failure.title}**`, "", "```text", failure.detail, "```", "");
    }
  }
  return lines.join("\n");
}
