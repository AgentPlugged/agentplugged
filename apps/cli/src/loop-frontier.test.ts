import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_TYPE_REGISTRY, LOOP_EVENT_TYPES } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";

/**
 * The line between the engine and what runs outside it (the creator's
 * word of 2026-10-09): the loop works while a session of the tool is open. What goes on without a
 * session (resuming, the night, several machines, a notice on the phone) is outside this engine,
 * which holds none of it, only events any reader may follow.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packages = join(here, "..", "..", "..", "packages");
const loopDir = join(packages, "core", "src", "loop");

/** The code of the loop, comments left out: the engine's files, its reducers and the protocol's. */
function loopCode(): Array<{ file: string; code: string }> {
  const files = readdirSync(loopDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(loopDir, name));
  files.push(
    join(packages, "core", "src", "projection", "loop-reducers.ts"),
    join(packages, "protocol", "src", "loop.ts"),
  );
  expect(files.length).toBeGreaterThanOrEqual(4);
  return files.map((file) => ({
    file,
    code: readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1"),
  }));
}

describe("the loop holds nothing of what runs outside the engine", () => {
  it("starts nothing by itself: no timer, no schedule, no process, no network", () => {
    const forbidden =
      /\b(setInterval|setTimeout|setImmediate|cron|schedule|child_process|spawn|execFile|fetch|XMLHttpRequest|WebSocket|http|https|net|dgram|worker_threads)\b/i;
    for (const { file, code } of loopCode()) {
      const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
      for (const source of imports) {
        expect(source, file).not.toMatch(
          /^node:(child_process|http|https|net|dgram|worker_threads)/,
        );
      }
      expect(code, file).not.toMatch(forbidden);
    }
  });

  it("notifies nobody: nothing about the phone, a push, a mail, a night or another machine", () => {
    const forbidden =
      /\b(notif\w*|push (notice|message)|webhook|sms|e-?mail|phone|mobile|overnight|nightly|night|relay|bridge|machine:\w*|other machine|cloud)\b/i;
    for (const { file, code } of loopCode()) {
      expect(code, file).not.toMatch(forbidden);
    }
  });

  it("reads and writes the journal like any other command: three ordinary events, nothing else", () => {
    expect(Object.values(LOOP_EVENT_TYPES).sort()).toEqual([
      "loop.resumed",
      "loop.stopped",
      "story.attempt_recorded",
    ]);
    for (const type of Object.values(LOOP_EVENT_TYPES)) {
      expect(EVENT_TYPE_REGISTRY[type], type).toMatchObject({ version: 1 });
      expect(EVENT_TYPE_REGISTRY[type]?.sensitive, type).toBeUndefined();
    }
  });
});
