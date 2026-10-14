import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode, type PhaseId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentNextResult,
  type AgentStateView,
  type CommandContext,
  type CritiqueResult,
  createCommandRegistry,
  createUlidFactory,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type RecordedEvent,
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
import { versionsOf } from "./critique-rules.js";

/**
 * The critique of a deliverable, end to end: a critique asked, a report refused then
 * accepted, the stack, the three gestures, an open hypothesis brought back when a proof arrives
 * and closed by the creator, the critique offered once per version.
 */

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(7));

function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

const PRD_PATH = ".agentplugged/docs/prd.md";
const ARCHITECTURE_PATH = ".agentplugged/docs/architecture.md";
const BRIEF_PATH = ".agentplugged/docs/brief.md";

const prd = (extra = "") =>
  [
    "---",
    "id: prd",
    "kind: prd",
    "owner: iris",
    "---",
    "# PRD",
    "",
    "## Exports",
    "",
    "- EF-1: The visitor exports their data.",
    "- ENF-1: A page answers in at most 300 ms, measured by `pnpm bench`.",
    extra,
    "",
  ]
    .filter((line, index) => line !== "" || index !== 4)
    .join("\n");

const story = (id: string, requirements: string[]) =>
  [
    "---",
    `id: ${id}`,
    "kind: story",
    "owner: sam",
    `requirements: [${requirements.join(", ")}]`,
    "---",
    `# Story ${id}`,
    "",
  ].join("\n");

/** `inFraming`: a new product, still in its framing phase (the phases are closed otherwise). */
async function product(options: { inFraming?: boolean } = {}) {
  const files = new MemoryFiles();
  let clock = Date.UTC(2026, 9, 9, 9, 0, 0);
  const now = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now, newId: createUlidFactory({ now }) });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("sam", "Sam", "code", "build"),
      ...shippedAgent("quentin", "Quentin", "quality", "build"),
    }),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  const run = async <T = unknown>(name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok) {
      throw new Error(
        `${name} failed: ${result.error.code} ${JSON.stringify(result.error.details)}`,
      );
    }
    return result.value as T;
  };
  const resolve = (checkpoint: string | undefined, extra: Record<string, unknown>) =>
    registry.run("review", human, { action: "resolve", checkpoint, ...extra });
  const approve = async (checkpoint: string | undefined) => {
    const answered = await resolve(checkpoint, { decision: "approved" });
    if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
  };
  const closers: Partial<Record<PhaseId, string>> = {
    framing: "iris",
    planning: "main",
    design: "main",
  };
  for (const phase of options.inFraming === true
    ? []
    : (["framing", "planning", "design"] as const)) {
    const opened = await run<RecordedEvent>("open_checkpoint", {
      agent: closers[phase],
      type: "phase_end",
      phase,
      risk: "low",
      title: `End of ${phase}`,
      summary: "Ready.",
    });
    await approve(opened.checkpoint);
  }
  if (options.inFraming !== true) {
    files.seed(PRD_PATH, prd());
    files.seed(".agentplugged/stories/1-1-export.md", story("1-1", ["EF-1"]));
  }
  const critique = (input: Record<string, unknown>) =>
    run<CritiqueResult>("critique", { agent: "quentin", ...input });
  const state = () => run<AgentStateView>("get_state", { full: true });
  const next = () => run<AgentNextResult>("next", {});
  /** A story of the product delivered: the code a passage covers changed. */
  const deliver = async (id: string) => {
    const opened = await run<RecordedEvent>("open_checkpoint", {
      agent: "sam",
      type: "story",
      risk: "low",
      title: `Story ${id}`,
      summary: "Done.",
      story: id,
    });
    await approve(opened.checkpoint);
  };
  return { files, journal, call, run, critique, state, next, resolve, deliver };
}

const OBJECTIONS = [
  {
    severity: "minor",
    claim: "The word visitor is not defined.",
    passage: "Exports",
    argument: "The glossary does not say who a visitor is.",
  },
  {
    severity: "blocking",
    claim: "An export of a whole account can time out.",
    passage: "EF-1",
    argument: "Nothing bounds the number of rows an export reads.",
    proposal: "Cap the export or make it asynchronous.",
    proof: "Export 100 000 rows in a test.",
  },
  {
    severity: "should_fix",
    claim: "Three hundred milliseconds is measured on an empty database.",
    passage: "ENF-1",
    argument: "The benchmark does not say with how much data it runs.",
    proposal: "State the data size the budget holds for.",
    proof: "Run the benchmark on a database of one million rows.",
  },
];

/** A report on the PRD: the document is the `kind`, the method the one `lenses` entry. */
const REPORT = {
  kind: "prd",
  lenses: ["pre_mortem"],
  summary: "Requirements fail by what they forgot.",
  findings: OBJECTIONS,
};

const errorOf = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? undefined : (result.error as { code: string; details: Record<string, unknown> });

describe("the critique of a deliverable", () => {
  it("refuses a report that is not whole with the list of what is missing, then accepts it", async () => {
    const { call, critique, journal } = await product();
    const bare = await call("critique", {
      agent: "quentin",
      kind: "prd",
      findings: [
        { severity: "blocking", claim: "No limit." },
        { severity: "minor", claim: "Unclear.", passage: "Pricing", argument: "Never priced." },
      ],
    });
    const error = errorOf(bare);
    expect(error).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    const reason = String(error?.details.reason);
    for (const missing of [
      "method_missing",
      "summary_missing",
      "passage_missing:1",
      "argument_missing:1",
      "proposal_missing:1",
      "proof_missing:1",
      "passage_unknown:2",
    ]) {
      expect(reason).toContain(missing);
    }
    // Nothing was written by the refusal.
    expect(journal.events.some((event) => event.type === "critique.reported")).toBe(false);

    const accepted = await critique(REPORT);
    expect(accepted.critique).toMatch(/^K-[0-9A-Z]{10}$/);
    expect(accepted.objections).toBe(3);
    // The creator's stack: the graver first, one line each, numbered as in the report.
    expect(accepted.stack).toEqual([
      "2. blocking · EF-1 — An export of a whole account can time out.",
      "3. should_fix · ENF-1 — Three hundred milliseconds is measured on an empty database.",
      "1. minor · Exports — The word visitor is not defined.",
    ]);
    const stored = journal.events.find((event) => event.type === "critique.reported");
    expect(stored?.payload).toMatchObject({
      document: PRD_PATH,
      method: "pre_mortem",
      versions: versionsOf(prd()),
    });
  });

  it("refuses a document that is not there, a method or a document it does not know", async () => {
    const { call, files } = await product();
    // The UX specification does not exist in this product.
    expect(await files.exists(".agentplugged/docs/ux.md")).toBe(false);
    const absent = await call("critique", { agent: "quentin", ...REPORT, kind: "ux" });
    expect(String(errorOf(absent)?.details.reason)).toContain("document_not_found");
    for (const wrong of [{ kind: "readme" }, { lenses: ["brainstorm"] }]) {
      const result = await call("critique", { agent: "quentin", ...REPORT, ...wrong });
      expect(errorOf(result)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    }
    // A field the call does not use is named, not ignored.
    const stray = await call("critique", { agent: "quentin", ...REPORT, quote: "oui" });
    expect(String(errorOf(stray)?.details.reason)).toContain("unexpected:quote");
    // Only an active agent critiques.
    const stranger = await call("critique", { agent: "ghost", ...REPORT });
    expect(stranger.ok).toBe(false);
  });

  it("records the creator's three gestures: correct, follow as a hypothesis, drop with a reason", async () => {
    const { call, critique, state, journal } = await product();
    const { critique: id } = await critique(REPORT);
    const gestures = (
      items: unknown[],
      quote: string | null = "1 écarte, 2 hypothèse, 3 corrige",
    ) => ({
      agent: "quentin",
      item: id,
      items,
      ...(quote === null ? {} : { quote }),
    });
    // Dropping needs the creator's reason; following a hypothesis needs its proof; both need their words.
    const noReason = await call("critique", gestures([{ n: 1, gesture: "discard" }]));
    expect(String(errorOf(noReason)?.details.reason)).toContain("reason_missing:1");
    const noQuote = await call("critique", gestures([{ n: 3, gesture: "fix" }], null));
    expect(String(errorOf(noQuote)?.details.reason)).toContain("quote_missing");
    const noProof = await call("critique", gestures([{ n: 1, gesture: "hypothesis" }]));
    expect(String(errorOf(noProof)?.details.reason)).toContain("proof_missing:1");

    const settled = await run(
      call,
      gestures([
        { n: 1, gesture: "discard", reason: "Defined in the glossary." },
        { n: 2, gesture: "hypothesis" },
        { n: 3, gesture: "fix" },
      ]),
    );
    expect(settled).toMatchObject({
      settled: { fix: 1, hypothesis: 1, discard: 1 },
      hypotheses: [`H-${id?.slice(2)}-2`],
      // The author of the document corrects it, not the critic.
      fix: { owner: "iris", proposals: ["3. State the data size the budget holds for."] },
      left: 0,
    });
    expect(journal.events.some((event) => event.type === "critique.settled")).toBe(true);
    // The hypothesis is in the journal and in the state; nothing is left to sort.
    const view = (await state()).critique;
    expect(view?.open).toBe(1);
    expect(view?.hypotheses[0]).toContain("An export of a whole account can time out.");
    expect(view?.awaiting).toBeUndefined();
    // An objection already sorted cannot be sorted twice.
    const again = await call("critique", gestures([{ n: 3, gesture: "discard", reason: "No." }]));
    expect(String(errorOf(again)?.details.reason)).toContain("objection_settled:3");
  });

  it("lets the creator sort some objections now and the rest later, and shows what waits", async () => {
    const { call, critique, state } = await product();
    const { critique: id } = await critique(REPORT);
    await run(call, {
      agent: "quentin",
      item: id,
      items: [{ n: 2, gesture: "fix" }],
      quote: "la 2, corrige",
    });
    expect((await state()).critique?.awaiting).toEqual([`${id} · prd.md · 2 left`]);
  });

  it("replaces the earlier critique of a document by the new one, and keeps the hypotheses", async () => {
    const { call, critique, state } = await product();
    const { critique: first } = await critique({ ...REPORT, findings: [OBJECTIONS[1]] });
    await run(call, {
      agent: "quentin",
      item: first,
      items: [{ n: 1, gesture: "hypothesis" }],
      quote: "hypothèse",
    });
    await critique({ ...REPORT, lenses: ["red_team"], findings: [OBJECTIONS[2]] });
    const view = (await state()).critique;
    // The hypothesis of the first critique stands; the new critique waits for the creator.
    expect(view?.open).toBe(1);
    expect(view?.awaiting).toHaveLength(1);
    // The old critique is gone: it cannot be settled any more.
    const stale = await call("critique", {
      agent: "quentin",
      item: first,
      items: [{ n: 1, gesture: "fix" }],
      quote: "oui",
    });
    expect(String(errorOf(stale)?.details.reason)).toContain("critique_unknown");
  });

  it("recalls an open hypothesis when a proof arrives, and is closed on the creator's decision", async () => {
    const { call, critique, run: send, next, state } = await product();
    const { critique: id } = await critique({ ...REPORT, findings: [OBJECTIONS[2]] });
    await send("critique", {
      agent: "quentin",
      item: id,
      items: [{ n: 1, gesture: "hypothesis" }],
      quote: "garde-la en hypothèse",
    });
    const hypothesis = `H-${id?.slice(2)}-1`;
    // No evidence yet: nothing is brought back.
    expect((await next()).hypotheses_due).toBeUndefined();
    // A proof of ENF-1 arrives (a measure over its budget).
    await send("sync_requirements", { agent: "quentin" });
    await send("record_proof", {
      agent: "quentin",
      requirement: "ENF-1",
      measured: 450,
      source: "pnpm bench",
    });
    const recalled = await next();
    expect(recalled.hypotheses_due).toEqual([
      `${hypothesis} · Three hundred milliseconds is measured on an empty database. — proof fail for ENF-1`,
    ]);
    // The creator looks at it and keeps it open: it stays quiet until a newer evidence.
    await send("critique", {
      agent: "quentin",
      item: hypothesis,
      items: [{ gesture: "still_open", reason: "Not enough data yet." }],
      quote: "encore ouverte",
    });
    expect((await next()).hypotheses_due).toBeUndefined();
    expect((await state()).critique?.open).toBe(1);
    await send("record_proof", {
      agent: "quentin",
      requirement: "ENF-1",
      measured: 250,
      source: "pnpm bench",
    });
    expect((await next()).hypotheses_due).toHaveLength(1);
    // Closed on the creator's decision: proved. It leaves the open list and is not brought back.
    const closed = await send<CritiqueResult>("critique", {
      agent: "quentin",
      item: hypothesis,
      items: [{ gesture: "proved", reason: "250 ms on a million rows." }],
      quote: "prouvée",
    });
    expect(closed).toMatchObject({ hypothesis, outcome: "proved", open: 0 });
    expect((await next()).hypotheses_due).toBeUndefined();
    expect((await state()).critique).toBeUndefined();
    // Closing it twice is refused.
    const twice = await call("critique", {
      agent: "quentin",
      item: hypothesis,
      items: [{ gesture: "dropped", reason: "Again." }],
      quote: "encore",
    });
    expect(String(errorOf(twice)?.details.reason)).toContain("hypothesis_unknown");
  });

  it("recalls a hypothesis when a story that cites its passage is delivered", async () => {
    const { critique, run: send, next, deliver } = await product();
    const { critique: id } = await critique({ ...REPORT, findings: [OBJECTIONS[1]] });
    await send("critique", {
      agent: "quentin",
      item: id,
      items: [{ n: 1, gesture: "hypothesis" }],
      quote: "hypothèse",
    });
    expect((await next()).hypotheses_due).toBeUndefined();
    // Story 1-1 cites EF-1, the passage's identifier.
    await deliver("1-1");
    const recalled = (await next()).hypotheses_due;
    expect(recalled).toHaveLength(1);
    expect(recalled?.[0]).toContain("story 1-1 delivered (EF-1)");
  });
});

describe("what is left of a critique, and a new report", () => {
  it("shows again what the creator did not sort, and the corrections kept, after the session was cut", async () => {
    const { call, critique, run: send } = await product();
    const { critique: id } = await critique(REPORT);
    await send("critique", {
      agent: "quentin",
      item: id,
      items: [{ n: 3, gesture: "fix" }],
      quote: "la 3, corrige",
    });
    // Only the item: nothing is written, the open objections come back, the graver first.
    const shown = await run(call, { agent: "quentin", item: id });
    expect(shown).toEqual({
      critique: id,
      stack: [
        "2. blocking · EF-1 — An export of a whole account can time out.",
        "1. minor · Exports — The word visitor is not defined.",
      ],
      fix: { owner: "iris", proposals: ["3. State the data size the budget holds for."] },
      left: 2,
    });
    const unknown = await call("critique", { agent: "quentin", item: "K-0000000000" });
    expect(String(errorOf(unknown)?.details.reason)).toContain("critique_unknown");
  });

  it("writes nothing when it only shows", async () => {
    const { critique, run: send, journal } = await product();
    const { critique: id } = await critique(REPORT);
    const events = journal.events.length;
    await send("critique", { agent: "quentin", item: id });
    expect(journal.events.length).toBe(events);
  });

  it("refuses a new report while the creator's stack for that version waits, never wiping it", async () => {
    const { call, critique, files, run: send } = await product();
    const { critique: id } = await critique(REPORT);
    // An agent cannot erase the objections the creator did not sort, even with an empty report.
    for (const findings of [[], [OBJECTIONS[1]]]) {
      const again = await call("critique", { agent: "quentin", ...REPORT, findings });
      expect(String(errorOf(again)?.details.reason)).toContain(`critique_unsorted:${id}`);
    }
    // The document changed: the old critique is obsolete and a new one is welcome.
    files.seed(PRD_PATH, prd("- EF-2: Exports are capped."));
    const fresh = await critique({ ...REPORT, findings: [OBJECTIONS[1]] });
    expect(fresh.critique).not.toBe(id);
    // Sorted objections do not hold a new report back either.
    await send("critique", {
      agent: "quentin",
      item: fresh.critique,
      items: [{ n: 1, gesture: "fix" }],
      quote: "oui",
    });
    expect((await critique({ ...REPORT, findings: [] })).objections).toBe(0);
  });
});

describe("Noah offers the critique, once per version", () => {
  /** A `document` point on a document at its present version, opened by the author. */
  async function validate(
    p: Awaited<ReturnType<typeof product>>,
    supersedes?: string,
    path = PRD_PATH,
  ) {
    const text = await p.files.readText(path);
    return p.run<RecordedEvent>("open_checkpoint", {
      agent: "iris",
      type: "document",
      risk: "low",
      title: "Document to validate",
      summary: "Ready.",
      documents: [{ path, branch: "main", blob_sha: versionsOf(text)[0] }],
      ...(supersedes === undefined ? {} : { supersedes }),
    });
  }
  const RISKY = "- ENF-2: Passwords are encrypted at rest, verified by review.";

  it("offers it with the reason, in the step that asks the creator, and never imposes it", async () => {
    const p = await product();
    p.files.seed(PRD_PATH, prd(RISKY));
    await validate(p);
    const step = await p.next();
    expect(step.step).toBe("validation");
    expect(step.critique).toEqual({ kind: "prd", why: "security_requirements" });
  });

  it("offers it once: after the offer is recorded, the same version is not offered again", async () => {
    const p = await product();
    p.files.seed(PRD_PATH, prd(RISKY));
    const first = await validate(p);
    expect((await p.next()).critique).toBeDefined();
    const proposed = await p.critique({ kind: "prd" });
    expect(proposed).toEqual({ offered: PRD_PATH });
    expect(p.journal.events.filter((event) => event.type === "critique.proposed")).toHaveLength(1);
    const after = await p.next();
    expect(after.step).toBe("validation");
    expect(after.critique).toBeUndefined();
    // The offer is recorded once per version.
    const twice = await p.call("critique", { agent: "quentin", kind: "prd" });
    expect(String(errorOf(twice)?.details.reason)).toContain("already_offered");
    // A new version of the document is offered again.
    const refused = await p.resolve(first.checkpoint, {
      decision: "changes_requested",
      note: "Add the export limit.",
    });
    expect(refused.ok).toBe(true);
    p.files.seed(PRD_PATH, prd(`${RISKY}\n- ENF-3: Exports are capped.`));
    await validate(p, first.checkpoint);
    expect((await p.next()).critique).toEqual({ kind: "prd", why: "security_requirements" });
  });

  it("still offers the critique of a version the creator's inputs were reconciled with", async () => {
    const p = await product();
    p.files.seed(PRD_PATH, prd(RISKY));
    await validate(p);
    expect((await p.next()).critique).toBeDefined();
    await p.critique({
      kind: "prd",
      lenses: ["reconcile"],
      summary: "What the brief said and the PRD lost.",
      findings: [],
    });
    expect((await p.next()).critique).toEqual({ kind: "prd", why: "security_requirements" });
  });

  it("refuses a reconciliation that would erase a stack the creator has not sorted", async () => {
    const p = await product();
    await p.critique(REPORT);
    p.files.seed(PRD_PATH, prd("- EF-2: A changed version of the document."));
    const refused = await p.call("critique", {
      agent: "quentin",
      ...REPORT,
      lenses: ["reconcile"],
      findings: [],
    });
    expect(String(errorOf(refused)?.details.reason)).toContain("critique_unsorted");
  });

  it("does not offer it again when the version was already criticised", async () => {
    const p = await product();
    p.files.seed(PRD_PATH, prd(RISKY));
    await validate(p);
    expect((await p.next()).critique).toBeDefined();
    await p.critique(REPORT);
    expect((await p.next()).critique).toBeUndefined();
  });

  it("offers nothing for a document at no risk, and offers a document the creator marked important", async () => {
    const plain = await product();
    await validate(plain);
    expect((await plain.next()).critique).toBeUndefined();

    const marked = await product();
    marked.files.seed(
      BRIEF_PATH,
      "---\nid: brief\nkind: brief\nowner: iris\nimportant: true\n---\n# Brief\n",
    );
    await validate(marked, undefined, BRIEF_PATH);
    expect((await marked.next()).critique).toEqual({ kind: "brief", why: "important" });
  });

  it("does not offer an architecture that only speaks of tokens and permissions", async () => {
    const p = await product();
    p.files.seed(
      ARCHITECTURE_PATH,
      "---\nid: architecture\nkind: architecture\nowner: iris\n---\n# Architecture\n\nDesign tokens, file permissions and a cookie banner.\n",
    );
    await validate(p, undefined, ARCHITECTURE_PATH);
    expect((await p.next()).critique).toBeUndefined();
  });

  it("offers the architecture of a product that holds sensitive data", async () => {
    const p = await product();
    p.files.seed(
      ARCHITECTURE_PATH,
      "---\nid: architecture\nkind: architecture\nowner: iris\n---\n# Architecture\n\nWe store the personal data of the visitors.\n",
    );
    await validate(p, undefined, ARCHITECTURE_PATH);
    expect((await p.next()).critique).toEqual({ kind: "architecture", why: "sensitive_data" });
  });
});

const PRFAQ_PATH = ".agentplugged/docs/prfaq.md";

const prfaq = (extra = "") =>
  [
    "---",
    "id: prfaq",
    "kind: prfaq",
    "owner: iris",
    "---",
    "# Press release: Plumb",
    "",
    "## Release",
    "",
    "2027-03-01 - Plumb lets freelancers invoice in one tap.",
    "",
    "## Customer FAQ",
    "",
    "- How much does it cost? - [open]",
    "",
    "## Internal FAQ",
    "",
    "- What must be true? - Freelancers pay monthly.",
    extra,
    "",
  ].join("\n");

/** The bets of the test of an idea: the personas' strong objections, each with what would prove it. */
const BETS = [
  {
    severity: "should_fix",
    claim: "Freelancers will pay for this every month.",
    passage: "Willingness to pay",
    argument: "The investor sees no one who paid for the first version yet.",
    proposal: "Ask five freelancers to pre-order.",
    proof: "Five pre-orders in two weeks.",
  },
  {
    severity: "blocking",
    claim: "An accounting package already does this for free.",
    passage: "Alternatives",
    argument: "The competitor offers invoicing at no cost to the same people.",
    proposal: "Name what Plumb does that the package does not.",
    proof: "Three freelancers who left the package say why.",
  },
  {
    severity: "minor",
    claim: "Nobody asked for a mobile app.",
    passage: "Form of the product",
    argument: "The impatient user answers from a laptop at the desk.",
  },
];

const IDEA_REPORT = {
  agent: "iris",
  kind: "idea",
  lenses: ["personas"],
  summary: "A demanding customer, the competitor and a skeptical investor.",
  findings: BETS,
};

describe("testing an idea, before the brief", () => {
  it("keeps the bets of the personas as hypotheses on the creator's gesture, in the 17.9 register", async () => {
    const { call, critique, state, journal } = await product({ inFraming: true });
    const accepted = await critique(IDEA_REPORT);
    expect(accepted.objections).toBe(3);
    // The creator's stack: the graver first, one line each.
    expect(accepted.stack).toEqual([
      "2. blocking · Alternatives — An accounting package already does this for free.",
      "1. should_fix · Willingness to pay — Freelancers will pay for this every month.",
      "3. minor · Form of the product — Nobody asked for a mobile app.",
    ]);
    expect(
      journal.events.find((event) => event.type === "critique.reported")?.payload,
    ).toMatchObject({
      document: ".agentplugged/docs/idea",
      method: "personas",
      versions: ["idea"],
    });
    // One gesture per bet: keep one as a hypothesis, drop one with a reason, keep the minor one open.
    const settled = await critique({
      agent: "iris",
      item: accepted.critique,
      items: [
        { n: 1, gesture: "hypothesis" },
        { n: 2, gesture: "discard", reason: "The package is for companies, not freelancers." },
      ],
      quote: "la 1 en hypothèse, la 2 on écarte",
    });
    expect(settled).toMatchObject({
      settled: { fix: 0, hypothesis: 1, discard: 1 },
      hypotheses: [`H-${accepted.critique?.slice(2)}-1`],
      left: 1,
    });
    // The bet is in the same register as the hypotheses of a document, with what would prove it.
    const view = (await state()).critique;
    expect(view?.open).toBe(1);
    expect(view?.hypotheses[0]).toContain("idea — Freelancers will pay for this every month.");
    expect(view?.awaiting).toEqual([`${accepted.critique} · idea · 1 left`]);
    // The creator's reason and words are kept; a bet without its proof cannot be kept.
    const bare = await call("critique", {
      agent: "iris",
      item: accepted.critique,
      items: [{ n: 3, gesture: "hypothesis" }],
      quote: "oui",
    });
    expect(String(errorOf(bare)?.details.reason)).toContain("proof_missing:3");
  });

  it("refuses a report on the idea that is not whole, and a second test while the bets wait", async () => {
    const { call, critique } = await product({ inFraming: true });
    const bare = await call("critique", {
      agent: "iris",
      kind: "idea",
      findings: [{ severity: "blocking", claim: "No buyer." }],
    });
    const reason = String(errorOf(bare)?.details.reason);
    for (const missing of [
      "method_missing",
      "summary_missing",
      "passage_missing:1",
      "proof_missing:1",
    ]) {
      expect(reason).toContain(missing);
    }
    const first = await critique(IDEA_REPORT);
    const again = await call("critique", IDEA_REPORT);
    expect(String(errorOf(again)?.details.reason)).toContain(`critique_unsorted:${first.critique}`);
  });

  it("recalls a bet when the first story is delivered, and closes it on the creator's decision", async () => {
    const { critique, next, deliver } = await product();
    const { critique: id } = await critique(IDEA_REPORT);
    await critique({
      agent: "iris",
      item: id,
      items: [{ n: 1, gesture: "hypothesis" }],
      quote: "garde-la",
    });
    expect((await next()).hypotheses_due).toBeUndefined();
    await deliver("1-1");
    const hypothesis = `H-${id?.slice(2)}-1`;
    expect((await next()).hypotheses_due).toEqual([
      `${hypothesis} · Freelancers will pay for this every month. — story 1-1 delivered`,
    ]);
    const closed = await critique({
      agent: "iris",
      item: hypothesis,
      items: [{ gesture: "refuted", reason: "Two of five pre-ordered." }],
      quote: "réfutée",
    });
    expect(closed).toMatchObject({ hypothesis, outcome: "refuted", open: 0 });
    expect((await next()).hypotheses_due).toBeUndefined();
  });
});

describe("the press release, a document of the product", () => {
  /** A `document` point on the press release at its present version. */
  async function validate(p: Awaited<ReturnType<typeof product>>) {
    const text = await p.files.readText(PRFAQ_PATH);
    return p.run<RecordedEvent>("open_checkpoint", {
      agent: "iris",
      type: "document",
      risk: "low",
      title: "Press release to validate",
      summary: "Ready.",
      documents: [{ path: PRFAQ_PATH, branch: "main", blob_sha: versionsOf(text)[0] }],
    });
  }

  it("is validated by a point like the brief's, and waits for the creator in the next step", async () => {
    const p = await product({ inFraming: true });
    p.files.seed(PRFAQ_PATH, prfaq());
    const opened = await validate(p);
    const step = await p.next();
    expect(step).toMatchObject({ step: "validation", checkpoint: opened.checkpoint });
    await p.resolve(opened.checkpoint, { decision: "approved" });
    expect((await p.next()).step).not.toBe("validation");
  });

  it("is critiqued like any document, its FAQ passages checked, and its open questions become bets", async () => {
    const p = await product({ inFraming: true });
    p.files.seed(PRFAQ_PATH, prfaq());
    const report = (passage: string) => ({
      agent: "iris",
      kind: "prfaq",
      lenses: ["personas"],
      summary: "The customer and the investor read the FAQ.",
      findings: [
        {
          severity: "should_fix",
          claim: "The price is unknown and the customer will ask first.",
          passage,
          argument: "The customer FAQ leaves the price open.",
          proposal: "Test two prices with five freelancers.",
          proof: "Five freelancers say which price they would pay.",
        },
      ],
    });
    const wrong = await p.call("critique", report("Pricing FAQ"));
    expect(String(errorOf(wrong)?.details.reason)).toContain("passage_unknown:1");
    const accepted = await p.critique(report("Customer FAQ"));
    const settled = await p.critique({
      agent: "iris",
      item: accepted.critique,
      items: [{ n: 1, gesture: "hypothesis" }],
      quote: "oui, une hypothèse",
    });
    expect(settled.hypotheses).toEqual([`H-${accepted.critique?.slice(2)}-1`]);
    expect((await p.state()).critique?.hypotheses[0]).toContain("prfaq.md — The price is unknown");
  });
});

describe("Noah offers to test the idea, once", () => {
  it("offers it on a new product before the brief, in a line, and never twice", async () => {
    const p = await product({ inFraming: true });
    const first = await p.next();
    expect(first.step).toBe("framing");
    expect(first.critique).toEqual({ kind: "idea", why: "new_product" });
    expect(await p.critique({ agent: "iris", kind: "idea" })).toEqual({
      offered: ".agentplugged/docs/idea",
    });
    // Skipped: the answer was no, and the offer is not repeated, in this step nor in the next.
    expect((await p.next()).critique).toBeUndefined();
    const twice = await p.call("critique", { agent: "iris", kind: "idea" });
    expect(String(errorOf(twice)?.details.reason)).toContain("already_offered");
  });

  it("offers it just after the brief, while the end of framing waits for the creator", async () => {
    const p = await product({ inFraming: true });
    p.files.seed(BRIEF_PATH, "---\nid: brief\nkind: brief\nowner: iris\n---\n# Brief\n");
    const text = await p.files.readText(BRIEF_PATH);
    await p.run<RecordedEvent>("open_checkpoint", {
      agent: "iris",
      type: "phase_end",
      phase: "framing",
      risk: "low",
      title: "End of framing",
      summary: "The brief is ready.",
      documents: [{ path: BRIEF_PATH, branch: "main", blob_sha: versionsOf(text)[0] }],
    });
    const step = await p.next();
    expect(step.step).toBe("phase_review");
    expect(step.critique).toEqual({ kind: "idea", why: "new_product" });
  });

  it("does not offer it once the idea was tested, once the release exists, nor after framing", async () => {
    const tested = await product({ inFraming: true });
    await tested.critique(IDEA_REPORT);
    expect((await tested.next()).critique).toBeUndefined();

    const written = await product({ inFraming: true });
    written.files.seed(PRFAQ_PATH, prfaq());
    expect((await written.next()).critique).toBeUndefined();

    const later = await product();
    expect((await later.next()).critique).toBeUndefined();
  });

  it("gives way to the offer of a document at risk, which is the more pressing", async () => {
    const p = await product({ inFraming: true });
    p.files.seed(
      BRIEF_PATH,
      "---\nid: brief\nkind: brief\nowner: iris\nimportant: true\n---\n# Brief\n",
    );
    const text = await p.files.readText(BRIEF_PATH);
    await p.run<RecordedEvent>("open_checkpoint", {
      agent: "iris",
      type: "document",
      risk: "low",
      title: "Document to validate",
      summary: "Ready.",
      documents: [{ path: BRIEF_PATH, branch: "main", blob_sha: versionsOf(text)[0] }],
    });
    expect((await p.next()).critique).toEqual({ kind: "brief", why: "important" });
  });
});

describe("a blend of two methods and the reconciliation of the inputs", () => {
  it("keeps both methods of a blend in the journal, and refuses a third", async () => {
    const { call, critique, journal } = await product();
    const three = await call("critique", {
      agent: "quentin",
      ...REPORT,
      lenses: ["divergence", "failure_modes", "steelman"],
    });
    expect(errorOf(three)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENTS });
    const blended = await critique({ ...REPORT, lenses: ["failure_modes", "steelman"] });
    expect(blended.objections).toBe(3);
    expect(
      journal.events.find((event) => event.type === "critique.reported")?.payload,
    ).toMatchObject({ method: "failure_modes", blend: "steelman" });
  });

  it("takes a reconciliation of five findings, one gesture each, and never touches the text", async () => {
    const { call, critique, files, state } = await product();
    const finding = (n: number) => ({
      severity: "should_fix",
      claim: `Idea ${n} of the brief did not land in the PRD.`,
      passage: "Exports",
      argument: `Brief: « the export must feel instant » (idea ${n}); the PRD says nothing of it.`,
      proposal: "Add it under Exports, in the creator's words.",
      proof: "The creator confirms it still holds.",
    });
    const six = Array.from({ length: 6 }, (_, i) => finding(i + 1));
    const base = {
      ...REPORT,
      lenses: ["reconcile"],
      summary: "What the brief said, and the PRD lost.",
    };
    const refused = await call("critique", { agent: "quentin", ...base, findings: six });
    expect(String(errorOf(refused)?.details.reason)).toContain("too_many_objections:6>5");
    const before = await files.readText(PRD_PATH);
    const { critique: id, objections } = await critique({ ...base, findings: six.slice(0, 5) });
    expect(objections).toBe(5);
    const settled = await run(call, {
      agent: "quentin",
      item: id,
      items: [
        { n: 1, gesture: "fix" },
        { n: 2, gesture: "fix" },
        { n: 3, gesture: "hypothesis" },
        { n: 4, gesture: "discard", reason: "Left out on purpose." },
        { n: 5, gesture: "fix" },
      ],
      quote: "1, 2 et 5 : ajoutez ; 3 je garde à l'œil ; 4 non",
    });
    expect(settled).toMatchObject({ settled: { fix: 3, hypothesis: 1, discard: 1 }, left: 0 });
    expect(settled.fix?.proposals).toHaveLength(3);
    // The engine only gives the proposals: the text of the creator's document is untouched.
    expect(await files.readText(PRD_PATH)).toBe(before);
    expect((await state()).critique?.open).toBe(1);
  });
});

/** `critique` through the registry, as a value (the action is the same for every call). */
async function run(
  call: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>,
  input: Record<string, unknown>,
): Promise<CritiqueResult> {
  const result = await call("critique", input);
  if (!result.ok) throw new Error(`critique failed: ${JSON.stringify(result.error)}`);
  return result.value as CritiqueResult;
}
