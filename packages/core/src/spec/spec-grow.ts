import { parse, stringify } from "yaml";
import type { ParsedDocument } from "../docs/parse-document.js";
import type { SpecCounts } from "./path-rules.js";

/**
 * Carrying a spec over to the full path, pure: the spec becomes the base of the
 * brief, the PRD and the architecture without the creator retyping a line. Every part of the spec
 * starts with a marker (`<!-- part: brief|requirements|decisions|stories -->`, placed before its
 * heading, the heading itself being the creator's words in their language). The text of a part
 * moves as it is, identifiers included, to the document that owns it; nothing is reworded.
 */

export const SPEC_PATH = ".agentplugged/docs/spec.md";
export const GROWN_PATHS = {
  brief: ".agentplugged/docs/brief.md",
  prd: ".agentplugged/docs/prd.md",
  architecture: ".agentplugged/docs/architecture.md",
} as const;

const PART_MARKER = /^<!--\s*part:\s*(brief|requirements|decisions|stories)\s*-->\s*$/;
const HEADER = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
/** A story of the spec's list: `- 1-2 : title`, an item opening with a story id. */
const STORY_ITEM = /^\s*(?:[-*+]|\d+\.)\s+[*`]*\d{1,6}-\d{1,6}[*`]*\s*[:—–-]/;
/** The header keys that belong to the architecture once the spec is carried over. */
const ARCHITECTURE_KEYS = ["dependencies", "prerequisites"] as const;
/** The header keys the spec owns or the new documents rebuild; the others (`important`, `sources`…) go to the brief. */
const SPEC_KEYS = [
  "id",
  "kind",
  "owner",
  "links",
  "size",
  "users",
  "sensitive",
  "integrations",
  "platforms",
  "asked",
  ...ARCHITECTURE_KEYS,
];

type Part = "preamble" | "brief" | "requirements" | "decisions" | "stories";

/** The documents the spec becomes, as text; or why it cannot be carried over. */
export type Grown =
  | { readonly ok: true; readonly documents: Readonly<Record<keyof typeof GROWN_PATHS, string>> }
  | { readonly ok: false; readonly reason: "header" | "parts" };

const lines = (text: string) => text.replace(/\r\n/g, "\n");

/** What a spec holds, counted, from its parsed form and its text. */
export function countSpec(document: ParsedDocument, text: string): SpecCounts {
  return {
    requirements: document.definitions.filter(
      (definition) => definition.id.startsWith("EF-") && !definition.retired,
    ).length,
    stories: lines(text)
      .split("\n")
      .filter((line) => STORY_ITEM.test(line)).length,
  };
}

function document(
  header: Record<string, unknown>,
  body: readonly string[],
  extra: Record<string, unknown> = {},
): string {
  const text = body.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  return `---\n${stringify({ ...header, ...extra }).trimEnd()}\n---\n${text === "" ? "" : `${text}\n`}`;
}

/**
 * The brief, the PRD and the architecture a spec becomes. The brief takes the opening of the spec,
 * its brief part and its list of stories (nothing is lost); the PRD takes the requirements, the
 * architecture the decisions, and the dependencies and prerequisites the spec's header declares.
 */
export function growSpec(source: string): Grown {
  const text = lines(source);
  const match = HEADER.exec(text);
  if (match === null) return { ok: false, reason: "header" };
  let raw: unknown;
  try {
    raw = parse(match[1] ?? "");
  } catch {
    return { ok: false, reason: "header" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "header" };
  }
  const header = raw as Record<string, unknown>;
  const parts: Record<Part, string[]> = {
    preamble: [],
    brief: [],
    requirements: [],
    decisions: [],
    stories: [],
  };
  let current: Part = "preamble";
  let marked = 0;
  for (const line of text.slice(match[0].length).split("\n")) {
    const marker = PART_MARKER.exec(line);
    if (marker !== null) {
      current = marker[1] as Part;
      marked += 1;
    } else {
      parts[current].push(line);
    }
  }
  if (marked === 0) return { ok: false, reason: "parts" };
  const kept = Object.fromEntries(
    Object.entries(header).filter(([key]) => !SPEC_KEYS.includes(key)),
  );
  const owned = Object.fromEntries(
    ARCHITECTURE_KEYS.filter((key) => header[key] !== undefined).map((key) => [key, header[key]]),
  );
  return {
    ok: true,
    documents: {
      brief: document(
        { id: "brief", kind: "brief", owner: "iris", links: [] },
        [...parts.preamble, ...parts.brief, ...parts.stories],
        kept,
      ),
      prd: document(
        { id: "prd", kind: "prd", owner: "maya", links: ["brief"] },
        parts.requirements,
      ),
      architecture: document(
        { id: "architecture", kind: "architecture", owner: "alex", links: ["prd"] },
        parts.decisions,
        owned,
      ),
    },
  };
}
