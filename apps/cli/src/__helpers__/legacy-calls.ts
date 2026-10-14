import { toolInputOf } from "@agentplugged/core";
import { Client } from "@modelcontextprotocol/client";

/**
 * Tests only. The tools are grouped, but the commands behind them are the same: the
 * tests written for the one-action tools keep calling them by their command's name, and this maps
 * each call to the grouped tool (`report_progress` -> `story` with `action: "progress"`). Each
 * test of the old names therefore also proves the correspondence table: same validation, same
 * events, same refusals through the new tools.
 *
 * It also gives back what those tests read: `structuredContent` (parsed from the text, the server
 * no longer sends it twice) and, for a refusal, `{ code, details }` read from the one text.
 */
interface ToolResultLike {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

function read(result: ToolResultLike): ToolResultLike {
  if (result.structuredContent !== undefined || result.content === undefined) return result;
  const text = result.content[0]?.text;
  if (typeof text !== "string") return result;
  if (result.isError === true) {
    const match = /^Error ([A-Z_0-9]+): ([\s\S]*?)(?:\n(\{[\s\S]*\}))?$/.exec(text);
    if (match === null) return result;
    let details: Record<string, unknown> = {};
    try {
      details = match[3] === undefined ? {} : (JSON.parse(match[3]) as Record<string, unknown>);
    } catch {
      details = {};
    }
    // The tests' own error text is `message of <message_key>`: give the key back as it was.
    const key = /^message of (.+)$/.exec(match[2] ?? "")?.[1];
    return {
      ...result,
      structuredContent: {
        code: match[1],
        ...(key === undefined ? { message: match[2] } : { message_key: key }),
        details,
      },
    };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      return { ...result, structuredContent: parsed as Record<string, unknown> };
    }
  } catch {
    // Not JSON: nothing structured to give back.
  }
  return result;
}

let installed = false;

/** Makes every `Client.callTool` of the old names reach the grouped tools. */
export function installLegacyCalls(): void {
  if (installed) return;
  installed = true;
  const original = Client.prototype.callTool;
  Client.prototype.callTool = async function patched(
    this: Client,
    params: { name: string; arguments?: Record<string, unknown> },
    ...rest: unknown[]
  ) {
    const mapped = toolInputOf(params.name, params.arguments ?? {});
    const next =
      mapped === undefined ? params : { ...params, name: mapped.tool, arguments: mapped.input };
    const result = (await (original as (...args: unknown[]) => Promise<ToolResultLike>).call(
      this,
      next,
      ...rest,
    )) as ToolResultLike;
    const shown = read(result);
    // What the server really sent, for the tests that check the wire.
    Object.defineProperty(shown, "raw", { value: result, enumerable: false });
    return shown;
  } as typeof Client.prototype.callTool;
}

installLegacyCalls();
