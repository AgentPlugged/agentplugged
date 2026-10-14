import { describe, expect, it } from "vitest";
import {
  addedLines,
  applyMutation,
  describeMutation,
  type Mutation,
  proposeMutations,
  selectMutations,
} from "./mutations.js";

/**
 * The mutations of a change, pure: small, deterministic breaks found in
 * the lines a story added, in any language, never inside a string or a comment, never in a test.
 */

const everyLine = (text: string) =>
  new Set(Array.from({ length: text.split("\n").length }, (_, index) => index + 1));

const propose = (path: string, text: string, only?: number[]) =>
  proposeMutations(path, text, only === undefined ? everyLine(text) : new Set(only));

const swaps = (mutations: readonly Mutation[]) =>
  mutations.map((mutation) => `${mutation.kind}:${mutation.from.trim()}->${mutation.to.trim()}`);

describe("the breaks, language by language", () => {
  it("turns a comparison, a boolean, a logic operator and a constant in TypeScript", () => {
    const text = [
      "export function allowed(age: number, member: boolean): boolean {",
      "  if (age >= 18 && member === true) {",
      "    return true;",
      "  }",
      "  return age > 65 || retries == 3;",
      "}",
    ].join("\n");
    const found = swaps(propose("src/allowed.ts", text));
    expect(found).toContain("comparison:>=-><");
    expect(found).toContain("comparison:===->!==");
    expect(found).toContain("logic:&&->||");
    expect(found).toContain("logic:||->&&");
    expect(found).toContain("boolean:true->false");
    expect(found).toContain("comparison:>-><=");
    expect(found).toContain("comparison:==->!=");
    expect(found).toContain("number:18->19");
    expect(found).toContain("number:65->66");
    expect(found).toContain("number:3->4");
    // The condition is negated inside its own brackets.
    expect(found).toContain(
      "condition:age >= 18 && member === true->!(age >= 18 && member === true)",
    );
  });

  it("reads Python: and/or, True/False, `if x:` negated, a returned value dropped", () => {
    const text = [
      "def can_enter(user, limit):",
      "    if user.age >= limit and user.active:",
      "        return True",
      "    return user.score",
    ].join("\n");
    const found = swaps(propose("app/gate.py", text));
    expect(found).toContain("logic:and->or");
    expect(found).toContain("boolean:True->False");
    expect(found).toContain("comparison:>=-><");
    expect(found).toContain(
      "condition:user.age >= limit and user.active->not (user.age >= limit and user.active)",
    );
    expect(found).toContain("return:user.score->None");
  });

  it("reads Go: a condition without brackets, a bare return, `!=`", () => {
    const text = [
      "func Check(n int, err error) (int, error) {",
      "\tif err != nil {",
      "\t\treturn 0, err",
      "\t}",
      "\tif n > 10 {",
      "\t\treturn",
      "\t}",
      "\treturn n, nil",
      "}",
    ].join("\n");
    const found = swaps(propose("pkg/check.go", text));
    expect(found).toContain("comparison:!=->==");
    expect(found).toContain("condition:err != nil->!(err != nil)");
    expect(found).toContain("number:10->11");
    expect(found).toContain("return:return->;");
    // Go has no `nil`-like value that fits every return: no value is dropped.
    expect(
      found.filter((entry) => entry.startsWith("return:") && entry !== "return:return->;"),
    ).toEqual([]);
  });

  it("reads Rust, Java, Ruby and PHP with their own nothing", () => {
    expect(
      swaps(
        propose(
          "src/lib.rs",
          "fn f(x: i32) -> bool {\n    if x < 3 { return true; }\n    x == 7\n}",
        ),
      ),
    ).toEqual(expect.arrayContaining(["boolean:true->false", "number:3->4", "comparison:==->!="]));
    expect(
      swaps(
        propose(
          "src/Lib.java",
          "class A { int f(int x) { if (x != 0) { return x * 2; } return -1; } }",
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "comparison:!=->==",
        "return:x * 2->null",
        "condition:x != 0->!(x != 0)",
      ]),
    );
    expect(
      swaps(propose("lib/a.rb", "def f(x)\n  return x if x == 1 or x == 2\n  return nil\nend")),
    ).toEqual(expect.arrayContaining(["logic:or->and", "comparison:==->!=", "number:1->2"]));
    expect(swaps(propose("src/a.php", "<?php function f($x) { return $x > 5 ? 1 : 0; }"))).toEqual(
      expect.arrayContaining(["comparison:>-><=", "number:5->6", "return:$x > 5 ? 1 : 0->null"]),
    );
  });

  it("reads C: a comparison and a bare return", () => {
    const found = swaps(
      propose("src/a.c", "int f(int x) {\n  if (x <= 2) return;\n  return x + 1;\n}"),
    );
    expect(found).toContain("comparison:<=->>");
    expect(found).toContain("return:return->;");
    // C has no nothing to return: the value of `return x + 1` is left.
    expect(found).not.toContain("return:x + 1->null");
  });
});

describe("what it never breaks", () => {
  it("leaves strings, comments, generics, arrows, imports and test files alone", () => {
    const text = [
      'import { a } from "./a";',
      "// if (x == 1) return true;",
      'const note = "x == 1 and y < 2 and true";',
      "const map: Map<string, number> = new Map();",
      "const f = (x: number) => x;",
      "/* while (a > b) {} */",
    ].join("\n");
    expect(propose("src/plain.ts", text)).toEqual([]);
    const test = "it('x', () => { expect(a == 1).toBe(true); });";
    expect(propose("src/plain.test.ts", test)).toEqual([]);
    expect(propose("README.md", "a == b")).toEqual([]);
    expect(propose("src/generated.min.js", "if (a == 1) { return true }")).toEqual([]);
  });

  it("leaves a condition that holds a statement alone (Go's `if v, ok := m[k]; ok`)", () => {
    const go = 'func f(m map[string]int) {\n\tif v, ok := m["a"]; ok {\n\t\tg(v)\n\t}\n}';
    expect(
      swaps(propose("pkg/a.go", go)).filter((entry) => entry.startsWith("condition:")),
    ).toEqual([]);
  });

  it("leaves shell redirections and Rust `if let` and closures alone", () => {
    expect(propose("bin/run.sh", "cat < in.txt > out.txt\n")).toEqual([]);
    const rust = "fn f(o: Option<i32>) {\n    if let Some(x) = o { g(x) }\n    let h = || x;\n}";
    expect(swaps(propose("src/a.rs", rust))).toEqual([]);
  });

  it("does not touch a word of the language that merely looks like a table key", () => {
    // `constructor` and `toString` are names of the object's own members, never operators.
    const text = "const o = { constructor: 1, toString: 2 };\nif (constructor) { toString(); }";
    const found = swaps(propose("src/a.ts", text));
    expect(found).toContain("number:1->2");
    expect(
      found.some((entry) => /^(?:comparison|logic|boolean):(?:constructor|toString)/.test(entry)),
    ).toBe(false);
  });

  it("only moves the lines the change added", () => {
    const text = "const a = x == 1;\nconst b = y == 2;\nconst c = z == 3;";
    expect(swaps(propose("src/a.ts", text, [2]))).toEqual(["comparison:==->!=", "number:2->3"]);
    expect(propose("src/a.ts", text, [])).toEqual([]);
  });

  it("reads the added lines of a diff's new side", () => {
    expect([
      ...addedLines(
        new Map([
          [1, 1],
          [2, null],
          [3, null],
          [4, 3],
        ]),
      ),
    ]).toEqual([2, 3]);
  });
});

describe("applying a break", () => {
  const text = "if (a < b) {\n  return a;\n}\n";

  it("replaces the text where the break was found and refuses a text that moved", () => {
    const [first] = propose("src/a.ts", text).filter((mutation) => mutation.kind === "comparison");
    expect(first).toBeDefined();
    const broken = applyMutation(text, first as Mutation);
    expect(broken).toBe("if (a >= b) {\n  return a;\n}\n");
    expect(applyMutation(`// moved\n${text}`, first as Mutation)).toBeUndefined();
  });

  it("puts a line in a sentence for the answer", () => {
    const [first] = propose("src/a.ts", text);
    expect(describeMutation(first as Mutation)).toMatch(/^src\/a\.ts:1 \w+ `.+` -> `.+`$/);
  });
});

describe("the choice is bounded, spread and always the same", () => {
  const files = ["src/a.ts", "src/b.ts", "src/c.ts"].map((path) => ({
    path,
    text: "if (a < b && c == 1) { return x > 2; }\nconst ok = true;\n",
  }));
  const all = files.flatMap((file) => propose(file.path, file.text));

  it("takes at most the bound", () => {
    expect(selectMutations(all, 4)).toHaveLength(4);
    expect(selectMutations(all, 1000)).toHaveLength(all.length);
    expect(selectMutations([], 5)).toEqual([]);
  });

  it("spreads over the files and the kinds before taking a second of the same", () => {
    const chosen = selectMutations(all, 3);
    expect(new Set(chosen.map((mutation) => mutation.path)).size).toBe(3);
    const six = selectMutations(all, 6);
    expect(new Set(six.map((mutation) => `${mutation.path}:${mutation.kind}`)).size).toBe(6);
  });

  it("gives the same mutations for the same change, whatever the order they come in", () => {
    const one = selectMutations(all, 7).map(describeMutation);
    const two = selectMutations([...all].reverse(), 7).map(describeMutation);
    expect(two).toEqual(one);
  });
});
