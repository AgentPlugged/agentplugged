import { PassThrough } from "node:stream";
import {
  type CodexUserConfig,
  codexHookHashes,
  renderCodexHooks,
  type WorkspaceFiles,
} from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";
import { offerCodexTrust } from "./codex-trust-flow.js";
import { createPrompter } from "./prompt.js";

const t = createTranslator("en");
const ROOT = "C:\\Users\\Ada\\Desktop\\demo";

/** The project's files: only `.codex/config.toml`, with the hooks `sync` writes (or not). */
const project = (text: string | undefined): WorkspaceFiles =>
  ({
    exists: async () => text !== undefined,
    readText: async () => text ?? "",
  }) as unknown as WorkspaceFiles;

/** Codex's own `config.toml`, in memory; counts the writes. */
function userConfig(initial: string | undefined) {
  let text = initial;
  const writes: string[] = [];
  const config: CodexUserConfig = {
    path: "C:\\Users\\Ada\\.codex\\config.toml",
    read: async () => text,
    write: async (next) => {
      writes.push(next);
      text = next;
    },
  };
  return { config, writes, text: () => text };
}

function ask(answer: string | undefined) {
  const input = new PassThrough();
  if (answer !== undefined) input.write(`${answer}\n`);
  else input.end();
  const prompter = createPrompter(input, () => {});
  return { prompter: () => prompter, close: () => prompter.close() };
}

const run = async (options: {
  answer?: string | undefined;
  interactive?: boolean;
  platform?: string;
  files?: WorkspaceFiles;
  config: CodexUserConfig;
}) => {
  const typed = ask(options.answer);
  const note = await offerCodexTrust({
    t,
    interactive: options.interactive ?? true,
    platform: options.platform ?? "win32",
    projectRoot: ROOT,
    files: options.files ?? project(`# generated\n${renderCodexHooks()}`),
    userConfig: options.config,
    prompter: typed.prompter,
  });
  typed.close();
  return note;
};

describe("approving Codex's hooks for the creator (layer 2)", () => {
  it("writes the three approvals, under both drive spellings, after a yes", async () => {
    const user = userConfig('model = "x"\n');
    const note = await run({ answer: "yes", config: user.config });
    expect(note).toContain("3 hooks of agentplugged approved");
    expect(user.writes).toHaveLength(1);
    const text = user.text() ?? "";
    expect(text.startsWith('model = "x"\n')).toBe(true);
    for (const { label, hash } of codexHookHashes()) {
      expect(text).toContain(
        `[hooks.state.'C:\\Users\\Ada\\Desktop\\demo\\.codex\\config.toml:${label}:0:0']\ntrusted_hash = "${hash}"`,
      );
      expect(text).toContain(`'c:\\Users\\Ada\\Desktop\\demo\\.codex\\config.toml:${label}:0:0'`);
    }
    // Asked again once everything is approved: nothing to ask, nothing to write.
    expect(await run({ answer: "yes", config: user.config })).toBeUndefined();
    expect(user.writes).toHaveLength(1);
  });

  it("writes nothing on a no, an empty answer, or the end of the input", async () => {
    for (const answer of ["no", "", undefined]) {
      const user = userConfig('model = "x"\n');
      const note = await run({ answer, config: user.config });
      expect(note).toContain("not approved");
      expect(user.writes).toEqual([]);
    }
  });

  it("never asks, never writes, when nobody can answer (a script, --yes, a pipe)", async () => {
    const user = userConfig(undefined);
    expect(await run({ answer: "yes", interactive: false, config: user.config })).toBeUndefined();
    expect(user.writes).toEqual([]);
  });

  it("proposes nothing on a platform where the hash was not checked, nor for hooks that are not ours", async () => {
    const user = userConfig(undefined);
    expect(await run({ answer: "yes", platform: "linux", config: user.config })).toBeUndefined();
    expect(
      await run({ answer: "yes", files: project("# the creator's own\n"), config: user.config }),
    ).toBeUndefined();
    expect(
      await run({ answer: "yes", files: project(undefined), config: user.config }),
    ).toBeUndefined();
    expect(user.writes).toEqual([]);
  });

  it("writes nothing and says why when the file has a form it cannot merge", async () => {
    const user = userConfig(
      `[hooks.state."${ROOT}\\.codex\\config.toml:pre_tool_use:0:0"]\ntrusted_hash = "sha256:1"\n`,
    );
    const note = await run({ answer: "yes", config: user.config });
    expect(note).toContain("I wrote nothing");
    expect(user.writes).toEqual([]);
  });

  it("merges again into what the file holds right before the write: nothing Codex wrote meanwhile is lost", async () => {
    const user = userConfig('model = "x"\n');
    let reads = 0;
    const racing: CodexUserConfig = {
      ...user.config,
      read: async () => {
        reads += 1;
        // Codex marks a folder as trusted while the question waits.
        return reads === 1
          ? user.text()
          : `${user.text()}[projects.'C:\\work']\ntrust_level = "trusted"\n`;
      },
    };
    const note = await run({ answer: "yes", config: racing });
    expect(note).toContain("approved");
    const written = user.writes.at(-1) ?? "";
    expect(written).toContain("[projects.'C:\\work']\ntrust_level = \"trusted\"");
    expect(written).toContain(
      "[hooks.state.'C:\\Users\\Ada\\Desktop\\demo\\.codex\\config.toml:pre_tool_use:0:0']",
    );
  });

  it("tells the 'Review hooks' icon of the extension in the notice", () => {
    for (const locale of ["fr", "en"] as const) {
      const text = createTranslator(locale)("sync.codex_trust");
      expect(text).toContain(locale === "fr" ? "Examiner les hooks" : "Review hooks");
      expect(text).toContain("/hooks");
    }
  });

  it("says so, and leaves the gesture, when the write fails", async () => {
    const user = userConfig(undefined);
    const failing: CodexUserConfig = {
      ...user.config,
      write: async () => {
        throw new Error("EPERM");
      },
    };
    const note = await run({ answer: "yes", config: failing });
    expect(note).toContain("could not write");
    expect(note).toContain("EPERM");
  });
});
