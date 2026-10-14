import { normalizedFolder, ProofsFileSchema } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { MemoryFiles } from "../testing/memory-files.js";
import { proofDecisions } from "./proof-accord.js";
import {
  PROOFS_PATH,
  proofFingerprint,
  readProofDeclaration,
  resolvedCommand,
} from "./proof-declaration.js";
import { isSecretVariable, parseCommandLine } from "./proof-line.js";
import {
  cleanOutput,
  lastLine,
  measuredAfter,
  safeOutput,
  usefulLines,
  wholeOutput,
} from "./proof-output.js";

/**
 * The pure rules of the proofs the engine produces: how a line is read, which
 * variables stay behind, what makes a fingerprint, what the declaration may hold, and what is kept
 * of an output.
 */

describe("a command line (no shell when the line allows it)", () => {
  it("splits a program and its arguments, quotes included, without a shell", () => {
    expect(parseCommandLine("npm test")).toEqual({ kind: "argv", argv: ["npm", "test"] });
    expect(parseCommandLine('node -e "console.log(1 + 1)" --flag=a')).toEqual({
      kind: "argv",
      argv: ["node", "-e", "console.log(1 + 1)", "--flag=a"],
    });
    expect(parseCommandLine("vitest run 'a b' ''")).toEqual({
      kind: "argv",
      argv: ["vitest", "run", "a b", ""],
    });
    // A Windows path stays as written: the backslash is not an escape.
    expect(parseCommandLine(String.raw`.\node_modules\.bin\vitest run`)).toEqual({
      kind: "argv",
      argv: [String.raw`.\node_modules\.bin\vitest`, "run"],
    });
    expect(parseCommandLine('echo "say \\"hi\\""')).toEqual({
      kind: "argv",
      argv: ["echo", 'say "hi"'],
    });
  });

  it("sends the shell's own syntax to the shell, and never guesses", () => {
    for (const line of [
      "npm test && npm run lint",
      "npm test | tee out.txt",
      "npm test > out.txt",
      "echo $HOME",
      'echo "$HOME"',
      "echo `date`",
      "eslint src/**/*.ts",
      "FOO=1 npm test",
      "echo %PATH%",
      "(cd app && npm test)",
      "ls ~/project",
      "cmd1; cmd2",
    ]) {
      expect(parseCommandLine(line), line).toEqual({ kind: "shell" });
    }
    // Inside single quotes nothing is special, and a glob in quotes is the program's own.
    expect(parseCommandLine("grep 'a|b$' file")).toEqual({
      kind: "argv",
      argv: ["grep", "a|b$", "file"],
    });
    expect(parseCommandLine('eslint "src/**/*.ts"')).toEqual({
      kind: "argv",
      argv: ["eslint", "src/**/*.ts"],
    });
  });

  it("refuses a line it cannot read", () => {
    expect(parseCommandLine('echo "open')).toEqual({ kind: "invalid", reason: "unbalanced_quote" });
    expect(parseCommandLine("   ")).toEqual({ kind: "invalid", reason: "empty" });
  });
});

describe("the environment of a command (no secret)", () => {
  it("recognises the variables that hold, or may hold, a secret", () => {
    for (const name of [
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "STRIPE_API_KEY",
      "DB_PASSWORD",
      "DATABASE_URL",
      "SSH_AUTH_SOCK",
      "OPENAI_KEY",
      "session_cookie",
      "SENTRY_DSN",
    ]) {
      expect(isSecretVariable(name), name).toBe(true);
    }
    for (const name of ["PATH", "HOME", "PWD", "GIT_AUTHOR_NAME", "NODE_ENV", "LANG", "TEMP"]) {
      expect(isSecretVariable(name), name).toBe(false);
    }
    for (const name of [
      "HTTPS_PROXY",
      "GITHUB_PAT",
      "PGPASSFILE",
      "GIT_CONFIG_PARAMETERS",
      "SSH_ASKPASS",
    ]) {
      expect(isSecretVariable(name), name).toBe(true);
    }
    // A value that carries the credentials of an address goes too, whatever the name.
    expect(isSecretVariable("REGISTRY", "https://user:pass@registry.example.com/")).toBe(true);
    expect(isSecretVariable("REGISTRY", "https://registry.example.com/")).toBe(false);
  });
});

describe("the fingerprint of a command (the least change asks again)", () => {
  const base = {
    name: "tests",
    run: "npm test",
    cwd: ".",
    timeout: 300,
    proves: ["ENF-2", "ENF-1"],
  };

  it("is the same for the same command, whatever the order of what it proves", () => {
    expect(proofFingerprint(base)).toMatch(/^[0-9a-f]{24}$/);
    expect(proofFingerprint({ ...base, proves: ["ENF-1", "ENF-2"] })).toBe(proofFingerprint(base));
  });

  it("changes with the name, the line, the folder, the limit, what it proves or how it measures", () => {
    const seen = new Set([proofFingerprint(base)]);
    for (const change of [
      { name: "unit" },
      { run: "npm test " },
      { run: "npm  test" },
      { run: "npm run test" },
      { cwd: "app" },
      { timeout: 301 },
      { proves: ["ENF-1"] },
      { proves: ["ENF-1", "ENF-2", "ENF-3"] },
      { measured_after: "p95=" },
    ]) {
      seen.add(proofFingerprint({ ...base, ...change }));
    }
    expect(seen.size).toBe(10);
  });

  it("is computed on the command with its defaults filled in", () => {
    const resolved = resolvedCommand({ name: "tests", run: "npm test", proves: ["ENF-2"] });
    expect(resolved).toMatchObject({ cwd: ".", timeout: 300, shell: false });
    expect(resolvedCommand({ name: "a", run: "a | b", proves: ["ENF-2"] }).shell).toBe(true);
    expect(normalizedFolder("./app/")).toBe("app");
    expect(normalizedFolder(undefined)).toBe(".");
  });
});

describe(".agentplugged/proofs.yaml (what the project declares)", () => {
  const read = (text: string | undefined) =>
    readProofDeclaration(new MemoryFiles(text === undefined ? {} : { [PROOFS_PATH]: text }));

  it("declares nothing when the file is absent", async () => {
    expect(await read(undefined)).toEqual({ kind: "none" });
    expect(await read("")).toEqual({ kind: "commands", commands: [] });
  });

  it("reads each command with its defaults and its fingerprint", async () => {
    const declared = await read(
      [
        "commands:",
        "  - name: tests",
        "    run: npm test",
        "    proves: [enf-2]",
        "  - name: bench",
        "    run: node bench.mjs",
        "    cwd: ./perf/",
        "    timeout: 60",
        "    proves: [ENF-1]",
        '    measured_after: "p95_ms="',
      ].join("\n"),
    );
    expect(declared).toMatchObject({ kind: "commands" });
    if (declared.kind !== "commands") return;
    expect(
      declared.commands.map((command) => [command.name, command.cwd, command.timeout]),
    ).toEqual([
      ["tests", ".", 300],
      ["bench", "perf", 60],
    ]);
    expect(declared.commands[0]?.proves).toEqual(["ENF-2"]);
    expect(declared.commands[1]?.measured_after).toBe("p95_ms=");
  });

  it("refuses, with where, what it cannot run", async () => {
    const invalid = async (text: string) => {
      const declared = await read(text);
      expect(declared.kind).toBe("invalid");
      return declared.kind === "invalid" ? declared.problems.join(" | ") : "";
    };
    // Outside the project, or hidden characters, or no requirement, or the same name twice.
    expect(
      await invalid("commands:\n  - { name: t, run: npm test, cwd: ../x, proves: [ENF-1] }"),
    ).toContain("commands.0.cwd");
    expect(
      await invalid("commands:\n  - { name: t, run: npm test, cwd: /etc, proves: [ENF-1] }"),
    ).toContain("commands.0.cwd");
    // A command that proves no requirement is the tests of the criteria, and says so with its mark.
    expect(await invalid("commands:\n  - { name: t, run: npm test }")).toContain(
      "commands.0.proves",
    );
    expect(
      await read(
        ["commands:", "  - name: t", "    run: npx vitest run -t {criterion}", ""].join("\n"),
      ),
    ).toMatchObject({ kind: "commands" });
    expect(await invalid("commands:\n  - { name: t, run: npm test, proves: [X-1] }")).toContain(
      "commands.0.proves",
    );
    expect(await invalid("commands:\n  - { name: T, run: npm test, proves: [ENF-1] }")).toContain(
      "commands.0.name",
    );
    expect(
      await invalid('commands:\n  - { name: t, run: "npm test\\u202e", proves: [ENF-1] }'),
    ).toContain("commands.0.run");
    expect(
      await invalid('commands:\n  - { name: t, run: "echo \\"open", proves: [ENF-1] }'),
    ).toContain("a quote is not closed");
    expect(
      await invalid("commands:\n  - { name: t, run: a, proves: [ENF-1], extra: 1 }"),
    ).toContain("commands.0");
    expect(
      await invalid(
        "commands:\n  - { name: t, run: a, proves: [ENF-1] }\n  - { name: t, run: b, proves: [ENF-2] }",
      ),
    ).toContain("names must differ");
    expect(await invalid("commands: [")).toContain(PROOFS_PATH);
    // The same schema serves the protocol.
    expect(ProofsFileSchema.safeParse({ commands: [] }).success).toBe(true);
  });
});

describe("what is kept of an output", () => {
  it("masks the secrets an output shows, in every shape the engine knows", () => {
    const secrets = [
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      "npm_abcdefghijklmnopqrstuvwxyz0123456789",
      "sk-live-abcdefghijklmnopqrstuvwxyz",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrst",
      "Bearer abcdefghijklmnop",
    ];
    for (const secret of secrets) {
      const masked = safeOutput({ head: `token was ${secret} ok`, tail: "", omitted: 0 });
      expect(masked, secret).not.toContain(secret.slice(-12));
      expect(masked).toContain("[secret]");
    }
    expect(
      safeOutput({ head: "password=hunter2 and api_key: abc123", tail: "", omitted: 0 }),
    ).not.toMatch(/hunter2|abc123/);
    // The word may sit inside a name, or in a JSON key.
    const embedded = safeOutput({
      head: 'DB_PASSWORD=hunter2 API_TOKEN=abc123 {"password": "p4ss w0rd"} Authorization: zzz999',
      tail: "",
      omitted: 0,
    });
    expect(embedded).not.toMatch(/hunter2|abc123|p4ss|zzz999/);
    expect(
      safeOutput({ head: "clone https://user:pass@github.com/a/b", tail: "", omitted: 0 }),
    ).not.toContain("user:pass");
    expect(
      safeOutput({
        head: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
        tail: "",
        omitted: 0,
      }),
    ).not.toContain("MIIEvQ");
    // A plain message is left alone.
    expect(safeOutput({ head: "12 tests passed in src/app.ts", tail: "", omitted: 0 })).toBe(
      "12 tests passed in src/app.ts",
    );
  });

  it("drops the word a cut would leave half, so that no start of a secret survives", () => {
    const whole = wholeOutput({
      head: "start of the output ghp_abcdefghijklmnop",
      tail: "qrstuvwxyz0123456789 end of the output",
      omitted: 4096,
    });
    expect(whole).toContain("4096 bytes of output not kept");
    expect(whole).not.toContain("ghp_");
    expect(whole).not.toContain("qrstuv");
    expect(whole).toContain("start of the output");
    expect(whole).toContain("end of the output");
  });

  it("cleans the escape sequences and the control characters of a terminal", () => {
    expect(cleanOutput("\u001b[31mred\u001b[0m\r\nprogress 10%\rprogress 100%\n\u0007bell")).toBe(
      "red\nprogress 100%\n bell",
    );
  });

  it("keeps a few useful lines of a failure, bounded, and the last line of a success", () => {
    const output = [
      "> project@1.0.0 test",
      ...Array.from({ length: 200 }, (_, index) => `ok ${index} something passed`),
      "FAIL src/app.test.ts > signs in > refuses a bad password",
      "AssertionError: expected 401 to be 403",
      "  at src/app.test.ts:42:7",
      "Tests  1 failed | 200 passed",
    ].join("\n");
    const lines = usefulLines(output);
    expect(lines).toContain("FAIL src/app.test.ts > signs in > refuses a bad password");
    expect(lines).toContain("AssertionError: expected 401 to be 403");
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.join("\n").length).toBeLessThanOrEqual(1200);
    expect(lastLine(output)).toBe("Tests 1 failed | 200 passed");
    // Many failing lines: the first ones, where the cause is, and the last ones.
    const many = Array.from({ length: 100 }, (_, index) => `error number ${index}`).join("\n");
    const kept = usefulLines(many);
    expect(kept.length).toBeLessThanOrEqual(12);
    expect(kept[0]).toBe("error number 0");
    expect(kept.at(-1)).toBe("error number 99");
    // A line is cut at 160 characters, and without a failure word the last lines are kept.
    expect(usefulLines(`${"x".repeat(500)}\nthe end`).every((line) => line.length <= 160)).toBe(
      true,
    );
    expect(usefulLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("reads the number after a text, on the last line that has it", () => {
    const output = "warmup p95_ms=900\nrun p95_ms= 182.5 (ms)\nsummary";
    expect(measuredAfter(output, "p95_ms=")).toBe(182.5);
    expect(measuredAfter("latency: 12", "latency")).toBe(12);
    expect(measuredAfter("p95_ms=abc", "p95_ms=")).toBeUndefined();
    expect(measuredAfter("nothing", "p95_ms=")).toBeUndefined();
    // The text is searched for, never turned into a pattern.
    expect(measuredAfter("a.*b 7", ".*")).toBeUndefined();
    expect(measuredAfter("v=1e3", "v=")).toBe(1000);
  });
});

describe("what counts as the creator's accord", () => {
  const point = (assurance: string, decision = "approved", source = "chat") => ({
    checkpoints: {
      "G-0000000001": {
        id: "G-0000000001",
        type: "creator_action",
        status: "resolved",
        opened_event: "01",
        executed: { event: "02", at: "x", source },
        resolution: { decision, source, assurance },
        creator_action: {
          kind: "proof_commands",
          reason: "r",
          commands: [
            {
              name: "tests",
              fingerprint: "a".repeat(24),
              run: "npm test",
              cwd: ".",
              timeout: 300,
              proves: ["ENF-2"],
            },
          ],
          require: "engine",
        },
      },
    },
  });

  it("is the creator's proved answer, never a word the hook could not prove", () => {
    for (const assurance of ["presence", "locale", "chat", "elicitation"]) {
      const decisions = proofDecisions(point(assurance));
      expect([...decisions.accepted.keys()], assurance).toEqual(["a".repeat(24)]);
      expect(decisions.require, assurance).toBe("engine");
    }
    for (const assurance of ["chat_unverified", "system", "agent"]) {
      const decisions = proofDecisions(point(assurance));
      expect(decisions.accepted.size, assurance).toBe(0);
      expect(decisions.require, assurance).toBe("any");
    }
    expect(proofDecisions(point("chat", "rejected")).refused.has("a".repeat(24))).toBe(true);
    expect(proofDecisions(point("chat", "approved", "agent")).accepted.size).toBe(0);
  });
});
