import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  BRAND_PATH,
  type CommandContext,
  checkDocumentsDetailed,
  createCommandRegistry,
  type DocsCheckResult,
  type DocumentFile,
  IDENTITY_PAGE_PATH,
  IDENTITY_PATH,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

/** `docs check` on the brand platform, the identity and its fixed rules. */

const KB = `---
id: kb-index
kind: note
owner: zoe
links: []
---
# Map
`;
const UX_PATH = ".agentplugged/docs/ux.md";
const MOCKUP = ".agentplugged/docs/ux-mockups/screen-home.html";
const PUBLISHED = ".agentplugged/docs/launch/pages/home.md";

function platform(mutate: (body: string) => string = (body) => body): string {
  const body = `# Brand

## Mission

Help makers ship small things calmly.

## Values

- Calm: one decision per screen.
- Honest: we say what we do not know.
- Small: nothing that is not needed.

## Personality

- Warm, not chatty.
- Direct, not curt.
- Playful, not silly.

## Promise

Ship the small thing today.

## What the brand is not

- A productivity cult: it does not count your hours.
- A toy: it keeps your work safe.

## Voice and tone

- Speak to one person, in the second person.
- Sentences under twenty words.
- Name the problem before the fix.

| To say | To avoid |
| --- | --- |
| You can undo this. | Revolutionary undo engine |
| It did not save. Try again. | Oops! Something went wrong |

## Name and slogan

| Candidate | Why | Availability |
| --- | --- | --- |
| Tiny | short, says the size | domain and trademark: to verify at the registry |
`;
  return `---\nid: brand\nkind: note\nowner: julien\nlinks: [kb-index]\nlanguage: en\n---\n${mutate(body)}`;
}

const TOKENS = `tokens:
  color:
    ink: "#1B2A41"
    paper: "#F7F5F0"
    accent: "#B93A0B"
  type:
    display: { family: "Georgia, serif", size: 32px }
    body: "system-ui, sans-serif"
  radius:
    card: 16px
`;
const RULES = `brand_rules:
  - id: accent-reserved
    kind: reserved_color
    text: The accent leads to the main action.
    color: color.accent
    only: [".cta"]
  - id: palette-closed
    kind: palette_only
    text: No colour outside the palette.
  - id: flat
    kind: no_gradient
    text: No gradient.
  - id: radius-scale
    kind: radius_scale
    text: One radius.
    allowed: [radius.card]
  - id: contrast-aa
    kind: contrast
    text: AA.
    pairs: [[color.ink, color.paper]]
  - id: icons
    kind: manual
    text: Icons are outlined.
`;

function identity(
  options: { header?: string; mutate?: (body: string) => string; rules?: string } = {},
): string {
  const body = `# Identity

## Symbol and logotype

Two shapes that face each other.

### Light ground

Ink on paper.

### Dark ground

Paper on ink.

### App icon

The symbol alone.

## Palette

| Token | Role |
| --- | --- |
| \`color.ink\` | Text and titles, never a button |
| \`color.paper\` | The ground of screens |
| \`color.accent\` | The main action only |

## Typography

Georgia for titles, system for the rest.

## Signature object

The send button, in four states.

## Key screens

### Welcome

Settles the promise.

### Home

Settles the density.

### Done

Settles the reward.

## Fixed rules

- \`accent-reserved\`: the accent is for the action.
- \`palette-closed\`: three colours.
- \`flat\`: nothing to compete with the work.
- \`radius-scale\`: one radius.
- \`contrast-aa\`: legible by everyone.
- \`icons\`: outlined.
`;
  return `---\nid: identity\nkind: note\nowner: stella\nlinks: [brand]\nlanguage: en\n${options.header ?? TOKENS + (options.rules ?? RULES)}---\n${(options.mutate ?? ((text) => text))(body)}`;
}

const POLICY = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

function page(style: string, body = "<main><h1>Identity</h1></main>"): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}"><title>Identity</title><style>\n${style}\n</style></head><body>${body}</body></html>`;
}

const GOOD_STYLE =
  "body{background:#F7F5F0;color:#1B2A41}.cta{background:#B93A0B;color:#F7F5F0;border-radius:16px}.card{border-radius:16px}";

function check(
  files: Record<string, string>,
  extra: Partial<Parameters<typeof checkDocumentsDetailed>[0]> = {},
) {
  const current: DocumentFile[] = Object.entries({
    ".agentplugged/docs/index.md": KB,
    ...files,
  }).map(([path, text]) => ({ path, text }));
  return checkDocumentsDetailed({
    current,
    owners: new Set(["julien", "stella", "zoe"]),
    ...extra,
  });
}

const invalid = (result: ReturnType<typeof check>) =>
  result.problems
    .filter((problem) => problem.code === ErrorCode.LAUNCH_DOCUMENT_INVALID)
    .map((problem) => problem.details.reason);
const warnings = (result: ReturnType<typeof check>) => result.warnings.map((entry) => entry.reason);
const details = (result: ReturnType<typeof check>, reason: string) =>
  result.problems.filter((problem) => problem.details.reason === reason);

const GOOD = { [BRAND_PATH]: platform(), [IDENTITY_PATH]: identity() };

describe("the brand platform", () => {
  it("accepts a complete platform", () => {
    expect(
      check({ [BRAND_PATH]: platform() }).problems.map((p) => JSON.stringify(p.details)),
    ).toEqual([]);
  });

  it("names a missing, empty or doubled section", () => {
    const result = check({
      [BRAND_PATH]: platform((body) => body.replace(/## Mission\n\n.*\n/, "## Mission\n\n")),
    });
    expect(details(result, "brand_section")[0]?.details).toMatchObject({
      section: "mission",
      problem: "empty",
    });
    const twice = check({ [BRAND_PATH]: platform((body) => `${body}\n## Promise\n\nAnother.\n`) });
    expect(details(twice, "brand_section")[0]?.details).toMatchObject({ problem: "duplicate" });
  });

  it("wants a promise of one sentence on one line", () => {
    for (const promise of [
      "Ship it. Then rest.",
      "Ship it\n\nThen rest",
      `${"word ".repeat(60)}`,
    ]) {
      const result = check({
        [BRAND_PATH]: platform((body) => body.replace("Ship the small thing today.", promise)),
      });
      expect(invalid(result), promise).toContain("brand_promise");
    }
  });

  it("wants a voice with rules and filled examples in two columns", () => {
    const noTable = check({
      [BRAND_PATH]: platform((body) => body.replace(/\| To say[\s\S]*?\n\n/, "\n")),
    });
    expect(details(noTable, "brand_voice")[0]?.details.problem).toBe("columns");
    const halfFilled = check({
      [BRAND_PATH]: platform((body) => body.replace("| Oops! Something went wrong |", "|  |")),
    });
    expect(details(halfFilled, "brand_voice")[0]?.details.problem).toBe("examples");
    const fewRules = check({
      [BRAND_PATH]: platform((body) =>
        body.replace("- Sentences under twenty words.\n- Name the problem before the fix.\n", ""),
      ),
    });
    expect(details(fewRules, "brand_voice")[0]?.details.problem).toBe("rules");
  });

  it("wants at least two things the brand is not, and a name that is only a lead", () => {
    const one = check({
      [BRAND_PATH]: platform((body) => body.replace("- A toy: it keeps your work safe.\n", "")),
    });
    expect(details(one, "brand_section")[0]?.details.problem).toBe("few");
    const free = check({
      [BRAND_PATH]: platform((body) => body.replace("to verify at the registry", "free")),
    });
    expect(invalid(free)).toContain("brand_availability");
  });

  it("checks the header", () => {
    const result = check({
      [BRAND_PATH]: platform()
        .replace("owner: julien", "owner: stella")
        .replace("id: brand", "id: other"),
    });
    expect(details(result, "brand_header").map((p) => p.details.field)).toEqual(["id", "owner"]);
  });
});

describe("the voice read on the published pages", () => {
  it("warns on a phrase the voice says to avoid, not otherwise", () => {
    const page1 =
      "---\nid: page-home\nkind: note\nowner: julien\nlinks: [kb-index]\nlanguage: en\nseo:\n  intent: x\n  title: t\n  description: d\n  keywords:\n    - term: a\n      hypothesis: true\n---\n# Home\n\nOur Revolutionary undo engine saves you.\n";
    const result = check({ ...GOOD, [PUBLISHED]: page1 });
    expect(result.warnings.find((w) => w.reason === "brand_voice_avoid")?.details.phrase).toBe(
      "Revolutionary undo engine",
    );
    const clean = check({ ...GOOD, [PUBLISHED]: page1.replace("Revolutionary undo", "calm undo") });
    expect(warnings(clean)).not.toContain("brand_voice_avoid");
  });
});

describe("the identity", () => {
  it("accepts a complete identity, and lists the rule no program verifies", () => {
    const result = check(GOOD);
    expect(result.problems).toEqual([]);
    const unverifiable = result.warnings.find((w) => w.reason === "brand_rule_unverifiable");
    expect(unverifiable?.details).toMatchObject({ count: 1, rules: "icons" });
  });

  it("wants the three variants of the symbol and exactly three key screens", () => {
    const noIcon = check({
      ...GOOD,
      [IDENTITY_PATH]: identity({
        mutate: (b) => b.replace("### App icon\n\nThe symbol alone.", "### Other\n\nx."),
      }),
    });
    expect(details(noIcon, "brand_section")[0]?.details).toMatchObject({
      section: "symbol",
      problem: "variants",
      detail: "icon",
    });
    const two = check({
      ...GOOD,
      [IDENTITY_PATH]: identity({
        mutate: (b) => b.replace("### Done\n\nSettles the reward.\n", ""),
      }),
    });
    expect(details(two, "brand_section")[0]?.details).toMatchObject({
      section: "screens",
      problem: "count",
      found: 2,
    });
  });

  it("wants every colour with a role, and no role for a colour that does not exist", () => {
    const noRole = check({
      ...GOOD,
      [IDENTITY_PATH]: identity({
        mutate: (b) => b.replace("| `color.accent` | The main action only |\n", ""),
      }),
    });
    expect(details(noRole, "identity_palette")[0]?.details).toMatchObject({
      token: "color.accent",
      problem: "missing",
    });
    const bare = check({
      ...GOOD,
      [IDENTITY_PATH]: identity({ mutate: (b) => b.replace("The main action only", "Action") }),
    });
    expect(details(bare, "identity_palette")[0]?.details.problem).toBe("role");
    const ghost = check({
      ...GOOD,
      [IDENTITY_PATH]: identity({
        mutate: (b) =>
          b.replace("| `color.paper`", "| `color.ghost` | Nothing at all |\n| `color.paper`"),
      }),
    });
    expect(details(ghost, "identity_palette")[0]?.details).toMatchObject({
      token: "color.ghost",
      problem: "unknown",
    });
  });

  it("reads the tokens in the format of the UX specification", () => {
    const bad = check({
      ...GOOD,
      [IDENTITY_PATH]: identity({ header: `${TOKENS.replace('"#B93A0B"', "orange")}${RULES}` }),
    });
    expect(invalid(bad)).toContain("ux_tokens");
    const none = check({ ...GOOD, [IDENTITY_PATH]: identity({ header: RULES }) });
    expect(details(none, "brand_header")[0]?.details.field).toBe("tokens");
  });

  it("refuses a rule that is not declared in a verifiable form, or not written", () => {
    const bad = check({
      ...GOOD,
      [IDENTITY_PATH]: identity({
        header: `${TOKENS}brand_rules:\n  - id: vibes\n    kind: be-nice\n    text: x\n  - id: lone\n    kind: reserved_color\n    text: x\n    color: color.accent\n`,
      }),
    });
    expect(details(bad, "identity_rules").map((p) => p.details.rule)).toEqual(
      expect.arrayContaining(["vibes", "lone"]),
    );
    const unwritten = check({
      ...GOOD,
      [IDENTITY_PATH]: identity({
        mutate: (b) => b.replace("- `flat`: nothing to compete with the work.\n", ""),
      }),
    });
    expect(details(unwritten, "identity_rules")[0]?.details).toMatchObject({ rule: "flat" });
    const noRules = check({ ...GOOD, [IDENTITY_PATH]: identity({ header: TOKENS }) });
    expect(invalid(noRules)).toContain("identity_rules");
  });

  it("holds the declared pairs of colours to AA", () => {
    const rules = RULES.replace(
      "[[color.ink, color.paper]]",
      "[[color.accent, color.paper], [color.paper, color.accent]]",
    ).replace("kind: contrast", "kind: contrast\n    min: 7");
    const result = check({ ...GOOD, [IDENTITY_PATH]: identity({ rules }) });
    expect(details(result, "brand_rule")).toHaveLength(2);
    expect(details(result, "brand_rule")[0]?.details.detail).toMatch(
      /color\.accent on color\.paper: contrast \d\.\d\d:1, minimum 7:1/,
    );
  });

  it("warns when the identity builds on a platform that is not validated", () => {
    const result = check(GOOD, { validations: { checkpoints: [], now: 0 } });
    expect(warnings(result)).toContain("brand_not_validated");
  });
});

describe("the fixed rules applied to the files", () => {
  const files = (style: string, extra: Record<string, string> = {}) =>
    new Map([[IDENTITY_PAGE_PATH, page(style)], ...Object.entries(extra)]);

  it("passes a page that keeps every rule", () => {
    const result = check(GOOD, { brandFiles: files(GOOD_STYLE) });
    expect(result.problems).toEqual([]);
  });

  it("says the page is absent, only when the files were read", () => {
    expect(warnings(check(GOOD, { brandFiles: new Map() }))).toContain("identity_page_absent");
    expect(warnings(check(GOOD))).not.toContain("identity_page_absent");
  });

  it("names each gap with the rule, the file and the line", () => {
    const style =
      ".card{background:#B93A0B}\n.x{background:linear-gradient(#fff,#000)}\n.y{border-radius:9px}\n.z{color:#123456}";
    const result = check(GOOD, { brandFiles: files(style) });
    const found = details(result, "brand_rule");
    expect(found.map((p) => p.details.rule).sort()).toEqual(
      [
        "accent-reserved",
        "flat",
        "palette-closed",
        "palette-closed",
        "palette-closed",
        "radius-scale",
      ].sort(),
    );
    const accent = found.find((p) => p.details.rule === "accent-reserved");
    expect(accent?.details.path).toBe(IDENTITY_PAGE_PATH);
    expect(accent?.details.line).toBe(3);
    expect(accent?.message_key).toBe("error.launch_document_invalid.brand_rule");
  });

  it("applies them to the mock-up pages of the UX", () => {
    const mockups = new Map([[MOCKUP, page(".a{color:#B93A0B}")]]);
    const result = check(GOOD, { brandFiles: new Map(), mockups });
    expect(details(result, "brand_rule").map((p) => p.details.path)).toEqual([MOCKUP]);
  });

  it("refuses an identity page that is not safe, and does not apply the rules to it", () => {
    const unsafe = page(GOOD_STYLE, "<script>alert(1)</script>");
    const result = check(GOOD, { brandFiles: new Map([[IDENTITY_PAGE_PATH, unsafe]]) });
    expect(details(result, "identity_page")[0]?.details).toMatchObject({ problem: "tag" });
    expect(details(result, "brand_rule")).toEqual([]);
    const network = page("@import url(https://x.test/a.css);");
    expect(
      details(
        check(GOOD, { brandFiles: new Map([[IDENTITY_PAGE_PATH, network]]) }),
        "identity_page",
      ),
    ).toHaveLength(1);
    const big = page(GOOD_STYLE, `<p>${"x".repeat(61_000)}</p>`);
    expect(
      details(check(GOOD, { brandFiles: new Map([[IDENTITY_PAGE_PATH, big]]) }), "identity_page")[0]
        ?.details.problem,
    ).toBe("size");
  });

  it("does not let a hostile text reach the page through the engine", () => {
    // Findings quote the page: a long or markup-laden value is cut to a line and never raw.
    const style = `.a{background:#B93A0B; --x:"</style><script>"}\n.b{color:#B93A0B}`;
    const result = check(GOOD, { brandFiles: files(style) });
    for (const problem of result.problems) {
      expect(String(problem.details.detail ?? "").length).toBeLessThan(200);
    }
  });

  it("reads the style files the identity lists, and only relative .css paths", () => {
    const header = `${TOKENS}${RULES}style_files: [src/theme.css]\n`;
    const withFile = { ...GOOD, [IDENTITY_PATH]: identity({ header }) };
    const ok = check(withFile, {
      brandFiles: files(GOOD_STYLE, { "src/theme.css": ".btn{color:#B93A0B}" }),
    });
    expect(details(ok, "brand_rule").map((p) => p.details.path)).toEqual(["src/theme.css"]);
    const missing = check(withFile, { brandFiles: files(GOOD_STYLE) });
    expect(details(missing, "identity_styles")[0]?.details.problem).toBe("missing");
    for (const bad of ["../x.css", "/etc/a.css", "src/theme.js", "C:/a.css", "a\\\\b.css"]) {
      const result = check(
        {
          ...GOOD,
          [IDENTITY_PATH]: identity({ header: `${TOKENS}${RULES}style_files: ["${bad}"]\n` }),
        },
        { brandFiles: files(GOOD_STYLE) },
      );
      expect(details(result, "identity_styles")[0]?.details.problem, bad).toBe("path");
    }
  });
});

describe("the UX specification and the identity", () => {
  const ux = (tokens: string) =>
    `---\nid: ux\nkind: ux\nowner: stella\nlinks: [kb-index]\n${tokens}---\n# UX\n\n## Brand and style\n\nPrimary {color.accent} on {color.paper}.\n`;

  it("takes the tokens of the identity by name", () => {
    const result = check({ ...GOOD, [UX_PATH]: ux("") });
    expect(details(result, "ux_token_undefined")).toEqual([]);
  });

  it("names a token the specification gives another value", () => {
    const result = check({ ...GOOD, [UX_PATH]: ux('tokens:\n  color:\n    accent: "#00FF00"\n') });
    expect(details(result, "identity_drift")[0]?.details).toMatchObject({ token: "color.accent" });
    const same = check({ ...GOOD, [UX_PATH]: ux('tokens:\n  color:\n    accent: "#b93a0b"\n') });
    expect(details(same, "identity_drift")).toEqual([]);
  });

  it("still names a token that neither defines", () => {
    const result = check({
      ...GOOD,
      [UX_PATH]: ux("").replace("{color.paper}", "{color.nowhere}"),
    });
    expect(details(result, "ux_token_undefined")[0]?.details.token).toBe("color.nowhere");
  });
});

describe("the command reads the identity page and the style files", () => {
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
  const run = async (files: MemoryFiles) => {
    const result = await createCommandRegistry().run("docs", context(files), { action: "check" });
    if (!result.ok) throw new Error("docs check failed");
    return result.value as DocsCheckResult;
  };
  const seeded = (header: string) =>
    new MemoryFiles({
      ".agentplugged/docs/index.md": KB,
      [BRAND_PATH]: platform(),
      [IDENTITY_PATH]: identity({ header }),
      [IDENTITY_PAGE_PATH]: page(GOOD_STYLE),
      "src/theme.css": ".btn{background:#B93A0B}",
    });

  it("passes when everything holds, and writes nothing", async () => {
    const files = seeded(TOKENS + RULES);
    const result = await run(files);
    expect(result.problems).toEqual([]);
    expect(files.writes).toEqual([]);
  });

  it("applies the rules to the listed style files, and never reads one it was not given", async () => {
    const listed = await run(seeded(`${TOKENS}${RULES}style_files: [src/theme.css]\n`));
    expect(listed.problems.map((p) => [p.details.rule, p.details.path])).toEqual([
      ["accent-reserved", "src/theme.css"],
    ]);
    const unlisted = await run(seeded(TOKENS + RULES));
    expect(unlisted.problems).toEqual([]);
    const outside = await run(seeded(`${TOKENS}${RULES}style_files: ["../secret.css"]\n`));
    expect(outside.problems.map((p) => p.details.reason)).toEqual(["identity_styles"]);
  });
});
