import {
  type Command,
  inputShapeOf,
  publishedShape,
  TOOL_GROUPS,
  type ToolGroup,
} from "@agentplugged/core";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";

/** The most characters a published tool description may hold. */
export const MAX_DESCRIPTION = 400;

/**
 * The published description of each grouped tool: what it does, its actions, and the safety rules
 * that must stay in the agent's sight. Everything else (fields, refusals, the order of gestures) is
 * in the reference, section « Tool: <name> », and in the skills.
 */
export const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  state:
    "Read-only. Actions: get (ONE option only), next, trace, merge_order, environment. See reference/tool-state.md",
  checkpoint:
    "Validation points. Actions: open (before asking the creator), decide (only a point the creator did not keep), measures, gap. Never answer for the creator. See reference/tool-checkpoint.md",
  chat: "Ask the creator. Actions: ask, answer (only the creator's own words in quote, or via question_tool), stack_open, stack_ask, stack_answer, table. Never answer, reword or waive for the creator. See reference/tool-chat.md",
  story:
    "Actions: start (only in its workdir), status, progress, result (end with it), pr (never merge), ci, deviation, lift_deviation, leave_fast_track, merge_conflict, criterion, loop. Never skip hooks or push the main branch. See reference/tool-story.md",
  review:
    "Actions: start, submit, triage, get, publish, audit, critique, tests, qa, ready, export. Never review a story you built. See reference/tool-review.md",
  agent:
    "Activity, handovers. Actions: status, delegate (Noah only), workshop. agent = your own id. See reference/tool-agent.md",
  guard:
    "Creator-only actions, sensitive data. Actions: request, check (refused means never), external_read, creator_action (only with their yes), read_sensitive, write_sensitive (never read salle/ or memory/ files directly). what = action. See reference/tool-guard.md",
  plan: "Actions: sprint (the creator approves), defer, complete_deferred, course (change of mind). Never start a story an open deferred item locks. See reference/tool-plan.md",
  memory:
    "Lessons. Actions: read (before your first answer), retrospective, record, promote_propose, promote. Never record or promote a lesson before the creator approved it. See reference/tool-memory.md",
  measure:
    "Actions: cost (never invent an amount), usage, requirements, proof (real results only), run (a command the creator accepted). See reference/tool-measure.md",
};

type Json = Record<string, unknown>;

/** One field of a published schema: a type, and the values of a short enumeration. */
function slim(field: unknown): Json {
  if (typeof field !== "object" || field === null) return {};
  const node = field as Json;
  const out: Json = {};
  const types = new Set<string>();
  const note = (value: unknown) => {
    if (typeof value === "string" && value !== "null") types.add(value);
    if (Array.isArray(value)) for (const item of value) note(item);
  };
  note(node.type);
  for (const branch of (node.anyOf ?? node.oneOf ?? []) as unknown[]) {
    note((branch as Json | undefined)?.type);
  }
  if (types.size === 1) out.type = [...types][0];
  if (Array.isArray(node.enum) && node.enum.length <= 12) out.enum = node.enum;
  return out;
}

/** Two published fields of the same name, merged: kept only what both agree on. */
function merged(a: Json, b: Json): Json {
  const out: Json = {};
  if (a.type !== undefined && a.type === b.type) out.type = a.type;
  // An enumeration is kept only when both agree there is one; otherwise one side is free text.
  if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
    out.enum = [...new Set([...(a.enum as unknown[]), ...(b.enum as unknown[])])];
  }
  return out;
}

export interface PublishedTool {
  readonly name: string;
  readonly description: string;
  /** The JSON Schema advertised in `tools/list`: lean, the engine validates the input itself. */
  readonly schema: Json;
  /** The fields of each action, for the error that says what to fix. */
  readonly actions: ReadonlyMap<string, Command>;
}

/**
 * The published form of a group: one object with `action` and the union of the actions' fields,
 * reduced to names and types (no `$schema`, no `additionalProperties`, no pattern, no bound): the
 * validation stays whole inside each command, and a refusal says what to fix.
 */
export function publishedTool(
  name: string,
  group: ToolGroup,
  commands: ReadonlyMap<string, Command>,
): PublishedTool | undefined {
  const properties: Record<string, Json> = {};
  const actions = new Map<string, Command>();
  for (const [action, spec] of Object.entries(group.actions)) {
    const command = commands.get(spec.command);
    if (command === undefined) continue;
    actions.set(action, command);
    const shape = inputShapeOf(command);
    if (shape === undefined) continue;
    const published = publishedShape(shape, spec.rename ?? {});
    for (const [field, schema] of Object.entries((published.properties ?? {}) as Json)) {
      const slimmed = slim(schema);
      const known = properties[field];
      properties[field] = known === undefined ? slimmed : merged(known, slimmed);
    }
  }
  if (actions.size === 0) return undefined;
  const description = TOOL_DESCRIPTIONS[name] ?? group.summary;
  return {
    name,
    description,
    schema: {
      type: "object",
      properties: { action: { type: "string", enum: [...actions.keys()] }, ...properties },
      required: ["action"],
    },
    actions,
  };
}

/** The groups the registry's commands fill, in the table's order. */
export function publishedTools(commands: ReadonlyMap<string, Command>): PublishedTool[] {
  return Object.entries(TOOL_GROUPS).flatMap(([name, group]) => {
    const tool = publishedTool(name, group, commands);
    return tool === undefined ? [] : [tool];
  });
}

/** A schema the SDK advertises as given and lets every value through (the command validates). */
export function advertisedJson(schema: Json): StandardSchemaWithJSON {
  return {
    "~standard": {
      version: 1,
      vendor: "agentplugged",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => schema, output: () => schema },
    },
  } as unknown as StandardSchemaWithJSON;
}
