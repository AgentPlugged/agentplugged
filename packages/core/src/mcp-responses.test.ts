import { describe, expect, it } from "vitest";
import {
  compact,
  RESPONSE_FORMS,
  ResponseMemory,
  responseFormsCover,
  shapeResponse,
} from "./mcp-responses.js";
import { TOOL_GROUPS } from "./mcp-tools.js";

/**
 * The answers of the tools carry the essential. Samples are what the engine really
 * answered on a project at the build phase (two stories, a sprint, a backup that cannot reach its
 * remote), before they were shaped.
 */
const STATE_GET = {
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

const STATE_NEXT = {
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

const size = (value: unknown) => JSON.stringify(value).length;
const shape = (tool: string, action: string, value: unknown, memory = new ResponseMemory()) =>
  shapeResponse(tool, action, value, memory) as Record<string, any>;

describe("the form of each answer", () => {
  it("has a form and a largest size for every action the server publishes, and none left over", () => {
    expect(responseFormsCover()).toEqual({ missing: [], extra: [] });
    const published = Object.values(TOOL_GROUPS).reduce(
      (sum, group) => sum + Object.keys(group.actions).length,
      0,
    );
    expect(Object.keys(RESPONSE_FORMS)).toHaveLength(published);
    for (const form of Object.values(RESPONSE_FORMS)) {
      expect(["ack", "read", "decision"]).toContain(form.kind);
      expect(form.max).toBeGreaterThan(0);
    }
  });

  it("answers a write with its identifier, never the event's type nor its time", () => {
    const event = {
      id: "01M4GEK9C006KMT31Z4RTXS74S",
      type: "story.status_changed",
      at: "2026-10-09T13:45:45.600Z",
    };
    for (const name of Object.keys(RESPONSE_FORMS).filter(
      (n) => RESPONSE_FORMS[n]?.kind === "ack",
    )) {
      const [tool, action] = name.split(".") as [string, string];
      const answer = shape(tool, action, event);
      expect(answer, name).toEqual({ id: event.id });
      expect(size(answer), name).toBeLessThanOrEqual(RESPONSE_FORMS[name]?.max ?? 0);
    }
  });

  it("keeps the identifiers a write created: the checkpoint it opened, the sprint, the deferred item", () => {
    const opened = shape("checkpoint", "open", {
      id: "01M4GEK9C006KMT31Z4RTXS74S",
      type: "checkpoint.opened",
      at: "2026-10-09T13:45:45.600Z",
      checkpoint: "G-ABCDEF1234",
      auto_applied: { checkpoint: "G-ABCDEF1234", option: "a" },
    });
    expect(opened).toEqual({
      id: "01M4GEK9C006KMT31Z4RTXS74S",
      checkpoint: "G-ABCDEF1234",
      auto_applied: { checkpoint: "G-ABCDEF1234", option: "a" },
    });
    expect(size(opened)).toBeLessThanOrEqual(RESPONSE_FORMS["checkpoint.open"]?.max ?? 0);
  });

  it("drops what is empty or null, and keeps false and zero", () => {
    expect(
      compact({ a: null, b: "", c: [], d: {}, e: false, f: 0, g: [null, 1], h: { i: null } }),
    ).toEqual({ e: false, f: 0, g: [1] });
    // A reference to an event is its identifier; a checkpoint's `{ id, type }` is not one.
    expect(
      compact({ event: { id: "01M", at: "2026" }, point: { id: "G-1", type: "decision" } }),
    ).toEqual({
      event: "01M",
      point: { id: "G-1", type: "decision" },
    });
  });

  it("never rewrites a text of the creator or of an agent", () => {
    const quote = "  « oui », mais   garde ${le} \\n tel quel ";
    const answer = shape("chat", "answer", {
      id: "01M",
      type: "x.y",
      at: "2026",
      quote,
      note: quote,
    });
    expect(answer.quote).toBe(quote);
    expect(answer.note).toBe(quote);
    const story = shape("state", "get", {
      detail: "story",
      story: "1-1",
      state: { progress: { agent: "sam", percent: 10, note: quote, at: "2026" } },
      checkpoints: {
        "G-1": {
          id: "G-1",
          type: "decision",
          status: "resolved",
          title: quote,
          resolution: { decision: "approved", note: quote },
        },
      },
    });
    expect(story.state.progress.note).toBe(quote);
    expect(story.checkpoints["G-1"]).toContain(quote);
  });
});

describe("what a read gives", () => {
  it("state.get gives the summary of the build phase in under 2 000 characters, with what makes decide", () => {
    const answer = shape("state", "get", STATE_GET);
    expect(size(answer)).toBeLessThan(size(STATE_GET) * 0.75);
    expect(size(answer)).toBeLessThanOrEqual(RESPONSE_FORMS["state.get"]?.max ?? 0);
    expect(answer.stories).toEqual(STATE_GET.stories);
    expect(answer.agents).toEqual(STATE_GET.agents);
    expect(answer.sprint).toBe(STATE_GET.sprint);
    expect(answer.refused_checkpoints).toEqual(STATE_GET.refused_checkpoints);
    // The phases stay: the planning skills check which are closed.
    expect(answer.phase).toEqual(STATE_GET.phase);
    expect(answer.clock).toEqual({
      now_local: "2026-10-09 09:45:00 -04:00",
      time_zone: "America/Toronto",
    });
    // The points of validation and the Git workflow the agents read stay whole.
    const { delegated: _none, ...points } = STATE_GET.validation.points;
    expect(answer.validation.points).toEqual(points);
    expect(answer.validation.mode).toBe("chat");
    expect(answer.git.story_branches).toBe(true);
    expect(answer.engine_version).toBe("0.1.0");
    // What says nothing: empty lists, nulls, times, the channels (state.next gives them).
    for (const gone of [
      "agents_idle",
      "merged_order",
      "open_checkpoints",
      "journey",
      "session_trusted",
    ]) {
      expect(answer, gone).not.toHaveProperty(gone);
    }
    expect(answer.validation).not.toHaveProperty("channels");
    expect(answer.git).not.toHaveProperty("recommended");
    expect(answer.installs).toEqual({ mode: "visible" });
  });

  it("says a warning, the hint and the backup's instruction once per session", () => {
    const memory = new ResponseMemory();
    const first = shape("state", "get", STATE_GET, memory);
    expect(first.warnings).toEqual(STATE_GET.warnings);
    expect(first.more).toBe(STATE_GET.more);
    expect(first.journal_backup.action).toBe(STATE_GET.journal_backup.action);
    const second = shape("state", "get", STATE_GET, memory);
    expect(second).not.toHaveProperty("warnings");
    expect(second).not.toHaveProperty("more");
    expect(second.journal_backup).toEqual({ status: "blocked", reason: "no_remote" });
    expect(size(second)).toBeLessThan(size(first) - 400);
    // Another session has not been told yet; a new warning is said when it appears.
    expect(shape("state", "get", STATE_GET).warnings).toEqual(STATE_GET.warnings);
    const changed = { ...STATE_GET, warnings: [{ code: "sensitive_unreadable", count: 23 }] };
    expect(shape("state", "get", changed, memory).warnings).toEqual(changed.warnings);
    // An instruction that comes back with another status is said again.
    const offline = {
      ...STATE_GET,
      journal_backup: { status: "offline", action: "Not an incident." },
    };
    expect(shape("state", "get", offline, memory).journal_backup.action).toBe("Not an incident.");
  });

  it("says the offer of a critique once per session, and again for another document", () => {
    const memory = new ResponseMemory();
    const offer = { kind: "prd", why: "security_requirements" };
    expect(shape("state", "next", { ...STATE_NEXT, critique: offer }, memory).critique).toEqual(
      offer,
    );
    expect(shape("state", "next", { ...STATE_NEXT, critique: offer }, memory)).not.toHaveProperty(
      "critique",
    );
    const other = { kind: "architecture", why: "sensitive_data" };
    expect(shape("state", "next", { ...STATE_NEXT, critique: other }, memory).critique).toEqual(
      other,
    );
  });

  it("state.next gives the step and the channels the decisions read, and nothing idle", () => {
    const answer = shape("state", "next", STATE_NEXT);
    expect(size(answer)).toBeLessThanOrEqual(RESPONSE_FORMS["state.next"]?.max ?? 0);
    expect(answer).toMatchObject({
      agent: "sam",
      story: "1-1",
      checkpoint: "G-V7K0K2RHRE",
      phase: "build",
      step: "changes_requested",
      engine_version: "0.1.0",
    });
    expect(answer.validation.channels).toEqual(STATE_NEXT.validation.channels);
    expect(answer.validation.points).toEqual({
      configured: false,
      fixed: STATE_NEXT.validation.points.fixed,
      proposed: STATE_NEXT.validation.points.proposed,
    });
    for (const gone of [
      "you",
      "agent_name",
      "phases",
      "pile",
      "morning",
      "waiting",
      "stray",
      "decisions",
    ]) {
      expect(answer, gone).not.toHaveProperty(gone);
    }
    // The morning's report is sent once it holds something.
    const busy = shape("state", "next", {
      ...STATE_NEXT,
      morning: { since: "2026-10-09T00:30:35.558Z", done: [{ story: "1-1" }], done_total: 1 },
    });
    expect(busy.morning).toEqual({
      since: "2026-10-09T00:30:35.558Z",
      done: [{ story: "1-1" }],
      done_total: 1,
    });
  });

  it("a story's detail tells the settled checkpoints in a line, the open ones whole", () => {
    const answer = shape("state", "get", {
      detail: "story",
      story: "1-1",
      state: {
        status: "in_review",
        started: {
          agent: "sam",
          branch: "feat/1-1",
          base: "59c77c48f7c7",
          device: "machine:kBY",
          at: "2026-10-04",
          event: "01M43",
        },
        ci: { status: "waived", commit: "ac558c6e1c93f1a2b3c4d5e6", at: "2026", event: "01M4" },
      },
      checkpoints: {
        "G-OPEN": {
          id: "G-OPEN",
          type: "decision",
          status: "open",
          title: "Which colour?",
          summary: "Blue or red",
          opened_at: "2026",
        },
        "G-DONE": {
          id: "G-DONE",
          type: "permission",
          risk: "high",
          status: "resolved",
          title: "Install a dependency",
          summary: "A long summary the line does not need",
          resolution: { decision: "approved", at: "2026", source: "chat", relayed_by: "noah" },
          abridged: true,
        },
      },
    });
    expect(answer.state.started).toEqual({ agent: "sam", branch: "feat/1-1" });
    expect(answer.state.ci).toEqual({ status: "waived", commit: "ac558c6e1c93" });
    expect(answer.checkpoints["G-OPEN"]).toMatchObject({ status: "open", summary: "Blue or red" });
    expect(answer.checkpoints["G-DONE"]).toBe(
      "G-DONE · permission · high · resolved · approved · Install a dependency",
    );
  });

  it("keeps the documents and the supersessions of the page of checkpoints, and what a line cannot say", () => {
    const page = shape("state", "get", {
      detail: "checkpoints",
      checkpoints: [
        {
          id: "G-DOC",
          type: "document",
          status: "resolved",
          title: "The PRD",
          documents: [{ path: ".agentplugged/docs/prd.md", branch: "main", blob_sha: "abc123" }],
          supersedes: "G-OLD",
          resolution: { decision: "approved", assurance: "local", at: "2026-10-09T00:00:00Z" },
          opened_at: "2026-10-08T00:00:00Z",
        },
      ],
    });
    // The page is read to know whether a document is approved: nothing but the bookkeeping goes.
    expect(page.checkpoints[0]).toEqual({
      id: "G-DOC",
      type: "document",
      status: "resolved",
      title: "The PRD",
      documents: [{ path: ".agentplugged/docs/prd.md", branch: "main", blob_sha: "abc123" }],
      supersedes: "G-OLD",
      resolution: { decision: "approved", assurance: "local" },
    });
    // The line of a settled point in a story says the option chosen and the blocks that stay.
    const story = shape("state", "get", {
      detail: "story",
      story: "1-1",
      state: { pull_request: { number: 2, head: "ac558c6e1c93f1a2b3c4d5e6", base: "59c77c48" } },
      checkpoints: {
        "G-A": {
          id: "G-A",
          type: "decision",
          status: "resolved",
          title: "Which colour?",
          resolution: { decision: "option_chosen", option: "b" },
        },
        "G-B": {
          id: "G-B",
          type: "permission",
          status: "resolved",
          title: "Reset the base",
          blocks_lifted: false,
          blocks_count: 1,
          resolution: { decision: "rejected" },
        },
      },
    });
    expect(story.checkpoints["G-A"]).toContain("option_chosen · b");
    expect(story.checkpoints["G-B"]).toContain("blocks kept");
    // The head of the pull request is kept, to compare a review with it, in the length Git shows.
    expect(story.state.pull_request.head).toBe("ac558c6e1c93");
  });

  it("leaves the other options of state.get whole: they are the detail asked for", () => {
    const full = {
      detail: "full",
      checkpoints: { "G-1": { resolution: { assurance: "chat", source: "chat" } } },
      empty: [],
    };
    expect(shape("state", "get", full)).toEqual(full);
    const agent = {
      detail: "agent",
      agent: "sam",
      state: { last_signal_at: "2026-10-09T13:45:45.927Z", task: null },
    };
    expect(shape("state", "get", agent)).toEqual(agent);
  });

  it("the trace's overview leaves out the counts at zero", () => {
    const answer = shape("state", "trace", {
      action: "overview",
      requirements: [
        {
          id: "EF-1",
          text: "Un utilisateur peut enregistrer une recette.",
          status: "todo",
          stories: ["2-1"],
          tests: 0,
          pull_requests: 0,
          deviations: 0,
        },
        {
          id: "EF-2",
          text: "Autre.",
          status: "done",
          stories: ["2-2"],
          tests: 3,
          pull_requests: 1,
          deviations: 0,
        },
      ],
    });
    expect(answer.requirements[0]).toEqual({
      id: "EF-1",
      text: "Un utilisateur peut enregistrer une recette.",
      status: "todo",
      stories: ["2-1"],
    });
    expect(answer.requirements[1]).toMatchObject({ tests: 3, pull_requests: 1 });
    expect(answer.requirements[1]).not.toHaveProperty("deviations");
  });

  it("passes an unknown action's answer as it is", () => {
    const value = { a: null };
    expect(shapeResponse("nope", "nope", value, new ResponseMemory())).toBe(value);
  });
});
