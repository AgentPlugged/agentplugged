import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalAgent, EvalAgentOutcome, EvalAgentRequest } from "@agentplugged/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./main.js";

/**
 * With a fake agent: never the real tool, never a
 * token. `check` is free; `run` says its plan first, notes with the judge's closed format, keeps a
 * pass as the reference on request and exits with 1 on a regression of quality or of cost.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SKILL = `---
name: pricing-check
description: Price an offer step by step with the creator, from the costs they know.
---
# Pricing

- **Output:** a short note with the chosen price and its reasoning, in docs/pricing.md
- Never invent a cost: ask the creator for it.
`;

const CASES = `
cases:
  - id: write-note
    input: "Price my coaching offer: 3 sessions, 300 euros"
    rubric:
      - "The note names the 300 euros price and the 3 sessions"
    checks:
      - { kind: file_has, path: docs/pricing.md, text: "300" }
triggers:
  - { query: "help me price my coaching offer", should_trigger: true }
  - { query: "write the product brief from my idea", should_trigger: false }
`;

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-evalflow-"));
  await mkdir(join(cwd, ".agentplugged/skills/pricing-check/evals"), { recursive: true });
  await writeFile(join(cwd, ".agentplugged/method.yaml"), "x: 1\n");
  await writeFile(join(cwd, ".agentplugged/skills/pricing-check/SKILL.md"), SKILL);
  await writeFile(join(cwd, ".agentplugged/skills/pricing-check/evals/cases.yaml"), CASES);
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** An agent that writes the note, costs what it is told, and is judged as it is told. */
class Fake implements EvalAgent {
  readonly tool = "claude-code";
  readonly skillDir = ".claude/skills";
  readonly requests: EvalAgentRequest[] = [];
  cost: number | null = 10_000;
  writes = true;
  passes = true;
  usable = true;
  model: string | undefined;
  fires: (query: string) => boolean = (query) => query.includes("price");
  async available() {
    return this.usable ? { ok: true } : { ok: false, detail: "claude is not on the path" };
  }
  async run(request: EvalAgentRequest): Promise<EvalAgentOutcome> {
    this.requests.push(request);
    if (request.role === "judge") {
      const verdict = {
        n: 1,
        passed: this.passes,
        evidence: this.passes ? 'the note says "300 euros"' : "the price is missing",
      };
      return {
        status: "done",
        transcript: JSON.stringify({
          type: "result",
          result: JSON.stringify({ verdicts: [verdict] }),
          usage: { input_tokens: 400, output_tokens: 50 },
        }),
        produced: [],
        ms: 1,
      };
    }
    // A query that must call the skill loads it (the run is cut there); the others are left alone.
    const loads = request.stopWhen !== undefined && this.fires(request.prompt);
    return {
      status: loads ? "stopped" : "done",
      transcript: JSON.stringify({
        type: "result",
        result: 'The price is 300 euros for 3 sessions: the note says "300 euros".',
        ...(this.cost === null
          ? {}
          : this.model === undefined
            ? { usage: { input_tokens: this.cost, output_tokens: 0 } }
            : { modelUsage: { [this.model]: { inputTokens: this.cost, outputTokens: 0 } } }),
      }),
      produced: this.writes ? [{ path: "docs/pricing.md", text: "# Price\n300 euros" }] : [],
      ms: 1,
    };
  }
}

async function eval_(args: string[], agent?: EvalAgent) {
  let stdout = "";
  let stderr = "";
  const status = await main({
    argv: ["eval", ...args],
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    engineVersion: "0.1.0",
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    interactive: false,
    ...(agent === undefined ? {} : { evalAgent: agent }),
  });
  return { status, stdout, stderr };
}

describe("eval check: free, no agent", () => {
  it("counts the cases, checks them against the words of the description and says the pass kept", async () => {
    const result = await eval_(["check", "pricing-check"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("pricing-check: 1 cases, 2 queries");
    expect(result.stdout).toContain("every query goes where expected");
    expect(result.stdout).toContain("no pass kept yet");
    expect((await eval_(["check"])).stdout).toContain("pricing-check: 1 cases");
  });

  it("exits with 1 on a file that cannot be used, and lists everything wrong", async () => {
    await writeFile(
      join(cwd, ".agentplugged/skills/pricing-check/evals/cases.yaml"),
      "cases:\n  - { id: a, input: 'TODO: a request', rubric: ['a fact the note must hold'] }\n  - { id: a, input: 'a second request', rubric: ['another fact held here'] }\n",
    );
    const result = await eval_(["check", "pricing-check"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("problem cases.0.input");
    expect(result.stdout).toContain("used twice");
  });

  it("exits with 2 for a skill that does not exist, and with 2 for an option it does not know", async () => {
    expect((await eval_(["check", "nothing"])).status).toBe(2);
    const bad = await eval_(["check", "--wat"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("Usage: agentplugged eval");
  });

  it("checks the shipped skills' cases: valid, and called by the words of their descriptions", async () => {
    const result = await eval_(["check", "--method"]);
    expect(result.status, result.stdout).toBe(0);
    for (const skill of ["develop-story", "review-story", "write-prd", "round-table"]) {
      expect(result.stdout, skill).toContain(`${skill}: `);
    }
    expect(result.stdout).not.toContain("do not go where expected");
    expect(result.stdout).not.toContain("problem ");
  });
});

describe("eval init: cases to start from, never over a file", () => {
  it("writes the proposal once for a skill that has none", async () => {
    await rm(join(cwd, ".agentplugged/skills/pricing-check/evals"), { recursive: true });
    const first = await eval_(["init", "pricing-check"]);
    expect(first.status, first.stderr).toBe(0);
    const text = await readFile(
      join(cwd, ".agentplugged/skills/pricing-check/evals/cases.yaml"),
      "utf8",
    );
    expect(text).toContain("should_trigger: false");
    expect(text).toContain("TODO");
    expect((await eval_(["check", "pricing-check"])).status).toBe(1);
    const again = await eval_(["init", "pricing-check"]);
    expect(again.stdout).toContain("already exists");
    expect(
      await readFile(join(cwd, ".agentplugged/skills/pricing-check/evals/cases.yaml"), "utf8"),
    ).toBe(text);
  });

  it("does not write into the method shipped, unless asked from its own repository", async () => {
    const result = await eval_(["init", "write-brief"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("read-only");
  });
});

describe("eval run: the plan first, a real agent, the reference", () => {
  it("says the plan and runs nothing with --plan", async () => {
    const agent = new Fake();
    const result = await eval_(["run", "pricing-check", "--plan", "--runs", "2"], agent);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "2 run(s) of each case: 2 runs of the agent and 2 of the judge. This uses tokens.",
    );
    expect(agent.requests).toEqual([]);
  });

  it("counts only what will run: the cases asked for, one side of the split", async () => {
    const agent = new Fake();
    const plan = (args: string[]) => eval_(["run", "pricing-check", "--plan", ...args], agent);
    expect((await plan(["--mode", "trigger"])).stdout).toContain(
      "2 runs of the agent and 0 of the judge",
    );
    // One query on each side: both train, the held-out half is empty.
    expect((await plan(["--mode", "trigger", "--set", "train"])).stdout).toContain(
      "2 runs of the agent",
    );
    expect((await plan(["--mode", "trigger", "--set", "test"])).stdout).toContain(
      "0 runs of the agent",
    );
    expect((await plan(["--case", "nothing"])).stdout).toContain(
      "0 runs of the agent and 0 of the judge",
    );
  });

  it("refuses a plan above the limit, and an agent that cannot be run", async () => {
    const agent = new Fake();
    const many = await eval_(
      ["run", "pricing-check", "--mode", "trigger", "--runs", "10", "--max-calls", "5"],
      agent,
    );
    expect(many.status).toBe(2);
    expect(many.stderr).toContain("the limit is 5");
    expect(agent.requests).toEqual([]);
    agent.usable = false;
    const away = await eval_(["run", "pricing-check"], agent);
    expect(away.status).toBe(2);
    expect(away.stderr).toContain("claude is not on the path");
  });

  it("notes the case, counts the tokens, keeps the pass on request and compares the next one", async () => {
    const agent = new Fake();
    const first = await eval_(["run", "pricing-check", "--record"], agent);
    expect(first.status, first.stderr + first.stdout).toBe(0);
    expect(first.stdout).toContain("skill · write-note: pass rate 1 over 1 run(s), 10 000 tokens");
    expect(first.stdout).toContain("the judge used 450 tokens");
    expect(first.stdout).toContain("Pass kept as the reference");
    const reference = JSON.parse(
      await readFile(join(cwd, ".agentplugged/skills/pricing-check/evals/reference.json"), "utf8"),
    );
    expect(reference.cases["write-note"]).toMatchObject({
      pass_rate: 1,
      tokens: 10_000,
      measured: 1,
    });
    // The same again: no regression.
    const same = await eval_(["run", "pricing-check"], agent);
    expect(same.status).toBe(0);
    expect(same.stdout).toContain("No regression.");
    // The skill got heavier: +50 % and well over the floor.
    agent.cost = 15_000;
    const costly = await eval_(["run", "pricing-check"], agent);
    expect(costly.status).toBe(1);
    expect(costly.stdout).toContain("! cost write-note: 10000 to 15000 tokens");
    // …unless the creator's threshold allows it.
    expect((await eval_(["run", "pricing-check", "--max-cost-growth", "60"], agent)).status).toBe(
      0,
    );
    // A case that no longer passes.
    agent.cost = 10_000;
    agent.passes = false;
    const worse = await eval_(["run", "pricing-check"], agent);
    expect(worse.status).toBe(1);
    expect(worse.stdout).toContain("! quality write-note: pass rate fell from 1 to 0");
    expect(worse.stdout).toContain(
      "failed: The note names the 300 euros price and the 3 sessions (the price is missing)",
    );
    // The engine's own check fails too: the note was not written.
    agent.passes = true;
    agent.writes = false;
    expect((await eval_(["run", "pricing-check"], agent)).status).toBe(1);
  });

  it("says « not measured » when the tool gave no count, and does not compare it", async () => {
    const agent = new Fake();
    await eval_(["run", "pricing-check", "--record"], agent);
    agent.cost = null;
    const result = await eval_(["run", "pricing-check"], agent);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("tokens not measured");
    expect(result.stdout).toContain("- not measured write-note: tokens not measured");
    expect(result.stdout).not.toMatch(/(?:^|\s)0 tokens/);
  });

  it("fails a case that does not pass when nothing was kept for it, and does not record an incomplete pass", async () => {
    const agent = new Fake();
    agent.passes = false;
    const failing = await eval_(["run", "pricing-check"], agent);
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain("write-note does not pass and no pass was kept for it");
    const broken: EvalAgent = {
      ...agent,
      tool: "claude-code",
      skillDir: ".claude/skills",
      available: async () => ({ ok: true }),
      run: async () => ({
        status: "failed",
        detail: "no credential",
        transcript: "",
        produced: [],
        ms: 1,
      }),
    };
    const incomplete = await eval_(["run", "pricing-check", "--record"], broken);
    expect(incomplete.status).toBe(2);
    expect(incomplete.stdout).toContain("no credential");
    expect(incomplete.stdout).toContain("was not recorded");
  });

  it("measures the firing for real, one side of the split on request, stopped at the first call", async () => {
    const agent = new Fake();
    const result = await eval_(
      ["run", "pricing-check", "--mode", "trigger", "--set", "train"],
      agent,
    );
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("Mode trigger");
    expect(result.stdout).toContain("loaded in 100% of runs, as wanted");
    expect(result.stdout).toContain("loaded in 0% of runs, as wanted");
    expect(agent.requests.every((request) => request.stopWhen !== undefined)).toBe(true);
    // One query on each side: both train, nothing is held out yet.
    expect(agent.requests.length).toBe(2);
  });

  it("fails a query that goes wrong when nothing was kept for it: a skill that wakes up on everything", async () => {
    const agent = new Fake();
    agent.fires = () => true;
    const result = await eval_(["run", "pricing-check", "--mode", "trigger"], agent);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("goes wrong and no pass was kept for it");
    expect(result.stdout).toContain("wanted: stay quiet");
    expect(result.stdout).toContain("Blocked");
  });

  it("does not keep a pass that regresses, unless the creator says so", async () => {
    const agent = new Fake();
    const reference = join(cwd, ".agentplugged/skills/pricing-check/evals/reference.json");
    await eval_(["run", "pricing-check", "--record"], agent);
    agent.cost = 30_000;
    const refused = await eval_(["run", "pricing-check", "--record"], agent);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain("Not recorded");
    expect(JSON.parse(await readFile(reference, "utf8")).cases["write-note"].tokens).toBe(10_000);
    const accepted = await eval_(["run", "pricing-check", "--record", "--accept"], agent);
    expect(accepted.stdout).toContain("Pass kept as the reference");
    expect(JSON.parse(await readFile(reference, "utf8")).cases["write-note"].tokens).toBe(30_000);
  });

  it("blocks until the creator accepts that the cases changed: a loosened grid hides a regression", async () => {
    const agent = new Fake();
    await eval_(["run", "pricing-check", "--record"], agent);
    const path = join(cwd, ".agentplugged/skills/pricing-check/evals/cases.yaml");
    await writeFile(
      path,
      CASES.replace(
        "The note names the 300 euros price and the 3 sessions",
        "The note names the price",
      ),
    );
    const check = await eval_(["check", "pricing-check"]);
    expect(check.stdout).toContain("changed since the pass kept");
    const changed = await eval_(["run", "pricing-check"], agent);
    expect(changed.status).toBe(1);
    expect(changed.stdout).toContain("the cases changed since the reference was recorded");
    // Keeping the pass is the way out: nothing else regressed, so the creator's gesture is enough.
    const kept = await eval_(["run", "pricing-check", "--record"], agent);
    expect(kept.stdout).toContain("Pass kept as the reference");
    expect((await eval_(["run", "pricing-check"], agent)).status).toBe(0);
  });

  it("does not compare the cost of another model", async () => {
    const agent = new Fake();
    agent.model = "model-a";
    await eval_(["run", "pricing-check", "--record"], agent);
    agent.model = "model-b";
    agent.cost = 90_000;
    const result = await eval_(["run", "pricing-check"], agent);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("recorded with model-a, now model-b: the cost is not compared");
  });

  it("tells a regression before a run that could not be finished", async () => {
    const two = `${CASES}`.replace(
      "triggers:",
      `  - id: second\n    input: "Second: price my other offer, 100 euros"\n    checks:\n      - { kind: answer_has, text: "300 euros" }\ntriggers:`,
    );
    await writeFile(join(cwd, ".agentplugged/skills/pricing-check/evals/cases.yaml"), two);
    const agent = new Fake();
    await eval_(["run", "pricing-check", "--record"], agent);
    agent.passes = false;
    const original = agent.run.bind(agent);
    agent.run = async (request) =>
      request.prompt.startsWith("Second")
        ? { status: "failed", detail: "no credential", transcript: "", produced: [], ms: 1 }
        : original(request);
    const result = await eval_(["run", "pricing-check"], agent);
    expect(result.stdout).toContain("could not be noted");
    expect(result.stdout).toContain("! quality write-note");
    expect(result.status).toBe(1);
  });

  it("runs the variant against the same skill without a section, and refuses a part that is not there", async () => {
    const agent = new Fake();
    const result = await eval_(
      ["run", "pricing-check", "--mode", "variant", "--without", "Pricing"],
      agent,
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain("against variant");
    const lonely = await eval_(
      ["run", "pricing-check", "--mode", "variant", "--without", "No such section"],
      agent,
    );
    expect(lonely.status).toBe(2);
    expect((await eval_(["run", "pricing-check", "--mode", "variant"], agent)).status).toBe(2);
  });

  it("refuses to keep a pass for a shipped skill from a product", async () => {
    const result = await eval_(["run", "write-prd", "--record", "--plan"], new Fake());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("read-only");
  });
});

/** The workflow that runs the real evaluations, by hand. */
const EVALS_WORKFLOW = "method-evals.yml";

describe("what runs, and when", () => {
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  it("is never part of the normal tests: no package script and no public CI runs a real evaluation", () => {
    for (const path of [
      "package.json",
      "apps/cli/package.json",
      "turbo.json",
      "packages/core/package.json",
    ]) {
      expect(read(path), path).not.toMatch(/eval (?:run|init)/);
    }
    // Every workflow of the repository but the evaluations' own (a copy of the repository may hold
    // only some of them).
    const workflows = readdirSync(join(root, ".github/workflows")).filter(
      (name) => /\.ya?ml$/.test(name) && name !== EVALS_WORKFLOW,
    );
    expect(workflows).toContain("ci.yml");
    for (const name of workflows) {
      const path = `.github/workflows/${name}`;
      expect(read(path), path).not.toMatch(/\beval\b/);
    }
  });

  it("runs from a workflow of its own, by hand only, on the self-hosted runner, with a limit of runs", (context) => {
    if (!existsSync(join(root, ".github/workflows", EVALS_WORKFLOW))) {
      context.skip(`this repository has no evaluation workflow (${EVALS_WORKFLOW})`);
    }
    const workflow = read(`.github/workflows/${EVALS_WORKFLOW}`);
    expect(workflow).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^\s+(?:push|pull_request|schedule|workflow_run):/m);
    expect(workflow).toContain("runs-on: [self-hosted, agentplugged]");
    expect(workflow).not.toContain("ubuntu-latest");
    expect(workflow).toContain("'eval', 'run'");
    expect(workflow).toContain("--max-calls");
    expect(workflow).toContain("--method");
  });
});
