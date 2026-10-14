import {
  type CreatorPrompt,
  type CreatorReply,
  DECISION_FORM_FIELDS,
  formDigest,
  stackField,
  stackPromptDigest,
} from "@agentplugged/core";
import { createTranslator, isMessageKey, type Translate } from "@agentplugged/i18n";
import {
  contentSections,
  type DecisionChoice,
  type DecisionPrompt,
  ELICITATION_TIMEOUT_MS,
  MAX_ELICITED_NOTE_LENGTH,
  type StackPrompt,
} from "@agentplugged/protocol";
import type {
  ClientCapabilities,
  ElicitRequestFormParams,
  ElicitResult,
} from "@modelcontextprotocol/server";
import { inputResponse, ProtocolError, SdkError, SdkErrorCode } from "@modelcontextprotocol/server";

/**
 * The engine's questions in the AI tool's own form: the MCP protocol's elicitation
 * (`elicitation/create`, form mode). This file only renders the decision object the engine built
 * and reads the protocol's answer back; what counts as an answer is decided by the engine
 * (`readReply`).
 */

/** Sends one form request tied to the tool call in flight (`ctx.mcpReq.elicitInput`). */
export type ElicitInput = (
  params: ElicitRequestFormParams,
  options: { readonly timeout: number },
) => Promise<ElicitResult>;

/**
 * True when the client announced at initialization that it shows forms (`elicitation.form`; the
 * SDK reads a bare `elicitation: {}` as `{ form: {} }`, as the protocol says).
 */
export function showsForms(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation = capabilities?.elicitation as { form?: unknown; url?: unknown } | undefined;
  if (elicitation === undefined || elicitation === null) return false;
  // The protocol: a bare `elicitation: {}` means `{ form: {} }`. The 2025 handshake's schema
  // already says so; the per-request envelope of the 2026-07-28 revision arrives as sent.
  return elicitation.form !== undefined || elicitation.url === undefined;
}

/**
 * Control, format (bidirectional marks, zero-width characters, tags) and line or paragraph
 * separator characters: never shown. Line breaks are handled by the caller.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A text of the journal on one line, as the form shows it: no hidden character, no line break. */
export function line(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(HIDDEN, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A text of the journal on several lines: each one cleaned, the empty ones dropped. */
export function lines(text: string): string[] {
  return text
    .normalize("NFKC")
    .split(/\r\n|\r|\n|\p{Zl}|\p{Zp}/u)
    .map(line)
    .filter((entry) => entry !== "");
}

/**
 * A deliverable's words as recorded: no normalisation (NFKC would change `m²` into `m2`), the
 * protocol already refused every hidden character, and the lines are kept as written.
 */
export function recorded(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

type MessageKey = Parameters<Translate>[0];

/** The messages that title the choices of a decision: each surface (form, question tool) has its own. */
export interface ChoiceKeys {
  readonly recommended: MessageKey;
  readonly approve: MessageKey;
  readonly reject: MessageKey;
  readonly changes: MessageKey;
  readonly changesNone: MessageKey;
}

const FORM_KEYS: ChoiceKeys = {
  recommended: "elicitation.choice.recommended",
  approve: "elicitation.choice.approve",
  reject: "elicitation.choice.reject",
  changes: "elicitation.choice.changes",
  changesNone: "elicitation.choice.changes_none",
};

/** The title of one choice, in the creator's language; the recommendation is marked. */
export function choiceTitle(
  t: Translate,
  prompt: DecisionPrompt,
  choice: DecisionChoice,
  keys: ChoiceKeys = FORM_KEYS,
): string {
  if (choice.decision === "option_chosen") {
    const option = prompt.options.find((entry) => entry.id === choice.option);
    const label = line(option?.label ?? choice.option ?? choice.id);
    return choice.recommended ? t(keys.recommended, { label }) : label;
  }
  if (choice.decision === "approved") return t(keys.approve);
  if (choice.decision === "rejected") return t(keys.reject);
  return t(prompt.options.length > 0 ? keys.changesNone : keys.changes);
}

/** The creator's action a request asks for, field by field, as the engine recorded it. */
export function actionText(action: NonNullable<DecisionPrompt["creator_action"]>): string {
  return Object.entries(action)
    .filter(([key, value]) => key !== "reason" && key !== "content" && value !== undefined)
    .map(([key, value]) => `${key}: ${line(String(value))}`)
    .join(" · ");
}

/**
 * The form of a decision object, in one question (corrections B). The message says who
 * asks (AgentPlugged), then the question in words: the checkpoint's own words, quoted line by line
 * so they can never pass for the engine's, then the engine's facts (options with their
 * consequence and the recommendation marked, risk, irreversibility, documents, the definition or
 * the deliverable), and the technical details last (the point, the action's fields). The schema is
 * flat, of primitive fields, as the protocol requires: `choice` alone (one of the choices,
 * required). Approving, or choosing an option, records at once, without a note: the note of a
 * refusal or of a request for changes is a second question (`renderNoteForm`). No field has a
 * default: a tool that fills defaults on its own (`applyDefaults`) chooses nothing. No
 * confirmation box; an irreversible action is named in the message, and the creator's one answer is
 * their agreement.
 */
export function renderForm(prompt: DecisionPrompt, t: Translate): ElicitRequestFormParams {
  const agent = prompt.opened_by === null ? "-" : line(prompt.opened_by);
  // The question first, in the words of whoever wrote it, quoted apart from the engine's facts.
  const text = [t("elicitation.message.intro"), "", t("elicitation.message.written_by", { agent })];
  for (const entry of [line(prompt.title), ...lines(prompt.summary)]) text.push(`> ${entry}`);
  if (prompt.options.length > 0) {
    text.push("", t("elicitation.message.options"));
    for (const option of prompt.options) {
      const values = { label: line(option.label), consequence: line(option.consequence) };
      text.push(
        t(
          option.recommended
            ? "elicitation.message.option_recommended"
            : "elicitation.message.option",
          values,
        ),
      );
    }
  }
  text.push("", t("elicitation.message.risk", { risk: t(`elicitation.risk.${prompt.risk}`) }));
  if (prompt.irreversible) {
    text.push(
      t("elicitation.message.irreversible", {
        action: line(prompt.external_action?.action ?? prompt.title),
      }),
    );
  }
  // The definition of an agent or skill to write: whole, section by section, each
  // line quoted as the agent wrote it (it is checked to hold no hidden character or line break).
  const content =
    prompt.creator_action !== null && "content" in prompt.creator_action
      ? prompt.creator_action.content
      : undefined;
  if (content !== undefined) {
    text.push("", t("elicitation.message.content", { agent }));
    for (const { key, items } of contentSections(content)) {
      const label = `content.section.${key}`;
      text.push(isMessageKey(label) ? t("content.section.heading", { label: t(label) }) : key);
      for (const item of items) text.push(`> ${item}`);
    }
  }
  if (prompt.documents.length > 0) {
    text.push("", t("elicitation.message.documents"));
    for (const document of prompt.documents) {
      text.push(
        t("elicitation.message.document", {
          path: line(document.path),
          branch: line(document.branch),
        }),
      );
    }
  }
  // A deliverable: angle, audience and short version in the agent's words, quoted,
  // then the command for the full text, which is what the creator validates.
  const publication = prompt.publication ?? null;
  if (publication !== null) {
    text.push(
      "",
      t("elicitation.message.publication.angle", { angle: publication.angle }),
      t("elicitation.message.publication.audience", { audience: publication.audience }),
      t("elicitation.message.publication.short", { agent }),
    );
    for (const entry of recorded(publication.short_version)) text.push(`> ${entry}`);
    text.push(t("elicitation.message.publication.full", { agent }));
  }
  // The technical details, last: the point, and the fields of the action as the engine recorded them.
  text.push("", t("elicitation.message.checkpoint", { checkpoint: prompt.checkpoint, agent }));
  if (prompt.creator_action !== null) {
    text.push(t("elicitation.message.action", { action: actionText(prompt.creator_action) }));
  }
  const properties: ElicitRequestFormParams["requestedSchema"]["properties"] = {
    [DECISION_FORM_FIELDS.choice]: {
      type: "string",
      title: t("elicitation.field.choice"),
      oneOf: prompt.choices.map((choice) => ({
        const: choice.id,
        title: choiceTitle(t, prompt, choice),
      })),
    },
  };
  return {
    mode: "form",
    message: text.join("\n"),
    requestedSchema: {
      type: "object",
      properties,
      required: [DECISION_FORM_FIELDS.choice],
    },
  };
}

/**
 * The second question (corrections B), asked only after a refusal or a request for
 * changes: what the creator wrote is the reason, or the changes. One required field, `note`, and the
 * point's title quoted, so the creator knows which decision this is about.
 */
export function renderNoteForm(
  prompt: DecisionPrompt,
  choice: DecisionChoice,
  t: Translate,
): ElicitRequestFormParams {
  const agent = prompt.opened_by === null ? "-" : line(prompt.opened_by);
  const ask =
    choice.decision === "rejected"
      ? "elicitation.note.message.rejected"
      : "elicitation.note.message.changes";
  const text = [
    t(ask),
    "",
    t("elicitation.message.written_by", { agent }),
    `> ${line(prompt.title)}`,
  ];
  return {
    mode: "form",
    message: text.join("\n"),
    requestedSchema: {
      type: "object",
      properties: {
        [DECISION_FORM_FIELDS.note]: {
          type: "string",
          title: t("elicitation.field.note"),
          description: t("elicitation.field.note.description"),
          minLength: 1,
          maxLength: MAX_ELICITED_NOTE_LENGTH,
        },
      },
      required: [DECISION_FORM_FIELDS.note],
    },
  };
}

/** The longest title a box of the stack's form shows. */
const STACK_BOX_TITLE = 90;

/**
 * The form of a stack: one form for several points, a box per point still waiting,
 * **ticked at first**: the creator unticks what they do not validate and submits (their own
 * decision, an exception to « no default » that holds for the form of one point). The message says
 * who asks (AgentPlugged, the stack and the agent that opened each point), then each point
 * numbered with the engine's facts (risk, what an approval chooses) apart from the checkpoint's own
 * words, quoted line by line so they can never pass for the engine's. Every box is required: a
 * reply that leaves one out is no answer.
 */
export function renderStackForm(prompt: StackPrompt, t: Translate): ElicitRequestFormParams {
  const text = [
    t("elicitation.stack.intro", { count: prompt.items.length }),
    t("elicitation.stack.stack", { stack: prompt.stack }),
  ];
  for (const item of prompt.items) {
    const agent = item.opened_by === null ? "-" : line(item.opened_by);
    text.push(
      "",
      t("elicitation.stack.point", {
        n: item.n,
        checkpoint: item.checkpoint,
        risk: t(`elicitation.risk.${item.risk}`),
        agent,
      }),
    );
    if (item.recommendation !== null) {
      text.push(
        t("elicitation.stack.recommendation", {
          label: line(item.recommendation.label),
          consequence: line(item.recommendation.consequence),
        }),
      );
    }
    for (const document of item.documents) {
      text.push(
        t("elicitation.message.document", {
          path: line(document.path),
          branch: line(document.branch),
        }),
      );
    }
    text.push(t("elicitation.message.written_by", { agent }));
    for (const entry of [line(item.title), ...lines(item.summary)]) text.push(`> ${entry}`);
  }
  text.push("", t("elicitation.stack.untick"));
  const properties: ElicitRequestFormParams["requestedSchema"]["properties"] = {};
  for (const item of prompt.items) {
    const title = line(item.title);
    properties[stackField(item.n)] = {
      type: "boolean",
      title: t("elicitation.stack.field", {
        n: item.n,
        title: title.length > STACK_BOX_TITLE ? `${title.slice(0, STACK_BOX_TITLE - 1)}…` : title,
      }),
      default: true,
    };
  }
  return {
    mode: "form",
    message: text.join("\n"),
    requestedSchema: {
      type: "object",
      properties,
      required: prompt.items.map((item) => stackField(item.n)),
    },
  };
}

/**
 * A refusal that comes back sooner than this was not read by a person: the client refused the form
 * on its own (the VS Code extension of Claude Code answers `decline` at once). The
 * engine remembers it for the session and uses the AI tool's question tool instead.
 */
export const AUTO_DECLINE_MS = 1500;

/** True for the SDK's refusal to send a form this connection cannot carry. */
function cannotSend(error: unknown): boolean {
  return (
    error instanceof SdkError &&
    (error.code === SdkErrorCode.CapabilityNotSupported ||
      error.code === SdkErrorCode.MethodNotSupportedByProtocolVersion)
  );
}

/** True for the SDK's timeout: the client sent no answer within the delay. */
function timedOut(error: unknown): boolean {
  return error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout;
}

/** True for an answer the SDK found outside the form's schema: the creator chose nothing valid. */
function outsideSchema(error: unknown): boolean {
  return error instanceof ProtocolError && /does not match requested schema/i.test(error.message);
}

/**
 * The engine's port to ask the creator through this tool call's form, or undefined when the
 * client did not announce forms. `decline` and `cancel` come back as they are; an answer outside
 * the schema is no choice (`invalid`); no answer within `ELICITATION_TIMEOUT_MS`, a tool call the
 * client cancelled, or an error, is `failed`; a connection that cannot carry the request is
 * `unavailable`; a hook of the AI tool that could answer in the creator's place (`toolHook`)
 * stops the form before it is sent (`tool_hook`).
 */
export function creatorPromptOf(options: {
  readonly capabilities: ClientCapabilities | undefined;
  readonly channel: string;
  readonly elicit: ElicitInput;
  readonly text?: Translate;
  readonly timeoutMs?: number;
  /** The engine's command on this machine, in place of `npx agentplugged`. */
  readonly localize?: (text: string) => string;
  /** True when a hook of the AI tool could answer the form in the creator's place. */
  readonly toolHook?: () => Promise<boolean>;
  /** True once the tool call was cancelled by the client: an answer then counts for nothing. */
  readonly aborted?: () => boolean;
  /** The clock (milliseconds), to tell a refusal at once from a creator's: the system's by default. */
  readonly now?: () => number;
}): CreatorPrompt | undefined {
  if (!showsForms(options.capabilities)) return undefined;
  const t = options.text ?? createTranslator("en");
  const timeout = options.timeoutMs ?? ELICITATION_TIMEOUT_MS;
  const send = async (form: ElicitRequestFormParams): Promise<CreatorReply> => {
    try {
      if ((await options.toolHook?.()) === true) return { action: "tool_hook" };
    } catch {
      return { action: "tool_hook" };
    }
    const params =
      options.localize === undefined ? form : { ...form, message: options.localize(form.message) };
    let result: ElicitResult;
    const now = options.now ?? Date.now;
    const sentAt = now();
    try {
      result = await options.elicit(params, { timeout });
    } catch (error) {
      if (cannotSend(error)) return { action: "unavailable" };
      if (outsideSchema(error)) return { action: "accept", content: {} };
      // A short wait (`timeoutMs`, the probe of a client whose form may stay pending) that ended
      // with nothing: said, so that the engine stops sending forms in this session.
      if (options.timeoutMs !== undefined && timedOut(error)) {
        return { action: "failed", timedOut: true };
      }
      return { action: "failed" };
    }
    if (options.aborted?.() === true) return { action: "failed" };
    if (result.action === "accept") {
      const content = result.content;
      return {
        action: "accept",
        content: typeof content === "object" && content !== null ? { ...content } : {},
      };
    }
    // A refusal that came back before a person could read the form says so.
    const quick = now() - sentAt < AUTO_DECLINE_MS;
    return {
      action: result.action === "decline" ? "decline" : "cancel",
      ...(quick ? { quick: true } : {}),
    };
  };
  return {
    channel: options.channel,
    ask: (prompt): Promise<CreatorReply> => send(renderForm(prompt, t)),
    // A stack of points in one form, a box per point.
    askStack: (prompt): Promise<CreatorReply> => send(renderStackForm(prompt, t)),
    // The note of a refusal or of changes, in a second question.
    askNote: (prompt, choice): Promise<CreatorReply> => send(renderNoteForm(prompt, choice, t)),
  };
}

/** The key of the form among the input requests of a round. */
export const FORM_KEY = "decision";

/**
 * What the server keeps of the form between the two rounds of a call (protocol revision
 * 2026-07-28), sealed in the request state: which point, which decision object (its digest), for
 * which agent, and until when the answer counts. The client echoes it back with the creator's answer; the engine
 * reads the answer only when the point and the decision object are still the ones shown.
 */
export interface FormState {
  readonly checkpoint: string;
  readonly form: string;
  readonly agent: string;
  readonly until: number;
}

/** A form to return to the client as an input request, with the state that goes with it. */
export interface PendingForm {
  readonly params: ElicitRequestFormParams;
  readonly state: FormState;
}

function isFormState(value: unknown): value is FormState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.checkpoint === "string" &&
    typeof state.form === "string" &&
    typeof state.agent === "string" &&
    typeof state.until === "number"
  );
}

/**
 * What a client's response to the form says, as the engine's port reads it. `quick`: a
 * refusal that came back before a person could read the form (see `AUTO_DECLINE_MS`).
 */
function replyOf(view: ReturnType<typeof inputResponse>, quick: boolean): CreatorReply | undefined {
  if (view.kind !== "elicit") return undefined;
  if (view.action === "accept") {
    const content = view.content;
    return {
      action: "accept",
      content: typeof content === "object" && content !== null ? { ...content } : {},
    };
  }
  return {
    action: view.action === "decline" ? "decline" : "cancel",
    ...(quick ? { quick: true } : {}),
  };
}

/**
 * The engine's port to ask the creator on a protocol revision without server-to-client requests
 * (2026-07-28 and later): the question rides the call itself. The first round has no
 * answer: the port builds the form, keeps it (`pending`) and tells the engine nothing was asked
 * (`unavailable`, nothing written); the server then returns it as an `input_required` result. The
 * client shows the form, and retries the same call with the creator's answer and the sealed
 * state; the engine builds the decision object again from the journal, and the answer counts
 * only when its digest is the one the state holds (a point that changed meanwhile is asked
 * again, never answered by a click given to another form), before `until` (else `failed`).
 * Everything else is as `creatorPromptOf`: the same form, the hooks of the tool (`tool_hook`),
 * the engine reading the content (`readReply`). Undefined when the request's capabilities do not
 * announce forms.
 */
export function modernCreatorPromptOf(options: {
  readonly capabilities: ClientCapabilities | undefined;
  readonly channel: string;
  /** The `inputResponses` of this round, verbatim from the client (untrusted). */
  readonly responses: Record<string, unknown> | undefined;
  /** The request state of this round, once verified by the codec (undefined at the first round). */
  readonly state: unknown;
  readonly now: () => number;
  /** The agent that asked (`agent` of `ask_creator`, lower case): the state is its alone. */
  readonly agent: string;
  /**
   * Marks the state as used, once: false when a round already read an answer under it. A click
   * answers one form, once; a replay of it is asked again.
   */
  readonly claim?: (key: string, until: number) => boolean;
  readonly text?: Translate;
  readonly timeoutMs?: number;
  readonly localize?: (text: string) => string;
  readonly toolHook?: () => Promise<boolean>;
  readonly aborted?: () => boolean;
}): { readonly port: CreatorPrompt; readonly pending: () => PendingForm | undefined } | undefined {
  if (!showsForms(options.capabilities)) return undefined;
  const t = options.text ?? createTranslator("en");
  const timeout = options.timeoutMs ?? ELICITATION_TIMEOUT_MS;
  let pending: PendingForm | undefined;
  /**
   * One round of a form: the answer of the sealed state when it is for this very point (or stack)
   * and form, else the form itself kept for the client (`unavailable`, nothing asked yet).
   */
  const round = async (
    key: string,
    digest: string,
    render: () => ElicitRequestFormParams,
  ): Promise<CreatorReply> => {
    try {
      if ((await options.toolHook?.()) === true) return { action: "tool_hook" };
    } catch {
      return { action: "tool_hook" };
    }
    const sealed = isFormState(options.state) ? options.state : undefined;
    if (
      sealed !== undefined &&
      sealed.checkpoint === key &&
      sealed.form === digest &&
      sealed.agent === options.agent
    ) {
      if (options.now() > sealed.until) {
        return options.timeoutMs === undefined
          ? { action: "failed" }
          : { action: "failed", timedOut: true };
      }
      // The form left with the first round at `until - timeout`: a refusal within AUTO_DECLINE_MS
      // of it was not read by a person.
      const quick = options.now() - (sealed.until - timeout) < AUTO_DECLINE_MS;
      const reply = replyOf(inputResponse(options.responses, FORM_KEY), quick);
      const claimKey = `${sealed.checkpoint}:${sealed.form}:${sealed.agent}:${sealed.until}`;
      if (reply !== undefined && options.claim?.(claimKey, sealed.until) !== false) {
        return options.aborted?.() === true ? { action: "failed" } : reply;
      }
    }
    const form = render();
    pending = {
      params:
        options.localize === undefined
          ? form
          : { ...form, message: options.localize(form.message) },
      state: {
        checkpoint: key,
        form: digest,
        agent: options.agent,
        until: options.now() + timeout,
      },
    };
    return { action: "unavailable" };
  };
  const port: CreatorPrompt = {
    channel: options.channel,
    ask: (prompt): Promise<CreatorReply> =>
      round(prompt.checkpoint, formDigest(prompt), () => renderForm(prompt, t)),
    // A stack in one form; its id is the key of the sealed state.
    askStack: (prompt): Promise<CreatorReply> =>
      round(prompt.stack, stackPromptDigest(prompt), () => renderStackForm(prompt, t)),
  };
  return { port, pending: () => pending };
}
