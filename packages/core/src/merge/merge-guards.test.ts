import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import type { StoryConflict } from "../projection/agent-reducers.js";
import { answer, checkpointState } from "../testing/checkpoint-state.js";
import { MemoryFiles } from "../testing/memory-files.js";
import { conflictProblem, orderProblem } from "./merge-guards.js";
import type {
  BranchMerge,
  ConflictFileProbe,
  ConflictHunk,
  ConflictProbe,
  MergeProbe,
} from "./merge-probe.js";

/** The order of the merges and the conflict checks, on a state and a Git in memory. */

const BASE = "1".repeat(40);
const MAIN = "2".repeat(40);
const HEAD = "3".repeat(40);
const MERGE = "4".repeat(40);
const OLD_HEAD = "5".repeat(40);
const T1 = "2026-10-04T10:00:00.000Z";
const T2 = "2026-10-04T10:05:00.000Z";

const reason = (value: unknown) =>
  value instanceof AgentPluggedError ? value.details.reason : undefined;
const details = (value: unknown) =>
  value instanceof AgentPluggedError ? value.details : undefined;

function storyFile(id: string, dependsOn: string[] = []) {
  return [
    "---",
    `id: ${id}`,
    "kind: story",
    "owner: sam",
    `title: Story ${id}`,
    "epic: epic-4",
    "reviewer: quentin",
    "requirements: [EF-29]",
    "budget_usd: 1",
    `branch: feat/${id}-work`,
    `depends_on: [${dependsOn.join(", ")}]`,
    "---",
    `# Story ${id}`,
    "",
    "## Context",
    "",
    "Context.",
    "",
    "## Intent",
    "",
    "Intent.",
    "",
    "## Acceptance criteria",
    "",
    "Given a, when b, then c.",
    "",
    "## Out of scope",
    "",
    "Nothing.",
    "",
  ].join("\n");
}

interface Ready {
  readonly id: string;
  readonly deps?: string[];
  readonly pr?: string;
  readonly ready?: boolean;
}

/** A state with these stories ready to merge: in review, CI green, review done, merge point open. */
function stateOf(stories: readonly Ready[], extra: Record<string, unknown> = {}) {
  const entries: Record<string, unknown> = {};
  const checkpoints: Record<string, unknown> = {};
  stories.forEach((story, index) => {
    const commit = story.pr ?? `${index + 6}`.repeat(40);
    const ready = story.ready !== false;
    entries[story.id] = {
      status: "in_review",
      status_by: { agent: "sam", at: T1 },
      started: { agent: "sam", branch: `feat/${story.id}-work`, base: BASE, base_ref: "main" },
      ci: { status: "pass", commit, at: T2 },
      pull_request: { head: commit },
      review: {
        passes: [
          {
            number: 1,
            since: T1,
            commit,
            reviews: {},
            security: { reasons: [], unavailable: false },
            complete: true,
            outcome: ready ? "approved" : "changes_requested",
            completed_at: T2,
            closed_by: null,
            published: {},
          },
        ],
      },
    };
    checkpoints[`G-${index}000000001`] = checkpointState(`G-${index}000000001`, {
      type: "story",
      source: "merge",
      story: story.id,
      opened_event: `01JZ00000000000000000000${index}1`,
    });
  });
  return { stories: entries, checkpoints, ...extra };
}

function filesOf(stories: readonly Ready[]) {
  return new MemoryFiles(
    Object.fromEntries(
      stories.map((story) => [
        `.agentplugged/stories/${story.id}-work.md`,
        storyFile(story.id, story.deps ?? []),
      ]),
    ),
  );
}

/** A diff that changes `paths`. */
const diffOf = (paths: readonly string[]) =>
  paths
    .map(
      (path) =>
        `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    )
    .join("");

function context(
  stories: readonly Ready[],
  diffs: Record<string, readonly string[] | undefined>,
  probe?: MergeProbe,
): CommandContext {
  return {
    files: filesOf(stories),
    storyDiff: {
      // The commit names the story: stories' pull request heads are distinct.
      diff: async (_base: string, head: string) => {
        const paths = diffs[head];
        return paths === undefined ? undefined : diffOf(paths);
      },
    },
    ...(probe === undefined ? {} : { mergeProbe: probe }),
  } as unknown as CommandContext;
}

describe("the order of the merges", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);

  it("lets the first story merge and holds back one that depends on a ready story", async () => {
    const stories: Ready[] = [
      { id: "4-1", pr: A },
      { id: "4-2", pr: B, deps: ["4-1"] },
    ];
    const ctx = context(stories, { [A]: ["a.ts"], [B]: ["z.ts"] });
    const state = stateOf(stories);
    expect(await orderProblem(ctx, state, "4-1", "G-0000000001", A)).toBeUndefined();
    const refused = await orderProblem(ctx, state, "4-2", "G-1000000001", B);
    expect(reason(refused)).toBe("out_of_order");
    expect(details(refused)).toMatchObject({ before: "4-1", why: "dependency" });
  });

  it("holds back a story that shares a file with an earlier ready story, not one that does not", async () => {
    const stories: Ready[] = [
      { id: "4-1", pr: A },
      { id: "4-3", pr: B },
    ];
    const state = stateOf(stories);
    const shared = context(stories, { [A]: ["a.ts"], [B]: ["a.ts", "b.ts"] });
    const refused = await orderProblem(shared, state, "4-3", "G-1000000001", B);
    expect(details(refused)).toMatchObject({
      reason: "out_of_order",
      before: "4-1",
      why: "overlap",
    });
    const apart = context(stories, { [A]: ["a.ts"], [B]: ["b.ts"] });
    expect(await orderProblem(apart, state, "4-3", "G-1000000001", B)).toBeUndefined();
  });

  it("is careful when the files of an earlier story cannot be read", async () => {
    const stories: Ready[] = [
      { id: "4-1", pr: A },
      { id: "4-3", pr: B },
    ];
    const ctx = context(stories, { [B]: ["b.ts"] });
    expect(reason(await orderProblem(ctx, stateOf(stories), "4-3", "G-1000000001", B))).toBe(
      "out_of_order",
    );
  });

  it("follows the sprint in force when nothing else orders two stories", async () => {
    const stories: Ready[] = [
      { id: "4-1", pr: A },
      { id: "4-3", pr: B },
    ];
    const ctx = context(stories, { [A]: ["a.ts"], [B]: ["a.ts"] });
    // The sprint in force plans 4-3 before 4-1.
    const state = stateOf(stories, {
      sprints: {
        "S-1": {
          id: "S-1",
          event: "01JZ0000000000000000000001",
          checkpoint: "G-9000000001",
          planned_by: "maya",
          stories: [{ id: "4-3" }, { id: "4-1" }],
        },
      },
    });
    (state.checkpoints as Record<string, unknown>)["G-9000000001"] = checkpointState(
      "G-9000000001",
      { status: "resolved", resolution: answer("approved", T1) },
    );
    expect(await orderProblem(ctx, state, "4-3", "G-1000000001", B)).toBeUndefined();
    expect(reason(await orderProblem(ctx, state, "4-1", "G-0000000001", A))).toBe("out_of_order");
  });

  it("refuses a story whose dependency is neither delivered nor ready", async () => {
    const stories: Ready[] = [
      { id: "4-1", pr: A, ready: false },
      { id: "4-2", pr: B, deps: ["4-1"] },
    ];
    const state = stateOf(stories);
    // 4-1 is in review but its review failed: the gate holds it, it is not in the queue.
    const refused = await orderProblem(
      context(stories, { [A]: ["a.ts"], [B]: ["z.ts"] }),
      state,
      "4-2",
      "G-1000000001",
      B,
    );
    expect(details(refused)).toMatchObject({ reason: "dependency_unmerged", dependency: "4-1" });
  });

  it("does not hold a story behind a dependency that is delivered", async () => {
    const stories: Ready[] = [{ id: "4-2", pr: B, deps: ["4-1"] }];
    const state = stateOf(stories);
    (state.stories as Record<string, unknown>)["4-1"] = {
      status: "in_review",
      started: { agent: "sam", branch: "feat/4-1-work", base: BASE, base_ref: "main" },
      merged: { at: T2 },
    };
    expect(
      await orderProblem(context(stories, { [B]: ["z.ts"] }), state, "4-2", "G-0000000001", B),
    ).toBeUndefined();
  });

  it("refuses the stories of a dependency cycle", async () => {
    const stories: Ready[] = [
      { id: "4-1", pr: A, deps: ["4-2"] },
      { id: "4-2", pr: B, deps: ["4-1"] },
    ];
    const ctx = context(stories, { [A]: ["a.ts"], [B]: ["b.ts"] });
    expect(reason(await orderProblem(ctx, stateOf(stories), "4-1", "G-0000000001", A))).toBe(
      "dependency_cycle",
    );
    expect(reason(await orderProblem(ctx, stateOf(stories), "4-2", "G-1000000001", B))).toBe(
      "dependency_cycle",
    );
  });

  it("lets an unknown story file alone: no dependency is invented", async () => {
    const stories: Ready[] = [{ id: "4-1", pr: A }];
    const ctx = {
      ...context(stories, { [A]: ["a.ts"] }),
      files: new MemoryFiles(),
    } as CommandContext;
    expect(await orderProblem(ctx, stateOf(stories), "4-1", "G-0000000001", A)).toBeUndefined();
  });
});

/** A Git in memory. */
class FakeProbe implements MergeProbe {
  refs = new Map<string, string>([["main", MAIN]]);
  probes = new Map<string, ConflictProbe>();
  texts = new Map<string, string>();
  ancestors = new Map<string, boolean>();
  history: readonly BranchMerge[] | undefined = [];
  async resolve(ref: string) {
    return this.refs.get(ref);
  }
  async probe(main: string, head: string): Promise<ConflictProbe> {
    return this.probes.get(`${main}|${head}`) ?? { status: "clean", main };
  }
  async show(commit: string, path: string) {
    return this.texts.get(`${commit}:${path}`);
  }
  async isAncestor(ancestor: string, descendant: string) {
    return this.ancestors.get(`${ancestor}|${descendant}`) ?? true;
  }
  merged = new Map<string, string>();
  trees = new Map<string, string>();
  async mergedTree(main: string, own: string) {
    return this.merged.get(`${main}|${own}`) ?? "T";
  }
  async treeOf(commit: string) {
    return this.trees.get(commit) ?? "T";
  }
  async merges() {
    return this.history;
  }
  /** The commits made on the forge. */
  forgeMade = new Set<string>();
  async madeOnForge(commit: string) {
    return this.forgeMade.has(commit);
  }
}

const hunk = (main: string[], story: string[], base: string[] = []): ConflictHunk => ({
  main,
  base,
  story,
});
const file = (path: string, hunks: ConflictHunk[]): ConflictFileProbe => ({
  path,
  structural: false,
  hunks,
  hunks_truncated: false,
});
const conflicting = (main: string, files: ConflictFileProbe[]): ConflictProbe => ({
  status: "conflict",
  main,
  files,
  files_truncated: false,
});

function conflictState(conflicts: StoryConflict[] = [], decision?: unknown) {
  return {
    stories: {
      "4-3": {
        started: { agent: "sam", branch: "feat/4-3-work", base: BASE, base_ref: "main" },
        conflicts,
      },
    },
    checkpoints: decision === undefined ? {} : { "G-8000000001": decision },
  };
}

const qualification = (overrides: Partial<StoryConflict> = {}): StoryConflict => ({
  main: MAIN,
  head: OLD_HEAD,
  base_ref: "main",
  kind: "textual",
  files: [{ path: "src/index.ts", class: "additions" }],
  files_truncated: false,
  rationale: "Imports.",
  recommendation: null,
  checkpoint: null,
  by: "sam",
  at: T1,
  event: "01JZ0000000000000000000009",
  ...overrides,
});

const run = (ctx: CommandContext, state: ReturnType<typeof conflictState>) =>
  conflictProblem(ctx, state, "4-3", "G-0000000001", HEAD);

const plain = (probe?: MergeProbe, diff?: string): CommandContext =>
  ({
    ...(probe === undefined ? {} : { mergeProbe: probe }),
    storyDiff: { diff: async () => diff ?? "" },
  }) as unknown as CommandContext;

describe("the conflict checks of a merge", () => {
  it("leaves the judgement to the forge without a Git port", async () => {
    expect(await run(plain(), conflictState())).toBeUndefined();
  });

  it("refuses a head that still conflicts with the main branch", async () => {
    const probe = new FakeProbe();
    probe.probes.set(`${MAIN}|${HEAD}`, conflicting(MAIN, [file("a.ts", [hunk(["x"], ["y"])])]));
    const refused = await run(plain(probe), conflictState());
    expect(details(refused)).toMatchObject({ reason: "conflict", files: ["a.ts"] });
  });

  it("refuses a conflict marker left in the story's changes", async () => {
    const diff =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,3 @@\n+<<<<<<< main\n+x\n+>>>>>>> story\n";
    const refused = await run(plain(new FakeProbe(), diff), conflictState());
    expect(details(refused)).toMatchObject({ reason: "conflict_markers", files: ["a.ts"] });
  });

  it("refuses a rebased branch, an octopus merge and a history it cannot read", async () => {
    const rebased = new FakeProbe();
    rebased.ancestors.set(`${BASE}|${HEAD}`, false);
    expect(details(await run(plain(rebased), conflictState()))).toMatchObject({
      reason: "conflict_unverified",
      why: "rebased",
    });
    const octopus = new FakeProbe();
    octopus.history = [{ commit: MERGE, parents: [OLD_HEAD, MAIN, "6".repeat(40)] }];
    expect(details(await run(plain(octopus), conflictState()))).toMatchObject({
      reason: "conflict_unverified",
      why: "octopus",
    });
    const unreadable = new FakeProbe();
    unreadable.history = undefined;
    expect(details(await run(plain(unreadable), conflictState()))).toMatchObject({
      why: "unreadable",
    });
    const parents = new FakeProbe();
    parents.history = [{ commit: MERGE, parents: [OLD_HEAD, MAIN] }];
    parents.probes.set(`${MAIN}|${OLD_HEAD}`, { status: "unavailable" });
    expect(details(await run(plain(parents), conflictState()))).toMatchObject({
      why: "unreadable",
    });
  });

  it("accepts a branch whose merges of the main branch resolved nothing", async () => {
    const probe = new FakeProbe();
    probe.history = [{ commit: MERGE, parents: [OLD_HEAD, MAIN] }];
    expect(await run(plain(probe), conflictState())).toBeUndefined();
  });

  /** A branch whose merge commit resolved the conflict of `src/index.ts`. */
  function resolved(text: string | undefined) {
    const probe = new FakeProbe();
    probe.history = [{ commit: MERGE, parents: [OLD_HEAD, MAIN] }];
    const conflict = conflicting(MAIN, [file("src/index.ts", [hunk(["import a"], ["import b"])])]);
    probe.probes.set(`${MAIN}|${OLD_HEAD}`, conflict);
    if (text !== undefined) probe.texts.set(`${MERGE}:src/index.ts`, text);
    return probe;
  }

  it("refuses a resolution no qualification covers", async () => {
    const refused = await run(plain(resolved("import a\nimport b")), conflictState());
    expect(details(refused)).toMatchObject({
      reason: "conflict_unqualified",
      commit: MERGE,
      files: ["src/index.ts"],
    });
    // A qualification of another main commit does not cover it.
    const other = conflictState([qualification({ main: "7".repeat(40) })]);
    const unrelated = resolved("import a\nimport b");
    unrelated.ancestors.set(`${"7".repeat(40)}|${MAIN}`, false);
    expect(reason(await run(plain(unrelated), other))).toBe("conflict_unqualified");
  });

  it("accepts a textual resolution that keeps both sides, and refuses one that loses a line", async () => {
    const state = conflictState([qualification()]);
    const pair = conflicting(MAIN, [file("src/index.ts", [hunk(["import a"], ["import b"])])]);
    const keeps = resolved("import a\nimport b\nrest");
    keeps.probes.set(`${MAIN}|${OLD_HEAD}`, pair);
    expect(await run(plain(keeps), state)).toBeUndefined();
    const loses = resolved("import b\nrest");
    expect(details(await run(plain(loses), state))).toMatchObject({
      reason: "conflict_dropped",
      files: ["src/index.ts"],
      commit: MERGE,
    });
    const marked = resolved("import a\nimport b\n<<<<<<< main\n");
    expect(reason(await run(plain(marked), state))).toBe("conflict_markers");
    const deleted = resolved(undefined);
    expect(reason(await run(plain(deleted), state))).toBe("conflict_dropped");
  });

  it("covers a merge only for the conflict the qualification named", async () => {
    const state = conflictState([qualification()]);
    // The conflict this merge settled has a second file, of substance, that nobody qualified.
    const wider = resolved("import a\nimport b");
    wider.probes.set(
      `${MAIN}|${OLD_HEAD}`,
      conflicting(MAIN, [
        file("src/index.ts", [hunk(["import a"], ["import b"])]),
        file("src/cart.ts", [hunk(["total = a"], ["total = b"], ["total = 0"])]),
      ]),
    );
    expect(details(await run(plain(wider), state))).toMatchObject({
      reason: "conflict_unqualified",
      files: ["src/index.ts", "src/cart.ts"],
    });
    // The same file, but now of substance: a textual qualification does not cover it.
    const heavier = resolved("import a\nimport b");
    heavier.probes.set(
      `${MAIN}|${OLD_HEAD}`,
      conflicting(MAIN, [file("src/index.ts", [hunk(["x = a"], ["x = b"], ["x = 0"])])]),
    );
    expect(reason(await run(plain(heavier), state))).toBe("conflict_unqualified");
  });

  it("refuses a branch whose reviewed commits are no longer in it (replayed on the main branch)", async () => {
    const state = conflictState([]);
    (state.stories["4-3"] as Record<string, unknown>).ci = { commit: OLD_HEAD };
    const replayed = new FakeProbe();
    replayed.ancestors.set(`${OLD_HEAD}|${HEAD}`, false);
    expect(details(await run(plain(replayed), state))).toMatchObject({
      reason: "conflict_unverified",
      why: "rebased",
      commit: OLD_HEAD,
    });
  });

  it("refuses a merge of the main branch that holds changes of its own, or took in a side commit", async () => {
    const own = new FakeProbe();
    own.history = [{ commit: MERGE, parents: [OLD_HEAD, MAIN] }];
    own.trees.set(MERGE, "evil");
    expect(details(await run(plain(own), conflictState()))).toMatchObject({
      reason: "conflict_unverified",
      why: "diverged",
    });
    const side = new FakeProbe();
    side.history = [{ commit: MERGE, parents: [OLD_HEAD, "7".repeat(40)] }];
    side.ancestors.set(`${"7".repeat(40)}|${MAIN}`, false);
    expect(details(await run(plain(side), conflictState()))).toMatchObject({
      why: "foreign",
    });
  });

  it("accepts the merges the creator made on the forge: nothing to qualify, nothing foreign", async () => {
    // A conflict resolved in two clicks on the forge, from a main branch this machine has not fetched.
    const side = new FakeProbe();
    const forgeMain = "7".repeat(40);
    side.history = [{ commit: MERGE, parents: [OLD_HEAD, forgeMain] }];
    side.ancestors.set(`${forgeMain}|${MAIN}`, false);
    side.probes.set(
      `${forgeMain}|${OLD_HEAD}`,
      conflicting(forgeMain, [file("src/index.ts", [hunk(["x = a"], ["x = b"], ["x = 0"])])]),
    );
    // Made here: refused as before (a side commit, then a conflict nobody qualified).
    expect(details(await run(plain(side), conflictState()))).toMatchObject({ why: "foreign" });
    // Made on the forge: the creator's own gesture, part of the story.
    side.forgeMade.add(MERGE);
    expect(await run(plain(side), conflictState())).toBeUndefined();
  });

  it("lets the forge judge when Git cannot merge in memory, unless a conflict was qualified", async () => {
    const old = new FakeProbe();
    old.probes.set(`${MAIN}|${HEAD}`, { status: "unavailable" });
    old.probes.set(`${MAIN}|${OLD_HEAD}`, { status: "unavailable" });
    old.history = [{ commit: MERGE, parents: [OLD_HEAD, MAIN] }];
    expect(await run(plain(old), conflictState())).toBeUndefined();
    expect(reason(await run(plain(old), conflictState([qualification()])))).toBe(
      "conflict_unverified",
    );
  });

  it("covers a merge of a later main commit, and a substance qualification before a textual one", async () => {
    const later = "8".repeat(40);
    const probe = resolved("import a\nimport b");
    probe.history = [{ commit: MERGE, parents: [OLD_HEAD, later] }];
    probe.refs.set("main", later);
    probe.ancestors.set(`${MAIN}|${later}`, true);
    probe.probes.set(
      `${later}|${OLD_HEAD}`,
      conflicting(later, [file("src/index.ts", [hunk(["import a"], ["import b"])])]),
    );
    probe.texts.set(`${MERGE}:src/index.ts`, "import a\nimport b");
    expect(await run(plain(probe), conflictState([qualification()]))).toBeUndefined();
    // A textual declaration after a conflict of substance on the same main commit does not cover.
    const decided = checkpointState("G-8000000001", {
      type: "decision",
      source: "merge_conflict",
      story: "4-3",
      status: "resolved",
      resolution: { ...answer("option_chosen", T2), option: "keep_main" },
    });
    const state = conflictState(
      [
        qualification({
          kind: "substantive",
          recommendation: "keep_main",
          checkpoint: "G-8000000001",
        }),
        qualification({ at: T2 }),
      ],
      decided,
    );
    const lost = resolved("import b");
    lost.probes.set(
      `${MAIN}|${OLD_HEAD}`,
      conflicting(MAIN, [file("src/index.ts", [hunk(["import a"], ["import b"])])]),
    );
    expect(reason(await run(plain(lost), state))).toBe("conflict_dropped");
  });

  it("does not let a conflict of substance cover a file the creator never saw", async () => {
    const decided = checkpointState("G-8000000001", {
      type: "decision",
      source: "merge_conflict",
      story: "4-3",
      status: "resolved",
      resolution: { ...answer("option_chosen", T2), option: "combine" },
    });
    const state = conflictState(
      [
        qualification({
          kind: "substantive",
          recommendation: "combine",
          checkpoint: "G-8000000001",
        }),
      ],
      decided,
    );
    const probe = resolved("import a\nimport b");
    probe.probes.set(
      `${MAIN}|${OLD_HEAD}`,
      conflicting(MAIN, [
        file("src/index.ts", [hunk(["import a"], ["import b"])]),
        file("src/other.ts", [hunk(["x"], ["y"], ["z"])]),
      ]),
    );
    expect(details(await run(plain(probe), state))).toMatchObject({
      reason: "conflict_unqualified",
      files: ["src/index.ts", "src/other.ts"],
    });
  });

  it("refuses when the diff cannot be read while Git can", async () => {
    const ctx = {
      mergeProbe: new FakeProbe(),
      storyDiff: { diff: async () => undefined },
    } as unknown as CommandContext;
    expect(details(await run(ctx, conflictState()))).toMatchObject({
      reason: "conflict_unverified",
      why: "unreadable",
    });
  });

  it("accepts a resolution a later commit of the branch repaired", async () => {
    const state = conflictState([qualification()]);
    const pair = conflicting(MAIN, [file("src/index.ts", [hunk(["import a"], ["import b"])])]);
    const repaired = resolved("import b\nrest");
    repaired.probes.set(`${MAIN}|${OLD_HEAD}`, pair);
    // The merge commit lost a line; the branch's head holds both again.
    repaired.texts.set(`${HEAD}:src/index.ts`, "import a\nimport b\nrest");
    expect(await run(plain(repaired), state)).toBeUndefined();
    // Nor the merge commit nor the head keeps it: refused, with the merge commit's loss.
    const lost = resolved("import b\nrest");
    lost.probes.set(`${MAIN}|${OLD_HEAD}`, pair);
    lost.texts.set(`${HEAD}:src/index.ts`, "import b\nrest");
    expect(reason(await run(plain(lost), state))).toBe("conflict_dropped");
  });

  it("cannot verify a qualification whose commits are no longer there", async () => {
    const probe = resolved("import a\nimport b");
    probe.probes.delete(`${MAIN}|${OLD_HEAD}`);
    probe.probes.set(`${MAIN}|${OLD_HEAD}`, { status: "unavailable" });
    // The merge's own parents are unreadable first.
    expect(reason(await run(plain(probe), conflictState([qualification()])))).toBe(
      "conflict_unverified",
    );
  });

  it("asks a conflict of substance for the creator's answer, and keeps the side chosen", async () => {
    const decision = (option: string | null) =>
      checkpointState("G-8000000001", {
        type: "decision",
        source: "merge_conflict",
        story: "4-3",
        status: option === null ? "open" : "resolved",
        resolution: option === null ? null : { ...answer("option_chosen", T2), option },
      });
    const q = qualification({
      kind: "substantive",
      recommendation: "keep_story",
      checkpoint: "G-8000000001",
      files: [{ path: "src/index.ts", class: "both_modified" }],
    });
    const probe = (text: string) => {
      const found = resolved(text);
      found.probes.set(
        `${MAIN}|${OLD_HEAD}`,
        conflicting(MAIN, [
          file("src/index.ts", [hunk(["total = a"], ["total = b"], ["total = 0"])]),
        ]),
      );
      return found;
    };
    // Not answered yet: nothing proves the creator chose.
    expect(
      details(await run(plain(probe("total = b")), conflictState([q], decision(null)))),
    ).toMatchObject({ reason: "conflict_unverified", why: "undecided" });
    const chosen = conflictState([q], decision("keep_story"));
    expect(await run(plain(probe("total = b")), chosen)).toBeUndefined();
    expect(reason(await run(plain(probe("total = a")), chosen))).toBe("conflict_dropped");
    const main = conflictState([q], decision("keep_main"));
    expect(await run(plain(probe("total = a")), main)).toBeUndefined();
    expect(reason(await run(plain(probe("total = b")), main))).toBe("conflict_dropped");
    const combined = conflictState([q], decision("combine"));
    expect(await run(plain(probe("total = a + b")), combined)).toBeUndefined();
  });
});
