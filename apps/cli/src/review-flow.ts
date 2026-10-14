import {
  ACTION_DECISIONS,
  type AgentPluggedError,
  ARCHITECTURE_SECURITY_REVIEW_PATH,
  type ArchitectureReview,
  type CheckpointState,
  type CommandContext,
  type CommandRegistry,
  type IntentPreview,
  type KeyResult,
  type MemoryPreview,
  type PresencePrompt,
  type PresenceState,
  parseWaiverAnswer,
  type ReviewAction,
  type ReviewList,
  type ReviewResolved,
  reviewActions,
  waiverDeadlineProblem,
  waiverRefusal,
} from "@agentplugged/core";
import { isMessageKey, type MessageKey, type Translate } from "@agentplugged/i18n";
import {
  contentSections,
  MAX_WAIVED_TOTAL_DAYS,
  MAX_WAIVER_DAYS,
  type ResolutionDecision,
  SHORT_VERSION_TARGET_SECONDS,
} from "@agentplugged/protocol";
import { displayText, localDateTime } from "./history-text.js";
import { formatProductKey } from "./key-flow.js";
import { askChoice, askText, type Prompter } from "./prompt.js";

/** A label of the catalog, or the key itself when the catalog has none. */
function label(t: Translate, key: string): string {
  return isMessageKey(key) ? t(key) : key;
}

/** A checkpoint's type, with the phase an end of phase closes: « fin de phase (Cadrage) ». */
export function typeLabel(
  t: Translate,
  checkpoint: Pick<CheckpointState, "type"> & { readonly phase?: string | null },
): string {
  if (checkpoint.type === "phase_end" && typeof checkpoint.phase === "string") {
    return t("checkpoint.type.phase_end_of", { phase: label(t, `next.phase.${checkpoint.phase}`) });
  }
  return label(t, `checkpoint.type.${checkpoint.type}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many seconds the undo window lasts: 10. */
export const UNDO_MS = 10_000;

/**
 * The provenance of a checkpoint that an untrusted session opened: one discreet line,
 * for the history. It only informs: nothing waits on it.
 */
function provenanceLines(t: Translate, checkpoint: CheckpointState): string[] {
  const mark = checkpoint.untrusted;
  if (mark === null || mark === undefined) return [];
  return [t("review.card.untrusted_provenance"), ""];
}

/** The verdict of Chloé's review of the architecture, as the card shows it. */
function verdictLine(t: Translate, review: ArchitectureReview | null): string {
  if (review === null) return t("review.card.security_verdict.unknown");
  return review.verdict === "blocking"
    ? t("review.card.security_verdict.blocking", {
        blocking: review.blocking,
        findings: review.findings,
      })
    : t("review.card.security_verdict.no_blocking", { findings: review.findings });
}

/**
 * The presentation of a deliverable, then the command for its full text. The agent's
 * words are shown line by line behind a bar, control characters made spaces, so that they cannot
 * pass for the engine's own lines.
 */
function publicationLines(t: Translate, checkpoint: CheckpointState): string[] {
  const command = `npx agentplugged publication ${checkpoint.id}`;
  const presentation = checkpoint.publication ?? null;
  if (presentation === null) return [t("review.card.publication.missing", { command })];
  const agent = displayText(checkpoint.opened_by ?? "-");
  return [
    t("review.card.publication.angle", { angle: displayText(presentation.angle) }),
    t("review.card.publication.audience", { audience: displayText(presentation.audience) }),
    t("review.card.publication.short", { seconds: SHORT_VERSION_TARGET_SECONDS, agent }),
    ...presentation.short_version.split(/\r?\n/).map((line) => `  │ ${displayText(line)}`),
    t("review.card.publication.full", { count: checkpoint.documents.length, command }),
  ];
}

/** What a change of the memory contains, line by line: every text whole, as it would be recorded. */
function memoryLines(t: Translate, memory: MemoryPreview | undefined): string[] {
  if (memory === undefined) return [`  ${t("review.memory.unreadable")}`];
  const show = (text: string) => displayText(text);
  if (memory.kind === "promotion") {
    const lines = [`  ${t("review.memory.promotion")}`];
    if (memory.lesson === null) lines.push(`  ${t("review.memory.lesson_unreadable")}`);
    else {
      lines.push(
        `    ${memory.lesson.id}: ${show(memory.lesson.title)}`,
        `      ${show(memory.lesson.text)}`,
      );
      if (memory.lesson.agents.length > 0) {
        lines.push(`      ${t("review.memory.for", { agents: memory.lesson.agents.join(", ") })}`);
      }
    }
    for (const id of memory.replaces) lines.push(`    ${t("review.memory.replaces", { id })}`);
    return lines;
  }
  const lines = [`  ${t("review.memory.looked_at")} ${show(memory.summary)}`];
  for (const lesson of memory.lessons) {
    lines.push(`  ${lesson.id}: ${show(lesson.title)}`, `    ${show(lesson.text)}`);
    if (lesson.agents.length > 0) {
      lines.push(`    ${t("review.memory.for", { agents: lesson.agents.join(", ") })}`);
    }
    for (const id of lesson.replaces) lines.push(`    ${t("review.memory.replaces", { id })}`);
  }
  for (const entry of memory.retire) {
    lines.push(`  ${t("review.memory.retires", { id: entry.lesson })} ${show(entry.reason)}`);
  }
  for (const action of memory.actions) {
    lines.push(
      `  ${action.id}: ${show(action.text)}${action.owner === null ? "" : ` (${action.owner})`}`,
    );
  }
  return lines;
}

/**
 * The text card of a checkpoint: header `type · risk · recipient`, title, summary,
 * what changes, risks, tests/QA/security (verdict and criteria, or "not measured"), options and
 * recommendation of a decision, what is blocked, and the confirmation it asks.
 */
export function formatCard(
  t: Translate,
  checkpoint: CheckpointState,
  /** The security review the checkpoint cites, as Chloé submitted it (null: none). */
  securityReview?: ArchitectureReview | null,
  intents: readonly IntentPreview[] = [],
  /** What a `memory` checkpoint contains, decrypted by the engine (absent: no key). */
  memory?: MemoryPreview,
): string {
  const lines: string[] = [...provenanceLines(t, checkpoint)];
  lines.push(
    t("review.card.header", {
      id: checkpoint.id,
      type: typeLabel(t, checkpoint),
      risk: label(t, `checkpoint.risk.${checkpoint.risk}`),
      recipient: label(t, `checkpoint.role.${checkpoint.recipient_role}`),
    }),
  );
  lines.push(checkpoint.title, "");
  lines.push(...checkpoint.summary.split(/\r?\n/).map((line) => `  ${line}`), "");
  // A creator's action asked from the chat: approving it carries it out.
  const action = checkpoint.creator_action ?? undefined;
  if (action !== undefined) {
    lines.push(t("review.card.creator_action", { kind: creatorActionLabel(t, action.kind) }));
    // Every field of the action, whole: what is approved is what is shown (an agent's role too).
    for (const [field, value] of Object.entries(action)) {
      if (field === "kind" || field === "content" || value === undefined) continue;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      lines.push(`  ${field}: ${displayText(text)}`);
    }
    // The complete definition of an agent or skill, section by section: what the
    // engine writes if you approve, nothing else.
    if ("content" in action && action.content !== undefined) {
      lines.push(t("review.card.content"));
      for (const { key, items } of contentSections(action.content)) {
        const label = `content.section.${key}`;
        lines.push(
          `  ${isMessageKey(label) ? t("content.section.heading", { label: t(label) }) : displayText(key)}`,
        );
        for (const item of items) lines.push(`    ${displayText(item)}`);
      }
    }
    lines.push("");
  }
  // A deliverable: its angle, its audience and its short version, in the agent's words,
  // then the command that shows the full text, the version approved here.
  if (checkpoint.type === "publication") lines.push(...publicationLines(t, checkpoint), "");
  // A change of the memory: its content is encrypted, the agent shows it in the chat.
  if ((checkpoint.memory ?? null) !== null) {
    lines.push(t("review.card.memory"), ...memoryLines(t, memory), "");
  }
  if (checkpoint.documents.length === 0) lines.push(t("review.card.no_changes"));
  else {
    lines.push(t("review.card.changes"));
    for (const document of checkpoint.documents) {
      // Chloé's review, attached to the end of the design phase, says what it is.
      const review = document.path.replaceAll("\\", "/") === ARCHITECTURE_SECURITY_REVIEW_PATH;
      const key = review ? "review.card.security_review_line" : "review.card.change_line";
      lines.push(`  ${t(key, { path: document.path, branch: document.branch })}`);
      if (review && securityReview !== undefined) {
        lines.push(`    ${verdictLine(t, securityReview)}`);
      }
    }
  }
  // What approving freezes, story by story, in a few lines.
  if (intents.length > 0) {
    lines.push(t("review.card.intents"));
    for (const preview of intents) {
      lines.push(
        `  ${t(`review.card.intent.${preview.status}` as MessageKey, {
          story: preview.story ?? "?",
          path: displayText(preview.path),
          frozen_by: preview.frozen_by ?? "",
        })}`,
      );
      // Text an agent wrote: control characters shown as spaces.
      for (const line of preview.intent) lines.push(`    │ ${displayText(line)}`);
      if (preview.more) lines.push("    │ …");
    }
  }
  lines.push(
    t("review.card.risks", {
      risk: label(t, `checkpoint.risk.${checkpoint.risk}`),
      reversibility: t(
        checkpoint.irreversible ? "review.card.irreversible" : "review.card.reversible",
      ),
    }),
  );
  const verdict = checkpoint.verdict;
  if (verdict === null) lines.push(t("review.card.not_measured"));
  else {
    lines.push(
      t("review.card.quality", { verdict: label(t, `checkpoint.verdict.${verdict.result}`) }),
    );
    for (const criterion of verdict.criteria) {
      lines.push(
        `  ${t("review.card.criterion", {
          metric: criterion.metric,
          op: label(t, `checkpoint.op.${criterion.op}`),
          threshold: criterion.threshold,
          severity: label(t, `checkpoint.severity.${criterion.severity}`),
          measure:
            criterion.measure === null ? t("review.card.measure_missing") : criterion.measure,
          result: t(criterion.satisfied ? "review.card.met" : "review.card.unmet"),
        })}`,
      );
    }
  }
  if (checkpoint.options !== null) {
    lines.push(t("review.card.options"));
    for (const option of checkpoint.options) {
      const recommended =
        option.id === checkpoint.recommendation ? t("review.card.recommended") : "";
      lines.push(
        `  ${t("review.card.option_line", { label: option.label, consequence: option.consequence })}${recommended}`,
      );
    }
  }
  if (checkpoint.blocks.length === 0) lines.push(t("review.card.nothing_blocked"));
  else {
    lines.push(t("review.card.blocked"));
    for (const block of checkpoint.blocks) {
      const story = block.story ?? checkpoint.story;
      const action = label(t, `checkpoint.action.${block.action}`);
      lines.push(`  ${story === null ? action : t("review.card.blocked_line", { action, story })}`);
    }
  }
  lines.push(
    t("review.card.confirmation", {
      modes: checkpoint.confirmation
        .map((mode) => label(t, `checkpoint.confirmation.${mode}`))
        .join(", "),
    }),
  );
  if (checkpoint.status === "waived" && checkpoint.resolution?.waiver_until) {
    lines.push(
      t("review.card.waiver_expired", { date: localDateTime(checkpoint.resolution.waiver_until) }),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The label of an action of the terminal. */
function actionLabel(t: Translate, checkpoint: CheckpointState, action: ReviewAction): string {
  if (action.kind === "choose") {
    const option = checkpoint.options?.find((entry) => entry.id === action.option);
    const recommended =
      action.option === checkpoint.recommendation ? t("review.card.recommended") : "";
    return `${t("review.action.choose", { label: option?.label ?? action.option })}${recommended}`;
  }
  return t(`review.action.${action.kind}` as MessageKey);
}

/** The label of a decision (`approved`, `waived`…) in the creator's language. */
export function decisionLabel(t: Translate, decision: ResolutionDecision): string {
  return t(`review.decision.${decision}` as MessageKey);
}

/** What the creator answered, before the confirmations. */
export interface ReviewAnswer {
  readonly decision: ResolutionDecision;
  readonly option?: string;
  readonly note?: string;
  readonly waiver_until?: string;
}

/**
 * The numbered actions, then what the chosen one needs: a note (reservations, refusal), an
 * instruction (changes), a deadline (waiver, at most 30 days). Undefined when the creator quits.
 */
export async function askAnswer(
  t: Translate,
  prompter: Prompter,
  checkpoint: CheckpointState,
  now: () => number,
): Promise<ReviewAnswer | undefined> {
  const actions = reviewActions(checkpoint);
  for (;;) {
    prompter.say(t("review.actions.title"));
    actions.forEach((action, index) => {
      prompter.say(`  ${index + 1}. ${actionLabel(t, checkpoint, action)}`);
    });
    const quit = actions.length - 1;
    const index = await askChoice(
      t,
      prompter,
      (fallback) => t("review.prompt.action", { default: fallback }),
      actions.length,
      quit,
    );
    const action = actions[index] as ReviewAction;
    if (action.kind === "quit") return undefined;
    const decision = ACTION_DECISIONS[action.kind];
    if (action.kind === "choose") return { decision, option: action.option };
    if (action.kind === "approve") return { decision };
    if (action.kind === "waive") {
      const refusal = waiverRefusal(checkpoint);
      if (refusal !== undefined) {
        prompter.say(t(`review.waiver.refused.${refusal}` as MessageKey));
        continue;
      }
      const deadline = (await askText(
        t,
        prompter,
        t("review.prompt.deadline", { max: MAX_WAIVER_DAYS }),
        {
          required: true,
          check: (answer) => {
            const until = parseWaiverAnswer(answer, now());
            if (until === undefined) return t("review.deadline.invalid", { max: MAX_WAIVER_DAYS });
            const problem = waiverDeadlineProblem(until, now());
            if (problem === "too_far")
              return t("review.deadline.too_far", { max: MAX_WAIVER_DAYS });
            if (problem !== undefined) return t("review.deadline.past");
            // Renewals included, a checkpoint is waived 90 days at most.
            const added = Date.parse(until) - now();
            if (checkpoint.waived_ms + added > MAX_WAIVED_TOTAL_DAYS * DAY_MS) {
              return t("review.deadline.renewal", { max: MAX_WAIVED_TOTAL_DAYS });
            }
            return undefined;
          },
        },
      )) as string;
      return {
        decision,
        waiver_until: parseWaiverAnswer(deadline, now()) as string,
      };
    }
    const note = (await askText(t, prompter, t(`review.prompt.note.${decision}` as MessageKey), {
      required: true,
    })) as string;
    return { decision, note };
  }
}

/** Where the confirmations ended: confirmed, or cancelled (nothing is written). */
export type Confirmation = "confirmed" | "cancelled";

/**
 * The confirmation the checkpoint asks, before anything is written: at low or medium risk,
 * Enter and a window of 10 s where `a` undoes; at high risk, the presence assertion comes with the
 * write (`onPresencePrompt` shows what is signed and its fingerprint just before the prompt).
 * Nothing more for an irreversible action (no sentence to type); the terminal is the
 * way of the `strict` level only.
 */
export async function confirmAnswer(
  t: Translate,
  prompter: Prompter,
  checkpoint: CheckpointState,
  answer: ReviewAnswer,
  presence: PresenceState,
  undoMs: number,
): Promise<Confirmation> {
  const decision = decisionLabel(t, answer.decision);
  if (checkpoint.confirmation.includes("presence")) {
    if (presence.status === "linked") prompter.say(t("review.presence.coming"));
    else prompter.say(presenceFallbackText(t, presence));
    if (presence.status === "linked") return "confirmed";
  }
  const enter = await prompter.ask(t("review.confirm.enter", { decision, id: checkpoint.id }));
  if (enter === undefined || enter.trim() !== "") {
    prompter.say(t("review.confirm.cancelled"));
    return "cancelled";
  }
  prompter.say(t("review.confirm.undo", { seconds: Math.ceil(undoMs / 1000) }));
  if (await prompter.waitCancel(undoMs, "a")) {
    prompter.say(t("review.confirm.undone"));
    return "cancelled";
  }
  return "confirmed";
}

/** Why a checkpoint that asks for presence will be signed `locale`. */
export function presenceFallbackText(t: Translate, presence: PresenceState): string {
  switch (presence.status) {
    case "not_linked":
      return t("review.presence.fallback.not_linked");
    case "no_credential":
      return t("review.presence.fallback.no_credential");
    default:
      return `${t("review.presence.fallback.unavailable")} ${presenceUnavailableText(t, presence.reason)}`;
  }
}

/** Why Windows Hello cannot be used here. */
export function presenceUnavailableText(t: Translate, reason: string | undefined): string {
  const key = `presence.unavailable.${reason ?? "unsupported"}`;
  return isMessageKey(key) ? t(key) : t("presence.unavailable.other", { reason: reason ?? "" });
}

/** What the terminal shows just before Windows Hello's prompt: what is signed, its fingerprint. */
export function formatPresencePrompt(t: Translate, prompt: PresencePrompt): string {
  const payload = prompt.event.payload ?? {};
  const what =
    prompt.event.type === "checkpoint.resolved"
      ? t("review.presence.signs.resolution", {
          decision: decisionLabel(t, payload.decision as ResolutionDecision),
          id: String(payload.checkpoint),
        })
      : t("review.presence.signs.link", { device: prompt.event.actor.device });
  return `${t("review.presence.signs", { what, fingerprint: prompt.fingerprint })}\n`;
}

/** A failure of the registry, as an error to show. */
function failed(result: { ok: false; error: AgentPluggedError }): AgentPluggedError {
  return result.error;
}

/**
 * `review [G-id]`: the open checkpoints, a choice, the card, the numbered actions, the
 * confirmations, then the answer written by core (signed by the creator's key). Returns the
 * message to print at the end, or throws the error to show.
 */
export async function runReview(
  t: Translate,
  prompter: Prompter,
  registry: CommandRegistry,
  context: CommandContext,
  checkpointId: string | undefined,
  options: {
    readonly undoMs: number;
    readonly now: () => number;
    /** The journal's remote, when one is configured: a reminder to sync around the answer. */
    readonly remote?: string | null;
  },
): Promise<string> {
  const listed = await registry.run("review", context, {
    action: "list",
    ...(checkpointId === undefined ? {} : { checkpoint: checkpointId }),
  });
  if (!listed.ok) throw failed(listed);
  const list = listed.value as ReviewList;
  if (list.pending.length > 0) {
    prompter.say(
      t("review.pending", {
        count: list.pending.length,
        devices: list.pending.map((key) => key.device).join(", "),
      }),
    );
  }
  if (list.checkpoints.length === 0) return `${t("review.none")}\n`;
  let checkpoint = list.checkpoints[0] as CheckpointState;
  if (checkpointId === undefined) {
    prompter.say(t("review.list.title", { count: list.checkpoints.length }));
    list.checkpoints.forEach((entry, index) => {
      prompter.say(
        `  ${index + 1}. ${t("review.list.line", {
          id: entry.id,
          title: entry.title,
          type: typeLabel(t, entry),
          risk: label(t, `checkpoint.risk.${entry.risk}`),
        })}`,
      );
    });
    const index = await askChoice(
      t,
      prompter,
      (fallback) => t("review.prompt.checkpoint", { default: fallback }),
      list.checkpoints.length,
      0,
    );
    checkpoint = list.checkpoints[index] as CheckpointState;
  }
  prompter.say("");
  prompter.say(
    formatCard(
      t,
      checkpoint,
      list.security_reviews?.[checkpoint.id],
      list.intents?.[checkpoint.id] ?? [],
      list.memory?.[checkpoint.id],
    ).trimEnd(),
  );
  prompter.say("");
  if (options.remote) prompter.say(t("review.remote_reminder", { remote: options.remote }));
  // A checkpoint the engine answered on its own (`auto` level): the creator reopens it.
  // So is a point an agent decided because the creator did not keep that kind of point.
  if (
    checkpoint.status === "resolved" &&
    (checkpoint.resolution?.source === "auto" || checkpoint.resolution?.source === "agent")
  ) {
    return reopenAutoApplied(t, prompter, registry, context, checkpoint);
  }
  const answer = await askAnswer(t, prompter, checkpoint, options.now);
  if (answer === undefined) return `${t("review.quit")}\n`;
  const confirmation = await confirmAnswer(
    t,
    prompter,
    checkpoint,
    answer,
    list.presence,
    options.undoMs,
  );
  if (confirmation === "cancelled") return "";
  const resolved = await registry.run("review", context, {
    action: "resolve",
    checkpoint: checkpoint.id,
    ...answer,
  });
  if (!resolved.ok) throw failed(resolved);
  return formatResolved(t, resolved.value as ReviewResolved, checkpoint);
}

/**
 * A checkpoint applied automatically: what was applied, then « Rouvrir » or « Quitter ».
 * Reopening needs no confirmation: it only makes the checkpoint open again.
 */
async function reopenAutoApplied(
  t: Translate,
  prompter: Prompter,
  registry: CommandRegistry,
  context: CommandContext,
  checkpoint: CheckpointState,
): Promise<string> {
  prompter.say(
    checkpoint.resolution?.source === "agent"
      ? t("review.agent_decided", {
          agent: displayText(checkpoint.resolution.relayed_by ?? "?"),
          at: localDateTime(checkpoint.resolution.at),
          decision: displayText(checkpoint.resolution.option ?? checkpoint.resolution.decision),
          reason: displayText(checkpoint.resolution.note ?? "-"),
        })
      : t("review.auto_applied", {
          option: displayText(checkpoint.resolution?.option ?? "-"),
          at: localDateTime(checkpoint.resolution?.at ?? ""),
        }),
  );
  prompter.say(t("review.actions.title"));
  prompter.say(`  1. ${t("review.action.reopen")}`);
  prompter.say(`  2. ${t("review.action.quit")}`);
  const index = await askChoice(
    t,
    prompter,
    (fallback) => t("review.prompt.action", { default: fallback }),
    2,
    1,
  );
  if (index !== 0) return `${t("review.quit")}\n`;
  const reopened = await registry.run("review", context, {
    action: "reopen",
    checkpoint: checkpoint.id,
  });
  if (!reopened.ok) throw failed(reopened);
  return `${t("review.reopened", { id: checkpoint.id })}\n`;
}

/** What was written: the decision, the checkpoint, and the assurance (`locale` said as such). */
export function formatResolved(
  t: Translate,
  result: ReviewResolved,
  checkpoint: Pick<CheckpointState, "risk">,
): string {
  const lines = [
    t("review.done", {
      decision: decisionLabel(t, result.decision),
      id: result.checkpoint,
      assurance: t(`assurance.${result.assurance}` as MessageKey),
    }),
  ];
  if (checkpoint.risk === "high" && result.assurance === "locale") {
    lines.push(t("review.done.locale_high"));
  }
  // The creator's action the approval carried out, and its files.
  const executed = result.executed;
  if (executed !== undefined) {
    lines.push(t("review.executed", { kind: creatorActionLabel(t, executed.kind) }));
    // A gesture of the forge: what it did, on which repository.
    const gesture = executed.gesture;
    if (gesture !== undefined && executed.kind === "release") {
      // Staging went into production.
      lines.push(
        t(
          gesture.pr !== undefined
            ? "review.executed.gesture.release.pull_request"
            : "review.executed.gesture.release.direct",
          {
            branch: displayText(gesture.branch ?? "-"),
            commit: (gesture.commit ?? "").slice(0, 12),
            pr: gesture.pr ?? 0,
            url: displayText(gesture.url ?? "-"),
          },
        ),
      );
    } else if (gesture !== undefined) {
      lines.push(
        t(
          gesture.status === "already"
            ? "review.executed.gesture.already"
            : "review.executed.gesture.done",
          {
            kind: creatorActionLabel(t, executed.kind),
            target: displayText(gesture.target ?? "-"),
          },
        ),
      );
      if (gesture.pr !== undefined && gesture.url !== undefined) {
        lines.push(
          t("review.executed.gesture.pull_request", {
            pr: gesture.pr,
            url: displayText(gesture.url),
          }),
        );
      }
    }
    const files = executed.files;
    if (files !== undefined) {
      lines.push(...files.paths.map((path) => `  ${displayText(path)}`));
      if (typeof files.sync === "object") {
        lines.push(t("review.executed.sync_failed", { code: files.sync.code }));
      }
    }
  }
  // The story the engine merged once its merge checkpoint was approved.
  const merged = result.merged;
  if (merged !== undefined) {
    lines.push(
      merged.direct !== undefined
        ? // No pull request, the creator's workflow having none.
          t(merged.direct.on_base ? "review.merged.direct.on_base" : "review.merged.direct", {
            story: displayText(merged.story),
            into: displayText(merged.direct.into),
            commit: merged.commit.slice(0, 12),
          })
        : t(merged.already ? "review.merged.already" : "review.merged", {
            story: displayText(merged.story),
            pr: merged.pr ?? 0,
            url: displayText(merged.url ?? "-"),
            commit: merged.commit.slice(0, 12),
          }),
    );
    if (merged.worktree.status === "removed") lines.push(t("review.merged.worktree.removed"));
    if (merged.worktree.status === "kept") {
      lines.push(
        t("review.merged.worktree.kept", {
          reason: t(
            `review.merged.worktree.reason.${merged.worktree.reason ?? "failed"}` as MessageKey,
          ),
        }),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** A creator's action by its kind, in the creator's language. */
export function creatorActionLabel(t: Translate, kind: string): string {
  const key = `creator_action.kind.${kind}`;
  return isMessageKey(key) ? t(key) : displayText(kind);
}

/** What `key presence` or `key endorse` did, in the creator's language. */
export function formatKey(t: Translate, result: KeyResult): string {
  if (result.action === "export" || result.action === "import" || result.action === "seal") {
    return formatProductKey(t, result);
  }
  if (result.action === "endorse") {
    if (result.status === "endorsed")
      return `${t("key.endorse.done", { device: result.device })}\n`;
    if (result.pending.length === 0) return `${t("key.endorse.none")}\n`;
    return [
      t("key.endorse.title", { count: result.pending.length }),
      ...result.pending.map(
        (key) =>
          `  ${t("key.endorse.line", { device: key.device, at: localDateTime(key.registered_at) })}`,
      ),
      t("key.endorse.hint"),
      "",
    ].join("\n");
  }
  if (result.status === "unavailable") return `${presenceUnavailableText(t, result.reason)}\n`;
  if (result.status === "already_linked") return `${t("key.presence.already")}\n`;
  return `${t("key.presence.linked", { alg: result.alg ?? "" })}\n`;
}
