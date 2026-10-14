import { RULE_ACTIONS, type RuleAction, type RuleValue } from "@agentplugged/protocol";
import { GENERATED_HEADER_HASH } from "../init/generated.js";
import { forbiddenShellPatterns } from "./permissions.js";
import { protectedBranches, type ShellRulePattern, shellRulePatterns } from "./rule-permissions.js";

/**
 * The rules of commands Codex applies itself: `.codex/rules/agentplugged.rules`, a
 * Starlark file of `prefix_rule(pattern=[…], decision=…)`. A rule matches the first words of a
 * command, whole words only (no wildcard): `forbidden` refuses it (the product's `deny`), `prompt`
 * asks the creator when the command leaves the sandbox (the product's `ask`), `allow` runs a
 * command outside the sandbox without asking. Codex reads the file in a trusted project, hooks
 * approved or not: before the creator approves the hooks, these rules are all that refuses.
 *
 * Only what a prefix of words says exactly is written; the rest (a wildcard in the middle, a
 * command run from another folder, SQL in a command line, the main branch pushed by its short
 * form) is the hook's, which reads the whole command line with the engine's reader. Best effort,
 * like every command rule: a shell can reach a program another way.
 */

/** `rm`'s flags that remove recursively, whole words (`rm -rf /`): Codex compares words, not stems. */
const RM_RECURSIVE = ["-r", "-R", "-rf", "-fr", "-Rf", "-fR", "-rfv", "-frv", "--recursive"];

/**
 * The git commands that write the repository: Codex's sandbox keeps `.git` read-only, so they run
 * outside it. Not `rebase` (`--exec` runs a program) nor `worktree` (it writes outside the project):
 * the engine makes the working copies itself.
 */
const GIT_WRITES = [
  "add",
  "commit",
  "switch",
  "checkout",
  "branch",
  "merge",
  "stash",
  "restore",
  "cherry-pick",
  "tag",
];

const HAS_WILDCARD = /[*?]/;

type Word = string | readonly string[];

const starlark = (word: Word): string =>
  typeof word === "string"
    ? JSON.stringify(word)
    : `[${word.map((entry) => JSON.stringify(entry)).join(", ")}]`;

/** One word of a shell pattern as a prefix word, or undefined when a prefix cannot say it. */
function wordOf(part: string, command: string, first: boolean, last: boolean): Word | undefined {
  // `rm -r* /`: the recursive flags, whole words.
  if (command === "rm" && first && /^-[a-zA-Z]{1,2}\*$/.test(part)) return RM_RECURSIVE;
  if (!HAS_WILDCARD.test(part)) return part;
  // A trailing star after a literal stem (`install*`): the stem, whole.
  const stem = part.slice(0, -1);
  return last && part.endsWith("*") && stem !== "" && !HAS_WILDCARD.test(stem) ? stem : undefined;
}

/** The words of a shell pattern as a prefix pattern, or undefined when a prefix cannot say it. */
function wordsOf(pattern: ShellRulePattern): Word[] | undefined {
  if (HAS_WILDCARD.test(pattern.command)) return undefined;
  const parts = pattern.args === "" || pattern.args === "*" ? [] : pattern.args.split(" ");
  const words: Word[] = [pattern.command];
  for (const [index, part] of parts.entries()) {
    const word = wordOf(part, pattern.command, index === 0, index === parts.length - 1);
    if (word === undefined) return undefined;
    words.push(word);
  }
  return words;
}

interface Rule {
  readonly words: readonly Word[];
  readonly decision: "forbidden" | "prompt" | "allow";
  readonly justification: string;
}

const justificationOf = (action: string, value: string): string =>
  `AgentPlugged: the permission rule \`${action}\` is \`${value}\` for this product.`;

/** The pushes the main branch's names reach, and the forced ones, written by hand (see `wordsOf`). */
function pushRules(
  action: "push_main" | "force_push",
  decision: "forbidden" | "prompt",
  mainBranch: string | undefined,
): Rule[] {
  const justification = justificationOf(action, decision === "forbidden" ? "deny" : "ask");
  const forced = ["--force", "-f", "--force-with-lease"];
  if (action === "force_push") {
    return [
      { words: ["git", "push", forced], decision, justification },
      { words: ["git", "push", "origin", forced], decision, justification },
    ];
  }
  const branches = protectedBranches(mainBranch);
  return branches.flatMap((branch) =>
    ["origin", "upstream"].map((remote) => ({
      words: ["git", "push", remote, [branch, `HEAD:${branch}`, `refs/heads/${branch}`]],
      decision,
      justification,
    })),
  );
}

const NEVER_RUN =
  "AgentPlugged: agents never run this command (the journal, the merge, the forges' tokens, another AI session).";

/**
 * The text of `.codex/rules/agentplugged.rules` for the rules in force. Every rule of a command that
 * is `deny` becomes `forbidden` when a prefix of words can say it, and so do the commands agents
 * may never run (a merge by hand, the forges' tokens, the journal's branch, another AI session). An
 * `ask` becomes `prompt` only with approval `on-request`: with `never` Codex cannot ask, a `prompt`
 * would be a refusal no answer could lift, and the agent asks in the chat instead. With
 * `edit_code` allowed, the git commands that write the repository are `allow` (they would fail in
 * the sandbox, which keeps `.git` read-only, and the night has nobody to approve them).
 */
export function renderCodexRules(
  rules: Readonly<Record<RuleAction, RuleValue>>,
  mainBranch?: string,
  approval: "never" | "on-request" = "on-request",
): string {
  const found: Rule[] = [];
  for (const action of RULE_ACTIONS) {
    const value = rules[action];
    if (value === "allow" || (value === "ask" && approval === "never")) continue;
    const decision = value === "deny" ? "forbidden" : "prompt";
    if (action === "push_main" || action === "force_push") {
      found.push(...pushRules(action, decision, mainBranch));
      continue;
    }
    const justification = justificationOf(action, value);
    for (const pattern of shellRulePatterns(action, mainBranch)) {
      const words = wordsOf(pattern);
      if (words !== undefined) found.push({ words, decision, justification });
    }
  }
  for (const pattern of forbiddenShellPatterns()) {
    const words = wordsOf(pattern);
    if (words !== undefined) found.push({ words, decision: "forbidden", justification: NEVER_RUN });
  }
  if (rules.edit_code === "allow") {
    found.push({
      words: ["git", GIT_WRITES],
      decision: "allow",
      justification:
        "AgentPlugged: git commands that write the repository run outside the sandbox (it keeps .git read-only); a push stays under the push rules.",
    });
  }
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const rule of found) {
    const pattern = `[${rule.words.map(starlark).join(", ")}]`;
    const key = `${pattern}|${rule.decision}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(
      `prefix_rule(\n    pattern = ${pattern},\n    decision = ${JSON.stringify(rule.decision)},\n    justification = ${JSON.stringify(rule.justification)},\n)\n`,
    );
  }
  return `${GENERATED_HEADER_HASH}\n# The product's permission rules, as Codex's own rules of commands.\n\n${blocks.join("\n")}`;
}
