import { sha256, toBase64url, utf8 } from "@agentplugged/crypto";
import { DECK_SLIDE_TITLE } from "@agentplugged/protocol";
import { normalizeText, splitFrontmatter } from "../init/generated.js";
import { DECK_PAGE_LABELS, DECK_PAGE_SCRIPT, DECK_PAGE_STYLE } from "./deck-page-assets.js";
import { visibleText } from "./launch-documents.js";
import { parseDocumentFile, tableCells } from "./parse-document.js";
import { slideParts } from "./pitch-documents.js";

/**
 * The deck drawn: from the Markdown of a deck, one page of HTML that stands alone
 * (style and script inline, no network resource, nothing to install), one slide per screen,
 * keyboard navigation, the notes of the speaker on a key, printing to PDF by the browser, light
 * and dark. A pure function: the same deck gives the same page, and the text of the deck is never
 * changed, only put in markup.
 *
 * The one rule that matters: the deck is a text from outside the page. Every character of it goes
 * through `escapeHtml` before it reaches the markup, the Markdown it understands is a short list
 * (emphasis, code, links to http(s), lists, tables, quotes), anything else, raw HTML included, is
 * shown as the text it is. The page carries a content security policy that allows only its own
 * inline script (by its hash) and style: if a hole were ever found in the escaping, the browser
 * would still refuse a script it does not know.
 */

/** The text of a deck as a page, with what the page holds. */
export interface DeckPage {
  readonly html: string;
  readonly slides: number;
  /** The slides that carry notes. */
  readonly notes: number;
  /**
   * What of the file is not a slide, so not on the page: the sections that are not `Slide n` and
   * the text before the first one (as `(intro)`). Said to the creator, never dropped in silence.
   */
  readonly notDrawn: readonly string[];
}

/** Text as it may stand in the content or in a quoted attribute of the page. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Control characters out (the one reserved below included), tabs and new lines kept. */
function clean(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove them.
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

const MARK = "\u0000";
const TOKEN = new RegExp(`${MARK}(\\d+)${MARK}`, "g");

/** Bold and italic, on text that is already escaped and holds no link nor code (those are tokens). */
function emphasis(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?![_\w])/g, "$1<em>$2</em>");
}

/**
 * A line of text as inline markup: code, links, emphasis. Everything else is plain text. Code and
 * links are set aside as tokens while the emphasis is applied, so that a mark inside an address
 * never reaches it, and put back at the end.
 */
export function inlineHtml(raw: string): string {
  const store: string[] = [];
  // What each token stood for as written: an address keeps its backticks, they are not code there.
  const written: string[] = [];
  const keep = (html: string, source = html) => {
    store.push(html);
    written.push(source);
    return `${MARK}${store.length - 1}${MARK}`;
  };
  const address = (url: string) =>
    url.replace(TOKEN, (_, index: string) => written[Number(index)] ?? "");
  let text = escapeHtml(clean(raw)).replace(/`([^`]+)`/g, (_, code: string) =>
    keep(`<code>${code}</code>`, `\`${code}\``),
  );
  // An image is its description and its address, as text: nothing is fetched, nothing is lost.
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]*)\)/g, (_, alt: string, url: string) =>
    url === "" ? alt : `${alt} (${keep(address(url))})`,
  );
  // A link is a link only to http(s); otherwise it is its text and its address, as text.
  text = text.replace(/\[([^\]]+)\]\(([^)\s]*)\)/g, (_, label: string, found: string) => {
    const url = address(found);
    return /^https?:\/\/[^\s]+$/i.test(url)
      ? keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${emphasis(label)}</a>`)
      : `${label} (${keep(url)})`;
  });
  const restore = (html: string): string =>
    html.replace(TOKEN, (_, index: string) => restore(store[Number(index)] ?? ""));
  return restore(emphasis(text));
}

/** The plain text of a line: emphasis and code marks out (for text drawn in a figure). */
function plain(raw: string): string {
  return clean(raw)
    .replace(/\*+|`+|__/g, "")
    .trim();
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "table"; rows: string[][]; header: boolean }
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "visual"; text: string };

const VISUAL_LINE = /^\s*(?:[>*-]\s+)?\**\s*(?:visual|visuel)\s*\**\s*:\s*\**\s*(.*)$/i;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

/** True when `line` closes the fence `open` (same character, at least as long). */
function closesFence(open: string, line: string): boolean {
  const marker = FENCE_LINE.exec(line)?.[1] ?? "";
  return marker[0] === open[0] && marker.length >= open.length;
}

const GONE = "\u0001";

/**
 * The lines without their HTML comments: a comment that closes, over one line or several, outside
 * code (a fence, a span of code). A line that was only a comment leaves nothing, not a blank line in
 * the middle of a block. A comment left open is text, and shown as such: nothing of the deck is
 * dropped for a mark it did not close.
 */
function withoutComments(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let chunk: string[] = [];
  const flush = () => {
    const text = chunk
      .join("\n")
      .replace(/(`+[^`\n]*`+)|<!--[\s\S]*?-->/g, (match, code?: string) =>
        code === undefined ? match.replace(/[^\n]+/g, GONE) : code,
      );
    for (const line of text.split("\n")) {
      if (line.includes(GONE) && line.replaceAll(GONE, "").trim() === "") continue;
      kept.push(line.replaceAll(GONE, ""));
    }
    chunk = [];
  };
  let open: string | undefined;
  for (const raw of lines) {
    const line = raw.replaceAll(GONE, "");
    if (open !== undefined) {
      kept.push(line);
      if (closesFence(open, line)) open = undefined;
    } else if (FENCE_LINE.test(line)) {
      flush();
      kept.push(line);
      open = FENCE_LINE.exec(line)?.[1];
    } else {
      chunk.push(line);
    }
  }
  flush();
  return kept;
}

/** The lines of a slide as blocks. */
function blocksOf(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  const source = withoutComments(lines);
  let at = 0;
  const startsBlock = (line: string) =>
    /^\s*(?:#{1,6}\s|>|\|)/.test(line) ||
    FENCE_LINE.test(line) ||
    LIST_ITEM.test(line) ||
    VISUAL_LINE.test(line);
  while (at < source.length) {
    const line = source[at] ?? "";
    if (line.trim() === "") {
      at += 1;
    } else if (FENCE_LINE.test(line)) {
      const open = FENCE_LINE.exec(line)?.[1] ?? "```";
      const code: string[] = [];
      at += 1;
      while (at < source.length && !closesFence(open, source[at] ?? "")) {
        code.push(source[at] ?? "");
        at += 1;
      }
      at += 1;
      blocks.push({ kind: "code", text: code.join("\n") });
    } else if (/^\s*#{1,6}\s/.test(line)) {
      const marks = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      blocks.push({
        kind: "heading",
        level: Math.min(6, Math.max(3, marks?.[1]?.length ?? 3)),
        text: (marks?.[2] ?? "").replace(/\s+#+\s*$/, ""),
      });
      at += 1;
    } else if (VISUAL_LINE.test(line)) {
      blocks.push({ kind: "visual", text: (VISUAL_LINE.exec(line)?.[1] ?? "").trim() });
      at += 1;
    } else if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (at < source.length && /^\s*>/.test(source[at] ?? "")) {
        quoted.push((source[at] ?? "").replace(/^\s*>\s?/, ""));
        at += 1;
      }
      blocks.push({ kind: "quote", lines: quoted });
    } else if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      let header = false;
      while (at < source.length && /^\s*\|/.test(source[at] ?? "")) {
        const row = source[at] ?? "";
        if (TABLE_SEPARATOR.test(row) && rows.length === 1) header = true;
        else if (!TABLE_SEPARATOR.test(row)) rows.push(tableCells(row));
        at += 1;
      }
      blocks.push({ kind: "table", rows, header });
    } else if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (at < source.length) {
        const item = LIST_ITEM.exec(source[at] ?? "");
        if (item !== null) {
          items.push(item[3] ?? "");
          at += 1;
        } else if (/^\s+\S/.test(source[at] ?? "") && items.length > 0) {
          // A continuation of the item above.
          items[items.length - 1] = `${items.at(-1)} ${(source[at] ?? "").trim()}`;
          at += 1;
        } else {
          break;
        }
      }
      blocks.push({ kind: "list", ordered, items });
    } else {
      const text: string[] = [];
      while (at < source.length && (source[at] ?? "").trim() !== "") {
        if (text.length > 0 && startsBlock(source[at] ?? "")) break;
        text.push((source[at] ?? "").trim());
        at += 1;
      }
      blocks.push({ kind: "p", text: text.join(" ") });
    }
  }
  return blocks;
}

/** What a `Visual:` line asks to draw, when it names a kind we draw. */
type VisualKind = "figures" | "flow" | "quote";

const VISUAL_KINDS: ReadonlyArray<readonly [RegExp, VisualKind]> = [
  [/^(?:key figures?|figures?|chiffres?(?: clés?)?|numbers?)\b/i, "figures"],
  [/^(?:diagram|schema|schéma|flow|steps?|parcours|étapes?)\b/i, "flow"],
  [/^(?:quote|citation)\b/i, "quote"],
];

function visualKindOf(text: string): VisualKind | undefined {
  const clean = plain(text);
  return VISUAL_KINDS.find(([pattern]) => pattern.test(clean))?.[1];
}

/** Key figures: each item is « figure — what it says », the figure drawn large, in SVG. */
function figuresHtml(items: readonly string[]): string {
  const cards = items.map((item) => {
    const split = /^(.{1,40}?)\s+[—–]\s+(.+)$/.exec(item) ?? /^(.{1,40}?):\s+(.+)$/.exec(item);
    const figure = plain(split?.[1] ?? item);
    const label = split?.[2];
    const length = [...figure].length;
    // A short figure is drawn large, in SVG; a longer text is left to wrap, as text.
    const drawn =
      length <= 14
        ? `<svg viewBox="0 0 200 70" role="img" aria-label="${escapeHtml(figure)}"><text x="100" y="52" text-anchor="middle" font-size="${Math.min(54, Math.floor(190 / (Math.max(1, length) * 0.6)))}">${escapeHtml(figure)}</text></svg>`
        : `<strong>${escapeHtml(figure)}</strong>`;
    return `<figure class="stat">${drawn}${label === undefined ? "" : `<span>${inlineHtml(label)}</span>`}</figure>`;
  });
  return `<div class="stats">${cards.join("")}</div>`;
}

const ARROW = '<svg viewBox="0 0 24 12" aria-hidden="true"><path d="M1 6h20M16 1l6 5-6 5"/></svg>';

/** A simple diagram: the items as boxes joined by arrows. */
function flowHtml(items: readonly string[]): string {
  const boxes = items.map(
    (item, index) =>
      `<div role="listitem"><span class="box">${inlineHtml(item)}</span>${
        index < items.length - 1 ? ARROW : ""
      }</div>`,
  );
  return `<div class="flow" role="list">${boxes.join("")}</div>`;
}

const QUOTE_MARK =
  '<svg viewBox="0 0 48 36" aria-hidden="true"><path d="M0 36V18C0 7 6 1 16 0v7c-5 1-7 4-7 8h7v21zM28 36V18C28 7 34 1 44 0v7c-5 1-7 4-7 8h7v21z"/></svg>';

/** A quotation: the mark drawn, the words, and an attribution when the last line starts with a dash. */
function quoteHtml(lines: readonly string[]): string {
  const last = lines.at(-1) ?? "";
  const by = /^[—–]\s*(.+)$/.exec(last.trim());
  const words = (by === null ? lines : lines.slice(0, -1)).filter((line) => line.trim() !== "");
  return (
    `<figure class="quote">${QUOTE_MARK}<blockquote>${words.map(inlineHtml).join("<br>")}</blockquote>` +
    (by === null ? "" : `<figcaption>${inlineHtml(last.trim())}</figcaption>`) +
    "</figure>"
  );
}

function tableHtml(rows: readonly string[][], header: boolean): string {
  const row = (cells: readonly string[], tag: "th" | "td") =>
    `<tr>${cells.map((cell) => `<${tag}>${inlineHtml(cell)}</${tag}>`).join("")}</tr>`;
  const head = header && rows[0] !== undefined ? `<thead>${row(rows[0], "th")}</thead>` : "";
  const body = rows.slice(header ? 1 : 0).map((cells) => row(cells, "td"));
  return `<table>${head}<tbody>${body.join("")}</tbody></table>`;
}

/** The content of a slide as markup. */
function slideHtml(lines: readonly string[]): string {
  const blocks = blocksOf(lines);
  const visual = blocks.find((block) => block.kind === "visual");
  const kind = visual === undefined ? undefined : visualKindOf(visual.text);
  // The first block that can be drawn is drawn once; the others stay the text they are.
  let drawn = false;
  const html = blocks.map((block): string => {
    if (block.kind === "visual") return `<p class="vis">${inlineHtml(`Visual: ${block.text}`)}</p>`;
    if (block.kind === "heading") {
      return `<h${block.level}>${inlineHtml(block.text)}</h${block.level}>`;
    }
    if (block.kind === "p") return `<p>${inlineHtml(block.text)}</p>`;
    if (block.kind === "code") return `<pre><code>${escapeHtml(clean(block.text))}</code></pre>`;
    if (block.kind === "table") return tableHtml(block.rows, block.header);
    if (block.kind === "quote") {
      if (kind === "quote" && !drawn) {
        drawn = true;
        return quoteHtml(block.lines);
      }
      return `<blockquote>${block.lines.map(inlineHtml).join("<br>")}</blockquote>`;
    }
    if ((kind === "figures" || kind === "flow") && !drawn) {
      drawn = true;
      return kind === "figures" ? figuresHtml(block.items) : flowHtml(block.items);
    }
    const tag = block.ordered ? "ol" : "ul";
    return `<${tag}>${block.items.map((item) => `<li>${inlineHtml(item)}</li>`).join("")}</${tag}>`;
  });
  return html.join("\n");
}

/**
 * The content security policy of a page that stands alone: nothing from the network, only its own
 * inline style, and, for a page with a script, that one script by its hash. The pages of the UX
 * mock-ups carry the same policy without a script, and `docs check` requires it.
 */
export function pagePolicy(scriptHash?: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    ...(scriptHash === undefined ? [] : [`script-src 'sha256-${scriptHash}'`]),
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Standard base64, with its padding: the form a content security policy reads a hash in. */
function base64(bytes: Uint8Array): string {
  const url = toBase64url(bytes).replace(/-/g, "+").replace(/_/g, "/");
  return url + "=".repeat((4 - (url.length % 4)) % 4);
}

/** The claim of a slide: its heading without « Slide 3 — ». */
function claimOf(heading: string): string {
  return heading
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/^\s*(?:slide|diapositive)\s+\d{1,3}\s*[-—–:]?\s*/i, "")
    .trim();
}

/**
 * The page of a deck. `markdown` is the file as written (header included); a deck with no slide
 * gives a page with none (the command refuses it before).
 */
export function renderDeckPage(markdown: string): DeckPage {
  const text = normalizeText(markdown).normalize("NFC");
  const document = parseDocumentFile("deck.md", text);
  const lines = text.split("\n");
  const fr = String(document.language?.value ?? "")
    .toLowerCase()
    .startsWith("fr");
  const words = DECK_PAGE_LABELS[fr ? "fr" : "en"];
  const body = (splitFrontmatter(text)?.body ?? text).split("\n");
  const firstSection = body.findIndex((line) => /^\s*##\s/.test(line));
  const intro = body.slice(0, firstSection === -1 ? body.length : firstSection);
  const notDrawn = [
    ...(visibleText(intro.filter((line) => !/^#\s/.test(line))) === "" ? [] : ["(intro)"]),
    ...document.sections
      .filter((section) => !DECK_SLIDE_TITLE.test(section.title))
      .map((section) => claimOf(lines[section.line - 1] ?? "").slice(0, 40)),
  ];
  const title = body.map((line) => /^#\s+(.+?)\s*$/.exec(line)?.[1]).find(Boolean) ?? "Deck";
  let noted = 0;
  const slides = document.sections
    .filter((section) => DECK_SLIDE_TITLE.test(section.title))
    .map((section, index) => {
      const { content, notes, noted: hasNotes } = slideParts(section);
      const claim = claimOf(lines[section.line - 1] ?? "");
      const notesHtml = notes.some((line) => line.trim() !== "")
        ? `<aside class="notes"><h3>${escapeHtml(words.speaker)}</h3>${slideHtml(notes)}</aside>`
        : "";
      if (hasNotes && notesHtml !== "") noted += 1;
      const label = `${words.slide} ${index + 1}`;
      return (
        `<section class="slide" id="slide-${index + 1}" aria-label="${escapeHtml(label)}"><div class="in">` +
        (claim === "" ? "" : `<h2>${inlineHtml(claim)}</h2>`) +
        slideHtml(content) +
        notesHtml +
        "</div></section>"
      );
    });
  const hash = base64(sha256(utf8(DECK_PAGE_SCRIPT)));
  const policy = pagePolicy(hash);
  const button = (id: string, label: string) =>
    `<button type="button" id="${id}" title="${escapeHtml(words.hint)}">${escapeHtml(label)}</button>`;
  const html =
    "<!doctype html>\n" +
    `<html lang="${fr ? "fr" : "en"}">\n<head>\n<meta charset="utf-8">\n` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">\n` +
    `<title>${escapeHtml(clean(title))}</title>\n<style>${DECK_PAGE_STYLE}</style>\n</head>\n<body>\n` +
    `<main>\n${slides.join("\n")}\n</main>\n` +
    '<nav class="ctl">' +
    button("prev", `← ${words.prev}`) +
    '<span id="count" aria-live="polite"></span>' +
    button("next", `${words.next} →`) +
    button("notes", words.notes) +
    button("theme", words.theme) +
    button("full", words.full) +
    '</nav>\n<div class="bar"><i id="bar"></i></div>\n' +
    `<script>${DECK_PAGE_SCRIPT}</script>\n</body>\n</html>\n`;
  return { html, slides: slides.length, notes: noted, notDrawn };
}
