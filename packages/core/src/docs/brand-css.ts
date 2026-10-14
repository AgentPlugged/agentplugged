import { isColorName, NEUTRAL_COLOR_WORDS, parseColor, type Rgba } from "./brand-color.js";

/**
 * A small reader of CSS for the fixed rules of the brand, as pure functions. It reads
 * what the rules need and nothing more: for each declaration, the selectors it applies to (nesting
 * and `&` resolved), its property, its value (custom properties `var(--x)` replaced by every value
 * the file gives them) and its line. It is not a CSS engine: it does not run the cascade, and it
 * says so wherever that matters (a colour it cannot read, a rule it cannot place).
 */

export interface Declaration {
  /** The selectors the declaration applies to (one per comma, nesting resolved), possibly none. */
  readonly selectors: readonly string[];
  readonly property: string;
  readonly value: string;
  readonly line: number;
  /** The block the declaration is in: declarations of one block apply to the same elements. */
  readonly block: number;
  /** The conditions (`@media`...) it is under, as written; empty at the top level. */
  readonly context: string;
}

export interface Sheet {
  readonly declarations: Declaration[];
  /** The values given to each custom property (`--accent`), anywhere in the sheet. */
  readonly customs: Map<string, string[]>;
  /** The same values, each with the conditions (`@media`...) it is given under. */
  readonly customEntries: Map<string, { value: string; context: string }[]>;
  /** True when the nesting went deeper than `MAX_NESTING`: what is below was not read. */
  tooDeep: boolean;
}

const MAX_NESTING = 32;
const MAX_SELECTORS = 64;
/** Stands for a list of selectors too long to read: it is never one a rule allows. */
const TOO_MANY = "(too many selectors)";
const MAX_VARIANTS = 16;
const MAX_DEPTH = 6;

/** At-rules whose blocks hold rules like the top level (the condition is not a selector). */
const TRANSPARENT_AT = /^@(?:media|supports|layer|container|scope|document|starting-style)\b/i;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = 0; at < text.length; at += 1) if (text[at] === "\n") starts.push(at + 1);
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** The text with comments blanked out (same length, so offsets stay true). */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** Splits at the top-level commas (not inside parentheses, brackets or strings). */
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? "";
    if (quote !== "") {
      if (char === "\\") at += 1;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, at));
      start = at + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

interface Reader {
  readonly text: string;
  readonly starts: readonly number[];
  readonly base: number;
  readonly out: Declaration[];
  readonly customs: Map<string, string[]>;
  readonly sheet: Sheet;
  block: number;
  at: number;
}

/** Reads up to the next top-level `{`, `;` or `}`; returns it with the text before. */
function readPrelude(reader: Reader): {
  text: string;
  start: number;
  end: string;
} {
  const { text } = reader;
  const start = reader.at;
  let depth = 0;
  let quote = "";
  while (reader.at < text.length) {
    const char = text[reader.at] ?? "";
    if (quote !== "") {
      if (char === "\\") reader.at += 1;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === "{" || char === ";" || char === "}")) {
      const found = text.slice(start, reader.at);
      return { text: found, start, end: char };
    }
    reader.at += 1;
  }
  return { text: text.slice(start), start, end: "" };
}

function joinSelectors(chain: readonly (readonly string[])[]): string[] {
  let combined: string[] = [""];
  for (const level of chain) {
    const next: string[] = [];
    for (const outer of combined) {
      for (const inner of level) {
        next.push(
          outer === ""
            ? inner.replaceAll("&", "")
            : inner.includes("&")
              ? inner.replaceAll("&", outer)
              : `${outer} ${inner}`,
        );
        if (next.length > MAX_SELECTORS) return [TOO_MANY];
      }
    }
    combined = next;
  }
  return combined.filter((selector) => selector.trim() !== "");
}

function readBody(
  reader: Reader,
  chain: readonly (readonly string[])[],
  nested: boolean,
  context: string,
  level: number,
) {
  if (level > MAX_NESTING) {
    // Too deep to be a style sheet: the rest is not read, and the sheet says so.
    reader.sheet.tooDeep = true;
    reader.at = reader.text.length;
    return;
  }
  const block = reader.block++;
  while (reader.at < reader.text.length) {
    const prelude = readPrelude(reader);
    const text = prelude.text.trim();
    if (prelude.end === "}") {
      if (text !== "") addDeclaration(reader, text, prelude.start, chain, block, context);
      reader.at += 1;
      if (nested) return;
      continue;
    }
    if (prelude.end === ";") {
      if (text !== "") addDeclaration(reader, text, prelude.start, chain, block, context);
      reader.at += 1;
      continue;
    }
    if (prelude.end === "") {
      if (text !== "") addDeclaration(reader, text, prelude.start, chain, block, context);
      return;
    }
    // A block opens.
    reader.at += 1;
    if (text.startsWith("@")) {
      const keyframes = /^@(?:-\w+-)?keyframes\b/i.test(text);
      const inner = TRANSPARENT_AT.test(text)
        ? chain
        : [[keyframes ? "@keyframes" : (text.split(/\s/)[0] ?? "@")]];
      const condition = TRANSPARENT_AT.test(text) ? text.replace(/\s+/g, " ") : "";
      readBody(
        reader,
        inner,
        true,
        condition === "" ? context : `${context}${context === "" ? "" : " "}${condition}`,
        level + 1,
      );
    } else {
      readBody(reader, [...chain, splitTop(text, ",")], true, context, level + 1);
    }
  }
}

function addDeclaration(
  reader: Reader,
  text: string,
  start: number,
  chain: readonly (readonly string[])[],
  block: number,
  context: string,
) {
  const colon = text.indexOf(":");
  if (colon <= 0 || text.startsWith("@")) return;
  const property = text.slice(0, colon).trim().toLowerCase();
  if (!/^(?:--[^\s:]+|-?[a-z][a-z0-9-]*)$/.test(property)) return;
  const value = text
    .slice(colon + 1)
    .replace(/!\s*important\s*$/i, "")
    .trim();
  if (property.startsWith("--")) {
    const known = reader.customs.get(property);
    if (known === undefined) reader.customs.set(property, [value]);
    else known.push(value);
    const entry = { value, context };
    const entries = reader.sheet.customEntries.get(property);
    if (entries === undefined) reader.sheet.customEntries.set(property, [entry]);
    else entries.push(entry);
    return;
  }
  const lead = reader.text.slice(start).search(/\S/);
  reader.out.push({
    selectors: joinSelectors(chain),
    property,
    value,
    line: lineAt(reader.starts, reader.base + start + Math.max(0, lead)),
    block,
    context,
  });
}

export function newSheet(): Sheet {
  return {
    declarations: [],
    customs: new Map(),
    customEntries: new Map(),
    tooDeep: false,
  };
}

/** The conditions under which a custom property is given a value, the top level included. */
export function customContexts(sheet: Sheet): string[] {
  const found = new Set<string>([""]);
  for (const entries of sheet.customEntries.values()) {
    for (const entry of entries) found.add(entry.context);
  }
  return [...found];
}

/**
 * The values of the custom properties as they are under one condition: what the condition gives
 * wins over the top level, and a value given only under another condition is not one here.
 */
export function customsIn(sheet: Sheet, context: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [name, entries] of sheet.customEntries) {
    const own = entries.filter((entry) => entry.context === context);
    const chosen = own.length > 0 ? own : entries.filter((entry) => entry.context === "");
    if (chosen.length > 0)
      out.set(
        name,
        chosen.map((entry) => entry.value),
      );
  }
  return out;
}

/** Reads some CSS: `source` is the whole file (for lines), `text` a part of it at `offset`. */
export function readCss(
  source: string,
  text: string,
  offset: number,
  chain: readonly (readonly string[])[] = [],
  sheet?: Sheet,
): Sheet {
  const target: Sheet = sheet ?? newSheet();
  const reader: Reader = {
    text: withoutComments(text),
    starts: lineStarts(source),
    base: offset,
    out: target.declarations,
    customs: target.customs,
    sheet: target,
    block: target.declarations.length === 0 ? 0 : (target.declarations.at(-1)?.block ?? 0) + 1000,
    at: 0,
  };
  readBody(reader, chain, false, "", 0);
  return target;
}

/** The text between the parentheses opened at `open`, and the index after the closing one. */
export function balanced(text: string, open: number): { inner: string; end: number } | undefined {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "(") depth += 1;
    else if (text[at] === ")") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, at), end: at + 1 };
    }
  }
  return undefined;
}

/**
 * The values a declaration can have once every `var(--x)` is replaced by each value the sheet
 * gives it (its fallback when it gives none). More than `MAX_VARIANTS` is cut: the rest is not
 * looked at, and what is cut is `truncated`.
 */
export function valueVariants(
  value: string,
  customs: ReadonlyMap<string, readonly string[]>,
  depth = 0,
): { values: string[]; truncated: boolean } {
  const found = /var\(/i.exec(value);
  if (found === null) return { values: [value], truncated: false };
  if (depth >= MAX_DEPTH) return { values: [value], truncated: false };
  const group = balanced(value, found.index + 3);
  if (group === undefined) return { values: [value], truncated: false };
  const [rawName = "", ...rest] = splitTop(group.inner, ",");
  const name = rawName.trim();
  const fallback = rest.join(",").trim();
  const defined = customs.get(name);
  const options =
    defined !== undefined && defined.length > 0 ? defined : fallback === "" ? [] : [fallback];
  // A custom property nobody defines, with no fallback: the text stays, and is not read.
  if (options.length === 0) return { values: [value], truncated: false };
  const head = value.slice(0, found.index);
  const tail = value.slice(group.end);
  const values: string[] = [];
  let truncated = false;
  for (const option of options) {
    const next = valueVariants(`${head}${option}${tail}`, customs, depth + 1);
    truncated ||= next.truncated;
    for (const item of next.values) {
      if (values.length >= MAX_VARIANTS) truncated = true;
      else values.push(item);
    }
  }
  return { values, truncated };
}

// ---------------------------------------------------------------------------------------------
// Colours in a value
// ---------------------------------------------------------------------------------------------

/** Colour functions that are not read: a rule cannot know what they give. */
const UNREAD_COLOR_FUNCTIONS =
  /\b(?:color-mix|color|lab|lch|oklab|oklch|hwb|light-dark|device-cmyk|contrast-color)\s*\(/i;

/** Properties whose words are not colours (a family named « Orange » is not an orange). */
const NO_WORD_COLORS =
  /^(?:font|font-family|content|quotes|animation|animation-name|transition|transition-property|will-change|grid|grid-template|grid-template-areas|grid-area|list-style|counter-reset|counter-increment|cursor|src|mask|mask-image|display|position|filter)$/;

export interface ColorsFound {
  readonly colors: Rgba[];
  /** What was seen and not read, as written (cut at 40 characters). */
  readonly unread: string[];
}

/** The colours a value spells. `var()` must already be replaced. */
export function colorsIn(value: string, property: string): ColorsFound {
  const colors: Rgba[] = [];
  const unread: string[] = [];
  let text = value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  // url(): an address, not a colour (a page with one is refused anyway).
  text = text.replace(/url\([^)]*\)/gi, " ");
  if (/var\(/i.test(text)) unread.push(text.slice(0, 40));
  const unreadFunction = UNREAD_COLOR_FUNCTIONS.exec(text);
  if (unreadFunction !== null) {
    const group = balanced(text, unreadFunction.index + unreadFunction[0].length - 1);
    unread.push(
      text.slice(unreadFunction.index, group?.end ?? unreadFunction.index + 40).slice(0, 40),
    );
    if (group !== undefined)
      text = text.slice(0, unreadFunction.index) + " " + text.slice(group.end);
  }
  // rgb(), rgba(), hsl(), hsla(): read whole.
  for (;;) {
    const call = /\b(?:rgba?|hsla?)\s*\(/i.exec(text);
    if (call === null) break;
    const group = balanced(text, call.index + call[0].length - 1);
    const spelled =
      group === undefined ? undefined : text.slice(call.index, group.end).replace(/\s+\(/, "(");
    const color = spelled === undefined ? undefined : parseColor(spelled);
    if (color === undefined) unread.push(text.slice(call.index, call.index + 40));
    else colors.push(color);
    text = text.slice(0, call.index) + " " + text.slice(group?.end ?? call.index + call[0].length);
  }
  for (const match of text.matchAll(/#[0-9a-zA-Z]+/g)) {
    const color = /^#[0-9a-fA-F]+$/.test(match[0]) ? parseColor(match[0]) : undefined;
    if (color === undefined) unread.push(match[0].slice(0, 40));
    else colors.push(color);
  }
  if (!NO_WORD_COLORS.test(property)) {
    for (const match of text.replace(/#[0-9a-zA-Z]+/g, " ").matchAll(/[A-Za-z][A-Za-z-]*/g)) {
      const word = match[0].toLowerCase();
      if (NEUTRAL_COLOR_WORDS.has(word)) continue;
      if (isColorName(word)) {
        const color = parseColor(word);
        if (color !== undefined) colors.push(color);
      }
    }
  }
  return { colors, unread };
}

// ---------------------------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------------------------

/** Tags are not case-sensitive, classes and identifiers are. */
const caseOf = (token: string) => (/^[.#]/.test(token) ? token : token.toLowerCase());

/**
 * The simple selectors of the subject of a selector (its last compound: what the declaration
 * styles), as `.class`, `#id` or `tag`. What is inside parentheses, brackets and after a colon is
 * dropped (`:not(.cta)` does not make an element a `.cta`).
 */
export function subjectTokens(selector: string): string[] {
  let text = selector;
  for (let pass = 0; pass < 4 && /\([^()]*\)/.test(text); pass += 1) {
    text = text.replace(/\([^()]*\)/g, "");
  }
  text = text.replace(/\[[^\]]*\]/g, "").replace(/::?[A-Za-z-]+/g, "");
  const subject =
    text
      .trim()
      .split(/\s*[>+~]\s*|\s+/)
      .filter((part) => part !== "")
      .at(-1) ?? "";
  return [...subject.matchAll(/[.#]?[A-Za-z_][\w-]*/g)].map((match) => match[0].toLowerCase());
}

/** True when the subject of the selector is one of the `only` simple selectors. */
export function selectorIn(selector: string, only: readonly string[]): boolean {
  const allowed = new Set(only.map(caseOf));
  return subjectTokens(selector).some((token) => allowed.has(token));
}

// ---------------------------------------------------------------------------------------------
// HTML: the styles of a page
// ---------------------------------------------------------------------------------------------

/** Presentation attributes of SVG that hold a colour. */
const PAINT_ATTRIBUTES = ["fill", "stroke", "stop-color", "color", "flood-color"] as const;

const ELEMENT =
  /<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** The style of a page: the sheet of its `<style>` blocks and of its inline `style` attributes. */
export function readHtmlStyles(html: string): Sheet {
  const sheet: Sheet = newSheet();
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const body = style[1] ?? "";
    const start = (style.index ?? 0) + style[0].indexOf(body);
    readCss(html, body, start, [], sheet);
  }
  const starts = lineStarts(html);
  const withoutStyles = html.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, (block) =>
    block.replace(/[^\n]/g, " "),
  );
  let inline = 0;
  for (const element of withoutStyles.matchAll(ELEMENT)) {
    const tag = (element[1] ?? "").toLowerCase();
    const attributes = new Map<string, string>();
    for (const attribute of (element[2] ?? "").matchAll(ATTRIBUTE)) {
      attributes.set(
        (attribute[1] ?? "").toLowerCase(),
        attribute[2] ?? attribute[3] ?? attribute[4] ?? "",
      );
    }
    const classes = (attributes.get("class") ?? "").split(/\s+/).filter((name) => name !== "");
    const id = attributes.get("id");
    const subject = `${tag}${classes.map((name) => `.${name}`).join("")}${id === undefined || id === "" ? "" : `#${id}`}`;
    const at = element.index ?? 0;
    const style = attributes.get("style");
    if (style !== undefined) {
      const offset = at + element[0].indexOf(style);
      const part = readCss(html, style, offset, [[subject]]);
      for (const declaration of part.declarations) {
        sheet.declarations.push({ ...declaration, block: 100_000 + inline });
      }
      sheet.tooDeep ||= part.tooDeep;
      inline += 1;
    }
    for (const name of PAINT_ATTRIBUTES) {
      const value = attributes.get(name);
      if (value === undefined) continue;
      sheet.declarations.push({
        selectors: [subject],
        property: name === "color" ? "color" : name,
        value,
        line: lineAt(starts, at),
        block: 200_000 + at,
        context: "",
      });
    }
    // An SVG gradient is a gradient: it is seen as one, wherever the page draws it.
    if (tag === "lineargradient" || tag === "radialgradient") {
      sheet.declarations.push({
        selectors: [subject],
        property: "background-image",
        value: `svg-${tag === "lineargradient" ? "linear" : "radial"}-gradient()`,
        line: lineAt(starts, at),
        block: 300_000 + at,
        context: "",
      });
    }
  }
  return sheet;
}
