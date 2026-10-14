import type {
  PhaseId,
  UsageOrigin,
  UsageSkillAttribution,
  UsageStepAttribution,
} from "@agentplugged/protocol";
import { DEVELOPER_AGENTS } from "../profile/catalog.js";
import type { SkillCall } from "./trace-readers.js";

/**
 * To which step and to which skill a slice of consumption belongs, as pure rules.
 * Two origins, said on every attribution and never mixed up: `tool` (the AI tool's own trace
 * names the skill it ran) and `interval` (the engine deduced it from an interval the journal
 * bounds). What neither says is not attributed: no name is guessed, and the consumption stays
 * counted, as unattributed.
 */

/** A skill that ran from `from` (included) to `to` (excluded), milliseconds. */
export interface SkillSpan {
  readonly from: number;
  readonly to: number;
  readonly skill: string;
  readonly origin: UsageOrigin;
  /** An `interval` span: the agent that reported it (a span is only applied to that agent's work). */
  readonly agent?: string;
}

/**
 * The skills the tool says it ran (Claude Code's `Skill` call): each runs until the next skill is
 * called or the creator types a message, whichever comes first, else to the end of the session.
 * The name is the tool's; the end is deduced, which is why a part cut at a skill's end stays
 * attributed to it only by this rule.
 */
export function toolSkillSpans(
  calls: readonly SkillCall[],
  prompts: readonly number[],
): SkillSpan[] {
  const sorted = [...calls].sort((a, b) => a.at - b.at);
  return sorted.map((call, index) => {
    const next = sorted.slice(index + 1).find((other) => other.at > call.at)?.at;
    const typed = prompts
      .filter((time) => time > call.at)
      .reduce((a, b) => Math.min(a, b), Infinity);
    return {
      from: call.at,
      to: Math.min(next ?? Number.POSITIVE_INFINITY, typed),
      skill: call.skill,
      origin: "tool" as const,
    };
  });
}

/** The span covering `time` among those of `agent` (spans of no agent apply to all), the last started first. */
function covering(
  spans: readonly SkillSpan[],
  time: number,
  agent: string | undefined,
): SkillSpan | undefined {
  let best: SkillSpan | undefined;
  for (const span of spans) {
    if (span.agent !== undefined && span.agent !== agent) continue;
    if (time >= span.from && time < span.to && (best === undefined || span.from >= best.from)) {
      best = span;
    }
  }
  return best;
}

/**
 * The skill at `time`: the one the journal bounds (begun and ended by the agent that ran it) wins
 * over the one the tool named, whose end is only deduced; that one wins over `fallback` (the skill
 * Noah handed the conversation to).
 */
export function skillAt(
  time: number,
  spans: { readonly tool: readonly SkillSpan[]; readonly journal: readonly SkillSpan[] },
  agent: string,
  fallback?: UsageSkillAttribution,
): UsageSkillAttribution | undefined {
  const named = covering(spans.journal, time, agent) ?? covering(spans.tool, time, undefined);
  if (named !== undefined) return { name: named.skill, origin: named.origin };
  return fallback;
}

/** The instants inside (`from`, `to`) where a skill starts or ends: where a slice is cut. */
export function skillBoundaries(
  spans: { readonly tool: readonly SkillSpan[]; readonly journal: readonly SkillSpan[] },
  agent: string,
  from: number,
  to: number,
): number[] {
  const all = [...spans.tool, ...spans.journal.filter((span) => span.agent === agent)];
  const inside = new Set<number>();
  for (const span of all) {
    for (const time of [span.from, span.to]) {
      if (Number.isFinite(time) && time > from && time < to) inside.add(time);
    }
  }
  return [...inside].sort((a, b) => a - b);
}

/** The agents that review a story: its quality reviewer and the security reviewer. */
const REVIEW_AGENTS: readonly string[] = ["quentin", "chloe"];

/**
 * The step of a part, deduced from the journal: a story's developer builds it, its reviewers
 * review it, Omar delivers it, else the phase the creator's approvals say was current. Any other
 * agent on a story (Noah, a plug-in's) is not given a step it did not take.
 * The creator's conversation with Noah (coordination) is no step: unattributed.
 */
export function stepOf(input: {
  readonly agent: string;
  readonly phase: PhaseId | undefined;
  readonly story: string | undefined;
  readonly work: { readonly kind: string };
}): UsageStepAttribution | undefined {
  if (input.work.kind === "coordination") return undefined;
  if (input.story !== undefined) {
    if (DEVELOPER_AGENTS.includes(input.agent)) return { name: "build", origin: "interval" };
    if (input.agent === "omar") return { name: "delivery", origin: "interval" };
    if (REVIEW_AGENTS.includes(input.agent)) return { name: "review", origin: "interval" };
  }
  if (input.phase !== undefined) return { name: input.phase, origin: "interval" };
  return undefined;
}
