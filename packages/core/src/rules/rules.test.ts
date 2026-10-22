import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  claudeRulePermissions,
  codexRuleSettings,
  createCommandRegistry,
  cursorRulePermissions,
  DEFAULT_RULES,
  initCommand,
  type MainBranchRead,
  type MainBranchReader,
  type RulesResult,
  resolveProfile,
  resolveRules,
  rulesCommand,
  type SyncResult,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { SYNC_MANIFEST_PATH } from "../sync/manifest.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const CONFIG = ".agentplugged/method.yaml";
const CLAUDE = ".claude/settings.json";
const CURSOR = ".cursor/cli.json";
const CODEX = ".codex/config.toml";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => "1.0.0",
  extensions: async () => [],
};

/** A main branch holding `text` as its `method.yaml` (undefined: the branch has none). */
function mainBranch(text: string | undefined, branch = "main"): MainBranchReader {
  return { read: async () => ({ found: true, branch, text }) };
}

const noMain = (current?: string): MainBranchReader => ({
  read: async (): Promise<MainBranchRead> =>
    current === undefined
      ? { found: false, reason: "no_main_branch" }
      : { found: false, reason: "no_main_branch", current },
});

function context(
  files: MemoryFiles,
  extra: Partial<Pick<CommandContext, "interactive" | "mainBranch">> = {},
): CommandContext {
  return {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    ...extra,
  };
}

/** A new product, the four tools targeted (none detected). */
async function product(): Promise<MemoryFiles> {
  const files = new MemoryFiles();
  const result = await initCommand.run(context(files), { profile: resolveProfile("new-product") });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  return files;
}

async function rules(
  files: MemoryFiles,
  input: Record<string, unknown> = {},
  extra: Partial<Pick<CommandContext, "interactive" | "mainBranch">> = { interactive: true },
) {
  return rulesCommand.run(context(files, extra), input);
}

async function shown(files: MemoryFiles, mainBranchReader?: MainBranchReader) {
  const result = await rules(
    files,
    {},
    mainBranchReader === undefined ? {} : { mainBranch: mainBranchReader },
  );
  if (!result.ok) throw new Error(`rules failed: ${result.error.code}`);
  return result.value;
}

async function sync(files: MemoryFiles, mainBranchReader?: MainBranchReader): Promise<SyncResult> {
  const result = await syncCommand.run(
    context(files, mainBranchReader === undefined ? {} : { mainBranch: mainBranchReader }),
    {},
  );
  if (!result.ok) throw new Error(`sync failed: ${result.error.code}`);
  return result.value;
}

const json = (files: MemoryFiles, path: string) => JSON.parse(files.files.get(path) ?? "null");
const table = (result: RulesResult) =>
  Object.fromEntries(result.rows.map((row) => [row.action, row.rule]));

describe("rules: the table", () => {
  it("shows the defaults of a new product, with their locks", async () => {
    const files = await product();
    const result = await shown(files);
    expect(result.rows.every((row) => row.recorded === row.rule)).toBe(true);
    expect(result.rows.map(({ recorded: _, ...row }) => row)).toEqual([
      { action: "read_files", rule: "allow", default: "allow", lock: "none" },
      { action: "edit_code", rule: "allow", default: "allow", lock: "none" },
      { action: "run_checks", rule: "allow", default: "allow", lock: "none" },
      { action: "install_dependency", rule: "allow", default: "allow", lock: "none" },
      { action: "internet", rule: "allow", default: "allow", lock: "none" },
      { action: "destructive_command", rule: "deny", default: "deny", lock: "never_allow" },
      { action: "push_main", rule: "deny", default: "deny", lock: "locked" },
      { action: "force_push", rule: "deny", default: "deny", lock: "locked" },
      { action: "read_secrets", rule: "deny", default: "deny", lock: "locked" },
    ]);
    expect(result.source).toEqual({ kind: "working_copy" });
    expect(result.warnings).toEqual([]);
    expect(files.files.get(CONFIG)).not.toContain("rules");
  });

  it("is a creator's command, and showing works without a terminal", async () => {
    expect(createCommandRegistry().names()).toContain("rules");
    const files = await product();
    expect((await rules(files, {}, {})).ok).toBe(true);
  });

  it("refuses without method.yaml", async () => {
    const result = await rules(new MemoryFiles());
    expect(!result.ok && result.error.code).toBe(ErrorCode.METHOD_NOT_INSTALLED);
  });
});

describe("rules set and reset", () => {
  it("records a rule keeping comments, and sync then asks before the web in Claude Code", async () => {
    const files = await product();
    files.seed(CONFIG, `# my product\n${files.files.get(CONFIG) ?? ""}`);
    // The web is allowed by default: the creator who wants to be asked says so.
    await sync(files);
    expect(json(files, CLAUDE).permissions.allow).toEqual(
      expect.arrayContaining(["WebFetch", "WebSearch"]),
    );
    expect(files.files.get(CODEX)).toContain('web_search = "live"');
    const result = await rules(files, { action: "set", rule: "internet", value: "ask" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written).toBe(true);
    expect(table(result.value).internet).toBe("ask");
    const text = files.files.get(CONFIG) ?? "";
    expect(text.startsWith("# my product\n")).toBe(true);
    expect(text).toContain("rules:\n  internet: ask\n");

    await sync(files);
    const claude = json(files, CLAUDE).permissions;
    expect(claude.ask).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    expect(claude.allow).not.toContain("WebFetch");
    expect(files.files.get(CODEX)).toContain('web_search = "disabled"');
    expect(files.files.get(CODEX)).not.toContain("network_access");
    expect(json(files, SYNC_MANIFEST_PATH).permission_lists[CLAUDE].ask).toContain("WebFetch");
    const cursor = json(files, CURSOR).permissions;
    expect(cursor.allow).not.toContain("WebFetch(*)");
    expect(cursor.deny).toContain("WebFetch(*)");
    expect(files.files.get("AGENTS.md")).toContain("ask: internet");
    expect(files.reference()).toContain(
      "- `internet` (access the internet (web fetch, web search, `curl`, `wget`)): ask",
    );

    // Back to `allow` (the default: the key goes), the rules move from ask to allow, and nothing
    // of ours is left behind in either tool.
    const back = await rules(files, { action: "set", rule: "internet", value: "allow" });
    expect(back.ok && back.value.written).toBe(true);
    expect(files.files.get(CONFIG)).not.toContain("internet:");
    await sync(files);
    const again = json(files, CLAUDE).permissions;
    expect(again.allow).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    expect(again.ask ?? []).not.toContain("WebFetch");
    expect(files.files.get(CODEX)).toContain('web_search = "live"');
    expect(files.files.get(CODEX)).toContain("[sandbox_workspace_write]\nnetwork_access = true\n");
    expect(json(files, CURSOR).permissions.allow).toContain("WebFetch(*)");
    expect(json(files, SYNC_MANIFEST_PATH).permission_lists[CURSOR].allow).toContain("WebFetch(*)");
    expect(json(files, CURSOR).permissions.deny).not.toContain("WebFetch(*)");
  });

  it("never pins a default, and reset without rules writes nothing", async () => {
    const files = await product();
    const before = files.files.get(CONFIG);
    const same = await rules(files, { action: "set", rule: "internet", value: "allow" });
    expect(same.ok && same.value.written).toBe(false);
    const reset = await rules(files, { action: "reset" });
    expect(reset.ok && reset.value.written).toBe(false);
    expect(files.files.get(CONFIG)).toBe(before);
    const show = await rules(files, { action: "show" }, {});
    expect(show.ok && show.value.action).toBe("show");
  });

  it("says what is recorded here and what is in force from the main branch", async () => {
    const files = await product();
    const main = mainBranch(files.files.get(CONFIG));
    const result = await rules(
      files,
      { action: "set", rule: "internet", value: "deny" },
      { interactive: true, mainBranch: main },
    );
    expect(result.ok && result.value.set).toEqual({
      action: "internet",
      value: "deny",
      inForce: "allow",
    });
    expect(result.ok && result.value.rows.find((row) => row.action === "internet")).toMatchObject({
      rule: "allow",
      recorded: "deny",
    });
  });

  it("says when the rule is already recorded", async () => {
    const files = await product();
    await rules(files, { action: "set", rule: "edit_code", value: "ask" });
    const before = files.files.get(CONFIG);
    const result = await rules(files, { action: "set", rule: "edit_code", value: "ask" });
    expect(result.ok && result.value.written).toBe(false);
    expect(files.files.get(CONFIG)).toBe(before);
  });

  it("is refused outside a terminal, before anything is written", async () => {
    const files = await product();
    const before = files.files.get(CONFIG);
    for (const input of [
      { action: "set", rule: "internet", value: "allow" },
      { action: "reset" },
    ]) {
      const result = await rules(files, input, {});
      expect(!result.ok && result.error.code).toBe(ErrorCode.REVIEW_NOT_INTERACTIVE);
    }
    expect(files.files.get(CONFIG)).toBe(before);
  });

  it.each([
    ["push_main", "allow"],
    ["push_main", "ask"],
    ["force_push", "allow"],
    ["read_secrets", "ask"],
    ["destructive_command", "allow"],
  ])("refuses to loosen %s to %s with RULE_LOCKED, writing nothing", async (rule, value) => {
    const files = await product();
    const before = files.files.get(CONFIG);
    const result = await rules(files, { action: "set", rule, value });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.RULE_LOCKED);
    expect(result.error.details).toMatchObject({ action: rule, value });
    expect(files.files.get(CONFIG)).toBe(before);
  });

  it("denies the mass deletions by default, and accepts ask for them", async () => {
    const files = await product();
    await sync(files);
    expect(json(files, CLAUDE).permissions.deny).toContain("Bash(rm -r* /)");
    const result = await rules(files, {
      action: "set",
      rule: "destructive_command",
      value: "ask",
    });
    expect(result.ok && table(result.value).destructive_command).toBe("ask");
    await sync(files);
    const permissions = json(files, CLAUDE).permissions;
    expect(permissions.ask).toContain("Bash(rm -r* /)");
    expect(permissions.deny).not.toContain("Bash(rm -r* /)");
  });

  it.each([
    [{ action: "set", rule: "teleport", value: "allow" }],
    [{ action: "set", rule: "internet", value: "maybe" }],
    [{ action: "unknown" }],
  ])("refuses invalid arguments %j", async (input) => {
    const files = await product();
    const result = await rules(files, input);
    expect(!result.ok && result.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });

  it("reset goes back to the defaults", async () => {
    const files = await product();
    const before = files.files.get(CONFIG);
    await rules(files, { action: "set", rule: "internet", value: "deny" });
    await rules(files, { action: "set", rule: "run_checks", value: "ask" });
    const result = await rules(files, { action: "reset" });
    expect(result.ok && result.value.written).toBe(true);
    expect(files.files.get(CONFIG)).toBe(before);
    const again = await rules(files, { action: "reset" });
    expect(again.ok && again.value.written).toBe(false);
  });
});

describe("rules: hand edits and the main branch", () => {
  it("ignores a locked rule loosened by hand: deny applies, RULE_LOCKED reported", async () => {
    const files = await product();
    files.seed(CONFIG, `${files.files.get(CONFIG) ?? ""}rules:\n  push_main: allow\n`);
    const result = await shown(files);
    expect(table(result).push_main).toBe("deny");
    expect(result.warnings).toEqual([
      {
        kind: "locked",
        action: "push_main",
        value: "allow",
        applied: "deny",
        where: "working_copy",
      },
    ]);
    const synced = await sync(files);
    expect(synced.rules?.warnings).toEqual(result.warnings);
    const claude = json(files, CLAUDE).permissions;
    expect(claude.deny).toContain("Bash(git push * main)");
    expect(claude.allow).not.toContain("Bash(git push * main)");
  });

  it("applies the main branch's rule when the working branch is looser, and says so", async () => {
    const files = await product();
    const config = files.files.get(CONFIG) ?? "";
    files.seed(CONFIG, `${config}rules:\n  internet: allow\n`);
    const main = mainBranch(`${config}rules:\n  internet: ask\n`);
    const result = await shown(files, main);
    expect(result.source).toEqual({ kind: "main", branch: "main" });
    expect(table(result).internet).toBe("ask");
    expect(result.warnings).toEqual([
      {
        kind: "working_copy_looser",
        action: "internet",
        working: "allow",
        applied: "ask",
        branch: "main",
      },
    ]);
    const synced = await sync(files, main);
    expect(synced.rules?.warnings).toEqual(result.warnings);
    const claude = json(files, CLAUDE).permissions;
    expect(claude.ask).toContain("WebFetch");
    expect(claude.allow).not.toContain("WebFetch");
  });

  it("never reads the working copy while a main branch exists, even stricter", async () => {
    const files = await product();
    files.seed(CONFIG, `${files.files.get(CONFIG) ?? ""}rules:\n  internet: deny\n`);
    const result = await shown(files, mainBranch(undefined, "origin/trunk"));
    expect(table(result).internet).toBe("allow");
    expect(result.warnings).toEqual([
      { kind: "main_rules_missing", branch: "origin/trunk" },
      {
        kind: "working_copy_pending",
        action: "internet",
        working: "deny",
        applied: "allow",
        branch: "origin/trunk",
      },
    ]);
  });

  it("reports a locked rule loosened on the main branch, and unreadable rules there", async () => {
    const files = await product();
    const config = files.files.get(CONFIG) ?? "";
    const loosened = await shown(files, mainBranch(`${config}rules:\n  read_secrets: allow\n`));
    expect(table(loosened).read_secrets).toBe("deny");
    expect(loosened.warnings).toContainEqual({
      kind: "locked",
      action: "read_secrets",
      value: "allow",
      applied: "deny",
      where: "main",
    });
    const invalid = await shown(files, mainBranch("rules: [x\n"));
    expect(invalid.warnings).toEqual([{ kind: "main_rules_invalid", branch: "main" }]);
    expect(table(invalid)).toEqual(DEFAULT_RULES);
  });

  it("uses the current branch when there is no main branch, with a warning", async () => {
    const files = await product();
    files.seed(CONFIG, `${files.files.get(CONFIG) ?? ""}rules:\n  internet: allow\n`);
    const result = await shown(files, noMain("feature/x"));
    expect(table(result).internet).toBe("allow");
    expect(result.warnings).toEqual([{ kind: "no_main_branch", current: "feature/x" }]);
    expect((await shown(files, noMain())).warnings).toEqual([{ kind: "no_main_branch" }]);
  });

  it("reports a local main that differs from the remote one, which is read", async () => {
    const files = await product();
    const reader: MainBranchReader = {
      read: async () => ({
        found: true,
        branch: "origin/main",
        text: files.files.get(CONFIG),
        local: { branch: "main", ahead: 1, behind: 2 },
      }),
    };
    const result = await shown(files, reader);
    expect(result.warnings).toEqual([
      { kind: "local_branch_differs", branch: "origin/main", local: "main", ahead: 1, behind: 2 },
    ]);
  });

  it("falls back on the working copy, said, when Git refuses the folder or fails", async () => {
    const files = await product();
    files.seed(CONFIG, `${files.files.get(CONFIG) ?? ""}rules:\n  internet: allow\n`);
    const refused: MainBranchReader = {
      read: async () => ({
        found: false,
        reason: "no_repository",
        refused: "fatal: detected dubious ownership in repository",
      }),
    };
    const shownRefused = await shown(files, refused);
    expect(table(shownRefused).internet).toBe("allow");
    expect(shownRefused.warnings).toEqual([
      { kind: "repository_refused", reason: "fatal: detected dubious ownership in repository" },
    ]);
    const broken: MainBranchReader = {
      read: async () => {
        throw new Error("git ls-tree: timed out\nmore");
      },
    };
    const synced = await sync(files, broken);
    expect(synced.rules?.source).toEqual({ kind: "working_copy" });
    expect(synced.rules?.warnings).toEqual([
      { kind: "main_unreadable", reason: "git ls-tree: timed out" },
    ]);
    expect(json(files, CLAUDE).permissions.allow).toContain("WebFetch");
  });
});

describe("rules: agents and upgrades", () => {
  it("keeps method.yaml and the files that carry the rules out of agents' reach in every tool it can", async () => {
    const files = await product();
    await sync(files);
    const claude: string[] = json(files, CLAUDE).permissions.deny;
    const cursor: string[] = json(files, CURSOR).permissions.deny;
    expect(claude).toContain("Edit(/.agentplugged/method.yaml)");
    expect(cursor).toContain("Write(.agentplugged/method.yaml)");
    expect(claude).toContain("Edit(/.claude/**)");
    expect(claude).toContain("Edit(/.mcp.json)");
    // The creator's commands (`rules set`, `sync`, `review`…) are no longer listed: a
    // terminal, a key or an answer guards each of them, and the constitution forbids them to agents.
    for (const gone of [
      "npx agentplugged review*",
      "npx agentplugged sync*",
      "agentplugged review*",
      "npx agentplugged rules set*",
    ]) {
      expect(claude).not.toContain(`Bash(${gone})`);
    }
  });

  it("moves an existing product to the new defaults by sync, keeping what the creator chose", async () => {
    const files = await product();
    // The creator chose to be asked before the web: a rule recorded by `rules set`.
    await rules(files, { action: "set", rule: "internet", value: "ask" });
    await sync(files);
    // What the 3.26 sync had written: asks it no longer produces, recorded as its own, and the creator's own rules.
    const settings = json(files, CLAUDE);
    settings.permissions.ask.push("Bash(git clean*)", "Bash(rm -r*)", "Bash(my-tool*)");
    settings.permissions.deny.push("Bash(npx agentplugged review*)", "Bash(my-deny*)");
    files.seed(CLAUDE, JSON.stringify(settings));
    const manifest = json(files, SYNC_MANIFEST_PATH);
    manifest.permissions = [...manifest.permissions, "Bash(npx agentplugged review*)"];
    manifest.permission_lists[CLAUDE].ask = [
      ...manifest.permission_lists[CLAUDE].ask,
      "Bash(git clean*)",
      "Bash(rm -r*)",
    ];
    files.seed(SYNC_MANIFEST_PATH, JSON.stringify(manifest));
    await sync(files);
    const after = json(files, CLAUDE).permissions;
    // What sync wrote and no longer produces is gone.
    expect(after.ask).not.toContain("Bash(git clean*)");
    expect(after.ask).not.toContain("Bash(rm -r*)");
    expect(after.deny).not.toContain("Bash(npx agentplugged review*)");
    // What the creator wrote, and the rule they chose with `rules set`, stays.
    expect(after.ask).toContain("Bash(my-tool*)");
    expect(after.deny).toContain("Bash(my-deny*)");
    expect(after.ask).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
  });

  it("says once that allow rules were added, and reports the creator's stricter rules", async () => {
    // An older product: settings without allow nor ask, a creator's own ask for edits.
    const files = await product();
    files.seed(CLAUDE, JSON.stringify({ permissions: { ask: ["Edit(/**)"], deny: [] } }));
    const first = await sync(files);
    expect(first.rules?.allowAdded.map((entry) => entry.path)).toEqual([CLAUDE, CURSOR]);
    expect(first.rules?.allowAdded[0]?.count).toBeGreaterThan(0);
    expect(first.rules?.conflicts).toEqual([{ path: CLAUDE, rule: "Edit(/**)", list: "ask" }]);
    const settings = json(files, CLAUDE).permissions;
    expect(settings.ask).toContain("Edit(/**)");
    expect(settings.allow).toContain("Edit(/**)");
    const second = await sync(files);
    expect(second.rules?.allowAdded).toEqual([]);
    expect(second.rules?.conflicts).toHaveLength(1);
  });
});

describe("rules in each tool's permissions", () => {
  const defaults = DEFAULT_RULES;

  it("Claude Code: allows by default the Git reads that change nothing, in both shells, and not `git -C`", () => {
    const { allow, deny } = claudeRulePermissions(defaults);
    for (const read of ["diff", "log", "show", "status"]) {
      expect(allow).toContain(`Bash(git ${read}:*)`);
      expect(allow).toContain(`PowerShell(git ${read}:*)`);
    }
    // A prefix rule starting `git -C` would allow every Git command given a folder, a push included.
    expect(allow.some((rule) => rule.includes("git -C"))).toBe(false);
    expect(deny.some((rule) => rule.includes("git diff"))).toBe(false);
  });

  it("Claude Code: allow, ask and deny by action, the locked ones always denied", () => {
    const lists = claudeRulePermissions(defaults);
    expect(lists.allow).toEqual(
      expect.arrayContaining([
        "Read(/**)",
        "Edit(/**)",
        "Bash(npm test*)",
        "Bash(pnpm test*)",
        "WebFetch",
        "WebSearch",
        "Bash(curl*)",
        "Bash(npm install*)",
        "Bash(npx*)",
      ]),
    );
    // Nothing asks by default: the creator adds what they want asked.
    expect(lists.ask).toEqual([]);
    expect(lists.deny).toEqual(
      expect.arrayContaining([
        "Bash(git push)",
        "Bash(git push origin)",
        "Bash(git push origin HEAD*)",
        "Bash(git push --all*)",
        "Bash(git push --mirror*)",
        "Bash(git push * main)",
        "Bash(git push * *:main)",
        "Bash(git push * master *)",
        "Bash(git push --force*)",
        "Bash(git push * -f)",
        "Read(**/*.pem)",
        "Read(~/.ssh/**)",
        "Bash(rm -r* /)",
        "Bash(rm -r* ~)",
        "Bash(rm -r* ..)",
        "Bash(rm -fr* /)",
        "Bash(git -C * push --force*)",
        "Bash(*DROP DATABASE*)",
        "Bash(dropdb*)",
      ]),
    );
    // What stays inside the repository is the work: no rule names it.
    for (const list of [lists.allow, lists.ask, lists.deny]) {
      expect(list).not.toContain("Bash(rm -r*)");
      expect(list).not.toContain("Bash(git clean*)");
      expect(list).not.toContain("Bash(git reset --hard*)");
      expect(list.some((rule) => rule.includes("DROP TABLE"))).toBe(false);
    }
    for (const list of [lists.allow, lists.ask, lists.deny]) {
      expect(new Set(list).size).toBe(list.length);
    }
    // What the creator chooses to be asked about is asked, the package runners included.
    const asking = claudeRulePermissions({
      ...defaults,
      install_dependency: "ask",
      internet: "ask",
    });
    expect(asking.ask).toEqual(
      expect.arrayContaining([
        "Bash(npm install*)",
        "Bash(pnpm add*)",
        "WebFetch",
        "WebSearch",
        "Bash(npm ci*)",
        "Bash(npm i)",
        "Bash(npm i *)",
        "Bash(pnpm i*)",
        "Bash(yarn)",
        "Bash(yarn add*)",
        "Bash(bun i*)",
        "Bash(bun add*)",
        "Bash(npx*)",
        "Bash(pnpm dlx *)",
        "Bash(bunx*)",
      ]),
    );
    expect(asking.allow.some((rule) => rule.startsWith("Bash(npx"))).toBe(false);
    // The product's own main branch is named too.
    expect(claudeRulePermissions(defaults, "trunk").deny).toContain("Bash(git push * trunk)");
  });

  it("Cursor CLI: allow and deny only, an ask written as deny and reported", () => {
    const lists = cursorRulePermissions(defaults);
    expect(lists.ask).toEqual([]);
    expect(lists.allow).toEqual(
      expect.arrayContaining(["Read(**)", "Write(**)", "Shell(npm:test*)", "WebFetch(*)"]),
    );
    expect(lists.deny).toEqual(
      expect.arrayContaining([
        "Shell(git:push * main)",
        "Shell(git:push)",
        "Shell(git:push origin)",
        "Shell(rm:-r* /)",
      ]),
    );
    expect(lists.askedAsDeny).toEqual([]);
    // What the creator asks for is written as deny: Cursor CLI has no list that asks.
    const asking = cursorRulePermissions({
      ...defaults,
      install_dependency: "ask",
      internet: "ask",
    });
    expect(asking.deny).toEqual(expect.arrayContaining(["WebFetch(*)", "Shell(npm:install*)"]));
    // Package runners, a bare `yarn` and SQL are Claude Code's only (see the Cursor fallback).
    expect(asking.deny).not.toContain("Shell(npx)");
    expect(asking.deny).not.toContain("Shell(yarn)");
    expect(asking.askedAsDeny).toEqual(["install_dependency", "internet"]);
  });

  it("Codex: the sandbox follows edit_code, the network and web search follow internet", () => {
    // The web is allowed by default.
    expect(codexRuleSettings(defaults)).toEqual({
      sandboxMode: "workspace-write",
      // Nothing is asked while agents edit on their own; the sandbox is the boundary.
      approvalPolicy: "never",
      networkAccess: true,
      webSearch: "live",
    });
    // At the strict level, Codex keeps asking.
    expect(codexRuleSettings(defaults, true).approvalPolicy).toBe("on-request");
    // `internet: ask` disables web search: Codex cannot ask before one.
    expect(codexRuleSettings({ ...defaults, internet: "ask" })).toEqual({
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccess: false,
      webSearch: "disabled",
    });
    expect(codexRuleSettings({ ...defaults, edit_code: "ask", internet: "deny" })).toEqual({
      sandboxMode: "read-only",
      approvalPolicy: "on-request",
      networkAccess: false,
      webSearch: "disabled",
    });
  });

  it("sync writes Codex in read-only when edits ask first, and reports Cursor's asks", async () => {
    const files = await product();
    await rules(files, { action: "set", rule: "edit_code", value: "ask" });
    const result = await sync(files);
    expect(files.files.get(CODEX)).toContain(
      'sandbox_mode = "read-only"\napproval_policy = "on-request"\n',
    );
    expect(result.rules?.cursorAskedAsDeny).toEqual(["edit_code"]);
    expect(json(files, CURSOR).permissions.deny).toContain("Write(**)");
    expect(json(files, CLAUDE).permissions.ask).toContain("Edit(/**)");
  });

  it("lists the rules in force in the constitution, init and sync alike", async () => {
    const files = await product();
    const constitution = files.files.get("AGENTS.md") ?? "";
    expect(constitution).toContain("\n## Permission rules\n");
    expect(constitution).toContain(
      "deny: destructive_command, push_main, force_push, read_secrets",
    );
    expect(files.reference()).toContain(
      "- `push_main` (push to the main branch): deny (never do it)",
    );
    const result = await sync(files);
    expect(result.entries.find((entry) => entry.path === "AGENTS.md")?.action).toBe("unchanged");
  });

  it("resolves without a reader from the working copy, locks applied", async () => {
    const resolved = await resolveRules(
      { format_version: 2, engine_version: "1.0.0", rules: { destructive_command: "allow" } },
      undefined,
    );
    expect(resolved.rules.destructive_command).toBe("ask");
    expect(resolved.source).toEqual({ kind: "working_copy" });
  });
});
