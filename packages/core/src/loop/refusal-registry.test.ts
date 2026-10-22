import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { type CommandContext, CommandRegistry, defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { nextStep } from "../next/next.js";
import { MemoryFiles } from "../testing/memory-files.js";
import {
  clearRefusals,
  FRESH_MS,
  gestureOf,
  liveRefusals,
  REFUSALS_PATH,
  REPEATED_MS,
  readRefusals,
  recordRefusal,
  repeatedGesture,
  targetOf,
} from "./refusal-registry.js";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 22, 10, minute)).toISOString();
const refusal = { action: "start_story", code: "STORY_NOT_STARTABLE", target: "1-1", reason: "k" };

describe("recordRefusal", () => {
  it("counts the same action, code, target and reason, and keeps a different cause apart", () => {
    const one = recordRefusal([], refusal, at(0));
    const two = recordRefusal(one.entries, refusal, at(1));
    expect(two.entry.count).toBe(2);
    const other = recordRefusal(two.entries, { ...refusal, reason: "another" }, at(2));
    expect(other.entry.count).toBe(1);
    expect(other.entries).toHaveLength(2);
    const elsewhere = recordRefusal(other.entries, { ...refusal, target: "1-2" }, at(3));
    expect(elsewhere.entry.count).toBe(1);
  });

  it("starts again when the earlier refusal is forgotten", () => {
    const one = recordRefusal([], refusal, at(0));
    const later = new Date(Date.parse(at(0)) + FRESH_MS + 1000).toISOString();
    expect(recordRefusal(one.entries, refusal, later).entry.count).toBe(1);
    const two = recordRefusal(one.entries, refusal, at(1));
    const much = new Date(Date.parse(at(1)) + REPEATED_MS + 1000).toISOString();
    expect(recordRefusal(two.entries, refusal, much).entry.count).toBe(1);
  });

  it("clears the keys of the same action and target on a success only", () => {
    const one = recordRefusal([], refusal, at(0));
    const two = recordRefusal(one.entries, { ...refusal, action: "update_story" }, at(1));
    expect(clearRefusals(two.entries, "start_story", "1-1").map((entry) => entry.action)).toEqual([
      "update_story",
    ]);
    expect(clearRefusals(two.entries, "start_story", "1-2")).toHaveLength(2);
  });

  it("lists the live refusals, latest first", () => {
    const one = recordRefusal([], refusal, at(0));
    const two = recordRefusal(one.entries, { ...refusal, target: "1-2" }, at(2));
    const now = Date.parse(at(3));
    expect(liveRefusals(two.entries, now).map((entry) => entry.target)).toEqual(["1-2", "1-1"]);
    expect(liveRefusals(two.entries, now + FRESH_MS)).toEqual([]);
  });
});

describe("targetOf and the gestures", () => {
  it("takes the first usual field and ignores the rest", () => {
    expect(targetOf({ story: "2-3", checkpoint: "G-1" })).toBe("2-3");
    expect(targetOf({ path: "a/b.md" })).toBe("a/b.md");
    expect(targetOf({ summary: "x" })).toBe("");
  });

  it("gives a gesture to the usual codes and says a repeat in one sentence", () => {
    expect(gestureOf(ErrorCode.CHECKPOINT_OPEN)).toContain("state.next");
    expect(gestureOf("NOT_A_CODE")).toBeUndefined();
    expect(repeatedGesture(2, undefined)).toContain("2 times");
    expect(repeatedGesture(3, "Do this.")).toContain("Do this.");
  });
});

/** A registry of one agent command that fails with the code until `fix` is called. */
function setup(code: string = ErrorCode.CHECKPOINT_OPEN) {
  const files = new MemoryFiles({ [METHOD_CONFIG_PATH]: "x" });
  let working = false;
  const registry = new CommandRegistry([
    defineCommand({
      name: "refuse",
      audience: "agent",
      async run() {
        return working
          ? ok("done")
          : fail(new AgentPluggedError(code as never, "error.checkpoint_open", { reason: "r" }));
      },
    }),
  ]);
  const context = { files, actor: "agent", engineVersion: "0.0.0" } as unknown as CommandContext;
  return { files, registry, context, fix: () => (working = true) };
}

describe("CommandRegistry and the registry of refusals", () => {
  it("tells the gesture at the first refusal and not to retry at the second", async () => {
    const { registry, context } = setup();
    const first = await registry.run("refuse", context, { story: "1-1" });
    if (first.ok) throw new Error("expected a refusal");
    expect(first.error.advice.do).toContain("state.next");
    expect(first.error.advice.repeated).toBeUndefined();
    const second = await registry.run("refuse", context, { story: "1-1" });
    if (second.ok) throw new Error("expected a refusal");
    expect(second.error.advice).toMatchObject({ repeated: 2 });
    expect(String(second.error.advice.do)).toContain("Refused 2 times");
    const other = await registry.run("refuse", context, { story: "1-2" });
    if (other.ok) throw new Error("expected a refusal");
    expect(other.error.advice.repeated).toBeUndefined();
  });

  it("forgets the refusals after a success of the same call", async () => {
    const { registry, context, files, fix } = setup();
    await registry.run("refuse", context, { story: "1-1" });
    fix();
    expect((await registry.run("refuse", context, { story: "1-1" })).ok).toBe(true);
    expect(await readRefusals(files)).toEqual([]);
    expect(files.removals).toContain(REFUSALS_PATH);
  });

  it("never counts a transient code, nor the creator's retries, nor a folder without the method", async () => {
    const busy = setup(ErrorCode.JOURNAL_BUSY);
    await busy.registry.run("refuse", busy.context, {});
    await busy.registry.run("refuse", busy.context, {});
    expect(await readRefusals(busy.files)).toEqual([]);
    const bare = setup();
    bare.files.files.delete(METHOD_CONFIG_PATH);
    await bare.registry.run("refuse", bare.context, {});
    expect(bare.files.writes).not.toContain(REFUSALS_PATH);
  });

  it("answers as before when the registry cannot be written", async () => {
    const { registry, context, files } = setup();
    files.writeText = async () => {
      throw new Error("disk full");
    };
    const result = await registry.run("refuse", context, {});
    expect(result.ok === false && result.error.code).toBe(ErrorCode.CHECKPOINT_OPEN);
  });
});

describe("state.next and the registry", () => {
  const NOW = Date.parse(at(10));
  const CONFIG = {
    domains: ["framing"],
    phases: ["framing"],
    tools: ["claude-code"],
    preferred: {},
    agents: { iris: "Iris", noah: "Noah" },
    reviewers: { qa: [], security: [] },
    existing: false,
  } as never;
  const DOCS = { kinds: [], stories: [] } as never;
  const state = (refusals: ReturnType<typeof recordRefusal>["entries"]) => ({
    projection: {},
    now: NOW,
    sync: { fresh: true } as never,
    refusals,
  });

  it("says the latest refusal with its gesture, and change_method from the second", () => {
    const named = { ...refusal, code: ErrorCode.CHECKPOINT_OPEN };
    const one = recordRefusal([], named, at(8));
    const told = nextStep(state(one.entries), DOCS, CONFIG);
    expect(told.refused).toMatchObject({
      action: "start_story",
      code: "CHECKPOINT_OPEN",
      times: 1,
    });
    expect(told.refused?.do).toContain("state.next");
    expect(told.change_method).toBeUndefined();
    const two = recordRefusal(one.entries, named, at(9));
    const again = nextStep(state(two.entries), DOCS, CONFIG);
    expect(again.refused?.times).toBe(2);
    expect(again.change_method).toMatchObject({ cause: "action", times: 2 });
    expect(again.change_method?.what).toContain("start_story");
  });

  it("says nothing of a refusal forgotten, nor without any", () => {
    const old = recordRefusal([], refusal, at(0));
    expect(nextStep(state(old.entries), DOCS, CONFIG).refused).toBeUndefined();
    expect(nextStep(state([]), DOCS, CONFIG).refused).toBeUndefined();
  });
});
