import { isRecord } from "../values.js";
import { lines, skillNameOf } from "./trace-readers.js";

/**
 * What made a session dearer than it needed to be, read by the engine in the tool's
 * own trace so that the agent never reads the conversation itself: the skills loaded more than
 * once, the files read again and again, the tools that kept failing. Three kinds, each a fact with
 * its count; the engine proposes nothing and changes nothing. Claude Code's transcript only: another
 * tool's trace does not say it, and the report says so instead of showing an empty list.
 */

/** A skill loaded this many times in one session, a file read this many, a tool failing this many. */
export const SKILL_RELOADS = 2;
export const FILE_REREADS = 3;
export const TOOL_FAILURES = 3;
/** ...and at least this share of its calls: a tool called a thousand times that failed thirty is not failing. */
export const TOOL_FAILURE_RATE = 0.25;
/** At most this many of each kind are kept, the heaviest first. */
export const HABITS_PER_KIND = 3;

export interface SessionHabits {
  /** Skills called more than once: the whole skill text entered the conversation each time. */
  readonly skills_reloaded: readonly { readonly skill: string; readonly calls: number }[];
  /** Files read at least three times; `chars` is the text those reads brought back, all but the first. */
  readonly files_reread: readonly {
    readonly path: string;
    readonly reads: number;
    readonly chars: number;
  }[];
  /** Tools whose calls failed at least three times, and at least a quarter of the time. */
  readonly tools_failing: readonly {
    readonly tool: string;
    readonly calls: number;
    readonly errors: number;
  }[];
}

interface Call {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** The text a tool result brought back, in characters. */
function resultChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce<number>(
    (total, block) =>
      total + (isRecord(block) && typeof block.text === "string" ? block.text.length : 0),
    0,
  );
}

/** The tools that write a file: a read after one of them is a new read. */
const WRITES: readonly string[] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** A name or a path from a trace, on one line without control character, at most 200 characters. */
function plain(text: string): string {
  let out = "";
  for (const char of text.replaceAll("\\", "/")) {
    out += (char.codePointAt(0) ?? 0) < 32 || char === "\u007f" ? " " : char;
  }
  return out.length <= 200 ? out : `${out.slice(0, 199)}…`;
}

/** The habits of a Claude Code transcript. Pure. */
export function habitsOf(text: string): SessionHabits {
  const calls = new Map<string, Call>();
  const results = new Map<string, { error: boolean; chars: number }>();
  for (const row of lines(text)) {
    if (!isRecord(row.message) || !Array.isArray(row.message.content)) continue;
    for (const block of row.message.content) {
      if (!isRecord(block)) continue;
      if (
        row.type === "assistant" &&
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        calls.set(block.id, { name: block.name, input: isRecord(block.input) ? block.input : {} });
      }
      if (
        row.type === "user" &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        results.set(block.tool_use_id, {
          error: block.is_error === true,
          chars: resultChars(block.content),
        });
      }
    }
  }
  const skills = new Map<string, number>();
  // A read counts for the same file and the same window (`offset`, `limit`): reading a big file by
  // pieces is no re-reading, and a file the session wrote itself starts afresh.
  const files = new Map<string, { path: string; reads: number; chars: number }>();
  const tools = new Map<string, { calls: number; errors: number }>();
  for (const [id, call] of calls) {
    const result = results.get(id);
    const skill = call.name === "Skill" ? skillNameOf(call.input) : undefined;
    if (skill !== undefined) skills.set(skill, (skills.get(skill) ?? 0) + 1);
    const target =
      typeof call.input.file_path === "string" ? plain(call.input.file_path) : undefined;
    if (target !== undefined && WRITES.includes(call.name)) {
      for (const [key, file] of files) if (file.path === target) files.delete(key);
    }
    if (call.name === "Read" && target !== undefined) {
      const key = `${target}\u0000${String(call.input.offset ?? "")}\u0000${String(call.input.limit ?? "")}`;
      const seen = files.get(key);
      // The first read is the useful one: only what the following ones brought back is waste.
      files.set(key, {
        path: target,
        reads: (seen?.reads ?? 0) + 1,
        chars: (seen?.chars ?? 0) + (seen === undefined ? 0 : (result?.chars ?? 0)),
      });
    }
    const name = plain(call.name);
    const tool = tools.get(name) ?? { calls: 0, errors: 0 };
    tools.set(name, {
      calls: tool.calls + 1,
      errors: tool.errors + (result?.error === true ? 1 : 0),
    });
  }
  return {
    skills_reloaded: [...skills]
      .filter(([, count]) => count >= SKILL_RELOADS)
      .map(([skill, count]) => ({ skill, calls: count }))
      .sort((a, b) => b.calls - a.calls || (a.skill < b.skill ? -1 : 1))
      .slice(0, HABITS_PER_KIND),
    files_reread: [...files.values()]
      .filter((file) => file.reads >= FILE_REREADS)
      .map((file) => ({ path: file.path, reads: file.reads, chars: file.chars }))
      .sort((a, b) => b.chars - a.chars || (a.path < b.path ? -1 : 1))
      .slice(0, HABITS_PER_KIND),
    tools_failing: [...tools]
      .filter(
        ([, tool]) => tool.errors >= TOOL_FAILURES && tool.errors / tool.calls >= TOOL_FAILURE_RATE,
      )
      .map(([name, tool]) => ({ tool: name, calls: tool.calls, errors: tool.errors }))
      .sort((a, b) => b.errors - a.errors || (a.tool < b.tool ? -1 : 1))
      .slice(0, HABITS_PER_KIND),
  };
}
