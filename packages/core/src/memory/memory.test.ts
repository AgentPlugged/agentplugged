import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentSession,
  type CommandContext,
  computeProjectionDetailed,
  createCommandRegistry,
  initCommand,
  MemoryCommonMemory,
  MemoryKeyStore,
  type MemoryRead,
  MemoryStateStore,
  type NextResult,
  type RecordedEvent,
  readProductKey,
  renderConstitutionReference,
  resolveProfile,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(7));
const OTHER_SEED = toBase64url(new Uint8Array(32).fill(8));

function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

function storyFile(id: string, owner: string) {
  return [
    "---",
    `id: ${id}`,
    "kind: story",
    `owner: ${owner}`,
    `title: Story ${id}`,
    "epic: epic-1",
    "reviewer: quentin",
    "requirements: [EF-1]",
    "budget_usd: 1",
    `branch: feat/${id}-work`,
    "depends_on: []",
    "---",
    `# Story ${id}`,
    "",
    "## Context",
    "",
    "Accounts.",
    "",
    "## Intent",
    "",
    `Ada can do ${id}.`,
    "",
    "## Acceptance criteria",
    "",
    "Given Ada, when she acts, then it works.",
    "",
    "## Out of scope",
    "",
    "Nothing else.",
    "",
  ].join("\n");
}

const LESSON_A = {
  title: "Run the contract tests first",
  text: "Run the contract tests before the pull request: two stories bounced on them.",
  tags: ["testing"],
};
const LESSON_B = {
  title: "Ask for the sample data early",
  text: "Ask the creator for sample data in the first story of an epic.",
  agents: ["sam"],
};
const SECRET_TEXT = "contract tests";

/** A product with its stories 1-1 and 1-2, a machine key, and the common memory of this machine. */
async function product(options: { seed?: string; commonMemory?: MemoryCommonMemory } = {}) {
  const files = new MemoryFiles();
  let clock = Date.UTC(2026, 9, 4, 12, 0, 0);
  const now = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(options.seed ?? SEED);
  const journal = new MemoryStateStore({ keys, now });
  const common = options.commonMemory ?? new MemoryCommonMemory();
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("izzy", "Izzy", "product", "build"),
      ...shippedAgent("sam", "Sam", "code", "build"),
      ...shippedAgent("quentin", "Quentin", "quality", "build"),
    }),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
    keys,
  };
  const init = await initCommand.run(human, {
    profile: resolveProfile("new-product", { phases: ["build"] }),
  });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  await files.writeText(
    ".agentplugged/epics/epic-1.md",
    "---\nid: epic-1\nkind: epic\nowner: izzy\n---\n# Epic 1\n",
  );
  await files.writeText(".agentplugged/stories/1-1-sign-up.md", storyFile("1-1", "sam"));
  await files.writeText(".agentplugged/stories/1-2-sign-in.md", storyFile("1-2", "sam"));
  const session = new AgentSession();
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    human: undefined,
    commonMemory: common,
    session,
  };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown> = {}) =>
    registry.run(name, agent, input);
  const ok = async <T = RecordedEvent>(name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok)
      throw new Error(`${name} failed: ${result.error.code} ${result.error.message_key}`);
    return result.value as T;
  };
  const code = async (name: string, input: Record<string, unknown> = {}) => {
    const result = await call(name, input);
    if (result.ok) return "ok";
    return `${result.error.code}:${String(result.error.details.reason ?? "")}`;
  };
  /** The creator at the terminal answers a checkpoint. */
  const answer = async (checkpoint: string, decision = "approved", note?: string) => {
    const answered = await registry.run("review", human, {
      action: "resolve",
      checkpoint,
      decision,
      ...(note === undefined ? {} : { note }),
    });
    if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
  };
  /** A story done: its `story` checkpoint approved. */
  const done = async (story: string) => {
    const opened = await ok("open_checkpoint", {
      agent: "sam",
      type: "story",
      risk: "low",
      title: `Story ${story}`,
      summary: "Done.",
      story,
    });
    await answer(opened.checkpoint as string);
  };
  const finishEpic = async () => {
    await done("1-1");
    await done("1-2");
  };
  type Proposed = RecordedEvent & { retrospective: string; lessons: string[] };
  const propose = async (extra: Record<string, unknown> = {}) =>
    ok<Proposed>("propose_retrospective", {
      agent: "izzy",
      scope: { kind: "epic", id: "1" },
      summary: "Two stories, both bounced once.",
      lessons: [LESSON_A, LESSON_B],
      actions: [{ text: "Add a lint rule for imports.", owner: "sam" }],
      ...extra,
    });
  /** Proposes, approves and records one retrospective; returns its lessons' ids. */
  const record = async (extra: Record<string, unknown> = {}) => {
    const proposed = await propose(extra);
    await answer(proposed.checkpoint as string);
    await ok("record_lessons", { agent: "izzy", checkpoint: proposed.checkpoint });
    return proposed;
  };
  const read = async (reader = "sam", extra: Record<string, unknown> = {}) =>
    ok<MemoryRead>("read_memory", { agent: reader, ...extra });
  const next = async () => ok<NextResult>("next", {});
  return {
    files,
    keys,
    journal,
    common,
    human,
    agent,
    session,
    registry,
    call,
    ok,
    code,
    answer,
    done,
    finishEpic,
    propose,
    record,
    read,
    next,
  };
}

describe("the retrospective", () => {
  it("is due once an epic is done, to Izzy, and a rejected one is not asked again", async () => {
    const p = await product();
    expect((await p.next()).step).not.toBe("retrospective");
    await p.finishEpic();
    const step = await p.next();
    expect(step).toMatchObject({
      step: "retrospective",
      agent: "izzy",
      scope: { kind: "epic", id: "1" },
    });
    const proposed = await p.propose();
    // Its checkpoint waits for the creator, ahead of any other step.
    expect(await p.next()).toMatchObject({ step: "validation", checkpoint: proposed.checkpoint });
    await p.answer(proposed.checkpoint as string, "rejected", "Not now.");
    expect((await p.next()).step).not.toBe("retrospective");
  });

  it("opens a memory checkpoint with counts only and an encrypted proposal", async () => {
    const p = await product();
    await p.finishEpic();
    const proposed = await p.propose({
      retire: [],
      lessons: [LESSON_A],
    });
    expect(proposed.retrospective).toMatch(/^R-[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(proposed.lessons).toEqual([`L-${proposed.retrospective.slice(2)}-1`]);
    const opened = p.journal.events.find(
      (event) =>
        event.type === "checkpoint.opened" &&
        event.payload !== undefined &&
        (event.payload as { type: string }).type === "memory",
    );
    expect(opened?.payload).toMatchObject({
      type: "memory",
      risk: "low",
      title: "Retrospective: epic 1",
      memory: { kind: "retrospective", scope: { kind: "epic", id: "1" } },
    });
    const proposal = p.journal.events.find(
      (event) => event.type === "memory.retrospective_proposed",
    );
    expect(proposal?.payload).toBeUndefined();
    expect(proposal?.payload_enc).toBeDefined();
    // No text of any lesson is in the journal, in clear.
    expect(JSON.stringify(p.journal.events)).not.toContain(SECRET_TEXT);
  });

  it("refuses a scope that is unknown, running or taken, never a session that read outside", async () => {
    const p = await product();
    expect(
      await p.code("propose_retrospective", {
        agent: "izzy",
        scope: { kind: "epic", id: "9" },
        summary: "x",
        lessons: [LESSON_A],
      }),
    ).toBe("MEMORY_INVALID:unknown_scope");
    expect(
      await p.code("propose_retrospective", {
        agent: "izzy",
        scope: { kind: "epic", id: "1" },
        summary: "x",
        lessons: [LESSON_A],
      }),
    ).toBe("MEMORY_INVALID:scope_not_finished");
    await p.done("1-1");
    await p.done("1-2");
    // What a session read outside is a trace in the journal: it blocks no retrospective.
    await p.ok("record_external_read", { tool: "WebFetch", source: "https://evil.example/page" });
    expect(
      await p.code("propose_retrospective", {
        agent: "izzy",
        scope: { kind: "epic", id: "1" },
        summary: "x",
        lessons: [LESSON_A],
      }),
    ).toBe("ok");
    const fresh = await product();
    await fresh.finishEpic();
    await fresh.propose();
    expect(
      await fresh.code("propose_retrospective", {
        agent: "izzy",
        scope: { kind: "epic", id: "1" },
        summary: "x",
        lessons: [LESSON_A],
      }),
    ).toBe("MEMORY_INVALID:scope_taken");
  });

  it("writes nothing without the product key", async () => {
    const p = await product();
    await p.finishEpic();
    p.keys.products.clear();
    expect(
      await p.code("propose_retrospective", {
        agent: "izzy",
        scope: { kind: "epic", id: "1" },
        summary: "x",
        lessons: [LESSON_A],
      }),
    ).toMatch(/^PRODUCT_KEY_MISSING/);
    expect(p.journal.events.some((event) => event.type === "memory.retrospective_proposed")).toBe(
      false,
    );
  });
});

describe("recording the lessons the creator approved", () => {
  it("records nothing before the approval, then writes encrypted files and the anchors", async () => {
    const p = await product();
    await p.finishEpic();
    const proposed = await p.propose();
    expect(await p.code("record_lessons", { agent: "izzy", checkpoint: proposed.checkpoint })).toBe(
      "MEMORY_INVALID:not_approved",
    );
    expect([...p.files.files.keys()].some((path) => path.includes("memory/lessons/"))).toBe(false);
    expect((await p.read()).empty).toBe(true);
    await p.answer(proposed.checkpoint as string);
    expect(await p.next()).toMatchObject({
      step: "memory_record",
      agent: "izzy",
      checkpoint: proposed.checkpoint,
    });
    const recorded = await p.ok<{ recorded: string[]; retired: string[] }>("record_lessons", {
      agent: "izzy",
      checkpoint: proposed.checkpoint,
    });
    expect(recorded.recorded).toEqual(proposed.lessons);
    const file =
      p.files.files.get(`.agentplugged/memory/lessons/${proposed.lessons[0]}.json`) ?? "";
    expect(file.startsWith("agentplugged-enc:1:")).toBe(true);
    expect(file).not.toContain(SECRET_TEXT);
    const anchor = p.journal.events.find((event) => event.type === "lessons.recorded");
    expect(JSON.stringify(anchor?.payload)).not.toContain(SECRET_TEXT);
    expect((await p.next()).step).not.toBe("memory_record");
    // A second call is refused by the engine as already done: it only repairs files.
    const again = await p.ok<{ repaired: string[] }>("record_lessons", {
      agent: "izzy",
      checkpoint: proposed.checkpoint,
    });
    expect(again.repaired).toEqual([]);
    expect(p.journal.events.filter((event) => event.type === "lessons.recorded")).toHaveLength(1);
  });

  it("serves the lessons to the agent they are for, filtered by tags, and the actions", async () => {
    const p = await product();
    await p.finishEpic();
    const proposed = await p.record();
    const sam = await p.read("sam");
    expect(sam.lessons.map((lesson) => lesson.id).sort()).toEqual([...proposed.lessons].sort());
    expect(sam.lessons[0]).toMatchObject({ source: "product" });
    expect(sam.actions).toMatchObject([{ owner: "sam", scope: "epic 1" }]);
    // Lesson B is for Sam only.
    const izzy = await p.read("izzy");
    expect(izzy.lessons.map((lesson) => lesson.title)).toEqual([LESSON_A.title]);
    const tagged = await p.read("sam", { tags: ["testing"] });
    expect(tagged.lessons.map((lesson) => lesson.title)).toEqual([LESSON_A.title]);
    expect((await p.read("sam", { limit: 1 })).warnings).toEqual([{ code: "truncated", count: 1 }]);
  });

  it("leaves out what the creator reserved, and only with reservations", async () => {
    const p = await product();
    await p.finishEpic();
    const proposed = await p.propose();
    await p.answer(proposed.checkpoint as string);
    const [first, second] = proposed.lessons as [string, string];
    expect(
      await p.code("record_lessons", {
        agent: "izzy",
        checkpoint: proposed.checkpoint,
        except: [second],
      }),
    ).toBe("MEMORY_INVALID:except_not_allowed");
    const reserved = await product();
    await reserved.finishEpic();
    const other = await reserved.propose();
    await reserved.answer(
      other.checkpoint as string,
      "approved_with_reservations",
      "Not the second.",
    );
    const [a, b] = other.lessons as [string, string];
    expect(
      await reserved.code("record_lessons", {
        agent: "izzy",
        checkpoint: other.checkpoint,
        except: ["L-0000000000-1"],
      }),
    ).toBe("MEMORY_INVALID:except_unknown");
    const recorded = await reserved.ok<{ recorded: string[] }>("record_lessons", {
      agent: "izzy",
      checkpoint: other.checkpoint,
      except: [b],
    });
    expect(recorded.recorded).toEqual([a]);
    expect((await reserved.read("sam")).lessons.map((lesson) => lesson.id)).toEqual([a]);
    expect(first).toBeDefined();
  });

  it("refuses to record a refused retrospective, or a checkpoint that is none", async () => {
    const p = await product();
    await p.finishEpic();
    const proposed = await p.propose();
    await p.answer(proposed.checkpoint as string, "changes_requested", "Shorter.");
    expect(await p.code("record_lessons", { agent: "izzy", checkpoint: proposed.checkpoint })).toBe(
      "MEMORY_INVALID:not_approved",
    );
    expect(await p.code("record_lessons", { agent: "izzy", checkpoint: "G-0000000000" })).toBe(
      "MEMORY_INVALID:unknown_checkpoint",
    );
    // Sent back, it returns to its author, who may propose again.
    expect(await p.next()).toMatchObject({ step: "changes_requested", agent: "izzy" });
    const again = await p.propose({ summary: "Shorter." });
    expect(again.checkpoint).not.toBe(proposed.checkpoint);
  });

  it("repairs a lost or altered file from the journal, with no second event", async () => {
    const p = await product();
    await p.finishEpic();
    const proposed = await p.record();
    const [first, second] = proposed.lessons as [string, string];
    p.files.files.delete(`.agentplugged/memory/lessons/${first}.json`);
    const altered = `.agentplugged/memory/lessons/${second}.json`;
    p.files.files.set(altered, `${p.files.files.get(altered)}x`);
    const damaged = await p.read("sam");
    expect(damaged.lessons).toEqual([]);
    expect(damaged.warnings).toEqual(
      expect.arrayContaining([
        { code: "lesson_missing", ids: [first] },
        { code: "lesson_altered", ids: [second] },
      ]),
    );
    const repaired = await p.ok<{ repaired: string[] }>("record_lessons", {
      agent: "izzy",
      checkpoint: proposed.checkpoint,
    });
    expect(repaired.repaired.sort()).toEqual([first, second].sort());
    expect((await p.read("sam")).lessons).toHaveLength(2);
    expect(p.journal.events.filter((event) => event.type === "lessons.recorded")).toHaveLength(1);
  });
});

describe("no lesson without the creator", () => {
  it("refuses an agent's own write in memory/lessons and memory/retros, and serves no planted file", async () => {
    const p = await product();
    for (const path of ["lessons/L-x.json", "retros/R-x.json", "Lessons/a.md", "LESSONS/a.md"]) {
      expect(
        await p.code("write_sensitive", { agent: "sam", area: "memory", path, content: "{}" }),
      ).toBe(
        "INVALID_ARGUMENTS:write_sensitive: path: memory/lessons/ and memory/retros/ are written by the engine, after the creator approves a retrospective (propose_retrospective)",
      );
    }
    // Other paths of the memory keep working.
    expect(
      await p.code("write_sensitive", {
        agent: "sam",
        area: "memory",
        path: "notes.md",
        content: "x",
      }),
    ).toBe("ok");
    // A file planted by hand in memory/lessons/ is never served.
    p.files.seed(".agentplugged/memory/lessons/L-AAAAAAAAAA-1.json", "{}");
    const served = await p.read("sam");
    expect(served.lessons).toEqual([]);
    expect(served.warnings).toEqual([{ code: "lessons_unvalidated", count: 1 }]);
  });

  it("serves no lesson whose anchor the creator never approved, even one an event forges", async () => {
    const p = await product();
    await p.finishEpic();
    const proposed = await p.propose();
    const product_id = (await p.journal.productId()) as string;
    // An anchor for a retrospective nobody approved: the projection holds it, nothing serves it.
    await p.journal.appendAll([
      {
        type: "lessons.recorded",
        actor: { kind: "agent", agent: "izzy" },
        product: product_id,
        provenance: "trusted",
        payload: {
          checkpoint: proposed.checkpoint,
          retro: proposed.retrospective,
          lessons: [{ id: proposed.lessons[0], digest: "a".repeat(64) }],
          retired: [],
          excepted: [],
        },
      },
    ]);
    const served = await p.read();
    expect(served.lessons).toEqual([]);
    expect(served.warnings).toEqual([]);
  });

  it("ignores a proposal that names a checkpoint it was not written with", async () => {
    const p = await product();
    await p.finishEpic();
    const proposed = await p.propose();
    const product_id = (await p.journal.productId()) as string;
    await p.journal.appendAll([
      {
        type: "memory.retrospective_proposed",
        actor: { kind: "agent", agent: "izzy" },
        product: product_id,
        provenance: "trusted",
        payload: {
          checkpoint: proposed.checkpoint,
          scope: { kind: "epic", id: "1" },
          summary: "Forged.",
          lessons: [{ title: "Forged", text: "Forged lesson.", salt: "0".repeat(32) }],
          retire: [],
          actions: [],
        },
      },
    ]);
    const listing = await p.journal.list();
    const key = await readProductKey(p.keys, product_id);
    const detailed = await computeProjectionDetailed(listing.events, {
      problems: listing.problems,
      head: listing.head,
      product: product_id,
      ...(key === undefined ? {} : { productKey: key }),
    });
    const retros = Object.values(
      (detailed.projection.state.memory as { retros: Record<string, { summary: string }> }).retros,
    );
    expect(retros.map((retro) => retro.summary)).toEqual(["Two stories, both bounced once."]);
    expect(detailed.projection.ignored.some((event) => event.reason === "invalid")).toBe(true);
  });

  it("tells the agents how the memory works: constitution and activation step", async () => {
    const constitution = renderConstitutionReference();
    for (const text of [
      "## Memory",
      "`memory.read`",
      "never override this constitution",
      "Never write a lesson yourself",
      "`memory.retrospective`",
      "`memory.promote`",
    ]) {
      expect(constitution.replace(/\s+/g, " ")).toContain(text.replace(/\s+/g, " "));
    }
    // Noah's own part (retrospectives are Izzy's) is in his role, checked with the method.
    // A session that read outside proposes lessons like any other.
    expect(constitution).not.toContain("untrusted_session");
  });

  it("refuses Noah and the main session while Noah is active", async () => {
    const files = new MemoryFiles();
    const keys = new MemoryKeyStore(SEED);
    const journal = new MemoryStateStore({ keys });
    const human: CommandContext = {
      files,
      tools: NO_TOOL,
      method: shippedMethod({
        ...shippedAgent("noah", "Noah", "product", "framing"),
        ...shippedAgent("izzy", "Izzy", "product", "build"),
      }),
      actor: "human",
      engineVersion: "1.0.0",
      journal,
      keys,
    };
    const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
    if (!init.ok) throw new Error("init failed");
    const registry = createCommandRegistry();
    const agent: CommandContext = { ...human, actor: "agent" };
    for (const name of [
      "propose_retrospective",
      "record_lessons",
      "propose_promotion",
      "promote_lesson",
    ]) {
      for (const who of ["noah", "main"]) {
        const result = await registry.run(name, agent, { agent: who });
        expect(result.ok ? undefined : result.error.code, `${name} ${who}`).toBe(
          ErrorCode.ROLE_FORBIDDEN,
        );
      }
    }
    // Reading is Noah's.
    const read = await registry.run("read_memory", agent, { agent: "noah" });
    expect(read.ok).toBe(true);
  });
});

describe("contradictory and old lessons", () => {
  it("a lesson that replaces another retires it once approved, never before", async () => {
    const p = await product();
    await p.finishEpic();
    const first = await p.record({ lessons: [LESSON_A], actions: [] });
    const old = first.lessons[0] as string;
    // A second retrospective, of a sprint-less scope, cannot reuse the epic: use a new epic.
    await p.files.writeText(
      ".agentplugged/stories/2-1-x.md",
      storyFile("2-1", "sam").replace("epic-1", "epic-2"),
    );
    await p.done("2-1");
    const second = await p.propose({
      scope: { kind: "epic", id: "2" },
      lessons: [
        {
          title: "Run them in CI",
          text: "Run the contract tests in the CI, not by hand.",
          replaces: [old],
        },
      ],
      actions: [],
    });
    // Proposed, not approved: the old lesson is still served.
    expect((await p.read()).lessons.map((lesson) => lesson.id)).toEqual([old]);
    await p.answer(second.checkpoint as string);
    await p.ok("record_lessons", { agent: "izzy", checkpoint: second.checkpoint });
    const now = await p.read();
    expect(now.lessons.map((lesson) => lesson.title)).toEqual(["Run them in CI"]);
  });

  it("refuses to replace or retire what is not active, or twice", async () => {
    const p = await product();
    await p.finishEpic();
    const gone = {
      agent: "izzy",
      scope: { kind: "epic", id: "1" },
      summary: "x",
    };
    expect(
      await p.code("propose_retrospective", {
        ...gone,
        lessons: [{ ...LESSON_A, replaces: ["L-0000000000-1"] }],
      }),
    ).toBe("MEMORY_INVALID:lesson_unknown");
    expect(
      await p.code("propose_retrospective", {
        ...gone,
        retire: [{ lesson: "L-0000000000-1", reason: "wrong" }],
      }),
    ).toBe("MEMORY_INVALID:lesson_unknown");
    const first = await p.record({ lessons: [LESSON_A], actions: [] });
    const old = first.lessons[0] as string;
    await p.files.writeText(
      ".agentplugged/stories/2-1-x.md",
      storyFile("2-1", "sam").replace("epic-1", "epic-2"),
    );
    await p.done("2-1");
    expect(
      await p.code("propose_retrospective", {
        ...gone,
        scope: { kind: "epic", id: "2" },
        lessons: [{ ...LESSON_B, replaces: [old] }],
        retire: [{ lesson: old, reason: "wrong" }],
      }),
    ).toBe("MEMORY_INVALID:lesson_conflict");
    // A plain retirement.
    const retire = await p.propose({
      scope: { kind: "epic", id: "2" },
      lessons: [],
      retire: [{ lesson: old, reason: "No longer true." }],
      actions: [],
    });
    await p.answer(retire.checkpoint as string);
    await p.ok("record_lessons", { agent: "izzy", checkpoint: retire.checkpoint });
    expect((await p.read()).empty).toBe(true);
  });
});

describe("a machine without the product key", () => {
  it("reads an empty memory with a warning, and the common memory still", async () => {
    const p = await product();
    await p.finishEpic();
    await p.record();
    p.keys.products.clear();
    const served = await p.read("sam");
    expect(served.lessons).toEqual([]);
    expect(served.warnings).toEqual([{ code: "product_key_missing" }]);
    expect(served.empty).toBe(true);
  });

  it("reads the memory of nobody else: another product's files do not decrypt", async () => {
    const p = await product();
    await p.finishEpic();
    await p.record();
    const stranger = await product();
    for (const [path, text] of p.files.files) {
      if (path.includes("memory/lessons/")) stranger.files.seed(path, text);
    }
    const served = await stranger.read("sam");
    expect(served.lessons).toEqual([]);
    expect(served.warnings).toEqual([{ code: "lessons_unvalidated", count: 2 }]);
  });
});

describe("promotion to the common memory", () => {
  async function recorded(common = new MemoryCommonMemory()) {
    const p = await product({ commonMemory: common });
    await p.finishEpic();
    const proposed = await p.record({ lessons: [LESSON_A], actions: [] });
    return { p, lesson: proposed.lessons[0] as string };
  }

  it("shares one approved lesson, encrypted, with another product of the machine", async () => {
    const common = new MemoryCommonMemory();
    const { p, lesson } = await recorded(common);
    const promotion = await p.ok("propose_promotion", { agent: "izzy", lesson });
    // Nothing is shared before the approval.
    expect(common.entries.size).toBe(0);
    expect(
      await p.code("promote_lesson", { agent: "izzy", checkpoint: promotion.checkpoint }),
    ).toBe("MEMORY_INVALID:not_approved");
    expect(await p.code("propose_promotion", { agent: "izzy", lesson })).toBe(
      "MEMORY_INVALID:promotion_pending",
    );
    const opened = p.journal.events.find(
      (event) =>
        (event.payload as { memory?: { kind: string } } | undefined)?.memory?.kind === "promotion",
    );
    expect(opened?.payload).toMatchObject({ type: "memory", risk: "medium", memory: { lesson } });
    expect(JSON.stringify(opened?.payload)).not.toContain(SECRET_TEXT);
    await p.answer(promotion.checkpoint as string);
    expect(await p.next()).toMatchObject({
      step: "memory_record",
      checkpoint: promotion.checkpoint,
    });
    const promoted = await p.ok<{ common: string }>("promote_lesson", {
      agent: "izzy",
      checkpoint: promotion.checkpoint,
    });
    expect(promoted.common).toMatch(/^C-/);
    const stored = [...common.entries.values()][0] ?? "";
    expect(stored.startsWith("agentplugged-enc:1:")).toBe(true);
    expect(stored).not.toContain(SECRET_TEXT);
    expect(await p.code("propose_promotion", { agent: "izzy", lesson })).toBe(
      "MEMORY_INVALID:already_promoted",
    );
    // Another product on the same machine (same machine key, own product key) reads it.
    const other = await product({ commonMemory: common });
    const served = await other.read("sam");
    expect(served.lessons).toMatchObject([{ source: "common", title: LESSON_A.title }]);
    // A second call restores nothing and writes no second event.
    await p.ok("promote_lesson", { agent: "izzy", checkpoint: promotion.checkpoint });
    expect(p.journal.events.filter((event) => event.type === "lessons.promoted")).toHaveLength(1);
  });

  it("writes nothing when the creator refuses, and a common lesson can be replaced", async () => {
    const common = new MemoryCommonMemory();
    const { p, lesson } = await recorded(common);
    const refused = await p.ok("propose_promotion", { agent: "izzy", lesson });
    await p.answer(refused.checkpoint as string, "rejected", "No.");
    expect(await p.code("promote_lesson", { agent: "izzy", checkpoint: refused.checkpoint })).toBe(
      "MEMORY_INVALID:not_approved",
    );
    expect(common.entries.size).toBe(0);
    const first = await p.ok("propose_promotion", { agent: "izzy", lesson });
    await p.answer(first.checkpoint as string);
    const one = await p.ok<{ common: string }>("promote_lesson", {
      agent: "izzy",
      checkpoint: first.checkpoint,
    });
    expect(
      await p.code("propose_promotion", { agent: "izzy", lesson, replaces: ["C-0000000000"] }),
    ).toBe("MEMORY_INVALID:already_promoted");
    expect(one.common).toBeDefined();
  });

  it("supersedes a common entry it replaces, and retires the copy of a retired lesson", async () => {
    const common = new MemoryCommonMemory();
    const { p, lesson } = await recorded(common);
    const one = await p.ok("propose_promotion", { agent: "izzy", lesson });
    await p.answer(one.checkpoint as string);
    const shared = await p.ok<{ common: string }>("promote_lesson", {
      agent: "izzy",
      checkpoint: one.checkpoint,
    });
    // Retiring the product lesson retires its shared copy too.
    await p.files.writeText(
      ".agentplugged/stories/2-1-x.md",
      storyFile("2-1", "sam").replace("epic-1", "epic-2"),
    );
    await p.done("2-1");
    const retire = await p.propose({
      scope: { kind: "epic", id: "2" },
      lessons: [],
      retire: [{ lesson, reason: "Wrong." }],
      actions: [],
    });
    await p.answer(retire.checkpoint as string);
    await p.ok("record_lessons", { agent: "izzy", checkpoint: retire.checkpoint });
    expect((await p.read()).lessons).toEqual([]);
    expect(shared.common).toBeDefined();
  });

  it("is refused without a machine key and for an unknown lesson, never for a session that read outside", async () => {
    const { p, lesson } = await recorded();
    expect(await p.code("propose_promotion", { agent: "izzy", lesson: "L-0000000000-1" })).toBe(
      "MEMORY_INVALID:lesson_unknown",
    );
    expect(
      await p.code("propose_promotion", { agent: "izzy", lesson, replaces: ["C-0000000000"] }),
    ).toBe("MEMORY_INVALID:common_unknown");
    p.keys.secret = undefined;
    expect(await p.code("propose_promotion", { agent: "izzy", lesson })).toBe(
      "MEMORY_INVALID:common_unavailable",
    );
    const q = await recorded();
    await q.p.ok("record_external_read", { tool: "WebFetch", source: "https://evil.example/" });
    expect(await q.p.code("propose_promotion", { agent: "izzy", lesson: q.lesson })).toBe("ok");
  });

  it("serves nothing from a common memory whose machine key changed, and warns", async () => {
    const common = new MemoryCommonMemory();
    const { p, lesson } = await recorded(common);
    const one = await p.ok("propose_promotion", { agent: "izzy", lesson });
    await p.answer(one.checkpoint as string);
    await p.ok("promote_lesson", { agent: "izzy", checkpoint: one.checkpoint });
    const elsewhere = await product({ commonMemory: common, seed: OTHER_SEED });
    const served = await elsewhere.read("sam");
    expect(served.lessons).toEqual([]);
    expect(served.warnings).toEqual([{ code: "common_altered", ids: [...common.entries.keys()] }]);
  });
});

describe("what the reviews found", () => {
  it("requires the reservations to name what they leave out, actions included", async () => {
    const p = await product();
    await p.finishEpic();
    const proposed = await p.propose();
    await p.answer(proposed.checkpoint as string, "approved_with_reservations", "Not the action.");
    expect(await p.code("record_lessons", { agent: "izzy", checkpoint: proposed.checkpoint })).toBe(
      "MEMORY_INVALID:except_required",
    );
    const action = `${proposed.retrospective}-A1`;
    await p.ok("record_lessons", {
      agent: "izzy",
      checkpoint: proposed.checkpoint,
      except: [action],
    });
    const served = await p.read("sam");
    expect(served.lessons).toHaveLength(2);
    expect(served.actions).toEqual([]);
  });

  it("records an approved retrospective whose target another one retired meanwhile", async () => {
    const p = await product();
    await p.finishEpic();
    const first = await p.record({ lessons: [LESSON_A], actions: [] });
    const old = first.lessons[0] as string;
    for (const epic of ["2", "3"]) {
      await p.files.writeText(
        `.agentplugged/stories/${epic}-1-x.md`,
        storyFile(`${epic}-1`, "sam").replace("epic-1", `epic-${epic}`),
      );
      await p.done(`${epic}-1`);
    }
    const retire = (epic: string) =>
      p.propose({
        scope: { kind: "epic", id: epic },
        lessons: [],
        retire: [{ lesson: old, reason: "Wrong." }],
        actions: [],
      });
    const two = await retire("2");
    const three = await retire("3");
    await p.answer(two.checkpoint as string);
    await p.answer(three.checkpoint as string);
    await p.ok("record_lessons", { agent: "izzy", checkpoint: two.checkpoint });
    const skipped = await p.ok<{ skipped: string[] }>("record_lessons", {
      agent: "izzy",
      checkpoint: three.checkpoint,
    });
    expect(skipped.skipped).toEqual([old]);
    // Nothing stays to record: `next` is free again.
    expect((await p.next()).step).not.toBe("memory_record");
  });

  it("filters nothing for an empty tag list, and hides what a failing keychain cannot read", async () => {
    const p = await product();
    await p.finishEpic();
    await p.record();
    expect((await p.read("sam", { tags: [] })).lessons).toHaveLength(2);
    const readProduct = p.keys.readProductSecret.bind(p.keys);
    p.keys.readProductSecret = async () => {
      throw new Error("keychain locked");
    };
    const served = await p.read("sam");
    expect(served.lessons).toEqual([]);
    expect(served.warnings).toEqual([{ code: "keychain_unavailable" }]);
    p.keys.readProductSecret = readProduct;
  });

  it("refuses an invisible character in a lesson, and the raw read of a lesson file", async () => {
    const p = await product();
    await p.finishEpic();
    for (const hidden of ["a​b", "a‮b", "a\u{E0041}b"]) {
      expect(
        await p.code("propose_retrospective", {
          agent: "izzy",
          scope: { kind: "epic", id: "1" },
          summary: "x",
          lessons: [{ title: "T", text: `Run ${hidden} tests.` }],
        }),
      ).toMatch(/^INVALID_ARGUMENTS/);
    }
    const proposed = await p.record();
    const read = await p.code("read_sensitive", {
      agent: "quentin",
      area: "memory",
      path: `lessons/${proposed.lessons[0]}.json`,
    });
    expect(read).toMatch(/^INVALID_ARGUMENTS/);
  });

  it("answers a change of the memory in the chat once the session read outside, recorded as it was proved", async () => {
    const p = await product();
    await p.finishEpic();
    const proposed = await p.propose();
    await p.ok("record_external_read", { tool: "WebFetch", source: "https://evil.example/page" });
    expect(
      await p.code("answer_checkpoint", {
        agent: "izzy",
        checkpoint: proposed.checkpoint,
        decision: "approved",
        quote: "ok",
      }),
    ).toBe("ok");
  });

  it("serves a shared copy of this product's lesson never twice, and not once it is retired", async () => {
    const common = new MemoryCommonMemory();
    const p = await product({ commonMemory: common });
    await p.finishEpic();
    const proposed = await p.record({ lessons: [LESSON_A], actions: [] });
    const lesson = proposed.lessons[0] as string;
    const promotion = await p.ok("propose_promotion", { agent: "izzy", lesson });
    await p.answer(promotion.checkpoint as string);
    // A second promotion of the same lesson, while the first is approved and not carried out.
    expect(await p.code("propose_promotion", { agent: "izzy", lesson })).toBe(
      "MEMORY_INVALID:promotion_pending",
    );
    await p.ok("promote_lesson", { agent: "izzy", checkpoint: promotion.checkpoint });
    expect((await p.read("sam")).lessons.map((entry) => entry.source)).toEqual(["product"]);
    // Without the product key the shared copy serves, until its lesson is retired.
    const stranger = await product({ commonMemory: common });
    expect((await stranger.read("sam")).lessons.map((entry) => entry.source)).toEqual(["common"]);
  });

  it("finishes a promotion whose files failed, and never revives a retired lesson", async () => {
    const common = new MemoryCommonMemory();
    const p = await product({ commonMemory: common });
    await p.finishEpic();
    const proposed = await p.record({ lessons: [LESSON_A, LESSON_B], actions: [] });
    const [first, second] = proposed.lessons as [string, string];
    const one = await p.ok("propose_promotion", { agent: "izzy", lesson: first });
    await p.answer(one.checkpoint as string);
    const shared = await p.ok<{ common: string }>("promote_lesson", {
      agent: "izzy",
      checkpoint: one.checkpoint,
    });
    const two = await p.ok("propose_promotion", {
      agent: "izzy",
      lesson: second,
      replaces: [shared.common],
    });
    await p.answer(two.checkpoint as string);
    // The record is written, then the files fail: the call says so, and a second one finishes.
    const original = common.write.bind(common);
    common.write = async () => {
      throw new Error("disk full");
    };
    const failed = await p.code("promote_lesson", { agent: "izzy", checkpoint: two.checkpoint });
    expect(failed).toMatch(/^UNEXPECTED/);
    common.write = original;
    const finished = await p.ok<{ replaced: string[] }>("promote_lesson", {
      agent: "izzy",
      checkpoint: two.checkpoint,
    });
    expect(finished.replaced).toEqual([shared.common]);
    expect(p.journal.events.filter((event) => event.type === "lessons.promoted")).toHaveLength(2);
    const served = await p.read("sam");
    expect(served.lessons.filter((entry) => entry.source === "common")).toEqual([]);
  });
});

describe("due retrospectives and the review card", () => {
  it("asks for the latest finished epic only, not for a whole history", async () => {
    const p = await product();
    await p.finishEpic();
    await p.files.writeText(
      ".agentplugged/stories/2-1-x.md",
      storyFile("2-1", "sam").replace("epic-1", "epic-2"),
    );
    await p.done("2-1");
    expect(await p.next()).toMatchObject({
      step: "retrospective",
      scope: { kind: "epic", id: "2" },
    });
  });

  it("shows the creator what a retrospective contains, decrypted by the engine", async () => {
    const p = await product();
    await p.finishEpic();
    const proposed = await p.propose();
    const listed = await p.registry.run("review", p.human, {
      action: "list",
      checkpoint: proposed.checkpoint,
    });
    if (!listed.ok) throw new Error(listed.error.code);
    const preview = (
      listed.value as { memory?: Record<string, { kind: string; lessons: { text: string }[] }> }
    ).memory?.[proposed.checkpoint as string];
    expect(preview?.kind).toBe("retrospective");
    expect(preview?.lessons.map((lesson) => lesson.text)).toEqual([LESSON_A.text, LESSON_B.text]);
    // Without the key, the card says nothing of the content.
    p.keys.products.clear();
    const blind = await p.registry.run("review", p.human, {
      action: "list",
      checkpoint: proposed.checkpoint,
    });
    expect(blind.ok && (blind.value as { memory?: unknown }).memory).toBeFalsy();
  });

  it("looks back on a finished sprint, and refuses one still running", async () => {
    const p = await product();
    expect(
      await p.code("propose_retrospective", {
        agent: "izzy",
        scope: { kind: "sprint", id: "S-0000000000" },
        summary: "x",
        lessons: [LESSON_A],
      }),
    ).toBe("MEMORY_INVALID:unknown_scope");
  });
});
