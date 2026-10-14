import {
  RESEARCH_EFFORTS,
  RESEARCH_FOLLOW_UP_AGENTS,
  type ResearchEffort,
} from "@agentplugged/protocol";

/**
 * The plan of a research, announced before any sub-agent starts: the three efforts
 * (quick, standard, deep), what each sends out, and an estimate of the tokens, computed here so that
 * it is the same every time and the creator chooses knowing the price. The figures are estimates of
 * the engine, not measures: what a sub-agent reads of the web is the part that varies.
 */

/** What every sub-agent receives before it reads anything: its sub-question and the rules. */
const BRIEF_TOKENS = 400;
/** A page read by a sub-agent, as it enters its context. */
const READ_TOKENS = 3_000;
/** A finding a sub-agent returns (about 280 characters). */
const FINDING_TOKENS = 75;
/** The skill, the type's lines, the format, the template, the page written and the answer. */
const PARENT_TOKENS = 2_900;
/** What the lead reads of a finding and writes of it as a claim. */
const PARENT_PER_FINDING_TOKENS = 150;
/** A report imported: one sub-agent extracts at most this many claims from it. */
const EXTRACTED_CLAIMS = 25;
/** Pages read to give the claims a conclusion rests on their second source. */
const CHECK_READS = 3;
/** A report of this size (characters) when the creator does not say. */
export const REPORT_CHARS_DEFAULT = 40_000;
const CHARS_PER_TOKEN = 4;
/** The range around the expected figure: web pages vary in size and depth. */
const LOW = 0.6;
const HIGH = 1.6;

export interface PlannedEffort {
  readonly effort: ResearchEffort;
  readonly agents: number;
  readonly findings: number;
  readonly rounds: number;
  readonly tokens: { readonly low: number; readonly expected: number; readonly high: number };
}

export interface ResearchPlanned {
  readonly research: "plan";
  readonly mode: "run" | "import";
  /** The sub-questions asked, for a run. */
  readonly questions?: number;
  /** The size of the report, for an import. */
  readonly reportChars?: number;
  readonly efforts: readonly PlannedEffort[];
}

const hundreds = (value: number): number => Math.round(value / 100) * 100;

function rangeOf(expected: number): PlannedEffort["tokens"] {
  return {
    low: hundreds(expected * LOW),
    expected: hundreds(expected),
    high: hundreds(expected * HIGH),
  };
}

/** The tokens of one effort for a number of sub-questions: the sub-agents, a second round if any, the lead. */
export function runEstimate(
  effort: ResearchEffort,
  questions: number,
): { agents: number; tokens: number } {
  const set = RESEARCH_EFFORTS[effort];
  const agents = Math.max(1, Math.min(questions, set.agents));
  const first = agents * (BRIEF_TOKENS + set.findings * (READ_TOKENS + FINDING_TOKENS));
  let findings = agents * set.findings;
  let second = 0;
  if (set.rounds > 1) {
    // The follow-up round chases the contradictions and leads of the first, with fewer sub-agents
    // and half the reads.
    const followAgents = Math.min(agents, RESEARCH_FOLLOW_UP_AGENTS);
    const half = Math.floor(set.findings / 2);
    second = followAgents * (BRIEF_TOKENS + half * (READ_TOKENS + FINDING_TOKENS));
    findings += followAgents * half;
  }
  return { agents, tokens: PARENT_TOKENS + findings * PARENT_PER_FINDING_TOKENS + first + second };
}

/** The tokens of importing a report: one extraction sub-agent that reads it, the lead, the second sources of the key claims. */
export function importEstimate(reportChars: number): number {
  return (
    PARENT_TOKENS +
    EXTRACTED_CLAIMS * PARENT_PER_FINDING_TOKENS +
    BRIEF_TOKENS +
    Math.ceil(reportChars / CHARS_PER_TOKEN) +
    EXTRACTED_CLAIMS * FINDING_TOKENS +
    CHECK_READS * READ_TOKENS
  );
}

/** The plan of a run for `questions` sub-questions: the three efforts side by side. */
export function planRun(questions: number): ResearchPlanned {
  const efforts = (Object.keys(RESEARCH_EFFORTS) as ResearchEffort[]).map((effort) => {
    const { agents, tokens } = runEstimate(effort, questions);
    const set = RESEARCH_EFFORTS[effort];
    return { effort, agents, findings: set.findings, rounds: set.rounds, tokens: rangeOf(tokens) };
  });
  return { research: "plan", mode: "run", questions, efforts };
}

/** The plan of importing a report of `reportChars` characters: one sub-agent, no effort to choose. */
export function planImport(reportChars: number): ResearchPlanned {
  return {
    research: "plan",
    mode: "import",
    reportChars,
    efforts: [
      {
        effort: "standard",
        agents: 1,
        findings: EXTRACTED_CLAIMS,
        rounds: 1,
        tokens: rangeOf(importEstimate(reportChars)),
      },
    ],
  };
}

const thousands = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/** The lines `docs research questions=<n>` or `report=<chars>` prints. */
export function planLines(plan: ResearchPlanned): string[] {
  const lines = plan.efforts.map((entry) => {
    const { low, expected, high } = entry.tokens;
    const range = `~${thousands(expected)} tokens (${thousands(low)} to ${thousands(high)})`;
    return plan.mode === "import"
      ? `research: plan import | 1 sub-agent extracts up to ${entry.findings} claims from ${plan.reportChars} characters | ${range}`
      : `research: plan ${entry.effort} | ${entry.agents} sub-agent(s), up to ${entry.findings} findings each, ${entry.rounds} round(s) | ${range}`;
  });
  return [
    ...lines,
    "research: plan | estimates, not costs: say these figures to the creator before any sub-agent starts, the web reads included",
  ];
}

const WORD = /^(questions|report)=([1-9]\d{0,6})$/;

/** The arguments of the plan form of `docs research`: `questions=<n>` (a run) or `report=<chars>` (an import). */
export function parsePlanWords(
  words: readonly string[],
): { plan: ResearchPlanned } | { invalid: string } | undefined {
  if (!words.some((word) => /^(questions|report)=/.test(word))) return undefined;
  const given = words.map((word) => WORD.exec(word));
  if (words.length !== 1 || given[0] === null || given[0] === undefined) {
    return { invalid: "docs research questions=<1 to 12> | report=<characters>" };
  }
  const [, name, value] = given[0];
  const number = Number(value);
  if (name === "questions") {
    return number > 12
      ? { invalid: "docs research questions=<1 to 12>" }
      : { plan: planRun(number) };
  }
  return { plan: planImport(number) };
}
