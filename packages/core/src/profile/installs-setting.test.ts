import { toBase64url } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  AgentSession,
  type AnswerRecorded,
  type CommandContext,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type ProfileResult,
  profileCommand,
  readProfile,
  resolveProfile,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const CONFIG = ".agentplugged/method.yaml";

function setup() {
  const files = new MemoryFiles();
  const keys = new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(3)));
  const journal = new MemoryStateStore({ keys });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    keys,
  };
  return { files, journal, human, keys };
}

describe("the installs mode in method.yaml", () => {
  it("is recorded by init when the creator chose one, and never replaced by a later init", async () => {
    const { files, human } = setup();
    const first = await initCommand.run(human, {
      profile: resolveProfile("new-product"),
      installs: "visible",
    });
    expect(first.ok && first.value.installs).toBe("visible");
    expect(parse(files.files.get(CONFIG) as string).installs).toEqual({ mode: "visible" });
    // `profile` is the command that changes it: init keeps what is recorded.
    const again = await initCommand.run(human, { installs: "validate" });
    expect(again.ok && again.value.installs).toBe("visible");
    expect(parse(files.files.get(CONFIG) as string).installs).toEqual({ mode: "visible" });
  });

  it("is absent when nothing was chosen: validate applies, the safe default", async () => {
    const { files, human } = setup();
    const result = await initCommand.run(human, { profile: resolveProfile("new-product") });
    expect(result.ok && result.value.installs).toBeUndefined();
    expect(parse(files.files.get(CONFIG) as string).installs).toBeUndefined();
    const state = await readProfile(files);
    expect(state).toMatchObject({ installed: true });
    expect(state instanceof Error ? undefined : state.installs).toBeUndefined();
  });

  it("refuses a mode that is neither visible nor validate, writing nothing", async () => {
    const { files, human } = setup();
    await initCommand.run(human, { profile: resolveProfile("new-product") });
    const before = files.files.get(CONFIG);
    const refused = await initCommand.run(human, { installs: "fast" });
    // An existing file keeps its settings: the question is the profile command's.
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.METHOD_CONFIG_INVALID);
    expect(files.files.get(CONFIG)).toBe(before);
    const profile = await profileCommand.run(human, { installs: "fast" });
    expect(profile.ok ? undefined : profile.error.code).toBe(ErrorCode.METHOD_CONFIG_INVALID);
    expect(files.files.get(CONFIG)).toBe(before);
  });

  it("is changed by profile alone, the profile left as it was", async () => {
    const { files, human } = setup();
    await initCommand.run(human, { profile: resolveProfile("new-product") });
    const profileBefore = parse(files.files.get(CONFIG) as string).profile;
    // The default is `visible`: the creator who wants every installation validated says so.
    const changed = await profileCommand.run(human, { installs: "validate" });
    expect(changed.ok && (changed.value as ProfileResult).action).toBe("updated");
    expect(changed.ok && (changed.value as ProfileResult).installs).toEqual({
      mode: "validate",
      previous: undefined,
    });
    const written = parse(files.files.get(CONFIG) as string);
    expect(written.installs).toEqual({ mode: "validate" });
    expect(written.profile).toEqual(profileBefore);
    // Choosing the mode already in force changes nothing; the default changes nothing either.
    const same = await profileCommand.run(human, { installs: "validate" });
    expect(same.ok && (same.value as ProfileResult).action).toBe("unchanged");
    const back = await profileCommand.run(human, { installs: "visible" });
    expect(back.ok && (back.value as ProfileResult).action).toBe("updated");
    expect(parse(files.files.get(CONFIG) as string).installs).toEqual({ mode: "visible" });
  });

  it("is kept with the validation level and the rest of the file", async () => {
    const { files, human } = setup();
    await initCommand.run(human, { profile: resolveProfile("new-product") });
    await profileCommand.run(human, { validation: "strict", installs: "validate" });
    const written = parse(files.files.get(CONFIG) as string);
    expect(written.validation).toEqual({ mode: "strict" });
    expect(written.installs).toEqual({ mode: "validate" });
    expect(written.format_version).toBe(2);
  });
});

describe("the installs mode asked in the chat", () => {
  it("is a request of the profile action, approved by the creator, carried out by the engine", async () => {
    const { files, human, journal } = setup();
    await initCommand.run(human, { profile: resolveProfile("new-product") });
    const synced = await syncCommand.run(human, {});
    expect(synced.ok).toBe(true);
    const agent: CommandContext = {
      ...human,
      actor: "agent",
      session: new AgentSession(Date.now()),
    };
    const registry = createCommandRegistry();
    const asked = await registry.run("request_creator_action", agent, {
      agent: "main",
      action: { kind: "profile", installs: "validate" },
      reason: "I want to validate each installation",
    });
    expect(asked.ok).toBe(true);
    const value = (asked as { value: { checkpoint: string; risk: string } }).value;
    // A choice of working method: a medium risk.
    expect(value.risk).toBe("medium");
    const opened = (await journal.list()).events.at(-1);
    expect(opened?.payload).toMatchObject({
      title: "Set the installs mode to validate",
      creator_action: { kind: "profile", installs: "validate" },
    });
    expect(files.files.get(CONFIG)).not.toContain("installs:");
    // Nothing happens until the creator approves; the same request is refused when already so.
    const approved = await registry.run("answer_checkpoint", agent, {
      agent: "main",
      checkpoint: value.checkpoint,
      decision: "approved",
      quote: "yes, do it",
    });
    expect(approved.ok).toBe(true);
    const executed = (approved as { value: AnswerRecorded }).value.executed;
    expect(executed).toMatchObject({ kind: "profile", files: { changed: true } });
    expect(parse(files.files.get(CONFIG) as string).installs).toEqual({ mode: "validate" });
    const again = await registry.run("request_creator_action", agent, {
      agent: "main",
      action: { kind: "profile", installs: "validate" },
      reason: "again",
    });
    expect(again.ok ? undefined : again.error.code).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
  });

  it("is refused for another value, and a profile action must change something", async () => {
    const { human } = setup();
    await initCommand.run(human, { profile: resolveProfile("new-product") });
    const agent: CommandContext = {
      ...human,
      actor: "agent",
      session: new AgentSession(Date.now()),
    };
    const registry = createCommandRegistry();
    for (const action of [{ kind: "profile", installs: "always" }, { kind: "profile" }]) {
      const refused = await registry.run("request_creator_action", agent, {
        agent: "main",
        action,
        reason: "x",
      });
      expect(refused.ok ? undefined : refused.error.code, JSON.stringify(action)).toBe(
        ErrorCode.INVALID_ARGUMENTS,
      );
    }
  });
});
