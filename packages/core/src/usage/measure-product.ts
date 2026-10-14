import type { MethodConfig } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { forgetProductKey, projectionKey } from "../journal/product-key.js";
import type { StateStore } from "../journal/state-store.js";
import { skippedPhases } from "../journey/journey-rules.js";
import { activePhases, phaseAt, phaseEndTimes } from "../phases/phases.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { computeProjectionDetailed } from "../projection/compute-projection.js";
import { journalFacts, type MeasureResult, writeMeasures } from "./measure-usage.js";
import type { UsageState } from "./usage-rules.js";

/** A trace modified up to this long before its measure is read again: the measure was written after the read. */
const UNCHANGED_SLACK_MS = 60_000;

/** What measuring the product's sessions did on this machine. */
export interface MeasureOutcome extends MeasureResult {
  /** False when this machine has no AI tool's traces to read (no `usageTraces`). */
  readonly available: boolean;
  /** False when this machine cannot read the product's measures (no product key): nothing written. */
  readonly readable: boolean;
}

/**
 * Measures the product's sessions and writes what is new or changed. Needs the
 * product key: the measures are encrypted, and what the journal already holds must be read to
 * write only what changed. Never throws for the traces: a machine without them measures nothing.
 */
export async function measureProduct(
  context: CommandContext,
  target: { readonly product: string; readonly journal: StateStore; readonly config: MethodConfig },
): Promise<MeasureOutcome> {
  const none = { read: 0, skipped: 0, written: 0, stories: [] as string[] };
  if (context.usageTraces === undefined) return { ...none, available: false, readable: true };
  const access = await projectionKey(context, target.product);
  if (access.key === undefined) return { ...none, available: true, readable: false };
  try {
    const listing = await target.journal.list();
    const detailed = await computeProjectionDetailed(listing.events, {
      problems: listing.problems,
      head: listing.head,
      product: target.product,
      allowTestTypes: context.allowTestTypes === true,
      productKey: access.key,
    });
    const held = (detailed.projection.state.usage as UsageState | undefined)?.sessions ?? {};
    const { folders } = journalFacts(listing.events);
    // A session already tied to a story whose trace was not touched since is not read again: only
    // the sessions still running, and those tied to no story (the journal may know more now).
    const since = (session: string) => {
      const was = Object.hasOwn(held, session) ? held[session] : undefined;
      // A story's session measured holds no step (a story's parts always get
      // one now): it is read once more, to be attributed.
      return was === undefined ||
        was.story === null ||
        was.parts === undefined ||
        (was.parts.length > 0 && !was.parts.some((part) => part.step !== undefined))
        ? undefined
        : Date.parse(was.at) - UNCHANGED_SLACK_MS;
    };
    const traces = await context.usageTraces.read(
      [...new Set(folders.map((folder) => folder.worktree))],
      since,
    );
    // The phase current at a time, from the phases the journal's approved ends closed.
    const state = detailed.projection.state;
    const checkpoints = Object.values(
      (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
    );
    const active = activePhases(target.config.profile, skippedPhases(state));
    const now = (context.now ?? Date.now)();
    const result = await writeMeasures({
      phaseAt: (time) => phaseAt(time, checkpoints, active, now),
      phaseEnds: phaseEndTimes(checkpoints, now),
      journal: target.journal,
      product: target.product,
      listing,
      traces,
      held,
    });
    return { ...result, available: true, readable: true };
  } finally {
    await forgetProductKey(access.key);
  }
}
