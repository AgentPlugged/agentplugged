import { describe, expect, it } from "vitest";
import { isTestPath } from "../reuse/code-files.js";
import { lineCount, readTests, testViolations } from "./test-rules.js";

/**
 * The rules of the tests for the guard before a write: what the words of a file show
 * for sure, in many languages. Every sample is a string, so this file holds nothing the rules read.
 */

const rows = (path: string, text: string) =>
  testViolations(path, text).map((violation) => `${violation.row}:${violation.line}`);

describe("a test isolated so that the others do not run (focused)", () => {
  it.each([
    ["a.test.ts", 'describe("a", () => {\n  it.only("b", () => {});\n});', "focused:2"],
    ["a.test.ts", 'test.describe.only("a", () => {});', "focused:1"],
    ["a.test.js", "fit('b', () => {});", "focused:1"],
    ["a.test.js", "fdescribe('b', () => {});", "focused:1"],
    ["a.spec.ts", "it.only.each([1, 2])('b', () => {});", "focused:1"],
    ["a_spec.rb", 'fit "does it" do\nend', "focused:1"],
    ["a_spec.rb", 'it "does it", focus: true do\nend', "focused:1"],
    ["a_spec.rb", 'it "does it", :focus do\nend', "focused:1"],
    ["a_test.dart", "test('a', () {}, solo: true);", "focused:1"],
  ])("refuses %s", (path, text, expected) => {
    expect(rows(path, text)).toEqual([expected]);
  });

  it("never reads a comment, a string or another receiver", () => {
    const text = [
      '// it.only("a") is what to avoid',
      'const note = "describe.only(x)";',
      "const pencil = { only() {} };",
      "pencil.only();",
      "fit(model);",
    ].join("\n");
    expect(rows("a.test.ts", text)).toEqual([]);
    // `fit` is a plain name in Python.
    expect(rows("test_a.py", "fit(model)\n")).toEqual([]);
  });
});

describe("a test disabled with no reason (skipped)", () => {
  it.each([
    ["a.test.ts", 'it.skip("a", () => {});', "skipped:1"],
    ["a.test.ts", 'describe.skip("a", () => {});', "skipped:1"],
    ["a.test.ts", 'xit("a", () => {});', "skipped:1"],
    ["a.test.ts", 'test.fixme("a", () => {});', "skipped:1"],
    ["a.test.ts", 'it.skip.each([1])("a", () => {});', "skipped:1"],
    ["a.test.ts", 'test.skip(browserName === "x", "no");', "skipped:1"],
    ["test_a.py", "@pytest.mark.skip\ndef test_a():\n    pass", "skipped:1"],
    ["test_a.py", "@pytest.mark.skip(reason='no')\ndef test_a():\n    pass", "skipped:1"],
    ["test_a.py", "def test_a():\n    pytest.skip()", "skipped:2"],
    ["a_test.go", "func TestA(t *testing.T) {\n\tt.Skip()\n}", "skipped:2"],
    ["a_test.go", "func TestA(t *testing.T) {\n\tt.SkipNow()\n}", "skipped:2"],
    ["ATest.java", "@Disabled\nvoid a() {}", "skipped:1"],
    ["ATest.java", "@Ignore\npublic void a() {}", "skipped:1"],
    ["ATest.kt", "@Disabled\nfun a() {}", "skipped:1"],
    ["ATests.cs", '[Fact(Skip = "no")]\npublic void A() {}', "skipped:1"],
    ["ATests.cs", "[Ignore]\npublic void A() {}", "skipped:1"],
    ["a_test.rs", "#[test]\n#[ignore]\nfn a() {}", "skipped:2"],
    ["a_spec.rb", 'xit "does it" do\nend', "skipped:1"],
    ["a_spec.rb", "skip\n", "skipped:1"],
    ["ATest.php", "$this->markTestSkipped();", "skipped:1"],
    ["ATests.swift", "throw XCTSkip()", "skipped:1"],
    ["a_test.dart", "test('a', () {}, skip: true);", "skipped:1"],
    ["a_test.cpp", "TEST(A, DISABLED_b) {}", "skipped:1"],
  ])("refuses %s", (path, text, expected) => {
    expect(rows(path, text)).toEqual([expected]);
  });

  it.each([
    ["a.test.ts", '// waits for the payment sandbox, ticket 4521\nit.skip("a", () => {});'],
    ["a.test.ts", 'it.skip("a", () => {}); // broken by the new calendar, redo with 5-2'],
    ["a.test.ts", '/* the sandbox is down until friday */ xit("a", () => {});'],
    ["a.test.ts", 'test.skip(isCi, "the sandbox is not reachable from the CI");'],
    ["test_a.py", "@pytest.mark.skip(reason='needs the payment sandbox')\ndef test_a():\n    pass"],
    ["test_a.py", "def test_a():\n    pytest.skip('no GPU on this machine')"],
    ["a_test.go", 'func TestA(t *testing.T) {\n\tt.Skip("needs the database container")\n}'],
    ["ATest.java", '@Disabled("flaky on the CI, see ticket 98")\nvoid a() {}'],
    ["ATests.cs", '[Fact(Skip = "needs the payment sandbox")]\npublic void A() {}'],
    ["a_test.rs", '#[ignore = "needs the network"]\nfn a() {}'],
    ["a_spec.rb", 'skip "needs the payment sandbox"'],
    ["a_test.dart", "test('a', () {}, skip: 'needs the browser');"],
    ["test_a.py", "# the bug is tracked in ticket 12\n@pytest.mark.skip\ndef test_a():\n    pass"],
  ])("lets through a reason written: %s", (path, text) => {
    expect(rows(path, text)).toEqual([]);
  });

  it("asks for words, not a filler or a linter's pragma", () => {
    expect(rows("a.test.ts", '// TODO\nit.skip("a", () => {});')).toEqual(["skipped:2"]);
    expect(
      rows("a.test.ts", '// eslint-disable-next-line no-skip\nit.skip("a", () => {});'),
    ).toEqual(["skipped:2"]);
    expect(rows("a.test.ts", '// skip\nit.skip("a", () => {});')).toEqual(["skipped:2"]);
  });

  it("does not take the name of a skipped test for its reason", () => {
    expect(rows("a.test.ts", 'it.skip("does the whole thing right", () => {});')).toEqual([
      "skipped:1",
    ]);
  });

  it("tells the block of Mocha from the skip of the running test of Vitest", () => {
    expect(
      rows("a.test.ts", 'it("a", (context) => {\n  context.skip("no keychain here");\n});'),
    ).toEqual([]);
    expect(rows("a.test.ts", "if (need) context.skip();")).toEqual([]);
    expect(rows("a.test.ts", 'context.skip("a", () => {});')).toEqual(["skipped:1"]);
  });

  it("leaves a todo and an ordinary skip of something else alone", () => {
    expect(rows("a.test.ts", 'it.todo("later");\nconst page = reader.skip(2);')).toEqual([]);
    expect(rows("test_a.py", "reader.skip(3)\nskip = 1")).toEqual([]);
  });
});

describe("a fixed wait (hard_wait)", () => {
  it.each([
    ["a.test.ts", "await page.waitForTimeout(500);", "hard_wait:1"],
    ["a.test.ts", "await new Promise((resolve) => setTimeout(resolve, 500));", "hard_wait:1"],
    ["a.test.ts", "await sleep(100);", "hard_wait:1"],
    ["a.cy.ts", "cy.wait(2000);", "hard_wait:1"],
    ["test_a.py", "def test_a():\n    time.sleep(2)", "hard_wait:2"],
    ["a_test.go", "func TestA(t *testing.T) {\n\ttime.Sleep(time.Second)\n}", "hard_wait:2"],
    ["ATest.java", "Thread.sleep(500);", "hard_wait:1"],
    ["ATests.cs", "await Task.Delay(500);", "hard_wait:1"],
    ["a_test.rs", "std::thread::sleep(std::time::Duration::from_millis(5));", "hard_wait:1"],
    ["a_spec.rb", "sleep 2", "hard_wait:1"],
    ["ATest.php", "usleep(1000);", "hard_wait:1"],
  ])("refuses %s", (path, text, expected) => {
    expect(rows(path, text)).toEqual([expected]);
  });

  it("lets through the interval of a poll, in a loop of any shape", () => {
    const js = "while (!(await ready())) {\n  await new Promise((r) => setTimeout(r, 50));\n}";
    expect(rows("a.test.ts", js)).toEqual([]);
    expect(rows("a.test.ts", "while (!done) await sleep(50);")).toEqual([]);
    expect(
      rows("test_a.py", "def wait():\n    while not ready():\n        time.sleep(0.1)"),
    ).toEqual([]);
    expect(rows("a_test.go", "for {\n\tif ok() {\n\t\tbreak\n\t}\n\ttime.Sleep(10)\n}")).toEqual(
      [],
    );
    // Beside a loop is not in it.
    expect(rows("a.test.ts", "for (const a of b) {\n  run(a);\n}\nawait sleep(50);")).toEqual([
      "hard_wait:4",
    ]);
  });

  it("lets through a wait of nothing, a definition, a mock, a fake clock and a reason", () => {
    expect(rows("a.test.ts", "await sleep(0);")).toEqual([]);
    expect(
      rows("a.test.ts", "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));"),
    ).toEqual([]);
    expect(rows("a.test.ts", "function sleep(ms) {}")).toEqual([]);
    expect(rows("a.test.ts", "const deps = { sleep: vi.fn() };")).toEqual([]);
    expect(rows("a.test.ts", 'vi.mock("./sleep");')).toEqual([]);
    expect(rows("a.test.ts", "vi.useFakeTimers();\nawait sleep(5000);")).toEqual([]);
    expect(
      rows("test_a.py", "@freeze_time('2020-01-01')\ndef test_a():\n    time.sleep(5)"),
    ).toEqual([]);
    expect(
      rows(
        "a.test.ts",
        "// the rate limiter counts real seconds, nothing else to watch\nawait sleep(1100);",
      ),
    ).toEqual([]);
    expect(rows("a.test.ts", "setTimeout(() => done(), 50);")).toEqual([]);
  });
});

describe("an assertion that cannot fail (tautology)", () => {
  it.each([
    ["a.test.ts", "expect(true).toBe(true);"],
    ["a.test.ts", "expect(1).toBe(1);"],
    ["a.test.ts", "expect(true).toBeTruthy();"],
    ["a.test.ts", "expect(false).toBeFalsy();"],
    ["a.test.ts", "expect(value).toBe(value);"],
    ["a.test.ts", "expect(user.name).toEqual(user.name);"],
    ["a.test.ts", "expect(true).to.equal(true);"],
    ["a.test.ts", "expect(true).to.be.true;"],
    ["a.test.ts", "assert(true);"],
    ["a.test.ts", "assert.ok(true);"],
    ["a.test.ts", "assert.equal(x, x);"],
    ["a.test.ts", "assert.strictEqual(1, 1);"],
    ["test_a.py", "def test_a():\n    assert x == x"],
    ["test_a.py", "def test_a():\n    assert True"],
    ["test_a.py", "def test_a():\n    assert 1 == 1, 'math'"],
    ["test_a.py", "def test_a(self):\n    self.assertTrue(True)"],
    ["test_a.py", "def test_a(self):\n    self.assertEqual(a, a)"],
    ["a_test.go", "func TestA(t *testing.T) {\n\tassert.Equal(t, got, got)\n}"],
    ["a_test.go", "func TestA(t *testing.T) {\n\tassert.True(t, true)\n}"],
    ["ATest.java", "assertEquals(1, 1);"],
    ["ATest.java", "assertTrue(true);"],
    ["ATest.java", "assertThat(x).isEqualTo(x);"],
    ["ATest.java", "assertThat(true).isTrue();"],
    ["ATests.cs", "Assert.True(true);"],
    ["ATests.cs", "Assert.Equal(x, x);"],
    ["a_test.rs", "assert!(true);"],
    ["a_test.rs", "assert_eq!(x, x);"],
    ["a_test.rs", 'assert_eq!(x, x, "same");'],
    ["a_spec.rb", "expect(true).to eq(true)"],
    ["a_spec.rb", "expect(x).to eq(x)"],
    ["a_spec.rb", "assert_equal x, x"],
    ["a_spec.rb", "assert true"],
    ["ATest.php", "$this->assertTrue(true);"],
    ["ATest.php", "$this->assertSame($x, $x);"],
  ])("refuses %s: %s", (path, text) => {
    const found = rows(path, text);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^tautology:/);
  });

  it.each([
    ["a.test.ts", "expect(result).toBe(true);"],
    ["a.test.ts", "expect(true).toBe(await check());"],
    ["a.test.ts", "expect(1).toBe(count);"],
    ["a.test.ts", "expect(f(1)).toBe(f(1));"],
    ["a.test.ts", "expect(screen.getByText('a')).toBeInTheDocument();"],
    ["a.test.ts", "expect(a).toBe(b);"],
    ["a.test.ts", "assert.equal(a, b);"],
    ["a.test.ts", "const ok = true; expect(ok).toBe(true);"],
    ["a.test.ts", "expect(x);"],
    ["a.test.ts", "expect(x).toBe(y);\nexpect(true)"],
    ["test_a.py", "def test_a():\n    assert x == y"],
    ["test_a.py", "def test_a():\n    assert f(x) == f(x)"],
    ["test_a.py", "def test_a():\n    assert result is not None"],
    ["test_a.py", "def test_a():\n    assert not False"],
    ["test_a.py", "def test_a(self):\n    self.assertTrue(result)"],
    ["a_test.go", "func TestA(t *testing.T) {\n\tassert.Equal(t, want, got)\n}"],
    ["a_test.go", "func TestA(t *testing.T) {\n\tassert.True(t, got)\n}"],
    ["a_test.rs", 'let v = r.expect("a message").len();'],
    ["a_test.rs", "assert_eq!(a, b);"],
    ["ATest.java", "assertEquals(expected, actual);"],
    ["ATest.java", 'assertTrue(user.isActive(), "active");'],
    ["a_spec.rb", "expect(x).to eq(y)"],
  ])("lets through %s: %s", (path, text) => {
    expect(rows(path, text)).toEqual([]);
  });

  it("says where, in a file of many tests", () => {
    const text = [
      'describe("a", () => {',
      '  it("b", () => {',
      "    expect(compute()).toBe(3);",
      "  });",
      '  it("c", () => {',
      "    expect(true).toBe(true);",
      "  });",
      "});",
    ].join("\n");
    expect(rows("a.test.ts", text)).toEqual(["tautology:6"]);
  });
});

describe("what it does not read", () => {
  it("never reads a comment or a string, whatever it says", () => {
    const text = [
      "// it.only('a'); sleep(5); expect(true).toBe(true);",
      "/* xit('a') */",
      'const sample = "expect(1).toBe(1); it.skip(x)";',
      "const raw = `",
      "  describe.only('x');",
      "`;",
    ].join("\n");
    expect(rows("a.test.ts", text)).toEqual([]);
  });

  it("lists the breaches in order of line, each once", () => {
    const text = 'it.only("a", () => {\n  sleep(10);\n  expect(1).toBe(1);\n});';
    expect(rows("a.test.ts", text)).toEqual(["focused:1", "hard_wait:2", "tautology:3"]);
  });

  it("reads a text of millions of characters in the time of a hook, whatever it repeats", () => {
    const hostile = [
      "it.skip(".repeat(300_000),
      "expect(".repeat(400_000),
      "assert ".repeat(400_000),
      '"'.repeat(2_000_000),
      "/*".repeat(1_000_000),
      "sleep(".repeat(400_000),
      "(".repeat(2_000_000),
    ];
    for (const text of hostile) {
      const started = Date.now();
      testViolations("a.test.ts", text);
      expect(Date.now() - started, text.slice(0, 10)).toBeLessThan(3000);
    }
  }, 60_000);
});

describe("what the review found", () => {
  it("lets a zero delay turn the event loop, and sees a loop in its other shapes", () => {
    expect(rows("a.test.ts", "await new Promise((r) => setTimeout(r, 0));")).toEqual([]);
    expect(rows("a.test.ts", "await new Promise((r) => setTimeout(r, 50));")).toEqual([
      "hard_wait:1",
    ]);
    expect(rows("a.test.cs", "while (!Ready())\n{\n    Thread.Sleep(50);\n}")).toEqual([]);
    expect(rows("a_spec.rb", "sleep 0.1 while !ready?")).toEqual([]);
    expect(rows("a.test.ts", "await waitFor(async () => {\n  await sleep(50);\n});")).toEqual([]);
  });

  it("is not switched off by a helper that happens to be called runTest", () => {
    expect(rows("a.test.ts", "const runTest = () => 1;\nawait sleep(500);")).toEqual([
      "hard_wait:2",
    ]);
  });

  it("sees a concurrent isolated test, and a fragment that ends on the mark", () => {
    expect(rows("a.test.ts", 'it.concurrent.only("a", () => {});')).toEqual(["focused:1"]);
    expect(rows("a.test.ts", "describe.only")).toEqual(["focused:1"]);
    expect(rows("a.test.ts", "const only = items.only;")).toEqual([]);
  });

  it("reads a text of long lines and deep indentation in the time of a hook", () => {
    const line = (indent: string, code: string) => `${indent}${code}\n`.repeat(3000);
    const wide = line(" ".repeat(1300), "sleep(1);");
    const tabs = line("\t".repeat(1300), "sleep(1);");
    const python = line("    ".repeat(250), "time.sleep(1)");
    for (const [path, text] of [
      ["a.test.ts", wide],
      ["a.test.ts", tabs],
      ["test_a.py", python],
    ] as const) {
      const started = Date.now();
      readTests(path, text);
      expect(Date.now() - started, path).toBeLessThan(2000);
    }
  }, 60_000);

  it("says when it read only part of a text", () => {
    expect(readTests("a.test.ts", "sleep(1);").partial).toBe(false);
    const hostile = "sleep(".repeat(3_000_000);
    expect(readTests("a.test.ts", hostile).partial).toBe(true);
  }, 60_000);
});

describe("which paths are files of tests", () => {
  it.each([
    ["src/a.test.ts", false, true],
    ["src/a.tests.ts", false, true],
    ["src/a-test.js", false, true],
    ["pkg/a_test.go", false, true],
    ["tests/test_a.py", false, true],
    ["src/OrderTest.java", false, true],
    ["src/CartSpec.scala", false, true],
    ["packages/build/src/a.test.ts", false, true],
    ["apps/bin/a.test.ts", false, true],
    ["tests/helpers/builders.ts", true, true],
    ["tests/helpers/builders.ts", false, false],
    ["e2e/pages/login.ts", true, true],
    ["src/ChangeSpec.java", false, false],
    ["src/app.ts", true, false],
    ["src/a.test.snap", false, false],
    ["docs/tests.md", true, false],
    ["node_modules/x/a.test.js", false, false],
    ["dist/a.test.js", false, false],
    ["src/a.d.ts", true, false],
  ])("%s (folders %s) is a test file: %s", (path, folders, expected) => {
    expect(isTestPath(path, folders)).toBe(expected);
  });
});

describe("the number of lines of a file", () => {
  it("does not count the end of the last line as another", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\n")).toBe(1);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\n\nb")).toBe(3);
  });
});
