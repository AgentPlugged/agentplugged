import {
  CHECKPOINT_EVENT_TYPES,
  CheckActionInputSchema,
  checkpointIdOf,
  ErrorCode,
  type ExternalReadPayload,
  type HighRiskAction,
  INSTALL_EVENT_TYPES,
  MAIN_SESSION_AGENT,
  type MethodConfig,
  RecordExternalReadInputSchema,
  RequestActionInputSchema,
  SESSION_EVENT_TYPES,
} from "@agentplugged/protocol";
import {
  agentWriteContext,
  invalidInput,
  project,
  provenanceOf,
} from "../agent-activity/agent-commands.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { loadMethodConfig } from "../init/method-config.js";
import type { JournalListing, StateStore } from "../journal/state-store.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { commandMatches, isNetworkCommand } from "./command-match.js";
import {
  type GateDecision,
  type GateRequest,
  gateDecision,
  type InstallGate,
  installCheckpoint,
  normalizeDetail,
  ruleOf,
} from "./gate.js";
import { installFolders } from "./install-folders.js";
import { type InstallTarget, type InstallVerdict, plannedInstall } from "./install-plan.js";
import { resolveInstallSettings } from "./install-settings.js";
import { plannedDependencies } from "./planned-dependencies.js";
import { readSource, type SessionTrust, sessionTrust, usableId } from "./session.js";

/** What `request_action` answers. */
export interface RequestActionResult {
  /** `proceed`: go on (the tool may still ask); `wait`: the creator must answer first; `refused`. */
  readonly decision: "proceed" | "wait" | "refused";
  /** `allowed`, `exempt`, `approved`, `open` (a checkpoint waits), `rule_deny`, `rejected`. */
  readonly reason: "allowed" | "exempt" | "approved" | "open" | "rule_deny" | "rejected";
  /** The checkpoint of this request, when there is one. */
  readonly checkpoint?: string;
}

/** Aborts a write the gate does not need (the checkpoint already exists, or none is needed). */
class NoCheckpoint extends Error {
  constructor(readonly decision: GateDecision) {
    super("no checkpoint to open");
  }
}

/** What a gate needs once the agent is known active: the journal and the session's trust. */
interface GateTarget {
  readonly product: string;
  readonly journal: StateStore;
  readonly config: MethodConfig;
  readonly trust: SessionTrust;
}

/** The product, its journal (read once) and the session's trust, for `agent`. */
async function gateTarget(
  context: CommandContext,
  agent: string,
): Promise<GateTarget | AgentPluggedError> {
  const target = await agentWriteContext(context, agent);
  if (target instanceof AgentPluggedError) return target;
  const listing = await target.journal.list();
  const trust = await sessionTrust(context, target.config, listing.events);
  return { ...target, trust };
}

/**
 * What the gate knows of an installation: the creator's mode, read on the main branch,
 * and whether the approved architecture plans every package the command installs.
 */
async function installGateOf(
  context: CommandContext,
  target: GateTarget,
  command: string,
  via: "hook" | "request",
  /** The folder the tool runs the command in, when the hook gave it. */
  cwd: string | undefined,
): Promise<{ gate: InstallGate; verdict: InstallVerdict }> {
  const { mode } = await resolveInstallSettings(target.config, context.mainBranch);
  const { state } = await project(context, target.config, await target.journal.list());
  const declared = await plannedDependencies(context, state);
  // Where the installation runs: the product's folder, or the working copy of one of
  // its stories (the hook gives the folder the tool runs in; the command may name its own). The
  // project's files are read there, and nowhere else: an unknown folder is never read as planned
  // nor official (a point at the `validate` mode is then of a high risk, and the activity shows the
  // installation as not planned). Without the hook's folder, nothing is read from the root.
  const folders = installFolders(
    context,
    (state.stories as Record<string, { started?: { worktree: string } }> | undefined) ?? {},
    via === "hook" ? cwd : undefined,
  );
  const verdict = await plannedInstall(command, declared, folders);
  return { gate: { mode, planned: verdict.planned, official: verdict.official }, verdict };
}

/**
 * The level of an installation's point at the `validate` mode: medium when
 * the architecture plans it, or when it does not but the engine reads it without any doubt (plain
 * names of the official registry); high otherwise.
 */
function checkpointLevel(
  install: { gate: InstallGate; verdict: InstallVerdict } | undefined,
  detail: string,
): "planned" | "official" | undefined {
  if (install === undefined) return undefined;
  if (install.verdict.planned) return "planned";
  // A line the point would show cut (500 characters) is not one a stack groups unread.
  if (detail.length >= 500) return undefined;
  return install.verdict.official ? "official" : undefined;
}

/**
 * Writes what an installation let through (`install.recorded`, one event per installation of the
 * command, with whether the approved architecture plans it): the product's activity shows it, so
 * nothing is installed out of sight.
 */
async function recordInstalls(
  target: GateTarget,
  agent: string,
  trust: SessionTrust,
  targets: readonly InstallTarget[],
  via: "hook" | "request",
  planned: boolean,
): Promise<void> {
  for (const entry of targets) {
    // A manager the schema cannot name (a program with a path or capitals) is left out.
    if (entry.kind === "unreadable" && !/^[a-z][a-z0-9.+-]{0,31}$/.test(entry.manager)) continue;
    await target.journal.append({
      type: INSTALL_EVENT_TYPES.recorded,
      actor: { kind: "agent", agent },
      product: target.product,
      provenance: provenanceOf(trust),
      payload: {
        ecosystem: entry.kind === "unreadable" ? "other" : entry.ecosystem,
        manager: entry.manager,
        packages: entry.kind === "packages" ? entry.packages.slice(0, 50) : [],
        manifest: entry.kind === "manifest",
        via,
        planned: entry.kind === "unreadable" ? false : planned,
        ...(entry.kind === "unreadable" ? { unreadable: true } : {}),
      },
    });
  }
}

/**
 * The gate of one request: the decision taken under the journal lock, on the
 * journal as it is when written, so that two identical requests open one checkpoint. An `open`
 * decision writes the checkpoint (signed by the machine, `actor.agent` the agent asking, `main`
 * for a hook) and answers `wait`.
 */
async function runGate(
  context: CommandContext,
  target: GateTarget,
  agent: string,
  input: {
    action: HighRiskAction;
    detail: string;
    story?: string | undefined;
    cwd?: string | undefined;
  },
  via: "hook" | "request" = "hook",
): Promise<GateDecision> {
  const { trust } = target;
  const now = (context.now ?? Date.now)();
  // An installation follows the creator's mode.
  const install =
    input.action === "install_dependency"
      ? await installGateOf(context, target, input.detail, via, input.cwd)
      : undefined;
  const request: GateRequest = {
    action: input.action,
    detail: normalizeDetail(input.detail) || input.action,
    // The hook gives no story: the working copy the installation runs in names it.
    story: input.story ?? install?.verdict.story,
    // An approval covers the installation itself, not how it is written.
    identity: install?.verdict.identity,
  };
  // What needs no checkpoint of the journal: everything but an installation at the `validate` mode,
  // a `deny` rule, the engine's own command. An installation at the `visible` mode goes through
  // and is recorded (shown in the activity, written to the journal, never validated).
  const early = gateDecision({
    request,
    trust,
    checkpoints: [],
    now,
    ...(install === undefined ? {} : { install: install.gate }),
  });
  if (early.kind !== "open") {
    if (
      early.kind === "proceed" &&
      early.reason === "allowed" &&
      install?.gate.mode === "visible"
    ) {
      await recordInstalls(
        target,
        agent,
        trust,
        install.verdict.targets,
        via,
        install.verdict.planned,
      );
    }
    return early;
  }
  const decide = async (listing: JournalListing) => {
    const { state } = await project(context, target.config, listing);
    return gateDecision({
      request,
      trust,
      checkpoints: Object.values(checkpointsOf(state)),
      now,
      ...(install === undefined ? {} : { install: install.gate }),
    });
  };
  try {
    const events = await target.journal.appendAll(
      [
        {
          type: CHECKPOINT_EVENT_TYPES.opened,
          actor: { kind: "agent", agent },
          product: target.product,
          ...(request.story === undefined ? {} : { story: request.story }),
          provenance: "untrusted",
          payload: {
            ...installCheckpoint(agent, request, trust, checkpointLevel(install, request.detail)),
          },
        },
      ],
      {
        precondition: async (listing) => {
          const decision = await decide(listing);
          if (decision.kind !== "open") throw new NoCheckpoint(decision);
        },
      },
    );
    const opened = events[0];
    if (opened === undefined) throw new Error("gate: nothing was written");
    return { kind: "wait", checkpoint: checkpointIdOf(opened.id) };
  } catch (error) {
    if (error instanceof NoCheckpoint) return error.decision;
    throw error;
  }
}

/** True when the journal already holds this read, for this tool session (or for none). */
function alreadyRecorded(
  listing: JournalListing,
  read: { tool: string; source: string },
  session: string | undefined,
): boolean {
  return listing.events.some((event) => {
    if (event.type !== SESSION_EVENT_TYPES.externalRead || event.payload === undefined) {
      return false;
    }
    const payload = event.payload as Partial<ExternalReadPayload>;
    return (
      payload.tool === read.tool && payload.source === read.source && payload.session === session
    );
  });
}

/**
 * True for a read declared by a shell command (`Bash`) that fetches nothing from outside the
 * product. Never for a source that is a URL, or the value a hook could not substitute (the whole
 * source is a `${…}`), or for an absent source: when in doubt, the read counts.
 */
function isLocalShellCommand(tool: string, source: string | undefined): boolean {
  if (tool.trim() !== "Bash" || source === undefined) return false;
  const command = source.trim();
  if (command === "" || /^\$\{[^}]*\}$/.test(command) || /^https?:\/\//i.test(command)) {
    return false;
  }
  return !isNetworkCommand(command);
}

/**
 * `record_external_read`: an external read of the calling session, from a Claude Code
 * `PostToolUse` hook `sync` writes, or declared by an agent. A trace, nothing more: a new
 * read (tool, source) is written once to the journal (`session.external_read`: source, time, agent),
 * and joins the session only once written; no action of the session is blocked for it. Answers `{}`,
 * which a hook reads as no decision.
 */
export const recordExternalReadCommand = defineCommand<Record<string, never>>({
  name: "record_external_read",
  audience: "agent",
  description:
    "Record that this session read external content: a web page, a search, a comment, a message, a data connection, a command that fetched something. Claude Code's hooks call it for you after WebFetch, WebSearch, network commands (curl, wget, gh, git pull/fetch/clone) and other MCP servers' tools; in other tools, call it yourself after such a read (`tool` the tool you used, `source` the URL or where it came from). It only leaves a trace in the journal (source, time, agent): reading the internet blocks nothing, neither your memory, nor a retrospective, nor an installation.",
  inputSchema: RecordExternalReadInputSchema,
  async run(context, input) {
    const parsed = RecordExternalReadInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("record_external_read", parsed.error));
    const { tool, source, session: id, agent = MAIN_SESSION_AGENT } = parsed.data;
    const target = await agentWriteContext(context, agent);
    if (target instanceof AgentPluggedError) return fail(target);
    const session = context.session;
    session?.learn(id);
    // A shell command is checked again here, as `check_action` does: a Claude Code that cannot
    // tell what a command holds (a here-document, a quoted string) calls the hook all the same.
    // A command that fetches nothing from outside (`cat > f <<'EOF'`, `sed -n`) is no read.
    if (isLocalShellCommand(tool, source)) return ok({});
    const read = readSource(tool, source);
    const sessionId = usableId(id);
    try {
      // Once per session, tool and source: the hooks call it after every read. Without a
      // session, the journal tells whether it is already there.
      if (session !== undefined ? session.hasRead(read) : false) return ok({});
      if (session === undefined && alreadyRecorded(await target.journal.list(), read, sessionId)) {
        return ok({});
      }
      await target.journal.append({
        type: SESSION_EVENT_TYPES.externalRead,
        actor: { kind: "agent", agent },
        product: target.product,
        provenance: "untrusted",
        payload: { ...read, ...(sessionId === undefined ? {} : { session: sessionId }) },
      });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
    // Only once written: a read that could not be recorded is tried again by the next hook.
    session?.addRead(read);
    return ok({});
  },
});

/** The answer of `request_action` for a decision. */
function requestResult(decision: GateDecision): RequestActionResult {
  switch (decision.kind) {
    case "proceed":
      return decision.reason === "approved"
        ? { decision: "proceed", reason: "approved", checkpoint: decision.checkpoint }
        : { decision: "proceed", reason: decision.reason };
    case "wait":
      return { decision: "wait", reason: "open", checkpoint: decision.checkpoint };
    case "refused":
      return decision.reason === "rule_deny"
        ? { decision: "refused", reason: "rule_deny" }
        : { decision: "refused", reason: "rejected", checkpoint: decision.checkpoint };
    default:
      throw new Error("request_action: no checkpoint was opened");
  }
}

/**
 * `request_action`: an agent asks before a high-risk action. It proceeds,
 * whatever the session has read, unless a `deny` rule refuses the action or the creator
 * validates installations (`installs.mode: validate`): then a checkpoint `core` opens (one per
 * request: action and whole detail, in this session) and the agent waits for the creator's answer.
 */
export const requestActionCommand = defineCommand<RequestActionResult>({
  name: "request_action",
  audience: "agent",
  description:
    "Ask before a high-risk action: installing a dependency, a destructive command, pushing to the main branch, force-pushing, reading secrets, deploying, publishing, or any other action you judge risky (`other`). `detail` is the exact command or target. You get `proceed`, whatever you have read before. Only when the creator validates installations (`installs.mode: validate`) does an installation get `wait` with a checkpoint (G-…) the creator must approve: do not install, work on something else, and ask again with the same request later; once approved, you get `proceed` for the story (for one hour for another action). `refused` means never: a `deny` rule, or the creator refused this request. `proceed` does not lift the AI tool's own permission prompts.",
  inputSchema: RequestActionInputSchema,
  async run(context, input) {
    const parsed = RequestActionInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("request_action", parsed.error));
    const { agent, action, detail, story } = parsed.data;
    try {
      const target = await gateTarget(context, agent);
      if (target instanceof AgentPluggedError) return fail(target);
      const decision = await runGate(context, target, agent, { action, detail, story }, "request");
      return ok(requestResult(decision));
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/** A `PreToolUse` hook's answer: no decision (`{}`), or a denial with its reason. */
export type HookAnswer =
  | Record<string, never>
  | {
      readonly hookSpecificOutput: {
        readonly hookEventName: "PreToolUse";
        readonly permissionDecision: "deny";
        readonly permissionDecisionReason: string;
      };
    };

function deny(reason: string): HookAnswer {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * The answer for a command the gate could not check: closed only when the creator
 * validates installations, where an unchecked one would skip their validation. At the default mode
 * the gate is a trace, never a reason to refuse.
 */
async function unchecked(context: CommandContext, code: string): Promise<HookAnswer> {
  try {
    const loaded = await loadMethodConfig(context.files);
    const mode =
      loaded instanceof AgentPluggedError
        ? undefined
        : (await resolveInstallSettings(loaded.config, context.mainBranch)).mode;
    if (mode !== "validate") return {};
  } catch {
    // The mode cannot be read: the default applies.
    return {};
  }
  return deny(`AgentPlugged n'a pas pu vérifier cette commande (${code}) ; réessaie.`);
}

/** The hook's answer for a decision. */
function hookAnswer(decision: GateDecision): HookAnswer {
  switch (decision.kind) {
    case "wait":
      return deny(
        `AgentPlugged: the creator validates installations, and checkpoint ${decision.checkpoint} waits for their answer in the chat: do not try another way; work on something else, then run the same command again once it is approved.`,
      );
    case "refused":
      return deny(
        decision.reason === "rule_deny"
          ? "AgentPlugged: the permission rules deny this action."
          : `AgentPlugged: the creator refused this command (checkpoint ${decision.checkpoint}). Do not run it.`,
      );
    case "proceed":
      return {};
    default:
      return {};
  }
}

/**
 * `check_action`: a Claude Code `PreToolUse` hook `sync` writes, before a command matching a
 * high-risk rule. The same gate as `request_action`, for the session's main agent (`main`): an
 * approved `request_action` of the same command in this session lets it through. It answers
 * `{}` to let the tool's own rules decide, or a denial whose reason tells the agent which
 * checkpoint to wait for. It fails closed: an input it cannot read or a check it cannot finish
 * (the journal busy, the method not installed) is a denial. Never an `allow`.
 */
export const checkActionCommand = defineCommand<HookAnswer>({
  name: "check_action",
  audience: "agent",
  description:
    "Called by Claude Code's PreToolUse hooks before a high-risk command; you do not need to call it (use request_action). Answers a hook decision: nothing, or a denial while the creator has not approved the command.",
  inputSchema: CheckActionInputSchema,
  async run(context, input) {
    const parsed = CheckActionInputSchema.safeParse(input);
    if (!parsed.success) return ok(await unchecked(context, ErrorCode.INVALID_ARGUMENTS));
    const { action, command, session: id, cwd } = parsed.data;
    try {
      context.session?.learn(id);
      const target = await gateTarget(context, MAIN_SESSION_AGENT);
      if (target instanceof AgentPluggedError) return ok(await unchecked(context, target.code));
      // Checked again here, with the main branch `sync` wrote the hooks with: a Claude Code
      // that ignores `if` calls the hook for every command.
      const rule = ruleOf(action);
      if (rule !== undefined && !commandMatches(rule, command, target.trust.mainBranch)) {
        return ok({});
      }
      const decision = await runGate(context, target, MAIN_SESSION_AGENT, {
        action,
        detail: command,
        cwd,
      });
      return ok(hookAnswer(decision));
    } catch (error) {
      return ok(
        await unchecked(
          context,
          error instanceof AgentPluggedError ? error.code : ErrorCode.UNEXPECTED,
        ),
      );
    }
  },
});

/** The commands of untrusted content, exposed as MCP tools. */
export const trustCommands = [
  recordExternalReadCommand,
  requestActionCommand,
  checkActionCommand,
] as const;
