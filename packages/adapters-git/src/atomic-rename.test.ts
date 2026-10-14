import { AgentPluggedError } from "@agentplugged/core";
import { describe, expect, it } from "vitest";
import { renameWithRetry } from "./atomic-rename.js";

const failing = (code: string, times: number) => {
  const calls: Array<[string, string]> = [];
  const move = async (from: string, to: string) => {
    calls.push([from, to]);
    if (calls.length <= times) throw Object.assign(new Error(`${code}: held`), { code });
  };
  return { calls, move };
};

describe("renameWithRetry", () => {
  it("tries again on Windows when the file is held, with growing pauses, then succeeds", async () => {
    const { calls, move } = failing("EPERM", 2);
    const pauses: number[] = [];
    await renameWithRetry("a.tmp", "a", {
      rename: move,
      platform: "win32",
      wait: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(calls).toHaveLength(3);
    expect(pauses).toHaveLength(2);
    expect(pauses[1]).toBeGreaterThan(pauses[0] ?? 0);
  });

  it("gives up within about two seconds with an error that names the file", async () => {
    const { calls, move } = failing("EBUSY", Number.POSITIVE_INFINITY);
    let waited = 0;
    const error = await renameWithRetry("dir/SKILL.md.tmp", "dir/SKILL.md", {
      rename: move,
      platform: "win32",
      wait: async (ms) => {
        waited += ms;
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentPluggedError);
    expect((error as AgentPluggedError).message_key).toBe("error.file_in_use");
    expect((error as AgentPluggedError).details).toMatchObject({ path: "dir/SKILL.md" });
    expect(waited).toBeLessThanOrEqual(2_000);
    expect(calls.length).toBeGreaterThan(2);
  });

  it("does not retry on another system, nor on another error", async () => {
    const linux = failing("EPERM", Number.POSITIVE_INFINITY);
    await expect(
      renameWithRetry("a.tmp", "a", { rename: linux.move, platform: "linux" }),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(linux.calls).toHaveLength(1);
    const missing = failing("ENOENT", Number.POSITIVE_INFINITY);
    await expect(
      renameWithRetry("a.tmp", "a", { rename: missing.move, platform: "win32" }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(missing.calls).toHaveLength(1);
  });
});
