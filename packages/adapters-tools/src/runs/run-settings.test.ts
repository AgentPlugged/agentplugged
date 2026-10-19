import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createToolAdapter } from "./adapter.js";
import { claudeCodeTranslator } from "./claude-code.js";
import { runSettingsDir, sweepRunSettings, writeRunSettings } from "./run-settings.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const base = () => {
  const root = mkdtempSync(join(tmpdir(), "ap-settings-"));
  roots.push(root);
  return root;
};

describe("the settings file of a launch", () => {
  it("is written for the user alone, in a folder of its own, and removed on request", () => {
    const root = base();
    const file = writeRunSettings('{"permissions":{}}', root);
    expect(file.path.startsWith(runSettingsDir(root))).toBe(true);
    expect(readFileSync(file.path, "utf8")).toBe('{"permissions":{}}');
    if (process.platform !== "win32") expect(statSync(file.path).mode & 0o077).toBe(0);
    file.remove();
    file.remove();
    expect(existsSync(file.path)).toBe(false);
  });

  it("is swept at the start of the bridge when a cut left one behind, and nothing else is touched", () => {
    const root = base();
    const left = writeRunSettings("{}", root);
    const other = join(runSettingsDir(root), "keep.txt");
    writeFileSync(other, "mine");
    sweepRunSettings(root);
    expect(existsSync(left.path)).toBe(false);
    expect(existsSync(other)).toBe(true);
    // No folder at all: nothing to do, nothing thrown.
    sweepRunSettings(join(root, "nowhere"));
  });

  it("is given to the program as --settings for one launch and gone when the launch ends", async () => {
    const root = base();
    const script = join(root, "tool.cjs");
    // Stands for the program: it reads the file it was given and says how many rules it holds.
    writeFileSync(
      script,
      `const fs = require("node:fs");
const path = process.argv[process.argv.indexOf("--settings") + 1];
const rules = JSON.parse(fs.readFileSync(path, "utf8")).permissions;
globalThis.__path = path;
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: path + "|" + rules.allow.length + "|" + rules.deny.length }) + "\\n");
`,
    );
    const adapter = createToolAdapter({
      translator: claudeCodeTranslator,
      launcher: { file: process.execPath, prefixArgs: [script] },
      env: {},
    });
    const allow = Array.from({ length: 5000 }, (_, i) => `Bash(tool-${i} run*)`);
    const result = await adapter.start({
      cwd: root,
      prompt: "x",
      permissions: { level: "edit", projectRules: { allow, deny: ["Edit(/x/**)"] } },
    }).done;
    const [path, allowed, denied] = (result.text ?? "").split("|");
    expect(result.outcome).toBe("completed");
    expect([allowed, denied]).toEqual(["5000", "1"]);
    expect(existsSync(path ?? "")).toBe(false);
  });
});
