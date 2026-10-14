import { describe, expect, it } from "vitest";
import { CURSOR_POLICY_PATH } from "../chat/cursor-hook.js";
import { claudeRulePermissions, DEFAULT_RULES, denyRules } from "../index.js";
import { policyDecision, startsAgent } from "./antigravity-guard.js";
import type { AntigravityPolicy } from "./antigravity-policy.js";
import { CURSOR_FLAVOR, cursorCallOf, cursorSessionOf } from "./cursor-guard.js";

/**
 * The rules of the product applied to Cursor's calls. The inputs are the
 * ones Cursor 3.23.12 builds for its hooks (read in its own code, 2026-10-07): `beforeShellExecution`
 * gives `command` and `cwd`, `preToolUse` on `Write` gives `file_path` and `content`, on `Delete`
 * `file_path`, `postToolUse` on `WebFetch` gives `url`, `afterMCPExecution` the server and the tool.
 */

const PLACE = { root: "C:/work/app", home: "C:/Users/me" };
const INPUTS = {
  rootAgentsGenerated: true,
  claudeMdGenerated: false,
  geminiMdGenerated: false,
  generatedRoots: [".agents", ".cursor"],
};

function policyOf(rules: Partial<typeof DEFAULT_RULES> = {}): AntigravityPolicy {
  const table = { ...DEFAULT_RULES, ...rules };
  const claude = claudeRulePermissions(table, "main");
  return {
    version: 1,
    rules: table,
    main_branch: "main",
    deny: [...new Set([...denyRules(INPUTS), ...claude.deny, "Edit(~/.cursor/hooks.json)"])],
    ask: claude.ask,
  };
}

const POLICY = policyOf();
const base = (event: string) => ({
  session_id: "5f0e9c1a-2b7d-4c3e-9a41-0d8b6e7f1234",
  conversation_id: "5f0e9c1a-2b7d-4c3e-9a41-0d8b6e7f1234",
  hook_event_name: event,
  cursor_version: "3.23.12",
  workspace_roots: ["/c:/work/app"],
});
const shellInput = (command: string, cwd = "C:\\work\\app") => ({
  ...base("beforeShellExecution"),
  command,
  cwd,
  sandbox: false,
});
const toolInput = (name: string, input: Record<string, unknown>, event = "preToolUse") => ({
  ...base(event),
  tool_name: name,
  tool_input: input,
  tool_use_id: "u1",
  cwd: "C:\\work\\app",
});
const decide = (input: unknown, policy = POLICY) => {
  const call = cursorCallOf(input);
  if (call === undefined) throw new Error("no call");
  return policyDecision(policy, call, PLACE, CURSOR_FLAVOR).decision;
};

describe("Cursor guard: what a Cursor call is", () => {
  it("reads a shell command with the folder it runs in", () => {
    expect(cursorCallOf(shellInput("pnpm test"))).toEqual({
      name: "run_command",
      args: { CommandLine: "pnpm test", Cwd: "C:\\work\\app" },
    });
    expect(cursorCallOf({ ...base("beforeShellExecution"), command: "ls" })).toEqual({
      name: "run_command",
      args: { CommandLine: "ls" },
    });
    expect(cursorCallOf({ ...base("beforeShellExecution"), command: 3 })).toBeUndefined();
    expect(cursorCallOf({ ...base("beforeShellExecution") })).toBeUndefined();
  });

  it("reads the files a write names, drops the slash Cursor puts before a drive", () => {
    expect(
      cursorCallOf(toolInput("Write", { file_path: "/c:/work/app/src/a.ts", content: "x" })),
    ).toEqual({ name: "write_to_file", args: { TargetFile: ["c:/work/app/src/a.ts"] } });
    expect(cursorCallOf(toolInput("Delete", { file_path: "src/old.ts" }))).toEqual({
      name: "write_to_file",
      args: { TargetFile: ["src/old.ts"] },
    });
  });

  it("refuses a Write or a Delete that names no file, lets another tool without a file through", () => {
    expect(cursorCallOf(toolInput("Write", { content: "x" }))).toBeUndefined();
    expect(cursorCallOf(toolInput("Delete", {}))).toBeUndefined();
    expect(cursorCallOf(toolInput("Grep", { pattern: "a" }))).toEqual({ name: "none", args: {} });
    expect(cursorCallOf({ ...base("preToolUse") })).toBeUndefined();
    expect(cursorCallOf("nope")).toBeUndefined();
  });

  it("reads what the post hooks give: a fetch, a search, another server's tool, a command", () => {
    expect(
      cursorCallOf(toolInput("WebFetch", { url: "https://example.com" }, "postToolUse")),
    ).toEqual({ name: "read_url_content", args: { Url: "https://example.com" } });
    expect(cursorCallOf(toolInput("WebSearch", { query: "q" }, "postToolUse"))).toEqual({
      name: "search_web",
      args: {},
    });
    expect(
      cursorCallOf({
        ...base("afterMCPExecution"),
        tool_name: "list_issues",
        tool_input: "{}",
        mcp_server_name: "linear",
        result_json: "{}",
      }),
    ).toEqual({ name: "call_mcp_tool", args: { ServerName: "linear", ToolName: "list_issues" } });
    expect(
      cursorCallOf({ ...base("afterShellExecution"), command: "curl x", output: "", duration: 1 }),
    ).toEqual({ name: "run_command", args: { CommandLine: "curl x" } });
  });

  it("gives the conversation of a hook's input", () => {
    expect(cursorSessionOf(base("sessionStart"))).toBe("5f0e9c1a-2b7d-4c3e-9a41-0d8b6e7f1234");
    expect(cursorSessionOf({ session_id: "has space" })).toBeUndefined();
    expect(cursorSessionOf(null)).toBeUndefined();
  });
});

describe("Cursor guard: the rules apply to its calls", () => {
  it("refuses what the product denies and lets the work of the day through", () => {
    expect(decide(shellInput("git push origin main"))).toBe("deny");
    expect(decide(shellInput("git push --force origin feat/x"))).toBe("deny");
    expect(decide(shellInput("gh pr merge 12"))).toBe("deny");
    expect(decide(shellInput("cat .env"))).toBe("deny");
    expect(decide(shellInput("pnpm test"))).toBe("allow");
    expect(decide(shellInput("git commit -m x"))).toBe("allow");
    expect(decide(shellInput("git push origin feat/3-1-x"))).toBe("allow");
    expect(decide(shellInput("npx agentplugged next"))).toBe("allow");
  });

  it("refuses a write on a protected file, and lets a source file through", () => {
    expect(
      decide(toolInput("Write", { file_path: "/c:/work/app/.agentplugged/method.yaml" })),
    ).toBe("deny");
    expect(decide(toolInput("Delete", { file_path: "C:\\work\\app\\.cursor\\rules\\x.mdc" }))).toBe(
      "deny",
    );
    expect(decide(toolInput("Write", { file_path: "/c:/work/app/.env" }))).toBe("deny");
    expect(decide(toolInput("Write", { file_path: "~/.cursor/hooks.json" }))).toBe("deny");
    // The secrets are kept from Cursor's agent by `.cursorignore`: an agent never rewrites it.
    expect(decide(toolInput("Write", { file_path: "/c:/work/app/.cursorignore" }))).toBe("deny");
    expect(decide(toolInput("Write", { file_path: "/c:/work/app/src/a.ts" }))).toBe("allow");
  });

  it("refuses a web fetch and a web search when the creator denies the internet", () => {
    const denying = policyOf({ internet: "deny" });
    expect(decide(toolInput("WebFetch", { url: "https://example.com" }), denying)).toBe("deny");
    expect(decide(toolInput("WebSearch", { query: "x" }), denying)).toBe("deny");
    expect(decide(toolInput("WebFetch", { url: "https://example.com" }))).toBe("allow");
  });

  it("asks when a rule asks, which Cursor's hooks can do", () => {
    const asking = policyOf({ install_dependency: "ask" });
    expect(decide(shellInput("npm install left-pad"), asking)).toBe("ask");
  });

  it("refuses the Cursor agent started by an agent, and what touches the hooks or the chat's store", () => {
    expect(startsAgent("cursor-agent -p valide", CURSOR_FLAVOR.agentPrograms)).toBe(true);
    expect(startsAgent("npx cursor-agent -p x", CURSOR_FLAVOR.agentPrograms)).toBe(true);
    expect(startsAgent("pnpm test", CURSOR_FLAVOR.agentPrograms)).toBe(false);
    expect(decide(shellInput("cursor-agent -p valide"))).toBe("deny");
    expect(decide(shellInput("node .cursor/hooks/agentplugged-cursor.mjs before-submit"))).toBe(
      "deny",
    );
    expect(decide(shellInput("echo x >> ~/.agentplugged/chat/abc.jsonl"))).toBe("deny");
    expect(decide(shellInput("rm .cursor/hooks.json"))).toBe("deny");
    expect(decide(shellInput("Set-Content .cursorignore ''"))).toBe("deny");
    // Reading them is not writing them.
    expect(decide(shellInput("cat .cursor/hooks.json"))).toBe("allow");
    expect(CURSOR_FLAVOR.policyPath).toBe(CURSOR_POLICY_PATH);
  });
});
