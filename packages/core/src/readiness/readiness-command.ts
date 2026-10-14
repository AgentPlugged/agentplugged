import {
  CHECKPOINT_EVENT_TYPES,
  ErrorCode,
  READINESS_EVENT_TYPES,
  READINESS_FIX_FIRST,
  READINESS_GO_ON,
  type ReadinessStep,
  type ReadyInput,
  ReadyInputSchema,
  readinessIdOf,
  readinessStepOf,
} from "@agentplugged/protocol";
import { agentEventCommand, invalidInput } from "../agent-activity/agent-commands.js";
import { checkpointPayload, truncate } from "../checkpoints/checkpoint-rules.js";
import { defineCommand, fail, ok } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { AgentPluggedError } from "../errors.js";
import { loadMethodConfig } from "../init/method-config.js";
import { needsUxOf, readCopy } from "./readiness-read.js";
import {
  analyse,
  countsOf,
  fixesOf,
  type Gate,
  gateOf,
  ownerOfFinding,
  type ReadyCopy,
  stackOf,
  validateReadyReport,
  validateSettle,
  verdictOf,
  waivedKeysOf,
} from "./readiness-rules.js";

type State = Readonly<Record<string, unknown>>;

function invalid(step: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "ready",
    field: step,
    reason: `ready: ${step}: ${reason}`,
  });
}

/** What the answers of `review.ready` hold, by step; only what the next gesture needs. */
export interface ReadyResult {
  readonly stage: string;
  readonly track: string;
  /** `none`, `stale` or `current`: whether the agent's reading holds for these documents. */
  readonly judged: string;
  readonly verdict: string;
  readonly open: { blocking: number; should_fix: number; minor: number };
  readonly accepted?: number;
  /** The findings left, the graver first (`J<n>` are the agent's), and how many more. */
  readonly stack: readonly string[];
  readonly more?: number;
  /** Check: what the gate reads. */
  readonly documents?: readonly string[];
  readonly epics?: number;
  readonly stories?: number;
  readonly ids?: Readonly<Record<string, number>>;
  /** Report: the report's id and the decision a blocking verdict opened. */
  readonly report?: string;
  readonly decision?: boolean;
  /** Settle: the gestures counted, and who corrects what. */
  readonly settled?: { fix: number; accept: number };
  readonly fix?: readonly { owner: string; lines: readonly string[] }[];
}

function gateAt(copy: ReadyCopy, state: State, now: number): Gate {
  return gateOf(analyse(copy, state, now), state);
}

function resultOf(gate: Gate): ReadyResult {
  const { lines, more } = stackOf(gate.open);
  return {
    stage: gate.analysis.inventory.stage,
    track: gate.analysis.inventory.track,
    judged: gate.judged,
    verdict: gate.verdict,
    open: countsOf(gate.open),
    ...(gate.accepted > 0 ? { accepted: gate.accepted } : {}),
    stack: lines,
    ...(more > 0 ? { more } : {}),
  };
}

interface Prepared {
  readonly copy: ReadyCopy;
}

function problemsOf(
  input: ReadyInput,
  step: ReadinessStep,
  state: State,
  prepared: Prepared | undefined,
  now: number,
): string[] {
  if (prepared === undefined) return ["documents_unreadable"];
  const gate = gateAt(prepared.copy, state, now);
  if (step === "report") {
    return validateReadyReport(input, prepared.copy, gate.analysis.inventory.track);
  }
  if (step === "settle") return validateSettle(input, gate);
  return [];
}

/** The decision a blocking verdict opens: correct first, or go on all the same. */
function decisionPayload(open: Gate["open"]) {
  const blocking = open.filter((f) => f.severity === "blocking");
  const lines = stackOf(blocking)
    .lines.map((line) => `- ${line}`)
    .join("\n");
  return checkpointPayload({
    type: "decision",
    risk: "medium",
    title: truncate(`Readiness gate: ${blocking.length} blocking finding(s)`, 120),
    summary: truncate(
      `The plan is not ready to build as it stands:\n${lines}\nCorrect the documents first, or go on all the same: the blocking findings are then accepted as they are, on your word.`,
      2000,
    ),
    options: [
      {
        id: READINESS_FIX_FIRST,
        label: "Correct the documents first",
        consequence:
          "The authors of the documents correct what is blocking; the gate is run again on the new versions before the stories are cut or built.",
      },
      {
        id: READINESS_GO_ON,
        label: "Go on all the same",
        consequence:
          "The blocking findings stay as they are, on your word: the stories are cut and built on the documents as they stand, and the developers will meet the gaps.",
      },
    ],
    recommendation: READINESS_FIX_FIRST,
    blocks: [],
  });
}

const recordReady = agentEventCommand<typeof ReadyInputSchema, Prepared>({
  name: "ready",
  description:
    "Record a judged report of the readiness gate, or the creator's gestures on its findings.",
  inputSchema: ReadyInputSchema,
  needsState: () => true,
  prepare: async (_input, context, _agents, config) => ({
    copy: await readCopy(context, needsUxOf(config)),
  }),
  events: (input, state, prepared, now) => {
    const step = readinessStepOf(input);
    if (step === "settle") {
      return {
        events: [
          {
            type: READINESS_EVENT_TYPES.settled,
            payload: {
              decisions: (input.items ?? []).map((item) => ({
                id: item.id,
                gesture: item.gesture,
                ...(item.reason === undefined ? {} : { reason: item.reason }),
              })),
              quote: input.quote ?? "",
            },
          },
        ],
      };
    }
    const copy = (prepared as Prepared).copy;
    const analysis = analyse(copy, state ?? {}, now);
    const findings = (input.findings ?? []).map((finding) => ({
      severity: finding.severity,
      kind: finding.kind,
      claim: finding.claim,
      passages: finding.passages,
      ...(finding.proposal === undefined ? {} : { proposal: finding.proposal }),
      owner: ownerOfFinding(copy, finding.passages),
    }));
    // The verdict: the engine's open findings (none the creator accepted or went on with) and the
    // ones just judged (a new report starts the judged keys over).
    const accepted =
      (state?.readiness as { accepted?: Record<string, unknown> } | undefined)?.accepted ?? {};
    const waived = waivedKeysOf(state ?? {});
    const left = analysis.findings.filter(
      (f) => !Object.hasOwn(accepted, f.key) && !waived.has(f.key),
    );
    const open = [
      ...left,
      ...findings.map((f, index) => ({
        key: `J${index + 1}`,
        severity: f.severity,
        origin: "agent" as const,
        text: f.claim,
        owner: f.owner,
        fix: f.proposal ?? "",
      })),
    ];
    const verdict = verdictOf(open);
    // A decision of the last report that still waits is the one this report belongs to.
    const previous = (state?.readiness as { report?: { checkpoint?: string | null } } | undefined)
      ?.report?.checkpoint;
    const waiting =
      previous != null &&
      ((state?.checkpoints ?? {}) as Record<string, { status?: string }>)[previous]?.status ===
        "open"
        ? previous
        : undefined;
    const payload = {
      mark: analysis.mark,
      stage: analysis.inventory.stage,
      path: analysis.inventory.track,
      summary: input.summary ?? "",
      verdict,
      engine: countsOf(left),
      findings,
      waivable: [
        ...open.filter((f) => f.severity === "blocking").map((f) => f.key),
        ...analysis.findings.filter((f) => waived.has(f.key)).map((f) => f.key),
      ],
    };
    if (verdict !== "blocking") {
      // What the creator went on with stays waived: the report keeps the decision that waived it.
      const kept = waived.size > 0 && previous != null ? { checkpoint: previous } : {};
      return {
        events: [{ type: READINESS_EVENT_TYPES.reported, payload: { ...payload, ...kept } }],
      };
    }
    if (waiting !== undefined) {
      return {
        events: [
          { type: READINESS_EVENT_TYPES.reported, payload: { ...payload, checkpoint: waiting } },
        ],
        checkpoint: waiting,
      };
    }
    return {
      events: [
        { type: CHECKPOINT_EVENT_TYPES.opened, payload: { ...decisionPayload(open) } },
        { type: READINESS_EVENT_TYPES.reported, payload, checkpointField: "checkpoint" },
      ],
      own: 1,
    };
  },
  check: (input, state, { prepared, now }) => {
    const step = readinessStepOf(input);
    const problems = problemsOf(input, step, state, prepared, now);
    if (problems.length === 0) return undefined;
    return invalid(step, `not whole (${problems.length}): ${problems.slice(0, 20).join(", ")}`);
  },
});

/**
 * `review.ready`: the readiness gate before the stories are cut and before the first
 * one is built, in three calls of one action told apart by what they hold. Check reads the plan as
 * a whole and writes nothing: what the engine computes (documents present, validated and unchanged,
 * identifiers known, requirements, stories, journeys and decisions traced both ways) and what is
 * left to judge. Report records the agent's reading (contradictions between documents, decisions a
 * developer would have to invent), closed and verified against the documents; the engine gives the
 * verdict (ready, reserves, blocking) from both, and a blocking one opens a decision for the
 * creator. Settle records the creator's gesture on each finding: its author corrects the document,
 * or they accept it with a reason of their own. Nothing here rewrites a document.
 */
export const readyCommand = defineCommand<ReadyResult>({
  name: "ready",
  audience: "agent",
  description:
    "Readiness gate before cutting the stories and before the first one (skill check-readiness). Check (`agent` alone): reads and writes nothing; answers what the engine computed of the plan (documents present, validated, unchanged; identifiers; requirements, stories, journeys and decisions traced both ways) as `stack` (one line per finding, led by its key, the graver first), `open` counts, `judged` (none, stale, current: whether a reading holds for these documents) and the `documents` to read. Report: `summary` (what you read and your answer to: would a developer have to settle alone a point no document writes down? one line) and `findings` (possibly none), each `severity`, `kind` (conflict: two documents disagree; gap: a decision nothing records), `claim` (one line), `passages` (1 to 3 of `<document>: <heading or EF-n, ENF-n, PU-n, AD-n>`, the first is the document to correct; a conflict names two documents) and, unless minor, `proposal`. The engine refuses a report that is not whole with the list of what is missing, checks every passage against its document, answers `verdict` (ready, reserves, blocking) and the `stack`, and a blocking verdict opens a `decision` for the creator (`decision`: true). Settle: `items` (`id` the finding's key, `gesture` fix to have its author correct the document, or accept with the creator's own `reason`) and the creator's words in `quote`; answers `fix` (the `owner` and the lines to hand them) and the verdict again. Never settle without the creator's words; never rewrite a document.",
  inputSchema: ReadyInputSchema,
  async run(context, input) {
    const parsed = ReadyInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("ready", parsed.error));
    const step = readinessStepOf(parsed.data);
    const loaded = await loadMethodConfig(context.files);
    if (loaded instanceof AgentPluggedError) return fail(loaded);
    const needsUx = needsUxOf(loaded.config);
    const now = (context.now ?? Date.now)();
    if (step === "check") {
      const state = await currentState(context);
      const gate = gateAt(await readCopy(context, needsUx), state, now);
      const inventory = gate.analysis.inventory;
      return ok<ReadyResult>({
        ...resultOf(gate),
        documents: inventory.documents,
        epics: inventory.epics,
        stories: inventory.stories,
        ids: inventory.ids,
      });
    }
    const written = await recordReady.run(context, input);
    if (!written.ok) return fail(written.error);
    const state = await currentState(context);
    const gate = gateAt(await readCopy(context, needsUx), state, now);
    if (step === "report") {
      return ok<ReadyResult>({
        ...resultOf(gate),
        report: readinessIdOf(written.value.id),
        ...(gate.verdict === "blocking" && gate.report?.checkpoint != null
          ? { decision: true }
          : {}),
      });
    }
    const items = parsed.data.items ?? [];
    const kept = items.filter((item) => item.gesture === "fix").map((item) => item.id);
    // The findings kept for correction are still open: their authors correct the documents.
    const fix = fixesOf(gate.open, kept);
    return ok<ReadyResult>({
      ...resultOf(gate),
      settled: {
        fix: kept.length,
        accept: items.filter((item) => item.gesture === "accept").length,
      },
      ...(fix.length === 0 ? {} : { fix }),
    });
  },
});

/** The agents' commands of the readiness gate, exposed as an MCP action after the others. */
export const readinessAgentCommands = [readyCommand] as const;
