import { describe, expect, it } from "vitest";
import { pagePolicy } from "./deck-page.js";
import { mockupFaults } from "./ux-mockup.js";

const POLICY = pagePolicy();

/** A page as the template gives it, with the body (and the style) of the test. */
function page(body: string, style = "body{margin:0;font:16px system-ui}"): string {
  return (
    "<!doctype html>\n" +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<meta http-equiv="Content-Security-Policy" content="${POLICY}">` +
    `<title>Home</title><style>${style}</style></head><body>${body}</body></html>`
  );
}

const kinds = (html: string) => mockupFaults(html).map((fault) => fault.problem);

describe("a mock-up page that stands alone", () => {
  it("accepts a page made of the short lists: text, tables, forms without a form, drawings", () => {
    const html = page(
      '<main class="screen" aria-label="Home"><h1>Today</h1><p>3 <strong>tasks</strong> left</p>' +
        '<ul><li><a href="#next">Next</a></li></ul><button type="button" class="primary">Add</button>' +
        '<input type="text" placeholder="Name" aria-label="Name"><table><tr><th>A</th><td>1</td></tr></table>' +
        '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M0 0L10 10" stroke="#000"/></svg>' +
        '<div style="padding:8px;color:#222" data-region="1">[1] header</div></main>',
      ":root{--c:#123456}@media (prefers-color-scheme:dark){body{background:#000}}.a{color:var(--c)}",
    );
    expect(mockupFaults(html)).toEqual([]);
  });

  it("is a complete document with the policy of the deck page, before anything is loaded", () => {
    expect(kinds("<p>no doctype</p>")).toEqual(["doctype"]);
    expect(
      kinds(page("<p>x</p>").replace(`content="${POLICY}"`, 'content="default-src *"')),
    ).toContain("meta");
    const late = page("<p>x</p>").replace(/<meta http-equiv[^>]*>/, "");
    expect(kinds(late)).toContain("policy");
    const afterStyle = page("<p>x</p>")
      .replace(/<meta http-equiv[^>]*>/, "")
      .replace(
        "</style>",
        `</style><meta http-equiv="Content-Security-Policy" content="${POLICY}">`,
      );
    expect(kinds(afterStyle)).toContain("policy");
    expect(POLICY).not.toContain("script-src");
    expect(POLICY).toContain("default-src 'none'");
  });

  it("refuses anything that runs: a script, an event handler, a javascript address", () => {
    expect(kinds(page("<script>alert(1)</script>"))).toContain("tag");
    expect(kinds(page("<SCRIPT SRC=x></SCRIPT>"))).toContain("tag");
    expect(kinds(page('<p onclick="x()">a</p>'))).toContain("attribute");
    expect(kinds(page('<p ONMOUSEOVER = "x()">a</p>'))).toContain("attribute");
    expect(kinds(page("<p onfocus=alert(1)>a</p>"))).toContain("attribute");
    expect(kinds(page('<a href="javascript:alert(1)">a</a>'))).toContain("link");
    expect(kinds(page('<a href="&#106;avascript:alert(1)">a</a>'))).toContain("link");
    expect(kinds(page('<a href=" javascript:alert(1)">a</a>'))).toContain("link");
    expect(kinds(page("<svg><script>alert(1)</script></svg>"))).toContain("tag");
    expect(kinds(page('<svg onload="x()"></svg>'))).toContain("attribute");
    expect(kinds(page('<svg><a href="javascript:x()"><text>a</text></a></svg>'))).toContain("link");
    expect(kinds(page('<button type="submit">a</button>'))).toContain("button type");
    expect(kinds(page('<form action="https://evil.example"><input></form>'))).toContain("tag");
  });

  it("refuses anything that reaches the network, in a tag, a style or an address", () => {
    for (const body of [
      '<img src="https://evil.example/x.png">',
      '<img src="data:image/png;base64,AAAA">',
      '<link rel="stylesheet" href="https://evil.example/a.css">',
      '<iframe src="https://evil.example"></iframe>',
      '<object data="https://evil.example"></object>',
      '<embed src="https://evil.example">',
      '<base href="https://evil.example/">',
      '<video src="x"></video>',
      '<a href="https://evil.example">x</a>',
      '<a href="//evil.example">x</a>',
      '<a href="ux-mockups/other.html">x</a>',
      '<p style="background:url(https://evil.example/x)">a</p>',
      '<p style="background:URL (x)">a</p>',
      '<p style="background:u\\72l(x)">a</p>',
      '<svg><image href="https://evil.example/x.png"/></svg>',
      '<svg><use href="https://evil.example/x.svg#a"/></svg>',
      "<svg><foreignObject><p>x</p></foreignObject></svg>",
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    ]) {
      expect(mockupFaults(page(body)).length, body).toBeGreaterThan(0);
    }
    for (const style of [
      "@import url(https://evil.example/a.css);",
      '@import "https://evil.example/a.css";',
      "@font-face{font-family:x;src:url(https://evil.example/f.woff)}",
      "body{background:image-set('x' 1x)}",
      "body{background:expression(alert(1))}",
      "body{behavior:x}",
      "body{--x:\\75rl(x)}",
    ]) {
      expect(mockupFaults(page("<p>a</p>", style)).length, style).toBeGreaterThan(0);
    }
  });

  it("refuses a refresh, another meta, a comment, a CDATA section and markup it cannot read", () => {
    const head = (meta: string) => page("<p>a</p>").replace("<title>", `${meta}<title>`);
    expect(
      kinds(head('<meta http-equiv="refresh" content="0;url=https://evil.example">')),
    ).toContain("meta");
    expect(kinds(head('<meta name="referrer" content="always">'))).toContain("meta");
    expect(kinds(page("<!-- <script>alert(1)</script> -->"))).toContain("markup");
    expect(kinds(page("<![CDATA[x]]>"))).toContain("markup");
    expect(kinds(page("<?xml version='1.0'?>"))).toContain("markup");
    expect(kinds(page("<p <script>alert(1)</script>"))).toContain("markup");
    expect(kinds(page("a < b"))).toContain("markup");
  });

  it("reads a style and a title as plain text: a closing tag in them cannot open markup", () => {
    expect(kinds(page("<p>a</p>", "</style><script>alert(1)</script>"))).toContain("tag");
    expect(kinds(page("<p>a</p>", "a{} <p>x</p>"))).toContain("markup");
    const title = page("<p>a</p>").replace(
      "<title>Home</title>",
      "<title></title><script>x</script>",
    );
    expect(mockupFaults(title).length).toBeGreaterThan(0);
    expect(kinds(page("<p>a</p>").replace("<title>Home</title>", ""))).toContain("title");
  });

  it("refuses text copied from the creator that is made of markup, or hides it in an attribute", () => {
    const pasted = [
      '"><script>alert(1)</script>',
      "<img src=x onerror=alert(1)>",
      "</div><iframe src=//evil.example></iframe>",
      "<svg/onload=alert(1)>",
      '<a href="x" title="</a><script>">y</a>',
    ];
    for (const payload of pasted) {
      expect(mockupFaults(page(`<p>${payload}</p>`)).length, payload).toBeGreaterThan(0);
    }
    // The same words, escaped as text, are text: the page shows them and runs nothing.
    const escaped = page(
      "<p>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img src=x&gt;</p>",
    );
    expect(mockupFaults(escaped)).toEqual([]);
    // A quote inside an attribute value is the value; a `<` in it is refused.
    expect(kinds(page('<p title="a > b">x</p>'))).toEqual([]);
    expect(kinds(page('<p title="<b>">x</p>'))).toContain("attribute");
  });

  it("refuses control characters and a name given twice, and names the first fault of each kind", () => {
    expect(kinds(`${page("<p>a</p>")}\u0000`)).toEqual(["character"]);
    expect(kinds(page('<p class="a" class="b">x</p>'))).toContain("attribute");
    const many = mockupFaults(page("<script>1</script><script>2</script><p onclick=x>a</p>"));
    expect(new Set(many.map((fault) => fault.problem)).size).toBe(many.length);
    for (const fault of many) expect(fault.detail.length).toBeLessThanOrEqual(60);
  });

  // Found by the review: pages a browser loaded something from, with no fault raised.
  it("applies the policy from the head only: no tag but html and head may stand before its meta", () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`;
    const url = '<div style="background:url(http://127.0.0.1:1/x)">x</div>';
    const moved = (inside: string) =>
      `<!doctype html><html><head><title>T</title>${inside}</head><body>${url}</body></html>`;
    expect(kinds(moved(`<textarea>${meta}</textarea>`))).toContain("policy");
    expect(kinds(moved(`<svg>${meta}</svg>`))).toContain("policy");
    expect(
      kinds(`<!doctype html><html><head><title>T</title></head><body>${url}${meta}</body></html>`),
    ).toContain("policy");
    // The metas of the charset and of the viewport, and the head's own tags, may come first.
    expect(kinds(page("<p>a</p>"))).toEqual([]);
    expect(
      kinds(
        `<!doctype html><html><head>${meta}<title>T</title></head><body><p>a</p></body></html>`,
      ),
    ).toEqual([]);
  });

  it("reads a character reference in a style as the browser does: it can spell what the list refuses", () => {
    for (const style of [
      "background:&#117;rl(http://127.0.0.1:1/x)",
      "background:&#x75;rl(http://127.0.0.1:1/x)",
      "background:&Tab;url(x)",
    ]) {
      expect(kinds(page(`<div style="${style}">x</div>`)), style).toContain("style");
      expect(kinds(page(`<svg><style>a{${style}}</style></svg>`)), style).toContain("style");
      expect(kinds(page("<p>a</p>", style)), style).toContain("style");
    }
    // A lone ampersand (a nested selector) is not a reference.
    expect(kinds(page("<p>a</p>", ".a{&:hover{color:red}}"))).toEqual([]);
  });

  it("reads the values of a drawing: no address, no function, whatever the attribute", () => {
    for (const body of [
      '<svg><rect fill="url(http://127.0.0.1:1/a.svg#p)"/></svg>',
      '<svg><rect fill="URL(#p)"/></svg>',
      '<svg><path d="javascript:alert(1)"/></svg>',
      '<svg><g transform="url(x)"/></svg>',
      '<svg><rect stroke="//evil.example/x"/></svg>',
    ]) {
      expect(kinds(page(body)), body).toContain("attribute");
    }
    const drawing =
      '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M0 0 L10.5,-3 C1 2 3 4 5 6z" fill="none" stroke="#1a1a1a" stroke-width="2"/><g transform="translate(2 2) rotate(45)"><circle cx="5" cy="5" r="2" fill="currentColor"/></g></svg>';
    expect(kinds(page(drawing))).toEqual([]);
  });

  it("finds the end of a style or a title wherever it is, and reads a long tag", () => {
    expect(
      kinds(page("<p>a</p>").replace("<title>Home</title>", "<title>İstanbul</title>")),
    ).toEqual([]);
    const path = `M0 0 ${"L1 1 ".repeat(1_200)}`;
    expect(kinds(page(`<svg><path d="${path}"/></svg>`))).toEqual([]);
    expect(kinds(page(`<svg><path d="${path.repeat(3)}"/></svg>`))).toContain("markup");
  });
});
