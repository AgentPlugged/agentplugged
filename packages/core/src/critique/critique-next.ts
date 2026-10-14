import { critiquePathOf } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { readDocumentFiles } from "../docs/docs-command.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { storiesOf } from "../docs/story-rules.js";
import type { NextStep } from "../next/next.js";
import { isDocumentReview } from "../phases/phases.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { readRegistry } from "../requirements/requirement-files.js";
import {
  type CritiqueOffer,
  type CritiqueRisk,
  critiquable,
  deliveredAfter,
  documentRisk,
  hypothesesDue,
  hypothesesOf,
  ideaOffer,
  normalizedPath,
  critiqueOffer as offerOf,
  wasOffered,
} from "./critique-rules.js";

/** What `next` adds for the critique of a deliverable, when there is something to say. */
export interface CritiqueNext {
  /** Offer, once per version, the critique of the document the creator is about to validate. */
  readonly critique?: CritiqueOffer;
  /** The open hypotheses an evidence arrived for, one line each, and how many more. */
  readonly hypotheses_due?: readonly string[];
  readonly hypotheses_due_more?: number;
}

/** The stories of the working copy that cite each identifier, from their files. */
async function storyCitations(context: CommandContext): Promise<Map<string, string[]>> {
  const documents = (await readDocumentFiles(context.files, true)).map((file) =>
    parseDocumentFile(file.path, file.text),
  );
  const cited = new Map<string, string[]>();
  for (const [story, document] of storiesOf(documents)) {
    for (const requirement of document.story?.requirements ?? []) {
      const list = cited.get(requirement.value) ?? [];
      if (!list.includes(story)) list.push(story);
      cited.set(requirement.value, list);
    }
  }
  return cited;
}

/** The risk of each structuring document a point cites whose version was not offered yet. */
async function risksOf(
  context: CommandContext,
  state: Readonly<Record<string, unknown>>,
  checkpoint: CheckpointState,
): Promise<Map<string, CritiqueRisk | undefined>> {
  const risks = new Map<string, CritiqueRisk | undefined>();
  let security: boolean | undefined;
  for (const cited of checkpoint.documents) {
    const path = normalizedPath(cited.path);
    if (!critiquable(path) || wasOffered(state, path, [cited.blob_sha])) continue;
    if (!(await context.files.exists(path))) continue;
    const text = await context.files.readText(path).catch(() => undefined);
    if (text === undefined) continue;
    if (security === undefined && (path.endsWith("/prd.md") || path.endsWith("/spec.md"))) {
      security = (await readRegistry(context.files)).some((entry) => entry.pillar === "security");
    }
    risks.set(path, documentRisk(path, text, security === true));
  }
  return risks;
}

/**
 * True while the brief is to be written (the framing step) or waits for the creator's validation,
 * and the creator did not write the press release already.
 */
async function briefInProgress(
  context: CommandContext,
  step: NextStep,
  checkpoints: Readonly<Record<string, CheckpointState>>,
): Promise<boolean> {
  const point =
    step.checkpoint !== null && Object.hasOwn(checkpoints, step.checkpoint)
      ? checkpoints[step.checkpoint]
      : undefined;
  // The brief is validated by its own `document` point or, in framing, by the end of the phase.
  const validating = point?.documents.some(
    (cited) => normalizedPath(cited.path) === critiquePathOf("brief"),
  );
  if (step.step !== "framing" && validating !== true) return false;
  return !(await context.files.exists(critiquePathOf("prfaq")));
}

/**
 * What `next` says of the critique: the offer when the step is the creator's validation of a
 * structuring document at risk whose version was not offered (never twice for the same version),
 * and the hypotheses brought back by an evidence. Reads the journal and, only when needed, the
 * document and the register; writes nothing.
 */
export async function critiqueNext(context: CommandContext, step: NextStep): Promise<CritiqueNext> {
  const state = await currentState(context);
  const out: { -readonly [K in keyof CritiqueNext]: CritiqueNext[K] } = {};
  const checkpoints = (state.checkpoints ?? {}) as Record<string, CheckpointState>;
  const waiting =
    step.step === "validation" &&
    step.checkpoint !== null &&
    Object.hasOwn(checkpoints, step.checkpoint)
      ? checkpoints[step.checkpoint]
      : undefined;
  if (waiting !== undefined && isDocumentReview(waiting)) {
    const offer = offerOf(state, waiting.documents, await risksOf(context, state, waiting));
    if (offer !== undefined) out.critique = offer;
  }
  // On a new product, before the brief or while it waits for the creator, the test of
  // the idea and the press release are offered, once. A document's offer, if any, comes first.
  if (out.critique === undefined && (await briefInProgress(context, step, checkpoints))) {
    const offer = ideaOffer(state);
    if (offer !== undefined) out.critique = offer;
  }
  const open = Object.values(hypothesesOf(state));
  if (open.length > 0) {
    // The stories' files are read only when a story was delivered since a hypothesis was looked at.
    const named = open.filter((hypothesis) => hypothesis.refs.length > 0);
    const from = named.map((hypothesis) => hypothesis.seen ?? hypothesis.since).sort()[0];
    const cites =
      from !== undefined && deliveredAfter(state, from)
        ? await storyCitations(context)
        : new Map<string, string[]>();
    const { due, more } = hypothesesDue(state, cites);
    if (due.length > 0) {
      out.hypotheses_due = due.map((entry) => `${entry.id} · ${entry.claim} — ${entry.why}`);
      if (more > 0) out.hypotheses_due_more = more;
    }
  }
  return out;
}
