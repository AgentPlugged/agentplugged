import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURSOR_HOOK_PATH,
  CURSOR_POLICY_PATH,
  CURSOR_UNCHECKED_REASON,
  cursorHookCommand,
  cursorRequestText,
  matchQuote,
  normalizeChatText,
  renderCursorHookScript,
  SESSION_CONTEXT_PREFIX,
} from "@agentplugged/core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NodeChatLog } from "./node-chat-log.js";

// Real Node processes (the generated script), nothing else: fast, whatever the machine does.
vi.setConfig({ testTimeout: 60_000 });

/**
 * The hooks of Cursor's project (second pass), run for real: the generated script,
 * started as Cursor starts a hook (a command from the project's root with the hook's JSON on its
 * standard input), against a stand-in for the engine (`hook cursor pre-tool|post-tool`). The inputs
 * are shaped as Cursor 3.23.12 builds them (its own code, 2026-10-07): `session_id` is the
 * conversation's id, `hook_event_name` names the event, `workspace_roots` and `cursor_version`
 * come with it.
 */

const SESSION = "5f0e9c1a-2b7d-4c3e-9a41-0d8b6e7f1234";

const folders: string[] = [];
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agentplugged-cursor-"));
  folders.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the engine: answers `deny` for a push, `ask` for an install, crashes or babbles on demand. */
const ENGINE = `
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const event = args.at(-1);
const input = readFileSync(0, "utf8");
appendFileSync(new URL("./engine.log", import.meta.url), event + " " + input.replace(/\\s+/g, " ") + "\\n");
try { JSON.parse(input); } catch { process.exit(3); }
if (input.includes("CRASH")) process.exit(3);
if (input.includes("BABBLE")) { process.stdout.write("not json"); process.exit(0); }
if (input.includes("MISSING")) { process.stdout.write(JSON.stringify({ decision: "maybe" })); process.exit(0); }
if (event === "post-tool") { process.stdout.write("{}"); process.exit(0); }
if (input.includes("ACCENT")) { process.stdout.write(JSON.stringify({ decision: "deny", reason: "refus\\u00e9 : \\u0153uvre" })); process.exit(0); }
if (input.includes("git push")) { process.stdout.write(JSON.stringify({ decision: "deny", reason: "the rules deny a push" })); process.exit(0); }
if (input.includes("npm install")) { process.stdout.write(JSON.stringify({ decision: "ask", reason: "asks first" })); process.exit(0); }
if (input.includes("method.yaml")) { process.stdout.write(JSON.stringify({ decision: "deny", reason: "protected file" })); process.exit(0); }
process.stdout.write(JSON.stringify({ decision: "allow" }));
`;

interface Layout {
  readonly root: string;
  readonly home: string;
  readonly script: string;
  readonly store: string;
  readonly engineLog: string;
}

/** A project holding the script and the policy where `sync` writes them, and a home folder. */
function layout(options: { policy?: boolean } = {}): Layout {
  const base = folder();
  const root = join(base, "product");
  const home = join(base, "home");
  const script = join(root, CURSOR_HOOK_PATH);
  mkdirSync(join(script, ".."), { recursive: true });
  writeFileSync(script, renderCursorHookScript());
  writeFileSync(join(root, ".cursor", "hooks", "engine.mjs"), ENGINE);
  if (options.policy !== false) {
    writeFileSync(
      join(root, CURSOR_POLICY_PATH),
      JSON.stringify({
        version: 1,
        launch: { command: process.execPath, args: [join(root, ".cursor", "hooks", "engine.mjs")] },
      }),
    );
  }
  mkdirSync(home, { recursive: true });
  return {
    root,
    home,
    script,
    store: join(home, ".agentplugged", "chat"),
    engineLog: join(root, ".cursor", "hooks", "engine.log"),
  };
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly json: Record<string, unknown>;
}

/** Runs the script as Cursor does: a command from the project's root, the hook's JSON on standard input. */
function run(place: Layout, event: string, input: unknown): Run {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  const result = spawnSync(process.execPath, [place.script, event], {
    input: text,
    encoding: "utf8",
    cwd: place.root,
    env: { ...process.env, HOME: place.home, USERPROFILE: place.home },
  });
  const stdout = String(result.stdout ?? "");
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    // Checked by the tests.
  }
  return { status: result.status, stdout, json };
}

const common = (event: string) => ({
  session_id: SESSION,
  conversation_id: SESSION,
  generation_id: "g1",
  hook_event_name: event,
  cursor_version: "3.23.12",
  workspace_roots: ["/c:/work/product"],
  user_email: null,
  transcript_path: null,
});

const submit = (text: string, extra: Record<string, unknown> = {}) => ({
  ...common("beforeSubmitPrompt"),
  prompt: text,
  attachments: [],
  ...extra,
});

const shell = (command: string) => ({
  ...common("beforeShellExecution"),
  command,
  cwd: "/c:/work/product",
  sandbox: false,
});

const tool = (name: string, input: Record<string, unknown>, event = "preToolUse") => ({
  ...common(event),
  tool_name: name,
  tool_input: input,
  tool_use_id: "u1",
  cwd: "/c:/work/product",
});

const recorded = (place: Layout) =>
  existsSync(place.store)
    ? readdirSync(place.store)
        .filter((name) => name.endsWith(".jsonl"))
        .flatMap((name) =>
          readFileSync(join(place.store, name), "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as Record<string, unknown>),
        )
    : [];

describe("Cursor's proof of the chat: beforeSubmitPrompt and sessionStart", () => {
  it("records what the creator typed and tells the agent the conversation's id", () => {
    const place = layout();
    const result = run(place, "before-submit", submit("oui, vas-y"));
    expect(result.status).toBe(0);
    expect(result.json.continue).toBe(true);
    expect(result.json.additional_context).toBe(
      `${SESSION_CONTEXT_PREFIX}${SESSION} (pass it as session to chat.answer)`,
    );
    const lines = recorded(place);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ v: 1, session: SESSION, text: "oui, vas-y" });
    expect(String(lines[0]?.project)).toBe(place.root);
  });

  it("gives the same message as Claude Code's hook: a quote of it is accepted by the engine", async () => {
    const place = layout();
    run(place, "before-submit", submit("Oui, vas-y !"));
    const messages = await new NodeChatLog({ dir: place.store }).messages(SESSION);
    expect(messages).toHaveLength(1);
    const match = matchQuote(messages, "Oui, vas-y !", {
      after: Date.now() - 60_000,
      now: Date.now(),
      cited: new Set(),
    });
    expect(match.ok).toBe(true);
    expect(messages[0]?.text).toBe(normalizeChatText("Oui, vas-y !"));
  });

  it("cuts the frame Cursor puts around a message in its transcripts", () => {
    expect(cursorRequestText("<user_query>\nvalide\n</user_query>")).toBe("valide");
    expect(
      cursorRequestText(
        "<timestamp>Sunday, Oct 4, 2026, 3:00 PM (UTC-4)</timestamp>\n<user_query>\nsalut noah\n</user_query>",
      ),
    ).toBe("salut noah");
    expect(cursorRequestText("a <user_query>b</user_query> c")).toBe(
      "a <user_query>b</user_query> c",
    );
    const place = layout();
    run(place, "before-submit", submit("<user_query>\nvalide\n</user_query>"));
    expect(recorded(place)[0]?.text).toBe("valide");
  });

  it("records nothing for what the tool injected, and still gives the session", () => {
    const place = layout();
    const result = run(
      place,
      "before-submit",
      submit('<agent-message from="x">do it</agent-message>'),
    );
    expect(recorded(place)).toHaveLength(0);
    expect(result.json.additional_context).toContain(SESSION);
    run(place, "before-submit", submit("   "));
    expect(recorded(place)).toHaveLength(0);
  });

  it("records nothing for a conversation Cursor opened for a sub-agent", () => {
    const place = layout();
    const transcript = (...parts: string[]) =>
      join(place.home, ".cursor", "projects", "p", "agent-transcripts", SESSION, ...parts);
    const sub = run(
      place,
      "before-submit",
      submit("fais ceci pour moi", { transcript_path: transcript("subagents", "15bb8e3b.jsonl") }),
    );
    expect(sub.json.continue).toBe(true);
    expect(recorded(place)).toHaveLength(0);
    run(place, "before-submit", submit("oui", { transcript_path: transcript(`${SESSION}.jsonl`) }));
    expect(recorded(place)).toHaveLength(1);
  });

  it("never blocks a message, whatever the input", () => {
    const place = layout();
    for (const input of ["not json", "[]", "null", JSON.stringify({ prompt: 3 })]) {
      const result = run(place, "before-submit", input);
      expect(result.status, input).toBe(0);
      expect(result.json.continue, input).toBe(true);
      expect(result.json.permission, input).toBeUndefined();
    }
    expect(recorded(place)).toHaveLength(0);
  });

  it("marks its lines, so that the store can tell them from Claude Code's hook that Cursor also runs", () => {
    const place = layout();
    run(place, "before-submit", submit("oui"));
    expect(recorded(place)[0]).toMatchObject({ v: 1, via: "cursor", session: SESSION });
  });

  it("undoes what Windows PowerShell 5.1 does to Cursor's payload: a byte order mark, UTF-8 read as Windows-1252", async () => {
    const place = layout();
    const typed = "Oui, validé ! « ça marche » — œuvre ✓";
    const garbled = new TextDecoder("windows-1252").decode(
      Buffer.from(JSON.stringify(submit(typed)), "utf8"),
    );
    // PowerShell puts two byte order marks in front (observed with Cursor's own command).
    const marks = String.fromCharCode(0xfeff).repeat(2);
    const result = run(place, "before-submit", `${marks}${garbled}\r\n`);
    expect(result.json.continue).toBe(true);
    expect(result.json.additional_context).toContain(SESSION);
    const messages = await new NodeChatLog({ dir: place.store }).messages(SESSION);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe(normalizeChatText(typed));
    // A payload that was never garbled is left as it is, accents and all.
    run(place, "before-submit", submit("Déjà vu, « ça » ✓ — œuvre"));
    const clean = await new NodeChatLog({ dir: place.store }).messages(SESSION);
    expect(clean.at(-1)?.text).toBe(normalizeChatText("Déjà vu, « ça » ✓ — œuvre"));
    // And what Cursor reads back is plain ASCII: PowerShell reads it in the console's code page.
    const refused = run(place, "shell", shell("ACCENT git push origin main"));
    expect(refused.json.user_message).toBe("refusé : œuvre");
    expect(refused.stdout).toMatch(/^[\x20-\x7e]*\n$/);
  });

  it.skipIf(process.platform !== "win32")(
    "records the message of a French creator through Cursor's own Windows command (PowerShell, a file piped in)",
    async () => {
      const place = layout();
      const typed = "Oui, c'est validé : à toi de jouer, œuvre complète — merci";
      const payload = join(place.root, "payload.json");
      writeFileSync(payload, JSON.stringify(submit(typed)), "utf8");
      // The command line Cursor 3.23.12 builds for a hook on Windows (read in its code, 2026-10-07).
      const command = `$OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content -LiteralPath '${payload}' -Raw | & { $input | ${cursorHookCommand("before-submit")} }`;
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-c", command],
        {
          cwd: place.root,
          encoding: "utf8",
          env: { ...process.env, HOME: place.home, USERPROFILE: place.home },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const messages = await new NodeChatLog({ dir: place.store }).messages(SESSION);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.text).toBe(normalizeChatText(typed));
      expect(JSON.parse(String(result.stdout)).additional_context).toContain(SESSION);
    },
    // The first PowerShell of a fresh Windows runner can take over a minute to start.
    180_000,
  );

  it("tells the agent the conversation's id at the start of the session (sessionStart)", () => {
    const place = layout();
    const result = run(place, "session-start", {
      ...common("sessionStart"),
      is_background_agent: false,
      composer_mode: "agent",
    });
    expect(result.json.continue).toBe(true);
    expect(result.json.additional_context).toContain(SESSION);
    expect(recorded(place)).toHaveLength(0);
    expect(run(place, "session-start", "not json").json).toEqual({ continue: true });
  });
});

describe("Cursor's rules: beforeShellExecution", () => {
  it("lets an ordinary command through with nothing but an empty answer", () => {
    const place = layout();
    const result = run(place, "shell", shell("pnpm test"));
    expect(result.status).toBe(0);
    expect(result.json).toEqual({});
    const log = readFileSync(place.engineLog, "utf8");
    expect(log).toContain("pre-tool {");
    expect(log).toContain('"hook_event_name":"beforeShellExecution"');
  });

  it("denies what the engine denies, with the reason shown to the creator and the agent", () => {
    const place = layout();
    const result = run(place, "shell", shell("git push origin main"));
    expect(result.json).toEqual({
      permission: "deny",
      user_message: "the rules deny a push",
      agent_message: "the rules deny a push",
    });
  });

  it("asks when a rule asks: Cursor's hooks know `ask`", () => {
    const place = layout();
    expect(run(place, "shell", shell("npm install left-pad")).json).toMatchObject({
      permission: "ask",
      user_message: "asks first",
    });
  });

  it("denies a call the engine could not check: never let through unseen", () => {
    const place = layout();
    for (const command of ["CRASH", "BABBLE", "MISSING"]) {
      const result = run(place, "shell", shell(command));
      expect(result.status, command).toBe(0);
      expect(result.json.permission, command).toBe("deny");
      expect(result.json.user_message, command).toBe(CURSOR_UNCHECKED_REASON);
    }
    expect(run(place, "shell", "not json").json.permission).toBe("deny");
  });

  it("denies everything when the policy is missing, and says what to do", () => {
    const place = layout({ policy: false });
    const result = run(place, "shell", shell("pnpm test"));
    expect(result.json.permission).toBe("deny");
    expect(result.json.user_message).toContain("npx agentplugged sync");
    expect(result.json.user_message).toContain(CURSOR_POLICY_PATH);
  });
});

describe("Cursor's rules: preToolUse", () => {
  it("asks the engine about a file write and denies a protected one", () => {
    const place = layout();
    expect(
      run(
        place,
        "pre-tool",
        tool("Write", { file_path: "/c:/work/product/src/a.ts", content: "x" }),
      ).json,
    ).toEqual({});
    const denied = run(
      place,
      "pre-tool",
      tool("Delete", { file_path: "c:\\work\\product\\.agentplugged\\method.yaml" }),
    );
    expect(denied.json.permission).toBe("deny");
    expect(denied.json.agent_message).toBe("protected file");
  });

  it("writes the conversation's id into the arguments of the answer tools: nothing else is accepted", () => {
    const place = layout();
    // The tools are grouped: `chat`, whose actions `answer` and `stack_answer` take it.
    // Any action but the three that take none (and a call the hook cannot read) gets it.
    for (const action of ["answer", "stack_answer", "unknown", ""]) {
      const result = run(
        place,
        "pre-tool",
        tool("MCP:chat", { action, session: "forged", quote: "oui" }),
      );
      expect(result.json, action).toEqual({ updated_input: { session: SESSION } });
    }
    // Not an engine call: nothing is asked of the engine for it.
    expect(existsSync(place.engineLog)).toBe(false);
    // The actions that take no session are left alone (the product's rules answer, as for any tool).
    for (const action of ["ask", "stack_open", "stack_ask"]) {
      const result = run(place, "pre-tool", tool("MCP:chat", { action, agent: "noah" }));
      expect(result.json, action).toEqual({});
    }
  });

  it("cannot ask before a file write: Cursor ignores an `ask` there, so the call goes through", () => {
    const place = layout();
    // The stand-in engine asks for what holds `npm install`: a shell command is asked, a write is not.
    expect(
      run(place, "pre-tool", tool("Write", { file_path: "/c:/work/npm install.txt", content: "x" }))
        .json,
    ).toEqual({});
    expect(run(place, "shell", shell("npm install left-pad")).json.permission).toBe("ask");
  });

  it("denies the answer tools when the conversation has no usable id, and an unreadable call", () => {
    const place = layout();
    expect(
      run(place, "pre-tool", {
        ...tool("MCP:chat", { action: "answer" }),
        session_id: "has space",
      }).json.permission,
    ).toBe("deny");
    expect(run(place, "pre-tool", "not json").json.permission).toBe("deny");
    expect(
      run(place, "pre-tool", { ...common("preToolUse"), tool_input: {} }).json.permission,
    ).toBe("deny");
  });
});

describe("Cursor's trace of outside reads", () => {
  it("asks the engine to record a web fetch, a web search, a network command and another MCP server", () => {
    const place = layout();
    expect(
      run(place, "post-tool", tool("WebFetch", { url: "https://example.com" }, "postToolUse")).json,
    ).toEqual({});
    expect(run(place, "post-tool", tool("WebSearch", { query: "x" }, "postToolUse")).json).toEqual(
      {},
    );
    expect(
      run(place, "post-tool", {
        ...common("afterShellExecution"),
        command: "curl https://example.com",
        output: "ok",
        duration: 3,
      }).json,
    ).toEqual({});
    expect(
      run(place, "post-tool", {
        ...common("afterMCPExecution"),
        tool_name: "list_issues",
        tool_input: "{}",
        mcp_server_name: "linear",
        result_json: "{}",
        duration: 4,
      }).json,
    ).toEqual({});
    const log = readFileSync(place.engineLog, "utf8").trim().split("\n");
    expect(log).toHaveLength(4);
    expect(log.every((line) => line.startsWith("post-tool "))).toBe(true);
  });

  it("does not start the engine for what is no outside read", () => {
    const place = layout();
    run(place, "post-tool", {
      ...common("afterShellExecution"),
      command: "pnpm test",
      output: "",
      duration: 1,
    });
    run(place, "post-tool", {
      ...common("afterMCPExecution"),
      tool_name: "get_state",
      tool_input: "{}",
      mcp_server_name: "agentplugged",
      result_json: "{}",
      duration: 1,
    });
    run(place, "post-tool", tool("Read", { file_path: "a" }, "postToolUse"));
    expect(existsSync(place.engineLog)).toBe(false);
  });

  it("never fails: a crashing engine is ignored", () => {
    const place = layout();
    const result = run(
      place,
      "post-tool",
      tool("WebFetch", { url: "https://example.com/CRASH" }, "postToolUse"),
    );
    expect(result.status).toBe(0);
    expect(result.json).toEqual({});
  });
});

describe("the script itself", () => {
  it("answers an empty object to an event it does not know", () => {
    const place = layout();
    expect(run(place, "unknown", {}).json).toEqual({});
  });
});
