import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeToolProbe, packageName } from "./index.js";

const windows = process.platform === "win32";

describe("adapters-tools", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@agentplugged/adapters-tools");
  });
});

describe("NodeToolProbe", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentplugged-tools-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Environment of the machine, with `PATH` and the home folder replaced. */
  function envWith(path: string, home = root): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^(path|home|userprofile)$/i.test(key)) env[key] = value;
    }
    return { ...env, PATH: path, HOME: home, USERPROFILE: home };
  }

  /**
   * A fake command `name` in `dir`: a Node script that runs `body`, behind a `.cmd` on
   * Windows or a shell script elsewhere.
   */
  async function fakeCommand(dir: string, name: string, body: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    const script = join(dir, `${name}.mjs`);
    await writeFile(script, body);
    if (windows) {
      const path = join(dir, `${name}.cmd`);
      await writeFile(path, `@"${process.execPath}" "${script}" %*\r\n`);
      return path;
    }
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(path, 0o755);
    return path;
  }

  const prints = (text: string) => `process.stdout.write(${JSON.stringify(text)});`;

  it("finds a tool its installer left out of PATH, after PATH (Antigravity CLI in ~/.gemini/bin)", async () => {
    const agy = await fakeCommand(join(root, ".gemini", "bin"), "agy", prints("1.2.16"));
    // Found off the PATH: said so.
    expect(await new NodeToolProbe({ env: envWith("") }).which(["agy", "gemini"])).toEqual({
      name: "agy",
      path: agy,
      onPath: false,
    });
    // PATH wins over the home folder.
    const onPath = await fakeCommand(join(root, "bin"), "agy", prints("2.0.0"));
    expect(await new NodeToolProbe({ env: envWith(join(root, "bin")) }).which(["agy"])).toEqual({
      name: "agy",
      path: onPath,
    });
  });

  it("finds Claude Code where its installers put it, off the PATH, and the PATH first", async () => {
    const native = await fakeCommand(join(root, ".local", "bin"), "claude", prints("2.1.0"));
    const probe = new NodeToolProbe({ env: envWith("") });
    expect(await probe.which(["claude"])).toEqual({ name: "claude", path: native, onPath: false });
    const former = await fakeCommand(join(root, ".claude", "local"), "codex", prints("0.5.0"));
    expect(await probe.which(["codex"])).toEqual({ name: "codex", path: former, onPath: false });
    const bin = join(root, "bin");
    const listed = await fakeCommand(bin, "claude", prints("2.2.0"));
    expect(await new NodeToolProbe({ env: envWith(bin) }).which(["claude"])).toEqual({
      name: "claude",
      path: listed,
    });
  });

  it("finds the first name present, in order, and nothing in an empty PATH", async () => {
    const bin = join(root, "bin");
    const gemini = await fakeCommand(bin, "gemini", prints("0.62.0"));
    const probe = new NodeToolProbe({ env: envWith(bin) });

    expect(await probe.which(["agy", "gemini"])).toEqual({ name: "gemini", path: gemini });
    expect(await probe.which(["claude"])).toBeUndefined();
    expect(await new NodeToolProbe({ env: envWith("") }).which(["gemini"])).toBeUndefined();
  });

  it("searches PATH folders in order, folders with spaces included", async () => {
    const first = join(root, "first dir");
    const second = join(root, "second");
    const expected = await fakeCommand(first, "claude", prints("1.0.0"));
    await fakeCommand(second, "claude", prints("2.0.0"));
    const separator = windows ? ";" : ":";
    const probe = new NodeToolProbe({ env: envWith([second, first].join(separator)) });
    expect((await probe.which(["claude"]))?.path).toBe(
      join(second, windows ? "claude.cmd" : "claude"),
    );
    const reversed = new NodeToolProbe({ env: envWith([first, second].join(separator)) });
    const match = await reversed.which(["claude"]);
    expect(match?.path).toBe(expected);
    expect(await reversed.version(match?.path ?? "")).toBe("1.0.0");
  });

  it("returns what --version prints", async () => {
    const bin = join(root, "bin");
    const claude = await fakeCommand(
      bin,
      "claude",
      `if (process.argv[2] !== "--version") process.exit(3); ${prints("2.1.287 (Claude Code)\n")}`,
    );
    const probe = new NodeToolProbe({ env: envWith(bin) });
    expect(await probe.version(claude)).toBe("2.1.287 (Claude Code)\n");
  });

  it("returns stdout, not a warning printed on stderr", async () => {
    const warns = `process.stderr.write("warning: Node 22.1.0 is deprecated\\n"); `;
    const codex = await fakeCommand(root, "codex", `${warns}${prints("codex-cli 0.48.0 ✓\n")}`);
    const probe = new NodeToolProbe({ env: envWith(root) });
    expect(await probe.version(codex)).toBe("codex-cli 0.48.0 ✓\n");

    // A tool that prints its version on stderr only is still read.
    const gemini = await fakeCommand(root, "gemini", `process.stderr.write("0.62.0\\n");`);
    expect(await probe.version(gemini)).toBe("0.62.0\n");
  });

  it("reports a non-zero exit code as a failed probe", async () => {
    const codex = await fakeCommand(root, "codex", `${prints("1.0.0")} process.exit(2);`);
    expect(await new NodeToolProbe({ env: envWith(root) }).version(codex)).toBeUndefined();
  });

  it("gives up after the time limit", async () => {
    const slow = await fakeCommand(root, "slow", "setTimeout(() => {}, 20_000);");
    const probe = new NodeToolProbe({ env: envWith(root), timeoutMs: 300 });
    const start = Date.now();
    expect(await probe.version(slow)).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("reports a missing executable as a failed probe", async () => {
    const probe = new NodeToolProbe({ env: envWith(root) });
    expect(await probe.version(join(root, windows ? "missing.exe" : "missing"))).toBeUndefined();
  });

  it.runIf(windows)("refuses what it cannot start without a shell", async () => {
    const probe = new NodeToolProbe({ env: envWith(root) });
    expect(await probe.version(join(root, "tool.ps1"))).toBeUndefined();
    expect(await probe.version(join(root, "tool"))).toBeUndefined();
    const unsafe = await fakeCommand(join(root, "100%"), "claude", prints("1.0.0"));
    expect(await probe.version(unsafe)).toBeUndefined();
  });

  it.runIf(windows)("follows PATHEXT and skips extension-less shims", async () => {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), "#!/bin/sh\n");
    const probe = new NodeToolProbe({ env: { ...envWith(bin), PATHEXT: ".EXE" } });
    expect(await probe.which(["claude"])).toBeUndefined();
    const cmd = await fakeCommand(bin, "claude", prints("1.0.0"));
    expect(await probe.which(["claude"])).toBeUndefined();
    const withCmd = new NodeToolProbe({ env: { ...envWith(bin), PATHEXT: ".EXE;.CMD" } });
    expect(await withCmd.which(["claude"])).toEqual({ name: "claude", path: cmd });
  });

  it.runIf(!windows)("skips files that are not executable", async () => {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), "#!/bin/sh\n");
    expect(await new NodeToolProbe({ env: envWith(bin) }).which(["claude"])).toBeUndefined();
  });

  it("reads the version of every matching extension folder", async () => {
    const extension = async (dir: string, name: string, manifest: string | undefined) => {
      const folder = join(root, dir, "extensions", name);
      await mkdir(folder, { recursive: true });
      if (manifest !== undefined) await writeFile(join(folder, "package.json"), manifest);
    };
    await extension(".vscode", "anthropic.claude-code-2.1.287-win32-x64", '{"version":"2.1.287"}');
    await extension(".vscode", "anthropic.claude-code-2.0.0", '{"version":"2.0.0"}');
    await extension(".vscode", "anthropic.claude-code-broken", "{not json");
    await extension(".cursor", "anthropic.claude-code-2.1.290", '{"version":"2.1.290"}');
    await extension(".cursor", "anthropic.claude-code-empty", undefined);
    await extension(".vscode", "anthropic.claude-codex-1.0.0", '{"version":"1.0.0"}');
    await extension(".vscode", "openai.chatgpt-26.818.22352", '{"version":"26.818.22352"}');

    const probe = new NodeToolProbe({ env: envWith("") });
    const found = await probe.extensions("anthropic.claude-code");
    const sorted = [...found].sort((a, b) =>
      `${a.editor}${a.version}`.localeCompare(`${b.editor}${b.version}`),
    );
    expect(sorted).toEqual([
      { editor: "cursor", version: "2.1.290" },
      { editor: "cursor", version: undefined },
      { editor: "vscode", version: "2.0.0" },
      { editor: "vscode", version: "2.1.287" },
      { editor: "vscode", version: undefined },
    ]);
    expect(await probe.extensions("openai.chatgpt")).toEqual([
      { editor: "vscode", version: "26.818.22352" },
    ]);
  });

  it("skips folders VS Code marks obsolete and scans VS Code Insiders", async () => {
    const vscode = join(root, ".vscode", "extensions");
    for (const name of ["openai.chatgpt-1.0.0", "openai.chatgpt-2.0.0", "openai.chatgpt-3.0.0"]) {
      await mkdir(join(vscode, name), { recursive: true });
      await writeFile(
        join(vscode, name, "package.json"),
        JSON.stringify({ version: name.slice(15) }),
      );
    }
    await writeFile(
      join(vscode, ".obsolete"),
      JSON.stringify({ "openai.chatgpt-2.0.0": true, "openai.chatgpt-3.0.0": false }),
    );
    const insiders = join(root, ".vscode-insiders", "extensions", "openai.chatgpt-4.0.0");
    await mkdir(insiders, { recursive: true });
    await writeFile(join(insiders, "package.json"), '{"version":"4.0.0"}');

    const probe = new NodeToolProbe({ env: envWith("") });
    const versions = (await probe.extensions("openai.chatgpt")).map(
      (found) => `${found.editor}:${found.version}`,
    );
    expect(versions.sort()).toEqual(["vscode:1.0.0", "vscode:3.0.0", "vscode:4.0.0"]);

    // An unreadable `.obsolete` hides nothing.
    await writeFile(join(vscode, ".obsolete"), "{broken");
    expect(await probe.extensions("openai.chatgpt")).toHaveLength(4);
  });

  it("finds no extension without a home folder or extension folders", async () => {
    expect(await new NodeToolProbe({ env: envWith("") }).extensions("openai.chatgpt")).toEqual([]);
    const homeless = new NodeToolProbe({ env: { PATH: "" } });
    expect(await homeless.extensions("openai.chatgpt")).toEqual([]);
  });
});
