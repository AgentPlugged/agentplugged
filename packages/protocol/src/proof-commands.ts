import { z } from "zod";
import { plainLine } from "./agent-content.js";
import { AgentIdSchema } from "./method-config.js";
import {
  PROOF_COMMAND_NAME_PATTERN,
  RegisteredRequirementIdSchema,
  RegisteredRequirementInputSchema,
} from "./requirement-id.js";

/**
 * The commands a project declares to prove its requirements. The project writes them
 * in `.agentplugged/proofs.yaml` (an agent may propose a change, never accept it); the creator
 * accepts the exact lines once, at the chat (`request_creator_action`, kind `proof_commands`); the
 * engine then runs an accepted command itself (`run_proof_command`) and inscribes the result. An
 * accord is for the fingerprint of the command: its name, its line, its folder, its time limit and
 * the requirements it proves. Any change asks the creator again.
 */

/** The most commands a project declares. */
export const MAX_PROOF_COMMANDS = 30;
/** The most commands one request asks the creator to accept (the whole text must stay readable). */
export const MAX_PROOF_COMMANDS_PER_REQUEST = 8;
/** The time limit without a setting, and the longest the project may set, in seconds. */
export const DEFAULT_PROOF_TIMEOUT_SECONDS = 300;
export const MAX_PROOF_TIMEOUT_SECONDS = 3600;
/** The longest command line. */
export const MAX_PROOF_LINE = 300;

/** What the creator may demand of the proofs at the release: any, or only those the engine ran or read. */
export const PROOF_REQUIREMENTS = ["engine", "any"] as const;
export type ProofRequirement = (typeof PROOF_REQUIREMENTS)[number];

export const ProofCommandNameSchema = z.string().trim().regex(PROOF_COMMAND_NAME_PATTERN, {
  message: "expected a name: lower-case letters, digits, - or _, starting with a letter (tests)",
});

/**
 * A folder inside the project, relative, with `/`: no absolute path, no drive, no `..`, no
 * backslash. `.` is the project's folder. Whether a link leads outside is checked by the adapter.
 */
function folderProblem(folder: string): string | undefined {
  if (/^(?:[/\\~]|[A-Za-z]:)/.test(folder)) return "expected a folder inside the project";
  if (folder.includes("\\")) return "expected / as separator";
  const segments = folder.replace(/\/$/, "").split("/");
  if (segments.some((segment, index) => segment === ".." || (segment === "" && index > 0))) {
    return "expected a folder inside the project, without .. nor empty parts";
  }
  return undefined;
}

export const ProofFolderSchema = plainLine(100).superRefine((folder, context) => {
  const problem = folderProblem(folder);
  if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
});

/** The folder as the engine uses it: `./` and a trailing `/` removed, `.` for the project's. */
export function normalizedFolder(folder: string | undefined): string {
  const cleaned = (folder ?? ".").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  return cleaned === "" ? "." : cleaned;
}

const ProvesSchema = z
  .array(RegisteredRequirementInputSchema)
  .max(10)
  .refine((ids) => new Set(ids).size === ids.length, { message: "requirements must differ" });

/** One command of `.agentplugged/proofs.yaml`. */
export const ProofCommandSchema = z.strictObject({
  name: ProofCommandNameSchema,
  /** The command line, as typed in a terminal: a program and its arguments. */
  run: plainLine(MAX_PROOF_LINE),
  /** The folder it runs in, inside the project (default: the project's). */
  cwd: ProofFolderSchema.optional(),
  /** Its time limit in seconds (default 300); the engine stops the command after it. */
  timeout: z.int().min(1).max(MAX_PROOF_TIMEOUT_SECONDS).optional(),
  /** The requirements (ENF-n, AD-n) a passing run proves; none for the tests of the criteria. */
  proves: ProvesSchema.optional(),
  /**
   * For a requirement with a numeric budget: the text that precedes the measured number on a line
   * of the output (`p95_ms=`). The engine reads the last such line and compares the number with the
   * budget. Without it a measure is decided by the exit code alone.
   */
  measured_after: plainLine(60).optional(),
});
export type ProofCommand = z.infer<typeof ProofCommandSchema>;

/** `.agentplugged/proofs.yaml`. */
export const ProofsFileSchema = z.strictObject({
  commands: z
    .array(ProofCommandSchema)
    .max(MAX_PROOF_COMMANDS)
    .refine(
      (commands) => new Set(commands.map((command) => command.name)).size === commands.length,
      {
        message: "command names must differ",
      },
    ),
});
export type ProofsFile = z.infer<typeof ProofsFileSchema>;

/** A command as the creator accepted it: everything the engine runs, nothing left to default. */
export const AcceptedProofCommandSchema = z.strictObject({
  name: ProofCommandNameSchema,
  /** The fingerprint the accord is for (see `proofFingerprint` in the engine). */
  fingerprint: z.string().regex(/^[0-9a-f]{24}$/),
  run: plainLine(MAX_PROOF_LINE),
  cwd: ProofFolderSchema,
  timeout: z.int().min(1).max(MAX_PROOF_TIMEOUT_SECONDS),
  proves: z.array(RegisteredRequirementIdSchema).max(10),
  measured_after: plainLine(60).optional(),
});
export type AcceptedProofCommand = z.infer<typeof AcceptedProofCommandSchema>;

/** Input of `run_proof_command`: the agent, and the name of a command the project declares. */
export const RunProofCommandInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  command: ProofCommandNameSchema,
});
export type RunProofCommandInput = z.infer<typeof RunProofCommandInputSchema>;
