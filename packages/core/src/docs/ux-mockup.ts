import { pagePolicy } from "./deck-page.js";

/**
 * The mock-up pages of the UX specification, judged as pure functions. A page is
 * written by an agent from words that come from outside (the creator's, a product they admire, a
 * page they pasted), so it is read like the deck page is written: it must stand
 * alone, need nothing from the network, run nothing, and carry the content security policy that
 * would make a browser refuse what slipped through. `docs check` does not try to clean a page; it
 * accepts only what it fully understands: a short list of tags, a short list of attributes per
 * tag, links to the page itself, styles without any address. Anything else is a problem, named.
 */

/** What is wrong with a page: a short word and the thing found (never more than 60 characters). */
export interface MockupFault {
  readonly problem: string;
  readonly detail: string;
}

const TAGS: ReadonlySet<string> = new Set(
  (
    "html head meta title style body main header footer nav section article aside div span p " +
    "h1 h2 h3 h4 h5 h6 ul ol li dl dt dd a button label input textarea select option table " +
    "thead tbody tr th td strong em small b i code pre kbd mark hr br figure figcaption time " +
    "svg g path rect circle ellipse line polyline polygon text"
  ).split(" "),
);

const GLOBAL_ATTRIBUTES =
  /^(?:class|id|lang|dir|title|role|tabindex|aria-[a-z-]+|data-[a-z0-9-]+)$/;
const ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  html: new Set(["lang"]),
  meta: new Set(["charset", "name", "content", "http-equiv"]),
  a: new Set(["href"]),
  button: new Set(["type", "disabled"]),
  input: new Set([
    "type",
    "value",
    "placeholder",
    "checked",
    "disabled",
    "readonly",
    "name",
    "min",
    "max",
  ]),
  textarea: new Set(["placeholder", "disabled", "readonly", "rows", "cols", "name"]),
  select: new Set(["disabled", "name"]),
  option: new Set(["selected", "value", "disabled"]),
  label: new Set(["for"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  time: new Set(["datetime"]),
};
const SVG_ATTRIBUTES = new Set(
  (
    "viewbox width height x y cx cy r rx ry x1 y1 x2 y2 d points fill stroke stroke-width " +
    "stroke-linecap stroke-linejoin opacity transform text-anchor font-size fill-opacity"
  ).split(" "),
);
const SVG_TAGS = new Set("svg g path rect circle ellipse line polyline polygon text".split(" "));
const INPUT_TYPES = new Set(
  "text search email password number tel url checkbox radio range date time button".split(" "),
);
const BUTTON_TYPES = new Set(["button"]);
const SVG_VALUE = /^[A-Za-z0-9.,#%\s+\-()]*$/;
/** The most a tag may hold, attributes included (a long drawing path is a few thousand). */
const MAX_TAG = 10_000;

/** The tag of an opening or closing markup, attributes included (quotes may hold a `>`). */
const MARKUP =
  /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Things a style can hold that reach out or hide an address. A backslash or a character reference
 * (`&#117;rl(`) spells any of them in a way a browser reads and this list does not.
 */
const STYLE_REFUSED =
  /\\|<|&(?:#|[a-z][a-z0-9]*;)|url\s*\(|@import|@font-face|@namespace|@charset|image-set|image\s*\(|src\s*\(|expression|behavior|-moz-binding|javascript:/i;

function fault(problem: string, detail: string): MockupFault {
  return { problem, detail: detail.replace(/\s+/g, " ").slice(0, 60) };
}

function styleFault(css: string, where: string): MockupFault | undefined {
  const refused = STYLE_REFUSED.exec(css);
  return refused === null ? undefined : fault("style", `${where}: ${refused[0]}`);
}

/** The attributes of a tag, by lower-case name; a name given twice is a fault. */
function attributesOf(raw: string): { list: Array<[string, string]>; twice: string | undefined } {
  const list: Array<[string, string]> = [];
  let twice: string | undefined;
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? "").toLowerCase();
    if (list.some(([known]) => known === name)) twice = name;
    list.push([name, match[2] ?? match[3] ?? match[4] ?? ""]);
  }
  return { list, twice };
}

function attributeFault(
  tag: string,
  name: string,
  value: string,
  svg: boolean,
): MockupFault | undefined {
  if (value.includes("<")) return fault("attribute", `${tag} ${name}`);
  if (name === "style") return styleFault(value, `${tag} style`);
  if (name === "href" && tag === "a") {
    return /^#[A-Za-z0-9_-]*$/.test(value) ? undefined : fault("link", value);
  }
  if (name === "type" && tag === "input") {
    return INPUT_TYPES.has(value.toLowerCase()) ? undefined : fault("input type", value);
  }
  if (name === "type" && tag === "button") {
    return BUTTON_TYPES.has(value.toLowerCase()) ? undefined : fault("button type", value);
  }
  if (GLOBAL_ATTRIBUTES.test(name) || name === "style") return undefined;
  if (ATTRIBUTES[tag]?.has(name) === true) return undefined;
  if ((svg || SVG_TAGS.has(tag)) && SVG_ATTRIBUTES.has(name)) {
    // Numbers, paths, colours and words: no address, no function but a bracket group.
    return SVG_VALUE.test(value) && !/url/i.test(value)
      ? undefined
      : fault("attribute", `${tag} ${name} value`);
  }
  return fault("attribute", `${tag} ${name}`);
}

/**
 * Every fault of a page, the first of each kind. An empty list means the page may be shown: it is
 * a complete document, with its policy before any tag but `html` and `head` (the metas of the
 * charset and of the viewport may stand before it), and holds nothing outside the lists above.
 */
export function mockupFaults(html: string): MockupFault[] {
  const faults: MockupFault[] = [];
  const add = (item: MockupFault | undefined) => {
    if (item !== undefined && !faults.some((known) => known.problem === item.problem)) {
      faults.push(item);
    }
  };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
  const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.exec(html);
  if (control !== null) return [fault("character", `U+${control[0].charCodeAt(0).toString(16)}`)];
  const text = html.replace(/\r\n?/g, "\n");
  const doctype = /^<!doctype html>\s*/i.exec(text);
  if (doctype === null) return [fault("doctype", "the page opens with <!doctype html>")];
  let at = doctype[0].length;
  let policySeen = false;
  let svgDepth = 0;
  const policy = pagePolicy();
  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open === -1) break;
    const markup = MARKUP.exec(text.slice(open, open + MAX_TAG));
    if (markup === null) {
      add(fault("markup", text.slice(open, open + 24)));
      break;
    }
    const [whole, slash = "", rawName = "", rawAttributes = ""] = markup;
    const tag = rawName.toLowerCase();
    at = open + whole.length;
    if (!TAGS.has(tag)) {
      add(fault("tag", tag));
      continue;
    }
    if (slash === "/") {
      if (tag === "svg") svgDepth = Math.max(0, svgDepth - 1);
      continue;
    }
    const { list, twice } = attributesOf(rawAttributes);
    if (twice !== undefined) add(fault("attribute", `${tag} ${twice} twice`));
    if (tag === "svg") svgDepth += 1;
    if (tag === "meta") {
      const names = list.map(([name]) => name).join(" ");
      const value = (key: string) => list.find(([name]) => name === key)?.[1];
      const canonical =
        (names === "charset" && (value("charset") ?? "").toLowerCase() === "utf-8") ||
        (names === "name content" && value("name") === "viewport") ||
        (names === "http-equiv content" &&
          (value("http-equiv") ?? "").toLowerCase() === "content-security-policy" &&
          value("content") === policy);
      if (!canonical) add(fault("meta", names));
      if (names === "http-equiv content" && canonical) policySeen = true;
      continue;
    }
    // The policy comes before anything the browser could load or run: nothing but the head's own
    // tags may stand before it, so that it is in the head, where a browser applies it.
    if (!policySeen && tag !== "html" && tag !== "head") add(fault("policy", `<${tag}> before it`));
    for (const [name, value] of list) {
      add(attributeFault(tag, name, value, svgDepth > 0));
    }
    if (tag === "style" || tag === "title") {
      // Text with nothing in it that a parser could read as markup: the same in every parser.
      const found = text.slice(at).search(new RegExp(`</${tag}`, "i"));
      const close = found === -1 ? -1 : at + found;
      const end = close === -1 ? text.length : close;
      const body = text.slice(at, end);
      if (close === -1 || body.includes("<")) add(fault("markup", `${tag} holds a <`));
      if (tag === "style") add(styleFault(body, "style"));
      at = end;
    }
  }
  if (!policySeen) add(fault("policy", "the Content-Security-Policy meta is missing or altered"));
  if (!/<title>[^<]*\S[^<]*<\/title>/i.test(text)) add(fault("title", "the page has no title"));
  return faults;
}
