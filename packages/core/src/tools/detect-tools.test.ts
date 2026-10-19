import { describe, expect, it } from "vitest";
import { compareVersions, type DetectedTool, detectTools, parseVersion } from "./detect-tools.js";
import type { ExtensionMatch, ToolProbe } from "./tool-probe.js";

interface FakeMachine {
  /** Command name -> `--version` output; undefined means the probe fails. */
  readonly commands?: Record<string, string | undefined>;
  /** Extension prefix -> folders. */
  readonly extensions?: Record<string, ExtensionMatch[]>;
  /** Steps that throw. */
  readonly crash?: { which?: boolean; version?: boolean; extensions?: boolean };
}

function fakeProbe(machine: FakeMachine = {}): ToolProbe & { calls: string[] } {
  const calls: string[] = [];
  const commands = machine.commands ?? {};
  return {
    calls,
    async which(names) {
      calls.push(`which:${names.join(",")}`);
      if (machine.crash?.which) throw new Error("boom");
      const name = names.find((candidate) => Object.hasOwn(commands, candidate));
      return name === undefined ? undefined : { name, path: `/fake/${name}` };
    },
    async version(path) {
      calls.push(`version:${path}`);
      if (machine.crash?.version) throw new Error("boom");
      return commands[path.replace("/fake/", "")];
    },
    async extensions(prefix) {
      calls.push(`extensions:${prefix}`);
      if (machine.crash?.extensions) throw new Error("boom");
      return machine.extensions?.[prefix] ?? [];
    },
  };
}

const byId = (tools: DetectedTool[], id: string) => {
  const tool = tools.find((candidate) => candidate.id === id);
  if (!tool) throw new Error(`missing ${id}`);
  return tool;
};

const notFound = (id: string, name: string) => ({
  id,
  name,
  found: false,
  version: undefined,
  versionRecognized: false,
  sources: [],
  cliMissingForBridge: false,
});

describe("parseVersion", () => {
  it.each([
    ["2.1.287 (Claude Code)", "2.1.287"],
    ["codex-cli 0.48.0", "0.48.0"],
    ["v1.2.3-alpha.21\n", "1.2.3-alpha.21"],
    ["0.62.0-nightly.", "0.62.0-nightly"],
    ["1.105.1\nabc123\nx64", "1.105.1"],
    ["26.818.22352", "26.818.22352"],
    ["???", undefined],
    ["1.2", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("reads %j as %j", (text, expected) => {
    expect(parseVersion(text)).toBe(expected);
  });
});

describe("compareVersions", () => {
  it("orders numerically, a release after its pre-releases", () => {
    const sorted = ["1.10.0", "1.2.0", "1.2.0-beta.10", "1.2.0-beta.2", "0.9.9"].sort(
      compareVersions,
    );
    expect(sorted).toEqual(["0.9.9", "1.2.0-beta.2", "1.2.0-beta.10", "1.2.0", "1.10.0"]);
  });
});

describe("detectTools", () => {
  it("lists the four tools as not found on an empty machine", async () => {
    const tools = await detectTools(fakeProbe());
    expect(tools).toEqual([
      { ...notFound("claude-code", "Claude Code"), driveFiles: ["CLAUDE.md", ".claude/"] },
      { ...notFound("codex", "Codex"), driveFiles: ["AGENTS.md", ".codex/"] },
      { ...notFound("antigravity", "Antigravity CLI"), driveFiles: ["GEMINI.md", ".gemini/"] },
      { ...notFound("cursor", "Cursor"), driveFiles: ["AGENTS.md", ".cursor/"] },
    ]);
  });

  it("reads the version of a command in PATH", async () => {
    const tools = await detectTools(fakeProbe({ commands: { claude: "2.1.287 (Claude Code)" } }));
    expect(byId(tools, "claude-code")).toMatchObject({
      found: true,
      version: "2.1.287",
      versionRecognized: true,
      sources: [{ kind: "command", command: "claude" }],
      cliMissingForBridge: false,
    });
  });

  it("finds a tool installed only as an extension, and flags the bridge", async () => {
    const probe = fakeProbe({
      extensions: {
        "anthropic.claude-code": [{ editor: "vscode", version: "2.1.287" }],
      },
    });
    expect(byId(await detectTools(probe), "claude-code")).toMatchObject({
      found: true,
      version: "2.1.287",
      versionRecognized: true,
      sources: [{ kind: "extension", editor: "vscode" }],
      cliMissingForBridge: true,
    });
    expect(probe.calls).toContain("extensions:anthropic.claude-code");
    expect(probe.calls).toContain("extensions:openai.chatgpt");
  });

  it("keeps the highest extension version and cites every editor", async () => {
    const tools = await detectTools(
      fakeProbe({
        extensions: {
          "openai.chatgpt": [
            { editor: "vscode", version: "26.9.1" },
            { editor: "cursor", version: "26.818.22352" },
            { editor: "vscode", version: undefined },
            { editor: "vscode", version: "26.10.0" },
          ],
        },
      }),
    );
    expect(byId(tools, "codex")).toMatchObject({
      version: "26.818.22352",
      sources: [
        { kind: "extension", editor: "vscode" },
        { kind: "extension", editor: "cursor" },
      ],
    });
  });

  it("shows one line with the CLI version when both the CLI and the extension exist", async () => {
    const tools = await detectTools(
      fakeProbe({
        commands: { claude: "2.1.300 (Claude Code)" },
        extensions: { "anthropic.claude-code": [{ editor: "vscode", version: "2.1.287" }] },
      }),
    );
    expect(tools.filter((tool) => tool.id === "claude-code")).toHaveLength(1);
    expect(byId(tools, "claude-code")).toMatchObject({
      version: "2.1.300",
      sources: [
        { kind: "command", command: "claude" },
        { kind: "extension", editor: "vscode" },
      ],
      cliMissingForBridge: false,
    });
  });

  it("does not take the retired gemini command for Antigravity CLI", async () => {
    const tools = await detectTools(fakeProbe({ commands: { gemini: "0.62.0" } }));
    expect(byId(tools, "antigravity").found).toBe(false);
    const both = await detectTools(fakeProbe({ commands: { agy: "1.0.0", gemini: "0.62.0" } }));
    expect(byId(both, "antigravity")).toMatchObject({
      name: "Antigravity CLI",
      version: "1.0.0",
      sources: [{ kind: "command", command: "agy" }],
    });
  });

  it("finds Cursor through cursor-agent, then the editor, never a bare agent", async () => {
    const cli = await detectTools(fakeProbe({ commands: { "cursor-agent": "2025.10.1" } }));
    expect(byId(cli, "cursor")).toMatchObject({
      sources: [{ kind: "command", command: "cursor-agent" }],
      cliMissingForBridge: false,
    });

    const bare = await detectTools(fakeProbe({ commands: { agent: "2025.10.1" } }));
    expect(byId(bare, "cursor").found).toBe(false);

    const editor = await detectTools(fakeProbe({ commands: { cursor: "1.7.2\nabc\nx64" } }));
    expect(byId(editor, "cursor")).toMatchObject({
      found: true,
      version: "1.7.2",
      sources: [{ kind: "editor", command: "cursor" }],
      cliMissingForBridge: true,
    });
  });

  it("lists a tool whose version is unreadable, flagged", async () => {
    const tools = await detectTools(fakeProbe({ commands: { codex: "???" } }));
    expect(byId(tools, "codex")).toMatchObject({
      found: true,
      version: undefined,
      versionRecognized: false,
      sources: [{ kind: "command", command: "codex" }],
    });
  });

  it("does not cover an unreadable command version with the extension's", async () => {
    const tools = await detectTools(
      fakeProbe({
        commands: { codex: "???" },
        extensions: { "openai.chatgpt": [{ editor: "vscode", version: "26.818.22352" }] },
      }),
    );
    expect(byId(tools, "codex")).toMatchObject({
      found: true,
      version: undefined,
      versionRecognized: false,
      sources: [
        { kind: "command", command: "codex" },
        { kind: "extension", editor: "vscode" },
      ],
      cliMissingForBridge: false,
    });
  });

  it("treats a failing probe (time limit, non-zero exit) as not found", async () => {
    const tools = await detectTools(fakeProbe({ commands: { claude: undefined } }));
    expect(byId(tools, "claude-code").found).toBe(false);
  });

  it("never fails when a probe crashes", async () => {
    for (const crash of [{ which: true }, { version: true }, { extensions: true }]) {
      const tools = await detectTools(
        fakeProbe({
          commands: { codex: "1.0.0" },
          extensions: { "openai.chatgpt": [{ editor: "vscode", version: "2.0.0" }] },
          crash,
        }),
      );
      expect(tools).toHaveLength(4);
      expect(byId(tools, "codex").found).toBe(true);
    }
  });

  it("looks for every tool in parallel", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const probe: ToolProbe = {
      async which() {
        started += 1;
        await gate;
        return undefined;
      },
      version: async () => undefined,
      extensions: async () => [],
    };
    const detection = detectTools(probe);
    // Every tool has started probing before any probe answers.
    expect(started).toBe(5);
    release();
    await detection;
  });
});
