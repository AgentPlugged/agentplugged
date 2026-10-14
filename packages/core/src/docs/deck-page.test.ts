import { sha256Hex } from "@agentplugged/crypto";
import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  createCommandRegistry,
  DECK_PAGE_PATH,
  DECK_PATH,
  type DeckDrawn,
  escapeHtml,
  renderDeckPage,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { inlineHtml } from "./deck-page.js";

/** The deck drawn as one page, and `docs slides` that writes it. */

/** A hash in hexadecimal as standard base64, the way a content security policy writes it. */
function base64OfHex(hex: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = (hex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16));
  let out = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const [a = 0, b = 0, c = 0] = bytes.slice(at, at + 3);
    const word = (a << 16) | (b << 8) | c;
    const left = bytes.length - at;
    out += alphabet[(word >> 18) & 63];
    out += alphabet[(word >> 12) & 63];
    out += left > 1 ? alphabet[(word >> 6) & 63] : "=";
    out += left > 2 ? alphabet[word & 63] : "=";
  }
  return out;
}

const HEADER = "id: deck\nkind: note\nowner: julien\nlinks: [narrative]\nlanguage: en";

function deck(body: string, header = HEADER): string {
  return `---\n${header}\n---\n${body}`;
}

const PLAIN = deck(
  [
    "# Deck: Solo makers",
    "",
    "## Slide 1 — Makers lose a week to rework",
    "",
    "- **40 %** — fewer tokens (source: EF-1)",
    "- 3 weeks — lost per release",
    "",
    "Visual: key figures — the cost of rework",
    "",
    "Notes: Say it slowly.",
    "",
    "Ask the room who has lived it.",
    "",
    "## Slide 2 — Three steps",
    "",
    "1. Frame",
    "2. Build",
    "3. Ship",
    "",
    "Visual: diagram — the path",
    "",
    "Notes: Walk the steps.",
    "",
    "## Slide 3 — Try it",
    "",
    "> Tokens saved are weeks gained.",
    "> — A maker",
    "",
    "Visual: quote",
    "",
    "Notes: Close on the ask.",
    "",
  ].join("\n"),
);

describe("the deck drawn: one standalone page", () => {
  const page = renderDeckPage(PLAIN);

  it("draws one slide per screen, with the claim as its title and the notes apart", () => {
    expect(page.slides).toBe(3);
    expect(page.notes).toBe(3);
    expect(page.html.match(/<section class="slide"/g)).toHaveLength(3);
    expect(page.html).toContain("<h2>Makers lose a week to rework</h2>");
    expect(page.html).toContain('<aside class="notes">');
    expect(page.html).toContain("Say it slowly.");
    expect(page.html).toContain("Ask the room who has lived it.");
    expect(page.html).toContain("<title>Deck: Solo makers</title>");
  });

  it("is the same page every time it is drawn", () => {
    expect(renderDeckPage(PLAIN)).toEqual(page);
    expect(renderDeckPage(PLAIN.replace(/\n/g, "\r\n")).html).toBe(page.html);
  });

  it("needs nothing from the network: no resource, no link tag, no import, no remote address", () => {
    const { html } = page;
    expect(html).not.toMatch(/<link\b|<img\b|<iframe\b|<object\b|<embed\b|<video\b|<audio\b/i);
    expect(html).not.toMatch(/\bsrc\s*=|@import|url\(|https?:\/\//i);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).toContain("default-src 'none'");
    // The policy lets in the one script the page carries, by its hash, and no other.
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    const hash = base64OfHex(sha256Hex(script));
    expect(html).toContain(`script-src 'sha256-${hash}'`);
  });

  it("moves with the keyboard, shows the notes on a key, prints and follows light and dark", () => {
    const { html } = page;
    for (const key of ["ArrowRight", "ArrowLeft", "PageDown", "PageUp", "Home", "End"]) {
      expect(html, key).toContain(`"${key}"`);
    }
    expect(html).toContain('k==="n"');
    expect(html).toContain('"notes-on"');
    expect(html).toContain("@media print");
    expect(html).toContain("break-after:page");
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain('[data-theme="light"]');
    expect(html).toContain('[data-theme="dark"]');
    expect(html).toContain('name="viewport"');
    // Without the script the slides are one under the other: the page is still a document.
    expect(html).toContain("html.js .slide{display:none");
  });

  it("draws the visuals a slide plans, in SVG, from its own words", () => {
    const { html } = page;
    // Key figures: the figure large, its words under it.
    expect(html).toContain('<figure class="stat">');
    expect(html).toMatch(/<text [^>]*>40 %<\/text>/);
    expect(html).toContain("<span>fewer tokens (source: EF-1)</span>");
    expect(html).toMatch(/<text [^>]*>3 weeks<\/text>/);
    // A diagram: the steps as boxes joined by arrows.
    expect(html.match(/<span class="box">/g)).toHaveLength(3);
    expect(html.match(/<path d="M1 6h20M16 1l6 5-6 5"\/>/g)).toHaveLength(2);
    // A quotation, with its attribution.
    expect(html).toContain('<figure class="quote">');
    expect(html).toContain("<figcaption>— A maker</figcaption>");
    // The line that planned the visual stays on the slide, as the creator wrote it.
    expect(html).toContain("Visual: key figures — the cost of rework");
  });

  it("keeps a visual it does not draw as the line it is, and draws a plain list as a list", () => {
    const text = deck(
      "# D\n\n## Slide 1 — A\n\n- one\n- two\n\nVisual: a photo of the team\n\nNotes: n.\n\n## Slide 2 — B\n\nB.\n\nNotes: n.\n\n## Slide 3 — C\n\nC.\n\nNotes: n.\n",
    );
    const { html } = renderDeckPage(text);
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("Visual: a photo of the team");
    expect(html).not.toContain('class="stat"');
  });

  it("writes the controls in the language of the deck", () => {
    const fr = renderDeckPage(
      deck(PLAIN.split("---\n")[2] ?? "", HEADER.replace("language: en", "language: fr")),
    );
    expect(fr.html).toContain('<html lang="fr">');
    expect(fr.html).toContain("Notes de l&#39;orateur");
    expect(fr.html).toContain("Plein écran");
    expect(page.html).toContain('<html lang="en">');
  });

  it("leaves out the comments of the template, and nothing else", () => {
    const text = deck(
      "# D\n\n## Slide 1 — A\n\nkept <!-- gone --> text\n\n<!-- a comment\nover two lines -->\n\nNotes: n.\n\n## Slide 2 — B\n\nB.\n\nNotes: n.\n\n## Slide 3 — C\n\nC.\n\nNotes: n.\n",
    );
    const { html } = renderDeckPage(text);
    expect(html).toContain("kept  text");
    expect(html).not.toContain("gone");
    expect(html).not.toContain("over two lines");
  });

  it("shows the tables, the code and the links to the web as they are", () => {
    const text = deck(
      "# D\n\n## Slide 1 — A\n\n| a | b |\n| --- | --- |\n| 1 | **2** |\n\n```\nlet x = 1 < 2;\n```\n\nSee [the site](https://example.org/a?b=1&c=2).\n\nNotes: n.\n\n## Slide 2 — B\n\nB.\n\nNotes: n.\n\n## Slide 3 — C\n\nC.\n\nNotes: n.\n",
    );
    const { html } = renderDeckPage(text);
    expect(html).toContain("<thead><tr><th>a</th><th>b</th></tr></thead>");
    expect(html).toContain("<td><strong>2</strong></td>");
    expect(html).toContain("<pre><code>let x = 1 &lt; 2;</code></pre>");
    expect(html).toContain(
      '<a href="https://example.org/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">the site</a>',
    );
  });
});

/** The tags and attributes a page of ours may hold: nothing else may come from a deck. */
const TAGS = new Set(
  "html head meta title style body main section h2 h3 h4 h5 h6 p ul ol li strong em code pre a table thead tbody tr th td blockquote br figure figcaption svg path text span div nav button i aside script".split(
    " ",
  ),
);
const ATTRIBUTES = new Set(
  "lang charset name content http-equiv id class aria-label aria-live aria-hidden role href target rel type title viewBox d x y text-anchor font-size".split(
    " ",
  ),
);

/** Every tag of the page outside its style and its script, with its attributes. */
function tagsOf(html: string): Array<{ name: string; attributes: Record<string, string> }> {
  const markup = html
    .replace(/<style>[\s\S]*?<\/style>/, "<style></style>")
    .replace(/<script>[\s\S]*?<\/script>/, "<script></script>");
  const found: Array<{ name: string; attributes: Record<string, string> }> = [];
  for (const match of markup.matchAll(
    /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/g,
  )) {
    const attributes: Record<string, string> = {};
    for (const attribute of (match[2] ?? "").matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
      attributes[attribute[1] ?? ""] = attribute[2] ?? "";
    }
    found.push({ name: match[1] ?? "", attributes });
  }
  // Whatever looks like a tag but was not read as one is an injection that slipped through.
  const opened = (markup.match(/<[a-zA-Z]/g) ?? []).length;
  expect(found.length, "every tag is well-formed").toBe(opened);
  return found;
}

const HOSTILE = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '"><svg onload=alert(1)>',
  "</title><script>alert(2)</script>",
  "<iframe src=//evil.example></iframe>",
  "<!-- --><script>alert(3)</script>",
];

describe("the deck cannot inject anything into the page", () => {
  function hostileDeck(payload: string): string {
    return deck(
      [
        `# ${payload}`,
        "",
        `## Slide 1 — ${payload}`,
        "",
        `${payload} paragraph`,
        "",
        `- ${payload}`,
        `- ${payload} — ${payload}`,
        "",
        `1. ${payload}`,
        "",
        `| ${payload} | b |`,
        "| --- | --- |",
        `| ${payload} | [x](${payload}) |`,
        "",
        `> ${payload}`,
        `> — ${payload}`,
        "",
        "```",
        payload,
        "```",
        "",
        `### ${payload}`,
        "",
        `[click](javascript:alert(1)) [click](data:text/html,${payload}) ![${payload}](https://evil.example/x.png)`,
        "",
        `[ok](https://example.org/"${payload}) \`${payload}\` **${payload}** *${payload}*`,
        "",
        `Visual: key figures ${payload}`,
        "",
        `Notes: ${payload}`,
        "",
        `${payload}`,
        "",
        "## Slide 2 — B",
        "",
        "- a — b",
        "- c — d",
        "",
        "Visual: diagram",
        "",
        "Notes: n.",
        "",
        "## Slide 3 — C",
        "",
        "> q",
        "",
        `Visual: quote ${payload}`,
        "",
        "Notes: n.",
        "",
      ].join("\n"),
      HEADER.replace("language: en", `language: "${payload.replaceAll('"', "'")}"`),
    );
  }

  it.each(HOSTILE)("shows %s as text and as nothing else", (payload) => {
    const { html } = renderDeckPage(hostileDeck(payload));
    // The one script and the one style of the page are the only ones.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html.match(/<style/g)).toHaveLength(1);
    const tags = tagsOf(html);
    for (const tag of tags) {
      expect(TAGS.has(tag.name), `tag ${tag.name}`).toBe(true);
      for (const [name, value] of Object.entries(tag.attributes)) {
        expect(ATTRIBUTES.has(name), `attribute ${name}`).toBe(true);
        expect(name.startsWith("on"), name).toBe(false);
        if (name === "href") expect(value).toMatch(/^https?:\/\/[^\s"<>]*$/);
      }
    }
    expect(html).not.toMatch(/href="(?!https?:\/\/)/i);
    // The text itself is there, escaped: it was not dropped nor changed.
    expect(html).toContain(escapeHtml(payload.replace(/<!--.*?-->/g, "")));
  });

  it("escapes every character that opens markup, in text and in attributes", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
    expect(inlineHtml("a < b & c > d \u0000 `<b>`")).toBe(
      "a &lt; b &amp; c &gt; d  <code>&lt;b&gt;</code>",
    );
    expect(inlineHtml('[x](https://a.b/c" onmouseover="d)')).not.toContain("<a ");
  });

  it("does not let a quoted code mark smuggle markup back in", () => {
    const html = inlineHtml("`<img src=x onerror=1>` and \u0000" + "0" + "\u0000");
    expect(html).not.toContain("<img");
  });

  it("keeps an address as written when its text holds emphasis marks, and the markup well nested", () => {
    for (const url of [
      "https://x.com/__init__/a_b_c",
      "https://y.com/*x*",
      "https://z.com/`q`",
      "https://w.com/a**b**c",
    ]) {
      const html = inlineHtml(`See [the page](${url}) now`);
      expect(html, url).toContain(
        `<a href="${url}" target="_blank" rel="noopener noreferrer">the page</a>`,
      );
      expect(html, url).not.toMatch(/href="[^"]*<(?:strong|em|code)>/);
    }
    // On a whole page: every address stays an address, every tag one of ours.
    const marked = renderDeckPage(
      deck(
        "# D\n\n## Slide 1 — [**a**](https://x.com/__i__/*b*/`c`) and `[d](https://e.com)`\n\n- [<b>x</b>](https://h.com/a_b_c) __y__ *z* `<i>`\n\nNotes: [n](https://n.com/_a_)\n\n## Slide 2 — B\n\nB.\n\nNotes: n.\n\n## Slide 3 — C\n\nC.\n\nNotes: n.\n",
      ),
    ).html;
    for (const tag of tagsOf(marked)) {
      expect(TAGS.has(tag.name), tag.name).toBe(true);
      if (tag.attributes.href !== undefined) {
        expect(tag.attributes.href).toMatch(/^https?:\/\/[^\s"<>]*$/);
      }
    }
    expect(marked).toContain('href="https://x.com/__i__/*b*/`c`"');
    expect(marked).toContain("<code>[d](https://e.com)</code>");
    // A mark opened in the text and closed in a link's label is neither a link nor a tag torn in two.
    expect(inlineHtml("**a [b**](https://h.com)")).toBe(
      '**a <a href="https://h.com" target="_blank" rel="noopener noreferrer">b**</a>',
    );
    expect(inlineHtml("**bold [and `code`](https://h.com)** end")).toBe(
      '<strong>bold <a href="https://h.com" target="_blank" rel="noopener noreferrer">and <code>code</code></a></strong> end',
    );
  });
});

/** The text a page shows, without its markup: what a person reads. */
function shownText(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("nothing of the deck is dropped in silence", () => {
  const rich = deck(
    [
      "# Deck: all of it",
      "",
      "Intro before the first slide.",
      "",
      "## Slide 1 — Claim with `<!--` inside",
      "",
      "A span `<!-- not a comment` and an open <!-- comment that never closes, still text.",
      "",
      "![the logo](https://example.org/logo.png) and [a mail](mailto:a@b.c) and 1_000 and __init__.",
      "",
      "~~~",
      "<!-- kept --> **not bold**",
      "~~~",
      "",
      "- 4 521 customers who have already paid for the product and left",
      "- 12 — stories",
      "",
      "Visual: figures",
      "",
      "Notes: the speaker's words.",
      "",
      "## Slide 2 — Quote",
      "",
      "> To be or not",
      "> — Someone",
      "",
      "Visual: quote",
      "",
      "Notes: n.",
      "",
      "## Slide 3 — End ##",
      "",
      "Last.",
      "",
      "Notes: n.",
      "",
      "## Sources",
      "",
      "- the list of sources",
      "",
    ].join("\n"),
  );
  const page = renderDeckPage(rich);
  const shown = shownText(page.html);

  it("shows the words of the slides, a comment left open and the marks of code as they are", () => {
    for (const part of [
      "Claim with <!-- inside",
      "A span <!-- not a comment and an open <!-- comment that never closes, still text.",
      "the logo (https://example.org/logo.png)",
      "a mail (mailto:a@b.c)",
      "1_000",
      "<!-- kept --> **not bold**",
      "4 521 customers who have already paid for the product and left",
      "the speaker's words.",
      "— Someone",
      "End",
    ]) {
      expect(shown, part).toContain(part);
    }
    expect(shown).not.toContain("End ##");
  });

  it("says what it did not draw, so that nothing is lost without the creator knowing", () => {
    expect(page.notDrawn).toEqual(["(intro)", "Sources"]);
    expect(renderDeckPage(PLAIN).notDrawn).toEqual([]);
  });
});

describe("docs slides: the page is written next to the deck", () => {
  const noTools: ToolProbe = {
    which: async () => undefined,
    version: async () => undefined,
    extensions: async () => [],
  };
  const context = (files: MemoryFiles): CommandContext => ({
    files,
    tools: noTools,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.2.3",
  });
  const run = (files: MemoryFiles) =>
    createCommandRegistry().run("docs", context(files), { action: "slides" });

  it("writes only the page, leaves the deck as it is and says what it holds", async () => {
    const files = new MemoryFiles({ [DECK_PATH]: PLAIN });
    const result = await run(files);
    expect(result).toEqual({
      ok: true,
      value: {
        page: "deck",
        path: DECK_PAGE_PATH,
        slides: 3,
        notes: 3,
        notDrawn: [],
        deck: "draft",
      },
    });
    expect(DECK_PAGE_PATH).toBe(".agentplugged/docs/launch/deck.html");
    expect(files.files.get(DECK_PATH)).toBe(PLAIN);
    expect(files.files.get(DECK_PAGE_PATH)).toBe(renderDeckPage(PLAIN).html);
    expect(files.writes).toEqual([DECK_PAGE_PATH]);
    // Drawn again, the same page.
    await run(files);
    expect(files.files.get(DECK_PAGE_PATH)).toBe(renderDeckPage(PLAIN).html);
    const value = (result.ok ? result.value : undefined) as DeckDrawn;
    expect(value.slides).toBe(3);
  });

  it("draws nothing without a deck, nor from a deck that docs check refuses", async () => {
    const none = await run(new MemoryFiles());
    expect(!none.ok && none.error.details.reason).toBe(`docs slides: no deck (${DECK_PATH})`);
    const broken = new MemoryFiles({
      [DECK_PATH]: deck("# D\n\n## Slide 1 — A\n\nOnly one, and <the claim> left.\n", HEADER),
    });
    const refused = await run(broken);
    expect(!refused.ok && refused.error.details.reason).toContain("run docs check");
    expect(broken.writes).toEqual([]);
  });

  it("never follows a symbolic link, to read the deck or to write its page", async () => {
    class Linked extends MemoryFiles {
      async isSymbolicLink(path: string) {
        return path === DECK_PAGE_PATH;
      }
    }
    const files = new Linked({ [DECK_PATH]: PLAIN });
    const refused = await run(files);
    expect(!refused.ok && refused.error.details.reason).toBe(
      `docs slides: ${DECK_PAGE_PATH} is a symbolic link`,
    );
    expect(files.writes).toEqual([]);
  });

  it("tells what it did not draw", async () => {
    const files = new MemoryFiles({ [DECK_PATH]: `${PLAIN}\n## Sources\n\n- one\n` });
    const result = await run(files);
    expect(result.ok && (result.value as DeckDrawn).notDrawn).toEqual(["Sources"]);
  });
});
