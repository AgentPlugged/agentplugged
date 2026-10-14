/**
 * What the engine really answered to `state.get` and `state.next` on a
 * project at the build phase (two stories, a sprint, a backup that cannot reach its remote), before
 * the answers were shaped. The economy test measures the shaped answers against them.
 */
export const STATE_GET = {
  detail: "summary",
  clock: {
    now: "2026-10-09T13:45:00.219Z",
    now_local: "2026-10-09 09:45:00 -04:00",
    time_zone: "America/Toronto",
    utc_offset: "-04:00",
  },
  product: "01M43R4Y5A7CA7PRERPMX92KC2",
  phase: {
    current: "build",
    status: "in_progress",
    phases:
      "framing done, planning done, design done, build in_progress, delivery upcoming, launch upcoming",
  },
  agents: { sam: "waiting · story 1-1" },
  agents_idle: ["noah", "iris", "maya", "stella", "alex", "chloe", "tess", "izzy", "omar", "main"],
  stories: {
    "1-1": "in_review · 15% · waits for G-V7K0K2RHRE · PR #2 · CI waived",
    "1-2": "in_progress · 8%",
  },
  merged_stories: 0,
  merged_order: [],
  open_checkpoints: [],
  refused_checkpoints: ["G-V7K0K2RHRE · rejected · Run a destructive command"],
  stacks_open: 0,
  session_trusted: true,
  open_questions: 42,
  sprint:
    "S-3JTF36QFDY · in_force · Un testeur peut créer son compte · 1-1 in_review, 1-2 in_progress",
  deferred_open: 0,
  deviations_open: 0,
  validation: {
    mode: "chat",
    source: "main",
    warning: null,
    unpublished: null,
    proof: "hook",
    review: [],
    elicitation: false,
    channels: {
      available: ["chat"],
      elicitation: "unavailable",
      question_tool: "hook_missing",
    },
    points: {
      configured: false,
      fixed: ["framing", "architecture", "breakdown", "merge", "release", "publication"],
      delegated: [],
      proposed: ["framing", "architecture", "release", "publication"],
    },
  },
  git: {
    chosen: false,
    branches: { integration: null, production: null },
    story_branches: true,
    ci: "remote",
    merge: "pr",
    review: true,
    recommended: { story_branches: true, ci: "remote", merge: "pr", review: true },
  },
  journey: { skipped: [], skipped_total: 0 },
  installs: { mode: "visible", source: "main", warning: null, declared: {} },
  usage: {
    estimates: {
      standard: { low: 2, expected: 6, high: 14, basis: "reference", stories: 0 },
      fast: { low: 0.3, expected: 1, high: 4, basis: "reference", stories: 0 },
    },
  },
  warnings: [{ code: "sensitive_unreadable", count: 22 }],
  more: "This is a summary. For the detail pass ONE option, never two: `agent` (an id), `story` (an id), `checkpoint` (a G-… id), `checkpoints`, `delegations`, or `full: true` for the whole abridged state.",
  engine_version: "0.1.0",
  journal_backup: {
    status: "blocked",
    reason: "no_remote",
    since: "2026-10-09T13:24:13.252Z",
    action:
      "The product's journal is kept on this machine only: this repository has no remote. Tell the creator ONCE, in one sentence and in their language.",
  },
};

export const STATE_NEXT = {
  you: false,
  agent: "sam",
  agent_name: "Sam",
  tool: "claude-code",
  waiting: [],
  command: null,
  story: "1-1",
  checkpoint: "G-V7K0K2RHRE",
  sync: null,
  missing_tools: [],
  pending_keys: [],
  phase: "build",
  phases: [
    { id: "framing", status: "done" },
    { id: "build", status: "in_progress" },
  ],
  stray: [],
  sprint: { id: "S-3JTF36QFDY", goal: "Un testeur peut créer son compte.", done: 0, total: 4 },
  deferred: null,
  step: "changes_requested",
  answer: null,
  decisions: [],
  pile: { stack: [], apart: [], more: 0 },
  morning: { since: "2026-10-09T00:30:35.558Z", done: [], done_total: 0, decided: [] },
  journey: { skipped: [], skipped_total: 0 },
  git: STATE_GET.git,
  validation: STATE_GET.validation,
  engine_version: "0.1.0",
  journal_backup: STATE_GET.journal_backup,
};
