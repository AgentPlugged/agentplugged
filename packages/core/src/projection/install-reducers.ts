import {
  type EventEnvelope,
  INSTALL_EVENT_TYPES,
  type InstallRecordedPayload,
  MACHINE_DEVICE_PATTERN,
} from "@agentplugged/protocol";
import { agentOf } from "./agent-reducers.js";
import type { Reducer } from "./reducers.js";

/**
 * The installations of dependencies the engine let through without asking (
 * `installs.mode: visible`, the default): the activity of the product shows them, so that nothing is installed
 * out of sight. Only the latest `MAX_RECORDED_INSTALLS` are kept in the state.
 */

/** The installations kept in `state.installs`. */
export const MAX_RECORDED_INSTALLS = 200;

/** `state.installs[]`: one installation let through. */
export interface InstallEntry {
  readonly ecosystem: string;
  readonly manager: string;
  /** The packages installed (none for the manifest's own dependencies). */
  readonly packages: readonly string[];
  readonly manifest: boolean;
  /** `hook` (the AI tool's hook) or `request` (an agent's `request_action`). */
  readonly via: string;
  /** Whether the approved architecture plans it, or null (not said: recorded). */
  readonly planned: boolean | null;
  /** The engine could not read what the command installs. */
  readonly unreadable: boolean;
  /** The agent that installed, or null. */
  readonly agent: string | null;
  readonly at: string;
  readonly event: string;
}

/** The installations of a projection, oldest first. */
export function installsOf(state: Readonly<Record<string, unknown>>): InstallEntry[] {
  return (state.installs as InstallEntry[] | undefined) ?? [];
}

function applyInstall(draft: Parameters<Reducer>[0], event: EventEnvelope): void {
  if (event.actor.kind !== "agent" || !MACHINE_DEVICE_PATTERN.test(event.actor.device)) {
    draft.ignored.push({ id: event.id, reason: "invalid" });
    return;
  }
  const payload = event.payload as InstallRecordedPayload;
  agentOf(draft, event);
  const installs = (draft.state.installs as InstallEntry[] | undefined) ?? [];
  installs.push({
    ecosystem: payload.ecosystem,
    manager: payload.manager,
    packages: [...payload.packages],
    manifest: payload.manifest,
    via: payload.via,
    planned: payload.planned ?? null,
    unreadable: payload.unreadable === true,
    agent: event.actor.agent ?? null,
    at: event.at,
    event: event.id,
  });
  if (installs.length > MAX_RECORDED_INSTALLS) {
    installs.splice(0, installs.length - MAX_RECORDED_INSTALLS);
  }
  draft.state.installs = installs;
}

/** The reducer of the planned installations let through. */
export const INSTALL_REDUCERS: Readonly<Record<string, Reducer>> = {
  [INSTALL_EVENT_TYPES.recorded]: (draft, event) => applyInstall(draft, event),
};
