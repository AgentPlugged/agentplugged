import { ErrorCode, type ErrorPayload, issueName } from "@agentplugged/protocol";

/** Expected, translatable failure: `{ code, message_key, details }`. */
export class AgentPluggedError extends Error {
  readonly code: ErrorCode;
  readonly message_key: string;
  readonly details: Readonly<Record<string, unknown>>;
  /**
   * What the engine adds when it answers an agent (the gesture to make, how many times the same
   * refusal came): sent with the details, never part of them, so that the cause of the refusal and
   * the advice stay apart.
   */
  readonly advice: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    messageKey: string,
    details: Record<string, unknown> = {},
    advice: Record<string, unknown> = {},
  ) {
    super(`${code}: ${messageKey}`);
    this.name = "AgentPluggedError";
    this.code = code;
    this.message_key = messageKey;
    this.details = details;
    this.advice = advice;
  }

  toPayload(): ErrorPayload {
    return {
      code: this.code,
      message_key: this.message_key,
      details: { ...this.details, ...this.advice },
    };
  }
}

/**
 * `details` of a field error: the English `reason`, plus `reason_key` (a message key surfaces
 * translate) when the reason is a known schema message, or when `reasonKey` is given.
 */
export function reasonDetails(
  reason: string,
  reasonKey?: string,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  const known = issueName(reason);
  const key = reasonKey ?? (known === undefined ? undefined : `reason.${known}`);
  return key === undefined ? { reason, ...params } : { reason, reason_key: key, ...params };
}

/** `UNEXPECTED`, with the reason it states. */
export function unexpected(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", { reason });
}

/** `UNEXPECTED`: `what` (a port the caller did not give) is not available here. */
export function unavailable(what: string): AgentPluggedError {
  return unexpected(`${what} is not available here`);
}
