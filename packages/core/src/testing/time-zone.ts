declare const process: { env: Record<string, string | undefined> };

/**
 * Runs `run` with the process in the time zone `zone` (an IANA name), then puts the variable back
 *: the local time of the creator's machine is a test input, never the CI's.
 */
export function withTimeZone<T>(zone: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
