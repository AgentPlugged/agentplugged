import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NodeChatLog } from "./node-chat-log.js";

const folders: string[] = [];
afterAll(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DIGEST = "a".repeat(64);
const line = (extra: Record<string, unknown>) =>
  `${JSON.stringify({
    v: 1,
    session: "s",
    at: "2026-10-08T10:00:00.000Z",
    digest: DIGEST,
    text: "oui",
    ...extra,
  })}\n`;

describe("NodeChatLog.hasMessageFrom", () => {
  it("finds a message of that tool for that project, whatever the separators and the case", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentplugged-chat-from-"));
    folders.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "one.jsonl"),
      `${line({ project: "C:\\Users\\Ada\\demo", via: "cursor" })}{"cut`,
    );
    writeFileSync(join(dir, "two.jsonl"), line({ project: "C:\\Users\\Ada\\other", via: "codex" }));
    writeFileSync(join(dir, "three.jsonl"), line({ project: "C:\\Users\\Ada\\demo" }));
    const log = new NodeChatLog({ dir });
    expect(await log.hasMessageFrom("c:/users/ada/demo/", "cursor")).toBe(true);
    // Another tool, another project, or a line with no tool: not this tool's message.
    expect(await log.hasMessageFrom("C:\\Users\\Ada\\demo", "codex")).toBe(false);
    expect(await log.hasMessageFrom("C:\\Users\\Ada\\other", "codex")).toBe(true);
    expect(await new NodeChatLog({ dir: join(dir, "missing") }).hasMessageFrom("x", "codex")).toBe(
      false,
    );
  });
});
