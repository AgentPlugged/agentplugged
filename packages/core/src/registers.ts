/**
 * What the registers kept in the projection's state have in common (deferred work, deviations):
 * records by id, each carrying the ULID of the event that wrote it, which gives their order.
 */

/** The records under `state[key]`, by id; none when the state holds nothing there. */
export function recordsOf<T>(
  state: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, T>> {
  const value = state[key];
  return typeof value === "object" && value !== null ? (value as Record<string, T>) : {};
}

/** The record `id` of a register, or undefined (never an inherited property). */
export function recordById<T>(records: Readonly<Record<string, T>>, id: string): T | undefined {
  return Object.hasOwn(records, id) ? records[id] : undefined;
}

/** Writing order: the ULID of the event that wrote the record. */
export function byEvent(a: { readonly event: string }, b: { readonly event: string }): number {
  return a.event < b.event ? -1 : a.event > b.event ? 1 : 0;
}
