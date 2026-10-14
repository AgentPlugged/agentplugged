import type { EventEnvelope } from "@agentplugged/protocol";

/**
 * The aliases of the agents' former identifiers. Agent identifiers are
 * stable once shipped; the renaming of 2026-10-03 is the one exception, carried by the format
 * step `rename-agents` of `migrate` (format 1 → 2). The journal is never rewritten: its events keep
 * the identifiers they were written with, and the projection reads them through this table.
 *
 * This file and the migration step are the only places of the product that name the former
 * agents: the check of former names (`former-names.test.ts`) leaves them out.
 */

/** The format from which the new identifiers are in force. */
export const RENAMED_AGENTS_FORMAT = 2;

/** Each former identifier and the agent that took over its role. */
export const RENAMED_AGENTS: Readonly<Record<string, string>> = {
  marc: "maya",
  lea: "stella",
  atlas: "alex",
  // `sam` was the scrum master before format 2; since, `sam` is a backend developer.
  sam: "izzy",
  vera: "quentin",
  argus: "chloe",
  kai: "omar",
  clio: "zoe",
  lyra: "julien",
  muse: "lou",
};

/**
 * The developers retired by the renaming: shown as such, their history kept under their own
 * identifier. `rex` was the quick-lane developer, now a mode of every developer.
 */
export const RETIRED_DEVELOPERS: readonly string[] = ["nova", "orion", "rex"];

/**
 * The display names of the former team, as the creator read them: with `FORMER_AGENT_IDS`, what
 * the check of former names looks for in the product.
 */
export const FORMER_AGENT_NAMES: readonly string[] = [
  "Marc",
  "Léa",
  "Lea",
  "Atlas",
  "Vera",
  "Argus",
  "Kai",
  "Clio",
  "Lyra",
  "Muse",
  "Nova",
  "Orion",
  "Rex",
];

/** Every identifier of the former team: what a document written before format 2 may name. */
export const FORMER_AGENT_IDS: readonly string[] = [
  ...Object.keys(RENAMED_AGENTS),
  ...RETIRED_DEVELOPERS,
];

/**
 * The agent an identifier of the journal stands for. A former identifier that no agent bears any
 * more (`marc`, `lea`…) is always its successor, whatever the format: a machine still on the
 * former engine may write one after another machine migrated. `sam` alone is ambiguous: the
 * scrum master (now `izzy`) under the format in force before 2, the backend developer from 2 on.
 * A retired developer keeps its identifier.
 */
export function aliasAgent(id: string, format: number): string {
  if (id === "sam" && format >= RENAMED_AGENTS_FORMAT) return id;
  return Object.hasOwn(RENAMED_AGENTS, id) ? (RENAMED_AGENTS[id] as string) : id;
}

/**
 * The developer who takes over the stories of a retired one: `nova` → `sam`,
 * `orion` → `ethan`, `rex` → `sam` (the quick lane is a mode of every developer); any other
 * identifier is itself. A story owned, started or planned for a retired developer is built,
 * resumed and delivered by its successor.
 */
export function currentDeveloper(id: string): string {
  if (id === "nova" || id === "rex") return "sam";
  if (id === "orion") return "ethan";
  return id;
}

/** True for a developer the renaming retired (`nova`, `orion`, `rex`). */
export function isRetiredDeveloper(id: string): boolean {
  return RETIRED_DEVELOPERS.includes(id);
}

/**
 * The owner a document names, read as today's agent: a document keeps the owner it was written
 * with (its approved version is never rewritten). `sam` is ambiguous in a document and is kept.
 */
export function documentOwner(id: string): string {
  if (id === "sam") return id;
  return Object.hasOwn(RENAMED_AGENTS, id) ? (RENAMED_AGENTS[id] as string) : id;
}

function aliasList(value: unknown, format: number): unknown {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === "string" ? aliasAgent(item, format) : item))
    : value;
}

/**
 * An event as the projection reads it: `actor.agent`, and the agents its payload names
 * (`agent`, `owner`, `opened_by`, a sprint's `capacity.agents` and its stories' `owner`), read
 * through the aliases of the format in force. The same event when nothing changes; never a
 * change of the journal: a copy, after its signature was checked.
 */
export function aliasEvent(event: EventEnvelope, format: number): EventEnvelope {
  let changed = false;
  const actorAgent = event.actor.agent;
  const actor =
    actorAgent !== undefined && aliasAgent(actorAgent, format) !== actorAgent
      ? { ...event.actor, agent: aliasAgent(actorAgent, format) }
      : event.actor;
  if (actor !== event.actor) changed = true;
  let payload = event.payload as unknown;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const next: Record<string, unknown> = { ...record };
    for (const key of ["agent", "owner", "opened_by"]) {
      const value = record[key];
      if (typeof value === "string" && aliasAgent(value, format) !== value) {
        next[key] = aliasAgent(value, format);
        changed = true;
      }
    }
    const capacity = record.capacity as { agents?: unknown } | undefined;
    if (typeof capacity === "object" && capacity !== null && Array.isArray(capacity.agents)) {
      const agents = aliasList(capacity.agents, format) as unknown[];
      if (agents.some((agent, index) => agent !== (capacity.agents as unknown[])[index])) {
        next.capacity = { ...capacity, agents };
        changed = true;
      }
    }
    if (Array.isArray(record.stories)) {
      const stories = record.stories.map((story: unknown) => {
        if (typeof story !== "object" || story === null) return story;
        const owner = (story as { owner?: unknown }).owner;
        if (typeof owner !== "string" || aliasAgent(owner, format) === owner) return story;
        changed = true;
        return { ...story, owner: aliasAgent(owner, format) };
      });
      next.stories = stories;
    }
    payload = next;
  }
  if (!changed) return event;
  return { ...event, actor, payload } as EventEnvelope;
}
