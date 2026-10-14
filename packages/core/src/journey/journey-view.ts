import type { JourneyStep } from "@agentplugged/protocol";
import { skippedList } from "./journey-rules.js";

/**
 * The steps the creator skipped, as `next` and `get_state` show them: the journey is a
 * proposal, so a skipped step is shown as skipped (the creator's choice, with who said it and why),
 * never as an error, and it is not proposed again. The creator may take it up again at any time
 * (`step_resume`).
 */

/** The most skipped steps shown: the newest ones; the total says how many there are. */
export const SKIPPED_SHOWN = 40;

/** The longest reason shown. */
const REASON_SHOWN = 200;

/** A step skipped, as shown. */
export interface SkippedView {
  readonly step: JourneyStep;
  /** The story it covers, or null for the product (or every story). */
  readonly story: string | null;
  /** The creator's reason, or `no reason given`. */
  readonly reason: string;
  /** Who decided it: `creator` (the chat or the form), or their device (the terminal). */
  readonly by: string;
  /** Where the answer was given. */
  readonly source: string;
  readonly at: string;
}

/** What `next` and `get_state` say of the skipped steps. */
export interface JourneyView {
  /** The steps skipped, oldest first. */
  readonly skipped: readonly SkippedView[];
  readonly skipped_total: number;
}

/** The skipped steps of a projection's state. */
export function journeyView(state: Readonly<Record<string, unknown>>): JourneyView {
  const all = skippedList(state);
  return {
    skipped: all.slice(-SKIPPED_SHOWN).map((skip) => ({
      step: skip.step,
      story: skip.story,
      reason:
        skip.reason.length > REASON_SHOWN
          ? `${skip.reason.slice(0, REASON_SHOWN - 1)}…`
          : skip.reason,
      by: skip.by,
      source: skip.source,
      at: skip.at,
    })),
    skipped_total: all.length,
  };
}
