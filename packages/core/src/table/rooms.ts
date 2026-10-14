import {
  MAX_MEMORY_LINES,
  NOAH_AGENT,
  RECALLED_MEMORY_LINES,
  type Room,
  type RoomGuest,
  RoomIdSchema,
  RoomSchema,
} from "@agentplugged/protocol";
import { parse } from "yaml";
import { METHOD_DIR } from "../init/layout.js";
import type { WorkspaceFiles } from "../workspace-files.js";

/**
 * Saved rooms of the round table. A room is two plain files the creator can read
 * and edit, beside the product's other files and never in the journal: `<id>.yaml` (the cast, the
 * setting, whether the room remembers) and `<id>.memory.md` (a few lines per session, the oldest
 * forgotten). Pure rules, and the reads and writes of those two files; nothing else.
 */

export const ROOMS_DIR = `${METHOD_DIR}/rooms`;

export const roomPath = (id: string): string => `${ROOMS_DIR}/${id}.yaml`;
export const memoryPath = (id: string): string => `${ROOMS_DIR}/${id}.memory.md`;

/** Characters a recalled memory holds at most, whatever the lines the creator edited in. */
const RECALLED_MEMORY_CHARS = 1_200;
/** Characters of one memory line kept when reading (a line edited by hand may be longer). */
const MEMORY_LINE_CHARS = 200;
const MEMORY_HEADER =
  "# Room memory: one line per point worth remembering, the newest last. Edit freely.";

/** A room read from its file: the room, or why it cannot be used (short codes). */
export type RoomRead =
  | { readonly ok: true; readonly room: Room }
  | { readonly ok: false; readonly problems: readonly string[] };

/** What is wrong with a room's cast beyond its shape, as codes. */
function castProblems(room: Room): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const member of room.members) {
    // The leader of the table never sits, in a saved room either.
    if (member === NOAH_AGENT || member === "main") problems.push(`room_member_leads:${member}`);
    if (seen.has(member)) problems.push(`room_member_twice:${member}`);
    seen.add(member);
  }
  const guests = new Set<string>();
  for (const guest of room.guests) {
    if (guests.has(guest.id)) problems.push(`room_guest_twice:${guest.id}`);
    guests.add(guest.id);
  }
  return problems;
}

/** Reads a room's text: a short code for each thing wrong, never an exception. */
export function parseRoom(text: string): RoomRead {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    return { ok: false, problems: ["room_invalid:yaml"] };
  }
  const parsed = RoomSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "room");
    return {
      ok: false,
      problems: [...new Set(fields)].slice(0, 6).map((field) => `room_invalid:${field}`),
    };
  }
  const problems = castProblems(parsed.data);
  return problems.length === 0 ? { ok: true, room: parsed.data } : { ok: false, problems };
}

/** Reads the saved room of that name: `room_unknown` when there is none. */
export async function readRoom(files: WorkspaceFiles, id: string): Promise<RoomRead> {
  if (!RoomIdSchema.safeParse(id).success) return { ok: false, problems: ["room_unknown"] };
  const path = roomPath(id);
  if (!(await files.exists(path))) return { ok: false, problems: ["room_unknown"] };
  const text = await files.readText(path).catch(() => undefined);
  return text === undefined ? { ok: false, problems: ["room_invalid:read"] } : parseRoom(text);
}

/** The lines of memory in a file's text: the lines that start with `- `, each bounded. */
export function parseMemory(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim().slice(0, MEMORY_LINE_CHARS))
    .filter((line) => line !== "");
}

/** The memory after a session adds its lines (dated), the oldest forgotten past the bound. */
export function withMemory(
  entries: readonly string[],
  date: string,
  lines: readonly string[],
): string[] {
  return [...entries, ...lines.map((line) => `${date}: ${line}`)].slice(-MAX_MEMORY_LINES);
}

export function renderMemory(entries: readonly string[]): string {
  return `${MEMORY_HEADER}\n${entries.map((entry) => `- ${entry}`).join("\n")}\n`;
}

/** What is read back on entering: the latest lines, in a short total, the newest last. */
export function recalledMemory(entries: readonly string[]): string[] {
  const kept: string[] = [];
  let size = 0;
  for (const entry of entries.slice(-RECALLED_MEMORY_LINES).reverse()) {
    if (size + entry.length > RECALLED_MEMORY_CHARS) break;
    kept.unshift(entry);
    size += entry.length;
  }
  return kept;
}

async function memoryOf(files: WorkspaceFiles, id: string): Promise<string[]> {
  const path = memoryPath(id);
  if (!(await files.exists(path))) return [];
  return parseMemory(await files.readText(path).catch(() => ""));
}

/** Adds a session's lines to the room's memory file (created on the first session). */
export async function saveMemory(
  files: WorkspaceFiles,
  id: string,
  date: string,
  lines: readonly string[],
): Promise<void> {
  const entries = withMemory(await memoryOf(files, id), date, lines);
  await files.writeText(memoryPath(id), renderMemory(entries));
}

/** A room as it is handed to the table on entering: the cast that is still there, and its memory. */
export interface RecalledRoom {
  readonly id: string;
  readonly name: string;
  readonly setting: string;
  /** Members still in the team. */
  readonly members: readonly string[];
  /** Members the team no longer has (or has turned off): not seated. */
  readonly absent: readonly string[];
  readonly guests: readonly RoomGuest[];
  readonly remembers: boolean;
  /** The latest lines of memory, short; empty when the room does not remember. */
  readonly memory: readonly string[];
}

/** The room as the table needs it: its cast checked against the team, and a short memory. */
export async function recallRoom(
  files: WorkspaceFiles,
  id: string,
  active: ReadonlySet<string>,
): Promise<{ ok: true; room: RecalledRoom } | { ok: false; problems: readonly string[] }> {
  const read = await readRoom(files, id);
  if (!read.ok) return read;
  const { room } = read;
  return {
    ok: true,
    room: {
      id,
      name: room.name,
      setting: room.setting,
      members: room.members.filter((member) => active.has(member)),
      absent: room.members.filter((member) => !active.has(member)),
      guests: room.guests,
      remembers: room.memory,
      memory: room.memory ? recalledMemory(await memoryOf(files, id)) : [],
    },
  };
}
