import { z } from "zod";
import type { Command } from "./command.js";
import { TOOL_GROUPS, toolNotation, withToolNotation } from "./mcp-tools.js";

/**
 * The manual of the grouped tools. The tools' published descriptions are short; what
 * each action does, its fields and its refusals are written once, in the commands themselves, and
 * rendered into the reference (`.agentplugged/reference/tool-<name>.md`, one file « Tool: <name> »), read when
 * an agent first uses an action. The commands are provided by `index.ts` when core loads, so that
 * `init` and `sync` can render them without depending on it.
 */
let manual: ReadonlyArray<Command> = [];

export function provideToolManual(commands: ReadonlyArray<Command>): void {
  manual = commands;
}

type Json = Record<string, unknown>;

/** Keys of a JSON Schema that weigh much and say nothing the engine does not check itself. */
const DROPPED = new Set(["$schema", "additionalProperties", "pattern", "maxLength", "minLength"]);

/** A JSON Schema reduced to its shape: types, enums, required lists, nesting (no patterns or bounds). */
function reduced(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(reduced);
  if (typeof node !== "object" || node === null) return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    if (DROPPED.has(key)) continue;
    // `properties` maps field names to schemas: a field may be called like a dropped key.
    if (key === "properties" && typeof value === "object" && value !== null) {
      out[key] = Object.fromEntries(
        Object.entries(value as Json).map(([name, field]) => [name, reduced(field)]),
      );
      continue;
    }
    out[key] = reduced(value);
  }
  return out;
}

/** The input schema of a command as JSON Schema, reduced; undefined when it cannot be drawn. */
export function inputShapeOf(command: Command): Json | undefined {
  if (command.inputSchema === undefined) return undefined;
  try {
    const json = z.toJSONSchema(command.inputSchema, { io: "input", unrepresentable: "any" });
    return reduced(json) as Json;
  } catch {
    return undefined;
  }
}

/** The shape of an action's input as the tool publishes it: `action` (or `what`) renamed. */
export function publishedShape(shape: Json, rename: Readonly<Record<string, string>>): Json {
  const properties = (shape.properties ?? {}) as Json;
  const required = ((shape.required ?? []) as string[]).slice();
  const back = Object.fromEntries(Object.entries(rename).map(([from, to]) => [to, from]));
  const renamed: Json = {};
  for (const [name, field] of Object.entries(properties)) renamed[back[name] ?? name] = field;
  return {
    ...shape,
    properties: renamed,
    required: required.map((name) => back[name] ?? name),
  };
}

function section(tool: string, group: (typeof TOOL_GROUPS)[string]): string {
  const lines = [
    `## Tool: ${tool}`,
    "",
    `${group.summary} Call \`${tool}\` with \`action\` set to the action's name (${Object.keys(
      group.actions,
    )
      .map((action) => `\`${tool}.${action}\``)
      .join(
        ", ",
      )}); the other fields are the action's own, listed below (\`*\` marks a required one).`,
  ];
  for (const [action, spec] of Object.entries(group.actions)) {
    const command = manual.find(
      (candidate) => candidate.name === spec.command && candidate.audience === "agent",
    );
    lines.push("", `### \`${toolNotation({ tool, action })}\``, "");
    if (command?.description !== undefined) lines.push(withToolNotation(command.description));
    const shape = command === undefined ? undefined : inputShapeOf(command);
    if (shape !== undefined) {
      const published = publishedShape(shape, spec.rename ?? {});
      const required = new Set((published.required ?? []) as string[]);
      const properties = (published.properties ?? {}) as Json;
      const fields = Object.entries(properties).map(
        ([name, field]) => `${name}${required.has(name) ? "*" : ""}: ${JSON.stringify(field)}`,
      );
      lines.push("", `Fields: ${fields.length === 0 ? "none" : fields.join("; ")}`);
    }
  }
  return lines.join("\n");
}

/** The reference sections of every grouped tool, empty while no command was provided. */
export function renderToolsReference(withNoah = true): string {
  if (manual.length === 0) return "";
  const text = renderAll();
  // Without Noah the main session is not an agent of the method: nothing names him.
  return withNoah ? text : text.replace(/\bNoah('s)?\b/g, "the main session$1");
}

function renderAll(): string {
  return Object.entries(TOOL_GROUPS)
    .map(([tool, group]) => section(tool, group))
    .join("\n\n");
}
