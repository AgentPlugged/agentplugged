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
  resolveValidationSettings,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { parseMethodConfig } from "../init/method-config.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

/** The points the creator keeps, recorded in `method.yaml`, read on the main branch. */

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const CONFIG = ".agentplugged/method.yaml";

function setup() {
  const files = new MemoryFiles();
  const keys = new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(4)));
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

describe("the points the creator keeps, in method.yaml", () => {
  it("are recorded by init when the creator chose them, in the catalog's order, and never replaced by a later init", async () => {
    const { files, human } = setup();
    const first = await initCommand.run(human, {
      profile: resolveProfile("new-product"),
      points: ["release", "framing"],
    });
    expect(first.ok && first.value.points).toEqual(["framing", "release"]);
    expect(parse(files.files.get(CONFIG) as string).validation).toEqual({
      points: ["framing", "release"],
    });
    // `profile` is the command that changes them: init keeps what is recorded.
    const again = await initCommand.run(human, { points: ["merge"] });
    expect(again.ok && again.value.points).toEqual(["framing", "release"]);
  });

  it("are absent when nothing was chosen: every point waits for the creator", async () => {
    const { files, human } = setup();
    const result = await initCommand.run(human, { profile: resolveProfile("new-product") });
    expect(result.ok && result.value.points).toBeUndefined();
    expect(parse(files.files.get(CONFIG) as string).validation).toBeUndefined();
    const state = await readProfile(files);
    expect(state instanceof Error ? undefined : state.points).toBeUndefined();
    const settings = await resolveValidationSettings(
      parseMethodConfig(files.files.get(CONFIG) as string) as never,
      undefined,
    );
    expect(settings.points).toBeUndefined();
  });

  it("can be empty: the creator keeps none, the agents decide every point", async () => {
    const { files, human } = setup();
    await initCommand.run(human, { profile: resolveProfile("new-product") });
    const changed = await profileCommand.run(human, { points: [] });
    expect(changed.ok && (changed.value as ProfileResult).action).toBe("updated");
    expect(parse(files.files.get(CONFIG) as string).validation).toEqual({ points: [] });
    const state = await readProfile(files);
    expect(state instanceof Error ? undefined : state.points).toEqual([]);
  });

  it("refuses a point that does not exist, or twice the same, writing nothing", async () => {
    const { files, human } = setup();
    await initCommand.run(human, { profile: resolveProfile("new-product") });
    const before = files.files.get(CONFIG);
    for (const points of [["framing", "nothing"], ["merge", "merge"], "merge"]) {
      const refused = await profileCommand.run(human, { points });
      expect(refused.ok ? undefined : refused.error.code, JSON.stringify(points)).toBe(
        ErrorCode.METHOD_CONFIG_INVALID,
      );
    }
    expect(files.files.get(CONFIG)).toBe(before);
  });

  it("are changed by profile alone, the profile and the level left as they were", async () => {
    const { files, human } = setup();
    await initCommand.run(human, { profile: resolveProfile("new-product"), validation: "strict" });
    const profileBefore = parse(files.files.get(CONFIG) as string).profile;
    const changed = await profileCommand.run(human, { points: ["architecture", "merge"] });
    expect(changed.ok && (changed.value as ProfileResult).points).toEqual({
      points: ["architecture", "merge"],
      previous: undefined,
    });
    const written = parse(files.files.get(CONFIG) as string);
    expect(written.validation).toEqual({ mode: "strict", points: ["architecture", "merge"] });
    expect(written.profile).toEqual(profileBefore);
    // The same set again, in another order, changes nothing.
    const same = await profileCommand.run(human, { points: ["merge", "architecture"] });
    expect(same.ok && (same.value as ProfileResult).action).toBe("unchanged");
    // A level changed alone keeps the points.
    await profileCommand.run(human, { validation: "chat" });
    expect(parse(files.files.get(CONFIG) as string).validation).toEqual({
      mode: "chat",
      points: ["architecture", "merge"],
    });
  });

  it("are read on the main branch before the working copy, and an unreadable section keeps them all", async () => {
    const { files, human } = setup();
    await initCommand.run(human, { profile: resolveProfile("new-product"), points: ["framing"] });
    const working = parseMethodConfig(files.files.get(CONFIG) as string) as never;
    const reader = (text: string | undefined) => ({
      read: async () => ({ found: true as const, branch: "origin/main", text }),
    });
    // The main branch wins: an agent cannot widen the delegation on its own branch.
    const main = await resolveValidationSettings(
      working,
      reader("validation:\n  points: [merge, release]\n"),
    );
    expect(main).toMatchObject({ points: ["merge", "release"], source: "main" });
    // The main branch has none: the creator has not chosen there.
    const none = await resolveValidationSettings(working, reader("format_version: 2\n"));
    expect(none.points).toBeUndefined();
    // A damaged section there is strict, and every point waits for the creator.
    const broken = await resolveValidationSettings(
      working,
      reader("validation:\n  points: [nothing]\n"),
    );
    expect(broken).toMatchObject({ mode: "strict", points: undefined });
  });
});

describe("the points asked in the chat", () => {
  async function chat() {
    const { files, human, journal } = setup();
    await initCommand.run(human, { profile: resolveProfile("new-product") });
    const synced = await syncCommand.run(human, {});
    expect(synced.ok).toBe(true);
    const agent: CommandContext = {
      ...human,
      actor: "agent",
      session: new AgentSession(Date.now()),
    };
    return { files, journal, agent, registry: createCommandRegistry() };
  }

  it("is a request of the profile action, approved by the creator, carried out by the engine", async () => {
    const { files, journal, agent, registry } = await chat();
    const asked = await registry.run("request_creator_action", agent, {
      agent: "main",
      action: { kind: "profile", points: ["framing", "architecture", "release", "publication"] },
      reason: "I do not want to be asked about the merges any more",
    });
    expect(asked.ok).toBe(true);
    const value = (asked as { value: { checkpoint: string; risk: string } }).value;
    // The creator keeps fewer points than every one: more is left to the agents, a lowering.
    expect(value.risk).toBe("high");
    const opened = (await journal.list()).events.at(-1);
    expect(opened?.payload).toMatchObject({
      title: "Choose the points of validation: framing, architecture, release, publication",
      creator_action: {
        kind: "profile",
        points: ["framing", "architecture", "release", "publication"],
      },
    });
    expect(files.files.get(CONFIG)).not.toContain("points:");
    const approved = await registry.run("answer_checkpoint", agent, {
      agent: "main",
      checkpoint: value.checkpoint,
      decision: "approved",
      quote: "oui, ne me demande plus les fusions",
    });
    expect(approved.ok).toBe(true);
    expect((approved as { value: AnswerRecorded }).value.executed).toMatchObject({
      kind: "profile",
      files: { changed: true },
    });
    expect(parse(files.files.get(CONFIG) as string).validation).toEqual({
      points: ["framing", "architecture", "release", "publication"],
    });
    const again = await registry.run("request_creator_action", agent, {
      agent: "main",
      action: { kind: "profile", points: ["publication", "framing", "release", "architecture"] },
      reason: "again",
    });
    expect(again.ok ? undefined : again.error.code).toBe(ErrorCode.CREATOR_ACTION_UNCHANGED);
  });

  it("is a medium risk when the creator keeps more than before", async () => {
    const { files, agent, registry } = await chat();
    const text = files.files.get(CONFIG) as string;
    await files.writeText(CONFIG, `${text}validation:\n  points: [framing]\n`);
    const asked = await registry.run("request_creator_action", agent, {
      agent: "main",
      action: { kind: "profile", points: ["framing", "merge"] },
      reason: "I want to validate the merges",
    });
    expect((asked as { value: { risk: string } }).value.risk).toBe("medium");
  });

  it("is refused for a point that does not exist", async () => {
    const { agent, registry } = await chat();
    const refused = await registry.run("request_creator_action", agent, {
      agent: "main",
      action: { kind: "profile", points: ["everything"] },
      reason: "x",
    });
    expect(refused.ok ? undefined : refused.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });
});
