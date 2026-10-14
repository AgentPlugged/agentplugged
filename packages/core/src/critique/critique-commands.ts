import {
  CRITIQUE_EVENT_TYPES,
  type CritiqueInput,
  CritiqueInputSchema,
  type CritiqueStep,
  critiqueIdOf,
  critiquePathOf,
  critiqueStepOf,
  ErrorCode,
  hypothesisIdOf,
  IDEA_VERSION,
  type ProjectionState,
} from "@agentplugged/protocol";
import { agentEventCommand, invalidInput } from "../agent-activity/agent-commands.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { AgentPluggedError } from "../errors.js";
import {
  type CritiqueRecord,
  correctionLines,
  critiqueById,
  critiqueOfDocument,
  critiqueStack,
  hypothesesOf,
  hypothesisById,
  keptObjections,
  openStack,
  validateClose,
  validateCritiqueReport,
  validateProposal,
  validateSettle,
  validateShow,
  versionsOf,
  wasOffered,
} from "./critique-rules.js";

type State = ProjectionState["state"];

/** The document as the working copy holds it, with the ids of its version. */
interface Prepared {
  readonly text: string | undefined;
  readonly versions: readonly string[];
}

function invalid(step: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "critique",
    field: step,
    reason: `critique: ${step}: ${reason}`,
  });
}

/** What is wrong with a call, as codes; empty when it is whole and fits the state. */
function problemsOf(input: CritiqueInput, state: State, prepared: Prepared | undefined): string[] {
  switch (critiqueStepOf(input)) {
    case "report":
      return validateCritiqueReport(
        input,
        prepared?.text,
        input.kind === undefined
          ? undefined
          : critiqueOfDocument(state, critiquePathOf(input.kind)),
      );
    case "show":
      return validateShow(input, critiqueById(state, input.item));
    case "propose":
      return validateProposal(
        input,
        prepared?.text,
        input.kind !== undefined &&
          wasOffered(state, critiquePathOf(input.kind), prepared?.versions ?? []),
      );
    case "settle":
      return validateSettle(
        input,
        critiqueById(state, input.item),
        Object.keys(hypothesesOf(state)).length,
      );
    default:
      return validateClose(input, hypothesisById(state, input.item));
  }
}

/** The document a call is about, as the working copy holds it. */
async function documentOf(context: CommandContext, input: CritiqueInput): Promise<Prepared> {
  if (input.kind === undefined) return { text: undefined, versions: [] };
  // The idea is no file: one version, under one mark.
  if (input.kind === "idea") return { text: undefined, versions: [IDEA_VERSION] };
  const path = critiquePathOf(input.kind);
  const text = (await context.files.exists(path))
    ? await context.files.readText(path).catch(() => undefined)
    : undefined;
  return { text, versions: text === undefined ? [] : versionsOf(text) };
}

const recordCritique = agentEventCommand<typeof CritiqueInputSchema, Prepared>({
  name: "critique",
  description:
    "Record a critique, an offer, the creator's gestures or the closing of a hypothesis.",
  inputSchema: CritiqueInputSchema,
  prepare: (input, context) => documentOf(context, input),
  events: (input, _state, prepared) => {
    const document = critiquePathOf(input.kind ?? "prd");
    const versions = [...(prepared?.versions ?? [])];
    const closing = input.items?.[0];
    switch (critiqueStepOf(input)) {
      case "report":
        return {
          events: [
            {
              type: CRITIQUE_EVENT_TYPES.reported,
              payload: {
                document,
                versions,
                method: input.lenses?.[0],
                ...(input.lenses?.[1] === undefined ? {} : { blend: input.lenses[1] }),
                reason: input.summary,
                objections: keptObjections(input),
              },
            },
          ],
        };
      case "propose":
        return {
          events: [{ type: CRITIQUE_EVENT_TYPES.proposed, payload: { document, versions } }],
        };
      case "settle":
        return {
          events: [
            {
              type: CRITIQUE_EVENT_TYPES.settled,
              payload: { critique: input.item, decisions: input.items, quote: input.quote },
            },
          ],
        };
      default:
        return {
          events: [
            {
              type: CRITIQUE_EVENT_TYPES.closed,
              payload: {
                hypothesis: input.item,
                outcome: closing?.gesture,
                reason: closing?.reason,
                quote: input.quote,
              },
            },
          ],
        };
    }
  },
  check: (input, state, { prepared }) => {
    const problems = problemsOf(input, state, prepared);
    if (problems.length === 0) return undefined;
    return invalid(
      critiqueStepOf(input),
      `not whole (${problems.length}): ${problems.slice(0, 20).join(", ")}`,
    );
  },
});

/** What `review.critique` answers, by step; only what the next gesture needs. */
export interface CritiqueResult {
  /** Report: the critique's id, the number of objections and the stack the creator reads. */
  readonly critique?: string;
  readonly objections?: number;
  readonly stack?: readonly string[];
  /** Settle: the gestures counted, the hypotheses kept, who corrects the document (and what), what is left. */
  readonly settled?: Readonly<Record<string, number>>;
  readonly hypotheses?: readonly string[];
  readonly fix?: { readonly owner: string; readonly proposals: readonly string[] };
  readonly left?: number;
  /** Propose: the document whose critique was offered. */
  readonly offered?: string;
  /** Close: the hypothesis, how it ended, how many stay open. */
  readonly hypothesis?: string;
  readonly outcome?: string;
  readonly open?: number;
}

/** The owner of a document, from its header: the agent that corrects it. */
async function ownerOf(context: CommandContext, path: string): Promise<string> {
  const text = (await context.files.exists(path))
    ? await context.files.readText(path).catch(() => undefined)
    : undefined;
  const owner = text === undefined ? undefined : parseDocumentFile(path, text).header?.owner;
  return typeof owner === "string" ? owner : "creator";
}

/** The author who corrects the document, and the proposals of the objections kept for correction. */
async function correctionOf(
  context: CommandContext,
  critique: CritiqueRecord,
  numbers: readonly number[],
): Promise<{ owner: string; proposals: string[] }> {
  return {
    owner: await ownerOf(context, critique.document),
    proposals: correctionLines(critique, numbers),
  };
}

async function resultOf(
  context: CommandContext,
  input: CritiqueInput,
  step: CritiqueStep,
  eventId: string,
  state: State,
): Promise<CritiqueResult> {
  switch (step) {
    case "report": {
      const objections = keptObjections(input);
      return {
        critique: critiqueIdOf(eventId),
        objections: objections.length,
        stack: critiqueStack(objections),
      };
    }
    case "settle": {
      const critique = critiqueById(state, input.item);
      const decisions = input.items ?? [];
      const numbers = (gesture: string) =>
        decisions.flatMap((d) => (d.gesture === gesture && d.n !== undefined ? [d.n] : []));
      const fixed = numbers("fix");
      return {
        settled: {
          fix: fixed.length,
          hypothesis: numbers("hypothesis").length,
          discard: numbers("discard").length,
        },
        hypotheses: numbers("hypothesis").map((n) => hypothesisIdOf(input.item ?? "", n)),
        ...(fixed.length === 0 || critique === undefined
          ? {}
          : { fix: await correctionOf(context, critique, fixed) }),
        left: critique?.objections.filter((objection) => objection.status === "open").length ?? 0,
      };
    }
    case "show": {
      const critique = critiqueById(state, input.item);
      if (critique === undefined) return {};
      const kept = critique.objections.filter((o) => o.status === "fix").map((o) => o.n);
      return {
        critique: critique.id,
        stack: openStack(critique),
        ...(kept.length === 0 ? {} : { fix: await correctionOf(context, critique, kept) }),
        left: critique.objections.filter((objection) => objection.status === "open").length,
      };
    }
    case "close":
      return {
        hypothesis: input.item ?? "",
        outcome: input.items?.[0]?.gesture ?? "",
        open: Object.keys(hypothesesOf(state)).length,
      };
    default:
      return { offered: critiquePathOf(input.kind ?? "prd") };
  }
}

/**
 * `review.critique`: the critique of a deliverable, in four calls of one action,
 * told apart by what the call holds (`critiqueStepOf`). A report records the result of a method
 * applied to a document (the engine refuses one that is not whole with the list of what is
 * missing, and checks the passages against the document) and answers with the short stack the
 * creator reads; a proposal records that the critique of this version of a document was offered;
 * a settling records the creator's gestures on the objections (correct the document, keep as a
 * hypothesis, drop with a reason); a closing records what the creator decides of a hypothesis.
 * Nothing here rewrites a document: the author does, on the creator's gesture.
 */
export const critiqueCommand = defineCommand<CritiqueResult>({
  name: "critique",
  audience: "agent",
  description:
    "Critique a deliverable (skill critique-deliverable) or test an idea (skill test-idea); four calls, told apart by what they hold. Report: `kind` (brief, prd, ux, architecture, spec, prfaq: the document of .agentplugged/docs/; or idea: tested before any document, its passages are free labels), `lenses` (the method, or two to blend: the identifiers of references/choose.md, with personas and reconcile alone), `summary` (why this method, one line) and `findings`, the objections, each with `severity`, `claim` (one line, the hypothesis it would become), `passage` (a heading of the document or an identifier EF-n, ENF-n, AD-n that it holds), `argument`, and unless minor `proposal` and `proof` (what would prove or refute it). The engine refuses a report that is not whole with the list of what is missing, and answers `critique` (K-…) and `stack`: the objections to show the creator, the graver first, one line each. Settle (`item` the critique K-…): the creator's gesture on each objection they answered, `items` (`n`, `gesture`: fix to correct the document, hypothesis to follow it until its proof, discard with their `reason`) and their words in `quote`; answers `fix`, the author (`owner`) who corrects the document and the `proposals` to hand them, and `hypotheses` (H-…). Close (`item` the hypothesis H-…): `items` with one entry (`gesture`: proved, refuted, dropped or still_open, and `reason`) and `quote`. Show (`item` the critique K-… alone): what is left to sort, `stack`, and the corrections kept (`fix`). Propose (`kind` alone): once Noah offered the critique of that version of the document (state.next `critique`); once per version (the idea: once). Never settle or close without the creator's own words.",
  inputSchema: CritiqueInputSchema,
  async run(context, input) {
    const parsed = CritiqueInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("critique", parsed.error));
    const step = critiqueStepOf(parsed.data);
    // Seeing what is left of a critique writes nothing.
    if (step === "show") {
      const state = await currentState(context);
      const problems = problemsOf(parsed.data, state, undefined);
      if (problems.length > 0)
        return fail(invalid(step, `not whole (${problems.length}): ${problems.join(", ")}`));
      return ok(await resultOf(context, parsed.data, step, "", state));
    }
    const written = await recordCritique.run(context, input);
    if (!written.ok) return fail(written.error);
    const state = await currentState(context);
    return ok(await resultOf(context, parsed.data, step, written.value.id, state));
  },
});

/** The agents' commands of the critique, exposed as an MCP action after the others. */
export const critiqueAgentCommands = [critiqueCommand] as const;
