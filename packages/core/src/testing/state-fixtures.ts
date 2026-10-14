import type { FullStateView } from "../agent-activity/agent-commands.js";
import type {
  AgentState,
  InstanceState,
  ResultEntry,
  StoryState,
} from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { DelegationEntry } from "../projection/delegation-reducers.js";
import { answer, checkpointState } from "./checkpoint-state.js";

/**
 * A complete state of a product that lived for weeks, for tests (never built): as large as the
 * one of the demo after six hours (38 checkpoints, 19 agents, 100 handovers) or several times
 * larger, with the lengths of text real agents write.
 */
export interface StateSize {
  readonly checkpoints: number;
  readonly stories: number;
  /** How many of the checkpoints are still open. */
  readonly open?: number;
  /** Every optional field of the state present at least once (the invariant tests walk them). */
  readonly rich?: boolean;
  readonly agents?: number;
  readonly delegations?: number;
  /** Characters of a summary, a result, a brief. */
  readonly text?: number;
}

/** What the demo of 2026-10-04 weighed: 38 checkpoints, a few stories. */
export const DEMO_SIZE: StateSize = { checkpoints: 38, stories: 4, open: 2 };

const AGENTS = [
  "iris",
  "maya",
  "stella",
  "alex",
  "chloe",
  "izzy",
  "sam",
  "ethan",
  "hugo",
  "lina",
  "jade",
  "quentin",
  "tess",
  "omar",
  "zoe",
  "lou",
  "julien",
  "milo",
  "noah",
];

/** A text of about `length` characters, each one different. */
export function words(seed: string, length: number): string {
  let text = "";
  let n = 0;
  while (text.length < length) {
    text += `${seed} point ${n} : une phrase de la longueur de celles que les agents écrivent dans un résultat. `;
    n += 1;
  }
  return text.slice(0, length).trimEnd();
}

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID that sorts by `n`. */
export function ulid(n: number): string {
  let rest = n;
  let tail = "";
  for (let i = 0; i < 10; i++) {
    tail = ULID_CHARS.charAt(rest % 32) + tail;
    rest = Math.floor(rest / 32);
  }
  return `01M43XAJ69T2M7V1${tail}`;
}

const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 8, 0, 0) + n * 60_000).toISOString();

function result(agent: string, story: string | null, n: number, text: number): ResultEntry {
  return {
    agent,
    story,
    status: "complete",
    summary: words(`${agent} résumé`, text),
    assumptions: [words(`${agent} hypothèse`, 200), words(`${agent} hypothèse bis`, 200)],
    open_questions: [words(`${agent} question`, 250)],
    conflicts: [words(`${agent} conflit`, 250)],
    at: at(n),
  };
}

/** A checkpoint the way the projection keeps it: documents, options, a proof, an untrusted mark. */
export function bigCheckpoint(n: number, open: boolean, text: number, story: string | null) {
  const id = `G-${ulid(n).slice(-10)}`;
  const base = checkpointState(id, {
    type:
      n % 3 === 0
        ? "decision"
        : n % 7 === 1
          ? "phase_end"
          : n % 11 === 2
            ? "publication"
            : "document",
    risk: n % 7 === 0 ? "high" : "medium",
    title: words(`Point ${n}`, 70),
    summary: words(`Résumé du point ${n}`, text),
    story,
    documents: [1, 2, 3, 4, 5].map((k) => ({
      path: `.agentplugged/stories/${n}-${k}.md`,
      branch: "main",
      blob_sha: `${n.toString(16).padStart(8, "0")}${"a".repeat(32)}`,
    })),
    blocks: story === null ? [] : [{ action: "story.review", story }],
    options:
      n % 3 === 0
        ? [1, 2, 3].map((k) => ({
            id: `option-${k}`,
            label: `Option ${k}`,
            consequence: words(`Conséquence ${k}`, 160),
          }))
        : null,
    recommendation: n % 3 === 0 ? "option-2" : null,
    opened_by: AGENTS[n % AGENTS.length] ?? "iris",
    opened_at: at(n),
    opened_event: ulid(n),
    provenance: "untrusted",
    untrusted: {
      internet: "ask",
      reads: [
        { tool: "Bash", source: "cat >" },
        { tool: "Bash", source: "git add" },
        { tool: "Bash", source: "Bash" },
      ],
    },
  });
  if (open) return base;
  return {
    ...base,
    status: "resolved" as const,
    blocks_lifted: true,
    resolution: answer("approved", at(n + 5), {
      by: "machine:kBY_lrTtcfoJsYfq",
      assurance: "chat",
      source: "chat",
      quote: "oui",
      relayed_by: "noah",
      note: n % 5 === 0 ? words(`Note du créateur ${n}`, 600) : null,
      proof: { message: { at: at(n + 4), digest: "3a".repeat(32) } },
    }),
  } satisfies CheckpointState;
}

/** A complete state of the given size. */
export function fullState(size: StateSize): FullStateView {
  const text = size.text ?? 600;
  const agentIds = AGENTS.slice(0, size.agents ?? AGENTS.length);
  const agents: Record<string, AgentState> = {};
  agentIds.forEach((id, index) => {
    agents[id] = {
      status: "idle",
      task: words(`${id} tâche`, 80),
      story: null,
      last_signal_at: at(index),
      last_result: result(id, null, index, text),
    };
  });

  const stories: Record<string, StoryState> = {};
  const instances: Record<string, InstanceState> = {};
  const merged = Math.floor(size.stories * 0.6);
  for (let i = 0; i < size.stories; i++) {
    const id = `${1 + Math.floor(i / 10)}-${(i % 10) + 1}`;
    const done = i < merged;
    const sam = "sam";
    stories[id] = {
      status: done ? "in_review" : i % 4 === 0 ? "blocked" : "in_progress",
      status_by: { agent: sam, at: at(100 + i) },
      progress: { agent: sam, percent: 40, note: words(`Avancement ${id}`, 300), at: at(100 + i) },
      results: {
        [sam]: result(sam, id, 100 + i, text),
        quentin: result("quentin", id, 101 + i, text),
      },
      waiting_on: [],
      started: {
        agent: sam,
        branch: `feat/${id}-travail`,
        base: "a".repeat(40),
        base_ref: "main",
        worktree: `.claude/worktrees/${id}`,
        device: "machine:abc",
        at: at(90 + i),
        event: ulid(900 + i),
      },
      ci: {
        status: "pass",
        forge: "github",
        checks: 5,
        failed: [],
        pr: 100 + i,
        url: `https://example.test/pr/${100 + i}`,
        commit: "b".repeat(40),
        at: at(110 + i),
        event: ulid(910 + i),
        by: "sam",
      },
      pull_request: {
        forge: "github",
        number: 100 + i,
        url: `https://example.test/pr/${100 + i}`,
        branch: `feat/${id}-travail`,
        base: "main",
        head: "b".repeat(40),
        criteria: [true, true, true],
        tests: "pass",
        tests_summary: words("Tests", 300),
        body_sha256: "c".repeat(64),
        by: "sam",
        at: at(111 + i),
        event: ulid(920 + i),
      },
      review: {
        passes: [1, 2].map((number) => ({
          number,
          commit: "b".repeat(40),
          since: at(100 + i),
          reviews: {},
        })),
      },
      ...(done
        ? {
            merged: {
              checkpoint: `G-${ulid(i).slice(-10)}`,
              forge: "github",
              pr: 100 + i,
              url: `https://example.test/pr/${100 + i}`,
              commit: "b".repeat(40),
              merge_commit: "d".repeat(40),
              method: "squash",
              files: Array.from({ length: 30 }, (_, k) => `src/${id}/fichier-${k}.ts`),
              files_truncated: false,
              source: "chat",
              already: false,
              by: "noah",
              at: at(200 + i),
              event: ulid(930 + i),
              seq: i + 1,
            },
          }
        : {}),
    } as unknown as StoryState;
    // The review passes carry the engine's own summary in the abridged state.
    (stories[id] as unknown as { review: unknown }).review = {
      passes: [1, 2].map((number) => ({
        number,
        commit: "b".repeat(40),
        complete: true,
        outcome: "approved",
        security: null,
        given: ["qa"],
        reviews: { qa: { verdict: "pass", by: "quentin", findings: 2 } },
        published: true,
      })),
      untriaged: 0,
      done: true,
    };
    instances[`sam/${id}`] = {
      agent: sam,
      story: id,
      status: "working",
      task: words("Instance", 80),
      last_signal_at: at(100 + i),
    };
  }

  const checkpoints: Record<string, CheckpointState> = {};
  const open = size.open ?? 3;
  const storyIds = Object.keys(stories);
  for (let n = 0; n < size.checkpoints; n++) {
    const isOpen = n >= size.checkpoints - open;
    const story = n % 2 === 0 ? (storyIds[n % Math.max(1, storyIds.length)] ?? null) : null;
    const checkpoint = bigCheckpoint(n + 1, isOpen, text, story);
    checkpoints[checkpoint.id] = checkpoint;
  }
  if (size.rich === true) enrich(stories, checkpoints);
  const delegations: DelegationEntry[] = Array.from(
    { length: size.delegations ?? 100 },
    (_, n) => ({
      id: ulid(5000 + n),
      at: at(300 + n),
      from: "noah",
      to: AGENTS[n % AGENTS.length] ?? "iris",
      kind: "agent",
      mode: n % 2 === 0 ? "conversation" : "autonomous",
      story: null,
      brief: words(`Consigne ${n}`, 450),
      provenance: "trusted",
    }),
  );

  const openPoints = Object.values(agents).flatMap((agent) =>
    (agent.last_result?.open_questions ?? []).map((questionText) => ({
      kind: "question" as const,
      text: questionText,
      agent: agent.last_result?.agent ?? "",
      story: null,
    })),
  );

  const standard = { low: 2, expected: 6, high: 14, basis: "reference", stories: 0 };

  return {
    clock: {
      now: at(1000),
      now_local: "2026-10-02 08:00:00 +00:00",
      time_zone: "UTC",
      utc_offset: "+00:00",
    },
    delegations,
    product: ulid(1),
    journal_head: ulid(2),
    agents,
    instances,
    stories,
    checkpoints,
    open_points: openPoints,
    warnings: [],
    phase: {
      current: "build",
      status: "in_progress",
      since: at(50),
      phases: [
        { id: "framing", status: "closed" },
        { id: "planning", status: "closed" },
        { id: "design", status: "closed" },
        { id: "build", status: "in_progress" },
        { id: "delivery", status: "upcoming" },
        { id: "launch", status: "upcoming" },
      ],
      stray: [],
    },
    session: {
      trusted: false,
      reads: Array.from({ length: 30 }, (_, n) => ({ tool: "Bash", source: `commande ${n}` })),
    },
    external_reads: {
      total: 6,
      recent: Array.from({ length: 6 }, (_, n) => ({
        tool: "Bash",
        source: `commande ${n}`,
        agent: "main",
        at: "2026-10-03T12:00:00.000Z",
      })),
    },
    sprint: {
      current: {
        id: "S-1",
        goal: words("But du sprint", 200),
        status: "in_force",
        stories: storyIds.map((id) => ({ id, owner: "sam", budget_usd: 10, status: "todo" })),
        capacity: { agents: ["sam"], humans: 1 },
        budget_usd: 100,
        budget_limit_usd: null,
        checkpoint: Object.keys(checkpoints)[0] ?? "",
        planned_by: "izzy",
        at: at(60),
      },
      latest: null,
    },
    deferred: {
      open:
        size.rich === true
          ? [
              {
                id: "D-1",
                title: "Reprendre la pagination",
                detail: words("Détail du travail reporté", 300),
                origin: "review",
                story: "9-9",
                owner: "sam",
                locks: ["9-9"],
                phase: "build",
                status: "open",
                recorded_by: "quentin",
                recorded_at: at(10),
                event: ulid(8001),
                closed: null,
              },
            ]
          : [],
      done: 0,
      dropped: 0,
    },
    deviations: {
      open:
        size.rich === true
          ? [
              {
                id: "V-1",
                story: "9-9",
                requirements: ["EF-1"],
                summary: "Écart",
                detail: null,
                pr: 100,
                commit: "b".repeat(40),
                status: "open",
                reported_by: "quentin",
                reported_at: at(11),
                event: ulid(8002),
                resolved: null,
              },
            ]
          : [],
      resolved: 0,
    },
    usage: {
      table: { version: "2026-10-06", as_of: "2026-10-06", source: "https://example.test/pricing" },
      estimates: {
        standard,
        fast: { low: 0.3, expected: 1, high: 4, basis: "reference", stories: 0 },
        guard: { low: 0.1, high: 42, factor: 3 },
      },
    },
    validation: {
      mode: "chat",
      source: "main",
      warning: null,
      unpublished: null,
      proof: "hook",
      review: [],
      elicitation: true,
      // The shortest honest answer: the state's size is what the abridged state's tests measure.
      channels: { available: ["chat"], elicitation: "unavailable", question_tool: "unavailable" },
      points: {
        configured: false,
        fixed: ["framing", "architecture", "breakdown", "merge", "release", "publication"],
        delegated: [],
        proposed: ["framing", "architecture", "release", "publication"],
      },
    },
    stacks:
      size.rich === true
        ? [
            {
              id: "S-1",
              opened_by: "noah",
              opened_at: at(12),
              remaining: [{ n: 1, checkpoint: Object.keys(checkpoints)[0] ?? "" }],
              total: 2,
            },
          ]
        : [],
    installs: {
      mode: "visible",
      source: "main",
      warning: null,
      declared: { npm: 12 },
      recent:
        size.rich === true
          ? [
              {
                ecosystem: "npm",
                manager: "npm",
                packages: ["left-pad"],
                manifest: false,
                via: "hook",
                agent: "sam",
                at: at(13),
                event: ulid(8003),
              },
            ]
          : [],
    },
  } as unknown as FullStateView;
}

/** Every optional field of a story and of a checkpoint, once each, for the invariant tests. */
function enrich(stories: Record<string, StoryState>, checkpoints: Record<string, CheckpointState>) {
  const richCheckpoint = {
    ...bigCheckpoint(7777, true, 300, "9-9"),
    criteria: [{ id: "c1", metric: "coverage", op: ">=", threshold: 80, severity: "blocking" }],
    measures: { coverage: { value: 90, measured_by: "quentin", measured_at: at(20) } },
    verdict: { result: "pass", reasons: [], criteria: [] },
    publication: { angle: "Angle", audience: "Public", short_version: "Court" },
    request: { action: "install_dependency", detail: "npm install left-pad" },
    creator_action: { action: "profile" },
    memory: { scope: "epic-1" },
    executed: { event: ulid(8100), at: at(21), source: "chat" },
  } as unknown as CheckpointState;
  checkpoints[richCheckpoint.id] = richCheckpoint;
  const refused = {
    ...bigCheckpoint(7778, false, 300, "9-9"),
    blocks_lifted: false,
    resolution: answer("changes_requested", at(22), {
      note: words("Ce que le créateur veut changer", 400),
      waiver_until: at(23),
      channel: "claude-code",
      stack: "S-1",
      confirmation_quote: "oui",
    }),
  } as unknown as CheckpointState;
  checkpoints[refused.id] = refused;
  stories["9-9"] = {
    status: "blocked",
    status_by: { agent: "sam", at: at(30) },
    progress: { agent: "sam", percent: 10, note: "Début", at: at(30) },
    results: { sam: result("sam", "9-9", 31, 200) },
    waiting_on: [refused.id, richCheckpoint.id],
    started: {
      agent: "sam",
      branch: "feat/9-9-travail",
      base: "a".repeat(40),
      base_ref: "main",
      worktree: ".claude/worktrees/9-9",
      device: "machine:abc",
      at: at(29),
      event: ulid(8200),
    },
    merge_feedback: {
      checkpoint: refused.id,
      decision: "changes_requested",
      note: words("Note du créateur sur la fusion", 400),
      at: at(32),
    },
    fast_track: {
      status: "left",
      agent: "sam",
      summary: "Un petit changement",
      declared: { reason: "typo" },
      entered_at: at(28),
      entered_event: ulid(8201),
      checked: {
        commit: "b".repeat(40),
        count: 5,
        files: ["a.ts", "b.ts"],
        files_truncated: false,
        ok: false,
        reasons: ["too_many_files"],
        at: at(33),
        event: ulid(8202),
      },
      left: {
        by: "engine",
        reasons: ["too_many_files"],
        detail: "5 fichiers",
        commit: "b".repeat(40),
        at: at(34),
        event: ulid(8203),
      },
    },
    conflicts: [
      {
        main: "c".repeat(40),
        head: "b".repeat(40),
        base_ref: "main",
        kind: "textual",
        files: [{ path: "a.ts", class: "code" }],
        files_truncated: false,
        rationale: "Même ligne",
        recommendation: "combine",
        checkpoint: null,
        by: "sam",
        at: at(35),
        event: ulid(8204),
      },
    ],
    ci: {
      status: "fail",
      forge: "github",
      checks: 4,
      failed: ["lint"],
      pr: 200,
      url: "https://example.test/pr/200",
      commit: "b".repeat(40),
      at: at(36),
      event: ulid(8205),
      by: "quentin",
      reason: "une raison",
    },
    pull_request: {
      forge: "github",
      number: 200,
      url: "https://example.test/pr/200",
      branch: "feat/9-9-travail",
      base: "main",
      head: "b".repeat(40),
      criteria: [true],
      tests: "pass",
      tests_summary: null,
      body_sha256: "c".repeat(64),
      by: "sam",
      at: at(37),
      event: ulid(8206),
    },
    review: {
      passes: [
        {
          number: 1,
          commit: "b".repeat(40),
          complete: false,
          outcome: null,
          security: null,
          given: ["qa"],
          reviews: {},
          published: false,
        },
      ],
      untriaged: 1,
      done: false,
    },
  } as unknown as StoryState;
}
