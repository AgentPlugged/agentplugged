import type { ProofRequirement } from "@agentplugged/protocol";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { DeclaredProofCommand } from "./proof-declaration.js";

/**
 * What the creator decided about the project's proof commands, read from the
 * journal's projection and nowhere else: a `creator_action` checkpoint of the kind `proof_commands`,
 * answered `approved` by the creator and carried out (`executed`), accepts the fingerprints it
 * recorded; answered `rejected`, it refuses them. The projection already ignores an approval that
 * did not come from the creator (an agent, the `auto` level, a forged event); this reads that result.
 */

/** The sources an answer must come from to be the creator's own. */
const CREATOR_SOURCES: ReadonlySet<string> = new Set(["terminal", "chat", "elicitation"]);

/**
 * How an answer was proved. An accord that lets the engine run programs needs the creator's words
 * proved (the hook, the form, the terminal): never `chat_unverified`, `system` or `agent`.
 */
const PROVED_ASSURANCES: ReadonlySet<string> = new Set([
  "presence",
  "locale",
  "chat",
  "elicitation",
]);

/** A command the creator accepted. */
export interface AcceptedEntry {
  readonly point: string;
  readonly name: string;
  readonly proves: readonly string[];
}

/** What the creator decided, over the whole journal. */
export interface ProofDecisions {
  /** The commands the creator accepted, by fingerprint: the point, the name and what each proves. */
  readonly accepted: ReadonlyMap<string, AcceptedEntry>;
  /** The fingerprints the creator refused (and did not accept since). */
  readonly refused: ReadonlySet<string>;
  /** What the creator demands of the proofs at a release. `any` without a decision. */
  readonly require: ProofRequirement;
}

function proofPoints(state: Readonly<Record<string, unknown>>): CheckpointState[] {
  const points = (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {};
  return Object.values(points)
    .filter(
      (point) =>
        point.type === "creator_action" &&
        point.creator_action?.kind === "proof_commands" &&
        point.status === "resolved" &&
        point.resolution !== null &&
        CREATOR_SOURCES.has(point.resolution.source) &&
        PROVED_ASSURANCES.has(point.resolution.assurance),
    )
    .sort((a, b) =>
      a.opened_event < b.opened_event ? -1 : a.opened_event > b.opened_event ? 1 : 0,
    );
}

/** The decisions of the creator on the proof commands, in the order of the points that took them. */
export function proofDecisions(state: Readonly<Record<string, unknown>>): ProofDecisions {
  const accepted = new Map<string, AcceptedEntry>();
  const refused = new Set<string>();
  let require: ProofRequirement = "any";
  for (const point of proofPoints(state)) {
    const record = point.creator_action;
    if (record?.kind !== "proof_commands") continue;
    const decision = point.resolution?.decision;
    if (decision === "approved" && (point.executed ?? null) !== null) {
      for (const command of record.commands ?? []) {
        accepted.set(command.fingerprint, {
          point: point.id,
          name: command.name,
          proves: command.proves,
        });
        refused.delete(command.fingerprint);
      }
      if (record.require !== undefined) require = record.require;
    } else if (decision === "rejected") {
      for (const command of record.commands ?? []) {
        if (!accepted.has(command.fingerprint)) refused.add(command.fingerprint);
      }
    }
  }
  return { accepted, refused, require };
}

/** Where a declared command stands with the creator. */
export type CommandStanding = "accepted" | "refused" | "pending";

export function standingOf(
  command: Pick<DeclaredProofCommand, "fingerprint">,
  decisions: ProofDecisions,
): CommandStanding {
  if (decisions.accepted.has(command.fingerprint)) return "accepted";
  return decisions.refused.has(command.fingerprint) ? "refused" : "pending";
}

/** True when a point of proof commands is open: the creator has not answered it yet. */
export function proofRequestOpen(
  state: Readonly<Record<string, unknown>>,
): CheckpointState | undefined {
  const points = (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {};
  return Object.values(points).find(
    (point) =>
      point.type === "creator_action" &&
      point.creator_action?.kind === "proof_commands" &&
      point.status === "open",
  );
}

/**
 * The commands a request asks the creator to accept: the ones named (a refused one too: naming it
 * is asking again), else every declared command that is new or modified and not refused as it
 * stands. Commands already accepted are never asked twice.
 */
export function commandsToAccept(
  declared: readonly DeclaredProofCommand[],
  decisions: ProofDecisions,
  named: readonly string[] | undefined,
): { readonly commands: DeclaredProofCommand[]; readonly unknown: string[] } {
  if (named !== undefined) {
    const byName = new Map(declared.map((command) => [command.name, command] as const));
    const unknown = named.filter((name) => !byName.has(name));
    const commands = named
      .map((name) => byName.get(name))
      .filter(
        (command): command is DeclaredProofCommand =>
          command !== undefined && standingOf(command, decisions) !== "accepted",
      );
    return { commands, unknown };
  }
  return {
    commands: declared.filter((command) => standingOf(command, decisions) === "pending"),
    unknown: [],
  };
}
