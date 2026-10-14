import { describe, expect, it } from "vitest";
import { type CommandContext, createCommandRegistry, type DocsCheckResult } from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { checkDocuments } from "./check-docs.js";
import { pagePolicy } from "./deck-page.js";
import { parseDocumentFile } from "./parse-document.js";
import { uxDocumentChecks, uxElementsOf } from "./ux-documents.js";

const UX = ".agentplugged/docs/ux.md";
const PAGES = ".agentplugged/docs/ux-mockups/";

const TOKENS = `tokens:
  color:
    background: { light: "#FFFFFF", dark: "#111111" }
    primary: "#0F62FE"
    on-primary: "{color.background.light}"
  type:
    body: { family: "system-ui", size: 16px, weight: 400 }
  space:
    "1": 4px
    "2": 8px
  radius:
    md: 8px
`;

const HOME_SKETCH = `### Home

\`\`\`
+------------------+
| [1] header       |
| [2] task list    |
| [3] add button   |
+------------------+
\`\`\`

1. Header: the date and the count of tasks.
2. Task list: one row per task.
3. Add button: opens the new task.
`;

const BODY = `# UX

## Brand and style

The primary {color.primary} on {color.background}, text in {type.body}, gaps {space.2}, corners {radius.md}.

## Information architecture

| Screen | Purpose | Journeys | Reached from |
| --- | --- | --- | --- |
| Home | See the day | PU-1 | Launch |
| Settings | Change things | PU-1 | Home |

## Key screens

| Screen | Mock-up |
| --- | --- |
| Home | [Home](ux-mockups/screen-home.html) |
| Settings | [Settings](ux-mockups/screen-settings.html) |

## Screen sketches

${HOME_SKETCH}
### Settings

\`\`\`
[1] title
[2] options
\`\`\`

1. Title.
2. Options list.

## Elements to build

| Id | Kind | Element | Where |
| --- | --- | --- | --- |
| UX-1 | component | Task row | Home |
| UX-2 | state | Empty list | Home |
| UX-3 | accessibility | Focus ring on the add button | Home |
`;

function ux(extra = "", body = BODY, header = "") {
  return `---\nid: ux\nkind: ux\nowner: stella\nlinks: [prd]\n${header}${extra === "" ? TOKENS : extra}---\n${body}`;
}

const page = (title: string) =>
  "<!doctype html>\n" +
  '<html lang="en"><head><meta charset="utf-8">' +
  `<meta http-equiv="Content-Security-Policy" content="${pagePolicy()}">` +
  `<title>${title}</title><style>body{margin:0}</style></head><body><p>${title}</p></body></html>`;

const PRD =
  "---\nid: prd\nkind: prd\nowner: maya\nlinks: []\n---\n# PRD\n\n- PU-1: A user plans the day.\n- EF-1: The user adds a task.\n";

function story(id: string, context: string, outOfScope = "- Nothing.") {
  return {
    path: `.agentplugged/stories/${id}.md`,
    text: `---\nid: ${id}\nkind: story\nowner: sam\nlinks: [prd]\ntitle: "A story"\nepic: epic-1\nreviewer: quentin\nrequirements: [EF-1]\nbudget_usd: 5\nbranch: feat/${id}-x\ndepends_on: []\n---\n# ${id}\n\n## Context\n\n${context}\n\n## Intent\n\nBuild it.\n\n## Acceptance criteria\n\n- Given a, when b, then c.\n\n## Out of scope\n\n${outOfScope}\n`,
  };
}

const EPIC = {
  path: ".agentplugged/epics/epic-1.md",
  text: "---\nid: epic-1\nkind: epic\nowner: izzy\nlinks: [prd]\n---\n# Epic 1\n\n## Dependency graph\n\n- 1-1: none\n",
};

function run(
  text: string,
  mockups?: Record<string, string>,
  more: Array<{ path: string; text: string }> = [],
) {
  const files = [{ path: UX, text }, ...more];
  const documents = files.map((file) => parseDocumentFile(file.path, file.text));
  const texts = new Map(files.map((file) => [file.path, file.text]));
  return uxDocumentChecks({
    documents,
    textOf: (path) => texts.get(path),
    ...(mockups === undefined ? {} : { mockups: new Map(Object.entries(mockups)) }),
  });
}

const reasons = (found: { problems: Array<{ details: Record<string, unknown> }> }) =>
  found.problems.map((problem) => String(problem.details.reason));

const PAGES_OK = {
  [`${PAGES}screen-home.html`]: page("Home"),
  [`${PAGES}screen-settings.html`]: page("Settings"),
};

describe("the design tokens of the header", () => {
  it("accepts a specification whose every used token is defined, aliases and light/dark included", () => {
    expect(run(ux(), PAGES_OK)).toEqual({ problems: [], warnings: [] });
  });

  it("names a token that is used and defined nowhere, once, on the line that uses it", () => {
    const found = run(
      ux("", BODY.replace("{radius.md}", "{radius.xl} and {radius.xl} and {color.accent}")),
      PAGES_OK,
    );
    expect(found.problems.map((p) => [p.details.reason, p.details.token])).toEqual([
      ["ux_token_undefined", "radius.xl"],
      ["ux_token_undefined", "color.accent"],
    ]);
    expect(found.problems[0]?.details.line).toBe(
      ux("", BODY)
        .split("\n")
        .findIndex((line) => line.includes("The primary")) + 1,
    );
  });

  it("follows a group down to its leaves, and refuses a token that stops short or goes past", () => {
    const body =
      "{color.background.light} {color.background} {type.body.size} {type.body.size.x} {space.3}";
    const found = run(ux("", `${BODY}\n${body}\n`), PAGES_OK);
    expect(found.problems.map((p) => p.details.token)).toEqual(["type.body.size.x", "space.3"]);
  });

  it("refuses a block that is not valid: an unknown group, a colour that is not hexadecimal, an empty map", () => {
    const bad = (tokens: string) =>
      reasons(run(ux(tokens, BODY.replace(/\{[a-z0-9.-]+\}/g, "")), PAGES_OK));
    expect(bad("tokens:\n  colour: { a: 1 }\n")).toEqual(["ux_tokens"]);
    expect(bad('tokens:\n  color: { primary: "blue" }\n')).toEqual(["ux_tokens"]);
    expect(bad('tokens:\n  color: { primary: "#0F62FE (sample)" }\n')).toEqual(["ux_tokens"]);
    expect(bad("tokens:\n  space: {}\n")).toEqual(["ux_tokens"]);
    expect(bad("tokens: [a, b]\n")).toEqual(["ux_tokens"]);
    expect(bad("tokens:\n  type: { body: { a: { b: { c: { d: 1 } } } } }\n")).toEqual([
      "ux_tokens",
    ]);
    expect(bad('tokens:\n  color: { "bad key": "#000" }\n')).toEqual(["ux_tokens"]);
    expect(bad("tokens:\n  space: { x: '<script>' }\n")).toEqual(["ux_tokens"]);
  });

  it("refuses an alias to a token that does not exist", () => {
    const tokens = 'tokens:\n  color:\n    a: "#000000"\n    b: "{color.nope}"\n';
    expect(run(ux(tokens, "# UX\n"), {}).problems.map((p) => p.details.token)).toEqual([
      "color.nope",
    ]);
  });

  it("ignores what is in a comment or a code fence, and reads a token in inline code", () => {
    const body =
      "# UX\n<!-- {color.ghost} -->\n```\n{color.ghost2}\n```\nUse `{color.primary}`. {color.ghost3}\n";
    expect(run(ux("", body), {}).problems.map((p) => p.details.token)).toEqual(["color.ghost3"]);
  });

  it("reads the names of a specification written before as bold or bare as well", () => {
    const legacy =
      "# UX\n\n| Token | Value |\n| --- | --- |\n| **color.primary** | #0F62FE |\n| radius.md | 8px |\n\n{color.primary} {radius.md} {radius.xl}\n";
    expect(run(ux("tokens-not: 1\n", legacy), {}).problems.map((p) => p.details.token)).toEqual([
      "radius.xl",
    ]);
  });

  it("builds on a UI system: its tokens are named {ui.…}, defined only when the header declares it", () => {
    const body = "# UX\nThe {ui.button} with {color.primary}.\n";
    expect(run(ux("", body), {}).problems.map((p) => p.details.token)).toEqual(["ui.button"]);
    expect(run(ux("", body, "ui_system: shadcn\n"), {}).problems).toEqual([]);
    expect(run(ux("", body, 'ui_system: ""\n'), {}).problems.map((p) => p.details.token)).toEqual([
      "ui.button",
    ]);
  });

  it("still reads a specification written before the header held the tokens (names in tables)", () => {
    const legacy =
      "# UX\n\n| Token | Value |\n| --- | --- |\n| `color.primary` | #0F62FE |\n\nUse {color.primary} and {color.other}.\n";
    expect(run(ux("tokens-not: 1\n", legacy), {}).problems.map((p) => p.details.token)).toEqual([
      "color.other",
    ]);
  });
});

describe("the elements UX-n and their coverage by stories", () => {
  it("lists the elements of the table, with their line, retired ones marked", () => {
    const elements = uxElementsOf(
      ux("", `${BODY}\n| UX-9 | state | (retired) Old state | Home |\n`),
    );
    expect(elements.map((e) => [e.id, e.retired])).toEqual([
      ["UX-1", false],
      ["UX-2", false],
      ["UX-3", false],
      ["UX-9", true],
    ]);
    expect(uxElementsOf(ux("", "UX-4 opens a line\n"))).toEqual([]);
  });

  it("refuses an element defined twice", () => {
    const found = run(ux("", `${BODY}\n| UX-2 | state | Again | Home |\n`), PAGES_OK);
    expect(found.problems.map((p) => [p.details.reason, p.details.id])).toEqual([
      ["ux_element_duplicate", "UX-2"],
    ]);
  });

  it("needs nothing from stories before there is one, then names each element no story carries", () => {
    expect(run(ux(), PAGES_OK).problems).toEqual([]);
    const one = story("1-1", "- UX-1 and `UX-3` are built here.", "- UX-2 is left to later.");
    const found = run(ux(), PAGES_OK, [one, EPIC]);
    expect(found.problems.map((p) => [p.details.reason, p.details.id])).toEqual([
      ["ux_element_uncovered", "UX-2"],
    ]);
    const two = story("1-2", "- The empty list: UX-2.");
    expect(run(ux(), PAGES_OK, [one, two, EPIC]).problems).toEqual([]);
  });

  it("does not take UX-12 for UX-1, and lets a retired element go", () => {
    const text = ux("", `${BODY}\n| UX-4 | state | (retired) Gone | Home |\n`);
    const found = run(text, PAGES_OK, [story("1-1", "- UX-12 only, UX-3."), EPIC]);
    expect(found.problems.map((p) => p.details.id)).toEqual(["UX-1", "UX-2"]);
  });
});

describe("the key screens, their sketches and their mock-up pages", () => {
  it("wants a page for each key screen, linked from its row, or the creator's word that there is none", () => {
    const noLink = BODY.replace("[Settings](ux-mockups/screen-settings.html)", "Settings page");
    expect(
      run(ux("", noLink), PAGES_OK).problems.map((p) => [p.details.reason, p.details.screen]),
    ).toEqual([["ux_screen_unmocked", "Settings"]]);
    const chosen = BODY.replace("[Settings](ux-mockups/screen-settings.html)", "none");
    const found = run(ux("", chosen), { [`${PAGES}screen-home.html`]: page("Home") });
    expect(found.problems).toEqual([]);
    expect(found.warnings.map((w) => [w.reason, w.details.screen])).toEqual([
      ["ux_screen_tables_only", "Settings"],
    ]);
    const french = BODY.replace("[Settings](ux-mockups/screen-settings.html)", "aucune");
    expect(run(ux("", french), { [`${PAGES}screen-home.html`]: page("Home") }).problems).toEqual(
      [],
    );
  });

  it("checks that every linked page exists, only when the pages were read", () => {
    const found = run(ux(), { [`${PAGES}screen-home.html`]: page("Home") });
    expect(found.problems.map((p) => [p.details.reason, p.details.target])).toEqual([
      ["ux_mockup_missing", "ux-mockups/screen-settings.html"],
    ]);
    expect(run(ux()).problems).toEqual([]);
  });

  it("keeps a link inside the folder, flat, in lowercase: nothing that leaves it or goes elsewhere", () => {
    for (const target of [
      "../../etc/screen.html",
      "ux-mockups/../ux.html",
      "ux-mockups/Screen.html",
      "ux-mockups/a/b.html",
      "/ux-mockups/screen-home.html",
      "other/screen-home.html",
      "screen-home.html",
      "ux-mockups/screen-home.htm",
    ]) {
      const found = run(ux("", `${BODY}\nSee [x](${target}).\n`), PAGES_OK);
      expect(reasons(found), target).toContain("ux_mockup_path");
    }
    // A link to the web is none of this check's business, and an anchor in a page is the page.
    const fine = run(
      ux(
        "",
        `${BODY}\n[web](https://example.org/a.html) [home](ux-mockups/screen-home.html#top)\n`,
      ),
      PAGES_OK,
    );
    expect(fine.problems).toEqual([]);
  });

  it("wants a sketch for each key screen: a drawing with marked regions, a numbered list that matches", () => {
    const without = BODY.replace(HOME_SKETCH, "");
    expect(
      run(ux("", without), PAGES_OK).problems.map((p) => [p.details.screen, p.details.problem]),
    ).toEqual([["Home", "missing"]]);
    const cases: Array<[string, string]> = [
      [HOME_SKETCH.replace(/```[\s\S]*?```\n/, ""), "drawing"],
      [HOME_SKETCH.replace("3. Add button: opens the new task.\n", ""), "marks"],
      [
        HOME_SKETCH.replace("2. Task list", "3. Task list").replace(
          "3. Add button",
          "4. Add button",
        ),
        "regions",
      ],
      [HOME_SKETCH.replace("[3] add button", "[9] add button"), "marks"],
    ];
    for (const [sketch, problem] of cases) {
      const found = run(ux("", BODY.replace(HOME_SKETCH, sketch)), PAGES_OK);
      expect(
        found.problems.map((p) => p.details.problem),
        problem,
      ).toEqual([problem === "marks" ? "marks" : problem]);
    }
    const one = HOME_SKETCH.replace(/\n2\. .*\n3\. .*\n/, "\n")
      .replace("[2] task list", "")
      .replace("[3] add button", "");
    expect(
      run(ux("", BODY.replace(HOME_SKETCH, one)), PAGES_OK).problems.map((p) => p.details.problem),
    ).toEqual(["regions"]);
  });

  it("asks a sketch for the screens of the architecture too, once the specification has sketches", () => {
    const more = BODY.replace(
      "| Settings | Change things | PU-1 | Home |",
      "| Settings | Change things | PU-1 | Home |\n| Help | Read | PU-1 | Home |",
    );
    expect(run(ux("", more), PAGES_OK).problems.map((p) => p.details.screen)).toEqual(["Help"]);
    // A specification with no sketch section at all, nor key screens, is left as it was.
    const old =
      "# UX\n\n## Information architecture\n\n| Screen | Purpose |\n| --- | --- |\n| Home | See |\n";
    expect(run(ux("", old), {})).toEqual({ problems: [], warnings: [] });
  });

  it("takes the creator's word that the tables stand alone only from the column of the page", () => {
    const hijacked = BODY.replace(
      "| Settings | [Settings](ux-mockups/screen-settings.html) |",
      "| Settings | (nothing yet) none |",
    );
    expect(
      run(ux("", hijacked), PAGES_OK).problems.map((p) => [p.details.reason, p.details.screen]),
    ).toEqual([["ux_screen_unmocked", "Settings"]]);
    const elsewhere = BODY.replace(
      "| Settings | [Settings](ux-mockups/screen-settings.html) |",
      "| Settings | | none |",
    );
    expect(run(ux("", elsewhere), PAGES_OK).problems.map((p) => p.details.reason)).toEqual([
      "ux_screen_unmocked",
    ]);
  });

  it("finds a link written with a reference, and a sketch whose list is nested", () => {
    const referenced = BODY.replace(
      "[Settings](ux-mockups/screen-settings.html)",
      "[Settings][s]",
    ).concat("\n[s]: ux-mockups/screen-settings.html\n");
    expect(run(ux("", referenced), PAGES_OK)).toEqual({ problems: [], warnings: [] });
    const gone = run(ux("", referenced.replace("screen-settings.html", "gone.html")), PAGES_OK);
    expect(gone.problems.map((p) => p.details.reason)).toEqual(["ux_mockup_missing"]);
    const nested = HOME_SKETCH.replace(
      "3. Add button: opens the new task.",
      "3. Add button: opens it.\n   1) the form\n   2) the focus",
    );
    expect(run(ux("", BODY.replace(HOME_SKETCH, nested)), PAGES_OK).problems).toEqual([]);
  });

  it("warns when a specification draws fewer than two or more than four key screens", () => {
    const few = BODY.replace(/\| Settings \| \[Settings\].*\n/, "");
    expect(
      run(ux("", few), PAGES_OK).warnings.map((w) => [w.reason, w.details.count]),
    ).toContainEqual(["ux_key_screens_count", 1]);
  });
});

describe("the pages themselves", () => {
  it("accepts pages that stand alone and warns about a page no link leads to", () => {
    const found = run(ux(), { ...PAGES_OK, [`${PAGES}directions.html`]: page("Directions") });
    expect(found.problems).toEqual([]);
    expect(found.warnings.map((w) => [w.reason, w.details.path])).toEqual([
      ["ux_mockup_orphan", `${PAGES}directions.html`],
    ]);
  });

  it("caps the size of a page and the number of pages", () => {
    const big = page("Big").replace("<p>Big</p>", `<p>${"x".repeat(30_100)}</p>`);
    const found = run(ux(), { ...PAGES_OK, [`${PAGES}screen-home.html`]: big });
    expect(found.problems.map((p) => [p.details.reason, p.details.field, p.details.path])).toEqual([
      ["ux_mockup_size", "bytes", `${PAGES}screen-home.html`],
    ]);
    const many = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`${PAGES}p-${index}.html`, page("P")]),
    );
    expect(reasons(run(ux(), { ...PAGES_OK, ...many }))).toContain("ux_mockup_size");
    // The size is in bytes of the text, not in characters.
    const accents = page("A").replace("<p>A</p>", `<p>${"é".repeat(15_100)}</p>`);
    expect(reasons(run(ux(), { ...PAGES_OK, [`${PAGES}screen-home.html`]: accents }))).toEqual([
      "ux_mockup_size",
    ]);
  });

  it("names a page that is not safe, with the first thing wrong in it", () => {
    const evil = page("Home").replace(
      "<p>Home</p>",
      '<img src="https://evil.example/x.png"><script>alert(1)</script>',
    );
    const found = run(ux(), { ...PAGES_OK, [`${PAGES}screen-home.html`]: evil });
    expect(
      found.problems.map((p) => [p.details.reason, p.details.path, p.details.problem]),
    ).toEqual([["ux_mockup_unsafe", `${PAGES}screen-home.html`, "tag"]]);
  });

  it("refuses a file name that is not a flat lowercase page name", () => {
    const found = run(ux(), {
      ...PAGES_OK,
      [`${PAGES}Bad Name.html`]: page("x"),
      [`${PAGES}sub/a.html`]: page("x"),
    });
    expect(reasons(found)).toEqual(["ux_mockup_path", "ux_mockup_path"]);
  });
});

describe("docs check carries these rules", () => {
  it("reports them through checkDocuments as problems of the LAUNCH_DOCUMENT_INVALID family, sorted", () => {
    const documents = [
      { path: UX, text: ux("", BODY.replace("{radius.md}", "{radius.xl}")) },
      { path: ".agentplugged/docs/prd.md", text: PRD },
    ];
    const problems = checkDocuments({
      current: documents,
      owners: new Set(["stella", "maya"]),
      mockups: new Map(Object.entries(PAGES_OK)),
    });
    expect(problems.map((p) => [p.code, p.message_key, p.details.token])).toEqual([
      ["LAUNCH_DOCUMENT_INVALID", "error.launch_document_invalid.ux_token_undefined", "radius.xl"],
    ]);
    // Without the pages read, the links are not followed: nothing else changes.
    expect(checkDocuments({ current: documents, owners: new Set(["stella", "maya"]) }).length).toBe(
      1,
    );
  });
});

describe("the command reads the pages of the folder", () => {
  const context = (files: MemoryFiles): CommandContext => ({
    files,
    tools: {
      which: async () => undefined,
      version: async () => undefined,
      extensions: async () => [],
    },
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.2.3",
    docsBase: {
      read: async () => ({ found: false, reason: "no_commit" }),
      readBlobs: async () => new Map(),
      blobsInHistory: async () => new Set(),
    },
  });
  const check = async (files: MemoryFiles) => {
    const result = await createCommandRegistry().run("docs", context(files), { action: "check" });
    if (!result.ok) throw new Error("docs check failed");
    return result.value as DocsCheckResult;
  };
  const seeded = () =>
    new MemoryFiles({
      [UX]: ux(),
      ".agentplugged/docs/prd.md": PRD,
      ...PAGES_OK,
    });

  it("passes a specification whose pages are there and safe, and writes nothing", async () => {
    const files = seeded();
    const result = await check(files);
    expect(result.problems).toEqual([]);
    expect(result.documents).toBe(2);
    expect(files.writes).toEqual([]);
  });

  it("fails on a missing page, an unsafe page, and names what is not a page", async () => {
    const files = seeded();
    files.seed(
      `${PAGES}screen-settings.html`,
      page("Settings").replace("<p>", "<script>x()</script><p>"),
    );
    files.seed(`${PAGES}notes.txt`, "<script>not a page</script>");
    await files.remove(`${PAGES}screen-home.html`);
    const result = await check(files);
    expect(result.problems.map((p) => [p.details.reason, p.details.path])).toEqual([
      ["ux_mockup_path", `${PAGES}notes.txt`],
      ["ux_mockup_unsafe", `${PAGES}screen-settings.html`],
      ["ux_mockup_missing", UX],
    ]);
    expect(result.problems.every((p) => p.code === "LAUNCH_DOCUMENT_INVALID")).toBe(true);
  });

  it("names a file of another kind or another spelling in the folder, whatever it holds", async () => {
    const files = seeded();
    for (const name of ["a.svg", "b.htm", "C.html", "d.xhtml", "sub/e.html"]) {
      files.seed(`${PAGES}${name}`, "<script>alert(1)</script>");
    }
    const result = await check(files);
    expect(
      result.problems.map((p) => [p.details.reason, String(p.details.path).slice(PAGES.length)]),
    ).toEqual([
      ["ux_mockup_path", "C.html"],
      ["ux_mockup_path", "a.svg"],
      ["ux_mockup_path", "b.htm"],
      ["ux_mockup_path", "d.xhtml"],
      ["ux_mockup_path", "sub/e.html"],
    ]);
  });
});
