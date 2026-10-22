import { SyncManifestSchema } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { recordGitWorkflow, syncCommand, workflowOf } from "../index.js";
import { product } from "../testing/product-harness.js";

/**
 * Only the skills of the current phase are installed in the tools, and the engine installs those
 * of the next phase itself once a phase ends: the creator types nothing.
 */

const skill = (name: string, phase: string) => ({
  [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: A skill of the tests.\nmetadata:\n  phase: ${phase}\n---\n# ${name}\n`,
});

const SKILLS = {
  ...skill("frame-it", "framing"),
  ...skill("plan-it", "planning"),
  ...skill("correct-course", "planning"),
  ...skill("any-time", "framing"),
};

const CONFIG = ".agentplugged/method.yaml";

describe("the skills of the phase in the tools", () => {
  it("installs the framing's skills, then the planning's once the framing is over", async () => {
    const harness = await product("new-product", {
      ...SKILLS,
      // A skill that names no phase serves every phase.
      "skills/mine/SKILL.md": "---\nname: mine\ndescription: The creator's own.\n---\n# mine\n",
    });
    const { files, human, call, decide } = harness;
    const text = (files.files.get(CONFIG) ?? "").replace(/tools:.*\n(?: {2}- .*\n)*/, "");
    files.seed(CONFIG, `${text}tools: [claude-code]\n`);
    const synced = await syncCommand.run(human, {});
    if (!synced.ok) throw new Error(synced.error.code);
    const has = (name: string) => files.files.has(`.claude/skills/${name}/SKILL.md`);
    expect(has("frame-it")).toBe(true);
    expect(has("plan-it")).toBe(false);
    // The fixed base, and a skill without a phase, whatever the phase.
    expect(has("correct-course")).toBe(true);
    expect(has("mine")).toBe(true);
    const manifest = () =>
      SyncManifestSchema.parse(
        JSON.parse(files.files.get(".agentplugged/.cache/sync-manifest.json") ?? "{}"),
      );
    expect(manifest().skills_phase).toBe("framing");

    // The framing ends (here skipped by the creator): the next read of the state installs the
    // planning's skills, by the engine itself.
    await decide({ kind: "step_skip", step: "phase_framing" });
    const next = await call("next");
    expect(next.ok).toBe(true);
    expect(manifest().skills_phase).toBe("planning");
    expect(has("plan-it")).toBe(true);
    expect(has("frame-it")).toBe(false);
    expect(has("correct-course")).toBe(true);
    // The skill left out stays in the method's folder, callable by its name.
    expect(files.files.has(".agentplugged/skills/frame-it/SKILL.md")).toBe(true);
  });

  it("commits what the change of phase wrote, where the engine may commit, so main stays clean", async () => {
    const harness = await product("new-product", SKILLS);
    const { files, human, call, decide, workspace } = harness;
    const text = (files.files.get(CONFIG) ?? "").replace(/tools:.*\n(?: {2}- .*\n)*/, "");
    files.seed(CONFIG, `${text}tools: [claude-code]\n`);
    // Stories land directly on main: the engine may commit there.
    const recorded = await recordGitWorkflow(
      human,
      {
        workflow: { story_branches: true, ci: "none", merge: "direct", review: true },
        previous: workflowOf(await harness.state()).record?.workflow,
      },
      "chat",
    );
    expect(recorded).not.toBeInstanceOf(Error);
    const synced = await syncCommand.run(human, {});
    if (!synced.ok) throw new Error(synced.error.code);
    // The first sync is the creator's: nothing is committed by the engine.
    expect(workspace.pathCommits).toEqual([]);
    await decide({ kind: "step_skip", step: "phase_framing" });
    expect((await call("next")).ok).toBe(true);
    expect(workspace.pathCommits).toHaveLength(1);
    const [commit] = workspace.pathCommits;
    expect(commit?.branch).toBeUndefined();
    // The skills of the new phase, those of the old one removed, and the manifest: all of it.
    expect(commit?.paths).toContain(".claude/skills/plan-it/SKILL.md");
    expect(commit?.paths).toContain(".claude/skills/frame-it/SKILL.md");
    expect(commit?.paths).toContain(".agentplugged/.cache/sync-manifest.json");
    // Nothing changed since: the next reading installs and commits nothing more.
    expect((await call("next")).ok).toBe(true);
    expect(workspace.pathCommits).toHaveLength(1);
  });

  it("commits nothing where the engine may not commit (stories go through a pull request)", async () => {
    const harness = await product("new-product", SKILLS);
    const { files, human, call, decide, workspace } = harness;
    const text = (files.files.get(CONFIG) ?? "").replace(/tools:.*\n(?: {2}- .*\n)*/, "");
    files.seed(CONFIG, `${text}tools: [claude-code]\n`);
    const synced = await syncCommand.run(human, {});
    if (!synced.ok) throw new Error(synced.error.code);
    await decide({ kind: "step_skip", step: "phase_framing" });
    expect((await call("next")).ok).toBe(true);
    expect(files.files.has(".claude/skills/plan-it/SKILL.md")).toBe(true);
    expect(workspace.pathCommits).toEqual([]);
  });
});
