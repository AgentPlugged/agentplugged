import { describe, expect, it } from "vitest";
import {
  agentCommand,
  type CommandContext,
  createCommandRegistry,
  initCommand,
  resolveProfile,
  syncCommand,
  type ToolProbe,
  type WorkshopResult,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { digestOf } from "./eval-run.js";
import { loadSkill } from "./eval-store.js";

/**
 * The workshop's `verify` on a skill of the creator's: it carries its behaviour cases
 * (valid or not), the pass kept for this version of the skill, and, when it has none, cases to
 * start from. A shipped skill is not asked for any. No tool is added: it is `agent.workshop`.
 */

const noTools: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

async function product() {
  const files = new MemoryFiles();
  const method = shippedMethod();
  const context = (actor: "human" | "agent" = "human"): CommandContext => ({
    files,
    tools: noTools,
    method,
    actor,
    engineVersion: "1.0.0",
  });
  const init = await initCommand.run(context(), { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const made = await agentCommand.run(context(), {
    action: "create",
    kind: "skill",
    id: "pricing-check",
    description: "Price an offer step by step with the creator, from costs they know.",
    content: {
      steps: [
        "Ask which offer the creator wants to price.",
        "Propose three prices with the reasoning.",
      ],
      outputs: ["A short note with the chosen price and its reasoning, in docs/pricing.md"],
      rules: ["Never invent a cost: ask.", "The creator decides the price."],
    },
  });
  if (!made.ok) throw new Error(`create failed: ${made.error.code}`);
  const verify = async (id: string, triggers: string[] = []) => {
    const result = await createCommandRegistry().run("workshop", context("agent"), {
      workshop: { op: "verify", id, triggers },
    });
    if (!result.ok) throw new Error(`workshop failed: ${result.error.code}`);
    return result.value as Extract<WorkshopResult, { op: "verify" }>;
  };
  return { files, verify, context };
}

const DIR = ".agentplugged/skills/pricing-check";
const CASES = `
cases:
  - id: write-note
    input: "Price my coaching offer: 3 sessions, 300 euros"
    rubric:
      - "The note names the 300 euros price and the 3 sessions"
triggers:
  - { query: "help me price my coaching offer", should_trigger: true }
  - { query: "write the product brief from my idea", should_trigger: false }
`;

describe("the workshop's verify and the behaviour cases", () => {
  it("proposes cases to a skill that has none, from the phrases the creator expects, and fails nothing", async () => {
    const p = await product();
    const result = await p.verify("pricing-check", ["help me price my offer"]);
    expect(result.ok).toBe(true);
    expect(result.evals).toMatchObject({ cases: 0, reference: "absent" });
    expect(result.evals?.starter).toContain("help me price my offer");
    expect(result.evals?.starter).toContain("should_trigger: false");
  });

  it("checks the cases of a skill that has them, and fails on a file that cannot be used", async () => {
    const p = await product();
    p.files.seed(`${DIR}/evals/cases.yaml`, CASES);
    const good = await p.verify("pricing-check");
    expect(good.ok).toBe(true);
    expect(good.evals).toMatchObject({ cases: 1, queries: 2, problems: [], reference: "none" });
    p.files.seed(
      `${DIR}/evals/cases.yaml`,
      "cases:\n  - { id: a, input: 'TODO: a request', rubric: ['a fact the note must hold'] }",
    );
    const bad = await p.verify("pricing-check");
    expect(bad.ok).toBe(false);
    expect(bad.failed[0]).toMatchObject({ check: "evals" });
    expect(bad.failed[0]?.detail).toContain("TODO");
  });

  it("says when the pass kept is for another version of the skill: the evaluation has to be run again", async () => {
    const p = await product();
    p.files.seed(`${DIR}/evals/cases.yaml`, CASES);
    const loaded = await loadSkill(p.files, DIR);
    if ("error" in loaded) throw new Error(loaded.error);
    const reference = (digest: string) =>
      JSON.stringify({
        version: 1,
        recorded_at: "2026-10-13T10:00:00.000Z",
        tool: "claude-code",
        digest,
        cases: {},
        triggers: {},
      });
    p.files.seed(`${DIR}/evals/reference.json`, reference(digestOf(loaded.skill.files)));
    const current = await p.verify("pricing-check");
    expect(current.evals?.reference).toBe("current");
    expect(current.ok).toBe(true);
    // The skill changes: the proof is out of date, and the check says to run the evaluation again.
    const path = `${DIR}/SKILL.md`;
    p.files.seed(path, `${p.files.files.get(path) ?? ""}\n- A new rule.\n`);
    const stale = await p.verify("pricing-check");
    expect(stale.evals?.reference).toBe("stale");
    expect(stale.ok).toBe(false);
    expect(stale.failed[0]).toMatchObject({ check: "evals" });
    expect(stale.failed[0]?.detail).toContain("agentplugged eval run pricing-check");
    // The cases change, the skill does not: the same.
    p.files.seed(path, p.files.files.get(path)?.replace("\n- A new rule.\n", "") ?? "");
    p.files.seed(
      `${DIR}/evals/reference.json`,
      JSON.stringify({
        version: 1,
        recorded_at: "2026-10-13T10:00:00.000Z",
        tool: "claude-code",
        digest: digestOf(loaded.skill.files),
        cases_digest: "f".repeat(16),
        cases: {},
        triggers: {},
      }),
    );
    expect((await p.verify("pricing-check")).evals?.reference).toBe("stale");
    // A pass that cannot be read blocks as well.
    p.files.seed(`${DIR}/evals/reference.json`, "{nope");
    const invalid = await p.verify("pricing-check");
    expect(invalid.evals?.reference).toBe("invalid");
    expect(invalid.ok).toBe(false);
  });

  it("leaves the cases where they are: sync writes the skill for every tool, and never its evaluations", async () => {
    const p = await product();
    p.files.seed(`${DIR}/evals/cases.yaml`, CASES);
    p.files.seed(`${DIR}/evals/reference.json`, "{}");
    const before = p.files.writes.length;
    const synced = await syncCommand.run(p.context(), {});
    expect(synced.ok).toBe(true);
    const written = p.files.writes.slice(before);
    expect(written.some((path) => path.includes("pricing-check"))).toBe(true);
    expect(
      written.filter((path) => path.includes("/evals/") || path.endsWith("cases.yaml")),
    ).toEqual([]);
  });

  it("asks nothing of a shipped skill or of an agent, and writes nothing", async () => {
    const p = await product();
    const before = p.files.writes.length;
    const shipped = await p.verify("iris");
    expect(shipped.evals).toBeUndefined();
    expect(shipped.failed.map((check) => check.check)).not.toContain("evals");
    expect(p.files.writes.length).toBe(before);
  });
});
