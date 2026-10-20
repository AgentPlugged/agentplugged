import {
  type AgentPluggedError,
  isRetiredDeveloper,
  type NextResult,
  STORY_BUILDERS,
  type ToolId,
  toolName,
} from "@agentplugged/core";
import { isMessageKey, pluralOf, type Translate } from "@agentplugged/i18n";
import { displayText } from "./history-text.js";
import { fastTrackReasons } from "./story-text.js";
import { stagingLine } from "./workflow-flow.js";

/**
 * How the creator calls an agent in a tool: `/iris` in Claude Code (its skill), `@agent-iris` in
 * Antigravity CLI and Cursor (their sub-agents), and by its name in Codex, which has no command.
 */
export function agentCall(tool: ToolId, id: string): string | undefined {
  switch (tool) {
    case "claude-code":
      return `/${id}`;
    case "antigravity":
    case "cursor":
      return `@agent-${id}`;
    case "codex":
      return undefined;
  }
}

/** The step line, after the current phase when there is one: `Phase: … · Step: …`. */
function phaseLine(t: Translate, result: NextResult): string {
  const step = stepLine(t, result);
  if (result.phase === null) return step;
  const key = `next.phase.${result.phase}`;
  return t("next.phase", { phase: isMessageKey(key) ? t(key) : result.phase, step });
}

function stepLine(t: Translate, result: NextResult): string {
  const key = `next.step.${result.step}`;
  const step = isMessageKey(key) ? t(key) : result.step;
  if (result.story !== null) {
    return t("next.step.story", { step, story: displayText(result.story) });
  }
  if (result.sync !== null) {
    const reason =
      result.sync === "tool_missing"
        ? t("next.sync.tool_missing", { tools: result.missing_tools.map(toolName).join(", ") })
        : t(`next.sync.${result.sync}`);
    return t("next.step.reason", { step, reason });
  }
  const [key0] = result.pending_keys;
  if (result.step === "key_endorsement" && key0 !== undefined) {
    const keyText = displayText(key0);
    const reason =
      result.pending_keys.length === 1
        ? t("next.keys.one", { key: keyText })
        : t("next.keys.other", { count: result.pending_keys.length, key: keyText });
    return t("next.step.reason", { step, reason });
  }
  return t("next.step", { step });
}

/**
 * An agent as the creator reads it: a developer on a story is an instance, named by
 * the pair (« Sam · story 4-2 »); a developer the renaming retired says so.
 */
export function agentLabel(
  t: Translate,
  agent: string,
  name: string,
  story: string | null | undefined,
): string {
  if (isRetiredDeveloper(agent)) return t("agent.retired", { name });
  if (story !== null && story !== undefined && STORY_BUILDERS.includes(agent)) {
    return t("agent.instance", { name, story });
  }
  return name;
}

function agentLine(t: Translate, result: NextResult): string {
  if (result.you) return t("next.agent.creator");
  if (result.agent === null) return t("next.agent.none");
  const id = displayText(result.agent);
  const name = agentLabel(
    t,
    result.agent,
    displayText(result.agent_name ?? result.agent),
    result.story === null ? null : displayText(result.story),
  );
  if (result.tool === null) return t("next.agent.no_tool", { name });
  const tool = toolName(result.tool);
  const call = agentCall(result.tool, id);
  return call === undefined
    ? t("next.agent.name_it", { name, tool })
    : t("next.agent.call", { name, call, tool });
}

function waitingLine(t: Translate, result: NextResult): string {
  const first = result.waiting[0];
  if (first === undefined) return t("next.waiting.none");
  const id = displayText(first.id);
  const title = displayText(first.title).trim();
  return result.waiting.length === 1
    ? t("next.waiting.one", { id, title })
    : t("next.waiting.other", { count: result.waiting.length, id, title });
}

/** The sprint in force, when there is one: its goal and how many stories are done. */
function sprintLines(t: Translate, result: NextResult): string[] {
  const sprint = result.sprint;
  if (sprint === null) return [];
  const params = { goal: displayText(sprint.goal), done: sprint.done, total: sprint.total };
  return [t(`next.sprint.${pluralOf(t, sprint.done)}`, params)];
}

/** A phase by its name (`next.phase.*`), « aucune » for none. */
function phaseName(t: Translate, phase: string | null): string {
  const key = `next.phase.${phase ?? "none"}`;
  return isMessageKey(key) ? t(key) : displayText(phase ?? "");
}

/** One warning line per end of phase left aside (another phase's, approved out of turn). */
function strayLines(t: Translate, result: NextResult): string[] {
  return result.stray.map((entry) =>
    t(`next.stray.${entry.reason}`, {
      id: displayText(entry.checkpoint),
      phase: phaseName(t, entry.phase),
      current: phaseName(t, result.phase),
    }),
  );
}

/**
 * What `next` shows: three lines (the current phase and the step, the agent to call and where,
 * what waits for the creator), then the sprint in force when there is one, then a
 * line with the command when the step has one, then a
 * warning per end of phase left aside. Every text from the
 * journal or the definitions goes through `displayText`.
 */
export function formatNext(t: Translate, result: NextResult): string {
  const lines = [
    phaseLine(t, result),
    agentLine(t, result),
    waitingLine(t, result),
    ...sprintLines(t, result),
  ];
  // The deferred item that locks a story: the one to treat, or a story left aside.
  const lock = result.deferred;
  if (lock !== null) {
    lines.push(
      t("next.deferred.locked", {
        story: displayText(lock.story),
        item: displayText(lock.item),
        title: displayText(lock.title),
        command: displayText(lock.command),
      }),
    );
  }
  // The story's CI: the failed checks, and its pull request.
  const ci = result.ci;
  if (ci !== undefined && ci.failed.length > 0) {
    lines.push(t("next.ci.failed", { failed: ci.failed.map(displayText).join(", ") }));
  }
  if (ci !== undefined && ci.url !== null) {
    lines.push(t("next.ci.url", { url: displayText(ci.url) }));
  }
  // Why the CI cannot be read, and the creator's way out when the command is another one.
  if (ci?.cause === "no_ci") lines.push(t("next.ci.no_ci"));
  if (ci?.waive === true) lines.push(t("next.ci.waive"));
  // The creator's refusal of the story's merge, and their note.
  const feedback = result.merge_feedback;
  if (feedback !== undefined) {
    lines.push(
      t(`next.merge_feedback.${feedback.decision}`, {
        checkpoint: displayText(feedback.checkpoint),
      }),
    );
    if (feedback.note !== null) {
      lines.push(t("next.merge_feedback.note", { note: displayText(feedback.note) }));
    }
  }
  // A deliverable the creator sent back: their instruction goes back to its agent.
  const sentBack = result.publication_feedback;
  if (sentBack !== undefined) {
    lines.push(
      t(
        sentBack.agent_inactive
          ? "next.publication_feedback.inactive"
          : "next.publication_feedback.sent_back",
        {
          checkpoint: displayText(sentBack.checkpoint),
          title: displayText(sentBack.title),
          agent: displayText(result.agent_name ?? sentBack.agent ?? "?"),
        },
      ),
    );
    if (sentBack.note !== null) {
      lines.push(t("next.merge_feedback.note", { note: displayText(sentBack.note) }));
    }
  }
  // The story's fast track: a small change, or the way back to the full lane.
  const track = result.fast_track;
  if (track !== undefined) {
    lines.push(
      track.status === "active"
        ? t("next.fast_track.active")
        : t("next.fast_track.left", {
            reasons: fastTrackReasons(t, track.reasons),
            by: t(
              track.left_by === "agent" ? "next.fast_track.by.agent" : "next.fast_track.by.engine",
            ),
          }),
    );
  }
  // A conflict with the main branch to resolve, and the creator's choice.
  const conflict = result.merge_conflict;
  if (conflict !== undefined) {
    const files = conflict.files.map(displayText).join(", ");
    if (conflict.phase === "to_resolve") {
      lines.push(t("next.merge_conflict.textual", { files }));
    } else if (conflict.phase === "decided") {
      const optionKey = `merge.option.${conflict.option ?? ""}`;
      lines.push(
        t("next.merge_conflict.decided", {
          option: isMessageKey(optionKey) ? t(optionKey) : displayText(conflict.option ?? ""),
          checkpoint: displayText(conflict.checkpoint ?? ""),
        }),
      );
    } else {
      lines.push(
        t("next.merge_conflict.refused", { checkpoint: displayText(conflict.checkpoint ?? "") }),
      );
    }
    if (conflict.note !== null) {
      lines.push(t("next.merge_feedback.note", { note: displayText(conflict.note) }));
    }
  }
  // The merge checkpoints waiting, in the order of the merges.
  const queue = result.merge_queue;
  if (queue !== undefined) {
    lines.push(
      t("next.merge_queue", {
        queue: queue.map((entry) => `${entry.position}. ${displayText(entry.story)}`).join(", "),
      }),
    );
  }
  // Pages behind with no notice in them: the creator's Git settings give no commit.
  const latePages = result.late_pages;
  if (latePages !== undefined) {
    lines.push(
      t("next.late_pages", { pages: latePages.map((page) => displayText(page.path)).join(", ") }),
    );
  }
  // Zoé's update beside a story under way: never in place of the step.
  const background = result.background;
  if (background !== undefined) {
    lines.push(
      t("next.background", {
        agent: displayText(background.agent_name),
        pages: background.pages.map((page) => displayText(page)).join(", "),
      }),
    );
  }
  // The story's review: each kind, the reviewers to launch, the findings to sort.
  const review = result.review;
  if (review !== undefined) {
    lines.push(
      t("next.review.pass", {
        pass: review.pass,
        qa: t(`next.review.state.${review.qa}`),
        security: t(`next.review.state.${review.security}`),
      }),
    );
    if (review.reviewers.length > 0) {
      lines.push(
        t("next.review.reviewers", { reviewers: review.reviewers.map(displayText).join(", ") }),
      );
    }
    if (review.qa === "unavailable") lines.push(t("next.review.no_reviewer"));
    if (review.untriaged > 0) lines.push(t("next.review.untriaged", { count: review.untriaged }));
  }
  // The points the creator keeps: work that goes on without them, or where it stops.
  if (result.independent === true) lines.push(t("next.independent"));
  if (result.paused !== undefined) {
    lines.push(
      t(result.paused.reason === "emergency_stop" ? "next.paused.stopped" : "next.paused", {
        since: displayText(result.paused.since),
      }),
    );
  } else if (result.stop === true) {
    lines.push(t("next.stop"));
  }
  const morning = result.morning;
  if (morning !== undefined && morning.done_total + morning.decided_total > 0) {
    lines.push(
      t("next.morning", {
        done: morning.done_total,
        decided: morning.decided_total,
        waiting: morning.waiting.length,
      }),
    );
  }
  // The steps the creator skipped: their choice, shown as such, never as errors.
  const skipped = result.journey?.skipped ?? [];
  if (skipped.length > 0) {
    lines.push(
      t("next.journey.skipped", {
        steps: skipped
          .map((entry) => {
            const key = `journey.step.${entry.step}`;
            const name = isMessageKey(key) ? t(key) : displayText(entry.step);
            return entry.story === null ? name : `${name} (${displayText(entry.story)})`;
          })
          .join(", "),
      }),
    );
  }
  // What waits in staging (`main` + `dev`) and whether it is time to release it.
  if (result.git !== undefined) {
    const staging = stagingLine(t, result.git);
    if (staging !== undefined) lines.push(staging);
  }
  // Where the creator answers: in the chat, but `review` for a high risk at the
  // `strict` level. The `strict` level is spoken of only when it is the level; since
  // Nothing else sends the creator to the terminal.
  if (result.command !== null && result.answer === "chat") {
    lines.push(t("next.answer.chat"));
  } else if (result.command !== null && result.answer === "terminal") {
    lines.push(
      t(result.answer_reason === "strict" ? "next.answer.terminal" : "next.command", {
        command: result.command,
      }),
    );
  } else if (result.command !== null) {
    lines.push(t("next.command", { command: result.command }));
  }
  lines.push(...strayLines(t, result));
  return `${lines.join("\n")}\n`;
}

/**
 * `next --json`: the step as data, values exact (JSON escaping is enough): `step`, `you`,
 * `agent`, `agent_name`, `tool`, `waiting`, `command`, `story`, `checkpoint`, `sync`,
 * `missing_tools`, `pending_keys`, `phase` (the current phase, or null), `phases` (each phase
 * with its status), `stray` (the ends of phase left aside), `sprint`, `deferred` (the lock of
 * a story: the item a `deferred_work` step treats, or the lock of a story left aside; or null),
 * `ci` on a
 * `ci_failed` or `ci_check` step only, `review` on a `review` or `review_triage` step
 * only.
 */
export function nextJson(result: NextResult): string {
  return `${JSON.stringify(
    {
      step: result.step,
      you: result.you,
      agent: result.agent,
      agent_name: result.agent_name,
      tool: result.tool,
      waiting: result.waiting.map(({ id, title, type, risk }) => ({ id, title, type, risk })),
      command: result.command,
      // Where the creator answers the step's checkpoint: `chat`, `terminal` or null.
      answer: result.answer ?? null,
      // Why the terminal: `strict` (the only reason); absent otherwise.
      ...(result.answer_reason === undefined ? {} : { answer_reason: result.answer_reason }),
      story: result.story,
      checkpoint: result.checkpoint,
      sync: result.sync,
      missing_tools: result.missing_tools,
      pending_keys: result.pending_keys,
      phase: result.phase,
      phases: result.phases.map(({ id, status }) => ({ id, status })),
      stray: result.stray.map(({ checkpoint, phase, reason }) => ({ checkpoint, phase, reason })),
      sprint:
        result.sprint === null
          ? null
          : {
              id: result.sprint.id,
              goal: result.sprint.goal,
              done: result.sprint.done,
              total: result.sprint.total,
            },
      deferred:
        result.deferred === null
          ? null
          : {
              item: result.deferred.item,
              title: result.deferred.title,
              story: result.deferred.story,
              command: result.deferred.command,
            },
      // On a step that names a story in or out of the fast track.
      ...(result.fast_track === undefined
        ? {}
        : {
            fast_track: {
              status: result.fast_track.status,
              left_by: result.fast_track.left_by,
              reasons: [...result.fast_track.reasons],
            },
          }),
      // On a `changes_requested` step of a deliverable only.
      ...(result.publication_feedback === undefined
        ? {}
        : { publication_feedback: { ...result.publication_feedback } }),
      // On a `retrospective` step only: the epic or sprint to look back on.
      ...(result.scope === undefined ? {} : { scope: { ...result.scope } }),
      // On a `memory_record` step only: `retrospective` (record_lessons) or `promotion` (promote_lesson).
      ...(result.memory_kind === undefined ? {} : { memory_kind: result.memory_kind }),
      // On a `ci_failed` or `ci_check` step only.
      ...(result.ci === undefined
        ? {}
        : {
            ci: {
              status: result.ci.status,
              failed: [...result.ci.failed],
              pr: result.ci.pr,
              url: result.ci.url,
              cause: result.ci.cause,
              waive: result.ci.waive,
            },
          }),
      // The point an agent decides, the work that goes on without the creator, where
      // it stops, the single stack of what waits for them and what the night did.
      ...(result.point === undefined ? {} : { point: { ...result.point } }),
      ...(result.independent === true ? { independent: true } : {}),
      ...(result.stop === true ? { stop: true } : {}),
      ...(result.paused === undefined ? {} : { paused: { ...result.paused } }),
      ...(result.pile === undefined
        ? {}
        : {
            pile: {
              stack: [...result.pile.stack],
              apart: [...result.pile.apart],
              more: result.pile.more,
            },
          }),
      ...(result.morning === undefined ? {} : { morning: result.morning }),
      // The steps the creator skipped.
      ...(result.journey === undefined ? {} : { journey: result.journey }),
      // The creator's Git workflow, and what waits in staging.
      ...(result.git === undefined ? {} : { git: result.git }),
      // On a `review` or `review_triage` step only.
      ...(result.review === undefined
        ? {}
        : {
            review: {
              pass: result.review.pass,
              qa: result.review.qa,
              security: result.review.security,
              reviewers: [...result.review.reviewers],
              untriaged: result.review.untriaged,
            },
          }),
    },
    null,
    2,
  )}\n`;
}

/** `next --json` when it fails: `{ "error": { code, message_key, details } }`. */
export function nextJsonError(error: AgentPluggedError): string {
  return `${JSON.stringify({ error: error.toPayload() }, null, 2)}\n`;
}
