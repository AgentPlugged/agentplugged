import { describe, expect, it } from "vitest";
import { contrastRatio, hexOf, parseColor } from "./brand-color.js";
import { colorsIn, readCss, selectorIn, valueVariants } from "./brand-css.js";
import {
  type BrandRule,
  type BrandSource,
  checkBrandRules,
  flattenTokens,
  readRules,
  weakPairs,
} from "./brand-rules.js";

/** the fixed rules of the brand, applied to pages and style files. */

const TOKENS = flattenTokens({
  color: {
    ink: "#1B2A41",
    paper: "#F7F5F0",
    accent: "#D9480F",
    soft: "{color.paper}",
  },
  type: {
    display: { family: '"Fraunces", Georgia, serif', size: "32px" },
    body: "Inter, system-ui, sans-serif",
  },
  radius: { card: "16px", button: "10px" },
});

function rule(entry: Record<string, unknown>): BrandRule {
  const read = readRules([{ id: "r", text: "A rule.", ...entry }], TOKENS);
  expect(read.problems).toEqual([]);
  return read.rules[0] as BrandRule;
}

const css = (text: string): BrandSource[] => [{ path: "a.css", text, kind: "css" }];
const html = (style: string, body = ""): BrandSource[] => [
  {
    path: "p.html",
    text: `<!doctype html>\n<html><head><style>\n${style}\n</style></head><body>${body}</body></html>`,
    kind: "html",
  },
];
const run = (rules: BrandRule[], sources: BrandSource[]) => checkBrandRules(rules, TOKENS, sources);

describe("colours", () => {
  it("reads the forms it can read exactly, and nothing else", () => {
    expect(hexOf(parseColor("#D9480F") ?? { r: 0, g: 0, b: 0, a: 0 })).toBe("#d9480f");
    expect(hexOf(parseColor("#d40") ?? { r: 0, g: 0, b: 0, a: 0 })).toBe("#dd4400");
    expect(hexOf(parseColor("rgb(217 72 15)") ?? { r: 0, g: 0, b: 0, a: 0 })).toBe("#d9480f");
    expect(hexOf(parseColor("rgba(217, 72, 15, .5)") ?? { r: 0, g: 0, b: 0, a: 0 })).toBe(
      "#d9480f",
    );
    expect(hexOf(parseColor("hsl(0 100% 50%)") ?? { r: 0, g: 0, b: 0, a: 0 })).toBe("#ff0000");
    expect(hexOf(parseColor("Tomato") ?? { r: 0, g: 0, b: 0, a: 0 })).toBe("#ff6347");
    expect(parseColor("oklch(60% 0.2 40)")).toBeUndefined();
    expect(parseColor("#12")).toBeUndefined();
    expect(parseColor("color-mix(in srgb, red, blue)")).toBeUndefined();
  });

  it("computes the contrast of WCAG 2", () => {
    const black = parseColor("#000") ?? { r: 0, g: 0, b: 0, a: 1 };
    const white = parseColor("#fff") ?? { r: 0, g: 0, b: 0, a: 1 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    // #767676 on white is the usual limit: 4.54:1, and #777777 falls just under 4.5.
    expect(contrastRatio(parseColor("#767676") ?? white, white)).toBeGreaterThan(4.5);
    expect(contrastRatio(parseColor("#777777") ?? white, white)).toBeLessThan(4.5);
  });

  it("lists what a value spells, and what it could not read", () => {
    const found = colorsIn("1px solid #fff, 0 0 4px rgba(0,0,0,.2)", "border");
    expect(found.colors).toHaveLength(2);
    expect(colorsIn("oklch(60% .2 40)", "color").unread).toHaveLength(1);
    expect(colorsIn("color-mix(in srgb, #fff 50%, red)", "color").unread).toHaveLength(1);
    expect(colorsIn("Orange, serif", "font-family").colors).toHaveLength(0);
    expect(colorsIn("orange", "color").colors).toHaveLength(1);
  });
});

describe("reading CSS", () => {
  it("resolves nesting and custom properties", () => {
    const sheet = readCss(
      "x",
      ":root{--accent:#D9480F}\n.cta{ color:var(--accent); &:hover{ background:#fff } .icon{ fill:red } }",
      0,
    );
    const hover = sheet.declarations.find((d) => d.property === "background");
    expect(hover?.selectors).toEqual([".cta:hover"]);
    expect(sheet.declarations.find((d) => d.property === "fill")?.selectors).toEqual([
      ".cta .icon",
    ]);
    expect(valueVariants("var(--accent)", sheet.customs).values).toEqual(["#D9480F"]);
    expect(valueVariants("var(--nope, blue)", sheet.customs).values).toEqual(["blue"]);
  });

  it("takes the subject of a selector, never what is inside :not() or brackets", () => {
    expect(selectorIn(".card .cta:hover", [".cta"])).toBe(true);
    expect(selectorIn(".cta .other", [".cta"])).toBe(false);
    expect(selectorIn(".card:not(.cta)", [".cta"])).toBe(false);
    expect(selectorIn('[class~="cta"]', [".cta"])).toBe(false);
    expect(selectorIn("button.primary", ["button"])).toBe(true);
    expect(selectorIn("*", [".cta"])).toBe(false);
  });
});

describe("reading the rules", () => {
  it("names each problem with the rule", () => {
    const read = readRules(
      [
        { id: "ok", kind: "no_gradient", text: "None." },
        { id: "ok", kind: "no_gradient", text: "Twice." },
        {
          id: "bad-color",
          kind: "reserved_color",
          text: "x",
          color: "color.missing",
          only: [".a"],
        },
        {
          id: "bad-only",
          kind: "reserved_color",
          text: "x",
          color: "color.accent",
          only: ["a b"],
        },
        { id: "bad-kind", kind: "vibes", text: "x" },
        { id: "extra", kind: "manual", text: "x", only: [".a"] },
        { id: "no-text", kind: "manual" },
        {
          id: "family",
          kind: "font_role",
          text: "x",
          family: "type.nothing",
          only: [".q"],
        },
        {
          id: "radius",
          kind: "radius_scale",
          text: "x",
          allowed: ["radius.card", "13 pixels"],
        },
      ],
      TOKENS,
    );
    const names = read.problems.map((p) => p.rule);
    expect(names).toEqual(
      expect.arrayContaining([
        "ok",
        "bad-color",
        "bad-only",
        "bad-kind",
        "extra",
        "no-text",
        "family",
        "radius",
      ]),
    );
    expect(readRules("nope", TOKENS).problems).toHaveLength(1);
    expect(readRules([], TOKENS).problems).toHaveLength(1);
  });

  it("resolves aliases of tokens", () => {
    expect(TOKENS.get("color.soft")).toBe("#F7F5F0");
  });
});

describe("reserved colour", () => {
  const reserved = rule({
    kind: "reserved_color",
    color: "color.accent",
    only: [".cta", "#mic"],
  });

  it("accepts the colour on its elements, hover and nesting included", () => {
    const style =
      ".cta{background:#D9480F}.cta:hover{background:#d9480f}.card{ .cta{ color:#D9480F } }#mic{fill:#D9480F}";
    expect(run([reserved], css(style)).findings).toEqual([]);
  });

  it("names every other use: element, other spelling, variable, inline style, paint attribute", () => {
    const style = [
      ".card{border-color:#D9480F}",
      ".a{color:rgb(217 72 15)}",
      ".b{color:rgba(217,72,15,.5)}",
      ":root{--brand:#D9480F}",
      ".c{background:var(--brand)}",
      ".d:not(.cta){color:#D9480F}",
    ].join("\n");
    const found = run([reserved], css(style)).findings;
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 5, 6]);
    expect(found[0]?.rule).toBe("r");
    expect(found[0]?.detail).toContain("reserved to .cta, #mic");
    const inline = run(
      [reserved],
      html(".x{}", '<div style="color:#D9480F">a</div><svg><path fill="#D9480F"/></svg>'),
    ).findings;
    expect(inline).toHaveLength(2);
  });

  it("does not let a colour it cannot read through", () => {
    const found = run(
      [reserved],
      css(".x{color:oklch(60% .2 40)} .y{color:color-mix(in srgb,#D9480F,#fff)}"),
    ).findings;
    expect(found).toHaveLength(2);
    expect(found[0]?.detail).toContain("not readable");
    // a variable nobody defines, with no fallback, is not read either
    expect(run([reserved], css(".x{color:var(--unknown)}")).findings).toHaveLength(1);
  });

  it("reads the name of the colour as well", () => {
    const named = rule({
      id: "r2",
      kind: "reserved_color",
      color: "color.accent",
      only: [".cta"],
    });
    const tokens = flattenTokens({ color: { accent: "#ff6347" } });
    const read = readRules(
      [
        {
          id: "r2",
          kind: "reserved_color",
          text: "x",
          color: "color.accent",
          only: [".cta"],
        },
      ],
      tokens,
    );
    expect(named.kind).toBe("reserved_color");
    expect(checkBrandRules(read.rules, tokens, css(".x{color:tomato}")).findings).toHaveLength(1);
  });
});

describe("palette only", () => {
  const palette = rule({ kind: "palette_only", allow: ["#ffffff"] });
  it("accepts the palette, its alpha and the colours allowed, names the others", () => {
    const style =
      ".a{color:#1B2A41}.b{background:rgba(27,42,65,.5)}.c{color:#fff}.d{color:transparent}.e{color:#123456}.f{color:red}";
    const found = run([palette], css(style)).findings;
    expect(found.map((f) => f.line)).toEqual([1, 1]);
    expect(found.map((f) => f.detail).join("|")).toContain("#123456");
  });
});

describe("fonts", () => {
  const role = rule({
    id: "display",
    kind: "font_role",
    family: "type.display",
    only: [".question"],
  });
  const families = rule({
    id: "families",
    kind: "font_families",
    allowed: ["type.display", "type.body"],
  });

  it("reserves a family to its elements", () => {
    const style =
      '.question{font-family:"Fraunces",Georgia,serif}\n.title{font-family:Fraunces}\n.t2{font:italic 700 24px/1.2 Fraunces, serif}';
    const found = run([role], css(style)).findings;
    expect(found.map((f) => f.line)).toEqual([2, 3]);
  });

  it("closes the set of families", () => {
    const style =
      "body{font-family:Inter,system-ui,sans-serif}\n.x{font-family:'Comic Sans MS',cursive}\n.y{font:16px Papyrus}\n.z{font-family:var(--f)}";
    const found = run([families], css(style)).findings;
    expect(found.map((f) => f.line)).toEqual([2, 3, 4]);
  });
});

describe("radii", () => {
  const radii = rule({
    kind: "radius_scale",
    allowed: ["radius.card", "radius.button", "50%"],
  });
  it("accepts the scale, 0 and the listed shapes, names the rest", () => {
    const style =
      ".a{border-radius:16px}.b{border-radius:10px 0}.c{border-radius:50%}\n.d{border-radius:12px}\n.e{border-top-left-radius:999px}\n.f{border-radius:calc(1px + 2px)}";
    const found = run([radii], css(style)).findings;
    expect(found.map((f) => f.line)).toEqual([2, 3, 4]);
  });
});

describe("gradients", () => {
  const flat = rule({ kind: "no_gradient", except: [".photo"] });
  it("allows them where the rule says and nowhere else", () => {
    const style =
      ".photo{background:linear-gradient(red,blue)}\n.hero{background-image:radial-gradient(#fff,#000)}\n.v{--g:linear-gradient(red,blue)}.w{background:var(--g)}\n.z{background:repeating-conic-gradient(red 0 10%,blue 0 20%)}";
    const found = run([flat], css(style)).findings;
    expect(found.map((f) => f.line)).toEqual([2, 3, 4]);
  });
});

describe("contrast", () => {
  const aa = rule({ kind: "contrast" });
  it("computes the pair of a block, with the lower bar of large text", () => {
    const style = [
      ".ok{color:#1B2A41;background:#F7F5F0}",
      ".weak{color:#999;background:#fff}",
      ".big{color:#8a8a8a;background:#fff;font-size:28px}",
      ".big-weak{color:#bbb;background:#fff;font-size:28px}",
      ".bold{color:#8a8a8a;background:#fff;font-size:19px;font-weight:700}",
      ".over{color:rgba(0,0,0,.4);background:#fff}",
    ].join("\n");
    const result = run([aa], css(style));
    expect(result.findings.map((f) => f.line)).toEqual([2, 4, 6]);
    expect(result.findings[0]?.detail).toMatch(
      /#999999 on #ffffff: contrast 2\.85:1, minimum 4\.5:1/,
    );
    expect(result.findings[1]?.detail).toContain("large text");
  });

  it("says what it could not compute, rather than call it kept", () => {
    const result = run(
      [aa],
      css(".a{color:#000}.b{background:#fff}.c{color:#000;background:rgba(255,255,255,.5)}"),
    );
    expect(result.findings).toEqual([]);
    expect(result.undetermined.get("a.css")).toBe(3);
  });

  it("holds a stricter minimum and reads the pairs of tokens", () => {
    const strict = rule({
      kind: "contrast",
      min: 7,
      pairs: [
        ["color.ink", "color.paper"],
        ["color.accent", "color.paper"],
      ],
    });
    const weak = weakPairs(strict, TOKENS);
    expect(weak.map((w) => w.text)).toEqual(["color.accent"]);
    expect(weak[0]?.ratio).toBeLessThan(7);
    expect(
      readRules([{ id: "c", kind: "contrast", text: "x", min: 4 }], TOKENS).problems,
    ).toHaveLength(1);
  });
});

describe("rules no program can verify", () => {
  it("lists them", () => {
    const manual = rule({
      id: "m",
      kind: "manual",
      text: "Questions are always in italic serif.",
    });
    const result = run([manual], css(".a{color:red}"));
    expect(result.unverifiable.map((r) => r.id)).toEqual(["m"]);
    expect(result.findings).toEqual([]);
  });
});

describe("at most a few findings per rule and file", () => {
  it("cuts the list", () => {
    const flat = rule({ kind: "no_gradient" });
    const style = Array.from(
      { length: 12 },
      (_, n) => `.g${n}{background:linear-gradient(red,blue)}`,
    ).join("\n");
    expect(run([flat], css(style)).findings).toHaveLength(5);
  });
});

describe("themes, depth, SVG gradients, radius keywords, partial checks", () => {
  const contrast = () => rule({ kind: "contrast" });

  it("pairs the colours of a light and a dark scheme by condition", () => {
    const sheet =
      ":root{--bg:#fff;--fg:#111} @media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#fff}} body{color:var(--fg);background:var(--bg)}";
    const result = run([contrast()], css(sheet));
    expect(result.findings).toEqual([]);
    expect(result.undetermined.size).toBe(0);
  });

  it("still finds a weak pair inside one scheme", () => {
    const sheet =
      ":root{--bg:#fff;--fg:#111} @media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#222}} body{color:var(--fg);background:var(--bg)}";
    const result = run([contrast()], css(sheet));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.detail).toContain("#222222 on #111111");
  });

  it("says undetermined what cannot be paired", () => {
    const sheet =
      "@media (min-width:1px){body{color:var(--fg);background:#fff}} @media print{:root{--fg:#fff}}";
    const result = run([contrast()], css(sheet));
    expect(result.findings).toEqual([]);
    expect(result.undetermined.get("a.css")).toBe(1);
  });

  it("does not fall over on very deep nesting, and says so", () => {
    const result = run([contrast()], css("a{".repeat(20000)));
    expect(result.tooDeep.has("a.css")).toBe(true);
    expect(run([contrast()], css(".a{color:red}")).tooDeep.size).toBe(0);
  });

  it("sees SVG gradients", () => {
    const flat = rule({ kind: "no_gradient" });
    const page = html(
      "",
      '<svg><defs><linearGradient id="g"><stop offset="0"/></linearGradient><radialGradient id="h"/></defs></svg>',
    );
    expect(run([flat], page).findings).toHaveLength(2);
  });

  it("lets radius keywords through", () => {
    const scale = rule({
      kind: "radius_scale",
      allowed: ["radius.card", "radius.button"],
    });
    for (const keyword of ["inherit", "initial", "unset", "revert"]) {
      expect(run([scale], css(`.a{border-radius:${keyword}}`)).findings).toEqual([]);
    }
    expect(run([scale], css(".a{border-radius:7px}")).findings).toHaveLength(1);
  });

  it("says when too many values were cut", () => {
    const customs = Array.from({ length: 20 }, (_, n) => `.t${n}{--c:#${"abcdef"[n % 6]}00}`).join(
      "",
    );
    const palette = rule({ kind: "palette_only" });
    const result = run([palette], css(`${customs} a{color:var(--c)}`));
    expect(result.truncated.get("a.css")).toBe(1);
    expect(run([palette], css("a{color:red}")).truncated.size).toBe(0);
  });
});
