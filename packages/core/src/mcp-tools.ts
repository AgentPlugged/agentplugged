/**
 * The tools of the `agentplugged` MCP server, grouped by domain: ten tools, each with
 * an `action` field, in place of the forty-six one-action tools the server used to publish. Only
 * the dress of the commands changes: each action runs the engine command of the same capability
 * (`command`), through the same registry, with the same validation, the same refusals (the
 * role checks included) and the same events in the journal.
 *
 * A field of the old tool named `action` is published as `what` (the group's own `action` field
 * says which action runs); `rename` maps a published field to the command's field.
 */
export interface ToolAction {
  /** The engine command this action runs. */
  readonly command: string;
  /** Published field -> the command's field (applied to the input before the command runs). */
  readonly rename?: Readonly<Record<string, string>>;
}

export interface ToolGroup {
  /** What the group is for, for the reference (the published description is shorter). */
  readonly summary: string;
  readonly actions: Readonly<Record<string, ToolAction>>;
}

const WHAT = { what: "action" } as const;

/** The correspondence « old tool -> new tool and action », the single source of the grouping. */
export const TOOL_GROUPS: Readonly<Record<string, ToolGroup>> = {
  state: {
    summary:
      "Read where the product stands. An empty or null field is not sent: absent means none. A warning and a hint are said once per session; the options of `get` (`agent`, `checkpoint`, `delegations`, `full`) answer whole.",
    actions: {
      get: { command: "get_state" },
      next: { command: "next" },
      trace: { command: "get_trace" },
      merge_order: { command: "get_merge_order" },
      environment: { command: "check_environment" },
    },
  },
  checkpoint: {
    summary:
      "Open a point of validation, decide one yourself, record its measures, settle a gap of a requirement.",
    actions: {
      open: { command: "open_checkpoint" },
      decide: { command: "decide_checkpoint" },
      measures: { command: "report_measures" },
      gap: { command: "settle_gap" },
    },
  },
  chat: {
    summary: "Ask the creator and record their answers, one point or a stack.",
    actions: {
      answer: { command: "answer_checkpoint" },
      ask: { command: "ask_creator" },
      stack_open: { command: "open_stack" },
      stack_ask: { command: "ask_stack" },
      stack_answer: { command: "answer_stack" },
      table: { command: "round_table" },
    },
  },
  story: {
    summary: "Build, report and deliver a story.",
    actions: {
      start: { command: "start_story" },
      status: { command: "update_story" },
      progress: { command: "report_progress" },
      result: { command: "submit_result" },
      pr: { command: "open_pull_request" },
      ci: { command: "check_ci" },
      deviation: { command: "report_deviation" },
      lift_deviation: { command: "lift_deviation" },
      leave_fast_track: { command: "leave_fast_track" },
      criterion: { command: "record_criterion" },
      loop: { command: "loop" },
      merge_conflict: { command: "qualify_merge_conflict" },
    },
  },
  review: {
    summary:
      "Review a story: start, submit, triage and publish the findings. Submit the audit of a pillar. Critique a deliverable.",
    actions: {
      start: { command: "start_review" },
      submit: { command: "submit_review" },
      triage: { command: "triage_review" },
      get: { command: "get_review" },
      publish: { command: "publish_review" },
      audit: { command: "submit_audit" },
      critique: { command: "critique" },
      ready: { command: "ready" },
      tests: { command: "review_tests" },
      qa: { command: "acceptance_qa" },
      export: { command: "export_review" },
    },
  },
  agent: {
    summary: "Declare your activity and hand work over.",
    actions: {
      status: { command: "report_status" },
      delegate: { command: "delegate" },
      summarize: { command: "summarize" },
      pause: { command: "pause_team" },
      workshop: { command: "workshop" },
    },
  },
  guard: {
    summary: "Actions reserved to the creator, sensitive content and external reads.",
    actions: {
      request: { command: "request_action", rename: WHAT },
      check: { command: "check_action", rename: WHAT },
      external_read: { command: "record_external_read" },
      write: { command: "check_write" },
      call: { command: "check_call" },
      creator_action: { command: "request_creator_action", rename: WHAT },
      read_sensitive: { command: "read_sensitive" },
      write_sensitive: { command: "write_sensitive" },
    },
  },
  plan: {
    summary: "Plan a sprint, keep the deferred work, correct the course.",
    actions: {
      sprint: { command: "plan_sprint" },
      course: { command: "correct_course" },
      defer: { command: "defer_work" },
      complete_deferred: { command: "complete_deferred" },
    },
  },
  memory: {
    summary: "Read the lessons and run a retrospective.",
    actions: {
      read: { command: "read_memory" },
      retrospective: { command: "propose_retrospective" },
      record: { command: "record_lessons" },
      promote_propose: { command: "propose_promotion" },
      promote: { command: "promote_lesson" },
    },
  },
  measure: {
    summary: "Costs and consumption; the register of non-functional requirements and their proofs.",
    actions: {
      cost: { command: "report_cost" },
      usage: { command: "measure_usage" },
      requirements: { command: "sync_requirements" },
      proof: { command: "record_proof" },
      run: { command: "run_proof_command", rename: { source: "command" } },
    },
  },
};

/** Where an engine command is reached through the server. */
export interface ToolCall {
  readonly tool: string;
  readonly action: string;
}

const BY_COMMAND: ReadonlyMap<string, ToolCall> = new Map(
  Object.entries(TOOL_GROUPS).flatMap(([tool, group]) =>
    Object.entries(group.actions).map(
      ([action, spec]) => [spec.command, { tool, action }] as const,
    ),
  ),
);

/** The tool and action that reach an engine command, or undefined for a command not exposed. */
export function toolCallOf(command: string): ToolCall | undefined {
  return BY_COMMAND.get(command);
}

/** The notation of a tool call in the texts agents read: `story.progress`. */
export function toolNotation(call: ToolCall): string {
  return `${call.tool}.${call.action}`;
}

/** The engine command an action of a tool runs, with its published field renames. */
export function commandOf(
  tool: string,
  action: string,
): { readonly command: string; readonly rename: Readonly<Record<string, string>> } | undefined {
  const spec = TOOL_GROUPS[tool]?.actions[action];
  return spec === undefined ? undefined : { command: spec.command, rename: spec.rename ?? {} };
}

/**
 * The call of the grouped tool that replaces a call of an old one-action tool: `report_progress`
 * with `{ story, note }` is `story` with `{ action: "progress", story, note }`. The old field named
 * `action` is published as `what`. Undefined for a command no group holds.
 */
export function toolInputOf(
  command: string,
  input: Readonly<Record<string, unknown>>,
): { readonly tool: string; readonly input: Record<string, unknown> } | undefined {
  const call = BY_COMMAND.get(command);
  if (call === undefined) return undefined;
  const rename = TOOL_GROUPS[call.tool]?.actions[call.action]?.rename ?? {};
  const back = Object.fromEntries(Object.entries(rename).map(([from, to]) => [to, from]));
  const published: Record<string, unknown> = { action: call.action };
  for (const [field, value] of Object.entries(input)) published[back[field] ?? field] = value;
  return { tool: call.tool, input: published };
}

/** Every engine command the server exposes (the old tool names). */
export function exposedCommands(): string[] {
  return [...BY_COMMAND.keys()];
}

/** The tools that carry at least one of the given commands (a role's tools). */
export function toolsOfCommands(commands: ReadonlySet<string>): string[] {
  return Object.keys(TOOL_GROUPS).filter((tool) =>
    Object.values(TOOL_GROUPS[tool]?.actions ?? {}).some((spec) => commands.has(spec.command)),
  );
}

// Names with an underscore are unique; the two plain words are rewritten between backticks only.
const UNDERSCORED = [...BY_COMMAND.keys()].filter((name) => name.includes("_"));
const PLAIN = [...BY_COMMAND.keys()].filter((name) => !name.includes("_"));
const NAME_PATTERN = new RegExp(
  // Not after a dot: `plan.complete_deferred` is already the notation (the text is rewritten once).
  `\`(${PLAIN.join("|")})\`|(?<![\\w.])(${UNDERSCORED.join("|")})\\b`,
  "g",
);

/**
 * `text` with the old one-action tool names written as the grouped tool and action that replace
 * them (`report_progress` -> `story.progress`). The commands keep their names inside the engine;
 * this is what an agent reads.
 */
export function withToolNotation(text: string): string {
  return text.replace(
    NAME_PATTERN,
    (match, plain: string | undefined, named: string | undefined) => {
      const call = toolCallOf(plain ?? named ?? "");
      if (call === undefined) return match;
      return plain === undefined ? toolNotation(call) : `\`${toolNotation(call)}\``;
    },
  );
}
