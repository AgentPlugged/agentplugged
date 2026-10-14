import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { AgentIdSchema } from "./method-config.js";

/**
 * Untrusted content, a trace. A session of an AI tool
 * (one `agentplugged` MCP server) is untrusted once it read external content: the hooks `sync`
 * writes report every such read (`record_external_read`), and an agent may declare one. The
 * journal keeps it (`session.external_read`: source, time, agent) and everything such a session
 * writes carries `provenance: untrusted`: for the history and the audit, never to block. No
 * memory, retrospective, installation nor validation point waits for it. Nothing an agent calls
 * makes a session trusted again.
 */

/** Event types of untrusted content, each at version 1. */
export const SESSION_EVENT_TYPES = {
  externalRead: "session.external_read",
} as const;

/**
 * The actions of high risk: the permission rules that act outside the
 * working branch, deploying, publishing, and `other` (an action the agent judges risky).
 */
export const HIGH_RISK_ACTIONS = [
  "install_dependency",
  "destructive_command",
  "push_main",
  "force_push",
  "read_secrets",
  "deploy",
  "publish",
  "other",
] as const;
export type HighRiskAction = (typeof HIGH_RISK_ACTIONS)[number];

/** How the internet rule marked a session of a journal written: `allow` or `ask`. */
export const UNTRUSTED_INTERNET_RULES = ["allow", "ask"] as const;

/** A free text of 1 to `max` characters. */
const text = (max: number) => z.string().trim().min(1).max(max);

/** A session id of an AI tool (Claude Code's `session_id`), as a hook gives it. */
const SessionIdSchema = z.string().trim().max(200);

/** One external read: the tool that read it and its source (a host, a tool name). */
export const ExternalReadSchema = z.strictObject({
  tool: text(200),
  source: text(200),
});
export type ExternalRead = z.infer<typeof ExternalReadSchema>;

/** `payload` of `session.external_read`: the read, and the tool's session when known. */
export const ExternalReadPayloadSchema = z.strictObject({
  ...ExternalReadSchema.shape,
  session: text(200).optional(),
});
export type ExternalReadPayload = z.infer<typeof ExternalReadPayloadSchema>;

/**
 * Why a checkpoint's session was untrusted, written by `core` in `checkpoint.opened` (never by
 * an agent): the internet rule that opened it, and the reads known (at most 10).
 * No longer written; the older journals keep it for the history.
 */
export const UntrustedMarkSchema = z.strictObject({
  internet: z.enum(UNTRUSTED_INTERNET_RULES).optional(),
  reads: z.array(ExternalReadSchema).max(10),
});
export type UntrustedMark = z.infer<typeof UntrustedMarkSchema>;

/**
 * The action a checkpoint of `request_action` or `check_action` asks for (an installation,): `detail` is
 * the request as shown (cut at 500), `digest` the SHA-256 of the whole normalized request (what
 * identifies it, never cut) or, for an installation the engine reads, of the identity
 * of what it installs (the manager, the package names, the options: not a version, not how the
 * output is shown), `sessions` the names of the session that asked (server instance,
 * tool session ids): an approval holds for that session only.
 */
export const ActionRequestSchema = z.strictObject({
  action: z.enum(HIGH_RISK_ACTIONS),
  detail: text(500),
  digest: z.string().regex(/^[0-9a-f]{64}$/, { message: "expected a SHA-256 in hexadecimal" }),
  sessions: z.array(text(200)).min(1).max(10),
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

const agent = AgentIdSchema.max(64);

/**
 * Input of `record_external_read`: what was read, by which tool. Claude Code's hooks give the
 * values as they substitute them (`${tool_input.url}`), possibly empty: `source` is optional and
 * may be any text, which `core` reduces (a host for a URL) and cleans.
 */
export const RecordExternalReadInputSchema = z.strictObject({
  tool: text(200),
  source: z.string().max(4000).optional(),
  session: SessionIdSchema.optional(),
  agent: agent.optional(),
});
export type RecordExternalReadInput = z.infer<typeof RecordExternalReadInputSchema>;

/** Input of `request_action`: an agent asks before a high-risk action. */
export const RequestActionInputSchema = z.strictObject({
  agent,
  action: z.enum(HIGH_RISK_ACTIONS),
  detail: text(500),
  story: StoryIdSchema.optional(),
});
export type RequestActionInput = z.infer<typeof RequestActionInputSchema>;

/** Input of `check_action`: a Claude Code `PreToolUse` hook, before a high-risk command. */
export const CheckActionInputSchema = z.strictObject({
  action: z.enum(HIGH_RISK_ACTIONS),
  command: z.string().max(4000),
  session: SessionIdSchema.optional(),
  /**
   * The folder the tool runs the command in (the hook's `cwd`): an installation is
   * read against the project's own files, so `visible` skips the validation only from its root.
   */
  cwd: z.string().max(1000).optional(),
});
export type CheckActionInput = z.infer<typeof CheckActionInputSchema>;
