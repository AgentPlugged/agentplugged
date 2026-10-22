import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  engineCommand,
  initCommand,
  mcpLaunch,
  renderConstitutionReference,
  resolveProfile,
  syncCommand,
  type ToolProbe,
  withEngineCommand,
} from "../index.js";
import { fixtureAgent, MemoryFiles, shippedMethod } from "../testing/memory-files.js";

/** The engine's command on this machine, and the rules of the chat's conversation. */

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const DOCS_CHECK = "Run `npx agentplugged docs check` before you propose it.";

/** Iris and Noah, one skill and its Markdown annex, all of which cite the engine. */
const METHOD = shippedMethod({
  ...fixtureAgent("noah", { name: "Noah" }),
  "skills/write-brief/SKILL.md": `---\nname: write-brief\ndescription: A skill of the tests.\n---\n# Brief\n\n${DOCS_CHECK}\n`,
  "skills/write-brief/references/checklist.md": `# Checklist\n\n${DOCS_CHECK}\n`,
});

function context(files: MemoryFiles): CommandContext {
  return { files, tools: NO_TOOL, method: METHOD, actor: "human", engineVersion: "1.0.0" };
}

const CONFIG = ".agentplugged/method.yaml";

async function installed(mcp?: string): Promise<MemoryFiles> {
  const files = new MemoryFiles();
  const result = await initCommand.run(context(files), { profile: resolveProfile("new-product") });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  if (mcp !== undefined) files.seed(CONFIG, `${files.files.get(CONFIG)}${mcp}`);
  return files;
}

async function sync(files: MemoryFiles, platform?: string) {
  const result = await syncCommand.run({ ...context(files), platform }, {});
  if (!result.ok) throw new Error(`sync failed: ${result.error.code}`);
  return result.value;
}

/** Every generated text that reaches the agents: Markdown and Codex's TOML agents. */
function agentTexts(files: MemoryFiles): [string, string][] {
  return [...files.files.entries()].filter(
    ([path]) => /\.(md|mdc|toml)$/.test(path) && !path.startsWith(".agentplugged/"),
  );
}

describe("engineCommand and withEngineCommand", () => {
  it("is the launch of the MCP configuration, without its wrapper nor its `mcp`", () => {
    expect(engineCommand(mcpLaunch("1.2.3", { platform: "linux" }))).toBe(
      "npx -y agentplugged@1.2.3",
    );
    expect(engineCommand(mcpLaunch("1.2.3", { platform: "win32" }))).toBe(
      "npx -y agentplugged@1.2.3",
    );
    expect(
      engineCommand(
        mcpLaunch("1.2.3", { override: { command: "node", args: ["/work/cli/bin.js", "mcp"] } }),
      ),
    ).toBe("node /work/cli/bin.js");
  });

  it("quotes a Windows path and a path with a space, so a shell keeps it whole", () => {
    expect(
      engineCommand(
        mcpLaunch("1.0.0", {
          override: { command: "node", args: ["C:\\Work\\agent plugged\\bin.js", "mcp"] },
        }),
      ),
    ).toBe('node "C:\\Work\\agent plugged\\bin.js"');
    expect(
      engineCommand(
        mcpLaunch("1.0.0", { override: { command: "node", args: ["C:\\Work\\bin.js", "mcp"] } }),
      ),
    ).toBe('node "C:\\Work\\bin.js"');
  });

  it("keeps a launch that does not end with `mcp` as it is", () => {
    expect(engineCommand({ command: "agentplugged", args: [] })).toBe("agentplugged");
    expect(engineCommand({ command: "node", args: ["a.js", "--flag"] })).toBe("node a.js --flag");
  });

  it("replaces the phrase wherever it stands, never a pinned or longer one", () => {
    const engine = "node /w/bin.js";
    expect(
      withEngineCommand("`npx agentplugged docs check`, then `npx agentplugged next`.", engine),
    ).toBe("`node /w/bin.js docs check`, then `node /w/bin.js next`.");
    expect(withEngineCommand("npx agentplugged@1.0.0 sync and npx agentplugged-x", engine)).toBe(
      "npx agentplugged@1.0.0 sync and npx agentplugged-x",
    );
    // A `$` of the command is not a replacement pattern.
    expect(withEngineCommand("npx agentplugged sync", 'node "C:\\$&\\bin.js"')).toBe(
      'node "C:\\$&\\bin.js" sync',
    );
  });
});

describe("sync writes the engine command that works on this machine", () => {
  it("the pinned npx launch by default, in the constitution, skills, agents and annexes", async () => {
    const files = await installed();
    await sync(files);
    const texts = agentTexts(files);
    expect(texts.length).toBeGreaterThan(8);
    for (const [path, text] of texts) {
      expect(text, path).not.toMatch(/npx agentplugged(?![@\w-])/);
    }
    for (const path of [
      ".claude/skills/write-brief/SKILL.md",
      ".claude/skills/write-brief/references/checklist.md",
      ".agents/skills/write-brief/SKILL.md",
    ]) {
      expect(files.files.get(path), path).toContain(
        "Run `npx -y agentplugged@1.0.0 docs check` before you propose it.",
      );
    }
    expect(files.files.get("AGENTS.md")).toContain("`npx -y agentplugged@1.0.0 docs check`");
  });

  it("the local engine of method.yaml when the package is not published, everywhere", async () => {
    const files = await installed(
      "mcp:\n  command: node\n  args: ['C:\\Work\\agent plugged\\bin.js', mcp]\n",
    );
    await sync(files, "win32");
    const local = 'node "C:\\Work\\agent plugged\\bin.js"';
    for (const [path, text] of agentTexts(files)) {
      expect(text, path).not.toMatch(/npx (-y )?agentplugged/);
    }
    expect(files.files.get(".claude/skills/write-brief/SKILL.md")).toContain(
      `Run \`${local} docs check\` before you propose it.`,
    );
    expect(files.files.get(".claude/skills/write-brief/references/checklist.md")).toContain(
      `\`${local} docs check\``,
    );
    expect(files.files.get(".claude/skills/iris/SKILL.md")).not.toContain("npx agentplugged");
    expect(files.files.get("AGENTS.md")).toContain(`\`${local} docs check\``);
    // Codex's agents are TOML: the path stays valid text there, never an unescaped string.
    const codex = files.files.get(".codex/agents/iris.toml") ?? "";
    expect(codex).not.toContain("npx agentplugged");
  });

  it("init and sync write the same constitution, and a second run changes nothing", async () => {
    const files = await installed("mcp:\n  command: node\n  args: [/work/bin.js, mcp]\n");
    const reinit = await initCommand.run(context(files), {});
    expect(reinit.ok).toBe(true);
    const afterInit = files.files.get("AGENTS.md");
    await sync(files);
    expect(files.files.get("AGENTS.md")).toBe(afterInit);
    expect(afterInit).toContain("`node /work/bin.js docs check`");
    const again = await sync(files);
    expect(again.entries.every((entry) => entry.action === "unchanged")).toBe(true);
  });
});

describe("the constitution's rules for the conversation", () => {
  const withNoah = renderConstitutionReference([], undefined, { tools: ["claude-code"] });
  const withoutNoah = renderConstitutionReference();

  it("says who speaks, and announces each handover in both directions", () => {
    for (const text of [withNoah, withoutNoah]) {
      expect(text).toContain("## Talking with the creator");
      expect(text).toContain("Begin each message with your icon and your first name");
      expect(text).toContain("every handover in both directions");
    }
    expect(withNoah).toContain("🧭 Noah : I hand over to Iris for the brief.");
    expect(withNoah).toContain("🔎 Iris : I give the hand back to Noah.");
    // Without Noah, the hand goes back to the creator and Noah is not named.
    expect(withoutNoah).toContain("🔎 Iris : I give the hand back to you.");
    expect(withoutNoah).not.toContain("🧭 Noah");
    expect(withoutNoah).not.toContain("hand back to Noah");
  });

  it("opens the checkpoint before asking, and never asks twice", () => {
    for (const text of [withNoah, withoutNoah]) {
      const flat = text.replace(/\s+/g, " ");
      expect(flat).toContain("call `checkpoint.open`, and only then ask the creator");
      expect(flat).toContain("Never ask for the same validation twice");
      expect(flat).toContain("Asking the creator's opinion comes after the opening, never before");
    }
  });

  it("shows local time, never UTC, from the clock of get_state", () => {
    const flat = withoutNoah.replace(/\s+/g, " ");
    expect(flat).toContain("Show every date and time in the creator's local time, never in UTC");
    expect(flat).toContain("`clock` in `state.get`");
    expect(flat).toContain("`time_zone`");
  });

  it("keeps the engine's inner workings from the creator, unless one blocks an action", () => {
    const flat = withoutNoah.replace(/\s+/g, " ");
    expect(flat).toContain("Keep the engine's inner workings to yourself");
    for (const word of ["unverified session", "provenance", "fingerprint", "event id"]) {
      expect(flat, word).toContain(word);
    }
    expect(flat).toContain("exception is a detail that blocks an action");
    expect(flat).toContain("in one plain sentence that tells them what to do");
  });

  it("asks the creator for a Git identity instead of borrowing one", () => {
    const flat = withoutNoah.replace(/\s+/g, " ");
    expect(flat).toContain("never borrow an identity from the history");
    expect(flat).toContain("ask the creator, once, the name and the email address");
    expect(flat).toContain('git -c user.name="…" -c user.email="…" commit');
    expect(flat).toContain("never `--global` nor `--system`");
    expect(flat).toContain(
      "Never change the global Git configuration without their explicit agreement",
    );
  });

  it("tells Noah to wait while the work is out, and to offer a fresh conversation per phase", () => {
    const flat = withNoah.replace(/\s+/g, " ");
    // His rules (waiting, one conversation per phase) are in his role; the constitution keeps what
    // depends on the tool: how a fresh conversation starts.
    expect(flat).toContain(
      "a fresh conversation is `/clear` in Claude Code, a new session in the other tools",
    );
    expect(flat).toContain("`agent.delegate` before you launch anything");
    expect(withoutNoah).not.toContain("a fresh conversation is `/clear`");
  });
});
