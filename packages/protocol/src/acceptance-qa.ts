import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { plainLine } from "./agent-content.js";
import { CriterionNumberSchema } from "./criteria.js";
import { AgentIdSchema } from "./method-config.js";
import { ProofRunSchema } from "./requirements.js";
import { CommitIdSchema } from "./story.js";

/**
 * The acceptance QA of a story in a browser. Each criterion that can be seen through
 * the interface is played as a scenario, in the host's browser pilot or by the test command the
 * creator accepted under the name `browser-qa`; what was seen is kept as files (screenshots, a video) in a
 * local folder outside the journal. The agent's report is closed: it covers every criterion of the
 * story once (a scenario, or « outside the interface » with a reason), and the engine checks it.
 * The journal holds, for each criterion, the verdict, the path of each proof and its fingerprint;
 * a criterion with no proof file is never `passed`.
 */

/** Event type, at version 1, on the story's own stream. */
export const QA_EVENT_TYPES = { reported: "story.qa_reported" } as const;

/** The name of the accepted command that plays one criterion in a browser (`{criterion}` in its line). */
export const QA_COMMAND = "browser-qa";

/** The folder of the proofs, relative to the project, ignored by Git (the method's `.cache/`). */
export const QA_PROOF_DIR = ".agentplugged/.cache/qa";

export const QA_VERDICTS = ["passed", "failed", "blocked"] as const;
export type QaVerdict = (typeof QA_VERDICTS)[number];

export const QA_PROOF_KINDS = ["screenshot", "video"] as const;
export type QaProofKind = (typeof QA_PROOF_KINDS)[number];

/** Who saw it: the engine, which played the accepted command, or the agent, who drove the host's pilot. */
export const QA_ORIGINS = ["engine", "reported"] as const;

/** The most proofs one criterion keeps, and the most the engine fingerprints (bytes) in one file. */
export const MAX_QA_PROOFS = 6;
export const MAX_QA_PROOF_BYTES = 64 * 1024 * 1024;

/** The kind of a proof from its file name, or null when it is neither an image nor a video. */
export function qaProofKind(path: string): QaProofKind | null {
  if (/\.(?:png|jpe?g|webp)$/i.test(path)) return "screenshot";
  if (/\.(?:webm|mp4)$/i.test(path)) return "video";
  return null;
}

/** `AC-18-5-2` as the file names carry it: lower case, every other character a dash. */
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * True when a proof path belongs to a criterion: it lies in the proofs folder and its name carries
 * the criterion's id (`AC-18-5-2` or `AC_18_5_2`, in any case), bounded so that criterion 2 does not
 * own the proofs of criterion 21.
 */
export function qaProofBelongs(path: string, id: string): boolean {
  if (!path.startsWith(`${QA_PROOF_DIR}/`)) return false;
  const rest = slug(path.slice(QA_PROOF_DIR.length + 1));
  return new RegExp(`(?:^|-)${slug(id)}(?![0-9])`).test(rest);
}

/** A path in the proofs folder: relative, with `/`, no `..`, an image or a video. */
export const QaPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .transform((path) => path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, ""))
  .refine((path) => path.startsWith(`${QA_PROOF_DIR}/`), {
    message: `expected a path under ${QA_PROOF_DIR}/`,
  })
  .refine((path) => !path.split("/").includes(".."), { message: "expected no .. segment" })
  .refine((path) => /^[A-Za-z0-9._/-]+$/.test(path), {
    message: "expected letters, digits, dot, dash, underscore and / only",
  })
  .refine((path) => qaProofKind(path) !== null, {
    message: "expected an image (png, jpg, webp) or a video (webm, mp4)",
  });

/** One scenario of the report: played by the engine (`run`), or reported with its verdict and proofs. */
const ScenarioSchema = z.strictObject({
  criterion: CriterionNumberSchema,
  /** The engine plays it with the accepted `qa` command and reads the verdict from the exit code. */
  run: z.literal(true).optional(),
  verdict: z.enum(QA_VERDICTS).optional(),
  proofs: z.array(QaPathSchema).max(MAX_QA_PROOFS).optional(),
  /** What the page really showed when it is not what the criterion says (failed), or why not played (blocked). */
  observed: plainLine(300).optional(),
});

/** A criterion nothing observable through the interface tells, with the reason. */
const OutsideSchema = z.strictObject({
  criterion: CriterionNumberSchema,
  reason: plainLine(200),
});

/** The closed report of an acceptance QA: every criterion of the story, once. */
export const QaCheckSchema = z.strictObject({
  scenarios: z.array(ScenarioSchema).max(60),
  outside: z.array(OutsideSchema).max(60).optional(),
});
export type QaCheck = z.infer<typeof QaCheckSchema>;

/** Input of `acceptance_qa`. */
export const AcceptanceQaInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  story: StoryIdSchema,
  check: QaCheckSchema,
});
export type AcceptanceQaInput = z.infer<typeof AcceptanceQaInputSchema>;

/** One proof as the journal keeps it: where, what, how big, and the SHA-256 of the file. */
export const QaProofSchema = z.strictObject({
  path: QaPathSchema,
  kind: z.enum(QA_PROOF_KINDS),
  bytes: z.int().min(1).max(MAX_QA_PROOF_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type QaProof = z.infer<typeof QaProofSchema>;

const ResultSchema = z
  .strictObject({
    criterion: CriterionNumberSchema,
    verdict: z.enum(QA_VERDICTS),
    origin: z.enum(QA_ORIGINS),
    proofs: z.array(QaProofSchema).max(MAX_QA_PROOFS),
    observed: plainLine(300).optional(),
    /** Engine: the run of the accepted command. */
    run: ProofRunSchema.optional(),
  })
  .refine((result) => (result.origin === "engine") === (result.run !== undefined), {
    message: "a run is the engine's, and only the engine's",
    path: ["run"],
  })
  // A criterion with no proof file is never « passed by QA ».
  .refine((result) => result.verdict !== "passed" || result.proofs.length > 0, {
    message: "a passed scenario keeps at least one proof",
    path: ["proofs"],
  })
  .refine((result) => result.verdict === "passed" || result.observed !== undefined, {
    message: "say what was observed, or why the scenario could not be played",
    path: ["observed"],
  });

/** `payload` of `story.qa_reported` (its story is the envelope's). */
export const QaReportedPayloadSchema = z
  .strictObject({
    commit: CommitIdSchema.optional(),
    clean: z.boolean().optional(),
    results: z.array(ResultSchema).max(60),
    outside: z.array(OutsideSchema).max(60),
  })
  .refine(
    (payload) => {
      const seen = new Set<number>();
      for (const entry of [...payload.results, ...payload.outside]) {
        if (seen.has(entry.criterion)) return false;
        seen.add(entry.criterion);
      }
      return seen.size > 0;
    },
    { message: "each criterion once, at least one", path: ["results"] },
  );
export type QaReportedPayload = z.infer<typeof QaReportedPayloadSchema>;
