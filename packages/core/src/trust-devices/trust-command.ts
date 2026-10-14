import {
  DEVICE_TRUST_EVENT_TYPES,
  ErrorCode,
  type MethodConfig,
  type RootPin,
} from "@agentplugged/protocol";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { humanKeyMissing, humanTarget, trustProblem, writeHuman } from "../human/human-commands.js";
import { localeSigner } from "../human/human-events.js";
import { loadHumanKey } from "../human/human-key.js";
import type { JournalListing } from "../journal/state-store.js";
import { computeProjectionDetailed } from "../projection/compute-projection.js";
import type { DeviceTrustView } from "../projection/device-trust.js";
import { rootChangedError } from "./root-changed.js";

/**
 * `agentplugged trust dismiss`: the way
 * out of `SECURITY_ROOT_CHANGED`. At the creator's terminal only; it names the events that raised
 * the alert and, once the creator answered the one question of the terminal (the CLI asks it, then
 * calls again with `confirm: true`), publishes `trust.dismissed`, signed by the creator's key.
 * Nothing else is ever dismissed, and it only runs when there is something wrong.
 */

export const TRUST_ACTIONS = ["dismiss"] as const;

/** The most events one `trust.dismissed` names (the schema). */
const MAX_DISMISSED_PER_EVENT = 16;

/** An event that raised the alert: what the terminal shows before the question. */
export interface TrustFaultView {
  readonly id: string;
  readonly hash: string;
  /** The creator key it registers. */
  readonly device: string;
  /** The date the event carries. */
  readonly at: string;
}

export type TrustResult =
  /** Nothing to dismiss: no pinned root on this machine, or the journal agrees with it. */
  | { readonly action: "dismiss"; readonly status: "none"; readonly pinned: boolean }
  /** The events that raised the alert, waiting for the creator's answer (`confirm`). */
  | {
      readonly action: "dismiss";
      readonly status: "list";
      readonly faults: readonly TrustFaultView[];
    }
  /** Published: `trust.dismissed` was written; `cleared` says the alert no longer stands. */
  | {
      readonly action: "dismiss";
      readonly status: "dismissed";
      readonly events: readonly string[];
      readonly cleared: boolean;
    };

async function project(
  context: CommandContext,
  config: MethodConfig,
  listing: JournalListing,
  pinned: RootPin,
) {
  // The creator's commands never need the sensitive content: projected without the product key.
  return computeProjectionDetailed(listing.events, {
    problems: listing.problems,
    head: listing.head,
    ...(config.product_id === undefined ? {} : { product: config.product_id }),
    allowTestTypes: context.allowTestTypes === true,
    pinnedRoot: pinned,
  });
}

function faultsOf(view: DeviceTrustView | undefined): readonly TrustFaultView[] {
  return (view?.faults ?? []).map(({ id, hash, device, at }) => ({ id, hash, device, at }));
}

export const trustDevicesCommand = defineCommand<TrustResult>({
  name: "trust",
  async run(context, input) {
    if (input.action !== "dismiss") {
      return fail(
        new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
          command: "trust",
          reason: `trust: ${String(input.action ?? "")} (${TRUST_ACTIONS.join(", ")})`,
        }),
      );
    }
    const target = await humanTarget(context, "trust");
    if (target instanceof AgentPluggedError) return fail(target);
    try {
      const pin = await context.rootPins?.read(target.product);
      if (pin === undefined) return ok({ action: "dismiss", status: "none", pinned: false });
      const listing = await target.journal.list();
      const first = await project(context, target.config, listing, pin);
      const faults = faultsOf(first.deviceTrust);
      if (faults.length === 0) return ok({ action: "dismiss", status: "none", pinned: true });
      if (input.confirm !== true) return ok({ action: "dismiss", status: "list", faults });

      const key = await loadHumanKey(target.human.keys, { create: false });
      if (key === undefined) return fail(humanKeyMissing());
      const untrusted = trustProblem(first.projection.state, key.device);
      if (untrusted !== undefined) return fail(untrusted);
      const at = new Date((context.now ?? Date.now)()).toISOString();
      // What the creator was shown (the CLI passes it back): a fault that arrived since is not
      // dismissed unseen. Without it, every fault standing now.
      const shown = Array.isArray(input.events) ? new Set(input.events as unknown[]) : undefined;
      const chosen = faults.filter((fault) => shown === undefined || shown.has(fault.hash));
      if (chosen.length === 0) return ok({ action: "dismiss", status: "list", faults });
      const hashes = chosen.map((fault) => fault.hash);
      // At most 16 hashes in one event (the schema): as many events as it takes, in one write.
      const drafts = [];
      for (let start = 0; start < hashes.length; start += MAX_DISMISSED_PER_EVENT) {
        drafts.push({
          type: DEVICE_TRUST_EVENT_TYPES.dismissed,
          payload: { events: hashes.slice(start, start + MAX_DISMISSED_PER_EVENT), issued_at: at },
          signer: localeSigner(key),
        });
      }
      await writeHuman(context, target, key, drafts);
      const after = await project(context, target.config, await target.journal.list(), pin);
      return ok({
        action: "dismiss",
        status: "dismissed",
        events: chosen.map((fault) => fault.id),
        cleared: after.deviceTrust?.blocked !== true,
      });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

export { rootChangedError };
