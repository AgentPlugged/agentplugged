import type { CommandContext } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { AgentPluggedError } from "../errors.js";
import { loadMethodConfig } from "../init/method-config.js";
import { isSkipped } from "../journey/journey-rules.js";
import type { NextStep } from "../next/next.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { needsUxOf, readCopy } from "./readiness-read.js";
import { analyse, countsOf, gateOf, gatePassed } from "./readiness-rules.js";

/**
 * What `next` adds for the readiness gate, when there is something to say. `check`:
 * no reading holds for the documents as they are (`why`: `none` or `stale`): Izzy runs the skill
 * `check-readiness` before the stories are cut (`stage: breakdown`) or before the first one
 * (`stage: build`); the creator may skip it (`step_skip` `readiness`). `blocked`: the verdict is
 * blocking and the creator did not go on. `reserves`: the gate is passed with findings left to
 * settle, `open` of them.
 */
export interface ReadinessNext {
  readonly readiness?: {
    readonly gate: "check" | "blocked" | "reserves";
    readonly stage: "breakdown" | "build";
    readonly why?: "none" | "stale";
    readonly open?: number;
  };
}

/** The steps where the gate stands: before the stories are cut, and before the first is built. */
const GATE_STEPS: ReadonlySet<string> = new Set(["breakdown", "sprint_planning", "build"]);

/** Reads the documents only when the gate can stand here; writes nothing. */
export async function readinessNext(
  context: CommandContext,
  step: NextStep,
): Promise<ReadinessNext> {
  if (!GATE_STEPS.has(step.step)) return {};
  const state = await currentState(context);
  if (isSkipped(state, "readiness")) return {};
  const stories = (state.stories ?? {}) as Record<string, StoryState>;
  if (Object.values(stories).some((story) => story.started !== undefined)) return {};
  const loaded = await loadMethodConfig(context.files);
  if (loaded instanceof AgentPluggedError) return {};
  const copy = await readCopy(context, needsUxOf(loaded.config));
  const hasPlan = copy.documents.some((d) => d.kind?.value === "prd" || d.kind?.value === "spec");
  if (!hasPlan) return {};
  const gate = gateOf(analyse(copy, state, (context.now ?? Date.now)()), state);
  const stage = gate.analysis.inventory.stage;
  // While the stories are being cut and validated, the gate waits for the cutting to be done.
  if (step.step === "breakdown" && stage === "build") return {};
  if (gate.judged !== "current") {
    return { readiness: { gate: "check", stage, why: gate.judged === "stale" ? "stale" : "none" } };
  }
  if (!gatePassed(gate)) {
    return { readiness: { gate: "blocked", stage, open: countsOf(gate.open).blocking } };
  }
  const left = gate.open.filter((f) => f.severity !== "minor").length;
  return left > 0 ? { readiness: { gate: "reserves", stage, open: left } } : {};
}
