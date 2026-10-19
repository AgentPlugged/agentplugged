import { z } from "zod";

/**
 * Makes the schemas check values by plain interpretation, without compiling a checker at run time.
 *
 * By default the schema library probes whether the page may build code from text (`Function("")`)
 * and compiles faster checkers when it can. A page under a strict content policy (no `eval`) would
 * report that probe as a violation even though it falls back by itself. A page calls this once, before
 * it checks anything; the results are identical, only a little slower on large inputs.
 */
export function disableSchemaCodegen(): void {
  z.config({ jitless: true });
}
