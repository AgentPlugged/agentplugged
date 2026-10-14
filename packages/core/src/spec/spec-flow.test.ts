import { gitBlobId as blobId, utf8 } from "@agentplugged/crypto";
import { describe, expect, it } from "vitest";
import {
  type AgentNextResult,
  type CheckpointState,
  createCommandRegistry,
  type DocsCheckResult,
  type RecordedEvent,
  type RequirementsSynced,
} from "../index.js";
import { HEAD, product } from "../testing/product-harness.js";
import { shippedAgent } from "../testing/requirements-product.js";
import { sampleBreakdown, specText } from "../testing/spec-sample.js";
import type { SpecGrowResult, SpecPathResult } from "./spec-command.js";
import { SPEC_PATH } from "./spec-grow.js";
import { SPEC_SECURITY_REVIEW_PATH } from "./spec-security.js";

/**
 * The short path from end to end: Noah proposes a path from what the creator said, the
 * creator chooses with one gesture, one spec is written and validated, the stories come out of it,
 * the register of the requirements reads it, and a product that grows goes to the full path.
 */

const AGENTS = {
  ...shippedAgent("maya", "Maya", "product", "planning"),
  ...shippedAgent("izzy", "Izzy", "product", "build"),
  ...shippedAgent("sam", "Sam", "code", "build"),
  ...shippedAgent("quentin", "Quentin", "quality", "build"),
};

async function shortProduct(agents: typeof AGENTS = AGENTS) {
  const harness = await product("new-product", agents);
  const registry = createCommandRegistry();
  const { call, human, decide, state, files } = harness;
  const next = async () => {
    const result = await call("next");
    if (!result.ok) throw new Error(`next failed: ${result.error.code}`);
    return result.value as AgentNextResult;
  };
  const docs = async (input: Record<string, unknown>) => {
    const result = await registry.run("docs", human, input);
    if (!result.ok) {
      throw new Error(`docs failed: ${result.error.code} ${JSON.stringify(result.error.details)}`);
    }
    return result.value;
  };
  const path = async (...words: string[]) =>
    ((await docs({ action: "path", words })) as SpecPathResult).choice;
  /** The creator picks the short path: one gesture, their word as the reason. */
  const chooseShort = () =>
    decide({ kind: "step_skip", step: "full_path" }, "oui, le chemin court", "le chemin court");
  /** Maya opens the spec's point; the creator approves it. */
  const validateSpec = async () => {
    const opened = await call("open_checkpoint", {
      agent: "maya",
      type: "document",
      risk: "low",
      title: "The spec",
      summary: "One spec for the small project.",
      documents: [{ path: SPEC_PATH, branch: "main", blob_sha: HEAD }],
    });
    if (!opened.ok) throw new Error(`open failed: ${opened.error.code}`);
    const { checkpoint } = opened.value as RecordedEvent;
    const answered = await registry.run("review", human, {
      action: "resolve",
      checkpoint,
      decision: "approved",
    });
    if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
    return checkpoint as string;
  };
  const sync = async () => {
    const result = await call("sync_requirements", { agent: "quentin" });
    if (!result.ok) throw new Error(`sync failed: ${result.error.code}`);
    return result.value as unknown as RequirementsSynced;
  };
  const check = async () => (await docs({ action: "check" })) as DocsCheckResult;
  return { ...harness, next, docs, path, chooseShort, validateSpec, sync, check, state, files };
}

describe("choosing the path", () => {
  it("is proposed to a new product at its framing, once the idea is there", async () => {
    const { next } = await shortProduct();
    const step = await next();
    expect(step).toMatchObject({ step: "framing", agent: "iris", spec_path: "choose" });
    expect(step.spec_path_why).toBeUndefined();
  });

  it("recommends the short path for a small tool, the full one for a big or risky product", async () => {
    const { path } = await shortProduct();
    const base = ["users=2", "integrations=1", "platforms=1"];
    expect(await path("size=small", "sensitive=none", ...base)).toEqual({
      path: "short",
      risky: false,
      asked: false,
      reasons: [],
    });
    expect(await path("size=large", "sensitive=none", ...base)).toMatchObject({
      path: "full",
      reasons: ["size:large"],
    });
    expect(await path("size=small", "sensitive=payment", ...base)).toEqual({
      path: "full",
      risky: true,
      asked: false,
      reasons: ["sensitive:payment"],
    });
  });

  it("takes the short path for a risky product only when the creator asks, in so many words", async () => {
    const { path } = await shortProduct();
    const risky = ["size=small", "sensitive=accounts,payment", "users=2", "integrations=1"];
    expect((await path(...risky, "platforms=1")).path).toBe("full");
    expect(await path(...risky, "platforms=1", "asked=short")).toMatchObject({
      path: "short",
      risky: true,
      asked: true,
    });
  });

  it("refuses an incomplete description: a risk nobody asked about is not a risk absent", async () => {
    const { docs } = await shortProduct();
    const bad = (words: string[]) => docs({ action: "path", words }).catch((error) => error);
    expect(String(await bad(["size=small", "users=2", "integrations=1", "platforms=1"]))).toContain(
      "sensitive",
    );
    expect(String(await bad(["size=small", "users"]))).toContain("key=value");
  });

  it("is chosen with one gesture, which skips the full path and nothing else", async () => {
    const { chooseShort, state, next } = await shortProduct();
    const asked = await chooseShort();
    expect(asked).toMatchObject({ kind: "step_skip", risk: "low" });
    expect(asked.journey?.warning).toContain("Without the full path");
    const skips = (await state()).skips as Record<string, Record<string, unknown>>;
    expect(Object.keys(skips)).toEqual(["full_path"]);
    expect(skips.full_path).toMatchObject({ by: "creator", source: "chat" });
    const step = await next();
    // No more brief to write: the spec, by Maya, and the three phases it replaces are skipped.
    expect(step).toMatchObject({ step: "spec", agent: "maya", phase: "build" });
    expect(step.spec_path).toBeUndefined();
    expect(step.phases.filter((phase) => phase.status === "skipped").map((p) => p.id)).toEqual(
      expect.arrayContaining(["framing", "planning", "design"]),
    );
  });
});

describe("the spec has an author whoever is on the team", () => {
  it("is the creator's to write when Maya is not an active agent: Iris has no skill for it", async () => {
    const harness = await product("new-product");
    await harness.decide({ kind: "step_skip", step: "full_path" }, "oui, le chemin court");
    const step = await harness.call("next");
    expect(step.ok && (step.value as AgentNextResult)).toMatchObject({ step: "spec", you: true });
  });
});

describe("one spec, validated, then the stories", () => {
  it("waits for the creator's approval of the spec before any story is cut", async () => {
    const { chooseShort, next, files, call } = await shortProduct();
    await chooseShort();
    files.seed(SPEC_PATH, specText());
    // The spec is written but not yet put before the creator: its author is called to open the point.
    expect(await next()).toMatchObject({ step: "spec", agent: "maya" });
    const opened = await call("open_checkpoint", {
      agent: "maya",
      type: "document",
      risk: "low",
      title: "The spec",
      summary: "One spec.",
      documents: [{ path: SPEC_PATH, branch: "main", blob_sha: HEAD }],
    });
    expect(opened.ok).toBe(true);
    // One point of validation, the same as for a document: the creator's turn.
    const waiting = await next();
    expect(waiting).toMatchObject({ step: "validation", you: true });
    expect(waiting.waiting.map((point) => point.type)).toEqual(["document"]);
  });

  it("goes to the breakdown once the creator approved the spec, with no phase end to answer", async () => {
    const { chooseShort, next, files, validateSpec, checkpoint } = await shortProduct();
    await chooseShort();
    files.seed(SPEC_PATH, specText());
    const id = await validateSpec();
    expect((await checkpoint(id)) as CheckpointState | undefined).toMatchObject({
      type: "document",
      status: "resolved",
    });
    expect(await next()).toMatchObject({ step: "breakdown", agent: "izzy", phase: "build" });
  });

  it("checks the stories cut from the spec against it, then they wait for review like any breakdown", async () => {
    const { chooseShort, next, files, validateSpec, check } = await shortProduct();
    await chooseShort();
    files.seed(SPEC_PATH, specText());
    await validateSpec();
    for (const [path, text] of Object.entries(sampleBreakdown())) files.seed(path, text);
    // Every requirement of the spec is carried by a story, the stories are well formed.
    expect((await check()).problems).toEqual([]);
    // The stories are on the usual road: Izzy has them reviewed, then the sprint, the developers.
    const step = await next();
    expect(step).toMatchObject({ step: "breakdown", agent: "izzy" });
    expect(step.spec_path).toBeUndefined();
  });

  it("registers the non-functional requirements of the spec, with the stories that carry them", async () => {
    const { chooseShort, files, validateSpec, sync } = await shortProduct();
    await chooseShort();
    files.seed(SPEC_PATH, specText());
    await validateSpec();
    for (const [path, text] of Object.entries(sampleBreakdown())) files.seed(path, text);
    const first = await sync();
    expect(first.changed).toBe(true);
    expect(first.register).toMatchObject({ total: 2, unproven: 2 });
    expect(first.register?.gaps.map((gap) => gap.split(":")[0])).toEqual(["ENF-1", "ENF-2"]);
    expect((await sync()).changed).toBe(false);
  });
});

describe("a product that grows goes to the full path", () => {
  it("says in one line why, as soon as the scope or the size of the spec calls for it", async () => {
    const { chooseShort, files, validateSpec, next } = await shortProduct();
    await chooseShort();
    files.seed(SPEC_PATH, specText());
    await validateSpec();
    expect((await next()).spec_path).toBeUndefined();
    files.seed(SPEC_PATH, specText({ size: "large", users: 3000 }));
    const step = await next();
    expect(step.spec_path).toBe("grow");
    expect(step.spec_path_why).toEqual(["size:large", "users:crowd"]);
    // The spec itself grew: more requirements than a short document carries.
    const many = Array.from(
      { length: 14 },
      (_, index) => `- EF-${index + 5} : Une capacité de plus, numéro ${index + 5}.`,
    );
    files.seed(SPEC_PATH, specText({}, many));
    expect((await next()).spec_path_why).toEqual(["requirements:16"]);
  });

  it("carries the spec over without retyping: the creator resumes the full path, the engine writes the documents", async () => {
    const { chooseShort, decide, files, validateSpec, next, docs, sync, check, state } =
      await shortProduct();
    await chooseShort();
    files.seed(SPEC_PATH, specText());
    await validateSpec();
    for (const [path, text] of Object.entries(sampleBreakdown())) files.seed(path, text);
    const before = await sync();
    files.seed(SPEC_PATH, specText({ size: "large" }));
    expect((await next()).spec_path).toBe("grow");

    await decide({ kind: "step_resume", step: "full_path" }, "oui, passe au chemin complet");
    expect(Object.keys((await state()).skips ?? {})).toEqual([]);
    expect((await next()).spec_path).toBe("carry");

    const grown = (await docs({ action: "grow" })) as SpecGrowResult;
    expect(grown.written).toEqual([
      ".agentplugged/docs/brief.md",
      ".agentplugged/docs/prd.md",
      ".agentplugged/docs/architecture.md",
    ]);
    expect(grown.identifiers).toEqual(["EF-1", "EF-2", "ENF-1", "ENF-2", "AD-1"]);
    expect(await files.exists(SPEC_PATH)).toBe(false);
    expect(await files.readText(".agentplugged/docs/prd.md")).toContain(
      "- EF-1 : Le gérant importe un dossier de factures en PDF.",
    );
    expect((await check()).problems).toEqual([]);
    // The register is what it was: the same requirements, the same stories, nothing to rewrite.
    expect((await sync()).changed).toBe(false);
    expect((await sync()).register).toMatchObject({ total: before.register?.total });
    const step = await next();
    expect(step.spec_path).toBeUndefined();
    expect(step.step).not.toBe("spec");
  });

  it("refuses to carry over twice, or over documents that exist, and writes nothing", async () => {
    const { files, docs } = await shortProduct();
    await expect(docs({ action: "grow" })).rejects.toThrow("INVALID_ARGUMENTS");
    files.seed(SPEC_PATH, specText());
    files.seed(".agentplugged/docs/prd.md", "---\nid: prd\nkind: prd\nowner: maya\n---\n# PRD\n");
    await expect(docs({ action: "grow" })).rejects.toThrow("INVALID_ARGUMENTS");
    expect(await files.exists(SPEC_PATH)).toBe(true);
    expect(await files.exists(".agentplugged/docs/brief.md")).toBe(false);
  });

  it("refuses to carry over while the short path is still chosen: the creator resumes the full path first", async () => {
    const { chooseShort, files, docs } = await shortProduct();
    await chooseShort();
    files.seed(SPEC_PATH, specText());
    await expect(docs({ action: "grow" })).rejects.toThrow("short path");
    expect(await files.exists(SPEC_PATH)).toBe(true);
    expect(await files.exists(".agentplugged/docs/brief.md")).toBe(false);
  });
});

describe("the security of the short path", () => {
  const WITH_CHLOE = { ...AGENTS, ...shippedAgent("chloe", "Chloé", "security", "build") };
  const OPTIONS = [
    { id: "fix", label: "Maya corrige la spec", consequence: "Chloé relit la nouvelle version." },
    {
      id: "full",
      label: "Chemin complet",
      consequence: "La spec devient brief, PRD, architecture.",
    },
    { id: "accept", label: "Accepter le risque", consequence: "Les stories sont découpées." },
  ];
  const REVIEW_DOC = (owner = "chloe", note = "Aucun constat.") =>
    `---\nid: spec-security-review\nkind: note\nowner: ${owner}\nlinks:\n  - spec\n---\n# Avis\n\n${note}\n`;

  /** A product with Chloé whose creator took the short path, and the spec validated. */
  async function reviewed(text = specText()) {
    const harness = await shortProduct(WITH_CHLOE);
    await harness.chooseShort();
    harness.files.seed(SPEC_PATH, text);
    await harness.validateSpec();
    /** Chloé writes her review and submits it for the spec as it is in the working copy. */
    const submit = async (
      options: {
        counts?: string;
        owner?: string;
        note?: string;
        spec?: string;
        write?: boolean;
      } = {},
    ) => {
      const doc = REVIEW_DOC(options.owner, options.note);
      if (options.write !== false) harness.files.seed(SPEC_SECURITY_REVIEW_PATH, doc);
      const result = await harness.call("submit_result", {
        agent: "chloe",
        status: "complete",
        summary: `Architecture security review: ${options.counts ?? "verdict=no-blocking findings=1 blocking=0"} review=${blobId(utf8(doc))} architecture=${blobId(utf8(options.spec ?? text))}\nOne low finding.`,
        assumptions: [],
        open_questions: [],
        conflicts: [],
      });
      if (!result.ok) throw new Error(`submit failed: ${result.error.code}`);
    };
    /** Chloé puts her findings to the creator. */
    const ask = async () => {
      const opened = await harness.call("open_checkpoint", {
        agent: "chloe",
        type: "decision",
        risk: "high",
        title: "Findings on the spec",
        summary: "One blocking finding.",
        options: OPTIONS,
        recommendation: "fix",
      });
      if (!opened.ok) throw new Error(`open failed: ${opened.error.code}`);
      return (opened.value as RecordedEvent).checkpoint as string;
    };
    const answer = async (checkpoint: string, option: string) => {
      const answered = await createCommandRegistry().run("review", harness.human, {
        action: "resolve",
        checkpoint,
        decision: "option_chosen",
        option,
      });
      if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
    };
    return { ...harness, submit, ask, answer };
  }
  const BLOCKING = "verdict=blocking findings=2 blocking=1";

  it("calls Chloé on the validated spec before any story is cut, then goes to the breakdown", async () => {
    const { next, submit } = await reviewed();
    expect(await next()).toMatchObject({ step: "security_review", agent: "chloe" });
    await submit();
    expect(await next()).toMatchObject({ step: "breakdown", agent: "izzy" });
  });

  it("asks again when the spec changed since her review, and never for a review of another document", async () => {
    const { next, submit, files } = await reviewed();
    await submit({ spec: "some other document" });
    expect(await next()).toMatchObject({ step: "security_review", agent: "chloe" });
    await submit();
    expect((await next()).step).toBe("breakdown");
    files.seed(SPEC_PATH, specText({}, ["- ENF-3 : Les accès sont journalisés."]));
    expect(await next()).toMatchObject({ step: "security_review", agent: "chloe" });
  });

  it("wants the review itself, not only its line: written, committed as submitted, and Chloé's", async () => {
    const { next, submit, files } = await reviewed();
    // A line without a document: the short pass is not a skipped one.
    await submit({ write: false });
    expect(await next()).toMatchObject({ step: "security_review", agent: "chloe" });
    // The document is not the version the line cites.
    await submit();
    files.seed(SPEC_SECURITY_REVIEW_PATH, REVIEW_DOC("chloe", "Autre texte."));
    expect(await next()).toMatchObject({ step: "security_review", agent: "chloe" });
    // The document says another owner than Chloé.
    await submit({ owner: "alex" });
    expect(await next()).toMatchObject({ step: "security_review", agent: "chloe" });
    await submit();
    expect((await next()).step).toBe("breakdown");
  });

  it("holds the stories on blocking findings until the creator accepts the risk", async () => {
    const { next, submit, ask, answer } = await reviewed();
    await submit({ counts: BLOCKING });
    // The findings need an answer: Chloé is called to put them to the creator.
    expect(await next()).toMatchObject({ step: "security_review", agent: "chloe" });
    const checkpoint = await ask();
    expect(await next()).toMatchObject({ step: "validation", you: true, checkpoint });
    // Any other answer than the creator accepting the risk keeps the stories back.
    await answer(checkpoint, "fix");
    expect(await next()).toMatchObject({ step: "security_review", agent: "chloe" });
    const again = await ask();
    await answer(again, "accept");
    expect(await next()).toMatchObject({ step: "breakdown", agent: "izzy" });
  });

  it("does not let a milder review of the same version cancel a blocking one", async () => {
    const { next, submit } = await reviewed();
    await submit({ counts: BLOCKING });
    await submit({ note: "Relu : plus de constat." });
    expect(await next()).toMatchObject({ step: "security_review", agent: "chloe" });
  });

  it("leaves a team without Chloé alone: no reviewer, no gate", async () => {
    const { chooseShort, next, files, validateSpec } = await shortProduct();
    await chooseShort();
    files.seed(SPEC_PATH, specText());
    await validateSpec();
    expect((await next()).step).toBe("breakdown");
  });

  it("says in one line, once the spec speaks of what its scope does not declare, that the full path is due", async () => {
    const { chooseShort, next, files, validateSpec } = await shortProduct();
    await chooseShort();
    const risky = specText({}, ["- EF-3 : Le gérant paie par carte bancaire (paiement en ligne)."]);
    files.seed(SPEC_PATH, risky);
    await validateSpec();
    const step = await next();
    expect(step.spec_path).toBe("risk");
    expect(step.spec_path_why).toEqual(["text:sensitive"]);
    // The creator asked for the short path in so many words: nothing to say.
    files.seed(SPEC_PATH, risky.replace("platforms: 1", "platforms: 1\nasked: short"));
    expect((await next()).spec_path).toBeUndefined();
    // A spec that declares its sensitive kinds is the business of the scope rules (grow).
    files.seed(SPEC_PATH, risky.replace("sensitive: []", "sensitive: [payment]"));
    expect((await next()).spec_path).toBe("grow");
    // A spec with nothing sensitive says nothing.
    files.seed(SPEC_PATH, specText());
    expect((await next()).spec_path).toBeUndefined();
  });
});
