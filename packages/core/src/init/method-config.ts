import {
  ErrorCode,
  type MethodConfig,
  MethodConfigSchema,
  type ToolId,
} from "@agentplugged/protocol";
import { type Document, LineCounter, parseDocument, stringify } from "yaml";
import { AgentPluggedError, reasonDetails } from "../errors.js";
import type { StateStore } from "../journal/state-store.js";
import { AGENT_DOMAINS, inactiveAgents } from "../profile/catalog.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { METHOD_CONFIG_PATH } from "./layout.js";

/** `details.field` when the fault is not tied to one field (syntax error, unreadable file). */
export const ROOT_FIELD = "(root)";

export function methodConfigInvalid(
  field: string,
  reason: string,
  line?: number,
  column?: number,
): AgentPluggedError {
  const details: Record<string, unknown> = {
    path: METHOD_CONFIG_PATH,
    field,
    ...reasonDetails(reason),
  };
  if (line !== undefined) details.line = line;
  if (line !== undefined && column !== undefined) details.column = column;
  return new AgentPluggedError(
    ErrorCode.METHOD_CONFIG_INVALID,
    line === undefined ? "error.method_config_invalid" : "error.method_config_invalid.line",
    details,
  );
}

type Ranged = { range?: readonly [number, number, number] } | null | undefined;

/** Key node of the last path segment, used to point at an unknown key. */
function findKeyNode(document: Document, path: readonly PropertyKey[]): unknown {
  const parent = path.length > 1 ? document.getIn(path.slice(0, -1), true) : document.contents;
  const items = (parent as { items?: Array<{ key?: { value?: unknown } }> } | null)?.items;
  return items?.find((pair) => pair.key?.value === path[path.length - 1])?.key;
}

/** Parses and validates `method.yaml`; returns the config or a `METHOD_CONFIG_INVALID` error. */
export function parseMethodConfig(text: string): MethodConfig | AgentPluggedError {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, prettyErrors: true, uniqueKeys: true });
  const syntaxError = document.errors[0];
  if (syntaxError) {
    const position = syntaxError.linePos?.[0];
    const reason = syntaxError.message.split("\n")[0] ?? syntaxError.code;
    return methodConfigInvalid(ROOT_FIELD, reason, position?.line, position?.col);
  }

  const locate = (node: unknown) => {
    const offset = (node as Ranged)?.range?.[0];
    return offset === undefined ? undefined : lineCounter.linePos(offset);
  };

  const result = MethodConfigSchema.safeParse(document.toJS());
  if (result.success) {
    const reason = inactiveAgentsProblem(result.data);
    if (reason === undefined) return result.data;
    const position = locate(document.getIn(["agents", "inactive"], true));
    return methodConfigInvalid(INACTIVE_FIELD, reason, position?.line, position?.col);
  }

  const issue = result.error.issues[0];
  if (!issue) return methodConfigInvalid(ROOT_FIELD, "invalid");
  const path: PropertyKey[] = [...issue.path];
  const unknownKey = issue.code === "unrecognized_keys" ? issue.keys[0] : undefined;
  if (unknownKey !== undefined) path.push(unknownKey);
  const field = path.length > 0 ? path.map(String).join(".") : ROOT_FIELD;

  // Line of the offending value (or of the unknown key), when it appears in the file.
  const node =
    path.length === 0
      ? document.contents
      : unknownKey !== undefined
        ? findKeyNode(document, path)
        : document.getIn(path, true);
  const position = locate(node);
  return methodConfigInvalid(field, issue.message, position?.line, position?.col);
}

const INACTIVE_FIELD = "agents.inactive";

/**
 * `agents.inactive` names known agents, once each, and matches the profile when there is one
 * (it is computed, never edited by hand). Returns why it does not, or undefined.
 */
function inactiveAgentsProblem(config: MethodConfig): string | undefined {
  const listed = config.agents?.inactive;
  if (listed !== undefined) {
    const unknown = listed.find((agent) => !Object.hasOwn(AGENT_DOMAINS, agent));
    if (unknown !== undefined) return `unknown agent "${unknown}"`;
    const duplicate = listed.find((agent, i) => listed.indexOf(agent) !== i);
    if (duplicate !== undefined) return `duplicate agent "${duplicate}"`;
  }
  if (config.profile === undefined) return undefined;
  const expected = inactiveAgents(config.profile);
  if (listed === undefined || listed.join(",") !== expected.join(",")) {
    return `does not match the profile (expected [${expected.join(", ")}])`;
  }
  return undefined;
}

/**
 * The text of an edited `method.yaml` document, as every edit of the engine writes it: no
 * refolding of long lines and no padding in flow lists, so untouched lines stay as the creator
 * wrote them, and the line endings of `original` (CRLF kept). For migration steps too.
 */
export function stringifyMethodDocument(document: Document, original: string): string {
  const output = document.toString({ lineWidth: 0, flowCollectionPadding: false });
  return original.includes("\r\n") ? output.replace(/\r?\n/g, "\r\n") : output;
}

export function renderMethodConfig(config: MethodConfig): string {
  return stringify(MethodConfigSchema.parse(config));
}

export interface LoadedMethodConfig {
  readonly text: string;
  readonly config: MethodConfig;
}

/** Reads and validates `method.yaml`, which must exist. */
export async function loadMethodConfig(
  files: WorkspaceFiles,
): Promise<LoadedMethodConfig | AgentPluggedError> {
  let text: string;
  try {
    text = await files.readText(METHOD_CONFIG_PATH);
  } catch (error) {
    return methodConfigInvalid(ROOT_FIELD, error instanceof Error ? error.message : String(error));
  }
  const config = parseMethodConfig(text);
  return config instanceof AgentPluggedError ? config : { text, config };
}

/**
 * The document of a `method.yaml` text that parses as a valid one, to edit: comments and other keys
 * are kept; else why it is not valid.
 */
export function openMethodDocument(text: string): Document | AgentPluggedError {
  const current = parseMethodConfig(text);
  return current instanceof AgentPluggedError ? current : parseDocument(text);
}

/**
 * The text of an edited document, with the line endings of `original`, once validated; else why the
 * edit made it invalid. `stable`: no refolding of long lines, as `stringifyMethodDocument` writes it.
 */
export function editedMethodText(
  document: Document,
  original: string,
  stable = false,
): string | AgentPluggedError {
  let output = stable
    ? document.toString({ lineWidth: 0, flowCollectionPadding: false })
    : document.toString();
  if (original.includes("\r\n")) output = output.replace(/\r?\n/g, "\r\n");
  const checked = parseMethodConfig(output);
  return checked instanceof AgentPluggedError ? checked : output;
}

/** Writes the `tools` list into the text of `method.yaml`, keeping comments and other keys. */
export function writeTools(text: string, tools: readonly ToolId[]): string | AgentPluggedError {
  const document = parseDocument(text);
  document.set("tools", document.createNode([...tools]));
  return editedMethodText(document, text);
}

/** Writes `engine_version` into the text of `method.yaml`, keeping comments and other keys. */
export function writeEngineVersion(text: string, version: string): string | AgentPluggedError {
  const document = parseDocument(text);
  document.set("engine_version", version);
  return editedMethodText(document, text);
}

/**
 * The product of this folder: `product_id` of `method.yaml`, else the journal's (an agent never
 * writes `method.yaml`); else `METHOD_CONFIG_INVALID`.
 */
export async function productOf(
  config: MethodConfig,
  journal: StateStore,
): Promise<string | AgentPluggedError> {
  const product = config.product_id ?? (await journal.productId());
  return product ?? methodConfigInvalid("product_id", "missing: run `npx agentplugged init` first");
}
