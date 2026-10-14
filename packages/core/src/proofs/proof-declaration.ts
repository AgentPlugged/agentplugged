import { sha256Hex } from "@agentplugged/crypto";
import {
  type AcceptedProofCommand,
  DEFAULT_PROOF_TIMEOUT_SECONDS,
  normalizedFolder,
  type ProofCommand,
  ProofsFileSchema,
} from "@agentplugged/protocol";
import { parseDocument } from "yaml";
import { METHOD_DIR } from "../init/layout.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { parseDeclaredLine, runsCriteria } from "./proof-line.js";

/**
 * The commands the project declares to prove its requirements: the file
 * `.agentplugged/proofs.yaml`, read and checked by the engine. An agent may write a proposal in it;
 * nothing in it runs before the creator accepted the exact lines.
 *
 * ```yaml
 * commands:
 *   - name: tests
 *     run: npm test
 *     timeout: 600          # seconds, 300 without
 *     proves:
 * ```
 */
export const PROOFS_PATH = `${METHOD_DIR}/proofs.yaml`;

/** A declared command with everything the engine runs spelled out, and its fingerprint. */
export interface DeclaredProofCommand extends AcceptedProofCommand {
  /** True when the line is started through the system's shell (its syntax needs one). */
  readonly shell: boolean;
}

/** What the file says: the commands, or why it cannot be read. `none`: the project declares none. */
export type ProofDeclaration =
  | { readonly kind: "commands"; readonly commands: readonly DeclaredProofCommand[] }
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly problems: readonly string[] };

/**
 * The fingerprint an accord is for: the name, the line, the folder, the time limit, what it proves
 * and how it measures, nothing else. Two declarations with the same fingerprint run the same way
 * and prove the same; the least change to any of these is another fingerprint.
 */
export function proofFingerprint(
  command: Pick<
    AcceptedProofCommand,
    "name" | "run" | "cwd" | "timeout" | "proves" | "measured_after"
  >,
): string {
  return sha256Hex(
    JSON.stringify([
      "proof-command@1",
      command.name,
      command.run,
      command.cwd,
      command.timeout,
      [...command.proves].sort(),
      command.measured_after ?? null,
    ]),
  ).slice(0, 24);
}

/** A declared command with its defaults filled in and its fingerprint. */
export function resolvedCommand(command: ProofCommand): DeclaredProofCommand {
  const resolved = {
    name: command.name,
    run: command.run,
    cwd: normalizedFolder(command.cwd),
    timeout: command.timeout ?? DEFAULT_PROOF_TIMEOUT_SECONDS,
    proves: [...(command.proves ?? [])],
    ...(command.measured_after === undefined ? {} : { measured_after: command.measured_after }),
  };
  return {
    ...resolved,
    fingerprint: proofFingerprint(resolved),
    // The marks of a criterion are plain characters once written: they do not make a shell line.
    shell: parseDeclaredLine(command.run).kind !== "argv",
  };
}

/** The accord's record of a declared command: what the creator reads, without the engine's own flag. */
export function acceptedForm(command: DeclaredProofCommand): AcceptedProofCommand {
  const { shell: _shell, ...accepted } = command;
  return accepted;
}

/** The first problems of a file, as short lines the agent can fix. */
const MAX_PROBLEMS = 5;

/**
 * Reads `.agentplugged/proofs.yaml`: absent is `none`; a file that is not valid YAML, does not
 * match the schema, or holds a line that cannot be read is `invalid`, with where.
 */
export async function readProofDeclaration(files: WorkspaceFiles): Promise<ProofDeclaration> {
  if (!(await files.exists(PROOFS_PATH))) return { kind: "none" };
  let text: string;
  try {
    text = await files.readText(PROOFS_PATH);
  } catch {
    return { kind: "invalid", problems: [`${PROOFS_PATH}: cannot be read`] };
  }
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) {
    const first = document.errors[0]?.message.split("\n")[0] ?? "invalid YAML";
    return { kind: "invalid", problems: [`${PROOFS_PATH}: ${first}`] };
  }
  const parsed = ProofsFileSchema.safeParse(document.toJS() ?? { commands: [] });
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, MAX_PROBLEMS).map((issue) => {
      const where = issue.path.length === 0 ? "(root)" : issue.path.join(".");
      return `${where}: ${issue.message}`;
    });
    return { kind: "invalid", problems };
  }
  const problems: string[] = [];
  parsed.data.commands.forEach((command, index) => {
    const line = parseDeclaredLine(command.run);
    if (line.kind === "invalid") {
      problems.push(
        `commands.${index}.run: ${line.reason === "empty" ? "empty" : "a quote is not closed"}`,
      );
    }
    if ((command.proves ?? []).length === 0 && !runsCriteria(command.run)) {
      problems.push(`commands.${index}.proves: name a requirement, or put {criterion} in the line`);
    }
  });
  if (problems.length > 0) return { kind: "invalid", problems };
  return { kind: "commands", commands: parsed.data.commands.map(resolvedCommand) };
}
