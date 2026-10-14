import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  AGENT_DOMAINS,
  checkDocumentsDetailed,
  type Definition,
  GENERATED_HEADER,
  OFFERS_DIR,
  POSITIONING_PATH,
  readDefinitions,
  SEQUENCES_DIR,
  withGeneratedHeader,
} from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { ErrorCode, LAUNCH_DOCUMENT_REASONS, type SkillFrontmatter } from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { withNoah } from "./__helpers__/noah-text.js";

/** The sales skill: Milo writes offers and sequences, never sends, never invents. */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const SKILL = "write-sales";
const OFFER = `${OFFERS_DIR}main.md`;
const SEQUENCE = `${SEQUENCES_DIR}prospecting.md`;
const KB = {
  path: ".agentplugged/docs/index.md",
  text: "---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n",
};
const POSITIONING = {
  path: POSITIONING_PATH,
  text: `---\nid: positioning\nkind: note\nowner: julien\nlinks: [kb-index]\nlanguage: en\n---\n# Positioning\n\n${[
    "Audience",
    "Problem",
    "Promise",
    "Difference",
  ]
    .map((title) => `## ${title}\n\nSomething true.\n`)
    .join(
      "\n",
    )}\n## Evidence\n\n| Claim | Status | Source |\n| --- | --- | --- |\n| It syncs | verified | kb-index |\n`,
};

let skills: Map<string, Definition>;
let agents: Map<string, Definition>;

beforeAll(async () => {
  const source = new NodeWorkspaceFiles(methodDir);
  const shippedSkills = await readDefinitions(source, "skills", "skill");
  const shippedAgents = await readDefinitions(source, "agents", "agent");
  if (!Array.isArray(shippedSkills) || !Array.isArray(shippedAgents)) {
    throw new Error("invalid shipped method");
  }
  skills = new Map(shippedSkills.map((definition) => [definition.name, definition]));
  agents = new Map(shippedAgents.map((definition) => [definition.name, definition]));
});

function skill(): Definition {
  const definition = skills.get(SKILL);
  if (definition === undefined) throw new Error(`${SKILL} is not shipped`);
  return definition;
}

const flat = (text: string) => text.replace(/\s+/g, " ");
const annex = (path: string) =>
  readFileSync(join(methodDir, "skills", SKILL, path), "utf8").replace(/\r\n/g, "\n");

/** A template filled as the skill asks: every placeholder in angle brackets replaced by a text. */
const filled = (path: string) =>
  annex(path)
    .replace("<blob id of the validated positioning>", "a".repeat(40))
    .replace("<verified, stated or untrusted>", "stated")
    .replace(/<[^<>\n]+>/g, "Something true about it");

const owners = new Set(Object.keys(AGENT_DOMAINS));
const check = (files: Array<{ path: string; text: string }>) =>
  checkDocumentsDetailed({ current: [KB, POSITIONING, ...files], owners });

describe("the sales skill", () => {
  it("ships the skill with its annexes, called from Milo's menu", () => {
    expect([...skill().annexes].sort()).toEqual([
      "assets/offer-template.md",
      "assets/sequence-template.md",
      "references/before-you-send.md",
      "references/sales-checklist.md",
    ]);
    const metadata = (skill().frontmatter as SkillFrontmatter).metadata;
    expect(metadata).toMatchObject({ agent: "milo", phase: "launch" });
    const menu = agents.get("milo")?.agent?.menu ?? [];
    for (const code of ["OF", "SQ"]) {
      const item = menu.find((entry) => entry.code === code);
      expect(item?.skill, code).toBe(SKILL);
      expect(item?.prompt, code).toBeUndefined();
    }
    // The buyers, the call guide and the follow-up of results keep their own prompts.
    for (const code of ["BY", "OB", "FU"]) {
      expect(menu.find((entry) => entry.code === code)?.prompt, code).toBeDefined();
    }
  });

  it("gives the skill its sections and its numbered steps", () => {
    const { body } = skill();
    for (const title of ["Overview", "Before you start", "Decisions", "Steps", "Rules"]) {
      expect(
        body.split("\n").filter((line) => line === `## ${title}`),
        title,
      ).toHaveLength(1);
    }
    const steps = [...body.matchAll(/^(\d{1,2})\. \*\*/gm)].map((match) => Number(match[1]));
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  const step = (n: number) => {
    const body = skill().body;
    const start = body.indexOf(`\n${n}. **`);
    const next = body.indexOf(`\n${n + 1}. **`, start + 1);
    return flat(body.slice(start, next === -1 ? body.indexOf("\n## Rules") : next));
  };

  it("names only its own annexes, and every one of them", () => {
    const named = new Set(
      [...skill().body.matchAll(/`((?:assets|references)\/[\w.-]+\.md)`/g)].map((m) => m[1]),
    );
    expect([...named].sort()).toEqual([...skill().annexes].sort());
  });

  it("works through the MCP server as Milo, from next to a publication checkpoint", () => {
    const text = flat(skill().body);
    for (const call of [
      "agent.status",
      "state.get",
      "checkpoint.open",
      "story.result",
      "guard.external_read",
      "chat.answer",
    ]) {
      expect(text, call).toContain(`\`${call}\``);
    }
    expect(text).toContain("`agent: milo`");
    expect(step(1)).toContain("`npx agentplugged next --json`");
    expect(step(9)).toContain("`type: publication`");
    expect(step(9)).toContain("`git rev-parse HEAD:<path>`");
    expect(step(9).indexOf("`git commit`")).toBeLessThan(step(9).indexOf("`checkpoint.open`"));
    expect(step(9)).toContain("One checkpoint per deliverable");
    expect(step(9)).toContain("approving it sends nothing");
    expect(step(11)).toContain("`story.result`");
  });

  it("produces nothing without a validated positioning, and says what validated means", () => {
    expect(step(2)).toContain("**The positioning must be validated**");
    expect(step(2)).toContain("you write nothing");
    expect(step(2)).toContain("`partial`");
    expect(step(10)).toContain("`approved` or `approved_with_reservations`");
    expect(step(10)).toContain("never a waiver, never an option picked");
    expect(step(10)).toContain("last *approved* `publication` checkpoint");
    expect(step(10)).toContain("equal to the blob of the file as it is now");
    // Without a validated positioning: Julien, or the creator when Julien is not active; a review stays possible.
    expect(step(2)).toContain("when Julien is not active, say so too");
    expect(step(2)).toContain("A review (below) needs no validated positioning");
    expect(step(2)).toContain("Read the `sales.positioning_blob` of every deliverable that exists");
    // A positioning edited after a deliverable was written makes it stale.
    expect(step(10)).toContain("`positioning_blob`");
    expect(step(10)).toContain("stale");
    expect(flat(skill().body)).toContain("Produce nothing without a validated positioning");
  });

  it("never sends, publishes nor pays, and writes only the offers and the sequences", () => {
    const rules = flat(skill().body.slice(skill().body.indexOf("\n## Rules")));
    expect(rules).toContain("Never publish, send, schedule, buy or pay anything");
    expect(rules).toContain("Never send an email, never load a sequence or an address");
    expect(rules).toContain("Write only the files of `.agentplugged/docs/sales/offers/`");
    const written = [...skill().body.matchAll(/`(\.agentplugged\/docs\/[^`]+)`/g)].map((m) => m[1]);
    const own =
      /^\.agentplugged\/docs\/(?:sales\/(?:offers\/(?:<slug>\.md)?|sequences\/(?:<slug>\.md)?)?|launch\/positioning\.md|index\.md)$/;
    for (const path of written) expect(path, path).toMatch(own);
    expect(written).toContain("`.agentplugged/docs/sales/offers/`".slice(1, -1));
  });

  it("stops without a knowledge base, refuses to send, and leaves the end of the phase to the creator", () => {
    expect(step(2)).toContain("Without `index.md` there is no knowledge base");
    expect(step(2)).toContain("Zoé writes it first");
    expect(step(2)).toContain("`partial`");
    expect(step(6)).toContain("never ask for access to one");
    const text = flat(skill().body);
    expect(text).toContain("Do not open the end of the launch phase on your own");
    expect(text).toContain("never contact a prospect");
    expect(step(1)).toContain("`launch`");
    expect(step(6)).toContain("**Claims**");
  });

  it("passes docs check with the guidance comments removed and only the placeholders filled", () => {
    const bare = (path: string) => filled(path).replace(/<!--[\s\S]*?-->\n?/g, "");
    expect(check([{ path: OFFER, text: bare("assets/offer-template.md") }]).problems).toEqual([]);
    expect(check([{ path: SEQUENCE, text: bare("assets/sequence-template.md") }]).problems).toEqual(
      [],
    );
    // A figure in a comment of the templates would survive a naive fill: there is none.
    for (const path of ["assets/offer-template.md", "assets/sequence-template.md"]) {
      expect(annex(path)).not.toMatch(/\d+ ?(?:EUR|USD|\$|€)/);
    }
  });

  it("invents no price, testimonial, figure nor guarantee: a decision, or the creator's statement", () => {
    const text = flat(skill().body);
    expect(text).toContain("**Prices and terms are the creator's call, always.**");
    expect(text).toContain("`type: decision`");
    expect(text).toContain("Never invent a price, a discount, a guarantee, a testimonial");
    expect(step(3)).toContain("a missing price is always one");
    expect(step(4)).toContain(
      "`pricing` (`free`, `none`, or `stated` with its `amount` and `stated_on`, never otherwise)",
    );
    expect(text).toContain("as `stated`");
    expect(flat(annex("references/sales-checklist.md"))).toContain("**No price of your own.**");
  });

  it("writes a sequence ready to copy, with its reminders before sending and no legal advice", () => {
    expect(step(6)).toContain("`stop_condition`");
    expect(step(6)).toContain("`opt_out`");
    expect(step(6)).toContain("`delay_days`");
    expect(step(6)).toContain("**Before you send**");
    expect(step(6)).toContain("never a legal opinion");
    expect(step(6)).toContain("one line per country");
    expect(step(6)).toContain("never load the sequence into a tool");
    const reminders = flat(annex("references/before-you-send.md"));
    for (const part of ["consent", "stop receiving", "stop", "country", "not legal advice"]) {
      expect(reminders.toLowerCase(), part).toContain(part);
    }
    expect(reminders).toContain("several countries");
    expect(flat(annex("assets/sequence-template.md"))).toContain(
      "This is a reminder, not legal advice",
    );
  });

  it("declares a read outside the product before it happens and keeps it untrusted", () => {
    const text = flat(skill().body);
    expect(text).toContain("`guard.external_read` (`tool`, `source`) before you read");
    expect(text).toContain("marked `untrusted`");
    const reading = flat(annex("references/before-you-send.md"));
    expect(reading).toContain("**before**");
    expect(reading).toContain("`untrusted`");
  });

  it("ships templates that pass docs check once filled, and refuses their markers before", () => {
    const offer = { path: OFFER, text: filled("assets/offer-template.md") };
    const sequence = { path: SEQUENCE, text: filled("assets/sequence-template.md") };
    expect(check([offer, sequence]).problems).toEqual([]);
    const raw = check([
      { path: OFFER, text: annex("assets/offer-template.md") },
      { path: SEQUENCE, text: annex("assets/sequence-template.md") },
    ]).problems;
    expect(raw.length).toBeGreaterThan(0);
    expect(new Set(raw.map((problem) => problem.code))).toEqual(
      new Set([ErrorCode.DOC_PLACEHOLDER_LEFT, ErrorCode.LAUNCH_DOCUMENT_INVALID]),
    );
    // The sequence template carries two sample emails, and the body has the same two sections.
    expect(annex("assets/sequence-template.md").match(/^## Email \d+$/gm)).toHaveLength(2);
    expect(annex("assets/offer-template.md")).toContain("status: none");
  });

  it("refuses a template copied with its generated line, and accepts it once the line is gone", () => {
    const files = [
      { path: OFFER, text: withGeneratedHeader(filled("assets/offer-template.md")) },
      { path: SEQUENCE, text: withGeneratedHeader(filled("assets/sequence-template.md")) },
    ];
    expect(check(files).problems.map((problem) => problem.details.reason_key)).toEqual([
      "reason.doc_generated_marker",
      "reason.doc_generated_marker",
    ]);
    const cleaned = files.map((file) => ({
      ...file,
      text: file.text.replace(`${GENERATED_HEADER}\n`, ""),
    }));
    expect(check(cleaned).problems).toEqual([]);
  });

  it("explains every refusal and warning, in French (tu) and in English", () => {
    const fr = createTranslator("fr");
    const en = createTranslator("en");
    for (const reason of LAUNCH_DOCUMENT_REASONS) {
      const key = `error.launch_document_invalid.${reason}` as Parameters<typeof fr>[0];
      expect(fr(key), key).not.toBe(key);
      expect(en(key), key).not.toBe(key);
      expect(fr(key), key).not.toBe(en(key));
    }
    for (const reason of [
      "sales_sequence_long",
      "sales_positioning_not_validated",
      "sales_positioning_moved",
    ]) {
      const key = `docs.check.warning.${reason}` as Parameters<typeof fr>[0];
      expect(fr(key), key).not.toBe(key);
      expect(en(key), key).not.toBe(key);
      expect(fr(key), key).not.toBe(en(key));
    }
    expect(fr("error.launch_document_invalid.sales_pricing" as never)).toMatch(/c'est à toi/);
  });
});

describe("Milo and Noah around the sales skill", () => {
  const read = withNoah(
    methodDir,
    (path: string) => flat(readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n")),
    flat,
  );

  it("tells Milo to sell from a validated positioning only, and never to invent a price", () => {
    const milo = read("agents/milo/SKILL.md");
    expect(milo).toContain("He sells only from a validated positioning");
    expect(milo).toContain("He invents no price, no testimonial, no figure and no guarantee");
    expect(milo).toContain("guard.external_read");
    // The follow-up of results goes back through the skill, and never touches what was sent.
    const menu = agents.get("milo")?.agent?.menu ?? [];
    const followUp = flat(menu.find((entry) => entry.code === "FU")?.prompt ?? "");
    expect(followUp).toContain("goes through the skill `write-sales`");
    expect(followUp).toContain("Never rewrite what the creator already sent");
    const facts = (agents.get("milo")?.agent?.persistent_facts ?? []).join(" ");
    expect(flat(facts)).toContain("produce nothing without one");
    expect(flat(facts)).toContain("`offers/`");
    expect(flat(facts)).toContain("is never invented");
  });

  it("has Noah propose Milo after the positioning, and Julien first when it is not validated", () => {
    const noah = read("agents/noah/SKILL.md");
    expect(noah).toContain("Noah proposes Milo");
    expect(noah).toContain("offers Julien and the positioning first");
    expect(noah).toContain("does not hand the work to Milo");
    expect(noah).toContain("never sends an email");
  });

  it("lists the skill and the sales documents in the method's README", () => {
    const readme = read("README.md");
    expect(readme).toContain("| `write-sales` | Milo (`OF`, `SQ`) |");
    expect(readme).toContain(".agentplugged/docs/sales/offers/");
    expect(readme).toContain("Milo never invents a price");
  });
});
