import type { CreatorActionRecord } from "@agentplugged/protocol";
import { parseDeclaredLine } from "./proof-line.js";

/**
 * What the creator reads when the engine asks them to accept the project's proof commands (story
 * 17.22), in English like the rest of the journal. The lines are the ones the engine will run,
 * character for character; nothing an agent wrote stands between the file and the creator.
 */

type ProofCommandsRecord = Extract<CreatorActionRecord, { kind: "proof_commands" }>;

/** The title: what the creator decides. */
export function proofCommandsTitle(record: ProofCommandsRecord): string {
  const names = (record.commands ?? []).map((command) => command.name);
  const parts = [
    ...(names.length === 0
      ? []
      : [
          `let the engine run ${names.length === 1 ? "the proof command" : `${names.length} proof commands`} ${names.join(", ")}`,
        ]),
    ...(record.require === "engine"
      ? ["demand proofs the engine produced itself at the release"]
      : record.require === "any"
        ? ["accept proofs agents reported again at the release"]
        : []),
  ];
  const title = parts.join(" and ");
  return `${title.charAt(0).toUpperCase()}${title.slice(1)}`;
}

/** What the engine does with the lines, said once, before them. */
const RULES =
  "The engine runs exactly these lines, in the project's folder, and nothing else. A plain program is started without a shell; a line that uses the shell's syntax (or a script such as npm on Windows) goes through the system's shell. What a line itself launches (a script, a Makefile, a program of the project's folder found by its name) is whatever the project's files say. No variable that looks like a secret is passed on, each run stops at its time limit, and the output stays in a local file, secrets masked. Any change to a line, folder, limit or requirement asks you again.";

/** One command as the creator reads it: its name, the exact line, where, how long, what it proves. */
export function proofCommandLine(
  command: NonNullable<ProofCommandsRecord["commands"]>[number],
): string {
  const shell = parseDeclaredLine(command.run).kind === "argv" ? "" : "; through the shell";
  const measured =
    command.measured_after === undefined ? "" : `; measure read after "${command.measured_after}"`;
  return `- ${command.name}: ${command.run} [in ${command.cwd}; stops after ${command.timeout} s; ${command.proves.length === 0 ? "runs the tests of a criterion" : `proves ${command.proves.join(", ")}`}${shell}${measured}]`;
}

/** What approving does. */
export function proofCommandsEffect(record: ProofCommandsRecord): string {
  const commands = record.commands ?? [];
  const demand =
    record.require === "engine"
      ? "At a release, only a proof the engine ran or read itself counts: one an agent reported is a gap you settle."
      : record.require === "any"
        ? "At a release, a proof an agent reported counts again (the engine's own stay marked)."
        : "";
  return [
    ...(commands.length === 0 ? [] : [RULES, ...commands.map(proofCommandLine)]),
    ...(demand === "" ? [] : [demand]),
  ].join("\n");
}
