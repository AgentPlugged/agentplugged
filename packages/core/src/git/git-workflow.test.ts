import { toBase64url } from "@agentplugged/crypto";
import type { EventEnvelope, GitWorkflow } from "@agentplugged/protocol";
import { resolveGitWorkflow } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  type CommandContext,
  gitView,
  initCommand,
  isSkipped,
  MemoryKeyStore,
  MemoryStateStore,
  profileCommand,
  recordGitWorkflow,
  resolveProfile,
  stagedStories,
  workflowImplications,
  workflowOf,
} from "../index.js";
import { computeProjection } from "../projection/compute-projection.js";
import { GIT_REDUCERS } from "../projection/git-reducers.js";
import { emptyDraft } from "../projection/reducers.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

/** The creator's Git workflow, recorded in `method.yaml` and in the journal. */

const NO_TOOL = {
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
  return { files, journal, human };
}

const STAGED: GitWorkflow = {
  integration: "dev",
  production: "main",
  story_branches: true,
  ci: "remote",
  merge: "pr",
  review: true,
};

async function stateOf(journal: MemoryStateStore) {
  return (await computeProjection((await journal.list()).events)).state;
}

describe("the Git workflow, chosen at init", () => {
  it("is written to method.yaml and to the journal, and read from there", async () => {
    const { files, journal, human } = setup();
    const result = await initCommand.run(human, {
      profile: resolveProfile("new-product"),
      workflow: STAGED,
    });
    expect(result.ok && result.value.workflow).toEqual(STAGED);
    expect(parse(files.files.get(CONFIG) as string).git).toEqual(STAGED);
    const view = workflowOf(await stateOf(journal));
    expect(view.chosen).toBe(true);
    expect(view.resolved.integration).toBe("dev");
    expect(view.resolved.staged).toBe(true);
    expect(view.record?.source).toBe("init");
  });

  it("never replaces a workflow already recorded", async () => {
    const { files, human } = setup();
    await initCommand.run(human, { profile: resolveProfile("new-product"), workflow: STAGED });
    await initCommand.run(human, { workflow: { ...STAGED, ci: "none" } });
    expect(parse(files.files.get(CONFIG) as string).git.ci).toBe("remote");
  });

  it("refuses a production branch without an integration branch, and two equal branches", async () => {
    const { human } = setup();
    for (const wrong of [{ production: "main" }, { integration: "dev", production: "dev" }]) {
      const result = await initCommand.run(human, { workflow: wrong });
      expect(result.ok).toBe(false);
    }
  });
});

describe("changing the workflow in the middle of a product", () => {
  it("is one answer, tells what it implies, and records the change once", async () => {
    const { files, journal, human } = setup();
    await initCommand.run(human, {
      profile: resolveProfile("new-product"),
      workflow: { story_branches: true, ci: "remote", merge: "pr", review: true },
    });
    const changed = await profileCommand.run(human, { workflow: STAGED });
    expect(changed.ok && changed.value.workflow?.given).toBe(true);
    expect(parse(files.files.get(CONFIG) as string).git.integration).toBe("dev");
    if (!changed.ok || changed.value.workflow === undefined) throw new Error("no workflow");
    const recorded = await recordGitWorkflow(
      human,
      { workflow: changed.value.workflow.workflow, previous: changed.value.workflow.previous },
      "terminal",
    );
    if (recorded instanceof Error) throw recorded;
    expect(recorded.event).toBe("written");
    expect(recorded.implications.map((entry) => entry.code)).toEqual(["integration"]);
    expect(workflowOf(await stateOf(journal)).resolved.integration).toBe("dev");
    // The same one again: the file and the journal already say so.
    const again = await recordGitWorkflow(
      human,
      { workflow: STAGED, previous: STAGED },
      "terminal",
    );
    expect(again instanceof Error ? undefined : again.event).toBe("unchanged");
  });
});

describe("what the choice changes in the engine", () => {
  const withWorkflow = (workflow: GitWorkflow, forge = true) => ({
    git_workflow: { workflow, forge, source: "terminal", at: "", event: "", merges: 0 },
  });

  it("makes no CI and no review the creator's choice, not a gap", () => {
    expect(isSkipped({}, "story_ci", "1-1")).toBe(false);
    const none = withWorkflow({ ...STAGED, ci: "none", review: false });
    expect(isSkipped(none, "story_ci", "1-1")).toBe(true);
    expect(isSkipped(none, "ci_setup")).toBe(true);
    expect(isSkipped(none, "story_review", "1-1")).toBe(true);
    // A CI on their machine needs a forge to read it from; without one the merge does not wait for it.
    expect(isSkipped(withWorkflow({ ...STAGED, ci: "local" }), "story_ci", "1-1")).toBe(false);
    expect(isSkipped(withWorkflow({ ...STAGED, ci: "local" }, false), "story_ci", "1-1")).toBe(
      true,
    );
  });

  it("makes a CI on the forge no wait when there is no pull request to read it from", () => {
    const direct = withWorkflow({ ...STAGED, merge: "direct" });
    expect(isSkipped(direct, "story_ci", "1-1")).toBe(true);
    // Its set-up stays proposed: pushes to the branches run it.
    expect(isSkipped(direct, "ci_setup")).toBe(false);
  });

  it("merges directly when a story has no branch of its own", () => {
    expect(resolveGitWorkflow({ story_branches: false, merge: "pr" }).merge).toBe("direct");
  });

  it("says what a change means for the stories in progress", () => {
    const before = resolveGitWorkflow({ story_branches: true });
    const after = resolveGitWorkflow({ ...STAGED, ci: "none", review: false, merge: "direct" });
    expect(workflowImplications(before, after, 2).map((entry) => entry.code)).toEqual([
      "integration",
      "ci",
      "merge",
      "review",
    ]);
  });

  it("aims the stories in progress at the new integration branch, losing nothing", () => {
    const draft = emptyDraft();
    draft.state.stories = {
      "1-1": { started: { base_ref: "origin/main", worktree: "../shop.worktrees/1-1" } },
      "1-2": { started: { base_ref: "abc", worktree: "." } },
      "1-3": {
        started: { base_ref: "main", worktree: "../shop.worktrees/1-3" },
        merged: { seq: 1 },
      },
    };
    const event = {
      id: "01",
      at: "2026-10-06T10:00:00.000Z",
      actor: { kind: "system", device: "machine:AAAAAAAAAAAAAAAA" },
      payload: { workflow: STAGED, previous: null, source: "terminal", forge: true, main: "main" },
    } as unknown as EventEnvelope;
    (GIT_REDUCERS["git.workflow_set"] as (d: unknown, e: EventEnvelope) => void)(draft, event);
    const stories = draft.state.stories as Record<string, { started: { base_ref: string } }>;
    expect(stories["1-1"]?.started.base_ref).toBe("origin/dev");
    expect(stories["1-2"]?.started.base_ref).toBe("abc");
    expect(stories["1-3"]?.started.base_ref).toBe("main");
  });
});

describe("main + dev: what waits in staging", () => {
  const record = (merges: number) => ({
    workflow: STAGED,
    forge: true,
    source: "terminal",
    at: "2026-10-01T00:00:00.000Z",
    event: "e",
    merges,
  });
  const merged = (seq: number, at: string) => ({
    started: { branch: `feat/${seq}` },
    status: "done",
    merged: { seq, at },
    ci: { status: "pass" },
  });

  it("counts the stories merged since the choice and the last release, and advises", () => {
    const state = {
      git_workflow: record(1),
      stories: {
        "1-1": merged(1, "2026-10-01T00:00:00.000Z"),
        "1-2": merged(2, "2026-10-02T00:00:00.000Z"),
        "1-3": merged(3, "2026-10-03T00:00:00.000Z"),
      },
    };
    expect(stagedStories(state).map((entry) => entry.story)).toEqual(["1-2", "1-3"]);
    const now = Date.parse("2026-10-05T00:00:00.000Z");
    const view = gitView(state, now, { forge: true });
    expect(view.staging?.waiting).toHaveLength(2);
    expect(view.staging?.oldest_days).toBe(3);
    expect(view.staging?.advice).toBe("release");
    // A release empties it; a story built meanwhile is the next one's, not a brake.
    const released = {
      ...state,
      git_release: { merges: 3, stories: ["1-2", "1-3"], at: "2026-10-04T00:00:00.000Z" },
      stories: {
        ...state.stories,
        "1-4": { started: { branch: "feat/4" }, status: "in_progress" },
      },
    };
    expect(stagedStories(released)).toEqual([]);
    expect(gitView(released, now, { forge: true }).staging?.advice).toBe("nothing");
  });

  it("says wait when something holds the release back", () => {
    const state = {
      git_workflow: record(0),
      stories: {
        "1-1": { ...merged(1, "2026-10-01T00:00:00.000Z"), ci: { status: "fail" } },
      },
    };
    const view = gitView(state, Date.parse("2026-10-02T00:00:00.000Z"), { forge: true });
    expect(view.staging?.brakes).toContain("ci_not_green");
    expect(view.staging?.advice).toBe("wait");
  });

  it("has no staging without an integration branch, and always a recommendation", () => {
    const view = gitView({}, 0, { forge: false });
    expect(view.chosen).toBe(false);
    expect(view.staging).toBeUndefined();
    expect(view.recommended).toMatchObject({ ci: "local", merge: "direct", review: true });
    expect(gitView({}, 0, { forge: true }).recommended).toMatchObject({
      ci: "remote",
      merge: "pr",
    });
  });
});
