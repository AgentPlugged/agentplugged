import type { ToolId } from "@agentplugged/protocol";

export type { ToolId };

export interface ToolSpec {
  readonly id: ToolId;
  /** Product name, never translated. */
  readonly name: string;
  /** Commands that run the tool, in order of preference. */
  readonly commands: readonly string[];
  /** Prefix of its extension folders (`<prefix>-<version>-<platform>`). */
  readonly extensionPrefix?: string;
  /** Command of an editor that embeds the tool. */
  readonly editorCommand?: string;
  /** What `sync` generates for this tool: how the method drives it. */
  readonly driveFiles: readonly string[];
}

/** The AI tools the method knows how to drive, in display order. */
export const TOOL_CATALOG: readonly ToolSpec[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    commands: ["claude"],
    extensionPrefix: "anthropic.claude-code",
    driveFiles: ["CLAUDE.md", ".claude/"],
  },
  {
    id: "codex",
    name: "Codex",
    commands: ["codex"],
    extensionPrefix: "openai.chatgpt",
    driveFiles: ["AGENTS.md", ".codex/"],
  },
  {
    id: "antigravity",
    name: "Antigravity CLI",
    commands: ["agy"],
    driveFiles: ["GEMINI.md", ".gemini/"],
  },
  {
    id: "cursor",
    name: "Cursor",
    // Only `cursor-agent`: a bare `agent` on PATH may be any unrelated program.
    commands: ["cursor-agent"],
    editorCommand: "cursor",
    driveFiles: ["AGENTS.md", ".cursor/"],
  },
  {
    id: "kimi",
    name: "Kimi Code CLI",
    // `kimi` is also the command of the archived Python Kimi CLI: both are recognised as Kimi.
    commands: ["kimi"],
    driveFiles: ["AGENTS.md", ".kimi-code/"],
  },
];
