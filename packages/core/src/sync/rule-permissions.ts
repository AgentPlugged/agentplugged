import { RULE_ACTIONS, type RuleAction, type RuleValue } from "@agentplugged/protocol";

/**
 * How `sync` writes the permission rules in each AI tool's own syntax. Every
 * pattern is best-effort: a shell can always reach a program another way (a path, `sh -c`). The
 * constitution lists the rules in force, which agents follow whatever the tool.
 */

/** One thing an action covers, before it is written in a tool's syntax. */
type RulePattern =
  /** Reading files: `project` is the whole project, otherwise a glob (`**\/*.pem`, `~/.ssh/**`). */
  | { readonly kind: "read"; readonly path: "project" | string }
  /** Writing the project's files. */
  | { readonly kind: "write" }
  /**
   * A shell command: `command` then the arguments pattern (`*` alone: any arguments). With
   * `claudeOnly`, Cursor gets no equivalent (its syntax matches the command first).
   */
  | {
      readonly kind: "shell";
      readonly command: string;
      readonly args: string;
      readonly claudeOnly?: boolean;
    }
  /** The tools' own web access (fetch and search). */
  | { readonly kind: "web" };

/** Shell patterns of one command; `""` is the command alone, without arguments. */
const shell = (command: string, ...args: string[]): RulePattern[] =>
  args.map((pattern) => ({ kind: "shell", command, args: pattern }));

/** Shell patterns written for Claude Code only (see each use for why). */
const claudeOnly = (command: string, ...args: string[]): RulePattern[] =>
  args.map((pattern) => ({ kind: "shell", command, args: pattern, claudeOnly: true }));

/**
 * The checks, through the project's scripts and the usual runners. A package runner (`npx`,
 * `pnpm dlx`, `bunx`) is `install_dependency`: it may download a package.
 */
const RUN_CHECKS: readonly RulePattern[] = [
  ...shell("npm", "test*", "run test*", "run lint*", "run build*", "run typecheck*", "run check*"),
  ...shell(
    "pnpm",
    "test*",
    "lint*",
    "build*",
    "typecheck*",
    "run test*",
    "run lint*",
    "run build*",
    "run typecheck*",
  ),
  ...shell("yarn", "test*", "lint*", "build*", "typecheck*"),
  ...shell("bun", "test*", "run test*", "run lint*", "run build*"),
  ...shell("cargo", "test*", "build*", "check*", "clippy*"),
  ...shell("go", "test*", "build*", "vet*"),
  ...shell("pytest", "*"),
  ...shell("python", "-m pytest*"),
  ...shell("make", "test*", "lint*", "build*", "check*"),
];

/**
 * The installations of dependencies and the package runners (`npx`, `pnpm dlx`, `bunx`): they may
 * download a package. At the default (`allow`) they go through: the engine records them in the
 * activity (`installs.mode: visible`).
 */
const INSTALL_DEPENDENCY: readonly RulePattern[] = [
  ...shell("npm", "install*", "i", "i *", "add*", "ci*"),
  ...shell("pnpm", "add*", "i*"),
  ...shell("yarn", "add*", "install*"),
  // `yarn` alone installs; for Cursor, `Shell(yarn)` would cover every yarn command.
  ...claudeOnly("yarn", ""),
  ...shell("bun", "add*", "i*"),
  // An option before the verb: `npm --prefix dir install x`, `pnpm -C dir add x`,
  // `yarn --cwd dir add x`, `npm --silent install x`. Without these such a command would not match
  // the patterns above and would go through the gate unseen. Each pattern names the verb, so that
  // `npm --prefix dir run build` or `pnpm -C dir info` stay free.
  ...shell("npm", "-* install*", "-* i", "-* i *", "-* add*", "-* ci*"),
  ...shell("pnpm", "-* add*", "-* install*", "-* i", "-* i *"),
  ...shell("yarn", "-* add*", "-* install*"),
  ...shell("bun", "-* add*", "-* install*", "-* i", "-* i *"),
  // Package runners download what they run. Claude Code only: for Cursor CLI an `ask` is a
  // `deny`, which would also block `npx agentplugged docs check` (the constitution asks for it).
  ...claudeOnly("npx", "*"),
  ...claudeOnly("pnpm", "dlx *"),
  ...claudeOnly("bunx", "*"),
  ...claudeOnly("yarn", "dlx *"),
  ...claudeOnly("bun", "x *"),
  ...claudeOnly("npm", "exec *"),
  ...claudeOnly("pnpm", "exec *", "-* dlx *"),
  ...shell("pip", "install*"),
  ...shell("pip3", "install*"),
  ...shell("python", "-m pip install*"),
  ...shell("uv", "add*", "pip install*"),
  ...shell("poetry", "add*"),
  ...shell("cargo", "add*", "install*"),
  ...shell("go", "get*", "install*"),
  ...shell("gem", "install*"),
  ...shell("bundle", "add*"),
  ...shell("composer", "require*"),
];

const INTERNET: readonly RulePattern[] = [
  { kind: "web" },
  ...shell("curl", "*"),
  ...shell("wget", "*"),
  // PowerShell's downloaders, the shell Antigravity runs its commands in on Windows.
  ...shell("Invoke-WebRequest", "*"),
  ...shell("Invoke-RestMethod", "*"),
  ...shell("iwr", "*"),
  ...shell("irm", "*"),
];

/** SQL that drops a whole database, in its common casings (Bash rules match case-sensitively). */
const DESTRUCTIVE_SQL = ["DROP DATABASE", "DROP SCHEMA"].flatMap((sql) => {
  const lower = sql.toLowerCase();
  const title = lower.replace(/\b\w/g, (c) => c.toUpperCase());
  return [sql, lower, title];
});

/** What a recursive removal must never aim at: a root, the home folder, the parent folder. */
const MASS_DELETE_TARGETS = ["/", "~", "~/", "$HOME", "$HOME/", '"$HOME"', "..", "../"];

/** `rm`'s flags that remove recursively, as the start of the word (`-rf`, `-fr`, `-Rfv`…). */
const RECURSIVE_FLAGS = ["-r*", "-R*", "-fr*", "-fR*", "--recursive*"];

/** Windows' roots and home folder, for PowerShell and cmd (the shells Antigravity uses there). */
const WINDOWS_TARGETS = ["C:\\", "C:/", "%USERPROFILE%", "$env:USERPROFILE", "$HOME", "~"];

/**
 * The gestures that delete in mass outside the repository: a recursive removal of a
 * root, of the home folder or of the parent folder, a disk wiped, a whole database dropped. The
 * removals inside the repository (`rm -rf node_modules dist`, `git clean`, `git reset --hard`)
 * are not here: the journal keeps the trace, and git keeps the rest. The creator who wants them
 * asked adds their own rules to their settings. Best-effort, like every command rule: it names
 * the targets a mistake reaches, not every spelling.
 */
const DESTRUCTIVE_COMMAND: readonly RulePattern[] = [
  ...RECURSIVE_FLAGS.flatMap((flag) =>
    MASS_DELETE_TARGETS.flatMap((target) => shell("rm", `${flag} ${target}`)),
  ),
  ...shell("rm", "*--no-preserve-root*"),
  ...WINDOWS_TARGETS.flatMap((target) => [
    ...["Remove-Item", "remove-item", "ri"].flatMap((command) =>
      shell(command, `*-r* ${target}`, `*-R* ${target}`),
    ),
    ...["rd", "rmdir"].flatMap((command) => shell(command, `/s* ${target}`, `/S* ${target}`)),
  ]),
  ...shell("Format-Volume", "*"),
  ...shell("mkfs", "*"),
  ...shell("dd", "* of=/dev/*"),
  ...shell("dropdb", "*"),
  // Anywhere in a command line (`psql -c "DROP DATABASE …"`): Cursor's syntax matches the command
  // first, so Claude Code only.
  ...DESTRUCTIVE_SQL.map(
    (sql): RulePattern => ({ kind: "shell", command: "*", args: `${sql}*`, claudeOnly: true }),
  ),
];

/** `git` patterns written as given and run from another folder (`git -C dir push …`). */
const gitPush = (...args: string[]): RulePattern[] =>
  args.flatMap((arg) => shell("git", arg, `-C * ${arg}`));

/**
 * `git push` that may reach the main branch: its usual forms (`origin main`, `HEAD:main`,
 * `refs/heads/main`), and those that push the current branch or every branch without naming
 * them (`git push`, `git push origin`, `git push origin HEAD`, `--all`, `--mirror`). Agents push
 * their story branch by name: `git push origin <branch>`.
 */
function pushMain(branches: readonly string[]): RulePattern[] {
  return [
    ...gitPush("push", "push origin", "push origin HEAD*", "push --all*", "push --mirror*"),
    ...gitPush("push * --all*", "push * --mirror*"),
    ...branches.flatMap((branch) =>
      gitPush(
        `push * ${branch}`,
        `push * ${branch} *`,
        `push * *:${branch}`,
        `push * *:${branch} *`,
        `push * refs/heads/${branch}*`,
        `push * *:refs/heads/${branch}*`,
      ),
    ),
  ];
}

const FORCE_PUSH: readonly RulePattern[] = gitPush(
  "push --force*",
  "push -f*",
  "push * --force*",
  "push * -f",
  "push * -f *",
  "push * +*",
);

/**
 * Secrets besides the `.env` files already protected: private keys, and the logins of the
 * usual cloud and package tools.
 */
const READ_SECRETS: readonly RulePattern[] = [
  { kind: "read", path: "~/.ssh/**" },
  { kind: "read", path: "~/.aws/**" },
  { kind: "read", path: "~/.gnupg/**" },
  { kind: "read", path: "~/.kube/config" },
  { kind: "read", path: "~/.docker/config.json" },
  { kind: "read", path: "~/.npmrc" },
  { kind: "read", path: "~/.netrc" },
  { kind: "read", path: "**/*.pem" },
  { kind: "read", path: "**/*.key" },
  { kind: "read", path: "**/id_rsa*" },
  { kind: "read", path: "**/id_ed25519*" },
  { kind: "read", path: "**/*.p12" },
  { kind: "read", path: "**/*.pfx" },
  { kind: "read", path: "**/.npmrc" },
  { kind: "read", path: "**/.netrc" },
  { kind: "read", path: "**/.git-credentials" },
  // The system keychains of the three systems (Windows' credential and vault folders, macOS'
  // keychains, the secret services of Linux), where the machine's and the creator's keys live.
  { kind: "read", path: "~/Library/Keychains/**" },
  { kind: "read", path: "~/.local/share/keyrings/**" },
  { kind: "read", path: "~/.local/share/kwalletd/**" },
  { kind: "read", path: "~/AppData/Roaming/Microsoft/Credentials/**" },
  { kind: "read", path: "~/AppData/Local/Microsoft/Credentials/**" },
  { kind: "read", path: "~/AppData/Roaming/Microsoft/Protect/**" },
  { kind: "read", path: "~/AppData/Roaming/Microsoft/Vault/**" },
  { kind: "read", path: "~/AppData/Local/Microsoft/Vault/**" },
  // The keys of this machine kept in a file where no keychain exists (a server).
  { kind: "read", path: "~/.agentplugged/keys/**" },
];

/**
 * The branches `push_main` guards: `main` and `master`, and the product's own (its
 * main branch, and the branches of its workflow, the integration one and the production one). A
 * `mainBranch` holds several names separated by a line break, which no branch name contains.
 */
export function protectedBranches(mainBranch: string | undefined): string[] {
  const branches = ["main", "master"];
  for (const name of (mainBranch ?? "").split("\n")) {
    if (name !== "" && !branches.includes(name)) branches.push(name);
  }
  return branches;
}

/** What each action covers. `push_main` also names the product's main branch when it is another. */
function patternsOf(action: RuleAction, mainBranch: string | undefined): readonly RulePattern[] {
  switch (action) {
    case "read_files":
      return [{ kind: "read", path: "project" }];
    case "edit_code":
      return [{ kind: "write" }];
    case "run_checks":
      return RUN_CHECKS;
    case "install_dependency":
      return INSTALL_DEPENDENCY;
    case "internet":
      return INTERNET;
    case "destructive_command":
      return DESTRUCTIVE_COMMAND;
    case "push_main":
      return pushMain(protectedBranches(mainBranch));
    case "force_push":
      return FORCE_PUSH;
    case "read_secrets":
      return READ_SECRETS;
  }
}

/** Permission lists of a tool, each without duplicates, in action order. */
export interface RulePermissions {
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
}

function push(list: string[], rules: readonly string[]) {
  for (const rule of rules) if (!list.includes(rule)) list.push(rule);
}

function claudeRules(pattern: RulePattern): string[] {
  switch (pattern.kind) {
    case "read":
      return [`Read(${pattern.path === "project" ? "/**" : pattern.path})`];
    case "write":
      return ["Edit(/**)"];
    case "shell":
      if (pattern.args === "") return [`Bash(${pattern.command})`];
      return [
        pattern.args === "*"
          ? `Bash(${pattern.command}*)`
          : `Bash(${pattern.command === "*" ? "*" : `${pattern.command} `}${pattern.args})`,
      ];
    case "web":
      return ["WebFetch", "WebSearch"];
  }
}

function cursorRules(pattern: RulePattern): string[] {
  switch (pattern.kind) {
    case "read":
      return [`Read(${pattern.path === "project" ? "**" : pattern.path})`];
    case "write":
      return ["Write(**)"];
    case "shell":
      if (pattern.claudeOnly === true) return [];
      return [
        pattern.args === "*" || pattern.args === ""
          ? `Shell(${pattern.command})`
          : `Shell(${pattern.command}:${pattern.args})`,
      ];
    case "web":
      return ["WebFetch(*)"];
  }
}

/** One action's Claude Code rules (`Bash(npm install*)`…), as `claudeRulePermissions` writes them. */
export function claudeActionRules(action: RuleAction, mainBranch?: string): string[] {
  const rules: string[] = [];
  push(rules, patternsOf(action, mainBranch).flatMap(claudeRules));
  return rules;
}

/**
 * The rules as Claude Code's settings hold them. A backslash right before the closing parenthesis
 * escapes it there, so such a rule is written with that one backslash doubled (the others are
 * read literally). Claude Code's `PowerShell` tool has its own rules: each `Bash(x)` rule gets
 * its `PowerShell(x)` twin, or a command would pass by being run through the other shell.
 */
export function claudeCommandRules(rules: readonly string[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    const lone = rule.endsWith("\\)") && !rule.endsWith("\\\\)");
    const escaped = lone ? `${rule.slice(0, -1)}\\)` : rule;
    push(out, [escaped]);
    if (escaped.startsWith("Bash(")) push(out, [`PowerShell${escaped.slice("Bash".length)}`]);
  }
  return out;
}

/** The Claude Code rule that allows all the tools of the `agentplugged` MCP server. */
export const ENGINE_MCP_RULE = "mcp__agentplugged";

/**
 * The reads of the repository that change nothing, allowed by default so that a reviewer can compare
 * two passes of a story without a refusal. Only the plain forms are named: `git -C <folder> …` is
 * not (a rule matches the start of the command, so allowing `git -C` would allow every Git command
 * with it, a push included): an agent works in the project's folder and needs no `-C`.
 */
export const READ_ONLY_GIT_RULES = [
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
] as const;

/**
 * Claude Code (`.claude/settings.json`): each action's patterns in `allow`, `ask` or `deny`.
 * Claude Code evaluates `deny`, then `ask`, then `allow`, whatever the settings file: a creator's
 * own `allow` never lifts an `ask` or a `deny` written here. `engine` is the command the agents run
 * for the engine (`engineCommand`).
 */
export function claudeRulePermissions(
  rules: Readonly<Record<RuleAction, RuleValue>>,
  mainBranch?: string,
  engine?: string,
): RulePermissions {
  const lists: Record<RuleValue, string[]> = { allow: [], ask: [], deny: [] };
  for (const action of RULE_ACTIONS) {
    push(lists[rules[action]], patternsOf(action, mainBranch).flatMap(claudeRules));
  }
  // Every tool of the engine's own MCP server is allowed. They bypass nothing: the engine
  // checks the proof of every answer itself (Claude Code's automatic mode refused `answer_checkpoint`
  // for a merge, as a merge without review, while the engine had checked the creator's answer).
  push(lists.allow, [ENGINE_MCP_RULE, ...claudeCommandRules(READ_ONLY_GIT_RULES)]);
  // The command the agents are given for the engine (`engineCommand`: `npx -y agentplugged@x`, or
  // the creator's local launch, `node <path>/bin.js`) is allowed as it is written in their texts, so
  // that what they are told to run and what their rules allow always agree.
  if (engine !== undefined && engine !== "") {
    push(lists.allow, claudeCommandRules([`Bash(${engine}:*)`]));
  }
  return lists;
}

/** Cursor CLI's lists, and the actions whose `ask` became `deny`. */
export interface CursorRulePermissions extends RulePermissions {
  readonly askedAsDeny: readonly RuleAction[];
}

/** The Cursor CLI rule that allows all the tools of the `agentplugged` MCP server (`Mcp(server:tool)`). */
export const CURSOR_ENGINE_MCP_RULE = "Mcp(agentplugged:*)";

/**
 * CLI Cursor (`.cursor/cli.json`): `allow` and `deny` only, and every tool of the engine's MCP server
 * allowed, so that the CLI asks no approval for them. Cursor CLI has no list that asks:
 * without the project's hooks, an `ask` rule is written as `deny` (and reported); with them (`hooks`),
 * the `beforeShellExecution` hook of the project asks, and nothing is written as `deny` for it.
 */
export function cursorRulePermissions(
  rules: Readonly<Record<RuleAction, RuleValue>>,
  mainBranch?: string,
  hooks = false,
): CursorRulePermissions {
  const allow: string[] = [];
  const deny: string[] = [];
  const askedAsDeny: RuleAction[] = [];
  for (const action of RULE_ACTIONS) {
    const value = rules[action];
    // With the hooks, a shell command that a rule asks for is asked by `beforeShellExecution`; what
    // Cursor's hooks cannot ask (a file write, a read, the web) stays a `deny` of the CLI, said.
    const patterns = patternsOf(action, mainBranch).filter(
      (pattern) => !(value === "ask" && hooks && pattern.kind === "shell"),
    );
    const list = patterns.flatMap(cursorRules);
    if (value === "allow") push(allow, list);
    else push(deny, list);
    if (value === "ask" && list.length > 0) askedAsDeny.push(action);
  }
  push(allow, [CURSOR_ENGINE_MCP_RULE]);
  return { allow, ask: [], deny, askedAsDeny };
}

/** Codex's settings (`.codex/config.toml`) for the rules it can express. */
export interface CodexRuleSettings {
  /** `workspace-write` while agents edit on their own; `read-only` otherwise (Codex asks). */
  readonly sandboxMode: "workspace-write" | "read-only";
  /**
   * `never` (the sandbox is the boundary, nothing is asked: the night has nobody to
   * approve) while agents edit on their own and the validation level is not `strict`; otherwise
   * `on-request`.
   */
  readonly approvalPolicy: "never" | "on-request";
  /** Network inside the `workspace-write` sandbox: only when `internet` is `allow`. */
  readonly networkAccess: boolean;
  /**
   * Folders outside the project that Codex may write in (`writable_roots`), by their
   * absolute path on this machine: the folder of the stories' working copies. Not part of the
   * rules: `sync` adds it when it knows where the project sits.
   */
  readonly writableRoots?: readonly string[];
  /**
   * `live` when `internet` is `allow`; `disabled` otherwise: Codex cannot ask before a web search,
   * so `ask` is written like `deny` (the fallback reason says so).
   */
  readonly webSearch: "live" | "disabled";
}

/**
 * Codex: `sandbox_mode` follows `edit_code`, network access and web search follow `internet`. With
 * `edit_code` allowed and a validation level other than `strict`, the approval policy is `never`:
 * Codex asks nothing and stays inside its sandbox (the project's folder), the refusals being the
 * rules of commands and the hooks (the creator's decision of 2026-10-06). Two rules are
 * reshaped (said in the fallback reason): `internet: ask` disables web search and keeps the sandbox
 * offline, and `edit_code: deny` is a read-only sandbox, `edit_code: ask` too, with approval on
 * request: Codex asks to leave it.
 */
export function codexRuleSettings(
  rules: Readonly<Record<RuleAction, RuleValue>>,
  strict = false,
): CodexRuleSettings {
  const internet = rules.internet;
  const edits = rules.edit_code === "allow";
  return {
    sandboxMode: edits ? "workspace-write" : "read-only",
    approvalPolicy: edits && !strict ? "never" : "on-request",
    networkAccess: internet === "allow" && edits,
    webSearch: internet === "allow" ? "live" : "disabled",
  };
}

/** One shell pattern of an action, in the form the rules above are written in (`command`, `args`). */
export interface ShellRulePattern {
  readonly command: string;
  readonly args: string;
}

/**
 * The shell patterns of one action (a command and its arguments pattern, `*` alone for any
 * arguments), for the tools whose rules are about commands: Codex's `prefix_rule`
 * writes them as far as a prefix of words can say them.
 */
export function shellRulePatterns(action: RuleAction, mainBranch?: string): ShellRulePattern[] {
  const found: ShellRulePattern[] = [];
  for (const pattern of patternsOf(action, mainBranch)) {
    if (pattern.kind === "shell") found.push({ command: pattern.command, args: pattern.args });
  }
  return found;
}
