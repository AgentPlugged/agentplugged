import { sha256Hex } from "@agentplugged/crypto";
import {
  type ActionRequest,
  type CheckpointOpenedPayload,
  type HighRiskAction,
  type InstallMode,
  LIFTING_DECISIONS,
  RULE_ACTIONS,
  type RuleAction,
} from "@agentplugged/protocol";
import { byOpening, checkpointPayload, truncate } from "../checkpoints/checkpoint-rules.js";
import { statusAt } from "../checkpoints/resolution-rules.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { engineCommandOnly } from "./command-match.js";
import { identityDigest } from "./install-plan.js";
import type { SessionTrust } from "./session.js";

/**
 * The gate of high-risk actions (calibrated), pure: what
 * `request_action` and `check_action` answer. A session that read external content is no longer a
 * reason to wait: the read is a trace in the journal (`session.external_read`), nothing more. The
 * gate refuses an action whose rule is `deny`, and validates an installation only when the creator
 * asked for it (`installs.mode: validate`): then a checkpoint `core` opens, which only the creator
 * resolves. Everything else proceeds, the tool's own rules still applying.
 */

/**
 * How long an approval holds: one hour, for the same request of the same session; an installation
 * approved for a story holds for the whole story.
 */
export const APPROVAL_TTL_MS = 60 * 60 * 1000;

/**
 * - `proceed`: the action may go on; the AI tool's own rules still apply (`ask` asks).
 *   `allowed`: nothing to validate; `approved`: the creator approved this very request;
 *   `exempt`: the engine's own command (`npx agentplugged …`).
 * - `wait`: a checkpoint is open for this request; `open`: one must be opened.
 * - `refused`: `rule_deny` (the rule in force is `deny`), or `rejected` (the creator refused this
 *   request).
 */
export type GateDecision =
  | { readonly kind: "proceed"; readonly reason: "allowed" | "exempt" }
  | { readonly kind: "proceed"; readonly reason: "approved"; readonly checkpoint: string }
  | { readonly kind: "wait"; readonly checkpoint: string }
  | { readonly kind: "open" }
  | { readonly kind: "refused"; readonly reason: "rule_deny" }
  | { readonly kind: "refused"; readonly reason: "rejected"; readonly checkpoint: string };

/**
 * What the gate knows of an installation: the creator's mode, and whether the approved
 * architecture plans every package the command installs, from the official registry.
 */
export interface InstallGate {
  readonly mode: InstallMode;
  readonly planned: boolean;
  /**
   * The command is read without any doubt and takes plain names of the official registry
   * (a planned one too). At the `validate` mode its point is of a medium risk, which a stack may group.
   */
  readonly official?: boolean;
}

/** The permission rule of a high-risk action, when it has one. */
export function ruleOf(action: HighRiskAction): RuleAction | undefined {
  return (RULE_ACTIONS as readonly string[]).includes(action) ? (action as RuleAction) : undefined;
}

/** A request as it is compared: control characters out, whitespace collapsed, never cut. */
export function normalizeDetail(detail: string): string {
  return [...detail]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 ? code < 0x7f || code >= 0xa0 : /\s/.test(char);
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** What the gate needs to know of a request. */
export interface GateRequest {
  readonly action: HighRiskAction;
  /** The whole request, normalized (`normalizeDetail`): what is hashed, never cut. */
  readonly detail: string;
  readonly story: string | undefined;
  /**
   * What an approval of an installation covers (`installIdentity`), when the engine reads
   * every installation of the command. The approval then holds for the same installation however it
   * is written (another version, `2>&1 | tail`, another working copy), and for nothing else.
   */
  readonly identity?: string | undefined;
}

/**
 * The SHA-256 (hexadecimal) of a request: its action and its whole normalized detail, or, for an
 * installation the engine reads, the identity of what it installs.
 */
export function requestDigest(
  request: Pick<GateRequest, "action" | "detail" | "identity">,
): string {
  if (request.action === "install_dependency" && request.identity !== undefined) {
    return identityDigest(request.identity);
  }
  return sha256Hex(`${request.action}\n${request.detail}`);
}

/**
 * True for a checkpoint `core` opened for this very request (action and digest, whatever its
 * story) in one of the names of this session.
 */
function sameRequest(
  checkpoint: CheckpointState,
  request: GateRequest,
  digest: string,
  identities: ReadonlySet<string>,
): boolean {
  const asked = checkpoint.request;
  if (checkpoint.source !== "untrusted_action" || asked === null) return false;
  if (!(asked.sessions ?? []).some((name) => identities.has(name))) return false;
  // The same action on the same line, however the digest was made (a request of an agent, which
  // names no folder, and the hook, which reads one, ask the same installation: one point).
  return (
    asked.action === request.action && (asked.digest === digest || asked.detail === request.detail)
  );
}

/**
 * The decision for a request, in order: the engine's own command proceeds; a `deny` rule refuses;
 * anything but an installation at the `validate` mode proceeds (a session that read
 * external content waits for nothing); else the last checkpoint opened for the same request in the
 * same session decides: open → wait, approved (a decision that lifts blocks) within the hour (the
 * whole story, for an installation) → proceed, approved longer ago → a new one, refused → refused;
 * none → open one.
 */
export function gateDecision(input: {
  readonly request: GateRequest;
  readonly trust: Pick<SessionTrust, "rules" | "identities">;
  readonly checkpoints: Iterable<CheckpointState>;
  readonly now: number;
  readonly install?: InstallGate;
}): GateDecision {
  const { request, trust, now, install } = input;
  if (request.action === "install_dependency" && engineCommandOnly(request.detail)) {
    return { kind: "proceed", reason: "exempt" };
  }
  const rule = ruleOf(request.action);
  if (rule !== undefined && trust.rules[rule] === "deny") {
    return { kind: "refused", reason: "rule_deny" };
  }
  if (request.action !== "install_dependency" || install?.mode !== "validate") {
    return { kind: "proceed", reason: "allowed" };
  }
  const digest = requestDigest(request);
  const identities = new Set(trust.identities);
  const last = [...input.checkpoints]
    .filter((checkpoint) => sameRequest(checkpoint, request, digest, identities))
    .sort(byOpening)
    .at(-1);
  if (last === undefined) return { kind: "open" };
  if (statusAt(last, now) !== "resolved" || last.resolution === null) {
    return { kind: "wait", checkpoint: last.id };
  }
  if (!LIFTING_DECISIONS.has(last.resolution.decision)) {
    return { kind: "refused", reason: "rejected", checkpoint: last.id };
  }
  const age = now - Date.parse(last.resolution.at);
  // The approval of an installation the engine read as safe to group (a medium risk: planned
  // or official) holds only while the project is still read that way. A copy that gained a `.npmrc`, a
  // script run at install time, or a dependency from elsewhere since is another thing than the creator
  // approved: a new point, at a high risk.
  if (
    last.risk === "medium" &&
    last.request?.action === "install_dependency" &&
    !(install.planned || install.official === true)
  ) {
    return { kind: "open" };
  }
  // An approval of an installation covers the family of the action for the story (`npm
  // install`, `npm ci`, `pnpm install`…: one identity) for as long as the story lasts, not for an hour:
  // the creator never validates the same installation again and again while a story goes on.
  const forStory = request.story !== undefined && last.story === request.story;
  return age >= 0 && (forStory || age < APPROVAL_TTL_MS)
    ? { kind: "proceed", reason: "approved", checkpoint: last.id }
    : { kind: "open" };
}

/** What the summary of an installation says of how the engine read it. */
function levelNote(level: "planned" | "official" | undefined): string {
  if (level === "planned") return "\n\nThe approved architecture plans this installation.";
  if (level === "official") {
    return "\n\nNo approved architecture declares this installation: read the packages it names. The engine read it without any doubt: plain names of the official registry, in a project that redirects nothing.";
  }
  return "";
}

/**
 * The checkpoint `core` opens before an installation, at the `validate` mode: a
 * `permission` (`high` risk, or `medium` when the engine reads the installation without any doubt),
 * with the request (shown cut at 500, identified by its digest and the session's names). Its summary
 * is English data. Texts are cut in UTF-16 units, never inside a surrogate pair. The journal has
 * called this point `untrusted_action` and keeps the name, so that every journal
 * reads the same.
 */
export function installCheckpoint(
  agent: string,
  request: GateRequest,
  trust: Pick<SessionTrust, "identities">,
  /**
   * The engine reads this installation without any doubt: a medium risk instead of a high one, which
   * a stack of points may group. `planned`: the approved architecture declares it;
   * `official`: it does not, but it takes only plain names of the official registry, in
   * a project that redirects nothing.
   */
  level?: "planned" | "official",
): CheckpointOpenedPayload {
  const shown = truncate(request.detail, 500);
  const action: ActionRequest = {
    action: request.action,
    detail: shown,
    digest: requestDigest(request),
    sessions: trust.identities.slice(0, 10).map((name) => truncate(name, 200)),
  };
  return {
    ...checkpointPayload({
      type: "permission",
      risk: level === undefined ? "high" : "medium",
      irreversible: false,
      title: truncate(`Install a dependency: ${request.detail}`, 120),
      summary: truncate(
        `${agent} asks to install a dependency (the installs are validated).${levelNote(level)}\n\nRequested: ${shown}`,
        2000,
      ),
      blocks:
        request.story === undefined ? [] : [{ action: "permission.use", story: request.story }],
    }),
    source: "untrusted_action",
    request: action,
  };
}
