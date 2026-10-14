import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeToolQuestions,
  questionsDigest,
  renderDecisionHookScript,
} from "@agentplugged/core";
import { sha256Hex } from "@agentplugged/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeDecisionLog } from "./node-decision-log.js";

/**
 * What Claude Code 2.1.289 gave a `PostToolUse` hook for `AskUserQuestion`, recorded by a hook of
 * our own in a real session (`claude -p` driven through its stream-json protocol, the creator's
 * answer given as the SDK's `canUseTool` answer, 2026-10-05). Only the paths are shortened.
 */
const REAL_POST = {
  session_id: "2bd84d05-6f48-479c-9948-d3df7ebf8a93",
  transcript_path: "C:\\Users\\x\\.claude\\projects\\p\\2bd84d05-6f48-479c-9948-d3df7ebf8a93.jsonl",
  cwd: "C:\\work\\shop",
  prompt_id: "6b468459-2263-4319-b380-5063167f9717",
  permission_mode: "default",
  hook_event_name: "PostToolUse",
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: [
      {
        question: "Quelle couleur ?",
        header: "Couleur",
        options: [
          { label: "Rouge (Recommandé)", description: "chaud" },
          { label: "Bleu", description: "froid" },
        ],
        multiSelect: false,
      },
    ],
    answers: { "Quelle couleur ?": "Bleu" },
  },
  tool_response: {
    questions: [
      {
        question: "Quelle couleur ?",
        header: "Couleur",
        options: [
          { label: "Rouge (Recommandé)", description: "chaud" },
          { label: "Bleu", description: "froid" },
        ],
        multiSelect: false,
      },
    ],
    answers: { "Quelle couleur ?": "Bleu" },
  },
  tool_use_id: "toolu_01QLGU7VmWv66gUP9d7gmcKx",
  duration_ms: 0,
};

/** What the same hook got before the tool ran (`PreToolUse`): the call as the agent made it. */
const REAL_PRE = {
  ...REAL_POST,
  hook_event_name: "PreToolUse",
  tool_input: { questions: REAL_POST.tool_input.questions },
  tool_response: undefined,
  duration_ms: undefined,
};

let folder: string;
let script: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "agentplugged-decision-"));
  script = join(folder, "agentplugged-decision.mjs");
  writeFileSync(script, renderDecisionHookScript());
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** Runs the script as Claude Code does: the payload on its standard input, a home of its own. */
function run(
  payload: unknown,
  env: Record<string, string> = {},
): { home: string; stdout: string; lines: Record<string, unknown>[] } {
  const home = mkdtempSync(join(folder, "home-"));
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PROJECT_DIR: "C:\\work\\shop",
      ...env,
    },
  });
  expect(result.status).toBe(0);
  const dir = join(home, ".agentplugged", "chat");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".decisions.jsonl"));
  } catch {
    files = [];
  }
  const lines = files.flatMap((name) =>
    readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
  return { home, stdout: result.stdout, lines };
}

describe("the question tool's hook", () => {
  it("records the creator's answer of a real PostToolUse payload, with the fingerprint of the questions", () => {
    const { lines, stdout } = run(REAL_POST);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      v: 1,
      session: REAL_POST.session_id,
      project: "C:\\work\\shop",
      answers: [{ question: "Quelle couleur ?", answer: "Bleu" }],
    });
    expect(line?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The script and the engine agree on what the questions are.
    expect(line?.fingerprint).toBe(
      questionsDigest(normalizeToolQuestions(REAL_POST.tool_input.questions) ?? []),
    );
    // It tells the agent what to do next: the session id, never the answer itself.
    const output = JSON.parse(stdout) as { hookSpecificOutput: Record<string, string> };
    expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(output.hookSpecificOutput.additionalContext).toContain(
      `agentplugged chat session: ${REAL_POST.session_id}`,
    );
    expect(output.hookSpecificOutput.additionalContext).not.toContain("Bleu");
  });

  it("agrees with the engine on the fingerprint whatever the order of the keys and the extra fields", () => {
    const questions = [
      {
        extra: true,
        options: [{ description: "d1", label: "A", preview: "ignored" }, { label: "B" }],
        multiSelect: true,
        question: "Pick ?",
        header: "H",
      },
      { question: "Second ?", header: "S", options: [{ label: "Y", description: "y" }] },
    ];
    const { lines } = run({
      ...REAL_POST,
      tool_input: { questions, answers: { "Pick ?": "A, B", "Second ?": "Y" } },
      tool_response: { answers: { "Pick ?": "A, B", "Second ?": "Y" } },
    });
    expect(lines[0]?.fingerprint).toBe(questionsDigest(normalizeToolQuestions(questions) ?? []));
    expect(lines[0]?.answers).toEqual([
      { question: "Pick ?", answer: "A, B" },
      { question: "Second ?", answer: "Y" },
    ]);
  });

  it("records the creator's own words and the notes the tool gives, and skips a question left unanswered", () => {
    const { lines } = run({
      ...REAL_POST,
      tool_input: {
        questions: [
          { question: "One ?", header: "1", options: [], multiSelect: false },
          { question: "Two ?", header: "2", options: [], multiSelect: false },
        ],
      },
      tool_response: {
        answers: { "One ?": "my own words", "Two ?": "" },
        annotations: { "One ?": { notes: "because" } },
      },
    });
    expect(lines[0]?.answers).toEqual([
      { question: "One ?", answer: "my own words", notes: "because" },
    ]);
  });

  it("takes the answers of what the tool returned only, never of the call's own input", () => {
    // An answer written in the call (the agent's) is no answer, whatever the response holds.
    expect(run({ ...REAL_POST, tool_response: "done" }).lines).toEqual([]);
    expect(run({ ...REAL_POST, tool_response: { questions: [] } }).lines).toEqual([]);
  });

  it("records nothing for a dialog the tool closed by itself or left half answered", () => {
    for (const extra of [{ afkTimeoutMs: 30000 }, { followUp: true }, { response: "wait" }]) {
      const response = { ...REAL_POST.tool_response, ...extra };
      expect(run({ ...REAL_POST, tool_response: response }).lines, JSON.stringify(extra)).toEqual(
        [],
      );
    }
  });

  it("flags a call that carries fields the fingerprint does not cover, and still records it", () => {
    const questions = [
      {
        ...REAL_POST.tool_input.questions[0],
        options: [
          { label: "Rouge", description: "chaud", preview: "a fake box of the engine" },
          { label: "Bleu", description: "froid" },
        ],
      },
    ];
    const { lines } = run({
      ...REAL_POST,
      tool_input: { questions },
      tool_response: { answers: { "Quelle couleur ?": "Bleu" } },
    });
    expect(lines[0]).toMatchObject({ extra: true });
    // The same questions without it carry no flag.
    expect(run(REAL_POST).lines[0]).not.toHaveProperty("extra");
    const withKind = run({
      ...REAL_POST,
      tool_input: { questions: [{ ...REAL_POST.tool_input.questions[0], kind: "text" }] },
    });
    expect(withKind.lines[0]).toMatchObject({ extra: true });
  });

  it("records nothing when the creator did not answer: no answers, a headless run, another tool", () => {
    const refused = {
      ...REAL_POST,
      tool_input: { questions: REAL_POST.tool_input.questions },
      tool_response: { questions: REAL_POST.tool_input.questions },
    };
    expect(run(refused).lines).toEqual([]);
    expect(run(REAL_POST, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }).lines).toEqual([]);
    expect(run({ ...REAL_POST, tool_name: "Bash" }).lines).toEqual([]);
    expect(run({ ...REAL_POST, session_id: "" }).lines).toEqual([]);
    expect(run({ ...REAL_POST, tool_input: { questions: "nope", answers: {} } }).lines).toEqual([]);
    // A session with a person at it (the extension of VS Code) is recorded.
    expect(run(REAL_POST, { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }).lines).toHaveLength(1);
  });

  it("refuses, before the tool runs, a call that carries the answers itself", () => {
    expect(run(REAL_PRE).stdout).toBe("");
    for (const toolInput of [
      { ...REAL_PRE.tool_input, answers: { "Quelle couleur ?": "Bleu" } },
      { ...REAL_PRE.tool_input, annotations: {} },
    ]) {
      const refused = run({ ...REAL_PRE, tool_input: toolInput });
      const output = JSON.parse(refused.stdout) as {
        hookSpecificOutput: { hookEventName: string; permissionDecision: string };
      };
      expect(output.hookSpecificOutput).toMatchObject({
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      });
      expect(refused.lines).toEqual([]);
    }
  });

  it("never blocks the tool on a failure: garbage in, nothing recorded, exit 0", () => {
    const home = mkdtempSync(join(folder, "home-"));
    const result = spawnSync(process.execPath, [script], {
      input: "not json",
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("keeps the store for a day: a line older than that is pruned when the next one is written", () => {
    const home = mkdtempSync(join(folder, "home-"));
    const dir = join(home, ".agentplugged", "chat");
    mkdirSync(dir, { recursive: true });
    const first = spawnSync(process.execPath, [script], {
      input: JSON.stringify(REAL_POST),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        USERPROFILE: home,
        CLAUDE_PROJECT_DIR: "/p",
      },
    });
    expect(first.status).toBe(0);
    const [name] = readdirSync(dir);
    const old = JSON.stringify({
      v: 1,
      at: "2020-01-01T00:00:00.000Z",
      fingerprint: "a".repeat(64),
    });
    writeFileSync(
      join(dir, name as string),
      `${old}\n${readFileSync(join(dir, name as string), "utf8")}`,
    );
    spawnSync(process.execPath, [script], {
      input: JSON.stringify(REAL_POST),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        USERPROFILE: home,
        CLAUDE_PROJECT_DIR: "/p",
      },
    });
    const kept = readFileSync(join(dir, name as string), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(kept).toHaveLength(2);
    expect(kept.some((line) => line.includes("2020-01-01"))).toBe(false);
  });
});

describe("NodeDecisionLog reads what the hook wrote", () => {
  /** Runs the script in a home folder, then reads that home's store as the engine does. */
  const readBack = async (payload: unknown, session: string, env: Record<string, string> = {}) => {
    const { home } = run(payload, env);
    return new NodeDecisionLog({ dir: join(home, ".agentplugged", "chat") }).records(session);
  };

  it("gives the record of a session, with the fingerprint the engine computes", async () => {
    const records = await readBack(REAL_POST, REAL_POST.session_id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      session: REAL_POST.session_id,
      project: String.raw`C:\work\shop`,
      fingerprint: questionsDigest(normalizeToolQuestions(REAL_POST.tool_input.questions) ?? []),
      answers: [{ question: "Quelle couleur ?", answer: "Bleu" }],
    });
  });

  it("gives nothing for another session, a missing store, or lines it cannot read", async () => {
    expect(await readBack(REAL_POST, "another-session")).toEqual([]);
    expect(await new NodeDecisionLog({ dir: join(folder, "nowhere") }).records("x")).toEqual([]);
    const home = mkdtempSync(join(folder, "home-"));
    const dir = join(home, ".agentplugged", "chat");
    mkdirSync(dir, { recursive: true });
    const log = new NodeDecisionLog({ dir });
    const session = "s-1";
    const name = `${sha256Hex(session).slice(0, 32)}.decisions.jsonl`;
    const good = {
      extra: true,
      v: 1,
      session,
      at: "2026-10-05T08:00:00.000Z",
      fingerprint: "a".repeat(64),
      answers: [{ question: "Q ?", answer: "A", notes: "n" }, { question: 3 }],
    };
    writeFileSync(
      join(dir, name),
      [
        "not json",
        JSON.stringify({ ...good, v: 2 }),
        JSON.stringify({ ...good, session: "other" }),
        JSON.stringify({ ...good, at: "yesterday" }),
        JSON.stringify({ ...good, fingerprint: "short" }),
        JSON.stringify({ ...good, answers: "no" }),
        JSON.stringify(good),
        "",
      ].join("\n"),
    );
    expect(await log.records(session)).toEqual([
      {
        session,
        at: good.at,
        fingerprint: good.fingerprint,
        extra: true,
        answers: [{ question: "Q ?", answer: "A", notes: "n" }],
      },
    ]);
  });
});
