import { describe, expect, it } from "vitest";
import {
  KIMI_HOOKS_BEGIN,
  KIMI_HOOKS_END,
  kimiHookCommand,
  kimiHooksBlock,
  kimiHooksState,
  withKimiHooks,
  withoutKimiHooks,
} from "./kimi-hooks.js";

const ENGINE = "npx -y agentplugged@1.4.0";
const MINE =
  'default_model = "k2"\n\n[[hooks]]\nevent = "PreToolUse"\nmatcher = "Bash"\ncommand = "echo mine"\n';

function installed(text: string | undefined, engine = ENGINE): string {
  const edit = withKimiHooks(text, engine);
  if (edit.kind !== "changed") throw new Error(`expected a change, got ${edit.kind}`);
  return edit.text;
}

describe("the block of hooks in the user's Kimi settings", () => {
  it("is one PreToolUse rule that runs the engine's hook for Kimi", () => {
    const block = kimiHooksBlock(ENGINE);
    expect(block).toBe(
      [
        KIMI_HOOKS_BEGIN,
        "[[hooks]]",
        'event = "PreToolUse"',
        'command = "npx -y agentplugged@1.4.0 hook kimi pre-tool"',
        "timeout = 30",
        KIMI_HOOKS_END,
      ].join("\n"),
    );
    expect(kimiHookCommand(ENGINE)).toBe("npx -y agentplugged@1.4.0 hook kimi pre-tool");
    // No field Kimi would reject: its file fails to load with an extra one.
    expect(block).not.toMatch(/matcher|name =|description/);
  });

  it("is created whole in a file that does not exist or is empty", () => {
    expect(installed(undefined)).toBe(`${kimiHooksBlock(ENGINE)}\n`);
    expect(installed("  \n")).toBe(`${kimiHooksBlock(ENGINE)}\n`);
  });

  it("is added after the creator's text, which stays byte for byte", () => {
    const next = installed(MINE);
    expect(next.startsWith(MINE)).toBe(true);
    expect(next).toBe(`${MINE}\n${kimiHooksBlock(ENGINE)}\n`);
    expect(kimiHooksState(next, ENGINE)).toBe("installed");
  });

  it("adds the missing line break, and keeps Windows line breaks", () => {
    expect(installed("a = 1").startsWith("a = 1\n\n# agentplugged:begin")).toBe(true);
    const crlf = installed("a = 1\r\nb = 2\r\n");
    expect(crlf.startsWith("a = 1\r\nb = 2\r\n\r\n# agentplugged:begin")).toBe(true);
    expect(crlf.replaceAll("\r\n", "").includes("\n")).toBe(false);
  });

  it("is idempotent: installing again changes nothing", () => {
    const once = installed(MINE);
    expect(withKimiHooks(once, ENGINE)).toEqual({ kind: "unchanged" });
  });

  it("is replaced in place when another engine version wrote it, the rest untouched", () => {
    const older = installed(MINE, "npx -y agentplugged@1.2.0");
    const tail = `${older}more = true\n`;
    expect(kimiHooksState(tail, ENGINE)).toBe("outdated");
    const next = installed(tail);
    expect(next).toBe(`${MINE}\n${kimiHooksBlock(ENGINE)}\nmore = true\n`);
    expect(kimiHooksState(next, ENGINE)).toBe("installed");
  });

  it("is taken away cleanly, leaving exactly what the creator had", () => {
    expect(withoutKimiHooks(installed(MINE))).toEqual({ kind: "changed", text: MINE });
    expect(withoutKimiHooks(installed(undefined))).toEqual({ kind: "changed", text: "" });
    expect(withoutKimiHooks(MINE)).toEqual({ kind: "unchanged" });
    const crlf = installed("a = 1\r\n");
    expect(withoutKimiHooks(crlf)).toEqual({ kind: "changed", text: "a = 1\r\n" });
  });

  it("never touches an entry of the creator's, even one that looks like ours", () => {
    const lookalike = `${MINE}\n[[hooks]]\nevent = "PreToolUse"\ncommand = "npx -y agentplugged@1.4.0 hook kimi pre-tool"\n`;
    // Without our markers, it is the creator's: not ours, so the state is `missing` and nothing is removed.
    expect(kimiHooksState(lookalike, ENGINE)).toBe("missing");
    expect(withoutKimiHooks(lookalike)).toEqual({ kind: "unchanged" });
    const next = installed(lookalike);
    expect(next.startsWith(lookalike)).toBe(true);
    expect(withoutKimiHooks(next)).toEqual({ kind: "changed", text: lookalike });
  });

  it("refuses a file it cannot change safely, and says why", () => {
    expect(withKimiHooks(`${KIMI_HOOKS_BEGIN}\nx = 1\n`, ENGINE)).toEqual({
      kind: "refused",
      reason: "unbalanced_markers",
    });
    expect(withoutKimiHooks(`x = 1\n${KIMI_HOOKS_END}\n`)).toEqual({
      kind: "refused",
      reason: "unbalanced_markers",
    });
    // A doubled end marker is ambiguous too.
    expect(withoutKimiHooks(`${kimiHooksBlock(ENGINE)}\n${KIMI_HOOKS_END}\n`)).toEqual({
      kind: "refused",
      reason: "unbalanced_markers",
    });
    expect(withKimiHooks('hooks = [{ event = "Stop", command = "x" }]\n', ENGINE)).toEqual({
      kind: "refused",
      reason: "inline_hooks",
    });
  });

  it("reads the state of an absent file as missing", () => {
    expect(kimiHooksState(undefined, ENGINE)).toBe("missing");
    expect(kimiHooksState("", ENGINE)).toBe("missing");
  });
});

describe("the direct form of the hook", () => {
  const ENTRY = "/opt/agentplugged/dist/bin.js";
  const SPACED = "C:\\Users\\Some One\\AppData\\agentplugged\\dist\\bin.js";

  it("starts the installed engine and falls back to npx when its file is gone", () => {
    expect(kimiHookCommand(ENGINE, ENTRY)).toBe(
      `node "${ENTRY}" hook kimi pre-tool || npx -y agentplugged@1.4.0 hook kimi pre-tool`,
    );
  });

  it("quotes a path with spaces and backslashes, and writes it as valid TOML text", () => {
    const block = kimiHooksBlock(ENGINE, SPACED);
    expect(kimiHookCommand(ENGINE, SPACED)).toContain(`node "${SPACED}" hook kimi pre-tool || `);
    const line = block.split("\n").find((l) => l.startsWith("command = ")) ?? "";
    expect(JSON.parse(line.slice("command = ".length))).toBe(kimiHookCommand(ENGINE, SPACED));
    expect(kimiHooksState(`${block}\n`, ENGINE, (path) => path === SPACED)).toBe("installed");
  });

  it("is installed while the file named exists, and outdated once it is gone", () => {
    const text = `${kimiHooksBlock(ENGINE, ENTRY)}\n`;
    expect(kimiHooksState(text, ENGINE, (path) => path === ENTRY)).toBe("installed");
    expect(kimiHooksState(text, ENGINE, () => false)).toBe("outdated");
    expect(kimiHooksState(text, ENGINE)).toBe("outdated");
    // A block of another version stays outdated even when its file exists.
    expect(kimiHooksState(text, "npx -y agentplugged@1.5.0", () => true)).toBe("outdated");
  });

  it("replaces the npx-only block in place and is left alone when equal", () => {
    const npxOnly = installed(MINE);
    const next = withKimiHooks(npxOnly, ENGINE, ENTRY);
    if (next.kind !== "changed") throw new Error("expected a change");
    expect(next.text).toContain(`node \\"${ENTRY}\\"`);
    expect(next.text.startsWith(MINE)).toBe(true);
    expect(withKimiHooks(next.text, ENGINE, ENTRY)).toEqual({ kind: "unchanged" });
  });

  it("falls back to npx alone for a path it cannot quote", () => {
    for (const entry of ['/a"b/bin.js', "/a\nb/bin.js", ""]) {
      expect(kimiHookCommand(ENGINE, entry)).toBe(kimiHookCommand(ENGINE));
    }
  });
});
