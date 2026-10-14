import { ErrorCode, ROOT_CHANGED_MESSAGE_KEY } from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import type { DeviceTrustView } from "../projection/device-trust.js";

/**
 * `SECURITY_ROOT_CHANGED`: the journal holds another root of trust than the one
 * this machine pinned. Every surface that would give an order for the product (the bridge, 6.13;
 * the views, 6.15) asks this first and gives none while it answers an error: better to block
 * than to be wrong. The way out is `agentplugged trust dismiss` at the terminal.
 */
export function rootChangedError(view: DeviceTrustView | undefined): AgentPluggedError | undefined {
  if (view === undefined || !view.blocked) return undefined;
  return new AgentPluggedError(ErrorCode.SECURITY_ROOT_CHANGED, ROOT_CHANGED_MESSAGE_KEY, {
    events: view.faults.map((fault) => fault.id),
  });
}

/** Throws `SECURITY_ROOT_CHANGED` while the alert stands. */
export function assertOrdersAllowed(view: DeviceTrustView | undefined): void {
  const error = rootChangedError(view);
  if (error !== undefined) throw error;
}

/** True when `device` is a trusted device of the registry (the root included). */
export function isTrustedDevice(view: DeviceTrustView | undefined, device: string): boolean {
  return view?.devices.some((entry) => entry.device === device) === true;
}
