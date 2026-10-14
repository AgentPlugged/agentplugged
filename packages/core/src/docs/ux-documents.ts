import { utf8 } from "@agentplugged/crypto";
import {
  STORY_SECTIONS,
  UX_ELEMENT_PATTERN,
  UX_KEY_SCREENS,
  UX_MOCKUP_DIR,
  UX_MOCKUP_FILE,
  UX_MOCKUP_MAX_BYTES,
  UX_MOCKUP_MAX_FILES,
  UX_SECTIONS,
  UX_SYSTEM_GROUP,
  UX_TABLES_ONLY,
  UX_TOKEN_GROUPS,
} from "@agentplugged/protocol";
import { normalizeText, splitFrontmatter } from "../init/generated.js";
import { METHOD_DIR } from "../init/layout.js";
import type { DocsProblem, DocsWarning } from "./docs-base.js";
import { pathKey } from "./knowledge-freshness.js";
import { invalid, type LaunchCheck } from "./launch-documents.js";
import { type ParsedDocument, type Section, tableCells } from "./parse-document.js";
import { storiesOf, warning } from "./story-rules.js";
import { mockupFaults } from "./ux-mockup.js";

/**
 * The visual part of the UX specification, as pure functions: the design tokens of
 * its header and the `{token}` it uses, the elements `UX-n` that stories carry, the key screens
 * with their sketch and their mock-up page, and the pages themselves (size, and the rules of
 * `ux-mockup.ts`). The specification wins over a page: `docs check` only verifies that a page
 * exists, stands alone and is safe, never that it matches the text, which is the reader's call.
 * Everything here is optional for a specification written before: a rule applies when the part it
 * guards is there (a `tokens` block, a key screens table, an element table).
 */

/** The specification and the folder of its pages. */
export const UX_PATH = `${METHOD_DIR}/docs/ux.md`;
export const UX_MOCKUP_PATH = `${METHOD_DIR}/docs/${UX_MOCKUP_DIR}/`;

export interface UxCheckInput {
  readonly documents: readonly ParsedDocument[];
  readonly textOf: (path: string) => string | undefined;
  /**
   * The pages of `ux-mockups/` by path. Absent when the caller did not read them: the existence
   * of a page and the pages themselves are then not checked.
   */
  readonly mockups?: ReadonlyMap<string, string> | undefined;
  /** The tokens of the brand identity, by path: the specification may use them by name. */
  readonly brandTokens?: ReadonlyMap<string, string> | undefined;
}

export type UxCheck = LaunchCheck;

interface BodyLine {
  readonly line: number;
  readonly text: string;
  /** Inside a code fence. */
  readonly fenced: boolean;
}

/** The lines of the body that are not a comment, with their line in the file and their fence. */
function bodyLines(raw: string): BodyLine[] {
  const text = normalizeText(raw).normalize("NFC");
  const parts = splitFrontmatter(text);
  const first = parts === undefined ? 1 : 3 + parts.yaml.split("\n").length - 1;
  const lines: BodyLine[] = [];
  let fence: string | undefined;
  let comment = false;
  (parts?.body ?? text).split("\n").forEach((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      lines.push({ line: first + index, text: line, fenced: true });
      return;
    }
    if (marker !== undefined) {
      fence = marker;
      lines.push({ line: first + index, text: line, fenced: true });
      return;
    }
    // A comment is not part of the specification: what is outside it stays.
    let visible = "";
    let at = 0;
    while (at < line.length) {
      if (comment) {
        const end = line.indexOf("-->", at);
        if (end === -1) at = line.length;
        else {
          comment = false;
          at = end + 3;
        }
      } else {
        const start = line.indexOf("<!--", at);
        visible += line.slice(at, start === -1 ? line.length : start);
        if (start === -1) at = line.length;
        else {
          comment = true;
          at = start + 4;
        }
      }
    }
    lines.push({ line: first + index, text: visible, fenced: false });
  });
  return inlineReferences(lines);
}

const REFERENCE_DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/;
const REFERENCE_LINK = /\[([^\]]*)\]\[([^\]]*)\]/g;

/** `[text][id]` with its `[id]: target` line read as `[text](target)`: one way to find a link. */
function inlineReferences(lines: BodyLine[]): BodyLine[] {
  const targets = new Map<string, string>();
  for (const entry of lines) {
    const found = entry.fenced ? null : REFERENCE_DEFINITION.exec(entry.text);
    if (found !== null) targets.set((found[1] ?? "").toLowerCase(), found[2] ?? "");
  }
  if (targets.size === 0) return lines;
  return lines.map((entry) =>
    entry.fenced
      ? entry
      : {
          ...entry,
          text: entry.text.replace(REFERENCE_LINK, (whole, text: string, id: string) => {
            const target = targets.get((id === "" ? text : id).toLowerCase());
            return target === undefined ? whole : `[${text}](${target})`;
          }),
        },
  );
}

const plainName = (cell: string) =>
  cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const keyOf = (name: string) => plainName(name).toLowerCase();
const isPlaceholder = (name: string) => /^<[^>]*>$/.test(plainName(name)) || plainName(name) === "";

const SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** The data rows of the tables of some lines (the header and the separator of each left out). */
function tableRows(lines: readonly BodyLine[]): Array<{ line: number; cells: string[] }> {
  const rows: Array<{ line: number; cells: string[]; separator: boolean }> = [];
  for (const entry of lines) {
    if (entry.fenced) continue;
    if (!/^\s*\|/.test(entry.text)) {
      rows.push({ line: entry.line, cells: [], separator: false });
      continue;
    }
    rows.push({
      line: entry.line,
      cells: tableCells(entry.text),
      separator: SEPARATOR.test(entry.text),
    });
  }
  const data: Array<{ line: number; cells: string[] }> = [];
  rows.forEach((row, index) => {
    if (row.cells.length === 0 || row.separator) return;
    // The row above a separator is a header.
    if (rows[index + 1]?.separator === true) return;
    data.push({ line: row.line, cells: row.cells });
  });
  return data;
}

function sectionLines(all: readonly BodyLine[], section: Section): BodyLine[] {
  return all.filter(
    (entry) => entry.line > section.line && entry.line <= section.line + section.lines.length,
  );
}

function sectionOf(document: ParsedDocument, titles: readonly string[]): Section | undefined {
  return document.sections.find((section) => titles.includes(section.title));
}

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const REFERENCE = /^\{([a-z]+(?:\.[A-Za-z0-9_-]+)+)\}$/;
const MAX_DEPTH = 4;
const GROUPS: readonly string[] = UX_TOKEN_GROUPS;

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface Tokens {
  /** Every path that is a token or the start of one (`color`, `color.primary`, `color.primary.dark`). */
  readonly defined: Set<string>;
  /** References that tokens make to other tokens. */
  readonly aliases: string[];
  readonly problems: Array<{ detail: string }>;
}

function walkTokens(group: string, node: unknown, path: string, depth: number, out: Tokens) {
  out.defined.add(path);
  if (isMap(node)) {
    if (depth >= MAX_DEPTH) {
      out.problems.push({ detail: `${path}: too deep` });
      return;
    }
    const entries = Object.entries(node);
    if (entries.length === 0) out.problems.push({ detail: `${path}: empty` });
    for (const [key, value] of entries) {
      if (!KEY.test(key)) out.problems.push({ detail: `${path}: key ${key.slice(0, 30)}` });
      else walkTokens(group, value, `${path}.${key}`, depth + 1, out);
    }
    return;
  }
  const alias = typeof node === "string" ? REFERENCE.exec(node.trim())?.[1] : undefined;
  if (alias !== undefined) {
    out.aliases.push(alias);
    return;
  }
  if (group === "color") {
    if (typeof node !== "string" || !HEX.test(node)) {
      out.problems.push({ detail: `${path}: not a hexadecimal colour` });
    }
    return;
  }
  const scalar =
    (typeof node === "string" && node.trim() !== "" && !/[\n<>]/.test(node)) ||
    (typeof node === "number" && Number.isFinite(node));
  if (!scalar) out.problems.push({ detail: `${path}: not a value` });
}

export function readTokens(raw: unknown): Tokens {
  const out: Tokens = { defined: new Set(), aliases: [], problems: [] };
  if (!isMap(raw)) {
    out.problems.push({ detail: "tokens: expected groups" });
    return out;
  }
  for (const [group, node] of Object.entries(raw)) {
    if (!GROUPS.includes(group)) {
      out.problems.push({ detail: `group ${group.slice(0, 30)}` });
    } else if (!isMap(node)) {
      out.problems.push({ detail: `${group}: expected a map` });
    } else {
      walkTokens(group, node, group, 0, out);
    }
  }
  return out;
}

/** A specification written before the header held the tokens defined them in tables (`color.primary`, bold or bare). */
function legacyTokens(lines: readonly BodyLine[]): string[] {
  const names: string[] = [];
  for (const row of tableRows(lines)) {
    const name = /^[*`]*([a-z]+(?:\.[A-Za-z0-9_-]+)+)[*`]*$/.exec((row.cells[0] ?? "").trim())?.[1];
    if (name !== undefined && GROUPS.includes(name.slice(0, name.indexOf(".")))) names.push(name);
  }
  return names;
}

const USED_TOKEN = /\{((?:color|type|space|radius|shadow|ui)(?:\.[A-Za-z0-9_-]+)+)\}/g;

function tokenProblems(
  document: ParsedDocument,
  lines: readonly BodyLine[],
  brandTokens: ReadonlyMap<string, string> | undefined,
): DocsProblem[] {
  const { path } = document;
  const problems: DocsProblem[] = [];
  const block = document.tokens;
  const tokens: Tokens =
    block === undefined
      ? { defined: new Set(), aliases: [], problems: [] }
      : readTokens(block.value);
  for (const found of tokens.problems.slice(0, 3)) {
    problems.push(
      invalid(path, block?.line ?? 1, "ux_tokens", { field: "tokens", detail: found.detail }),
    );
  }
  for (const name of [...legacyTokens(lines), ...(brandTokens?.keys() ?? [])]) {
    const parts = name.split(".");
    for (let end = 1; end <= parts.length; end += 1)
      tokens.defined.add(parts.slice(0, end).join("."));
  }
  const system = document.ui_system?.value;
  const declared = typeof system === "string" && system.trim() !== "";
  const known = (token: string) =>
    token.startsWith(`${UX_SYSTEM_GROUP}.`) ? declared : tokens.defined.has(token);
  const reported = new Set<string>();
  const undefinedToken = (token: string, line: number) => {
    if (known(token) || reported.has(token)) return;
    reported.add(token);
    problems.push(invalid(path, line, "ux_token_undefined", { token }));
  };
  for (const alias of tokens.aliases) undefinedToken(alias, block?.line ?? 1);
  for (const entry of lines) {
    if (entry.fenced) continue;
    for (const match of entry.text.matchAll(USED_TOKEN)) undefinedToken(match[1] ?? "", entry.line);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Elements UX-n
// ---------------------------------------------------------------------------------------------

/** An element of the specification that a story must carry. */
export interface UxElement {
  readonly id: string;
  readonly line: number;
  readonly retired: boolean;
}

/** The elements a specification defines: table rows whose first cell is `UX-n`. */
export function uxElementsOf(raw: string): UxElement[] {
  const elements: UxElement[] = [];
  for (const row of tableRows(bodyLines(raw))) {
    const id = plainName(row.cells[0] ?? "");
    if (!UX_ELEMENT_PATTERN.test(id)) continue;
    elements.push({
      id,
      line: row.line,
      retired: row.cells.slice(1).some((cell) => /^\s*(?:\((?:retired|retirée)\)|~~)/i.test(cell)),
    });
  }
  return elements;
}

function elementProblems(document: ParsedDocument, elements: readonly UxElement[]): DocsProblem[] {
  const seen = new Map<string, number>();
  const problems: DocsProblem[] = [];
  for (const element of elements) {
    const first = seen.get(element.id);
    if (first === undefined) seen.set(element.id, element.line);
    else
      problems.push(
        invalid(document.path, element.line, "ux_element_duplicate", { id: element.id, first }),
      );
  }
  return problems;
}

const STORY_PLACES: readonly string[] = [
  ...STORY_SECTIONS.context,
  ...STORY_SECTIONS.acceptance_criteria,
];

/**
 * Every active element must be carried by a story, once at least one exists: named in its
 * `Context` or its `Acceptance criteria` (not in `Out of scope`, which says it is not done).
 */
function coverageProblems(
  documents: readonly ParsedDocument[],
  ux: ParsedDocument,
  elements: readonly UxElement[],
): DocsProblem[] {
  const stories = storiesOf(documents);
  if (stories.size === 0 || elements.length === 0) return [];
  const carried = [...stories.values()].flatMap((story) =>
    story.sections
      .filter((section) => STORY_PLACES.includes(section.title))
      .flatMap((section) => section.lines),
  );
  const text = carried.join("\n");
  const problems: DocsProblem[] = [];
  const reported = new Set<string>();
  for (const element of elements) {
    if (element.retired || reported.has(element.id)) continue;
    if (new RegExp(`(?<![\\w-])${element.id}(?!\\d)`).test(text)) continue;
    reported.add(element.id);
    problems.push(invalid(ux.path, element.line, "ux_element_uncovered", { id: element.id }));
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Key screens, sketches, pages
// ---------------------------------------------------------------------------------------------

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const STRICT_TARGET = new RegExp(`^${UX_MOCKUP_DIR}/[a-z0-9]+(?:-[a-z0-9]+)*\\.html$`);

/** A link of the specification that points to a page: its target, as written, and its line. */
function pageLinks(lines: readonly BodyLine[]): Array<{ target: string; line: number }> {
  const links: Array<{ target: string; line: number }> = [];
  for (const entry of lines) {
    if (entry.fenced) continue;
    for (const match of entry.text.matchAll(LINK)) {
      const target = (match[1] ?? "").split(/[#?]/)[0] ?? "";
      if (SCHEME.test(target)) continue;
      if (/\.html?$/i.test(target) || target.includes(`${UX_MOCKUP_DIR}/`)) {
        links.push({ target, line: entry.line });
      }
    }
  }
  return links;
}

interface Screen {
  readonly name: string;
  readonly line: number;
  readonly cells: readonly string[];
}

function screensOf(
  document: ParsedDocument,
  all: readonly BodyLine[],
  titles: readonly string[],
): { found: boolean; screens: Screen[] } {
  const section = sectionOf(document, titles);
  if (section === undefined) return { found: false, screens: [] };
  const screens = tableRows(sectionLines(all, section))
    .filter((row) => !isPlaceholder(row.cells[0] ?? ""))
    .map((row) => ({ name: plainName(row.cells[0] ?? ""), line: row.line, cells: row.cells }));
  return { found: true, screens };
}

function sketchProblems(
  document: ParsedDocument,
  all: readonly BodyLine[],
  wanted: readonly Screen[],
): DocsProblem[] {
  const section = sectionOf(document, UX_SECTIONS.sketches);
  const subsections = new Map<string, BodyLine[]>();
  if (section !== undefined) {
    let current: BodyLine[] | undefined;
    for (const entry of sectionLines(all, section)) {
      const heading = entry.fenced ? null : /^ {0,3}###\s+(.+?)\s*#*\s*$/.exec(entry.text);
      if (heading !== null) {
        current = [];
        subsections.set(keyOf(heading[1] ?? ""), current);
      } else current?.push(entry);
    }
  }
  const problems: DocsProblem[] = [];
  for (const screen of wanted) {
    const lines = subsections.get(keyOf(screen.name));
    if (lines === undefined) {
      problems.push(
        invalid(document.path, screen.line, "ux_sketch", {
          screen: screen.name,
          problem: "missing",
        }),
      );
      continue;
    }
    const drawing = lines
      .filter((entry) => entry.fenced)
      .map((entry) => entry.text)
      .join("\n");
    const regions = lines
      .filter((entry) => !entry.fenced)
      .flatMap((entry) => /^(\d{1,2})[.)]\s+\S/.exec(entry.text)?.[1] ?? [])
      .map(Number);
    const ordered = regions.every((number, index) => number === index + 1);
    const marks = [...drawing.matchAll(/\[(\d{1,2})\]/g)].map((match) => Number(match[1]));
    const drawn =
      regions.every((number) => marks.includes(number)) &&
      marks.every((number) => regions.includes(number));
    const problem =
      drawing.trim() === ""
        ? "drawing"
        : regions.length < 2 || !ordered
          ? "regions"
          : drawn
            ? undefined
            : "marks";
    if (problem !== undefined) {
      problems.push(
        invalid(document.path, screen.line, "ux_sketch", {
          screen: screen.name,
          problem,
          regions: regions.length,
        }),
      );
    }
  }
  return problems;
}

const bytesOf = (text: string) => utf8(text).length;

function pageChecks(mockups: ReadonlyMap<string, string>, linked: ReadonlySet<string>): UxCheck {
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  const paths = [...mockups.keys()].sort();
  if (paths.length > UX_MOCKUP_MAX_FILES) {
    problems.push(
      invalid(UX_MOCKUP_PATH, 1, "ux_mockup_size", {
        field: "files",
        found: paths.length,
        max: UX_MOCKUP_MAX_FILES,
      }),
    );
  }
  for (const path of paths) {
    const html = mockups.get(path) ?? "";
    const name = path.slice(UX_MOCKUP_PATH.length);
    if (!UX_MOCKUP_FILE.test(name) || html.trim() === "") {
      problems.push(invalid(path, 1, "ux_mockup_path", { target: name.slice(0, 60) }));
      continue;
    }
    const bytes = bytesOf(html);
    if (bytes > UX_MOCKUP_MAX_BYTES) {
      problems.push(
        invalid(path, 1, "ux_mockup_size", {
          field: "bytes",
          found: bytes,
          max: UX_MOCKUP_MAX_BYTES,
        }),
      );
      continue;
    }
    const fault = mockupFaults(html)[0];
    if (fault !== undefined) {
      problems.push(
        invalid(path, 1, "ux_mockup_unsafe", { problem: fault.problem, detail: fault.detail }),
      );
    }
    if (!linked.has(path)) warnings.push(warning("ux_mockup_orphan", { path }));
  }
  return { problems, warnings };
}

/**
 * The rules of the UX specification's visual part. A specification with none of the parts they
 * read (no `tokens`, no key screens, no element) passes untouched.
 */
export function uxDocumentChecks(input: UxCheckInput): UxCheck {
  const ux = input.documents.find(
    (document) => pathKey(document.path) === UX_PATH && document.kind?.value === "ux",
  );
  const raw = ux === undefined ? undefined : input.textOf(ux.path);
  if (ux === undefined || raw === undefined) return { problems: [], warnings: [] };
  const all = bodyLines(raw);
  const problems = tokenProblems(ux, all, input.brandTokens);
  const warnings: DocsWarning[] = [];
  const elements = uxElementsOf(raw);
  problems.push(
    ...elementProblems(ux, elements),
    ...coverageProblems(input.documents, ux, elements),
  );

  // Links to pages: inside the folder, flat, and existing when the pages were read.
  const linked = new Set<string>();
  for (const link of pageLinks(all)) {
    if (!STRICT_TARGET.test(link.target)) {
      problems.push(
        invalid(ux.path, link.line, "ux_mockup_path", { target: link.target.slice(0, 60) }),
      );
      continue;
    }
    const path = `${METHOD_DIR}/docs/${link.target}`;
    linked.add(path);
    if (input.mockups !== undefined && !input.mockups.has(path)) {
      problems.push(invalid(ux.path, link.line, "ux_mockup_missing", { target: link.target }));
    }
  }

  // Key screens: a page each, or the creator's word that the tables stand alone; and a sketch.
  const keyScreens = screensOf(ux, all, UX_SECTIONS.key_screens);
  for (const screen of keyScreens.screens) {
    const row = all.find((entry) => entry.line === screen.line)?.text ?? "";
    if (pageLinks([{ line: screen.line, text: row, fenced: false }]).length > 0) continue;
    if (UX_TABLES_ONLY.test(plainName(screen.cells[1] ?? ""))) {
      warnings.push(
        warning("ux_screen_tables_only", { path: ux.path, line: screen.line, screen: screen.name }),
      );
    } else {
      problems.push(invalid(ux.path, screen.line, "ux_screen_unmocked", { screen: screen.name }));
    }
  }
  const count = keyScreens.screens.length;
  if (keyScreens.found && (count < UX_KEY_SCREENS.min || count > UX_KEY_SCREENS.max)) {
    warnings.push(
      warning("ux_key_screens_count", {
        path: ux.path,
        count,
        min: UX_KEY_SCREENS.min,
        max: UX_KEY_SCREENS.max,
      }),
    );
  }
  const sketched = sectionOf(ux, UX_SECTIONS.sketches) !== undefined;
  const architecture = sketched ? screensOf(ux, all, UX_SECTIONS.architecture).screens : [];
  const wanted = [...keyScreens.screens, ...architecture].filter(
    (screen, index, list) =>
      list.findIndex((other) => keyOf(other.name) === keyOf(screen.name)) === index,
  );
  problems.push(...sketchProblems(ux, all, wanted));

  if (input.mockups !== undefined) {
    const pages = pageChecks(input.mockups, linked);
    problems.push(...pages.problems);
    warnings.push(...pages.warnings);
  }
  return { problems, warnings };
}
