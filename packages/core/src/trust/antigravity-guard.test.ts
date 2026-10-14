import { toBase64url } from "@agentplugged/crypto";
import { SESSION_EVENT_TYPES } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_HARMLESS_TOOLS, ANTIGRAVITY_POLICY_PATH } from "../chat/antigravity-hook.js";
import {
  type CommandContext,
  claudeRulePermissions,
  computeProjection,
  createCommandRegistry,
  DEFAULT_RULES,
  denyRules,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  resolveProfile,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import {
  type AntigravityCall,
  absolutePath,
  callOf,
  type GuardDecision,
  guardToolCall,
  pathMatches,
  pathsOf,
  policyDecision,
  recordToolRead,
  startsAgent,
} from "./antigravity-guard.js";
import { type AntigravityPolicy, parsePolicy, renderPolicy } from "./antigravity-policy.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const PLACE = { root: "C:/work/app", home: "C:/Users/me" };
const INPUTS = {
  rootAgentsGenerated: true,
  claudeMdGenerated: false,
  geminiMdGenerated: true,
  generatedRoots: [".agents", ".gemini"],
};

/** The policy `sync` writes for Antigravity: the lists written for Claude Code. */
function policyOf(rules: Partial<typeof DEFAULT_RULES> = {}): AntigravityPolicy {
  const table = { ...DEFAULT_RULES, ...rules };
  const claude = claudeRulePermissions(table, "main");
  return {
    version: 1,
    rules: table,
    main_branch: "main",
    deny: [...new Set([...denyRules(INPUTS), ...claude.deny])],
    ask: claude.ask,
  };
}

const POLICY = policyOf();
const decide = (name: string, args: Record<string, unknown>, policy = POLICY): GuardDecision =>
  policyDecision(policy, { name, args }, PLACE);
const shell = (CommandLine: string, policy = POLICY) =>
  decide("run_command", { CommandLine }, policy);
const verdict = (decision: GuardDecision) => decision.decision;

describe("Antigravity guard: the policy sync writes", () => {
  it("round-trips, and is never guessed from a text that is not one", () => {
    expect(parsePolicy(renderPolicy(POLICY))).toEqual(POLICY);
    expect(parsePolicy("not json")).toBeUndefined();
    expect(parsePolicy(JSON.stringify({ ...POLICY, version: 2 }))).toBeUndefined();
    expect(parsePolicy(JSON.stringify({ ...POLICY, deny: "Bash(x)" }))).toBeUndefined();
    const { read_files: _gone, ...partial } = POLICY.rules;
    expect(parsePolicy(JSON.stringify({ ...POLICY, rules: partial }))).toBeUndefined();
    expect(
      parsePolicy(JSON.stringify({ ...POLICY, rules: { ...POLICY.rules, internet: "x" } })),
    ).toBeUndefined();
  });

  it("reads the call of a hook's input", () => {
    expect(callOf({ toolCall: { name: "run_command", args: { CommandLine: "ls" } } })).toEqual({
      name: "run_command",
      args: { CommandLine: "ls" },
    });
    expect(callOf({ toolCall: { name: "x" } })).toEqual({ name: "x", args: {} });
    expect(callOf({ toolCall: { name: "" } })).toBeUndefined();
    expect(callOf({})).toBeUndefined();
    expect(callOf(null)).toBeUndefined();
    expect(callOf({ toolCall: { name: 4 } })).toBeUndefined();
  });
});

describe("Antigravity guard: shell commands, the same rules as Claude Code", () => {
  it("denies what the product forbids to every agent: what destroys or gives away", () => {
    for (const command of [
      "git push origin main",
      "git push",
      "git push origin HEAD",
      "git push --force origin feat/x",
      "cd src && git push origin main",
      "GIT PUSH origin main",
      "gh pr merge 3",
      "glab mr merge 2",
      "gh repo delete x/y",
      "git checkout agentplugged/journal",
      "rm -rf /",
      "rm -rf ~",
      "rm -rf ..",
      "dropdb shop",
      'psql -c "DROP DATABASE shop"',
    ]) {
      expect(verdict(shell(command)), command).toBe("deny");
    }
  });

  it("lets through what the product no longer forbids: the work, and what a real guard already holds", () => {
    for (const command of [
      "npm install left-pad",
      "pip install requests",
      "rm -rf build",
      "git clean -fdx",
      "git reset --hard",
      "curl https://example.com",
      "curl -X POST -d x https://example.com",
      "Invoke-WebRequest -Uri https://example.com",
      "iwr https://example.com",
      "gh api repos/x/y",
      "git rebase main",
      "git commit --no-verify -m x",
      "npx agentplugged review G-1",
      "npx -y agentplugged@1.0.0 sync",
      "npm test",
      "git status",
      "git push origin feat/3-22-antigravity",
      "gh pr list",
      "echo bonjour",
      "git commit -m 'Antigravity support'",
      "echo antigravity",
    ]) {
      expect(verdict(shell(command)), command).toBe("allow");
    }
  });

  it("asks for what the creator made the rules ask for", () => {
    const asking = policyOf({
      install_dependency: "ask",
      internet: "ask",
      destructive_command: "ask",
    });
    for (const command of [
      "npm install left-pad",
      "pip install requests",
      "rm -rf ~",
      "curl https://example.com",
      "Invoke-WebRequest -Uri https://example.com",
      "iwr https://example.com",
      "IRM https://example.com",
    ]) {
      expect(verdict(shell(command, asking)), command).toBe("ask");
    }
    // What no rule names stays allowed.
    expect(verdict(shell("rm -rf build", asking))).toBe("allow");
    expect(verdict(shell("npm test", asking))).toBe("allow");
  });

  it("follows what a shell would run: groups, wrappers, here-documents", () => {
    for (const command of [
      "(cd src && git push origin main)",
      'bash -c "git push origin main"',
      'powershell -Command "git push"',
      "$(git push origin main)",
      "timeout 5 git push origin main",
      "echo x; git push",
    ]) {
      expect(verdict(shell(command)), command).toBe("deny");
    }
    // Data a here-document holds is not a command.
    expect(verdict(shell("cat > notes.md <<'EOF'\ngit push origin main\nEOF"))).toBe("allow");
  });

  it("applies the rules in force: a rule that denies, a rule that allows", () => {
    const closed = policyOf({ internet: "deny", install_dependency: "deny" });
    expect(verdict(shell("curl https://example.com", closed))).toBe("deny");
    expect(verdict(shell("iwr https://example.com", closed))).toBe("deny");
    expect(verdict(shell("npm install left-pad", closed))).toBe("deny");
    const open = policyOf({ internet: "allow", install_dependency: "allow", push_main: "allow" });
    expect(verdict(shell("curl https://example.com", open))).toBe("allow");
    expect(verdict(shell("npm install left-pad", open))).toBe("allow");
    // The prohibitions that no rule lifts stay.
    expect(verdict(shell("gh pr merge 3", open))).toBe("deny");
    expect(verdict(shell("glab mr merge 2", open))).toBe("deny");
  });

  it("gives the agent the reason", () => {
    const denied = shell("git push origin main");
    expect(denied).toMatchObject({ decision: "deny" });
    expect(denied.decision === "deny" ? denied.reason : "").toContain("the permission rules deny");
    const asked = shell("npm install left-pad", policyOf({ install_dependency: "ask" }));
    expect(asked.decision === "ask" ? asked.reason : "").toContain("ask the creator first");
  });
});

describe("Antigravity guard: a session an agent starts itself", () => {
  it("denies Antigravity started by name, by path, by a launcher or by a wrapper", () => {
    for (const command of [
      "agy -p valide",
      "agy.exe -p valide",
      "antigravity .",
      "& 'C:\\Users\\me\\.gemini\\bin\\agy.exe' -p valide",
      "C:\\Users\\me\\.gemini\\bin\\agy.exe --continue",
      "/usr/local/bin/agy -p x",
      "Start-Process agy -ArgumentList '-p x'",
      "cmd /c agy -p x",
      "echo hi && agy -p x",
      "npx agy -p x",
      'bash -c "agy -p x"',
    ]) {
      expect(startsAgent(command), command).toBe(true);
      expect(verdict(shell(command)), command).toBe("deny");
    }
  });

  it("denies copying Antigravity's program (a renamed copy would hide the session), and writing through a reader", () => {
    for (const command of [
      "Copy-Item C:\\Users\\me\\.gemini\\bin\\agy.exe .\\a.exe",
      "cmd /c copy agy.exe b.exe",
      "cp ~/.gemini/bin/agy /tmp/a",
      'schtasks /create /tn x /tr "C:\\tools\\agy.exe -p valide"',
      "cat notes.md > ~/.agentplugged/chat/x.jsonl",
      "cat notes.md >> .agents/plugins/agentplugged/policy.json",
      "Get-Content a.json > .agents\\plugins\\agentplugged\\hooks.json",
    ]) {
      expect(verdict(shell(command)), command).toBe("deny");
    }
    for (const command of [
      "where agy.exe",
      "Get-Command agy",
      "ls ~/.gemini/bin",
      "cat ~/.gemini/config/config.json",
    ]) {
      expect(verdict(shell(command)), command).toBe("allow");
    }
  });

  it("does not take a word of a message or a path for the program", () => {
    for (const command of [
      "echo agy",
      "git commit -m 'Fix: Antigravity pris en charge'",
      "cat docs/antigravity.md",
      "ls ~/.gemini/antigravity-cli",
      "grep -rn antigravity src",
    ]) {
      expect(startsAgent(command), command).toBe(false);
    }
  });
});

describe("Antigravity guard: the transcripts and the store of the creator's messages", () => {
  const transcript =
    "C:\\Users\\me\\.gemini\\antigravity-cli\\brain\\abc\\.system_generated\\logs\\transcript_full.jsonl";

  it("lets a command only read them, never write them", () => {
    expect(verdict(shell(`cat ${transcript}`))).toBe("allow");
    expect(verdict(shell(`Get-Content '${transcript}' -Tail 5`))).toBe("allow");
    for (const command of [
      `echo x >> ${transcript}`,
      `Add-Content '${transcript}' 'x'`,
      `node -e "require('fs').appendFileSync('${transcript.replaceAll("\\", "/")}','x')"`,
      "Set-Content ~/.agentplugged/chat/x.jsonl 'x'",
      "echo x >> $HOME/.agentplugged/chat/x.jsonl",
      "cat a | tee ~/.agentplugged/chat/x.jsonl",
    ]) {
      expect(verdict(shell(command)), command).toBe("deny");
    }
  });

  it("lets a command only read the product's plugin and Antigravity's settings too", () => {
    expect(verdict(shell("cat .agents/plugins/agentplugged/policy.json"))).toBe("allow");
    expect(verdict(shell("Get-Content ~/.gemini/config/config.json"))).toBe("allow");
    for (const command of [
      "Set-Content .agents/plugins/agentplugged/policy.json '{}'",
      "echo {} > .agents\\plugins\\agentplugged\\hooks.json",
      "rm -f .agents/plugins/agentplugged/hooks.json",
      "Remove-Item -Recurse .agents\\plugins\\agentplugged",
      "sed -i s/a/b/ .agents/plugins/agentplugged/hooks/agentplugged-antigravity.mjs",
      "echo {} > ~/.gemini/config/plugins.json",
      "Set-Content $HOME\\.gemini\\config\\config.json x",
    ]) {
      expect(verdict(shell(command)), command).toBe("deny");
    }
  });

  it("denies the file tools too", () => {
    expect(verdict(decide("write_to_file", { TargetFile: transcript }))).toBe("deny");
    expect(
      verdict(decide("write_to_file", { TargetFile: "C:/Users/me/.agentplugged/chat/x.jsonl" })),
    ).toBe("deny");
    // Reading the store is no write: it stays open (only the proof is protected).
    expect(
      verdict(decide("view_file", { AbsolutePath: "C:/Users/me/.agentplugged/chat/x.jsonl" })),
    ).toBe("allow");
    // Antigravity's own settings: a global hook, a disabled plugin, a permission granted for good.
    expect(
      verdict(decide("write_to_file", { TargetFile: "C:/Users/me/.gemini/config/hooks.json" })),
    ).toBe("deny");
    expect(
      verdict(
        decide("replace_file_content", { TargetFile: "C:/Users/me/.gemini/config/config.json" }),
      ),
    ).toBe("deny");
  });
});

describe("Antigravity guard: paths", () => {
  it("denies writing what the product protects, in any spelling of the path", () => {
    for (const TargetFile of [
      "C:\\work\\app\\.agentplugged\\method.yaml",
      "C:/work/app/.agentplugged/method.yaml",
      "c:\\WORK\\App\\.AgentPlugged\\METHOD.YAML",
      ".agentplugged/method.yaml",
      "./.agentplugged/method.yaml",
      "C:\\work\\app\\src\\..\\.agentplugged\\method.yaml",
      "file:///C:/work/app/.agentplugged/method.yaml",
      "C:\\work\\app\\.agents\\plugins\\agentplugged\\policy.json",
      "C:\\work\\app\\.agents\\plugins\\agentplugged\\hooks.json",
      "C:\\work\\app\\GEMINI.md",
      "C:\\work\\app\\.env",
      "C:\\work\\app\\sub\\.env.local",
    ]) {
      for (const tool of ["write_to_file", "replace_file_content", "multi_replace_file_content"]) {
        expect(verdict(decide(tool, { TargetFile })), `${tool} ${TargetFile}`).toBe("deny");
      }
    }
  });

  it("lets the work of the product through", () => {
    for (const TargetFile of [
      "C:\\work\\app\\src\\a.ts",
      "C:\\work\\app\\.agentplugged\\agents\\iris\\agent.yaml",
      "C:\\work\\app\\.env.example",
      "C:\\work\\app\\.agentplugged\\docs\\prd.md",
      "C:\\work\\app\\.agentplugged\\stories\\3-1.md",
      "src/index.ts",
      // Another folder, even one named alike: only the product's own paths are protected.
      "C:\\other\\.agentplugged\\method.yaml",
    ]) {
      expect(verdict(decide("write_to_file", { TargetFile })), TargetFile).toBe("allow");
    }
  });

  it("denies reading what stays secret", () => {
    for (const AbsolutePath of [
      "C:\\work\\app\\.env",
      "C:\\Users\\me\\.ssh\\id_rsa",
      "C:\\Users\\me\\.config\\gh\\hosts.yml",
      "C:\\Users\\me\\.claude\\.credentials.json",
    ]) {
      expect(verdict(decide("view_file", { AbsolutePath })), AbsolutePath).toBe("deny");
    }
    // What is no secret stays readable: the room, the memory, the example of an environment file.
    for (const AbsolutePath of [
      "C:\\work\\app\\.agentplugged\\salle\\x.md",
      "C:\\work\\app\\.agentplugged\\memory\\m.md",
      "C:\\work\\app\\.env.example",
    ]) {
      expect(verdict(decide("view_file", { AbsolutePath })), AbsolutePath).toBe("allow");
    }
    expect(verdict(decide("view_file", { AbsolutePath: "C:\\work\\app\\src\\a.ts" }))).toBe(
      "allow",
    );
    expect(verdict(decide("list_dir", { DirectoryPath: "C:\\work\\app\\src" }))).toBe("allow");
    expect(verdict(decide("grep_search", { SearchPath: "C:\\Users\\me\\.ssh", Query: "x" }))).toBe(
      "deny",
    );
  });

  it("takes a tool it does not know that carries a command for a shell, and protects the nested .agents folders", () => {
    for (const [name, args] of [
      ["run_shell_command", { CommandLine: "git push origin main" }],
      ["exec_command", { command: "git push origin main" }],
      ["terminal", { script: "gh pr merge 3" }],
    ] as const) {
      expect(verdict(decide(name, args)), name).toBe("deny");
    }
    expect(verdict(decide("some_tool", { Prompt: "git push origin main" }))).toBe("allow");
    // Antigravity reads hooks and plugins from every .agents folder up to the root, and the home's.
    for (const TargetFile of [
      "C:\\work\\app\\sub\\.agents\\hooks.json",
      "C:\\work\\app\\packages\\a\\.agents\\plugins\\x\\hooks.json",
      "C:\\Users\\me\\.agents\\hooks.json",
      "C:\\Users\\me\\.gemini\\settings.json",
    ]) {
      expect(verdict(decide("write_to_file", { TargetFile })), TargetFile).toBe("deny");
    }
    // The folders Antigravity gives the agent to work in stay open.
    expect(
      verdict(
        decide("write_to_file", {
          TargetFile: "C:\\Users\\me\\.gemini\\antigravity-cli\\brain\\abc\\notes.md",
        }),
      ),
    ).toBe("allow");
  });

  it("checks a tool it does not know that names a path, as writing and as reading", () => {
    expect(
      verdict(
        decide("generate_image", { OutputPath: "C:\\work\\app\\.agentplugged\\method.yaml" }),
      ),
    ).toBe("deny");
    expect(verdict(decide("some_new_tool", { SourceFile: "C:\\work\\app\\.env" }))).toBe("deny");
    expect(verdict(decide("some_new_tool", { Anything: "x" }))).toBe("allow");
  });

  it("asks before each write when the rule says so", () => {
    const careful = policyOf({ edit_code: "ask" });
    expect(
      verdict(decide("write_to_file", { TargetFile: "C:\\work\\app\\src\\a.ts" }, careful)),
    ).toBe("ask");
    expect(
      verdict(
        decide(
          "write_to_file",
          { TargetFile: "C:\\work\\app\\.agentplugged\\method.yaml" },
          careful,
        ),
      ),
    ).toBe("deny");
    expect(
      verdict(decide("view_file", { AbsolutePath: "C:\\work\\app\\src\\a.ts" }, careful)),
    ).toBe("allow");
  });

  it("reads path rules: from the project, from the home folder, anywhere", () => {
    expect(
      pathMatches(
        "/.agentplugged/agents/**",
        "C:\\work\\app\\.agentplugged\\agents\\x\\a.yaml",
        PLACE,
      ),
    ).toBe(true);
    expect(
      pathMatches("/.agentplugged/agents/**", "C:\\work\\app\\.agentplugged\\docs\\a.md", PLACE),
    ).toBe(false);
    expect(pathMatches("~/.ssh/**", "C:\\Users\\me\\.ssh\\id_ed25519", PLACE)).toBe(true);
    expect(pathMatches("~/.ssh/**", "C:\\Users\\other\\.ssh\\id_ed25519", PLACE)).toBe(false);
    expect(pathMatches("**/.env*", "C:\\anywhere\\deep\\.env.production", PLACE)).toBe(true);
    expect(pathMatches("**/.env*", "C:\\anywhere\\deep\\environment.ts", PLACE)).toBe(false);
    expect(pathMatches("/**", "C:\\work\\app\\a\\b.ts", PLACE)).toBe(true);
    expect(pathMatches("/**", "C:\\elsewhere\\b.ts", PLACE)).toBe(false);
    expect(absolutePath("a/../b/./c.ts", PLACE)).toBe(
      "c:/work/app/b/c.ts".replace("c:", "C:".toLowerCase()),
    );
    expect(absolutePath("~/x", PLACE)).toBe("c:/users/me/x");
  });

  it("names the paths of a call, never what the agent wrote", () => {
    expect(
      pathsOf({
        TargetFile: "a.ts",
        CodeContent: "C:\\secret\\not-a-path",
        toolSummary: "x",
        Cwd: "C:\\work",
        Paths: ["b", "c"],
        Count: 3,
      }),
    ).toEqual(["a.ts", "C:\\work", "b", "c"]);
  });
});

describe("Antigravity guard: spellings a shell and Windows read as the same", () => {
  it("denies pushing the main branch however the command is written", () => {
    for (const command of [
      "git push origin 'main'",
      'git push origin "main"',
      "git push 'origin' main",
      "git  push   origin  main",
      "git\tpush\torigin\tmain",
      "GIT.EXE push origin main",
      "& 'C:\\Program Files\\Git\\cmd\\git.exe' push origin main",
      '"C:\\Program Files\\Git\\bin\\git.exe" push origin main',
      "git push origin 'refs/heads/main'",
      "cd src; & git push origin 'main'",
    ]) {
      expect(verdict(shell(command)), command).toBe("deny");
    }
    // The words of a message or of an argument are not the program's.
    expect(verdict(shell("git commit -m 'git push origin main'"))).toBe("allow");
    expect(verdict(shell("echo git push origin main"))).toBe("allow");
    expect(verdict(shell("git push origin feat/3-22-antigravity"))).toBe("allow");
  });

  it("reads the folder a command runs in as part of it", () => {
    const run = (CommandLine: string, Cwd: string, policy = POLICY) =>
      verdict(decide("run_command", { CommandLine, Cwd }, policy));
    const plugin = "C:\\work\\app\\.agents\\plugins\\agentplugged";
    expect(run("Set-Content policy.json '{}'", plugin)).toBe("deny");
    expect(run("rm hooks.json", plugin.replaceAll("\\", "/"))).toBe("deny");
    expect(run("Set-Content config.json x", "C:\\Users\\me\\.gemini\\config")).toBe("deny");
    expect(run("Set-Content x.md y", "C:\\work\\app\\.agentplugged\\agents\\iris")).toBe("allow");
    // `cd` and relative paths: the folders the command names are the command's words.
    expect(
      run("cd .agents\\plugins; Set-Content agentplugged\\policy.json '{}'", "C:\\work\\app"),
    ).toBe("deny");
    // Reading is allowed, and so is the work of the product.
    expect(run("cat policy.json", plugin)).toBe("allow");
    expect(run("npm test", "C:\\work\\app")).toBe("allow");
    expect(run("npm test", "C:\\work\\app\\src")).toBe("allow");
    // An `edit_code` rule that denies is no reason to stop every command.
    expect(run("npm test", "C:\\work\\app", policyOf({ edit_code: "deny" }))).toBe("allow");
  });

  it("reads the spellings of one Windows path as the same path", () => {
    for (const TargetFile of [
      "C:\\work\\app\\.agentplugged\\method.yaml::$DATA",
      "C:\\work\\app\\.agentplugged\\method.yaml:stream",
      "C:\\work\\app\\.agentplugged\\method.yaml.",
      "C:\\work\\app\\.agentplugged\\method.yaml ",
      "C:\\work\\app\\.agentplugged\\method.yaml...",
      "\\\\?\\C:\\work\\app\\.agentplugged\\method.yaml",
      "\\\\.\\C:\\work\\app\\.agentplugged\\method.yaml",
      "\\\\localhost\\C$\\work\\app\\.agentplugged\\method.yaml",
      "file:///C:/work/app/.agentplugged/method.yaml",
      "file:///c:/work/app/.agentplugged/meth%6Fd.yaml",
      "C:\\work\\app\\.agentplugged\\.\\method.yaml",
    ]) {
      expect(verdict(decide("write_to_file", { TargetFile })), TargetFile).toBe("deny");
    }
    // A folder whose name has a space in its URL form is still the product's folder.
    const spaced = { root: "C:/my work/app", home: "C:/Users/me" };
    expect(
      policyDecision(
        POLICY,
        {
          name: "write_to_file",
          args: { TargetFile: "file:///C:/my%20work/app/.agentplugged/method.yaml" },
        },
        spaced,
      ).decision,
    ).toBe("deny");
  });

  it("reads a project whose own folder has a short name: its files settled under the full one", () => {
    // The project opened as C:/Users/RUNNER~1/app: the disk names everything under runneradmin.
    const place = {
      root: "C:/Users/RUNNER~1/app",
      home: "C:/Users/RUNNER~1",
      resolve: (path: string) =>
        path
          .replace(/RUNNER~1/gi, "runneradmin")
          .replace(/AGENTP~1/gi, ".agentplugged")
          .replace(/METHOD~1\.YAM/gi, "method.yaml"),
    };
    for (const target of [
      "C:\\Users\\RUNNER~1\\app\\AGENTP~1\\METHOD~1.YAM",
      "C:\\Users\\runneradmin\\app\\.agentplugged\\method.yaml",
    ]) {
      expect(
        policyDecision(POLICY, { name: "write_to_file", args: { TargetFile: target } }, place)
          .decision,
        target,
      ).toBe("deny");
    }
    expect(
      policyDecision(
        POLICY,
        { name: "write_to_file", args: { TargetFile: "C:\\Users\\RUNNER~1\\app\\src\\a.ts" } },
        place,
      ).decision,
    ).toBe("allow");
  });

  it("tries the path the file system names too: the short names Windows gives", () => {
    const named = (path: string) =>
      path.replace(/AGENTP~1/gi, ".agentplugged").replace(/METHOD~1\.YAM/gi, "method.yaml");
    const place = { ...PLACE, resolve: named };
    const short = {
      name: "write_to_file",
      args: { TargetFile: "C:\\work\\app\\AGENTP~1\\METHOD~1.YAM" },
    };
    expect(policyDecision(POLICY, short, place).decision).toBe("deny");
    expect(
      policyDecision(
        POLICY,
        { name: "view_file", args: { AbsolutePath: "C:\\work\\app\\ENV~1" } },
        {
          ...PLACE,
          resolve: (path) => path.replace(/ENV~1/i, ".env"),
        },
      ).decision,
    ).toBe("deny");
    // A disk that cannot answer leaves the path as written, never a refusal to decide.
    const broken = {
      ...PLACE,
      resolve: () => {
        throw new Error("no disk");
      },
    };
    expect(
      policyDecision(
        POLICY,
        { name: "write_to_file", args: { TargetFile: "C:\\work\\app\\src\\a.ts" } },
        broken,
      ).decision,
    ).toBe("allow");
    expect(
      policyDecision(
        POLICY,
        {
          name: "write_to_file",
          args: { TargetFile: "C:\\work\\app\\.agentplugged\\method.yaml" },
        },
        broken,
      ).decision,
    ).toBe("deny");
  });

  it("denies the mass deletions of PowerShell and cmd, as it does for `rm -rf` of a root", () => {
    for (const command of [
      "Remove-Item -Recurse -Force C:\\",
      "Remove-Item -Recurse -Force $env:USERPROFILE",
      "ri -Recurse ~",
      "rd /s /q C:\\",
      "rmdir /s %USERPROFILE%",
      "Format-Volume -DriveLetter D",
    ]) {
      expect(verdict(shell(command)), command).toBe("deny");
    }
    // The removals inside the repository, and the single file, are the work.
    for (const command of [
      "Remove-Item -Recurse -Force build",
      "Remove-Item build -r",
      "rd /s /q build",
      "del /s /q *.log",
      "Remove-Item notes.txt",
    ]) {
      expect(verdict(shell(command)), command).toBe("allow");
    }
  });

  it("denies reading the login of Antigravity", () => {
    for (const AbsolutePath of [
      "C:\\Users\\me\\.gemini\\oauth_creds.json",
      "C:/Users/me/.gemini/google_accounts.json",
    ]) {
      expect(verdict(decide("view_file", { AbsolutePath })), AbsolutePath).toBe("deny");
    }
  });
});

describe("Antigravity guard: the tools the script lets through are the tools the engine needs no check for", () => {
  it("never lets the script allow a tool the engine would check", () => {
    for (const name of ANTIGRAVITY_HARMLESS_TOOLS) {
      expect(
        verdict(
          decide(name, { CommandLine: "git push origin main", TargetFile: "C:/work/app/.env" }),
        ),
        name,
      ).toBe("allow");
    }
  });
});

describe("Antigravity guard: the web tools", () => {
  it("follows the internet rule: allowed by default, as the creator sets it", () => {
    for (const name of ["read_url_content", "open_browser_url", "search_web"]) {
      expect(verdict(decide(name, { Url: "https://x" })), name).toBe("allow");
      expect(verdict(decide(name, { Url: "https://x" }, policyOf({ internet: "ask" }))), name).toBe(
        "ask",
      );
      expect(
        verdict(decide(name, { Url: "https://x" }, policyOf({ internet: "deny" }))),
        name,
      ).toBe("deny");
    }
  });

  it("lets the tools that bring nothing to check through", () => {
    for (const name of [
      "manage_task",
      "send_message",
      "ask_question",
      "wait",
      "invoke_subagent",
      "call_mcp_tool",
    ]) {
      expect(verdict(decide(name, { Prompt: "git push origin main", ServerName: "x" })), name).toBe(
        "allow",
      );
    }
  });
});

/** A product with the policy in place, and an agent's context outside any session object. */
async function product(
  rules = "",
  options: { installs?: "validate" | "visible"; policy?: AntigravityPolicy } = {},
) {
  const files = new MemoryFiles();
  let at = Date.UTC(2026, 9, 4, 12, 0, 0);
  const now = () => {
    at += 1000;
    return at;
  };
  const keys = new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(9)));
  const journal = new MemoryStateStore({ keys, now });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    human: { keys },
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  if (rules !== "")
    files.seed(
      ".agentplugged/method.yaml",
      `${files.files.get(".agentplugged/method.yaml") ?? ""}rules:\n${rules}`,
    );
  if (options.installs !== undefined) {
    files.seed(
      ".agentplugged/method.yaml",
      `${files.files.get(".agentplugged/method.yaml") ?? ""}installs:\n  mode: ${options.installs}\n`,
    );
  }
  files.seed(ANTIGRAVITY_POLICY_PATH, renderPolicy(options.policy ?? POLICY));
  const agent: CommandContext = { ...human, actor: "agent", human: undefined, interactive: false };
  const registry = createCommandRegistry();
  const projection = async () => {
    const listing = await journal.list();
    return computeProjection(listing.events, { problems: listing.problems });
  };
  return { files, journal, agent, registry, human, projection };
}

const CONVERSATION = "9eae3f94-67bd-4732-aee1-32feeb86e0ba";
const call = (CommandLine: string): AntigravityCall => ({
  name: "run_command",
  args: { CommandLine, Cwd: "C:/work/app" },
});

describe("Antigravity guard: the gate of a high-risk command, a conversation as the session", () => {
  it("denies without a readable policy, never lets a call through unchecked", async () => {
    const { agent, files } = await product();
    files.remove(ANTIGRAVITY_POLICY_PATH);
    const missing = await guardToolCall(agent, call("echo ok"), {
      place: PLACE,
      conversation: CONVERSATION,
    });
    expect(missing.decision).toBe("deny");
    files.seed(ANTIGRAVITY_POLICY_PATH, "{ not json");
    const broken = await guardToolCall(agent, call("echo ok"), {
      place: PLACE,
      conversation: CONVERSATION,
    });
    expect(broken.decision).toBe("deny");
  });

  it("answers the policy for what the gate does not cover", async () => {
    const { agent } = await product("  internet: deny\n");
    const environment = { place: PLACE, conversation: CONVERSATION };
    expect((await guardToolCall(agent, call("echo ok"), environment)).decision).toBe("allow");
    expect((await guardToolCall(agent, call("git push origin main"), environment)).decision).toBe(
      "deny",
    );
    expect(
      (
        await guardToolCall(
          agent,
          { name: "write_to_file", args: { TargetFile: "C:/work/app/.agentplugged/method.yaml" } },
          environment,
        )
      ).decision,
    ).toBe("deny");
  });

  it("opens a checkpoint for an installation when the creator validates them, the same one each time, then follows the creator", async () => {
    const { agent, registry, human, projection } = await product("", { installs: "validate" });
    const environment = { place: PLACE, conversation: CONVERSATION };
    const first = await guardToolCall(agent, call("npm install left-pad"), environment);
    expect(first.decision).toBe("deny");
    const reason = first.decision === "deny" ? first.reason : "";
    const id = /G-[0-9A-Z]+/.exec(reason)?.[0] as string;
    expect(id).toBeDefined();
    expect(reason).toContain("waits for their answer");
    const again = await guardToolCall(agent, call("npm install left-pad"), environment);
    expect(again).toEqual(first);
    expect(Object.keys((await projection()).state.checkpoints as object)).toEqual([id]);

    const approved = await registry.run("review", human, {
      action: "resolve",
      checkpoint: id,
      decision: "approved",
    });
    expect(approved.ok).toBe(true);
    // Approved for this conversation: the gate lets it through.
    const after = await guardToolCall(agent, call("npm install left-pad"), environment);
    expect(after.decision).toBe("allow");
    // Another conversation is another session: it waits for its own approval.
    const other = await guardToolCall(agent, call("npm install left-pad"), {
      place: PLACE,
      conversation: "11111111-2222-3333-4444-555555555555",
    });
    expect(other.decision).toBe("deny");
  });

  it("records the reads of a conversation and blocks nothing for them", async () => {
    const asking = policyOf({ install_dependency: "ask" });
    const { agent, journal } = await product("  install_dependency: ask\n", { policy: asking });
    const environment = { place: PLACE, conversation: CONVERSATION };
    expect((await guardToolCall(agent, call("npm install left-pad"), environment)).decision).toBe(
      "ask",
    );

    await recordToolRead(agent, call("curl https://example.com"), CONVERSATION);
    await recordToolRead(agent, call("curl https://example.com"), CONVERSATION);
    const reads = (await journal.list()).events.filter(
      (event) => event.type === SESSION_EVENT_TYPES.externalRead,
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]?.payload).toMatchObject({
      session: CONVERSATION,
      tool: "Bash",
      source: "example.com",
    });
    // The conversation read the internet: the policy answers as before, the gate asks nothing more.
    expect((await guardToolCall(agent, call("npm install left-pad"), environment)).decision).toBe(
      "ask",
    );
    expect((await guardToolCall(agent, call("npm test"), environment)).decision).toBe("allow");
  });

  it("records the reads of the web tools, of another MCP server's tools, and of nothing else", async () => {
    const { agent, journal } = await product("  internet: deny\n");
    const sources = async () =>
      (await journal.list()).events
        .filter((event) => event.type === SESSION_EVENT_TYPES.externalRead)
        .map(
          (event) =>
            `${(event.payload as { tool: string }).tool} ${(event.payload as { source: string }).source}`,
        );
    await recordToolRead(
      agent,
      { name: "read_url_content", args: { Url: "https://docs.example.org/page" } },
      CONVERSATION,
    );
    await recordToolRead(agent, { name: "search_web", args: { query: "x" } }, CONVERSATION);
    await recordToolRead(
      agent,
      { name: "call_mcp_tool", args: { ServerName: "github", ToolName: "get_issue" } },
      CONVERSATION,
    );
    expect(await sources()).toEqual([
      "WebFetch docs.example.org",
      "WebSearch web search",
      "mcp__github__get_issue github (MCP: get_issue)",
    ]);
    const before = (await sources()).length;
    // The engine's own server, a local command, a file tool: no read.
    await recordToolRead(
      agent,
      {
        name: "call_mcp_tool",
        args: { ServerName: "agentplugged_agentplugged", ToolName: "get_state" },
      },
      CONVERSATION,
    );
    await recordToolRead(
      agent,
      { name: "call_mcp_tool", args: { ServerName: "agentplugged", ToolName: "get_state" } },
      CONVERSATION,
    );
    await recordToolRead(agent, call("cat > f.md <<'EOF'\ncurl x\nEOF"), CONVERSATION);
    await recordToolRead(
      agent,
      { name: "view_file", args: { AbsolutePath: "C:/work/app/a.ts" } },
      CONVERSATION,
    );
    expect((await sources()).length).toBe(before);
  });
});
