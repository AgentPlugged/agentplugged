import { gitBlobId, utf8 } from "@agentplugged/crypto";
import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  computeProjection,
  DEFAULT_RULES,
  type MainBranchReader,
  type StoryState,
  writeGuardIdle,
} from "../index.js";
import { ARCHITECTURE_PATH } from "../phases/design-review.js";
import { claudeTrustHooks, hookValue } from "../sync/trust-hooks.js";
import { product } from "../testing/requirements-product.js";

/**
 * The guard before a write, end to end: the hook `sync` writes for Claude Code, fed
 * with the input Claude Code gives a hook, reaches the engine's `check_write`, which refuses a
 * write that breaks a named rule and lets every other through.
 */

// Core has no platform types: the timer the slow journal of a test needs is declared here.
declare function setTimeout(handler: () => void, ms: number): unknown;

const ROOT = "/work/shop";
const WORKTREE = "/work/shop.worktrees/1-3";
const COMMIT = "c".repeat(40);
const SESSION = "session-1";

/** A key of a known shape, built here so that this file holds no secret. */
const KEY = `ghp_${"aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL3nR6"}`;

const STORY = [
  "---",
  "id: 1-3",
  "kind: story",
  "owner: sam",
  "title: Chat hooks",
  "epic: epic-1",
  "reviewer: quentin",
  "requirements: [EF-1]",
  "budget_usd: 2",
  "branch: feat/1-3-chat-hooks",
  "depends_on: []",
  "---",
  "# Story 1-3",
  "",
  "## Context",
  "",
  "Hooks live in `packages/core/src/chat/` and the page in `src/ui/`; the manifest `package.json` changes.",
  "",
  "## Intent",
  "",
  "Ada can chat.",
  "",
  "## Acceptance criteria",
  "",
  "- Given a message, when sent, then it shows.",
  "",
].join("\n");

const architecture = (decisions: string[]) =>
  [
    "---",
    "id: architecture",
    "kind: architecture",
    "owner: creator",
    "links: []",
    "---",
    "# Architecture",
    "",
    ...decisions,
    "",
  ].join("\n");

const CHECKABLE = architecture([
  "### AD-1 — No left-pad",
  "",
  "- **Binds:** the dependencies.",
  "- **Prevents:** a trivial package.",
  "- **Rule:** we write it ourselves.",
  "- **Guard:** no dependency left-pad",
  "",
  "### AD-2 — The UI never reaches the database",
  "",
  "- **Binds:** src/ui.",
  "- **Prevents:** a query from a page.",
  "- **Rule:** the UI goes through the API.",
  "- **Guard:** never import pg from src/ui/**",
]);

const PROSE_ONLY = architecture([
  "### AD-3 — One writer per piece of data",
  "",
  "- **Binds:** the data.",
  "- **Prevents:** two writers.",
  "- **Rule:** prose only, nothing a machine can check.",
]);

interface Options {
  readonly architecture?: string;
  readonly story?: boolean;
  readonly budget?: number;
  /** The machine: `win32` reads paths the way Windows spells them. */
  readonly platform?: string;
  /** The product's folder (`ROOT` by default). */
  readonly root?: string;
  /** Where the story works: its own copy (the default), or the main folder (`.`, no branch per story). */
  readonly worktree?: string;
  /** What the main branch holds as `method.yaml`, when it is not the working copy's. */
  readonly mainMethod?: string;
}

/** The input Claude Code gives a `PreToolUse` hook for a file tool, with what each tool carries. */
const hookInput = (tool: string, toolInput: Record<string, unknown>, cwd = ROOT) => ({
  session_id: SESSION,
  transcript_path: "/home/ada/.claude/projects/shop/session-1.jsonl",
  cwd,
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: toolInput,
  tool_use_id: "toolu_01",
});

/** What Claude Code writes in a hook's `input` for a value: `${path}` of the hook's input, or nothing. */
function substitute(value: unknown, input: Record<string, unknown>): unknown {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([\w.]+)\}/g, (_, path: string) => {
    const found = path
      .split(".")
      .reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], input);
    if (found === undefined) return "";
    return typeof found === "string" ? found : JSON.stringify(found);
  });
}

async function guarded(options: Options = {}) {
  let files: { files: Map<string, string> } | undefined;
  const mainBranch: MainBranchReader = {
    read: async (path) => ({
      found: true,
      branch: "origin/main",
      text:
        path === ".agentplugged/method.yaml" && options.mainMethod !== undefined
          ? options.mainMethod
          : files?.files.get(path),
    }),
  };
  const context: Partial<CommandContext> = {
    projectRoot: options.root ?? ROOT,
    mainBranch,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.budget === undefined ? {} : { writeGuardBudgetMs: options.budget }),
  };
  const w = await product({ context });
  files = w.files;
  w.files.seed(".agentplugged/stories/1-3-chat-hooks.md", STORY);
  const text = options.architecture ?? CHECKABLE;
  w.files.seed(ARCHITECTURE_PATH, text);
  const opened = (await w.run("open_checkpoint", {
    agent: "main",
    type: "document",
    risk: "medium",
    title: "The architecture",
    summary: "Approve the architecture.",
    documents: [{ path: ARCHITECTURE_PATH, branch: "main", blob_sha: gitBlobId(utf8(text)) }],
  })) as { checkpoint: string };
  await w.approve(opened.checkpoint);
  const productId = w.journal.events[0]?.product as string;
  if (options.story !== false) {
    await w.journal.appendAll([
      {
        type: "story.started",
        actor: { kind: "agent", agent: "sam" },
        product: productId,
        story: "1-3",
        provenance: "trusted",
        payload: {
          agent: "sam",
          branch: "feat/1-3-chat-hooks",
          base: COMMIT,
          base_ref: "main",
          worktree: options.worktree ?? "../shop.worktrees/1-3",
        },
      },
    ]);
  }
  const hooks = claudeTrustHooks(DEFAULT_RULES).PreToolUse;
  /** The tool's hook, run the way Claude Code runs it: its input filled from the hook's own input. */
  const check = async (tool: string, toolInput: Record<string, unknown>, cwd = ROOT) => {
    const group = hooks.find((candidate) => candidate.matcher === tool);
    const handler = group?.hooks[0] as { tool: string; input: Record<string, unknown> };
    expect(handler.tool).toBe("guard");
    const given = hookInput(tool, toolInput, cwd) as Record<string, unknown>;
    const filled = Object.fromEntries(
      Object.entries(handler.input).map(([key, value]) => [key, substitute(value, given)]),
    );
    expect(filled.action).toBe("write");
    const { action: _action, ...fields } = filled;
    const result = await w.registry.run("check_write", w.agent, fields);
    if (!result.ok) throw new Error(`check_write failed: ${result.error.code}`);
    await writeGuardIdle(w.agent);
    return result.value as {
      hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string };
    };
  };
  const events = (type: string) => w.journal.events.filter((event) => event.type === type);
  const projection = async () => computeProjection((await w.journal.list()).events);
  return { ...w, check, events, projection, productId };
}

const write = (path: string, content: string) => ({ file_path: path, content });
const reasonOf = (answer: Awaited<ReturnType<Awaited<ReturnType<typeof guarded>>["check"]>>) =>
  answer.hookSpecificOutput?.permissionDecisionReason ?? "";

describe("the secret rule", () => {
  it("refuses a secret in each file tool, names the rule and the kind, and keeps the value out of everything", async () => {
    const g = await guarded();
    const target = `${WORKTREE}/packages/core/src/chat/hook.ts`;
    const answers = [
      await g.check("Write", write(target, `export const token = "${KEY}";`)),
      await g.check("Edit", {
        file_path: `${target}.edit`,
        old_string: "a",
        new_string: `x = "${KEY}"`,
      }),
      await g.check("MultiEdit", {
        file_path: `${target}.multi`,
        edits: [{ old_string: "a", new_string: `y = "${KEY}"` }],
      }),
      await g.check("NotebookEdit", {
        notebook_path: `${WORKTREE}/packages/core/src/chat/n.ipynb`,
        new_source: `k = "${KEY}"`,
      }),
    ];
    for (const answer of answers) {
      expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");
      const reason = reasonOf(answer);
      expect(reason).toContain("rule secret");
      expect(reason).toContain("GitHub token");
      expect(reason).toContain("Nothing was written");
      expect(reason).not.toContain(KEY.slice(4, 20));
      // One line: a refusal costs few tokens.
      expect(reason).not.toContain("\n");
      expect(reason.length).toBeLessThan(400);
    }
    const refused = g.events("write.refused");
    expect(refused).toHaveLength(4);
    expect(refused[0]?.payload).toMatchObject({
      rule: "secret",
      story: "1-3",
      detail: "GitHub token",
      session: SESSION,
    });
    expect(refused[0]?.story).toBe("1-3");
    // The value is written nowhere: not in an event, not in the state.
    const everything = JSON.stringify([g.journal.events, (await g.projection()).state]);
    expect(everything).not.toContain(KEY.slice(4, 20));
    expect((await g.projection()).state.stories).toMatchObject({
      "1-3": { write_guard: { refused: { secret: 4, scope: 0, decision: 0 } } },
    });
  });

  it("refuses a secret with no story in progress, and a path outside the product, from the text alone", async () => {
    const g = await guarded({ story: false });
    for (const path of [`${ROOT}/src/config.ts`, "/tmp/elsewhere/notes.ts"]) {
      const answer = await g.check("Write", write(path, `const k = "${KEY}"`));
      expect(answer.hookSpecificOutput?.permissionDecision, path).toBe("deny");
    }
    expect(g.events("write.refused")[0]?.story).toBeUndefined();
  });

  it("is not lifted by widening the scope: a secret goes in the configuration", async () => {
    const g = await guarded();
    const asked = await g.run("request_creator_action", {
      agent: "main",
      action: { kind: "scope_widen", story: "1-3", paths: ["packages/"] },
      reason: "the page needs it",
    });
    await g.approve((asked as { checkpoint: string }).checkpoint);
    const answer = await g.check(
      "Write",
      write(`${WORKTREE}/packages/protocol/src/a.ts`, `k = "${KEY}"`),
    );
    expect(reasonOf(answer)).toContain("rule secret");
  });

  it("refuses a secret in a very long text (read up to its bound), never for its size alone", async () => {
    const g = await guarded();
    const huge = `k = "${KEY}"\n${"x".repeat(5_000_000)}`;
    const answer = await g.check("Write", write(`${WORKTREE}/packages/core/src/chat/big.ts`, huge));
    expect(reasonOf(answer)).toContain("rule secret");
  });

  it("lets through a variable that reads the secret from the configuration", async () => {
    const g = await guarded();
    const answer = await g.check(
      "Write",
      write(
        `${WORKTREE}/packages/core/src/chat/hook.ts`,
        "const token = process.env.GITHUB_TOKEN;",
      ),
    );
    expect(answer).toEqual({});
  });
});

/** The words of a test that breaks a rule, built here so that this file holds none to read. */
const ONLY = `it${"."}only("a", () => {});`;
const WAIT = "await sleep(500);";

describe("the tests rule", () => {
  const spec = `${WORKTREE}/packages/core/src/chat/hook.test.ts`;

  it("refuses a test isolated, in each file tool, with one line that names the rule and the row", async () => {
    const g = await guarded();
    const answers = [
      await g.check("Write", write(spec, `describe("a", () => {\n  ${ONLY}\n});`)),
      await g.check("Edit", { file_path: `${spec}.x.test.ts`, old_string: "a", new_string: ONLY }),
      await g.check("MultiEdit", {
        file_path: `${spec}.y.test.ts`,
        edits: [{ old_string: "a", new_string: ONLY }],
      }),
    ];
    for (const answer of answers) {
      expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");
      const reason = reasonOf(answer);
      expect(reason).toContain("rule test (focused)");
      expect(reason).toContain("Nothing was written");
      expect(reason).not.toContain("\n");
      expect(reason.length).toBeLessThan(260);
    }
    expect(reasonOf(answers[0] as (typeof answers)[number])).toContain("line 2");
    const refused = g.events("write.refused");
    expect(refused).toHaveLength(3);
    expect(refused[0]?.payload).toMatchObject({
      rule: "test",
      detail: "focused",
      story: "1-3",
      session: SESSION,
    });
    expect((await g.projection()).state.stories).toMatchObject({
      "1-3": { write_guard: { refused: { test: 3 } } },
    });
  });

  it("names each row of the guard: skipped, hard_wait, tautology", async () => {
    const g = await guarded();
    const cases: [string, string][] = [
      ['it.skip("a", () => {});', "skipped"],
      [WAIT, "hard_wait"],
      ["expect(true).toBe(true);", "tautology"],
    ];
    for (const [text, row] of cases) {
      const answer = await g.check("Write", write(`${WORKTREE}/tests/${row}.test.ts`, text));
      expect(reasonOf(answer), row).toContain(`rule test (${row})`);
    }
    expect(g.events("write.refused").map((event) => event.payload?.detail)).toEqual([
      "skipped",
      "hard_wait",
      "tautology",
    ]);
  });

  it("decides without a story in progress, and in the main folder of the product", async () => {
    const g = await guarded({ story: false });
    expect(reasonOf(await g.check("Write", write(`${ROOT}/src/a.test.ts`, ONLY)))).toContain(
      "rule test (focused)",
    );
    expect(g.events("write.refused")[0]?.story).toBeUndefined();
  });

  it("lets through a reason written, a file that is no test, a text that only quotes the words", async () => {
    const g = await guarded();
    const reasoned = `// waits for the sandbox, ticket 4521\nit.skip("a", () => {});`;
    expect(await g.check("Write", write(spec, reasoned))).toEqual({});
    expect(
      await g.check("Write", write(`${WORKTREE}/packages/core/src/chat/hook.ts`, ONLY)),
    ).toEqual({});
    expect(
      await g.check(
        "Write",
        write(spec, `const note = "${ONLY}";\n// ${WAIT}\nexpect(x).toBe(1);`),
      ),
    ).toEqual({});
    expect(await g.check("Write", write(`${WORKTREE}/docs/tests.md`, ONLY))).toEqual({});
    // A folder of a project that only happens to hold the product is no folder of tests.
    expect(
      await g.check("Write", write("/home/tests/shop/src/app.ts", ONLY), "/home/tests/shop"),
    ).toEqual({});
    expect(g.events("write.refused")).toHaveLength(0);
    expect(g.events("write.doubted")).toHaveLength(0);
  });

  it("refuses a file of tests that is too large, a whole file only, at the limit the creator set", async () => {
    const g = await guarded();
    const lines = (count: number) =>
      `${Array.from({ length: count }, (_, i) => `// line ${i}`).join("\n")}\n`;
    const huge = await g.check("Write", write(spec, lines(1001)));
    expect(reasonOf(huge)).toContain("rule test (oversize)");
    expect(reasonOf(huge)).toContain("1001 lines");
    expect(reasonOf(huge)).not.toContain("\n");
    expect(await g.check("Write", write(spec, lines(1000)))).toEqual({});
    // An edit carries a piece, not the file: its size is not known, so it is not refused for it.
    expect(
      await g.check("Edit", { file_path: spec, old_string: "a", new_string: lines(1500) }),
    ).toEqual({});
    // The creator's limit, in `tests.max_lines` of method.yaml.
    const path = ".agentplugged/method.yaml";
    g.files.seed(path, `${await g.files.readText(path)}tests:\n  max_lines: 300\n`);
    expect(reasonOf(await g.check("Write", write(spec, lines(400))))).toContain("limit of 300");
    expect(await g.check("Write", write(spec, lines(300)))).toEqual({});
    // Under the floor of 200 nothing is read of the method.
    expect(await g.check("Write", write(spec, lines(150)))).toEqual({});
  });

  it("reads the limit on the main branch: an agent does not raise it in its own copy", async () => {
    const lines = (count: number) => `${"// a line\n".repeat(count)}`;
    // The working copy says 5 000; the main branch says nothing: the default holds.
    const kept = await guarded({ mainMethod: "format_version: 1\n" });
    const path = ".agentplugged/method.yaml";
    kept.files.seed(path, `${await kept.files.readText(path)}tests:\n  max_lines: 5000\n`);
    expect(reasonOf(await kept.check("Write", write(spec, lines(1200))))).toContain(
      "limit of 1000",
    );
    // The main branch sets 300: it holds.
    const set = await guarded({ mainMethod: "tests:\n  max_lines: 300\n" });
    expect(reasonOf(await set.check("Write", write(spec, lines(400))))).toContain("limit of 300");
    // A section the main branch cannot read gives the default.
    const broken = await guarded({ mainMethod: "tests:\n  max_lines: nonsense\n" });
    expect(await broken.check("Write", write(spec, lines(900)))).toEqual({});
  });

  it("says in an edit that the line is the new text's, and leaves a helper in a folder of tests long", async () => {
    const g = await guarded();
    const answer = await g.check("Edit", {
      file_path: spec,
      old_string: "a",
      new_string: `// ok\n${ONLY}`,
    });
    expect(reasonOf(answer)).toContain("in the new text, line 2");
    const long = `${"// a line\n".repeat(1500)}`;
    expect(await g.check("Write", write(`${WORKTREE}/tests/helpers/builders.ts`, long))).toEqual(
      {},
    );
  });

  it("traces a doubt when it read only part of the text, never a refusal for it", async () => {
    const g = await guarded();
    const answer = await g.check("Write", write(spec, "sleep(".repeat(660_000)));
    expect(answer).toEqual({});
    expect(g.events("write.doubted").map((event) => event.payload?.reason)).toEqual(["timeout"]);
    const big = await g.check("Write", write(`${WORKTREE}/docs/a.ts`, "x".repeat(4_100_000)));
    expect(big).toEqual({});
    expect(g.events("write.doubted").map((event) => event.payload?.reason)).toContain(
      "unreadable_input",
    );
  });

  it("is not lifted by widening the scope, and a secret still comes first", async () => {
    const g = await guarded();
    const answer = await g.check("Write", write(spec, `${ONLY}\nk = "${KEY}"`));
    expect(reasonOf(answer)).toContain("rule secret");
  });
});

describe("the scope rule", () => {
  it("refuses a file the story does not name, then lets it through once the creator widened the scope", async () => {
    const g = await guarded();
    const outside = `${WORKTREE}/packages/protocol/src/index.ts`;
    const refused = await g.check("Write", write(outside, "export const a = 1;"));
    expect(refused.hookSpecificOutput?.permissionDecision).toBe("deny");
    const reason = reasonOf(refused);
    expect(reason).toContain("rule scope");
    expect(reason).toContain("story 1-3");
    expect(reason).toContain("packages/protocol/src/index.ts");
    expect(reason).toContain("scope_widen");
    expect(g.events("write.refused")[0]?.payload).toMatchObject({
      rule: "scope",
      story: "1-3",
      path: outside,
    });

    // What the story names, its tests and its documents go through.
    for (const path of [
      `${WORKTREE}/packages/core/src/chat/new-hook.ts`,
      `${WORKTREE}/packages/protocol/src/index.test.ts`,
      `${WORKTREE}/docs/guide.md`,
    ]) {
      expect(await g.check("Write", write(path, "export {};")), path).toEqual({});
    }

    // The creator widens the scope in one gesture, recorded in the journal.
    const asked = (await g.run("request_creator_action", {
      agent: "main",
      action: { kind: "scope_widen", story: "1-3", paths: ["packages/protocol/"] },
      reason: "the protocol needs the new event",
    })) as { checkpoint: string; risk: string };
    expect(asked.risk).toBe("low");
    await g.approve(asked.checkpoint);
    expect(g.events("creator_action.executed")).toHaveLength(1);
    const story = (await g.projection()).state.stories as Record<string, StoryState>;
    expect(story["1-3"]?.scope_widened).toEqual(["packages/protocol/"]);
    expect(await g.check("Write", write(outside, "export const a = 1;"))).toEqual({});
    // Still not the others.
    const other = await g.check("Write", write(`${WORKTREE}/apps/cli/src/main.ts`, "export {};"));
    expect(reasonOf(other)).toContain("rule scope");
  });

  it("will not widen the scope to everything, and asks more care for a whole top-level folder", async () => {
    const g = await guarded();
    for (const paths of [["**"], ["."], ["*"], ["../x"]]) {
      const refused = await g.call("request_creator_action", {
        agent: "main",
        action: { kind: "scope_widen", story: "1-3", paths },
        reason: "all of it",
      });
      expect(refused.ok, paths.join()).toBe(false);
    }
    const wide = (await g.run("request_creator_action", {
      agent: "main",
      action: { kind: "scope_widen", story: "1-3", paths: ["packages/"] },
      reason: "the whole folder",
    })) as { risk: string };
    expect(wide.risk).toBe("medium");
  });

  it("counts the refusals and shows them in the story's state", async () => {
    const g = await guarded();
    await g.check("Write", write(`${WORKTREE}/apps/cli/src/a.ts`, "export {};"));
    await g.check("Write", write(`${WORKTREE}/apps/cli/src/b.ts`, "export {};"));
    const stories = (await g.projection()).state.stories as Record<string, StoryState>;
    expect(stories["1-3"]?.write_guard?.refused).toEqual({
      secret: 0,
      scope: 2,
      decision: 0,
      test: 0,
    });
    // The files themselves are kept (distinct, bounded) for the walk through the change.
    expect(stories["1-3"]?.write_guard?.paths).toHaveLength(2);
  });

  it("lets a story that names no file write anywhere, and traces the doubt once", async () => {
    const g = await guarded();
    g.files.seed(
      ".agentplugged/stories/1-3-chat-hooks.md",
      STORY.replace(/`[^`]*`/g, "the chat").replace("package.json", "the manifest"),
    );
    const first = await g.check("Write", write(`${WORKTREE}/anything/a.ts`, "export {};"));
    const second = await g.check("Write", write(`${WORKTREE}/anything/b.ts`, "export {};"));
    expect([first, second]).toEqual([{}, {}]);
    const doubts = g
      .events("write.doubted")
      .filter((event) => event.payload?.reason === "no_scope");
    expect(doubts).toHaveLength(1);
  });
});

describe("the decision rule (AD-n)", () => {
  it("refuses a manifest that adds a forbidden dependency, citing the decision", async () => {
    const g = await guarded();
    const answer = await g.check(
      "Write",
      write(`${WORKTREE}/package.json`, '{ "dependencies": { "left-pad": "^1.3.0" } }'),
    );
    expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");
    const reason = reasonOf(answer);
    expect(reason).toContain("decision AD-1");
    expect(reason).toContain("dependency left-pad");
    expect(g.events("write.refused")[0]?.payload).toMatchObject({
      rule: "decision",
      decision: "AD-1",
      story: "1-3",
    });
  });

  it("refuses an import the decision forbids from that folder, and only from there", async () => {
    const g = await guarded();
    const page = await g.check(
      "Edit",
      {
        file_path: `${WORKTREE}/src/ui/page.ts`,
        old_string: "// db",
        new_string: 'import { Pool } from "pg";',
      },
      WORKTREE,
    );
    expect(reasonOf(page)).toContain("decision AD-2");
    // The same import in the data layer is the decision's own business.
    const data = await g.check(
      "Write",
      write(`${WORKTREE}/packages/core/src/chat/db.ts`, 'import { Pool } from "pg";'),
    );
    expect(data).toEqual({});
  });

  it("lets through a decision it cannot check, and traces that doubt once", async () => {
    const g = await guarded({ architecture: PROSE_ONLY });
    const target = `${WORKTREE}/packages/core/src/chat/a.ts`;
    expect(await g.check("Write", write(target, "export {};"))).toEqual({});
    expect(await g.check("Write", write(target, "export const b = 1;"))).toEqual({});
    const doubts = g.events("write.doubted");
    expect(doubts).toHaveLength(1);
    expect(doubts[0]?.payload).toMatchObject({ reason: "unverifiable_decision", story: "1-3" });
  });

  it("lets everything through when the architecture is not approved", async () => {
    const g = await guarded();
    // The architecture changed after its approval: it declares nothing.
    g.files.seed(ARCHITECTURE_PATH, `${CHECKABLE}\n- **Guard:** no dependency zod\n`);
    const answer = await g.check(
      "Write",
      write(`${WORKTREE}/package.json`, '{ "dependencies": { "left-pad": "1" } }'),
    );
    expect(answer).toEqual({});
  });
});

describe("the doubt passes", () => {
  it("lets through a write with no story in progress, and traces the doubt once per session", async () => {
    const g = await guarded({ story: false });
    const path = `${ROOT}/src/anything.ts`;
    expect(await g.check("Write", write(path, "export {};"))).toEqual({});
    expect(await g.check("Write", write(`${ROOT}/src/other.ts`, "export {};"))).toEqual({});
    const doubts = g.events("write.doubted");
    expect(doubts).toHaveLength(1);
    expect(doubts[0]?.payload).toMatchObject({ reason: "no_story", session: SESSION });
    expect(g.events("write.refused")).toHaveLength(0);
  });

  it("lets through a file of the product's folder while the story works in its own copy", async () => {
    const g = await guarded();
    expect(await g.check("Write", write(`${ROOT}/src/anything.ts`, "export {};"))).toEqual({});
    expect(g.events("write.doubted")[0]?.payload).toMatchObject({ reason: "no_story" });
  });

  it("says nothing about a file outside the product and the stories' copies", async () => {
    const g = await guarded();
    expect(await g.check("Write", write("/tmp/elsewhere/notes.ts", "export {};"))).toEqual({});
    expect(g.events("write.doubted")).toHaveLength(0);
  });

  it("lets through a path it cannot place, and an input it cannot read", async () => {
    const g = await guarded();
    expect(await g.check("Write", write("../../../etc/x", "export {};"), WORKTREE)).toEqual({});
    // A tool that gave no path (the hook left `${…}` as is): nothing to check, the write goes.
    expect(await g.check("Write", { content: "export {};" })).toEqual({});
    const bad = await g.registry.run("check_write", g.agent, { tool: 42 });
    expect(bad).toEqual({ ok: true, value: {} });
  });

  it("lets through on an error of the engine and traces it", async () => {
    const g = await guarded();
    // The story's files cannot be read: the scope cannot be known.
    const listed = g.files.listFiles.bind(g.files);
    g.files.listFiles = async (dir: string) => {
      if (dir.includes("stories")) throw new Error("disk");
      return listed(dir);
    };
    const answer = await g.check("Write", write(`${WORKTREE}/apps/cli/src/main.ts`, "export {};"));
    expect(answer).toEqual({});
    expect(g.events("write.doubted")[0]?.payload).toMatchObject({ reason: "error" });
    expect(g.events("write.refused")).toHaveLength(0);
  });

  it("lets through when the journal cannot be read at all", async () => {
    const g = await guarded();
    g.journal.listFailure = new Error("busy");
    const answer = await g.check("Write", write(`${WORKTREE}/apps/cli/src/main.ts`, "export {};"));
    expect(answer).toEqual({});
  });

  it("never waits more than a few hundred milliseconds: a slow journal lets the write through, traced", async () => {
    const g = await guarded({ budget: 40 });
    const real = g.journal.list.bind(g.journal);
    g.journal.list = async () => {
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 300));
      return real();
    };
    const started = Date.now();
    const answer = await g.check("Write", write(`${WORKTREE}/apps/cli/src/main.ts`, "export {};"));
    // The check itself waits for the traces too (writeGuardIdle): time the engine's own answer.
    expect(answer).toEqual({});
    expect(Date.now() - started).toBeLessThan(2000);
    const doubts = g.events("write.doubted");
    expect(doubts[0]?.payload).toMatchObject({ reason: "timeout" });
    // The first reading went on: the next write is judged on it, fast, and refused by its rule.
    const timed = Date.now();
    const next = await g.registry.run("check_write", g.agent, {
      tool: "Write",
      path: `${WORKTREE}/apps/cli/src/other.ts`,
      text: "export {};",
      session: SESSION,
      cwd: ROOT,
    });
    expect(Date.now() - timed).toBeLessThan(300);
    expect(next.ok && JSON.stringify(next.value)).toContain("rule scope");
  });

  it("answers a write that would be refused without waiting for the journal when it is a secret", async () => {
    const g = await guarded({ budget: 20 });
    g.journal.list = () => new Promise(() => undefined);
    const started = Date.now();
    const result = await g.registry.run("check_write", g.agent, {
      tool: "Write",
      path: `${WORKTREE}/packages/core/src/chat/a.ts`,
      text: `k = "${KEY}"`,
      session: SESSION,
      cwd: ROOT,
    });
    expect(result.ok && JSON.stringify(result.value)).toContain("rule secret");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("stays out of a folder that is no AgentPlugged product", async () => {
    const g = await guarded();
    g.files.files.delete(".agentplugged/method.yaml");
    expect(await g.check("Write", write(`${WORKTREE}/apps/cli/src/main.ts`, "export {};"))).toEqual(
      {},
    );
    expect(g.events("write.doubted")).toHaveLength(0);
  });
});

describe("a refusal costs little, and the journal does not fill up", () => {
  it("writes one event for a file and a rule per session, however often the agent retries", async () => {
    const g = await guarded();
    const target = `${WORKTREE}/apps/cli/src/main.ts`;
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(reasonOf(await g.check("Write", write(target, "export {};")))).toContain("rule scope");
    }
    expect(g.events("write.refused")).toHaveLength(1);
    // Another file is another refusal.
    await g.check("Write", write(`${WORKTREE}/apps/cli/src/other.ts`, "export {};"));
    expect(g.events("write.refused")).toHaveLength(2);
  });

  it("writes at most fifty refusals for a session", async () => {
    const g = await guarded();
    for (let file = 0; file < 60; file++) {
      const answer = await g.check(
        "Write",
        write(`${WORKTREE}/apps/cli/src/f${file}.ts`, "export {};"),
      );
      expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");
    }
    expect(g.events("write.refused")).toHaveLength(50);
  });

  it("keeps a path of emoji within what the journal accepts", async () => {
    const g = await guarded();
    const answer = await g.check(
      "Write",
      write(`${WORKTREE}/apps/cli/src/${"😀".repeat(200)}.ts`, "export {};"),
    );
    expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(g.events("write.refused")).toHaveLength(1);
    expect(
      ((g.events("write.refused")[0]?.payload ?? {}) as { path: string }).path.length,
    ).toBeLessThanOrEqual(300);
  });

  it("lets through a key the documentation made up", async () => {
    const g = await guarded();
    const target = `${WORKTREE}/packages/core/src/chat/example.ts`;
    expect(await g.check("Write", write(target, 'const key = "AKIAIOSFODNN7EXAMPLE";'))).toEqual(
      {},
    );
    expect(
      await g.check("Write", write(target, "OPENAI_API_KEY=sk-your-api-key-goes-here")),
    ).toEqual({});
  });
});

describe("what the hook gives for MultiEdit and for a tool it could not read", () => {
  const target = `${WORKTREE}/src/ui/page.ts`;

  it("reads the new text of each edit of a MultiEdit, secret and decision alike", async () => {
    const g = await guarded();
    const secret = await g.check("MultiEdit", {
      file_path: target,
      edits: [
        { old_string: "a", new_string: "const a = 1;" },
        { old_string: "b", new_string: `const k = "${KEY}"; // "quoted"\n` },
      ],
    });
    expect(reasonOf(secret)).toContain("rule secret");
    const decision = await g.check("MultiEdit", {
      file_path: target,
      edits: [{ old_string: "a", new_string: 'import { Pool } from "pg";' }],
    });
    expect(reasonOf(decision)).toContain("decision AD-2");
    expect(
      await g.check("MultiEdit", {
        file_path: target,
        edits: [{ old_string: "a", new_string: "b" }],
      }),
    ).toEqual({});
  });

  it("traces a text it could not read, once, and goes on with the other rules", async () => {
    const g = await guarded();
    // Claude Code turned the list of edits into text the engine cannot read.
    const answer = await g.registry.run("check_write", g.agent, {
      tool: "MultiEdit",
      path: `${WORKTREE}/apps/cli/src/main.ts`,
      text: "[object Object],[object Object]",
      session: SESSION,
      cwd: ROOT,
    });
    await writeGuardIdle(g.agent);
    // The scope rule still sees the path.
    expect(JSON.stringify(answer.ok && answer.value)).toContain("rule scope");
    expect(g.events("write.doubted").map((event) => event.payload?.reason)).toEqual([
      "unreadable_input",
    ]);
  });

  it("traces an input with no path, and an input it cannot parse", async () => {
    const g = await guarded();
    expect(await g.check("Write", { content: "export {};" })).toEqual({});
    const bad = await g.registry.run("check_write", g.agent, { tool: 42 });
    await writeGuardIdle(g.agent);
    expect(bad).toEqual({ ok: true, value: {} });
    expect(g.events("write.doubted").map((event) => event.payload?.reason)).toEqual([
      "unreadable_input",
      "unreadable_input",
    ]);
  });
});

describe("the index follows the journal without making a write wait", () => {
  it("serves the last index while a new one is read, and refuses on the new one only", async () => {
    const g = await guarded({ budget: 80 });
    const inside = `${WORKTREE}/packages/core/src/chat/a.ts`;
    const outside = `${WORKTREE}/apps/cli/src/main.ts`;
    expect(await g.check("Write", write(inside, "export {};"))).toEqual({});
    // Something unrelated moves the journal, and reading it again becomes slow.
    await g.run("report_status", { agent: "sam", status: "working", task: "x", story: "1-3" });
    const real = g.journal.list.bind(g.journal);
    g.journal.list = async () => {
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 400));
      return real();
    };
    const started = Date.now();
    // A write that passes is judged on the last index at once: no timeout, no doubt.
    expect(await g.check("Write", write(inside, "export const n = 1;"))).toEqual({});
    expect(Date.now() - started).toBeLessThan(300);
    expect(g.events("write.doubted")).toHaveLength(0);
    // A write that would be refused waits for the new index (an old scope may be one just widened):
    // past the budget it goes through in doubt.
    expect(await g.check("Write", write(outside, "export {};"))).toEqual({});
    expect(g.events("write.doubted")[0]?.payload).toMatchObject({ reason: "timeout" });
    // Once the new index is read, the refusal comes.
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 600));
    g.journal.list = real;
    expect(reasonOf(await g.check("Write", write(outside, "export {};")))).toContain("rule scope");
  });
});

describe("where the story works", () => {
  it("guards a session that runs in the story's own working copy", async () => {
    const g = await guarded({ root: WORKTREE });
    const outside = await g.check(
      "Write",
      write(`${WORKTREE}/apps/cli/src/main.ts`, "export {};"),
      WORKTREE,
    );
    expect(reasonOf(outside)).toContain("rule scope");
    expect(
      await g.check(
        "Write",
        write(`${WORKTREE}/packages/core/src/chat/a.ts`, "export {};"),
        WORKTREE,
      ),
    ).toEqual({});
  });

  it("reads a path written with the long-path prefix of Windows like the plain one", async () => {
    const g = await guarded({ platform: "win32", root: "C:/work/shop" });
    const answer = await g.check(
      "Write",
      write("\\\\?\\C:\\work\\shop.worktrees\\1-3\\apps\\cli\\src\\main.ts", "export {};"),
      "C:\\work\\shop",
    );
    expect(reasonOf(answer)).toContain("rule scope");
  });

  it("reads the paths the way Windows spells them, case aside", async () => {
    const g = await guarded({ platform: "win32", root: "C:/work/shop" });
    const copy = "C:\\work\\Shop.worktrees\\1-3";
    const inside = await g.check(
      "Write",
      write(`${copy}\\packages\\core\\src\\chat\\hook.ts`, "export {};"),
      "C:\\work\\shop",
    );
    expect(inside).toEqual({});
    const outside = await g.check(
      "Write",
      write(`${copy}\\apps\\cli\\src\\main.ts`, "export {};"),
      "C:\\work\\shop",
    );
    expect(reasonOf(outside)).toContain("rule scope");
    expect(reasonOf(outside)).toContain("apps/cli/src/main.ts");
  });

  it("guards a story that works in the main folder (no branch per story) from that folder", async () => {
    const g = await guarded({ worktree: "." });
    const outside = await g.check("Write", write(`${ROOT}/apps/cli/src/main.ts`, "export {};"));
    expect(reasonOf(outside)).toContain("rule scope");
    expect(reasonOf(outside)).toContain("story 1-3");
    expect(
      await g.check("Write", write(`${ROOT}/packages/core/src/chat/a.ts`, "export {};")),
    ).toEqual({});
  });

  it("does not guess between two stories that share the main folder", async () => {
    const g = await guarded({ worktree: "." });
    g.files.seed(".agentplugged/stories/1-4-other.md", STORY.replaceAll("1-3", "1-4"));
    await g.journal.appendAll([
      {
        type: "story.started",
        actor: { kind: "agent", agent: "sam" },
        product: g.productId,
        story: "1-4",
        provenance: "trusted",
        payload: {
          agent: "sam",
          branch: "feat/1-4-other",
          base: COMMIT,
          base_ref: "main",
          worktree: ".",
        },
      },
    ]);
    const answer = await g.check("Write", write(`${ROOT}/apps/cli/src/main.ts`, "export {};"));
    expect(answer).toEqual({});
    expect(g.events("write.doubted")[0]?.payload).toMatchObject({ reason: "ambiguous_story" });
  });
});

describe("the hook sync installs", () => {
  it("is written in .claude/settings.json for the four file tools, with the engine's own tool", async () => {
    const g = await guarded();
    const settings = JSON.parse(g.files.files.get(".claude/settings.json") ?? "{}") as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> };
    };
    const ours = settings.hooks.PreToolUse.filter((group) =>
      ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(group.matcher),
    );
    expect(ours.map((group) => group.matcher)).toEqual([
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
    ]);
    for (const group of ours) {
      const hook = group.hooks[0] as Record<string, unknown>;
      expect(hook).toMatchObject({ type: "mcp_tool", server: "agentplugged", tool: "guard" });
      // What Claude Code fills in from its own input.
      expect(hook.input).toMatchObject({
        action: "write",
        session: hookValue("session_id"),
        cwd: hookValue("cwd"),
      });
      // The fence around the engine's own budget: seconds, not minutes.
      expect(hook.timeout).toBeLessThanOrEqual(5);
    }
    const notebook = ours[3]?.hooks[0] as { input: Record<string, string> };
    expect(notebook.input.path).toBe(hookValue("tool_input.notebook_path"));
  });

  it("answers fast once it has read the product: no text is added to the context when the write passes", async () => {
    const g = await guarded();
    const path = `${WORKTREE}/packages/core/src/chat/a.ts`;
    expect(await g.check("Write", write(path, "export {};"))).toEqual({});
    const timed = Date.now();
    for (let i = 0; i < 20; i++) {
      expect(await g.check("Write", write(path, `export const n = ${i};`))).toEqual({});
    }
    expect((Date.now() - timed) / 20).toBeLessThan(150);
    expect(g.events("write.doubted")).toHaveLength(0);
  });
});
