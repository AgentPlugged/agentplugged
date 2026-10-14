/**
 * The sequence of the messages of one pair of devices. The sender
 * numbers its messages 1, 2, 3… and records the number durably before sending; the receiver keeps
 * a sliding window of the last 64 numbers: a number already seen is a replay (`duplicate`), a number
 * 64 or more below the highest received is too old, and a delivery out of order inside the window
 * is accepted (a relay that reorders removes nothing). Holes are not counted: the bridge's signed
 * heartbeat says what was sent last.
 *
 * Pure data: `state()` is plain JSON the caller stores (before opening the message, §8), and
 * `SequenceWindow.restore` reads it back. A device that loses this state, or restores a backup of
 * it, links again. The window moves only on `accept`, which the caller calls after the message's
 * signature verified: an attacker's forged number must never push the window forward.
 */

/** Size of the window: numbers `highest - 63` to `highest` are tracked. */
export const SEQUENCE_WINDOW_SIZE = 64;

export type SequenceVerdict = "accepted" | "duplicate" | "too_old" | "invalid";

export interface SequenceWindowState {
  /** The highest number accepted, 0 before any. */
  readonly highest: number;
  /** The numbers accepted in the window `(highest - 64, highest]`, ascending. */
  readonly seen: readonly number[];
}

const isSequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** The next number a sender uses after `last` (0 before any); throws at the end of the safe range. */
export function nextSequence(last: number): number {
  if (!Number.isSafeInteger(last) || last < 0 || last >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("the sequence cannot go on");
  }
  return last + 1;
}

export class SequenceWindow {
  #highest: number;
  #seen: number[];

  constructor() {
    this.#highest = 0;
    this.#seen = [];
  }

  /** The window kept in `state`, or undefined when it is not a valid state (never guessed). */
  static restore(state: unknown): SequenceWindow | undefined {
    if (typeof state !== "object" || state === null) return undefined;
    const { highest, seen } = state as { highest?: unknown; seen?: unknown };
    if (typeof highest !== "number" || !Number.isSafeInteger(highest) || highest < 0)
      return undefined;
    if (!Array.isArray(seen) || seen.length > SEQUENCE_WINDOW_SIZE) return undefined;
    let previous = 0;
    for (const value of seen) {
      if (!isSequence(value) || value <= previous) return undefined;
      if (value > highest || value <= highest - SEQUENCE_WINDOW_SIZE) return undefined;
      previous = value;
    }
    if (highest > 0 && seen.at(-1) !== highest) return undefined;
    if (highest === 0 && seen.length > 0) return undefined;
    const window = new SequenceWindow();
    window.#highest = highest;
    window.#seen = [...seen];
    return window;
  }

  /** What `accept(seq)` would answer, without moving the window. */
  check(seq: number): SequenceVerdict {
    if (!isSequence(seq)) return "invalid";
    if (seq > this.#highest) return "accepted";
    if (seq <= this.#highest - SEQUENCE_WINDOW_SIZE) return "too_old";
    return this.#seen.includes(seq) ? "duplicate" : "accepted";
  }

  /** Records `seq` when it is accepted; the verdict says why not otherwise. */
  accept(seq: number): SequenceVerdict {
    const verdict = this.check(seq);
    if (verdict !== "accepted") return verdict;
    if (seq > this.#highest) this.#highest = seq;
    this.#seen.push(seq);
    this.#seen = [...new Set(this.#seen)]
      .filter((value) => value > this.#highest - SEQUENCE_WINDOW_SIZE)
      .sort((a, b) => a - b);
    return "accepted";
  }

  /** The state to store (plain JSON). */
  state(): SequenceWindowState {
    return { highest: this.#highest, seen: [...this.#seen] };
  }
}
